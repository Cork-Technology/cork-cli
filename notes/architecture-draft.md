# Cork CLI / MCP Server — Draft Architecture Proposal (v0.1, unattended session output)

Status: DRAFT for review. Everything here is grounded in `notes/research/*` (four research
threads) and `notes/experiments/01-fork-experiments.md` (9 green fork tests). Open questions
that survived research are in `notes/questions.md` (Q1–Q8); this draft takes positions anyway
so you can veto rather than fill blanks.

## 0. TL;DR of proposed decisions

| Area | Proposal |
|---|---|
| Schema core | **zod v4 (≥4.2)** everywhere; one `defineTool` registry → CLI + MCP + TS types |
| MCP | **Official TS SDK v2** (`@modelcontextprotocol/server`, stable ~2026-07-28); Standard Schema takes zod v4 natively |
| CLI layer | **trpc-cli** consuming the same registry — **RATIFIED 2026-07-16** after review-board + verification spike (experiments/04): exit to bare commander proven at 88 lines/hours; framework overhead measured ~15ms; `jsonInput: "auto"` required in wiring config; registry schemas stay framework-clean (positional meta injected at the 25-line projection); flip triggers now numeric (p50 overhead >400ms, baseline 125ms) |
| MCP tool surface | **~11 parameterized tools** (not 13+ per-action tools); `cork_tx_prepare` takes a discriminated-union `action`; no bespoke keyword search tool (native client tool-search won) |
| Time-dependent math | **Port to TS bigint-WAD + bit-parity CI against forge fork tests** (harness already built & proven this session); `eth_call` used for *current* values, local math only for *projections* that have no on-chain view (worst-case floor over horizon) |
| Rust addon | **Defer for v1.** HyperSync's own Node client is already napi-over-Rust; the constraint math is trivial integer arithmetic; addon slot preserved in repo layout (`crates/`) for when fork-orchestration/RFQ-backtest features land |
| Data modes | Global `--mode centralized|rpc|indexer|auto` (+ per-command override). **No silent fallback**: `auto` reports which mode served each answer + freshness metadata |
| Addresses/config | **Vendor at release pinned to commit SHA** + `cork meta refresh` for runtime re-fetch; verify CREATE2-derived addresses from salts (they're in prod.toml) and cross-check config↔frontend↔Sourcify↔on-chain code hash |
| Repo | pnpm monorepo: `packages/{schemas,core,cli,mcp,enrichment}` + `experiments/` + (later) `crates/` |
| Runtime | Node LTS primary, Bun in CI matrix (as briefed) |

## 1. What the research changed vs the brief

1. **Live limit orders are plain 1inch LOP v4 fixed-price orders; rollover orders are ERC-7683
   with a fixed premium floor.** No Dutch-auction pricing exists on-chain today (D1/D2, Q1/Q2).
   The `orders` tools ship with a pricing-strategy discriminator so Dutch slots in later.
   **UPDATE 2026-07-16 (owner answers):** Dutch auctions = **1inch Fusion** (extension contracts
   on LOP; a Fusion order is a LOP order whose extension points at the Settlement contract —
   current v3.1 Settlement `0x2Ad5004c60e16E54d5007C80CE329Adde5B51Ef5` on mainnet AND Arbitrum).
   Full decode + price math in `research/fusion-dutch-auction.md`: detect via the 20-byte address
   heading `makingAmountData`, branch v2/v3 layouts, piecewise-linear rate bump (1e7 = 100%) with
   gas-linked component, nested ceil-rounding; `@1inch/fusion-sdk@2.4.x` `AuctionCalculator` is
   reusable (port + bit-parity-test it like the floor math; price is a pure function of
   (auctionDetails, taker, baseFee, timestamp)). Salt rule: keccak(extension) low-160 must equal
   salt low-160 when makerTraits bit 249 set — a free integrity check for `cork decode`.
   Rollover (PR #161, branch `feat/base-staging-deployer` / base `audit/zeus-remediations`):
   factory + exact/partial **Settlers** + 5 modules + 3600s trust timelock, CREATE2-salted,
   external deps `registry` + `phoenixPoolManager`; deployed on a Cork vTestnet, **Arbitrum
   mainnet imminent** — rollover tools target that surface, schema-first now, wired post-deploy.
2. **The impairment floor is a token bucket** (empirically characterized, see experiments):
   refill `rateChangePerDayMax`/day capped at `rateChangeCapacityMax`; one commit can spend the
   whole bucket; preview never shows more than one bucket of movement. The product-critical
   number "max REF impairment over horizon T" **cannot be read from chain** — it must be
   computed locally as `max(rateMin, lastAdjustedRate − credits(now) − perDayMax·T)` (committed-
   descent model). This is the single strongest justification for Goal 2's local math.
3. **Every user action is a Bundler3 multicall bundle** (adapter is `onlyBundler3`; PM enforces
   whitelist itself when enabled). TX-prep = bundle assembly (funding legs + action + sweep),
   decode = recursive bundle unwrap. Verified on a real mainnet exercise tx.
4. **ABIs and addresses are fetchable keylessly from Sourcify** (all core contracts full-match)
   and the phoenix repo is public — the GitHub-sourced config story is simpler than feared, and
   `@cork-technology/phoenix` npm (docs claim) does not exist (D5).
5. **api-phoenix.cork.tech is the centralized mode**, live today (pools, whitelist, flows,
   limit-orders incl. POST). Multichain is real now: mainnet + Arbitrum + virtual 49222.
6. **No live unexpired public pool exists today** (all expired ≤2026-07-12) — CI and dev must
   run against a pinned fork of the euler-research vnet (two live vnet-only markets) until new
   pools launch (Q3). **UPDATE 2026-07-16:** owner confirmed the Tenderly vnet (chainId 1) as
   the canonical test env with self-created pools via impersonation — done: fixture pool
   `0xceebea35…c16a` with permissionless MockRateOracle, funded dev EOA, live swap/unwind paths
   (see experiments/03-vnet-fixture.md). Also: **anvil works inside podman** (`podman exec` /
   `--network container:`), restoring cheatcode-RPC workflows alongside forge in-process forks.
   RFQ (Goal 3) gains a dependency: Cork's **market-registry-api** (WIP) will expose public
   endpoints for (a) listable market-pair tokens, (b) per-pair oracle queries — re-ask owner
   before designing `cork_rfq_quote` internals.

## 2. One schema, three consumers (§5.3) — the load-bearing pattern

```ts
// packages/schemas/src/kit.ts
import { z } from "zod"; // v4

export const Address = z.string().regex(/^0x[0-9a-fA-F]{40}$/).describe("EVM address (0x…40 hex)");
export const Hex = z.string().regex(/^0x[0-9a-fA-F]*$/);
export const MarketId = z.string().regex(/^0x[0-9a-fA-F]{64}$/)
  .describe("Cork MarketId = keccak256(abi.encode(Market struct))");
export const BigIntStr = z.codec(z.string().regex(/^\d+$/), z.bigint(), {
  decode: (s) => BigInt(s), encode: (b) => b.toString(),
}); // wire = decimal string, TS = bigint; JSON Schema emitted with io:"input"
export const ChainId = z.union([z.literal(1), z.literal(42161), z.literal(11155111), z.literal(49222)]);

// packages/core/src/tools/registry.ts
export interface ToolDef<In extends z.ZodType, Out extends z.ZodType> {
  name: `cork_${string}`;            // MCP name; CLI path derived (cork_markets_list → cork markets list)
  title: string;
  description: string;               // ≤2 sentences; deep docs live behind cork_help
  annotations: { readOnlyHint: boolean };
  input: In; output: Out;            // outputs stay codec-free wire shapes (JSON-safe)
  handler: (input: z.output<In>, ctx: Ctx) => Promise<z.input<Out>>;
}
```
- MCP side: `registerTool(def.name, { inputSchema: def.input, outputSchema: def.output, … },
  def.handler)` — SDK v2 accepts zod v4 directly, validates both directions, returns
  `structuredContent`.
- CLI side: trpc-cli renders the same zod inputs as flags/positionals (`.meta({positional,
  alias})`), plus `--json '<whole-input>'` for agents. trpc-cli is confined to `packages/cli`
  wiring; if it stalls (solo maintainer, 0.x), the registry re-renders onto commander in days.
- Rules that keep this honest: inputs max 1 nesting level; bigints as decimal strings; hex/
  address as pattern strings; **never** `z.instanceof`, transforms that lose JSON fidelity, or
  zod-to-json-schema (EOL, silently wrong on v4).
- **Boundary schemas are wire-typed (verified empirically, see experiments/02-dx-smoke.md G2):**
  trpc-cli's norpc builder requires input-type == output-type, so `z.codec(string→bigint)` does
  not typecheck at the boundary. Inputs/outputs stay JSON-native (decimal strings, hex strings);
  handlers decode to `bigint`/branded types via internal schemas one line in. This also keeps
  MCP outputSchema/structuredContent trivially JSON-safe. (Smoke test also confirmed: MCP SDK v2
  still pre-stable on npm — start on v1 `registerTool` or v2 beta consciously; and strip
  CLI-only `.meta` keys like `positional` before exporting JSON Schema to MCP.)

## 3. MCP tool surface (§5.4 + Goal 4) — ~11 tools

| Tool | CLI | Mode-sensitive | Notes |
|---|---|---|---|
| `cork_markets_list` | `cork markets list` | yes | filters: chain, status(live/expired), asset |
| `cork_market_get` | `cork markets get <id>` | yes | full Market struct + constraint state + enrichment labels |
| `cork_orders_list` | `cork orders list` | yes | LOP + rollover; `pricing: fixed\|dutch\|rollover-premium` discriminator (future-proof, Q1/Q2) |
| `cork_rates_get` | `cork rates get <id>` | RPC-only | swapRate, oracle rate, constraints, previewSwap/previewUnwindSwap battery |
| `cork_impairment_floor` | `cork rates floor <id> --horizon 30d` | local math | committed-descent model; cites lastAdjustedRate/credits inputs + block |
| `cork_tx_prepare` | `cork tx prepare <action> …` | RPC | discriminated union over all 13 safe* actions → full Bundler3 bundle + human summary + guards (whitelist check, paused bitmap, expiry, deadline) |
| `cork_tx_decode` | `cork decode <calldata\|txhash>` | RPC/offline | recursive Bundler3 unwrap → labeled JSON (validated on real tx) |
| `cork_rfq_quote` | `cork rfq quote …` | hybrid | Goal 3; schema stubbed pending Q5 |
| `cork_meta_config` | `cork meta config` | github/vendored | addresses + provenance (commit SHA, CREATE2-verified?) |
| `cork_meta_whitelist` | `cork meta whitelist <id> [addr]` | yes | poolWhitelistStatus + per-account check |
| `cork_help` | `cork help <topic>` | offline | deep docs; keeps other descriptions terse |

- No bespoke tool-search tool: names/descriptions are written keyword-dense; native client-side
  tool search (defer_loading) handles budget. Re-evaluate only if non-Claude hosts dominate.
- Every response carries an envelope: `{data, meta: {chainId, block, mode, fetchedAt,
  staleness, refs: [doc links]}, warnings: []}`.

## 4. Data modes (§5.2)

- `--mode centralized` → api-phoenix.cork.tech (fast, trusted, may lag chain).
- `--mode rpc` (Lite-Decentralized) → user/config RPCs with a fallback pool; historical-log ops
  **fail honestly** when the endpoint lacks archive (observed: publicnode 403s) with a labeled
  error and remediation hint.
- `--mode indexer` (Full-Decentralized) → HyperSync (user's `ENVIO_API_TOKEN`) for
  MarketCreated/PoolSwap/OrderFilled backfills + RPC for live state. Caveat documented: token
  is a soft-centralized dependency (Q8); reorg handling via `rollback_guard` + parent-hash
  polling at tip (never `stream()` at tip).
- `--mode auto` = centralized → rpc → indexer with **per-answer provenance** in `meta.mode`;
  never silently mixes modes within one response.

## 5. Parity guarantee for time-dependent math (§5.5)

Decision proposed: **hybrid**.
- *Current* values: always `eth_call` (swapRate, previews) — they're views, no drift risk.
- *Projections* (no on-chain view): worst-case floor over horizon, descent schedule, unwind-fee
  decay curve → local TS bigint-WAD port.
- Parity harness = exactly what was built today: forge fork tests (podman image) that drive the
  real contracts through warped time and emit golden vectors (JSON); the TS implementation must
  match **bit-for-bit** (the 1-wei rounding artifacts are reproducible integer division). CI
  re-runs the fork suite against a pinned vnet/anvil fork block weekly + on contract-version
  bumps; drift = red build. Local math outputs always cite their input snapshot (block, stored
  constraints) so agents can re-derive.

## 6. Enrichment layer (§5.6)

- `packages/enrichment`: bundled JSON keyed `(chainId, address, contractVersion)` — labels,
  units (WAD/native-decimals), doc refs. Two URLs per ref: docs.cork.tech page (humans; site
  blocks bots) + pinned raw markdown from `Cork-Technology/docs@<sha>` (agents).
- Error taxonomy: custom-error selector → name/args/meaning (e.g. `0x6abe01f1` NotWhitelisted,
  `0x940f5f69` onlyCorkPoolManager, panic 0x11 during preview → "oracle failure" label).
- Versioned against deployments: enrichment entries carry the Sourcify verification match +
  deploy block; `cork meta config --verify` recomputes CREATE2 from prod.toml salts.
- Known-wrong docs flagged (D4 MarketId page) rather than silently linked.

## 7. GitHub-sourced config (§5.9)

- Release-time: sync prod.toml + frontend config + ABIs (Sourcify as tie-breaker) into
  `packages/core/src/deployments/` pinned to commit SHAs; record provenance.
- Runtime: `cork meta refresh [--ref main]` re-fetches, diffs, and **verifies**: (a) CREATE2
  address derivation from salts + deployer, (b) on-chain `extcodehash` presence, (c)
  config-vs-frontend-vs-Sourcify triangle; mismatches are surfaced (exit code + warnings[]),
  never auto-resolved (per brief).
- Full-Decentralized offline story: vendored snapshot works with zero github.com access;
  refresh is optional. GitHub surface beyond config for v1: ABIs + docs mirror only (releases/
  wiki later).

## 8. Repo skeleton (§5.7)

```
cork-helper-cli/
├── pnpm-workspace.yaml            # packages/*
├── packages/
│   ├── schemas/                   # zod v4 kit: primitives, tool input/output schemas, envelope
│   ├── core/                      # domain logic: markets, orders, rates(+floor math), tx build/decode,
│   │   ├── src/deployments/       #   vendored pinned config + ABIs (+provenance.json)
│   │   ├── src/datasources/       #   centralized | rpc | hypersync clients behind one interface
│   │   └── src/tools/             #   the ToolDef registry (single source of truth)
│   ├── cli/                       # trpc-cli wiring + output formatting (thin)
│   ├── mcp/                       # MCP SDK v2 wiring: stdio + streamable HTTP (thin)
│   └── enrichment/                # labels, refs, error taxonomy (JSON + loader)
├── experiments/fork-harness/      # forge parity/characterization suite (exists, 9 green)
├── notes/                         # this lab notebook
└── crates/                        # (deferred) alloy-node addon slot; PoC imported when needed
```
Build discipline: `tsc --noEmit` gate; strict + noUncheckedIndexedAccess +
exactOptionalPropertyTypes from day one; publish as one npm package `@cork/cli` (bin: `cork`)
re-exporting workspace builds; napi prebuilds only if/when `crates/` graduates.

## 9. Hosted mode (§5.8) + forgotten things (§5.10)

- Hosted MCP (streamable HTTP): OAuth per MCP spec or api-key header (decide with infra); rate
  limit per token; responses carry `staleness` so clients can enforce freshness; schema version
  in server info + `cork_help version` tool; SSE keep-alives.
- Reorg policy: centralized mode inherits API's consistency; indexer mode: rollback_guard;
  rpc mode: `block` pinning per response envelope.
- Multichain: every tool takes `chainId` (default from config); virtual 49222 supported as
  first-class test chain.
- Idempotency: tx-prep is pure (no nonce/gas policy inside — the wallet decides); include
  `validUntil`/deadline guidance instead.
- Supply chain: pnpm lockfile + `minimumReleaseAge` (or pnpm's equivalent gating), provenance-
  pinned config, no postinstall scripts, SLSA-ish release workflow; single-binary (bun compile /
  Node SEA) deferred — npx is the MCP norm and SEA complicates napi later.
- Telemetry: none by default (agents + DeFi = privacy-sensitive); opt-in crash reporting only.

## 10. Suggested build order (when we start building)

1. `packages/schemas` + registry kit (the §2 pattern) with 2 pilot tools:
   `cork_market_get`, `cork_tx_decode` (both fully testable against vnet snapshots today).
2. Floor math port + bit-parity CI against the existing forge harness.
3. `cork_tx_prepare` bundle builder (validate by byte-equality against the real captured tx).
4. Data-source abstraction + modes; markets/orders list tools.
5. MCP wiring (SDK v2 stable lands ~2026-07-28 — timing is perfect), then hosted HTTP.
6. RFQ (Goal 3) after Q5 answers.
```
