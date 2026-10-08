// RFQ v2 write signing, held byte for byte to the venue's published vectors (cork-api 0.4.5
// worked example). A drift here means every signed RFQ write is refused with 401.
// Also pins the rollover JIT-market commitment the venue serves as `jit_market_hash`.
import { describe, expect, it } from "vitest";
import { concat, encodeAbiParameters, hashTypedData, keccak256, recoverTypedDataAddress, sha256, stringToBytes, toHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { canonicalJson, RFQ_WRITE_TYPES, rfqWriteBodyHash, rfqWriteTypedData } from "../src/rfq-signing.ts";
import { hashJitMarketParams, JIT_MARKET_PARAMS_TYPEHASHES } from "../src/rollover.ts";

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
  const DOMAIN_SEPARATOR = "0xe5ffc7c8ddf9b6305d45efdf6b3237524caabf9e6b2b5c772b1681440b66f84d";
  const DIGEST = "0x1369f1384f35f8816aabb4ab8bcf45e2b7a7d03796568c4abad4a7d9ed70588b";
  const SIGNATURE =
    "0x28fefa98f945dbff42b20517287afbd9f0bbf769a3f9b214089bcec0a248d7c4101809a47b48e98dbf0681a10ba2d8c7dd20aef4dde62a714380ee0797ec696d1c";

  const typed = () => rfqWriteTypedData({ operation: "open", ref: body.request_id, chainId: body.chain_id, bodyHash: rfqWriteBodyHash("open", body) });

  it("canonical JSON and bodyHash", () => {
    expect(canonicalJson(body)).toBe(CANONICAL);
    expect(rfqWriteBodyHash("open", body)).toBe(BODY_HASH);
  });

  it("type hash, domain separator and digest, rebuilt word by word", () => {
    expect(keccak256(toHex("CorkRfqWrite(string operation,string ref,bytes32 bodyHash)"))).toBe(TYPE_HASH);
    const words = (values: readonly (Hex | bigint)[]) =>
      encodeAbiParameters(values.map((v) => ({ type: typeof v === "bigint" ? "uint256" : "bytes32" })), values);
    const domainTypeHash = keccak256(toHex("EIP712Domain(string name,string version,uint256 chainId)"));
    expect(keccak256(words([domainTypeHash, keccak256(toHex("Cork RFQ")), keccak256(toHex("1")), 8453n]))).toBe(DOMAIN_SEPARATOR);
    const structHash = keccak256(words([TYPE_HASH, keccak256(toHex("open")), keccak256(toHex("example-0001")), BODY_HASH]));
    expect(keccak256(concat(["0x1901", DOMAIN_SEPARATOR, structHash]))).toBe(DIGEST);
    expect(hashTypedData(typed())).toBe(DIGEST);
  });

  it("signature by Anvil account #0, and it recovers", async () => {
    expect(await privateKeyToAccount(ANVIL_0_KEY).signTypedData(typed())).toBe(SIGNATURE);
    expect(await recoverTypedDataAddress({ ...typed(), signature: SIGNATURE })).toBe(ANVIL_0_ADDRESS);
  });

  it("no verifying contract in the domain; the type is exactly the venue's", () => {
    expect(typed().domain).toEqual({ name: "Cork RFQ", version: "1", chainId: 8453 });
    expect(RFQ_WRITE_TYPES.CorkRfqWrite.map((f) => `${f.type} ${f.name}`)).toEqual(["string operation", "string ref", "bytes32 bodyHash"]);
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
  const DIGEST = "0x0517174e3a880c0bfb0f8ac21f0dca4d1627563ede8f8b1f962ca1e66e0df2ce";
  const SIGNATURE =
    "0xaf1fd8a102120a1cf5d49c1c04e8c0d92a5c27a923f402320b6844ad85d33441358ba1c8899094fa1db395ed38288e4f8108dc4ed2e0e3a1559619ee6ed679821b";

  it("canonical JSON, bodyHash, digest and signature", async () => {
    expect(canonicalJson(body)).toBe(CANONICAL);
    expect(rfqWriteBodyHash("open", body)).toBe(BODY_HASH);
    const typed = rfqWriteTypedData({ operation: "open", ref: body.request_id, chainId: body.chain_id, bodyHash: BODY_HASH });
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
