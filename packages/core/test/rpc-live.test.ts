// Live smoke for the RPC resolver against the real network. Self-skips unless CORK_RPC_LIVE=1 so
// CI stays offline/deterministic. Proves end-to-end: the committed default resolves and answers, and
// a chain with NO committed default (Base 8453) falls back to a real chainlist public RPC.
import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { resolveRpc } from "@cork/core";

const LIVE = process.env.CORK_RPC_LIVE === "1";

describe.skipIf(!LIVE)("resolveRpc — live", () => {
  it("chain 1 uses the committed default and the client answers eth_chainId=1", async () => {
    const r = await resolveRpc(1, undefined);
    expect(r).not.toBeNull();
    expect(r!.source).toBe("default");
    expect(await r!.client.getChainId()).toBe(1);
  }, 30_000);

  it("chain 8453 (no default) falls back to a chainlist public RPC answering eth_chainId=8453", async () => {
    const r = await resolveRpc(8453, undefined);
    expect(r).not.toBeNull();
    expect(r!.source).toBe("chainlist");
    expect(await r!.client.getChainId()).toBe(8453);
  }, 60_000);

  it("chain 49222 (staging vnet, not on chainlist) resolves to null without an explicit RPC", async () => {
    expect(await resolveRpc(49222, undefined)).toBeNull();
  }, 15_000);

  it("persists an on-disk cache", async () => {
    await resolveRpc(1, undefined);
    expect(existsSync(process.env.CORK_RPC_CACHE_FILE!)).toBe(true);
  }, 30_000);
});
