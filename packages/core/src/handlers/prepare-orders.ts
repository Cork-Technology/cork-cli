// Split from handlers.ts (2026-08-05): prepare-orders handlers — one typed dispatch, per-tool modules.
// Declarations are moved byte-identically; see handlers.ts for the runTool dispatch.
import { isAddressEqual, recoverAddress } from "viem";
import { ORDERS_TOPIC_REFERENCE, UNITS_TOPIC_REFERENCE, Envelope, executionEthTransaction, executionMakerLadder, executionMakerOrder, executionMakerOrderContractMaker, executionRolloverIntent, PrepareOrdersInput } from "@cork/schemas";
import { allowedSenderSuffix, buildCancelOrder, buildMakerOrder, buildTakerFill, classifyInvalidatorWord, decodeExtensionFields, decodeMakerTraits, encodeExtensionFields, ERC1271_MAGIC, erc1271Abi, hashLopOrder, isAllowedSender, LADDER_ID_MAX, ladderRungClientRequestId, LOP_ADDRESSES, type LopOrder, lopInvalidatorPlan, readLopInvalidator, reconstructMakerOrder, saltExtensionBinding, type TakerFillResult } from "../orders.ts";
import { annotateApprovalStatus, type ApprovalRequirement, approvalMissingWarning, makerApprovalRequirements, takerApprovalRequirements } from "../order-approvals.ts";
import { buildDeployFixedRateOracleCall, buildDeployOracleCall, buildJitExtension, decodeJitExtension, deriveJitMarket, encodeJitExtraData, type JITMarketParams, predictShares } from "../market-registry.ts";
import { resolveMarketRegistry, resolveRollover } from "../config-remote.ts";
import { buildRolloverIntent, checkRolloverOrderTerms, classifyRolloverSettler, hashJitMarketParams, retiredSettlerTeaching, ZERO_JIT_MARKET_HASH } from "../rollover.ts";
import { verificationDigest } from "../rollover-verify.ts";
import { type AuctionPriceReport, auctionPhase, buildAuctionAmountData, type DecodedFusionOrder, decodeFusionOrder, fusionRateBump, fusionTakerPays, fusionTotalFee, isGetterWhitelisted, NotAFusionOrder } from "../fusion.ts";
import { getLopOrderbook, parseSignedLopOrder, type SignedLopOrder } from "../datasources/venue.ts";
import { envelope, getDep, getRpc, type HandlerContext, isTransportFailure, nowSecondsOf, revertReason, ToolInputError, unavailable, venueDepsOf, venueFailed } from "./shared.ts";
import { collectVenuePages, venueNoticeWarnings } from "./query.ts";
import { resolveListingPremium } from "./submit.ts";
import { buildTakerJitInteraction, diagnoseStaleSidePrediction, farFutureExpiryWarning, type JitLadderResult, jitValueGate, type LegacyJitReport, parsePermitWires, prepareJitLegacy, resolveFeeCap, runJitPreflightLadder, type TakerJitReport, verifyExtraDataLayout } from "./jit.ts";
import { oracleRateEcho, resolveRecipeOracleConstraint } from "./registry.ts";
import { prepareForSelfTakerFill } from "./forself.ts";
import { handleAnswerRfq, handleRefreshOrder, type SugarDeps } from "./prepare-orders-sugars.ts";

/** The sugars re-enter this dispatcher and its approval annotator; handed in, never imported back. */
const SUGAR_DEPS: SugarDeps = { prepare: (input, ctx) => handlePrepareOrders(input, ctx), annotateApprovals: (ctx, chainId, entries) => annotateIfExplicitRpc(ctx, chainId, entries) };

/** Maker-side 2.1.0 JIT report echoed in `data.jit` — the base always rides; the verified half is
 *  filled only when an RPC resolved and the pre-flights ran. Legacy maker orders carry
 *  LegacyJitReport instead. */
type MakerJitReport = {
  adapter: `0x${string}`;
  hook: string;
  recipe: `0x${string}`;
  enableJitMint: boolean;
  source?: NonNullable<Extract<JitLadderResult, { gate?: undefined }>["verified"]>["source"];
  oracle?: { address: `0x${string}` | null; deployed: boolean; rate?: bigint };
  derivedPoolId?: `0x${string}`;
  /** Decode round-trip: what the adapter's own decodeExtraData read back from the bytes we built. */
  extraDataLayout?: string;
  constraint?: Extract<JitLadderResult, { gate?: undefined }>["constraint"];
  identity?: string;
  predictedCorkSwapToken?: `0x${string}`;
  permitNote?: string;
};

/** Best-effort approval-status annotation for the maker/finalize paths: runs ONLY with an
 *  explicit RPC context (ctx.rpcUrl / ctx.resolveRpc) — same policy as funding-leg resolution —
 *  so pure offline order building stays chain-silent. The requirement entries always ride;
 *  this may only ADD satisfied/current fields, never block the artifact. */
async function annotateIfExplicitRpc(ctx: HandlerContext, chainId: PrepareOrdersInput["chainId"], entries: ApprovalRequirement[]): Promise<ApprovalRequirement[]> {
  if (!ctx.resolveRpc && !ctx.rpcUrl) return entries;
  const resolved = await getRpc(ctx, chainId);
  if (!resolved) return entries;
  return annotateApprovalStatus(resolved.client, { entries, nowSeconds: nowSecondsOf(ctx), ...(ctx.atBlock !== undefined ? { atBlock: ctx.atBlock } : {}) });
}

/** Maker-side auction plan echoed in `data.fusion`: what the signed extension commits to. */
interface MakerAuctionPlan {
  settlement: `0x${string}`;
  role: string;
  auction: { startTime: string; durationSeconds: string; initialRateBump: string; points: Array<{ rateBump: string; timeDelta: string }>; scale: string };
  phase: "pre-start" | "decaying" | "floor";
  takerPaysCeiling: string;
  takerPaysNow: string;
  floorTakingAmount: string;
}

/** Maker-signature verification ladder, shared by finalize-maker-order and taker-fill's inline
 *  signedOrder path. Code detection decides the branch: a CONTRACT maker (a Safe, the Zyfai
 *  shape) cannot be ecrecovered — verification performs the SAME isValidSignature staticcall
 *  the fill performs; an EOA maker verifies offline by ecrecover. Returns a VERDICT, not an
 *  envelope: the call sites refuse with legitimately different consequences ("NOT finalized"
 *  vs "no fill bytes were built"), so message construction stays with each caller. */
/** How the maker-code probe went. "no-code" is a positive answer (an EOA); only the other two
 *  leave the account type genuinely unknown. viem's getCode returns `undefined` for an
 *  account WITHOUT code, so the read's outcome is tracked separately from its value —
 *  conflating the two reported every EOA maker as "could not be checked" (2026-08-20). */
type MakerCodeProbe = "has-code" | "no-code" | "no-rpc" | "read-failed";

type MakerSignatureVerdict =
  | { kind: "eoa"; recoveredSigner: `0x${string}`; codeProbe: Exclude<MakerCodeProbe, "has-code"> }
  | { kind: "erc1271" }
  | { kind: "erc1271_transport"; reason: string }
  | { kind: "erc1271_rejected"; isValidSignatureAnswer: string | null }
  | { kind: "eoa_mismatch"; recoveredSigner: `0x${string}` }
  | { kind: "unparseable"; reason: string };

/** The disclosure an EOA verdict carries when the account type could not be established —
 *  one sentence per cause, shared by finalize and the inline taker-fill path. `consequence`
 *  names what the caller did with the order anyway. */
function makerCodeUnknownWarning(probe: Exclude<MakerCodeProbe, "has-code">, consequence: string): { code: string; message: string } | null {
  if (probe === "no-code") return null;
  const cause = probe === "no-rpc" ? "no RPC resolved to check whether the maker has code" : "the maker's code could not be read (the RPC call failed)";
  return { code: "chain_read_failed", message: `${cause} — the signature ecrecovers to the maker, so ${consequence}; if the maker is actually a contract account, retry with an RPC available` };
}

async function verifyMakerSignatureLadder(a: { ctx: HandlerContext; chainId: PrepareOrdersInput["chainId"]; maker: `0x${string}`; orderHash: `0x${string}`; signature: `0x${string}` }): Promise<MakerSignatureVerdict> {
  const resolved = await getRpc(a.ctx, a.chainId);
  let probe: MakerCodeProbe = "no-rpc";
  if (resolved) {
    try {
      // `undefined` and "0x" both mean "no code" — only a throw means the read failed.
      const code = await resolved.client.getCode({ address: a.maker });
      probe = code !== undefined && code !== "0x" ? "has-code" : "no-code";
    } catch {
      probe = "read-failed"; // transport failure or a client without getCode — the EOA branch discloses it
    }
  }
  if (probe === "has-code") {
    let magic: unknown;
    try {
      magic = await resolved!.client.readContract({ address: a.maker, abi: erc1271Abi, functionName: "isValidSignature", args: [a.orderHash, a.signature] });
    } catch (err) {
      // Attribution: a transport failure is indeterminate (retryable, not a verdict); a
      // contract-side revert IS the verdict — the fill runs this exact staticcall.
      if (isTransportFailure(err)) return { kind: "erc1271_transport", reason: revertReason(err) };
      magic = null;
    }
    if (typeof magic !== "string" || magic.slice(0, 10).toLowerCase() !== ERC1271_MAGIC) {
      return { kind: "erc1271_rejected", isValidSignatureAnswer: typeof magic === "string" ? magic : null };
    }
    return { kind: "erc1271" };
  }
  let recoveredSigner: `0x${string}`;
  try {
    recoveredSigner = await recoverAddress({ hash: a.orderHash, signature: a.signature });
  } catch (err) {
    return { kind: "unparseable", reason: err instanceof Error ? err.message : "the signature could not be parsed" };
  }
  if (!isAddressEqual(recoveredSigner, a.maker)) return { kind: "eoa_mismatch", recoveredSigner };
  return { kind: "eoa", recoveredSigner, codeProbe: probe };
}

export async function handlePrepareOrders(input: PrepareOrdersInput, ctx: HandlerContext): Promise<Envelope> {
  const chainId = input.chainId;
  const action = input.action;

  if (action.type === "maker-ladder") return handleMakerLadder(input, action, ctx);
  if (action.type === "answer-rfq") return handleAnswerRfq(input, action, ctx, SUGAR_DEPS);
  if (action.type === "refresh-order") return handleRefreshOrder(input, action, ctx, SUGAR_DEPS);

  if (action.type === "finalize-maker-order") {
    const lop = LOP_ADDRESSES[chainId];
    if (!lop) return unavailable(chainId, "no_lop", `no known 1inch LOP v4 deployment for chainId ${chainId}`, ctx);
    // The full listing-premium resolution runs HERE, not just at submit — finalize's whole
    // contract is that submitInput relays as-is after the caller's policy gate admits the
    // artifact, so a listing the relay would refuse (the removed percent field present, the
    // premium missing, a malformed fraction) must fail before that gate ever sees it. Same
    // function, same messages, same refusal vocabulary as the relay (resolveListingPremium
    // in submit.ts).
    const listingPremium = resolveListingPremium(action.listing.premium, action.listing.premiumAnnualized);
    if (!listingPremium.ok) {
      return unavailable(chainId, "invalid_order_terms", listingPremium.message, ctx);
    }
    const p = action.prepared;
    if (p.clientRequestId !== input.clientRequestId || p.typedData.domain.chainId !== chainId || !isAddressEqual(p.lop, lop) || !isAddressEqual(p.typedData.domain.verifyingContract, lop)) {
      return envelope({
        state: "conflict",
        data: null,
        chainId,
        source: "config",
        warnings: [{ code: "prepared_context_mismatch", message: "prepared order clientRequestId / chainId / verifying contract does not match this finalization request" }],
        ctx,
      });
    }
    const m = p.typedData.message;
    try {
      const orderArgs = {
        chainId,
        lop,
        order: { salt: BigInt(m.salt), maker: m.maker, receiver: m.receiver, makerAsset: m.makerAsset, takerAsset: m.takerAsset, makingAmount: BigInt(m.makingAmount), takingAmount: BigInt(m.takingAmount), makerTraits: BigInt(m.makerTraits) },
        claimedOrderHash: p.orderHash,
        extension: p.extension,
      };
      // Maker kind decides the verification path: a CONTRACT maker (a Safe, the Zyfai shape)
      // cannot be ecrecovered — the fill validates it with an isValidSignature staticcall, so
      // finalization performs the SAME call. Code detection is an RPC read; without one, a
      // contract maker's finalization fails honestly in the ecrecover branch below.
      const { orderHash: reconstructedHash } = reconstructMakerOrder(orderArgs);
      const finalizeWarnings: Array<{ code: string; message: string }> = [];
      let makerAccountType: "EOA" | "ERC1271" = "EOA";
      let recoveredSigner: `0x${string}` | null = null;
      const verdict = await verifyMakerSignatureLadder({ ctx, chainId, maker: m.maker, orderHash: reconstructedHash, signature: action.signature });
      if (verdict.kind === "erc1271_transport") {
        return unavailable(chainId, "chain_read_failed", `the maker ${m.maker} is a CONTRACT account but its isValidSignature staticcall failed in transport (${verdict.reason}) — the ERC-1271 signature could not be verified either way; retry with a working RPC (the fill path requires this exact call to answer)`, ctx);
      }
      if (verdict.kind === "erc1271_rejected") {
        return envelope({
          state: "conflict",
          data: { orderHash: reconstructedHash, maker: m.maker, makerAccountType: "ERC1271", isValidSignatureAnswer: verdict.isValidSignatureAnswer },
          chainId,
          source: "chain",
          warnings: [{ code: "signature_or_reconstruction_mismatch", message: `the maker ${m.maker} is a CONTRACT account and its isValidSignature(orderHash, signature) did not answer the ERC-1271 magic value — the fill path runs this exact staticcall, so the order could rest on the book but never fill. NOT finalized. (For a Safe, the hash must have been approved/signed per its own ERC-1271 scheme.)` }],
          ctx,
        });
      }
      // The two refusals below throw into this block's catch, which appends the
      // contract-account hint — the exact pre-refactor behavior (the errors used to
      // originate inside finalizeMakerOrder).
      if (verdict.kind === "eoa_mismatch") throw new Error(`signature recovers to ${verdict.recoveredSigner}, not the order maker ${m.maker}`);
      if (verdict.kind === "unparseable") throw new Error(verdict.reason);
      if (verdict.kind === "erc1271") {
        makerAccountType = "ERC1271";
      } else {
        recoveredSigner = verdict.recoveredSigner;
        const w = makerCodeUnknownWarning(verdict.codeProbe, "it is finalized as an EOA order");
        if (w) finalizeWarnings.push(w);
      }
      const finalized = { order: orderArgs.order, orderHash: reconstructedHash, signature: action.signature, extension: p.extension };
      const submitInput = {
        chainId,
        clientRequestId: input.clientRequestId,
        action: {
          type: "lop-order" as const,
          order: { salt: finalized.order.salt.toString(), maker: finalized.order.maker, receiver: finalized.order.receiver, makerAsset: finalized.order.makerAsset, takerAsset: finalized.order.takerAsset, makingAmount: finalized.order.makingAmount.toString(), takingAmount: finalized.order.takingAmount.toString(), makerTraits: finalized.order.makerTraits.toString() },
          signature: finalized.signature,
          extension: finalized.extension,
          side: action.listing.side,
          // The removed percent field never reaches submitInput — resolveListingPremium
          // refused it above; the fraction is the one listing premium (cork-api 0.3.15).
          premiumAnnualized: action.listing.premiumAnnualized!,
          expiry: action.listing.expiry,
          nonce: action.listing.nonce,
          allowsPartialFills: action.listing.allowsPartialFills,
          makerAccountType,
          makerPermit2: "0x" as const,
          ...(action.listing.quoteRef ? { quoteRef: action.listing.quoteRef } : {}),
        },
        format: input.format,
      };
      // The gate-facing artifact is content-addressed so an independent policy gate can pin
      // exactly what it admitted before submit.
      const artifact = { kind: "signed-maker-order", orderHash: finalized.orderHash, recoveredSigner, makerAccountType, signature: finalized.signature, extension: finalized.extension, submitInput };
      // Approval requirements re-derived from the SIGNED bytes [K3]: the Permit2 sourcing bit
      // and expiry from the signed makerTraits; for a JIT extension, the adapter/collateral
      // from the decoded extension and the predicted cST from its embedded permit. Advisory
      // only — deliberately OUTSIDE `artifact`, so the digest pins signed content alone.
      const finalizeTraits = decodeMakerTraits(finalized.order.makerTraits);
      let finalizeJit: { adapter: `0x${string}`; collateralAsset: `0x${string}`; enableJitMint: boolean; predictedCorkSwapToken?: `0x${string}` } | undefined;
      if (finalized.extension !== "0x") {
        try {
          const dec = decodeJitExtension(finalized.extension);
          finalizeJit = { adapter: dec.adapter, collateralAsset: dec.params.collateralAsset, enableJitMint: Boolean(dec.params.enableJitMint), ...(dec.permits[0] ? { predictedCorkSwapToken: dec.permits[0].token } : {}) };
        } catch {
          /* not a JIT extension (e.g. auction-only) — the plain requirements apply */
        }
      }
      const approvals = await annotateIfExplicitRpc(ctx, chainId, makerApprovalRequirements({
        maker: finalized.order.maker,
        makerAsset: finalized.order.makerAsset,
        makingAmount: finalized.order.makingAmount,
        lop,
        usePermit2: finalizeTraits.usePermit2,
        orderExpiry: finalizeTraits.expiry,
        ...(finalizeJit ? { jit: finalizeJit } : {}),
      }));
      const finalizeApprovalWarn = approvalMissingWarning(approvals, "before submitting the listing (a resting order without them fills-then-reverts)");
      if (finalizeApprovalWarn) finalizeWarnings.push(finalizeApprovalWarn);
      return envelope({
        state: "ok",
        // Advisory echoes OUTSIDE `artifact` (the digest pins signed content alone), decoded
        // from the SIGNED traits like maker-order's: the exclusivity suffix the book will show.
        data: { ...artifact, approvals, allowedSender: finalizeTraits.allowedSender, scales: { approvalsAmount: "approvals[].amount is base units of that entry's own token", unitsTopic: UNITS_TOPIC_REFERENCE }, signedArtifactDigest: verificationDigest(artifact), callerSigned: true, helperSigned: false },
        chainId,
        source: makerAccountType === "ERC1271" ? "chain" : "config",
        warnings: [
          {
            code: "caller_signed_artifact",
            message:
              makerAccountType === "ERC1271"
                ? "contract-maker signature verified via the ERC-1271 isValidSignature staticcall (the same check the fill performs), not created [K1]; pass submitInput verbatim to cork_submit after your independent policy gate admits this artifact"
                : "signature verified and recovered, not created [K1]; pass submitInput verbatim to cork_submit after your independent policy gate admits this artifact",
          },
          ...finalizeWarnings,
        ],
        ctx,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "maker order finalization failed";
      return envelope({
        state: "conflict",
        data: null,
        chainId,
        source: "config",
        warnings: [{ code: "signature_or_reconstruction_mismatch", message: message.includes("recovers to") ? `${message}. If the maker is a CONTRACT account (ERC-1271, e.g. a Safe), finalization verifies it with an on-chain isValidSignature staticcall — make sure an RPC resolves (CORK_RPC_URL) so the maker's code can be detected` : message }],
        ctx,
      });
    }
  }

  if (action.type === "maker-order") {
    const lop = LOP_ADDRESSES[chainId];
    if (!lop) return unavailable(chainId, "no_lop", `no known 1inch LOP v4 deployment for chainId ${chainId}`, ctx);
    const nowSecs = nowSecondsOf(ctx);

    // ── optional JIT market block (2.1.0): the order names a RECIPE CONTRACT and carries the
    // OFF-CHAIN-resolved constraint — filled from one recipe.resolve call here, so the three
    // coupled fields (recipe, constraint, additionalData) are guaranteed to agree. Pool id and
    // share addresses are PINNED at signing; on-chain staleness protection is recipe.verify. ──
    let extension = action.extension;
    const warnings: Array<{ code: string; message: string }> = [];
    let jitData: MakerJitReport | LegacyJitReport | undefined;
    // U8 (design §9): a CONTRACT maker (a Safe) cannot sign the EOA-only ERC-2612 permit a JIT
    // mint needs, so when its pool does not exist yet the completion path starts with create-pool
    // and the two allowances. Decided from chain facts (pool existence from the share prediction,
    // maker code from getCode); silent when either is unknown.
    let contractMakerPreRest = false;
    if (action.jitMarket) {
      if (action.extension !== undefined && action.extension !== "0x") {
        throw new ToolInputError("cork_prepare_orders", [{ path: ["action", "extension"], message: "extension and jitMarket are mutually exclusive — jitMarket BUILDS the extension" }]);
      }
      const jm = action.jitMarket;
      // Value-domain checks shared by both generations AND both hook sides (envelope, exit 3 —
      // not format throws): one gate, so the boundary rules cannot drift between paths.
      const swapFee = BigInt(jm.swapFeePercentage);
      const unwindFee = BigInt(jm.unwindSwapFeePercentage);
      const expiryTimestamp = BigInt(jm.expiryTimestamp);
      const valueGate = jitValueGate(chainId, ctx, swapFee, unwindFee, expiryTimestamp, nowSecs, { capWei: await resolveFeeCap(chainId, "adapter") });
      if (valueGate) return valueGate;
      const farFuture = farFutureExpiryWarning(expiryTimestamp, nowSecs);
      if (farFuture) warnings.push(farFuture);

      // DEPRECATED generation: mode-string extraData against the old adapter, behind the gate.
      if (jm.legacy) {
        const leg = await prepareJitLegacy({ chainId, ctx, lop, jm, makerAsset: action.makerAsset, takerAsset: action.takerAsset });
        if (leg.gate) return leg.gate;
        extension = leg.extension;
        jitData = leg.jitData;
        warnings.push(...leg.warnings);
      } else {
        // The pre-flight ladder (registry/adapter/recipe/bindings/roles/coherence/oracle/verify/
        // derivation) is SHARED with the taker fill — runJitPreflightLadder in jit.ts. Only the
        // maker tail below (cST prediction with maker-facing wording, extension encode) is local.
        const ladder = await runJitPreflightLadder({ ctx, chainId, lop, jm, side: "maker" });
        if (ladder.gate) return ladder.gate;
        const { recipe, rateOverride, additionalData, constraint } = ladder;
        warnings.push(...ladder.warnings);
        jitData = { adapter: ladder.adapter, hook: "preInteraction (maker-side)", recipe, enableJitMint: jm.enableJitMint };

        if (ladder.verified) {
          const { client, boundController, source, oracle, derived } = ladder.verified;
          jitData = { ...jitData, source, oracle: { address: oracle.address, deployed: oracle.deployed, ...(oracle.deployed ? oracleRateEcho(oracle) : {}) }, derivedPoolId: derived.poolId, constraint, identity: "PINNED at signing: the constraint is carried in the order, so this pool id and the predicted share addresses hold however far the rate moves (2.1.0)" };
          warnings.push({ code: "constraint_window_notice", message: "staleness is now guarded by recipe.verify at fill time, not a moving pool id: if the live rate walks outside the carried constraint's window, fills revert RecipeRejectedConstraint until you re-resolve and sign a fresh order" });

          try {
            // Predicted cST: direct read when the pool exists; otherwise the state-override
            // simulation (role granted in-memory — works before AND after the governance grant).
            // When the oracle is not deployed, the simulation prepends the SAME permissionless
            // deploy the fill performs, so the pool actually creates in-memory.
            const { dep: jitDep } = await getDep(ctx, chainId);
            const preCalls: Array<{ to: `0x${string}`; data: `0x${string}` }> = [];
            if (!oracle.deployed) {
              preCalls.push({ to: ladder.registry, data: source === "fixed" ? buildDeployFixedRateOracleCall(rateOverride) : buildDeployOracleCall(jm.collateralAsset, jm.referenceAsset, oracle.mode ?? "price") });
            }
            // A missing/partial deployment config is NOT a chain read failure [C11]: guarding
            // (like the legacy-jit and registry siblings) instead of `jitDep!` keeps a config
            // gap from surfacing as a misattributed `chain_read_failed` TypeError.
            if (jitDep?.poolManager === undefined) {
              warnings.push({ code: "share_prediction_unavailable", message: `no poolManager deployment configured for chainId ${chainId} — cST prediction skipped; VERIFY yourself that one order side is the derived pool's cST, or the fill reverts OrderNotForPool (refresh cork-defaults.json)` });
            } else {
              const pred = await predictShares(client, {
                adapter: ladder.adapter,
                controller: boundController,
                poolManager: jitDep.poolManager,
                market: derived.market,
                poolId: derived.poolId,
                unwindSwapFeePercentage: unwindFee,
                swapFeePercentage: swapFee,
                preCalls,
                chainId,
              });
              const cst = pred.cst;
              if (!pred.exists && pred.status !== "unavailable") {
                try {
                  const code = typeof (client as { getCode?: unknown }).getCode === "function" ? await (client as { getCode: (a: { address: `0x${string}` }) => Promise<`0x${string}` | undefined> }).getCode({ address: input.account }) : undefined;
                  if (code !== undefined && code !== "0x") {
                    contractMakerPreRest = true;
                    warnings.push({ code: "contract_maker_pre_rest", message: `the maker ${input.account} is a CONTRACT account and the derived pool does not exist yet: the JIT permit path is EOA-only, so create the pool first (cork_prepare_market create-pool with this order's jitMarket legs) and place the cST → LOP allowance${jm.enableJitMint ? " and the collateral → JIT adapter allowance" : ""} from the account BEFORE the order rests — data.execution.then lists the steps in order` });
                  }
                } catch {
                  // unreadable code → nothing to say (the fill's ERC-1271 check decides later)
                }
              }
              if (pred.status === "unavailable") {
                warnings.push({ code: "share_prediction_unavailable", message: "could not predict the new pool's cST address (eth_simulateV1/state overrides unsupported or simulation failed) — VERIFY yourself that one order side is the derived pool's cST, or the fill reverts OrderNotForPool; the ERC-2612 permit must also be signed over that cST" });
              }
              if (cst) {
                jitData = { ...jitData, predictedCorkSwapToken: cst, permitNote: "for a NEW pool, sign an ERC-2612 permit over this cST (owner = maker, spender = the LOP, value >= the cST amount) and pass it in jitMarket.permits — a fresh token has no prior allowance for the LOP's pull. On that re-prepare, pass jitMarket.constraint = this result's jit.constraint (same clientRequestId): the constraint is part of the pool's identity, and a single oracle tick between the two prepares otherwise re-derives a different pool and cST than the permit was signed over (jit_side_mismatch)" };
                const cstLc = cst.toLowerCase();
                if (action.makerAsset.toLowerCase() !== cstLc && action.takerAsset.toLowerCase() !== cstLc) {
                  warnings.push({ code: "jit_side_mismatch", message: `NEITHER order side is the derived pool's cST ${cst} — the fill WILL revert OrderNotForPool. Set makerAsset (selling coverage) or takerAsset (buying coverage) to the predicted cST. If that side came from an EARLIER prepare, the oracle rate has moved since and the constraint re-derived a different pool: pass that prepare's jit.constraint in jitMarket.constraint to pin the identity the permit was signed over` });
                  await diagnoseStaleSidePrediction(client, [["makerAsset", action.makerAsset], ["takerAsset", action.takerAsset]], derived.poolId, warnings, "Re-run derive-cork-pool and set the order side to the FRESH predicted cST before signing.");
                }
              }
            }
          } catch (err) {
            // The ladder already succeeded — a tail failure degrades to unverified, never a gate.
            warnings.push({ code: "chain_read_failed", message: `JIT share-prediction reads failed (${revertReason(err)}) — the extension is built but the cST side-match is unverified` });
          }
        }
        const permits = parsePermitWires(jm.permits);
        const jitParams: JITMarketParams = { collateralAsset: jm.collateralAsset, referenceAsset: jm.referenceAsset, expiryTimestamp, recipe, rateOverride, constraint, additionalData, swapFeePercentage: swapFee, unwindSwapFeePercentage: unwindFee, enableJitMint: jm.enableJitMint };
        const extraData = encodeJitExtraData(jitParams, permits);
        if (ladder.verified) {
          // Decode round-trip: the deployed adapter's own decoder is the layout oracle for the
          // bytes this build produced. A disagreement is the finding's failure class — refused.
          const layout = await verifyExtraDataLayout({ client: ladder.verified.client, adapter: ladder.adapter, extraData, params: jitParams, permits, chainId, ctx, artifact: "order" });
          if ("gate" in layout) return layout.gate;
          jitData = { ...jitData, extraDataLayout: layout.status };
        }
        extension = buildJitExtension(ladder.adapter, extraData);
      }
    }

    // ── optional Cork-native decaying-premium auction (fusion plan F2): the deployed Fusion
    // settlement rides as a pure AMOUNT GETTER (no postInteraction → fills stay permissionless);
    // the signed takingAmount is the FLOOR and the price decays down to it. Composes with the
    // JIT extension above: one blob, one salt binding. Pure local byte-building — no RPC. ──
    let fusionData: MakerAuctionPlan | undefined;
    if (action.auction) {
      if (action.extension !== undefined && action.extension !== "0x") {
        throw new ToolInputError("cork_prepare_orders", [{ path: ["action", "extension"], message: "extension and auction are mutually exclusive — auction BUILDS the amount-getter extension fields" }]);
      }
      const au = action.auction;
      const startTime = au.startTime !== undefined ? BigInt(au.startTime) : nowSecs;
      const auction = {
        gasBumpEstimate: 0n,
        gasPriceEstimate: 0n,
        startTime,
        duration: BigInt(au.durationSeconds),
        initialRateBump: BigInt(au.initialRateBump),
        points: (au.points ?? []).map((p) => ({ rateBump: BigInt(p.rateBump), timeDelta: BigInt(p.timeDelta) })),
      };
      let amountData: ReturnType<typeof buildAuctionAmountData>;
      try {
        amountData = buildAuctionAmountData(chainId, auction);
      } catch (err) {
        // Well-formed values breaking a curve/width rule (over-wide bump, non-decaying points,
        // no settlement for the chain) → envelope, exit 3, with the encoder's own teaching.
        return unavailable(chainId, "invalid_order_terms", err instanceof Error ? err.message : "auction encoding failed", ctx);
      }
      const jitPre = extension !== undefined && extension !== "0x" ? decodeExtensionFields(extension).preInteractionData : "0x";
      extension = encodeExtensionFields({
        makingAmountData: amountData.makingAmountData,
        takingAmountData: amountData.takingAmountData,
        ...(jitPre !== "0x" ? { preInteractionData: jitPre } : {}),
      });
      warnings.push({ code: "decaying_price_notice", message: `the taker price DECAYS from +${auction.initialRateBump} (base 1e7) above the signed takingAmount down to the signed floor over ${auction.duration}s from ${startTime} — the signed takingAmount is the WORST case for the maker, not the expected price. The venue book lists a static premium (a decaying listing convention is an open venue question): list it honestly, and takers should re-price with cork_compute dutch-auction-price + simulate before filling` });
    }

    let built: ReturnType<typeof buildMakerOrder>;
    try {
      built = buildMakerOrder({
        chainId,
        lop,
        maker: input.account,
        makerAsset: action.makerAsset,
        takerAsset: action.takerAsset,
        makingAmount: BigInt(action.makingAmount),
        takingAmount: BigInt(action.takingAmount),
        clientRequestId: input.clientRequestId,
        ...(action.expirySeconds !== undefined ? { expiry: nowSecs + BigInt(action.expirySeconds) } : {}),
        allowPartialFills: action.allowsPartialFills,
        usePermit2: action.usePermit2,
        ...(action.allowedSender !== undefined ? { allowedSender: action.allowedSender } : {}),
        ...(action.ocoGroup !== undefined ? { ocoGroup: action.ocoGroup } : {}),
        ...(extension !== undefined ? { extension } : {}),
      });
    } catch (err) {
      // Well-formed values that violate an order-construction domain rule (malformed extension
      // shape, a trait slot overflow) → envelope, not an internal error.
      return unavailable(chainId, "invalid_order_terms", err instanceof Error ? err.message : "maker order construction failed", ctx);
    }
    if (action.auction) {
      // The fusion echo is derived from the BUILT BYTES, not the input struct [K3]: decode the
      // signed-artifact extension with the same decoder every consumer uses, so an encode bug
      // can never produce an echo that disagrees with what the maker actually signs.
      let dec: DecodedFusionOrder;
      try {
        dec = decodeFusionOrder(built.order, built.extension, chainId);
      } catch (err) {
        return unavailable(chainId, "invalid_order_terms", `self-check failed: the built auction extension did not decode back as a Fusion order (${err instanceof Error ? err.message : String(err)}) — this is a tool bug, do not sign; please report it`, ctx);
      }
      const bumpNow = fusionRateBump(dec.auction, nowSecs, null);
      fusionData = {
        settlement: dec.settlement,
        role: "amount getter ONLY — no postInteraction, so any taker fills at the decayed price through the plain LOP fill path (no resolver, no whitelist)",
        auction: { startTime: String(dec.auction.startTime), durationSeconds: String(dec.auction.duration), initialRateBump: String(dec.auction.initialRateBump), points: dec.auction.points.map((p) => ({ rateBump: String(p.rateBump), timeDelta: String(p.timeDelta) })), scale: "rate bump base 1e7 = +100% above the signed floor" },
        phase: auctionPhase(dec.auction, nowSecs),
        takerPaysCeiling: String(fusionTakerPays(built.order.makingAmount, built.order.takingAmount, built.order.makingAmount, 0n, dec.auction.initialRateBump)),
        takerPaysNow: String(fusionTakerPays(built.order.makingAmount, built.order.takingAmount, built.order.makingAmount, 0n, bumpNow.effective)),
        floorTakingAmount: String(built.order.takingAmount),
      };
    }
    // The maker's (underwriter's) approval requirements — every grant must exist BEFORE the
    // order rests, or it sits on the book fillable-looking and every fill attempt reverts.
    const jitApprovalCtx =
      action.jitMarket && jitData && "adapter" in jitData
        ? { adapter: jitData.adapter, collateralAsset: action.jitMarket.collateralAsset, enableJitMint: action.jitMarket.enableJitMint ?? false, ...("predictedCorkSwapToken" in jitData && jitData.predictedCorkSwapToken ? { predictedCorkSwapToken: jitData.predictedCorkSwapToken } : {}) }
        : undefined;
    const approvals = await annotateIfExplicitRpc(ctx, chainId, makerApprovalRequirements({
      maker: input.account,
      makerAsset: action.makerAsset,
      makingAmount: BigInt(action.makingAmount),
      lop,
      usePermit2: action.usePermit2,
      orderExpiry: decodeMakerTraits(built.order.makerTraits).expiry,
      ...(jitApprovalCtx ? { jit: jitApprovalCtx } : {}),
    }));
    const makerApprovalWarn = approvalMissingWarning(approvals, "before signing and listing this order");
    if (makerApprovalWarn) warnings.push(makerApprovalWarn);
    if (action.ocoGroup !== undefined) {
      warnings.push({ code: "oco_group_notice", message: `this order shares invalidator nonce ${built.nonce} with every order by ${input.account} that names ocoGroup '${action.ocoGroup}': the first fill or cancel of ANY of them retires ALL of them (one-cancels-the-other), and a PARTIAL fill spends the bit too. The venue does not learn the group — a sibling left OPEN on the book after another rung filled is dead on chain; re-read the bit (readLopInvalidator, or cork_track reconcile) before ranking or filling it. To withdraw the group, cancel any one rung: they share the bit. Vocabulary: ${ORDERS_TOPIC_REFERENCE}` });
    }
    return envelope({
      state: "ok",
      data: {
        kind: "maker-order",
        lop,
        typedData: { domain: built.domain, types: built.types, primaryType: built.primaryType, message: built.order },
        orderHash: built.orderHash,
        extension: built.extension,
        // The venue listing must carry this exact value: cork_submit compares the listing's nonce
        // against what the signed makerTraits encode and refuses to relay a mismatch.
        nonce: built.nonce,
        // The group this order's bit belongs to (null = stands alone on its id-derived bit).
        ocoGroup: action.ocoGroup ?? null,
        // Exclusivity as the signed traits STORE it (decoded back from the built word, not echoed
        // from the input): the 10-byte suffix the book will show, null = any taker.
        allowedSender: decodeMakerTraits(built.order.makerTraits).allowedSender,
        approvals,
        scales: { makingAmount: "base units of makerAsset (the token's own decimals)", takingAmount: "base units of takerAsset", approvalsAmount: "approvals[].amount is base units of that entry's own token", unitsTopic: UNITS_TOPIC_REFERENCE },
        ...(jitData ? { jit: jitData } : {}),
        ...(fusionData ? { fusion: fusionData } : {}),
        execution: contractMakerPreRest ? executionMakerOrderContractMaker() : executionMakerOrder(),
        clientRequestId: input.clientRequestId,
      },
      chainId,
      source: jitData ? "chain" : "config",
      warnings,
      ctx,
    });
  }

  if (action.type === "cancel") {
    const lop = LOP_ADDRESSES[chainId];
    if (!lop) return unavailable(chainId, "no_lop", `no known 1inch LOP v4 deployment for chainId ${chainId}`, ctx);
    const traits = BigInt(action.makerTraits);
    const cancel = buildCancelOrder(traits, action.orderHash);
    // What this cancel retires is decided by the SIGNED traits, not the hash: on the bit
    // invalidator, cancelOrder spends the (maker, nonce) bit, so every order by this maker that
    // carries the same nonce — a one-cancels-the-other group — is retired by this one transaction.
    // On the remaining-amount invalidator only this order hash is retired.
    const plan = lopInvalidatorPlan(traits);
    const retires = plan.mode === "bit"
      ? { invalidator: "bit" as const, nonce: plan.nonceOrEpoch.toString(), scope: `every order by ${input.account} whose makerTraits carry nonce ${plan.nonceOrEpoch} — a shared-nonce (ocoGroup) ladder is retired as one` }
      : { invalidator: "remaining" as const, nonce: null, scope: "this order hash only (remaining-amount invalidator)" };
    return envelope({ state: "ok", data: { kind: "cancel", to: lop, calldata: cancel.data, orderHash: action.orderHash, retires, execution: executionEthTransaction() }, chainId, source: "config", ctx });
  }

  if (action.type === "rollover-intent") {
    const { rollover, warning: rolloverWarn } = await resolveRollover(chainId);
    if (!rollover) {
      return unavailable(chainId, "unknown_deployment", `no rollover deployment configured for chainId ${chainId} (rollover is live on Arbitrum One and Base — 42161, 8453)`, ctx);
    }
    const warnings: Array<{ code: string; message: string }> = rolloverWarn ? [rolloverWarn] : [];

    // Settler-kind pre-flight: the mode gate is enforced ON-CHAIN (ExactSettler reverts
    // Settler__PartialFillsNotSupported on allowPartialFills:true and PartialSettler reverts
    // Settler__ExactFillsNotSupported on false), so a mismatched order is signable but unfillable.
    const cls = classifyRolloverSettler(rollover, action.settler);
    if (cls.status === "retired") {
      return unavailable(chainId, "settler_retired", retiredSettlerTeaching(action.settler, cls, rollover), ctx);
    }
    const kind = cls.status === "active" ? cls.kind : undefined;
    if (kind === "EXACT" && action.allowPartialFills) {
      return unavailable(chainId, "settler_mode_mismatch", `settler ${action.settler} is the ExactSettler, which rejects allowPartialFills:true on-chain — use the PartialSettler ${rollover.partialSettler} or set allowPartialFills:false`, ctx);
    }
    if (kind === "PARTIAL" && !action.allowPartialFills) {
      return unavailable(chainId, "settler_mode_mismatch", `settler ${action.settler} is the PartialSettler, which rejects allowPartialFills:false on-chain — use the ExactSettler ${rollover.exactSettler} or set allowPartialFills:true`, ctx);
    }
    if (kind === undefined) {
      warnings.push({ code: "settler_not_recognized", message: `settler ${action.settler} is not a configured Cork settler for chainId ${chainId} (exact: ${rollover.exactSettler}, partial: ${rollover.partialSettler}) — the venue only admits factory-approved settlers` });
    }

    // Optional JIT market commitment: hash the negotiated instruction locally [K3], or take a
    // pre-computed hash verbatim; never both (two sources of the same commitment can disagree).
    if (action.jitMarket && action.jitMarketHash) {
      return unavailable(chainId, "invalid_order_terms", "jitMarket and jitMarketHash are mutually exclusive — pass the instruction to hash locally, or the pre-computed commitment, not both", ctx);
    }
    let jitMarketHash: `0x${string}` | undefined = action.jitMarketHash;
    if (action.jitMarket) {
      const jm = action.jitMarket;
      // Same value-domain gate the LOP JIT builders run (fee cap + future expiry, one place so
      // the boundary rules cannot drift), plus the rollover-specific window rule.
      const gate = jitValueGate(chainId, ctx, BigInt(jm.swapFeePercentage), BigInt(jm.unwindSwapFeePercentage), BigInt(jm.expiryTimestamp), nowSecondsOf(ctx), { capWei: await resolveFeeCap(chainId, "adapter") });
      if (gate) return gate;
      if (BigInt(jm.expiryTimestamp) <= BigInt(action.fillDeadline)) {
        return unavailable(chainId, "invalid_order_terms", `jitMarket.expiryTimestamp (${jm.expiryTimestamp}) must outlast the order's fillDeadline (${action.fillDeadline}) — a pool that expires inside the fill window cannot receive the rollover`, ctx);
      }
      const farFuture = farFutureExpiryWarning(BigInt(jm.expiryTimestamp), nowSecondsOf(ctx));
      if (farFuture) warnings.push(farFuture);
      // Best-effort pool-identity cross-check: the commitment PINS the carried constraint, and
      // constraint values are part of pool identity — a dstPoolId kept from an OLDER derivation
      // signs an order every fill reverts (BaseFiller__JitPoolMismatch). Same posture as the
      // LOP JIT ladder: runs whenever an RPC resolves; silent without one.
      try {
        const resolved = await getRpc(ctx, chainId);
        const { marketRegistry: mr } = await resolveMarketRegistry(chainId);
        if (resolved && mr) {
          const res = await resolveRecipeOracleConstraint({
            client: resolved.client,
            ctx,
            chainId,
            mr,
            recipe: jm.recipe,
            collateralAsset: jm.collateralAsset,
            referenceAsset: jm.referenceAsset,
            ...(BigInt(jm.rateOverride) > 0n ? { fixedRate: BigInt(jm.rateOverride) } : {}),
            wantConstraint: false,
          });
          if (!res.gate && res.oracle.address) {
            const derived = deriveJitMarket({
              collateralAsset: jm.collateralAsset,
              referenceAsset: jm.referenceAsset,
              expiryTimestamp: BigInt(jm.expiryTimestamp),
              constraint: {
                rateMin: BigInt(jm.constraint.rateMin),
                rateMax: BigInt(jm.constraint.rateMax),
                rateChangePerDayMax: BigInt(jm.constraint.rateChangePerDayMax),
                rateChangeCapacityMax: BigInt(jm.constraint.rateChangeCapacityMax),
              },
              oracle: res.oracle.address,
            });
            if (derived.poolId.toLowerCase() !== action.dstPoolId.toLowerCase()) {
              warnings.push({ code: "jit_pool_mismatch", message: `dstPoolId ${action.dstPoolId} is NOT the pool this jitMarket instruction derives (${derived.poolId}, against oracle ${res.oracle.address}${res.oracle.deployed ? "" : " — predicted; the fill deploys it"}) — the fill WILL revert BaseFiller__JitPoolMismatch. Constraint values are part of pool identity: re-derive with cork_query derive-cork-pool and use ITS poolId (and predicted dst cST) before signing` });
            }
          }
        }
      } catch {
        /* best-effort leg: a transport failure must not block an offline-buildable artifact */
      }
      jitMarketHash = hashJitMarketParams({
        collateralAsset: jm.collateralAsset,
        referenceAsset: jm.referenceAsset,
        expiryTimestamp: BigInt(jm.expiryTimestamp),
        recipe: jm.recipe,
        rateOverride: BigInt(jm.rateOverride),
        rateMin: BigInt(jm.constraint.rateMin),
        rateMax: BigInt(jm.constraint.rateMax),
        rateChangePerDayMax: BigInt(jm.constraint.rateChangePerDayMax),
        rateChangeCapacityMax: BigInt(jm.constraint.rateChangeCapacityMax),
        additionalData: jm.additionalData,
        swapFeePercentage: BigInt(jm.swapFeePercentage),
        unwindSwapFeePercentage: BigInt(jm.unwindSwapFeePercentage),
      });
    }

    if (jitMarketHash !== undefined && jitMarketHash !== ZERO_JIT_MARKET_HASH) {
      warnings.push({ code: "jit_market_notice", message: "this order commits to just-in-time DESTINATION-market creation (non-zero jitMarketHash) — contract-valid (BaseFiller fillWithJitMarket), but the venue's admission (cork-api ≤0.3.16) requires the destination cST/pool to already be INDEXED and its expiry known, with no jitMarketHash bypass: cork_submit can relay this order only once the dst pool exists on-chain; until then hand the signed order to your filler venue-free" });
    }

    // Deterministic venue-admission battery, shared with submit ([F14]: the two surfaces must
    // refuse the same orders). The builder pins intent.deadline = fillDeadline and attaches no
    // hooks, so the submit-side extras don't apply here.
    const openDeadline = BigInt(action.openDeadline);
    const fillDeadline = BigInt(action.fillDeadline);
    const orderSize = BigInt(action.orderSize);
    const violation = checkRolloverOrderTerms({
      nowSeconds: nowSecondsOf(ctx),
      openDeadline,
      fillDeadline,
      orderSize,
      minPremiumPerShare: BigInt(action.minPremiumPerShare),
      srcCstToken: action.srcCstToken,
      dstCstToken: action.dstCstToken,
      premiumToken: action.premiumToken,
      srcPoolId: action.srcPoolId,
      dstPoolId: action.dstPoolId,
      settler: action.settler,
      ...(action.exclusiveFiller !== undefined ? { exclusiveFiller: action.exclusiveFiller } : {}),
    });
    if (violation) return unavailable(chainId, "invalid_order_terms", `${violation} — the venue would reject the signed order with the same complaint`, ctx);

    const built = buildRolloverIntent({
      chainId,
      user: input.account,
      settler: action.settler,
      rolloverContract: action.rolloverContract,
      srcCstToken: action.srcCstToken,
      dstCstToken: action.dstCstToken,
      premiumToken: action.premiumToken,
      srcPoolId: action.srcPoolId,
      dstPoolId: action.dstPoolId,
      orderSize,
      minPremiumPerShare: BigInt(action.minPremiumPerShare),
      openDeadline,
      fillDeadline,
      ...(action.minCaReceived !== undefined ? { minCaReceived: BigInt(action.minCaReceived) } : {}),
      ...(action.minSharesOut !== undefined ? { minSharesOut: BigInt(action.minSharesOut) } : {}),
      ...(jitMarketHash !== undefined ? { jitMarketHash } : {}),
      allowPartialFills: action.allowPartialFills,
      allowUnderfill: action.allowUnderfill,
      ...(action.premiumPaymentMode !== undefined ? { premiumPaymentMode: action.premiumPaymentMode } : {}),
      ...(action.fillerHint !== undefined ? { fillerHint: action.fillerHint } : {}),
      ...(action.exclusiveFiller !== undefined ? { exclusiveFiller: action.exclusiveFiller } : {}),
      ...(action.orderSalt !== undefined ? { orderSalt: BigInt(action.orderSalt) } : {}),
      ...(action.nonce !== undefined ? { nonce: BigInt(action.nonce) } : {}),
      clientRequestId: input.clientRequestId,
    });
    return envelope({
      state: "ok",
      data: {
        kind: "rollover-intent",
        settler: action.settler,
        ...(kind ? { settlerKind: kind } : {}),
        typedData: { domain: built.domain, types: built.types, primaryType: built.primaryType, message: built.order },
        orderDigest: built.orderDigest,
        rolloverIntentHash: built.rolloverIntentHash,
        orderDataType: built.orderDataType,
        venuePost: built.venuePost,
        execution: executionRolloverIntent(),
        clientRequestId: input.clientRequestId,
      },
      chainId,
      source: "config",
      warnings,
      ctx,
    });
  }

  if (action.type === "taker-fill") {
    const lop = LOP_ADDRESSES[chainId];
    if (!lop) return unavailable(chainId, "no_lop", `no known 1inch LOP v4 deployment for chainId ${chainId}`, ctx);
    const wanted = action.orderHash.toLowerCase();

    // ── Inline signed order: the caller already holds the bytes, so the venue is NOT
    // contacted at all — a flaky book or a dropped row cannot block a fill of bytes in hand.
    // The verification bar is the venue path's and stricter: [K3] local re-hash against the
    // claimed orderHash, the salt↔extension binding OrderLib enforces at fill, and the maker
    // signature verified the way the fill verifies it (ecrecover / the ERC-1271 staticcall);
    // the shared tail then runs the same on-chain liveness pre-flight [K7].
    if (action.signedOrder) {
      const so = action.signedOrder;
      const order: LopOrder = { salt: BigInt(so.order.salt), maker: so.order.maker, receiver: so.order.receiver, makerAsset: so.order.makerAsset, takerAsset: so.order.takerAsset, makingAmount: BigInt(so.order.makingAmount), takingAmount: BigInt(so.order.takingAmount), makerTraits: BigInt(so.order.makerTraits) };
      const localOrderHash = hashLopOrder(chainId, lop, order);
      if (localOrderHash.toLowerCase() !== wanted) {
        return envelope({
          state: "conflict",
          data: { requestedOrderHash: action.orderHash, localOrderHash },
          chainId,
          source: "config",
          warnings: [{ code: "order_hash_mismatch", message: "the supplied signedOrder does not hash to orderHash — no fill bytes were built. The EIP-712 order hash is CHAIN-SPECIFIC (check chainId) and covers exactly the 8 struct fields (check them against the order you meant)" }],
          ctx,
        });
      }
      if (so.extension !== "0x" && !saltExtensionBinding(order.salt, so.extension).bound) {
        return envelope({
          state: "conflict",
          data: { orderHash: localOrderHash },
          chainId,
          source: "config",
          warnings: [{ code: "signature_or_reconstruction_mismatch", message: "the salt's low 160 bits are not bound to keccak256(extension) — OrderLib enforces this binding at fill (InvalidExtension), so these bytes can never fill. Pass the order's OWN extension verbatim; no fill bytes were built" }],
          ctx,
        });
      }
      // A zero makingAmount here is a CALLER-supplied order — attribution differs from the
      // venue path, where the same defect is a malformed service row.
      if (order.makingAmount === 0n) {
        return unavailable(chainId, "invalid_order_terms", "the supplied signed order has makingAmount 0 — nothing is fillable", ctx);
      }
      const verdict = await verifyMakerSignatureLadder({ ctx, chainId, maker: order.maker, orderHash: localOrderHash, signature: so.signature });
      if (verdict.kind === "erc1271_transport") {
        return unavailable(chainId, "chain_read_failed", `the maker ${order.maker} is a CONTRACT account but its isValidSignature staticcall failed in transport (${verdict.reason}) — the ERC-1271 signature could not be verified either way; retry with a working RPC (the fill path requires this exact call to answer)`, ctx);
      }
      if (verdict.kind === "erc1271_rejected" || verdict.kind === "eoa_mismatch" || verdict.kind === "unparseable") {
        return envelope({
          state: "conflict",
          data: { orderHash: localOrderHash, maker: order.maker, ...(verdict.kind === "erc1271_rejected" ? { makerAccountType: "ERC1271", isValidSignatureAnswer: verdict.isValidSignatureAnswer } : {}), ...(verdict.kind === "eoa_mismatch" ? { recoveredSigner: verdict.recoveredSigner } : {}) },
          chainId,
          source: verdict.kind === "erc1271_rejected" ? "chain" : "config",
          warnings: [{
            code: "signature_or_reconstruction_mismatch",
            message:
              verdict.kind === "erc1271_rejected"
                ? `the maker ${order.maker} is a CONTRACT account and its isValidSignature(orderHash, signature) did not answer the ERC-1271 magic value — the fill runs this exact staticcall, so these bytes can only revert; no fill bytes were built. (For a Safe, the hash must have been approved/signed per its own ERC-1271 scheme.)`
                : verdict.kind === "eoa_mismatch"
                  ? `the signature recovers to ${verdict.recoveredSigner}, not the order maker ${order.maker} — the fill would revert on it, so no fill bytes were built. If the maker is a CONTRACT account (ERC-1271, e.g. a Safe), make sure an RPC resolves (CORK_RPC_URL) so the maker's code can be detected`
                  : `${verdict.reason} — no fill bytes were built`,
          }],
          ctx,
        });
      }
      const acquisitionWarnings: Array<{ code: string; message: string }> = [];
      if (verdict.kind === "eoa") {
        const w = makerCodeUnknownWarning(verdict.codeProbe, "it is treated as an EOA order");
        if (w) acquisitionWarnings.push(w);
      }
      const signed: SignedLopOrder = { order, signature: so.signature, extension: so.extension, makerAccountType: verdict.kind === "erc1271" ? "ERC1271" : "EOA" };
      return await buildTakerFillArtifact({ ctx, chainId, account: input.account, clientRequestId: input.clientRequestId, action, lop, signed, localOrderHash, acquisitionWarnings, artifactSource: verdict.kind === "erc1271" ? "chain" : "config" });
    }

    const deps = venueDepsOf(ctx);
    try {
      // Locate the resting order in the venue book under a hard page bound; an exhausted bound
      // fails closed (no false "not found") rather than truncating silently.
      const book = await collectVenuePages(
        { maxPages: action.maxPages },
        (cursor) => getLopOrderbook(deps, { chainId, limit: 100, ...(cursor ? { cursor } : {}) }),
      );
      const row = book.items.find((item) => {
        const nested = item.order && typeof item.order === "object" && !Array.isArray(item.order) ? (item.order as Record<string, unknown>) : item;
        const h = nested.orderHash ?? nested.order_hash ?? item.orderHash ?? item.order_hash;
        return typeof h === "string" && h.toLowerCase() === wanted;
      });
      if (!row) {
        if (!book.complete) {
          return envelope({
            state: "conflict",
            data: { requestedOrderHash: action.orderHash, pagesFetched: book.pagesFetched, reason: book.reason, ...(book.nextCursor ? { nextCursor: book.nextCursor } : {}) },
            chainId,
            source: "service",
            warnings: [{ code: "pagination_incomplete", message: `the orderbook search was incomplete (${book.reason}); no absence claim or fill bytes were produced` }],
            ctx,
          });
        }
        return unavailable(chainId, "order_not_found", `no resting venue order found for ${action.orderHash} on chainId ${chainId}`, ctx);
      }
      const parsed = parseSignedLopOrder(row);
      if (!parsed.ok) return unavailable(chainId, "invalid_service_response", `venue returned a malformed signed order — ${parsed.error}`, ctx);
      const signed = parsed.value;
      // [K3] re-hash the venue's order locally; a row that does not hash to the requested order
      // (or disagrees with the venue's own claimed hash) yields NO fill bytes.
      const localOrderHash = hashLopOrder(chainId, lop, signed.order);
      if (localOrderHash.toLowerCase() !== wanted || (signed.venueOrderHash !== undefined && signed.venueOrderHash.toLowerCase() !== localOrderHash.toLowerCase())) {
        return envelope({
          state: "conflict",
          data: { requestedOrderHash: action.orderHash, localOrderHash, venueOrderHash: signed.venueOrderHash ?? null },
          chainId,
          source: "service",
          warnings: [{ code: "order_hash_mismatch", message: "the venue row does not hash to the requested order — no fill bytes were built (formerly digest_mismatch)" }],
          ctx,
        });
      }
      // A zero makingAmount is a malformed VENUE row (nothing fillable), not a caller mistake —
      // attribute it correctly instead of surfacing a divisor error as invalid_order_terms.
      if (signed.order.makingAmount === 0n) {
        return unavailable(chainId, "invalid_service_response", `venue returned a resting order with makingAmount 0 for ${action.orderHash} — a malformed row; no fill bytes were built`, ctx);
      }
      // The venue's in-band notices ride the book pages this search read (e.g. the premium
      // deprecation) — the fill path is exactly who they are for.
      return await buildTakerFillArtifact({ ctx, chainId, account: input.account, clientRequestId: input.clientRequestId, action, lop, signed, localOrderHash, acquisitionWarnings: venueNoticeWarnings(book), artifactSource: "service" });
    } catch (err) {
      return venueFailed(chainId, err, ctx);
    }
  }

  return unavailable(chainId, "phase_gated", `prepare_orders '${(action as { type: string }).type}' is not implemented`, ctx);
}

type TakerFillAction = Extract<PrepareOrdersInput["action"], { type: "taker-fill" }>;

/** The shared taker-fill tail — liveness pre-flight, forSelf contradiction gates, JIT
 *  interaction building, auction pricing, and the fill-bytes envelope. Identical whichever way
 *  the signed order was acquired: the venue book search, or the caller-supplied `signedOrder`
 *  (which never contacts the venue). */
type MakerLadderAction = Extract<PrepareOrdersInput["action"], { type: "maker-ladder" }>;
type MakerOrderAction = Extract<PrepareOrdersInput["action"], { type: "maker-order" }>;

/**
 * A ladder is a FAN-OUT over the maker-order path, not a second implementation: every rung is
 * built by re-entering handlePrepareOrders with a derived maker-order input, so JIT, auction,
 * approvals, and every pre-flight behave rung-for-rung exactly as they do for one order. This
 * function owns only what is ladder-shaped — the rung ids, the nonce policy, the capacity
 * accounting, the one notice, and the fail-closed rule (a ladder is one intent: any rung's
 * refusal is the ladder's refusal, no partial artifacts).
 */
async function handleMakerLadder(input: PrepareOrdersInput, action: MakerLadderAction, ctx: HandlerContext): Promise<Envelope> {
  const chainId = input.chainId;
  const ladderId = input.clientRequestId;
  // ladderRungClientRequestId throws on an over-long id; checked here first so the caller gets a
  // teaching envelope (invalid_order_terms), not an internal_error from a thrown helper.
  if (ladderId.length > LADDER_ID_MAX) {
    return unavailable(chainId, "invalid_order_terms", `ladder clientRequestId is ${ladderId.length} chars; rung ids are '<ladderId>:<index>' and must stay within 128 characters — use at most ${LADDER_ID_MAX}`, ctx);
  }
  const group = action.ocoGroup ?? ladderId;
  const policy = action.noncePolicy;
  // The nonce policy, as ONE predicate: which rungs share the group's bit. shared-reserved is the
  // ruled default (a revision ladder for one taker; an open rung fills independently).
  const grouped = (reserved: boolean): boolean => policy === "shared" || (policy === "shared-reserved" && reserved);

  const rungs: Array<{ index: number; clientRequestId: string; reach: "open" | "reserved"; grouped: boolean; label?: string; makingAmount: bigint; env: Envelope }> = [];
  for (const [index, rung] of action.rungs.entries()) {
    const reserved = rung.allowedSender !== undefined;
    const isGrouped = grouped(reserved);
    const rungAction: MakerOrderAction = {
      type: "maker-order",
      poolId: action.poolId,
      side: action.side,
      makerAsset: action.makerAsset,
      takerAsset: action.takerAsset,
      makingAmount: rung.makingAmount ?? action.makingAmount,
      takingAmount: rung.takingAmount,
      allowsPartialFills: action.allowsPartialFills,
      usePermit2: action.usePermit2,
      ...(rung.expirySeconds !== undefined ? { expirySeconds: rung.expirySeconds } : action.expirySeconds !== undefined ? { expirySeconds: action.expirySeconds } : {}),
      ...(rung.allowedSender !== undefined ? { allowedSender: rung.allowedSender } : {}),
      ...(isGrouped ? { ocoGroup: group } : {}),
      ...(rung.auction !== undefined ? { auction: rung.auction } : {}),
      ...(action.jitMarket !== undefined ? { jitMarket: action.jitMarket } : {}),
    };
    const clientRequestId = ladderRungClientRequestId(ladderId, index);
    const env = await handlePrepareOrders({ ...input, clientRequestId, action: rungAction }, ctx);
    if (env.state !== "ok") {
      // Fail closed, and say which rung: the rung's own code and message carry the fix.
      return envelope({
        state: env.state,
        data: { kind: "maker-ladder", failedRung: { index, clientRequestId, ...(rung.label !== undefined ? { label: rung.label } : {}) }, rung: env.data },
        warnings: env.warnings.map((w, i) => ({ ...w, message: `rung ${index}${rung.label ? ` (${rung.label})` : ""}: ${w.message}${i === 0 ? " — no ladder artifact was built; a ladder is one intent" : ""}` })),
        chainId,
        source: "config",
        ctx,
      });
    }
    rungs.push({ index, clientRequestId, reach: reserved ? "reserved" : "open", grouped: isGrouped, ...(rung.label !== undefined ? { label: rung.label } : {}), makingAmount: BigInt(rungAction.makingAmount), env });
  }

  // CAPACITY: the maker asset the ladder can consume. Rungs on one bit can fill at most once
  // between them, so a group counts once at its LARGEST rung; every ungrouped rung is its own
  // group and adds up.
  const groupMax = new Map<string, bigint>();
  for (const r of rungs) {
    const bucket = r.grouped ? `group:${group}` : `rung:${r.index}`;
    const prev = groupMax.get(bucket) ?? 0n;
    if (r.makingAmount > prev) groupMax.set(bucket, r.makingAmount);
  }
  const makerAssetRequired = [...groupMax.values()].reduce((s, v) => s + v, 0n);
  const groupedIdx = rungs.filter((r) => r.grouped).map((r) => r.index);
  const openIdx = rungs.filter((r) => !r.grouped).map((r) => r.index);
  const capacityRule =
    groupedIdx.length > 0 && openIdx.length > 0
      ? `rungs ${groupedIdx.join(",")} share one bit (count once, at the largest) and rungs ${openIdx.join(",")} each fill independently (each counts): ${makerAssetRequired} base units of makerAsset can be consumed in total`
      : groupedIdx.length > 0
        ? `every rung shares one bit: at most one fills, so the largest rung (${makerAssetRequired}) is the whole exposure`
        : `every rung has its own bit: all can fill, so the sum (${makerAssetRequired}) is the exposure`;

  // Warnings: rung warnings are collapsed by (code, message) with the rungs that raised them,
  // and the per-rung oco_group_notice is replaced by ONE ladder-level notice.
  const collapsed = new Map<string, { code: string; message: string; rungs: number[] }>();
  for (const r of rungs) {
    for (const w of r.env.warnings) {
      if (w.code === "oco_group_notice") continue;
      const bucket = `${w.code}|${w.message}`;
      const e = collapsed.get(bucket);
      if (e) e.rungs.push(r.index);
      else collapsed.set(bucket, { code: w.code, message: w.message, rungs: [r.index] });
    }
  }
  const warnings: Array<{ code: string; message: string }> = [...collapsed.values()].map((e) => ({ code: e.code, message: `rung${e.rungs.length > 1 ? "s" : ""} ${e.rungs.join(",")}: ${e.message}` }));
  if (groupedIdx.length > 0) {
    const nonce = (rungs[groupedIdx[0]!]!.env.data as { nonce: string }).nonce;
    warnings.push({
      code: "oco_group_notice",
      message: `rungs ${groupedIdx.join(",")} share invalidator nonce ${nonce} (ocoGroup '${group}'): the first fill or cancel of ANY of them retires ALL of them (one-cancels-the-other), and a PARTIAL fill spends the bit too${openIdx.length > 0 ? `; rungs ${openIdx.join(",")} are on their own bits and can fill in addition` : ""}. The venue does not learn the group — a rung left OPEN on the book after a sibling filled is dead on chain; re-read the bit before ranking or filling it. To withdraw the group, cancel any one grouped rung. Vocabulary: ${ORDERS_TOPIC_REFERENCE}`,
    });
  }

  const lop = (rungs[0]!.env.data as { lop: string }).lop;
  return envelope({
    state: "ok",
    data: {
      kind: "maker-ladder",
      lop,
      ladder: { clientRequestId: ladderId, ocoGroup: group, noncePolicy: policy, rungCount: rungs.length },
      rungs: rungs.map((r) => ({ index: r.index, clientRequestId: r.clientRequestId, reach: r.reach, grouped: r.grouped, ...(r.label !== undefined ? { label: r.label } : {}), ...(r.env.data as Record<string, unknown>) })),
      capacity: { makerAssetRequired: makerAssetRequired.toString(), rule: capacityRule },
      scales: { makerAssetRequired: "base units of makerAsset (the token's own decimals)", unitsTopic: UNITS_TOPIC_REFERENCE },
      execution: executionMakerLadder(),
    },
    warnings,
    chainId,
    source: "config",
    ctx,
  });
}

async function buildTakerFillArtifact(a: {
  ctx: HandlerContext;
  chainId: PrepareOrdersInput["chainId"];
  account: `0x${string}`;
  clientRequestId: string;
  action: TakerFillAction;
  lop: `0x${string}`;
  signed: SignedLopOrder;
  localOrderHash: `0x${string}`;
  /** Warnings from the acquisition path: venue notices, or the inline path's disclosures. */
  acquisitionWarnings: Array<{ code: string; message: string }>;
  artifactSource: "service" | "config" | "chain";
}): Promise<Envelope> {
  const { ctx, chainId, account, clientRequestId, action, lop, signed, localOrderHash } = a;
  // Exclusivity pre-flight, chain-free from the signed bytes [K3]: a reserved order admits ONE
  // filler — the LOP compares the LOW 80 BITS of msg.sender to the suffix the maker signed and
  // reverts PrivateOrder() otherwise. The sender is whoever CALLS the LOP: the account on the
  // raw path, the ForSelf ADAPTER on the wrapper path (the wrapper is the LOP's caller, the
  // account only calls the wrapper). Bytes that can only revert are not built; the message
  // names the reserved suffix so a taker who controls that sender can re-prepare with it.
  const allowedSender = decodeMakerTraits(signed.order.makerTraits).allowedSender;
  const fillSender = action.forSelf ? action.forSelf.adapter : account;
  if (allowedSender !== null && !isAllowedSender(signed.order.makerTraits, fillSender)) {
    return envelope({
      state: "unavailable",
      data: { orderHash: localOrderHash, allowedSender, fillSender, fillSenderSuffix: allowedSenderSuffix(fillSender) },
      chainId,
      source: "config",
      warnings: [{ code: "private_order", message: `this order is reserved for a filler whose address ends in ${allowedSender} (the signed makerTraits allowed-sender slot), but ${action.forSelf ? `a ForSelf fill is sent to the LOP by the ADAPTER ${fillSender}` : `this fill would be sent by ${fillSender}`}, whose last 10 bytes are ${allowedSenderSuffix(fillSender)} — the LOP reverts PrivateOrder(), so no fill bytes were built. If you control the reserved sender, prepare again with it as ${action.forSelf ? "the adapter (the LOP sees the adapter, never the account, on the wrapper path)" : "account"}; otherwise this order is not yours to lift. Reach vocabulary (fill sender vs beneficiary): ${ORDERS_TOPIC_REFERENCE}` }],
      ctx,
    });
  }
  // Liveness pre-flight [K7]: the venue can list rows whose on-chain invalidator already
  // says filled-or-cancelled (observed live 2026-08-06 — every resting sell row was dead).
  // Fill bytes for such an order can only revert InvalidatedOrder, so a DEFINITIVE dead
  // reading is a conflict (chain outranks the venue), not an artifact. Best-effort: no
  // resolved RPC or a failed read builds as before (this tool never claimed liveness).
  // The resolved client is hoisted: the approval-status annotation below reuses it, so this
  // path's chain-contact policy is unchanged (one resolution, security + advisory reads).
  const resolved = await getRpc(ctx, chainId);
  {
    if (resolved) {
      try {
        const plan = lopInvalidatorPlan(signed.order.makerTraits);
        const status = classifyInvalidatorWord(plan, await readLopInvalidator(resolved.client, plan, lop, signed.order.maker, localOrderHash));
        if (status.status === "filled-or-cancelled") {
          return envelope({
            state: "conflict",
            data: { orderHash: localOrderHash, venueStatus: "resting", chainStatus: status.status },
            chainId,
            source: "chain",
            warnings: [{ code: "status_mismatch", message: `the venue lists this order as resting, but its on-chain ${plan.mode === "bit" ? "bit" : "remaining"} invalidator says FILLED-OR-CANCELLED — chain outranks the venue [K7]; a fill of these bytes can only revert InvalidatedOrder, so none were built` }],
            ctx,
          });
        }
      } catch {
        /* liveness could not be read — build as before; the fill's own check decides */
      }
    }
  }
  // ForSelf mode contradictions are teaching errors BEFORE any building: the wrapper
  // structurally forces the target to the caller and cannot carry taker interactions.
  if (action.forSelf) {
    if (action.receiver !== undefined) {
      throw new ToolInputError("cork_prepare_orders", [{ path: ["action", "receiver"], message: "forSelf and receiver are mutually exclusive — the ForSelf wrapper structurally delivers the bought asset to the CALLING account (that is its whole point); drop receiver, or drop forSelf to route a custom receiver through the raw LOP path" }]);
    }
    if (action.interaction !== undefined || action.jitMarket !== undefined) {
      throw new ToolInputError("cork_prepare_orders", [{ path: ["action", action.interaction !== undefined ? "interaction" : "jitMarket"], message: "forSelf cannot carry a taker interaction — the wrapper zeroes the interaction-length bits by design (a mid-fill callee while it holds a live allowance would defeat its custody model). Lifting a BUY-cover order with a taker-side JIT mint is the underwriter's raw-LOP path, not a caged-wallet path" }]);
    }
  }
  // Taker-side JIT: build the interaction bytes with the full pre-flight ladder.
  let interaction = action.interaction;
  let jitData: TakerJitReport | undefined;
  const jitWarnings: Array<{ code: string; message: string }> = [];
  if (action.jitMarket) {
    if (action.interaction !== undefined) {
      throw new ToolInputError("cork_prepare_orders", [{ path: ["action", "interaction"], message: "interaction and jitMarket are mutually exclusive — jitMarket BUILDS the interaction" }]);
    }
    const built = await buildTakerJitInteraction({ ctx, chainId, lop, jm: action.jitMarket, order: signed.order, orderExtension: signed.extension });
    if (built.gate) return built.gate;
    interaction = built.interaction;
    jitData = built.jit;
    jitWarnings.push(...built.warnings);
  }
  // Auction-priced resting order (fusion F2): the amount getter charges the DECAYED price,
  // not the signed floor — so buildTakerFill's default slippage cap (the signed ratio, i.e.
  // the floor) would make the artifact revert TakingAmountTooHigh for the entire decay
  // window. Default the cap to the curve's CEILING instead: valid at ANY broadcast time
  // (the getter only ever charges less; the cap is a threshold, not a payment), with the
  // current/floor prices reported so the taker sees what they are agreeing to.
  let auctionData: AuctionPriceReport | undefined;
  let auctionCap: bigint | undefined;
  if (signed.extension !== undefined && signed.extension !== "0x") {
    let auctionDec: DecodedFusionOrder | undefined;
    try {
      auctionDec = decodeFusionOrder(signed.order, signed.extension, chainId);
    } catch (err) {
      // A CLASSIFIED getter means the order's price comes from a contract we cannot price
      // (audit ARTIFACT-FUSION-003). We must not DERIVE a cap from its tail bytes — that would
      // be inventing a number for a charge we do not understand. A taker who sets an explicit
      // maximumTakingAmount still gets bytes: the LOP enforces that cap on-chain
      // (TakingAmountTooHigh), so the unknown getter can only make the fill revert, never
      // overcharge. Any other decode failure just means the extension is not auction-priced.
      if (err instanceof NotAFusionOrder && err.settlement !== undefined && err.classification !== undefined) {
        const code = err.classification === "legacy" ? "phase_gated" : "settler_not_recognized";
        if (action.maximumTakingAmount === undefined) {
          return envelope({
            state: "unavailable",
            data: { kind: "taker-fill", orderHash: localOrderHash, settlement: err.settlement, classification: err.classification },
            chainId,
            source: "config",
            warnings: [
              { code, message: `${err.message}. No fill bytes were emitted: the default slippage cap is DERIVED from the auction curve, and this getter's curve cannot be read. Pass an explicit maximumTakingAmount — the LOP enforces it on-chain — if you intend to fill at a price you set yourself` },
              ...a.acquisitionWarnings,
            ],
            ctx,
          });
        }
        jitWarnings.push({ code, message: `${err.message}. You set an explicit maximumTakingAmount, which the LOP enforces on-chain, so the fill is built — but what this getter charges below that cap was NOT derived here` });
      }
    }
    if (auctionDec) {
      const nowSecs = nowSecondsOf(ctx);
      const fillMaking = action.fillMakingAmount ? BigInt(action.fillMakingAmount) : signed.order.makingAmount;
      const whitelisted = isGetterWhitelisted(auctionDec.fees, account);
      const fee = fusionTotalFee(auctionDec.fees, whitelisted);
      const bumpNow = fusionRateBump(auctionDec.auction, nowSecs, null);
      // Foreign curves may put a point ABOVE initialRateBump (our own encoder refuses, the
      // parser does not) — the safe ceiling is the curve's MAXIMUM bump, wherever it sits.
      const maxBump = auctionDec.auction.points.reduce((m, p) => (p.rateBump > m ? p.rateBump : m), auctionDec.auction.initialRateBump);
      const M = signed.order.makingAmount;
      const T = signed.order.takingAmount;
      const currentTakerPays = fusionTakerPays(M, T, fillMaking, fee, bumpNow.effective);
      const ceilingTakerPays = fusionTakerPays(M, T, fillMaking, fee, maxBump);
      const finish = auctionDec.auction.startTime + auctionDec.auction.duration;
      if (action.maximumTakingAmount === undefined) auctionCap = ceilingTakerPays;
      auctionData = {
        settlement: auctionDec.settlement,
        classification: auctionDec.classification,
        phase: auctionPhase(auctionDec.auction, nowSecs),
        currentTakerPays: String(currentTakerPays),
        ceilingTakerPays: String(ceilingTakerPays),
        floorTakerPays: String(fusionTakerPays(M, T, fillMaking, fee, 0n)),
        decayEndsAt: String(finish),
        takerIsGetterWhitelisted: whitelisted,
        priceBasis: "basefee-independent upper bound — the gas bump can only LOWER the charge",
      };
      jitWarnings.push({ code: "decaying_price_notice", message: `this resting order is AUCTION-priced: the getter charges the DECAYED price (currently ${currentTakerPays}, floor at ${fusionTakerPays(M, T, fillMaking, fee, 0n)}, decay ends at ${finish})${action.maximumTakingAmount === undefined ? ` — the slippage cap was defaulted to the curve ceiling ${ceilingTakerPays} so the artifact stays valid at any broadcast time` : ""}. Re-price with cork_compute dutch-auction-price at broadcast time and simulate first` });
      if (action.maximumTakingAmount !== undefined && BigInt(action.maximumTakingAmount) < currentTakerPays) {
        jitWarnings.push({ code: "would_revert", message: `your maximumTakingAmount ${action.maximumTakingAmount} is BELOW the current decayed price ${currentTakerPays} — the fill reverts until the price decays under your cap (a resting-bid strategy; fine if intended, dead bytes if not; decay ends at ${finish})` });
      }
    }
  }
  // ForSelf mode: the same fill, emitted as a call to the integrator-deployed wrapper.
  if (action.forSelf) {
    return await prepareForSelfTakerFill({
      ctx,
      chainId,
      account: account,
      clientRequestId: clientRequestId,
      lop,
      forSelf: action.forSelf,
      signed,
      localOrderHash,
      ...(action.fillMakingAmount !== undefined ? { fillMakingAmount: BigInt(action.fillMakingAmount) } : {}),
      ...(action.maximumTakingAmount !== undefined ? { maximumTakingAmount: BigInt(action.maximumTakingAmount) } : {}),
      ...(auctionCap !== undefined ? { auctionCap } : {}),
      ...(auctionData !== undefined ? { auctionData } : {}),
      priorWarnings: jitWarnings,
    });
  }
  let fill: TakerFillResult;
  try {
    fill = buildTakerFill({
      order: signed.order,
      signature: signed.signature,
      makerAccountType: signed.makerAccountType,
      taker: account,
      extension: signed.extension,
      ...(action.receiver ? { receiver: action.receiver } : {}),
      ...(action.fillMakingAmount ? { fillMakingAmount: BigInt(action.fillMakingAmount) } : {}),
      ...(action.maximumTakingAmount ? { maximumTakingAmount: BigInt(action.maximumTakingAmount) } : auctionCap !== undefined ? { maximumTakingAmount: auctionCap } : {}),
      ...(interaction ? { interaction } : {}),
    });
  } catch (err) {
    return unavailable(chainId, "invalid_order_terms", err instanceof Error ? err.message : "the resting order cannot be filled by this variant", ctx);
  }
  // The taker's (hedger's) approval requirements, with the fill's ACTUAL cap (for an auction
  // row that is the curve ceiling the cap was defaulted to). Annotated against the client the
  // liveness pre-flight already resolved — no extra chain-contact policy.
  const takerJitCtx =
    jitData && action.jitMarket
      ? { adapter: jitData.adapter, collateralAsset: action.jitMarket.collateralAsset, ...(jitData.predictedCorkSwapToken ? { predictedCorkSwapToken: jitData.predictedCorkSwapToken } : {}) }
      : undefined;
  let approvals = takerApprovalRequirements({
    taker: account,
    takerAsset: signed.order.takerAsset,
    requiredTakingAmount: BigInt(fill.requiredTakingAmount),
    lop,
    ...(auctionData ? { auction: true } : {}),
    ...(takerJitCtx ? { jit: takerJitCtx } : {}),
  });
  if (resolved) {
    approvals = await annotateApprovalStatus(resolved.client, { entries: approvals, nowSeconds: nowSecondsOf(ctx), ...(ctx.atBlock !== undefined ? { atBlock: ctx.atBlock } : {}) });
  }
  const takerApprovalWarn = approvalMissingWarning(approvals, "before broadcasting this fill");
  if (takerApprovalWarn) jitWarnings.push(takerApprovalWarn);
  return envelope({
    state: "ok",
    data: {
      kind: "taker-fill",
      to: lop,
      calldata: fill.calldata,
      value: "0",
      from: account,
      orderHash: localOrderHash,
      makerAsset: signed.order.makerAsset,
      takerAsset: signed.order.takerAsset,
      fillFunction: fill.functionName,
      requiredMakingAmount: fill.requiredMakingAmount,
      requiredTakingAmount: fill.requiredTakingAmount,
      takerTraits: fill.takerTraits,
      // The order's exclusivity as signed (null = open); a non-null value here is the suffix
      // this fill's sender was just checked against.
      allowedSender,
      approvals,
      // A caller-assembled interaction is opaque bytes: whatever tokens the interaction
      // contract itself pulls mid-fill are invisible here — say so instead of implying the
      // report is complete (jitMarket-built interactions ARE characterized, in `jit`).
      ...(action.interaction !== undefined ? { approvalsNote: "a custom taker interaction rides this fill — any tokens the interaction contract itself pulls are OUTSIDE this approvals report; discover them with cork_track simulate before granting anything" } : {}),
      ...(jitData ? { jit: jitData } : {}),
      ...(auctionData ? { auction: auctionData } : {}),
      // Money outputs carry their unit [R1 convention]: two tokens' quanta meet on this result
      // and neither is necessarily 18-decimals.
      scales: { requiredMakingAmount: "base units of makerAsset (the token's own decimals)", requiredTakingAmount: "base units of takerAsset — the on-chain cap the calldata enforces", unitsTopic: UNITS_TOPIC_REFERENCE },
      simulationRequired: true,
      execution: executionEthTransaction(),
      clientRequestId: clientRequestId,
    },
    chainId,
    source: a.artifactSource,
    warnings: [...jitWarnings, { code: "unsigned_artifact", message: "unsigned fill calldata only — independently simulate it (cork_track simulate) and ensure the taker-asset allowance before signing or broadcasting" }, ...a.acquisitionWarnings],
    ctx,
  });
}
