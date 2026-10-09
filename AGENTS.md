# AGENTS.md — rules for coding agents in cork-cli

This file is for any coding agent working in this repository. `CLAUDE.md` holds the full working
reference; the rules below are the ones whose violation cost a release.

> **STOP — a new contract deployment is a NEW deployment set, never an edit of an existing one.**
> Each set under `generations.<chain>.sets` in `cork-defaults.v2.json` records ONE Distribution
> (`distribution`), and every address in it must come from THAT Distribution's component records.
> When a component is redeployed (a new adapter, registry, settler…), add a new set with the new
> Distribution name, copy the unchanged blocks, change only what the new Distribution changed,
> and declare any new wire; then move `primary` if asked. Never overwrite an address in an
> existing set: released binaries and resting orders still point at it. 2026-10-07 commit
> 1573f600 wrote market-registry 0.6.0's adapter `0x960C…0616` (Distribution
> `phoenix/v0.5-rc.1`) into the `phoenix/v0.4-rc.1` set; it was reverted on 2026-10-09 and
> became set `phoenix/v0.5`. `packages/core/test/market-registry-v05.test.ts` pins each set
> to its own adapter — if you need to change that test, you are probably making this mistake.

## Other standing rules

- Run everything with Bun (`mise.toml` pins it), never `node`.
- Edit addresses only in `cork-defaults.v2.json`; never in TypeScript, never in the frozen
  schema-1 `cork-defaults.json`.
- A new contract code hash goes into `approvedImplementations` in the same change that adds the
  address; the allowlist is never read from the remote copy.
- Never commit an RPC URL or an API key.
- Gates: `bun run typecheck`, `bun run test:ci`, `bun run test:mutation`; a surface change
  regenerates its fixture only after the tier's checks (see `evals/README.md`).
