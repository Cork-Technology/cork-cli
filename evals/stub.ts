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
    default:
      throw new Error(`stub has no fixture for ${args.functionName}`);
  }
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
