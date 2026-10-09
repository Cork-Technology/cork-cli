// Docs-freshness gate — the drift class where the partner quickstart shipped
// a full release cycle documenting the RETIRED registry generation while cork-defaults.json at
// the same tag carried the current one. Docs are prose, so no type checker sees them rot; this
// suite makes the rot self-announcing by tying the quickstart's generation markers to the SAME
// config the tool resolves. The next registry redeploy edits cork-defaults.json → this fails →
// the doc refresh becomes part of the change, not a later report.
import { readdirSync, readFileSync } from "node:fs";
import { DOC_TOPICS, inputJsonSchema, REGISTRY } from "@cork/schemas";
import { describe, expect, it } from "vitest";
import { BUNDLED_DEFAULTS } from "../src/config-remote.ts";
import { ConfigOverrideSchema, mergeConfig } from "../src/config-override.ts";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
const quickstart = read("../../../docs/zyfai-quickstart.md");
const anatomy = read("../../../docs/jit-order-anatomy.md");
// Schema 2 (0.6): a chain hosts a SET of generations, one primary. The quickstart's worked
// examples are live captures against phoenix/v0.3-rc.1 (0.3.3), which stays ACTIVE — so the doc
// must name BOTH the primary set's addresses (what a new market uses) and the 0.3.3 set's (what
// every listed pool still reads as), and no address from a retired or legacy set.
type MarketRegistryBlock = { registry: string; adapter: string; contractsVersion: string; wire: string; recipes?: Record<string, string> };
const config = JSON.parse(read("../../../cork-defaults.v2.json")) as {
  generations: Record<string, { primary: string; sets: Record<string, { status: string; marketRegistry?: MarketRegistryBlock & Record<string, unknown> }> }>;
};

// The quickstart's walkthrough chain (Base).
const BASE = config.generations["8453"]!;
const PRIMARY = BASE.sets[BASE.primary]!.marketRegistry!;
const ACTIVE_REGISTRIES = Object.values(BASE.sets)
  .filter((g) => g.status === "active" && g.marketRegistry && g.marketRegistry.wire !== "legacy")
  .map((g) => g.marketRegistry!);
// The set the examples were captured against; the test names it by wire so a future relabel fails loudly.
const FLAT = ACTIVE_REGISTRIES.find((mr) => mr.wire === "flat")!;
const ARBITRUM = config.generations["42161"]!;
const LEGACY_STACKS = Object.values(ARBITRUM.sets)
  .map((g) => g.marketRegistry)
  .filter((mr): mr is MarketRegistryBlock & Record<string, unknown> => mr !== undefined && mr.wire === "legacy");

/** Superseded 0.3.x stacks, pinned as history: these exact addresses shipped in the quickstart's
 *  worked examples after the 0.3.3 redeploy retired them (the drift inventory). Config no
 *  longer records them anywhere (git history does), so they are constants here — append the next
 *  generation's set when it retires; never remove entries. */
const RETIRED_032_STACK = [
  "0xF5323F305360A792284814a7EDe78c2209A1DC94", // MarketRegistry 0.3.2
  "0x1b754F17EDd87784b01542aAe0e4CA672CFdc7CE", // CorkLimitOrderAdapter 0.3.2
  "0xD27c7BB8564Db019B41d9C48d1ABCEd9A7d90291", // LiquidityPriceRecipe 0.3.2
  "0x1cF1ef3F0d2f59Bf26A373ce7Dcf0F88612C1506", // LiquidityNavRecipe 0.3.2
  "0x6d838136bbbE7D34Ce8dDDc431Ce1bB4A1F9D98D", // FixedRateRecipe 0.3.2
  "0x0846D8849887fC377891E716D3bF4ad46208aA82", // sUSDe/mwUSDC nav wrapper under the 0.3.2 registry
];

const has = (doc: string, needle: string) => doc.toLowerCase().includes(needle.toLowerCase());

describe("docs freshness: zyfai-quickstart.md tracks the configured registry generations", () => {
  it("the config pins a nested-wire primary and a flat-wire active set on Base (the two generations the doc describes)", () => {
    expect(PRIMARY.wire).toBe("nested");
    expect(FLAT, "an ACTIVE flat-wire (0.3.x) registry on Base — the set the worked examples were captured against").toBeDefined();
    expect(BASE.primary).toBe("phoenix/v0.5");
    // The older nested set the doc names beside it keeps its own 0.4.0 adapter, and the doc shows it.
    expect(has(quickstart, "0x3E01C558fc0854e92e6ef2a84c19D6Bf9D82B104")).toBe(true);
  });

  it("names the PRIMARY generation: registry, adapter, market creator and all four recipes from cork-defaults.v2.json", () => {
    const r = PRIMARY.recipes!;
    for (const addr of [PRIMARY.registry, PRIMARY.adapter, PRIMARY["marketCreator"] as string, r.liquidity!, r.nav!, r.fixed!, r.impairment!]) {
      expect(has(quickstart, addr), `quickstart must show the primary-generation address ${addr}`).toBe(true);
    }
  });

  it("still names the ACTIVE flat-wire generation its examples were captured against: registry, adapter, and all three original recipes", () => {
    for (const addr of [FLAT.registry, FLAT.adapter, FLAT.recipes!.liquidity!, FLAT.recipes!.nav!, FLAT.recipes!.fixed!]) {
      expect(has(quickstart, addr), `quickstart must show the 0.3.3 address ${addr} (its captures)`).toBe(true);
    }
  });

  it("every 'contracts release X' claim names an ACTIVE generation's contractsVersion, and the primary's is claimed — a config relabel without a doc refresh fails here", () => {
    const claims = [...quickstart.matchAll(/contracts release \*{0,2}(\d+\.\d+\.\d+)/g)].map((m) => m[1]!);
    expect(claims.length, "the quickstart is expected to state its releases at least twice (status block, risks section)").toBeGreaterThanOrEqual(2);
    const active = new Set(ACTIVE_REGISTRIES.map((mr) => mr.contractsVersion));
    for (const v of claims) expect(active.has(v), `'contracts release ${v}' names no ACTIVE registry generation (${[...active].join(", ")})`).toBe(true);
    expect(claims, "the primary's release must be claimed somewhere").toContain(PRIMARY.contractsVersion);
  });

  it("carries NO retired-generation addresses — neither the superseded 0.3.2 stack nor the legacy (pre-2.1.0) registry stack", () => {
    const legacy = LEGACY_STACKS.flatMap((mr) => Object.values(mr).filter((v): v is string => typeof v === "string" && v.startsWith("0x")));
    expect(legacy.length, "the legacy registry stack is still configured (arbitrum-v1.1)").toBeGreaterThan(0);
    for (const addr of [...RETIRED_032_STACK, ...legacy]) {
      expect(has(quickstart, addr), `retired address ${addr} must not appear in the quickstart`).toBe(false);
    }
  });
});

describe("docs freshness: jit-order-anatomy.md is address-free by design", () => {
  it("contains no 20-byte addresses (role hashes are bytes32 and allowed)", () => {
    // exactly 40 hex chars — a 64-char bytes32 fails the negative lookahead at position 40.
    const addresses = anatomy.match(/0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g) ?? [];
    expect(addresses, "the anatomy doc survives redeploys precisely because it names no deployment").toEqual([]);
  });

  it("pins the on-chain-verified role pair (POOL_CREATOR + FEE_MANAGER, not the pre-v1.3 CONFIGURATOR) and the nested-wire role holder", () => {
    // keccak256("POOL_CREATOR_ROLE") / keccak256("FEE_MANAGER_ROLE") — verified against the live
    // v1.3 controller 2026-08-12: the adapter holds these two and does NOT hold CONFIGURATOR_ROLE.
    expect(anatomy).toContain("0x4066b03ab177190abcd4de6384e71f7a60f56b879537b65d43a0523ade6cfe52");
    expect(anatomy).toContain("0x6c0757dc3e6b28b2580c03fd9e96c274acf4f99d91fbec9b418fa1d70604ff1c");
    // The stale pair's hash must not be presented as a precondition (prose may NAME the role).
    expect(anatomy).not.toContain("0x3b49a237fe2d18fa4d9642b8a0e065923cceb71b797783b619a030a61d848bf0");
    // 0.5.0 (nested wire, verified live 2026-09-22): the role moved to the CREATOR, and the
    // 1.4.0 controller has no FEE_MANAGER_ROLE — the doc must say both, per generation.
    expect(anatomy).toMatch(/the \*\*creator\*\*/);
    expect(anatomy).toMatch(/no `FEE_MANAGER_ROLE`/);
  });

  it("documents both payload layouts by their wire names and the fields that moved", () => {
    for (const needle of ["`flat`", "`nested`", "bytes32 oracleSalt", "bytes   extraData", "bool         enableJitMint", "InvalidFees", "MARKET_CREATOR"]) {
      expect(anatomy, `anatomy must mention ${needle}`).toContain(needle);
    }
  });
});

describe("docs freshness: docs/cli.md's staging config.json example parses and merges", () => {
  const cli = read("../../../docs/cli.md");
  const section = cli.slice(cli.indexOf("### Point one install at staging"));
  const block = /```json\n([\s\S]*?)\n```/u.exec(section)?.[1];

  it("the section carries one fenced JSON block, and it is valid JSON once the address placeholders are filled", () => {
    expect(block).toBeDefined();
    expect(() => JSON.parse(block!.replaceAll("0x…", "0x1111111111111111111111111111111111111111"))).not.toThrow();
  });

  it("the block passes the override schema as written — schemaVersion, every required field, the field NAMES the schema knows (an unknown name is stripped silently, so a typo here would ship a half-set)", () => {
    const doc = JSON.parse(block!.replaceAll("0x…", "0x1111111111111111111111111111111111111111")) as Record<string, unknown>;
    const parsed = ConfigOverrideSchema.safeParse(doc);
    expect(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues)).toBe(true);
    // Strict on names: every key the doc writes must survive the parse (`.strip()` would drop a
    // misspelled one, as `creator` was before this test existed).
    const docSet = ((doc.generations as Record<string, { sets: Record<string, Record<string, Record<string, unknown>>> }>)["8453"]!).sets["phoenix/staging"]!;
    const parsedSet = parsed.success ? (parsed.data.generations!["8453"]!.sets!["phoenix/staging"]! as unknown as Record<string, Record<string, unknown>>) : {};
    for (const blockName of ["phoenix", "marketRegistry"]) {
      expect(Object.keys(parsedSet[blockName]!).sort(), blockName).toEqual(Object.keys(docSet[blockName]!).sort());
    }
  });

  it("merged onto the bundled defaults it adds the set and moves Base's primary, and leaves every production set readable", () => {
    const doc = JSON.parse(block!.replaceAll("0x…", "0x1111111111111111111111111111111111111111")) as Record<string, unknown>;
    const { merged, summary } = mergeConfig(BUNDLED_DEFAULTS, ConfigOverrideSchema.parse(doc));
    const base = (merged as unknown as { generations: Record<string, { primary: string; sets: Record<string, unknown> }> }).generations["8453"]!;
    expect(base.primary).toBe("phoenix/staging");
    expect(Object.keys(base.sets)).toEqual(expect.arrayContaining(["phoenix/staging", ...Object.keys(BUNDLED_DEFAULTS.generations["8453"]!.sets)]));
    expect(JSON.stringify(summary)).toContain("phoenix/staging");
  });
});

// ── Rollover roles ─────────────────────────────────────────────────────────────────────────────
// A rollover takes two parties, and the contracts fix who is who. The cPT holder owns the clone,
// signs the order and is paid the premium. The source cST holder fills through BaseFiller: brings
// the source cST, pays the premium, receives the destination cST. Who ASKS is not a role: the
// venue lets either party open, answer or counter a rollover RFQ (2026-10-09; a cover holder that
// opens one fills an order that cannot cite it, cork-indexing-api#121), so asking, requesting and
// opening an RFQ are judged against nobody. The 0.7.0-rc.2 docs named the cST
// holder as the signer and the requester in four places, and claimed the tool could not build
// the fill months after `rollover-fill` shipped. Prose has no type checker, so this block reads
// the roles from the schemas, then holds every prose surface to them clause by clause.

/** Clauses of prose: whitespace folded, split at clause punctuation and "and". An aside — a
 *  parenthetical or a pair of em dashes — is lifted out and judged on its own, and the sentence is
 *  judged without it: "The cST holder (principal) signs" must read as "The cST holder signs", and
 *  the aside may carry a claim of its own. A fenced code block contributes one clause per LINE, so
 *  command lines never run together; CLI flags are dropped first (`--client-request-id` is not
 *  the verb "request"). */
function sentences(text: string): string[][] {
  const out: string[][] = [];
  const split = (s: string) => {
    for (const sentence of s.split(/[.;:!?#]/)) {
      const cl = sentence.split(/,|\band\b/).map((c) => c.replace(/\s+/g, " ").trim()).filter(Boolean);
      if (cl.length > 0) out.push(cl);
    }
  };
  text.split(/^```[^\n]*$/m).forEach((part, i) => {
    const units = i % 2 === 1 ? part.split("\n") : [part];
    for (const u of units) {
      let main = u.replace(/--[a-z][a-z0-9-]*/g, " ").replace(/\s+/g, " ");
      const asides: string[] = [];
      // Innermost parentheses first, repeatedly, so nesting unwinds; then dash pairs.
      for (let prev = ""; prev !== main; ) {
        prev = main;
        main = main.replace(/\(([^()]*)\)/g, (_, inner: string) => (asides.push(inner), " "));
      }
      main = main.replace(/ — ([^—]*?) — /g, (_, inner: string) => (asides.push(inner), " ")).replace(/—/g, ",");
      split(main);
      for (const a of asides) split(a);
    }
  });
  return out;
}
const clauses = (text: string): string[] => sentences(text).flat();

// The detector is a heuristic over English, so it is built to fail closed on the mistakes that
// matter and to stay quiet on what both parties legitimately do. Both parties SIGN something (the
// filler signs transactions, approvals and, when reserved, a FillerAuth), and both parties OPEN or
// COLLECT things, so a bare verb is not a role claim: the role is in the verb's OBJECT. What stays
// strict on purpose: "signs" with no object or a pronoun object ("signs it") counts as signing
// the order; rephrase with the object named. A clause carrying a negation states what a party
// does NOT do and is never a violation — "not only does the cST holder sign" would slip through,
// an accepted false negative.

/** Objects that are not the order: what a filler signs on the way to a fill. */
const NOT_THE_ORDER = /\b(transactions?|tx|approv\w*|permits?|FillerAuth|calldata)\b|\bthe fill\b/i;

/** What only the order's SIGNER does: sign the order, receive the premium. Asking for a price is
 *  not here: either party may ask. */
function signerAct(c: string): boolean {
  if (/\bsigns?\b|\bsigned\b(?! by)/.test(c) && !NOT_THE_ORDER.test(c)) return true;
  if (/\b(receives?|collects?|gets?|earns?|is paid) the premium\b/i.test(c)) return true;
  // Naming the intent as the party's own instrument ("rolls cover with a rollover-intent").
  return /\brollover-intent\b/.test(c) && !fillerAct(c);
}

/** What only the FILLER does: fill, bring the source cST, pay the premium. */
function fillerAct(c: string): boolean {
  return /\bfills?\b|\brollover-fill\b|\bbrings? the (source )?cST\b|\bpays? the premium\b/.test(c);
}

/** A holder named in the clause as its actor. A possessive ("the cPT holder's order") or the agent
 *  of a passive ("signed by the cPT holder") is not the clause's subject. */
const HOLDER = /\b(cST|cPT) holders?\b(?!['’]s)/;
const PASSIVE_AGENT = /\bby (the |a |an )?(source )?(cST|cPT) holders?\b/g;

/** A contrast ("not the cPT holder", "unlike the cST holder") names a holder without becoming the
 *  subject of what follows. */
const CONTRAST = /^(not|never|unlike|rather than|instead of)\b/i;
/** A negated act is removed before the clause is judged: "does not sign", "never fills", "is not
 *  the requester". Only the act the negation governs goes; another act in the same clause stays
 *  asserted ("a cST holder who never fills orders signs the rollover order"), and a negation
 *  that governs no act leaves the clause whole ("a cST holder who does not know what a roll is
 *  worth can ask for a price"). A clause opening with "No" ("No cST holder signs") has no actor. */
const NEGATED_ACT =
  /\b(not|never|cannot|can't|doesn't|don't|isn't|won't|no longer)\s+(\w+\s+){0,2}?(signs?|signed|fills?|asks?|requests?|opens?|pays?|receives?|collects?|gets?|earns?|brings?|the requester|a requester)\b/gi;
const NO_ACTOR = /^no\b/i;

/** A passive puts its agent in a role directly: "the order is signed by a cST holder". */
function passiveViolation(c: string): boolean {
  if (/\bsigned by (the |a |an )?(source )?cST holders?\b/.test(c) && !NOT_THE_ORDER.test(c)) return true;
  if (/\bpremium\b.*\b(paid|goes) to (the |a |an )?(source )?cST holders?\b/.test(c)) return true;
  return /\b(filled|paid) by (the |a |an )?(source )?cPT holders?\b/.test(c);
}

/** Each sentence that puts a party in the other party's role. A clause that names no holder keeps
 *  the sentence's last subject, so a list of verbs is judged against the party that heads it:
 *  "The cPT holder answers, fills and pays the premium" is three claims about the cPT holder. */
function roleViolations(text: string): string[] {
  const bad: string[] = [];
  for (const s of sentences(text)) {
    let subject: string | undefined;
    for (const c of s) {
      if (!CONTRAST.test(c)) subject = HOLDER.exec(c.replace(PASSIVE_AGENT, " "))?.[1] ?? subject;
      if (NO_ACTOR.test(c)) continue;
      const asserted = c.replace(NEGATED_ACT, " ");
      if (passiveViolation(asserted) || (subject === "cST" && signerAct(asserted)) || (subject === "cPT" && fillerAct(asserted))) {
        bad.push(s.join(", "));
        break;
      }
    }
  }
  return bad;
}

/** Every prose surface a reader or an agent meets: the docs, the README, every doc topic, and
 *  every tool's input schema (its descriptions are what an agent reads first). */
const ROLE_SURFACES: Array<[string, string]> = [
  ...readdirSync(new URL("../../../docs/", import.meta.url))
    .filter((f) => f.endsWith(".md"))
    .map((f): [string, string] => [`docs/${f}`, read(`../../../docs/${f}`)]),
  ["README.md", read("../../../README.md")],
  ...Object.values(DOC_TOPICS).map((t): [string, string] => [`topic:${t.name}`, `${t.summary}\n${t.body}`]),
  ...REGISTRY.map((t): [string, string] => [`schema:${t.name}`, JSON.stringify(inputJsonSchema(t.name))]),
];

describe("docs freshness: rollover roles — the cPT holder signs, the cST holder fills, either may ask", () => {
  // Read from the ADVERTISED contract (the JSON Schema every MCP client and `--explain` see), so
  // the roles are anchored to what an agent is told, not to zod's internal object shape.
  type JsonNode = { description?: string; properties?: Record<string, JsonNode>; oneOf?: JsonNode[]; const?: string };
  const variant = (tool: Parameters<typeof inputJsonSchema>[0], type: string): JsonNode => {
    const schema = inputJsonSchema(tool) as unknown as JsonNode;
    const found = schema.properties!.action!.oneOf!.find((v) => v.properties!.type!.const === type);
    expect(found, `${tool} ${type}`).toBeDefined();
    return found!;
  };
  const descriptionAt = (node: JsonNode, ...path: string[]): string => {
    const leaf = path.reduce((n, key) => n.properties![key]!, node);
    expect(leaf.description, path.join(".")).toBeTypeOf("string");
    return leaf.description!;
  };

  it("the advertised schemas state the roles this block holds the prose to", () => {
    const intent = variant("cork_prepare_orders", "rollover-intent");
    const fill = variant("cork_prepare_orders", "rollover-fill");
    const open = variant("cork_submit", "rfq-open");
    // The signer's own cPT is pulled into its clone: the signer is the cPT holder.
    expect(descriptionAt(intent, "standardHooks", "srcCptToken")).toMatch(/SOURCE pool's cPT[\s\S]*pulls orderSize of it from you/);
    // The fill's caller brings the source cST and pays the premium; the signature it carries is the cPT holder's.
    expect(fill.description).toMatch(/you bring the SOURCE cST, pay the premium/);
    expect(descriptionAt(fill, "signedOrder", "signature")).toMatch(/^the cPT holder's signature/);
    // Either party may open the rollover RFQ, so its premium token is named for both sides.
    expect(descriptionAt(open, "premiumToken")).toMatch(/you receive it when you hold the cPT, you pay it when you hold the cover/);
  });

  it("the detector flags each sentence the docs once shipped, and the symmetric mistake, and passes the corrected forms", () => {
    for (const wrong of [
      "a rollover-intent src→dst for a cST holder",
      "a cST holder rolling cover to a successor expiry signs a `rollover-intent`",
      "A cST holder rolls cover with a `rollover-intent`.",
      "The cPT holder fills the order with `rollover-fill`.",
      "the cPT holder pays the premium",
      "The cST holder (principal) signs a `rollover-intent`.", // an aside between subject and verb
      "A cST holder — the party that is paid — signs the order.",
      "Rollover orders (a cST holder signs them) rest on the venue.", // a claim inside the aside
      "The source cPT holder answers, fills with `rollover-fill` and pays the premium.", // the subject heads a verb list
      "The cST holder reads the quote, accepts it and signs the order.",
      "The cST holder, not the cPT holder, signs the order.", // a contrast does not take the subject
      "The rollover order is signed by a cST holder.", // a passive names its agent's role directly
      "The order is filled by the cPT holder.",
      "The premium is paid by the cPT holder.",
      "The premium goes to the cST holder.",
      "The cST holder collects the premium.",
      "The cST holder signs it.", // strict on purpose: an unnamed object counts as the order
      "A cST holder who never fills orders signs the rollover order.", // the negation governs another verb
    ]) expect(roleViolations(wrong), wrong).not.toEqual([]);
    for (const right of [
      "the cPT holder signs a rollover-intent src→dst and the source cST holder fills it with rollover-fill",
      "The cPT holder opens the rollover RFQ, signs the order and receives the premium.",
      // Either party may ask (2026-10-09): a cover holder that opens the RFQ is no role violation.
      "A cST holder who does not know what a roll is worth can ask for a price.",
      "The cST holder is the requester of a rollover RFQ.",
      "The cST holder opens a rollover RFQ with an API key and fills the order by its terms.",
      "The rollover RFQ is opened by a cST holder.",
      "A source cST holder answers, fills with `rollover-fill` and pays the premium.",
      "The cST holder pays the premium to the cPT holder.", // the first-named holder is the subject
      // An aside is its own sentence: its subject does not leak into the main clause, and the
      // main clause's verb is not read against the aside's holder.
      "The cPT holder (not the cST holder, who fills) signs the order.",
      // Command lines are judged one by one: a holder named in one line's comment is not the
      // subject of the next line's command.
      "```sh\nch prepare order rollover-intent --settler <0x…>   # cPT holder\nch prepare order rollover-fill --order-digest <0x…>   # cST holder\n```",
      // What both parties legitimately do: the filler signs transactions, approvals and a
      // FillerAuth, opens and collects things that are not the RFQ or the premium.
      "The cST holder signs the fill transaction.",
      "The exclusive filler, a cST holder, signs a FillerAuth for you.",
      "The cST holder signs the approve transaction for BaseFiller.",
      "The cST holder opens a cover position on the new pool.",
      "The cST holder collects the destination cST.",
      // Negations state what a party does not do.
      "The cST holder never signs the order.",
      "The cST holder does not sign the rollover order.",
      "The cPT holder never fills the order.",
      "The cST holder is not the requester.",
      "No cST holder signs the rollover order.",
      // A possessive is not a subject, and neither is a passive's agent.
      "The cPT holder's order fills when the cST holder runs rollover-fill.",
      "The rollover order is signed by a cPT holder, and a cST holder fills it.",
      // The agent of a passive does not carry over as the subject of the next clause: here the
      // ORDER fills once, not the cPT holder.
      "Each rollover order is signed by a cPT holder and fills once.",
      "The premium is paid by the cST holder.",
    ]) expect(roleViolations(right), right).toEqual([]);
  });

  it("no prose surface puts the cST holder in the signer's role or the cPT holder in the filler's", () => {
    const found = ROLE_SURFACES.flatMap(([name, text]) => roleViolations(text).map((c) => `${name}: ${c}`));
    expect(found).toEqual([]);
    expect(ROLE_SURFACES.length).toBeGreaterThan(REGISTRY.length + Object.keys(DOC_TOPICS).length); // the docs were read too
  });

  it("every surface that tells a reader about rollover-intent also names rollover-fill — the trade has two sides", () => {
    const halfTold = ROLE_SURFACES.filter(([name, text]) => !name.startsWith("schema:") && text.includes("rollover-intent") && !text.includes("rollover-fill")).map(([name]) => name);
    expect(halfTold).toEqual([]);
  });

  it("no surface says the tool cannot build the fill", () => {
    const claims = ROLE_SURFACES.flatMap(([name, text]) =>
      clauses(text).filter((c) => /\b(does not|doesn't|cannot|can't|not yet)\b.{0,40}\bbuild\b.{0,30}\bfill/i.test(c)).map((c) => `${name}: ${c}`),
    );
    expect(claims).toEqual([]);
  });
});
