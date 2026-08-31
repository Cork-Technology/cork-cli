// A DEPLOYED oracle whose rate() reverts must be diagnosed as the oracle's fault, not
// the caller's input. Before this, the rate read collapsed to null (indistinguishable from "not
// read"), recipe_refused told the caller to add an anchor / deploy the oracle (both false), and
// registry-oracle reported the oracle as healthy by dropping the rate field. Reproduced live on
// the euler-covered-vault Tenderly fork 2026-08-29 (block clock 78,052 s behind wall-clock →
// Morpho accrual underflow → rate() reverts Panic(0x11)); mainnet answers rate() = 1.086.
import { beforeEach, describe, expect, it } from "vitest";
import { resetRegistryBindingGuardCache, runTool, type HandlerContext } from "@cork/core";
import { stubRpc, type StubCall } from "./helpers.ts";

const WAD = 10n ** 18n;
const CA = "0x211Cc4DD073734dA055fbF44a2b4667d5E5fE5d2";
const REF = "0xdDb46999F8891663a8F2828d25298f70416d7610";
const REG = "0xa78d8137B01058dD23e545b6557209eBBc9611F1";
const CONTROLLER = "0x6b65D663e0B445BAf1870D5af806d57Ebb2C82A1";
const PM = "0x02803Bb52D2184f906F45B50C66AA969C2E37263";
const NAV = "0xAeD3D0e3C86A994d88741C285657c3e78550f66d";
const ORACLE = "0x0c76020c927b4D9A6Cc822dF4009000f50432637";
const ZERO = "0x0000000000000000000000000000000000000000";
const PANIC = () => {
  throw new Error('The contract function "rate" reverted with the following reason:\nArithmetic operation resulted in underflow or overflow.\n\nContract Call:\n  address: 0x0c76');
};
const RESOLVE_REVERT = () => {
  throw new Error('The contract function "resolve" reverted with the following reason:\nArithmetic operation resulted in underflow or overflow.');
};
const CONSTRAINT = { rateMin: "1", rateMax: (2n * WAD).toString(), rateChangePerDayMax: WAD.toString(), rateChangeCapacityMax: (3n * WAD).toString() };

beforeEach(() => resetRegistryBindingGuardCache());

/** A DEPLOYED nav oracle whose rate() reverts; everything else answers as the live registry does. */
const revertingOracleStub = (over: Partial<Record<string, () => unknown>> = {}) => (c: StubCall): unknown => {
  if (c.functionName in over) return over[c.functionName]!();
  switch (c.functionName) {
    case "MARKET_REGISTRY": return REG;
    case "POOL_MANAGER": return PM;
    case "CONTROLLER": return CONTROLLER;
    case "FEE_MANAGER_ROLE": return `0x${"6c".repeat(32)}`;
    case "hasRole": return true;
    case "isRecipe": return true;
    case "source": return 0; // RecipeSource.NAV
    case "lookupWrapper": return ORACLE; // deployed
    case "rate": return PANIC();
    case "resolve": return RESOLVE_REVERT();
    case "verify": return PANIC();
    case "maxExpiryDuration": return 2_592_000n;
    case "CORK_POOL_MANAGER": return PM;
    case "shares": return [ZERO, ZERO];
    default: throw new Error(`unexpected ${c.functionName}`);
  }
};
const ctx = (handler: (c: StubCall) => unknown): HandlerContext => ({ nowSeconds: 1_789_900_000n, resolveRpc: stubRpc(handler, { code: { [ORACLE.toLowerCase()]: "0x6001" } }) });

describe("a deployed oracle whose rate() reverts is named as the cause", () => {
  it("registry-oracle: rateReadable:false + the revert, plus an oracle_rate_unreadable info — never a silently healthy oracle", async () => {
    const env = await runTool("cork_query", { chainId: 42161, resource: "registry-oracle", filters: { collateralAsset: CA, referenceAsset: REF, mode: "nav" } }, ctx(revertingOracleStub()));
    expect(env.state).toBe("ok");
    const o = (env.data as { oracle: { address: string; deployed: boolean; rateReadable?: boolean; rateError?: string; rate?: unknown } }).oracle;
    expect(o.deployed).toBe(true);
    expect(o.rateReadable).toBe(false);
    expect(o.rate).toBeUndefined();
    expect(o.rateError).toContain("reverted");
    const w = env.warnings.find((x) => x.code === "oracle_rate_unreadable");
    expect(w?.message).toContain("DEPLOYED but its rate() reverts");
    expect(w?.message).toContain("fork");
  });

  it("registry-oracle: a READABLE deployed oracle says rateReadable:true beside its rate", async () => {
    const env = await runTool("cork_query", { chainId: 42161, resource: "registry-oracle", filters: { collateralAsset: CA, referenceAsset: REF, mode: "nav" } }, ctx(revertingOracleStub({ rate: () => WAD })));
    const o = (env.data as { oracle: { rateReadable?: boolean; rate?: string } }).oracle;
    expect(o.rateReadable).toBe(true);
    expect(BigInt(o.rate!)).toBe(WAD);
    expect(env.warnings.some((x) => x.code === "oracle_rate_unreadable")).toBe(false);
  });

  it("derive-cork-pool: the resolve revert gates as oracle_rate_unreadable, NOT recipe_refused with anchor advice", async () => {
    const env = await runTool("cork_query", { chainId: 42161, resource: "derive-cork-pool", filters: { collateralAsset: CA, referenceAsset: REF, expiry: "1790000000", recipe: NAV } }, ctx(revertingOracleStub()));
    expect(env.state).toBe("unavailable");
    expect(env.warnings[0]?.code).toBe("oracle_rate_unreadable");
    expect(env.warnings[0]?.message).toContain(ORACLE);
    expect(env.warnings[0]?.message).not.toContain("anchorRate");
  });

  it("recipe-rate-constraint (the signing-time step) gates the same way", async () => {
    const env = await runTool("cork_compute", { chainId: 42161, params: { kind: "recipe-rate-constraint", recipe: NAV, collateralAsset: CA, referenceAsset: REF } }, ctx(revertingOracleStub()));
    expect(env.state).toBe("unavailable");
    expect(env.warnings[0]?.code).toBe("oracle_rate_unreadable");
  });

  it("create-pool with an EXPLICIT constraint builds, and the verify pre-flight names the oracle fault instead of a generic read failure", async () => {
    const env = await runTool("cork_prepare_market", { chainId: 42161, clientRequestId: "cor206-create-01", action: { type: "create-pool", collateralAsset: CA, referenceAsset: REF, expiryTimestamp: "1790000000", recipe: NAV, constraint: CONSTRAINT } }, ctx(revertingOracleStub()));
    expect(env.state).toBe("ok");
    expect(env.warnings.some((w) => w.code === "oracle_rate_unreadable")).toBe(true);
    expect(env.warnings.some((w) => w.code === "chain_read_failed")).toBe(false);
    expect((env.data as { oracle: { rateReadable?: boolean } }).oracle.rateReadable).toBe(false);
  });

  it("a deployed oracle that READS fine with a reverting resolve is the recipe's own refusal — recipe_refused, pointing at additionalData, not at deploying an oracle", async () => {
    const env = await runTool("cork_query", { chainId: 42161, resource: "derive-cork-pool", filters: { collateralAsset: CA, referenceAsset: REF, expiry: "1790000000", recipe: NAV } }, ctx(revertingOracleStub({ rate: () => WAD })));
    expect(env.state).toBe("unavailable");
    expect(env.warnings[0]?.code).toBe("recipe_refused");
    expect(env.warnings[0]?.message).toContain("recipe's own refusal");
    expect(env.warnings[0]?.message).toContain(`rate() = ${WAD}`);
    expect(env.warnings[0]?.message).not.toContain("is not deployed");
  });

  it("an UNDEPLOYED oracle keeps the anchor/deploy teaching (that advice is right there)", async () => {
    const env = await runTool("cork_query", { chainId: 42161, resource: "derive-cork-pool", filters: { collateralAsset: CA, referenceAsset: REF, expiry: "1790000000", recipe: NAV } }, ctx(revertingOracleStub({ lookupWrapper: () => ZERO, "simulate:deploy": () => ORACLE })));
    expect(env.state).toBe("unavailable");
    expect(env.warnings[0]?.code).toBe("recipe_refused");
    expect(env.warnings[0]?.message).toContain("anchorRate");
  });
});
