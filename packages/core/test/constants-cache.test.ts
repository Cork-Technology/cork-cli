// Long-TTL contract-constants cache: the module that retires replicated contract literals
// (MAX_FEE_PERCENTAGE, maxExpiryDuration, controller role hashes). Tests opt IN to persistence
// with CORK_CONST_CACHE_FILE — under vitest without it the cache is deliberately a no-op, so
// every other suite keeps its exact pre-cache read patterns (and never touches ~/.cache).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTool } from "@cork/core";
import { CONSTANT_TTL_MS, cachedContractConstant, cachedContractConstantBytes32, refreshContractConstant, resetConstantsCacheForTests } from "../src/chain/constants-cache.ts";
import { jitValueGate, maxExpiryBoundWarning, resolveFeeCap } from "../src/handlers/jit.ts";

const ADDR = "0x0aCccE0ef90da8b8d95DBFeE2ADaaED9b566586C" as const;
const WAD = 10n ** 18n;

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cork-const-cache-"));
  file = join(dir, "contract-constants.json");
  process.env.CORK_CONST_CACHE_FILE = file;
  resetConstantsCacheForTests();
});
afterEach(() => {
  delete process.env.CORK_CONST_CACHE_FILE;
  resetConstantsCacheForTests();
  rmSync(dir, { recursive: true, force: true });
});

const seed = (entries: Record<string, { v: string; ts: number }>) => writeFileSync(file, JSON.stringify(entries));
const clientOf = (handler: () => unknown) => ({ readContract: async () => handler() }) as never;

describe("cachedContractConstant (sync read: memory → disk, TTL-checked)", () => {
  it("answers a fresh entry and refuses one past the TTL", () => {
    const now = 1_000_000_000_000;
    seed({
      [`8453:${ADDR.toLowerCase()}:MAX_FEE_PERCENTAGE`]: { v: (3n * WAD).toString(), ts: now - 1 },
      [`8453:${ADDR.toLowerCase()}:maxExpiryDuration`]: { v: "2592000", ts: now - CONSTANT_TTL_MS - 1 },
    });
    expect(cachedContractConstant(8453, ADDR, "MAX_FEE_PERCENTAGE", now)).toBe(3n * WAD);
    expect(cachedContractConstant(8453, ADDR, "maxExpiryDuration", now)).toBeUndefined(); // stale
    expect(cachedContractConstant(8453, ADDR, "never_written", now)).toBeUndefined();
  });

  it("keys on the CHAIN too — identical CREATE2 addresses across chains must not share values", () => {
    const now = 1_000_000_000_000;
    seed({
      [`8453:${ADDR.toLowerCase()}:x`]: { v: "1", ts: now },
      [`42161:${ADDR.toLowerCase()}:x`]: { v: "2", ts: now },
    });
    expect(cachedContractConstant(8453, ADDR, "x", now)).toBe(1n);
    expect(cachedContractConstant(42161, ADDR, "x", now)).toBe(2n);
  });

  it("renders bytes32 values zero-padded (role hashes)", () => {
    const now = 1_000_000_000_000;
    seed({ [`8453:${ADDR.toLowerCase()}:ROLE`]: { v: "0x4066b03ab177190abcd4de6384e71f7a60f56b879537b65d43a0523ade6cfe52", ts: now } });
    expect(cachedContractConstantBytes32(8453, ADDR, "ROLE", now)).toBe("0x4066b03ab177190abcd4de6384e71f7a60f56b879537b65d43a0523ade6cfe52");
  });
});

describe("refreshContractConstant (async best-effort: read once per TTL, keep stale on failure)", () => {
  it("a fresh cache costs NO read; a stale one reads live and persists", async () => {
    const now = 1_000_000_000_000;
    let reads = 0;
    const client = clientOf(() => {
      reads++;
      return 7n * WAD;
    });
    seed({ [`8453:${ADDR.toLowerCase()}:MAX_FEE_PERCENTAGE`]: { v: (5n * WAD).toString(), ts: now - 1 } });
    expect(await refreshContractConstant(client, 8453, ADDR, "MAX_FEE_PERCENTAGE", "uint256", now)).toBe(5n * WAD);
    expect(reads).toBe(0);
    resetConstantsCacheForTests();
    seed({ [`8453:${ADDR.toLowerCase()}:MAX_FEE_PERCENTAGE`]: { v: (5n * WAD).toString(), ts: now - CONSTANT_TTL_MS - 1 } });
    expect(await refreshContractConstant(client, 8453, ADDR, "MAX_FEE_PERCENTAGE", "uint256", now)).toBe(7n * WAD);
    expect(reads).toBe(1);
    const stored = JSON.parse(readFileSync(file, "utf8")) as Record<string, { v: string; ts: number }>;
    expect(stored[`8453:${ADDR.toLowerCase()}:MAX_FEE_PERCENTAGE`]).toEqual({ v: (7n * WAD).toString(), ts: now });
  });

  it("a failed read keeps the STALE value alive (it answered from this chain once); a never-answered key stays undefined", async () => {
    const now = 1_000_000_000_000;
    const failing = clientOf(() => {
      throw new Error("rpc down");
    });
    seed({ [`8453:${ADDR.toLowerCase()}:maxExpiryDuration`]: { v: "2592000", ts: now - CONSTANT_TTL_MS - 1 } });
    expect(await refreshContractConstant(failing, 8453, ADDR, "maxExpiryDuration", "uint256", now)).toBe(2_592_000n);
    expect(await refreshContractConstant(failing, 8453, ADDR, "never_answered", "uint256", now)).toBeUndefined();
  });

  it("single-flights concurrent refreshes of one key", async () => {
    let reads = 0;
    const client = clientOf(() => {
      reads++;
      return 1n;
    });
    const [a, b] = await Promise.all([
      refreshContractConstant(client, 8453, ADDR, "maxExpiryDuration"),
      refreshContractConstant(client, 8453, ADDR, "maxExpiryDuration"),
    ]);
    expect(a).toBe(1n);
    expect(b).toBe(1n);
    expect(reads).toBe(1);
  });

  it("without the env opt-in under vitest the cache is a NO-OP: refresh reads live but never persists, sync reads answer nothing", async () => {
    delete process.env.CORK_CONST_CACHE_FILE;
    resetConstantsCacheForTests();
    let reads = 0;
    const client = clientOf(() => {
      reads++;
      return 9n;
    });
    expect(await refreshContractConstant(client, 8453, ADDR, "maxExpiryDuration")).toBe(9n);
    expect(await refreshContractConstant(client, 8453, ADDR, "maxExpiryDuration")).toBe(9n);
    expect(reads).toBe(2); // read-per-call — the exact pre-cache behavior every other suite relies on
    expect(cachedContractConstant(8453, ADDR, "maxExpiryDuration")).toBeUndefined();
  });
});

describe("consumers read the chain's value through the cache, with the compiled literal as FALLBACK only", () => {
  const ctx = { nowSeconds: 1n };

  it("jitValueGate enforces the LIVE cap when one is supplied — a 4% fee passes the compiled 5e18 but refuses at a cached 3e18, message naming the live cap", () => {
    const fee = 4n * WAD;
    expect(jitValueGate(42161, ctx, fee, 0n, 100n, 1n)).toBeUndefined(); // fallback cap 5e18
    const gate = jitValueGate(42161, ctx, fee, 0n, 100n, 1n, { capWei: 3n * WAD });
    expect(gate?.state).toBe("unavailable");
    expect(gate?.warnings[0]?.message).toContain("capped at 3e18 (3%)");
  });

  it("resolveFeeCap: cold cache → the compiled 5e18; warm cache → the chain's own value", async () => {
    expect(await resolveFeeCap(42161, "adapter")).toBe(5n * WAD);
    // Warm the adapter's entry (config resolves the adapter address for 42161).
    const { resolveMarketRegistry } = await import("@cork/core");
    const { marketRegistry: mr } = await resolveMarketRegistry(42161);
    seed({ [`42161:${mr!.adapter!.toLowerCase()}:MAX_FEE_PERCENTAGE`]: { v: (3n * WAD).toString(), ts: Date.now() } });
    resetConstantsCacheForTests();
    expect(await resolveFeeCap(42161, "adapter")).toBe(3n * WAD);
    // The creator's cap is keyed on the CREATOR address — the adapter's entry must not answer it.
    expect(await resolveFeeCap(42161, "creator")).toBe(5n * WAD);
  });

  it("a warm cache lets maxExpiryBoundWarning warn even when the chain read fails", async () => {
    seed({ [`42161:${ADDR.toLowerCase()}:maxExpiryDuration`]: { v: "3600", ts: Date.now() } });
    const failing = clientOf(() => {
      throw new Error("rpc down");
    });
    const w = await maxExpiryBoundWarning(failing, 42161, ADDR, 1_790_010_000n, 1_790_000_000n);
    expect(w?.code).toBe("would_revert");
    expect(w?.message).toContain("ExpiryOutOfRange");
  });

  it("end-to-end: a maker-order jitMarket fee legal under 5e18 refuses once the ADAPTER's cached live cap says 3e18", async () => {
    const { resolveMarketRegistry } = await import("@cork/core");
    const { marketRegistry: mr } = await resolveMarketRegistry(42161);
    seed({ [`42161:${mr!.adapter!.toLowerCase()}:MAX_FEE_PERCENTAGE`]: { v: (3n * WAD).toString(), ts: Date.now() } });
    const env = await runTool(
      "cork_prepare_orders",
      {
        chainId: 42161,
        account: "0xc0ffee0000000000000000000000000000000001",
        clientRequestId: "const-cache-e2e-01",
        action: {
          type: "maker-order",
          poolId: `0x${"11".repeat(32)}`,
          side: "SELL",
          makerAsset: "0x211Cc4DD073734dA055fbF44a2b4667d5E5fE5d2",
          takerAsset: "0xdDb46999F8891663a8F2828d25298f70416d7610",
          makingAmount: "1000000000000000000",
          takingAmount: "1000000",
          jitMarket: {
            collateralAsset: "0x211Cc4DD073734dA055fbF44a2b4667d5E5fE5d2",
            referenceAsset: "0xdDb46999F8891663a8F2828d25298f70416d7610",
            expiryTimestamp: "1795000000",
            recipe: "0xb881DB48ad6DA84a8F0D1cE4150Caf7Ae016Dc55",
            swapFeePercentage: (4n * WAD).toString(),
            constraint: { rateMin: "1", rateMax: "2000000000000000000", rateChangePerDayMax: "1", rateChangeCapacityMax: "1" },
          },
        },
      },
      { nowSeconds: 1_790_000_000n, resolveRpc: async () => null },
    );
    expect(env.state).toBe("unavailable");
    expect(env.warnings[0]?.code).toBe("invalid_order_terms");
    expect(env.warnings[0]?.message).toContain("capped at 3e18 (3%)");
  });
});
