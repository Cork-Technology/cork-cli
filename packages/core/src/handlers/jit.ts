// Split from handlers.ts (2026-08-05): jit handlers — one typed dispatch, per-tool modules.
// Declarations are moved byte-identically; see handlers.ts for the runTool dispatch.
import { type ChainId, Envelope } from "@cork/schemas";
import { rateOracleAbi } from "../chain/abis.ts";
import { type LopOrder } from "../orders.ts";
import { buildDeployFixedRateOracleCall, buildDeployOracleCall, decodeJitExtension, deriveJitMarket, encodeJitExtraData, jitAdapterAbi, type PermitParams, predictShares, readAdapterRoles, readForeignSharePool, recipeAbi, type ResolvedConstraint } from "../market-registry.ts";
import * as legacyRegistry from "../market-registry-legacy.ts";
import { deprecatedEnabled, deprecatedGateMessage } from "../deprecation.ts";
import { resolveMarketRegistry, resolveMarketRegistryLegacy } from "../config-remote.ts";
import { envelope, getDep, getRpc, type HandlerContext, nowSecondsOf, revertReason, ToolInputError, unavailable } from "./shared.ts";
import { resolveRecipeOracleConstraint, staticResolveConstraint } from "./registry.ts";


/** Value-domain gate shared by BOTH JIT builders (maker extension + taker interaction): the
 *  protocol's fee cap and strictly-future expiry, in one place so a boundary rule can never
 *  drift between the two paths. Returns the gate envelope, or undefined when the values pass. */
export function jitValueGate(chainId: ChainId, ctx: HandlerContext, swapFee: bigint, unwindFee: bigint, expiryTimestamp: bigint, nowSecs: bigint): Envelope | undefined {
  if (swapFee > 5n * 10n ** 18n || unwindFee > 5n * 10n ** 18n) {
    return unavailable(chainId, "invalid_order_terms", "JIT fee percentages are 1e18 = 1% and capped at 5e18 (5%) — this value would revert at pool creation", ctx);
  }
  if (expiryTimestamp <= nowSecs) {
    return unavailable(chainId, "invalid_order_terms", `jitMarket.expiryTimestamp ${expiryTimestamp} is not in the future (now ${nowSecs}) — pool creation requires expiryTimestamp > block.timestamp, so a fill would revert. Note this field is ABSOLUTE unix seconds, not a relative duration`, ctx);
  }
  return undefined;
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

/** Build the TAKER interaction (`adapter ++ abi.encode(JITMarketParams, PermitParams[])`) for
 *  lifting a resting order — the walkthrough's canonical settle path: the underwriter-taker
 *  delivers a not-yet-minted cST via takerInteraction, which always mints (enableJitMint gates
 *  only the maker-side twin). Reuses the SAME primitives as the maker-side prepare (recipe
 *  resolution, constraint staticcall, verify pre-flight, state-override share prediction), so
 *  every protocol rule stays single-sourced; only the orchestration differs — including one
 *  taker-specific guard: when the RESTING order carries its own JIT extension, the taker's
 *  params must derive the SAME pool id, or the two hooks would fight (conflict, no bytes). */
export async function buildTakerJitInteraction(args: {
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
  taker: `0x${string}`;
  order: LopOrder;
  orderExtension: `0x${string}` | undefined;
}): Promise<{ gate: Envelope } | { gate?: undefined; interaction: `0x${string}`; jit: Record<string, unknown>; warnings: Array<{ code: string; message: string }> }> {
  const { ctx, chainId, lop, jm } = args;
  const warnings: Array<{ code: string; message: string }> = [];
  const nowSecs = nowSecondsOf(ctx);
  const swapFee = BigInt(jm.swapFeePercentage);
  const unwindFee = BigInt(jm.unwindSwapFeePercentage);
  const expiryTimestamp = BigInt(jm.expiryTimestamp);
  const valueGate = jitValueGate(chainId, ctx, swapFee, unwindFee, expiryTimestamp, nowSecs);
  if (valueGate) return { gate: valueGate };
  const { marketRegistry: mr, warning: mrWarn } = await resolveMarketRegistry(chainId);
  if (!mr?.adapter) {
    return { gate: unavailable(chainId, "unknown_deployment", `no JIT CorkLimitOrderAdapter configured for chainId ${chainId} — JIT fills are live on Arbitrum One (42161)`, ctx) };
  }
  if (mrWarn) warnings.push(mrWarn);
  let recipe = jm.recipe;
  if (!recipe) {
    if (jm.mode === undefined) {
      throw new ToolInputError("cork_prepare_orders", [{ path: ["action", "jitMarket", "recipe"], message: "jitMarket needs `recipe` (the approved IMarketRecipe CONTRACT ADDRESS); `mode` survives only as deprecated sugar" }]);
    }
    const hinted = mr.recipes?.[jm.mode];
    if (!hinted) {
      return { gate: unavailable(chainId, "recipe_not_found", `recipe mode '${jm.mode}' has no configured 2.1.0 recipe hint — recipes are CONTRACT ADDRESSES now (jitMarket.recipe); known mode hints: ${Object.keys(mr.recipes ?? {}).join(", ") || "none"}`, ctx) };
    }
    warnings.push({ code: "deprecation_notice", message: `jitMarket.mode is deprecated sugar: '${jm.mode}' resolved to recipe ${hinted} — pass jitMarket.recipe directly` });
    recipe = hinted;
  }
  const rateOverride = BigInt(jm.rateOverride ?? "0");
  const additionalData = (jm.additionalData ?? "0x") as `0x${string}`;
  let constraint: ResolvedConstraint | undefined = jm.constraint
    ? { rateMin: BigInt(jm.constraint.rateMin), rateMax: BigInt(jm.constraint.rateMax), rateChangePerDayMax: BigInt(jm.constraint.rateChangePerDayMax), rateChangeCapacityMax: BigInt(jm.constraint.rateChangeCapacityMax) }
    : undefined;
  let jit: Record<string, unknown> = { adapter: mr.adapter, hook: "takerInteraction (taker-side — always mints)", recipe };

  const resolved = await getRpc(ctx, chainId);
  if (!resolved) {
    if (!constraint) {
      return { gate: unavailable(chainId, "requires_rpc", "jitMarket has no explicit constraint and no RPC resolved to derive one — set CORK_RPC_URL, or pass jitMarket.constraint (from cork_compute resolve-recipe)", ctx) };
    }
    warnings.push({ code: "funding_needs_rpc", message: "no RPC resolved — taker-side JIT pre-flights (adapter bindings, roles, recipe, oracle, verify, cST side-match) were SKIPPED; the interaction is built from the caller-supplied constraint but unverified" });
  } else {
    const client = resolved.client;
    try {
      const [boundLop, boundRegistry, boundController] = await Promise.all([
        client.readContract({ address: mr.adapter, abi: jitAdapterAbi, functionName: "LIMIT_ORDER_PROTOCOL" }),
        client.readContract({ address: mr.adapter, abi: jitAdapterAbi, functionName: "MARKET_REGISTRY" }),
        client.readContract({ address: mr.adapter, abi: jitAdapterAbi, functionName: "CONTROLLER" }),
      ]);
      if (boundLop.toLowerCase() !== lop.toLowerCase() || boundRegistry.toLowerCase() !== mr.registry.toLowerCase()) {
        return { gate: envelope({ state: "conflict", data: { adapter: mr.adapter, expected: { lop, registry: mr.registry }, onChain: { lop: boundLop, registry: boundRegistry } }, chainId, source: "chain", warnings: [{ code: "adapter_binding_mismatch", message: "the configured JIT adapter's on-chain bindings do not match this tool's LOP/registry config — refresh cork-defaults.json before broadcasting anything" }], ctx }) };
      }
      const adapterRoles = await readAdapterRoles(client, boundController, mr.adapter);
      if (!adapterRoles.granted) {
        warnings.push({ code: "roles_not_granted", message: `the adapter is missing controller roles (POOL_CREATOR: ${adapterRoles.hasCreator}, ${adapterRoles.secondRole}: ${adapterRoles.hasSecond}) — this fill will revert until both are granted (a governance action)` });
      }
      const res = await resolveRecipeOracleConstraint({ client, ctx, chainId, mr, recipe, collateralAsset: jm.collateralAsset, referenceAsset: jm.referenceAsset, fixedRate: rateOverride > 0n ? rateOverride : undefined, additionalData, wantConstraint: false });
      warnings.push(...res.warnings);
      if (res.gate) return { gate: res.gate };
      const { source, oracle } = res;
      if (source === "fixed" && rateOverride === 0n) {
        return { gate: unavailable(chainId, "invalid_order_terms", `recipe ${recipe} is a FIXED-rate recipe: rateOverride must carry the rate its FixedRateOracle is deployed at — zero reverts the fill`, ctx) };
      }
      if (source !== "fixed" && rateOverride !== 0n) {
        return { gate: unavailable(chainId, "invalid_order_terms", `recipe ${recipe} reads a ${source} oracle: rateOverride must be 0 — a non-zero value is REJECTED by the fill (UnexpectedRateOverride)`, ctx) };
      }
      if (!constraint) {
        const c = await staticResolveConstraint(client, ctx, chainId, { recipe, collateralAsset: jm.collateralAsset, referenceAsset: jm.referenceAsset, oracle, additionalData });
        if ("gate" in c) return { gate: c.gate };
        constraint = c.constraint;
      }
      if (oracle.address === null) {
        return { gate: unavailable(chainId, "oracle_not_deployable", `the recipe's oracle cannot be resolved (${oracle.reason ?? "pair not deployable as-registered"}) — the fill would revert`, ctx) };
      }
      if (oracle.deployed) {
        const ok = await client.readContract({ address: recipe, abi: recipeAbi, functionName: "verify", args: [jm.collateralAsset, jm.referenceAsset, oracle.address, { ...constraint }, additionalData] }).catch(() => null);
        if (ok === false) warnings.push({ code: "would_revert", message: "recipe.verify REJECTS this constraint against the live oracle right now — the fill would revert RecipeRejectedConstraint; re-resolve and rebuild" });
      }
      const derived = deriveJitMarket({ collateralAsset: jm.collateralAsset, referenceAsset: jm.referenceAsset, expiryTimestamp, constraint, oracle: oracle.address });
      jit = { ...jit, source, oracle: { address: oracle.address, deployed: oracle.deployed }, derivedPoolId: derived.poolId, constraint };
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
        preCalls.push({ to: mr.registry, data: source === "fixed" ? buildDeployFixedRateOracleCall(rateOverride) : buildDeployOracleCall(jm.collateralAsset, jm.referenceAsset, oracle.mode ?? "price") });
      }
      const pred = await predictShares(client, { adapter: mr.adapter, controller: boundController, poolManager: jitDep!.poolManager, market: derived.market, poolId: derived.poolId, unwindSwapFeePercentage: unwindFee, swapFeePercentage: swapFee, preCalls });
      if (pred.status === "unavailable") {
        warnings.push({ code: "share_prediction_unavailable", message: "could not predict the pool's cST (eth_simulateV1/state overrides unsupported) — VERIFY yourself that one side of the RESTING order is the derived pool's cST, or the fill reverts OrderNotForPool" });
      }
      if (pred.cst) {
        jit = { ...jit, predictedCorkSwapToken: pred.cst, permitNote: "sign the ERC-2612 permit over this cST with the TAKER as owner (spender = the LOP, value >= the cST amount) and pass it in jitMarket.permits — the LOP pulls the just-minted cST from the taker" };
        const cstLc = pred.cst.toLowerCase();
        if (args.order.makerAsset.toLowerCase() !== cstLc && args.order.takerAsset.toLowerCase() !== cstLc) {
          warnings.push({ code: "jit_side_mismatch", message: `NEITHER side of the resting order is the derived pool's cST ${pred.cst} — the fill WILL revert OrderNotForPool` });
          await diagnoseStaleSidePrediction(client, [["the resting order's makerAsset", args.order.makerAsset], ["the resting order's takerAsset", args.order.takerAsset]], derived.poolId, warnings, "This resting order can never fill; it must be re-signed against a fresh share prediction.");
        }
      }
    } catch (err) {
      if (!constraint) {
        return { gate: unavailable(chainId, "chain_read_failed", `taker-side JIT pre-flight reads failed (${revertReason(err)}) and no explicit constraint was supplied — the interaction cannot be built. Retry, or pass jitMarket.constraint`, ctx) };
      }
      warnings.push({ code: "chain_read_failed", message: `taker-side JIT pre-flight reads failed (${revertReason(err)}) — the interaction is built from the caller-supplied constraint but unverified` });
    }
  }
  const permits: PermitParams[] = (jm.permits ?? []).map((p) => ({ token: p.token, value: BigInt(p.value), deadline: BigInt(p.deadline), v: p.v, r: p.r, s: p.s }));
  const extraData = encodeJitExtraData(
    { collateralAsset: jm.collateralAsset, referenceAsset: jm.referenceAsset, expiryTimestamp, recipe, rateOverride, constraint: constraint!, additionalData, swapFeePercentage: swapFee, unwindSwapFeePercentage: unwindFee, enableJitMint: jm.enableJitMint },
    permits,
  );
  const interaction = `0x${mr.adapter.slice(2)}${extraData.slice(2)}` as `0x${string}`;
  return { interaction, jit, warnings };
}

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
}): Promise<{ gate: Envelope } | { gate?: undefined; extension: `0x${string}`; jitData: Record<string, unknown>; warnings: Array<{ code: string; message: string }> }> {
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
  let jitData: Record<string, unknown> = { generation: "legacy (pre-2.1.0)", adapter: mr.adapter, hook: "preInteraction (maker-side)", mode, enableJitMint: jm.enableJitMint };
  warnings.push({ code: "rate_drift_notice", message: "LEGACY generation: market identity follows the LIVE oracle rate — the derived pool id is only stepwise-stable, and a drifted rate reverts the fill with OrderNotForPool (by design, as a staleness guard)" });
  const resolved = await getRpc(ctx, chainId);
  if (!resolved) {
    warnings.push({ code: "funding_needs_rpc", message: "no RPC resolved — legacy JIT pre-flights (adapter bindings, roles, recipe, oracle, derived pool, cST side-match) were SKIPPED; the extension is built but unverified" });
    return { extension, jitData, warnings };
  }
  const client = resolved.client;
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
    const rate = (await client.readContract({ address: oracle, abi: rateOracleAbi, functionName: "rate" })) as bigint;
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
