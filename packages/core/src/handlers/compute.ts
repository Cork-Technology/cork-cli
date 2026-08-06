// Split from handlers.ts (2026-08-05): compute handlers — one typed dispatch, per-tool modules.
// Declarations are moved byte-identically; see handlers.ts for the runTool dispatch.
import { ComputeInput, type ComputeParams, Envelope, Hex } from "@cork/schemas";
import { mulDiv, WAD } from "../math/fixed.ts";
import { impairmentFloor, previewAdjustedRate } from "../math/constraint.ts";
import { previewSwap, previewUnwindSwap } from "../math/preview.ts";
import { type CorkAddresses, readPoolState } from "../chain/reads.ts";
import { decodeMakerTraits, hashLopOrder, LOP_ADDRESSES } from "../orders.ts";
import { type DecodedFusionOrder, decodeFusionOrder, fusionRateBump, fusionTakerPays, fusionTotalFee, isGetterWhitelisted, NotAFusionOrder } from "../fusion.ts";
import { chainReadFailed, envelope, getDep, getRpc, type HandlerContext, localComputeFailed, nowSecondsOf, rpcProvenance, rpcWarn, ToolInputError, unavailable } from "./shared.ts";
import { parseOrderRecord } from "./decode.ts";
import { getRegistry, handleComputeResolveRecipeLegacy, resolveRecipeOracleConstraint } from "./registry.ts";


export async function handleCompute(input: ComputeInput, ctx: HandlerContext): Promise<Envelope> {
  const chainId = input.chainId ?? 1;
  const p = input.params;

  if (p.kind === "rollover-premium-floor") {
    const floor = mulDiv(BigInt(p.dstCstProduced), BigInt(p.minPremiumPerShare), WAD, "floor");
    return envelope({ state: "ok", data: { kind: p.kind, premiumFloor: floor }, chainId, source: "config", ctx });
  }

  // Chain-backed kinds need an RPC + addresses.
  if (p.kind === "cst-swap-rate" || p.kind === "unwind-rate" || p.kind === "impairment-floor") {
    const { dep, depWarn } = await getDep(ctx, chainId);
    if (!dep) return unavailable(chainId, "unknown_deployment", `no known Cork deployment for chainId ${chainId}`, ctx);
    const resolved = await getRpc(ctx, chainId);
    if (!resolved) return unavailable(chainId, "requires_rpc", `${p.kind} needs an RPC endpoint for chainId ${chainId} (none resolved: offline, or a chain with no default/fallback — set CORK_RPC_URL)`, ctx);
    const client = resolved.client;
    // rpcWarn/rpcProvenance are evaluated at ENVELOPE construction, not here: the client fails
    // over in-call on a dead endpoint (mutating `resolved`), and the disclosure must describe
    // the endpoint that actually served the reads.
    const w = [...depWarn];
    const rpc = () => rpcProvenance(input.format, resolved);
    const addrs: CorkAddresses = { poolManager: dep.poolManager, constraintAdapter: dep.constraintAdapter };
    const pinnedBlock = input.at?.block !== undefined ? BigInt(input.at.block) : ctx.atBlock;
    if (input.at?.timestamp !== undefined) {
      // Accepted-but-reserved field (F12): validated, then ignored — say so instead of letting a
      // caller believe their replay was timestamp-pinned.
      w.push({ code: "reserved_field_ignored", message: "at.timestamp is accepted but NOT honored in this iteration — results are anchored to the block/clock; use at.block to pin chain reads" });
    }
    // [C11] Only the RPC read lives in the chain try/catch; the local math below produces its own
    // envelope on a domain violation instead of masquerading as a chain failure.
    let s: Awaited<ReturnType<typeof readPoolState>>;
    try {
      s = await readPoolState(client, addrs, p.poolId, pinnedBlock);
    } catch (err) {
      return chainReadFailed(chainId, err, [...rpcWarn(resolved), ...w], ctx, resolved);
    }
    try {
      const swapRate = previewAdjustedRate({ market: s.market, state: s.constraintState, oracleRate: s.oracleRate, nowTs: s.blockTimestamp });
      const decimals = { collateralDecimals: s.collateralDecimals, referenceDecimals: s.referenceDecimals };

      if (p.kind === "cst-swap-rate") {
        const r = previewSwap(BigInt(p.collateralAssetsOut), { swapRate, swapFeePercentage: s.swapFeePercentage, collateralDecimals: s.collateralDecimals, referenceDecimals: s.referenceDecimals });
        // Unit disclosure (F7): this response mixes three decimal systems; label every field so
        // an integration built on an 18/18 pool doesn't break by 10^12 on a 6-dec asset.
        const scales = {
          swapRate: "1e18 = 1.0 (WAD)",
          cstSharesIn: "cST shares, always 18-decimals",
          referenceAssetsIn: `native decimals of the reference asset (${s.referenceDecimals})`,
          fee: `native decimals of the collateral asset (${s.collateralDecimals})`,
        };
        return envelope({ state: "ok", data: { kind: p.kind, swapRate, ...r, scales, ...decimals }, chainId, source: "chain", block: s.blockNumber, warnings: [...rpcWarn(resolved), ...w], ...rpc(), ctx });
      }
      if (p.kind === "unwind-rate") {
        const r = previewUnwindSwap(BigInt(p.collateralAssetsIn), { swapRate, unwindSwapFeePercentage: s.unwindSwapFeePercentage, collateralDecimals: s.collateralDecimals, referenceDecimals: s.referenceDecimals, issuedAt: s.issuedAt, expiryTimestamp: s.market.expiryTimestamp, nowTs: s.blockTimestamp });
        const scales = {
          swapRate: "1e18 = 1.0 (WAD)",
          cstSharesOut: "cST shares, always 18-decimals",
          referenceAssetsOut: `native decimals of the reference asset (${s.referenceDecimals})`,
          fee: `native decimals of the collateral asset (${s.collateralDecimals})`,
        };
        return envelope({ state: "ok", data: { kind: p.kind, swapRate, ...r, scales, ...decimals }, chainId, source: "chain", block: s.blockNumber, warnings: [...rpcWarn(resolved), ...w], ...rpc(), ctx });
      }
      const floor = impairmentFloor({ market: s.market, state: s.constraintState, horizonSeconds: BigInt(p.horizonSeconds), tEval: s.blockTimestamp });
      const scales = { worstRate: "1e18 = 1.0 (WAD)", maxReferencePerCst: "reference WAD per 1e18 cST (null = unbounded: impairment can be total)", availableAtEval: "WAD descent budget" };
      if (floor.maxReferencePerCst === null) {
        w.push({ code: "invalid_state", message: "the worst-case rate collapses to ZERO over this horizon (rateMin is 0) — impairment can be total and the reference cost per cST is unbounded" });
      }
      return envelope({ state: "ok", data: { kind: p.kind, ...floor, scales }, chainId, source: "chain", block: s.blockNumber, warnings: [...rpcWarn(resolved), ...w], ...rpc(), ctx });
    } catch (err) {
      return localComputeFailed(chainId, err, [...rpcWarn(resolved), ...w], ctx);
    }
  }

  if (p.kind === "resolve-recipe") {
    // 2.1.0: ask the recipe CONTRACT what four rate limits it would impose (a staticcall to
    // recipe.resolve) — THE step that produces the constraint you sign into a JIT order. The
    // registry's percentage-band math is gone from the public surface; p.legacy reaches the
    // deprecated pre-2.1.0 bands behind the gate.
    if (p.legacy) return handleComputeResolveRecipeLegacy(input, p, ctx, chainId);
    if (!p.collateralAsset || !p.referenceAsset) {
      return unavailable(chainId, "missing_filter", "resolve-recipe needs collateralAsset + referenceAsset (the pair the constraint is for), plus recipe (the approved recipe CONTRACT ADDRESS; mode survives as deprecated sugar). Optional: args (recipe additionalData hex), rate (FIXED recipes), rateOracle (explicit oracle)", ctx);
    }
    const r = await getRegistry(ctx, chainId);
    if (r.gate) return r.gate;
    const { mr, resolved, warnings } = r;
    const client = resolved.client;
    try {
      const res = await resolveRecipeOracleConstraint({
        client,
        ctx,
        chainId,
        mr,
        recipe: p.recipe,
        mode: p.mode,
        collateralAsset: p.collateralAsset,
        referenceAsset: p.referenceAsset,
        fixedRate: p.rate !== undefined ? BigInt(p.rate) : undefined,
        rateOracle: p.rateOracle,
        additionalData: p.args,
        wantConstraint: true,
      });
      warnings.push(...res.warnings);
      if (res.gate) return res.gate;
      const { recipe, source, oracle, constraint } = res;
      return envelope({
        state: "ok",
        data: {
          kind: p.kind,
          recipe,
          source,
          scales: { constraint: "ABSOLUTE rates, 1e18 = 1.0 — these four raw values are what a JIT order carries, in this order" },
          constraint,
          rateOracle: { address: oracle.address, status: oracle.deployed ? "live" : oracle.address ? "predicted" : "none", ...(oracle.mode ? { mode: oracle.mode } : {}), rate: oracle.rate, ...(oracle.reason ? { reason: oracle.reason } : {}) },
          note: oracle.deployed ? "resolved against the LIVE oracle rate" : "no live oracle — the recipe resolved from its fallback (e.g. the anchorRate in args); the eventual fill deploys the oracle and re-checks with recipe.verify against the LIVE rate",
        },
        chainId,
        source: "chain",
        warnings: [...rpcWarn(resolved), ...warnings],
        ...rpcProvenance(input.format, resolved),
        ctx,
      });
    } catch (err) {
      return chainReadFailed(chainId, err, [...rpcWarn(resolved), ...warnings], ctx, resolved);
    }
  }

  if (p.kind === "dutch-auction-price") {
    return handleComputeDutchAuction(input, p, ctx);
  }
  // The one deliberately-gated kind left, naming its REAL blocker and unblock condition.
  return unavailable(chainId, "phase_gated", "rfq-quote would RECOMMEND a price — a pricing-model/product decision that is deliberately deferred, not missing infrastructure. The registry band math it would build on is already live as cork_compute resolve-recipe; discover open RFQs with cork_query rfqs and answer them with cork_submit rfq-answer. A Fusion-style decaying-premium order (compute dutch-auction-price is live) is one modeled-quote-free alternative — see notes/fusion-integration-plan.md", ctx);
}

/**
 * dutch-auction-price: the CURRENT price of a 1inch Fusion (v3.1) dutch-auction order — pure
 * local math over the order's own extension bytes [K3]. Price = f(extension, taker, basefee,
 * timestamp); the port is proven wei-exact against the DEPLOYED settlement getters on mainnet +
 * Arbitrum (experiments/fusion-spike/probe.ts). at.timestamp pins the moment (the one compute
 * input that is clock-anchored, not block-anchored); baseFeeWei omitted = gas bump skipped =
 * upper-bound price.
 */
function handleComputeDutchAuction(input: ComputeInput, p: Extract<ComputeParams, { kind: "dutch-auction-price" }>, ctx: HandlerContext): Envelope {
  const chainId = input.chainId ?? 1;
  const order = parseOrderRecord(p.order, "cork_compute", ["params", "order"]);
  const extRaw = p.order.extension;
  const extParsed = extRaw === undefined ? undefined : Hex.safeParse(extRaw);
  if (extParsed === undefined || !extParsed.success) {
    throw new ToolInputError("cork_compute", [
      { path: ["params", "order", "extension"], message: "dutch-auction-price needs the order's extension bytes (0x-hex) — the auction curve lives in extension.makingAmountData, so an order without its extension cannot be priced; fetch the order WITH its extension" },
    ]);
  }
  const extension = extParsed.data as `0x${string}`;

  let decoded: DecodedFusionOrder;
  try {
    decoded = decodeFusionOrder(order, extension, chainId);
  } catch (err) {
    if (err instanceof NotAFusionOrder) {
      // Well-formed bytes that are structurally not a (supported) Fusion order → domain envelope.
      return unavailable(chainId, err.message.includes("LEGACY") ? "phase_gated" : "invalid_order_terms", err.message, ctx);
    }
    // Malformed extension/auction bytes → teachable invalid input (same split as decode calldata).
    throw new ToolInputError("cork_compute", [{ path: ["params", "order", "extension"], message: err instanceof Error ? err.message : "extension bytes do not decode" }]);
  }

  const warnings: Array<{ code: string; message: string }> = [];
  if (!decoded.saltBoundToExtension) {
    return envelope({
      state: "conflict",
      data: { kind: p.kind, settlement: decoded.settlement, classification: decoded.classification, order },
      chainId,
      source: "config",
      warnings: [{ code: "extension_salt_mismatch", message: "salt's low 160 bits are NOT keccak256(extension)'s low 160 bits — this order/extension pair would revert InvalidExtension at fill; the price of an unfillable pair is not quoted" }],
      ctx,
    });
  }
  if (decoded.classification === "unknown") {
    warnings.push({ code: "settler_not_recognized", message: `settlement ${decoded.settlement} (decoded from the extension) is not in the known Fusion set for chainId ${chainId} — priced as the v3.1 layout since the bytes parse as one; verify the contract independently before acting on this quote` });
  }

  const pinned = input.at?.timestamp !== undefined;
  const ts = pinned ? BigInt(input.at!.timestamp!) : nowSecondsOf(ctx);
  const baseFee = p.baseFeeWei !== undefined ? BigInt(p.baseFeeWei) : null;
  const bump = fusionRateBump(decoded.auction, ts, baseFee);
  const finish = decoded.auction.startTime + decoded.auction.duration;
  const phase = ts <= decoded.auction.startTime ? "pre-start" : ts >= finish ? "floor" : "decaying";

  const m = p.makingAmount !== undefined ? BigInt(p.makingAmount) : order.makingAmount;
  const M = order.makingAmount;
  const T = order.takingAmount;
  // A requested makingAmount above the order's own makingAmount extrapolates the linear term past
  // what is fillable — 1inch clamps any fill to the remaining amount, so takerPays for m > M is a
  // number that corresponds to no real fill. Disclose it (build-and-warn, same posture as the
  // taker-fill clamp which hard-errors on a SIGNABLE artifact; a quote stays a quote). [footgun N2]
  if (m > M) {
    warnings.push({ code: "makingamount_exceeds_order", message: `makingAmount ${m} exceeds the order's own makingAmount ${M}; the price is a LINEAR EXTRAPOLATION of no fillable amount (1inch clamps every fill to the remaining size). Quote at most ${M} for a realizable taker cost` });
  }
  const feeWhitelisted = fusionTotalFee(decoded.fees, true);
  const feeOther = fusionTotalFee(decoded.fees, false);
  const takerWhitelisted = p.taker !== undefined ? isGetterWhitelisted(decoded.fees, p.taker) : undefined;
  const price =
    p.taker !== undefined
      ? { makingAmount: m, taker: p.taker, takerIsGetterWhitelisted: takerWhitelisted, takerPays: fusionTakerPays(M, T, m, takerWhitelisted ? feeWhitelisted : feeOther, bump.effective) }
      : { makingAmount: m, takerPays: { whitelistedTaker: fusionTakerPays(M, T, m, feeWhitelisted, bump.effective), nonWhitelistedTaker: fusionTakerPays(M, T, m, feeOther, bump.effective) } };

  const traits = decodeMakerTraits(order.makerTraits);
  const lop = LOP_ADDRESSES[chainId];
  if (!lop) warnings.push({ code: "no_lop", message: `no known 1inch LOP v4 deployment for chainId ${chainId} — the EIP-712 orderHash needs the verifying contract, so it is omitted` });
  const pi = decoded.postInteraction;
  return envelope({
    state: "ok",
    data: {
      kind: p.kind,
      chainId,
      settlement: { address: decoded.settlement, classification: decoded.classification },
      orderHash: lop ? hashLopOrder(chainId, lop, order) : null,
      at: { timestamp: ts, source: pinned ? "at.timestamp (pinned)" : "ctx clock", baseFeeWei: baseFee },
      auction: { ...decoded.auction, finishTime: finish },
      phase,
      rateBump: {
        auctionBump: bump.auctionBump,
        gasBump: baseFee === null ? null : bump.gasBump,
        effective: bump.effective,
        ...(baseFee === null && decoded.auction.gasBumpEstimate > 0n ? { gasBumpSkipped: "baseFeeWei not supplied — the gas-adjustment term is skipped, so this is the UPPER-BOUND price" } : {}),
      },
      price,
      fees: { integratorFee: decoded.fees.integratorFee, resolverFee: decoded.fees.resolverFee, whitelistDiscountNumerator: decoded.fees.whitelistDiscountNumerator, getterWhitelistSize: decoded.fees.whitelist.length },
      fillability: {
        makerTraitsExpiry: traits.expiry,
        ...(pi
          ? {
              gated: true,
              resolvingStartTime: pi.resolvingStartTime,
              publicFillTime: pi.publicFillTime,
              whitelistSize: pi.whitelist.length,
              accessTokenFallback: "a non-whitelisted taker may fill only after publicFillTime AND while holding the Fusion access token",
              ...(chainId === 1 && decoded.classification === "current" ? { priorityFeeCap: "mainnet Settlement additionally caps the fill tx's priority fee (DAO rule) — a fill above the cap reverts regardless of price" } : {}),
              surplus: { estimatedTakingAmount: pi.estimatedTakingAmount, protocolSurplusFeePercent: pi.surplusFeePercent, note: "surplus fee affects MAKER proceeds, not the taker-side price quoted here" },
            }
          : { gated: false, note: "no post-interaction bound to the settlement — fills are permissionless at the decayed price (Cork-native auction-order shape)" }),
      },
      scales: {
        rateBump: "1e7 = 100% (bump base)",
        fees: "1e5 base (integratorFee/resolverFee)",
        whitelistDiscountNumerator: "1e2 base",
        takerPays: "taker-asset native base units (includes fees; the fee slice is split out in postInteraction)",
        makingAmount: "maker-asset native base units",
      },
      note: "the quote decays with time: re-evaluate (or pin at.timestamp) near fill, and remaining fill capacity is chain state (LOP invalidators via cork_track reconcile), not part of this pure computation",
    },
    chainId,
    source: "config",
    warnings,
    ctx,
  });
}
