// [K7] chain-over-indexer verification for rollover orders, two independent legs:
//   1. STATUS — `ISettler.orderStatus(orderDigest)` (public view @ 032d3e5a) via the regular
//      resolved RPC: the authoritative CURRENT lifecycle status, readable with zero tokens.
//   2. EVENT HISTORY — `eth_getLogs` over a logs-capable endpoint (HyperRPC preferred; ordinary
//      public RPCs refuse historical ranges). Every settler lifecycle event indexes the
//      orderDigest as topic1, so one `topics=[null, digest]` scan from the seeding block returns
//      the full history. Endpoint + token resolution lives in ./datasources/envio.ts.
//
// Event signatures are verbatim from rollover-private @ 032d3e5a (ISettler/IPartialSettler);
// the ERC-7683 `Open` event's tuple layout is not reproduced here, so an Open log surfaces as
// an unlabeled event rather than being guessed [K3-honest].
import { keccak256, stringToHex, toEventSelector } from "viem";
import { envioToken, hyperRpcHost, redactEnvioUrl, redactUrlIn } from "./datasources/envio.ts";

type Hex = `0x${string}`;
type Address = `0x${string}`;

/** RolloverTypes.OrderStatus enum order (BS-ST-20). */
export const ORDER_STATUS_NAMES = ["None", "Opened", "Settled", "Expired", "Cancelled", "Closing"] as const;
export type ChainOrderStatus = (typeof ORDER_STATUS_NAMES)[number];

export const SETTLER_EVENTS: Record<string, string> = Object.fromEntries(
  [
    "OrderSettled(bytes32)",
    "OrderExpired(bytes32)",
    "OrderCancelled(bytes32)",
    "OrderClosing(bytes32)",
    "RolloverLegFilled(bytes32,address,bytes32,uint256,uint256)",
    "PremiumLegFilled(bytes32,address,address,bytes32,uint256)",
    "SrcCstRefunded(bytes32,address,bytes32,uint256)",
    "DefaulterResidualReclaimed(bytes32,address,address,uint256)",
    "DefaulterResidualReclaimedWithSubFiller(bytes32,address,bytes32,address,uint256)",
    "FillerSettled(bytes32,address,bytes32,uint256)",
  ].map((sig) => [toEventSelector(sig), sig.split("(", 1)[0]!]),
);

export const settlerStatusAbi = [
  {
    type: "function",
    name: "orderStatus",
    stateMutability: "view",
    inputs: [{ name: "orderDigest", type: "bytes32" }],
    outputs: [{ name: "status", type: "uint8" }],
  },
] as const;

/** Venue lifecycle → the chain statuses consistent with it (venue derives richer sub-states). */
const CONSISTENT: Record<string, ChainOrderStatus[]> = {
  PENDING: ["None"], // signed-but-unopened orders are invisible on-chain by design
  OPENED: ["Opened"],
  PARTIALLY_FILLED: ["Opened"],
  AWAITING_PREMIUM: ["Opened"],
  SETTLED: ["Settled"],
  EXPIRED: ["Expired"],
  CANCELLED: ["Cancelled"],
  CLOSING: ["Closing"],
};

/** Enum value → name. An out-of-range value (a NEWER contract's enum, or a bad read) is reported
 *  as `unknown(n)` — mapping it to "None" could fabricate a status_mismatch (venue OPENED vs
 *  fake "None") or mask one (venue PENDING matching fake "None"). */
export function chainStatusName(v: number | bigint): ChainOrderStatus | `unknown(${number})` {
  return ORDER_STATUS_NAMES[Number(v)] ?? `unknown(${Number(v)})`;
}

export function venueChainConsistent(venueStatus: string, chain: string): boolean {
  const allowed = CONSISTENT[venueStatus.toUpperCase()];
  return allowed ? (allowed as string[]).includes(chain) : false;
}

// ── Logs endpoint resolution ─────────────────────────────────────────────────

/** A logs-capable endpoint plus how to authenticate to it. `bearerToken`, when present, is sent as
 *  an `Authorization: Bearer` header (HyperRPC) — the token is NEVER placed in the URL. */
export interface LogsEndpoint {
  url: string;
  bearerToken?: string;
}

/** Resolve a logs-capable JSON-RPC endpoint: explicit override → CORK_LOGS_RPC_URL → HyperRPC
 *  (token-gated). Returns null when nothing is configured — verification then honestly reports the
 *  gap. For HyperRPC the token is returned SEPARATELY (sent as a Bearer header by fetchDigestLogs),
 *  never embedded in the URL; overrides are used verbatim (their own auth, whatever the operator
 *  baked in). Token resolution is delegated to ./datasources/envio.ts so the Envio auth rules live
 *  in exactly one place. */
export function resolveLogsEndpoint(chainId: number, override?: string): LogsEndpoint | null {
  if (override) return { url: override };
  if (process.env.CORK_LOGS_RPC_URL) return { url: process.env.CORK_LOGS_RPC_URL };
  const token = envioToken("hyperrpc");
  return token ? { url: hyperRpcHost(chainId), bearerToken: token } : null;
}

export interface RawLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  transactionHash: string;
  logIndex: string;
}

export class LogsRangeLimited extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LogsRangeLimited";
  }
}

/** Fetch every log mentioning the digest as topic1 from the given addresses (fetch-injectable).
 *  All error messages are token-safe: the URL is redacted host-only and both the raw URL and the
 *  bearer token are scrubbed out of any transport/RPC error before it is thrown. */
export async function fetchDigestLogs(args: {
  url: string;
  addresses: Address[];
  digest: Hex;
  fromBlock: number;
  bearerToken?: string;
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
  timeoutMs?: number;
}): Promise<RawLog[]> {
  // Scrub both the URL and the token from any message we might throw.
  const scrub = (m: string): string => {
    let s = redactUrlIn(m, args.url);
    if (args.bearerToken) s = s.split(args.bearerToken).join("<redacted>");
    return s;
  };
  const f = args.fetchImpl ?? fetch;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), args.timeoutMs ?? 20_000);
  let res: Response;
  try {
    res = await f(args.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(args.bearerToken ? { authorization: `Bearer ${args.bearerToken}` } : {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_getLogs",
        params: [
          {
            fromBlock: `0x${args.fromBlock.toString(16)}`,
            toBlock: "latest",
            address: args.addresses,
            topics: [null, args.digest],
          },
        ],
      }),
      signal: ctrl.signal,
    });
  } catch (err) {
    const raw = err instanceof Error ? err.message.split("\n")[0]! : String(err);
    throw new Error(`logs endpoint (${redactEnvioUrl(args.url)}) unreachable: ${scrub(raw)}`);
  } finally {
    clearTimeout(t);
  }
  const body = (await res.json().catch(() => null)) as { result?: RawLog[]; error?: { message?: string } } | null;
  if (!body || body.error || !Array.isArray(body.result)) {
    const msg = scrub(body?.error?.message ?? `HTTP ${res.status}`);
    // Range-cap rejections (non-archive nodes, free tiers) are a distinct, honest outcome.
    if (/range|archive|10000|block/i.test(msg)) throw new LogsRangeLimited(msg);
    throw new Error(`logs endpoint error: ${msg}`);
  }
  return body.result;
}

export interface LabeledLog {
  event: string;
  address: string;
  txHash: string;
  /** Decimal string — chain integers ride the wire as strings everywhere else (F10). */
  blockNumber: string;
}

export function labelLogs(logs: RawLog[]): LabeledLog[] {
  return logs.map((l) => ({
    event: SETTLER_EVENTS[l.topics[0] ?? ""] ?? `unknown (topic0 ${(l.topics[0] ?? "0x").slice(0, 10)}…)`,
    address: l.address,
    txHash: l.transactionHash,
    blockNumber: BigInt(l.blockNumber).toString(),
  }));
}

/** Deterministic content tag for a verification result (debug/aids diffing). */
export function verificationDigest(v: unknown): Hex {
  return keccak256(stringToHex(JSON.stringify(v)));
}
