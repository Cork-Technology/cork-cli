// Built-in self-drive plays: ONE canonical play per eval task — the tool calls a competent agent
// would make, built from the stub's own constants (never hand-pasted hex), plus a final answer
// composed from ground truth. Two consumers, one source: `self-drive.ts builtin` (interactive)
// and `self-drive.test.ts` (the offline winnability gate — every task must have a play and every
// play must grade PASS). A task without a play fails the gate: "not yet played" can never grow
// silently again. These are NOT model transcripts; they assert that the suite is coherent, not
// how a model performs (that is Layer B's number, and stays on the sonnet gate).
import { runTool, ToolInputError } from "@cork/core";
import { DEMO_ACCOUNT, DEMO_POOL_ID, DEMO_SIGNED_TX, TOOL_EXAMPLES } from "@cork/schemas";
import type { TraceCall } from "./run.ts";
import {
  ARCHIVED_DIGEST, CST, DEMO_RECEIPT, DERIVED_JIT_POOL, FORSELF_ADAPTER, RFQ_ANSWER_ID, FINALIZE_REQUEST_ID, FINALIZE_SIGNATURE,
  GROUPED_RUNG, PREPARED_MAKER_ORDER, RFQ_OPEN_ID, JIT_TASK_CONSTRAINT, LIQUIDITY_RECIPE, RC2_CLONE, RC2_EXACT_SETTLER, RC2_FACTORY,
  RESERVED_FILLER, RESERVED_ORDER_HASH, RESTING_ORDER_HASH, RETIRED_EXACT_SETTLER, SIGNED_LOP_PAYLOAD, SIGNED_ROLLOVER_POST, stubContext,
} from "./stub.ts";

export interface Play {
  id: string;
  calls: Array<{ tool: string; input: unknown }>;
  /** The final answer graded by the task's regex (absent in a recording spec). */
  finalText?: string;
}

export interface PlayedTask {
  trace: TraceCall[];
  /** One line per call: `record` carries the full envelope, `grade` a short digest. */
  digests: string[];
}

/** Execute a play's calls against the stub, exactly as the harness would trace them. */
export async function playTask(play: Play, mode: "record" | "grade"): Promise<PlayedTask> {
  const ctx = stubContext();
  const trace: TraceCall[] = [];
  const digests: string[] = [];
  for (const c of play.calls) {
    const call: TraceCall = { tool: c.tool, input: c.input };
    try {
      const env = await runTool(c.tool, c.input, ctx);
      call.state = env.state;
      call.codes = env.warnings.map((w) => w.code);
      digests.push(mode === "record" ? `${c.tool} -> ${JSON.stringify(env)}` : `${c.tool} -> ${env.state}${call.codes.length ? "/" + call.codes.join("+") : ""} :: ${JSON.stringify(env.data).slice(0, 160)}`);
    } catch (err) {
      call.invalid = true;
      digests.push(`${c.tool} -> INVALID :: ${err instanceof ToolInputError ? JSON.stringify(err.issues).slice(0, 400) : String(err).slice(0, 400)}`);
    }
    trace.push(call);
  }
  return { trace, digests };
}

const A = DEMO_ACCOUNT;
const P = DEMO_POOL_ID;
const SUSDE = "0x9D39A5DE30e57443BfF2A8307A4256c8797A3497";
const VBUSDC = "0x53E82ABbb12638F09d9e624578ccB666217a765e";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const CA = "0x211Cc4DD073734dA055fbF44a2b4667d5E5fE5d2";
const REF = "0xdDb46999F8891663a8F2828d25298f70416d7610";
const LOP1 = "0x111111125421cA6dc452d289314280a0f8842A65";
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const OTHER_TAKER = "0xc0ffee0000000000000000000000000000000002";
const rolloverBase = { settler: RC2_EXACT_SETTLER, rolloverContract: A, srcPoolId: `0x${"11".repeat(32)}`, dstPoolId: `0x${"22".repeat(32)}`, srcCstToken: SUSDE, dstCstToken: VBUSDC, premiumToken: USDC, orderSize: "250000000000000000000", minPremiumPerShare: "12000000000000000", openDeadline: "1795000000", fillDeadline: "1795604800" };
// The price-dutch task's inline order (a real Fusion v3.1 extension; the task pins the moment).
const dutchOrder = { salt: "72116775394861435818731221900729193628876322478708569", maker: A, receiver: "0x0000000000000000000000000000000000000000", makerAsset: SUSDE, takerAsset: VBUSDC, makingAmount: "1000000000000000000", takingAmount: "1000000", makerTraits: "904625697166532776746648320380374280103671755200316906558262375061821325312", extension: "0x0000006e0000006e0000006e0000006e0000006e0000003700000000000000002ad5004c60e16e54d5007c80ce329adde5b51ef5000000000000006a922100000e100f4240020aae6003840493e00384000000000000002ad5004c60e16e54d5007c80ce329adde5b51ef5000000000000006a922100000e100f4240020aae6003840493e0038400000000000000" };
const ladderBase = { poolId: P, side: "SELL", makerAsset: SUSDE, takerAsset: VBUSDC, makingAmount: "1000000000000000000" };

// simulate-before-signing plays the SAME prepared artifact the first call returns; built here
// through runTool so the second call's literal can never drift from the first.
const simPrepared = await runTool("cork_prepare_phoenix", { chainId: 1, account: A, clientRequestId: "eval-sim-0001", fundingMode: "erc20-approve", action: { type: "deposit", poolId: P, collateralAssetsIn: "1000000000000000000", receiver: A, minCptAndCstSharesOut: "1" } }, stubContext());
if (simPrepared.state !== "ok") throw new Error(`self-drive plays: the simulate fixture's prepare answered ${simPrepared.state} — fixture rot`);
const decodeExample = TOOL_EXAMPLES.cork_decode![0]!.input as Record<string, unknown>;

const q = (input: Record<string, unknown>) => ({ tool: "cork_query", input });
const c = (input: Record<string, unknown>) => ({ tool: "cork_compute", input });
const px = (id: string, action: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ tool: "cork_prepare_phoenix", input: { chainId: 1, account: A, clientRequestId: id, fundingMode: "erc20-approve", ...extra, action } });
const po = (id: string, action: Record<string, unknown>, chainId = 1) => ({ tool: "cork_prepare_orders", input: { chainId, account: A, clientRequestId: id, action } });

export const PLAYS: Play[] = [
  // ── reads ──
  { id: "read-market", calls: [q({ resource: "cork-pool", chainId: 1, filters: { poolId: P } })], finalText: "The pool's swap rate is 0.8 (800000000000000000 at 1e18 = 1.0)." },
  { id: "read-balances", calls: [q({ resource: "account-state", chainId: 1, filters: { poolId: P, account: A } })], finalText: "Balances and funding allowances for the account in this pool are listed above per token." },
  { id: "read-config", calls: [q({ resource: "protocol-config", chainId: 1 })], finalText: "The Cork adapter on mainnet is 0xCCcCcCCCcccCBaD6F772a511B337d9CCc9570407." },
  { id: "read-whitelist", calls: [q({ resource: "pool-whitelist", chainId: 1, filters: { poolId: P, account: A } })], finalText: "The account is not whitelisted on this pool (false)." },
  { id: "venue-orderbook", calls: [q({ resource: "orderbook", chainId: 1, filters: { poolId: P } })], finalText: "The orderbook has 2 resting orders for this pool." },
  { id: "whitelist-enumerate", calls: [q({ resource: "whitelisted-addresses", chainId: 1, mode: "full-decentralized" })], finalText: "Whitelisted addresses across pools: see the rows above, including 0x000000000000000000000000000000000000a11ce." },
  { id: "rollover-feed", calls: [q({ resource: "rollover-orders", chainId: 42161, filters: { fillable: true } })], finalText: "The fillable rollover orders on Arbitrum are listed above." },
  { id: "rollover-clones-by-factory", calls: [q({ resource: "rollover-orders", chainId: 42161, filters: { kind: "contracts", factory: RC2_FACTORY } })], finalText: `One clone from the current factory: ${RC2_CLONE}.` },
  { id: "registry-recipes", calls: [q({ resource: "registry-recipes", chainId: 42161 })], finalText: "The approved recipes are listed above; the liquidity recipe takes abi.encode(uint256 anchorRate) as its additionalData." },
  { id: "predict-market", calls: [q({ resource: "derive-cork-pool", chainId: 42161, filters: { collateralAsset: CA, referenceAsset: REF, expiry: "1900000000", recipe: LIQUIDITY_RECIPE } })], finalText: `Derived pool id as returned; cST ${CST}, cPT as returned.` },
  { id: "book-best-for-me", calls: [q({ resource: "orderbook", chainId: 1, filters: { poolId: P, account: A } })], finalText: `Fill ${RESTING_ORDER_HASH} first: it is the only fillable order for you, ranked best. The other resting order is reserved for a different fill sender and is excluded (PrivateOrder), so you cannot fill it.` },
  { id: "rfq-discovery-feed", calls: [q({ resource: "rfqs", chainId: 42161 })], finalText: "Open RFQ rfq_open7 with the notional shown above. These rows are off-chain, venue-claimed data and cannot be verified on-chain." },
  // ── compute ──
  { id: "price-swap", calls: [c({ chainId: 1, params: { kind: "cst-swap-rate", poolId: P, collateralAssetsOut: "1000000000000000000" } })], finalText: "Taking 1 sUSDe out costs the cST shares and reference assets shown above (scales labeled in the result)." },
  { id: "price-unwind", calls: [c({ chainId: 1, params: { kind: "unwind-rate", poolId: P, collateralAssetsIn: "5000000000000000000" } })], finalText: "Putting 5e18 collateral back returns the cST shares and reference assets shown above." },
  { id: "impairment", calls: [c({ chainId: 1, params: { kind: "impairment-floor", poolId: P, horizonSeconds: 259200 } })], finalText: "The worst-case, rate-limited impairment floor over 3 days is reported above; it is a floor, not the minRate." },
  { id: "rollover-floor", calls: [c({ params: { kind: "rollover-premium-floor", dstCstProduced: "500000000000000000000", minPremiumPerShare: "10000000000000000" } })], finalText: "The guaranteed premium floor is 5000000000000000000 base units (5.0 with 18 decimals)." },
  { id: "price-dutch", calls: [c({ chainId: 1, params: { kind: "dutch-auction-price", order: dutchOrder }, at: { timestamp: "1787962200" } })], finalText: "At that moment the taker pays 1080000 for the full making amount (1.08 vbUSDC)." },
  { id: "param-scale-wholenumber", calls: [c({ params: { kind: "rollover-premium-floor", dstCstProduced: "1000000000000000000000", minPremiumPerShare: "20000000000000000" } })], finalText: "The floor is 20000000000000000000 base units (20 tokens at 18 decimals)." },
  { id: "resolve-constraint", calls: [c({ chainId: 42161, params: { kind: "recipe-rate-constraint", recipe: LIQUIDITY_RECIPE, collateralAsset: CA, referenceAsset: REF } })], finalText: "The constraint: rateMax 1600000000000000000 (1.6), with the other three limits as returned." },
  { id: "gated-rfq-quote", calls: [c({ chainId: 42161, params: { kind: "rfq-quote", marketTypeBucket: "stablecoin-depeg", durationSeconds: 2592000 } })], finalText: "This tool cannot price it: rfq-quote is deferred (phase gated). Instead, post a decaying auction maker order and let the market discover the premium, or ask underwriters via an RFQ." },
  // ── phoenix prepares ──
  { id: "prepare-deposit", calls: [px("eval-dep-0001", { type: "deposit", poolId: P, collateralAssetsIn: "10000000000000000000", receiver: A, minCptAndCstSharesOut: "1" })], finalText: "Unsigned deposit bundle built (erc20-approve funding); sign and broadcast it yourself." },
  { id: "prepare-swap", calls: [px("eval-swap-0001", { type: "swap", poolId: P, collateralAssetsOut: "1000000000000000000", receiver: A, maxCstSharesIn: "2000000000000000000", maxReferenceAssetsIn: "2000000" })], finalText: "Unsigned swap bundle built with the two caps and a sweep-back leg." },
  { id: "prepare-unwind", calls: [px("eval-unw-0001", { type: "unwind-swap", poolId: P, collateralAssetsIn: "3000000000000000000", receiver: A, minReferenceAssetsOut: "0", minCstSharesOut: "0" })], finalText: "Unsigned unwind-swap bundle built." },
  { id: "param-scale-decimal", calls: [px("eval-scale-0001", { type: "deposit", poolId: P, collateralAssetsIn: "2500000000000000000", receiver: A, minCptAndCstSharesOut: "1" })], finalText: "Built: 2.5 sUSDe is 2500000000000000000 base units." },
  { id: "param-passthrough-baseunits", calls: [px("eval-pass-0001", { type: "withdraw-other", poolId: P, referenceAssetsOut: "100000000", owner: A, receiver: A, maxCptSharesIn: "1000000000000000000000" })], finalText: "Built the withdraw-other bundle for exactly 100000000 base units of the reference asset." },
  { id: "param-absolute-deadline", calls: [px("eval-dead-0001", { type: "swap", poolId: P, collateralAssetsOut: "1000000000000000000", receiver: A, maxCstSharesIn: "2000000000000000000", maxReferenceAssetsIn: "2000000" }, { deadlineAt: "1795000000" })], finalText: "Built with an absolute deadline of 1795000000, so a retry is byte-identical." },
  { id: "execution-block-consumption", calls: [px("eval-exec-0001", { type: "deposit", poolId: P, collateralAssetsIn: "1000000000000000000", receiver: A, minCptAndCstSharesOut: "1" })], finalText: "Next: simulate with cork_track, sign the transaction client-side, decode the signed bytes, then broadcast with eth_sendRawTransaction via your own RPC and track the hash." },
  { id: "simulate-before-signing", calls: [px("eval-sim-0001", { type: "deposit", poolId: P, collateralAssetsIn: "1000000000000000000", receiver: A, minCptAndCstSharesOut: "1" }), { tool: "cork_track", input: { chainId: 1, mode: "simulate", subject: { kind: "artifact", artifact: simPrepared.data } } }], finalText: "The dry-run simulated the frozen bytes: they would not revert, so it is safe to sign." },
  { id: "prepare-forself-exercise", calls: [{ tool: "cork_prepare_phoenix", input: { chainId: 1, account: A, clientRequestId: "eval-fs-0001", forSelf: { adapter: FORSELF_ADAPTER }, action: { type: "exercise", poolId: P, cstSharesIn: "1000000000000000000", receiver: A, minCollateralAssetsOut: "1", maxReferenceAssetsIn: "2000000" } } }], finalText: `Approve your tokens to the ForSelf adapter ${FORSELF_ADAPTER} itself (allowances target the adapter, not the Cork adapter or Permit2).` },
  // ── orders ──
  { id: "prepare-order", calls: [po("eval-ord-0001", { type: "maker-order", poolId: P, side: "SELL", makerAsset: SUSDE, takerAsset: VBUSDC, makingAmount: "1000000000000000000", takingAmount: "1000000" })], finalText: "Signable maker order built; sign the typed data, finalize, then submit." },
  { id: "approvals-maker-order", calls: [po("eval-appr-0001", { type: "maker-order", poolId: P, side: "SELL", makerAsset: SUSDE, takerAsset: VBUSDC, makingAmount: "1000000000000000000", takingAmount: "1000000" })], finalText: `The maker must approve sUSDe to the 1inch LOP ${LOP1} before the order is fillable; the allowance is currently 0, so that approval is missing right now.` },
  { id: "approvals-permit2-layers", calls: [po("eval-appr-0002", { type: "maker-order", poolId: P, side: "SELL", makerAsset: SUSDE, takerAsset: VBUSDC, makingAmount: "1000000000000000000", takingAmount: "1000000", expirySeconds: 3600, usePermit2: true })], finalText: `Two layers: an ERC-20 approve of sUSDe to Permit2 ${PERMIT2}, and a Permit2 internal allowance for spender ${LOP1}; both grants are direct owner-signed transactions.` },
  { id: "prepare-auction-order", calls: [po("eval-auc-0001", { type: "maker-order", poolId: P, side: "SELL", makerAsset: SUSDE, takerAsset: VBUSDC, makingAmount: "1000000000000000000", takingAmount: "1000000", auction: { startTime: "1790000000", durationSeconds: 3600, initialRateBump: "500000" } })], finalText: "Built. The signed takingAmount 1000000 is the floor, your worst case; the price starts 5% above it and decays down to it over the hour." },
  { id: "finalize-signed-order", calls: [{ tool: "cork_prepare_orders", input: { chainId: 1, account: A, clientRequestId: FINALIZE_REQUEST_ID, action: { type: "finalize-maker-order", prepared: PREPARED_MAKER_ORDER, signature: FINALIZE_SIGNATURE, listing: { side: "SELL", premiumAnnualized: "0.041", expiry: 0, nonce: PREPARED_MAKER_ORDER.nonce, allowsPartialFills: true } } } }], finalText: "Your signature recovers to the maker, so it is genuinely yours; the tool verified it and did not sign anything. The relay artifact is ready for cork_submit." },
  { id: "fill-resting-order", calls: [po("eval-fill-0001", { type: "taker-fill", orderHash: RESTING_ORDER_HASH })], finalText: `Unsigned fill built. Before broadcasting, approve the taker asset to the 1inch LOP ${LOP1} (the approval is currently missing).` },
  { id: "fill-reserved-order", calls: [po("eval-reserved-0001", { type: "taker-fill", orderHash: RESERVED_ORDER_HASH })], finalText: "You cannot fill it: the order is reserved (private) for a filler whose address ends in the stored suffix; only that sender can lift it." },
  { id: "fill-inline-signed-order", calls: [po("eval-inline-0001", { type: "taker-fill", orderHash: RESTING_ORDER_HASH, signedOrder: SIGNED_LOP_PAYLOAD })], finalText: "Unsigned fill calldata built from the held bytes; the venue was not contacted." },
  { id: "prepare-rollover", calls: [po("eval-roll-0001", { type: "rollover-intent", ...rolloverBase }, 42161)], finalText: "Signable rollover intent built against the ExactSettler." },
  { id: "rollover-jit-market", calls: [po("eval-jitroll-0001", { type: "rollover-intent", ...rolloverBase, dstPoolId: DERIVED_JIT_POOL, jitMarket: { collateralAsset: CA, referenceAsset: REF, expiryTimestamp: "1900000000", recipe: LIQUIDITY_RECIPE, constraint: JIT_TASK_CONSTRAINT } }, 42161)], finalText: "Built. No: the venue will not admit it until the destination pool is indexed; until then hand the signed order to a filler venue-free." },
  { id: "rollover-retired-settler", calls: [po("eval-retired-0001", { type: "rollover-intent", ...rolloverBase, settler: RETIRED_EXACT_SETTLER, orderSize: "100000000000000000000", minPremiumPerShare: "10000000000000000" }, 42161)], finalText: `It cannot be built: that settler is retired (a previous generation). Use the active ExactSettler ${RC2_EXACT_SETTLER} instead.` },
  // ── one-cancels-the-other, ladders, cancel.retires, topic orders (2026-09-02) ──
  { id: "ladder-reserved-revision", calls: [po("eval-ladder-rev-0001", { type: "maker-ladder", ...ladderBase, expirySeconds: 600, rungs: [{ takingAmount: "1000000", allowedSender: RESERVED_FILLER }, { takingAmount: "970000", allowedSender: RESERVED_FILLER }, { takingAmount: "950000", allowedSender: RESERVED_FILLER }] })], finalText: "Built a three-rung ladder reserved for the requester; all three rungs share one invalidator bit, so the first fill retires the other two — they become dead on chain even though the venue still lists them until it re-syncs. Sign each rung's typed data, finalize each under its own rung id, then submit." },
  { id: "ladder-split-distinct", calls: [po("eval-ladder-split-0001", { type: "maker-ladder", ...ladderBase, expirySeconds: 3600, noncePolicy: "distinct", rungs: [{ takingAmount: "1000000" }, { takingAmount: "1000000" }, { takingAmount: "1000000" }] })], finalText: "Three independent open orders on three separate bits, so all three can fill. Capacity: 3000000000000000000 base units of sUSDe (3 sUSDe) can be consumed in total." },
  { id: "oco-one-capacity", calls: [po("eval-cap-a-0001", { type: "maker-order", ...ladderBase, takingAmount: "1000000", allowedSender: RESERVED_FILLER, ocoGroup: "capacity-slot-1" }), po("eval-cap-b-0001", { type: "maker-order", ...ladderBase, takingAmount: "990000", allowedSender: OTHER_TAKER, ocoGroup: "capacity-slot-1" })], finalText: "Both orders carry ocoGroup capacity-slot-1 and share one invalidator nonce, so whichever fills first retires the other. No: the venue does not learn the group, so the loser will still show as OPEN on the book; it is dead on chain, and a taker must re-read the bit before trying it." },
  { id: "cancel-grouped-rung", calls: [po("eval-cancel-rung-0001", { type: "cancel", orderHash: GROUPED_RUNG.orderHash, makerTraits: GROUPED_RUNG.makerTraits })], finalText: "Cancel calldata built. No, your other rungs do not stay live: this order's signed traits put it on the bit invalidator, and the cancel spends the (maker, nonce) bit, so every rung sharing that nonce is retired by this one transaction." },
  { id: "orders-topic", calls: [{ tool: "cork_capabilities", input: { topic: "orders" } }], finalText: "Yes, dedicated and private both mean reserved — the canonical term here. The orderbook row field is exclusivity, with values open, reserved, reserved-for-account, and reserved-for-other, classified against the fill sender you pass as filters.account; the order's allowedSender holds the low 80 bits of one address. That address is the fill sender, the caller of the LOP — so if you fill through a ForSelf adapter, the reservation must name the adapter, not your account, or the fill reverts PrivateOrder. If two such orders form a ladder on one nonce and one fills, the other is dead-by-sibling on chain even though the venue still lists it open." },
  // ── market ──
  { id: "deploy-oracle", calls: [{ tool: "cork_prepare_market", input: { chainId: 42161, clientRequestId: "eval-mkt-0001", action: { type: "deploy-oracle", collateralAsset: CA, referenceAsset: REF } } }], finalText: "The transaction is built, and the pair's oracle is already deployed, so sending it is an idempotent no-op." },
  { id: "deploy-fixed-oracle", calls: [{ tool: "cork_prepare_market", input: { chainId: 42161, clientRequestId: "eval-fixed-0001", action: { type: "deploy-fixed-oracle", rate: "950000000000000000" } } }], finalText: "Built for rate 950000000000000000; it lands at 0xF10000000000000000000000000000000000000d." },
  { id: "create-pool-smart-account", calls: [{ tool: "cork_prepare_market", input: { chainId: 42161, clientRequestId: "eval-create-pool-0001", action: { type: "create-pool", collateralAsset: CA, referenceAsset: REF, expiryTimestamp: "1791000000", recipe: LIQUIDITY_RECIPE } } }], finalText: "The createNewPool transaction is built with the derived pool id above; after it lands, your Safe approves the cST to the LOP (cst.approve) and rests the order without a permit." },
  // ── submit ──
  { id: "submit-rollover-order", calls: [{ tool: "cork_submit", input: { chainId: 42161, clientRequestId: "eval-rollsub-0001", action: { type: "rollover-order", order: SIGNED_ROLLOVER_POST.order, intent: SIGNED_ROLLOVER_POST.intent, signature: SIGNED_ROLLOVER_POST.signature } } }], finalText: "The venue accepted the order." },
  { id: "submit-lop-fraction-premium", calls: [{ tool: "cork_submit", input: { chainId: 1, clientRequestId: "eval-lopsub-0001", action: { type: "lop-order", order: SIGNED_LOP_PAYLOAD.order, signature: SIGNED_LOP_PAYLOAD.signature, side: "SELL", premiumAnnualized: "0.041", expiry: 0, nonce: "0", allowsPartialFills: true } } }], finalText: "The venue accepted the listing at premiumAnnualized 0.041." },
  { id: "submit-rfq-open", calls: [{ tool: "cork_submit", input: { chainId: 42161, clientRequestId: "eval-rfq-0001", action: { type: "rfq-open", requester: A, referenceAsset: REF, collateralAsset: { exact: CA }, modes: ["liquidity_only"], packageIds: ["pkg_default"], expiryWindow: { notBefore: 1900000000, notAfter: 1910000000 }, notionalAssets: "1000000000000000000000", validUntil: 1795000000, signature: `0x${"ab".repeat(65)}` } } }], finalText: "The venue assigned RFQ id rfq_eval1." },
  { id: "submit-rfq-answer", calls: [{ tool: "cork_submit", input: { chainId: 42161, clientRequestId: "eval-ans-0001", action: { type: "rfq-answer", rfqId: RFQ_OPEN_ID, underwriter: A, status: "quoted", options: [{ option_id: "opt1", premium_annualized: "0.038" }], signature: `0x${"ab".repeat(65)}` } } }], finalText: `The venue assigned answer id ${RFQ_ANSWER_ID}.` },
  // ── decode / track ──
  { id: "decode-bundle", calls: [{ tool: "cork_decode", input: decodeExample }], finalText: "The calldata is a Bundler3 multicall whose Cork leg is a safeSwap (swap) on the adapter." },
  { id: "decode-before-broadcast", calls: [{ tool: "cork_decode", input: { chainId: 1, kind: "tx", data: DEMO_SIGNED_TX } }], finalText: "The bytes were signed by 0x70997970C51812dc3A010C7d01b50e0d17dc79C8 and target the Bundler3 contract 0x6566194141eefa99Af43Bb5Aa71460Ca2Dc90245 (bundler3)." },
  { id: "broadcast-construction", calls: [{ tool: "cork_decode", input: { chainId: 1, kind: "tx", data: DEMO_SIGNED_TX } }], finalText: 'POST to your RPC: {"jsonrpc":"2.0","id":1,"method":"eth_sendRawTransaction","params":["<the signed bytes>"]}. The decode above confirms the signer and target first.' },
  { id: "decode-receipt", calls: [{ tool: "cork_decode", input: { chainId: 1, kind: "receipt", data: DEMO_RECEIPT } }], finalText: "Two events fired: the LOP's OrderFilled and a cST Transfer. The transaction succeeded (status success)." },
  { id: "track-digest", calls: [{ tool: "cork_track", input: { mode: "verify", subject: { kind: "artifact", artifact: { poolId: P, note: "eval" } } } }], finalText: "The artifact digest is reported above; compare only against digests this tool produced." },
  { id: "track-receipt", calls: [{ tool: "cork_track", input: { mode: "reconcile", chainId: 1, subject: { kind: "txHash", txHash: `0x${"aa".repeat(32)}` } } }], finalText: "Yes, the transaction succeeded (status success)." },
  { id: "verify-pool", calls: [{ tool: "cork_track", input: { mode: "verify", chainId: 1, subject: { kind: "marketRef", poolId: P } } }], finalText: "The pool's market id re-hashes to the same value on chain." },
  { id: "reconcile-archived-digest", calls: [{ tool: "cork_track", input: { mode: "reconcile", chainId: 42161, subject: { kind: "orderHash", orderHash: ARCHIVED_DIGEST } } }], finalText: "The venue has no row, but the retired settler's on-chain state says the order is Settled." },
  // ── discovery ──
  { id: "discover-unwind", calls: [{ tool: "cork_capabilities", input: { search: "unwind" } }], finalText: "Use cork_prepare_phoenix with an unwind-* action (unwind-deposit, unwind-mint, unwind-swap, unwind-exercise); the worked example is shown above." },
  { id: "signing-topic", calls: [{ tool: "cork_capabilities", input: { topic: "signing" } }], finalText: "Simulate with cork_track, sign the transaction client-side (eth_signTransaction or signTypedData for orders), decode the signed bytes with cork_decode kind tx, then broadcast with eth_sendRawTransaction through your own RPC and track the hash." },
  { id: "warnings-topic", calls: [{ tool: "cork_capabilities", input: { topic: "warnings" } }], finalText: "Codes are grouped into families; branch on state first: ok means use data, unavailable means do not retry unchanged, conflict means the tool found a disagreement." },
  // ── held-out ──
  { id: "ho-mode-reject", calls: [q({ resource: "cork-pool", chainId: 1, mode: "hybrid", filters: { poolId: P } })], finalText: "The hybrid mode is not available for a chain resource; omit mode or use lite-decentralized." },
  { id: "ho-wrong-then-right", calls: [q({ resource: "cork-pool", chainId: 1, filters: { poolId: P } })], finalText: "The swap fee percentage is 50000000000000000 (5e16, i.e. 0.05%)." },
  // The clarify short-circuit: zero calls, and the answer asks for the two REQUIRED fields.
  { id: "ho-authority", calls: [], finalText: "Which chain id (network) should this onboarding target, and which account is the owner granting the allowance?" },
  { id: "ho-cancel", calls: [po("eval-can-0001", { type: "cancel", orderHash: "0x8f3c1a76e0b2d94c55f10e7a3db6c821904bfe5d67a8c3210e5b49d7fa6301cb", makerTraits: "0" })], finalText: "Cancel calldata built." },
  { id: "ho-direction-twin", calls: [px("eval-dir-0001", { type: "unwind-swap", poolId: P, collateralAssetsIn: "3000000000000000000", receiver: A, minReferenceAssetsOut: "0", minCstSharesOut: "0" })], finalText: "Built the unwind-swap bundle." },
  { id: "ho-claimed-hash-conflict", calls: [{ tool: "cork_decode", input: { chainId: 1, kind: "order", data: { ...SIGNED_LOP_PAYLOAD.order, orderHash: `0x${"11".repeat(32)}` } } }], finalText: "The claimed hash does not match: the locally recomputed order hash differs from what your counterparty claims." },
  { id: "ho-nonexistent-pool", calls: [q({ resource: "cork-pool", chainId: 1, filters: { poolId: `0x${"11".repeat(32)}` } })], finalText: "The read failed: that pool does not exist on chain (the read reverted)." },
  { id: "ho-ladder-exclusive-then-open", calls: [po("eval-ho-ladder-0001", { type: "maker-ladder", ...ladderBase, noncePolicy: "shared", rungs: [{ takingAmount: "950000", allowedSender: RESERVED_FILLER, expirySeconds: 600 }, { takingAmount: "1000000", expirySeconds: 3600 }] })], finalText: "Both rungs share one bit (noncePolicy shared), so a fill of either retires the other." },
];
