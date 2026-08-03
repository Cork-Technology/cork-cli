// General deprecation gate (owner ruling 2026-08-03): deprecated features/tools stay available
// behind an explicit opt-in — the CORK_ENABLE_DEPRECATED=1 environment variable (the CLI's
// --enable-deprecated flag sets the same variable before dispatch) — and every use is labelled.
// The warning-code contract, uniform across every deprecated surface:
//   deprecated_gated  (on `unavailable`): the feature was invoked WITHOUT the opt-in. The message
//     names what replaced it and how to unlock the old path; nothing was executed.
//   deprecated        (informational on `ok`): the opt-in is set and the deprecated path DID run.
//   deprecation_notice (informational on `ok`): still-supported convenience sugar (e.g.
//     jitMarket.mode) that will be removed later — no gate, just teaching toward the new shape.
// First gated consumer: the pre-2.1.0 MarketRegistry generation (marketRegistryLegacy config).

export function deprecatedEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const v = env["CORK_ENABLE_DEPRECATED"];
  return v === "1" || v === "true";
}

/** The standard `unavailable` message body for a gated deprecated feature. */
export function deprecatedGateMessage(what: string, replacement: string): string {
  return `${what} is DEPRECATED and gated. ${replacement} Set CORK_ENABLE_DEPRECATED=1 (CLI: --enable-deprecated) to run the deprecated path anyway — every result it produces is labelled with a 'deprecated' warning.`;
}
