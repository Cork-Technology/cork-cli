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
    file: "packages/core/src/handlers.ts",
    find: "const interaction = `0x${mr.adapter.slice(2)}${extraData.slice(2)}` as `0x${string}`;",
    replace: "const interaction = `0x${extraData.slice(2)}${mr.adapter.slice(2)}` as `0x${string}`;",
    tests: [T.venue],
  },
  {
    id: "predict-precalls-dropped",
    file: "packages/core/src/handlers.ts",
    find: 'preCalls.push({ to: mr.registry, data: source === "fixed" && filters.rate !== undefined ? buildDeployFixedRateOracleCall(filters.rate) : buildDeployOracleCall(ca, ref, oracle.mode ?? "price") });',
    replace: "void 0;",
    tests: [T.mr],
  },
  {
    // NOTE: the maker and taker builders contain BYTE-IDENTICAL preCalls lines; the finds below
    // disambiguate by indentation (maker sits deeper inside handlePrepareOrders). A refactor
    // that equalizes the indentation will surface here as pattern rot — re-aim, don't delete.
    id: "makerjit-precalls-dropped",
    file: "packages/core/src/handlers.ts",
    find: '\n              preCalls.push({ to: mr.registry, data: source === "fixed" ? buildDeployFixedRateOracleCall(rateOverride) : buildDeployOracleCall(jm.collateralAsset, jm.referenceAsset, oracle.mode ?? "price") });',
    replace: "\n              void 0;",
    tests: [T.mr],
  },
  {
    id: "takerjit-precalls-dropped",
    file: "packages/core/src/handlers.ts",
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
    file: "packages/core/src/handlers.ts",
    find: "\n      if (!adapterRoles.granted) {",
    replace: "\n      if (false) {",
    tests: [T.venue],
  },
  {
    id: "makerjit-roles-warn-dropped",
    file: "packages/core/src/handlers.ts",
    find: "\n            if (!adapterRoles.granted) {",
    replace: "\n            if (false) {",
    tests: [T.mr],
  },
  // ── stale_share_prediction: the consumed-nonce diagnosis (single shared emitter by design) ──
  {
    id: "stale-diagnosis-warn-dropped",
    file: "packages/core/src/handlers.ts",
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
    file: "packages/core/src/handlers.ts",
    find: "if (swapFee > 5n * 10n ** 18n || unwindFee > 5n * 10n ** 18n) {",
    replace: "if (swapFee >= 5n * 10n ** 18n || unwindFee >= 5n * 10n ** 18n) {",
    tests: [T.mr],
  },
  {
    id: "jit-expiry-boundary",
    file: "packages/core/src/handlers.ts",
    find: "if (expiryTimestamp <= nowSecs) {",
    replace: "if (expiryTimestamp < nowSecs) {",
    tests: [T.mr],
  },
  {
    id: "binding-guard-inverted",
    file: "packages/core/src/handlers.ts",
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
