// RFQ v2 writes are PROVEN: the venue accepts an open, an answer or a counter only with a
// signature by the writing address (or a partner API key). This module owns the two halves
// that must agree byte for byte — what cork_prepare_orders rfq-write hands out to sign, and
// what cork_submit checks before relaying — plus the venue gates both run first.

import { isAddressEqual } from "viem";
import { executionTypedData, type Envelope, type PrepareOrdersInput } from "@cork/schemas";
import { getRfq, type RfqKind, type RfqWriteAuth, venueBaseUrl } from "../datasources/venue.ts";
import { type ApiKeyDisclosure, resolveRfqApiKey } from "../credentials.ts";
import { erc20Abi } from "../chain/abis.ts";
import { hashLopOrder, LOP_ADDRESSES } from "../orders.ts";
import { planRfqWrite, type RfqWritePlan, type RfqWriteRequest } from "../rfq-bodies.ts";
import { parseQuotedOrder, quotedOptionTermsViolation } from "../rfq-quotes.ts";
import { rfqCounterKindFieldsViolation, rfqOpenKindFieldsViolation } from "../rfq-rollover.ts";
import { recoverEoaSigner, verifyMakerSignatureLadder } from "./order-auth.ts";
import { checkRolloverWrite, type RolloverOptionEcho } from "./rfq-rollover.ts";
import { envelope, getRpc, type HandlerContext, nowSecondsOf, unavailable, venueDepsOf, venueFailed } from "./shared.ts";

type Warning = { code: string; message: string };
type ChainId = PrepareOrdersInput["chainId"];

/** The record an answer or counter targets, or the refusal the venue would answer instead. */
export type RfqTarget =
  | { ok: true; rfq: Record<string, unknown> | undefined; kind: RfqKind | undefined }
  | { ok: false; code: string; message: string };

export function rfqKindOf(rfq: Record<string, unknown>): RfqKind {
  // Rows stored before kinds existed are new_position (the venue's own rfqKind rule).
  return rfq.kind === "rollover" ? "rollover" : "new_position";
}

/**
 * The venue's write gates that a read can predict, in the venue's own order (cork-api 0.4.5
 * src/modules/rfq/v2/routes/post-answer.ts / post-counter.ts): unknown RFQ (404 — an RFQ opened
 * on /rfqs/v1 is not served on v2 either), another kind (409), expired (410), and for a counter
 * a sender other than the requester (403). Refused here so a write never burns its request_id
 * on an answer the venue can only refuse. An open has no target.
 */
export async function readRfqTarget(ctx: HandlerContext, chainId: number, request: RfqWriteRequest): Promise<RfqTarget> {
  if (request.type === "rfq-open") return { ok: true, rfq: undefined, kind: undefined };
  const rfq = await getRfq(venueDepsOf(ctx), request.rfqId);
  if (!rfq) return { ok: false, code: "rfq_not_found", message: `RFQ '${request.rfqId}' is unknown to the venue's /rfqs/v2 (a normal outcome for a never-posted or mistyped id; an RFQ opened on the retired /rfqs/v1 is not served on v2 and cannot be written to from here)` };
  if (typeof rfq.chain_id === "number" && rfq.chain_id !== chainId) {
    return { ok: false, code: "invalid_order_terms", message: `RFQ '${request.rfqId}' is on chain ${rfq.chain_id}, not ${chainId} — the write is signed for the RFQ's own chain; pass chainId ${rfq.chain_id}` };
  }
  const kind = rfqKindOf(rfq);
  const what = request.type === "rfq-answer" ? "answer" : "counter";
  if (request.kind !== undefined && request.kind !== kind) {
    return { ok: false, code: "invalid_order_terms", message: `RFQ '${request.rfqId}' is kind "${kind}"; a "${request.kind}" ${what} cannot be posted on it (the venue would 409) — omit kind, the RFQ supplies it` };
  }
  if (rfq.state === "expired") {
    return { ok: false, code: "invalid_order_terms", message: `RFQ '${request.rfqId}' is expired — the venue no longer accepts ${what}s on it (would 410 on relay); post a fresh RFQ instead` };
  }
  if (request.type === "rfq-counter") {
    const requester = rfq.requester;
    if (typeof requester === "string" && requester.toLowerCase() !== request.requester.toLowerCase()) {
      return { ok: false, code: "invalid_order_terms", message: `only the RFQ's requester may counter: RFQ '${request.rfqId}' was opened by ${requester}, not ${request.requester} — the venue would 403 this on relay` };
    }
  }
  return { ok: true, rfq, kind };
}

/** The fields a write carries depend on its kind (an open names it; an answer or counter takes
 *  the RFQ's), and the venue's two kinds are separate strict schemas. Chain-free; returns the
 *  refusal text, or null. */
export function rfqKindFieldsViolation(request: RfqWriteRequest, kind: RfqKind | undefined): string | null {
  if (request.type === "rfq-open") return rfqOpenKindFieldsViolation(request);
  if (request.type === "rfq-counter" && kind !== undefined) return rfqCounterKindFieldsViolation(kind, request);
  return null;
}

/** The outcome of checking a supplied signature against the rebuilt body. */
export type RfqSignatureCheck =
  | { ok: true; how: "eoa" | "erc1271"; warnings: Warning[] }
  | { ok: false; message: string; recovered: `0x${string}` | null };

/**
 * Who signed this write, decided before relay [K3]: ecrecover over the typed-data digest first
 * (chain-free), then — when it does not recover to the signer — the ERC-1271 isValidSignature
 * read a contract wallet answers, the same ladder maker orders use. A signature nobody could
 * check (a possible contract signer with no RPC, a transport failure) is relayed with a warning:
 * the venue checks it either way.
 */
export async function checkRfqWriteSignature(ctx: HandlerContext, plan: RfqWritePlan, signature: `0x${string}`): Promise<RfqSignatureCheck> {
  const recovered = await recoverEoaSigner(plan.digest, signature);
  if (recovered.signer !== null && isAddressEqual(recovered.signer, plan.signer)) return { ok: true, how: "eoa", warnings: [] };
  const verdict = await verifyMakerSignatureLadder({ ctx, chainId: plan.chainId as ChainId, maker: plan.signer, orderHash: plan.digest, signature });
  switch (verdict.kind) {
    case "eoa":
      return { ok: true, how: "eoa", warnings: [] };
    case "erc1271":
      return { ok: true, how: "erc1271", warnings: [] };
    case "erc1271_transport":
      return { ok: true, how: "erc1271", warnings: [{ code: "chain_read_failed", message: `the signer ${plan.signer} has code, and its ERC-1271 isValidSignature read failed in transport (${verdict.reason}) — relayed unchecked; the venue checks the signature itself and answers 401 if the wallet refuses it` }] };
    case "erc1271_rejected":
      return { ok: false, message: `the signer ${plan.signer} is a contract wallet and its isValidSignature REJECTED this signature over the CorkRfqWrite digest ${plan.digest} (answer: ${verdict.isValidSignatureAnswer ?? "a revert"})`, recovered: null };
    case "unparseable":
      return { ok: false, message: `the signature could not be parsed (${verdict.reason})`, recovered: null };
    case "eoa_mismatch":
      if (verdict.codeProbe === "no-code") {
        return { ok: false, message: `the signature recovers to ${verdict.recoveredSigner}, not ${plan.signer} — it was made by another key, or over another body (bodyHash ${plan.bodyHash}; rebuild with cork_prepare_orders rfq-write using the SAME fields and clientRequestId)`, recovered: verdict.recoveredSigner };
      }
      return {
        ok: true,
        how: "eoa",
        warnings: [{ code: "chain_read_failed", message: `the signature recovers to ${verdict.recoveredSigner}, not ${plan.signer}, and ${verdict.codeProbe === "no-rpc" ? "no RPC resolved" : "the code read failed"} to ask whether ${plan.signer} is a contract wallet — relayed unchecked; the venue checks the signature and answers 401 if it does not prove the signer` }],
      };
  }
}

/** The venue's RFQ v2 quoted-answer rule (cork-api 0.4.5 post-answer.schema.ts): every option
 *  carries the 1inch `order` the underwriter stands behind, made by that underwriter, with its
 *  `order_signature` (the proof the venue checks when no API key is sent), and no two options
 *  carry the same order — mirrored, registered in MIRRORED_VENUE_LOGIC. Chain-free; checkQuotedOptions then re-hashes
 *  each order and proves its signature. Returns the refusal text, or null. */
export function answerOptionOrderViolation(underwriter: string, options: ReadonlyArray<Record<string, unknown>>): string | null {
  const seen = new Set<string>();
  for (const [i, o] of options.entries()) {
    const order = o.order;
    if (order === null || typeof order !== "object") return `options[${i}] carries no order: an RFQ v2 quote must carry the exact signed 1inch limit order the underwriter stands behind (order + order_signature) — cork_prepare_orders answer-rfq builds it`;
    const maker = (order as Record<string, unknown>).maker;
    if (typeof maker !== "string" || maker.toLowerCase() !== underwriter.toLowerCase()) return `options[${i}].order.maker (${String(maker)}) must be the answer's underwriter ${underwriter} (the venue rejects any other maker with a 400)`;
    if (typeof o.order_signature !== "string" || !/^0x[0-9a-fA-F]+$/.test(o.order_signature)) return `options[${i}].order_signature is missing: the underwriter's EIP-712 signature over the order is the venue's proof for a quoted answer (a 401 without it)`;
    const key = Object.entries(order as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${String(v).toLowerCase()}`).join("&");
    if (seen.has(key)) return `options[${i}] repeats another option's order: each option must carry a different order (the venue rejects two options sharing one order hash with a 400)`;
    seen.add(key);
  }
  return null;
}

/** What the checks found about one quoted option's order. */
export interface QuotedOrderCheck {
  optionId: string | null;
  orderHash: `0x${string}`;
  signerType: "eoa" | "erc1271" | "unchecked";
  notChecked: string[];
}

export type QuotedOptionsCheck =
  | { ok: true; quoted: QuotedOrderCheck[]; warnings: Warning[] }
  | { ok: false; envelope: Envelope };

/**
 * A quoted new_position answer, held to the orders it carries before it is signed or relayed:
 * each option on the RFQ's chain (the order is hashed for it), each order re-hashed under the
 * chain's LOP domain and distinct, each order signature proven by the underwriter (the same
 * ecrecover → ERC-1271 ladder a fill runs), and each option's terms agreeing with its order
 * (quotedOptionTermsViolation). The venue rejects the first two with a 400 and the third with
 * a 401; the terms check is ours — the venue checks them only through the top-level
 * signature, from cork-api PR #113 onward (older 0.4.5 builds did not).
 */
export async function checkQuotedOptions(ctx: HandlerContext, chainId: number, rfq: Record<string, unknown> | undefined, underwriter: string, options: ReadonlyArray<Record<string, unknown>>): Promise<QuotedOptionsCheck> {
  const refuse = (message: string): QuotedOptionsCheck => ({ ok: false, envelope: unavailable(chainId as ChainId, "invalid_order_terms", message, ctx) });
  const rfqChain = typeof rfq?.chain_id === "number" ? rfq.chain_id : chainId;
  const lop = LOP_ADDRESSES[rfqChain];
  if (!lop) return { ok: false, envelope: unavailable(chainId as ChainId, "no_lop", `orders cannot be quoted on chain ${rfqChain}: no 1inch Limit Order Protocol contract is known there (the venue would 400)`, ctx) };
  const resolved = await getRpc(ctx, chainId as ChainId);
  const nowSeconds = nowSecondsOf(ctx);
  const decimalsByToken = new Map<string, number | undefined>();
  const seen = new Map<string, number>();
  const quoted: QuotedOrderCheck[] = [];
  const warnings: Warning[] = [];
  for (const [i, option] of options.entries()) {
    if (option.chain_id !== rfqChain) return refuse(`options[${i}].chain_id must be the RFQ's chain (${rfqChain}): its order is hashed for that chain (the venue would 400) — got ${JSON.stringify(option.chain_id)}`);
    const parsed = parseQuotedOrder(option.order);
    if (!parsed.ok) return refuse(`options[${i}].${parsed.reason}`);
    const order = parsed.order;
    const orderHash = hashLopOrder(rfqChain, lop, order);
    const twin = seen.get(orderHash);
    if (twin !== undefined) return refuse(`options[${i}] and options[${twin}] carry the same order (hash ${orderHash}) — each option must carry a different order (the venue would 400); build one order per option`);
    seen.set(orderHash, i);
    const taker = order.takerAsset.toLowerCase();
    if (!decimalsByToken.has(taker)) {
      let decimals: number | undefined;
      if (resolved) {
        try {
          decimals = Number(await resolved.client.readContract({ address: order.takerAsset, abi: erc20Abi, functionName: "decimals" }));
        } catch {
          decimals = undefined;
        }
      }
      decimalsByToken.set(taker, decimals);
    }
    const terms = quotedOptionTermsViolation({ index: i, option, order, nowSeconds, collateralDecimals: decimalsByToken.get(taker) });
    if (terms.violation !== null) return refuse(terms.violation);
    const signature = option.order_signature as `0x${string}`;
    const verdict = await verifyMakerSignatureLadder({ ctx, chainId: rfqChain as ChainId, maker: order.maker, orderHash, signature, ...(resolved ? { client: resolved.client } : {}) });
    const refused = (why: string): QuotedOptionsCheck => ({
      ok: false,
      envelope: envelope({ state: "conflict", data: { optionIndex: i, orderHash, underwriter, relayed: false }, chainId: chainId as ChainId, source: "config", warnings: [{ code: "signature_or_reconstruction_mismatch", message: `options[${i}].order_signature ${why} — NOT relayed: the venue would refuse the answer with a 401. Sign the order typed data cork_prepare_orders answer-rfq returns, as the underwriter` }], ctx }),
    });
    let signerType: QuotedOrderCheck["signerType"];
    switch (verdict.kind) {
      case "eoa":
        signerType = "eoa";
        break;
      case "erc1271":
        signerType = "erc1271";
        break;
      case "erc1271_rejected":
        return refused(`is REJECTED by the underwriter's own isValidSignature (answer: ${verdict.isValidSignatureAnswer ?? "a revert"}) over order hash ${orderHash}`);
      case "unparseable":
        return refused(`cannot be parsed (${verdict.reason})`);
      case "eoa_mismatch":
        if (verdict.codeProbe === "no-code") return refused(`recovers to ${verdict.recoveredSigner}, not the underwriter ${order.maker}, over order hash ${orderHash}`);
        signerType = "unchecked";
        warnings.push({ code: "chain_read_failed", message: `options[${i}].order_signature recovers to ${verdict.recoveredSigner}, not ${order.maker}, and ${verdict.codeProbe === "no-rpc" ? "no RPC resolved" : "the code read failed"} to ask whether the underwriter is a contract wallet — not checked here; the venue checks it and answers 401 if it does not prove the underwriter` });
        break;
      case "erc1271_transport":
        signerType = "unchecked";
        warnings.push({ code: "chain_read_failed", message: `options[${i}].order_signature: the underwriter has code and its isValidSignature read failed in transport (${verdict.reason}) — not checked here; the venue checks it itself` });
        break;
    }
    quoted.push({ optionId: typeof option.option_id === "string" ? option.option_id : null, orderHash, signerType, notChecked: terms.notChecked });
  }
  return { ok: true, quoted, warnings };
}

/** The refusal for a signature that does not prove the write: not relayed. */
export function signatureRefused(chainId: number, plan: RfqWritePlan, message: string, ctx: HandlerContext): Envelope {
  return envelope({
    state: "conflict",
    data: { operation: plan.operation, expectedSigner: plan.signer, bodyHash: plan.bodyHash, digest: plan.digest, relayed: false },
    chainId: chainId as ChainId,
    source: "config",
    warnings: [{ code: "signature_or_reconstruction_mismatch", message: `${message} — NOT relayed: the venue would refuse it with a 401` }],
    ctx,
  });
}

/** The caller's choice of proof, before anything is read or sent. A chosen API key must resolve
 *  here, so a write that cannot be proven refuses without touching the venue. */
export type RfqAuthChoice = { method: "signature"; signature: `0x${string}` } | { method: "apiKey"; key: string; disclosure: ApiKeyDisclosure };

export async function resolveRfqAuth(
  ctx: HandlerContext,
  chainId: number,
  auth: { method: "signature"; signature: `0x${string}` } | { method: "apiKey" },
): Promise<{ ok: true; auth: RfqAuthChoice } | { ok: false; envelope: Envelope }> {
  if (auth.method === "signature") return { ok: true, auth };
  // A shared HTTP endpoint would write every caller's RFQs under the operator's own key.
  if (ctx.apiKeys === "refuse") {
    return { ok: false, envelope: unavailable(chainId as ChainId, "api_key_missing", "auth {method: 'apiKey'} is refused on the HTTP MCP endpoint: the server's keys belong to its operator, and using them would let every caller write RFQs as the operator. Nothing was sent. Use auth {method: 'signature'}, or run the stdio server or the CLI with your own key", ctx) };
  }
  const resolved = await resolveRfqApiKey({ venueUrl: venueBaseUrl(ctx.venueUrl), ...(ctx.profile !== undefined ? { profile: ctx.profile } : {}) });
  if (!resolved.ok) return { ok: false, envelope: unavailable(chainId as ChainId, "api_key_missing", `auth {method: 'apiKey'}: ${resolved.message}. Nothing was sent`, ctx) };
  return { ok: true, auth: { method: "apiKey", key: resolved.key, disclosure: resolved.disclosure } };
}

export type RfqWriteProof =
  | {
      ok: true;
      how: "eoa" | "erc1271" | "api-key";
      warnings: Warning[];
      /** What the relay carries: the signature in the body, or the key in the header only. */
      bodyExtra: { signature?: `0x${string}` };
      venueAuth: RfqWriteAuth | undefined;
      /** What the result says about the proof — never the key itself. */
      disclosure: { method: "signature" } | ApiKeyDisclosure;
    }
  | { ok: false; message: string };

/** A signature is checked against the exact body before relay [K3]; a key is the venue's to check. */
export async function proveRfqWrite(ctx: HandlerContext, plan: RfqWritePlan, auth: RfqAuthChoice): Promise<RfqWriteProof> {
  if (auth.method === "apiKey") return { ok: true, how: "api-key", warnings: [], bodyExtra: {}, venueAuth: { apiKey: auth.key }, disclosure: auth.disclosure };
  const check = await checkRfqWriteSignature(ctx, plan, auth.signature);
  if (!check.ok) return { ok: false, message: check.message };
  return { ok: true, how: check.how, warnings: check.warnings, bodyExtra: { signature: auth.signature }, venueAuth: undefined, disclosure: { method: "signature" } };
}

/** cork_prepare_orders rfq-write: the typed data a write is signed with [K1]. */
export async function handleRfqWrite(input: PrepareOrdersInput, action: Extract<PrepareOrdersInput["action"], { type: "rfq-write" }>, ctx: HandlerContext): Promise<Envelope> {
  const chainId = input.chainId;
  const request = action.request as RfqWriteRequest;
  try {
    const target = await readRfqTarget(ctx, chainId, request);
    if (!target.ok) return unavailable(chainId, target.code, target.message, ctx);
    const fieldsProblem = rfqKindFieldsViolation(request, target.kind);
    if (fieldsProblem) return unavailable(chainId, "invalid_order_terms", fieldsProblem, ctx);
    const rollover = request.type === "rfq-open" ? request.kind === "rollover" : target.kind === "rollover";
    // A rollover write is held to the venue's rollover rules before it is signed — the same
    // checks cork_submit runs again before relay.
    let rolloverCheck: { warnings: Array<{ code: string; message: string }>; options?: RolloverOptionEcho[] } = { warnings: [] };
    if (rollover) {
      const checked = await checkRolloverWrite(ctx, chainId, request, target.rfq);
      if (!checked.ok) return checked.envelope;
      rolloverCheck = checked;
    }
    // A quoted answer is signed over the orders it carries, so they are checked before the
    // typed data is handed out — the same checks cork_submit runs again before relay.
    let quotedCheck: QuotedOptionsCheck = { ok: true, quoted: [], warnings: [] };
    if (!rollover && request.type === "rfq-answer" && request.status === "quoted") {
      const orderProblem = answerOptionOrderViolation(request.underwriter, request.options ?? []);
      if (orderProblem) return unavailable(chainId, "invalid_order_terms", orderProblem, ctx);
      quotedCheck = await checkQuotedOptions(ctx, chainId, target.rfq, request.underwriter, request.options ?? []);
      if (!quotedCheck.ok) return quotedCheck.envelope;
    }
    const plan = planRfqWrite({ chainId, clientRequestId: input.clientRequestId, request, ...(target.kind ? { target: { kind: target.kind } } : {}) });
    if (!isAddressEqual(plan.signer, input.account)) {
      const role = plan.operation === "answer" ? "underwriter" : "requester";
      return unavailable(chainId, "invalid_order_terms", `the ${role} (${plan.signer}) must sign this ${plan.operation}, but account is ${input.account} — set account to the ${role}`, ctx);
    }
    return envelope({
      state: "ok",
      data: {
        kind: "rfq-write",
        operation: plan.operation,
        ref: plan.ref,
        signer: plan.signer,
        rfqKind: (plan.body.kind as RfqKind | undefined) ?? null,
        body: plan.body,
        bodyHash: plan.bodyHash,
        typedData: plan.typedData,
        digest: plan.digest,
        submitAction: { ...request, ...(request.type !== "rfq-open" ? { kind: plan.body.kind } : {}) },
        execution: executionTypedData([
          `sign the typed-data client-side as ${plan.signer} (eth_signTypedData_v4, 'Cork RFQ' domain, chain ${chainId})`,
          `cork_submit ${request.type} with action = submitAction plus auth {method: 'signature', signature}, and the SAME clientRequestId (it is the write's request_id — the body, and so the signature, depend on it)`,
          ...(quotedCheck.ok && quotedCheck.quoted.length > 0 ? ["then post each quoted order to the book: cork_submit lop-order with its finalize-maker-order submitInput plus quoteRef {rfqId, answerId (from the rfq-answer result), optionId} — the venue refuses an order already on the book in an answer, so the answer goes first"] : []),
        ]),
        ...(quotedCheck.ok && quotedCheck.quoted.length > 0 ? { quotedOrders: quotedCheck.quoted } : {}),
        ...(rolloverCheck.options !== undefined ? { rolloverOptions: rolloverCheck.options } : {}),
        clientRequestId: input.clientRequestId,
      },
      chainId,
      source: request.type === "rfq-open" ? "config" : "service",
      ...(quotedCheck.ok && quotedCheck.warnings.length + rolloverCheck.warnings.length > 0 ? { warnings: [...quotedCheck.warnings, ...rolloverCheck.warnings] } : {}),
      ctx,
    });
  } catch (err) {
    return venueFailed(chainId, err, ctx);
  }
}
