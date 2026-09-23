// Every CONTRACT a LOP v4 extension makes the protocol CALL during a fill, classified against the
// chain's known deployments (owner requirement 2026-09-23: the user must be safe even when the
// venue returns an order whose extension names an address that matches no known generation).
//
// The threat, precisely. A resting order's extension is signed by the MAKER and passed verbatim
// into the taker's fill transaction. Inside that transaction the LOP calls four kinds of
// maker-chosen contract, in this order (OrderMixin._fill, 1inch LOP v4 source): the making/taking
// AMOUNT GETTERS (they SET the price the taker pays), the PRE-INTERACTION (before the maker asset
// moves), then — after the maker asset moves and the taker asset is pulled — the POST-INTERACTION
// (with the fill's final amounts in hand). A maker-side hook cannot spend the taker's allowance
// directly, but it executes inside the taker's transaction, on the taker's gas, and can revert or
// reorder state the taker relies on; an unknown GETTER can set any price the cap allows.
// The venue is DISCOVERY, not authority: a row it serves may carry an extension nobody in
// this repo has ever read. So before any fill bytes are built, every target is classified:
//   known    — the JIT ADAPTER of some configured generation (role-checked, not mere address-book
//              membership), or the
//              release-pinned Fusion settlement (current) — the only contracts this build has
//              read the source of;
//   legacy   — a Fusion settlement layout this build no longer prices (refused elsewhere);
//   unknown  — anything else. An unknown HOOK is refused on the fill path, excluded from the ranked
//              book and labeled on decode — never "warned and built", because no cap bounds a
//              hook. An unknown GETTER keeps the 2026-08-26 rule (fusion.ts): the derived cap is
//              refused, an explicit cap builds with a warning, since the LOP enforces that cap.
// The permit-only `customData` and the asset suffixes carry no call target and are not classified.
import { classifyAddress, type ResolvedGeneration } from "./generations.ts";
import { classifySettlement } from "./fusion.ts";
import { decodeExtensionFields } from "./orders.ts";
import { getAddress, isAddress } from "viem";

export type ExtensionSlot = "makingAmountGetter" | "takingAmountGetter" | "preInteraction" | "postInteraction";
export type ExtensionTargetClass = "known" | "legacy" | "unknown";

export interface ExtensionTarget {
  slot: ExtensionSlot;
  address: `0x${string}`;
  classification: ExtensionTargetClass;
  /** what the address IS when known: the generation label + role, or "fusion settlement (current)" */
  as?: string;
}

/** The first 20 bytes of a non-empty interaction/getter field are the target address (LOP v4
 *  `_parseArgs` / `OffsetsLib` convention); an empty field names no target. */
function targetOf(field: `0x${string}`): `0x${string}` | null {
  if (field === "0x" || field.length < 42) return null;
  // Lower-case before checksumming: the 20 bytes arrive in whatever spelling the venue (or a test)
  // used, and viem's isAddress REJECTS a mixed-case string whose checksum is wrong — which would
  // let a mis-cased stranger hook pass as "no target". Bytes are bytes; the case is presentation.
  const raw = `0x${field.slice(2, 42).toLowerCase()}`;
  return isAddress(raw) ? getAddress(raw) : null;
}

/** Classify every call target the extension carries. An extension that fails to parse (no field
 *  table) yields NO targets — the caller decides what an unreadable extension means for it. */
export function extensionTargets(extension: `0x${string}`, generations: readonly ResolvedGeneration[], chainId: number): ExtensionTarget[] {
  if (extension === "0x") return [];
  let f: ReturnType<typeof decodeExtensionFields>;
  try {
    f = decodeExtensionFields(extension);
  } catch {
    return [];
  }
  const slots: Array<[ExtensionSlot, `0x${string}`]> = [
    ["makingAmountGetter", f.makingAmountData],
    ["takingAmountGetter", f.takingAmountData],
    ["preInteraction", f.preInteractionData],
    ["postInteraction", f.postInteractionData],
  ];
  const out: ExtensionTarget[] = [];
  for (const [slot, field] of slots) {
    const address = targetOf(field);
    if (address === null) continue;
    // Only a JIT ADAPTER is a legitimate hook target among Cork's contracts: a pool manager, a
    // settler or a registry named in a hook slot is as foreign to a fill as a stranger's
    // contract (nothing in this repo ever builds such an order), so the role is checked, not
    // mere membership in the address book.
    const cork = classifyAddress(generations, address).filter((c) => c.role === "jitAdapter");
    if (cork.length > 0) {
      out.push({ slot, address, classification: "known", as: cork.map((c) => `${c.label} ${c.role}`).join(", ") });
      continue;
    }
    const settlement = classifySettlement(address, chainId);
    if (settlement === "current") {
      out.push({ slot, address, classification: "known", as: "fusion settlement (current)" });
      continue;
    }
    if (settlement === "legacy") {
      out.push({ slot, address, classification: "legacy", as: "fusion settlement (legacy layout)" });
      continue;
    }
    out.push({ slot, address, classification: "unknown" });
  }
  return out;
}

/** The targets a fill must NOT proceed against: the unknown HOOKS. Getters are deliberately not
 *  in this set — an unknown AMOUNT GETTER can only move the price, and the LOP enforces the
 *  taker's `maximumTakingAmount` on-chain (TakingAmountTooHigh), so the 2026-08-26 ruling stands:
 *  refuse the DERIVED cap, build under an EXPLICIT one, warn. No cap bounds what a HOOK does. */
export function foreignExtensionTargets(targets: readonly ExtensionTarget[]): ExtensionTarget[] {
  return targets.filter((t) => t.classification === "unknown" && (t.slot === "preInteraction" || t.slot === "postInteraction"));
}

export function describeForeignTargets(foreign: readonly ExtensionTarget[]): string {
  return foreign.map((t) => `${t.slot} → ${t.address}`).join("; ");
}
