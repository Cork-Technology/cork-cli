// Maturity map ↔ handler consistency gate: MATURITY is hand-maintained data, so this test probes
// every variant it declares "specified" (gated) through the real runTool dispatch and asserts the
// handler actually returns `unavailable` with the reason code the map advertises. When a variant
// is later implemented, its probe here fails → whoever activates it must update MATURITY in the
// same change. The coverage assertion closes the other direction: a newly-gated MATURITY entry
// without a probe fails too. Offline by design (CORK_CONFIG_NO_FETCH=1 via vitest.config.ts).
import { describe, expect, it } from "vitest";
import { DEMO_POOL_ID, MATURITY, type ToolName } from "@cork/schemas";
import { runTool } from "@cork/core";

const NOW = 1_800_000_000n;
const P = DEMO_POOL_ID;
const A = "0xc0ffee0000000000000000000000000000000001";
const T = "0x9d39a5de30e57443bff2a8307a4256c8797a3497"; // sUSDe (lowercase = no checksum claimed)
const S = "0xccccccccccccbad6f772a511b337d9ccc9570407"; // corkAdapter
const H = `0x${"22".repeat(32)}`;

/** One probe per MATURITY entry with status "specified"; key = `${tool}:${variantKey|*}`. */
const GATED_PROBES: Array<{ tool: ToolName; key: string; input: unknown }> = [
  // cork_query — indexer-backed resources
  ...["markets", "whitelisted-addresses", "flows", "limit-order-markets", "orderbook", "fills"].map(
    (resource) => ({ tool: "cork_query" as const, key: resource, input: { resource } }),
  ),
  // cork_compute — backend-gated kinds
  { tool: "cork_compute", key: "dutch-auction-price", input: { params: { kind: "dutch-auction-price", order: {} } } },
  { tool: "cork_compute", key: "rfq-quote", input: { params: { kind: "rfq-quote", marketTypeBucket: "stable", durationSeconds: 86400 } } },
  // cork_decode — non-calldata kinds
  { tool: "cork_decode", key: "order", input: { kind: "order", data: {} } },
  { tool: "cork_decode", key: "event", input: { kind: "event", data: "0x00" } },
  { tool: "cork_decode", key: "receipt", input: { kind: "receipt", data: {} } },
  // cork_prepare_phoenix — authority ops
  { tool: "cork_prepare_phoenix", key: "authority-onboard", input: { chainId: 1, account: A, clientRequestId: "maturity-probe-01", action: { type: "authority-onboard", token: T, spender: S } } },
  { tool: "cork_prepare_phoenix", key: "authority-revoke", input: { chainId: 1, account: A, clientRequestId: "maturity-probe-02", action: { type: "authority-revoke", token: T, spender: S } } },
  // cork_prepare_orders — service-backed variants
  { tool: "cork_prepare_orders", key: "taker-fill", input: { chainId: 1, account: A, clientRequestId: "maturity-probe-03", action: { type: "taker-fill", orderHash: H } } },
  // cork_track — simulate + service-backed subjects
  { tool: "cork_track", key: "simulate", input: { mode: "simulate", subject: { kind: "artifact", artifact: {} } } },
  { tool: "cork_track", key: "reconcile/orderHash", input: { mode: "reconcile", subject: { kind: "orderHash", orderHash: H } } },
  { tool: "cork_track", key: "reconcile/submissionRef", input: { mode: "reconcile", subject: { kind: "submissionRef", submissionRef: "sub-0001" } } },
  // tool-level gated
  { tool: "cork_prepare_market", key: "*", input: { chainId: 1, clientRequestId: "maturity-probe-05", action: { type: "deploy-wrapper", collateralAsset: T, referenceAsset: T } } },
  { tool: "cork_submit", key: "*", input: { chainId: 1, clientRequestId: "maturity-probe-06", signedOrder: {}, signature: "0x00" } },
];

/** The reason string's leading token is the warning code the gated call must return. */
function reasonCode(reason: string | undefined): string {
  expect(reason, "every specified maturity entry must carry a reason").toBeTruthy();
  return reason!.split(/[\s(]/, 1)[0]!;
}

function maturityFor(tool: ToolName, key: string): { status: string; reason?: string } {
  const m = MATURITY[tool]!;
  if (key === "*") return m;
  const v = m.variants?.[key];
  expect(v, `MATURITY[${tool}].variants['${key}'] must exist`).toBeTruthy();
  return v!;
}

describe("MATURITY map agrees with handler behavior", () => {
  it("covers every 'specified' maturity entry with a probe (and no extras)", () => {
    const declared = new Set<string>();
    for (const [tool, m] of Object.entries(MATURITY)) {
      if (m.variants) {
        for (const [k, v] of Object.entries(m.variants)) if (v.status === "specified") declared.add(`${tool}:${k}`);
        if (m.status === "specified") declared.add(`${tool}:*`);
      } else if (m.status === "specified") {
        declared.add(`${tool}:*`);
      }
    }
    const probed = new Set(GATED_PROBES.map((p) => `${p.tool}:${p.key}`));
    expect([...probed].sort()).toEqual([...declared].sort());
  });

  it.each(GATED_PROBES.map((p) => [`${p.tool}:${p.key}`, p] as const))(
    "%s: gated in code exactly as the map claims",
    async (_label, probe) => {
      const m = maturityFor(probe.tool, probe.key);
      expect(m.status).toBe("specified");
      const env = await runTool(probe.tool, probe.input, { nowSeconds: NOW });
      expect(env.state).toBe("unavailable");
      expect(env.warnings[0]?.code).toBe(reasonCode(m.reason));
    },
  );
});
