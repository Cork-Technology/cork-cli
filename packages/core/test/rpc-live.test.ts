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

// End-to-end 2.1.0 parity: our chain-native registry reads (built-in Arbitrum RPC) vs the live
// market-registry read API (sandbox). The API comparison is best-effort — if the sandbox is
// unreachable we still assert our own derivation is coherent, but do not fail the run on the
// external dependency. Every route below was hand-verified 2026-08-03 (fixtures in the session
// scratchpad); these tests keep that parity from silently regressing.
describe.skipIf(!LIVE)("2.1.0 registry — live parity vs the market-registry read API", () => {
  const CA = "0x211Cc4DD073734dA055fbF44a2b4667d5E5fE5d2"; // sUSDe (registered on Arbitrum)
  const REF = "0xdDb46999F8891663a8F2828d25298f70416d7610"; // sUSDS (registered on Arbitrum)
  const LIQ = "0xA39d552802b2D3A9be6F5DCDD2C6961DaeD1234D"; // LiquidityRecipe (approved)
  const ANCHOR_ARGS = `0x${(10n ** 18n).toString(16).padStart(64, "0")}`; // abi.encode(1e18)
  const API = process.env.CORK_MARKET_API ?? "https://zian-b.feat.cork.tech";

  const apiGet = async <T>(path: string): Promise<T | undefined> => {
    try {
      const res = await fetch(`${API}${path}`);
      return res.ok ? ((await res.json()) as T) : undefined;
    } catch {
      return undefined; // sandbox down — self-consistency assertions still ran
    }
  };
  const apiPost = async <T>(path: string, body: unknown): Promise<T | undefined> => {
    try {
      const res = await fetch(`${API}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      return res.ok ? ((await res.json()) as T) : undefined;
    } catch {
      return undefined;
    }
  };

  it("our configured registry matches GET /v1/registries (address + contracts_version 2.1.0)", async () => {
    const { resolveMarketRegistry } = await import("@cork/core");
    const { marketRegistry: mr } = await resolveMarketRegistry(42161);
    expect(mr?.contractsVersion).toBe("2.1.0");
    const api = await apiGet<{ registries: Array<{ chain_id: number; registry: string; contracts_version: string }> }>("/v1/registries");
    if (!api) return;
    const row = api.registries.find((r) => r.chain_id === 42161);
    expect(row?.registry.toLowerCase()).toBe(mr!.registry.toLowerCase());
    expect(row?.contracts_version).toBe(mr!.contractsVersion);
  }, 30_000);

  it("registry-assets matches GET /v1/42161/assets (same address set)", async () => {
    const ours = await runTool("cork_query", { chainId: 42161, resource: "registry-assets", format: "concise" }, { nowSeconds: 1_790_000_000n });
    expect(ours.state).toBe("ok");
    const ourAddrs = ((ours.data as { items: Array<{ address: string }> }).items.map((i) => i.address.toLowerCase())).sort();
    const api = await apiGet<{ items: Array<{ address: string }> }>("/v1/42161/assets");
    if (!api) return;
    expect(ourAddrs).toEqual(api.items.map((i) => i.address.toLowerCase()).sort());
  }, 60_000);

  it("resolve-recipe matches POST /v1/42161/resolve wei-for-wei (liquidity + anchor)", async () => {
    const ours = await runTool(
      "cork_compute",
      { chainId: 42161, params: { kind: "resolve-recipe", recipe: LIQ, collateralAsset: CA, referenceAsset: REF, args: ANCHOR_ARGS }, format: "concise" },
      { nowSeconds: 1_790_000_000n },
    );
    expect(ours.state).toBe("ok");
    const oc = (ours.data as { constraint: Record<string, string> }).constraint;
    const api = await apiPost<{ constraint: Record<string, { raw: string }> }>("/v1/42161/resolve", { recipe: LIQ, collateral_asset: CA, reference_asset: REF, args: ANCHOR_ARGS });
    if (!api) return;
    expect(oc["rateMin"]).toBe(api.constraint["rate_min"]!.raw);
    expect(oc["rateMax"]).toBe(api.constraint["rate_max"]!.raw);
    expect(oc["rateChangePerDayMax"]).toBe(api.constraint["rate_change_per_day_max"]!.raw);
    expect(oc["rateChangeCapacityMax"]).toBe(api.constraint["rate_change_capacity_max"]!.raw);
  }, 60_000);

  it("market-predict matches POST /v1/42161/market/predict (oracle address; identity when both derive one)", async () => {
    const ours = await runTool(
      "cork_query",
      { chainId: 42161, resource: "market-predict", filters: { collateralAsset: CA, referenceAsset: REF, expiry: "1900000000", recipe: LIQ, args: ANCHOR_ARGS }, format: "concise" },
      { nowSeconds: 1_790_000_000n },
    );
    expect(ours.state).toBe("ok");
    const od = ours.data as { oracle: { address: string; deployed: boolean; rate?: string }; market: { poolId: string; exists: boolean } | null; shares: { corkSwapToken: string; corkPrincipalToken: string } | null };
    const api = await apiPost<{ oracle: { address: string; deployed: boolean; rate: { raw: string } | null }; market: { pool_id: string; exists: boolean } | null; shares: { shares_token: string; principal_token: string } | null }>(
      "/v1/42161/market/predict",
      { recipe: LIQ, collateral_asset: CA, reference_asset: REF, expiry: "1900000000", args: ANCHOR_ARGS },
    );
    if (!api) return;
    expect(od.oracle.address.toLowerCase()).toBe(api.oracle.address.toLowerCase());
    expect(od.oracle.deployed).toBe(api.oracle.deployed);
    // Identity is rate-conditioned pre-creation; only compare when both derived one on the same rate.
    if (od.market && api.market && od.oracle.rate === api.oracle.rate?.raw) {
      expect(od.market.poolId).toBe(api.market.pool_id);
      expect(od.market.exists).toBe(api.market.exists);
      if (od.shares && api.shares) {
        expect(od.shares.corkSwapToken.toLowerCase()).toBe(api.shares.shares_token.toLowerCase());
        expect(od.shares.corkPrincipalToken.toLowerCase()).toBe(api.shares.principal_token.toLowerCase());
      }
    }
  }, 90_000);
});
