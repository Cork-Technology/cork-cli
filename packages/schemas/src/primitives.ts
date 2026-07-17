import { getAddress, isAddress } from "viem";
import { z } from "zod";

// Hex-typed outputs (`0x${string}`) so parsed values interoperate with viem/@cork/core directly.
const hex = <T extends `0x${string}`>(re: RegExp, msg: string) =>
  z.string().regex(re, msg).transform((v) => v as T);

// EVM address, normalized to EIP-55 via viem. All-lower/all-upper (no checksum claimed) and correct
// mixed-case pass; a wrong mixed-case checksum (a typo) fails here cleanly via isAddress(strict)
// instead of silently normalizing (getAddress never rejects) or throwing deep in viem at encode time.
export const Address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "expected 0x-prefixed 20-byte address")
  .refine((v) => isAddress(v, { strict: true }), "invalid EIP-55 address checksum")
  .transform((v): `0x${string}` => getAddress(v))
  .describe("EVM address");

export const Hex = hex<`0x${string}`>(/^0x[0-9a-fA-F]*$/, "expected 0x-prefixed hex").describe("0x-prefixed hex");

export const Bytes32 = hex<`0x${string}`>(/^0x[0-9a-fA-F]{64}$/, "expected 0x-prefixed 32-byte hex");

/** Cork MarketId = keccak256(abi.encode(Market)) — 8-field struct hash [C1]. */
export const MarketId = Bytes32.describe(
  "Cork MarketId = keccak256(abi.encode(Market)) [C1]",
);

/** Unsigned integer as a decimal string (bigint on the wire; wire-typed boundary). */
export const UintStr = z
  .string()
  .regex(/^[0-9]+$/, "expected non-negative decimal integer string")
  .describe("unsigned integer, decimal string");

export const ChainId = z
  .literal([1, 42161, 8453, 11155111, 49222])
  .describe(
    "1=mainnet,42161=arbitrum,8453=base,11155111=sepolia,49222=cork-virtual-staging",
  );
export type ChainId = z.infer<typeof ChainId>;

export const DataMode = z
  .enum(["centralized", "lite-decentralized", "full-decentralized"])
  .describe("explicit data mode; never silent-fallback [RFC §7]");
export type DataMode = z.infer<typeof DataMode>;

export const Format = z.enum(["concise", "full"]).default("concise");

export const ClientRequestId = z
  .string()
  .min(8)
  .max(128)
  .describe("caller idempotency key; retries with the same id are byte-safe [K2]");
