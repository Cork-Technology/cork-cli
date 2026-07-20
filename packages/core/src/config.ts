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
import bundledDefaults from "../../../cork-defaults.json";

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
 * CREATE2 attestations: (salt from phoenix config/prod.toml [sepolia.bytes32]) + (initCodeHash =
 * keccak of the Sourcify creation bytecode) → the deployed address. Verified empirically: cast
 * reproduces `expected` from these exact inputs (see create2 verify test). Lets any caller
 * independently re-derive the address instead of trusting a hardcoded value [C10].
 */
export interface Create2Attestation {
  name: string;
  salt: `0x${string}`;
  initCodeHash: `0x${string}`;
  expected: `0x${string}`;
}

export const CREATE2_ATTESTATIONS: Create2Attestation[] = [
  {
    name: "corkAdapter",
    salt: "0x212fafd35b277528fa898ceaadcc917285f4666e2a87556d583e345956860f7d",
    initCodeHash: "0x2e1204abee27192079350f3f17779da88e1940a2ac222eb9f3e5a66060f682cb",
    expected: "0xCCcCcCCCcccCBaD6F772a511B337d9CCc9570407",
  },
];
