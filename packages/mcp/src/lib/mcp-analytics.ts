// The hosted MCP's REPO-SPECIFIC analytics layer (`ch mcp --http`, deployed to the Phala CVM
// behind mcp.cork.tech), on top of the analytics core in lib/:
//   analytics.ts          the core (initAnalytics, trackServer, captureException, exportLog, …,
//                         the key<->env guard, identities, caps, base properties);
//   scrub.ts / telemetry-env.ts / log-export.ts
//                         the core's scrub rules, env contract and log exporter;
//   analytics-catalog.ts  PRODUCT "mcp", SERVICE, the two events;
//   posthog-http.ts       the event transport (no SDK in the public binary);
//   this file             the MCP parts: the opt-in, the schema-typed extractor for tool
//                         arguments, the session token, the client headers, the passthrough
//                         keys, request logs, and the object http.ts / bin.ts / shutdown.ts use.
//
// WHEN IT RUNS. Only `ch mcp --http` constructs it (packages/cli/src/bin.ts), and only on an
// EXPLICIT opt-in: CORK_MCP_ANALYTICS=1 AND POSTHOG_KEY is one of Cork's project keys AND
// CORK_ENV names that key's environment (the core's guard). Only Cork's own deploy config sets
// all three (packaging/phala-compose.yml); a POSTHOG_KEY that happens to be
// in someone's shell does nothing. DO_NOT_TRACK=1 and CORK_TELEMETRY=0 always win. The CLI
// commands and the stdio MCP server never import this file. Off = no object, no timer, no network.
//
// WHAT IT SENDS — metadata, plus a shape-filtered projection of tool ARGUMENTS (never by copying
// an object, never a tool result):
//   $mcp_tool_call   tool name, MCP client name/version (initialize handshake, carried in the
//                    session token below), latency, success, error code, protocol revision, the
//                    client's User-Agent / vendor header (closed shapes), chain id, and the
//                    VALIDATED arguments flattened to `<dotted.snake>` keys and kept by VALUE
//                    SHAPE only (`toolArgProperties`): booleans, finite numbers, decimal amounts,
//                    0x+40 addresses and 0x+64 hashes (lowercased), schema-declared enum values,
//                    `<key>_count` for arrays. Free strings, longer hex (signatures, permits,
//                    calldata, signed payloads), records and nested blobs are dropped, so a new
//                    field fails closed. A value is kept only where the schema declares that very
//                    shape (Bytes32, Address, numeric pattern, enum). READ tools (registry
//                    `telemetry.kind: "read"`) keep no address and no hash outside `keepHashes`.
//                    An argument key that names a top-level event property (`client`,
//                    `product`, `env`, `chain_id`, `pool_id`, …) is dropped and counted; the
//                    pool aliases come from the core's poolAliases only.
//                    The result then passes the core's scrubProperties (a second, generic
//                    shape filter, its key denylist, pool aliases, 40 properties at most).
//   $mcp_initialize  MCP client name/version and protocol revision.
//   $exception       the core's rebuilt error: class, scrubText'd message, code locations.
//   logs (OTLP)      one record per /mcp or /docs request, through the core's exporter
//                    (log-export.ts): route template, method, status, latency, client,
//                    client version, JSON-RPC method, tool name (REQUEST_LOG_KEYS, then
//                    scrubProperties; client_version through its own validator). No error
//                    text: see REQUEST_LOG_KEYS.
// NEVER: tool results ($mcp_parameters / $mcp_response are never set), free text (prompts, agent
// intent, client-chosen strings), signatures, permits, calldata, request/response bodies, headers
// other than the two client-identification ones, bearer tokens, API keys, or the caller's IP
// (no $ip; `$geoip_disable: true`).
//
// IDENTITY (the core's identityFor). A WRITE tool whose validated arguments name the acting wallet
// (registry `telemetry.actor`: the prepare `account`, a submitted order's maker, an RFQ requester
// or underwriter) is recorded under that wallet: distinct_id = the address lowercased,
// `address_verified: false` (this server never verifies a signature), person profiles on. Wallets
// are never merged or aliased ($identify / $create_alias are never sent). Every other event keeps
// the client identity `anon_mcp-<mcp client label>` with `$process_person_profile: false` (the
// hosted server refuses caller API keys, http.ts). Every event of a session carries
// `mcp_session_id`, a random `ses_<32 hex>` minted at initialize — never derived from the IP — so
// a session's calls group whichever identity they carry. It is deliberately NOT `$session_id`
// (PostHog expects a per-person UUIDv7 there).
import { randomBytes } from "node:crypto";
import { BUILD_COMMIT, BUILD_VERSION, mcpClientLabel } from "@cork/core";
import { DECIMAL_FRACTION_PATTERN, inputJsonSchema, toolByName, type ToolName } from "@cork/schemas";
import type { ToolCallObservation } from "../server.ts";
import {
  captureException,
  exportLog,
  flushAnalytics,
  identityFor,
  initAnalytics,
  logExportConfig,
  PROJECT_KEYS,
  shutdownAnalytics,
  trackServer,
  type AnalyticsSink,
  type Identity,
  type Passthrough,
} from "./analytics.js";
import { parseTelemetryEnv } from "./telemetry-env.js";
import { POOL_ALIAS_NAMES, poolAliases, snakeKey, type Properties } from "./scrub.js";

export { PROJECT_KEYS };

/** The MCP client as the session token carries it. */
export interface SessionInfo {
  sessionId: string;
  clientName?: string;
  clientVersion?: string;
}

/** What one HTTP request tells us about its caller — already reduced to closed shapes. */
export interface RequestMeta {
  session?: SessionInfo;
  protocolVersion?: string;
  userAgent?: string;
  vendorClient?: string;
}

export interface RequestLog {
  route: string;
  method: string;
  status: number;
  latencyMs: number;
  rpcMethod?: string;
  tool?: string;
  meta: RequestMeta;
}

// ── Client strings: closed shapes ──────────────────────────────────────

/** A value shaped like something personal or secret: an address or hash (0x-hex, bare hex of
 *  16+), an e-mail, an IPv4 address. Such a value is never a client name, version or revision. */
const SENSITIVE_SHAPE = /0x[0-9a-f]{4,}|[0-9a-f]{16,}|@|\b(?:\d{1,3}\.){3}\d{1,3}\b/iu;

/** A closed-charset token (versions, protocol revisions, vendor headers): [A-Za-z0-9._-], ≤ 64;
 *  undefined when nothing usable remains or the raw value has a sensitive shape. Client NAMES
 *  go through mcpClientLabel (an allowlist) instead. */
export function token(raw: unknown, max = 64): string | undefined {
  if (typeof raw !== "string" || SENSITIVE_SHAPE.test(raw)) return undefined;
  const s = raw.trim().replace(/[^A-Za-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, max);
  return s.length > 0 ? s : undefined;
}

/** A version as clients and products write it — `^v?\d+(\.\d+){0,3}([-+][0-9A-Za-z.-]{1,32})?$`
 *  (the API's own pattern) and no sensitive shape — else "other"; undefined in = undefined out. */
const VERSION_SHAPE = /^v?\d+(\.\d+){0,3}([-+][0-9A-Za-z.-]{1,32})?$/u;
export function versionToken(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string") return "other";
  const v = raw.trim();
  return VERSION_SHAPE.test(v) && !SENSITIVE_SHAPE.test(v) ? v : "other";
}

// User-Agent product names kept as-is (canonical spelling); an MCP client name maps through
// mcpClientLabel; anything else is "other". Keyed lowercase.
const UA_PRODUCTS: ReadonlyMap<string, string> = new Map(
  [
    "Mozilla", "AppleWebKit", "Chrome", "Chromium", "Safari", "Firefox", "Gecko", "Edg", "Edge", "OPR", "Electron",
    "Bun", "node", "Node.js", "Deno", "undici", "node-fetch", "axios", "got",
    "python-httpx", "aiohttp", "python-requests", "Python-urllib", "Python", "curl", "Wget", "Go-http-client", "okhttp", "Java", "reqwest",
    "cork-cli", "cork-cli-mcp", "cork-mcp", "cork-sdk", "Anthropic", "ClaudeAI", "OpenAI",
  ].map((n) => [n.toLowerCase(), n] as const),
);
function productName(raw: string): string {
  const known = UA_PRODUCTS.get(raw.toLowerCase());
  if (known !== undefined) return known;
  const label = mcpClientLabel(raw);
  return label === undefined ? "other" : label;
}

/** A User-Agent reduced to its RFC 9110 product tokens: comments dropped, at most three
 *  `name[/version]` products, the name from a known list (else "other"), the version through
 *  versionToken. `claude-code/2.1.141 (cli) node/22` → `claude-code/2.1.141 node/22`. */
export function productTokens(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  let s = raw.slice(0, 1024);
  for (let i = 0; i < 8 && /\([^()]*\)/u.test(s); i++) s = s.replace(/\([^()]*\)/gu, " ");
  const products: string[] = [];
  for (const word of s.replace(/[()]/gu, " ").split(/\s+/u)) {
    if (products.length >= 3) break;
    if (word === "") continue;
    const slash = word.indexOf("/");
    const name = productName(slash === -1 ? word : word.slice(0, slash));
    products.push(slash === -1 ? name : `${name}/${versionToken(word.slice(slash + 1))}`);
  }
  return products.length > 0 ? products.join(" ") : undefined;
}

// `x-anthropic-client` values Anthropic sends (PostHog's client detection lists the same four).
const VENDOR_CLIENTS: ReadonlyMap<string, string> = new Map([["claudecode", "ClaudeCode"], ["claudeai", "ClaudeAI"], ["cowork", "Cowork"], ["claudedesign", "ClaudeDesign"]]);
/** The vendor header from its allowlist (separators and case ignored), else "other". */
export function vendorClient(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string") return "other";
  return VENDOR_CLIENTS.get(raw.toLowerCase().replace(/[^a-z0-9]+/gu, "")) ?? "other";
}

// ── Tool arguments: shape-filtered, fail-closed ─────────────────────────
//
// A value is kept only when BOTH its shape is safe AND the tool's input schema declares that
// exact shape at its path: a `0x`+64 value only where the field is a Bytes32 (`^0x…{64}$`), a
// `0x`+40 value only where it is an Address (`{40}`), a digit/decimal string only where the field
// declares a numeric pattern, a number only where it declares a number, a string otherwise only
// when it is one of the field's declared enum/literal values. So a free-text field (`search`,
// `clientRequestId`) or a generic Hex field (`data`, `extension`, a signature) keeps nothing,
// whatever the caller puts in it, and a new field fails closed with no change here. The value and
// the schema are walked TOGETHER: a discriminated union resolves to the branches whose
// discriminator literals match the value, so one variant's Bytes32 never vouches for another
// variant's Hex at the same path. Objects: declared keys only (a record's caller-chosen keys never
// become property names), depth ≤ 3, arrays → `<key>_count`.

/** Max argument properties per event. The core keeps 40 properties at most per event
 *  (scrubProperties, `$` keys and passthrough keys aside); up to 3 pool aliases, `address_verified`,
 *  `capped_drops`, `chain_id` and `args_dropped` count there too, so 32 arguments always fit. */
export const MAX_ARG_PROPERTIES = 32;
const MAX_ARG_DEPTH = 3;
const ADDRESS_SHAPE = /^0x[0-9a-fA-F]{40}$/u;
const HASH_SHAPE = /^0x[0-9a-fA-F]{64}$/u;
const AMOUNT_SHAPE = /^\d+(?:\.\d+)?$/u;
const MAX_AMOUNT_CHARS = 78;
/** The JSON-schema patterns of the shared primitives (packages/schemas/src/primitives.ts). */
const ADDRESS_PATTERN = "^0x[0-9a-fA-F]{40}$";
const HASH_PATTERN = "^0x[0-9a-fA-F]{64}$";
const NUMERIC_PATTERNS: ReadonlySet<string> = new Set(["^[0-9]+$", DECIMAL_FRACTION_PATTERN.source]);
// The contract's enum shape, with `-` allowed: Cork's declared enum values are kebab-case
// (`account-state`, `maker-order`, `erc20-approve`). Only a value the schema itself declares at
// that path passes, so the alphabet is a closed set either way.
const ENUM_SHAPE = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/u;

type JsonNode = Record<string, unknown>;

/** What a tool call may keep: addresses (write tools only) and 32-byte hashes (every Bytes32
 *  field of a write tool; on a read tool only the declared `keepHashes` paths, camelCase dotted). */
export interface ArgPolicy {
  addresses: boolean;
  hashes: true | ReadonlySet<string>;
}

/** The alternatives a schema node stands for: `$ref`s resolved, anyOf/oneOf/allOf flattened. */
function alternatives(node: unknown, defs: Record<string, JsonNode>, hops = 0): JsonNode[] {
  if (node === null || typeof node !== "object" || hops > 32) return [];
  let n = node as JsonNode;
  const ref = n["$ref"];
  if (typeof ref === "string") {
    if (!ref.startsWith("#/$defs/")) return [];
    const { $ref: _r, ...siblings } = n;
    n = { ...(defs[ref.slice("#/$defs/".length)] ?? {}), ...siblings };
    // The target may itself be a ref or a union.
    if (typeof n["$ref"] === "string" && n["$ref"] !== ref) return alternatives(n, defs, hops + 1);
  }
  const branches = ["anyOf", "oneOf", "allOf"].flatMap((k) => (Array.isArray(n[k]) ? (n[k] as unknown[]) : []));
  if (branches.length > 0) return branches.flatMap((b) => alternatives(b, defs, hops + 1));
  return [n];
}

const literalsOf = (n: JsonNode): unknown[] => [...(Array.isArray(n["enum"]) ? (n["enum"] as unknown[]) : []), ...("const" in n ? [n["const"]] : [])];

/** An object branch fits the value when every discriminator literal it declares matches. */
function branchFits(branch: JsonNode, value: Record<string, unknown>, defs: Record<string, JsonNode>): boolean {
  const props = branch["properties"] as Record<string, unknown> | undefined;
  if (!props || typeof props !== "object") return false;
  for (const [k, p] of Object.entries(props)) {
    const alts = alternatives(p, defs);
    if (alts.length !== 1) continue;
    const lits = literalsOf(alts[0]!);
    if (lits.length === 1 && "const" in alts[0]! && value[k] !== lits[0]) return false;
  }
  return true;
}

function typeMatches(leaf: JsonNode, v: unknown): boolean {
  const t = leaf["type"];
  const types = Array.isArray(t) ? t : [t];
  const lits = literalsOf(leaf);
  if (typeof v === "string") return types.includes("string") || lits.some((l) => typeof l === "string");
  if (typeof v === "number") return types.includes("number") || types.includes("integer") || lits.some((l) => typeof l === "number");
  if (typeof v === "boolean") return types.includes("boolean") || lits.some((l) => typeof l === "boolean");
  return false;
}

/** Does this leaf schema vouch for keeping `v` (already type-matched)? */
function leafAllows(leaf: JsonNode, v: string | number | boolean, path: string, policy: ArgPolicy): boolean {
  if (typeof v === "boolean") return true;
  if (typeof v === "number") return Number.isFinite(v);
  if (literalsOf(leaf).includes(v)) return ENUM_SHAPE.test(v);
  const pattern = leaf["pattern"];
  if (pattern === HASH_PATTERN) return HASH_SHAPE.test(v) && (policy.hashes === true || policy.hashes.has(path));
  if (pattern === ADDRESS_PATTERN) return ADDRESS_SHAPE.test(v) && policy.addresses;
  if (typeof pattern === "string" && NUMERIC_PATTERNS.has(pattern)) return v.length <= MAX_AMOUNT_CHARS && AMOUNT_SHAPE.test(v);
  return false;
}

/** The rule-14 projection of one validated input against its JSON schema: declared keys only
 *  (depth ≤ 3), arrays as `<key>_count`, scalars kept only where shape AND schema agree (see the
 *  section comment), at most MAX_ARG_PROPERTIES. */
export function shapeFilteredArgs(data: unknown, schema: object, policy: ArgPolicy): { properties: Record<string, string | number | boolean>; dropped: number } {
  const doc = schema as JsonNode;
  const defs = (doc["$defs"] ?? {}) as Record<string, JsonNode>;
  const properties: Record<string, string | number | boolean> = {};
  let kept = 0;
  let dropped = 0;
  const put = (key: string, v: string | number | boolean): void => {
    if (kept >= MAX_ARG_PROPERTIES) {
      dropped++;
      return;
    }
    properties[key] = v;
    kept++;
  };
  /** `nodes`: the schema nodes declaring the object at `path` (several = union branches). */
  const walk = (obj: Record<string, unknown>, nodes: unknown[], path: string[]): void => {
    const branches = nodes.flatMap((n) => alternatives(n, defs)).filter((b) => branchFits(b, obj, defs));
    for (const [k, v] of Object.entries(obj)) {
      if (v === undefined) continue;
      const p = [...path, k];
      const children = branches.map((b) => (b["properties"] as Record<string, unknown>)[k]).filter((c) => c !== undefined);
      // Undeclared keys (a record's caller-chosen keys) never become property names.
      if (children.length === 0) {
        dropped++;
        continue;
      }
      const name = p.map(snakeKey).join(".");
      if (Array.isArray(v)) put(`${name}_count`, v.length);
      else if (v !== null && typeof v === "object") {
        // A record (no declared properties), a blob past the depth bound or a non-plain object
        // is dropped whole.
        const declared = children.flatMap((c) => alternatives(c, defs)).some((b) => b["properties"] !== undefined && typeof b["properties"] === "object");
        if (declared && p.length < MAX_ARG_DEPTH && Object.getPrototypeOf(v) === Object.prototype) walk(v as Record<string, unknown>, children, p);
        else dropped++;
      } else if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
        const leaves = children.flatMap((c) => alternatives(c, defs)).filter((l) => typeMatches(l, v));
        // EVERY declared alternative of this type must vouch for the value (a Bytes32 | Hex union
        // keeps nothing a generic Hex branch could carry).
        const ok = leaves.length > 0 && leaves.every((l) => leafAllows(l, v, p.join("."), policy));
        if (ok) put(name, typeof v === "string" && v.startsWith("0x") ? v.toLowerCase() : v);
        else dropped++;
      } else dropped++;
    }
  };
  if (data !== null && typeof data === "object" && !Array.isArray(data)) walk(data as Record<string, unknown>, [doc], []);
  return { properties, dropped };
}

const SCHEMAS = new Map<string, object>();
function schemaOf(tool: ToolName): object {
  let s = SCHEMAS.get(tool);
  if (!s) {
    s = inputJsonSchema(tool);
    SCHEMAS.set(tool, s);
  }
  return s;
}

export interface ToolArgTelemetry {
  /** `<dotted.snake>` → kept value (the same paths the API's events use: `order.maker`). No key
   *  is a top-level event name (`isReservedEventKey`). */
  properties: Record<string, string | number | boolean>;
  /** `pool_id` / `src_pool_id` / `dst_pool_id`: the core's poolAliases of `properties`
   *  (trackServer adds the same aliases to the event through scrubProperties). */
  pools: Properties;
  /** Leaf values (or blobs) seen and not kept. */
  dropped: number;
  /** The acting wallet (lowercase) of a write tool, when its input names one. */
  actor?: string;
}

/** Top-level event property names that only this layer, the core or PostHog set: the session and
 *  call fields (MCP_PASSTHROUGH keys), `chain_id` (the envelope's), `args_dropped`, the pool
 *  aliases, the core's base and identity fields and caps. An argument key is never one of them. */
const RESERVED_EVENT_KEYS: ReadonlySet<string> = new Set([
  "distinct_id",
  "product",
  "app_version",
  "build_id",
  "env",
  "address_verified",
  "agent_id",
  "agent_wallet",
  "capped_drops",
  "chain_id",
  "args_dropped",
  ...POOL_ALIAS_NAMES,
]);

/** True when `key` is a top-level event property name (see RESERVED_EVENT_KEYS, the passthrough
 *  keys, any `$` key). Dotted paths (`action.order.maker`) never are. */
export function isReservedEventKey(key: string): boolean {
  return key.startsWith("$") || RESERVED_EVENT_KEYS.has(key) || Object.hasOwn(MCP_PASSTHROUGH, key);
}

/** Drop every argument key that collides with a top-level event property; each drop is counted,
 *  except a pool id the core's alias already carries with the same value. */
export function withoutReservedKeys(properties: Record<string, string | number | boolean>, pools: Properties = {}): { properties: Record<string, string | number | boolean>; dropped: number } {
  const out: Record<string, string | number | boolean> = {};
  let dropped = 0;
  for (const [k, v] of Object.entries(properties)) {
    if (!isReservedEventKey(k)) out[k] = v;
    else if (pools[k] !== v) dropped++;
  }
  return { properties: out, dropped };
}

/** The shape-filtered projection of one tool call's arguments. Undefined when the tool is
 *  unknown or the arguments do not validate (an invalid call keeps nothing). Never throws. */
export function toolArgProperties(tool: string, rawArgs: unknown): ToolArgTelemetry | undefined {
  try {
    const def = toolByName(tool);
    if (!def) return undefined;
    const parsed = def.input.safeParse(rawArgs ?? {});
    if (!parsed.success) return undefined;
    const telemetry = def.telemetry;
    const root = parsed.data;
    const policy: ArgPolicy = telemetry.kind === "write" ? { addresses: true, hashes: true } : { addresses: false, hashes: new Set(telemetry.keepHashes ?? []) };
    const { properties, dropped } = shapeFilteredArgs(root, schemaOf(def.name as ToolName), policy);
    let actor: string | undefined;
    if (telemetry.kind === "write") {
      for (const path of telemetry.actor) {
        let cur: unknown = root;
        for (const seg of path.split(".")) cur = cur !== null && typeof cur === "object" ? (cur as Record<string, unknown>)[seg] : undefined;
        if (typeof cur === "string" && ADDRESS_SHAPE.test(cur)) {
          actor = cur.toLowerCase();
          break;
        }
      }
    }
    // The pool aliases come from the core's poolAliases over every kept path; then no argument
    // key may take a top-level event name (withoutReservedKeys).
    const pools = poolAliases(properties);
    const own = withoutReservedKeys(properties, pools);
    return { properties: own.properties, pools, dropped: dropped + own.dropped, ...(actor !== undefined ? { actor } : {}) };
  } catch {
    return undefined;
  }
}

// ── Session token (stateless MCP: carries the initialize handshake to later requests) ──
//
// The HTTP projection builds a fresh server per request, so the instance serving a tools/call
// never saw initialize. At initialize we answer `Mcp-Session-Id: <token>` (the transport is
// stateless and never validates it); the client replays it on every later request, which is how
// a tools/call learns its client name. The token is UNTRUSTED on the way back in: every field is
// re-validated, and it is used for attribution only.

const SESSION_PREFIX = "ckm1.";
const SESSION_ID = /^ses_[0-9a-f]{32}$/u;

export function newSessionId(): string {
  return `ses_${randomBytes(16).toString("hex")}`;
}

export function encodeSessionToken(info: SessionInfo): string {
  const body = { s: info.sessionId, ...(info.clientName ? { n: info.clientName } : {}), ...(info.clientVersion ? { v: info.clientVersion } : {}) };
  return SESSION_PREFIX + Buffer.from(JSON.stringify(body), "utf8").toString("base64url");
}

export function decodeSessionToken(header: string | null | undefined): SessionInfo | undefined {
  if (!header || header.length > 512 || !header.startsWith(SESSION_PREFIX)) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(header.slice(SESSION_PREFIX.length), "base64url").toString("utf8")) as { s?: unknown; n?: unknown; v?: unknown };
    if (typeof parsed.s !== "string" || !SESSION_ID.test(parsed.s)) return undefined;
    const clientName = mcpClientLabel(parsed.n);
    const clientVersion = versionToken(parsed.v);
    return { sessionId: parsed.s, ...(clientName ? { clientName } : {}), ...(clientVersion ? { clientVersion } : {}) };
  } catch {
    return undefined;
  }
}

// ── Passthrough: the MCP keys that skip the core's shape filter ────
//
// PostHog's MCP Analytics reads `$mcp_*` properties, and the core's scrubProperties drops
// every `$` key it does not own; `mcp_session_id` (36 chars) and the User-Agent product list
// (spaces, slashes) are not enum tokens either. Each such key passes ONLY through its own
// validator (initAnalytics `passthrough`): a closed value or a closed charset.

const CLIENT_LABEL = /^[a-z0-9][a-z0-9-]{0,31}$/u;
const VERSIONISH = /^(?:v?\d+(?:\.\d+){0,3}(?:[-+][0-9A-Za-z.-]{1,32})?|other)$/u;
const TOOLISH = /^[a-z][a-z0-9_]{0,63}$/u;
const matching = (re: RegExp) => (v: unknown): string | undefined => (typeof v === "string" && re.test(v) ? v : undefined);
const oneOf = (...allowed: string[]) => (v: unknown): string | undefined => (typeof v === "string" && allowed.includes(v) ? v : undefined);

export const MCP_PASSTHROUGH: Passthrough = {
  mcp_session_id: matching(SESSION_ID),
  client: matching(CLIENT_LABEL),
  envelope_state: matching(/^[a-z][a-z_]{0,31}$/u),
  $mcp_source: oneOf("posthog_mcp_analytics"),
  $mcp_interface: oneOf("mcp"),
  $mcp_server_name: oneOf("cork-mcp"),
  $mcp_server_version: matching(/^[0-9A-Za-z.+-]{1,64}$/u),
  $mcp_server_build: matching(/^(?:[0-9a-f]{7,40}|unknown)$/u),
  $mcp_client_name: matching(CLIENT_LABEL),
  $mcp_client_version: matching(VERSIONISH),
  $mcp_protocol_version: matching(/^[A-Za-z0-9._-]{1,32}$/u),
  $mcp_client_user_agent: matching(/^[A-Za-z0-9._/ +-]{1,200}$/u),
  $mcp_vendor_client: matching(/^[A-Za-z]{1,32}$/u),
  $mcp_tool_name: matching(TOOLISH),
  $mcp_resource_name: matching(TOOLISH),
  $mcp_duration_ms: (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined),
  $mcp_is_error: (v) => (typeof v === "boolean" ? v : undefined),
  $mcp_error_type: matching(TOOLISH),
};

/** The identity of every event that is not a write naming its wallet: `anon_mcp-<label>`
 *  (`anon_mcp-…` never collides with the API's own anon_ ids, anon_other / anon_unknown). */
function clientIdentity(meta: RequestMeta): Identity {
  return identityFor({ client: `mcp-${meta.session?.clientName ?? "unknown"}`, ...capKeyOf(meta) });
}

/** The session id as the core's `capKey`: each session has its own per-caller minute cap
 *  (all sessions of one client share `anon_mcp-<client>`). Memory only, never sent. */
function capKeyOf(meta: RequestMeta): { capKey?: string } {
  return meta.session ? { capKey: meta.session.sessionId } : {};
}

/** The session and client part every event carries (all passthrough keys). */
function sessionProperties(meta: RequestMeta): Record<string, unknown> {
  const s = meta.session;
  return {
    // A dashboard filter label PostHog's MCP Analytics views select on — not an SDK marker.
    $mcp_source: "posthog_mcp_analytics",
    $mcp_interface: "mcp",
    $mcp_server_name: "cork-mcp",
    $mcp_server_version: BUILD_VERSION.replace(/^v/u, ""),
    $mcp_server_build: BUILD_COMMIT,
    // Not `$session_id`: PostHog's session features expect a UUIDv7 unique to one person, and
    // an MCP session can act for several wallets. A plain grouping property instead.
    ...(s ? { mcp_session_id: s.sessionId } : {}),
    ...(s?.clientName ? { $mcp_client_name: s.clientName } : {}),
    // `client` = the software that called this product (the core's meaning of `client`): here the AI
    // app that drives the MCP session (the allowlisted label, "unknown" without a handshake). On
    // the API the same property names the Cork client (`cork-cli`, `cork-mcp`, …), on purpose;
    // a cross-product journey joins on the wallet or the session, never on `client`.
    client: s?.clientName ?? "unknown",
    ...(s?.clientVersion ? { $mcp_client_version: s.clientVersion } : {}),
    ...(meta.protocolVersion ? { $mcp_protocol_version: meta.protocolVersion } : {}),
    ...(meta.userAgent ? { $mcp_client_user_agent: meta.userAgent } : {}),
    ...(meta.vendorClient ? { $mcp_vendor_client: meta.vendorClient } : {}),
  };
}

/** The object http.ts and bin.ts hold: the core's module functions, MCP-shaped. */
export class McpAnalytics {

  /** One tools/call. Built field by field from the observation (which carries no result by
   *  construction, server.ts) and from the shape-filtered projection of the call's arguments
   *  (`toolArgProperties`) — the raw arguments themselves are never handed on. */
  toolCall(call: ToolCallObservation, meta: RequestMeta, rawArgs?: unknown): void {
    const args = call.tool === "unknown_tool" || rawArgs === undefined ? undefined : toolArgProperties(call.tool, rawArgs);
    // A write naming its acting wallet is that wallet's event (person profiles on, the address
    // unverified: this server never sees a signature verified); anything else keeps the client id.
    const identity = args?.actor !== undefined ? identityFor({ wallet: { address: args.actor, verified: false } }) : clientIdentity(meta);
    const props: Record<string, unknown> = {
      ...sessionProperties(meta),
      $mcp_tool_name: call.tool,
      $mcp_resource_name: call.tool,
      $mcp_duration_ms: call.durationMs,
      $mcp_is_error: call.isError,
      ...(call.errorType ? { $mcp_error_type: call.errorType } : {}),
      envelope_state: call.state,
      ...(call.chainId !== undefined ? { chain_id: call.chainId } : {}),
      ...(args ? { args_dropped: args.dropped, ...args.pools } : {}),
    };
    // toolArgProperties already removed every key that names a top-level event property, so an
    // argument never overwrites a fixed field (nor a core field after it).
    Object.assign(props, args?.properties);
    trackServer("mcp_tool_call", props, identity);
    if (call.errorType === "internal_error" && call.error !== undefined) this.captureException(call.error, meta, { site: "tools/call", toolName: call.tool });
  }

  /** One initialize handshake (a new session). */
  initialize(meta: RequestMeta): void {
    trackServer("mcp_initialize", sessionProperties(meta), clientIdentity(meta));
  }

  /** An unexpected fault: the core's captureException (rebuilt error, dedupe, daily cap). */
  captureException(err: unknown, meta: RequestMeta = {}, opts: { site?: string; toolName?: string; fatal?: boolean } = {}): void {
    captureException(err, {
      site: opts.site ?? "http/route",
      identity: clientIdentity(meta),
      props: { ...sessionProperties(meta), ...(opts.toolName ? { $mcp_tool_name: opts.toolName } : {}) },
      // One dedupe window per tool (the core's `dedupe` key parts, never sent).
      ...(opts.toolName ? { dedupe: [opts.toolName] } : {}),
      ...(opts.fatal ? { fatal: true } : {}),
    });
  }

  /** One HTTP request as an OTLP log record (reads go to logs, not events). */
  requestLog(rec: RequestLog): void {
    const level = rec.status >= 500 ? "error" : rec.status >= 400 ? "warn" : "info";
    // The core's exporter (log-export.ts via the core's exportLog; a no-op when tracking or
    // POSTHOG_LOGS is off): body through scrubText, these attributes through REQUEST_LOG_KEYS and
    // then scrubProperties (`route` as a route template). product, env and app_version ride the
    // OTLP resource.
    exportLog({
      level,
      body: `${rec.method} ${rec.route} ${rec.status}${rec.rpcMethod ? ` ${rec.rpcMethod}` : ""}${rec.tool ? ` ${rec.tool}` : ""}`,
      attributes: {
        route: rec.route,
        method: rec.method,
        status: rec.status,
        latency_ms: rec.latencyMs,
        client: rec.meta.session?.clientName ?? "unknown",
        client_version: rec.meta.session?.clientVersion,
        // `tools/call` -> `tools_call`: an enum token, which the property filter keeps.
        rpc_method: rec.rpcMethod?.replace(/\//gu, "_"),
        tool: rec.tool,
      },
    });
  }

  /** Send what is queued (events and logs). Bounded; never throws. */
  async flush(): Promise<void> {
    await flushAnalytics();
  }

  /** Flush and close: after this nothing more is recorded. Bounded; never throws. */
  async shutdown(): Promise<void> {
    await shutdownAnalytics();
  }
}

/** The only attributes a request log keeps (the core exporter's `allow` hook). Deliberately NO
 *  `err_message` / `err_type` (the core's default text keys, which the API sends): a request
 *  log is built field by field from the route and status, and the only error text this server
 *  has is a tool's error, which can echo the caller's input (invalid-argument messages quote the
 *  arguments; upstream errors quote request data). scrubText removes secrets and personal
 *  shapes, not free text, so that text is never logged. Unexpected faults go to `$exception`
 *  (captureException: class, scrubbed message, frames) instead. */
const REQUEST_LOG_KEYS: ReadonlySet<string> = new Set(["route", "method", "status", "latency_ms", "client", "client_version", "rpc_method", "tool"]);

/** Log keys that skip the shape filter (a dotted version is not an enum token), each through
 *  the same validator as its event twin `$mcp_client_version`: the API's logs carry it too. */
const REQUEST_LOG_PASSTHROUGH = { client_version: matching(VERSIONISH) };

export interface StartOptions {
  /** Operator warnings (stderr in the binary). Never carries a payload. */
  warn?: (message: string) => void;
  /** Test seam (the core's): a sink in place of the HTTP transport. Skips the key<->env
   *  guard, not the kill switches nor the CORK_MCP_ANALYTICS opt-in. */
  sink?: AnalyticsSink;
  /** Test seam (the core's): the fetch of the log exporter (and of the event transport when
   *  no `sink` is given). */
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  now?: () => number;
}

/** The binary's entry: the analytics object, or undefined plus the reason it is off. */
export function analyticsFromEnv(rawEnv: Record<string, string | undefined>, opts: StartOptions = {}): { analytics?: McpAnalytics; status: string } {
  // The MCP-only extra opt-in. The binary is
  // public, so a Cork key in a user's shell must not turn telemetry on by itself.
  if (rawEnv["CORK_MCP_ANALYTICS"]?.trim() !== "1") return { status: "off (CORK_MCP_ANALYTICS is not 1)" };
  // The release is the commit the binary was BUILT from (stamped at compile time, attested with
  // the image) unless the deploy sets POSTHOG_RELEASE. A source run has none: app_version is then "unknown".
  const release = rawEnv["POSTHOG_RELEASE"]?.trim() ? rawEnv["POSTHOG_RELEASE"] : BUILD_COMMIT;
  const env = parseTelemetryEnv({ ...rawEnv, POSTHOG_RELEASE: release });
  const started = initAnalytics(env, {
    passthrough: MCP_PASSTHROUGH,
    // textKeys: none (no error text in MCP logs, see REQUEST_LOG_KEYS).
    logs: { allow: (key) => REQUEST_LOG_KEYS.has(key), passthrough: REQUEST_LOG_PASSTHROUGH, textKeys: [] },
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    ...(opts.warn ? { warn: opts.warn } : {}),
    ...(opts.sink ? { sink: opts.sink } : {}),
    ...(opts.now ? { now: opts.now } : {}),
  });
  if (!started.enabled) return { status: `off (${started.reason ?? "disabled"})` };
  const logs = logExportConfig() !== undefined;
  return { analytics: new McpAnalytics(), status: `on (${env.CORK_ENV} → ${env.POSTHOG_HOST}, key …${env.POSTHOG_KEY.slice(-4)}, logs ${logs ? "on" : "off"})` };
}
