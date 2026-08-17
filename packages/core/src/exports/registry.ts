// @cork/core/registry — the MarketRegistry 2.1.0 surface: registry reads, recipe constraint
// resolution, JIT market derivation and extension encode/decode, oracle deploy call builders.
// The pre-2.1.0 generation stays namespaced under `marketRegistryLegacy`, reachable at runtime
// only through the deprecation gate.
export * from "../market-registry.ts";
export * as marketRegistryLegacy from "../market-registry-legacy.ts";
export * from "../deprecation.ts";
