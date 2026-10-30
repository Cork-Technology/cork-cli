// Test-only endpoints: runtime CORK_RPC_URL* is deliberately cleared by vitest.setup.ts.
// Keep automatic discovery tests on the core resolver; configured checks never fall back to it.
import { it } from "vitest";
import { resolveRpc, runTool, type HandlerContext } from "@cork/core";
import type { Envelope } from "@cork/schemas";

class MissingLiveRpc extends Error {}

export function requiredLiveRpcUrl(chainId: number): string {
  const key = `CORK_TEST_RPC_URL_${chainId}`;
  const url = process.env[key]?.trim();
  if (!url) throw new MissingLiveRpc(`Configured live RPC check requires nonblank ${key}; automatic fallback is disabled`);
  return url;
}

/** Redact only AFTER the entire test body finishes. Core readers and the independent raw
 *  reference retain original viem clients/errors, including revert classification and data.
 *  Never attach the raw error/cause: normalized URLs can bypass GitHub's exact secret masking. */
export async function configuredCheck(check: () => unknown | Promise<unknown>) {
  try { return await check(); }
  catch (error) {
    if (error instanceof MissingLiveRpc) throw error;
    const safeNames = ["AssertionError", "RpcChainMismatchError", "RpcChainVerificationError", "TimeoutError", "HttpRequestError", "ContractFunctionExecutionError"];
    const kind = error instanceof Error && safeNames.includes(error.name) ? error.name : "Error";
    throw new Error(`Configured live RPC check failed (${kind}); private endpoint/provider details redacted`);
  }
}

export function configuredIt(name: string, check: () => unknown | Promise<unknown>, timeout?: number) {
  return it(name, () => configuredCheck(check), timeout);
}

export async function resolveConfiguredRpc(chainId: number) {
  const resolved = await resolveRpc(chainId, requiredLiveRpcUrl(chainId));
  if (!resolved) throw new Error(`Configured live RPC did not resolve for chain ${chainId}; automatic fallback is disabled`);
  return resolved;
}

/** Handler and independent raw reference use the same configured chain endpoint but retain
 *  their separate implementations/ABIs. This does not configure automatic-discovery tests. */
export async function runConfiguredTool(name: string, input: unknown, ctx: HandlerContext = {}): Promise<Envelope> {
  const chainId = input && typeof input === "object" && "chainId" in input && typeof input.chainId === "number" ? input.chainId : 1;
  return runTool(name, input, { ...ctx, rpcUrl: requiredLiveRpcUrl(chainId) });
}
