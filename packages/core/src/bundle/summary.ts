// Plain-English rendering of a decoded Bundler3 bundle: what these bytes will DO, in the order
// they do it, so a signer can check intent against the hex before signing rather than after.
//
// Deliberately literal. It reports what each leg says, never what it ought to say — an unknown leg
// is called out as unreadable rather than glossed over, because the value of this summary comes
// entirely from being trustworthy when it matters.
import type { DecodedLeg } from "./decode.ts";

const MAX_UINT = (1n << 256n) - 1n;

export interface SummaryOptions {
  /**
   * Address -> role label ("collateral", "cST", …). The caller usually knows these from the pool
   * read; without it addresses are shown bare, which is honest but harder to read.
   */
  tokenRoles?: Record<string, string> | undefined;
  /** The initiator, so legs paying it out can say "you" instead of repeating the address. */
  account?: `0x${string}` | undefined;
  /** The adapter, so legs moving tokens into it read as "the adapter". */
  adapter?: `0x${string}` | undefined;
}

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

function amount(v: unknown): string {
  if (typeof v !== "bigint") return String(v);
  // The full-balance sentinel is the whole point of a sweep leg; printing 1.16e77 hides that.
  return v === MAX_UINT ? "the entire remaining balance" : v.toString();
}

/** Render an address as the most specific thing we know about it. */
function who(addr: unknown, o: SummaryOptions): string {
  if (typeof addr !== "string") return String(addr);
  const a = addr.toLowerCase();
  if (o.account && a === o.account.toLowerCase()) return `you (${short(addr)})`;
  if (o.adapter && a === o.adapter.toLowerCase()) return `the adapter (${short(addr)})`;
  const role = o.tokenRoles?.[a];
  return role ? `${role} (${short(addr)})` : short(addr);
}

function describeLeg(leg: DecodedLeg, o: SummaryOptions): string {
  switch (leg.kind) {
    case "cork": {
      // "where do the proceeds go" is the first thing worth checking on a Cork leg, and a
      // redirected receiver is exactly the tampering a summary should make visible.
      const p = leg.params as Record<string, unknown> | undefined;
      const parts: string[] = [];
      if (p && typeof p.receiver === "string") parts.push(`proceeds to ${who(p.receiver, o)}`);
      if (p && typeof p.owner === "string") parts.push(`shares burned from ${who(p.owner, o)}`);
      return `run Cork '${leg.action}' on ${who(leg.to, o)}${parts.length ? ` — ${parts.join(", ")}` : ""}`;
    }
    case "leg": {
      const [a0, a1, a2] = leg.args as [unknown, unknown, unknown];
      switch (leg.fn) {
        case "erc20TransferFrom":
          return `fund: pull ${amount(a2)} of ${who(a0, o)} from you into ${who(a1, o)}`;
        case "permit2TransferFrom":
          return `fund via Permit2: pull ${amount(a2)} of ${who(a0, o)} from you into ${who(a1, o)}`;
        case "erc20Transfer":
          return `return ${amount(a2)} of ${who(a0, o)} to ${who(a1, o)}`;
        case "nativeTransfer":
          return `send ${amount(a1)} wei of native currency to ${who(a0, o)}`;
        case "approve":
          return `approve ${who(a0, o)} to spend ${amount(a1)} of ${who(leg.to, o)}`;
        case "transfer":
          return `transfer ${amount(a1)} of ${who(leg.to, o)} to ${who(a0, o)}`;
        case "transferFrom":
          return `transfer ${amount(a2)} of ${who(leg.to, o)} from ${who(a0, o)} to ${who(a1, o)}`;
        default:
          return `call ${leg.fn}() on ${who(leg.to, o)}`;
      }
    }
    case "forself": {
      // The whole point of a ForSelf call is that no destination exists in the calldata —
      // the summary states the structural fact a reader would otherwise go looking for.
      const p = leg.params as Record<string, unknown> | undefined;
      const pool = p && typeof p.poolId === "string" ? ` for pool ${short(p.poolId)}` : "";
      const deadline = p && typeof p.deadline === "bigint" ? `, deadline ${p.deadline}` : "";
      return `run '${leg.action}' on the ForSelf adapter ${who(leg.to, o)}${pool}${deadline} — inputs are pulled from the caller, every output goes back to the CALLER (no receiver parameter exists); verify the adapter address is your integrator's deployment`;
    }
    case "bundle":
      return `a nested bundle on ${who(leg.to, o)} (${leg.legs.length} leg${leg.legs.length === 1 ? "" : "s"}):`;
    case "unknown":
      return `UNREADABLE leg on ${who(leg.to, o)} — selector ${leg.selector}${leg.note ? `; ${leg.note}` : ""}. Do not sign until you have identified it`;
  }
}

/** Per-leg caveats that change what signing means, appended to the leg's own line. */
function caveats(leg: DecodedLeg): string {
  const notes: string[] = [];
  if (leg.skipRevert) notes.push("MAY FAIL SILENTLY (skipRevert)");
  if (leg.value > 0n) notes.push(`sends ${leg.value} wei`);
  return notes.length ? ` [${notes.join("; ")}]` : "";
}

/**
 * One numbered line per leg, nested bundles indented under their parent.
 *
 * Returns lines rather than a blob so callers can indent, wrap, or paginate — the CLI renders
 * them as prose, MCP passes them through as data.
 */
export function summarizeBundle(legs: DecodedLeg[], options: SummaryOptions = {}): string[] {
  const out: string[] = [];
  const walk = (list: DecodedLeg[], prefix: string) => {
    list.forEach((leg, i) => {
      out.push(`${prefix}${i + 1}. ${describeLeg(leg, options)}${caveats(leg)}`);
      if (leg.kind === "bundle") walk(leg.legs, `${prefix}   `);
    });
  };
  walk(legs, "");
  return out;
}
