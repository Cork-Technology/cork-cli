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

/** Whether this action's funding can be auto-built (value-in always; burn only when owner==adapter). */
export function canAutoFund(type: PhoenixAction["type"]): boolean {
  return type in FUNDING_TABLE || type in BURN_TABLE;
}

function tokenFor(role: TokenRole, t: PoolTokens): `0x${string}` {
  return t[role];
}

export interface FundingPlan {
  legs: Call[];
  /** Present when funding could not be auto-built and the caller must handle it. */
  note?: string;
}

/** Build the funding plan for an action (legs + an optional owner-managed note). */
export function fundingPlan(
  action: PhoenixAction,
  tokens: PoolTokens,
  adapter: `0x${string}`,
  mode: FundingMode,
): FundingPlan {
  if (mode === "pre-funded") return { legs: [] };
  const fn = mode === "permit2" ? "permit2TransferFrom" : "erc20TransferFrom";
  const build = (reqs: FundReq[]): Call[] =>
    reqs.map((req) => {
      const raw = (action as unknown as Record<string, string>)[req.field];
      if (raw === undefined) throw new Error(`funding: action ${action.type} missing field ${req.field}`);
      const data = encodeFunctionData({ abi: generalAdapterAbi, functionName: fn, args: [tokenFor(req.role, tokens), adapter, BigInt(raw)] });
      return call(adapter, data);
    });

  const valueReqs = FUNDING_TABLE[action.type];
  if (valueReqs) return { legs: build(valueReqs) };

  const burnReqs = BURN_TABLE[action.type];
  if (burnReqs) {
    const owner = (action as unknown as { owner?: `0x${string}` }).owner;
    if (owner && owner.toLowerCase() !== adapter.toLowerCase()) {
      return { legs: [], note: `owner (${owner}) is not the adapter; shares are burned from owner directly — ensure owner approved the pool manager for cPT/cST. No funding leg was built.` };
    }
    // owner == adapter: transfer shares in, unless a sentinel amount (uint256.max) is used.
    const hasSentinel = burnReqs.some((r) => BigInt((action as unknown as Record<string, string>)[r.field] ?? "0") === MAX_UINT);
    if (hasSentinel) return { legs: [], note: "owner==adapter with a uint256.max sentinel amount; pre-fund the adapter's shares directly (amount is resolved on-chain). No funding leg was built." };
    return { legs: build(burnReqs) };
  }
  return { legs: [] };
}

/** Legs-only convenience (value-in actions). */
export function fundingLegs(action: PhoenixAction, tokens: PoolTokens, adapter: `0x${string}`, mode: FundingMode): Call[] {
  return fundingPlan(action, tokens, adapter, mode).legs;
}
