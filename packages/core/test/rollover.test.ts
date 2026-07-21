// Rollover order construction: typehash freezes, domain-separator parity vs the LIVE Arbitrum
// settlers, dual-implementation digest cross-check (viem hashTypedData vs a Solidity-faithful
// manual encoder ported from LibSettlerHashing), intent-hash conventions, and the runTool
// integration surface (settler-kind pre-flight, determinism, gating).
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
  ORDER_DATA_TYPEHASH,
  ROLLOVER_INTENT_TYPEHASH,
  ROLLOVER_PARAMS_TYPEHASH,
  type HandlerContext,
  type OrderDataStruct,
} from "@cork/core";

// Live Arbitrum rollover deployment (verified on-chain 2026-07-20; cork-defaults.json `rollover`).
const EXACT = "0x983270AE48545665Cee4D7EF61C65fF3fdC8222D" as const;
const PARTIAL = "0x8e9Ca640338D3bDbFe3781D7178cA73Af66f366a" as const;
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
    premiumToken: SRC_CST,
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

describe("typehash freezes (rollover-private @ 032d3e5a, INV-WIRE-ORDER-STABILITY)", () => {
  it("constants match the deployed preimages", () => {
    expect(ORDER_DATA_TYPEHASH).toBe("0x13e9d1169b91b8d51ad1ecb30db94b1402a90b6aa0e6e2fe545ee438aa717405");
    expect(ROLLOVER_PARAMS_TYPEHASH).toBe("0xa54ced05edd759aa1c084738db7bc7e4711ff98cefdf790fca3d1d6f9e44b8f9");
    expect(ROLLOVER_INTENT_TYPEHASH).toBe("0xf51f4a1c7b05e3efe0e78b23b4c74d1cb7166b32f2fb066706c2da9208ec9ffe");
    expect(CALL_TYPEHASH).toBe("0x3fad4ba9aae5ad2d96a46400ed3ee818b640829b240f127d0d98b9430f2aa136");
  });
});

describe("domain separator parity (golden vectors fetched from the LIVE settlers' DOMAIN_SEPARATOR())", () => {
  it("ExactSettler", () => {
    expect(corkSettlerDomainSeparator(42161, EXACT)).toBe(
      "0x641550e0088df248f3b9ff4c2a671ec5a2063f5018a4576e2c9cdb3fe0ac4781",
    );
  });
  it("PartialSettler", () => {
    expect(corkSettlerDomainSeparator(42161, PARTIAL)).toBe(
      "0x94fcfec3a959b1a5c1c5bdd07caec8bc0e6179d7ccc6ddd77004bf9eec2f89ab",
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
      premiumToken: SRC_CST,
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
      premiumToken: SRC_CST,
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

  it("exact uint64/uint256 maxima are ACCEPTED (boundary, not off-by-one)", async () => {
    const env = await runTool(
      "cork_prepare_orders",
      { ...base, action: { ...base.action, orderSize: String(U256_MAX), openDeadline: String(U64_MAX - 1n), fillDeadline: String(U64_MAX) } },
      ctx,
    );
    expect(env.state).toBe("ok");
  });
});
