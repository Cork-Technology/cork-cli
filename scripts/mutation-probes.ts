// Mutation probes for the bytes-critical core logic — a REPEATABLE gate, not a one-off audit.
// Each catalog entry applies one semantic mutant to a source file, runs the focused offline test
// subset, and expects it to FAIL (the mutant is "caught"). The run exits non-zero when:
//   - any mutant SURVIVES (the suite cannot see that defect — write a killer test), or
//   - a mutant's `find` pattern no longer matches (pattern rot: the source moved; re-aim the
//     probe rather than silently losing coverage), or
//   - the clean baseline is already red (a red suite would masquerade as "caught").
// Mutants are planted and run in a DISPOSABLE SANDBOX COPY of the working tree (see the sandbox
// block in the runner): the real tree is never mutated, so concurrent vitest/eval/CLI runs in
// the tree are safe, and a kill mid-mutant strands only tmp-dir garbage. (Before 2026-08-28 the
// mutants were written into real source — the one-tree-one-runner era; observed 2026-08-27 as a
// forself selector-parity "failure" that was an in-flight mutant.) Rot checks still read the
// REAL files — probes aim at the source of record, not the copy.
//
//   bun run test:mutation            # full catalog (~2–5 min; spawns focused vitest runs)
//   bun scripts/mutation-probes.ts --only marketid,orders   # comma-separated id prefixes
//
// Selection philosophy: mutants target the places where a silent defect becomes SIGNED-BUT-WRONG
// BYTES or a wrong money answer — struct/tuple field order, enum ordinals, bit flags, hash
// inputs, rounding directions, boundary comparators, storage-slot math — not statement coverage.
// The catalog is append-only in spirit: when a survivor is killed, keep the probe.
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

interface Mutant {
  id: string;
  file: string;
  find: string;
  replace: string;
  /** Focused offline test files expected to catch the mutant. */
  tests: string[];
}

const T = {
  mr: "packages/core/test/market-registry.test.ts",
  mrLegacy: "packages/core/test/market-registry-legacy.test.ts",
  marketid: "packages/core/test/marketid.test.ts",
  create2: "packages/core/test/create2.test.ts",
  attest: "packages/core/test/create2-attestations.test.ts",
  orders: "packages/core/test/orders.test.ts",
  invalidator: "packages/core/test/lop-invalidator.test.ts",
  rollover: "packages/core/test/rollover.test.ts",
  math: "packages/core/test/math.test.ts",
  preview: "packages/core/test/preview.test.ts",
  constraint: "packages/core/test/constraint.test.ts",
  fusion: "packages/core/test/fusion.test.ts",
  fusionTrust: "packages/core/test/fusion-getter-trust.test.ts",
  bundle: "packages/core/test/bundle.test.ts",
  encoders: "packages/core/test/action-encoders.test.ts",
  funding: "packages/core/test/funding.test.ts",
  events: "packages/core/test/event-decode.test.ts",
  venue: "packages/core/test/venue.test.ts",
  venueTransport: "packages/core/test/venue-transport.test.ts",
  venueRedirect: "packages/core/test/venue-redirect.test.ts",
  venuePremium: "packages/core/test/venue-premium.test.ts",
  implementations: "packages/core/test/implementations.test.ts",
  breaker: "packages/core/test/breaker.test.ts",
  rpc: "packages/core/test/rpc.test.ts",
  handlers: "packages/core/test/handlers.test.ts",
  ladder: "packages/core/test/maker-ladder.test.ts",
  rank: "packages/core/test/orders-rank.test.ts",
  offers: "packages/core/test/offers.test.ts",
  watch: "packages/core/test/orders-watch.test.ts",
  answer: "packages/core/test/answer-rfq.test.ts",
  gate: "packages/core/test/jit-bytes-gate.test.ts",
  extraData: "packages/core/test/jit-extra-data-fixture.test.ts",
  decodeTx: "packages/core/test/decode-tx.test.ts",
  forself: "packages/core/test/forself.test.ts",
  inlineFill: "packages/core/test/taker-fill-inline.test.ts",
  hybridVerify: "packages/core/test/hybrid-verify.test.ts",
  filterScope: "packages/core/test/query-filter-scope.test.ts",
  scanCache: "packages/core/test/scan-cache.test.ts",
  phala: "packages/core/test/phala-attest.test.ts",
  cli: "packages/cli/test/cli.test.ts",
  hypersync: "packages/core/test/hypersync.test.ts",
  release: "packages/cli/test/release.test.ts",
  selfUpdateIdentity: "packages/cli/test/self-update-identity.test.ts",
  releaseTag: "packages/cli/test/release-tag.test.ts",
  mcpSignals: "packages/cli/test/mcp-signals.test.ts",
  rolloverVerify: "packages/core/test/rollover-verify.test.ts",
  eventAttribution: "packages/core/test/event-attribution.test.ts",
  taskFixtures: "evals/task-fixtures.test.ts",
  warningRegistry: "packages/core/test/warning-registry.test.ts",
  marketCreator: "packages/core/test/market-creator.test.ts",
  oracleDiag: "packages/core/test/oracle-rate-diagnosis.test.ts",
  constCache: "packages/core/test/constants-cache.test.ts",
  outputScales: "evals/output-scales-gate.test.ts",
  apiSurface: "packages/core/test/api-surface.test.ts",
  approvals: "packages/core/test/order-approvals.test.ts",
  evalGrading: "evals/grading.test.ts",
  evalHygiene: "evals/task-hygiene.test.ts",
  decodeJit: "packages/core/test/decode-jit-order.test.ts",
  decodeLop: "packages/core/test/decode-lop-call.test.ts",
  decodeTrust: "packages/core/test/decode-trust.test.ts",
  implTrust: "packages/core/test/implementation-trust.test.ts",
  makerCode: "packages/core/test/maker-code-probe.test.ts",
  port: "scripts/port-to-public.test.ts",
  evalAuth: "evals/auth-mode.test.ts",
  evalConfigPin: "evals/config-pin.test.ts",
  fetchTimeout: "packages/core/test/fetch-timeout.test.ts",
  teaching: "packages/schemas/test/teaching.test.ts",
  docTopics: "packages/core/test/doc-topics.test.ts",
  http: "packages/mcp/test/http.test.ts",
  httpAdmission: "packages/mcp/test/http-admission.test.ts",
  surfaceTier: "packages/mcp/test/surface-tier.test.ts",
};

const CATALOG: Mutant[] = [
  // ── market identity: keccak(abi.encode(Market)) — field order IS the pool id ──────────────
  {
    id: "marketid-pair-swapped",
    file: "packages/core/src/marketid.ts",
    find: "collateralAsset: market.collateralAsset,\n      referenceAsset: market.referenceAsset,",
    replace: "collateralAsset: market.referenceAsset,\n      referenceAsset: market.collateralAsset,",
    tests: [T.marketid, T.mr],
  },
  // ── CREATE2 derivation: the tamper-evidence for every trusted address ─────────────────────
  {
    id: "create2-prefix",
    file: "packages/core/src/create2.ts",
    find: 'concatHex(["0xff", getAddress(args.deployer), salt32, args.initCodeHash])',
    replace: 'concatHex(["0xfe", getAddress(args.deployer), salt32, args.initCodeHash])',
    tests: [T.create2, T.attest],
  },
  {
    id: "create2-slice-offset",
    file: "packages/core/src/create2.ts",
    find: "getAddress(slice(keccak256(packed), 12))",
    replace: "getAddress(slice(keccak256(packed), 11).slice(0, 42) as `0x${string}`)",
    tests: [T.create2, T.attest],
  },
  // ── 1inch makerTraits bit flags: the historical silent-no-op bug class ────────────────────
  {
    id: "orders-preinteraction-flag-bit",
    file: "packages/core/src/orders.ts",
    find: "const PRE_INTERACTION_CALL_FLAG = 1n << 252n;",
    replace: "const PRE_INTERACTION_CALL_FLAG = 1n << 253n;",
    tests: [T.orders],
  },
  {
    id: "orders-extension-flag-bit",
    file: "packages/core/src/orders.ts",
    find: "const HAS_EXTENSION_FLAG = 1n << 249n;",
    replace: "const HAS_EXTENSION_FLAG = 1n << 248n;",
    tests: [T.orders],
  },
  {
    id: "orders-preinteraction-detect-boundary",
    file: "packages/core/src/orders.ts",
    find: "if (off(6n) > off(5n)) flags |= PRE_INTERACTION_CALL_FLAG;",
    replace: "if (off(6n) >= off(5n)) flags |= PRE_INTERACTION_CALL_FLAG;",
    tests: [T.orders],
  },
  {
    id: "orders-nonce-shift",
    file: "packages/core/src/orders.ts",
    find: "t |= p.nonce << 120n;",
    replace: "t |= p.nonce << 121n;",
    tests: [T.orders, T.invalidator],
  },
  {
    // The group seed is namespaced: a group named "x" must NOT land on the bit a stand-alone order
    // with clientRequestId "x" uses — sharing is a choice, never an accident.
    id: "orders-oco-namespace-dropped",
    file: "packages/core/src/orders.ts",
    find: "return nonceFromSeed(`oco-group:${ocoGroup}`);",
    replace: "return nonceFromSeed(ocoGroup);",
    tests: [T.orders],
  },
  {
    // ocoGroup must actually seed the nonce — ignoring it silently gives every rung its own bit
    // and the ladder stops being one-cancels-the-other.
    id: "orders-oco-seed-ignored",
    file: "packages/core/src/orders.ts",
    find: "const nonce = a.nonce !== undefined ? a.nonce : a.ocoGroup !== undefined ? ocoGroupNonce(a.ocoGroup) : nonceFromSeed(a.clientRequestId);",
    replace: "const nonce = a.nonce !== undefined ? a.nonce : nonceFromSeed(a.clientRequestId);",
    tests: [T.orders],
  },
  {
    // The handler must hand ocoGroup to the builder — dropping the pass-through gives every rung
    // its own bit while the result still claims a group.
    id: "handler-oco-passthrough-dropped",
    file: "packages/core/src/handlers/prepare-orders.ts",
    find: "...(action.ocoGroup !== undefined ? { ocoGroup: action.ocoGroup } : {}),",
    replace: "",
    tests: [T.handlers],
  },
  {
    // The result must echo the group it built for, never a constant.
    id: "handler-oco-echo-null",
    file: "packages/core/src/handlers/prepare-orders.ts",
    find: "ocoGroup: action.ocoGroup ?? null,",
    replace: "ocoGroup: null,",
    tests: [T.handlers],
  },
  {
    // The notice is a LABEL on grouped orders only; firing it on every order is noise that hides
    // the real signal.
    id: "handler-oco-notice-ungated",
    file: "packages/core/src/handlers/prepare-orders.ts",
    find: "if (action.ocoGroup !== undefined) {",
    replace: "if (action.ocoGroup !== undefined || true) {",
    tests: [T.handlers],
  },
  {
    // cancel's `retires` must come from the SIGNED traits' nonce, not a placeholder.
    id: "handler-cancel-retires-nonce",
    file: "packages/core/src/handlers/prepare-orders.ts",
    find: "nonce: plan.nonceOrEpoch.toString(), scope: `every order by",
    replace: "nonce: \"0\", scope: `every order by",
    tests: [T.handlers],
  },
  {
    // shared-reserved must leave OPEN rungs on their own bit — grouping them silently turns a
    // "reserved ladder + open rung" into a strict one-of, and the capacity claim becomes false.
    id: "ladder-policy-open-grouped",
    file: "packages/core/src/handlers/prepare-orders.ts",
    find: 'policy === "shared" || (policy === "shared-reserved" && reserved)',
    replace: 'policy !== "distinct"',
    tests: [T.ladder],
  },
  {
    // distinct must never group.
    id: "ladder-policy-distinct-grouped",
    file: "packages/core/src/handlers/prepare-orders.ts",
    find: 'policy === "shared" || (policy === "shared-reserved" && reserved)',
    replace: 'policy === "shared" || policy === "distinct" || (policy === "shared-reserved" && reserved)',
    tests: [T.ladder],
  },
  {
    // Capacity: a group counts ONCE at its largest rung — summing a group overstates exposure.
    id: "ladder-capacity-group-summed",
    file: "packages/core/src/handlers/prepare-orders.ts",
    find: "const bucket = r.grouped ? `group:${group}` : `rung:${r.index}`;",
    replace: "const bucket = `rung:${r.index}`;",
    tests: [T.ladder],
  },
  {
    // Capacity: the largest rung, not the last one seen.
    id: "ladder-capacity-last-not-max",
    file: "packages/core/src/handlers/prepare-orders.ts",
    find: "if (r.makingAmount > prev) groupMax.set(bucket, r.makingAmount);",
    replace: "groupMax.set(bucket, r.makingAmount);",
    tests: [T.ladder],
  },
  {
    // Rung ids must carry the index — a constant suffix collides every rung on one idempotency key.
    id: "ladder-rung-id-index-dropped",
    file: "packages/core/src/orders.ts",
    find: "return `${ladderId}:${index}`;",
    replace: "return `${ladderId}:0`;",
    tests: [T.ladder],
  },
  {
    // Fail closed: a refused rung must end the ladder, never be skipped.
    id: "ladder-fail-open",
    file: "packages/core/src/handlers/prepare-orders.ts",
    find: 'if (env.state !== "ok") {\n      // Fail closed, and say which rung: the rung\'s own code and message carry the fix.\n      return envelope({',
    replace: 'if (env.state !== "ok") {\n      // Fail closed, and say which rung: the rung\'s own code and message carry the fix.\n      continue; return envelope({',
    tests: [T.ladder],
  },
  {
    // One ladder-level notice: leaking the per-rung copies is the noise the collapse exists to remove.
    id: "ladder-notice-not-collapsed",
    file: "packages/core/src/handlers/prepare-orders.ts",
    find: 'if (w.code === "oco_group_notice") continue;',
    replace: 'if (false) continue;',
    tests: [T.ladder],
  },
  {
    // The grouped flag on a rung must reflect the policy outcome, not a constant.
    id: "ladder-grouped-flag-constant",
    file: "packages/core/src/handlers/prepare-orders.ts",
    find: 'reach: reserved ? "reserved" : "open", grouped: isGrouped,',
    replace: 'reach: reserved ? "reserved" : "open", grouped: true,',
    tests: [T.ladder],
  },
  {
    // Price direction: a BUY row is better when the maker pays MORE — dropping the flip ranks
    // BUY rows cheapest-first, the wrong way round for the taker.
    id: "rank-buy-direction-dropped",
    file: "packages/core/src/orders-rank.ts",
    find: 'if (p !== 0) return a.side === "BUY" ? -p : p;',
    replace: "if (p !== 0) return p;",
    tests: [T.rank],
  },
  {
    // Reserved-for-account wins a price tie (no race); flipping it hands the tie to the open row.
    id: "rank-reserved-tie-flipped",
    file: "packages/core/src/orders-rank.ts",
    find: "if (a.reservedForAccount !== b.reservedForAccount) return a.reservedForAccount ? -1 : 1;",
    replace: "if (a.reservedForAccount !== b.reservedForAccount) return a.reservedForAccount ? 1 : -1;",
    tests: [T.rank],
  },
  {
    // Chain-confirmed beats unverified.
    id: "rank-confirmed-tie-flipped",
    file: "packages/core/src/orders-rank.ts",
    find: "if (a.confirmed !== b.confirmed) return a.confirmed ? -1 : 1;",
    replace: "if (a.confirmed !== b.confirmed) return a.confirmed ? 1 : -1;",
    tests: [T.rank],
  },
  {
    // Expiry boundary mirrors MakerTraitsLib.isExpired (`expiration < block.timestamp`): a row
    // expiring exactly now is still fillable; tightening to `<=` hides a live order.
    id: "rank-expiry-boundary-tightened",
    file: "packages/core/src/orders-rank.ts",
    find: "if (traits.expiry !== 0n && traits.expiry < opts.nowSeconds) {",
    replace: "if (traits.expiry !== 0n && traits.expiry <= opts.nowSeconds) {",
    tests: [T.rank],
  },
  {
    // A reserved-for-other row must be EXCLUDED, not ranked.
    id: "rank-reserved-other-kept",
    file: "packages/core/src/orders-rank.ts",
    find: "if (traits.allowedSender !== null && account !== undefined && !isAllowedSender(order.makerTraits, account)) {",
    replace: "if (false) {",
    tests: [T.rank],
  },
  {
    // Group collapse must keep the BEST rung and hide the rest, not serve every rung.
    id: "rank-group-collapse-dropped",
    file: "packages/core/src/orders-rank.ts",
    find: "        rep.group!.collapsed.push(s.hash);\n        continue;",
    replace: "        rep.group!.collapsed.push(s.hash);",
    tests: [T.rank],
  },
  {
    // The ranked view is the DEFAULT; making `best` opt-in silently restores newest-first.
    id: "query-orderbook-default-sort-venue",
    file: "packages/core/src/handlers/query.ts",
    find: 'if (input.resource === "orderbook" && (input.sort ?? "best") === "best") {',
    replace: 'if (input.resource === "orderbook" && input.sort === "best") {',
    tests: [T.rank],
  },
  {
    // `sort` on another resource must be refused, never silently unapplied (C13).
    id: "query-sort-refusal-dropped",
    file: "packages/core/src/handlers/query.ts",
    find: 'if (input.sort !== undefined && input.resource !== "orderbook") {',
    replace: 'if (false) {',
    tests: [T.rank],
  },
  {
    // A citation resolves on BOTH ids: keying the join on the answer alone lets an order claim
    // the terms of a sibling option.
    id: "offers-join-answer-only",
    file: "packages/core/src/handlers/query-offers.ts",
    find: "const quote = ref ? (quotes.get(`${ref.answerId}|${ref.optionId}`) ?? null) : null;",
    replace: "const quote = ref ? ([...quotes.values()].find((q) => q.answerId === ref.answerId) ?? null) : null;",
    tests: [T.offers],
  },
  {
    // Indicative = served options NO live order cites; counting cited ones too inflates the tally.
    id: "offers-indicative-counts-cited",
    file: "packages/core/src/handlers/query-offers.ts",
    find: "if (!cited.has(`${q.answerId}|${q.optionId}`)) indicative.push(",
    replace: "if (true) indicative.push(",
    tests: [T.offers],
  },
  {
    // A pass has no price: treating it as quoted invents an indicative option.
    id: "offers-pass-counted",
    file: "packages/core/src/handlers/query-offers.ts",
    find: 'if (inner.status !== undefined && inner.status !== "quoted") continue; // a pass has no price',
    replace: "",
    tests: [T.offers],
  },
  // ── the bytes-decoder gate (policy R12a): refuse off-list adapter code, read our bytes back ──
  {
    // No refusal at all: off-list adapter code would build bytes that code may misread.
    id: "gate-refusal-dropped",
    file: "packages/core/src/handlers/jit.ts",
    find: "  if (refusals.length === 0) return { warnings: [] };",
    replace: "  return { warnings: [] };",
    tests: [T.gate],
  },
  {
    // The operator override must actually be read; a dead switch is a silent refusal forever.
    id: "gate-env-ignored",
    file: "packages/core/src/handlers/jit.ts",
    find: "  if (unapprovedCodeAllowed()) {",
    replace: "  if (false) {",
    tests: [T.gate],
  },
  {
    // The gate acts on what the guard SAW: an unreadable code must never refuse.
    id: "gate-unreadable-refused",
    file: "packages/core/src/implementations.ts",
    find: 'return checks.filter((c) => roles.includes(c.role) && (c.verdict === "not_approved" || c.verdict === "no_code" || c.verdict === "proxy_unresolved"));',
    replace: 'return checks.filter((c) => roles.includes(c.role) && c.verdict !== "approved");',
    tests: [T.gate],
  },
  {
    // Refusal is scoped to the roles that DECODE bytes; the registry stays build-and-warn.
    id: "gate-roles-ignored",
    file: "packages/core/src/implementations.ts",
    find: 'return checks.filter((c) => roles.includes(c.role) && (c.verdict === "not_approved" || c.verdict === "no_code" || c.verdict === "proxy_unresolved"));',
    replace: 'return checks.filter((c) => c.verdict === "not_approved" || c.verdict === "no_code" || c.verdict === "proxy_unresolved");',
    tests: [T.gate],
  },
  {
    // The env value is a closed set: "1" or "true".
    id: "gate-env-any-value",
    file: "packages/core/src/implementations.ts",
    find: '  return v === "1" || v === "true";\n}\n\n/** Render positive findings',
    replace: '  return v !== undefined;\n}\n\n/** Render positive findings',
    tests: [T.gate],
  },
  {
    // A decoder that disagrees on a field must GATE, not be echoed as verified.
    id: "layout-mismatch-not-gated",
    file: "packages/core/src/handlers/jit.ts",
    find: '  if (differing.length === 0) return { status: "verified-on-chain: the adapter\'s decodeExtraData read these bytes back field for field" };',
    replace: '  return { status: "verified-on-chain: the adapter\'s decodeExtraData read these bytes back field for field" };',
    tests: [T.gate],
  },
  {
    // A missing helper (pre-0.4.0) is "unchecked", never a refusal — rethrowing would gate every
    // current adapter.
    id: "layout-absent-refused",
    file: "packages/core/src/handlers/jit.ts",
    find: "  } catch (err) {\n    return { status: `unchecked: the adapter exposes no decodeExtraData helper",
    replace: "  } catch (err) {\n    throw err;\n    return { status: `unchecked: the adapter exposes no decodeExtraData helper",
    tests: [T.gate],
  },
  {
    // The comparator must see the two address legs — swapping them is THE silent failure.
    id: "layout-diff-collateral-blind",
    file: "packages/core/src/market-registry.ts",
    find: '  if (lc(e.collateralAsset) !== lc(d.collateralAsset)) out.push("collateralAsset");\n  if (lc(e.referenceAsset) !== lc(d.referenceAsset)) out.push("referenceAsset");',
    replace: "",
    tests: [T.extraData, T.gate],
  },
  {
    // The comparator must see the fee legs — the other same-typed pair a swap could hide in.
    id: "layout-diff-fees-blind",
    file: "packages/core/src/market-registry.ts",
    find: '  if (e.swapFeePercentage !== d.swapFeePercentage) out.push("swapFeePercentage");\n  if (e.unwindSwapFeePercentage !== d.unwindSwapFeePercentage) out.push("unwindSwapFeePercentage");',
    replace: "",
    tests: [T.extraData, T.gate],
  },
  {
    // Permits are part of the layout too.
    id: "layout-diff-permits-blind",
    file: "packages/core/src/market-registry.ts",
    find: '  if (encoded.permits.length !== decoded.permits.length) out.push("permits.length");',
    replace: '  if (false) out.push("permits.length");',
    tests: [T.extraData],
  },
  {
    // The TAKER path must gate on its own round-trip, not only the maker path.
    id: "layout-taker-not-gated",
    file: "packages/core/src/handlers/jit.ts",
    find: '    if ("gate" in layout) return { gate: layout.gate };\n    jit.extraDataLayout = layout.status;',
    replace: '    jit.extraDataLayout = "gate" in layout ? "mismatch" : layout.status;',
    tests: [T.gate],
  },
  {
    // The MAKER path must gate on its round-trip.
    id: "layout-maker-not-gated",
    file: "packages/core/src/handlers/prepare-orders.ts",
    find: '          if ("gate" in layout) return layout.gate;\n          jitData = { ...jitData, extraDataLayout: layout.status };',
    replace: '          jitData = { ...jitData, extraDataLayout: "gate" in layout ? "mismatch" : layout.status };',
    tests: [T.gate],
  },
  {
    // The CLI flag must not leak past its own invocation (runCli is capture-everything/never-exit;
    // a stuck override would bypass the gate for every later call in the process).
    id: "cli-gate-flag-not-restored",
    file: "packages/cli/src/app.ts",
    find: '          if (opts["allowUnapprovedCode"]) {\n            if (prevUnapproved === undefined) delete process.env["CORK_ALLOW_UNAPPROVED_CODE"];\n            else process.env["CORK_ALLOW_UNAPPROVED_CODE"] = prevUnapproved;\n          }',
    replace: "",
    tests: [T.cli],
  },
  // ── answer-rfq / refresh-order: the kernel's amount math and the sugars' defaults ──
  {
    // premium_amount rounds TOWARD THE MAKER (ceil): floor shorts the maker by one unit on the golden.
    id: "answer-premium-floor",
    file: "packages/core/src/orders-answer.ts",
    find: "return ceilDiv(num * notionalAssets * tenorSeconds, den * YEAR_SECONDS);",
    replace: "return (num * notionalAssets * tenorSeconds) / (den * YEAR_SECONDS);",
    tests: [T.answer],
  },
  {
    // ACT/365, not ACT/360 — the venue and the kernel divide by 31,536,000.
    id: "answer-year-360",
    file: "packages/core/src/orders-answer.ts",
    find: "export const YEAR_SECONDS = 31_536_000n;",
    replace: "export const YEAR_SECONDS = 31_104_000n;",
    tests: [T.answer],
  },
  {
    // makingAmount is the notional as 18-decimal cST; a 6-dec collateral must scale up by 1e12.
    id: "answer-making-not-rescaled",
    file: "packages/core/src/orders-answer.ts",
    find: "return normalizeDecimals(notionalAssets, collateralDecimals, SHARE_DECIMALS);",
    replace: "return notionalAssets;",
    tests: [T.answer],
  },
  {
    // The re-rest rule has a 90 s floor so a lift has a window to land.
    id: "answer-rerest-floor-dropped",
    file: "packages/core/src/orders-answer.ts",
    find: "return Math.max(RE_REST_MIN_SECONDS, Math.min(RE_REST_MAX_SECONDS, half));",
    replace: "return Math.min(RE_REST_MAX_SECONDS, half);",
    tests: [T.answer],
  },
  {
    // The answer is RESERVED for the requester by default — an open order is a different product.
    id: "answer-reserve-dropped",
    file: "packages/core/src/handlers/prepare-orders-sugars.ts",
    find: "    ...(allowedSender !== undefined ? { allowedSender } : {}),\n    ...(quoteRef ? { quoteRef } : {}),",
    replace: "    ...(quoteRef ? { quoteRef } : {}),",
    tests: [T.answer],
  },
  {
    // Every rung answering one RFQ shares one bit by default (ocoGroup 'rfq:<rfqId>').
    id: "answer-oco-default-dropped",
    file: "packages/core/src/handlers/prepare-orders-sugars.ts",
    find: "const ocoGroup = action.ocoGroup ?? answerOcoGroup(action.rfqId);",
    replace: "const ocoGroup = action.ocoGroup ?? `answer:${input.clientRequestId}`;",
    tests: [T.answer],
  },
  {
    // A maker may cite only its OWN answer (cork-api 0.4.1 party rule) — dropping the check lets
    // a rival execute someone else's quote at that quote's terms.
    id: "answer-party-rule-dropped",
    file: "packages/core/src/handlers/prepare-orders-sugars.ts",
    find: "if (underwriter !== undefined && underwriter.toLowerCase() !== input.account.toLowerCase()) {",
    replace: "if (false) {",
    tests: [T.answer],
  },
  {
    // The cited option's premium and expiry set the amounts, not the caller's.
    id: "answer-cited-terms-ignored",
    file: "packages/core/src/handlers/prepare-orders-sugars.ts",
    find: "    premiumAnnualized = p;\n    expiryTimestamp = BigInt(e);",
    replace: "    premiumAnnualized = \"0.04\";\n    expiryTimestamp = BigInt(e);",
    tests: [T.answer],
  },
  {
    // The refresh re-rests on the SAME nonce — one bit, the two cannot both fill.
    id: "refresh-nonce-not-shared",
    file: "packages/core/src/handlers/prepare-orders-sugars.ts",
    find: "      nonce: traits.nonce,\n      ...(extension !== \"0x\" ? { extension } : {}),",
    replace: "      ...(extension !== \"0x\" ? { extension } : {}),",
    tests: [T.answer],
  },
  {
    // A spent bit REFUSES: a refresh on a dead bit could never fill.
    id: "refresh-dead-not-refused",
    file: "packages/core/src/handlers/prepare-orders-sugars.ts",
    find: 'return envelope({ state: "conflict", data: { orderHash: localHash, nonce: traits.nonce.toString(), venueStatus: "resting", chainStatus: status.status }',
    replace: 'if (false) return envelope({ state: "conflict", data: { orderHash: localHash, nonce: traits.nonce.toString(), venueStatus: "resting", chainStatus: status.status }',
    tests: [T.answer],
  },
  {
    // Only the maker refreshes its order (the new order is signed by account).
    id: "refresh-maker-check-dropped",
    file: "packages/core/src/handlers/prepare-orders-sugars.ts",
    find: "if (old.maker.toLowerCase() !== input.account.toLowerCase()) {",
    replace: "if (false) {",
    tests: [T.answer],
  },
  {
    // MakerOrderArgs.nonce is the explicit pin the refresh relies on.
    id: "orders-nonce-override-ignored",
    file: "packages/core/src/orders.ts",
    find: "const nonce = a.nonce !== undefined ? a.nonce : a.ocoGroup !== undefined ? ocoGroupNonce(a.ocoGroup) : nonceFromSeed(a.clientRequestId);",
    replace: "const nonce = a.ocoGroup !== undefined ? ocoGroupNonce(a.ocoGroup) : nonceFromSeed(a.clientRequestId);",
    tests: [T.answer],
  },
  // ── watch: the client-side watermark and verify-before-announce ──
  {
    // SELL: a LOWER unit price is better for the taker. Inverting it announces dearer orders.
    id: "watch-better-sell-inverted",
    file: "packages/core/src/orders-watch.ts",
    find: 'if (c !== p) return side === "SELL" ? c < p : c > p;',
    replace: 'if (c !== p) return side === "SELL" ? c > p : c < p;',
    tests: [T.watch],
  },
  {
    // Equal price: reserved-for-account beats open (nobody can race it). Dropping the reach rule
    // hides the one improvement a same-price order can bring.
    id: "watch-reach-ignored",
    file: "packages/core/src/orders-watch.ts",
    find: "return cand.reservedForAccount && !prev.reservedForAccount;",
    replace: "return false;",
    tests: [T.watch],
  },
  {
    // Verify before announce: a new row nobody confirmed on chain must ride under `unconfirmed`,
    // never `appeared`.
    id: "watch-unconfirmed-announced",
    file: "packages/core/src/orders-watch.ts",
    find: "if (isNew) (confirmed(row) ? appeared : unconfirmed).push(h);",
    replace: "if (isNew) appeared.push(h);",
    tests: [T.watch],
  },
  {
    // `better` is confirmed rows only — an unconfirmed better row is the corpse-announcement the
    // ruling forbids.
    id: "watch-better-unconfirmed",
    file: "packages/core/src/orders-watch.ts",
    find: "if (side && confirmed(row) && isBetterOffer(side, bestOf(row), prev.best[side])) {",
    replace: "if (side && isBetterOffer(side, bestOf(row), prev.best[side])) {",
    tests: [T.watch],
  },
  {
    // `gone` is the watermark's live set minus this read's — dropping it hides a filled best.
    id: "watch-gone-dropped",
    file: "packages/core/src/orders-watch.ts",
    find: "const gone = prev.live.filter((h) => !nowLive.has(h));",
    replace: "const gone: string[] = [];",
    tests: [T.watch],
  },
  {
    // Collapsed group rungs are part of the live set: without them a rung displaced as the
    // group's representative reads as "gone".
    id: "watch-live-excludes-collapsed",
    file: "packages/core/src/orders-watch.ts",
    find: "for (const sib of row.group?.collapsed ?? []) live.push(lower(sib));",
    replace: "",
    tests: [T.watch],
  },
  {
    // A watermark taken for another fill sender does not compare (reach and exclusion differ).
    id: "watch-account-mismatch-ignored",
    file: "packages/core/src/orders-watch.ts",
    find: "if (prev.account !== account) {",
    replace: "if (false) {",
    tests: [T.watch],
  },
  {
    // The long-poll returns on the first read that CHANGED; ignoring the change polls to timeout.
    id: "query-wait-ignores-change",
    file: "packages/core/src/handlers/query-watch.ts",
    find: 'const changed = (data.changes as { changed?: boolean } | undefined)?.changed === true;',
    replace: "const changed = false;",
    tests: [T.watch],
  },
  {
    // ceil(wait / cadence) polls: `wait: 5` at 2 s is 3 reads, not 2.
    id: "query-wait-polls-floored",
    file: "packages/core/src/handlers/query-watch.ts",
    find: "const polls = Math.max(1, Math.ceil((wait as number) / WATCH_POLL_SECONDS));",
    replace: "const polls = Math.max(1, Math.floor((wait as number) / WATCH_POLL_SECONDS));",
    tests: [T.watch],
  },
  {
    // --watch prints the first read and the ticks that CHANGED; printing every tick buries the change.
    id: "cli-watch-quiet-tick-dropped",
    file: "packages/cli/src/app.ts",
    find: "if (tick === 1 || changed || code !== EXIT.ok) {",
    replace: "if (true) {",
    tests: [T.cli],
  },
  {
    // --watch threads each read's watermark into the next as `since`; without it no tick can diff.
    id: "cli-watch-since-not-threaded",
    file: "packages/cli/src/app.ts",
    find: 'since = data["watermark"];',
    replace: "since = undefined;",
    tests: [T.cli],
  },
  {
    // A live-but-reserved row still backs its quote; counting that quote as indicative would tell a
    // hedger a firm price "cannot be bought" because THEY cannot lift it.
    id: "offers-reserved-live-not-firm",
    file: "packages/core/src/handlers/query-offers.ts",
    find: 'if ((row as { exclusion?: string }).exclusion !== "reserved-for-other") continue;',
    replace: "continue;",
    tests: [T.offers],
  },
  {
    // filters.rfqId must scope to offers executing THAT request.
    id: "offers-rfq-scope-dropped",
    file: "packages/core/src/handlers/query-offers.ts",
    find: "const scoped = filters.rfqId ? items.filter((it) => it.quote !== null && (it.quote as { rfqId: string }).rfqId === filters.rfqId) : items;",
    replace: "const scoped = items;",
    tests: [T.offers],
  },
  {
    id: "orders-taker-interaction-offset",
    file: "packages/core/src/orders.ts",
    find: "const TAKER_ARGS_INTERACTION_LENGTH_OFFSET = 200n;",
    replace: "const TAKER_ARGS_INTERACTION_LENGTH_OFFSET = 201n;",
    tests: [T.orders],
  },
  {
    id: "taker-interaction-concat-order",
    file: "packages/core/src/handlers/jit.ts",
    find: "const interaction = `0x${ladder.adapter.slice(2)}${extraData.slice(2)}` as `0x${string}`;",
    replace: "const interaction = `0x${extraData.slice(2)}${ladder.adapter.slice(2)}` as `0x${string}`;",
    tests: [T.venue],
  },
  {
    id: "predict-precalls-dropped",
    file: "packages/core/src/handlers/registry.ts",
    find: 'preCalls.push({ to: mr.registry, data: source === "fixed" && filters.rate !== undefined ? buildDeployFixedRateOracleCall(filters.rate) : buildDeployOracleCall(ca, ref, oracle.mode ?? "price") });',
    replace: "void 0;",
    tests: [T.mr],
  },
  // ── diagnoseOracleDeployFailure: the deploy-revert post-mortem's three discriminators ─────
  {
    // The collision verdict requires EVERY leg registered; some() would misdiagnose a
    // half-registered pair as the CREATE2 collision.
    id: "diagnose-collision-every-vs-some",
    file: "packages/core/src/handlers/shared.ts",
    find: "if (registered.every((found) => found === true)) {",
    replace: "if (registered.some((found) => found === true)) {",
    tests: [T.mr],
  },
  {
    // A NAMED registry error must short-circuit as a registration problem; dropping the gate
    // would run the collision heuristic on typed reverts.
    id: "diagnose-named-error-gate-dropped",
    file: "packages/core/src/handlers/shared.ts",
    find: "if (REGISTRY_DEPLOY_ERROR_NAMES.some((name) => reason.includes(name))) {",
    replace: "if (([] as string[]).some((name) => reason.includes(name))) {",
    tests: [T.mr],
  },
  {
    // The unregistered-leg verdict fires on the FIRST missing asset; requiring two would let a
    // single-missing pair fall through to the generic guess.
    id: "diagnose-missing-threshold",
    file: "packages/core/src/handlers/shared.ts",
    find: "if (missing.length > 0) {",
    replace: "if (missing.length > 1) {",
    tests: [T.mr],
  },
  {
    // The one colliding filter key (mode) rides under an ALIASED flag; dropping the alias table
    // silently removes --oracle-mode (commander rejects the flag; blob-only again).
    id: "cli-oracle-mode-alias-dropped",
    file: "packages/cli/src/app.ts",
    find: 'tool.name === "cork_query" ? [["mode", "oracle-mode"] as const] : [];',
    replace: "[];",
    tests: [T.cli],
  },
  {
    // The alias must WRITE into filters under the KEY name — accepting the flag but dropping
    // the assignment would silently ignore --oracle-mode.
    id: "cli-oracle-mode-merge-dropped",
    file: "packages/cli/src/app.ts",
    find: "            filters[key] = String(supplied);",
    replace: "            void String(supplied);",
    tests: [T.cli],
  },
  {
    // revertReason MUST prefer the decoded "Error:" line — reverting to first-match-wins
    // re-creates the bug where viem's generic shortMessage shadowed every typed error.
    id: "revertreason-decode-preference-dropped",
    file: "packages/core/src/handlers/shared.ts",
    find: 'const errorAt = lines.findIndex((l) => l.includes("Error:"));',
    replace: "const errorAt = -1;",
    tests: [T.mr],
  },
  {
    // The args line under "Error:" rides along only when it IS an args tuple.
    id: "revertreason-args-gate-flipped",
    file: "packages/core/src/handlers/shared.ts",
    find: 'const args = lines[errorAt + 1]?.trim().startsWith("(") ? ` ${lines[errorAt + 1]?.trim()}` : "";',
    replace: 'const args = "";',
    tests: [T.mr],
  },
  {
    // NOTE: the maker and taker builders contain BYTE-IDENTICAL preCalls lines; the finds below
    // disambiguate by indentation (maker sits deeper inside handlePrepareOrders). A refactor
    // that equalizes the indentation will surface here as pattern rot — re-aim, don't delete.
    id: "makerjit-precalls-dropped",
    file: "packages/core/src/handlers/prepare-orders.ts",
    find: '\n              preCalls.push({ to: ladder.registry, data: source === "fixed" ? buildDeployFixedRateOracleCall(rateOverride) : buildDeployOracleCall(jm.collateralAsset, jm.referenceAsset, oracle.mode ?? "price") });',
    replace: "\n              void 0;",
    tests: [T.mr],
  },
  {
    id: "takerjit-precalls-dropped",
    file: "packages/core/src/handlers/jit.ts",
    find: '\n        preCalls.push({ to: ladder.registry, data: source === "fixed" ? buildDeployFixedRateOracleCall(rateOverride) : buildDeployOracleCall(jm.collateralAsset, jm.referenceAsset, oracle.mode ?? "price") });',
    replace: "\n        void 0;",
    tests: [T.venue],
  },
  // ── Adapter roles pre-flight: signable-but-unfillable is exactly the silent-defect class ──
  // The comparator lives in ONE helper (readAdapterRoles) on purpose — a && → || mutant
  // reports a half-granted adapter as fillable. Killed by the PARTIAL-grant tests, which key
  // the hasRole stub on the role hash (creator granted, configurator missing).
  {
    id: "roles-gate-comparator",
    file: "packages/core/src/market-registry.ts",
    find: "return { hasCreator, hasSecond, secondRole, granted: hasCreator && hasSecond };",
    replace: "return { hasCreator, hasSecond, secondRole, granted: hasCreator || hasSecond };",
    tests: [T.mr, T.venue],
  },
  {
    // Generation probe disabled: every controller is treated as pre-0.3.2, so the pre-flight
    // checks CONFIGURATOR on a controller whose adapter actually needs FEE_MANAGER — the
    // missing-grant warning names the WRONG governance action (or stays green after a partial
    // grant). Killed by the 0.3.2-generation tests, which stub FEE_MANAGER_ROLE() answering.
    id: "roles-generation-probe-dropped",
    file: "packages/core/src/market-registry.ts",
    find: '    const probed = await probe("FEE_MANAGER_ROLE");\n    if (probed !== undefined) {',
    replace: '    const probed = await probe("FEE_MANAGER_ROLE");\n    if (false as boolean) {',
    tests: [T.mr],
  },
  {
    // Swapped role fallback: the creator-role read degrades to CONFIGURATOR when the live probe
    // has no answer, so the mixed-state stub reports POOL_CREATOR: false — the killer asserts
    // the per-role truth in the warning message.
    id: "roles-gate-creator-arg-swapped",
    file: "packages/core/src/market-registry.ts",
    find: 'const creator = roles.creator ?? (await probe("POOL_CREATOR_ROLE")) ?? POOL_CREATOR_ROLE;',
    replace: 'const creator = roles.creator ?? (await probe("POOL_CREATOR_ROLE")) ?? CONFIGURATOR_ROLE;',
    tests: [T.mr],
  },
  // Per-site warning emission (maker vs taker disambiguated by indentation, same convention as
  // the precalls probes above — indentation drift surfaces as pattern rot, re-aim, don't delete).
  // Site map, verified by enclosing function: the 6-space site is buildTakerJitInteraction (a
  // top-level helper, shallow body), the 12-space site is the maker branch nested inside
  // handlePrepareOrders — SHALLOWER indent = TAKER here, the opposite of a naive reading.
  // (The first version of these probes had the labels swapped; the survivors exposed it.)
  {
    id: "takerjit-roles-warn-dropped",
    // Anchored WITH the readAdapterRoles line: the ladder's call (chainId-only options — the
    // constants-cache opt-in) is what disambiguates it from prepareJitLegacy's role-override call.
    file: "packages/core/src/handlers/jit.ts",
    find: "const adapterRoles = await readAdapterRoles(client, boundController, mr.adapter, { chainId });\n    if (!adapterRoles.granted) {",
    replace: "const adapterRoles = await readAdapterRoles(client, boundController, mr.adapter, { chainId });\n    if (false) {",
    tests: [T.venue],
  },
  {
    // Re-aimed after the 2026-08-11 ladder extraction: the maker's own roles conditional moved
    // into the SHARED runJitPreflightLadder (covered by takerjit-roles-warn-dropped above), so
    // the maker-side defect class is now "the maker drops the ladder's warnings on the floor" —
    // roles_not_granted, deprecation_notice, funding_needs_rpc all vanish from maker results.
    id: "makerjit-roles-warn-dropped",
    file: "packages/core/src/handlers/prepare-orders.ts",
    find: "\n        warnings.push(...ladder.warnings);",
    replace: "\n        void ladder.warnings;",
    tests: [T.mr],
  },
  // ── stale_share_prediction: the consumed-nonce diagnosis (single shared emitter by design) ──
  {
    id: "stale-diagnosis-warn-dropped",
    file: "packages/core/src/handlers/jit.ts",
    find: "if (foreign && foreign.toLowerCase() !== derivedPoolId.toLowerCase()) {",
    replace: "if (false) {",
    tests: [T.mr, T.venue],
  },
  {
    // Wrong getter name: the probe answers only for "poolId", so the mutant's read throws,
    // the helper degrades to undefined, and the diagnosis silently vanishes — presence tests die.
    id: "stale-diagnosis-getter-swapped",
    file: "packages/core/src/market-registry.ts",
    find: 'abi: sharePoolIdAbi, functionName: "poolId"',
    replace: 'abi: sharePoolIdAbi, functionName: "poolId2" as never',
    tests: [T.mr, T.venue],
  },
  // ── Fusion auction ENCODE (F2): wrong bytes here become a SIGNED order priced wrong ───────
  {
    id: "fusion-encode-start-duration-swapped",
    file: "packages/core/src/fusion.ts",
    find: '    fit(a.startTime, 4, "startTime"),\n    fit(a.duration, 3, "duration"),',
    replace: '    fit(a.duration, 3, "duration"),\n    fit(a.startTime, 4, "startTime"),',
    tests: [T.fusion],
  },
  {
    id: "fusion-encode-point-fields-swapped",
    file: "packages/core/src/fusion.ts",
    find: 'parts.push(fit(p.rateBump, 3, `point ${i} rateBump`), fit(p.timeDelta, 2, `point ${i} timeDelta`));',
    replace: 'parts.push(fit(p.timeDelta, 2, `point ${i} timeDelta`), fit(p.rateBump, 3, `point ${i} rateBump`));',
    tests: [T.fusion],
  },
  {
    // Monotonic-decay enforcement [N1]: comparing against initialRateBump instead of the running
    // prevBump re-opens the down-then-up curve that every "decays to the floor" doc forbids.
    id: "fusion-encode-decay-vs-initial-not-prev",
    file: "packages/core/src/fusion.ts",
    find: "if (p.rateBump > prevBump) throw new Error(`Fusion auction point ${i}: rateBump ${p.rateBump} exceeds the preceding bump ${prevBump}",
    replace: "if (p.rateBump > a.initialRateBump) throw new Error(`Fusion auction point ${i}: rateBump ${p.rateBump} exceeds the preceding bump ${prevBump}",
    tests: [T.fusion],
  },
  {
    id: "fusion-encode-fee-section-width",
    file: "packages/core/src/fusion.ts",
    find: "parts.push(toHex(0n, { size: 7 }));",
    replace: "parts.push(toHex(0n, { size: 6 }));",
    tests: [T.fusion],
  },
  {
    // taking must equal making byte-for-byte (fusion-sdk invariant our own decoder enforces) —
    // a divergent mutant produces orders every Fusion consumer rejects.
    id: "fusion-encode-taking-diverges",
    file: "packages/core/src/fusion.ts",
    find: "return { makingAmountData: data, takingAmountData: data, settlement };",
    replace: "return { makingAmountData: data, takingAmountData: concatHex([settlement, encodeAuctionGetterData({ ...auction, initialRateBump: auction.initialRateBump + 1n })]), settlement };",
    tests: [T.fusion],
  },
  {
    id: "extension-encode-offset-index",
    file: "packages/core/src/orders.ts",
    find: "offsets |= end << (32n * BigInt(i));",
    replace: "offsets |= end << (32n * BigInt(i + 1 > 7 ? 7 : i + 1));",
    tests: [T.fusion],
  },
  // ── F2 fill side: a floor-based default cap makes the auction-fill artifact dead bytes ────
  {
    id: "takerfill-auction-cap-default-dropped",
    file: "packages/core/src/handlers/prepare-orders.ts",
    find: " : auctionCap !== undefined ? { maximumTakingAmount: auctionCap } : {}),",
    replace: " : {}),",
    tests: [T.venue],
  },
  {
    // Foreign curves may put a point ABOVE initialRateBump — a ceiling folded from initial only
    // under-caps and the fill reverts whenever the curve rises. Killed by the byte-patched
    // foreign-curve test.
    id: "takerfill-auction-maxbump-ignores-points",
    file: "packages/core/src/handlers/prepare-orders.ts",
    find: "const maxBump = auctionDec.auction.points.reduce((m, p) => (p.rateBump > m ? p.rateBump : m), auctionDec.auction.initialRateBump);",
    replace: "const maxBump = auctionDec.auction.initialRateBump;",
    tests: [T.venue],
  },
  {
    // The fusion and jit labels are NOT exclusive since F2 composed them — re-adding the old
    // guard hides the JIT commitment on exactly the rows where a taker most needs it.
    id: "decode-order-labels-exclusive-again",
    file: "packages/core/src/handlers/decode.ts",
    find: '  let jit: JitLabel | undefined;\n  try {\n    const d = decodeJitExtension(extension);',
    replace: '  let jit: JitLabel | undefined;\n  try {\n    if (fusion !== undefined) throw new Error("mutant: labels exclusive");\n    const d = decodeJitExtension(extension);',
    tests: [T.fusion],
  },
  // ── type-sweep behavior gates (2026-08-09): runtime narrowing that replaced casts ─────────
  {
    // The ok-path decode result must CARRY the positive salt-binding verdict; dropping the
    // spread silently removes a verification field consumers act on.
    id: "decode-saltbinding-verdict-dropped",
    file: "packages/core/src/handlers/decode.ts",
    find: "data: { ...base, ...saltBinding, ...(claimedOrderHash !== undefined ? { claimedOrderHash, claimedHashVerified: orderHash !== null } : {}) },",
    replace: "data: { ...base, ...(claimedOrderHash !== undefined ? { claimedOrderHash, claimedHashVerified: orderHash !== null } : {}) },",
    tests: [T.decodeJit],
  },
  {
    // Recipe constants keep only bigint answers (the cast this gate replaced would have let a
    // misdecoded value flow into display); flipping the gate drops every real constant.
    id: "registry-constant-bigint-gate-flipped",
    file: "packages/core/src/handlers/registry.ts",
    find: 'if (typeof v === "bigint") constants[name] = v.toString();',
    replace: 'if (typeof v !== "bigint") constants[name] = String(v);',
    tests: [T.mr],
  },
  {
    // The live-tail merge keeps only MINED logs; flipping the filter merges nothing (or
    // pending garbage) and the disclosed liveTail.merged count lies.
    id: "livetail-mined-filter-flipped",
    file: "packages/core/src/handlers/query.ts",
    find: "l.blockNumber !== null && l.transactionHash !== null",
    replace: "l.blockNumber === null && l.transactionHash === null",
    tests: [T.hypersync],
  },
  // ── incremental scan cursors + windowed tokenless fallback (2026-08-13) ───────────────────
  {
    // The reorg overlap disappears: the resumed scan starts past the watermark and a boundary
    // reorg's replacement events are never seen.
    id: "cursor-reorg-overlap-lost",
    file: "packages/core/src/handlers/query.ts",
    find: "const resumeFrom = cached !== undefined ? Math.max(spec.fromBlock, cached.watermark - SCAN_REORG_OVERLAP + 1) : spec.fromBlock;",
    replace: "const resumeFrom = cached !== undefined ? Math.max(spec.fromBlock, cached.watermark + 1) : spec.fromBlock;",
    tests: [T.hypersync],
  },
  {
    // The boundary filter inverts: cached history is dropped instead of kept and the resumed
    // read silently loses every old row.
    id: "cursor-boundary-filter-inverted",
    file: "packages/core/src/handlers/query.ts",
    find: "decoded = cached.rows.filter((row) => Number(row.blockNumber) < resumeFrom).concat(decoded);",
    replace: "decoded = cached.rows.filter((row) => Number(row.blockNumber) >= resumeFrom).concat(decoded);",
    tests: [T.hypersync],
  },
  {
    // A page-capped PARTIAL backfill gets written back: the next call resumes past an interior
    // gap and the missing range becomes permanently invisible.
    id: "cursor-partial-writeback-allowed",
    file: "packages/core/src/handlers/query.ts",
    find: "if (cacheId !== undefined && r.complete !== false && r.archiveHeight !== undefined) {",
    replace: "if (cacheId !== undefined && r.archiveHeight !== undefined) {",
    tests: [T.hypersync],
  },
  {
    // Cache identity loses the scan NAME: cork-pools and trading-pairs share an entry and the
    // pairs read serves unprojected market rows.
    id: "cursor-cache-name-collision",
    file: "packages/core/src/scan-cache.ts",
    find: "return `${String(a.chainId)}:${a.name}:${String(a.fromBlock)}:${addr}:${topics}`;",
    replace: "return `${String(a.chainId)}:scan:${String(a.fromBlock)}:${addr}:${topics}`;",
    tests: [T.hypersync],
  },
  {
    // Merge-on-write is lost: our stale in-process view clobbers every entry a sibling process
    // wrote since our last read (the MCP server vs CLI runs sharing one file).
    id: "scan-cache-sibling-clobber",
    file: "packages/core/src/scan-cache.ts",
    find: "  memo = undefined;\n  const file = loadFile();",
    replace: "  const file = loadFile();",
    tests: [T.scanCache],
  },
  {
    // The size cap is lost: a whole-LOP fill history serializes into the cache file on every
    // call.
    id: "scan-cache-size-cap-lost",
    file: "packages/core/src/scan-cache.ts",
    find: "if (entry.rows.length > SCAN_CACHE_MAX_ROWS) return; // too big to be worth persisting — see header",
    replace: "",
    tests: [T.scanCache],
  },
  {
    // The windowed walk stops disclosing its bound: a capped walk claims completeness.
    id: "windowed-partial-honesty-lost",
    file: "packages/core/src/datasources/hypersync.ts",
    find: "return { logs, archiveHeight: head, ...(from <= head ? { complete: false as const, nextBlock: from } : {}) };",
    replace: "return { logs, archiveHeight: head };",
    tests: [T.hypersync],
  },
  // ── rollover cursor pagination (venue 0.3.5, 2026-08-13): one vocabulary everywhere ───────
  {
    // The cursor param is dropped from the rollover wire: every page silently serves page 1
    // again — the venue's old silent-strip trap, recreated on our side.
    id: "rollover-cursor-param-lost",
    file: "packages/core/src/datasources/venue.ts",
    find: "fillable: p.fillable, source: p.source, cursor: p.cursor, limit: p.limit",
    replace: "fillable: p.fillable, source: p.source, limit: p.limit",
    tests: [T.venue],
  },
  // ── hybrid mode verification gates (2026-08-13): venue discovers, chain confirms ──────────
  {
    // The definitive half of the split rule is lost: dead book rows serve as confirmed.
    id: "hybrid-dead-row-drop-lost",
    file: "packages/core/src/handlers/hybrid-verify.ts",
    find: 'else if (classifyInvalidatorWord(ref.plan!, word).status === "filled-or-cancelled") drop("on-chain invalidator says filled-or-cancelled");',
    replace: 'else if (false) drop("on-chain invalidator says filled-or-cancelled");',
    tests: [T.hybridVerify],
  },
  {
    // The verification budget is lost: every row verifies AND the over-budget slice still
    // appends — duplicated rows, unbounded RPC cost.
    id: "hybrid-budget-slice-lost",
    file: "packages/core/src/handlers/hybrid-verify.ts",
    find: "const inBudget = rows.slice(0, HYBRID_VERIFY_BUDGET);",
    replace: "const inBudget = rows;",
    tests: [T.hybridVerify],
  },
  {
    // The vocabulary guard is lost: an unknown venue status word reads as a refutation and the
    // next venue migration deletes valid rollover rows.
    id: "hybrid-vocabulary-guard-lost",
    file: "packages/core/src/handlers/hybrid-verify.ts",
    find: 'else if (!knownVenueStatus(venueStatus) || chain.startsWith("unknown(")) {',
    replace: "else if (false) {",
    tests: [T.hybridVerify],
  },
  {
    // The pools drop gate regresses to keep: a pool no configured PM knows serves as confirmed.
    id: "hybrid-unknown-pool-drop-lost",
    file: "packages/core/src/handlers/hybrid-verify.ts",
    find: 'else drop("no configured pool manager knows this poolId");',
    replace: 'else keep(row, "confirmed");',
    tests: [T.hybridVerify],
  },
  {
    // The trading-pairs exists annotation vanishes while the row still claims confirmed.
    id: "hybrid-pairs-exists-annotation-lost",
    file: "packages/core/src/handlers/hybrid-verify.ts",
    find: 'kept.push({ ...row, verification: "confirmed", exists });',
    replace: 'kept.push({ ...row, verification: "confirmed" });',
    tests: [T.hybridVerify],
  },
  {
    // The fills match key misaligns: every venue fill fails to match its own log and the whole
    // feed drops — the comparator must slice the exact 32-byte orderHash word.
    id: "hybrid-fills-match-key-misaligned",
    file: "packages/core/src/handlers/hybrid-verify.ts",
    find: "0x${l.data.slice(2, 66).toLowerCase()}",
    replace: "0x${l.data.slice(2, 64).toLowerCase()}",
    tests: [T.hybridVerify],
  },
  {
    // The no-RPC degradation stops labeling: venue rows serve WITHOUT the unverified marker —
    // the silent-trust regression the rename exists to prevent.
    id: "hybrid-norpc-label-lost",
    file: "packages/core/src/handlers/hybrid-verify.ts",
    find: '  items: rows.map((r) => label(r, "unverified")),',
    replace: "  items: rows,",
    tests: [T.hybridVerify],
  },
  {
    // The bit-word dedup is lost: every book row of the same (maker, slot) burns its own
    // invalidator read — the default mode's RPC cost multiplies silently.
    id: "hybrid-bit-read-dedup-lost",
    file: "packages/core/src/handlers/hybrid-verify.ts",
    find: "const readKey = plan.mode === \"bit\" ? `bit:${maker}:${plan.slot.toString()}` :",
    replace: "const readKey = plan.mode === \"bit\" ? `bit:${maker}:${plan.slot.toString()}:${localHash}` :",
    tests: [T.hybridVerify],
  },
  {
    // The fills emit loop walks the clustering sort instead of the venue's row order — the
    // order-instability regression the rework fixed.
    id: "hybrid-fills-order-instability",
    file: "packages/core/src/handlers/hybrid-verify.ts",
    find: "for (const row of inBudget) {\n      const ref = refByRow.get(row);",
    replace: "for (const { row } of sorted) {\n      const ref = refByRow.get(row);",
    tests: [T.hybridVerify],
  },
  {
    // The rename teaching vanishes: "centralized" becomes a bare enum error with no pointer.
    id: "hybrid-rename-teaching-lost",
    file: "packages/schemas/src/teaching.ts",
    find: 'centralized: "hybrid",',
    replace: "",
    tests: [T.venue],
  },
  // ── full-decentralized fills join + trading-pairs derivation (2026-08-12) ─────────────────
  {
    // The join membership gate regresses to passthrough: every 1inch fill leaks into a feed
    // that claims to be Cork-scoped — the exact defect the join closed.
    id: "fills-join-membership-dropped",
    file: "packages/core/src/handlers/query.ts",
    find: "return pools ? [{ ...f, poolIds: [...pools].sort() }] : [];",
    replace: "return [{ ...f, poolIds: pools ? [...pools].sort() : [] }];",
    tests: [T.hypersync],
  },
  {
    // The poolIds annotation is lost: rows stop saying WHICH pool their transaction touched.
    id: "fills-join-annotation-lost",
    file: "packages/core/src/handlers/query.ts",
    find: "return pools ? [{ ...f, poolIds: [...pools].sort() }] : [];",
    replace: "return pools ? [{ ...f }] : [];",
    tests: [T.hypersync],
  },
  {
    // The scan-span cut regresses to genesis: the fills scan walks the whole 1inch history
    // again instead of starting where the first Cork pool exists.
    id: "fills-join-span-regressed",
    file: "packages/core/src/handlers/query.ts",
    find: "// Nothing Cork can have filled before the first pool existed — a real scan-span cut.\n          fromBlock: firstPoolBlock,",
    replace: "// Nothing Cork can have filled before the first pool existed — a real scan-span cut.\n          fromBlock: 0,",
    tests: [T.hypersync],
  },
  {
    // cPT movements stop keying the join: fills that only touch the principal token vanish,
    // and the transfer scan's address set silently halves.
    id: "fills-join-cpt-key-dropped",
    file: "packages/core/src/handlers/query.ts",
    find: "tokenToPool.set(String(m.corkPrincipalToken).toLowerCase(), String(m.poolId));",
    replace: "",
    tests: [T.hypersync],
  },
  {
    // The empty-pools early return is lost: a chain with no pools serves a joined-over-nothing
    // feed without the honest "no Cork pools exist" note.
    id: "fills-join-empty-pools-note-lost",
    file: "packages/core/src/handlers/query.ts",
    find: "if (tokenToPool.size === 0) {",
    replace: "if (false) {",
    tests: [T.hypersync],
  },
  {
    // trading-pairs regresses to raw market rows: the pair projection (and its honest-subset
    // shape) disappears while the resource still answers.
    id: "trading-pairs-projection-lost",
    file: "packages/core/src/handlers/query.ts",
    find: "decode: (logs) => decodeMarketRows(logs).map((m) => ({ poolId: m.poolId, corkSwapToken: m.corkSwapToken, collateralAsset: m.collateralAsset, referenceAsset: m.referenceAsset, expiry: m.expiry, poolManager: m.poolManager, blockNumber: m.blockNumber, txHash: m.txHash })),",
    replace: "decode: decodeMarketRows,",
    tests: [T.hypersync],
  },
  // ── port-to-public transform gates (2026-08-10): a wrong port = wrong PUBLISHED tree ─────
  {
    // Dropping notes/ from the exclusion list leaks the private tree into the public repo.
    id: "port-exclusion-notes-dropped",
    file: "scripts/port-to-public.ts",
    find: 'export const EXCLUDED_PREFIXES = ["notes/", "experiments/", "rfc/", "misc/", "slack-drafts"] as const;',
    replace: 'export const EXCLUDED_PREFIXES = ["experiments/", "rfc/", "misc/", "slack-drafts"] as const;',
    tests: [T.port],
  },
  {
    // The anchor-drift gate is what makes a reworded private line FAIL instead of silently
    // porting an un-repointed file (a private URL/reference reaching the public tree).
    id: "port-anchor-gate-dropped",
    file: "scripts/port-to-public.ts",
    find: "    if (!content.includes(r.from)) {",
    replace: "    if (false) {",
    tests: [T.port],
  },
  {
    // Excluded-only commits must be SKIPPED — minting empty commits with full messages is the
    // exact misleading-history regression observed live on 2026-08-10.
    id: "port-empty-skip-dropped",
    file: "scripts/port-to-public.ts",
    find: "      if (tree === parentTree) {",
    replace: "      if (false) {",
    tests: [T.port],
  },
  {
    // The eval self-skip gate: dropping the skip branch re-creates the 2026-08-10 regression
    // (CI without the secret proceeds keyless and paints main red with a 401).
    id: "eval-auth-skip-gate-dropped",
    file: "evals/auth-mode.ts",
    find: '  if (env.ANTHROPIC_BASE_URL) return "ambient";\n  return "skip";',
    replace: '  return "ambient";',
    tests: [T.evalAuth],
  },
  {
    // The aws branch is lost: Claude-on-AWS config falls through to keyed/skip — CI with OIDC
    // configured silently runs the wrong client (or skips) instead of SigV4.
    id: "eval-auth-aws-branch-dropped",
    file: "evals/auth-mode.ts",
    find: '  if (env.ANTHROPIC_AWS_WORKSPACE_ID || env.ANTHROPIC_AWS_API_KEY) return "aws";',
    replace: "",
    tests: [T.evalAuth],
  },
  {
    // Either marker alone must select aws; demanding both makes the documented single-variable
    // setups (workspace+OIDC role, or key alone) silently fall through.
    id: "eval-auth-aws-both-markers-required",
    file: "evals/auth-mode.ts",
    find: 'if (env.ANTHROPIC_AWS_WORKSPACE_ID || env.ANTHROPIC_AWS_API_KEY) return "aws";',
    replace: 'if (env.ANTHROPIC_AWS_WORKSPACE_ID && env.ANTHROPIC_AWS_API_KEY) return "aws";',
    tests: [T.evalAuth],
  },
  {
    // The Layer-B config pin: an unpinned eval resolves config remote-first while the stub
    // answers MARKET_REGISTRY() from the local cork-defaults.json — remote/bundled skew during
    // a registry-redeploy integration re-creates the 0.3.3 adapter_binding_mismatch eval rot.
    id: "eval-config-pin-dropped",
    file: "evals/run.ts",
    find: 'process.env.CORK_CONFIG_NO_FETCH ??= "1";',
    replace: "",
    tests: [T.evalConfigPin],
  },
  // ── the 2026-08-12 dedup helpers: each replaced 3-4 private copies of a rule, so a defect in
  // the ONE implementation now reaches every consumer at once — exactly what makes it probe-worthy ──
  {
    // fetchWithTimeout guards the venue/config/chainlist/logs transports: a no-op abort turns
    // the hard deadline into an unbounded hang (the 10s-timeout waste class the breakers exist for).
    id: "fetch-timeout-abort-dropped",
    file: "packages/core/src/fetch-timeout.ts",
    find: "const t = setTimeout(() => ctrl.abort(), timeoutMs);",
    replace: "const t = setTimeout(() => void ctrl, timeoutMs);",
    tests: [T.fetchTimeout],
  },
  {
    // A caller-provided signal must COMPOSE with the deadline, not replace it (or be replaced
    // by it): dropping the composition regresses to the `{ ...init, signal }` overwrite the
    // helper exists to prevent.
    id: "fetch-timeout-caller-signal-dropped",
    file: "packages/core/src/fetch-timeout.ts",
    find: "const signal = init.signal ? AbortSignal.any([init.signal, ctrl.signal]) : ctrl.signal;",
    replace: "const signal = ctrl.signal;",
    tests: [T.fetchTimeout],
  },
  {
    // probePairWrapper serves registry-oracle, recipe resolution AND prepare_market: an inverted
    // recorded-wrapper comparator reports every deployed oracle as undeployed (and simulates a
    // deploy for pairs that already have one).
    id: "pair-probe-deployed-inverted",
    file: "packages/core/src/handlers/registry.ts",
    find: "if (wrapper !== ZERO_ADDR) return { address: wrapper, deployed: true };",
    replace: "if (wrapper === ZERO_ADDR) return { address: wrapper, deployed: true };",
    tests: [T.mr],
  },
  {
    // probeFixedOracle's deployed verdict is getCode-decided: treating empty code as deployed
    // tells a caller the CREATE2 oracle exists when a fill would still have to deploy it.
    id: "fixed-probe-deployed-inverted",
    file: "packages/core/src/handlers/registry.ts",
    find: 'return { address: predicted, deployed: code !== undefined && code !== "0x" };',
    replace: 'return { address: predicted, deployed: code === undefined || code === "0x" };',
    tests: [T.mr],
  },
  {
    // resolveModeSugar is the ONE deprecated-mode resolver (jit ladder, registry-recipes,
    // recipe-rate-constraint): losing the hint lookup turns every legacy mode into
    // recipe_not_found, killing the still-supported sugar across all three surfaces.
    id: "mode-sugar-hint-dropped",
    file: "packages/core/src/handlers/registry.ts",
    find: "  const hinted = mr.recipes?.[mode];",
    replace: "  const hinted = undefined;",
    tests: [T.mr],
  },
  // ── runTool dispatch wiring (new seam from the per-tool split): a swapped case silently
  // answers the WRONG tool — the envelope shape hides it until a consumer trips on the data ──
  {
    id: "dispatch-track-routed-to-submit",
    file: "packages/core/src/handlers.ts",
    find: 'return handleTrack(parsed.data as TrackInput, ctx);',
    replace: 'return handleSubmit(parsed.data as never, ctx);',
    tests: [T.handlers, T.venue],
  },
  {
    id: "decode-kind-order-misrouted",
    file: "packages/core/src/handlers/decode.ts",
    find: 'if (input.kind === "order") return handleDecodeOrder(input, chainId, ctx);',
    replace: 'if (input.kind === "order") return handleDecodeEvent(input, chainId, ctx);',
    tests: [T.fusion],
  },
  // ── LOP bit invalidator: shared bits are how one fill killed every other order ────────────
  {
    id: "invalidator-slot-shift",
    file: "packages/core/src/orders.ts",
    find: 'return { mode: "bit", nonceOrEpoch, slot: nonceOrEpoch >> 8n, mask: 1n << (nonceOrEpoch & 0xffn) };',
    replace: 'return { mode: "bit", nonceOrEpoch, slot: nonceOrEpoch >> 7n, mask: 1n << (nonceOrEpoch & 0xffn) };',
    tests: [T.invalidator],
  },
  {
    id: "invalidator-mask-width",
    file: "packages/core/src/orders.ts",
    find: "mask: 1n << (nonceOrEpoch & 0xffn)",
    replace: "mask: 1n << (nonceOrEpoch & 0x7fn)",
    tests: [T.invalidator],
  },
  // ── rollover EIP-712: typehash + Call hashing feed the settler's signature check ──────────
  {
    id: "rollover-orderdata-typehash",
    file: "packages/core/src/rollover.ts",
    find: "export const ORDER_DATA_TYPEHASH: Hex = keccak256(stringToHex(ORDER_DATA_TYPE_STRING));",
    replace: "export const ORDER_DATA_TYPEHASH: Hex = keccak256(stringToHex(ROLLOVER_PARAMS_TYPE_STRING));",
    tests: [T.rollover],
  },
  {
    id: "rollover-call-hash-order",
    file: "packages/core/src/rollover.ts",
    find: "[CALL_TYPEHASH, c.target, c.value, keccak256(c.callData), c.allowFailure, c.isDelegateCall]",
    replace: "[CALL_TYPEHASH, c.target, c.value, keccak256(c.callData), c.isDelegateCall, c.allowFailure]",
    tests: [T.rollover],
  },
  // ── rc.2 wire (jitMarketHash): every mutant below produces a plausible pre-rc.2 or reordered
  // encoding whose digest no deployed settler accepts ─────────────────────────────────────────
  {
    // Reverting the params type string to the pre-rc.2 preimage regenerates the RETIRED
    // generation's typehash — the exact wire break rc.2 shipped, run backwards.
    id: "rollover-params-typestring-pre-rc2",
    file: "packages/core/src/rollover.ts",
    find: '"RolloverParams(address srcCstToken,address dstCstToken,uint256 minCaReceived,uint256 minSharesOut,bytes32 srcPoolId,bytes32 dstPoolId,address settler,bytes32 jitMarketHash)";',
    replace: '"RolloverParams(address srcCstToken,address dstCstToken,uint256 minCaReceived,uint256 minSharesOut,bytes32 srcPoolId,bytes32 dstPoolId,address settler)";',
    tests: [T.rollover],
  },
  {
    // Dropping jitMarketHash from the manual params encode keeps every remaining value correct
    // but hashes the 832-byte-era struct — the dual-implementation cross-check must catch it.
    id: "rollover-params-hash-drops-jit",
    file: "packages/core/src/rollover.ts",
    find: "        o.rolloverParams.settler,\n        o.rolloverParams.jitMarketHash,",
    replace: "        o.rolloverParams.settler,\n        o.rolloverParams.srcPoolId,",
    tests: [T.rollover],
  },
  {
    // A wrong non-zero default would sign a phantom JIT commitment on every plain order.
    id: "rollover-jit-zero-default",
    file: "packages/core/src/rollover.ts",
    find: "jitMarketHash: a.jitMarketHash ?? ZERO_JIT_MARKET_HASH,",
    replace: "jitMarketHash: a.jitMarketHash ?? ORDER_DATA_TYPEHASH,",
    tests: [T.rollover],
  },
  {
    // additionalData rides as its keccak256 (EIP-712 dynamic-type rule); committing the swap/
    // unwind fees in swapped order keeps both values plausible but breaks the commitment.
    id: "rollover-jit-params-fee-order",
    file: "packages/core/src/rollover.ts",
    find: "        keccak256(p.additionalData),\n        p.swapFeePercentage,\n        p.unwindSwapFeePercentage,",
    replace: "        keccak256(p.additionalData),\n        p.unwindSwapFeePercentage,\n        p.swapFeePercentage,",
    tests: [T.rollover],
  },
  {
    // The admission battery's past-openDeadline gate is strictly-past (the venue's own
    // comparison): widening it to <= would refuse the legal open-exactly-now boundary.
    id: "rollover-admission-open-boundary",
    file: "packages/core/src/rollover.ts",
    find: "if (t.openDeadline < t.nowSeconds) return",
    replace: "if (t.openDeadline <= t.nowSeconds) return",
    tests: [T.rollover],
  },
  {
    // premiumToken distinctness must check BOTH cSTs — halving it admits venue-rejected orders.
    id: "rollover-admission-premium-distinct",
    file: "packages/core/src/rollover.ts",
    find: "if (lc(t.premiumToken) === lc(t.srcCstToken) || lc(t.premiumToken) === lc(t.dstCstToken)) {",
    replace: "if (lc(t.premiumToken) === lc(t.srcCstToken) && lc(t.premiumToken) === lc(t.dstCstToken)) {",
    tests: [T.rollover],
  },
  {
    // Retired-settler classification must consult the LEGACY generations — skipping them
    // degrades the precise settler_retired refusal into relay-with-warning.
    id: "rollover-settler-legacy-skipped",
    file: "packages/core/src/rollover.ts",
    find: "for (const g of dep.legacyGenerations ?? []) {",
    replace: "for (const g of [] as RolloverGenerationAddresses[]) {",
    tests: [T.rollover],
  },
  {
    // Event-history scans must span every generation from the EARLIEST seed block — dropping
    // the legacy set silently empties retired-generation fills/clones/digest histories in
    // full-decentralized query AND track reconcile.
    id: "rollover-scan-targets-active-only",
    file: "packages/core/src/config-remote.ts",
    find: "const generations = [dep, ...(dep.legacyGenerations ?? [])];",
    replace: "const generations = [dep];",
    tests: [T.hypersync, T.rolloverVerify],
  },
  {
    // Generation scoping (ONE mechanism behind the digest AND factory scans): a configured
    // owner must scope to ITS generation's seed — regressing to the full span re-opens the
    // multi-million-block range that trips ordinary endpoints and starves the windowed
    // no-token fallback. Killed from BOTH consumer suites, proving both wrappers ride it.
    id: "rollover-generation-scan-full-span",
    file: "packages/core/src/config-remote.ts",
    find: "      return { addresses: [address as `0x${string}`], fromBlock: g.seededAtBlock };",
    replace: "      return { addresses: [address as `0x${string}`], fromBlock: full.fromBlock };",
    tests: [T.hypersync, T.rolloverVerify],
  },
  {
    // The membership test must consult EVERY address a generation owns — halving it to the
    // first entry silently un-scopes partial-settler digests to the full span.
    id: "rollover-generation-scan-membership",
    file: "packages/core/src/config-remote.ts",
    find: "    if (addressesOf(g).some((a) => a.toLowerCase() === lc)) {",
    replace: "    if (addressesOf(g)[0]!.toLowerCase() === lc) {",
    tests: [T.rolloverVerify],
  },  {
    // The venue-miss sweep exists so venue absence cannot silence live chain state [K7]:
    // skipping non-None statuses degrades every archived-generation reconcile to not-found.
    id: "rollover-venue-miss-sweep-inert",
    file: "packages/core/src/handlers/track.ts",
    find: 'if (chainStatus === "None") continue;',
    replace: "if (chainStatus !== undefined) continue;",
    tests: [T.rolloverVerify],
  },
  {
    // The suggestion is exact STRING math; a float-division regression re-emits the artifacts
    // (0.040999999999999995) the teaching polices — and fails its own gate.
    id: "premium-suggestion-float-division",
    file: "packages/core/src/handlers/submit.ts",
    find: "  const [int = \"0\", dec = \"\"] = repr.split(\".\");",
    replace: "  const [int = \"0\", dec = \"\"] = String(premium / 100).split(\".\"); void repr;",
    tests: [T.venuePremium],
  },
  {
    // Retired generations must stay NAMED in decode tx target labeling — dropping them turns
    // genuine Cork cancel/settle traffic into an unknown_target distrust warning.
    id: "decode-legacy-generation-naming-dropped",
    file: "packages/core/src/handlers/decode.ts",
    find: "      ...(rollover?.legacyGenerations ?? []).flatMap((g): Array<[string, string | undefined]> => [",
    replace: "      ...(undefined ?? []).flatMap((g): Array<[string, string | undefined]> => [",
    tests: [T.decodeTx],
  },
  // ── warning-code registry: membership is enforced by test, so membership must be mutable-
  //    detectable — a dropped classification (the exact drift the registry exists to catch)
  //    must fail the set-equality gate, proving the extraction actually reads the handlers ──
  {
    id: "warning-registry-code-dropped",
    file: "packages/schemas/src/doc-topics.ts",
    find: '"pool_expired", "pool_paused", "not_whitelisted",',
    replace: '"pool_expired", "not_whitelisted",',
    tests: [T.warningRegistry],
  },
  {
    // A typo'd tool name in an expectation makes its axis SILENTLY INERT: forbid never matches,
    // require can never be satisfied, prelude never widens the pick. The hygiene gate exists
    // because none of those show up as a failure — they show up as false confidence.
    id: "eval-task-names-unknown-tool",
    file: "evals/tasks.ts",
    find: 'require: ["cork_track"],',
    replace: 'require: ["cork_trak"],',
    tests: [T.evalHygiene],
  },
  {
    // Two tasks sharing an id makes CORK_EVAL_ONLY ambiguous and double-counts one in the
    // summary — a quiet distortion of every rate the run reports.
    id: "eval-task-duplicate-id",
    file: "evals/tasks.ts",
    find: 'id: "decode-receipt",',
    replace: 'id: "decode-bundle",',
    tests: [T.evalHygiene],
  },
  {
    // The read-before-write allowance must be READ-ONLY tools only; a write ahead of a prepare
    // target is a wrong pick, not a prelude.
    id: "eval-grade-readfirst-any-tool",
    file: "evals/run.ts",
    find: "const readFirst = first !== undefined && READ_ONLY_TOOLS.has(first.tool) && !READ_ONLY_TOOLS.has(e.tool);",
    replace: "const readFirst = first !== undefined && !READ_ONLY_TOOLS.has(e.tool);",
    tests: [T.evalGrading],
  },
  {
    // …and it must not excuse a wrong first pick on a READ target either.
    id: "eval-grade-readfirst-read-target",
    file: "evals/run.ts",
    find: "const readFirst = first !== undefined && READ_ONLY_TOOLS.has(first.tool) && !READ_ONLY_TOOLS.has(e.tool);",
    replace: "const readFirst = first !== undefined && READ_ONLY_TOOLS.has(first.tool);",
    tests: [T.evalGrading],
  },
  {
    // The multi-step axis must gate `ok`: without it a task whose second step never ran passes
    // on the strength of an answer describing work the trace does not contain.
    id: "eval-grade-require-not-gating-ok",
    file: "evals/run.ts",
    find: "return { ok: toolPick && paramsOk && statePass && answerPass && safe && stepsRan, toolPick",
    replace: "return { ok: toolPick && paramsOk && statePass && answerPass && safe, toolPick",
    tests: [T.evalGrading],
  },
  {
    // An INVALID call is not a step that ran: dropping the validity filter would count a
    // schema-refused attempt as the dry-run having happened.
    id: "eval-grade-require-counts-invalid-calls",
    file: "evals/run.ts",
    find: "const stepsRan = (e.require ?? []).every((t) => trace.some((c) => c.tool === t && !c.invalid));",
    replace: "const stepsRan = (e.require ?? []).every((t) => trace.some((c) => c.tool === t));",
    tests: [T.evalGrading],
  },
  {
    // The exact regression this guards against: the answer regex going stale against the
    // fixture's actual row count (five weeks at "empty" once; the count moved 1 -> 2 when the
    // RESERVED sibling landed 2026-08-27). The killer test pins regex and book together; this
    // mutant reintroduces the previous count, the most tempting wrong value at every move.
    id: "eval-task-orderbook-count-stale",
    file: "evals/tasks.ts",
    find: 'answer: /\\b2\\b|\\btwo\\b/i, maxCalls: 2 } },',
    replace: 'answer: /\\b1\\b|\\bone\\b/i, maxCalls: 2 } },',
    tests: [T.taskFixtures],
  },
  {
    // The [K1] safety axis must gate `ok`. Dropping it from the conjunction makes an agent that
    // prepares bytes AND relays them to the venue score a perfect task — the exact unrequested
    // side effect the axis exists to catch, invisible again.
    id: "eval-grade-forbid-not-gating-ok",
    file: "evals/run.ts",
    find: "&& answerPass && safe && stepsRan, toolPick",
    replace: "&& answerPass && stepsRan, toolPick",
    tests: [T.evalGrading],
  },
  {
    // The detection predicate itself: a `forbid` list that is never consulted reports every
    // trace safe, which is indistinguishable from having no safety axis at all.
    id: "eval-grade-forbid-never-detected",
    file: "evals/run.ts",
    find: "const safe = !trace.some((c) => e.forbid?.includes(c.tool) ?? false);",
    replace: "const safe = true;",
    tests: [T.evalGrading],
  },
  // ── eval stub fidelity: the stub must MIRROR venue behavior, not ignore parameters ─────────
  {
    // The receipt fixture's logs must be GENUINELY encoded from the decoder's own signatures.
    // A drifted topic0 decodes to `raw`/unknown — the task would then grade an agent's honest
    // "I cannot identify these events" as a miss, and the ABI drift would go unnoticed.
    id: "eval-stub-receipt-topic-drift",
    file: "evals/stub.ts",
    // The drift must be in a TYPE (or the event name): topic0 hashes the signature, so renaming
    // a parameter is inert — a first attempt at this probe mutated `remainingAmount` and
    // survived, which is the probe being wrong, not the suite (2026-08-20).
    find: 'const ORDER_FILLED = parseAbiItem("event OrderFilled(bytes32 orderHash, uint256 remainingAmount)");',
    replace: 'const ORDER_FILLED = parseAbiItem("event OrderFilled(bytes32 orderHash, uint128 remainingAmount)");',
    tests: [T.taskFixtures],
  },
  {
    // getCode is ADDRESS-AWARE on purpose: the ForSelf adapter is a contract, every other
    // fixture account an EOA. A blanket-EOA stub refuses the adapter (no contract there) and
    // makes the whole ForSelf surface untestable — which is how it went uncovered until now.
    id: "eval-stub-forself-adapter-codeless",
    file: "evals/stub.ts",
    find: "          if (address === FORSELF_ADAPTER.toLowerCase()) return FORSELF_ADAPTER_CODE;",
    replace: "",
    tests: [T.taskFixtures],
  },
  {
    // An implementation-role address answers "0x" instead of throwing: the guard then hashes
    // an EMPTY account and warns implementation_not_approved on every prepare the evals grade.
    id: "eval-stub-impl-role-answers-empty",
    file: "evals/stub.ts",
    find: "          if (IMPLEMENTATION_ROLE_ADDRESSES.has(address)) throw new Error(`eval stub holds no bytecode for ${address}`);",
    replace: "",
    tests: [T.taskFixtures],
  },
  {
    // The ForSelf pre-flight compares CORK() against the POOL MANAGER; answering the Cork
    // adapter instead is the exact confusion that makes an integrator grant an allowance to a
    // contract bound to another stack. The stub must model the real binding, not a plausible one.
    id: "eval-stub-forself-cork-binding-wrong",
    file: "evals/stub.ts",
    find: 'return (corkDefaults as { deployments: Record<string, { poolManager: string }> }).deployments["1"]!.poolManager;',
    replace: 'return (corkDefaults as { deployments: Record<string, { corkAdapter: string }> }).deployments["1"]!.corkAdapter;',
    tests: [T.taskFixtures],
  },
  {
    // The venue answers an ANSWER id on /answers; serving the RFQ id instead leaves the
    // handler's `answer_id ?? null` null while the relay still looks accepted — the one field
    // the underwriter needs, quietly absent.
    id: "eval-stub-rfq-answer-id-shape",
    file: "evals/stub.ts",
    find: 'if (url.includes("/answers")) return r(201, { answer_id: RFQ_ANSWER_ID, rfq_id: RFQ_OPEN_ID });',
    replace: 'if (url.includes("/answers")) return r(201, { rfq_id: RFQ_OPEN_ID });',
    tests: [T.taskFixtures],
  },

  {
    // The stub's factory filter mirrors the venue's server-side filtering; a stub that ignores
    // the parameter grades a task that never exercised the filter (a green no-op, class C13).
    id: "eval-stub-factory-filter-ignored",
    file: "evals/stub.ts",
    find: "const items = factory && factory.toLowerCase() !== RC2_FACTORY.toLowerCase() ? [] : [row];",
    replace: "const items = [row];",
    tests: [T.taskFixtures],
  },
  {
    // Same class as the factory filter: the RFQ feed's state filter is SERVER-SIDE at the venue.
    // A stub that serves the open row regardless of `state` would let a "closed feed" read look
    // populated — and the discovery task would grade a filter that never ran (green no-op, C13).
    id: "eval-stub-rfq-state-filter-ignored",
    file: "evals/stub.ts",
    find: 'return r(200, { items: state === "open" ? [withAnswers ? { ...row, answers, answer_count: answers.length } : row] : [], nextCursor: null, hasMore: false });',
    replace: 'return r(200, { items: [withAnswers ? { ...row, answers, answer_count: answers.length } : row], nextCursor: null, hasMore: false });',
    tests: [T.taskFixtures],
  },
  {
    // The finalize fixture's signature must be over the PREPARED hash. Signing a different hash
    // (here: the resting order's) still yields a syntactically valid 65-byte signature, so a
    // suite that never checks recovery would pass a fixture the handler must refuse — the task
    // would then grade nothing but the agent's ability to call a tool that always conflicts.
    id: "eval-stub-finalize-signature-wrong-hash",
    file: "evals/stub.ts",
    find: "export const FINALIZE_SIGNATURE = await FINALIZE_MAKER.sign({ hash: PREPARED_MAKER_ORDER.orderHash as `0x${string}` });",
    replace: "export const FINALIZE_SIGNATURE = await FINALIZE_MAKER.sign({ hash: RESTING_ORDER_HASH });",
    tests: [T.taskFixtures],
  },
  {
    // Finalization is the SAME request as its prepare [K2]: a prompt that names a DIFFERENT
    // request id than the prepared fixture carries makes the task unpassable for every agent
    // (prepared_context_mismatch). Mutating the shared constant is inert — prompt and fixture
    // move together — so the defect is planted where drift actually happens: the prompt.
    id: "eval-task-finalize-prompt-id-drift",
    file: "evals/tasks.ts",
    find: '(chain 1, request id "${FINALIZE_REQUEST_ID}")',
    replace: '(chain 1, request id "eval-fin-other")',
    tests: [T.taskFixtures],
  },
  // ── eval task set: an expectation that grades nothing must fail a test, not pass quietly ────
  {
    // The auction task's whole point is the 1e7-base rate bump: 5% is "500000", not "5". The
    // defect lives in the TASK's expectation (mutating the test's own canonical call is
    // circular — a test cannot catch its own edit): an expectation at the wrong scale grades an
    // agent's wrong-scale answer as correct.
    id: "eval-task-auction-bump-scale",
    file: "evals/tasks.ts",
    find: 'params: { action: { type: "maker-order", auction: { initialRateBump: "500000", durationSeconds: 3600 } } },',
    replace: 'params: { action: { type: "maker-order", auction: { initialRateBump: "5", durationSeconds: 3600 } } },',
    tests: [T.taskFixtures],
  },
  {
    // The venue-free CLAIM, planted in the SOURCE (mutating the test's throwing-venueFetch guard
    // would be circular): if the handler stops honoring `signedOrder` and falls through to the
    // book, a caller holding valid bytes is blocked whenever the venue is down — exactly the
    // failure the inline path exists to remove. The throwing-fetch fixture test is its killer.
    id: "inline-fill-falls-through-to-venue",
    file: "packages/core/src/handlers/prepare-orders.ts",
    find: "    if (action.signedOrder) {\n      const so = action.signedOrder;",
    replace: "    if (false && action.signedOrder) {\n      const so = action.signedOrder!;",
    tests: [T.taskFixtures],
  },
  // ── CREATE2 attestations: binds is the attestation↔config drift gate; salts are identity ──
  {
    // A binds path pointing at the WRONG config field would let the attestation and the served
    // config drift apart while the gate stays green — the exact silent failure binds exists to
    // prevent (registry vs adapter are different addresses, so the swap must fail the test).
    id: "attestation-binds-path-swapped",
    file: "packages/core/src/config.ts",
    find: 'binds: { section: "marketRegistry", chains: [42161, 8453], path: "adapter" },',
    replace: 'binds: { section: "marketRegistry", chains: [42161, 8453], path: "registry" },',
    tests: [T.attest],
  },
  {
    // Cross-wiring two phoenix entries' salts keeps every VALUE plausible but breaks both
    // derivations — the local re-derivation test must catch a tampered/miscopied salt.
    id: "attestation-phoenix-salt-swapped",
    file: "packages/core/src/config.ts",
    find: 'name: "poolManagerV13",\n    salt: "0xee0ccc36f7c20be262d77eed4fee79a4569918c84e94b751c375ca720bd910bb",',
    replace: 'name: "poolManagerV13",\n    salt: "0xddcbb6a4d6a401dc57afc714560c71a1ef107c2a74589ed9fc8308243853f106",',
    tests: [T.attest],
  },
  // ── math ports: rounding direction is wei-for-wei parity ──────────────────────────────────
  {
    id: "muldiv-ceil-dropped",
    file: "packages/core/src/math/fixed.ts",
    find: 'if (rounding === "ceil" && p % d !== 0n) q += 1n;',
    replace: 'if (rounding === "ceil" && p % d !== 0n) q += 0n;',
    tests: [T.math, T.preview],
  },
  {
    id: "fee-rounding-floor",
    file: "packages/core/src/math/mathhelper.ts",
    find: 'return mulDiv(amount, fee1e18, PCT_DENOM, "ceil");',
    replace: 'return mulDiv(amount, fee1e18, PCT_DENOM, "floor");',
    tests: [T.math, T.preview],
  },
  {
    // The settler charges ceil (LibAtomicFill.computeRequiredPremium, Rounding.Ceil); a floor
    // flip understates the maker's guaranteed premium by 1 wei on any remainder — the exact bug
    // the 2026-08-10 audit found (it had survived because the only vector was remainder-free).
    id: "premium-floor-rounding-flipped",
    file: "packages/core/src/handlers/compute.ts",
    find: 'const floor = mulDiv(BigInt(p.dstCstProduced), BigInt(p.minPremiumPerShare), WAD, "ceil");',
    replace: 'const floor = mulDiv(BigInt(p.dstCstProduced), BigInt(p.minPremiumPerShare), WAD, "floor");',
    tests: [T.handlers],
  },
  // ── MCP number-precision guards: dropping either re-opens silent JSON-float laundering ──────
  {
    // parseOrderRecord: an unsafe-integer JSON number is already rounded by the parse; without
    // the refusal, String() launders the rounded value into the struct/orderHash with state ok
    // (observed empirically over MCP stdio, 2026-08-10 — the CLI's F22 guard never covered MCP).
    id: "order-record-unsafe-number-guard-dropped",
    file: "packages/core/src/handlers/decode.ts",
    find: 'if (typeof raw === "number" && !Number.isSafeInteger(raw)) {',
    replace: 'if (typeof raw === "number" && false) {',
    tests: [T.handlers],
  },
  {
    // filters.rate: same laundering path; a rounded rate keys a wrong CREATE2 oracle address.
    id: "filters-rate-unsafe-number-guard-dropped",
    file: "packages/core/src/handlers/filters.ts",
    find: 'if (typeof raw.rate === "number" && !Number.isSafeInteger(raw.rate)) {',
    replace: 'if (typeof raw.rate === "number" && false) {',
    tests: [T.handlers],
  },
  // ── token bucket: the impairment floor's worst case must stay a floor ─────────────────────
  {
    id: "bucket-cap-max",
    file: "packages/core/src/math/constraint.ts",
    find: "const creditsCapped = min(p.rateChangeCapacityMax, p.remainingCredits + refilled);",
    replace: "const creditsCapped = max(p.rateChangeCapacityMax, p.remainingCredits + refilled);",
    tests: [T.constraint],
  },
  {
    id: "bucket-consume-uncapped",
    file: "packages/core/src/math/constraint.ts",
    find: "const creditsConsumed = min(absIncoming, creditsCapped);",
    replace: "const creditsConsumed = absIncoming;",
    tests: [T.constraint],
  },
  // ── Fusion dutch auction: byte-offset parsing is the whole price ──────────────────────────
  {
    id: "fusion-duration-offset",
    file: "packages/core/src/fusion.ts",
    find: "duration: num(extraData, 11, 14),",
    replace: "duration: num(extraData, 11, 13),",
    tests: [T.fusion],
  },
  {
    id: "fusion-point-ratebump-width",
    file: "packages/core/src/fusion.ts",
    find: "auction.points.push({ rateBump: num(extraData, off, off + 3), timeDelta: num(extraData, off + 3, off + 5) });",
    replace: "auction.points.push({ rateBump: num(extraData, off, off + 2), timeDelta: num(extraData, off + 3, off + 5) });",
    tests: [T.fusion],
  },
  // ── Bundler3 Call struct: field order is what gets signed and executed ────────────────────
  {
    id: "bundler3-call-field-order",
    file: "packages/core/src/bundle/bundler3.ts",
    find: '"function multicall((address to, bytes data, uint256 value, bool skipRevert, bytes32 callbackHash)[] bundle) payable"',
    replace: '"function multicall((address to, bytes data, bool skipRevert, uint256 value, bytes32 callbackHash)[] bundle) payable"',
    tests: [T.bundle, T.encoders],
  },
  // ── sweep-back: the receiver is the difference between refund and skimmable residual ──────
  {
    id: "funding-sweep-receiver-adapter",
    file: "packages/core/src/bundle/funding.ts",
    find: 'sweepLegs.push(call(adapter, encodeFunctionData({ abi: bundlerSweepAbi, functionName: "erc20Transfer", args: [token, target, MAX_UINT] })));',
    replace: 'sweepLegs.push(call(adapter, encodeFunctionData({ abi: bundlerSweepAbi, functionName: "erc20Transfer", args: [token, adapter, MAX_UINT] })));',
    tests: [T.funding],
  },
  // ── handler guards: boundary comparators around fund-moving reverts ───────────────────────
  {
    id: "jit-fee-cap-boundary",
    file: "packages/core/src/handlers/jit.ts",
    find: "if (swapFee > cap || unwindFee > cap) {",
    replace: "if (swapFee >= cap || unwindFee >= cap) {",
    tests: [T.mr],
  },
  {
    id: "jit-expiry-boundary",
    file: "packages/core/src/handlers/jit.ts",
    find: "if (expiryTimestamp <= nowSecs) {",
    replace: "if (expiryTimestamp < nowSecs) {",
    tests: [T.mr],
  },
  {
    id: "binding-guard-inverted",
    file: "packages/core/src/handlers/registry.ts",
    find: "bindingGuardCache.set(key, bound.toLowerCase() === mr.registry.toLowerCase());",
    replace: "bindingGuardCache.set(key, bound.toLowerCase() !== mr.registry.toLowerCase());",
    tests: [T.mr],
  },
  // ── 2.1.0 registry surface (survivor-hardened 2026-08-03; keep green forever) ─────────────
  {
    id: "jitparams-field-order",
    file: "packages/core/src/market-registry.ts",
    find: '{ name: "recipe", type: "address" },\n      { name: "rateOverride", type: "uint256" },',
    replace: '{ name: "rateOverride", type: "uint256" },\n      { name: "recipe", type: "address" },',
    tests: [T.mr],
  },
  {
    id: "jitparams-constraint-order",
    file: "packages/core/src/market-registry.ts",
    find: '{ name: "rateMin", type: "uint256" },\n          { name: "rateMax", type: "uint256" },',
    replace: '{ name: "rateMax", type: "uint256" },\n          { name: "rateMin", type: "uint256" },',
    tests: [T.mr],
  },
  {
    id: "oracle-mode-inverted",
    file: "packages/core/src/market-registry.ts",
    find: "export const ORACLE_MODE = { price: 0, nav: 1 } as const;",
    replace: "export const ORACLE_MODE = { price: 1, nav: 0 } as const;",
    tests: [T.mr],
  },
  {
    id: "recipe-source-order",
    file: "packages/core/src/market-registry.ts",
    find: 'export const RECIPE_SOURCE = ["nav", "price", "fixed"] as const;',
    replace: 'export const RECIPE_SOURCE = ["price", "nav", "fixed"] as const;',
    tests: [T.mr],
  },
  {
    id: "role-slot-encode-order",
    file: "packages/core/src/market-registry.ts",
    find: 'const roleDataSlot = keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [role, 0n]));',
    replace: 'const roleDataSlot = keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "bytes32" }], [0n, role]));',
    tests: [T.mr],
  },
  {
    id: "market-field-cross",
    file: "packages/core/src/market-registry.ts",
    find: "rateChangePerDayMax: args.constraint.rateChangePerDayMax,\n    rateChangeCapacityMax: args.constraint.rateChangeCapacityMax,",
    replace: "rateChangePerDayMax: args.constraint.rateChangeCapacityMax,\n    rateChangeCapacityMax: args.constraint.rateChangePerDayMax,",
    tests: [T.mr],
  },
  {
    id: "shares-decode-swapped",
    file: "packages/core/src/market-registry.ts",
    find: "const cpt = getAddress(`0x${last.data.slice(2 + 24, 2 + 64)}`);\n      const cst = getAddress(`0x${last.data.slice(2 + 64 + 24, 2 + 128)}`);",
    replace: "const cst = getAddress(`0x${last.data.slice(2 + 24, 2 + 64)}`);\n      const cpt = getAddress(`0x${last.data.slice(2 + 64 + 24, 2 + 128)}`);",
    tests: [T.mr],
  },
  {
    id: "jit-event-sig-drift",
    file: "packages/core/src/market-registry.ts",
    find: 'toEventSelector("JITMarketCreated(bytes32,address,address,address,uint256,address)")',
    replace: 'toEventSelector("JITMarketCreated(bytes32,address,address,address,uint256,string)")',
    tests: [T.mr, T.events],
  },
  {
    id: "extension-offset-field",
    file: "packages/core/src/market-registry.ts",
    find: "const offsets = (end << (32n * 6n)) | (end << (32n * 7n));",
    replace: "const offsets = (end << (32n * 5n)) | (end << (32n * 7n));",
    tests: [T.mr, T.mrLegacy],
  },
  {
    id: "deprecation-gate-bypass",
    file: "packages/core/src/deprecation.ts",
    find: 'return v === "1" || v === "true";',
    replace: "return true;",
    tests: [T.mrLegacy],
  },
  // ── event decode: the LOP OrderCancelled fallback must actually exist ─────────────────────
  // (Note: SWAPPING the two ABIs is an EQUIVALENT mutant — the strict decoders disambiguate by
  // topic count, so no log ever matches both. Dropping the fallback is the observable defect.)
  {
    id: "eventdecode-fallback-dropped",
    file: "packages/core/src/event-decode.ts",
    find: "for (const abi of [KNOWN_EVENTS_ABI, LOP_CANCELLED_FALLBACK_ABI]) {",
    replace: "for (const abi of [KNOWN_EVENTS_ABI]) {",
    tests: [T.events],
  },
  // ── decode kind:"tx": the validate-before-broadcast step — its two comparators are what a
  //    client trusts before eth_sendRawTransaction ────────────────────────────────────────────
  {
    // Signer-recovery wiring: a decoder that stops recovering (echoing something plausible
    // instead) would let a wrong-key signature pass the pre-broadcast check.
    id: "decodetx-signer-not-recovered",
    file: "packages/core/src/handlers/decode.ts",
    find: "const signer = await recoverTransactionAddress({ serializedTransaction: raw as TransactionSerialized });",
    replace: "const signer = ZERO_ADDR as `0x${string}`;",
    tests: [T.decodeTx],
  },
  {
    // Target cross-check: inverting the address comparator mislabels every target (and silences
    // the unknown-target warning), defeating the "is `to` the contract I expect" question.
    id: "decodetx-target-label-inverted",
    file: "packages/core/src/handlers/decode.ts",
    find: "candidates.find(([, addr]) => addr !== undefined && addr.toLowerCase() === to.toLowerCase())",
    replace: "candidates.find(([, addr]) => addr !== undefined && addr.toLowerCase() !== to.toLowerCase())",
    tests: [T.decodeTx],
  },
  {
    // chainId conflict gate: the signature commits to the tx's chainId — an inverted comparator
    // would bless wrong-chain broadcasts and conflict the honest ones.
    id: "decodetx-chainid-gate-inverted",
    file: "packages/core/src/handlers/decode.ts",
    find: "if (input.chainId !== undefined && txChainId !== undefined && input.chainId !== txChainId) {",
    replace: "if (input.chainId !== undefined && txChainId !== undefined && input.chainId === txChainId) {",
    tests: [T.decodeTx],
  },
  {
    // Envelope enum guard: dropping the ChainId membership check leaks an exotic tx chainId into
    // provenance, making the result violate the advertised outputSchema.
    id: "decodetx-chain-enum-guard-dropped",
    file: "packages/core/src/handlers/decode.ts",
    find: "const txChainKnown = txChainId === undefined || ChainId.safeParse(txChainId).success;",
    replace: "const txChainKnown = true;",
    tests: [T.decodeTx],
  },
  // ── Phala attestation: the byte math a third-party deployment verdict stands on ───────────
  {
    // Measurement chain order: SHA384(old || digest), never the reverse.
    id: "phala-rtmr-concat-swapped",
    file: "packages/core/src/phala-attest.ts",
    find: "rtmr = sha384(Buffer.concat([rtmr, digest]));",
    replace: "rtmr = sha384(Buffer.concat([digest, rtmr]));",
    tests: [T.phala],
  },
  {
    // RTMR3 measures ONLY imr==3 events — folding other registers' events in breaks the replay.
    id: "phala-rtmr-imr-filter",
    file: "packages/core/src/phala-attest.ts",
    find: "if (e.imr !== 3) continue;",
    replace: "if (e.imr > 3) continue;",
    tests: [T.phala],
  },
  {
    // Short digests pad on the RIGHT (documented replay detail) — left-padding measures differently.
    id: "phala-rtmr-pad-left",
    file: "packages/core/src/phala-attest.ts",
    find: "digest = Buffer.concat([digest, Buffer.alloc(48 - digest.length, 0)]);",
    replace: "digest = Buffer.concat([Buffer.alloc(48 - digest.length, 0), digest]);",
    tests: [T.phala],
  },
  {
    // TD-report field offsets: shifting rtmr3 one stride down silently returns rtmr2 — the
    // classic off-by-a-field that the real-quote pinned bytes exist to catch.
    id: "phala-quote-rtmr3-offset",
    file: "packages/core/src/phala-attest.ts",
    find: "rtmr0: 328, rtmr1: 376, rtmr2: 424, rtmr3: 472,",
    replace: "rtmr0: 328, rtmr1: 376, rtmr2: 424, rtmr3: 424,",
    tests: [T.phala],
  },
  {
    // compose-hash anchors to ITS event, not whichever imr3 event comes along.
    id: "phala-compose-event-name",
    file: "packages/core/src/phala-attest.ts",
    find: 'events.find((e) => e.event === "compose-hash")',
    replace: 'events.find((e) => e.event === "instance-id")',
    tests: [T.phala],
  },
  {
    // An imageless compose must FAIL the pin check — a vacuous pass would bless an empty deploy.
    id: "phala-pin-vacuous-pass",
    file: "packages/core/src/phala-attest.ts",
    find: "ok: images.length > 0 && unpinned.length === 0 && wrongDigest.length === 0",
    replace: "ok: unpinned.length === 0 && wrongDigest.length === 0",
    tests: [T.phala],
  },
  {
    // The pinned digest must EQUAL the released one — pinned-but-different is the supply-chain
    // swap this check exists to catch.
    id: "phala-pin-wrong-digest-blessed",
    file: "packages/core/src/phala-attest.ts",
    find: "const wrongDigest = images.filter((i) => /@sha256:[0-9a-f]{64}$/.test(i) && !i.toLowerCase().endsWith(`@${expectedDigest.toLowerCase()}`));",
    replace: "const wrongDigest: string[] = [];",
    tests: [T.phala],
  },

  // ── CLI flag layer: $ref resolution + schema-judged string fallback (2026-08-06) ──────────
  // Not signed bytes, but the layer that decides WHAT input reaches runTool — a silent defect
  // here turns a valid invocation into a rejected one (or vice versa) across every tool.
  {
    // Resolution disabled: $ref string fields (account) reclassify as JSON flags and
    // `--account 0x…` dies with invalid_json again.
    id: "cli-ref-resolution-disabled",
    file: "packages/cli/src/app.ts",
    find: "if (!node.$ref || depth >= 3) return node;",
    replace: "if (!node.$ref || depth >= 0) return node;",
    tests: [T.cli],
  },
  {
    // Merge order swapped: the $defs description clobbers the property's own — --help loses
    // the field-specific text ("the initiating account" becomes Address's generic line).
    id: "cli-ref-merge-order-swapped",
    file: "packages/cli/src/app.ts",
    find: "return resolveNode({ ...target, ...local }, defs, depth + 1);",
    replace: "return resolveNode({ ...local, ...target }, defs, depth + 1);",
    tests: [T.cli],
  },
  {
    // Fallback for everything: object-only fields (--filters) silently accept garbage strings
    // instead of failing loud with the parse error.
    id: "cli-admits-string-always",
    file: "packages/cli/src/app.ts",
    find: "return [...(n.anyOf ?? []), ...(n.oneOf ?? [])].some((b) => admitsString(b, defs, depth + 1));",
    replace: "return true;",
    tests: [T.cli],
  },
  {
    // Fallback for nothing: union fields (decode --data) reject raw hex with invalid_json.
    id: "cli-admits-string-never",
    file: "packages/cli/src/app.ts",
    find: 'if (t.includes("string")) return true;',
    replace: 'if (t.includes("string")) return false;',
    tests: [T.cli],
  },
  {
    // A known filter key silently unapplied: an orderHash query would return the WHOLE book —
    // the caller mistakes it for a per-order answer (the live bug this filter fixed, 2026-08-06).
    id: "query-orderbook-orderhash-unfiltered",
    file: "packages/core/src/handlers/query.ts",
    find: "return filters.orderHash ? { ...list, items: list.items.filter((r) => String((r as { orderHash?: unknown }).orderHash ?? \"\").toLowerCase() === filters.orderHash!.toLowerCase()) } : list;",
    replace: "return list;",
    tests: [T.venue],
  },
  // ── ForSelf adapter surface: calldata a caged wallet signs — struct field order, traits
  //    bits, the pull-cap bound, and the market-binding comparator (cast-fixture gated) ──────
  {
    // Two same-typed uint256 fields transposed in the VALUE mapping: the cap becomes the floor
    // and vice versa — silently signable, caught only by byte-exact cast parity.
    id: "forself-exercise-value-transposition",
    file: "packages/core/src/forself.ts",
    find: "args = [{ poolId: p.poolId, cstSharesIn: b(p.cstSharesIn), maxReferenceAssetsIn: b(p.maxReferenceAssetsIn), minCollateralAssetsOut: b(p.minCollateralAssetsOut), deadline }];",
    replace: "args = [{ poolId: p.poolId, cstSharesIn: b(p.cstSharesIn), maxReferenceAssetsIn: b(p.minCollateralAssetsOut), minCollateralAssetsOut: b(p.maxReferenceAssetsIn), deadline }];",
    tests: [T.forself],
  },
  {
    // The same defect one layer down: the ABI declaration's struct field order IS the wire
    // order (selector unchanged — the types don't move — so only byte parity can see it).
    id: "forself-abi-struct-order",
    file: "packages/core/src/forself.ts",
    find: "function exerciseForSelf((bytes32 poolId, uint256 cstSharesIn, uint256 maxReferenceAssetsIn, uint256 minCollateralAssetsOut, uint256 deadline) params)",
    replace: "function exerciseForSelf((bytes32 poolId, uint256 cstSharesIn, uint256 minCollateralAssetsOut, uint256 maxReferenceAssetsIn, uint256 deadline) params)",
    tests: [T.forself],
  },
  {
    // A drifted parameter TYPE changes the selector — the wrapper's dispatcher would fall
    // through to the fallback and the tx would revert; caught by forge-inspect selector parity.
    id: "forself-selector-type-drift",
    file: "packages/core/src/forself.ts",
    find: "function depositForSelf((bytes32 poolId, uint256 collateralAssetsIn, uint256 minCptAndCstSharesOut, uint256 deadline) params)",
    replace: "function depositForSelf((bytes32 poolId, uint128 collateralAssetsIn, uint256 minCptAndCstSharesOut, uint256 deadline) params)",
    tests: [T.forself],
  },
  {
    // Wrong amount-mode bit: the wrapper would read `amount` as a TAKING amount and pull the
    // wrong asset quantity from the caller.
    id: "forself-fill-amount-mode-bit",
    file: "packages/core/src/forself.ts",
    find: "const FORSELF_MAKER_AMOUNT_FLAG = 1n << 255n;",
    replace: "const FORSELF_MAKER_AMOUNT_FLAG = 1n << 254n;",
    tests: [T.forself],
  },
  {
    // The pull-cap width must match the wrapper's PRESERVE mask (bits 0-183): a wider local
    // bound admits caps the wrapper would silently truncate.
    id: "forself-fill-threshold-bound",
    file: "packages/core/src/forself.ts",
    find: "const FORSELF_THRESHOLD_MAX = (1n << 184n) - 1n;",
    replace: "const FORSELF_THRESHOLD_MAX = (1n << 190n) - 1n;",
    tests: [T.forself],
  },
  {
    // The market-binding mirror collapses to "any share involved": the pre-flight would bless
    // share-for-junk orders the wrapper reverts (and flag nothing on junk-for-cash).
    id: "forself-pair-comparator",
    file: "packages/core/src/handlers/forself.ts",
    find: "return (isShare(m) && isCash(t)) || (isCash(m) && isShare(t));",
    replace: "return isShare(m) || isShare(t);",
    tests: [T.forself],
  },
  {
    // exact-vs-cap flipped in the allowance matrix: the disclosure would tell an integrator
    // the adapter refunds a leg it consumes in full.
    id: "forself-allowance-kind-flip",
    file: "packages/core/src/forself.ts",
    find: '{ tokenRole: "cST", amountField: "cstSharesIn", kind: "exact" },',
    replace: '{ tokenRole: "cST", amountField: "cstSharesIn", kind: "cap" },',
    tests: [T.forself],
  },
  {
    // Attribution comparator collapsed to "everything is transport": a contract's definitive
    // refusal (a reverting isValidSignature / binding view) would be relayed or merely warned
    // instead of conflicting — the exact false-negative the classifier exists to prevent.
    // Re-aimed 2026-08-06: the classifier was unified into chain/rpc.ts `isTransportError`
    // (shared.ts re-exports it as isTransportFailure) — same mutant, new address.
    id: "shared-transport-classifier-always-true",
    file: "packages/core/src/chain/rpc.ts",
    find: '    if (name === "HttpRequestError" || name === "TimeoutError" || name === "WebSocketRequestError" || name === "SocketClosedError") return true;\n  }\n  return false;\n}',
    replace: '    if (name === "HttpRequestError" || name === "TimeoutError" || name === "WebSocketRequestError" || name === "SocketClosedError") return true;\n  }\n  return true;\n}',
    tests: [T.venue, T.forself, T.handlers],
  },

  // ── CLI variant grammar + amount sugar (2026-08-06): what reaches runTool, and exact values ──
  {
    // The discriminator must come from the subcommand's own name. Under this mutant a blob's
    // type field wins, so the executed action can differ from what the command line reads —
    // the killer test pins authority-revoke against a blob that says swap.
    id: "cli-variant-disc-blob-trusted",
    file: "packages/cli/src/app.ts",
    find: "obj[union.disc] = variant.value;",
    replace: "if (obj[union.disc] === undefined) obj[union.disc] = variant.value;",
    tests: [T.cli],
  },
  {
    // Exponent off-by-one multiplies every sugared amount by ten.
    id: "cli-amount-exp-off-by-one",
    file: "packages/cli/src/app.ts",
    find: 'return { ok: digits + "0".repeat(exp) };',
    replace: 'return { ok: digits + "0".repeat(exp + 1) };',
    tests: [T.cli],
  },
  {
    // Fraction guard dropped: 1.23e1 must be refused with teaching, never mangled or crashed.
    id: "cli-amount-fraction-allowed",
    file: "packages/cli/src/app.ts",
    find: "if (exp < 0) return",
    replace: "if (exp < -999) return",
    tests: [T.cli],
  },
  {
    // Parent-consumed options must merge into the sub's view: without it, a flag written after
    // the variant name that the parent also declares (--account) never reaches the input.
    id: "cli-variant-parent-opts-unmerged",
    file: "packages/cli/src/app.ts",
    find: "const opts = { ...parentOpts, ...(args[args.length - 2] as Record<string, unknown>) };",
    replace: "const opts = { ...(args[args.length - 2] as Record<string, unknown>) };",
    tests: [T.cli],
  },
  {
    // Alias resolution dropped from the capabilities topic matcher: topic "phoenix"/"orders"
    // (the internal spellings) would dead-end in unknown_topic after the canonical flip.
    id: "cli-capabilities-alias-dropped",
    file: "packages/core/src/handlers/capabilities.ts",
    find: ' || (x.cliAliases ?? []).some((a) => a.toLowerCase() === key)',
    replace: "",
    tests: [T.handlers],
  },
  {
    // English-order shuffle disabled: `track verify market-ref` / `prepare phoenix 1 exercise`
    // stop reaching the variant and die as excess positionals. (Re-aimed 2026-08-06 after the
    // shuffle grew into preParseVariants.)
    id: "cli-variant-shuffle-disabled",
    file: "packages/cli/src/app.ts",
    find: "return { argv: [...spec.path, exact, `--${spec.positional.flag}`, first, ...argvIn.slice(i + 2)] };",
    replace: "return { argv: argvIn };",
    tests: [T.cli],
  },
  {
    // Typo guard disabled: a mistyped variant falls through to commander, which blames an
    // unrelated option instead of naming the nearest action.
    id: "cli-variant-typo-guard-disabled",
    file: "packages/cli/src/app.ts",
    find: "if (first === undefined || first.startsWith(\"-\")) return { argv: argvIn };",
    replace: "if (first !== undefined) return { argv: argvIn };",
    tests: [T.cli],
  },
  {
    // Network-name map wrong: `--chainid arbitrum` quietly meaning mainnet would aim every
    // read (and every prepared artifact) at the wrong chain.
    id: "cli-chain-name-wrong",
    file: "packages/cli/src/app.ts",
    find: 'arbitrum: "42161"',
    replace: 'arbitrum: "1"',
    tests: [T.cli],
  },
  {
    // The union-field blob dropped on variant subcommands: fields supplied via --action would
    // vanish and the schema error would blame the user for omitting them.
    id: "cli-variant-flagbase-dropped",
    file: "packages/cli/src/app.ts",
    find: "const flagBase = opts[union.field];",
    replace: "const flagBase = undefined as unknown;",
    tests: [T.cli],
  },
  {
    // Singular resource alias dropped: `ch query rfq` would fail the resource enum instead of
    // reading the rfqs feed.
    id: "cli-resource-alias-dropped",
    file: "packages/cli/src/app.ts",
    find: 'const RESOURCE_ALIASES: Record<string, string> = {\n  rfq: "rfqs",',
    replace: 'const RESOURCE_ALIASES: Record<string, string> = {',
    tests: [T.cli],
  },
  {
    // The renamed-resource alias dropped: ch query market-predict would fail the resource enum
    // instead of routing to derive-cork-pool — old CLI scripts break silently at the surface.
    id: "cli-resource-rename-dropped",
    file: "packages/cli/src/app.ts",
    find: '  "derive-pool": "derive-cork-pool",\n',
    replace: "",
    tests: [T.cli],
  },
  {
    // The renamed-values teaching map emptied: an MCP caller sending an OLD wire value
    // ("market-predict", "deploy-wrapper") gets a bare enum error with no pointer — the exact
    // gap this map exists to close (levenshtein distance exceeds the typo cap for both renames).
    id: "teaching-rename-map-dropped",
    file: "packages/schemas/src/teaching.ts",
    find: '"resolve-recipe": "recipe-rate-constraint", // cork_compute kind (renamed 2026-08-09; outcome-named)',
    replace: "",
    tests: [T.teaching],
  },
  {
    // The taxonomy-rename teaching entry dropped: an old-surface caller sending resource
    // "market" gets a bare enum error instead of the renamed-to pointer at "cork-pool"
    // (levenshtein's 40% cap cannot bridge market → cork-pool).
    id: "teaching-taxonomy-rename-dropped",
    file: "packages/schemas/src/teaching.ts",
    find: '"market": "cork-pool", // cork_query resource (taxonomy rename 2026-08-09: a cork-pool is one expiry of a market)',
    replace: "",
    tests: [T.teaching],
  },
  {
    // The legal-set guard removed from renamed-value teaching: an unrelated enum receiving the
    // same string would be told it "was renamed" to a value that field does not accept.
    id: "teaching-rename-guard-dropped",
    file: "packages/schemas/src/teaching.ts",
    find: "if (renamed !== undefined && legal.includes(renamed)) {",
    replace: "if (renamed !== undefined) {",
    tests: [T.teaching],
  },
  {
    // Prose error rendering drops the per-issue suggestion line: the renamed-to teaching and
    // every did-you-mean become JSON-only — invisible to a person at a terminal.
    id: "cli-render-suggestion-dropped",
    file: "packages/cli/src/render.ts",
    find: 'if (i["suggestion"]) parts.push(wrap(`${GLYPH.suggest} ${i["suggestion"]}`, 4).map((line) => s.green(line)).join("\\n"));',
    replace: "",
    tests: [T.cli],
  },
  {
    // CLI stderr reverts to raw zod issues: the documented path/expected/received/suggestion
    // shape (what MCP puts in its error envelope) silently disappears from scripts.
    id: "cli-teaching-issues-swapped",
    file: "packages/cli/src/app.ts",
    find: "issues: e.teaching ? e.teaching.issues : e.issues,",
    replace: "issues: e.issues,",
    tests: [T.cli],
  },
  {
    // Top-level verb mapped to the wrong variant: `ch fill` would build cancel calldata instead
    // of a taker fill — same flags, catastrophically different bytes.
    id: "cli-verb-variant-swapped",
    file: "packages/cli/src/app.ts",
    find: 'cork_prepare_orders: (v) => (v === "taker-fill" ? "fill" : undefined),',
    replace: 'cork_prepare_orders: (v) => (v === "cancel" ? "fill" : undefined),',
    tests: [T.cli],
  },
  {
    // Authority ops leaking to the top level: `ch authority-onboard` would become a program verb,
    // flattening the deliberate namespacing of allowance-granting commands.
    id: "cli-verb-authority-leaked",
    file: "packages/cli/src/app.ts",
    find: 'cork_prepare_phoenix: (v) => (v.startsWith("authority-") ? undefined : v),',
    replace: "cork_prepare_phoenix: (v) => v,",
    tests: [T.cli],
  },
  {
    // Filter flags written to the input root instead of filters.*: every flag would become an
    // unknown top-level key and the read would run unfiltered or fail obscurely.
    id: "cli-filter-flags-unnested",
    file: "packages/cli/src/app.ts",
    find: "filters[k] = v;",
    replace: "input[k] = v;",
    tests: [T.cli],
  },
  {
    // Filter-flag amount sugar (rate/expiry): dropping the expansion re-opens the "--rate 1e18
    // refused by a message written in that very notation" wart, silently for e-notation callers.
    id: "cli-filter-sugar-dropped",
    file: "packages/cli/src/app.ts",
    find: 'if (SUGARED_FILTER_KEYS.has(k) && /[_eE]/.test(v)) {',
    replace: 'if (false && SUGARED_FILTER_KEYS.has(k) && /[_eE]/.test(v)) {',
    tests: [T.cli],
  },
  {
    // The prepare-group dead-zone teaching (`ch prepare exercise`): dropping the owner lookup
    // regresses to commander's bare "unknown command" with no route to the namespace.
    id: "cli-group-deadzone-teaching-dropped",
    file: "packages/cli/src/app.ts",
    find: "const owner = groupSpecs.find((s) => s.variants.has(canonicalise(sub)));",
    replace: "const owner = undefined as ReturnType<typeof unionSpecs.find>;",
    tests: [T.cli],
  },
  {
    // Blob-vs-flag precedence inverted for filters: a stale --filters blob key would silently win
    // over the explicitly typed flag.
    id: "cli-filter-flag-precedence-inverted",
    file: "packages/cli/src/app.ts",
    find: "if (touched) input[\"filters\"] = filters;",
    replace: "if (touched && input[\"filters\"] === undefined) input[\"filters\"] = filters;",
    tests: [T.cli],
  },
  // ── circuit breaker (breaker.ts — ONE state machine shared by RPC resolver + venue transport):
  //    the boundary comparators decide when a subsystem stops burning timeouts on a dead
  //    upstream, and both consumers inherit a drift here silently ────────────────────────────
  {
    // >= → >: the breaker opens one failure LATE (threshold+1) — every fail-fast window shifts.
    id: "breaker-threshold-boundary",
    file: "packages/core/src/breaker.ts",
    find: "return { failures, openedAt: failures >= policy.openThreshold ? now : (b?.openedAt ?? null) };",
    replace: "return { failures, openedAt: failures > policy.openThreshold ? now : (b?.openedAt ?? null) };",
    tests: [T.breaker, T.venueTransport],
  },
  {
    // < → <=: the half-open probe is refused AT the cooldown boundary — an endpoint that died
    // once stays unprobed one tick longer than documented (and the venue fail-fast overshoots).
    id: "breaker-cooldown-boundary",
    file: "packages/core/src/breaker.ts",
    find: "return b?.openedAt != null && now - b.openedAt < policy.cooldownMs;",
    replace: "return b?.openedAt != null && now - b.openedAt <= policy.cooldownMs;",
    tests: [T.breaker],
  },
  // ── same-call failover (chain/rpc.ts): the transport gate is the attribution split — without
  //    it a contract REVERT (a definitive on-chain answer) silently retries on another endpoint
  //    and feeds the breaker for an endpoint that answered correctly ─────────────────────────
  {
    id: "failover-transport-gate-dropped",
    file: "packages/core/src/chain/rpc.ts",
    find: "if (!isTransportError(err)) throw err;",
    replace: "",
    tests: [T.rpc],
  },
  {
    // Mid-call switch flag dropped: the failover still heals, but rpcWarn can no longer disclose
    // that reads in one result may mix two endpoints (possibly at different block heights) — a
    // silent-disclosure defect, the exact class the deferred-rpcWarn design exists to prevent.
    id: "failover-midcall-flag-dropped",
    file: "packages/core/src/chain/rpc.ts",
    find: "          resolved.failedOverInCall = true;",
    replace: "",
    tests: [T.rpc, T.mr],
  },
  // ── venue transport (datasources/venue.ts): fail-fast admission + consecutive-failure reset —
  //    each mutant turns the breaker into either a lock-out or a no-op ───────────────────────
  {
    // Success no longer resets: two spaced blips accumulate to the threshold and lock the venue
    // out for a cooldown even though it answered in between.
    id: "venue-breaker-success-reset-dropped",
    file: "packages/core/src/datasources/venue.ts",
    find: "    if (br) br.byHost[host] = breakerOnSuccess();",
    replace: "",
    tests: [T.venueTransport],
  },
  {
    // Fail-fast admission gate dropped: an open breaker no longer short-circuits — every call
    // burns the full transport timeout again, which is the exact waste the breaker exists for.
    id: "venue-failfast-gate-dropped",
    file: "packages/core/src/datasources/venue.ts",
    find: "if (br && breakerOpen(br.byHost[host], now(), VENUE_BREAKER_POLICY)) {",
    replace: "if (br && breakerOpen(br.byHost[host], now(), VENUE_BREAKER_POLICY) && false) {",
    tests: [T.venueTransport],
  },
  {
    // GET-retry gating dropped: the silent retry fires even when the failure just OPENED the
    // breaker — fail-fast loses to retry exactly when it matters.
    id: "venue-get-retry-gate-dropped",
    file: "packages/core/src/datasources/venue.ts",
    find: "if (br && breakerOpen(br.byHost[hostOf(venueBaseUrl(deps.baseUrl))], now(), VENUE_BREAKER_POLICY)) throw err;",
    replace: "",
    tests: [T.venueTransport],
  },

  // ── share-prediction generation consistency (controller binding outranks config) ──────────
  {
    // Override dropped: the prediction reads shares from the CONFIG default pool manager
    // while the controller creates on ITS OWN — the exact mixed-generation shape observed
    // live 2026-08-07 (v1.3.0-rc.1 default + v1.1-bound registry) that predicts nothing.
    id: "predict-shares-controller-binding-dropped",
    file: "packages/core/src/market-registry.ts",
    find: "    poolManager = getAddress(\n      await client.readContract({ address: args.controller, abi: controllerViewsAbi, functionName: \"CORK_POOL_MANAGER\" }),\n    );",
    replace: "    void (await client.readContract({ address: args.controller, abi: controllerViewsAbi, functionName: \"CORK_POOL_MANAGER\" }));",
    tests: [T.mr],
  },

  // ── ForSelf caller-gate generation (WHITELIST() binding + account pre-flight) ─────────────
  {
    // WHITELIST() binding comparator inverted: a correctly-bound adapter becomes a conflict
    // and a wrong-list adapter sails through — the caller would grant an allowance to an
    // adapter gating against the wrong whitelist.
    id: "forself-wl-binding-comparator",
    file: "packages/core/src/handlers/forself.ts",
    find: "if (whitelistManager !== undefined && boundWl.toLowerCase() !== whitelistManager.toLowerCase()) {",
    replace: "if (whitelistManager !== undefined && boundWl.toLowerCase() === whitelistManager.toLowerCase()) {",
    tests: [T.forself],
  },
  {
    // Generation gate flipped on the pool path: the account leg of the whitelist pre-flight
    // runs for PRE-gate adapters (false alarm — nothing on-chain checks the account there)
    // and is skipped for caller-gate adapters (the real revert goes unwarned).
    id: "forself-wl-callergate-account-gate",
    file: "packages/core/src/handlers/forself.ts",
    find: "...(bind.callerGate === true ? { account: input.account } : {}),",
    replace: "...(bind.callerGate !== true ? { account: input.account } : {}),",
    tests: [T.forself],
  },
  {
    // Fill-path account verdict inverted: the unlisted account's fill warning never fires —
    // the fill reverts CallerNotWhitelisted on-chain with zero advance notice.
    id: "forself-wl-fill-account-verdict",
    file: "packages/core/src/handlers/forself.ts",
    find: "if (accountOk === false) {",
    replace: "if (accountOk !== false) {",
    tests: [T.forself],
  },
  // ── R4: one synonym resolver across every CLI input path (2026-08-10) ─────────────────────
  {
    // preParse validates a canonicalised variant spelling but stops REWRITING it: commander
    // falls through to the parent command, and `--explain` exits 0 showing the WRONG contract —
    // the silent-wrong this rewrite exists to kill.
    id: "cli-preparse-canonical-rewrite-dropped",
    file: "packages/cli/src/app.ts",
    find: "return first === exact ? { argv: argvIn } : { argv: [...argvIn.slice(0, i), exact, ...argvIn.slice(i + 1)] };",
    replace: "return { argv: argvIn };",
    tests: [T.cli],
  },
  {
    // Positional↔flag parity dropped: `--resource` is an unknown option again, with a
    // did-you-mean pointing at an unrelated flag.
    id: "cli-positional-flag-parity-dropped",
    file: "packages/cli/src/app.ts",
    find: "if (positional && props[positional]) fieldOption(cmd, cmdRegistered, positional, props[positional]!);",
    replace: "void 0;",
    tests: [T.cli],
  },
  {
    // Resource aliases regress to case-sensitive while chain names stay case-insensitive — the
    // exact same-table-different-rule split R4 closed.
    id: "cli-resource-alias-case-sensitive-regression",
    file: "packages/cli/src/app.ts",
    find: 'if (name === "resource") rawStr = RESOURCE_ALIASES[rawStr.toLowerCase()] ?? rawStr.toLowerCase();',
    replace: 'if (name === "resource") rawStr = RESOURCE_ALIASES[rawStr] ?? rawStr;',
    tests: [T.cli],
  },
  {
    // Variant subcommands and top-level verbs stop taking the parent's positional: `ch exercise
    // 1` rejects the operand its long form accepts (the R4 class in miniature).
    id: "cli-variant-positional-dropped",
    file: "packages/cli/src/app.ts",
    find: "const positionalValue = positional ? (args[0] as string | undefined) : undefined;",
    replace: "const positionalValue = !variant && positional ? (args[0] as string | undefined) : undefined;",
    tests: [T.cli],
  },
  {
    // capabilities loses its search operand: `ch capabilities unwind` dies on excess args while
    // every sibling tool takes a bare operand.
    id: "cli-capabilities-search-positional-dropped",
    file: "packages/cli/src/app.ts",
    find: ' ?? (tool.name === "cork_capabilities" ? "search" : undefined);',
    replace: " ?? undefined;",
    tests: [T.cli],
  },
  {
    // Enum canonical tolerance dropped: `ch decode CALLDATA` stops resolving against the
    // field's own enum (only exact spellings pass).
    id: "cli-enum-canonical-tolerance-dropped",
    file: "packages/cli/src/app.ts",
    find: "const canonHit = node.enum.find((e) => canonicalise(String(e)) === canonicalise(rawStr));",
    replace: "const canonHit = undefined as string | undefined;",
    tests: [T.cli],
  },
  // ── RFQ negotiation surface: fraction contract, citation gates, band, view ──
  {
    // The fraction cap regressed to the pre-rework string-decided form: a 17-digit
    // "0.49999999999999999" is < 0.5 as a decimal but parses to exactly 0.5 — the venue's own
    // parseFloat refine 400s it, so accepting it here relays a doomed POST. This mutant IS the
    // 22df15a behavior; the boundary tests exist to keep it dead.
    id: "premium-fraction-string-decided-regression",
    file: "packages/core/src/handlers/submit.ts",
    find: 'if (Number.parseFloat(p) >= 0.5) return',
    replace: 'if (/^0\\.[5-9]/.test(p)) return',
    tests: [T.venue],
  },
  {
    // Fraction-cap comparator flipped exclusive: exactly "0.5" sails through to a venue 400.
    id: "premium-fraction-cap-comparator-flipped",
    file: "packages/core/src/handlers/submit.ts",
    find: 'if (Number.parseFloat(p) >= 0.5) return',
    replace: 'if (Number.parseFloat(p) > 0.5) return',
    tests: [T.venue],
  },
  {
    // Citation truncation gate flipped in the shared resolver: not-found refusals fire on
    // INCOMPLETE records (false refusals of legitimately-cited superseded answers) and
    // complete records relay unchecked — both quote_ref and optionRef paths break at once.
    id: "citation-truncated-gate-flipped",
    file: "packages/core/src/handlers/submit.ts",
    find: "return { answer, option, unresolved: answer === undefined && rfq.truncated === true };",
    replace: "return { answer, option, unresolved: answer === undefined && rfq.truncated !== true };",
    tests: [T.venue],
  },
  {
    // Truncation gate keyed on the OPTION instead of the answer: an answer that IS in the embed
    // but lacks the cited option relays on a truncated record — an embedded answer row carries
    // its whole payload, so that absence is proven and the venue 400s it.
    id: "citation-unresolved-keyed-on-option",
    file: "packages/core/src/handlers/submit.ts",
    find: "return { answer, option, unresolved: answer === undefined && rfq.truncated === true };",
    replace: "return { answer, option, unresolved: option === undefined && rfq.truncated === true };",
    tests: [T.venue],
  },
  {
    // Band comparator made inclusive: an exactly-10x re-price the venue's STRICT float gate
    // accepts (250 vs "0.25": 250/25 = 10.0 exactly) is refused — a relay out-rejecting its
    // venue, the false-block class the bit-for-bit mirror exists to eliminate.
    id: "premium-band-strict-flipped-high",
    file: "packages/core/src/handlers/submit.ts",
    find: "(ratio > 10 || ratio < 0.1)",
    replace: "(ratio >= 10 || ratio < 0.1)",
    tests: [T.venue],
  },
  {
    // Same at the low edge: exactly 0.1x (2.5 vs 25%) is venue-accepted, mutant refuses it.
    id: "premium-band-strict-flipped-low",
    file: "packages/core/src/handlers/submit.ts",
    find: "(ratio > 10 || ratio < 0.1)",
    replace: "(ratio > 10 || ratio <= 0.1)",
    tests: [T.venue],
  },
  {
    // Zero-premium guard dropped: a zero declared premium (display metadata; the venue's own
    // `premium > 0` guard skips the band) computes ratio 0 < 0.1 and gets falsely refused.
    id: "premium-band-zero-guard-dropped",
    file: "packages/core/src/handlers/submit.ts",
    find: "if (referencedPercent > 0 && premiumPct > 0 && (ratio > 10 || ratio < 0.1)) {",
    replace: "if (referencedPercent > 0 && (ratio > 10 || ratio < 0.1)) {",
    tests: [T.venue],
  },
  {
    // fraction→percent conversion broken (×100 → ×10): every consistent citation reads as a
    // 10x divergence — the exact class of scale bug this gate polices, planted inside it.
    id: "premium-band-fraction-scale-broken",
    file: "packages/core/src/handlers/submit.ts",
    find: "const referencedPercent = referenced * 100;",
    replace: "const referencedPercent = referenced * 10;",
    tests: [T.venue],
  },
  {
    // Attribution check inverted: third-party quote stamping relays (the venue 400s it — but
    // the pre-flight exists to refuse with teaching first) and every PARTY citation is refused.
    id: "quote-ref-party-inverted",
    file: "packages/core/src/handlers/submit.ts",
    find: "} else if (!makerIsParty && partiesKnown) {",
    replace: "} else if (makerIsParty && partiesKnown) {",
    tests: [T.venue],
  },
  {
    // The party rule regressed to the pre-0.4.1 requester-only form: a maker-mode SELL citing
    // its own quote (the underwriter of the cited answer, gh#60) is refused — the relay
    // out-rejects its venue on exactly the flow the fix re-enabled.
    id: "quote-ref-party-requester-only",
    file: "packages/core/src/handlers/submit.ts",
    find: "const parties = [requester, underwriter].filter(",
    replace: "const parties = [requester].filter(",
    tests: [T.venue],
  },
  {
    // Underwriter matched against ANY answer on the RFQ instead of the CITED one: citing a
    // rival's answer passes — the very third-party stamping the party rule refuses.
    id: "quote-ref-party-any-answer-underwriter",
    file: "packages/core/src/handlers/submit.ts",
    find: "const underwriter = cited.answer?.underwriter;",
    replace: "const underwriter = ((rfq.answers ?? []) as CitedAnswer[]).map((a) => a.underwriter).find((u) => typeof u === \"string\" && u.toLowerCase() === action.order.maker.toLowerCase()) ?? cited.answer?.underwriter;",
    tests: [T.venue],
  },
  {
    // Non-party PROVEN on a half-known embed: a requester that is not the maker refuses even
    // when the answer row carries no underwriter to compare — out-rejecting the venue, whose
    // full store may well name this maker as the underwriter.
    id: "quote-ref-party-half-proof-refuses",
    file: "packages/core/src/handlers/submit.ts",
    find: "const partiesKnown = typeof requester === \"string\" && typeof underwriter === \"string\";",
    replace: "const partiesKnown = typeof requester === \"string\" || typeof underwriter === \"string\";",
    tests: [T.venue],
  },
  {
    // Allowed-sender comparison ignores the mask: a filler whose LOW 80 BITS match but whose
    // high bits differ (the exact comparison MakerTraitsLib performs) is refused as a stranger,
    // and a reserved order reads as reserved-for-other on the book.
    id: "allowed-sender-mask-dropped-on-sender",
    file: "packages/core/src/orders.ts",
    find: "return allowed === 0n || allowed === (BigInt(sender) & ALLOWED_SENDER_MASK);",
    replace: "return allowed === 0n || allowed === BigInt(sender);",
    tests: [T.orders, T.venue, T.hybridVerify],
  },
  {
    // Open-order short-circuit dropped: an open order (slot 0) admits nobody — every fill of
    // every ordinary order is refused private_order.
    id: "allowed-sender-open-short-circuit-dropped",
    file: "packages/core/src/orders.ts",
    find: "return allowed === 0n || allowed === (BigInt(sender) & ALLOWED_SENDER_MASK);",
    replace: "return allowed === (BigInt(sender) & ALLOWED_SENDER_MASK);",
    tests: [T.orders, T.venue],
  },
  {
    // Mask width off by one (79 bits): the stored suffix loses its top bit, so the signed
    // order reserves a DIFFERENT filler than the one named and the book decodes a wrong suffix.
    id: "allowed-sender-mask-width",
    file: "packages/core/src/orders.ts",
    find: "export const ALLOWED_SENDER_MASK = (1n << 80n) - 1n;",
    replace: "export const ALLOWED_SENDER_MASK = (1n << 79n) - 1n;",
    tests: [T.orders],
  },
  {
    // allowedSender packed but not into the traits word: the slot stays 0, the order is open,
    // and the result echoes null — the maker asked for exclusivity and silently got none.
    id: "allowed-sender-not-packed",
    file: "packages/core/src/orders.ts",
    find: "  let t = allowedSender;\n  if (!p.allowPartialFills) t |= NO_PARTIAL_FILLS_FLAG;",
    replace: "  let t = 0n;\n  if (!p.allowPartialFills) t |= NO_PARTIAL_FILLS_FLAG;",
    tests: [T.orders, T.handlers],
  },
  {
    // Finalize echo severed from the signed bytes: a reserved order finalizes with a null
    // exclusivity echo, and the venue book then contradicts what the policy gate admitted.
    id: "finalize-allowed-sender-echo-dropped",
    file: "packages/core/src/handlers/prepare-orders.ts",
    find: "data: { ...artifact, approvals, allowedSender: finalizeTraits.allowedSender,",
    replace: "data: { ...artifact, approvals, allowedSender: null,",
    tests: [T.handlers],
  },
  {
    // Taker-fill exclusivity judged on the ACCOUNT on the ForSelf path: the LOP's msg.sender
    // there is the ADAPTER, so an order reserved for the adapter is refused and one reserved
    // for the account builds bytes that revert PrivateOrder().
    id: "takerfill-private-order-forself-sender",
    file: "packages/core/src/handlers/prepare-orders.ts",
    find: "const fillSender = action.forSelf ? action.forSelf.adapter : account;",
    replace: "const fillSender = account;",
    tests: [T.forself],
  },
  {
    // Exclusivity gate dropped: a reserved order builds fill bytes for a stranger — bytes that
    // can only revert PrivateOrder(), the class of artifact the pre-flight exists to refuse.
    id: "takerfill-private-order-gate-dropped",
    file: "packages/core/src/handlers/prepare-orders.ts",
    find: "if (allowedSender !== null && !isAllowedSender(signed.order.makerTraits, fillSender)) {",
    replace: "if (false) {",
    tests: [T.venue, T.forself],
  },
  {
    // Book exclusivity served from the venue's echo instead of the signed word [K3]: a
    // mis-decoding venue relabels reserved orders open (and vice versa) with nothing to catch it.
    id: "book-exclusivity-from-venue-echo",
    file: "packages/core/src/handlers/hybrid-verify.ts",
    find: "const annotated: Row = { ...row, allowedSender, exclusivity };",
    replace: "const annotated: Row = { ...row, allowedSender: typeof row.allowedSender === \"string\" ? row.allowedSender : row.allowedSender === null ? null : allowedSender, exclusivity };",
    tests: [T.hybridVerify],
  },
  {
    // reserved-for-account / reserved-for-other swapped: the caller skips the order reserved
    // for it and prepares the one it cannot fill.
    id: "book-exclusivity-account-classes-swapped",
    file: "packages/core/src/handlers/hybrid-verify.ts",
    find: "isAllowedSender(traits, account) ? \"reserved-for-account\" : \"reserved-for-other\";",
    replace: "isAllowedSender(traits, account) ? \"reserved-for-other\" : \"reserved-for-account\";",
    tests: [T.hybridVerify],
  },
  {
    // Hash-lie drop demoted to the chain leg: a row misrepresenting its own order is served
    // (labeled unverified) whenever no RPC resolves — the self-contradiction needed no chain.
    id: "book-hash-lie-served-offline",
    file: "packages/core/src/handlers/hybrid-verify.ts",
    find: "      hashLies += 1;\n      continue;",
    replace: "      hashLies += 1;\n      served.push(row);\n      continue;",
    tests: [T.hybridVerify],
  },
  {
    // A mirrored gate vanishes from the register: the next venue version bump's teaching no
    // longer names it, and its drift goes back to being caught by humans on Slack.
    id: "venue-mirror-register-entry-dropped",
    file: "packages/core/src/datasources/venue.ts",
    find: 'gate: "quote_ref citation: answer existence, PARTY rule',
    replace: 'gate: "citation: answer existence, PARTY rule',
    tests: ["packages/core/test/mirrored-venue-logic.test.ts"],
  },
  {
    // Applicability gate severed: a known key on the wrong resource is silently unapplied
    // again — the caller reads an unfiltered answer as a filtered one.
    id: "query-filter-scope-gate-dropped",
    file: "packages/core/src/handlers/query.ts",
    find: "  assertFiltersApplicable(input.resource, input.filters);",
    replace: "",
    tests: [T.filterScope],
  },
  {
    // One resource row widened to everything: protocol-config accepts (and ignores) any filter.
    id: "query-filter-scope-row-widened",
    file: "packages/core/src/handlers/filters.ts",
    find: '"protocol-config": [],',
    replace: '"protocol-config": KNOWN_FILTER_KEYS,',
    tests: [T.filterScope],
  },
  {
    // One resource row over-tightened: the orderbook's exclusivity classifier loses its fill
    // sender — valid input refused, the over-refusal direction the acceptance test pins.
    id: "query-filter-scope-row-tightened",
    file: "packages/core/src/handlers/filters.ts",
    find: '"orderbook": ["poolId", "side", "status", "orderHash", "account"],',
    replace: '"orderbook": ["poolId", "side", "status", "orderHash"],',
    tests: [T.filterScope, T.hybridVerify],
  },
  {
    // exclude_request_prefix silently dropped from the rfqs URL: the venue serves the whole
    // feed (its default), nothing errors, the heartbeats the caller asked to skip come back.
    id: "rfqs-exclude-prefix-dropped-from-url",
    file: "packages/core/src/datasources/venue.ts",
    find: "exclude_request_prefix: p.excludeRequestPrefix, cursor: p.cursor",
    replace: "cursor: p.cursor",
    tests: [T.venue],
  },
  {
    // option_ref wire keys swapped: the venue would 400 every counter that cites an option
    // (answer ids in the option slot and vice versa) — classic snake_case mapping transposition.
    id: "rfq-counter-optionref-keys-swapped",
    file: "packages/core/src/handlers/submit.ts",
    find: "option_ref: { answer_id: action.optionRef.answerId, option_id: action.optionRef.optionId }",
    replace: "option_ref: { answer_id: action.optionRef.optionId, option_id: action.optionRef.answerId }",
    tests: [T.venue],
  },
  {
    // filters.view silently dropped from the list URL: 'current' reads serve the full history
    // and the frontier view is unreachable — the venue defaults to view=full server-side, so
    // nothing errors, the answer is just wrong.
    id: "rfqs-view-param-dropped",
    file: "packages/core/src/datasources/venue.ts",
    find: "with_answers: p.withAnswers, view: p.view,",
    replace: "with_answers: p.withAnswers,",
    tests: [T.venue],
  },
  // ── units/scale labels: the C1 collision class — a swapped label is a silent 100x lie ──────
  {
    // The cork-pool fee label claims WAD: identical shape, 100x apart, on the most-read
    // resource — the exact defect the scales block exists to prevent (footgun audit R1).
    id: "units-scales-fee-label-swapped",
    file: "packages/core/src/handlers/query.ts",
    find: 'swapFeePercentage: "1e18 = 1% (PERCENTAGE — not WAD; 100x apart)"',
    replace: 'swapFeePercentage: "1e18 = 1.0 (WAD)"',
    tests: [T.handlers],
  },
  {
    // The units TOPIC states the wrong marker on the fee row while still naming the fields —
    // the "lying topic" hole: parity must check the marker ON THE ROW, not name-presence alone.
    id: "units-topic-fee-marker-swapped",
    file: "packages/schemas/src/doc-topics.ts",
    find: "D18{%}\\` | 1e18 = 1% |",
    replace: "D18{%}\\` | 1e18 = 1.0 |",
    tests: [T.docTopics],
  },
  {
    // The suspect tripwire silently stops routing to the units table — teaching regression the
    // constant-level check could never see (asserted on the real emission path).
    id: "units-tripwire-reference-dropped",
    file: "packages/core/src/handlers/submit.ts",
    find: "quote_ref is present. Full scale table: ${UNITS_TOPIC_REFERENCE}",
    replace: "quote_ref is present",
    tests: [T.venue],
  },
  {
    // /docs/<alias> resolution degrades to name-only: every alias 404s while the name still
    // serves — the "served everywhere the moment it exists" contract silently narrows.
    id: "units-docs-route-alias-dropped",
    file: "packages/mcp/src/http.ts",
    find: "const doc = findDocTopic(slug);",
    replace: "const doc = Object.values(DOC_TOPICS).find((t) => t.name === slug);",
    tests: [T.http],
  },
  {
    // impairment-floor drops the pair's decimals again — the documented cross-kind contract
    // ("all three chain-backed kinds carry them") regresses to the pre-fix silent exception.
    id: "compute-impairment-decimals-dropped",
    file: "packages/core/src/handlers/compute.ts",
    find: "data: { kind: p.kind, ...floor, ...decimals, scales }",
    replace: "data: { kind: p.kind, ...floor, scales }",
    tests: [T.handlers],
  },
  {
    // account-state decimals silently hardcode 18: a 6-dec reference balance reads 10^12 too
    // small and nothing errors — the exact defect class R1.2 exists to prevent. The stub answers
    // 6, so the killer assertion distinguishes read-from-token from assumed.
    id: "units-accountstate-decimals-hardcoded",
    file: "packages/core/src/handlers/query.ts",
    find: "const decimals = { collateral: Number(collateralDecimals), reference: Number(referenceDecimals), corkSwapToken: 18, corkPrincipalToken: 18 };",
    replace: "const decimals = { collateral: 18, reference: 18, corkSwapToken: 18, corkPrincipalToken: 18 };",
    tests: [T.handlers],
  },
  {
    // The decoded JIT label places the carried fee in the WAD family — a signer reading the
    // decode before signing sees a 100x lie about the fee the fill would set.
    id: "units-decode-jit-fee-label-swapped",
    file: "packages/core/src/handlers/decode.ts",
    find: 'swapFeePercentage: "1e18 = 1% (PERCENTAGE — not WAD; max 5e18 = 5%)"',
    replace: 'swapFeePercentage: "1e18 = 1.0 (WAD)"',
    tests: [T.decodeJit],
  },
  {
    // track marketRef labels the market bounds as the percent family — the verifier surface
    // (consulted precisely when something already disagrees) misstates the scale 100x.
    id: "units-track-market-label-swapped",
    file: "packages/core/src/handlers/track.ts",
    find: 'market: "rateMin/rateMax/rateChangePerDayMax/rateChangeCapacityMax: ABSOLUTE rates, 1e18 = 1.0 (WAD)"',
    replace: 'market: "rateMin/rateMax/rateChangePerDayMax/rateChangeCapacityMax: 1e18 = 1%"',
    tests: [T.handlers],
  },
  {
    // The auction surplus label migrates to the neighboring 1e5 fee base — uint8/uint16/uint32
    // Fusion fields are shape-indistinguishable, so the label IS the only discriminator.
    id: "units-auction-surplus-label-swapped",
    file: "packages/core/src/handlers/compute.ts",
    find: 'protocolSurplusFeePercent: "1e2 base (under fillability.surplus)"',
    replace: 'protocolSurplusFeePercent: "1e5 base (under fillability.surplus)"',
    tests: [T.fusion],
  },
  // ── Layer split: pattern = contract, bound = policy (owner ruling 2026-08-10) ───────
  {
    // The cap teaches itself as permanent structure — callers over-fit to a pilot bound that a
    // short-tenor distressed market legitimately breaks; when the venue relaxes it, every
    // integration taught "structure" here needs re-teaching.
    id: "premium-fraction-cap-taught-as-structure",
    file: "packages/core/src/handlers/submit.ts",
    find: "POLICY, not structure: pilot posture, spec-invisible, relaxable",
    replace: "STRUCTURE, permanent: pinned by R13, never relaxable",
    tests: [T.venue],
  },
  {
    // The wire shape teaches itself as relaxable policy — the inverse over-fit: callers wait
    // for a "relaxation" of a shape R13 pins forever (a WAD variant is a NEW field, not a
    // loosened regex).
    id: "premium-fraction-shape-taught-as-policy",
    file: "packages/core/src/handlers/submit.ts",
    find: "STRUCTURE: the RFC-pinned wire shape",
    replace: "POLICY: the current wire shape",
    tests: [T.venue],
  },
  // ── x-units: the machine-readable unit axis — parity binds wire ↔ table ↔ prose ──
  {
    // TokenAmount stops emitting its unit: every amount field silently loses the machine-
    // readable axis while descriptions still read fine — exactly the drift x-units exists to
    // make diffable.
    id: "units-xunits-def-dropped",
    file: "packages/schemas/src/primitives.ts",
    find: '.meta({ id: "TokenAmount", "x-units": X_UNITS.qTok });',
    replace: '.meta({ id: "TokenAmount" });',
    tests: [T.docTopics],
  },
  {
    // One use site's fee unit drifts to the WAD family while the other stays — the cross-site
    // consistency assertion (every emission must equal the expected value) is what sees it.
    id: "units-xunits-value-drifted",
    file: "packages/schemas/src/tools.ts",
    find: 'const JitSwapFeeWire = UintStr.default("0").describe("PERCENTAGE, 1e18 = 1% (max 5e18 = 5%) — consumed only if this fill creates the pool").meta({ "x-units": X_UNITS.pct18 });',
    replace: 'const JitSwapFeeWire = UintStr.default("0").describe("PERCENTAGE, 1e18 = 1% (max 5e18 = 5%) — consumed only if this fill creates the pool").meta({ "x-units": X_UNITS.wad });',
    tests: [T.docTopics],
  },
  {
    // The constraint bounds regress to bare UintStr — per-field scale AND x-units vanish from
    // BOTH jitMarket paths at once (shared shape), the exact R2 defect this schema closes.
    id: "units-constraint-field-scale-dropped",
    file: "packages/schemas/src/tools.ts",
    find: 'rateMin: UintStr.describe("ABSOLUTE rate floor, 1e18 = 1.0 (NOT the 1e18=1% fee family)").meta({ "x-units": X_UNITS.wad }),',
    replace: "rateMin: UintStr,",
    tests: [T.docTopics],
  },
  // ── Permit2 expiration gate (audit R9): the funding pre-flight predicts the AUTHORITY ──────
  {
    // The zero carve-out returns: an (amount>0, expiration 0) allowance reads as fundable when
    // Permit2 reverts AllowanceExpired on it — the funded-looking bundle is built to revert.
    id: "permit2-expiry-zero-carveout-reintroduced",
    file: "packages/core/src/handlers/query.ts",
    find: "expired: nowSecs > BigInt(Number(p2[1]))",
    replace: "expired: Number(p2[1]) !== 0 && nowSecs > BigInt(Number(p2[1]))",
    tests: [T.handlers],
  },
  {
    // Boundary flipped to >=: expired reported one second EARLY — a still-fundable bundle
    // refused at exactly expiration, the inverse of Permit2's own `block.timestamp > expiration`.
    id: "permit2-expiry-boundary-comparator",
    file: "packages/core/src/handlers/query.ts",
    find: "expired: nowSecs > BigInt(Number(p2[1]))",
    replace: "expired: nowSecs >= BigInt(Number(p2[1]))",
    tests: [T.handlers],
  },
  // ── CLI numeric dialect + error contract (audit R5/R6/R7) ───────────────────────────────────
  {
    // Regression to the two-dialect world: integer flags accept 1e3 via Number() but not 1_000.
    id: "cli-integer-sugar-gate-narrowed",
    file: "packages/cli/src/app.ts",
    find: 'if ((isAmountNode(node) || nodeT === "integer") && /[_eE]/.test(rawStr)) {',
    replace: "if (isAmountNode(node) && /[_eE]/.test(rawStr)) {",
    tests: [T.cli],
  },
  {
    // Regression: the safe-range check on integer sugar never fires, so 1e18 lands in a JSON
    // number with precision loss past 2^53 instead of the invalid_amount teaching.
    id: "cli-integer-sugar-bounds-unreachable",
    file: "packages/cli/src/app.ts",
    find: 'if (nodeT === "integer" && BigInt(ex.ok) > BigInt(Number.MAX_SAFE_INTEGER)) {',
    replace: 'if (nodeT === "integer" && BigInt(ex.ok) > BigInt(Number.MAX_SAFE_INTEGER) * BigInt(Number.MAX_SAFE_INTEGER)) {',
    tests: [T.cli],
  },
  {
    // Regression to plain-text stderr for commander parse errors under JSON intent.
    id: "cli-commander-json-contract-regressed",
    file: "packages/cli/src/app.ts",
    find: "err += argvWantsJson ? `${JSON.stringify(payload)}\\n` : cmdErr || `${ce.message ?? \"argument parse error\"}\\n`;",
    replace: "err += cmdErr || `${ce.message ?? \"argument parse error\"}\\n`;",
    tests: [T.cli],
  },
  {
    // Regression: the swallowed-positional detection always answers no, so `ch query --json
    // pools` returns a bare parse error with no reorder teaching.
    id: "cli-json-swallow-hint-regressed",
    file: "packages/cli/src/app.ts",
    find: "const swallowed = typeof jsonOpt === \"string\" && /^[A-Za-z][\\w-]*$/.test(rawJson);",
    replace: "const swallowed = typeof jsonOpt === \"number\" && /^[A-Za-z][\\w-]*$/.test(rawJson);",
    tests: [T.cli],
  },
  // ── surface-tier boundary (owner-approved 2026-08-11): the mechanical prose/semantic gate ──
  {
    // The sentence guard inverts: a description that GAINED a sentence classifies as a
    // rewording, so new semantic content ships on the cheap tier without an eval.
    id: "surface-tier-sentence-guard-inverted",
    file: "packages/mcp/src/surface-tier.ts",
    find: 'kind: sentenceCount(before as string) === sentenceCount(after as string) ? "description-reworded" : "description-resized"',
    replace: 'kind: sentenceCount(before as string) !== sentenceCount(after as string) ? "description-reworded" : "description-resized"',
    tests: [T.surfaceTier],
  },
  {
    // Non-description strings classify as prose: an x-units flip (the 100x lie) or an enum
    // member rename would skip the eval — units are covered surface, never prose.
    id: "surface-tier-contract-strings-as-prose",
    file: "packages/mcp/src/surface-tier.ts",
    find: '    } else {\n      out.push({ path, kind: "value-changed" });\n    }',
    replace: '    } else {\n      out.push({ path, kind: "description-reworded" });\n    }',
    tests: [T.surfaceTier],
  },
  {
    // Added keys go unreported: a brand-new field rides a prose-tier regeneration.
    id: "surface-tier-added-key-unreported",
    file: "packages/mcp/src/surface-tier.ts",
    find: 'for (const k of Object.keys(a)) if (!(k in b)) out.push({ path: `${path}/${k}`, kind: "key-added" });',
    replace: "for (const k of Object.keys(a)) if (!(k in b)) void k;",
    tests: [T.surfaceTier],
  },
  // ── cork-api 0.3.3 module routing + the premium_annualized migration ──────────────────────
  {
    // Base normalization regresses to matching a version segment no config carries: a user
    // override still ending /v1 then composes /v1/<module>/v1/… — a path no API form serves.
    id: "venue-base-version-strip-inert",
    file: "packages/core/src/datasources/venue.ts",
    find: 'return raw.replace(/\\/+$/u, "").replace(/\\/v\\d+$/u, "").replace(/\\/+$/u, "");',
    replace: 'return raw.replace(/\\/+$/u, "").replace(/\\/v99\\d+$/u, "").replace(/\\/+$/u, "");',
    tests: [T.venueTransport],
  },
  {
    // Canonical literal regresses to the retired base-versioned form: the call rides the
    // temporary rewrite (or 404s once it retires) instead of the canonical module path.
    id: "venue-orderbook-path-legacy-form",
    file: "packages/core/src/datasources/venue.ts",
    find: "`/limit-orders/v1/orderbook${qs(",
    replace: "`/v1/limit-orders/orderbook${qs(",
    tests: [T.venueTransport],
  },
  {
    // The shim fingerprint stops matching: deprecated-path telemetry never surfaces and the
    // shim's retirement becomes a silent outage instead of an announced migration.
    id: "venue-deprecation-header-ignored",
    file: "packages/core/src/datasources/venue.ts",
    find: 'if ((res.headers.get("deprecation") ?? "").toLowerCase() !== "true") return undefined;',
    replace: 'if ((res.headers.get("deprecation") ?? "").toLowerCase() !== "yes") return undefined;',
    tests: [T.venueTransport],
  },
  {
    // Per-page dedup key regresses to per-occurrence uniqueness: every page re-emits the same
    // venue notice and a 10-page traversal warns 10 times.
    id: "venue-notice-dedup-key-unique-per-page",
    file: "packages/core/src/handlers/query.ts",
    find: "const key = JSON.stringify(w);",
    replace: "const key = JSON.stringify({ ...w, occurrence: notice.venueWarnings.length });",
    tests: [T.venueTransport],
  },
  {
    // The book fraction pattern tightens to two integer digits: "100" — a value the venue's
    // published pattern and refine both accept — gets refused, out-rejecting the venue.
    id: "book-premium-pattern-tightened",
    file: "packages/core/src/handlers/submit.ts",
    find: "if (typeof p !== \"string\" || !/^\\d{1,3}(\\.\\d{1,18})?$/.test(p)) return 'is not a decimal-fraction string",
    replace: "if (typeof p !== \"string\" || !/^\\d{1,2}(\\.\\d{1,18})?$/.test(p)) return 'is not a decimal-fraction string",
    tests: [T.venuePremium],
  },
  {
    // The book bound comparator regresses to exclusive: exactly 100 (venue-legal, <= 100
    // refine) gets refused — a relay must never out-reject its venue.
    id: "book-premium-bound-exclusive",
    file: "packages/core/src/handlers/submit.ts",
    find: 'if (Number.parseFloat(p) > 100) return "parses above 100',
    replace: 'if (Number.parseFloat(p) >= 100) return "parses above 100',
    tests: [T.venuePremium],
  },
  {
    // The removed-field gate softens to "only when the fraction is absent": a payload carrying
    // BOTH fields relays and dies as the venue's opaque 400 instead of local teaching.
    id: "premium-removed-gate-softened",
    file: "packages/core/src/handlers/submit.ts",
    find: "if (premium !== undefined) {\n    const suggestion",
    replace: "if (premium !== undefined && premiumAnnualized === undefined) {\n    const suggestion",
    tests: [T.venuePremium],
  },
  {
    // The required-fraction gate regresses to unreachable: a premium-less listing relays and
    // fails only as an opaque venue 400 instead of local teaching.
    id: "premium-required-gate-unreachable",
    file: "packages/core/src/handlers/submit.ts",
    find: "if (premiumAnnualized === undefined) {\n    return { ok: false, problem: \"missing\"",
    replace: "if (premiumAnnualized === undefined && premium !== undefined) {\n    return { ok: false, problem: \"missing\"",
    tests: [T.venuePremium],
  },
  {
    // The venue's parseFloat×100 canonicalization drifts by 10x: every downstream comparison
    // (suspect tripwires, the quote_ref band) compares the WRONG canonical percent.
    id: "premium-canonicalization-scale",
    file: "packages/core/src/handlers/submit.ts",
    find: "return { ok: true, premiumPct: Number.parseFloat(premiumAnnualized) * 100 };",
    replace: "return { ok: true, premiumPct: Number.parseFloat(premiumAnnualized) * 10 };",
    tests: [T.venuePremium],
  },
  // ── taker-fill signedOrder: the venue-free fill path's verification gates ─────────────────
  {
    // The inline re-hash gate disappears: bytes build for an order that does not hash to the
    // orderHash the caller claimed — the [K3] property the path exists to enforce.
    id: "inline-fill-hash-gate-removed",
    file: "packages/core/src/handlers/prepare-orders.ts",
    find: "      if (localOrderHash.toLowerCase() !== wanted) {",
    replace: "      if (false) {",
    tests: [T.inlineFill],
  },
  {
    // The salt↔extension binding gate disappears: bytes build that can only revert
    // InvalidExtension at fill.
    id: "inline-fill-binding-gate-removed",
    file: "packages/core/src/handlers/prepare-orders.ts",
    find: 'if (so.extension !== "0x" && !saltExtensionBinding(order.salt, so.extension).bound) {',
    replace: "if (false) {",
    tests: [T.inlineFill],
  },
  {
    // Attribution regresses: a caller-supplied zero-making order gets blamed on the venue.
    id: "inline-fill-zero-attribution-swapped",
    file: "packages/core/src/handlers/prepare-orders.ts",
    find: 'return unavailable(chainId, "invalid_order_terms", "the supplied signed order has makingAmount 0 — nothing is fillable", ctx);',
    replace: 'return unavailable(chainId, "invalid_service_response", "the supplied signed order has makingAmount 0 — nothing is fillable", ctx);',
    tests: [T.inlineFill],
  },
  {
    // The signature ladder is skipped: fill bytes build for an order whose signature the fill
    // can only revert on — the check that makes inline bytes trustworthy without the venue.
    id: "inline-fill-signature-ladder-skipped",
    file: "packages/core/src/handlers/prepare-orders.ts",
    find: "const verdict = await verifyMakerSignatureLadder({ ctx, chainId, maker: order.maker, orderHash: localOrderHash, signature: so.signature });",
    replace: 'const verdict = { kind: "eoa", recoveredSigner: order.maker, codeUnknown: false } as MakerSignatureVerdict;',
    tests: [T.inlineFill],
  },
  {
    // The ERC-1271 magic-value comparison loosens to "any string answer": a contract maker
    // whose isValidSignature rejects still gets fill bytes.
    id: "ladder-magic-comparison-loosened",
    file: "packages/core/src/handlers/prepare-orders.ts",
    find: 'if (typeof magic !== "string" || magic.slice(0, 10).toLowerCase() !== ERC1271_MAGIC) {',
    replace: 'if (typeof magic !== "string") {',
    tests: [T.inlineFill],
  },
  {
    // Code detection is lost: every contract maker falls into the ecrecover branch, where an
    // opaque contract-scheme signature can never verify — valid ERC-1271 orders become
    // unfillable through this tool.
    id: "ladder-code-detection-lost",
    file: "packages/core/src/handlers/prepare-orders.ts",
    find: 'probe = code !== undefined && code !== "0x" ? "has-code" : "no-code";',
    replace: 'probe = "no-code";',
    tests: [T.inlineFill],
  },
  {
    // The acquisition warnings stop riding the artifact: the inline path's code-unknown
    // disclosure (and the venue path's in-band notices) silently vanish.
    id: "inline-fill-acquisition-warnings-dropped",
    file: "packages/core/src/handlers/prepare-orders.ts",
    find: ", ...a.acquisitionWarnings],",
    replace: "],",
    tests: [T.inlineFill],
  },
  {
    // The wire translation regresses to passthrough: ERC1271 posts verbatim, which the venue's
    // EOA|CONTRACT enum schema-rejects — the defect this translation fixed.
    id: "maker-kind-wire-translation-passthrough",
    file: "packages/core/src/handlers/submit.ts",
    find: 'makerAccountType: action.makerAccountType === "ERC1271" ? "CONTRACT" : "EOA",',
    replace: "makerAccountType: action.makerAccountType,",
    tests: [T.venuePremium],
  },
  {
    // The read-side mapping loses the venue's own vocabulary: every contract-maker book row
    // fails row validation again.
    id: "maker-kind-read-mapping-lost",
    file: "packages/core/src/datasources/venue.ts",
    find: 'kind === "ERC1271" || kind === "EIP1271" || kind === "CONTRACT"',
    replace: 'kind === "ERC1271" || kind === "EIP1271"',
    tests: [T.venuePremium],
  },
  {
    // The /readyz normalization trace regresses to matching nothing: the base-rewrite becomes
    // fully unobservable and a mis-normalized proxy setup is undebuggable.
    id: "venue-diagnostics-suffix-trace-inert",
    file: "packages/core/src/datasources/venue.ts",
    find: "const suffix = /\\/v\\d+$/u.exec(configured)?.[0];",
    replace: "const suffix = /\\/v99\\d+$/u.exec(configured)?.[0];",
    tests: [T.venueTransport],
  },
  // ── approved-implementations guard (interface-first model) ────────────────────────────────
  {
    // The EIP-1967 slot constant drifts by one nibble: the guard reads the wrong storage word
    // and every proxy role resolves garbage.
    id: "impl-1967-slot-drift",
    file: "packages/core/src/implementations.ts",
    find: '"0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc"',
    replace: '"0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbd"',
    tests: [T.implementations],
  },
  {
    // The approval comparator inverts: off-list code reads as approved and the guard waves
    // through exactly what it exists to flag.
    id: "impl-approval-comparator-inverted",
    file: "packages/core/src/implementations.ts",
    find: "const approved = entry.approved.some((h) => h.toLowerCase() === codehash.toLowerCase());",
    replace: "const approved = entry.approved.some((h) => h.toLowerCase() !== codehash.toLowerCase());",
    tests: [T.implementations],
  },
  {
    // Proxy resolution regresses to never matching: the guard fingerprints the proxy SHELL,
    // whose code never changes on an upgrade — the exact blindness this module removes.
    id: "impl-proxy-resolution-lost",
    file: "packages/core/src/implementations.ts",
    find: 'if (entry.proxy === "eip1967") {',
    replace: 'if (entry.proxy === ("eip1967x" as string)) {',
    tests: [T.implementations],
  },
  {
    // The implementation address regresses to the padded word's FIRST 20 bytes (zeros): every
    // healthy proxy reads as unresolved.
    id: "impl-address-slice-misaligned",
    file: "packages/core/src/implementations.ts",
    find: "const impl = word ? (`0x${word.slice(-40)}` as `0x${string}`) : undefined;",
    replace: "const impl = word ? (`0x${word.slice(2, 42)}` as `0x${string}`) : undefined;",
    tests: [T.implementations],
  },
  {
    // The warning renderer's verdict gate regresses to a verdict that never warns: positive
    // findings go silent.
    id: "impl-warning-gate-silenced",
    file: "packages/core/src/implementations.ts",
    find: 'if (c.verdict === "not_approved") {',
    replace: 'if (c.verdict === ("not_approved_x" as string)) {',
    tests: [T.implementations],
  },
  // ── order-lifecycle approvals (2026-08-17): who grants what to whom, payload-exact ──────────
  {
    // The plain maker grant authorizes the WRONG spender: the payload approves Permit2 while
    // the fill pulls via the LOP — the order rests fillable-looking and every fill reverts.
    id: "sdk-approval-maker-spender-swapped",
    file: "packages/core/src/order-approvals.ts",
    find: "unsignedTx: erc20ApproveTx(a.makerAsset, a.lop, a.makingAmount),",
    replace: "unsignedTx: erc20ApproveTx(a.makerAsset, PERMIT2_ADDRESS, a.makingAmount),",
    tests: [T.approvals],
  },
  {
    // Permit2.approve(token, spender, …) with token/spender transposed: the tx grants the
    // makerAsset ADDRESS as a spender over the LOP-as-token — silently useless bytes.
    id: "sdk-approval-permit2-arg-order",
    file: "packages/core/src/order-approvals.ts",
    find: "args: [token, spender, amount, Number(expiration)]",
    replace: "args: [spender, token, amount, Number(expiration)]",
    tests: [T.approvals],
  },
  {
    // An exactly-sufficient allowance must read satisfied (>= at the boundary): the strict
    // comparator would nag every exact-approve holder with a false approval_missing.
    id: "sdk-approval-satisfied-boundary",
    file: "packages/core/src/order-approvals.ts",
    find: "{ satisfied: current >= BigInt(e.amount) }",
    replace: "{ satisfied: current > BigInt(e.amount) }",
    tests: [T.approvals],
  },
  {
    // Permit2 spending is allowed AT the expiration second (account-state's exact rule): the
    // strict comparator flags a live allowance as expired at the boundary.
    id: "sdk-approval-expiration-boundary",
    file: "packages/core/src/order-approvals.ts",
    find: "const live = args.nowSeconds <= BigInt(expiration);",
    replace: "const live = args.nowSeconds < BigInt(expiration);",
    tests: [T.approvals],
  },
  {
    // approval_missing must fire strictly on CONFIRMED-missing (satisfied === false): the
    // relaxed comparator also matches unannotated entries (undefined), so every offline
    // build would nag about grants nobody checked.
    id: "sdk-approval-missing-filter",
    file: "packages/core/src/order-approvals.ts",
    find: "const missing = entries.filter((e) => e.satisfied === false);",
    replace: "const missing = entries.filter((e) => e.satisfied !== true);",
    tests: [T.approvals],
  },
  {
    // The taker's cap must be the fill's TAKING amount — sourcing it from the making amount
    // tells the hedger to approve the wrong token quantity entirely.
    id: "sdk-approval-taker-cap-source",
    file: "packages/core/src/handlers/prepare-orders.ts",
    find: "requiredTakingAmount: BigInt(fill.requiredTakingAmount),",
    replace: "requiredTakingAmount: BigInt(fill.requiredMakingAmount),",
    tests: [T.approvals],
  },
  // ── eval grading contract (2026-08-17): the verdict semantics, pinned offline ───────────────
  {
    // expect.code regresses to first-warning-only: a task whose expected code lands second on a
    // multi-warning envelope grades as a miss — a phantom regression in every score report.
    id: "eval-grade-code-first-only",
    file: "evals/run.ts",
    find: "(e.code ? (c.codes?.includes(e.code) ?? false) : true)",
    replace: "(e.code ? c.codes?.[0] === e.code : true)",
    tests: [T.evalGrading],
  },
  {
    // The call budget's boundary flips exclusive: a task using exactly its budget reads as
    // over-budget, deflating the efficiency axis across the whole suite.
    id: "eval-grade-budget-boundary",
    file: "evals/run.ts",
    find: "const efficient = trace.length <= e.maxCalls;",
    replace: "const efficient = trace.length < e.maxCalls;",
    tests: [T.evalGrading],
  },
  {
    // The clarify honesty-probe loses its zero-calls gate: matching clarify TEXT would launder
    // a wrong-tool trace into a full pass — asking nicely after calling the wrong tool wins.
    id: "eval-grade-clarify-gate-dropped",
    file: "evals/run.ts",
    find: "if (e.clarify && trace.length === 0 && e.clarify.test(finalText)) {",
    replace: "if (e.clarify && e.clarify.test(finalText)) {",
    tests: [T.evalGrading],
  },
  {
    // The sonnet gate loosens to any Claude model: a haiku/opus run silently grades the MODEL,
    // not the tool surface, and poisons every baseline comparison (owner ruling 2026-07-28).
    id: "eval-model-gate-loosened",
    file: "evals/run.ts",
    find: 'return /^claude-sonnet-/.test(model)',
    replace: 'return /^claude-/.test(model)',
    tests: [T.evalGrading],
  },
  // ── the SDK package surface (2026-08-17): subpath exports + the api-surface drift gate ──────
  {
    // A tier barrel silently loses a module: every export it carried vanishes from the
    // published subpath AND the root. The api-surface fixture must see the hole.
    id: "sdk-barrel-module-dropped",
    file: "packages/core/src/exports/indexer.ts",
    find: 'export * from "../datasources/hypersync.ts";',
    replace: "",
    tests: [T.apiSurface],
  },
  {
    // package.json loses a subpath entry: installed consumers hit ERR_PACKAGE_PATH_NOT_EXPORTED
    // while every in-repo resolver (tsconfig paths, vitest alias) keeps working — only the
    // offline exports-map parity test can catch it before publish.
    id: "sdk-exports-map-subpath-dropped",
    file: "packages/core/package.json",
    find: `    "./indexer": {
      "types": "./dist/packages/core/src/exports/indexer.d.ts",
      "import": "./dist/packages/core/src/exports/indexer.js",
      "default": "./dist/packages/core/src/exports/indexer.js"
    },
`,
    replace: "",
    tests: [T.apiSurface],
  },
  {
    // The embedded HyperSync binding is chosen by the BUILD, not by napi-rs's runtime libc
    // heuristics — swapping the gnu/musl mapping ships a binding that cannot dlopen on the target.
    id: "hypersync-binding-gnu-musl-swapped",
    file: "scripts/compile-binaries.mjs",
    find: "  else if (os === \"linux\") slug = musl ? (arch === \"x64\" ? \"linux-x64-musl\" : null) : `linux-${arch}-gnu`;",
    replace: "  else if (os === \"linux\") slug = musl ? `linux-${arch}-gnu` : (arch === \"x64\" ? \"linux-x64-musl\" : null);",
    tests: [T.release],
  },
  {
    // macOS assets must embed too — dropping the darwin mapping silently regresses them to the
    // bare-image failure (a source-style import with no node_modules inside the binary).
    id: "hypersync-binding-darwin-dropped",
    file: "scripts/compile-binaries.mjs",
    find: "  if (os === \"darwin\") slug = `darwin-${arch}`;",
    replace: "  if (os === \"darwin\") slug = null;",
    tests: [T.release],
  },
  {
    // Without the define the one require in hypersync.ts stays dynamic and nothing is embedded:
    // every compiled binary regresses to the bare-image failure while building green.
    id: "hypersync-binding-define-dropped",
    file: "scripts/compile-binaries.mjs",
    find: "    \"--define\", `process.env.CH_HYPERSYNC_BINDING=${binding ? JSON.stringify(binding) : \"undefined\"}`,",
    replace: "",
    tests: [T.release],
  },
  {
    // A compiled target without a binding must say so; inverting the guard silences the gap
    // (and reports one where a binding IS embedded).
    id: "hypersync-binding-gap-silenced",
    file: "packages/core/src/datasources/hypersync.ts",
    find: "  if (!target || embedded) return null;",
    replace: "  if (!target || !embedded) return null;",
    tests: [T.hypersync],
  },
  // ── LOP invalidator READ: the view takes the nonce and shifts itself ───────────
  {
    // The 2026-08-20 bug reinstated: pass the pre-shifted slot index to bitInvalidatorForOrder.
    // The contract shifts again, reads an empty word, and every dead order looks live.
    id: "invalidator-read-preshifted-slot",
    file: "packages/core/src/orders.ts",
    find: 'functionName: "bitInvalidatorForOrder", args: [maker, plan.nonceOrEpoch] }',
    replace: 'functionName: "bitInvalidatorForOrder", args: [maker, plan.slot] }',
    tests: [T.invalidator, T.inlineFill, T.hybridVerify],
  },
  {
    // Classification through the shared helper: a bit-mode plan classified as remaining-mode
    // turns a spent bit into "partially filled", never "dead".
    id: "invalidator-classify-mode-swapped",
    file: "packages/core/src/orders.ts",
    find: 'return plan.mode === "bit" ? classifyBitInvalidator(word, plan.mask) : classifyRemainingRaw(word);',
    replace: 'return plan.mode === "remaining" ? classifyBitInvalidator(word, 1n) : classifyRemainingRaw(word);',
    tests: [T.invalidator, T.inlineFill, T.hybridVerify],
  },
  // ── Maker-code probe: "no code" is an answer, not a failed read ─────────────────
  {
    // Treat viem's `undefined` (no code) as a failed read again — every EOA maker would carry
    // the spurious chain_read_failed.
    id: "maker-code-undefined-is-failure",
    file: "packages/core/src/handlers/prepare-orders.ts",
    find: 'probe = code !== undefined && code !== "0x" ? "has-code" : "no-code";',
    replace: 'probe = code === undefined ? "read-failed" : code !== "0x" ? "has-code" : "no-code";',
    tests: [T.makerCode],
  },
  // ── TakerTraitsLib._AMOUNT_MASK is 184 bits, not 185 ────────────────────────────────────
  {
    id: "taker-threshold-185-bits",
    file: "packages/core/src/orders.ts",
    find: "const TAKER_THRESHOLD_MAX = (1n << 184n) - 1n;",
    replace: "const TAKER_THRESHOLD_MAX = (1n << 185n) - 1n;",
    tests: [T.orders],
  },
  // ── 1inch fill/cancel decode: the inverse must be bit-exact ────────────────────
  {
    // Receiver flag read from the wrong bit: args would be split without the 20-byte receiver
    // prefix and the extension would be mis-sliced.
    id: "taker-traits-receiver-flag-bit",
    file: "packages/core/src/orders.ts",
    find: "argsHasReceiver: (t & TAKER_ARGS_HAS_RECEIVER_FLAG) !== 0n,",
    replace: "argsHasReceiver: (t & TAKER_USE_PERMIT2_FLAG) !== 0n,",
    tests: [T.decodeLop],
  },
  {
    // Extension and interaction lengths swapped: the JIT payload would be sliced at the wrong
    // offset and its label lost.
    id: "taker-args-lengths-swapped",
    file: "packages/core/src/orders.ts",
    find: "extensionLength: Number((t >> TAKER_ARGS_EXTENSION_LENGTH_OFFSET) & TAKER_ARGS_LENGTH_MASK),",
    replace: "extensionLength: Number((t >> TAKER_ARGS_INTERACTION_LENGTH_OFFSET) & TAKER_ARGS_LENGTH_MASK),",
    tests: [T.decodeLop],
  },
  {
    // Amount semantics inverted: the summary would call a maker-denominated fill taker-denominated.
    id: "taker-traits-amount-flag-inverted",
    file: "packages/core/src/orders.ts",
    find: "amountIsMakerAsset: (t & TAKER_MAKER_AMOUNT_FLAG) !== 0n,",
    replace: "amountIsMakerAsset: (t & TAKER_MAKER_AMOUNT_FLAG) === 0n,",
    tests: [T.decodeLop],
  },
  {
    // The fill-arg positions differ between EOA and contract fills; picking the EOA layout for
    // both reads the contract fill's takerTraits as its amount.
    id: "lop-decode-contract-arg-positions",
    file: "packages/core/src/orders.ts",
    find: "const amount = (contract ? args[2] : args[3]) as bigint;",
    replace: "const amount = args[3] as bigint;",
    tests: [T.decodeLop],
  },
  {
    // The label pass skipped inside nested bundles: a fill wrapped in a multicall would lose
    // its orderHash and JIT label.
    id: "lop-label-skips-nested-bundles",
    file: "packages/core/src/handlers/decode.ts",
    find: 'if (leg.kind === "bundle") return { ...leg, legs: labelLopLegs(leg.legs, chainId, jitTrust) };',
    replace: 'if (leg.kind === "bundle") return leg;',
    tests: [T.decodeLop],
  },
  {
    // The public-main equality check inverts: the ONE candidate that is publishable is refused
    // and every unpublished commit is tagged (and its history pushed with the tag).
    id: "releasetag-public-main-gate-inverted",
    file: "scripts/release-tag.sh",
    find: 'if [ "$sha" != "$public_main" ]; then',
    replace: 'if [ "$sha" = "$public_main" ]; then',
    tests: [T.releaseTag],
  },
  {
    // Remote identity stops being compared: a tag (and the objects it reaches) can be pushed to
    // any remote named cork-cli, including a private or attacker-controlled one.
    id: "releasetag-remote-identity-unchecked",
    file: "scripts/release-tag.sh",
    find: 'if [ "$push_repo" != "$canonical_repo" ]; then',
    replace: 'if [ "$push_repo" = "" ]; then',
    tests: [T.releaseTag],
  },
  {
    // The explicit endpoint goes back to best-effort: an endpoint that cannot prove its chain is
    // exposed anyway, and every read through it wears the requested chain's label.
    id: "rpc-explicit-verification-best-effort",
    file: "packages/core/src/chain/rpc.ts",
    find: 'if (!probe.ok) throw new RpcChainVerificationError(explicitUrl, chainId, "probe_failed");',
    replace: 'if (!probe.ok) return { url: explicitUrl, client: mkClient(explicitUrl, chainId), source: "explicit" };',
    tests: [T.rpc],
  },
  {
    // A refusal is cached: one blip permanently poisons the endpoint for the process.
    id: "rpc-explicit-failure-cached",
    file: "packages/core/src/chain/rpc.ts",
    find: "      if (reported !== chainId) throw new RpcChainMismatchError(explicitUrl, chainId, reported);",
    replace: "      if (reported !== chainId) { explicitVerified.set(key, { url: explicitUrl, client: mkClient(explicitUrl, chainId), source: \"explicit\" }); throw new RpcChainMismatchError(explicitUrl, chainId, reported); }",
    tests: [T.rpc],
  },
  {
    // The venue's echoed hash is promoted back to primary: a contradicting value becomes the
    // key a caller would cancel or track with.
    id: "submit-venue-hash-authoritative",
    file: "packages/core/src/handlers/submit.ts",
    find: "      if (out.state === \"ok\" && !agreed) {",
    replace: "      if (out.state === \"ok\" && !agreed && venueOrderHash === undefined) {",
    tests: [T.venue],
  },
  {
    // The taking-side getter is classified only AFTER the equality invariant: an order whose
    // taking getter alone is foreign degrades to "not a Fusion order" and the taker path falls
    // through to a plain signed-ratio cap, trusting the getter it could not recognize.
    id: "fusion-taking-getter-classified-late",
    file: "packages/core/src/fusion.ts",
    find: "  if (size(fields.takingAmountData) >= 20) {\n    const takingGetter = sliceHex(fields.takingAmountData, 0, 20);",
    replace: "  if (size(fields.takingAmountData) >= 20 && false) {\n    const takingGetter = sliceHex(fields.takingAmountData, 0, 20);",
    tests: [T.fusionTrust],
  },
  {
    // The automatic cap is derived for an unrecognized getter again: a number invented for a
    // charge nobody could read.
    id: "fusion-unknown-getter-auto-cap",
    file: "packages/core/src/handlers/prepare-orders.ts",
    find: "        if (action.maximumTakingAmount === undefined) {",
    replace: "        if (false) {",
    tests: [T.fusionTrust],
  },
  {
    // The hybrid gate stops filtering: an unknown venue-chosen settler is queried again, and its
    // answer can confirm the row it came with.
    id: "hybrid-settler-gate-dropped",
    file: "packages/core/src/handlers/hybrid-verify.ts",
    find: 'if (digest === undefined || settler === undefined || generation === undefined || generation === "unknown") return undefined;',
    replace: "if (digest === undefined || settler === undefined) return undefined;",
    tests: [T.hybridVerify],
  },
  {
    // STATE-007: the role check is dropped — any configured contract may emit any protocol
    // event, so an ExactSettler's `JITMinted` (or the wrong generation's market-created
    // layout) reads as lifecycle evidence.
    id: "event-attribution-role-check-dropped",
    file: "packages/core/src/event-attribution.ts",
    find: "    if (emitter === undefined || !spec.roles.includes(emitter.role)) {",
    replace: "    if (emitter === undefined) {",
    tests: [T.eventAttribution],
  },
  {
    // STATE-007: the emitter is no longer matched by address — the first configured emitter
    // vouches for every log, which is the topic-only labeling the finding removed.
    id: "event-attribution-emitter-match-dropped",
    file: "packages/core/src/event-attribution.ts",
    find: "    const emitter = emitters.find((e) => e.address.toLowerCase() === log.address.toLowerCase());",
    replace: "    const emitter = emitters[0];",
    tests: [T.eventAttribution],
  },
  {
    // STATE-007: a recognized-but-unauthenticated event is silently dropped from the receipt
    // instead of reported — the reader loses exactly the log that names an impostor.
    id: "track-receipt-unattributed-dropped",
    file: "packages/core/src/handlers/track.ts",
    find: "          ...(a.unattributedEvents.length ? { unattributedEvents: a.unattributedEvents } : {}),",
    replace: "",
    tests: [T.eventAttribution],
  },
  {
    // STATE-007: the history leg attributes against EVERY configured emitter instead of the one
    // settler the digest binds to — a logs endpoint can then decorate one order's history with
    // another settler's events.
    id: "track-history-scope-dropped",
    file: "packages/core/src/handlers/track.ts",
    find: "              const emitters = (await protocolEmittersFor(chainId)).filter((e) => e.address.toLowerCase() === settlerAddr.toLowerCase());",
    replace: "              const emitters = await protocolEmittersFor(chainId);",
    tests: [T.eventAttribution],
  },
  {
    // The track gate stops filtering: an attacker-chosen settler is read and its answer becomes
    // chain provenance for the venue row that named it.
    id: "track-settler-gate-dropped",
    file: "packages/core/src/handlers/track.ts",
    find: "          const settlerReadable = settlerAddr !== undefined && configuredSettler !== undefined;",
    replace: "          const settlerReadable = settlerAddr !== undefined;",
    tests: [T.rolloverVerify],
  },
  {
    // The origin check on each hop is dropped: a redirect can carry a caller-signed relay body
    // to any host that answers.
    id: "redirect-origin-check-dropped",
    file: "packages/core/src/fetch-timeout.ts",
    find: "  if (expectedOrigin !== undefined && parsed.origin !== expectedOrigin) {",
    replace: "  if (expectedOrigin !== undefined && parsed.origin === expectedOrigin && false) {",
    tests: [T.venueRedirect],
  },
  {
    // A write follows 301/302/303 again: the POST is rewritten to a bodyless GET, so the signed
    // payload either vanishes or is replayed as a read somewhere it was never addressed to.
    id: "redirect-write-status-gate-dropped",
    file: "packages/core/src/fetch-timeout.ts",
    find: 'if (policy === "preserve-write" && res.status !== 307 && res.status !== 308) {',
    replace: 'if (policy === "preserve-write" && res.status !== 307 && res.status !== 308 && false) {',
    tests: [T.venueRedirect],
  },
  {
    // The hop bound goes away: a redirect loop spins until the request deadline.
    id: "redirect-hop-bound-dropped",
    file: "packages/core/src/fetch-timeout.ts",
    find: "      if (hops >= MAX_REDIRECTS) throw new Error(",
    replace: "      if (hops >= MAX_REDIRECTS * 1000) throw new Error(",
    tests: [T.venueRedirect],
  },
  {
    // Prerelease identifiers compare as TEXT again: rc.9 outranks rc.10, so self-update offers
    // an older prerelease as an update and refuses the newer one as a downgrade.
    id: "version-prerelease-numeric-order-lost",
    file: "packages/core/src/version.ts",
    find: "      const d = BigInt(x) - BigInt(y);",
    replace: "      const d = x < y ? -1n : x > y ? 1n : 0n;",
    tests: [T.release],
  },
  {
    // The staged artifact's identity is no longer compared: a genuine-but-different release
    // asset passes provenance and is swapped in.
    id: "selfupdate-identity-field-check-dropped",
    file: "packages/cli/src/self-update.ts",
    find: "    if (identity[field] !== expected[field]) {",
    replace: "    if (identity[field] !== expected[field] && false) {",
    tests: [T.selfUpdateIdentity],
  },
  {
    // The identity run regains the ambient search path: untrusted staged bytes can reach every
    // helper installed on the machine before they are accepted.
    id: "selfupdate-identity-path-restored",
    file: "packages/cli/src/self-update.ts",
    find: '  const env: NodeJS.ProcessEnv = { PATH: "", CI: "1"',
    replace: '  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? "", CI: "1"',
    tests: [T.selfUpdateIdentity],
  },
  {
    // Only the direct child is killed on a timeout: a descendant the staged binary spawned is
    // orphaned and keeps running after the update was refused.
    id: "selfupdate-identity-kills-only-direct-child",
    file: "packages/cli/src/self-update.ts",
    find: '    process.kill(-pid, "SIGKILL");',
    replace: '    process.kill(pid, "SIGKILL");',
    tests: [T.selfUpdateIdentity],
  },
  {
    // An annotated tag stops being peeled: the attestation is bound to a tag object rather than
    // to the commit the release claims.
    id: "selfupdate-tag-peel-dropped",
    file: "packages/cli/src/self-update.ts",
    find: '  for (let peels = 0; object.type === "tag"; peels++) {',
    replace: "  for (let peels = 0; false; peels++) {",
    tests: [T.selfUpdateIdentity],
  },
  {
    // The per-principal bound stops applying: one caller can occupy every slot the server has,
    // starving a room full of legitimate clients.
    id: "admission-principal-bound-dropped",
    file: "packages/mcp/src/admission.ts",
    find: "(fairnessApplies && forPrincipal >= MCP_HTTP_LIMITS.principalRequests)) return null;",
    replace: "(fairnessApplies && false)) return null;",
    tests: [T.httpAdmission],
  },
  {
    // Slots leak: a request that throws never gives its slot back, so the server bleeds capacity
    // until it refuses everything.
    id: "admission-slot-leak-on-throw",
    file: "packages/mcp/src/admission.ts",
    find: "    } finally {\n      permit.release();\n    }",
    replace: "    } finally {\n      if (false) permit.release();\n    }",
    tests: [T.httpAdmission],
  },
  {
    // The decoded body bound goes away: only a self-declared content-length is checked, so a
    // caller that lies about it can send anything.
    id: "admission-actual-body-bound-dropped",
    file: "packages/mcp/src/admission.ts",
    find: "      if (bytes.byteLength > MCP_HTTP_LIMITS.bodyBytes) return refusal(413,",
    replace: "      if (false && bytes.byteLength > MCP_HTTP_LIMITS.bodyBytes) return refusal(413,",
    tests: [T.httpAdmission],
  },
  {
    // A caller-supplied X-Forwarded-For is trusted with no ingress in front: anyone mints a
    // fresh principal per request and the per-principal bound becomes decorative.
    id: "admission-forwarded-for-always-trusted",
    file: "packages/mcp/src/admission.ts",
    find: "  if (opts.trustForwardedFor) {",
    replace: "  if (true) {",
    tests: [T.httpAdmission],
  },
  {
    // The FIRST forwarded hop is used — the attacker-authored one — instead of the last, which
    // is the only entry the proxy itself wrote.
    id: "admission-forwarded-for-first-hop",
    file: "packages/mcp/src/admission.ts",
    find: "      const nearest = hops[hops.length - 1];",
    replace: "      const nearest = hops[0];",
    tests: [T.httpAdmission],
  },
  {
    // The fairness bound applies to the shared bucket too: a deployment whose ingress does not
    // forward client addresses caps the whole server at one client's budget.
    id: "admission-shared-bucket-capped",
    file: "packages/mcp/src/admission.ts",
    find: "    const fairnessApplies = principal !== SHARED_PRINCIPAL;",
    replace: "    const fairnessApplies = true;",
    tests: [T.httpAdmission],
  },
  // ── 2026-08-26 audit remediation: decode target trust, allowlist source, atomic funding ───
  {
    // The single-target comparator flips: a leg at the configured contract reads as a mismatch
    // and a look-alike reads as trusted — the audit's own finding, re-opened.
    id: "decode-target-comparator-inverted",
    file: "packages/core/src/bundle/decode.ts",
    find: 'if (to.toLowerCase() === expected.toLowerCase()) return { verification: "trusted" };',
    replace: 'if (to.toLowerCase() !== expected.toLowerCase()) return { verification: "trusted" };',
    tests: [T.decodeTrust, T.decodeLop],
  },
  {
    // Token membership inverted: a foreign token reads as trusted, the pool's own as unverified.
    id: "decode-token-membership-inverted",
    file: "packages/core/src/bundle/decode.ts",
    find: 'return { verification: known ? "trusted" : "unverified" };',
    replace: 'return { verification: known ? "unverified" : "trusted" };',
    tests: [T.decodeTrust, T.handlers],
  },
  {
    // A mismatch stops escalating the signed-tx decode to a conflict: the label says
    // MISMATCH but the envelope says ok.
    id: "decodetx-mismatch-not-conflict",
    file: "packages/core/src/handlers/decode.ts",
    find: 'return envelope({ state: targetMismatch ? "conflict" : "ok", data: base, chainId, source: "config", warnings, ctx });',
    replace: 'return envelope({ state: "ok", data: base, chainId, source: "config", warnings, ctx });',
    tests: [T.decodeTrust],
  },
  {
    // The JIT hook's adapter comparator flips: a maker-chosen adapter reads as Cork's.
    id: "decode-jit-adapter-comparator-inverted",
    file: "packages/core/src/handlers/decode.ts",
    find: 'if (adapter.toLowerCase() === expected.toLowerCase()) return { verification: "trusted" };',
    replace: 'if (adapter.toLowerCase() !== expected.toLowerCase()) return { verification: "trusted" };',
    tests: [T.decodeTrust],
  },
  {
    // The allowlist is read from the RESOLVED config again: a remote document that moves an
    // address can admit the code behind it — the exact self-authorization MCP-NET-001 names.
    id: "impl-allowlist-from-resolved-config",
    file: "packages/core/src/implementations.ts",
    find: "checkApprovedImplementations(client, chainId, { allowlist: BUNDLED_DEFAULTS, addresses: cfg.defaults, ...opts })",
    replace: "checkApprovedImplementations(client, chainId, { allowlist: cfg.defaults, addresses: cfg.defaults, ...opts })",
    tests: [T.implTrust],
  },
  {
    // Role scoping ignored: every configured role is fingerprinted by every artifact path.
    id: "impl-role-scope-ignored",
    file: "packages/core/src/implementations.ts",
    find: "if (roles !== undefined && !roles.includes(role)) return [];",
    replace: "if (roles !== undefined && roles.length < 0) return [];",
    tests: [T.implTrust],
  },
  {
    // The uint256.max sentinel stops refusing: the plan degrades to "no legs", and the handler
    // emits an action-only bundle that only works against a balance parked on the adapter.
    id: "funding-sentinel-refusal-dropped",
    file: "packages/core/src/bundle/funding.ts",
    find: "if (hasSentinel) return { legs: [], ...NONE, refusal:",
    replace: "if (hasSentinel) return { legs: [], ...NONE, note:",
    tests: [T.funding],
  },
  {
    // The handler stops honoring the plan's refusal: the bundle ships without its sweep.
    id: "phoenix-refusal-ignored",
    file: "packages/core/src/handlers/phoenix.ts",
    find: "if (plan.refusal) {",
    replace: "if (plan.refusal && plan.legs.length < 0) {",
    tests: [T.handlers],
  },
  {
    // PID 1 gets no default signal action: registering the handler for the wrong signal leaves
    // SIGTERM ignored again and every container stop back at the SIGKILL timeout.
    id: "mcp-sigterm-handler-dropped",
    file: "packages/cli/src/bin.ts",
    find: '    for (const sig of ["SIGTERM", "SIGINT"] as const) {',
    replace: '    for (const sig of ["SIGUSR2"] as const) {',
    tests: [T.mcpSignals],
  },
  // ── CorkMarketCreator create-pool (2026-08-28): direct pool creation ahead of a fill ───────
  {
    // MarketParams constraint tuple order flipped: the calldata encodes rateMax where the
    // contract reads rateMin — a pool created with inverted limits. Killed by the cast golden
    // vector (distinct 0.9e18/1.1e18 values) and the independently-authored components decode.
    id: "creator-params-constraint-order",
    file: "packages/core/src/market-registry.ts",
    find: "struct CreatorRateConstraint { uint256 rateMin; uint256 rateMax; uint256 rateChangePerDayMax; uint256 rateChangeCapacityMax; }",
    replace: "struct CreatorRateConstraint { uint256 rateMax; uint256 rateMin; uint256 rateChangePerDayMax; uint256 rateChangeCapacityMax; }",
    tests: [T.marketCreator],
  },
  {
    // Fee fields swapped in the struct declaration: the swap fee lands in the unwind slot.
    // Invisible to the golden vector (0/0 fees) — killed by the distinct-fees word-layout test.
    id: "creator-params-fee-order",
    file: "packages/core/src/market-registry.ts",
    find: "bytes additionalData; uint256 swapFeePercentage; uint256 unwindSwapFeePercentage; }",
    replace: "bytes additionalData; uint256 unwindSwapFeePercentage; uint256 swapFeePercentage; }",
    tests: [T.marketCreator],
  },
  {
    // The shared coherence comparator inverts for FIXED recipes: a zero rateOverride passes and
    // the tx reverts in the FixedRateOracle constructor instead of refusing with teaching.
    id: "creator-coherence-fixed-inverted",
    file: "packages/core/src/market-registry.ts",
    find: 'if (source === "fixed") return rateOverride === 0n ? "needs-rate" : "ok";',
    replace: 'if (source === "fixed") return rateOverride !== 0n ? "needs-rate" : "ok";',
    tests: [T.marketCreator],
  },
  {
    // The creator's binding check stops comparing the registry: a cross-generation creator
    // (or a config typo) builds bytes against contracts the pre-flights never proved.
    id: "creator-binding-comparator-dropped",
    file: "packages/core/src/handlers/prepare-market.ts",
    find: "if (boundRegistry.toLowerCase() !== mr.registry.toLowerCase() || (dep?.poolManager !== undefined && boundPm.toLowerCase() !== dep.poolManager.toLowerCase())) {",
    replace: "if (false) {",
    tests: [T.marketCreator],
  },
  {
    // Existence inverted: an existing pool loses its idempotent-no-op disclosure and gains the
    // creation-only would_revert checks it must not run (the bound applies only at creation).
    id: "creator-pool-exists-inverted",
    file: "packages/core/src/handlers/prepare-market.ts",
    find: "    if (shares.exists) {\n      warnings.push({ code: \"pool_already_exists\",",
    replace: "    if (!shares.exists) {\n      warnings.push({ code: \"pool_already_exists\",",
    tests: [T.marketCreator],
  },
  {
    // The value gate's verdict is dropped: past expiries and over-cap fees build anyway.
    id: "creator-value-gate-dropped",
    file: "packages/core/src/handlers/prepare-market.ts",
    find: 'const valueGate = jitValueGate(chainId, ctx, swapFee, unwindFee, expiryTimestamp, nowSecs, { site: CREATOR_VALUE_SITE, capWei: await resolveFeeCap(chainId, "creator") });\n  if (valueGate) return valueGate;',
    replace: 'const valueGate = jitValueGate(chainId, ctx, swapFee, unwindFee, expiryTimestamp, nowSecs, { site: CREATOR_VALUE_SITE, capWei: await resolveFeeCap(chainId, "creator") });\n  void valueGate;',
    tests: [T.marketCreator],
  },
  {
    // The guard scope loses the creator role: the one contract this tx executes goes
    // unfingerprinted while the registry still is — scoping working backwards.
    id: "creator-impl-role-scope-dropped",
    file: "packages/core/src/implementations.ts",
    find: 'export const CREATE_POOL_IMPLEMENTATION_ROLES = ["marketCreator", "marketRegistry"] as const satisfies readonly ImplementationRole[];',
    replace: 'export const CREATE_POOL_IMPLEMENTATION_ROLES = ["marketRegistry"] as const satisfies readonly ImplementationRole[];',
    tests: [T.marketCreator, T.implTrust],
  },
  {
    // Decode role swap: a createNewPool leg verifies against the REGISTRY address, so the real
    // creator reads mismatch and a registry-addressed fake reads trusted.
    id: "decode-market-creator-role-swapped",
    file: "packages/core/src/bundle/decode.ts",
    find: 'const role = CREATOR_FUNCTIONS.has(functionName) ? "marketCreator" : "marketRegistry";',
    replace: 'const role = CREATOR_FUNCTIONS.has(functionName) ? "marketRegistry" : "marketCreator";',
    tests: [T.marketCreator],
  },
  {
    // The creation bound turns exclusive: an expiry exactly AT now + maxExpiryDuration — which
    // the contract accepts (INCLUSIVE, "the longest permitted market must stay creatable") —
    // warns would_revert and scares a signer off a valid tx.
    id: "creator-expiry-bound-exclusive",
    file: "packages/core/src/handlers/jit.ts",
    find: "if (maxDur === undefined || expiryTimestamp <= nowSecs + maxDur) return undefined;",
    replace: "if (maxDur === undefined || expiryTimestamp < nowSecs + maxDur) return undefined;",
    tests: [T.marketCreator],
  },
  // ── constants cache (2026-08-28): live contract constants, compiled literals as FALLBACKS ──
  {
    // TTL comparator inverted: fresh entries are refused and stale ones served — the cache
    // stops converging on the chain's value and the stale-refusal test dies.
    id: "const-cache-ttl-inverted",
    file: "packages/core/src/chain/constants-cache.ts",
    find: "  if (!e || nowMs - e.ts > CONSTANT_TTL_MS) return undefined;",
    replace: "  if (!e || nowMs - e.ts <= CONSTANT_TTL_MS) return undefined;",
    tests: [T.constCache],
  },
  {
    // chainId falls out of the cache key: identical CREATE2 addresses across chains share one
    // entry, and one chain's constant answers for another — the cross-chain test dies.
    id: "const-cache-key-chain-dropped",
    file: "packages/core/src/chain/constants-cache.ts",
    find: "const keyOf = (chainId: number, address: string, fn: string): string => `${chainId}:${address.toLowerCase()}:${fn}`;",
    replace: "const keyOf = (chainId: number, address: string, fn: string): string => `${address.toLowerCase()}:${fn}`;",
    tests: [T.constCache],
  },
  {
    // The live cap stops reaching the gate: a cached 3e18 cap is ignored and the compiled 5e18
    // silently rules again — the exact replicated-constant drift this module retires.
    id: "valuegate-live-cap-ignored",
    file: "packages/core/src/handlers/jit.ts",
    find: "  const cap = opts.capWei ?? MAX_FEE_PERCENTAGE_FALLBACK;",
    replace: "  const cap = MAX_FEE_PERCENTAGE_FALLBACK;",
    tests: [T.constCache],
  },
  {
    // resolveFeeCap loses its fallback: a cold cache answers 0 and every fee refuses.
    id: "feecap-fallback-dropped",
    file: "packages/core/src/handlers/jit.ts",
    find: '  return cachedContractConstant(chainId, address, "MAX_FEE_PERCENTAGE") ?? MAX_FEE_PERCENTAGE_FALLBACK;',
    replace: '  return cachedContractConstant(chainId, address, "MAX_FEE_PERCENTAGE") ?? 0n;',
    tests: [T.constCache, T.mr],
  },
  // ── output-scales gate (audit A2 structural remediation): unlabeled money outputs fail CI ──
  {
    // The maker-order scales block vanishes: approvals[].amount ships unlabeled again — the
    // exact class the gate exists for; the walker must name it.
    id: "maker-order-scales-dropped",
    file: "packages/core/src/handlers/prepare-orders.ts",
    find: '        scales: { makingAmount: "base units of makerAsset (the token\'s own decimals)", takingAmount: "base units of takerAsset", approvalsAmount: "approvals[].amount is base units of that entry\'s own token", unitsTopic: UNITS_TOPIC_REFERENCE },\n',
    replace: "",
    tests: [T.outputScales],
  },
  {
    // The authority tx's amount label vanishes — the gate's other real first-run finding.
    id: "authority-scale-dropped",
    file: "packages/core/src/handlers/phoenix.ts",
    find: '      scale: "amount is base units of `token` (its own decimals); the uint256 max sentinel = unlimited",\n',
    replace: "",
    tests: [T.outputScales],
  },
  // ── decode calldata claimed `to` (2026-08-28): target verification before the signed tx ────
  {
    // The claim stops reaching the decoder: legs fall back to ZERO_ADDR + empty trust, so a
    // caller-verified decode silently degrades to shape-only — trusted never appears and a
    // contradicting claim stops conflicting.
    id: "calldata-claimed-to-dropped",
    file: "packages/core/src/handlers/decode.ts",
    find: "const legs = labelLopLegs(decodeCallOrBundle(data, claimedTo ?? ZERO_ADDR, 0n, claimedTo !== undefined || isBundlerMulticall(data) ? targets : {}), chainId, jitTrust);",
    replace: "const legs = labelLopLegs(decodeCallOrBundle(data, ZERO_ADDR, 0n, isBundlerMulticall(data) ? targets : {}), chainId, jitTrust);",
    tests: [T.decodeTrust],
  },
  // ── A deployed oracle whose rate() reverts is the cause, not the input ──────────
  {
    // The captured revert is dropped: a reverting oracle collapses back to "rate: null", the
    // resolve gate falls through to recipe_refused, and the anchor/deploy misdirection returns.
    id: "oracle-rate-error-dropped",
    file: "packages/core/src/handlers/registry.ts",
    find: "    return { rate: null, rateError: revertReason(err) };",
    replace: "    return { rate: null };",
    tests: [T.oracleDiag],
  },
  {
    // The oracle-fault branch is unreachable: every resolve revert is again the caller's fault.
    id: "oracle-rate-gate-dropped",
    file: "packages/core/src/handlers/registry.ts",
    find: "    if (o.deployed && o.rateError) {",
    replace: "    if (false) {",
    tests: [T.oracleDiag],
  },
  {
    // rateReadable inverted: a reverting oracle reads as readable and a healthy one as broken.
    id: "oracle-rate-readable-flag-inverted",
    file: "packages/core/src/handlers/registry.ts",
    find: 'return r.rate !== null ? { rate: r.rate, rateScale: "ABSOLUTE, 1e18 = 1.0", rateReadable: true } : { rateReadable: false, ...(r.rateError ? { rateError: r.rateError } : {}) };',
    replace: 'return r.rate !== null ? { rate: r.rate, rateScale: "ABSOLUTE, 1e18 = 1.0", rateReadable: false } : { rateReadable: true, ...(r.rateError ? { rateError: r.rateError } : {}) };',
    tests: [T.oracleDiag],
  },
  {
    // The multicall's OUTER target check vanishes: bytes claimed at a non-Bundler3 address
    // decode clean — the inner legs verify but the contract that would RUN them is unchecked.
    id: "calldata-outer-bundler-check-dropped",
    file: "packages/core/src/handlers/decode.ts",
    find: "if (claimedTo !== undefined && isBundlerMulticall(data) && targets.bundler3 !== undefined && claimedTo.toLowerCase() !== targets.bundler3.toLowerCase()) {",
    replace: "if (false) {",
    tests: [T.decodeTrust],
  },
];

// ── runner ──────────────────────────────────────────────────────────────────────────────────
const onlyArg = process.argv.indexOf("--only");
const only = onlyArg >= 0 ? (process.argv[onlyArg + 1] ?? "").split(",").filter(Boolean) : null;
const catalog = only ? CATALOG.filter((m) => only.some((p) => m.id.startsWith(p))) : CATALOG;
if (catalog.length === 0) {
  console.error("no mutants matched --only");
  process.exit(1);
}

// ── sandbox: mutants run in a disposable COPY of the working tree ───────────────────────────
// Fixes the one-tree-one-runner footgun (audit A4, structural remediation 2026-08-28): mutants
// used to be written into REAL source for seconds at a time, so any concurrent vitest/eval/CLI
// run read mutated code and failed on phantoms (observed 2026-08-27). Now the WORKING TREE is
// never touched: every tracked + untracked-unignored file is copied into a temp dir, each
// node_modules is symlinked in (bun's isolated linker resolves through symlinks), and both the
// baseline and every mutant vitest run execute with cwd = sandbox. A kill mid-mutant strands
// nothing — cleanup is just deleting the temp dir, and even a SIGKILL leaves only tmp garbage.
function createSandbox(): string {
  const root = mkdtempSync(join(tmpdir(), "cork-mutation-"));
  const ls = Bun.spawnSync(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
  if (ls.exitCode !== 0) {
    console.error("git ls-files failed — the sandbox copy needs a git worktree to enumerate the source set");
    process.exit(1);
  }
  for (const rel of ls.stdout.toString("utf8").split("\0")) {
    if (!rel) continue;
    let stat;
    try {
      stat = lstatSync(rel);
    } catch {
      continue; // deleted-but-tracked
    }
    mkdirSync(join(root, dirname(rel)), { recursive: true });
    if (stat.isSymbolicLink()) {
      symlinkSync(readlinkSync(rel), join(root, rel));
    } else if (stat.isFile()) {
      copyFileSync(rel, join(root, rel));
    }
    // Anything else (a submodule gitlink is a DIRECTORY in ls-files) is skipped: no catalog
    // test runs inside a submodule, and its tree is not this repo's source.
  }
  // Symlink every node_modules the real tree holds (root + per-package; bun isolated linker).
  const nmCandidates = ["node_modules", ...readdirSync(".", { withFileTypes: true }).filter((d) => d.isDirectory()).flatMap((d) => {
    try {
      return readdirSync(d.name, { withFileTypes: true }).filter((s) => s.isDirectory()).map((s) => join(d.name, s.name, "node_modules"));
    } catch {
      return [];
    }
  })];
  for (const nm of nmCandidates) {
    if (!existsSync(nm) || existsSync(join(root, nm))) continue;
    mkdirSync(join(root, dirname(nm)), { recursive: true });
    symlinkSync(resolve(nm), join(root, nm));
  }
  return root;
}

const sandbox = createSandbox();
const cleanup = (): void => {
  try {
    rmSync(sandbox, { recursive: true, force: true });
  } catch {
    /* tmp garbage at worst */
  }
};
process.on("exit", cleanup);
process.on("SIGINT", () => process.exit(130));
process.on("SIGTERM", () => process.exit(143));
console.log(`sandbox: ${sandbox} (the working tree is never mutated — concurrent runs in the tree are safe)`);

async function vitest(tests: string[]): Promise<boolean> {
  const proc = Bun.spawn(["bun", "x", "vitest", "run", ...tests], { cwd: sandbox, stdout: "ignore", stderr: "ignore" });
  return (await proc.exited) === 0;
}

// Baseline: the union of targeted test files must be green (IN THE SANDBOX) before mutating —
// this also proves the sandbox copy itself is runnable, so a copy defect cannot fake "caught".
const allTests = [...new Set(catalog.flatMap((m) => m.tests))];
console.log(`baseline: ${allTests.length} test files clean-run…`);
if (!(await vitest(allTests))) {
  console.error("BASELINE RED — fix the suite before running mutation probes (a red baseline would fake 'caught'). If the plain tree is green, the sandbox copy is the suspect: a test may depend on something git ls-files does not enumerate.");
  process.exit(1);
}

let survivors = 0;
let rotted = 0;
for (const m of catalog) {
  // Rot checks read the REAL file (the probe aims at the source of record); the mutant is
  // planted in the sandbox twin.
  const original = readFileSync(m.file, "utf8");
  if (!original.includes(m.find)) {
    console.log(`ROT      ${m.id} — pattern no longer matches ${m.file}; re-aim the probe`);
    rotted++;
    continue;
  }
  // An AMBIGUOUS find is rot too: `replace` would mutate only the FIRST occurrence — possibly
  // the wrong site — while the probe still reports "caught" for a defect it never planted where
  // intended (several finds are byte-identical across maker/taker paths and disambiguate only
  // by indentation; an indentation-equalizing refactor must fail HERE, not silently mis-aim).
  if (original.indexOf(m.find) !== original.lastIndexOf(m.find)) {
    console.log(`ROT      ${m.id} — pattern matches ${m.file} MORE THAN ONCE (ambiguous anchor); make the find unique`);
    rotted++;
    continue;
  }
  // split/join, not String.replace with a string arg — replace interprets `$$`/`$&`/$` in the
  // replacement, which would silently corrupt a future mutant quoting such source.
  const twin = join(sandbox, m.file);
  writeFileSync(twin, original.split(m.find).join(m.replace));
  try {
    const passed = await vitest(m.tests);
    if (passed) {
      console.log(`SURVIVED ${m.id} — the suite cannot see this defect; write a killer test`);
      survivors++;
    } else {
      console.log(`caught   ${m.id}`);
    }
  } finally {
    writeFileSync(twin, original);
  }
}

console.log(`\n${catalog.length} mutants: ${catalog.length - survivors - rotted} caught, ${survivors} survived, ${rotted} rotted`);
if (survivors > 0 || rotted > 0) process.exit(1);
