// The filler's two protections on a rollover fill (planning#83, 2026-10-09). BaseFiller is
// caller-bound — it pulls from and pays only msg.sender — so a fill cannot be redirected; but the
// VALUE it returns is decided inside the holder's clone, by hooks the holder signed and attesters
// the holder chose. The trust-config timelock delay is 0 on both chains (read live 2026-10-09), so
// the holder can swap the clone's attesters for its own and attest a mid-roll hook that keeps the
// unwound collateral; with minDstPerSrc = 0 the filler then pays its src cST and the premium for
// nothing. Proven on a Base fork (planning#83 case C).
//
// 1. deriveDstFloor — the dst cST an HONEST roll mints per src cST, read from the two pool-manager
//    previews the clone's own path runs: previewUnwindMint on the source pool (the collateral the
//    unwind returns) and previewDeposit on the destination (the shares that collateral mints; the
//    clone itself caps its deposit at this preview, DepositOverMint). Phoenix converts both ways
//    at exactly 1:1 after decimal normalization, with no fee, so the honest rate is exact and the
//    floor IS the previewed rate: any tolerance would be value a skimming hook keeps for free.
// 2. readRolloverTrust — the clone's live attesters against the factory defaults, a queued trust
//    change, the change delay, and every intent hook checked against the DEFAULT attesters for its
//    phase. A disclosure, never a refusal: the holder can change its attesters after this read
//    (the delay is 0), so the floor is the protection and this is the evidence.
import { isAddressEqual, type PublicClient } from "viem";
import { erc20Abi, marketAbiFor } from "../chain/abis.ts";
import { resolveGenerations } from "../config-remote.ts";
import { type PoolGenerationResolution, resolvePoolGeneration } from "../generations.ts";
import { isContractRevert } from "../chain/rpc.ts";
import { revertReason } from "./shared.ts";

type Address = `0x${string}`;
type FoundPool = Extract<PoolGenerationResolution, { found: true }>;

/** The two CorkPoolManager previews the clone's path mirrors (the same on the 8- and 10-field
 *  pool managers; both answer 0 while the action is paused or the pool expired). */
export const poolPreviewAbi = [
  { type: "function", name: "previewUnwindMint", stateMutability: "view", inputs: [{ name: "poolId", type: "bytes32" }, { name: "cptAndCstSharesIn", type: "uint256" }], outputs: [{ name: "collateralAssetsOut", type: "uint256" }] },
  { type: "function", name: "previewDeposit", stateMutability: "view", inputs: [{ name: "poolId", type: "bytes32" }, { name: "collateralAssetsIn", type: "uint256" }], outputs: [{ name: "cptAndCstSharesOut", type: "uint256" }] },
] as const;

/** The rollover factory's trust surface (CorkRolloverContractFactory, rollover 0.2.0 and rc.2). */
export const rolloverFactoryTrustAbi = [
  { type: "function", name: "defaultAttesters", stateMutability: "view", inputs: [], outputs: [{ name: "attesters", type: "address[]" }] },
  { type: "function", name: "DEFAULT_TRUST_THRESHOLD", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "trustConfigTimelock", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "pendingTrustConfig", stateMutability: "view", inputs: [{ name: "rolloverContract", type: "address" }], outputs: [{ name: "threshold", type: "uint8" }, { name: "attesters", type: "address[]" }, { name: "effectiveAt", type: "uint64" }] },
] as const;

/** The clone's live trust (CorkRolloverContract.rolloverContractSnapshot). */
export const rolloverCloneTrustAbi = [
  {
    type: "function",
    name: "rolloverContractSnapshot",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "trustSnapshot", type: "tuple", components: [{ name: "erc7484Registry", type: "address" }, { name: "liveTrustThreshold", type: "uint8" }, { name: "liveTrustAttesters", type: "address[]" }] }],
  },
] as const;

/** OpenZeppelin TimelockController.getMinDelay — the trust-config change delay. */
export const timelockDelayAbi = [{ type: "function", name: "getMinDelay", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }] as const;

/** ERC-7484 `check(module, moduleType, attesters, threshold)` — reverts unless `threshold` of the
 *  given attesters attest `module` for `moduleType`; the clone runs exactly this per hook. */
export const erc7484CheckAbi = [
  { type: "function", name: "check", stateMutability: "view", inputs: [{ name: "module", type: "address" }, { name: "moduleType", type: "uint256" }, { name: "attesters", type: "address[]" }, { name: "threshold", type: "uint256" }], outputs: [] },
] as const;

/** Rollover hook module types (Typehashes.sol): pre 5, mid 6, post 7, premium = MODULE_TYPE_EXECUTOR 8. */
export const HOOK_MODULE_TYPES = { pre: 5n, mid: 6n, post: 7n, premium: 8n } as const;
export type HookPhase = keyof typeof HOOK_MODULE_TYPES;

/** Why no floor could be derived. `fill-refused` is not a gap in the derivation but a fill the
 *  settler refuses, so it refuses whatever floor the caller states. */
export type DstFloorGap = "fill-refused" | "source-pool-unknown" | "destination-pool-unknown" | "token-mismatch" | "cross-collateral" | "source-closed" | "destination-closed" | "read-failed";

export type DstFloor =
  | {
      ok: true;
      /** minDstPerSrc to sign, 1e18 = 1.0 (WAD): the previewed rate itself. */
      floor: bigint;
      /** src cST the clone burns: fillerSrcCst (the settler admits only quantum-aligned fills). */
      srcBurned: bigint;
      /** The source pool's share quantum, 10^(18 − collateral decimals). */
      quantum: bigint;
      /** collateral previewUnwindMint returns, in the collateral's base units. */
      collateralOut: bigint;
      /** dst cST previewDeposit mints for that collateral, 18 decimals. */
      expectedDstCst: bigint;
      collateralAsset: Address;
      /** Which pool answered previewDeposit: the destination itself, or — for a just-in-time
       *  destination that does not exist yet — the source pool on the SAME pool manager, whose
       *  deposit rule the new pool will share (same contract, same collateral). */
      depositPreviewedOn: "destination" | "source (just-in-time destination, same pool manager)";
    }
  | { ok: false; gap: DstFloorGap; reason: string };

/** The destination a just-in-time fill creates: its collateral, and the pool manager that will
 *  host it (the rollover generation's). */
export interface JitDestination {
  collateralAsset: Address;
  poolManager: Address;
}

const gap = (g: DstFloorGap, reason: string): DstFloor => ({ ok: false, gap: g, reason });

/** A pool the order names, resolved across every configured pool manager — or why not. A pool no
 *  manager knows because every read THREW is a read failure, not an absent pool. */
async function locate(client: PublicClient, chainId: number, poolId: Address, atBlock: bigint | undefined): Promise<FoundPool | { found: false; readFailed: boolean; message: string }> {
  const { generations } = await resolveGenerations(chainId);
  const r = await resolvePoolGeneration(client, generations, poolId, undefined, atBlock);
  if (r.found) return r;
  const readFailed = r.causes !== undefined && r.causes.length === r.asked.length && r.asked.length > 0;
  return { found: false, readFailed, message: r.message };
}

/** The floor an honest roll of `fillerSrcCst` meets, or the gap that stops the derivation. The
 *  source side is read first, so a fill off the share quantum is named even when the destination
 *  cannot be priced. */
export async function deriveDstFloor(
  client: PublicClient,
  p: { chainId: number; srcPoolId: Address; dstPoolId: Address; srcCstToken: Address; dstCstToken: Address; fillerSrcCst: bigint; jitDestination?: JitDestination; atBlock?: bigint },
): Promise<DstFloor> {
  const at = p.atBlock !== undefined ? { blockNumber: p.atBlock } : {};
  const marketOf = (r: FoundPool, poolId: Address) =>
    client.readContract({ address: r.poolManager, abi: marketAbiFor(r.generation.phoenix!.wire), functionName: "market", args: [poolId], ...at }) as Promise<{ collateralAsset: Address }>;
  try {
    // ── the source side: the unwind ──
    const src = await locate(client, p.chainId, p.srcPoolId, p.atBlock);
    if (!src.found) return src.readFailed ? gap("read-failed", `every pool-manager read for the source pool failed (${src.message})`) : gap("source-pool-unknown", `the source pool ${p.srcPoolId} is unknown to every pool manager asked (${src.message})`);
    if (!isAddressEqual(src.corkSwapToken, p.srcCstToken)) return gap("token-mismatch", `the source pool's cST is ${src.corkSwapToken}, not the order's srcCstToken ${p.srcCstToken}`);
    const { collateralAsset } = await marketOf(src, p.srcPoolId);
    const decimals = Number(await client.readContract({ address: collateralAsset, abi: erc20Abi, functionName: "decimals", ...at }));
    if (decimals > 18) return gap("fill-refused", `the source collateral has ${decimals} decimals; the clone refuses more than 18 (LibPhoenixShareQuantum__UnsupportedCollateralDecimals)`);
    const quantum = 10n ** BigInt(18 - decimals);
    if (p.fillerSrcCst % quantum !== 0n) {
      return gap("fill-refused", `fillerSrcCst ${p.fillerSrcCst} is not a multiple of the source pool's share quantum ${quantum} (10^(18 − ${decimals}) for its ${decimals}-decimal collateral) — the settler reverts LibPhoenixShareQuantum__FillAmountNotQuantumAligned`);
    }
    const collateralOut = (await client.readContract({ address: src.poolManager, abi: poolPreviewAbi, functionName: "previewUnwindMint", args: [p.srcPoolId, p.fillerSrcCst], ...at })) as bigint;
    if (collateralOut === 0n) return gap("source-closed", `previewUnwindMint(${p.srcPoolId}, ${p.fillerSrcCst}) answers 0: the source pool's unwind is paused or the pool expired, so the clone's unwindMint reverts`);

    // ── the destination side: the deposit ──
    const dst = await locate(client, p.chainId, p.dstPoolId, p.atBlock);
    let previewOn: { pm: Address; poolId: Address; where: "destination" | "source (just-in-time destination, same pool manager)" };
    if (dst.found) {
      if (!isAddressEqual(dst.corkSwapToken, p.dstCstToken)) return gap("token-mismatch", `the destination pool's cST is ${dst.corkSwapToken}, not the order's dstCstToken ${p.dstCstToken}`);
      const dstMarket = await marketOf(dst, p.dstPoolId);
      if (!isAddressEqual(dstMarket.collateralAsset, collateralAsset)) return gap("cross-collateral", `the source collateral ${collateralAsset} differs from the destination collateral ${dstMarket.collateralAsset}: the roll converts one into the other inside a mid-roll hook, and no preview prices that conversion`);
      previewOn = { pm: dst.poolManager, poolId: p.dstPoolId, where: "destination" };
    } else if (dst.readFailed) {
      return gap("read-failed", `every pool-manager read for the destination pool failed (${dst.message})`);
    } else if (p.jitDestination !== undefined) {
      if (!isAddressEqual(p.jitDestination.collateralAsset, collateralAsset)) return gap("cross-collateral", `the just-in-time destination's collateral ${p.jitDestination.collateralAsset} differs from the source collateral ${collateralAsset}: the roll converts one into the other inside a mid-roll hook, and no preview prices that conversion`);
      if (!isAddressEqual(p.jitDestination.poolManager, src.poolManager)) return gap("destination-pool-unknown", `the just-in-time destination is created on pool manager ${p.jitDestination.poolManager}, not on the source pool's ${src.poolManager}, so no live pool shares its deposit rule`);
      previewOn = { pm: src.poolManager, poolId: p.srcPoolId, where: "source (just-in-time destination, same pool manager)" };
    } else {
      return gap("destination-pool-unknown", `the destination pool ${p.dstPoolId} is unknown to every pool manager asked, so previewDeposit has no pool to price`);
    }
    const expectedDstCst = (await client.readContract({ address: previewOn.pm, abi: poolPreviewAbi, functionName: "previewDeposit", args: [previewOn.poolId, collateralOut], ...at })) as bigint;
    if (expectedDstCst === 0n) return gap("destination-closed", `previewDeposit(${previewOn.poolId}, ${collateralOut}) on the ${previewOn.where} answers 0: deposits are paused or the pool expired, so the clone's deposit reverts`);
    return { ok: true, floor: (expectedDstCst * 10n ** 18n) / p.fillerSrcCst, srcBurned: p.fillerSrcCst, quantum, collateralOut, expectedDstCst, collateralAsset, depositPreviewedOn: previewOn.where };
  } catch (err) {
    return gap("read-failed", `a preview read ${isContractRevert(err) ? "reverted" : "failed"} (${revertReason(err)})`);
  }
}

export interface HookVetting {
  phase: HookPhase;
  index: number;
  target: Address;
  /** true: the factory's DEFAULT attesters vouch for this module for this phase; false: they do
   *  not (registry.check reverted); null: no verdict (the read failed without a revert). */
  vettedByDefaults: boolean | null;
}

export interface RolloverTrust {
  registry: Address;
  defaults: { threshold: number; attesters: Address[] };
  clone: { threshold: number; attesters: Address[] };
  /** The clone trusts exactly the factory's defaults (same threshold, same attester set). */
  cloneMatchesDefaults: boolean;
  /** A trust change the holder queued and has not applied; null when none is queued. */
  pending: { threshold: number; attesters: Address[]; effectiveAt: string } | null;
  /** The trust-config timelock's delay, seconds: how long a queued change waits. */
  changeDelaySeconds: string;
  hooks: HookVetting[];
}

const sameSet = (a: readonly string[], b: readonly string[]) => {
  const norm = (x: readonly string[]) => [...new Set(x.map((v) => v.toLowerCase()))].sort();
  const [na, nb] = [norm(a), norm(b)];
  return na.length === nb.length && na.every((v, i) => v === nb[i]);
};

/** The clone's live trust next to the factory's defaults, and every intent hook checked against
 *  the DEFAULTS (not the clone's live set: a holder that installs its own attester passes its own
 *  check by construction). The factory stores its defaults strictly ascending (its constructor and
 *  setter validate that), which is the order the registry requires. Throws on a read failure; the
 *  caller decides how to disclose it. */
export async function readRolloverTrust(
  client: PublicClient,
  p: { factory: Address; clone: Address; hooks: Record<HookPhase, ReadonlyArray<{ target: Address }>>; atBlock?: bigint },
): Promise<RolloverTrust> {
  const at = p.atBlock !== undefined ? { blockNumber: p.atBlock } : {};
  const [defaultAttesters, defaultThreshold, snapshot, pendingRaw, timelock] = await Promise.all([
    client.readContract({ address: p.factory, abi: rolloverFactoryTrustAbi, functionName: "defaultAttesters", ...at }),
    client.readContract({ address: p.factory, abi: rolloverFactoryTrustAbi, functionName: "DEFAULT_TRUST_THRESHOLD", ...at }),
    client.readContract({ address: p.clone, abi: rolloverCloneTrustAbi, functionName: "rolloverContractSnapshot", ...at }),
    client.readContract({ address: p.factory, abi: rolloverFactoryTrustAbi, functionName: "pendingTrustConfig", args: [p.clone], ...at }),
    client.readContract({ address: p.factory, abi: rolloverFactoryTrustAbi, functionName: "trustConfigTimelock", ...at }),
  ]);
  const delay = (await client.readContract({ address: timelock as Address, abi: timelockDelayAbi, functionName: "getMinDelay", ...at })) as bigint;
  const defaults = { threshold: Number(defaultThreshold), attesters: [...(defaultAttesters as readonly Address[])] };
  const snap = snapshot as { erc7484Registry: Address; liveTrustThreshold: number; liveTrustAttesters: readonly Address[] };
  const clone = { threshold: Number(snap.liveTrustThreshold), attesters: [...snap.liveTrustAttesters] };
  // pendingTrustConfig answers (0, [], 0) when nothing is queued, the queued set while a change
  // waits, and (0, [], 1) once it is applied: applyTrustConfig clears the queued set (seen on a
  // Base fork, 2026-10-09) and OpenZeppelin's getTimestamp answers 1 for a done operation;
  // cancelTrustConfig clears both. The factory refuses an empty set (InvalidThreshold), so a
  // non-empty set alone means a change is pending.
  const [pThreshold, pAttesters, pEffectiveAt] = pendingRaw as readonly [number, readonly Address[], bigint];
  const pending = pAttesters.length > 0 ? { threshold: Number(pThreshold), attesters: [...pAttesters], effectiveAt: pEffectiveAt.toString() } : null;
  const entries = (Object.keys(HOOK_MODULE_TYPES) as HookPhase[]).flatMap((phase) => p.hooks[phase].map((h, index) => ({ phase, index, target: h.target })));
  const hooks: HookVetting[] = await Promise.all(
    entries.map(async (e) => {
      try {
        await client.readContract({ address: snap.erc7484Registry, abi: erc7484CheckAbi, functionName: "check", args: [e.target, HOOK_MODULE_TYPES[e.phase], defaults.attesters, BigInt(defaults.threshold)], ...at });
        return { ...e, vettedByDefaults: true };
      } catch (err) {
        // A revert is the registry's answer; anything else (transport, a lagging node) is no verdict.
        return { ...e, vettedByDefaults: isContractRevert(err) ? false : null };
      }
    }),
  );
  return { registry: snap.erc7484Registry, defaults, clone, cloneMatchesDefaults: defaults.threshold === clone.threshold && sameSet(defaults.attesters, clone.attesters), pending, changeDelaySeconds: delay.toString(), hooks };
}

/** What the trust read means for this fill: the clone trusts other attesters, a change is queued,
 *  a hook the defaults do not vouch for (a mid-roll hook first: that is where the unwound
 *  collateral can leave), or a hook nobody could check. */
export function trustWarnings(t: RolloverTrust, floorSet: boolean): Array<{ code: string; message: string }> {
  const out: Array<{ code: string; message: string }> = [];
  const protection = floorSet
    ? "your minDstPerSrc floor is what protects you: the fill reverts Settler__InsufficientMintRate if the roll mints less"
    : "with minDstPerSrc = 0 nothing protects you: the clone can keep the unwound collateral and the fill still succeeds";
  const delay = `the trust-config timelock delay is ${t.changeDelaySeconds} s, so the holder can change these attesters between this read and your fill`;
  if (!t.cloneMatchesDefaults) {
    out.push({ code: "rollover_trust_custom", message: `the holder's clone does not trust the factory's default attesters: it trusts [${t.clone.attesters.join(", ")}] at threshold ${t.clone.threshold}; the defaults are [${t.defaults.attesters.join(", ")}] at threshold ${t.defaults.threshold}. The holder sets these through the factory (queueTrustConfig, then applyTrustConfig), so its clone can run hooks the defaults never vetted; ${delay} — ${protection}` });
  }
  if (t.pending !== null) {
    out.push({ code: "rollover_trust_pending", message: `the holder queued a trust change for its clone: [${t.pending.attesters.join(", ")}] at threshold ${t.pending.threshold}, applicable from ${t.pending.effectiveAt} (unix seconds) by anyone calling applyTrustConfig — ${protection}` });
  }
  const unvetted = t.hooks.filter((h) => h.vettedByDefaults === false).sort((a, b) => Number(b.phase === "mid") - Number(a.phase === "mid"));
  if (unvetted.length > 0) {
    const mid = unvetted.some((h) => h.phase === "mid");
    out.push({ code: "hook_not_vetted", message: `the factory's default attesters do not vouch for ${unvetted.map((h) => `${h.phase} hook #${h.index} ${h.target}`).join(", ")}${mid ? " — a MID-roll hook runs between the source unwind and the destination deposit, where it can move the unwound collateral out of the clone" : ""}; the clone runs a hook only when its own attesters accept it. ${protection}` });
  }
  const unchecked = t.hooks.filter((h) => h.vettedByDefaults === null);
  if (unchecked.length > 0) {
    out.push({ code: "chain_read_failed", message: `the registry check of ${unchecked.map((h) => `${h.phase} hook #${h.index} ${h.target}`).join(", ")} got no verdict (the read failed without a revert) — whether the default attesters vouch for it is unknown` });
  }
  return out;
}

/** The floor the fill signs. */
export interface FloorChoice {
  value: bigint;
  source: "explicit" | "derived";
}

/** Pick the floor: the caller's when given, else the derived one; refuse when neither exists, and
 *  refuse a fill the settler itself refuses whatever the floor. `derived` is null when no RPC
 *  resolved. The refusal carries the warning code and the data the envelope reports. */
export function chooseFloor(
  explicit: bigint | undefined,
  derived: DstFloor | null,
): { ok: true; floor: FloorChoice } | { ok: false; code: "invalid_order_terms" | "dst_floor_underivable"; message: string; gap: DstFloorGap | "no-rpc" } {
  if (derived !== null && !derived.ok && derived.gap === "fill-refused") return { ok: false, code: "invalid_order_terms", message: derived.reason, gap: derived.gap };
  if (explicit !== undefined) return { ok: true, floor: { value: explicit, source: "explicit" } };
  if (derived?.ok) return { ok: true, floor: { value: derived.floor, source: "derived" } };
  const why = derived === null ? "no RPC resolved to read previewUnwindMint (source pool) and previewDeposit (destination pool)" : derived.reason;
  return {
    ok: false,
    code: "dst_floor_underivable",
    gap: derived === null ? "no-rpc" : derived.gap,
    message: `minDstPerSrc was omitted and the floor cannot be derived: ${why}. A fill without a floor pays your src cST and the premium for whatever the holder's clone mints, and the holder's hooks decide that — pass minDstPerSrc explicitly (1e18 = 1.0): the dst cST you accept per src cST you bring. Phoenix deposits and unwinds at exactly 1:1, so a same-collateral roll mints one dst cST per src cST and 1e18 is its honest floor; for a cross-collateral roll, price the conversion the mid-roll hook makes. Never 0 unless you accept that the holder's hooks can keep the whole roll`,
  };
}

/** What the chosen floor gives up or risks, measured against the honest rate when one was read. */
export function floorWarnings(floor: FloorChoice, derived: DstFloor | null, amounts: { fillerSrcCst: bigint; premiumCap: bigint }): Array<{ code: string; message: string }> {
  const honest = derived?.ok ? derived : null;
  if (floor.source === "derived" && honest !== null) {
    return [{ code: "dst_floor_derived", message: `minDstPerSrc defaulted to ${honest.floor} (1e18 = 1.0): previewUnwindMint returns ${honest.collateralOut} collateral for the ${honest.srcBurned} src cST the clone burns, and previewDeposit on the ${honest.depositPreviewedOn} mints ${honest.expectedDstCst} dst cST for it. Phoenix converts both ways at exactly 1:1, so this is the honest rate with no tolerance: the fill reverts Settler__InsufficientMintRate if the holder's hooks keep any of the collateral` }];
  }
  if (floor.value === 0n) {
    return [{ code: "no_dst_floor", message: `minDstPerSrc is 0: the settler checks no mint rate, so you pay ${amounts.fillerSrcCst} src cST and up to ${amounts.premiumCap} of the premium token for whatever the holder's clone mints. The holder controls the clone's attesters and the hooks it signed, and a mid-roll hook can keep the unwound collateral — ${honest !== null ? `an honest roll mints ${honest.expectedDstCst} dst cST here (floor ${honest.floor})` : "omit minDstPerSrc to have the honest floor derived"}` }];
  }
  if (honest === null) return [];
  if (floor.value > honest.floor) {
    return [{ code: "would_revert", message: `minDstPerSrc ${floor.value} is above the rate an honest roll mints now (${honest.floor}: ${honest.expectedDstCst} dst cST for ${honest.srcBurned} src cST) — the fill reverts Settler__InsufficientMintRate` }];
  }
  if (floor.value < honest.floor) {
    const accepted = (honest.srcBurned * floor.value) / 10n ** 18n;
    return [{ code: "dst_floor_slack", message: `minDstPerSrc ${floor.value} is below the honest rate ${honest.floor}: an honest roll mints ${honest.expectedDstCst} dst cST, and the fill still succeeds at ${accepted}, so the holder's hooks can keep the collateral behind the other ${honest.expectedDstCst - accepted} dst cST. Omit minDstPerSrc to sign the honest rate` }];
  }
  return [];
}
