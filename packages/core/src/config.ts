// Deployed Cork addresses (mainnet / chainId 1; the Tenderly vnet forks mainnet so they match).
// Verified against notes/research/cork-contracts-domain.md + Sourcify (C10). These are defaults;
// production callers should re-verify via CREATE2 (create2.ts) before trusting them.
import type { CorkAddresses } from "./chain/reads.ts";

export interface CorkDeployment extends CorkAddresses {
  corkAdapter: `0x${string}`;
  bundler3: `0x${string}`;
  whitelistManager: `0x${string}`;
}

export const MAINNET_DEPLOYMENT: CorkDeployment = {
  poolManager: "0xccCCcCcCCccCfAE2Ee43F0E727A8c2969d74B9eC",
  constraintAdapter: "0xCCcCcCcccCccEF378949D1a61ED2283C831AF03A",
  corkAdapter: "0xCCcCcCCCcccCBaD6F772a511B337d9CCc9570407",
  bundler3: "0x6566194141eefa99Af43Bb5Aa71460Ca2Dc90245",
  whitelistManager: "0xcCccCcCccCC6e38a2772Eb42D2f408eeB89cb0eE",
};

export const DEPLOYMENTS: Record<number, CorkDeployment> = {
  1: MAINNET_DEPLOYMENT,
};

export function deploymentFor(chainId: number): CorkDeployment | undefined {
  return DEPLOYMENTS[chainId];
}
