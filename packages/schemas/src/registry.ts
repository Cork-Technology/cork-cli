import { z } from "zod";
import {
  CapabilitiesInput,
  ComputeInput,
  DecodeInput,
  Envelope,
  PrepareMarketInput,
  PrepareOrdersInput,
  PreparePhoenixInput,
  QueryInput,
  SubmitInput,
  TrackInput,
} from "./tools.ts";

export interface ToolAnnotations {
  readOnlyHint: boolean;
  idempotentHint?: boolean;
  destructiveHint?: boolean;
  openWorldHint?: boolean;
}

export interface ToolDef<In extends z.ZodType = z.ZodType> {
  name: `cork_${string}`;
  /** Human display label (MCP Tool.title) — UI-only; models see name/description/schema. */
  title: string;
  /** CLI command path, e.g. ["prepare", "phoenix"] — the human projection. */
  cliPath: readonly string[];
  phase: 1 | 2 | 3 | 4;
  description: string;
  annotations: ToolAnnotations;
  input: In;
  output: z.ZodType;
}

function def<In extends z.ZodType>(d: ToolDef<In>): ToolDef<In> {
  return d;
}

export const REGISTRY = [
  def({
    name: "cork_query",
    title: "Cork: read state",
    cliPath: ["query"],
    phase: 1,
    description:
      "Read any Cork resource. Live chain state: market, account-state, pool-whitelist, protocol-config. Venue-backed (centralized): markets, orderbook, fills, limit-order-markets, flows (rollover orders/fills/contracts via filters.kind). Use for STATE READS. NOT for derived math (use cork_compute) or building txs (use cork_prepare_*).",
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    input: QueryInput,
    output: Envelope,
  }),
  def({
    name: "cork_compute",
    title: "Cork: deterministic math",
    cliPath: ["compute"],
    phase: 1,
    description:
      "Deterministic math over verified chain state: swap/unwind rate, dutch-auction (Fusion) price, rollover premium floor, worst-case impairment floor, RFQ quote. NOT for raw reads or byte-building.",
    annotations: { readOnlyHint: true, idempotentHint: true },
    input: ComputeInput,
    output: Envelope,
  }),
  def({
    name: "cork_decode",
    title: "Cork: decode bytes",
    cliPath: ["decode"],
    phase: 1,
    description:
      "Decode bytes to labeled JSON: Cork calldata (recursively unwraps Bundler3 multicall), a limit order, an event, or a receipt. Reconstructs; never trusts a caller-supplied parse [K3].",
    annotations: { readOnlyHint: true, idempotentHint: true },
    input: DecodeInput,
    output: Envelope,
  }),
  def({
    name: "cork_capabilities",
    title: "Cork: manual & maturity map",
    cliPath: ["capabilities"],
    phase: 1,
    description:
      "The searchable manual + maturity map. No args → maturity of every tool/variant; topic → full variant docs; search → keyword to exact tool+variant+filled template. Progressive disclosure [C13].",
    annotations: { readOnlyHint: true, idempotentHint: true },
    input: CapabilitiesInput,
    output: Envelope,
  }),
  def({
    name: "cork_prepare_phoenix",
    title: "Cork: build unsigned Phoenix bundle",
    cliPath: ["prepare", "phoenix"],
    phase: 2,
    description:
      "Build an unsigned Bundler3 bundle for a Cork Phoenix adapter action or token-authority op. Returns bytes for LATER signing — executes nothing [K1]. Deterministic for identical inputs + observed state; the deadline is wall-clock + deadlineSeconds, so it re-anchors on a later retry [K2]. Post-expiry settles are withdraw/withdraw-other/redeem (pre-expiry actions on an expired pool build but would revert). Full per-variant docs via cork_capabilities.",
    annotations: { readOnlyHint: true, idempotentHint: true },
    input: PreparePhoenixInput,
    output: Envelope,
  }),
  def({
    name: "cork_prepare_orders",
    title: "Cork: build signable order",
    cliPath: ["prepare", "orders"],
    phase: 3,
    description:
      "Build unsigned limit-order lifecycle typed-data (1inch LOP v4 maker/taker/cancel) or a rollover ERC-7683 intent (CorkSettler domain). Returns typed-data for LATER signing. Submission is cork_submit.",
    annotations: { readOnlyHint: true, idempotentHint: true },
    input: PrepareOrdersInput,
    output: Envelope,
  }),
  def({
    name: "cork_prepare_market",
    title: "Cork: build market deployment (gated)",
    cliPath: ["prepare", "market"],
    phase: 4,
    description:
      "Build unsigned market-deployment artifacts. STATUS: Phase 4, schema PROVISIONAL — MarketRegistry surface unverified [Q-REG].",
    annotations: { readOnlyHint: true, idempotentHint: true },
    input: PrepareMarketInput,
    output: Envelope,
  }),
  def({
    name: "cork_track",
    title: "Cork: verify & reconcile",
    cliPath: ["track"],
    phase: 2,
    description:
      "Verify a resource against deployed state, simulate frozen bytes, or reconcile a receipt/order/ref to a closed lifecycle state. Chain outranks indexer; disagreement → state 'conflict' [K7].",
    annotations: { readOnlyHint: true, idempotentHint: true },
    input: TrackInput,
    output: Envelope,
  }),
  def({
    name: "cork_submit",
    title: "Cork: relay signed payload to venue",
    cliPath: ["submit"],
    phase: 3,
    description:
      "Relay a CALLER-signed/authored payload to the Cork venue — the only side-effecting tool. Actions: rollover-order, lop-order (both fully signed; commitments recomputed locally before relay [K3]), rfq-open, rfq-answer. Never signs [K1]; idempotent by clientRequestId [K2].",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    input: SubmitInput,
    output: Envelope,
  }),
] as const satisfies readonly ToolDef[];

export type ToolName = (typeof REGISTRY)[number]["name"];

export function toolByName(name: string): ToolDef | undefined {
  return REGISTRY.find((t) => t.name === name);
}

// `reused: "ref"` extracts EVERY revisited subschema, including union-branch discriminator
// literals (`type: {"const": "mint"}` would become an opaque `$ref` to an anonymous `__schemaN`
// def — hiding exactly the anchor an agent generates against). Keep only the deliberately named
// `.meta({ id })` primitives as `$defs`; fold every anonymous def back inline.
function inlineAnonymousDefs(doc: unknown): unknown {
  if (doc === null || typeof doc !== "object") return doc;
  const root = doc as Record<string, unknown>;
  const defs = (root.$defs ?? {}) as Record<string, unknown>;
  const anon = new Map(Object.entries(defs).filter(([k]) => k.startsWith("__schema")));
  if (anon.size === 0) return doc;
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (node === null || typeof node !== "object") return node;
    const o = node as Record<string, unknown>;
    const ref = o.$ref;
    if (typeof ref === "string" && ref.startsWith("#/$defs/__schema")) {
      const body = walk(anon.get(ref.slice("#/$defs/".length)));
      // JSON Schema 2020-12 allows keywords beside $ref; preserve any siblings over the body.
      const { $ref: _drop, ...siblings } = o;
      return { ...(body as Record<string, unknown>), ...walk(siblings) as Record<string, unknown> };
    }
    return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, walk(v)]));
  };
  const out = walk({ ...root, $defs: Object.fromEntries(Object.entries(defs).filter(([k]) => !k.startsWith("__schema"))) }) as Record<string, unknown>;
  if (out.$defs && Object.keys(out.$defs as object).length === 0) delete out.$defs;
  return out;
}

/** JSON Schema (draft used by zod v4) for a tool's input — the MCP inputSchema.
 *  `reused: "ref"` + the `.meta({ id })` primitives emit each shared primitive once per document
 *  as a named `$defs` entry ($ref at use sites); the size win is modest (phoenix −5%) — the point
 *  is one-place unit/format teaching on shared primitives (spec-legal per JSON Schema 2020-12 /
 *  SEP-2106; Claude+OpenAI follow $ref). Anonymous extractions are folded back inline so
 *  discriminator consts stay visible in place. */
export function inputJsonSchema(name: ToolName): unknown {
  const t = toolByName(name);
  if (!t) throw new Error(`unknown tool: ${name}`);
  return inlineAnonymousDefs(z.toJSONSchema(t.input, { io: "input", reused: "ref" }));
}
