// Rollover order construction (rollover-private @ 5af1048e, v0.1.0-rc.2): typehash freezes,
// domain-separator parity vs the FOUR live rc.2 settlers (Arbitrum + Base), golden digest
// vectors generated from the release's own Solidity libraries (forge, 2026-08-19),
// dual-implementation digest cross-check (viem hashTypedData vs a Solidity-faithful manual
// encoder ported from LibSettlerHashing), the JITMarketParams commitment, intent-hash
// conventions, and the runTool integration surface (settler classification incl. the retired
// July generation, the venue-admission battery, determinism, gating).
import { describe, expect, it } from "vitest";
import { concatHex, keccak256, zeroHash } from "viem";
import {
  buildRolloverIntent,
  computeOrderDigest,
  corkSettlerDomainSeparator,
  hashOrderDataManual,
  intentStructHash,
  runTool,
  CALL_TYPEHASH,
  encodeOrderData,
  hashJitMarketParams,
  JIT_MARKET_PARAMS_TYPEHASH,
  ORDER_DATA_ABI_LENGTH,
  ORDER_DATA_TYPEHASH,
  ROLLOVER_INTENT_TYPEHASH,
  ROLLOVER_PARAMS_TYPEHASH,
  ZERO_JIT_MARKET_HASH,
  type HandlerContext,
  type OrderDataStruct,
} from "@cork/core";

// Live rc.2 rollover deployment — identical addresses on 42161 + 8453 (verified on-chain
// 2026-08-19; cork-defaults.json `rollover`).
const EXACT = "0xF4ffd4b3FAedb784b04d1883119840515f224C2f" as const;
const PARTIAL = "0xC0fbA28687D16e9A94527F7864C7c8D41f1E6B4e" as const;
// The RETIRED July 2026 generation (cork-defaults `rollover.42161.legacyGenerations[0]`) — still
// deployed and answering, but venue-archived and wire-incompatible with rc.2 digests.
const RETIRED_EXACT = "0x983270AE48545665Cee4D7EF61C65fF3fdC8222D" as const;
const RETIRED_PARTIAL = "0x8e9Ca640338D3bDbFe3781D7178cA73Af66f366a" as const;
// Rollover premium must ride a THIRD asset (venue admission: premiumToken differs from both cSTs).
const PREMIUM = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as const;
const CLONE = "0xc0ffee0000000000000000000000000000000001" as const;
const SRC_CST = "0x9D39A5DE30e57443BfF2A8307A4256c8797A3497" as const;
const DST_CST = "0x53E82ABbb12638F09d9e624578ccB666217a765e" as const;
const SRC_POOL = "0x1111111111111111111111111111111111111111111111111111111111111111" as const;
const DST_POOL = "0x2222222222222222222222222222222222222222222222222222222222222222" as const;

const NOW = 1_790_000_000n;
const ctx: HandlerContext = { nowSeconds: NOW };

function intentArgs(overrides: Record<string, unknown> = {}) {
  return {
    chainId: 42161,
    user: CLONE,
    settler: EXACT,
    rolloverContract: CLONE,
    srcCstToken: SRC_CST,
    dstCstToken: DST_CST,
    premiumToken: PREMIUM,
    srcPoolId: SRC_POOL,
    dstPoolId: DST_POOL,
    orderSize: 250n * 10n ** 18n,
    minPremiumPerShare: 12n * 10n ** 15n,
    openDeadline: NOW + 3_600n,
    fillDeadline: NOW + 86_400n,
    clientRequestId: "test-roll-0001",
    ...overrides,
  } as Parameters<typeof buildRolloverIntent>[0];
}

describe("typehash freezes (rollover-private @ 5af1048e = v0.1.0-rc.2, INV-WIRE-ORDER-STABILITY)", () => {
  it("constants match the deployed preimages (cast keccak over Typehashes.sol strings, 2026-08-19)", () => {
    expect(ORDER_DATA_TYPEHASH).toBe("0x23937e8e093d96fdc4118fb64533f77e10cd8e8557771334a825ed96cdb5f758");
    expect(ROLLOVER_PARAMS_TYPEHASH).toBe("0xf77bd4e003e4b9acebf51b2fb1fc702de5529ba949e96e8b675dd8848fc7390e");
    expect(ROLLOVER_INTENT_TYPEHASH).toBe("0xf51f4a1c7b05e3efe0e78b23b4c74d1cb7166b32f2fb066706c2da9208ec9ffe");
    expect(CALL_TYPEHASH).toBe("0x3fad4ba9aae5ad2d96a46400ed3ee818b640829b240f127d0d98b9430f2aa136");
    expect(JIT_MARKET_PARAMS_TYPEHASH).toBe("0x06c2095e27008cfdf3288112d1601603f2b22765df639e3395a71f4472e9b697");
  });
});

describe("domain separator parity (golden vectors fetched from the LIVE rc.2 settlers' DOMAIN_SEPARATOR(), both chains)", () => {
  it("ExactSettler @ 42161", () => {
    expect(corkSettlerDomainSeparator(42161, EXACT)).toBe(
      "0x41e491ba10d31b35dcbfbc56c1eb43c74c004839bffe997e83c8f8624521832c",
    );
  });
  it("PartialSettler @ 42161", () => {
    expect(corkSettlerDomainSeparator(42161, PARTIAL)).toBe(
      "0xd48386f91c627ea02710c392509c12ffba49bb108e9af5e3f60b5b1a1b563372",
    );
  });
  it("ExactSettler @ 8453 (identical address, chain-distinct domain)", () => {
    expect(corkSettlerDomainSeparator(8453, EXACT)).toBe(
      "0xd0524ee7c8df23c4f54873aac98d156da8bcac409713b8f29644be6551e35412",
    );
  });
  it("PartialSettler @ 8453", () => {
    expect(corkSettlerDomainSeparator(8453, PARTIAL)).toBe(
      "0x7251296b1db0a227882a7b8ef3ed1e2d4d40bf2e1770f3db40e9fef9523411ed",
    );
  });
});

describe("order digest", () => {
  it("viem hashTypedData equals the Solidity-faithful manual encoder (independent implementations)", () => {
    const built = buildRolloverIntent(intentArgs());
    const manualStruct = hashOrderDataManual(built.order);
    // digest = keccak(0x1901 ‖ domainSeparator ‖ structHash) — recompose manually
    const sep = corkSettlerDomainSeparator(42161, EXACT);
    const manualDigest = keccak256(concatHex(["0x1901", sep, manualStruct]));
    expect(built.orderDigest).toBe(manualDigest);
    expect(built.orderDigest).toBe(computeOrderDigest(42161, built.order as OrderDataStruct));
  });

  it("is deterministic for identical inputs and clientRequestId-sensitive [K2]", () => {
    const a = buildRolloverIntent(intentArgs());
    const b = buildRolloverIntent(intentArgs());
    expect(a.orderDigest).toBe(b.orderDigest);
    expect(a.order.orderSalt).toBe(b.order.orderSalt);
    const c = buildRolloverIntent(intentArgs({ clientRequestId: "test-roll-0002" }));
    expect(c.orderDigest).not.toBe(a.orderDigest);
  });
});

describe("rolloverIntentHash", () => {
  it("uses the zero-digest convention (order-independent commitment)", () => {
    const built = buildRolloverIntent(intentArgs());
    expect(built.intent.orderDigest).toBe(zeroHash);
    expect(built.rolloverIntentHash).toBe(intentStructHash(built.intent));
    // Binding the (nonzero) digest back in yields a DIFFERENT hash — the committed value must be zero-digest.
    const bound = intentStructHash({ ...built.intent, orderDigest: built.orderDigest });
    expect(bound).not.toBe(built.rolloverIntentHash);
  });

  it("nonce is part of the commitment", () => {
    const a = buildRolloverIntent(intentArgs());
    const c = buildRolloverIntent({ ...intentArgs(), nonce: 2n });
    expect(c.rolloverIntentHash).not.toBe(a.rolloverIntentHash);
  });
});

describe("runTool cork_prepare_orders rollover-intent", () => {
  const base = {
    chainId: 42161,
    account: CLONE,
    clientRequestId: "test-roll-1001",
    action: {
      type: "rollover-intent",
      settler: EXACT,
      rolloverContract: CLONE,
      srcPoolId: SRC_POOL,
      dstPoolId: DST_POOL,
      srcCstToken: SRC_CST,
      dstCstToken: DST_CST,
      premiumToken: PREMIUM,
      orderSize: "250000000000000000000",
      minPremiumPerShare: "12000000000000000",
      openDeadline: String(NOW + 3_600n),
      fillDeadline: String(NOW + 86_400n),
    },
  };

  it("builds a signable order on Arbitrum (ok, config-sourced, no chain I/O)", async () => {
    const env = await runTool("cork_prepare_orders", base, ctx);
    expect(env.state).toBe("ok");
    const data = env.data as Record<string, unknown>;
    expect(data.kind).toBe("rollover-intent");
    expect(data.settlerKind).toBe("EXACT");
    expect(String(data.orderDigest)).toMatch(/^0x[0-9a-f]{64}$/);
    expect(String(data.rolloverIntentHash)).toMatch(/^0x[0-9a-f]{64}$/);
    expect(data.orderDataType).toBe(ORDER_DATA_TYPEHASH);
    const typed = data.typedData as { domain: Record<string, unknown>; message: Record<string, unknown> };
    expect(typed.domain).toMatchObject({ name: "CorkSettler", version: "1.0.0", chainId: 42161, verifyingContract: EXACT });
    // venuePost mirrors OrderData onto the wire shape (decimal strings, lowercase addresses)
    const post = data.venuePost as { order: Record<string, unknown>; intent: Record<string, unknown>; envelope: Record<string, unknown> };
    expect(post.order.user).toBe(CLONE.toLowerCase());
    expect(post.order.originChainId).toBe("42161");
    expect(post.order.rolloverIntentHash).toBe(data.rolloverIntentHash);
    expect((post.order.rolloverParams as Record<string, unknown>).settler).toBe(EXACT.toLowerCase());
    expect(post.intent.deadline).toBe(String(NOW + 86_400n));
    expect(post.envelope.orderDataType).toBe(ORDER_DATA_TYPEHASH);
    expect(env.provenance.source).toBe("config");
  });

  it("rejects the ExactSettler + allowPartialFills:true trap (the venue-doc erratum, enforced on-chain)", async () => {
    const env = await runTool(
      "cork_prepare_orders",
      { ...base, action: { ...base.action, allowPartialFills: true } },
      ctx,
    );
    expect(env.state).toBe("unavailable");
    expect(env.warnings[0]?.code).toBe("settler_mode_mismatch");
    expect(env.warnings[0]?.message).toContain(PARTIAL);
  });

  it("rejects the PartialSettler without allowPartialFills", async () => {
    const env = await runTool(
      "cork_prepare_orders",
      { ...base, action: { ...base.action, settler: PARTIAL } },
      ctx,
    );
    expect(env.state).toBe("unavailable");
    expect(env.warnings[0]?.code).toBe("settler_mode_mismatch");
  });

  it("builds for the PartialSettler when allowPartialFills:true", async () => {
    const env = await runTool(
      "cork_prepare_orders",
      { ...base, action: { ...base.action, settler: PARTIAL, allowPartialFills: true } },
      ctx,
    );
    expect(env.state).toBe("ok");
    expect((env.data as Record<string, unknown>).settlerKind).toBe("PARTIAL");
  });

  it("warns (but builds) for an unrecognized settler", async () => {
    const env = await runTool(
      "cork_prepare_orders",
      { ...base, action: { ...base.action, settler: "0x00000000000000000000000000000000DeaDBeef" } },
      ctx,
    );
    expect(env.state).toBe("ok");
    expect(env.warnings.some((w) => w.code === "settler_not_recognized")).toBe(true);
    expect((env.data as Record<string, unknown>).settlerKind).toBeUndefined();
  });

  it("gates chains without a rollover deployment (mainnet)", async () => {
    const env = await runTool("cork_prepare_orders", { ...base, chainId: 1 }, ctx);
    expect(env.state).toBe("unavailable");
    expect(env.warnings[0]?.code).toBe("unknown_deployment");
  });

  it("rejects incoherent terms (past fillDeadline, zero size, inverted deadlines)", async () => {
    const past = await runTool(
      "cork_prepare_orders",
      { ...base, action: { ...base.action, fillDeadline: String(NOW - 1n) , openDeadline: String(NOW - 2n)} },
      ctx,
    );
    expect(past.state).toBe("unavailable");
    expect(past.warnings[0]?.code).toBe("invalid_order_terms");

    const zero = await runTool("cork_prepare_orders", { ...base, action: { ...base.action, orderSize: "0" } }, ctx);
    expect(zero.state).toBe("unavailable");
    expect(zero.warnings[0]?.code).toBe("invalid_order_terms");

    const inverted = await runTool(
      "cork_prepare_orders",
      { ...base, action: { ...base.action, openDeadline: String(NOW + 90_000n) } },
      ctx,
    );
    expect(inverted.state).toBe("unavailable");
    expect(inverted.warnings[0]?.code).toBe("invalid_order_terms");
  });

  it("identical calls produce byte-identical envelopes (digest-stable) [K2]", async () => {
    const a = await runTool("cork_prepare_orders", base, ctx);
    const b = await runTool("cork_prepare_orders", base, ctx);
    expect(a.provenance.digest).toBe(b.provenance.digest);
  });
});

describe("intent hashing with NON-EMPTY hooks (the hard path: Call struct + array hashing)", () => {
  const HOOK = {
    target: "0x9D39A5DE30e57443BfF2A8307A4256c8797A3497" as const,
    value: 0n,
    callData: "0xdeadbeef" as const,
    allowFailure: false,
    isDelegateCall: true,
  };
  const intentWithHooks = {
    rolloverContract: CLONE,
    orderDigest: zeroHash,
    deadline: 1_795_604_800n,
    nonce: 7n,
    preRolloverHooks: [HOOK],
    midRolloverHooks: [],
    postRolloverHooks: [HOOK, { ...HOOK, callData: "0x" as const, isDelegateCall: true }],
    premiumHooks: [],
  };

  it("matches viem's independent EIP-712 struct hashing (recomposed through hashTypedData)", async () => {
    // hashTypedData(domain, types, msg) = keccak(0x1901 ‖ hashDomain ‖ structHash). viem derives
    // the struct hash (incl. Call[] array + nested-struct rules) from the types object on its
    // own — if our Solidity-ported intentStructHash agrees, both implementations agree on the
    // hook-hashing rules (keccak(callData), per-element struct hash, concat-then-keccak).
    const { hashTypedData, hashDomain, keccak256: k, concatHex: cat } = await import("viem");
    const INTENT_TYPES = {
      RolloverIntent: [
        { name: "rolloverContract", type: "address" },
        { name: "orderDigest", type: "bytes32" },
        { name: "deadline", type: "uint64" },
        { name: "nonce", type: "uint64" },
        { name: "preRolloverHooks", type: "Call[]" },
        { name: "midRolloverHooks", type: "Call[]" },
        { name: "postRolloverHooks", type: "Call[]" },
        { name: "premiumHooks", type: "Call[]" },
      ],
      Call: [
        { name: "target", type: "address" },
        { name: "value", type: "uint256" },
        { name: "callData", type: "bytes" },
        { name: "allowFailure", type: "bool" },
        { name: "isDelegateCall", type: "bool" },
      ],
    } as const;
    const domain = { name: "X", version: "1", chainId: 1, verifyingContract: CLONE } as const;
    const viaViem = hashTypedData({ domain, types: INTENT_TYPES, primaryType: "RolloverIntent", message: intentWithHooks });
    const domainSep = hashDomain({
      domain: { ...domain, chainId: 1n },
      types: { EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ] },
    });
    const recomposed = k(cat(["0x1901", domainSep, intentStructHash(intentWithHooks)]));
    expect(recomposed).toBe(viaViem);
  });

  it("every hook field is commitment-bearing (callData, isDelegateCall, ordering, array slot)", () => {
    const base = intentStructHash(intentWithHooks);
    expect(intentStructHash({ ...intentWithHooks, preRolloverHooks: [{ ...HOOK, callData: "0xdeadbeee" }] })).not.toBe(base);
    expect(intentStructHash({ ...intentWithHooks, preRolloverHooks: [{ ...HOOK, isDelegateCall: false }] })).not.toBe(base);
    // same hook moved to a different phase array → different commitment
    expect(intentStructHash({ ...intentWithHooks, preRolloverHooks: [], midRolloverHooks: [HOOK] })).not.toBe(base);
    // order within an array matters
    const twoA = intentStructHash({ ...intentWithHooks, postRolloverHooks: [HOOK, { ...HOOK, callData: "0x" }] });
    const twoB = intentStructHash({ ...intentWithHooks, postRolloverHooks: [{ ...HOOK, callData: "0x" }, HOOK] });
    expect(twoA).not.toBe(twoB);
  });
});

describe("input bounds are teachable invalid input, never internal errors (regression: uint64/uint256 overflow)", () => {
  const base = {
    chainId: 42161,
    account: CLONE,
    clientRequestId: "test-bounds-01",
    action: {
      type: "rollover-intent",
      settler: EXACT,
      rolloverContract: CLONE,
      srcPoolId: SRC_POOL,
      dstPoolId: DST_POOL,
      srcCstToken: SRC_CST,
      dstCstToken: DST_CST,
      premiumToken: PREMIUM,
      orderSize: "1000",
      minPremiumPerShare: "1",
      openDeadline: String(NOW + 1n),
      fillDeadline: String(NOW + 2n),
    },
  };
  const U64_MAX = (1n << 64n) - 1n;
  const U256_MAX = (1n << 256n) - 1n;

  it("fillDeadline > uint64 → ToolInputError naming the field (was: raw viem IntegerOutOfRange)", async () => {
    await expect(
      runTool("cork_prepare_orders", { ...base, action: { ...base.action, fillDeadline: String(U64_MAX + 1n) } }, ctx),
    ).rejects.toMatchObject({ name: "ToolInputError" });
  });

  it("orderSize > uint256 → ToolInputError (schema-level, teaching attached)", async () => {
    try {
      await runTool("cork_prepare_orders", { ...base, action: { ...base.action, orderSize: String(U256_MAX + 1n) } }, ctx);
      expect.unreachable("should have thrown");
    } catch (e) {
      const err = e as { name: string; issues: Array<{ path: unknown[]; message: string }> };
      expect(err.name).toBe("ToolInputError");
      expect(JSON.stringify(err.issues)).toContain("uint256");
    }
  });

  it("exact boundary values are ACCEPTED (uint256 amount max; UnixSeconds plausibility max)", async () => {
    // UnixSeconds fields are now bounded to 4102444800 (2100-01-01) by the ms-detector refine —
    // the boundary itself must pass, one above must fail with the milliseconds teaching.
    const UNIX_MAX = 4102444800n;
    const env = await runTool(
      "cork_prepare_orders",
      { ...base, action: { ...base.action, orderSize: String(U256_MAX), openDeadline: String(UNIX_MAX - 1n), fillDeadline: String(UNIX_MAX) } },
      ctx,
    );
    expect(env.state).toBe("ok");
  });

  it("a millisecond-scale deadline (Date.now() pasted as seconds) is teachable invalid input", async () => {
    try {
      await runTool("cork_prepare_orders", { ...base, action: { ...base.action, fillDeadline: "1753363200000" } }, ctx);
      expect.unreachable("should have thrown");
    } catch (e) {
      const err = e as { name: string; issues: unknown };
      expect(err.name).toBe("ToolInputError");
      expect(JSON.stringify(err.issues)).toContain("MILLISECONDS");
    }
  });
});

describe("golden digest vectors (generated from rollover-private @ 5af1048e Solidity libraries via forge, 2026-08-19)", () => {
  // Same fixture as intentArgs, with the salt pinned to the forge run's and the premium token
  // the forge sample used (hashing is validation-free; admission rules live in the handlers).
  const golden = () =>
    buildRolloverIntent(intentArgs({ premiumToken: SRC_CST, orderSalt: 8_811_723_641n }));

  it("intentStructHash matches LibAuthenticatedHooks.intentStructHash", () => {
    expect(golden().rolloverIntentHash).toBe("0x29e46ec9a02a21c7f6044cdbccc4cc2348db336d4e3e23713d0402fc527074b3");
  });

  it("struct hash + digest match LibSettlerHashing.hashOrderData/computeOrderDigest (jitMarketHash = 0)", () => {
    const built = golden();
    expect(hashOrderDataManual(built.order)).toBe("0x7dcaf868b7e9f269274900bcbd400a77d97ae9190ee82b7d554fd626cfe06f1f");
    expect(built.orderDigest).toBe("0x3b5f8a84692f17e77ce95dadb0c506252cb5632efd7d2fca6d7f6ef315d23429");
  });

  it("a non-zero jitMarketHash lands in the struct hash exactly as the library computes it", () => {
    const jit = `0x${"00".repeat(30)}abcd` as const;
    const built = buildRolloverIntent(
      intentArgs({ premiumToken: SRC_CST, orderSalt: 8_811_723_641n, jitMarketHash: jit }),
    );
    expect(hashOrderDataManual(built.order)).toBe("0x5017a027c8ca05c9695b12107b13135d19b5a7964ea049ac25b12f0cefeeddc3");
    // and the viem path agrees with the manual encoder on the same input
    const sep = corkSettlerDomainSeparator(42161, EXACT);
    expect(built.orderDigest).toBe(keccak256(concatHex(["0x1901", sep, hashOrderDataManual(built.order)])));
  });
});

describe("jitMarketHash semantics (rc.2: the field is signed either way)", () => {
  it("omitted jitMarketHash and an explicit zero hash produce the SAME digest", () => {
    const omitted = buildRolloverIntent(intentArgs());
    const explicit = buildRolloverIntent(intentArgs({ jitMarketHash: ZERO_JIT_MARKET_HASH }));
    expect(explicit.orderDigest).toBe(omitted.orderDigest);
    expect(omitted.order.rolloverParams.jitMarketHash).toBe(ZERO_JIT_MARKET_HASH);
    expect(omitted.venuePost.order.rolloverParams.jitMarketHash).toBe(ZERO_JIT_MARKET_HASH);
  });

  it("a non-zero commitment changes the digest", () => {
    const a = buildRolloverIntent(intentArgs());
    const b = buildRolloverIntent(intentArgs({ jitMarketHash: `0x${"11".repeat(32)}` }));
    expect(b.orderDigest).not.toBe(a.orderDigest);
  });
});

describe("hashJitMarketParams (BaseFiller.hashJITMarketParams @ 5af1048e)", () => {
  const params = {
    collateralAsset: "0x211Cc4DD073734dA055fbF44a2b4667d5E5fE5d2" as const,
    referenceAsset: "0xdDb46999F8891663a8F2828d25298f70416d7610" as const,
    expiryTimestamp: 1_798_761_600n,
    recipe: "0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa" as const,
    rateOverride: 0n,
    rateMin: 9n * 10n ** 17n,
    rateMax: 11n * 10n ** 17n,
    rateChangePerDayMax: 10n ** 16n,
    rateChangeCapacityMax: 5n * 10n ** 16n,
    additionalData: "0x1234" as const,
    swapFeePercentage: 3n * 10n ** 17n,
    unwindSwapFeePercentage: 2n * 10n ** 17n,
  };

  it("matches the forge-generated golden vector", () => {
    expect(hashJitMarketParams(params)).toBe("0xa0ad01ccd8fb743078f541f703bd84b28e14c673a11af2ba25af5be90eae1d19");
  });

  it("additionalData is committed via keccak256, and every field is commitment-bearing", () => {
    const base = hashJitMarketParams(params);
    expect(hashJitMarketParams({ ...params, additionalData: "0x" })).not.toBe(base);
    // rateMin/rateMax swapped keeps every VALUE but must change the hash (field-order mutant)
    expect(hashJitMarketParams({ ...params, rateMin: params.rateMax, rateMax: params.rateMin })).not.toBe(base);
    expect(hashJitMarketParams({ ...params, swapFeePercentage: params.unwindSwapFeePercentage, unwindSwapFeePercentage: params.swapFeePercentage })).not.toBe(base);
    expect(hashJitMarketParams({ ...params, rateOverride: 1n })).not.toBe(base);
  });
});

describe("encodeOrderData (the ERC-7683 envelope blob the settlers decode)", () => {
  it("is exactly ORDER_DATA_ABI_LENGTH (864) bytes — LibRolloverOrder rejects any other length", () => {
    const built = buildRolloverIntent(intentArgs());
    const blob = encodeOrderData(built.order);
    expect(ORDER_DATA_ABI_LENGTH).toBe(864);
    expect(blob).toHaveLength(2 + ORDER_DATA_ABI_LENGTH * 2);
  });

  it("jitMarketHash rides in the final 32-byte word", () => {
    const jit = `0x${"ab".repeat(32)}` as const;
    const blob = encodeOrderData(buildRolloverIntent(intentArgs({ jitMarketHash: jit })).order);
    expect(blob.slice(-64)).toBe("ab".repeat(32));
  });
});

describe("runTool rollover admission battery (venue-parity gates) + settler generations", () => {
  const base = {
    chainId: 42161,
    account: CLONE,
    clientRequestId: "test-roll-adm-01",
    action: {
      type: "rollover-intent",
      settler: EXACT,
      rolloverContract: CLONE,
      srcPoolId: SRC_POOL,
      dstPoolId: DST_POOL,
      srcCstToken: SRC_CST,
      dstCstToken: DST_CST,
      premiumToken: PREMIUM,
      orderSize: "250000000000000000000",
      minPremiumPerShare: "12000000000000000",
      openDeadline: String(NOW + 3_600n),
      fillDeadline: String(NOW + 86_400n),
    },
  };
  const run = (patch: Record<string, unknown>) =>
    runTool("cork_prepare_orders", { ...base, action: { ...base.action, ...patch } }, ctx);

  it("a RETIRED-generation settler is refused with settler_retired naming the active replacement", async () => {
    for (const [retired, active] of [
      [RETIRED_EXACT, EXACT],
      [RETIRED_PARTIAL, PARTIAL],
    ] as const) {
      const env = await run({ settler: retired, allowPartialFills: retired === RETIRED_PARTIAL });
      expect(env.state).toBe("unavailable");
      expect(env.warnings[0]?.code).toBe("settler_retired");
      expect(env.warnings[0]?.message).toContain(active);
      expect(env.warnings[0]?.message).toContain("july-2026");
    }
  });

  it("premiumToken equal to either cST is refused (venue admission parity)", async () => {
    for (const premiumToken of [SRC_CST, DST_CST]) {
      const env = await run({ premiumToken });
      expect(env.state).toBe("unavailable");
      expect(env.warnings[0]?.code).toBe("invalid_order_terms");
      expect(env.warnings[0]?.message).toContain("premiumToken");
    }
  });

  it("openDeadline in the past, zero premium, equal pool ids, exclusiveFiller == settler — each refused", async () => {
    const past = await run({ openDeadline: String(NOW - 1n) });
    expect(past.state).toBe("unavailable");
    expect(past.warnings[0]?.message).toContain("openDeadline");

    // Boundary: openDeadline exactly NOW is legal (the venue rejects strictly-past only).
    const boundary = await run({ openDeadline: String(NOW) });
    expect(boundary.state).toBe("ok");

    const zeroPremium = await run({ minPremiumPerShare: "0" });
    expect(zeroPremium.state).toBe("unavailable");
    expect(zeroPremium.warnings[0]?.message).toContain("minPremiumPerShare");

    const samePools = await run({ dstPoolId: SRC_POOL });
    expect(samePools.state).toBe("unavailable");
    expect(samePools.warnings[0]?.message).toContain("srcPoolId");

    const selfFiller = await run({ exclusiveFiller: EXACT });
    expect(selfFiller.state).toBe("unavailable");
    expect(selfFiller.warnings[0]?.message).toContain("exclusiveFiller");
  });

  it("Base (8453) builds too — the rc.2 deployment is paired", async () => {
    const env = await runTool("cork_prepare_orders", { ...base, chainId: 8453 }, ctx);
    expect(env.state).toBe("ok");
    const typed = (env.data as Record<string, unknown>).typedData as { domain: Record<string, unknown> };
    expect(typed.domain).toMatchObject({ chainId: 8453, verifyingContract: EXACT });
  });

  const JIT_MARKET = {
    collateralAsset: "0x211Cc4DD073734dA055fbF44a2b4667d5E5fE5d2",
    referenceAsset: "0xdDb46999F8891663a8F2828d25298f70416d7610",
    expiryTimestamp: "1798761600",
    recipe: "0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa",
    constraint: {
      rateMin: "900000000000000000",
      rateMax: "1100000000000000000",
      rateChangePerDayMax: "10000000000000000",
      rateChangeCapacityMax: "50000000000000000",
    },
    additionalData: "0x1234",
    swapFeePercentage: "300000000000000000",
    unwindSwapFeePercentage: "200000000000000000",
  };

  it("jitMarket is hashed locally into rolloverParams.jitMarketHash [K3] — identical to passing the pre-computed commitment", async () => {
    const viaParams = await run({ jitMarket: JIT_MARKET });
    expect(viaParams.state).toBe("ok");
    const post = (viaParams.data as Record<string, unknown>).venuePost as { order: { rolloverParams: { jitMarketHash: string } } };
    expect(post.order.rolloverParams.jitMarketHash).toBe("0xa0ad01ccd8fb743078f541f703bd84b28e14c673a11af2ba25af5be90eae1d19");

    const viaHash = await run({ jitMarketHash: "0xa0ad01ccd8fb743078f541f703bd84b28e14c673a11af2ba25af5be90eae1d19" });
    expect(viaHash.state).toBe("ok");
    expect((viaHash.data as Record<string, unknown>).orderDigest).toBe((viaParams.data as Record<string, unknown>).orderDigest);
  });

  it("jitMarket + jitMarketHash together are refused (one commitment source)", async () => {
    const env = await run({ jitMarket: JIT_MARKET, jitMarketHash: `0x${"11".repeat(32)}` });
    expect(env.state).toBe("unavailable");
    expect(env.warnings[0]?.code).toBe("invalid_order_terms");
    expect(env.warnings[0]?.message).toContain("mutually exclusive");
  });

  it("jitMarket fee above the 5% cap and an expiry inside the fill window are refused", async () => {
    const fee = await run({ jitMarket: { ...JIT_MARKET, swapFeePercentage: "5000000000000000001" } });
    expect(fee.state).toBe("unavailable");
    expect(fee.warnings[0]?.message).toContain("5%");

    const expiry = await run({ jitMarket: { ...JIT_MARKET, expiryTimestamp: String(NOW + 86_400n) } });
    expect(expiry.state).toBe("unavailable");
    expect(expiry.warnings[0]?.message).toContain("expiryTimestamp");
  });
});
