// A reference vault whose share price does NOT report its losses.
//
// MetaMorpho v1.1 (`_accruedFeeAndAssets`): when the real supplied assets fall below the last
// accounted total — a market wrote off bad debt — the gap is added to `lostAssets`, and
// `totalAssets()` is reported as real assets + lostAssets. The share price (what a NAV rate
// oracle reads through `convertToAssets`) therefore never falls on bad debt, and `lostAssets`
// never goes down. Withdrawals keep paying at the reported price until liquidity runs out, so
// the shortfall falls on whoever exits last.
//
// What that does to a Cork cover, whichever recipe it uses (2026-10-01, verified on Base:
// YCSUSDC `lostAssets()` = 131.38 USDC of 701,674, sparkUSDC 0): the pool's rate reads the
// REPORTED price and does not move, so the cST holder still swaps at the reported price while
// the pool has collateral — and the cPT side receives shares backed by less than that price. The
// hidden shortfall is carried by the UNDERWRITER, unpriced, in a liquidity pool and in an
// impairment pool alike. Only a fixed rate does not read the feed.
//
// THE COUNTER IS NOT THE HOLE. `lostAssets` never decreases. The vault's own NatSpec advises
// covering a loss by supplying on behalf of address(1): those shares can never be redeemed, so
// their backing belongs to every other holder. YCSUSDC's 131.38 USDC (booked 2025-11-19) was
// covered the next day by 135 USDC supplied to address(1); read 2026-10-01, those shares are
// worth 140.55 USDC, so the OPEN shortfall is zero and a real share is backed slightly ABOVE the
// reported price. The open shortfall is therefore max(0, lostAssets − value of address(1)'s
// shares), and that — not the counter — is what a cover's underwriter carries.
//
// The probe is one optional view: a vault that answers `lostAssets()` keeps losses out of its
// share price. A vault that does not answer it is NOT thereby proven to report every loss —
// each vault family books losses its own way — so absence stays silent, never a clean bill.
import { parseAbi } from "viem";

export const navLossAbi = parseAbi([
  "function lostAssets() view returns (uint256)",
  "function totalAssets() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function convertToAssets(uint256) view returns (uint256)",
]);

/** Shares supplied on behalf of this address can never be redeemed (MetaMorpho's own advice for
 *  covering lost assets). */
export const UNREDEEMABLE_HOLDER = "0x0000000000000000000000000000000000000001" as const;

export interface UnreportedLoss {
  /** The vault's lost-assets COUNTER (it never decreases), in the vault's asset base units. */
  lostAssets: bigint;
  /** The vault's REPORTED total assets (real assets + lostAssets), same units. */
  totalAssets: bigint;
  /** Value of the shares held by address(1) — assets donated to cover losses. `null` = not read. */
  coveredAssets: bigint | null;
  /** max(0, lostAssets − coveredAssets): the shortfall still open. Equals lostAssets when the
   *  cover could not be read (the conservative reading, labeled by `coveredAssets: null`). */
  openShortfall: bigint;
}

type NavLossFn = "lostAssets" | "totalAssets" | "balanceOf" | "convertToAssets";
type NavLossClient = { readContract(a: { address: `0x${string}`; abi: typeof navLossAbi; functionName: NavLossFn; args?: readonly [] | readonly [`0x${string}`] | readonly [bigint] }): Promise<unknown> };

/** Read the unreported-loss accounting of a reference vault. `undefined` = the vault exposes no
 *  `lostAssets()` (or the read failed): nothing is known, nothing is claimed. */
export async function readUnreportedLoss(client: NavLossClient, reference: `0x${string}`): Promise<UnreportedLoss | undefined> {
  try {
    const [lost, total] = await Promise.all([
      client.readContract({ address: reference, abi: navLossAbi, functionName: "lostAssets" }),
      client.readContract({ address: reference, abi: navLossAbi, functionName: "totalAssets" }),
    ]);
    if (typeof lost !== "bigint" || typeof total !== "bigint") return undefined;
    let coveredAssets: bigint | null = null;
    try {
      const dead = await client.readContract({ address: reference, abi: navLossAbi, functionName: "balanceOf", args: [UNREDEEMABLE_HOLDER] });
      if (typeof dead === "bigint") {
        const worth = dead === 0n ? 0n : await client.readContract({ address: reference, abi: navLossAbi, functionName: "convertToAssets", args: [dead] });
        if (typeof worth === "bigint") coveredAssets = worth;
      }
    } catch {
      /* the cover stays unread: the counter is reported as open, labeled */
    }
    const openShortfall = coveredAssets === null ? lost : lost > coveredAssets ? lost - coveredAssets : 0n;
    return { lostAssets: lost, totalAssets: total, coveredAssets, openShortfall };
  } catch {
    return undefined;
  }
}

/** Share of the reported assets that is OPEN shortfall, 1e8 = 100%, floor. Zero total = 0. */
export function unreportedLossShare(l: Pick<UnreportedLoss, "openShortfall" | "totalAssets">): bigint {
  return l.totalAssets === 0n ? 0n : (l.openShortfall * 100_000_000n) / l.totalAssets;
}

/** The disclosure, worded for the side reading it. Four states: no loss recorded, a counter
 *  fully covered through address(1), an open shortfall, and a cover that could not be read. */
export function unreportedLossWarning(reference: `0x${string}`, l: UnreportedLoss, side: "requester" | "underwriter"): { code: string; message: string } {
  const share = unreportedLossShare(l);
  const pct = `${share / 1_000_000n}.${(share % 1_000_000n).toString().padStart(6, "0")}%`;
  const accounting = `the reference ${reference} keeps realized bad debt OUT of its share price (it exposes lostAssets(), the MetaMorpho v1.1 accounting), and the NAV rate oracle reads the reported price, which does not fall on such a loss`;
  const state = l.coveredAssets === null
    ? `its lost-assets counter reads ${l.lostAssets} of ${l.totalAssets} reported total assets (the vault's asset base units); the cover supplied to address(1) could not be read, so the whole counter is treated as OPEN (${pct})`
    : l.lostAssets === 0n
      ? "its lost-assets counter reads 0: no loss is recorded today. Any FUTURE bad debt stays out of the share price until someone covers it"
    : l.openShortfall === 0n
      ? `its lost-assets counter reads ${l.lostAssets} (the counter never decreases) and the shares held by address(1) are worth ${l.coveredAssets}, so that loss is COVERED: no shortfall is open today. Any FUTURE bad debt stays out of the share price until someone covers it`
      : `its lost-assets counter reads ${l.lostAssets}, the shares held by address(1) cover ${l.coveredAssets} of it, and ${l.openShortfall} of ${l.totalAssets} reported total assets is OPEN shortfall (${pct}, the vault's asset base units)`;
  // With nothing open, the consequence is a condition on a FUTURE loss, never a present claim.
  const open = l.openShortfall > 0n;
  const consequence = side === "underwriter"
    ? `the pool's rate will not move on an uncovered loss under a liquidity OR an impairment recipe: the holder keeps swapping at the reported price and your cPT side receives shares backed by less than it. ${open ? "You carry an open shortfall up to the cover size" : "You would carry a future uncovered loss up to the cover size"}, and no rate window prices it — price it yourself, or pass`
    : `the pool's rate will not move on an uncovered loss under a liquidity OR an impairment recipe: you can still swap at the reported price while the pool has collateral, and ${open ? "the underwriter carries an open shortfall" : "the underwriter would carry a future uncovered loss"}, so expect it to be priced or passed. The band of an impairment cover only pays a loss the share price reports`;
  return { code: "reference_loss_unreported", message: `${accounting}; ${state} — ${consequence}. cork_capabilities topic:"cover"` };
}
