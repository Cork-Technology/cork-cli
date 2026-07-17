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

// Chain 1. Verified against notes/research/cork-contracts-domain.md + Sourcify (C10); corkAdapter
// re-derivable via CREATE2 (CREATE2_ATTESTATIONS below). The Tenderly vnet forks mainnet, so these
// match there too.
export const MAINNET_DEPLOYMENT: Required<CorkDeployment> = {
  poolManager: "0xccCCcCcCCccCfAE2Ee43F0E727A8c2969d74B9eC",
  constraintAdapter: "0xCCcCcCcccCccEF378949D1a61ED2283C831AF03A",
  corkAdapter: "0xCCcCcCCCcccCBaD6F772a511B337d9CCc9570407",
  bundler3: "0x6566194141eefa99Af43Bb5Aa71460Ca2Dc90245",
  whitelistManager: "0xcCccCcCccCC6e38a2772Eb42D2f408eeB89cb0eE",
};

// Chain 42161 — partial (read path only). Empirically derived 2026-07-17:
//  - poolManager from the Cork API (api-phoenix.cork.tech/v1/pools?chainId=42161 →
//    poolManagerAddress), code verified on-chain (ERC-1967 proxy, same shape as mainnet).
//  - constraintAdapter discovered by debug_traceCall of PM.swapRate(poolId): on mainnet the
//    identical call-tree position is the known adapter (0xCCcC…F03A), on Arbitrum it is this
//    address (proxy → impl 0x64ecde96…, same delegate pattern). Code verified on-chain.
//  - corkAdapter/bundler3/whitelistManager: NOT yet discoverable (mainnet vanity addresses have no
//    code on Arbitrum; no whitelist-enabled pools or bundler flows exist to trace). Left unset →
//    prepare_phoenix and pool-whitelist on 42161 gate with `unknown_deployment` until sourced.
export const ARBITRUM_DEPLOYMENT: CorkDeployment = {
  poolManager: "0xc2De56fb1C7a85250ce69C37B4773767C77954AE",
  constraintAdapter: "0x798CB4Bd8066BAeF149Cf89AED71507B334bF20E",
};

export const DEPLOYMENTS: Record<number, CorkDeployment> = {
  1: MAINNET_DEPLOYMENT,
  42161: ARBITRUM_DEPLOYMENT,
};

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
