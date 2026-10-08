// Offline chain stub for agent evals: a fake resolved RPC whose client serves the canonical
// demo-pool fixture state (the vnet fixture pool 0xceeb…c16a) so eval runs need NO network
// except the LLM API — deterministic, CI-friendly, and identical between runs.
import { allowedSenderSuffix, buildRolloverIntent, BUNDLED_DEFAULTS, classifyAddress, computeMarketId, decodeJitExtraData, generationsOf, type HandlerContext, hashLopOrder, LOP_ADDRESSES, type LopOrder, primaryOf, rolloverGenerationsOf, runTool, splitPermitSignature, encodeBookWatermark, premiumAmount, decodeExtensionFields, encodeExtensionFields } from "@cork/core";
import { privateKeyToAccount } from "viem/accounts";
import { decodeFunctionData, encodeAbiParameters, encodeErrorResult, encodeEventTopics, encodeFunctionResult, getAddress, parseAbi, parseAbiItem, pad, keccak256 } from "viem";
import { DEMO_ACCOUNT as DEMO_ACCOUNT_ADDR, DEMO_POOL_ID, TOOL_EXAMPLES } from "@cork/schemas";
import { planRfqWrite } from "../packages/core/src/rfq-bodies.ts";

export const SUSDE = "0x9D39A5DE30e57443BfF2A8307A4256c8797A3497";
export const VBUSDC = "0x53E82ABbb12638F09d9e624578ccB666217a765e";
const ORACLE = "0x14115b5fdab3afcd72cf03785041c720100edb0e";
const CPT = "0xc37d9aCe13C63806c6fA475aD507E94c70b6e110";
/** Exported so eval-task answer regexes derive from THIS constant instead of re-pinning the
 *  literal (the same import-don't-duplicate rule as LIQUIDITY_RECIPE below). */
export const CST = "0x16Aa2EbE1E2D6C856c634DaFc256257d2fEc0C69";
const NOW = 1_790_000_000n;

// MarketRegistry fixture — READ FROM the bundled cork-defaults.v2.json rather than pinned: the
// binding guard compares the stub's MARKET_REGISTRY() answer against the live config, so a
// hardcoded address here rots on every registry redeploy (the pinned 0.3.2 literal survived the
// 0.3.3 redeploy and silently turned two eval tasks red via adapter_binding_mismatch — found
// 2026-08-10 only because the eval log made the misses identifiable). Same for the recipe hints.
// The block is the one the registry-bound handlers BIND to (handlers/shared.ts
// getMarketRegistry): the PRIMARY generation — the nested-wire phoenix/v0.4-rc.1 set on
// 42161/8453 since stage 2a. The stub answers EVERY generation's getters address-aware (the
// contract asked decides which set's addresses come back), so a test that names a flat-wire
// generation sees a coherent flat stack and the default sees the nested one.
const GENERATIONS_42161 = generationsOf(BUNDLED_DEFAULTS, 42161);
const REGISTRY_GENERATION = (chainId: number) => primaryOf(generationsOf(BUNDLED_DEFAULTS, chainId));
const MR_42161 = REGISTRY_GENERATION(42161)!.marketRegistry!;
/** The generation a contract address belongs to (adapter / creator / registry / recipe), so a
 *  binding getter answers ITS set — never the primary's for a flat-wire adapter under test. */
const generationOfAddress = (chainId: number, address: string) => {
  const list = generationsOf(BUNDLED_DEFAULTS, chainId);
  const hit = classifyAddress(list, address)[0];
  return hit ? list.find((g) => g.label === hit.label) : undefined;
};
// Every address the approved-implementations guard may fingerprint — every GENERATION's — from
// the same config the guard resolves them from, so a redeploy cannot leave this set pointing at
// a stale literal.
const IMPLEMENTATION_ROLE_ADDRESSES = new Set(
  Object.keys(BUNDLED_DEFAULTS.generations)
    .flatMap((chainId) => generationsOf(BUNDLED_DEFAULTS, Number(chainId)))
    .flatMap((g) => [g.phoenix?.corkAdapter, g.phoenix?.whitelistManager, g.marketRegistry?.registry, g.marketRegistry?.adapter, g.marketRegistry?.marketCreator])
    .filter((a): a is `0x${string}` => typeof a === "string")
    .map((a) => a.toLowerCase()),
);
// The rollover generations — read from config like the registry above (the pinned-literal rot
// class): the retired-settler task's expected teaching and the sweep fixture's settler identity
// must track config, not a copy. RC2_* name the rollover v0.1.0-rc.2 set (the phoenix/v0.3-rc.1
// generation's block — active, no longer primary since phoenix/v0.4-rc.1); RETIRED_* the July
// 2026 set (arbitrum-v1.1's block).
const ROLLOVERS_42161 = rolloverGenerationsOf(GENERATIONS_42161);
const RC2_ROLLOVER = ROLLOVERS_42161.find((g) => g.wire === "rc.2" && g.status === "active")!;
export const RC2_EXACT_SETTLER = RC2_ROLLOVER.exactSettler;
export const RC2_FACTORY = RC2_ROLLOVER.factory;
export const RETIRED_EXACT_SETTLER = ROLLOVERS_42161.find((g) => g.status === "retired")!.exactSettler;
const REGISTRY_210 = MR_42161.registry;

// ── Migration fixtures (2026-09-22): the account's OLD pool on the phoenix/v0.3-rc.1 manager and
//    the NEW pool on the 10-field primary, both on Arbitrum (42161). Address-aware like the rest
//    of the stub: `shares`/`market` answer only on the manager each pool LIVES on (so a
//    pool-scoped prepare resolves the v0.3 generation for the old pool and the primary for the
//    new), `balanceOf` puts the position on the OLD pool only (the new set holds nothing yet —
//    the live fact the migration topic states), and the HyperSync stub announces both pools
//    under the MarketCreated topic of their emitter's wire.
const PHOENIX_42161 = (label: string) => GENERATIONS_42161.find((g) => g.label === label)!.phoenix!;
export const MIGRATION_OLD_PM = PHOENIX_42161("phoenix/v0.3-rc.1").poolManager;
export const MIGRATION_NEW_PM = PHOENIX_42161("phoenix/v0.4-rc.1").poolManager;
export const MIGRATION_OLD_POOL = `0x${"0d".repeat(32)}` as const;
export const MIGRATION_NEW_POOL = `0x${"0e".repeat(32)}` as const;
export const MIGRATION_OLD_CPT = "0x0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d01";
export const MIGRATION_OLD_CST = "0x0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d02";
export const MIGRATION_NEW_CPT = "0x0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e01";
export const MIGRATION_NEW_CST = "0x0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e02";
const MIGRATION_POOLS: Record<string, { pm: string; cpt: string; cst: string; wire: "8-field" | "10-field" }> = {
  [MIGRATION_OLD_POOL]: { pm: MIGRATION_OLD_PM, cpt: MIGRATION_OLD_CPT, cst: MIGRATION_OLD_CST, wire: "8-field" },
  [MIGRATION_NEW_POOL]: { pm: MIGRATION_NEW_PM, cpt: MIGRATION_NEW_CPT, cst: MIGRATION_NEW_CST, wire: "10-field" },
};
/** The migration pool the (manager, poolId) pair names on 42161 — undefined elsewhere. */
const migrationPoolOf = (chainId: number, address: string, poolId: unknown) => {
  if (chainId !== 42161 || typeof poolId !== "string") return undefined;
  const m = MIGRATION_POOLS[poolId.toLowerCase() === MIGRATION_OLD_POOL ? MIGRATION_OLD_POOL : poolId.toLowerCase() === MIGRATION_NEW_POOL ? MIGRATION_NEW_POOL : ""];
  return m && m.pm.toLowerCase() === address.toLowerCase() ? m : undefined;
};
export const LIQUIDITY_RECIPE = MR_42161.recipes!.liquidity!;
export const IMPAIRMENT_RECIPE = MR_42161.recipes!.impairment!;
export const FIXED_RECIPE = MR_42161.recipes!.fixed!;
/** The generation blocks per chain — the addresses the stub answers as the creator/adapter
 *  bindings (POOL_MANAGER, CONTROLLER, MARKET_CREATOR, MARKET_REGISTRY), resolved from the
 *  contract ASKED; the phoenix paths use the primary. */
const primaryPhoenix = (chainId: number) => primaryOf(generationsOf(BUNDLED_DEFAULTS, chainId))?.phoenix;
const registryPhoenixOf = (chainId: number, address: string) => (generationOfAddress(chainId, address) ?? REGISTRY_GENERATION(chainId))?.phoenix;
const registryBlockOf = (chainId: number, address: string) => (generationOfAddress(chainId, address) ?? REGISTRY_GENERATION(chainId))?.marketRegistry;
/** The two pseudo-unit denominations the live 0.5.0 registry lists (USD 0x…0348, ETH 0xeeee…). */
const NESTED_DENOMINATIONS = ["0x0000000000000000000000000000000000000348", "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE"] as const;
const WAD = 10n ** 18n;

const MARKET = {
  collateralAsset: SUSDE,
  referenceAsset: VBUSDC,
  expiryTimestamp: 1_798_761_600n,
  rateMin: 500_000_000_000_000_000n,
  rateMax: 1_000_000_000_000_000_000n,
  rateChangePerDayMax: 1_000_000_000_000_000n,
  rateChangeCapacityMax: 7_000_000_000_000_000n,
  rateOracle: ORACLE,
};

function readContract(args: { address: string; functionName: string; args?: unknown[] }, chainId: number): unknown {
  const poolId = args.args?.[0];
  // The demo pool exists ON MAINNET ONLY — like production. A chain-blind stub answered the
  // same live pool on every chainId, which made an agent's cross-chain disambiguation probe
  // unresolvable (observed 2026-08-17: it honestly refused to guess between three identical
  // chains). Registry/recipe reads are functionName-keyed and stay chain-agnostic.
  const migration = migrationPoolOf(chainId, args.address, poolId);
  const known = ((typeof poolId !== "string" || poolId.toLowerCase() === DEMO_POOL_ID.toLowerCase()) && chainId === 1) || migration !== undefined;
  switch (args.functionName) {
    case "market":
      // A 10-field manager answers the widened tuple (fees inside the identity).
      if (migration) return migration.wire === "10-field" ? { ...MARKET, swapFeePercentage: WAD, unwindSwapFeePercentage: WAD } : MARKET;
      return known ? MARKET : { ...MARKET, collateralAsset: "0x0000000000000000000000000000000000000000", referenceAsset: "0x0000000000000000000000000000000000000000", rateOracle: "0x0000000000000000000000000000000000000000", expiryTimestamp: 0n };
    case "constraints":
      return [800_000_000_000_000_000n, NOW - 86_400n, 7_000_000_000_000_000n];
    case "swapRate":
      if (!known) throw Object.assign(new Error("execution reverted"), { shortMessage: 'The contract function "swapRate" reverted.' });
      return 800_000_000_000_000_000n;
    case "swapFee":
    case "unwindSwapFee":
      return 50_000_000_000_000_000n;
    case "shares":
      // Only the known (existing) pool answers live share addresses. A blanket answer made
      // EVERY derived pool read exists:true with shares "read" — contradicting the JIT tasks'
      // own premise ("destination pool does not exist yet"); the honest prediction path is the
      // creation SIMULATION below (observed 2026-08-27: an agent that probed derive-cork-pool
      // was told the pool already existed and graded down for believing it).
      if (migration) return [migration.cpt, migration.cst];
      return known ? [CPT, CST] : ["0x0000000000000000000000000000000000000000", "0x0000000000000000000000000000000000000000"];
    case "rate":
      // A FixedRateOracle answers the rate it was deployed at; every pair oracle answers 0.8.
      return args.address.toLowerCase() === predictedFixedOracle(DEPLOYED_FIXED_RATE).toLowerCase() ? DEPLOYED_FIXED_RATE : 800_000_000_000_000_000n;
    case "lostAssets":
      // The fixture reference is a vault of a family WITHOUT the MetaMorpho v1.1 counter: the
      // call reverts, as it does on the live vaults that lack the view (tests wrap the client
      // to answer it).
      throw new Error('execution reverted: the contract function "lostAssets" reverted');
    case "decimals":
      return args.address.toLowerCase() === VBUSDC.toLowerCase() ? 6 : 18;
    case "issuedAt":
      return NOW - 604_800n;
    case "balanceOf": {
      // The migration account holds the OLD pool's shares and nothing on the NEW pool.
      const token = args.address.toLowerCase();
      if (token === MIGRATION_NEW_CST.toLowerCase() || token === MIGRATION_NEW_CPT.toLowerCase()) return 0n;
      return 42_000_000_000_000_000_000n;
    }
    case "allowance":
      // The RESTING maker's cST→LOP grant is LIVE: the ranked book's maker-readiness leg reads
      // it, and the fixture row must rank (a maker with no grant in place is rightly excluded
      // as not-ready). Every other (owner, spender) answers 0 — the confirmed-missing fixture
      // the approval_missing tasks grade.
      return String(args.args?.[0]).toLowerCase() === RESTING_MAKER.address.toLowerCase() ? 10n ** 24n : 0n;
    case "bitInvalidatorForOrder":
      return 0n; // untouched slot — the resting order reads LIVE to the fill's pre-flight [K7]
    case "orderStatus":
      // The venue-miss sweep fixture: ONE digest the venue archived but the RETIRED July exact
      // settler still holds as Settled (enum 2); every other (settler, digest) answers None.
      return args.address.toLowerCase() === RETIRED_EXACT_SETTLER.toLowerCase() && String(args.args?.[0]).toLowerCase() === ARCHIVED_DIGEST ? 2 : 0;
    case "isWhitelisted":
      return false;
    case "isGlobalWhitelisted":
    case "isMarketWhitelisted":
      return true; // matches the seeded whitelist events below — verification leg agrees
    // ── MarketRegistry surface (recipes as contracts; constraint via recipe.resolve). Every
    //    binding getter answers the set the ASKED contract belongs to — a pinned literal here
    //    rots on every redeploy (the 0.3.2 lesson at the top of this file), and a primary-only
    //    answer would break the binding chain of a flat-wire generation under test. ──
    case "MARKET_REGISTRY":
      return registryBlockOf(chainId, args.address)?.registry ?? REGISTRY_210; // adapter (flat) / creator (nested) immutable — keeps the binding guard green
    case "MARKET_CREATOR":
      return registryBlockOf(chainId, args.address)?.marketCreator ?? "0x0000000000000000000000000000000000000000"; // the nested adapter's creation delegate
    case "POOL_MANAGER":
      return registryPhoenixOf(chainId, args.address)?.poolManager ?? "0x0000000000000000000000000000000000000000";
    case "CONTROLLER":
      return registryBlockOf(chainId, args.address)?.controller ?? "0x0000000000000000000000000000000000000000";
    case "FEE_MANAGER_ROLE":
      return `0x${"6c".repeat(32)}`; // any stable hash — the pre-flight uses the probed value itself
    case "hasRole":
      return true; // POOL_CREATOR + FEE_MANAGER granted (matches the live grants, 2026-08-28)
    case "maxExpiryDuration":
      return 2_592_000n; // 30 days — the live registry's value at last read
    case "isRecipe": {
      const a = String(args.args?.[0] ?? "").toLowerCase();
      return a === LIQUIDITY_RECIPE.toLowerCase() || a === FIXED_RECIPE.toLowerCase() || a === IMPAIRMENT_RECIPE.toLowerCase();
    }
    case "getRecipes":
      return [[LIQUIDITY_RECIPE, FIXED_RECIPE, IMPAIRMENT_RECIPE], 3n];
    // Denominations: the nested registry lists plain unit ADDRESSES (the live 0.5.0 answer:
    // the USD and ETH pseudo-units); a flat registry lists {labelHash, unit} records.
    case "getDenominations":
      return registryBlockOf(chainId, args.address)?.wire === "nested"
        ? [[...NESTED_DENOMINATIONS], 2n]
        : [[{ labelHash: `0x${"a1".repeat(32)}`, unit: NESTED_DENOMINATIONS[0] }, { labelHash: `0x${"a2".repeat(32)}`, unit: NESTED_DENOMINATIONS[1] }], 2n];
    case "isDenomination":
      return NESTED_DENOMINATIONS.some((u) => u.toLowerCase() === String(args.args?.[0] ?? "").toLowerCase());
    case "source":
      // RecipeSource: NAV=0, PRICE=1, FIXED=2 (the deliberately inverted upstream ordering).
      return args.address.toLowerCase() === FIXED_RECIPE.toLowerCase() ? 2 : args.address.toLowerCase() === IMPAIRMENT_RECIPE.toLowerCase() ? 0 : 1;
    case "description":
      if (args.address.toLowerCase() === IMPAIRMENT_RECIPE.toLowerCase()) {
        return "Impairment: the rate window is the anchor plus or minus apySpreadPercentage * durationSeconds / 365 days of it. additionalData is abi.encode(uint256 anchorRate, uint256 durationSeconds, uint256 apySpreadPercentage), 96 bytes; apySpreadPercentage is on the percentage scale (1e18 = 1%).";
      }
      return args.address.toLowerCase() === FIXED_RECIPE.toLowerCase() ? "Fixed rate: a window of WINDOW_WIDTH around the fixed oracle rate." : "Liquidity: the widest rate window CorkPoolManager will accept.";
    case "SECONDS_PER_YEAR":
      return 31_536_000n;
    case "CAPACITY_DAYS":
      return 7n;
    case "EXTRA_DATA_LENGTH":
      return 96n;
    case "MAX_APY_SPREAD_PERCENTAGE":
      return 100n * WAD;
    case "MAX_BAND_PERCENTAGE":
      return 50n * WAD;
    case "REGISTRY":
      return REGISTRY_210;
    case "RATE_MIN":
    case "WINDOW_WIDTH":
      return 1n;
    case "RATE_MIN_PERCENTAGE":
    case "RATE_MAX_PERCENTAGE":
    case "RATE_CHANGE_PER_DAY_MAX_PERCENTAGE":
      return 100n * WAD;
    case "RATE_CHANGE_CAPACITY_MAX_PERCENTAGE":
      return 300n * WAD;
    // ── ForSelf adapter bindings (the Zyfai shape): the pre-flight verifies these on-chain
    //    before the caller grants the adapter an allowance, so they must answer the CONFIGURED
    //    addresses — a mismatch is a conflict, by design.
    case "CORK":
      // The ForSelf adapter binds the POOL MANAGER (not the Cork adapter) — the pre-flight
      // compares against exactly that, because an adapter pinned to another stack would route
      // the caller's allowance to the wrong protocol.
      return primaryPhoenix(1)!.poolManager;
    case "LOP":
      return BUNDLED_DEFAULTS.lopAddresses["1"]!;
    // The JIT adapter's own LOP binding (the maker-order pre-flight ladder checks it against the
    // chain's configured LOP): the real adapter answers its chain's 1inch deployment.
    // The adapter's pure decode helper reads the bytes back with the hook's own decoder — on the
    // WIRE of the adapter asked (the same selector returns the flat struct on a 0.3.x adapter and
    // the (MarketParams, enableJitMint) wrapper on a 0.5.0 one). The stub answers as a FAITHFUL
    // adapter of that generation would; tests wrap it to lie.
    case "decodeExtraData": {
      const wire = registryBlockOf(chainId, args.address)?.wire ?? "nested";
      const bytes = (args.args as [`0x${string}`])[0];
      if (wire === "nested") {
        const d = decodeJitExtraData("nested", bytes);
        const { enableJitMint, oracleSalt, ...market } = d.params;
        return [{ market: { ...market, oracleSalt: oracleSalt ?? `0x${"00".repeat(32)}` }, enableJitMint }, d.permits];
      }
      const d = decodeJitExtraData("flat", bytes);
      const { extraData, oracleSalt: _noSalt, ...rest } = d.params;
      // The flat adapter returns its own v/r/s permit rows.
      return [{ ...rest, additionalData: extraData }, d.permits.map((p) => ({ token: p.token, value: p.value, deadline: p.deadline, ...splitPermitSignature(p.signature)! }))];
    }
    case "LIMIT_ORDER_PROTOCOL":
      return BUNDLED_DEFAULTS.lopAddresses[String(chainId)] ?? BUNDLED_DEFAULTS.lopAddresses["1"]!;
    case "WHITELIST":
      // A pre-caller-gate adapter has no such view. A REVERT here is explicitly not a conflict
      // (the pre-flight adapts) — serving it proves that branch instead of the happy one.
      throw Object.assign(new Error("execution reverted"), { shortMessage: 'The contract function "WHITELIST" reverted.' });
    case "predictFixedRateOracle":
      return predictedFixedOracle(BigInt(String(args.args?.[0] ?? 0))); // CREATE2-salted on the RATE; not yet deployed (getCode answers "0x")
    case "lookupWrapper":
      return ORACLE; // pair oracle deployed; its rate() is served above
    case "resolve": {
      // The impairment recipe COMPUTES here — the real band math over the args the caller
      // actually encoded, so an eval agent's mis-encoded additionalData produces wrong numbers
      // instead of a green canned answer (realistic, never a rubber stamp). The oracle is
      // deployed in this world (lookupWrapper above), so like the deployed recipe the carried
      // anchor is IGNORED and the stub oracle's rate (0.8e18) anchors the window.
      if (args.address.toLowerCase() === IMPAIRMENT_RECIPE.toLowerCase()) {
        const data = String(args.args?.[3] ?? "0x");
        if ((data.length - 2) / 2 !== 96) throw new Error(`execution reverted: MalformedAdditionalData(${String((data.length - 2) / 2)})`);
        const word = (i: number) => BigInt(`0x${data.slice(2 + i * 64, 2 + (i + 1) * 64)}`);
        const [carried, durationSeconds, spread] = [word(0), word(1), word(2)];
        const oracleArg = String(args.args?.[2] ?? "").toLowerCase();
        const anchor = oracleArg === "0x0000000000000000000000000000000000000000" ? carried : 800_000_000_000_000_000n;
        const D = 100n * WAD;
        const YEAR = 31_536_000n;
        if (anchor === 0n) throw new Error("execution reverted: ZeroAnchorRate()");
        if (durationSeconds === 0n) throw new Error("execution reverted: ZeroDuration()");
        if (durationSeconds > 2_592_000n) throw new Error(`execution reverted: DurationTooLong(${durationSeconds.toString()}, 2592000)`);
        const band = (spread * durationSeconds) / YEAR;
        if (band >= D) throw new Error(`execution reverted: BandTooWide(${band.toString()})`);
        const perDayPct = (spread * 86_400n) / YEAR;
        return {
          rateMin: (anchor * (D - band) + D - 1n) / D,
          rateMax: (anchor * (D + band)) / D,
          rateChangePerDayMax: (anchor * perDayPct) / D,
          rateChangeCapacityMax: (anchor * 7n * perDayPct) / D,
        };
      }
      // The fixed recipe resolves only against a DEPLOYED FixedRateOracle. ONE rate has its
      // oracle deployed in this world (DEPLOYED_FIXED_RATE); for every other rate a plain read
      // refuses, as the live recipe does, and the constraint comes from the deploy-then-resolve
      // simulation below (simulateCalls).
      if (args.address.toLowerCase() === FIXED_RECIPE.toLowerCase()) {
        const r = fixedResolve(args.args as unknown as FixedResolveArgs, deployedFixedOracles());
        if ("error" in r) throw new Error(`execution reverted: ${r.error.text}`);
        return r.constraint;
      }
      // The liquidity shape at rate 0.8e18: floor 1 wei, ceiling 2×rate, per-day rate, capacity 3×rate.
      return { rateMin: 1n, rateMax: 1_600_000_000_000_000_000n, rateChangePerDayMax: 800_000_000_000_000_000n, rateChangeCapacityMax: 2_400_000_000_000_000_000n };
    }
    case "verify": {
      // The nested impairment recipe's verify takes the pool expiry and, on the call that
      // CREATES the pool, REJECTS — returns false, it does not revert — a duration beyond the
      // market's remaining life; the boundary is inclusive, and with `creating` false it
      // accepts (measured on the live recipe at one block, Base, 2026-10-01: 10 days of life,
      // durations of 10 d exact → true, 10 d + 1 h → false, the same with creating false →
      // true). The creator turns that false into RecipeRejectedConstraint. Nested arg order:
      // (ca, ref, oracle, expiryTimestamp, creating, constraint, extraData).
      const v = args.args ?? [];
      if (args.address.toLowerCase() === IMPAIRMENT_RECIPE.toLowerCase() && v.length === 7 && v[4] === true) {
        const data = String(v[6] ?? "0x");
        if ((data.length - 2) / 2 === 96 && BigInt(`0x${data.slice(2 + 64, 2 + 128)}`) > BigInt(String(v[3])) - NOW) return false;
      }
      return true;
    }
    case "symbol":
      return "sUSDe";
    case "name":
      return "Staked USDe";
    default:
      throw new Error(`stub has no fixture for ${args.functionName}`);
  }
}

// ── The fixed recipe and its oracle, as the chain behaves (read live on Base 2026-10-01) ──────
//    resolve checks the payload FIRST (UnexpectedExtraData(length)), then the oracle
//    (RateOracleNotDeployed(ca, ref)); against a deployed FixedRateOracle it answers
//    { rate, rate + 1, 0, 0 } — WINDOW_WIDTH 1, both allowances zero — and overflows (Panic 0x11)
//    at uint256's maximum. The oracle address is CREATE2-salted on the rate alone. The stub keeps
//    its OWN ABI: it plays the chain, and must not share an encoder with the code under test.
const FIXED_CHAIN_ABI = parseAbi([
  "function deployFixedRateOracle(uint256 rate) returns (address oracle)",
  "function resolve(address collateralAsset, address referenceAsset, address rateOracle, bytes extraData) view returns ((uint256 rateMin, uint256 rateMax, uint256 rateChangePerDayMax, uint256 rateChangeCapacityMax))",
  "error UnexpectedExtraData(uint256 length)",
  "error RateOracleNotDeployed(address ca, address ref)",
  "error Panic(uint256 code)",
]);
type FixedResolveArgs = readonly [`0x${string}`, `0x${string}`, `0x${string}`, `0x${string}`];
/** The ONE rate whose FixedRateOracle is already deployed in this world (0.5): the fixture for
 *  the plain-resolve path. Every other rate's oracle has no code. */
export const DEPLOYED_FIXED_RATE = 500_000_000_000_000_000n;
const deployedFixedOracles = (): Map<string, bigint> => new Map([[predictedFixedOracle(DEPLOYED_FIXED_RATE).toLowerCase(), DEPLOYED_FIXED_RATE]]);
/** One address per rate, like the registry's CREATE2 prediction. */
export const predictedFixedOracle = (rate: bigint): `0x${string}` => getAddress(`0x${keccak256(encodeAbiParameters([{ type: "string" }, { type: "uint256" }], ["eval-stub-fixed-rate-oracle", rate])).slice(-40)}`);
/** recipe.resolve on the fixed recipe. `deployed` maps each oracle address that has code in the
 *  simulation so far to the rate it was deployed at. */
function fixedResolve(a: FixedResolveArgs, deployed: Map<string, bigint>): { constraint: { rateMin: bigint; rateMax: bigint; rateChangePerDayMax: bigint; rateChangeCapacityMax: bigint } } | { error: { text: string; data: `0x${string}` } } {
  const [ca, ref, oracle, extraData] = a;
  const length = BigInt((extraData.length - 2) / 2);
  if (length > 0n) return { error: { text: `UnexpectedExtraData(${length})`, data: encodeErrorResult({ abi: FIXED_CHAIN_ABI, errorName: "UnexpectedExtraData", args: [length] }) } };
  const rate = deployed.get(oracle.toLowerCase());
  if (rate === undefined) return { error: { text: `RateOracleNotDeployed(${ca}, ${ref})`, data: encodeErrorResult({ abi: FIXED_CHAIN_ABI, errorName: "RateOracleNotDeployed", args: [ca, ref] }) } };
  if (rate === 2n ** 256n - 1n) return { error: { text: "Panic(17)", data: encodeErrorResult({ abi: FIXED_CHAIN_ABI, errorName: "Panic", args: [17n] }) } };
  return { constraint: { rateMin: rate, rateMax: rate + 1n, rateChangePerDayMax: 0n, rateChangeCapacityMax: 0n } };
}
type SimCall = { to?: string; data?: string };
type SimResult = { status: "success" | "failure"; data: `0x${string}` };
/** eth_simulateV1 over the stub chain: the calls run IN ORDER and share state, so an oracle a
 *  call deploys has code for the calls after it. Fixed-oracle deploys and fixed-recipe resolves
 *  are executed; every other call stays green, and the LAST call of a share prediction answers
 *  the shares read ([cPT, cST]) — production reads them from the pool the simulation created. */
function simulateCalls(a: { calls: SimCall[] }): { results: SimResult[] } {
  const deployed = deployedFixedOracles();
  const fixedLeg = (c: SimCall): SimResult | undefined => {
    const data = (c.data ?? "0x") as `0x${string}`;
    try {
      const d = decodeFunctionData({ abi: FIXED_CHAIN_ABI, data });
      if (d.functionName === "deployFixedRateOracle") {
        const oracle = predictedFixedOracle(d.args[0]);
        deployed.set(oracle.toLowerCase(), d.args[0]);
        return { status: "success", data: encodeFunctionResult({ abi: FIXED_CHAIN_ABI, functionName: "deployFixedRateOracle", result: oracle }) };
      }
      if (String(c.to).toLowerCase() !== FIXED_RECIPE.toLowerCase()) return undefined;
      const r = fixedResolve(d.args as FixedResolveArgs, deployed);
      return "error" in r ? { status: "failure", data: r.error.data } : { status: "success", data: encodeFunctionResult({ abi: FIXED_CHAIN_ABI, functionName: "resolve", result: r.constraint }) };
    } catch {
      return undefined; // not a fixed-oracle call
    }
  };
  const shares = `0x${CPT.slice(2).toLowerCase().padStart(64, "0")}${CST.slice(2).toLowerCase().padStart(64, "0")}` as const;
  const results = a.calls.map((c) => fixedLeg(c) ?? ({ status: "success", data: "0x" } as SimResult));
  const last = a.calls.length - 1;
  if (last >= 0 && fixedLeg(a.calls[last]!) === undefined) results[last] = { status: "success", data: shares };
  return { results };
}

/** A rollover orderDigest the venue no longer serves (its generation is archived) but whose
 *  state survives on-chain at the retired settler — the track venue-miss sweep fixture. */
export const ARCHIVED_DIGEST = `0x${"5e".repeat(32)}`;

/** The one open RFQ on the venue stub's discovery feed (the rfq-read task's ground truth). */
export const RFQ_OPEN_ID = "rfq_open7";
/** An open RFQ that declares NO fill_sender — served on the single-record read only (the feed
 *  keeps its one row so every count the eval fixtures pin stays put). answer-rfq must build it
 *  OPEN with `fill_sender_unknown`, never reserved for the requester account by guess. */
export const RFQ_NOSENDER_ID = "rfq_open8nosender";
/** A rollover RFQ (kind "rollover") opened by the demo account, with one quote into an existing
 *  pool — the RFQ a rollover-intent quoteRef accepts (the cork_prepare_orders example). */
export const RFQ_ROLLOVER_ID = "rfq_0roll123";
export const RFQ_ROLLOVER_REQUESTER = "0xc0ffee0000000000000000000000000000000001";
/** An open RFQ whose inline template carries the `cork-inline-liquidity/1` oracle_params block
 *  (the shape the Cork status-page heartbeat RFQs carry): an anchor BELOW the stub oracle's live
 *  rate (0.7 vs 0.8), the JIT task expiry, a 1% swap fee. Its one answer (by the resting maker)
 *  cites an option whose own template names the LIVE rate as anchor. Served on the single-record
 *  read only, like RFQ_NOSENDER_ID. */
export const RFQ_INLINE_ID = "rfq_open9inline";
export const RFQ_INLINE_ANCHOR = "700000000000000000";
export const RFQ_INLINE_OPTION_ANCHOR = "800000000000000000"; // = the stub oracle's rate()
export const RFQ_INLINE_ANSWER_ID = "ans_inline1";
/** Two RFQs under the cork-inline-impairment/1 convention (the fourth recipe's three-word
 *  block). COMPLETE carries anchor + duration (7 days) + spread (10%/year, 1e18 = 1%); PARTIAL
 *  omits the spread — the recipe's payload cannot be derived from it, and answer-rfq must say
 *  so instead of encoding a zero. Served on the single-record read only. */
export const RFQ_IMPAIRMENT_ID = "rfq_open10impair";
export const RFQ_IMPAIRMENT_PARTIAL_ID = "rfq_open11impairpartial";
export const RFQ_IMPAIRMENT_DURATION = "604800";
export const RFQ_IMPAIRMENT_SPREAD = "10000000000000000000";
/** The impairment RFQs' pool expiry: the duration plus an hour of open→answer slack past the
 *  stub clock — CREATABLE (inside the registry's 30-day maxExpiryDuration, unlike the JIT task's
 *  years-out fixture) and coherent with duration_seconds, so a well-formed answer carries no
 *  would_revert and no window-vs-life note. Tests that want those pass their own expiry. */
export const RFQ_IMPAIRMENT_EXPIRY = (NOW + 604_800n + 3_600n).toString();
/** Two RFQs for FIXED-RATE cover (cork-api 0.4.4: mode `fixed_rate`, the frozen rate in
 *  `oracle_params.rate_override`). BELOW freezes 0.75 under the stub oracle's 0.8 — the reference
 *  must lose 6.25% before the cover pays; ABOVE freezes 0.9 — the cover pays 12.5% at once, the
 *  case answer-rfq must name to the underwriter. Served on the single-record read only. */
export const RFQ_FIXED_ID = "rfq_open12fixed";
export const RFQ_FIXED_ABOVE_ID = "rfq_open13fixedabove";
export const RFQ_FIXED_RATE = "750000000000000000";
/** The resting maker's posted answer on RFQ_FIXED_ID: one fixed_rate option that proposes
 *  ANOTHER rate (0.74) in its own template — the 0.4.4 counter-proposal a cited answer builds. */
export const RFQ_FIXED_ANSWER_ID = "ans_fixed1";
export const RFQ_FIXED_OPTION_RATE = "740000000000000000";
export const RFQ_FIXED_ABOVE_RATE = "900000000000000000";
/** The id the venue assigns an underwriter's answer (the rfq-answer task's ground truth). */
export const RFQ_ANSWER_ID = "ans_eval1";

/** An integrator-deployed Cork ForSelf adapter (the Zyfai parameter-blind session-key shape).
 *  NOT a Cork deployment — the tool verifies its CORK()/LOP() bindings on-chain precisely
 *  because the caller is about to grant IT the token allowances. */
export const FORSELF_ADAPTER = "0x5ea500000000000000000000000000000000aDa0"; // EIP-55 checksummed: the Address schema enforces it
const FORSELF_ADAPTER_CODE = "0x60806040523480156100";

/** One rc.2 rollover clone on the venue's contracts feed (the factory-filter task). */
export const RC2_CLONE = "0x96f126A8503145201A60Bf9BdB29fE26E40cCA14";
export const RC2_CLONE_OWNER = "0x303Dd0B6835b4b4739d35F16A123e77D5A7dCFFF";

// One REAL signed rc.2 rollover order, ready to relay: built through the SAME builder the
// prepare path uses (typed-data + venue wire body), signed by a throwaway key that IS the
// order's user — the submit handler ecrecovers it for real, recomputes the intent hash and
// digest for real, and runs the full admission battery. Realistic, not mocked.
const ROLLOVER_USER = privateKeyToAccount(`0x${"09".repeat(32)}`);
const SIGNED_ROLLOVER_BUILT = buildRolloverIntent({
  chainId: 42161,
  user: ROLLOVER_USER.address,
  settler: RC2_EXACT_SETTLER as `0x${string}`,
  rolloverContract: ROLLOVER_USER.address,
  srcCstToken: SUSDE,
  dstCstToken: VBUSDC,
  premiumToken: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", // USDC — a THIRD asset (admission)
  srcPoolId: `0x${"11".repeat(32)}`,
  dstPoolId: `0x${"22".repeat(32)}`,
  orderSize: 250n * 10n ** 18n,
  minPremiumPerShare: 12n * 10n ** 15n,
  openDeadline: 1_795_000_000n,
  fillDeadline: 1_795_604_800n,
  clientRequestId: "eval-rollsub-fixture",
});
// ONLY the three keys the cork_submit rollover-order action takes (strictObject): spreading the
// whole venuePost leaked chainId+envelope into the prompt payload, making "relay exactly as
// given" schema-invalid verbatim. venuePost.signature is a placeholder instruction by design —
// replaced here with the real signature over the real digest.
export const SIGNED_ROLLOVER_POST = {
  order: SIGNED_ROLLOVER_BUILT.venuePost.order,
  intent: SIGNED_ROLLOVER_BUILT.venuePost.intent,
  signature: await ROLLOVER_USER.sign({ hash: SIGNED_ROLLOVER_BUILT.orderDigest }),
};
export const SIGNED_ROLLOVER_DIGEST = SIGNED_ROLLOVER_BUILT.orderDigest;

// The JIT rollover task's CORRECT destination pool id: derived through the same Market-tuple
// hash the fill runs, against the stub's pair oracle and the constraint the prompt carries —
// so the task grades commitment-building, not pool-id guessing.
export const JIT_TASK_CONSTRAINT = { rateMin: "1", rateMax: "1600000000000000000", rateChangePerDayMax: "800000000000000000", rateChangeCapacityMax: "2400000000000000000" };
export const JIT_TASK_EXPIRY = 1_900_000_000n;
export const JIT_TASK_PAIR = { collateralAsset: "0x211Cc4DD073734dA055fbF44a2b4667d5E5fE5d2", referenceAsset: "0xdDb46999F8891663a8F2828d25298f70416d7610" } as const;
// Derived FROM the constraint constant above (never a second hand-written copy: a tuned string
// twin with a stale bigint twin makes DERIVED_JIT_POOL the id of a DIFFERENT pool than the
// constraint the prompt carries — the pinned-literal rot class, in duplicate-value form).
export const DERIVED_JIT_POOL = computeMarketId(
  {
    ...JIT_TASK_PAIR,
    expiryTimestamp: JIT_TASK_EXPIRY,
    rateMin: BigInt(JIT_TASK_CONSTRAINT.rateMin),
    rateMax: BigInt(JIT_TASK_CONSTRAINT.rateMax),
    rateChangePerDayMax: BigInt(JIT_TASK_CONSTRAINT.rateChangePerDayMax),
    rateChangeCapacityMax: BigInt(JIT_TASK_CONSTRAINT.rateChangeCapacityMax),
    rateOracle: ORACLE,
  },
  // The JIT ROLLOVER task binds its market to the rc.2 settler's generation (phoenix/v0.3-rc.1,
  // an 8-field pool manager) — the commitment's pool id follows the SETTLER's set, not the
  // chain primary's, so this stays the 8-field id (the 0.2 wire's 10-field twin is a stage-2b
  // fixture of its own).
  "8-field",
);

// One seeded GlobalWhitelistAdded(WHITELISTED_ACCT) log so whitelisted-addresses has a
// deterministic non-empty answer. topic0 = keccak("GlobalWhitelistAdded(address)").
const WHITELISTED_ACCT = "0x00000000000000000000000000000000000a11ce";
const GLOBAL_ADDED_TOPIC = "0x3dfb644c437d7ac77310a6355571af9bcbf4d2e01c805141c03aa9786737a2c5";
const MARKET_CREATED_7 = parseAbiItem("event MarketCreated(bytes32 indexed id, address indexed referenceAsset, address indexed collateralAsset, uint256 expiry, address rateOracle, address principalToken, address swapToken)");
const MARKET_CREATED_9 = parseAbiItem("event MarketCreated(bytes32 indexed poolId, address indexed referenceAsset, address indexed collateralAsset, uint256 expiry, address rateOracle, address principalToken, address swapToken, uint256 swapFeePercentage, uint256 unwindSwapFeePercentage)");
/** The two migration pools' creation logs, each under ITS emitter wire's topic (a 7-arg log from
 *  the v0.3 manager, a 9-arg log from the 10-field primary) — the positions sweep decodes each
 *  with its emitter's ABI. */
function migrationMarketLogs(): Array<{ address: string; topics: string[]; data: `0x${string}`; blockNumber: number; transactionHash: string }> {
  const old = MIGRATION_POOLS[MIGRATION_OLD_POOL]!;
  const neu = MIGRATION_POOLS[MIGRATION_NEW_POOL]!;
  return [
    {
      address: old.pm,
      topics: [...encodeEventTopics({ abi: [MARKET_CREATED_7], args: { id: MIGRATION_OLD_POOL, referenceAsset: VBUSDC, collateralAsset: SUSDE } })] as string[],
      data: encodeAbiParameters([{ type: "uint256" }, { type: "address" }, { type: "address" }, { type: "address" }], [MARKET.expiryTimestamp, ORACLE, old.cpt as `0x${string}`, old.cst as `0x${string}`]),
      blockNumber: 22_999_990,
      transactionHash: `0x${"0d".repeat(32)}`,
    },
    {
      address: neu.pm,
      topics: [...encodeEventTopics({ abi: [MARKET_CREATED_9], args: { poolId: MIGRATION_NEW_POOL, referenceAsset: VBUSDC, collateralAsset: SUSDE } })] as string[],
      data: encodeAbiParameters([{ type: "uint256" }, { type: "address" }, { type: "address" }, { type: "address" }, { type: "uint256" }, { type: "uint256" }], [MARKET.expiryTimestamp, ORACLE, neu.cpt as `0x${string}`, neu.cst as `0x${string}`, WAD, WAD]),
      blockNumber: 22_999_991,
      transactionHash: `0x${"0e".repeat(32)}`,
    },
  ];
}

/** The same two migration pools as the venue's /pools/v1 rows (the shape cork-pools reads:
 *  `poolManagerAddress`, token OBJECTS with `address`, string `expiry`). */
function migrationVenueRows(): Array<Record<string, unknown>> {
  const row = (poolId: string, m: { pm: string; cpt: string; cst: string }, block: number, tx: string) => ({
    chainId: 42161,
    poolId,
    poolManagerAddress: m.pm,
    swapToken: { address: m.cst, symbol: "cST" },
    principalToken: { address: m.cpt, symbol: "cPT" },
    collateralToken: { address: SUSDE, symbol: "sUSDe" },
    referenceToken: { address: VBUSDC, symbol: "vbUSDC" },
    expiry: new Date(Number(MARKET.expiryTimestamp) * 1000).toISOString(), // the venue serves ISO-8601, not seconds
    rateOracleAddress: ORACLE,
    deploymentBlockNumber: block,
    deploymentTxHash: tx,
  });
  return [row(MIGRATION_OLD_POOL, MIGRATION_POOLS[MIGRATION_OLD_POOL]!, 22_999_990, `0x${"0d".repeat(32)}`), row(MIGRATION_NEW_POOL, MIGRATION_POOLS[MIGRATION_NEW_POOL]!, 22_999_991, `0x${"0e".repeat(32)}`)];
}

function whitelistHyperSync() {
  return {
    async queryLogs(q: { fromBlock?: number; address?: string[]; topics?: Array<string[] | null> }) {
      const wanted = new Set(q.topics?.[0] ?? []);
      const scope = new Set((q.address ?? []).map((a) => a.toLowerCase()));
      const logs = wanted.has(GLOBAL_ADDED_TOPIC)
        ? [{ address: "0xcCccCcCccCC6e38a2772Eb42D2f408eeB89cb0eE", topics: [GLOBAL_ADDED_TOPIC, `0x${WHITELISTED_ACCT.slice(2).padStart(64, "0")}`], data: "0x", blockNumber: 23_000_000, transactionHash: `0x${"aa".repeat(32)}` }]
        : migrationMarketLogs().filter((l) => wanted.has(l.topics[0]!) && (scope.size === 0 || scope.has(l.address.toLowerCase())) && l.blockNumber >= (q.fromBlock ?? 0));
      return { logs, archiveHeight: 23_000_100 };
    },
  };
}

// One REAL resting order on the venue stub's book — realistic, not mocked: the maker is a
// throwaway key, the signature is a genuine ECDSA signature over the genuine LOP v4 order hash
// (the taker-fill handler re-hashes the row and can ecrecover it), and the liveness pre-flight
// reads a genuine bit-invalidator answer from the chain stub. The hash is computed HERE, once,
// so the task prompt and the served row cannot drift.
const RESTING_MAKER = privateKeyToAccount(`0x${"07".repeat(32)}`);
const RESTING_ORDER: LopOrder = {
  salt: 7n,
  maker: RESTING_MAKER.address,
  receiver: "0x0000000000000000000000000000000000000000",
  makerAsset: CST,
  takerAsset: SUSDE,
  makingAmount: 10n ** 18n,
  takingAmount: 5n * 10n ** 16n,
  makerTraits: 0n,
};
export const RESTING_ORDER_HASH = hashLopOrder(1, LOP_ADDRESSES[1]!, RESTING_ORDER);
/** The answer-rfq task's terms: a pool expiry 20 days out (inside the registry's 30-day creation
 *  bound) and the kernel-exact takingAmount for 4% on the stub RFQ's notional over that tenor —
 *  computed HERE with the same function the handler uses, so the prompt and the grader cannot
 *  drift from the served amounts. */
export const ANSWER_TASK_EXPIRY = (NOW + 20n * 86_400n).toString();
export const ANSWER_TASK_TAKING = premiumAmount("0.04", 1000n * 10n ** 18n, 20n * 86_400n).toString();
/** A watermark from "an earlier look" at the book by DEMO_ACCOUNT_ADDR: its best SELL was a
 *  (since-gone) order at TWICE the resting row's unit price, so today's ranked read finds the
 *  resting row APPEARED and BETTER, and the old best GONE — the watch task's expected changes. */
const EARLIER_BEST_HASH = `0x${"a5".repeat(32)}`;
export const WATCH_WATERMARK = encodeBookWatermark({ v: 1, account: DEMO_ACCOUNT_ADDR.toLowerCase(), live: [EARLIER_BEST_HASH], best: { SELL: { orderHash: EARLIER_BEST_HASH, unitPrice: (RESTING_ORDER.takingAmount * 2n).toString(), reservedForAccount: false }, BUY: null } });

/** The RFQ v2 writer of the relay tasks. Every v2 write is proven, so a task that relays one
 *  hands the agent a GENUINE CorkRfqWrite signature by this fixture key over exactly the body
 *  the task describes — the venue (and cork_submit before it) refuses any other. */
const RFQ_WRITER = privateKeyToAccount(`0x${"0d".repeat(32)}`);
export const RFQ_WRITER_ADDRESS = RFQ_WRITER.address;
async function signedRfqAction(clientRequestId: string, action: Record<string, unknown>, kind?: "new_position" | "rollover"): Promise<Record<string, unknown>> {
  const plan = planRfqWrite({ chainId: 42161, clientRequestId, request: action as never, ...(kind ? { target: { kind } } : {}) });
  return { ...action, auth: { method: "signature", signature: await RFQ_WRITER.signTypedData(plan.typedData as never) } };
}
/** submit-rfq-open: a liquidity request on the stub pair. */
export const SIGNED_RFQ_OPEN = await signedRfqAction("eval-rfq-0001", { type: "rfq-open", kind: "new_position", requester: RFQ_WRITER.address, referenceAsset: JIT_TASK_PAIR.referenceAsset, collateralAsset: { exact: JIT_TASK_PAIR.collateralAsset }, modes: ["liquidity_only"], packageIds: ["pkg_default"], expiryWindow: { notBefore: 1900000000, notAfter: 1910000000 }, notionalAssets: "1000000000000000000000", validUntil: 1795000000 });
/** submit-rfq-open-fixed: the fixed-rate request frozen at RFQ_FIXED_RATE. */
export const SIGNED_RFQ_OPEN_FIXED = await signedRfqAction("eval-rfq-fixed-0001", { type: "rfq-open", kind: "new_position", requester: RFQ_WRITER.address, referenceAsset: JIT_TASK_PAIR.referenceAsset, collateralAsset: { exact: JIT_TASK_PAIR.collateralAsset }, modes: ["fixed_rate"], packageIds: ["pkg_default"], expiryWindow: { notBefore: Number(RFQ_IMPAIRMENT_EXPIRY) - 1, notAfter: Number(RFQ_IMPAIRMENT_EXPIRY) }, marketTemplate: { inline: { oracle_recipe: FIXED_RECIPE, oracle_params: { schema: "cork-inline-fixed/1", rate_override: RFQ_FIXED_RATE, expiry: RFQ_IMPAIRMENT_EXPIRY, swap_fee_wad: "0", unwind_swap_fee_wad: "0" } } }, notionalAssets: "1000000000", validUntil: 1790086400 });
/** submit-rfq-answer: one quoted option at 3.8%, carrying the signed limit order it stands behind
 *  (RFQ v2: one order, one quote). A cover order: it sells cST on the stub pair for the premium in
 *  the collateral, and its amounts are the kernel's for the option's own premium and expiry —
 *  cork_submit holds every option to the order it carries. */
const RFQ_ANSWER_EXPIRY = 1_900_000_000;
const RFQ_ANSWER_ORDER: LopOrder = { salt: 3801n, maker: RFQ_WRITER.address, receiver: "0x0000000000000000000000000000000000000000", makerAsset: "0x5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c", takerAsset: JIT_TASK_PAIR.collateralAsset, makingAmount: 10n ** 21n, takingAmount: premiumAmount("0.038", 10n ** 21n, BigInt(RFQ_ANSWER_EXPIRY) - NOW), makerTraits: 0n };
export const SIGNED_RFQ_ANSWER = await signedRfqAction(
  "eval-ans-0001",
  {
    type: "rfq-answer",
    rfqId: RFQ_OPEN_ID,
    underwriter: RFQ_WRITER.address,
    status: "quoted",
    options: [{
      option_id: "opt1",
      chain_id: 42161,
      collateral_asset: JIT_TASK_PAIR.collateralAsset.toLowerCase(),
      reference_asset: JIT_TASK_PAIR.referenceAsset.toLowerCase(),
      mode: "liquidity_only",
      package_id: "pkg_default",
      expiry: RFQ_ANSWER_EXPIRY,
      market_template: { inline: { oracle_recipe: LIQUIDITY_RECIPE.toLowerCase(), oracle_params: {} } },
      premium_annualized: "0.038",
      notional_max_assets: "1000000000000000000000",
      fresh_until: RFQ_ANSWER_EXPIRY,
      order: Object.fromEntries(Object.entries(RFQ_ANSWER_ORDER).map(([k, v]) => [k, typeof v === "string" ? v.toLowerCase() : String(v)])),
      order_signature: await RFQ_WRITER.sign({ hash: hashLopOrder(42161, LOP_ADDRESSES[42161]!, RFQ_ANSWER_ORDER) }),
    }],
  },
  "new_position",
);

/** The same real signed order as a CALLER-HELD payload for the relay task (the fraction-premium
 *  translation probe): order wire fields + genuine signature, ready for cork_submit lop-order. */
export const SIGNED_LOP_PAYLOAD = {
  order: {
    salt: RESTING_ORDER.salt.toString(),
    maker: RESTING_ORDER.maker,
    receiver: RESTING_ORDER.receiver,
    makerAsset: RESTING_ORDER.makerAsset,
    takerAsset: RESTING_ORDER.takerAsset,
    makingAmount: RESTING_ORDER.makingAmount.toString(),
    takingAmount: RESTING_ORDER.takingAmount.toString(),
    makerTraits: RESTING_ORDER.makerTraits.toString(),
  },
  signature: await RESTING_MAKER.sign({ hash: RESTING_ORDER_HASH }),
};
// The venue book row is the SAME payload plus row metadata — one signature, one source of
// truth (the sign-twice duplication this replaced could drift if the order fixture changes).
/** The RFQ answer the resting row CITES (quoteRef) — the firm quote of the offers view — and the
 *  answer nobody backed with an order (indicative). Both ride on the stub RFQ when the feed is
 *  read with answers embedded, so the join has real ids on both sides. */
export const FIRM_ANSWER_ID = "ans_firm1";
export const SOFT_ANSWER_ID = "ans_soft1";
export const SOFT_UNDERWRITER = "0x000000000000000000000000000000000000dEaD";
const RESTING_ROW: Record<string, unknown> = {
  ...SIGNED_LOP_PAYLOAD.order,
  signature: SIGNED_LOP_PAYLOAD.signature,
  extension: "0x",
  makerAccountType: "EOA",
  orderHash: RESTING_ORDER_HASH,
  side: "SELL",
  status: "OPEN",
  quoteRef: { rfq_id: RFQ_OPEN_ID, answer_id: FIRM_ANSWER_ID, option_id: "opt1" },
};

// A RESERVED sibling on the same book: same maker, same economics, but its signed makerTraits
// carry an allowed-sender suffix that is NOT the eval taker's — so the exclusivity refusal
// (private_order) grades end-to-end against real signed bytes, exactly as the tool judges it.
// The reserved filler is a nobody: only its LAST 10 BYTES exist in the order.
// A REALISTIC-looking address (no 20-zero prefix): agents miscounted the zero-padded form as 41
// hex chars twice (2026-09-02/03) and refused to build. The low 80 bits — the reserved suffix the
// makerTraits store — are unchanged, so every hash and every suffix assertion stays put.
export const RESERVED_FILLER = "0x5eed5eed5eed5eed5eedbadbadbadbadbadbadb1";
const RESERVED_ORDER: LopOrder = { ...RESTING_ORDER, salt: 8n, makerTraits: BigInt(allowedSenderSuffix(RESERVED_FILLER)) };
export const RESERVED_ORDER_HASH = hashLopOrder(1, LOP_ADDRESSES[1]!, RESERVED_ORDER);
const RESERVED_ROW: Record<string, unknown> = {
  ...SIGNED_LOP_PAYLOAD.order,
  salt: RESERVED_ORDER.salt.toString(),
  makerTraits: RESERVED_ORDER.makerTraits.toString(),
  signature: await RESTING_MAKER.sign({ hash: RESERVED_ORDER_HASH }),
  extension: "0x",
  makerAccountType: "EOA",
  orderHash: RESERVED_ORDER_HASH,
};

/** Offline venue stub: canned api-phoenix responses for the eval tasks. */
async function venueFetch(url: string, init?: RequestInit): Promise<Response> {
  const r = (status: number, body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status }));
  if (init?.method === "POST") {
    if (url.includes("/rollover/v1/orders")) return r(201, {}); // handler fills the digest from its local recomputation
    // Accept with no echoed orderHash — the venue's own shape. Echoing a DIFFERENT hash is a
    // conflict (the local EIP-712 hash is the order's identity); the placeholder "0x" used to
    // be one, which would have graded every relay task as a failed relay.
    if (url.includes("/limit-orders")) return r(201, {});
    // /rfqs/v2/{id}/answers answers with an ANSWER id; the open endpoint with an RFQ id. A
    // stub that returned rfq_id for both would let the handler's `answer_id ?? null` read null
    // and still look accepted — the field the underwriter needs, quietly absent.
    if (url.includes("/answers")) return r(201, { answer_id: RFQ_ANSWER_ID, rfq_id: RFQ_OPEN_ID });
    if (url.includes("/rfqs")) return r(201, { rfq_id: "rfq_eval1", state: "open" });
  }
  if (url.includes("/pools")) {
    // The venue's pool list is chain-scoped server-side; the stub mirrors that. On 42161 it
    // serves the two migration pools in the venue's row shape (poolManagerAddress + the token
    // objects) — the positions sweep's DEFAULT enumeration (hybrid) reads them from here, the
    // full-decentralized enumeration from migrationMarketLogs(); both name the same pools.
    const chain = Number(new URL(url).searchParams.get("chainId") ?? "1");
    const items = chain === 42161 ? migrationVenueRows() : chain === 1 ? [{ chainId: 1, poolId: DEMO_POOL_ID, poolName: "sUSDe-vbUSDC-DEMO" }] : [];
    return r(200, { items, nextCursor: null, hasMore: false });
  }
  if (/\/rollover\/v1\/orders\/0x/.test(url)) return r(404, { message: "not found" });
  if (url.includes("/rollover/v1/contracts")) {
    // The venue applies the factory filter server-side; the stub mirrors that so a filtered
    // read is answered by filtering, not by ignoring the parameter.
    const factory = new URL(url).searchParams.get("factory");
    const row = { chainId: 42161, address: RC2_CLONE, owner: RC2_CLONE_OWNER, factory: RC2_FACTORY.toLowerCase(), trustThreshold: 1, deploymentBlock: "495935441" };
    const items = factory && factory.toLowerCase() !== RC2_FACTORY.toLowerCase() ? [] : [row];
    return r(200, { items, nextCursor: null, hasMore: false });
  }
  if (url.includes("/rollover/")) return r(200, { items: [] });
  if (/\/rfqs\/v2(\/|\?|$)/.test(url)) {
    // The discovery feed: ONE open RFQ. The venue filters state server-side (default open);
    // the stub mirrors that — a state the row doesn't match answers empty, not unfiltered.
    const state = new URL(url).searchParams.get("state") ?? "open";
    // underwriter= (venue 0.4.1): only RFQs this underwriter has ANSWERED. The stub RFQ's two
    // answers come from the resting maker and the soft underwriter; any other address gets an
    // honestly empty feed, never an unfiltered one.
    const underwriter = new URL(url).searchParams.get("underwriter");
    const answeredBy = new Set([RESTING_MAKER.address.toLowerCase(), SOFT_UNDERWRITER.toLowerCase()]);
    // The venue's REAL envelope shape (cork-api get-rfqs.schema.ts, verified against staging
    // 2026-09-21): row-level facts beside `request`, the requester's body stored verbatim. A
    // flat row here hid a boundary defect for three rc cuts — never flatten a fixture the venue
    // does not flatten.
    const request = { chain_id: 42161, requester: RC2_CLONE_OWNER, fill_sender: RC2_CLONE_OWNER, reference_asset: "0xdDb46999F8891663a8F2828d25298f70416d7610", collateral_asset: { exact: "0x211Cc4DD073734dA055fbF44a2b4667d5E5fE5d2" }, modes: ["liquidity_only"], package_ids: ["pkg_default"], notional_assets: "1000000000000000000000", expiry_window: { not_before: 1900000000, not_after: 1910000000 }, valid_until: 1795000000, schema_version: "2", kind: "new_position" };
    // RFQ v2 serves `kind` on the row and strips every signature from reads.
    const row = { rfq_id: RFQ_OPEN_ID, kind: "new_position", state: "open", received_at: 1789000000, version: 3, request };
    // GET /rfqs/v2/{rfq_id} — the single-record read. Without this the feed lists an RFQ that
    // then reads back as rfq_not_found, and an agent that verifies before it submits is told
    // the work does not exist. That punishes the exact caution [K3] asks for, so serve it.
    // Answers embed only when asked (with_answers, or the single-record read): one FIRM answer
    // (the resting row cites it) and one SOFT answer nobody backed — the offers view's two cases.
    const answers = [
      { answer_id: FIRM_ANSWER_ID, underwriter: RESTING_MAKER.address, answer: { status: "quoted", options: [{ option_id: "opt1", premium_annualized: "0.05", expiry: 1900000000 }] } },
      { answer_id: SOFT_ANSWER_ID, underwriter: SOFT_UNDERWRITER, answer: { status: "quoted", options: [{ option_id: "opt1", premium_annualized: "0.03", expiry: 1900000000 }] } },
    ];
    const withAnswers = new URL(url).searchParams.get("with_answers") === "true";
    const single = /\/rfqs\/v2\/([^/?]+)/.exec(url)?.[1];
    if (single !== undefined) {
      const id = decodeURIComponent(single);
      if (id === RFQ_OPEN_ID) return r(200, { ...row, answers, answer_count: answers.length });
      if (id === RFQ_ROLLOVER_ID) {
        // A rollover RFQ (RFQ v2 kind "rollover") with one quote into an existing pool — what a
        // rollover-intent quoteRef accepts.
        const rollRequest = { schema_version: "2", kind: "rollover", chain_id: 42161, requester: RFQ_ROLLOVER_REQUESTER.toLowerCase(), source: { pool_id: `0x${"11".repeat(32)}`, shares: "250000000000000000000" }, reference_asset: "0x9d39a5de30e57443bff2a8307a4256c8797a3497", collateral_asset: { exact: "0x53e82abbb12638f09d9e624578ccb666217a765e" }, expiry_window: { not_before: 1795000000, not_after: 1797600000 }, premium_token: { exact: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" }, valid_until: 1794900000 };
        const rollAnswers = [{ answer_id: "ans_0roll1", underwriter: RESTING_MAKER.address, answer: { schema_version: "2", kind: "rollover", status: "quoted", options: [{ option_id: "opt1", chain_id: 42161, destination: { pool_id: `0x${"22".repeat(32)}` }, premium_token: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", premium_per_share: "5000000", shares_max: "250000000000000000000", fresh_until: 1794900000 }] } }];
        return r(200, { rfq_id: RFQ_ROLLOVER_ID, kind: "rollover", state: "open", received_at: 1789000000, version: 1, request: rollRequest, answers: rollAnswers, answer_count: 1 });
      }
      if (id === RFQ_NOSENDER_ID) {
        const { fill_sender: _omit, ...noSender } = request;
        return r(200, { ...row, request: noSender, rfq_id: RFQ_NOSENDER_ID, answers: [], answer_count: 0 });
      }
      if (id === RFQ_INLINE_ID) {
        const inlineTemplate = (anchor: string) => ({ inline: { oracle_recipe: LIQUIDITY_RECIPE, oracle_params: { schema: "cork-inline-liquidity/1", anchor_rate: anchor, expiry: String(JIT_TASK_EXPIRY), swap_fee_wad: "1000000000000000000", unwind_swap_fee_wad: "0" } } });
        const inlineAnswers = [{ answer_id: RFQ_INLINE_ANSWER_ID, underwriter: RESTING_MAKER.address, answer: { status: "quoted", options: [{ option_id: "opt1", premium_annualized: "0.05", expiry: Number(JIT_TASK_EXPIRY), market_template: inlineTemplate(RFQ_INLINE_OPTION_ANCHOR) }] } }];
        return r(200, { ...row, rfq_id: RFQ_INLINE_ID, request: { ...request, market_template: inlineTemplate(RFQ_INLINE_ANCHOR) }, answers: inlineAnswers, answer_count: 1 });
      }
      if (id === RFQ_IMPAIRMENT_ID || id === RFQ_IMPAIRMENT_PARTIAL_ID) {
        const params: Record<string, string> = { schema: "cork-inline-impairment/1", anchor_rate: RFQ_INLINE_ANCHOR, duration_seconds: RFQ_IMPAIRMENT_DURATION, expiry: RFQ_IMPAIRMENT_EXPIRY, swap_fee_wad: "1000000000000000000", unwind_swap_fee_wad: "0" };
        if (id === RFQ_IMPAIRMENT_ID) params.apy_spread_percentage = RFQ_IMPAIRMENT_SPREAD;
        const window = { not_before: Number(RFQ_IMPAIRMENT_EXPIRY) - 86_400, not_after: Number(RFQ_IMPAIRMENT_EXPIRY) + 86_400 };
        return r(200, { ...row, rfq_id: id, request: { ...request, modes: ["liquidity_impairment"], expiry_window: window, market_template: { inline: { oracle_recipe: IMPAIRMENT_RECIPE, oracle_params: params } } }, answers: [], answer_count: 0 });
      }
      if (id === RFQ_FIXED_ID || id === RFQ_FIXED_ABOVE_ID) {
        const fixedTemplate = (rate: string) => ({ inline: { oracle_recipe: FIXED_RECIPE, oracle_params: { schema: "cork-inline-fixed/1", rate_override: rate, expiry: RFQ_IMPAIRMENT_EXPIRY, swap_fee_wad: "0", unwind_swap_fee_wad: "0" } } });
        const window = { not_before: Number(RFQ_IMPAIRMENT_EXPIRY) - 86_400, not_after: Number(RFQ_IMPAIRMENT_EXPIRY) + 86_400 };
        const fixedAnswers = id === RFQ_FIXED_ID ? [{ answer_id: RFQ_FIXED_ANSWER_ID, underwriter: RESTING_MAKER.address, answer: { status: "quoted", options: [{ option_id: "opt1", mode: "fixed_rate", premium_annualized: "0.05", expiry: Number(RFQ_IMPAIRMENT_EXPIRY), market_template: fixedTemplate(RFQ_FIXED_OPTION_RATE) }] } }] : [];
        return r(200, { ...row, rfq_id: id, request: { ...request, modes: ["fixed_rate"], expiry_window: window, market_template: fixedTemplate(id === RFQ_FIXED_ID ? RFQ_FIXED_RATE : RFQ_FIXED_ABOVE_RATE) }, answers: fixedAnswers, answer_count: fixedAnswers.length });
      }
      return r(404, { message: `unknown rfq ${single}` });
    }
    // kind= (RFQ v2): the stub's one RFQ is a new-position request.
    const kind = new URL(url).searchParams.get("kind");
    const listed = state === "open" && (underwriter === null || answeredBy.has(underwriter.toLowerCase())) && (kind === null || kind === "new_position");
    return r(200, { items: listed ? [withAnswers ? { ...row, answers, answer_count: answers.length } : row] : [], nextCursor: null, hasMore: false });
  }
  if (url.includes("/limit-orders/v1/orderbook")) return r(200, { items: [RESTING_ROW, RESERVED_ROW] });
  if (url.includes("/limit-orders/")) return r(200, { items: [] });
  return r(404, { message: `no stub for ${url}` });
}

export function stubContext(): HandlerContext {
  return {
    nowSeconds: NOW,
    venueFetch,
    hyperSync: whitelistHyperSync(),
    rpcUrl: "https://stub.vnet.example/rpc", // enables the funding path; resolver below serves it
    resolveRpc: async (chainId, url) => ({
      url: url ?? "https://stub.vnet.example/rpc",
      source: "explicit" as const,
      client: {
        readContract: async (a: never) => readContract(a, chainId),
        // Share PREDICTION for a pool that does not exist: production simulates the JIT
        // creation via eth_simulateV1 and reads shares from the in-memory pool — so
        // derive-cork-pool reports exists:false with shares "simulated", matching the JIT
        // tasks' premise. The fixed recipe's deploy-then-resolve runs through the same call.
        simulateCalls: async (a: { calls: SimCall[] }) => simulateCalls(a),
        // Code is ADDRESS-AWARE, not blanket: the ForSelf adapter is a CONTRACT (its bindings
        // are verified before a caller grants it an allowance, and a codeless address is
        // correctly refused adapter_binding_mismatch), while every other fixture account stays
        // an EOA so the maker-signature ladder takes its ecrecover branch rather than ERC-1271.
        getCode: async (a: { address?: string } | undefined) => {
          const address = String(a?.address ?? "").toLowerCase();
          if (address === FORSELF_ADAPTER.toLowerCase()) return FORSELF_ADAPTER_CODE;
          if (address === predictedFixedOracle(DEPLOYED_FIXED_RATE).toLowerCase()) return "0x6080604052";
          // The fixture TOKENS are deployed contracts in this world: the maker-readiness probe
          // reads eth_getCode on the makerAsset, and a code-less token is the silent-noop class
          // the ranked book excludes — healthy fixture rows must not be that.
          if (address === CST.toLowerCase() || address === SUSDE.toLowerCase() || address === VBUSDC.toLowerCase()) return "0x6080604052";
          // The implementation guard hashes the code behind each trusted role. This stub holds
          // no real bytecode, so "0x" here would be a FALSE statement ("the adapter is an empty
          // account") that warns implementation_not_approved on every prepare and skews
          // grading. Throwing is the honest answer — unreadable — which the guard documents as
          // silent degradation. The guard itself is covered by Layer A.
          if (IMPLEMENTATION_ROLE_ADDRESSES.has(address)) throw new Error(`eval stub holds no bytecode for ${address}`);
          return "0x";
        },
        // track simulate's eth_call dry-run: every frozen artifact simulates viable here (the
        // task grades the simulate-before-sign habit, not revert forensics).
        call: async () => ({ data: "0x" }),
        estimateGas: async () => 100_000n,
        getBlockNumber: async () => 23_000_000n,
        // eth_getLogs — the tokenless MarketCreated scan (the positions sweep's DEFAULT
        // enumeration, over the caller's RPC alone). Serves the two migration pools' creation
        // logs on 42161, scoped by the requested address set and block range like a real node;
        // every other chain answers an honestly empty log set.
        request: async (a: { method: string; params: Array<{ fromBlock?: string; toBlock?: string; address?: string[]; topics?: Array<string[] | string | null> }> }) => {
          if (a.method !== "eth_getLogs") throw new Error(`eval stub: unsupported request ${a.method}`);
          if (chainId !== 42161) return [];
          const q = a.params[0] ?? {};
          const from = q.fromBlock ? Number(q.fromBlock) : 0;
          const to = q.toBlock ? Number(q.toBlock) : Number.MAX_SAFE_INTEGER;
          const scope = new Set((q.address ?? []).map((x) => x.toLowerCase()));
          const t0 = q.topics?.[0];
          const wanted = new Set(Array.isArray(t0) ? t0 : t0 ? [t0] : []);
          return migrationMarketLogs()
            .filter((l) => l.blockNumber >= from && l.blockNumber <= to && (scope.size === 0 || scope.has(l.address.toLowerCase())) && (wanted.size === 0 || wanted.has(l.topics[0]!)))
            .map((l) => ({ address: l.address, topics: l.topics, data: l.data, blockNumber: `0x${l.blockNumber.toString(16)}`, transactionHash: l.transactionHash }));
        },
        getBlock: async () => ({ timestamp: NOW }),
        getTransactionReceipt: async () => ({ status: "success", blockNumber: 23_000_000n, gasUsed: 21_000n, logs: [] }),
      } as never,
    }),
  };
}

// ── finalize-maker-order fixture: a REAL prepared order + a REAL external signature ─────────
// Built through the SAME runTool path an agent would call (never a hand-assembled twin — the
// duplicate-value rot class), then signed by a throwaway key that IS the order's maker. The
// finalize handler ecrecovers it against its own reconstruction for real; the exported nonce is
// the prepared result's own derived value (the listing must carry it exactly).
/** The prepare AND finalize request id: finalization is the SAME request as its prepare [K2],
 *  so the handler refuses a prepared context whose clientRequestId differs (prepared_context_
 *  mismatch). Exported so the task prompt cannot drift from the fixture it hands the agent. */
export const FINALIZE_REQUEST_ID = "eval-fin-0001";
const FINALIZE_MAKER = privateKeyToAccount(`0x${"0b".repeat(32)}`);
const preparedEnv = await runTool(
  "cork_prepare_orders",
  {
    chainId: 1,
    account: FINALIZE_MAKER.address,
    clientRequestId: FINALIZE_REQUEST_ID,
    action: { type: "maker-order", poolId: DEMO_POOL_ID, side: "SELL", makerAsset: SUSDE, takerAsset: VBUSDC, makingAmount: "1000000000000000000", takingAmount: "1000000" },
  },
  stubContext(),
);
if (preparedEnv.state !== "ok") throw new Error(`finalize fixture: maker-order prepare answered ${preparedEnv.state} — fixture rot`);
/** The exact `data` object maker-order returned (finalize takes it verbatim; the wire schema
 *  strips the round-tripped extras itself). */
export const PREPARED_MAKER_ORDER = preparedEnv.data as { orderHash: string; nonce: string };
/** The maker's REAL signature over the prepared order hash — external to the tools [K1]. */
export const FINALIZE_SIGNATURE = await FINALIZE_MAKER.sign({ hash: PREPARED_MAKER_ORDER.orderHash as `0x${string}` });

/** The same signature with ONE byte of `r` flipped: recovers to a stranger, never the maker. The
 *  conflict-family eval task feeds it to finalize-maker-order, which must refuse
 *  signature_or_reconstruction_mismatch and relay nothing. */
export const TAMPERED_FINALIZE_SIGNATURE = (() => {
  const sig = FINALIZE_SIGNATURE;
  const byte = parseInt(sig.slice(4, 6), 16) ^ 0x01;
  return `${sig.slice(0, 4)}${byte.toString(16).padStart(2, "0")}${sig.slice(6)}` as `0x${string}`;
})();

/** A resting order on 42161 whose extension names a STRANGER contract as the postInteraction
 *  hook (owner requirement 2026-09-23): taker-fill must refuse it — foreign_extension_target, no
 *  bytes. Built from the canonical auction extension so the getters stay the pinned settlement
 *  and ONLY the hook is foreign; salt bound to the extension (OrderLib), HAS_EXTENSION set. */
export const FOREIGN_HOOK_SIGNED_ORDER = await (async () => {
  const example = (TOOL_EXAMPLES.cork_compute!.find((e) => (e.input as { params?: { kind?: string } }).params?.kind === "dutch-auction-price")!.input as { params: { order: { extension: `0x${string}` } } }).params.order.extension;
  const fields = decodeExtensionFields(example);
  const extension = encodeExtensionFields({ ...fields, postInteractionData: "0xbad0000000000000000000000000000000000baddeadbeef" as `0x${string}` });
  const salt = (1n << 200n) | (BigInt(keccak256(extension)) & ((1n << 160n) - 1n));
  const order = { salt, maker: RESTING_MAKER.address, receiver: "0x0000000000000000000000000000000000000000", makerAsset: SUSDE, takerAsset: VBUSDC, makingAmount: 10n ** 18n, takingAmount: 1_000_000n, makerTraits: (1n << 249n) | (1n << 255n) } as const;
  const orderHash = hashLopOrder(42161, LOP_ADDRESSES[42161]!, order);
  const wire = Object.fromEntries(Object.entries(order).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : String(v)]));
  return { orderHash, signedOrder: { order: wire, signature: await RESTING_MAKER.sign({ hash: orderHash }), extension } };
})();
// ── grouped-rung fixture: one rung of a REAL one-cancels-the-other ladder ────────────────────
// Built through the ladder path itself (never a hand-assembled twin): the cancel task hands the
// agent this rung's SIGNED traits and asks what a cancel retires. Exported so the prompt cannot
// drift from the fixture, and so the fixture test can check the sibling shares the nonce.
export const LADDER_REQUEST_ID = "eval-ladder-fixture-0001";
const ladderEnv = await runTool(
  "cork_prepare_orders",
  {
    chainId: 1,
    account: DEMO_ACCOUNT_ADDR,
    clientRequestId: LADDER_REQUEST_ID,
    action: {
      type: "maker-ladder",
      poolId: DEMO_POOL_ID,
      side: "SELL",
      makerAsset: SUSDE,
      takerAsset: VBUSDC,
      makingAmount: "1000000000000000000",
      expirySeconds: 600,
      rungs: [{ takingAmount: "1000000", allowedSender: RESERVED_FILLER }, { takingAmount: "950000", allowedSender: RESERVED_FILLER }, { takingAmount: "980000" }],
    },
  },
  stubContext(),
);
if (ladderEnv.state !== "ok") throw new Error(`ladder fixture: maker-ladder answered ${ladderEnv.state} — fixture rot`);
const ladderRungs = (ladderEnv.data as { rungs: Array<{ orderHash: `0x${string}`; nonce: string; grouped: boolean; typedData: { message: { makerTraits: string } } }> }).rungs;
/** Rung 0 of the fixture ladder (reserved, grouped with rung 1) plus what a cancel of it must
 *  report: rung 1 shares the nonce, rung 2 (open, shared-reserved policy) does not. */
export const GROUPED_RUNG = {
  orderHash: ladderRungs[0]!.orderHash,
  makerTraits: ladderRungs[0]!.typedData.message.makerTraits,
  nonce: ladderRungs[0]!.nonce,
  siblingNonce: ladderRungs[1]!.nonce,
  openRungNonce: ladderRungs[2]!.nonce,
};

// ── decode receipt fixture: GENUINE encoded logs, never hand-pasted hex ──────────────────────
// Two logs from one plausible fill transaction: the LOP's own OrderFilled and the cST transfer
// it caused. Encoded here with viem from the same event signatures the decoder's ABI set
// declares, so a signature change breaks the fixture loudly instead of decoding to "raw".
const ORDER_FILLED = parseAbiItem("event OrderFilled(bytes32 orderHash, uint256 remainingAmount)");
const ERC20_TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
export const DEMO_RECEIPT = {
  status: "success",
  blockNumber: 23_000_000,
  gasUsed: 210_000,
  logs: [
    {
      address: LOP_ADDRESSES[1]!,
      topics: encodeEventTopics({ abi: [ORDER_FILLED] }),
      data: encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [RESTING_ORDER_HASH, 0n]),
    },
    {
      address: CST,
      topics: encodeEventTopics({ abi: [ERC20_TRANSFER], args: { from: RESTING_MAKER.address, to: DEMO_ACCOUNT_ADDR } }),
      data: pad("0xde0b6b3a7640000", { size: 32 }),
    },
  ],
};
