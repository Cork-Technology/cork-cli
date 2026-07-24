// track mode:"simulate" — eth_call dry-run of FROZEN prepared bytes [K1: executes nothing].
// A revert is a successful simulation whose answer is wouldRevert:true, never a fabricated error.
import { describe, expect, it } from "vitest";
import { runTool, type HandlerContext } from "@cork/core";
import { stubResolved } from "./helpers.ts";

const TO = "0x1FA4431bC113D308beE1d46B0e98Cb805FB48C13";
const ACCT = "0xc0ffee0000000000000000000000000000000001";

function ctx(behavior: { callOk?: `0x${string}`; callThrow?: Error; gas?: bigint }): HandlerContext {
  return {
    nowSeconds: 1_790_000_000n,
    resolveRpc: async () =>
      stubResolved({
        call: async () => {
          if (behavior.callThrow) throw behavior.callThrow;
          return { data: behavior.callOk };
        },
        estimateGas: async () => {
          if (behavior.gas === undefined) throw new Error("estimate unsupported");
          return behavior.gas;
        },
      }),
  };
}

const simulate = (artifact: Record<string, unknown>, c: HandlerContext) =>
  runTool("cork_track", { mode: "simulate", chainId: 42161, subject: { kind: "artifact", artifact }, format: "concise" }, c);

describe("cork_track simulate (frozen-bytes dry-run)", () => {
  it("viable bytes → ok, wouldRevert:false, gas estimate when available", async () => {
    const env = await simulate({ bundler3: TO, multicall: "0x374f435d", account: ACCT }, ctx({ callOk: "0x", gas: 210_000n }));
    expect(env.state).toBe("ok");
    const d = env.data as { wouldRevert: boolean; gasEstimate: string; to: string; from: string };
    expect(d.wouldRevert).toBe(false);
    expect(d.to).toBe(TO);
    expect(d.from).toBe(ACCT);
    expect(BigInt(d.gasEstimate)).toBe(210_000n);
    expect(env.provenance.source).toBe("chain");
  });

  it("reverting bytes → STILL ok, wouldRevert:true + reason + would_revert warning", async () => {
    const env = await simulate({ to: TO, data: "0xdeadbeef", from: ACCT }, ctx({ callThrow: new Error("execution reverted: SAFE_TRANSFER_FROM_FAILED") }));
    expect(env.state).toBe("ok");
    const d = env.data as { wouldRevert: boolean; revertReason: string };
    expect(d.wouldRevert).toBe(true);
    expect(d.revertReason).toContain("SAFE_TRANSFER_FROM_FAILED");
    expect(env.warnings.some((w) => w.code === "would_revert" && w.message.includes("do not sign"))).toBe(true);
  });

  it("gas-estimate failure never spoils a viable call result", async () => {
    const env = await simulate({ to: TO, data: "0x00", account: ACCT }, ctx({ callOk: "0xabcd" }));
    expect(env.state).toBe("ok");
    const d = env.data as { wouldRevert: boolean; returnData: string; gasEstimate?: string };
    expect(d.wouldRevert).toBe(false);
    expect(d.returnData).toBe("0xabcd");
    expect(d.gasEstimate).toBeUndefined();
  });

  it("missing sender → simulated anyway with the fidelity gap disclosed", async () => {
    const env = await simulate({ to: TO, data: "0x00" }, ctx({ callOk: "0x" }));
    expect(env.state).toBe("ok");
    expect(env.warnings.some((w) => w.message.includes("sender-dependent"))).toBe(true);
  });

  it("artifact without target/bytes → teaching missing_filter naming the accepted keys", async () => {
    const env = await simulate({ something: "else" }, ctx({ callOk: "0x" }));
    expect(env.state).toBe("unavailable");
    expect(env.warnings[0]?.code).toBe("missing_filter");
    expect(env.warnings[0]?.message).toContain("bundler3");
  });

  it("non-artifact subjects have nothing executable → explicit gate", async () => {
    const env = await runTool("cork_track", { mode: "simulate", chainId: 42161, subject: { kind: "txHash", txHash: `0x${"11".repeat(32)}` }, format: "concise" }, ctx({ callOk: "0x" }));
    expect(env.state).toBe("unavailable");
    expect(env.warnings[0]?.message).toContain("artifact");
  });

  it("no RPC → requires_rpc, never a fake simulation", async () => {
    const env = await simulate({ to: TO, data: "0x00" }, { nowSeconds: 1n, resolveRpc: async () => null });
    expect(env.state).toBe("unavailable");
    expect(env.warnings[0]?.code).toBe("requires_rpc");
  });
});
