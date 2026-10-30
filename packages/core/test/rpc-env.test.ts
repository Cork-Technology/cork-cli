// Exercise real dispatch, explicit verification and transport; no external endpoint is contacted.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetExplicitVerification, resetRpcInflight, runTool, ToolInputError } from "@cork/core";

const HASH = `0x${"ab".repeat(32)}`;
const BASE = "https://base.fixture.invalid/private-base?token=SYNTHETIC_BASE_SECRET";
const ARB = "https://arb.fixture.invalid/private-arb?token=SYNTHETIC_ARB_SECRET";
const GLOBAL = "https://global.fixture.invalid/private-global";
const OVERRIDE = "https://override.fixture.invalid/private-override";
const endpoints = new Map<string, { chainId: number | null; block: number; fail?: boolean }>();
let calls: Array<{ endpoint: string; method: string }>;
const track = (chainId: number, rpcUrl?: string) => runTool("cork_track", {
  chainId, mode: "reconcile", subject: { kind: "txHash", txHash: HASH }, format: "full",
}, rpcUrl === undefined ? {} : { rpcUrl });

beforeEach(() => {
  endpoints.clear();
  calls = [];
  resetExplicitVerification();
  resetRpcInflight();
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const endpoint = request.url;
    const body = await request.json() as { id: number; method: string };
    calls.push({ endpoint, method: body.method });
    const fixture = endpoints.get(endpoint);
    if (!fixture) throw new Error("External transport denied by RPC env fixture");
    if (fixture.fail) throw new Error("Synthetic transport failure");
    const result = body.method === "eth_chainId" ? (fixture.chainId === null ? null : `0x${fixture.chainId.toString(16)}`) :
      body.method === "eth_getTransactionReceipt" ? {
        transactionHash: HASH, transactionIndex: "0x0", blockHash: HASH,
        blockNumber: `0x${fixture.block.toString(16)}`, gasUsed: "0x5208", cumulativeGasUsed: "0x5208",
        status: "0x1", logs: [], logsBloom: `0x${"00".repeat(256)}`,
        from: `0x${"11".repeat(20)}`, to: `0x${"22".repeat(20)}`, contractAddress: null, type: "0x0",
      } : null;
    return Response.json({ jsonrpc: "2.0", id: body.id, result });
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  resetExplicitVerification();
  resetRpcInflight();
});

function configured() {
  endpoints.set(BASE, { chainId: 8453, block: 101 });
  endpoints.set(ARB, { chainId: 42161, block: 202 });
  vi.stubEnv("CORK_RPC_URL_8453", BASE);
  vi.stubEnv("CORK_RPC_URL_42161", ARB);
}

describe("private per-chain RPC env through core dispatch", () => {
  it("routes concurrent Base and Arbitrum reads without cross-chain reuse or secret-bearing output", async () => {
    configured();
    const [base, arb] = await Promise.all([track(8453), track(42161)]);
    expect(base).toMatchObject({ state: "ok", data: { blockNumber: "101", status: "success" }, provenance: { rpc: { source: "explicit", host: "base.fixture.invalid" } } });
    expect(arb).toMatchObject({ state: "ok", data: { blockNumber: "202", status: "success" }, provenance: { rpc: { source: "explicit", host: "arb.fixture.invalid" } } });
    expect(calls).toEqual(expect.arrayContaining([
      { endpoint: BASE, method: "eth_chainId" }, { endpoint: BASE, method: "eth_getTransactionReceipt" },
      { endpoint: ARB, method: "eth_chainId" }, { endpoint: ARB, method: "eth_getTransactionReceipt" },
    ]));
    expect(JSON.stringify([base, arb])).not.toMatch(/SYNTHETIC_|private-base|private-arb/);
  });

  it("keeps context overrides above chain env, and chain env above global", async () => {
    configured();
    endpoints.set(GLOBAL, { chainId: 8453, block: 303 });
    endpoints.set(OVERRIDE, { chainId: 8453, block: 404 });
    vi.stubEnv("CORK_RPC_URL", GLOBAL);
    expect((await track(8453, OVERRIDE)).data).toMatchObject({ blockNumber: "404" });
    expect((await track(8453)).data).toMatchObject({ blockNumber: "101" });
    expect(calls.some((c) => c.endpoint === GLOBAL)).toBe(false);
  });

  it.each(["", "   "])("treats blank chain env %j as absent and preserves global-only routing", async (blank) => {
    endpoints.set(GLOBAL, { chainId: 8453, block: 303 });
    vi.stubEnv("CORK_RPC_URL_8453", blank);
    vi.stubEnv("CORK_RPC_URL", `  ${GLOBAL}  `);
    expect((await track(8453)).data).toMatchObject({ blockNumber: "303" });
  });

  it("reads changed environment on the next call and verifies the new endpoint", async () => {
    configured();
    expect((await track(8453)).data).toMatchObject({ blockNumber: "101" });
    endpoints.set(OVERRIDE, { chainId: 8453, block: 404 });
    vi.stubEnv("CORK_RPC_URL_8453", OVERRIDE);
    expect((await track(8453)).data).toMatchObject({ blockNumber: "404" });
    expect(calls.filter((c) => c.method === "eth_chainId")).toEqual([
      { endpoint: BASE, method: "eth_chainId" }, { endpoint: OVERRIDE, method: "eth_chainId" },
    ]);
  });

  it("does not borrow another chain suffix or a blank global for a private chain", async () => {
    configured();
    vi.stubEnv("CORK_RPC_URL", "  ");
    const result = await track(49222);
    expect(result).toMatchObject({ state: "unavailable" });
    expect(result.warnings.some((w) => w.code === "requires_rpc")).toBe(true);
    expect(calls).toEqual([]);
  });

  it.each([
    { chainId: 42161, block: 101 },
    { chainId: null, block: 101 },
    { chainId: 8453, block: 101, fail: true },
  ])("refuses configured mismatch or unverified transport without fallback: %j", async (fixture) => {
    vi.stubEnv("CORK_RPC_URL_8453", BASE);
    endpoints.set(BASE, fixture);
    const error = await track(8453).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ToolInputError);
    expect(JSON.stringify(error)).not.toMatch(/SYNTHETIC_BASE_SECRET|private-base/);
    expect(calls).toEqual([{ endpoint: BASE, method: "eth_chainId" }]);
  });

  it("re-probes after an outage instead of caching failure", async () => {
    vi.stubEnv("CORK_RPC_URL_8453", BASE);
    endpoints.set(BASE, { chainId: 8453, block: 101, fail: true });
    await expect(track(8453)).rejects.toBeInstanceOf(ToolInputError);
    endpoints.set(BASE, { chainId: 8453, block: 101 });
    expect((await track(8453)).data).toMatchObject({ blockNumber: "101" });
    expect(calls.filter((c) => c.method === "eth_chainId")).toHaveLength(2);
  });

  it("does not fall through an explicitly supplied whitespace override", async () => {
    configured();
    await expect(track(8453, "   ")).rejects.toBeInstanceOf(ToolInputError);
    expect(calls.some((c) => c.endpoint === BASE)).toBe(false);
  });
});
