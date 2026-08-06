// Split from handlers.ts (2026-08-05): registry handlers — one typed dispatch, per-tool modules.
// Declarations are moved byte-identically; see handlers.ts for the runTool dispatch.
import { type ChainId, Envelope, QueryInput } from "@cork/schemas";
import { type ResolvedRpc } from "../chain/rpc.ts";
import { rateOracleAbi } from "../chain/abis.ts";
import { aggregatorV3Abi, ASSET_KIND, buildDeployFixedRateOracleCall, buildDeployOracleCall, constantGetterAbi, DENOMINATION_PSEUDO_UNITS, deriveJitMarket, erc20MetadataAbi, jitAdapterAbi, marketRegistryAbi, ORACLE_MODE, type OracleModeName, predictShares, type PredictSharesResult, RECIPE_CATALOG, RECIPE_SOURCE, recipeAbi, type RecipeSourceName, type ResolvedConstraint, SOURCE_INTERFACE, SOURCE_TYPE } from "../market-registry.ts";
import * as legacyRegistry from "../market-registry-legacy.ts";
import { deprecatedEnabled, deprecatedGateMessage } from "../deprecation.ts";
import { resolveMarketRegistry, resolveMarketRegistryLegacy } from "../config-remote.ts";
import { chainReadFailed, envelope, getDep, getRpc, type HandlerContext, localComputeFailed, nowSecondsOf, revertReason, rpcProvenance, rpcWarn, unavailable, ZERO_ADDR } from "./shared.ts";
import { type QueryFilters } from "./filters.ts";


/** Resolve the MarketRegistry stack + an RPC for registry-backed calls, or an honest gate. */
export async function getRegistry(ctx: HandlerContext, chainId: ChainId): Promise<
  | { gate: Envelope }
  | { gate?: undefined; mr: NonNullable<Awaited<ReturnType<typeof resolveMarketRegistry>>["marketRegistry"]>; resolved: ResolvedRpc; warnings: Array<{ code: string; message: string }> }
> {
  const { marketRegistry: mr, warning } = await resolveMarketRegistry(chainId);
  if (!mr) {
    return { gate: unavailable(chainId, "unknown_deployment", `no MarketRegistry configured for chainId ${chainId} — the registry stack is live on Arbitrum One (42161)`, ctx) };
  }
  const resolved = await getRpc(ctx, chainId);
  if (!resolved) {
    return { gate: unavailable(chainId, "requires_rpc", `MarketRegistry reads need an RPC endpoint for chainId ${chainId} (none resolved — set CORK_RPC_URL)`, ctx) };
  }
  // CONFIG warnings only — rpcWarn is deliberately NOT baked in here: the client fails over
  // in-call (mutating `resolved`), so consumers prepend rpcWarn(resolved) at ENVELOPE
  // construction, after their reads have run.
  return { mr, resolved, warnings: warning ? [warning] : [] };
}

/** Best-effort 2.1.0 generation guard, cached per (chainId, adapter) for the process: the ONE
 *  check that rules out the previous-generation hazard (an old registry ANSWERS 2.1.0-shaped
 *  calls with misdecoded garbage) is the adapter's MARKET_REGISTRY() immutable matching the
 *  configured registry (INTEGRATOR.md). Returns a conflict warning on mismatch; silence when
 *  the adapter is unconfigured or the read fails (the prepare paths re-check hard). */
const bindingGuardCache = new Map<string, boolean>();
/** Test hook: clear the per-process binding-guard memo (mirrors resetConfigMemo). */
export function resetRegistryBindingGuardCache(): void {
  bindingGuardCache.clear();
}
async function registryBindingMismatch(client: ResolvedRpc["client"], chainId: ChainId, mr: { registry: `0x${string}`; adapter?: `0x${string}` | undefined }): Promise<{ code: string; message: string } | undefined> {
  if (!mr.adapter) return undefined;
  const key = `${chainId}:${mr.adapter.toLowerCase()}:${mr.registry.toLowerCase()}`;
  const cached = bindingGuardCache.get(key);
  if (cached === true) return undefined;
  if (cached === undefined) {
    try {
      const bound = (await client.readContract({ address: mr.adapter, abi: jitAdapterAbi, functionName: "MARKET_REGISTRY" })) as `0x${string}`;
      bindingGuardCache.set(key, bound.toLowerCase() === mr.registry.toLowerCase());
    } catch {
      return undefined; // disclosed-by-omission: reads proceed; prepares re-check hard
    }
  }
  if (bindingGuardCache.get(key) === false) {
    return { code: "adapter_binding_mismatch", message: `the configured adapter's on-chain MARKET_REGISTRY() does not match the configured registry ${mr.registry} — one of them is a stale/previous-generation address (the old registry answers 2.1.0 calls with misdecoded garbage). Refresh cork-defaults.json; do not trust these reads` }; // conflict-grade
  }
  return undefined;
}

/** Shape an on-chain AssetSource into the API-parity object (absent slot ⇒ null). */
function shapeAssetSource(s: { addr: `0x${string}`; sourceType: number; sourceInterface: number; denomination: string }): Record<string, unknown> | null {
  if (s.addr === ZERO_ADDR) return null;
  return { address: s.addr, sourceType: SOURCE_TYPE[s.sourceType] ?? s.sourceType, sourceInterface: SOURCE_INTERFACE[s.sourceInterface] ?? s.sourceInterface, denomination: s.denomination };
}

type RegistryClient = ResolvedRpc["client"];

/** Best-effort ERC-20 self-description (symbol/name/decimals) — null when the token won't say. */
async function tokenMeta(client: RegistryClient, addr: `0x${string}`): Promise<{ decimals: number; symbol: string; name: string } | null> {
  try {
    const [decimals, symbol, name] = await Promise.all([
      client.readContract({ address: addr, abi: erc20MetadataAbi, functionName: "decimals" }),
      client.readContract({ address: addr, abi: erc20MetadataAbi, functionName: "symbol" }),
      client.readContract({ address: addr, abi: erc20MetadataAbi, functionName: "name" }),
    ]);
    return { decimals: Number(decimals), symbol: symbol as string, name: name as string };
  } catch {
    return null;
  }
}

/** One recipe's live self-description: source()/description()/REGISTRY() + catalogued constants
 *  (values always read live; a constant the contract no longer answers is silently dropped,
 *  matching the read API). Catalog absence is not a gate — argsKnown:false, still resolvable. */
async function readRecipeMeta(client: RegistryClient, recipe: `0x${string}`, configuredRegistry: `0x${string}`): Promise<Record<string, unknown>> {
  const r = { address: recipe, abi: recipeAbi } as const;
  const [source, description, boundRegistry] = await Promise.all([
    client.readContract({ ...r, functionName: "source" }),
    client.readContract({ ...r, functionName: "description" }).catch(() => null),
    client.readContract({ ...r, functionName: "REGISTRY" }).catch(() => null),
  ]);
  const catalog = RECIPE_CATALOG[recipe.toLowerCase()];
  const constants: Record<string, string> = {};
  if (catalog) {
    await Promise.all(
      catalog.constants.map(async (name) => {
        try {
          const v = (await client.readContract({ address: recipe, abi: constantGetterAbi(name), functionName: name })) as unknown as bigint;
          constants[name] = v.toString();
        } catch {
          /* dropped: the contract no longer answers this getter */
        }
      }),
    );
  }
  return {
    address: recipe,
    source: RECIPE_SOURCE[source as number] ?? source,
    description,
    constants,
    registry: boundRegistry,
    registryMatches: boundRegistry !== null && String(boundRegistry).toLowerCase() === configuredRegistry.toLowerCase(),
    argsKnown: Boolean(catalog),
    args: catalog?.args ?? null,
  };
}

/** MarketRegistry chain views (contracts 2.1.0): approved assets (two named source slots),
 *  recipes-as-contracts (self-described, live constants), denominations, conversion feeds, and
 *  mode-keyed / fixed-rate oracle status. filters.legacy routes to the DEPRECATED pre-2.1.0
 *  generation behind the deprecation gate. */
export async function handleQueryRegistry(input: QueryInput, filters: QueryFilters, chainId: ChainId, ctx: HandlerContext): Promise<Envelope> {
  if (filters.legacy) return handleQueryRegistryLegacy(input, filters, chainId, ctx);
  const r = await getRegistry(ctx, chainId);
  if (r.gate) return r.gate;
  const { mr, resolved, warnings } = r;
  const client = resolved.client;
  const rpc = () => rpcProvenance(input.format, resolved);
  const reg = { address: mr.registry, abi: marketRegistryAbi } as const;
  const version = mr.contractsVersion ? { contractsVersion: mr.contractsVersion } : {};
  try {
    const bindingWarn = await registryBindingMismatch(client, chainId, mr);
    if (bindingWarn) {
      return envelope({ state: "conflict", data: { resource: input.resource, chainId, registry: mr.registry, adapter: mr.adapter }, chainId, source: "chain", warnings: [...rpcWarn(resolved), ...warnings, bindingWarn], ...rpc(), ctx });
    }
    if (input.resource === "registry-assets") {
      // filters.address → single lookup by natural key (an address keys exactly one asset per chain).
      if (filters.address) {
        const [found, entry] = await client.readContract({ ...reg, functionName: "lookupAssetByAddress", args: [filters.address] });
        if (!found) return unavailable(chainId, "asset_not_found", `address ${filters.address} is not a registry-approved asset on chainId ${chainId} — list them with cork_query resource:"registry-assets" (no filters)`, ctx);
        const item = { address: entry.addr, name: entry.name, kind: ASSET_KIND[entry.kind] ?? entry.kind, priceSource: shapeAssetSource(entry.priceSource), navSource: shapeAssetSource(entry.navSource), token: await tokenMeta(client, entry.addr) };
        return envelope({ state: "ok", data: { resource: input.resource, chainId, registry: mr.registry, ...version, count: 1, items: [item] }, chainId, source: "chain", warnings: [...rpcWarn(resolved), ...warnings], ...rpc(), ctx });
      }
      const [page, total] = await client.readContract({ ...reg, functionName: "getAssets", args: [0n, 500n] });
      if (total > BigInt(page.length)) {
        warnings.push({ code: "pagination_incomplete", message: `registry reports ${total} assets but this read returns the first ${page.length} — items are partial evidence` });
      }
      const items = await Promise.all(
        page.map(async (a) => ({ address: a.addr, name: a.name, kind: ASSET_KIND[a.kind] ?? a.kind, priceSource: shapeAssetSource(a.priceSource), navSource: shapeAssetSource(a.navSource), token: await tokenMeta(client, a.addr) })),
      );
      return envelope({ state: "ok", data: { resource: input.resource, chainId, registry: mr.registry, ...version, count: items.length, total, items }, chainId, source: "chain", warnings: [...rpcWarn(resolved), ...warnings], ...rpc(), ctx });
    }
    if (input.resource === "registry-recipes") {
      // A recipe is an approved CONTRACT ADDRESS in 2.1.0 — no modes, no stored bands, no
      // applyBands. filters.recipe → single lookup; filters.mode survives as DEPRECATED sugar
      // over the config's named-recipe hints.
      let single: `0x${string}` | undefined = filters.recipe;
      if (!single && filters.mode !== undefined) {
        const hinted = mr.recipes?.[filters.mode];
        if (!hinted) {
          return unavailable(chainId, "recipe_not_found", `recipe mode '${filters.mode}' has no configured 2.1.0 recipe hint — recipes are CONTRACT ADDRESSES now (filters.recipe); known mode hints: ${Object.keys(mr.recipes ?? {}).join(", ") || "none"}`, ctx);
        }
        warnings.push({ code: "deprecation_notice", message: `filters.mode is deprecated sugar: '${filters.mode}' resolved to recipe ${hinted} via this tool's config hints. Recipes are contract addresses in 2.1.0 — pass filters.recipe; mode will be removed in a later release` });
        single = hinted;
      }
      if (single) {
        const isRecipe = await client.readContract({ ...reg, functionName: "isRecipe", args: [single] });
        if (!isRecipe) return unavailable(chainId, "recipe_not_found", `${single} is not an approved recipe on this registry (isRecipe is the only membership gate) — list them with cork_query resource:"registry-recipes"`, ctx);
        const item = await readRecipeMeta(client, single, mr.registry);
        return envelope({ state: "ok", data: { resource: input.resource, chainId, registry: mr.registry, ...version, scale: "constants ending _PERCENTAGE are 1e18 = 1%; RATE_MIN-style constants are ABSOLUTE rates, 1e18 = 1.0; read each value's own name", count: 1, items: [item] }, chainId, source: "chain", warnings: [...rpcWarn(resolved), ...warnings], ...rpc(), ctx });
      }
      const [page, total] = await client.readContract({ ...reg, functionName: "getRecipes", args: [0n, 100n] });
      if (total > BigInt(page.length)) {
        warnings.push({ code: "pagination_incomplete", message: `registry reports ${total} recipes but this read returns the first ${page.length} — items are partial evidence; a recipe absent here may still exist` });
      }
      const items = await Promise.all(page.map((addr) => readRecipeMeta(client, addr, mr.registry)));
      return envelope({ state: "ok", data: { resource: input.resource, chainId, registry: mr.registry, ...version, scale: "constants ending _PERCENTAGE are 1e18 = 1%; RATE_MIN-style constants are ABSOLUTE rates, 1e18 = 1.0; read each value's own name", count: items.length, total, items }, chainId, source: "chain", warnings: [...rpcWarn(resolved), ...warnings], ...rpc(), ctx });
    }
    if (input.resource === "registry-denominations") {
      // The registry stores the label HASH; display text comes from the unit's own symbol()
      // (fiat/native pseudo-units from a fixed table). labelHash is the identity, label display.
      if (filters.label !== undefined) {
        const [found, unit] = await client.readContract({ ...reg, functionName: "lookupDenomination", args: [filters.label] });
        if (!found) return unavailable(chainId, "denomination_not_found", `denomination '${filters.label}' is not registered on chainId ${chainId} — labels are EXACT BYTES and case-sensitive ('USD' and 'usd' are different denominations); list them with cork_query resource:"registry-denominations"`, ctx);
        return envelope({ state: "ok", data: { resource: input.resource, chainId, registry: mr.registry, ...version, count: 1, items: [{ label: filters.label, unit }] }, chainId, source: "chain", warnings: [...rpcWarn(resolved), ...warnings], ...rpc(), ctx });
      }
      const [page, total] = await client.readContract({ ...reg, functionName: "getDenominations", args: [0n, 500n] });
      if (total > BigInt(page.length)) {
        warnings.push({ code: "pagination_incomplete", message: `registry reports ${total} denominations but this read returns the first ${page.length}` });
      }
      const items = await Promise.all(
        page.map(async (d) => {
          const pseudo = DENOMINATION_PSEUDO_UNITS[d.unit.toLowerCase()];
          const label = pseudo ?? (await tokenMeta(client, d.unit))?.symbol ?? null;
          return { labelHash: d.labelHash, unit: d.unit, label, labelSource: pseudo ? "pseudo-unit table" : label ? "unit symbol() — display only; labelHash is the identity" : null };
        }),
      );
      return envelope({ state: "ok", data: { resource: input.resource, chainId, registry: mr.registry, ...version, count: items.length, total, items }, chainId, source: "chain", warnings: [...rpcWarn(resolved), ...warnings], ...rpc(), ctx });
    }
    if (input.resource === "registry-feeds") {
      // A feed is ONE DIRECTED edge of the graph proving an asset reaches US dollars — base→quote
      // and quote→base are different records. `live` is the aggregator's current answer;
      // comparing live.decimals against feedDecimals exposes decimals drift since registration.
      const readLive = async (aggregator: `0x${string}`) => {
        try {
          const [decimals, round] = await Promise.all([
            client.readContract({ address: aggregator, abi: aggregatorV3Abi, functionName: "decimals" }),
            client.readContract({ address: aggregator, abi: aggregatorV3Abi, functionName: "latestRoundData" }),
          ]);
          const [, answer, , updatedAt] = round as unknown as readonly [bigint, bigint, bigint, bigint, bigint];
          return { answer: answer.toString(), decimals: Number(decimals), updatedAt: updatedAt.toString() };
        } catch {
          return null;
        }
      };
      if (filters.base || filters.quote) {
        if (!filters.base || !filters.quote) return unavailable(chainId, "missing_filter", "a single-feed lookup needs BOTH filters.base and filters.quote (direction matters: base→quote and quote→base are different feeds)", ctx);
        const [found, entry] = await client.readContract({ ...reg, functionName: "lookupConversionFeed", args: [filters.base, filters.quote] });
        if (!found) return unavailable(chainId, "feed_not_found", `no conversion feed registered for ${filters.base} → ${filters.quote} on chainId ${chainId} (direction matters); list them with cork_query resource:"registry-feeds"`, ctx);
        const item = { base: entry.base, quote: entry.quote, aggregator: entry.aggregatorAddress, feedDecimals: entry.feedDecimals, live: await readLive(entry.aggregatorAddress) };
        return envelope({ state: "ok", data: { resource: input.resource, chainId, registry: mr.registry, ...version, count: 1, items: [item] }, chainId, source: "chain", warnings: [...rpcWarn(resolved), ...warnings], ...rpc(), ctx });
      }
      const [page, total] = await client.readContract({ ...reg, functionName: "getConversionFeeds", args: [0n, 500n] });
      if (total > BigInt(page.length)) {
        warnings.push({ code: "pagination_incomplete", message: `registry reports ${total} conversion feeds but this read returns the first ${page.length}` });
      }
      const items = await Promise.all(page.map(async (f) => ({ base: f.base, quote: f.quote, aggregator: f.aggregatorAddress, feedDecimals: f.feedDecimals, live: await readLive(f.aggregatorAddress) })));
      return envelope({ state: "ok", data: { resource: input.resource, chainId, registry: mr.registry, ...version, count: items.length, total, items }, chainId, source: "chain", warnings: [...rpcWarn(resolved), ...warnings], ...rpc(), ctx });
    }
    // registry-oracle — two keying families, one resource:
    //  · filters.rate → the FIXED-RATE oracle for that rate (keyed on the rate, not a pair);
    //  · filters.collateralAsset+referenceAsset [+ filters.mode price|nav] → the pair's wrapper.
    // The oracle:{address,deployed,deployable,…} shape is shared with derive-market +
    // cork_prepare_market, so oracle.address is one reusable path across those tools.
    if (filters.rate !== undefined) {
      if (filters.collateralAsset || filters.referenceAsset) {
        return unavailable(chainId, "missing_filter", "filters.rate keys a FIXED-RATE oracle (no pair) — pass either rate OR collateralAsset+referenceAsset, not both", ctx);
      }
      if (filters.rate === 0n) return unavailable(chainId, "invalid_state", "a zero fixed rate cannot have an oracle — the FixedRateOracle constructor reverts on 0", ctx);
      const predicted = await client.readContract({ ...reg, functionName: "predictFixedRateOracle", args: [filters.rate] });
      const code = await client.getCode({ address: predicted }).catch(() => undefined);
      const deployed = code !== undefined && code !== "0x";
      return envelope({
        state: "ok",
        data: { resource: input.resource, chainId, registry: mr.registry, ...version, rate: filters.rate, scale: "rate is ABSOLUTE, 1e18 = 1.0", oracle: { address: predicted, deployed, deployable: true }, ...(deployed ? {} : { note: "not deployed yet; registry.deployFixedRateOracle(rate) is permissionless + idempotent (CREATE2-salted by the rate) — cork_prepare_market deploy-fixed-oracle builds that tx, and a JIT fill with rateOverride deploys it automatically" }) },
        chainId,
        source: "chain",
        warnings,
        ...rpc(),
        ctx,
      });
    }
    if (!filters.collateralAsset || !filters.referenceAsset) {
      return unavailable(chainId, "missing_filter", "registry-oracle requires filters.collateralAsset AND filters.referenceAsset (order matters: collateral first — the reverse pair is a different oracle), or filters.rate for a fixed-rate oracle", ctx);
    }
    const modeName: OracleModeName = filters.mode === "nav" ? "nav" : "price";
    if (filters.mode !== undefined && filters.mode !== "price" && filters.mode !== "nav") {
      return unavailable(chainId, "missing_filter", `registry-oracle filters.mode must be 'price' or 'nav' (got '${filters.mode}') — one pair can hold BOTH wrappers at different addresses, so the mode is part of the key. For a fixed-rate oracle pass filters.rate instead`, ctx);
    }
    const wrapper = await client.readContract({ ...reg, functionName: "lookupWrapper", args: [filters.collateralAsset, filters.referenceAsset, ORACLE_MODE[modeName]] });
    // The applied default is disclosed in DATA (not a warning: no caller field was ignored —
    // reserved_field_ignored means something else) so the echoed mode is never mistaken for a
    // caller choice.
    const pairEcho = { collateralAsset: filters.collateralAsset, referenceAsset: filters.referenceAsset, mode: modeName, ...(filters.mode === undefined ? { modeNote: "no filters.mode given — defaulted to 'price'; one pair can hold a price AND a nav wrapper at different addresses, pass mode explicitly when you mean nav" } : {}) };
    if (wrapper !== ZERO_ADDR) {
      const rate = (await client.readContract({ address: wrapper, abi: rateOracleAbi, functionName: "rate" }).catch(() => null)) as bigint | null;
      return envelope({ state: "ok", data: { resource: input.resource, chainId, registry: mr.registry, ...version, ...pairEcho, oracle: { address: wrapper, deployed: true, deployable: true, ...(rate !== null ? { rate } : {}) } }, chainId, source: "chain", warnings: [...rpcWarn(resolved), ...warnings], ...rpc(), ctx });
    }
    try {
      // Simulating the real deploy (not re-deriving CREATE2 off-chain) is deliberate: the salt
      // includes the RESOLVED source addresses, so re-deriving would duplicate the registry's
      // nav-fallback rules — the simulation cannot drift from what a fill will actually do.
      const sim = await client.simulateContract({ ...reg, functionName: "deploy", args: [filters.collateralAsset, filters.referenceAsset, ORACLE_MODE[modeName]] });
      return envelope({ state: "ok", data: { resource: input.resource, chainId, registry: mr.registry, ...version, ...pairEcho, oracle: { address: sim.result, deployed: false, deployable: true }, note: `no ${modeName} oracle yet; registry.deploy(ca, ref, ${modeName}) would succeed (permissionless, idempotent) — cork_prepare_market builds that tx` }, chainId, source: "chain", warnings: [...rpcWarn(resolved), ...warnings], ...rpc(), ctx });
    } catch (err) {
      return envelope({ state: "ok", data: { resource: input.resource, chainId, registry: mr.registry, ...version, ...pairEcho, oracle: { address: null, deployed: false, deployable: false, reason: revertReason(err) }, note: `this pair cannot get a ${modeName} oracle as-registered (MissingSource / NavModeWithoutNavSource — an unregistered asset, a missing source slot, or no conversion path) — a JIT fill for it would revert` }, chainId, source: "chain", warnings: [...rpcWarn(resolved), ...warnings], ...rpc(), ctx });
    }
  } catch (err) {
    return chainReadFailed(chainId, err, [...rpcWarn(resolved), ...warnings], ctx, resolved);
  }
}

/** The DEPRECATED pre-2.1.0 resolve-recipe (percentage bands × live rate via the old registry's
 *  applyBands, bit-parity self-checked) — preserved behind the deprecation gate. */
export async function handleComputeResolveRecipeLegacy(
  input: { format: "concise" | "full" },
  p: { kind: "resolve-recipe"; mode?: string | undefined; rate?: string | undefined; collateralAsset?: `0x${string}` | undefined; referenceAsset?: `0x${string}` | undefined },
  ctx: HandlerContext,
  chainId: ChainId,
): Promise<Envelope> {
  if (!deprecatedEnabled()) {
    return unavailable(chainId, "deprecated_gated", deprecatedGateMessage("legacy resolve-recipe (pre-2.1.0 percentage-band math)", "In 2.1.0 a recipe resolves its own constraint — drop `legacy` and pass the recipe CONTRACT ADDRESS."), ctx);
  }
  if (p.mode === undefined) return unavailable(chainId, "missing_filter", "legacy resolve-recipe needs `mode` (the old registry's exact case-sensitive mode string)", ctx);
  const { marketRegistry: mr, warning } = await resolveMarketRegistryLegacy(chainId);
  if (!mr) return unavailable(chainId, "unknown_deployment", `no LEGACY MarketRegistry configured for chainId ${chainId}`, ctx);
  const resolved = await getRpc(ctx, chainId);
  if (!resolved) return unavailable(chainId, "requires_rpc", `MarketRegistry reads need an RPC endpoint for chainId ${chainId} (none resolved — set CORK_RPC_URL)`, ctx);
  const warnings: Array<{ code: string; message: string }> = [...(warning ? [warning] : []), { code: "deprecated", message: "this is the DEPRECATED pre-2.1.0 band math against the OLD registry (CORK_ENABLE_DEPRECATED is set) — 2.1.0 recipes resolve their own constraints" }];
  const client = resolved.client;
  const rpc = () => rpcProvenance(input.format, resolved);
  const reg = { address: mr.registry, abi: legacyRegistry.marketRegistryAbi } as const;
  try {
    const [found, entry] = await client.readContract({ ...reg, functionName: "lookupRecipe", args: [p.mode] });
    if (!found) {
      const [, modes] = await client.readContract({ ...reg, functionName: "getRecipes", args: [0n, 100n] });
      return unavailable(chainId, "recipe_not_found", `recipe mode '${p.mode}' is not in the legacy registry (modes are EXACT case-sensitive strings; available: ${modes.join(", ")})`, ctx);
    }
    let rate: bigint;
    let oracle: `0x${string}` | undefined;
    if (p.rate !== undefined) {
      rate = BigInt(p.rate);
    } else {
      if (!p.collateralAsset || !p.referenceAsset) {
        return unavailable(chainId, "missing_filter", "legacy resolve-recipe needs either an explicit rate, or collateralAsset+referenceAsset to read the pair's live oracle rate", ctx);
      }
      const sim = await client.simulateContract({ ...reg, functionName: "deploy", args: [p.collateralAsset, p.referenceAsset] });
      oracle = sim.result;
      rate = (await client.readContract({ address: oracle, abi: rateOracleAbi, functionName: "rate" })) as bigint;
      if (rate === 0n) return unavailable(chainId, "chain_read_failed", "the pair's rate oracle reports a ZERO rate — the bands cannot be meaningfully resolved", ctx);
    }
    const bands: legacyRegistry.ConstraintBands = { mode: entry.mode, rateMin: entry.rateMin, rateMax: entry.rateMax, rateChangePerDayMax: entry.rateChangePerDayMax, rateChangeCapacityMax: entry.rateChangeCapacityMax };
    let local: ReturnType<typeof legacyRegistry.applyBandsLocal>;
    try {
      local = legacyRegistry.applyBandsLocal(bands, rate);
    } catch (err) {
      return localComputeFailed(chainId, err, [...rpcWarn(resolved), ...warnings], ctx);
    }
    const onChain = await client.readContract({ ...reg, functionName: "applyBands", args: [p.mode, rate] });
    const same = onChain.rateMin === local.rateMin && onChain.rateMax === local.rateMax && onChain.rateChangePerDayMax === local.rateChangePerDayMax && onChain.rateChangeCapacityMax === local.rateChangeCapacityMax;
    if (!same) {
      return envelope({ state: "conflict", data: { kind: p.kind, mode: p.mode, rate, local, onChain }, chainId, source: "chain", warnings: [...rpcWarn(resolved), ...warnings, { code: "band_parity_mismatch", message: "local applyBands port disagrees with the on-chain view — trust the chain values and report this" }], ctx });
    }
    return envelope({
      state: "ok",
      data: { kind: p.kind, mode: p.mode, scales: { bands: "1e18 = 1% (percentage)", rateAndResolved: "1e18 = 1.0 (absolute)" }, bands, rate, ...(oracle ? { oracle, rateSource: "live oracle" } : { rateSource: "caller-supplied" }), resolved: local, parity: "verified against on-chain applyBands" },
      chainId,
      source: "chain",
      warnings,
      ...rpc(),
      ctx,
    });
  } catch (err) {
    return chainReadFailed(chainId, err, [...rpcWarn(resolved), ...warnings], ctx, resolved);
  }
}

/** The DEPRECATED pre-2.1.0 registry reads (mode-keyed recipes with PERCENTAGE bands, two-arg
 *  deploy, chainId-keyed asset lookup), preserved verbatim behind the deprecation gate because
 *  the old generation is still live on-chain. */
async function handleQueryRegistryLegacy(input: QueryInput, filters: QueryFilters, chainId: ChainId, ctx: HandlerContext): Promise<Envelope> {
  if (!deprecatedEnabled()) {
    return unavailable(chainId, "deprecated_gated", deprecatedGateMessage(`filters.legacy (the pre-2.1.0 registry generation)`, `The 2.1.0 registry is the default read path (drop filters.legacy).`), ctx);
  }
  if (input.resource === "registry-denominations" || input.resource === "registry-feeds") {
    return unavailable(chainId, "missing_filter", `${input.resource} does not exist in the pre-2.1.0 generation — drop filters.legacy`, ctx);
  }
  const { marketRegistry: mr, warning } = await resolveMarketRegistryLegacy(chainId);
  if (!mr) return unavailable(chainId, "unknown_deployment", `no LEGACY MarketRegistry configured for chainId ${chainId}`, ctx);
  const resolved = await getRpc(ctx, chainId);
  if (!resolved) return unavailable(chainId, "requires_rpc", `MarketRegistry reads need an RPC endpoint for chainId ${chainId} (none resolved — set CORK_RPC_URL)`, ctx);
  const warnings: Array<{ code: string; message: string }> = [...(warning ? [warning] : []), { code: "deprecated", message: "this is the DEPRECATED pre-2.1.0 registry generation (CORK_ENABLE_DEPRECATED is set) — its answers do not describe the 2.1.0 world" }];
  const client = resolved.client;
  const rpc = () => rpcProvenance(input.format, resolved);
  const reg = { address: mr.registry, abi: legacyRegistry.marketRegistryAbi } as const;
  try {
    if (input.resource === "registry-assets") {
      if (filters.address) {
        const [found, entry] = await client.readContract({ ...reg, functionName: "lookupAssetByAddress", args: [filters.address, BigInt(chainId)] });
        if (!found) return unavailable(chainId, "asset_not_found", `address ${filters.address} is not a legacy-registry asset on chainId ${chainId}`, ctx);
        return envelope({ state: "ok", data: { resource: input.resource, chainId, registry: mr.registry, count: 1, items: [entry] }, chainId, source: "chain", warnings: [...rpcWarn(resolved), ...warnings], ...rpc(), ctx });
      }
      const [page, total] = await client.readContract({ ...reg, functionName: "getAssets", args: [0n, 500n] });
      if (total > BigInt(page.length)) {
        warnings.push({ code: "pagination_incomplete", message: `legacy registry reports ${total} assets but this read returns the first ${page.length} — items are partial evidence` });
      }
      return envelope({ state: "ok", data: { resource: input.resource, chainId, registry: mr.registry, count: page.length, total, items: page }, chainId, source: "chain", warnings: [...rpcWarn(resolved), ...warnings], ...rpc(), ctx });
    }
    if (input.resource === "registry-recipes") {
      if (filters.mode !== undefined) {
        const [found, entry] = await client.readContract({ ...reg, functionName: "lookupRecipe", args: [filters.mode] });
        if (!found) return unavailable(chainId, "recipe_not_found", `recipe mode '${filters.mode}' is not in the legacy registry`, ctx);
        return envelope({ state: "ok", data: { resource: input.resource, chainId, registry: mr.registry, scale: "bands are PERCENTAGES: 1e18 = 1%", items: [entry] }, chainId, source: "chain", warnings: [...rpcWarn(resolved), ...warnings], ...rpc(), ctx });
      }
      const [page, modes, total] = await client.readContract({ ...reg, functionName: "getRecipes", args: [0n, 100n] });
      if (total > BigInt(page.length)) {
        warnings.push({ code: "pagination_incomplete", message: `legacy registry reports ${total} recipes but this read returns the first ${page.length} — items (and the modes list) are partial evidence; a mode absent here may still exist` });
      }
      return envelope({ state: "ok", data: { resource: input.resource, chainId, registry: mr.registry, scale: "bands are PERCENTAGES: 1e18 = 1%", count: page.length, total, modes, items: page }, chainId, source: "chain", warnings: [...rpcWarn(resolved), ...warnings], ...rpc(), ctx });
    }
    if (!filters.collateralAsset || !filters.referenceAsset) {
      return unavailable(chainId, "missing_filter", "registry-oracle requires filters.collateralAsset AND filters.referenceAsset", ctx);
    }
    const wrapper = await client.readContract({ ...reg, functionName: "lookupWrapper", args: [filters.collateralAsset, filters.referenceAsset] });
    if (wrapper !== ZERO_ADDR) {
      return envelope({ state: "ok", data: { resource: input.resource, chainId, collateralAsset: filters.collateralAsset, referenceAsset: filters.referenceAsset, oracle: { address: wrapper, deployed: true, deployable: true } }, chainId, source: "chain", warnings: [...rpcWarn(resolved), ...warnings], ...rpc(), ctx });
    }
    try {
      const sim = await client.simulateContract({ ...reg, functionName: "deploy", args: [filters.collateralAsset, filters.referenceAsset] });
      return envelope({ state: "ok", data: { resource: input.resource, chainId, collateralAsset: filters.collateralAsset, referenceAsset: filters.referenceAsset, oracle: { address: sim.result, deployed: false, deployable: true } }, chainId, source: "chain", warnings: [...rpcWarn(resolved), ...warnings], ...rpc(), ctx });
    } catch (err) {
      return envelope({ state: "ok", data: { resource: input.resource, chainId, collateralAsset: filters.collateralAsset, referenceAsset: filters.referenceAsset, oracle: { address: null, deployed: false, deployable: false, reason: revertReason(err) } }, chainId, source: "chain", warnings: [...rpcWarn(resolved), ...warnings], ...rpc(), ctx });
    }
  } catch (err) {
    return chainReadFailed(chainId, err, [...rpcWarn(resolved), ...warnings], ctx, resolved);
  }
}

/** Shared 2.1.0 recipe/oracle/constraint resolution — the exact sequence a fill's _resolveOracle
 *  runs, and the one place its rules live so cork_compute resolve-recipe, cork_query
 *  derive-market, and the JIT maker-order prepare can never disagree:
 *  1. recipe from an explicit address, or DEPRECATED mode sugar over the config hints;
 *  2. isRecipe — the only membership gate (no unverified path);
 *  3. source() decides the oracle family (ENUM TRAP: RecipeSource ≠ OracleMode ordering —
 *     oracleModeForSource does the inversion);
 *  4. oracle: explicit override → fixed-rate (keyed on the rate) → pair wrapper (live, else the
 *     simulated-deploy prediction);
 *  5. optionally the constraint via recipe.resolve — the staticcall gets the LIVE oracle only
 *     when one is deployed; a predicted/absent oracle is passed as address(0), which is what
 *     lets the liquidity recipe fall back to the anchorRate in additionalData (API parity). */
interface RecipeResolution {
  gate?: Envelope;
  recipe: `0x${string}`;
  source: RecipeSourceName;
  oracle: { address: `0x${string}` | null; deployed: boolean; deployable: boolean; mode: OracleModeName | null; rate: bigint | null; reason?: string };
  constraint?: ResolvedConstraint;
  warnings: Array<{ code: string; message: string }>;
}

export async function resolveRecipeOracleConstraint(args: {
  client: RegistryClient;
  ctx: HandlerContext;
  chainId: ChainId;
  mr: { registry: `0x${string}`; recipes?: Record<string, `0x${string}`> | undefined };
  recipe?: `0x${string}` | undefined;
  mode?: string | undefined;
  collateralAsset: `0x${string}`;
  referenceAsset: `0x${string}`;
  fixedRate?: bigint | undefined;
  rateOracle?: `0x${string}` | undefined;
  additionalData?: `0x${string}` | undefined;
  wantConstraint: boolean;
}): Promise<RecipeResolution> {
  const { client, ctx, chainId, mr } = args;
  const warnings: Array<{ code: string; message: string }> = [];
  const bad = (g: Envelope): RecipeResolution => ({ gate: g, recipe: ZERO_ADDR, source: "price", oracle: { address: null, deployed: false, deployable: false, mode: null, rate: null }, warnings });
  const reg = { address: mr.registry, abi: marketRegistryAbi } as const;
  // 1+2: the recipe address, and its membership.
  let recipe = args.recipe;
  if (!recipe) {
    if (args.mode === undefined) {
      return bad(unavailable(chainId, "missing_filter", "a recipe CONTRACT ADDRESS is required (recipes replaced mode strings in 2.1.0) — discover them with cork_query resource:\"registry-recipes\"", ctx));
    }
    const hinted = mr.recipes?.[args.mode];
    if (!hinted) {
      return bad(unavailable(chainId, "recipe_not_found", `recipe mode '${args.mode}' has no configured 2.1.0 recipe hint — recipes are CONTRACT ADDRESSES now; known mode hints: ${Object.keys(mr.recipes ?? {}).join(", ") || "none"}. Discover recipes with cork_query resource:"registry-recipes"`, ctx));
    }
    warnings.push({ code: "deprecation_notice", message: `mode is deprecated sugar: '${args.mode}' resolved to recipe ${hinted} via this tool's config hints — pass the recipe address directly; mode will be removed in a later release` });
    recipe = hinted;
  }
  const isRecipe = await client.readContract({ ...reg, functionName: "isRecipe", args: [recipe] });
  if (!isRecipe) {
    return bad(unavailable(chainId, "recipe_not_found", `${recipe} is not an approved recipe on this registry (isRecipe is the only membership gate) — a fill would revert RecipeNotRegistered. List recipes with cork_query resource:"registry-recipes"`, ctx));
  }
  // 3: the recipe's source decides the oracle family.
  const sourceOrdinal = (await client.readContract({ address: recipe, abi: recipeAbi, functionName: "source" })) as number;
  const source = RECIPE_SOURCE[sourceOrdinal];
  if (!source) return bad(unavailable(chainId, "chain_read_failed", `recipe ${recipe} reports unknown source ordinal ${sourceOrdinal}`, ctx));
  // 4: oracle resolution.
  let oracle: RecipeResolution["oracle"];
  if (args.rateOracle) {
    const code = await client.getCode({ address: args.rateOracle }).catch(() => undefined);
    const deployed = code !== undefined && code !== "0x";
    const rate = deployed ? ((await client.readContract({ address: args.rateOracle, abi: rateOracleAbi, functionName: "rate" }).catch(() => null)) as bigint | null) : null;
    oracle = { address: args.rateOracle, deployed, deployable: true, mode: null, rate };
  } else if (source === "fixed") {
    if (args.fixedRate === undefined) {
      oracle = { address: null, deployed: false, deployable: true, mode: null, rate: null, reason: "a FIXED recipe's oracle is keyed on the RATE — pass the rate (rateOverride) to predict it" };
    } else {
      const predicted = (await client.readContract({ ...reg, functionName: "predictFixedRateOracle", args: [args.fixedRate] })) as `0x${string}`;
      const code = await client.getCode({ address: predicted }).catch(() => undefined);
      const deployed = code !== undefined && code !== "0x";
      oracle = { address: predicted, deployed, deployable: true, mode: null, rate: deployed ? args.fixedRate : null };
    }
  } else {
    const modeName: OracleModeName = source;
    const wrapper = (await client.readContract({ ...reg, functionName: "lookupWrapper", args: [args.collateralAsset, args.referenceAsset, ORACLE_MODE[modeName]] })) as `0x${string}`;
    if (wrapper !== ZERO_ADDR) {
      const rate = (await client.readContract({ address: wrapper, abi: rateOracleAbi, functionName: "rate" }).catch(() => null)) as bigint | null;
      oracle = { address: wrapper, deployed: true, deployable: true, mode: modeName, rate };
    } else {
      try {
        const sim = await client.simulateContract({ ...reg, functionName: "deploy", args: [args.collateralAsset, args.referenceAsset, ORACLE_MODE[modeName]] });
        oracle = { address: sim.result as `0x${string}`, deployed: false, deployable: true, mode: modeName, rate: null };
      } catch (err) {
        oracle = { address: null, deployed: false, deployable: false, mode: modeName, rate: null, reason: revertReason(err) };
      }
    }
  }
  const base: RecipeResolution = { recipe, source, oracle, warnings };
  // 5: the constraint — recipe.resolve with the API's exact oracle-passing semantics.
  if (args.wantConstraint) {
    const c = await staticResolveConstraint(client, ctx, chainId, { recipe, collateralAsset: args.collateralAsset, referenceAsset: args.referenceAsset, oracle, additionalData: args.additionalData });
    if ("gate" in c) return { ...base, gate: c.gate };
    base.constraint = c.constraint;
  }
  return base;
}

/** The recipe.resolve staticcall itself, shared by the resolution helper and the JIT prepare
 *  (which needs its coherence checks BETWEEN oracle resolution and constraint resolution). The
 *  call gets the LIVE oracle only when one is deployed; predicted/absent → address(0). */
export async function staticResolveConstraint(
  client: RegistryClient,
  ctx: HandlerContext,
  chainId: ChainId,
  args: { recipe: `0x${string}`; collateralAsset: `0x${string}`; referenceAsset: `0x${string}`; oracle: RecipeResolution["oracle"]; additionalData?: `0x${string}` | undefined },
): Promise<{ constraint: ResolvedConstraint } | { gate: Envelope }> {
  const oracleForCall = args.oracle.deployed && args.oracle.address ? args.oracle.address : ZERO_ADDR;
  try {
    const c = (await client.readContract({ address: args.recipe, abi: recipeAbi, functionName: "resolve", args: [args.collateralAsset, args.referenceAsset, oracleForCall, args.additionalData ?? "0x"] })) as { rateMin: bigint; rateMax: bigint; rateChangePerDayMax: bigint; rateChangeCapacityMax: bigint };
    return { constraint: { rateMin: c.rateMin, rateMax: c.rateMax, rateChangePerDayMax: c.rateChangePerDayMax, rateChangeCapacityMax: c.rateChangeCapacityMax } };
  } catch (err) {
    return { gate: unavailable(chainId, "recipe_refused", `the recipe refused to resolve a constraint for this input: ${revertReason(err)}. Typical causes: the liquidity recipe needs additionalData = abi.encode(uint256 anchorRate) while the pair's oracle is not deployed; the fixed-rate recipe needs its FixedRateOracle DEPLOYED (cork_prepare_market deploy-fixed-oracle) and rejects any additionalData`, ctx) };
  }
}

/** derive-market: derive the market a JIT LOP fill would produce for (collateralAsset,
 *  referenceAsset, expiry, recipe [+args/rate]) BEFORE it exists — the recipe's oracle (+ live
 *  rate), the OFF-CHAIN-resolved constraint, pool id, cST/cPT tokens, and whether the pool
 *  already exists. Composes the shared recipe resolution + our verified computeMarketId + a
 *  state-override share simulation — the same derivation the adapter runs at fill time.
 *  Chain-native (no dependency on the read API); the pool id is computed LOCALLY. Like the HTTP
 *  endpoint, market/shares are null while the pair oracle is undeployed — without a live rate
 *  the identity would be an invention. */
export async function handleQueryMarketPredict(input: QueryInput, filters: QueryFilters, chainId: ChainId, ctx: HandlerContext): Promise<Envelope> {
  if (!filters.collateralAsset || !filters.referenceAsset || filters.expiry === undefined || (filters.recipe === undefined && filters.mode === undefined)) {
    return unavailable(chainId, "missing_filter", "derive-market requires filters.collateralAsset, filters.referenceAsset (ORDER MATTERS: collateral first), filters.expiry (unix seconds), and filters.recipe (the approved recipe CONTRACT ADDRESS — discover with cork_query resource:\"registry-recipes\"; filters.mode survives as deprecated sugar). Optional: filters.args (recipe additionalData hex), filters.rate (FIXED recipes: the rateOverride), filters.rateOracle (explicit oracle)", ctx);
  }
  if (filters.collateralAsset.toLowerCase() === filters.referenceAsset.toLowerCase()) {
    // Well-formed inputs that violate a domain rule → envelope (exit 3), not a throw — same class
    // as rollover's invalid_order_terms. Only unparseable/format faults throw (exit 2).
    return unavailable(chainId, "invalid_pair", "collateralAsset and referenceAsset must differ — a market is a pair of distinct assets", ctx);
  }
  const r = await getRegistry(ctx, chainId);
  if (r.gate) return r.gate;
  const { mr, resolved, warnings } = r;
  const client = resolved.client;
  const rpc = () => rpcProvenance(input.format, resolved);
  const ca = filters.collateralAsset, ref = filters.referenceAsset, expiry = filters.expiry;
  const inputEcho = { collateralAsset: ca, referenceAsset: ref, expiry, ...(filters.recipe ? { recipe: filters.recipe } : {}), ...(filters.mode ? { mode: filters.mode } : {}) };
  try {
    const bindingWarn = await registryBindingMismatch(client, chainId, mr);
    if (bindingWarn) {
      return envelope({ state: "conflict", data: { resource: input.resource, chainId, registry: mr.registry, adapter: mr.adapter }, chainId, source: "chain", warnings: [...rpcWarn(resolved), ...warnings, bindingWarn], ...rpc(), ctx });
    }
    const res = await resolveRecipeOracleConstraint({ client, ctx, chainId, mr, recipe: filters.recipe, mode: filters.mode, collateralAsset: ca, referenceAsset: ref, fixedRate: filters.rate, rateOracle: filters.rateOracle, additionalData: filters.args, wantConstraint: true });
    warnings.push(...res.warnings);
    if (res.gate) return res.gate;
    const { recipe, source, oracle, constraint } = res;
    const oracleEcho = { address: oracle.address, deployed: oracle.deployed, deployable: oracle.deployable, ...(oracle.mode ? { mode: oracle.mode } : {}), ...(oracle.rate !== null ? { rate: oracle.rate } : {}), ...(oracle.reason ? { reason: oracle.reason } : {}) };
    // Identity needs an oracle ADDRESS, not a deployed oracle: the pool id's only oracle-derived
    // input is the address (already predicted via the simulated deploy — the same one the fill
    // will run), and the constraint can resolve from the recipe's anchor fallback. Nothing has to
    // be deployed first — the fill deploys the oracle inside the transaction that needs it. This
    // deliberately EXCEEDS today's HTTP endpoint, which still nulls market/shares whenever the
    // oracle has no code and forces agents to deploy the wrapper just to learn the share
    // addresses (the walkthrough calls that behavior out as a caveat).
    if (oracle.address === null) {
      return envelope({ state: "ok", data: { resource: input.resource, chainId, input: inputEcho, recipe, source, oracle: oracleEcho, ...(constraint ? { constraint: { ...constraint, scale: "ABSOLUTE rates, 1e18 = 1.0" } } : {}), market: null, shares: null }, chainId, source: "chain", warnings: [...rpcWarn(resolved), ...warnings, { code: "oracle_not_deployable", message: `this pair cannot get a ${source} oracle as-registered (${oracle.reason ?? "unregistered asset / missing source or conversion path"}) — a JIT fill would revert; nothing further can be predicted` }], ...rpc(), ctx });
    }
    if (oracle.deployed && oracle.rate === 0n) return unavailable(chainId, "chain_read_failed", "the rate oracle reports a ZERO rate (RateUnavailable) — a fill creating this market would revert and the identity cannot be derived", ctx);
    // Identity: constraint + oracle → Market struct → LOCAL poolId (verified computeMarketId).
    if (!constraint) return unavailable(chainId, "recipe_refused", "the recipe did not resolve a constraint — the market identity cannot be derived", ctx);
    let derived: ReturnType<typeof deriveJitMarket>;
    try {
      derived = deriveJitMarket({ collateralAsset: ca, referenceAsset: ref, expiryTimestamp: expiry, constraint, oracle: oracle.address });
    } catch (err) {
      return localComputeFailed(chainId, err, [...rpcWarn(resolved), ...warnings], ctx);
    }
    // cST / cPT — pinned when the pool exists, else predicted via the state-override simulation.
    // With an UNDEPLOYED oracle the simulation prepends the same permissionless deploy the fill
    // performs, so the pool creates in-memory and the share addresses come back real.
    const { dep } = await getDep(ctx, chainId);
    let shares: PredictSharesResult = { exists: false, status: "unavailable" };
    if (dep?.poolManager && mr.controller && mr.adapter) {
      const preCalls: Array<{ to: `0x${string}`; data: `0x${string}` }> = [];
      if (!oracle.deployed) {
        preCalls.push({ to: mr.registry, data: source === "fixed" && filters.rate !== undefined ? buildDeployFixedRateOracleCall(filters.rate) : buildDeployOracleCall(ca, ref, oracle.mode ?? "price") });
      }
      shares = await predictShares(client, { adapter: mr.adapter, controller: mr.controller, poolManager: dep.poolManager, market: derived.market, poolId: derived.poolId, preCalls });
    }
    const extra: Array<{ code: string; message: string }> = [];
    if (shares.status === "unavailable") extra.push({ code: "share_prediction_unavailable", message: "could not predict the pool's cST/cPT (eth_simulateV1/state overrides unsupported, or config missing) — the pool id, oracle, and constraint above are still valid" });
    if (!shares.exists && !oracle.deployed) {
      extra.push({ code: "oracle_not_deployed", message: "the oracle is not deployed and does not need to be: the fill deploys it (permissionless, idempotent) at this PREDICTED address inside the same transaction, and the pool id's only oracle-derived input is that address. The identity above is stable unless the pair's registered sources change before the fill (a re-registration shifts the predicted address → OrderNotForPool)" });
    } else if (!shares.exists) {
      extra.push({ code: "rate_drift_notice", message: "the pool does not exist yet, so this prediction is conditioned on TODAY's oracle rate and drifts stepwise until pinned. In 2.1.0 the pinning moment is EARLIER than pool creation: an order that CARRIES this constraint fixes the pool id and share addresses at signing — sign, and this identity holds however far the rate moves (staleness then guards via recipe.verify, not a moving id)" });
    }
    // T6: a prediction can be internally consistent yet describe an UNCREATABLE market — say so.
    const nowSecs = nowSecondsOf(ctx);
    if (!shares.exists && expiry <= nowSecs) {
      extra.push({ code: "would_revert", message: `expiry ${expiry} is not in the future (now ${nowSecs}) — createNewPool requires a future expiry, so a JIT fill for this market would revert; the identity below is for a market that cannot be created` });
    }
    if (constraint.rateMin <= 0n || constraint.rateMin >= constraint.rateMax) {
      extra.push({ code: "would_revert", message: `the resolved constraint violates createNewPool's requirements (needs 0 < rateMin < rateMax; rateMin=${constraint.rateMin}, rateMax=${constraint.rateMax}) — a JIT fill for this recipe would revert InvalidParams` });
    }
    return envelope({
      state: "ok",
      data: {
        resource: input.resource,
        chainId,
        input: inputEcho,
        recipe,
        source,
        oracle: oracleEcho,
        market: { poolId: derived.poolId, exists: shares.exists, scale: "the constraint is ABSOLUTE rates, 1e18 = 1.0", constraint },
        shares: shares.cst || shares.cpt ? { corkSwapToken: shares.cst ?? null, corkPrincipalToken: shares.cpt ?? null, source: shares.status } : null,
      },
      chainId,
      source: "chain",
      warnings: [...rpcWarn(resolved), ...warnings, ...extra],
      ...rpc(),
      ctx,
    });
  } catch (err) {
    return chainReadFailed(chainId, err, [...rpcWarn(resolved), ...warnings], ctx, resolved);
  }
}
