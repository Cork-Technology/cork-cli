// CLI projection of the same registry the MCP server uses — one command per tool at its cliPath.
//
// INPUT can arrive three ways, and they compose (later wins):
//   1. `--json '<object>'`  the canonical wire shape, identical to what MCP receives
//   2. `--input '<object>'` the same thing under an unambiguous name
//   3. flags derived from the tool's own schema, plus one positional for the first required
//      scalar — so `ch query registry-assets --chainid=42161` says what it means
//
// OUTPUT is prose by default and JSON on request (`--json` with no value, or CORK_JSON=1).
// The wire format has not changed; what changed is who the default serves. Scripts that
// already pass `--json '<object>'` keep getting JSON, because supplying input that way is
// itself a machine-readable intent.
//
// `--explain` prints the tool's contract: prose by default (explain.ts), JSON Schema under
// --json or CORK_EXPLAIN_JSON=1.
//
// Exit codes map envelope state so scripts can branch: 0 ok, 2 invalid input,
// 3 unavailable, 4 conflict, 1 unexpected error.
import { Command } from "commander";
import { REGISTRY, RENAMED_VALUES, SCHEMA_VERSION, inputJsonSchema, type ToolDef } from "@cork/schemas";
import { BUILD_COMMIT, BUILD_TARGET, BUILD_VERSION, DIGIT_FILTER_KEYS, KNOWN_FILTER_KEYS, runTool, ToolInputError, type HandlerContext } from "@cork/core";
import { envFlag } from "./env.ts";
import { explainWantsJson, formatExplainText } from "./explain.ts";
import { renderEnvelope, renderError } from "./render.ts";
import { runSelfUpdate } from "./self-update.ts";

export const EXIT = { ok: 0, error: 1, invalid: 2, unavailable: 3, conflict: 4 } as const;

/**
 * JSON.parse that REFUSES silent integer precision loss: a numeric-field literal like
 * 2500000000000000001 becomes 2500000000000000000 in a plain parse BEFORE any schema sees it.
 * Uses the ES2024 reviver `context.source` (raw literal text, supported by Bun/JSC) to detect
 * an integer literal that no longer round-trips; falls back to a plain parse on engines
 * without source access. Amount-class fields are strings and unaffected.
 */
function parseJsonPrecise(text: string): unknown {
  return JSON.parse(text, function reviver(_key: string, value: unknown, context?: { source?: string }) {
    if (typeof value === "number" && context && typeof context.source === "string" && /^-?\d+$/.test(context.source) && !Number.isSafeInteger(value)) {
      throw new Error(
        `integer ${context.source} exceeds JavaScript's safe integer range and would silently lose precision in JSON parsing — pass this value as a decimal STRING (the schema's string-typed fields take arbitrary precision)`,
      );
    }
    return value;
  } as Parameters<typeof JSON.parse>[1]);
}

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

function leafName(tool: ToolDef): string {
  return tool.cliPath[tool.cliPath.length - 1]!;
}

/** The CLI's structural view of a JSON-Schema node — a supertype of what zod v4 emits
 *  (ToolInputSchema), so the wire document assigns into it with no cast. `properties` admits
 *  boolean sub-schemas because the spec does (zod never emits one for our inputs; `objectProps`
 *  filters them defensively). A type alias, not an interface, so the implicit index signature
 *  keeps it assignable to plain JSON-object types. */
type SchemaNode = {
  type?: string | string[];
  enum?: unknown[];
  const?: unknown;
  pattern?: string;
  description?: string;
  properties?: Record<string, SchemaNode | boolean>;
  required?: string[];
  $ref?: string;
  $defs?: Record<string, SchemaNode>;
  anyOf?: SchemaNode[];
  oneOf?: SchemaNode[];
};

/** A node's object-valued properties (boolean sub-schemas dropped — zod never emits them here). */
function objectProps(props: SchemaNode["properties"]): Record<string, SchemaNode> {
  return Object.fromEntries(Object.entries(props ?? {}).filter((e): e is [string, SchemaNode] => typeof e[1] === "object"));
}

/**
 * Resolve a `$ref` into its `$defs` target so classification sees the concrete shape.
 * A field like `account: { $ref: "#/$defs/Address" }` IS a string (pattern-checked) —
 * without resolution it mis-classifies as a JSON flag and `--account 0x…` demands quoting.
 * Local keys (description) win over the target's; depth-capped for $ref-of-$ref chains.
 */
function resolveNode(node: SchemaNode, defs: Record<string, SchemaNode>, depth = 0): SchemaNode {
  if (!node.$ref || depth >= 3) return node;
  const target = defs[node.$ref.replace("#/$defs/", "")];
  if (!target) return node;
  const { $ref: _drop, ...local } = node;
  return resolveNode({ ...target, ...local }, defs, depth + 1);
}

/**
 * Does the schema admit a plain string for this field? Judged by the schema, not by how a value
 * looks: union fields like decode's `data` (hex-string-or-object, the string side behind a $ref)
 * accept a raw flag value, while object-only fields (`--filters`, `--action`) keep the loud
 * JSON-parse error — the actionable message when a structure was clearly intended.
 */
function admitsString(node: SchemaNode, defs: Record<string, SchemaNode>, depth = 0): boolean {
  if (depth >= 4) return false;
  const n = resolveNode(node, defs);
  const t = Array.isArray(n.type) ? n.type : n.type ? [n.type] : [];
  if (t.includes("string")) return true;
  return [...(n.anyOf ?? []), ...(n.oneOf ?? [])].some((b) => admitsString(b, defs, depth + 1));
}

/** Display spelling for a schema property's flag: kebab-case (`chainId` → `--chain-id`), which
 *  commander camelCases back so the opts attribute equals the schema field name exactly. */
function flagFor(prop: string): string {
  return prop.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

/** `--chain-id`, `--chainId` and `--chainid` should all reach the same option. */
function canonicalise(flagName: string): string {
  return flagName.replace(/-/g, "").toLowerCase();
}

function isScalarNode(node: SchemaNode): boolean {
  const t = Array.isArray(node.type) ? node.type[0] : node.type;
  if (node.enum && node.enum.length > 0) return true;
  return t === "string" || t === "number" || t === "integer" || t === "boolean";
}

/** Coerce a command-line string into the type the schema expects. */
function coerce(node: SchemaNode, raw: string): unknown {
  const t = Array.isArray(node.type) ? node.type[0] : node.type;
  const numeric = t === "number" || t === "integer" || (!t && (node.enum ?? []).length > 0 && (node.enum ?? []).every((v) => typeof v === "number"));
  if (numeric) {
    const n = Number(raw);
    return Number.isNaN(n) ? raw : n;
  }
  if (t === "boolean") return raw === "" || raw === "true" || raw === "1";
  return raw;
}

/**
 * Rewrite argv so a schema-derived flag can be spelled any of the ways a person might
 * reasonably type it. Only names that resolve to a known property are touched; anything
 * else (including `--rpc-url`) passes through untouched for commander to handle.
 */
function normaliseArgv(argv: readonly string[], known: ReadonlyMap<string, string>): string[] {
  return argv.map((arg) => {
    if (!arg.startsWith("--")) return arg;
    const eq = arg.indexOf("=");
    const name = (eq === -1 ? arg.slice(2) : arg.slice(2, eq)).trim();
    const spelling = known.get(canonicalise(name));
    if (spelling === undefined || spelling === name) return arg;
    return eq === -1 ? `--${spelling}` : `--${spelling}${arg.slice(eq)}`;
  });
}

/** camelCase discriminator value → the kebab-case subcommand spelling (`txHash` → `tx-hash`) —
 *  the identical transform as flagFor; the second name marks the subcommand-vs-flag call sites. */
const kebab = flagFor;

/** Plain Levenshtein for did-you-mean suggestions on mistyped variant names. */
function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array<number>(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) dp[0]![j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) dp[i]![j] = Math.min(dp[i - 1]![j]! + 1, dp[i]![j - 1]! + 1, dp[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length]![b.length]!;
}

/** Variant-subcommand aliases — taxonomy-AGREEING synonyms only (PRE-RENAME action names are
 *  deliberately not here; they fall through to the did-you-mean/renamed-to teaching).
 *  resolve-rate-constraint is the outcome-named synonym: the call returns ONE rate constraint
 *  (the struct a JIT order carries; cf. RecipeRejectedConstraint, phoenix's ConstraintRateAdapter),
 *  resolved by the recipe named in --recipe — the canonical spelling mirrors recipe.resolve. */
const VARIANT_ALIASES: Record<string, string[]> = {
  "recipe-rate-constraint": ["resolve-rate-constraint"],
  order: ["limit-order"], // decode: the kind decodes exactly a LOP limit order
  "taker-fill": ["fill"], // prepare order: the same word the top-level verb already uses
};

/** Reverse lookup (alias → canonical) for positional VALUES: `ch decode limit-order` must reach
 *  the same place the alias comment above promises. Applied only when the canonical target is in
 *  the positional's own enum, so a compute-side alias can never leak into decode's kind slot. */
const VARIANT_ALIAS_TARGET: Record<string, string> = Object.fromEntries(
  Object.entries(VARIANT_ALIASES).flatMap(([canon, aliases]) => aliases.map((a) => [a, canon])),
);

/** Alternate resource spellings accepted at the CLI: the singular forms and shorthands that
 *  AGREE with the current taxonomy (a cork-pool is one expiry of a market; LOP pair listings
 *  are trading-pairs). PRE-RENAME values are deliberately NOT aliased: an old name must never
 *  silently work — it falls through to the wire schema, where RENAMED_VALUES rejects it with
 *  its "was renamed to" teaching (market/markets/derive-market/limit-order-markets/
 *  market-predict all teach their terminal names). Every alias targets the TERMINAL name.
 *  Blobs stay wire-exact — aliases apply to the positional and flag forms only. */
const RESOURCE_ALIASES: Record<string, string> = {
  rfq: "rfqs",
  pool: "cork-pool",
  pools: "cork-pools",
  "market-instance": "cork-pool", // the taxonomy-teaching synonym: a pool is an INSTANCE of a market
  "market-instances": "cork-pools",
  "derive-pool": "derive-cork-pool",
  "limit-orders": "orderbook",
  "pool-migration-orders": "rollover-orders",
  "extend-expiry-orders": "rollover-orders",
  "orderbook-pairs": "trading-pairs",
  // The registered-* family: every registry-* table whose rows ARE "registered X". registry-oracle
  // is deliberately excluded (it is a STATUS lookup, not a table) — its synonym is asset-pair-oracle
  // (the wrapper is keyed on the (CA, REF) pair; the fixed-rate path keys on --rate instead).
  "registered-assets": "registry-assets",
  "registered-recipes": "registry-recipes",
  "registered-denominations": "registry-denominations",
  "registered-feeds": "registry-feeds",
  "market-recipes": "registry-recipes", // recipes are MARKET-level terms
  "asset-pair-oracle": "registry-oracle", // the pair-keyed synonym (the wrapper is keyed on the (CA, REF) pair)
  "trading-pair": "trading-pairs",
};

/** Pool actions + fill are also TOP-LEVEL verbs: `ch exercise …` = `ch prepare pool exercise …`,
 *  `ch fill …` = `ch prepare order taker-fill …`. The authority ops stay namespaced. */
const TOP_LEVEL_VERBS: Record<string, (variant: string) => string | undefined> = {
  cork_prepare_phoenix: (v) => (v.startsWith("authority-") ? undefined : v),
  cork_prepare_orders: (v) => (v === "taker-fill" ? "fill" : undefined),
};

/** Network-name shorthand for chainId values: arbitrum → 42161. */
const CHAIN_NAMES: Record<string, string> = { mainnet: "1", ethereum: "1", arbitrum: "42161", base: "8453", sepolia: "11155111" };

/** Option names owned by the CLI itself (canonicalised spellings) — a schema field must never
 *  register over them. The collision lint in cli.test.ts duplicates this set as a tripwire. */
const RESERVED = new Set(["json", "input", "rpcurl", "explain", "enabledeprecated", "help"]);

/** The digits-only filter keys that get the CLI's amount sugar (`--rate 1e18`); imported from
 *  filters.ts so the sugar list and parseQueryFilters' bigint fields cannot drift apart. */
const SUGARED_FILTER_KEYS = new Set<string>(DIGIT_FILTER_KEYS);

/** One variant of a discriminated-union field: the const that names it + its own field schemas. */
interface UnionVariant {
  value: string;
  /** RAW branch node (refs intact) — used for variant-scoped --explain rendering. */
  raw: SchemaNode;
  props: Record<string, SchemaNode>;
  description?: string;
}
interface UnionInfo {
  field: string;
  disc: "type" | "kind";
  variants: UnionVariant[];
}

/**
 * Detect the tool's discriminated-union object field (`action`/`params`/`subject`): a oneOf/anyOf
 * whose EVERY branch carries a const-valued `type` or `kind`. This is what lets the CLI surface
 * each variant as its own subcommand (`ch prepare phoenix exercise …`) — the most meaningful word
 * in the call stops hiding inside a JSON blob. Non-discriminated unions (decode's hex-or-object
 * `data`) are deliberately not matched.
 */
function discriminatedUnion(props: Record<string, SchemaNode>, defs: Record<string, SchemaNode>): UnionInfo | undefined {
  for (const [field, node0] of Object.entries(props)) {
    const node = resolveNode(node0, defs);
    const list = node.oneOf ?? node.anyOf;
    if (!list || list.length === 0) continue;
    let disc: "type" | "kind" | undefined;
    const variants: UnionVariant[] = [];
    for (const raw of list) {
      const b = resolveNode(raw, defs);
      const p = objectProps(b.properties);
      const d = (["type", "kind"] as const).find((k) => typeof p[k]?.const === "string");
      if (!d || (disc && d !== disc)) {
        disc = undefined;
        break;
      }
      disc = d;
      variants.push({ value: p[d]!.const as string, raw, props: p, ...(b.description !== undefined ? { description: b.description } : {}) });
    }
    if (disc && variants.length === list.length) return { field, disc, variants };
  }
  return undefined;
}

/**
 * Exact human-amount sugar for digits-only fields: `1_000` strips underscores; `1000e18` /
 * `1.5e18` expand by pure string/integer arithmetic (nothing floating-point anywhere in the
 * path). A value that isn't sugar passes through untouched for the schema to judge; sugar that
 * cannot expand to an integer is an error worth teaching.
 */
export function expandAmount(raw: string): { ok: string } | { err: string } {
  const s = raw.replace(/_/g, "");
  if (/^[0-9]+$/.test(s)) return { ok: s };
  const m = /^([0-9]+)(?:\.([0-9]+))?[eE]\+?([0-9]+)$/.exec(s);
  if (!m) return { ok: raw };
  const expRaw = Number(m[3]);
  if (expRaw > 100) return { err: `'${raw}': exponent ${expRaw} is larger than any uint256 quantity (max ~1.16e77)` };
  const frac = m[2] ?? "";
  const exp = expRaw - frac.length;
  if (exp < 0) return { err: `'${raw}' does not expand to an integer — ${frac.length} decimal place(s) exceed the exponent ${expRaw}` };
  const digits = (m[1]! + frac).replace(/^0+(?=[0-9])/, "");
  return { ok: digits + "0".repeat(exp) };
}

/** Is this (resolved) node an amount-class field — a digits-only-pattern string? */
function isAmountNode(node: SchemaNode): boolean {
  const t = Array.isArray(node.type) ? node.type[0] : node.type;
  return t === "string" && node.pattern === "^[0-9]+$";
}

/** A one-word placeholder for a flag's value, shown in --help. */
function describeShort(node: SchemaNode): string {
  const t = Array.isArray(node.type) ? node.type[0] : node.type;
  if (node.enum && node.enum.length > 0) {
    const joined = node.enum.map(String).join("|");
    return joined.length <= 42 ? joined : "value";
  }
  if (t === "number" || t === "integer") return "n";
  if (t === "boolean") return "true|false";
  return "value";
}

function firstSentence(text: string): string {
  const cut = text.split(/(?<=\.)\s/)[0] ?? text;
  return cut.length > 110 ? `${cut.slice(0, 107)}…` : cut;
}

/** Run the CLI over argv (without node/script prefix). Captures output; never calls process.exit. */
export async function runCli(
  argv: string[],
  ctx: HandlerContext = {},
  env: Record<string, string | undefined> = {},
): Promise<CliResult> {
  let out = "";
  let err = "";
  let code: number = EXIT.ok;
  const envWantsJson = envFlag(env, "CORK_JSON");
  // JSON intent for errors that fire BEFORE any command action runs (audit R6): commander-level
  // failures (unknown option/command, excess args) and pre-parse errors happen before the
  // per-command `--json` option is bound, so the intent is read straight off argv — a JSON-mode
  // consumer must never receive plain text on stderr.
  const argvWantsJson = envWantsJson || argv.some((a) => a === "--json" || a.startsWith("--json="));
  // Commander's own stderr is buffered separately so a parse error can be re-shaped into the
  // structured payload under JSON intent instead of leaking plain text.
  let cmdErr = "";

  const program = new Command();
  program
    .name("ch")
    .description("Cork Phoenix CLI (ch) — reads, deterministic math, and unsigned tx/bundle preparation.")
    .version(BUILD_VERSION, "-V, --version", "print the ch version")
    .exitOverride()
    .configureOutput({
      writeOut: (s) => (out += s),
      writeErr: (s) => (cmdErr += s),
    });

  // Group commands by their cliPath prefix so `prepare phoenix` nests under `prepare`.
  // parent.command() (vs new Command + addCommand) copies exitOverride/configureOutput from the
  // parent, so the capture wiring is declared once on `program`.
  const GROUP_DESCRIPTIONS: Record<string, string> = {
    prepare: "build unsigned artifacts (Bundler3 bundles, order typed-data, market deployment)",
  };
  const groups = new Map<string, Command>();
  const groupFor = (seg: string): Command => {
    let g = groups.get(seg);
    if (!g) {
      g = program.command(seg).description(GROUP_DESCRIPTIONS[seg] ?? `${seg} tools`);
      groups.set(seg, g);
    }
    return g;
  };

  // Every schema-derived flag across every tool, so argv can be normalised before commander
  // sees it (commander binds one long flag per option; spelling tolerance lives here).
  const knownFlags = new Map<string, string>();
  for (const tool of REGISTRY) {
    const s: SchemaNode = inputJsonSchema(tool.name);
    for (const prop of Object.keys(s?.properties ?? {})) knownFlags.set(canonicalise(flagFor(prop)), flagFor(prop));
  }

  interface UnionCliSpec {
    path: string[];
    variants: Set<string>;
    variantNames: string[];
    /** canonicalise(spelling) → the EXACT spelling commander dispatches on (kebab name or a
     *  registered alias). preParse REWRITES tolerated spellings to this — a spelling merely
     *  accepted here but left in argv falls through commander to the parent command, which
     *  mis-reads it as a positional (and `--explain` then exits 0 showing the WRONG contract). */
    dispatch: Map<string, string>;
    positional?: { flag: string; values: Set<string> };
  }
  const unionSpecs: UnionCliSpec[] = [];
  // English-order rescue + typo guard for unioned tools: commander dispatches subcommands on the
  // FIRST operand only, so a positional-then-variant spelling (`track verify market-ref`,
  // `prepare phoenix 42161 exercise`) is swapped here (the positional rides as its own flag).
  // A first operand that is NEITHER a variant nor a legal positional value gets a did-you-mean
  // refusal — left alone, commander would blame an unrelated option and mislead.
  const preParseVariants = (argvIn: string[]): { argv: string[] } | { error: string } => {
    for (const spec of unionSpecs) {
      if (spec.path.some((seg, i) => argvIn[i] !== seg)) continue;
      const i = spec.path.length;
      const first = argvIn[i];
      if (first === undefined || first.startsWith("-")) return { argv: argvIn };
      if (spec.variants.has(canonicalise(first))) {
        // Rewrite a tolerated spelling (`unwindDeposit`, `Unwind-Deposit`) to the exact one
        // commander dispatches on — validation without rewriting was the silent-wrong.
        const exact = spec.dispatch.get(canonicalise(first))!;
        return first === exact ? { argv: argvIn } : { argv: [...argvIn.slice(0, i), exact, ...argvIn.slice(i + 1)] };
      }
      if (spec.positional?.values.has(first.toLowerCase())) {
        const next = argvIn[i + 1];
        if (next !== undefined && !next.startsWith("-") && spec.variants.has(canonicalise(next))) {
          const exact = spec.dispatch.get(canonicalise(next)) ?? next;
          return { argv: [...spec.path, exact, `--${spec.positional.flag}`, first, ...argvIn.slice(i + 2)] };
        }
        return { argv: argvIn };
      }
      // A RENAMED wire value deserves its "renamed to" pointer here too — levenshtein alone
      // never bridges a rename (the distance exceeds the typo cap by design), and before this
      // check the same value taught in a --json blob but not as a subcommand.
      const renamed = RENAMED_VALUES[first];
      if (renamed !== undefined && spec.variants.has(canonicalise(renamed))) {
        return { error: `'${first}' was renamed to '${renamed}' — run \`ch ${spec.path.join(" ")} ${renamed} …\`` };
      }
      const nearest = spec.variantNames.reduce(
        (best, v) => (levenshtein(canonicalise(first), canonicalise(v)) < levenshtein(canonicalise(first), canonicalise(best)) ? v : best),
        spec.variantNames[0]!,
      );
      const hint = levenshtein(canonicalise(first), canonicalise(nearest)) <= 3 ? ` — did you mean '${nearest}'?` : "";
      const posNote = spec.positional ? `, or a ${spec.positional.flag} value` : "";
      return { error: `unknown action '${first}' for ch ${spec.path.join(" ")}${hint} (expected one of: ${spec.variantNames.join(", ")}${posNote})` };
    }
    // Group-level dead zone (`ch prepare exercise`): no spec path matches, and commander alone
    // would answer "unknown command 'exercise'" with no route. When the stray operand IS a known
    // action of one of the group's tools, name the namespace that owns it; when it is merely
    // close to one, say which. Nothing is silently rewritten — an explicit path is the teaching.
    const g = argvIn[0];
    if (g !== undefined && groups.has(g)) {
      const sub = argvIn[1];
      const subIsCommand = sub !== undefined && !sub.startsWith("-") && groups.get(g)!.commands.some((c) => c.name() === sub || c.aliases().includes(sub));
      if (sub !== undefined && sub !== "help" && !sub.startsWith("-") && !subIsCommand) {
        const groupSpecs = unionSpecs.filter((s) => s.path[0] === g);
        const owner = groupSpecs.find((s) => s.variants.has(canonicalise(sub)));
        if (owner) {
          const verbNote = program.commands.some((c) => c.name() === sub) ? ` (or the top-level shortcut: \`ch ${sub} …\`)` : "";
          return { error: `'${sub}' is an action of \`ch ${owner.path.join(" ")}\` — run \`ch ${owner.path.join(" ")} ${sub} …\`${verbNote}` };
        }
        const renamed = RENAMED_VALUES[sub];
        const renamedOwner = renamed !== undefined ? groupSpecs.find((s) => s.variants.has(canonicalise(renamed))) : undefined;
        if (renamed !== undefined && renamedOwner) {
          return { error: `'${sub}' was renamed to '${renamed}' — run \`ch ${renamedOwner.path.join(" ")} ${renamed} …\`` };
        }
        const cands = groupSpecs.flatMap((s) => s.variantNames.map((v) => ({ v, s })));
        if (cands.length > 0) {
          const nearest = cands.reduce((best, c) => (levenshtein(canonicalise(sub), canonicalise(c.v)) < levenshtein(canonicalise(sub), canonicalise(best.v)) ? c : best));
          if (levenshtein(canonicalise(sub), canonicalise(nearest.v)) <= 3) {
            return { error: `unknown command '${sub}' for ch ${g} — did you mean '${nearest.v}' (\`ch ${nearest.s.path.join(" ")} ${nearest.v} …\`)?` };
          }
        }
      }
    }
    return { argv: argvIn };
  };

  for (const tool of REGISTRY) {
    const parent = tool.cliPath.length > 1 ? groupFor(tool.cliPath[0]!) : program;
    const schema: SchemaNode = inputJsonSchema(tool.name);
    const defs = schema?.$defs ?? {};
    const props = Object.fromEntries(Object.entries(objectProps(schema.properties)).map(([k, n]) => [k, resolveNode(n, defs)]));
    const required = schema?.required ?? [];
    // One positional, for the first required scalar — `ch query cork-pool`, `ch decode calldata`.
    // capabilities has no required scalar but search is its primary use: `ch capabilities unwind`
    // must not die on "too many arguments" when every other tool takes a bare operand.
    const positional = required.find((r) => props[r] && isScalarNode(props[r]!)) ?? (tool.name === "cork_capabilities" ? "search" : undefined);
    // The discriminated-union field (action/params/subject), if the tool has one: each of its
    // variants becomes a SUBCOMMAND (`ch prepare phoenix exercise …`) with the variant's own
    // fields flattened into flags. The legacy forms (positional chainId + --action/--params
    // blobs) keep working on the parent command — the subcommands are additive sugar.
    const union = discriminatedUnion(props, defs);

    const baseOptions = (c: Command): Command =>
      c
        // commander v12 silently ignores extra positional args by default — a typo like
        // `ch query cork-pool <poolId>` (input belongs in a flag) must error, not half-run.
        .allowExcessArguments(false)
        .option("--json [json]", "with a value: tool input as JSON. Bare: print JSON instead of prose.")
        .option("--input <json>", "tool input as a JSON string (unambiguous form of --json <json>)")
        .option("--rpc-url <url>", "RPC endpoint for chain-backed reads/compute")
        .option("--enable-deprecated", "unlock DEPRECATED features (e.g. the pre-2.1.0 registry generation via legacy:true) — same effect as CORK_ENABLE_DEPRECATED=1; every result they produce is labelled")
        .option("--explain", "print the tool's contract and exit (prose; JSON Schema under --json)");

    const fieldOption = (c: Command, registered: Set<string>, name: string, node: SchemaNode): void => {
      const canon = flagFor(name);
      // Duplicate/reserved canonical names would make one flag write two places — register the
      // first occurrence only; the variant-collision lint test asserts none exist in the registry.
      // RESERVED holds canonicalised (dash-free) spellings, so the kebab flag name must be
      // canonicalised before the lookup — `rpcUrl` kebabs to "rpc-url", reserved as "rpcurl".
      if (registered.has(canon) || RESERVED.has(canonicalise(canon))) return;
      registered.add(canon);
      const hint = isScalarNode(node) ? describeShort(node) : "json";
      // Fall back to the accepted values rather than echoing the flag's own name, which
      // tells a reader nothing they cannot see in the left-hand column.
      const help = node.description
        ? firstSentence(node.description)
        : node.enum && node.enum.length > 0
          ? `one of: ${node.enum.join(", ")}`
          : `${name} (see --explain)`;
      c.option(`--${canon} <${hint}>`, help);
    };

    const cmd = baseOptions(parent.command(leafName(tool)).description(`[phase ${tool.phase}] ${tool.description}`));
    for (const alias of tool.cliAliases ?? []) cmd.alias(alias);
    if (positional) cmd.argument(`[${positional}]`, props[positional]?.description ? firstSentence(props[positional]!.description!) : `${positional} to act on`);
    const cmdRegistered = new Set<string>();
    for (const [name, node] of Object.entries(props)) {
      if (name === positional) continue;
      fieldOption(cmd, cmdRegistered, name, node);
    }
    // Positional↔flag parity: the positional field ALSO rides as a flag (`ch query --resource
    // rfqs`, `ch prepare pool --chain-id 1`). Before this, the flag spelling of a positional was
    // an unknown option — with a did-you-mean pointing at an unrelated flag (--resource →
    // "--source"). When both forms are given, the flag overrides the positional, matching the
    // flags-override-everything convention of every other field.
    if (positional && props[positional]) fieldOption(cmd, cmdRegistered, positional, props[positional]!);

    // cork_query: every known filters key rides as a first-class flag (`--pool-id`, `--rfq-id`,
    // `--status` …) merging INTO filters — the escaped-JSON `--filters` blob stays available and
    // the flags override its keys. A key colliding with a top-level field (mode) stays blob-only.
    const filterFlagKeys: string[] =
      tool.name === "cork_query"
        ? (KNOWN_FILTER_KEYS as readonly string[]).filter(
            (k) => !(k in props) && !RESERVED.has(canonicalise(flagFor(k))) && !cmdRegistered.has(flagFor(k)),
          )
        : [];
    for (const k of filterFlagKeys) {
      cmdRegistered.add(flagFor(k));
      cmd.option(`--${flagFor(k)} <value>`, `filters.${k}`);
      knownFlags.set(canonicalise(flagFor(k)), flagFor(k));
    }
    // A filter key that collides with a top-level field cannot ride under its own name — the
    // bare flag must keep meaning the top-level field — so it rides under an ALIAS instead.
    // `mode` is the one such key: top-level `mode` selects the DATA backend, while filters.mode
    // is the pair's ORACLE mode (price|nav) — hence --oracle-mode.
    const filterFlagAliases: ReadonlyArray<readonly [key: string, flag: string]> =
      tool.name === "cork_query" ? [["mode", "oracle-mode"] as const] : [];
    for (const [key, flag] of filterFlagAliases) {
      if (cmdRegistered.has(flag)) continue;
      cmdRegistered.add(flag);
      cmd.option(`--${flag} <value>`, `filters.${key} (price|nav — the bare --${key} is the top-level data-mode field)`);
      knownFlags.set(canonicalise(flag), flag);
    }

    /** One action body for the parent AND every variant subcommand (closure over out/err/code). */
    const makeAction = (variant?: UnionVariant) =>
      async (...args: unknown[]) => {
        // commander hands (positionalArgs..., options, command); options is second-to-last.
        // On a variant subcommand the PARENT parses any option it also declares (default
        // commander traversal: `--account` after `exercise` still binds to `prepare phoenix`),
        // so the sub merges the parent's consumed opts under its own.
        const self = args[args.length - 1] as Command;
        const parentOpts = variant ? ((self.parent?.opts() ?? {}) as Record<string, unknown>) : {};
        const opts = { ...parentOpts, ...(args[args.length - 2] as Record<string, unknown>) };
        // Variant subcommands and top-level verbs accept the parent's positional too — the long
        // and short spellings must take the same operands (`ch exercise 1` = `ch prepare pool
        // exercise 1` = `ch prepare pool 1 exercise`); every field still also rides as a flag.
        const positionalValue = positional ? (args[0] as string | undefined) : undefined;

        const jsonOpt = opts["json"];
        const wantsJson = jsonOpt !== undefined || envWantsJson;

        /** Emit one structured error payload (JSON or prose per --json intent) and set the exit
         *  code — the single shape every CLI-level failure takes, so no site can drift. */
        const fail = (payload: { error: Record<string, unknown> }, exitCode: number): void => {
          err += wantsJson ? `${JSON.stringify(payload)}\n` : renderError(payload);
          code = exitCode;
        };

        if (opts["explain"]) {
          // Variant-scoped explain: same renderer, with the union field narrowed to this branch
          // (raw node, refs intact) — `ch prepare phoenix exercise --explain` documents exercise.
          let schemaDoc: SchemaNode = inputJsonSchema(tool.name);
          let cli = `ch ${tool.cliPath.join(" ")}`;
          if (variant && union) {
            const p: Record<string, SchemaNode | boolean> = { ...(schemaDoc.properties ?? {}) };
            const fieldRaw = p[union.field];
            const fieldObj = typeof fieldRaw === "object" ? fieldRaw : {};
            const unionKey = fieldObj.oneOf ? "oneOf" : "anyOf";
            p[union.field] = { ...fieldObj, [unionKey]: [variant.raw] };
            schemaDoc = { ...schemaDoc, properties: p };
            cli += ` ${kebab(variant.value)}`;
          }
          const doc = { tool: tool.name, cli, phase: tool.phase, description: tool.description, inputSchema: schemaDoc };
          // explainWantsJson carries the explain-scoped env var; the global one applies too.
          out += wantsJson || explainWantsJson(env) ? `${JSON.stringify(doc, null, 2)}\n` : `${formatExplainText(doc)}\n`;
          return;
        }

        // Base input: whichever JSON form was supplied. `--json` with a value and `--input`
        // mean the same thing; a bare `--json` is an output request, not input.
        let input: Record<string, unknown> = {};
        const rawJson = typeof jsonOpt === "string" ? jsonOpt : typeof opts["input"] === "string" ? (opts["input"] as string) : undefined;
        if (rawJson !== undefined) {
          try {
            const parsed = parseJsonPrecise(rawJson);
            if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("expected a JSON object");
            input = parsed as Record<string, unknown>;
          } catch (e) {
            // R7: a bare `--json` placed BEFORE a positional swallows it as the blob value —
            // `ch query --json pools` arrives here with rawJson "pools". A single bare word that
            // is not JSON-shaped is that mistake, not malformed JSON; teach the reorder.
            const swallowed = typeof jsonOpt === "string" && /^[A-Za-z][\w-]*$/.test(rawJson);
            const hint = swallowed ? ` — '${rawJson}' looks like a POSITIONAL that a bare --json (an output request) swallowed; put --json AFTER the positionals (ch ${tool.cliPath.join(" ")} ${rawJson} --json), or pass a full object (--json '{...}')` : "";
            fail({ error: { code: "invalid_json", tool: tool.name, message: `invalid JSON input: ${(e as Error).message}${hint}` } }, EXIT.invalid);
            return;
          }
        }

        /** Assign one value with synonym resolution, amount sugar, and scalar/JSON handling;
         *  false = error emitted. ONE resolver for positional and flag forms alike, so a synonym
         *  accepted in one spelling slot is accepted in every spelling slot (blobs stay
         *  wire-exact by design): chain names lowercase-insensitively; resource aliases likewise
         *  (they were case-sensitive while chain names were not — same table, different rule);
         *  enum-valued fields tolerate the taxonomy-agreeing variant aliases and canonicalised
         *  spellings, judged against the field's OWN enum so an alias never leaks across domains. */
        const assign = (target: Record<string, unknown>, name: string, node: SchemaNode, supplied: unknown): boolean => {
          let rawStr = String(supplied);
          if (name === "chainId" && CHAIN_NAMES[rawStr.toLowerCase()] !== undefined) rawStr = CHAIN_NAMES[rawStr.toLowerCase()]!;
          if (name === "resource") rawStr = RESOURCE_ALIASES[rawStr.toLowerCase()] ?? rawStr.toLowerCase();
          if (node.enum && node.enum.length > 0 && !node.enum.includes(rawStr)) {
            const aliasTarget = Object.entries(VARIANT_ALIAS_TARGET).find(([a]) => canonicalise(a) === canonicalise(rawStr))?.[1];
            if (aliasTarget !== undefined && node.enum.includes(aliasTarget)) rawStr = aliasTarget; // `ch decode limit-order` → kind "order"
            else {
              const canonHit = node.enum.find((e) => canonicalise(String(e)) === canonicalise(rawStr));
              if (canonHit !== undefined) rawStr = String(canonHit); // `ch decode Calldata` → "calldata"
            }
          }
          // Amount sugar covers integer-typed flags too (audit R5): Number("1e3") accepted
          // float notation while "1_000" failed, so two adjacent flags on one subcommand spoke
          // different dialects. One expander, one dialect. Integer fields add a safe-range gate
          // because they land in JSON numbers, which lose precision past 2^53 — string-typed
          // amounts have arbitrary precision and need no gate.
          const nodeT = Array.isArray(node.type) ? node.type[0] : node.type;
          if ((isAmountNode(node) || nodeT === "integer") && /[_eE]/.test(rawStr)) {
            const ex = expandAmount(rawStr);
            if ("err" in ex) {
              fail({ error: { code: "invalid_amount", tool: tool.name, message: `--${flagFor(name)}: ${ex.err}` } }, EXIT.invalid);
              return false;
            }
            if (nodeT === "integer" && BigInt(ex.ok) > BigInt(Number.MAX_SAFE_INTEGER)) {
              fail({ error: { code: "invalid_amount", tool: tool.name, message: `--${flagFor(name)}: '${rawStr}' expands to ${ex.ok}, beyond the safe integer range of this JSON-number field (max 9007199254740991) — integer-typed fields are durations/counts, not token amounts` } }, EXIT.invalid);
              return false;
            }
            rawStr = ex.ok;
          }
          if (isScalarNode(node)) {
            target[name] = coerce(node, rawStr);
            return true;
          }
          try {
            target[name] = parseJsonPrecise(rawStr);
          } catch (e) {
            // Not parseable as JSON: if the SCHEMA admits a string for this field (union-typed,
            // e.g. `--data 0xdeadbeef` on decode: hex-or-object), pass the raw value through and
            // let schema validation judge it. Object-only fields keep the loud parse error.
            if (admitsString(node, defs)) {
              target[name] = rawStr;
              return true;
            }
            fail({ error: { code: "invalid_json", tool: tool.name, message: `--${flagFor(name)} expects JSON: ${(e as Error).message}` } }, EXIT.invalid);
            return false;
          }
          return true;
        };

        // Then the ergonomic forms, which win over the JSON blob so a flag can override it. The
        // positional rides through the SAME resolver as its flag twin — one set of synonyms.
        if (positional && positionalValue !== undefined && props[positional]) {
          if (!assign(input, positional, props[positional]!, positionalValue)) return;
        }
        for (const [name, node] of Object.entries(props)) {
          if (variant && union && name === union.field) continue;
          const supplied = opts[name];
          if (supplied === undefined) continue;
          if (!assign(input, name, node, supplied)) return;
        }

        // Filter flags (cork_query): merge on top of any blob-supplied filters. Values stay raw
        // strings — parseQueryFilters owns coercion (booleans accept "true"/"false") — EXCEPT the
        // digits-only keys (SUGARED_FILTER_KEYS, imported from filters.ts), which get the same
        // amount sugar every schema-derived amount flag has: before this, `--rate 1e18` was
        // refused by an error message written in the very notation the flag would not accept.
        if (filterFlagKeys.length > 0 || filterFlagAliases.length > 0) {
          const blobF = input["filters"];
          const filters: Record<string, unknown> =
            blobF && typeof blobF === "object" && !Array.isArray(blobF) ? { ...(blobF as Record<string, unknown>) } : {};
          let touched = false;
          for (const k of filterFlagKeys) {
            const supplied = opts[k];
            if (supplied === undefined) continue;
            let v = String(supplied);
            if (SUGARED_FILTER_KEYS.has(k) && /[_eE]/.test(v)) {
              const ex = expandAmount(v);
              if ("err" in ex) {
                fail({ error: { code: "invalid_amount", tool: tool.name, message: `--${flagFor(k)}: ${ex.err}` } }, EXIT.invalid);
                return;
              }
              v = ex.ok;
            }
            filters[k] = v;
            touched = true;
          }
          // Aliased keys: commander camelizes the flag spelling (oracle-mode → oracleMode).
          for (const [key, flag] of filterFlagAliases) {
            const supplied = opts[flag.replace(/-(\w)/g, (_, c: string) => c.toUpperCase())];
            if (supplied === undefined) continue;
            filters[key] = String(supplied);
            touched = true;
          }
          if (touched) input["filters"] = filters;
        }

        // Variant subcommand: build the union object — a blob-supplied field is the base, the
        // variant's flattened flags override it, and the discriminator is always injected from
        // the subcommand's own name (never trusted from the blob).
        if (variant && union) {
          let base: Record<string, unknown> = {};
          const blobBase = input[union.field];
          if (blobBase && typeof blobBase === "object" && !Array.isArray(blobBase)) base = { ...(blobBase as Record<string, unknown>) };
          const flagBase = opts[union.field];
          if (flagBase !== undefined) {
            try {
              const parsed = parseJsonPrecise(String(flagBase));
              if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) base = { ...base, ...(parsed as Record<string, unknown>) };
            } catch (e) {
              fail({ error: { code: "invalid_json", tool: tool.name, message: `--${flagFor(union.field)} expects JSON: ${(e as Error).message}` } }, EXIT.invalid);
              return;
            }
          }
          const obj: Record<string, unknown> = base;
          for (const [name, node0] of Object.entries(variant.props)) {
            if (name === union.disc) continue;
            const supplied = opts[name];
            if (supplied === undefined) continue;
            if (!assign(obj, name, resolveNode(node0, defs), supplied)) return;
          }
          obj[union.disc] = variant.value;
          input[union.field] = obj;
        }

        // --enable-deprecated maps onto the same env var the gate reads (deprecation.ts), so the
        // CLI flag and MCP env configuration stay one mechanism — and is RESTORED afterwards:
        // runCli is documented capture-everything/never-exit, so a flagged call must not leave
        // the gate unlocked for later runCli calls in the same process (tests, embedding).
        const prevDeprecated = process.env["CORK_ENABLE_DEPRECATED"];
        if (opts["enableDeprecated"]) process.env["CORK_ENABLE_DEPRECATED"] = "1";
        const callCtx: HandlerContext = { ...ctx, ...(opts["rpcUrl"] ? { rpcUrl: opts["rpcUrl"] as string } : {}) };
        try {
          const envelope = await runTool(tool.name, input, callCtx);
          out += wantsJson ? `${JSON.stringify(envelope, null, 2)}\n` : renderEnvelope(envelope, tool);
          const state = (envelope as { state?: string }).state;
          code = state === "ok" ? EXIT.ok : state === "conflict" ? EXIT.conflict : EXIT.unavailable;
        } catch (e) {
          // Errors are structured on stderr with the same closed codes as the envelope, so
          // scripts parse failures the way they parse stdout.
          if (e instanceof ToolInputError) {
            // Teaching issues (path/expected/received/suggestion — the documented shape, same
            // payload MCP puts in its error envelope) ARE the issues; raw zod issues only when
            // teaching could not be built.
            fail({ error: { code: "invalid_input", tool: e.tool, issues: e.teaching ? e.teaching.issues : e.issues, ...(e.teaching ? { remediation: e.teaching.remediation, example: e.teaching.example } : {}) } }, EXIT.invalid);
          } else {
            fail({ error: { code: "internal_error", tool: tool.name, message: (e as Error).message.split("\n")[0] ?? String(e) } }, EXIT.error);
          }
        } finally {
          if (opts["enableDeprecated"]) {
            if (prevDeprecated === undefined) delete process.env["CORK_ENABLE_DEPRECATED"];
            else process.env["CORK_ENABLE_DEPRECATED"] = prevDeprecated;
          }
        }
      };

    cmd.action(makeAction());

    if (union) {
      {
        const variantNames = union.variants.map((v) => kebab(v.value));
        const variantCanon = new Set([...variantNames, ...variantNames.flatMap((v) => VARIANT_ALIASES[v] ?? [])].map(canonicalise));
        // Exact dispatchable spelling per tolerated form: canonical kebab names first, then the
        // registered aliases (commander dispatches both; anything else must be rewritten).
        const dispatch = new Map<string, string>();
        for (const v of variantNames) dispatch.set(canonicalise(v), v);
        for (const v of variantNames) for (const a of VARIANT_ALIASES[v] ?? []) dispatch.set(canonicalise(a), a);
        const specPaths = [[...tool.cliPath], ...(tool.cliAliases ?? []).map((alias) => [...tool.cliPath.slice(0, -1), alias])];
        for (const specPath of specPaths) {
          unionSpecs.push({
            path: specPath,
            variants: variantCanon,
            variantNames,
            dispatch,
            ...(positional && props[positional]?.enum?.length
              ? {
                  positional: {
                    flag: flagFor(positional),
                    values: new Set([
                      ...props[positional]!.enum!.map((e) => String(e).toLowerCase()),
                      ...(positional === "chainId" ? Object.keys(CHAIN_NAMES) : []),
                    ]),
                  },
                }
              : {}),
          });
        }
      }
      /** Attach one variant's full CLI surface — the parent's positional, the top-level fields
       *  as flags, the variant's own fields flattened, and the action — to a subcommand OR a
       *  top-level verb. ONE builder for both so they cannot drift (they had: the verb copy
       *  silently lost the knownFlags registration the subcommand copy carried). */
      const attachVariantSurface = (target: Command, v: UnionVariant): void => {
        // The parent's positional works here too (`ch prepare pool exercise 1`): rejecting an
        // operand the long form accepts was the R4 class in miniature.
        if (positional) target.argument(`[${positional}]`, props[positional]?.description ? firstSentence(props[positional]!.description!) : positional);
        const registered = new Set<string>();
        // Top-level fields ride as flags here (chainId included — the variant owns the slot).
        for (const [name, node] of Object.entries(props)) {
          if (union.field === name) continue;
          fieldOption(target, registered, name, node);
        }
        // The variant's own fields, flattened.
        for (const [name, node0] of Object.entries(v.props)) {
          if (name === union.disc) continue;
          const node = resolveNode(node0, defs);
          fieldOption(target, registered, name, node);
          knownFlags.set(canonicalise(flagFor(name)), flagFor(name));
        }
        target.action(makeAction(v));
      };

      for (const v of union.variants) {
        const sub = baseOptions(
          cmd
            .command(kebab(v.value))
            .description(firstSentence(v.description ?? `${v.value} (see --explain)`)),
        );
        for (const alias of VARIANT_ALIASES[kebab(v.value)] ?? []) sub.alias(alias);
        attachVariantSurface(sub, v);

        // Top-level verb: pool actions + fill are also PROGRAM-level commands — `ch exercise …`
        // = `ch prepare pool exercise …`, `ch fill …` = `ch prepare order taker-fill …`. Same
        // flags, same action body; a name already taken at the top level is skipped (lint-tested).
        const verb = TOP_LEVEL_VERBS[tool.name]?.(kebab(v.value));
        if (verb !== undefined && !program.commands.some((c) => c.name() === verb || c.aliases().includes(verb))) {
          const top = baseOptions(
            program
              .command(verb)
              .description(`${firstSentence(v.description ?? verb)} (= ch ${tool.cliPath.join(" ")} ${kebab(v.value)})`),
          );
          attachVariantSurface(top, v);
        }
      }
    }
  }

  // Non-tool commands: version/build identity, the MCP server, and self-update. These are CLI
  // plumbing, not registry tools — no envelope, no --explain.
  program
    .command("version")
    .description("print version and build identity (--json for machine-readable)")
    .option("--json", "print as JSON")
    .action((opts: { json?: boolean }) => {
      const info = {
        version: BUILD_VERSION,
        commit: BUILD_COMMIT,
        target: BUILD_TARGET || null,
        schemaVersion: SCHEMA_VERSION,
        runtime: (globalThis as { Bun?: { version: string } }).Bun ? `bun ${(globalThis as { Bun?: { version: string } }).Bun!.version}` : `node ${process.versions.node}`,
      };
      out +=
        opts.json || envWantsJson
          ? `${JSON.stringify(info, null, 2)}\n`
          : `ch ${info.version} (commit ${info.commit})\n  target   ${info.target ?? "(source run)"}\n  schema   ${info.schemaVersion}\n  runtime  ${info.runtime}\n`;
    });

  program
    .command("mcp")
    .description("start the Cork MCP server (all 9 tools): stdio by default (`claude mcp add cork-defi -- ch mcp`), or Streamable HTTP with --http [--port 8080] [--host <addr>] (endpoint /mcp, health /healthz, readiness /readyz, docs /docs/<topic>; bearer auth via CORK_MCP_TOKEN)")
    .option("--http", "serve Streamable HTTP instead of stdio")
    .option("--port <port>", "HTTP port (default 8080)")
    .option("--host <addr>", "bind address (default 127.0.0.1, loopback only)")
    .action(() => {
      // The real server must own stdio from process start, so the binary entrypoint (bin.ts)
      // intercepts `mcp` before commander ever parses. Reaching this action means runCli was
      // invoked directly (tests/embedding), where a captured stdio server cannot work.
      err += "the MCP server owns stdio from process start — run it via the ch entrypoint: `ch mcp`\n";
      code = EXIT.error;
    });

  program
    .command("self-update")
    .description("update ch in place from the latest GitHub release (verifies provenance before swapping)")
    .option("--tag <tag>", "update to a specific release tag instead of latest")
    .option("--dry-run", "resolve and report what would change without downloading")
    .action(async (opts: { tag?: string; dryRun?: boolean }) => {
      const res = await runSelfUpdate({ ...(opts.tag ? { tag: opts.tag } : {}), ...(opts.dryRun ? { dryRun: true } : {}) });
      out += res.out;
      err += res.err;
      code = res.code === 0 ? EXIT.ok : EXIT.error;
    });

  const pre = preParseVariants(normaliseArgv(argv, knownFlags));
  if ("error" in pre) {
    const payload = { error: { code: "invalid_input", tool: "ch", message: pre.error } };
    // argvWantsJson, not envWantsJson: pre-parse errors fire before `--json` is bound as an
    // option, and the bare-flag spelling must reach the same JSON contract (audit R6).
    err += argvWantsJson ? `${JSON.stringify(payload)}\n` : renderError(payload);
    return { code: EXIT.invalid, stdout: out, stderr: err };
  }
  try {
    await program.parseAsync(pre.argv, { from: "user" });
    err += cmdErr; // rare non-error commander stderr (warnings) passes through verbatim
  } catch (e) {
    // exitOverride throws CommanderError for --help/--version/parse errors.
    const ce = e as { code?: string; exitCode?: number; message?: string };
    if (ce.code === "commander.helpDisplayed" || ce.code === "commander.help" || ce.code === "commander.version") {
      err += cmdErr; // error-triggered help text stays user-readable in both modes
      code = EXIT.ok;
    } else {
      // Commander-level parse errors (unknown option/command, excess args) previously leaked
      // plain text onto stderr under JSON mode — the one path where a JSON consumer got
      // non-JSON (audit R6). Same envelope shape as every other CLI error.
      const message = (cmdErr || ce.message || "argument parse error").trim();
      const payload = { error: { code: "invalid_input", tool: "ch", message } };
      err += argvWantsJson ? `${JSON.stringify(payload)}\n` : cmdErr || `${ce.message ?? "argument parse error"}\n`;
      code = code === EXIT.ok ? EXIT.invalid : code;
    }
  }

  return { code, stdout: out, stderr: err };
}
