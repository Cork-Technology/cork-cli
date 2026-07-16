import { describe, expect, it } from "vitest";
import {
  call,
  corkActionCall,
  decodeBundle,
  encodeCorkAction,
  encodeMulticall,
  MULTICALL_SELECTOR,
  type SafeDepositParams,
  type SafeSwapParams,
} from "@cork/core";

const POOL = "0xceebea356e5159c9cb06612c39ef2e6e0fe9cd3bb047541e26e0c0767bd1c16a" as const;
// Lowercased (addresses encode lowercased in calldata); viem rejects mixed-case non-EIP-55 input.
const RCV = "0xc0ffee0000000000000000000000000000000001" as const;
const ADP = "0xccccccccccccbad6f772a511b337d9ccc9570407" as const;

const swapParams: SafeSwapParams = {
  poolId: POOL,
  collateralAssetsOut: 100000000000000000000n,
  receiver: RCV,
  maxCstSharesIn: 101000000000000000000n,
  maxReferenceAssetsIn: 130000000000000000000n,
  deadline: 1893456000n,
};
const depositParams: SafeDepositParams = {
  poolId: POOL,
  collateralAssetsIn: 50000000n,
  receiver: RCV,
  minCptAndCstSharesOut: 49000000000000000000n,
  deadline: 1893456000n,
};

// Golden calldata produced independently with `cast calldata`.
const SWAP_CALLDATA =
  "0xd5f2e59eceebea356e5159c9cb06612c39ef2e6e0fe9cd3bb047541e26e0c0767bd1c16a0000000000000000000000000000000000000000000000056bc75e2d63100000000000000000000000000000c0ffee000000000000000000000000000000000100000000000000000000000000000000000000000000000579a814e10a7400000000000000000000000000000000000000000000000000070c1cc73b00c800000000000000000000000000000000000000000000000000000000000070dbd880";
const DEPOSIT_CALLDATA =
  "0x41881406ceebea356e5159c9cb06612c39ef2e6e0fe9cd3bb047541e26e0c0767bd1c16a0000000000000000000000000000000000000000000000000000000002faf080000000000000000000000000c0ffee0000000000000000000000000000000001000000000000000000000000000000000000000000000002a802f8630a2400000000000000000000000000000000000000000000000000000000000070dbd880";

describe("CorkAdapter action encoding (byte-parity with cast calldata)", () => {
  it("safeSwap encodes exactly", () => {
    expect(encodeCorkAction("safeSwap", swapParams)).toBe(SWAP_CALLDATA);
  });
  it("safeDeposit encodes exactly", () => {
    expect(encodeCorkAction("safeDeposit", depositParams)).toBe(DEPOSIT_CALLDATA);
  });
});

describe("Bundler3 multicall envelope (byte-parity with cast calldata)", () => {
  const bundle = [call(ADP, SWAP_CALLDATA), call(ADP, DEPOSIT_CALLDATA)];

  it("multicall selector matches deployed Bundler3 (0x374f435d)", () => {
    expect(MULTICALL_SELECTOR).toBe("0x374f435d");
  });

  it("encodeMulticall matches cast output", () => {
    const expected =
      "0x374f435d00000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000001e0000000000000000000000000ccccccccccccbad6f772a511b337d9ccc957040700000000000000000000000000000000000000000000000000000000000000a000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000c4d5f2e59eceebea356e5159c9cb06612c39ef2e6e0fe9cd3bb047541e26e0c0767bd1c16a0000000000000000000000000000000000000000000000056bc75e2d63100000000000000000000000000000c0ffee000000000000000000000000000000000100000000000000000000000000000000000000000000000579a814e10a7400000000000000000000000000000000000000000000000000070c1cc73b00c800000000000000000000000000000000000000000000000000000000000070dbd88000000000000000000000000000000000000000000000000000000000000000000000000000000000ccccccccccccbad6f772a511b337d9ccc957040700000000000000000000000000000000000000000000000000000000000000a000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000a441881406ceebea356e5159c9cb06612c39ef2e6e0fe9cd3bb047541e26e0c0767bd1c16a0000000000000000000000000000000000000000000000000000000002faf080000000000000000000000000c0ffee0000000000000000000000000000000001000000000000000000000000000000000000000000000002a802f8630a2400000000000000000000000000000000000000000000000000000000000070dbd88000000000000000000000000000000000000000000000000000000000";
    expect(encodeMulticall(bundle)).toBe(expected);
  });
});

describe("recursive decode round-trips", () => {
  it("decodes a flat cork bundle", () => {
    const data = encodeMulticall([
      corkActionCall(ADP, "safeSwap", swapParams),
      corkActionCall(ADP, "safeDeposit", depositParams),
    ]);
    const legs = decodeBundle(data);
    expect(legs.map((l) => l.kind)).toEqual(["cork", "cork"]);
    const first = legs[0];
    expect(first?.kind).toBe("cork");
    if (first?.kind === "cork") {
      expect(first.action).toBe("safeSwap");
      expect((first.params as SafeSwapParams).collateralAssetsOut).toBe(swapParams.collateralAssetsOut);
      expect((first.params as SafeSwapParams).poolId.toLowerCase()).toBe(POOL);
    }
  });

  it("decodes nested bundles (reenter-style) recursively", () => {
    const inner = encodeMulticall([corkActionCall(ADP, "safeDeposit", depositParams)]);
    const outer = encodeMulticall([call(ADP, SWAP_CALLDATA), call(ADP, inner)]);
    const legs = decodeBundle(outer);
    expect(legs[0]?.kind).toBe("cork");
    expect(legs[1]?.kind).toBe("bundle");
    if (legs[1]?.kind === "bundle") {
      expect(legs[1].legs[0]?.kind).toBe("cork");
      if (legs[1].legs[0]?.kind === "cork") expect(legs[1].legs[0].action).toBe("safeDeposit");
    }
  });

  it("surfaces unknown legs raw instead of dropping them", () => {
    const data = encodeMulticall([call(ADP, "0xdeadbeef")]);
    const legs = decodeBundle(data);
    expect(legs[0]?.kind).toBe("unknown");
    if (legs[0]?.kind === "unknown") expect(legs[0].selector).toBe("0xdeadbeef");
  });
});
