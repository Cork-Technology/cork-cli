// ONE JIT-extension decoder for readers that hold the chain's generations (2026-09-22, review
// A3): the hook TARGET is classified first (generations.ts `classifyAddress`, role `jitAdapter`)
// and the payload is decoded on THAT generation's declared registry wire — never trial-decoded
// across wires. Two trial ladders existed before this module (market-registry `decodeJitExtensionAny`,
// nested → flat; handlers/decode.ts, nested → flat → legacy), and the book's maker-readiness
// verdict rode on one of them: a flat payload that also parses as a plausible nested market
// would have been judged on the wrong wire. An adapter no generation configures yields `null`
// — "unknown", never a verdict on a guessed layout. The legacy (pre-2.1.0, mode-string) lane is
// reachable ONLY through the generation whose registry wire is `legacy`.
//
// Lives in its own module because market-registry-legacy.ts imports market-registry.ts: the
// dispatcher needs both decoders and would close an import cycle from either.
import { classifyAddress, type MarketRegistryWire, type ResolvedGeneration } from "./generations.ts";
import { decodeJitExtraData, type JITMarketParams, jitExtensionTarget, type PermitParams } from "./market-registry.ts";
import * as legacyRegistry from "./market-registry-legacy.ts";

export type DecodedJitExtension =
  | { wire: Extract<MarketRegistryWire, "flat" | "nested">; generation: string; adapter: `0x${string}`; params: JITMarketParams; permits: PermitParams[] }
  | { wire: "legacy"; generation: string; adapter: `0x${string}`; params: legacyRegistry.JITMarketParams; permits: legacyRegistry.PermitParams[] };

/** Decode a LOP v4 extension's JIT preInteraction by the CLASSIFICATION of its adapter: the
 *  generation whose `marketRegistry.adapter` it is picks the codec. Returns `null` when the
 *  extension carries no preInteraction, when the adapter belongs to no generation's registry
 *  block, or when the generation's wire is one this build does not decode. Throws only what the
 *  wire's own decoder throws on malformed bytes AT a classified adapter — bytes claiming to be a
 *  Cork payload at Cork's contract, which is worth surfacing, not swallowing. */
export function decodeJitExtensionFor(generations: readonly ResolvedGeneration[], extension: `0x${string}`): DecodedJitExtension | null {
  let target: ReturnType<typeof jitExtensionTarget>;
  try {
    target = jitExtensionTarget(extension);
  } catch {
    return null; // no field table / no preInteraction — not a JIT extension
  }
  const hit = classifyAddress(generations, target.adapter).find((c) => c.role === "jitAdapter");
  if (hit === undefined) return null;
  const wire = generations.find((g) => g.label === hit.label)?.marketRegistry?.wire;
  if (wire === undefined) return null;
  if (wire === "legacy") {
    const d = legacyRegistry.decodeJitExtension(extension);
    return { wire, generation: hit.label, adapter: d.adapter, params: d.params, permits: d.permits };
  }
  return { wire, generation: hit.label, adapter: target.adapter, ...decodeJitExtraData(wire, target.extraData) };
}
