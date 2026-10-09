// The examples the docs show, as data: every fenced block of README.md and docs/*.md, and every
// `ch` command in their shell blocks, classified so a test can RUN them (doc-examples.test.ts).
//
// A command line is one of three kinds:
//   - concrete: runs as written;
//   - template: runs once its placeholders (<0x…>, <amt>, 0xYOUR_SAFE, …) are filled by FLAG
//     name — the value a reader would type there, taken from the bundled config and the
//     canonical demo fixtures, never invented;
//   - shape: shows syntax, not a call (`ch <command>`, `ch mint · ch swap`, an elided `{…}`
//     payload, `…` for "the rest", a pipe) — only its command path is checked.
// [optional] groups are dropped: the required form is the one that must run. The exception is the
// recipe's anchor ([--args-uints …], [--args …], [--extra-data …]): a pair whose oracle is not
// deployed needs it, and the docs say so, so the runner passes it as a reader of such a pair would.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { BUNDLED_DEFAULTS, generationsOf, primaryOf } from "@cork/core";
import { DEMO_ACCOUNT, DEMO_SIGNED_TX, TOOL_EXAMPLES } from "@cork/schemas";

export const DOC_FILES = ["README.md", "docs/cli.md", "docs/sdk.md", "docs/sdk-roadmap.md", "docs/zyfai-quickstart.md", "docs/jit-order-anatomy.md"] as const;
const ROOT = fileURLToPath(new URL("../../..", import.meta.url));

export interface FencedBlock {
  file: string;
  /** 1-based line of the opening fence. */
  line: number;
  lang: string;
  text: string;
  /** The HTML comment right above the fence, if any (`<!-- example: … -->`). */
  marker: string | null;
}

export function fencedBlocks(file: string): FencedBlock[] {
  const lines = readFileSync(`${ROOT}/${file}`, "utf8").split("\n");
  const out: FencedBlock[] = [];
  for (let i = 0; i < lines.length; i++) {
    const open = lines[i]!.match(/^\s*```(\S*)\s*$/);
    if (!open) continue;
    const start = i;
    const body: string[] = [];
    for (i++; i < lines.length && !/^\s*```\s*$/.test(lines[i]!); i++) body.push(lines[i]!);
    let k = start - 1;
    while (k >= 0 && lines[k]!.trim() === "") k--;
    const marker = k >= 0 ? (lines[k]!.match(/^<!--\s*(example:[^>]*?)\s*-->$/)?.[1] ?? null) : null;
    out.push({ file, line: start + 1, lang: open[1] || "", text: body.join("\n"), marker });
  }
  return out;
}

/** Split a shell line into words: single and double quotes, backslash escapes. `#` starts a
 *  comment only at the start of a word outside quotes; `|` ends the command (a pipe). */
export function shellWords(line: string): { words: string[]; pipe: boolean } {
  const words: string[] = [];
  let cur = "";
  let inWord = false;
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === "\\" && quote === '"' && i + 1 < line.length) cur += line[++i];
      else cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; inWord = true; continue; }
    if (ch === "\\" && i + 1 < line.length) { cur += line[++i]; inWord = true; continue; }
    if (ch === "#" && !inWord) break;
    if (ch === "|") { if (inWord) words.push(cur); return { words, pipe: true }; }
    if (/\s/.test(ch)) { if (inWord) { words.push(cur); cur = ""; inWord = false; } continue; }
    cur += ch;
    inWord = true;
  }
  if (inWord) words.push(cur);
  return { words, pipe: false };
}

export type DocCommandKind = "concrete" | "template" | "shape";
export interface DocCommand {
  file: string;
  line: number;
  /** The command as the doc shows it (continuations joined, comment dropped). */
  source: string;
  kind: DocCommandKind;
  /** argv after `ch`, placeholders filled; for a shape line, only the command path. */
  argv: string[];
}

const SHELL = new Set(["sh", "bash", "shell", "console", ""]);

/** A word that shows syntax rather than a value: an ellipsis for "the rest", a `·` list, an
 *  elided payload (`'{…}'`), or a placeholder for the command itself. */
const isShapeWord = (w: string) => w === "…" || w === "·" || w.startsWith("<command") || /\{[^}]*…/.test(w) || /…[^"']*\}/.test(w);

/** The shell assignments the docs use, evaluated: `$(date +%s)`, integer arithmetic `$(( … ))`,
 *  and `$(printf '%064x' N)` (an abi word). Any other form is left as written, so a command that
 *  uses it fails visibly instead of running with a guess. */
export function evaluateAssignment(value: string, nowSeconds: number): string {
  let v = value.replace(/^["']|["']$/g, "").replaceAll("$(date +%s)", String(nowSeconds));
  v = v.replace(/\$\(printf '%064x' (\d+)\)/g, (_, n: string) => BigInt(n).toString(16).padStart(64, "0"));
  v = v.replace(/\$\(\(\s*([\d\s+*]+?)\s*\)\)/g, (_, expr: string) => String(expr.split("+").reduce((sum, term) => sum + term.split("*").reduce((p, f) => p * BigInt(f.trim()), 1n), 0n)));
  return v;
}

export function docCommands(nowSeconds = Math.floor(Date.now() / 1000)): DocCommand[] {
  const out: DocCommand[] = [];
  for (const file of DOC_FILES) {
    // One terminal per page: a variable set in one block is still set in the blocks after it.
    const vars = new Map<string, string>();
    for (const b of fencedBlocks(file)) {
      if (!SHELL.has(b.lang)) continue;
      for (const raw of b.text.replace(/\\\n\s*/g, " ").split("\n")) {
        const assignment = raw.match(/^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)=(.+?)(?:\s+#.*)?$/);
        if (assignment) vars.set(assignment[1]!, evaluateAssignment(assignment[2]!, nowSeconds));
        const line = raw.replace(/^\s*\$\s*/, "");
        if (!/^\s*ch(\s|$)/.test(line)) continue;
        const { words: rawWords, pipe } = shellWords(line);
        const words = rawWords.map((w) => w.replace(/\$\{?([A-Z_][A-Z0-9_]*)\}?/g, (m, name: string) => vars.get(name) ?? m));
        const argv = words.slice(1);
        const source = words.join(" ");
        if (pipe || argv.some(isShapeWord)) {
          out.push({ file: b.file, line: b.line, source, kind: "shape", argv: commandPath(argv) });
          continue;
        }
        const filled = fillPlaceholders(dropOptional(argv), commandPath(argv));
        out.push({ file: b.file, line: b.line, source, kind: filled.changed ? "template" : "concrete", argv: filled.argv });
      }
    }
  }
  return out;
}

/** The leading words that are neither flags nor placeholders: the command path. */
function commandPath(argv: string[]): string[] {
  const path: string[] = [];
  for (const w of argv) {
    if (w.startsWith("-") || w.includes("<") || isShapeWord(w)) break;
    path.push(w);
  }
  return path;
}

/** Drop every `[ … ]` optional group; a group may span words (`[--tag <vX.Y.Z>]`). A word that
 *  only STARTS with `[` and is JSON (`'[{…}]'`, `'["…"]'`) is a value, not a group. */
const ANCHOR_GROUPS = new Set(["[--args-uints", "[--args", "[--extra-data"]);
export function dropOptional(argv: string[]): string[] {
  const out: string[] = [];
  let group: "drop" | "keep" | null = null;
  let depth = 0;
  for (const w of argv) {
    let word = w;
    if (!group) {
      if (!word.startsWith("[") || /^\[["{]/.test(word)) { out.push(word); continue; }
      group = ANCHOR_GROUPS.has(word) ? "keep" : "drop";
      word = word.slice(1);
      depth = 0;
    }
    // The group closes at the "]" that brackets inside the word (a JSON value) do not balance.
    depth += (word.match(/\[/g)?.length ?? 0) - (word.match(/\]/g)?.length ?? 0);
    const closes = depth < 0;
    if (closes) word = word.slice(0, -1);
    if (group === "keep" && word) out.push(word);
    if (closes) group = null;
  }
  return out;
}

const BASE = primaryOf(generationsOf(BUNDLED_DEFAULTS, 8453))!;
/** Values a reader would type, from the bundled config (the Base primary) and the canonical demo
 *  fixtures. A live test overrides the ones that must EXIST now (a pool, a resting order). */
export const FIXTURES = {
  chainId: "8453",
  account: DEMO_ACCOUNT as string,
  usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  /** The reference asset the Zyfai quickstart covers (mwUSDC on Base). */
  reference: "0xc1256Ae5FF1cf2719D4937adb3bbCCab2E00A2Ca",
  navRecipe: BASE.marketRegistry!.recipes!.nav!,
  settler: BASE.rollover!.exactSettler,
  forSelfAdapter: BASE.forSelf!.adapter,
  /** A pool id; live runs replace it with a pool that exists. */
  pool: `0x${"38".repeat(32)}`,
  hash: `0x${"ab".repeat(32)}`,
  /** A well-formed venue RFQ id (rfq_ and lowercase alphanumerics). */
  rfqId: "rfq_docexample1",
  /** The worked examples' signed transaction and Bundler3 multicall (cork_decode). */
  signedTx: DEMO_SIGNED_TX as string,
  calldata: (TOOL_EXAMPLES.cork_decode!.find((e) => (e.input as { kind?: string }).kind === "calldata")!.input as { data: string }).data,
  clientRequestId: "doc-example-0001",
  anchor: "1090410000000000000",
};

const ADDRESS_FLAGS: Record<string, keyof typeof FIXTURES> = {
  "--account": "account", "--receiver": "account", "--owner": "account", "--requester": "account", "--underwriter": "account", "--maker": "account",
  "--token": "usdc", "--maker-asset": "usdc", "--taker-asset": "reference", "--spender": "settler",
  "--collateral-asset": "usdc", "--reference-asset": "reference", "--recipe": "navRecipe", "--settler": "settler", "--to": "settler", "--address": "reference",
  "--pool-id": "pool", "--order-hash": "hash", "--order-digest": "hash", "--signature": "hash",
};

/** A `"0x…"` inside a JSON value, by its key. */
const JSON_KEY_VALUES: Record<string, string> = {
  adapter: FIXTURES.forSelfAdapter,
  poolId: FIXTURES.pool,
  allowedSender: FIXTURES.account,
  txHash: FIXTURES.hash,
  orderHash: FIXTURES.hash,
};

/** The value for one placeholder word, by the flag before it (and, for `--data`, the command
 *  it feeds); undefined when it is no placeholder. */
function placeholderValue(w: string, flag: string, path: readonly string[]): string | undefined {
  const isPlaceholder = /^<[^>]*>$/.test(w) || w === "0x…" || /^0xYOUR_[A-Z]+$/.test(w) || w === "rfq_…" || /^0x<[^>]+>$/.test(w);
  if (!isPlaceholder) return undefined;
  // The worked decode bytes are mainnet bytes (their legs target the chain-1 contracts).
  if (flag === "--chain-id") return path[0] === "decode" ? "1" : FIXTURES.chainId;
  if (flag === "--client-request-id") return FIXTURES.clientRequestId;
  if (flag === "--rfq-id") return FIXTURES.rfqId;
  if (flag === "--data" && path[0] === "decode") return path[1] === "tx" ? FIXTURES.signedTx : FIXTURES.calldata;
  if (/^0x<anchor/.test(w) || flag === "--extra-data" || flag === "--args") return `0x${BigInt(FIXTURES.anchor).toString(16).padStart(64, "0")}`;
  if (w === "<nav-recipe>") return FIXTURES.navRecipe;
  if (w === "<old>" || w === "<new>") return FIXTURES.pool;
  if (w === "0xYOUR_ADAPTER") return FIXTURES.forSelfAdapter;
  if (/^0xYOUR_/.test(w) || w === "<safe>") return FIXTURES.account;
  const byFlag = ADDRESS_FLAGS[flag];
  if (byFlag) return FIXTURES[byFlag];
  const named: Record<string, string> = {
    "<amt>": /collateral/.test(flag) ? "1000e6" : "1000e18",
    "<n>": "1",
    "<s>": "2",
    "<unix>": String(Math.floor(Date.now() / 1000) + 7 * 86_400),
    "<rate>": "12e15",
    "<1e18=1%>": "1e18",
    "<1e18=1.0>": "1e18",
    "<price|nav>": "nav",
    "<anchor>": FIXTURES.anchor,
    "<topic>": "signing",
  };
  return named[w];
}

/** Fill each placeholder by the flag before it, and the placeholders inside JSON values. */
export function fillPlaceholders(argv: string[], path: readonly string[] = []): { argv: string[]; changed: boolean } {
  let changed = false;
  const out = argv.map((w, i) => {
    const v = placeholderValue(w, argv[i - 1] ?? "", path);
    if (v !== undefined) { changed = true; return v; }
    if (/<anchor>|0xYOUR_[A-Z]+|"0x…"/.test(w)) {
      changed = true;
      return w
        .replaceAll("<anchor>", FIXTURES.anchor)
        .replaceAll("0xYOUR_ADAPTER", FIXTURES.forSelfAdapter)
        .replace(/0xYOUR_[A-Z]+/g, FIXTURES.account)
        .replace(/"(\w+)":"0x…"/g, (_, key: string) => `"${key}":"${JSON_KEY_VALUES[key] ?? FIXTURES.hash}"`);
    }
    return w;
  });
  return { argv: out, changed };
}
