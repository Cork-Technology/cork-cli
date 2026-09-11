// A venue row is DISCOVERY, not authority (audit DB-004, 2026-09-11): the maker signature and
// the extension rule are checked on every path that acts on a signed order — the ranked book
// (and so `firm`, watch announcements, ranking), the venue taker-fill branch, and refresh-order —
// with the same functions the venue-free inline fill already ran. Real keys, real signatures,
// a stubbed venue that serves whatever row we hand it, a stubbed chain that answers eth_getCode
// and isValidSignature per fixture. Nothing here mocks the verdict: a forged row is a row
// whose signature a different key made.
import { describe, expect, it } from "vitest";
import { keccak256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { buildMakerOrder, decodeMakerTraits, LOP_ADDRESSES, type LopOrder } from "../src/orders.ts";
import { runTool } from "../src/handlers.ts";
import { ERC1271_MAGIC } from "../src/orders.ts";
import { extensionVerdict } from "../src/handlers/order-auth.ts";
import { stubResolved, stubRpc } from "./helpers.ts";

const LOP = LOP_ADDRESSES[1]!;
const NOW = 1_800_000_000n;
const maker = privateKeyToAccount(`0x${"2a".repeat(32)}`);
const forger = privateKeyToAccount(`0x${"2b".repeat(32)}`);
const safe = "0x00000000000000000000000000000000000005af" as const; // a contract maker
const ME = "0xc0ffee0000000000000000000000000000000001" as const;
const CST = "0x16Aa2EbE1E2D6C856c634DaFc256257d2fEc0C69";
const SUSDE = "0x9D39A5DE30e57443BfF2A8307A4256c8797A3497";
const HAS_EXTENSION = 1n << 249n;
const CODE = "0x6080604052"; // any non-empty bytecode

const wire = (o: LopOrder) => ({ salt: o.salt.toString(), maker: o.maker, receiver: o.receiver, makerAsset: o.makerAsset, takerAsset: o.takerAsset, makingAmount: o.makingAmount.toString(), takingAmount: o.takingAmount.toString(), makerTraits: o.makerTraits.toString() });

/** A venue book row: a real order by `makerAddr`, signed by `signer` (the forger, when they differ). */
async function rowBy(id: string, signer: typeof maker, makerAddr: `0x${string}` = signer.address, over: { extension?: `0x${string}`; taking?: bigint } = {}) {
  const built = buildMakerOrder({ chainId: 1, lop: LOP, maker: makerAddr, makerAsset: CST, takerAsset: SUSDE, makingAmount: 10n ** 18n, takingAmount: over.taking ?? 5n * 10n ** 16n, clientRequestId: id, expiry: NOW + 3600n });
  return {
    orderHash: built.orderHash,
    order: wire(built.order),
    signature: await signer.sign({ hash: built.orderHash }),
    extension: over.extension ?? built.extension,
    makerAccountType: makerAddr === signer.address ? "EOA" : "ERC1271",
    side: "SELL",
    status: "OPEN",
  };
}

const venueWith = (rows: unknown[]) => async (url: string) =>
  url.includes("/limit-orders/v1/orderbook") ? new Response(JSON.stringify({ items: rows, hasMore: false }), { status: 200 }) : new Response(JSON.stringify({ items: [] }), { status: 200 });

/** Chain: every bit slot untouched (live); `code` decides who is a contract; `isValidSignature`
 *  answers (or throws) for contract makers; bitInvalidator reads can be made to throw too. */
const chain = (o: { code?: Record<string, string>; isValidSignature?: string | Error; invalidator?: bigint | Error } = {}) =>
  stubRpc(
    (c) => {
      if (c.functionName === "bitInvalidatorForOrder") {
        if (o.invalidator instanceof Error) throw o.invalidator;
        return o.invalidator ?? 0n;
      }
      if (c.functionName === "isValidSignature") {
        if (o.isValidSignature instanceof Error) throw o.isValidSignature;
        return o.isValidSignature ?? ERC1271_MAGIC;
      }
      throw new Error(`no stub for ${c.functionName}`);
    },
    { code: o.code },
  );
const transport = () => Object.assign(new Error("fetch failed"), { name: "HttpRequestError" });

const book = (rows: unknown[], ctx: Record<string, unknown>, input: Record<string, unknown> = {}) =>
  runTool("cork_query", { resource: "orderbook", chainId: 1, pageSize: 100, filters: { account: ME }, ...input }, { nowSeconds: NOW, venueFetch: venueWith(rows), ...ctx });
type Book = { count: number; items: Array<Record<string, unknown>>; excluded: Array<Record<string, unknown>>; verification: { confirmed: number; unverified: number; dropped: number }; changes?: { appeared: string[]; unconfirmed: string[] }; watermark: string };
const data = (env: { data: unknown }) => env.data as Book;

describe("extensionVerdict — OrderLib.isValidExtension, branch for branch", () => {
  const base: LopOrder = { salt: 0n, maker: maker.address, receiver: "0x0000000000000000000000000000000000000000", makerAsset: CST, takerAsset: SUSDE, makingAmount: 1n, takingAmount: 1n, makerTraits: 0n };
  const ext = "0x00000001" as const;
  const extLow = BigInt(keccak256(ext)) & ((1n << 160n) - 1n);
  it("no flag + no bytes = valid; no flag + bytes = UnexpectedOrderExtension (even when the salt commits to them)", () => {
    expect(extensionVerdict(base, "0x")).toEqual({ valid: true });
    expect(extensionVerdict({ ...base, salt: extLow }, ext)).toMatchObject({ valid: false, reason: "UnexpectedOrderExtension" });
  });
  it("flag + no bytes = MissingOrderExtension; flag + unbound bytes = InvalidExtensionHash; flag + bound bytes = valid", () => {
    const flagged = { ...base, makerTraits: HAS_EXTENSION };
    expect(extensionVerdict(flagged, "0x")).toMatchObject({ valid: false, reason: "MissingOrderExtension" });
    expect(extensionVerdict({ ...flagged, salt: extLow + 1n }, ext)).toMatchObject({ valid: false, reason: "InvalidExtensionHash" });
    expect(extensionVerdict({ ...flagged, salt: extLow }, ext)).toEqual({ valid: true });
  });
});

describe("the ranked book authenticates every row it serves", () => {
  it("a forged EOA row: served `unverified` without an RPC (nobody could ask the maker), DROPPED with an RPC that says the maker has no code", async () => {
    const honest = await rowBy("auth-1", maker);
    const forged = await rowBy("auth-2", forger, maker.address, { taking: 4n * 10n ** 16n }); // cheaper — would rank first
    const offline = await book([honest, forged], { resolveRpc: async () => null });
    expect(offline.state).toBe("ok");
    expect(data(offline).count).toBe(2);
    const byHash = Object.fromEntries(data(offline).items.map((r) => [String(r.orderHash).toLowerCase(), r]));
    expect(byHash[honest.orderHash.toLowerCase()]).toMatchObject({ makerSignature: "eoa-verified", verification: "unverified" });
    expect(byHash[forged.orderHash.toLowerCase()]).toMatchObject({ makerSignature: "unverified", verification: "unverified" });

    const online = await book([honest, forged], { resolveRpc: chain() });
    expect(online.state).toBe("ok");
    expect(data(online).count).toBe(1);
    expect(data(online).items[0]).toMatchObject({ orderHash: honest.orderHash, makerSignature: "eoa-verified", verification: "confirmed" });
    expect(data(online).verification).toMatchObject({ confirmed: 1, dropped: 1 });
    expect(online.warnings.some((w) => w.code === "status_mismatch" && w.message.includes("maker signature refuted"))).toBe(true);
  });

  it("a CONTRACT maker's row: confirmed only when its isValidSignature answers the magic value; a rejection DROPS; a transport failure leaves it unverified", async () => {
    const row = await rowBy("auth-3", forger, safe); // the Safe's signer key is not the Safe's address
    const ok = await book([row], { resolveRpc: chain({ code: { [safe]: CODE } }) });
    expect(data(ok).items[0]).toMatchObject({ makerSignature: "erc1271-verified", verification: "confirmed" });

    const rejected = await book([row], { resolveRpc: chain({ code: { [safe]: CODE }, isValidSignature: "0xffffffff" }) });
    expect(data(rejected).count).toBe(0);
    expect(data(rejected).verification.dropped).toBe(1);
    expect(rejected.warnings.some((w) => w.code === "status_mismatch" && w.message.includes("isValidSignature rejected"))).toBe(true);

    const flaky = await book([row], { resolveRpc: chain({ code: { [safe]: CODE }, isValidSignature: transport() }) });
    expect(data(flaky).count).toBe(1);
    expect(data(flaky).items[0]).toMatchObject({ makerSignature: "unverified", verification: "unverified" });
    expect(data(flaky).verification).toMatchObject({ confirmed: 0, unverified: 1, dropped: 0 });
  });

  it("a live bit is NOT enough: a row whose signature nobody could verify is never `confirmed`, so it is never announced as appeared", async () => {
    const honest = await rowBy("auth-4", maker);
    const first = await book([honest], { resolveRpc: chain() });
    const forged = await rowBy("auth-5", forger, safe, { taking: 3n * 10n ** 16n });
    // The Safe's code read fails: the maker MAY be a contract, nobody can say — indeterminate.
    const codeRead = chain({ code: { [safe]: CODE }, isValidSignature: transport() });
    const second = await book([honest, forged], { resolveRpc: codeRead }, { since: data(first).watermark });
    expect(second.state).toBe("ok");
    expect(data(second).changes!.appeared).toEqual([]);
    expect(data(second).changes!.unconfirmed).toEqual([forged.orderHash.toLowerCase()]);
  });

  it("a forged-looking row whose maker's code read fails in transport is KEPT unverified — an RPC outage refutes nothing", async () => {
    const row = await rowBy("auth-8", forger, safe);
    const codeFails = async () => stubResolved({ readContract: async () => 0n, getCode: async () => { throw transport(); } });
    const env = await book([row], { resolveRpc: codeFails });
    expect(env.state).toBe("ok");
    expect(data(env).count).toBe(1);
    expect(data(env).items[0]).toMatchObject({ makerSignature: "unverified", verification: "unverified" });
    expect(data(env).verification.dropped).toBe(0);
  });

  it("extension bytes the salt/traits do not commit to DROP the row chain-free (signature_or_reconstruction_mismatch)", async () => {
    const honest = await rowBy("auth-6", maker);
    const unbound = { ...(await rowBy("auth-7", maker)), extension: "0xdeadbeef" as const }; // signed WITHOUT the flag: UnexpectedOrderExtension
    for (const resolveRpc of [async () => null, chain()]) {
      const env = await book([honest, unbound], { resolveRpc });
      expect(env.state).toBe("ok");
      expect(data(env).count).toBe(1);
      expect(data(env).verification.dropped).toBe(1);
      expect(env.warnings.some((w) => w.code === "signature_or_reconstruction_mismatch" && w.message.includes("isValidExtension"))).toBe(true);
    }
  });
});

describe("taker-fill from the venue book authenticates the row like bytes in hand", () => {
  const fill = (orderHash: `0x${string}`, rows: unknown[], ctx: Record<string, unknown>) =>
    runTool("cork_prepare_orders", { chainId: 1, account: ME, clientRequestId: "venue-fill-0001", action: { type: "taker-fill", orderHash } }, { nowSeconds: NOW, venueFetch: venueWith(rows), ...ctx });

  it("a forged signature yields NO fill bytes (conflict, recoveredSigner disclosed, acquisition named)", async () => {
    const forged = await rowBy("vf-1", forger, maker.address);
    const env = await fill(forged.orderHash, [forged], { resolveRpc: chain() });
    expect(env.state).toBe("conflict");
    expect(env.warnings[0]!.code).toBe("signature_or_reconstruction_mismatch");
    expect(env.warnings[0]!.message).toContain("no fill bytes were built");
    expect(env.data).toMatchObject({ acquisition: "venue", requestedOrderHash: forged.orderHash, recoveredSigner: forger.address });
    expect((env.data as { calldata?: string }).calldata).toBeUndefined();
  });

  it("the venue's makerAccountType claim is replaced by the verdict: an EOA-claimed row by a contract maker fills as an ERC-1271 order", async () => {
    const row = { ...(await rowBy("vf-2", forger, safe)), makerAccountType: "EOA" };
    const env = await fill(row.orderHash, [row], { resolveRpc: chain({ code: { [safe]: CODE } }) });
    expect(env.state, JSON.stringify(env.warnings)).toBe("ok");
    expect(env.data).toMatchObject({ makerAccountType: "ERC1271", fillFunction: "fillContractOrder" });
    const rejected = await fill(row.orderHash, [row], { resolveRpc: chain({ code: { [safe]: CODE }, isValidSignature: "0x00000000" }) });
    expect(rejected.state).toBe("conflict");
    expect(rejected.warnings[0]!.message).toContain("ERC-1271");
  });

  it("an indeterminate read is unavailable, not a verdict: the ERC-1271 call or the maker's code read failing in transport", async () => {
    const row = await rowBy("vf-3", forger, safe);
    const call = await fill(row.orderHash, [row], { resolveRpc: chain({ code: { [safe]: CODE }, isValidSignature: transport() }) });
    expect(call.state).toBe("unavailable");
    expect(call.warnings[0]!.code).toBe("chain_read_failed");
    // getCode itself failing: the stub throws for unknown code fixtures only on implementation
    // roles, so drive it through a client whose getCode rejects.
    const codeFails = async () => stubResolved({ readContract: async () => 0n, getCode: async () => { throw transport(); } });
    const probe = await fill(row.orderHash, [row], { resolveRpc: codeFails });
    expect(probe.state).toBe("unavailable");
    expect(probe.warnings[0]!.code).toBe("chain_read_failed");
    expect(probe.warnings[0]!.message).toContain("code could not be read");
  });

  it("extension bytes beside the row that its traits do not expect yield no fill bytes", async () => {
    const row = { ...(await rowBy("vf-4", maker)), extension: "0xdeadbeef" as const };
    const env = await fill(row.orderHash, [row], { resolveRpc: chain() });
    expect(env.state).toBe("conflict");
    expect(env.data).toMatchObject({ extensionFault: "UnexpectedOrderExtension" });
  });
});

describe("refresh-order authenticates the predecessor before asking for a new signature", () => {
  const refresh = (orderHash: `0x${string}`, rows: unknown[], ctx: Record<string, unknown>, account: `0x${string}` = maker.address) =>
    runTool("cork_prepare_orders", { chainId: 1, account, clientRequestId: "refresh-auth-0001", action: { type: "refresh-order", orderHash } }, { nowSeconds: NOW, venueFetch: venueWith(rows), ...ctx });

  it("a row the account never signed is not refreshed (conflict), with or without an RPC", async () => {
    const forged = await rowBy("rf-1", forger, maker.address);
    for (const resolveRpc of [async () => null, chain()]) {
      const env = await refresh(forged.orderHash, [forged], { resolveRpc });
      expect(env.state).toBe("conflict");
      expect(env.warnings[0]!.code).toBe("signature_or_reconstruction_mismatch");
      expect(env.warnings[0]!.message).toContain("the order was not refreshed");
      expect((env.data as { typedData?: unknown }).typedData).toBeUndefined();
    }
  });

  it("a contract maker refreshes only when its ERC-1271 answer validates the predecessor; the extension it carries must be the one the salt commits to", async () => {
    const row = await rowBy("rf-2", forger, safe);
    const ok = await refresh(row.orderHash, [row], { resolveRpc: chain({ code: { [safe]: CODE } }) }, safe);
    expect(ok.state, JSON.stringify(ok.warnings)).toBe("ok");
    expect(decodeMakerTraits(BigInt((ok.data as { typedData: { message: { makerTraits: string } } }).typedData.message.makerTraits)).nonce).toBe(decodeMakerTraits(BigInt(row.order.makerTraits)).nonce);
    const rejected = await refresh(row.orderHash, [row], { resolveRpc: chain({ code: { [safe]: CODE }, isValidSignature: "0x00000000" }) }, safe);
    expect(rejected.state).toBe("conflict");
    const unbound = { ...(await rowBy("rf-3", maker)), extension: "0xdeadbeef" as const };
    const ext = await refresh(unbound.orderHash, [unbound], { resolveRpc: chain() });
    expect(ext.state).toBe("conflict");
    expect(ext.data).toMatchObject({ extensionFault: "UnexpectedOrderExtension" });
  });
});
