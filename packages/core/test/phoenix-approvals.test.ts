// cork_prepare_phoenix `data.approvals` (2026-10-01, cork-cli-private#24 item 3): every pool
// bundle names the grants it needs — the initiator's pulls to the cork adapter (one ERC-20
// allowance in erc20-approve mode, the two Permit2 layers in permit2 mode) and, on a burn-side
// action with an `owner` that is not the adapter, the OWNER's allowance to the cork adapter (the
// spender the 0.6.1 hint fix named; an allowance to the pool manager is never spent). Each entry
// is annotated with the live allowance, and a confirmed-missing grant warns `approval_missing`
// with the unsigned approve tx in hand. The stub answers the real view names.
import { describe, expect, it } from "vitest";
import { decodeFunctionData, getAddress, parseAbi } from "viem";
import { BUNDLED_DEFAULTS, generationsOf, PERMIT2_ADDRESS, primaryOf, runTool, type HandlerContext } from "@cork/core";
import { POOL_TOKENS, stubRpc, type StubCall } from "./helpers.ts";

const NOW = 1_790_000_000n;
const POOL = "0xceebea356e5159c9cb06612c39ef2e6e0fe9cd3bb047541e26e0c0767bd1c16a" as const;
const INIT = getAddress("0x00000000000000000000000000000000000000aa");
const OWNER = getAddress("0x00000000000000000000000000000000000000bb");
const ADAPTER_42161 = primaryOf(generationsOf(BUNDLED_DEFAULTS, 42161))!.phoenix!.corkAdapter as `0x${string}`;
const erc20 = parseAbi(["function approve(address spender, uint256 amount)"]);
const permit2 = parseAbi(["function approve(address token, address spender, uint160 amount, uint48 expiration)"]);

/** A pool-manager view of one live pool plus allowance reads: ERC-20 `allowance(owner, spender)`
 *  and Permit2 `allowance(owner, token, spender)` answer from the given maps. */
function rpc(allowances: { erc20?: Record<string, bigint>; permit2?: Record<string, [bigint, number]> } = {}) {
  return stubRpc((c: StubCall) => {
    switch (c.functionName) {
      case "market":
        return { collateralAsset: POOL_TOKENS.collateral, referenceAsset: POOL_TOKENS.reference, expiryTimestamp: 9_999_999_999n, rateMin: 1n, rateMax: 1n, rateChangePerDayMax: 1n, rateChangeCapacityMax: 1n, rateOracle: "0x0000000000000000000000000000000000000001" };
      case "shares":
        return [POOL_TOKENS.cpt, POOL_TOKENS.cst];
      case "paused":
        return false;
      case "getPausedBitMap":
        return 0n;
      case "isWhitelisted":
        return true;
      case "allowance": {
        if (c.address.toLowerCase() === PERMIT2_ADDRESS.toLowerCase()) {
          const [owner, token, spender] = c.args as [string, string, string];
          return allowances.permit2?.[`${owner}:${token}:${spender}`.toLowerCase()] ?? [0n, 0];
        }
        const [owner, spender] = c.args as [string, string];
        return allowances.erc20?.[`${c.address}:${owner}:${spender}`.toLowerCase()] ?? 0n;
      }
      default:
        throw new Error(`no stub for ${c.functionName}`);
    }
  });
}
type Entry = { role: string; stage: string; holder: string; token: string; tokenRole: string; spender: string; spenderRole: string; mechanism: string; amount: string | null; kind: string; note: string; satisfied?: boolean; currentAllowance?: string; unsignedTx: { to: string; calldata: `0x${string}` } | null };
type Data = { approvals: Entry[]; scales: { approvalsAmount: string } };
const prepare = (action: Record<string, unknown>, fundingMode: "erc20-approve" | "permit2", resolveRpc: NonNullable<HandlerContext["resolveRpc"]>) =>
  runTool("cork_prepare_phoenix", { chainId: 42161, account: INIT, clientRequestId: `approvals-${String(action.type)}-0001`, fundingMode, action }, { nowSeconds: NOW, resolveRpc });
const codes = (env: { warnings: Array<{ code: string }> }) => env.warnings.map((w) => w.code);

describe("cork_prepare_phoenix data.approvals", () => {
  it("a capped deposit (mint) in erc20-approve mode: ONE grant, initiator → cork adapter for the collateral cap, with the unsigned approve tx; missing on chain → approval_missing", async () => {
    const env = await prepare({ type: "mint", poolId: POOL, cptAndCstSharesOut: "5", receiver: INIT, maxCollateralAssetsIn: "1000" }, "erc20-approve", rpc());
    expect(env.state).toBe("ok");
    const d = env.data as Data;
    expect(d.approvals).toHaveLength(1);
    const e = d.approvals[0]!;
    expect(e).toMatchObject({ role: "initiator", stage: "before-bundle", holder: INIT, token: POOL_TOKENS.collateral, tokenRole: "collateral", spender: ADAPTER_42161, spenderRole: "Cork adapter", mechanism: "erc20-approve", amount: "1000", kind: "cap", satisfied: false, currentAllowance: "0" });
    expect(e.unsignedTx!.to).toBe(POOL_TOKENS.collateral);
    const dec = decodeFunctionData({ abi: erc20, data: e.unsignedTx!.calldata });
    expect(dec.args).toEqual([ADAPTER_42161, 1000n]);
    expect(codes(env)).toContain("approval_missing");
    expect(env.warnings.find((w) => w.code === "approval_missing")!.message).toMatch(/collateral .* → Cork adapter .* \(current 0, needs 1000\)/u);
    expect(d.scales.approvalsAmount).toMatch(/base units of that entry's own token/u);
  });

  it("the same bundle with the allowance in place: satisfied, no approval_missing", async () => {
    const env = await prepare({ type: "mint", poolId: POOL, cptAndCstSharesOut: "5", receiver: INIT, maxCollateralAssetsIn: "1000" }, "erc20-approve", rpc({ erc20: { [`${POOL_TOKENS.collateral}:${INIT}:${ADAPTER_42161}`.toLowerCase()]: 1000n } }));
    expect((env.data as Data).approvals[0]).toMatchObject({ satisfied: true, currentAllowance: "1000" });
    expect(codes(env)).not.toContain("approval_missing");
  });

  it("permit2 mode: BOTH layers per pulled token — the ERC-20 allowance to Permit2 and Permit2's internal (initiator, token, spender = adapter) allowance", async () => {
    const env = await prepare({ type: "swap", poolId: POOL, collateralAssetsOut: "10", receiver: INIT, maxCstSharesIn: "7", maxReferenceAssetsIn: "3" }, "permit2", rpc({ permit2: { [`${INIT}:${POOL_TOKENS.cst}:${ADAPTER_42161}`.toLowerCase()]: [7n, 2_000_000_000] } }));
    expect(env.state).toBe("ok");
    const a = (env.data as Data).approvals;
    expect(a.map((e) => [e.tokenRole, e.spenderRole, e.mechanism, e.amount, e.kind])).toEqual([
      ["cST", "Permit2", "erc20-approve", "7", "cap"],
      ["cST", "Cork adapter", "permit2-approve", "7", "cap"],
      ["reference", "Permit2", "erc20-approve", "3", "cap"],
      ["reference", "Cork adapter", "permit2-approve", "3", "cap"],
    ]);
    // Layer 2's unsigned tx goes to the Permit2 CONTRACT and names the adapter as spender.
    expect(a[1]!.unsignedTx!.to).toBe(PERMIT2_ADDRESS);
    expect(decodeFunctionData({ abi: permit2, data: a[1]!.unsignedTx!.calldata }).args.slice(0, 3)).toEqual([POOL_TOKENS.cst, ADAPTER_42161, 7n]);
    expect(a[1]).toMatchObject({ satisfied: true, currentAllowance: "7", currentExpiration: 2_000_000_000 });
    expect(a[3]).toMatchObject({ satisfied: false, currentAllowance: "0" });
  });

  it("a redeem from an OWNER that is not the adapter: the owner's cPT allowance to the CORK ADAPTER (never the pool manager), and no initiator pull", async () => {
    const env = await prepare({ type: "redeem", poolId: POOL, cptSharesIn: "1000000000000000000", owner: OWNER, receiver: OWNER, minReferenceAssetsOut: "1", minCollateralAssetsOut: "1" }, "erc20-approve", rpc());
    expect(env.state).toBe("ok");
    const a = (env.data as Data).approvals;
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ role: "owner", holder: OWNER, token: POOL_TOKENS.cpt, tokenRole: "cPT", spender: ADAPTER_42161, spenderRole: "Cork adapter", mechanism: "erc20-approve", amount: "1000000000000000000", kind: "exact", satisfied: false });
    expect(a[0]!.note).toMatch(/with the ADAPTER as the caller.*an allowance to the pool manager is never spent/u);
    expect(decodeFunctionData({ abi: erc20, data: a[0]!.unsignedTx!.calldata }).args).toEqual([ADAPTER_42161, 1_000_000_000_000_000_000n]);
    expect(codes(env)).toEqual(expect.arrayContaining(["owner_managed_funding", "approval_missing"]));
  });

  it("unwind-deposit from the initiator: cPT and cST are pulled under ONE field — two grants, one per token", async () => {
    const env = await prepare({ type: "unwind-deposit", poolId: POOL, collateralAssetsOut: "10", owner: ADAPTER_42161, receiver: INIT, maxCptAndCstSharesIn: "20" }, "erc20-approve", rpc());
    expect(env.state).toBe("ok");
    const a = (env.data as Data).approvals;
    expect(a.map((e) => [e.role, e.tokenRole, e.amount, e.kind])).toEqual([["initiator", "cPT", "20", "cap"], ["initiator", "cST", "20", "cap"]]);
  });
});
