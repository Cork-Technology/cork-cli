# AGENTS.md — rules for coding agents in cork-cli

This file is for any coding agent working in this repository. `CLAUDE.md` holds the working
reference: a short root file, with the detail in `.claude/rules/*.md` (one file per area, named in
the root file's index). The rules below are the ones whose violation cost a release.

> **STOP — a new contract deployment is a NEW deployment set, never an edit of an existing one.**
> Each set under `generations.<chain>.sets` in `cork-defaults.v2.json` records ONE Distribution
> (`distribution`), and every address in it must come from THAT Distribution's component records.
> When a component is redeployed (a new adapter, registry, settler…), add a new set with the new
> Distribution name, copy the unchanged blocks, change only what the new Distribution changed,
> and declare any new wire; then move `primary` if asked. Never overwrite an address in an
> existing set: released binaries and resting orders still point at it. The mistake looks like a
> one-line address update: a redeployed adapter written into the set of the Distribution it
> replaced. `packages/core/test/market-registry-v05.test.ts` pins each set to its own adapter —
> if you need to change that test, you are probably making this mistake.

> **STOP — a revert is a change, and a regenerated fixture is not a review.** Before you commit
> a revert (or any change that regenerates `packages/core/test/fixtures/api-surface.json` or
> `packages/mcp/test/fixtures/surface.json`), diff the public surface against the LAST RELEASE
> tag: the SDK exports, the tool schemas, the JSON output. A regeneration that deletes lines
> removes something a release shipped: restore it, or list it under `### Removed` and treat
> the bump as breaking. Never regenerate a fixture just to make its gate pass — a drift gate
> compares the code with its own fixture, so a regenerated fixture passes whatever it deleted.
> `api-surface.test.ts` also compares the SDK surface with `api-surface.released.json` (the last
> release) and refuses an unrecorded removal; move that baseline forward at each release.

## Other standing rules

- Run everything with Bun (`mise.toml` pins it), never `node`.
- Edit addresses only in `cork-defaults.v2.json`; never in TypeScript, never in the frozen
  schema-1 `cork-defaults.json`.
- A new contract code hash goes into `approvedImplementations` in the same change that adds the
  address; the allowlist is never read from the remote copy.
- Never commit an RPC URL or an API key.
- No PostHog (or any analytics) SDK in any package, and no telemetry in the CLI or the stdio
  MCP server. Hosted-server analytics live only in `packages/mcp/src/lib/` (the analytics core
  (`analytics.ts`, `scrub.ts`, `telemetry-env.ts`, `log-export.ts`) and `mcp-analytics.ts`, the one entry);
  `packages/mcp/test/analytics-guard.test.ts` holds both rules.
- Gates: `bun run typecheck`, `bun run test:ci`, `bun run test:mutation`; a surface change
  regenerates its fixture only after the tier's checks (see `evals/README.md`).
- Keep this file and `CLAUDE.md` free of dated history: a rule states what to do and the test
  that holds it. The story of an incident goes in the CHANGELOG and the commit message.
