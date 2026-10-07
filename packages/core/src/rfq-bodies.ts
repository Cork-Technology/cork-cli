// The exact RFQ v2 write bodies, built ONCE for both cork_prepare_orders rfq-write (which returns
// what to sign) and cork_submit (which relays it): the venue hashes what it stores, so a byte
// that differs between the two refuses the signature with a 401.
//
// The venue stores — and so hashes — every address and bytes32 LOWERCASED (its HexAddressSchema
// and HexBytes32Schema transforms); a template id and oracle_params values keep their case.

import { hashTypedData, type Hex } from "viem";
import type { SubmitInput } from "@cork/schemas";
import { rfqWriteBodyHash, rfqWriteTypedData, type RfqOperation } from "./rfq-signing.ts";
import { rolloverOptionToWire } from "./rfq-rollover.ts";
import type { RfqKind } from "./datasources/venue.ts";

type SubmitAction = SubmitInput["action"];
type WithoutAuth<T> = Omit<T, "auth">;
export type RfqOpenRequest = WithoutAuth<Extract<SubmitAction, { type: "rfq-open" }>>;
export type RfqAnswerRequest = WithoutAuth<Extract<SubmitAction, { type: "rfq-answer" }>>;
export type RfqCounterRequest = WithoutAuth<Extract<SubmitAction, { type: "rfq-counter" }>>;
export type RfqWriteRequest = RfqOpenRequest | RfqAnswerRequest | RfqCounterRequest;

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;

/** An address or bytes32 as the venue stores it; anything else is left for the venue to refuse. */
function lower(v: unknown): unknown {
  return typeof v === "string" && (ADDRESS.test(v) || BYTES32.test(v)) ? v.toLowerCase() : v;
}

function lowerSpec(spec: unknown): unknown {
  if (spec === null || typeof spec !== "object") return spec;
  const s = spec as Record<string, unknown>;
  if ("exact" in s) return { ...s, exact: lower(s.exact) };
  if (Array.isArray(s.one_of)) return { ...s, one_of: s.one_of.map(lower) };
  return spec;
}

function lowerTemplate(template: unknown): unknown {
  if (template === null || typeof template !== "object") return template;
  const t = template as Record<string, unknown>;
  const inline = t.inline;
  if (inline === null || typeof inline !== "object") return template;
  return { ...t, inline: { ...(inline as Record<string, unknown>), oracle_recipe: lower((inline as Record<string, unknown>).oracle_recipe) } };
}

const ORDER_ADDRESS_KEYS = ["maker", "receiver", "makerAsset", "takerAsset"] as const;
const JIT_MARKET_LOWERED_KEYS = ["collateralAsset", "referenceAsset", "recipe", "oracleSalt"] as const;

function lowerKeys(o: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out = { ...o };
  for (const k of keys) if (k in out) out[k] = lower(out[k]);
  return out;
}

/** One answer option as the venue stores it, for either kind. */
function lowerOption(option: Record<string, unknown>): Record<string, unknown> {
  const out = lowerKeys(option, ["collateral_asset", "reference_asset", "premium_token"]);
  if ("market_template" in out) out.market_template = lowerTemplate(out.market_template);
  if (out.order !== null && typeof out.order === "object") out.order = lowerKeys(out.order as Record<string, unknown>, ORDER_ADDRESS_KEYS);
  const destination = out.destination;
  if (destination !== null && typeof destination === "object") {
    const d = destination as Record<string, unknown>;
    if ("pool_id" in d) out.destination = { ...d, pool_id: lower(d.pool_id) };
    else if (d.jit_market !== null && typeof d.jit_market === "object") {
      const jit = lowerKeys(d.jit_market as Record<string, unknown>, JIT_MARKET_LOWERED_KEYS);
      // The venue lowercases the recipe bytes too (JitMarketSchema.additionalData transform).
      if (typeof jit.additionalData === "string") jit.additionalData = jit.additionalData.toLowerCase();
      out.destination = { ...d, jit_market: jit };
    }
  }
  return out;
}

/** The body of an RFQ open, without its proof. The two kinds carry different fields
 *  (rfqOpenKindFieldsViolation has already refused a mix). */
export function rfqOpenBody(chainId: number, requestId: string, a: RfqOpenRequest): Record<string, unknown> {
  const shared = {
    schema_version: "2",
    kind: a.kind,
    request_id: requestId,
    requester: lower(a.requester),
    chain_id: chainId,
  };
  const window = { not_before: a.expiryWindow.notBefore, not_after: a.expiryWindow.notAfter };
  const template = a.marketTemplate ? { market_template: lowerTemplate(a.marketTemplate) } : {};
  if (a.kind === "rollover") {
    return {
      ...shared,
      source: { pool_id: lower(a.source?.poolId), shares: a.source?.shares },
      reference_asset: lower(a.referenceAsset),
      collateral_asset: lowerSpec(a.collateralAsset),
      expiry_window: window,
      ...template,
      premium_token: lowerSpec(a.premiumToken),
      valid_until: a.validUntil,
    };
  }
  return {
    ...shared,
    reference_asset: lower(a.referenceAsset),
    collateral_asset: lowerSpec(a.collateralAsset),
    modes: a.modes,
    package_ids: a.packageIds,
    expiry_window: window,
    ...template,
    notional_assets: a.notionalAssets,
    valid_until: a.validUntil,
  };
}

/** The body of an answer, without its proofs. `kind` is the target RFQ's. */
export function rfqAnswerBody(kind: RfqKind, requestId: string, a: RfqAnswerRequest): Record<string, unknown> {
  return {
    schema_version: "2",
    kind,
    request_id: requestId,
    underwriter: lower(a.underwriter),
    status: a.status,
    ...(a.status === "quoted" ? { options: (a.options ?? []).map((o) => lowerOption(kind === "rollover" ? rolloverWireOption(o) : o)) } : { reason_code: a.reasonCode ?? "PASS" }),
    // Optional revision link (venue-validated: must cite an OWN prior answer on this RFQ).
    ...(a.supersedes !== undefined ? { supersedes: a.supersedes } : {}),
  };
}

/** A rollover option written with a `destination.jitMarket` input block, in its wire shape.
 *  An option the converter refuses is left as given: the write checks refuse it first. */
function rolloverWireOption(option: Record<string, unknown>): Record<string, unknown> {
  const converted = rolloverOptionToWire(option);
  return converted.ok ? converted.option : option;
}

/** The body of a counter, without its proof. `kind` is the target RFQ's, and decides the unit
 *  the bid is priced in. */
export function rfqCounterBody(kind: RfqKind, requestId: string, a: RfqCounterRequest): Record<string, unknown> {
  return {
    schema_version: "2",
    kind,
    request_id: requestId,
    requester: lower(a.requester),
    ...(kind === "rollover" ? { premium_per_share: a.premiumPerShare, premium_token: lower(a.premiumToken) } : { premium_annualized: a.premiumAnnualized }),
    ...(a.optionRef ? { option_ref: { answer_id: a.optionRef.answerId, option_id: a.optionRef.optionId } } : {}),
    ...(a.freshUntil !== undefined ? { fresh_until: a.freshUntil } : {}),
  };
}

/** Everything a signed write needs: the body, the address that must prove it, and the typed
 *  data that address signs. `target` is the RFQ an answer or counter is posted on — its chain
 *  and kind, read from the venue, are authoritative. */
export interface RfqWritePlan {
  operation: RfqOperation;
  ref: string;
  chainId: number;
  signer: `0x${string}`;
  body: Record<string, unknown>;
  bodyHash: Hex;
  typedData: ReturnType<typeof rfqWriteTypedData>;
  digest: Hex;
}

export function planRfqWrite(a: { chainId: number; clientRequestId: string; request: RfqWriteRequest; target?: { kind: RfqKind } }): RfqWritePlan {
  const r = a.request;
  let operation: RfqOperation;
  let ref: string;
  let signer: string;
  let body: Record<string, unknown>;
  if (r.type === "rfq-open") {
    operation = "open";
    ref = a.clientRequestId;
    signer = r.requester;
    body = rfqOpenBody(a.chainId, a.clientRequestId, r);
  } else {
    const kind = a.target?.kind ?? r.kind ?? "new_position";
    ref = r.rfqId;
    if (r.type === "rfq-answer") {
      operation = "answer";
      signer = r.underwriter;
      body = rfqAnswerBody(kind, a.clientRequestId, r);
    } else {
      operation = "counter";
      signer = r.requester;
      body = rfqCounterBody(kind, a.clientRequestId, r);
    }
  }
  const bodyHash = rfqWriteBodyHash(operation, body);
  const typedData = rfqWriteTypedData({ operation, ref, chainId: a.chainId, bodyHash });
  return { operation, ref, chainId: a.chainId, signer: signer.toLowerCase() as `0x${string}`, body, bodyHash, typedData, digest: hashTypedData(typedData) };
}
