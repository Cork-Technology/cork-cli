// OUTPUT-side scales gate (footgun-audit A2's structural follow-up, built 2026-08-28): every
// money/rate-bearing OUTPUT field must sit under a units label. Inputs have schema-lint forcing
// x-units on every numeric field; outputs are not schema-declared, so this gate anchors on the
// ENVELOPES instead: it runs every worked example (TOOL_EXAMPLES — the canonical, test-validated
// calls) against the offline stub and walks each ok result's `data` for money-named keys whose
// value is numeric-bearing but has no labeling in scope. A new output field named like money
// ships labeled, or this test names it — the class that let taker-fill's amounts ship unlabeled
// (found only by the next manual audit) fails CI instead.
//
// "Labeled" means: the field or an ancestor object carries a `scales` block, a `scale` /
// `rateScale` string, or a `unitsTopic` pointer — the three labeling shapes the repo uses
// (CLAUDE.md "Money/rate outputs are unit-labeled"). The allowlist below admits the fields
// that look like money but are not, each WITH A REASON — the schema-lint allowlist pattern.
import { describe, expect, it } from "vitest";
import { runTool } from "@cork/core";
import { TOOL_EXAMPLES } from "@cork/schemas";
import { stubContext } from "./stub.ts";

/** Keys that look like money/rate. Deliberately broad — the allowlist narrows with reasons. */
const MONEY_KEY = /(amount|fee|premium|rate|price|notional|value|floor|cap|bump)/i;
/** A value that carries a number: bigint, number, or a digits-only string. */
const numericBearing = (v: unknown): boolean =>
  typeof v === "bigint" || typeof v === "number" || (typeof v === "string" && /^\d+$/.test(v));
/** The labeling shapes in scope for an object and its descendants. */
const labels = (o: Record<string, unknown>): boolean =>
  "scales" in o || "scale" in o || "rateScale" in o || "unitsTopic" in o;

/** Subtrees the walker SKIPS wholesale — shapes whose units are owned elsewhere and that must
 *  stay byte-faithful, so a label cannot ride inside them:
 *  - `input` / `examples`: verbatim echoes of INPUT-land, where units live in the input
 *    schema's x-units markers (schema-lint's jurisdiction, gated there);
 *  - `typedData` / `order` / `venuePost` / `intent`: wire-verbatim signable/relayable structs —
 *    injecting a scales key would change the very bytes they exist to reproduce. The labels for
 *    their amounts sit BESIDE them in `data` (the maker-order/finalize scales blocks). */
const SKIP_SUBTREES = new Set(["input", "examples", "typedData", "order", "venuePost", "intent"]);

/** Fields that MATCH the money regex but are legitimately unlabeled — each with a reason. Keyed
 *  by the LEAF key name; a `path:`-prefixed entry pins one exact location instead. */
const ALLOWLIST: Record<string, string> = {
  value: "eth-transaction wei field — named by the tx envelope convention, universally wei ('0' on every prepare)",
  premiumPaymentMode: "an enum ordinal (0=upfront, 1=on-settle), not a premium amount",
  premiumAnnualized: "the venue's decimal-fraction STRING ('0.041' = 4.1%) — not base units; the convention is the field's own contract (and it fails the digits-only check anyway)",
  maxFeePerGas: "EIP-1559 gas field on a decoded signed tx — always wei by protocol, the tx envelope's own vocabulary",
  maxPriorityFeePerGas: "see maxFeePerGas",
  notional_assets: "a venue-owned RFQ row served verbatim (snake_case wire shape, owned-shape rule): collateral base units per the venue's published contract",
};

type Violation = { tool: string; title: string; path: string };

/** Walk `data`, collecting money-named numeric-bearing keys with NO label in scope. */
function walk(tool: string, title: string, node: unknown, path: string, labeled: boolean, out: Violation[]): void {
  if (Array.isArray(node)) {
    node.forEach((item, i) => walk(tool, title, item, `${path}[${i}]`, labeled, out));
    return;
  }
  if (node === null || typeof node !== "object") return;
  const o = node as Record<string, unknown>;
  const scoped = labeled || labels(o);
  for (const [k, v] of Object.entries(o)) {
    const p = `${path}.${k}`;
    if (k === "scales") continue; // the label itself
    if (SKIP_SUBTREES.has(k)) continue;
    if (typeof v === "object" && v !== null) {
      walk(tool, title, v, p, scoped, out);
      continue;
    }
    if (!MONEY_KEY.test(k) || !numericBearing(v)) continue;
    if (scoped) continue;
    if (k in ALLOWLIST || `path:${p}` in ALLOWLIST) continue;
    out.push({ tool, title, path: p });
  }
}

describe("output scales gate: money-named output fields carry a units label", () => {
  it("every worked example's ok result walks clean (or the field joins the allowlist WITH a reason)", async () => {
    const violations: Violation[] = [];
    let okResults = 0;
    for (const [tool, examples] of Object.entries(TOOL_EXAMPLES)) {
      for (const ex of examples) {
        const env = await runTool(tool as never, ex.input as never, stubContext());
        if (env.state !== "ok") continue;
        okResults++;
        walk(tool, ex.title, env.data, "data", false, violations);
      }
    }
    // The battery must actually exercise outputs — a stub regression that turns every example
    // unavailable would otherwise make this gate silently vacuous.
    expect(okResults).toBeGreaterThanOrEqual(10);
    const rendered = violations.map((v) => `${v.tool} (${v.title}): ${v.path}`).join("\n");
    expect(violations, `unlabeled money-named output fields — add a scales/scale label beside them, or allowlist WITH a reason:\n${rendered}`).toEqual([]);
  });

  it("the walker itself SEES an unlabeled field (self-test: the gate cannot be vacuously green)", () => {
    const out: Violation[] = [];
    walk("t", "seed", { requiredTakingAmount: "1000" }, "data", false, out);
    expect(out).toHaveLength(1);
    // …and a scales sibling or an ancestor label silences exactly that finding.
    const labeled: Violation[] = [];
    walk("t", "seed", { requiredTakingAmount: "1000", scales: { requiredTakingAmount: "base units" } }, "data", false, labeled);
    expect(labeled).toEqual([]);
    const ancestor: Violation[] = [];
    walk("t", "seed", { scale: "ABSOLUTE, 1e18 = 1.0", inner: { swapRate: "800" } }, "data", false, ancestor);
    expect(ancestor).toEqual([]);
  });
});
