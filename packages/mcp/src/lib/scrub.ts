// cork-telemetry-core@40e0e86 scrub.ts
/**
 * Cork telemetry scrub core. CORE FILE: copy as is. Pure: no env, no I/O,
 * no dependency.
 * Conformance: vectors.json (run by vectors.test.ts in CI).
 *
 * What may leave the process:
 * - ALLOWED: wallet / contract / token addresses (0x + 40 hex), tx / order
 *   hashes and pool ids (0x + 64 hex), amounts, chain ids, enums, counts.
 * - FORBIDDEN: secrets (keys, RPC URLs with keys, tokens, DSNs, mnemonics),
 *   IPs, emails, signatures / permits / calldata (hex > 64 digits), bodies,
 *   free text in properties.
 *
 * Three entry points:
 * - scrubText(s)        free text that must survive (error messages, log
 *                        bodies): cuts what is forbidden INSIDE the text.
 * - scrubValue(v)       JSON-ish context (log attributes, exception context):
 *                        drops secret-named keys, scrubs strings, bounds size.
 * - scrubProperties(p)  event properties: flatten + VALUE-SHAPE filter, fail
 *                        closed (a new field passes only with a safe shape).
 *
 * Extension points (repo-specific, NOT in this file):
 * - registerSecret / registerEnvSecrets: call at boot with the secrets the
 *   process holds (signer keys, RPC keys). Shape cannot tell a private key
 *   from a tx hash; the registry can.
 * - a schema-typed extractor (`PropertyExtractor`, API zod walker, MCP
 *   JSON-schema walker) for request-shaped data. Its output still passes
 *   scrubProperties.
 */

export type Scalar = string | number | boolean;
export type Properties = Record<string, Scalar>;

/**
 * Repo-specific: turns a validated request body / tool args into flat
 * properties, using the schema to decide which strings are typed (address,
 * bytes32, numeric pattern, enum member). Build it on `flattenProperties`
 * with a schema-aware `LeafJudge`. Output is re-checked by scrubProperties.
 */
export type PropertyExtractor<Schema = unknown> = (input: unknown, schema?: Schema) => Properties;

/** Decides one leaf. `rawPath` = the original keys (for a schema lookup). Undefined = drop. */
export type LeafJudge = (value: unknown, snakeKey: string, rawPath: readonly string[]) => Scalar | undefined;

// ---------------------------------------------------------------------------
// Shape primitives
// ---------------------------------------------------------------------------

export const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
export const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;
/** Integer or decimal string; uint256 fits in 78 digits. */
export const NUMERIC_RE = /^-?\d{1,78}(?:\.\d{1,78})?$/;
export const MAX_NUMERIC_CHARS = 78;
/**
 * Enum-like token built by code: starts with a letter or digit, then
 * letters, digits, `_`, `-`; 28 chars max (`UncertainExecutionFailure`,
 * `smart-session`, `7579`). No space, dot, colon or slash: no sentence, host
 * or URL can pass.
 */
export const ENUM_TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,27}$/;

export const isAddress = (v: unknown): v is string => typeof v === "string" && ADDRESS_RE.test(v);
export const isBytes32 = (v: unknown): v is string => typeof v === "string" && BYTES32_RE.test(v);
export const isNumericString = (v: unknown): v is string =>
  typeof v === "string" && v.length <= MAX_NUMERIC_CHARS && NUMERIC_RE.test(v);

/** Vendor credential prefixes (anchored): never an enum value. */
export const CREDENTIAL_PREFIX_RE =
  /^(?:0x|sk-|sk_(?:live|test)_|rk_(?:live|test)_|pk_(?:live|test)_|ph[cxs]_|xox[abprs]-|xapp-|gh[pousr]_|github_pat_|glpat-|npm_|hf_|AIza|r8_|pplx-|ya29\.|AKIA|ASIA|eyJ)/i;
/** Mixes upper case, lower case and digits: the shape of a random token. */
const highEntropy = (s: string): boolean => /[A-Z]/.test(s) && /[a-z]/.test(s) && /\d/.test(s);
/** Hex-only run of 8+ (`deadbeef`, raw key bytes): not an id we know. */
const RAW_HEX_RE = /^[0-9a-fA-F]{8,}$/;

/** An enum-like token that is not credential-, hex- or token-shaped. */
export function isEnumToken(v: unknown): v is string {
  if (typeof v !== "string" || !ENUM_TOKEN_RE.test(v)) return false;
  if (CREDENTIAL_PREFIX_RE.test(v) || RAW_HEX_RE.test(v)) return false;
  return !(v.replace(/[^A-Za-z0-9]/g, "").length > 12 && highEntropy(v));
}

// ---------------------------------------------------------------------------
// Key names
// ---------------------------------------------------------------------------

/** camelCase / kebab / UPPER -> snake_case, for ONE key segment (dots too become `_`). */
export function snakeKey(k: string): string {
  return k
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

/**
 * A key segment whose VALUE is secret, whatever its shape (a private key has
 * the tx-hash shape). Narrow on purpose: protocol ids (`pool_key`,
 * `market_key`, `token_id`) pass. Input: one snake_case segment.
 */
const SECRET_SEGMENT_RE =
  /^(?:key|pk|sk|token|secret|secrets|password|passwd|passphrase|mnemonic|seed|cookie|cookies|authorization|auth|bearer|credential|credentials|private|privkey|apikey|dsn|jwt)$|priv(?:ate)?_?key|secret|password|passwd|passphrase|mnemonic|(?:^|_)seed(?:_phrase)?$|recovery_phrase|(?:^|_)(?:api|signing|signer|session|access|auth|refresh|id|bot|bearer|private|client|webhook)_?(?:key|token|secret)$|(?:^|_)[ps]k$|(?:^|_)[a-z]{0,5}[a-z]key$|_token$|_auth$|_apikey$|_jwt$|(?:^|_)credentials?$|(?:^|_)webhook(?:_url)?$/;

/** A key segment that holds content or proof with no analytic value (never sent). */
const CONTENT_SEGMENTS: ReadonlySet<string> = new Set([
  "signature",
  "signatures",
  "permit",
  "permit2",
  "calldata",
  "call_data",
  "extension",
  "envelope",
  "body",
  "payload",
  "headers",
  "header",
  "request",
  "response",
  "url",
  "uri",
  "email",
  "ip",
  "ip_address",
  "cookie",
  "authorization",
  "salt",
  "nonce",
  "sig",
  "sigs",
  // split-signature parts
  "v",
  "r",
  "s",
  "y_parity",
  "yparity",
]);

/** True when the value under this key is secret (input: any spelling of one segment). */
export function isSecretKey(rawKey: string): boolean {
  return SECRET_SEGMENT_RE.test(snakeKey(rawKey));
}

/** True when this key is never sent, whatever its value. Addresses are the one exception (see dropKey). */
export function isContentKey(rawKey: string): boolean {
  const k = snakeKey(rawKey);
  return CONTENT_SEGMENTS.has(k) || k.includes("signature") || k.includes("permit");
}

const UNSAFE_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Drop this key? Content keys always. Secret keys too, except: an address is
 * public whatever its key is called (`session_key`, `token`), and a `token`
 * OBJECT (`{ address, symbol, decimals }`) is walked, not dropped.
 */
function dropKey(rawKey: string, value: unknown): boolean {
  if (UNSAFE_KEYS.has(rawKey) || rawKey === "$ip") return true;
  if (isContentKey(rawKey)) return true;
  if (!isSecretKey(rawKey)) return false;
  if (isAddress(value)) return false;
  const isObject = value !== null && typeof value === "object" && !Array.isArray(value);
  return !(isObject && /^tokens?$/.test(snakeKey(rawKey)));
}

// ---------------------------------------------------------------------------
// Secret registry. Process-global on purpose.
// ---------------------------------------------------------------------------

export const REDACTED_SECRET = "[redacted-secret]";
const MIN_SECRET_LEN = 8;
const secretForms = new Set<string>();
let secretPattern: RegExp | undefined;

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function rebuildSecrets(): void {
  if (secretForms.size === 0) {
    secretPattern = undefined;
    return;
  }
  // Longest first so a decimal / hex form is never partly replaced.
  const alts = [...secretForms].sort((a, b) => b.length - a.length).map(escapeRe);
  secretPattern = new RegExp(`(?:0x)?(?:${alts.join("|")})`, "gi");
}

/**
 * Remember a secret this process holds. Matched later in any case, with or
 * without `0x`, and (hex secrets of 16+ digits) in decimal. Idempotent.
 */
export function registerSecret(value: string | undefined | null): void {
  if (typeof value !== "string") return;
  const v = value.trim();
  if (v.length < MIN_SECRET_LEN) return;
  const before = secretForms.size;
  const hex = /^(?:0x)?([0-9a-fA-F]+)$/.exec(v);
  if (hex?.[1] && hex[1].length >= 16) {
    const body = hex[1].toLowerCase();
    secretForms.add(body);
    try {
      secretForms.add(BigInt(`0x${body}`).toString(10));
    } catch {
      /* hex form only */
    }
  } else {
    secretForms.add(v.toLowerCase());
  }
  if (secretForms.size !== before) rebuildSecrets();
}

/** Env names whose values are secrets (tested on the lowercased name). */
export const SECRET_ENV_NAME_RE =
  /(^|_)(pk|private|privkey|private_key|secret|password|passwd|passphrase|mnemonic|seed|apikey|api_key|key|token|authorization|auth|cookie|credentials?|bearer|webhook|dsn)(_|$)/;

/** Register every env value that is secret by name, or shaped like a private key. Call at boot. */
export function registerEnvSecrets(env: Record<string, string | undefined>): void {
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    const v = value.trim();
    if (v === "" || /^(?:true|false|\d+)$/i.test(v)) continue;
    if (SECRET_ENV_NAME_RE.test(name.toLowerCase()) || BYTES32_RE.test(v)) registerSecret(v);
  }
}

export function containsSecret(s: string): boolean {
  if (!secretPattern) return false;
  secretPattern.lastIndex = 0;
  return secretPattern.test(s);
}

export function redactSecrets(s: string): string {
  if (!secretPattern) return s;
  secretPattern.lastIndex = 0;
  return s.replace(secretPattern, REDACTED_SECRET);
}

/** Test hook. */
export function resetSecretsForTests(): void {
  secretForms.clear();
  secretPattern = undefined;
}

// ---------------------------------------------------------------------------
// scrubText: free text
// ---------------------------------------------------------------------------

// viem meta sections. `Request body:` is a raw JSON-RPC body: keep the
// method only. `Contract Call:` / `Raw Call Arguments:` / `Request
// Arguments:` blocks (address, args, data, from): keep the `function:` line.
const REQUEST_BODY_RE = /Request body: [^\n]*/g;
const CALL_BLOCK_RE = /(Contract Call:|Raw Call Arguments:|Request Arguments:)[ \t]*\n((?:[ \t]+\S[^\n]*(?:\n|$))*)/g;
// Mnemonic / seed phrases: several words, up to the end of the line or the
// next `name=` assignment.
const PHRASE_RE =
  /(?<![A-Za-z0-9])(mnemonic|seed(?:[ _-]?phrase)?|(?:secret[ _-]?)?recovery[ _-]?phrase)(\s*[=:]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\n]*?(?=\s+[A-Za-z_][A-Za-z0-9_-]*=|\n|$))/gi;
// "name": "value" (JSON in text). Redacted when the name is secret or content.
const JSON_PAIR_RE = /"([A-Za-z0-9_$-]{1,64})"(\s*:\s*)"((?:[^"\\\n]|\\.)*)"/g;
// name=value (query strings, env dumps, CLI flags).
// A value that is itself `name=...` (`q=password=x`) is skipped, so the inner pair is matched.
const ASSIGN_RE = /(?<![A-Za-z0-9_-])([A-Za-z][A-Za-z0-9_-]{0,63})=((?![A-Za-z][A-Za-z0-9_-]*=)[^\s&'",;]+)/g;
// name: value (headers, YAML-ish dumps). Redacted only for secret names.
const COLON_RE = /(?<![A-Za-z0-9_-])([A-Za-z][A-Za-z0-9_-]{0,63})(\s*:[ \t]*)(?!\/\/)([^\s,;'"]+)/g;
// A 32-byte value right after a secret word: `session key 0x..`, `pk 0x..`.
const WORD_HEX64_RE = /(?<![A-Za-z0-9_-])([A-Za-z][A-Za-z0-9_-]{0,63})(\s+)((?:0x)?[0-9a-fA-F]{64})(?![0-9a-fA-F])/g;
const BEARER_RE = /\bBearer\s+[^\s'",;]+/gi;
const BASIC_RE = /\bBasic\s+[A-Za-z0-9+/=]{8,}/g;
// scheme://[userinfo@]host[:port][rest]. Userinfo is greedy to the LAST '@'
// before the path, so a DSN password with '@' never leaks into the host.
const URL_RE = /\b([a-zA-Z][a-zA-Z0-9+.-]*):\/\/(?:[^\s/'"<>]*@)?([^\s/?#@'"<>]+)([^\s'"<>]*)/g;
const HOST = String.raw`(?:[a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}`;
// Scheme-less DSN userinfo: user:pass@host -> [redacted]@host.
const SCHEMELESS_DSN_RE = /(?<![A-Za-z0-9._%+/-])[A-Za-z0-9._%+-]+:[^\s@/'"]+@(?=[A-Za-z0-9-]+(?:\.|:|\b))/g;
// Scheme-less host[:port][/path]?query -> host/path?[redacted].
const SCHEMELESS_QUERY_RE = new RegExp(String.raw`(?<![A-Za-z0-9/.-])(${HOST}(?::\d+)?(?:\/[^\s?'"<>]*)?)\?[^\s'"<>]+`, "g");
// Scheme-less host + path with a key-like segment: /v<n>/<8+>, a UUID, or a 16+ char segment.
const SCHEMELESS_PATH_RE = new RegExp(String.raw`(?<![A-Za-z0-9/.-])(${HOST}(?::\d+)?)(\/[^\s'"<>]+)`, "g");
const KEYISH_SEGMENT_RE = /^(?:[A-Za-z0-9_-]{16,}|[0-9a-fA-F-]{36})$/;
/** A 10+ char segment with letters AND digits (`abc123def456`): a likely key. */
const keyishSegment = (seg: string): boolean =>
  KEYISH_SEGMENT_RE.test(seg) || (/^[A-Za-z0-9_-]{10,}$/.test(seg) && /[A-Za-z]/.test(seg) && /\d/.test(seg));
const JWT_RE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]*)?/g;
const CREDENTIAL_TEXT_RE =
  /(?<![A-Za-z0-9_-])(?:sk-[A-Za-z0-9_-]{8,}|(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{8,}|ph[cxs]_[A-Za-z0-9]{10,}|xox[abprs]-[A-Za-z0-9-]{8,}|xapp-[A-Za-z0-9-]{8,}|gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}|glpat-[A-Za-z0-9_-]{16,}|npm_[A-Za-z0-9]{16,}|hf_[A-Za-z0-9]{16,}|AIza[A-Za-z0-9_-]{30,}|r8_[A-Za-z0-9]{16,}|pplx-[A-Za-z0-9]{16,}|ya29\.[A-Za-z0-9_-]{16,}|(?:AKIA|ASIA)[A-Z0-9]{16})/g;
// 32+ token-like chars mixing upper, lower and digits (base64, API keys). Not 0x.
/**
 * A 32+ run is a token when it mixes upper, lower and digits, or when it is
 * one unbroken single-case alphanumeric run (no `_` / `-`) with 4+ letters
 * and 4+ digits (lowercase base32 / hex-ish API keys). Snake / kebab
 * identifiers with words pass.
 */
const tokenLike = (m: string): boolean =>
  highEntropy(m) ||
  // pure hex is left to the bare-hex rule ([hex])
  (!/^[0-9a-fA-F]+$/.test(m) &&
  (/^[a-z0-9]+$|^[A-Z0-9]+$/.test(m) && (m.match(/\d/g)?.length ?? 0) >= 4 && (m.match(/[A-Za-z]/g)?.length ?? 0) >= 4));
const TOKEN_RUN_RE = /(?<![A-Za-z0-9+/_-])(?!0x)[A-Za-z0-9+/_-]{32,}={0,2}/g;
const LONG_HEX_RE = /(?:0x|\\x)[0-9a-fA-F]{65,}/g;
const BARE_HEX_RE = /(?<![0-9A-Za-z])[0-9a-fA-F]{32,}(?![0-9A-Za-z])/g;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const IPV4_RE = /(?<![\d.])(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?![\d.])/g;
// IPv6: 4+ groups, or a `::` form (times like 10:00:05 have 3 groups).
const IPV6_RE =
  /(?<![\w:])(?:(?:[0-9a-f]{1,4}:){3,7}[0-9a-f]{1,4}|(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4})*)?::(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4})*)?)(?![\w:])/gi;
const HOME_DIR_RE = /(\/home\/|\/Users\/|[A-Za-z]:\\Users\\)[^/\\\s]+/g;

/** A name whose value is never kept in text (secret or proof). */
const redactName = (name: string): boolean => isSecretKey(name) || isContentKey(name);

/**
 * Decode up to 3 levels of %XX that give printable ASCII, so `api%5Fkey%3D..`
 * and encoded URLs meet the rules below. Other bytes stay encoded.
 */
function percentDecode(input: string): string {
  let s = input;
  for (let i = 0; i < 3 && /%[2-7][0-9a-fA-F]/.test(s); i += 1) {
    const next = s.replace(/%([2-7][0-9a-fA-F])/g, (m, h: string) => {
      const c = parseInt(h, 16);
      return c >= 0x20 && c <= 0x7e ? String.fromCharCode(c) : m;
    });
    if (next === s) break;
    s = next;
  }
  return s;
}

/** Scrub free text. Addresses and 32-byte hashes survive as written. */
export function scrubText(input: string): string {
  let s = input;
  s = percentDecode(s);
  s = redactSecrets(s);
  s = s
    .replace(REQUEST_BODY_RE, (m) => {
      const method = /"method"\s*:\s*"([A-Za-z0-9_]{1,64})"/.exec(m)?.[1] ?? "unknown";
      return `Request body: method=${method}`;
    })
    .replace(CALL_BLOCK_RE, (_m, header: string, block: string) => {
      const fn = block.split("\n").find((l) => /^\s*function:/.test(l));
      return fn ? `${header}\n${fn}\n` : `${header} [redacted]\n`;
    })
    .replace(PHRASE_RE, "$1$2[redacted]")
    .replace(JSON_PAIR_RE, (m, name: string, sep: string, value: string) =>
      redactName(name) && !isAddress(value) ? `"${name}"${sep}"[redacted]"` : m,
    )
    .replace(ASSIGN_RE, (m, name: string, value: string) =>
      redactName(name) && !isAddress(value) ? `${name}=[redacted]` : m,
    )
    .replace(COLON_RE, (m, name: string, sep: string, value: string) =>
      isSecretKey(name) && !isAddress(value) && value !== "[redacted]" && !/^Bearer$|^Basic$/i.test(value)
        ? `${name}${sep}[redacted]`
        : m,
    )
    .replace(WORD_HEX64_RE, (m, name: string, sep: string) => (isSecretKey(name) ? `${name}${sep}[redacted]` : m))
    .replace(BEARER_RE, "Bearer [redacted]")
    .replace(BASIC_RE, "Basic [redacted]")
    .replace(URL_RE, (_m, scheme: string, host: string, rest: string) =>
      `${scheme}://${host}${rest !== "" && rest !== "/" ? "/[redacted]" : ""}`,
    )
    .replace(SCHEMELESS_DSN_RE, "[redacted]@")
    .replace(SCHEMELESS_QUERY_RE, "$1?[redacted]")
    .replace(SCHEMELESS_PATH_RE, (m, host: string, path: string) => {
      if (path.startsWith("/[redacted]")) return m;
      const segs = path.split(/[/?#]/).filter(Boolean);
      const keyish = /\/v\d+\/[A-Za-z0-9_-]{8,}/.test(path) || segs.some(keyishSegment);
      return keyish ? `${host}/[redacted]` : m;
    })
    .replace(JWT_RE, "[redacted-credential]")
    .replace(CREDENTIAL_TEXT_RE, "[redacted-credential]")
    .replace(TOKEN_RUN_RE, (m) => (tokenLike(m) && !/0x[0-9a-fA-F]{40}/.test(m) ? "[redacted-token]" : m))
    .replace(LONG_HEX_RE, (m) => `[hex:${m.length - 2}]`)
    .replace(BARE_HEX_RE, "[hex]")
    .replace(EMAIL_RE, "[redacted-email]")
    .replace(IPV4_RE, "[redacted-ip]")
    .replace(IPV6_RE, "[redacted-ip]")
    .replace(HOME_DIR_RE, "$1[user]");
  return s;
}

// ---------------------------------------------------------------------------
// scrubValue: JSON-ish context (log attributes, exception context)
// ---------------------------------------------------------------------------

const MAX_VALUE_DEPTH = 6;
const MAX_VALUE_ARRAY = 20;
export const MAX_TEXT_CHARS = 1_000;

/**
 * Deep-scrub a JSON-ish value. Drops secret- and content-named keys (an
 * address survives a secret name), lowercases exact addresses / hashes,
 * scrubs every other string (scrubText, capped), bounds depth and arrays.
 */
export function scrubValue(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    if (!containsSecret(value) && (isAddress(value) || isBytes32(value))) return value.toLowerCase();
    const out = scrubText(value);
    return out.length > MAX_TEXT_CHARS ? `${out.slice(0, MAX_TEXT_CHARS)}…` : out;
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "boolean") return value;
  if (typeof value === "bigint") return scrubValue(value.toString(), depth);
  if (depth >= MAX_VALUE_DEPTH) return "[depth]";
  if (Array.isArray(value)) return value.slice(0, MAX_VALUE_ARRAY).map((v) => scrubValue(v, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (dropKey(k, v)) continue;
      const s = scrubValue(v, depth + 1);
      if (s !== undefined) out[k] = s;
    }
    return out;
  }
  return undefined; // functions, symbols
}

// ---------------------------------------------------------------------------
// scrubProperties: event properties (value-shape filter, fail closed)
// ---------------------------------------------------------------------------

export const MAX_PROPERTIES = 40;
export const MAX_DEPTH = 3;
const MAX_COLLECTED = 1_000;

/** PostHog controls a caller may pass; every other `$` key is dropped. */
const ALLOWED_DOLLAR: ReadonlySet<string> = new Set(["$process_person_profile", "$geoip_disable"]);

/**
 * The default leaf rule, for properties built by code (no schema):
 * boolean, finite number, bigint -> decimal, address / bytes32 (lowercased),
 * numeric string <= 78 chars, enum-like token. Everything else is dropped:
 * free text, URLs, IPs, hex > 64 digits, credential-shaped strings.
 * Request-shaped data must go through a schema-typed extractor first.
 */
export const defaultLeaf: LeafJudge = (v) => {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "bigint") {
    const d = v.toString();
    return d.length <= MAX_NUMERIC_CHARS && !containsSecret(d) ? d : undefined;
  }
  if (typeof v !== "string" || containsSecret(v)) return undefined;
  if (isAddress(v) || isBytes32(v)) return v.toLowerCase();
  if (isNumericString(v)) return v;
  if (isEnumToken(v)) return v;
  return undefined;
};

/**
 * Flatten to dotted snake_case keys, arrays -> `<key>_count` (no element
 * values), drop secret / content keys and `__proto__`, judge each leaf.
 * DEPTH counts object levels from the INPUT root (max 3). A key that already
 * holds dots (`action.order.maker`, an extractor's output, a prefix like
 * `arg.`) is checked segment by segment but adds no depth, so re-scrubbing
 * flat output is stable.
 * Collects up to 1,000 entries (no cap here).
 */
export function flattenProperties(input: unknown, leaf: LeafJudge = defaultLeaf): Properties {
  const out: Properties = {};
  let n = 0;
  const put = (k: string, v: Scalar): void => {
    if (k in out || n >= MAX_COLLECTED) return;
    out[k] = v;
    n += 1;
  };
  const walk = (obj: Record<string, unknown>, prefix: readonly string[], raw: readonly string[], depth: number): void => {
    for (const [rawKey, v] of Object.entries(obj)) {
      if (n >= MAX_COLLECTED) return;
      if (v === undefined || v === null) continue;
      if (rawKey.startsWith("$")) {
        if (prefix.length === 0 && ALLOWED_DOLLAR.has(rawKey) && typeof v === "boolean") put(rawKey, v);
        continue;
      }
      const parts = rawKey.split(".").filter((p) => p !== "");
      if (parts.length === 0) continue;
      const last = parts[parts.length - 1] as string;
      // Inner segments act as objects; the last one holds `v`.
      if (parts.slice(0, -1).some((p) => dropKey(p, {})) || dropKey(last, v)) continue;
      const segs = [...prefix, ...parts.map(snakeKey)];
      if (segs.some((x) => x === "")) continue;
      const key = segs.join(".");
      const path = [...raw, ...parts];
      if (Array.isArray(v)) {
        put(`${key}_count`, v.length);
      } else if (typeof v === "object") {
        if (depth < MAX_DEPTH) walk(v as Record<string, unknown>, segs, path, depth + 1);
      } else {
        const kept = leaf(v, key, path);
        if (kept !== undefined) put(key, kept);
      }
    }
  };
  if (input !== null && typeof input === "object" && !Array.isArray(input)) {
    walk(input as Record<string, unknown>, [], [], 1);
  }
  return out;
}

export const POOL_ALIAS_NAMES = ["pool_id", "src_pool_id", "dst_pool_id"] as const;

/**
 * Top-level `pool_id` / `src_pool_id` / `dst_pool_id`, so one breakdown works
 * across routes (`source.pool_id`, `order.rollover_params.src_pool_id`). Set
 * only when every kept property with that last segment holds one value.
 */
export function poolAliases(props: Record<string, unknown>): Properties {
  const out: Properties = {};
  for (const name of POOL_ALIAS_NAMES) {
    const values = new Set<Scalar>();
    for (const [k, v] of Object.entries(props)) {
      if (k.slice(k.lastIndexOf(".") + 1) === name && (typeof v === "string" || typeof v === "number")) values.add(v);
    }
    if (values.size === 1) out[name] = [...values][0] as Scalar;
  }
  return out;
}

/** Keep the first `max` non-`$` properties (insertion order); `$` controls always stay. */
export function capProperties(props: Properties, max = MAX_PROPERTIES): Properties {
  const out: Properties = {};
  let n = 0;
  for (const [k, v] of Object.entries(props)) {
    if (k.startsWith("$")) out[k] = v;
    else if (n < max) {
      out[k] = v;
      n += 1;
    }
  }
  return out;
}

/**
 * The last gate for every event and exception property set: flatten, shape
 * filter, pool aliases first, then at most 40 properties.
 */
export function scrubProperties(props: Record<string, unknown>, leaf: LeafJudge = defaultLeaf): Properties {
  const flat = flattenProperties(props, leaf);
  const aliases = poolAliases(flat);
  return capProperties({ ...aliases, ...Object.fromEntries(Object.entries(flat).filter(([k]) => !(k in aliases))) });
}
