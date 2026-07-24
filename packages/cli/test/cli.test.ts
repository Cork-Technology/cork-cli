import { describe, expect, it } from "vitest";
import { EXIT, runCli } from "@cork/cli";

const NOW = 1_800_000_000n;
const POOL = "0xceebea356e5159c9cb06612c39ef2e6e0fe9cd3bb047541e26e0c0767bd1c16a";
const RCV = "0xc0ffee0000000000000000000000000000000001";

describe("ch CLI", () => {
  it("capabilities prints the tool list, exit 0", async () => {
    const r = await runCli(["capabilities"], { nowSeconds: NOW });
    expect(r.code).toBe(EXIT.ok);
    const env = JSON.parse(r.stdout);
    expect(env.state).toBe("ok");
    expect(env.data.tools).toHaveLength(9);
  });

  it("prepare phoenix (nested command) builds a bundle via --json, exit 0", async () => {
    const input = JSON.stringify({
      chainId: 1,
      account: RCV,
      clientRequestId: "req-00000001",
      action: { type: "swap", poolId: POOL, collateralAssetsOut: "100000000000000000000", receiver: RCV, maxCstSharesIn: "101000000000000000000", maxReferenceAssetsIn: "130000000000000000000" },
    });
    const r = await runCli(["prepare", "phoenix", "--json", input], { nowSeconds: NOW });
    expect(r.code).toBe(EXIT.ok);
    expect(JSON.parse(r.stdout).data.action).toBe("safeSwap");
  });

  it("--explain prints the contract without running, exit 0", async () => {
    const r = await runCli(["compute", "--explain"], { nowSeconds: NOW });
    expect(r.code).toBe(EXIT.ok);
    const doc = JSON.parse(r.stdout);
    expect(doc.tool).toBe("cork_compute");
    expect(doc.inputSchema.type).toBe("object");
  });

  it("invalid --json → exit 2", async () => {
    const r = await runCli(["decode", "--json", "{not json"], { nowSeconds: NOW });
    expect(r.code).toBe(EXIT.invalid);
    expect(r.stderr).toMatch(/invalid --json/);
  });

  it("schema-invalid input → exit 2", async () => {
    const r = await runCli(["prepare", "phoenix", "--json", JSON.stringify({ chainId: 1, account: "bad", clientRequestId: "x", action: {} })], { nowSeconds: NOW });
    expect(r.code).toBe(EXIT.invalid);
  });

  it("phase-gated tool → exit 3 (unavailable)", async () => {
    const r = await runCli(["query", "--json", JSON.stringify({ resource: "whitelisted-addresses" })], { nowSeconds: NOW });
    expect(r.code).toBe(EXIT.unavailable);
    expect(JSON.parse(r.stdout).state).toBe("unavailable");
  });

  it("conflict (track digest mismatch) → exit 4", async () => {
    const wrong = `0x${"0".repeat(64)}`;
    const r = await runCli(
      ["track", "--json", JSON.stringify({ mode: "verify", subject: { kind: "artifact", artifact: { a: 1 } }, expect: { artifactDigest: wrong } })],
      { nowSeconds: NOW },
    );
    expect(r.code).toBe(EXIT.conflict);
    expect(JSON.parse(r.stdout).state).toBe("conflict");
  });

  it("compute rollover-premium-floor via --json, exit 0", async () => {
    const r = await runCli(
      ["compute", "--json", JSON.stringify({ params: { kind: "rollover-premium-floor", dstCstProduced: "1000000000000000000000", minPremiumPerShare: "20000000000000000" } })],
      { nowSeconds: NOW },
    );
    expect(r.code).toBe(EXIT.ok);
    expect(JSON.parse(r.stdout).data.premiumFloor).toBe("20000000000000000000");
  });

  it("F22: an unsafe integer literal in --json is rejected instead of silently losing precision", async () => {
    const r = await runCli(
      ["compute", "--json", '{"params": {"kind": "impairment-floor", "poolId": "0x' + "ab".repeat(32) + '", "horizonSeconds": 2500000000000000001}}'],
      { nowSeconds: NOW },
    );
    expect(r.code).toBe(EXIT.invalid);
    expect(r.stderr).toContain("lose precision");
  });

  it("excess positional arguments error instead of being silently ignored", async () => {
    const r = await runCli(["capabilities", "stray-arg"], { nowSeconds: NOW });
    expect(r.code).toBe(EXIT.invalid);
  });
});
