// Every example the docs show RUNS (README.md and docs/*.md; extraction in doc-examples.ts).
//
// - offline (always): each `ch` command runs through runCli — the binary's own entry point — with
//   no RPC and an unreachable venue. It must succeed, or answer only that it needs the chain or
//   the venue (exit 3, an availability code). Never exit 1 (a crash) or 2 (the doc's own input is
//   wrong). Each shell block runs top to bottom in its own home (credentials, keystores), with a
//   scripted reader at the terminal, as a person would run it. A shape line (syntax, not a call)
//   only needs its command path to exist.
// - blocks (always): each JSON block parses; each TypeScript block says how it is checked
//   (`<!-- example: run -->`, `run-live`, `fragment`) and is checked that way.
// - live (CORK_RPC_LIVE=1): the read-only commands run against the real chains and venue with
//   live values (a pool that exists, a resting order, an RFQ) and must exit 0; an output sample
//   (a JSON block right after a command) must still match the live output's keys and labels.
//
// An outcome other than success is accepted only where the doc itself states it (OUTCOMES).
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { BUNDLED_DEFAULTS, generationsOf, primaryOf, runTool } from "@cork/core";
import type { Prompter } from "../src/prompt.ts";
import { runCli } from "../src/app.ts";
import { type DocCommand, docCommands, DOC_FILES, dropOptional, evaluateAssignment, fencedBlocks, fillPlaceholders, FIXTURES, shellWords } from "./doc-examples.ts";

const LIVE = process.env.CORK_RPC_LIVE === "1";
const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
/** Commands that never run here: a long-running server, and a binary swap that downloads. */
const NEVER_RUN = new Set(["mcp", "self-update"]);
/** Commands with side effects outside this machine; they run offline (the venue is unreachable) and never live. */
const SIDE_EFFECTS = new Set(["submit", "auth", "wallet", "sign"]);
/** Exit 3 offline is honest only for these: the answer needs the chain, the venue, or a token. */
const AVAILABILITY = new Set(["requires_rpc", "venue_unreachable", "hypersync_unavailable"]);

/** Outcomes the docs state, by file and a fragment of the command. */
const OUTCOMES: Array<{ file: string; match: RegExp; tier: "offline" | "live"; exit: number; code: string; why: string }> = [
  { file: "docs/cli.md", match: /^ch auth status --venue https:\/\/breaking/, tier: "offline", exit: 3, code: "auth", why: "the block stores a key for the default venue only, so no source serves another host" },
  { file: "docs/zyfai-quickstart.md", match: /^ch query cork-pool .*0x22eeb2b19fa6d4d0434f468cb03ce77f2d6870128a5a2c64453562db4651b858/, tier: "live", exit: 3, code: "pool_not_found", why: "the doc says the pool does not exist before the first fill" },
  { file: "docs/cli.md", match: /^ch query whitelisted-addresses/, tier: "live", exit: 3, code: "hypersync_unavailable", why: "the doc says it needs ENVIO_HYPERSYNC_TOKEN" },
];
const outcomeOf = (c: DocCommand, tier: "offline" | "live") => OUTCOMES.find((o) => o.tier === tier && o.file === c.file && o.match.test(c.source));

/** A reader at the terminal: a password for every password prompt, the well-known Anvil #0 test
 *  key when asked for a private key, and yes to every question. */
const PASSWORD = "doc-example-password";
const reader = (): Prompter => ({
  secret: async (q) => (/private key/i.test(q) ? "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" : PASSWORD),
  confirm: async () => true,
  say: () => undefined,
});
/** A complete transaction a reader would have saved as tx.json for `ch sign`. */
const COMPLETE_TX = { to: FIXTURES.settler, data: "0x", value: "0", chainId: 8453, nonce: 0, gas: "21000", maxFeePerGas: "1000000000", maxPriorityFeePerGas: "1000" };

/** The first code an envelope or an error carries, and the warnings. */
function outcome(r: { code: number; stdout: string; stderr: string }): { exit: number; code: string } {
  for (const text of [r.stdout, r.stderr]) {
    try {
      const j = JSON.parse(text) as { warnings?: Array<{ code: string }>; error?: { code?: string } };
      return { exit: r.code, code: j.error?.code ?? j.warnings?.[0]?.code ?? "" };
    } catch { /* prose or a stream of JSON lines: no code */ }
  }
  return { exit: r.code, code: "" };
}

/** The commands of one shell block, prepared to run in that block's own home. */
function blocks(): Map<string, DocCommand[]> {
  const by = new Map<string, DocCommand[]>();
  for (const c of docCommands()) {
    const key = `${c.file}:${c.line}`;
    by.set(key, [...(by.get(key) ?? []), c]);
  }
  return by;
}

/** argv as the runner passes it: a watch is bounded (the docs show it running until stopped),
 *  and `tx.json` is the complete transaction saved in the block's home. */
function runnable(argv: string[], home: string): string[] {
  const out = argv.map((w) => (w === "tx.json" ? join(home, "tx.json") : w));
  if (out.includes("--watch") && !out.includes("--iterations")) out.push("--iterations", "2", "--interval", "1");
  return out;
}

describe("doc examples — the extractor reads a shell line as a shell would", () => {
  it("splits words on quotes and escapes, stops at a comment or a pipe", () => {
    expect(shellWords(`ch query x --json '{"a": 1}' "b c" d\\ e # note`)).toEqual({ words: ["ch", "query", "x", "--json", '{"a": 1}', "b c", "d e"], pipe: false });
    expect(shellWords(`ch sign --account a#1 | jq .`)).toEqual({ words: ["ch", "sign", "--account", "a#1"], pipe: true });
  });

  it("drops an optional group, but keeps the recipe's anchor and a JSON value that closes a group", () => {
    expect(dropOptional(["x", "[--tag", "<v>]", "y"])).toEqual(["x", "y"]);
    expect(dropOptional(["[--json]", "z"])).toEqual(["z"]);
    expect(dropOptional(["--v", '["a"]', "[--mode", "price|nav]"])).toEqual(["--v", '["a"]']);
    expect(dropOptional(["x", "[--args-uints", '["<anchor>"]]', "y"])).toEqual(["x", "--args-uints", '["<anchor>"]', "y"]);
    expect(dropOptional(["[--extra-data", "<0x…>]", "[--swap-fee", "<1e18=1%>]"])).toEqual(["--extra-data", "<0x…>"]);
  });

  it("evaluates the assignments the docs use, and leaves any other form as written", () => {
    expect(evaluateAssignment("$(( $(date +%s) + 7*86400 ))", 1_000)).toBe(String(1_000 + 7 * 86_400));
    expect(evaluateAssignment("0x$(printf '%064x' 255)", 0)).toBe(`0x${"0".repeat(62)}ff`);
    expect(evaluateAssignment("$(curl -s x)", 0)).toBe("$(curl -s x)");
  });

  it("fills a placeholder by the flag before it, never by guess", () => {
    expect(fillPlaceholders(["--chain-id", "<id>", "--pool-id", "<0x…>", "--x", "<what>"]).argv).toEqual(["--chain-id", FIXTURES.chainId, "--pool-id", FIXTURES.pool, "--x", "<what>"]);
    expect(fillPlaceholders(["--chain-id", "<id>", "--data", "<0x…>"], ["decode", "calldata"]).argv).toEqual(["--chain-id", "1", "--data", FIXTURES.calldata]);
  });
});

describe("doc examples — every command runs (offline)", () => {
  const offlineCtx = { resolveRpc: async () => null, venueFetch: async () => { throw Object.assign(new Error("venue unreachable in this test"), { name: "TypeError" }); } };

  it("the docs carry the examples this test reads (the extractor still finds them)", () => {
    const all = docCommands();
    expect(all.length).toBeGreaterThan(140);
    expect(all.filter((c) => c.kind !== "shape").length).toBeGreaterThan(80);
  });

  for (const [block, cmds] of blocks()) {
    it(`${block}: each command succeeds or needs only the chain or the venue`, async () => {
      const home = mkdtempSync(join(tmpdir(), "doc-ex-"));
      writeFileSync(join(home, "tx.json"), JSON.stringify(COMPLETE_TX));
      const env = { CORK_CREDENTIALS_FILE: join(home, "credentials"), CORK_KEYSTORE_DIR: join(home, "keystores"), CORK_CONFIG_NO_FETCH: "1", CORK_JSON: "1" };
      for (const c of cmds) {
        if (NEVER_RUN.has(c.argv[0]!)) continue;
        if (c.kind === "shape") {
          const r = await runCli([...c.argv, "--help"], offlineCtx, env);
          expect(r.code, `shape line ${c.source}: its command path must exist`).toBe(0);
          continue;
        }
        const r = await runCli(runnable(c.argv, home), offlineCtx, env, { prompter: reader(), readSecret: async () => "doc-example-key-0000" });
        const got = outcome(r);
        const stated = outcomeOf(c, "offline");
        if (stated) {
          expect(got, `${c.source} — ${stated.why}`).toEqual({ exit: stated.exit, code: stated.code });
          continue;
        }
        const honest = got.exit === 0 || (got.exit === 3 && AVAILABILITY.has(got.code));
        expect(honest, `${c.source}\n  → exit ${got.exit} ${got.code}\n  ${(r.stderr || r.stdout).slice(0, 400)}`).toBe(true);
      }
    }, 120_000);
  }
});

describe("doc examples — code blocks", () => {
  const all = DOC_FILES.flatMap((f) => fencedBlocks(f));

  it("every JSON block parses (JSONC: comments allowed)", () => {
    for (const b of all.filter((x) => x.lang === "json" || x.lang === "jsonc")) {
      const text = b.lang === "jsonc" ? b.text.replace(/^\s*\/\/.*$/gm, "").replace(/\s\/\/[^\n"]*$/gm, "") : b.text;
      expect(() => JSON.parse(text), `${b.file}:${b.line}`).not.toThrow();
    }
  });

  const ts = all.filter((b) => b.lang === "ts");
  it("every TypeScript block says how it is checked", () => {
    const unmarked = ts.filter((b) => !/^example: (run|run-live|fragment)$/.test(b.marker ?? "")).map((b) => `${b.file}:${b.line}`);
    expect(unmarked, "each needs <!-- example: run | run-live | fragment --> above its fence").toEqual([]);
  });

  /** Run a block as a module from the repo root, where the workspace packages resolve. */
  const run = (b: (typeof ts)[number]) => spawnSync("bun", ["--eval", b.text], { cwd: ROOT, encoding: "utf8", timeout: 120_000, env: { ...process.env, CORK_CONFIG_NO_FETCH: "1" } });
  for (const b of ts.filter((x) => x.marker === "example: run")) {
    it(`${b.file}:${b.line} runs`, () => {
      const r = run(b);
      expect(r.status, `${b.file}:${b.line}\n${r.stderr}`).toBe(0);
    }, 130_000);
  }
  for (const b of ts.filter((x) => x.marker === "example: run-live")) {
    it.skipIf(!LIVE)(`${b.file}:${b.line} runs against the live chain`, () => {
      const r = run(b);
      expect(r.status, `${b.file}:${b.line}\n${r.stderr}`).toBe(0);
    }, 130_000);
  }
  for (const b of ts.filter((x) => x.marker === "example: fragment")) {
    it(`${b.file}:${b.line}: every name a fragment imports exists`, async () => {
      for (const m of b.text.matchAll(/import\s*\{([^}]+)\}\s*from\s*"([^"]+)"/g)) {
        const mod = (await import(m[2]!)) as Record<string, unknown>;
        for (const name of m[1]!.split(",").map((s) => s.trim()).filter((s) => s && !s.startsWith("type "))) {
          expect(mod[name], `${b.file}:${b.line}: ${m[2]} exports ${name}`).toBeDefined();
        }
      }
    });
  }
});

describe.skipIf(!LIVE)("doc examples — the read-only commands run live", () => {
  const READ_ONLY = new Set(["query", "compute", "capabilities", "decode", "track", "prepare", "exercise", "fill", "deposit", "withdraw", "unwind-deposit", "mint", "version"]);

  // Live values: a pool on the primary that has not expired (the docs run their examples on the
  // primary), a resting order, a rollover order, an RFQ whose template names a recipe (answer-rfq
  // needs one), per chain.
  const live = new Map<string, Partial<Record<"pool" | "order" | "digest" | "rfq", string | undefined>>>();
  beforeAll(async () => {
    for (const chainId of [8453, 42161]) {
      const soon = new Date(Date.now() + 86_400_000).toISOString();
      const [pools, book, rolls, rfqs] = await Promise.all([
        runTool("cork_query", { chainId, resource: "cork-pools", pageSize: 200, maxPages: 3 }, {}),
        runTool("cork_query", { chainId, resource: "orderbook", sort: "venue", pageSize: 20, maxPages: 1 }, {}),
        runTool("cork_query", { chainId, resource: "rollover-orders", filters: { kind: "orders" }, pageSize: 100, maxPages: 3 }, {}),
        runTool("cork_query", { chainId, resource: "rfqs", filters: { withAnswers: false }, pageSize: 50, maxPages: 1 }, {}),
      ]);
      const items = <T>(env: { data: unknown }) => ((env.data as { items?: T[] } | null)?.items ?? []);
      const primaryPm = primaryOf(generationsOf(BUNDLED_DEFAULTS, chainId))!.phoenix!.poolManager.toLowerCase();
      live.set(String(chainId), {
        pool: items<{ poolId: string; expiry: string; isDepositPaused: boolean; poolManagerAddress: string }>(pools)
          .filter((p) => p.poolManagerAddress.toLowerCase() === primaryPm && p.expiry > soon && !p.isDepositPaused)
          .sort((a, b) => b.expiry.localeCompare(a.expiry))[0]?.poolId,
        order: items<{ orderHash?: string }>(book)[0]?.orderHash,
        // A rollover order the settler can still fill: the venue lists settled and lapsed ones too.
        digest: items<{ orderDigest?: string; status?: string; fillDeadline?: string }>(rolls)
          .find((o) => o.status === "PENDING" && Number(o.fillDeadline) > Date.now() / 1000 + 600)?.orderDigest,
        rfq: items<{ rfq_id?: string; market_template?: { inline?: { oracle_recipe?: string } } }>(rfqs).find((r) => r.market_template?.inline?.oracle_recipe)?.rfq_id,
      });
    }
  }, 300_000);

  /** argv with the live values in place of the fixtures, or why a live value is missing. */
  function liveArgv(c: DocCommand): { argv: string[] } | { missing: string } {
    const chain = c.argv[c.argv.indexOf("--chain-id") + 1] ?? FIXTURES.chainId;
    const l = live.get(chain) ?? {};
    const need = (flag: string, key: keyof typeof l) => c.argv.includes(flag) && l[key] === undefined;
    const missing = need("--order-hash", "order") ? "a resting order" : need("--order-digest", "digest") ? "a rollover order that can still fill" : need("--rfq-id", "rfq") ? "an RFQ whose template names a recipe" : c.argv.includes(FIXTURES.pool) && !l.pool ? "a live pool on the primary" : null;
    if (missing) return { missing: `no ${missing} on chain ${chain} now` };
    return {
      argv: runnable(c.argv.map((w, i) => {
        const flag = c.argv[i - 1];
        if (w === FIXTURES.pool) return l.pool!;
        if (flag === "--order-hash" && w === FIXTURES.hash) return l.order!;
        if (flag === "--order-digest" && w === FIXTURES.hash) return l.digest!;
        if (flag === "--rfq-id" && w === FIXTURES.rfqId) return l.rfq!;
        return w.replaceAll(FIXTURES.pool, l.pool ?? FIXTURES.pool);
      }), tmpdir()),
    };
  }

  it("each runs and exits 0, or as the doc states", async () => {
    const failures: string[] = [];
    const skipped: string[] = [];
    for (const c of docCommands()) {
      if (c.kind === "shape" || NEVER_RUN.has(c.argv[0]!) || SIDE_EFFECTS.has(c.argv[0]!) || !READ_ONLY.has(c.argv[0]!)) continue;
      const a = liveArgv(c);
      if ("missing" in a) { skipped.push(`${c.file}:${c.line} ${c.source.slice(0, 80)} — ${a.missing}`); continue; }
      const r = await runCli(a.argv, {}, { CORK_JSON: "1" });
      const got = outcome(r);
      const stated = outcomeOf(c, "live");
      const ok = stated ? got.exit === stated.exit && got.code === stated.code : got.exit === 0;
      if (!ok) failures.push(`${c.file}:${c.line} ${c.source.slice(0, 120)}\n  → exit ${got.exit} ${got.code}: ${(r.stderr || r.stdout).slice(0, 300)}`);
    }
    if (skipped.length) console.log(`skipped (no live value to use):\n${skipped.join("\n")}`);
    expect(failures, failures.join("\n\n")).toEqual([]);
  }, 1_200_000);

  // A sample marked `<!-- example: output <path> -->` shows the output of the command right above
  // it, trimmed. Values move (rates, ids), so only two things are held to the live output: every
  // key the sample shows still exists there, and every LABEL it shows (a generation, a wire, a
  // source, a status) is still the live label. A stale generation label fails here.
  const LABELS = new Set(["generation", "label", "wire", "source", "status", "kind", "mode", "distribution", "contractsVersion", "verification"]);
  /** Every key path of the sample, with the label values to compare. */
  function differences(sample: unknown, live: unknown, at: string): string[] {
    if (Array.isArray(sample)) {
      if (!Array.isArray(live)) return [`${at}: an array in the doc, ${typeof live} live`];
      return sample.flatMap((s, i) => (i < live.length ? differences(s, live[i], `${at}[${i}]`) : [`${at}[${i}]: the doc shows more items than the live output has`]));
    }
    if (sample === null || typeof sample !== "object") return [];
    if (live === null || typeof live !== "object") return [`${at}: an object in the doc, ${JSON.stringify(live)} live`];
    const out: string[] = [];
    for (const [k, v] of Object.entries(sample)) {
      const lv = (live as Record<string, unknown>)[k];
      if (!(k in (live as object))) { out.push(`${at}.${k}: in the doc, gone from the live output`); continue; }
      if (LABELS.has(k) && typeof v === "string" && !/[…<]/.test(v) && lv !== v) out.push(`${at}.${k}: the doc says ${JSON.stringify(v)}, live is ${JSON.stringify(lv)}`);
      out.push(...differences(v, lv, `${at}.${k}`));
    }
    return out;
  }
  const outputs = DOC_FILES.flatMap((f) => fencedBlocks(f)).filter((b) => /^example: output\b/.test(b.marker ?? ""));
  for (const b of outputs) {
    it(`${b.file}:${b.line}: the output sample still matches the live output`, async () => {
      const cmd = docCommands().filter((c) => c.file === b.file && c.line < b.line && c.kind !== "shape").at(-1)!;
      const a = liveArgv(cmd);
      if ("missing" in a) { console.log(`skipped ${b.file}:${b.line} — ${a.missing}`); return; }
      const r = await runCli(a.argv, {}, { CORK_JSON: "1" });
      const path = (b.marker!.match(/^example: output\s*(\S*)$/)?.[1] ?? "").split(".").filter(Boolean);
      const live = path.reduce<unknown>((v, k) => (v as Record<string, unknown> | undefined)?.[k], JSON.parse(r.stdout));
      const sample = JSON.parse(b.text.replace(/^\s*\/\/.*$/gm, "").replace(/\s\/\/[^\n"]*$/gm, ""));
      expect(differences(sample, live, path.join(".") || "(envelope)"), `${cmd.source}`).toEqual([]);
    }, 300_000);
  }
});
