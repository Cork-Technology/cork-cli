# Cork CLI/MCP — Lab Notebook (unattended session, 2026-07-15)

Working notes for the ~6h unattended design/research window (brief §6).

## Structure

- `research/` — research findings, one file per thread, with sources
  - `cli-frameworks.md` — §5.1 evaluation
  - `schema-once-mcp.md` — §5.3 + §5.4 (schema pattern, tool granularity, tool search)
  - `cork-public-hypersync.md` — Cork public docs/deployments + HyperSync patterns
  - `cork-contracts-domain.md` — domain model from euler-research + private repos
  - `github-config-sources.md` — phoenix prod.toml + depeg-frontend config analysis
- `experiments/` — empirical work on anvil fork / Tenderly vnet
  - scripts live in `../experiments/`, observations recorded here
- `assumptions.md` — ASSUMPTION(n) log
- `questions.md` — QUESTION(n) log (prioritized at end of session)
- `discrepancies.md` — claim-vs-observed table
- `architecture-draft.md` — draft architecture proposal + repo skeleton (end state)

## Environment facts (verified 2026-07-15)

- Toolchain: node v24.16.0, bun 1.3.14 (via mise), pnpm 11.3.0, cargo/rustc 1.95.0, foundry 1.7.1 (forge/cast/anvil)
- `/Users/work/Projects/euler-research` exists — contains phoenix-private, rollover-private,
  limit-order-protocol, limit-order-sdk, cork-indexing-api as submodules + knowledge/ docs
- No `alloy-ts-poc/` folder in this workspace (checked; brief said "if present")
- GitHub access to private Cork-Technology repos works via MCP gateway (phoenix fetched OK)
- Tenderly vnet responds: block 0x1841828 (~25,434,152) — BEHIND mainnet head (~25,538,249 via publicnode)
  → vnet is a fork pinned/advancing from an earlier block; treat as shared state
- Public RPCs: publicnode OK; llamarpc down (521) at check time — auto-fallback design point for Lite-Decentralized mode
