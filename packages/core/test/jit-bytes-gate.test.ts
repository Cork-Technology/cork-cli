// The bytes-decoder gate (policy R12a, finding 2026-09-03): the JIT paths REFUSE to build the
// extraData a hook decodes when the adapter's live code is off this build's approved list, and
// they read their own bytes back through the adapter's decodeExtraData when it exists. The
// handler runs against the eval stub's full chain and venue (the same stack the JIT tasks use);
// each test wraps ONE client view — getCode for the adapter, or decodeExtraData — to put the
// chain into the state under test, and leaves everything else real.
import { afterEach, describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { DEMO_ACCOUNT } from "@cork/schemas";
import { buildMakerOrder, implementationRefusals, LOP_ADDRESSES, resolveMarketRegistry, runTool, unapprovedCodeAllowed, type HandlerContext, type ImplementationCheck } from "@cork/core";
import { JIT_TASK_CONSTRAINT, JIT_TASK_PAIR, LIQUIDITY_RECIPE, stubContext } from "../../../evals/stub.ts";

const CHAIN = 42161 as const;
const NOW = 1_790_000_000n; // the eval stub's clock
const EXPIRY = (NOW + 20n * 86_400n).toString(); // inside the registry's 30-day creation bound
const OFF_LIST_CODE = "0x60806040deadbeef" as const;

type Client = { readContract: (a: { functionName: string; args?: unknown[]; address?: string }) => Promise<unknown>; getCode: (a: { address?: string }) => Promise<string> } & Record<string, unknown>;

/** The eval stub with one client view replaced. */
function wrapped(patch: (client: Client, adapter: `0x${string}`) => Partial<Client>): HandlerContext {
  const base = stubContext();
  return {
    ...base,
    resolveRpc: async (chainId, url) => {
      const r = await base.resolveRpc!(chainId, url);
      if (!r) return r;
      const adapter = (await resolveMarketRegistry(chainId)).marketRegistry!.adapter!;
      const client = r.client as unknown as Client;
      return { ...r, client: { ...client, ...patch(client, adapter) } as never };
    },
  };
}
/** The adapter's code hashes off the list; every other address answers as the stub does. */
const offListAdapter = () => wrapped((client, adapter) => ({ getCode: async (a) => (String(a?.address ?? "").toLowerCase() === adapter.toLowerCase() ? OFF_LIST_CODE : client.getCode(a)) }));

const makerJit = (ctx: HandlerContext, id = "gate-0001") =>
  runTool("cork_prepare_orders", { chainId: CHAIN, account: DEMO_ACCOUNT, clientRequestId: id, action: { type: "maker-order", poolId: `0x${"ce".repeat(32)}`, side: "SELL", makerAsset: "0x16Aa2EbE1E2D6C856c634DaFc256257d2fEc0C69", takerAsset: JIT_TASK_PAIR.collateralAsset, makingAmount: "1000000000000000000", takingAmount: "50000000000000000", jitMarket: { ...JIT_TASK_PAIR, expiryTimestamp: EXPIRY, recipe: LIQUIDITY_RECIPE, constraint: JIT_TASK_CONSTRAINT } } }, ctx);

describe("implementationRefusals + the env override (pure)", () => {
  const checks: ImplementationCheck[] = [
    { role: "jitAdapter", address: "0x00000000000000000000000000000000000000a1", codehash: `0x${"aa".repeat(32)}`, verdict: "not_approved" },
    { role: "marketRegistry", address: "0x00000000000000000000000000000000000000b2", codehash: `0x${"bb".repeat(32)}`, verdict: "not_approved" },
    { role: "jitAdapter", address: "0x00000000000000000000000000000000000000c3", verdict: "unreadable" },
    { role: "jitAdapter", address: "0x00000000000000000000000000000000000000d4", verdict: "no_code" },
    { role: "jitAdapter", address: "0x00000000000000000000000000000000000000e5", verdict: "proxy_unresolved" },
    { role: "jitAdapter", address: "0x00000000000000000000000000000000000000f6", codehash: `0x${"cc".repeat(32)}`, verdict: "approved" },
  ];
  it("refuses only POSITIVE findings on the named roles: not_approved, no_code, proxy_unresolved — never unreadable or approved, never another role", () => {
    expect(implementationRefusals(checks, ["jitAdapter"]).map((c) => c.address.slice(-2))).toEqual(["a1", "d4", "e5"]);
    expect(implementationRefusals(checks, ["marketRegistry"]).map((c) => c.address.slice(-2))).toEqual(["b2"]);
    expect(implementationRefusals(checks, ["corkAdapter"])).toEqual([]);
  });
  it("CORK_ALLOW_UNAPPROVED_CODE accepts 1 and true only", () => {
    expect(unapprovedCodeAllowed({})).toBe(false);
    expect(unapprovedCodeAllowed({ CORK_ALLOW_UNAPPROVED_CODE: "1" })).toBe(true);
    expect(unapprovedCodeAllowed({ CORK_ALLOW_UNAPPROVED_CODE: "true" })).toBe(true);
    expect(unapprovedCodeAllowed({ CORK_ALLOW_UNAPPROVED_CODE: "yes" })).toBe(false);
  });
});

describe("the JIT maker path refuses off-list adapter code (conflict, no bytes) — and the override labels instead", () => {
  afterEach(() => { delete process.env["CORK_ALLOW_UNAPPROVED_CODE"]; });

  it("baseline: against the stub's adapter the JIT order builds, and the R12a round-trip reads the bytes back verbatim", async () => {
    const env = await makerJit(stubContext());
    expect(env.state, JSON.stringify(env.warnings)).toBe("ok");
    const d = env.data as { typedData: unknown; jit: { extraDataLayout: string } };
    expect(d.typedData).toBeDefined();
    expect(d.jit.extraDataLayout).toContain("verified-on-chain");
    expect(env.warnings.some((w) => w.code === "implementation_not_approved" || w.code === "implementation_gate_bypassed")).toBe(false);
  });

  it("off-list adapter code: conflict, implementation_not_approved, NO typed-data; the data names the role, hash, and the override", async () => {
    const env = await makerJit(offListAdapter());
    expect(env.state).toBe("conflict");
    expect(env.warnings[0]!.code).toBe("implementation_not_approved");
    expect(env.warnings[0]!.message).toContain("R12a");
    expect(env.warnings[0]!.message).toMatch(/No [a-z-]+ was built/);
    const d = env.data as { refused: Array<{ role: string; verdict: string; codehash?: string }>; override: string; typedData?: unknown };
    expect(d.typedData).toBeUndefined();
    expect(d.refused[0]).toMatchObject({ role: "jitAdapter", verdict: "not_approved" });
    expect(d.refused[0]!.codehash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(d.override).toContain("CORK_ALLOW_UNAPPROVED_CODE");
  });

  it("with CORK_ALLOW_UNAPPROVED_CODE=1 the same input builds, labeled implementation_gate_bypassed (the plain warning rides too)", async () => {
    process.env["CORK_ALLOW_UNAPPROVED_CODE"] = "1";
    const env = await makerJit(offListAdapter(), "gate-0002");
    expect(env.state, JSON.stringify(env.warnings)).toBe("ok");
    expect((env.data as { typedData: unknown }).typedData).toBeDefined();
    expect(env.warnings.some((w) => w.code === "implementation_gate_bypassed" && w.message.includes("built anyway"))).toBe(true);
    expect(env.warnings.some((w) => w.code === "implementation_not_approved")).toBe(true);
  });

  it("an UNREADABLE adapter code (the guard could not look) never refuses — the gate acts on what it saw", async () => {
    const ctx = wrapped((client, adapter) => ({ getCode: async (a) => { if (String(a?.address ?? "").toLowerCase() === adapter.toLowerCase()) throw new Error("eth_getCode unavailable"); return client.getCode(a); } }));
    const env = await makerJit(ctx, "gate-0003");
    expect(env.state, JSON.stringify(env.warnings)).toBe("ok");
    expect(env.warnings.some((w) => w.code === "implementation_not_approved")).toBe(false);
  });
});

describe("the R12a round-trip: the adapter's own decodeExtraData is the layout oracle", () => {
  it("a decoder that reads the bytes back DIFFERENTLY (collateral and reference swapped) is a conflict naming both fields — no bytes", async () => {
    const ctx = wrapped((client) => ({
      readContract: async (a) => {
        const out = await client.readContract(a);
        if (a.functionName !== "decodeExtraData") return out;
        const [p, permits] = out as [Record<string, unknown>, unknown[]];
        return [{ ...p, collateralAsset: p.referenceAsset, referenceAsset: p.collateralAsset }, permits];
      },
    }));
    const env = await makerJit(ctx, "gate-0004");
    expect(env.state).toBe("conflict");
    expect(env.warnings[0]!.code).toBe("extra_data_layout_mismatch");
    const d = env.data as { differing: string[]; typedData?: unknown; encoded: { params: Record<string, string> }; decoded: { params: Record<string, string> } };
    expect(d.differing).toEqual(["collateralAsset", "referenceAsset"]);
    expect(d.typedData).toBeUndefined();
    expect(d.encoded.params.collateralAsset!.toLowerCase()).toBe(JIT_TASK_PAIR.collateralAsset.toLowerCase());
    expect(d.decoded.params.collateralAsset!.toLowerCase()).toBe(JIT_TASK_PAIR.referenceAsset.toLowerCase());
  });

  it("a decoder that swaps the two fee fields is caught the same way — the silent class a revert never shows", async () => {
    const ctx = wrapped((client) => ({
      readContract: async (a) => {
        const out = await client.readContract(a);
        if (a.functionName !== "decodeExtraData") return out;
        const [p, permits] = out as [Record<string, unknown>, unknown[]];
        return [{ ...p, swapFeePercentage: 1n, unwindSwapFeePercentage: 2n }, permits];
      },
    }));
    const env = await makerJit(ctx, "gate-0005");
    expect(env.state).toBe("conflict");
    expect((env.data as { differing: string[] }).differing).toEqual(["swapFeePercentage", "unwindSwapFeePercentage"]);
  });

  it("an adapter WITHOUT the helper (pre-0.4.0) builds, and says the layout is unchecked — never a guess, never a refusal", async () => {
    const ctx = wrapped((client) => ({ readContract: async (a) => { if (a.functionName === "decodeExtraData") throw new Error("execution reverted"); return client.readContract(a); } }));
    const env = await makerJit(ctx, "gate-0006");
    expect(env.state, JSON.stringify(env.warnings)).toBe("ok");
    const d = env.data as { typedData: unknown; jit: { extraDataLayout: string } };
    expect(d.typedData).toBeDefined();
    expect(d.jit.extraDataLayout).toContain("unchecked");
    expect(d.jit.extraDataLayout).toContain("pre-0.4.0");
  });
});

describe("the TAKER path (a BUY-cover lift with a JIT mint) is held to the same gate", () => {
  const maker = privateKeyToAccount(`0x${"5f".repeat(32)}`);
  async function restingBuy() {
    const lop = LOP_ADDRESSES[CHAIN]!;
    // The resting maker BUYS cover: pays collateral, takes the (not yet minted) cST.
    const built = buildMakerOrder({ chainId: CHAIN, lop, maker: maker.address, makerAsset: JIT_TASK_PAIR.collateralAsset, takerAsset: "0x16Aa2EbE1E2D6C856c634DaFc256257d2fEc0C69", makingAmount: 50_000_000_000_000_000n, takingAmount: 10n ** 18n, clientRequestId: "buy-0001" });
    const o = built.order;
    return { orderHash: built.orderHash, signedOrder: { order: { salt: o.salt.toString(), maker: o.maker, receiver: o.receiver, makerAsset: o.makerAsset, takerAsset: o.takerAsset, makingAmount: o.makingAmount.toString(), takingAmount: o.takingAmount.toString(), makerTraits: o.makerTraits.toString() }, signature: await maker.sign({ hash: built.orderHash }), extension: "0x" } };
  }
  const takerJit = async (ctx: HandlerContext, id: string) => {
    const r = await restingBuy();
    return runTool("cork_prepare_orders", { chainId: CHAIN, account: DEMO_ACCOUNT, clientRequestId: id, action: { type: "taker-fill", orderHash: r.orderHash, signedOrder: r.signedOrder, jitMarket: { ...JIT_TASK_PAIR, expiryTimestamp: EXPIRY, recipe: LIQUIDITY_RECIPE, constraint: JIT_TASK_CONSTRAINT } } }, ctx);
  };

  it("baseline: the interaction builds and its layout is verified through the stub adapter's decoder", async () => {
    const env = await takerJit(stubContext(), "tgate-0001");
    expect(env.state, JSON.stringify(env.warnings)).toBe("ok");
    expect((env.data as { jit: { extraDataLayout: string } }).jit.extraDataLayout).toContain("verified-on-chain");
  });

  it("a lying decoder refuses the fill bytes too (extra_data_layout_mismatch), naming the field", async () => {
    const ctx = wrapped((client) => ({
      readContract: async (a) => {
        const out = await client.readContract(a);
        if (a.functionName !== "decodeExtraData") return out;
        const [p, permits] = out as [Record<string, unknown>, unknown[]];
        return [{ ...p, enableJitMint: !(p.enableJitMint as boolean) }, permits];
      },
    }));
    const env = await takerJit(ctx, "tgate-0003");
    expect(env.state).toBe("conflict");
    expect(env.warnings[0]!.code).toBe("extra_data_layout_mismatch");
    expect((env.data as { differing: string[]; calldata?: unknown }).differing).toEqual(["enableJitMint"]);
    expect((env.data as { calldata?: unknown }).calldata).toBeUndefined();
  });

  it("off-list adapter code refuses the fill bytes too (conflict, implementation_not_approved)", async () => {
    const env = await takerJit(offListAdapter(), "tgate-0002");
    expect(env.state).toBe("conflict");
    expect(env.warnings[0]!.code).toBe("implementation_not_approved");
    expect((env.data as { calldata?: unknown }).calldata).toBeUndefined();
  });
});
