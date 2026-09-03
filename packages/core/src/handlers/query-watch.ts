// cork_query orderbook `wait`: the long-poll over the ranked book. Split from query.ts (2026-09-03)
// — the read it repeats is injected (`read` = handleQuery), so this module has no import cycle
// with the dispatcher and can be tested with any reader.
import type { Envelope, QueryInput } from "@cork/schemas";
import { WATCH_POLL_SECONDS } from "../orders-watch.ts";
import { defaultSleep, type HandlerContext } from "./shared.ts";

// ── watch: long-poll the ranked book until it changes ────────────────────────────────────────
// Driven by poll COUNT, not the wall clock: `wait` seconds at WATCH_POLL_SECONDS cadence is
// ceil(wait / cadence) reads, so an injected instant sleep makes the loop deterministic and a
// real one paces it. Each poll is the same ranked read a caller would make by hand; the loop
// returns on the first read whose `changes.changed` is true, on a non-ok state, on abort, or when
// the polls run out — and says which under `waited`.
export async function handleQueryWait(input: QueryInput, ctx: HandlerContext, read: (input: QueryInput, ctx: HandlerContext) => Promise<Envelope>): Promise<Envelope> {
  const { wait, ...single } = input;
  const polls = Math.max(1, Math.ceil((wait as number) / WATCH_POLL_SECONDS));
  const pause = ctx.sleep ?? defaultSleep;
  for (let poll = 1; ; poll++) {
    const env = await read(single as QueryInput, ctx);
    const data = env.data as Record<string, unknown>;
    const changed = (data.changes as { changed?: boolean } | undefined)?.changed === true;
    const exhausted = poll >= polls;
    const aborted = ctx.signal?.aborted === true;
    if (env.state !== "ok" || changed || exhausted || aborted) {
      return { ...env, data: { ...data, waited: { requestedSeconds: wait, pollIntervalSeconds: WATCH_POLL_SECONDS, polls, pollsMade: poll, changed, endedBy: changed ? "change" : aborted ? "abort" : exhausted ? "timeout" : "state" } } };
    }
    await pause(WATCH_POLL_SECONDS * 1000, ctx.signal);
  }
}
