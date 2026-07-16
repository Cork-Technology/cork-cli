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
    cliPath: ["query"],
    phase: 1,
    description:
      "Read any Cork resource (markets, whitelist, orderbook, fills, flows, account state, protocol config). Use for STATE READS. NOT for derived math (use cork_compute) or building txs (use cork_prepare_*).",
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    input: QueryInput,
    output: Envelope,
  }),
  def({
    name: "cork_compute",
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
    cliPath: ["prepare", "phoenix"],
    phase: 2,
    description:
      "Build an unsigned Bundler3 bundle for a Cork Phoenix adapter action or token-authority op. Returns bytes for LATER signing — executes nothing [K1]. Idempotent by clientRequestId [K2].",
    annotations: { readOnlyHint: true, idempotentHint: true },
    input: PreparePhoenixInput,
    output: Envelope,
  }),
  def({
    name: "cork_prepare_orders",
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
    cliPath: ["submit"],
    phase: 3,
    description:
      "Relay a CALLER-SIGNED limit order to the Cork orderbook service. The only side-effecting tool. Transmits an already-signed payload; never signs [K1]. Idempotent by clientRequestId [K2].",
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

/** JSON Schema (draft used by zod v4) for a tool's input — the MCP inputSchema. */
export function inputJsonSchema(name: ToolName): unknown {
  const t = toolByName(name);
  if (!t) throw new Error(`unknown tool: ${name}`);
  return z.toJSONSchema(t.input, { io: "input" });
}
