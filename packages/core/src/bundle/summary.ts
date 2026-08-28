// Plain-English rendering of a decoded Bundler3 bundle: what these bytes will DO, in the order
// they do it, so a signer can check intent against the hex before signing rather than after.
//
// Deliberately literal. It reports what each leg says, never what it ought to say — an unknown leg
// is called out as unreadable rather than glossed over, because the value of this summary comes
// entirely from being trustworthy when it matters.
import { type DecodedLeg, hasCallback } from "./decode.ts";
import { U256_MAX } from "../math/fixed.ts";
import { lopInvalidatorPlan } from "../orders.ts";

const MAX_UINT = U256_MAX;

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
    case "lop": {
      const c = leg.call;
      // The calldata-kind decode has no target; the tx-kind decode names the real LOP address.
      const target = /^0x0{40}$/i.test(leg.to) ? "the 1inch LOP" : `the 1inch LOP ${short(leg.to)}`;
      if (c.fn === "cancelOrder") {
        const plan = lopInvalidatorPlan(c.makerTraits);
        const how = plan.mode === "bit" ? `sets its bit in your bit invalidator (nonce ${plan.nonceOrEpoch})` : "marks it fully filled in your remaining invalidator";
        return `cancel 1inch limit order ${short(c.orderHash)} on ${target} — ${how}; nothing moves, the order just can never fill`;
      }
      const t = c.takerTraits;
      const od = c.order;
      const terms = t.amountIsMakerAsset
        ? `take ${amount(c.amount)} of ${who(od.makerAsset, o)}, paying at most ${t.threshold === 0n ? "the order's own rate in" : `${amount(t.threshold)} of`} ${who(od.takerAsset, o)}`
        : `pay ${amount(c.amount)} of ${who(od.takerAsset, o)}, receiving at least ${t.threshold === 0n ? "the order's own rate in" : `${amount(t.threshold)} of`} ${who(od.makerAsset, o)}`;
      const delivered = c.args.receiver ? `, maker asset delivered to ${who(c.args.receiver, o)}` : "";
      const hooks: string[] = [];
      if (c.args.extension) {
        const j = leg.label?.jit;
        hooks.push(
          j
            ? `maker extension: Cork just-in-time market via adapter ${short(j.adapter)} — ${short(j.collateralAsset)}/${short(j.referenceAsset)} expiring ${j.expiryTimestamp}, ${"recipe" in j ? `recipe ${short(j.recipe)}` : `legacy mode '${j.mode}'`}, ${j.enableJitMint ? "mints the cST from the maker's collateral" : "market creation only"}, ${j.permits} embedded permit${j.permits === 1 ? "" : "s"}`
            : `${(c.args.extension.length - 2) / 2}-byte maker extension${leg.label?.fusion ? ` (${leg.label.fusion.classification === "legacy" ? "legacy Fusion" : "Fusion auction"} amount getter)` : ""}`,
        );
      }
      if (c.args.interaction) hooks.push(`${(c.args.interaction.length - 2) / 2}-byte taker interaction on ${short(c.args.interaction.slice(0, 42))}`);
      if (c.fn === "fillContractOrder" || c.fn === "fillContractOrderArgs") hooks.push("contract-maker signature (ERC-1271)");
      const hash = leg.label?.orderHash ? ` ${short(leg.label.orderHash)}` : "";
      return `fill 1inch limit order${hash} from maker ${who(od.maker, o)} on ${target}: ${terms}${delivered}${hooks.length ? ` [${hooks.join("; ")}]` : ""}`;
    }
    case "market": {
      // Market-infrastructure calls are all idempotent creates: the summary names WHAT gets
      // created and where, so a swapped pair or a wrong registry is visible at a glance.
      const p = leg.params as readonly unknown[];
      if (leg.action === "createNewPool") {
        const m = p[0] as { collateralAsset?: string; referenceAsset?: string; expiryTimestamp?: bigint; recipe?: string } | undefined;
        const pair = m && typeof m.collateralAsset === "string" && typeof m.referenceAsset === "string" ? `${who(m.collateralAsset, o)}/${who(m.referenceAsset, o)}` : "?";
        return `create the Cork pool for ${pair} expiring ${m?.expiryTimestamp ?? "?"} (recipe ${typeof m?.recipe === "string" ? short(m.recipe) : "?"}) via the market creator ${who(leg.to, o)} — idempotent: an existing pool is a lookup`;
      }
      if (leg.action === "deploy") {
        const [ca, ref, mode] = p as [unknown, unknown, unknown];
        return `deploy the ${mode === 1 ? "nav" : "price"} rate oracle for ${who(ca, o)}/${who(ref, o)} on the market registry ${who(leg.to, o)} — idempotent`;
      }
      if (leg.action === "deployFixedRateOracle") {
        return `deploy the fixed-rate oracle for rate ${amount(p[0])} (ABSOLUTE, 1e18 = 1.0) on the market registry ${who(leg.to, o)} — idempotent`;
      }
      return `call ${leg.action}() on ${who(leg.to, o)}`;
    }
    case "bundle":
      return `a nested bundle on ${who(leg.to, o)} (${leg.legs.length} leg${leg.legs.length === 1 ? "" : "s"}):`;
    case "unknown":
      return `UNREADABLE leg on ${who(leg.to, o)} — selector ${leg.selector}${leg.note ? `; ${leg.note}` : ""}. Do not sign until you have identified it`;
  }
}

/** The verification verdict, as a prefix a reader cannot miss. `trusted` is silent — it is the
 *  expected state, and a summary that says "verified" on every line trains the eye to skip. */
function verdict(leg: DecodedLeg): string {
  switch (leg.verification) {
    case "trusted":
      return "";
    case "mismatch":
      return `TARGET MISMATCH (expected ${leg.expectedTarget ?? "?"}, got ${leg.to}) — do not sign: `;
    case "unverified":
      // An unknown leg already announces itself as unreadable; a second prefix adds noise.
      return leg.kind === "unknown" ? "" : "UNVERIFIED target: ";
  }
}

/** Per-leg caveats that change what signing means, appended to the leg's own line. */
function caveats(leg: DecodedLeg): string {
  const notes: string[] = [];
  if (leg.skipRevert) notes.push("MAY FAIL SILENTLY (skipRevert)");
  if (leg.value > 0n) notes.push(`sends ${leg.value} wei`);
  // A non-zero callbackHash lets the target call back into Bundler3 (reenter) during this leg
  // — code the summary cannot see runs inside the bundle. Nothing this tool prepares sets it.
  if (hasCallback(leg)) notes.push(`CALLBACK ENABLED: the target may re-enter the bundler (callbackHash ${leg.callbackHash})`);
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
      out.push(`${prefix}${i + 1}. ${verdict(leg)}${describeLeg(leg, options)}${caveats(leg)}`);
      if (leg.kind === "bundle") walk(leg.legs, `${prefix}   `);
    });
  };
  walk(legs, "");
  return out;
}
