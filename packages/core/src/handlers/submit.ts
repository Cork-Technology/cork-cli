// Split from handlers.ts (2026-08-05): submit handlers — one typed dispatch, per-tool modules.
// Declarations are moved byte-identically; see handlers.ts for the runTool dispatch.
import { isAddressEqual, recoverAddress } from "viem";
import { Envelope, SubmitInput, UNITS_TOPIC_REFERENCE } from "@cork/schemas";
import { decodeMakerTraits, ERC1271_MAGIC, erc1271Abi, hashLopOrder, LOP_ADDRESSES, saltExtensionBinding } from "../orders.ts";
import { resolveRollover } from "../config-remote.ts";
import { checkRolloverOrderTerms, classifyRolloverSettler, computeOrderDigest, intentStructHash, ORDER_DATA_TYPEHASH, retiredSettlerTeaching, ZERO_JIT_MARKET_HASH, type OrderDataStruct, type RolloverIntentStruct } from "../rollover.ts";
import { getRfq, postLopOrder, postRfq, postRfqAnswer, postRfqCounter, postRolloverOrder, type VenuePostResult } from "../datasources/venue.ts";
import { envelope, firstLine, getRpc, type HandlerContext, isTransportFailure, nowSecondsOf, unavailable, venueDepsOf, venueFailed } from "./shared.ts";
import { venueNoticeWarnings } from "./query.ts";

/**
 * The venue's PremiumFractionSchema, replicated operation-for-operation (cork-indexing-api
 * src/modules/rfq/v1/schemas/rfq-common.schema.ts): shape by the same regex, the < 0.5 cap by
 * the SAME `Number.parseFloat` its zod refine runs. An earlier form here decided the cap on
 * the string ("first fractional digit >= 5") on the theory that floats falsely rejected a
 * 17-digit "0.49999999999999999" — but the venue itself parses that value to exactly 0.5 and
 * 400s it, so the string form was permissive by one ulp relative to the server it exists to
 * predict. Both forms are deterministic; this one is the deployed one.
 * Returns a human-readable violation, or null when the venue would accept the value.
 *
 * The two branches are DIFFERENT LAYERS and the messages say so (COR-35 ruling, 2026-08-10):
 * the regex is STRUCTURE — in the published openapi.json on both write paths, and pinned by
 * R13 (a field's unit never changes in place; a WAD variant would be a NEW field name). The
 * < 0.5 cap is POLICY — server-enforced but spec-invisible (zod refines don't export) and
 * pilot posture (a short-tenor distressed market could legitimately annualize above 50%).
 * Teaching them as one thing would over-fit callers to a bound that is expected to move.
 */
export function premiumFractionViolation(p: unknown): string | null {
  if (typeof p !== "string" || !/^(0|0\.\d{1,18})$/.test(p)) return "not a decimal-fraction string — STRUCTURE: the RFC-pinned wire shape (openapi pattern ^(0|0\\.[0-9]{1,18})$), permanent under R13 (a unit never changes in place; a WAD variant would be a NEW field name)";
  if (Number.parseFloat(p) >= 0.5) return "parses to >= 0.5 — the venue decides this cap via Number.parseFloat, so a decimal within one float-ulp of 0.5 is rejected there too. POLICY, not structure: pilot posture, spec-invisible, relaxable — expect this bound to move someday, never the fraction shape";
  return null;
}

/**
 * The BOOK's premium_annualized contract (cork-api 0.3.3 post-order.schema.ts), replicated
 * operation-for-operation — deliberately a SEPARATE function from the RFQ gate above, because
 * the two surfaces share the fraction convention but not the bounds: the RFQ caps at < 0.5
 * (pilot posture), the book at <= 100 (the mirror of its legacy 10000% percent ceiling).
 * Same layering as above: the regex is STRUCTURE (published in the venue's openapi.json), the
 * 100 bound is a zod refine — server-enforced, spec-prose-only, and policy.
 */
export function bookPremiumAnnualizedViolation(p: unknown): string | null {
  if (typeof p !== "string" || !/^\d{1,3}(\.\d{1,18})?$/.test(p)) return 'is not a decimal-fraction string — STRUCTURE: the book listing\'s published wire shape (openapi pattern ^\\d{1,3}(\\.\\d{1,18})?$, "0.041" = 4.1% annualized)';
  if (Number.parseFloat(p) > 100) return "parses above 100 (= 10000% annualized) — the venue's refine bound, the mirror of the legacy percent field's 10000 ceiling. POLICY, not structure: relaxable someday, never the fraction shape";
  return null;
}

/** A refused listing premium, mapped by the caller onto its envelope vocabulary: every problem
 *  is a caller mistake (unavailable/invalid_order_terms) — `removed` is the sunset percent
 *  field, `missing`/`fraction` are the successor field absent or malformed. */
export type ListingPremiumResolution =
  | { ok: true; premiumPct: number }
  | { ok: false; problem: "removed" | "missing" | "fraction"; message: string };

/**
 * The venue's listing-premium RESOLUTION (cork-api 0.3.15 post-order.ts), replicated
 * operation-for-operation: `premium_annualized` is the ONE premium field since the percent
 * `premium` completed its sunset on 2026-08-17 — the venue answers a pointed 400 on `premium`
 * presence (a preValidation gate, not a silent schema strip), and we refuse before relay with
 * the same teaching. The fraction canonicalizes by `Number.parseFloat × 100`. ONE function for
 * both call sites — cork_submit lop-order (the relay) and finalize-maker-order (which emits a
 * relayable submitInput and must therefore refuse the same listings the relay would, BEFORE the
 * caller's policy gate admits the artifact) — so the two gates cannot drift apart and teach
 * differently.
 */
/** The exact fraction spelling for a percent number: shift the decimal point two places left
 *  on the number's canonical STRING — never float division, which emits the very artifacts
 *  (0.040999999999999995, 1e-7) the teaching polices. Returns undefined for a repr string
 *  math cannot shift exactly (scientific notation) — the caller then omits the suggestion. */
export function percentToFractionString(premium: number): string | undefined {
  const repr = String(premium);
  if (!/^\d+(\.\d+)?$/.test(repr)) return undefined;
  const [int = "0", dec = ""] = repr.split(".");
  const digits = int.padStart(3, "0");
  const shifted = `${digits.slice(0, -2)}.${digits.slice(-2)}${dec}`.replace(/\.$/, "");
  // canonicalize: strip leading zeros to one, trailing zeros after the point
  return shifted.replace(/^0+(?=\d)/, "").replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}

export function resolveListingPremium(premium: number | undefined, premiumAnnualized: string | undefined): ListingPremiumResolution {
  if (premium !== undefined) {
    const suggestion = premiumAnnualized === undefined ? percentToFractionString(premium) : undefined;
    return { ok: false, problem: "removed", message: `the percent-number premium field was REMOVED by the venue on 2026-08-17 (its scheduled sunset) — it now answers a pointed 400 on presence, so nothing was relayed. Send only premiumAnnualized: the annualized decimal-fraction STRING ("0.041" = 4.1%), same name and convention as the RFQ surface${suggestion !== undefined ? ` (for ${premium}%, that is "${suggestion}")` : ""}. Full scale table: ${UNITS_TOPIC_REFERENCE}` };
  }
  if (premiumAnnualized === undefined) {
    return { ok: false, problem: "missing", message: `a listing premium is required: send premiumAnnualized, the annualized decimal-fraction STRING ("0.041" = 4.1%) shared with the RFQ surface. The percent-number premium field was removed 2026-08-17. Full scale table: ${UNITS_TOPIC_REFERENCE}` };
  }
  const violation = bookPremiumAnnualizedViolation(premiumAnnualized);
  if (violation) {
    return { ok: false, problem: "fraction", message: `premiumAnnualized ${JSON.stringify(premiumAnnualized)} ${violation}; percent numbers (4.1) were the REMOVED premium field's convention and do not belong here. Full scale table: ${UNITS_TOPIC_REFERENCE}` };
  }
  return { ok: true, premiumPct: Number.parseFloat(premiumAnnualized) * 100 };
}

/**
 * Resolve a cited option inside a fetched RFQ record. The venue validates citations against
 * its DATABASE (post-order / post-counter read rfq_answers by id), but the single-get embed
 * we pre-flight against is READ-BOUNDED (READ_LIMIT rows, flagged `truncated`) — so a missing
 * row proves absence only when the embed is complete. `unresolved` = the citation may exist
 * beyond the truncation horizon; the caller relays and lets the venue's full-store check rule.
 */
function resolveCitedOption(rfq: Record<string, unknown>, answerId: string, optionId: string): { option: Record<string, unknown> | undefined; unresolved: boolean } {
  const answers = (rfq.answers ?? []) as Array<{ answer_id?: unknown; answer?: { options?: Array<Record<string, unknown>> } }>;
  const answer = answers.find((a) => String(a.answer_id) === answerId);
  const option = answer?.answer?.options?.find((o) => String(o.option_id) === optionId);
  return { option, unresolved: option === undefined && rfq.truncated === true };
}

export async function handleSubmit(input: SubmitInput, ctx: HandlerContext): Promise<Envelope> {
  const chainId = input.chainId;
  const action = input.action;
  const deps = venueDepsOf(ctx);

  /** Shared POST-outcome mapping (201 created / 200 idempotent replay / 4xx per venue docs).
   *  Successful relays also surface the venue's own in-band notices — the body `warnings[]`
   *  channel (cork-api 0.3.3+; deprecations announce their removal dates there) and the
   *  deprecated-path rewrite's canonical-path header. */
  const mapPost = (res: VenuePostResult, okData: (body: Record<string, unknown>, replay: boolean) => Record<string, unknown>, okWarnings: Array<{ code: string; message: string }> = []): Envelope => {
    const body = (res.body ?? {}) as Record<string, unknown>;
    const msg = typeof body.message === "string" ? body.message : `HTTP ${res.httpStatus}`;
    if (res.httpStatus === 201 || res.httpStatus === 200) {
      const notices = venueNoticeWarnings({
        venueWarnings: Array.isArray(body.warnings) ? (body.warnings.filter((w) => w !== null && typeof w === "object") as Array<Record<string, unknown>>) : [],
        ...(res.deprecatedPath !== undefined ? { deprecatedPath: res.deprecatedPath } : {}),
      });
      return envelope({ state: "ok", data: okData(body, res.httpStatus === 200), chainId, source: "service", warnings: [...okWarnings, ...notices], ctx });
    }
    if (res.httpStatus === 409) {
      return envelope({ state: "conflict", data: { venueResponse: body }, chainId, source: "service", warnings: [{ code: "venue_conflict", message: `venue 409: ${msg} (same id/digest already stored with a DIFFERENT payload — use a fresh clientRequestId for a genuinely new request [K2])` }], ctx });
    }
    if (res.httpStatus === 429) {
      return unavailable(chainId, "venue_rate_limited", `venue 429: ${msg}${res.retryAfterSeconds !== undefined ? ` — retry after ${res.retryAfterSeconds}s` : ""} (per-user open-order caps / 100 req/min per IP)`, ctx);
    }
    if (res.httpStatus === 404 || res.httpStatus === 410 || res.httpStatus === 422) {
      return unavailable(chainId, "venue_rejected", `venue ${res.httpStatus}: ${msg}${res.httpStatus === 422 ? " (permanent for this RFQ — do not retry)" : ""}`, ctx);
    }
    if (res.httpStatus >= 500) {
      // A server-side failure is not a rejection of the payload — mark it retryable.
      return unavailable(chainId, "venue_unreachable", `venue server error ${res.httpStatus}: ${msg} — likely transient; retry with the SAME clientRequestId [K2]`, ctx);
    }
    return unavailable(chainId, "venue_rejected", `venue ${res.httpStatus}: ${msg}`, ctx);
  };

  try {
    if (action.type === "rollover-order") {
      const o = action.order;
      // Single-chain protocol: the routing fields must match the target chain (venue rejects too).
      if (o.originChainId !== String(chainId) || o.destinationChainId !== String(chainId)) {
        return unavailable(chainId, "invalid_order_terms", `originChainId/destinationChainId must equal chainId ${chainId} (single-chain rollover)`, ctx);
      }
      // [F14] Re-run the settler/term checks the prepare path enforces — a submit-only caller
      // must not be able to relay an order the prepare path would have refused to build.
      // Non-fatal findings (unrecognized settler, missing config) ride the OK envelope as
      // warnings — prepare's relay-with-warning posture, previously silently skipped here.
      const settlerWarnings: Array<{ code: string; message: string }> = [];
      const hookStructs = (hooks: typeof action.intent.preRolloverHooks) =>
        hooks.map((h) => ({ target: h.target, value: BigInt(h.value), callData: h.callData, allowFailure: h.allowFailure, isDelegateCall: h.isDelegateCall }));
      {
        const { rollover } = await resolveRollover(chainId);
        if (rollover) {
          const cls = classifyRolloverSettler(rollover, o.settler);
          if (cls.status === "retired") {
            return unavailable(chainId, "settler_retired", retiredSettlerTeaching(o.settler, cls, rollover), ctx);
          }
          if (cls.status === "active" && cls.kind === "EXACT" && o.allowPartialFills) {
            return unavailable(chainId, "settler_mode_mismatch", `settler ${o.settler} is the ExactSettler, which rejects allowPartialFills:true on-chain — this signed order is unfillable; re-sign against the PartialSettler ${rollover.partialSettler} or with allowPartialFills:false`, ctx);
          }
          if (cls.status === "active" && cls.kind === "PARTIAL" && !o.allowPartialFills) {
            return unavailable(chainId, "settler_mode_mismatch", `settler ${o.settler} is the PartialSettler, which rejects allowPartialFills:false on-chain — this signed order is unfillable; re-sign against the ExactSettler ${rollover.exactSettler} or with allowPartialFills:true`, ctx);
          }
          if (cls.status === "unknown") {
            settlerWarnings.push({ code: "settler_not_recognized", message: `settler ${o.settler} is not a configured Cork settler for chainId ${chainId} (exact ${rollover.exactSettler}, partial ${rollover.partialSettler}) — relayed, but verify the address before counting on settlement` });
          }
        } else {
          settlerWarnings.push({ code: "settler_not_recognized", message: `no rollover deployment configured for chainId ${chainId} — the settler/mode coherence checks could not run; relayed unverified` });
        }
        // Deterministic venue-admission battery (shared with prepare; a violation is the venue's
        // 400 pre-flighted locally — NOT relayed). Chain-dependent admission (hook-target code
        // existence, the settler resolveFor preflight) stays venue-side.
        const violation = checkRolloverOrderTerms({
          nowSeconds: nowSecondsOf(ctx),
          openDeadline: BigInt(o.openDeadline),
          fillDeadline: BigInt(o.fillDeadline),
          orderSize: BigInt(o.orderSize),
          minPremiumPerShare: BigInt(o.minPremiumPerShare),
          srcCstToken: o.srcCstToken,
          dstCstToken: o.dstCstToken,
          premiumToken: o.premiumToken,
          srcPoolId: o.rolloverParams.srcPoolId,
          dstPoolId: o.rolloverParams.dstPoolId,
          settler: o.settler,
          exclusiveFiller: o.exclusiveFiller,
          intentDeadline: BigInt(action.intent.deadline),
          hooks: hookStructs([...action.intent.preRolloverHooks, ...action.intent.midRolloverHooks, ...action.intent.postRolloverHooks, ...action.intent.premiumHooks]),
        });
        if (violation) return unavailable(chainId, "invalid_order_terms", `${violation} — NOT relayed (the venue rejects it with the same complaint)`, ctx);
        if (o.rolloverParams.jitMarketHash.toLowerCase() !== ZERO_JIT_MARKET_HASH) {
          settlerWarnings.push({ code: "jit_market_notice", message: "this order commits to just-in-time DESTINATION-market creation (non-zero jitMarketHash) — the venue's admission (cork-api ≤0.3.16) requires the destination cST/pool to already be INDEXED, with no jitMarketHash bypass: expect a venue 400 until the dst pool exists on-chain; the signed order itself stays contract-valid and can be handed to a filler venue-free" });
        }
      }
      if (o.rolloverParams.settler.toLowerCase() !== o.settler.toLowerCase() || o.rolloverParams.srcCstToken.toLowerCase() !== o.srcCstToken.toLowerCase() || o.rolloverParams.dstCstToken.toLowerCase() !== o.dstCstToken.toLowerCase()) {
        return unavailable(chainId, "invalid_order_terms", "rolloverParams (settler/srcCstToken/dstCstToken) must mirror OrderData exactly — the venue rejects mismatches", ctx);
      }
      if (action.intent.rolloverContract.toLowerCase() !== o.rolloverContract.toLowerCase()) {
        return unavailable(chainId, "invalid_order_terms", "intent.rolloverContract must equal order.rolloverContract", ctx);
      }
      // [K3] Recompute the zero-digest intent commitment; a payload whose hooks do not hash to
      // the signed rolloverIntentHash is NOT relayed — the venue would reject it, and relaying
      // would leak a broken payload.
      const intentStruct: RolloverIntentStruct = {
        rolloverContract: action.intent.rolloverContract,
        orderDigest: `0x${"00".repeat(32)}`,
        deadline: BigInt(action.intent.deadline),
        nonce: BigInt(action.intent.nonce),
        preRolloverHooks: hookStructs(action.intent.preRolloverHooks),
        midRolloverHooks: hookStructs(action.intent.midRolloverHooks),
        postRolloverHooks: hookStructs(action.intent.postRolloverHooks),
        premiumHooks: hookStructs(action.intent.premiumHooks),
      };
      const recomputedIntentHash = intentStructHash(intentStruct);
      if (recomputedIntentHash.toLowerCase() !== o.rolloverIntentHash.toLowerCase()) {
        return envelope({
          state: "conflict",
          data: { claimed: o.rolloverIntentHash, recomputed: recomputedIntentHash },
          chainId,
          source: "config",
          warnings: [{ code: "intent_hash_mismatch", message: "intent does not hash to order.rolloverIntentHash (zero-digest EIP-712 struct hash) — the payload was NOT relayed; the intent or the signed order is inconsistent (formerly digest_mismatch)" }],
          ctx,
        });
      }
      // Recompute the ERC-7683 orderDigest locally so the venue's answer can be cross-checked.
      const orderStruct: OrderDataStruct = {
        user: o.user,
        settler: o.settler,
        fillerHint: o.fillerHint,
        exclusiveFiller: o.exclusiveFiller,
        srcCstToken: o.srcCstToken,
        dstCstToken: o.dstCstToken,
        premiumToken: o.premiumToken,
        rolloverContract: o.rolloverContract,
        originChainId: BigInt(o.originChainId),
        destinationChainId: BigInt(o.destinationChainId),
        openDeadline: BigInt(o.openDeadline),
        fillDeadline: BigInt(o.fillDeadline),
        orderSalt: BigInt(o.orderSalt),
        orderSize: BigInt(o.orderSize),
        minPremiumPerShare: BigInt(o.minPremiumPerShare),
        allowPartialFills: o.allowPartialFills,
        allowUnderfill: o.allowUnderfill,
        premiumPaymentMode: o.premiumPaymentMode,
        rolloverIntentHash: o.rolloverIntentHash,
        rolloverParams: {
          srcCstToken: o.rolloverParams.srcCstToken,
          dstCstToken: o.rolloverParams.dstCstToken,
          minCaReceived: BigInt(o.rolloverParams.minCaReceived),
          minSharesOut: BigInt(o.rolloverParams.minSharesOut),
          srcPoolId: o.rolloverParams.srcPoolId,
          dstPoolId: o.rolloverParams.dstPoolId,
          settler: o.rolloverParams.settler,
          jitMarketHash: o.rolloverParams.jitMarketHash,
        },
      };
      const localDigest = computeOrderDigest(chainId, orderStruct);
      // [F14/K3] Recover the signature against the locally recomputed EIP-712 digest: a garbage-
      // or foreign-signed order must not relay (it would rest at the venue but never fill).
      try {
        const recovered = await recoverAddress({ hash: localDigest, signature: action.signature });
        if (!isAddressEqual(recovered, o.user)) {
          return envelope({
            state: "conflict",
            data: { orderDigest: localDigest, recoveredSigner: recovered, orderUser: o.user },
            chainId,
            source: "config",
            warnings: [{ code: "signature_or_reconstruction_mismatch", message: `the signature recovers to ${recovered}, not order.user ${o.user} — NOT relayed; the order would rest at the venue but could never settle. The classic rc.2 migration cause: the wallet signed a NON-ZERO rolloverParams.jitMarketHash that this payload omitted — an omitted field re-hashes as the zero hash, so include exactly what was signed` }],
            ctx,
          });
        }
      } catch (err) {
        return envelope({
          state: "conflict",
          data: { orderDigest: localDigest },
          chainId,
          source: "config",
          warnings: [{ code: "signature_or_reconstruction_mismatch", message: `the signature could not be recovered over the recomputed order digest (${firstLine(err)}) — NOT relayed` }],
          ctx,
        });
      }
      const res = await postRolloverOrder(deps, {
        chainId,
        order: o,
        intent: action.intent,
        signature: action.signature,
        envelope: { orderDataType: ORDER_DATA_TYPEHASH },
      });
      const out = mapPost(res, (body, replay) => ({ kind: "rollover-order", accepted: true, replay, orderDigest: body.orderDigest ?? localDigest, localDigest }), settlerWarnings);
      // Venue digest disagreement is a conflict, not a success — surface it [K7]. Read the
      // venue's own response body (the same boundary mapPost read), not the envelope back.
      if (out.state === "ok") {
        const venueDigest = ((res.body ?? {}) as Record<string, unknown>).orderDigest;
        if (typeof venueDigest === "string" && venueDigest.toLowerCase() !== localDigest.toLowerCase()) {
          return envelope({
            state: "conflict",
            data: { venueDigest, localDigest },
            chainId,
            source: "service",
            warnings: [{ code: "venue_digest_mismatch", message: "the venue computed a DIFFERENT orderDigest than the local EIP-712 recomputation — do not sign or rely on either until resolved (formerly digest_mismatch)" }],
            ctx,
          });
        }
      }
      return out;
    }

    if (action.type === "lop-order") {
      const lop = LOP_ADDRESSES[chainId];
      if (!lop) return unavailable(chainId, "no_lop", `no known 1inch LOP v4 deployment for chainId ${chainId}`, ctx);
      const orderMsg = {
        salt: BigInt(action.order.salt),
        maker: action.order.maker,
        receiver: action.order.receiver,
        makerAsset: action.order.makerAsset,
        takerAsset: action.order.takerAsset,
        makingAmount: BigInt(action.order.makingAmount),
        takingAmount: BigInt(action.order.takingAmount),
        makerTraits: BigInt(action.order.makerTraits),
      };
      // [K3] The orderHash sent to the venue is recomputed locally, never caller-supplied —
      // via the same hashLopOrder the maker path signs against (this block used to carry a
      // hand-rolled copy of the typed-data shape).
      const orderHash = hashLopOrder(chainId, lop, orderMsg);
      // [F3/K3] Derive the listing fields from the SIGNED makerTraits instead of trusting the
      // caller's duplicates: the venue book must never advertise an expiry / partial-fill policy /
      // nonce that contradicts what the signature enforces at fill. decodeMakerTraits owns the
      // MakerTraitsLib bit layout — no private copy of the shift/mask constants here.
      {
        const traits = decodeMakerTraits(orderMsg.makerTraits);
        const traitsExpiry = traits.expiry; // 0 = no expiry
        const traitsNonce = traits.nonce;
        const traitsAllowsPartial = traits.allowPartialFills;
        const mismatches: string[] = [];
        if (BigInt(action.expiry) !== traitsExpiry) mismatches.push(`expiry: listing says ${action.expiry}, the signed makerTraits encode ${traitsExpiry}`);
        if (BigInt(action.nonce) !== traitsNonce) mismatches.push(`nonce: listing says ${action.nonce}, the signed makerTraits encode ${traitsNonce}`);
        if (action.allowsPartialFills !== traitsAllowsPartial) mismatches.push(`allowsPartialFills: listing says ${action.allowsPartialFills}, the signed makerTraits say ${traitsAllowsPartial}`);
        if (mismatches.length > 0) {
          return envelope({
            state: "conflict",
            data: { orderHash, listing: { expiry: action.expiry, nonce: action.nonce, allowsPartialFills: action.allowsPartialFills }, fromMakerTraits: { expiry: traitsExpiry, nonce: traitsNonce, allowsPartialFills: traitsAllowsPartial } },
            chainId,
            source: "config",
            warnings: [{ code: "listing_traits_mismatch", message: `listing fields contradict the signed order's makerTraits (${mismatches.join("; ")}) — NOT relayed; takers acting on the listing would build fills that revert` }],
            ctx,
          });
        }
      }
      const lopWarnings: Array<{ code: string; message: string }> = [];
      // [F3/K3] For an EOA maker, prove the signature is the maker's over THIS order before
      // relaying. A contract maker (ERC-1271) cannot be ecrecovered — verify it with the SAME
      // isValidSignature staticcall the fill performs, whenever an RPC resolves (best-effort:
      // a missing RPC downgrades to a disclosed gap, a definitive rejection blocks the relay).
      if (action.makerAccountType === "ERC1271") {
        const resolved = await getRpc(ctx, chainId);
        if (resolved) {
          let magic: string | null | undefined;
          try {
            magic = await resolved.client.readContract({ address: orderMsg.maker, abi: erc1271Abi, functionName: "isValidSignature", args: [orderHash, action.signature] });
          } catch (err) {
            // Attribution: transport = indeterminate (disclose, relay); a contract-side
            // revert = the maker's own definitive refusal (the fill runs this exact call).
            magic = isTransportFailure(err) ? undefined : null;
          }
          if (magic === undefined) {
            lopWarnings.push({ code: "chain_read_failed", message: `the maker ${orderMsg.maker}'s isValidSignature staticcall failed in transport — the ERC-1271 signature could not be pre-verified; the fill path runs this exact check, so an invalid signature would rest on the book unfillable` });
          } else if (magic === null || magic.slice(0, 10).toLowerCase() !== ERC1271_MAGIC) {
            return envelope({
              state: "conflict",
              data: { orderHash, maker: orderMsg.maker, isValidSignatureAnswer: magic },
              chainId,
              source: "chain",
              warnings: [{ code: "signature_or_reconstruction_mismatch", message: `the contract maker ${orderMsg.maker} rejected this signature (isValidSignature did not answer the ERC-1271 magic value) — NOT relayed; the fill path runs this exact staticcall, so the order could rest on the book but never fill` }],
              ctx,
            });
          }
        } else {
          lopWarnings.push({ code: "chain_read_failed", message: "no RPC resolved — the ERC-1271 contract-maker signature was NOT pre-verified locally (an EOA signature would have been ecrecovered); the venue and the fill path still check it" });
        }
      } else {
        try {
          const recovered = await recoverAddress({ hash: orderHash, signature: action.signature });
          if (!isAddressEqual(recovered, orderMsg.maker)) {
            return envelope({
              state: "conflict",
              data: { orderHash, recoveredSigner: recovered, orderMaker: orderMsg.maker },
              chainId,
              source: "config",
              warnings: [{ code: "signature_or_reconstruction_mismatch", message: `the signature recovers to ${recovered}, not the order maker ${orderMsg.maker} — NOT relayed; this order could rest on the book but never fill` }],
              ctx,
            });
          }
        } catch (err) {
          return envelope({
            state: "conflict",
            data: { orderHash },
            chainId,
            source: "config",
            warnings: [{ code: "signature_or_reconstruction_mismatch", message: `the signature could not be recovered over the recomputed order hash (${firstLine(err)}) — NOT relayed` }],
            ctx,
          });
        }
      }
      // ── The listing premium, resolved the venue's way (see resolveListingPremium — shared
      // with finalize-maker-order so both gates refuse identical listings with identical
      // teaching). Replicating the RESOLUTION — not just the gates — is what lets every check
      // below (suspect tripwires, the quote_ref band) compare exactly what the venue compares.
      const resolved = resolveListingPremium(action.premium, action.premiumAnnualized);
      if (!resolved.ok) {
        return unavailable(chainId, "invalid_order_terms", resolved.message, ctx);
      }
      const premiumPct = resolved.premiumPct;
      // Numbers-contract tripwires, on the venue's CANONICAL percent: a sub-0.1% premium is the
      // classic fraction-pasted-as-percent mistake — flagged, not blocked (par-priced cPT
      // orders can be legitimately tiny; the venue logs this same signal without rejecting).
      if (premiumPct > 0 && premiumPct < 0.1) {
        // Teaching by exemplar, not by computed suggestion: premiumPct is a float and any
        // arithmetic on it for display re-teaches the very artifact this warning polices.
        lopWarnings.push({ code: "premium_scale_suspect", message: `the declared premium resolves to ${premiumPct}% — below 0.1%. The classic cause is a percent number scaled as a fraction (4.1% is premiumAnnualized "0.041"); the venue rejects ~100x divergence when quote_ref is present. Full scale table: ${UNITS_TOPIC_REFERENCE}` });
      }
      // The successor field's own paste mistake runs the OTHER way: a percent number typed into
      // the fraction field ("4.1" = 410% annualized). Legal at the venue (its cap is 100), and
      // genuinely reachable by short-tenor distressed markets — so a warning, never a block.
      // The suggested spelling is exact STRING math (shift the point two left), never a float
      // division — a teaching message reading `0.041000000000000002` teaches the wrong lesson.
      if (action.premiumAnnualized !== undefined && Number.parseFloat(action.premiumAnnualized) > 1) {
        const [int = "0", dec = ""] = action.premiumAnnualized.split(".");
        const digits = int.padStart(3, "0");
        const suggested = `${digits.slice(0, -2)}.${digits.slice(-2)}${dec}`;
        lopWarnings.push({ code: "premium_scale_suspect", message: `premiumAnnualized "${action.premiumAnnualized}" parses above 1 — that is ${premiumPct}% annualized. If you meant ${action.premiumAnnualized}%, write "${suggested}". Relayed as given (the venue accepts fractions up to 100). Full scale table: ${UNITS_TOPIC_REFERENCE}` });
      }
      // quote_ref pre-flight [K3-style]: replicate the venue's own POST-time gate (post-order.ts
      // "Verify RFQ provenance") so a bad citation fails EARLY with teaching instead of a venue
      // 400. The venue checks, in order: the answer exists on the named RFQ, the order's maker
      // is the RFQ's requester (attribution integrity — no stamping third-party quotes), the
      // option exists, chain and collateral cohere with this order, and the declared premium
      // sits inside the strict float band ratio > 10 || ratio < 0.1 — computed via
      // Number.parseFloat on the very JSON numbers we relay, so replicating those operations
      // bit-for-bit predicts the venue exactly. (An earlier exact-bigint form here used
      // INCLUSIVE bounds and no premium>0 guard, refusing orders the venue accepts at exactly
      // 10x and at zero declared premium — a relay must never out-reject its venue.)
      if (action.quoteRef) {
        const rfq = await getRfq(deps, action.quoteRef.rfqId);
        if (!rfq) return unavailable(chainId, "invalid_order_terms", `quote_ref cites unknown RFQ '${action.quoteRef.rfqId}'`, ctx);
        const storedRequester = (rfq.request as Record<string, unknown> | undefined)?.requester;
        if (typeof storedRequester === "string" && storedRequester.toLowerCase() !== action.order.maker.toLowerCase()) {
          return unavailable(chainId, "invalid_order_terms", `quote_ref belongs to another buyer: RFQ '${action.quoteRef.rfqId}' was opened by ${storedRequester}, but this order's maker is ${action.order.maker} — the venue rejects third-party quote stamping (quote-to-fill attribution stays honest)`, ctx);
        }
        const { option, unresolved } = resolveCitedOption(rfq, action.quoteRef.answerId, action.quoteRef.optionId);
        if (unresolved) {
          // The embed is truncated and the cited answer is beyond the horizon — absence is not
          // proven, so relay: the venue validates citations against its FULL store and 400s a
          // genuinely bad one. Flagged, never silent (the premium cross-check cannot run here).
          lopWarnings.push({ code: "citation_unresolved", message: `quote_ref could not be resolved client-side: RFQ '${action.quoteRef.rfqId}' serves a TRUNCATED answers embed and answer '${action.quoteRef.answerId}' is not within it — relayed; the venue checks citations against its full store (superseded answers stay citable by design) and the premium cross-check is deferred to its gate` });
        } else {
          if (!option) return unavailable(chainId, "invalid_order_terms", `quote_ref option '${action.quoteRef.optionId}' not found in answer '${action.quoteRef.answerId}' of RFQ '${action.quoteRef.rfqId}'`, ctx);
          const optChain = (option as { chain_id?: unknown }).chain_id;
          if (typeof optChain === "number" && optChain !== chainId) {
            return unavailable(chainId, "invalid_order_terms", `quote_ref option is for chain ${optChain}, not ${chainId} — the cited option must describe THIS order (venue 400)`, ctx);
          }
          const optCollateral = (option as { collateral_asset?: unknown }).collateral_asset;
          if (typeof optCollateral === "string" && ![action.order.makerAsset.toLowerCase(), action.order.takerAsset.toLowerCase()].includes(optCollateral.toLowerCase())) {
            return unavailable(chainId, "invalid_order_terms", `quote_ref option's collateral asset ${optCollateral} is not a leg of this order (${action.order.makerAsset} / ${action.order.takerAsset}) — the cited option must describe THIS order (venue 400)`, ctx);
          }
          // Deliberately STRICTER than the venue on one point: a cited premium that does not
          // parse to a positive number makes the venue skip its band silently — here that is a
          // conflict, not a silent skip (the silent skip was exactly this guard's blind spot).
          const referenced = option.premium_annualized === undefined ? Number.NaN : Number.parseFloat(String(option.premium_annualized));
          if (!Number.isFinite(referenced) || referenced <= 0) {
            return envelope({
              state: "conflict",
              data: { quoteRef: action.quoteRef, citedOptionPremiumAnnualized: option.premium_annualized ?? null },
              chainId,
              source: "service",
              warnings: [{ code: "quote_ref_unverifiable", message: `the cited RFQ option has no parsable positive premium_annualized (got ${JSON.stringify(option.premium_annualized)}) — the premium scale cross-check cannot run; NOT relayed. Cite a valid option or drop quoteRef. RFQ premiums are FRACTION strings ("0.041" = 4.1%); full scale table: ${UNITS_TOPIC_REFERENCE}` }],
              ctx,
            });
          }
          // The venue's band, operation-for-operation: BOTH sides canonicalized to percent by
          // parseFloat × 100 (the declared side already was, above), strict inequalities,
          // guarded on BOTH premiums being positive (a zero declared premium is accepted
          // there — the signed amounts are the truth, premium is display metadata).
          const referencedPercent = referenced * 100;
          const ratio = premiumPct / referencedPercent;
          if (referencedPercent > 0 && premiumPct > 0 && (ratio > 10 || ratio < 0.1)) {
            // Display-only cleanup: 0.036*100 floats to 3.5999999999999996 — the DECISION uses
            // that raw value (it is the venue's), the teaching message shows the human 3.6.
            const displayPercent = Number(referencedPercent.toPrecision(12));
            return envelope({
              state: "conflict",
              data: { declaredPremiumPercent: premiumPct, ...(action.premiumAnnualized !== undefined ? { declaredPremiumAnnualized: action.premiumAnnualized } : {}), citedOptionFraction: option.premium_annualized, expectedPercent: referencedPercent },
              chainId,
              source: "service",
              warnings: [{ code: "premium_scale_mismatch", message: `the declared premium (= ${premiumPct}%) diverges ${ratio > 10 ? ">10" : "<1/10"}x from the cited quote (${option.premium_annualized} fraction = ${displayPercent}%) — outside the venue's own strict 10x acceptance band (replicated exactly, float and all), so this would be rejected on relay; NOT relayed. The book and the RFQ now share the fraction convention: premiumAnnualized "0.036" = 3.6%. Full scale table: ${UNITS_TOPIC_REFERENCE}` }],
              ctx,
            });
          }
        }
      }
      // Extension commitment pre-flight: what would revert InvalidExtension at fill is caught here.
      if (action.extension !== "0x") {
        const { saltLow, extLow, bound } = saltExtensionBinding(BigInt(action.order.salt), action.extension);
        if (!bound) {
          return envelope({
            state: "conflict",
            data: { saltLow160: `0x${saltLow.toString(16)}`, extensionKeccakLow160: `0x${extLow.toString(16)}` },
            chainId,
            source: "config",
            warnings: [{ code: "extension_salt_mismatch", message: "salt's low 160 bits must equal keccak256(extension)'s low 160 bits — this order would revert InvalidExtension at fill; NOT relayed" }],
            ctx,
          });
        }
      }
      const res = await postLopOrder(deps, {
        salt: action.order.salt,
        maker: action.order.maker,
        receiver: action.order.receiver,
        makerAsset: action.order.makerAsset,
        takerAsset: action.order.takerAsset,
        makingAmount: action.order.makingAmount,
        takingAmount: action.order.takingAmount,
        makerTraits: action.order.makerTraits,
        extension: action.extension === "0x" ? "" : action.extension,
        orderHash,
        signature: action.signature,
        // Wire translation: the venue's enum is EOA|CONTRACT (it verifies against the maker's
        // on-chain bytecode); our surface says ERC1271 — the standard the fill actually invokes.
        // Posting "ERC1271" verbatim was a live defect: the venue's schema 400s it, so no
        // contract-maker order ever reached the book through this relay.
        makerAccountType: action.makerAccountType === "ERC1271" ? "CONTRACT" : "EOA",
        makerPermit2: action.makerPermit2,
        side: action.side,
        // The removed percent `premium` is never relayed — resolveListingPremium refuses any
        // payload carrying it before this point (the venue 400s on presence since 0.3.15).
        premium_annualized: action.premiumAnnualized!,
        expiry: action.expiry,
        nonce: action.nonce,
        allowsPartialFills: action.allowsPartialFills,
        chainId,
        ...(action.quoteRef ? { quote_ref: { rfq_id: action.quoteRef.rfqId, answer_id: action.quoteRef.answerId, option_id: action.quoteRef.optionId } } : {}),
      });
      // The LOCAL EIP-712 hash is the order's identity [K3]: it is what the maker signed and
      // what the LOP will compute at fill time. A venue that echoes a different hash is
      // describing a different order — surfacing its value as `orderHash` would hand the caller
      // a key that cancels/tracks nothing (audit STATE-005). The local hash stays primary; the
      // venue's is reported beside it, and the disagreement is a conflict.
      const venueOrderHash = typeof (res.body as { orderHash?: unknown } | null)?.orderHash === "string" ? (res.body as { orderHash: string }).orderHash : undefined;
      const agreed = venueOrderHash === undefined || venueOrderHash.toLowerCase() === orderHash.toLowerCase();
      const out = mapPost(
        res,
        (_body, replay) => ({ kind: "lop-order", accepted: true, replay, orderHash, localOrderHash: orderHash, ...(venueOrderHash !== undefined ? { venueOrderHash } : {}) }),
        lopWarnings,
      );
      // Only a SERVED result can disagree; a 4xx/5xx already carries its own verdict. The relay
      // WAS accepted — `accepted` reports that fact truthfully; the conflict is about which hash
      // names the order, and the envelope state carries that verdict.
      if (out.state === "ok" && !agreed) {
        return envelope({
          state: "conflict",
          data: { kind: "lop-order", accepted: true, replay: res.httpStatus === 200, orderHash, localOrderHash: orderHash, venueOrderHash },
          chainId,
          source: "service",
          warnings: [
            ...out.warnings,
            {
              code: "order_hash_mismatch",
              message: `the venue ACCEPTED the relay but echoed orderHash ${venueOrderHash}, which contradicts the locally recomputed EIP-712 hash ${orderHash} — the LOCAL hash is what the maker signed and what the LOP computes at fill, so it stays authoritative. The order may now rest on the book under a different identity: re-read the book, and do not use the venue's value to cancel or track it`,
            },
          ],
          ctx,
        });
      }
      return out;
    }

    if (action.type === "rfq-open") {
      // [F6] Mirror the sibling rollover-intent validation: an inverted or already-past window
      // was previously relayed untouched and failed (or half-worked) only at the venue.
      const nowSecs = nowSecondsOf(ctx);
      if (action.expiryWindow.notBefore > action.expiryWindow.notAfter) {
        return unavailable(chainId, "invalid_order_terms", `expiryWindow is inverted: notBefore (${action.expiryWindow.notBefore}) is after notAfter (${action.expiryWindow.notAfter})`, ctx);
      }
      if (BigInt(action.expiryWindow.notAfter) <= nowSecs) {
        return unavailable(chainId, "invalid_order_terms", `expiryWindow.notAfter (${action.expiryWindow.notAfter}) is not in the future (now ${nowSecs}) — no pool expiry could ever satisfy this window`, ctx);
      }
      if (BigInt(action.validUntil) <= nowSecs) {
        return unavailable(chainId, "invalid_order_terms", `validUntil (${action.validUntil}) is not in the future (now ${nowSecs}) — the RFQ would be born expired`, ctx);
      }
      const res = await postRfq(deps, {
        schema_version: "1",
        request_id: input.clientRequestId,
        requester: action.requester,
        chain_id: chainId,
        reference_asset: action.referenceAsset,
        collateral_asset: action.collateralAsset,
        modes: action.modes,
        package_ids: action.packageIds,
        expiry_window: { not_before: action.expiryWindow.notBefore, not_after: action.expiryWindow.notAfter },
        ...(action.marketTemplate ? { market_template: action.marketTemplate } : {}),
        notional_assets: action.notionalAssets,
        valid_until: action.validUntil,
        signature: action.signature,
      });
      return mapPost(res, (body, replay) => ({ kind: "rfq-open", accepted: true, replay, rfqId: body.rfq_id ?? null, state: body.state ?? null }));
    }

    // rfq-counter — the requester's non-committal counter-bid (the buyer's side of the
    // negotiation loop; the venue broadcasts it to every underwriter, newest counter wins).
    if (action.type === "rfq-counter") {
      // The venue's fraction contract (§2.1), replicated exactly — see premiumFractionViolation.
      const fractionProblem = premiumFractionViolation(action.premiumAnnualized);
      if (fractionProblem !== null) {
        return unavailable(chainId, "invalid_order_terms", `premiumAnnualized must be a decimal-string FRACTION < 0.5 ("0.041" = 4.1% annualized) — got ${JSON.stringify(action.premiumAnnualized)} (${fractionProblem}); percent numbers (4.1) belong only on the book listing field, wads (1e18-scaled) never appear on the RFQ surface. Full scale table: ${UNITS_TOPIC_REFERENCE}`, ctx);
      }
      // optionRef pre-flight [K3-style]: one venue GET, only when the counter cites an option.
      // The same fetch replays the venue's own POST gate order (post-counter.ts): 404 unknown
      // RFQ, 403 wrong requester, 410 expired, 400 bad citation — each refused here with
      // teaching BEFORE the POST burns its request_id. A TRUNCATED answers embed cannot prove
      // absence (superseded answers stay citable by design), so a not-found citation refuses
      // only on a complete record and otherwise relays flagged — the venue validates against
      // its full store either way.
      const counterWarnings: Array<{ code: string; message: string }> = [];
      if (action.optionRef) {
        const rfq = await getRfq(deps, action.rfqId);
        if (!rfq) return unavailable(chainId, "rfq_not_found", `RFQ '${action.rfqId}' is unknown to the venue (a normal outcome for a never-posted or mistyped id)`, ctx);
        const storedRequester = (rfq.request as Record<string, unknown> | undefined)?.requester;
        if (typeof storedRequester === "string" && storedRequester.toLowerCase() !== action.requester.toLowerCase()) {
          return unavailable(chainId, "invalid_order_terms", `only the RFQ's requester may counter: RFQ '${action.rfqId}' was opened by ${storedRequester}, not ${action.requester} — the venue would 403 this on relay`, ctx);
        }
        if (rfq.state === "expired") {
          return unavailable(chainId, "invalid_order_terms", `RFQ '${action.rfqId}' is expired — the venue no longer accepts counters on it (would 410 on relay); post a fresh RFQ instead`, ctx);
        }
        const { option, unresolved } = resolveCitedOption(rfq, action.optionRef.answerId, action.optionRef.optionId);
        if (unresolved) {
          counterWarnings.push({ code: "citation_unresolved", message: `optionRef could not be resolved client-side: RFQ '${action.rfqId}' serves a TRUNCATED answers embed and answer '${action.optionRef.answerId}' is not within it — relayed; the venue checks citations against its full store (superseded answers stay citable by design)` });
        } else if (!option) {
          return unavailable(chainId, "invalid_order_terms", `optionRef option '${action.optionRef.optionId}' not found in answer '${action.optionRef.answerId}' of RFQ '${action.rfqId}' — a counter's optionRef must cite an option of an answer on this RFQ (the venue would 400 this on relay); drop optionRef to counter the envelope at large`, ctx);
        }
      }
      const res = await postRfqCounter(deps, action.rfqId, {
        schema_version: "1",
        request_id: input.clientRequestId,
        requester: action.requester,
        premium_annualized: action.premiumAnnualized,
        ...(action.optionRef ? { option_ref: { answer_id: action.optionRef.answerId, option_id: action.optionRef.optionId } } : {}),
        ...(action.freshUntil !== undefined ? { fresh_until: action.freshUntil } : {}),
        signature: action.signature,
      });
      return mapPost(res, (body, replay) => ({ kind: "rfq-counter", accepted: true, replay, counterId: body.counter_id ?? null, rfqId: action.rfqId }), counterWarnings);
    }

    // rfq-answer — enforce the fraction contract on quoted options before relaying (§2.1: the
    // venue's own regex + parseFloat cap, replicated exactly — see premiumFractionViolation).
    if (action.status === "quoted") {
      for (const [i, o] of (action.options ?? []).entries()) {
        const p = o.premium_annualized;
        const problem = p === undefined ? null : premiumFractionViolation(p);
        if (problem !== null) {
          return unavailable(chainId, "invalid_order_terms", `options[${i}].premium_annualized must be a decimal-string FRACTION < 0.5 ("0.041" = 4.1%) — got ${JSON.stringify(p)} (${problem}); percent numbers (4.1) belong only on the legacy book field, wads (1e18-scaled) never appear on the RFQ surface. Full scale table: ${UNITS_TOPIC_REFERENCE}`, ctx);
        }
      }
    }
    const res = await postRfqAnswer(deps, action.rfqId, {
      schema_version: "1",
      request_id: input.clientRequestId,
      underwriter: action.underwriter,
      status: action.status,
      ...(action.status === "quoted" ? { options: action.options ?? [] } : { reason_code: action.reasonCode ?? "PASS" }),
      // Optional revision link, relayed verbatim (venue-validated: must cite an OWN prior
      // answer on this same RFQ). Supersession is implicit either way — audit trail only.
      ...(action.supersedes !== undefined ? { supersedes: action.supersedes } : {}),
      signature: action.signature,
    });
    return mapPost(res, (body, replay) => ({ kind: "rfq-answer", accepted: true, replay, answerId: body.answer_id ?? null, rfqId: action.rfqId }));
  } catch (err) {
    return venueFailed(chainId, err, ctx);
  }
}
