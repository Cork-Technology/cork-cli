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
// The probe is one optional view: a vault that answers `lostAssets()` keeps losses out of its
// share price. A vault that does not answer it is NOT thereby proven to report every loss —
// each vault family books losses its own way — so absence stays silent, never a clean bill.
import { parseAbi } from "viem";

export const navLossAbi = parseAbi(["function lostAssets() view returns (uint256)", "function totalAssets() view returns (uint256)"]);

export interface UnreportedLoss {
  /** Realized bad debt the share price does not reflect, in the vault's asset base units. */
  lostAssets: bigint;
  /** The vault's REPORTED total assets (real assets + lostAssets), same units. */
  totalAssets: bigint;
}

type NavLossClient = { readContract(a: { address: `0x${string}`; abi: typeof navLossAbi; functionName: "lostAssets" | "totalAssets" }): Promise<unknown> };

/** Read the unreported-loss accounting of a reference vault. `undefined` = the vault exposes no
 *  `lostAssets()` (or the read failed): nothing is known, nothing is claimed. */
export async function readUnreportedLoss(client: NavLossClient, reference: `0x${string}`): Promise<UnreportedLoss | undefined> {
  try {
    const [lost, total] = await Promise.all([
      client.readContract({ address: reference, abi: navLossAbi, functionName: "lostAssets" }),
      client.readContract({ address: reference, abi: navLossAbi, functionName: "totalAssets" }),
    ]);
    if (typeof lost !== "bigint" || typeof total !== "bigint") return undefined;
    return { lostAssets: lost, totalAssets: total };
  } catch {
    return undefined;
  }
}

/** Share of the reported assets that is unreported loss, in basis points of a basis point
 *  (1e8 = 100%), floor. Zero total = 0. */
export function unreportedLossShare(l: UnreportedLoss): bigint {
  return l.totalAssets === 0n ? 0n : (l.lostAssets * 100_000_000n) / l.totalAssets;
}

/** The disclosure, worded for the side reading it. */
export function unreportedLossWarning(reference: `0x${string}`, l: UnreportedLoss, side: "requester" | "underwriter"): { code: string; message: string } {
  const share = unreportedLossShare(l);
  const pct = `${share / 1_000_000n}.${(share % 1_000_000n).toString().padStart(6, "0")}%`;
  const fact = `the reference ${reference} keeps realized bad debt OUT of its share price (it exposes lostAssets(), the MetaMorpho v1.1 accounting): lostAssets is ${l.lostAssets} of ${l.totalAssets} reported total assets (${pct}, the vault's asset base units), and the NAV rate oracle reads the reported price, which does not fall on such a loss`;
  const consequence = side === "underwriter"
    ? "the pool's rate will not move on that loss under a liquidity OR an impairment recipe: the holder keeps swapping at the reported price and your cPT side receives shares backed by less than it. You carry the hidden shortfall up to the cover size, and no rate window prices it — price it yourself, or pass"
    : "the pool's rate will not move on that loss under a liquidity OR an impairment recipe: you can still swap at the reported price while the pool has collateral, and the underwriter carries the hidden shortfall, so expect it to be priced or passed. The band of an impairment cover only pays a loss the share price reports";
  return { code: "reference_loss_unreported", message: `${fact} — ${consequence}. cork_capabilities topic:"cover"` };
}
