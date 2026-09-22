// cork_prepare_orders answer-rfq + refresh-order — the underwriter's two most frequent moves as one
// call each. Split from prepare-orders.ts (2026-09-03). Both re-enter the maker-order path through
// injected deps (`prepare` = handlePrepareOrders, `annotateApprovals` = its approval annotator), so
// this module has no import cycle with the dispatcher.
import { ORDERS_TOPIC_REFERENCE, UNITS_TOPIC_REFERENCE, Envelope, executionAnswerRfq, executionRefreshOrder, PrepareOrdersInput } from "@cork/schemas";
import { buildMakerOrder, classifyInvalidatorWord, decodeMakerTraits, hashLopOrder, LOP_ADDRESSES, lopInvalidatorPlan, readLopInvalidator } from "../orders.ts";
import { type ApprovalRequirement, approvalMissingWarning, makerApprovalRequirements } from "../order-approvals.ts";
import { getLopOrderbook, getRfq, parseSignedLopOrder } from "../datasources/venue.ts";
import { erc20Abi } from "../chain/abis.ts";
import { answerOcoGroup, coverMakingAmount, impliedPremiumWad, INLINE_IMPAIRMENT_SCHEMA, inlineAdditionalData, inlineParamsOfTemplate, premiumAmount, premiumFraction, reRestExpirySeconds, type InlineTemplateParams } from "../orders-answer.ts";
import { chainReadFailed, envelope, getRpc, type HandlerContext, nowSecondsOf, revertReason, ToolInputError, unavailable, venueDepsOf, venueFailed } from "./shared.ts";
import { collectVenuePages, handleQuery } from "./query.ts";
import { authenticateSignedOrder } from "./order-auth.ts";

type MakerOrderAction = Extract<PrepareOrdersInput["action"], { type: "maker-order" }>;

/** What the sugars borrow from the dispatcher, handed in rather than imported. */
export interface SugarDeps {
  prepare: (input: PrepareOrdersInput, ctx: HandlerContext) => Promise<Envelope>;
  annotateApprovals: (ctx: HandlerContext, chainId: PrepareOrdersInput["chainId"], entries: ApprovalRequirement[]) => Promise<ApprovalRequirement[]>;
}

// ── answer-rfq: the underwriter's every-RFQ sequence as ONE call (the underwriter use cases U1/U4) ──
// Reads the RFQ (and the cited option) from the venue, derives the pool the cover creates on fill,
// computes the kernel's amounts, and re-enters the maker-order path with the derived action — so
// every pre-flight, approval, JIT and auction rule the maker-order path applies is applied here
// too, by the same code. Nothing here picks a premium: the option's, or the caller's.
type AnswerRfqAction = Extract<PrepareOrdersInput["action"], { type: "answer-rfq" }>;
type RefreshOrderAction = Extract<PrepareOrdersInput["action"], { type: "refresh-order" }>;

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : typeof v === "number" ? String(v) : undefined);
const isAddr = (v: unknown): v is `0x${string}` => typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v);
const recipeOfTemplate = (t: unknown): `0x${string}` | undefined => {
  if (!t || typeof t !== "object") return undefined;
  const inline = (t as { inline?: unknown }).inline;
  const r = inline && typeof inline === "object" ? (inline as { oracle_recipe?: unknown }).oracle_recipe : undefined;
  return isAddr(r) ? r : undefined;
};


/** The venue's answers embed: `answers[]` rows, each `{ answer_id, underwriter, answer: { status, options[] } }` (or flat). */
function findRfqOption(rfq: Record<string, unknown>, answerId: string, optionId: string): { answer: Record<string, unknown>; option: Record<string, unknown> } | "no-answer" | "no-option" {
  const answers = Array.isArray(rfq.answers) ? (rfq.answers as unknown[]) : [];
  const answer = answers.find((a) => a && typeof a === "object" && String((a as { answer_id?: unknown }).answer_id) === answerId) as Record<string, unknown> | undefined;
  if (!answer) return "no-answer";
  const inner = (answer.answer && typeof answer.answer === "object" ? answer.answer : answer) as Record<string, unknown>;
  const options = Array.isArray(inner.options) ? (inner.options as unknown[]) : [];
  const option = options.find((o) => o && typeof o === "object" && String((o as { option_id?: unknown }).option_id) === optionId) as Record<string, unknown> | undefined;
  return option ? { answer, option } : "no-option";
}

export async function handleAnswerRfq(input: PrepareOrdersInput, action: AnswerRfqAction, ctx: HandlerContext, sugar: SugarDeps): Promise<Envelope> {
  const chainId = input.chainId;
  const lop = LOP_ADDRESSES[chainId];
  if (!lop) return unavailable(chainId, "no_lop", `no known 1inch LOP v4 deployment for chainId ${chainId}`, ctx);
  const nowSecs = nowSecondsOf(ctx);
  const cited = action.answerId !== undefined || action.optionId !== undefined;
  if (cited && (action.answerId === undefined || action.optionId === undefined)) {
    throw new ToolInputError("cork_prepare_orders", [{ path: ["action", action.answerId === undefined ? "answerId" : "optionId"], message: "a cited answer needs BOTH answerId and optionId (the option lives on the answer); for an uncited answer pass premiumAnnualized + expiryTimestamp instead" }]);
  }
  if (cited && (action.premiumAnnualized !== undefined || action.expiryTimestamp !== undefined)) {
    throw new ToolInputError("cork_prepare_orders", [{ path: ["action", "premiumAnnualized"], message: "answerId/optionId and premiumAnnualized/expiryTimestamp are mutually exclusive: a cited option supplies its own premium and expiry" }]);
  }
  if (!cited && (action.premiumAnnualized === undefined || action.expiryTimestamp === undefined)) {
    throw new ToolInputError("cork_prepare_orders", [{ path: ["action", action.premiumAnnualized === undefined ? "premiumAnnualized" : "expiryTimestamp"], message: "an UNCITED answer needs premiumAnnualized (decimal-fraction string, \"0.041\" = 4.1%) AND expiryTimestamp (the pool expiry, unix seconds) — or cite one of your posted options with answerId + optionId" }]);
  }
  if (action.premiumAnnualized !== undefined) {
    try { premiumFraction(action.premiumAnnualized); } catch (e) { throw new ToolInputError("cork_prepare_orders", [{ path: ["action", "premiumAnnualized"], message: (e as Error).message }]); }
  }

  // ── the RFQ record (venue) ──
  const deps = venueDepsOf(ctx);
  let rfq: Record<string, unknown> | null;
  try {
    rfq = await getRfq(deps, action.rfqId, "full");
  } catch (err) {
    return venueFailed(chainId, err, ctx);
  }
  if (!rfq) return unavailable(chainId, "rfq_not_found", `RFQ ${action.rfqId} is unknown to the venue`, ctx);
  const warnings: Array<{ code: string; message: string }> = [];
  const rfqChain = str(rfq.chain_id);
  if (rfqChain !== undefined && rfqChain !== String(chainId)) {
    return unavailable(chainId, "invalid_order_terms", `RFQ ${action.rfqId} is for chainId ${rfqChain}, not ${chainId} — answer it on its own chain`, ctx);
  }
  const rfqState = str(rfq.state);
  if (rfqState !== undefined && rfqState !== "open") warnings.push({ code: "invalid_order_terms", message: `RFQ ${action.rfqId} is ${rfqState}, not open — the requester may no longer be looking; the order still builds` });
  const requester = isAddr(rfq.requester) ? rfq.requester : undefined;
  const referenceAsset = isAddr(rfq.reference_asset) ? rfq.reference_asset : undefined;
  if (!referenceAsset) return unavailable(chainId, "invalid_service_response", "the RFQ record carries no reference_asset address", ctx);
  // collateral: `exact`, or the caller's pick from `one_of`.
  const ca = rfq.collateral_asset as { exact?: unknown; one_of?: unknown } | undefined;
  let collateralAsset: `0x${string}` | undefined;
  if (ca && isAddr(ca.exact)) {
    collateralAsset = ca.exact;
    if (action.collateralAsset !== undefined && action.collateralAsset.toLowerCase() !== collateralAsset.toLowerCase()) {
      return unavailable(chainId, "invalid_order_terms", `the RFQ asks for collateral ${collateralAsset} exactly; ${action.collateralAsset} is not what the requester will accept`, ctx);
    }
  } else if (ca && Array.isArray(ca.one_of)) {
    const accepted = (ca.one_of as unknown[]).filter(isAddr).map((a) => a.toLowerCase());
    if (action.collateralAsset === undefined) {
      throw new ToolInputError("cork_prepare_orders", [{ path: ["action", "collateralAsset"], message: `this RFQ accepts any of ${accepted.length} collateral tokens (${accepted.join(", ")}) — pick one with collateralAsset` }]);
    }
    if (!accepted.includes(action.collateralAsset.toLowerCase())) {
      return unavailable(chainId, "invalid_order_terms", `${action.collateralAsset} is not among the collateral tokens the RFQ accepts (${accepted.join(", ")})`, ctx);
    }
    collateralAsset = action.collateralAsset;
  } else if (action.collateralAsset !== undefined) {
    collateralAsset = action.collateralAsset;
  }
  if (!collateralAsset) return unavailable(chainId, "invalid_service_response", "the RFQ record names no acceptable collateral asset (collateral_asset.exact / one_of) — pass collateralAsset", ctx);

  // ── the quote: a cited option or the caller's own terms ──
  let premiumAnnualized: string;
  let expiryTimestamp: bigint;
  let quoteRef: { rfqId: string; answerId: string; optionId: string } | undefined;
  let templateRecipe: `0x${string}` | undefined = recipeOfTemplate(rfq.market_template);
  // The requester's inline block (anchor, expiry, fees) — the cited option's when it carries one.
  let inline: InlineTemplateParams | undefined = inlineParamsOfTemplate(rfq.market_template);
  let inlineSource: "rfq" | "cited option" = "rfq";
  let optionEcho: Record<string, unknown> | null = null;
  if (cited) {
    const found = findRfqOption(rfq, action.answerId!, action.optionId!);
    if (found === "no-answer") return unavailable(chainId, "invalid_order_terms", `answer ${action.answerId} is not on RFQ ${action.rfqId} (the venue serves ${Array.isArray(rfq.answers) ? (rfq.answers as unknown[]).length : 0} answers)`, ctx);
    if (found === "no-option") return unavailable(chainId, "invalid_order_terms", `option ${action.optionId} is not on answer ${action.answerId}`, ctx);
    const underwriter = str(found.answer.underwriter) ?? str((found.answer.answer as Record<string, unknown> | undefined)?.underwriter);
    if (underwriter !== undefined && underwriter.toLowerCase() !== input.account.toLowerCase()) {
      return unavailable(chainId, "invalid_order_terms", `answer ${action.answerId} was posted by ${underwriter}, not by ${input.account} — a maker may cite only its OWN answer (the RFQ requester may cite any; cork-api 0.4.1 party rule). Post your own answer first (cork_submit rfq-answer) or answer uncited with premiumAnnualized`, ctx);
    }
    const p = str(found.option.premium_annualized);
    const e = str(found.option.expiry);
    if (p === undefined || e === undefined || !/^\d+$/.test(e)) return unavailable(chainId, "invalid_service_response", `option ${action.optionId} carries no usable premium_annualized/expiry`, ctx);
    premiumAnnualized = p;
    expiryTimestamp = BigInt(e);
    quoteRef = { rfqId: action.rfqId, answerId: action.answerId!, optionId: action.optionId! };
    templateRecipe = recipeOfTemplate(found.option.market_template) ?? templateRecipe;
    const optionInline = inlineParamsOfTemplate(found.option.market_template);
    if (optionInline) {
      inline = optionInline;
      inlineSource = "cited option";
    }
    optionEcho = { answerId: action.answerId, optionId: action.optionId, premiumAnnualized: p, expiry: e, ...(str(found.option.notional_max_assets) !== undefined ? { notionalMaxAssets: str(found.option.notional_max_assets) } : {}) };
    const maxNotional = str(found.option.notional_max_assets);
    const wanted = action.notionalAssets ?? str(rfq.notional_assets);
    if (maxNotional !== undefined && wanted !== undefined && /^\d+$/.test(maxNotional) && BigInt(wanted) > BigInt(maxNotional)) {
      warnings.push({ code: "invalid_order_terms", message: `the notional ${wanted} exceeds the option's notional_max_assets ${maxNotional} — the quote was meant up to that size; the order still builds at ${wanted}` });
    }
  } else {
    premiumAnnualized = action.premiumAnnualized!;
    expiryTimestamp = BigInt(action.expiryTimestamp!);
  }
  const recipe = action.jitMarket?.recipe ?? templateRecipe;
  if (!recipe) {
    throw new ToolInputError("cork_prepare_orders", [{ path: ["action", "jitMarket", "recipe"], message: `neither the RFQ nor the cited option names a recipe (market_template.inline.oracle_recipe) — pass jitMarket.recipe (the approved recipe CONTRACT ADDRESS; discover with cork_query resource:"registry-recipes")` }]);
  }
  const notionalStr = action.notionalAssets ?? str(rfq.notional_assets);
  if (notionalStr === undefined || !/^\d+$/.test(notionalStr) || BigInt(notionalStr) === 0n) return unavailable(chainId, "invalid_order_terms", "no positive notional: the RFQ carries no notional_assets and none was passed", ctx);
  const notional = BigInt(notionalStr);
  if (expiryTimestamp <= nowSecs) return unavailable(chainId, "invalid_order_terms", `the pool expiry ${expiryTimestamp} is not in the future (now ${nowSecs}) — a cover with no tenor has no premium`, ctx);
  const win = rfq.expiry_window as { not_before?: unknown; not_after?: unknown } | undefined;
  if (win) {
    const nb = str(win.not_before), na = str(win.not_after);
    if ((nb !== undefined && /^\d+$/.test(nb) && expiryTimestamp < BigInt(nb)) || (na !== undefined && /^\d+$/.test(na) && expiryTimestamp > BigInt(na))) {
      warnings.push({ code: "invalid_order_terms", message: `pool expiry ${expiryTimestamp} is outside the RFQ's expiry_window [${nb ?? "?"}, ${na ?? "?"}] — a visible counter-proposal the requester may ignore; the order still builds` });
    }
  }
  if (inline?.expiry !== undefined && inline.expiry !== expiryTimestamp) {
    warnings.push({ code: "invalid_order_terms", message: `the ${cited ? "cited option's" : "RFQ's"} inline template (oracle_params.expiry) names pool expiry ${inline.expiry}, but this answer builds at ${expiryTimestamp} — the requester derived its pool at ${inline.expiry}; the expiry is part of pool identity, so a different value is a different pool. The order still builds` });
  }

  // ── the requester's inline block: carried as the recipe's additionalData, BY SCHEMA ──
  // Liquidity: abi.encode(anchorRate). Impairment: abi.encode(anchorRate, durationSeconds,
  // apySpreadPercentage) — all three words or nothing (a partial block would encode a zero the
  // requester never asked for). The anchor decides the constraint ONLY while the pair's oracle
  // is undeployed (the recipe's resolve reads it in place of the missing oracle). Against a
  // DEPLOYED oracle every current recipe anchors on the live rate and ignores that word —
  // verified live 2026-09-11 on Arbitrum for the liquidity recipe and read in the 0.4.0 source
  // for the impairment one. So the payload is carried (the undeployed case is exactly when it
  // matters), and a deployed oracle's rate is compared with the anchor below and disclosed.
  const inlineData = inline ? inlineAdditionalData(inline) : undefined;
  // `extraData` is the name; `additionalData` the deprecated alias (both present and different
  // is refused by the maker path's resolver, which this order re-enters).
  const explicitBytes = action.jitMarket?.extraData ?? action.jitMarket?.additionalData;
  const extraData: `0x${string}` | undefined = explicitBytes ?? inlineData;
  // The impairment window is sized by duration_seconds — the requester's choice, which the recipe
  // never compares with the pool's life. A window sized for 7 days on a market that lives 30 can
  // hit its wall long before expiry; one sized for 30 on a 7-day market is looser cover than the
  // spread implies. Either is the requester's to choose and the underwriter's to price, so it is
  // DISCLOSED (info), never refused; a day of slack absorbs the clock between open and answer.
  if (inline?.schema === INLINE_IMPAIRMENT_SCHEMA && inline.durationSeconds !== undefined) {
    const tenor = expiryTimestamp - nowSecs;
    const gap = inline.durationSeconds > tenor ? inline.durationSeconds - tenor : tenor - inline.durationSeconds;
    if (gap > 86_400n) {
      warnings.push({ code: "invalid_order_terms", message: `the ${cited ? "cited option's" : "RFQ's"} impairment block sizes the rate window for duration_seconds ${inline.durationSeconds} while this answer's market lives ${tenor} s (expiry ${expiryTimestamp} − now ${nowSecs}) — ${inline.durationSeconds < tenor ? "the window can reach its wall before the market expires" : "the window is wider than the market's life needs"}; the recipe never checks the two agree. The requester chose it and the constraint (pool identity) is built from it, so the order builds as asked — price the cover on the window, not the tenor` });
    }
  }
  if (inline?.schema === INLINE_IMPAIRMENT_SCHEMA && inlineData === undefined && explicitBytes === undefined) {
    const missing = (["anchorRate", "durationSeconds", "apySpreadPercentage"] as const).filter((k) => inline![k as keyof typeof inline] === undefined);
    warnings.push({ code: "invalid_order_terms", message: `the ${cited ? "cited option's" : "RFQ's"} inline template is ${INLINE_IMPAIRMENT_SCHEMA} but its oracle_params block lacks ${missing.join(" + ")} — the impairment recipe's additionalData is exactly three words (anchor_rate 1e18 = 1.0, duration_seconds, apy_spread_percentage 1e18 = 1%), so none was derived; the order builds WITHOUT extraData and the recipe will refuse to resolve. Pass jitMarket.extraData (encodeImpairmentArgs) or ask the requester for a complete block` });
  }

  // ── reach: the declared FILL SENDER, or open when nobody declared one ──
  // The LOP compares allowedSender with the address that CALLS it. A requester that fills
  // through a ForSelf adapter is not that caller, so reserving for the requester account would
  // lock out the only party the reservation is for (PrivateOrder). Until the venue serves the
  // RFQ's fill_sender, an undeclared sender means an OPEN order, said in a warning — never a
  // guess (the kernel's rule for the same case, 2026-09-04).
  if (!action.reserve && action.fillSender !== undefined) {
    throw new ToolInputError("cork_prepare_orders", [{ path: ["action", "fillSender"], message: "fillSender reserves the fill; it contradicts reserve:false" }]);
  }
  const declared = isAddr(rfq.fill_sender) ? rfq.fill_sender : undefined;
  const allowedSender = action.reserve ? (action.fillSender ?? declared) : undefined;
  if (action.reserve && allowedSender === undefined) {
    warnings.push({
      code: "fill_sender_unknown",
      message: `RFQ ${action.rfqId} declares no fill_sender, so this order is OPEN to any taker. The LOP compares allowedSender with the address that CALLS it; the requester${requester ? ` ${requester}` : ""} may fill through an adapter (a ForSelf integrator), and an order reserved for the account would revert PrivateOrder() for the only party it was meant for. To reserve, pass fillSender: the requester's own address when you know it calls the LOP itself, or its adapter address.`,
    });
  }

  // ── the pool the cover creates on fill: derive-cork-pool (recipe → constraint → id → cST) ──
  // The fees and the oracle salt ride into the derivation too: on a 10-field generation the two
  // fee percentages are PART OF THE POOL ID, so the order's JIT block and this derivation must
  // carry the same values or the answer would name a pool the fill never creates.
  const swapFeePercentage = action.jitMarket?.swapFeePercentage ?? inline?.swapFeeWad ?? "0";
  const unwindSwapFeePercentage = action.jitMarket?.unwindSwapFeePercentage ?? inline?.unwindSwapFeeWad ?? "0";
  const derive = await handleQuery(
    { resource: "derive-cork-pool", chainId, format: "concise", pageSize: 25, maxPages: 10, filters: { collateralAsset, referenceAsset, expiry: expiryTimestamp.toString(), recipe, swapFeePercentage, unwindSwapFeePercentage, ...(action.jitMarket?.oracleSalt !== undefined ? { oracleSalt: action.jitMarket.oracleSalt } : {}), ...(extraData !== undefined ? { args: extraData } : {}), ...(action.jitMarket?.rateOverride !== undefined && action.jitMarket.rateOverride !== "0" ? { rate: action.jitMarket.rateOverride } : {}) } } as Parameters<typeof handleQuery>[0],
    ctx,
  );
  // A gated derive keeps its reason FIRST (the envelope contract) — but the warnings gathered
  // before it (an incomplete inline block, an undeclared fill sender, an out-of-window expiry)
  // ride along: they are often WHY the derive gated, and dropping them sent a caller to the
  // recipe's raw revert with no hint that the RFQ's own block was the cause.
  if (derive.state !== "ok") return { ...derive, warnings: [{ code: derive.warnings[0]?.code ?? "invalid_state", message: `answer-rfq could not derive the pool the cover creates: ${derive.warnings[0]?.message ?? derive.state}` }, ...warnings, ...derive.warnings.slice(1)] };
  type DerivedConstraint = { rateMin: bigint | string; rateMax: bigint | string; rateChangePerDayMax: bigint | string; rateChangeCapacityMax: bigint | string };
  const dd = derive.data as { pool: { poolId: `0x${string}`; exists: boolean; constraint?: DerivedConstraint } | null; shares: { corkSwapToken: `0x${string}` | null } | null; recipe: `0x${string}`; oracle: { address: `0x${string}` | null; deployed: boolean; rate?: bigint | string } };
  if (!dd.pool) return unavailable(chainId, "oracle_not_deployable", "the pair cannot get an oracle as registered — no pool id, no cST, no order", ctx);
  const cst = dd.shares?.corkSwapToken ?? null;
  if (!cst) return unavailable(chainId, "share_prediction_unavailable", "the pool's cST could not be read or predicted — the order's maker side cannot be set", ctx);
  // The anchor against a DEPLOYED oracle: the recipe ignores it, so the requester's expectation
  // and this pool agree only when the live rate equals the anchor at signing.
  const liveRate = typeof dd.oracle.rate === "bigint" ? dd.oracle.rate : typeof dd.oracle.rate === "string" && /^\d+$/.test(dd.oracle.rate) ? BigInt(dd.oracle.rate) : undefined;
  if (inline?.anchorRate !== undefined && dd.oracle.deployed && liveRate !== undefined && liveRate !== inline.anchorRate) {
    warnings.push({ code: "rate_drift_notice", message: `the requester's inline template names anchor_rate ${inline.anchorRate}, but the pair's oracle is DEPLOYED at ${dd.oracle.address} and reads ${liveRate} now — the recipe anchors on the LIVE rate and ignores the carried anchor, so this order's constraint (and pool ${dd.pool.poolId}) follow ${liveRate}, not the requester's ${inline.anchorRate}. A pool derived at the anchor is a different pool; the requester's fill checks decide whether this one is acceptable. The anchor is still carried in extraData for the undeployed-oracle case` });
  }
  // The derived constraint is PINNED into the order explicitly: the maker path then verifies
  // the carried numbers (recipe.verify) instead of resolving a second time — one derivation,
  // the one `answer.pool` reports.
  const pinnedConstraint = action.jitMarket?.constraint ?? (dd.pool.constraint ? { rateMin: String(dd.pool.constraint.rateMin), rateMax: String(dd.pool.constraint.rateMax), rateChangePerDayMax: String(dd.pool.constraint.rateChangePerDayMax), rateChangeCapacityMax: String(dd.pool.constraint.rateChangeCapacityMax) } : undefined);

  // ── amounts, the kernel's way ──
  const resolved = await getRpc(ctx, chainId);
  if (!resolved) return unavailable(chainId, "requires_rpc", "answer-rfq needs an RPC (collateral decimals, pool derivation)", ctx);
  let collateralDecimals: number;
  try {
    collateralDecimals = Number(await resolved.client.readContract({ address: collateralAsset, abi: erc20Abi, functionName: "decimals" }));
  } catch (err) {
    return chainReadFailed(chainId, err, [{ code: "chain_read_failed", message: `reading decimals() of collateral ${collateralAsset} failed` }], ctx);
  }
  const tenorSeconds = expiryTimestamp - nowSecs;
  const takingAmount = premiumAmount(premiumAnnualized, notional, tenorSeconds);
  const makingAmount = coverMakingAmount(notional, collateralDecimals);
  if (takingAmount === 0n) return unavailable(chainId, "invalid_order_terms", "the premium rounds to zero collateral units for this notional and tenor — nothing to take", ctx);

  // ── expiry: the venue's re-rest rule against the RFQ's remaining validity ──
  const validUntil = str(rfq.valid_until);
  const remaining = validUntil !== undefined && /^\d+$/.test(validUntil) ? BigInt(validUntil) - nowSecs : tenorSeconds;
  if (remaining <= 0n) return unavailable(chainId, "invalid_order_terms", `RFQ ${action.rfqId} validity lapsed at ${validUntil} (now ${nowSecs}) — the requester is no longer taking answers`, ctx);
  const expirySeconds = action.expirySeconds ?? reRestExpirySeconds(remaining);
  const ocoGroup = action.ocoGroup ?? answerOcoGroup(action.rfqId);

  // The caller's explicit jitMarket fields win; absent ones come from the requester's inline
  // block (fees, anchor), else the defaults. `undefined` values are dropped so a spread never
  // erases an inline value.
  const { recipe: _r, additionalData: _legacyBytes, ...jitRest } = action.jitMarket ?? {};
  const jitExplicit = Object.fromEntries(Object.entries(jitRest).filter(([, v]) => v !== undefined));
  const jitFromInline = {
    ...(extraData !== undefined ? { extraData } : {}),
    ...(pinnedConstraint !== undefined ? { constraint: pinnedConstraint } : {}),
    swapFeePercentage,
    unwindSwapFeePercentage,
  };
  const makerAction: MakerOrderAction = {
    type: "maker-order",
    poolId: dd.pool.poolId,
    side: "SELL",
    makerAsset: cst,
    takerAsset: collateralAsset,
    makingAmount: makingAmount.toString(),
    takingAmount: takingAmount.toString(),
    expirySeconds,
    allowsPartialFills: action.allowsPartialFills,
    usePermit2: action.usePermit2,
    ocoGroup,
    ...(allowedSender !== undefined ? { allowedSender } : {}),
    ...(quoteRef ? { quoteRef } : {}),
    jitMarket: { collateralAsset, referenceAsset, expiryTimestamp: expiryTimestamp.toString(), recipe, rateOverride: "0", enableJitMint: false, ...jitFromInline, ...jitExplicit } as NonNullable<MakerOrderAction["jitMarket"]>,
  };
  const env = await sugar.prepare({ ...input, action: makerAction }, ctx);
  if (env.state !== "ok") return { ...env, warnings: [...warnings, ...env.warnings] };
  const impliedWad = impliedPremiumWad(takingAmount, notional, tenorSeconds);
  return {
    ...env,
    warnings: [...warnings, ...env.warnings],
    data: {
      ...(env.data as Record<string, unknown>),
      answer: {
        rfqId: action.rfqId,
        requester: requester ?? null,
        quoteRef: quoteRef ?? null,
        option: optionEcho,
        premiumAnnualized,
        collateralAsset,
        referenceAsset,
        collateralDecimals,
        notionalAssets: notional.toString(),
        poolExpiry: expiryTimestamp.toString(),
        tenorSeconds: tenorSeconds.toString(),
        takingAmount: takingAmount.toString(),
        makingAmount: makingAmount.toString(),
        impliedPremiumWad: impliedWad.toString(),
        formula: "takingAmount = ceil(premium × notional × tenorSeconds / 31536000) in collateral base units (ACT/365, rounded toward the maker — the kernel's premium_amount); makingAmount = notional rescaled to the 18-decimal cST",
        reservedFor: allowedSender ?? null,
        reach: allowedSender !== undefined ? "reserved" : "open",
        expirySeconds,
        expiryRule: action.expirySeconds !== undefined ? "caller" : "venue re-rest rule: max(90 s, min(600 s, remaining RFQ validity / 2))",
        ocoGroup,
        pool: { poolId: dd.pool.poolId, exists: dd.pool.exists, corkSwapToken: cst, recipe: dd.recipe, oracleDeployed: dd.oracle.deployed, ...(liveRate !== undefined ? { oracleRate: liveRate.toString() } : {}) },
        inline: inline
          ? {
              schema: inline.schema,
              source: inlineSource,
              anchorRate: inline.anchorRate?.toString() ?? null,
              expiry: inline.expiry?.toString() ?? null,
              swapFeeWad: inline.swapFeeWad ?? null,
              unwindSwapFeeWad: inline.unwindSwapFeeWad ?? null,
              ...(inline.schema === INLINE_IMPAIRMENT_SCHEMA ? { durationSeconds: inline.durationSeconds?.toString() ?? null, apySpreadPercentage: inline.apySpreadPercentage?.toString() ?? null, complete: inlineData !== undefined } : {}),
              extraData: extraData ?? null,
              anchorHonored: inline.anchorRate === undefined ? null : !dd.oracle.deployed,
              note: "the recipe reads the anchor word of extraData only while the pair's oracle is undeployed; against a deployed oracle it anchors on the live rate — see rate_drift_notice when they differ",
            }
          : null,
        scales: { premiumAnnualized: "annualized decimal-fraction STRING (\"0.041\" = 4.1%)", impliedPremiumWad: "the amounts decoded back to an annualized fraction, 1e18 = 1.0", takingAmount: "base units of the collateral asset", makingAmount: "base units of the cST (18 decimals)", unitsTopic: UNITS_TOPIC_REFERENCE },
      },
      execution: executionAnswerRfq(),
    },
  };
}

// ── refresh-order: re-rest a resting order of yours on the SAME bit with a new expiry (U2) ──
export async function handleRefreshOrder(input: PrepareOrdersInput, action: RefreshOrderAction, ctx: HandlerContext, sugar: SugarDeps): Promise<Envelope> {
  const chainId = input.chainId;
  const lop = LOP_ADDRESSES[chainId];
  if (!lop) return unavailable(chainId, "no_lop", `no known 1inch LOP v4 deployment for chainId ${chainId}`, ctx);
  const wanted = action.orderHash.toLowerCase();
  const deps = venueDepsOf(ctx);
  let row: Record<string, unknown> | undefined;
  try {
    const book = await collectVenuePages({ maxPages: action.maxPages }, (cursor) => getLopOrderbook(deps, { chainId, limit: 100, ...(cursor ? { cursor } : {}) }));
    row = book.items.find((item) => {
      const nested = item.order && typeof item.order === "object" && !Array.isArray(item.order) ? (item.order as Record<string, unknown>) : item;
      const h = nested.orderHash ?? nested.order_hash ?? item.orderHash ?? item.order_hash;
      return typeof h === "string" && h.toLowerCase() === wanted;
    });
    if (!row) {
      if (!book.complete) return envelope({ state: "conflict", data: { requestedOrderHash: action.orderHash, pagesFetched: book.pagesFetched, reason: book.reason, ...(book.nextCursor ? { nextCursor: book.nextCursor } : {}) }, chainId, source: "service", warnings: [{ code: "pagination_incomplete", message: `the orderbook search was incomplete (${book.reason}); no absence claim and no refreshed order were produced` }], ctx });
      return unavailable(chainId, "order_not_found", `no resting venue order found for ${action.orderHash} on chainId ${chainId} — an order that is not resting has nothing to refresh; post a maker-order`, ctx);
    }
  } catch (err) {
    return venueFailed(chainId, err, ctx);
  }
  const parsed = parseSignedLopOrder(row);
  if (!parsed.ok) return unavailable(chainId, "invalid_service_response", `venue returned a malformed signed order — ${parsed.error}`, ctx);
  const old = parsed.value.order;
  const localHash = hashLopOrder(chainId, lop, old);
  if (localHash.toLowerCase() !== wanted) {
    return envelope({ state: "conflict", data: { requestedOrderHash: action.orderHash, localOrderHash: localHash }, chainId, source: "service", warnings: [{ code: "order_hash_mismatch", message: `the venue row for ${action.orderHash} hashes to ${localHash} locally — a row misrepresenting its own order is not refreshed` }], ctx });
  }
  if (old.maker.toLowerCase() !== input.account.toLowerCase()) {
    return unavailable(chainId, "invalid_order_terms", `order ${action.orderHash} was made by ${old.maker}, not by ${input.account} — only the maker can re-rest its order (the new order is signed by account)`, ctx);
  }
  // The venue row is DISCOVERY, not authority [K3]: before its terms become a NEW signature
  // request, the extension rule and the maker signature are checked exactly as a fill checks
  // them — a refresh must never re-sign bytes the venue served with a signature `account`
  // never made, or an extension the salt never committed to. Chain-free for an EOA maker;
  // the ERC-1271 staticcall for a contract maker (an RPC read, indeterminate without one).
  const auth = await authenticateSignedOrder({ ctx, chainId, order: old, orderHash: localHash, signature: parsed.value.signature, extension: parsed.value.extension, consequence: "the order was not refreshed", echo: { requestedOrderHash: action.orderHash, acquisition: "venue" } });
  if (!auth.ok) return auth.envelope;
  const traits = decodeMakerTraits(old.makerTraits);
  const plan = lopInvalidatorPlan(old.makerTraits);
  if (plan.mode !== "bit") return unavailable(chainId, "invalid_order_terms", "this order uses the remaining-amount invalidator (allowMultipleFills) — a refresh shares a BIT, which only single-fill orders have; post a maker-order instead", ctx);
  // Liveness [K7]: a spent bit means the old order is dead AND a refresh on the same nonce would
  // be dead on arrival — refuse, and say what to do instead.
  const resolved = await getRpc(ctx, chainId);
  const warnings: Array<{ code: string; message: string }> = [...auth.warnings];
  if (resolved) {
    try {
      const status = classifyInvalidatorWord(plan, await readLopInvalidator(resolved.client, plan, lop, old.maker, localHash));
      if (status.status === "filled-or-cancelled") {
        return envelope({ state: "conflict", data: { orderHash: localHash, nonce: traits.nonce.toString(), venueStatus: "resting", chainStatus: status.status }, chainId, source: "chain", warnings: [{ code: "status_mismatch", message: `the LOP invalidator says order ${action.orderHash} (nonce ${traits.nonce}) is already filled or cancelled — its bit is spent, so a refresh on the same bit could never fill. The venue still lists it; post a NEW maker-order (its own bit) instead` }], ctx });
      }
    } catch (err) {
      warnings.push({ code: "venue_reported", message: `liveness read failed (${revertReason(err)}) — the refresh is built on the venue's word that the order rests; confirm the bit before signing` });
    }
  } else {
    warnings.push({ code: "venue_reported", message: "no RPC resolved — the refresh is built on the venue's word that the order rests (its bit was not read); set CORK_RPC_URL to confirm before signing" });
  }
  const nowSecs = nowSecondsOf(ctx);
  const extension = parsed.value.extension;
  let built: ReturnType<typeof buildMakerOrder>;
  try {
    built = buildMakerOrder({
      chainId, lop, maker: input.account,
      makerAsset: old.makerAsset, takerAsset: old.takerAsset,
      makingAmount: old.makingAmount, takingAmount: old.takingAmount,
      clientRequestId: input.clientRequestId,
      expiry: nowSecs + BigInt(action.expirySeconds),
      allowPartialFills: traits.allowPartialFills,
      usePermit2: traits.usePermit2,
      ...(traits.allowedSender !== null ? { allowedSender: `0x${"00".repeat(10)}${traits.allowedSender.slice(2)}` as `0x${string}` } : {}),
      nonce: traits.nonce,
      ...(extension !== "0x" ? { extension } : {}),
    });
  } catch (err) {
    return unavailable(chainId, "invalid_order_terms", err instanceof Error ? err.message : "refreshed order construction failed", ctx);
  }
  const approvals = await sugar.annotateApprovals(ctx, chainId, makerApprovalRequirements({ maker: input.account, makerAsset: old.makerAsset, makingAmount: old.makingAmount, lop, usePermit2: traits.usePermit2, orderExpiry: decodeMakerTraits(built.order.makerTraits).expiry }));
  const makerApprovalWarn = approvalMissingWarning(approvals, "before signing and listing the refreshed order");
  if (makerApprovalWarn) warnings.push(makerApprovalWarn);
  warnings.push({ code: "oco_group_notice", message: `the refreshed order shares invalidator nonce ${built.nonce} with ${action.orderHash}: whichever of the two fills or is cancelled first retires the other (one bit) — the refresh is a revision, not a second exposure. The venue lists both as OPEN; re-read the bit before ranking or filling either. Vocabulary: ${ORDERS_TOPIC_REFERENCE}` });
  return envelope({
    state: "ok",
    data: {
      kind: "maker-order",
      lop,
      typedData: { domain: built.domain, types: built.types, primaryType: built.primaryType, message: built.order },
      orderHash: built.orderHash,
      extension: built.extension,
      nonce: built.nonce,
      ocoGroup: null,
      allowedSender: decodeMakerTraits(built.order.makerTraits).allowedSender,
      approvals,
      refreshes: { orderHash: localHash, nonce: traits.nonce.toString(), previousExpiry: traits.expiry.toString(), newExpiry: (nowSecs + BigInt(action.expirySeconds)).toString(), sameTerms: ["makerAsset", "takerAsset", "makingAmount", "takingAmount", "allowedSender", "allowsPartialFills", "usePermit2", "extension"], extensionCarried: extension !== "0x" },
      scales: { makingAmount: "base units of makerAsset (the token's own decimals)", takingAmount: "base units of takerAsset", approvalsAmount: "approvals[].amount is base units of that entry's own token", unitsTopic: UNITS_TOPIC_REFERENCE },
      execution: executionRefreshOrder(),
      clientRequestId: input.clientRequestId,
    },
    chainId,
    source: resolved ? "chain" : "service",
    warnings,
    ctx,
  });
}
