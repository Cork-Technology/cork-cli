# DX smoke test — zod v4 + trpc-cli one-schema pattern (2026-07-15)

Scratch project (session scratchpad `dx-smoke/`, not committed): zod 4.4.3, trpc-cli 0.15.1,
@modelcontextprotocol/sdk 1.29.0, bun 1.3.14. One `floorInput` zod schema exercised as all
three consumers.

## What worked (verified)

1. **JSON Schema for MCP**: `z.toJSONSchema(floorInput, {io:"input"})` → clean draft-2020-12
   with `pattern`, `description`, `default`, `required` — directly usable as MCP inputSchema.
2. **CLI**: `createCli({router})` with the built-in norpc `t` (zero @trpc/server dep):
   `.meta({positional:true})` → positional arg; camelCase → kebab-case flags; zod constraints
   (min/max/pattern/default) rendered into `--help`; invocation parsed, validated, and executed
   (worst-rate math on bigints, exact against hand-check).
3. **Types**: handler receives fully inferred `{poolId: string; horizonDays: number;
   lastAdjustedRate: bigint}` — defaults applied (no `| undefined`), codec decoded.

## Gotchas caught (record for the real build)

- **G1 — MCP SDK v2 not on npm yet**: `@modelcontextprotocol/sdk` latest = 1.29.0 (v1 API);
  v2 (`@modelcontextprotocol/server`) still pre-stable. Start on v1's `registerTool` (zod v4
  works there) or the v2 beta consciously; re-check ~2026-07-28.
- **G2 — trpc-cli norpc builder rejects codecs at the type level**: its `.input()` wants
  `StandardSchemaV1<T,T>` (input type == output type), so `z.codec(string→bigint)` fails tsc.
  Options: (a) boundary schemas stay wire-typed (strings) and handlers decode internally —
  aligns with the "outputs codec-free" rule anyway; (b) use real `@trpc/server` initTRPC whose
  procedures support In≠Out; (c) upstream PR. Decision for draft: **(a)**, keep codecs as an
  internal convenience only.
- **G3 — old import style deprecated**: `trpcServer` re-export is a deprecation stub; norpc
  `t`/`os` are the supported no-dependency builders. norpc `t.procedure` has **no `.output()`**
  — output schemas must live in our own registry metadata (we need them for MCP anyway).
- **G4 — strict-tsc environment needs**: `@types/json-schema` (trpc-cli d.ts references it),
  `@types/node` (uses `node:stream` in types), `esModuleInterop: true` (zod v4 locales .d.cts).
  None are blockers; all belong in the repo's base tsconfig/devDeps.
- **G5 — `.meta({positional:true})` leaks into JSON Schema output** (`"positional": true`
  keyword). Strip CLI-only meta keys when exporting MCP schemas.

## Net assessment

The one-schema pattern holds up empirically; the seams are exactly where research predicted
(codec io-types at the boundary, CLI-meta vs JSON-Schema hygiene). No finding threatens the
architecture; G2 slightly reshapes it (wire-typed boundary schemas + internal decode), which
is arguably cleaner anyway.
