// registry.ts — the framework-agnostic tool registry.
// RULE UNDER TEST: no CLI-framework imports here, no framework-specific meta keys.
// Wire-typed boundary (G2): all inputs/outputs are JSON-safe strings/numbers/booleans.
import { z } from "zod";

export const MarketId = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/)
  .describe("Cork MarketId (bytes32 hex)");
const DecStr = z.string().regex(/^\d+$/);

export interface ToolDef<
  In extends z.ZodObject = z.ZodObject,
  Out extends z.ZodType = z.ZodType,
> {
  /** MCP tool name, e.g. "cork_rates_floor" */
  name: string;
  description: string;
  /** CLI command path, e.g. ["rates", "floor"] */
  cliPath: readonly string[];
  /** input keys rendered as CLI positionals, in order (CLI concern, but framework-agnostic data) */
  positional?: readonly string[];
  input: In;
  output: Out;
  handler: (input: z.output<In>) => Promise<z.input<Out>> | z.input<Out>;
}

// helper keeps inference exact without casts
export function defineTool<In extends z.ZodObject, Out extends z.ZodType>(
  def: ToolDef<In, Out>,
): ToolDef<In, Out> {
  return def;
}

// --- command 1: rates floor (real committed-descent math from the fork experiments) ---
const floorInput = z.object({
  poolId: MarketId,
  lastAdjustedRate: DecStr.describe("WAD rate from constraints() (decimal string)"),
  remainingCredits: DecStr.describe("remaining credits from constraints() (decimal string)"),
  rateMin: DecStr.describe("market rateMin, WAD (decimal string)"),
  perDayMax: DecStr.describe("market rateChangePerDayMax, WAD/day (decimal string)"),
  horizonDays: z.number().int().min(0).max(365).default(30).describe("projection horizon in days"),
});
const floorOutput = z.object({
  worstRate: z.string().describe("worst-case adjusted rate at horizon, WAD decimal string"),
  clampedAtMin: z.boolean(),
});

export const ratesFloor = defineTool({
  name: "cork_rates_floor",
  description: "Worst-case impairment floor over a horizon (committed-descent model)",
  cliPath: ["rates", "floor"],
  positional: ["poolId"],
  input: floorInput,
  output: floorOutput,
  handler: (input) => {
    const last = BigInt(input.lastAdjustedRate);
    const credits = BigInt(input.remainingCredits);
    const min = BigInt(input.rateMin);
    const perDay = BigInt(input.perDayMax);
    const raw = last - credits - perDay * BigInt(input.horizonDays);
    const worst = raw < min ? min : raw;
    return { worstRate: worst.toString(), clampedAtMin: worst === min };
  },
});

// --- command 2: markets get (static fixture; RPC out of scope for the spike) ---
const marketsGetInput = z.object({
  poolId: MarketId,
  chainId: z.number().int().default(1).describe("EVM chain id"),
});
const marketsGetOutput = z.object({
  poolId: MarketId,
  chainId: z.number(),
  collateralAsset: z.string(),
  referenceAsset: z.string(),
  expiryTimestamp: z.number(),
});

export const marketsGet = defineTool({
  name: "cork_markets_get",
  description: "Fetch full market parameters for a Cork pool id",
  cliPath: ["markets", "get"],
  positional: ["poolId"],
  input: marketsGetInput,
  output: marketsGetOutput,
  handler: (input) => ({
    poolId: input.poolId,
    chainId: input.chainId,
    collateralAsset: "0x9D39A5DE30e57443BfF2A8307A4256c8797A3497",
    referenceAsset: "0x53E82ABbb12638F09d9e624578ccB666217a765e",
    expiryTimestamp: 1798761600,
  }),
});

// erase generics for iteration; handlers stay type-safe at definition site
export const registry: readonly ToolDef[] = [ratesFloor, marketsGet] as const;
