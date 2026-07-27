// Maturity map ↔ handler consistency gate: MATURITY is hand-maintained data, so this test probes
// every variant it declares "specified" (gated) through the real runTool dispatch and asserts the
// handler actually returns `unavailable` with the reason code the map advertises. When a variant
// is later implemented, its probe here fails → whoever activates it must update MATURITY in the
// same change. The coverage assertion closes the other direction: a newly-gated MATURITY entry
// without a probe fails too. Offline by design (CORK_CONFIG_NO_FETCH=1 via vitest.config.ts).
import { describe, expect, it } from "vitest";
import { MATURITY, type ToolName } from "@cork/schemas";
import { runTool } from "@cork/core";

const NOW = 1_800_000_000n;

/** One probe per MATURITY entry with status "specified"; key = `${tool}:${variantKey|*}`. */
const GATED_PROBES: Array<{ tool: ToolName; key: string; input: unknown }> = [
  // cork_compute — the two deliberately-gated kinds. dutch-auction-price waits on an out-of-scope
  // external protocol (1inch Fusion is not in the pilot); rfq-quote waits on a pricing MODEL (a
  // product decision). Everything else is activated: whitelisted-addresses (2026-07-27, HyperSync
  // event replay), decode order/event/receipt (2026-07-27, pure local), prepare_phoenix
  // authority-onboard/revoke (2026-07-27, unsigned direct approve txs), taker-fill,
  // track simulate/artifact, prepare_market — none probed as gated any more.
  { tool: "cork_compute", key: "dutch-auction-price", input: { params: { kind: "dutch-auction-price", order: {} } } },
  { tool: "cork_compute", key: "rfq-quote", input: { params: { kind: "rfq-quote", marketTypeBucket: "stable", durationSeconds: 86400 } } },
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
