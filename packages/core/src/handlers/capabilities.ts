// Split from handlers.ts (2026-08-05): cork_capabilities — discovery/introspection + the
// CREATE2 verify topic. Pure config, no chain reads.
import { DOC_TOPICS, findDocTopic, inputJsonSchema, MATURITY, REGISTRY, SCHEMA_VERSION, searchTools, TOOL_EXAMPLES, toolByName } from "@cork/schemas";
import { verifyCreate2 } from "../create2.ts";
import { CREATE2_ATTESTATIONS, CREATE2_DEPLOYER } from "../config.ts";
import { envelope, type HandlerContext, unavailable } from "./shared.ts";
import type { Envelope } from "@cork/schemas";

export async function handleCapabilities(input: { topic?: string; search?: string }, ctx: HandlerContext): Promise<Envelope> {
  if (input.topic === "verify") {
    // Independently re-derive each deployed address from (deployer, salt, initCodeHash) [C10].
    const verifications = CREATE2_ATTESTATIONS.map((a) => ({
      name: a.name,
      ...verifyCreate2({ deployer: CREATE2_DEPLOYER, salt: a.salt, initCodeHash: a.initCodeHash, expected: a.expected }),
      salt: a.salt,
      initCodeHash: a.initCodeHash,
    }));
    const allMatch = verifications.every((v) => v.match);
    return envelope({
      state: allMatch ? "ok" : "conflict",
      data: { deployer: CREATE2_DEPLOYER, verifications },
      chainId: 1,
      source: "config",
      ...(allMatch ? {} : { warnings: [{ code: "create2_mismatch", message: "a deployed address did not reproduce from its salt+initCodeHash" }] }),
      ctx,
    });
  }
  const card = (t: (typeof REGISTRY)[number]) => ({ name: t.name, cli: `ch ${t.cliPath.join(" ")}`, phase: t.phase, maturity: MATURITY[t.name], description: t.description, annotations: t.annotations });

  // search: natural-language query -> ranked tools with the best-matching VARIANT (token
  // scoring over names/descriptions/example titles + per-variant hint phrases; search.ts).
  if (input.search) {
    const ranked = searchTools(input.search);
    const matches = ranked.map((r) => {
      // A doc-topic hit (e.g. "how do I sign/broadcast this?") returns the topic card inline —
      // summary + the exact lookup — rather than pretending to be a tool.
      if (r.topic !== undefined) {
        const topic = findDocTopic(r.topic)!;
        return { topic: topic.name, aliases: topic.aliases, summary: topic.summary, reference: `cork_capabilities topic:"${topic.name}"` };
      }
      const t = toolByName(r.name)!;
      const variantMaturity = r.variant ? MATURITY[r.name]?.variants?.[r.variant] : undefined;
      return {
        ...card(t as (typeof REGISTRY)[number]),
        ...(r.variant !== undefined ? { variant: r.variant } : {}),
        ...(variantMaturity !== undefined ? { variantMaturity } : {}),
        examples: TOOL_EXAMPLES[r.name],
        inputSchema: inputJsonSchema(r.name),
      };
    });
    return envelope({ state: "ok", data: { query: input.search, matches }, chainId: 1, source: "config", ctx });
  }

  // topic: a DOC TOPIC (guidance about using the surface, e.g. "signing" — resolved first, by
  // name or alias), else a tool name (with or without cork_ prefix) or cli leaf -> full doc.
  if (input.topic) {
    const doc = findDocTopic(input.topic);
    if (doc) {
      return envelope({
        state: "ok",
        data: { topic: doc.name, aliases: doc.aliases, summary: doc.summary, body: doc.body },
        chainId: 1,
        source: "config",
        ctx,
      });
    }
    const key = input.topic.toLowerCase();
    const t = REGISTRY.find((x) => x.name.toLowerCase() === key || x.name.toLowerCase() === `cork_${key}` || x.cliPath.join(" ").toLowerCase() === key || x.cliPath[x.cliPath.length - 1]?.toLowerCase() === key || (x.cliAliases ?? []).some((a) => a.toLowerCase() === key));
    if (!t) {
      // The teaching list is DERIVED from DOC_TOPICS — a hardcoded copy here would drift the
      // moment a topic is added, in the one message whose job is naming what exists.
      const topics = Object.values(DOC_TOPICS).map((d) => `${d.name} (aliases: ${d.aliases.join(", ")})`).join("; ");
      return unavailable(1, "unknown_topic", `no tool or doc topic matches '${input.topic}'; doc topics: ${topics} — else try search or omit args for the full list`, ctx);
    }
    return envelope({ state: "ok", data: { ...card(t), examples: TOOL_EXAMPLES[t.name], inputSchema: inputJsonSchema(t.name), output: "Envelope" }, chainId: 1, source: "config", ctx });
  }

  const data = REGISTRY.map(card);
  return envelope({ state: "ok", data: { tools: data, schemaVersion: SCHEMA_VERSION }, chainId: 1, source: "config", ctx });
}
