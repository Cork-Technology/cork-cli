// Split from handlers.ts (2026-08-05): filters handlers — one typed dispatch, per-tool modules.
// Declarations are moved byte-identically; see handlers.ts for the runTool dispatch.
import { Address, MarketId, nearestValue, UnixSeconds } from "@cork/schemas";
import { ToolInputError } from "./shared.ts";


/** Parse the free-form filters record into typed poolId/account, rejecting malformed values (exit 2). */
export interface QueryFilters {
  poolId?: `0x${string}`;
  account?: `0x${string}`;
  kind?: "orders" | "fills" | "contracts";
  side?: "BUY" | "SELL";
  status?: string;
  orderDigest?: `0x${string}`;
  orderHash?: `0x${string}`;
  filler?: `0x${string}`;
  address?: `0x${string}`;
  factory?: `0x${string}`;
  settler?: `0x${string}`;
  fillable?: boolean;
  source?: "API" | "CHAIN";
  collateralAsset?: `0x${string}`;
  referenceAsset?: `0x${string}`;
  mode?: string;
  expiry?: bigint;
  rfqId?: string;
  state?: "open" | "expired";
  withAnswers?: boolean;
  view?: "full" | "current";
  excludeRequestPrefix?: string;
  underwriter?: `0x${string}`;
  recipe?: `0x${string}`;
  args?: `0x${string}`;
  rate?: bigint;
  rateOracle?: `0x${string}`;
  label?: string;
  base?: `0x${string}`;
  quote?: `0x${string}`;
  legacy?: boolean;
  oracleSalt?: `0x${string}`;
  swapFeePercentage?: bigint;
  unwindSwapFeePercentage?: bigint;
}

/** Every filter key parseQueryFilters understands — unknown keys are a teachable error, as advertised.
 *  Exported for the completeness gate: each key must also appear in the schema's filters describe. */
export const KNOWN_FILTER_KEYS = [
  "poolId",
  "account",
  "kind",
  "side",
  "status",
  "orderDigest",
  "orderHash",
  "filler",
  "address",
  "factory",
  "settler",
  "fillable",
  "source",
  "collateralAsset",
  "referenceAsset",
  "mode",
  "expiry",
  "rfqId",
  "state",
  "withAnswers",
  "view",
  "excludeRequestPrefix",
  "underwriter",
  "recipe",
  "args",
  "rate",
  "rateOracle",
  "label",
  "base",
  "quote",
  "legacy",
  "oracleSalt",
  "swapFeePercentage",
  "unwindSwapFeePercentage",
] as const;

/** The digits-only (bigint-valued) filter keys — `rate`, `expiry` and the two fee percentages
 *  below parse via BigInt. Exported for the CLI, whose amount sugar (`--rate 1e18`) must cover
 *  exactly these keys; importing the list keeps the sugar and the parser from drifting apart. */
export const DIGIT_FILTER_KEYS = ["rate", "expiry", "swapFeePercentage", "unwindSwapFeePercentage"] as const;

type FilterKey = (typeof KNOWN_FILTER_KEYS)[number];

/** The filter keys each resource CONSUMES — the applicability gate handleQuery enforces. A key
 *  outside its resource's row is refused with teaching (exit 2): a filter that is accepted but
 *  never applied lets a caller mistake an unfiltered answer for a filtered one — the orderHash
 *  client-side rule ("a known filter key is never silently unapplied"), generalized to every
 *  resource. Rows are the UNION across the resource's modes and kinds (fills.poolId is
 *  full-decentralized-only, rollover-orders unions orders/fills/contracts keys); narrowing
 *  within a mode stays the handler's own business. A drift gate pins this record to the schema
 *  enum and to KNOWN_FILTER_KEYS from both sides. */
export const RESOURCE_FILTER_KEYS: Readonly<Record<string, readonly FilterKey[]>> = {
  "cork-pools": ["poolId"],
  "cork-pool": ["poolId"],
  "pool-whitelist": ["poolId", "account"],
  "whitelisted-addresses": ["poolId"],
  "rollover-orders": ["kind", "account", "settler", "poolId", "status", "fillable", "source", "orderDigest", "filler", "address", "factory"],
  "trading-pairs": ["poolId"],
  "orderbook": ["poolId", "side", "status", "orderHash", "account"],
  "fills": ["orderHash", "poolId"],
  "account-state": ["poolId", "account"],
  "protocol-config": [],
  "registry-assets": ["address", "legacy"],
  "registry-oracle": ["collateralAsset", "referenceAsset", "mode", "rate", "oracleSalt", "legacy"],
  "registry-recipes": ["recipe", "mode", "legacy"],
  "registry-denominations": ["label", "address", "legacy"],
  "registry-feeds": ["base", "quote", "legacy"],
  "derive-cork-pool": ["collateralAsset", "referenceAsset", "expiry", "recipe", "mode", "args", "rate", "rateOracle", "oracleSalt", "swapFeePercentage", "unwindSwapFeePercentage"],
  "rfqs": ["rfqId", "state", "account", "referenceAsset", "withAnswers", "view", "excludeRequestPrefix", "underwriter"],
  "offers": ["poolId", "side", "account", "rfqId"],
};

/** The keys a resource's VARIANT consumes when the resource has several read shapes under one
 *  name (audit DB-006). `rfqs` with `rfqId` is a single-record read: the list-only keys (state,
 *  requester, underwriter, prefix, withAnswers — the record embeds its answers regardless) are
 *  accepted by the union above and then never applied. `rollover-orders` reads a different
 *  venue feed per `kind`, each with its own filter set. A key outside the variant's set is
 *  refused with the same teaching a wrong-resource key gets — an unfiltered answer must never
 *  pass for a filtered one. Keys that SELECT the variant (`rfqId`, `kind`) are always applicable. */
export function variantFilterKeys(resource: string, raw: Record<string, unknown> | undefined): { variant: string; keys: readonly string[] } | undefined {
  if (resource === "rfqs" && raw?.rfqId !== undefined) return { variant: "rfqs (single record, filters.rfqId)", keys: ["rfqId", "view"] };
  if (resource === "rollover-orders") {
    const kind = raw?.kind === undefined ? "orders" : String(raw.kind);
    if (kind === "orders") return { variant: "rollover-orders kind=orders", keys: ["kind", "account", "settler", "poolId", "status", "fillable", "source", "orderDigest"] };
    if (kind === "fills") return { variant: "rollover-orders kind=fills", keys: ["kind", "orderDigest", "filler", "settler"] };
    if (kind === "contracts") return { variant: "rollover-orders kind=contracts", keys: ["kind", "account", "address", "factory"] };
  }
  return undefined;
}

/** Refuse a KNOWN filter key the named resource does not consume. Runs after parseQueryFilters
 *  (globally unknown keys get its did-you-mean first), so every refusal here is a real key on
 *  the wrong resource — the teaching names the resource's own keys. A resource with variants
 *  (see variantFilterKeys) narrows the check to the variant the input selects. */
export function assertFiltersApplicable(resource: string, raw: Record<string, unknown> | undefined): void {
  const union = RESOURCE_FILTER_KEYS[resource];
  if (union === undefined) return; // an unmapped resource never over-refuses (schema drift is the gate's job)
  const variant = variantFilterKeys(resource, raw);
  const applicable = variant?.keys ?? union;
  const scope = variant?.variant ?? resource;
  for (const key of Object.keys(raw ?? {})) {
    if (!(applicable as readonly string[]).includes(key)) {
      const near = nearestValue(key, applicable);
      throw new ToolInputError("cork_query", [{
        path: ["filters", key],
        message: `filters.${key} does not apply to ${variant ? `this read shape — ${scope}` : `resource '${resource}'`} — it would be silently unapplied, and an unfiltered answer must never pass for a filtered one. ${applicable.length ? `${variant ? scope : `'${resource}'`} consumes: ${applicable.join(", ")}` : `'${resource}' takes no filters`}${near ? ` — did you mean '${near}'?` : ""}`,
      }]);
    }
  }
}

export function parseQueryFilters(raw: Record<string, unknown> | undefined): QueryFilters {
  const out: QueryFilters = {};
  const fail = (key: string, message: string): never => {
    throw new ToolInputError("cork_query", [{ path: ["filters", key], message }]);
  };
  for (const key of Object.keys(raw ?? {})) {
    if (!(KNOWN_FILTER_KEYS as readonly string[]).includes(key)) {
      const near = nearestValue(key, KNOWN_FILTER_KEYS);
      fail(key, `unknown filter key${near ? ` — did you mean '${near}'?` : ""} (known: ${KNOWN_FILTER_KEYS.join(", ")})`);
    }
  }
  if (raw?.poolId !== undefined) {
    const r = MarketId.safeParse(raw.poolId);
    if (!r.success) fail("poolId", "not a valid 32-byte pool id");
    else out.poolId = r.data;
  }
  for (const key of ["account", "filler", "address", "factory", "settler", "underwriter"] as const) {
    if (raw?.[key] !== undefined) {
      const r = Address.safeParse(raw[key]);
      if (!r.success) fail(key, "not a valid EVM address");
      else out[key] = r.data;
    }
  }
  for (const key of ["orderDigest", "orderHash"] as const) {
    if (raw?.[key] !== undefined) {
      const v = String(raw[key]);
      if (!/^0x[0-9a-fA-F]{64}$/.test(v)) fail(key, "not a 32-byte hex hash");
      else out[key] = v.toLowerCase() as `0x${string}`;
    }
  }
  if (raw?.kind !== undefined) {
    const v = String(raw.kind);
    if (v !== "orders" && v !== "fills" && v !== "contracts") fail("kind", "expected 'orders' | 'fills' | 'contracts'");
    else out.kind = v;
  }
  if (raw?.side !== undefined) {
    const v = String(raw.side);
    if (v !== "BUY" && v !== "SELL") fail("side", "expected 'BUY' | 'SELL'");
    else out.side = v;
  }
  if (raw?.source !== undefined) {
    const v = String(raw.source);
    if (v !== "API" && v !== "CHAIN") fail("source", "expected 'API' | 'CHAIN'");
    else out.source = v;
  }
  if (raw?.status !== undefined) out.status = String(raw.status);
  if (raw?.fillable !== undefined) {
    if (typeof raw.fillable === "boolean") out.fillable = raw.fillable;
    else if (raw.fillable === "true" || raw.fillable === "false") out.fillable = raw.fillable === "true";
    else fail("fillable", "expected a boolean");
  }
  // registry-oracle pair (ORDER MATTERS: collateral first) + registry-recipes single-mode lookup.
  for (const key of ["collateralAsset", "referenceAsset"] as const) {
    if (raw?.[key] !== undefined) {
      const r = Address.safeParse(raw[key]);
      if (!r.success) fail(key, "not a valid EVM address");
      else out[key] = r.data;
    }
  }
  if (raw?.mode !== undefined) out.mode = String(raw.mode);
  // derive-cork-pool: expiry as a unix-seconds decimal string (part of the derived market
  // identity) — routed through the shared UnixSeconds primitive so the ms-detector and
  // plausibility bound ride this field too (T6a), instead of a bare digit regex that accepted
  // year-58-billion values.
  if (raw?.expiry !== undefined) {
    const r = UnixSeconds.safeParse(String(raw.expiry));
    if (!r.success) fail("expiry", r.error.issues[0]?.message ?? "expected a unix timestamp in SECONDS (decimal string)");
    else out.expiry = BigInt(r.data);
  }
  // RFQ feed (venue ids are opaque but always rfq_-prefixed — same guard the venue itself applies).
  if (raw?.rfqId !== undefined) {
    const v = String(raw.rfqId);
    if (!/^rfq_[0-9a-z]+$/.test(v)) fail("rfqId", "expected a venue RFQ id (rfq_ prefix, lowercase alphanumeric)");
    else out.rfqId = v;
  }
  if (raw?.state !== undefined) {
    const v = String(raw.state);
    if (v !== "open" && v !== "expired") fail("state", "expected 'open' | 'expired'");
    else out.state = v;
  }
  if (raw?.view !== undefined) {
    const v = String(raw.view);
    if (v !== "full" && v !== "current") fail("view", "expected 'full' (every stored answer row, the default) | 'current' (the negotiation frontier: one current answer per underwriter + the current counter)");
    else out.view = v;
  }
  // rfqs list: a LITERAL request_id prefix to drop server-side (venue 0.4.1; it escapes LIKE
  // wildcards, so "50%_off" excludes exactly that prefix). The venue bounds it to 1..64 chars.
  if (raw?.excludeRequestPrefix !== undefined) {
    const v = String(raw.excludeRequestPrefix);
    if (v.length < 1 || v.length > 64) fail("excludeRequestPrefix", "expected a literal request_id prefix of 1 to 64 characters (e.g. 'healthcheck-')");
    else out.excludeRequestPrefix = v;
  }
  if (raw?.withAnswers !== undefined) {
    if (typeof raw.withAnswers === "boolean") out.withAnswers = raw.withAnswers;
    else if (raw.withAnswers === "true" || raw.withAnswers === "false") out.withAnswers = raw.withAnswers === "true";
    else fail("withAnswers", "expected a boolean");
  }
  // 2.1.0 registry filters: a recipe is an approved CONTRACT ADDRESS; `args` is the recipe's raw
  // additionalData hex; `rate` keys a fixed-rate oracle (18-decimal integer string); `rateOracle`
  // overrides oracle resolution on resolve/predict; label/base/quote are the denominations/feeds
  // point lookups; `legacy` selects the DEPRECATED pre-2.1.0 generation (gated).
  for (const key of ["recipe", "rateOracle", "base", "quote"] as const) {
    if (raw?.[key] !== undefined) {
      const r = Address.safeParse(raw[key]);
      if (!r.success) fail(key, "not a valid EVM address");
      else out[key] = r.data;
    }
  }
  if (raw?.args !== undefined) {
    const v = String(raw.args);
    if (!/^0x[0-9a-fA-F]*$/.test(v)) fail("args", "expected 0x-prefixed hex bytes (the recipe's additionalData, passed verbatim)");
    else out.args = v as `0x${string}`;
  }
  if (raw?.rate !== undefined) {
    // Refuse unsafe-integer JSON numbers BEFORE String() can launder the already-rounded value:
    // a wad rate is ~1e18 > 2^53, and a wrong rate keys a wrong CREATE2 fixed-oracle address —
    // a silently-wrong pool identity, not a visibly-wrong read. (Same guard as parseOrderRecord.)
    if (typeof raw.rate === "number" && !Number.isSafeInteger(raw.rate)) {
      fail("rate", "arrived as a JSON number outside JavaScript's safe-integer range — its low digits were ALREADY rounded away during JSON parsing; resend it as a decimal STRING (1e18 = 1.0)");
    } else {
      const v = String(raw.rate);
      if (!/^[0-9]+$/.test(v)) fail("rate", "expected an 18-decimal rate as a decimal integer string (1e18 = 1.0)");
      else out.rate = BigInt(v);
    }
  }
  if (raw?.label !== undefined) out.label = String(raw.label);
  // Nested-wire (0.5.x) identity inputs: the oracle salt of a pair's FIRST wrapper (bytes32,
  // default zero) and the two fee percentages that are PART OF a 10-field pool id (1e18 = 1%,
  // default 0) — same unsafe-number guard as `rate`, for the same reason (a wrong fee is a wrong
  // pool id, silently).
  if (raw?.oracleSalt !== undefined) {
    const v = String(raw.oracleSalt);
    if (!/^0x[0-9a-fA-F]{64}$/.test(v)) fail("oracleSalt", "expected a 32-byte hex salt (0x + 64 hex chars; the zero salt is the pair's default wrapper)");
    else out.oracleSalt = v as `0x${string}`;
  }
  for (const key of ["swapFeePercentage", "unwindSwapFeePercentage"] as const) {
    if (raw?.[key] !== undefined) {
      if (typeof raw[key] === "number" && !Number.isSafeInteger(raw[key])) {
        fail(key, "arrived as a JSON number outside JavaScript's safe-integer range — its low digits were ALREADY rounded away during JSON parsing; resend it as a decimal STRING (1e18 = 1%)");
      } else {
        const v = String(raw[key]);
        if (!/^[0-9]+$/.test(v)) fail(key, "expected a fee percentage as a decimal integer string (1e18 = 1%)");
        else out[key] = BigInt(v);
      }
    }
  }
  if (raw?.legacy !== undefined) {
    if (typeof raw.legacy === "boolean") out.legacy = raw.legacy;
    else if (raw.legacy === "true" || raw.legacy === "false") out.legacy = raw.legacy === "true";
    else fail("legacy", "expected a boolean");
  }
  return out;
}
