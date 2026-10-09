// The valid ranges of a rollover order and of each fill, as the settlers enforce them — rollover
// v0.2.0 (tag fa247696) and v0.1.0-rc.2 run the same rules (read 2026-10-09):
//
//   open (BaseSettler._validateOrderCommon), both settler kinds:
//     - both pools live on the SETTLER's pool manager (CORK_POOL_MANAGER, immutable): their cST
//       must be the order's tokens (Settler__SrcCstNotCanonical / Settler__DstCstNotCanonical);
//     - orderSize is a multiple of the source pool's share quantum, 10^(18 − collateral decimals)
//       (LibPhoenixShareQuantum__OrderSizeNotQuantumAligned);
//     - fillDeadline is strictly before BOTH pools' expiry (Settler__FillDeadlineExceedsPoolExpiry).
//   fill (_validateRolloverBeforeExecution + the mode gates):
//     - 0 < fill ≤ orderSize (Settler__RolloverAmountOutOfBounds);
//     - ExactSettler: fill = orderSize unless allowUnderfill (Settler__ExactFillRequiresFullOrderSize);
//     - PartialSettler: consumed + fill ≤ orderSize, one leg per (BaseFiller, bytes32(filler))
//       slot (Settler__AlreadyFilled);
//     - both: fill and the residual it leaves (orderSize − consumed − fill) are multiples of the
//       quantum (FillAmountNotQuantumAligned / ResidualNotQuantumAligned).
//   the clone, per fill: the unwind returns ≥ minCaReceived (UnwindMintShortfall) and the deposit
//   mints ≥ minSharesOut (UnwindDepositShortfall) — absolute floors on EACH fill, so on a partial
//   order a floor set for the whole order makes every smaller fill revert.
//
// The pure functions below mirror those rules once; the reader fetches the facts they need.
import { isAddressEqual, type PublicClient, zeroAddress } from "viem";
import { erc20Abi, marketAbiFor, poolManagerAbi } from "../chain/abis.ts";
import { resolveGenerations } from "../config-remote.ts";

type Address = `0x${string}`;

/** BaseSettler's immutable pool manager. */
export const settlerPoolManagerAbi = [{ type: "function", name: "CORK_POOL_MANAGER", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }] as const;
/** PoolShare.expiry() — the pool's expiry, read from its cST. */
export const poolShareExpiryAbi = [{ type: "function", name: "expiry", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }] as const;
/** PartialSettler's two accounting views (SettlerTypes, identical on v0.2.0 and rc.2). */
export const partialSettlerAccountingAbi = [
  {
    type: "function",
    name: "rolloverAccountingOf",
    stateMutability: "view",
    inputs: [{ name: "orderDigest", type: "bytes32" }],
    outputs: [{ name: "accounting", type: "tuple", components: [{ name: "participantSlotCount", type: "uint32" }, { name: "dstCstEscrowed", type: "uint256" }, { name: "srcCstConsumed", type: "uint256" }] }],
  },
  {
    type: "function",
    name: "fillerSlotAccountingOf",
    stateMutability: "view",
    inputs: [{ name: "orderDigest", type: "bytes32" }, { name: "filler", type: "address" }, { name: "subFiller", type: "bytes32" }],
    outputs: [
      {
        name: "accounting",
        type: "tuple",
        components: [
          { name: "rollover", type: "tuple", components: [{ name: "dstCstProduced", type: "uint256" }, { name: "srcCstProvided", type: "uint256" }, { name: "filledAt", type: "uint64" }, { name: "premiumFired", type: "bool" }] },
          { name: "settlementDestination", type: "address" },
          { name: "settled", type: "bool" },
        ],
      },
    ],
  },
] as const;

/** LibPhoenixShareQuantum: the source share quantum for a collateral with `decimals`. */
export function shareQuantum(decimals: number): bigint {
  if (decimals > 18) throw new RangeError(`collateral decimals ${decimals} exceed 18 (LibPhoenixShareQuantum__UnsupportedCollateralDecimals)`);
  return 10n ** BigInt(18 - decimals);
}

/** LibPhoenixShareQuantum.requireFillAndResidualQuantumAligned, as a message or null. */
export function fillQuantumViolation(fill: bigint, residual: bigint, quantum: bigint): string | null {
  if (fill % quantum !== 0n) return `the fill ${fill} is not a multiple of the source share quantum ${quantum} — the settler reverts LibPhoenixShareQuantum__FillAmountNotQuantumAligned`;
  if (residual % quantum !== 0n) return `the fill ${fill} leaves ${residual} of the order, which is not a multiple of the source share quantum ${quantum} — the settler reverts LibPhoenixShareQuantum__ResidualNotQuantumAligned`;
  return null;
}

/** What the settler's open-time checks need, read from the chain. */
export interface RollPoolFacts {
  /** The settler's own pool manager (CORK_POOL_MANAGER). */
  poolManager: Address;
  /** collateral and quantum are null when the manager's wire is unknown to this build. */
  src: { cst: Address; expiry: bigint | null; collateral: Address | null; quantum: bigint | null };
  /** null when the destination pool does not exist (yet: a just-in-time order creates it). */
  dst: { cst: Address; expiry: bigint | null; collateral: Address | null } | null;
}

/** Read the facts the settler checks at open, from the SETTLER's pool manager. Throws on a read
 *  failure; an absent pool is a zero cST, as Phoenix answers. */
export async function readRollPools(client: PublicClient, p: { chainId: number; settler: Address; srcPoolId: Address; dstPoolId: Address; atBlock?: bigint }): Promise<RollPoolFacts> {
  const at = p.atBlock !== undefined ? { blockNumber: p.atBlock } : {};
  const poolManager = (await client.readContract({ address: p.settler, abi: settlerPoolManagerAbi, functionName: "CORK_POOL_MANAGER", ...at })) as Address;
  const [srcShares, dstShares] = await Promise.all([
    client.readContract({ address: poolManager, abi: poolManagerAbi, functionName: "shares", args: [p.srcPoolId], ...at }) as Promise<readonly [Address, Address]>,
    client.readContract({ address: poolManager, abi: poolManagerAbi, functionName: "shares", args: [p.dstPoolId], ...at }) as Promise<readonly [Address, Address]>,
  ]);
  const expiryOf = async (cst: Address) => (isAddressEqual(cst, zeroAddress) ? null : ((await client.readContract({ address: cst, abi: poolShareExpiryAbi, functionName: "expiry", ...at })) as bigint));
  // The quantum needs the source collateral, read through the market() ABI of the manager's
  // declared wire; a manager no configured generation names has no wire, and no quantum here.
  const { generations } = await resolveGenerations(p.chainId);
  const wire = generations.find((g) => g.phoenix !== undefined && isAddressEqual(g.phoenix.poolManager as Address, poolManager))?.phoenix?.wire;
  const collateralOf = async (cst: Address, poolId: Address) =>
    wire === undefined || isAddressEqual(cst, zeroAddress) ? null : ((await client.readContract({ address: poolManager, abi: marketAbiFor(wire), functionName: "market", args: [poolId], ...at })) as { collateralAsset: Address }).collateralAsset;
  const [srcCollateral, dstCollateral, srcExpiry, dstExpiry] = await Promise.all([collateralOf(srcShares[1], p.srcPoolId), collateralOf(dstShares[1], p.dstPoolId), expiryOf(srcShares[1]), expiryOf(dstShares[1])]);
  const quantum = srcCollateral === null ? null : shareQuantum(Number(await client.readContract({ address: srcCollateral, abi: erc20Abi, functionName: "decimals", ...at })));
  return {
    poolManager,
    src: { cst: srcShares[1], expiry: srcExpiry, collateral: srcCollateral, quantum },
    dst: isAddressEqual(dstShares[1], zeroAddress) ? null : { cst: dstShares[1], expiry: dstExpiry, collateral: dstCollateral },
  };
}

/** The settler's open-time rules against an order's terms: the first one the order breaks, as
 *  the settler error and a message, or null. `jit` marks an order whose destination a
 *  just-in-time fill creates: BaseFiller creates the pool and opens the order in the same call, so
 *  a destination that does not exist yet is admitted, at the instruction's expiry when known. */
export function openRangeViolation(
  f: RollPoolFacts,
  t: { srcCstToken: Address; dstCstToken: Address; orderSize: bigint; fillDeadline: bigint; jit?: { expiry: bigint | null } },
): { settlerError: string; message: string } | null {
  if (!isAddressEqual(f.src.cst, t.srcCstToken)) {
    return { settlerError: "Settler__SrcCstNotCanonical", message: isAddressEqual(f.src.cst, zeroAddress) ? `the source pool is unknown to the settler's pool manager ${f.poolManager} — a settler rolls only pools on its own pool manager` : `the source pool's cST on the settler's pool manager ${f.poolManager} is ${f.src.cst}, not the order's srcCstToken ${t.srcCstToken}` };
  }
  if (f.dst === null && t.jit === undefined) {
    return { settlerError: "Settler__DstCstNotCanonical", message: `the destination pool is unknown to the settler's pool manager ${f.poolManager}, and the order commits to no just-in-time market that would create it` };
  }
  if (f.dst !== null && !isAddressEqual(f.dst.cst, t.dstCstToken)) {
    return { settlerError: "Settler__DstCstNotCanonical", message: `the destination pool's cST on the settler's pool manager ${f.poolManager} is ${f.dst.cst}, not the order's dstCstToken ${t.dstCstToken}` };
  }
  if (f.src.quantum !== null && t.orderSize % f.src.quantum !== 0n) {
    return { settlerError: "LibPhoenixShareQuantum__OrderSizeNotQuantumAligned", message: `orderSize ${t.orderSize} is not a multiple of the source share quantum ${f.src.quantum}` };
  }
  const dstExpiry = f.dst?.expiry ?? t.jit?.expiry ?? null;
  const firstExpiry = [f.src.expiry, dstExpiry].filter((e): e is bigint => e !== null).reduce<bigint | null>((m, e) => (m === null || e < m ? e : m), null);
  if (firstExpiry !== null && t.fillDeadline >= firstExpiry) {
    return { settlerError: "Settler__FillDeadlineExceedsPoolExpiry", message: `fillDeadline ${t.fillDeadline} is not strictly before both pools' expiry (source ${f.src.expiry ?? "unread"}, destination ${dstExpiry ?? "unread"})` };
  }
  return null;
}

/** The fill sizes the settler admits, as the agent-facing hint `data.fillRange`. */
export interface FillRange {
  kind: "exact" | "exact-underfill" | "partial";
  /** src cST the order still accepts: orderSize − consumed (consumed is read from the
   *  PartialSettler; an open exact order has consumed nothing). null when it was not read. */
  remaining: string | null;
  /** The smallest and largest admissible fill, and the step between admissible sizes; an exact
   *  order without underfill admits exactly one size. null where an input was not read. */
  min: string | null;
  max: string | null;
  step: string | null;
  /** The smallest fill that clears the holder's per-fill floors (minCaReceived, minSharesOut),
   *  derived from the previews; null when they could not be read or no floor is set. */
  minClearingHolderFloors: string | null;
}

export function fillRange(p: { kind: FillRange["kind"]; orderSize: bigint; consumed: bigint | null; quantum: bigint | null; minClearingHolderFloors: bigint | null }): FillRange {
  const remaining = p.consumed === null ? null : (p.orderSize - p.consumed).toString();
  const floors = p.minClearingHolderFloors?.toString() ?? null;
  if (p.kind === "exact") return { kind: "exact", remaining, min: remaining, max: remaining, step: null, minClearingHolderFloors: floors };
  return { kind: p.kind, remaining, min: p.quantum?.toString() ?? null, max: remaining, step: p.quantum?.toString() ?? null, minClearingHolderFloors: floors };
}

/** The smallest quantum-aligned fill whose unwind and deposit clear the holder's per-fill floors,
 *  from one previewed fill (`srcBurned` → `collateralOut` → `expectedDstCst`, linear in the fill
 *  because Phoenix converts 1:1). null when no floor is set. */
export function minFillClearingFloors(p: { minCaReceived: bigint; minSharesOut: bigint; srcBurned: bigint; collateralOut: bigint; expectedDstCst: bigint; quantum: bigint }): bigint | null {
  if (p.minCaReceived === 0n && p.minSharesOut === 0n) return null;
  const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;
  const forCa = ceilDiv(p.minCaReceived * p.srcBurned, p.collateralOut);
  const forShares = ceilDiv(p.minSharesOut * p.srcBurned, p.expectedDstCst);
  const need = forCa > forShares ? forCa : forShares;
  return ceilDiv(need, p.quantum) * p.quantum;
}

/** The smallest fill that clears the holder's floors when the roll stays on one collateral:
 *  Phoenix returns fill / quantum collateral and mints one dst share per src share, so one
 *  quantum previews as (quantum → 1 collateral unit → quantum shares). null across collaterals,
 *  where the conversion a mid-roll hook makes is not known here. */
export function sameCollateralMinFill(f: RollPoolFacts, floors: { minCaReceived: bigint; minSharesOut: bigint }): bigint | null {
  if (f.src.quantum === null || f.src.collateral === null || f.dst?.collateral == null || !isAddressEqual(f.src.collateral, f.dst.collateral)) return null;
  return minFillClearingFloors({ ...floors, srcBurned: f.src.quantum, collateralOut: 1n, expectedDstCst: f.src.quantum, quantum: f.src.quantum });
}
