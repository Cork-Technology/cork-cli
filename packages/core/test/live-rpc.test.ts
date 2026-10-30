import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetExplicitVerification, resetRpcInflight } from "@cork/core";
import { readUnreportedLoss } from "../src/chain/nav-loss.ts";
import { configuredCheck, requiredLiveRpcUrl, resolveConfiguredRpc, runConfiguredTool } from "./live-rpc.ts";

const CHAINS = [1, 42161, 8453] as const;
const HASH: `0x${string}` = `0x${"ab".repeat(32)}`;
const TOKEN = "0x1111111111111111111111111111111111111111";
const REVERT = "0x12345678";
const endpoint = (chainId: number) => `https://SYNTHETIC_USER:SYNTHETIC_PASSWORD@chain-${chainId}.fixture.invalid/SYNTHETIC_PATH%2FKEY?token=SYNTHETIC_QUERY%2BKEY`;
const canonical = (input: string) => { const url = new URL(input); url.username = ""; url.password = ""; return url.href; };
let calls: Array<{ chainId: number; method: string }>;
let wrongChain: boolean;
let revert: boolean;

beforeEach(() => {
  calls = [];
  wrongChain = false;
  revert = false;
  resetExplicitVerification();
  resetRpcInflight();
  for (const chainId of CHAINS) vi.stubEnv(`CORK_TEST_RPC_URL_${chainId}`, undefined);
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const chainId = CHAINS.find((chain) => canonical(endpoint(chain)) === canonical(url));
    if (chainId === undefined) throw new Error("Configured RPC fixture refuses all other transport");
    const body = JSON.parse(String(init?.body)) as { id: number; method: string };
    calls.push({ chainId, method: body.method });
    if (body.method === "eth_call" && revert) return Response.json({ jsonrpc: "2.0", id: body.id, error: { code: 3, message: `execution reverted: ${endpoint(chainId)}`, data: REVERT } });
    const result = body.method === "eth_chainId" ? `0x${(wrongChain ? 42161 : chainId).toString(16)}` :
      body.method === "eth_blockNumber" ? "0x7b" :
      body.method === "eth_getTransactionReceipt" ? {
        transactionHash: HASH, transactionIndex: "0x0", blockHash: HASH, blockNumber: `0x${(chainId + 100).toString(16)}`,
        gasUsed: "0x5208", cumulativeGasUsed: "0x5208", status: "0x1", logs: [], logsBloom: `0x${"00".repeat(256)}`,
        from: TOKEN, to: TOKEN, contractAddress: null, type: "0x0",
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

const track = (chainId: number) => runConfiguredTool("cork_track", {
  chainId, mode: "reconcile", subject: { kind: "txHash", txHash: HASH }, format: "full",
});

describe("configured live RPC coverage — offline", () => {
  it.each([undefined, "", " \t "])("fails closed for missing/blank values %j before any transport", async (value) => {
    vi.stubEnv("CORK_RPC_URL", endpoint(1));
    vi.stubEnv("CORK_RPC_URL_8453", endpoint(8453));
    for (const chainId of CHAINS) {
      vi.stubEnv(`CORK_TEST_RPC_URL_${chainId}`, value);
      await expect(configuredCheck(() => resolveConfiguredRpc(chainId))).rejects.toThrow(`requires nonblank CORK_TEST_RPC_URL_${chainId}`);
      await expect(track(chainId)).rejects.toThrow(`requires nonblank CORK_TEST_RPC_URL_${chainId}`);
    }
    expect(calls).toEqual([]);
  });

  it("cannot borrow another chain's test secret", async () => {
    vi.stubEnv("CORK_TEST_RPC_URL_42161", endpoint(42161));
    expect(() => requiredLiveRpcUrl(8453)).toThrow("requires nonblank CORK_TEST_RPC_URL_8453");
    expect(calls).toEqual([]);
  });

  it.each(CHAINS)("chain %i: verifies the configured endpoint and independently reads the same receipt as the handler", async (chainId) => {
    vi.stubEnv(`CORK_TEST_RPC_URL_${chainId}`, endpoint(chainId));
    vi.stubEnv("CORK_RPC_URL", "https://must-not-be-used.fixture.invalid");
    const raw = await resolveConfiguredRpc(chainId);
    expect(raw.source).toBe("explicit");
    expect(await raw.client.getChainId()).toBe(chainId);
    const receipt = await raw.client.getTransactionReceipt({ hash: HASH });
    const env = await track(chainId);
    expect(receipt.blockNumber).toBe(BigInt(chainId + 100));
    expect(env).toMatchObject({ state: "ok", data: { blockNumber: receipt.blockNumber.toString(), status: "success" } });
    expect(calls.every((call) => call.chainId === chainId)).toBe(true);
    expect(JSON.stringify(env)).not.toMatch(/SYNTHETIC_|PATH|QUERY|PASSWORD/);
  });

  it("refuses a wrong-chain configured endpoint without borrowing another secret or public RPC", async () => {
    vi.stubEnv("CORK_TEST_RPC_URL_8453", endpoint(8453));
    vi.stubEnv("CORK_TEST_RPC_URL_42161", endpoint(42161));
    wrongChain = true;
    await expect(configuredCheck(() => resolveConfiguredRpc(8453))).rejects.toThrow("Configured live RPC check failed");
    await expect(configuredCheck(() => track(8453))).rejects.toThrow("Configured live RPC check failed");
    expect(calls).toEqual([{ chainId: 8453, method: "eth_chainId" }, { chainId: 8453, method: "eth_chainId" }]);
  });

  it("keeps real viem revert classification and raw selector data inside the test body", async () => {
    vi.stubEnv("CORK_TEST_RPC_URL_8453", endpoint(8453));
    revert = true;
    await configuredCheck(async () => {
      const { client } = await resolveConfiguredRpc(8453);
      expect(await readUnreportedLoss(client, TOKEN)).toEqual({ status: "absent" });
      const error: unknown = await client.call({ to: TOKEN, data: "0x12345678" }).catch((err: unknown) => err);
      let data: unknown;
      for (let current = error; current && typeof current === "object"; current = "cause" in current ? current.cause : undefined) {
        if ("data" in current && typeof current.data === "string") { data = current.data; break; }
      }
      expect(data).toBe(REVERT);
    });
  });

  it("redacts actual secret-bearing viem failures only after the full check, including normalized userinfo/path/query", async () => {
    vi.stubEnv("CORK_TEST_RPC_URL_8453", endpoint(8453));
    revert = true;
    const { client } = await resolveConfiguredRpc(8453);
    const raw: unknown = await client.call({ to: TOKEN, data: "0x12345678" }).catch((error: unknown) => error);
    expect(String(raw)).toContain("SYNTHETIC_"); // positive control: a raw diagnostic really would leak
    const safe: unknown = await configuredCheck(() => { throw raw; }).catch((error: unknown) => error);
    expect(safe).toBeInstanceOf(Error);
    expect(String(safe)).toContain("Configured live RPC check failed");
    expect([String(safe), (safe as Error).stack, JSON.stringify(safe)].join("\n")).not.toMatch(/SYNTHETIC|fixture\.invalid|PATH|QUERY|KEY|cause/);
  });

  it("still fails an assertion rather than turning configured coverage green", async () => {
    await expect(configuredCheck(() => expect(1).toBe(2))).rejects.toThrow("Configured live RPC check failed (AssertionError)");
  });
});
