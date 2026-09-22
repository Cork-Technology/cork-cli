// Generations — a chain hosts a SET of contract generations; one is primary (cork-cli 0.6 design
// contract, 2026-09-22; owner ruling: v0.5.1 is the last release of the previous generation and
// the 0.6 line adds the Distribution phoenix/v0.4-rc.1 set while KEEPING every older set
// readable, decodable and — where the chain still fills — preparable. Nothing here retires an
// address).
//
// A GENERATION is the set of contracts that were deployed to work together plus the wire shapes
// they speak: an optional `phoenix` block (pool manager stack), an optional `marketRegistry`
// block (registry + JIT adapter + creator + recipes), an optional `rollover` block (factory +
// two settlers) and an optional `forSelf` block. Each block DECLARES its wire (`8-field` |
// `10-field`, `legacy` | `flat` | `nested`, `rc.2` | `0.2`) — the config declares, the code
// implements; a codec that does not know a declared wire refuses rather than guessing. Per chain
// the config records `{ primary: <label>, sets: { <label>: generation } }`; labels are the
// Distribution names where one exists (`phoenix/v0.4-rc.1`) and our own for the eras before the
// Distribution existed (`arbitrum-v1.1`, `mainnet`).
//
// Why a set and not a flat "current + historical" list (the PR #17 shape this supersedes): the
// three registry generations and the two phoenix identity generations were decided by DIFFERENT
// mechanisms there (a config array with a literal tag vs a chain-blind address list, defaulting
// unknown managers to the newest wire), and four string vocabularies described the same fact.
// Here ONE record answers every question — which set is primary, which sets are preparable,
// which address belongs to which set in which role, and which wire each block speaks.
//
// Statuses: `active` = readable AND preparable (an explicit `generation` label is needed when it
// is not the primary); `read-only` = reads, decode, attribution and classification only — a
// prepare refuses `generation_read_only`. The rollover sub-block keeps its own `retired` date
// because venue admission is a rollover fact, not a phoenix fact.
//
// Everything in this module is PURE except `resolvePoolGeneration`, which issues one batched
// `shares(poolId)` read per generation pool manager — the mechanism pool-scoped reads use to
// find the generation a poolId lives on (stage 3 wires the handlers to it).
import { z } from "zod";
import { Address } from "@cork/schemas";
import type { PublicClient } from "viem";
import { poolManagerAbi } from "./chain/abis.ts";

// ── Wire vocabularies (code enums) ──────────────────────────────────────────────────────────────

/** Phoenix `Market` width: 8 fields (poolId = keccak(abi.encode(8)), fees outside the id,
 *  fee cap 5%) or 10 fields (fees inside the Market AND the id, `MarketCreated` gains two args,
 *  fee < 100%). */
export const PHOENIX_WIRES = ["8-field", "10-field"] as const;
export type PhoenixWire = (typeof PHOENIX_WIRES)[number];

/** MarketRegistry generation wire: `legacy` (pre-2.1.0 mode strings, behind the deprecation
 *  gate), `flat` (0.3.x: flat JITMarketParams + additionalData, verify(5), deploy(3)), `nested`
 *  (0.5.x: (MarketParams, enableJitMint) + permits, extraData + oracleSalt, verify(7), deploy(4)). */
export const MARKET_REGISTRY_WIRES = ["legacy", "flat", "nested"] as const;
export type MarketRegistryWire = (typeof MARKET_REGISTRY_WIRES)[number];

/** Rollover wire: `rc.1` (the July 2026 v0.1.0-rc.1 set — OrderData 832 bytes, no jitMarketHash;
 *  RETIRED 2026-08-13, kept so a retired settler is named precisely, never encoded for), `rc.2`
 *  (RolloverParams.jitMarketHash, 864 bytes; JITMarketParams without oracleSalt) or `0.2`
 *  (bytes32 oracleSalt after additionalData — the JITMarketParams typehash changes).
 *  OrderData/RolloverParams are identical in rc.2 and 0.2. The design contract names only rc.2
 *  and 0.2; rc.1 is added so the retired block does not have to DECLARE a wire it never spoke —
 *  a config claiming a wire the contract does not implement is the exact class this model
 *  exists to remove. */
export const ROLLOVER_WIRES = ["rc.1", "rc.2", "0.2"] as const;
export type RolloverWire = (typeof ROLLOVER_WIRES)[number];

export const GENERATION_STATUSES = ["active", "read-only"] as const;
export type GenerationStatus = (typeof GENERATION_STATUSES)[number];

/** A generation label: a Distribution name (`phoenix/v0.4-rc.1`) or one of ours (`mainnet`). */
export type GenerationLabel = string;

// ── Schemas (the v2 config document's per-generation blocks) ────────────────────────────────────

/** Phoenix stack: the two read-path contracts are required (enough for query/compute/track);
 *  the tx-path contracts, the whitelist manager and the controller are optional because not
 *  every era's deployment is fully known — handlers gate per capability (`unknown_deployment`). */
export const PhoenixBlockSchema = z
  .object({
    poolManager: Address,
    constraintAdapter: Address,
    corkAdapter: Address.optional(),
    bundler3: Address.optional(),
    whitelistManager: Address.optional(),
    controller: Address.optional(),
    contractsVersion: z.string().optional(),
    wire: z.enum(PHOENIX_WIRES),
  })
  .strip();
export type PhoenixBlock = z.infer<typeof PhoenixBlockSchema>;

/** MarketRegistry stack. `recipes` are NAMED HINTS for the deprecated mode sugar only — recipe
 *  membership is decided solely by `isRecipe` on chain. `oracleFactory` exists only on the
 *  legacy wire (pair oracles without a mode); `marketCreator` is optional (an older config
 *  without it gates the create-pool prepare). */
export const MarketRegistryBlockSchema = z
  .object({
    registry: Address,
    adapter: Address.optional(),
    marketCreator: Address.optional(),
    controller: Address.optional(),
    oracleFactory: Address.optional(),
    wrapperFactory: Address.optional(),
    fixedRateOracleFactory: Address.optional(),
    aggregatorAdapterFactory: Address.optional(),
    recipes: z.record(z.string(), Address).optional(),
    owner: Address.optional(),
    contractsVersion: z.string().optional(),
    deployedAtBlock: z.number().int().nonnegative().optional(),
    wire: z.enum(MARKET_REGISTRY_WIRES),
  })
  .strip();
export type MarketRegistryBlock = z.infer<typeof MarketRegistryBlockSchema>;

/** Rollover venue contracts: the factory that self-deploys per-user clones and the two ERC-7683
 *  settlers. `settlerDomain` is the EIP-712 domain OrderData is signed under (verifyingContract
 *  = the settler). `seededAtBlock` = the generation's earliest deployment — the backfill start
 *  for event reconstruction. `retired` = the ISO date the generation stopped being venue-
 *  admissible (a wire-format release retires a whole generation at once: rc.2's jitMarketHash
 *  typehash change, 2026-08-13). */
export const RolloverBlockSchema = z
  .object({
    factory: Address,
    exactSettler: Address,
    partialSettler: Address,
    settlerDomain: z.object({ name: z.string(), version: z.string() }).strip(),
    seededAtBlock: z.number().int().nonnegative(),
    retired: z.string().optional(),
    contractsVersion: z.string().optional(),
    wire: z.enum(ROLLOVER_WIRES),
  })
  .strip();
export type RolloverBlock = z.infer<typeof RolloverBlockSchema>;

/** Cork's reference ForSelf adapter (cork-periphery) for this generation's pool manager. */
export const ForSelfBlockSchema = z
  .object({
    adapter: Address,
    contractsVersion: z.string().optional(),
  })
  .strip();
export type ForSelfBlock = z.infer<typeof ForSelfBlockSchema>;

export const GenerationSchema = z
  .object({
    status: z.enum(GENERATION_STATUSES),
    /** The Distribution cut this set was published under, when one exists. */
    distribution: z.string().optional(),
    phoenix: PhoenixBlockSchema.optional(),
    marketRegistry: MarketRegistryBlockSchema.optional(),
    rollover: RolloverBlockSchema.optional(),
    forSelf: ForSelfBlockSchema.optional(),
  })
  .strip();
export type Generation = z.infer<typeof GenerationSchema>;

/** One chain's generations: the primary label must name one of the sets, and the primary must
 *  be `active` — a read-only primary would make every default prepare refuse. */
export const ChainGenerationsSchema = z
  .object({
    primary: z.string(),
    sets: z.record(z.string(), GenerationSchema),
  })
  .strip()
  .superRefine((chain, ctx) => {
    const primary = chain.sets[chain.primary];
    if (primary === undefined) {
      ctx.addIssue({ code: "custom", path: ["primary"], message: `primary '${chain.primary}' names no set (sets: ${Object.keys(chain.sets).join(", ")})` });
    } else if (primary.status !== "active") {
      ctx.addIssue({ code: "custom", path: ["primary"], message: `primary '${chain.primary}' is ${primary.status}; the primary generation must be active` });
    }
  });
export type ChainGenerations = z.infer<typeof ChainGenerationsSchema>;

/** A generation as consumers see it: the record plus its label and whether it is the primary. */
export interface ResolvedGeneration extends Generation {
  label: GenerationLabel;
  primary: boolean;
}

/** The compact reference every resolver result carries beside its block. */
export interface GenerationRef {
  label: GenerationLabel;
  status: GenerationStatus;
  distribution?: string;
}

// ── Pure functions ──────────────────────────────────────────────────────────────────────────────

/** The chain's generations in RESOLUTION ORDER: the primary first, then the other active sets in
 *  config order, then the read-only sets in config order. Every consumer that walks "all
 *  generations" reads this one ordering (classification, pool resolution, emitters, scans), so a
 *  tie between two sets is always broken the same way — in favour of the set a prepare targets. */
export function generationsOf(defaults: { generations?: Record<string, ChainGenerations> | undefined }, chainId: number): ResolvedGeneration[] {
  const chain = defaults.generations?.[String(chainId)];
  if (!chain) return [];
  const entries = Object.entries(chain.sets).map(([label, g]): ResolvedGeneration => ({ ...g, label, primary: label === chain.primary }));
  const primary = entries.filter((g) => g.primary);
  const active = entries.filter((g) => !g.primary && g.status === "active");
  const readOnly = entries.filter((g) => !g.primary && g.status !== "active");
  return [...primary, ...active, ...readOnly];
}

/** The primary generation of an ordered list (undefined for a chain with no generations). */
export function primaryOf(list: readonly ResolvedGeneration[]): ResolvedGeneration | undefined {
  return list.find((g) => g.primary);
}

export type GenerationRefusalCode = "generation_unknown" | "generation_read_only" | "unknown_deployment";

export interface GenerationRefusal {
  code: GenerationRefusalCode;
  message: string;
}

export type GenerationSelection = { ok: true; generation: ResolvedGeneration } | { ok: false; refusal: GenerationRefusal };

/** Select the generation a call targets: the primary when no label is given, the named set
 *  otherwise. `purpose: "prepare"` additionally refuses a read-only set — its contracts are kept
 *  for reads, decode and attribution, never for new bytes. The refusal is TYPED so a handler can
 *  route it into its envelope (`generation_unknown` lists the labels the chain knows). */
export function selectGeneration(list: readonly ResolvedGeneration[], label?: GenerationLabel, purpose: "read" | "prepare" = "read"): GenerationSelection {
  if (list.length === 0) {
    return { ok: false, refusal: { code: "unknown_deployment", message: "no generation is configured for this chain" } };
  }
  const generation = label === undefined ? primaryOf(list) : list.find((g) => g.label === label);
  if (generation === undefined) {
    return {
      ok: false,
      refusal: {
        code: "generation_unknown",
        message: `generation '${label}' is not configured on this chain — known generations: ${list.map((g) => `${g.label} (${g.status}${g.primary ? ", primary" : ""})`).join(", ")}; omit \`generation\` to target the primary`,
      },
    };
  }
  if (purpose === "prepare" && generation.status !== "active") {
    return {
      ok: false,
      refusal: {
        code: "generation_read_only",
        message: `generation '${generation.label}' is read-only: its contracts are kept for reads, decode and attribution, but no new bytes are built against them — target the primary (${primaryOf(list)?.label ?? "none"}) or another active generation`,
      },
    };
  }
  return { ok: true, generation };
}

/** The roles an address can hold inside a generation. `bundler3` is deliberately absent — it is
 *  Morpho infrastructure the adapter binds to, not a Cork generation contract. */
export const GENERATION_ROLES = [
  "poolManager",
  "constraintAdapter",
  "corkAdapter",
  "whitelistManager",
  "controller",
  "registry",
  "jitAdapter",
  "marketCreator",
  "factory",
  "exactSettler",
  "partialSettler",
  "forSelfAdapter",
  "recipe",
] as const;
export type GenerationRole = (typeof GENERATION_ROLES)[number];

export interface AddressClassification {
  label: GenerationLabel;
  status: GenerationStatus;
  primary: boolean;
  role: GenerationRole;
  /** For `recipe`: the config's hint name (liquidity | nav | fixed | impairment). */
  recipeName?: string;
}

/** Every role an address holds, in every generation of the list (resolution order). ONE function
 *  for every address-scoped question — decode labels, event attribution, settler classification,
 *  the book's row verification, `unknown_target` — so a contract that two generations share (the
 *  phoenix controller the registry block also names) is reported once per generation per role. */
export function classifyAddress(list: readonly ResolvedGeneration[], address: string): AddressClassification[] {
  const lc = address.toLowerCase();
  const out: AddressClassification[] = [];
  for (const g of list) {
    const seen = new Set<string>();
    const hit = (role: GenerationRole, candidate: string | undefined, recipeName?: string) => {
      if (candidate === undefined || candidate.toLowerCase() !== lc) return;
      const key = recipeName === undefined ? role : `${role}:${recipeName}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ label: g.label, status: g.status, primary: g.primary, role, ...(recipeName !== undefined ? { recipeName } : {}) });
    };
    hit("poolManager", g.phoenix?.poolManager);
    hit("constraintAdapter", g.phoenix?.constraintAdapter);
    hit("corkAdapter", g.phoenix?.corkAdapter);
    hit("whitelistManager", g.phoenix?.whitelistManager);
    hit("controller", g.phoenix?.controller);
    hit("registry", g.marketRegistry?.registry);
    hit("jitAdapter", g.marketRegistry?.adapter);
    hit("marketCreator", g.marketRegistry?.marketCreator);
    hit("controller", g.marketRegistry?.controller);
    for (const [name, recipe] of Object.entries(g.marketRegistry?.recipes ?? {})) hit("recipe", recipe, name);
    hit("factory", g.rollover?.factory);
    hit("exactSettler", g.rollover?.exactSettler);
    hit("partialSettler", g.rollover?.partialSettler);
    hit("forSelfAdapter", g.forSelf?.adapter);
  }
  return out;
}

/** The market-registry wires this build's codecs IMPLEMENT (the config declares wires; this is
 *  the code's half of that contract): `flat` (0.3.x) and, since stage 2a, `nested` (0.5.x —
 *  (MarketParams, enableJitMint) + permits, extraData + oracleSalt, verify(7), deploy(4), the
 *  10-field derivation; market-registry.ts `WIRES`). With both implemented, every registry-bound
 *  path (JIT ladder, registry-* reads, derive-cork-pool, create-pool, deploy-oracle) binds the
 *  PRIMARY generation again and the codec follows that generation's declared wire; a named
 *  generation on a wire outside this list refuses phase_gated rather than emitting bytes its
 *  adapter would misread. The legacy wire is served by its own deprecated lane (`legacy:true`),
 *  never listed here. */
export const IMPLEMENTED_MARKET_REGISTRY_WIRES: readonly MarketRegistryWire[] = ["flat", "nested"];

/** The first generation (resolution order) whose marketRegistry block speaks `wire`. The
 *  deprecation-gated legacy lane is "the generation whose marketRegistry.wire is legacy" — there
 *  is no separate legacy config block any more; and a codec that implements ONE wire binds to the
 *  generation declaring it rather than to whichever set happens to be primary. */
export function marketRegistryForWire(list: readonly ResolvedGeneration[], wire: MarketRegistryWire): ResolvedGeneration | undefined {
  return list.find((g) => g.marketRegistry?.wire === wire);
}

// ── Rollover flattening ─────────────────────────────────────────────────────────────────────────

/** One rollover generation as every rollover consumer reads it (rollover.ts re-exports the
 *  interface under its historical name; classification, scan scoping, emitter attribution and
 *  decode labels all read this list). */
export interface RolloverGenerationEntry {
  factory: `0x${string}`;
  exactSettler: `0x${string}`;
  partialSettler: `0x${string}`;
  settlerDomain: { name: string; version: string };
  seededAtBlock: number;
  retired?: string | undefined;
  contractsVersion?: string | undefined;
  wire: RolloverWire;
  /** The chain generation's label — the one vocabulary for "which set". */
  label: GenerationLabel;
  /** `retired` = the block carries a retired date (venue-inadmissible, wire-incompatible). */
  status: "active" | "retired";
  /** Exactly one per chain when any active rollover exists: the primary generation's block, or
   *  — when the primary generation has no live rollover — the first live one in resolution order. */
  primary: boolean;
}

/** The ONE rollover flattening: the primary generation's live rollover first, then the other
 *  live rollover blocks in resolution order, then the retired ones in resolution order. Same
 *  shape and ordering contract as the pre-0.6 `rolloverGenerations(dep)` (primary → active →
 *  retired), now derived from the chain's generations instead of three config lists. */
export function rolloverGenerationsOf(list: readonly ResolvedGeneration[]): RolloverGenerationEntry[] {
  const entry = (g: ResolvedGeneration, r: RolloverBlock, status: "active" | "retired", primary: boolean): RolloverGenerationEntry => ({
    factory: r.factory as `0x${string}`,
    exactSettler: r.exactSettler as `0x${string}`,
    partialSettler: r.partialSettler as `0x${string}`,
    settlerDomain: { name: r.settlerDomain.name, version: r.settlerDomain.version },
    seededAtBlock: r.seededAtBlock,
    ...(r.retired !== undefined ? { retired: r.retired } : {}),
    ...(r.contractsVersion !== undefined ? { contractsVersion: r.contractsVersion } : {}),
    wire: r.wire,
    label: g.label,
    status,
    primary,
  });
  const live = list.filter((g) => g.rollover !== undefined && g.rollover.retired === undefined);
  const retired = list.filter((g) => g.rollover !== undefined && g.rollover.retired !== undefined);
  // `list` is already primary-first, so the first live block belongs to the primary generation
  // whenever it has one; the flag lands on that entry and nowhere else.
  return [
    ...live.map((g, i) => entry(g, g.rollover!, "active", i === 0)),
    ...retired.map((g) => entry(g, g.rollover!, "retired", false)),
  ];
}

// ── Pool-scoped generation resolution (one batched chain read) ──────────────────────────────────

/** The minimal client surface: the same `readContract` every chain read uses. viem batches the
 *  parallel reads into one multicall3 request on a known chain, so this costs one round trip. */
export type PoolGenerationClient = Pick<PublicClient, "readContract">;

export type PoolGenerationResolution =
  | {
      found: true;
      generation: ResolvedGeneration;
      poolManager: `0x${string}`;
      corkPrincipalToken: `0x${string}`;
      corkSwapToken: `0x${string}`;
      asked: Array<{ label: GenerationLabel; poolManager: `0x${string}` }>;
    }
  | {
      found: false;
      code: "pool_not_found" | "generation_unknown" | "unknown_deployment";
      message: string;
      asked: Array<{ label: GenerationLabel; poolManager: `0x${string}`; error?: string }>;
    };

const ZERO = "0x0000000000000000000000000000000000000000";

/** Which generation a pool lives on: one batched `shares(poolId)` read across every generation's
 *  pool manager (a nonexistent pool does NOT revert — `shares` returns two zero addresses, the
 *  same predicate `poolMissing` uses); the first manager (resolution order) returning a non-zero
 *  cST wins. `label` given → only that generation's manager is asked. None knows the pool → a
 *  typed miss naming every manager asked, so the caller can say exactly where it looked. A read
 *  that throws counts as "does not know it" and is recorded on its entry. */
export async function resolvePoolGeneration(
  client: PoolGenerationClient,
  list: readonly ResolvedGeneration[],
  poolId: `0x${string}`,
  label?: GenerationLabel,
  atBlock?: bigint,
): Promise<PoolGenerationResolution> {
  let candidates: ResolvedGeneration[];
  if (label !== undefined) {
    const sel = selectGeneration(list, label);
    if (!sel.ok) return { found: false, code: sel.refusal.code === "generation_unknown" ? "generation_unknown" : "unknown_deployment", message: sel.refusal.message, asked: [] };
    candidates = [sel.generation];
  } else {
    candidates = [...list];
  }
  const withPm = candidates.filter((g) => g.phoenix !== undefined);
  if (withPm.length === 0) {
    return { found: false, code: "unknown_deployment", message: label === undefined ? "no generation on this chain has a phoenix pool manager" : `generation '${label}' has no phoenix pool manager`, asked: [] };
  }
  const blockArg = atBlock !== undefined ? { blockNumber: atBlock } : {};
  const reads = await Promise.all(
    withPm.map(async (g) => {
      const poolManager = g.phoenix!.poolManager as `0x${string}`;
      try {
        const shares = await client.readContract({ address: poolManager, abi: poolManagerAbi, functionName: "shares", args: [poolId], ...blockArg });
        return { g, poolManager, shares: shares as readonly [`0x${string}`, `0x${string}`], error: undefined };
      } catch (err) {
        return { g, poolManager, shares: undefined, error: err instanceof Error ? (err.message.split("\n")[0] ?? String(err)) : String(err) };
      }
    }),
  );
  const asked = reads.map((r) => ({ label: r.g.label, poolManager: r.poolManager, ...(r.error !== undefined ? { error: r.error } : {}) }));
  for (const r of reads) {
    if (r.shares !== undefined && r.shares[1].toLowerCase() !== ZERO) {
      return { found: true, generation: r.g, poolManager: r.poolManager, corkPrincipalToken: r.shares[0], corkSwapToken: r.shares[1], asked: asked.map(({ label: l, poolManager }) => ({ label: l, poolManager })) };
    }
  }
  return {
    found: false,
    code: "pool_not_found",
    message: `pool ${poolId} is unknown to every pool manager asked: ${asked.map((a) => `${a.label} (${a.poolManager}${a.error ? `, read failed: ${a.error}` : ""})`).join(", ")}`,
    asked,
  };
}
