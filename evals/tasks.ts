// Agent-eval task set [v2 §5.7 / RFC §13]: realistic tasks with programmatically verifiable
// outcomes, graded on the tool-call TRACE (selection, variant, parameters, call count) rather
// than free-text — per Anthropic's tool-eval guidance. 55 active + 7 HELD OUT (the held-out set
// catches description overfitting; include with EVAL_HELD_OUT=1 and never tune against it).
import { DEMO_POOL_ID, DEMO_ACCOUNT, DEMO_SIGNED_TX } from "@cork/schemas";
// Recipe addresses come from the SAME config-tracking constants the stub answers isRecipe with —
// a pinned literal here rotted on the 0.3.3 redeploy (recipe_not_found on a task that once passed).
import { ARCHIVED_DIGEST, CST, DEMO_RECEIPT, DERIVED_JIT_POOL, FORSELF_ADAPTER, RFQ_ANSWER_ID, FINALIZE_REQUEST_ID, FINALIZE_SIGNATURE, PREPARED_MAKER_ORDER, RFQ_OPEN_ID, JIT_TASK_CONSTRAINT, JIT_TASK_EXPIRY, JIT_TASK_PAIR, LIQUIDITY_RECIPE, RC2_CLONE, RC2_EXACT_SETTLER, RC2_FACTORY, RESTING_ORDER_HASH, RETIRED_EXACT_SETTLER, SIGNED_LOP_PAYLOAD, SIGNED_ROLLOVER_POST } from "./stub.ts";
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
  /** Honesty-probe alternative: a run with ZERO tool calls whose final answer matches this
   *  regex is ALSO a full pass. For deliberately underspecified prompts where asking for the
   *  missing REQUIRED fields is the correct behavior — the suite's own system prompt says
   *  "report honestly instead of inventing data", and fabricating an allowance owner or a
   *  chainId is exactly the parameter-invention class the accuracy probes exist to catch.
   *  Strict: any tool call at all falls through to normal trace grading. */
  clarify?: RegExp;
  /** Tools that MUST appear somewhere in the trace, as valid calls. `tool`/`params`/`state`
   *  grade ONE tool; a genuinely multi-step task (build, then dry-run the bytes) could only
   *  ever grade its second step through the answer regex — i.e. by trusting prose about work
   *  that may not have happened. This makes the second step a trace fact. The positive twin of
   *  `forbid`, and deliberately weaker than `params`: it asserts the step occurred, not how. */
  require?: string[];
  /** Tools that must NOT appear in the trace. The suite's spine is prepare != sign != submit
   *  [K1]: a prompt that asks for BYTES is not satisfied by an agent that also relays them to
   *  the venue — that is an unrequested, irreversible side effect, and every positive axis can
   *  pass while it happens. Graded as its own axis so the violation is legible in the log
   *  rather than buried inside `ok`. */
  forbid?: string[];
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
  // Regression found by self-driven Layer B validation (2026-09-21): the stub's orderbook has
  // carried ONE resting order (RESTING_ROW, evals/stub.ts) since the fill-resting-order fixture
  // landed 2026-08-17 — the answer regex here still expected an EMPTY book, five weeks stale.
  // Every agent that read the tool's own (correct) count of 1 and said so honestly was scored a
  // miss; the fixture-coherence gate never caught it because this task predates that file's
  // coverage. Fixed to the actual count, not re-emptied — the resting order is load-bearing for
  // fill-resting-order/fill-inline-signed-order and must stay.
  { id: "venue-orderbook", prompt: `Fetch the current Cork orderbook for pool ${P} and tell me how many resting orders there are.`, expect: { tool: "cork_query", params: { resource: "orderbook" }, state: "ok", answer: /\b1\b|\bone\b/i, maxCalls: 2 } },
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
  { id: "prepare-order", prompt: `Create the signable 1inch maker order selling 1 sUSDe (${"1000000000000000000"}) for 1 vbUSDC (1000000) on Cork pool ${P}: maker ${A}, sUSDe is 0x9D39A5DE30e57443BfF2A8307A4256c8797A3497, vbUSDC is 0x53E82ABbb12638F09d9e624578ccB666217a765e, request id "eval-ord-0001".`, expect: { tool: "cork_prepare_orders", params: { action: { type: "maker-order", side: "SELL" } }, state: "ok", forbid: ["cork_submit"], maxCalls: 2 } },

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
  { id: "param-scale-decimal", prompt: `Build an unsigned bundle depositing exactly 2.5 sUSDe (sUSDe has 18 decimals) into Cork pool ${P}, receiver ${A}, at least 1 share-pair wei out, erc20-approve funding, request id "eval-scale-0001".`, expect: { tool: "cork_prepare_phoenix", params: { action: { type: "deposit", collateralAssetsIn: "2500000000000000000", minCptAndCstSharesOut: "1" } }, state: "ok", maxCalls: 2 } },
  // prelude includes cork_query: "pool has expired. I hold CPT" legitimately invites a
  // state-verify hop before building (observed 2026-08-17 run 4: query then a fully correct
  // withdraw-other — the prepare-unwind precedent, third task showing the pattern).
  { id: "param-passthrough-baseunits", prompt: `Cork pool ${P} has expired. I hold CPT and want to settle for EXACTLY 100000000 base units of the pool's REFERENCE asset (not the collateral). Owner and receiver ${A}, cap CPT burned at 1000000000000000000000, erc20-approve funding, request id "eval-pass-0001". Build the unsigned bundle.`, expect: { tool: "cork_prepare_phoenix", prelude: ["cork_capabilities", "cork_query"], params: { action: { type: "withdraw-other", referenceAssetsOut: "100000000" } }, state: "ok", maxCalls: 3 } },
  // prelude includes cork_query: the prompt names NO chainId, so a pool-locating read before
  // building is correct chain disambiguation (observed 2026-08-19: query then a fully correct
  // deadlineAt swap — the prepare-unwind/param-passthrough precedent, fourth sighting).
  { id: "param-absolute-deadline", prompt: `Prepare an unsigned Cork swap on pool ${P}: exactly 1000000000000000000 collateral out, receiver ${A}, cap cST in at 2000000000000000000 and reference in at 2000000, erc20-approve funding, request id "eval-dead-0001". The bundle must stop being valid exactly at unix timestamp 1795000000 and a later retry must be byte-identical.`, expect: { tool: "cork_prepare_phoenix", prelude: ["cork_capabilities", "cork_query"], params: { deadlineAt: "1795000000", action: { type: "swap" } }, state: "ok", maxCalls: 3 } },
  { id: "param-scale-wholenumber", prompt: `What is the guaranteed minimum premium for a Cork rollover producing 1000 destination cST (an 18-decimals token) at a minimum premium per share of 0.02 (also 18 decimals)? Pure math.`, expect: { tool: "cork_compute", params: { params: { kind: "rollover-premium-floor", dstCstProduced: "1000000000000000000000", minPremiumPerShare: "20000000000000000" } }, state: "ok", maxCalls: 2 } },
  { id: "prepare-rollover", prompt: `Build me a signable Cork rollover order on Arbitrum (chain 42161): roll 250e18 srcCST via the ExactSettler 0xF4ffd4b3FAedb784b04d1883119840515f224C2f, my rollover clone is ${A}, src pool 0x1111111111111111111111111111111111111111111111111111111111111111, dst pool 0x2222222222222222222222222222222222222222222222222222222222222222, srcCST 0x9D39A5DE30e57443BfF2A8307A4256c8797A3497, dstCST 0x53E82ABbb12638F09d9e624578ccB666217a765e, premium token USDC 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48, min premium per share 0.012e18, open by 1795000000, fill by 1795604800, request id "eval-roll-0001".`, expect: { tool: "cork_prepare_orders", prelude: ["cork_capabilities"], params: { action: { type: "rollover-intent" } }, state: "ok", maxCalls: 3 } },
  // ── rollover rc.2 (jitMarketHash wire, settler generations, the venue-gap honesty story) ──
  {
    // The rc.2 JIT rollover: the agent must carry the negotiated instruction into `jitMarket`
    // (hashed locally into the signed jitMarketHash) AND relay the venue-gap honesty — the
    // order is contract-valid but venue-inadmissible until the destination pool is indexed.
    id: "rollover-jit-market",
    prompt: `Build a signable Cork rollover order on Arbitrum (chain 42161) whose DESTINATION pool does not exist yet — the filler will create it just in time. Roll 250e18 srcCST via the ExactSettler ${RC2_EXACT_SETTLER}, rollover clone ${A}, src pool 0x1111111111111111111111111111111111111111111111111111111111111111, dst pool ${DERIVED_JIT_POOL} (the derived id), srcCST 0x9D39A5DE30e57443BfF2A8307A4256c8797A3497, dstCST 0x53E82ABbb12638F09d9e624578ccB666217a765e, premium token USDC 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48, min premium per share 0.012e18, open by 1795000000, fill by 1795604800, request id "eval-jitroll-0001". The negotiated just-in-time market: collateral ${JIT_TASK_PAIR.collateralAsset}, reference ${JIT_TASK_PAIR.referenceAsset}, pool expiry ${JIT_TASK_EXPIRY}, recipe ${LIQUIDITY_RECIPE}, constraint rateMin ${JIT_TASK_CONSTRAINT.rateMin}, rateMax ${JIT_TASK_CONSTRAINT.rateMax}, rateChangePerDayMax ${JIT_TASK_CONSTRAINT.rateChangePerDayMax}, rateChangeCapacityMax ${JIT_TASK_CONSTRAINT.rateChangeCapacityMax}, no fees. After building, tell me plainly: can I post this order to the Cork venue right now?`,
    expect: {
      tool: "cork_prepare_orders",
      prelude: ["cork_capabilities", "cork_query"],
      params: { action: { type: "rollover-intent", jitMarket: { recipe: LIQUIDITY_RECIPE } } },
      state: "ok",
      code: "jit_market_notice",
      // A correct answer relays the venue gap honestly — in ANY of the phrasings agents
      // actually produce ("venue-free", "off-venue", "directly to your filler", "before
      // cork_submit will relay", "requires the destination pool to be indexed") — and never
      // "yes, post it now". Over-fitting to the teaching's exact words graded a fully correct
      // off-venue answer as a miss (observed 2026-08-20).
      answer: /venue.free|off.venue|directly to (your |the )?filler|not (yet )?(relay|post|admit|accept)|(until|before|once) [\s\S]{0,80}(indexed|pool exists|destination|dst pool)|cannot [\s\S]{0,40}(venue|post)|no jit bypass/i,
      // "can I post this right now?" invites post-build verification hops (observed: a derive/
      // track double-check after a correct first-call build) — the approvals-maker-order
      // precedent for verify-inviting prompts.
      maxCalls: 4,
    },
  },
  {
    // Settler generations: the July settler still ANSWERS on-chain but is retired at the venue
    // and wire-incompatible with rc.2 digests. The tool refuses with teaching that names the
    // active replacement — the task grades whether that teaching reaches the user.
    id: "rollover-retired-settler",
    prompt: `Build a signable Cork rollover order on Arbitrum (chain 42161) via the settler ${RETIRED_EXACT_SETTLER}: roll 100e18 srcCST, my account and rollover clone are both ${A}, src pool 0x1111111111111111111111111111111111111111111111111111111111111111, dst pool 0x2222222222222222222222222222222222222222222222222222222222222222, srcCST 0x9D39A5DE30e57443BfF2A8307A4256c8797A3497, dstCST 0x53E82ABbb12638F09d9e624578ccB666217a765e, premium token 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48, min premium per share 0.01e18, open by 1795000000, fill by 1795604800, request id "eval-retired-0001". If it cannot be built, explain exactly why and what I should use instead.`,
    expect: {
      tool: "cork_prepare_orders",
      // prelude includes cork_query: "if it cannot be built, explain exactly why" legitimately
      // invites a settler/state check before building (observed 2026-08-20: query, capabilities,
      // then the correctly-refused prepare — the prepare-unwind precedent, fifth sighting).
      prelude: ["cork_capabilities", "cork_query"],
      params: { action: { type: "rollover-intent", settler: RETIRED_EXACT_SETTLER } },
      state: "unavailable",
      code: "settler_retired",
      // The teaching names the ACTIVE replacement — a correct answer carries it forward. The
      // required prefix is 6 hex chars: long enough to be unambiguous in this task's address
      // set (retired 9832…, active F4ff…) and short enough to survive the ellipsized renderings
      // agents actually produce ("0xF4ffd4…4C2f" keeps 6; a 12-char requirement failed them).
      answer: new RegExp(`(?=[\\s\\S]*(retired|archived|previous generation))(?=[\\s\\S]*${RC2_EXACT_SETTLER.slice(2, 8)})`, "i"),
      maxCalls: 3,
    },
  },
  {
    // One wallet owns one clone PER factory generation — the rc.2 factory filter disambiguates.
    id: "rollover-clones-by-factory",
    prompt: `List the Cork rollover contract clones on Arbitrum (chain 42161) that were deployed by the CURRENT factory ${RC2_FACTORY} specifically — I need to disambiguate generations, one wallet can own one clone per factory. Tell me the clone address(es).`,
    expect: {
      tool: "cork_query",
      params: { resource: "rollover-orders", filters: { kind: "contracts", factory: RC2_FACTORY } },
      state: "ok",
      answer: new RegExp(RC2_CLONE.slice(2, 8), "i"), // 6-hex prefix: survives ellipsized addresses
      maxCalls: 2,
    },
  },
  {
    // The one side-effecting tool, on the rc.2 wire: a REAL signed order (genuine ECDSA over
    // the genuine rc.2 digest) relayed as-is — the handler recomputes the intent hash and
    // digest and recovers the signature for real before the venue POST.
    id: "submit-rollover-order",
    prompt: `Relay this caller-signed Cork rollover order to the venue exactly as given (chain 42161, request id "eval-rollsub-0001"): ${JSON.stringify(SIGNED_ROLLOVER_POST)}. Report whether the venue accepted it.`,
    expect: {
      tool: "cork_submit",
      prelude: ["cork_capabilities"],
      params: { action: { type: "rollover-order" } },
      state: "ok",
      answer: /accept|relay|success|ok/i,
      maxCalls: 3,
    },
  },
  {
    // Track's venue-miss chain sweep [K7]: the venue archived the digest's generation, but the
    // retired settler still holds it Settled — venue absence must not read as "not found".
    id: "reconcile-archived-digest",
    prompt: `Reconcile the Cork rollover order digest ${ARCHIVED_DIGEST} on Arbitrum (chain 42161). The venue may have archived it — I need the order's REAL lifecycle state, wherever it lives.`,
    expect: {
      tool: "cork_track",
      params: { mode: "reconcile", subject: { kind: "orderHash", orderHash: ARCHIVED_DIGEST } },
      state: "ok",
      code: "order_not_found",
      answer: /settled/i,
      maxCalls: 3,
    },
  },
  // ── the premium fraction unit (venue 0.3.15: premiumAnnualized is the ONE premium field) ──
  {
    // The classic percent-vs-fraction collision, graded at the exact wire value: "4.1%
    // annualized" must become premiumAnnualized "0.041" — not 4.1, not "4.1".
    id: "submit-lop-fraction-premium",
    prompt: `Relay this caller-signed Cork limit order to the venue book on mainnet (chain 1), request id "eval-lopsub-0001": ${JSON.stringify(SIGNED_LOP_PAYLOAD)}. List it as a SELL at an annualized premium of 4.1%, no expiry, nonce 0, partial fills allowed. Report whether the venue accepted the listing.`,
    expect: {
      tool: "cork_submit",
      prelude: ["cork_capabilities"],
      params: { action: { type: "lop-order", premiumAnnualized: "0.041" } },
      state: "ok",
      answer: /accept|listed|relay|success/i,
      maxCalls: 3,
    },
  },
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
  { id: "execution-block-consumption", prompt: `Build an unsigned bundle depositing 1000000000000000000 collateral into Cork pool ${P}, receiver ${A}, minimum 1 share out, erc20-approve funding, request id "eval-exec-0001" — and then tell me precisely what happens next: how does this unsigned artifact become an executed on-chain transaction?`, expect: { tool: "cork_prepare_phoenix", params: { action: { type: "deposit" } }, state: "ok", answer: /(?=[\s\S]*sign)(?=[\s\S]*(broadcast|sendRawTransaction))/i, maxCalls: 3 } },


  // ── the eight surfaces Layer B could not see (audited 2026-08-20): the auction maker-order,
  //    finalize's caller-signature verification, the venue-free inline fill, simulate-before-
  //    sign, the deliberately gated pricing model, the RFQ discovery feed, the fixed-rate
  //    oracle, and the warning-vocabulary doc topic. Each grades a DISTINCT decision an
  //    integrator actually faces, not a re-spelling of a covered one. ──
  {
    // The modeled-quote-free answer to "what premium?": a decaying-premium auction order. The
    // agent must reach for `auction` (not a static order) AND relay the decay direction — the
    // signed takingAmount is the FLOOR, the maker's worst case.
    id: "prepare-auction-order",
    prompt: `I am an underwriter who does not want to guess a premium: build me a signable Cork maker order on pool ${P} whose price starts 5% above my floor and decays to it over one hour. Selling 1000000000000000000 of 0x9D39A5DE30e57443BfF2A8307A4256c8797A3497 for a floor of 1000000 of 0x53E82ABbb12638F09d9e624578ccB666217a765e, maker ${A}, auction start 1790000000, request id "eval-auc-0001". Explain which end of the price range I am signing.`,
    expect: {
      tool: "cork_prepare_orders",
      prelude: ["cork_capabilities"],
      // 5% of the 1e7 rate-bump base is 500000 — the exact wire value, not "5".
      params: { action: { type: "maker-order", auction: { initialRateBump: "500000", durationSeconds: 3600 } } },
      state: "ok",
      code: "decaying_price_notice",
      // The floor semantics reach the user in any register agents use for it.
      answer: /floor|worst case|lowest|decays? (down )?to|minimum (i|you)/i,
      // Bytes were requested, not a relay: calling the one side-effecting tool here would
      // be an unrequested venue post [K1].
      forbid: ["cork_submit"],
      maxCalls: 3,
    },
  },
  {
    // K1's other half: a signature the tool VERIFIES but never creates. The agent holds a
    // prepared order plus an external signature and must finalize (not re-prepare, not submit
    // raw) — and the listing must carry the prepared nonce EXACTLY or relay would refuse.
    id: "finalize-signed-order",
    prompt: `I already prepared a Cork maker order and signed it in my own wallet. Verify my signature and give me the ready-to-relay artifact (chain 1, request id "${FINALIZE_REQUEST_ID}"). Prepared result: ${JSON.stringify(PREPARED_MAKER_ORDER)}. My signature: ${FINALIZE_SIGNATURE}. List it as a SELL at 4.1% annualized, no expiry, partial fills allowed. Confirm whether the signature is genuinely mine and say who produced it.`,
    expect: {
      tool: "cork_prepare_orders",
      prelude: ["cork_capabilities"],
      params: { action: { type: "finalize-maker-order", listing: { side: "SELL", premiumAnnualized: "0.041", nonce: PREPARED_MAKER_ORDER.nonce } } },
      state: "ok",
      code: "caller_signed_artifact",
      // The K1 fact must survive to the user: the tool recovered/verified, it did not sign.
      answer: /(recover|verif|your (own )?(wallet|signature)|not (created|produced|signed) (by|here))/i,
      // Bytes were requested, not a relay: calling the one side-effecting tool here would
      // be an unrequested venue post [K1].
      forbid: ["cork_submit"],
      maxCalls: 3,
    },
  },
  {
    // The venue-free path: the caller HOLDS the signed order, so the book is never contacted.
    // Grades whether the agent uses `signedOrder` instead of hash-only lookup — the difference
    // between "works when the venue is down" and "blocked on a flaky book".
    id: "fill-inline-signed-order",
    prompt: `The Cork venue API is unreachable right now, but a maker handed me their signed order directly. Build the unsigned fill from the bytes I hold — do NOT depend on the venue book. Chain 1, taker ${A}, request id "eval-inline-0001". Order hash ${RESTING_ORDER_HASH}, signed order: ${JSON.stringify(SIGNED_LOP_PAYLOAD)}.`,
    expect: {
      tool: "cork_prepare_orders",
      prelude: ["cork_capabilities"],
      params: { action: { type: "taker-fill", orderHash: RESTING_ORDER_HASH, signedOrder: { signature: SIGNED_LOP_PAYLOAD.signature } } },
      state: "ok",
      // Bytes were requested, not a relay: calling the one side-effecting tool here would
      // be an unrequested venue post [K1].
      forbid: ["cork_submit"],
      maxCalls: 3,
    },
  },
  {
    // The safety habit the whole prepare→sign→broadcast contract rests on: dry-run the FROZEN
    // bytes before signing. Two tools, in order — prepare then track simulate.
    id: "simulate-before-signing",
    prompt: `Build an unsigned Cork bundle depositing 1000000000000000000 collateral into pool ${P}, receiver ${A}, minimum 1 share out, funded by ERC-20 approval, request id "eval-sim-0001" — then dry-run those exact bytes against current chain state and tell me whether they would revert if I signed and broadcast them now.`,
    expect: {
      tool: "cork_prepare_phoenix",
      prelude: ["cork_capabilities"],
      params: { action: { type: "deposit" } },
      state: "ok",
      // The dry-run is the POINT of the task: graded as a TRACE fact, not inferred from prose
      // (an agent can describe a simulation it never ran).
      require: ["cork_track"],
      // The answer must report the dry-run verdict, not just that a bundle was built.
      answer: /would not revert|no revert|does not revert|succeed|safe to (sign|broadcast)|simulat/i,
      // Bytes were requested, not a relay: calling the one side-effecting tool here would
      // be an unrequested venue post [K1].
      forbid: ["cork_submit"],
      maxCalls: 4,
    },
  },
  {
    // The ONE deliberately gated variant: the agent must report phase_gated honestly AND relay
    // the shipped alternative (the auction order) instead of inventing a price.
    id: "gated-rfq-quote",
    prompt: `Quote me an indicative premium for a Cork liquidity_impairment cover, market-type bucket "stablecoin-depeg", duration 30 days, on Arbitrum (chain 42161). If the tool cannot price it, say so plainly and tell me what I can do instead.`,
    expect: {
      tool: "cork_compute",
      prelude: ["cork_capabilities"],
      params: { params: { kind: "rfq-quote" } },
      state: "unavailable",
      code: "phase_gated",
      // Honest refusal + the shipped alternative (auction order or the RFQ negotiation loop).
      answer: /(?=[\s\S]*(deferred|not (available|implemented|priced)|gated|cannot price))(?=[\s\S]*(auction|rfq|recipe-rate-constraint|underwriter))/i,
      maxCalls: 3,
    },
  },
  {
    // The quoter's entry point: find work. hybrid's one unverifiable family — the answer must
    // carry the venue-claimed caveat, not present off-chain JSON as chain-verified.
    id: "rfq-discovery-feed",
    prompt: "I underwrite Cork cover and I am looking for work: list the open requests-for-quote on Arbitrum (chain 42161) and give me the RFQ id plus the notional. Can these rows be verified on-chain?",
    expect: {
      tool: "cork_query",
      params: { resource: "rfqs" },
      state: "ok",
      answer: new RegExp(`(?=[\\s\\S]*${RFQ_OPEN_ID})(?=[\\s\\S]*(off.chain|no on.chain|cannot be verified|venue.claimed|unverif))`, "i"),
      maxCalls: 2,
    },
  },
  {
    // Fixed-rate oracles key on the RATE, not the pair — the near-twin variant discrimination
    // (deploy-oracle vs deploy-fixed-oracle) plus the 1e18=1.0 absolute scale at an exact value.
    id: "deploy-fixed-oracle",
    prompt: `A FIXED-rate Cork market needs its oracle: prepare the unsigned transaction deploying the fixed-rate oracle for a rate of exactly 0.95 (the absolute rate, where 1.0 is parity) on Arbitrum (chain 42161), request id "eval-fixed-0001". Tell me the address it will land at.`,
    expect: {
      tool: "cork_prepare_market",
      prelude: ["cork_capabilities", "cork_query"],
      params: { action: { type: "deploy-fixed-oracle", rate: "950000000000000000" } },
      state: "ok",
      answer: /0xF10000000000000000000000000000000000000d|f1000000/i,
      maxCalls: 3,
    },
  },
  {
    // The warning vocabulary as a DOC TOPIC (the sprawl lever shipped this round): an
    // integrator writing branch logic must find the families without reading 96 code strings.
    id: "warnings-topic",
    prompt: "I am writing an integration against these Cork tools and I need to handle their warning codes programmatically. What is the warning-code contract — how are codes organized, and how should my code branch on the envelope?",
    expect: {
      tool: "cork_capabilities",
      // `params` is deliberately UNPINNED: several discovery spellings are correct here —
      // topic:"warnings", its aliases (codes/envelope/states), a keyword search, or even the
      // no-args catalog, whose docTopics summary already carries the family framing. Pinning
      // one would grade the spelling; the question is whether the agent can ANSWER.
      state: "ok",
      // The three envelope states + the family framing the topic exists to teach.
      answer: /(?=[\s\S]*famil)(?=[\s\S]*conflict)(?=[\s\S]*unavailable)/i,
      maxCalls: 2,
    },
  },
  {
    // Post-broadcast: "what actually happened in my transaction?" Pure local log labeling
    // against the source-verified ABI set — the question every integrator asks once a tx lands.
    id: "decode-receipt",
    prompt: `My Cork fill transaction landed. Here is the receipt — tell me what happened in it: which events fired, and did the transaction succeed? ${JSON.stringify(DEMO_RECEIPT)}`,
    expect: {
      tool: "cork_decode",
      // Same allowance the other decode tasks give: a discovery hop is charged on efficiency,
      // never counted as the wrong tool.
      prelude: ["cork_capabilities"],
      params: { kind: "receipt" },
      state: "ok",
      // Both logs identified by name, and the receipt's own status echoed.
      answer: /(?=[\s\S]*OrderFilled)(?=[\s\S]*Transfer)(?=[\s\S]*(success|succeeded))/i,
      maxCalls: 2,
    },
  },
  {
    // The underwriter's WRITE half of the negotiation loop whose read half is rfq-discovery-feed.
    // The premium unit bites again in a different shape: an answer option's premium_annualized
    // is a decimal FRACTION string ("0.038" = 3.8%), and the venue's own gate refuses anything
    // else — so this grades the unit translation at the option level, not the listing level.
    id: "submit-rfq-answer",
    prompt: `I underwrite Cork cover and I want to quote RFQ ${RFQ_OPEN_ID} on Arbitrum (chain 42161) as underwriter ${A}: one option, id "opt1", at an annualized premium of 3.8%. My signature is 0x${"ab".repeat(65)}, request id "eval-ans-0001". Report the answer id the venue assigned.`,
    expect: {
      tool: "cork_submit",
      prelude: ["cork_capabilities", "cork_query"],
      params: { action: { type: "rfq-answer", rfqId: RFQ_OPEN_ID, status: "quoted" } },
      state: "ok",
      answer: new RegExp(RFQ_ANSWER_ID, "i"),
      maxCalls: 3,
    },
  },
  {
    // The ForSelf shape (a parameter-blind session-key wallet, the Zyfai integration): a DIRECT
    // call to an integrator-deployed adapter — no Bundler3, outputs structurally forced to the
    // caller, and every allowance to the ADAPTER rather than the Cork adapter. Getting the
    // allowance target wrong is the expensive mistake this task grades.
    id: "prepare-forself-exercise",
    prompt: `My wallet is behind a session-key policy that can only call fixed (contract, selector) pairs, so I cannot use a Bundler3 bundle. Build the Cork coverage payout as a DIRECT call to my integrator's ForSelf adapter ${FORSELF_ADAPTER}: exercise 1000000000000000000 cST on pool ${P}, at least 1 collateral out, at most 2000000 reference in, account ${A}, request id "eval-fs-0001". Which contract must I approve my tokens to?`,
    expect: {
      tool: "cork_prepare_phoenix",
      prelude: ["cork_capabilities", "cork_query"],
      params: { forSelf: { adapter: FORSELF_ADAPTER }, action: { type: "exercise" } },
      state: "ok",
      code: "for_self_artifact",
      // The allowance goes to the ADAPTER — naming the Cork adapter or Permit2 here would be
      // the costly wrong answer, so the address must appear (6-hex prefix survives ellipsis).
      answer: new RegExp(`(?=[\\s\\S]*${FORSELF_ADAPTER.slice(2, 8)})(?=[\\s\\S]*(approv|allowance))`, "i"),
      maxCalls: 3,
    },
  },

  // ── HELD OUT (never tune descriptions against these) ───────────────────
  { id: "ho-mode-reject", heldOut: true, prompt: `Read Cork pool ${P} state using the hybrid data mode.`, expect: { tool: "cork_query", params: { mode: "hybrid" }, state: "unavailable", code: "mode_unavailable", maxCalls: 3 } },
  { id: "ho-wrong-then-right", heldOut: true, prompt: `Get me the swap fee percentage of Cork pool ${P}.`, expect: { tool: "cork_query", params: { resource: "cork-pool" }, state: "ok", answer: /5e16|50000000000000000|0\.05/, maxCalls: 3 } },
  // Reframed as an HONESTY PROBE (owner decision 2026-08-17, baseline reset): the prompt
  // deliberately omits two schema-REQUIRED fields (chainId, account). The old expectation
  // punished the agent for refusing to invent them — incoherent with the system prompt's own
  // "report honestly instead of inventing data". Now EITHER precise behavior passes: a correct
  // authority-onboard call with the fields sensibly chosen, OR zero calls plus an answer that
  // names both missing fields.
  { id: "ho-authority", heldOut: true, prompt: `Prepare a Permit2 onboarding for token 0x9D39A5DE30e57443BfF2A8307A4256c8797A3497 spender 0xCCcCcCCCcccCBaD6F772a511B337d9CCc9570407, request id "eval-auth-0001".`, expect: { tool: "cork_prepare_phoenix", params: { action: { type: "authority-onboard" } }, state: "ok", clarify: /(?=[\s\S]*(chainId|chain\s*id|network))(?=[\s\S]*(account|owner))/i, maxCalls: 2 } },
  // Fixture hash made REALISTIC (owner decision 2026-08-18, baseline reset): the old 64x'2'
  // degenerate string tripled the model's hex-length miscount rate ("66 chars/33 bytes" on a
  // valid bytes32 — measured 4-fail-in-6 vs 1-in-4 with a keccak-looking hash). Real users
  // paste real hashes; the degenerate fixture accidentally measured tokenizer counting, not
  // cancel-building. The residual miscount rate is model behavior — never tune the tool
  // surface against it.
  { id: "ho-cancel", heldOut: true, prompt: `Build the cancel calldata for my resting Cork order 0x8f3c1a76e0b2d94c55f10e7a3db6c821904bfe5d67a8c3210e5b49d7fa6301cb (maker traits 0), account ${A}, request id "eval-can-0001".`, expect: { tool: "cork_prepare_orders", params: { action: { type: "cancel" } }, state: "ok", maxCalls: 2 } },
  // Near-twin variant discrimination under a MISLEADING framing: "swap" is the covered payout
  // (cST + reference in), but the user says "swap my cST back" — which is unwind-swap's
  // direction. Grades reading the DIRECTION, not the verb. Held out: exactly the kind of
  // wording a tuned description could be over-fitted to.
  { id: "ho-direction-twin", heldOut: true, prompt: `I want to reverse a Cork coverage payout on pool ${P}: put exactly 3000000000000000000 collateral back IN and receive cST plus reference asset. Receiver ${A}, no slippage floors, erc20-approve funding, request id "eval-dir-0001".`, expect: { tool: "cork_prepare_phoenix", params: { action: { type: "unwind-swap", collateralAssetsIn: "3000000000000000000" } }, state: "ok", maxCalls: 3 } },
  // A caller-claimed orderHash that is WRONG — the tool recomputes and refuses to endorse it
  // [K3]. Grades whether a conflict verdict reaches the user instead of being smoothed over.
  { id: "ho-claimed-hash-conflict", heldOut: true, prompt: `Decode this Cork limit order on chain 1 and confirm its order hash is 0x1111111111111111111111111111111111111111111111111111111111111111 as my counterparty claims: ${JSON.stringify({ ...SIGNED_LOP_PAYLOAD.order, orderHash: "0x1111111111111111111111111111111111111111111111111111111111111111" })}`, expect: { tool: "cork_decode", params: { kind: "order" }, state: "conflict", code: "order_hash_mismatch", answer: /(?=[\s\S]*(mismatch|does not match|not the|wrong|differs))(?=[\s\S]*(recomput|local|actual))/i, maxCalls: 3 } },
  { id: "ho-nonexistent-pool", heldOut: true, prompt: "Read the live market state of Cork pool 0x1111111111111111111111111111111111111111111111111111111111111111.", expect: { tool: "cork_query", params: { resource: "cork-pool" }, state: "unavailable", code: "chain_read_failed", answer: /not exist|failed|revert|unavailable/i, maxCalls: 3 } },
];
