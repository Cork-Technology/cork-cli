// Shared offline test stubs. The handlers only ever touch the RPC through
// HandlerContext.resolveRpc, so tests inject a fake resolver whose viem client answers a fixed
// set of methods. These two helpers remove the `{ url, source, client: … as never }` envelope
// boilerplate that was hand-rolled across the handler test files.
import type { HandlerContext } from "@cork/core";

/** A readContract/simulateContract call as the handlers issue it (address + functionName + args). */
export type StubCall = { functionName: string; args?: readonly unknown[]; address: string };

/** Wrap a (partial) viem client into the ResolvedRpc envelope a resolver returns. `client` is a
 *  bag of just the methods the code under test calls (readContract, call, simulateCalls, …). */
export function stubResolved(
  client: Record<string, (...args: never[]) => unknown>,
  source: "explicit" | "default" = "explicit",
  url = "https://stub/rpc",
) {
  return { url, source, client: client as never };
}

/** A resolveRpc whose client answers readContract / simulateContract / simulateCalls from ONE
 *  handler keyed on functionName ("simulate:<fn>" for simulateContract). simulateCalls defaults to
 *  an empty result set unless opts.simulateCalls is given. */
export function stubRpc(
  handler: (c: StubCall) => unknown,
  opts: {
    source?: "explicit" | "default";
    simulateCalls?: ((a: { account: string; calls: { to: string; data: string }[]; stateOverrides?: unknown }) => unknown) | undefined;
    /** eth_getCode answers, keyed by lowercased address; absent addresses answer "0x" (no code). */
    code?: Record<string, string> | undefined;
  } = {},
): NonNullable<HandlerContext["resolveRpc"]> {
  return async () =>
    stubResolved(
      {
        readContract: async (c: StubCall) => handler(c),
        simulateContract: async (c: StubCall) => ({ result: handler({ ...c, functionName: `simulate:${c.functionName}` }) }),
        simulateCalls: async (a: { account: string; calls: { to: string; data: string }[]; stateOverrides?: unknown }) => (opts.simulateCalls ? opts.simulateCalls(a) : { results: [] }),
        getCode: async ({ address }: { address: string }) => opts.code?.[address.toLowerCase()] ?? "0x",
      } as Record<string, (...args: never[]) => unknown>,
      opts.source ?? "explicit",
    );
}
