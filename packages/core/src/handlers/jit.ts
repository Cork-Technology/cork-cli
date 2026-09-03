// Split from handlers.ts (2026-08-05): jit handlers — one typed dispatch, per-tool modules.
// Declarations are moved byte-identically; see handlers.ts for the runTool dispatch.
import { type ChainId, Envelope } from "@cork/schemas";
import { rateOracleAbi } from "../chain/abis.ts";
import { type LopOrder } from "../orders.ts";
import { buildDeployFixedRateOracleCall, buildDeployOracleCall, decodeJitExtension, deriveJitMarket, diffJitExtraData, encodeJitExtraData, jitAdapterAbi, type JITMarketParams, MAX_FEE_PERCENTAGE_FALLBACK, type PermitParams, predictShares, rateOverrideCoherence, readAdapterRoles, readForeignSharePool, recipeAbi, type ResolvedConstraint } from "../market-registry.ts";
import { cachedContractConstant, refreshContractConstant } from "../chain/constants-cache.ts";
import * as legacyRegistry from "../market-registry-legacy.ts";
import { deprecatedEnabled, deprecatedGateMessage } from "../deprecation.ts";
import { resolveMarketRegistry, resolveMarketRegistryLegacy } from "../config-remote.ts";
import { approvedImplementationChecks, type ImplementationCheck, implementationRefusals, JIT_IMPLEMENTATION_ROLES, LEGACY_JIT_IMPLEMENTATION_ROLES, unapprovedCodeAllowed } from "../implementations.ts";
import { envelope, getDep, getRpc, type HandlerContext, nowSecondsOf, revertReason, ToolInputError, unavailable } from "./shared.ts";
import { oracleRateUnreadableMessage, resolveModeSugar, resolveRecipeOracleConstraint, staticResolveConstraint } from "./registry.ts";


/** Site-specific WORDS for the shared value gate: the boundary rules are identical wherever a
 *  pool gets created (JIT hook or the CorkMarketCreator tx); only the field name and the thing
 *  that reverts differ per surface. */
export interface ValueGateSite {
  fees: string;
  expiryField: string;
  revertActor: string;
}
const JIT_VALUE_SITE: ValueGateSite = { fees: "JIT fee percentages", expiryField: "jitMarket.expiryTimestamp", revertActor: "a fill" };

/** The site's deployed fee ceiling, from the long-TTL constants cache (both the JIT adapter
 *  and the CorkMarketCreator expose MAX_FEE_PERCENTAGE(), verified live 2026-08-28) — the
 *  compiled 5e18 answers only while the cache is cold or offline. Config-only resolution, so
 *  the value gates keep running FIRST and offline; the ladder/create-pool refresh the cache
 *  once a client exists, converging one call after any redeploy that moves the cap. */
export async function resolveFeeCap(chainId: ChainId, capSource: "adapter" | "creator"): Promise<bigint> {
  const { marketRegistry: mr } = await resolveMarketRegistry(chainId);
  const address = capSource === "creator" ? mr?.marketCreator : mr?.adapter;
  if (!address) return MAX_FEE_PERCENTAGE_FALLBACK;
  return cachedContractConstant(chainId, address, "MAX_FEE_PERCENTAGE") ?? MAX_FEE_PERCENTAGE_FALLBACK;
}

const capText = (cap: bigint): string => (cap % 10n ** 18n === 0n ? `${cap / 10n ** 18n}e18 (${cap / 10n ** 18n}%)` : `${cap} (1e18 = 1%)`);

/** Value-domain gate shared by BOTH JIT builders (maker extension + taker interaction) AND the
 *  create-pool prepare: the protocol's fee cap and strictly-future expiry, in one place so a
 *  boundary rule can never drift between the paths. Returns the gate envelope, or undefined
 *  when the values pass. `capWei` comes from resolveFeeCap (the deployed contract's own value
 *  through the cache); the default is the compiled fallback. */
export function jitValueGate(chainId: ChainId, ctx: HandlerContext, swapFee: bigint, unwindFee: bigint, expiryTimestamp: bigint, nowSecs: bigint, opts: { site?: ValueGateSite; capWei?: bigint } = {}): Envelope | undefined {
  const site = opts.site ?? JIT_VALUE_SITE;
  const cap = opts.capWei ?? MAX_FEE_PERCENTAGE_FALLBACK;
  if (swapFee > cap || unwindFee > cap) {
    return unavailable(chainId, "invalid_order_terms", `${site.fees} are 1e18 = 1% and capped at ${capText(cap)} — this value would revert at pool creation`, ctx);
  }
  if (expiryTimestamp <= nowSecs) {
    return unavailable(chainId, "invalid_order_terms", `${site.expiryField} ${expiryTimestamp} is not in the future (now ${nowSecs}) — pool creation requires expiryTimestamp > block.timestamp, so ${site.revertActor} would revert. Note this field is ABSOLUTE unix seconds, not a relative duration`, ctx);
  }
  return undefined;
}

/** The >5-years advisory, shared by the maker and rollover jitMarket sites. The old copies
 *  claimed "the chain enforces NO upper bound" — false since the 2.1.0 registry: pool CREATION
 *  is bounded by registry.maxExpiryDuration (30 days at last read), enforced by the JIT
 *  adapter, the rollover BaseFiller, and the CorkMarketCreator alike. A far expiry is not
 *  refused here (an EXISTING pool skips the bound), but the claim had to go. */
export function farFutureExpiryWarning(expiryTimestamp: bigint, nowSecs: bigint): { code: string; message: string } | undefined {
  const FIVE_YEARS = 5n * 31_557_600n;
  if (expiryTimestamp <= nowSecs + FIVE_YEARS) return undefined;
  return { code: "expiry_far_future", message: `jitMarket.expiryTimestamp ${expiryTimestamp} is more than 5 years out — cPT principal stays locked until expiry, and pool CREATION is bounded by the registry's maxExpiryDuration, so a fill that must create this pool reverts ExpiryOutOfRange until that window reaches the expiry; double-check this is intended` };
}

/** Best-effort maxExpiryDuration bound check (the creator/adapter/BaseFiller creation rule:
 *  expiry <= now + registry.maxExpiryDuration(), INCLUSIVE). The bound is a registry constant,
 *  so it rides the long-TTL constants cache: a fresh cached value costs no read, a stale one
 *  refreshes through the client. Emits would_revert with the date the market becomes
 *  creatable; silent when no value is obtainable or the bound passes. The bound applies only
 *  to a call that CREATES the pool — callers gate on existence where they know it. */
export async function maxExpiryBoundWarning(
  client: Parameters<typeof readAdapterRoles>[0],
  chainId: ChainId,
  registry: `0x${string}`,
  expiryTimestamp: bigint,
  nowSecs: bigint,
): Promise<{ code: string; message: string } | undefined> {
  const maxDur = cachedContractConstant(chainId, registry, "maxExpiryDuration") ?? (await refreshContractConstant(client, chainId, registry, "maxExpiryDuration"));
  if (maxDur === undefined || expiryTimestamp <= nowSecs + maxDur) return undefined;
  return { code: "would_revert", message: `expiryTimestamp ${expiryTimestamp} exceeds the registry's creation bound: expiry must be <= now + maxExpiryDuration (${nowSecs} + ${maxDur}) when the pool is CREATED, or the creation reverts ExpiryOutOfRange. The market becomes creatable from ${expiryTimestamp - maxDur}; an already-existing pool is unaffected` };
}

/** Decorates a jit_side_mismatch with the WHY, when knowable: an order side that already hosts
 *  a live PoolShare of a DIFFERENT pool is a consumed nonce-based prediction (plain-CREATE share
 *  deploys are first-come-first-served — see readForeignSharePool), and the order can never fill.
 *  ONE shared emission site on purpose: duplicated identical conditionals defeat first-occurrence
 *  mutation probes (the jitValueGate/readAdapterRoles lesson). Best-effort — silent on any read
 *  failure; the jit_side_mismatch warning it decorates already stands. */
export async function diagnoseStaleSidePrediction(
  client: Parameters<typeof readForeignSharePool>[0],
  sides: ReadonlyArray<readonly [string, `0x${string}`]>,
  derivedPoolId: `0x${string}`,
  warnings: Array<{ code: string; message: string }>,
  remedy: string,
): Promise<void> {
  for (const [label, side] of sides) {
    const foreign = await readForeignSharePool(client, side);
    if (foreign && foreign.toLowerCase() !== derivedPoolId.toLowerCase()) {
      warnings.push({ code: "stale_share_prediction", message: `${label} ${side} already belongs to a DIFFERENT live pool (${foreign}) — a nonce-based cST prediction consumed by an interleaving pool creation (cST/cPT deploy via plain CREATE, first-come-first-served). ${remedy}` });
    }
  }
}

/** The chain-verified half of a ladder run — present only when an RPC resolved AND the
 *  pre-flights ran to completion; the callers' prediction tails key off it. */
export interface JitLadderVerified {
  client: Parameters<typeof predictShares>[0];
  boundController: `0x${string}`;
  source: Awaited<ReturnType<typeof resolveRecipeOracleConstraint>>["source"];
  /** address is non-null by construction: the ladder gates on an unresolvable oracle. */
  oracle: Omit<Awaited<ReturnType<typeof resolveRecipeOracleConstraint>>["oracle"], "address"> & { address: `0x${string}` };
  derived: ReturnType<typeof deriveJitMarket>;
}

export type JitLadderResult =
  | { gate: Envelope }
  | {
      gate?: undefined;
      adapter: `0x${string}`;
      registry: `0x${string}`;
      recipe: `0x${string}`;
      rateOverride: bigint;
      additionalData: `0x${string}`;
      /** Always defined on success: explicit, statically resolved, or the run was gated. */
      constraint: ResolvedConstraint;
      warnings: Array<{ code: string; message: string }>;
      verified?: JitLadderVerified;
    };

/** Side-specific WORDS for the shared ladder — the logic is single-sourced; only these
 *  fragments differ between the maker (signs an extension) and the taker (builds a fill
 *  interaction). Everything else about the two hook sides lives in the callers' tails. */
const LADDER_SIDE = {
  maker: { artifact: "extension", act: "signing", live: "JIT market orders", rolesTail: "; the order is signable but not yet fillable" },
  taker: { artifact: "interaction", act: "broadcasting", live: "JIT fills", rolesTail: "" },
} as const;

/** The wire fields of a `jitMarket` block, shared by both hook sides — derived from the ladder's
 *  own signature so the shape has exactly one declaration site. */
export type JitMarketWireParams = Parameters<typeof runJitPreflightLadder>[0]["jm"];

/** Parse the ERC-2612 permit wire rows into bigint params — ONE spelling for the maker and
 *  taker encode sites (the legacy path keeps its own copy: generation isolation by rule). */
export function parsePermitWires(permits: JitMarketWireParams["permits"]): PermitParams[] {
  return (permits ?? []).map((p) => ({ token: p.token, value: BigInt(p.value), deadline: BigInt(p.deadline), v: p.v, r: p.r, s: p.s }));
}

/**
 * The 2.1.0 JIT pre-flight ladder, SHARED by the maker prepare and the taker fill: registry +
 * adapter resolution, recipe (or deprecated mode sugar), the adapter binding triple, controller
 * roles, recipe↔oracle↔constraint resolution, the rateOverride↔source coherence gates, the
 * oracle gate, the recipe.verify pre-flight, and the market derivation. The two paths used to
 * carry ~100-line copies of this orchestration — protocol rules double-anchored by probes and
 * free to drift (and they had: the taker copy silently lacked the verify-read-failure and
 * oracle-not-deployed disclosures the maker copy carried). The share-prediction tails stay
 * with their callers (buildTakerJitInteraction below, the maker block in prepare-orders.ts) —
 * they genuinely differ per side.
 */
export async function runJitPreflightLadder(args: {
  ctx: HandlerContext;
  chainId: ChainId;
  lop: `0x${string}`;
  jm: {
    collateralAsset: `0x${string}`;
    referenceAsset: `0x${string}`;
    expiryTimestamp: string;
    recipe?: `0x${string}` | undefined;
    mode?: string | undefined;
    rateOverride: string;
    additionalData?: `0x${string}` | undefined;
    constraint?: { rateMin: string; rateMax: string; rateChangePerDayMax: string; rateChangeCapacityMax: string } | undefined;
    swapFeePercentage: string;
    unwindSwapFeePercentage: string;
    enableJitMint: boolean;
    permits?: Array<{ token: `0x${string}`; value: string; deadline: string; v: number; r: `0x${string}`; s: `0x${string}` }> | undefined;
  };
  side: keyof typeof LADDER_SIDE;
}): Promise<JitLadderResult> {
  const { ctx, chainId, lop, jm, side } = args;
  const words = LADDER_SIDE[side];
  const warnings: Array<{ code: string; message: string }> = [];
  const expiryTimestamp = BigInt(jm.expiryTimestamp);
  const { marketRegistry: mr, warning: mrWarn } = await resolveMarketRegistry(chainId);
  if (!mr?.adapter) {
    return { gate: unavailable(chainId, "unknown_deployment", `no JIT CorkLimitOrderAdapter configured for chainId ${chainId} — ${words.live} are live on Arbitrum One and Base (42161, 8453)`, ctx) };
  }
  if (mrWarn) warnings.push(mrWarn);
  // Recipe: explicit address, or DEPRECATED mode sugar over the config hints (config-only,
  // so the sugar also works offline).
  let recipe = jm.recipe;
  if (!recipe) {
    if (jm.mode === undefined) {
      throw new ToolInputError("cork_prepare_orders", [{ path: ["action", "jitMarket", "recipe"], message: "jitMarket needs `recipe` (the approved IMarketRecipe CONTRACT ADDRESS — discover with cork_query resource:\"registry-recipes\"); `mode` survives only as deprecated sugar" }]);
    }
    const sugar = resolveModeSugar({ mr, mode: jm.mode, modeField: "jitMarket.mode", recipeField: "jitMarket.recipe", chainId, ctx, warnings });
    if (sugar.gate) return { gate: sugar.gate };
    recipe = sugar.recipe;
  }
  const rateOverride = BigInt(jm.rateOverride ?? "0");
  const additionalData = (jm.additionalData ?? "0x") as `0x${string}`;
  let constraint: ResolvedConstraint | undefined = jm.constraint
    ? { rateMin: BigInt(jm.constraint.rateMin), rateMax: BigInt(jm.constraint.rateMax), rateChangePerDayMax: BigInt(jm.constraint.rateChangePerDayMax), rateChangeCapacityMax: BigInt(jm.constraint.rateChangeCapacityMax) }
    : undefined;
  const base = { adapter: mr.adapter, registry: mr.registry, recipe, rateOverride, additionalData, warnings } as const;

  // Chain pre-flights + constraint resolution; every gap is disclosed, never guessed.
  const resolved = await getRpc(ctx, chainId);
  if (!resolved) {
    if (!constraint) {
      return { gate: unavailable(chainId, "requires_rpc", "jitMarket has no explicit constraint and no RPC resolved to derive one — set CORK_RPC_URL, or pass jitMarket.constraint (from cork_compute recipe-rate-constraint)", ctx) };
    }
    warnings.push({ code: "funding_needs_rpc", message: `no RPC resolved — JIT pre-flights (adapter bindings, roles, recipe membership, source/rateOverride coherence, oracle, verify, cST side-match) were SKIPPED; the ${words.artifact} is built from the caller-supplied constraint but unverified` });
    return { ...base, constraint };
  }
  const client = resolved.client;
  // Interface-first guard on the two contracts the hook executes (adapter + registry): the
  // binding reads below prove WHICH contracts, this proves their CODE is the admitted one.
  {
    const impl = await approvedImplementationChecks(client, chainId, { roles: JIT_IMPLEMENTATION_ROLES, ...(ctx.atBlock !== undefined ? { atBlock: ctx.atBlock } : {}) });
    warnings.push(...impl.warnings);
    const gate = bytesDecoderGate({ checks: impl.checks, roles: ["jitAdapter"], chainId, ctx, artifact: words.artifact, adapterName: "JIT adapter" });
    if (gate.gate) return { gate: gate.gate };
    warnings.push(...gate.warnings);
  }
  try {
    const [boundLop, boundRegistry, boundController] = await Promise.all([
      client.readContract({ address: mr.adapter, abi: jitAdapterAbi, functionName: "LIMIT_ORDER_PROTOCOL" }),
      client.readContract({ address: mr.adapter, abi: jitAdapterAbi, functionName: "MARKET_REGISTRY" }),
      client.readContract({ address: mr.adapter, abi: jitAdapterAbi, functionName: "CONTROLLER" }),
    ]);
    if (boundLop.toLowerCase() !== lop.toLowerCase() || boundRegistry.toLowerCase() !== mr.registry.toLowerCase()) {
      return { gate: envelope({ state: "conflict", data: { adapter: mr.adapter, expected: { lop, registry: mr.registry }, onChain: { lop: boundLop, registry: boundRegistry } }, chainId, source: "chain", warnings: [{ code: "adapter_binding_mismatch", message: `the configured JIT adapter's on-chain bindings do not match this tool's LOP/registry config — a stale/previous-generation address (the old registry answers 2.1.0 calls with misdecoded garbage); refresh cork-defaults.json before ${words.act} anything` }], ctx }) };
    }
    // Opportunistic cache refresh for the fee cap the value gate consumed earlier this call
    // (and will consume next call): a contract constant, one read per TTL.
    await refreshContractConstant(client, chainId, mr.adapter, "MAX_FEE_PERCENTAGE");
    const adapterRoles = await readAdapterRoles(client, boundController, mr.adapter, { chainId });
    if (!adapterRoles.granted) {
      warnings.push({ code: "roles_not_granted", message: `the adapter is missing controller roles (POOL_CREATOR: ${adapterRoles.hasCreator}, ${adapterRoles.secondRole}: ${adapterRoles.hasSecond}) — a fill through it will revert until both are granted (a governance action, not a code change)${words.rolesTail}` });
    }
    const res = await resolveRecipeOracleConstraint({ client, ctx, chainId, mr, recipe, collateralAsset: jm.collateralAsset, referenceAsset: jm.referenceAsset, fixedRate: rateOverride > 0n ? rateOverride : undefined, additionalData, wantConstraint: false });
    warnings.push(...res.warnings);
    if (res.gate) return { gate: res.gate };
    const { source, oracle } = res;
    // rateOverride ↔ source coherence — checked BEFORE constraint resolution so the caller
    // gets the real rule, not a downstream recipe revert: the fill REJECTS a non-zero
    // override on a price/nav recipe (UnexpectedRateOverride), and a fixed fill deploys
    // FixedRateOracle(rateOverride), whose constructor reverts on 0. The comparator is the
    // shared rateOverrideCoherence (one rule, per-site words — the create-pool prepare gates
    // on the same predicate).
    const coherence = rateOverrideCoherence(source, rateOverride);
    if (coherence === "needs-rate") {
      return { gate: unavailable(chainId, "invalid_order_terms", `recipe ${recipe} is a FIXED-rate recipe: the order must carry rateOverride (the rate its FixedRateOracle is deployed at) — zero reverts the fill in the oracle constructor`, ctx) };
    }
    if (coherence === "must-be-zero") {
      return { gate: unavailable(chainId, "invalid_order_terms", `recipe ${recipe} reads a ${source} oracle: rateOverride must be 0 — a non-zero value is REJECTED by the fill (UnexpectedRateOverride), not ignored`, ctx) };
    }
    if (!constraint) {
      const c = await staticResolveConstraint(client, ctx, chainId, { recipe, collateralAsset: jm.collateralAsset, referenceAsset: jm.referenceAsset, oracle, additionalData });
      if ("gate" in c) return { gate: c.gate };
      constraint = c.constraint;
    }
    if (oracle.address === null) {
      return { gate: unavailable(chainId, "oracle_not_deployable", `the recipe's oracle cannot be resolved (${oracle.reason ?? "pair not deployable as-registered"}) — a fill would revert; check cork_query registry-assets / registry-oracle`, ctx) };
    }
    // Verify pre-flight — the exact staticcall the fill runs (step 4). Only meaningful
    // against a DEPLOYED oracle: the liquidity recipe checks the LIVE rate sits inside the
    // window, so a predicted oracle can't answer yet (the fill deploys it first).
    if (oracle.deployed) {
      const ok = await client.readContract({ address: recipe, abi: recipeAbi, functionName: "verify", args: [jm.collateralAsset, jm.referenceAsset, oracle.address, { ...constraint }, additionalData] }).catch(() => null);
      if (ok === false) {
        warnings.push({ code: "would_revert", message: "recipe.verify REJECTS this constraint against the live oracle right now — the fill would revert RecipeRejectedConstraint (the constraint is stale, or was never one this recipe would produce). Re-resolve it (cork_compute recipe-rate-constraint) and rebuild" });
      } else if (ok === null) {
        if (oracle.rateError) warnings.push({ code: "oracle_rate_unreadable", message: oracleRateUnreadableMessage(oracle.address, oracle.rateError, "recipe.verify read it and failed the same way, and the fill will too.") });
        else warnings.push({ code: "chain_read_failed", message: "the recipe.verify pre-flight read failed — the fill's constraint check could not be previewed" });
      }
    } else {
      warnings.push({ code: "oracle_not_deployed", message: `the recipe's oracle is not deployed yet (predicted ${oracle.address}) — the fill deploys it automatically, then recipe.verify re-checks the carried constraint against the LIVE rate. The pool id below assumes the predicted oracle address; re-registering the pair's sources before the fill would shift it and revert OrderNotForPool` });
    }
    const derived = deriveJitMarket({ collateralAsset: jm.collateralAsset, referenceAsset: jm.referenceAsset, expiryTimestamp, constraint, oracle: oracle.address });
    // Creation-bound pre-flight (best-effort): the adapter enforces the registry's
    // maxExpiryDuration when the fill must CREATE the pool — a bound the >5y advisory alone
    // cannot see (2.1.0 reads it at 30 days). An existing pool skips the bound on-chain; the
    // warning says so rather than gating.
    const expiryBound = await maxExpiryBoundWarning(client, chainId, mr.registry, expiryTimestamp, nowSecondsOf(ctx));
    if (expiryBound) warnings.push(expiryBound);
    return { ...base, constraint, verified: { client, boundController, source, oracle: { ...oracle, address: oracle.address }, derived } };
  } catch (err) {
    if (!constraint) {
      return { gate: unavailable(chainId, "chain_read_failed", `the JIT pre-flight reads failed (${revertReason(err)}) and no explicit constraint was supplied — the constraint comes from recipe.resolve and is PART OF THE SIGNED ORDER, so the ${words.artifact} cannot be built. Retry, or pass jitMarket.constraint from cork_compute recipe-rate-constraint`, ctx) };
    }
    warnings.push({ code: "chain_read_failed", message: `JIT pre-flight reads failed (${revertReason(err)}) — the ${words.artifact} is built from the caller-supplied constraint but unverified` });
    return { ...base, constraint };
  }
}

/** Build the TAKER interaction (`adapter ++ abi.encode(JITMarketParams, PermitParams[])`) for
 *  lifting a resting order — the walkthrough's canonical settle path: the underwriter-taker
 *  delivers a not-yet-minted cST via takerInteraction, which always mints (enableJitMint gates
 *  only the maker-side twin). The pre-flight ladder is the SHARED runJitPreflightLadder above;
 *  this builder adds the taker tail: one taker-specific guard (a resting order carrying its own
 *  JIT extension pins the market the maker signed for — the taker's params must re-derive the
 *  SAME pool id, or the two hooks would fight: conflict, no bytes) plus the cST prediction. */
export async function buildTakerJitInteraction(args: {
  ctx: HandlerContext;
  chainId: ChainId;
  lop: `0x${string}`;
  jm: JitMarketWireParams;
  order: LopOrder;
  orderExtension: `0x${string}` | undefined;
}): Promise<{ gate: Envelope } | { gate?: undefined; interaction: `0x${string}`; jit: TakerJitReport; warnings: Array<{ code: string; message: string }> }> {
  const { ctx, chainId, lop, jm } = args;
  const nowSecs = nowSecondsOf(ctx);
  const swapFee = BigInt(jm.swapFeePercentage);
  const unwindFee = BigInt(jm.unwindSwapFeePercentage);
  const expiryTimestamp = BigInt(jm.expiryTimestamp);
  const valueGate = jitValueGate(chainId, ctx, swapFee, unwindFee, expiryTimestamp, nowSecs);
  if (valueGate) return { gate: valueGate };
  const ladder = await runJitPreflightLadder({ ctx, chainId, lop, jm, side: "taker" });
  if (ladder.gate) return { gate: ladder.gate };
  const { recipe, rateOverride, additionalData, constraint, warnings } = ladder;
  let jit: TakerJitReport = { adapter: ladder.adapter, hook: "takerInteraction (taker-side — always mints)", recipe };

  if (ladder.verified) {
    const { client, boundController, source, oracle, derived } = ladder.verified;
    jit = { ...jit, source, oracle: { address: oracle.address, deployed: oracle.deployed }, derivedPoolId: derived.poolId, constraint };
    try {
      // Consistency with the MAKER's signed intent: a resting order carrying its own JIT
      // extension pins the market the maker signed for — the taker's params must re-derive it.
      if (args.orderExtension && args.orderExtension !== "0x") {
        try {
          const makerJit = decodeJitExtension(args.orderExtension);
          const makerDerived = deriveJitMarket({ collateralAsset: makerJit.params.collateralAsset, referenceAsset: makerJit.params.referenceAsset, expiryTimestamp: makerJit.params.expiryTimestamp, constraint: makerJit.params.constraint, oracle: oracle.address });
          if (makerDerived.poolId !== derived.poolId) {
            return { gate: envelope({ state: "conflict", data: { takerDerivedPoolId: derived.poolId, makerDerivedPoolId: makerDerived.poolId }, chainId, source: "chain", warnings: [{ code: "marketid_mismatch", message: "the taker's jitMarket params derive a DIFFERENT pool id than the resting order's own JIT extension — the two hooks would target different markets and the fill would revert OrderNotForPool. Copy the params from `ch decode order` (jit label) of the resting order" }], ctx }) };
          }
        } catch {
          /* the order's extension is not a JIT payload (e.g. Fusion) — nothing to cross-check */
        }
      }
      const { dep: jitDep } = await getDep(ctx, chainId);
      const preCalls: Array<{ to: `0x${string}`; data: `0x${string}` }> = [];
      if (!oracle.deployed) {
        preCalls.push({ to: ladder.registry, data: source === "fixed" ? buildDeployFixedRateOracleCall(rateOverride) : buildDeployOracleCall(jm.collateralAsset, jm.referenceAsset, oracle.mode ?? "price") });
      }
      // A missing/partial deployment config is NOT a chain read failure [C11] — guard, don't `!`
      // (the legacy path below and registry.ts already degrade this way).
      if (jitDep?.poolManager === undefined) {
        warnings.push({ code: "share_prediction_unavailable", message: `no poolManager deployment configured for chainId ${chainId} — cST prediction skipped; VERIFY yourself that one side of the RESTING order is the derived pool's cST, or the fill reverts OrderNotForPool (refresh cork-defaults.json)` });
      } else {
        const pred = await predictShares(client, { adapter: ladder.adapter, controller: boundController, poolManager: jitDep.poolManager, market: derived.market, poolId: derived.poolId, unwindSwapFeePercentage: unwindFee, swapFeePercentage: swapFee, preCalls, chainId });
        if (pred.status === "unavailable") {
          warnings.push({ code: "share_prediction_unavailable", message: "could not predict the pool's cST (eth_simulateV1/state overrides unsupported) — VERIFY yourself that one side of the RESTING order is the derived pool's cST, or the fill reverts OrderNotForPool" });
        }
        if (pred.cst) {
          jit = { ...jit, predictedCorkSwapToken: pred.cst, permitNote: "sign the ERC-2612 permit over this cST with the TAKER as owner (spender = the LOP, value >= the cST amount) and pass it in jitMarket.permits — the LOP pulls the just-minted cST from the taker. On that re-prepare, pass jitMarket.constraint = this result's jit.constraint: the resting order names one specific pool, and a re-derivation from a moved oracle rate would target a different one (OrderNotForPool)" };
          const cstLc = pred.cst.toLowerCase();
          if (args.order.makerAsset.toLowerCase() !== cstLc && args.order.takerAsset.toLowerCase() !== cstLc) {
            warnings.push({ code: "jit_side_mismatch", message: `NEITHER side of the resting order is the derived pool's cST ${pred.cst} — the fill WILL revert OrderNotForPool` });
            await diagnoseStaleSidePrediction(client, [["the resting order's makerAsset", args.order.makerAsset], ["the resting order's takerAsset", args.order.takerAsset]], derived.poolId, warnings, "This resting order can never fill; it must be re-signed against a fresh share prediction.");
          }
        }
      }
    } catch (err) {
      // The ladder already succeeded — a tail failure degrades to unverified, never a gate.
      warnings.push({ code: "chain_read_failed", message: `JIT share-prediction reads failed (${revertReason(err)}) — the interaction is built but the cST side-match is unverified` });
    }
  }
  const permits = parsePermitWires(jm.permits);
  const jitParams: JITMarketParams = { collateralAsset: jm.collateralAsset, referenceAsset: jm.referenceAsset, expiryTimestamp, recipe, rateOverride, constraint, additionalData, swapFeePercentage: swapFee, unwindSwapFeePercentage: unwindFee, enableJitMint: jm.enableJitMint };
  const extraData = encodeJitExtraData(jitParams, permits);
  if (ladder.verified) {
    const layout = await verifyExtraDataLayout({ client: ladder.verified.client, adapter: ladder.adapter, extraData, params: jitParams, permits, chainId, ctx, artifact: "interaction" });
    if ("gate" in layout) return { gate: layout.gate };
    jit.extraDataLayout = layout.status;
  }
  const interaction = `0x${ladder.adapter.slice(2)}${extraData.slice(2)}` as `0x${string}`;
  return { interaction, jit, warnings };
}


/** Taker-side JIT report echoed in `data.jit`. The base triple always rides; the verified half
 *  is filled only when an RPC resolved and the pre-flights ran (degrades with a
 *  funding_needs_rpc warning otherwise). */
export type TakerJitReport = {
  adapter: `0x${string}`;
  hook: string;
  recipe: `0x${string}`;
  /** R12a round-trip: what the adapter's own decodeExtraData read back from the bytes we built. */
  extraDataLayout?: string;
  source?: Awaited<ReturnType<typeof resolveRecipeOracleConstraint>>["source"];
  oracle?: { address: `0x${string}` | null; deployed: boolean };
  derivedPoolId?: `0x${string}`;
  constraint?: ResolvedConstraint;
  predictedCorkSwapToken?: `0x${string}`;
  permitNote?: string;
};

/** Legacy (pre-2.1.0) JIT report echoed in `data.jit` — same base/verified split. */
export type LegacyJitReport = {
  generation: "legacy (pre-2.1.0)";
  adapter: `0x${string}`;
  hook: string;
  mode: string;
  enableJitMint: boolean;
  oracle?: `0x${string}`;
  rateAtPrepare?: bigint;
  derivedPoolId?: `0x${string}`;
  resolvedConstraints?: ReturnType<typeof legacyRegistry.deriveJitMarket>["resolved"];
  predictedCorkSwapToken?: `0x${string}`;
};

/** The DEPRECATED pre-2.1.0 JIT extension build (mode-string extraData against the OLD adapter,
 *  bands resolved at fill time) — preserved behind the deprecation gate because the OLD adapter
 *  still holds both controller roles on-chain (verified 2026-08-03): until governance grants
 *  them to the 2.1.0 adapter, this is the only FILLABLE JIT path. */
export async function prepareJitLegacy(args: {
  chainId: ChainId;
  ctx: HandlerContext;
  lop: `0x${string}`;
  jm: { collateralAsset: `0x${string}`; referenceAsset: `0x${string}`; expiryTimestamp: string; mode?: string | undefined; swapFeePercentage: string; unwindSwapFeePercentage: string; enableJitMint: boolean; permits?: Array<{ token: `0x${string}`; value: string; deadline: string; v: number; r: `0x${string}`; s: `0x${string}` }> | undefined };
  makerAsset: `0x${string}`;
  takerAsset: `0x${string}`;
}): Promise<{ gate: Envelope } | { gate?: undefined; extension: `0x${string}`; jitData: LegacyJitReport; warnings: Array<{ code: string; message: string }> }> {
  const { chainId, ctx, lop, jm } = args;
  if (!deprecatedEnabled()) {
    return { gate: unavailable(chainId, "deprecated_gated", deprecatedGateMessage("jitMarket.legacy (the pre-2.1.0 mode-string JIT flow against the old adapter)", "The 2.1.0 flow carries a recipe ADDRESS and the resolved constraint — drop `legacy`, pass jitMarket.recipe (+ constraint or an RPC to auto-resolve it)."), ctx) };
  }
  if (jm.mode === undefined) return { gate: unavailable(chainId, "missing_filter", "legacy JIT orders need jitMarket.mode (the old registry's exact case-sensitive mode string)", ctx) };
  const mode = jm.mode;
  const { marketRegistry: mr, warning: mrWarn } = await resolveMarketRegistryLegacy(chainId);
  if (!mr?.adapter) {
    return { gate: unavailable(chainId, "unknown_deployment", `no LEGACY JIT CorkLimitOrderAdapter configured for chainId ${chainId}`, ctx) };
  }
  const warnings: Array<{ code: string; message: string }> = [
    ...(mrWarn ? [mrWarn] : []),
    { code: "deprecated", message: "this order targets the DEPRECATED pre-2.1.0 adapter/registry generation (CORK_ENABLE_DEPRECATED is set). It is currently the only path whose adapter holds the controller roles, but it derives the constraint at FILL time from the live rate — the pool id drifts with the rate, and the generation will be retired once the 2.1.0 adapter is granted its roles" },
  ];
  const jitParams: legacyRegistry.JITMarketParams = {
    collateralAsset: jm.collateralAsset,
    referenceAsset: jm.referenceAsset,
    expiryTimestamp: BigInt(jm.expiryTimestamp),
    mode,
    swapFeePercentage: BigInt(jm.swapFeePercentage),
    unwindSwapFeePercentage: BigInt(jm.unwindSwapFeePercentage),
    enableJitMint: jm.enableJitMint,
  };
  const permits: legacyRegistry.PermitParams[] = (jm.permits ?? []).map((p) => ({ token: p.token, value: BigInt(p.value), deadline: BigInt(p.deadline), v: p.v, r: p.r, s: p.s }));
  const extension = legacyRegistry.buildJitExtension(mr.adapter, legacyRegistry.encodeJitExtraData(jitParams, permits));
  let jitData: LegacyJitReport = { generation: "legacy (pre-2.1.0)", adapter: mr.adapter, hook: "preInteraction (maker-side)", mode, enableJitMint: jm.enableJitMint };
  warnings.push({ code: "rate_drift_notice", message: "LEGACY generation: market identity follows the LIVE oracle rate — the derived pool id is only stepwise-stable, and a drifted rate reverts the fill with OrderNotForPool (by design, as a staleness guard)" });
  const resolved = await getRpc(ctx, chainId);
  if (!resolved) {
    warnings.push({ code: "funding_needs_rpc", message: "no RPC resolved — legacy JIT pre-flights (adapter bindings, roles, recipe, oracle, derived pool, cST side-match) were SKIPPED; the extension is built but unverified" });
    return { extension, jitData, warnings };
  }
  const client = resolved.client;
  // The deprecated lane is held to the same standard as the current one: its adapter and
  // registry have their own allowlist roles, so a swapped implementation warns here too.
  {
    const impl = await approvedImplementationChecks(client, chainId, { roles: LEGACY_JIT_IMPLEMENTATION_ROLES, ...(ctx.atBlock !== undefined ? { atBlock: ctx.atBlock } : {}) });
    warnings.push(...impl.warnings);
    const gate = bytesDecoderGate({ checks: impl.checks, roles: ["legacyJitAdapter"], chainId, ctx, artifact: "extension", adapterName: "legacy JIT adapter" });
    if (gate.gate) return { gate: gate.gate };
    warnings.push(...gate.warnings);
  }
  try {
    const [boundLop, boundRegistry, boundController] = await Promise.all([
      client.readContract({ address: mr.adapter, abi: legacyRegistry.jitAdapterAbi, functionName: "LIMIT_ORDER_PROTOCOL" }),
      client.readContract({ address: mr.adapter, abi: legacyRegistry.jitAdapterAbi, functionName: "MARKET_REGISTRY" }),
      client.readContract({ address: mr.adapter, abi: legacyRegistry.jitAdapterAbi, functionName: "CONTROLLER" }),
    ]);
    if (boundLop.toLowerCase() !== lop.toLowerCase() || boundRegistry.toLowerCase() !== mr.registry.toLowerCase()) {
      return { gate: envelope({ state: "conflict", data: { adapter: mr.adapter, expected: { lop, registry: mr.registry }, onChain: { lop: boundLop, registry: boundRegistry } }, chainId, source: "chain", warnings: [{ code: "adapter_binding_mismatch", message: "the LEGACY JIT adapter's on-chain bindings do not match this tool's legacy config — refresh cork-defaults.json before signing anything" }], ctx }) };
    }
    const adapterRoles = await readAdapterRoles(client, boundController, mr.adapter, { creator: legacyRegistry.POOL_CREATOR_ROLE, second: legacyRegistry.CONFIGURATOR_ROLE, secondLabel: "CONFIGURATOR" });
    if (!adapterRoles.granted) {
      warnings.push({ code: "roles_not_granted", message: `the legacy adapter is missing controller roles (POOL_CREATOR: ${adapterRoles.hasCreator}, ${adapterRoles.secondRole}: ${adapterRoles.hasSecond}) — a fill through it will revert; the generation has likely been retired. Use the 2.1.0 flow` });
    }
    const reg = { address: mr.registry, abi: legacyRegistry.marketRegistryAbi } as const;
    const [found, entry] = await client.readContract({ ...reg, functionName: "lookupRecipe", args: [mode] });
    if (!found) {
      return { gate: unavailable(chainId, "recipe_not_found", `recipe mode '${mode}' is not in the legacy registry — the fill would revert EntryNotFound`, ctx) };
    }
    const sim = await client.simulateContract({ ...reg, functionName: "deploy", args: [jm.collateralAsset, jm.referenceAsset] });
    const oracle = sim.result;
    const rate = await client.readContract({ address: oracle, abi: rateOracleAbi, functionName: "rate" });
    if (rate === 0n) {
      return { gate: unavailable(chainId, "chain_read_failed", "the pair's rate oracle reports a ZERO rate — the fill would revert RateUnavailable", ctx) };
    }
    const bands: legacyRegistry.ConstraintBands = { mode: entry.mode, rateMin: entry.rateMin, rateMax: entry.rateMax, rateChangePerDayMax: entry.rateChangePerDayMax, rateChangeCapacityMax: entry.rateChangeCapacityMax };
    const derived = legacyRegistry.deriveJitMarket({ params: jitParams, oracle, rate, bands });
    jitData = { ...jitData, oracle, rateAtPrepare: rate, derivedPoolId: derived.poolId, resolvedConstraints: derived.resolved };
    const { dep: jitDep } = await getDep(ctx, chainId);
    if (jitDep?.poolManager && boundController) {
      const pred = await legacyRegistry.predictShares(client, { adapter: mr.adapter, controller: boundController, poolManager: jitDep.poolManager, market: derived.market, poolId: derived.poolId, unwindSwapFeePercentage: jitParams.unwindSwapFeePercentage, swapFeePercentage: jitParams.swapFeePercentage });
      if (pred.cst) {
        jitData = { ...jitData, predictedCorkSwapToken: pred.cst };
        const cstLc = pred.cst.toLowerCase();
        if (args.makerAsset.toLowerCase() !== cstLc && args.takerAsset.toLowerCase() !== cstLc) {
          warnings.push({ code: "jit_side_mismatch", message: `NEITHER order side is the derived pool's cST ${pred.cst} — the fill WILL revert OrderNotForPool` });
        }
      }
    }
  } catch (err) {
    warnings.push({ code: "chain_read_failed", message: `legacy JIT pre-flight reads failed (${revertReason(err)}) — the extension is built but unverified` });
  }
  return { extension, jitData, warnings };
}

// ── The bytes-decoder gate (policy R12a, finding 2026-09-03) ────────────────────────────────
// An ABI names a `bytes` parameter but cannot describe its layout, so a hook that DECODES bytes
// this tool ENCODES is the one place where code drift can silently re-read a market or a fee —
// a revert is the good outcome there, a wrong market is the bad one. The interface-first guard
// is therefore a REFUSAL on the adapter roles of the JIT paths (conflict, no bytes), while every
// ABI-typed path stays build-and-warn: a shape change there fails loudly at the call. The
// operator override exists for the window between a redeploy and the release that ships its
// hash; it is labeled on every result it produces.
export function bytesDecoderGate(a: {
  checks: readonly ImplementationCheck[];
  roles: readonly string[];
  chainId: ChainId;
  ctx: HandlerContext;
  artifact: string;
  adapterName: string;
}): { gate?: Envelope; warnings: Array<{ code: string; message: string }> } {
  const refusals = implementationRefusals(a.checks, a.roles);
  if (refusals.length === 0) return { warnings: [] };
  const describe = (c: ImplementationCheck) =>
    c.verdict === "not_approved"
      ? `${c.role} ${c.address} runs code hashing to ${c.codehash}, which is NOT on the approved-implementations list bundled into this build`
      : c.verdict === "no_code"
        ? `${c.role} ${c.implementation ?? c.address} has NO code on chain`
        : `${c.role} ${c.address} is configured as an EIP-1967 proxy whose implementation slot is empty`;
  if (unapprovedCodeAllowed()) {
    return {
      warnings: refusals.map((c) => ({
        code: "implementation_gate_bypassed",
        message: `CORK_ALLOW_UNAPPROVED_CODE is set: ${describe(c)} — the ${a.artifact} was built anyway, for the extraData layout THIS BUILD knows. The ${a.adapterName} decodes those bytes with code this build never tested; verify the layout against the deployed decodeExtraData (or a fork fill) before signing`,
      })),
    };
  }
  return {
    warnings: [],
    gate: envelope({
      state: "conflict",
      data: { refused: refusals.map((c) => ({ role: c.role, address: c.address, ...(c.implementation ? { implementation: c.implementation } : {}), ...(c.codehash ? { codehash: c.codehash } : {}), verdict: c.verdict })), override: "CORK_ALLOW_UNAPPROVED_CODE=1 (CLI --allow-unapproved-code) builds anyway, labeled implementation_gate_bypassed" },
      chainId: a.chainId,
      source: "chain",
      warnings: refusals.map((c) => ({
        code: "implementation_not_approved",
        message: `${describe(c)}. The ${a.adapterName} DECODES the extraData this tool encodes — a \`bytes\` layout no ABI describes (policy R12a) — so code this build never tested against could read these bytes as a different market or a different fee, silently. No ${a.artifact} was built. If the address moved ahead of a release and you have verified the new code yourself, set CORK_ALLOW_UNAPPROVED_CODE=1 (CLI --allow-unapproved-code) to build anyway; every such result is labeled implementation_gate_bypassed`,
      })),
      ctx: a.ctx,
    }),
  };
}

/** The R12a round-trip: hand the bytes we built to the adapter's own `decodeExtraData` and
 *  compare what it read back, field for field, with what we meant. Verified = the deployed
 *  decoder agrees on every field; unchecked = the adapter exposes no helper (pre-0.4.0) or the
 *  read failed, said in words, never guessed; a disagreement is a conflict with no bytes — the
 *  exact failure class the finding describes, caught before anyone signs. */
export async function verifyExtraDataLayout(a: {
  client: { readContract: (args: { address: `0x${string}`; abi: typeof jitAdapterAbi; functionName: "decodeExtraData"; args: [`0x${string}`] }) => Promise<unknown> };
  adapter: `0x${string}`;
  extraData: `0x${string}`;
  params: JITMarketParams;
  permits: readonly PermitParams[];
  chainId: ChainId;
  ctx: HandlerContext;
  artifact: string;
}): Promise<{ status: string } | { gate: Envelope }> {
  let decoded: { params: JITMarketParams; permits: PermitParams[] };
  try {
    const out = (await a.client.readContract({ address: a.adapter, abi: jitAdapterAbi, functionName: "decodeExtraData", args: [a.extraData] })) as readonly [JITMarketParams, readonly PermitParams[]];
    decoded = { params: { ...out[0], constraint: { ...out[0].constraint } }, permits: out[1].map((p) => ({ ...p })) };
  } catch (err) {
    return { status: `unchecked: the adapter exposes no decodeExtraData helper (pre-0.4.0 generation) or the read failed (${revertReason(err)}) — the bytes follow the layout this build knows` };
  }
  const differing = diffJitExtraData({ params: a.params, permits: a.permits }, decoded);
  if (differing.length === 0) return { status: "verified-on-chain: the adapter's decodeExtraData read these bytes back field for field" };
  return {
    gate: envelope({
      state: "conflict",
      data: { adapter: a.adapter, differing, encoded: jsonSafe({ params: a.params, permits: a.permits }), decoded: jsonSafe(decoded) },
      chainId: a.chainId,
      source: "chain",
      warnings: [{ code: "extra_data_layout_mismatch", message: `the deployed adapter's decodeExtraData read the extraData this tool encoded DIFFERENTLY on ${differing.join(", ")} — the bytes layout this build encodes is not the layout the adapter at ${a.adapter} decodes (policy R12a: a \`bytes\` layout change the ABI cannot show). No ${a.artifact} was built: a fill would create or mint against a market other than the one you meant. Update cork-cli to a build that targets this adapter generation` }],
      ctx: a.ctx,
    }),
  };
}

const jsonSafe = (v: unknown): unknown => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x)));
