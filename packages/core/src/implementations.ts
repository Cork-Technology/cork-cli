// The approved-implementations guard: the interface-first model's runtime half.
//
// The model (mirrored in the distribution-repo proposal): an INTERFACE — ABIs plus the layouts
// inside `bytes` parameters — is what this tool supports; an IMPLEMENTATION is one deployed
// codebase behind that interface, admitted to the config's `approvedImplementations` allowlist
// only after the behavioral suite passes against it. This module answers the runtime question:
// "is the code I am about to trust on the approved list?" — by fingerprinting the LIVE runtime
// code (keccak256 of eth_getCode, equal to EXTCODEHASH for deployed code) and comparing against
// the allowlist. It closes the one drift class the address/binding guards cannot see: a proxy
// whose implementation was swapped under its stable address. For a `proxy: "eip1967"` role the
// guard therefore resolves the implementation address from the EIP-1967 slot FIRST and hashes
// that code — the proxy shell's own code never changes on an upgrade.
//
// Trust split (audit MCP-NET-001, 2026-08-24): the ADDRESSES come from the resolved config
// (remote-first, like every other address read), but the ALLOWLIST comes only from the copy
// bundled into this build. A remote document may legitimately move an address; it must never be
// the same document that admits the code behind that address, or a tampered config would
// authorize itself. Until a release ships the new hash, a moved address warns — that is the
// tripwire working, not a bug.
//
// Posture matches the other pre-flights: best-effort disclosure. Bytes are built regardless; an
// unreadable view degrades to silence (a read failure must never turn byte-building into a hard
// error); only a POSITIVE finding — code that hashes off-list, an empty account, an empty proxy
// slot — warns. Each prepare path scopes the guard to the roles its artifact actually calls
// (below), so an unrelated role's drift cannot noise up an unrelated artifact.
import { keccak256 } from "viem";
import { BUNDLED_DEFAULTS, resolveConfig, type CorkDefaults } from "./config-remote.ts";

/** ERC-1967 implementation slot: bytes32(uint256(keccak256("eip1967.proxy.implementation")) - 1). */
export const EIP1967_IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as const;

/** The roles the allowlist can name, and the config block each resolves from. */
export const IMPLEMENTATION_ROLES = ["corkAdapter", "whitelistManager", "marketRegistry", "jitAdapter", "marketCreator", "legacyMarketRegistry", "legacyJitAdapter"] as const;
export type ImplementationRole = (typeof IMPLEMENTATION_ROLES)[number];

/** Per-artifact role scopes: exactly the contracts whose code the produced bytes will execute.
 *  A Bundler3 bundle runs the CorkAdapter (and a gated pool consults the WhitelistManager);
 *  an oracle-deploy tx runs the MarketRegistry; a 2.1.0 JIT hook runs the JIT adapter, which
 *  calls the registry; a create-pool tx runs the CorkMarketCreator, which calls the registry;
 *  the deprecated hook runs the previous generation of both. */
export const PHOENIX_IMPLEMENTATION_ROLES = ["corkAdapter", "whitelistManager"] as const satisfies readonly ImplementationRole[];
export const PREPARE_MARKET_IMPLEMENTATION_ROLES = ["marketRegistry"] as const satisfies readonly ImplementationRole[];
export const JIT_IMPLEMENTATION_ROLES = ["jitAdapter", "marketRegistry"] as const satisfies readonly ImplementationRole[];
export const CREATE_POOL_IMPLEMENTATION_ROLES = ["marketCreator", "marketRegistry"] as const satisfies readonly ImplementationRole[];
export const LEGACY_JIT_IMPLEMENTATION_ROLES = ["legacyJitAdapter", "legacyMarketRegistry"] as const satisfies readonly ImplementationRole[];

/** The minimal client surface the guard needs. Structural on purpose: handler stubs that do not
 *  implement these views skip the guard silently, exactly like the other best-effort legs. */
export interface CodeReader {
  getCode?: (args: { address: `0x${string}`; blockNumber?: bigint }) => Promise<`0x${string}` | undefined>;
  getStorageAt?: (args: { address: `0x${string}`; slot: `0x${string}`; blockNumber?: bigint }) => Promise<`0x${string}` | undefined>;
}

export interface ImplementationCheck {
  role: string;
  address: `0x${string}`;
  /** Present for proxy roles: the implementation the EIP-1967 slot named. */
  implementation?: `0x${string}`;
  /** keccak256 of the live runtime code, when readable. */
  codehash?: `0x${string}`;
  verdict: "approved" | "not_approved" | "no_code" | "proxy_unresolved" | "unreadable";
}

/** Resolve a config role to the address the guard fingerprints — against the SAME blocks that
 *  already own the addresses (deployments / marketRegistry / marketRegistryLegacy), so the
 *  allowlist never duplicates an address that could then skew. Unknown roles resolve to
 *  undefined and are skipped: an UPDATED config may name roles an older binary does not know,
 *  and that must not warn. */
export function implementationRoleAddress(role: string, defaults: CorkDefaults, chainId: number): `0x${string}` | undefined {
  const dep = defaults.deployments[String(chainId)];
  const mr = defaults.marketRegistry?.[String(chainId)];
  const legacy = defaults.marketRegistryLegacy?.[String(chainId)];
  switch (role) {
    case "corkAdapter":
      return dep?.corkAdapter as `0x${string}` | undefined;
    case "whitelistManager":
      return dep?.whitelistManager as `0x${string}` | undefined;
    case "marketRegistry":
      return mr?.registry as `0x${string}` | undefined;
    case "jitAdapter":
      return mr?.adapter as `0x${string}` | undefined;
    case "marketCreator":
      return mr?.marketCreator as `0x${string}` | undefined;
    case "legacyMarketRegistry":
      return legacy?.registry as `0x${string}` | undefined;
    case "legacyJitAdapter":
      return legacy?.adapter as `0x${string}` | undefined;
    default:
      return undefined;
  }
}

const NOT_DEPLOYED = new Set(["0x", "", undefined] as Array<string | undefined>);

async function checkOne(
  client: CodeReader,
  role: string,
  entry: { proxy?: "eip1967" | undefined; approved: string[] },
  address: `0x${string}`,
  blockArg: { blockNumber?: bigint },
): Promise<ImplementationCheck> {
  try {
    let subject = address;
    let implementation: `0x${string}` | undefined;
    if (entry.proxy === "eip1967") {
      if (typeof client.getStorageAt !== "function") return { role, address, verdict: "unreadable" };
      const word = await client.getStorageAt({ address, slot: EIP1967_IMPLEMENTATION_SLOT, ...blockArg });
      const impl = word ? (`0x${word.slice(-40)}` as `0x${string}`) : undefined;
      if (impl === undefined || /^0x0{40}$/u.test(impl)) {
        // A configured proxy whose implementation slot is empty is a positive finding, not a
        // degradation: either the role is no longer the proxy the config believes, or the
        // proxy was gutted. Neither is a state to sign against silently.
        return { role, address, verdict: "proxy_unresolved" };
      }
      implementation = impl;
      subject = impl;
    }
    const code = await client.getCode!({ address: subject, ...blockArg });
    if (NOT_DEPLOYED.has(code)) return { role, address, ...(implementation ? { implementation } : {}), verdict: "no_code" };
    const codehash = keccak256(code as `0x${string}`);
    const approved = entry.approved.some((h) => h.toLowerCase() === codehash.toLowerCase());
    return { role, address, ...(implementation ? { implementation } : {}), codehash, verdict: approved ? "approved" : "not_approved" };
  } catch {
    return { role, address, verdict: "unreadable" };
  }
}

/** The two documents and two scopes a fingerprint run is parameterized by. NAMED on purpose:
 *  the allowlist source and the address source are both CorkDefaults, and swapping them
 *  positionally would quietly hand the allowlist to the document an attacker can move — the
 *  exact confusion the trust split exists to prevent. */
export interface ApprovedImplementationsOptions {
  /** The document the approved-implementations ALLOWLIST is read from. Production passes the
   *  copy bundled into the build (`BUNDLED_DEFAULTS`): a document that can move an address must
   *  never also be the one that admits the code behind it (see the header). */
  allowlist: CorkDefaults;
  /** Where role ADDRESSES resolve from — the resolved (remote-first) config in production.
   *  Default: the allowlist document (the single-document case). */
  addresses?: CorkDefaults;
  /** Scope to the roles the caller's artifact executes; omitted = every allowlisted role. */
  roles?: readonly string[];
  atBlock?: bigint;
}

/** Fingerprint the configured roles for the chain — every allowlisted role, or only
 *  `opts.roles` when a caller scopes the check to the contracts its artifact executes. Reads
 *  are issued together (one extra round trip, like the pool pre-flight); a client without
 *  `getCode` skips the whole guard. */
export async function checkApprovedImplementations(
  client: CodeReader,
  chainId: number,
  opts: ApprovedImplementationsOptions,
): Promise<ImplementationCheck[]> {
  const { allowlist, addresses = allowlist, roles, atBlock } = opts;
  const chain = allowlist.approvedImplementations?.[String(chainId)];
  if (!chain || typeof client.getCode !== "function") return [];
  const blockArg = atBlock !== undefined ? { blockNumber: atBlock } : {};
  const jobs = Object.entries(chain).flatMap(([role, entry]) => {
    if (roles !== undefined && !roles.includes(role)) return [];
    const address = implementationRoleAddress(role, addresses, chainId);
    return address ? [checkOne(client, role, entry, address, blockArg)] : [];
  });
  return Promise.all(jobs);
}

/** The one-call form the prepare handlers use beside their pool pre-flight: addresses from the
 *  resolved config (remote-first, the same path every address read takes), the allowlist from
 *  the copy bundled into this build, scoped to `roles`. Returns only the warnings. Swallows its
 *  own failures whole — this guard reports drift; it must never be the reason a bundle fails
 *  to build. */
export async function approvedImplementationGuard(
  client: CodeReader,
  chainId: number,
  opts: Pick<ApprovedImplementationsOptions, "roles" | "atBlock"> = {},
): Promise<Array<{ code: string; message: string }>> {
  return (await approvedImplementationChecks(client, chainId, opts)).warnings;
}

/** The guard's findings AND its warnings, for callers that REFUSE on some roles: the JIT hook
 *  paths gate on the adapter (below), every other path stays build-and-warn. Same trust split,
 *  same swallow-own-failures posture as approvedImplementationGuard. */
export async function approvedImplementationChecks(
  client: CodeReader,
  chainId: number,
  opts: Pick<ApprovedImplementationsOptions, "roles" | "atBlock"> = {},
): Promise<{ checks: ImplementationCheck[]; warnings: Array<{ code: string; message: string }> }> {
  try {
    const cfg = await resolveConfig();
    const checks = await checkApprovedImplementations(client, chainId, { allowlist: BUNDLED_DEFAULTS, addresses: cfg.defaults, ...opts });
    return { checks, warnings: implementationWarnings(checks) };
  } catch {
    return { checks: [], warnings: [] };
  }
}

/** The positive findings among `roles` — the ones a bytes-decoding path refuses on. A role that
 *  reads `approved` or `unreadable` never refuses: the guard gates on what it SAW, not on what it
 *  could not read (a dead RPC must not turn byte-building into a hard error). */
export function implementationRefusals(checks: readonly ImplementationCheck[], roles: readonly string[]): ImplementationCheck[] {
  return checks.filter((c) => roles.includes(c.role) && (c.verdict === "not_approved" || c.verdict === "no_code" || c.verdict === "proxy_unresolved"));
}

/** `CORK_ALLOW_UNAPPROVED_CODE=1` (CLI `--allow-unapproved-code`) downgrades the bytes-decoder
 *  refusal to build-and-warn — for the window between a redeploy and the release that ships its
 *  hash, when the operator has verified the new code by other means. Same shape as the
 *  deprecation gate. */
export function unapprovedCodeAllowed(env: Record<string, string | undefined> = process.env): boolean {
  const v = env["CORK_ALLOW_UNAPPROVED_CODE"];
  return v === "1" || v === "true";
}

/** Render positive findings as build-and-warn messages; `approved` and `unreadable` are silent
 *  (the guard discloses drift, it does not gate on its own availability). */
export function implementationWarnings(checks: ImplementationCheck[]): Array<{ code: string; message: string }> {
  const out: Array<{ code: string; message: string }> = [];
  for (const c of checks) {
    if (c.verdict === "not_approved") {
      const via = c.implementation ? ` (implementation ${c.implementation}, resolved from its EIP-1967 proxy slot)` : "";
      out.push({
        code: "implementation_not_approved",
        message: `the live code behind ${c.role} ${c.address}${via} hashes to ${c.codehash}, which is NOT on the approved-implementations list bundled into this build — the logic changed after the last behavioral-suite admission, or the address moved ahead of a release. Update to a release that admits it (a legitimate upgrade lands there after the suite passes) or treat the target as unverified before signing`,
      });
    } else if (c.verdict === "no_code") {
      out.push({
        code: "implementation_not_approved",
        message: `${c.role} ${c.implementation ?? c.address} has NO code on chain ${c.implementation ? "(the address its EIP-1967 proxy slot names)" : ""} — the configured address does not host a contract here; the config and the chain disagree`,
      });
    } else if (c.verdict === "proxy_unresolved") {
      out.push({
        code: "implementation_not_approved",
        message: `${c.role} ${c.address} is configured as an EIP-1967 proxy but its implementation slot is empty — either it is not (or no longer) that proxy shape, or it points nowhere; the guard cannot vouch for the code behind it`,
      });
    }
  }
  return out;
}
