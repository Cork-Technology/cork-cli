import { describe, expect, it } from "vitest";
import { REGISTRY, TOOL_EXAMPLES, inputJsonSchema } from "@cork/schemas";
import { EXIT, expandAmount, runCli } from "@cork/cli";

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
    const r = await runCli(["capabilities", "stray-arg"], { nowSeconds: NOW });
    expect(r.code).toBe(EXIT.invalid);
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

  it("the renamed deploy-oracle keeps its old CLI spelling as an alias", async () => {
    const r = await runCli(
      ["prepare", "market", "deploy-wrapper", "--chainid", "42161", "--clientrequestid", "alias-0002", "--collateral-asset", RCV, "--reference-asset", "0xc0ffee0000000000000000000000000000000002", "--json"],
      { nowSeconds: NOW, resolveRpc: async () => null },
    );
    expect(r.code).toBe(EXIT.ok);
    expect(JSON.parse(r.stdout).data.kind).toBe("deploy-oracle");
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
      { nowSeconds: NOW },
    );
    expect(r.stderr).toBe("");
    expect(r.code).toBe(EXIT.ok);
    const env = JSON.parse(r.stdout);
    expect(env.state).toBe("ok");
    expect(env.data.action).toBe("safeExercise");
  });

  it("root help lists the pool verbs and fill; verbs advertise their canonical spelling", async () => {
    const r = await runCli(["--help"], { nowSeconds: NOW });
    for (const verb of ["mint", "deposit", "swap", "exercise", "redeem", "withdraw", "unwind-swap", "fill"]) {
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
});
