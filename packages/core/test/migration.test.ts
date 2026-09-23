// Migration (0.6, 2026-09-22; owner requirement: v0.6.0 supports the previous AND the current
// generation at once so users can move funds). Three surfaces: the `generation` ALIASES
// (`primary` / `previous` / the refused `all`) resolved in ONE place to a label; account-state
// WITHOUT a poolId = the account's positions across every generation (pool enumeration under the
// mode's pledge — the MarketCreated scan over your RPC by default, HyperSync under
// full-decentralized, the venue's list under hybrid —
// then a balance sweep, zero-position pools dropped, `expired` per pool, per-generation
// subtotals); and the `migration` doc topic. Offline: a venueFetch stub serves /pools/v1 rows per
// manager in pages, a stub HyperSync source serves the same pools as MarketCreated
// logs, and an address-aware `balanceOf` puts a position on two of three managers.
import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeEventTopics, parseAbi } from "viem";
import { DOC_TOPICS, findDocTopic } from "@cork/schemas";
import { BUNDLED_DEFAULTS, generationsOf, GENERATION_ALIASES, type HandlerContext, resolveGenerationAlias, runTool, selectGeneration, ToolInputError } from "@cork/core";
import { stubResolved } from "./helpers.ts";
import { expiryIsoOfSeconds, venueExpiry, venuePoolRowsToMarketRows } from "../src/handlers/query-positions.ts";

const NOW = 1_753_000_000n;
const CHAIN = 42161;
const ARBITRUM = generationsOf(BUNDLED_DEFAULTS, CHAIN);
const MAINNET = generationsOf(BUNDLED_DEFAULTS, 1);
const pmOf = (label: string) => ARBITRUM.find((g) => g.label === label)!.phoenix!.poolManager as `0x${string}`;
const PRIMARY_PM = pmOf("phoenix/v0.4-rc.1");
const V03_PM = pmOf("phoenix/v0.3-rc.1");
const V11_PM = pmOf("arbitrum-v1.1");
const LEGACY_PM = pmOf("arbitrum-legacy");

const COL = "0x1111111111111111111111111111111111111111" as const;
const REF = "0x2222222222222222222222222222222222222222" as const;
const ORACLE = "0x3333333333333333333333333333333333333333" as const;
const ACCOUNT = "0x7777777777777777777777777777777777777777" as const;
const WAD = 10n ** 18n;
const ZERO = "0x0000000000000000000000000000000000000000" as const;

// Three pools: P_OLD (v0.3, live), P_EXPIRED (v0.3, expired an hour ago), P_NEW (primary, live).
// Each has its own share pair so balanceOf can be address-keyed.
const pool = (n: number) => `0x${n.toString(16).padStart(2, "0").repeat(32)}` as `0x${string}`;
const share = (n: number) => `0x${n.toString(16).padStart(2, "0").repeat(20)}` as `0x${string}`;
const P_OLD = pool(0xa1);
const P_EXPIRED = pool(0xa2);
const P_NEW = pool(0xb1);
const P_EMPTY = pool(0xc1); // on arbitrum-v1.1, no balance — must be dropped
const SHARES = {
  [P_OLD]: { cpt: share(0x11), cst: share(0x12) },
  [P_EXPIRED]: { cpt: share(0x21), cst: share(0x22) },
  [P_NEW]: { cpt: share(0x31), cst: share(0x32) },
  [P_EMPTY]: { cpt: share(0x41), cst: share(0x42) },
} as const;
const BALANCES: Record<string, bigint> = {
  [SHARES[P_OLD]!.cst.toLowerCase()]: 5n * WAD,
  [SHARES[P_OLD]!.cpt.toLowerCase()]: 5n * WAD,
  [SHARES[P_EXPIRED]!.cpt.toLowerCase()]: 7n * WAD, // cPT only: the post-expiry settle case
  [SHARES[P_NEW]!.cst.toLowerCase()]: 3n * WAD,
};

const marketCreated7 = parseAbi(["event MarketCreated(bytes32 indexed id, address indexed referenceAsset, address indexed collateralAsset, uint256 expiry, address rateOracle, address principalToken, address swapToken)"]);
const marketCreated9 = parseAbi(["event MarketCreated(bytes32 indexed poolId, address indexed referenceAsset, address indexed collateralAsset, uint256 expiry, address rateOracle, address principalToken, address swapToken, uint256 swapFeePercentage, uint256 unwindSwapFeePercentage)"]);
function log7(emitter: string, poolId: `0x${string}`, expiry: bigint, block: number) {
  const topics = encodeEventTopics({ abi: marketCreated7, eventName: "MarketCreated", args: { id: poolId, referenceAsset: REF, collateralAsset: COL } });
  const s = SHARES[poolId as keyof typeof SHARES]!;
  const data = encodeAbiParameters([{ type: "uint256" }, { type: "address" }, { type: "address" }, { type: "address" }], [expiry, ORACLE, s.cpt, s.cst]);
  return { address: emitter, topics: [...topics] as string[], data, blockNumber: block, transactionHash: `0x${block.toString(16).padStart(64, "0")}` };
}
function log9(emitter: string, poolId: `0x${string}`, expiry: bigint, block: number) {
  const topics = encodeEventTopics({ abi: marketCreated9, eventName: "MarketCreated", args: { poolId, referenceAsset: REF, collateralAsset: COL } });
  const s = SHARES[poolId as keyof typeof SHARES]!;
  const data = encodeAbiParameters([{ type: "uint256" }, { type: "address" }, { type: "address" }, { type: "address" }, { type: "uint256" }, { type: "uint256" }], [expiry, ORACLE, s.cpt, s.cst, WAD, WAD]);
  return { address: emitter, topics: [...topics] as string[], data, blockNumber: block, transactionHash: `0x${block.toString(16).padStart(64, "0")}` };
}

const LOGS = [log7(V03_PM, P_OLD, NOW + 86_400n, 10), log7(V03_PM, P_EXPIRED, NOW - 3_600n, 11), log9(PRIMARY_PM, P_NEW, NOW + 86_400n, 12), log7(V11_PM, P_EMPTY, NOW + 86_400n, 13)];

/** The scan source: serves each manager's logs when that manager is in the asked address set. */
function hyperSyncOf(asked: string[][]) {
  return {
    async queryLogs(q: { fromBlock: number; address?: string[]; topics?: Array<string[] | null> }) {
      asked.push([...(q.address ?? [])]);
      const scope = new Set((q.address ?? []).map((a) => a.toLowerCase()));
      // Honours fromBlock like the real source (the scan cache resumes past its watermark).
      return { logs: LOGS.filter((l) => scope.has(l.address.toLowerCase()) && l.blockNumber >= q.fromBlock), archiveHeight: 1_000 };
    },
  };
}

function ctxFor(asked: string[][] = [], more: Partial<HandlerContext> = {}): HandlerContext {
  return {
    nowSeconds: NOW,
    hyperSync: hyperSyncOf(asked),
    resolveRpc: async () =>
      stubResolved({
        getBlockNumber: async () => 1_000n, // = archiveHeight → the live tail is "current"
        readContract: async ({ address, functionName }: { address: string; functionName: string }) => {
          switch (functionName) {
            case "balanceOf":
              return BALANCES[address.toLowerCase()] ?? 0n;
            case "shares":
              return address.toLowerCase() === V03_PM.toLowerCase() ? [SHARES[P_OLD]!.cpt, SHARES[P_OLD]!.cst] : [ZERO, ZERO];
            case "market":
              return { collateralAsset: COL, referenceAsset: REF, expiryTimestamp: NOW + 86_400n, rateMin: WAD / 2n, rateMax: WAD, rateChangePerDayMax: WAD / 10n, rateChangeCapacityMax: WAD, rateOracle: ORACLE };
            case "decimals":
              return 18;
            case "allowance":
              return 0n;
            default:
              throw new Error(`no stub for ${functionName}`);
          }
        },
      }),
    ...more,
  };
}

const positions = (ctx: HandlerContext, generation?: string, mode: "hybrid" | "full-decentralized" | "lite-decentralized" | null = "full-decentralized") => runTool("cork_query", { resource: "account-state", chainId: CHAIN, pageSize: 25, format: "concise", filters: { account: ACCOUNT }, ...(mode ? { mode } : {}), ...(generation ? { generation } : {}) }, ctx);
// The venue's /pools/v1 rows for the SAME four pools (+ one row on a manager no generation of
// the chain owns — a filtered-out set, or venue noise — which the sweep must skip). Served in
// pages so the cursor walk is exercised; every call's URL is recorded.
const UNLISTED_PM = "0x9999999999999999999999999999999999999999" as const;
const P_UNLISTED = pool(0xd1);
function venueRow(pm: string, poolId: `0x${string}`, expiry: bigint, block: number) {
  const sh = SHARES[poolId as keyof typeof SHARES] ?? { cpt: share(0x51), cst: share(0x52) };
  return { chainId: CHAIN, poolId, poolManagerAddress: pm, swapToken: { address: sh.cst, symbol: "cST" }, principalToken: sh.cpt, collateralToken: { address: COL }, referenceToken: REF, expiry: new Date(Number(expiry) * 1000).toISOString(), rateOracleAddress: ORACLE, deploymentBlockNumber: String(block), deploymentTxHash: `0x${block.toString(16).padStart(64, "0")}` };
}
const VENUE_ROWS = [venueRow(V03_PM, P_OLD, NOW + 86_400n, 10), venueRow(V03_PM, P_EXPIRED, NOW - 3_600n, 11), venueRow(PRIMARY_PM, P_NEW, NOW + 86_400n, 12), venueRow(V11_PM, P_EMPTY, NOW + 86_400n, 13), venueRow(UNLISTED_PM, P_UNLISTED, NOW + 86_400n, 14)];
function venueOf(urls: string[], rows = VENUE_ROWS, pageOf = 3) {
  return async (url: string): Promise<Response> => {
    urls.push(url);
    const u = new URL(url);
    if (!u.pathname.endsWith("/pools/v1")) return new Response("not found", { status: 404 });
    const start = Number(u.searchParams.get("cursor") ?? "0");
    const items = rows.slice(start, start + pageOf);
    const next = start + pageOf < rows.length ? String(start + pageOf) : undefined;
    return new Response(JSON.stringify({ items, ...(next ? { nextCursor: next, hasMore: true } : { hasMore: false }) }), { status: 200, headers: { "content-type": "application/json" } });
  };
}


type PositionsData = {
  account: string;
  generations: Array<{ label: string; status: string }>;
  scanned: { managers: number; pools: number; complete: boolean; source: string };
  positions: Array<{ generation: { label: string }; poolId: string; expired: boolean; expiry: string; balances: { corkSwapToken: string; corkPrincipalToken: string }; corkSwapToken: string; corkPrincipalToken: string; expiryTimestamp: string }>;
  byGeneration: Array<{ label: string; pools: number; corkSwapTokenTotal: string; corkPrincipalTokenTotal: string }>;
  scales: Record<string, string>;
  generation?: unknown;
};

describe("generation aliases resolve in ONE place, to a label", () => {
  it("`previous` on 42161 for a phoenix call = phoenix/v0.3-rc.1 (the newest active non-primary set with a pool manager); `primary` = the primary; a plain label passes through", () => {
    expect(resolveGenerationAlias(ARBITRUM, "previous", ["phoenix"])).toMatchObject({ ok: true, label: "phoenix/v0.3-rc.1", alias: "previous" });
    expect(resolveGenerationAlias(ARBITRUM, "primary", ["phoenix"])).toMatchObject({ ok: true, label: "phoenix/v0.4-rc.1", alias: "primary" });
    expect(resolveGenerationAlias(ARBITRUM, "arbitrum-v1.1", ["phoenix"])).toEqual({ ok: true, label: "arbitrum-v1.1" });
    expect(resolveGenerationAlias(ARBITRUM, undefined, ["phoenix"])).toEqual({ ok: true, label: undefined });
  });
  it("`previous` follows the block kinds the call NEEDS: a rollover call's previous set must carry a rollover block", () => {
    const r = resolveGenerationAlias(ARBITRUM, "previous", ["rollover"]);
    expect(r.ok).toBe(true);
    const label = (r as { label: string }).label;
    expect(ARBITRUM.find((g) => g.label === label)?.rollover).toBeDefined();
    expect(ARBITRUM.find((g) => g.label === label)?.primary).toBe(false);
  });
  it("`previous` skips an active non-primary set that lacks the needed block: a synthetic chain whose newest non-primary set has no rollover block resolves the rollover call's `previous` to the next one", () => {
    const g = (label: string, blocks: Record<string, unknown>, primary = false) => ({ label, status: "active", primary, ...blocks }) as unknown as (typeof ARBITRUM)[number];
    const list = [g("p", { phoenix: {}, marketRegistry: {}, rollover: {} }, true), g("no-settler", { phoenix: {}, marketRegistry: {} }), g("with-settler", { phoenix: {}, rollover: {} })];
    expect(resolveGenerationAlias(list, "previous", ["rollover"])).toMatchObject({ ok: true, label: "with-settler" });
    expect(resolveGenerationAlias(list, "previous", ["marketRegistry"])).toMatchObject({ ok: true, label: "no-settler" });
    expect(resolveGenerationAlias(list, "previous", ["phoenix", "rollover"])).toMatchObject({ ok: true, label: "with-settler" });
    const none = resolveGenerationAlias(list, "previous", ["marketRegistry", "rollover"]);
    expect(none.ok).toBe(false);
    if (!none.ok) expect(none.refusal.message).toContain("carrying marketRegistry + rollover contracts");
  });
  it("selectGeneration resolves the alias and returns the SET — never the alias string", () => {
    const sel = selectGeneration(ARBITRUM, "previous", "prepare", ["phoenix"]);
    expect(sel.ok).toBe(true);
    if (sel.ok) expect(sel.generation.label).toBe("phoenix/v0.3-rc.1");
    expect((GENERATION_ALIASES as readonly string[]).includes(sel.ok ? sel.generation.label : "")).toBe(false);
  });
  it("a chain with ONE generation (mainnet) refuses `previous` as generation_unknown and says there is nothing to migrate from", () => {
    const sel = selectGeneration(MAINNET, "previous", "read", ["phoenix"]);
    expect(sel.ok).toBe(false);
    if (!sel.ok) {
      expect(sel.refusal.code).toBe("generation_unknown");
      expect(sel.refusal.message).toContain("nothing to migrate from");
      expect(sel.refusal.message).toContain("mainnet");
    }
  });
  it("`all` is refused on a prepare with teaching (a prepare builds ONE artifact) and on a read (naming the multi-generation read)", () => {
    const prep = selectGeneration(ARBITRUM, "all", "prepare");
    expect(prep.ok).toBe(false);
    if (!prep.ok) expect(prep.refusal.message).toMatch(/ONE artifact.*topic:"migration"/s);
    const read = selectGeneration(ARBITRUM, "all", "read");
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.refusal.message).toContain("account-state WITHOUT filters.poolId");
  });
  it("an unknown label's teaching now lists the aliases beside the labels", () => {
    const sel = selectGeneration(ARBITRUM, "phoenix/v0.9");
    expect(sel.ok).toBe(false);
    if (!sel.ok) expect(sel.refusal.message).toContain("aliases: primary, previous");
  });
  it("end to end: a prepare with generation 'previous' builds against phoenix/v0.3-rc.1 and CARRIES THE LABEL in provenance; 'all' on a prepare is invalid input", async () => {
    const ok = await runTool(
      "cork_prepare_phoenix",
      { chainId: CHAIN, account: ACCOUNT, clientRequestId: "mig-auth-0001", generation: "previous", action: { type: "authority-onboard", token: SHARES[P_OLD]!.cst, spender: V03_PM }, format: "concise" },
      { nowSeconds: NOW },
    );
    expect(ok.state).toBe("ok");
    expect(ok.provenance.generation).toMatchObject({ label: "phoenix/v0.3-rc.1", status: "active" });
    await expect(
      runTool("cork_prepare_phoenix", { chainId: CHAIN, account: ACCOUNT, clientRequestId: "mig-auth-0002", generation: "all", action: { type: "authority-onboard", token: SHARES[P_OLD]!.cst, spender: V03_PM }, format: "concise" }, { nowSeconds: NOW }),
    ).rejects.toSatisfy((e: unknown) => e instanceof ToolInputError && JSON.stringify((e as { issues?: unknown }).issues ?? "").includes("ONE artifact"));
    // A pool-scoped read narrowed by the alias: the resolver asks ONLY the previous manager.
    const single = await runTool("cork_query", { resource: "account-state", chainId: CHAIN, pageSize: 25, format: "concise", generation: "previous", filters: { poolId: P_OLD, account: ACCOUNT } }, ctxFor());
    expect(single.state).toBe("ok");
    expect(single.provenance.generation).toMatchObject({ label: "phoenix/v0.3-rc.1" });
  });
  it("`previous` on a registry read resolves against the marketRegistry block (v0.3's flat registry)", async () => {
    const env = await runTool("cork_query", { resource: "protocol-config", chainId: CHAIN, pageSize: 25, format: "concise", generation: "previous" }, { nowSeconds: NOW });
    expect(env.state).toBe("ok");
    expect(env.provenance.generation).toMatchObject({ label: "phoenix/v0.3-rc.1" });
  });
});

describe("account-state WITHOUT filters.poolId — positions across every generation", () => {
  it("scans EVERY manager with a phoenix block, sweeps cST+cPT, drops zero-position pools, flags the expired one, and carries no provenance.generation", async () => {
    const asked: string[][] = [];
    const env = await positions(ctxFor(asked));
    expect(env.state).toBe("ok");
    expect(env.provenance).not.toHaveProperty("generation");
    const d = env.data as PositionsData;
    expect(d.generation).toBeUndefined();
    expect(d.account).toBe(ACCOUNT);
    // Four generations carry a pool manager on 42161 → four managers asked in ONE scan.
    expect(d.scanned).toEqual({ managers: 4, pools: 4, complete: true, source: "full-decentralized" });
    expect(env.provenance.mode).toBe("full-decentralized");
    expect(asked).toHaveLength(1);
    expect(new Set(asked[0]!.map((a) => a.toLowerCase()))).toEqual(new Set([PRIMARY_PM, V03_PM, V11_PM, LEGACY_PM].map((a) => a.toLowerCase())));
    expect(d.generations.map((g) => g.label)).toEqual(["phoenix/v0.4-rc.1", "phoenix/v0.3-rc.1", "arbitrum-v1.1", "arbitrum-legacy"]);
    // Three positions (P_EMPTY dropped), each tagged with ITS generation.
    expect(d.positions.map((p) => [p.poolId, p.generation.label, p.expired])).toEqual([
      [P_OLD, "phoenix/v0.3-rc.1", false],
      [P_EXPIRED, "phoenix/v0.3-rc.1", true],
      [P_NEW, "phoenix/v0.4-rc.1", false],
    ]);
    expect(d.positions[0]).toMatchObject({ corkSwapToken: SHARES[P_OLD]!.cst, corkPrincipalToken: SHARES[P_OLD]!.cpt, expiryTimestamp: (NOW + 86_400n).toString(), expiry: expiryIsoOfSeconds(NOW + 86_400n), balances: { corkSwapToken: (5n * WAD).toString(), corkPrincipalToken: (5n * WAD).toString() } });
    expect(d.positions[1]!.balances).toEqual({ corkSwapToken: "0", corkPrincipalToken: (7n * WAD).toString() });
    const S = (n: bigint) => n.toString();
    expect(d.byGeneration).toEqual([
      { label: "phoenix/v0.4-rc.1", status: "active", pools: 1, corkSwapTokenTotal: S(3n * WAD), corkPrincipalTokenTotal: "0" },
      { label: "phoenix/v0.3-rc.1", status: "active", pools: 2, corkSwapTokenTotal: S(5n * WAD), corkPrincipalTokenTotal: S(12n * WAD) },
      { label: "arbitrum-v1.1", status: "active", pools: 0, corkSwapTokenTotal: "0", corkPrincipalTokenTotal: "0" },
      { label: "arbitrum-legacy", status: "read-only", pools: 0, corkSwapTokenTotal: "0", corkPrincipalTokenTotal: "0" },
    ]);
    expect(d.scales["balances"]).toContain("18-decimal");
    expect(d.scales["unitsTopic"]).toBeDefined();
  });
  it("`generation: 'previous'` NARROWS the sweep to the previous set's manager; 'all' = every manager; a label without a pool manager is invalid input", async () => {
    const asked: string[][] = [];
    const env = await positions(ctxFor(asked), "previous");
    expect(env.state).toBe("ok");
    const d = env.data as PositionsData;
    expect(asked[0]!.map((a) => a.toLowerCase())).toEqual([V03_PM.toLowerCase()]);
    expect(d.scanned.managers).toBe(1);
    expect(d.generations).toHaveLength(1);
    expect(d.generations[0]).toMatchObject({ label: "phoenix/v0.3-rc.1", status: "active" });
    expect(d.positions.map((p) => p.poolId)).toEqual([P_OLD, P_EXPIRED]);
    const all = await positions(ctxFor(), "all");
    expect((all.data as PositionsData).scanned.managers).toBe(4);
    await expect(positions(ctxFor(), "phoenix/v0.9")).rejects.toBeInstanceOf(ToolInputError);
  });
  it("the expired flag follows the CLOCK: at the boundary second the pool is expired (Phoenix's own >= gate)", async () => {
    const env = await positions(ctxFor([], { nowSeconds: NOW + 86_400n }));
    const d = env.data as PositionsData;
    expect(d.positions.map((p) => p.expired)).toEqual([true, true, true]);
  });
  it("without filters.account the read refuses missing_filter and teaches both shapes", async () => {
    const env = await runTool("cork_query", { resource: "account-state", chainId: CHAIN, pageSize: 25, format: "concise", filters: {} }, ctxFor());
    expect(env.state).toBe("unavailable");
    expect(env.warnings[0]?.code).toBe("missing_filter");
    expect(env.warnings[0]?.message).toContain("without: the account's positions");
  });
  it("the single-pool branch is UNCHANGED: with filters.poolId the read resolves the pool's generation, answers balances for all four tokens plus allowances, and carries provenance.generation", async () => {
    const env = await runTool("cork_query", { resource: "account-state", chainId: CHAIN, pageSize: 25, format: "concise", filters: { account: ACCOUNT, poolId: P_OLD } }, ctxFor());
    expect(env.state).toBe("ok");
    expect(env.provenance.generation).toMatchObject({ label: "phoenix/v0.3-rc.1" });
    const d = env.data as { poolId: string; balances: Record<string, bigint>; allowances?: unknown; positions?: unknown; tokens: { corkSwapToken: string } };
    expect(d.poolId).toBe(P_OLD);
    expect(Object.keys(d.balances).sort()).toEqual(["collateral", "corkPrincipalToken", "corkSwapToken", "reference"]);
    expect(d.allowances).toBeDefined();
    expect(d.positions).toBeUndefined();
  });
});

describe("account-state WITHOUT filters.poolId — enumeration follows the mode's pledge; the venue is an OPT-IN", () => {
  it("omitting mode is lite-decentralized: the scan runs over YOUR RPC alone (no venue call, no HyperSync, no fallback label) — provenance.mode lite-decentralized", async () => {
    const urls: string[] = [];
    const asked: string[][] = [];
    // ctx.hyperSync is present here and must NOT be used: the default pledge is the RPC alone.
    const rpcLogs: string[][] = [];
    const ctx = ctxFor(asked, { venueFetch: venueOf(urls) });
    const inner = ctx.resolveRpc!;
    ctx.resolveRpc = async (...a: Parameters<typeof inner>) => {
      const r = (await inner(...a))!;
      const client = r.client as unknown as { request?: unknown };
      client.request = async (q: { params: Array<{ address?: string[] }> }) => {
        rpcLogs.push(q.params[0]!.address ?? []);
        return LOGS.map((l) => ({ address: l.address, topics: l.topics, data: l.data, blockNumber: `0x${l.blockNumber.toString(16)}`, transactionHash: l.transactionHash }));
      };
      return r;
    };
    const env = await positions(ctx, undefined, null);
    expect(env.state).toBe("ok");
    expect(env.provenance.mode).toBe("lite-decentralized");
    expect(urls).toEqual([]); // the venue was never contacted
    expect(asked).toEqual([]); // HyperSync was never asked
    expect(rpcLogs).toHaveLength(1); // one eth_getLogs over every manager
    expect(env.warnings.map((w) => w.code)).not.toContain("logs_windowed_fallback");
    const d = env.data as PositionsData;
    expect(d.scanned).toEqual({ managers: 4, pools: 4, complete: true, source: "lite-decentralized" });
    expect(d.positions.map((p) => p.poolId)).toEqual([P_OLD, P_EXPIRED, P_NEW]);
  });
  it("`mode: hybrid` walks the venue's /pools/v1 at the CALLER's pageSize (never a substituted one) until hasMore is false, attributes each row to its manager's generation, skips a row on a manager no generation owns, and sweeps balances over YOUR RPC — provenance.mode hybrid", async () => {
    const urls: string[] = [];
    const asked: string[][] = [];
    const env = await positions(ctxFor(asked, { venueFetch: venueOf(urls) }), undefined, "hybrid");
    expect(env.state).toBe("ok");
    expect(env.provenance.mode).toBe("hybrid");
    expect(asked).toEqual([]); // no log scan ran
    expect(urls).toHaveLength(2); // 5 rows, 3 per page → two pages, the cursor threaded
    for (const u of urls) expect(new URL(u).searchParams.get("limit")).toBe("25"); // the input's pageSize, verbatim
    expect(new URL(urls[0]!).searchParams.get("chainId")).toBe(String(CHAIN));
    expect(new URL(urls[1]!).searchParams.get("cursor")).toBe("3");
    const d = env.data as PositionsData;
    // The unlisted manager's row is skipped: 4 pools scanned of 5 served, sweep complete.
    expect(d.scanned).toEqual({ managers: 4, pools: 4, complete: true, source: "hybrid" });
    expect(d.positions.map((p) => [p.poolId, p.generation.label, p.expired])).toEqual([
      [P_OLD, "phoenix/v0.3-rc.1", false],
      [P_EXPIRED, "phoenix/v0.3-rc.1", true],
      [P_NEW, "phoenix/v0.4-rc.1", false],
    ]);
    // Token addresses come through whether the venue serves a string or an { address } object;
    // the venue's ISO-8601 `expiry` is normalised to unix seconds (the shape the scan serves and
    // the `expired` flag compares against).
    expect(d.positions[0]).toMatchObject({ corkSwapToken: SHARES[P_OLD]!.cst, corkPrincipalToken: SHARES[P_OLD]!.cpt, expiryTimestamp: (NOW + 86_400n).toString() });
    expect(env.warnings.map((w) => w.code)).not.toContain("pagination_incomplete");
  });
  it("`mode: hybrid` passes the chain-resource mode gate for THIS read only; `previous` narrows the venue rows to that manager", async () => {
    const urls: string[] = [];
    const env = await positions(ctxFor([], { venueFetch: venueOf(urls) }), "previous", "hybrid");
    expect(env.state).toBe("ok");
    const d = env.data as PositionsData;
    expect(d.scanned).toEqual({ managers: 1, pools: 2, complete: true, source: "hybrid" });
    expect(d.positions.map((p) => p.poolId)).toEqual([P_OLD, P_EXPIRED]);
    // The gate still holds for every other chain resource.
    const gated = await runTool("cork_query", { resource: "account-state", chainId: CHAIN, pageSize: 25, format: "concise", mode: "hybrid", filters: { account: ACCOUNT, poolId: P_OLD } }, ctxFor([], { venueFetch: venueOf(urls) }));
    expect(gated.state).toBe("unavailable");
    expect(gated.warnings[0]?.code).toBe("mode_unavailable");
  });
  it("a venue walk cut short by maxPages is disclosed: complete false + pagination_incomplete naming maxPages", async () => {
    const env = await runTool("cork_query", { resource: "account-state", chainId: CHAIN, pageSize: 25, maxPages: 1, mode: "hybrid", format: "concise", filters: { account: ACCOUNT } }, ctxFor([], { venueFetch: venueOf([]) }));
    expect(env.state).toBe("ok");
    const d = env.data as PositionsData;
    expect(d.scanned).toMatchObject({ pools: 3, complete: false, source: "hybrid" });
    const w = env.warnings.find((x) => x.code === "pagination_incomplete");
    expect(w?.message).toContain("pageSize");
    expect(w?.message).toContain("maxPages");
  });
  it("a venue row whose expiry is not seconds-or-strict-ISO is skipped and DISCLOSED, never thrown on; an explicit offset is canonicalised", async () => {
    // "next tuesday" and a MILLISECOND digit string are both refused; an explicit-offset ISO
    // string is accepted and canonicalised.
    const rows = [{ ...VENUE_ROWS[0]!, expiry: "next tuesday" }, { ...VENUE_ROWS[1]!, expiry: ((NOW - 3_600n) * 1000n).toString() }, { ...VENUE_ROWS[2]!, expiry: new Date(Number(NOW + 86_400n) * 1000).toISOString().replace("Z", "+00:00") }];
    const env = await positions(ctxFor([], { venueFetch: venueOf([], rows) }), undefined, "hybrid");
    expect(env.state).toBe("ok");
    const d = env.data as PositionsData;
    expect(d.scanned).toMatchObject({ pools: 1, complete: true });
    expect(d.positions.map((p) => [p.poolId, p.expired, p.expiry])).toEqual([[P_NEW, false, expiryIsoOfSeconds(NOW + 86_400n)]]);
    const w = env.warnings.find((x) => x.code === "invalid_service_response");
    expect(w?.message).toContain("2 venue pool row(s)");
    expect(w?.message).toContain("strict ISO-8601");
  });
  it("the sweep shares the cork-pools scan's incremental cursor: a second read resumes past the watermark (minus the reorg overlap) and answers the same positions", async () => {
    // The scan cache is keyed by the CORK_SCAN_CACHE_FILE variable; point it at a private file
    // for this test the way hypersync.test.ts does, and restore whatever was there.
    const SCAN_CACHE_VAR = "CORK_SCAN_CACHE_FILE";
    const envGet = (k: string): string | undefined => process.env[k];
    const envSet = (k: string, v: string | undefined): void => {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    };
    const saved = envGet(SCAN_CACHE_VAR);
    envSet(SCAN_CACHE_VAR, `${envGet("TMPDIR") ?? "/tmp"}/cork-scan-cache-mig-${process.pid}-${Date.now()}.json`);
    try {
      const froms: number[] = [];
      const source = {
        async queryLogs(q: { fromBlock: number; address?: string[] }) {
          froms.push(q.fromBlock);
          const scope = new Set((q.address ?? []).map((a) => a.toLowerCase()));
          return { logs: LOGS.filter((l) => scope.has(l.address.toLowerCase()) && l.blockNumber >= q.fromBlock), archiveHeight: 1_000 };
        },
      };
      const first = await positions(ctxFor([], { hyperSync: source }), undefined, "full-decentralized");
      const second = await positions(ctxFor([], { hyperSync: source }), undefined, "full-decentralized");
      expect(froms[0]).toBe(0);
      expect(froms[1]).toBeGreaterThan(0); // resumed from the cached watermark, not block 0
      expect((second.data as PositionsData).positions).toEqual((first.data as PositionsData).positions);
      expect((second.data as PositionsData).scanned).toMatchObject({ pools: 4, complete: true });
    } finally {
      envSet(SCAN_CACHE_VAR, saved);
    }
  });
  it("`mode: full-decentralized` WITHOUT a HyperSync source falls back to the windowed walk and SAYS so (cork-pools parity); with one, it uses it and stays silent", async () => {
    const asked: string[][] = [];
    const withHs = await positions(ctxFor(asked), undefined, "full-decentralized");
    expect(asked).toHaveLength(1);
    expect(withHs.warnings.map((w) => w.code)).not.toContain("logs_windowed_fallback");
    const ctx = ctxFor([]);
    delete (ctx as { hyperSync?: unknown }).hyperSync; // no archive source at all
    const inner = ctx.resolveRpc!;
    ctx.resolveRpc = async (...a: Parameters<typeof inner>) => {
      const r = (await inner(...a))!;
      (r.client as unknown as { request: unknown }).request = async () => LOGS.map((l) => ({ address: l.address, topics: l.topics, data: l.data, blockNumber: `0x${l.blockNumber.toString(16)}`, transactionHash: l.transactionHash }));
      return r;
    };
    const noHs = await positions(ctx, undefined, "full-decentralized");
    expect(noHs.state).toBe("ok");
    expect(noHs.provenance.mode).toBe("full-decentralized");
    expect(noHs.warnings.map((w) => w.code)).toContain("logs_windowed_fallback");
    expect((noHs.data as PositionsData).scanned).toMatchObject({ pools: 4, complete: true, source: "full-decentralized" });
  });
});

describe("an endpoint that refuses eth_getLogs at the floor (owner ruling 2026-09-23)", () => {
  /** An RPC whose eth_getLogs refuses EVERY range; getBlockNumber works. */
  const refusingClient = () => ({
    getBlockNumber: async () => 1_000n,
    request: async () => {
      throw new Error("eth_getLogs is limited to a 1,000 range");
    },
    readContract: async ({ address, functionName }: { address: string; functionName: string }) => (functionName === "balanceOf" ? (BALANCES[address.toLowerCase()] ?? 0n) : functionName === "decimals" ? 18 : 0n),
  });
  /** A healthy RPC serving the LOGS over eth_getLogs. */
  const servingClient = () => ({
    getBlockNumber: async () => 1_000n,
    request: async () => LOGS.map((l) => ({ address: l.address, topics: l.topics, data: l.data, blockNumber: `0x${l.blockNumber.toString(16)}`, transactionHash: l.transactionHash })),
    readContract: async ({ address, functionName }: { address: string; functionName: string }) => (functionName === "balanceOf" ? (BALANCES[address.toLowerCase()] ?? 0n) : functionName === "decimals" ? 18 : 0n),
  });
  it("AUTOMATIC endpoint: the walk fails over ONCE to the next resolution, discloses rpc_fallback naming both hosts, and completes", async () => {
    let calls = 0;
    const ctx: HandlerContext = {
      nowSeconds: NOW,
      resolveRpc: async () => {
        calls += 1;
        return calls === 1 ? ({ url: "https://strict.example/rpc", source: "default", client: refusingClient() } as never) : ({ url: "https://healthy.example/rpc", source: "default", client: servingClient() } as never);
      },
    };
    const env = await positions(ctx, undefined, null);
    expect(env.state).toBe("ok");
    // Re-resolved for the walk (the live-tail leg resolves once more on its own); the BALANCE
    // sweep keeps the first client — a range cap is about eth_getLogs, not eth_call.
    expect(calls).toBeGreaterThanOrEqual(2);
    const w = env.warnings.find((x) => x.code === "rpc_fallback");
    expect(w?.message).toContain("strict.example");
    expect(w?.message).toContain("healthy.example");
    expect((env.data as PositionsData).scanned).toMatchObject({ pools: 4, complete: true });
  });
  it("EXPLICIT endpoint (the operator's own --rpc-url): NO failover — a loud unavailable naming the host and the floor", async () => {
    let calls = 0;
    const ctx: HandlerContext = {
      nowSeconds: NOW,
      resolveRpc: async () => {
        calls += 1;
        return { url: "https://mine.example/rpc", source: "explicit", client: refusingClient() } as never;
      },
    };
    const env = await positions(ctx, undefined, null);
    expect(env.state).toBe("unavailable");
    expect(calls).toBe(1); // never re-resolved
    expect(env.warnings[0]?.code).toBe("chain_read_failed");
    expect(env.warnings[0]?.message).toContain("1000-block floor");
    expect(env.warnings.map((w) => w.code)).not.toContain("rpc_fallback");
  });
  it("AUTOMATIC endpoint whose re-resolution lands on the SAME host: the original refusal propagates (no silent loop)", async () => {
    const ctx: HandlerContext = { nowSeconds: NOW, resolveRpc: async () => ({ url: "https://only.example/rpc", source: "default", client: refusingClient() }) as never };
    const env = await positions(ctx, undefined, null);
    expect(env.state).toBe("unavailable");
    expect(env.warnings[0]?.message).toContain("1000-block floor");
  });
});

describe("the venue row → MarketRow mapping is pure and shape-checked", () => {
  const emitters = [
    { poolManager: V03_PM, wire: "8-field" as const, label: "phoenix/v0.3-rc.1" },
    { poolManager: PRIMARY_PM, wire: "10-field" as const, label: "phoenix/v0.4-rc.1" },
  ];
  it("venueExpiry accepts ONLY strict ISO-8601 with an explicit zone, canonicalises to UTC second precision, and derives the seconds from the canonical instant", () => {
    expect(venueExpiry("2026-08-10T12:30:00.000Z")).toEqual({ iso: "2026-08-10T12:30:00Z", seconds: "1786365000" });
    expect(venueExpiry("2026-08-10T12:30:00Z")).toEqual({ iso: "2026-08-10T12:30:00Z", seconds: "1786365000" });
    // A sub-second fraction is dropped (chain expiry is an integer second).
    expect(venueExpiry("2026-08-10T12:30:00.999Z")).toEqual({ iso: "2026-08-10T12:30:00Z", seconds: "1786365000" });
    // An explicit offset is unambiguous and is canonicalised to Z: 14:30 at +02:00 IS 12:30Z.
    expect(venueExpiry("2026-08-10T14:30:00+02:00")).toEqual({ iso: "2026-08-10T12:30:00Z", seconds: "1786365000" });
    expect(venueExpiry("2026-08-10T07:30:00-05:00")).toEqual({ iso: "2026-08-10T12:30:00Z", seconds: "1786365000" });
  });
  it("venueExpiry accepts integer unix seconds too (the shape every RFQ field serves live) — one parser for every venue instant", () => {
    expect(venueExpiry("1786365000")).toEqual({ iso: "2026-08-10T12:30:00Z", seconds: "1786365000" });
    expect(venueExpiry(1786365000)).toEqual({ iso: "2026-08-10T12:30:00Z", seconds: "1786365000" });
  });
  it("venueExpiry REFUSES every ambiguous or lenient shape Date.parse would have accepted", () => {
    const refused: unknown[] = [
      "2026-08-10T12:30:00", // no zone — Date.parse reads LOCAL time
      "2026-08-10", // date only
      "2026-08-10 12:30:00Z", // space separator
      "2026-08-10T12:30Z", // no seconds
      "1786365000000", // 13 digits: milliseconds masquerading as seconds
      1786365000000,
      1786365000.5, // a fractional number
      "Aug 10 2026 12:30:00 GMT", // natural-language / RFC-2822 forms
      "next tuesday",
      "2026-02-30T00:00:00Z", // invalid calendar date — refused, never rolled into March
      "2026-13-01T00:00:00Z",
      "2026-08-10T24:00:00Z",
      "2026-08-10T12:60:00Z",
      "", null, undefined, {},
    ];
    for (const v of refused) expect(venueExpiry(v), JSON.stringify(v)).toBeUndefined();
  });
  it("expiryIsoOfSeconds is the ONE canonical spelling both sources land on", () => {
    expect(expiryIsoOfSeconds(1786365000n)).toBe("2026-08-10T12:30:00Z");
    expect(expiryIsoOfSeconds(0n)).toBe("1970-01-01T00:00:00Z");
    // A venue ISO string and the chain's seconds for the same instant produce the SAME text.
    expect(venueExpiry("2026-08-10T14:30:00+02:00")!.iso).toBe(expiryIsoOfSeconds(1786365000n));
  });
  it("maps a live-shaped row (token OBJECTS, ISO expiry, string block number) and a bare-address row alike; attributes wire + generation from the emitter", () => {
    const live = { chainId: 8453, poolId: P_OLD, poolName: "x", expiry: "2026-08-10T12:30:00.000Z", deploymentBlockNumber: "49786153", deploymentTxHash: `0x${"ab".repeat(32)}`, poolManagerAddress: V03_PM.toLowerCase(), collateralToken: { address: COL, symbol: "sUSDe", decimals: 18 }, referenceToken: { address: REF, symbol: "mwUSDC", decimals: 18 }, principalToken: { address: SHARES[P_OLD]!.cpt, symbol: "cPT", decimals: 18 }, swapToken: { address: SHARES[P_OLD]!.cst, symbol: "cST", decimals: 18 }, rateOracleAddress: ORACLE };
    const bare = { poolId: P_NEW, poolManagerAddress: PRIMARY_PM, swapToken: SHARES[P_NEW]!.cst, principalToken: SHARES[P_NEW]!.cpt, collateralToken: COL, referenceToken: REF, expiry: "2027-01-15T08:00:00Z" };
    const { rows, unreadableExpiry } = venuePoolRowsToMarketRows([live, bare], emitters);
    expect(unreadableExpiry).toBe(0);
    expect(rows).toEqual([
      { poolId: P_OLD, referenceAsset: REF, collateralAsset: COL, expiry: "1786365000", rateOracle: ORACLE, corkPrincipalToken: SHARES[P_OLD]!.cpt, corkSwapToken: SHARES[P_OLD]!.cst, poolManager: V03_PM, wire: "8-field", generation: "phoenix/v0.3-rc.1", blockNumber: "49786153", txHash: `0x${"ab".repeat(32)}`, emitter: V03_PM },
      { poolId: P_NEW, referenceAsset: REF, collateralAsset: COL, expiry: "1800000000", rateOracle: ZERO, corkPrincipalToken: SHARES[P_NEW]!.cpt, corkSwapToken: SHARES[P_NEW]!.cst, poolManager: PRIMARY_PM, wire: "10-field", generation: "phoenix/v0.4-rc.1", blockNumber: "", txHash: "", emitter: PRIMARY_PM },
    ]);
  });
  it("skips: a manager no emitter owns, a row missing a token leg, a malformed poolId; counts (does not skip silently) an unreadable expiry — a millisecond digit string INCLUDED", () => {
    const ok = { poolId: P_NEW, poolManagerAddress: PRIMARY_PM, swapToken: SHARES[P_NEW]!.cst, principalToken: SHARES[P_NEW]!.cpt, collateralToken: COL, referenceToken: REF, expiry: "2027-01-15T08:00:00Z" };
    const { rows, unreadableExpiry } = venuePoolRowsToMarketRows(
      [{ ...ok, poolManagerAddress: "0x9999999999999999999999999999999999999999" }, { ...ok, swapToken: undefined }, { ...ok, poolId: "0x1234" }, { ...ok, expiry: "someday" }, { ...ok, expiry: "1800000000000" }, { ...ok, expiry: null }, ok],
      emitters,
    );
    expect(rows.map((r) => r.poolId)).toEqual([P_NEW]);
    expect(unreadableExpiry).toBe(3); // "someday", a 13-digit (millisecond) string, null
  });
});

describe("the `migration` doc topic", () => {
  it("resolves by name and by every alias, names the aliases, the pool-scoped actions per expiry state, create-pool, rollover-intent, cork_track, and the two standing facts", () => {
    const t = findDocTopic("migration")!;
    expect(t).toBeDefined();
    for (const alias of ["migrate", "move-funds", "previous-generation"]) expect(findDocTopic(alias)?.name).toBe("migration");
    expect(DOC_TOPICS["migration"]).toBe(t);
    for (const needle of ["`previous`", "`primary`", "unwind-deposit", "unwind-mint", "withdraw", "redeem", "withdraw-other", "create-pool", "rollover-intent", "cork_track", "deposit", "mint", "account-state", "no registered assets", "no CREATE2 attestation"]) {
      expect(t.body).toContain(needle);
    }
  });
  it("the capabilities tool serves it and the no-args catalog lists it", async () => {
    const env = await runTool("cork_capabilities", { topic: "move-funds" }, {});
    expect(env.state).toBe("ok");
    expect((env.data as { topic: string }).topic).toBe("migration");
    const all = await runTool("cork_capabilities", {}, {});
    expect((all.data as { docTopics: Array<{ name: string }> }).docTopics.map((d) => d.name)).toContain("migration");
  });
});
