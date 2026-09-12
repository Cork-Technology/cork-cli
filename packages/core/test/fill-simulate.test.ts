// Probe-fill simulation — the classification is graded revert-by-revert. The load-bearing
// distinctions: the threshold-0 cap (an auction row must probe at its live price, not the signed
// floor), TransferFromTakerToMakerFailed vs TransferFromMakerToTakerFailed (the ONE selector of
// the pair that proves the maker's whole side, vs the maker-side failure it must never be
// confused with), transport failure as "unknown" (never a verdict), and the bounded cause-chain
// walk for viem's variably-nested revert data.
import { describe, expect, it } from "vitest";
import { encodeErrorResult, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { buildTakerFill, hashLopOrder, LOP_ADDRESSES, type LopOrder } from "../src/orders.ts";
import type { SignedLopOrder } from "../src/datasources/venue.ts";
import { probeAccountTypeOf, simulateTopFill } from "../src/handlers/fill-simulate.ts";

const LOP = LOP_ADDRESSES[1]!;
const ACCOUNT = "0x00000000000000000000000000000000000000aa" as const;
const CST = "0x00000000000000000000000000000000000000c5" as const;
const COLLATERAL = "0x9D39A5DE30e57443BfF2A8307A4256c8797A3497" as const;
const maker = privateKeyToAccount(`0x${"4b".repeat(32)}`);

const order: LopOrder = {
  salt: 11n,
  maker: maker.address,
  receiver: "0x0000000000000000000000000000000000000000",
  makerAsset: CST,
  takerAsset: COLLATERAL,
  makingAmount: 10n ** 18n,
  takingAmount: 5n * 10n ** 16n,
  makerTraits: 0n,
};

async function signedRow(over: Partial<SignedLopOrder> = {}): Promise<SignedLopOrder> {
  const signature = await maker.sign({ hash: hashLopOrder(1, LOP, order) });
  return { order, signature, extension: "0x", makerAccountType: "EOA", ...over } as SignedLopOrder;
}

type CallArgs = { to: string; data: `0x${string}`; account: string; blockNumber?: bigint };
type ProbeClient = Parameters<typeof simulateTopFill>[0];
function clientOf(impl: (args: CallArgs) => unknown) {
  const calls: CallArgs[] = [];
  return {
    calls,
    client: {
      call: async (args: CallArgs) => {
        calls.push(args);
        return impl(args);
      },
    } as unknown as ProbeClient,
  };
}

const revertWith = (data: `0x${string}`, depth = 1): Error => {
  // viem nests the raw revert data at varying depths down the cause chain; model that.
  let inner: object = { data };
  for (let i = 1; i < depth; i += 1) inner = { cause: inner };
  return Object.assign(new Error("execution reverted"), depth === 0 ? { data } : { cause: inner });
};

const errData = (name: string) =>
  encodeErrorResult({ abi: parseAbi([`error ${name}()`]), errorName: name });

describe("simulateTopFill — verdicts", () => {
  it("success is 'fillable', probed at the LOP from the fill sender", async () => {
    const { client, calls } = clientOf(() => ({ data: "0x" }));
    const sim = await simulateTopFill(client, { signed: await signedRow(), lop: LOP, account: ACCOUNT });
    expect(sim?.verdict).toBe("fillable");
    expect(sim?.revert).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ to: LOP, account: ACCOUNT });
    expect(calls[0]!.blockNumber).toBeUndefined();
  });

  it("the probe carries takerTraits threshold 0 — the LOP skips the cap check, so an auction row probes at its LIVE price", async () => {
    const { client, calls } = clientOf(() => ({ data: "0x" }));
    const signed = await signedRow();
    await simulateTopFill(client, { signed, lop: LOP, account: ACCOUNT });
    const uncapped = buildTakerFill({ order, signature: signed.signature, makerAccountType: "EOA", taker: ACCOUNT, extension: "0x", maximumTakingAmount: 0n }).calldata;
    const defaultCap = buildTakerFill({ order, signature: signed.signature, makerAccountType: "EOA", taker: ACCOUNT, extension: "0x" }).calldata;
    expect(calls[0]!.data).toBe(uncapped);
    expect(calls[0]!.data).not.toBe(defaultCap);
  });

  it("TransferFromTakerToMakerFailed is 'maker-ready' — the fill got past the maker's ENTIRE side", async () => {
    const { client } = clientOf(() => {
      throw revertWith(errData("TransferFromTakerToMakerFailed"));
    });
    const sim = await simulateTopFill(client, { signed: await signedRow(), lop: LOP, account: ACCOUNT });
    expect(sim?.verdict).toBe("maker-ready");
    expect(sim?.revert).toEqual({ name: "TransferFromTakerToMakerFailed", selector: errData("TransferFromTakerToMakerFailed").slice(0, 10) });
    expect(sim?.note).toContain("taker-asset allowance");
  });

  it("TransferFromMakerToTakerFailed — the MAKER-side twin — is 'would-revert', never maker-ready", async () => {
    const { client } = clientOf(() => {
      throw revertWith(errData("TransferFromMakerToTakerFailed"));
    });
    const sim = await simulateTopFill(client, { signed: await signedRow(), lop: LOP, account: ACCOUNT });
    expect(sim?.verdict).toBe("would-revert");
    expect(sim?.revert?.name).toBe("TransferFromMakerToTakerFailed");
  });

  it("a named LOP revert is 'would-revert' with the name; an unknown selector reports the raw selector with name null", async () => {
    const { client: known } = clientOf(() => {
      throw revertWith(errData("InvalidatedOrder"));
    });
    const simKnown = await simulateTopFill(known, { signed: await signedRow(), lop: LOP, account: ACCOUNT });
    expect(simKnown?.verdict).toBe("would-revert");
    expect(simKnown?.revert?.name).toBe("InvalidatedOrder");

    const { client: unknown } = clientOf(() => {
      throw revertWith("0xdeadbeef00");
    });
    const simUnknown = await simulateTopFill(unknown, { signed: await signedRow(), lop: LOP, account: ACCOUNT });
    expect(simUnknown?.verdict).toBe("would-revert");
    expect(simUnknown?.revert).toEqual({ name: null, selector: "0xdeadbeef" });
    expect(simUnknown?.note).toContain("outside the known LOP/Cork error set");
  });

  it("a transport failure is 'unknown' — never a verdict about the order", async () => {
    const { client } = clientOf(() => {
      throw Object.assign(new Error("fetch failed"), { name: "HttpRequestError" });
    });
    const sim = await simulateTopFill(client, { signed: await signedRow(), lop: LOP, account: ACCOUNT });
    expect(sim?.verdict).toBe("unknown");
    expect(sim?.revert).toBeUndefined();
  });

  it("a revert with NO surfaced data is 'would-revert' with both revert fields null", async () => {
    const { client } = clientOf(() => {
      throw new Error("execution reverted");
    });
    const sim = await simulateTopFill(client, { signed: await signedRow(), lop: LOP, account: ACCOUNT });
    expect(sim?.verdict).toBe("would-revert");
    expect(sim?.revert).toEqual({ name: null, selector: null });
  });
});

describe("simulateTopFill — the revert-data walk and edge mechanics", () => {
  it("finds the data nested several causes deep, and gives up past the depth bound", async () => {
    const { client: nested } = clientOf(() => {
      throw revertWith(errData("PrivateOrder"), 4);
    });
    const simNested = await simulateTopFill(nested, { signed: await signedRow(), lop: LOP, account: ACCOUNT });
    expect(simNested?.revert?.name).toBe("PrivateOrder");

    const { client: tooDeep } = clientOf(() => {
      throw revertWith(errData("PrivateOrder"), 12);
    });
    const simDeep = await simulateTopFill(tooDeep, { signed: await signedRow(), lop: LOP, account: ACCOUNT });
    expect(simDeep?.revert).toEqual({ name: null, selector: null });
  });

  it("a bare selector shorter than 4 bytes is not revert data", async () => {
    const { client } = clientOf(() => {
      throw revertWith("0xdead" as `0x${string}`);
    });
    const sim = await simulateTopFill(client, { signed: await signedRow(), lop: LOP, account: ACCOUNT });
    expect(sim?.revert).toEqual({ name: null, selector: null });
  });

  it("terms the fill builder cannot encode yield NULL — no probe, no invented verdict", async () => {
    // Empirically: buildTakerFill throws "compactSignature of length 64 expected, got 2".
    const { client, calls } = clientOf(() => ({ data: "0x" }));
    const sim = await simulateTopFill(client, { signed: await signedRow({ signature: "0x1234" as `0x${string}` }), lop: LOP, account: ACCOUNT });
    expect(sim).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("a client whose call throws SYNCHRONOUSLY is still classified, not escaped", async () => {
    const client = {
      call: ((): never => {
        throw revertWith(errData("OrderExpired"));
      }) as never,
    };
    const sim = await simulateTopFill(client, { signed: await signedRow(), lop: LOP, account: ACCOUNT });
    expect(sim?.verdict).toBe("would-revert");
    expect(sim?.revert?.name).toBe("OrderExpired");
  });

  it("atBlock pins the probe's block", async () => {
    const { client, calls } = clientOf(() => ({ data: "0x" }));
    await simulateTopFill(client, { signed: await signedRow(), lop: LOP, account: ACCOUNT, atBlock: 123n });
    expect(calls[0]!.blockNumber).toBe(123n);
  });
});

describe("probeAccountTypeOf — only a SETTLED signature may be probed", () => {
  it("maps the two settled labels and refuses everything else", () => {
    expect(probeAccountTypeOf("eoa-verified")).toBe("EOA");
    expect(probeAccountTypeOf("erc1271-verified")).toBe("ERC1271");
    expect(probeAccountTypeOf("unverified")).toBeNull();
    expect(probeAccountTypeOf(undefined)).toBeNull();
    expect(probeAccountTypeOf(42)).toBeNull();
  });
});
