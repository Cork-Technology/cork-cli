// Split from handlers.ts (2026-08-05): jit handlers — one typed dispatch, per-tool modules.
// Declarations are moved byte-identically; see handlers.ts for the runTool dispatch.
import { type ChainId, Envelope } from "@cork/schemas";
import { rateOracleAbi } from "../chain/abis.ts";
import { type LopOrder } from "../orders.ts";
import { buildDeployFixedRateOracleCall, decodeJitExtension, deriveJitMarket, diffJitExtraData, flattenNestedJitParams, jitAdapterAbi, jitAdapterNestedAbi, type JITMarketParams, marketCreatorNestedAbi, MAX_FEE_PERCENTAGE_FALLBACK, type PermitParams, predictShares, rateOverrideCoherence, readForeignSharePool, readRoleHolder, type ResolvedConstraint, wireCodec, ZERO_ORACLE_SALT } from "../market-registry.ts";
import { cachedContractConstant, refreshContractConstant } from "../chain/constants-cache.ts";
import * as legacyRegistry from "../market-registry-legacy.ts";
import { deprecatedEnabled, deprecatedGateMessage } from "../deprecation.ts";
import { resolveGenerations } from "../config-remote.ts";
import { marketRegistryForWire, type MarketRegistryWire, type PhoenixWire } from "../generations.ts";
import { poolManagerAbi } from "../chain/abis.ts";
import { approvedImplementationChecks, type ImplementationCheck, implementationRefusals, JIT_IMPLEMENTATION_ROLES, unapprovedCodeAllowed } from "../implementations.ts";
import { envelope, getDep, getMarketRegistry, getRpc, type HandlerContext, nowSecondsOf, revertReason, ToolInputError, unavailable } from "./shared.ts";
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

/** The fee rule of a phoenix wire, stated as the LARGEST ALLOWED value plus the rule in words.
 *  8-field: the registry stack's MAX_FEE_PERCENTAGE (5e18 = 5%, INCLUSIVE) — read live through
 *  the long-TTL constants cache where the adapter/creator expose the view, the compiled 5e18
 *  otherwise. 10-field: Phoenix v1.4.0-rc.1 reverts InvalidFees() at OR ABOVE 100e18 (100%),
 *  and NO contract of that generation exposes a cap view (facts D4) — so the largest allowed
 *  fee is 100e18 − 1 and nothing is ever refreshed for it. */
export interface FeeRule {
  maxAllowed: bigint;
  phoenixWire: PhoenixWire;
  /** The rule as the gate's teaching states it. */
  text: string;
}
export const TEN_FIELD_FEE_LIMIT_EXCLUSIVE = 100n * 10n ** 18n;

export async function resolveFeeRule(chainId: ChainId, capSource: "adapter" | "creator", ctx: HandlerContext = {}): Promise<FeeRule> {
  const { mr, phoenixWire } = await getMarketRegistry(ctx, chainId);
  if (phoenixWire === "10-field") {
    return { maxAllowed: TEN_FIELD_FEE_LIMIT_EXCLUSIVE - 1n, phoenixWire, text: "strictly below 100e18 (100%) — Phoenix v1.4.0-rc.1 reverts InvalidFees() at or above it; this generation exposes no MAX_FEE_PERCENTAGE view" };
  }
  const address = capSource === "creator" ? mr?.marketCreator : mr?.adapter;
  const cap = (address && mr?.wire === "flat" ? cachedContractConstant(chainId, address, "MAX_FEE_PERCENTAGE") : undefined) ?? MAX_FEE_PERCENTAGE_FALLBACK;
  return { maxAllowed: cap, phoenixWire: "8-field", text: `capped at ${capText(cap)} INCLUSIVE — the ${capSource}'s MAX_FEE_PERCENTAGE on this 8-field generation` };
}

/** The site's largest allowed fee as a plain number — resolveFeeRule's `maxAllowed` (kept for
 *  the call sites that only need the bound; the gate's wording comes from the rule). */
export async function resolveFeeCap(chainId: ChainId, capSource: "adapter" | "creator", ctx: HandlerContext = {}): Promise<bigint> {
  return (await resolveFeeRule(chainId, capSource, ctx)).maxAllowed;
}

const capText = (cap: bigint): string => (cap % 10n ** 18n === 0n ? `${cap / 10n ** 18n}e18 (${cap / 10n ** 18n}%)` : `${cap} (1e18 = 1%)`);

/** Value-domain gate shared by BOTH JIT builders (maker extension + taker interaction) AND the
 *  create-pool prepare: the protocol's fee rule and strictly-future expiry, in one place so a
 *  boundary rule can never drift between the paths. Returns the gate envelope, or undefined
 *  when the values pass. `feeRule` comes from resolveFeeRule (per phoenix wire); `capWei` is the
 *  bound alone (an inclusive cap, the pre-0.6 form); the default is the compiled fallback. */
export function jitValueGate(chainId: ChainId, ctx: HandlerContext, swapFee: bigint, unwindFee: bigint, expiryTimestamp: bigint, nowSecs: bigint, opts: { site?: ValueGateSite; capWei?: bigint; feeRule?: FeeRule } = {}): Envelope | undefined {
  const site = opts.site ?? JIT_VALUE_SITE;
  const cap = opts.feeRule?.maxAllowed ?? opts.capWei ?? MAX_FEE_PERCENTAGE_FALLBACK;
  if (swapFee > cap || unwindFee > cap) {
    const rule = opts.feeRule?.text ?? `capped at ${capText(cap)}`;
    return unavailable(chainId, "invalid_order_terms", `${site.fees} are 1e18 = 1% and ${rule} — this value would revert at pool creation`, ctx);
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

/** The recipe-bytes + oracle-salt inputs of EVERY JIT block — the registry jitMarket, create-pool
 *  AND the rollover jitMarket — resolved by ONE rule (2026-09-22, review B2: the rollover branch
 *  had its own alias check with the opposite canonical name, no deprecation notice, a different
 *  refusal class, and a presence test that let an explicit "0x" hide a conflicting alias):
 *  `extraData` is the input name (the 0.5.0 contracts' word); `additionalData` is accepted as a
 *  deprecated alias — both present and DIFFERENT is two payloads and refuses (invalid input
 *  naming both; an explicit "0x" COUNTS as present), both equal is fine, the alias alone is
 *  accepted with an info deprecation_notice. `site.bytesField` is the name the target wire's OWN
 *  struct gives the member (`WireCodec.bytesField`; `additionalData` for the rollover
 *  BaseFiller) — it rides in the teaching and is what the typed-data OUTPUT shows; it never
 *  changes which input name is canonical. `oracleSalt` defaults to the zero salt (the pair's
 *  default wrapper); with a registry `wire`, a NON-ZERO salt on a flat/legacy generation refuses
 *  with teaching — that wire has no field for it, so the bytes could only drop it silently.
 *  `wire: undefined` skips that gate (the rollover hash applies its own per-rollover-wire rule);
 *  `saltGiven` tells the caller whether the salt was the caller's or the default. */
export function resolveJitBytesInput(
  jm: { extraData?: `0x${string}` | undefined; additionalData?: `0x${string}` | undefined; oracleSalt?: `0x${string}` | undefined },
  wire: MarketRegistryWire | undefined,
  generationLabel: string | undefined,
  site: { tool: string; path: string[]; bytesField?: "additionalData" | "extraData" },
  warnings: Array<{ code: string; message: string }>,
): { extraData: `0x${string}`; oracleSalt: `0x${string}`; saltGiven: boolean } {
  const member = site.bytesField ?? "extraData";
  if (jm.extraData !== undefined && jm.additionalData !== undefined && jm.extraData.toLowerCase() !== jm.additionalData.toLowerCase()) {
    throw new ToolInputError(site.tool, [{ path: [...site.path, "extraData"], message: `extraData (${jm.extraData}) and additionalData (${jm.additionalData}) are two spellings of the SAME recipe bytes (the target struct's \`${member}\` member) and they differ — pass one (extraData is the input name; additionalData is the deprecated alias)` }]);
  }
  if (jm.extraData === undefined && jm.additionalData !== undefined) {
    warnings.push({ code: "deprecation_notice", message: `${site.path.join(".")}.additionalData is the deprecated input spelling of extraData (the market-registry 0.5.0 contracts renamed the recipe-bytes member${member === "additionalData" ? "; the target struct itself still names it additionalData, and the typed-data output keeps that name" : "; the 0.3.x wire still writes it as additionalData"}) — accepted, pass extraData in new calls` });
  }
  const extraData = (jm.extraData ?? jm.additionalData ?? "0x") as `0x${string}`;
  const saltGiven = jm.oracleSalt !== undefined;
  const oracleSalt = (jm.oracleSalt ?? ZERO_ORACLE_SALT) as `0x${string}`;
  if (wire !== undefined && wire !== "nested" && !/^0x0*$/i.test(oracleSalt)) {
    throw new ToolInputError(site.tool, [{ path: [...site.path, "oracleSalt"], message: `oracleSalt ${oracleSalt} is non-zero, but generation '${generationLabel ?? "?"}' speaks the '${wire}' registry wire, whose deploy(ca, ref, mode) / MarketParams carry NO oracle salt — the value would be dropped, not honoured. Omit it (or pass the zero salt), or target a nested-wire generation (the phoenix/v0.4-rc.1 primary)` }]);
  }
  return { extraData, oracleSalt, saltGiven };
}

/** Best-effort maxExpiryDuration bound check (the creator/adapter/BaseFiller creation rule:
 *  expiry <= now + registry.maxExpiryDuration(), INCLUSIVE). The bound is a registry constant,
 *  so it rides the long-TTL constants cache: a fresh cached value costs no read, a stale one
 *  refreshes through the client. Emits would_revert with the date the market becomes
 *  creatable; silent when no value is obtainable or the bound passes. The bound applies only
 *  to a call that CREATES the pool — callers gate on existence where they know it. */
export async function maxExpiryBoundWarning(
  client: Parameters<typeof readRoleHolder>[0],
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
      /** The market creator (nested wire: the role holder and the contract the adapter delegates
       *  creation to; flat: the periphery creator, unused by the fill). */
      marketCreator?: `0x${string}` | undefined;
      /** The registry wire the bytes are encoded for, and the pool-manager width the id follows. */
      wire: MarketRegistryWire;
      phoenixWire: PhoenixWire;
      /** The generation the adapter/registry pair came from (dep, guard scope and shares follow it). */
      generation?: { label: string };
      recipe: `0x${string}`;
      rateOverride: bigint;
      extraData: `0x${string}`;
      oracleSalt: `0x${string}`;
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
    extraData?: `0x${string}` | undefined;
    additionalData?: `0x${string}` | undefined;
    oracleSalt?: `0x${string}` | undefined;
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
  const swapFee = BigInt(jm.swapFeePercentage);
  const unwindFee = BigInt(jm.unwindSwapFeePercentage);
  const { mr, mrWarn, generation: mrGeneration, phoenixWire: phoenixWireResolved, refusal: mrRefusal } = await getMarketRegistry(ctx, chainId);
  if (mrRefusal) return { gate: unavailable(chainId, mrRefusal.code, mrRefusal.message, ctx) };
  if (!mr?.adapter) {
    return { gate: unavailable(chainId, "unknown_deployment", `no JIT CorkLimitOrderAdapter configured for chainId ${chainId} — ${words.live} are live on Arbitrum One and Base (42161, 8453)`, ctx) };
  }
  warnings.push(...mrWarn);
  // The codec follows the generation's DECLARED registry wire; the pool-id width follows its
  // phoenix wire (nested registries create on 10-field managers, but the two are separate
  // declarations and a config may pair them otherwise — the id must follow the manager).
  const codec = wireCodec(mr.wire);
  const wire = codec.wire;
  // The pool-id width is DECLARED by the generation's phoenix block, never inferred from the
  // registry wire (the pre-0.6 `nested → 10-field` guess: review A2, 2026-09-22 — a generation
  // carrying a registry block but no phoenix block has no pool manager to create on, and a
  // guessed width derives an id no fill produces, OrderNotForPool on chain).
  if (phoenixWireResolved === undefined) {
    return { gate: unavailable(chainId, "unknown_deployment", `generation '${mrGeneration?.label ?? "?"}' declares no phoenix block; the pool id width is unknown, so no ${words.artifact} can be derived against it — refresh cork-defaults.v2.json or target a generation whose phoenix block is configured`, ctx) };
  }
  const phoenixWire: PhoenixWire = phoenixWireResolved;
  const { extraData, oracleSalt } = resolveJitBytesInput(jm, wire, mrGeneration?.label, { tool: "cork_prepare_orders", path: ["action", "jitMarket"], bytesField: codec.bytesField }, warnings);
  if (wire === "nested" && !mr.marketCreator) {
    return { gate: unavailable(chainId, "unknown_deployment", `generation '${mrGeneration?.label}' speaks the nested registry wire but configures no CorkMarketCreator — on that wire the adapter delegates pool creation to the creator (and the creator holds the controller role), so no ${words.artifact} can be pre-flighted; refresh cork-defaults.v2.json`, ctx) };
  }
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
  let constraint: ResolvedConstraint | undefined = jm.constraint
    ? { rateMin: BigInt(jm.constraint.rateMin), rateMax: BigInt(jm.constraint.rateMax), rateChangePerDayMax: BigInt(jm.constraint.rateChangePerDayMax), rateChangeCapacityMax: BigInt(jm.constraint.rateChangeCapacityMax) }
    : undefined;
  const base = { adapter: mr.adapter, registry: mr.registry, marketCreator: mr.marketCreator, wire, phoenixWire, ...(mrGeneration ? { generation: { label: mrGeneration.label } } : {}), recipe, rateOverride, extraData, oracleSalt, warnings } as const;

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
    const impl = await approvedImplementationChecks(client, chainId, { roles: JIT_IMPLEMENTATION_ROLES, ...(mrGeneration ? { generation: mrGeneration.label } : {}), ...(ctx.atBlock !== undefined ? { atBlock: ctx.atBlock } : {}) });
    warnings.push(...impl.warnings);
    const gate = bytesDecoderGate({ checks: impl.checks, roles: ["jitAdapter"], chainId, ctx, artifact: words.artifact, adapterName: "JIT adapter" });
    if (gate.gate) return { gate: gate.gate };
    warnings.push(...gate.warnings);
  }
  try {
    // The binding chain per wire. Flat: the adapter itself binds LOP / registry / controller.
    // Nested: the adapter binds LOP / pool manager / MARKET CREATOR, and the creator binds the
    // registry / controller / pool manager — every link is read and compared, because a
    // creator from another generation would put the recipe checks on one registry and the
    // creation on another pool manager (the cross-generation class the guard exists for).
    const { dep: jitDep } = await getDep(ctx, chainId, { ...(mrGeneration ? { generation: mrGeneration.label } : {}) });
    let boundController: `0x${string}`;
    let roleHolder: `0x${string}`;
    if (wire === "flat") {
      const [boundLop, boundRegistry, controller] = await Promise.all([
        client.readContract({ address: mr.adapter, abi: jitAdapterAbi, functionName: "LIMIT_ORDER_PROTOCOL" }),
        client.readContract({ address: mr.adapter, abi: jitAdapterAbi, functionName: "MARKET_REGISTRY" }),
        client.readContract({ address: mr.adapter, abi: jitAdapterAbi, functionName: "CONTROLLER" }),
      ]);
      if (boundLop.toLowerCase() !== lop.toLowerCase() || boundRegistry.toLowerCase() !== mr.registry.toLowerCase()) {
        return { gate: envelope({ state: "conflict", data: { adapter: mr.adapter, expected: { lop, registry: mr.registry }, onChain: { lop: boundLop, registry: boundRegistry } }, chainId, source: "chain", warnings: [{ code: "adapter_binding_mismatch", message: `the configured JIT adapter's on-chain bindings do not match this tool's LOP/registry config — a stale/previous-generation address (the old registry answers 2.1.0 calls with misdecoded garbage); refresh cork-defaults.v2.json before ${words.act} anything` }], ctx }) };
      }
      boundController = controller;
      roleHolder = mr.adapter;
      // Opportunistic cache refresh for the fee cap the value gate consumed earlier this call
      // (and will consume next call): a contract constant, one read per TTL — flat wire only,
      // the nested stack exposes no such view (facts D4).
      await refreshContractConstant(client, chainId, mr.adapter, "MAX_FEE_PERCENTAGE");
    } else {
      const creator = mr.marketCreator!;
      const [boundLop, adapterPm, boundCreator, creatorRegistry, creatorController, creatorPm] = await Promise.all([
        client.readContract({ address: mr.adapter, abi: jitAdapterNestedAbi, functionName: "LIMIT_ORDER_PROTOCOL" }),
        client.readContract({ address: mr.adapter, abi: jitAdapterNestedAbi, functionName: "POOL_MANAGER" }),
        client.readContract({ address: mr.adapter, abi: jitAdapterNestedAbi, functionName: "MARKET_CREATOR" }),
        client.readContract({ address: creator, abi: marketCreatorNestedAbi, functionName: "MARKET_REGISTRY" }),
        client.readContract({ address: creator, abi: marketCreatorNestedAbi, functionName: "CONTROLLER" }),
        client.readContract({ address: creator, abi: marketCreatorNestedAbi, functionName: "POOL_MANAGER" }),
      ]);
      const lc = (a: string) => a.toLowerCase();
      const pmMismatch = lc(adapterPm) !== lc(creatorPm) || (jitDep?.poolManager !== undefined && lc(creatorPm) !== lc(jitDep.poolManager));
      if (lc(boundLop) !== lc(lop) || lc(boundCreator) !== lc(creator) || lc(creatorRegistry) !== lc(mr.registry) || pmMismatch) {
        return { gate: envelope({ state: "conflict", data: { adapter: mr.adapter, marketCreator: creator, expected: { lop, marketCreator: creator, registry: mr.registry, ...(jitDep?.poolManager ? { poolManager: jitDep.poolManager } : {}) }, onChain: { lop: boundLop, marketCreator: boundCreator, registry: creatorRegistry, adapterPoolManager: adapterPm, creatorPoolManager: creatorPm, controller: creatorController } }, chainId, source: "chain", warnings: [{ code: "adapter_binding_mismatch", message: `the configured nested-wire JIT adapter's binding chain does not close: adapter.LIMIT_ORDER_PROTOCOL / adapter.MARKET_CREATOR / creator.MARKET_REGISTRY / the pool manager both bind must equal this tool's config for generation '${mrGeneration?.label}' — a stale or cross-generation address; refresh cork-defaults.v2.json before ${words.act} anything` }], ctx }) };
      }
      boundController = creatorController;
      roleHolder = creator;
    }
    // The controller role is held by the wire's ROLE HOLDER: the adapter (flat) or the creator
    // (nested — the adapter holds none; verified live 2026-09-22). A 10-field controller has no
    // fee authority, so POOL_CREATOR alone is the requirement there.
    const holderRoles = await readRoleHolder(client, boundController, roleHolder, { chainId, phoenixWire });
    if (!holderRoles.granted) {
      warnings.push({ code: "roles_not_granted", message: `the ${codec.roleHolder === "creator" ? "market creator (the contract the adapter delegates pool creation to)" : "adapter"} is missing controller roles (POOL_CREATOR: ${holderRoles.hasCreator}${phoenixWire === "10-field" ? "" : `, ${holderRoles.secondRole}: ${holderRoles.hasSecond}`}) — a fill through it will revert until granted (a governance action, not a code change)${words.rolesTail}` });
    }
    const res = await resolveRecipeOracleConstraint({ client, ctx, chainId, mr, recipe, collateralAsset: jm.collateralAsset, referenceAsset: jm.referenceAsset, fixedRate: rateOverride > 0n ? rateOverride : undefined, extraData, oracleSalt, wantConstraint: false });
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
      const c = await staticResolveConstraint(client, ctx, chainId, { recipe, collateralAsset: jm.collateralAsset, referenceAsset: jm.referenceAsset, oracle, extraData, wire });
      if ("gate" in c) return { gate: c.gate };
      constraint = c.constraint;
    }
    if (oracle.address === null) {
      return { gate: unavailable(chainId, "oracle_not_deployable", `the recipe's oracle cannot be resolved (${oracle.reason ?? "pair not deployable as-registered"}) — a fill would revert; check cork_query registry-assets / registry-oracle`, ctx) };
    }
    // Identity first: the nested verify takes `creating` — whether THIS fill creates the pool —
    // which needs the derived id and an existence read (shares(poolId) on the generation's pool
    // manager does not revert for an unknown pool; a non-zero cST means it exists).
    const derived = deriveJitMarket({ collateralAsset: jm.collateralAsset, referenceAsset: jm.referenceAsset, expiryTimestamp, constraint, oracle: oracle.address, wire: phoenixWire, swapFeePercentage: swapFee, unwindSwapFeePercentage: unwindFee });
    let creating = true;
    if (jitDep?.poolManager) {
      try {
        const [, cst] = await client.readContract({ address: jitDep.poolManager, abi: poolManagerAbi, functionName: "shares", args: [derived.poolId] });
        creating = cst.toLowerCase() === "0x0000000000000000000000000000000000000000";
      } catch {
        /* unknown existence → the creating-case rules are the stricter preview */
      }
    }
    // Verify pre-flight — the exact staticcall the fill runs (step 4), on the wire's arg order
    // (nested: expiry + creating before the constraint). Only meaningful against a DEPLOYED
    // oracle: the liquidity recipe checks the LIVE rate sits inside the window, so a predicted
    // oracle can't answer yet (the fill deploys it first).
    if (oracle.deployed) {
      const ok = await codec.verify(client, { recipe, collateralAsset: jm.collateralAsset, referenceAsset: jm.referenceAsset, oracle: oracle.address, expiryTimestamp, creating, constraint, extraData }).catch(() => null);
      if (ok === false) {
        warnings.push({ code: "would_revert", message: "recipe.verify REJECTS this constraint against the live oracle right now — the fill would revert RecipeRejectedConstraint (the constraint is stale, or was never one this recipe would produce). Re-resolve it (cork_compute recipe-rate-constraint) and rebuild" });
      } else if (ok === null) {
        if (oracle.rateError && oracle.rateReadFailure !== "transport") warnings.push({ code: "oracle_rate_unreadable", message: oracleRateUnreadableMessage(oracle.address, oracle.rateError, "recipe.verify read it and failed the same way, and the fill will too.") });
        else warnings.push({ code: "chain_read_failed", message: "the recipe.verify pre-flight read failed — the fill's constraint check could not be previewed" });
      }
    } else {
      warnings.push({ code: "oracle_not_deployed", message: `the recipe's oracle is not deployed yet (predicted ${oracle.address}) — the fill deploys it automatically${wire === "nested" ? ` (with oracleSalt ${oracleSalt})` : ""}, then recipe.verify re-checks the carried constraint against the LIVE rate. The pool id below assumes the predicted oracle address; re-registering the pair's sources before the fill would shift it and revert OrderNotForPool` });
    }
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
  const { recipe, rateOverride, extraData, oracleSalt, constraint, warnings, wire, phoenixWire } = ladder;
  const codec = wireCodec(wire);
  let jit: TakerJitReport = { adapter: ladder.adapter, hook: "takerInteraction (taker-side — always mints)", recipe, wire, ...(ladder.generation ? { generation: ladder.generation.label } : {}) };

  if (ladder.verified) {
    const { client, boundController, source, oracle, derived } = ladder.verified;
    jit = { ...jit, source, oracle: { address: oracle.address, deployed: oracle.deployed }, derivedPoolId: derived.poolId, constraint };
    try {
      // Consistency with the MAKER's signed intent: a resting order carrying its own JIT
      // extension pins the market the maker signed for — the taker's params must re-derive it.
      // Decoded on the LADDER's wire, and only when the extension targets the same adapter: a
      // hook at another generation's adapter is a different codec (and a different fight).
      if (args.orderExtension && args.orderExtension !== "0x") {
        try {
          const makerJit = decodeJitExtension(wire, args.orderExtension);
          if (makerJit.adapter.toLowerCase() !== ladder.adapter.toLowerCase()) throw new Error("the resting order's JIT hook targets another adapter");
          const makerDerived = deriveJitMarket({ collateralAsset: makerJit.params.collateralAsset, referenceAsset: makerJit.params.referenceAsset, expiryTimestamp: makerJit.params.expiryTimestamp, constraint: makerJit.params.constraint, oracle: oracle.address, wire: phoenixWire, swapFeePercentage: makerJit.params.swapFeePercentage, unwindSwapFeePercentage: makerJit.params.unwindSwapFeePercentage });
          if (makerDerived.poolId !== derived.poolId) {
            return { gate: envelope({ state: "conflict", data: { takerDerivedPoolId: derived.poolId, makerDerivedPoolId: makerDerived.poolId }, chainId, source: "chain", warnings: [{ code: "marketid_mismatch", message: "the taker's jitMarket params derive a DIFFERENT pool id than the resting order's own JIT extension — the two hooks would target different markets and the fill would revert OrderNotForPool. Copy the params from `ch decode order` (jit label) of the resting order" }], ctx }) };
          }
        } catch {
          /* the order's extension is not a JIT payload (e.g. Fusion) — nothing to cross-check */
        }
      }
      // The pool manager of the SAME generation the adapter belongs to (dep and mr are one set).
      const { dep: jitDep } = await getDep(ctx, chainId, { ...(ladder.generation ? { generation: ladder.generation.label } : {}) });
      const preCalls: Array<{ to: `0x${string}`; data: `0x${string}` }> = [];
      if (!oracle.deployed) {
        preCalls.push({ to: ladder.registry, data: source === "fixed" ? buildDeployFixedRateOracleCall(rateOverride) : codec.deployCall(jm.collateralAsset, jm.referenceAsset, oracle.mode ?? "price", oracleSalt) });
      }
      // A generation with a registry block but no phoenix block has no pool manager to create on
      // — a refusal naming the set, not a warning that lets bytes ride (review A2, 2026-09-22;
      // the ladder's own phoenix-wire gate makes this unreachable, kept as the second tripwire).
      if (jitDep?.poolManager === undefined) {
        return { gate: unavailable(chainId, "unknown_deployment", `generation '${ladder.generation?.label ?? "?"}' declares no phoenix block; the pool id width is unknown and no pool manager exists to predict the cST on — refresh cork-defaults.v2.json`, ctx) };
      } else {
        // The simulation runs AS the wire's role holder (the account the override grants).
        const pred = await predictShares(client, { adapter: codec.roleHolder === "creator" ? ladder.marketCreator! : ladder.adapter, controller: boundController, poolManager: jitDep.poolManager, market: derived.market, poolId: derived.poolId, wire: phoenixWire, unwindSwapFeePercentage: unwindFee, swapFeePercentage: swapFee, preCalls, chainId });
        if (pred.status === "unavailable") {
          warnings.push({ code: "share_prediction_unavailable", message: `could not predict the pool's cST — ${pred.reason ?? "no reason recorded"}. VERIFY yourself that one side of the RESTING order is the derived pool's cST, or the fill reverts OrderNotForPool; a REVERT named here means the fill's own creation leg would revert the same way` });
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
  const jitParams: JITMarketParams = { collateralAsset: jm.collateralAsset, referenceAsset: jm.referenceAsset, expiryTimestamp, recipe, rateOverride, constraint, extraData, oracleSalt, swapFeePercentage: swapFee, unwindSwapFeePercentage: unwindFee, enableJitMint: jm.enableJitMint };
  const hookBytes = codec.encodeExtraData(jitParams, permits);
  if (ladder.verified) {
    const layout = await verifyExtraDataLayout({ client: ladder.verified.client, adapter: ladder.adapter, wire, extraData: hookBytes, params: jitParams, permits, chainId, ctx, artifact: "interaction" });
    if ("gate" in layout) return { gate: layout.gate };
    jit.extraDataLayout = layout.status;
  }
  const interaction = `0x${ladder.adapter.slice(2)}${hookBytes.slice(2)}` as `0x${string}`;
  return { interaction, jit, warnings };
}


/** Taker-side JIT report echoed in `data.jit`. The base triple always rides; the verified half
 *  is filled only when an RPC resolved and the pre-flights ran (degrades with a
 *  funding_needs_rpc warning otherwise). */
export type TakerJitReport = {
  adapter: `0x${string}`;
  hook: string;
  recipe: `0x${string}`;
  /** The registry wire the interaction bytes are encoded for + the generation it targets. */
  wire?: MarketRegistryWire;
  generation?: string;
  /** Decode round-trip: what the adapter's own decodeExtraData read back from the bytes we built. */
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
  // The legacy lane is the generation whose marketRegistry block declares `wire: "legacy"`
  // (generations.ts) — there is no separate legacy config block since 0.6.
  const { generations, warning: mrWarn } = await resolveGenerations(chainId);
  const legacyGen = marketRegistryForWire(generations, "legacy");
  const mr = legacyGen?.marketRegistry;
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
  // The deprecated lane is held to the same standard as the current one: the same two roles,
  // resolved INSIDE the legacy generation (its registry and adapter hashes are on the shared
  // per-role allowlist), so a swapped implementation warns here too.
  {
    const impl = await approvedImplementationChecks(client, chainId, { roles: JIT_IMPLEMENTATION_ROLES, generation: legacyGen!.label, ...(ctx.atBlock !== undefined ? { atBlock: ctx.atBlock } : {}) });
    warnings.push(...impl.warnings);
    const gate = bytesDecoderGate({ checks: impl.checks, roles: ["jitAdapter"], chainId, ctx, artifact: "extension", adapterName: "legacy JIT adapter" });
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
      return { gate: envelope({ state: "conflict", data: { adapter: mr.adapter, expected: { lop, registry: mr.registry }, onChain: { lop: boundLop, registry: boundRegistry } }, chainId, source: "chain", warnings: [{ code: "adapter_binding_mismatch", message: "the LEGACY JIT adapter's on-chain bindings do not match this tool's legacy config — refresh cork-defaults.v2.json before signing anything" }], ctx }) };
    }
    const adapterRoles = await readRoleHolder(client, boundController, mr.adapter, { creator: legacyRegistry.POOL_CREATOR_ROLE, second: legacyRegistry.CONFIGURATOR_ROLE, secondLabel: "CONFIGURATOR" });
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

// ── The bytes-decoder gate (finding 2026-09-03) ────────────────────────────────
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
        message: `${describe(c)}. The ${a.adapterName} DECODES the extraData this tool encodes — a \`bytes\` layout no ABI describes — so code this build never tested against could read these bytes as a different market or a different fee, silently. No ${a.artifact} was built. If the address moved ahead of a release and you have verified the new code yourself, set CORK_ALLOW_UNAPPROVED_CODE=1 (CLI --allow-unapproved-code) to build anyway; every such result is labeled implementation_gate_bypassed`,
      })),
      ctx: a.ctx,
    }),
  };
}

/** The decode round-trip: hand the bytes we built to the adapter's own `decodeExtraData` and
 *  compare what it read back, field for field, with what we meant. Verified = the deployed
 *  decoder agrees on every field; unchecked = the adapter exposes no helper (pre-0.4.0) or the
 *  read failed, said in words, never guessed; a disagreement is a conflict with no bytes — the
 *  exact failure class the finding describes, caught before anyone signs. The helper's RETURN
 *  layout differs per wire under one selector (flat: the 10-member flat struct with the bytes
 *  named additionalData; nested: the (MarketParams, enableJitMint) wrapper) — read with the
 *  wire's ABI and normalized through the codec's own unwrapper, never by shape-guessing. */
export async function verifyExtraDataLayout(a: {
  client: { readContract: (args: { address: `0x${string}`; abi: typeof jitAdapterAbi | typeof jitAdapterNestedAbi; functionName: "decodeExtraData"; args: [`0x${string}`] }) => Promise<unknown> };
  adapter: `0x${string}`;
  wire: MarketRegistryWire;
  extraData: `0x${string}`;
  params: JITMarketParams;
  permits: readonly PermitParams[];
  chainId: ChainId;
  ctx: HandlerContext;
  artifact: string;
}): Promise<{ status: string } | { gate: Envelope }> {
  let decoded: { params: JITMarketParams; permits: PermitParams[] };
  try {
    if (a.wire === "nested") {
      const out = (await a.client.readContract({ address: a.adapter, abi: jitAdapterNestedAbi, functionName: "decodeExtraData", args: [a.extraData] })) as Parameters<typeof flattenNestedJitParams>[0];
      decoded = flattenNestedJitParams(out);
    } else {
      const out = (await a.client.readContract({ address: a.adapter, abi: jitAdapterAbi, functionName: "decodeExtraData", args: [a.extraData] })) as readonly [JITMarketParams & { additionalData: `0x${string}` }, readonly PermitParams[]];
      const { additionalData, ...rest } = out[0];
      decoded = { params: { ...rest, extraData: additionalData, constraint: { ...out[0].constraint } }, permits: out[1].map((p) => ({ ...p })) };
    }
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
      warnings: [{ code: "extra_data_layout_mismatch", message: `the deployed adapter's decodeExtraData read the extraData this tool encoded DIFFERENTLY on ${differing.join(", ")} — the bytes layout this build encodes is not the layout the adapter at ${a.adapter} decodes (a \`bytes\` layout change the ABI cannot show). No ${a.artifact} was built: a fill would create or mint against a market other than the one you meant. Update cork-cli to a build that targets this adapter generation` }],
      ctx: a.ctx,
    }),
  };
}

const jsonSafe = (v: unknown): unknown => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x)));
