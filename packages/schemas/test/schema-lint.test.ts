// Schema lint (footgun class-elimination item 7): the dialect taxonomy as CI.
//
// Every numeric leaf on the tool input surface must be EXPLICITLY allowlisted with a reason.
// The default for any field carrying money/time/rate semantics is a protected string primitive
// (UnixSeconds/TokenAmount/UintStr/Uint64Str) — those primitives carry the unit teaching, the
// uint bounds, and the milliseconds detector, so every new field that uses them starts life
// protected. A bare z.number() bypasses all of that (floats, silent JSON precision loss ≥ 2^53,
// no unit teaching), which is exactly how the F1/F2/F5/F6/F22 class was born one field at a time.
//
// If this test fails on a NEW field: prefer the protected primitives; only extend the allowlist
// for genuinely small/bounded numerics (enum-like modes, page sizes, bounded relative durations,
// venue-defined wire floats) — and say why.
import { describe, expect, it } from "vitest";
import { REGISTRY, inputJsonSchema } from "@cork/schemas";

/** tool :: dotted-path (union branches as <oneOfN>) → reason it is allowed to be numeric. */
const NUMERIC_ALLOWLIST: Record<string, string> = {
  // chainId: a closed numeric enum of known chains, everywhere.
  "cork_query :: chainId": "closed enum",
  "cork_compute :: chainId": "closed enum",
  "cork_decode :: chainId": "closed enum",
  "cork_prepare_phoenix :: chainId": "closed enum",
  "cork_prepare_orders :: chainId": "closed enum",
  "cork_prepare_orders :: action<oneOf1>.prepared.typedData.domain.chainId": "closed enum (round-tripped prepared artifact)",
  "cork_prepare_market :: chainId": "closed enum",
  "cork_track :: chainId": "closed enum",
  "cork_submit :: chainId": "closed enum",
  // Pagination knobs: small bounded ints, no domain semantics.
  "cork_query :: pageSize": "bounded page knob (1..200)",
  "cork_query :: maxPages": "bounded page knob (1..50)",
  "cork_prepare_orders :: action<oneOf2>.maxPages": "bounded page knob (1..50)",
  // RELATIVE durations, bounded in schema — never absolute moments.
  "cork_compute :: params<oneOf4>.horizonSeconds": "relative duration (impairment horizon)",
  "cork_compute :: params<oneOf5>.durationSeconds": "relative duration (phase-gated rfq-quote)",
  "cork_prepare_phoenix :: deadlineSeconds": "relative duration, bounded 1..86400",
  "cork_prepare_orders :: action<oneOf0>.expirySeconds": "relative duration, bounded <= 10y (traits slot is 40-bit)",
  // Venue-defined wire numerics (the venue's own JSON contract), bounded in schema.
  "cork_prepare_orders :: action<oneOf1>.listing.premium": "venue book field: PERCENT float, bounded 0..1000",
  "cork_prepare_orders :: action<oneOf1>.listing.expiry": "venue book field: absolute unix int, bounded <= year 2100",
  "cork_submit :: action<oneOf1>.premium": "venue book field: PERCENT float, bounded 0..1000",
  "cork_submit :: action<oneOf1>.expiry": "venue book field: absolute unix int, bounded <= year 2100",
  "cork_submit :: action<oneOf2>.expiryWindow.notBefore": "venue RFQ field: absolute unix int, bounded <= year 2100 + handler window checks",
  "cork_submit :: action<oneOf2>.expiryWindow.notAfter": "venue RFQ field: absolute unix int, bounded <= year 2100 + handler window checks",
  "cork_submit :: action<oneOf2>.validUntil": "venue RFQ field: absolute unix int, bounded <= year 2100 + future check",
  // Tiny fixed-width protocol values.
  "cork_prepare_orders :: action<oneOf0>.jitMarket.permits[].v": "ECDSA recovery byte 0..255",
  "cork_prepare_orders :: action<oneOf4>.premiumPaymentMode<anyOf0>": "literal 0|1",
  "cork_prepare_orders :: action<oneOf4>.premiumPaymentMode<anyOf1>": "literal 0|1",
  "cork_submit :: action<oneOf0>.order.premiumPaymentMode<anyOf0>": "literal 0|1",
  "cork_submit :: action<oneOf0>.order.premiumPaymentMode<anyOf1>": "literal 0|1",
};

/** Absolute-time fields riding as bounded venue ints (allowed above) — every OTHER field whose
 *  name smells of time/money/rate must be a string $ref to a protected primitive. */
const SEMANTIC_NAME = /deadline|expiry|expires|until|timestamp|amount|premium|rate\b|size|notional|salt|nonce/i;

function collectNumericLeaves(node: unknown, path: string, tool: string, out: string[]): void {
  if (!node || typeof node !== "object") return;
  const o = node as Record<string, unknown>;
  const t = o.type;
  if (t === "number" || t === "integer" || (Array.isArray(o.enum) && o.enum.some((v) => typeof v === "number"))) {
    out.push(`${tool} :: ${path}`);
  }
  const props = o.properties as Record<string, unknown> | undefined;
  if (props) for (const [k, v] of Object.entries(props)) collectNumericLeaves(v, path ? `${path}.${k}` : k, tool, out);
  if (o.items) collectNumericLeaves(o.items, `${path}[]`, tool, out);
  for (const key of ["anyOf", "oneOf", "allOf"] as const) {
    const arr = o[key] as unknown[] | undefined;
    if (arr) arr.forEach((v, i) => collectNumericLeaves(v, `${path}<${key}${i}>`, tool, out));
  }
  if (o.additionalProperties && typeof o.additionalProperties === "object") collectNumericLeaves(o.additionalProperties, `${path}.*`, tool, out);
  if (o.$defs) for (const [k, v] of Object.entries(o.$defs as Record<string, unknown>)) collectNumericLeaves(v, `$defs.${k}`, tool, out);
}

describe("schema lint: the numeric-dialect taxonomy as CI", () => {
  const leaves: string[] = [];
  for (const t of REGISTRY) collectNumericLeaves(inputJsonSchema(t.name), "", t.name, leaves);

  it("every numeric leaf on the tool input surface is explicitly allowlisted with a reason", () => {
    const unlisted = leaves.filter((l) => !(l in NUMERIC_ALLOWLIST));
    expect(unlisted, `new numeric field(s) without an allowlist entry — prefer the protected string primitives (UnixSeconds/TokenAmount/UintStr); if a bare number is genuinely right, add an entry with the reason:\n${unlisted.join("\n")}`).toEqual([]);
  });

  it("the allowlist carries no dead entries (fields that no longer exist)", () => {
    const present = new Set(leaves);
    const dead = Object.keys(NUMERIC_ALLOWLIST).filter((k) => !present.has(k));
    expect(dead, "allowlist entries for fields that no longer exist — remove them").toEqual([]);
  });

  it("numeric fields with time/money/rate names are individually justified (no blanket pass)", () => {
    // Every semantically-named numeric leaf must be in the allowlist (checked above) AND its
    // reason must mention a bound or venue contract — a reminder that the DEFAULT for such
    // fields is a protected string primitive.
    for (const l of leaves) {
      const field = l.split(" :: ")[1] ?? "";
      const leafName = field.split(/[.<[]/).pop() ?? field.split(".").pop() ?? "";
      if (SEMANTIC_NAME.test(leafName)) {
        const reason = NUMERIC_ALLOWLIST[l] ?? "";
        expect(/bounded|relative|venue|literal|byte/i.test(reason), `${l}: semantically-named numeric field needs a bound/venue justification (got: "${reason}")`).toBe(true);
      }
    }
  });

  it("the protected primitives keep their guarantees (spot checks)", async () => {
    const { UnixSeconds, TokenAmount, UintStr } = await import("@cork/schemas");
    expect(UnixSeconds.safeParse(String(Date.now())).success).toBe(false); // ms detector
    expect(TokenAmount.safeParse(String((1n << 256n))).success).toBe(false); // uint256 bound
    expect(UintStr.safeParse("1.5").success).toBe(false); // integers only — and no BigInt throw inside safeParse
  });
});
