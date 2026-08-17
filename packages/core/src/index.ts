// @cork/core — deterministic, bit-exact ports of Cork Phoenix on-chain math + address
// derivation, chain reads, Bundler3 encode/decode, and the typed 9-tool runTool dispatch.
//
// The root export is the full curated SDK surface: every tier barrel below plus the envelope
// (runTool). The same tiers are importable individually as subpaths (`@cork/core/math`,
// `@cork/core/orders`, …) so a consumer who only wants the pure math never loads the venue
// client or an RPC transport. The public surface — root and every subpath — is pinned by the
// API-surface drift gate (packages/core/test/api-surface.test.ts): adding or removing an export
// fails CI until the fixture is regenerated deliberately (UPDATE_API_SURFACE=1).
//
// Deliberately NOT exported (internal machinery, no stability promise): breaker.ts,
// atomic-file.ts, fetch-timeout.ts, scan-cache.ts, and the per-tool handlers under handlers/
// (reachable only through runTool).
export * from "./exports/math.ts";
export * from "./exports/orders.ts";
export * from "./exports/registry.ts";
export * from "./exports/chain.ts";
export * from "./exports/bundle.ts";
export * from "./exports/venue.ts";
export * from "./exports/indexer.ts";
export * from "./exports/config.ts";
// The envelope: runTool + ToolInputError + HandlerContext + the CLI filter-key constants.
export * from "./handlers.ts";
