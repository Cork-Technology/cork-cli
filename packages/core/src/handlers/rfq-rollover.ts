// The chain and venue half of rollover RFQs: whether a pool a rollover RFQ names is live, what
// a quoted just-in-time destination derives to, and which quote a rollover order cites. The
// rules themselves are pure (../rfq-rollover.ts); this module only gathers the facts.

import { getRfq } from "../datasources/venue.ts";
import { resolveGenerations } from "../config-remote.ts";
import { resolvePoolGeneration } from "../generations.ts";
import { resolvePoolTokens } from "../chain/reads.ts";
import { deriveJitMarket } from "../market-registry.ts";
import { hashJitMarketParams } from "../rollover.ts";
import { findRolloverQuote, jitMarketParamsOfWire, rfqCounterKindFieldsViolation, premiumTokenAllowed, rolloverOptionToWire, rolloverOptionViolation } from "../rfq-rollover.ts";
import type { RfqWriteRequest } from "../rfq-bodies.ts";
import type { Envelope, PrepareOrdersInput } from "@cork/schemas";
import { getMarketRegistry, getRpc, type HandlerContext, nowSecondsOf, unavailable, venueDepsOf } from "./shared.ts";
import { resolveRecipeOracleConstraint } from "./registry.ts";

type Warning = { code: string; message: string };
type ChainId = PrepareOrdersInput["chainId"];

export type PoolLiveness =
  | { status: "live"; expiry: bigint; generation: string }
  | { status: "expired"; expiry: bigint }
  | { status: "missing"; message: string }
  | { status: "unread"; reason: string };

/** Whether a pool exists on any configured pool manager and has not expired. The venue asks
 *  its own index; this asks the chain, which every indexed pool is on. A read that fails says
 *  so instead of guessing. */
export async function readPoolLiveness(ctx: HandlerContext, chainId: number, poolId: `0x${string}`): Promise<PoolLiveness> {
  try {
    const resolved = await getRpc(ctx, chainId as ChainId);
    if (!resolved) return { status: "unread", reason: "no RPC resolved" };
    const { generations } = await resolveGenerations(chainId);
    const r = await resolvePoolGeneration(resolved.client, generations, poolId, undefined, ctx.atBlock);
    if (!r.found) {
      if (r.causes !== undefined && r.causes.length === r.asked.length) return { status: "unread", reason: `no pool manager could be read (${r.message})` };
      return { status: "missing", message: r.message };
    }
    const tokens = await resolvePoolTokens(resolved.client, { poolManager: r.poolManager, wire: r.generation.phoenix!.wire }, poolId, ctx.atBlock, { corkPrincipalToken: r.corkPrincipalToken, corkSwapToken: r.corkSwapToken });
    if (tokens.expiryTimestamp <= nowSecondsOf(ctx)) return { status: "expired", expiry: tokens.expiryTimestamp };
    return { status: "live", expiry: tokens.expiryTimestamp, generation: r.generation.label };
  } catch (err) {
    return { status: "unread", reason: err instanceof Error ? (err.message.split("\n")[0] ?? String(err)) : String(err) };
  }
}

/** The refusal or warning a pool's liveness turns into, for the pool a write names. */
function livenessVerdict(chainId: number, ctx: HandlerContext, what: string, poolId: string, l: PoolLiveness): { refusal?: Envelope; warning?: Warning } {
  switch (l.status) {
    case "live":
      return {};
    case "missing":
      return { refusal: unavailable(chainId as ChainId, "pool_not_found", `${what} ${poolId} is not a Cork pool on chain ${chainId} — the venue refuses a pool it has not indexed with a 400 (${l.message})`, ctx) };
    case "expired":
      return { refusal: unavailable(chainId as ChainId, "invalid_order_terms", `${what} ${poolId} expired at ${l.expiry} (now ${nowSecondsOf(ctx)}) — there is nothing to roll from or into an expired pool (the venue would 400)`, ctx) };
    case "unread":
      return { warning: { code: "chain_read_failed", message: `${what} ${poolId} could not be checked on the chain (${l.reason}) — sent unchecked; the venue checks the pool against its own index and answers 400 if it is unknown or expired` } };
  }
}

/** What a quoted just-in-time destination derives to: the pool a fill would create, computed the
 *  way the rollover-intent prepare cross-checks it (the primary generation's registry and pool
 *  manager — the 0.2 rollover wire the venue hashes with is the primary's). */
export async function deriveJitDestination(ctx: HandlerContext, chainId: number, jitWire: Record<string, unknown>): Promise<{ poolId: `0x${string}`; oracle: `0x${string}`; oracleDeployed: boolean } | { reason: string }> {
  try {
    const resolved = await getRpc(ctx, chainId as ChainId);
    if (!resolved) return { reason: "no RPC resolved" };
    const { mr, phoenixWire } = await getMarketRegistry(ctx, chainId);
    if (!mr || !phoenixWire) return { reason: "no market registry or pool manager wire for the primary generation" };
    const p = jitMarketParamsOfWire(jitWire);
    const res = await resolveRecipeOracleConstraint({
      client: resolved.client,
      ctx,
      chainId: chainId as ChainId,
      mr,
      recipe: p.recipe,
      collateralAsset: p.collateralAsset,
      referenceAsset: p.referenceAsset,
      ...(p.rateOverride > 0n ? { fixedRate: p.rateOverride } : {}),
      ...(p.oracleSalt !== undefined ? { oracleSalt: p.oracleSalt } : {}),
      wantConstraint: false,
    });
    if (res.gate || !res.oracle.address) return { reason: res.gate ? (res.gate.warnings[0]?.message ?? "the recipe or oracle read refused") : "the pair has no oracle address" };
    const derived = deriveJitMarket({
      collateralAsset: p.collateralAsset,
      referenceAsset: p.referenceAsset,
      expiryTimestamp: p.expiryTimestamp,
      constraint: { rateMin: p.rateMin, rateMax: p.rateMax, rateChangePerDayMax: p.rateChangePerDayMax, rateChangeCapacityMax: p.rateChangeCapacityMax },
      oracle: res.oracle.address,
      wire: phoenixWire,
      swapFeePercentage: p.swapFeePercentage,
      unwindSwapFeePercentage: p.unwindSwapFeePercentage,
    });
    return { poolId: derived.poolId, oracle: res.oracle.address, oracleDeployed: res.oracle.deployed };
  } catch (err) {
    return { reason: err instanceof Error ? (err.message.split("\n")[0] ?? String(err)) : String(err) };
  }
}

/** What the checks found about one rollover quote option. */
export interface RolloverOptionEcho {
  optionId: string;
  destination: "pool" | "jitMarket";
  /** Existing-pool destinations: the pool. Just-in-time destinations: the pool the market derives to, or null when it could not be derived here. */
  poolId: string | null;
  /** Just-in-time destinations only: BaseFiller's commitment (the 0.2 JITMarketParams hash) the requester's order must sign, and the venue stores. */
  jitMarketHash?: `0x${string}`;
  notChecked: string[];
}

export type RolloverWriteCheck = { ok: true; warnings: Warning[]; options?: RolloverOptionEcho[] } | { ok: false; envelope: Envelope };

/**
 * The venue's rollover-kind write rules, run before a write is signed (cork_prepare_orders
 * rfq-write) and again before it is relayed (cork_submit): an open names a live source pool; a
 * quote is on the RFQ's chain, in a token the requester accepts, for at most its shares, into a
 * live pool that is not the source or a just-in-time market (hashed and derived here, so the
 * underwriter sees what the requester's order must sign); a counter bids in an accepted token.
 */
export async function checkRolloverWrite(ctx: HandlerContext, chainId: number, request: RfqWriteRequest, rfq: Record<string, unknown> | undefined): Promise<RolloverWriteCheck> {
  const refuse = (message: string): RolloverWriteCheck => ({ ok: false, envelope: unavailable(chainId as ChainId, "invalid_order_terms", message, ctx) });
  if (request.type === "rfq-open") {
    const poolId = request.source!.poolId as `0x${string}`;
    const verdict = livenessVerdict(chainId, ctx, "source.poolId", poolId, await readPoolLiveness(ctx, chainId, poolId));
    if (verdict.refusal) return { ok: false, envelope: verdict.refusal };
    return { ok: true, warnings: verdict.warning ? [verdict.warning] : [] };
  }
  if (rfq === undefined) return { ok: true, warnings: [] };
  if (request.type === "rfq-counter") {
    const fields = rfqCounterKindFieldsViolation("rollover", request);
    if (fields) return refuse(fields);
    if (!premiumTokenAllowed(rfq.premium_token, request.premiumToken!)) return refuse(`premiumToken ${request.premiumToken} is not in this RFQ's premium_token set (${JSON.stringify(rfq.premium_token)}) — the venue would 400; bid in a token the requester accepts`);
    return { ok: true, warnings: [] };
  }
  if (request.status !== "quoted") return { ok: true, warnings: [] };
  const warnings: Warning[] = [];
  const echoes: RolloverOptionEcho[] = [];
  const now = nowSecondsOf(ctx);
  for (const [i, raw] of (request.options ?? []).entries()) {
    const converted = rolloverOptionToWire(raw);
    if (!converted.ok) return refuse(`options[${i}].${converted.reason}`);
    const option = converted.option;
    const problem = rolloverOptionViolation(i, option, rfq);
    if (problem) return refuse(problem);
    const dest = option.destination as Record<string, unknown>;
    if (typeof dest.pool_id === "string") {
      const verdict = livenessVerdict(chainId, ctx, `options[${i}].destination.pool_id`, dest.pool_id, await readPoolLiveness(ctx, chainId, dest.pool_id as `0x${string}`));
      if (verdict.refusal) return { ok: false, envelope: verdict.refusal };
      if (verdict.warning) warnings.push(verdict.warning);
      echoes.push({ optionId: option.option_id as string, destination: "pool", poolId: dest.pool_id, notChecked: verdict.warning ? ["destination pool liveness"] : [] });
      continue;
    }
    const jit = dest.jit_market as Record<string, unknown>;
    const jitMarketHash = hashJitMarketParams(jitMarketParamsOfWire(jit), "0.2");
    if (BigInt(jit.expiryTimestamp as string) <= now) {
      warnings.push({ code: "invalid_order_terms", message: `options[${i}].destination.jitMarket.expiryTimestamp (${String(jit.expiryTimestamp)}) is not in the future — no fill can create that market (the venue does not check it)` });
    }
    const derived = await deriveJitDestination(ctx, chainId, jit);
    const notChecked = "reason" in derived ? [`the pool this market derives to (${derived.reason})`] : [];
    echoes.push({ optionId: option.option_id as string, destination: "jitMarket", poolId: "poolId" in derived ? derived.poolId : null, jitMarketHash, notChecked });
  }
  return { ok: true, warnings, options: echoes };
}

export type RolloverQuoteRead =
  | { ok: true; rfq: Record<string, unknown>; option: Record<string, unknown> }
  | { ok: false; envelope: Envelope };

/** The RFQ and quote option a rollover order cites, read from the venue. A refusal names why the
 *  citation cannot back a rollover order: an unknown RFQ, one of another kind or chain, an answer
 *  that is not a quote or does not hold the option, or one beyond a truncated answers embed. */
export async function readRolloverQuote(ctx: HandlerContext, chainId: number, quoteRef: { rfqId: string; answerId: string; optionId: string }): Promise<RolloverQuoteRead> {
  const rfq = await getRfq(venueDepsOf(ctx), quoteRef.rfqId);
  if (!rfq) return { ok: false, envelope: unavailable(chainId as ChainId, "rfq_not_found", `quoteRef.rfqId '${quoteRef.rfqId}' is unknown to the venue's /rfqs/v2 (the venue would 400 the order: rfqId not found)`, ctx) };
  const found = findRolloverQuote(chainId, rfq, quoteRef);
  if (!found.found) {
    const why = found.unresolved
      ? `${found.reason}, and the record's answers embed is TRUNCATED, so the answer cannot be read here — cite an answer the record serves, or the requester's current one (cork_query rfqs filters.rfqId with view 'current')`
      : found.reason;
    return { ok: false, envelope: unavailable(chainId as ChainId, "invalid_order_terms", `quoteRef cannot back a rollover order: ${why} (the venue would 400: Invalid quoteRef)`, ctx) };
  }
  return { ok: true, rfq, option: found.option };
}
