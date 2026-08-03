// Offline chain stub for agent evals: a fake resolved RPC whose client serves the canonical
// demo-pool fixture state (notes/experiments/03-vnet-fixture.md) so eval runs need NO network
// except the LLM API — deterministic, CI-friendly, and identical between runs.
import type { HandlerContext } from "@cork/core";
import { DEMO_POOL_ID } from "@cork/schemas";

const SUSDE = "0x9D39A5DE30e57443BfF2A8307A4256c8797A3497";
const VBUSDC = "0x53E82ABbb12638F09d9e624578ccB666217a765e";
const ORACLE = "0x14115b5fdab3afcd72cf03785041c720100edb0e";
const CPT = "0xc37d9aCe13C63806c6fA475aD507E94c70b6e110";
const CST = "0x16Aa2EbE1E2D6C856c634DaFc256257d2fEc0C69";
const NOW = 1_790_000_000n;

// MarketRegistry 2.1.0 fixture (Arbitrum, matches cork-defaults.json so the binding guard passes).
const REGISTRY_210 = "0x47C3AF38435Db64D9400c30575E4c10482c0752D";
export const LIQUIDITY_RECIPE = "0xA39d552802b2D3A9be6F5DCDD2C6961DaeD1234D";
export const FIXED_RECIPE = "0xA85cFa6E66f301a18D182A8304f5C4afEf5b4682";
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

function readContract(args: { address: string; functionName: string; args?: unknown[] }): unknown {
  const poolId = args.args?.[0];
  const known = typeof poolId !== "string" || poolId.toLowerCase() === DEMO_POOL_ID.toLowerCase();
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

/** Offline venue stub: canned api-phoenix responses for the eval tasks. */
function venueFetch(url: string, init?: RequestInit): Promise<Response> {
  const r = (status: number, body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status }));
  if (init?.method === "POST") {
    if (url.includes("/rollover/orders")) return r(201, {}); // handler fills the digest from its local recomputation
    if (url.includes("/limit-orders")) return r(201, { orderHash: "0x" });
    if (url.includes("/rfqs")) return r(201, { rfq_id: "rfq_eval1", state: "open" });
  }
  if (url.includes("/pools")) return r(200, { items: [{ chainId: 1, poolId: DEMO_POOL_ID, poolName: "sUSDe-vbUSDC-DEMO" }] });
  if (/\/rollover\/orders\/0x/.test(url)) return r(404, { message: "not found" });
  if (url.includes("/rollover/")) return r(200, { items: [] });
  if (url.includes("/limit-orders/")) return r(200, { items: [] });
  return r(404, { message: `no stub for ${url}` });
}

export function stubContext(): HandlerContext {
  return {
    nowSeconds: NOW,
    venueFetch,
    hyperSync: whitelistHyperSync(),
    rpcUrl: "https://stub.vnet.example/rpc", // enables the funding path; resolver below serves it
    resolveRpc: async (_chainId, url) => ({
      url: url ?? "https://stub.vnet.example/rpc",
      source: "explicit" as const,
      client: {
        readContract: async (a: never) => readContract(a),
        getBlockNumber: async () => 23_000_000n,
        getBlock: async () => ({ timestamp: NOW }),
        getTransactionReceipt: async () => ({ status: "success", blockNumber: 23_000_000n, gasUsed: 21_000n, logs: [] }),
      } as never,
    }),
  };
}
