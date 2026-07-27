// Token-authority byte-building for cork_prepare_phoenix authority-onboard / authority-revoke.
// Builds an unsigned DIRECT ERC-20 approve tx for the token owner to execute — deliberately NOT
// a Bundler3 leg, because an approve routed through the bundler would key the allowance to the
// bundler contract instead of the owner. Unsigned bytes only [K1].
import { encodeFunctionData, parseAbi } from "viem";

const erc20ApproveAbi = parseAbi(["function approve(address spender, uint256 amount)"]);
const MAX_UINT256 = (1n << 256n) - 1n;

export interface AuthorityAction {
  type: "authority-onboard" | "authority-revoke";
  token: `0x${string}`;
  spender: `0x${string}`;
  /** onboard only; omitted = unlimited (MAX_UINT256). */
  amount?: string;
}

export interface AuthorityTx {
  to: `0x${string}`;
  calldata: `0x${string}`;
  amount: bigint;
  unlimited: boolean;
}

/** Encode the approve call for an authority op (revoke = zero the allowance). */
export function buildAuthorityTx(a: AuthorityAction): AuthorityTx {
  const unlimited = a.type === "authority-onboard" && a.amount === undefined;
  const amount = a.type === "authority-revoke" ? 0n : unlimited ? MAX_UINT256 : BigInt(a.amount!);
  return {
    to: a.token,
    calldata: encodeFunctionData({ abi: erc20ApproveAbi, functionName: "approve", args: [a.spender, amount] }),
    amount,
    unlimited,
  };
}

/** Which funding layer a spender serves, so a mistyped spender is visible in the result. */
export function spenderRoleOf(spender: string, corkAdapter: string | undefined, permit2: string): string {
  const s = spender.toLowerCase();
  if (corkAdapter && s === corkAdapter.toLowerCase()) return "corkAdapter (the erc20-approve funding mode's spender)";
  if (s === permit2.toLowerCase()) return "canonical Permit2 (the permit2 funding mode's outer layer; the Permit2-internal allowance for the adapter is set separately)";
  return "unrecognized: neither this chain's corkAdapter nor the canonical Permit2 — verify the spender address before signing";
}
