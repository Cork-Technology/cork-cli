// Recursive Bundler3 bundle decoder: unwrap multicall/reenter Call[] and identify each leg.
// Cork legs are decoded to {action, params}; nested bundles recurse; unknown legs are surfaced
// raw (with selector) rather than dropped — a decoder that silently hides legs is a footgun.
//
// A selector names an ABI SHAPE, not a contract (audit ARTIFACT-DECODE-002, 2026-08-24): any
// contract can expose `safeDeposit(...)` or `multicall(...)`. So every leg also carries a
// `verification` verdict against the targets the caller vouches for (`DecodeTrustTargets`):
//   trusted    — the leg's `to` IS the configured contract for that role;
//   mismatch   — a configured contract exists for the role and `to` is a DIFFERENT address
//                (the label is kept so the reader sees what the bytes claim, but a signer must
//                treat it as a contradiction — the decode handler reports it as a conflict);
//   unverified — nothing to compare against: no target configured for the role, or a role the
//                decoder has no authority for (an ERC-20 token, an integrator-deployed ForSelf
//                adapter). Honest, not a contradiction.
// With no targets at all (the default) every labeled leg is `unverified` — the pre-audit
// behaviour, now stated instead of implied.
import { decodeFunctionData, toFunctionSelector, type AbiFunction } from "viem";
import { corkAdapterAbi } from "./corkAdapterAbi.ts";
import { bundlerLegAbi } from "./legs.ts";
import { forSelfAbi } from "../forself.ts";
import { decodeLopCall, lopCallName, type DecodedLopCall } from "../orders.ts";
import type { LopLegLabel } from "../handlers/decode.ts";
import { decodeMulticall, isBundlerMulticall, ZERO_CALLBACK_HASH, type Call } from "./bundler3.ts";

/** The contracts a decode may treat as authoritative for each label. Every field optional: an
 *  absent target makes that role's legs `unverified`, never `trusted`. */
export interface DecodeTrustTargets {
  /** The Bundler3 a nested multicall/reenter leg must target. */
  bundler3?: `0x${string}` | undefined;
  /** The Cork adapter: every `safe*` action AND every GeneralAdapter fund/sweep leg runs here. */
  corkAdapter?: `0x${string}` | undefined;
  /** The chain's 1inch LOP v4, for fill/cancel legs. */
  lop?: `0x${string}` | undefined;
  /** An integrator-deployed ForSelf adapter, once the caller has verified its bindings. */
  forSelf?: `0x${string}` | undefined;
  /** Token contracts a plain ERC-20 leg (approve/transfer/transferFrom) may be trusted at —
   *  the pool's own tokens, from the pool read the bundle was built against. */
  erc20?: readonly `0x${string}`[] | undefined;
}

export type LegVerification = "trusted" | "mismatch" | "unverified";

/** Fields every leg carries. `callbackHash` is Bundler3's reentry commitment: non-zero means
 *  the target may call back INTO the bundler during this leg (`reenter`), which changes what
 *  signing means — so it is surfaced, never dropped. */
type LegBase = {
  to: `0x${string}`;
  value: bigint;
  skipRevert: boolean;
  callbackHash: `0x${string}`;
  verification: LegVerification;
  /** For a `mismatch`: the configured address the leg was expected to target. */
  expectedTarget?: `0x${string}`;
};

export type DecodedLeg =
  | (LegBase & { kind: "cork"; action: string; params: unknown })
  | (LegBase & { kind: "forself"; action: string; params: unknown })
  /** A GeneralAdapter fund/sweep leg (`role: "adapter"`, trusted against corkAdapter) or a
   *  plain ERC-20 call (`role: "erc20"`, trusted only against the caller's token list). */
  | (LegBase & { kind: "leg"; role: "adapter" | "erc20"; fn: string; args: readonly unknown[] })
  /** A 1inch LOP v4 fill or cancel. `label` (orderHash, maker-traits breakdown, JIT/Fusion
   *  extension labels) is chain-specific, so the decode handler attaches it afterwards. */
  | (LegBase & { kind: "lop"; call: DecodedLopCall; label?: LopLegLabel })
  | (LegBase & { kind: "bundle"; legs: DecodedLeg[] })
  | (LegBase & { kind: "unknown"; selector: `0x${string}`; data: `0x${string}`; note?: string });

/** Nested-bundle depth cap: untrusted calldata must not be able to blow the stack (and a
 *  stack overflow here would hide EVERY leg, the exact failure the header forbids). */
const MAX_DEPTH = 16;

const selectorMap = (abi: readonly unknown[]): Map<string, string> =>
  new Map(
    abi
      .filter((f): f is AbiFunction => (f as { type?: string }).type === "function")
      .map((f) => [toFunctionSelector(f).toLowerCase(), f.name]),
  );

// selector -> name, computed once from each ABI. The leg ABI mixes two trust roots: the
// adapter's own fund/sweep functions (called ON the adapter) and plain ERC-20 functions
// (called on a token), so they are split here by name.
const CORK_SELECTORS = selectorMap(corkAdapterAbi);
const LEG_SELECTORS = selectorMap(bundlerLegAbi);
const ADAPTER_LEG_FUNCTIONS = new Set(["erc20TransferFrom", "permit2TransferFrom", "erc20Transfer", "nativeTransfer", "permit2TransferFromWithPermit"]);
// The ForSelf example-adapter surface (integrator-deployed): selector-recognized so a caged
// wallet's *ForSelf / fillOrderForSelf tx labels in validate-before-broadcast instead of
// surfacing as UNREADABLE. The adapter ADDRESS is integrator config — trusted only when the
// caller passes it (the ForSelf prepare does, after verifying its bindings).
const FORSELF_SELECTORS = selectorMap(forSelfAbi);

/** Verdict for a role with ONE authoritative address: equal → trusted, configured-but-different
 *  → mismatch, unconfigured → unverified. */
function verifyAgainst(to: `0x${string}`, expected: `0x${string}` | undefined): Pick<LegBase, "verification" | "expectedTarget"> {
  if (expected === undefined) return { verification: "unverified" };
  if (to.toLowerCase() === expected.toLowerCase()) return { verification: "trusted" };
  return { verification: "mismatch", expectedTarget: expected };
}

/** Verdict for the ERC-20 role: a token is trusted only by membership in the caller's list;
 *  there is no single "right" token, so an absent or foreign token is unverified, never a
 *  mismatch. */
function verifyToken(to: `0x${string}`, tokens: readonly `0x${string}`[] | undefined): Pick<LegBase, "verification"> {
  const known = tokens?.some((t) => t.toLowerCase() === to.toLowerCase()) ?? false;
  return { verification: known ? "trusted" : "unverified" };
}

const base = (c: Call): Omit<LegBase, "verification"> => ({ to: c.to, value: c.value, skipRevert: c.skipRevert, callbackHash: c.callbackHash });

function decodeCall(c: Call, depth: number, trust: DecodeTrustTargets): DecodedLeg {
  const selector = c.data.slice(0, 10).toLowerCase() as `0x${string}`;
  // A leg whose selector matches but whose body is malformed/truncated DEGRADES to `unknown`
  // with the raw bytes preserved — it must never abort the decode and hide every other leg.
  try {
    if (isBundlerMulticall(c.data)) {
      if (depth >= MAX_DEPTH) {
        return { ...base(c), verification: "unverified", kind: "unknown", selector, data: c.data, note: `nested bundle exceeds the ${MAX_DEPTH}-level decode depth cap — raw bytes preserved` };
      }
      return { ...base(c), ...verifyAgainst(c.to, trust.bundler3), kind: "bundle", legs: decodeMulticall(c.data).map((leg) => decodeCall(leg, depth + 1, trust)) };
    }
    if (CORK_SELECTORS.has(selector)) {
      const { functionName, args } = decodeFunctionData({ abi: corkAdapterAbi, data: c.data });
      return { ...base(c), ...verifyAgainst(c.to, trust.corkAdapter), kind: "cork", action: functionName, params: args[0] };
    }
    if (LEG_SELECTORS.has(selector)) {
      const { functionName, args } = decodeFunctionData({ abi: bundlerLegAbi, data: c.data });
      const role = ADAPTER_LEG_FUNCTIONS.has(functionName) ? "adapter" : "erc20";
      const verdict = role === "adapter" ? verifyAgainst(c.to, trust.corkAdapter) : verifyToken(c.to, trust.erc20);
      return { ...base(c), ...verdict, kind: "leg", role, fn: functionName, args: args as readonly unknown[] };
    }
    if (FORSELF_SELECTORS.has(selector)) {
      const { functionName, args } = decodeFunctionData({ abi: forSelfAbi, data: c.data });
      return { ...base(c), ...verifyAgainst(c.to, trust.forSelf), kind: "forself", action: functionName, params: args[0] };
    }
    // The 1inch LOP fill/cancel surface this tool's own taker-fill and cancel produce: labeled
    // by selector so the validate-before-broadcast decode of those bytes names the order, the
    // amounts, and the hooks instead of calling the tool's own output UNREADABLE.
    if (lopCallName(selector) !== undefined) {
      return { ...base(c), ...verifyAgainst(c.to, trust.lop), kind: "lop", call: decodeLopCall(c.data) };
    }
  } catch (err) {
    return { ...base(c), verification: "unverified", kind: "unknown", selector, data: c.data, note: `selector matches ${CORK_SELECTORS.get(selector) ?? LEG_SELECTORS.get(selector) ?? FORSELF_SELECTORS.get(selector) ?? lopCallName(selector) ?? "a bundle"} but the body failed to decode (${err instanceof Error ? err.message.split("\n")[0] : String(err)}) — malformed or truncated` };
  }
  return { ...base(c), verification: "unverified", kind: "unknown", selector, data: c.data };
}

/** Decode ONE call (any target) into a labeled leg — a Bundler3 multicall nests as kind
 *  "bundle", a known adapter/ERC-20 call labels, anything else surfaces raw with its selector.
 *  Used by the signed-tx decoder, where the tx's single (to, data, value) is the call. */
export function decodeSingleCall(c: Call, trust: DecodeTrustTargets = {}): DecodedLeg {
  return decodeCall(c, 0, trust);
}

/** Decode top-level Bundler3.multicall calldata into a tree of legs, each verified against
 *  `trust` (see the header). */
export function decodeBundle(multicallData: `0x${string}`, trust: DecodeTrustTargets = {}): DecodedLeg[] {
  if (!isBundlerMulticall(multicallData)) {
    throw new Error("decodeBundle: not a Bundler3 multicall/reenter calldata");
  }
  return decodeMulticall(multicallData).map((leg) => decodeCall(leg, 0, trust));
}

/** Walk a decoded tree and collect the legs whose target contradicts a configured contract
 *  (`mismatch`) and the legs nobody could vouch for (`unverified`, labeled legs only — an
 *  `unknown` leg already says it is unreadable). Nested bundles are walked so a router cannot
 *  hide a leg one level down. */
export function collectVerification(legs: DecodedLeg[]): { mismatches: DecodedLeg[]; unverified: DecodedLeg[] } {
  const mismatches: DecodedLeg[] = [];
  const unverified: DecodedLeg[] = [];
  const walk = (list: DecodedLeg[]) => {
    for (const leg of list) {
      if (leg.verification === "mismatch") mismatches.push(leg);
      else if (leg.verification === "unverified" && leg.kind !== "unknown") unverified.push(leg);
      if (leg.kind === "bundle") walk(leg.legs);
    }
  };
  walk(legs);
  return { mismatches, unverified };
}

/** True when a leg's Bundler3 callback hash is set — the target may re-enter the bundler. */
export function hasCallback(leg: { callbackHash: `0x${string}` }): boolean {
  return leg.callbackHash.toLowerCase() !== ZERO_CALLBACK_HASH;
}
