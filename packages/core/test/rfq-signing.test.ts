// RFQ v2 write signing, held byte for byte to the venue's published vectors (cork-api 0.4.5
// worked example). A drift here means every signed RFQ write is refused with 401.
// Also pins the rollover JIT-market commitment the venue serves as `jit_market_hash`.
import { describe, expect, it } from "vitest";
import { concat, encodeAbiParameters, hashTypedData, keccak256, recoverTypedDataAddress, sha256, stringToBytes, toHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { canonicalJson, rfqWriteBodyHash, rfqWriteTypedData } from "../src/rfq-signing.ts"
import { hashJitMarketParams, JIT_MARKET_PARAMS_TYPEHASHES } from "../src/rollover.ts";
import { planRfqWrite } from "../src/rfq-bodies.ts";

// Anvil / Hardhat default account #0 — a PUBLIC test key that guards nothing.
const ANVIL_0_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const ANVIL_0_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const USDC_BASE = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

describe("fixed new_position open vector (the venue's published worked example)", () => {
  const body = {
    schema_version: "2",
    kind: "new_position",
    request_id: "example-0001",
    requester: ANVIL_0_ADDRESS.toLowerCase(),
    chain_id: 8453,
    reference_asset: USDC_BASE,
    collateral_asset: { exact: USDC_BASE },
    modes: ["liquidity_only"],
    package_ids: ["pkg-1"],
    expiry_window: { not_before: 1900000000, not_after: 1900086400 },
    notional_assets: "1000000",
    valid_until: 1899999000,
  };
  const CANONICAL =
    '{"chain_id":8453,"collateral_asset":{"exact":"0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"},"expiry_window":{"not_after":1900086400,"not_before":1900000000},"kind":"new_position","modes":["liquidity_only"],"notional_assets":"1000000","package_ids":["pkg-1"],"reference_asset":"0x833589fcd6edb6e08f4c7c32d4f71b54bda02913","request_id":"example-0001","requester":"0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266","schema_version":"2","valid_until":1899999000}';
  const BODY_HASH = "0x06155b57c9ad9103c427d6b25658525a7abeaf26336a1b520e9a5edd9b8a224b";
  const TYPE_HASH = "0xd8b7c220c1ff13056a1b853da79c936b9ebc11deb6e98c68bcfa4c149c30d43b";
  const DOMAIN_SEPARATOR = "0xb43b3ad5d3032f6db13d856e5fad4536f80e56b3cd87e7b867876de97643c43e";
  const DIGEST = "0xc788385f808abbde6b3957f9da46dfdaf097bdc97c869b9194828027123080ba";
  const SIGNATURE =
    "0xd5d87bb2fcb7aa4c49824e08eaa199c5474ebec3bc79935517f7d1ff477fe17a19dbf61d713acd66b4e68d173ce05c7af386f65b99f78d722e30130ea2ec64881c";

  const typed = () => rfqWriteTypedData({ venueOrigin: 'https://venue', operation: "open", ref: body.request_id, chainId: body.chain_id, bodyHash: rfqWriteBodyHash("open", body) });

  it("canonical JSON and bodyHash", () => {
    expect(canonicalJson(body)).toBe(CANONICAL);
    expect(rfqWriteBodyHash("open", body)).toBe(BODY_HASH);
  });

  it("type hash, domain separator and digest, rebuilt word by word", () => {
    expect(keccak256(toHex("CorkRfqWrite(string operation,string ref,bytes32 bodyHash)"))).toBe(TYPE_HASH);
    const words = (values: readonly (Hex | bigint)[]) =>
      encodeAbiParameters(values.map((v) => ({ type: typeof v === "bigint" ? "uint256" : "bytes32" })), values);
    const domainTypeHash = keccak256(toHex("EIP712Domain(string name,string version,uint256 chainId,bytes32 salt)"));
    expect(keccak256(words([domainTypeHash, keccak256(toHex("Cork RFQ")), keccak256(toHex("1")), 8453n, keccak256(toHex("https://venue"))]))).toBe(DOMAIN_SEPARATOR);
    const structHash = keccak256(words([TYPE_HASH, keccak256(toHex("open")), keccak256(toHex("example-0001")), BODY_HASH]));
    expect(keccak256(concat(["0x1901", DOMAIN_SEPARATOR, structHash]))).toBe(DIGEST);
    expect(hashTypedData(typed())).toBe(DIGEST);
  });

  it("signature by Anvil account #0, and it recovers", async () => {
    expect(await privateKeyToAccount(ANVIL_0_KEY).signTypedData(typed())).toBe(SIGNATURE);
    expect(await recoverTypedDataAddress({ ...typed(), signature: SIGNATURE })).toBe(ANVIL_0_ADDRESS);
  });


  it("ignores the signature and key order; signs kind", () => {
    expect(rfqWriteBodyHash("open", { ...body, signature: "0x1234" })).toBe(BODY_HASH);
    expect(rfqWriteBodyHash("open", Object.fromEntries(Object.entries(body).reverse()))).toBe(BODY_HASH);
    expect(rfqWriteBodyHash("open", { ...body, kind: "rollover" })).not.toBe(BODY_HASH);
  });
});

describe("fixed rollover open vector (the venue's published worked example)", () => {
  const body = {
    schema_version: "2",
    kind: "rollover",
    request_id: "example-roll-0001",
    requester: ANVIL_0_ADDRESS.toLowerCase(),
    chain_id: 8453,
    source: { pool_id: `0x${"11".repeat(32)}`, shares: "1000000000000000000" },
    reference_asset: USDC_BASE,
    collateral_asset: { exact: USDC_BASE },
    expiry_window: { not_before: 1900000000, not_after: 1900086400 },
    premium_token: { exact: USDC_BASE },
    valid_until: 1899999000,
  };
  const CANONICAL =
    '{"chain_id":8453,"collateral_asset":{"exact":"0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"},"expiry_window":{"not_after":1900086400,"not_before":1900000000},"kind":"rollover","premium_token":{"exact":"0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"},"reference_asset":"0x833589fcd6edb6e08f4c7c32d4f71b54bda02913","request_id":"example-roll-0001","requester":"0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266","schema_version":"2","source":{"pool_id":"0x1111111111111111111111111111111111111111111111111111111111111111","shares":"1000000000000000000"},"valid_until":1899999000}';
  const BODY_HASH = "0x620feef9af6330e50b2d2d03a757bc74f3f0bb8c47fd6be04bcce6cf9f6a3e93";
  const DIGEST = "0x93b6d3592f62235d4c080348dfaecff74e70c9847fcef8c6f923305565fe98a2";
  const SIGNATURE =
    "0xc60db4bd5e11efd4edcceb921c5d7c6db2360ea6c85a3371f41bb3f95c6cd0627e2bfad17636592e7e86f13b47148bf196b5c9039d88cbb41805588b2ebbf4981b";

  it("the client planner preserves the published omitted-role body, digest and signature", async () => {
    const plan = planRfqWrite({
      venueUrl: 'https://venue',
      chainId: body.chain_id,
      clientRequestId: body.request_id,
      request: {
        type: "rfq-open", kind: "rollover", requester: ANVIL_0_ADDRESS,
        source: { poolId: body.source.pool_id as `0x${string}`, shares: body.source.shares },
        referenceAsset: USDC_BASE, collateralAsset: { exact: USDC_BASE },
        expiryWindow: { notBefore: body.expiry_window.not_before, notAfter: body.expiry_window.not_after },
        premiumToken: { exact: USDC_BASE }, validUntil: body.valid_until,
      },
    });
    expect(canonicalJson(plan.body)).toBe(CANONICAL);
    expect(plan.bodyHash).toBe(BODY_HASH);
    expect(plan.digest).toBe(DIGEST);
    expect(await privateKeyToAccount(ANVIL_0_KEY).signTypedData(plan.typedData)).toBe(SIGNATURE);
  });

  it("canonical JSON, bodyHash, digest and signature", async () => {
    expect(canonicalJson(body)).toBe(CANONICAL);
    expect(rfqWriteBodyHash("open", body)).toBe(BODY_HASH);
    const typed = rfqWriteTypedData({ venueOrigin: 'https://venue', operation: "open", ref: body.request_id, chainId: body.chain_id, bodyHash: BODY_HASH });
    expect(hashTypedData(typed)).toBe(DIGEST);
    expect(await privateKeyToAccount(ANVIL_0_KEY).signTypedData(typed)).toBe(SIGNATURE);
  });
});

describe("answer bodies drop every order_signature, keep the order", () => {
  const order = { salt: "1", maker: USDC_BASE, receiver: `0x${"00".repeat(20)}`, makerAsset: USDC_BASE, takerAsset: USDC_BASE, makingAmount: "10", takingAmount: "20", makerTraits: "0" };
  const answer = {
    schema_version: "2",
    kind: "new_position",
    request_id: "req-signing-ans-01",
    underwriter: USDC_BASE,
    status: "quoted",
    signature: "0xaa",
    options: [{ option_id: "opt-1", chain_id: 8453, premium_annualized: "0.04", order, order_signature: "0xbb" }],
  };

  it("hashes the body without signature and order_signature", () => {
    const { signature: _s, options, ...rest } = answer;
    const expected = sha256(stringToBytes(canonicalJson({ ...rest, options: options.map(({ order_signature: _o, ...o }) => o) })));
    expect(rfqWriteBodyHash("answer", answer)).toBe(expected);
    expect(rfqWriteBodyHash("answer", { ...answer, options: [{ ...answer.options[0]!, order_signature: "0xcc" }] })).toBe(expected);
    expect(canonicalJson({ ...rest, options })).toContain('"order":');
  });

  it("only strips order_signature on answers", () => {
    const counterLike = { request_id: "x", options: [{ order_signature: "0xbb" }] };
    expect(rfqWriteBodyHash("counter", counterLike)).toBe(sha256(stringToBytes(canonicalJson(counterLike))));
  });
});

// The venue's own vector (computed with Foundry): its `jit_market_hash` is BaseFiller 0.2's
// commitment — our `0.2` wire, not rc.2.
describe("venue jit_market_hash = our 0.2 rollover wire", () => {
  const sample = {
    collateralAsset: USDC_BASE,
    referenceAsset: "0x4200000000000000000000000000000000000006",
    expiryTimestamp: 1900086400n,
    recipe: `0x${"ab".repeat(20)}`,
    rateOverride: 0n,
    rateMin: 1n,
    rateMax: 2n,
    rateChangePerDayMax: 3n,
    rateChangeCapacityMax: 4n,
    additionalData: "0x1234",
    oracleSalt: `0x${"33".repeat(32)}`,
    swapFeePercentage: 300000000000000000n,
    unwindSwapFeePercentage: 100000000000000000n,
  } as const;

  it("typehash and commitment match the venue byte for byte", () => {
    expect(JIT_MARKET_PARAMS_TYPEHASHES["0.2"]).toBe("0xa968732d6553ee65628eeb5c4711e46564468369219d46b8eed82b2b04b4baf7");
    expect(hashJitMarketParams(sample, "0.2")).toBe("0x50e23ebeb99b7f374db763d851e32aa2bd87ab3fa18a22abab59c2ed3a9bf622");
  });
});
