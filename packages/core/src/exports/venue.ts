// @cork/core/venue — the typed client for the Cork venue API (api-phoenix): pools, orderbook,
// fills, rollover, RFQ negotiation, order relay. Opaque keyset cursor pagination, the shared
// per-host breaker, and the venue's premium gates replicated op-for-op. RFQ v2 writes: the exact
// bodies the venue hashes and the CorkRfqWrite typed data a requester or underwriter signs.
export * from "../datasources/venue.ts";
export * from "../rfq-signing.ts";
export * from "../rfq-bodies.ts";
