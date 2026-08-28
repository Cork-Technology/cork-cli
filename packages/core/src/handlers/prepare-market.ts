// Split from handlers.ts (2026-08-05): prepare-market handlers — one typed dispatch, per-tool modules.
// Declarations are moved byte-identically; see handlers.ts for the runTool dispatch.
import { type ChainId, Envelope, executionEthTransaction, UNITS_TOPIC_REFERENCE } from "@cork/schemas";
import { buildCreatorCreatePoolCall, buildDeployFixedRateOracleCall, buildDeployOracleCall, deriveJitMarket, marketCreatorAbi, type OracleModeName, predictShares, type PredictSharesResult, rateOverrideCoherence, readAdapterRoles, recipeAbi, type ResolvedConstraint } from "../market-registry.ts";
import { resolveMarketRegistry } from "../config-remote.ts";
import { approvedImplementationGuard, CREATE_POOL_IMPLEMENTATION_ROLES, PREPARE_MARKET_IMPLEMENTATION_ROLES } from "../implementations.ts";
import { envelope, getDep, getRpc, type HandlerContext, nowSecondsOf, revertReason, rpcWarn, ToolInputError, unavailable } from "./shared.ts";
import { jitValueGate, maxExpiryBoundWarning, type ValueGateSite } from "./jit.ts";
import { probeFixedOracle, probePairWrapper, resolveModeSugar, resolveRecipeOracleConstraint, staticResolveConstraint } from "./registry.ts";

/** cork_prepare_market: unsigned oracle-infrastructure txs against the 2.1.0 registry —
 *  deploy-oracle = MarketRegistry.deploy(ca, ref, mode) (mode-keyed: one pair can hold a PRICE
 *  and a NAV wrapper at different addresses); deploy-fixed-oracle =
 *  MarketRegistry.deployFixedRateOracle(rate) (keyed on the RATE, no pair). Both are
 *  permissionless + idempotent on-chain; the pre-flight read is best-effort disclosure. */

/** The `oracle:{address,deployed}` status block — the same shape cork_query registry-oracle and
 *  derive-cork-pool report, so the three surfaces cannot drift. Empty when no RPC resolved. */
type OracleStatus = { oracle?: { address: `0x${string}`; deployed: boolean } };

/** create-pool wire fields: the jitMarket block minus the fill-only mint flag/permits — the
 *  creator's MarketParams keeps the shared field names, types, and order. */
export interface CreatePoolAction {
  type: "create-pool";
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
}

export async function handlePrepareMarket(
  input: { chainId: ChainId; clientRequestId: string; action: { type: "deploy-oracle"; collateralAsset: `0x${string}`; referenceAsset: `0x${string}`; mode?: "price" | "nav" } | { type: "deploy-fixed-oracle"; rate: string } | CreatePoolAction; format: "concise" | "full" },
  ctx: HandlerContext,
): Promise<Envelope> {
  const chainId = input.chainId;
  const { marketRegistry: mr, warning } = await resolveMarketRegistry(chainId);
  if (!mr) {
    return unavailable(chainId, "unknown_deployment", `no MarketRegistry configured for chainId ${chainId} — the registry stack is live on Arbitrum One and Base (42161, 8453)`, ctx);
  }
  const warnings: Array<{ code: string; message: string }> = warning ? [warning] : [];
  const a = input.action;
  if (a.type === "create-pool") return handleCreatePool(input, a, mr, warnings, ctx);
  const resolved = await getRpc(ctx, chainId);
  // Interface-first guard, scoped to the one contract this tx executes (the registry):
  // build-and-warn, same posture as the deployability pre-check below.
  if (resolved) warnings.push(...(await approvedImplementationGuard(resolved.client, chainId, { roles: PREPARE_MARKET_IMPLEMENTATION_ROLES, ...(ctx.atBlock !== undefined ? { atBlock: ctx.atBlock } : {}) })));
  // rpcWarn is prepended at ENVELOPE construction, not pushed here: the client fails over
  // in-call (mutating `resolved`), and the disclosure must describe the endpoint that served
  // the pre-checks.

  if (a.type === "deploy-fixed-oracle") {
    const rate = BigInt(a.rate);
    if (rate === 0n) return unavailable(chainId, "invalid_order_terms", "a zero fixed rate cannot have an oracle — the FixedRateOracle constructor reverts on 0; sending this tx would revert", ctx);
    const calldata = buildDeployFixedRateOracleCall(rate);
    let status: OracleStatus = {};
    if (resolved) {
      try {
        const fixed = await probeFixedOracle(resolved.client, mr.registry, rate);
        status = { oracle: { address: fixed.address, deployed: fixed.deployed } };
        if (fixed.deployed) warnings.push({ code: "oracle_already_deployed", message: `the fixed-rate oracle for rate ${rate} already exists at ${fixed.address} (CREATE2-salted by the rate: one oracle per rate per chain) — the tx is a safe no-op (deploy is idempotent)` });
      } catch (err) {
        warnings.push({ code: "chain_read_failed", message: `the predictFixedRateOracle pre-check failed (${revertReason(err)}) — the calldata is exact regardless` });
      }
    } else {
      warnings.push({ code: "funding_needs_rpc", message: "no RPC resolved — the deployability pre-check was skipped; the calldata is exact regardless" });
    }
    return envelope({
      state: "ok",
      data: { kind: "deploy-fixed-oracle", to: mr.registry, calldata, value: "0", rate, scale: "rate is ABSOLUTE, 1e18 = 1.0", ...status, execution: executionEthTransaction(), clientRequestId: input.clientRequestId },
      chainId,
      source: resolved ? "chain" : "config",
      warnings: [...(resolved ? rpcWarn(resolved) : []), ...warnings],
      ctx,
    });
  }

  const modeName: OracleModeName = a.mode ?? "price";
  const modeNote = a.mode === undefined ? { modeNote: "no mode given — defaulted to 'price'; oracles are MODE-KEYED in 2.1.0 (one pair can hold a price AND a nav wrapper at different addresses), pass mode:'nav' when you mean nav" } : {};
  const calldata = buildDeployOracleCall(a.collateralAsset, a.referenceAsset, modeName);

  // Best-effort status read (calldata building is pure; the tx is safe either way).
  let status: OracleStatus = {};
  if (resolved) {
    try {
      // probePairWrapper is the SAME probe cork_query registry-oracle / derive-cork-pool run —
      // shared logic, not just a shared output shape. A lookupWrapper transport failure now
      // lands in the catch as chain_read_failed (it used to be mislabeled oracle_not_deployable,
      // which is a deployability VERDICT this indeterminate read cannot support).
      const probe = await probePairWrapper(resolved.client, mr.registry, a.collateralAsset, a.referenceAsset, modeName);
      if (probe.address !== null && probe.deployed) {
        status = { oracle: { address: probe.address, deployed: true } };
        warnings.push({ code: "oracle_already_deployed", message: `this pair's ${modeName} oracle already exists at ${probe.address} — the tx is a safe no-op (deploy is idempotent and returns the recorded address)` });
      } else if (probe.address !== null) {
        status = { oracle: { address: probe.address, deployed: false } };
      } else {
        warnings.push({ code: "oracle_not_deployable", message: `the deploy simulation reverted: ${probe.reason}. Sending this tx would revert` });
      }
    } catch (err) {
      warnings.push({ code: "chain_read_failed", message: `the oracle status pre-check failed (${revertReason(err)}) — the calldata is exact regardless` });
    }
  } else {
    warnings.push({ code: "funding_needs_rpc", message: "no RPC resolved — the deployability pre-check was skipped; the calldata is exact regardless" });
  }
  return envelope({
    state: "ok",
    data: { kind: "deploy-oracle", to: mr.registry, calldata, value: "0", collateralAsset: a.collateralAsset, referenceAsset: a.referenceAsset, mode: modeName, ...modeNote, ...status, execution: executionEthTransaction(), clientRequestId: input.clientRequestId },
    chainId,
    source: resolved ? "chain" : "config",
    warnings: [...(resolved ? rpcWarn(resolved) : []), ...warnings],
    ctx,
  });
}

// ── create-pool: unsigned CorkMarketCreator.createNewPool(params) ────────────────────────────

const CREATOR_VALUE_SITE: ValueGateSite = { fees: "createNewPool fee percentages", expiryField: "expiryTimestamp", revertActor: "sending this tx" };

/** The smart-account teaching this action exists for, echoed on every successful build. */
const CREATOR_NOTE = "the smart-account path around EOA-only ERC-2612 JIT permits: batch this tx, then cst.approve(limitOrderProtocol), then the maker order/fill with NO permits (enableJitMint stays false — the pool already exists). The call is idempotent: an existing pool is a lookup returning (poolId, cst, cpt), nothing reverts";

const CREATOR_SCALES = {
  constraint: "ABSOLUTE rates, 1e18 = 1.0 (NOT the 1e18=1% fee family)",
  rateOverride: "ABSOLUTE, 1e18 = 1.0 (FIXED recipes only; 0 otherwise)",
  swapFeePercentage: "PERCENTAGE, 1e18 = 1% (max 5e18 = 5%)",
  unwindSwapFeePercentage: "PERCENTAGE, 1e18 = 1% (max 5e18 = 5%)",
  unitsTopic: UNITS_TOPIC_REFERENCE,
} as const;

/** Build the unsigned CorkMarketCreator.createNewPool tx: the pool a JIT order derives, created
 *  AHEAD of the fill — the same derivation and the same checks a fill runs (recipe membership →
 *  oracle deploy → constraint verify → fee/expiry bounds), permissionless and idempotent.
 *  Pre-flights mirror the JIT ladder's posture: value-domain rules gate (envelope, exit 3);
 *  chain pre-flights build-and-warn, each degrading to silence when its read is unavailable;
 *  offline byte-building works with an explicit constraint (the creator resolves the ORACLE
 *  on-chain, so unlike derive-cork-pool the calldata needs no oracle address). */
async function handleCreatePool(
  input: { chainId: ChainId; clientRequestId: string; format: "concise" | "full" },
  a: CreatePoolAction,
  mr: NonNullable<Awaited<ReturnType<typeof resolveMarketRegistry>>["marketRegistry"]>,
  warnings: Array<{ code: string; message: string }>,
  ctx: HandlerContext,
): Promise<Envelope> {
  const chainId = input.chainId;
  const creator = mr.marketCreator;
  if (!creator) {
    return unavailable(chainId, "unknown_deployment", `no CorkMarketCreator configured for chainId ${chainId} — direct pool creation is live on Arbitrum One and Base (42161, 8453)`, ctx);
  }
  if (a.collateralAsset.toLowerCase() === a.referenceAsset.toLowerCase()) {
    return unavailable(chainId, "invalid_pair", "collateralAsset and referenceAsset must differ — a market is a pair of distinct assets", ctx);
  }
  // Recipe: explicit address, or DEPRECATED mode sugar over the config hints (config-only, so
  // the sugar also works offline) — the same rule as the JIT ladder.
  let recipe = a.recipe;
  if (!recipe) {
    if (a.mode === undefined) {
      throw new ToolInputError("cork_prepare_market", [{ path: ["action", "recipe"], message: "create-pool needs `recipe` (the approved IMarketRecipe CONTRACT ADDRESS — discover with cork_query resource:\"registry-recipes\"); `mode` survives only as deprecated sugar" }]);
    }
    const sugar = resolveModeSugar({ mr, mode: a.mode, modeField: "mode", recipeField: "recipe", chainId, ctx, warnings });
    if (sugar.gate) return sugar.gate;
    recipe = sugar.recipe;
  }
  const rateOverride = BigInt(a.rateOverride ?? "0");
  const additionalData = (a.additionalData ?? "0x") as `0x${string}`;
  const swapFee = BigInt(a.swapFeePercentage);
  const unwindFee = BigInt(a.unwindSwapFeePercentage);
  const expiryTimestamp = BigInt(a.expiryTimestamp);
  const nowSecs = nowSecondsOf(ctx);
  // Value-domain rules (the creator restates the adapter's bounds: fee cap 5e18, future
  // expiry) — the SHARED gate, creator-worded.
  const valueGate = jitValueGate(chainId, ctx, swapFee, unwindFee, expiryTimestamp, nowSecs, CREATOR_VALUE_SITE);
  if (valueGate) return valueGate;
  let constraint: ResolvedConstraint | undefined = a.constraint
    ? { rateMin: BigInt(a.constraint.rateMin), rateMax: BigInt(a.constraint.rateMax), rateChangePerDayMax: BigInt(a.constraint.rateChangePerDayMax), rateChangeCapacityMax: BigInt(a.constraint.rateChangeCapacityMax) }
    : undefined;

  const build = (c: ResolvedConstraint): `0x${string}` =>
    buildCreatorCreatePoolCall({ collateralAsset: a.collateralAsset, referenceAsset: a.referenceAsset, expiryTimestamp, recipe, rateOverride, constraint: c, additionalData, swapFeePercentage: swapFee, unwindSwapFeePercentage: unwindFee });
  const baseData = (c: ResolvedConstraint) => ({
    kind: "create-pool" as const,
    to: creator,
    calldata: build(c),
    value: "0",
    collateralAsset: a.collateralAsset,
    referenceAsset: a.referenceAsset,
    expiryTimestamp,
    recipe,
    rateOverride,
    constraint: { ...c },
    scales: CREATOR_SCALES,
    note: CREATOR_NOTE,
    execution: executionEthTransaction(),
    clientRequestId: input.clientRequestId,
  });

  const resolved = await getRpc(ctx, chainId);
  if (!resolved) {
    if (!constraint) {
      return unavailable(chainId, "requires_rpc", "create-pool has no explicit constraint and no RPC resolved to derive one — set CORK_RPC_URL, or pass `constraint` (from cork_compute recipe-rate-constraint)", ctx);
    }
    warnings.push({ code: "funding_needs_rpc", message: "no RPC resolved — creator pre-flights (bindings, roles, recipe membership, source/rateOverride coherence, oracle, verify, expiry bound, pool existence) were SKIPPED; the tx is built from the caller-supplied constraint but unverified" });
    return envelope({ state: "ok", data: baseData(constraint), chainId, source: "config", warnings, ctx });
  }
  const client = resolved.client;
  // Interface-first guard on the two contracts this tx executes (creator + registry) — the
  // binding reads below prove WHICH contracts, this proves their CODE is the admitted one.
  warnings.push(...(await approvedImplementationGuard(client, chainId, { roles: CREATE_POOL_IMPLEMENTATION_ROLES, ...(ctx.atBlock !== undefined ? { atBlock: ctx.atBlock } : {}) })));
  try {
    const [boundPm, boundController, boundRegistry] = await Promise.all([
      client.readContract({ address: creator, abi: marketCreatorAbi, functionName: "POOL_MANAGER" }),
      client.readContract({ address: creator, abi: marketCreatorAbi, functionName: "CONTROLLER" }),
      client.readContract({ address: creator, abi: marketCreatorAbi, functionName: "MARKET_REGISTRY" }),
    ]);
    const { dep } = await getDep(ctx, chainId);
    if (boundRegistry.toLowerCase() !== mr.registry.toLowerCase() || (dep?.poolManager !== undefined && boundPm.toLowerCase() !== dep.poolManager.toLowerCase())) {
      return envelope({
        state: "conflict",
        data: { marketCreator: creator, expected: { registry: mr.registry, ...(dep?.poolManager ? { poolManager: dep.poolManager } : {}) }, onChain: { registry: boundRegistry, poolManager: boundPm } },
        chainId,
        source: "chain",
        warnings: [{ code: "adapter_binding_mismatch", message: "the configured CorkMarketCreator's on-chain bindings do not match this tool's registry/pool-manager config — a stale or cross-generation address; refresh cork-defaults.json before signing anything" }],
        ctx,
      });
    }
    const creatorRoles = await readAdapterRoles(client, boundController, creator);
    if (!creatorRoles.granted) {
      warnings.push({ code: "roles_not_granted", message: `the market creator is missing controller roles (POOL_CREATOR: ${creatorRoles.hasCreator}, ${creatorRoles.secondRole}: ${creatorRoles.hasSecond}) — sending this tx will revert until both are granted (a governance action, not a code change)` });
    }
    const res = await resolveRecipeOracleConstraint({ client, ctx, chainId, mr, recipe, collateralAsset: a.collateralAsset, referenceAsset: a.referenceAsset, fixedRate: rateOverride > 0n ? rateOverride : undefined, additionalData, wantConstraint: false });
    warnings.push(...res.warnings);
    if (res.gate) return res.gate;
    const { source, oracle } = res;
    // rateOverride ↔ source coherence — the SAME comparator the JIT ladder gates on.
    const coherence = rateOverrideCoherence(source, rateOverride);
    if (coherence === "needs-rate") {
      return unavailable(chainId, "invalid_order_terms", `recipe ${recipe} is a FIXED-rate recipe: the tx must carry rateOverride (the rate its FixedRateOracle is deployed at) — zero reverts in the oracle constructor`, ctx);
    }
    if (coherence === "must-be-zero") {
      return unavailable(chainId, "invalid_order_terms", `recipe ${recipe} reads a ${source} oracle: rateOverride must be 0 — a non-zero value is REJECTED by the creator (UnexpectedRateOverride), not ignored`, ctx);
    }
    if (!constraint) {
      const c = await staticResolveConstraint(client, ctx, chainId, { recipe, collateralAsset: a.collateralAsset, referenceAsset: a.referenceAsset, oracle, additionalData });
      if ("gate" in c) return c.gate;
      constraint = c.constraint;
    }
    if (oracle.address === null) {
      warnings.push({ code: "oracle_not_deployable", message: `this pair cannot get a ${source} oracle as-registered (${oracle.reason ?? "unregistered asset / missing source or conversion path"}) — sending this tx would revert. The calldata is exact regardless` });
      return envelope({ state: "ok", data: baseData(constraint), chainId, source: "chain", warnings: [...rpcWarn(resolved), ...warnings], ctx });
    }
    // Verify pre-flight — the exact staticcall the creator runs (step 4 of its recipe
    // sequence). Only meaningful against a DEPLOYED oracle; an undeployed one is deployed by
    // the tx itself, then re-checked live.
    if (oracle.deployed) {
      const ok = await client.readContract({ address: recipe, abi: recipeAbi, functionName: "verify", args: [a.collateralAsset, a.referenceAsset, oracle.address, { ...constraint }, additionalData] }).catch(() => null);
      if (ok === false) {
        warnings.push({ code: "would_revert", message: "recipe.verify REJECTS this constraint against the live oracle right now — sending this tx would revert RecipeRejectedConstraint (the constraint is stale, or was never one this recipe would produce). Re-resolve it (cork_compute recipe-rate-constraint) and rebuild" });
      } else if (ok === null) {
        warnings.push({ code: "chain_read_failed", message: "the recipe.verify pre-flight read failed — the creator's constraint check could not be previewed" });
      }
    } else {
      warnings.push({ code: "oracle_not_deployed", message: `the recipe's oracle is not deployed yet (predicted ${oracle.address}) — the tx deploys it automatically (permissionless, idempotent), then recipe.verify re-checks the carried constraint against the LIVE rate. The pool id below assumes the predicted oracle address; re-registering the pair's sources before this tx lands would shift it` });
    }
    warnings.push({ code: "constraint_window_notice", message: "the tx carries the constraint resolved NOW: if the live rate walks outside its window before you broadcast, the creator reverts RecipeRejectedConstraint — re-resolve (cork_compute recipe-rate-constraint) and rebuild" });
    const derived = deriveJitMarket({ collateralAsset: a.collateralAsset, referenceAsset: a.referenceAsset, expiryTimestamp, constraint, oracle: oracle.address });
    // cST/cPT + existence: pinned when the pool exists, else the state-override simulation —
    // the same prediction derive-cork-pool serves, so the tx's return values are known upfront.
    let shares: PredictSharesResult = { exists: false, status: "unavailable" };
    if (dep?.poolManager && mr.controller && mr.adapter) {
      const preCalls: Array<{ to: `0x${string}`; data: `0x${string}` }> = [];
      if (!oracle.deployed) {
        preCalls.push({ to: mr.registry, data: source === "fixed" ? buildDeployFixedRateOracleCall(rateOverride) : buildDeployOracleCall(a.collateralAsset, a.referenceAsset, oracle.mode ?? "price") });
      }
      shares = await predictShares(client, { adapter: mr.adapter, controller: mr.controller, poolManager: dep.poolManager, market: derived.market, poolId: derived.poolId, preCalls });
    }
    if (shares.status === "unavailable") {
      warnings.push({ code: "share_prediction_unavailable", message: "could not predict the pool's cST/cPT (eth_simulateV1/state overrides unsupported, or config missing) — the calldata and pool id above are still exact; the tx itself returns (poolId, cst, cpt)" });
    }
    if (shares.exists) {
      warnings.push({ code: "pool_already_exists", message: `the pool ${derived.poolId} already exists — the tx is a safe idempotent no-op: it re-runs the recipe checks, skips creation, and returns the existing (poolId, cst, cpt)` });
    } else {
      // Creation-only rules, checked only when this tx would actually CREATE: the registry's
      // expiry bound (INCLUSIVE) and a live oracle currently reporting a zero rate.
      const bound = await maxExpiryBoundWarning(client, mr.registry, expiryTimestamp, nowSecs);
      if (bound) warnings.push(bound);
      if (oracle.deployed && oracle.rate === 0n) {
        warnings.push({ code: "would_revert", message: "the rate oracle reports a ZERO rate right now — creating this pool would revert RateUnavailable (a pool is permanent; a dead rate source must not be baked in)" });
      }
    }
    const data = {
      ...baseData(constraint),
      source,
      oracle: { address: oracle.address, deployed: oracle.deployed, ...(oracle.mode ? { mode: oracle.mode } : {}), ...(oracle.rate !== null ? { rate: oracle.rate, rateScale: "ABSOLUTE, 1e18 = 1.0" } : {}) },
      pool: { poolId: derived.poolId, exists: shares.exists },
      ...(shares.cst || shares.cpt ? { shares: { corkSwapToken: shares.cst ?? null, corkPrincipalToken: shares.cpt ?? null, source: shares.status } } : {}),
    };
    return envelope({ state: "ok", data, chainId, source: "chain", warnings: [...rpcWarn(resolved), ...warnings], ctx });
  } catch (err) {
    if (!constraint) {
      return unavailable(chainId, "chain_read_failed", `the creator pre-flight reads failed (${revertReason(err)}) and no explicit constraint was supplied — the constraint comes from recipe.resolve and is PART OF THE CALLDATA, so the tx cannot be built. Retry, or pass \`constraint\` from cork_compute recipe-rate-constraint`, ctx);
    }
    warnings.push({ code: "chain_read_failed", message: `creator pre-flight reads failed (${revertReason(err)}) — the tx is built from the caller-supplied constraint but unverified` });
    return envelope({ state: "ok", data: baseData(constraint), chainId, source: "chain", warnings: [...rpcWarn(resolved), ...warnings], ctx });
  }
}
