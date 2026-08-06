// Split from handlers.ts (2026-08-05): decode handlers — one typed dispatch, per-tool modules.
// Declarations are moved byte-identically; see handlers.ts for the runTool dispatch.
import { keccak256, parseTransaction, recoverTransactionAddress, type TransactionSerialized } from "viem";
import { Address, Bytes32, ChainId, DecodeInput, Envelope, Hex, UintStr } from "@cork/schemas";
import { decodeMakerTraits, decodeOrderTuple, hashLopOrder, LOP_ADDRESSES, type LopOrder } from "../orders.ts";
import { decodeJitExtension } from "../market-registry.ts";
import * as legacyRegistry from "../market-registry-legacy.ts";
import { decodeKnownLog, type RawLogLike } from "../event-decode.ts";
import { decodeFusionOrder, NotAFusionOrder } from "../fusion.ts";
import { decodeBundle, type DecodedLeg, decodeSingleCall } from "../bundle/decode.ts";
import { summarizeBundle } from "../bundle/summary.ts";
import { resolveMarketRegistry, resolveRollover } from "../config-remote.ts";
import { envelope, getDep, type HandlerContext, ToolInputError, ZERO_ADDR } from "./shared.ts";


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

/** decode kind:"tx" — a SIGNED raw transaction (legacy RLP or typed envelope 0x01–0x04): recover
 *  the signer from the signature, name the target against the chain's known Cork deployment
 *  addresses (warn plainly when unknown), and decode the inner calldata to the same labeled legs
 *  + summary as kind:"calldata". This is the validate-before-broadcast step [K3]: everything is
 *  reconstructed from the bytes; a supplied chainId that contradicts the tx's own is a conflict. */
export async function handleDecodeTx(input: DecodeInput, ctx: HandlerContext): Promise<Envelope> {
  if (typeof input.data !== "string") {
    throw new ToolInputError("cork_decode", [{ path: ["data"], message: "tx decode takes the SIGNED raw transaction bytes as 0x hex (legacy RLP or typed envelope 0x01–0x04) — the parse is reconstructed from the bytes, never supplied [K3]" }]);
  }
  const raw = input.data as `0x${string}`;
  let parsed: ReturnType<typeof parseTransaction>;
  try {
    parsed = parseTransaction(raw as TransactionSerialized);
  } catch (err) {
    throw new ToolInputError("cork_decode", [{ path: ["data"], message: `not a decodable Ethereum transaction (${err instanceof Error ? err.message.split("\n")[0] : String(err)}) — kind 'tx' takes the SIGNED serialized transaction; for inner calldata alone use kind 'calldata'` }]);
  }
  if (parsed.r === undefined || parsed.s === undefined) {
    throw new ToolInputError("cork_decode", [{ path: ["data"], message: "this transaction is UNSIGNED (no signature fields) — kind 'tx' validates signed bytes before broadcast; for unsigned bytes decode the inner calldata with kind 'calldata'" }]);
  }
  const signer = await recoverTransactionAddress({ serializedTransaction: raw as TransactionSerialized });
  const txChainId = parsed.chainId;
  // Which chain the address book resolves against: the tx's own chainId outranks the input's —
  // but the Envelope's chainId is a CLOSED enum (the advertised outputSchema), so a tx signed
  // for a chain outside this tool's coverage must not leak its raw id into provenance. The
  // truth stays in data.txChainId; the address-book lookup is skipped (we have no book there)
  // and the gap is disclosed instead of mislabeled. A legacy pre-EIP-155 tx (no chainId of its
  // own) falls back to the supplied one.
  const txChainKnown = txChainId === undefined || ChainId.safeParse(txChainId).success;
  const chainId = (txChainKnown ? (txChainId ?? input.chainId ?? 1) : (input.chainId ?? 1)) as ChainId;

  const warnings: Array<{ code: string; message: string }> = [];
  const to = parsed.to ?? null;
  let toLabel: string | null = null;
  let dep: Awaited<ReturnType<typeof getDep>>["dep"];
  if (to === null) {
    // Chain-independent: contract creation is outside every Cork prepare path.
    warnings.push({ code: "unknown_target", message: "this transaction has NO `to` (contract creation) — no Cork prepare path produces a deployment tx; do not broadcast unless you built it yourself" });
  }
  if (!txChainKnown) {
    warnings.push({ code: "unknown_deployment", message: `the transaction's own chainId ${txChainId} is not a chain this tool has an address book for — the target could not be checked against known Cork contracts (data.txChainId carries the tx's chain; provenance reports the request context ${chainId}). Identify the target independently before broadcasting` });
  } else {
    // Known-address book for the chain (best-effort config reads; every entry optional). The
    // registry/rollover resolvers read the same remote config file as getDep, so getDep's
    // staleness warning already covers all three — theirs are deliberately not duplicated.
    const got = await getDep(ctx, chainId);
    dep = got.dep;
    warnings.push(...got.depWarn);
    const [{ marketRegistry: mr }, { rollover }] = await Promise.all([resolveMarketRegistry(chainId), resolveRollover(chainId)]);
    const candidates: Array<[string, string | undefined]> = [
      ["bundler3", dep?.bundler3],
      ["corkAdapter", dep?.corkAdapter],
      ["poolManager", dep?.poolManager],
      ["constraintAdapter", dep?.constraintAdapter],
      ["whitelistManager", dep?.whitelistManager],
      ["1inch LOP v4", LOP_ADDRESSES[chainId]],
      ["marketRegistry", mr?.registry],
      ["corkLimitOrderAdapter (JIT)", mr?.adapter],
      ["exactSettler", rollover?.exactSettler],
      ["partialSettler", rollover?.partialSettler],
      ["rolloverFactory", rollover?.factory],
    ];
    toLabel = to === null ? null : (candidates.find(([, addr]) => addr !== undefined && addr.toLowerCase() === to.toLowerCase())?.[0] ?? null);
    if (to !== null && toLabel === null) {
      warnings.push({ code: "unknown_target", message: `\`to\` ${to} is not a known Cork deployment contract on chainId ${chainId}. For a token approve (authority-onboard/revoke) the target is the TOKEN itself — verify it is the token you intend; for anything else, do not broadcast until you have identified the target` });
    }
  }

  // Inner calldata → the SAME labeled legs + summary as kind:"calldata" (a Bundler3 multicall
  // unwraps recursively; any other single call labels via the known ABI set or surfaces raw).
  const data = parsed.data;
  let legs: DecodedLeg[] | undefined;
  if (data !== undefined && data !== "0x") {
    try {
      legs = decodeBundle(data);
    } catch {
      legs = [decodeSingleCall({ to: to ?? ZERO_ADDR, data, value: parsed.value ?? 0n, skipRevert: false, callbackHash: `0x${"0".repeat(64)}` })];
    }
  }
  // Same summarizer options as kind:"calldata" ({adapter} only) so the documented parity is
  // UNCONDITIONAL. Passing the signer as `account` would render legs paying the signer as
  // "you" — wrong when inspecting a third party's tx, and it silently broke the parity the
  // moment a leg referenced the signer (caught empirically 2026-08-06).
  const adapter = dep?.corkAdapter;
  const summary = legs ? summarizeBundle(legs, { adapter }) : ["(no calldata — a plain value transfer)"];
  // A ForSelf adapter is INTEGRATOR-deployed, so its address can never be in the Cork book —
  // when the calldata itself is a recognized ForSelf call, say so instead of a bare unknown.
  if (legs && legs.length === 1 && legs[0]!.kind === "forself" && to !== null) {
    const idx = warnings.findIndex((w) => w.code === "unknown_target");
    if (idx >= 0) {
      warnings[idx] = { code: "unknown_target", message: `\`to\` ${to} is not a known Cork deployment contract — but the calldata IS a Cork ForSelf adapter call ('${(legs[0] as { action: string }).action}'). ForSelf adapters are deployed by the INTEGRATOR, not Cork, so an unknown target is expected here: verify ${to} is your integrator's audited adapter (its CORK()/LOP() bindings must name the real protocols) before broadcasting` };
    }
  }

  const base = {
    kind: "tx" as const,
    txHash: keccak256(raw),
    type: parsed.type,
    chainId,
    txChainId: txChainId ?? null,
    signer,
    to,
    toLabel,
    value: parsed.value ?? 0n,
    nonce: parsed.nonce,
    gas: {
      ...(parsed.gas !== undefined ? { gas: parsed.gas } : {}),
      ...("gasPrice" in parsed && parsed.gasPrice !== undefined ? { gasPrice: parsed.gasPrice } : {}),
      ...("maxFeePerGas" in parsed && parsed.maxFeePerGas !== undefined ? { maxFeePerGas: parsed.maxFeePerGas } : {}),
      ...("maxPriorityFeePerGas" in parsed && parsed.maxPriorityFeePerGas !== undefined ? { maxPriorityFeePerGas: parsed.maxPriorityFeePerGas } : {}),
    },
    summary,
    ...(legs ? { legs } : {}),
  };
  // A supplied chainId that contradicts the tx's own is a conflict: broadcasting these bytes on
  // the requested chain is impossible (the signature commits to the tx's chainId).
  if (input.chainId !== undefined && txChainId !== undefined && input.chainId !== txChainId) {
    return envelope({
      state: "conflict",
      data: base,
      chainId,
      source: "config",
      warnings: [...warnings, { code: "chainid_mismatch", message: `the supplied chainId ${input.chainId} contradicts the transaction's own chainId ${txChainId} — the signature commits to ${txChainId}; these bytes cannot land on chainId ${input.chainId}` }],
      ctx,
    });
  }
  return envelope({ state: "ok", data: base, chainId, source: "config", warnings, ctx });
}

/** Kind router for cork_decode — order/event/receipt to their handlers, calldata inline. */
export async function handleDecode(input: DecodeInput, ctx: HandlerContext): Promise<Envelope> {
  const chainId = input.chainId ?? 1;
  if (input.kind === "tx") return handleDecodeTx(input, ctx);
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
