// Maker-side readiness of a RESTING order: can the LOP actually pull the maker asset when a
// taker fills it? A signed, live, authentic order can still be structurally un-fillable — the
// incident class (Base, 2026-09-11): a CONTRACT maker rested a JIT order on a not-yet-created
// cST; the embedded ERC-2612 permit path is ECDSA-only and a contract cannot hold an allowance
// on a code-less token, so the book ranked #1 an order every fill of which reverts
// TransferFromMakerToTakerFailed.
//
// Worse than the revert class: the LOP's transfer helper (`_callTransferFromWithSuffix`) counts
// a call to a CODE-LESS address with empty returndata as SUCCESS — so a fill against a code-less
// makerAsset with NO JIT hook to create it does not revert at the maker transfer: it "succeeds"
// while moving nothing, and the taker still pays. Simulation shows that class GREEN, which is
// why this module exists beside the fill simulation, not instead of it.
//
// Shape: ONE pure classifier (`assessMakerReadiness`) over optional pre-fetched facts, shared by
// the taker-fill prepare (one order) and the hybrid book verifier (a page of rows). A fact that
// was not fetched, or whose read failed, leaves its leg UNKNOWN — the classifier never turns a
// transport failure into a verdict (the indeterminate-is-kept rule, same as hybrid-verify).
// Fact gathering (`gatherMakerReadinessFacts`) issues every leg it needs CONCURRENTLY so a
// multicall-batching client coalesces them into one aggregate3 (getCode rides alongside as
// eth_getCode) — legs against a code-less token are wasted-but-harmless: their errors are
// explained by the getCode result, which the classifier consults first.
import { erc20Abi, permit2AllowanceAbi } from "../chain/abis.ts";
import { decodeExtensionFields, decodeMakerTraits, type LopOrder } from "../orders.ts";
import { decodeJitExtensionAny } from "../market-registry.ts";
import { PERMIT2_ADDRESS } from "../order-approvals.ts";
import type { MakerCodeProbe } from "./order-auth.ts";

const lc = (a: string) => a.toLowerCase();

// ── The maker-side context a signed extension carries ───────────────────────────────────────

/** The maker-side JIT hook decoded from the order's own extension bytes [K3] — who creates the
 *  pool, what funds the mint, and which tokens the embedded ERC-2612 permits cover. */
export interface MakerJitContext {
  adapter: `0x${string}`;
  collateralAsset: `0x${string}`;
  enableJitMint: boolean;
  /** The cST the first embedded permit names — the convention every JIT prepare in this repo
   *  writes (the permit exists to let the LOP pull the just-created token). null = no permit to
   *  infer from, so which token the hook creates is unknown from the bytes alone. */
  predictedCorkSwapToken: `0x${string}` | null;
  /** Every token an embedded ERC-2612 permit covers (the adapter executes them post-mint). */
  permitTokens: `0x${string}`[];
}

export interface MakerExtensionContext {
  jit: MakerJitContext | null;
  /** The LOP-level extension makerPermit token (first 20 bytes of extension field 5). The LOP
   *  executes this permit ONLY on the EOA fill path (_fillOrder), first fill — a contract
   *  maker's fill (_fillContractOrder) never runs it. */
  extensionPermitToken: `0x${string}` | null;
}

/** Decode what the extension says about the MAKER side, never throwing: a non-JIT extension
 *  (auction-only, or foreign bytes) yields `jit: null`; unreadable fields yield null legs. */
export function decodeMakerExtensionContext(extension: `0x${string}` | undefined): MakerExtensionContext {
  if (extension === undefined || extension === "0x") return { jit: null, extensionPermitToken: null };
  let jit: MakerJitContext | null = null;
  try {
    const dec = decodeJitExtensionAny(extension);
    jit = {
      adapter: dec.adapter,
      collateralAsset: dec.params.collateralAsset,
      enableJitMint: Boolean(dec.params.enableJitMint),
      predictedCorkSwapToken: dec.permits[0]?.token ?? null,
      permitTokens: dec.permits.map((p) => p.token),
    };
  } catch {
    /* not a JIT extension */
  }
  let extensionPermitToken: `0x${string}` | null = null;
  try {
    const permit = decodeExtensionFields(extension).makerPermit;
    // Field layout (OrderMixin): `token (20 bytes) ++ permit calldata`.
    if (permit.length >= 2 + 40) extensionPermitToken = `0x${permit.slice(2, 42)}` as `0x${string}`;
  } catch {
    /* unreadable field table */
  }
  return { jit, extensionPermitToken };
}

// ── Facts ───────────────────────────────────────────────────────────────────────────────────

/** Pre-fetched chain facts about the maker's side. Every leg is optional; "error" records a
 *  read that was ISSUED and failed (indeterminate, never a verdict). */
export interface MakerReadinessFacts {
  /** eth_getCode(makerAsset) classified — the fact every other leg's meaning hangs on. */
  makerAssetCode: MakerCodeProbe;
  /** Can the maker produce the ECDSA signature an ERC-2612 permit needs? true = proven (the
   *  order's own signature ecrecovered to the maker, or the maker has no code, or its code is
   *  an EIP-7702 delegation designator — a delegated EOA keeps its key); false = a real
   *  contract account; null = nobody could tell. */
  makerCanSignEcdsa: boolean | null;
  /** ERC-20 allowance(maker → LOP) on the makerAsset. */
  allowanceToLop?: bigint | "error";
  /** balanceOf(maker) on the makerAsset. */
  balance?: bigint | "error";
  /** Permit2 layer 1: ERC-20 allowance(maker → Permit2) on the makerAsset. */
  permit2Erc20Allowance?: bigint | "error";
  /** Permit2 layer 2: the internal (maker, makerAsset, spender = LOP) allowance. */
  permit2Internal?: { amount: bigint; expiration: number } | "error";
  /** enableJitMint funding: ERC-20 allowance(maker → JIT adapter) on the collateral. */
  mintCollateralAllowance?: bigint | "error";
  /** enableJitMint funding: balanceOf(maker) on the collateral. */
  mintCollateralBalance?: bigint | "error";
}

/** EIP-7702 delegation designator: `0xef0100 ++ address` — 23 bytes. An account wearing one HAS
 *  code, but it is a delegated EOA and its key still signs ECDSA (permits included). */
export function isEip7702Designator(code: `0x${string}` | undefined): boolean {
  return code !== undefined && code.length === 2 + 46 && code.slice(0, 8).toLowerCase() === "0xef0100";
}

/** Structural slice of a viem PublicClient (the same contravariance trick as AllowanceReader:
 *  readContract's ABI-typed overloads defeat any loose interface, so the parameter is `never`
 *  and the internal call sites cast once). */
export type ReadinessClient = {
  readContract: (args: never) => Promise<unknown>;
  getCode: (args: { address: `0x${string}`; blockNumber?: bigint }) => Promise<`0x${string}` | undefined>;
};

/** What the fact gatherer needs to know about the order — all chain-free, from the signed bytes. */
export interface MakerReadinessTarget {
  maker: `0x${string}`;
  makerAsset: `0x${string}`;
  lop: `0x${string}`;
  usePermit2: boolean;
  /** true = ECDSA capability already proven chain-free (the signature ecrecovered to the maker),
   *  so the maker's own code is never read. */
  makerSignedEcdsa: boolean;
  jit: MakerJitContext | null;
}

/** Issue every read the classifier could need for this order, CONCURRENTLY (one Promise.all —
 *  a batching client coalesces the readContract legs into one multicall; getCode rides as
 *  eth_getCode beside it). Legs are conditioned only on CHAIN-FREE facts (the signed traits,
 *  the decoded extension), never on another read's answer — the one-batch discipline. */
export async function gatherMakerReadinessFacts(client: ReadinessClient, t: MakerReadinessTarget, opts?: { atBlock?: bigint }): Promise<MakerReadinessFacts> {
  const blockOpt = opts?.atBlock !== undefined ? { blockNumber: opts.atBlock } : {};
  const read = (params: object): Promise<unknown> => (client.readContract as (p: object) => Promise<unknown>)({ ...params, ...blockOpt });
  const amount = (params: object): Promise<bigint | "error"> => read(params).then((v) => v as bigint).catch(() => "error" as const);
  // Promise.resolve().then(...) so a client whose getCode throws SYNCHRONOUSLY (a structural
  // slice missing the method) still lands in the leg's own .catch — read failure of any shape
  // is "read-failed"/indeterminate, never an escaped throw that kills the whole batch.
  const getCode = (address: `0x${string}`): Promise<`0x${string}` | undefined> => Promise.resolve().then(() => client.getCode({ address, ...blockOpt }));
  const skipBalance = t.jit?.enableJitMint === true; // the fill mints the makerAsset — the maker need not hold it

  const [assetCode, makerCode, allowanceToLop, balance, p2erc20, p2internal, mintAllowance, mintBalance] = await Promise.all([
    getCode(t.makerAsset).then((code) => ({ probe: (code !== undefined && code !== "0x" ? "has-code" : "no-code") as MakerCodeProbe })).catch(() => ({ probe: "read-failed" as MakerCodeProbe })),
    t.makerSignedEcdsa ? Promise.resolve(undefined) : getCode(t.maker).then((code) => ({ code })).catch(() => "error" as const),
    t.usePermit2 ? Promise.resolve(undefined) : amount({ address: t.makerAsset, abi: erc20Abi, functionName: "allowance", args: [t.maker, t.lop] }),
    skipBalance ? Promise.resolve(undefined) : amount({ address: t.makerAsset, abi: erc20Abi, functionName: "balanceOf", args: [t.maker] }),
    t.usePermit2 ? amount({ address: t.makerAsset, abi: erc20Abi, functionName: "allowance", args: [t.maker, PERMIT2_ADDRESS] }) : Promise.resolve(undefined),
    t.usePermit2
      ? read({ address: PERMIT2_ADDRESS, abi: permit2AllowanceAbi, functionName: "allowance", args: [t.maker, t.makerAsset, t.lop] })
          .then((v) => { const [amt, expiration] = v as readonly [bigint, number, number]; return { amount: amt, expiration }; })
          .catch(() => "error" as const)
      : Promise.resolve(undefined),
    t.jit?.enableJitMint ? amount({ address: t.jit.collateralAsset, abi: erc20Abi, functionName: "allowance", args: [t.maker, t.jit.adapter] }) : Promise.resolve(undefined),
    t.jit?.enableJitMint ? amount({ address: t.jit.collateralAsset, abi: erc20Abi, functionName: "balanceOf", args: [t.maker] }) : Promise.resolve(undefined),
  ]);

  const makerCanSignEcdsa = t.makerSignedEcdsa
    ? true
    : makerCode === "error" || makerCode === undefined
      ? null
      : makerCode.code === undefined || makerCode.code === "0x" || isEip7702Designator(makerCode.code)
        ? true
        : false;

  return {
    makerAssetCode: assetCode.probe,
    makerCanSignEcdsa,
    ...(allowanceToLop !== undefined ? { allowanceToLop } : {}),
    ...(balance !== undefined ? { balance } : {}),
    ...(p2erc20 !== undefined ? { permit2Erc20Allowance: p2erc20 } : {}),
    ...(p2internal !== undefined ? { permit2Internal: p2internal as { amount: bigint; expiration: number } | "error" } : {}),
    ...(mintAllowance !== undefined ? { mintCollateralAllowance: mintAllowance } : {}),
    ...(mintBalance !== undefined ? { mintCollateralBalance: mintBalance } : {}),
  };
}

// ── The classifier ──────────────────────────────────────────────────────────────────────────

export type MakerNotReadyCode =
  | "silent-noop" // code-less makerAsset NO hook creates: the maker transfer "succeeds" moving nothing — the taker pays for nothing
  | "unborn-cst-no-permit" // JIT creates the makerAsset but no embedded permit covers it — the LOP cannot pull the minted cST
  | "contract-maker-unborn-cst" // the incident class: permit present but the maker is a contract, and ERC-2612 is ECDSA-only
  | "allowance-missing"
  | "allowance-insufficient"
  | "balance-empty"
  | "balance-insufficient"
  | "permit2-missing"
  | "permit2-expired"
  | "mint-funding-missing";

export interface MakerReadinessReason {
  code: MakerNotReadyCode;
  /** true = un-fillable AS SIGNED in the current state for a reason no pending token grant
   *  fixes (the taker-fill surface warns `maker_not_ready` on these; grant-shaped reasons ride
   *  the approval_missing machinery instead). */
  structural: boolean;
  message: string;
}

export interface MakerReadiness {
  /** "not-ready": at least one leg PROVES every fill of this order currently reverts or
   *  silently moves nothing — the maker can fix all of them without re-signing (grant, fund,
   *  or create the pool), so consumers exclude with evidence, never drop. "unknown": a needed
   *  leg was unavailable and nothing fatal was proven — kept, unlabeled negative. */
  status: "ready" | "not-ready" | "unknown";
  reasons: MakerReadinessReason[];
}

export interface MakerReadinessInput {
  makerAsset: `0x${string}`;
  /** The making amount this consumer needs (the fill's amount, or the order's own). */
  makingAmount: bigint;
  allowPartialFills: boolean;
  usePermit2: boolean;
  jit: MakerJitContext | null;
  /** The LOP-level makerPermit token (decodeMakerExtensionContext) — the EOA-path escape hatch
   *  for a missing standing allowance. */
  extensionPermitToken: `0x${string}` | null;
  nowSeconds: bigint;
  facts: MakerReadinessFacts;
}

/** Classify the maker side from the facts in hand. Pure; every absent or errored fact leaves
 *  its leg unknown. The full rule set lives in the branches below; the module header carries
 *  the two classes that motivated it. */
export function assessMakerReadiness(a: MakerReadinessInput): MakerReadiness {
  const f = a.facts;
  const reasons: MakerReadinessReason[] = [];
  let indeterminate = false;
  const partial = a.allowPartialFills;
  const jit = a.jit;
  // "Covers" errs toward the JIT story when the created token is unknowable from the bytes
  // (no permit to infer from): the no-permit rule below then fires assumption-free anyway.
  const jitCoversMakerAsset = jit !== null && (jit.predictedCorkSwapToken === null || lc(jit.predictedCorkSwapToken) === lc(a.makerAsset));
  const permitsCoverMakerAsset = jit !== null && jit.permitTokens.some((t) => lc(t) === lc(a.makerAsset));

  if (f.makerAssetCode === "no-rpc" || f.makerAssetCode === "read-failed") {
    // The token-side legs all hang on this read; a transport failure is never a verdict.
    indeterminate = true;
  } else if (f.makerAssetCode === "no-code") {
    if (!jitCoversMakerAsset) {
      reasons.push({
        code: "silent-noop", structural: true,
        message: `the makerAsset ${a.makerAsset} has NO CODE and no JIT hook creates it during the fill — the LOP's maker transfer to a code-less address returns success with empty returndata, so a fill does NOT revert: it silently delivers nothing while still pulling the taker asset. Simulation shows this class green; do not fill`,
      });
    } else if (!permitsCoverMakerAsset) {
      reasons.push({
        code: "unborn-cst-no-permit", structural: true,
        message: `the makerAsset ${a.makerAsset} has no code yet (the JIT hook creates it during the fill), and the extension embeds NO ERC-2612 permit covering it — an allowance cannot exist on a code-less token, so the LOP has no way to pull the minted cST and every fill reverts TransferFromMakerToTakerFailed. The maker's fix (no re-sign needed): create the pool ahead of the fill (cork_prepare_market create-pool) and approve the then-existing cST to the LOP`,
      });
    } else if (f.makerCanSignEcdsa === false) {
      reasons.push({
        code: "contract-maker-unborn-cst", structural: true,
        message: `the maker is a CONTRACT account and the makerAsset ${a.makerAsset} has no code yet — the embedded ERC-2612 permit is ECDSA-only, so no valid permit by this maker can exist and a standing allowance cannot exist on a code-less token: every fill reverts TransferFromMakerToTakerFailed. The maker's fix (no re-sign needed): cork_prepare_market create-pool, then approve the cST to the LOP`,
      });
    } else if (f.makerCanSignEcdsa === null) {
      indeterminate = true; // permit present; whether the maker could have signed it is unknown
    } else if (!jit.enableJitMint) {
      // Created-but-not-minted: the hook births the cST with the maker holding zero of it.
      reasons.push({
        code: "balance-empty", structural: true,
        message: `the makerAsset ${a.makerAsset} has no code yet and the JIT hook creates the pool WITHOUT minting (enableJitMint is off) — at fill time the maker's balance of the just-created cST is provably zero, so the maker transfer reverts. The maker's fix (no re-sign needed): create the pool, mint/deposit the cST, and approve it to the LOP`,
      });
    }
    // no-code + covered + permit + can-sign + mint on: the permit is the allowance and the mint
    // is the balance — this leg is READY; the mint-funding legs below still apply.
  } else {
    // has-code: the ordinary allowance/balance story, with the two permit escape hatches.
    if (a.usePermit2) {
      if (f.permit2Erc20Allowance === "error" || f.permit2Erc20Allowance === undefined) indeterminate = true;
      else if (f.permit2Erc20Allowance === 0n) {
        reasons.push({ code: "permit2-missing", structural: false, message: `Permit2 sourcing (makerTraits bit 248) with NO ERC-20 allowance maker → Permit2 on ${a.makerAsset} — layer 1 of 2 is absent, so every fill reverts` });
      }
      if (f.permit2Internal === "error" || f.permit2Internal === undefined) indeterminate = true;
      else if (a.nowSeconds > BigInt(f.permit2Internal.expiration)) {
        reasons.push({ code: "permit2-expired", structural: false, message: `the Permit2 internal allowance (maker, ${a.makerAsset}, spender = the LOP) EXPIRED at ${String(f.permit2Internal.expiration)} — every fill reverts until the maker re-approves` });
      } else if (f.permit2Internal.amount === 0n) {
        reasons.push({ code: "permit2-missing", structural: false, message: `the Permit2 internal allowance (maker, ${a.makerAsset}, spender = the LOP) is ZERO — layer 2 of 2 is absent, so every fill reverts` });
      } else if (f.permit2Internal.amount < a.makingAmount && !partial) {
        reasons.push({ code: "allowance-insufficient", structural: false, message: `the Permit2 internal allowance ${f.permit2Internal.amount.toString()} is below the all-or-nothing making amount ${a.makingAmount.toString()} — the fill reverts` });
      }
    } else if (f.allowanceToLop === "error" || f.allowanceToLop === undefined) {
      indeterminate = true;
    } else if (f.allowanceToLop === 0n) {
      // Escape hatches for a zero standing allowance: an in-fill permit can grant it — the
      // LOP-level extension makerPermit (EOA fill path only), or a JIT-embedded permit (the
      // adapter executes it on the pre-interaction, either fill path). Both are ERC-2612, so
      // both die with a maker that cannot sign ECDSA.
      const extensionHatch = a.extensionPermitToken !== null && lc(a.extensionPermitToken) === lc(a.makerAsset);
      const hatch = (extensionHatch || permitsCoverMakerAsset) && f.makerCanSignEcdsa !== false;
      const hatchUnknown = (extensionHatch || permitsCoverMakerAsset) && f.makerCanSignEcdsa === null;
      if (!hatch) {
        reasons.push({ code: "allowance-missing", structural: false, message: `the maker holds NO allowance on ${a.makerAsset} for the LOP and no in-fill permit can grant one${extensionHatch || permitsCoverMakerAsset ? " (a permit rides the order, but the maker is a contract account and ERC-2612 is ECDSA-only)" : ""} — every fill reverts TransferFromMakerToTakerFailed until the maker approves` });
      } else if (hatchUnknown) indeterminate = true;
    } else if (f.allowanceToLop < a.makingAmount && !partial) {
      reasons.push({ code: "allowance-insufficient", structural: false, message: `the maker's allowance ${f.allowanceToLop.toString()} on ${a.makerAsset} is below the all-or-nothing making amount ${a.makingAmount.toString()} — the fill reverts` });
    }

    if (jit?.enableJitMint !== true) {
      if (f.balance === "error" || f.balance === undefined) indeterminate = true;
      else if (f.balance === 0n) {
        reasons.push({ code: "balance-empty", structural: false, message: `the maker's balance of ${a.makerAsset} is ZERO — every fill reverts (or a partial fill moves nothing); the maker must fund before any fill can succeed` });
      } else if (f.balance < a.makingAmount && !partial) {
        reasons.push({ code: "balance-insufficient", structural: false, message: `the maker's balance ${f.balance.toString()} of ${a.makerAsset} is below the all-or-nothing making amount ${a.makingAmount.toString()} — the fill reverts` });
      }
    }
  }

  if (jit?.enableJitMint === true) {
    // The mint's collateral pull: only ZERO is provable (the mint's cost depends on the pool
    // rate at fill time, so "insufficient" cannot be proven here).
    if (f.mintCollateralAllowance === "error" || f.mintCollateralAllowance === undefined || f.mintCollateralBalance === "error" || f.mintCollateralBalance === undefined) indeterminate = true;
    const zeroAllowance = f.mintCollateralAllowance !== "error" && f.mintCollateralAllowance !== undefined && f.mintCollateralAllowance === 0n;
    const zeroBalance = f.mintCollateralBalance !== "error" && f.mintCollateralBalance !== undefined && f.mintCollateralBalance === 0n;
    if (zeroAllowance || zeroBalance) {
      reasons.push({ code: "mint-funding-missing", structural: false, message: `enableJitMint is on but the maker's collateral ${jit.collateralAsset} ${zeroAllowance && zeroBalance ? "allowance to the JIT adapter AND balance are" : zeroAllowance ? "allowance to the JIT adapter is" : "balance is"} ZERO — the in-fill mint cannot be funded, so every fill reverts` });
    }
  }

  return { status: reasons.length > 0 ? "not-ready" : indeterminate ? "unknown" : "ready", reasons };
}

// ── Sugar: everything from a signed order + facts in one call ───────────────────────────────

/** The classifier's chain-free inputs derived from a signed order's own bytes. */
export function makerReadinessTargetOf(a: { order: LopOrder; extension: `0x${string}`; lop: `0x${string}`; makerSignedEcdsa: boolean }): { target: MakerReadinessTarget; extensionPermitToken: `0x${string}` | null; allowPartialFills: boolean; orderExpiry: bigint } {
  const traits = decodeMakerTraits(a.order.makerTraits);
  const ext = decodeMakerExtensionContext(a.extension);
  return {
    target: { maker: a.order.maker, makerAsset: a.order.makerAsset, lop: a.lop, usePermit2: traits.usePermit2, makerSignedEcdsa: a.makerSignedEcdsa, jit: ext.jit },
    extensionPermitToken: ext.extensionPermitToken,
    allowPartialFills: traits.allowPartialFills,
    orderExpiry: traits.expiry,
  };
}
