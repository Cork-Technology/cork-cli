// Recursive Bundler3 bundle decoder: unwrap multicall/reenter Call[] and identify each leg.
// Cork legs are decoded to {action, params}; nested bundles recurse; unknown legs are surfaced
// raw (with selector) rather than dropped — a decoder that silently hides legs is a footgun.
import { decodeFunctionData, toFunctionSelector } from "viem";
import { corkAdapterAbi } from "./corkAdapterAbi.ts";
import { bundlerLegAbi } from "./legs.ts";
import { decodeMulticall, isBundlerMulticall, type Call } from "./bundler3.ts";

export type DecodedLeg =
  | { kind: "cork"; to: `0x${string}`; action: string; params: unknown; value: bigint; skipRevert: boolean }
  | { kind: "leg"; to: `0x${string}`; fn: string; args: readonly unknown[]; value: bigint; skipRevert: boolean }
  | { kind: "bundle"; to: `0x${string}`; legs: DecodedLeg[]; value: bigint; skipRevert: boolean }
  | { kind: "unknown"; to: `0x${string}`; selector: `0x${string}`; data: `0x${string}`; value: bigint; skipRevert: boolean };

const selectorMap = (abi: readonly unknown[]): Map<string, string> =>
  new Map(
    (abi as Array<{ type: string; name: string }>)
      .filter((f) => f.type === "function")
      .map((f) => [toFunctionSelector(f as never).toLowerCase(), f.name]),
  );

// selector -> name, computed once from each ABI.
const CORK_SELECTORS = selectorMap(corkAdapterAbi);
const LEG_SELECTORS = selectorMap(bundlerLegAbi);

function decodeCall(c: Call): DecodedLeg {
  const selector = c.data.slice(0, 10).toLowerCase() as `0x${string}`;
  if (isBundlerMulticall(c.data)) {
    return { kind: "bundle", to: c.to, legs: decodeMulticall(c.data).map(decodeCall), value: c.value, skipRevert: c.skipRevert };
  }
  if (CORK_SELECTORS.has(selector)) {
    const { functionName, args } = decodeFunctionData({ abi: corkAdapterAbi, data: c.data });
    return { kind: "cork", to: c.to, action: functionName, params: args[0], value: c.value, skipRevert: c.skipRevert };
  }
  if (LEG_SELECTORS.has(selector)) {
    const { functionName, args } = decodeFunctionData({ abi: bundlerLegAbi, data: c.data });
    return { kind: "leg", to: c.to, fn: functionName, args: args as readonly unknown[], value: c.value, skipRevert: c.skipRevert };
  }
  return { kind: "unknown", to: c.to, selector, data: c.data, value: c.value, skipRevert: c.skipRevert };
}

/** Decode top-level Bundler3.multicall calldata into a tree of legs. */
export function decodeBundle(multicallData: `0x${string}`): DecodedLeg[] {
  if (!isBundlerMulticall(multicallData)) {
    throw new Error("decodeBundle: not a Bundler3 multicall/reenter calldata");
  }
  return decodeMulticall(multicallData).map(decodeCall);
}
