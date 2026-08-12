// Split from handlers.ts (2026-08-05): prepare-orders handlers — one typed dispatch, per-tool modules.
// Declarations are moved byte-identically; see handlers.ts for the runTool dispatch.
import { isAddressEqual } from "viem";
import { Envelope, executionEthTransaction, executionMakerOrder, executionRolloverIntent, PrepareOrdersInput } from "@cork/schemas";
import { buildCancelOrder, buildMakerOrder, buildTakerFill, classifyBitInvalidator, classifyRemainingRaw, decodeExtensionFields, encodeExtensionFields, ERC1271_MAGIC, erc1271Abi, finalizeMakerOrder, hashLopOrder, LOP_ADDRESSES, lopInvalidatorAbi, lopInvalidatorPlan, reconstructMakerOrder, type TakerFillResult } from "../orders.ts";
import { buildDeployFixedRateOracleCall, buildDeployOracleCall, buildJitExtension, encodeJitExtraData, predictShares } from "../market-registry.ts";
import { resolveRollover } from "../config-remote.ts";
import { buildRolloverIntent } from "../rollover.ts";
import { verificationDigest } from "../rollover-verify.ts";
import { type AuctionPriceReport, auctionPhase, buildAuctionAmountData, type DecodedFusionOrder, decodeFusionOrder, fusionRateBump, fusionTakerPays, fusionTotalFee, isGetterWhitelisted } from "../fusion.ts";
import { getLopOrderbook, parseSignedLopOrder } from "../datasources/venue.ts";
import { envelope, getDep, getRpc, type HandlerContext, isTransportFailure, nowSecondsOf, revertReason, ToolInputError, unavailable, venueDepsOf, venueFailed } from "./shared.ts";
import { collectVenuePages, venueNoticeWarnings } from "./query.ts";
import { buildTakerJitInteraction, diagnoseStaleSidePrediction, type JitLadderResult, jitValueGate, type LegacyJitReport, parsePermitWires, prepareJitLegacy, runJitPreflightLadder, type TakerJitReport } from "./jit.ts";
import { prepareForSelfTakerFill } from "./forself.ts";

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
  constraint?: Extract<JitLadderResult, { gate?: undefined }>["constraint"];
  identity?: string;
  predictedCorkSwapToken?: `0x${string}`;
  permitNote?: string;
};

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

  if (action.type === "finalize-maker-order") {
    const lop = LOP_ADDRESSES[chainId];
    if (!lop) return unavailable(chainId, "no_lop", `no known 1inch LOP v4 deployment for chainId ${chainId}`, ctx);
    // The listing must carry a premium in at least one spelling (the venue's own at-least-one
    // rule) — checked HERE, not just at submit, so the emitted submitInput is relayable as-is
    // and the failure lands before a signature ceremony, not after it.
    if (action.listing.premium === undefined && action.listing.premiumAnnualized === undefined) {
      return unavailable(chainId, "invalid_order_terms", `the listing needs a premium: send listing.premiumAnnualized, the annualized decimal-fraction STRING ("0.041" = 4.1%) shared with the RFQ surface (the percent-number listing.premium is deprecated; the venue removes it 2026-08-17)`, ctx);
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
      const resolved = await getRpc(ctx, chainId);
      let makerCode: string | undefined;
      if (resolved) {
        try {
          makerCode = await resolved.client.getCode({ address: m.maker });
        } catch {
          makerCode = undefined; // code unknowable (transport or a client without getCode) — the EOA branch discloses it
        }
      }
      if (makerCode !== undefined && makerCode !== "0x") {
        let magic: unknown;
        try {
          magic = await resolved!.client.readContract({ address: m.maker, abi: erc1271Abi, functionName: "isValidSignature", args: [reconstructedHash, action.signature] });
        } catch (err) {
          // Attribution: a transport failure is indeterminate (retryable, not a verdict); a
          // contract-side revert IS the verdict — the fill runs this exact staticcall.
          if (isTransportFailure(err)) {
            return unavailable(chainId, "chain_read_failed", `the maker ${m.maker} is a CONTRACT account but its isValidSignature staticcall failed in transport (${revertReason(err)}) — the ERC-1271 signature could not be verified either way; retry with a working RPC (the fill path requires this exact call to answer)`, ctx);
          }
          magic = null;
        }
        if (typeof magic !== "string" || magic.slice(0, 10).toLowerCase() !== ERC1271_MAGIC) {
          return envelope({
            state: "conflict",
            data: { orderHash: reconstructedHash, maker: m.maker, makerAccountType: "ERC1271", isValidSignatureAnswer: typeof magic === "string" ? magic : null },
            chainId,
            source: "chain",
            warnings: [{ code: "signature_or_reconstruction_mismatch", message: `the maker ${m.maker} is a CONTRACT account and its isValidSignature(orderHash, signature) did not answer the ERC-1271 magic value — the fill path runs this exact staticcall, so the order could rest on the book but never fill. NOT finalized. (For a Safe, the hash must have been approved/signed per its own ERC-1271 scheme.)` }],
            ctx,
          });
        }
        makerAccountType = "ERC1271";
      } else {
        const eoaFinalized = await finalizeMakerOrder({ ...orderArgs, signature: action.signature });
        recoveredSigner = eoaFinalized.recoveredSigner;
        if (makerCode === undefined) {
          finalizeWarnings.push({ code: "chain_read_failed", message: "no RPC resolved to check whether the maker has code — the signature ecrecovers to the maker, so it is finalized as an EOA order; if the maker is actually a contract account, resubmit with an RPC available" });
        }
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
          ...(action.listing.premium !== undefined ? { premium: action.listing.premium } : {}),
          ...(action.listing.premiumAnnualized !== undefined ? { premiumAnnualized: action.listing.premiumAnnualized } : {}),
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
      return envelope({
        state: "ok",
        data: { ...artifact, signedArtifactDigest: verificationDigest(artifact), callerSigned: true, helperSigned: false },
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
      const valueGate = jitValueGate(chainId, ctx, swapFee, unwindFee, expiryTimestamp, nowSecs);
      if (valueGate) return valueGate;
      const FIVE_YEARS = 5n * 31_557_600n;
      if (expiryTimestamp > nowSecs + FIVE_YEARS) {
        warnings.push({ code: "expiry_far_future", message: `jitMarket.expiryTimestamp ${expiryTimestamp} is more than 5 years out — cPT principal stays locked until expiry, and the chain enforces NO upper bound; double-check this is intended` });
      }

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
          jitData = { ...jitData, source, oracle: { address: oracle.address, deployed: oracle.deployed, ...(oracle.rate !== null ? { rate: oracle.rate } : {}) }, derivedPoolId: derived.poolId, constraint, identity: "PINNED at signing: the constraint is carried in the order, so this pool id and the predicted share addresses hold however far the rate moves (2.1.0)" };
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
              });
              const cst = pred.cst;
              if (pred.status === "unavailable") {
                warnings.push({ code: "share_prediction_unavailable", message: "could not predict the new pool's cST address (eth_simulateV1/state overrides unsupported or simulation failed) — VERIFY yourself that one order side is the derived pool's cST, or the fill reverts OrderNotForPool; the ERC-2612 permit must also be signed over that cST" });
              }
              if (cst) {
                jitData = { ...jitData, predictedCorkSwapToken: cst, permitNote: "for a NEW pool, sign an ERC-2612 permit over this cST (owner = maker, spender = the LOP, value >= the cST amount) and pass it in jitMarket.permits — a fresh token has no prior allowance for the LOP's pull" };
                const cstLc = cst.toLowerCase();
                if (action.makerAsset.toLowerCase() !== cstLc && action.takerAsset.toLowerCase() !== cstLc) {
                  warnings.push({ code: "jit_side_mismatch", message: `NEITHER order side is the derived pool's cST ${cst} — the fill WILL revert OrderNotForPool. Set makerAsset (selling coverage) or takerAsset (buying coverage) to the predicted cST` });
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
        extension = buildJitExtension(
          ladder.adapter,
          encodeJitExtraData(
            { collateralAsset: jm.collateralAsset, referenceAsset: jm.referenceAsset, expiryTimestamp, recipe, rateOverride, constraint, additionalData, swapFeePercentage: swapFee, unwindSwapFeePercentage: unwindFee, enableJitMint: jm.enableJitMint },
            permits,
          ),
        );
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
        ...(jitData ? { jit: jitData } : {}),
        ...(fusionData ? { fusion: fusionData } : {}),
        execution: executionMakerOrder(),
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
    const cancel = buildCancelOrder(BigInt(action.makerTraits), action.orderHash);
    return envelope({ state: "ok", data: { kind: "cancel", to: lop, calldata: cancel.data, orderHash: action.orderHash, execution: executionEthTransaction() }, chainId, source: "config", ctx });
  }

  if (action.type === "rollover-intent") {
    const { rollover, warning: rolloverWarn } = await resolveRollover(chainId);
    if (!rollover) {
      return unavailable(chainId, "unknown_deployment", `no rollover deployment configured for chainId ${chainId} (rollover is live on Arbitrum One, 42161)`, ctx);
    }
    const warnings: Array<{ code: string; message: string }> = rolloverWarn ? [rolloverWarn] : [];

    // Settler-kind pre-flight: the mode gate is enforced ON-CHAIN (ExactSettler reverts
    // Settler__PartialFillsNotSupported on allowPartialFills:true and PartialSettler reverts
    // Settler__ExactFillsNotSupported on false), so a mismatched order is signable but unfillable.
    const settlerLc = action.settler.toLowerCase();
    const kind = settlerLc === rollover.exactSettler.toLowerCase() ? "EXACT" : settlerLc === rollover.partialSettler.toLowerCase() ? "PARTIAL" : undefined;
    if (kind === "EXACT" && action.allowPartialFills) {
      return unavailable(chainId, "settler_mode_mismatch", `settler ${action.settler} is the ExactSettler, which rejects allowPartialFills:true on-chain — use the PartialSettler ${rollover.partialSettler} or set allowPartialFills:false`, ctx);
    }
    if (kind === "PARTIAL" && !action.allowPartialFills) {
      return unavailable(chainId, "settler_mode_mismatch", `settler ${action.settler} is the PartialSettler, which rejects allowPartialFills:false on-chain — use the ExactSettler ${rollover.exactSettler} or set allowPartialFills:true`, ctx);
    }
    if (kind === undefined) {
      warnings.push({ code: "settler_not_recognized", message: `settler ${action.settler} is not a configured Cork settler for chainId ${chainId} (exact: ${rollover.exactSettler}, partial: ${rollover.partialSettler}) — the venue only admits factory-approved settlers` });
    }

    const openDeadline = BigInt(action.openDeadline);
    const fillDeadline = BigInt(action.fillDeadline);
    const orderSize = BigInt(action.orderSize);
    const nowSecs = nowSecondsOf(ctx);
    if (orderSize === 0n) return unavailable(chainId, "invalid_order_terms", "orderSize must be positive — the venue rejects non-positive sizes", ctx);
    if (openDeadline > fillDeadline) return unavailable(chainId, "invalid_order_terms", `openDeadline (${openDeadline}) must not exceed fillDeadline (${fillDeadline})`, ctx);
    if (fillDeadline <= nowSecs) return unavailable(chainId, "invalid_order_terms", `fillDeadline (${fillDeadline}) is not in the future (now ${nowSecs}) — the venue rejects past deadlines`, ctx);

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
    const deps = venueDepsOf(ctx);
    const wanted = action.orderHash.toLowerCase();
    try {
      // Locate the resting order in the venue book under a hard page bound; an exhausted bound
      // fails closed (no false "not found") rather than truncating silently.
      const book = await collectVenuePages(
        { pageSize: 100, maxPages: action.maxPages },
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
      // Liveness pre-flight [K7]: the venue can list rows whose on-chain invalidator already
      // says filled-or-cancelled (observed live 2026-08-06 — every resting sell row was dead).
      // Fill bytes for such an order can only revert InvalidatedOrder, so a DEFINITIVE dead
      // reading is a conflict (chain outranks the venue), not an artifact. Best-effort: no
      // resolved RPC or a failed read builds as before (this tool never claimed liveness).
      {
        const resolved = await getRpc(ctx, chainId);
        if (resolved) {
          try {
            const plan = lopInvalidatorPlan(signed.order.makerTraits);
            const status =
              plan.mode === "bit"
                ? classifyBitInvalidator((await resolved.client.readContract({ address: lop, abi: lopInvalidatorAbi, functionName: "bitInvalidatorForOrder", args: [signed.order.maker, plan.slot] })) as bigint, plan.mask)
                : classifyRemainingRaw((await resolved.client.readContract({ address: lop, abi: lopInvalidatorAbi, functionName: "rawRemainingInvalidatorForOrder", args: [signed.order.maker, localOrderHash] })) as bigint);
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
        } catch {
          /* not auction-priced — the plain signed-ratio cap is correct */
        }
        if (auctionDec) {
          const nowSecs = nowSecondsOf(ctx);
          const fillMaking = action.fillMakingAmount ? BigInt(action.fillMakingAmount) : signed.order.makingAmount;
          const whitelisted = isGetterWhitelisted(auctionDec.fees, input.account);
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
          account: input.account,
          clientRequestId: input.clientRequestId,
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
          taker: input.account,
          extension: signed.extension,
          ...(action.receiver ? { receiver: action.receiver } : {}),
          ...(action.fillMakingAmount ? { fillMakingAmount: BigInt(action.fillMakingAmount) } : {}),
          ...(action.maximumTakingAmount ? { maximumTakingAmount: BigInt(action.maximumTakingAmount) } : auctionCap !== undefined ? { maximumTakingAmount: auctionCap } : {}),
          ...(interaction ? { interaction } : {}),
        });
      } catch (err) {
        return unavailable(chainId, "invalid_order_terms", err instanceof Error ? err.message : "the resting order cannot be filled by this variant", ctx);
      }
      return envelope({
        state: "ok",
        data: {
          kind: "taker-fill",
          to: lop,
          calldata: fill.calldata,
          value: "0",
          from: input.account,
          orderHash: localOrderHash,
          makerAsset: signed.order.makerAsset,
          takerAsset: signed.order.takerAsset,
          fillFunction: fill.functionName,
          requiredMakingAmount: fill.requiredMakingAmount,
          requiredTakingAmount: fill.requiredTakingAmount,
          takerTraits: fill.takerTraits,
          ...(jitData ? { jit: jitData } : {}),
          ...(auctionData ? { auction: auctionData } : {}),
          simulationRequired: true,
          execution: executionEthTransaction(),
          clientRequestId: input.clientRequestId,
        },
        chainId,
        source: "service",
        // venueNoticeWarnings: the venue's in-band notices ride the book pages this search read
        // (e.g. the premium-field deprecation) — the fill path is exactly who they are for.
        warnings: [...jitWarnings, { code: "unsigned_artifact", message: "unsigned fill calldata only — independently simulate it (cork_track simulate) and ensure the taker-asset allowance before signing or broadcasting" }, ...venueNoticeWarnings(book)],
        ctx,
      });
    } catch (err) {
      return venueFailed(chainId, err, ctx);
    }
  }

  return unavailable(chainId, "phase_gated", `prepare_orders '${(action as { type: string }).type}' is not implemented`, ctx);
}
