import { describe, expect, it } from "vitest";
import { toFunctionSelector } from "viem";
import { canAutoFund, fundingLegs, fundingPlan, generalAdapterAbi, isBurnAction, type PoolTokens } from "@cork/core";
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
