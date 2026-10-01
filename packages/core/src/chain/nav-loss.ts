// A reference whose SHARE PRICE does not report its losses.
//
// A pool whose recipe reads a NAV oracle swaps at the reference vault's reported share price
// (convertToAssets). MetaMorpho v1.1 keeps realized bad debt OUT of that price by design: its
// `_accruedFeeAndAssets` adds a shortfall to a `lostAssets` counter and reports
// `totalAssets() = real assets + lostAssets`, so the price never falls on bad debt. That is
// accrual accounting kept apart from the cash position: the vault records the loss and does not
// charge it to its shareholders.
//
// THE COUNTER IS NOT THE HOLE. `lostAssets` never decreases. The vault's own NatSpec advises
// covering a loss by supplying on behalf of address(1): those shares can never be redeemed, so
// their backing belongs to every other holder. YCSUSDC's 131.38 USDC (booked 2025-11-19) was
// covered the next day by 135 USDC supplied to address(1); read 2026-10-01, those shares are
// worth 140.55 USDC, so the OPEN shortfall is zero and a real share is backed slightly ABOVE the
// reported price. The open shortfall is max(0, lostAssets − value of address(1)'s shares), and
// that — not the counter — is what a cover's underwriter carries.
//
// While a shortfall is open, a NAV-read pool's rate does not move on it, under a liquidity or an
// impairment recipe alike: the holder keeps swapping at the reported price, and the cPT side
// receives shares backed by less than it. A fixed-rate pool reads no feed, and a price-sourced
// pool reads a market price, so this reading applies to NAV-sourced pools only — the caller
// gates on the recipe's source.
//
// TWO LIMITS, stated so the reading is not over-trusted. (1) The counter is storage written when
// the vault accrues; a write-off since the vault's last interaction is not in it yet. (2) Only
// this accounting is recognized: a vault without `lostAssets()` is not thereby proven to report
// every loss — each vault family books losses its own way.
import { parseAbi } from "viem";
import { firstLine, isContractRevert } from "./rpc.ts";

export const navLossAbi = parseAbi([
  "function lostAssets() view returns (uint256)",
  "function totalAssets() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function convertToAssets(uint256) view returns (uint256)",
]);

/** Shares supplied on behalf of this address can never be redeemed (MetaMorpho's own advice for
 *  covering lost assets). */
const UNREDEEMABLE_HOLDER = "0x0000000000000000000000000000000000000001";

export interface UnreportedLoss {
  /** The vault's lost-assets COUNTER (it never decreases), in the vault's asset base units. */
  lostAssets: bigint;
  /** The vault's REPORTED total assets (real assets + lostAssets), same units. */
  totalAssets: bigint;
  /** Value of the shares held by address(1) — assets supplied to cover losses. `null` = not
   *  read (the read failed); not asked, and 0, when the counter is zero. */
  coveredAssets: bigint | null;
  /** max(0, lostAssets − coveredAssets): the shortfall still open. Equals lostAssets when the
   *  cover could not be read (the conservative reading, labeled by `coveredAssets: null`). */
  openShortfall: bigint;
  /** The block every read above was taken at. */
  blockNumber: bigint;
}

/** Three outcomes that must never be confused: the vault HAS the counter (`read`), the vault
 *  has NO such view (`absent` — its `lostAssets()` REVERTED, on positive evidence of a revert:
 *  `isContractRevert`), and NOBODY KNOWS (`unread` — any other failure: a transport fault, a
 *  rate limit, a lagging node that does not have the pinned block). Unknown failures are
 *  `unread`, never `absent`: an outage must not read as a clean bill. */
export type UnreportedLossRead = { status: "read"; loss: UnreportedLoss } | { status: "absent" } | { status: "unread"; reason: string };

type NavLossFn = "lostAssets" | "totalAssets" | "balanceOf" | "convertToAssets";
interface NavLossClient {
  getBlockNumber(): Promise<bigint>;
  readContract(a: { address: `0x${string}`; abi: typeof navLossAbi; functionName: NavLossFn; args?: readonly [] | readonly [`0x${string}`] | readonly [bigint]; blockNumber?: bigint }): Promise<unknown>;
}

/** Read the counter, the reported total, and the cover held by address(1) — all at ONE block,
 *  so a loss or a cover landing mid-read cannot pair a new counter with an old cover. */
export async function readUnreportedLoss(client: NavLossClient, reference: `0x${string}`): Promise<UnreportedLossRead> {
  let blockNumber: bigint;
  try {
    blockNumber = await client.getBlockNumber();
  } catch (err) {
    return { status: "unread", reason: firstLine(err) };
  }
  const read = (functionName: NavLossFn, args?: readonly [`0x${string}`] | readonly [bigint]) => client.readContract({ address: reference, abi: navLossAbi, functionName, blockNumber, ...(args ? { args } : {}) });
  let lost: unknown;
  try {
    lost = await read("lostAssets");
  } catch (err) {
    return isContractRevert(err) ? { status: "absent" } : { status: "unread", reason: firstLine(err) };
  }
  if (typeof lost !== "bigint") return { status: "absent" };
  let total: unknown;
  try {
    total = await read("totalAssets");
  } catch (err) {
    // A vault that answers lostAssets() and reverts on totalAssets() is not one this reading knows.
    return isContractRevert(err) ? { status: "absent" } : { status: "unread", reason: firstLine(err) };
  }
  if (typeof total !== "bigint") return { status: "absent" };
  // A zero counter records no loss: there is nothing to cover and nothing to ask.
  if (lost === 0n) return { status: "read", loss: { lostAssets: 0n, totalAssets: total, coveredAssets: 0n, openShortfall: 0n, blockNumber } };
  let coveredAssets: bigint | null = null;
  try {
    const unredeemable = await read("balanceOf", [UNREDEEMABLE_HOLDER]);
    if (typeof unredeemable === "bigint") {
      const worth = unredeemable === 0n ? 0n : await read("convertToAssets", [unredeemable]);
      if (typeof worth === "bigint") coveredAssets = worth;
    }
  } catch {
    /* the cover stays unread: the counter is reported as open, labeled by the null */
  }
  const openShortfall = coveredAssets === null ? lost : lost > coveredAssets ? lost - coveredAssets : 0n;
  return { status: "read", loss: { lostAssets: lost, totalAssets: total, coveredAssets, openShortfall, blockNumber } };
}

/** Share of the reported assets that is OPEN shortfall, 1e8 = 100%, floor. Zero total = 0. */
export function unreportedLossShare(l: Pick<UnreportedLoss, "openShortfall" | "totalAssets">): bigint {
  return l.totalAssets === 0n ? 0n : (l.openShortfall * 100_000_000n) / l.totalAssets;
}

/** The four states a read loss can be in — the ONE classification the warning and any consumer
 *  share. Order matters: a zero counter is `none` whatever else was or was not read. */
export function unreportedLossState(l: UnreportedLoss): "none" | "cover-unread" | "covered" | "open" {
  if (l.lostAssets === 0n) return "none";
  if (l.coveredAssets === null) return "cover-unread";
  return l.openShortfall === 0n ? "covered" : "open";
}

/** The reading as it rides a result (`data.cover.referenceLoss`), with its unit note. */
export function referenceLossReading(l: UnreportedLoss): { reportedInSharePrice: false; state: ReturnType<typeof unreportedLossState>; lostAssets: string; totalAssets: string; coveredAssets: string | null; openShortfall: string; blockNumber: string; note: string } {
  return {
    reportedInSharePrice: false,
    state: unreportedLossState(l),
    lostAssets: l.lostAssets.toString(),
    totalAssets: l.totalAssets.toString(),
    coveredAssets: l.coveredAssets === null ? null : l.coveredAssets.toString(),
    openShortfall: l.openShortfall.toString(),
    blockNumber: l.blockNumber.toString(),
    note: "base units of the vault's own asset. lostAssets is a counter that never decreases and is written when the vault accrues; coveredAssets is the value of the shares held by address(1) (null = not read); openShortfall = max(0, lostAssets − coveredAssets) is what the share price hides today",
  };
}

/** The disclosure, worded for the side reading it and for the state the loss is in. */
export function unreportedLossWarning(reference: `0x${string}`, l: UnreportedLoss, side: "requester" | "underwriter"): { code: string; message: string } {
  const share = unreportedLossShare(l);
  const pct = `${share / 1_000_000n}.${(share % 1_000_000n).toString().padStart(6, "0")}%`;
  const accounting = `the reference ${reference} keeps realized bad debt OUT of its share price (it exposes lostAssets(), the MetaMorpho v1.1 accounting), and this pool's NAV rate oracle reads the reported price, which does not fall on such a loss`;
  const state = unreportedLossState(l);
  const said = {
    none: "its lost-assets counter reads 0: no loss is recorded today. Any FUTURE bad debt stays out of the share price until someone covers it",
    "cover-unread": `its lost-assets counter reads ${l.lostAssets} of ${l.totalAssets} reported total assets (the vault's asset base units); the cover supplied to address(1) could not be read, so the whole counter is treated as OPEN (${pct})`,
    covered: `its lost-assets counter reads ${l.lostAssets} (the counter never decreases) and the shares held by address(1) are worth ${l.coveredAssets}, so that loss is COVERED: no shortfall is open today. Any FUTURE bad debt stays out of the share price until someone covers it`,
    open: `its lost-assets counter reads ${l.lostAssets}, the shares held by address(1) cover ${l.coveredAssets} of it, and ${l.openShortfall} of ${l.totalAssets} reported total assets is OPEN shortfall (${pct}, the vault's asset base units)`,
  }[state];
  // The underwriter's burden is worded by what was ESTABLISHED: a present shortfall only when
  // one was read as open; a possible one when the cover could not be read; otherwise a condition
  // on a future loss.
  const future = { underwriter: "You would carry a future uncovered loss up to the cover size", requester: "the underwriter would carry a future uncovered loss" };
  const carried = {
    open: { underwriter: "You carry an open shortfall up to the cover size", requester: "the underwriter carries an open shortfall" },
    "cover-unread": { underwriter: "You may carry an open shortfall up to the cover size (the cover was not read)", requester: "the underwriter may carry an open shortfall (the cover was not read)" },
    covered: future,
    none: future,
  }[state][side];
  const consequence = side === "underwriter"
    ? `the pool's rate will not move on an uncovered loss under a liquidity OR an impairment recipe: the holder keeps swapping at the reported price and your cPT side receives shares backed by less than it. ${carried}, and no rate window prices it — price it yourself, or pass`
    : `the pool's rate will not move on an uncovered loss under a liquidity OR an impairment recipe: you can still swap at the reported price while the pool has collateral, and ${carried}, so expect it to be priced or passed. The band of an impairment cover only pays a loss the share price reports`;
  return { code: "reference_loss_unreported", message: `${accounting}; ${said} — ${consequence}. cork_capabilities topic:"cover"` };
}
