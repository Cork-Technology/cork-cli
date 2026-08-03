// decodeKnownLog: source-verified full decodes vs honest name-only labels. Logs are synthesized
// BY HAND from the pinned event declarations (selector + topic padding + abi.encode of the
// non-indexed tail), fully independent of the module's own ABI objects — so a drift in
// KNOWN_EVENTS_ABI's field order/indexing fails these tests rather than round-tripping invisibly.
import { describe, expect, it } from "vitest";
import { encodeAbiParameters, toEventSelector } from "viem";
import { decodeKnownLog, JIT_MARKET_CREATED_LEGACY_TOPIC, JIT_MARKET_CREATED_TOPIC, JIT_MINTED_TOPIC } from "@cork/core";

const POOL_ID = `0x${"da".repeat(32)}` as const;
const ORACLE = "0xC8dDf889131583be72260Dea891CFFec1e02aC2F";
const CA = "0x211Cc4DD073734dA055fbF44a2b4667d5E5fE5d2";
const REF = "0xdDb46999F8891663a8F2828d25298f70416d7610";
const RECIPE = "0xA39d552802b2D3A9be6F5DCDD2C6961DaeD1234D";
const ADAPTER = "0x230758CB5d5B222091A6ac3c1d557Cd395cDd65B";

/** address → 32-byte topic (left-padded), the EVM's indexed-address encoding. */
const topicOf = (addr: string): `0x${string}` => `0x${"00".repeat(12)}${addr.slice(2).toLowerCase()}` as `0x${string}`;

describe("decodeKnownLog — 2.1.0 JIT events (source-verified, full arg decode)", () => {
  it("JITMarketCreated (recipe address form) decodes to named args", () => {
    // Independently derived from the pinned declaration: poolId + rateOracle indexed; the data
    // tail is abi.encode(ca, ref, expiryTimestamp, recipe).
    expect(toEventSelector("JITMarketCreated(bytes32,address,address,address,uint256,address)")).toBe(JIT_MARKET_CREATED_TOPIC);
    const data = encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "uint256" }, { type: "address" }],
      [CA, REF, 1_900_000_000n, RECIPE],
    );
    const row = decodeKnownLog({ address: ADAPTER, topics: [JIT_MARKET_CREATED_TOPIC, POOL_ID, topicOf(ORACLE)], data });
    expect(row.known).toBe(true);
    if (!row.known) throw new Error("unreachable");
    expect(row.event).toBe("JITMarketCreated");
    expect(row.args["poolId"]).toBe(POOL_ID);
    expect(String(row.args["rateOracle"]).toLowerCase()).toBe(ORACLE.toLowerCase());
    expect(String(row.args["collateralAsset"]).toLowerCase()).toBe(CA.toLowerCase());
    expect(String(row.args["recipe"]).toLowerCase()).toBe(RECIPE.toLowerCase());
    expect(row.args["expiryTimestamp"]).toBe("1900000000"); // bigints arrive as decimal strings
  });

  it("JITMinted decodes to named args (selector shared across generations, same layout)", () => {
    expect(toEventSelector("JITMinted(bytes32,address,uint256,uint256)")).toBe(JIT_MINTED_TOPIC);
    const data = encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [42n, 41n]);
    const row = decodeKnownLog({ topics: [JIT_MINTED_TOPIC, POOL_ID, topicOf(CA)], data });
    expect(row.known).toBe(true);
    if (!row.known) throw new Error("unreachable");
    expect(row.event).toBe("JITMinted");
    expect(String(row.args["recipient"]).toLowerCase()).toBe(CA.toLowerCase());
    expect(row.args["cstShares"]).toBe("42");
    expect(row.args["collateralIn"]).toBe("41");
  });

  it("the LEGACY mode-string JITMarketCreated stays name-only (layout not source-verified)", () => {
    const row = decodeKnownLog({ topics: [JIT_MARKET_CREATED_LEGACY_TOPIC, POOL_ID], data: "0x" });
    expect(row.known).toBe(false);
    if (row.known) throw new Error("unreachable");
    expect(row.event).toContain("JITMarketCreated");
    expect(row.event).toContain("legacy");
    expect(row.note).toContain("not source-verified");
  });

  it("a malformed 2.1.0 JIT log (bad data length) degrades to the name-only label, never a wrong decode", () => {
    const row = decodeKnownLog({ topics: [JIT_MARKET_CREATED_TOPIC, POOL_ID], data: "0x01" });
    expect(row.known).toBe(false);
    if (row.known) throw new Error("unreachable");
    expect(row.event).toBe("JITMarketCreated");
  });

  it("an unknown selector stays an honest unknown row with raw bytes", () => {
    const row = decodeKnownLog({ topics: [`0x${"ee".repeat(32)}`], data: "0x1234" });
    expect(row.known).toBe(false);
    if (row.known) throw new Error("unreachable");
    expect(row.event).toBeNull();
    expect(row.data).toBe("0x1234");
  });

  it("regression: phoenix MarketCreated still fully decodes after the ABI-first reorder", () => {
    // id + referenceAsset + collateralAsset indexed; tail = (expiry, rateOracle, principalToken, swapToken).
    const sel = toEventSelector("MarketCreated(bytes32,address,address,uint256,address,address,address)");
    const data = encodeAbiParameters(
      [{ type: "uint256" }, { type: "address" }, { type: "address" }, { type: "address" }],
      [1_900_000_000n, ORACLE, CA, REF],
    );
    const row = decodeKnownLog({ topics: [sel, POOL_ID, topicOf(REF), topicOf(CA)], data });
    expect(row.known).toBe(true);
    if (!row.known) throw new Error("unreachable");
    expect(row.event).toBe("MarketCreated");
    expect(String(row.args["swapToken"]).toLowerCase()).toBe(REF.toLowerCase());
  });
});
