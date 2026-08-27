// The trust split behind the approved-implementations guard (audit MCP-NET-001, 2026-08-24):
// ADDRESSES follow the resolved config (remote-first — an address may legitimately move), the
// ALLOWLIST follows only the copy bundled into this build. The two are exercised together
// through the real remote path: a local HTTP server serves a hostile cork-defaults.json that
// moves the mainnet adapter to an attacker contract AND admits that contract's code hash in
// its own allowlist. The bundle honors the moved address (that is remote-first working as
// designed) — and the guard still warns, because the hostile document was never the allowlist.
//
// No module is mocked: the config resolver fetches over the network, the guard hashes the
// bytes the stub RPC serves, and the prepare handler runs end to end.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAddress, keccak256 } from "viem";
import {
  BUNDLED_DEFAULTS,
  checkApprovedImplementations,
  implementationRoleAddress,
  JIT_IMPLEMENTATION_ROLES,
  LEGACY_JIT_IMPLEMENTATION_ROLES,
  parseDefaults,
  PHOENIX_IMPLEMENTATION_ROLES,
  PREPARE_MARKET_IMPLEMENTATION_ROLES,
  resetConfigMemo,
  resolveConfig,
  runTool,
  type CodeReader,
  type HandlerContext,
} from "@cork/core";
import { POOL_TOKENS } from "./helpers.ts";

const ATTACKER = "0x00000000000000000000000000000000000000ee" as const;
const CODE_ATTACK = "0x60806040aaaa" as const;
const HASH_ATTACK = keccak256(CODE_ATTACK);
const POOL = `0x${"11".repeat(32)}` as const;
const ACCOUNT = "0x00000000000000000000000000000000000000aa" as const;
const EIP1967_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

const MAINNET_ADAPTER = BUNDLED_DEFAULTS.deployments["1"]!.corkAdapter! as `0x${string}`;
const MAINNET_WLM = BUNDLED_DEFAULTS.deployments["1"]!.whitelistManager! as `0x${string}`;

/** The bundled defaults with the mainnet adapter moved to ATTACKER, whose code the document
 *  itself "approves" — what a tampered remote would look like after passing shape validation. */
function hostileDefaults(): Record<string, unknown> {
  const raw = JSON.parse(JSON.stringify(BUNDLED_DEFAULTS)) as {
    deployments: Record<string, Record<string, string>>;
    approvedImplementations: Record<string, Record<string, { approved: string[] }>>;
  };
  raw.deployments["1"]!.corkAdapter = getAddress(ATTACKER);
  raw.approvedImplementations["1"]!.corkAdapter = { approved: [HASH_ATTACK] };
  return raw;
}

/** A pool + code view: the pool views a funded prepare reads, code for whatever `codeAt`
 *  serves, no proxy slots (the whitelistManager check degrades to unreadable, by design). */
function chainRpc(codeAt: Record<string, `0x${string}`>, reads: { code: string[]; storage: string[] }): NonNullable<HandlerContext["resolveRpc"]> {
  return async () => ({
    url: "https://stub.example/rpc",
    source: "explicit" as const,
    client: {
      readContract: async ({ functionName }: { functionName: string }) => {
        switch (functionName) {
          case "market":
            return { collateralAsset: POOL_TOKENS.collateral, referenceAsset: POOL_TOKENS.reference, expiryTimestamp: 9_999_999_999n, rateMin: 1n, rateMax: 1n, rateChangePerDayMax: 1n, rateChangeCapacityMax: 1n, rateOracle: POOL_TOKENS.collateral };
          case "shares":
            return [POOL_TOKENS.cpt, POOL_TOKENS.cst];
          case "paused":
            return false;
          case "getPausedBitMap":
            return 0n;
          case "isWhitelisted":
            return true;
          default:
            throw new Error(`no stub for ${functionName}`);
        }
      },
      simulateContract: async () => ({ result: ATTACKER }),
      getCode: async ({ address }: { address: string }) => {
        reads.code.push(address.toLowerCase());
        return codeAt[address.toLowerCase()] ?? "0x";
      },
      getStorageAt: async ({ address, slot }: { address: string; slot: string }) => {
        reads.storage.push(`${address.toLowerCase()}:${slot}`);
        throw new Error("no proxy view in this stub");
      },
    } as never,
  });
}

describe("allowlist source vs address source", () => {
  const client: CodeReader = { getCode: async ({ address }) => (address.toLowerCase() === ATTACKER ? CODE_ATTACK : "0x") };

  it("the bundled allowlist judges the code behind an address the resolved config moved — the moved-to contract is NOT approved", async () => {
    const hostile = parseDefaults(hostileDefaults());
    const checks = await checkApprovedImplementations(client, 1, { allowlist: BUNDLED_DEFAULTS, roles: ["corkAdapter"], addresses: hostile });
    expect(checks).toHaveLength(1);
    expect(checks[0]!.address.toLowerCase()).toBe(ATTACKER); // address: from the resolved (hostile) config
    expect(checks[0]!.codehash).toBe(HASH_ATTACK);
    expect(checks[0]!.verdict).toBe("not_approved"); // allowlist: bundled — the hostile self-approval never counted
  });

  it("control: had the allowlist come from the same document as the address, the attacker would approve itself", async () => {
    const hostile = parseDefaults(hostileDefaults());
    const checks = await checkApprovedImplementations(client, 1, { allowlist: hostile, roles: ["corkAdapter"] });
    expect(checks[0]!.verdict).toBe("approved");
  });
});

describe("remote-first config + bundled allowlist, end to end", () => {
  let server: Server;
  let url: string;
  let cacheDir: string;
  const saved: Record<string, string | undefined> = {};

  beforeEach(async () => {
    for (const k of ["CORK_DEFAULTS_URL", "CORK_CONFIG_CACHE_FILE", "CORK_CONFIG_NO_FETCH"]) saved[k] = process.env[k];
    server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(hostileDefaults()));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no port");
    url = `http://127.0.0.1:${address.port}/cork-defaults.json`;
    cacheDir = mkdtempSync(join(tmpdir(), "cork-trust-"));
    process.env.CORK_DEFAULTS_URL = url;
    process.env.CORK_CONFIG_CACHE_FILE = join(cacheDir, "cache.json");
    delete process.env.CORK_CONFIG_NO_FETCH; // vitest pins offline mode globally; this test IS the network path
    resetConfigMemo();
  });

  afterEach(async () => {
    resetConfigMemo();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(cacheDir, { recursive: true, force: true });
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("a hostile remote that moves the adapter and 'approves' its code: the bundle follows the address, the guard still warns", async () => {
    const cfg = await resolveConfig();
    expect(cfg.source).toBe("github"); // the remote path really served — not the bundled fallback
    expect(cfg.defaults.deployments["1"]!.corkAdapter!.toLowerCase()).toBe(ATTACKER);

    const reads = { code: [] as string[], storage: [] as string[] };
    const env = await runTool(
      "cork_prepare_phoenix",
      { chainId: 1, account: ACCOUNT, clientRequestId: "trust-root-0001", fundingMode: "erc20-approve", action: { type: "deposit", poolId: POOL, collateralAssetsIn: "1", receiver: ACCOUNT, minCptAndCstSharesOut: "1" }, format: "concise" },
      { nowSeconds: 1n, rpcUrl: "https://stub.example/rpc", resolveRpc: chainRpc({ [ATTACKER]: CODE_ATTACK }, reads) },
    );
    expect(env.state).toBe("ok");
    // Remote-first is doing its job: an address change lands without a release. Which is
    // exactly why the allowlist must not come from the same document.
    expect((env.data as { corkAdapter: string }).corkAdapter.toLowerCase()).toBe(ATTACKER);
    const flagged = env.warnings.filter((w) => w.code === "implementation_not_approved");
    expect(flagged).toHaveLength(1);
    expect(flagged[0]!.message).toContain("corkAdapter");
    expect(flagged[0]!.message.toLowerCase()).toContain(ATTACKER);
    expect(flagged[0]!.message).toContain(HASH_ATTACK);
    expect(flagged[0]!.message).toContain("bundled into this build");
    // Build-and-warn: the bytes are still there for a signer who has verified the move.
    expect((env.data as { fundingLegs: number; multicall: string }).fundingLegs).toBe(1);
  });
});

describe("role scoping: each artifact path fingerprints only the contracts its bytes execute", () => {
  it("cork_prepare_phoenix reads the adapter and the whitelist proxy slot — never the registry or JIT adapter", async () => {
    const reads = { code: [] as string[], storage: [] as string[] };
    const env = await runTool(
      "cork_prepare_phoenix",
      { chainId: 1, account: ACCOUNT, clientRequestId: "scope-phoenix-0001", fundingMode: "erc20-approve", action: { type: "deposit", poolId: POOL, collateralAssetsIn: "1", receiver: ACCOUNT, minCptAndCstSharesOut: "1" }, format: "concise" },
      { nowSeconds: 1n, rpcUrl: "https://stub.example/rpc", resolveRpc: chainRpc({}, reads) },
    );
    expect(env.state).toBe("ok");
    expect(reads.code).toEqual([MAINNET_ADAPTER.toLowerCase()]);
    expect(reads.storage).toEqual([`${MAINNET_WLM.toLowerCase()}:${EIP1967_SLOT}`]);
    // The adapter answered "no code" (a positive finding) and warned; the proxy view threw
    // (unreadable) and stayed silent — both documented postures, in one call.
    const flagged = env.warnings.filter((w) => w.code === "implementation_not_approved");
    expect(flagged.map((w) => w.message)).toEqual([expect.stringContaining("corkAdapter")]);
  });

  it("cork_prepare_market reads only the registry", async () => {
    const reads = { code: [] as string[], storage: [] as string[] };
    const env = await runTool(
      "cork_prepare_market",
      { chainId: 42161, clientRequestId: "scope-market-0001", action: { type: "deploy-fixed-oracle", rate: "1000000000000000000" } },
      { nowSeconds: 1n, rpcUrl: "https://stub.example/rpc", resolveRpc: chainRpc({}, reads) },
    );
    expect(env.state).toBe("ok");
    const registry = implementationRoleAddress("marketRegistry", BUNDLED_DEFAULTS, 42161)!;
    expect(reads.code).toEqual([registry.toLowerCase()]);
    expect(reads.storage).toEqual([]);
    expect(env.warnings.filter((w) => w.code === "implementation_not_approved").map((w) => w.message)).toEqual([expect.stringContaining("marketRegistry")]);
  });

  it("the scope constants name exactly the contracts each path executes", () => {
    expect(PHOENIX_IMPLEMENTATION_ROLES).toEqual(["corkAdapter", "whitelistManager"]);
    expect(PREPARE_MARKET_IMPLEMENTATION_ROLES).toEqual(["marketRegistry"]);
    expect(JIT_IMPLEMENTATION_ROLES).toEqual(["jitAdapter", "marketRegistry"]);
    expect(LEGACY_JIT_IMPLEMENTATION_ROLES).toEqual(["legacyJitAdapter", "legacyMarketRegistry"]);
  });

  it("an explicit role filter is honored by the checker itself, whatever the allowlist names", async () => {
    const reader: CodeReader = { getCode: async () => "0x" };
    const all = await checkApprovedImplementations(reader, 42161, { allowlist: BUNDLED_DEFAULTS });
    expect(all.map((c) => c.role).sort()).toEqual(["corkAdapter", "jitAdapter", "legacyJitAdapter", "legacyMarketRegistry", "marketRegistry", "whitelistManager"]);
    const scoped = await checkApprovedImplementations(reader, 42161, { allowlist: BUNDLED_DEFAULTS, roles: ["marketRegistry"] });
    expect(scoped.map((c) => c.role)).toEqual(["marketRegistry"]);
  });
});

describe("the deprecated generation is held to the same standard", () => {
  it("legacy roles resolve from marketRegistryLegacy and are allowlisted with the live Arbitrum code hashes", async () => {
    // Hashes recomputed on 2026-08-26 from live Arbitrum bytecode: keccak256(eth_getCode).
    expect(implementationRoleAddress("legacyJitAdapter", BUNDLED_DEFAULTS, 42161)).toBe("0xea15BF1E5565181Ed8678CcFf39D797272858505");
    expect(implementationRoleAddress("legacyMarketRegistry", BUNDLED_DEFAULTS, 42161)).toBe("0xF674488bf4643e205ccd826951e8b0d29f77600A");
    const chain = BUNDLED_DEFAULTS.approvedImplementations!["42161"]!;
    expect(chain.legacyJitAdapter!.approved).toEqual(["0x60ce947daf8a8db2b1eb581903bcc74caef76488a4849cc4a0427a3e9606e9d1"]);
    expect(chain.legacyMarketRegistry!.approved).toEqual(["0x0fc7787ec85619dfc68dab244ac8e3b0696672b3ce7c5a14609c07129d69cb0c"]);
    // A chain without a legacy generation resolves nothing for those roles — skipped, no warning.
    expect(implementationRoleAddress("legacyJitAdapter", BUNDLED_DEFAULTS, 8453)).toBeUndefined();
    const reader: CodeReader = { getCode: async () => "0x" };
    expect(await checkApprovedImplementations(reader, 8453, { allowlist: BUNDLED_DEFAULTS, roles: LEGACY_JIT_IMPLEMENTATION_ROLES })).toEqual([]);
    const legacy = await checkApprovedImplementations(reader, 42161, { allowlist: BUNDLED_DEFAULTS, roles: LEGACY_JIT_IMPLEMENTATION_ROLES });
    expect(legacy.map((c) => [c.role, c.verdict]).sort()).toEqual([["legacyJitAdapter", "no_code"], ["legacyMarketRegistry", "no_code"]]);
  });
});
