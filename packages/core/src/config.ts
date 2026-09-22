// Deployed Cork addresses per chain — ONE generation's phoenix block (generations.ts). A
// deployment always carries the two read-path contracts (poolManager + constraintAdapter —
// enough for query/compute/track) and its WIRE (the Market width its pool manager speaks); the
// tx-path contracts (corkAdapter/bundler3), whitelistManager and the controller are optional
// because not every era's deployment is fully known/verified — handlers gate per-capability
// with an honest `unknown_deployment` rather than pretending. Production callers should
// re-verify via CREATE2 (create2.ts) where an attestation exists.
import type { PhoenixBlock } from "./generations.ts";

/** A deployment IS a generation's phoenix block (generations.ts `PhoenixBlockSchema`): pool
 *  manager + constraint adapter + wire required; corkAdapter / bundler3 / whitelistManager /
 *  controller / contractsVersion optional. ONE type — the structurally-identical interface this
 *  aliased until 2026-09-22 needed `as CorkDeployment` casts wherever a block was handed out
 *  (review D). `chain/reads.ts` `CorkAddresses` is satisfied by it. */
export type CorkDeployment = PhoenixBlock;

// Addresses live in the canonical `cork-defaults.v2.json` at the repo root — the runtime fetches
// the latest copy from GitHub (config-remote.ts) and this bundled copy is the distribution
// fallback. Source files carry NO address literals. Provenance of the chain-1 values: verified
// via Sourcify + CREATE2 (C10). (`cork-defaults.json`, schema 1, is frozen for the 0.5 line and
// not read by this build.)
import bundledDefaults from "../../../cork-defaults.v2.json" with { type: "json" };

/** Test-fixture sugar ONLY: the bundled mainnet entry, which is complete (all optional
 *  tx-path fields present — config-remote.test pins it). Production paths resolve deployments
 *  REMOTE-FIRST via `resolveDeployment` (config-remote.ts); nothing at runtime may read this
 *  bundled-only view — a `deploymentFor(chainId)` convenience that did exactly that was removed
 *  2026-08-11. The mainnet stack predates the controller era, so `controller` is absent there. */
export const MAINNET_DEPLOYMENT: CorkDeployment & { corkAdapter: `0x${string}`; bundler3: `0x${string}`; whitelistManager: `0x${string}` } =
  bundledDefaults.generations["1"].sets.mainnet.phoenix as CorkDeployment & { corkAdapter: `0x${string}`; bundler3: `0x${string}`; whitelistManager: `0x${string}` };

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
  /** Where the init code is rebuildable from: PUBLIC repo + a release TAG or a COMMIT + source
   *  path (forge `path:Contract` form). A commit is allowed because the Distribution records
   *  pin commits and a set can be live before its tag exists (phoenix v1.4.0-rc.1 was). Solidity
   *  appends a build-sensitive metadata hash, so rebuild with a plain `forge build` in THAT repo
   *  at THAT tag/commit (its own remappings/profile). A proxy's init code additionally embeds
   *  its constructor args — implementation address + init calldata — so the attestation pins
   *  the implementation-at-deploy too. */
  source?: { repo: string; contract: string } & ({ tag: string; commit?: string } | { tag?: string; commit: string });
  /** The cork-defaults.v2.json field this attested address must equal — the drift gate tying
   *  the attestation layer to the config the tool actually routes calls to. Addresses a
   *  GENERATION: `section` names the block inside `generations[chain].sets[generation]`, `path`
   *  is a dot-path inside that block. Test-enforced (create2-attestations): a config edit
   *  without a matching attestation edit, or vice versa, fails offline. */
  binds?: { section: "phoenix" | "marketRegistry"; generation: string; chains: readonly number[]; path: string };
}

export const CREATE2_ATTESTATIONS: Create2Attestation[] = [
  {
    name: "corkAdapter",
    salt: "0x212fafd35b277528fa898ceaadcc917285f4666e2a87556d583e345956860f7d",
    initCodeHash: "0x2e1204abee27192079350f3f17779da88e1940a2ac222eb9f3e5a66060f682cb",
    expected: "0xCCcCcCCCcccCBaD6F772a511B337d9CCc9570407",
    binds: { section: "phoenix", generation: "mainnet", chains: [1], path: "corkAdapter" },
  },
  // Every entry below binds the phoenix/v0.3-rc.1 GENERATION (phoenix v1.3.0-rc.1 + market-
  // registry 0.3.3). The phoenix/v0.4-rc.1 set (phoenix v1.4.0-rc.1, market-registry 0.5.0,
  // rollover v0.2.0, cork-periphery v0.2.0-rc.1) has NO attestation yet: its Distribution
  // component records pin commits, addresses and runtime code hashes but carry no CREATE2 salts
  // or init-code hashes, and an attestation that cannot be re-derived from recorded inputs
  // would be a hardcode dressed up as evidence. Its trust rests on the approvedImplementations
  // code hashes (cross-checked against the records 2026-09-22) until the deploy broadcasts are
  // published; `source.commit` exists for that entry set.
  // MarketRegistry 0.3.3 set (42161 block 492983171 / 8453 block 49775886 — identical
  // addresses, ONE AtomicDeployer batch per chain with byte-identical init codes, verified from
  // both chains' broadcast records) — extracted from the deploy broadcast (market-registry
  // tag 0.3.3; the redeploy that fixes the cross-generation wrapper-salt collision by keying the
  // wrapper CREATE2 salt on the registry address). The AtomicDeployer itself is Safe-Singleton-
  // Factory CREATE2 (salt ++ initCode calldata; its rawSalt IS the global deployment salt); the
  // eight protocol contracts are CREATE2 FROM the AtomicDeployer under ONE guarded salt:
  // keccak256(abi.encodePacked(deploySender, rawSalt)) — the anti-squatting guard in
  // script/AtomicDeployer.sol. Every entry locally re-derived and matched against BOTH chains'
  // live addresses 2026-08-10. The factories' initCodeHashes are UNCHANGED from 0.3.2 — their
  // addresses moved only because the salt space moved, which is the point of the fix. The 0.3.2
  // set (registry 0xF5323F30…) is superseded; git history has its attestations.
  {
    name: "atomicDeployer",
    salt: "0xce89d6c66025e5b8639fbd88d3d4d841cfda15dd99e3f1ea98e3dec3f7a5c9b5",
    initCodeHash: "0xf71b94e19de5f98f8ced603caa2a4953479ae71e87f018dc3bc24429027ff448",
    expected: "0x56366DEed49735CdD8A6CbE72Db187b9A7958884",
    source: { repo: "github.com/Cork-Technology/market-registry", tag: "0.3.3", contract: "script/AtomicDeployer.sol:AtomicDeployer" },
  },
  {
    name: "marketRegistry",
    deployer: "0x56366DEed49735CdD8A6CbE72Db187b9A7958884",
    salt: "0x7e95f016beff322ab68560273670f09ee407ece46809047bc0b70970a64eead6",
    guard: { rawSalt: "0xce89d6c66025e5b8639fbd88d3d4d841cfda15dd99e3f1ea98e3dec3f7a5c9b5", guardSender: "0xE6E7437088bc0A9c29b5147AA13c1aB24541782a" },
    initCodeHash: "0x121b40b3455d01ad785c7b53bc460fca873133a3b7498d62b09cf602d67ae732",
    expected: "0xa78d8137B01058dD23e545b6557209eBBc9611F1",
    source: { repo: "github.com/Cork-Technology/market-registry", tag: "0.3.3", contract: "src/MarketRegistry.sol:MarketRegistry" },
    binds: { section: "marketRegistry", generation: "phoenix/v0.3-rc.1", chains: [42161, 8453], path: "registry" },
  },
  {
    name: "corkLimitOrderAdapter",
    deployer: "0x56366DEed49735CdD8A6CbE72Db187b9A7958884",
    salt: "0x7e95f016beff322ab68560273670f09ee407ece46809047bc0b70970a64eead6",
    guard: { rawSalt: "0xce89d6c66025e5b8639fbd88d3d4d841cfda15dd99e3f1ea98e3dec3f7a5c9b5", guardSender: "0xE6E7437088bc0A9c29b5147AA13c1aB24541782a" },
    initCodeHash: "0x9de5105f09a61a78b2441a2300094bd6b34c2759cbc10fda836396a579dd479d",
    expected: "0x8902a88912a334263fe3d731d03c267715b9374f",
    source: { repo: "github.com/Cork-Technology/market-registry", tag: "0.3.3", contract: "src/CorkLimitOrderAdapter.sol:CorkLimitOrderAdapter" },
    binds: { section: "marketRegistry", generation: "phoenix/v0.3-rc.1", chains: [42161, 8453], path: "adapter" },
  },
  {
    name: "wrapperRateConsumerFactory",
    deployer: "0x56366DEed49735CdD8A6CbE72Db187b9A7958884",
    salt: "0x7e95f016beff322ab68560273670f09ee407ece46809047bc0b70970a64eead6",
    guard: { rawSalt: "0xce89d6c66025e5b8639fbd88d3d4d841cfda15dd99e3f1ea98e3dec3f7a5c9b5", guardSender: "0xE6E7437088bc0A9c29b5147AA13c1aB24541782a" },
    initCodeHash: "0x9f7d017bc7ba9128c4ab4246dce99fd10de9611f0e0955a7247ab1e08afdb225",
    expected: "0xD488B245EF2c168fFb284a79ef9304DaC803CEC6",
    source: { repo: "github.com/Cork-Technology/market-registry", tag: "0.3.3", contract: "src/WrapperRateConsumerFactory.sol:WrapperRateConsumerFactory" },
    binds: { section: "marketRegistry", generation: "phoenix/v0.3-rc.1", chains: [42161, 8453], path: "wrapperFactory" },
  },
  {
    name: "fixedRateOracleFactory",
    deployer: "0x56366DEed49735CdD8A6CbE72Db187b9A7958884",
    salt: "0x7e95f016beff322ab68560273670f09ee407ece46809047bc0b70970a64eead6",
    guard: { rawSalt: "0xce89d6c66025e5b8639fbd88d3d4d841cfda15dd99e3f1ea98e3dec3f7a5c9b5", guardSender: "0xE6E7437088bc0A9c29b5147AA13c1aB24541782a" },
    initCodeHash: "0x2bc263ef45c96cfc64807511369b436baa56cdf256f32390564e6f33801dc02a",
    expected: "0x36f5DDb60695B09E5f41CA94eB551994F5541085",
    source: { repo: "github.com/Cork-Technology/market-registry", tag: "0.3.3", contract: "src/FixedRateOracleFactory.sol:FixedRateOracleFactory" },
    binds: { section: "marketRegistry", generation: "phoenix/v0.3-rc.1", chains: [42161, 8453], path: "fixedRateOracleFactory" },
  },
  {
    name: "aggregatorAdapterFactory",
    deployer: "0x56366DEed49735CdD8A6CbE72Db187b9A7958884",
    salt: "0x7e95f016beff322ab68560273670f09ee407ece46809047bc0b70970a64eead6",
    guard: { rawSalt: "0xce89d6c66025e5b8639fbd88d3d4d841cfda15dd99e3f1ea98e3dec3f7a5c9b5", guardSender: "0xE6E7437088bc0A9c29b5147AA13c1aB24541782a" },
    initCodeHash: "0x41055e120e8153a192624fc07ab38327cb481b814855b7b960a523de61f03224",
    expected: "0x3A5073aFc49e36f886fA55b5Db09BF485Eb65677",
    source: { repo: "github.com/Cork-Technology/market-registry", tag: "0.3.3", contract: "src/adapters/AggregatorV2V3AdapterFactory.sol:AggregatorV2V3AdapterFactory" },
    binds: { section: "marketRegistry", generation: "phoenix/v0.3-rc.1", chains: [42161, 8453], path: "aggregatorAdapterFactory" },
  },
  {
    name: "liquidityPriceRecipe",
    deployer: "0x56366DEed49735CdD8A6CbE72Db187b9A7958884",
    salt: "0x7e95f016beff322ab68560273670f09ee407ece46809047bc0b70970a64eead6",
    guard: { rawSalt: "0xce89d6c66025e5b8639fbd88d3d4d841cfda15dd99e3f1ea98e3dec3f7a5c9b5", guardSender: "0xE6E7437088bc0A9c29b5147AA13c1aB24541782a" },
    initCodeHash: "0xfa87863e27b920b646e09222488f730d0fbbe0c9e3351f903a2c2f3908a26101",
    expected: "0xb881DB48ad6DA84a8F0D1cE4150Caf7Ae016Dc55",
    source: { repo: "github.com/Cork-Technology/market-registry", tag: "0.3.3", contract: "src/recipes/LiquidityPriceRecipe.sol:LiquidityPriceRecipe" },
    binds: { section: "marketRegistry", generation: "phoenix/v0.3-rc.1", chains: [42161, 8453], path: "recipes.liquidity" },
  },
  {
    name: "liquidityNavRecipe",
    deployer: "0x56366DEed49735CdD8A6CbE72Db187b9A7958884",
    salt: "0x7e95f016beff322ab68560273670f09ee407ece46809047bc0b70970a64eead6",
    guard: { rawSalt: "0xce89d6c66025e5b8639fbd88d3d4d841cfda15dd99e3f1ea98e3dec3f7a5c9b5", guardSender: "0xE6E7437088bc0A9c29b5147AA13c1aB24541782a" },
    initCodeHash: "0x14743f20eee6d12d3e7bab21ab15561f1c94e5e952348ce3b1b4ca69183a2390",
    expected: "0xAeD3D0e3C86A994d88741C285657c3e78550f66d",
    source: { repo: "github.com/Cork-Technology/market-registry", tag: "0.3.3", contract: "src/recipes/LiquidityNavRecipe.sol:LiquidityNavRecipe" },
    binds: { section: "marketRegistry", generation: "phoenix/v0.3-rc.1", chains: [42161, 8453], path: "recipes.nav" },
  },
  {
    name: "fixedRateRecipe",
    deployer: "0x56366DEed49735CdD8A6CbE72Db187b9A7958884",
    salt: "0x7e95f016beff322ab68560273670f09ee407ece46809047bc0b70970a64eead6",
    guard: { rawSalt: "0xce89d6c66025e5b8639fbd88d3d4d841cfda15dd99e3f1ea98e3dec3f7a5c9b5", guardSender: "0xE6E7437088bc0A9c29b5147AA13c1aB24541782a" },
    initCodeHash: "0xcc9718159b9bb14ef88d186874626dbc6dc762a8220b151e3a80ff39ea104c07",
    expected: "0x133ac0fA9e3d44A34B8cE4E4B8D468758fd165C1",
    source: { repo: "github.com/Cork-Technology/market-registry", tag: "0.3.3", contract: "src/recipes/FixedRateRecipe.sol:FixedRateRecipe" },
    binds: { section: "marketRegistry", generation: "phoenix/v0.3-rc.1", chains: [42161, 8453], path: "recipes.fixed" },
  },
  // Phoenix v1.3.0-rc.1 stack (42161 + 8453, identical addresses) — Safe-Singleton-Factory
  // CREATE2, provenance from the 2026-08-10 paired shadow-release manifest (salt + initCodeHash
  // per contract), every entry locally re-derived and matched against both chains' live
  // addresses. The three proxies are OZ ERC1967Proxy — their init code EMBEDS the constructor
  // args (implementation address + init calldata), so each attestation pins the
  // implementation-at-deploy as well: poolManager impl 0x4a6D1352…55E3
  // (contracts/core/CorkPoolManager.sol), constraintAdapter impl 0x5ca7f1Be…e3f8
  // (contracts/core/ConstraintRateAdapter.sol), whitelistManager impl 0x1C83b4b2…7d84
  // (contracts/core/WhitelistManager.sol).
  {
    name: "poolManagerV13",
    salt: "0xee0ccc36f7c20be262d77eed4fee79a4569918c84e94b751c375ca720bd910bb",
    initCodeHash: "0xfd364848e65936c62f65f6fee0f1be402b3ea5bfdb6c5154dc42d036648778fd",
    expected: "0x02803Bb52D2184f906F45B50C66AA969C2E37263",
    source: { repo: "github.com/Cork-Technology/phoenix", tag: "v1.3.0-rc.1", contract: "lib/openzeppelin-contracts/contracts/proxy/ERC1967/ERC1967Proxy.sol:ERC1967Proxy" },
    binds: { section: "phoenix", generation: "phoenix/v0.3-rc.1", chains: [42161, 8453], path: "poolManager" },
  },
  {
    name: "constraintAdapterV13",
    salt: "0xddcbb6a4d6a401dc57afc714560c71a1ef107c2a74589ed9fc8308243853f106",
    initCodeHash: "0xa3499bd6994240b6e768ad944472ee4eb9665767e140c711ba7892e3b6e20b1e",
    expected: "0xA880bc161F7c738d206E15c788b47a864558d5b7",
    source: { repo: "github.com/Cork-Technology/phoenix", tag: "v1.3.0-rc.1", contract: "lib/openzeppelin-contracts/contracts/proxy/ERC1967/ERC1967Proxy.sol:ERC1967Proxy" },
    binds: { section: "phoenix", generation: "phoenix/v0.3-rc.1", chains: [42161, 8453], path: "constraintAdapter" },
  },
  {
    name: "whitelistManagerV13",
    salt: "0xb8ad1614409ae68fae7643fc60df479a3aecc1be03654ca25b67d20def070389",
    initCodeHash: "0x38d321299fb27582fe0cf1f7dd47e615b2a0b59e2309a78c713f2866c7b6436b",
    expected: "0xEEd30E98abDC4da6d9Ac15c1184C9d046cA0Ccd6",
    source: { repo: "github.com/Cork-Technology/phoenix", tag: "v1.3.0-rc.1", contract: "lib/openzeppelin-contracts/contracts/proxy/ERC1967/ERC1967Proxy.sol:ERC1967Proxy" },
    binds: { section: "phoenix", generation: "phoenix/v0.3-rc.1", chains: [42161, 8453], path: "whitelistManager" },
  },
  {
    name: "defaultCorkController",
    salt: "0x8a606dce5a3b74adde4f1c07775a3451187ab38f8e4b228110161edacdb5acdb",
    initCodeHash: "0x336b5eb8961397d4d36acf1278ffa251bbf248406a55547bf67e7881c2a22420",
    expected: "0x6b65D663e0B445BAf1870D5af806d57Ebb2C82A1",
    source: { repo: "github.com/Cork-Technology/phoenix", tag: "v1.3.0-rc.1", contract: "contracts/core/DefaultCorkController.sol:DefaultCorkController" },
    binds: { section: "phoenix", generation: "phoenix/v0.3-rc.1", chains: [42161, 8453], path: "controller" },
  },
  {
    name: "corkAdapterV13",
    salt: "0xf4c8801f2297c0f2d833f3a0666aca56be83e39950aeb8bd314f11484b6263da",
    initCodeHash: "0x01174f35f8be6540bec732c01ebf4286ad2d8462c79851f9750be31fcea4c222",
    expected: "0xfa8A94046f0bC16Da683Aa8219bd960FDAF572AD",
    source: { repo: "github.com/Cork-Technology/phoenix", tag: "v1.3.0-rc.1", contract: "contracts/periphery/CorkAdapter.sol:CorkAdapter" },
    binds: { section: "phoenix", generation: "phoenix/v0.3-rc.1", chains: [42161, 8453], path: "corkAdapter" },
  },
];
