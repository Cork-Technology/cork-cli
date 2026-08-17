// Agent-eval task set [v2 §5.7 / RFC §13]: realistic tasks with programmatically verifiable
// outcomes, graded on the tool-call TRACE (selection, variant, parameters, call count) rather
// than free-text — per Anthropic's tool-eval guidance. 30+ active + 5 HELD OUT (the held-out set
// catches description overfitting; include with EVAL_HELD_OUT=1 and never tune against it).
import { DEMO_POOL_ID, DEMO_ACCOUNT, DEMO_SIGNED_TX } from "@cork/schemas";
// Recipe addresses come from the SAME config-tracking constants the stub answers isRecipe with —
// a pinned literal here rotted on the 0.3.3 redeploy (recipe_not_found on a task that once passed).
import { CST, LIQUIDITY_RECIPE, RESTING_ORDER_HASH } from "./stub.ts";
import corkDefaults from "../cork-defaults.json";

// The mainnet adapter, read from config instead of re-pinned (the pinned-literal rot class the
// stub's own header documents). Held-out tasks keep their inline copies untouched by rule.
const MAINNET_ADAPTER = (corkDefaults as { deployments: Record<string, { corkAdapter?: string }> }).deployments["1"]!.corkAdapter!;
// The mainnet 1inch LOP — the spender the approval tasks expect the agent to NAME (it is the
// `spender` field of data.approvals entries, so a correct answer must surface it).
const MAINNET_LOP = (corkDefaults as { lopAddresses: Record<string, string> }).lopAddresses["1"]!;

export interface Expectation {
  /** The tool the agent should reach for first. */
  tool: string;
  /** First-call tools that ALSO count as a correct pick — e.g. a cork_capabilities discovery
   *  hop before the target tool. The target `tool` is still what params/state grade against. */
  prelude?: string[];
  /** Deep-subset match against SOME schema-valid call to `tool` (discriminators + key params). */
  params?: Record<string, unknown>;
  /** Envelope state SOME schema-valid call to `tool` must have reached (same call must also
   *  match `params` when given — outcome grading, not first-attempt grading: a recovered miss
   *  is a pass here and shows up in the `efficient`/`recovered` axes instead). */
  state?: "ok" | "unavailable" | "conflict";
  /** A warning code the matching call must carry — matched against EVERY warning on the
   *  envelope (not just the first; a multi-warning result must not fail on ordering). */
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

// The decode kind:"tx" fixture — the schemas-exported constant (bound to in-test deterministic
// signing by packages/core/test/decode-tx.test.ts, so it cannot drift from the demo bytes).
const SIGNED_TX = DEMO_SIGNED_TX;

export const TASKS: EvalTask[] = [
  // ── reads ──────────────────────────────────────────────────────────────
  { id: "read-market", prompt: `Read the current on-chain state of Cork pool ${P} and tell me the swap rate.`, expect: { tool: "cork_query", params: { resource: "cork-pool" }, state: "ok", answer: /0\.8|800000000000000000/, maxCalls: 2 } },
  { id: "read-balances", prompt: `What token balances does account ${A} hold in Cork pool ${P}?`, expect: { tool: "cork_query", params: { resource: "account-state" }, state: "ok", maxCalls: 2 } },
  { id: "read-config", prompt: "Which contract address is the Cork adapter deployed at on mainnet?", expect: { tool: "cork_query", params: { resource: "protocol-config" }, state: "ok", answer: new RegExp(MAINNET_ADAPTER, "i"), maxCalls: 2 } },
  { id: "read-whitelist", prompt: `Is ${A} whitelisted on Cork pool ${P}?`, expect: { tool: "cork_query", params: { resource: "pool-whitelist" }, state: "ok", answer: /not whitelisted|false|no\b/i, maxCalls: 2 } },
  { id: "venue-orderbook", prompt: `Fetch the current Cork orderbook for pool ${P} and tell me how many resting orders there are.`, expect: { tool: "cork_query", params: { resource: "orderbook" }, state: "ok", answer: /\b0\b|zero|no (resting )?orders|empty/i, maxCalls: 2 } },
  { id: "whitelist-enumerate", prompt: "List ALL whitelisted addresses across Cork pools (the full enumeration, not a single-account check).", expect: { tool: "cork_query", params: { resource: "whitelisted-addresses" }, state: "ok", answer: /a11ce/i, maxCalls: 2 } },
  { id: "rollover-feed", prompt: "Show me the currently fillable Cork rollover orders on Arbitrum (chain 42161).", expect: { tool: "cork_query", params: { resource: "rollover-orders" }, state: "ok", maxCalls: 2 } },
  // ── compute ────────────────────────────────────────────────────────────
  { id: "price-swap", prompt: `How much cST and reference asset would it cost right now to take 1 sUSDe (1e18) of collateral out of Cork pool ${P}?`, expect: { tool: "cork_compute", params: { params: { kind: "cst-swap-rate" } }, state: "ok", maxCalls: 2 } },
  { id: "price-unwind", prompt: `Quote the unwind: putting 5e18 collateral back into Cork pool ${P} — what comes out?`, expect: { tool: "cork_compute", params: { params: { kind: "unwind-rate" } }, state: "ok", maxCalls: 2 } },
  { id: "impairment", prompt: `What is the worst-case impairment floor for Cork pool ${P} over the next 3 days? Remember the floor is rate-limited, not minRate.`, expect: { tool: "cork_compute", params: { params: { kind: "impairment-floor", horizonSeconds: 259200 } }, state: "ok", maxCalls: 2 } },
  { id: "rollover-floor", prompt: "If a rollover produces 500e18 destination cST with a minimum premium of 0.01e18 per share, what is the guaranteed premium floor?", expect: { tool: "cork_compute", params: { params: { kind: "rollover-premium-floor" } }, state: "ok", answer: /5000000000000000000|5e18|5\.0/, maxCalls: 2 } },
  { id: "price-dutch", prompt: `Price this 1inch Fusion dutch-auction order AT unix time 1787962200 exactly (pin the evaluation moment): {"salt":"72116775394861435818731221900729193628876322478708569","maker":"${A}","receiver":"0x0000000000000000000000000000000000000000","makerAsset":"0x9D39A5DE30e57443BfF2A8307A4256c8797A3497","takerAsset":"0x53E82ABbb12638F09d9e624578ccB666217a765e","makingAmount":"1000000000000000000","takingAmount":"1000000","makerTraits":"904625697166532776746648320380374280103671755200316906558262375061821325312","extension":"0x0000006e0000006e0000006e0000006e0000006e0000003700000000000000002ad5004c60e16e54d5007c80ce329adde5b51ef5000000000000006a922100000e100f4240020aae6003840493e00384000000000000002ad5004c60e16e54d5007c80ce329adde5b51ef5000000000000006a922100000e100f4240020aae6003840493e0038400000000000000"}. What does a taker pay for the full making amount?`, expect: { tool: "cork_compute", params: { params: { kind: "dutch-auction-price" }, at: { timestamp: "1787962200" } }, state: "ok", answer: /1[,_]?080[,_]?000|1\.08/, maxCalls: 2 } },
  // ── prepare ────────────────────────────────────────────────────────────
  { id: "prepare-deposit", prompt: `Build me an unsigned bundle that deposits 10 sUSDe (10e18) into Cork pool ${P} for receiver ${A}, minimum 1 share out, request id "eval-dep-0001". Use erc20-approve funding.`, expect: { tool: "cork_prepare_phoenix", params: { action: { type: "deposit", poolId: P } }, state: "ok", maxCalls: 2 } },
  { id: "prepare-swap", prompt: `Prepare an unsigned Cork swap: I want exactly 1e18 collateral out of pool ${P}, receiver ${A}, willing to spend at most 2e18 cST and 2e6 reference. Request id "eval-swap-0001".`, expect: { tool: "cork_prepare_phoenix", params: { action: { type: "swap" } }, state: "ok", maxCalls: 2 } },
  // prelude includes cork_query: "a locked position I hold" legitimately invites a state-verify
  // hop before building (observed 1-in-3 on sonnet, 2026-08-12 re-trial; params/state 100% on
  // every trial) — a correct-behavior first call, not a wrong tool pick.
  { id: "prepare-unwind", prompt: `I hold a locked Cork position in pool ${P}. Prepare the unwind-swap bundle: 3e18 collateral back in, receiver ${A}, no slippage floors, request id "eval-unw-0001".`, expect: { tool: "cork_prepare_phoenix", prelude: ["cork_capabilities", "cork_query"], params: { action: { type: "unwind-swap" } }, state: "ok", maxCalls: 3 } },
  { id: "prepare-order", prompt: `Create the signable 1inch maker order selling 1 sUSDe (${"1000000000000000000"}) for 1 vbUSDC (1000000) on Cork pool ${P}: maker ${A}, sUSDe is 0x9D39A5DE30e57443BfF2A8307A4256c8797A3497, vbUSDC is 0x53E82ABbb12638F09d9e624578ccB666217a765e, request id "eval-ord-0001".`, expect: { tool: "cork_prepare_orders", params: { action: { type: "maker-order", side: "SELL" } }, state: "ok", maxCalls: 2 } },

  // ── token approvals across the order lifecycle (data.approvals; the underwriter/hedger ask:
  //    WHICH grants, to WHOM, WHEN — and the unsigned payload). The stub answers allowance 0,
  //    so every required grant reads confirmed-missing and approval_missing rides. ──
  {
    id: "approvals-maker-order",
    prompt: `I am an underwriter about to sign and list a 1inch maker order on Cork pool ${P}: selling 1 sUSDe (1000000000000000000, token 0x9D39A5DE30e57443BfF2A8307A4256c8797A3497) for 1 vbUSDC (1000000, token 0x53E82ABbb12638F09d9e624578ccB666217a765e), maker ${A}, request id "eval-appr-0001". Before I sign: which token approvals must be in place for this order to be fillable, who exactly is the spender, are they in place right now — and give me the unsigned approve transaction if not.`,
    expect: {
      tool: "cork_prepare_orders",
      // "are they in place right now?" legitimately invites a state-verify hop (account-state /
      // pool read) before AND a re-check after building — the prepare-unwind precedent
      // (observed on the 2026-08-17 first run: query, query, prepare, query — all correct).
      prelude: ["cork_capabilities", "cork_query"],
      params: { action: { type: "maker-order" } },
      state: "ok",
      code: "approval_missing",
      // A correct answer surfaces data.approvals: it names the LOP as the spender AND states a
      // negative grant status (agents phrase it as prose OR as a table cell — "current 0",
      // "❌", "not satisfied" — so the alternation covers both registers). The address match is
      // a distinctive 12-hex PREFIX, not the full 40: agents routinely ellipsize addresses
      // (`0x1111…2A65`), and requiring the full spelling grades formatting, not correctness.
      answer: new RegExp(`(?=[\\s\\S]*${MAINNET_LOP.slice(2, 14)})(?=[\\s\\S]*(missing|not in place|not currently|no allowance|not satisfied|unsatisfied|current(ly)?\\W{0,3}0\\b|❌|zero))`, "i"),
      maxCalls: 4,
    },
  },
  {
    id: "approvals-permit2-layers",
    prompt: `Build the same signable Cork maker order but sourced through Permit2: selling 1000000000000000000 of 0x9D39A5DE30e57443BfF2A8307A4256c8797A3497 for 1000000 of 0x53E82ABbb12638F09d9e624578ccB666217a765e on pool ${P}, maker ${A}, expiry 3600 seconds, request id "eval-appr-0002". Then explain EVERY allowance layer I must grant for a fill to succeed, and where each grant transaction is sent.`,
    expect: {
      tool: "cork_prepare_orders",
      prelude: ["cork_capabilities"],
      params: { action: { type: "maker-order", usePermit2: true } },
      state: "ok",
      // Both layers surfaced: the canonical Permit2 contract (layer 1's spender, layer 2's tx
      // target) and the two-layer framing from the entries.
      answer: /(?=[\s\S]*000000000022D473030F116dDEE9F6B43aC78BA3)(?=[\s\S]*(two|both|layer))/i,
      maxCalls: 3,
    },
  },

  // ── parameter-accuracy probes (from the 2026-07 live A/B pass — each pins the EXACT value,
  //    catching the measured DeFi failure classes: decimal scaling, base-unit pass-through,
  //    whole-number scaling, absolute-vs-relative deadlines, near-twin variant selection) ──
  { id: "param-scale-decimal", prompt: `Build an unsigned bundle depositing exactly 2.5 sUSDe (sUSDe has 18 decimals) into Cork pool ${P}, receiver ${A}, at least 1 share-pair wei out, pre-funded, request id "eval-scale-0001".`, expect: { tool: "cork_prepare_phoenix", params: { action: { type: "deposit", collateralAssetsIn: "2500000000000000000", minCptAndCstSharesOut: "1" } }, state: "ok", maxCalls: 2 } },
  { id: "param-passthrough-baseunits", prompt: `Cork pool ${P} has expired. I hold CPT and want to settle for EXACTLY 100000000 base units of the pool's REFERENCE asset (not the collateral). Owner and receiver ${A}, cap CPT burned at 1000000000000000000000, pre-funded, request id "eval-pass-0001". Build the unsigned bundle.`, expect: { tool: "cork_prepare_phoenix", params: { action: { type: "withdraw-other", referenceAssetsOut: "100000000" } }, state: "ok", maxCalls: 2 } },
  { id: "param-absolute-deadline", prompt: `Prepare an unsigned Cork swap on pool ${P}: exactly 1000000000000000000 collateral out, receiver ${A}, cap cST in at 2000000000000000000 and reference in at 2000000, pre-funded, request id "eval-dead-0001". The bundle must stop being valid exactly at unix timestamp 1795000000 and a later retry must be byte-identical.`, expect: { tool: "cork_prepare_phoenix", params: { deadlineAt: "1795000000", action: { type: "swap" } }, state: "ok", maxCalls: 2 } },
  { id: "param-scale-wholenumber", prompt: `What is the guaranteed minimum premium for a Cork rollover producing 1000 destination cST (an 18-decimals token) at a minimum premium per share of 0.02 (also 18 decimals)? Pure math.`, expect: { tool: "cork_compute", params: { params: { kind: "rollover-premium-floor", dstCstProduced: "1000000000000000000000", minPremiumPerShare: "20000000000000000" } }, state: "ok", maxCalls: 2 } },
  { id: "prepare-rollover", prompt: `Build me a signable Cork rollover order on Arbitrum (chain 42161): roll 250e18 srcCST via the ExactSettler 0x983270AE48545665Cee4D7EF61C65fF3fdC8222D, my rollover clone is ${A}, src pool 0x1111111111111111111111111111111111111111111111111111111111111111, dst pool 0x2222222222222222222222222222222222222222222222222222222222222222, srcCST 0x9D39A5DE30e57443BfF2A8307A4256c8797A3497, dstCST 0x53E82ABbb12638F09d9e624578ccB666217a765e, premium token = srcCST, min premium per share 0.012e18, open by 1795000000, fill by 1795604800, request id "eval-roll-0001".`, expect: { tool: "cork_prepare_orders", prelude: ["cork_capabilities"], params: { action: { type: "rollover-intent" } }, state: "ok", maxCalls: 3 } },
  // ── registry 2.1.0 (recipes as contracts; the constraint an order signs) ──
  {
    id: "registry-recipes",
    prompt: "List the approved recipe contracts on the Arbitrum Cork market registry (chain 42161) and tell me the argument shape the liquidity recipe takes.",
    expect: { tool: "cork_query", params: { resource: "registry-recipes" }, state: "ok", answer: /anchorRate|\(uint256\)/i, maxCalls: 2 },
  },
  {
    id: "resolve-constraint",
    prompt: `Resolve the four rate limits that the approved liquidity recipe contract ${LIQUIDITY_RECIPE} would impose on collateral 0x211Cc4DD073734dA055fbF44a2b4667d5E5fE5d2 vs reference 0xdDb46999F8891663a8F2828d25298f70416d7610 on Arbitrum (chain 42161) — the values a JIT order carries.`,
    expect: { tool: "cork_compute", params: { params: { kind: "recipe-rate-constraint", recipe: LIQUIDITY_RECIPE } }, state: "ok", answer: /1600000000000000000|1\.6/, maxCalls: 2 },
  },
  {
    id: "predict-market",
    prompt: `Predict the Cork market a JIT fill would create on Arbitrum (chain 42161) BEFORE anything is deployed: collateral 0x211Cc4DD073734dA055fbF44a2b4667d5E5fE5d2, reference 0xdDb46999F8891663a8F2828d25298f70416d7610, expiry 1900000000 (unix seconds), recipe contract ${LIQUIDITY_RECIPE}. Report the derived pool id plus the cST and cPT contracts.`,
    expect: { tool: "cork_query", params: { resource: "derive-cork-pool", filters: { recipe: LIQUIDITY_RECIPE } }, state: "ok", answer: new RegExp(CST.slice(2), "i"), maxCalls: 2 },
  },
  {
    // The hedger's fill: a REAL signed order rests on the venue stub's book (genuine ECDSA
    // signature, genuine hash, live bit-invalidator) — the handler re-hashes and verifies it
    // for real. Grades the taker-fill variant AND the approvals-on-fill story in one task.
    id: "fill-resting-order",
    prompt: `Build the unsigned fill for the resting Cork limit order ${RESTING_ORDER_HASH} on mainnet (chain 1), taker account ${A}, request id "eval-fill-0001". Also tell me which token approval I must grant before broadcasting this fill, and to whom exactly.`,
    expect: {
      tool: "cork_prepare_orders",
      prelude: ["cork_capabilities", "cork_query"],
      params: { action: { type: "taker-fill", orderHash: RESTING_ORDER_HASH } },
      state: "ok",
      code: "approval_missing",
      answer: new RegExp(`(?=[\\s\\S]*${MAINNET_LOP.slice(2, 14)})(?=[\\s\\S]*(approv|allowance))`, "i"),
      maxCalls: 3,
    },
  },
  // ── market infrastructure (cork_prepare_market had ZERO coverage until 2026-08-17) ──
  {
    id: "deploy-oracle",
    prompt: `Prepare the unsigned transaction that deploys the price rate-oracle wrapper for the pair collateral 0x211Cc4DD073734dA055fbF44a2b4667d5E5fE5d2 / reference 0xdDb46999F8891663a8F2828d25298f70416d7610 on the Arbitrum Cork market registry (chain 42161), request id "eval-mkt-0001". Tell me if it is already deployed.`,
    // prelude includes cork_query: "tell me if it is already deployed" legitimately invites a
    // registry-oracle status read before building (observed on the 2026-08-17 first run; the
    // prepare call, params, state, and answer were all correct).
    expect: { tool: "cork_prepare_market", prelude: ["cork_capabilities", "cork_query"], params: { action: { type: "deploy-oracle" } }, state: "ok", code: "oracle_already_deployed", answer: /already deployed|idempotent|no-op|exists/i, maxCalls: 3 },
  },
  // ── submit (the ONE side-effecting tool had ZERO coverage until 2026-08-17) ──
  {
    id: "submit-rfq-open",
    prompt: `Open a Cork request-for-quote on Arbitrum (chain 42161) as requester 0xc0ffee0000000000000000000000000000000001: reference asset 0xdDb46999F8891663a8F2828d25298f70416d7610, collateral exactly 0x211Cc4DD073734dA055fbF44a2b4667d5E5fE5d2, mode liquidity_only, package "pkg_default", pool expiry between 1900000000 and 1910000000 (unix seconds), notional 1000e18 of the collateral, valid until 1795000000, my signature is 0x${"ab".repeat(65)}, request id "eval-rfq-0001". Report the RFQ id the venue assigned.`,
    expect: { tool: "cork_submit", prelude: ["cork_capabilities"], params: { action: { type: "rfq-open" } }, state: "ok", answer: /rfq_eval1/, maxCalls: 3 },
  },
  // ── decode / track ─────────────────────────────────────────────────────
  // The example bytes are inlined in cork_decode's own description, so decoding DIRECTLY is the
  // efficient correct path; fetching them via cork_capabilities first is an acceptable prelude.
  { id: "decode-bundle", prompt: "Decode this Cork calldata and tell me which adapter action it performs: use the worked example bytes from the cork_decode tool's own example.", expect: { tool: "cork_decode", prelude: ["cork_capabilities"], params: { kind: "calldata" }, state: "ok", answer: /safeSwap|swap/i, maxCalls: 3 } },
  { id: "track-digest", prompt: `Compute the content digest for this artifact so I can pin it: {"poolId":"${P}","note":"eval"}.`, expect: { tool: "cork_track", params: { mode: "verify", subject: { kind: "artifact" } }, state: "ok", maxCalls: 2 } },
  { id: "track-receipt", prompt: "Reconcile transaction 0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa on mainnet — did it succeed?", expect: { tool: "cork_track", params: { mode: "reconcile", subject: { kind: "txHash" } }, state: "ok", answer: /success/i, maxCalls: 2 } },
  { id: "verify-pool", prompt: `Verify that Cork pool ${P} on chain matches its market id (re-hash check).`, expect: { tool: "cork_track", params: { mode: "verify", subject: { kind: "marketRef", poolId: P } }, state: "ok", maxCalls: 2 } },
  // ── discovery ──────────────────────────────────────────────────────────
  { id: "discover-unwind", prompt: "I'm new to these Cork tools. Which tool and variant do I use to undo a covered position, and what does an invocation look like?", expect: { tool: "cork_capabilities", params: { search: "unwind" }, state: "ok", maxCalls: 2 } },
  // ── sign-and-broadcast teaching (the remote-deployment story: the server never signs; clients
  //    complete artifacts client-side and broadcast through their OWN RPC) ──
  { id: "signing-topic", prompt: "I have a prepared Cork bundle from cork_prepare_phoenix. How do I actually execute it on-chain from here? Walk me through the exact steps.", expect: { tool: "cork_capabilities", state: "ok", answer: /signTypedData|eth_sendRawTransaction|sign.*client/i, maxCalls: 3 } },
  { id: "decode-before-broadcast", prompt: `I signed my Cork bundle locally. Before I broadcast, validate these signed transaction bytes and tell me who signed them and what contract they target: ${SIGNED_TX}`, expect: { tool: "cork_decode", prelude: ["cork_capabilities"], params: { kind: "tx" }, state: "ok", answer: /70997970C51812dc3A010C7d01b50e0d17dc79C8|6566194141eefa99Af43Bb5Aa71460Ca2Dc90245|bundler3/i, maxCalls: 3 } },
  // Negative side-effect probe: there IS no broadcast tool — the correct behavior is to validate
  // the bytes (decode kind:"tx") and hand back the raw JSON-RPC HTTP request for the client's
  // own endpoint, never to hunt for a server-side relay.
  { id: "broadcast-construction", prompt: `Give me the exact HTTP request I should send to broadcast these already-signed Cork transaction bytes on mainnet through a public RPC endpoint: ${SIGNED_TX}`, expect: { tool: "cork_decode", prelude: ["cork_capabilities"], params: { kind: "tx" }, state: "ok", answer: /eth_sendRawTransaction[\s\S]*params|params[\s\S]*eth_sendRawTransaction/i, maxCalls: 3 } },
  { id: "execution-block-consumption", prompt: `Build an unsigned bundle depositing 1000000000000000000 collateral into Cork pool ${P}, receiver ${A}, minimum 1 share out, pre-funded, request id "eval-exec-0001" — and then tell me precisely what happens next: how does this unsigned artifact become an executed on-chain transaction?`, expect: { tool: "cork_prepare_phoenix", params: { action: { type: "deposit" } }, state: "ok", answer: /(?=[\s\S]*sign)(?=[\s\S]*(broadcast|sendRawTransaction))/i, maxCalls: 3 } },

  // ── HELD OUT (never tune descriptions against these) ───────────────────
  { id: "ho-mode-reject", heldOut: true, prompt: `Read Cork pool ${P} state using the hybrid data mode.`, expect: { tool: "cork_query", params: { mode: "hybrid" }, state: "unavailable", code: "mode_unavailable", maxCalls: 3 } },
  { id: "ho-wrong-then-right", heldOut: true, prompt: `Get me the swap fee percentage of Cork pool ${P}.`, expect: { tool: "cork_query", params: { resource: "cork-pool" }, state: "ok", answer: /5e16|50000000000000000|0\.05/, maxCalls: 3 } },
  { id: "ho-authority", heldOut: true, prompt: `Prepare a Permit2 onboarding for token 0x9D39A5DE30e57443BfF2A8307A4256c8797A3497 spender 0xCCcCcCCCcccCBaD6F772a511B337d9CCc9570407, request id "eval-auth-0001".`, expect: { tool: "cork_prepare_phoenix", params: { action: { type: "authority-onboard" } }, state: "ok", maxCalls: 2 } },
  { id: "ho-cancel", heldOut: true, prompt: `Build the cancel calldata for my resting Cork order 0x2222222222222222222222222222222222222222222222222222222222222222 (maker traits 0), account ${A}, request id "eval-can-0001".`, expect: { tool: "cork_prepare_orders", params: { action: { type: "cancel" } }, state: "ok", maxCalls: 2 } },
  { id: "ho-nonexistent-pool", heldOut: true, prompt: "Read the live market state of Cork pool 0x1111111111111111111111111111111111111111111111111111111111111111.", expect: { tool: "cork_query", params: { resource: "cork-pool" }, state: "unavailable", code: "chain_read_failed", answer: /not exist|failed|revert|unavailable/i, maxCalls: 3 } },
];
