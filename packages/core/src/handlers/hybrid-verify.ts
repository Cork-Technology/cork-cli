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
import { classifyBitInvalidator, classifyRemainingRaw, hashLopOrder, LOP_ADDRESSES, lopInvalidatorAbi, lopInvalidatorPlan } from "../orders.ts";
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
    return {
      items: rows.map((r) => label(r, "unverified")),
      warnings: rows.length > 0 ? [{ code: "chain_read_failed", message: "no RPC resolved — hybrid verification did not run; every row is venue-claimed only (verification:'unverified')" }] : [],
      confirmed: 0,
      unverified: rows.length,
      dropped: 0,
    };
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
    if (!lop) return { items: rows.map((r) => label(r, "unverified")), warnings: [{ code: "no_lop", message: `no known 1inch LOP v4 deployment for chainId ${String(chainId)} — book rows are venue-claimed only` }], confirmed: 0, unverified: rows.length, dropped: 0 };
    // One invalidator word covers 256 orders of the same (maker, slot) — cache within the call.
    const bitWords = new Map<string, bigint>();
    for (const row of inBudget) {
      const parsed = parseSignedLopOrder(row);
      if (!parsed.ok) {
        keep(row, "unverified");
        continue;
      }
      const order = parsed.value.order;
      const localHash = hashLopOrder(chainId, lop, order);
      if (parsed.value.venueOrderHash !== undefined && parsed.value.venueOrderHash.toLowerCase() !== localHash.toLowerCase()) {
        // The row misrepresents its own order [K3] — a definitive self-contradiction.
        drop("row does not hash to its claimed orderHash");
        continue;
      }
      try {
        const plan = lopInvalidatorPlan(order.makerTraits);
        let status: { status: string };
        if (plan.mode === "bit") {
          const key = `${order.maker.toLowerCase()}:${plan.slot.toString()}`;
          let word = bitWords.get(key);
          if (word === undefined) {
            word = (await client.readContract({ address: lop, abi: lopInvalidatorAbi, functionName: "bitInvalidatorForOrder", args: [order.maker, plan.slot] })) as bigint;
            bitWords.set(key, word);
          }
          status = classifyBitInvalidator(word, plan.mask);
        } else {
          status = classifyRemainingRaw((await client.readContract({ address: lop, abi: lopInvalidatorAbi, functionName: "rawRemainingInvalidatorForOrder", args: [order.maker, localHash] })) as bigint);
        }
        if (status.status === "filled-or-cancelled") drop("on-chain invalidator says filled-or-cancelled");
        else keep(row, "confirmed");
      } catch {
        keep(row, "unverified", true);
      }
    }
  } else if (resource === "cork-pools" || resource === "trading-pairs") {
    const pms = await configuredPoolManagers(chainId);
    const existsCache = new Map<string, boolean | null>(); // poolId → exists (null = indeterminate)
    const poolExists = async (poolId: `0x${string}`): Promise<boolean | null> => {
      const hit = existsCache.get(poolId.toLowerCase());
      if (hit !== undefined) return hit;
      let sawError = false;
      let exists = false;
      for (const pm of pms) {
        try {
          const market = (await client.readContract({ address: pm, abi: poolManagerAbi, functionName: "market", args: [poolId] })) as { collateralAsset: `0x${string}` };
          if (market.collateralAsset !== zeroAddress) {
            exists = true;
            break;
          }
        } catch {
          sawError = true;
        }
      }
      const verdict = exists ? true : sawError ? null : false;
      existsCache.set(poolId.toLowerCase(), verdict);
      return verdict;
    };
    for (const row of inBudget) {
      const poolId = str(row.poolId) ?? str((row as { pool_id?: unknown }).pool_id);
      if (poolId === undefined || pms.length === 0) {
        keep(row, "unverified");
        continue;
      }
      const exists = await poolExists(poolId as `0x${string}`);
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
    if (!lop) return { items: rows.map((r) => label(r, "unverified")), warnings: [{ code: "no_lop", message: `no known 1inch LOP v4 deployment for chainId ${String(chainId)} — fill rows are venue-claimed only` }], confirmed: 0, unverified: rows.length, dropped: 0 };
    type FillRef = { row: Row; block: number; txHash: string; orderHash: string };
    const refs: FillRef[] = [];
    for (const row of inBudget) {
      const block = Number(str(row.blockNumber) ?? Number.NaN);
      const txHash = str(row.txHash)?.toLowerCase();
      const orderHash = str(row.orderHash)?.toLowerCase();
      if (!Number.isFinite(block) || txHash === undefined || orderHash === undefined) keep(row, "unverified");
      else refs.push({ row, block, txHash, orderHash });
    }
    // Cluster claimed blocks into bounded ranges so verification is a few getLogs, not N point
    // reads — the ranges are narrow and recent-ish, which ordinary public RPCs serve.
    const sorted = [...refs].sort((x, y) => x.block - y.block);
    const clusters: Array<{ from: number; to: number; refs: FillRef[] }> = [];
    for (const ref of sorted) {
      const last = clusters[clusters.length - 1];
      if (last && ref.block - last.to <= 2_000) {
        last.to = ref.block;
        last.refs.push(ref);
      } else clusters.push({ from: ref.block, to: ref.block, refs: [ref] });
    }
    const toHex = (n: number): `0x${string}` => `0x${n.toString(16)}`;
    for (const cluster of clusters) {
      try {
        const logs = (await (client as { request: (a: unknown) => Promise<Array<{ transactionHash: string | null; data: string }>> }).request({
          method: "eth_getLogs",
          params: [{ fromBlock: toHex(cluster.from), toBlock: toHex(cluster.to), address: [lop], topics: [[LOP_FILLED_TOPIC]] }],
        })) as Array<{ transactionHash: string | null; data: string }>;
        // OrderFilled(bytes32 orderHash, uint256 remaining): the orderHash is the first data word.
        const seen = new Set(logs.filter((l) => l.transactionHash !== null).map((l) => `${l.transactionHash!.toLowerCase()}:0x${l.data.slice(2, 66).toLowerCase()}`));
        for (const ref of cluster.refs) {
          if (seen.has(`${ref.txHash}:${ref.orderHash}`)) keep(ref.row, "confirmed");
          else drop("no OrderFilled log at the claimed block for this txHash+orderHash");
        }
      } catch {
        for (const ref of cluster.refs) keep(ref.row, "unverified", true);
      }
    }
  } else {
    // rollover-orders kind=orders: the settler's own orderStatus view arbitrates each row's
    // claimed lifecycle — the same read cork_track reconcile performs.
    for (const row of inBudget) {
      const digest = str(row.orderDigest) ?? str((row as { order_digest?: unknown }).order_digest);
      const settler = str(row.settler);
      const venueStatus = str(row.status);
      if (digest === undefined || settler === undefined || venueStatus === undefined) {
        keep(row, "unverified");
        continue;
      }
      try {
        const raw = (await client.readContract({ address: settler as `0x${string}`, abi: settlerStatusAbi, functionName: "orderStatus", args: [digest as `0x${string}`] })) as bigint | number;
        const chain = chainStatusName(raw);
        if (venueChainConsistent(venueStatus, chain)) keep(row, "confirmed");
        else if (!knownVenueStatus(venueStatus) || chain.startsWith("unknown(")) {
          // Vocabulary neither side of the table knows is INDETERMINATE, never a refutation —
          // the venue grows status words (observed on the 0.3.3 migration) and a newer settler
          // grows enum members; dropping on either would delete valid rows.
          keep(row, "unverified");
        } else drop(`settler orderStatus says ${chain}, contradicting the venue's ${venueStatus}`);
      } catch {
        keep(row, "unverified", true);
      }
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
