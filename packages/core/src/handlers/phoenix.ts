// Split from handlers.ts (2026-08-05): phoenix handlers — one typed dispatch, per-tool modules.
// Declarations are moved byte-identically; see handlers.ts for the runTool dispatch.
import { Envelope, executionEthTransaction, type PhoenixAction, PreparePhoenixInput } from "@cork/schemas";
import { corkActionCall } from "../bundle/actions.ts";
import { type Call } from "../bundle/bundler3.ts";
import { type AuthorityAction, buildAuthorityTx, spenderRoleOf } from "../bundle/authority.ts";
import { type CorkDeployment } from "../config.ts";
import { encodeMulticall } from "../bundle/bundler3.ts";
import { decodeBundle } from "../bundle/decode.ts";
import { summarizeBundle } from "../bundle/summary.ts";
import { canAutoFund, fundingPlan } from "../bundle/funding.ts";
import { poolPreflightWarnings } from "../bundle/preflight.ts";
import { approvedImplementationGuard, PHOENIX_IMPLEMENTATION_ROLES } from "../implementations.ts";
import { resolvePoolTokens } from "../chain/reads.ts";
import { chainReadFailed, envelope, getDep, getRpc, type HandlerContext, nowSecondsOf, PERMIT2_ADDRESS, poolMissing, poolNotFound, resolveDeadline, rpcProvenance, rpcWarn, unavailable } from "./shared.ts";
import { preparePhoenixForSelf } from "./forself.ts";


// PhoenixAction.type -> CorkAdapter action name.
export const ACTION_MAP = {
  mint: "safeMint",
  deposit: "safeDeposit",
  "unwind-deposit": "safeUnwindDeposit",
  "unwind-mint": "safeUnwindMint",
  withdraw: "safeWithdraw",
  "withdraw-other": "safeWithdrawOther",
  redeem: "safeRedeem",
  swap: "safeSwap",
  exercise: "safeExercise",
  "exercise-other": "safeExerciseOther",
  "unwind-swap": "safeUnwindSwap",
  "unwind-exercise": "safeUnwindExercise",
  "unwind-exercise-other": "safeUnwindExerciseOther",
} as const;

export function buildPhoenixCall(
  action: PhoenixAction,
  adapter: `0x${string}`,
  deadline: bigint,
): Call {
  const b = (v: string) => BigInt(v);
  const p = action;
  switch (p.type) {
    case "mint":
      return corkActionCall(adapter, "safeMint", { poolId: p.poolId, cptAndCstSharesOut: b(p.cptAndCstSharesOut), receiver: p.receiver, maxCollateralAssetsIn: b(p.maxCollateralAssetsIn), deadline });
    case "deposit":
      return corkActionCall(adapter, "safeDeposit", { poolId: p.poolId, collateralAssetsIn: b(p.collateralAssetsIn), receiver: p.receiver, minCptAndCstSharesOut: b(p.minCptAndCstSharesOut), deadline });
    case "unwind-deposit":
      return corkActionCall(adapter, "safeUnwindDeposit", { poolId: p.poolId, collateralAssetsOut: b(p.collateralAssetsOut), owner: p.owner, receiver: p.receiver, maxCptAndCstSharesIn: b(p.maxCptAndCstSharesIn), deadline });
    case "unwind-mint":
      return corkActionCall(adapter, "safeUnwindMint", { poolId: p.poolId, cptAndCstSharesIn: b(p.cptAndCstSharesIn), owner: p.owner, receiver: p.receiver, minCollateralAssetsOut: b(p.minCollateralAssetsOut), deadline });
    case "withdraw":
      return corkActionCall(adapter, "safeWithdraw", { poolId: p.poolId, collateralAssetsOut: b(p.collateralAssetsOut), owner: p.owner, receiver: p.receiver, maxCptSharesIn: b(p.maxCptSharesIn), deadline });
    case "withdraw-other":
      return corkActionCall(adapter, "safeWithdrawOther", { poolId: p.poolId, referenceAssetsOut: b(p.referenceAssetsOut), owner: p.owner, receiver: p.receiver, maxCptSharesIn: b(p.maxCptSharesIn), deadline });
    case "redeem":
      return corkActionCall(adapter, "safeRedeem", { poolId: p.poolId, cptSharesIn: b(p.cptSharesIn), owner: p.owner, receiver: p.receiver, minReferenceAssetsOut: b(p.minReferenceAssetsOut), minCollateralAssetsOut: b(p.minCollateralAssetsOut), deadline });
    case "swap":
      return corkActionCall(adapter, "safeSwap", { poolId: p.poolId, collateralAssetsOut: b(p.collateralAssetsOut), receiver: p.receiver, maxCstSharesIn: b(p.maxCstSharesIn), maxReferenceAssetsIn: b(p.maxReferenceAssetsIn), deadline });
    case "exercise":
      return corkActionCall(adapter, "safeExercise", { poolId: p.poolId, cstSharesIn: b(p.cstSharesIn), receiver: p.receiver, minCollateralAssetsOut: b(p.minCollateralAssetsOut), maxReferenceAssetsIn: b(p.maxReferenceAssetsIn), deadline });
    case "exercise-other":
      return corkActionCall(adapter, "safeExerciseOther", { poolId: p.poolId, referenceAssetsIn: b(p.referenceAssetsIn), receiver: p.receiver, minCollateralAssetsOut: b(p.minCollateralAssetsOut), maxCstSharesIn: b(p.maxCstSharesIn), deadline });
    case "unwind-swap":
      return corkActionCall(adapter, "safeUnwindSwap", { poolId: p.poolId, collateralAssetsIn: b(p.collateralAssetsIn), receiver: p.receiver, minReferenceAssetsOut: b(p.minReferenceAssetsOut), minCstSharesOut: b(p.minCstSharesOut), deadline });
    case "unwind-exercise":
      return corkActionCall(adapter, "safeUnwindExercise", { poolId: p.poolId, cstSharesOut: b(p.cstSharesOut), receiver: p.receiver, minReferenceAssetsOut: b(p.minReferenceAssetsOut), maxCollateralAssetsIn: b(p.maxCollateralAssetsIn), deadline });
    case "unwind-exercise-other":
      return corkActionCall(adapter, "safeUnwindExerciseOther", { poolId: p.poolId, referenceAssetsOut: b(p.referenceAssetsOut), receiver: p.receiver, minCstSharesOut: b(p.minCstSharesOut), maxCollateralAssetsIn: b(p.maxCollateralAssetsIn), deadline });
    default:
      throw new Error(`unknown phoenix action type: ${(p as { type: string }).type}`);
  }
}

/** cork_prepare_phoenix authority-onboard / authority-revoke: byte-building lives in
 *  bundle/authority.ts; this wraps it in the envelope with the spender-role disclosure. */
export function handlePhoenixAuthority(input: PreparePhoenixInput, depWarn: Array<{ code: string; message: string }>, dep: CorkDeployment, ctx: HandlerContext): Envelope {
  const a = input.action as AuthorityAction;
  const tx = buildAuthorityTx(a);
  return envelope({
    state: "ok",
    data: {
      kind: a.type,
      to: tx.to,
      calldata: tx.calldata,
      value: "0",
      token: a.token,
      spender: a.spender,
      amount: tx.amount,
      unlimited: tx.unlimited,
      scale: "amount is base units of `token` (its own decimals); the uint256 max sentinel = unlimited",
      spenderRole: spenderRoleOf(a.spender, dep.corkAdapter, PERMIT2_ADDRESS),
      note: "a direct tx from the token owner (an ERC-20 allowance is keyed to msg.sender, so this cannot ride inside a Bundler3 bundle); current allowances are readable via cork_query account-state",
      execution: executionEthTransaction(),
      clientRequestId: input.clientRequestId,
    },
    chainId: input.chainId,
    source: "config",
    warnings: depWarn,
    ctx,
  });
}

/**
 * cork_prepare_phoenix — bundle assembly: funding legs, action leg, sweep-back, pre-flights.
 *
 * Every pool-action bundle is ATOMIC: the initiator's pull legs, the Cork action, and the
 * sweep-back of any capped residual ride one multicall. The action is never emitted on its own
 * (audit ARTIFACT-PREFUND-001): an action-only bundle only works against tokens parked on the
 * shared adapter beforehand, and that balance is takeable by anyone through the public
 * `Bundler3.multicall` + the adapter's receiver-unchecked `erc20Transfer` until the action lands.
 *
 * Building the pull legs needs the pool's token addresses, read from the pool manager over
 * whatever RPC resolves (explicit → committed default → chainlist), the same ladder every other
 * chain read uses. Only a chain with NO reachable endpoint refuses (`requires_rpc`).
 */
export async function handlePreparePhoenix(input: PreparePhoenixInput, ctx: HandlerContext): Promise<Envelope> {
  // ForSelf mode: the action as a DIRECT call to an integrator-deployed ForSelf adapter —
  // no Bundler3, no funding/sweep legs (the adapter pulls and sweeps itself).
  if (input.forSelf) {
    return preparePhoenixForSelf(input, ctx);
  }
  const { dep, depWarn } = await getDep(ctx, input.chainId);
  if (!dep) return unavailable(input.chainId, "unknown_deployment", `no known Cork deployment for chainId ${input.chainId}`, ctx);
  const { corkAdapter, bundler3 } = dep;
  if (!corkAdapter || !bundler3) {
    return unavailable(input.chainId, "unknown_deployment", `tx-path contracts (corkAdapter/bundler3) are not configured for chainId ${input.chainId} (partial deployment — read tools still work); pass ctx.deployment to override`, ctx);
  }
  const nowSecs = nowSecondsOf(ctx);
  const { deadline, warning: deadlineWarning } = resolveDeadline(input, nowSecs, "the bundle would revert its deadline check on-chain");
  if (input.action.type === "authority-onboard" || input.action.type === "authority-revoke") {
    return handlePhoenixAuthority(input, depWarn, dep, ctx);
  }
  const actionLeg = buildPhoenixCall(input.action, corkAdapter, deadline);
  const warnings: Array<{ code: string; message: string }> = [...depWarn];
  if (deadlineWarning) warnings.push(deadlineWarning);
  // Every schema-admitted pool action has a funding model; this guards the SDK caller who casts.
  if (!canAutoFund(input.action.type)) {
    return unavailable(input.chainId, "invalid_state", `'${input.action.type}' has no funding model, so no atomic bundle can be built for it — the action is never emitted on its own`, ctx);
  }
  const mode = input.fundingMode;
  const poolId = input.action.poolId;

  // The pool read is what makes the funding legs possible: token addresses come from the pool
  // manager, over the resolved endpoint. Every failure maps to an envelope, never a raw throw
  // (viem errors embed the RPC URL).
  const resolved = await getRpc(ctx, input.chainId);
  if (!resolved) {
    return unavailable(
      input.chainId,
      "requires_rpc",
      `no RPC endpoint resolved for chainId ${input.chainId}, and the funding legs need the pool's token addresses (poolManager.market/shares) — set CORK_RPC_URL. The action is deliberately NOT emitted on its own: an action-only bundle only works against tokens parked on the shared adapter beforehand, where anyone can take them`,
      ctx,
    );
  }
  let tokens;
  try {
    tokens = await resolvePoolTokens(resolved.client, dep.poolManager, poolId, ctx.atBlock);
  } catch (err) {
    return chainReadFailed(input.chainId, err, [], ctx, resolved);
  }
  // Refuse to build funding legs against the zero address instead of emitting a
  // plausible-looking bundle that can only revert on-chain.
  if (poolMissing(tokens)) return poolNotFound(input.chainId, poolId, ctx);
  // The bundle summary names tokens by their pool role rather than by bare address.
  const tokenRoles: Record<string, string> = {
    [tokens.collateral.toLowerCase()]: "collateral",
    [tokens.reference.toLowerCase()]: "reference",
    [tokens.cst.toLowerCase()]: "cST",
    [tokens.cpt.toLowerCase()]: "cPT",
  };
  // Pre-flight guards [§5.4]: expiry, pause (global + per-pool bit), and whitelist. All
  // build-and-warn — a bundle that can only revert is still returned, clearly labelled.
  warnings.push(
    ...(await poolPreflightWarnings({
      client: resolved.client,
      poolManager: dep.poolManager,
      whitelistManager: dep.whitelistManager,
      corkAdapter,
      poolId,
      actionType: input.action.type,
      account: input.account,
      expiryTimestamp: tokens.expiryTimestamp,
      nowSeconds: nowSecs,
      atBlock: ctx.atBlock,
    })),
    // Interface-first guard, same posture, scoped to the contracts this bundle executes: warn
    // when a trusted role's live code is off the allowlist bundled into this build (a proxy
    // upgrade nobody admitted yet, or an address that moved ahead of a release).
    ...(await approvedImplementationGuard(resolved.client, input.chainId, { roles: PHOENIX_IMPLEMENTATION_ROLES, ...(ctx.atBlock !== undefined ? { atBlock: ctx.atBlock } : {}) })),
  );
  // Sweep-back [F13]: auto-funding moves the caller's slippage CAP into the adapter, but the
  // pool consumes only the true amount. The delta is not just stranded — CoreAdapter's
  // erc20Transfer never checks receiver==initiator() and Bundler3.multicall is public, so
  // anyone can take it in a later block. Return it to the declared initiator in-bundle.
  const plan = fundingPlan(input.action, tokens, corkAdapter, mode, input.account);
  if (plan.refusal) {
    return envelope({
      state: "unavailable",
      data: null,
      chainId: input.chainId,
      source: "chain",
      warnings: [...rpcWarn(resolved), ...warnings, { code: "unsafe_shared_balance", message: `${plan.refusal}; no signable bytes were emitted` }],
      ...rpcProvenance(input.format, resolved),
      ctx,
    });
  }
  const funding = plan.legs;
  const sweepBack = plan.sweepLegs;
  if (plan.note) warnings.push({ code: "owner_managed_funding", message: plan.note });
  if (sweepBack.length) {
    warnings.push({
      code: "sweep_back",
      message: `this bundle ends with ${sweepBack.length} sweep-back leg(s) returning any unspent balance of ${plan.sweptTokens.join(", ")} to ${input.account}, because auto-funding moved a slippage CAP (not the exact amount) into the adapter. Each sweeps the adapter's FULL balance of that token (uint256.max sentinel), so it also returns any residual an earlier bundle abandoned there — that balance was already takeable by anyone. A zero residual is a no-op, not a revert.`,
    });
  }

  const bundle = [...funding, actionLeg, ...sweepBack];
  const multicall = encodeMulticall(bundle);
  // What the caller is about to sign, in words. Token roles come from the pool read, so amounts
  // are attributed to "collateral"/"cST" rather than bare addresses; the decoder is handed the
  // same targets the bundle was built against, so every leg labels as trusted.
  const summary = summarizeBundle(
    decodeBundle(multicall, { bundler3, corkAdapter, erc20: [tokens.collateral, tokens.reference, tokens.cst, tokens.cpt] }),
    { tokenRoles, account: input.account, adapter: corkAdapter },
  );
  return envelope({
    state: "ok",
    data: { bundler3, corkAdapter, deadline, action: ACTION_MAP[input.action.type], fundingMode: mode, fundingLegs: funding.length, sweepBackLegs: sweepBack.length, summary, bundle, multicall, execution: executionEthTransaction(), clientRequestId: input.clientRequestId },
    chainId: input.chainId,
    source: "chain",
    warnings: [...rpcWarn(resolved), ...warnings],
    ...rpcProvenance(input.format, resolved),
    ctx,
  });
}
