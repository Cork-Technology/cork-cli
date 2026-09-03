// The bytes cork-cli encodes for the JIT adapter, frozen as a fixture the fork harness decodes
// with a Solidity reference of the helper (experiments/fork-harness/test/JitExtraDataDecoder.t.sol).
// This test is the drift gate on that fixture: the committed bytes must equal a fresh encoding of
// the same params (regenerate deliberately with UPDATE_JIT_FIXTURE=1), and they must round-trip
// through our own decoder — so the TS encoder, the TS decoder, and the EVM decoder are held to
// one layout from two sides.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { decodeJitExtraData, diffJitExtraData, encodeJitExtraData, type JITMarketParams, type PermitParams } from "@cork/core";

const FIXTURE = resolve(import.meta.dirname, "../../../experiments/fork-harness/test/fixtures/jit-extra-data.json");

/** Fixed, non-degenerate params: every field non-zero and distinct, so a swapped or dropped
 *  field cannot hide behind an equal neighbour. */
export const FIXTURE_PARAMS: JITMarketParams = {
  collateralAsset: "0x211Cc4DD073734dA055fbF44a2b4667d5E5fE5d2",
  referenceAsset: "0xdDb46999F8891663a8F2828d25298f70416d7610",
  expiryTimestamp: 1_900_000_000n,
  recipe: "0xb881DB48ad6DA84a8F0D1cE4150Caf7Ae016Dc55",
  rateOverride: 7n,
  constraint: { rateMin: 1n, rateMax: 1_600_000_000_000_000_000n, rateChangePerDayMax: 800_000_000_000_000_000n, rateChangeCapacityMax: 2_400_000_000_000_000_000n },
  additionalData: "0x000000000000000000000000000000000000000000000000000000000000002a",
  swapFeePercentage: 3_000_000_000_000_000_000n,
  unwindSwapFeePercentage: 1_500_000_000_000_000_000n,
  enableJitMint: true,
};
export const FIXTURE_PERMITS: PermitParams[] = [
  { token: "0x16Aa2EbE1E2D6C856c634DaFc256257d2fEc0C69", value: 1_000_000_000_000_000_000n, deadline: 1_800_003_600n, v: 28, r: `0x${"11".repeat(32)}`, s: `0x${"22".repeat(32)}` },
];

const str = (v: bigint | number) => v.toString();
function fixtureDocument(): Record<string, unknown> {
  const p = FIXTURE_PARAMS;
  const q = FIXTURE_PERMITS[0]!;
  return {
    note: "written by packages/core/test/jit-extra-data-fixture.test.ts (UPDATE_JIT_FIXTURE=1); decoded by test/JitExtraDataDecoder.t.sol",
    extraData: encodeJitExtraData(p, FIXTURE_PERMITS),
    expected: {
      collateralAsset: p.collateralAsset, referenceAsset: p.referenceAsset, expiryTimestamp: str(p.expiryTimestamp), recipe: p.recipe, rateOverride: str(p.rateOverride),
      constraint: { rateMin: str(p.constraint.rateMin), rateMax: str(p.constraint.rateMax), rateChangePerDayMax: str(p.constraint.rateChangePerDayMax), rateChangeCapacityMax: str(p.constraint.rateChangeCapacityMax) },
      additionalData: p.additionalData, swapFeePercentage: str(p.swapFeePercentage), unwindSwapFeePercentage: str(p.unwindSwapFeePercentage), enableJitMint: p.enableJitMint,
      permitCount: str(FIXTURE_PERMITS.length),
      permit0: { token: q.token, value: str(q.value), deadline: str(q.deadline), v: str(q.v), r: q.r, s: q.s },
    },
  };
}

describe("JIT extraData fixture — one layout, held from the TS and the EVM side", () => {
  it("the committed fixture equals a fresh encoding (UPDATE_JIT_FIXTURE=1 to regenerate deliberately)", () => {
    const fresh = fixtureDocument();
    if (process.env["UPDATE_JIT_FIXTURE"] === "1" || !existsSync(FIXTURE)) {
      writeFileSync(FIXTURE, `${JSON.stringify(fresh, null, 2)}\n`);
    }
    const committed = JSON.parse(readFileSync(FIXTURE, "utf8")) as { extraData: string; expected: unknown };
    expect(committed.extraData, "extraData bytes drifted from the encoder — a layout change; regenerate on purpose and re-run the forge decoder test").toBe(fresh.extraData);
    expect(committed.expected).toEqual(fresh.expected);
  });

  it("the bytes round-trip through our own decoder with no differing field", () => {
    const bytes = encodeJitExtraData(FIXTURE_PARAMS, FIXTURE_PERMITS);
    const back = decodeJitExtraData(bytes);
    expect(diffJitExtraData({ params: FIXTURE_PARAMS, permits: FIXTURE_PERMITS }, back)).toEqual([]);
    expect(back.params.enableJitMint).toBe(true);
    expect(back.permits[0]!.v).toBe(28);
  });

  it("diffJitExtraData names every field that disagrees, and only those", () => {
    const back = decodeJitExtraData(encodeJitExtraData(FIXTURE_PARAMS, FIXTURE_PERMITS));
    const swapped = { params: { ...back.params, collateralAsset: back.params.referenceAsset, referenceAsset: back.params.collateralAsset }, permits: back.permits };
    expect(diffJitExtraData({ params: FIXTURE_PARAMS, permits: FIXTURE_PERMITS }, swapped)).toEqual(["collateralAsset", "referenceAsset"]);
    const fees = { params: { ...back.params, swapFeePercentage: back.params.unwindSwapFeePercentage, unwindSwapFeePercentage: back.params.swapFeePercentage }, permits: back.permits };
    expect(diffJitExtraData({ params: FIXTURE_PARAMS, permits: FIXTURE_PERMITS }, fees)).toEqual(["swapFeePercentage", "unwindSwapFeePercentage"]);
    const cons = { params: { ...back.params, constraint: { ...back.params.constraint, rateMax: 5n } }, permits: back.permits };
    expect(diffJitExtraData({ params: FIXTURE_PARAMS, permits: FIXTURE_PERMITS }, cons)).toEqual(["constraint.rateMax"]);
    expect(diffJitExtraData({ params: FIXTURE_PARAMS, permits: FIXTURE_PERMITS }, { params: back.params, permits: [] })).toEqual(["permits.length"]);
    expect(diffJitExtraData({ params: FIXTURE_PARAMS, permits: FIXTURE_PERMITS }, { params: back.params, permits: [{ ...back.permits[0]!, v: 27 }] })).toEqual(["permits[0]"]);
    // Case-insensitive on addresses and hex: a checksummed echo is not a difference.
    const cased = { params: { ...back.params, collateralAsset: back.params.collateralAsset.toLowerCase() as `0x${string}` }, permits: back.permits };
    expect(diffJitExtraData({ params: FIXTURE_PARAMS, permits: FIXTURE_PERMITS }, cased)).toEqual([]);
  });
});
