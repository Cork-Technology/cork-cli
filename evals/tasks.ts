// Agent-eval task set [v2 §5.7 / RFC §13]: realistic tasks with programmatically verifiable
// outcomes, graded on the tool-call TRACE (selection, variant, parameters, call count) rather
// than free-text — per Anthropic's tool-eval guidance. ~20 active + 5 HELD OUT (the held-out set
// catches description overfitting; include with EVAL_HELD_OUT=1 and never tune against it).
import { DEMO_POOL_ID, DEMO_ACCOUNT } from "@cork/schemas";

export interface Expectation {
  /** The tool the agent should reach for first. */
  tool: string;
  /** Deep-subset match against the FIRST call to that tool (checks discriminators + key params). */
  params?: Record<string, unknown>;
  /** Envelope state the tool returned for that call. */
  state?: "ok" | "unavailable" | "conflict";
  /** warnings[0].code expected on a gated outcome. */
  code?: string;
  /** Regex the agent's final text answer must match. */
  answer?: RegExp;
  /** Trace budget — more calls than this counts as inefficiency. */
  maxCalls: number;
}

export interface EvalTask {
  id: string;
  prompt: string;
  expect: Expectation;
  heldOut?: boolean;
}

const P = DEMO_POOL_ID;
const A = DEMO_ACCOUNT;

export const TASKS: EvalTask[] = [
  // ── reads ──────────────────────────────────────────────────────────────
  { id: "read-market", prompt: `Read the current on-chain state of Cork pool ${P} and tell me the swap rate.`, expect: { tool: "cork_query", params: { resource: "market" }, state: "ok", answer: /0\.8|800000000000000000/, maxCalls: 2 } },
  { id: "read-balances", prompt: `What token balances does account ${A} hold in Cork pool ${P}?`, expect: { tool: "cork_query", params: { resource: "account-state" }, state: "ok", maxCalls: 2 } },
  { id: "read-config", prompt: "Which contract address is the Cork adapter deployed at on mainnet?", expect: { tool: "cork_query", params: { resource: "protocol-config" }, state: "ok", answer: /0xCCcCcCCCcccCBaD6F772a511B337d9CCc9570407/i, maxCalls: 2 } },
  { id: "read-whitelist", prompt: `Is ${A} whitelisted on Cork pool ${P}?`, expect: { tool: "cork_query", params: { resource: "pool-whitelist" }, state: "ok", answer: /not whitelisted|false|no\b/i, maxCalls: 2 } },
  { id: "venue-orderbook", prompt: `Fetch the current Cork orderbook for pool ${P} and tell me how many resting orders there are.`, expect: { tool: "cork_query", params: { resource: "orderbook" }, state: "ok", answer: /\b0\b|zero|no (resting )?orders|empty/i, maxCalls: 2 } },
  { id: "whitelist-enumerate", prompt: "List ALL whitelisted addresses across Cork pools (the full enumeration, not a single-account check).", expect: { tool: "cork_query", params: { resource: "whitelisted-addresses" }, state: "ok", answer: /0x0{0,30}a11ce/i, maxCalls: 2 } },
  { id: "rollover-feed", prompt: "Show me the currently fillable Cork rollover orders on Arbitrum (chain 42161).", expect: { tool: "cork_query", params: { resource: "flows" }, state: "ok", maxCalls: 2 } },
  // ── compute ────────────────────────────────────────────────────────────
  { id: "price-swap", prompt: `How much cST and reference asset would it cost right now to take 1 sUSDe (1e18) of collateral out of Cork pool ${P}?`, expect: { tool: "cork_compute", params: { params: { kind: "cst-swap-rate" } }, state: "ok", maxCalls: 2 } },
  { id: "price-unwind", prompt: `Quote the unwind: putting 5e18 collateral back into Cork pool ${P} — what comes out?`, expect: { tool: "cork_compute", params: { params: { kind: "unwind-rate" } }, state: "ok", maxCalls: 2 } },
  { id: "impairment", prompt: `What is the worst-case impairment floor for Cork pool ${P} over the next 3 days? Remember the floor is rate-limited, not minRate.`, expect: { tool: "cork_compute", params: { params: { kind: "impairment-floor", horizonSeconds: 259200 } }, state: "ok", maxCalls: 2 } },
  { id: "rollover-floor", prompt: "If a rollover produces 500e18 destination cST with a minimum premium of 0.01e18 per share, what is the guaranteed premium floor?", expect: { tool: "cork_compute", params: { params: { kind: "rollover-premium-floor" } }, state: "ok", answer: /5000000000000000000|5e18|5\.0/, maxCalls: 2 } },
  { id: "gated-dutch", prompt: `Price the Dutch auction for this Cork limit order right now: {"maker":"${A}","salt":"1"}.`, expect: { tool: "cork_compute", params: { params: { kind: "dutch-auction-price" } }, state: "unavailable", code: "phase_gated", maxCalls: 2 } },
  // ── prepare ────────────────────────────────────────────────────────────
  { id: "prepare-deposit", prompt: `Build me an unsigned bundle that deposits 10 sUSDe (10e18) into Cork pool ${P} for receiver ${A}, minimum 1 share out, request id "eval-dep-0001". Use erc20-approve funding.`, expect: { tool: "cork_prepare_phoenix", params: { action: { type: "deposit", poolId: P } }, state: "ok", maxCalls: 2 } },
  { id: "prepare-swap", prompt: `Prepare an unsigned Cork swap: I want exactly 1e18 collateral out of pool ${P}, receiver ${A}, willing to spend at most 2e18 cST and 2e6 reference. Request id "eval-swap-0001".`, expect: { tool: "cork_prepare_phoenix", params: { action: { type: "swap" } }, state: "ok", maxCalls: 2 } },
  { id: "prepare-unwind", prompt: `I hold a locked Cork position in pool ${P}. Prepare the unwind-swap bundle: 3e18 collateral back in, receiver ${A}, no slippage floors, request id "eval-unw-0001".`, expect: { tool: "cork_prepare_phoenix", params: { action: { type: "unwind-swap" } }, state: "ok", maxCalls: 2 } },
  { id: "prepare-order", prompt: `Create the signable 1inch maker order selling 1 sUSDe (${"1000000000000000000"}) for 1 vbUSDC (1000000) on Cork pool ${P}: maker ${A}, sUSDe is 0x9D39A5DE30e57443BfF2A8307A4256c8797A3497, vbUSDC is 0x53E82ABbb12638F09d9e624578ccB666217a765e, request id "eval-ord-0001".`, expect: { tool: "cork_prepare_orders", params: { action: { type: "maker-order", side: "SELL" } }, state: "ok", maxCalls: 2 } },

  // ── parameter-accuracy probes (from the 2026-07 live A/B pass — each pins the EXACT value,
  //    catching the measured DeFi failure classes: decimal scaling, base-unit pass-through,
  //    whole-number scaling, absolute-vs-relative deadlines, near-twin variant selection) ──
  { id: "param-scale-decimal", prompt: `Build an unsigned bundle depositing exactly 2.5 sUSDe (sUSDe has 18 decimals) into Cork pool ${P}, receiver ${A}, at least 1 share-pair wei out, pre-funded, request id "eval-scale-0001".`, expect: { tool: "cork_prepare_phoenix", params: { action: { type: "deposit", collateralAssetsIn: "2500000000000000000", minCptAndCstSharesOut: "1" } }, state: "ok", maxCalls: 2 } },
  { id: "param-passthrough-baseunits", prompt: `Cork pool ${P} has expired. I hold CPT and want to settle for EXACTLY 100000000 base units of the pool's REFERENCE asset (not the collateral). Owner and receiver ${A}, cap CPT burned at 1000000000000000000000, pre-funded, request id "eval-pass-0001". Build the unsigned bundle.`, expect: { tool: "cork_prepare_phoenix", params: { action: { type: "withdraw-other", referenceAssetsOut: "100000000" } }, state: "ok", maxCalls: 2 } },
  { id: "param-absolute-deadline", prompt: `Prepare an unsigned Cork swap on pool ${P}: exactly 1000000000000000000 collateral out, receiver ${A}, cap cST in at 2000000000000000000 and reference in at 2000000, pre-funded, request id "eval-dead-0001". The bundle must stop being valid exactly at unix timestamp 1795000000 and a later retry must be byte-identical.`, expect: { tool: "cork_prepare_phoenix", params: { deadlineAt: "1795000000", action: { type: "swap" } }, state: "ok", maxCalls: 2 } },
  { id: "param-scale-wholenumber", prompt: `What is the guaranteed minimum premium for a Cork rollover producing 1000 destination cST (an 18-decimals token) at a minimum premium per share of 0.02 (also 18 decimals)? Pure math.`, expect: { tool: "cork_compute", params: { params: { kind: "rollover-premium-floor", dstCstProduced: "1000000000000000000000", minPremiumPerShare: "20000000000000000" } }, state: "ok", maxCalls: 2 } },
  { id: "prepare-rollover", prompt: `Build me a signable Cork rollover order on Arbitrum (chain 42161): roll 250e18 srcCST via the ExactSettler 0x983270AE48545665Cee4D7EF61C65fF3fdC8222D, my rollover clone is ${A}, src pool 0x1111111111111111111111111111111111111111111111111111111111111111, dst pool 0x2222222222222222222222222222222222222222222222222222222222222222, srcCST 0x9D39A5DE30e57443BfF2A8307A4256c8797A3497, dstCST 0x53E82ABbb12638F09d9e624578ccB666217a765e, premium token = srcCST, min premium per share 0.012e18, open by 1795000000, fill by 1795604800, request id "eval-roll-0001".`, expect: { tool: "cork_prepare_orders", params: { action: { type: "rollover-intent" } }, state: "ok", maxCalls: 2 } },
  // ── decode / track ─────────────────────────────────────────────────────
  { id: "decode-bundle", prompt: "Decode this Cork calldata and tell me which adapter action it performs: use the worked example bytes from the cork_decode tool's own example.", expect: { tool: "cork_capabilities", maxCalls: 3 } },
  { id: "track-digest", prompt: `Compute the content digest for this artifact so I can pin it: {"poolId":"${P}","note":"eval"}.`, expect: { tool: "cork_track", params: { mode: "verify", subject: { kind: "artifact" } }, state: "ok", maxCalls: 2 } },
  { id: "track-receipt", prompt: "Reconcile transaction 0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa on mainnet — did it succeed?", expect: { tool: "cork_track", params: { mode: "reconcile", subject: { kind: "txHash" } }, state: "ok", answer: /success/i, maxCalls: 2 } },
  { id: "verify-pool", prompt: `Verify that Cork pool ${P} on chain matches its market id (re-hash check).`, expect: { tool: "cork_track", params: { mode: "verify", subject: { kind: "marketRef", poolId: P } }, state: "ok", maxCalls: 2 } },
  // ── discovery ──────────────────────────────────────────────────────────
  { id: "discover-unwind", prompt: "I'm new to these Cork tools. Which tool and variant do I use to undo a covered position, and what does an invocation look like?", expect: { tool: "cork_capabilities", params: { search: "unwind" }, state: "ok", maxCalls: 2 } },

  // ── HELD OUT (never tune descriptions against these) ───────────────────
  { id: "ho-mode-reject", heldOut: true, prompt: `Read Cork pool ${P} state using the centralized data mode.`, expect: { tool: "cork_query", params: { mode: "centralized" }, state: "unavailable", code: "mode_unavailable", maxCalls: 3 } },
  { id: "ho-wrong-then-right", heldOut: true, prompt: `Get me the swap fee percentage of Cork pool ${P}.`, expect: { tool: "cork_query", params: { resource: "market" }, state: "ok", answer: /5e16|50000000000000000|0\.05/, maxCalls: 3 } },
  { id: "ho-authority", heldOut: true, prompt: `Prepare a Permit2 onboarding for token 0x9D39A5DE30e57443BfF2A8307A4256c8797A3497 spender 0xCCcCcCCCcccCBaD6F772a511B337d9CCc9570407, request id "eval-auth-0001".`, expect: { tool: "cork_prepare_phoenix", params: { action: { type: "authority-onboard" } }, state: "ok", maxCalls: 2 } },
  { id: "ho-cancel", heldOut: true, prompt: `Build the cancel calldata for my resting Cork order 0x2222222222222222222222222222222222222222222222222222222222222222 (maker traits 0), account ${A}, request id "eval-can-0001".`, expect: { tool: "cork_prepare_orders", params: { action: { type: "cancel" } }, state: "ok", maxCalls: 2 } },
  { id: "ho-nonexistent-pool", heldOut: true, prompt: "Read the live market state of Cork pool 0x1111111111111111111111111111111111111111111111111111111111111111.", expect: { tool: "cork_query", params: { resource: "market" }, state: "unavailable", code: "chain_read_failed", answer: /not exist|failed|revert|unavailable/i, maxCalls: 3 } },
];
