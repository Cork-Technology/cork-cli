// Split from handlers.ts (2026-08-05): decode handlers — one typed dispatch, per-tool modules.
// Declarations are moved byte-identically; see handlers.ts for the runTool dispatch.
import { keccak256 } from "viem";
import { Address, Bytes32, type ChainId, DecodeInput, Envelope, Hex, UintStr } from "@cork/schemas";
import { decodeMakerTraits, decodeOrderTuple, hashLopOrder, LOP_ADDRESSES, type LopOrder } from "../orders.ts";
import { decodeJitExtension } from "../market-registry.ts";
import * as legacyRegistry from "../market-registry-legacy.ts";
import { decodeKnownLog, type RawLogLike } from "../event-decode.ts";
import { decodeFusionOrder, NotAFusionOrder } from "../fusion.ts";
import { decodeBundle } from "../bundle/decode.ts";
import { summarizeBundle } from "../bundle/summary.ts";
import { envelope, getDep, type HandlerContext, ToolInputError } from "./shared.ts";


// ── cork_decode order/event/receipt: pure LOCAL reconstruction [K3] ──────────────────────────

/** Parse a caller-supplied order RECORD (e.g. a typedData.message round-trip) into a LopOrder.
 *  Field-by-field validation with teachable paths; extra keys are ignored (we reconstruct from
 *  the eight struct fields, never from any decoded claims riding along). Shared by cork_decode
 *  (path root "data") and cork_compute dutch-auction-price (path root "params.order"). */
export function parseOrderRecord(rec: Record<string, unknown>, tool: "cork_decode" | "cork_compute" = "cork_decode", pathRoot: string[] = ["data"]): LopOrder {
  const fail = (key: string, message: string): never => {
    throw new ToolInputError(tool, [{ path: [...pathRoot, key], message }]);
  };
  const uint = (key: "salt" | "makingAmount" | "takingAmount" | "makerTraits"): bigint => {
    const r = UintStr.safeParse(rec[key] === undefined ? undefined : String(rec[key]));
    if (!r.success) fail(key, "expected an unsigned integer as a decimal string");
    return BigInt(r.data!);
  };
  const addr = (key: "maker" | "receiver" | "makerAsset" | "takerAsset"): `0x${string}` => {
    const r = Address.safeParse(rec[key]);
    if (!r.success) fail(key, "not a valid EVM address");
    return r.data!;
  };
  return {
    salt: uint("salt"),
    maker: addr("maker"),
    receiver: addr("receiver"),
    makerAsset: addr("makerAsset"),
    takerAsset: addr("takerAsset"),
    makingAmount: uint("makingAmount"),
    takingAmount: uint("takingAmount"),
    makerTraits: uint("makerTraits"),
  };
}

const DECODE_U160 = (1n << 160n) - 1n;

/** decode kind:"order" — label a 1inch LOP v4 order (hex tuple or JSON fields): full makerTraits
 *  breakdown + locally recomputed orderHash; any caller-claimed hash is cross-checked, never
 *  trusted [K3]. */
export function handleDecodeOrder(input: DecodeInput, chainId: ChainId, ctx: HandlerContext): Envelope {
  let order: LopOrder;
  let claimedOrderHash: `0x${string}` | undefined;
  let extension: `0x${string}` | undefined;
  if (typeof input.data === "string") {
    try {
      order = decodeOrderTuple(input.data as `0x${string}`);
    } catch (err) {
      throw new ToolInputError("cork_decode", [{ path: ["data"], message: err instanceof Error ? err.message : "not a decodable LOP v4 order tuple" }]);
    }
  } else {
    order = parseOrderRecord(input.data);
    if (input.data.orderHash !== undefined) {
      const r = Bytes32.safeParse(input.data.orderHash);
      if (!r.success) throw new ToolInputError("cork_decode", [{ path: ["data", "orderHash"], message: "not a 32-byte hex hash" }]);
      claimedOrderHash = r.data;
    }
    if (input.data.extension !== undefined) {
      const r = Hex.safeParse(input.data.extension);
      if (!r.success) throw new ToolInputError("cork_decode", [{ path: ["data", "extension"], message: "not 0x-prefixed hex" }]);
      extension = r.data as `0x${string}`;
    }
  }
  const traits = decodeMakerTraits(order.makerTraits);
  const lop = LOP_ADDRESSES[chainId];
  const orderHash = lop ? hashLopOrder(chainId, lop, order) : null;
  const warnings: Array<{ code: string; message: string }> = [];
  if (!lop) {
    warnings.push({ code: "no_lop", message: `no known 1inch LOP v4 deployment for chainId ${chainId} — the order decodes but its EIP-712 orderHash needs the verifying contract; pass a chainId with a known LOP (1, 42161) for the hash` });
  }
  // Fusion labeling (best-effort): when the extension carries an auction amount-getter, summarize
  // it — decode only, never a guess; a non-Fusion or unparseable extension just skips the label.
  let fusion: Record<string, unknown> | undefined;
  if (extension !== undefined && extension !== "0x") {
    try {
      const f = decodeFusionOrder(order, extension, chainId);
      fusion = {
        settlement: f.settlement,
        classification: f.classification,
        auction: { startTime: f.auction.startTime, duration: f.auction.duration, initialRateBump: f.auction.initialRateBump, points: f.auction.points.length },
        postInteractionGated: f.postInteraction !== null,
        note: "auction-priced order — current price via cork_compute dutch-auction-price",
      };
    } catch (err) {
      if (err instanceof NotAFusionOrder && /LEGACY/.test(err.message)) {
        fusion = { classification: "legacy", note: err.message };
      }
      /* not an auction order (or malformed auction bytes) — no label; the raw fields still decode */
    }
  }
  // JIT labeling (best-effort, same decode-only rule): when the extension's preInteraction field
  // carries a Cork JIT payload, unpack it so a taker can see what filling this order DOES —
  // which adapter it calls, which recipe/constraint (2.1.0) or mode (legacy) it commits to, and
  // whether permits ride along. Tried 2.1.0-first; the legacy shape is labeled as such. A
  // non-JIT extension just skips the label [K3: reconstructed from the bytes, never guessed].
  // NOT exclusive with the fusion label: a Cork-native auction order composes BOTH (amount
  // getters + JIT preInteraction in one blob) and a taker needs to see both commitments.
  let jit: Record<string, unknown> | undefined;
  if (extension !== undefined && extension !== "0x") {
    try {
      const d = decodeJitExtension(extension);
      jit = {
        generation: "2.1.0",
        adapter: d.adapter,
        collateralAsset: d.params.collateralAsset,
        referenceAsset: d.params.referenceAsset,
        expiryTimestamp: d.params.expiryTimestamp,
        recipe: d.params.recipe,
        rateOverride: d.params.rateOverride,
        constraint: { ...d.params.constraint, scale: "ABSOLUTE rates, 1e18 = 1.0" },
        additionalData: d.params.additionalData,
        swapFeePercentage: d.params.swapFeePercentage,
        unwindSwapFeePercentage: d.params.unwindSwapFeePercentage,
        enableJitMint: d.params.enableJitMint,
        permits: d.permits.length,
        note: "a fill calls the JIT adapter's preInteraction: it deploys the oracle if needed, re-checks the carried constraint with recipe.verify, creates the pool if missing, and mints per enableJitMint — one order side must be the derived pool's cST",
      };
    } catch {
      try {
        const d = legacyRegistry.decodeJitExtension(extension);
        jit = {
          generation: "legacy (pre-2.1.0)",
          adapter: d.adapter,
          collateralAsset: d.params.collateralAsset,
          referenceAsset: d.params.referenceAsset,
          expiryTimestamp: d.params.expiryTimestamp,
          mode: d.params.mode,
          swapFeePercentage: d.params.swapFeePercentage,
          unwindSwapFeePercentage: d.params.unwindSwapFeePercentage,
          enableJitMint: d.params.enableJitMint,
          permits: d.permits.length,
          note: "LEGACY mode-string JIT payload (constraint derived at FILL time from the live rate; pool id drifts with the rate) — targets the pre-2.1.0 adapter generation",
        };
      } catch {
        /* not a JIT extension either — no label; the raw fields still decode */
      }
    }
  }
  const base = {
    kind: "order" as const,
    chainId,
    lop: lop ?? null,
    order,
    makerTraits: { raw: order.makerTraits, ...traits },
    orderHash,
    ...(extension !== undefined ? { extension } : {}),
    ...(fusion ? { fusion } : {}),
    ...(jit ? { jit } : {}),
  };
  // Extension binding: OrderLib enforces salt.low160 == keccak256(extension).low160 at fill.
  if (extension !== undefined && extension !== "0x") {
    const bound = (order.salt & DECODE_U160) === (BigInt(keccak256(extension)) & DECODE_U160);
    if (!bound) {
      return envelope({
        state: "conflict",
        data: { ...base, saltBoundToExtension: false },
        chainId,
        source: "config",
        warnings: [...warnings, { code: "extension_salt_mismatch", message: "salt's low 160 bits are NOT keccak256(extension)'s low 160 bits — this order would revert InvalidExtension at fill" }],
        ctx,
      });
    }
    (base as Record<string, unknown>).saltBoundToExtension = true;
  }
  // Cross-check a caller-claimed hash against the local reconstruction [K3].
  if (claimedOrderHash !== undefined && orderHash !== null && claimedOrderHash.toLowerCase() !== orderHash.toLowerCase()) {
    return envelope({
      state: "conflict",
      data: { ...base, claimedOrderHash },
      chainId,
      source: "config",
      warnings: [...warnings, { code: "digest_mismatch", message: `the supplied orderHash ${claimedOrderHash} does not match the locally recomputed EIP-712 hash ${orderHash} — do not act on the claimed hash` }],
      ctx,
    });
  }
  return envelope({
    state: "ok",
    data: { ...base, ...(claimedOrderHash !== undefined ? { claimedOrderHash, claimedHashVerified: orderHash !== null } : {}) },
    chainId,
    source: "config",
    warnings,
    ctx,
  });
}

/** Normalize a caller-supplied log-shaped record for decodeKnownLog, with teachable failures. */
function asRawLog(rec: Record<string, unknown>, pathPrefix: string[]): RawLogLike {
  const topics = rec.topics;
  if (!Array.isArray(topics)) {
    throw new ToolInputError("cork_decode", [{ path: ["data", ...pathPrefix, "topics"], message: "expected topics: an array of 0x-prefixed 32-byte hex strings (topics[0] is the event selector)" }]);
  }
  return {
    ...(typeof rec.address === "string" ? { address: rec.address } : {}),
    topics: topics.map((t) => (typeof t === "string" ? t : null)),
    ...(typeof rec.data === "string" ? { data: rec.data } : {}),
  };
}

/** decode kind:"event" — one raw log {address?, topics[], data} → named args against the known
 *  Cork/rollover/LOP/ERC-20 ABI set; unknown or unverified layouts come back labeled raw. */
export function handleDecodeEvent(input: DecodeInput, chainId: ChainId, ctx: HandlerContext): Envelope {
  if (typeof input.data === "string") {
    throw new ToolInputError("cork_decode", [{ path: ["data"], message: "event decode takes a log OBJECT {address?, topics: string[], data: hex} — raw topics+data are what gets decoded [K3]; for transaction bytes use kind 'calldata'" }]);
  }
  const row = decodeKnownLog(asRawLog(input.data, []));
  return envelope({ state: "ok", data: { kind: "event", ...row }, chainId, source: "config", ctx });
}

/** decode kind:"receipt" — label every log in a tx receipt against the known ABI set. The
 *  receipt's own claims (status etc.) are echoed as claims; the decode work is the logs. */
export function handleDecodeReceipt(input: DecodeInput, chainId: ChainId, ctx: HandlerContext): Envelope {
  if (typeof input.data === "string") {
    throw new ToolInputError("cork_decode", [{ path: ["data"], message: "receipt decode takes the receipt OBJECT (eth_getTransactionReceipt result) — at minimum { logs: [{address?, topics[], data}] }" }]);
  }
  const logsRaw = input.data.logs;
  if (!Array.isArray(logsRaw)) {
    throw new ToolInputError("cork_decode", [{ path: ["data", "logs"], message: "expected logs: an array of log objects ({address?, topics[], data}) — the logs are what a receipt decode reconstructs from [K3]" }]);
  }
  const rows = logsRaw.map((l, i) => {
    if (!l || typeof l !== "object" || Array.isArray(l)) {
      throw new ToolInputError("cork_decode", [{ path: ["data", "logs", String(i)], message: "expected a log object {address?, topics[], data}" }]);
    }
    return decodeKnownLog(asRawLog(l as Record<string, unknown>, ["logs", String(i)]));
  });
  // Status normalization: echo the receipt's own claim in one canonical vocabulary.
  const s = input.data.status;
  const status = s === "success" || s === "0x1" || s === 1 || s === true ? "success" : s === "reverted" || s === "0x0" || s === 0 || s === false ? "reverted" : undefined;
  const known = rows.filter((r) => r.known).length;
  return envelope({
    state: "ok",
    data: {
      kind: "receipt",
      ...(status !== undefined ? { status, statusNote: "status/blockNumber/gasUsed are the receipt's own claims (echoed, not verifiable locally); the decoded logs below are reconstructed from their raw topics/data [K3]" } : {}),
      ...(typeof input.data.transactionHash === "string" ? { transactionHash: input.data.transactionHash } : {}),
      logCount: rows.length,
      knownCount: known,
      logs: rows,
    },
    chainId,
    source: "config",
    ctx,
  });
}

/** Kind router for cork_decode — order/event/receipt to their handlers, calldata inline. */
export async function handleDecode(input: DecodeInput, ctx: HandlerContext): Promise<Envelope> {
  const chainId = input.chainId ?? 1;
  if (input.kind === "order") return handleDecodeOrder(input, chainId, ctx);
  if (input.kind === "event") return handleDecodeEvent(input, chainId, ctx);
  if (input.kind === "receipt") return handleDecodeReceipt(input, chainId, ctx);
  if (typeof input.data !== "string") {
    throw new ToolInputError("cork_decode", "calldata decode requires a hex string");
  }
  let legs;
  try {
    legs = decodeBundle(input.data as `0x${string}`);
  } catch (err) {
    // Malformed top-level bytes are invalid INPUT (exit 2, teachable) — not an internal error.
    throw new ToolInputError("cork_decode", [{ path: ["data"], message: err instanceof Error ? err.message : "calldata does not decode as a Bundler3 multicall" }]);
  }
  // Plain-English rendering alongside the structured legs: these bytes usually arrive from
  // somewhere else, and "what will this DO" is the question being asked of them.
  const adapter = (await getDep(ctx, chainId)).dep?.corkAdapter;
  // Summary before the leg dump: a reader scanning the prose output wants the intent first.
  return envelope({ state: "ok", data: { kind: "calldata", summary: summarizeBundle(legs, { adapter }), legs }, chainId, source: "config", ctx });
}
