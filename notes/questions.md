# QUESTION log — prioritized for when you're back

Each: why it matters → what I tried → best guess.

## Q1. Where do Dutch-auction limit orders actually live? (HIGH — shapes a whole tool group)
- **Why:** The brief lists "current Dutch-auction limit-order prices" as core time-dependent
  state (Goal 2). But Cork's live limit orders are plain fixed-price 1inch LOP v4 orders (no
  extension bytes, no `DutchAuctionCalculator`), and rollover orders (ERC-7683) carry a *fixed*
  `minPremiumPerShare`. Nothing time-decaying exists in either order system I can find.
- **Tried:** read phoenix-private LOP integration + rollover-private order structs + 1inch LOP
  submodules; pulled live orders from api-phoenix (`/v1/limit-orders/`) — `extension` fields are
  empty/absent; searched docs (no Dutch-auction page in current docs; only legacy OTC/Airswap).
- **Best guess:** Dutch-auction orders are a *planned* feature (or live in a repo/branch I can't
  see). Design the `orders` tool group with a pricing-strategy discriminator (`fixed` |
  `dutch-auction` | `rollover-premium`) so the Dutch case slots in when it ships. Need: the repo/
  spec for the Dutch mechanism, or confirmation it's future work.

## Q2. Rollover orders: which repo/deployment is authoritative? (HIGH)
- **Why:** Goal 2 wants "current rollover-order prices"; rollover-private appears mid-flight
  (`phoenix-private-rollover-misnamed` is a superseded older architecture; rollover-private is
  ERC-7683-based). No deployed rollover contracts found in prod.toml or on-chain configs.
- **Tried:** read both rollover repos in euler-research; searched prod.toml + Sourcify + API for
  rollover deployments — nothing live found.
- **Best guess:** rollover is pre-production; CLI v1 should stub the schema but not the on-chain
  integration. Need: deployment status/timeline + the authoritative repo/branch.

## Q3. Which environment should the CLI treat as canonical test target? (MED-HIGH)
- **Why:** All public pools are expired right now (mainnet 2, Arbitrum 3 — expired 2026-07-12);
  live pools exist only on Cork's "virtual" chain 49222 and on the euler-research vnet (chainId
  1 clone). Tool development + CI parity tests need a stable, unexpired target.
- **Tried:** enumerated api-phoenix pools across chains; verified the brief's vnet is chainId 1
  with two live vnet-only markets (created ~2026-07-03, expiring ~2026-09-28/30).
- **Best guess:** CI forks the brief's vnet at a pinned block + the two vnet-only markets;
  chain-49222 RPC URL would be better if shareable. Need: the 49222 RPC URL + whether new
  mainnet/Arbitrum pools launch soon (cadence?).

## Q4. depeg-frontend branch authority + Arbitrum config source (MED)
- **Why:** §3 says ask which branch is authoritative per environment; also prod.toml has no
  Arbitrum section yet Arbitrum has deployed pools (same addresses) — where is Arbitrum's
  canonical config?
- **Tried:** fetched `pre-prod` mainnet.config.ts (matches prod.toml addresses + adds permit2,
  bundler3, 1inch LOP); did not enumerate other branches/config files deeply.
- **Best guess:** `pre-prod` = staging truth, `main`/prod = release truth; Arbitrum config lives
  in a newer phoenix commit or a separate ops repo. Need confirmation + the Arbitrum entry.

## Q5. RFQ system (Goal 3) inputs — where do the 50–100 pre-seeded tokens and risk metrics come from? (MED, blocks Goal 3 only)
- **Why:** Goal 3's RFQ needs per-market LLM-assessed config in a "public shared DB" + token
  risk stats. No trace of this exists in any repo/API I saw (api-phoenix has no RFQ endpoints).
- **Tried:** api-phoenix OpenAPI, cork-indexing-api source, docs.
- **Best guess:** greenfield — we define the schema + seed pipeline (HyperSync Parquet for
  metrics). Need: your intended pricing formula inputs (market-type buckets, duration → cost of
  capital curve) or the meeting artifacts describing them.

## Q6. Enrichment references: is docs.cork.tech stable enough to deep-link, and is the
`Cork-Technology/docs` gitbook branch the canonical mirror? (LOW-MED)
- **Why:** JSON outputs carry wiki/doc links; the site Cloudflare-blocks bots (curl/agents), the
  repo mirror doesn't. One docs page also contradicts code (MarketId definition, D4).
- **Tried:** llms.txt indexing, repo mirror fetch, cross-checked MarketId page vs code.
- **Best guess:** link both site URL (humans) + repo-pinned raw URL (agents); flag known-wrong
  pages. Need: who owns docs fixes (report D4/D8 upstream?).

## Q7. Whitelist governance surface (LOW)
- **Why:** `poolWhitelistStatus` is Governor/DevTeam-set off-chain metadata per the brief, but
  on-chain WhitelistManager fully determines it; the brief's phrase suggests an off-chain
  process feeding on-chain state. For the `meta` tool group: do we expose only on-chain truth,
  or also the pending/governance intent?
- **Tried:** WhitelistManager events + API whitelisted-addresses endpoint (both on-chain-derived).
- **Best guess:** on-chain truth only for v1. Need: whether a governance pipeline (timelock
  queue) should be surfaced as "pending whitelist changes".

## Q8. HyperSync token UX for Full-Decentralized mode (LOW — design caveat already noted)
- **Why:** tokens are mandatory since Nov 2025; free-tier limits unpublished. "Decentralized"
  mode with a mandatory SaaS token (and github.com config fetch) needs honest labeling.
- **Tried:** envio docs/FAQ (agent research, sources in notes).
- **Best guess:** ship mode as "self-sourced" (user's token, user's RPCs) + document the trust
  model; offer plain-RPC slow-scan fallback. Need: your appetite for an in-house indexer
  endpoint as a fourth semi-centralized option (cork-indexing-api already exists!).
