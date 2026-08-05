// Split from handlers.ts (2026-08-05): prepare-market handlers — one typed dispatch, per-tool modules.
// Declarations are moved byte-identically; see handlers.ts for the runTool dispatch.
import { type ChainId, Envelope, executionEthTransaction } from "@cork/schemas";
import { buildDeployFixedRateOracleCall, buildDeployOracleCall, marketRegistryAbi, ORACLE_MODE, type OracleModeName } from "../market-registry.ts";
import { resolveMarketRegistry } from "../config-remote.ts";
import { envelope, getRpc, type HandlerContext, revertReason, rpcWarn, unavailable, ZERO_ADDR } from "./shared.ts";


/** cork_prepare_market: unsigned oracle-infrastructure txs against the 2.1.0 registry —
 *  deploy-wrapper = MarketRegistry.deploy(ca, ref, mode) (mode-keyed: one pair can hold a PRICE
 *  and a NAV wrapper at different addresses); deploy-fixed-oracle =
 *  MarketRegistry.deployFixedRateOracle(rate) (keyed on the RATE, no pair). Both are
 *  permissionless + idempotent on-chain; the pre-flight read is best-effort disclosure. */
export async function handlePrepareMarket(
  input: { chainId: ChainId; clientRequestId: string; action: { type: "deploy-wrapper"; collateralAsset: `0x${string}`; referenceAsset: `0x${string}`; mode?: "price" | "nav" } | { type: "deploy-fixed-oracle"; rate: string }; format: "concise" | "full" },
  ctx: HandlerContext,
): Promise<Envelope> {
  const chainId = input.chainId;
  const { marketRegistry: mr, warning } = await resolveMarketRegistry(chainId);
  if (!mr) {
    return unavailable(chainId, "unknown_deployment", `no MarketRegistry configured for chainId ${chainId} — the registry is live on Arbitrum One (42161)`, ctx);
  }
  const warnings: Array<{ code: string; message: string }> = warning ? [warning] : [];
  const a = input.action;
  const resolved = await getRpc(ctx, chainId);
  if (resolved) warnings.push(...rpcWarn(resolved));
  const reg = { address: mr.registry, abi: marketRegistryAbi } as const;

  if (a.type === "deploy-fixed-oracle") {
    const rate = BigInt(a.rate);
    if (rate === 0n) return unavailable(chainId, "invalid_order_terms", "a zero fixed rate cannot have an oracle — the FixedRateOracle constructor reverts on 0; sending this tx would revert", ctx);
    const calldata = buildDeployFixedRateOracleCall(rate);
    let status: Record<string, unknown> = {};
    if (resolved) {
      try {
        const predicted = await resolved.client.readContract({ ...reg, functionName: "predictFixedRateOracle", args: [rate] });
        const code = await resolved.client.getCode({ address: predicted }).catch(() => undefined);
        const deployed = code !== undefined && code !== "0x";
        status = { oracle: { address: predicted, deployed } };
        if (deployed) warnings.push({ code: "oracle_already_deployed", message: `the fixed-rate oracle for rate ${rate} already exists at ${predicted} (CREATE2-salted by the rate: one oracle per rate per chain) — the tx is a safe no-op (deploy is idempotent)` });
      } catch (err) {
        warnings.push({ code: "chain_read_failed", message: `the predictFixedRateOracle pre-check failed (${revertReason(err)}) — the calldata is exact regardless` });
      }
    } else {
      warnings.push({ code: "funding_needs_rpc", message: "no RPC resolved — the deployability pre-check was skipped; the calldata is exact regardless" });
    }
    return envelope({
      state: "ok",
      data: { kind: "deploy-fixed-oracle", to: mr.registry, calldata, value: "0", rate, scale: "rate is ABSOLUTE, 1e18 = 1.0", ...status, execution: executionEthTransaction(), clientRequestId: input.clientRequestId },
      chainId,
      source: resolved ? "chain" : "config",
      warnings,
      ctx,
    });
  }

  const modeName: OracleModeName = a.mode ?? "price";
  const modeNote = a.mode === undefined ? { modeNote: "no mode given — defaulted to 'price'; oracles are MODE-KEYED in 2.1.0 (one pair can hold a price AND a nav wrapper at different addresses), pass mode:'nav' when you mean nav" } : {};
  const calldata = buildDeployOracleCall(a.collateralAsset, a.referenceAsset, modeName);

  // Best-effort status read (calldata building is pure; the tx is safe either way).
  let status: Record<string, unknown> = {};
  if (resolved) {
    try {
      const wrapper = await resolved.client.readContract({ ...reg, functionName: "lookupWrapper", args: [a.collateralAsset, a.referenceAsset, ORACLE_MODE[modeName]] });
      if (wrapper !== ZERO_ADDR) {
        // Same oracle:{address,deployed} shape as cork_query registry-oracle / market-predict.
        status = { oracle: { address: wrapper, deployed: true } };
        warnings.push({ code: "oracle_already_deployed", message: `this pair's ${modeName} oracle already exists at ${wrapper} — the tx is a safe no-op (deploy is idempotent and returns the recorded address)` });
      } else {
        const sim = await resolved.client.simulateContract({ ...reg, functionName: "deploy", args: [a.collateralAsset, a.referenceAsset, ORACLE_MODE[modeName]] });
        status = { oracle: { address: sim.result, deployed: false } };
      }
    } catch (err) {
      warnings.push({ code: "oracle_not_deployable", message: `the deploy simulation reverted (${revertReason(err)}) — typically an unregistered asset, a missing source for this mode, or no conversion path; sending this tx would revert. Check cork_query registry-assets / registry-oracle` });
    }
  } else {
    warnings.push({ code: "funding_needs_rpc", message: "no RPC resolved — the deployability pre-check was skipped; the calldata is exact regardless" });
  }
  return envelope({
    state: "ok",
    data: { kind: "deploy-wrapper", to: mr.registry, calldata, value: "0", collateralAsset: a.collateralAsset, referenceAsset: a.referenceAsset, mode: modeName, ...modeNote, ...status, execution: executionEthTransaction(), clientRequestId: input.clientRequestId },
    chainId,
    source: resolved ? "chain" : "config",
    warnings,
    ctx,
  });
}
