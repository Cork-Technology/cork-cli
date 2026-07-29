import { describe, expect, it } from "vitest";
import { decodeFunctionData, toFunctionSelector } from "viem";
import { bundlerSweepAbi, canAutoFund, fundingLegs, fundingPlan, generalAdapterAbi, isBurnAction, type PoolTokens } from "@cork/core";
import type { PhoenixAction } from "@cork/schemas";

const ADP = "0xccccccccccccbad6f772a511b337d9ccc9570407" as const;
const OTHER = "0x00000000000000000000000000000000000000ff" as const;
const POOL = "0xceebea356e5159c9cb06612c39ef2e6e0fe9cd3bb047541e26e0c0767bd1c16a" as const;
const RCV = "0x0000000000000000000000000000000000000001" as const;
const tokens: PoolTokens = {
  collateral: "0x0000000000000000000000000000000000000010",
  reference: "0x0000000000000000000000000000000000000020",
  cst: "0x0000000000000000000000000000000000000030",
  cpt: "0x0000000000000000000000000000000000000040",
};
const ERC20_TF = toFunctionSelector(generalAdapterAbi[0]!); // erc20TransferFrom
const PERMIT2_TF = toFunctionSelector(generalAdapterAbi[1]!); // permit2TransferFrom

const sel = (d: `0x${string}`) => d.slice(0, 10);

describe("fundingPlan: value-in actions", () => {
  it("deposit -> 1 erc20TransferFrom(collateral) leg to the adapter", () => {
    const action = { type: "deposit", poolId: POOL, collateralAssetsIn: "5", receiver: RCV, minCptAndCstSharesOut: "1" } as unknown as PhoenixAction;
    const { legs, note } = fundingPlan(action, tokens, ADP, "erc20-approve");
    expect(note).toBeUndefined();
    expect(legs).toHaveLength(1);
    expect(legs[0]?.to).toBe(ADP);
    expect(sel(legs[0]!.data)).toBe(ERC20_TF);
  });
  it("swap -> 2 legs (cst + reference)", () => {
    const action = { type: "swap", poolId: POOL, collateralAssetsOut: "1", receiver: RCV, maxCstSharesIn: "2", maxReferenceAssetsIn: "3" } as unknown as PhoenixAction;
    expect(fundingPlan(action, tokens, ADP, "erc20-approve").legs).toHaveLength(2);
  });
  it("permit2 mode uses permit2TransferFrom", () => {
    const action = { type: "deposit", poolId: POOL, collateralAssetsIn: "5", receiver: RCV, minCptAndCstSharesOut: "1" } as unknown as PhoenixAction;
    expect(sel(fundingPlan(action, tokens, ADP, "permit2").legs[0]!.data)).toBe(PERMIT2_TF);
  });
  it("pre-funded -> no legs", () => {
    const action = { type: "deposit", poolId: POOL, collateralAssetsIn: "5", receiver: RCV, minCptAndCstSharesOut: "1" } as unknown as PhoenixAction;
    expect(fundingPlan(action, tokens, ADP, "pre-funded").legs).toHaveLength(0);
  });
});

describe("fundingPlan: share-burn actions", () => {
  it("withdraw owner==adapter -> 1 cpt-transfer leg", () => {
    const action = { type: "withdraw", poolId: POOL, collateralAssetsOut: "1", owner: ADP, receiver: RCV, maxCptSharesIn: "9" } as unknown as PhoenixAction;
    const { legs, note } = fundingPlan(action, tokens, ADP, "erc20-approve");
    expect(note).toBeUndefined();
    expect(legs).toHaveLength(1);
  });
  it("unwind-deposit owner==adapter -> 2 legs (cpt + cst)", () => {
    const action = { type: "unwind-deposit", poolId: POOL, collateralAssetsOut: "1", owner: ADP, receiver: RCV, maxCptAndCstSharesIn: "9" } as unknown as PhoenixAction;
    expect(fundingPlan(action, tokens, ADP, "erc20-approve").legs).toHaveLength(2);
  });
  it("owner != adapter -> no leg + owner-managed note", () => {
    const action = { type: "withdraw", poolId: POOL, collateralAssetsOut: "1", owner: OTHER, receiver: RCV, maxCptSharesIn: "9" } as unknown as PhoenixAction;
    const { legs, note } = fundingPlan(action, tokens, ADP, "erc20-approve");
    expect(legs).toHaveLength(0);
    expect(note).toMatch(/owner/i);
  });
  it("owner==adapter with uint256.max sentinel -> no leg + note", () => {
    const MAX = ((1n << 256n) - 1n).toString();
    const action = { type: "redeem", poolId: POOL, cptSharesIn: MAX, owner: ADP, receiver: RCV, minReferenceAssetsOut: "0", minCollateralAssetsOut: "0" } as unknown as PhoenixAction;
    const { legs, note } = fundingPlan(action, tokens, ADP, "erc20-approve");
    expect(legs).toHaveLength(0);
    expect(note).toMatch(/sentinel/i);
  });
});

describe("fundingPlan: guards and predicates", () => {
  it("throws when a fundable action is missing its amount field (never funds 0 silently)", () => {
    const action = { type: "deposit", poolId: POOL, receiver: RCV } as unknown as PhoenixAction;
    expect(() => fundingPlan(action, tokens, ADP, "erc20-approve")).toThrow(/missing field collateralAssetsIn/);
  });
  it("fundingLegs is exactly fundingPlan().legs", () => {
    const action = { type: "deposit", poolId: POOL, collateralAssetsIn: "5", receiver: RCV, minCptAndCstSharesOut: "1" } as unknown as PhoenixAction;
    expect(fundingLegs(action, tokens, ADP, "permit2")).toEqual(fundingPlan(action, tokens, ADP, "permit2").legs);
  });
  it("classifies fundable vs burn actions", () => {
    expect(canAutoFund("deposit")).toBe(true);
    expect(canAutoFund("redeem")).toBe(true);
    expect(isBurnAction("redeem")).toBe(true);
    expect(isBurnAction("deposit")).toBe(false);
  });
  it("an unrecognized action type funds nothing — never guesses a token move", () => {
    const action = { type: "not-an-action", poolId: POOL } as unknown as PhoenixAction;
    expect(canAutoFund(action.type)).toBe(false);
    expect(fundingPlan(action, tokens, ADP, "erc20-approve").legs).toHaveLength(0);
  });
});

// ── Sweep-back legs [F13] ────────────────────────────────────────────────────────────────────
// Auto-funding moves the caller's slippage CAP into the adapter; the pool consumes only the true
// amount. The delta is takeable by anyone (CoreAdapter.erc20Transfer never checks
// receiver==initiator() and Bundler3.multicall is public), so a capped leg must be swept back.
const INIT = "0x00000000000000000000000000000000000000aa" as const;
const SWEEP_SEL = toFunctionSelector(bundlerSweepAbi[0]!); // erc20Transfer
const MAXU = (1n << 256n) - 1n;

describe("fundingPlan: sweep-back legs", () => {
  it("omits sweep legs entirely when no target is passed (back-compat)", () => {
    const action = { type: "mint", poolId: POOL, cptAndCstSharesOut: "5", receiver: RCV, maxCollateralAssetsIn: "9" } as unknown as PhoenixAction;
    const plan = fundingPlan(action, tokens, ADP, "erc20-approve");
    expect(plan.sweepLegs).toHaveLength(0);
    expect(plan.sweptTokens).toEqual([]);
  });

  it("mint (capped collateral) -> 1 sweep leg returning the collateral residual to the initiator", () => {
    const action = { type: "mint", poolId: POOL, cptAndCstSharesOut: "5", receiver: RCV, maxCollateralAssetsIn: "9" } as unknown as PhoenixAction;
    const plan = fundingPlan(action, tokens, ADP, "erc20-approve", INIT);
    expect(plan.sweepLegs).toHaveLength(1);
    expect(plan.sweptTokens).toEqual([tokens.collateral]);
    const leg = plan.sweepLegs[0]!;
    expect(leg.to).toBe(ADP);
    expect(sel(leg.data)).toBe(SWEEP_SEL);
    // full-balance sentinel, returned to the initiator — decoded, not assumed
    const { args } = decodeFunctionData({ abi: bundlerSweepAbi, data: leg.data });
    const [tok, to, amt] = args as [string, string, bigint];
    expect(tok.toLowerCase()).toBe(tokens.collateral);
    expect(to.toLowerCase()).toBe(INIT); // viem returns it checksummed
    expect(amt).toBe(MAXU);
  });

  it("deposit (exact collateral) -> no sweep leg: an exact amount strands nothing", () => {
    const action = { type: "deposit", poolId: POOL, collateralAssetsIn: "5", receiver: RCV, minCptAndCstSharesOut: "1" } as unknown as PhoenixAction;
    expect(fundingPlan(action, tokens, ADP, "erc20-approve", INIT).sweepLegs).toHaveLength(0);
  });

  it("exercise -> sweeps ONLY the capped reference leg, not the exact cst leg", () => {
    const action = { type: "exercise", poolId: POOL, cstSharesIn: "5", receiver: RCV, minCollateralAssetsOut: "1", maxReferenceAssetsIn: "9" } as unknown as PhoenixAction;
    const plan = fundingPlan(action, tokens, ADP, "erc20-approve", INIT);
    expect(plan.legs).toHaveLength(2);
    expect(plan.sweptTokens).toEqual([tokens.reference]);
  });

  it("swap (both legs capped) -> 2 sweep legs, cst and reference", () => {
    const action = { type: "swap", poolId: POOL, collateralAssetsOut: "5", receiver: RCV, maxCstSharesIn: "9", maxReferenceAssetsIn: "9" } as unknown as PhoenixAction;
    const plan = fundingPlan(action, tokens, ADP, "erc20-approve", INIT);
    expect(plan.sweptTokens).toEqual([tokens.cst, tokens.reference]);
  });

  it("withdraw (capped BURN leg) -> sweeps the cPT residual too", () => {
    // The original F13 proposal covered only exact-OUT value-in actions; the burn table is capped
    // as well (maxCptSharesIn), so it strands shares by the same mechanism.
    const action = { type: "withdraw", poolId: POOL, collateralAssetsOut: "5", owner: ADP, receiver: RCV, maxCptSharesIn: "9" } as unknown as PhoenixAction;
    const plan = fundingPlan(action, tokens, ADP, "erc20-approve", INIT);
    expect(plan.legs).toHaveLength(1);
    expect(plan.sweptTokens).toEqual([tokens.cpt]);
  });

  it("redeem (exact BURN leg) -> no sweep", () => {
    const action = { type: "redeem", poolId: POOL, cptSharesIn: "5", owner: ADP, receiver: RCV, minReferenceAssetsOut: "0", minCollateralAssetsOut: "0" } as unknown as PhoenixAction;
    expect(fundingPlan(action, tokens, ADP, "erc20-approve", INIT).sweepLegs).toHaveLength(0);
  });

  it("unwind-deposit -> 2 sweep legs (cPT + cST both funded at one cap)", () => {
    const action = { type: "unwind-deposit", poolId: POOL, collateralAssetsOut: "5", owner: ADP, receiver: RCV, maxCptAndCstSharesIn: "9" } as unknown as PhoenixAction;
    const plan = fundingPlan(action, tokens, ADP, "erc20-approve", INIT);
    expect(plan.sweptTokens).toEqual([tokens.cpt, tokens.cst]);
  });

  it("burn action we did NOT fund (owner != adapter) -> no sweep: nothing of ours is stranded", () => {
    const action = { type: "withdraw", poolId: POOL, collateralAssetsOut: "5", owner: OTHER, receiver: RCV, maxCptSharesIn: "9" } as unknown as PhoenixAction;
    const plan = fundingPlan(action, tokens, ADP, "erc20-approve", INIT);
    expect(plan.legs).toHaveLength(0);
    expect(plan.sweepLegs).toHaveLength(0);
  });

  it("pre-funded -> no sweep: the caller owns that balance", () => {
    const action = { type: "mint", poolId: POOL, cptAndCstSharesOut: "5", receiver: RCV, maxCollateralAssetsIn: "9" } as unknown as PhoenixAction;
    expect(fundingPlan(action, tokens, ADP, "pre-funded", INIT).sweepLegs).toHaveLength(0);
  });

  it("refuses to build a sweep the adapter would revert on (zero address / the adapter itself)", () => {
    const action = { type: "mint", poolId: POOL, cptAndCstSharesOut: "5", receiver: RCV, maxCollateralAssetsIn: "9" } as unknown as PhoenixAction;
    const zero = fundingPlan(action, tokens, ADP, "erc20-approve", "0x0000000000000000000000000000000000000000");
    expect(zero.sweepLegs).toHaveLength(0);
    expect(zero.sweepNote).toMatch(/zero address/);
    expect(zero.legs).toHaveLength(1); // funding still built — only the sweep is withheld
    const self = fundingPlan(action, tokens, ADP, "erc20-approve", ADP);
    expect(self.sweepLegs).toHaveLength(0);
    expect(self.sweepNote).toMatch(/adapter itself/);
  });
});
