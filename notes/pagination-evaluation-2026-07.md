# Evaluation: activating `cork_query` cursor/pageSize (2026-07-22) — DEFERRED

Decision: **keep `cursor`/`pageSize` reserved.** Downsides found empirically; activation
would ship data-integrity hazards, not polish.

## What the venue actually does today (probed live against api-phoenix)

- Every list endpoint (`/pools`, `/limit-orders/orderbook`, `/limit-orders/fills`,
  `/rollover/orders`) already returns the `{items, nextCursor, hasMore}` envelope, and
  `?limit=N` truncates correctly. Good bones.
- **`nextCursor` is never populated** — `null` even when `limit=2` withheld 15 of 17
  pools. There is no way to fetch page 2.
- **`hasMore` lies** — `false` while 15 items were withheld. An agent trusting it would
  conclude the 2-item list is complete.
- **A garbage `cursor` silently returns page 1** — the exact anti-pattern the 2026
  community guidance calls out (silent page-1 fallback causes agent retry loops); the
  contract requires a teaching error instead.

## Why each activation shape loses

1. **Pass-through** (`pageSize`→`limit`, `cursor`→`cursor`): inherits all three bugs and
   launders them through our envelope — the tool would assert completeness it cannot know.
2. **`pageSize` alone** (no cursor): honest truncation is detectable by over-fetching
   `limit+1`, but with no working upstream cursor there is no page 2 at all — a schema
   advertising a cursor that can never work is worse than one that says "reserved".
3. **Client-side pagination** (fetch-all + slice + synthetic cursor): works, but an opaque
   cursor over a mutating unsnapshotted list yields dupes/gaps between calls, and today's
   list sizes (17 pools; empty books/feeds pre-launch) make the complexity pure liability.

## What unblocks it

Upstream (venue) fixes, in order: populate `nextCursor` when truncating; make `hasMore`
truthful; reject malformed/expired cursors with an explicit error. Once those land,
activation is straightforward: `pageSize`→`limit`, opaque pass-through `cursor`, envelope
reports `nextCursor`/`hasMore` verbatim, teaching error (never page 1) on a rejected
cursor — the de-facto contract already recorded in `notes/research/mcp-frontier-2026.md`.
HyperSync-backed lists have a natural stable cursor for free (`next_block` from the query
response) and can activate independently when full-decentralized reads grow past one page.

## Asks for the venue team (raouf)

- `nextCursor`/`hasMore` on truncated responses (currently null/false with data withheld).
- Explicit 4xx on invalid cursor instead of silently serving page 1.
