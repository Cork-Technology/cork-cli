// Variant-level tool search [R6 / RFC §5.8]: token-overlap scoring over each tool's name, CLI
// path, description, example titles, AND per-variant hint phrases — so a natural-language query
// like "executed trades history" resolves to cork_query → fills even though no tool description
// contains those words. Substring token matching keeps simple stems working ("trade" ⊂ "trades",
// "bundle" ⊂ "Bundler3") without a stemmer.
import { REGISTRY, type ToolName } from "./registry.ts";
import { TOOL_EXAMPLES } from "./examples.ts";

export interface SearchHint {
  /** Variant this phrase points at (a resource / kind / action.type, or a mode/subject path). */
  variant: string;
  /** Space-separated phrases users and agents actually say for this variant. */
  text: string;
}

export const SEARCH_HINTS: Record<ToolName, readonly SearchHint[]> = {
  cork_query: [
    { variant: "market", text: "live market state pool tuple rates read on-chain snapshot" },
    { variant: "markets", text: "list all pools markets discovery enumerate" },
    { variant: "account-state", text: "balances account holdings tokens positions owned" },
    { variant: "pool-whitelist", text: "whitelist whitelisted allowed access check account" },
    { variant: "whitelisted-addresses", text: "whitelisted addresses list rows per pool" },
    { variant: "flows", text: "flows user action history activity past actions timeline" },
    { variant: "orderbook", text: "orderbook open resting limit orders book depth quotes" },
    { variant: "fills", text: "fills executed trades trade history filled orders past swaps" },
    { variant: "limit-order-markets", text: "limit order markets trading pairs listed" },
    { variant: "protocol-config", text: "deployed contract addresses protocol config fees bounds" },
    { variant: "registry-assets", text: "registry approved assets eligible tokens market ingredients whitelisted assets price source nav source denomination" },
    { variant: "registry-oracle", text: "rate oracle status pair wrapper deployed deployable price nav mode fixed rate oracle exists" },
    { variant: "registry-recipes", text: "recipes approved recipe contracts addresses constraint policy liquidity fixed constants args isRecipe" },
    { variant: "registry-denominations", text: "denominations labels units USD ETH USDS label hash case sensitive currency" },
    { variant: "registry-feeds", text: "conversion feeds chainlink aggregator edges base quote live answer decimals drift usd graph" },
    { variant: "market-predict", text: "predict market pool id cST cPT shares principal token before it exists jit derive oracle rate constraint preview what pool would a fill create addresses" },
    { variant: "rfqs", text: "rfq request for quote list open requests answers underwriter discovery feed poll" },
  ],
  cork_compute: [
    { variant: "cst-swap-rate", text: "swap rate cost quote price collateral out preview how much" },
    { variant: "unwind-rate", text: "unwind rate quote reverse swap preview put back" },
    { variant: "dutch-auction-price", text: "dutch auction current price fusion decay order now" },
    { variant: "rollover-premium-floor", text: "rollover premium floor minimum guaranteed" },
    { variant: "impairment-floor", text: "impairment floor worst case horizon rate limited depeg loss" },
    { variant: "rfq-quote", text: "rfq request for quote market maker" },
    { variant: "resolve-recipe", text: "resolve recipe constraint four rate limits sign order staticcall anchor rate additionalData" },
  ],
  cork_decode: [
    { variant: "calldata", text: "decode calldata bytes hex explain transaction bundler3 multicall legs what does this do" },
    { variant: "order", text: "decode limit order struct makertraits" },
    { variant: "event", text: "decode event log topics" },
    { variant: "receipt", text: "decode classify receipt outcome" },
  ],
  cork_capabilities: [
    { variant: "search", text: "find tool help manual discover which tool how do i" },
    { variant: "verify", text: "verify addresses create2 re-derive attestation trust" },
  ],
  cork_prepare_phoenix: [
    { variant: "deposit", text: "deposit mint bundle enter position provide collateral shares" },
    { variant: "swap", text: "swap coverage payout collateral out protection" },
    { variant: "exercise", text: "exercise lock cst claim coverage" },
    { variant: "unwind-swap", text: "unwind undo reverse covered position repurchase exit" },
    { variant: "withdraw", text: "withdraw redeem post-expiry settle burn shares claim" },
    { variant: "authority-onboard", text: "permit2 approve allowance onboard token authority standing" },
    { variant: "authority-revoke", text: "revoke allowance zero approval remove spender" },
  ],
  cork_prepare_orders: [
    { variant: "maker-order", text: "limit order maker sign typed data sell buy place resting" },
    { variant: "maker-order/jitMarket", text: "jit just in time market creation mint fill hook adapter create market via order coverage" },
    { variant: "taker-fill", text: "fill take order taker execute against" },
    { variant: "cancel", text: "cancel invalidate order remove resting" },
    { variant: "rollover-intent", text: "rollover intent erc-7683 settler roll position next expiry" },
  ],
  cork_prepare_market: [
    { variant: "deploy-wrapper", text: "deploy oracle wrapper rate feed pair create registry permissionless idempotent price nav mode" },
    { variant: "deploy-fixed-oracle", text: "deploy fixed rate oracle rateOverride create2 salted permissionless idempotent" },
  ],
  cork_track: [
    { variant: "verify/marketRef", text: "verify pool market against chain rehash marketid check" },
    { variant: "verify/artifact", text: "digest pin artifact verify bundle handed" },
    { variant: "reconcile/txHash", text: "transaction receipt status landed mined did it succeed confirm" },
    { variant: "simulate", text: "simulate dry run bundle bytes advisory" },
  ],
  cork_submit: [{ variant: "submit", text: "submit relay broadcast signed order orderbook send" }],
};

const STOPWORDS = new Set([
  "the", "for", "and", "with", "that", "this", "from", "into", "onto",
  "of", "a", "an", "to", "in", "on", "is", "are", "was", "it", "its",
  "my", "me", "i", "you", "do", "does", "did", "how", "what", "which",
  "can", "could", "should", "would", "get", "cork",
]);

function tokenize(q: string): string[] {
  return [
    ...new Set(
      q
        .toLowerCase()
        .split(/[^a-z0-9-]+/)
        .filter((t) => t.length >= 3 && !STOPWORDS.has(t)),
    ),
  ];
}

function hits(tokens: string[], corpus: string): number {
  return tokens.filter((t) => corpus.includes(t)).length;
}

export interface ToolSearchResult {
  name: ToolName;
  score: number;
  /** Present when the best evidence came from a variant-level hint. */
  variant?: string;
}

/** Rank tools (and their best-matching variant) for a natural-language query. */
export function searchTools(query: string, limit = 5): ToolSearchResult[] {
  const tokens = tokenize(query);
  if (tokens.length === 0) return [];

  const results: ToolSearchResult[] = [];
  for (const t of REGISTRY) {
    const toolCorpus = [
      t.name,
      t.cliPath.join(" "),
      t.description,
      ...(TOOL_EXAMPLES[t.name]?.map((e) => e.title) ?? []),
    ]
      .join(" ")
      .toLowerCase();
    const toolScore = hits(tokens, toolCorpus);

    let bestVariant: { variant: string; score: number } | undefined;
    for (const h of SEARCH_HINTS[t.name] ?? []) {
      const s = hits(tokens, `${h.variant} ${h.text}`.toLowerCase());
      if (s > 0 && (!bestVariant || s > bestVariant.score)) bestVariant = { variant: h.variant, score: s };
    }

    // Variant evidence is weighted above generic tool-description evidence: a query naming a
    // specific capability should rank the tool serving that capability first.
    const score = toolScore + (bestVariant ? bestVariant.score * 2 : 0);
    if (score > 0) {
      results.push({ name: t.name, score, ...(bestVariant ? { variant: bestVariant.variant } : {}) });
    }
  }
  return results.sort((a, b) => b.score - a.score).slice(0, limit);
}
