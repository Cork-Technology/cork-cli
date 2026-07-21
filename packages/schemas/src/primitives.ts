import { getAddress, isAddress } from "viem";
import { z } from "zod";

// Hex-typed outputs (`0x${string}`) so parsed values interoperate with viem/@cork/core directly.
const hex = <T extends `0x${string}`>(re: RegExp, msg: string) =>
  z.string().regex(re, msg).transform((v) => v as T);

// EVM address, normalized to EIP-55 via viem. All-lower/all-upper (no checksum claimed) and correct
// mixed-case pass; a wrong mixed-case checksum (a typo) fails here cleanly via isAddress(strict)
// instead of silently normalizing (getAddress never rejects) or throwing deep in viem at encode time.
//
// The multi-use primitives carry `.meta({ id })` so z.toJSONSchema({ reused: "ref" }) emits each
// ONCE per tool document as a named `$defs` entry with `$ref`s at every use site. Measured effect
// is modest (prepare_phoenix −5% wire) — the real payoff is that a $defs description (TokenAmount,
// UnixSeconds) teaches unit/format once and rides every use site at ~zero marginal cost. `$ref` is
// Claude/OpenAI-safe and spec-legal (JSON Schema 2020-12 default since MCP 2025-11-25, SEP-2106);
// see notes/research/mcp-frontier-2026.md.
export const Address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "expected 0x-prefixed 20-byte address")
  .refine((v) => isAddress(v, { strict: true }), "invalid EIP-55 address checksum")
  .transform((v): `0x${string}` => getAddress(v))
  .describe("EVM address")
  .meta({ id: "Address" });

export const Hex = hex<`0x${string}`>(/^0x[0-9a-fA-F]*$/, "expected 0x-prefixed hex")
  .describe("0x-prefixed hex")
  .meta({ id: "Hex" });

export const Bytes32 = hex<`0x${string}`>(/^0x[0-9a-fA-F]{64}$/, "expected 0x-prefixed 32-byte hex")
  .meta({ id: "Bytes32" });

/** Cork MarketId = keccak256(abi.encode(Market)) — 8-field struct hash [C1]. */
export const MarketId = Bytes32.describe(
  "Cork poolId (MarketId) = keccak256(abi.encode(Market)) [C1]. Get one from cork_query resource:'markets' or api-phoenix.cork.tech/v1/pools/",
).meta({ id: "MarketId" });

const U256_MAX = (1n << 256n) - 1n;
const U64_MAX = (1n << 64n) - 1n;

/** Unsigned integer as a decimal string (bigint on the wire; wire-typed boundary). Bounded to
 *  uint256 — anything larger would explode deep in ABI encoding as an internal error instead of
 *  failing here as teachable invalid input. */
export const UintStr = z
  .string()
  .regex(/^[0-9]+$/, "expected non-negative decimal integer string")
  .refine((v) => BigInt(v) <= U256_MAX, "exceeds uint256 (max 2^256-1)")
  .describe("unsigned integer, decimal string")
  .meta({ id: "UintStr" });

/** Token amount: same wire shape as UintStr, but the description teaches the unit/scale — the
 *  measured top parameter-failure class for DeFi tool servers is exactly wrong-scale amounts
 *  (MCP-Atlas: up to 45% syntax/format errors on financial servers). Rides every amount field
 *  via one shared $defs entry, so the teaching is ~free on the wire. */
export const TokenAmount = z
  .string()
  .regex(/^[0-9]+$/, "expected non-negative decimal integer string")
  .refine((v) => BigInt(v) <= U256_MAX, "exceeds uint256 (max 2^256-1)")
  .describe(
    "token amount in the token's own smallest unit (wei-style — respect that token's decimals, e.g. 1e18 for 18-decimals, 1e6 for USDC-style), decimal string. NOT a human-readable decimal",
  )
  .meta({ id: "TokenAmount" });

/** uint64-bounded decimal string — EIP-712 uint64 wire fields (deadlines, salts, nonces, chain
 *  ids in OrderData). */
export const Uint64Str = z
  .string()
  .regex(/^[0-9]+$/, "expected non-negative decimal integer string")
  .refine((v) => BigInt(v) <= U64_MAX, "exceeds uint64 (max 18446744073709551615) — this OrderData field is a uint64 on the wire")
  .describe("unsigned 64-bit integer, decimal string")
  .meta({ id: "Uint64Str" });

/** Absolute unix timestamp in seconds — uint64 wire shape with the time semantics taught inline
 *  (deadlines/expiries here are wall-clock absolute, never relative durations). */
export const UnixSeconds = z
  .string()
  .regex(/^[0-9]+$/, "expected non-negative decimal integer string")
  .refine((v) => BigInt(v) <= U64_MAX, "exceeds uint64 — expected an absolute unix timestamp in seconds")
  .describe("absolute unix timestamp in SECONDS (not ms), decimal string — a wall-clock moment, not a relative duration")
  .meta({ id: "UnixSeconds" });

export const ChainId = z
  .literal([1, 42161, 8453, 11155111, 49222])
  .describe(
    "1=mainnet,42161=arbitrum,8453=base,11155111=sepolia,49222=cork-virtual-staging",
  );
export type ChainId = z.infer<typeof ChainId>;

export const DataMode = z
  .enum(["centralized", "lite-decentralized", "full-decentralized"])
  .describe(
    "explicit data mode; never silent-fallback [RFC §7]. centralized=venue API (api-phoenix); lite-decentralized=direct RPC chain reads (default for chain resources); full-decentralized=HyperSync event scans (needs ENVIO_API_TOKEN). Omit to let the resource pick its natural mode",
  );
export type DataMode = z.infer<typeof DataMode>;

export const Format = z.enum(["concise", "full"]).default("concise");

export const ClientRequestId = z
  .string()
  .min(8)
  .max(128)
  .describe(
    "caller-chosen idempotency key — reuse it when retrying the same request [K2]. Artifacts are deterministic for identical inputs, observed state, and clock; deadline/expiry fields are wall-clock + duration, so bytes re-anchor in time on a later retry",
  );
