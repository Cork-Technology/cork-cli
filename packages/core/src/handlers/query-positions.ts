// account-state WITHOUT filters.poolId — the account's positions across EVERY generation of the
// chain (migration, 2026-09-22; owner requirement: v0.6.0 supports the previous and the current
// generation at once so users can move funds). A fund migration starts from "what do I hold
// where": the venue's existing pools live on the older managers (453 on Arbitrum across three
// managers, 466 on Base, 2026-09-22), the new set's pools on the 10-field primary, and nobody
// wants to paste 450 poolIds into single-pool reads. This read takes the pools every configured
// pool manager created — enumerated under the mode's connectivity pledge: YOUR RPC alone by
// default (the MarketCreated scan through the adaptive-window eth_getLogs source, each log decoded
// with the ABI of its EMITTER's declared wire; live 2026-09-23: 455 pools on Arbitrum, 470 on
// Base, complete in ~3 s — more than the venue lists), HyperSync under full-decentralized, the
// venue's pool list under hybrid (balances still from your RPC; the opt-in for an endpoint that
// caps eth_getLogs so hard the walk cannot finish) — sweeps `balanceOf(account)` on every pool's
// cST and cPT, and keeps the pools with a non-zero position, each tagged with its generation.
// History: the read defaulted to the venue for one day (2026-09-22) because the scan answered
// `pools: 0, complete: false` — the windowed source's fixed 50k window from block 0, not a
// property of chain-only enumeration. It is a sub-feature of the query handler and RE-ENTERS its
// scan/venue machinery through
// an injected function (`deps.enumeratePools`), never an import back — the rule every query-*.ts
// sibling follows so no import cycle exists.
//
// Why `provenance.generation` is ABSENT here: the ref names the ONE set a result describes, and
// this result spans several — each position carries its own `generation`. Why the totals are
// always summable: cST and cPT are 18-decimal share tokens on every generation (protocol
// invariant, the same claim the compute labels make), so a per-generation sum of shares is exact;
// collateral and reference balances are NOT read here (they are per-token, not per-position — the
// single-pool read has them).
import { z } from "zod";
import { type ChainId, Envelope, QueryInput, UNITS_TOPIC_REFERENCE } from "@cork/schemas";
import { erc20Abi } from "../chain/abis.ts";
import type { ResolvedRpc } from "../chain/rpc.ts";
import { resolveGenerations } from "../config-remote.ts";
import type { MarketRow } from "../datasources/hypersync.ts";
import { type GenerationRef, type ResolvedGeneration, resolveGenerationAlias } from "../generations.ts";
import { chainReadFailed, envelope, generationRefOf, type HandlerContext, nowSecondsOf, rpcProvenance, rpcWarn, ToolInputError, unavailable } from "./shared.ts";
import type { QueryFilters } from "./filters.ts";

/** One pool manager the sweep asks, with its wire (the MarketCreated ABI) and its generation. */
export interface PositionsEmitter {
  poolManager: `0x${string}`;
  wire: "8-field" | "10-field";
  label: string;
}

/** What the query handler lends this read: the pool-creation scan over a set of emitters. The
 *  handler picks the source (an injected HyperSync source, or the windowed eth_getLogs fallback
 *  over the resolved RPC — this is a lite-decentralized read, RPC only) and runs its
 *  backfill+tail primitive; the rows come back decoded per emitter wire. */
export interface PositionsDeps {
  enumeratePools(emitters: readonly PositionsEmitter[]): Promise<{ rows: MarketRow[]; complete: boolean; warnings: Array<{ code: string; message: string }>; /** which pledge served the enumeration — echoed as provenance.mode */ source: "lite-decentralized" | "hybrid" | "full-decentralized" }>;
}

/** The positions sweep walks the venue's pool list at the venue's MAXIMUM page (200 rows): the read
 *  is about completeness — every pool on every generation — and the live count is 453 pools on
 *  Arbitrum / 466 on Base (2026-09-22), so the default 25-row page × 10 pages answered `pools: 250,
 *  complete: false` on both chains. `pageSize` is a per-page presentation knob for lists; here
 *  `maxPages` alone bounds the walk (10 × 200 = 2000 pools before `pagination_incomplete`). */
export const POSITIONS_SWEEP_PAGE_SIZE = 200;

/** The venue serves a pool's `expiry` as an ISO-8601 timestamp (`2026-08-10T12:30:00.000Z`,
 *  verified live 2026-09-22); the chain scan serves unix seconds. The sweep's rows are the scan's
 *  shape, so a venue expiry is normalised to decimal seconds here — an ISO string through
 *  Date.parse (floored to the second), a digits-only string or number verbatim, anything else
 *  undefined (the caller skips the row and discloses the count). The first live run against a real
 *  position threw `Failed to parse String to BigInt` on the ISO form. */
export function venueExpirySeconds(v: unknown): string | undefined {
  if (typeof v === "number" && Number.isFinite(v) && v >= 0) return String(Math.floor(v));
  if (typeof v !== "string" || v.length === 0) return undefined;
  if (/^[0-9]+$/.test(v)) return v;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? String(Math.floor(ms / 1000)) : undefined;
}

const Address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
/** A token leg as the venue serves it: a bare address, or the `{ address, symbol, decimals }`
 *  object /pools/v1 carries (verified live 2026-09-22) — both read to the address. */
const TokenRef = z.union([Address, z.object({ address: Address }).loose().transform((t) => t.address)]);
/** The subset of a venue /pools/v1 row the sweep needs. `.loose()`: the venue adds fields freely
 *  and none of them may break an enumeration. */
const VenuePoolRow = z
  .object({
    poolId: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
    poolManagerAddress: Address,
    swapToken: TokenRef,
    principalToken: TokenRef,
    collateralToken: TokenRef,
    referenceToken: TokenRef,
    expiry: z.unknown(),
    rateOracleAddress: TokenRef.optional(),
    deploymentBlockNumber: z.union([z.string(), z.number()]).optional(),
    deploymentTxHash: z.string().optional(),
  })
  .loose();

/** Venue /pools/v1 rows → the scan's MarketRow shape, attributed to the asked emitters. PURE: a row
 *  on a manager no asked generation owns is skipped (a filtered-out set, or venue noise — another
 *  chain's row cannot occur, the list is chain-scoped server-side); a row that fails the shape is
 *  skipped; a row whose expiry is unreadable is skipped AND counted so the caller can disclose it.
 *  The sweep's completeness claim stays the traversal's — this mapping never invents a pool. */
export function venuePoolRowsToMarketRows(items: readonly Record<string, unknown>[], emitters: readonly PositionsEmitter[]): { rows: MarketRow[]; unreadableExpiry: number } {
  const byPm = new Map(emitters.map((e) => [e.poolManager.toLowerCase(), e] as const));
  const rows: MarketRow[] = [];
  let unreadableExpiry = 0;
  for (const raw of items) {
    const parsed = VenuePoolRow.safeParse(raw);
    if (!parsed.success) continue;
    const r = parsed.data;
    const e = byPm.get(r.poolManagerAddress.toLowerCase());
    if (!e) continue; // a manager no asked generation owns
    const expiry = venueExpirySeconds(r.expiry);
    if (expiry === undefined) {
      unreadableExpiry += 1;
      continue;
    }
    rows.push({
      poolId: r.poolId as `0x${string}`,
      referenceAsset: r.referenceToken as `0x${string}`,
      collateralAsset: r.collateralToken as `0x${string}`,
      expiry,
      rateOracle: (r.rateOracleAddress ?? "0x0000000000000000000000000000000000000000") as `0x${string}`,
      corkPrincipalToken: r.principalToken as `0x${string}`,
      corkSwapToken: r.swapToken as `0x${string}`,
      poolManager: e.poolManager,
      wire: e.wire,
      generation: e.label,
      blockNumber: String(r.deploymentBlockNumber ?? ""),
      txHash: r.deploymentTxHash ?? "",
      emitter: e.poolManager,
    });
  }
  return { rows, unreadableExpiry };
}

export interface AccountPosition {
  generation: GenerationRef;
  poolId: `0x${string}`;
  poolManager: `0x${string}`;
  expiryTimestamp: string;
  expired: boolean;
  collateralAsset: `0x${string}`;
  referenceAsset: `0x${string}`;
  corkSwapToken: `0x${string}`;
  corkPrincipalToken: `0x${string}`;
  balances: { corkSwapToken: bigint; corkPrincipalToken: bigint };
}

/** The minimal client the sweep needs — viem's PublicClient satisfies it structurally. */
interface BalanceClient {
  readContract(args: { address: `0x${string}`; abi: typeof erc20Abi; functionName: "balanceOf"; args: [`0x${string}`]; blockNumber?: bigint }): Promise<unknown>;
}

/** Sweep cST + cPT balances for every enumerated pool and keep the non-zero positions. PURE over
 *  the client: one `balanceOf` per share token, all in flight together (one batch — the RPC
 *  transport coalesces them; the 453 pools the venue knows on Arbitrum are 906 reads). Zero-position pools
 *  are DROPPED here, not hidden by the renderer, so `scanned.pools` vs `positions.length` is the
 *  honest ratio. `expired` compares the pool's expiry with the call's clock (`ctx.nowSeconds`
 *  pinnable), the same predicate the phoenix preflight uses. */
export async function sweepPositions(
  client: BalanceClient,
  account: `0x${string}`,
  rows: readonly MarketRow[],
  generationOf: (label: string) => GenerationRef | undefined,
  nowSecs: bigint,
  atBlock?: bigint,
): Promise<AccountPosition[]> {
  const blockOpt = atBlock !== undefined ? { blockNumber: atBlock } : {};
  const bal = async (token: `0x${string}`): Promise<bigint> => BigInt((await client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [account], ...blockOpt })) as bigint);
  const swept = await Promise.all(
    rows.map(async (m) => {
      const [cst, cpt] = await Promise.all([bal(m.corkSwapToken as `0x${string}`), bal(m.corkPrincipalToken as `0x${string}`)]);
      return { m, cst, cpt };
    }),
  );
  const out: AccountPosition[] = [];
  for (const { m, cst, cpt } of swept) {
    if (cst === 0n && cpt === 0n) continue;
    const g = m.generation !== undefined ? generationOf(m.generation) : undefined;
    if (!g) continue; // a row from an emitter no generation claims cannot be placed — the decoder never emits one
    const expiry = BigInt(m.expiry);
    out.push({
      generation: g,
      poolId: m.poolId as `0x${string}`,
      poolManager: m.poolManager as `0x${string}`,
      expiryTimestamp: m.expiry,
      // Phoenix's own gate is `block.timestamp >= expiry` for the post-expiry settles: AT the
      // boundary second the pool is expired.
      expired: nowSecs >= expiry,
      collateralAsset: m.collateralAsset as `0x${string}`,
      referenceAsset: m.referenceAsset as `0x${string}`,
      corkSwapToken: m.corkSwapToken as `0x${string}`,
      corkPrincipalToken: m.corkPrincipalToken as `0x${string}`,
      balances: { corkSwapToken: cst, corkPrincipalToken: cpt },
    });
  }
  return out;
}

/** Per-generation subtotals in RESOLUTION order (the primary first), one row per generation the
 *  sweep ASKED — a generation with no positions reports `pools: 0` and zero totals, so the
 *  reader sees "nothing on the new set yet" instead of a missing row. */
export function summarizeByGeneration(asked: readonly ResolvedGeneration[], positions: readonly AccountPosition[]): Array<{ label: string; status: ResolvedGeneration["status"]; pools: number; corkSwapTokenTotal: bigint; corkPrincipalTokenTotal: bigint }> {
  return asked.map((g) => {
    const mine = positions.filter((p) => p.generation.label === g.label);
    return {
      label: g.label,
      status: g.status,
      pools: mine.length,
      corkSwapTokenTotal: mine.reduce((acc, p) => acc + p.balances.corkSwapToken, 0n),
      corkPrincipalTokenTotal: mine.reduce((acc, p) => acc + p.balances.corkPrincipalToken, 0n),
    };
  });
}

/**
 * The multi-generation account-state read. `generation` (the top-level input, riding in ctx like
 * every other read's) NARROWS to one set — a label, or the `previous`/`primary` alias resolved
 * against the phoenix block; `all` (and omitted) means every generation with a pool manager. The
 * ONE place `all` is accepted: this read spans generations by construction.
 */
export async function handleAccountPositions(
  input: QueryInput,
  filters: QueryFilters,
  chainId: ChainId,
  ctx: HandlerContext,
  resolved: ResolvedRpc,
  deps: PositionsDeps,
): Promise<Envelope> {
  const account = filters.account;
  if (!account) return unavailable(chainId, "missing_filter", "account-state requires filters.account (with filters.poolId: one pool's balances and allowances; without: the account's positions across every generation)", ctx);
  const { generations, warning } = await resolveGenerations(chainId);
  const w: Array<{ code: string; message: string }> = warning ? [warning] : [];
  const withPm = generations.filter((g) => g.phoenix !== undefined);
  if (withPm.length === 0) return unavailable(chainId, "unknown_deployment", `no generation on chainId ${chainId} has a phoenix pool manager — nothing to sweep`, ctx);

  // Narrowing: `all`/omitted = every set; an alias resolves against the phoenix block; a label
  // must name a set WITH a pool manager.
  let asked: ResolvedGeneration[] = withPm;
  const label = ctx.generation;
  if (label !== undefined && label !== "all") {
    const a = resolveGenerationAlias(generations, label, ["phoenix"], "read");
    if (!a.ok) throw new ToolInputError("cork_query", [{ path: ["generation"], message: a.refusal.message }]);
    const g = withPm.find((x) => x.label === a.label);
    if (!g) {
      const known = withPm.map((x) => `${x.label} (${x.status}${x.primary ? ", primary" : ""})`).join(", ");
      const named = generations.find((x) => x.label === a.label);
      throw new ToolInputError("cork_query", [{ path: ["generation"], message: named ? `generation '${a.label}' has no phoenix pool manager on chainId ${chainId} — positions live on: ${known}` : `generation '${label}' is not configured on chainId ${chainId} — generations with pools: ${known}; aliases: primary, previous, all` }]);
    }
    asked = [g];
  }

  // One address appears once (a manager two generations share is scanned once, attributed to
  // its FIRST generation in resolution order — the same rule configuredPoolManagerRefs applies).
  const seen = new Set<string>();
  const emitters: PositionsEmitter[] = [];
  for (const g of asked) {
    const pm = g.phoenix!.poolManager as `0x${string}`;
    if (seen.has(pm.toLowerCase())) continue;
    seen.add(pm.toLowerCase());
    emitters.push({ poolManager: pm, wire: g.phoenix!.wire, label: g.label });
  }

  const rpc = () => rpcProvenance(input.format, resolved);
  try {
    const scan = await deps.enumeratePools(emitters);
    w.push(...scan.warnings);
    if (!scan.complete) {
      w.push({ code: "pagination_incomplete", message: scan.source === "hybrid" ? "the venue's pool list was not walked to the end (maxPages) — pools beyond the last page are missing from this sweep; raise maxPages" : "the pool-creation scan hit its per-call range budget on this RPC — pools created later than the last scanned block are missing from this sweep; partial evidence (this endpoint caps eth_getLogs hard: use one that serves address-filtered ranges, set ENVIO_HYPERSYNC_TOKEN with mode full-decentralized, or mode hybrid for the venue's list)" });
    }
    const generationOf = (l: string): GenerationRef | undefined => {
      const g = generations.find((x) => x.label === l);
      return g ? generationRefOf(g) : undefined;
    };
    // One row per pool: a cached backfill re-scanned through its reorg overlap can serve a pool
    // twice, and a double-counted position would double the subtotal.
    const byPool = new Map<string, MarketRow>();
    for (const m of scan.rows) if (!byPool.has(String(m.poolId).toLowerCase())) byPool.set(String(m.poolId).toLowerCase(), m);
    const rows = [...byPool.values()];
    const positions = await sweepPositions(resolved.client, account, rows, generationOf, nowSecondsOf(ctx), ctx.atBlock);
    const byGeneration = summarizeByGeneration(asked, positions);
    const scales = {
      balances: "cST / cPT share balances in 18-decimal share units (every generation's share tokens are 18 decimals) — collateral/reference balances are per-token, not per-position: read them with filters.poolId",
      byGeneration: "corkSwapTokenTotal / corkPrincipalTokenTotal: exact sums of 18-decimal shares across the generation's pools",
      unitsTopic: UNITS_TOPIC_REFERENCE,
    };
    return envelope({
      state: "ok",
      data: {
        resource: input.resource,
        chainId,
        account,
        // NO `generation` here and none in provenance: this result spans generations; each
        // position names its own.
        generations: asked.map((g) => generationRefOf(g)),
        scanned: { managers: emitters.length, pools: rows.length, complete: scan.complete, source: scan.source },
        positions,
        byGeneration,
        decimals: { corkSwapToken: 18, corkPrincipalToken: 18 },
        scales,
        note: positions.length === 0 ? "no cST or cPT balance on any scanned pool — the account holds no Cork position on the swept generation(s)" : `${String(positions.length)} pool(s) with a non-zero cST or cPT balance; exit each old pool with the pool-scoped action (unwind-* pre-expiry, withdraw/redeem post-expiry — the tool follows the pool's generation) and enter a pool on the primary (cork_capabilities topic:"migration")`,
      },
      chainId,
      source: "chain",
      // The pledge the ENUMERATION kept: venue-discovered rows (hybrid) or a HyperSync/log scan
      // (full-decentralized). The balances are chain reads under either.
      mode: scan.source,
      warnings: [...rpcWarn(resolved), ...w],
      ...rpc(),
      ctx,
    });
  } catch (err) {
    if (err instanceof ToolInputError) throw err;
    return chainReadFailed(chainId, err, [...rpcWarn(resolved), ...w], ctx, resolved);
  }
}
