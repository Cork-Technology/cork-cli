// Offline chain stub for agent evals: a fake resolved RPC whose client serves the canonical
// demo-pool fixture state (the vnet fixture pool 0xceeb…c16a) so eval runs need NO network
// except the LLM API — deterministic, CI-friendly, and identical between runs.
import { allowedSenderSuffix, buildRolloverIntent, computeMarketId, type HandlerContext, hashLopOrder, LOP_ADDRESSES, type LopOrder, runTool } from "@cork/core";
import { privateKeyToAccount } from "viem/accounts";
import { encodeAbiParameters, encodeEventTopics, parseAbiItem, pad } from "viem";
import { DEMO_ACCOUNT as DEMO_ACCOUNT_ADDR, DEMO_POOL_ID } from "@cork/schemas";

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
// Every address the approved-implementations guard may fingerprint, from the same config the
// guard resolves them from — so a redeploy cannot leave this set pointing at a stale literal.
const IMPLEMENTATION_ROLE_ADDRESSES = new Set(
  Object.values(corkDefaults.deployments as Record<string, { corkAdapter?: string; whitelistManager?: string }>)
    .flatMap((d) => [d.corkAdapter, d.whitelistManager])
    .concat(Object.values((corkDefaults as { marketRegistry?: Record<string, { registry?: string; adapter?: string; marketCreator?: string }> }).marketRegistry ?? {}).flatMap((m) => [m.registry, m.adapter, m.marketCreator]))
    .concat(Object.values((corkDefaults as { marketRegistryLegacy?: Record<string, { registry?: string; adapter?: string }> }).marketRegistryLegacy ?? {}).flatMap((m) => [m.registry, m.adapter]))
    .filter((a): a is string => typeof a === "string")
    .map((a) => a.toLowerCase()),
);
// The rc.2 rollover deployment + its RETIRED July generation — read from config like the
// registry above (the pinned-literal rot class): the retired-settler task's expected teaching
// and the sweep fixture's settler identity must track config, not a copy.
type RolloverCfg = { factory: string; exactSettler: string; partialSettler: string; legacyGenerations?: Array<{ exactSettler: string; partialSettler: string }> };
const ROLLOVER_42161 = (corkDefaults as { rollover: Record<string, RolloverCfg> }).rollover["42161"]!;
export const RC2_EXACT_SETTLER = ROLLOVER_42161.exactSettler;
export const RC2_FACTORY = ROLLOVER_42161.factory;
export const RETIRED_EXACT_SETTLER = ROLLOVER_42161.legacyGenerations![0]!.exactSettler;
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
      // Only the known (existing) pool answers live share addresses. A blanket answer made
      // EVERY derived pool read exists:true with shares "read" — contradicting the JIT tasks'
      // own premise ("destination pool does not exist yet"); the honest prediction path is the
      // creation SIMULATION below (observed 2026-08-27: an agent that probed derive-cork-pool
      // was told the pool already existed and graded down for believing it).
      return known ? [CPT, CST] : ["0x0000000000000000000000000000000000000000", "0x0000000000000000000000000000000000000000"];
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
    case "orderStatus":
      // The venue-miss sweep fixture: ONE digest the venue archived but the RETIRED July exact
      // settler still holds as Settled (enum 2); every other (settler, digest) answers None.
      return args.address.toLowerCase() === RETIRED_EXACT_SETTLER.toLowerCase() && String(args.args?.[0]).toLowerCase() === ARCHIVED_DIGEST ? 2 : 0;
    case "isWhitelisted":
      return false;
    case "isGlobalWhitelisted":
    case "isMarketWhitelisted":
      return true; // matches the seeded whitelist events below — verification leg agrees
    // ── MarketRegistry 2.1.0 surface (recipes as contracts; constraint via recipe.resolve) ──
    case "MARKET_REGISTRY":
      return REGISTRY_210; // adapter/creator immutable — keeps the binding guard green
    // ── CorkMarketCreator bindings + controller roles (the create-pool pre-flights): answer
    //    the CONFIGURED addresses per chain, like MARKET_REGISTRY above — a pinned literal
    //    here rots on every redeploy (the 0.3.2 lesson at the top of this file). ──
    case "POOL_MANAGER":
      return (corkDefaults as { deployments: Record<string, { poolManager?: string }> }).deployments[String(chainId)]?.poolManager ?? "0x0000000000000000000000000000000000000000";
    case "CONTROLLER":
      return (corkDefaults as { marketRegistry: Record<string, { controller?: string }> }).marketRegistry[String(chainId)]?.controller ?? "0x0000000000000000000000000000000000000000";
    case "FEE_MANAGER_ROLE":
      return `0x${"6c".repeat(32)}`; // any stable hash — the pre-flight uses the probed value itself
    case "hasRole":
      return true; // POOL_CREATOR + FEE_MANAGER granted (matches the live grants, 2026-08-28)
    case "maxExpiryDuration":
      return 2_592_000n; // 30 days — the live registry's value at last read
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
    // ── ForSelf adapter bindings (the Zyfai shape): the pre-flight verifies these on-chain
    //    before the caller grants the adapter an allowance, so they must answer the CONFIGURED
    //    addresses — a mismatch is a conflict, by design.
    case "CORK":
      // The ForSelf adapter binds the POOL MANAGER (not the Cork adapter) — the pre-flight
      // compares against exactly that, because an adapter pinned to another stack would route
      // the caller's allowance to the wrong protocol.
      return (corkDefaults as { deployments: Record<string, { poolManager: string }> }).deployments["1"]!.poolManager;
    case "LOP":
      return (corkDefaults as { lopAddresses: Record<string, string> }).lopAddresses["1"]!;
    case "WHITELIST":
      // A pre-caller-gate adapter has no such view. A REVERT here is explicitly not a conflict
      // (the pre-flight adapts) — serving it proves that branch instead of the happy one.
      throw Object.assign(new Error("execution reverted"), { shortMessage: 'The contract function "WHITELIST" reverted.' });
    case "predictFixedRateOracle":
      return "0xF10000000000000000000000000000000000000d"; // CREATE2-predicted, not yet deployed (getCode answers "0x")
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

/** A rollover orderDigest the venue no longer serves (its generation is archived) but whose
 *  state survives on-chain at the retired settler — the track venue-miss sweep fixture. */
export const ARCHIVED_DIGEST = `0x${"5e".repeat(32)}`;

/** The one open RFQ on the venue stub's discovery feed (the rfq-read task's ground truth). */
export const RFQ_OPEN_ID = "rfq_open7";
/** The id the venue assigns an underwriter's answer (the rfq-answer task's ground truth). */
export const RFQ_ANSWER_ID = "ans_eval1";

/** An integrator-deployed Cork ForSelf adapter (the Zyfai parameter-blind session-key shape).
 *  NOT a Cork deployment — the tool verifies its CORK()/LOP() bindings on-chain precisely
 *  because the caller is about to grant IT the token allowances. */
export const FORSELF_ADAPTER = "0x5ea500000000000000000000000000000000aDa0"; // EIP-55 checksummed: the Address schema enforces it
const FORSELF_ADAPTER_CODE = "0x60806040523480156100";

/** One rc.2 rollover clone on the venue's contracts feed (the factory-filter task). */
export const RC2_CLONE = "0x96f126A8503145201A60Bf9BdB29fE26E40cCA14";
const RC2_CLONE_OWNER = "0x303Dd0B6835b4b4739d35F16A123e77D5A7dCFFF";

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
export const DERIVED_JIT_POOL = computeMarketId({
  ...JIT_TASK_PAIR,
  expiryTimestamp: JIT_TASK_EXPIRY,
  rateMin: BigInt(JIT_TASK_CONSTRAINT.rateMin),
  rateMax: BigInt(JIT_TASK_CONSTRAINT.rateMax),
  rateChangePerDayMax: BigInt(JIT_TASK_CONSTRAINT.rateChangePerDayMax),
  rateChangeCapacityMax: BigInt(JIT_TASK_CONSTRAINT.rateChangeCapacityMax),
  rateOracle: ORACLE,
});

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
const RESTING_ROW: Record<string, string> = {
  ...SIGNED_LOP_PAYLOAD.order,
  signature: SIGNED_LOP_PAYLOAD.signature,
  extension: "0x",
  makerAccountType: "EOA",
  orderHash: RESTING_ORDER_HASH,
};

// A RESERVED sibling on the same book: same maker, same economics, but its signed makerTraits
// carry an allowed-sender suffix that is NOT the eval taker's — so the exclusivity refusal
// (private_order) grades end-to-end against real signed bytes, exactly as the tool judges it.
// The reserved filler is a nobody: only its LAST 10 BYTES exist in the order.
export const RESERVED_FILLER = "0x00000000000000000000badbadbadbadbadbadb1";
const RESERVED_ORDER: LopOrder = { ...RESTING_ORDER, salt: 8n, makerTraits: BigInt(allowedSenderSuffix(RESERVED_FILLER)) };
export const RESERVED_ORDER_HASH = hashLopOrder(1, LOP_ADDRESSES[1]!, RESERVED_ORDER);
const RESERVED_ROW: Record<string, string> = {
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
    // /rfqs/v1/{id}/answers answers with an ANSWER id; the open endpoint with an RFQ id. A
    // stub that returned rfq_id for both would let the handler's `answer_id ?? null` read null
    // and still look accepted — the field the underwriter needs, quietly absent.
    if (url.includes("/answers")) return r(201, { answer_id: RFQ_ANSWER_ID, rfq_id: RFQ_OPEN_ID });
    if (url.includes("/rfqs")) return r(201, { rfq_id: "rfq_eval1", state: "open" });
  }
  if (url.includes("/pools")) return r(200, { items: [{ chainId: 1, poolId: DEMO_POOL_ID, poolName: "sUSDe-vbUSDC-DEMO" }] });
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
  if (/\/rfqs\/v1(\/|\?|$)/.test(url)) {
    // The discovery feed: ONE open RFQ. The venue filters state server-side (default open);
    // the stub mirrors that — a state the row doesn't match answers empty, not unfiltered.
    const state = new URL(url).searchParams.get("state") ?? "open";
    const row = { rfq_id: RFQ_OPEN_ID, state: "open", chain_id: 42161, requester: RC2_CLONE_OWNER, reference_asset: "0xdDb46999F8891663a8F2828d25298f70416d7610", collateral_asset: { exact: "0x211Cc4DD073734dA055fbF44a2b4667d5E5fE5d2" }, modes: ["liquidity_only"], notional_assets: "1000000000000000000000", expiry_window: { not_before: 1900000000, not_after: 1910000000 }, valid_until: 1795000000, version: 3 };
    // GET /rfqs/v1/{rfq_id} — the single-record read. Without this the feed lists an RFQ that
    // then reads back as rfq_not_found, and an agent that verifies before it submits is told
    // the work does not exist. That punishes the exact caution [K3] asks for, so serve it.
    const single = /\/rfqs\/v1\/([^/?]+)/.exec(url)?.[1];
    if (single !== undefined) {
      return decodeURIComponent(single) === RFQ_OPEN_ID ? r(200, row) : r(404, { message: `unknown rfq ${single}` });
    }
    return r(200, { items: state === "open" ? [row] : [], nextCursor: null, hasMore: false });
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
        // creation via eth_simulateV1 and reads shares from the in-memory pool. The stub
        // answers that simulation with every leg green and the final shares read encoding
        // [cPT, cST] — so derive-cork-pool reports exists:false with shares "simulated",
        // matching the JIT tasks' premise.
        simulateCalls: async (a: { calls: Array<{ to?: string; data?: string }> }) => ({
          results: a.calls.map((_, i) =>
            i === a.calls.length - 1
              ? { status: "success", data: `0x${CPT.slice(2).toLowerCase().padStart(64, "0")}${CST.slice(2).toLowerCase().padStart(64, "0")}` }
              : { status: "success", data: "0x" },
          ),
        }),
        // Code is ADDRESS-AWARE, not blanket: the ForSelf adapter is a CONTRACT (its bindings
        // are verified before a caller grants it an allowance, and a codeless address is
        // correctly refused adapter_binding_mismatch), while every other fixture account stays
        // an EOA so the maker-signature ladder takes its ecrecover branch rather than ERC-1271.
        getCode: async (a: { address?: string } | undefined) => {
          const address = String(a?.address ?? "").toLowerCase();
          if (address === FORSELF_ADAPTER.toLowerCase()) return FORSELF_ADAPTER_CODE;
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
