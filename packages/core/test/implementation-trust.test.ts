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
  CREATE_POOL_IMPLEMENTATION_ROLES,
  generationsOf,
  implementationRoleAddress,
  IMPLEMENTATION_ROLES,
  JIT_IMPLEMENTATION_ROLES,
  marketRegistryForWire,
  parseDefaults,
  primaryOf,
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

const MAINNET = primaryOf(generationsOf(BUNDLED_DEFAULTS, 1))!;
const MAINNET_ADAPTER = MAINNET.phoenix!.corkAdapter! as `0x${string}`;
const MAINNET_WLM = MAINNET.phoenix!.whitelistManager! as `0x${string}`;
const ARBITRUM = generationsOf(BUNDLED_DEFAULTS, 42161);

/** The bundled defaults with the mainnet adapter moved to ATTACKER, whose code the document
 *  itself "approves" — what a tampered remote would look like after passing shape validation. */
function hostileDefaults(): Record<string, unknown> {
  const raw = JSON.parse(JSON.stringify(BUNDLED_DEFAULTS)) as {
    generations: Record<string, { primary: string; sets: Record<string, { phoenix: Record<string, string> }> }>;
    approvedImplementations: Record<string, Record<string, { approved: string[] }>>;
  };
  raw.generations["1"]!.sets["mainnet"]!.phoenix.corkAdapter = getAddress(ATTACKER);
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
    expect(cfg.defaults.generations["1"]!.sets["mainnet"]!.phoenix!.corkAdapter!.toLowerCase()).toBe(ATTACKER);

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
    // The registry-bound paths bind the PRIMARY (nested-wire) generation since stage 2a; the
    // flat set's registry is a different address and is NOT read by a default prepare.
    const registry = implementationRoleAddress("marketRegistry", primaryOf(ARBITRUM))!;
    expect(registry.toLowerCase()).not.toBe(implementationRoleAddress("marketRegistry", marketRegistryForWire(ARBITRUM, "flat"))!.toLowerCase());
    expect(reads.code).toEqual([registry.toLowerCase()]);
    expect(reads.storage).toEqual([]);
    expect(env.warnings.filter((w) => w.code === "implementation_not_approved").map((w) => w.message)).toEqual([expect.stringContaining("marketRegistry")]);
  });

  it("the scope constants name exactly the contracts each path executes (no legacy role names since 0.6)", () => {
    expect(IMPLEMENTATION_ROLES).toEqual(["corkAdapter", "whitelistManager", "marketRegistry", "jitAdapter", "marketCreator"]);
    expect(PHOENIX_IMPLEMENTATION_ROLES).toEqual(["corkAdapter", "whitelistManager"]);
    expect(PREPARE_MARKET_IMPLEMENTATION_ROLES).toEqual(["marketRegistry"]);
    expect(JIT_IMPLEMENTATION_ROLES).toEqual(["jitAdapter", "marketRegistry"]);
    expect(CREATE_POOL_IMPLEMENTATION_ROLES).toEqual(["marketCreator", "marketRegistry"]);
  });

  it("an explicit role filter is honored by the checker itself, whatever the allowlist names", async () => {
    const reader: CodeReader = { getCode: async () => "0x" };
    const all = await checkApprovedImplementations(reader, 42161, { allowlist: BUNDLED_DEFAULTS });
    expect(all.map((c) => c.role).sort()).toEqual(["corkAdapter", "jitAdapter", "marketCreator", "marketRegistry", "whitelistManager"]);
    const scoped = await checkApprovedImplementations(reader, 42161, { allowlist: BUNDLED_DEFAULTS, roles: ["marketRegistry"] });
    expect(scoped.map((c) => c.role)).toEqual(["marketRegistry"]);
  });
});

describe("roles resolve INSIDE the selected generation; the allowlist is the union of every generation's code", () => {
  const reader: CodeReader = { getCode: async () => "0x" };
  const primary = primaryOf(ARBITRUM)!;
  const flat = ARBITRUM.find((g) => g.label === "phoenix/v0.3-rc.1")!;
  const legacy = marketRegistryForWire(ARBITRUM, "legacy")!;

  it("implementationRoleAddress answers the generation it is given — phoenix roles from its phoenix block, registry roles from its marketRegistry block", () => {
    expect(implementationRoleAddress("corkAdapter", primary)).toBe("0x71eB628c3A40FB3896613804847840426f9284A7");
    expect(implementationRoleAddress("corkAdapter", flat)).toBe("0xfa8A94046f0bC16Da683Aa8219bd960FDAF572AD");
    expect(implementationRoleAddress("marketRegistry", primary)).toBe("0xe1f569f152bDB6eBB2d49cFd9d4aB98ECEe955c5");
    expect(implementationRoleAddress("marketRegistry", flat)).toBe("0xa78d8137B01058dD23e545b6557209eBBc9611F1");
    expect(implementationRoleAddress("jitAdapter", legacy)).toBe("0xea15BF1E5565181Ed8678CcFf39D797272858505");
    expect(implementationRoleAddress("marketRegistry", legacy)).toBe("0xF674488bf4643e205ccd826951e8b0d29f77600A");
    // A generation without the block, an unknown role, no generation at all: nothing, never a guess.
    expect(implementationRoleAddress("marketCreator", legacy)).toBeUndefined();
    expect(implementationRoleAddress("marketRegistry", ARBITRUM.find((g) => g.label === "arbitrum-legacy"))).toBeUndefined();
    expect(implementationRoleAddress("bundler3", primary)).toBeUndefined();
    expect(implementationRoleAddress("corkAdapter", undefined)).toBeUndefined();
  });

  it("the checker fingerprints the SELECTED generation's addresses (primary by default), and an unknown label fingerprints nothing", async () => {
    const byDefault = await checkApprovedImplementations(reader, 42161, { allowlist: BUNDLED_DEFAULTS, roles: JIT_IMPLEMENTATION_ROLES });
    expect(byDefault.map((c) => [c.role, c.address.toLowerCase()]).sort()).toEqual([["jitAdapter", "0x3e01c558fc0854e92e6ef2a84c19d6bf9d82b104"], ["marketRegistry", "0xe1f569f152bdb6ebb2d49cfd9d4ab98ecee955c5"]]);
    const flatChecks = await checkApprovedImplementations(reader, 42161, { allowlist: BUNDLED_DEFAULTS, roles: JIT_IMPLEMENTATION_ROLES, generation: "phoenix/v0.3-rc.1" });
    expect(flatChecks.map((c) => [c.role, c.address.toLowerCase()]).sort()).toEqual([["jitAdapter", "0x8902a88912a334263fe3d731d03c267715b9374f"], ["marketRegistry", "0xa78d8137b01058dd23e545b6557209ebbc9611f1"]]);
    const legacyChecks = await checkApprovedImplementations(reader, 42161, { allowlist: BUNDLED_DEFAULTS, roles: JIT_IMPLEMENTATION_ROLES, generation: "arbitrum-v1.1" });
    expect(legacyChecks.map((c) => [c.role, c.verdict]).sort()).toEqual([["jitAdapter", "no_code"], ["marketRegistry", "no_code"]]);
    expect(await checkApprovedImplementations(reader, 42161, { allowlist: BUNDLED_DEFAULTS, roles: JIT_IMPLEMENTATION_ROLES, generation: "no-such-generation" })).toEqual([]);
    // Base has no legacy generation — the same label resolves nothing there.
    expect(await checkApprovedImplementations(reader, 8453, { allowlist: BUNDLED_DEFAULTS, roles: JIT_IMPLEMENTATION_ROLES, generation: "arbitrum-v1.1" })).toEqual([]);
  });

  it("the per-chain allowlist admits every generation's live code hash under ONE role name (union; hashes cross-checked against the Distribution records 2026-09-22)", () => {
    const chain = BUNDLED_DEFAULTS.approvedImplementations!["42161"]!;
    expect(chain.marketRegistry!.approved).toEqual([
      "0x455b91170500a48e745346e799831271e709da030ef3a05016b33d3200106a26", // 0.5.0
      "0xcd625f21c50005aa8b8e0a6f72ebd3385d062bc975f32f90f6d5fc914ed9b284", // 0.3.3
      "0x0fc7787ec85619dfc68dab244ac8e3b0696672b3ce7c5a14609c07129d69cb0c", // pre-2.1.0 (legacy)
    ]);
    expect(chain.jitAdapter!.approved).toEqual([
      "0x2fe70bacb5c81095f8ba03bdb1eeb4f6d1969787d82e140f5c8642f77f52d35a",
      "0x5b6c36ca1be5a6187bd76ba759b0c6514bc1519af4d15030b90d16f884650320",
      "0x60ce947daf8a8db2b1eb581903bcc74caef76488a4849cc4a0427a3e9606e9d1",
    ]);
    expect(chain.corkAdapter!.approved).toEqual(["0xc8c05b7eb9f80d0207025ecb09beefaf046965e4ee81c8476513109be47b81f6", "0x097673dfa72affbbf3e6f3858e4a80c88fc9e5c52d1a7a5f3906b213a9da621a"]);
    expect(chain.whitelistManager).toEqual({ proxy: "eip1967", approved: ["0xc3757fe479d4a44aa3a3954159ba1281747b6de0dc78a58139390bfd9c2f4cb0", "0x538475aa44f636c9446b60cd79513d7b0f655cac2917c58cb3efb9ae89c49d07"] });
    expect(chain.marketCreator!.approved).toEqual(["0x2fde0d65ebd999c5bb7202f80a8dd1f8b0bc86b405237c93ea4a096e88c08766", "0x2f7dd61e18e4d3ca5d432771ee2eeb7000b3e609f26c151eb57dc147e5310287"]);
    expect(chain).not.toHaveProperty("legacyJitAdapter");
    expect(chain).not.toHaveProperty("legacyMarketRegistry");
    // Base never hosted the pre-2.1.0 generation: two hashes per registry role, not three.
    expect(BUNDLED_DEFAULTS.approvedImplementations!["8453"]!.marketRegistry!.approved).toHaveLength(2);
  });
});
