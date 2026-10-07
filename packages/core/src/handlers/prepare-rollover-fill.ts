// cork_prepare_orders: the FILLER side of a rollover (`rollover-fill`) and the per-account clone
// (`deploy-rollover-contract`) — 2026-10-01, the 2026-10-01 integration triage, item 4. Until now the maker side
// existed (rollover-intent → cork_submit rollover-order) and nothing could take a posted roll
// order: underwriter-one's v0.4 roll orders were re-posted every half hour and never filled.
//
// The roll order's counterparty is the SOURCE cST holder — the cover buyer whose position the
// holder's cPT is being rolled with. The fill runs through the generation's BaseFiller (the
// contracts' own filler entry: it pulls the src cST and the premium cap from the caller, opens
// the order if needed, calls settler.fill with the atomic envelope, and refunds every surplus),
// so the caller's two allowances go to BaseFiller. Byte-building is rollover-fill.ts; this file
// is the pre-flight — every refusal names the on-chain revert it pre-empts — and the envelope.
//
// Re-entry contract: this module is a sub-feature of cork_prepare_orders and never imports the
// dispatcher (no cycle); the dispatcher calls it. Chain reads are best-effort disclosures except
// where a verdict needs them (the digest recomputation is pure; the settler status, the clone
// ownership and the allowances are read when an RPC resolves and disclosed as unverified when
// none does — a fill is never REFUSED on a transport blip, only on a definitive answer).
import { isAddressEqual, zeroAddress, zeroHash } from "viem";
import { type ChainId, Envelope, executionEthTransaction, type PrepareOrdersInput, UNITS_TOPIC_REFERENCE } from "@cork/schemas";
import { erc20Abi } from "../chain/abis.ts";
import { resolveRollover } from "../config-remote.ts";
import { getRolloverOrder } from "../datasources/venue.ts";
import { annotateApprovalStatus, type ApprovalRequirement, approvalMissingWarning, erc20ApproveTx } from "../order-approvals.ts";
import { activeSettlersTeaching, classifyRolloverSettler, computeOrderDigest, hashJitMarketParams, type JitMarketParamsStruct, retiredSettlerTeaching, type RolloverGeneration, RolloverJitWireError } from "../rollover.ts";
import { encodeBaseFillerExecute, encodeBaseFillerExecuteWithMarket, encodeDeployRolloverContract, encodeOriginData, fillerAuthTypedData, gaslessOrderOf, hashFillerAuth, parseRolloverPayload, type ParsedRolloverPayload, requiredPremium, rolloverFactoryAbi } from "../rollover-fill.ts";
import { checkContractMakerSignature, probeMakerCode, recoverEoaSigner } from "./order-auth.ts";
import { chainStatusName, settlerStatusAbi } from "../rollover-verify.ts";
import { resolveJitBytesInput } from "./jit.ts";
import { chainReadFailed, envelope, firstLine, getRpc, type HandlerContext, isTransportFailure, nowSecondsOf, revertReason, rpcProvenance, rpcWarn, ToolInputError, unavailable, venueDepsOf, venueFailed } from "./shared.ts";

type RolloverFillAction = Extract<PrepareOrdersInput["action"], { type: "rollover-fill" }>;
type DeployCloneAction = Extract<PrepareOrdersInput["action"], { type: "deploy-rollover-contract" }>;
type Warning = { code: string; message: string };

const TERMINAL: ReadonlySet<string> = new Set(["Settled", "Expired", "Cancelled", "Closing"]);

/** The venue's resolved record for one digest carries the signed payload under `order.payload`
 *  (the list rows under `payload`); both spellings are read. */
function payloadOfVenueRow(row: Record<string, unknown>): Record<string, unknown> | undefined {
  const order = row["order"];
  const nested = order && typeof order === "object" ? (order as Record<string, unknown>)["payload"] : undefined;
  const flat = row["payload"];
  const p = nested ?? flat;
  return p && typeof p === "object" ? (p as Record<string, unknown>) : undefined;
}

/** The venue's `remainingSize` (a decimal string, or a number on an older row) — undefined when
 *  the row carries none, so the caller can say which default it fell back to. */
function remainingSizeOf(row: Record<string, unknown> | undefined): bigint | undefined {
  const order = row?.["order"];
  const v = order && typeof order === "object" ? (order as Record<string, unknown>)["remainingSize"] : undefined;
  if (typeof v === "string" && /^[0-9]+$/u.test(v)) return BigInt(v);
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  return undefined;
}

export async function handleRolloverFill(input: PrepareOrdersInput, action: RolloverFillAction, ctx: HandlerContext): Promise<Envelope> {
  const chainId = input.chainId;
  const account = input.account;
  const nowSecs = nowSecondsOf(ctx);
  const warnings: Warning[] = [];
  /** A refusal that carries every disclosure gathered so far (an alias teaching, a transport
   *  note) ahead of the refusing code — `warnings[0]` stays the reason. */
  const refuse = (code: string, message: string): Envelope => envelope({ state: "unavailable", data: null, chainId, source: "config", warnings: [{ code, message }, ...warnings], ctx });
  const { rollover, warning: rolloverWarn } = await resolveRollover(chainId);
  if (rolloverWarn) warnings.push(rolloverWarn);
  if (!rollover) return refuse("unknown_deployment", `no rollover deployment configured for chainId ${chainId} (rollover is live on Arbitrum One and Base — 42161, 8453)`);

  // ── the signed order: inline, or the venue's record by digest ──
  let parsed: ParsedRolloverPayload;
  let venueRow: Record<string, unknown> | undefined;
  let artifactSource: "service" | "config" = "config";
  if (action.signedOrder !== undefined) {
    try {
      parsed = parseRolloverPayload({ order: action.signedOrder.order, intent: action.signedOrder.intent, signature: action.signedOrder.signature, ...(action.signedOrder.envelope ? { envelope: action.signedOrder.envelope } : {}) });
    } catch (err) {
      throw new ToolInputError("cork_prepare_orders", [{ path: ["action", "signedOrder"], message: `the inline rollover payload is malformed: ${firstLine(err)}` }]);
    }
  } else {
    artifactSource = "service";
    let row: Record<string, unknown> | null;
    try {
      row = await getRolloverOrder(venueDepsOf(ctx), action.orderDigest);
    } catch (err) {
      return venueFailed(chainId, err, ctx);
    }
    if (!row) return refuse("order_not_found", `rollover order ${action.orderDigest} is unknown to the venue (a normal outcome for a never-posted digest); pass the signed payload inline via signedOrder if you hold it`);
    const payload = payloadOfVenueRow(row);
    if (!payload || typeof payload["order"] !== "object" || typeof payload["intent"] !== "object") {
      return refuse("invalid_service_response", `the venue's record for ${action.orderDigest} carries no signed payload (order + intent + signature) — nothing to fill from; the row's fields: ${Object.keys(row).join(", ")}`);
    }
    try {
      parsed = parseRolloverPayload(payload as never);
    } catch (err) {
      return refuse("invalid_service_response", `the venue's payload for ${action.orderDigest} failed shape validation: ${firstLine(err)} — no fill bytes are built from a row this tool cannot read`);
    }
    venueRow = row;
  }
  const { order, signature } = parsed;

  // ── [K3] the digest is RECOMPUTED from the payload; the claimed digest must match ──
  if (Number(order.originChainId) !== chainId) {
    return refuse("invalid_order_terms", `the order's originChainId is ${order.originChainId}, not ${chainId} — its digest lives under that chain's settler domain and it cannot be filled here`);
  }
  const localDigest = computeOrderDigest(chainId, order);
  if (localDigest.toLowerCase() !== action.orderDigest.toLowerCase()) {
    return envelope({
      state: "conflict",
      data: { requestedOrderDigest: action.orderDigest, localOrderDigest: localDigest },
      chainId,
      source: artifactSource,
      warnings: [...warnings, { code: "order_hash_mismatch", message: `the signed payload hashes to ${localDigest} under the CorkSettler domain of ${order.settler}, not to the requested ${action.orderDigest} — the record does not describe the order you asked for; no fill bytes` }],
      ctx,
    });
  }
  // The clone checks intent.orderDigest against the real digest on every hook dispatch; a record
  // that carries one must agree, a record without one (the builder's own post) is bound here.
  const intent = parsed.intentDigestGiven ? parsed.intent : { ...parsed.intent, orderDigest: localDigest };
  if (intent.orderDigest.toLowerCase() !== localDigest.toLowerCase()) {
    return envelope({
      state: "conflict",
      data: { orderDigest: localDigest, intentOrderDigest: intent.orderDigest },
      chainId,
      source: artifactSource,
      warnings: [...warnings, { code: "intent_hash_mismatch", message: `the intent names orderDigest ${intent.orderDigest} but the order hashes to ${localDigest} — the clone would refuse the hooks (CorkRolloverContract__OrderDigestMismatch); no fill bytes` }],
      ctx,
    });
  }
  // The venue's own envelope, when served, must be the one the settler re-encodes.
  const gasless = gaslessOrderOf(order);
  const originData = encodeOriginData(gasless);
  if (parsed.venueOriginData !== undefined && parsed.venueOriginData.toLowerCase() !== originData.toLowerCase()) {
    return envelope({
      state: "conflict",
      data: { orderDigest: localDigest, localOriginData: originData, venueOriginData: parsed.venueOriginData },
      chainId,
      source: artifactSource,
      warnings: [...warnings, { code: "venue_digest_mismatch", message: `the venue's originData for ${localDigest} is not abi.encode(GaslessCrossChainOrder) of the payload it serves — the settler compares the envelope byte-for-byte (Settler__OrderIdMismatch); no fill bytes` }],
      ctx,
    });
  }

  // ── settler generation, mode, deadlines, exclusivity ──
  const cls = classifyRolloverSettler(rollover, order.settler);
  if (cls.status === "retired") return refuse("settler_retired", retiredSettlerTeaching(order.settler, cls, rollover));
  if (cls.status === "unknown") {
    return refuse("settler_not_recognized", `settler ${order.settler} is not a configured Cork settler for chainId ${chainId} (active: ${activeSettlersTeaching(rollover, "EXACT")}; ${activeSettlersTeaching(rollover, "PARTIAL")}) — no BaseFiller is known for it, so no fill can be built here`);
  }
  const generation: RolloverGeneration = cls.generation;
  const baseFiller = generation.baseFiller;
  if (!baseFiller) return refuse("unknown_deployment", `the ${generation.label} rollover generation configures no BaseFiller on chainId ${chainId} — the filler entry this tool builds against`);
  if (cls.kind === "EXACT" && order.allowPartialFills) return refuse("settler_mode_mismatch", `the order is bound to the ExactSettler of ${generation.label} but allows partial fills — the settler reverts Settler__PartialFillsNotSupported; this order can never fill`);
  if (cls.kind === "PARTIAL" && !order.allowPartialFills) return refuse("settler_mode_mismatch", `the order is bound to the PartialSettler of ${generation.label} but forbids partial fills — the settler reverts Settler__ExactFillsNotSupported; this order can never fill`);
  if (order.fillDeadline <= nowSecs) return refuse("invalid_order_terms", `the order's fillDeadline ${order.fillDeadline} has passed (now ${nowSecs}) — the settler reverts Settler__FillAfterDeadline`);
  if (order.rolloverParams.settler.toLowerCase() !== order.settler.toLowerCase()) return refuse("invalid_order_terms", `rolloverParams.settler ${order.rolloverParams.settler} differs from the order's settler ${order.settler} — admission reverts Settler__RolloverParamsSettlerMismatch`);
  // LibFillerAuth passes a direct call by exclusiveFiller — but settler.fill's caller is
  // BaseFiller, never the account, so through this path ONLY a reservation for BaseFiller itself
  // is a direct pass; every other reservation (the account's own included) needs the exclusive
  // filler's FillerAuth signature over the account that calls BaseFiller.
  const reserved = !isAddressEqual(order.exclusiveFiller, zeroAddress) && !isAddressEqual(order.exclusiveFiller, baseFiller);
  const authDigest = hashFillerAuth({ chainId, settler: order.settler, orderDigest: localDigest, account });
  let fillerAuth: "not-reserved" | "reserved-for-base-filler" | "eoa-verified" | "erc1271-verified" | "unverified" = isAddressEqual(order.exclusiveFiller, zeroAddress) ? "not-reserved" : "reserved-for-base-filler";
  if (reserved) {
    if (action.fillerAuthSig === undefined) {
      return envelope({
        state: "unavailable",
        data: { orderDigest: localDigest, exclusiveFiller: order.exclusiveFiller, fillSender: account, fillerAuthDigest: authDigest, fillerAuthTypedData: fillerAuthTypedData({ chainId, settler: order.settler, orderDigest: localDigest, account }) },
        chainId,
        source: artifactSource,
        warnings: [...warnings, { code: "private_order", message: `the order reserves its fill for ${order.exclusiveFiller}; settler.fill is called by BaseFiller ${baseFiller}, never by ${account}, so the settler reverts Settler__UnauthorizedFiller unless ${order.exclusiveFiller} signed FillerAuth(orderDigest ${localDigest}, destination = ${account}, subFiller = bytes32(${account})) under the settler's CorkSettler/1.0.0 domain — ${isAddressEqual(order.exclusiveFiller, account) ? "that is YOUR OWN signature (the reservation names you, but the contract sees BaseFiller as the caller)" : "the exclusive filler delegates the fill to you with it"}; sign data.fillerAuthTypedData and pass it as fillerAuthSig` }],
        ctx,
      });
    }
    fillerAuth = "unverified";
  }

  // ── amounts ──
  const venueRemaining = remainingSizeOf(venueRow);
  const fillerSrcCst = action.fillerSrcCst !== undefined ? BigInt(action.fillerSrcCst) : (venueRemaining ?? order.orderSize);
  if (fillerSrcCst === 0n) return refuse("invalid_order_terms", "fillerSrcCst is zero — nothing to roll (Settler__RolloverAmountOutOfBounds)");
  if (fillerSrcCst > order.orderSize) return refuse("invalid_order_terms", `fillerSrcCst ${fillerSrcCst} exceeds the order's size ${order.orderSize} (Settler__RolloverAmountOutOfBounds)`);
  if (cls.kind === "EXACT" && !order.allowUnderfill && fillerSrcCst !== order.orderSize) {
    return refuse("invalid_order_terms", `an ExactSettler order without allowUnderfill fills only at its full size ${order.orderSize}; fillerSrcCst ${fillerSrcCst} reverts Settler__ExactFillRequiresFullOrderSize`);
  }
  const premiumEstimate = requiredPremium(fillerSrcCst, order.minPremiumPerShare);
  const premiumCap = action.premiumCap !== undefined ? BigInt(action.premiumCap) : premiumEstimate;
  const premiumCapEstimated = action.premiumCap === undefined;
  // Notices about the amounts ride the OK artifact only — a refusal or a conflict below is not
  // the place to discuss a cap that will never be charged.
  const amountNotices: Warning[] = [];
  if (premiumCap < premiumEstimate) {
    amountNotices.push({ code: "would_revert", message: `premiumCap ${premiumCap} is below ceil(fillerSrcCst × minPremiumPerShare / 1e18) = ${premiumEstimate}, the premium the settler charges at a 1:1 dst/src mint — the fill reverts Settler__PremiumExceedsCap unless the destination pool mints fewer shares per src share than that` });
  }
  if (action.fillerSrcCst === undefined && venueRemaining === undefined && cls.kind === "PARTIAL") {
    amountNotices.push({ code: "invalid_order_terms", message: `fillerSrcCst defaulted to the ORDER size ${order.orderSize}: ${venueRow ? "the venue row carries no remainingSize" : "the inline path has no remaining-size source"}, and the settler exposes no consumed-size view — on a partially filled PartialSettler order this overfills (Settler__RolloverAmountOutOfBounds / CorkRolloverContract__OverfillCeiling); pass fillerSrcCst = the remaining size` });
  }
  if (premiumCapEstimated) {
    amountNotices.push({ code: "premium_cap_estimated", message: `premiumCap defaulted to ${premiumEstimate} = ceil(fillerSrcCst × minPremiumPerShare / 1e18): exact when the destination pool mints one dst cST per src cST consumed; a destination pool minting MORE shares per collateral charges more (ceil(dstCstProduced × rate / 1e18)) and reverts Settler__PremiumExceedsCap above the cap — simulate, and raise the cap if the simulation names that error; BaseFiller refunds the unspent part either way` });
  }
  const minDstPerSrc = BigInt(action.minDstPerSrc);

  // ── the JIT destination market the order committed to ──
  const committed = order.rolloverParams.jitMarketHash;
  const hasCommitment = committed.toLowerCase() !== zeroHash;
  let jitParams: JitMarketParamsStruct | undefined;
  if (hasCommitment && action.jitMarket === undefined) {
    return refuse("invalid_order_terms", `the order commits to a just-in-time destination market (rolloverParams.jitMarketHash ${committed}) — pass the negotiated jitMarket instruction so the fill runs executeWithMarket; without it the destination pool may not exist and BaseFiller__JitNotConfigured / the settler's DstCstNotCanonical refuses`);
  }
  if (!hasCommitment && action.jitMarket !== undefined) {
    return refuse("invalid_order_terms", "the order commits to NO just-in-time market (jitMarketHash is zero), but a jitMarket instruction was passed — BaseFiller would revert BaseFiller__JitMarketHashMismatch; drop jitMarket (the destination pool must already exist)");
  }
  if (action.jitMarket !== undefined) {
    const jm = action.jitMarket;
    const { extraData: additionalData, oracleSalt: resolvedSalt, saltGiven } = resolveJitBytesInput(jm, undefined, generation.label, { tool: "cork_prepare_orders", path: ["action", "jitMarket"], bytesField: "additionalData" }, warnings);
    const wire = generation.wire;
    if (wire === "rc.1") return refuse("invalid_order_terms", `the ${generation.label} rollover generation (wire rc.1) predates just-in-time markets — this order's commitment cannot be executed there`);
    jitParams = {
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
      ...(saltGiven ? { oracleSalt: resolvedSalt } : wire === "0.2" ? { oracleSalt: zeroHash } : {}),
      swapFeePercentage: BigInt(jm.swapFeePercentage),
      unwindSwapFeePercentage: BigInt(jm.unwindSwapFeePercentage),
    };
    let localHash: `0x${string}`;
    try {
      localHash = hashJitMarketParams(jitParams, wire);
    } catch (err) {
      if (err instanceof RolloverJitWireError) return refuse("invalid_order_terms", `${err.message} (settler ${order.settler} belongs to the ${generation.label} generation, wire ${wire})`);
      throw err;
    }
    if (localHash.toLowerCase() !== committed.toLowerCase()) {
      return envelope({
        state: "conflict",
        data: { orderDigest: localDigest, committedJitMarketHash: committed, localJitMarketHash: localHash, jitMarketWire: wire },
        chainId,
        source: artifactSource,
        warnings: [...warnings, { code: "jit_market_hash_mismatch", message: `the jitMarket instruction hashes to ${localHash} on the ${generation.label} generation's ${wire} wire, but the order commits to ${committed} — BaseFiller reverts BaseFiller__JitMarketHashMismatch; the holder signed a different instruction (fees, constraint, recipe, salt or expiry differ). No fill bytes` }],
        ctx,
      });
    }
  }

  // ── chain pre-flights (best-effort; a transport failure discloses, never refuses) ──
  const resolved = await getRpc(ctx, chainId);
  let chainStatus: string | null = null;
  let cloneOk: boolean | null = null;
  let approvals: ApprovalRequirement[] = [
    { role: "taker", stage: "before-fill", holder: account, token: order.srcCstToken, tokenRole: "src cST (the source pool's cover you roll)", spender: baseFiller, spenderRole: "Cork BaseFiller", mechanism: "erc20-approve", amount: fillerSrcCst.toString(), kind: "exact", wallets: "eoa+contract", note: "BaseFiller pulls exactly fillerSrcCst from you, forwards it to the settler, and refunds any part the clone does not consume", unsignedTx: erc20ApproveTx(order.srcCstToken, baseFiller, fillerSrcCst) },
    { role: "taker", stage: "before-fill", holder: account, token: order.premiumToken, tokenRole: "premium token", spender: baseFiller, spenderRole: "Cork BaseFiller", mechanism: "erc20-approve", amount: premiumCap.toString(), kind: "cap", wallets: "eoa+contract", note: "BaseFiller pulls the whole premiumCap, pays the settler exactly ceil(dstCstProduced × minPremiumPerShare / 1e18), and refunds the rest to you in the same transaction", unsignedTx: erc20ApproveTx(order.premiumToken, baseFiller, premiumCap) },
  ];
  const balances: { srcCst?: string; premiumToken?: string } = {};
  // The HOLDER's signature over the order digest, verified the way the settler verifies it
  // (SignatureChecker.isValidSignatureNow(order.user, digest, sig)): ecrecover first, the
  // holder's own isValidSignature when it has code. A refuted signature builds no bytes — the
  // settler reverts on it, as cork_submit and the LOP taker-fill already refuse. A holder nobody
  // could ask (no RPC, a failed read) rides unverified and says so; an outage is not a verdict.
  let holderSignature: "eoa-verified" | "erc1271-verified" | "unverified" = "unverified";
  {
    const refuted = (why: string, source: "config" | "chain", extra: Record<string, unknown> = {}) =>
      envelope({
        state: "conflict",
        data: { orderDigest: localDigest, holder: order.user, ...extra },
        chainId,
        source,
        warnings: [...(resolved ? rpcWarn(resolved) : []), ...warnings, { code: "signature_or_reconstruction_mismatch", message: `the holder's signature does not verify for ${order.user} over the order digest ${localDigest}: ${why}. The settler checks exactly this (SignatureChecker) and reverts, so no fill bytes are built. Take the signed payload from the venue row or from the holder again` }],
        ...(resolved ? rpcProvenance(input.format, resolved) : {}),
        ctx,
      });
    const eoa = await recoverEoaSigner(localDigest, signature);
    const recovered = eoa.signer !== null ? `ecrecover yields ${eoa.signer}` : "the bytes do not recover to any signer";
    if (eoa.signer !== null && isAddressEqual(eoa.signer, order.user)) holderSignature = "eoa-verified";
    else if (!resolved) warnings.push({ code: "funding_needs_rpc", message: `the holder's signature does not ecrecover to ${order.user} (${recovered}) and no RPC resolved to ask a contract holder's isValidSignature — it rides unverified: the settler reverts on a signature the holder did not give` });
    else {
      const code = await probeMakerCode(resolved.client, order.user);
      if (code === "no-code") return refuted(`${order.user} is not a contract account, and ${recovered}`, "chain", eoa.signer !== null ? { recoveredSigner: eoa.signer } : {});
      if (code === "has-code") {
        const v = await checkContractMakerSignature(resolved.client, { maker: order.user, orderHash: localDigest, signature });
        if (v.kind === "erc1271") holderSignature = "erc1271-verified";
        else if (v.kind === "erc1271_rejected") return refuted("the holder is a contract account and its isValidSignature did not answer the ERC-1271 magic value", "chain");
        else warnings.push({ code: "chain_read_failed", message: `the holder ${order.user} is a contract account and its isValidSignature could not be asked (${v.reason}) — the signature rides unverified` });
      } else warnings.push({ code: "chain_read_failed", message: `the holder's signature does not ecrecover to ${order.user} (${recovered}) and the holder's code could not be read — whether a contract holder's isValidSignature accepts it is unknown; it rides unverified` });
    }
  }
  // The filler authorization, verified the way the settler verifies it (SignatureChecker):
  // ecrecover first (chain-free), the exclusive filler's own isValidSignature when it has code.
  if (reserved && action.fillerAuthSig !== undefined) {
    const eoa = await recoverEoaSigner(authDigest, action.fillerAuthSig);
    if (eoa.signer !== null && isAddressEqual(eoa.signer, order.exclusiveFiller)) fillerAuth = "eoa-verified";
    else if (resolved) {
      const v = await checkContractMakerSignature(resolved.client, { maker: order.exclusiveFiller, orderHash: authDigest, signature: action.fillerAuthSig });
      if (v.kind === "erc1271") fillerAuth = "erc1271-verified";
      else if (v.kind === "erc1271_rejected") {
        return envelope({
          state: "conflict",
          data: { orderDigest: localDigest, exclusiveFiller: order.exclusiveFiller, fillSender: account, fillerAuthDigest: authDigest, ...(eoa.signer !== null ? { recoveredSigner: eoa.signer } : {}) },
          chainId,
          source: "chain",
          warnings: [...rpcWarn(resolved), ...warnings, { code: "signature_or_reconstruction_mismatch", message: `fillerAuthSig does not verify for ${order.exclusiveFiller} over FillerAuth(${localDigest}, destination ${account}, subFiller bytes32(${account})) under the settler's domain — ${eoa.signer !== null ? `ecrecover yields ${eoa.signer}` : "the bytes are not an ECDSA signature"} and the filler's isValidSignature rejects it; the settler reverts Settler__UnauthorizedFiller. No fill bytes` }],
          ...rpcProvenance(input.format, resolved),
          ctx,
        });
      } else warnings.push({ code: "chain_read_failed", message: `the exclusive filler's isValidSignature could not be asked (${v.reason}) and ecrecover does not yield ${order.exclusiveFiller}${eoa.signer !== null ? ` (it yields ${eoa.signer})` : ""} — fillerAuthSig rides UNVERIFIED; simulate before signing` });
    } else warnings.push({ code: "funding_needs_rpc", message: `fillerAuthSig does not ecrecover to ${order.exclusiveFiller}${eoa.signer !== null ? ` (it yields ${eoa.signer})` : ""} and no RPC resolved to ask a contract filler's isValidSignature — it rides UNVERIFIED; the settler reverts Settler__UnauthorizedFiller if it is wrong` });
  }
  if (!resolved && order.openDeadline <= nowSecs) {
    warnings.push({ code: "would_revert", message: `the order's openDeadline ${order.openDeadline} has passed (now ${nowSecs}) and no RPC resolved to read whether the settler already opened it — if it is still None, BaseFiller's openFor reverts Settler__OpenAfterOpenDeadline` });
  }
  if (resolved) {
    try {
      const [status, clone, srcBal, premBal] = await Promise.all([
        resolved.client.readContract({ address: order.settler, abi: settlerStatusAbi, functionName: "orderStatus", args: [localDigest], ...(ctx.atBlock !== undefined ? { blockNumber: ctx.atBlock } : {}) }),
        resolved.client.readContract({ address: generation.factory as `0x${string}`, abi: rolloverFactoryAbi, functionName: "rolloverContractOf", args: [order.user], ...(ctx.atBlock !== undefined ? { blockNumber: ctx.atBlock } : {}) }),
        resolved.client.readContract({ address: order.srcCstToken, abi: erc20Abi, functionName: "balanceOf", args: [account], ...(ctx.atBlock !== undefined ? { blockNumber: ctx.atBlock } : {}) }),
        resolved.client.readContract({ address: order.premiumToken, abi: erc20Abi, functionName: "balanceOf", args: [account], ...(ctx.atBlock !== undefined ? { blockNumber: ctx.atBlock } : {}) }),
      ]);
      chainStatus = chainStatusName(status as bigint | number);
      cloneOk = (clone as string).toLowerCase() === order.rolloverContract.toLowerCase();
      balances.srcCst = String(srcBal);
      balances.premiumToken = String(premBal);
    } catch (err) {
      if (!isTransportFailure(err)) return chainReadFailed(chainId, err, [...rpcWarn(resolved), ...warnings], ctx, resolved);
      warnings.push({ code: "chain_read_failed", message: `the settler status / clone / balance reads failed in transport (${revertReason(err)}) — the fill is built unverified; simulate before signing` });
    }
    if (chainStatus !== null && TERMINAL.has(chainStatus)) {
      return envelope({
        state: "conflict",
        data: { orderDigest: localDigest, chainStatus },
        chainId,
        source: "chain",
        warnings: [...rpcWarn(resolved), ...warnings, { code: "status_mismatch", message: `the settler ${order.settler} reports order ${localDigest} as ${chainStatus} — it cannot be filled (Settler__OrderInTerminalState); the venue's row is stale` }],
        ...rpcProvenance(input.format, resolved),
        ctx,
      });
    }
    if (chainStatus === "None" && order.openDeadline <= nowSecs) {
      return refuse("invalid_order_terms", `the order is not yet opened on the settler and its openDeadline ${order.openDeadline} has passed (now ${nowSecs}) — BaseFiller's openFor reverts Settler__OpenAfterOpenDeadline`);
    }
    if (cloneOk === false) {
      return refuse("invalid_order_terms", `the order names rolloverContract ${order.rolloverContract}, but the ${generation.label} factory's clone for user ${order.user} is a different address — admission reverts Settler__RolloverContractNotDeployed / Settler__UserNotRolloverContractOwner`);
    }
    approvals = await annotateApprovalStatus(resolved.client, { entries: approvals, nowSeconds: nowSecs, ...(ctx.atBlock !== undefined ? { atBlock: ctx.atBlock } : {}) });
    warnings.push(...amountNotices);
    if (balances.srcCst !== undefined && BigInt(balances.srcCst) < fillerSrcCst) warnings.push({ code: "would_revert", message: `you hold ${balances.srcCst} of the src cST ${order.srcCstToken} but the fill pulls ${fillerSrcCst} — BaseFiller's transferFrom reverts; you need the SOURCE pool's cST (the cover being rolled), not the destination's` });
    if (balances.premiumToken !== undefined && BigInt(balances.premiumToken) < premiumCap) warnings.push({ code: "would_revert", message: `you hold ${balances.premiumToken} of the premium token ${order.premiumToken} but the fill pulls the whole cap ${premiumCap} up front (the surplus comes back in the same tx) — BaseFiller's transferFrom reverts` });
  } else {
    warnings.push(...amountNotices, { code: "funding_needs_rpc", message: "no RPC resolved — the settler status, the clone ownership, your balances and allowances were NOT read; the fill is built from the signed payload alone. Simulate and check the two BaseFiller allowances before signing" });
  }
  const approvalWarn = approvalMissingWarning(approvals, "before broadcasting this fill");
  if (approvalWarn) warnings.push(approvalWarn);

  // ── the bytes ──
  const jobArgs = { order, intent, userSig: signature, fillerSrcCst, premiumCap, minDstPerSrc, fillerAuthSig: action.fillerAuthSig ?? "0x" } as const;
  let calldata: `0x${string}`;
  try {
    calldata = jitParams !== undefined ? encodeBaseFillerExecuteWithMarket(jobArgs, jitParams, generation.wire as "rc.2" | "0.2") : encodeBaseFillerExecute(jobArgs);
  } catch (err) {
    return refuse("invalid_order_terms", firstLine(err));
  }
  const hooks = { pre: intent.preRolloverHooks.length, mid: intent.midRolloverHooks.length, post: intent.postRolloverHooks.length, premiumPhase: intent.premiumHooks.length };
  return envelope({
    state: "ok",
    data: {
      kind: "rollover-fill",
      to: baseFiller,
      calldata,
      value: "0",
      fillFunction: jitParams !== undefined ? "executeWithMarket" : "execute",
      orderDigest: localDigest,
      settler: order.settler,
      settlerKind: cls.kind,
      settlerGeneration: generation.label,
      jitMarketWire: generation.wire,
      user: order.user,
      rolloverContract: order.rolloverContract,
      srcCstToken: order.srcCstToken,
      dstCstToken: order.dstCstToken,
      premiumToken: order.premiumToken,
      srcPoolId: order.rolloverParams.srcPoolId,
      dstPoolId: order.rolloverParams.dstPoolId,
      orderSize: order.orderSize.toString(),
      fillerSrcCst: fillerSrcCst.toString(),
      minPremiumPerShare: order.minPremiumPerShare.toString(),
      premiumCap: premiumCap.toString(),
      premiumCapEstimated,
      premiumAtOneToOne: premiumEstimate.toString(),
      minDstPerSrc: minDstPerSrc.toString(),
      destination: account,
      openDeadline: order.openDeadline.toString(),
      fillDeadline: order.fillDeadline.toString(),
      exclusiveFiller: isAddressEqual(order.exclusiveFiller, zeroAddress) ? null : order.exclusiveFiller,
      fillerAuth,
      holderSignature,
      intentHooks: hooks,
      originData,
      chainStatus,
      cloneVerified: cloneOk,
      ...(balances.srcCst !== undefined ? { balances } : {}),
      approvals,
      scales: {
        fillerSrcCst: "src cST shares, 18 decimals",
        orderSize: "src cST shares, 18 decimals",
        premiumCap: "base units of premiumToken (its own decimals)",
        premiumAtOneToOne: "base units of premiumToken (its own decimals)",
        minPremiumPerShare: "premiumToken base units per 1e18 dst cST shares",
        minDstPerSrc: "1e18 = 1.0 (WAD)",
        approvalsAmount: "approvals[].amount is base units of that entry's own token",
        unitsTopic: UNITS_TOPIC_REFERENCE,
      },
      simulationRequired: true,
      execution: executionEthTransaction(),
      clientRequestId: input.clientRequestId,
    },
    chainId,
    source: artifactSource,
    warnings: [...(resolved ? rpcWarn(resolved) : []), ...warnings, { code: "unsigned_artifact", message: `unsigned BaseFiller.${jitParams !== undefined ? "executeWithMarket" : "execute"} calldata only — simulate it (cork_track simulate with to/calldata/account) and grant the two allowances in data.approvals to BaseFiller ${baseFiller} before signing; the dst cST is delivered to the sender (${account})` }],
    ...(resolved ? rpcProvenance(input.format, resolved) : {}),
    ctx,
  });
}

export async function handleDeployRolloverContract(input: PrepareOrdersInput, action: DeployCloneAction, ctx: HandlerContext): Promise<Envelope> {
  const chainId = input.chainId;
  const owner = action.owner ?? input.account;
  const warnings: Warning[] = [];
  const { rollover, generation: gen, warning: rolloverWarn } = await resolveRollover(chainId, undefined, ctx.generation);
  if (rolloverWarn) warnings.push(rolloverWarn);
  if (!rollover) return unavailable(chainId, "unknown_deployment", `no rollover deployment configured for chainId ${chainId} (rollover is live on Arbitrum One and Base — 42161, 8453)`, ctx);
  // A retired rollover block (a `retired` date) still resolves — for history reads — but its
  // factory's clones serve no admissible settler.
  if (gen !== undefined && rollover.generations?.some((g) => g.label === gen.label && g.retired !== undefined)) {
    return unavailable(chainId, "settler_retired", `the selected rollover generation ${gen.label} is retired — its factory's clones serve no admissible settler; select an active generation`, ctx);
  }
  const factory = rollover.factory as `0x${string}`;
  const calldata = encodeDeployRolloverContract();
  const resolved = await getRpc(ctx, chainId);
  let predicted: string | null = null;
  let existing: string | null = null;
  if (resolved) {
    try {
      const [p, e] = await Promise.all([
        resolved.client.readContract({ address: factory, abi: rolloverFactoryAbi, functionName: "predictRolloverContractOf", args: [owner] }),
        resolved.client.readContract({ address: factory, abi: rolloverFactoryAbi, functionName: "rolloverContractOf", args: [owner] }),
      ]);
      predicted = p as string;
      existing = (e as string).toLowerCase() === zeroAddress ? null : (e as string);
    } catch (err) {
      if (!isTransportFailure(err)) return chainReadFailed(chainId, err, [...rpcWarn(resolved), ...warnings], ctx, resolved);
      warnings.push({ code: "chain_read_failed", message: `the factory's predict/lookup reads failed in transport (${revertReason(err)}) — the deploy is built unverified` });
    }
  } else {
    warnings.push({ code: "funding_needs_rpc", message: "no RPC resolved — the predicted clone address and whether one already exists were NOT read" });
  }
  if (existing !== null) {
    warnings.push({ code: "rollover_contract_exists", message: `${owner} already owns the rollover clone ${existing} on the ${gen?.label ?? "selected"} generation's factory — sending this transaction reverts CorkRolloverContractFactory__AlreadyDeployed; name ${existing} as rolloverContract in the roll order instead` });
  }
  if (action.owner !== undefined && !isAddressEqual(action.owner, input.account)) {
    warnings.push({ code: "invalid_order_terms", message: `owner ${action.owner} differs from account ${input.account}: the factory deploys for msg.sender ONLY, so this transaction must be signed and sent by ${action.owner}` });
  }
  return envelope({
    state: "ok",
    data: {
      kind: "deploy-rollover-contract",
      to: factory,
      calldata,
      value: "0",
      owner,
      ...(gen ? { generation: { label: gen.label, status: gen.status }, rolloverGeneration: gen.label, wire: gen.wire } : {}),
      predictedRolloverContract: predicted,
      existingRolloverContract: existing,
      simulationRequired: true,
      execution: executionEthTransaction(),
      clientRequestId: input.clientRequestId,
    },
    chainId,
    source: resolved ? "chain" : "config",
    warnings: [...(resolved ? rpcWarn(resolved) : []), ...warnings, { code: "unsigned_artifact", message: `unsigned CorkRolloverContractFactory.deployRolloverContract() calldata — the clone belongs to msg.sender, so ${owner} must send it; the roll order's rolloverContract must then name the deployed address` }],
    ...(resolved ? rpcProvenance(input.format, resolved) : {}),
    ctx,
  });
}

export type { ChainId };
