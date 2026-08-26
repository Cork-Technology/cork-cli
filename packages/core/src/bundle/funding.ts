// Funding legs that move the initiator's tokens INTO the adapter before a Cork action runs
// (every action consumes from the adapter's own balance — CorkAdapter.sol snapshots
// `balanceOf(address(this))`). Leg fn is on the adapter itself (it inherits GeneralAdapter1):
//   erc20-approve -> erc20TransferFrom(token, adapter, amount)   (initiator pre-approves adapter)
//   permit2       -> permit2TransferFrom(token, adapter, amount) (initiator has a Permit2 allowance)
// There is deliberately NO "tokens already in the adapter" mode (audit ARTIFACT-PREFUND-001,
// 2026-08-24): a balance parked on the adapter ahead of the action is takeable by anyone through
// the public Bundler3.multicall + the adapter's unguarded erc20Transfer, for as long as it sits
// there. Pull, action and sweep-back must be ONE transaction.
import { encodeFunctionData, parseAbi, zeroAddress } from "viem";
import { U256_MAX } from "../math/fixed.ts";
import { call, type Call } from "./bundler3.ts";
import type { PhoenixAction } from "@cork/schemas";

export type FundingMode = "permit2" | "erc20-approve";
export type TokenRole = "collateral" | "reference" | "cst" | "cpt";

export interface PoolTokens {
  collateral: `0x${string}`;
  reference: `0x${string}`;
  cst: `0x${string}`;
  cpt: `0x${string}`;
}

export const generalAdapterAbi = parseAbi([
  "function erc20TransferFrom(address token, address receiver, uint256 amount)",
  "function permit2TransferFrom(address token, address receiver, uint256 amount)",
]);

/** CoreAdapter's outbound transfer, used for the sweep-back leg (also in `bundlerLegAbi`, so
 *  `decodeBundle` labels these legs without further work). */
export const bundlerSweepAbi = parseAbi(["function erc20Transfer(address token, address receiver, uint256 amount)"]);

/** Distributes keyof over the action union: the set of field names any variant declares. */
type KeysOfUnion<T> = T extends unknown ? keyof T : never;
type PhoenixActionField = KeysOfUnion<PhoenixAction> & string;

/** For each action, the tokens the adapter must hold and which param supplies the max amount.
 *  `field` is checked against the real action union, so a renamed schema field breaks the build
 *  here instead of silently funding nothing. */
type FundReq = { role: TokenRole; field: PhoenixActionField };
const FUNDING_TABLE: Partial<Record<PhoenixAction["type"], FundReq[]>> = {
  mint: [{ role: "collateral", field: "maxCollateralAssetsIn" }],
  deposit: [{ role: "collateral", field: "collateralAssetsIn" }],
  swap: [
    { role: "cst", field: "maxCstSharesIn" },
    { role: "reference", field: "maxReferenceAssetsIn" },
  ],
  exercise: [
    { role: "cst", field: "cstSharesIn" },
    { role: "reference", field: "maxReferenceAssetsIn" },
  ],
  "exercise-other": [
    { role: "reference", field: "referenceAssetsIn" },
    { role: "cst", field: "maxCstSharesIn" },
  ],
  "unwind-swap": [{ role: "collateral", field: "collateralAssetsIn" }],
  "unwind-exercise": [{ role: "collateral", field: "maxCollateralAssetsIn" }],
  "unwind-exercise-other": [{ role: "collateral", field: "maxCollateralAssetsIn" }],
};

// Share-burning actions burn from `owner` (which must be the adapter or the initiator). When
// owner == adapter we can fund by transferring the shares in; when owner == initiator the pool
// burns directly from the user and the caller manages the approval (no leg we should guess).
const MAX_UINT = U256_MAX;
const BURN_TABLE: Partial<Record<PhoenixAction["type"], FundReq[]>> = {
  withdraw: [{ role: "cpt", field: "maxCptSharesIn" }],
  "withdraw-other": [{ role: "cpt", field: "maxCptSharesIn" }],
  redeem: [{ role: "cpt", field: "cptSharesIn" }],
  "unwind-deposit": [
    { role: "cpt", field: "maxCptAndCstSharesIn" },
    { role: "cst", field: "maxCptAndCstSharesIn" },
  ],
  "unwind-mint": [
    { role: "cpt", field: "cptAndCstSharesIn" },
    { role: "cst", field: "cptAndCstSharesIn" },
  ],
};

export function isBurnAction(type: PhoenixAction["type"]): boolean {
  return type in BURN_TABLE;
}

/**
 * A funding requirement is CAPPED when its amount field is a `max*` slippage bound rather than an
 * exact amount. Both tables encode that distinction in the field name already, so deriving it here
 * keeps one source of truth — a hand-maintained parallel table would drift the moment either table
 * gains an action.
 *
 * Capped legs are the ones that strand a residual: we move the cap in, the pool consumes the real
 * amount (<= cap), and the difference is left sitting on the adapter. See `sweepBackLegs`.
 */
function isCapped(req: FundReq): boolean {
  return req.field.startsWith("max");
}

/** Whether this action's funding can be auto-built (value-in always; burn only when owner==adapter). */
export function canAutoFund(type: PhoenixAction["type"]): boolean {
  return type in FUNDING_TABLE || type in BURN_TABLE;
}

function tokenFor(role: TokenRole, t: PoolTokens): `0x${string}` {
  return t[role];
}

export interface FundingPlan {
  legs: Call[];
  /** Legs returning any residual of a CAPPED funded token to the initiator; go AFTER the action leg. */
  sweepLegs: Call[];
  /** Tokens the sweep legs cover, in leg order — for disclosure in the result envelope. */
  sweptTokens: `0x${string}`[];
  /** Present when the pool burns from an owner that is not the adapter — nothing to fund. */
  note?: string;
  /** Present when NO atomic pull-action-sweep exists for this input: emitting the action anyway
   *  would rely on a balance parked on the shared adapter, which anyone can take. The handler
   *  refuses the artifact and relays this text. */
  refusal?: string;
}

/**
 * Config-driven field access: FUNDING_TABLE/BURN_TABLE field names are correlated with
 * `action.type` by construction, which TS cannot prove across the union — the one narrow
 * escape hatch, kept in a single place instead of scattered casts. The field NAMES are
 * compile-checked against the union (PhoenixActionField); only the name↔variant pairing
 * stays a runtime fact.
 */
function actionField(action: PhoenixAction, field: PhoenixActionField): string | undefined {
  return (action as Partial<Record<PhoenixActionField, string>>)[field];
}

const ZERO_ADDRESS = zeroAddress;
const NONE = { sweepLegs: [] as Call[], sweptTokens: [] as `0x${string}`[] };

/**
 * Build the sweep-back legs for the requirements we actually funded.
 *
 * Only CAPPED requirements produce one: those move a slippage bound into the adapter, the pool
 * consumes the true amount, and the delta is stranded. It is not merely stranded but *takeable* —
 * `CoreAdapter.erc20Transfer` is `onlyBundler3` yet never checks `receiver == initiator()`, and
 * `Bundler3.multicall` is public, so anyone can sweep the adapter's balance to themselves in a
 * later block. Returning the residual in the same bundle closes that window and restores the
 * Morpho adapter invariant (an adapter should end every tx holding nothing).
 *
 * `type(uint256).max` is the adapter's full-balance sentinel, so we need not predict the residual;
 * it also makes a zero residual a no-op rather than a revert (the `require(amount != 0)` sits in
 * the non-sentinel branch, and the transfer is guarded by `if (amount > 0)`).
 */
function buildSweep(
  reqs: FundReq[],
  tokens: PoolTokens,
  adapter: `0x${string}`,
  target: `0x${string}`,
): { sweepLegs: Call[]; sweptTokens: `0x${string}`[]; refusal?: string } {
  const capped = reqs.filter(isCapped);
  if (capped.length === 0) return NONE;
  // The adapter reverts on both of these receivers, which would take the whole bundle with it —
  // and a bundle WITHOUT the sweep would leave the capped residual takeable by anyone. Neither
  // is a bundle to sign: the initiator (`account`) must be a real recipient.
  if (target === ZERO_ADDRESS) return { ...NONE, refusal: "the sweep-back target (account) is the zero address, which erc20Transfer rejects; without the sweep the unspent part of the capped input would stay on the shared adapter, where anyone can take it. Set account to the address that funds the bundle" };
  if (target.toLowerCase() === adapter.toLowerCase()) return { ...NONE, refusal: "the sweep-back target (account) is the adapter itself, which erc20Transfer rejects; without the sweep the unspent part of the capped input would stay on the shared adapter, where anyone can take it. Set account to the address that funds the bundle" };

  const sweptTokens: `0x${string}`[] = [];
  const sweepLegs: Call[] = [];
  for (const req of capped) {
    const token = tokenFor(req.role, tokens);
    if (sweptTokens.includes(token)) continue; // one full-balance sweep per token covers it
    sweptTokens.push(token);
    sweepLegs.push(call(adapter, encodeFunctionData({ abi: bundlerSweepAbi, functionName: "erc20Transfer", args: [token, target, MAX_UINT] })));
  }
  return { sweepLegs, sweptTokens };
}

/**
 * Build the atomic funding plan for an action: the initiator's pull legs (before the action) and
 * the sweep-back legs returning the residual of every CAPPED input to `sweepTo`, the declared
 * initiator (after the action). A plan that cannot be made atomic carries `refusal` instead of
 * legs; the handler must not emit the action on its own.
 */
export function fundingPlan(
  action: PhoenixAction,
  tokens: PoolTokens,
  adapter: `0x${string}`,
  mode: FundingMode,
  sweepTo: `0x${string}`,
): FundingPlan {
  const fn = mode === "permit2" ? "permit2TransferFrom" : "erc20TransferFrom";
  const build = (reqs: FundReq[]): Call[] =>
    reqs.map((req) => {
      const raw = actionField(action, req.field);
      if (raw === undefined) throw new Error(`funding: action ${action.type} missing field ${req.field}`);
      const data = encodeFunctionData({ abi: generalAdapterAbi, functionName: fn, args: [tokenFor(req.role, tokens), adapter, BigInt(raw)] });
      return call(adapter, data);
    });
  // Sweep only what we funded: a requirement we skipped strands nothing of ours.
  const sweep = (reqs: FundReq[]) => buildSweep(reqs, tokens, adapter, sweepTo);

  const valueReqs = FUNDING_TABLE[action.type];
  if (valueReqs) return { legs: build(valueReqs), ...sweep(valueReqs) };

  const burnReqs = BURN_TABLE[action.type];
  if (burnReqs) {
    const owner = "owner" in action ? action.owner : undefined;
    if (owner && owner.toLowerCase() !== adapter.toLowerCase()) {
      return { legs: [], ...NONE, note: `owner (${owner}) is not the adapter; shares are burned from owner directly — ensure owner approved the pool manager for cPT/cST. No funding leg was built.` };
    }
    // owner == adapter: transfer shares in, unless a sentinel amount (uint256.max) is used.
    const hasSentinel = burnReqs.some((r) => BigInt(actionField(action, r.field) ?? "0") === MAX_UINT);
    if (hasSentinel) return { legs: [], ...NONE, refusal: "owner is the adapter and the share amount is the uint256.max sentinel (resolved on-chain), so there is no exact amount to pull from the initiator atomically; the only way to satisfy it is to park shares on the shared adapter first, where anyone can take them. Pass the exact share amount, or set owner to the share holder so the pool burns from them directly" };
    // Burn legs are capped too (maxCptSharesIn / maxCptAndCstSharesIn), so they strand shares
    // exactly like the value-in path does.
    return { legs: build(burnReqs), ...sweep(burnReqs) };
  }
  return { legs: [], ...NONE };
}

/** Legs-only convenience (value-in actions); the initiator is still required because a plan
 *  is only meaningful with its sweep target. */
export function fundingLegs(action: PhoenixAction, tokens: PoolTokens, adapter: `0x${string}`, mode: FundingMode, sweepTo: `0x${string}`): Call[] {
  return fundingPlan(action, tokens, adapter, mode, sweepTo).legs;
}
