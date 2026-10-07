// Shared offline test stubs. The handlers only ever touch the RPC through
// HandlerContext.resolveRpc, so tests inject a fake resolver whose viem client answers a fixed
// set of methods. These two helpers remove the `{ url, source, client: … as never }` envelope
// boilerplate that was hand-rolled across the handler test files.
import type { HandlerContext } from "@cork/core";
import { BUNDLED_DEFAULTS, generationsOf } from "@cork/core";

/** Every address the approved-implementations guard fingerprints, read from the same config the
 *  guard resolves them from — every GENERATION's corkAdapter/whitelistManager/registry/adapter/
 *  creator, since a prepare may target any active set. A stub that holds no bytecode must not
 *  answer "0x" for these — that would be the FALSE statement "the adapter is an empty account",
 *  which the bytes-decoder gate (the versioning policy's bytes-layout rule) now REFUSES on.
 *  Throwing is the honest answer: unreadable, silent degradation. A test that wants a verdict
 *  passes real (or off-list) code through opts.code. */
const IMPLEMENTATION_ROLE_ADDRESSES = new Set(
  Object.keys(BUNDLED_DEFAULTS.generations)
    .flatMap((chainId) => generationsOf(BUNDLED_DEFAULTS, Number(chainId)))
    .flatMap((g) => [g.phoenix?.corkAdapter, g.phoenix?.whitelistManager, g.marketRegistry?.registry, g.marketRegistry?.adapter, g.marketRegistry?.marketCreator])
    .filter((a): a is `0x${string}` => typeof a === "string")
    .map((a) => a.toLowerCase()),
);

/** A readContract/simulateContract call as the handlers issue it (address + functionName + args). */
export type StubCall = { functionName: string; args?: readonly unknown[]; address: string };

/** Plausible runtime bytecode for a fixture TOKEN. Any non-"0x" answer reads as has-code to the
 *  maker-readiness probe — and fixture tokens must HAVE code: a code-less makerAsset is the
 *  silent-noop class (the LOP's transfer helper counts a call to a code-less address as SUCCESS)
 *  and the ranked book rightly excludes it, which is exactly what healthy fixture rows must not
 *  be. Pass `{ [token.toLowerCase()]: TOKEN_CODE }` through stubRpc's `code` opt. */
export const TOKEN_CODE = "0x6080604052";

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
    /** eth_getCode answers, keyed by lowercased address; absent addresses answer "0x" (no code) —
     *  except the implementation-role addresses, which throw (unreadable) unless a fixture is given. */
    code?: Record<string, string> | undefined;
    /** eth_call answers (the fill-simulation probe). Default: reject as a TRANSPORT failure, so
     *  a probe against a stub with no call model reports verdict "unknown" — honest, never a
     *  fabricated fillable/would-revert. */
    call?: ((a: { to: string; data: string; account?: string }) => unknown) | undefined;
  } = {},
): NonNullable<HandlerContext["resolveRpc"]> {
  return async () =>
    stubResolved(
      {
        readContract: async (c: StubCall) => handler(c),
        simulateContract: async (c: StubCall) => ({ result: handler({ ...c, functionName: `simulate:${c.functionName}` }) }),
        simulateCalls: async (a: { account: string; calls: { to: string; data: string }[]; stateOverrides?: unknown }) => (opts.simulateCalls ? opts.simulateCalls(a) : { results: [] }),
        call: async (a: { to: string; data: string; account?: string }) => {
          if (opts.call) return opts.call(a);
          throw Object.assign(new Error("stub: no eth_call model"), { name: "HttpRequestError" });
        },
        getCode: async ({ address }: { address: string }) => {
          const fixture = opts.code?.[address.toLowerCase()];
          if (fixture !== undefined) return fixture;
          if (IMPLEMENTATION_ROLE_ADDRESSES.has(address.toLowerCase())) throw new Error(`stub holds no bytecode for implementation role ${address}`);
          return "0x";
        },
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

/** An RFQ v2 write signed the way a writer would: the signer field (requester on open and
 *  counter, underwriter on answer) set to `signer`, then the CorkRfqWrite typed data that
 *  cork_prepare_orders rfq-write hands out signed into auth. `kind` is the target RFQ's. */
export async function proveRfqWrite<T extends { chainId: number; clientRequestId: string; action: Record<string, unknown> }>(
  signer: { address: `0x${string}`; signTypedData: (td: never) => Promise<`0x${string}`> },
  input: T,
  kind?: "new_position" | "rollover",
): Promise<T> {
  const { planRfqWrite } = await import("../src/rfq-bodies.ts");
  const action = { ...input.action };
  delete action.auth;
  if (action.type === "rfq-answer") action.underwriter = signer.address;
  else action.requester = signer.address;
  let signature: `0x${string}` = "0x00";
  try {
    const plan = planRfqWrite({ chainId: input.chainId, clientRequestId: input.clientRequestId, request: action as never, ...(kind ? { target: { kind } } : {}) });
    signature = await signer.signTypedData(plan.typedData as never);
  } catch {
    // An input the tool must refuse in words (a bigint where a string belongs) cannot be
    // hashed; it keeps a placeholder proof and is refused before the proof is read.
  }
  return { ...input, action: { ...action, auth: { method: "signature", signature } } };
}

/** A value as the venue stores it: every address and bytes32 lowercased, everything else kept. */
export function asStored<T>(value: T): T {
  if (typeof value === "string") return (/^0x[0-9a-fA-F]{40}$/.test(value) || /^0x[0-9a-fA-F]{64}$/.test(value) ? value.toLowerCase() : value) as T;
  if (Array.isArray(value)) return value.map(asStored) as T;
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, asStored(v)])) as T;
  return value;
}

/** A v2 RFQ record as GET /rfqs/v2/{id} serves it (row facts beside the stored request). */
export function rfqRecord(o: { rfqId?: string; requester: string; kind?: "new_position" | "rollover"; chainId?: number; state?: "open" | "expired"; answers?: unknown[]; truncated?: boolean }): Record<string, unknown> {
  return {
    rfq_id: o.rfqId ?? "rfq_1",
    state: o.state ?? "open",
    kind: o.kind ?? "new_position",
    version: 1,
    received_at: 1_790_000_000,
    answers: o.answers ?? [],
    truncated: o.truncated ?? false,
    request: { schema_version: "2", kind: o.kind ?? "new_position", requester: o.requester.toLowerCase(), chain_id: o.chainId ?? 42161 },
  };
}

/** A cover order an RFQ v2 option can carry: it sells a (placeholder) cST for `collateral`, made
 *  by `maker` — the shape cork_submit holds every quoted option to. */
export function coverQuoteOrder(maker: string, collateral: string, salt: number | string = 1): Record<string, string> {
  return { salt: String(salt), maker, receiver: "0x0000000000000000000000000000000000000000", makerAsset: "0x5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c", takerAsset: collateral, makingAmount: "1", takingAmount: "1", makerTraits: "0" };
}

/** Quoted options with a GENUINE order_signature by `signer` over each option's order (chain
 *  42161's LOP domain) — the proof cork_submit checks before relay. */
export async function signQuotes(signer: { sign: (a: { hash: `0x${string}` }) => Promise<`0x${string}`> }, options: Array<Record<string, unknown>>): Promise<Array<Record<string, unknown>>> {
  const { hashLopOrder, LOP_ADDRESSES } = await import("../src/orders.ts");
  const { parseQuotedOrder } = await import("../src/rfq-quotes.ts");
  return Promise.all(options.map(async (o) => {
    const parsed = parseQuotedOrder(o.order);
    return parsed.ok ? { ...o, order_signature: await signer.sign({ hash: hashLopOrder(42161, LOP_ADDRESSES[42161]!, parsed.order) }) } : o;
  }));
}
