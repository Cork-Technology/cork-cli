// Live smoke for the RPC resolver against the real network. Self-skips unless CORK_RPC_LIVE=1 so
// CI stays offline/deterministic. Proves end-to-end: the committed default resolves and answers, and
// a chain with NO committed default (Base 8453) falls back to a real chainlist public RPC.
import { describe, expect, it } from "vitest";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveRpc, runTool } from "@cork/core";

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
    // Self-contained: point the resolver at a fresh temp cache file (the test previously assumed
    // the runner exported CORK_RPC_CACHE_FILE, so existsSync(undefined) always read false).
    const cacheFile = join(tmpdir(), `cork-rpc-cache-${process.pid}-${Date.now()}.json`);
    const prev = process.env.CORK_RPC_CACHE_FILE;
    process.env.CORK_RPC_CACHE_FILE = cacheFile;
    try {
      rmSync(cacheFile, { force: true });
      await resolveRpc(1, undefined);
      expect(existsSync(cacheFile)).toBe(true);
    } finally {
      rmSync(cacheFile, { force: true });
      if (prev === undefined) delete process.env.CORK_RPC_CACHE_FILE;
      else process.env.CORK_RPC_CACHE_FILE = prev;
    }
  }, 30_000);
});

// End-to-end parity: our chain-native market-predict (built-in Arbitrum RPC) vs the live
// market-registry read API. The API comparison is best-effort — if the sandbox is unreachable we
// still assert our own derivation is coherent, but do not fail the run on the external dependency.
interface ApiPredict {
  oracle: { address: string; deployed: boolean; rate: string | null };
  market: { pool_id: string; exists: boolean } | null;
  shares: { shares_token: string; principal_token: string } | null;
}
describe.skipIf(!LIVE)("cork_query market-predict — live parity vs the market-registry read API", () => {
  const CA = "0x211Cc4DD073734dA055fbF44a2b4667d5E5fE5d2"; // sUSDe (registered on Arbitrum)
  const REF = "0x7F6501d3B98eE91f9b9535E4b0ac710Fb0f9e0bc"; // waArbUSDCn
  const API = process.env.CORK_MARKET_API ?? "https://zian-b.feat.cork.tech";

  it("matches the API oracle (always) + pool_id & cST/cPT (when both saw the same rate step)", async () => {
    const ours = await runTool(
      "cork_query",
      { chainId: 42161, resource: "market-predict", filters: { collateralAsset: CA, referenceAsset: REF, expiry: "1900000000", mode: "liquidity" }, format: "concise" },
      { nowSeconds: 1_790_000_000n },
    );
    expect(ours.state).toBe("ok");
    const od = ours.data as { oracle: { address: string; deployed: boolean; rate: string }; market: { poolId: string; exists: boolean }; shares: { corkSwapToken: string; corkPrincipalToken: string } | null };
    expect(od.oracle.deployed).toBe(true);
    expect(od.market.poolId).toMatch(/^0x[0-9a-f]{64}$/);

    let api: ApiPredict | undefined;
    try {
      const res = await fetch(`${API}/v1/42161/market/predict?collateralAsset=${CA.toLowerCase()}&referenceAsset=${REF.toLowerCase()}&expiry=1900000000&mode=liquidity`);
      if (res.ok) api = (await res.json()) as ApiPredict;
    } catch { /* sandbox down — keep the self-consistency assertions above, skip the cross-check */ }
    if (!api) return;

    expect(od.oracle.address.toLowerCase()).toBe(api.oracle.address.toLowerCase());
    // pool_id / shares are rate-conditioned; only identical when both calls landed on the same rate.
    if (od.oracle.rate === api.oracle.rate && api.market) {
      expect(od.market.poolId).toBe(api.market.pool_id);
      expect(od.market.exists).toBe(api.market.exists);
      if (od.shares && api.shares) {
        expect(od.shares.corkSwapToken.toLowerCase()).toBe(api.shares.shares_token.toLowerCase());
        expect(od.shares.corkPrincipalToken.toLowerCase()).toBe(api.shares.principal_token.toLowerCase());
      }
    }
  }, 90_000);
});
