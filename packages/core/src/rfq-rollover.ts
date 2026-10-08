// Rollover RFQs (venue RFQ v2, kind "rollover"): a cPT holder asks for a price to move a held
// position into another pool; an underwriter answers with a destination and a premium per
// share; the holder's own rollover order executes the quote it accepts. These are the venue's
// rules for those writes and for the order that cites a quote, mirrored so a write is refused
// here with teaching instead of burning a request_id on a venue 400.

import { zeroHash, type Hex } from "viem";
import type { JitMarketParamsStruct } from "./rollover.ts";

const UINT256_MAX = (1n << 256n) - 1n;
const POSITIVE_UINT = /^[1-9][0-9]*$/;
const UINT = /^[0-9]+$/;
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const HEX_BYTES = /^0x([0-9a-fA-F]{2})*$/;

const same = (a: unknown, b: unknown): boolean => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();

function positiveUint256(v: unknown): boolean {
  return typeof v === "string" && POSITIVE_UINT.test(v) && v.length <= 78 && BigInt(v) <= UINT256_MAX;
}

/** Whether the requester accepts its premium in `token` (venue premiumTokenAllowed; the venue
 *  compares the lowercased addresses it stores, so case never decides). */
export function premiumTokenAllowed(spec: unknown, token: string): boolean {
  if (spec === null || typeof spec !== "object") return false;
  const s = spec as { exact?: unknown; one_of?: unknown };
  if (typeof s.exact === "string") return same(s.exact, token);
  return Array.isArray(s.one_of) && s.one_of.some((t) => same(t, token));
}

/** The fields an RFQ open carries depend on its kind (venue RFQ v2 open schema: the two kinds
 *  are separate strict schemas, so a field of the other kind is a 400). Returns the refusal
 *  text, or null. */
export function rfqOpenKindFieldsViolation(a: {
  kind: "new_position" | "rollover";
  modes?: unknown;
  packageIds?: unknown;
  notionalAssets?: unknown;
  source?: unknown;
  premiumToken?: unknown;
}): string | null {
  if (a.kind === "rollover") {
    const stray = (["modes", "packageIds", "notionalAssets"] as const).filter((k) => a[k] !== undefined);
    if (stray.length > 0) {
      return `${stray.join(", ")} ${stray.length === 1 ? "belongs" : "belong"} to a new_position RFQ only: a rollover RFQ asks for a price to move cPT shares you already hold, so it names the position (source {poolId, shares}) and the tokens you accept the premium in (premiumToken), never cover modes, packages or a notional (the venue refuses them with a 400)`;
    }
    if (a.source === undefined) return "a rollover RFQ needs source {poolId, shares}: the pool your cPT position is in and how many cPT shares (18 decimals) you want priced";
    if (a.premiumToken === undefined) return "a rollover RFQ needs premiumToken: {exact: token} or {one_of: [tokens]} — the token(s) you accept the premium in";
    const one = (a.premiumToken as { one_of?: unknown }).one_of;
    if (Array.isArray(one) && new Set(one.map((t) => String(t).toLowerCase())).size !== one.length) return "premiumToken.one_of must name each token once (the venue refuses a repeated token with a 400)";
    return null;
  }
  const stray = (["source", "premiumToken"] as const).filter((k) => a[k] !== undefined);
  if (stray.length > 0) return `${stray.join(", ")} ${stray.length === 1 ? "belongs" : "belong"} to a rollover RFQ only: a new_position RFQ asks for cover, so it names modes, packageIds and notionalAssets instead (the venue refuses the other kind's fields with a 400)`;
  const missing = (["modes", "packageIds", "notionalAssets"] as const).filter((k) => a[k] === undefined);
  if (missing.length > 0) return `a new_position RFQ needs ${missing.join(", ")} (the venue requires ${missing.length === 1 ? "it" : "them"})`;
  return null;
}

/** A counter is priced in its RFQ kind's own unit (venue RFQ v2 counter schema): an annualized
 *  fraction on new_position; a premium per share in one of the requester's premium tokens on
 *  rollover. Returns the refusal text, or null. */
export function rfqCounterKindFieldsViolation(kind: "new_position" | "rollover", a: { premiumAnnualized?: unknown; premiumPerShare?: unknown; premiumToken?: unknown }): string | null {
  if (kind === "rollover") {
    if (a.premiumAnnualized !== undefined) return "premiumAnnualized prices a new_position counter: a rollover counter bids premiumPerShare (raw premium-token units per 1e18 destination shares) in a premiumToken the RFQ accepts (the venue refuses the other unit with a 400)";
    if (a.premiumPerShare === undefined || a.premiumToken === undefined) return "a rollover counter needs premiumPerShare (raw premium-token units per 1e18 destination shares, a positive integer string) and premiumToken (one of the tokens the RFQ accepts)";
    if (!positiveUint256(a.premiumPerShare)) return `premiumPerShare must be a positive integer string of at most uint256 — got ${JSON.stringify(a.premiumPerShare)}`;
    return null;
  }
  if (a.premiumPerShare !== undefined || a.premiumToken !== undefined) return "premiumPerShare and premiumToken price a rollover counter: a new_position counter bids premiumAnnualized, a decimal fraction string (\"0.041\" = 4.1% annualized)";
  if (a.premiumAnnualized === undefined) return "a new_position counter needs premiumAnnualized, a decimal fraction string (\"0.041\" = 4.1% annualized)";
  return null;
}

/** A rollover answer's just-in-time destination, written the way every other jitMarket input
 *  in this tool is (camelCase, `extraData` with `additionalData` as its alias, optional salt and
 *  fees), turned into the venue's JITMarketParams wire — field for field BaseFiller's struct,
 *  every number a decimal string, the zero salt and zero fees as defaults. */
export function rolloverJitMarketWire(jm: Record<string, unknown>): { ok: true; wire: Record<string, unknown> } | { ok: false; reason: string } {
  const str = (v: unknown): unknown => (typeof v === "number" || typeof v === "bigint" ? String(v) : v);
  const extra = jm.extraData;
  const alias = jm.additionalData;
  if (extra !== undefined && alias !== undefined && String(extra).toLowerCase() !== String(alias).toLowerCase()) {
    return { ok: false, reason: "carries both extraData and its alias additionalData with different bytes — pass extraData only" };
  }
  const constraint = (jm.constraint ?? {}) as Record<string, unknown>;
  const wire = {
    collateralAsset: jm.collateralAsset,
    referenceAsset: jm.referenceAsset,
    expiryTimestamp: str(jm.expiryTimestamp),
    recipe: jm.recipe,
    rateOverride: str(jm.rateOverride ?? "0"),
    constraint: {
      rateMin: str(constraint.rateMin),
      rateMax: str(constraint.rateMax),
      rateChangePerDayMax: str(constraint.rateChangePerDayMax),
      rateChangeCapacityMax: str(constraint.rateChangeCapacityMax),
    },
    additionalData: extra ?? alias ?? "0x",
    oracleSalt: jm.oracleSalt ?? zeroHash,
    swapFeePercentage: str(jm.swapFeePercentage ?? "0"),
    unwindSwapFeePercentage: str(jm.unwindSwapFeePercentage ?? "0"),
  };
  const problem = jitMarketWireViolation(wire);
  return problem === null ? { ok: true, wire } : { ok: false, reason: problem };
}

/** The venue's JitMarketSchema, field for field (RFQ v2 answer schema). */
function jitMarketWireViolation(w: Record<string, unknown>): string | null {
  for (const k of ["collateralAsset", "referenceAsset", "recipe"] as const) {
    if (typeof w[k] !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(w[k] as string)) return `${k} must be an address`;
  }
  for (const k of ["expiryTimestamp", "rateOverride", "swapFeePercentage", "unwindSwapFeePercentage"] as const) {
    const v = w[k];
    if (typeof v !== "string" || !UINT.test(v) || v.length > 78 || BigInt(v) > UINT256_MAX) return `${k} must be a uint256 decimal string`;
  }
  const c = (w.constraint ?? {}) as Record<string, unknown>;
  for (const k of ["rateMin", "rateMax", "rateChangePerDayMax", "rateChangeCapacityMax"] as const) {
    const v = c[k];
    if (typeof v !== "string" || !UINT.test(v) || v.length > 78 || BigInt(v) > UINT256_MAX) return `constraint.${k} must be a uint256 decimal string`;
  }
  if (typeof w.additionalData !== "string" || !HEX_BYTES.test(w.additionalData)) return "additionalData (extraData) must be hex bytes";
  if (typeof w.oracleSalt !== "string" || !BYTES32.test(w.oracleSalt)) return "oracleSalt must be a bytes32";
  return null;
}

/** The struct BaseFiller hashes, from a jit_market wire object. */
export function jitMarketParamsOfWire(w: Record<string, unknown>): JitMarketParamsStruct {
  const c = w.constraint as Record<string, string>;
  return {
    collateralAsset: w.collateralAsset as `0x${string}`,
    referenceAsset: w.referenceAsset as `0x${string}`,
    expiryTimestamp: BigInt(w.expiryTimestamp as string),
    recipe: w.recipe as `0x${string}`,
    rateOverride: BigInt(w.rateOverride as string),
    rateMin: BigInt(c.rateMin!),
    rateMax: BigInt(c.rateMax!),
    rateChangePerDayMax: BigInt(c.rateChangePerDayMax!),
    rateChangeCapacityMax: BigInt(c.rateChangeCapacityMax!),
    additionalData: w.additionalData as Hex,
    oracleSalt: w.oracleSalt as Hex,
    swapFeePercentage: BigInt(w.swapFeePercentage as string),
    unwindSwapFeePercentage: BigInt(w.unwindSwapFeePercentage as string),
  };
}

/** A rollover answer option as the venue takes it: a `destination.jitMarket` written in this
 *  tool's input shape becomes the wire `destination.jit_market`; everything else passes as given.
 *  Prepare and submit both run it, so the two sign and send the same body. */
export function rolloverOptionToWire(option: Record<string, unknown>): { ok: true; option: Record<string, unknown> } | { ok: false; reason: string } {
  const d = option.destination;
  if (d === null || typeof d !== "object" || !("jitMarket" in (d as Record<string, unknown>))) return { ok: true, option };
  const dest = d as Record<string, unknown>;
  if ("jit_market" in dest || "pool_id" in dest) return { ok: false, reason: "destination names more than one target — give exactly one of pool_id or jitMarket" };
  const converted = rolloverJitMarketWire(dest.jitMarket as Record<string, unknown>);
  if (!converted.ok) return { ok: false, reason: `destination.jitMarket ${converted.reason}` };
  return { ok: true, option: { ...option, destination: { jit_market: converted.wire } } };
}

/** The request side of a rollover RFQ, as its record serves it. */
interface RolloverRequestView {
  chainId: unknown;
  sourcePoolId: unknown;
  sourceShares: unknown;
  premiumToken: unknown;
}

function requestViewOf(rfq: Record<string, unknown>): RolloverRequestView {
  const source = (rfq.source ?? {}) as Record<string, unknown>;
  return { chainId: rfq.chain_id, sourcePoolId: source.pool_id, sourceShares: source.shares, premiumToken: rfq.premium_token };
}

/**
 * The venue's chain-free rules for one rollover answer option (RFQ v2 answer schema
 * RolloverAnswerOptionSchema + answer POST route checkRolloverOptions): on the RFQ's chain,
 * paid in a token the requester accepts, for no more shares than it holds, into exactly one
 * destination that is not the source pool. Whether that destination pool exists and is live is
 * a chain question (handlers/rfq-rollover.ts). Takes the WIRE option. Returns the refusal, or null.
 */
export function rolloverOptionViolation(index: number, option: Record<string, unknown>, rfq: Record<string, unknown>): string | null {
  const at = `options[${index}]`;
  const req = requestViewOf(rfq);
  for (const k of ["order", "order_signature", "premium_annualized", "mode", "package_id", "market_template", "notional_max_assets", "expiry"]) {
    if (k in option) return `${at}.${k} belongs to a new_position quote: a rollover quote carries no order (the cPT holder signs the rollover order, not the underwriter) — it names destination, premium_token, premium_per_share and shares_max (the venue refuses other fields with a 400)`;
  }
  if (typeof option.option_id !== "string" || option.option_id.length < 1 || option.option_id.length > 64) return `${at}.option_id must be a string of 1..64 characters`;
  if (typeof option.fresh_until !== "number" || !Number.isInteger(option.fresh_until) || option.fresh_until <= 0) return `${at}.fresh_until must be a positive unix-seconds integer`;
  if (option.chain_id !== req.chainId) return `${at}.chain_id must be the RFQ's chain (${String(req.chainId)}) — got ${JSON.stringify(option.chain_id)} (the venue would 400)`;
  if (typeof option.premium_token !== "string" || !premiumTokenAllowed(req.premiumToken, option.premium_token)) return `${at}.premium_token ${JSON.stringify(option.premium_token)} is not one the requester accepts (the RFQ's premium_token is ${JSON.stringify(req.premiumToken)}; the venue would 400)`;
  if (!positiveUint256(option.premium_per_share)) return `${at}.premium_per_share must be a positive integer string of at most uint256: raw premium-token units per 1e18 destination shares, exactly the rollover order's minPremiumPerShare — got ${JSON.stringify(option.premium_per_share)}`;
  if (typeof option.shares_max !== "string" || !POSITIVE_UINT.test(option.shares_max)) return `${at}.shares_max must be a positive integer string (cPT shares, 18 decimals) — got ${JSON.stringify(option.shares_max)}`;
  if (typeof req.sourceShares === "string" && UINT.test(req.sourceShares) && BigInt(option.shares_max) > BigInt(req.sourceShares)) {
    return `${at}.shares_max (${option.shares_max}) is more than the RFQ's source.shares (${req.sourceShares}) — a quote cannot cover shares the requester does not ask to roll (the venue would 400)`;
  }
  const d = option.destination;
  if (d === null || typeof d !== "object") return `${at}.destination is required: {pool_id} for an existing pool, or {jitMarket} for a market the filler creates at fill time`;
  const dest = d as Record<string, unknown>;
  const keys = Object.keys(dest);
  if (keys.length !== 1 || (keys[0] !== "pool_id" && keys[0] !== "jit_market")) return `${at}.destination must be exactly one of {pool_id} or {jitMarket} — got keys ${JSON.stringify(keys)}`;
  if ("pool_id" in dest) {
    if (typeof dest.pool_id !== "string" || !BYTES32.test(dest.pool_id)) return `${at}.destination.pool_id must be a bytes32 pool id`;
    if (same(dest.pool_id, req.sourcePoolId)) return `${at}.destination.pool_id is the RFQ's source pool: a rollover must move to ANOTHER pool (the venue would 400)`;
    return null;
  }
  const problem = jitMarketWireViolation(dest.jit_market as Record<string, unknown>);
  return problem === null ? null : `${at}.destination.jit_market.${problem}`;
}

/** The rollover order fields a quote citation is checked against. */
export interface RolloverQuoteOrder {
  user: string;
  premiumToken: string;
  orderSize: bigint;
  minPremiumPerShare: bigint;
  srcPoolId: string;
  dstPoolId: string;
  jitMarketHash: string;
}

/** One answer as an RFQ record embeds it. */
interface EmbeddedAnswer {
  answer_id?: unknown;
  status?: unknown;
  answer?: { status?: unknown; options?: Array<Record<string, unknown>> };
}

export type RolloverQuoteLookup =
  | { found: true; option: Record<string, unknown>; underwriter: string | null }
  | { found: false; reason: string; unresolved: boolean };

/** The cited option on a rollover RFQ record, with the venue's citation rules on the RFQ and
 *  answer (the venue's rollover v1 quote-ref rule): a v2 rollover RFQ on this chain, an answer
 *  on it that is a quote and holds the option. A TRUNCATED answers embed cannot prove an answer
 *  absent, so that miss is `unresolved` — the venue checks its full store. */
export function findRolloverQuote(chainId: number, rfq: Record<string, unknown>, quoteRef: { answerId: string; optionId: string }): RolloverQuoteLookup {
  if (rfq.kind !== "rollover") return { found: false, reason: "the referenced RFQ is a new_position RFQ; it cannot back a rollover order", unresolved: false };
  if (rfq.chain_id !== chainId) return { found: false, reason: `the referenced RFQ is on chain ${String(rfq.chain_id)}, not ${chainId}`, unresolved: false };
  const answers = (Array.isArray(rfq.answers) ? rfq.answers : []) as EmbeddedAnswer[];
  const answer = answers.find((a) => String(a.answer_id) === quoteRef.answerId);
  if (!answer) {
    return { found: false, reason: `answer '${quoteRef.answerId}' is not on the referenced RFQ`, unresolved: rfq.truncated === true || rfq.answers_truncated === true };
  }
  const status = answer.answer?.status ?? answer.status;
  if (status !== "quoted") return { found: false, reason: `the referenced answer is not a quote (status ${String(status)})`, unresolved: false };
  const option = (answer.answer?.options ?? []).find((o) => String(o.option_id) === quoteRef.optionId);
  if (!option) return { found: false, reason: `option '${quoteRef.optionId}' is not in the referenced answer`, unresolved: false };
  const underwriter = (answer as { underwriter?: unknown }).underwriter ?? (answer.answer as { underwriter?: unknown } | undefined)?.underwriter;
  return { found: true, option, underwriter: typeof underwriter === "string" ? underwriter : null };
}

/**
 * Whether a rollover order matches the quote it cites — the venue's quoteRefMismatch rule
 * (rollover v1 quote-ref), mirrored: the order's user is the RFQ's requester,
 * its source pool the RFQ's source, its destination the quoted one (an existing pool with a ZERO
 * jitMarketHash, or a just-in-time market whose hash equals the stored jit_market_hash), the
 * quoted premium token, a premium per share at least the quoted one, and no more shares than
 * the quote covers. RFQ expiry and fresh_until are not checked, as the venue does not: the
 * order carries its own deadlines. Returns why the quote does not back the order, or null.
 */
export function rolloverQuoteRefMismatch(rfq: Record<string, unknown>, option: Record<string, unknown>, order: RolloverQuoteOrder): string | null {
  const requester = rfq.requester;
  if (!same(requester, order.user)) return `the order's user ${order.user} is not the requester of the referenced RFQ (${String(requester)})`;
  const req = requestViewOf(rfq);
  if (!same(req.sourcePoolId, order.srcPoolId)) return `srcPoolId ${order.srcPoolId} is not the RFQ's source pool (${String(req.sourcePoolId)})`;
  const destination = (option.destination ?? {}) as Record<string, unknown>;
  const zero = order.jitMarketHash.toLowerCase() === zeroHash;
  if (destination.pool_id !== undefined) {
    if (!same(destination.pool_id, order.dstPoolId)) return `dstPoolId ${order.dstPoolId} is not the quoted destination pool (${String(destination.pool_id)})`;
    if (!zero) return "the quoted option is an existing pool, so jitMarketHash must be zero (the order must not also ask for a new market)";
  } else if (destination.jit_market !== undefined) {
    if (zero || !same(option.jit_market_hash, order.jitMarketHash)) return `jitMarketHash ${order.jitMarketHash} is not the quoted just-in-time market (${String(option.jit_market_hash ?? "no hash served")})`;
  } else {
    return "the referenced option has no readable destination";
  }
  if (!same(option.premium_token, order.premiumToken)) return `premiumToken ${order.premiumToken} is not the quoted premium_token (${String(option.premium_token)})`;
  const quotedPps = typeof option.premium_per_share === "string" && UINT.test(option.premium_per_share) ? BigInt(option.premium_per_share) : undefined;
  if (quotedPps === undefined || order.minPremiumPerShare < quotedPps) return `minPremiumPerShare ${order.minPremiumPerShare} is below the quoted premium_per_share (${String(option.premium_per_share)})`;
  const sharesMax = typeof option.shares_max === "string" && UINT.test(option.shares_max) ? BigInt(option.shares_max) : undefined;
  if (sharesMax === undefined || order.orderSize > sharesMax) return `orderSize ${order.orderSize} is more than the quoted shares_max (${String(option.shares_max)})`;
  return null;
}

/** The order terms a cited quote supplies when the caller leaves them out: the RFQ's source
 *  pool, the quoted destination, premium token and premium per share, and as many shares as
 *  the quote covers (never more than the RFQ asked to roll). */
export interface RolloverQuoteDefaults {
  srcPoolId: `0x${string}`;
  dstPoolId?: `0x${string}`;
  jitMarket?: Record<string, unknown>;
  jitMarketHash?: `0x${string}`;
  premiumToken: `0x${string}`;
  minPremiumPerShare: string;
  orderSize: string;
}

export function rolloverQuoteDefaults(rfq: Record<string, unknown>, option: Record<string, unknown>): RolloverQuoteDefaults {
  const req = requestViewOf(rfq);
  const sharesMax = BigInt(option.shares_max as string);
  const sourceShares = typeof req.sourceShares === "string" && UINT.test(req.sourceShares) ? BigInt(req.sourceShares) : sharesMax;
  const destination = (option.destination ?? {}) as Record<string, unknown>;
  const jit = destination.jit_market as Record<string, unknown> | undefined;
  return {
    srcPoolId: req.sourcePoolId as `0x${string}`,
    ...(typeof destination.pool_id === "string" ? { dstPoolId: destination.pool_id as `0x${string}` } : {}),
    ...(jit !== undefined
      ? {
          jitMarket: {
            collateralAsset: jit.collateralAsset,
            referenceAsset: jit.referenceAsset,
            expiryTimestamp: Number(jit.expiryTimestamp),
            recipe: jit.recipe,
            rateOverride: jit.rateOverride,
            constraint: jit.constraint,
            extraData: jit.additionalData,
            oracleSalt: jit.oracleSalt,
            swapFeePercentage: jit.swapFeePercentage,
            unwindSwapFeePercentage: jit.unwindSwapFeePercentage,
          },
        }
      : {}),
    ...(typeof option.jit_market_hash === "string" ? { jitMarketHash: option.jit_market_hash as `0x${string}` } : {}),
    premiumToken: option.premium_token as `0x${string}`,
    minPremiumPerShare: option.premium_per_share as string,
    orderSize: (sharesMax < sourceShares ? sharesMax : sourceShares).toString(),
  };
}
