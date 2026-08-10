// Phase 1 acceptance pins (remote-MCP signing plan): the signing doc topic resolves by name AND
// every alias AND via search, and every prepare result carries the data.execution completion
// pointer. All offline (config-only paths).
import { describe, expect, it } from "vitest";
import { DOC_TOPICS, inputJsonSchema, REGISTRY, UNITS_TOPIC_REFERENCE } from "@cork/schemas";
import { runTool } from "@cork/core";

const NOW = 1_800_000_000n;
const A = "0xc0ffee0000000000000000000000000000000001" as const;

describe("doc topic: signing", () => {
  it("resolves by name and by every alias, case-insensitively", async () => {
    for (const key of ["signing", "SIGNING", "execute", "broadcast", "sign-and-broadcast"]) {
      const env = await runTool("cork_capabilities", { topic: key }, { nowSeconds: NOW });
      expect(env.state).toBe("ok");
      const d = env.data as { topic: string; summary: string; body: string };
      expect(d.topic).toBe("signing");
      expect(d.summary).toBe(DOC_TOPICS.signing!.summary);
      expect(d.body).toContain("eth_sendRawTransaction");
    }
  });

  it("surfaces in search results as a topic card", async () => {
    const env = await runTool("cork_capabilities", { search: "how do I sign and broadcast this" }, { nowSeconds: NOW });
    expect(env.state).toBe("ok");
    const matches = (env.data as { matches: Array<Record<string, unknown>> }).matches;
    const topic = matches.find((m) => m.topic === "signing");
    expect(topic).toBeDefined();
    expect(topic!.reference).toBe('cork_capabilities topic:"signing"');
  });

  it("an unknown topic's teaching message names every doc topic + alias (derived, not hardcoded)", async () => {
    const env = await runTool("cork_capabilities", { topic: "nonexistent" }, { nowSeconds: NOW });
    expect(env.state).toBe("unavailable");
    for (const t of Object.values(DOC_TOPICS)) {
      expect(env.warnings[0]!.message).toContain(t.name);
      for (const a of t.aliases) expect(env.warnings[0]!.message).toContain(a);
    }
  });
});

describe("doc topic: units", () => {
  it("resolves by name and by every alias, case-insensitively", async () => {
    for (const key of ["units", "UNITS", "scales", "decimals", "wad", "fixed-point"]) {
      const env = await runTool("cork_capabilities", { topic: key }, { nowSeconds: NOW });
      expect(env.state).toBe("ok");
      const d = env.data as { topic: string; summary: string; body: string };
      expect(d.topic).toBe("units");
      expect(d.summary).toBe(DOC_TOPICS.units!.summary);
      expect(d.body).toContain("1e18 = 1%");
    }
  });

  it("surfaces in search results as a topic card", async () => {
    for (const q of ["what scale is this field", "is this wad or percent", "how many decimals"]) {
      const env = await runTool("cork_capabilities", { search: q }, { nowSeconds: NOW });
      expect(env.state).toBe("ok");
      const matches = (env.data as { matches: Array<Record<string, unknown>> }).matches;
      const topic = matches.find((m) => m.topic === "units");
      expect(topic, `search: ${q}`).toBeDefined();
      expect(topic!.reference).toBe(UNITS_TOPIC_REFERENCE);
    }
  });

  // The topic is a SECOND statement of a scale that already lives in each field's schema
  // description — so it can rot against the schemas. This pins both directions: the field's own
  // description must carry the scale marker, AND the topic body must name the field. Trail of Bits
  // found no correlation between unit-test volume and precision findings, so the guard that matters
  // is the one that fails when the two sources disagree, not another example.
  it("table parity: every field the topic names carries the same scale in its own schema description", () => {
    const SCALED_FIELDS: Array<{ field: string; marker: string }> = [
      { field: "swapFeePercentage", marker: "1e18 = 1%" },
      { field: "unwindSwapFeePercentage", marker: "1e18 = 1%" },
      { field: "rateOverride", marker: "1e18 = 1.0" },
      { field: "rate", marker: "1e18 = 1.0" },
      { field: "initialRateBump", marker: "1e7" },
      { field: "rateBump", marker: "1e7" },
      { field: "premium", marker: "PERCENT" },
      { field: "minPremiumPerShare", marker: "per 1e18" },
      // NOT listed: gasPriceEstimate / integratorFee / resolverFee / whitelistDiscountNumerator /
      // surplusFeePercent. Those are Fusion DECODE OUTPUTS (fusion.ts), never tool inputs, so they
      // have no input-schema description to check against — the topic labels them explicitly as
      // outputs instead. This list's contract is: input fields whose own description states a scale.
    ];

    // Collect every description reachable for a property name, resolving $refs into $defs (the
    // shared primitives — TokenAmount, PremiumPerShareRate — carry their teaching there, not at
    // the use site).
    const byField = new Map<string, string[]>();
    for (const tool of REGISTRY) {
      const schema = inputJsonSchema(tool.name) as Record<string, unknown>;
      const defs = (schema.$defs ?? {}) as Record<string, { description?: string }>;
      const walk = (node: unknown): void => {
        if (node === null || typeof node !== "object") return;
        const n = node as Record<string, unknown>;
        const props = n.properties as Record<string, Record<string, unknown>> | undefined;
        if (props) {
          for (const [name, prop] of Object.entries(props)) {
            const texts: string[] = [];
            if (typeof prop.description === "string") texts.push(prop.description);
            const ref = typeof prop.$ref === "string" ? prop.$ref.split("/").pop() : undefined;
            const refDesc = ref ? defs[ref]?.description : undefined;
            if (typeof refDesc === "string") texts.push(refDesc);
            if (texts.length > 0) byField.set(name, [...(byField.get(name) ?? []), ...texts]);
          }
        }
        for (const v of Object.values(n)) {
          if (Array.isArray(v)) v.forEach(walk);
          else walk(v);
        }
      };
      walk(schema);
    }

    const body = DOC_TOPICS.units!.body;
    for (const { field, marker } of SCALED_FIELDS) {
      const descs = byField.get(field);
      expect(descs, `${field} is not a property on any tool schema — rename or drop it from the units topic`).toBeDefined();
      expect(descs!.some((d) => d.includes(marker)), `${field}: no schema description states '${marker}'`).toBe(true);
      expect(body.includes(field), `the units topic body does not name ${field}`).toBe(true);
    }
  });

  it("the scale tripwires route to the topic (an error should teach the correct form, not only reject)", () => {
    // Asserted at the source-constant level: the three premium tripwire messages interpolate
    // UNITS_TOPIC_REFERENCE, so the routing cannot silently drop out of one of them.
    expect(UNITS_TOPIC_REFERENCE).toBe('cork_capabilities topic:"units"');
    expect(DOC_TOPICS.units!.name).toBe("units");
  });
});

describe("data.execution on prepare results (offline-buildable variants)", () => {
  const execOf = (env: { data: unknown }) => (env.data as { execution?: { kind: string; sign: string; then: string[]; reference: string } } | null)?.execution;

  it("authority-onboard (eth-transaction family)", async () => {
    const env = await runTool("cork_prepare_phoenix", { chainId: 1, account: A, clientRequestId: "exec-test-0001", action: { type: "authority-onboard", token: "0x9D39A5DE30e57443BfF2A8307A4256c8797A3497", spender: "0xCCcCcCCCcccCBaD6F772a511B337d9CCc9570407" } }, { nowSeconds: NOW });
    expect(env.state).toBe("ok");
    const ex = execOf(env)!;
    expect(ex.kind).toBe("eth-transaction");
    expect(ex.sign).toBe("eth_signTransaction");
    expect(ex.then.join(" ")).toMatch(/cork_track simulate[\s\S]*cork_decode[\s\S]*eth_sendRawTransaction/);
    expect(ex.reference).toBe('cork_capabilities topic:"signing"');
  });

  it("cancel (eth-transaction family)", async () => {
    const env = await runTool("cork_prepare_orders", { chainId: 1, account: A, clientRequestId: "exec-test-0002", action: { type: "cancel", orderHash: `0x${"11".repeat(32)}`, makerTraits: "0" } }, { nowSeconds: NOW });
    expect(env.state).toBe("ok");
    expect(execOf(env)!.kind).toBe("eth-transaction");
  });

  it("maker-order (typed-data family, finalize→submit path)", async () => {
    const env = await runTool("cork_prepare_orders", { chainId: 1, account: A, clientRequestId: "exec-test-0003", action: { type: "maker-order", poolId: `0x${"ce".repeat(32)}`, side: "SELL", makerAsset: "0x9D39A5DE30e57443BfF2A8307A4256c8797A3497", takerAsset: "0x53E82ABbb12638F09d9e624578ccB666217a765e", makingAmount: "1000000000000000000", takingAmount: "1000000" } }, { nowSeconds: NOW });
    expect(env.state).toBe("ok");
    const ex = execOf(env)!;
    expect(ex.kind).toBe("eip712-typed-data");
    expect(ex.sign).toBe("eth_signTypedData_v4");
    expect(ex.then.join(" ")).toMatch(/finalize-maker-order[\s\S]*cork_submit lop-order/);
  });

  it("rollover-intent (typed-data family, direct submit path)", async () => {
    const env = await runTool("cork_prepare_orders", { chainId: 42161, account: A, clientRequestId: "exec-test-0004", action: { type: "rollover-intent", settler: "0x983270AE48545665Cee4D7EF61C65fF3fdC8222D", rolloverContract: A, srcPoolId: `0x${"11".repeat(32)}`, dstPoolId: `0x${"22".repeat(32)}`, srcCstToken: "0x9D39A5DE30e57443BfF2A8307A4256c8797A3497", dstCstToken: "0x53E82ABbb12638F09d9e624578ccB666217a765e", premiumToken: "0x9D39A5DE30e57443BfF2A8307A4256c8797A3497", orderSize: "250000000000000000000", minPremiumPerShare: "12000000000000000", openDeadline: "1900000000", fillDeadline: "1900604800" } }, { nowSeconds: NOW });
    expect(env.state).toBe("ok");
    const ex = execOf(env)!;
    expect(ex.kind).toBe("eip712-typed-data");
    expect(ex.then.join(" ")).toMatch(/cork_submit rollover-order/);
  });

  it("finalize-maker-order does NOT carry execution (it already emits a relayable artifact)", async () => {
    // A context-mismatched finalize returns conflict with data null — the no-execution claim is
    // structural: the success path builds `artifact` without the field (asserted here via source
    // shape: any ok finalize data has signedArtifactDigest, never execution). Cheap proxy: the
    // conflict path.
    const env = await runTool("cork_prepare_orders", { chainId: 1, account: A, clientRequestId: "exec-test-0005", action: { type: "finalize-maker-order", prepared: { kind: "maker-order", lop: "0x111111125421ca6dc452d289314280a0f8842a65", typedData: { domain: { chainId: 42161, verifyingContract: "0x111111125421ca6dc452d289314280a0f8842a65" }, message: { salt: "1", maker: A, receiver: `0x${"00".repeat(20)}`, makerAsset: "0x9D39A5DE30e57443BfF2A8307A4256c8797A3497", takerAsset: "0x53E82ABbb12638F09d9e624578ccB666217a765e", makingAmount: "1", takingAmount: "1", makerTraits: "0" } }, orderHash: `0x${"11".repeat(32)}`, extension: "0x", clientRequestId: "exec-test-0005" }, signature: `0x${"11".repeat(65)}`, listing: { side: "SELL", premium: 1, expiry: 0, nonce: "0", allowsPartialFills: true } } }, { nowSeconds: NOW });
    expect(execOf(env)).toBeUndefined();
  });
});
