// Discovery-surface completeness gate. Every enum value / action variant an agent can invoke
// must also be DISCOVERABLE: present in the MATURITY map (so capabilities can say whether it
// works), findable via SEARCH_HINTS where the tool has per-variant hints, and named in the wire
// description agents actually read. Adding a variant without wiring these surfaces is silent
// drift this file turns into a test failure — in both directions (a stale MATURITY/hint entry
// pointing at a variant that no longer exists fails too).
import { describe, expect, it } from "vitest";
import { ComputeInput, MATURITY, PrepareOrdersInput, QueryInput, SEARCH_HINTS, SubmitInput } from "@cork/schemas";

const queryResources: readonly string[] = QueryInput.shape.resource.options;
const computeKinds: string[] = ComputeInput.shape.params.options.map((o) => o.shape.kind.value as string);
const submitTypes: string[] = SubmitInput.shape.action.options.map((o) => o.shape.type.value as string);
const orderTypes: string[] = PrepareOrdersInput.shape.action.options.map((o) => o.shape.type.value as string);

describe("cork_query resources are fully wired into the discovery surfaces", () => {
  const variants = Object.keys(MATURITY.cork_query?.variants ?? {});
  const hintVariants = (SEARCH_HINTS.cork_query ?? []).map((h) => h.variant);
  const describeText = QueryInput.shape.resource.description ?? "";

  it("every resource has a MATURITY variant entry (and no stale extras)", () => {
    expect([...variants].sort()).toEqual([...queryResources].sort());
  });

  it("every resource has a search hint (and no stale extras)", () => {
    expect([...hintVariants].sort()).toEqual([...queryResources].sort());
  });

  it("every resource is explained in the enum's wire description", () => {
    for (const r of queryResources) expect(describeText, `resource '${r}' missing from the resource describe`).toContain(`${r}=`);
  });
});

describe("cork_compute kinds are fully wired", () => {
  it("every kind has a MATURITY variant entry (and no stale extras)", () => {
    expect(Object.keys(MATURITY.cork_compute?.variants ?? {}).sort()).toEqual([...computeKinds].sort());
  });

  it("every kind has a search hint (and no stale extras)", () => {
    expect((SEARCH_HINTS.cork_compute ?? []).map((h) => h.variant).sort()).toEqual([...computeKinds].sort());
  });
});

describe("action-union variants match MATURITY exactly", () => {
  it("cork_submit", () => {
    expect(Object.keys(MATURITY.cork_submit?.variants ?? {}).sort()).toEqual([...submitTypes].sort());
  });

  it("cork_prepare_orders", () => {
    expect(Object.keys(MATURITY.cork_prepare_orders?.variants ?? {}).sort()).toEqual([...orderTypes].sort());
  });
});
