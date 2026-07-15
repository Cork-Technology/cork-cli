# Cork CLI/MCP — Lab Notebook (unattended session, 2026-07-15)

Working notes for the ~6h unattended design/research window (brief §6).

## Structure

**Start here → `architecture-draft.md`** (the synthesis), then `questions.md` (Q1–Q8 for you),
then `discrepancies.md` (D1–D9). Everything else is supporting evidence.

- `research/` — research findings, one file per thread, with sources
  - `cli-frameworks.md` — §5.1: 12 candidates; recommendation trpc-cli-over-registry, runner-up stricli
  - `schema-once-mcp.md` — §5.3+§5.4: zod v4 + MCP SDK v2; ~11 parameterized tools; no bespoke tool search
  - `cork-public-hypersync.md` — docs/llms.txt, Sourcify verification, api-phoenix.cork.tech, audits, HyperSync token/reorg/client guidance
  - `cork-contracts-domain.md` — full domain model: CorkAdapter=Bundler3 module, 13 actions, preview math, constraint source, 1inch LOP + ERC-7683 rollover, whitelist, events, ABI locations
  - `github-config-sources.md` — prod.toml + depeg-frontend analysis, address triangle, CREATE2 salts
- `experiments/` — empirical observations (runnable code in `../experiments/fork-harness/`, 9 green forge tests)
  - `01-fork-experiments.md` — sandbox constraints, market discovery, **token-bucket rate limiter fully characterized**, swap semantics, whitelist enforcement, real-tx bundle decode
  - `02-dx-smoke.md` — one-schema pattern verified live; gotchas G1–G5 (wire-typed boundary rule)
- `assumptions.md` — ASSUMPTION(n) log (A3 confirmed against source)
- `questions.md` — QUESTION(n) log, prioritized (Q1 Dutch-auction orders is the big one)
- `discrepancies.md` — claim-vs-observed table (D1–D9)
- `architecture-draft.md` — draft architecture + repo skeleton + build order

## Environment facts (verified 2026-07-15)

- Toolchain: node v24.16.0, bun 1.3.14 (via mise), pnpm 11.3.0, cargo/rustc 1.95.0, foundry 1.7.1 (forge/cast/anvil)
- `/Users/work/Projects/euler-research` exists — contains phoenix-private, rollover-private,
  limit-order-protocol, limit-order-sdk, cork-indexing-api as submodules + knowledge/ docs
- No `alloy-ts-poc/` folder in this workspace (checked; brief said "if present")
- GitHub access to private Cork-Technology repos works via MCP gateway (phoenix fetched OK)
- Tenderly vnet responds: block 0x1841828 (~25,434,152) — BEHIND mainnet head (~25,538,249 via publicnode)
  → vnet is a fork pinned/advancing from an earlier block; treat as shared state
- Public RPCs: publicnode OK; llamarpc down (521) at check time — auto-fallback design point for Lite-Decentralized mode
