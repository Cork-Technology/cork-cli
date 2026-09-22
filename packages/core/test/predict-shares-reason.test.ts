// predictShares names WHY a prediction is unavailable. The 2026-09-22 nested fill rehearsal spent
// three runs on a market the FILL rejected (a 1.0 anchor on a NAV pair whose live rate is 1.0901 →
// InvalidRate on the pool manager, RecipeRejectedConstraint from the creator) while the tool said
// only "eth_simulateV1/state overrides unsupported, or config missing". A simulated revert is a fact
// about the MARKET — the same revert the fill would hit — and must reach the caller verbatim; a
// transport failure is about the ENDPOINT and must read as such. Both are pinned here through the
// exact client surface predictShares uses (readContract + simulateCalls), no handler in between.
import { describe, expect, it } from "vitest";
import { encodeErrorResult, parseAbi, type PublicClient } from "viem";
import { predictShares } from "../src/market-registry.ts";
import type { Market8 } from "../src/types.ts";

const ZERO = "0x0000000000000000000000000000000000000000" as const;
const CONTROLLER = "0x66025095Ab3a7E60BA9C2b15e203822d5d3647b5" as const;
const CREATOR = "0x1A074F17647504D1c50B436074a74d051D502dEa" as const;
const PM = "0xcC17224A8710fa23BdA40c2CB563b85CeDDb0C2D" as const;
const POOL_ID = `0x${"11".repeat(32)}` as const;
const market: Market8 = {
  collateralAsset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  referenceAsset: "0x9c6864105AEC23388C89600046213a44C384c831",
  expiryTimestamp: 1_800_000_000n,
  rateMin: 1n,
  rateMax: 2n * 10n ** 18n,
  rateChangePerDayMax: 10n ** 18n,
  rateChangeCapacityMax: 3n * 10n ** 18n,
  rateOracle: "0x995Cc0De84116D559B00Bfdcd589626CB3322f03",
};
const sharesReturn = (cpt: `0x${string}`, cst: `0x${string}`) => `0x${cpt.slice(2).toLowerCase().padStart(64, "0")}${cst.slice(2).toLowerCase().padStart(64, "0")}` as `0x${string}`;

/** A client whose pool manager knows no pool, whose controller answers its own manager, and whose
 *  simulateCalls answers exactly the legs given. */
function clientWith(simulate: (calls: readonly { to: `0x${string}`; data: `0x${string}` }[]) => Promise<Array<{ status: "success" | "failure"; data?: `0x${string}`; error?: unknown }>> | never): PublicClient {
  return {
    readContract: async (a: { address: `0x${string}`; functionName: string }) => {
      if (a.functionName === "CORK_POOL_MANAGER") return PM;
      if (a.functionName === "shares") return [ZERO, ZERO] as const;
      throw new Error(`unexpected read ${a.functionName} at ${a.address}`);
    },
    simulateCalls: async (a: { calls: readonly { to: `0x${string}`; data: `0x${string}` }[] }) => ({ results: await simulate(a.calls) }),
  } as unknown as PublicClient;
}

const base = { adapter: CREATOR, controller: CONTROLLER, poolManager: PM, market, poolId: POOL_ID } as const;

describe("predictShares — the reason a prediction is unavailable", () => {
  it("names the creation leg's DECODED revert: a live rate outside the carried window is InvalidRate on the pool manager", async () => {
    const client = clientWith(async () => [
      { status: "failure", data: encodeErrorResult({ abi: parseAbi(["error InvalidRate()"]), errorName: "InvalidRate" }) },
      { status: "success", data: sharesReturn(ZERO, ZERO) },
    ]);
    const r = await predictShares(client, base);
    expect(r.status).toBe("unavailable");
    expect(r.reason).toContain("controller.createNewPool reverted InvalidRate()");
  });

  it("decodes a creator/recipe error with its arguments (RecipeRejectedConstraint names the recipe)", async () => {
    const recipe = "0xd5e8F76AafA20aA9A8983A35B71Ad3A793070Ed9" as const;
    const client = clientWith(async () => [
      { status: "failure", data: encodeErrorResult({ abi: parseAbi(["error RecipeRejectedConstraint(address recipe)"]), errorName: "RecipeRejectedConstraint", args: [recipe] }) },
      { status: "success", data: sharesReturn(ZERO, ZERO) },
    ]);
    const r = await predictShares(client, base);
    expect(r.reason).toContain(`RecipeRejectedConstraint(${recipe})`);
  });

  it("an unknown selector is reported as the selector, never guessed", async () => {
    const client = clientWith(async () => [
      { status: "failure", data: "0xdeadbeef" },
      { status: "success", data: sharesReturn(ZERO, ZERO) },
    ]);
    const r = await predictShares(client, base);
    expect(r.reason).toContain("reverted with selector 0xdeadbeef");
  });

  it("a failing PRE-leg (the oracle deploy) is named by its position and target", async () => {
    const registry = "0xe1f569f152bDB6eBB2d49cFd9d4aB98ECEe955c5" as const;
    const client = clientWith(async () => [
      { status: "failure", data: encodeErrorResult({ abi: parseAbi(["error EntryNotFound()"]), errorName: "EntryNotFound" }) },
      { status: "success", data: "0x" },
      { status: "success", data: sharesReturn(ZERO, ZERO) },
    ]);
    const r = await predictShares(client, { ...base, preCalls: [{ to: registry, data: "0x00" }] });
    expect(r.reason).toContain(`pre-leg 1 of 1 (${registry}) reverted EntryNotFound()`);
  });

  it("a creation that succeeded but produced no cST at the derived id is an identity disagreement, not a transport fault", async () => {
    const client = clientWith(async () => [
      { status: "success", data: "0x" },
      { status: "success", data: sharesReturn(ZERO, ZERO) },
    ]);
    const r = await predictShares(client, base);
    expect(r.reason).toContain("identity inputs disagree");
  });

  it("a transport that cannot simulate at all says so and carries the endpoint's own message", async () => {
    const client = clientWith(async () => { throw new Error("Method not found: eth_simulateV1"); });
    const r = await predictShares(client, base);
    expect(r.status).toBe("unavailable");
    expect(r.reason).toContain("eth_simulateV1 with state overrides failed on this endpoint: Method not found: eth_simulateV1");
  });

  it("a successful simulation carries NO reason", async () => {
    const cst = "0x7eD666020E7c12b8bcD20F9f56c03724ba85E20b" as const;
    const cpt = "0xb7d72a30DFbc2e05c07811f98eEEcff3f66a0b25" as const;
    const client = clientWith(async () => [
      { status: "success", data: "0x" },
      { status: "success", data: sharesReturn(cpt, cst) },
    ]);
    const r = await predictShares(client, base);
    expect(r).toMatchObject({ status: "simulated", cst, cpt, exists: false });
    expect(r.reason).toBeUndefined();
  });
});
