// How the hosted HTTP server (`ch mcp --http`) stops, with analytics in the picture. Pure over
// the two objects it is handed (no analytics import: lib/mcp-analytics.ts keeps its two importers),
// so packages/mcp/test/shutdown.test.ts drives each path with fakes and fake timers.
//
//   SIGTERM/SIGINT  gracefulStop: the analytics flush starts AT ONCE, concurrently with the
//                   listener drain — a slow in-flight call cannot starve it inside the drain
//                   bound — and the shutdown after the drain sends what the drained calls
//                   recorded, then closes analytics. bin.ts bounds the whole by DRAIN_MS.
//   a fatal crash   fatalStop: capture the exception, stop the listener and close the open
//                   connections (nothing more is served by a dying process), then flush;
//                   boundedFatal holds the whole to FATAL_FLUSH_MS, so a dead PostHog cannot
//                   keep a crashed process alive.

/** The fatal path's bound: the process exits 1 no later than this after the crash. */
export const FATAL_FLUSH_MS = 2_000;

export interface StoppableServer {
  stop(closeActive?: boolean): Promise<void>;
}

export interface FlushingAnalytics {
  captureException(err: unknown, meta?: undefined, opts?: { site?: string; fatal?: boolean }): void;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
}

/** The graceful stop: drain the listener while the analytics queue is already being sent. */
export async function gracefulStop(server: StoppableServer, analytics?: FlushingAnalytics): Promise<void> {
  const early = analytics?.flush();
  await server.stop();
  await Promise.all([early, analytics?.shutdown()]);
}

/** The crash path: record the exception, close the listener and its connections, flush. */
export async function fatalStop(server: StoppableServer | undefined, analytics: FlushingAnalytics, err: unknown): Promise<void> {
  analytics.captureException(err, undefined, { site: "process/fatal", fatal: true });
  // Not awaited: a connection that will not close must not delay the flush.
  void server?.stop(true).catch(() => undefined);
  await analytics.shutdown();
}

/** Settle when `work` does or after `ms`, whichever is first; never rejects. */
export function boundedFatal(work: () => Promise<void>, ms: number = FATAL_FLUSH_MS): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
    (timer as { unref?: () => void }).unref?.();
  });
  const run = Promise.resolve().then(work).catch(() => undefined);
  return Promise.race([run, bound]).finally(() => clearTimeout(timer));
}
