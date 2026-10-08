// track mode:"simulate" — eth_call dry-run of FROZEN prepared bytes (executes nothing).
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

describe("cork_track simulate: a clean answer must mean something", () => {
  // Measured live 2026-10-02: a Base registry call that REVERTS on Base read wouldRevert:false
  // when chainId was omitted — it ran on mainnet, where the target has no code, and a call to an
  // address without code succeeds and does nothing.
  const withCode = (code: string | Error | undefined, callOk: `0x${string}` = "0x"): HandlerContext => ({
    nowSeconds: 1_790_000_000n,
    resolveRpc: async () =>
      stubResolved({
        call: async () => ({ data: callOk }),
        estimateGas: async () => 21_000n,
        getCode: async () => {
          if (code instanceof Error) throw code;
          return code;
        },
      }),
  });
  const run = (input: Record<string, unknown>, c: HandlerContext) => runTool("cork_track", { mode: "simulate", subject: { kind: "artifact", artifact: { to: TO, data: "0xdeadbeef", from: ACCT } }, format: "concise", ...input }, c);

  it("an omitted chainId is said: the artifact carries no chain, and mainnet is a guess", async () => {
    const env = await run({}, withCode("0x6080"));
    expect(env.state).toBe("ok");
    expect(env.provenance.chainId).toBe(1);
    expect(env.warnings.find((w) => w.code === "chainid_defaulted")!.message).toMatch(/simulated on chainId 1 \(mainnet\).*pass the chainId you prepared with/u);
    expect((await run({ chainId: 8453 }, withCode("0x6080"))).warnings.some((w) => w.code === "chainid_defaulted")).toBe(false);
    // Also on the revert branch.
    const reverting: HandlerContext = { nowSeconds: 1_790_000_000n, resolveRpc: async () => stubResolved({ call: async () => { throw new Error("execution reverted: X"); }, estimateGas: async () => 1n }) };
    expect((await run({}, reverting)).warnings.map((w) => w.code)).toEqual(expect.arrayContaining(["chainid_defaulted", "would_revert"]));
  });

  it("a target WITHOUT code: wouldRevert:false is labeled as saying nothing", async () => {
    for (const empty of ["0x", undefined]) {
      const env = await run({ chainId: 8453 }, withCode(empty));
      expect(env.state).toBe("ok");
      expect(env.data).toMatchObject({ wouldRevert: false, targetHasCode: false });
      expect(env.warnings.find((w) => w.code === "unknown_target")!.message).toMatch(new RegExp(`the target ${TO} has NO code on chainId 8453.*wouldRevert:false says nothing`, "u"));
    }
    // A target with code is the expected state and stays quiet.
    const live = await run({ chainId: 8453 }, withCode("0x6080"));
    expect(live.data).toMatchObject({ wouldRevert: false, targetHasCode: true });
    expect(live.warnings.some((w) => w.code === "unknown_target")).toBe(false);
  });

  it("a code read that FAILS is not a verdict, and a plain value transfer (empty data) is not judged", async () => {
    const outage = await run({ chainId: 8453 }, withCode(new Error("fetch failed")));
    expect(outage.state).toBe("ok");
    expect((outage.data as Record<string, unknown>)["targetHasCode"]).toBeUndefined();
    expect(outage.warnings.some((w) => w.code === "unknown_target")).toBe(false);
    const transfer = await runTool("cork_track", { mode: "simulate", chainId: 8453, subject: { kind: "artifact", artifact: { to: TO, data: "0x", from: ACCT } }, format: "concise" }, withCode("0x"));
    expect((transfer.data as Record<string, unknown>)["targetHasCode"]).toBeUndefined();
    expect(transfer.warnings.some((w) => w.code === "unknown_target")).toBe(false);
  });
});
