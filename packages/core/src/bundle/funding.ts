// Funding legs that move the initiator's tokens INTO the adapter before a Cork action runs
// (every action consumes from the adapter's own balance — CorkAdapter.sol snapshots
// `balanceOf(address(this))`). Leg fn is on the adapter itself (it inherits GeneralAdapter1):
//   erc20-approve -> erc20TransferFrom(token, adapter, amount)   (initiator pre-approves adapter)
//   permit2       -> permit2TransferFrom(token, adapter, amount) (initiator has a Permit2 allowance)
//   pre-funded    -> no leg (tokens already in the adapter)
import { encodeFunctionData, parseAbi } from "viem";
import { call, type Call } from "./bundler3.ts";
import type { PhoenixAction } from "@cork/schemas";

export type FundingMode = "permit2" | "erc20-approve" | "pre-funded";
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

/** For each action, the tokens the adapter must hold and which param supplies the max amount. */
type FundReq = { role: TokenRole; field: string };
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
const MAX_UINT = (1n << 256n) - 1n;
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
  /** Present when funding could not be auto-built and the caller must handle it. */
  note?: string;
  /** Present when a sweep was warranted but could not be built. */
  sweepNote?: string;
}

/**
 * Config-driven field access: FUNDING_TABLE/BURN_TABLE field names are correlated with
 * `action.type` by construction, which TS cannot prove across the union — the one narrow
 * escape hatch, kept in a single place instead of scattered casts.
 */
function actionField(action: PhoenixAction, field: string): string | undefined {
  return (action as unknown as Record<string, string | undefined>)[field];
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
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
): { sweepLegs: Call[]; sweptTokens: `0x${string}`[]; sweepNote?: string } {
  const capped = reqs.filter(isCapped);
  if (capped.length === 0) return NONE;
  // The adapter reverts on both of these receivers, which would take the whole bundle with it.
  if (target === ZERO_ADDRESS) return { ...NONE, sweepNote: "no sweep-back leg was built: the sweep target is the zero address, which erc20Transfer rejects. Any residual of the capped input stays on the adapter, where it is skimmable by anyone." };
  if (target.toLowerCase() === adapter.toLowerCase()) return { ...NONE, sweepNote: "no sweep-back leg was built: the sweep target is the adapter itself, which erc20Transfer rejects. Any residual of the capped input stays on the adapter." };

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
 * Build the funding plan for an action (legs + an optional owner-managed note).
 *
 * Pass `sweepTo` (the declared initiator) to also get `sweepLegs` returning the residual of any
 * capped input. Omitted = no sweep, which is the right default for `pre-funded` callers who own
 * their own funding and for existing callers that place only `legs`.
 */
export function fundingPlan(
  action: PhoenixAction,
  tokens: PoolTokens,
  adapter: `0x${string}`,
  mode: FundingMode,
  sweepTo?: `0x${string}`,
): FundingPlan {
  if (mode === "pre-funded") return { legs: [], ...NONE };
  const fn = mode === "permit2" ? "permit2TransferFrom" : "erc20TransferFrom";
  const build = (reqs: FundReq[]): Call[] =>
    reqs.map((req) => {
      const raw = actionField(action, req.field);
      if (raw === undefined) throw new Error(`funding: action ${action.type} missing field ${req.field}`);
      const data = encodeFunctionData({ abi: generalAdapterAbi, functionName: fn, args: [tokenFor(req.role, tokens), adapter, BigInt(raw)] });
      return call(adapter, data);
    });
  // Sweep only what we funded: a requirement we skipped strands nothing of ours.
  const sweep = (reqs: FundReq[]) => (sweepTo ? buildSweep(reqs, tokens, adapter, sweepTo) : NONE);

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
    if (hasSentinel) return { legs: [], ...NONE, note: "owner==adapter with a uint256.max sentinel amount; pre-fund the adapter's shares directly (amount is resolved on-chain). No funding leg was built." };
    // Burn legs are capped too (maxCptSharesIn / maxCptAndCstSharesIn), so they strand shares
    // exactly like the value-in path does.
    return { legs: build(burnReqs), ...sweep(burnReqs) };
  }
  return { legs: [], ...NONE };
}

/** Legs-only convenience (value-in actions). */
export function fundingLegs(action: PhoenixAction, tokens: PoolTokens, adapter: `0x${string}`, mode: FundingMode): Call[] {
  return fundingPlan(action, tokens, adapter, mode).legs;
}
