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
  venueTransport: "packages/core/test/venue-transport.test.ts",
  breaker: "packages/core/test/breaker.test.ts",
  rpc: "packages/core/test/rpc.test.ts",
  handlers: "packages/core/test/handlers.test.ts",
  decodeTx: "packages/core/test/decode-tx.test.ts",
  forself: "packages/core/test/forself.test.ts",
  phala: "packages/core/test/phala-attest.test.ts",
  cli: "packages/cli/test/cli.test.ts",
  hypersync: "packages/core/test/hypersync.test.ts",
  decodeJit: "packages/core/test/decode-jit-order.test.ts",
  port: "scripts/port-to-public.test.ts",
  evalAuth: "evals/auth-mode.test.ts",
  teaching: "packages/schemas/test/teaching.test.ts",
  docTopics: "packages/core/test/doc-topics.test.ts",
  http: "packages/mcp/test/http.test.ts",
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
    find: '      second = (await client.readContract({ address: controller, abi: controllerViewsAbi, functionName: "FEE_MANAGER_ROLE" })) as `0x${string}`;\n      secondRole = "FEE_MANAGER";',
    replace: '      throw new Error("mutant: generation probe disabled");',
    tests: [T.mr],
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
    find: '  let jit: JitLabel | undefined;\n  if (extension !== undefined && extension !== "0x") {',
    replace: '  let jit: JitLabel | undefined;\n  if (extension !== undefined && extension !== "0x" && fusion === undefined) {',
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
    find: "return { argv: [...spec.path, next, `--${spec.positional.flag}`, first, ...argvIn.slice(i + 2)] };",
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
    find: 'if (i["suggestion"]) parts.push(wrapped(`→ ${i["suggestion"]}`, 4));',
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
  // ── RFQ negotiation surface (venue a2b03bd): fraction contract, citation gates, band, view ──
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
    find: "return { option, unresolved: option === undefined && rfq.truncated === true };",
    replace: "return { option, unresolved: option === undefined && rfq.truncated !== true };",
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
    find: "if (referencedPercent > 0 && action.premium > 0 && (ratio > 10 || ratio < 0.1)) {",
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
    // the pre-flight exists to refuse with teaching first) and every OWN citation is refused.
    id: "quote-ref-maker-requester-inverted",
    file: "packages/core/src/handlers/submit.ts",
    find: "if (typeof storedRequester === \"string\" && storedRequester.toLowerCase() !== action.order.maker.toLowerCase()) {",
    replace: "if (typeof storedRequester === \"string\" && storedRequester.toLowerCase() === action.order.maker.toLowerCase()) {",
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
