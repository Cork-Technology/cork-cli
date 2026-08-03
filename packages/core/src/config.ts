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
  // MarketRegistry 2.1.0 set (Arbitrum One, block 489540043) — extracted from the deploy
  // broadcast (market-registry-api @ a929458, contracts tag 2.1.0): one global salt
  // (config/deployment.toml) across all seven contracts, each deployed as a Safe-Singleton-
  // Factory CALL carrying salt ++ initCode. initCodeHash = keccak of the broadcast's raw init
  // code (creation bytecode ++ abi-encoded constructor args; the MarketRegistry creation
  // bytecode is byte-identical to the repo's pinned artifact). Every entry locally re-derived
  // and matched against the live address 2026-08-03 — the guard that matters here, because the
  // PREVIOUS registry generation still answers 2.1.0-shaped calls with misdecoded garbage.
  {
    name: "marketRegistry",
    salt: "0x6160b6f62415f62bf2aba6b76e3ba35b84b38d39acce87a9d84ea17c1f1c07ef",
    initCodeHash: "0x8f00d5974b2a67f9deff93a2aa8736dc65f53c92f328645c5c54b84d8e6effca",
    expected: "0x47C3AF38435Db64D9400c30575E4c10482c0752D",
  },
  {
    name: "corkLimitOrderAdapter",
    salt: "0x6160b6f62415f62bf2aba6b76e3ba35b84b38d39acce87a9d84ea17c1f1c07ef",
    initCodeHash: "0x1faa890d96aa499bc8443ec3623caa1b3e2c386e58dd700abb355576cb473d0a",
    expected: "0x230758CB5d5B222091A6ac3c1d557Cd395cDd65B",
  },
  {
    name: "wrapperRateConsumerFactory",
    salt: "0x6160b6f62415f62bf2aba6b76e3ba35b84b38d39acce87a9d84ea17c1f1c07ef",
    initCodeHash: "0xf0e2e2ae81bfd800019dc457f2570b5ee3117e83ca4c28a00c6d00c998f60334",
    expected: "0xDb8bd7eEA5322Df5c6c079c7D11C1b27F56e2007",
  },
  {
    name: "fixedRateOracleFactory",
    salt: "0x6160b6f62415f62bf2aba6b76e3ba35b84b38d39acce87a9d84ea17c1f1c07ef",
    initCodeHash: "0xca113bcfe0d99e2f4ee3f4a759ca7fa375f7896b74d6481d016b3190a081da7e",
    expected: "0xE899a11994eC6b8B50A1F7cbfD546fd260BbB0c5",
  },
  {
    name: "aggregatorAdapterFactory",
    salt: "0x6160b6f62415f62bf2aba6b76e3ba35b84b38d39acce87a9d84ea17c1f1c07ef",
    initCodeHash: "0x397a81563982f52d45fb670653a897c8bb0e9ef2b34a2e76f4fba95f353eff96",
    expected: "0xB1d34dca3c63CCEF1239D0432Bedcf4031c172c2",
  },
  {
    name: "liquidityRecipe",
    salt: "0x6160b6f62415f62bf2aba6b76e3ba35b84b38d39acce87a9d84ea17c1f1c07ef",
    initCodeHash: "0x652104243f9b8bf6124fbb9217bacccd244d3ebf39d50686c2613e2722c6f8d3",
    expected: "0xA39d552802b2D3A9be6F5DCDD2C6961DaeD1234D",
  },
  {
    name: "fixedRateRecipe",
    salt: "0x6160b6f62415f62bf2aba6b76e3ba35b84b38d39acce87a9d84ea17c1f1c07ef",
    initCodeHash: "0xc02b880184834fb0c7906af45fd67f33ac5732495aa57ab4a130e7b06d4d98c7",
    expected: "0xA85cFa6E66f301a18D182A8304f5C4afEf5b4682",
  },
];
