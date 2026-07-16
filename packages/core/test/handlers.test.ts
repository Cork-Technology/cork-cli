import { describe, expect, it } from "vitest";
import {
  corkActionCall,
  encodeMulticall,
  runTool,
  ToolInputError,
  MAINNET_DEPLOYMENT,
  type SafeSwapParams,
} from "@cork/core";

const POOL = "0xceebea356e5159c9cb06612c39ef2e6e0fe9cd3bb047541e26e0c0767bd1c16a" as const;
const RCV = "0xc0ffee0000000000000000000000000000000001" as const;
const NOW = 1_800_000_000n; // deterministic clock

describe("runTool: cork_capabilities", () => {
  it("lists all 9 tools with phase + cli", async () => {
    const env = await runTool("cork_capabilities", {}, { nowSeconds: NOW });
    expect(env.state).toBe("ok");
    const data = env.data as { tools: Array<{ name: string; cli: string; phase: number }> };
    expect(data.tools).toHaveLength(9);
    expect(data.tools.map((t) => t.name)).toContain("cork_prepare_phoenix");
    expect(data.tools.find((t) => t.name === "cork_prepare_phoenix")?.cli).toBe("cork prepare phoenix");
  });
});

describe("runTool: cork_decode (calldata)", () => {
  it("decodes a Bundler3 bundle to labeled cork legs", async () => {
    const swap: SafeSwapParams = {
      poolId: POOL,
      collateralAssetsOut: 100n * 10n ** 18n,
      receiver: RCV,
      maxCstSharesIn: 101n * 10n ** 18n,
      maxReferenceAssetsIn: 130n * 10n ** 18n,
      deadline: NOW + 1800n,
    };
    const data = encodeMulticall([corkActionCall(MAINNET_DEPLOYMENT.corkAdapter, "safeSwap", swap)]);
    const env = await runTool("cork_decode", { kind: "calldata", data, format: "concise" }, { nowSeconds: NOW });
    expect(env.state).toBe("ok");
    const legs = (env.data as { legs: Array<{ kind: string; action?: string }> }).legs;
    expect(legs[0]?.kind).toBe("cork");
    expect(legs[0]?.action).toBe("safeSwap");
  });

  it("non-calldata kinds are honestly unavailable", async () => {
    const env = await runTool("cork_decode", { kind: "event", data: {}, format: "concise" }, { nowSeconds: NOW });
    expect(env.state).toBe("unavailable");
    expect(env.warnings[0]?.code).toBe("phase_gated");
  });
});

describe("runTool: cork_compute", () => {
  it("rollover-premium-floor is pure and exact", async () => {
    const env = await runTool(
      "cork_compute",
      { params: { kind: "rollover-premium-floor", dstCstProduced: "1000000000000000000000", minPremiumPerShare: "20000000000000000" }, format: "concise" },
      { nowSeconds: NOW },
    );
    expect(env.state).toBe("ok");
    // 1000e18 * 0.02e18 / 1e18 = 20e18
    expect((env.data as { premiumFloor: string }).premiumFloor).toBe("20000000000000000000");
  });

  it("chain-backed kinds are unavailable without an RPC", async () => {
    const env = await runTool(
      "cork_compute",
      { params: { kind: "impairment-floor", poolId: POOL, horizonSeconds: 86400 }, format: "concise" },
      { nowSeconds: NOW },
    );
    expect(env.state).toBe("unavailable");
    expect(env.warnings[0]?.code).toBe("requires_rpc");
  });
});

describe("runTool: cork_prepare_phoenix", () => {
  it("builds a swap bundle with deterministic deadline + multicall bytes", async () => {
    const env = await runTool(
      "cork_prepare_phoenix",
      {
        chainId: 1,
        account: RCV,
        clientRequestId: "req-00000001",
        action: { type: "swap", poolId: POOL, collateralAssetsOut: "100000000000000000000", receiver: RCV, maxCstSharesIn: "101000000000000000000", maxReferenceAssetsIn: "130000000000000000000" },
        format: "concise",
      },
      { nowSeconds: NOW },
    );
    expect(env.state).toBe("ok");
    const data = env.data as { deadline: string; multicall: string; action: string; corkAdapter: string };
    expect(data.action).toBe("safeSwap");
    expect(data.deadline).toBe((NOW + 1800n).toString());
    expect(data.multicall.startsWith("0x374f435d")).toBe(true); // Bundler3.multicall selector
    expect(env.warnings.some((w) => w.code === "no_funding_leg")).toBe(true);
  });

  it("rejects malformed input with ToolInputError", async () => {
    await expect(
      runTool("cork_prepare_phoenix", { chainId: 1, account: "not-an-address", clientRequestId: "x", action: {}, format: "concise" }, { nowSeconds: NOW }),
    ).rejects.toBeInstanceOf(ToolInputError);
  });
});
