// What an RFQ v2 writer signs. Ported byte for byte from the venue's RFQ v2 signing and
// canonical-JSON rules (cork-api 0.4.5) and held to its published test vectors: one wrong byte
// here and the venue refuses every signed write with 401.
//
// The venue hashes the body AFTER its own validation, which lowercases every address and
// bytes32 value (a `market_template_id` and the `oracle_params` values keep their case). A
// caller must hash, and send, the body in that form.

import { sha256, stringToBytes, type Hex } from "viem";

export const RFQ_OPERATIONS = ["open", "answer", "counter"] as const;
export type RfqOperation = (typeof RFQ_OPERATIONS)[number];

export const RFQ_WRITE_DOMAIN_NAME = "Cork RFQ";
export const RFQ_WRITE_DOMAIN_VERSION = "1";

export const RFQ_WRITE_TYPES = {
  CorkRfqWrite: [
    { name: "operation", type: "string" },
    { name: "ref", type: "string" },
    { name: "bodyHash", type: "bytes32" },
  ],
} as const;

const MAX_DEPTH = 64;

/** RFC 8785 canonical JSON over the value domain the venue's schemas admit: keys sorted by
 *  UTF-16 code unit, undefined members dropped, uint256-scale numbers already strings. */
export function canonicalJson(value: unknown, depth = 0): string {
  if (depth > MAX_DEPTH) throw new Error("canonicalJson: input nesting exceeds MAX_DEPTH");
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v, depth + 1)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v, depth + 1)}`).join(",")}}`;
}

/** The body without its proofs, so a signature never signs itself: the top-level `signature`,
 *  and on answers every `options[].order_signature`. */
function unsignedBody(operation: RfqOperation, body: object): object {
  const { signature: _signature, ...rest } = body as Record<string, unknown>;
  if (operation === "answer" && Array.isArray(rest.options)) {
    rest.options = rest.options.map((option: Record<string, unknown>) => {
      const { order_signature: _orderSignature, ...kept } = option;
      return kept;
    });
  }
  return rest;
}

/** The `bodyHash` a CorkRfqWrite signs — also the venue's idempotency fingerprint, so a
 *  re-signed retry of the same body replays instead of conflicting. */
export function rfqWriteBodyHash(operation: RfqOperation, body: object): Hex {
  return sha256(stringToBytes(canonicalJson(unsignedBody(operation, body))));
}

/** The EIP-712 typed data for one write. `ref` is the body's `request_id` on open and the
 *  target `rfq_id` on answer and counter; `chainId` is the RFQ's chain. */
export function rfqWriteTypedData(params: { operation: RfqOperation; ref: string; chainId: number; bodyHash: Hex }) {
  return {
    domain: { name: RFQ_WRITE_DOMAIN_NAME, version: RFQ_WRITE_DOMAIN_VERSION, chainId: params.chainId },
    types: RFQ_WRITE_TYPES,
    primaryType: "CorkRfqWrite" as const,
    message: { operation: params.operation, ref: params.ref, bodyHash: params.bodyHash },
  };
}
