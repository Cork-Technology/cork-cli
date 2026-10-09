// Split from handlers.ts (2026-08-05): prepare-orders handlers — one typed dispatch, per-tool modules.
// Declarations are moved byte-identically; see handlers.ts for the runTool dispatch.
import { describeForeignTargets, extensionTargets, foreignExtensionTargets } from "../extension-targets.ts";
import { isAddressEqual, zeroHash } from "viem";
import { type ChainId, ORDERS_TOPIC_REFERENCE, UNITS_TOPIC_REFERENCE, Envelope, executionEthTransaction, executionMakerLadder, executionMakerOrder, executionMakerOrderContractMaker, executionRolloverIntent, PrepareOrdersInput } from "@cork/schemas";
import { allowedSenderSuffix, buildBitsInvalidateForOrder, buildCancelOrder, buildMakerOrder, buildTakerFill, classifyInvalidatorWord, decodeExtensionFields, decodeMakerTraits, encodeExtensionFields, hashLopOrder, isAllowedSender, LADDER_ID_MAX, ladderRungClientRequestId, LOP_ADDRESSES, type LopOrder, lopInvalidatorPlan, maskBits, planSlotSweep, readLopInvalidator, reconstructMakerOrder, type SlotSweepCandidate, slotCoordinates, type TakerFillResult } from "../orders.ts";
import { annotateApprovalStatus, type ApprovalRequirement, approvalMissingWarning, makerApprovalRequirements, takerApprovalRequirements } from "../order-approvals.ts";
import type { JitPermitWire, MarketRegistryWire } from "../generations.ts";
import { buildDeployFixedRateOracleCall, buildJitExtension, deriveJitMarket, type JITMarketParams, predictShares, wireCodec } from "../market-registry.ts";
import { resolveGenerations, resolveRollover } from "../config-remote.ts";
import { activeSettlersTeaching, buildRolloverIntent, checkRolloverOrderTerms, classifyRolloverSettler, hashJitMarketParams, retiredSettlerTeaching, type RolloverCall, type RolloverIntentArgs, standardRolloverHooks, RolloverJitWireError, ZERO_JIT_MARKET_HASH } from "../rollover.ts";
import { verificationDigest } from "../rollover-verify.ts";
import { type AuctionPriceReport, auctionPhase, buildAuctionAmountData, type DecodedFusionOrder, decodeFusionOrder, fusionRateBump, fusionTakerPays, fusionTotalFee, isGetterWhitelisted, NotAFusionOrder } from "../fusion.ts";
import { getLopOrderbook, parseSignedLopOrder, type SignedLopOrder, VENUE_OPEN_ORDERS_PER_POOL } from "../datasources/venue.ts";
import { envelope, getDep, getMarketRegistry, getRpc, type HandlerContext, nowSecondsOf, revertReason, ToolInputError, unavailable, venueDepsOf, venueFailed } from "./shared.ts";
import { fillRange, openRangeViolation, readRollPools, type RollPoolFacts, sameCollateralMinFill } from "./rollover-ranges.ts";
import { collectVenuePages, venueNoticeWarnings } from "./query.ts";
import { resolveListingPremium } from "./submit.ts";
import { buildTakerJitInteraction, diagnoseStaleSidePrediction, farFutureExpiryWarning, type JitLadderResult, jitValueGate, type LegacyJitReport, parsePermitWires, prepareJitLegacy, resolveFeeRule, resolveJitBytesInput, runJitPreflightLadder, type TakerJitReport, verifyExtraDataLayout } from "./jit.ts";
import { oracleRateEcho, resolveRecipeOracleConstraint } from "./registry.ts";
import { prepareForSelfTakerFill } from "./forself.ts";
import { assessMakerReadiness, decodeMakerExtensionContext, gatherMakerReadinessFacts, type MakerReadiness, makerReadinessTargetOf } from "./maker-readiness.ts";
import { handleAnswerRfq, handleRefreshOrder, type SugarDeps } from "./prepare-orders-sugars.ts";
import { handleDeployRolloverContract, handleRolloverFill } from "./prepare-rollover-fill.ts";
import { handleRfqWrite } from "./rfq-write.ts";
import { deriveJitDestination, readRolloverQuote } from "./rfq-rollover.ts";
import { rolloverQuoteDefaults, rolloverQuoteRefMismatch } from "../rfq-rollover.ts";

type RolloverIntentAction = Extract<PrepareOrdersInput["action"], { type: "rollover-intent" }>;
/** A rollover-intent's terms once a cited quote has filled the ones the caller left out. */
type QuoteFilledTerm = "srcPoolId" | "dstPoolId" | "premiumToken" | "orderSize" | "minPremiumPerShare";
type RolloverIntentTerms = Omit<RolloverIntentAction, QuoteFilledTerm> & { [K in QuoteFilledTerm]-?: NonNullable<RolloverIntentAction[K]> };
import { authenticateSignedOrder, makerCodeUnknownWarning, verifyMakerSignatureLadder } from "./order-auth.ts";
import { requesterCoverReading } from "./cover-mode.ts";

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
  /** The registry wire the extension bytes are encoded for + the generation it targets. */
  wire?: MarketRegistryWire;
  /** The JIT adapter's permit row (`vrs` = 65-byte ECDSA only, `bytes` = ECDSA or ERC-1271). */
  permitWire?: JitPermitWire;
  generation?: string;
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

export async function handlePrepareOrders(input: PrepareOrdersInput, ctx: HandlerContext): Promise<Envelope> {
  const chainId = input.chainId;
  const action = input.action;

  if (action.type === "maker-ladder") return handleMakerLadder(input, action, ctx);
  if (action.type === "rollover-fill") return handleRolloverFill(input, action, ctx);
  if (action.type === "deploy-rollover-contract") return handleDeployRolloverContract(input, action, ctx);
  if (action.type === "answer-rfq") return handleAnswerRfq(input, action, ctx, SUGAR_DEPS);
  if (action.type === "refresh-order") return handleRefreshOrder(input, action, ctx, SUGAR_DEPS);
  if (action.type === "rfq-write") return handleRfqWrite(input, action, ctx);

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
      if (verdict.kind === "eoa_mismatch" && verdict.codeProbe === "read-failed") {
        // Indeterminate: the maker's code read failed, so whether an ERC-1271 answer would
        // validate this signature is unknown — an RPC outage is not a signature verdict.
        return unavailable(chainId, "chain_read_failed", `the signature recovers to ${verdict.recoveredSigner}, not the order maker ${m.maker}, and the maker's code could not be read (the RPC call failed) — whether the maker is a contract account whose ERC-1271 answer would validate it is unknown; NOT finalized, retry with a working RPC`, ctx);
      }
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
      // Approval requirements re-derived from the SIGNED bytes: the Permit2 sourcing bit
      // and expiry from the signed makerTraits; for a JIT extension, the adapter/collateral
      // from the decoded extension and the predicted cST from its embedded permit. Advisory
      // only — deliberately OUTSIDE `artifact`, so the digest pins signed content alone.
      const finalizeTraits = decodeMakerTraits(finalized.order.makerTraits);
      const finalizeJit = decodeMakerExtensionContext((await resolveGenerations(chainId)).generations, finalized.extension).jit;
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
                ? "contract-maker signature verified via the ERC-1271 isValidSignature staticcall (the same check the fill performs), not created here; pass submitInput verbatim to cork_submit after your independent policy gate admits this artifact"
                : "signature verified and recovered, not created here; pass submitInput verbatim to cork_submit after your independent policy gate admits this artifact",
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
    // On a v/r/s permit row a CONTRACT maker (a Safe) cannot sign the ECDSA-only ERC-2612 permit a
    // JIT mint needs, so when its pool does not exist yet the completion path starts with
    // create-pool and the two allowances; on the bytes row (phoenix/v0.5) it may sign via ERC-1271. Decided from chain facts (pool existence from the share prediction, maker code
    // from getCode); silent when either is unknown.
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
      const valueGate = jitValueGate(chainId, ctx, swapFee, unwindFee, expiryTimestamp, nowSecs, { feeRule: await resolveFeeRule(chainId, "adapter", ctx) });
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
        const { recipe, rateOverride, extraData: recipeBytes, oracleSalt, constraint, wire, permitWire, phoenixWire } = ladder;
        const codec = wireCodec(wire);
        warnings.push(...ladder.warnings);
        jitData = { adapter: ladder.adapter, hook: "preInteraction (maker-side)", recipe, enableJitMint: jm.enableJitMint, wire, permitWire, ...(ladder.generation ? { generation: ladder.generation.label } : {}) };

        if (ladder.verified) {
          const { client, boundController, source, oracle, derived } = ladder.verified;
          jitData = { ...jitData, source, oracle: { address: oracle.address, deployed: oracle.deployed, ...(oracle.deployed ? oracleRateEcho(oracle) : {}) }, derivedPoolId: derived.poolId, constraint, identity: "PINNED at signing: the constraint is carried in the order, so this pool id and the predicted share addresses hold however far the rate moves (2.1.0)" };
          // A fixed rate never moves: its constraint cannot go stale, so there is nothing to notice.
          if (source !== "fixed") warnings.push({ code: "constraint_window_notice", message: "staleness is now guarded by recipe.verify at fill time, not a moving pool id: if the live rate walks outside the carried constraint's window, fills revert RecipeRejectedConstraint until you re-resolve and sign a fresh order" });

          try {
            // Predicted cST: direct read when the pool exists; otherwise the state-override
            // simulation (role granted in-memory — works before AND after the governance grant).
            // When the oracle is not deployed, the simulation prepends the SAME permissionless
            // deploy the fill performs, so the pool actually creates in-memory.
            const { dep: jitDep } = await getDep(ctx, chainId, { ...(ladder.generation ? { generation: ladder.generation.label } : {}) });
            const preCalls: Array<{ to: `0x${string}`; data: `0x${string}` }> = [];
            if (!oracle.deployed) {
              preCalls.push({ to: ladder.registry, data: source === "fixed" ? buildDeployFixedRateOracleCall(rateOverride) : codec.deployCall(jm.collateralAsset, jm.referenceAsset, oracle.mode ?? "price", oracleSalt) });
            }
            // A generation with a registry block but no phoenix block has no pool manager to
            // create on — a refusal naming the set, never bytes with a skipped prediction
            // (2026-09-22; the ladder's phoenix-wire gate already refused, this is the second
            // tripwire on the same fact).
            if (jitDep?.poolManager === undefined) {
              return unavailable(chainId, "unknown_deployment", `generation '${ladder.generation?.label ?? "?"}' declares no phoenix block; the pool id width is unknown and no pool manager exists to predict the cST on — refresh cork-defaults.v2.json`, ctx);
            } else {
              // The simulation runs AS the wire's role holder (adapter on flat, creator on nested).
              const pred = await predictShares(client, {
                adapter: codec.roleHolder === "creator" ? ladder.marketCreator! : ladder.adapter,
                controller: boundController,
                poolManager: jitDep.poolManager,
                market: derived.market,
                poolId: derived.poolId,
                wire: phoenixWire,
                unwindSwapFeePercentage: unwindFee,
                swapFeePercentage: swapFee,
                preCalls,
                chainId,
              });
              const cst = pred.cst;
              if (!pred.exists && pred.status !== "unavailable") {
                try {
                  const code = typeof (client as { getCode?: unknown }).getCode === "function" ? await (client as { getCode: (a: { address: `0x${string}` }) => Promise<`0x${string}` | undefined> }).getCode({ address: input.account }) : undefined;
                  // On the bytes permit row (phoenix/v0.5) a contract maker signs the permit through
                  // ERC-1271, so one that already carries a permit over the cST rests as is.
                  const permitCoversCst = cst !== undefined && cst !== null && (jm.permits ?? []).some((p) => p.token.toLowerCase() === cst.toLowerCase());
                  if (code !== undefined && code !== "0x" && !(permitWire === "bytes" && permitCoversCst)) {
                    contractMakerPreRest = true;
                    const allowances = `the cST → LOP allowance${jm.enableJitMint ? " and the collateral → JIT adapter allowance" : ""}`;
                    warnings.push({
                      code: "contract_maker_pre_rest",
                      message: permitWire === "bytes"
                        ? `the maker ${input.account} is a CONTRACT account and the derived pool does not exist yet. Two paths: (1) sign the ERC-2612 permit over the predicted cST through the wallet's ERC-1271 (this set's JIT adapter takes signature bytes) and re-prepare with it in jitMarket.permits; or (2) create the pool first (cork_prepare_market create-pool with this order's jitMarket legs) and place ${allowances} from the account BEFORE the order rests — data.execution.then lists path (2) in order`
                        : `the maker ${input.account} is a CONTRACT account and the derived pool does not exist yet: this set's JIT adapter takes only an ECDSA permit (v/r/s), so create the pool first (cork_prepare_market create-pool with this order's jitMarket legs) and place ${allowances} from the account BEFORE the order rests — data.execution.then lists the steps in order`,
                    });
                  }
                } catch {
                  // unreadable code → nothing to say (the fill's ERC-1271 check decides later)
                }
              }
              if (pred.status === "unavailable") {
                warnings.push({ code: "share_prediction_unavailable", message: `could not predict the new pool's cST address — ${pred.reason ?? "no reason recorded"}. VERIFY yourself that one order side is the derived pool's cST, or the fill reverts OrderNotForPool; a REVERT named here is the revert the fill's creation leg would hit` });
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
        const permits = parsePermitWires(jm.permits, permitWire);
        const jitParams: JITMarketParams = { collateralAsset: jm.collateralAsset, referenceAsset: jm.referenceAsset, expiryTimestamp, recipe, rateOverride, constraint, extraData: recipeBytes, oracleSalt, swapFeePercentage: swapFee, unwindSwapFeePercentage: unwindFee, enableJitMint: jm.enableJitMint };
        const extraData = codec.encodeExtraData(jitParams, permits, permitWire);
        if (ladder.verified) {
          // Decode round-trip: the deployed adapter's own decoder is the layout oracle for the
          // bytes this build produced. A disagreement is the bytes-decoder failure class — refused.
          const layout = await verifyExtraDataLayout({ client: ladder.verified.client, adapter: ladder.adapter, wire, permitWire, extraData, params: jitParams, permits, chainId, ctx, artifact: "order" });
          if ("gate" in layout) return layout.gate;
          jitData = { ...jitData, extraDataLayout: layout.status };
        }
        extension = buildJitExtension(ladder.adapter, extraData);
      }
    }

    // ── optional Cork-native decaying-premium auction: the deployed Fusion
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
      // The fusion echo is derived from the BUILT BYTES, not the input struct: decode the
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
        ? { adapter: jitData.adapter, collateralAsset: action.jitMarket.collateralAsset, enableJitMint: action.jitMarket.enableJitMint ?? false, ...("permitWire" in jitData && jitData.permitWire ? { permitWire: jitData.permitWire } : {}), ...("predictedCorkSwapToken" in jitData && jitData.predictedCorkSwapToken ? { predictedCorkSwapToken: jitData.predictedCorkSwapToken } : {}) }
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
    // What a cancel retires is decided by the SIGNED traits, not the hash: on the bit
    // invalidator, cancelOrder spends the (maker, nonce) bit, so every order by this maker that
    // carries the same nonce — a one-cancels-the-other group — is retired by this one transaction.
    // On the remaining-amount invalidator only this order hash is retired.
    const plan = lopInvalidatorPlan(traits);
    if (action.scope === "slot") return handleCancelSlotSweep({ ctx, chainId, account: input.account, action, lop, traits, plan });
    const cancel = buildCancelOrder(traits, action.orderHash);
    const retires = plan.mode === "bit"
      ? { invalidator: "bit" as const, nonce: plan.nonceOrEpoch.toString(), scope: `every order by ${input.account} whose makerTraits carry nonce ${plan.nonceOrEpoch} — a shared-nonce (ocoGroup) ladder is retired as one` }
      : { invalidator: "remaining" as const, nonce: null, scope: "this order hash only (remaining-amount invalidator)" };
    return envelope({ state: "ok", data: { kind: "cancel", scope: "order", to: lop, calldata: cancel.data, orderHash: action.orderHash, retires, execution: executionEthTransaction() }, chainId, source: "config", ctx });
  }

  if (action.type === "rollover-intent") {
    // A cited rollover RFQ quote supplies every term the caller leaves out, and every term is
    // then held to the venue's quote rules (rolloverQuoteRefMismatch) once the order is built.
    let quote: { rfq: Record<string, unknown>; option: Record<string, unknown> } | undefined;
    let act: RolloverIntentTerms;
    {
      const filled: Partial<RolloverIntentTerms> = {};
      if (action.quoteRef) {
        const read = await readRolloverQuote(ctx, chainId, action.quoteRef);
        if (!read.ok) return read.envelope;
        quote = { rfq: read.rfq, option: read.option };
        if (typeof read.rfq.requester !== "string" || !isAddressEqual(read.rfq.requester as `0x${string}`, input.account)) {
          return unavailable(chainId, "invalid_order_terms", `only the RFQ's requester can accept its quote: RFQ '${action.quoteRef.rfqId}' was opened by ${String(read.rfq.requester)}, not account ${input.account} (the order's user — the venue would 400: order user is not the requester)`, ctx);
        }
        const d = rolloverQuoteDefaults(read.rfq, read.option);
        if (action.srcPoolId === undefined) filled.srcPoolId = d.srcPoolId;
        if (action.premiumToken === undefined) filled.premiumToken = d.premiumToken;
        if (action.minPremiumPerShare === undefined) filled.minPremiumPerShare = d.minPremiumPerShare;
        if (action.orderSize === undefined) filled.orderSize = d.orderSize;
        if (d.dstPoolId !== undefined && action.dstPoolId === undefined) filled.dstPoolId = d.dstPoolId;
        if (d.jitMarket !== undefined && action.jitMarket === undefined && action.jitMarketHash === undefined) {
          filled.jitMarket = d.jitMarket as unknown as NonNullable<RolloverIntentTerms["jitMarket"]>;
        }
        if (d.jitMarket !== undefined && action.dstPoolId === undefined) {
          // The quote names a market, not a pool id: the pool the market derives to is the one
          // BaseFiller checks the order against (BaseFiller__JitPoolMismatch otherwise).
          const derived = await deriveJitDestination(ctx, chainId, (read.option.destination as { jit_market: Record<string, unknown> }).jit_market);
          if ("reason" in derived) {
            return unavailable(chainId, "invalid_order_terms", `the quoted destination is a just-in-time market and the pool it derives to could not be computed here (${derived.reason}) — pass dstPoolId yourself (cork_query derive-cork-pool with the quoted jit_market fields reports it)`, ctx);
          }
          filled.dstPoolId = derived.poolId;
        }
      }
      const merged = { ...action, ...filled };
      const missing = (["srcPoolId", "dstPoolId", "premiumToken", "orderSize", "minPremiumPerShare"] as const).filter((k) => merged[k] === undefined);
      if (missing.length > 0) {
        throw new ToolInputError("cork_prepare_orders", missing.map((k) => ({ path: ["action", k], message: `${k} is required unless quoteRef names a rollover RFQ quote that supplies it` })));
      }
      act = merged as RolloverIntentTerms;
    }
    const { rollover, warning: rolloverWarn } = await resolveRollover(chainId);
    if (!rollover) {
    // The partner named is the SAME generation's other settler: each factory approves only its
    // own settlers, so the primary's partner would be unfillable from another active generation.
      return unavailable(chainId, "unknown_deployment", `no rollover deployment configured for chainId ${chainId} (rollover is live on Arbitrum One and Base — 42161, 8453)`, ctx);
    }
    const warnings: Array<{ code: string; message: string }> = rolloverWarn ? [rolloverWarn] : [];

    // Settler-kind pre-flight: the mode gate is enforced ON-CHAIN (ExactSettler reverts
    // Settler__PartialFillsNotSupported on allowPartialFills:true and PartialSettler reverts
    // Settler__ExactFillsNotSupported on false), so a mismatched order is signable but unfillable.
    const cls = classifyRolloverSettler(rollover, act.settler);
    if (cls.status === "retired") {
      return unavailable(chainId, "settler_retired", retiredSettlerTeaching(act.settler, cls, rollover), ctx);
    }
    if (cls.status === "active" && cls.kind === "EXACT" && act.allowPartialFills) {
      return unavailable(chainId, "settler_mode_mismatch", `settler ${act.settler} is the ExactSettler of the ${cls.generation.label} generation, which rejects allowPartialFills:true on-chain — use that generation's PartialSettler ${cls.generation.partialSettler} or set allowPartialFills:false`, ctx);
    }
    if (cls.status === "active" && cls.kind === "PARTIAL" && !act.allowPartialFills) {
      return unavailable(chainId, "settler_mode_mismatch", `settler ${act.settler} is the PartialSettler of the ${cls.generation.label} generation, which rejects allowPartialFills:false on-chain — use that generation's ExactSettler ${cls.generation.exactSettler} or set allowPartialFills:true`, ctx);
    }
    if (cls.status === "unknown") {
      // A JIT commitment is hashed on the SETTLER generation's wire (each factory admits only its
      // own settlers, so the BaseFiller that reproduces the hash is that generation's). An
      // address no generation vouches for has no wire — and with two live wires (rc.2 and 0.2)
      // a guess is a coin toss on SIGNED bytes: the pre-0.6 fallback took the primary's 0.2
      // typehash, so an rc.2-shaped partner filler could never reproduce the commitment
      // (BaseFiller__JitMarketHashMismatch at best). Refused since 2026-09-22;
      // a plain order (no commitment) keeps the warn-and-build path — the venue's admission
      // decides, and nothing wire-shaped is signed.
      if (act.jitMarket !== undefined || (act.jitMarketHash !== undefined && act.jitMarketHash !== ZERO_JIT_MARKET_HASH)) {
        return unavailable(chainId, "invalid_order_terms", `settler ${act.settler} belongs to no configured rollover generation on chainId ${chainId}, and this order carries a JIT market commitment (${act.jitMarket !== undefined ? "jitMarket" : "a non-zero jitMarketHash"}) — the commitment's JITMarketParams typehash is the SETTLER generation's wire (rc.2 or 0.2), so an unvouched settler cannot be hashed for; bind the order to a configured settler (${activeSettlersTeaching(rollover, "EXACT")}; ${activeSettlersTeaching(rollover, "PARTIAL")}) or drop the commitment`, ctx);
      }
      warnings.push({ code: "settler_not_recognized", message: `settler ${act.settler} is not a configured Cork settler for chainId ${chainId} (active: ${activeSettlersTeaching(rollover, "EXACT")}; ${activeSettlersTeaching(rollover, "PARTIAL")}) — the venue only admits factory-approved settlers` });
    }
    // The JIT commitment is hashed on the SETTLER generation's wire, never the chain primary's:
    // the order is filled by the BaseFiller of the factory that approved this settler (each
    // factory admits only its own), so an rc.2 settler takes the rc.2 layout while the primary
    // set speaks 0.2. No fallback: an unrecognized settler was refused above whenever a
    // commitment rides along, and a plain order hashes nothing.
    const settlerGeneration = cls.status === "active" ? cls.generation : undefined;
    const jitWire = settlerGeneration?.wire;

    // Optional JIT market commitment: hash the negotiated instruction locally, or take a
    // pre-computed hash verbatim; never both (two sources of the same commitment can disagree).
    if (act.jitMarket && act.jitMarketHash) {
      return unavailable(chainId, "invalid_order_terms", "jitMarket and jitMarketHash are mutually exclusive — pass the instruction to hash locally, or the pre-computed commitment, not both", ctx);
    }
    let jitMarketHash: `0x${string}` | undefined = act.jitMarketHash;
    if (act.jitMarket) {
      const jm = act.jitMarket;
      if (jitWire === undefined || jitWire === "rc.1") {
        return unavailable(chainId, "invalid_order_terms", `a jitMarket instruction cannot be committed for settler ${act.settler}: ${jitWire === "rc.1" ? "its generation predates jitMarketHash (rc.1)" : "no live rollover generation on this chain speaks a JIT commitment wire"} — bind the order to an active settler (${activeSettlersTeaching(rollover, "EXACT")}; ${activeSettlersTeaching(rollover, "PARTIAL")})`, ctx);
      }
      // The recipe bytes + salt, resolved by the ONE alias rule every JIT input shares
      // (handlers/jit.ts resolveJitBytesInput, since 2026-09-22 — there were three
      // behaviours across the registry, create-pool and rollover blocks): `extraData` is the
      // input name, `additionalData` the deprecated alias (info deprecation_notice), both present
      // and different is two payloads and refuses as invalid input; an explicit "0x" counts as
      // present. The struct/typed-data OUTPUT keeps the BaseFiller's own member name,
      // `additionalData` (`bytesField`). The salt gate is NOT applied here: hashJitMarketParams
      // refuses a non-zero salt on rc.2 itself, as the caller's order terms.
      const { extraData: additionalData, oracleSalt: resolvedSalt, saltGiven } = resolveJitBytesInput(jm, undefined, settlerGeneration?.label, { tool: "cork_prepare_orders", path: ["action", "jitMarket"], bytesField: "additionalData" }, warnings);
      // oracleSalt exists only on the 0.2 wire: defaulted to the ZERO salt there (the nested
      // registry's deploy(ca, ref, mode, salt) with the zero salt is the pair's default oracle —
      // market-registry's ZERO_ORACLE_SALT), refused non-zero on rc.2 by the hash function itself.
      const oracleSalt: `0x${string}` | undefined = saltGiven ? resolvedSalt : jitWire === "0.2" ? zeroHash : undefined;
      // Same value-domain gate the LOP JIT builders run (fee rule + future expiry, one place so
      // the boundary rules cannot drift), plus the rollover-specific window rule. The fee rule
      // is the SETTLER generation's (its pool manager creates the destination pool): 5e18 on an
      // 8-field set, strictly below 100e18 on a 10-field one — never the chain primary's.
      const settlerCtx: HandlerContext = settlerGeneration !== undefined ? { ...ctx, generation: settlerGeneration.label } : ctx;
      // The pool id width is the pool manager's, read from the settler's chain generation (its
      // phoenix block) — declared, never inferred from the rollover wire (the pre-0.6
      // `phoenixWireOfRolloverWire` mapping did that, and a generation whose rollover block
      // outlived its phoenix block would have hashed the wrong width, 2026-09-22).
      // A generation with no phoenix block cannot create the destination pool at all — refused.
      const { generation: phoenixGeneration } = await getDep(ctx, chainId, { generation: settlerGeneration!.label });
      const phoenixWire = phoenixGeneration?.wire;
      if (phoenixWire === undefined) {
        return unavailable(chainId, "unknown_deployment", `generation '${settlerGeneration!.label}' (settler ${act.settler}) declares no phoenix block; the pool id width is unknown, so the jitMarket destination pool cannot be derived or committed — refresh cork-defaults.v2.json or bind the order to a settler whose generation carries a pool manager`, ctx);
      }
      const gate = jitValueGate(chainId, ctx, BigInt(jm.swapFeePercentage), BigInt(jm.unwindSwapFeePercentage), BigInt(jm.expiryTimestamp), nowSecondsOf(ctx), { feeRule: await resolveFeeRule(chainId, "adapter", settlerCtx) });
      if (gate) return gate;
      if (BigInt(jm.expiryTimestamp) <= BigInt(act.fillDeadline)) {
        return unavailable(chainId, "invalid_order_terms", `jitMarket.expiryTimestamp (${jm.expiryTimestamp}) must outlast the order's fillDeadline (${act.fillDeadline}) — a pool that expires inside the fill window cannot receive the rollover`, ctx);
      }
      const farFuture = farFutureExpiryWarning(BigInt(jm.expiryTimestamp), nowSecondsOf(ctx));
      if (farFuture) warnings.push(farFuture);
      // Best-effort pool-identity cross-check: the commitment PINS the carried constraint, and
      // constraint values are part of pool identity — a dstPoolId kept from an OLDER derivation
      // signs an order every fill reverts (BaseFiller__JitPoolMismatch). Same posture as the
      // LOP JIT ladder: runs whenever an RPC resolves; silent without one.
      try {
        const resolved = await getRpc(ctx, chainId);
        // The oracle the pool binds is the SETTLER generation's registry's: a cross-check
        // against another generation's registry derives a pool that BaseFiller never creates
        // and would warn about a mismatch that is ours, not the caller's. So the registry is
        // BOUND to the settler's set (its declared wire picks the codec — nested for a 0.2
        // settler, flat for rc.2), and the salt rides into the simulated oracle deploy.
        const { mr, generation: mrGeneration } = await getMarketRegistry(settlerCtx, chainId);
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
            ...(oracleSalt !== undefined ? { oracleSalt } : {}),
            wantConstraint: false,
          });
          if (!res.gate && res.oracle.address && settlerGeneration !== undefined && mrGeneration?.label === settlerGeneration.label) {
            // ONE derivation for one identity: deriveJitMarket on the phoenix wire
            // resolved above — 10-field hashes the two fees INTO the id, 8-field ignores them.
            const constraint = {
              rateMin: BigInt(jm.constraint.rateMin),
              rateMax: BigInt(jm.constraint.rateMax),
              rateChangePerDayMax: BigInt(jm.constraint.rateChangePerDayMax),
              rateChangeCapacityMax: BigInt(jm.constraint.rateChangeCapacityMax),
            };
            const derived = deriveJitMarket({ collateralAsset: jm.collateralAsset, referenceAsset: jm.referenceAsset, expiryTimestamp: BigInt(jm.expiryTimestamp), constraint, oracle: res.oracle.address, wire: phoenixWire, swapFeePercentage: BigInt(jm.swapFeePercentage), unwindSwapFeePercentage: BigInt(jm.unwindSwapFeePercentage) });
            if (derived.poolId.toLowerCase() !== act.dstPoolId.toLowerCase()) {
              warnings.push({ code: "jit_pool_mismatch", message: `dstPoolId ${act.dstPoolId} is NOT the pool this jitMarket instruction derives (${derived.poolId}, a ${phoenixWire} Market against oracle ${res.oracle.address}${res.oracle.deployed ? "" : " — predicted; the fill deploys it"}${phoenixWire === "10-field" ? "; the two fee percentages are part of the 10-field id" : ""}) — the fill WILL revert BaseFiller__JitPoolMismatch. Constraint values are part of pool identity: re-derive with cork_query derive-cork-pool and use ITS poolId (and predicted dst cST) before signing` });
            }
          }
        }
      } catch {
        /* best-effort leg: a transport failure must not block an offline-buildable artifact */
      }
      try {
        jitMarketHash = hashJitMarketParams(
          {
            collateralAsset: jm.collateralAsset,
            referenceAsset: jm.referenceAsset,
            expiryTimestamp: BigInt(jm.expiryTimestamp),
            recipe: jm.recipe,
            rateOverride: BigInt(jm.rateOverride),
            rateMin: BigInt(jm.constraint.rateMin),
            rateMax: BigInt(jm.constraint.rateMax),
            rateChangePerDayMax: BigInt(jm.constraint.rateChangePerDayMax),
            rateChangeCapacityMax: BigInt(jm.constraint.rateChangeCapacityMax),
            additionalData,
            ...(oracleSalt !== undefined ? { oracleSalt } : {}),
            swapFeePercentage: BigInt(jm.swapFeePercentage),
            unwindSwapFeePercentage: BigInt(jm.unwindSwapFeePercentage),
          },
          jitWire,
        );
      } catch (err) {
        // A wire/struct disagreement (a salt on rc.2) is the caller's terms, not a fault.
        if (err instanceof RolloverJitWireError) return unavailable(chainId, "invalid_order_terms", `${err.message} (settler ${act.settler} belongs to the ${settlerGeneration!.label} generation, rollover wire ${jitWire})`, ctx);
        throw err;
      }
    }

    if (jitMarketHash !== undefined && jitMarketHash !== ZERO_JIT_MARKET_HASH) {
      warnings.push({ code: "jit_market_notice", message: `this order commits to just-in-time DESTINATION-market creation (non-zero jitMarketHash, the ${jitWire ?? "settler generation's"} JITMarketParams layout${jitWire === "0.2" ? " — oracleSalt committed" : jitWire === "rc.2" ? " — no oracleSalt member" : ""}${act.jitMarketHash !== undefined ? "; a pre-computed hash must have been produced for THAT wire or the fill reverts BaseFiller__JitMarketHashMismatch" : ""}) — contract-valid (BaseFiller fillWithJitMarket), but the venue's admission (cork-api ≤0.3.16) requires the destination cST/pool to already be INDEXED and its expiry known, with no jitMarketHash bypass: cork_submit can relay this order only once the dst pool exists on-chain; until then hand the signed order to your filler venue-free` });
    }

    const openDeadline = BigInt(act.openDeadline);
    const fillDeadline = BigInt(act.fillDeadline);
    const orderSize = BigInt(act.orderSize);
    // The intent's hooks (2026-10-01): the clone runs them per phase, and a roll without the
    // pre-hook that pulls the holder's src cPT in and the post-hook that returns the dst cPT
    // cannot complete (nothing to burn; CorkRolloverContract__DstCptNotRestored). They are hashed
    // into rolloverIntentHash, so they ride the signed order or not at all.
    if (act.hooks !== undefined && act.standardHooks !== undefined) {
      return unavailable(chainId, "invalid_order_terms", "hooks and standardHooks are mutually exclusive — pass the two canonical modules through standardHooks, or compose every hook yourself through hooks", ctx);
    }
    let hooks: RolloverIntentArgs["hooks"];
    if (act.standardHooks !== undefined) {
      const mods = settlerGeneration?.modules;
      if (settlerGeneration === undefined || mods?.ownerTokenPull === undefined || mods.postRolloverDstCptTransfer === undefined) {
        return unavailable(chainId, "unknown_deployment", `the ${settlerGeneration?.label ?? "settler's"} rollover generation configures no hook modules on chainId ${chainId} (OwnerTokenPullModule / PostRolloverDstCptTransferModule) — pass the hooks explicitly through \`hooks\``, ctx);
      }
      // The pull module takes a FIXED amount (orderSize — the hooks are signed before any fill
      // size is known). On a partial-fill order the first fill pulls orderSize, the clone burns the
      // fill amount and sweeps the surplus back to the holder, and the NEXT fill pulls orderSize
      // again from a holder who now has less: the module must CLAMP to balance and allowance
      // (its allowUnderfill flag — independent of the ORDER's allowUnderfill, which the clone
      // checks against the fill context), and the holder's allowance to the clone must outlast
      // the first pull (each pull consumes min(balance, allowance) of allowance).
      const clampPull = act.allowUnderfill || act.allowPartialFills;
      hooks = standardRolloverHooks({ modules: { ownerTokenPull: mods.ownerTokenPull, postRolloverDstCptTransfer: mods.postRolloverDstCptTransfer }, srcCptToken: act.standardHooks.srcCptToken, dstCptToken: act.standardHooks.dstCptToken, orderSize, recipient: input.account, allowUnderfill: clampPull });
      const allowanceTeaching = act.allowPartialFills
        ? `approve the CLONE for the ORDER SIZE and keep that allowance standing across fills (an unlimited allowance, or re-approve after each partial fill): every fill's pre-hook pulls min(your balance, your allowance, ${orderSize}) and the clone sweeps the unburned surplus back to you, so a one-time allowance of exactly ${orderSize} is spent by the FIRST fill and the next one reverts OwnerTokenPullModule__NothingPullable`
        : `approve the CLONE for that amount before the order is filled (a direct ERC-20 approve from your account)`;
      warnings.push({ code: "owner_managed_funding", message: `the pre-hook pulls ${orderSize} of src cPT ${act.standardHooks.srcCptToken} from ${input.account} into the clone ${act.rolloverContract} at fill time — ${allowanceTeaching}; the post-hook returns the minted dst cPT ${act.standardHooks.dstCptToken} to you` });
    } else if (act.hooks !== undefined) {
      const toCall = (h: { target: `0x${string}`; value: string; callData: `0x${string}`; allowFailure: boolean; isDelegateCall: boolean }): RolloverCall => ({ target: h.target, value: BigInt(h.value), callData: h.callData, allowFailure: h.allowFailure, isDelegateCall: h.isDelegateCall });
      hooks = {
        ...(act.hooks.preRolloverHooks ? { preRolloverHooks: act.hooks.preRolloverHooks.map(toCall) } : {}),
        ...(act.hooks.midRolloverHooks ? { midRolloverHooks: act.hooks.midRolloverHooks.map(toCall) } : {}),
        ...(act.hooks.postRolloverHooks ? { postRolloverHooks: act.hooks.postRolloverHooks.map(toCall) } : {}),
        ...(act.hooks.premiumHooks ? { premiumHooks: act.hooks.premiumHooks.map(toCall) } : {}),
      };
    } else {
      warnings.push({ code: "invalid_order_terms", message: "this order carries NO intent hooks: the clone will have no src cPT to burn and nowhere to send the dst cPT, so no filler can complete it — pass standardHooks (srcCptToken + dstCptToken) unless you compose hooks yourself" });
    }
    const allHooks = [...(hooks?.preRolloverHooks ?? []), ...(hooks?.midRolloverHooks ?? []), ...(hooks?.postRolloverHooks ?? []), ...(hooks?.premiumHooks ?? [])];

    // The two slippage floors are SIGNED, and a floor left out is signed as ZERO: the src-side
    // unwind may then return any collateral and the dst mint any number of share pairs. A holder
    // may mean it on a pool it knows, so nothing refuses — but it is never silent (2026-10-02).
    const unfloored = [...(act.minCaReceived === undefined ? ["minCaReceived (the collateral the src-side unwind returns)"] : []), ...(act.minSharesOut === undefined ? ["minSharesOut (the dst share pairs minted)"] : [])];
    if (unfloored.length > 0) {
      warnings.push({ code: "invalid_order_terms", message: `no slippage floor: ${unfloored.join(" and ")} ${unfloored.length > 1 ? "are" : "is"} not set and will be SIGNED as 0, so a filler may complete this roll at whatever rate the two pools give at fill time — pass the floor${unfloored.length > 1 ? "s" : ""} you would accept. Phoenix unwinds and deposits at exactly 1:1: a fill of F src cST returns F / 10^(18 − collateral decimals) collateral and, on the same collateral, mints F dst shares. The clone checks both floors on EACH fill${act.allowPartialFills ? ", so on this partial-fill order set them for the smallest fill you accept" : ""}` });
    }

    // Deterministic venue-admission battery, shared with submit (the two surfaces must
    // refuse the same orders). The builder pins intent.deadline = fillDeadline; the hooks it
    // carries are checked by the same shape rule the submit side runs.
    const violation = checkRolloverOrderTerms({
      ...(allHooks.length > 0 ? { hooks: allHooks } : {}),
      nowSeconds: nowSecondsOf(ctx),
      openDeadline,
      fillDeadline,
      orderSize,
      minPremiumPerShare: BigInt(act.minPremiumPerShare),
      srcCstToken: act.srcCstToken,
      dstCstToken: act.dstCstToken,
      premiumToken: act.premiumToken,
      srcPoolId: act.srcPoolId,
      dstPoolId: act.dstPoolId,
      settler: act.settler,
      ...(act.exclusiveFiller !== undefined ? { exclusiveFiller: act.exclusiveFiller } : {}),
    });
    if (violation) return unavailable(chainId, "invalid_order_terms", `${violation} — the venue would reject the signed order with the same complaint`, ctx);

    // The settler's open-time rules that need the chain (rollover-ranges.ts): both pools on the
    // SETTLER's own pool manager, orderSize a multiple of the source share quantum, and the fill
    // deadline strictly before both pools' expiry. A definitive answer refuses — an order that can
    // never open is not worth signing; a read that fails is disclosed and the order builds.
    const isJit = act.jitMarket !== undefined || (jitMarketHash !== undefined && jitMarketHash !== ZERO_JIT_MARKET_HASH);
    let poolFacts: RollPoolFacts | null = null;
    if (cls.status === "active") {
      const resolved = await getRpc(ctx, chainId);
      if (resolved) {
        try {
          poolFacts = await readRollPools(resolved.client, { chainId, settler: act.settler, srcPoolId: act.srcPoolId, dstPoolId: act.dstPoolId, ...(ctx.atBlock !== undefined ? { atBlock: ctx.atBlock } : {}) });
        } catch (err) {
          warnings.push({ code: "chain_read_failed", message: `the settler's pool facts could not be read (${revertReason(err)}) — that both pools live on its pool manager, the order size's quantum and the deadline against the pool expiries are unchecked` });
        }
      }
      if (poolFacts !== null) {
        const broken = openRangeViolation(poolFacts, { srcCstToken: act.srcCstToken, dstCstToken: act.dstCstToken, orderSize, fillDeadline, ...(isJit ? { jit: { expiry: act.jitMarket !== undefined ? BigInt(act.jitMarket.expiryTimestamp) : null } } : {}) });
        if (broken) return unavailable(chainId, "invalid_order_terms", `${broken.message} — settler ${act.settler} reverts ${broken.settlerError} when the order opens, so it can never fill`, ctx);
      }
    }
    // The floors the holder signs are checked on EACH fill: on a partial-fill order a floor set
    // for the whole order makes every smaller fill revert.
    const minFill = poolFacts !== null ? sameCollateralMinFill(poolFacts, { minCaReceived: BigInt(act.minCaReceived ?? "0"), minSharesOut: BigInt(act.minSharesOut ?? "0") }) : null;
    if (act.allowPartialFills && minFill !== null && poolFacts?.src.quantum != null && minFill > poolFacts.src.quantum) {
      warnings.push({ code: "invalid_order_terms", message: `your floors apply to EACH fill: a fill below ${minFill} src cST returns less than minCaReceived or mints less than minSharesOut, and the clone reverts it (CorkRolloverContract__UnwindMintShortfall / UnwindDepositShortfall). On a partial-fill order, set the floors for the smallest fill you accept${minFill > orderSize ? ` — at ${minFill} no fill of this ${orderSize} order can clear them` : ""}` });
    }

    // The accepted quote, held to the venue's rule with the order's final terms: an explicit term
    // that breaks it (a lower premium, a bigger size, another destination) is refused here.
    if (quote !== undefined) {
      const mismatch = rolloverQuoteRefMismatch(quote.rfq, quote.option, {
        user: input.account,
        premiumToken: act.premiumToken,
        orderSize,
        minPremiumPerShare: BigInt(act.minPremiumPerShare),
        srcPoolId: act.srcPoolId,
        dstPoolId: act.dstPoolId,
        jitMarketHash: jitMarketHash ?? ZERO_JIT_MARKET_HASH,
      });
      if (mismatch) {
        const wireNote = jitWire !== "0.2" && (quote.option.destination as Record<string, unknown> | undefined)?.jit_market !== undefined ? ` — the venue hashes a quoted market on the 0.2 JITMarketParams layout, and settler ${act.settler} speaks ${jitWire ?? "no JIT wire"}: bind the order to a 0.2 settler` : "";
        return unavailable(chainId, "invalid_order_terms", `this order does not match the quote it cites: ${mismatch}${wireNote}. The venue would refuse it (400 Invalid quoteRef) — leave the term out to take it from the quote`, ctx);
      }
    }

    const built = buildRolloverIntent({
      chainId,
      user: input.account,
      settler: act.settler,
      rolloverContract: act.rolloverContract,
      srcCstToken: act.srcCstToken,
      dstCstToken: act.dstCstToken,
      premiumToken: act.premiumToken,
      srcPoolId: act.srcPoolId,
      dstPoolId: act.dstPoolId,
      orderSize,
      minPremiumPerShare: BigInt(act.minPremiumPerShare),
      openDeadline,
      fillDeadline,
      ...(act.minCaReceived !== undefined ? { minCaReceived: BigInt(act.minCaReceived) } : {}),
      ...(act.minSharesOut !== undefined ? { minSharesOut: BigInt(act.minSharesOut) } : {}),
      ...(jitMarketHash !== undefined ? { jitMarketHash } : {}),
      allowPartialFills: act.allowPartialFills,
      allowUnderfill: act.allowUnderfill,
      ...(act.premiumPaymentMode !== undefined ? { premiumPaymentMode: act.premiumPaymentMode } : {}),
      ...(act.fillerHint !== undefined ? { fillerHint: act.fillerHint } : {}),
      ...(act.exclusiveFiller !== undefined ? { exclusiveFiller: act.exclusiveFiller } : {}),
      ...(act.orderSalt !== undefined ? { orderSalt: BigInt(act.orderSalt) } : {}),
      ...(act.nonce !== undefined ? { nonce: BigInt(act.nonce) } : {}),
      ...(hooks !== undefined ? { hooks } : {}),
      clientRequestId: input.clientRequestId,
    });
    return envelope({
      state: "ok",
      data: {
        kind: "rollover-intent",
        ...(quote !== undefined
          ? {
              quoteRef: act.quoteRef,
              acceptedQuote: {
                premiumToken: quote.option.premium_token,
                premiumPerShare: quote.option.premium_per_share,
                sharesMax: quote.option.shares_max,
                destination: quote.option.destination,
                ...(quote.option.jit_market_hash !== undefined ? { jitMarketHash: quote.option.jit_market_hash } : {}),
                scales: { premiumPerShare: "raw premium-token base units per 1e18 destination shares (the order's minPremiumPerShare)", sharesMax: "cPT shares, 18 decimals", unitsTopic: UNITS_TOPIC_REFERENCE },
              },
            }
          : {}),
        intentHooks: { pre: built.intent.preRolloverHooks.length, mid: built.intent.midRolloverHooks.length, post: built.intent.postRolloverHooks.length, premiumPhase: built.intent.premiumHooks.length, ...(act.standardHooks !== undefined ? { standard: true, modules: settlerGeneration!.modules } : {}) },
        settler: act.settler,
        ...(cls.status === "active" ? { settlerKind: cls.kind, settlerGeneration: cls.generation.label } : {}),
        /** The JITMarketParams layout `rolloverParams.jitMarketHash` is (or must be) computed on — the settler generation's rollover wire. */
        ...(jitWire !== undefined ? { jitMarketWire: jitWire } : {}),
        // The ranges the settler enforces on this order and its fills, from the settler's own pool
        // manager; null when no RPC resolved or the reads failed (rollover-ranges.ts).
        ranges:
          poolFacts === null
            ? null
            : {
                poolManager: poolFacts.poolManager,
                quantum: poolFacts.src.quantum?.toString() ?? null,
                fillDeadlineBefore: [poolFacts.src.expiry, poolFacts.dst?.expiry ?? (act.jitMarket !== undefined ? BigInt(act.jitMarket.expiryTimestamp) : null)].filter((e): e is bigint => e !== null).reduce<bigint | null>((m, e) => (m === null || e < m ? e : m), null)?.toString() ?? null,
                fill: fillRange({ kind: cls.status === "active" && cls.kind === "PARTIAL" ? "partial" : act.allowUnderfill ? "exact-underfill" : "exact", orderSize, consumed: 0n, quantum: poolFacts.src.quantum, minClearingHolderFloors: minFill }),
                scales: { quantum: "src cST shares, 18 decimals", fillDeadlineBefore: "unix seconds", fill: "src cST shares, 18 decimals", unitsTopic: UNITS_TOPIC_REFERENCE },
              },
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
    // The verification bar is the venue path's and stricter: local re-hash against the
    // claimed orderHash, the salt↔extension binding OrderLib enforces at fill, and the maker
    // signature verified the way the fill verifies it (ecrecover / the ERC-1271 staticcall);
    // the shared tail then runs the same on-chain liveness pre-flight.
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
      // A zero makingAmount here is a CALLER-supplied order — attribution differs from the
      // venue path, where the same defect is a malformed service row.
      if (order.makingAmount === 0n) {
        return unavailable(chainId, "invalid_order_terms", "the supplied signed order has makingAmount 0 — nothing is fillable", ctx);
      }
      const auth = await authenticateSignedOrder({ ctx, chainId, order, orderHash: localOrderHash, signature: so.signature, extension: so.extension, consequence: "no fill bytes were built", echo: { acquisition: "inline" } });
      if (!auth.ok) return auth.envelope;
      const signed: SignedLopOrder = { order, signature: so.signature, extension: so.extension, makerAccountType: auth.makerAccountType };
      return await buildTakerFillArtifact({ ctx, chainId, account: input.account, clientRequestId: input.clientRequestId, action, lop, signed, localOrderHash, acquisitionWarnings: auth.warnings, artifactSource: auth.source });
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
      // Re-hash the venue's order locally; a row that does not hash to the requested order
      // (or disagrees with the venue's own claimed hash) yields NO fill bytes.
      const localOrderHash = hashLopOrder(chainId, lop, signed.order);
      if (localOrderHash.toLowerCase() !== wanted || (signed.venueOrderHash !== undefined && signed.venueOrderHash.toLowerCase() !== localOrderHash.toLowerCase())) {
        return envelope({
          state: "conflict",
          data: { requestedOrderHash: action.orderHash, localOrderHash, venueOrderHash: signed.venueOrderHash ?? null },
          chainId,
          source: "service",
          warnings: [{ code: "order_hash_mismatch", message: "the venue row does not hash to the requested order — no fill bytes were built" }],
          ctx,
        });
      }
      // A zero makingAmount is a malformed VENUE row (nothing fillable), not a caller mistake —
      // attribute it correctly instead of surfacing a divisor error as invalid_order_terms.
      if (signed.order.makingAmount === 0n) {
        return unavailable(chainId, "invalid_service_response", `venue returned a resting order with makingAmount 0 for ${action.orderHash} — a malformed row; no fill bytes were built`, ctx);
      }
      // The venue's row is DISCOVERY, not authority: the extension rule and the maker
      // signature are checked exactly as the inline path checks bytes in hand — a row the venue
      // serves with a signature its maker never made, or bytes its salt never committed to,
      // yields no fill (the fill would only revert) and the venue's `makerAccountType` claim is
      // replaced by the verdict's.
      const auth = await authenticateSignedOrder({ ctx, chainId, order: signed.order, orderHash: localOrderHash, signature: signed.signature, extension: signed.extension, consequence: "no fill bytes were built", echo: { requestedOrderHash: action.orderHash, acquisition: "venue" } });
      if (!auth.ok) return auth.envelope;
      const authenticated: SignedLopOrder = { ...signed, makerAccountType: auth.makerAccountType };
      // The venue's in-band notices ride the book pages this search read (e.g. the premium
      // deprecation) — the fill path is exactly who they are for.
      // The cover this fill BUYS against the cover the cited RFQ asked for (cork-cli#6): read from
      // the order's own JIT block, never from the option's label. Venue path only — an inline
      // signedOrder carries no citation. Build-and-warn: the requester decides with the facts.
      const quoteCover = await requesterCoverReading({ ctx, chainId, row, extension: authenticated.extension, account: input.account });
      return await buildTakerFillArtifact({ ctx, chainId, account: input.account, clientRequestId: input.clientRequestId, action, lop, signed: authenticated, localOrderHash, acquisitionWarnings: [...venueNoticeWarnings(book), ...auth.warnings, ...(quoteCover?.warnings ?? [])], artifactSource: "service", ...(quoteCover ? { quoteCover: quoteCover.cover } : {}) });
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
/** The venue rests at most VENUE_OPEN_ORDERS_PER_POOL open orders of one maker on one asset pair,
 *  and every rung of a ladder is one such order WHATEVER bit it shares (the venue never learns a
 *  group): a ladder beyond the cap signs rungs the venue refuses — exposure that never rests. */
function openOrderCapNotice(rungCount: number): { code: string; message: string } {
  return {
    code: "invalid_order_terms",
    message: `${rungCount} rungs on one pool exceed the venue's cap of ${VENUE_OPEN_ORDERS_PER_POOL} open orders per maker per asset pair: the venue refuses every order past the ${VENUE_OPEN_ORDERS_PER_POOL}th it rests for you there (HTTP 400, "maximum limit of ${VENUE_OPEN_ORDERS_PER_POOL} open orders per pool"), and orders already resting on the pair count too — post at most ${VENUE_OPEN_ORDERS_PER_POOL} rungs per pair, or cancel resting orders first; a shared bit does not reduce the count`,
  };
}

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
  if (rungs.length > VENUE_OPEN_ORDERS_PER_POOL) warnings.push(openOrderCapNotice(rungs.length));
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

/** The notice for a fill of an order whose signed expiry has passed. `expiry` 0 = no expiry. */
export function orderExpiredWarning(expiry: bigint, nowSecs: bigint): { code: string; message: string } | undefined {
  if (expiry === 0n || expiry >= nowSecs) return undefined;
  return { code: "would_revert", message: `the order EXPIRED at ${expiry} (now ${nowSecs} by this host's clock): its signed makerTraits carry that expiry, and the LOP reverts OrderExpired() for every fill after it. The maker must sign a fresh order (refresh-order re-rests the same terms). The bytes are built, and a fill of them reverts` };
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
  /** The requester-side cover reading of a cited venue row (cover-mode.ts); absent off the venue path or for an uncited row. */
  quoteCover?: Record<string, unknown> | undefined;
}): Promise<Envelope> {
  const { ctx, chainId, account, clientRequestId, action, lop, signed, localOrderHash } = a;
  // Exclusivity pre-flight, chain-free from the signed bytes: a reserved order admits ONE
  // filler — the LOP compares the LOW 80 BITS of msg.sender to the suffix the maker signed and
  // reverts PrivateOrder() otherwise. The sender is whoever CALLS the LOP: the account on the
  // raw path, the ForSelf ADAPTER on the wrapper path (the wrapper is the LOP's caller, the
  // account only calls the wrapper). Bytes that can only revert are not built; the message
  // names the reserved suffix so a taker who controls that sender can re-prepare with it.
  const signedTraits = decodeMakerTraits(signed.order.makerTraits);
  const allowedSender = signedTraits.allowedSender;
  // Expiry, chain-free from the same signed bytes: the LOP reverts OrderExpired() once
  // block.timestamp passes the signed expiry (MakerTraitsLib.isExpired: expiry != 0 && expiry <
  // block.timestamp). Named, not refused: this host's clock is not the chain's, and the bytes
  // are otherwise valid — but a fill that can only revert must not look fillable.
  const expiredWarning = orderExpiredWarning(signedTraits.expiry, nowSecondsOf(ctx));
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
  // Liveness pre-flight: the venue can list rows whose on-chain invalidator already
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
            warnings: [{ code: "status_mismatch", message: `the venue lists this order as resting, but its on-chain ${plan.mode === "bit" ? "bit" : "remaining"} invalidator says FILLED-OR-CANCELLED — chain outranks the venue; a fill of these bytes can only revert InvalidatedOrder, so none were built` }],
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
  // FOREIGN extension targets (2026-09-23): the signed extension names every
  // contract the LOP will CALL inside the taker's transaction — the amount getters that set the
  // price, the maker's pre- and post-interaction hooks. A target that is neither a configured
  // generation's JIT adapter nor the release-pinned Fusion settlement is code nobody here has
  // read, executing on the taker's gas with the taker's funds in motion. The venue is discovery,
  // not authority, so such a row is REFUSED — no fill bytes, on the raw path and the ForSelf path
  // alike (the wrapper still passes the extension to the LOP). Not build-and-warn: an explicit cap
  // bounds an unknown GETTER's charge but says nothing about what an unknown HOOK does.
  {
    const targets = extensionTargets(signed.extension ?? "0x", (await resolveGenerations(chainId)).generations, chainId);
    const foreign = foreignExtensionTargets(targets);
    if (foreign.length > 0) {
      return envelope({
        state: "unavailable",
        data: { orderHash: action.orderHash, extensionTargets: targets, foreign },
        chainId,
        source: "service",
        warnings: [{ code: "foreign_extension_target", message: `the resting order's extension makes the LOP call ${String(foreign.length)} contract(s) that match no configured Cork generation and are not the pinned Fusion settlement: ${describeForeignTargets(foreign)}. Filling would execute unknown code inside YOUR transaction, so no fill bytes were built. Decode the order (cork_decode kind:"order") to inspect it; if the maker is trusted and the contract is known to you, fill through your own tooling — this tool will not build the bytes.` }],
        ctx,
      });
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
  // Auction-priced resting order: the amount getter charges the DECAYED price,
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
      // A CLASSIFIED getter means the order's price comes from a contract we cannot price.
      // We must not DERIVE a cap from its tail bytes — that would
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
  // ── Maker-readiness pre-flight (the 2026-09-11 incident class): a signed, live, authentic
  // resting order can still be UN-FILLABLE because the LOP cannot pull the maker asset — a
  // contract maker on an unborn JIT cST (every fill reverts), or a code-less makerAsset with
  // no creating hook (the fill silently moves nothing while the taker pays — simulation shows
  // that class GREEN, which is why this decode-based check exists beside simulation). Decoded
  // from the SIGNED bytes; chain facts read in ONE concurrent batch with the maker-side
  // approval annotation against the client the liveness pre-flight already resolved (the
  // batching client coalesces the overlapping legs — no extra chain-contact policy).
  // Build-and-warn, never refuse: every reason is the MAKER's to fix, without re-signing.
  const makerCtx = makerReadinessTargetOf({ generations: (await resolveGenerations(chainId)).generations, order: signed.order, extension: signed.extension, lop, makerSignedEcdsa: signed.makerAccountType === "EOA" });
  let makerEntries = makerApprovalRequirements({
    maker: signed.order.maker,
    makerAsset: signed.order.makerAsset,
    makingAmount: signed.order.makingAmount,
    lop,
    usePermit2: makerCtx.target.usePermit2,
    orderExpiry: makerCtx.orderExpiry,
    ...(makerCtx.target.jit ? { jit: makerCtx.target.jit } : {}),
  });
  let makerReadiness: MakerReadiness = { status: "unknown", reasons: [] };
  if (resolved) {
    const [makerFacts, annotatedMakerEntries] = await Promise.all([
      gatherMakerReadinessFacts(resolved.client, makerCtx.target, ctx.atBlock !== undefined ? { atBlock: ctx.atBlock } : {}),
      annotateApprovalStatus(resolved.client, { entries: makerEntries, nowSeconds: nowSecondsOf(ctx), ...(ctx.atBlock !== undefined ? { atBlock: ctx.atBlock } : {}) }),
    ]);
    makerEntries = annotatedMakerEntries;
    makerReadiness = assessMakerReadiness({
      makerAsset: signed.order.makerAsset,
      makingAmount: action.fillMakingAmount !== undefined ? BigInt(action.fillMakingAmount) : signed.order.makingAmount,
      allowPartialFills: makerCtx.allowPartialFills,
      usePermit2: makerCtx.target.usePermit2,
      jit: makerCtx.target.jit,
      extensionPermitToken: makerCtx.extensionPermitToken,
      nowSeconds: nowSecondsOf(ctx),
      facts: makerFacts,
    });
  }
  // Warning mapping: STRUCTURAL reasons (no pending grant fixes them as-is) → maker_not_ready;
  // fund-shaped reasons → would_revert; grant-shaped reasons ride the approval_missing
  // machinery from the annotated maker entries. The approval warning is gated on the verdict
  // so an escape hatch (an in-fill permit standing in for the zero allowance the annotation
  // sees) never produces contradictory messages — the entries still carry the raw reads.
  const makerStructural = makerReadiness.reasons.filter((r) => r.structural);
  if (makerStructural.length > 0) {
    jitWarnings.push({ code: "maker_not_ready", message: `the resting order's MAKER side cannot deliver as signed: ${makerStructural.map((r) => r.message).join(" ALSO: ")}. The fix is the maker's — re-read the book after the maker has acted (full verdict in data.makerReadiness)` });
  }
  const makerFundGaps = makerReadiness.reasons.filter((r) => !r.structural && (r.code === "balance-empty" || r.code === "balance-insufficient" || r.code === "mint-funding-missing"));
  if (makerFundGaps.length > 0) {
    jitWarnings.push({ code: "would_revert", message: `the resting order's MAKER side is not funded: ${makerFundGaps.map((r) => r.message).join(" ALSO: ")}. The maker can fix this without re-signing — these bytes stay valid, but simulate before broadcasting` });
  }
  if (makerReadiness.status !== "ready") {
    const makerApprovalWarn = approvalMissingWarning(makerEntries, "— these are the MAKER's grants (holder = the maker, not you; only the maker's account can execute them) — before any fill of this order can succeed");
    if (makerApprovalWarn) jitWarnings.push(makerApprovalWarn);
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
      ? { adapter: jitData.adapter, collateralAsset: action.jitMarket.collateralAsset, ...(jitData.permitWire ? { permitWire: jitData.permitWire } : {}), ...(jitData.predictedCorkSwapToken ? { predictedCorkSwapToken: jitData.predictedCorkSwapToken } : {}) }
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
      // The VERDICT's account type (ecrecover vs the ERC-1271 staticcall), never the venue's
      // claim — it decides the fill function above.
      makerAccountType: signed.makerAccountType,
      requiredMakingAmount: fill.requiredMakingAmount,
      requiredTakingAmount: fill.requiredTakingAmount,
      takerTraits: fill.takerTraits,
      // The order's exclusivity as signed (null = open); a non-null value here is the suffix
      // this fill's sender was just checked against.
      allowedSender,
      // Taker grants first, then the MAKER's (role/holder distinguish them): the maker entries
      // ride so a taker who reads a maker_not_ready/approval_missing warning can hand the
      // maker the exact missing grant.
      approvals: [...approvals, ...makerEntries],
      // The maker-side verdict behind the warnings above; "unknown" = no client resolved or a
      // needed read failed (indeterminate is never a verdict).
      makerReadiness,
      ...(a.quoteCover !== undefined ? { cover: a.quoteCover } : {}),
      // A caller-assembled interaction is opaque bytes: whatever tokens the interaction
      // contract itself pulls mid-fill are invisible here — say so instead of implying the
      // report is complete (jitMarket-built interactions ARE characterized, in `jit`).
      ...(action.interaction !== undefined ? { approvalsNote: "a custom taker interaction rides this fill — any tokens the interaction contract itself pulls are OUTSIDE this approvals report; discover them with cork_track simulate before granting anything" } : {}),
      ...(jitData ? { jit: jitData } : {}),
      ...(auctionData ? { auction: auctionData } : {}),
      // Money outputs carry their unit: two tokens' quanta meet on this result
      // and neither is necessarily 18-decimals.
      scales: { requiredMakingAmount: "base units of makerAsset (the token's own decimals)", requiredTakingAmount: "base units of takerAsset — the on-chain cap the calldata enforces", unitsTopic: UNITS_TOPIC_REFERENCE },
      simulationRequired: true,
      execution: executionEthTransaction(),
      clientRequestId: clientRequestId,
    },
    chainId,
    source: a.artifactSource,
    warnings: [...(expiredWarning ? [expiredWarning] : []), ...jitWarnings, { code: "unsigned_artifact", message: "unsigned fill calldata only — independently simulate it (cork_track simulate) and ensure the taker-asset allowance before signing or broadcasting" }, ...a.acquisitionWarnings],
    ctx,
  });
}

/** The invalidator a traits word selects, for a message: its slot, or none. */
function slotLabel(makerTraits: bigint): string {
  const p = lopInvalidatorPlan(makerTraits);
  return p.mode === "bit" ? `slot ${p.slot}` : "the remaining-amount invalidator (no slot word)";
}

/** `cancel` with scope `slot`: LOP.bitsInvalidateForOrder for the anchor
 *  order's slot word, the mask = every OTHER resting order of this maker in that slot, read from
 *  the venue book. The book is DISCOVERY, not authority: every row is re-hashed locally and
 *  judged from its SIGNED makerTraits (maker, invalidator mode, slot); a row that does not hash
 *  to its own claim is skipped and counted. Fail-closed on an incomplete traversal: a mask built
 *  from a partial book under-sweeps and the `retires` list would lie, so a conflict names the
 *  reason and the cursor instead (raise maxPages). A remaining-invalidator anchor refuses before
 *  the venue is contacted — the contract would revert OrderIsNotSuitableForMassInvalidation. */
async function handleCancelSlotSweep(a: {
  ctx: HandlerContext;
  chainId: ChainId;
  account: `0x${string}`;
  action: Extract<PrepareOrdersInput["action"], { type: "cancel" }>;
  lop: `0x${string}`;
  traits: bigint;
  plan: ReturnType<typeof lopInvalidatorPlan>;
}): Promise<Envelope> {
  const { ctx, chainId, account, action, lop, traits, plan } = a;
  if (plan.mode !== "bit") {
    return unavailable(chainId, "invalid_order_terms", `scope 'slot' needs a bit-invalidator order (NO_PARTIAL_FILLS set or ALLOW_MULTIPLE_FILLS unset — every Cork-built order); these makerTraits select the remaining-amount invalidator, where there is no slot word to sweep and the LOP reverts OrderIsNotSuitableForMassInvalidation. Use scope 'order' (cancelOrder) for this order`, ctx);
  }
  const deps = venueDepsOf(ctx);
  let book: Awaited<ReturnType<typeof collectVenuePages>>;
  try {
    // The venue's own maker filter narrows the walk to this account's rows; the local maker
    // check below still runs, because the filter is the venue's claim and the signed order is
    // the fact.
    book = await collectVenuePages({ maxPages: action.maxPages }, (cursor) => getLopOrderbook(deps, { chainId, maker: account, limit: 100, ...(cursor ? { cursor } : {}) }));
  } catch (err) {
    return venueFailed(chainId, err, ctx);
  }
  if (!book.complete) {
    return envelope({
      state: "conflict",
      data: { orderHash: action.orderHash, scope: "slot", pagesFetched: book.pagesFetched, reason: book.reason, ...(book.nextCursor ? { nextCursor: book.nextCursor } : {}) },
      chainId,
      source: "service",
      warnings: [{ code: "pagination_incomplete", message: `the walk over your resting orders was incomplete (${book.reason}) after ${book.pagesFetched} page(s): a slot mask built from a partial book would retire orders this result could not name, so no bytes were built — raise maxPages (max 50) or cancel with scope 'order'` }],
      ctx,
    });
  }
  const candidates: SlotSweepCandidate[] = [];
  const unreadable: Array<{ venueOrderHash: string | null; reason: string }> = [];
  for (const row of book.items) {
    const parsed = parseSignedLopOrder(row);
    if (!parsed.ok) { unreadable.push({ venueOrderHash: null, reason: `malformed row: ${parsed.error}` }); continue; }
    const localHash = hashLopOrder(chainId, lop, parsed.value.order);
    if (parsed.value.venueOrderHash !== undefined && parsed.value.venueOrderHash.toLowerCase() !== localHash.toLowerCase()) {
      unreadable.push({ venueOrderHash: parsed.value.venueOrderHash, reason: "row does not hash to its own claimed orderHash — skipped (order_hash_mismatch)" });
      continue;
    }
    // The anchor row, when the book carries it, is the one place the caller's claim can be
    // checked against the SIGNED traits: a disagreement means the caller's slot is not the
    // order's slot, and a sweep of the wrong word must not be built.
    if (localHash.toLowerCase() === action.orderHash.toLowerCase() && parsed.value.order.makerTraits !== traits) {
      return unavailable(chainId, "invalid_order_terms", `the makerTraits supplied (${traits}) are not the SIGNED makerTraits of the order the venue holds under ${action.orderHash} (${parsed.value.order.makerTraits}): the supplied traits select slot ${plan.slot}, the signed ones ${slotLabel(parsed.value.order.makerTraits)} — pass the traits verbatim from the resting order; no bytes were built`, ctx);
    }
    candidates.push({ orderHash: localHash, makerTraits: parsed.value.order.makerTraits, maker: parsed.value.order.maker });
  }
  const sweep = planSlotSweep({ orderHash: action.orderHash, makerTraits: traits }, account, candidates);
  const built = buildBitsInvalidateForOrder(traits, sweep.additionalMask);
  const anchorListed = candidates.some((c) => c.orderHash.toLowerCase() === action.orderHash.toLowerCase());
  const siblings = sweep.retires.filter((r) => r.relation !== "anchor");
  const sameSlot = siblings.filter((r) => r.relation === "same-slot");
  const sharedBit = siblings.filter((r) => r.relation === "shared-bit");
  const anchorBitIndex = slotCoordinates(sweep.nonce).bitIndex;
  const additionalBits = maskBits(sweep.additionalMask);
  const retires = {
    invalidator: "bit" as const,
    nonce: sweep.nonce.toString(),
    slot: sweep.slot.toString(),
    anchorBit: sweep.anchorBit.toString(),
    additionalMask: `0x${sweep.additionalMask.toString(16).padStart(64, "0")}` as `0x${string}`,
    additionalBits,
    scope: sameSlot.length > 0
      ? `every order by ${account} whose makerTraits carry nonce ${sweep.nonce} (bit ${anchorBitIndex} of slot ${sweep.slot}) AND the ${sameSlot.length} other resting order(s) of yours whose nonce shares slot ${sweep.slot} (bits ${additionalBits.join(",")}) — one transaction`
      : `every order by ${account} whose makerTraits carry nonce ${sweep.nonce} (bit ${anchorBitIndex} of slot ${sweep.slot}); the venue lists no other resting order of yours in that slot, so this sweep retires exactly what cancelOrder would`,
    orders: sweep.retires.map((r) => ({ orderHash: r.orderHash, nonce: r.nonce.toString(), bit: r.bitIndex, relation: r.relation, listed: r.relation === "anchor" ? anchorListed : true })),
    skipped: sweep.skipped,
    book: { rows: book.items.length, pagesFetched: book.pagesFetched, complete: book.complete, unreadable },
  };
  const warnings: Array<{ code: string; message: string }> = [];
  warnings.push({
    code: "cancel_sweep_notice",
    message: sameSlot.length > 0
      ? `this sweep retires ${sweep.retires.length} resting order(s) in one transaction: the anchor ${action.orderHash}${sharedBit.length > 0 ? `, ${sharedBit.length} sharing its bit (an ocoGroup — dead under a plain cancel too)` : ""}, and ${sameSlot.length} on other bits of slot ${sweep.slot} (${sameSlot.map((r) => r.orderHash).join(", ")}) that ONLY this sweep reaches. The venue does not index cancels: every one of these rows stays OPEN on the book until a chain read drops it (status_mismatch) — re-read the bit before ranking or filling. An order of yours in this slot that the venue does not list dies too`
      : `no other resting order of yours shares slot ${sweep.slot} (${book.items.length} row(s) read, ${sweep.skipped.length} skipped), so this bitsInvalidateForOrder spends exactly the bit cancelOrder would${sharedBit.length > 0 ? ` — and the ${sharedBit.length} ocoGroup sibling(s) on that bit die with it, as under scope 'order'` : ""}. Cork derives nonces from keccak seeds, so two independent orders share a slot in about one pair in 2^32; a sweep pays off only for nonces pinned to one slot (SDK nonce) or chosen by another tool. The venue does not index cancels: the row stays OPEN on the book until a chain read drops it (status_mismatch)`,
  });
  if (!anchorListed) {
    warnings.push({ code: "order_not_found", message: `the venue lists no resting order of yours under ${action.orderHash}: the sweep is built from the supplied makerTraits alone (the chain is the authority — a bit the venue never saw is spent all the same), and the mask covers the siblings the venue DID list` });
  }
  return envelope({
    state: "ok",
    data: { kind: "cancel", scope: "slot", to: lop, calldata: built.data, orderHash: action.orderHash, retires, execution: executionEthTransaction() },
    chainId,
    source: "service",
    warnings,
    ctx,
  });
}
