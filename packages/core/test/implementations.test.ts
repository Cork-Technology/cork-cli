// The approved-implementations guard (interface-first model): live runtime code is
// fingerprinted (keccak256 of eth_getCode == EXTCODEHASH) and compared against the config
// allowlist; proxy roles resolve the EIP-1967 implementation first, because a proxy's own code
// never changes on an upgrade. Hash EXPECTATIONS here are precomputed literals, independent of
// the implementation's own keccak call — a mutant that hashes the wrong bytes cannot
// tautologically agree with the test.
import { describe, expect, it } from "vitest";
import {
  approvedImplementationGuard,
  checkApprovedImplementations,
  EIP1967_IMPLEMENTATION_SLOT,
  implementationWarnings,
  parseDefaults,
  runTool,
  type CodeReader,
  type CorkDefaults,
} from "@cork/core";

const CODE_A = "0x6080604052" as const;
const HASH_A = "0x1c3374235d773b2189aed115aa13143020fcdbbe86e38f358cf3e4771b2f0244"; // keccak(CODE_A), precomputed
const CODE_B = "0xdeadbeef" as const;
const HASH_B = "0xd4fd4e189132273036449fc9e11198c739161b4c0116a9a2dccdfa1c492006f1"; // keccak(CODE_B), precomputed

const ADAPTER = "0x00000000000000000000000000000000000000a1" as `0x${string}`;
const WLM = "0x00000000000000000000000000000000000000b2" as `0x${string}`;
const IMPL = "0x00000000000000000000000000000000000000c3" as `0x${string}`;

function defaultsWith(approved: Record<string, { proxy?: "eip1967"; approved: string[] }>): CorkDefaults {
  return parseDefaults({
    schemaVersion: 1,
    updated: "2026-08-12",
    deployments: { "1": { poolManager: ADAPTER, constraintAdapter: ADAPTER, corkAdapter: ADAPTER, whitelistManager: WLM } },
    lopAddresses: {},
    approvedImplementations: { "1": approved },
  });
}

/** A realistic reader: per-address code map + a proxy slot table; records slot reads. */
function reader(codeByAddress: Record<string, `0x${string}`>, slots: Record<string, `0x${string}`> = {}, slotReads: Array<{ address: string; slot: string }> = []): CodeReader {
  return {
    getCode: async ({ address }) => codeByAddress[address.toLowerCase()] ?? "0x",
    getStorageAt: async ({ address, slot }) => {
      slotReads.push({ address, slot });
      return slots[address.toLowerCase()] ?? `0x${"00".repeat(32)}`;
    },
  };
}

describe("checkApprovedImplementations", () => {
  it("approves a direct role whose live code hashes onto the list — case-insensitively", async () => {
    const d = defaultsWith({ corkAdapter: { approved: [HASH_A.toUpperCase().replace("0X", "0x")] } });
    const checks = await checkApprovedImplementations(reader({ [ADAPTER]: CODE_A }), 1, { allowlist: d });
    // the config validator checksums addresses — compare case-insensitively
    expect(checks.map((c) => ({ ...c, address: c.address.toLowerCase() }))).toEqual([{ role: "corkAdapter", address: ADAPTER, codehash: HASH_A, verdict: "approved" }]);
    expect(implementationWarnings(checks)).toEqual([]);
  });

  it("flags a direct role whose live code hashes OFF the list, naming role and hash", async () => {
    const d = defaultsWith({ corkAdapter: { approved: [HASH_A] } });
    const checks = await checkApprovedImplementations(reader({ [ADAPTER]: CODE_B }), 1, { allowlist: d });
    expect(checks[0]!.verdict).toBe("not_approved");
    expect(checks[0]!.codehash).toBe(HASH_B);
    const warnings = implementationWarnings(checks);
    expect(warnings[0]!.code).toBe("implementation_not_approved");
    expect(warnings[0]!.message).toContain("corkAdapter");
    expect(warnings[0]!.message).toContain(HASH_B);
  });

  it("a proxy role fingerprints the IMPLEMENTATION named by the EIP-1967 slot, not the shell", async () => {
    const slotReads: Array<{ address: string; slot: string }> = [];
    const d = defaultsWith({ whitelistManager: { proxy: "eip1967", approved: [HASH_A] } });
    // The shell's own code (CODE_B) is deliberately off-list — only the implementation counts.
    const r = reader({ [WLM]: CODE_B, [IMPL]: CODE_A }, { [WLM]: `0x${"00".repeat(12)}${IMPL.slice(2)}` }, slotReads);
    const checks = await checkApprovedImplementations(r, 1, { allowlist: d });
    expect(checks).toEqual([{ role: "whitelistManager", address: WLM, implementation: IMPL, codehash: HASH_A, verdict: "approved" }]);
    // The slot is asserted as a LITERAL, not the exported constant — asserting the import would
    // mutate in lockstep with the code and see nothing (the impl-1967-slot-drift probe's kill).
    expect(slotReads).toEqual([{ address: WLM, slot: "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" }]);
    expect(EIP1967_IMPLEMENTATION_SLOT).toBe("0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc");
  });

  it("an EMPTY proxy slot is a positive finding (proxy_unresolved), an empty implementation account is no_code — both warn", async () => {
    const d = defaultsWith({ whitelistManager: { proxy: "eip1967", approved: [HASH_A] } });
    const emptySlot = await checkApprovedImplementations(reader({ [WLM]: CODE_B }), 1, { allowlist: d });
    expect(emptySlot[0]!.verdict).toBe("proxy_unresolved");
    const codeless = await checkApprovedImplementations(reader({ [WLM]: CODE_B }, { [WLM]: `0x${"00".repeat(12)}${IMPL.slice(2)}` }), 1, { allowlist: d });
    expect(codeless[0]!.verdict).toBe("no_code");
    expect(implementationWarnings([...emptySlot, ...codeless]).map((w) => w.code)).toEqual(["implementation_not_approved", "implementation_not_approved"]);
  });

  it("degrades to silence: a throwing read is unreadable (no warning); a client without getCode skips the guard; an unknown role is skipped", async () => {
    const d = defaultsWith({ corkAdapter: { approved: [HASH_A] }, notARole: { approved: [HASH_A] } });
    const throwing: CodeReader = { getCode: async () => { throw new Error("eth_getCode unsupported"); } };
    const checks = await checkApprovedImplementations(throwing, 1, { allowlist: d });
    expect(checks.map((c) => ({ ...c, address: c.address.toLowerCase() }))).toEqual([{ role: "corkAdapter", address: ADAPTER, verdict: "unreadable" }]); // notARole skipped
    expect(implementationWarnings(checks)).toEqual([]);
    expect(await checkApprovedImplementations({}, 1, { allowlist: d })).toEqual([]);
  });
});

describe("the guard inside a prepare (build-and-warn, like the pool pre-flight)", () => {
  it("cork_prepare_phoenix surfaces implementation_not_approved when a trusted role's live code is off-list — bytes still built", async () => {
    // Chain 1's BUNDLED allowlist is real (captured live); a stub whose code hashes elsewhere
    // must warn. The stub also serves the pool views the funded prepare reads.
    const client = {
      readContract: async ({ functionName }: { functionName: string }) => {
        if (functionName === "market") return { collateralAsset: ADAPTER, referenceAsset: WLM, expiryTimestamp: 9_999_999_999n, rateMin: 1n, rateMax: 1n, rateChangePerDayMax: 1n, rateChangeCapacityMax: 1n, rateOracle: ADAPTER };
        if (functionName === "shares") return [ADAPTER, WLM];
        throw new Error(`no stub for ${functionName}`);
      },
      getCode: async () => CODE_B, // hashes off every real allowlist entry
      getStorageAt: async () => `0x${"00".repeat(12)}${IMPL.slice(2)}`,
    };
    const env = await runTool(
      "cork_prepare_phoenix",
      { chainId: 1, account: ADAPTER, clientRequestId: "impl-guard-01", fundingMode: "erc20-approve", action: { type: "deposit", poolId: `0x${"11".repeat(32)}`, collateralAssetsIn: "1", receiver: ADAPTER, minCptAndCstSharesOut: "1" } },
      { nowSeconds: 1n, rpcUrl: "https://stub.example/rpc", resolveRpc: async () => ({ url: "https://stub.example/rpc", source: "explicit" as const, client: client as never }) },
    );
    expect(env.state).toBe("ok");
    const implWarnings = env.warnings.filter((w) => w.code === "implementation_not_approved");
    expect(implWarnings.length).toBeGreaterThan(0);
    expect(env.warnings.some((w) => w.message.includes("EIP-1967"))).toBe(true); // the proxy role resolved and flagged
  });

  it("approvedImplementationGuard never throws — a broken config path returns no warnings", async () => {
    expect(await approvedImplementationGuard({ getCode: async () => { throw new Error("boom"); } }, 424242)).toEqual([]);
  });
});
