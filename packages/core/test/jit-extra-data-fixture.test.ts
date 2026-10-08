// Frozen JIT extraData reference vectors for flat and nested adapter layouts.
// Fresh encodings must match the committed bytes and decode field by field.
// Regenerate deliberately with UPDATE_JIT_FIXTURE=1.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { decodeJitExtraData, diffJitExtraData, encodeJitExtraData, type JITMarketParams, type PermitParams, permitSignatureOfVrs, splitPermitSignature } from "@cork/core";

// Fixtures live in this test tree; no excluded harness is required.
const FIXTURE = resolve(import.meta.dirname, "./fixtures/jit-extra-data.json");
const FIXTURE_NESTED = resolve(import.meta.dirname, "./fixtures/jit-extra-data-nested.json");

/** Fixed, non-degenerate params: every field non-zero and distinct, so a swapped or dropped
 *  field cannot hide behind an equal neighbour. */
export const FIXTURE_PARAMS: JITMarketParams = {
  collateralAsset: "0x211Cc4DD073734dA055fbF44a2b4667d5E5fE5d2",
  referenceAsset: "0xdDb46999F8891663a8F2828d25298f70416d7610",
  expiryTimestamp: 1_900_000_000n,
  recipe: "0xb881DB48ad6DA84a8F0D1cE4150Caf7Ae016Dc55",
  rateOverride: 7n,
  constraint: { rateMin: 1n, rateMax: 1_600_000_000_000_000_000n, rateChangePerDayMax: 800_000_000_000_000_000n, rateChangeCapacityMax: 2_400_000_000_000_000_000n },
  extraData: "0x000000000000000000000000000000000000000000000000000000000000002a",
  swapFeePercentage: 3_000_000_000_000_000_000n,
  unwindSwapFeePercentage: 1_500_000_000_000_000_000n,
  enableJitMint: true,
};
/** The flat wire's permit: a 65-byte ECDSA signature r‖s‖v (v = 28), split into v/r/s on the wire. */
export const FIXTURE_PERMITS: PermitParams[] = [
  { token: "0x16Aa2EbE1E2D6C856c634DaFc256257d2fEc0C69", value: 1_000_000_000_000_000_000n, deadline: 1_800_003_600n, signature: `0x${"11".repeat(32)}${"22".repeat(32)}1c` },
];
/** The nested wire's permit (adapter 0.5.0): signature BYTES of a non-ECDSA length — the shape a
 *  contract wallet's ERC-1271 signature takes (85 bytes, like a Safe7579 validator ++ sig). */
export const FIXTURE_PERMITS_NESTED: PermitParams[] = [
  { token: "0x16Aa2EbE1E2D6C856c634DaFc256257d2fEc0C69", value: 1_000_000_000_000_000_000n, deadline: 1_800_003_600n, signature: `0x${"33".repeat(20)}${"44".repeat(65)}` },
];

/** The nested-wire fixture: the same non-degenerate values plus a distinct non-zero oracleSalt
 *  (a dropped or shifted salt word cannot hide behind zeros) and the 0.5.0 recipe address. */
export const FIXTURE_PARAMS_NESTED: JITMarketParams = {
  ...FIXTURE_PARAMS,
  recipe: "0xd5e8F76AafA20aA9A8983A35B71Ad3A793070Ed9",
  oracleSalt: `0x${"5a".repeat(32)}`,
};

const str = (v: bigint | number) => v.toString();
function fixtureDocument(): Record<string, unknown> {
  const p = FIXTURE_PARAMS;
  const q = FIXTURE_PERMITS[0]!;
  const vrs = splitPermitSignature(q.signature)!;
  return {
    note: "Flat JIT extraData reference vector; regenerate with UPDATE_JIT_FIXTURE=1.",
    extraData: encodeJitExtraData("flat", p, FIXTURE_PERMITS),
    expected: {
      collateralAsset: p.collateralAsset, referenceAsset: p.referenceAsset, expiryTimestamp: str(p.expiryTimestamp), recipe: p.recipe, rateOverride: str(p.rateOverride),
      constraint: { rateMin: str(p.constraint.rateMin), rateMax: str(p.constraint.rateMax), rateChangePerDayMax: str(p.constraint.rateChangePerDayMax), rateChangeCapacityMax: str(p.constraint.rateChangeCapacityMax) },
      // The flat wire's own member name for the recipe bytes (the document is a wire fixture).
      additionalData: p.extraData, swapFeePercentage: str(p.swapFeePercentage), unwindSwapFeePercentage: str(p.unwindSwapFeePercentage), enableJitMint: p.enableJitMint,
      permitCount: str(FIXTURE_PERMITS.length),
      permit0: { token: q.token, value: str(q.value), deadline: str(q.deadline), v: str(vrs.v), r: vrs.r, s: vrs.s },
    },
  };
}
function fixtureDocumentNested(): Record<string, unknown> {
  const p = FIXTURE_PARAMS_NESTED;
  const q = FIXTURE_PERMITS_NESTED[0]!;
  return {
    note: "Nested JIT extraData reference vector with oracleSalt and bytes permit signatures; regenerate with UPDATE_JIT_FIXTURE=1.",
    extraData: encodeJitExtraData("nested", p, FIXTURE_PERMITS_NESTED),
    expected: {
      collateralAsset: p.collateralAsset, referenceAsset: p.referenceAsset, expiryTimestamp: str(p.expiryTimestamp), recipe: p.recipe, rateOverride: str(p.rateOverride),
      constraint: { rateMin: str(p.constraint.rateMin), rateMax: str(p.constraint.rateMax), rateChangePerDayMax: str(p.constraint.rateChangePerDayMax), rateChangeCapacityMax: str(p.constraint.rateChangeCapacityMax) },
      extraData: p.extraData, oracleSalt: p.oracleSalt, swapFeePercentage: str(p.swapFeePercentage), unwindSwapFeePercentage: str(p.unwindSwapFeePercentage), enableJitMint: p.enableJitMint,
      permitCount: str(FIXTURE_PERMITS_NESTED.length),
      permit0: { token: q.token, value: str(q.value), deadline: str(q.deadline), signature: q.signature },
    },
  };
}

describe("JIT extraData reference vectors", () => {
  it("the committed fixture equals a fresh encoding (UPDATE_JIT_FIXTURE=1 to regenerate deliberately)", () => {
    const fresh = fixtureDocument();
    const doc = `${JSON.stringify(fresh, null, 2)}\n`;
    if (process.env["UPDATE_JIT_FIXTURE"] === "1" || !existsSync(FIXTURE)) {
      writeFileSync(FIXTURE, doc);
    }
    const committed = JSON.parse(readFileSync(FIXTURE, "utf8")) as { extraData: string; expected: unknown };
    expect(committed.extraData, "flat extraData bytes drifted from the reference vector — regenerate deliberately").toBe(fresh.extraData);
    expect(committed.expected).toEqual(fresh.expected);
  });

  it("the NESTED fixture equals a fresh nested encoding (same UPDATE_JIT_FIXTURE=1 regeneration) and round-trips", () => {
    const fresh = fixtureDocumentNested();
    const doc = `${JSON.stringify(fresh, null, 2)}\n`;
    if (process.env["UPDATE_JIT_FIXTURE"] === "1" || !existsSync(FIXTURE_NESTED)) {
      writeFileSync(FIXTURE_NESTED, doc);
    }
    const committed = JSON.parse(readFileSync(FIXTURE_NESTED, "utf8")) as { extraData: `0x${string}`; expected: unknown };
    expect(committed.extraData, "nested extraData bytes drifted from the reference vector — regenerate deliberately").toBe(fresh.extraData);
    expect(committed.expected).toEqual(fresh.expected);
    const back = decodeJitExtraData("nested", committed.extraData);
    expect(diffJitExtraData({ params: FIXTURE_PARAMS_NESTED, permits: FIXTURE_PERMITS_NESTED }, back)).toEqual([]);
    expect(back.permits[0]!.signature).toBe(FIXTURE_PERMITS_NESTED[0]!.signature);
    expect(back.params.oracleSalt).toBe(FIXTURE_PARAMS_NESTED.oracleSalt);
    // The two wires' bytes differ (nesting + salt): a flat decode of nested bytes must not read
    // as the same params — it either throws or disagrees on a field.
    let flatReading: string[] | "threw";
    try {
      flatReading = diffJitExtraData({ params: FIXTURE_PARAMS_NESTED, permits: FIXTURE_PERMITS_NESTED }, decodeJitExtraData("flat", committed.extraData));
    } catch {
      flatReading = "threw";
    }
    expect(flatReading === "threw" || flatReading.length > 0).toBe(true);
  });

  it("the bytes round-trip through our own decoder with no differing field", () => {
    const bytes = encodeJitExtraData("flat", FIXTURE_PARAMS, FIXTURE_PERMITS);
    const back = decodeJitExtraData("flat", bytes);
    expect(diffJitExtraData({ params: FIXTURE_PARAMS, permits: FIXTURE_PERMITS }, back)).toEqual([]);
    expect(back.params.enableJitMint).toBe(true);
    expect(splitPermitSignature(back.permits[0]!.signature)!.v).toBe(28);
  });

  it("the nested wire carries the permit signature as BYTES; the flat wire refuses a non-ECDSA signature", () => {
    // A v/r/s-shaped nested layout (adapter 0.4.0) is a different byte string: the 0.5.0 row is
    // (token, value, deadline, bytes) — a dynamic tuple, so its encoding cannot equal a static
    // (token, value, deadline, uint8, bytes32, bytes32) row.
    const ecdsaNested = encodeJitExtraData("nested", FIXTURE_PARAMS_NESTED, FIXTURE_PERMITS);
    expect(decodeJitExtraData("nested", ecdsaNested).permits[0]!.signature).toBe(FIXTURE_PERMITS[0]!.signature);
    expect(() => encodeJitExtraData("flat", FIXTURE_PARAMS, FIXTURE_PERMITS_NESTED)).toThrow(/65-byte ECDSA/);
  });

  it("the flat wire refuses a non-zero oracleSalt — no field carries it, so it can never be dropped silently", () => {
    expect(() => encodeJitExtraData("flat", FIXTURE_PARAMS_NESTED, FIXTURE_PERMITS)).toThrow(/oracleSalt/);
  });

  it("diffJitExtraData names every field that disagrees, and only those", () => {
    const back = decodeJitExtraData("flat", encodeJitExtraData("flat", FIXTURE_PARAMS, FIXTURE_PERMITS));
    const swapped = { params: { ...back.params, collateralAsset: back.params.referenceAsset, referenceAsset: back.params.collateralAsset }, permits: back.permits };
    expect(diffJitExtraData({ params: FIXTURE_PARAMS, permits: FIXTURE_PERMITS }, swapped)).toEqual(["collateralAsset", "referenceAsset"]);
    const fees = { params: { ...back.params, swapFeePercentage: back.params.unwindSwapFeePercentage, unwindSwapFeePercentage: back.params.swapFeePercentage }, permits: back.permits };
    expect(diffJitExtraData({ params: FIXTURE_PARAMS, permits: FIXTURE_PERMITS }, fees)).toEqual(["swapFeePercentage", "unwindSwapFeePercentage"]);
    const cons = { params: { ...back.params, constraint: { ...back.params.constraint, rateMax: 5n } }, permits: back.permits };
    expect(diffJitExtraData({ params: FIXTURE_PARAMS, permits: FIXTURE_PERMITS }, cons)).toEqual(["constraint.rateMax"]);
    expect(diffJitExtraData({ params: FIXTURE_PARAMS, permits: FIXTURE_PERMITS }, { params: back.params, permits: [] })).toEqual(["permits.length"]);
    expect(diffJitExtraData({ params: FIXTURE_PARAMS, permits: FIXTURE_PERMITS }, { params: back.params, permits: [{ ...back.permits[0]!, signature: permitSignatureOfVrs(27, `0x${"11".repeat(32)}`, `0x${"22".repeat(32)}`) }] })).toEqual(["permits[0]"]);
    // Case-insensitive on addresses and hex: a checksummed echo is not a difference.
    const cased = { params: { ...back.params, collateralAsset: back.params.collateralAsset.toLowerCase() as `0x${string}` }, permits: back.permits };
    expect(diffJitExtraData({ params: FIXTURE_PARAMS, permits: FIXTURE_PERMITS }, cased)).toEqual([]);
  });
});
