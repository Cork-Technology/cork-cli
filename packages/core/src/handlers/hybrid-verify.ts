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
import { poolManagerAbi } from "../chain/abis.ts";
import { classifyInvalidatorWord, hashLopOrder, LOP_ADDRESSES, type LopInvalidatorPlan, lopInvalidatorPlan, readLopInvalidator } from "../orders.ts";
import { parseSignedLopOrder } from "../datasources/venue.ts";
import { LOP_FILLED_TOPIC } from "../datasources/hypersync.ts";
import { chainStatusName, knownVenueStatus, settlerStatusAbi, venueChainConsistent } from "../rollover-verify.ts";
import { resolveConfig } from "../config-remote.ts";
import { getRpc, type HandlerContext } from "./shared.ts";
import type { ChainId } from "@cork/schemas";

/** Rows fully verified per call; a larger page verifies the newest BUDGET rows and labels the
 *  rest — bounded RPC cost on every default-mode read, degrading honestly, never silently. */
export const HYBRID_VERIFY_BUDGET = 50;

type Row = Record<string, unknown>;
type Warning = { code: string; message: string };

export interface HybridVerification {
  items: Row[];
  warnings: Warning[];
  confirmed: number;
  unverified: number;
  dropped: number;
}

/** Every configured Phoenix pool manager on the chain (primary + named profiles) — venue rows
 *  may live on ANY generation (the venue's existing markets are on the v1.1 PM), so existence
 *  is "any configured PM knows it". */
export async function configuredPoolManagers(chainId: number): Promise<`0x${string}`[]> {
  const cfg = await resolveConfig();
  const pms = new Set<`0x${string}`>();
  const primary = cfg.defaults.deployments[String(chainId)];
  if (primary) pms.add(primary.poolManager);
  for (const profile of Object.values(cfg.defaults.deploymentProfiles?.[String(chainId)] ?? {})) pms.add(profile.poolManager);
  return [...pms];
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

/** Verify one page of venue rows against the chain. Returns null for resources with no
 *  verifiable on-chain footprint (rfqs; rollover fills/contracts rows are already event-shaped
 *  and reconcile via cork_track) — the caller serves those rows untouched, with a note. */
export async function verifyVenueRows(a: {
  ctx: HandlerContext;
  chainId: ChainId;
  resource: string;
  kind?: string | undefined;
  rows: Row[];
}): Promise<HybridVerification | null> {
  const { ctx, chainId, resource, rows } = a;
  const verifiable =
    resource === "orderbook" || resource === "cork-pools" || resource === "trading-pairs" || resource === "fills" || (resource === "rollover-orders" && (a.kind ?? "orders") === "orders");
  if (!verifiable) return null;

  const resolved = await getRpc(ctx, chainId).catch(() => null);
  if (!resolved) {
    // The pre-rename centralized behavior, demoted to a labeled fallback: venue rows serve,
    // but every one says it is venue-claimed only.
    return allUnverified(rows, { code: "chain_read_failed", message: "no RPC resolved — hybrid verification did not run; every row is venue-claimed only (verification:'unverified')" });
  }
  const client = resolved.client;

  const inBudget = rows.slice(0, HYBRID_VERIFY_BUDGET);
  const overBudget = rows.slice(HYBRID_VERIFY_BUDGET);
  const warnings: Warning[] = [];
  if (overBudget.length > 0) {
    warnings.push({ code: "verification_budget", message: `the page has ${String(rows.length)} rows; the first ${String(HYBRID_VERIFY_BUDGET)} (newest) were chain-verified and the remaining ${String(overBudget.length)} are labeled verification:'unverified' — lower pageSize for full coverage` });
  }

  const kept: Row[] = [];
  let confirmed = 0;
  let transportUnverified = 0;
  let dropped = 0;
  const droppedWhy: string[] = [];
  const keep = (row: Row, v: "confirmed" | "unverified", transport = false) => {
    kept.push(label(row, v));
    if (v === "confirmed") confirmed += 1;
    else if (transport) transportUnverified += 1;
  };
  const drop = (why: string) => {
    dropped += 1;
    if (droppedWhy.length < 3 && !droppedWhy.includes(why)) droppedWhy.push(why);
  };

  if (resource === "orderbook") {
    const lop = LOP_ADDRESSES[chainId];
    if (!lop) return allUnverified(rows, { code: "no_lop", message: `no known 1inch LOP v4 deployment for chainId ${String(chainId)} — book rows are venue-claimed only` });
    // Phase 1 — parse every row and collect the UNIQUE invalidator reads it needs. One bit
    // word covers 256 orders of the same (maker, slot), so rows dedupe onto shared reads.
    // A read is keyed on the WORD it fetches (bit mode: maker + slot index, since 256 nonces
    // share one word; remaining mode: maker + orderHash) and carries one representative
    // (plan, maker, hash) to perform it with — readLopInvalidator owns the view's arguments.
    type InvalidatorRead = { plan: LopInvalidatorPlan; maker: `0x${string}`; orderHash: `0x${string}` };
    type BookRef = { row: Row; verdict?: "unparseable" | "hash-lie"; readKey?: string; plan?: LopInvalidatorPlan };
    const reads = new Map<string, InvalidatorRead>();
    const refs: BookRef[] = inBudget.map((row) => {
      const parsed = parseSignedLopOrder(row);
      if (!parsed.ok) return { row, verdict: "unparseable" as const };
      const order = parsed.value.order;
      const localHash = hashLopOrder(chainId, lop, order);
      if (parsed.value.venueOrderHash !== undefined && parsed.value.venueOrderHash.toLowerCase() !== localHash.toLowerCase()) {
        // The row misrepresents its own order [K3] — a definitive self-contradiction.
        return { row, verdict: "hash-lie" as const };
      }
      const plan = lopInvalidatorPlan(order.makerTraits);
      const maker = order.maker.toLowerCase() as `0x${string}`;
      const readKey = plan.mode === "bit" ? `bit:${maker}:${plan.slot.toString()}` : `raw:${maker}:${localHash.toLowerCase()}`;
      if (!reads.has(readKey)) reads.set(readKey, { plan, maker: order.maker, orderHash: localHash });
      return { row, readKey, plan };
    });
    // Phase 2 — the deduped reads run CONCURRENTLY (the default mode's latency is this leg).
    const words = new Map<string, bigint | "error">();
    await Promise.all(
      [...reads].map(async ([key, r]) => {
        try {
          words.set(key, await readLopInvalidator(client, r.plan, lop, r.maker, r.orderHash));
        } catch {
          words.set(key, "error");
        }
      }),
    );
    // Phase 3 — verdicts applied in the venue's own row order.
    for (const ref of refs) {
      if (ref.verdict === "unparseable") keep(ref.row, "unverified");
      else if (ref.verdict === "hash-lie") drop("row does not hash to its claimed orderHash");
      else {
        const word = words.get(ref.readKey!);
        if (word === undefined || word === "error") keep(ref.row, "unverified", true);
        else if (classifyInvalidatorWord(ref.plan!, word).status === "filled-or-cancelled") drop("on-chain invalidator says filled-or-cancelled");
        else keep(ref.row, "confirmed");
      }
    }
  } else if (resource === "cork-pools" || resource === "trading-pairs") {
    const pms = await configuredPoolManagers(chainId);
    const poolIdOf = (row: Row) => str(row.poolId) ?? str((row as { pool_id?: unknown }).pool_id);
    // Per pool: probe the PM generations primary-first, SEQUENTIALLY (most pools live on the
    // primary); across pools: concurrent, deduped on poolId.
    const probeExists = async (poolId: `0x${string}`): Promise<boolean | null> => {
      let sawError = false;
      for (const pm of pms) {
        try {
          const market = (await client.readContract({ address: pm, abi: poolManagerAbi, functionName: "market", args: [poolId] })) as { collateralAsset: `0x${string}` };
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
    // claimed lifecycle — the same read cork_track reconcile performs.
    const readKeyOf = (row: Row): { key: string; settler: `0x${string}`; digest: `0x${string}` } | undefined => {
      const digest = str(row.orderDigest) ?? str((row as { order_digest?: unknown }).order_digest);
      const settler = str(row.settler);
      if (digest === undefined || settler === undefined) return undefined;
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
    for (const row of inBudget) {
      const k = readKeyOf(row);
      const venueStatus = str(row.status);
      if (k === undefined || venueStatus === undefined) {
        keep(row, "unverified");
        continue;
      }
      const chain = statuses.get(k.key);
      if (chain === undefined || chain === "error") keep(row, "unverified", true);
      else if (venueChainConsistent(venueStatus, chain)) keep(row, "confirmed");
      else if (!knownVenueStatus(venueStatus) || chain.startsWith("unknown(")) {
        // Vocabulary neither side of the table knows is INDETERMINATE, never a refutation —
        // the venue grows status words (observed on the 0.3.3 migration) and a newer settler
        // grows enum members; dropping on either would delete valid rows.
        keep(row, "unverified");
      } else drop(`settler orderStatus says ${chain}, contradicting the venue's ${venueStatus}`);
    }
  }

  for (const row of overBudget) keep(row, "unverified");

  if (dropped > 0) {
    warnings.push({ code: "status_mismatch", message: `${String(dropped)} venue row(s) DROPPED — the chain definitively refutes them (${droppedWhy.join("; ")}); chain outranks the venue [K7]` });
  }
  if (transportUnverified > 0) {
    warnings.push({ code: "chain_read_failed", message: `${String(transportUnverified)} row(s) could not be verified (transport failure) — kept, labeled verification:'unverified'` });
  }
  return { items: kept, warnings, confirmed, unverified: kept.length - confirmed, dropped };
}
