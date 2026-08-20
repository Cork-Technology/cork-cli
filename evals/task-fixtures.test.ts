// Fixture-coherence gate for the eval task set: one canonical correct tool call per COVERED
// task must reproduce the task's expected envelope (state + code) against the stub — offline,
// no LLM. This is the deterministic half of a task: if it fails, the task would fail for every
// agent regardless of competence (fixture rot, the class that silently turned two tasks red on
// the 0.3.3 redeploy), and no LLM tokens should be spent discovering that. The LLM half (tool
// selection, phrasing, unit translation) stays Layer B's. COVERAGE IS PARTIAL and grows with
// the task set: the six rc.2 tasks, the five highest-value earlier tasks (real signed fill,
// oracle deploy, rfq-open, rollover prepare, constraint resolve), the eight 2026-08-20
// surface-gap tasks (auction, finalize, inline fill, simulate, the gated quote, the RFQ feed,
// the fixed-rate oracle, the warnings topic) plus their two held-out siblings, and a read
// canary — extend this file when adding tasks whose outcome depends on stub fixtures.
import { describe, expect, it } from "vitest";
import { runTool } from "@cork/core";
import { TASKS } from "./tasks.ts";
import { DEMO_POOL_ID, DEMO_ACCOUNT } from "@cork/schemas";
import { stubContext } from "./stub.ts";
import {
  ARCHIVED_DIGEST,
  FINALIZE_REQUEST_ID,
  FINALIZE_SIGNATURE,
  PREPARED_MAKER_ORDER,
  RFQ_OPEN_ID,
  DERIVED_JIT_POOL,
  JIT_TASK_CONSTRAINT,
  LIQUIDITY_RECIPE,
  RC2_CLONE,
  RC2_EXACT_SETTLER,
  RC2_FACTORY,
  RESTING_ORDER_HASH,
  RETIRED_EXACT_SETTLER,
  SIGNED_LOP_PAYLOAD,
  SIGNED_ROLLOVER_POST,
} from "./stub.ts";

const SUSDE = "0x9D39A5DE30e57443BfF2A8307A4256c8797A3497";
const VBUSDC = "0x53E82ABbb12638F09d9e624578ccB666217a765e";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const rolloverBase = {
  settler: RC2_EXACT_SETTLER,
  rolloverContract: DEMO_ACCOUNT,
  srcPoolId: `0x${"11".repeat(32)}`,
  dstPoolId: `0x${"22".repeat(32)}`,
  srcCstToken: SUSDE,
  dstCstToken: VBUSDC,
  premiumToken: USDC,
  orderSize: "250000000000000000000",
  minPremiumPerShare: "12000000000000000",
  openDeadline: "1795000000",
  fillDeadline: "1795604800",
};

describe("eval task fixtures reproduce their expected envelopes (offline, canonical calls)", () => {
  it("rollover-jit-market: jitMarket build is ok, carries jit_market_notice, and the derived dst pool passes the cross-check", async () => {
    const env = await runTool(
      "cork_prepare_orders",
      {
        chainId: 42161,
        account: DEMO_ACCOUNT,
        clientRequestId: "eval-jitroll-0001",
        action: {
          type: "rollover-intent",
          ...rolloverBase,
          dstPoolId: DERIVED_JIT_POOL,
          jitMarket: {
            collateralAsset: "0x211Cc4DD073734dA055fbF44a2b4667d5E5fE5d2",
            referenceAsset: "0xdDb46999F8891663a8F2828d25298f70416d7610",
            expiryTimestamp: "1900000000",
            recipe: LIQUIDITY_RECIPE,
            constraint: JIT_TASK_CONSTRAINT,
          },
        },
      },
      stubContext(),
    );
    expect(env.state).toBe("ok");
    expect(env.warnings.some((w) => w.code === "jit_market_notice")).toBe(true);
    // Same regex↔teaching bind as the retired-settler task below.
    const jitTask = TASKS.find((t) => t.id === "rollover-jit-market")!;
    expect(jitTask.expect.answer!.test(env.warnings.find((w) => w.code === "jit_market_notice")!.message)).toBe(true);
    // The task hands the DERIVED pool id, so the cross-check must stay silent — a mismatch here
    // means the fixture's constraint/oracle drifted from the stub's resolve/lookupWrapper.
    expect(env.warnings.some((w) => w.code === "jit_pool_mismatch")).toBe(false);
  });

  it("rollover-retired-settler: refused settler_retired, teaching names the active replacement", async () => {
    const env = await runTool(
      "cork_prepare_orders",
      { chainId: 42161, account: DEMO_ACCOUNT, clientRequestId: "eval-retired-0001", action: { type: "rollover-intent", ...rolloverBase, settler: RETIRED_EXACT_SETTLER, orderSize: "100000000000000000000", minPremiumPerShare: "10000000000000000" } },
      stubContext(),
    );
    expect(env.state).toBe("unavailable");
    expect(env.warnings[0]?.code).toBe("settler_retired");
    expect(env.warnings[0]?.message).toContain(RC2_EXACT_SETTLER);
    // The task's answer regex must accept the TEACHING itself (agents relay it near-verbatim);
    // a wording change that breaks grading, or a regex whose escapes collapsed in the template
    // literal ([\s\S] → [sS] — shipped once), fails HERE, offline.
    const task = TASKS.find((t) => t.id === "rollover-retired-settler")!;
    expect(task.expect.answer!.test(env.warnings[0]!.message)).toBe(true);
  });

  it("rollover-clones-by-factory: the venue stub serves the rc.2 clone and filters by factory", async () => {
    const hit = await runTool("cork_query", { resource: "rollover-orders", chainId: 42161, filters: { kind: "contracts", factory: RC2_FACTORY } }, stubContext());
    expect(hit.state).toBe("ok");
    expect(JSON.stringify(hit.data).toLowerCase()).toContain(RC2_CLONE.slice(2, 14).toLowerCase());
    const miss = await runTool("cork_query", { resource: "rollover-orders", chainId: 42161, filters: { kind: "contracts", factory: RETIRED_EXACT_SETTLER } }, stubContext());
    expect((miss.data as { count: number }).count).toBe(0);
  });

  it("submit-rollover-order: the signed fixture relays clean (signature recovers, digest recomputes, admission passes)", async () => {
    const env = await runTool(
      "cork_submit",
      { chainId: 42161, clientRequestId: "eval-rollsub-0001", action: { type: "rollover-order", order: SIGNED_ROLLOVER_POST.order, intent: SIGNED_ROLLOVER_POST.intent, signature: SIGNED_ROLLOVER_POST.signature } },
      stubContext(),
    );
    expect(env.state).toBe("ok");
    expect((env.data as { accepted: boolean }).accepted).toBe(true);
  });

  it("reconcile-archived-digest: venue miss, but the retired settler's live state reconstructs Settled [K7]", async () => {
    const env = await runTool("cork_track", { mode: "reconcile", chainId: 42161, subject: { kind: "orderHash", orderHash: ARCHIVED_DIGEST } }, stubContext());
    expect(env.state).toBe("ok");
    expect(env.provenance.source).toBe("chain");
    const v = (env.data as { chainVerification: { settler: string; chainStatus: string } }).chainVerification;
    expect(v.chainStatus).toBe("Settled");
    expect(v.settler.toLowerCase()).toBe(RETIRED_EXACT_SETTLER.toLowerCase());
    expect(env.warnings.some((w) => w.code === "order_not_found")).toBe(true);
  });

  it("submit-lop-fraction-premium: the signed listing relays at premiumAnnualized '0.041'", async () => {
    const env = await runTool(
      "cork_submit",
      {
        chainId: 1,
        clientRequestId: "eval-lopsub-0001",
        action: { type: "lop-order", order: SIGNED_LOP_PAYLOAD.order, signature: SIGNED_LOP_PAYLOAD.signature, side: "SELL", premiumAnnualized: "0.041", expiry: 0, nonce: "0", allowsPartialFills: true },
      },
      stubContext(),
    );
    expect(env.state).toBe("ok");
  });

  it("fill-resting-order: the REAL signed resting order fills with approval_missing (the hedger task's whole spine)", async () => {
    const env = await runTool(
      "cork_prepare_orders",
      { chainId: 1, account: DEMO_ACCOUNT, clientRequestId: "eval-fill-0001", action: { type: "taker-fill", orderHash: RESTING_ORDER_HASH } },
      stubContext(),
    );
    expect(env.state).toBe("ok");
    expect(env.warnings.some((w) => w.code === "approval_missing")).toBe(true);
  });

  it("deploy-oracle: builds with oracle_already_deployed (the pair wrapper is served as live)", async () => {
    const env = await runTool(
      "cork_prepare_market",
      { chainId: 42161, clientRequestId: "eval-mkt-0001", action: { type: "deploy-oracle", collateralAsset: "0x211Cc4DD073734dA055fbF44a2b4667d5E5fE5d2", referenceAsset: "0xdDb46999F8891663a8F2828d25298f70416d7610" } },
      stubContext(),
    );
    expect(env.state).toBe("ok");
    expect(env.warnings.some((w) => w.code === "oracle_already_deployed")).toBe(true);
  });

  it("submit-rfq-open: the venue stub assigns rfq_eval1 (the answer regex's ground truth)", async () => {
    const env = await runTool(
      "cork_submit",
      { chainId: 42161, clientRequestId: "eval-rfq-0001", action: { type: "rfq-open", requester: DEMO_ACCOUNT, referenceAsset: "0xdDb46999F8891663a8F2828d25298f70416d7610", collateralAsset: { exact: "0x211Cc4DD073734dA055fbF44a2b4667d5E5fE5d2" }, modes: ["liquidity_only"], packageIds: ["pkg_default"], expiryWindow: { notBefore: 1900000000, notAfter: 1910000000 }, notionalAssets: "1000000000000000000000", validUntil: 1795000000, signature: `0x${"ab".repeat(65)}` } },
      stubContext(),
    );
    expect(env.state).toBe("ok");
    expect(JSON.stringify(env.data)).toContain("rfq_eval1");
  });

  it("prepare-rollover: the plain (no-JIT) rc.2 intent builds ok against the config settlers", async () => {
    const env = await runTool(
      "cork_prepare_orders",
      { chainId: 42161, account: DEMO_ACCOUNT, clientRequestId: "eval-roll-0001", action: { type: "rollover-intent", ...rolloverBase } },
      stubContext(),
    );
    expect(env.state).toBe("ok");
    expect((env.data as { settlerKind: string }).settlerKind).toBe("EXACT");
  });

  it("resolve-constraint: the recipe resolve fixture answers the rateMax the task's regex expects", async () => {
    const env = await runTool(
      "cork_compute",
      { chainId: 42161, params: { kind: "recipe-rate-constraint", recipe: LIQUIDITY_RECIPE, collateralAsset: "0x211Cc4DD073734dA055fbF44a2b4667d5E5fE5d2", referenceAsset: "0xdDb46999F8891663a8F2828d25298f70416d7610" } },
      stubContext(),
    );
    expect(env.state).toBe("ok");
    expect(JSON.stringify(env.data)).toContain("1600000000000000000");
  });


  // ── the 2026-08-20 surface-gap tasks ──────────────────────────────────────────────────────
  it("prepare-auction-order: the decaying-premium order builds and says the signed amount is the FLOOR", async () => {
    const env = await runTool(
      "cork_prepare_orders",
      { chainId: 1, account: DEMO_ACCOUNT, clientRequestId: "eval-auc-0001", action: { type: "maker-order", poolId: DEMO_POOL_ID, side: "SELL", makerAsset: SUSDE, takerAsset: VBUSDC, makingAmount: "1000000000000000000", takingAmount: "1000000", auction: { startTime: "1790000000", durationSeconds: 3600, initialRateBump: "500000" } } },
      stubContext(),
    );
    expect(env.state).toBe("ok");
    const notice = env.warnings.find((w) => w.code === "decaying_price_notice");
    expect(notice).toBeDefined();
    // regex<->teaching bind: the task's answer regex must accept the notice agents relay.
    const auctionTask = TASKS.find((t) => t.id === "prepare-auction-order")!;
    expect(auctionTask.expect.answer!.test(notice!.message)).toBe(true);
    // SCALE BIND: 5% at the rate-bump base of 1e7 is "500000". A task whose expectation drifted
    // to "5" would grade an agent's wrong-scale answer as correct — the percent-vs-fraction
    // collision class, one layer up (in the grader instead of the wire).
    const expectedBump = ((auctionTask.expect.params as { action: { auction: { initialRateBump: string } } }).action).auction.initialRateBump;
    expect(expectedBump).toBe("500000");
  });

  it("finalize-signed-order: the REAL external signature verifies and the artifact is caller-signed [K1]", async () => {
    const env = await runTool(
      "cork_prepare_orders",
      {
        chainId: 1,
        account: DEMO_ACCOUNT,
        // Finalization is the SAME request as its prepare [K2] — a different id is refused
        // prepared_context_mismatch, so the fixture and the task prompt share ONE constant.
        clientRequestId: FINALIZE_REQUEST_ID,
        action: { type: "finalize-maker-order", prepared: PREPARED_MAKER_ORDER, signature: FINALIZE_SIGNATURE, listing: { side: "SELL", premiumAnnualized: "0.041", expiry: 0, nonce: PREPARED_MAKER_ORDER.nonce, allowsPartialFills: true } },
      },
      stubContext(),
    );
    expect(env.state).toBe("ok");
    expect(env.warnings.some((w) => w.code === "caller_signed_artifact")).toBe(true);
    // PROMPT BIND: the task must INSTRUCT the agent to use the id the prepared fixture was
    // built with. A drifted instruction makes the task unpassable for EVERY agent
    // (prepared_context_mismatch) — an unwinnable task reads as a model failure, the worst kind
    // of eval rot. Checked on the captured instruction, not by substring: the prepared blob in
    // the prompt carries the id too, so `toContain` stays true while the instruction says
    // something else (a mutant proved exactly that, 2026-08-20).
    const finalizePrompt = TASKS.find((t) => t.id === "finalize-signed-order")!.prompt;
    expect(/request id "([^"]+)"/.exec(finalizePrompt)?.[1]).toBe(FINALIZE_REQUEST_ID);
    // The relay artifact must be present and carry the maker's own signature verbatim.
    expect(JSON.stringify(env.data)).toContain(FINALIZE_SIGNATURE);
  });

  it("fill-inline-signed-order: the venue is NOT contacted — the held bytes alone produce fill calldata", async () => {
    // A venueFetch that THROWS proves the claim structurally: if the inline path touched the
    // book, this test would fail rather than quietly passing on a stub that happened to answer.
    const ctx = { ...stubContext(), venueFetch: () => { throw new Error("venue must not be contacted on the inline path"); } };
    const env = await runTool(
      "cork_prepare_orders",
      { chainId: 1, account: DEMO_ACCOUNT, clientRequestId: "eval-inline-0001", action: { type: "taker-fill", orderHash: RESTING_ORDER_HASH, signedOrder: SIGNED_LOP_PAYLOAD } },
      ctx,
    );
    expect(env.state).toBe("ok");
    expect(env.warnings.some((w) => w.code === "unsigned_artifact")).toBe(true);
  });

  it("simulate-before-signing: the prepared bundle's frozen bytes dry-run without reverting", async () => {
    const prepared = await runTool(
      "cork_prepare_phoenix",
      { chainId: 1, account: DEMO_ACCOUNT, clientRequestId: "eval-sim-0001", fundingMode: "pre-funded", action: { type: "deposit", poolId: DEMO_POOL_ID, collateralAssetsIn: "1000000000000000000", receiver: DEMO_ACCOUNT, minCptAndCstSharesOut: "1" } },
      stubContext(),
    );
    expect(prepared.state).toBe("ok");
    const sim = await runTool("cork_track", { chainId: 1, mode: "simulate", subject: { kind: "artifact", artifact: prepared.data as Record<string, unknown> } }, stubContext());
    expect(sim.state).toBe("ok");
    expect((sim.data as { wouldRevert: boolean }).wouldRevert).toBe(false);
  });

  it("gated-rfq-quote: the one gated variant refuses phase_gated and names the shipped alternative", async () => {
    const env = await runTool("cork_compute", { chainId: 42161, params: { kind: "rfq-quote", marketTypeBucket: "stablecoin-depeg", durationSeconds: 2_592_000 } }, stubContext());
    expect(env.state).toBe("unavailable");
    expect(env.warnings[0]?.code).toBe("phase_gated");
    expect(TASKS.find((t) => t.id === "gated-rfq-quote")!.expect.answer!.test(env.warnings[0]!.message)).toBe(true);
  });

  it("rfq-discovery-feed: the open RFQ is served and labeled venue-claimed (hybrid's unverifiable family)", async () => {
    const env = await runTool("cork_query", { resource: "rfqs", chainId: 42161 }, stubContext());
    expect(env.state).toBe("ok");
    expect(JSON.stringify(env.data)).toContain(RFQ_OPEN_ID);
    // The note is what the task's answer regex grades the agent for relaying.
    expect((env.data as { note?: string }).note ?? "").toMatch(/off-chain|venue-claimed/i);
    // The stub mirrors the venue's SERVER-SIDE state filter: a non-open state answers empty,
    // never the unfiltered row (the parameter-ignored green no-op, class C13).
    const closed = await runTool("cork_query", { resource: "rfqs", chainId: 42161, filters: { state: "expired" } }, stubContext());
    expect((closed.data as { count: number }).count).toBe(0);
  });

  it("deploy-fixed-oracle: keyed on the RATE (1e18 = 1.0), predicting the CREATE2 address", async () => {
    const env = await runTool("cork_prepare_market", { chainId: 42161, clientRequestId: "eval-fixed-0001", action: { type: "deploy-fixed-oracle", rate: "950000000000000000" } }, stubContext());
    expect(env.state).toBe("ok");
    expect(TASKS.find((t) => t.id === "deploy-fixed-oracle")!.expect.answer!.test(JSON.stringify(env.data))).toBe(true);
  });

  it("warnings-topic: the doc topic answers with the family framing the task grades", async () => {
    const env = await runTool("cork_capabilities", { topic: "warnings" }, stubContext());
    expect(env.state).toBe("ok");
    expect(TASKS.find((t) => t.id === "warnings-topic")!.expect.answer!.test(JSON.stringify(env.data))).toBe(true);
  });

  it("ho-claimed-hash-conflict [held-out]: a wrong caller-claimed orderHash is refused, not endorsed [K3]", async () => {
    const env = await runTool("cork_decode", { chainId: 1, kind: "order", data: { ...SIGNED_LOP_PAYLOAD.order, orderHash: `0x${"11".repeat(32)}` } }, stubContext());
    expect(env.state).toBe("conflict");
    expect(env.warnings.some((w) => w.code === "order_hash_mismatch")).toBe(true);
  });

  it("ho-direction-twin [held-out]: the reverse-payout direction builds as unwind-swap", async () => {
    const env = await runTool(
      "cork_prepare_phoenix",
      { chainId: 1, account: DEMO_ACCOUNT, clientRequestId: "eval-dir-0001", fundingMode: "pre-funded", action: { type: "unwind-swap", poolId: DEMO_POOL_ID, collateralAssetsIn: "3000000000000000000", receiver: DEMO_ACCOUNT, minReferenceAssetsOut: "0", minCstSharesOut: "0" } },
      stubContext(),
    );
    expect(env.state).toBe("ok");
  });

  it("the demo-pool read the oldest task grades still answers (fixture canary)", async () => {
    const env = await runTool("cork_query", { resource: "cork-pool", chainId: 1, filters: { poolId: DEMO_POOL_ID } }, stubContext());
    expect(env.state).toBe("ok");
  });
});
