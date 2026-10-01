// The CHAIN side of "which cover does this request buy" — everything cover.ts (pure) cannot say.
//
// cover.ts reads the request against itself, and names the KIND of cover from the configured
// recipe hint (chain-free, so it works offline). What the recipe ALLOWS, what window a pool
// created today is born with, whether the fill's own check accepts it, where a frozen rate sits
// against the reference's rate, and whether the reference keeps losses out of its share price
// are facts the chain owns, and the recipe's limits differ per generation (the
// phoenix/v0.4-rc.1 impairment recipe caps the spread and the duration; the phoenix/v0.3-rc.1
// one declares no such constants — read live on Base 2026-10-01). So no recipe limit is restated
// here: this module ASKS — `recipe.resolve` for the constraint, `recipe.verify` for the check the
// creating fill runs, the registry's deployed wrapper for the reference's rate, the vault for
// its loss counter — and reports each answer as what it is: the recipe's refusal, a fact about
// the oracle, or a read that did not happen.
//
// Every read is best-effort and none can throw: a request relayed to the venue binds nobody, so
// an RPC that is missing or failing never blocks it. What could not be read is LISTED
// (`notRead`), so a quiet result is never mistaken for a clean one. The readers below are shared
// by rfq-open (the requester's side) and answer-rfq (the underwriter's), so the two cannot word
// or classify the same fact differently.
import type { ChainId } from "@cork/schemas";
import type { ResolvedRpc } from "../chain/rpc.ts";
import { resolveGenerations, resolveMarketRegistry } from "../config-remote.ts";
import { classifyAddress, IMPLEMENTED_MARKET_REGISTRY_WIRES, type MarketRegistryWire, primaryOf } from "../generations.ts";
import { type CoverKind, type CoverReading, fixedRateInTheMoneyWarning, fixedRateMoneyness, INLINE_SCHEMA_COVER, type InlineRecipe, withFixedRateLiveRate, withResolvedConstraint } from "../cover.ts";
import { INLINE_IMPAIRMENT_SCHEMA, inlineAdditionalData, type InlineTemplateParams, inlineParamsOfTemplate, recipeAddressOfTemplate } from "../orders-answer.ts";
import { RECIPE_SOURCE, type RecipeSourceName, recipeAbi, type ResolvedConstraint } from "../market-registry.ts";
import { readUnreportedLoss, referenceLossReading, unreportedLossWarning } from "../chain/nav-loss.ts";
import { firstLine, getRpc, type HandlerContext, isTransportFailure, nowSecondsOf, ZERO_ADDR } from "./shared.ts";
import { previewRecipeVerify, readPairLiveRate, resolveRecipeOracleConstraint } from "./registry.ts";

type Warning = { code: string; message: string };
type Client = ResolvedRpc["client"];
type Side = "requester" | "underwriter";

/** A recipe's oracle source, asked of the recipe itself (`source()`): `fixed` is the one fact
 *  that decides whether an order carries a frozen rate or recipe bytes. A failed read is
 *  reported as a failure with its kind — a caller that treated it as "not fixed" would drop
 *  the rate. */
export async function readRecipeSource(client: Client, recipe: `0x${string}`): Promise<{ source: RecipeSourceName } | { error: string; transport: boolean }> {
  try {
    const ordinal = Number(await client.readContract({ address: recipe, abi: recipeAbi, functionName: "source" }));
    const source = RECIPE_SOURCE[ordinal];
    return source ? { source } : { error: `source() answered the unknown ordinal ${ordinal}`, transport: false };
  } catch (err) {
    return { error: firstLine(err), transport: isTransportFailure(err) };
  }
}

/** A recipe address classified chain-free against the configured recipe hints: which generation
 *  it belongs to and which hint names it. Undefined when no configured generation names it. */
export async function classifyRecipeAddress(chainId: number, address: `0x${string}`): Promise<{ recipe: InlineRecipe; status: string; primaryLabel: string | undefined } | undefined> {
  const { generations } = await resolveGenerations(chainId);
  const hit = classifyAddress(generations, address).find((c) => c.role === "recipe");
  if (hit === undefined) return undefined;
  return { recipe: { address, recipeName: hit.recipeName, generation: hit.label }, status: hit.status, primaryLabel: primaryOf(generations)?.label };
}

/** The inline template's `oracle_recipe`, classified: which generation the cover is created
 *  on. Info on the primary's recipe (named), info on another generation's (named, with the pass
 *  it invites), `recipe_not_found` info when no generation hints at the address — never a
 *  refusal: the registry's `isRecipe` is the authority. `address` is set whenever the template
 *  carries a well-formed address. */
export async function classifyInlineRecipe(chainId: number, marketTemplate: unknown): Promise<{ address?: `0x${string}`; recipe?: InlineRecipe; warnings: Warning[] }> {
  const address = recipeAddressOfTemplate(marketTemplate);
  if (address === undefined) return { warnings: [] };
  const hit = await classifyRecipeAddress(chainId, address);
  if (hit === undefined) {
    return { address, warnings: [{ code: "recipe_not_found", message: `the inline template's oracle_recipe ${address} matches no configured generation's recipe hints on chainId ${chainId} — an underwriter can only quote a recipe approved on its registry (cork_query resource:"registry-recipes" lists them per generation); relayed as asked` }] };
  }
  const { recipe, status, primaryLabel } = hit;
  const which = recipe.recipeName ? `${recipe.recipeName} recipe` : "recipe";
  if (primaryLabel !== undefined && recipe.generation !== primaryLabel) {
    return { address, recipe, warnings: [{ code: "recipe_generation_notice", message: `the inline template's oracle_recipe ${address} is the ${which} of the ${recipe.generation} generation (${status}), not the primary ${primaryLabel}: the cover is created on ${recipe.generation}, which only an adapter bound to that generation can fill or exercise, and an underwriter quoting the primary alone passes on this RFQ silently. Pass the primary's recipe from cork_query resource:"registry-recipes" if the adapter you fill through is bound to the primary` }] };
  }
  return { address, recipe, warnings: [{ code: "recipe_generation_notice", message: `the inline template's oracle_recipe ${address} is the ${which} of the primary ${recipe.generation} generation: the cover is created there, and the adapter you fill through must be bound to that generation's pool manager` }] };
}

/** Where a frozen rate sits against the reference's rate today, for the side reading it: the
 *  position (for the echo), the in-the-money warning when it applies, or why the comparison was
 *  not made. Never throws. */
export async function readFixedRatePosition(
  client: Client,
  registry: `0x${string}`,
  pair: { collateralAsset: `0x${string}`; referenceAsset: `0x${string}` },
  fixedRate: bigint,
  side: Side,
): Promise<{ live?: { rate: bigint; source: string; position: "below" | "at" | "above"; gapPercentage: bigint }; warning?: Warning; notRead?: string }> {
  try {
    const live = await readPairLiveRate(client, registry, pair.collateralAsset, pair.referenceAsset);
    if (live.status === "none") return { notRead: "the reference's rate today: the pair has no deployed nav or price oracle to compare the frozen rate with" };
    if (live.status === "unreadable") {
      const why = live.failure === "transport" ? "its rate() read failed in transport" : live.failure === "zero" ? "its rate() answers zero" : "its rate() reverts";
      return { notRead: `the reference's rate today: the pair's ${live.source} oracle ${live.oracle} is deployed and ${why} (${live.reason})` };
    }
    const m = fixedRateMoneyness(fixedRate, live.rate);
    const warning = fixedRateInTheMoneyWarning({ fixedRate, liveRate: live.rate, liveRateSource: live.source, side });
    return { live: { rate: live.rate, source: live.source, ...m }, ...(warning ? { warning } : {}) };
  } catch (err) {
    return { notRead: `the reference's rate today: ${firstLine(err)}` };
  }
}

/** The reference's unreported loss for a NAV-read pool, worded for the side reading it: the
 *  reading and its warning when the vault has the counter, nothing when it has no such view,
 *  and the reason when nobody could tell. Never throws. */
export async function readReferenceLoss(client: Client, reference: `0x${string}`, side: Side): Promise<{ reading?: ReturnType<typeof referenceLossReading>; warning?: Warning; notRead?: string }> {
  const loss = await readUnreportedLoss(client, reference);
  if (loss.status === "read") return { reading: referenceLossReading(loss.loss), warning: unreportedLossWarning(reference, loss.loss, side) };
  return loss.status === "unread" ? { notRead: `the reference's lost-assets counter: ${loss.reason}` } : {};
}

/** The recipe bytes an inline block lends a recipe: its own block's, and nothing when the block
 *  was written for another cover (those words are parameters this recipe does not read). `kind`
 *  undefined = the recipe's cover is not known, and the block's bytes ride as written. */
export function blockBytesFor(kind: CoverKind | undefined, params: InlineTemplateParams | undefined): `0x${string}` | undefined {
  return params !== undefined && blockIsRecipesOwn(kind, params) ? inlineAdditionalData(params) : undefined;
}

/** Whether an inline block is the parameter block of the recipe's cover (true when the cover
 *  is not known: nothing says otherwise). */
export function blockIsRecipesOwn(kind: CoverKind | undefined, params: InlineTemplateParams): boolean {
  return kind === undefined || INLINE_SCHEMA_COVER[params.schema] === kind;
}

/** Why a nested-wire impairment recipe rejects a constraint at creation, when the cause is the
 *  one this tool can see: a duration beyond the market's remaining life. MEASURED on the live
 *  phoenix/v0.4-rc.1 recipe at one block (Base, 2026-10-01): with `creating` true, `verify`
 *  returns FALSE — it does not revert — for a duration above expiry − now, accepts a duration
 *  equal to it, and accepts any duration with `creating` false. The creator turns that false
 *  into RecipeRejectedConstraint. A DIAGNOSIS for a rejection the chain reported (or, where
 *  verify cannot run yet, the one rule said ahead of it) — never the verdict itself. Undefined
 *  when the duration fits, is unknown, or the wire's verify takes no expiry (flat). */
export function durationBeyondLifeNote(wire: MarketRegistryWire, durationSeconds: bigint | undefined, lifeSeconds: bigint): string | undefined {
  if (wire !== "nested" || durationSeconds === undefined || durationSeconds <= lifeSeconds) return undefined;
  return `The carried duration ${durationSeconds} s exceeds the market's remaining life ${lifeSeconds} s, and that life shrinks until the fill: this generation's impairment recipe rejects such a constraint when the pool is created (measured on the live recipe). Carry a duration below the remaining life, with room for the time to fill`;
}

/** The single pair a request names: an `exact` collateral, or a `one_of` with one entry. */
export function singleCollateral(c: { exact: `0x${string}` } | { one_of: readonly `0x${string}`[] }): `0x${string}` | undefined {
  if ("exact" in c) return c.exact;
  return c.one_of.length === 1 ? c.one_of[0] : undefined;
}

interface ResolveStep {
  /** The recipe's source, when the resolver reached the recipe. */
  source?: RecipeSourceName;
  warnings: Warning[];
  notRead: string[];
}

/** recipe.resolve for the request, then recipe.verify for the pool the request's own block
 *  names — the two calls the creating fill runs. Each outcome is reported as what it is. */
async function resolveAndVerify(
  ctx: HandlerContext,
  chainId: ChainId,
  client: Client,
  registry: { registry: `0x${string}`; recipes?: Record<string, `0x${string}`> | undefined; wire: MarketRegistryWire },
  a: { cover: CoverReading; recipe: InlineRecipe; kind: CoverKind; collateralAsset: `0x${string}`; referenceAsset: `0x${string}`; params: InlineTemplateParams | undefined; fixedRate: bigint | undefined },
): Promise<ResolveStep> {
  const out: ResolveStep = { warnings: [], notRead: [] };
  const extraData = blockBytesFor(a.kind, a.params);
  let res: Awaited<ReturnType<typeof resolveRecipeOracleConstraint>>;
  try {
    res = await resolveRecipeOracleConstraint({ client, ctx, chainId, mr: registry, recipe: a.recipe.address, collateralAsset: a.collateralAsset, referenceAsset: a.referenceAsset, fixedRate: a.fixedRate, extraData, oracleSalt: a.params?.oracleSalt, wantConstraint: true });
  } catch (err) {
    out.notRead.push(`recipe.resolve: ${firstLine(err)}`);
    return out;
  }
  // A gate raised before the recipe's source was read carries a placeholder recipe.
  if (res.recipe !== ZERO_ADDR) out.source = res.source;
  if (res.gate) {
    const w = res.gate.warnings[0];
    const code = w?.code ?? "recipe_refused";
    const said = w?.message ?? res.gate.state;
    // Only the recipe's own refusal is a fact about the REQUEST. An endpoint that failed, or
    // cannot simulate, established nothing; an oracle fault is a fact about the pair.
    if (code === "chain_read_failed") out.notRead.push(`recipe.resolve: ${said}`);
    else if (code === "recipe_refused") out.warnings.push({ code, message: `the recipe does not resolve this request as written, so an underwriter that derives the pool from it fails the same way — ${said}` });
    else out.warnings.push({ code, message: `the request cannot be resolved against the chain as it stands today — ${said}` });
    return out;
  }
  if (!res.constraint) return out;
  const constraint: ResolvedConstraint = res.constraint;
  withResolvedConstraint(a.cover, {
    source: res.source,
    oracle: { address: res.oracle.address, deployed: res.oracle.deployed, rate: res.oracle.rate === null ? null : res.oracle.rate.toString() },
    constraint: { rateMin: constraint.rateMin.toString(), rateMax: constraint.rateMax.toString(), rateChangePerDayMax: constraint.rateChangePerDayMax.toString(), rateChangeCapacityMax: constraint.rateChangeCapacityMax.toString() },
  });
  // verify takes what resolve does not: the pool EXPIRY (on the nested wire) and the live
  // rate. It can only run against a deployed oracle, and only for a block that names its pool.
  // `false` is the recipe rejecting the constraint (the fill's RecipeRejectedConstraint); a
  // revert is the recipe's own error; a transport fault is neither.
  const expiry = a.params?.expiry;
  if (expiry === undefined || !res.oracle.deployed || res.oracle.address === null) return out;
  if (expiry <= nowSecondsOf(ctx)) return out; // cover.ts already named a past expiry
  const v = await previewRecipeVerify(client, registry.wire, { recipe: a.recipe.address, collateralAsset: a.collateralAsset, referenceAsset: a.referenceAsset, oracle: res.oracle.address, expiryTimestamp: expiry, creating: true, constraint, extraData: extraData ?? "0x" });
  if (v.status === "rejected") {
    const life = expiry - nowSecondsOf(ctx);
    const duration = a.params?.schema === INLINE_IMPAIRMENT_SCHEMA ? a.params.durationSeconds : undefined;
    out.warnings.push({ code: "would_revert", message: `recipe.verify REJECTS the constraint it resolved, for the pool the block names (expiry ${expiry}, being created): the fill that creates this pool reverts RecipeRejectedConstraint, so an underwriter's order for this request cannot be filled as written. ${durationBeyondLifeNote(registry.wire, duration, life) ?? "The recipe does not say why: read the block against the recipe's own description (cork_query registry-recipes)"}` });
  } else if (v.status === "reverted") out.warnings.push({ code: "would_revert", message: `the fill that CREATES this pool runs recipe.verify with the block's pool expiry ${expiry}, and it reverts: ${v.reason} — an underwriter's order for this request cannot be filled as written. Change what the recipe names` });
  else if (v.status === "unread") out.notRead.push(`recipe.verify: ${v.reason}`);
  return out;
}

/** Ask the chain about a classified cover reading and attach what it says: the recipe's own
 *  constraint and the creating fill's check (or the recipe's refusal, as a warning), a frozen
 *  rate's position against the reference's rate, and — for a NAV-sourced recipe only — the
 *  reference's unreported loss. Mutates `cover` and returns the warnings; never throws. */
export async function coverChainReadings(
  ctx: HandlerContext,
  chainId: ChainId,
  a: {
    cover: CoverReading;
    recipe: InlineRecipe;
    /** The pair's collateral when the request names exactly one (see `singleCollateral`). */
    collateralAsset: `0x${string}` | undefined;
    referenceAsset: `0x${string}`;
    marketTemplate: Record<string, unknown> | undefined;
    side: Side;
  },
): Promise<Warning[]> {
  const { cover } = a;
  const warnings: Warning[] = [];
  const notRead: string[] = [];
  const finish = (): Warning[] => {
    if (notRead.length > 0) cover.notRead = notRead;
    return warnings;
  };
  if (cover.kind === "unknown") return finish();
  let client: Client;
  let registry: NonNullable<Awaited<ReturnType<typeof resolveMarketRegistry>>["marketRegistry"]>;
  try {
    const rpc = await getRpc(ctx, chainId);
    if (!rpc) {
      notRead.push("no RPC resolved: the recipe was not asked and the reference was not read");
      return finish();
    }
    client = rpc.client;
    const mr = (await resolveMarketRegistry(chainId, undefined, a.recipe.generation)).marketRegistry;
    if (!mr || !IMPLEMENTED_MARKET_REGISTRY_WIRES.includes(mr.wire)) {
      notRead.push(`generation ${a.recipe.generation} has no registry this build can ask`);
      return finish();
    }
    registry = mr;
  } catch (err) {
    notRead.push(`the chain could not be reached: ${firstLine(err)}`);
    return finish();
  }
  const params = inlineParamsOfTemplate(a.marketTemplate);
  const fixedRate = cover.kind === "fixed-rate" && cover.fixed?.rateOverride ? BigInt(cover.fixed.rateOverride) : undefined;
  // A request with no rate (fixed) or no band (impairment) has nothing to resolve: cover.ts
  // already named what is missing, and the recipe's refusal would only repeat it.
  const resolvable = cover.kind === "liquidity" || (cover.kind === "impairment" && cover.band !== undefined) || fixedRate !== undefined;
  let source: RecipeSourceName | undefined;
  if (a.collateralAsset === undefined) {
    notRead.push("the collateral is one_of with several entries: no single pair to resolve the recipe against");
  } else if (resolvable) {
    const step = await resolveAndVerify(ctx, chainId, client, registry, { cover, recipe: a.recipe, kind: cover.kind, collateralAsset: a.collateralAsset, referenceAsset: a.referenceAsset, params, fixedRate });
    source = step.source;
    warnings.push(...step.warnings);
    notRead.push(...step.notRead);
  }
  // A frozen rate against the reference's rate today: above it, the cover pays at once.
  if (fixedRate !== undefined && a.collateralAsset !== undefined) {
    const p = await readFixedRatePosition(client, registry.registry, { collateralAsset: a.collateralAsset, referenceAsset: a.referenceAsset }, fixedRate, a.side);
    if (p.live) withFixedRateLiveRate(cover, p.live.rate, p.live.source);
    if (p.warning) warnings.push(p.warning);
    if (p.notRead) notRead.push(p.notRead);
  }
  // Only a NAV-sourced pool swaps at the vault's reported share price: a price-sourced pool
  // reads a market price and a fixed-rate pool reads no feed.
  if (source === undefined) {
    const read = await readRecipeSource(client, a.recipe.address);
    if ("source" in read) source = read.source;
    else notRead.push(`the recipe's source (${read.error}), so the reference's lost-assets counter was not asked`);
  }
  if (source === "nav") {
    const loss = await readReferenceLoss(client, a.referenceAsset, a.side);
    if (loss.reading) cover.referenceLoss = loss.reading;
    if (loss.warning) warnings.push(loss.warning);
    if (loss.notRead) notRead.push(loss.notRead);
  }
  return finish();
}

