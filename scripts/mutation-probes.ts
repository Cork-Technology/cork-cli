// Mutation probes for the bytes-critical core logic — a REPEATABLE gate, not a one-off audit.
// Each catalog entry applies one semantic mutant to a source file, runs the focused offline test
// subset, and expects it to FAIL (the mutant is "caught"). The run exits non-zero when:
//   - any mutant SURVIVES (the suite cannot see that defect — write a killer test), or
//   - a mutant's `find` pattern no longer matches (pattern rot: the source moved; re-aim the
//     probe rather than silently losing coverage), or
//   - the clean baseline is already red (a red suite would masquerade as "caught").
// Files are restored byte-exactly from an in-memory snapshot in a finally block, so the probe
// run never leaves mutants behind — safe on a dirty working tree.
//
//   bun run test:mutation            # full catalog (~2–5 min; spawns focused vitest runs)
//   bun scripts/mutation-probes.ts --only marketid,orders   # comma-separated id prefixes
//
// Selection philosophy: mutants target the places where a silent defect becomes SIGNED-BUT-WRONG
// BYTES or a wrong money answer — struct/tuple field order, enum ordinals, bit flags, hash
// inputs, rounding directions, boundary comparators, storage-slot math — not statement coverage.
// The catalog is append-only in spirit: when a survivor is killed, keep the probe.
import { readFileSync, writeFileSync } from "node:fs";

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
  bundle: "packages/core/test/bundle.test.ts",
  encoders: "packages/core/test/action-encoders.test.ts",
  funding: "packages/core/test/funding.test.ts",
  events: "packages/core/test/event-decode.test.ts",
  venue: "packages/core/test/venue.test.ts",
  handlers: "packages/core/test/handlers.test.ts",
  decodeTx: "packages/core/test/decode-tx.test.ts",
  phala: "packages/core/test/phala-attest.test.ts",
  cli: "packages/cli/test/cli.test.ts",
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
    id: "orders-taker-interaction-offset",
    file: "packages/core/src/orders.ts",
    find: "const TAKER_ARGS_INTERACTION_LENGTH_OFFSET = 200n;",
    replace: "const TAKER_ARGS_INTERACTION_LENGTH_OFFSET = 201n;",
    tests: [T.orders],
  },
  {
    id: "taker-interaction-concat-order",
    file: "packages/core/src/handlers/jit.ts",
    find: "const interaction = `0x${mr.adapter.slice(2)}${extraData.slice(2)}` as `0x${string}`;",
    replace: "const interaction = `0x${extraData.slice(2)}${mr.adapter.slice(2)}` as `0x${string}`;",
    tests: [T.venue],
  },
  {
    id: "predict-precalls-dropped",
    file: "packages/core/src/handlers/registry.ts",
    find: 'preCalls.push({ to: mr.registry, data: source === "fixed" && filters.rate !== undefined ? buildDeployFixedRateOracleCall(filters.rate) : buildDeployOracleCall(ca, ref, oracle.mode ?? "price") });',
    replace: "void 0;",
    tests: [T.mr],
  },
  {
    // NOTE: the maker and taker builders contain BYTE-IDENTICAL preCalls lines; the finds below
    // disambiguate by indentation (maker sits deeper inside handlePrepareOrders). A refactor
    // that equalizes the indentation will surface here as pattern rot — re-aim, don't delete.
    id: "makerjit-precalls-dropped",
    file: "packages/core/src/handlers/prepare-orders.ts",
    find: '\n              preCalls.push({ to: mr.registry, data: source === "fixed" ? buildDeployFixedRateOracleCall(rateOverride) : buildDeployOracleCall(jm.collateralAsset, jm.referenceAsset, oracle.mode ?? "price") });',
    replace: "\n              void 0;",
    tests: [T.mr],
  },
  {
    id: "takerjit-precalls-dropped",
    file: "packages/core/src/handlers/jit.ts",
    find: '\n        preCalls.push({ to: mr.registry, data: source === "fixed" ? buildDeployFixedRateOracleCall(rateOverride) : buildDeployOracleCall(jm.collateralAsset, jm.referenceAsset, oracle.mode ?? "price") });',
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
    find: "return { hasCreator, hasConfigurator, granted: hasCreator && hasConfigurator };",
    replace: "return { hasCreator, hasConfigurator, granted: hasCreator || hasConfigurator };",
    tests: [T.mr, T.venue],
  },
  {
    // Swapped role constant: both reads become CONFIGURATOR, so the mixed-state stub reports
    // POOL_CREATOR: false — the killer asserts the per-role truth in the warning message.
    id: "roles-gate-creator-arg-swapped",
    file: "packages/core/src/market-registry.ts",
    find: 'args: [roles.creator ?? POOL_CREATOR_ROLE, adapter]',
    replace: 'args: [roles.creator ?? CONFIGURATOR_ROLE, adapter]',
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
    file: "packages/core/src/handlers/jit.ts",
    find: "\n      if (!adapterRoles.granted) {",
    replace: "\n      if (false) {",
    tests: [T.venue],
  },
  {
    id: "makerjit-roles-warn-dropped",
    file: "packages/core/src/handlers/prepare-orders.ts",
    find: "\n            if (!adapterRoles.granted) {",
    replace: "\n            if (false) {",
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
    find: '  let jit: Record<string, unknown> | undefined;\n  if (extension !== undefined && extension !== "0x") {',
    replace: '  let jit: Record<string, unknown> | undefined;\n  if (extension !== undefined && extension !== "0x" && fusion === undefined) {',
    tests: [T.fusion],
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
    find: 'return { mode: "bit", slot: nonceOrEpoch >> 8n, mask: 1n << (nonceOrEpoch & 0xffn), nonceOrEpoch };',
    replace: 'return { mode: "bit", slot: nonceOrEpoch >> 7n, mask: 1n << (nonceOrEpoch & 0xffn), nonceOrEpoch };',
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
    find: "if (swapFee > 5n * 10n ** 18n || unwindFee > 5n * 10n ** 18n) {",
    replace: "if (swapFee >= 5n * 10n ** 18n || unwindFee >= 5n * 10n ** 18n) {",
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
];

// ── runner ──────────────────────────────────────────────────────────────────────────────────
const onlyArg = process.argv.indexOf("--only");
const only = onlyArg >= 0 ? (process.argv[onlyArg + 1] ?? "").split(",").filter(Boolean) : null;
const catalog = only ? CATALOG.filter((m) => only.some((p) => m.id.startsWith(p))) : CATALOG;
if (catalog.length === 0) {
  console.error("no mutants matched --only");
  process.exit(1);
}

async function vitest(tests: string[]): Promise<boolean> {
  const proc = Bun.spawn(["bun", "x", "vitest", "run", ...tests], { stdout: "ignore", stderr: "ignore" });
  return (await proc.exited) === 0;
}

// Baseline: the union of targeted test files must be green BEFORE mutating.
const allTests = [...new Set(catalog.flatMap((m) => m.tests))];
console.log(`baseline: ${allTests.length} test files clean-run…`);
if (!(await vitest(allTests))) {
  console.error("BASELINE RED — fix the suite before running mutation probes (a red baseline would fake 'caught').");
  process.exit(1);
}

let survivors = 0;
let rotted = 0;
for (const m of catalog) {
  const original = readFileSync(m.file, "utf8");
  if (!original.includes(m.find)) {
    console.log(`ROT      ${m.id} — pattern no longer matches ${m.file}; re-aim the probe`);
    rotted++;
    continue;
  }
  writeFileSync(m.file, original.replace(m.find, m.replace));
  try {
    const passed = await vitest(m.tests);
    if (passed) {
      console.log(`SURVIVED ${m.id} — the suite cannot see this defect; write a killer test`);
      survivors++;
    } else {
      console.log(`caught   ${m.id}`);
    }
  } finally {
    writeFileSync(m.file, original);
  }
}

console.log(`\n${catalog.length} mutants: ${catalog.length - survivors - rotted} caught, ${survivors} survived, ${rotted} rotted`);
if (survivors > 0 || rotted > 0) process.exit(1);
