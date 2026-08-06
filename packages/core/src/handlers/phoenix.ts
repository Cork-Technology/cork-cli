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
import { canAutoFund, type FundingMode, fundingPlan } from "../bundle/funding.ts";
import { poolPreflightWarnings } from "../bundle/preflight.ts";
import { resolvePoolTokens } from "../chain/reads.ts";
import { chainReadFailed, envelope, getDep, getRpc, type HandlerContext, nowSecondsOf, unavailable } from "./shared.ts";
import { PERMIT2_ADDRESS } from "./submit.ts";
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

/** cork_prepare_phoenix — bundle assembly: funding legs, action leg, sweep-back, pre-flights. */
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
  // deadlineAt (absolute) pins the bundle bytes across retries [K2]; deadlineSeconds
  // (relative, default) re-anchors to the clock on each call.
  const deadline = input.deadlineAt !== undefined ? BigInt(input.deadlineAt) : nowSecs + BigInt(input.deadlineSeconds);
  if (input.action.type === "authority-onboard" || input.action.type === "authority-revoke") {
    return handlePhoenixAuthority(input, depWarn, dep, ctx);
  }
  const actionLeg = buildPhoenixCall(input.action, corkAdapter, deadline);
  const warnings: Array<{ code: string; message: string }> = [...depWarn];
  // deadlineAt is validated for FORMAT only by the schema; a past moment builds fine and can
  // only revert on-chain — disclose it (the sibling deadlineSeconds is bounded-future) [F19].
  if (input.deadlineAt !== undefined && deadline <= nowSecs) {
    warnings.push({ code: "would_revert", message: `deadlineAt ${deadline} is not in the future (now ${nowSecs}) — the bundle would revert its deadline check on-chain; pin a future absolute deadline for byte-stable retries` });
  }
  let funding: Call[] = [];
  let sweepBack: Call[] = [];
  // Filled in whenever we read the pool, so the bundle summary can name tokens by their role.
  let tokenRoles: Record<string, string> | undefined;
  const roleMapOf = (t: { collateral: string; reference: string; cst: string; cpt: string }): Record<string, string> => ({
    [t.collateral.toLowerCase()]: "collateral",
    [t.reference.toLowerCase()]: "reference",
    [t.cst.toLowerCase()]: "cST",
    [t.cpt.toLowerCase()]: "cPT",
  });
  const mode = input.fundingMode as FundingMode;

  if (mode === "pre-funded") {
    // Caller guarantees tokens already sit in the adapter — nothing to fund. But when an
    // explicit RPC is configured, run the same pool-existence/expiry pre-flight the funded
    // path gets [F19]: 'pre-funded' must not silently skip guards the sibling mode enforces.
    const poolId = (input.action as { poolId?: `0x${string}` }).poolId;
    if (ctx.rpcUrl && poolId) {
      const resolved = await getRpc(ctx, input.chainId);
      if (resolved) {
        try {
          const tokens = await resolvePoolTokens(resolved.client, dep.poolManager, poolId, ctx.atBlock);
          const ZERO = "0x0000000000000000000000000000000000000000";
          if (tokens.collateral === ZERO || tokens.cst === ZERO || tokens.cpt === ZERO) {
            return unavailable(input.chainId, "pool_not_found", `pool ${poolId} does not exist on chainId ${input.chainId} (market returned a zeroed struct); check the poolId/chainId pairing`, ctx);
          }
          tokenRoles = roleMapOf(tokens);
          // 'pre-funded' gets the same guards as the funded path — it must not silently skip
          // checks its sibling enforces [F19].
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
          );
        } catch {
          // best-effort — pre-funded byte-building stays offline-capable by design
        }
      }
    }
  } else if (!canAutoFund(input.action.type)) {
    warnings.push({ code: "manual_funding", message: `'${input.action.type}' has no auto-funding model in this iteration; fund the adapter manually or use fundingMode 'pre-funded'.` });
  } else if (!ctx.rpcUrl) {
    warnings.push({
      code: "funding_needs_rpc",
      message: `Funding leg for '${input.action.type}' needs an RPC to resolve pool token addresses; re-run with an RPC or use fundingMode 'pre-funded'. Bundle contains the action leg only.`,
    });
  } else {
    // Explicit RPC only (funding stays offline-by-default); routed through the resolver hook so
    // tests can stub the client, and guarded like every other chain read — a revert/transport
    // failure must map to an envelope, never escape raw (viem errors embed the RPC URL).
    const resolved = await getRpc(ctx, input.chainId);
    if (!resolved) return unavailable(input.chainId, "requires_rpc", "funding-leg resolution could not reach the configured RPC", ctx);
    const poolId = (input.action as { poolId: `0x${string}` }).poolId;
    let tokens;
    try {
      tokens = await resolvePoolTokens(resolved.client, dep.poolManager, poolId, ctx.atBlock);
    } catch (err) {
      return chainReadFailed(input.chainId, err, [], ctx, resolved);
    }
    // A nonexistent pool does NOT revert here — market() returns a zeroed struct. Refuse to
    // build funding legs against the zero address instead of emitting a plausible-looking
    // bundle that can only revert on-chain.
    const ZERO = "0x0000000000000000000000000000000000000000";
    if (tokens.collateral === ZERO || tokens.cst === ZERO || tokens.cpt === ZERO) {
      return unavailable(input.chainId, "pool_not_found", `pool ${poolId} does not exist on chainId ${input.chainId} (market returned a zeroed struct); check the poolId/chainId pairing`, ctx);
    }
    tokenRoles = roleMapOf(tokens);
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
        nowSeconds: nowSecondsOf(ctx),
        atBlock: ctx.atBlock,
      })),
    );
    // Sweep-back [F13]: auto-funding moves the caller's slippage CAP into the adapter, but the
    // pool consumes only the true amount. The delta is not just stranded — CoreAdapter's
    // erc20Transfer never checks receiver==initiator() and Bundler3.multicall is public, so
    // anyone can take it in a later block. Return it to the declared initiator in-bundle.
    const plan = fundingPlan(input.action, tokens, corkAdapter, mode, input.account);
    funding = plan.legs;
    sweepBack = plan.sweepLegs;
    if (plan.note) warnings.push({ code: "owner_managed_funding", message: plan.note });
    if (plan.sweepNote) warnings.push({ code: "sweep_back_skipped", message: plan.sweepNote });
    if (sweepBack.length) {
      warnings.push({
        code: "sweep_back",
        message: `this bundle ends with ${sweepBack.length} sweep-back leg(s) returning any unspent balance of ${plan.sweptTokens.join(", ")} to ${input.account}, because auto-funding moved a slippage CAP (not the exact amount) into the adapter. Each sweeps the adapter's FULL balance of that token (uint256.max sentinel), so it also returns any residual an earlier bundle abandoned there — that balance was already takeable by anyone. A zero residual is a no-op, not a revert.`,
      });
    }
  }

  const bundle = [...funding, actionLeg, ...sweepBack];
  const multicall = encodeMulticall(bundle);
  // What the caller is about to sign, in words. Token roles come from the pool read when we
  // did one, so amounts are attributed to "collateral"/"cST" rather than bare addresses.
  const summary = summarizeBundle(decodeBundle(multicall), { tokenRoles, account: input.account, adapter: corkAdapter });
  return envelope({
    state: "ok",
    data: { bundler3, corkAdapter, deadline, action: ACTION_MAP[input.action.type], fundingMode: mode, fundingLegs: funding.length, sweepBackLegs: sweepBack.length, summary, bundle, multicall, execution: executionEthTransaction(), clientRequestId: input.clientRequestId },
    chainId: input.chainId,
    source: ctx.rpcUrl && funding.length ? "chain" : "config",
    warnings,
    ctx,
  });
}
