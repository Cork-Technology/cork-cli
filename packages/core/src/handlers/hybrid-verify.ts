// hybrid mode's verification legs [K7]: the venue DISCOVERS rows, the chain CONFIRMS them.
// One implementation, two consumers — every read below calls the same chain-read code the
// lite-decentralized paths serve (the LOP invalidator classifiers, poolManagerAbi market()
// reads, the settler orderStatus view), never a private re-implementation.
//
// The split rule (owner decision 2026-08-13): a row the chain DEFINITIVELY refutes — a dead
// invalidator, a pool no configured pool manager knows, a fill log absent from its claimed
// block range, a rollover status the settler contradicts — is DROPPED and counted; serving it
// would hand the caller state that can only revert or mislead. A row whose verification was
// INDETERMINATE (transport failure, budget exhausted, unparseable row) is KEPT, labeled
// verification:"unverified" — evidence stays unless the chain itself refutes it.
//
// Budget (owner decision 2026-08-13): pages up to HYBRID_VERIFY_BUDGET rows verify fully;
// larger pages verify the first HYBRID_VERIFY_BUDGET rows (the venue lists newest-first) and
// label the rest "unverified" with a warning.
//
// trading-pairs rows are NEVER dropped: the venue is the authority on what is LISTED (owner
// decision 2026-08-13), and a JIT order legitimately lists a pair whose pool does not exist
// yet — chain existence rides as an `exists` annotation, not a liveness verdict.
import { zeroAddress } from "viem";
import { marketAbiFor } from "../chain/abis.ts";
import { classifyInvalidatorWord, decodeMakerTraits, hashLopOrder, isAllowedSender, LOP_ADDRESSES, type LopInvalidatorPlan, lopInvalidatorPlan, readLopInvalidator } from "../orders.ts";
import { classifyRolloverSettler } from "../rollover.ts";
import { parseSignedLopOrder, type SignedLopOrder } from "../datasources/venue.ts";
import { LOP_FILLED_TOPIC } from "../datasources/hypersync.ts";
import { chainStatusName, knownVenueStatus, settlerStatusAbi, venueChainConsistent } from "../rollover-verify.ts";
import { resolveConfig, resolveRollover } from "../config-remote.ts";
import { generationsOf, type PhoenixWire } from "../generations.ts";
import { getRpc, type HandlerContext, nowSecondsOf } from "./shared.ts";
import { authenticateBookRowSignature, type BookMakerSignature, extensionVerdict, recoverEoaSigner } from "./order-auth.ts";
import { assessMakerReadiness, gatherMakerReadinessFacts, type MakerReadiness, type MakerReadinessFacts, type MakerReadinessInput, type MakerReadinessTarget, makerReadinessTargetOf } from "./maker-readiness.ts";
import type { ChainId } from "@cork/schemas";

/** Rows fully verified per call; a larger page verifies the newest BUDGET rows and labels the
 *  rest — bounded RPC cost on every default-mode read, degrading honestly, never silently. */
export const HYBRID_VERIFY_BUDGET = 50;

type Row = Record<string, unknown>;
type Warning = { code: string; message: string };

/** One book row's signed order, parsed and re-hashed ONCE by the verifier and handed to the ranker. */
export interface ParsedBookRow {
  signed: SignedLopOrder;
  localHash: `0x${string}`;
  /** The maker-side readiness verdict (maker-readiness.ts), when the RPC leg could gather the
   *  facts — the ranker excludes "not-ready" rows with evidence, never drops them (the maker
   *  can fix every reason without re-signing, so the row may come back to life). */
  makerReadiness?: MakerReadiness;
}

export interface HybridVerification {
  items: Row[];
  warnings: Warning[];
  confirmed: number;
  unverified: number;
  dropped: number;
  /** orderbook only: parse results keyed by lowercase order hash, so the ranker that follows
   *  never parses or hashes a row a second time (the same bytes, the same verdict). */
  parsed?: ReadonlyMap<string, ParsedBookRow>;
}

/** Every configured Phoenix pool manager on the chain (every generation, resolution order —
 *  read-only sets included) — venue rows may live on ANY generation (the venue's existing
 *  markets are on the arbitrum-v1.1 PM), so existence is "any configured PM knows it". */
export async function configuredPoolManagers(chainId: number): Promise<`0x${string}`[]> {
  return (await configuredPoolManagerRefs(chainId)).map((r) => r.poolManager);
}

/** The same managers WITH the wire each speaks and its generation label — what a MarketCreated
 *  scan needs to pick the decode ABI per emitter, and what an existence probe needs to pick the
 *  `market()` ABI per manager. One address appears once (its first generation, resolution order). */
export async function configuredPoolManagerRefs(chainId: number): Promise<Array<{ poolManager: `0x${string}`; wire: PhoenixWire; label: string }>> {
  const cfg = await resolveConfig();
  const seen = new Set<string>();
  const out: Array<{ poolManager: `0x${string}`; wire: PhoenixWire; label: string }> = [];
  for (const g of generationsOf(cfg.defaults, chainId)) {
    if (!g.phoenix) continue;
    const pm = g.phoenix.poolManager as `0x${string}`;
    if (seen.has(pm.toLowerCase())) continue;
    seen.add(pm.toLowerCase());
    out.push({ poolManager: pm, wire: g.phoenix.wire, label: g.label });
  }
  return out;
}

const label = (row: Row, verification: "confirmed" | "unverified"): Row => ({ ...row, verification });

/** Every row served venue-claimed under one warning — the no-RPC / no-LOP degradations. */
const allUnverified = (rows: Row[], warning: Warning | undefined): HybridVerification => ({
  items: rows.map((r) => label(r, "unverified")),
  warnings: warning !== undefined && rows.length > 0 ? [warning] : [],
  confirmed: 0,
  unverified: rows.length,
  dropped: 0,
});

/** The one non-readContract call the fills leg needs — a structural subset of viem's
 *  PublicClient (same shape the live-tail uses), so the resolved client satisfies it without
 *  cast chains. */
interface EthGetLogsClient {
  request(args: { method: "eth_getLogs"; params: [Record<string, unknown>] }): Promise<Array<{ transactionHash: string | null; data: string }>>;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);

/** How a book row's signed exclusivity reads to a caller: `open` = any taker; `reserved` = the
 *  makerTraits name a filler and no fill sender was given to compare; `reserved-for-account` /
 *  `reserved-for-other` = compared against `filters.account` (the taker account on a raw fill,
 *  the ForSelf adapter on a wrapper fill — whoever calls the LOP). */
/** The reach vocabulary a book row can carry — one runtime list so the `orders` doc topic can be
 *  held to it by a test (a value added here without a topic line fails offline). */
export const BOOK_EXCLUSIVITY = ["open", "reserved", "reserved-for-account", "reserved-for-other"] as const;
export type BookExclusivity = (typeof BOOK_EXCLUSIVITY)[number];

/** The per-row parse record annotateBookRows builds; the RPC leg later MUTATES `makerReadiness`
 *  onto it in place — parsedByHash holds the same object, so the ranker sees the verdict. */
type ParsedBookEntry = { signed: SignedLopOrder; localHash: `0x${string}`; makerSignature: BookMakerSignature; makerReadiness?: MakerReadiness };

interface AnnotatedBook {
  lop: `0x${string}`;
  /** The served rows in the venue's order — self-contradicting rows removed, the rest carrying
   *  `allowedSender` + `exclusivity` decoded from their own signed makerTraits. */
  rows: Row[];
  /** Parse results keyed by SERVED row, so the liveness leg never re-parses. `makerSignature`
   *  is what the chain-free half could settle: `eoa-verified` (ecrecover to the maker), or
   *  `unverified` — the signature did not recover to the maker, so only the maker's own
   *  ERC-1271 answer (an RPC read, the liveness leg's job) can validate or refute it. */
  parsed: Map<Row, ParsedBookEntry>;
  dropped: number;
  warnings: Warning[];
}

/** The chain-free half of orderbook verification [K3], run on EVERY row whether or not an RPC
 *  resolves: parse the signed order once, re-hash it, check the extension rule OrderLib enforces
 *  at fill, ecrecover the signature, and decode what its makerTraits commit to. Two
 *  self-contradictions are settled here without a chain read, and a row showing either is
 *  DROPPED: it does not hash to its own claimed orderHash (unusable under either hash), or its
 *  extension bytes are not the ones its salt commits to (the fill reverts InvalidExtension).
 *  The signature is NEVER settled negative here. One that ecrecovers to the maker is settled
 *  positive (`eoa-verified`); every other one — a different signer, or bytes ecrecover cannot
 *  read at all (a Safe7579 maker signs `validator ++ sig`, 85 bytes; an ERC-1271 maker may sign
 *  anything its own validator accepts) — is handed to the liveness leg for the maker's own
 *  ERC-1271 answer, and dropped only when the chain refutes it (an EOA that never signed it, a
 *  contract whose isValidSignature rejects). rc.4 dropped the unreadable case chain-free and
 *  hid every live Safe-maker row on Base (2026-09-11). The venue's `makerAccountType` claim is
 *  never the arbiter.
 *  Exclusivity is served from the LOCAL decode — the venue's `allowedSender` echo is replaced,
 *  never read as truth; an echo that contradicted the signed bytes is counted and disclosed.
 *  An unparseable row rides through untouched (the liveness leg labels it unverified). */
async function annotateBookRows(rows: Row[], chainId: number, lop: `0x${string}`, account: `0x${string}` | undefined): Promise<AnnotatedBook> {
  const parsed = new Map<Row, ParsedBookEntry>();
  const served: Row[] = [];
  let hashLies = 0;
  let extensionLies = 0;
  let echoLies = 0;
  for (const row of rows) {
    const p = parseSignedLopOrder(row);
    if (!p.ok) {
      served.push(row);
      continue;
    }
    const localHash = hashLopOrder(chainId, lop, p.value.order);
    if (p.value.venueOrderHash !== undefined && p.value.venueOrderHash.toLowerCase() !== localHash.toLowerCase()) {
      hashLies += 1;
      continue;
    }
    if (!extensionVerdict(p.value.order, p.value.extension).valid) {
      extensionLies += 1;
      continue;
    }
    const recovered = await recoverEoaSigner(localHash, p.value.signature);
    // Only a positive ecrecover is settled here. `signer: null` (bytes ecrecover cannot read) is
    // the SHAPE of a contract maker's signature, not a refutation — the chain decides.
    const makerSignature: BookMakerSignature = recovered.signer !== null && recovered.signer.toLowerCase() === p.value.order.maker.toLowerCase() ? "eoa-verified" : "unverified";
    const traits = p.value.order.makerTraits;
    const allowedSender = decodeMakerTraits(traits).allowedSender;
    const echo = row.allowedSender;
    if (echo !== undefined && (typeof echo === "string" ? echo.toLowerCase() : null) !== allowedSender) echoLies += 1;
    const exclusivity: BookExclusivity =
      allowedSender === null ? "open" : account === undefined ? "reserved" : isAllowedSender(traits, account) ? "reserved-for-account" : "reserved-for-other";
    const annotated: Row = { ...row, allowedSender, exclusivity, makerSignature };
    parsed.set(annotated, { signed: p.value, localHash, makerSignature });
    served.push(annotated);
  }
  const warnings: Warning[] = [];
  if (hashLies > 0) {
    warnings.push({ code: "order_hash_mismatch", message: `${String(hashLies)} venue row(s) DROPPED — the signed order they carry does not hash to their claimed orderHash [K3]; a row that misrepresents its own order is unusable under either hash` });
  }
  if (extensionLies > 0) {
    warnings.push({ code: "signature_or_reconstruction_mismatch", message: `${String(extensionLies)} venue row(s) DROPPED chain-free — their extension bytes are not the ones the salt/makerTraits commit to (OrderLib.isValidExtension): no fill of such a row can ever succeed [K3]` });
  }
  if (echoLies > 0) {
    warnings.push({ code: "listing_traits_mismatch", message: `${String(echoLies)} venue row(s) listed an allowedSender that contradicts their signed makerTraits — the served allowedSender/exclusivity are decoded locally from the signed word [K3]; the venue's echo was not used` });
  }
  return { lop, rows: served, parsed, dropped: hashLies + extensionLies, warnings };
}

/** Verify one page of venue rows against the chain. Returns null for resources with no
 *  verifiable on-chain footprint (rfqs; rollover fills/contracts rows are already event-shaped
 *  and reconcile via cork_track) — the caller serves those rows untouched, with a note. */
export async function verifyVenueRows(a: {
  ctx: HandlerContext;
  chainId: ChainId;
  resource: string;
  kind?: string | undefined;
  rows: Row[];
  /** orderbook only: the fill sender each row's exclusivity is classified against. */
  account?: `0x${string}` | undefined;
}): Promise<HybridVerification | null> {
  const { ctx, chainId, resource } = a;
  const verifiable =
    resource === "orderbook" || resource === "cork-pools" || resource === "trading-pairs" || resource === "fills" || (resource === "rollover-orders" && (a.kind ?? "orders") === "orders");
  if (!verifiable) return null;

  // The orderbook's chain-free half runs first, RPC or not: it needs only the LOP domain (for
  // the re-hash) and the rows' own signed bytes.
  let book: AnnotatedBook | undefined;
  if (resource === "orderbook") {
    const lop = LOP_ADDRESSES[chainId];
    if (!lop) return allUnverified(a.rows, { code: "no_lop", message: `no known 1inch LOP v4 deployment for chainId ${String(chainId)} — book rows are venue-claimed only` });
    book = await annotateBookRows(a.rows, chainId, lop, a.account);
  }
  const rows = book ? book.rows : a.rows;
  // Re-key the parse results by hash: `kept` rows are relabeled copies, so identity keys would
  // not survive to the ranker; the hash is what both sides already hold.
  const parsedByHash = book ? new Map([...book.parsed.values()].map((p) => [p.localHash.toLowerCase(), p] as const)) : undefined;

  const resolved = await getRpc(ctx, chainId).catch(() => null);
  if (!resolved) {
    // The pre-rename centralized behavior, demoted to a labeled fallback: venue rows serve,
    // but every one says it is venue-claimed only. What the rows' own bytes already settled
    // (the book's self-contradictions) stays settled.
    const out = allUnverified(rows, { code: "chain_read_failed", message: "no RPC resolved — hybrid verification did not run; every row is venue-claimed only (verification:'unverified')" });
    return book ? { ...out, warnings: [...book.warnings, ...out.warnings], dropped: book.dropped, ...(parsedByHash ? { parsed: parsedByHash } : {}) } : out;
  }
  const client = resolved.client;

  const inBudget = rows.slice(0, HYBRID_VERIFY_BUDGET);
  const overBudget = rows.slice(HYBRID_VERIFY_BUDGET);
  const warnings: Warning[] = [...(book?.warnings ?? [])];
  if (overBudget.length > 0) {
    warnings.push({ code: "verification_budget", message: `the page has ${String(rows.length)} rows; the first ${String(HYBRID_VERIFY_BUDGET)} (newest) were chain-verified and the remaining ${String(overBudget.length)} are labeled verification:'unverified' — lower pageSize for full coverage` });
  }

  const kept: Row[] = [];
  let confirmed = 0;
  let transportUnverified = 0;
  let dropped = book?.dropped ?? 0; // the total, chain-free drops included (`verification.dropped`)
  let chainDropped = 0; // the rows THIS leg refuted — the only ones `status_mismatch` may claim
  const droppedWhy: string[] = [];
  const keep = (row: Row, v: "confirmed" | "unverified", transport = false) => {
    kept.push(label(row, v));
    if (v === "confirmed") confirmed += 1;
    else if (transport) transportUnverified += 1;
  };
  const drop = (why: string) => {
    dropped += 1;
    chainDropped += 1;
    if (droppedWhy.length < 3 && !droppedWhy.includes(why)) droppedWhy.push(why);
  };

  if (book) {
    const bookLop = book.lop;
    const nowSeconds = nowSecondsOf(ctx);
    // Phase 1 — from the chain-free parse above, collect the UNIQUE invalidator reads the
    // page needs. One bit word covers 256 orders of the same (maker, slot), so rows dedupe
    // onto shared reads. A read is keyed on the WORD it fetches (bit mode: maker + slot index,
    // since 256 nonces share one word; remaining mode: maker + orderHash) and carries one
    // representative (plan, maker, hash) to perform it with — readLopInvalidator owns the
    // view's arguments.
    type InvalidatorRead = { plan: LopInvalidatorPlan; maker: `0x${string}`; orderHash: `0x${string}` };
    type BookRef = { row: Row; parsed?: ParsedBookEntry; readKey?: string; plan?: LopInvalidatorPlan };
    const reads = new Map<string, InvalidatorRead>();
    const refs: BookRef[] = inBudget.map((row) => {
      const parsed = book.parsed.get(row);
      if (!parsed) return { row }; // unparseable — served, labeled unverified below
      const { order } = parsed.signed;
      const plan = lopInvalidatorPlan(order.makerTraits);
      const maker = order.maker.toLowerCase() as `0x${string}`;
      const readKey = plan.mode === "bit" ? `bit:${maker}:${plan.slot.toString()}` : `raw:${maker}:${parsed.localHash.toLowerCase()}`;
      if (!reads.has(readKey)) reads.set(readKey, { plan, maker: order.maker, orderHash: parsed.localHash });
      return { row, parsed, readKey, plan };
    });
    // Readiness plan, still chain-free: one fact gather per distinct maker-side CONTEXT (maker,
    // makerAsset, sourcing, JIT hook) — a maker with several rungs on one pair dedupes onto one
    // gather. When any row of a context proved ECDSA capability chain-free (eoa-verified), that
    // target wins the slot so the maker's own getCode is skipped for the whole context.
    const readinessTargets = new Map<string, MakerReadinessTarget>();
    const readinessInputByRow = new Map<Row, { key: string; input: Omit<MakerReadinessInput, "facts"> }>();
    for (const ref of refs) {
      if (!ref.parsed) continue;
      const rCtx = makerReadinessTargetOf({ order: ref.parsed.signed.order, extension: ref.parsed.signed.extension, lop: bookLop, makerSignedEcdsa: ref.parsed.makerSignature === "eoa-verified" });
      const t = rCtx.target;
      const jit = t.jit;
      const key = [t.maker, t.makerAsset, t.usePermit2 ? "p2" : "erc20", jit ? [jit.adapter, jit.collateralAsset, String(jit.enableJitMint), jit.predictedCorkSwapToken ?? "?"].join(",") : "-"].join(":").toLowerCase();
      const existing = readinessTargets.get(key);
      if (existing === undefined || (!existing.makerSignedEcdsa && t.makerSignedEcdsa)) readinessTargets.set(key, t);
      readinessInputByRow.set(ref.row, {
        key,
        input: { makerAsset: t.makerAsset, makingAmount: ref.parsed.signed.order.makingAmount, allowPartialFills: rCtx.allowPartialFills, usePermit2: t.usePermit2, jit, extensionPermitToken: rCtx.extensionPermitToken, nowSeconds },
      });
    }
    // Phase 2 — ONE Promise.all for every chain leg the page needs: the signature ladders for
    // rows the chain-free half could not settle (a refutation DROPS the row, an unreachable
    // maker leaves it `unverified`; contract makers are the exception on a book, so the common
    // page pays nothing), the deduped invalidator reads, and the readiness gathers. Issued in
    // the SAME tick deliberately: a batching client coalesces every readContract leg into one
    // aggregate3 per page (sequential Promise.alls would tick apart into separate multicalls).
    const signatureOutcome = new Map<Row, Awaited<ReturnType<typeof authenticateBookRowSignature>>>();
    const words = new Map<string, bigint | "error">();
    const factsByKey = new Map<string, MakerReadinessFacts>();
    await Promise.all([
      ...inBudget.map(async (row) => {
        const parsed = book.parsed.get(row);
        if (!parsed || parsed.makerSignature !== "unverified") return;
        signatureOutcome.set(row, await authenticateBookRowSignature(client, { maker: parsed.signed.order.maker, orderHash: parsed.localHash, signature: parsed.signed.signature }));
      }),
      ...[...reads].map(async ([key, r]) => {
        try {
          words.set(key, await readLopInvalidator(client, r.plan, bookLop, r.maker, r.orderHash));
        } catch {
          words.set(key, "error");
        }
      }),
      ...[...readinessTargets].map(async ([key, t]) => {
        factsByKey.set(key, await gatherMakerReadinessFacts(client, t));
      }),
    ]);
    // Phase 3 — verdicts applied in the venue's own row order. `confirmed` means BOTH legs
    // answered positively: the maker signed it (chain-free or via ERC-1271) AND the bit is
    // unspent; either leg indeterminate leaves the row `unverified`, either leg refuting DROPS it.
    let notReady = 0;
    for (const ref of refs) {
      if (ref.readKey === undefined) {
        keep(ref.row, "unverified");
        continue;
      }
      const sig = signatureOutcome.get(ref.row);
      if (sig?.outcome === "refuted") {
        drop(`maker signature refuted: ${sig.why}`);
        continue;
      }
      const word = words.get(ref.readKey);
      if (word !== undefined && word !== "error" && classifyInvalidatorWord(ref.plan!, word).status === "filled-or-cancelled") {
        drop("on-chain invalidator says filled-or-cancelled");
        continue;
      }
      const makerSignature: BookMakerSignature = sig === undefined ? ref.parsed!.makerSignature : sig.outcome === "verified" ? "erc1271-verified" : "unverified";
      const liveness = word === undefined || word === "error" ? "indeterminate" : "live";
      // Maker-side readiness (an annotation, never a liveness verdict): classified from the
      // facts the one-batch fetched, mutated onto the parse record so the ranker (which holds
      // the same object via parsedByHash) can exclude with evidence.
      const rIn = readinessInputByRow.get(ref.row);
      const facts = rIn ? factsByKey.get(rIn.key) : undefined;
      let makerReadiness: MakerReadiness | undefined;
      if (rIn && facts && ref.parsed) {
        makerReadiness = assessMakerReadiness({ ...rIn.input, facts });
        ref.parsed.makerReadiness = makerReadiness;
        if (makerReadiness.status === "not-ready") notReady += 1;
      }
      const row = { ...ref.row, makerSignature, ...(makerReadiness ? { makerReadiness } : {}) };
      if (liveness === "live" && makerSignature !== "unverified") keep(row, "confirmed");
      else keep(row, "unverified", liveness === "indeterminate" || sig?.outcome === "indeterminate");
    }
    if (notReady > 0) {
      warnings.push({
        code: "maker_not_ready",
        message: `${String(notReady)} book row(s) are maker-side NOT READY: chain reads prove every fill of them currently reverts or silently moves nothing (each row's makerReadiness.reasons say why — the 2026-09-11 class was a contract maker on a not-yet-created cST). A ranked read excludes them with the evidence under whyNotFillable; the maker can fix every reason without re-signing, so re-read after the maker acts`,
      });
    }
  } else if (resource === "cork-pools" || resource === "trading-pairs") {
    const pms = await configuredPoolManagerRefs(chainId);
    const poolIdOf = (row: Row) => str(row.poolId) ?? str((row as { pool_id?: unknown }).pool_id);
    // Per pool: probe the PM generations primary-first, SEQUENTIALLY (most pools live on the
    // primary); across pools: concurrent, deduped on poolId. Each manager is read through the
    // market() ABI of ITS wire — the 8-field ABI decodes a 10-field return silently (dropping the
    // fee words), which happens to leave collateralAsset intact today, but an existence probe
    // that only works by accident of word order is not a probe.
    const probeExists = async (poolId: `0x${string}`): Promise<boolean | null> => {
      let sawError = false;
      for (const pm of pms) {
        try {
          const market = (await client.readContract({ address: pm.poolManager, abi: marketAbiFor(pm.wire), functionName: "market", args: [poolId] })) as { collateralAsset: `0x${string}` };
          if (market.collateralAsset !== zeroAddress) return true;
        } catch {
          sawError = true;
        }
      }
      return sawError ? null : false;
    };
    const existsById = new Map<string, boolean | null>();
    await Promise.all(
      [...new Set(inBudget.flatMap((row) => (poolIdOf(row) !== undefined && pms.length > 0 ? [poolIdOf(row)!.toLowerCase()] : [])))].map(async (id) => {
        existsById.set(id, await probeExists(id as `0x${string}`));
      }),
    );
    for (const row of inBudget) {
      const poolId = poolIdOf(row);
      if (poolId === undefined || pms.length === 0) {
        keep(row, "unverified");
        continue;
      }
      const exists = existsById.get(poolId.toLowerCase()) ?? null;
      if (resource === "trading-pairs") {
        // Listing authority stays with the venue: existence is an annotation, never a drop —
        // a JIT order legitimately lists a pair whose pool is created at fill time.
        if (exists === null) {
          keep(row, "unverified", true);
        } else {
          kept.push({ ...row, verification: "confirmed", exists });
          confirmed += 1;
        }
      } else if (exists === true) keep(row, "confirmed");
      else if (exists === null) keep(row, "unverified", true);
      else drop("no configured pool manager knows this poolId");
    }
  } else if (resource === "fills") {
    const lop = LOP_ADDRESSES[chainId];
    if (!lop) return allUnverified(rows, { code: "no_lop", message: `no known 1inch LOP v4 deployment for chainId ${String(chainId)} — fill rows are venue-claimed only` });
    type FillRef = { row: Row; block: number; txHash: string; orderHash: string; verdict?: "confirmed" | "refuted" | "transport" };
    const refByRow = new Map<Row, FillRef>();
    for (const row of inBudget) {
      const block = Number(str(row.blockNumber) ?? Number.NaN);
      const txHash = str(row.txHash)?.toLowerCase();
      const orderHash = str(row.orderHash)?.toLowerCase();
      if (Number.isFinite(block) && txHash !== undefined && orderHash !== undefined) refByRow.set(row, { row, block, txHash, orderHash });
    }
    // Cluster claimed blocks into bounded ranges so verification is a few getLogs, not N point
    // reads — the ranges are narrow and recent-ish, which ordinary public RPCs serve. Clusters
    // scan concurrently; verdicts land back on the refs, and the emit loop below walks the
    // VENUE's row order (the sort here is for clustering only, never for output).
    const sorted = [...refByRow.values()].sort((x, y) => x.block - y.block);
    const clusters: Array<{ from: number; to: number; refs: FillRef[] }> = [];
    for (const ref of sorted) {
      const last = clusters[clusters.length - 1];
      if (last && ref.block - last.to <= 2_000) {
        last.to = ref.block;
        last.refs.push(ref);
      } else clusters.push({ from: ref.block, to: ref.block, refs: [ref] });
    }
    const toHex = (n: number): `0x${string}` => `0x${n.toString(16)}`;
    await Promise.all(
      clusters.map(async (cluster) => {
        try {
          const logs = await (client as EthGetLogsClient).request({
            method: "eth_getLogs",
            params: [{ fromBlock: toHex(cluster.from), toBlock: toHex(cluster.to), address: [lop], topics: [[LOP_FILLED_TOPIC]] }],
          });
          // OrderFilled(bytes32 orderHash, uint256 remaining): the orderHash is the first data word.
          const seen = new Set(logs.filter((l) => l.transactionHash !== null).map((l) => `${l.transactionHash!.toLowerCase()}:0x${l.data.slice(2, 66).toLowerCase()}`));
          for (const ref of cluster.refs) ref.verdict = seen.has(`${ref.txHash}:${ref.orderHash}`) ? "confirmed" : "refuted";
        } catch {
          for (const ref of cluster.refs) ref.verdict = "transport";
        }
      }),
    );
    for (const row of inBudget) {
      const ref = refByRow.get(row);
      if (ref === undefined) keep(row, "unverified");
      else if (ref.verdict === "confirmed") keep(row, "confirmed");
      else if (ref.verdict === "refuted") drop("no OrderFilled log at the claimed block for this txHash+orderHash");
      else keep(row, "unverified", true);
    }
  } else {
    // rollover-orders kind=orders: the settler's own orderStatus view arbitrates each row's
    // claimed lifecycle — the same read cork_track reconcile performs. But the SETTLER ADDRESS
    // comes from the venue row, which is untrusted discovery data (audit STATE-003): only a
    // configured active or retired generation may be called or believed. An unknown address is
    // never queried — a read against it is an attacker-chosen contract answering a question we
    // would then treat as chain truth — and its row stays venue-provenance, labeled.
    const { rollover } = await resolveRollover(chainId);
    /** The row's settler standing: which generation (active | retired, with its label) or unknown. */
    const generationOf = (row: Row): { status: "active" | "retired"; label: string } | { status: "unknown" } | undefined => {
      const settler = str(row.settler);
      if (settler === undefined) return undefined;
      if (!rollover) return { status: "unknown" };
      const c = classifyRolloverSettler(rollover, settler);
      return c.status === "unknown" ? c : { status: c.status, label: c.generation.label };
    };
    const readKeyOf = (row: Row): { key: string; settler: `0x${string}`; digest: `0x${string}` } | undefined => {
      const digest = str(row.orderDigest) ?? str((row as { order_digest?: unknown }).order_digest);
      const settler = str(row.settler);
      const generation = generationOf(row);
      if (digest === undefined || settler === undefined || generation === undefined || generation.status === "unknown") return undefined;
      return { key: `${settler.toLowerCase()}:${digest.toLowerCase()}`, settler: settler as `0x${string}`, digest: digest as `0x${string}` };
    };
    const statuses = new Map<string, string | "error">();
    await Promise.all(
      [...new Map(inBudget.flatMap((row) => { const k = readKeyOf(row); return k ? [[k.key, k] as const] : []; })).values()].map(async (k) => {
        try {
          const raw = (await client.readContract({ address: k.settler, abi: settlerStatusAbi, functionName: "orderStatus", args: [k.digest] })) as bigint | number;
          statuses.set(k.key, chainStatusName(raw));
        } catch {
          statuses.set(k.key, "error");
        }
      }),
    );
    const unknownSettlers = new Set<string>();
    for (const row of inBudget) {
      const generation = generationOf(row);
      // The generation rides on the row: a reader can see WHY a row is unverified, and WHICH
      // configured generation (its label) vouched for a verified one.
      const labeled =
        generation === undefined ? row
        : generation.status === "unknown" ? { ...row, settlerGeneration: "unknown" }
        : { ...row, settlerGeneration: generation.status, settlerGenerationLabel: generation.label };
      if (generation?.status === "unknown") unknownSettlers.add(str(row.settler)!.toLowerCase());
      const k = readKeyOf(row);
      const venueStatus = str(row.status);
      if (k === undefined || venueStatus === undefined) {
        keep(labeled, "unverified");
        continue;
      }
      const chain = statuses.get(k.key);
      if (chain === undefined || chain === "error") keep(labeled, "unverified", true);
      else if (venueChainConsistent(venueStatus, chain)) keep(labeled, "confirmed");
      else if (!knownVenueStatus(venueStatus) || chain.startsWith("unknown(")) {
        // Vocabulary neither side of the table knows is INDETERMINATE, never a refutation —
        // the venue grows status words (observed on the 0.3.3 migration) and a newer settler
        // grows enum members; dropping on either would delete valid rows.
        keep(labeled, "unverified");
      } else drop(`settler orderStatus says ${chain}, contradicting the venue's ${venueStatus}`);
    }
    if (unknownSettlers.size > 0) {
      warnings.push({
        code: "settler_not_recognized",
        message: `${String(unknownSettlers.size)} venue row(s) name a settler that is not a configured active or retired Cork generation (${[...unknownSettlers].join(", ")}) — no orderStatus read was issued against it and those rows stay venue-provenance (verification:"unverified"). A read against an unrecognized contract would let it answer a question we then treat as chain truth`,
      });
    }
  }

  for (const row of overBudget) keep(row, "unverified");

  if (chainDropped > 0) {
    warnings.push({ code: "status_mismatch", message: `${String(chainDropped)} venue row(s) DROPPED — the chain definitively refutes them (${droppedWhy.join("; ")}); chain outranks the venue [K7]` });
  }
  if (transportUnverified > 0) {
    warnings.push({ code: "chain_read_failed", message: `${String(transportUnverified)} row(s) could not be verified (transport failure) — kept, labeled verification:'unverified'` });
  }
  return { items: kept, warnings, confirmed, unverified: kept.length - confirmed, dropped, ...(parsedByHash ? { parsed: parsedByHash } : {}) };
}
