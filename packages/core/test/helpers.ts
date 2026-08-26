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

/** A pool-manager view of one live pool — what a funded prepare needs and nothing more:
 *  `market` + `shares` for the token addresses, and the pre-flight views (`paused`,
 *  `getPausedBitMap`, `isWhitelisted`) answering "open". No `getCode`, so the implementation
 *  guard skips itself (documented best-effort degradation) and these tests stay about funding. */
export const POOL_TOKENS = {
  collateral: "0x0000000000000000000000000000000000000c01",
  reference: "0x0000000000000000000000000000000000000c02",
  cst: "0x0000000000000000000000000000000000000c03",
  cpt: "0x0000000000000000000000000000000000000c04",
} as const;
export function poolTokensRpc(): NonNullable<HandlerContext["resolveRpc"]> {
  return async () => ({
    url: "https://stub.example/rpc",
    source: "explicit" as const,
    client: {
      readContract: async ({ functionName }: { functionName: string }) => {
        switch (functionName) {
          case "market":
            return { collateralAsset: POOL_TOKENS.collateral, referenceAsset: POOL_TOKENS.reference, expiryTimestamp: 9_999_999_999n, rateMin: 1n, rateMax: 1n, rateChangePerDayMax: 1n, rateChangeCapacityMax: 1n, rateOracle: POOL_TOKENS.collateral };
          case "shares":
            return [POOL_TOKENS.cpt, POOL_TOKENS.cst];
          case "paused":
            return false;
          case "getPausedBitMap":
            return 0n;
          case "isWhitelisted":
            return true;
          default:
            throw new Error(`no stub for ${functionName}`);
        }
      },
    } as never,
  });
}
