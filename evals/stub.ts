// Offline chain stub for agent evals: a fake resolved RPC whose client serves the canonical
// demo-pool fixture state (the vnet fixture pool 0xceeb…c16a) so eval runs need NO network
// except the LLM API — deterministic, CI-friendly, and identical between runs.
import { type HandlerContext, hashLopOrder, LOP_ADDRESSES, type LopOrder } from "@cork/core";
import { privateKeyToAccount } from "viem/accounts";
import { DEMO_POOL_ID } from "@cork/schemas";

const SUSDE = "0x9D39A5DE30e57443BfF2A8307A4256c8797A3497";
const VBUSDC = "0x53E82ABbb12638F09d9e624578ccB666217a765e";
const ORACLE = "0x14115b5fdab3afcd72cf03785041c720100edb0e";
const CPT = "0xc37d9aCe13C63806c6fA475aD507E94c70b6e110";
/** Exported so eval-task answer regexes derive from THIS constant instead of re-pinning the
 *  literal (the same import-don't-duplicate rule as LIQUIDITY_RECIPE below). */
export const CST = "0x16Aa2EbE1E2D6C856c634DaFc256257d2fEc0C69";
const NOW = 1_790_000_000n;

// MarketRegistry 2.1.0 fixture — READ FROM cork-defaults.json rather than pinned: the binding
// guard compares the stub's MARKET_REGISTRY() answer against the live config, so a hardcoded
// address here rots on every registry redeploy (the pinned 0.3.2 literal survived the 0.3.3
// redeploy and silently turned two eval tasks red via adapter_binding_mismatch — found 2026-08-10
// only because the eval log made the misses identifiable). Same for the recipe hints.
import corkDefaults from "../cork-defaults.json";
const MR_42161 = (corkDefaults as { marketRegistry: Record<string, { registry: string; recipes: Record<string, string> }> }).marketRegistry["42161"]!;
const REGISTRY_210 = MR_42161.registry;
export const LIQUIDITY_RECIPE = MR_42161.recipes.liquidity!;
export const FIXED_RECIPE = MR_42161.recipes.fixed!;
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
  const known = (typeof poolId !== "string" || poolId.toLowerCase() === DEMO_POOL_ID.toLowerCase()) && chainId === 1;
  switch (args.functionName) {
    case "market":
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
      return [CPT, CST];
    case "rate":
      return 800_000_000_000_000_000n;
    case "decimals":
      return args.address.toLowerCase() === VBUSDC.toLowerCase() ? 6 : 18;
    case "issuedAt":
      return NOW - 604_800n;
    case "balanceOf":
      return 42_000_000_000_000_000_000n;
    case "allowance":
      return 0n;
    case "bitInvalidatorForOrder":
      return 0n; // untouched slot — the resting order reads LIVE to the fill's pre-flight [K7]
    case "isWhitelisted":
      return false;
    case "isGlobalWhitelisted":
    case "isMarketWhitelisted":
      return true; // matches the seeded whitelist events below — verification leg agrees
    // ── MarketRegistry 2.1.0 surface (recipes as contracts; constraint via recipe.resolve) ──
    case "MARKET_REGISTRY":
      return REGISTRY_210; // adapter immutable — keeps the binding guard green
    case "isRecipe": {
      const a = String(args.args?.[0] ?? "").toLowerCase();
      return a === LIQUIDITY_RECIPE.toLowerCase() || a === FIXED_RECIPE.toLowerCase();
    }
    case "getRecipes":
      return [[LIQUIDITY_RECIPE, FIXED_RECIPE], 2n];
    case "source":
      return args.address.toLowerCase() === FIXED_RECIPE.toLowerCase() ? 2 : 1; // RecipeSource: PRICE=1, FIXED=2
    case "description":
      return args.address.toLowerCase() === FIXED_RECIPE.toLowerCase() ? "Fixed rate: a window of WINDOW_WIDTH around the fixed oracle rate." : "Liquidity: the widest rate window CorkPoolManager will accept.";
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
    case "lookupWrapper":
      return ORACLE; // pair oracle deployed; its rate() is served above
    case "resolve":
      // The liquidity shape at rate 0.8e18: floor 1 wei, ceiling 2×rate, per-day rate, capacity 3×rate.
      return { rateMin: 1n, rateMax: 1_600_000_000_000_000_000n, rateChangePerDayMax: 800_000_000_000_000_000n, rateChangeCapacityMax: 2_400_000_000_000_000_000n };
    case "verify":
      return true;
    case "symbol":
      return "sUSDe";
    case "name":
      return "Staked USDe";
    default:
      throw new Error(`stub has no fixture for ${args.functionName}`);
  }
}

// One seeded GlobalWhitelistAdded(WHITELISTED_ACCT) log so whitelisted-addresses has a
// deterministic non-empty answer. topic0 = keccak("GlobalWhitelistAdded(address)").
const WHITELISTED_ACCT = "0x00000000000000000000000000000000000a11ce";
const GLOBAL_ADDED_TOPIC = "0x3dfb644c437d7ac77310a6355571af9bcbf4d2e01c805141c03aa9786737a2c5";
function whitelistHyperSync() {
  return {
    async queryLogs(q: { topics?: Array<string[] | null> }) {
      const wanted = new Set(q.topics?.[0] ?? []);
      const logs = wanted.has(GLOBAL_ADDED_TOPIC)
        ? [{ address: "0xcCccCcCccCC6e38a2772Eb42D2f408eeB89cb0eE", topics: [GLOBAL_ADDED_TOPIC, `0x${WHITELISTED_ACCT.slice(2).padStart(64, "0")}`], data: "0x", blockNumber: 23_000_000, transactionHash: `0x${"aa".repeat(32)}` }]
        : [];
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
let restingRowMemo: Record<string, string> | undefined;
async function restingRow(): Promise<Record<string, string>> {
  restingRowMemo ??= {
    salt: RESTING_ORDER.salt.toString(),
    maker: RESTING_ORDER.maker,
    receiver: RESTING_ORDER.receiver,
    makerAsset: RESTING_ORDER.makerAsset,
    takerAsset: RESTING_ORDER.takerAsset,
    makingAmount: RESTING_ORDER.makingAmount.toString(),
    takingAmount: RESTING_ORDER.takingAmount.toString(),
    makerTraits: RESTING_ORDER.makerTraits.toString(),
    signature: await RESTING_MAKER.sign({ hash: RESTING_ORDER_HASH }),
    extension: "0x",
    makerAccountType: "EOA",
    orderHash: RESTING_ORDER_HASH,
  };
  return restingRowMemo;
}

/** Offline venue stub: canned api-phoenix responses for the eval tasks. */
async function venueFetch(url: string, init?: RequestInit): Promise<Response> {
  const r = (status: number, body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status }));
  if (init?.method === "POST") {
    if (url.includes("/rollover/v1/orders")) return r(201, {}); // handler fills the digest from its local recomputation
    if (url.includes("/limit-orders")) return r(201, { orderHash: "0x" });
    if (url.includes("/rfqs")) return r(201, { rfq_id: "rfq_eval1", state: "open" });
  }
  if (url.includes("/pools")) return r(200, { items: [{ chainId: 1, poolId: DEMO_POOL_ID, poolName: "sUSDe-vbUSDC-DEMO" }] });
  if (/\/rollover\/v1\/orders\/0x/.test(url)) return r(404, { message: "not found" });
  if (url.includes("/rollover/")) return r(200, { items: [] });
  if (url.includes("/limit-orders/v1/orderbook")) return r(200, { items: [await restingRow()] });
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
        getCode: async () => "0x", // every fixture account is an EOA
        getBlockNumber: async () => 23_000_000n,
        getBlock: async () => ({ timestamp: NOW }),
        getTransactionReceipt: async () => ({ status: "success", blockNumber: 23_000_000n, gasUsed: 21_000n, logs: [] }),
      } as never,
    }),
  };
}
