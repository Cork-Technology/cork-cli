// Deployed Cork addresses per chain. A deployment always carries the two read-path contracts
// (poolManager + constraintAdapter — enough for query/compute/track); the tx-path contracts
// (corkAdapter/bundler3) and whitelistManager are optional because not every chain's deployment
// is fully known/verified yet — handlers gate per-capability with an honest `unknown_deployment`
// rather than pretending. Production callers should re-verify via CREATE2 (create2.ts) where an
// attestation exists.
import type { CorkAddresses } from "./chain/reads.ts";

export interface CorkDeployment extends CorkAddresses {
  corkAdapter?: `0x${string}`;
  bundler3?: `0x${string}`;
  whitelistManager?: `0x${string}`;
}

// Addresses live in the canonical `cork-defaults.json` at the repo root — the runtime fetches the
// latest copy from GitHub (config-remote.ts) and this bundled copy is the distribution fallback.
// Source files carry NO address literals. Provenance of the current values: chain 1 verified via
// Sourcify + CREATE2 (C10); chain 42161 read-path empirically derived 2026-07-17 (Cork API
// poolManagerAddress + debug_traceCall calibration for the constraintAdapter; tx-path contracts
// unknown → omitted, handlers gate per capability).
import bundledDefaults from "../../../cork-defaults.json" with { type: "json" };

const bundledDeployments = bundledDefaults.deployments as Record<string, CorkDeployment>;

export const MAINNET_DEPLOYMENT: Required<CorkDeployment> = bundledDeployments["1"] as Required<CorkDeployment>;
export const ARBITRUM_DEPLOYMENT: CorkDeployment = bundledDeployments["42161"]!;

export const DEPLOYMENTS: Record<number, CorkDeployment> = Object.fromEntries(
  Object.entries(bundledDeployments).map(([k, v]) => [Number(k), v]),
);

export function deploymentFor(chainId: number): CorkDeployment | undefined {
  return DEPLOYMENTS[chainId];
}

/** Safe Singleton Factory — the CREATE2 deployer for Cork's cross-chain-identical addresses. */
export const CREATE2_DEPLOYER = "0x914d7Fec6aaC8cd542e72Bca78B30650d45643d7" as const;

/**
 * CREATE2 attestations: (deployer, salt, initCodeHash) → the deployed address. Verified
 * empirically: local keccak reproduces `expected` from these exact inputs (see create2 verify
 * test). Lets any caller independently re-derive the address instead of trusting a hardcoded
 * value [C10]. `deployer` defaults to the Safe Singleton Factory; the market-registry 0.3.2 set
 * was deployed by the AtomicDeployer in ONE guarded-CREATE2 batch — for those entries `salt` is
 * the EFFECTIVE CREATE2 salt keccak256(abi.encodePacked(guardSender, rawSalt)), and the guard
 * inputs are recorded so the derivation is reproducible from the deploy calldata alone.
 */
export interface Create2Attestation {
  name: string;
  salt: `0x${string}`;
  initCodeHash: `0x${string}`;
  expected: `0x${string}`;
  /** CREATE2 deployer; omitted = CREATE2_DEPLOYER (the Safe Singleton Factory). */
  deployer?: `0x${string}`;
  /** AtomicDeployer guard provenance: salt = keccak256(abi.encodePacked(guardSender, rawSalt)). */
  guard?: { rawSalt: `0x${string}`; guardSender: `0x${string}` };
}

export const CREATE2_ATTESTATIONS: Create2Attestation[] = [
  {
    name: "corkAdapter",
    salt: "0x212fafd35b277528fa898ceaadcc917285f4666e2a87556d583e345956860f7d",
    initCodeHash: "0x2e1204abee27192079350f3f17779da88e1940a2ac222eb9f3e5a66060f682cb",
    expected: "0xCCcCcCCCcccCBaD6F772a511B337d9CCc9570407",
  },
  // MarketRegistry 0.3.2 set (42161 block 491971103 / 8453 block 49648442 — identical
  // addresses, ONE AtomicDeployer batch per chain with identical inputs) — extracted from the
  // deploy broadcast (market-registry-private tag 0.3.2). The AtomicDeployer itself is Safe-
  // Singleton-Factory CREATE2 (salt ++ initCode calldata); the eight protocol contracts are
  // CREATE2 FROM the AtomicDeployer under ONE guarded salt: keccak256(abi.encodePacked(
  // deploySender, rawSalt)) — the anti-squatting guard in script/AtomicDeployer.sol. Every
  // entry locally re-derived and matched against BOTH chains' live addresses 2026-08-07.
  {
    name: "atomicDeployer",
    salt: "0x5d09d5a707ed9b8aeb40ee5f544b4846deabaf6c6559bc3356d3a4387960d3a9",
    initCodeHash: "0xf71b94e19de5f98f8ced603caa2a4953479ae71e87f018dc3bc24429027ff448",
    expected: "0x24a6C14D772E5931621A1DBe4BfeA0f6d7e681B2",
  },
  {
    name: "marketRegistry",
    deployer: "0x24a6C14D772E5931621A1DBe4BfeA0f6d7e681B2",
    salt: "0x7b721a223f31d0949286963ca6cec2713d81dd1a43a9510206b4d7ff4adb943c",
    guard: { rawSalt: "0x5d09d5a707ed9b8aeb40ee5f544b4846deabaf6c6559bc3356d3a4387960d3a9", guardSender: "0xE6E7437088bc0A9c29b5147AA13c1aB24541782a" },
    initCodeHash: "0x30c197c6fec24ca9bb19afbed9d36753cab192be627853d26489e3c3df8241ac",
    expected: "0xF5323F305360A792284814a7EDe78c2209A1DC94",
  },
  {
    name: "corkLimitOrderAdapter",
    deployer: "0x24a6C14D772E5931621A1DBe4BfeA0f6d7e681B2",
    salt: "0x7b721a223f31d0949286963ca6cec2713d81dd1a43a9510206b4d7ff4adb943c",
    guard: { rawSalt: "0x5d09d5a707ed9b8aeb40ee5f544b4846deabaf6c6559bc3356d3a4387960d3a9", guardSender: "0xE6E7437088bc0A9c29b5147AA13c1aB24541782a" },
    initCodeHash: "0x92a5ea42b19652513c11203e4a6e32881cc33b77ff41c6f59db7800a7e933d89",
    expected: "0x1b754F17EDd87784b01542aAe0e4CA672CFdc7CE",
  },
  {
    name: "wrapperRateConsumerFactory",
    deployer: "0x24a6C14D772E5931621A1DBe4BfeA0f6d7e681B2",
    salt: "0x7b721a223f31d0949286963ca6cec2713d81dd1a43a9510206b4d7ff4adb943c",
    guard: { rawSalt: "0x5d09d5a707ed9b8aeb40ee5f544b4846deabaf6c6559bc3356d3a4387960d3a9", guardSender: "0xE6E7437088bc0A9c29b5147AA13c1aB24541782a" },
    initCodeHash: "0x9f7d017bc7ba9128c4ab4246dce99fd10de9611f0e0955a7247ab1e08afdb225",
    expected: "0xF64c9d502531Cd87f9CB2994092FB56d02a21812",
  },
  {
    name: "fixedRateOracleFactory",
    deployer: "0x24a6C14D772E5931621A1DBe4BfeA0f6d7e681B2",
    salt: "0x7b721a223f31d0949286963ca6cec2713d81dd1a43a9510206b4d7ff4adb943c",
    guard: { rawSalt: "0x5d09d5a707ed9b8aeb40ee5f544b4846deabaf6c6559bc3356d3a4387960d3a9", guardSender: "0xE6E7437088bc0A9c29b5147AA13c1aB24541782a" },
    initCodeHash: "0x2bc263ef45c96cfc64807511369b436baa56cdf256f32390564e6f33801dc02a",
    expected: "0x7766d44d40329B3e15302531eb4C0D2578031Acb",
  },
  {
    name: "aggregatorAdapterFactory",
    deployer: "0x24a6C14D772E5931621A1DBe4BfeA0f6d7e681B2",
    salt: "0x7b721a223f31d0949286963ca6cec2713d81dd1a43a9510206b4d7ff4adb943c",
    guard: { rawSalt: "0x5d09d5a707ed9b8aeb40ee5f544b4846deabaf6c6559bc3356d3a4387960d3a9", guardSender: "0xE6E7437088bc0A9c29b5147AA13c1aB24541782a" },
    initCodeHash: "0x41055e120e8153a192624fc07ab38327cb481b814855b7b960a523de61f03224",
    expected: "0xf2aa4c2FEA4e6e0FF8de30C07C4f54fC86A93BbB",
  },
  {
    name: "liquidityPriceRecipe",
    deployer: "0x24a6C14D772E5931621A1DBe4BfeA0f6d7e681B2",
    salt: "0x7b721a223f31d0949286963ca6cec2713d81dd1a43a9510206b4d7ff4adb943c",
    guard: { rawSalt: "0x5d09d5a707ed9b8aeb40ee5f544b4846deabaf6c6559bc3356d3a4387960d3a9", guardSender: "0xE6E7437088bc0A9c29b5147AA13c1aB24541782a" },
    initCodeHash: "0xdefdfe13fd8c98cf3bcc959b37b8a57b1594177e47424b020b9a1210ea1a4612",
    expected: "0xD27c7BB8564Db019B41d9C48d1ABCEd9A7d90291",
  },
  {
    name: "liquidityNavRecipe",
    deployer: "0x24a6C14D772E5931621A1DBe4BfeA0f6d7e681B2",
    salt: "0x7b721a223f31d0949286963ca6cec2713d81dd1a43a9510206b4d7ff4adb943c",
    guard: { rawSalt: "0x5d09d5a707ed9b8aeb40ee5f544b4846deabaf6c6559bc3356d3a4387960d3a9", guardSender: "0xE6E7437088bc0A9c29b5147AA13c1aB24541782a" },
    initCodeHash: "0xa9c19c296b017a6d7d7fe156a12b0519814556e5f1cabd5f9a6bd2a41f94fb26",
    expected: "0x1cF1ef3F0d2f59Bf26A373ce7Dcf0F88612C1506",
  },
  {
    name: "fixedRateRecipe",
    deployer: "0x24a6C14D772E5931621A1DBe4BfeA0f6d7e681B2",
    salt: "0x7b721a223f31d0949286963ca6cec2713d81dd1a43a9510206b4d7ff4adb943c",
    guard: { rawSalt: "0x5d09d5a707ed9b8aeb40ee5f544b4846deabaf6c6559bc3356d3a4387960d3a9", guardSender: "0xE6E7437088bc0A9c29b5147AA13c1aB24541782a" },
    initCodeHash: "0x9edfd2059bfb00e96739ef0b4297b1d73588a0d761f82f15c93aab3bb217f31e",
    expected: "0x6d838136bbbE7D34Ce8dDDc431Ce1bB4A1F9D98D",
  },
];
