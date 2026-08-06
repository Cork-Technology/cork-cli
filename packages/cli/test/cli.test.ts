import { describe, expect, it } from "vitest";
import { TOOL_EXAMPLES } from "@cork/schemas";
import { EXIT, runCli } from "@cork/cli";

const NOW = 1_800_000_000n;
const POOL = "0xceebea356e5159c9cb06612c39ef2e6e0fe9cd3bb047541e26e0c0767bd1c16a";
const RCV = "0xc0ffee0000000000000000000000000000000001";

describe("ch CLI", () => {
  it("capabilities prints the tool list, exit 0", async () => {
    const r = await runCli(["capabilities", "--json"], { nowSeconds: NOW });
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

  it("--explain prints a plain-English contract by default (not JSON), exit 0", async () => {
    const r = await runCli(["compute", "--explain"], { nowSeconds: NOW });
    expect(r.code).toBe(EXIT.ok);
    // Human-readable header + variant blocks; explicitly NOT machine JSON.
    expect(r.stdout).toContain("cork_compute  ·  ch compute  ·  phase 1");
    expect(r.stdout).toContain("cst-swap-rate");
    expect(r.stdout).toContain("CORK_EXPLAIN_JSON=1");
    expect(() => JSON.parse(r.stdout)).toThrow();
  });

  it("--explain --json '{}' emits the machine-readable JSON schema, exit 0", async () => {
    const r = await runCli(["compute", "--explain", "--json", "{}"], { nowSeconds: NOW });
    expect(r.code).toBe(EXIT.ok);
    const doc = JSON.parse(r.stdout);
    expect(doc.tool).toBe("cork_compute");
    expect(doc.inputSchema.type).toBe("object");
  });

  it("--explain honors CORK_EXPLAIN_JSON=1 for JSON output, exit 0", async () => {
    const r = await runCli(["query", "--explain"], { nowSeconds: NOW }, { CORK_EXPLAIN_JSON: "1" });
    expect(r.code).toBe(EXIT.ok);
    expect(JSON.parse(r.stdout).tool).toBe("cork_query");
  });

  it("results are prose by default and JSON only on request", async () => {
    const prose = await runCli(["query", "protocol-config"], { nowSeconds: NOW });
    expect(prose.code).toBe(EXIT.ok);
    expect(() => JSON.parse(prose.stdout)).toThrow();
    expect(prose.stdout).toContain("OK");

    const bare = await runCli(["query", "protocol-config", "--json"], { nowSeconds: NOW });
    expect(JSON.parse(bare.stdout).state).toBe("ok");

    const viaEnv = await runCli(["query", "protocol-config"], { nowSeconds: NOW }, { CORK_JSON: "1" });
    expect(JSON.parse(viaEnv.stdout).state).toBe("ok");
  });

  it("supplying input as --json '<object>' still returns JSON, as every documented example assumes", async () => {
    const r = await runCli(["query", "--json", JSON.stringify({ resource: "protocol-config" })], { nowSeconds: NOW });
    expect(r.code).toBe(EXIT.ok);
    expect(JSON.parse(r.stdout).data.resource).toBe("protocol-config");
  });

  it("takes input as a positional plus schema-derived flags", async () => {
    const r = await runCli(["query", "protocol-config", "--chainid", "42161", "--json"], { nowSeconds: NOW });
    expect(r.code).toBe(EXIT.ok);
    const env = JSON.parse(r.stdout);
    expect(env.data.resource).toBe("protocol-config");
    expect(env.data.chainId).toBe(42161);
  });

  it("accepts a flag spelled --chainid, --chain-id or --chainId", async () => {
    for (const spelling of ["--chainid", "--chain-id", "--chainId"]) {
      const r = await runCli(["query", "protocol-config", spelling, "42161", "--json"], { nowSeconds: NOW });
      expect(r.code, spelling).toBe(EXIT.ok);
      expect(JSON.parse(r.stdout).data.chainId, spelling).toBe(42161);
    }
  });

  it("a flag overrides the same key inside --json, so a blob can be reused", async () => {
    const r = await runCli(
      ["query", "--json", JSON.stringify({ resource: "protocol-config", chainId: 1 }), "--chainid", "42161"],
      { nowSeconds: NOW },
    );
    expect(r.code).toBe(EXIT.ok);
    expect(JSON.parse(r.stdout).data.chainId).toBe(42161);
  });

  it("a $ref-typed string field takes a raw flag value — `--account 0x…` without JSON quoting", async () => {
    // account is `$ref: Address` in the schema; before $ref resolution it mis-classified as a
    // JSON flag and demanded `--account '"0x…"'`. authority-revoke is pure byte-building (offline).
    const r = await runCli(
      ["prepare", "phoenix", "1", "--account", RCV, "--clientrequestid", "req-00000002", "--action", JSON.stringify({ type: "authority-revoke", token: RCV, spender: RCV }), "--json"],
      { nowSeconds: NOW },
    );
    expect(r.stderr).not.toContain("invalid_json");
    expect(r.code).toBe(EXIT.ok);
    expect(JSON.parse(r.stdout).state).toBe("ok");
  });

  it("a union-typed field accepts a raw non-JSON string — `--data 0x…` on decode", async () => {
    // decode's data is hex-string-or-object; a bare 0x value must pass through as a string
    // instead of dying at the flag layer with invalid_json.
    const calldata = TOOL_EXAMPLES["cork_decode"]!.find((e) => (e.input as { kind?: string }).kind === "calldata")!.input as { data: string };
    const r = await runCli(["decode", "calldata", "--data", calldata.data, "--chainid", "1", "--json"], { nowSeconds: NOW });
    expect(r.stderr).not.toContain("invalid_json");
    expect(r.code).toBe(EXIT.ok);
    expect(JSON.parse(r.stdout).state).toBe("ok");
  });

  it("a malformed JSON-looking flag value still fails loud with invalid_json", async () => {
    const r = await runCli(["query", "rfqs", "--filters", "{not json", "--json"], { nowSeconds: NOW });
    expect(r.code).toBe(EXIT.invalid);
    expect(r.stderr).toContain("invalid_json");
    expect(r.stderr).toContain("expects JSON");
  });

  it("invalid JSON input → exit 2", async () => {
    const r = await runCli(["decode", "--json", "{not json"], { nowSeconds: NOW });
    expect(r.code).toBe(EXIT.invalid);
    expect(r.stderr).toMatch(/invalid JSON input/);
  });

  it("a failure is prose too, unless JSON was asked for", async () => {
    const prose = await runCli(["decode", "--input", "{not json"], { nowSeconds: NOW });
    expect(prose.code).toBe(EXIT.invalid);
    expect(prose.stderr).toContain("ERROR");
    expect(() => JSON.parse(prose.stderr)).toThrow();

    const json = await runCli(["decode", "--json", "{not json"], { nowSeconds: NOW });
    expect(JSON.parse(json.stderr).error.code).toBe("invalid_json");
  });

  it("schema-invalid input → exit 2", async () => {
    const r = await runCli(["prepare", "phoenix", "--json", JSON.stringify({ chainId: 1, account: "bad", clientRequestId: "x", action: {} })], { nowSeconds: NOW });
    expect(r.code).toBe(EXIT.invalid);
  });

  it("phase-gated tool → exit 3 (unavailable)", async () => {
    // rfq-quote is the LAST deliberately-gated variant (pricing model deferred).
    const r = await runCli(["compute", "--json", JSON.stringify({ params: { kind: "rfq-quote", marketTypeBucket: "stable", durationSeconds: 86400 } })], { nowSeconds: NOW });
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
