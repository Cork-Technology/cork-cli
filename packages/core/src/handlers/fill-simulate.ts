// Probe-fill simulation of a RESTING order: eth_call the REAL fill calldata from the caller's
// fill-sender account and classify the outcome. The probe is built with maximumTakingAmount 0 —
// takerTraits threshold 0 means the LOP skips the cap check entirely — so an auction row
// simulates at its live decayed price instead of reverting TakingAmountTooHigh against the
// signed floor.
//
// What the LOP's fill order-of-operations makes this probe mean: validation → predicate →
// amounts → invalidation → the MAKER's pre-interaction (a JIT hook creates/mints here, and the
// adapter executes the embedded permits) → the maker→taker transfer → taker interaction → the
// taker→maker transfer. A revert of TransferFromTakerToMakerFailed therefore proves the fill
// got PAST every maker-side step — expected when the probing account holds no taker-asset
// allowance — and classifies as "maker-ready". Success means the account could broadcast this
// fill right now.
//
// The one class simulation CANNOT catch: a code-less makerAsset with NO creating hook. The
// LOP's transfer helper counts a call to a code-less address with empty returndata as SUCCESS,
// so that fill simulates GREEN while delivering nothing. The maker-readiness decode
// (maker-readiness.ts, the ranker's maker-not-ready exclusion) is the necessary complement:
// callers simulate only rows that passed it, and a "maker-ready"/"fillable" verdict here is
// conditioned on that gate having run.
import { decodeErrorResult, parseAbi } from "viem";
import { buildTakerFill } from "../orders.ts";
import { marketCreatorAbi } from "../market-registry.ts";
import type { SignedLopOrder } from "../datasources/venue.ts";
import type { ResolvedRpc } from "../chain/rpc.ts";
import { isTransportFailure, revertReason } from "./shared.ts";

/** Every custom error the fill path can surface, for naming a revert: the LOP's own
 *  (IOrderMixin — all niladic — plus SimulationResults), OrderLib's extension rule, the
 *  invalidator/transfer libraries, and the Cork market-creator errors a JIT hook re-raises
 *  (RateUnavailable, RecipeRejectedConstraint, …) via the shared creator ABI. */
const fillErrorAbi = [
  ...parseAbi([
    "error InvalidatedOrder()",
    "error TakingAmountExceeded()",
    "error PrivateOrder()",
    "error BadSignature()",
    "error OrderExpired()",
    "error WrongSeriesNonce()",
    "error SwapWithZeroAmount()",
    "error PartialFillNotAllowed()",
    "error OrderIsNotSuitableForMassInvalidation()",
    "error EpochManagerAndBitInvalidatorsAreIncompatible()",
    "error ReentrancyDetected()",
    "error PredicateIsNotTrue()",
    "error TakingAmountTooHigh()",
    "error MakingAmountTooLow()",
    "error TransferFromMakerToTakerFailed()",
    "error TransferFromTakerToMakerFailed()",
    "error MismatchArraysLengths()",
    "error InvalidPermit2Transfer()",
    "error SimulationResults(bool success, bytes res)",
    "error MissingOrderExtension()",
    "error UnexpectedOrderExtension()",
    "error InvalidExtensionHash()",
    "error BitInvalidatedOrder()",
    "error RemainingInvalidatedOrder()",
    "error InvalidMsgValue()",
    "error ETHTransferFailed()",
    "error OffsetOutOfBounds()",
  ]),
  ...marketCreatorAbi,
] as const;

export type FillSimulationVerdict = "fillable" | "maker-ready" | "would-revert" | "unknown";

export interface FillSimulation {
  verdict: FillSimulationVerdict;
  /** The revert, when there was one: the decoded error name (null when the selector is outside
   *  the known LOP/Cork set) and its 4-byte selector (null when no revert data surfaced). */
  revert?: { name: string | null; selector: `0x${string}` | null };
  note: string;
}

type FillSimClient = Pick<ResolvedRpc["client"], "call">;

/** Walk an eth_call error's cause chain for the raw revert data (viem nests it at varying
 *  depths depending on transport). Bounded; null = no revert data surfaced. */
function revertDataOf(err: unknown): `0x${string}` | null {
  let cur: unknown = err;
  for (let depth = 0; depth < 10 && cur !== null && typeof cur === "object"; depth += 1) {
    const d = (cur as { data?: unknown }).data;
    if (typeof d === "string" && d.startsWith("0x") && d.length >= 10) return d as `0x${string}`;
    cur = (cur as { cause?: unknown }).cause;
  }
  return null;
}

/** Simulate filling `signed` from `account` and classify. Returns null when the fill bytes
 *  cannot be built for this variant (no verdict is invented). The caller must pass a row whose
 *  maker signature the verifier SETTLED (`makerAccountType` = the verdict, "EOA" for
 *  eoa-verified, "ERC1271" for erc1271-verified) — probing an unverified signature would
 *  misreport a forgery's BadSignature as the maker's problem. */
export async function simulateTopFill(
  client: FillSimClient,
  a: { signed: SignedLopOrder; lop: `0x${string}`; account: `0x${string}`; atBlock?: bigint },
): Promise<FillSimulation | null> {
  let calldata: `0x${string}`;
  try {
    calldata = buildTakerFill({
      order: a.signed.order,
      signature: a.signed.signature,
      makerAccountType: a.signed.makerAccountType,
      taker: a.account,
      extension: a.signed.extension,
      maximumTakingAmount: 0n,
    }).calldata;
  } catch {
    return null; // terms this variant cannot fill — no probe, no verdict
  }
  try {
    await (client.call as (args: object) => Promise<unknown>)({
      to: a.lop,
      data: calldata,
      account: a.account,
      ...(a.atBlock !== undefined ? { blockNumber: a.atBlock } : {}),
    });
    return { verdict: "fillable", note: "the REAL fill calldata succeeds in eth_call from this account at the current state — allowance, balance and the maker's whole side are in place" };
  } catch (err) {
    if (isTransportFailure(err)) {
      return { verdict: "unknown", note: `the probe could not run (transport failure: ${revertReason(err)}) — no verdict` };
    }
    const data = revertDataOf(err);
    if (data === null) {
      return { verdict: "would-revert", revert: { name: null, selector: null }, note: `the fill reverts (${revertReason(err)}) — the node surfaced no revert data to name the error` };
    }
    const selector = data.slice(0, 10) as `0x${string}`;
    let name: string | null = null;
    try {
      name = decodeErrorResult({ abi: fillErrorAbi, data }).errorName;
    } catch {
      /* a selector outside the known set — reported raw below */
    }
    if (name === "TransferFromTakerToMakerFailed") {
      return {
        verdict: "maker-ready",
        revert: { name, selector },
        note: "the probe got PAST the maker's entire side (validation, JIT hook, maker→taker transfer) and reverted only pulling the TAKER asset — expected when this account has not granted the taker-asset allowance yet; grant it and this fill goes through",
      };
    }
    return {
      verdict: "would-revert",
      revert: { name, selector },
      note: name !== null ? `the fill reverts ${name} — a broadcast of these bytes fails the same way at the current state` : `the fill reverts with selector ${selector}, outside the known LOP/Cork error set — identify it before filling`,
    };
  }
}

/** The venue book's makerSignature label mapped to the account type a probe may use; null =
 *  unsettled, do not probe. */
export function probeAccountTypeOf(makerSignature: unknown): "EOA" | "ERC1271" | null {
  if (makerSignature === "eoa-verified") return "EOA";
  if (makerSignature === "erc1271-verified") return "ERC1271";
  return null;
}
