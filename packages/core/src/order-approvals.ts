// Token-approval requirements for the 1inch LOP v4 order lifecycle — WHO must grant WHAT to
// WHOM before an order can rest fillable or a fill can broadcast, with the unsigned approval
// transaction payload for each grant [K1: prepared, never signed here].
//
// Ground truth (verified against the deployed LOP v4 source, OrderMixin.sol):
//  - Default maker pull: `transferFrom(maker → taker)` on the maker asset — needs a plain ERC-20
//    allowance maker → LOP, in place BEFORE the fill (a resting order without it looks fillable
//    but reverts TransferFromMakerToTakerFailed).
//  - makerTraits bit 248 (USE_PERMIT2): the pull becomes `IPermit2.transferFrom` — needs TWO
//    layers: an ERC-20 allowance maker → Permit2, AND a Permit2 internal allowance
//    (maker, makerAsset, spender = LOP) with amount ≤ uint160 and a LIVE expiration.
//  - Taker pull mirrors it (takerTraits bit 252 for Permit2; this codebase deliberately builds
//    direct-approve taker fills — a hedger's fill is one-shot, one exact allowance to the LOP).
//  - The extension makerPermit executes ONLY on the EOA fill path (_fillOrder); a CONTRACT maker
//    (ERC-1271, e.g. a Safe) gets NO permit execution — it must hold a standing allowance.
//  - JIT orders: the cST side has no code until the fill creates the pool, so an approve cannot
//    exist beforehand — the pull is covered by an ERC-2612 permit embedded in the extension
//    (EOAs only); and a JIT MINT additionally pulls collateral from the minting party into the
//    Cork JIT adapter, which needs its own ERC-20 allowance.
import { encodeFunctionData, parseAbi } from "viem";
import { erc20Abi, permit2AllowanceAbi } from "./chain/abis.ts";

/** Canonical Uniswap Permit2 — the same CREATE2 address on every chain this tool serves. */
export const PERMIT2_ADDRESS = "0x000000000022D473030F116dDEE9F6B43aC78BA3" as const;

/** Permit2 expirations are uint48; this value means "never expires" by Permit2 convention. */
export const PERMIT2_EXPIRATION_NEVER = (1n << 48n) - 1n;

const UINT160_MAX = (1n << 160n) - 1n;

const erc20ApproveAbi = parseAbi(["function approve(address spender, uint256 amount)"]);
const permit2ApproveAbi = parseAbi(["function approve(address token, address spender, uint160 amount, uint48 expiration)"]);

export interface UnsignedApprovalTx {
  /** The contract to send the tx to: the TOKEN for erc20-approve, PERMIT2 for permit2-approve. */
  to: `0x${string}`;
  calldata: `0x${string}`;
  value: "0";
}

export interface ApprovalRequirement {
  role: "maker" | "taker";
  /** When the grant must exist. Maker allowances belong BEFORE the order rests — a resting
   *  order without them looks fillable but reverts; permits are signed WITH the order. */
  stage: "before-listing" | "before-fill" | "with-order-signature";
  /** The account that must grant (and, for a tx, send it — allowances key on msg.sender). */
  holder: `0x${string}`;
  token: `0x${string}`;
  tokenRole: string;
  /** The party being authorized to pull. For permit2-approve this is the Permit2 INTERNAL
   *  spender (the LOP); the tx itself goes to the Permit2 contract (unsignedTx.to). */
  spender: `0x${string}`;
  spenderRole: "1inch LOP" | "Permit2" | "Cork JIT adapter" | "ForSelf adapter";
  mechanism: "erc20-approve" | "permit2-approve" | "erc2612-permit";
  /** Required minimum in the token's base units; null = size via simulation (JIT mint funding). */
  amount: string | null;
  kind: "exact" | "cap";
  /** Which wallet kinds can satisfy it. Approval TXS work for EOAs and contract wallets alike
   *  (a contract wallet executes the same payload through its own flow); an ERC-2612 permit
   *  needs an ECDSA signature, so it is EOA-only. */
  wallets: "eoa+contract" | "eoa-only";
  note: string;
  /** The unsigned grant tx [K1]; null for erc2612-permit (a signature, not a transaction). */
  unsignedTx: UnsignedApprovalTx | null;
  /** Best-effort chain annotation (absent = not checked / not checkable). */
  satisfied?: boolean;
  currentAllowance?: string;
  /** permit2-approve only: the live Permit2 expiration (unix seconds; 0 = already expired). */
  currentExpiration?: number;
}

export function erc20ApproveTx(token: `0x${string}`, spender: `0x${string}`, amount: bigint): UnsignedApprovalTx {
  return { to: token, calldata: encodeFunctionData({ abi: erc20ApproveAbi, functionName: "approve", args: [spender, amount] }), value: "0" };
}

export function permit2ApproveTx(token: `0x${string}`, spender: `0x${string}`, amount: bigint, expiration: bigint): UnsignedApprovalTx {
  return { to: PERMIT2_ADDRESS, calldata: encodeFunctionData({ abi: permit2ApproveAbi, functionName: "approve", args: [token, spender, amount, Number(expiration)] }), value: "0" };
}

const lc = (a: string) => a.toLowerCase();

/** The maker's (underwriter's) grants. Every allowance must exist BEFORE the order rests —
 *  otherwise the order sits on the book fillable-looking and every fill attempt reverts. */
export function makerApprovalRequirements(a: {
  maker: `0x${string}`;
  makerAsset: `0x${string}`;
  makingAmount: bigint;
  lop: `0x${string}`;
  usePermit2: boolean;
  /** Absolute unix seconds from the makerTraits expiry slot; 0/undefined = no expiry. */
  orderExpiry?: bigint;
  jit?: { adapter: `0x${string}`; collateralAsset: `0x${string}`; enableJitMint: boolean; predictedCorkSwapToken?: `0x${string}` | null };
}): ApprovalRequirement[] {
  const out: ApprovalRequirement[] = [];
  const predictedCst = a.jit?.predictedCorkSwapToken;
  const makerAssetIsJitCst = predictedCst != null && lc(predictedCst) === lc(a.makerAsset);
  const amount = a.makingAmount.toString();

  if (makerAssetIsJitCst) {
    out.push({
      role: "maker", stage: "with-order-signature", holder: a.maker, token: a.makerAsset,
      tokenRole: "makerAsset (predicted cST)", spender: a.lop, spenderRole: "1inch LOP",
      mechanism: "erc2612-permit", amount, kind: "exact", wallets: "eoa-only",
      note: "the cST exists only after the fill creates the pool, so a prior approve is impossible — sign an ERC-2612 permit (owner = maker, spender = the LOP, value >= makingAmount) and pass it in jitMarket.permits. A CONTRACT maker cannot produce this ECDSA signature; it must approve the cST to the LOP once the pool exists, or grant it from a pre-interaction.",
      unsignedTx: null,
    });
  } else if (a.usePermit2) {
    const overCap = a.makingAmount > UINT160_MAX;
    const expiration = a.orderExpiry !== undefined && a.orderExpiry > 0n ? a.orderExpiry : PERMIT2_EXPIRATION_NEVER;
    out.push({
      role: "maker", stage: "before-listing", holder: a.maker, token: a.makerAsset,
      tokenRole: "makerAsset", spender: PERMIT2_ADDRESS, spenderRole: "Permit2",
      mechanism: "erc20-approve", amount, kind: "exact", wallets: "eoa+contract",
      note: "Permit2 layer 1 of 2: the ERC-20 allowance that lets the Permit2 contract move this token. Holders commonly grant it unlimited once per token — Permit2's own layer then scopes amount and expiry per spender.",
      unsignedTx: erc20ApproveTx(a.makerAsset, PERMIT2_ADDRESS, a.makingAmount),
    });
    out.push({
      role: "maker", stage: "before-listing", holder: a.maker, token: a.makerAsset,
      tokenRole: "makerAsset", spender: a.lop, spenderRole: "1inch LOP",
      mechanism: "permit2-approve", amount, kind: "exact", wallets: "eoa+contract",
      note: `Permit2 layer 2 of 2: the internal allowance (maker, makerAsset, spender = the LOP) the fill's IPermit2.transferFrom consumes. Amount is capped at uint160 and the expiration must be LIVE at fill time${a.orderExpiry !== undefined && a.orderExpiry > 0n ? " (set here to the order's own expiry)" : " (no order expiry — set here to Permit2's never-expires sentinel; tighten it if you prefer)"}.${overCap ? " WARNING: makingAmount exceeds uint160 — the LOP reverts Permit2TransferAmountTooHigh on this order; use a direct approve instead." : ""}`,
      unsignedTx: permit2ApproveTx(a.makerAsset, a.lop, overCap ? UINT160_MAX : a.makingAmount, expiration),
    });
  } else {
    out.push({
      role: "maker", stage: "before-listing", holder: a.maker, token: a.makerAsset,
      tokenRole: "makerAsset", spender: a.lop, spenderRole: "1inch LOP",
      mechanism: "erc20-approve", amount, kind: "exact", wallets: "eoa+contract",
      note: "the fill pulls the maker asset with plain transferFrom(maker → taker) — the LOP needs this allowance at FILL time, so grant it before the order rests. Works identically from a contract wallet (it executes the same payload).",
      unsignedTx: erc20ApproveTx(a.makerAsset, a.lop, a.makingAmount),
    });
  }

  if (a.jit?.enableJitMint) {
    out.push({
      role: "maker", stage: "before-listing", holder: a.maker, token: a.jit.collateralAsset,
      tokenRole: "collateral (JIT mint funding)", spender: a.jit.adapter, spenderRole: "Cork JIT adapter",
      mechanism: "erc20-approve", amount: null, kind: "cap", wallets: "eoa+contract",
      note: "enableJitMint: the fill's pre-interaction mints the cST funded by the MAKER's collateral — the JIT adapter pulls it against this allowance. The exact cost depends on the pool rate at fill time; pick a cap that covers minting the full makingAmount of cST, build the tx with cork_prepare_phoenix authority-onboard (this token, this spender, your amount), and confirm with cork_track simulate.",
      unsignedTx: null,
    });
  }
  return out;
}

/** The taker's (hedger's) grants — needed before broadcasting the fill transaction. */
export function takerApprovalRequirements(a: {
  taker: `0x${string}`;
  takerAsset: `0x${string}`;
  /** The signed-ratio cap the fill can pull (for an auction row: the curve CEILING). */
  requiredTakingAmount: bigint;
  lop: `0x${string}`;
  forSelfAdapter?: `0x${string}`;
  auction?: boolean;
  jit?: { adapter: `0x${string}`; collateralAsset: `0x${string}`; predictedCorkSwapToken?: `0x${string}` | null };
}): ApprovalRequirement[] {
  const out: ApprovalRequirement[] = [];
  const predictedCst = a.jit?.predictedCorkSwapToken;
  const takerAssetIsJitCst = predictedCst != null && lc(predictedCst) === lc(a.takerAsset);
  const amount = a.requiredTakingAmount.toString();
  const capNote = a.auction
    ? "cap = the auction curve's CEILING (the cap must sit above the current decayed price for the whole window, or the fill reverts mid-decay); the fill consumes only the current price"
    : "cap = the signed-ratio taking amount; the fill consumes at most this much";

  if (takerAssetIsJitCst) {
    out.push({
      role: "taker", stage: "with-order-signature", holder: a.taker, token: a.takerAsset,
      tokenRole: "takerAsset (predicted cST)", spender: a.lop, spenderRole: "1inch LOP",
      mechanism: "erc2612-permit", amount, kind: "exact", wallets: "eoa-only",
      note: "the taker delivers a cST that is minted DURING the fill — sign an ERC-2612 permit (owner = taker, spender = the LOP, value >= the cST amount) and pass it in jitMarket.permits so the LOP can pull the just-minted token. A CONTRACT taker cannot produce this signature; it needs a pre-existing allowance path instead.",
      unsignedTx: null,
    });
  } else if (a.forSelfAdapter) {
    out.push({
      role: "taker", stage: "before-fill", holder: a.taker, token: a.takerAsset,
      tokenRole: "order takerAsset", spender: a.forSelfAdapter, spenderRole: "ForSelf adapter",
      mechanism: "erc20-approve", amount, kind: "cap", wallets: "eoa+contract",
      note: `ForSelf mode: every allowance goes to the ADAPTER, never the LOP — it pulls up to the cap and sweeps the unspent remainder back in the same transaction. ${capNote}.`,
      unsignedTx: erc20ApproveTx(a.takerAsset, a.forSelfAdapter, a.requiredTakingAmount),
    });
  } else {
    out.push({
      role: "taker", stage: "before-fill", holder: a.taker, token: a.takerAsset,
      tokenRole: "takerAsset", spender: a.lop, spenderRole: "1inch LOP",
      mechanism: "erc20-approve", amount, kind: "cap", wallets: "eoa+contract",
      note: `the fill pulls the taker asset from msg.sender with plain transferFrom — one exact allowance to the LOP is the simplest safe grant for a one-shot fill. ${capNote}.`,
      unsignedTx: erc20ApproveTx(a.takerAsset, a.lop, a.requiredTakingAmount),
    });
  }

  if (a.jit) {
    out.push({
      role: "taker", stage: "before-fill", holder: a.taker, token: a.jit.collateralAsset,
      tokenRole: "collateral (JIT mint funding)", spender: a.jit.adapter, spenderRole: "Cork JIT adapter",
      mechanism: "erc20-approve", amount: null, kind: "cap", wallets: "eoa+contract",
      note: "the taker interaction mints the cST funded by the TAKER's collateral — the JIT adapter pulls it against this allowance. The exact cost depends on the pool rate at fill time; pick a cap that covers the mint, build the tx with cork_prepare_phoenix authority-onboard (this token, this spender, your amount), and confirm with cork_track simulate.",
      unsignedTx: null,
    });
  }
  return out;
}

/** Best-effort chain annotation: read each grant's CURRENT state and mark it satisfied or not.
 *  Every read degrades to silence (the entry just stays unannotated) — this may only add
 *  information, never block the artifact. erc2612-permit entries are never annotated (the token
 *  may not exist yet, and a permit is not a stored allowance). */
export async function annotateApprovalStatus(
  client: { readContract: (args: never) => Promise<unknown> },
  args: { entries: ApprovalRequirement[]; nowSeconds: bigint; atBlock?: bigint },
): Promise<ApprovalRequirement[]> {
  const blockOpt = args.atBlock !== undefined ? { blockNumber: args.atBlock } : {};
  const read = (params: object) => (client.readContract as (p: object) => Promise<unknown>)({ ...params, ...blockOpt });
  return Promise.all(
    args.entries.map(async (e) => {
      try {
        if (e.mechanism === "erc20-approve") {
          const current = (await read({ address: e.token, abi: erc20Abi, functionName: "allowance", args: [e.holder, e.spender] })) as bigint;
          return { ...e, currentAllowance: current.toString(), ...(e.amount !== null ? { satisfied: current >= BigInt(e.amount) } : {}) };
        }
        if (e.mechanism === "permit2-approve") {
          const [amt, expiration] = (await read({ address: PERMIT2_ADDRESS, abi: permit2AllowanceAbi, functionName: "allowance", args: [e.holder, e.token, e.spender] })) as readonly [bigint, number, number];
          // Same rule as account-state: spending is allowed AT the boundary second; expiration 0
          // is always expired.
          const live = args.nowSeconds <= BigInt(expiration);
          return { ...e, currentAllowance: amt.toString(), currentExpiration: expiration, ...(e.amount !== null ? { satisfied: live && amt >= BigInt(e.amount) } : {}) };
        }
        return e;
      } catch {
        return e;
      }
    }),
  );
}
