import { describe, expect, it } from "vitest";
import { REGISTRY, TOOL_EXAMPLES, inputJsonSchema } from "@cork/schemas";
import { EXIT, expandAmount, runCli } from "@cork/cli";
import { poolTokensRpc, stubRpc } from "../../core/test/helpers.ts";
import { privateKeyToAccount } from "viem/accounts";
import { buildMakerOrder, LOP_ADDRESSES, resolveMarketRegistry, unapprovedCodeAllowed } from "@cork/core";
import { DEMO_ACCOUNT } from "@cork/schemas";
import { JIT_TASK_CONSTRAINT, JIT_TASK_PAIR, LIQUIDITY_RECIPE, stubContext } from "../../../evals/stub.ts";

const NOW = 1_800_000_000n;
const POOL = "0xceebea356e5159c9cb06612c39ef2e6e0fe9cd3bb047541e26e0c0767bd1c16a";
const RCV = "0xc0ffee0000000000000000000000000000000001";
const RCV2 = "0xc0ffee0000000000000000000000000000000002";

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
    const r = await runCli(["prepare", "phoenix", "--json", input], { nowSeconds: NOW, resolveRpc: poolTokensRpc() });
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

  it("an object-ONLY field rejects any non-JSON value — the fallback is schema-judged, not value-shaped", async () => {
    // filters admits no string anywhere in its schema, so even an innocent-looking bare word
    // must keep the actionable parse error instead of silently degrading to a type error.
    const r = await runCli(["query", "rfqs", "--filters", "notjson", "--json"], { nowSeconds: NOW });
    expect(r.code).toBe(EXIT.invalid);
    expect(r.stderr).toContain("invalid_json");
  });

  it("a union field's JSON-looking garbage falls through to SCHEMA validation, not the parse error", async () => {
    // decode's data admits a string, so '{bad' is passed through raw and the schema judges it —
    // the failure is invalid_input (teaching), never the flag layer's invalid_json.
    const r = await runCli(["decode", "tx", "--data", "{bad", "--chainid", "1", "--json"], { nowSeconds: NOW });
    expect(r.code).toBe(EXIT.invalid);
    expect(r.stderr).toContain("invalid_input");
    expect(r.stderr).not.toContain("invalid_json");
  });

  it("$ref resolution keeps the property's own description over the $defs one in --help", async () => {
    // account is {$ref: Address, description: "the initiating account…"} — the LOCAL description
    // must win the merge (a swapped spread would show Address's generic "EVM address" instead).
    const r = await runCli(["prepare", "phoenix", "--help"], { nowSeconds: NOW });
    expect(r.stdout).toContain("--account <value>");
    expect(r.stdout).toContain("the initiating account");
  });

  it("positionals are stable across every leaf — grammar changes here must be deliberate", async () => {
    // [command] appears on every tool with a discriminated union (variant subcommands,
    // 2026-08-06); the trailing positional is the legacy form and must keep working.
    const expected: Array<[string[], string]> = [
      [["capabilities"], "Usage: ch capabilities [options]"],
      [["query"], "Usage: ch query [options] [resource]"],
      [["compute"], "Usage: ch compute [options] [command]"],
      [["decode"], "Usage: ch decode [options] [kind]"],
      [["track"], "Usage: ch track [options] [command] [mode]"],
      [["submit"], "Usage: ch submit [options] [command] [chainId]"],
      [["prepare", "pool"], "Usage: ch prepare pool|phoenix [options] [command] [chainId]"],
      [["prepare", "order"], "Usage: ch prepare order|orders [options] [command] [chainId]"],
      [["prepare", "market"], "Usage: ch prepare market [options] [command] [chainId]"],
    ];
    for (const [path, usage] of expected) {
      const r = await runCli([...path, "--help"], { nowSeconds: NOW });
      expect(r.stdout, path.join(" ")).toContain(usage);
    }
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
    // capabilities now takes one operand (search — see the R4 suite below), so the excess-args
    // guard is pinned on a command whose single positional genuinely overflows.
    const r = await runCli(["query", "cork-pools", "stray-arg"], { nowSeconds: NOW });
    expect(r.code).toBe(EXIT.invalid);
  });
});

describe("R4: one synonym resolver across every input path (2026-08-10)", () => {
  it("capabilities takes a bare operand as a SEARCH — its primary use, previously 'too many arguments'", async () => {
    const r = await runCli(["capabilities", "unwind", "--json"], { nowSeconds: NOW });
    expect(r.code).toBe(EXIT.ok);
    const env = JSON.parse(r.stdout);
    expect(env.data.query).toBe("unwind");
    expect(env.data.matches.length).toBeGreaterThan(0);
  });

  it("a canonicalised variant spelling DISPATCHES (rewritten pre-parse) — `unwindDeposit --explain` shows the VARIANT contract, not the parent's", async () => {
    // Before the rewrite, preParse tolerated the spelling but commander fell through to the
    // parent command — and --explain exited 0 showing the WRONG contract (the silent-wrong).
    const r = await runCli(["prepare", "pool", "unwindDeposit", "--explain"], { nowSeconds: NOW });
    expect(r.code).toBe(EXIT.ok);
    expect(r.stdout).toContain("ch prepare pool unwind-deposit");
    expect(r.stdout).not.toContain("cptAndCstSharesOut"); // a sibling variant's field — parent contract would list it
  });

  it("the positional field rides as a flag too: `--resource` works on query (was: unknown option, 'did you mean --source?')", async () => {
    const r = await runCli(["query", "--resource", "pool", "--chain-id", "1", "--json"], { nowSeconds: NOW });
    // cork-pool without filters.poolId is the offline-deterministic outcome — proving the flag
    // fed the resource slot AND the alias table applied on the flag path.
    expect(r.code).toBe(EXIT.unavailable);
    expect(JSON.parse(r.stdout).warnings[0].code).toBe("missing_filter");
  });

  it("resource aliases are case-insensitive, like chain names always were", async () => {
    const r = await runCli(["query", "Pool", "--chain-id", "1", "--json"], { nowSeconds: NOW });
    expect(r.code).toBe(EXIT.unavailable);
    expect(JSON.parse(r.stdout).warnings[0].code).toBe("missing_filter");
  });

  it("top-level verbs accept the chainId positional their long form accepts: `ch exercise 1`", async () => {
    const r = await runCli(["exercise", "1", "--json"], { nowSeconds: NOW });
    expect(r.code).toBe(EXIT.invalid); // account/clientRequestId/pool fields are still missing…
    const payload = JSON.parse(r.stderr);
    const issuePaths = JSON.stringify(payload.error.issues);
    expect(issuePaths).not.toContain("chainId"); // …but chainId was ACCEPTED from the operand
  });

  it("variant subcommands accept it too, with chain-name sugar: `ch prepare pool exercise arbitrum`", async () => {
    const r = await runCli(["prepare", "pool", "exercise", "arbitrum", "--json"], { nowSeconds: NOW });
    expect(r.code).toBe(EXIT.invalid);
    expect(JSON.stringify(JSON.parse(r.stderr).error.issues)).not.toContain("chainId");
  });

  it("enum-valued positionals tolerate canonicalised spellings, judged against the field's own enum", async () => {
    const r = await runCli(["decode", "CALLDATA", "--json", "{}"], { nowSeconds: NOW });
    expect(r.code).toBe(EXIT.invalid); // data is still missing…
    expect(JSON.stringify(JSON.parse(r.stderr).error.issues)).not.toContain('"kind"'); // …but the kind slot resolved
  });
});

describe("variant subcommands (English-first grammar, 2026-08-06)", () => {
  it("routes a variant and merges parent-consumed top-level flags", async () => {
    // account/clientrequestid are ALSO parent flags — commander's traversal binds them to the
    // parent even when written after the variant name; the sub must still see them.
    const r = await runCli(
      ["prepare", "phoenix", "authority-revoke", "--chainid", "1", "--account", RCV, "--clientrequestid", "variant-0001", "--token", RCV, "--spender", RCV, "--json"],
      { nowSeconds: NOW },
    );
    expect(r.stderr).toBe("");
    expect(r.code).toBe(EXIT.ok);
    const env = JSON.parse(r.stdout);
    expect(env.state).toBe("ok");
    expect(env.data.kind).toBe("authority-revoke");
  });

  it("injects the discriminator from the subcommand name — a blob cannot smuggle a different type", async () => {
    const r = await runCli(
      ["prepare", "phoenix", "authority-revoke", "--chainid", "1", "--account", RCV, "--clientrequestid", "variant-0002", "--token", RCV, "--spender", RCV, "--input", JSON.stringify({ action: { type: "swap" } }), "--json"],
      { nowSeconds: NOW },
    );
    expect(r.code).toBe(EXIT.ok);
    expect(JSON.parse(r.stdout).data.kind).toBe("authority-revoke");
  });

  it("mode-then-variant reads in English order — `track verify market-ref` reaches the tool", async () => {
    const r = await runCli(
      ["track", "verify", "market-ref", "--chainid", "1", "--poolid", POOL, "--json"],
      { nowSeconds: NOW, resolveRpc: async () => null },
    );
    expect(r.code).toBe(EXIT.unavailable);
    const env = JSON.parse(r.stdout);
    expect(env.warnings[0].code).toBe("requires_rpc");
  });

  it("chainId-then-variant also shuffles — `prepare phoenix 1 authority-revoke` works", async () => {
    const r = await runCli(
      ["prepare", "phoenix", "1", "authority-revoke", "--account", RCV, "--clientrequestid", "variant-0003", "--token", RCV, "--spender", RCV, "--json"],
      { nowSeconds: NOW },
    );
    expect(r.code).toBe(EXIT.ok);
    expect(JSON.parse(r.stdout).data.kind).toBe("authority-revoke");
  });

  it("variant --explain is scoped to that variant", async () => {
    const r = await runCli(["prepare", "pool", "exercise", "--explain"], { nowSeconds: NOW });
    expect(r.code).toBe(EXIT.ok);
    expect(r.stdout).toContain("ch prepare pool exercise");
    expect(r.stdout).toContain("cstSharesIn");
    expect(r.stdout).not.toContain("authority-onboard");
  });

  it("prepare orders maker-ladder: the composite is a variant subcommand; --rungs takes JSON and the result carries one artifact per rung", async () => {
    const rungs = JSON.stringify([{ takingAmount: "1000000", allowedSender: "0xc0ffee0000000000000000000000000000000002" }, { takingAmount: "950000" }]);
    const r = await runCli(["prepare", "orders", "maker-ladder", "--chain-id", "1", "--account", "0xc0ffee0000000000000000000000000000000001", "--client-request-id", "cli-ladder-0001", "--pool-id", `0x${"ce".repeat(32)}`, "--side", "SELL", "--maker-asset", "0x9D39A5DE30e57443BfF2A8307A4256c8797A3497", "--taker-asset", "0x53E82ABbb12638F09d9e624578ccB666217a765e", "--making-amount", "1e18", "--rungs", rungs, "--json"], { nowSeconds: NOW });
    expect(r.code, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout) as { state: string; data: { kind: string; rungs: Array<{ clientRequestId: string; grouped: boolean }>; capacity: { makerAssetRequired: string } } };
    expect(out.state).toBe("ok");
    expect(out.data.kind).toBe("maker-ladder");
    expect(out.data.rungs.map((x) => x.clientRequestId)).toEqual(["cli-ladder-0001:0", "cli-ladder-0001:1"]);
    expect(out.data.rungs.map((x) => x.grouped)).toEqual([true, false]);
    expect(out.data.capacity.makerAssetRequired).toBe("2000000000000000000");
    const h = await runCli(["prepare", "orders", "maker-ladder", "--help"], { nowSeconds: NOW });
    expect(h.stdout + h.stderr).toContain("--nonce-policy");
  });

  it("variant --help lists the variant's own flattened flags, in kebab-case", async () => {
    const r = await runCli(["prepare", "orders", "taker-fill", "--help"], { nowSeconds: NOW });
    expect(r.stdout).toContain("--order-hash");
    expect(r.stdout).toContain("--for-self");
    expect(r.stdout).toContain("--chain-id"); // top-level fields ride as flags on the sub
  });

  it("a mistyped variant gets a did-you-mean refusal, not a misleading option error", async () => {
    const r = await runCli(["prepare", "phoenix", "exercize", "--chainid", "42161"], { nowSeconds: NOW });
    expect(r.code).toBe(EXIT.invalid);
    expect(r.stderr).toContain("did you mean 'exercise'");
    expect(r.stderr).not.toContain("unknown option");
  });

  it("an --action blob on a variant subcommand is the BASE, variant flags override, disc still injected", async () => {
    const r = await runCli(
      ["prepare", "phoenix", "authority-revoke", "--chainid", "1", "--account", RCV, "--clientrequestid", "variant-0004", "--spender", RCV, "--action", JSON.stringify({ type: "swap", token: RCV }), "--json"],
      { nowSeconds: NOW },
    );
    expect(r.stderr).toBe("");
    expect(r.code).toBe(EXIT.ok);
    expect(JSON.parse(r.stdout).data.kind).toBe("authority-revoke"); // token from blob, type from subcommand
  });

  it("pool/order are CANONICAL; the internal phoenix/orders spellings still route as aliases", async () => {
    // Canonical spelling.
    const canonical = await runCli(
      ["prepare", "pool", "authority-revoke", "--chainid", "1", "--account", RCV, "--clientrequestid", "alias-0001", "--token", RCV, "--spender", RCV, "--json"],
      { nowSeconds: NOW },
    );
    expect(canonical.code).toBe(EXIT.ok);
    expect(JSON.parse(canonical.stdout).data.kind).toBe("authority-revoke");
    // Alias spelling reaches the same command; help shows the canonical usage.
    const alias = await runCli(
      ["prepare", "phoenix", "authority-revoke", "--chainid", "1", "--account", RCV, "--clientrequestid", "alias-0002", "--token", RCV, "--spender", RCV, "--json"],
      { nowSeconds: NOW },
    );
    expect(alias.code).toBe(EXIT.ok);
    const h = await runCli(["prepare", "orders", "taker-fill", "--help"], { nowSeconds: NOW });
    expect(h.stdout).toContain("Usage: ch prepare order taker-fill");
  });

  it("the typo guard also covers alias paths", async () => {
    const r = await runCli(["prepare", "pool", "exercize", "--chainid", "42161"], { nowSeconds: NOW });
    expect(r.code).toBe(EXIT.invalid);
    expect(r.stderr).toContain("did you mean 'exercise'");
  });

  it("resolve-rate-constraint is the outcome-named alias of compute recipe-rate-constraint", async () => {
    // Offline: the missing_filter envelope naming the recipe-rate-constraint kind proves the alias
    // routed to the canonical variant rather than dying as an unknown subcommand.
    const r = await runCli(["compute", "resolve-rate-constraint", "--chain-id", "8453", "--json"], { nowSeconds: NOW });
    expect(r.code).toBe(EXIT.unavailable);
    expect(JSON.parse(r.stdout).warnings[0].message).toMatch(/^recipe-rate-constraint needs/);
  });

  it("the pre-rename deploy-wrapper spelling is NOT a silent alias — it teaches instead", async () => {
    const r = await runCli(
      ["prepare", "market", "deploy-wrapper", "--chainid", "42161", "--clientrequestid", "alias-0002", "--collateral-asset", RCV, "--reference-asset", "0xc0ffee0000000000000000000000000000000002", "--json"],
      { nowSeconds: NOW, resolveRpc: async () => null },
    );
    expect(r.code).toBe(EXIT.invalid);
    expect(r.stderr).toContain("deploy-oracle");
  });

  it("chainId accepts network names — `--chainid arbitrum` means 42161", async () => {
    const r = await runCli(["query", "protocol-config", "--chainid", "arbitrum", "--json"], { nowSeconds: NOW });
    expect(r.code).toBe(EXIT.ok);
    expect(JSON.parse(r.stdout).data.chainId).toBe(42161);
  });

  it("no variant field collides with a top-level field or a reserved flag, in any tool", () => {
    // The registration silently prefers the first occurrence on collision — this lint keeps
    // that branch dead: the registry must never actually contain one.
    const RESERVED = new Set(["json", "input", "rpcurl", "explain", "enabledeprecated", "help"]);
    for (const t of REGISTRY) {
      const s = inputJsonSchema(t.name) as { properties?: Record<string, { oneOf?: unknown[]; anyOf?: unknown[] }> };
      const top = Object.keys(s.properties ?? {});
      const topCanon = new Set(top.map((k) => k.toLowerCase()));
      for (const k of topCanon) expect(RESERVED.has(k), `${t.name}: top-level '${k}' is reserved`).toBe(false);
      for (const [field, node] of Object.entries(s.properties ?? {})) {
        const branches = (node.oneOf ?? node.anyOf ?? []) as Array<{ properties?: Record<string, { const?: unknown }> }>;
        for (const b of branches) {
          const p = b.properties ?? {};
          if (typeof p["type"]?.const !== "string" && typeof p["kind"]?.const !== "string") continue;
          for (const vf of Object.keys(p)) {
            const canon = vf.toLowerCase();
            expect(RESERVED.has(canon), `${t.name}.${field}: variant field '${vf}' is reserved`).toBe(false);
            expect(topCanon.has(canon) && vf !== "type" && vf !== "kind", `${t.name}.${field}: variant field '${vf}' collides with a top-level field`).toBe(false);
          }
        }
      }
    }
  });
});

describe("amount sugar (exact, no floats)", () => {
  it("expands scientific notation and underscores exactly", () => {
    expect(expandAmount("1000e18")).toEqual({ ok: `1${"0".repeat(21)}` });
    expect(expandAmount("1e18")).toEqual({ ok: `1${"0".repeat(18)}` });
    expect(expandAmount("1.5e18")).toEqual({ ok: `15${"0".repeat(17)}` });
    expect(expandAmount("0.5e18")).toEqual({ ok: `5${"0".repeat(17)}` });
    expect(expandAmount("1_000")).toEqual({ ok: "1000" });
    expect(expandAmount("1_000e6")).toEqual({ ok: "1000000000" });
    expect(expandAmount("123456")).toEqual({ ok: "123456" });
  });

  it("refuses sugar that cannot expand to an integer, and absurd exponents", () => {
    expect("err" in expandAmount("1.23e1")).toBe(true);
    expect("err" in expandAmount("1e101")).toBe(true);
  });

  it("passes non-sugar values through untouched for the schema to judge", () => {
    expect(expandAmount("abc")).toEqual({ ok: "abc" });
    expect(expandAmount("1.5")).toEqual({ ok: "1.5" });
  });

  it("works end-to-end on a money field — floor math stays wei-exact", async () => {
    const r = await runCli(
      ["compute", "rollover-premium-floor", "--dstcstproduced", "1000e18", "--minpremiumpershare", "12e15", "--json"],
      { nowSeconds: NOW },
    );
    expect(r.code).toBe(EXIT.ok);
    expect(JSON.parse(r.stdout).data.premiumFloor).toBe("12000000000000000000");
  });

  it("a fractional-remainder amount fails loud with invalid_amount, exit 2", async () => {
    const r = await runCli(
      ["compute", "rollover-premium-floor", "--dstcstproduced", "1.23e1", "--minpremiumpershare", "12e15", "--json"],
      { nowSeconds: NOW },
    );
    expect(r.code).toBe(EXIT.invalid);
    expect(r.stderr).toContain("invalid_amount");
  });

  it("sugar applies to FLAGS only — JSON blobs stay the exact wire form", async () => {
    const r = await runCli(
      ["compute", "--json", JSON.stringify({ params: { kind: "rollover-premium-floor", dstCstProduced: "1000e18", minPremiumPerShare: "12000000000000000" } })],
      { nowSeconds: NOW },
    );
    expect(r.code).toBe(EXIT.invalid); // schema pattern rejects the sugar inside the blob
  });
});

describe("top-level verbs, resource singulars, and filter flags (2026-08-06)", () => {
  const MAINNET_POOL = "0xd16e343d58ab0d5985086dfd4ff8128ea714be3c1275184f1bf11c0ede02cf05";

  it("ch exercise is a top-level verb equal to prepare pool exercise", async () => {
    const r = await runCli(
      ["exercise", "--chain-id", "1", "--account", RCV, "--client-request-id", "verb-0001", "--pool-id", POOL, "--cst-shares-in", "1000e18", "--receiver", RCV, "--min-collateral-assets-out", "1", "--max-reference-assets-in", "1000000", "--json"],
      { nowSeconds: NOW, resolveRpc: poolTokensRpc() },
    );
    expect(r.stderr).toBe("");
    expect(r.code).toBe(EXIT.ok);
    const env = JSON.parse(r.stdout);
    expect(env.state).toBe("ok");
    expect(env.data.action).toBe("safeExercise");
  });

  it("root help lists the pool verbs and fill; verbs advertise their canonical spelling", async () => {
    const r = await runCli(["--help"], { nowSeconds: NOW });
    // ALL 13 pool actions + fill — a silently-skipped registration (name collision with a
    // future command) must fail this lint, not vanish.
    const VERBS = ["mint", "deposit", "unwind-deposit", "unwind-mint", "withdraw", "withdraw-other", "redeem", "swap", "exercise", "exercise-other", "unwind-swap", "unwind-exercise", "unwind-exercise-other", "fill"];
    for (const verb of VERBS) {
      expect(r.stdout).toMatch(new RegExp(`^  ${verb} `, "m"));
    }
    // Root-list descriptions wrap; the canonical-spelling pointer shows in the verb's own help.
    const h = await runCli(["exercise", "--help"], { nowSeconds: NOW });
    expect(h.stdout).toContain("(= ch prepare pool exercise)");
    const hf = await runCli(["fill", "--help"], { nowSeconds: NOW });
    expect(hf.stdout).toContain("(= ch prepare order taker-fill)");
  });

  it("ch fill --explain documents taker-fill under the canonical path", async () => {
    const r = await runCli(["fill", "--explain"], { nowSeconds: NOW });
    expect(r.stdout).toContain("ch prepare order taker-fill");
    expect(r.stdout).toContain("taker-fill");
  });

  it("authority ops stay namespaced — no top-level authority-onboard", async () => {
    const r = await runCli(["authority-onboard", "--chain-id", "1"], { nowSeconds: NOW });
    expect(r.code).not.toBe(EXIT.ok);
    expect(r.stderr).toContain("unknown command");
  });

  it("ch query rfq reads the rfqs feed (singular alias, flag and positional)", async () => {
    const seen: string[] = [];
    const venueFetch = async (url: string): Promise<Response> => {
      seen.push(url);
      return new Response(JSON.stringify({ items: [] }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const r = await runCli(["query", "rfq", "--json"], { nowSeconds: NOW, venueFetch });
    expect(r.code).toBe(EXIT.ok);
    expect(JSON.parse(r.stdout).data.resource).toBe("rfqs");
    expect(seen.some((u) => u.includes("/rfqs"))).toBe(true);
  });

  it("a taxonomy-agreeing shorthand routes to the terminal resource (derive-pool → derive-cork-pool)", async () => {
    // Offline: derive-cork-pool without its required filters is a missing_filter envelope — an
    // envelope AT ALL proves the shorthand passed schema validation as the new resource.
    for (const ali of ["rollover-orders", "pool-migration-orders", "extend-expiry-orders"]) {
      const ro = await runCli(["query", ali, "--chain-id", "1", "--kind", "bogus", "--json"], { nowSeconds: NOW });
      expect(JSON.stringify(JSON.parse(ro.stderr).error.issues), ali).toContain("'orders' | 'fills' | 'contracts'"); // reached rollover-orders' own kind validation, offline
    }
    const op = await runCli(["query", "orderbook-pairs", "--chain-id", "1", "--mode", "lite-decentralized", "--json"], { nowSeconds: NOW });
    expect(JSON.parse(op.stdout).warnings[0].message, "orderbook-pairs").toContain("trading-pairs"); // the mode gate names the terminal resource, offline
    for (const [ali, canon] of [["registered-assets", "registry-assets"], ["registered-recipes", "registry-recipes"], ["registered-denominations", "registry-denominations"], ["registered-feeds", "registry-feeds"], ["market-recipes", "registry-recipes"], ["asset-pair-oracle", "registry-oracle"]] as const) {
      const rr = await runCli(["query", ali, "--chain-id", "1", "--json"], { nowSeconds: NOW, resolveRpc: async () => null });
      const env = JSON.parse(rr.stdout);
      expect(env.warnings[0].code, ali).toBe("unknown_deployment"); // routed to the registry handler (no registry on chain 1), offline
      void canon;
    }
    // A REAL decode through the alias: the old assertion (error.tool on malformed data) held
    // whether or not the alias resolved, which is how `decode limit-order` shipped dead.
    const ORDER_JSON = JSON.stringify({
      salt: "1",
      maker: "0xc0ffee0000000000000000000000000000000001",
      receiver: "0x0000000000000000000000000000000000000000",
      makerAsset: "0x9D39A5DE30e57443BfF2A8307A4256c8797A3497",
      takerAsset: "0x53E82ABbb12638F09d9e624578ccB666217a765e",
      makingAmount: "1000000000000000000",
      takingAmount: "1000000",
      makerTraits: "0",
    });
    const dl = await runCli(["decode", "limit-order", "--data", ORDER_JSON, "--chainid", "1", "--json"], { nowSeconds: NOW });
    expect(dl.code, "limit-order -> decode order").toBe(EXIT.ok);
    expect(JSON.parse(dl.stdout).data.kind, "limit-order routed to kind order").toBe("order");
    const lo = await runCli(["query", "limit-orders", "--chain-id", "1", "--pool-id", "notahex", "--json"], { nowSeconds: NOW });
    expect(JSON.parse(lo.stderr).error.issues[0].path, "limit-orders -> orderbook").toContain("filters"); // reached orderbook's filter validation
    const mi = await runCli(["query", "market-instance", "--chain-id", "42161", "--json"], { nowSeconds: NOW });
    expect(JSON.parse(mi.stdout).warnings[0].message).toContain("cork-pool"); // market-instance → cork-pool (missing_filter names the terminal resource)
    const r = await runCli(["query", "derive-pool", "--chain-id", "42161", "--json"], { nowSeconds: NOW });
    expect(r.code).toBe(EXIT.unavailable);
    const env = JSON.parse(r.stdout);
    expect(env.warnings[0].code).toBe("missing_filter");
    expect(env.warnings[0].message).toMatch(/^derive-cork-pool requires/);
  });

  it("PRE-RENAME values are NOT silent aliases — the positional form teaches the rename too", async () => {
    // Old names must never quietly work: without an alias entry, `ch query market` falls
    // through to the wire schema and gets the same renamed-to teaching a blob would.
    for (const [old, renamed] of [["market", "cork-pool"], ["markets", "cork-pools"], ["derive-market", "derive-cork-pool"], ["market-predict", "derive-cork-pool"], ["limit-order-markets", "trading-pairs"], ["flows", "rollover-orders"]] as const) {
      const r = await runCli(["query", old, "--chain-id", "42161", "--json"], { nowSeconds: NOW });
      expect(r.code, old).toBe(EXIT.invalid);
      const payload = JSON.parse(r.stderr);
      expect(payload.error.issues[0].suggestion, old).toBe(`"${old}" was renamed to "${renamed}"`);
    }
  });

  it("an OLD wire value in a blob teaches the rename — in prose AND in the JSON issues shape", async () => {
    const argvBase = ["query", "--input", JSON.stringify({ resource: "market-predict", chainId: 42161 })];
    const prose = await runCli(argvBase, { nowSeconds: NOW });
    expect(prose.code).toBe(EXIT.invalid);
    expect(prose.stderr).toContain('"market-predict" was renamed to "derive-cork-pool"');
    const json = await runCli([...argvBase, "--json"], { nowSeconds: NOW });
    const payload = JSON.parse(json.stderr);
    // Teaching issues ARE the issues (path/expected/received/suggestion) — the documented shape.
    expect(payload.error.issues[0].suggestion).toBe('"market-predict" was renamed to "derive-cork-pool"');
    expect(payload.error.issues[0].path).toBe("resource");
  });

  it("prose enum-typo help prints the suggestion sentence verbatim (no double wrapping)", async () => {
    const r = await runCli(["query", "--input", JSON.stringify({ resource: "orderbok", chainId: 1 })], { nowSeconds: NOW });
    expect(r.stderr).toContain('did you mean "orderbook"?');
    expect(r.stderr).not.toContain("did you mean did you mean");
  });

  it("`ch prepare <action>` names the namespace that owns the action instead of a bare unknown-command", async () => {
    // The dead zone: `ch exercise` and `ch prepare pool exercise` both worked while the natural
    // middle spelling got commander's raw "unknown command 'exercise'" with no route.
    const r = await runCli(["prepare", "exercise"], { nowSeconds: NOW });
    expect(r.code).toBe(EXIT.invalid);
    expect(r.stderr).toContain("ch prepare pool exercise");
    expect(r.stderr).toContain("ch exercise"); // the top-level shortcut is named too
    // An order action routes to its own namespace, not pool's.
    const m = await runCli(["prepare", "maker-order"], { nowSeconds: NOW });
    expect(m.code).toBe(EXIT.invalid);
    expect(m.stderr).toContain("ch prepare order maker-order");
    // A group-level typo still gets a did-you-mean with the full path (the prose renderer
    // wraps long lines, so compare with whitespace collapsed).
    const t = await runCli(["prepare", "exercize"], { nowSeconds: NOW });
    expect(t.code).toBe(EXIT.invalid);
    expect(t.stderr.replace(/\s+/g, " ")).toContain("did you mean 'exercise'");
    expect(t.stderr.replace(/\s+/g, " ")).toContain("ch prepare pool exercise");
    // Legal spellings are untouched by the group check.
    const ok = await runCli(["prepare", "pool", "exercise", "--explain"], { nowSeconds: NOW });
    expect(ok.code).toBe(EXIT.ok);
  });

  it("variant-subcommand path teaches RENAMED_VALUES (previously blob-only teaching)", async () => {
    const r = await runCli(["compute", "resolve-recipe"], { nowSeconds: NOW });
    expect(r.code).toBe(EXIT.invalid);
    expect(r.stderr).toContain("'resolve-recipe' was renamed to 'recipe-rate-constraint'");
    const m = await runCli(["prepare", "market", "deploy-wrapper"], { nowSeconds: NOW });
    expect(m.code).toBe(EXIT.invalid);
    expect(m.stderr).toContain("'deploy-wrapper' was renamed to 'deploy-oracle'");
  });

  it("`ch prepare order fill` is an alias of taker-fill (the word the top-level verb already uses)", async () => {
    const r = await runCli(["prepare", "order", "fill", "--explain"], { nowSeconds: NOW });
    expect(r.code).toBe(EXIT.ok);
    expect(r.stdout).toContain("taker-fill");
  });

  it("digits-only filter flags take the same amount sugar as schema-derived amount flags", async () => {
    // Before: `--rate 1e18` was refused by a message that itself said "(1e18 = 1.0)".
    const r = await runCli(["query", "registry-oracle", "--chain-id", "42161", "--rate", "1.05e18", "--json"], { nowSeconds: NOW, resolveRpc: async () => null });
    // Parse must SUCCEED (sugar expanded) — the offline gate is requires_rpc, not invalid_input.
    expect(r.code).toBe(EXIT.unavailable);
    expect(JSON.parse(r.stdout).warnings[0].code).toBe("requires_rpc");
    // Fractional remainder still refuses loudly, same as amount flags.
    const bad = await runCli(["query", "registry-oracle", "--chain-id", "42161", "--rate", "1.055e2", "--json"], { nowSeconds: NOW, resolveRpc: async () => null });
    expect(bad.code).toBe(EXIT.invalid);
    expect(JSON.parse(bad.stderr).error.code).toBe("invalid_amount");
  });

  it("filter keys are first-class flags landing under filters.*", async () => {
    // A malformed value fails at filters.poolId — proof the flag routed INTO filters.
    const r = await runCli(["query", "orderbook", "--chain-id", "1", "--pool-id", "notahex", "--json"], { nowSeconds: NOW });
    expect(r.code).toBe(EXIT.invalid);
    const payload = JSON.parse(r.stderr);
    expect(payload.error.code).toBe("invalid_input");
    expect(JSON.stringify(payload.error.issues)).toContain("filters");
  });

  it("a filter flag overrides the same key in a --filters blob", async () => {
    const r = await runCli(
      ["query", "orderbook", "--chain-id", "1", "--filters", JSON.stringify({ poolId: MAINNET_POOL }), "--pool-id", "notahex", "--json"],
      { nowSeconds: NOW },
    );
    expect(r.code).toBe(EXIT.invalid);
    expect(JSON.stringify(JSON.parse(r.stderr).error.issues)).toContain("poolId");
  });

  it("--mode on query stays the TOP-LEVEL data mode, never filters.mode", async () => {
    // "price" is a valid filters.mode but NOT a data mode — binding to the top level must reject it.
    const r = await runCli(["query", "registry-oracle", "--chain-id", "42161", "--mode", "price", "--json"], { nowSeconds: NOW });
    expect(r.code).toBe(EXIT.invalid);
    expect(JSON.stringify(JSON.parse(r.stderr).error.issues)).toContain("mode");
  });

  // filters.mode is the one filter key whose bare name collides with a top-level field, so it
  // rides under the ALIASED flag --oracle-mode. Routing proof: a bogus value must reach the
  // registry-oracle handler's own mode gate (which fires BEFORE any chain read) and come back
  // as ITS missing_filter teaching — not as a top-level schema error, not silently dropped.
  const oracleModeCtx = () => ({
    nowSeconds: NOW,
    resolveRpc: (async () => ({ client: { readContract: async () => { throw new Error("unreached"); } } }) as never) as never,
  });

  it("--oracle-mode routes into filters.mode (the aliased flag for the colliding key)", async () => {
    const r = await runCli(
      ["query", "registry-oracle", "--chain-id", "42161", "--collateral-asset", RCV, "--reference-asset", RCV2, "--oracle-mode", "bogus", "--json"],
      oracleModeCtx(),
    );
    expect(r.code).toBe(EXIT.unavailable);
    const env = JSON.parse(r.stdout);
    expect(env.warnings[0].code).toBe("missing_filter");
    expect(env.warnings[0].message).toContain("filters.mode");
    expect(env.warnings[0].message).toContain("bogus");
  });

  it("--oracle-mode overrides filters.mode from a --filters blob", async () => {
    const r = await runCli(
      ["query", "registry-oracle", "--chain-id", "42161", "--collateral-asset", RCV, "--reference-asset", RCV2, "--filters", JSON.stringify({ mode: "price" }), "--oracle-mode", "bogus", "--json"],
      oracleModeCtx(),
    );
    expect(r.code).toBe(EXIT.unavailable);
    expect(JSON.parse(r.stdout).warnings[0].message).toContain("bogus");
  });

  it("query --help advertises --oracle-mode with its collision note", async () => {
    const r = await runCli(["query", "--help"], { nowSeconds: NOW });
    expect(r.stdout).toContain("--oracle-mode");
    expect(r.stdout).toContain("filters.mode");
  });
});

describe("audit R5/R6/R7 — one numeric dialect, one error contract, the swallowed positional", () => {
  it("R5: integer-typed flags take the SAME sugar dialect as amount flags (1_0 and 1e1 both = 10)", async () => {
    // Before: Number("1e1") accepted float notation by accident while "1_0" failed — two flags
    // on one subcommand spoke different dialects. protocol-config validates pageSize offline.
    for (const spelling of ["1_0", "1e1", "10"]) {
      const r = await runCli(["query", "protocol-config", "--page-size", spelling, "--json"], { nowSeconds: NOW });
      expect(r.code, spelling).toBe(EXIT.ok);
    }
  });

  it("R5: sugar that expands beyond the safe integer range of a JSON-number field is refused with teaching", async () => {
    const r = await runCli(["query", "protocol-config", "--page-size", "1e18", "--json"], { nowSeconds: NOW });
    expect(r.code).toBe(EXIT.invalid);
    const payload = JSON.parse(r.stderr);
    expect(payload.error.code).toBe("invalid_amount");
    expect(payload.error.message).toContain("safe integer range");
    expect(payload.error.message).toContain("not token amounts");
  });

  it("R5: an in-range expansion still lands in schema validation, not a silent clamp (1e3 vs max 200)", async () => {
    const r = await runCli(["query", "protocol-config", "--page-size", "1e3", "--json"], { nowSeconds: NOW });
    expect(r.code).toBe(EXIT.invalid); // 1000 > the schema's max 200 — the schema teaches, sugar just expands
  });

  it("R6: a commander-level error is the structured JSON payload under CORK_JSON=1, not plain text", async () => {
    const r = await runCli(["query", "protocol-config", "--frobnicate"], { nowSeconds: NOW }, { CORK_JSON: "1" });
    expect(r.code).toBe(EXIT.invalid);
    const payload = JSON.parse(r.stderr); // the whole point: stderr must PARSE
    expect(payload.error.code).toBe("invalid_input");
    expect(payload.error.message).toContain("frobnicate");
  });

  it("R6: bare --json reaches the same contract for commander errors (pre-option-binding intent)", async () => {
    const r = await runCli(["query", "protocol-config", "--json", "--frobnicate"], { nowSeconds: NOW });
    expect(r.code).toBe(EXIT.invalid);
    expect(JSON.parse(r.stderr).error.code).toBe("invalid_input");
  });

  it("R6: without JSON intent the plain-text commander error is unchanged", async () => {
    const r = await runCli(["query", "protocol-config", "--frobnicate"], { nowSeconds: NOW });
    expect(r.code).toBe(EXIT.invalid);
    expect(r.stderr).toContain("frobnicate");
    expect(() => JSON.parse(r.stderr)).toThrow(); // plain text, deliberately
  });

  it("R7: a bare --json that swallowed a positional teaches the reorder instead of a bare parse error", async () => {
    const r = await runCli(["query", "--json", "pools"], { nowSeconds: NOW });
    expect(r.code).toBe(EXIT.invalid);
    const payload = JSON.parse(r.stderr);
    expect(payload.error.code).toBe("invalid_json");
    expect(payload.error.message).toContain("swallowed");
    expect(payload.error.message).toContain("pools --json"); // the exact corrected spelling
  });

  it("R7: genuinely malformed JSON keeps the plain parse error (no false reorder hint)", async () => {
    const r = await runCli(["query", "--json", "{not json"], { nowSeconds: NOW });
    expect(r.code).toBe(EXIT.invalid);
    expect(JSON.parse(r.stderr).error.message).not.toContain("swallowed");
  });
});

describe("code-smell audit fixes (2026-08-11)", () => {
  it("--enable-deprecated does not leak CORK_ENABLE_DEPRECATED into later runCli calls", async () => {
    const prev = process.env["CORK_ENABLE_DEPRECATED"];
    delete process.env["CORK_ENABLE_DEPRECATED"];
    try {
      const r = await runCli(["capabilities", "--enable-deprecated"], { nowSeconds: NOW });
      expect(r.code).toBe(EXIT.ok);
      // runCli is capture-everything/never-exit: one flagged call must not unlock the
      // deprecation gate for every later call in the same process (tests, embedding).
      expect(process.env["CORK_ENABLE_DEPRECATED"]).toBeUndefined();
    } finally {
      if (prev !== undefined) process.env["CORK_ENABLE_DEPRECATED"] = prev;
    }
  });

  it("CORK_EXPLAIN_JSON speaks the same strict dialect as CORK_JSON ('true' works, 'yes' does not)", async () => {
    const asTrue = await runCli(["query", "--explain"], { nowSeconds: NOW }, { CORK_EXPLAIN_JSON: "true" });
    expect(() => JSON.parse(asTrue.stdout)).not.toThrow();
    const asYes = await runCli(["query", "--explain"], { nowSeconds: NOW }, { CORK_EXPLAIN_JSON: "yes" });
    expect(() => JSON.parse(asYes.stdout)).toThrow(); // prose — 'yes' is not a CORK_* truthy value
  });
});

describe("ch query orderbook --watch (2026-09-02)", () => {
  // Real signed rows so the ranked read (hash re-check, traits decode) is the production path;
  // the venue is a stub whose book grows between reads; the chain a stub answering "live".
  const LOP = LOP_ADDRESSES[1]!;
  const maker = privateKeyToAccount(`0x${"2f".repeat(32)}`);
  const ME = "0xc0ffee0000000000000000000000000000000001";
  const bookRow = async (id: string, taking: bigint) => {
    const built = buildMakerOrder({ chainId: 1, lop: LOP, maker: maker.address, makerAsset: "0x16Aa2EbE1E2D6C856c634DaFc256257d2fEc0C69", takerAsset: "0x9D39A5DE30e57443BfF2A8307A4256c8797A3497", makingAmount: 10n ** 18n, takingAmount: taking, clientRequestId: id });
    const o = built.order;
    return { orderHash: built.orderHash, order: { salt: o.salt.toString(), maker: o.maker, receiver: o.receiver, makerAsset: o.makerAsset, takerAsset: o.takerAsset, makingAmount: o.makingAmount.toString(), takingAmount: o.takingAmount.toString(), makerTraits: o.makerTraits.toString() }, signature: await maker.sign({ hash: built.orderHash }), extension: "0x", makerAccountType: "EOA", side: "SELL", status: "OPEN" };
  };
  const venueSeq = (books: unknown[][]) => {
    let call = 0;
    return async (url: string) => {
      if (!url.includes("/limit-orders/v1/orderbook")) return new Response(JSON.stringify({ items: [] }), { status: 200 });
      return new Response(JSON.stringify({ items: books[Math.min(call++, books.length - 1)], hasMore: false }), { status: 200 });
    };
  };
  const live = stubRpc((c) => { if (c.functionName === "bitInvalidatorForOrder") return 0n; throw new Error(`no stub for ${c.functionName}`); });

  it("prints the first read, stays quiet on an unchanged tick, prints the tick a better order appears, and threads the watermark", async () => {
    const old = await bookRow("cw-1", 5n * 10n ** 16n);
    const cheaper = await bookRow("cw-2", 4n * 10n ** 16n);
    const sleeps: number[] = [];
    const r = await runCli(["query", "orderbook", "--chain-id", "1", "--account", ME, "--watch", "--interval", "3", "--iterations", "3", "--json"], { nowSeconds: NOW, venueFetch: venueSeq([[old], [old], [old, cheaper]]), resolveRpc: live, sleep: async (ms) => { sleeps.push(ms); } });
    expect(r.code).toBe(EXIT.ok);
    // Two JSON documents on stdout: tick 1 (the book) and tick 3 (the change); tick 2 was silent.
    const docs = r.stdout.trim().split("\n}\n").map((d, i, all) => JSON.parse(i < all.length - 1 ? `${d}\n}` : d));
    expect(docs.map((d: { tick: number }) => d.tick)).toEqual([1, 3]);
    expect(docs[0].data.changes).toBeUndefined();
    expect(docs[1].data.changes.changed).toBe(true);
    expect(docs[1].data.changes.better.map((b: { orderHash: string }) => b.orderHash)).toEqual([cheaper.orderHash.toLowerCase()]);
    expect(sleeps).toEqual([3000, 3000]); // paced between reads, never after the last
  });

  it("prose: a changed tick prints only the changes and the next watermark, headed by its tick number", async () => {
    const old = await bookRow("cw-3", 5n * 10n ** 16n);
    const cheaper = await bookRow("cw-4", 4n * 10n ** 16n);
    const r = await runCli(["query", "orderbook", "--chain-id", "1", "--account", ME, "--watch", "--iterations", "2"], { nowSeconds: NOW, venueFetch: venueSeq([[old], [old, cheaper]]), resolveRpc: live, sleep: async () => {} });
    expect(r.code).toBe(EXIT.ok);
    expect(r.stdout).toContain("watch tick 2");
    expect(r.stdout).toContain("better");
    expect(r.stdout.split("watch tick 2")[1]).toContain("watermark: bw1.");
  });

  it("refuses --watch off the orderbook, alongside --since/--wait, and with a bad interval — exit 2, nothing read", async () => {
    let calls = 0;
    const venueFetch = async () => { calls++; return new Response(JSON.stringify({ items: [] }), { status: 200 }); };
    const off = await runCli(["query", "rfqs", "--chain-id", "1", "--watch", "--json"], { nowSeconds: NOW, venueFetch });
    expect(off.code).toBe(EXIT.invalid);
    expect(JSON.parse(off.stderr).error.issues[0].message).toContain("orderbook");
    const both = await runCli(["query", "orderbook", "--chain-id", "1", "--watch", "--wait", "5", "--json"], { nowSeconds: NOW, venueFetch });
    expect(both.code).toBe(EXIT.invalid);
    const bad = await runCli(["query", "orderbook", "--chain-id", "1", "--watch", "--interval", "0", "--json"], { nowSeconds: NOW, venueFetch });
    expect(bad.code).toBe(EXIT.invalid);
    expect(calls).toBe(0);
  });

  it("--since and --wait are ordinary flags without --watch: one read, one long-poll, the same envelope as MCP", async () => {
    const old = await bookRow("cw-5", 5n * 10n ** 16n);
    const first = await runCli(["query", "orderbook", "--chain-id", "1", "--account", ME, "--json"], { nowSeconds: NOW, venueFetch: venueSeq([[old]]), resolveRpc: live });
    const wm = JSON.parse(first.stdout).data.watermark as string;
    expect(wm.startsWith("bw1.")).toBe(true);
    const polled = await runCli(["query", "orderbook", "--chain-id", "1", "--account", ME, "--since", wm, "--wait", "3", "--json"], { nowSeconds: NOW, venueFetch: venueSeq([[old]]), resolveRpc: live, sleep: async () => {} });
    expect(polled.code).toBe(EXIT.ok);
    expect(JSON.parse(polled.stdout).data.waited).toMatchObject({ pollsMade: 2, changed: false, endedBy: "timeout" });
  });
});

describe("--allow-unapproved-code — the bytes-decoder gate's operator override (2026-09-03)", () => {
  // The eval stub's full chain with ONE view replaced: the JIT adapter's code hashes off the list.
  const OFF_LIST_CODE = "0x60806040deadbeef";
  const offListAdapter = () => {
    const base = stubContext();
    return {
      ...base,
      resolveRpc: async (chainId: 42161, url: string | undefined) => {
        const r = await base.resolveRpc!(chainId, url);
        if (!r) return r;
        const adapter = (await resolveMarketRegistry(chainId)).marketRegistry!.adapter!.toLowerCase();
        const client = r.client as unknown as { getCode: (a: { address?: string }) => Promise<string> } & Record<string, unknown>;
        return { ...r, client: { ...client, getCode: async (a: { address?: string }) => (String(a?.address ?? "").toLowerCase() === adapter ? OFF_LIST_CODE : client.getCode(a)) } as never };
      },
    };
  };
  const input = JSON.stringify({ chainId: 42161, account: DEMO_ACCOUNT, clientRequestId: "cli-gate-0001", action: { type: "maker-order", poolId: `0x${"ce".repeat(32)}`, side: "SELL", makerAsset: "0x16Aa2EbE1E2D6C856c634DaFc256257d2fEc0C69", takerAsset: JIT_TASK_PAIR.collateralAsset, makingAmount: "1000000000000000000", takingAmount: "50000000000000000", jitMarket: { ...JIT_TASK_PAIR, expiryTimestamp: (1_790_000_000n + 20n * 86_400n).toString(), recipe: LIQUIDITY_RECIPE, constraint: JIT_TASK_CONSTRAINT } } });

  it("without the flag the JIT order is refused (conflict, exit 4); with it the order builds, labeled, and the setting is restored afterwards", async () => {
    const refused = await runCli(["prepare", "orders", "--json", input], offListAdapter() as never);
    expect(refused.code).toBe(EXIT.conflict);
    expect(JSON.parse(refused.stdout).warnings[0].code).toBe("implementation_not_approved");
    const built = await runCli(["prepare", "orders", "--allow-unapproved-code", "--json", input], offListAdapter() as never);
    expect(built.code).toBe(EXIT.ok);
    const env = JSON.parse(built.stdout);
    expect(env.data.typedData).toBeDefined();
    expect(env.warnings.some((w: { code: string }) => w.code === "implementation_gate_bypassed")).toBe(true);
    expect(unapprovedCodeAllowed()).toBe(false); // the flag never leaks past its own invocation
    const again = await runCli(["prepare", "orders", "--json", input], offListAdapter() as never);
    expect(again.code).toBe(EXIT.conflict);
  });
});
