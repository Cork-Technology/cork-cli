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

/**
 * Whether this action's funding can be auto-built. Share-burning actions
 * (unwind-deposit/unwind-mint/withdraw/withdraw-other/redeem) burn from `owner` with sentinel/owner
 * semantics that the caller controls via the `owner` param — we do NOT guess a leg for those.
 */
export function canAutoFund(type: PhoenixAction["type"]): boolean {
  return type in FUNDING_TABLE;
}

function tokenFor(role: TokenRole, t: PoolTokens): `0x${string}` {
  return t[role];
}

/** Build the funding legs for an action. Returns [] for pre-funded or non-auto-fundable actions. */
export function fundingLegs(
  action: PhoenixAction,
  tokens: PoolTokens,
  adapter: `0x${string}`,
  mode: FundingMode,
): Call[] {
  if (mode === "pre-funded") return [];
  const reqs = FUNDING_TABLE[action.type];
  if (!reqs) return [];
  const fn = mode === "permit2" ? "permit2TransferFrom" : "erc20TransferFrom";
  const legs: Call[] = [];
  for (const req of reqs) {
    const raw = (action as unknown as Record<string, string>)[req.field];
    if (raw === undefined) throw new Error(`funding: action ${action.type} missing field ${req.field}`);
    const amount = BigInt(raw);
    const data = encodeFunctionData({
      abi: generalAdapterAbi,
      functionName: fn,
      args: [tokenFor(req.role, tokens), adapter, amount],
    });
    legs.push(call(adapter, data));
  }
  return legs;
}
