// The generation model (cork-cli 0.6, 2026-09-22): a chain hosts a SET of contract generations,
// one primary. Pure functions over hand-built lists, plus the pool-scoped resolver against a
// stubbed client — every ordering, selection and classification rule the handlers lean on is
// pinned here, and the bundled v2 document is walked through the same functions so the config
// and the code cannot disagree about which set is primary or what each block speaks.
import { describe, expect, it } from "vitest";
import {
  BUNDLED_DEFAULTS,
  classifyAddress,
  ChainGenerationsSchema,
  GENERATION_LABEL_RENAMES,
  GENERATION_ROLES,
  generationsOf,
  renamedGenerationLabel,
  resolveGenerationAlias,
  IMPLEMENTED_MARKET_REGISTRY_WIRES,
  MARKET_REGISTRY_WIRES,
  marketRegistryForWire,
  PHOENIX_WIRES,
  primaryOf,
  resolvePoolGeneration,
  ROLLOVER_WIRES,
  rolloverGenerationsOf,
  selectGeneration,
  type PoolGenerationClient,
  type ResolvedGeneration,
} from "@cork/core";

const A = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`;
const POOL = `0x${"ab".repeat(32)}` as const;
const ZERO = "0x0000000000000000000000000000000000000000" as const;

/** A three-set chain in CONFIG order: read-only first, then the primary, then another active —
 *  deliberately not resolution order, so ordering is proven, not inherited. */
const DEFAULTS = {
  generations: {
    "7": {
      primary: "new",
      sets: {
        old: { status: "read-only" as const, phoenix: { poolManager: A(0x10), constraintAdapter: A(0x11), wire: "8-field" as const } },
        new: {
          status: "active" as const,
          distribution: "phoenix/vX",
          phoenix: { poolManager: A(0x20), constraintAdapter: A(0x21), corkAdapter: A(0x22), whitelistManager: A(0x23), controller: A(0x24), wire: "10-field" as const },
          marketRegistry: { registry: A(0x30), adapter: A(0x31), marketCreator: A(0x32), controller: A(0x24), recipes: { liquidity: A(0x33), nav: A(0x34) }, wire: "nested" as const },
          rollover: { factory: A(0x40), exactSettler: A(0x41), partialSettler: A(0x42), settlerDomain: { name: "CorkSettler", version: "1.0.0" }, seededAtBlock: 300, wire: "0.2" as const },
          forSelf: { adapter: A(0x50) },
        },
        mid: {
          status: "active" as const,
          phoenix: { poolManager: A(0x60), constraintAdapter: A(0x61), corkAdapter: A(0x62), wire: "8-field" as const },
          marketRegistry: { registry: A(0x70), adapter: A(0x71), wire: "flat" as const },
          rollover: { factory: A(0x80), exactSettler: A(0x81), partialSettler: A(0x82), settlerDomain: { name: "CorkSettler", version: "1.0.0" }, seededAtBlock: 200, wire: "rc.2" as const },
        },
        legacy: {
          status: "active" as const,
          marketRegistry: { registry: A(0x90), adapter: A(0x91), wire: "legacy" as const },
          rollover: { factory: A(0xa0), exactSettler: A(0xa1), partialSettler: A(0xa2), settlerDomain: { name: "CorkSettler", version: "1.0.0" }, seededAtBlock: 100, retired: "2026-08-13", wire: "rc.1" as const },
        },
      },
    },
  },
};
const LIST = generationsOf(DEFAULTS, 7);

describe("wire vocabularies are code enums the config is validated against", () => {
  it("names exactly the wires the design contract declares (+ rc.1 for the retired July rollover set)", () => {
    expect(PHOENIX_WIRES).toEqual(["8-field", "10-field"]);
    expect(MARKET_REGISTRY_WIRES).toEqual(["legacy", "flat", "nested"]);
    expect(ROLLOVER_WIRES).toEqual(["rc.1", "rc.2", "0.2"]);
    // Both non-legacy wires are implemented (market-registry.ts WIRES); the legacy wire is the
    // deprecated lane and is never listed here.
    expect(IMPLEMENTED_MARKET_REGISTRY_WIRES).toEqual(["flat", "nested"]);
    expect(GENERATION_ROLES).toContain("recipe");
    expect(GENERATION_ROLES).not.toContain("bundler3");
  });
  it("a chain's primary must name an ACTIVE set", () => {
    expect(() => ChainGenerationsSchema.parse({ primary: "x", sets: {} })).toThrow(/names no set/);
    expect(() => ChainGenerationsSchema.parse({ primary: "x", sets: { x: { status: "read-only" } } })).toThrow(/must be active/);
    expect(ChainGenerationsSchema.parse({ primary: "x", sets: { x: { status: "active" } } }).primary).toBe("x");
  });
});

describe("generationsOf — resolution order: primary, other active (config order), read-only (config order)", () => {
  it("orders the hand-built chain primary-first whatever the config order, and flags exactly one primary", () => {
    expect(LIST.map((g) => [g.label, g.status, g.primary])).toEqual([
      ["new", "active", true],
      ["mid", "active", false],
      ["legacy", "active", false],
      ["old", "read-only", false],
    ]);
    expect(LIST.filter((g) => g.primary)).toHaveLength(1);
    expect(primaryOf(LIST)?.label).toBe("new");
    expect(LIST[0]).toMatchObject({ distribution: "phoenix/vX", phoenix: { wire: "10-field" }, marketRegistry: { wire: "nested" } });
  });
  it("a chain with no generations is an empty list and no primary", () => {
    expect(generationsOf(DEFAULTS, 1)).toEqual([]);
    expect(primaryOf([])).toBeUndefined();
    expect(generationsOf({}, 7)).toEqual([]);
  });
  it("the bundled document resolves the way the design pins it", () => {
    expect(generationsOf(BUNDLED_DEFAULTS, 42161).map((g) => g.label)).toEqual(["cork/v0.4", "cork/v0.3", "arbitrum-v1.1", "arbitrum-legacy"]);
    expect(generationsOf(BUNDLED_DEFAULTS, 8453).map((g) => g.label)).toEqual(["cork/v0.4", "cork/v0.3"]);
    expect(generationsOf(BUNDLED_DEFAULTS, 1).map((g) => g.label)).toEqual(["mainnet"]);
  });
});

describe("selectGeneration — primary by default, the named set otherwise, typed refusals", () => {
  it("omitted label → the primary; a label → that set, whatever its position", () => {
    expect(selectGeneration(LIST)).toMatchObject({ ok: true, generation: { label: "new" } });
    expect(selectGeneration(LIST, "legacy")).toMatchObject({ ok: true, generation: { label: "legacy" } });
    expect(selectGeneration(LIST, "old")).toMatchObject({ ok: true, generation: { label: "old", status: "read-only" } });
  });
  it("an unknown label refuses generation_unknown and lists every label with its standing", () => {
    const r = selectGeneration(LIST, "nope");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.refusal.code).toBe("generation_unknown");
    expect(r.refusal.message).toContain("new (active, primary)");
    expect(r.refusal.message).toContain("old (read-only)");
    expect(r.refusal.message).toContain("omit `generation`");
  });
  it("a read-only set is selectable for a READ and refused for a PREPARE (generation_read_only, naming the primary)", () => {
    expect(selectGeneration(LIST, "old", "read").ok).toBe(true);
    const r = selectGeneration(LIST, "old", "prepare");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.refusal.code).toBe("generation_read_only");
    expect(r.refusal.message).toContain("target the primary (new)");
    // An active non-primary set prepares fine.
    expect(selectGeneration(LIST, "mid", "prepare").ok).toBe(true);
  });
  it("an empty list refuses unknown_deployment (nothing to select from)", () => {
    expect(selectGeneration([])).toMatchObject({ ok: false, refusal: { code: "unknown_deployment" } });
  });
});

describe("classifyAddress — every role an address holds, per generation, in resolution order", () => {
  it("maps each block field to its role", () => {
    const one = (addr: `0x${string}`) => classifyAddress(LIST, addr).map((c) => [c.label, c.role, c.recipeName]);
    expect(one(A(0x20))).toEqual([["new", "poolManager", undefined]]);
    expect(one(A(0x21))).toEqual([["new", "constraintAdapter", undefined]]);
    expect(one(A(0x22))).toEqual([["new", "corkAdapter", undefined]]);
    expect(one(A(0x23))).toEqual([["new", "whitelistManager", undefined]]);
    expect(one(A(0x30))).toEqual([["new", "registry", undefined]]);
    expect(one(A(0x31))).toEqual([["new", "jitAdapter", undefined]]);
    expect(one(A(0x32))).toEqual([["new", "marketCreator", undefined]]);
    expect(one(A(0x33))).toEqual([["new", "recipe", "liquidity"]]);
    expect(one(A(0x40))).toEqual([["new", "factory", undefined]]);
    expect(one(A(0x41))).toEqual([["new", "exactSettler", undefined]]);
    expect(one(A(0x42))).toEqual([["new", "partialSettler", undefined]]);
    expect(one(A(0x50))).toEqual([["new", "forSelfAdapter", undefined]]);
    expect(one(A(0x91))).toEqual([["legacy", "jitAdapter", undefined]]);
    expect(one(A(0xa1))).toEqual([["legacy", "exactSettler", undefined]]);
  });
  it("a contract two blocks of one generation name (the controller) is reported ONCE per generation; case-insensitive; unknown → empty", () => {
    expect(classifyAddress(LIST, A(0x24).toUpperCase().replace("0X", "0x"))).toEqual([{ label: "new", status: "active", primary: true, role: "controller" }]);
    expect(classifyAddress(LIST, A(0xff))).toEqual([]);
  });
  it("an address shared across generations lists every generation, primary first", () => {
    const shared = generationsOf({ generations: { "9": { primary: "p", sets: { q: { status: "read-only", phoenix: { poolManager: A(1), constraintAdapter: A(2), wire: "8-field" } }, p: { status: "active", phoenix: { poolManager: A(1), constraintAdapter: A(3), wire: "8-field" } } } } } }, 9);
    expect(classifyAddress(shared, A(1)).map((c) => [c.label, c.role, c.status])).toEqual([["p", "poolManager", "active"], ["q", "poolManager", "read-only"]]);
  });
  it("walks the bundled Arbitrum document: the shared 0.5.0 controller sits on both blocks of ONE generation; the 0.3.3 adapter is one generation's jitAdapter", () => {
    const arb = generationsOf(BUNDLED_DEFAULTS, 42161);
    expect(classifyAddress(arb, "0x66025095Ab3a7E60BA9C2b15e203822d5d3647b5")).toEqual([{ label: "cork/v0.4", status: "active", primary: true, role: "controller" }]);
    expect(classifyAddress(arb, "0x8902a88912a334263fe3d731d03c267715b9374f")).toEqual([{ label: "cork/v0.3", status: "active", primary: false, role: "jitAdapter" }]);
    expect(classifyAddress(arb, "0x983270AE48545665Cee4D7EF61C65fF3fdC8222D")).toEqual([{ label: "arbitrum-v1.1", status: "active", primary: false, role: "exactSettler" }]);
    expect(classifyAddress(arb, "0xc2De56fb1C7a85250ce69C37B4773767C77954AE")).toEqual([{ label: "arbitrum-legacy", status: "read-only", primary: false, role: "poolManager" }]);
    expect(classifyAddress(arb, "0xd5e8F76AafA20aA9A8983A35B71Ad3A793070Ed9")).toEqual([{ label: "cork/v0.4", status: "active", primary: true, role: "recipe", recipeName: "impairment" }]);
  });
});

describe("marketRegistryForWire — the first generation declaring a wire", () => {
  it("finds legacy/flat/nested by wire, undefined when no block speaks it", () => {
    expect(marketRegistryForWire(LIST, "nested")?.label).toBe("new");
    expect(marketRegistryForWire(LIST, "flat")?.label).toBe("mid");
    expect(marketRegistryForWire(LIST, "legacy")?.label).toBe("legacy");
    expect(marketRegistryForWire(generationsOf(BUNDLED_DEFAULTS, 8453), "legacy")).toBeUndefined();
    expect(marketRegistryForWire(generationsOf(BUNDLED_DEFAULTS, 42161), "legacy")?.label).toBe("arbitrum-v1.1");
  });
});

describe("rolloverGenerationsOf — the one rollover flattening", () => {
  it("primary's live block first, other live blocks in resolution order, retired blocks last; each entry carries its wire and chain label", () => {
    expect(rolloverGenerationsOf(LIST).map((g) => [g.label, g.status, g.primary, g.wire, g.seededAtBlock])).toEqual([
      ["new", "active", true, "0.2", 300],
      ["mid", "active", false, "rc.2", 200],
      ["legacy", "retired", false, "rc.1", 100],
    ]);
    // A generation without a rollover block ("old") contributes nothing.
    expect(rolloverGenerationsOf(LIST).some((g) => g.label === "old")).toBe(false);
    // Addresses ride verbatim; the settler domain is copied, never shared by reference.
    const first = rolloverGenerationsOf(LIST)[0]!;
    expect(first.settlerDomain).toEqual({ name: "CorkSettler", version: "1.0.0" });
    expect(first.settlerDomain).not.toBe(LIST[0]!.rollover!.settlerDomain);
  });
});

describe("resolvePoolGeneration — one batched shares(poolId) read across every generation's pool manager", () => {
  /** A client whose `shares` answer depends on the pool manager asked; records the managers asked. */
  const client = (knows: Record<string, [`0x${string}`, `0x${string}`]>, asked: string[] = [], failing: string[] = []): PoolGenerationClient =>
    ({
      readContract: async (args: { address: string; functionName: string; args?: readonly unknown[] }) => {
        asked.push(args.address.toLowerCase());
        expect(args.functionName).toBe("shares");
        expect(args.args?.[0]).toBe(POOL);
        if (failing.includes(args.address.toLowerCase())) throw new Error("execution reverted");
        return knows[args.address.toLowerCase()] ?? [ZERO, ZERO];
      },
    }) as unknown as PoolGenerationClient;

  it("the manager that knows the pool wins, resolution order breaks ties, and every manager is asked in ONE batch", async () => {
    const asked: string[] = [];
    const r = await resolvePoolGeneration(client({ [A(0x60)]: [A(0xc1), A(0xc2)] }, asked), LIST, POOL);
    expect(r.found).toBe(true);
    if (!r.found) return;
    expect(r.generation.label).toBe("mid");
    expect(r.poolManager).toBe(A(0x60));
    expect(r.corkPrincipalToken).toBe(A(0xc1));
    expect(r.corkSwapToken).toBe(A(0xc2));
    // Three managers (new, mid, old — "legacy" has no phoenix block), primary first.
    expect(asked).toEqual([A(0x20), A(0x60), A(0x10)]);
    expect(r.asked.map((a) => a.label)).toEqual(["new", "mid", "old"]);
  });
  it("two managers claiming the pool: the primary wins (resolution order is the tie-break)", async () => {
    const r = await resolvePoolGeneration(client({ [A(0x20)]: [A(0xd1), A(0xd2)], [A(0x60)]: [A(0xc1), A(0xc2)] }), LIST, POOL);
    expect(r.found && r.generation.label).toBe("new");
  });
  it("a zero cST is 'does not know it' (a nonexistent pool never reverts), and a read that THROWS is recorded, not fatal", async () => {
    const r = await resolvePoolGeneration(client({ [A(0x60)]: [A(0xc1), A(0xc2)] }, [], [A(0x20)]), LIST, POOL);
    expect(r.found && r.generation.label).toBe("mid");
    const miss = await resolvePoolGeneration(client({}, [], [A(0x20)]), LIST, POOL);
    expect(miss.found).toBe(false);
    if (miss.found) return;
    expect(miss.code).toBe("pool_not_found");
    expect(miss.message).toContain(`new (${A(0x20)}, read failed: execution reverted)`);
    expect(miss.message).toContain(`mid (${A(0x60)})`);
    expect(miss.asked).toEqual([{ label: "new", poolManager: A(0x20), error: "execution reverted" }, { label: "mid", poolManager: A(0x60) }, { label: "old", poolManager: A(0x10) }]);
  });
  it("a label asks ONLY that generation's manager; a read-only set is askable (reads are allowed there)", async () => {
    const asked: string[] = [];
    const r = await resolvePoolGeneration(client({ [A(0x10)]: [A(0xe1), A(0xe2)], [A(0x20)]: [A(0xd1), A(0xd2)] }, asked), LIST, POOL, "old");
    expect(asked).toEqual([A(0x10)]);
    expect(r.found && r.generation.label).toBe("old");
    const missNamed = await resolvePoolGeneration(client({ [A(0x20)]: [A(0xd1), A(0xd2)] }), LIST, POOL, "mid");
    expect(missNamed).toMatchObject({ found: false, code: "pool_not_found", asked: [{ label: "mid", poolManager: A(0x60) }] });
  });
  it("an unknown label and a generation without a pool manager are typed misses that ask nothing", async () => {
    const asked: string[] = [];
    expect(await resolvePoolGeneration(client({}, asked), LIST, POOL, "nope")).toMatchObject({ found: false, code: "generation_unknown", asked: [] });
    expect(await resolvePoolGeneration(client({}, asked), LIST, POOL, "legacy")).toMatchObject({ found: false, code: "unknown_deployment", asked: [] });
    expect(await resolvePoolGeneration(client({}, asked), [], POOL)).toMatchObject({ found: false, code: "unknown_deployment" });
    expect(asked).toEqual([]);
  });
  it("pins the block when asked", async () => {
    let seen: bigint | undefined;
    const c = { readContract: async (args: { blockNumber?: bigint }) => { seen = args.blockNumber; return [ZERO, ZERO]; } } as unknown as PoolGenerationClient;
    await resolvePoolGeneration(c, LIST.slice(0, 1) as ResolvedGeneration[], POOL, undefined, 123n);
    expect(seen).toBe(123n);
  });
});

// The 0.6.0 labels (`phoenix/v0.4-rc.1`, `phoenix/v0.3-rc.1`) were renamed to the Distribution-bundle
// spelling (`cork/v0.4`, `cork/v0.3`) on 2026-09-25: a label names the BUNDLE, Phoenix is one of its
// components. Inputs keep accepting the old spelling; results carry the new one; the bundle's own
// record name is untouched in `distribution`.

describe("renamed generation labels (phoenix/… → cork/…)", () => {
  const list = generationsOf(BUNDLED_DEFAULTS, 8453);
  it("the map names exactly the two 0.6.0 labels and points at labels that exist on both chains", () => {
    expect(Object.keys(GENERATION_LABEL_RENAMES).sort()).toEqual(["phoenix/v0.3-rc.1", "phoenix/v0.4-rc.1"]);
    for (const chainId of [42161, 8453]) {
      const labels = generationsOf(BUNDLED_DEFAULTS, chainId).map((g) => g.label);
      for (const to of Object.values(GENERATION_LABEL_RENAMES)) expect(labels).toContain(to);
    }
    expect(renamedGenerationLabel("cork/v0.4")).toBeUndefined();
    expect(renamedGenerationLabel(undefined)).toBeUndefined();
  });
  it("the resolver maps an old spelling to today's label and says where it came from", () => {
    const r = resolveGenerationAlias(list, "phoenix/v0.4-rc.1");
    expect(r).toEqual({ ok: true, label: "cork/v0.4", renamedFrom: "phoenix/v0.4-rc.1" });
    const r3 = resolveGenerationAlias(list, "phoenix/v0.3-rc.1", ["phoenix"], "prepare");
    expect(r3.ok && r3.label).toBe("cork/v0.3");
  });
  it("selectGeneration accepts the old spelling for reads AND prepares and returns the renamed set", () => {
    const sel = selectGeneration(list, "phoenix/v0.3-rc.1", "prepare", ["phoenix"]);
    expect(sel.ok && sel.generation.label).toBe("cork/v0.3");
    expect(sel.ok && sel.generation.distribution).toBe("phoenix/v0.3-rc.1"); // the bundle's record name stays
  });
  it("the primary carries the bundle's record name under `distribution`, distinct from its label", () => {
    const primary = list.find((g) => g.primary)!;
    expect(primary.label).toBe("cork/v0.4");
    expect(primary.distribution).toBe("phoenix/v0.4-rc.1");
  });
});
