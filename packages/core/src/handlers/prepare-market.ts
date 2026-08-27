// Split from handlers.ts (2026-08-05): prepare-market handlers — one typed dispatch, per-tool modules.
// Declarations are moved byte-identically; see handlers.ts for the runTool dispatch.
import { type ChainId, Envelope, executionEthTransaction } from "@cork/schemas";
import { buildDeployFixedRateOracleCall, buildDeployOracleCall, type OracleModeName } from "../market-registry.ts";
import { resolveMarketRegistry } from "../config-remote.ts";
import { approvedImplementationGuard, PREPARE_MARKET_IMPLEMENTATION_ROLES } from "../implementations.ts";
import { envelope, getRpc, type HandlerContext, revertReason, rpcWarn, unavailable } from "./shared.ts";
import { probeFixedOracle, probePairWrapper } from "./registry.ts";

/** cork_prepare_market: unsigned oracle-infrastructure txs against the 2.1.0 registry —
 *  deploy-oracle = MarketRegistry.deploy(ca, ref, mode) (mode-keyed: one pair can hold a PRICE
 *  and a NAV wrapper at different addresses); deploy-fixed-oracle =
 *  MarketRegistry.deployFixedRateOracle(rate) (keyed on the RATE, no pair). Both are
 *  permissionless + idempotent on-chain; the pre-flight read is best-effort disclosure. */

/** The `oracle:{address,deployed}` status block — the same shape cork_query registry-oracle and
 *  derive-cork-pool report, so the three surfaces cannot drift. Empty when no RPC resolved. */
type OracleStatus = { oracle?: { address: `0x${string}`; deployed: boolean } };

export async function handlePrepareMarket(
  input: { chainId: ChainId; clientRequestId: string; action: { type: "deploy-oracle"; collateralAsset: `0x${string}`; referenceAsset: `0x${string}`; mode?: "price" | "nav" } | { type: "deploy-fixed-oracle"; rate: string }; format: "concise" | "full" },
  ctx: HandlerContext,
): Promise<Envelope> {
  const chainId = input.chainId;
  const { marketRegistry: mr, warning } = await resolveMarketRegistry(chainId);
  if (!mr) {
    return unavailable(chainId, "unknown_deployment", `no MarketRegistry configured for chainId ${chainId} — the registry stack is live on Arbitrum One and Base (42161, 8453)`, ctx);
  }
  const warnings: Array<{ code: string; message: string }> = warning ? [warning] : [];
  const a = input.action;
  const resolved = await getRpc(ctx, chainId);
  // Interface-first guard, scoped to the one contract this tx executes (the registry):
  // build-and-warn, same posture as the deployability pre-check below.
  if (resolved) warnings.push(...(await approvedImplementationGuard(resolved.client, chainId, { roles: PREPARE_MARKET_IMPLEMENTATION_ROLES, ...(ctx.atBlock !== undefined ? { atBlock: ctx.atBlock } : {}) })));
  // rpcWarn is prepended at ENVELOPE construction, not pushed here: the client fails over
  // in-call (mutating `resolved`), and the disclosure must describe the endpoint that served
  // the pre-checks.

  if (a.type === "deploy-fixed-oracle") {
    const rate = BigInt(a.rate);
    if (rate === 0n) return unavailable(chainId, "invalid_order_terms", "a zero fixed rate cannot have an oracle — the FixedRateOracle constructor reverts on 0; sending this tx would revert", ctx);
    const calldata = buildDeployFixedRateOracleCall(rate);
    let status: OracleStatus = {};
    if (resolved) {
      try {
        const fixed = await probeFixedOracle(resolved.client, mr.registry, rate);
        status = { oracle: { address: fixed.address, deployed: fixed.deployed } };
        if (fixed.deployed) warnings.push({ code: "oracle_already_deployed", message: `the fixed-rate oracle for rate ${rate} already exists at ${fixed.address} (CREATE2-salted by the rate: one oracle per rate per chain) — the tx is a safe no-op (deploy is idempotent)` });
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
      warnings: [...(resolved ? rpcWarn(resolved) : []), ...warnings],
      ctx,
    });
  }

  const modeName: OracleModeName = a.mode ?? "price";
  const modeNote = a.mode === undefined ? { modeNote: "no mode given — defaulted to 'price'; oracles are MODE-KEYED in 2.1.0 (one pair can hold a price AND a nav wrapper at different addresses), pass mode:'nav' when you mean nav" } : {};
  const calldata = buildDeployOracleCall(a.collateralAsset, a.referenceAsset, modeName);

  // Best-effort status read (calldata building is pure; the tx is safe either way).
  let status: OracleStatus = {};
  if (resolved) {
    try {
      // probePairWrapper is the SAME probe cork_query registry-oracle / derive-cork-pool run —
      // shared logic, not just a shared output shape. A lookupWrapper transport failure now
      // lands in the catch as chain_read_failed (it used to be mislabeled oracle_not_deployable,
      // which is a deployability VERDICT this indeterminate read cannot support).
      const probe = await probePairWrapper(resolved.client, mr.registry, a.collateralAsset, a.referenceAsset, modeName);
      if (probe.address !== null && probe.deployed) {
        status = { oracle: { address: probe.address, deployed: true } };
        warnings.push({ code: "oracle_already_deployed", message: `this pair's ${modeName} oracle already exists at ${probe.address} — the tx is a safe no-op (deploy is idempotent and returns the recorded address)` });
      } else if (probe.address !== null) {
        status = { oracle: { address: probe.address, deployed: false } };
      } else {
        warnings.push({ code: "oracle_not_deployable", message: `the deploy simulation reverted: ${probe.reason}. Sending this tx would revert` });
      }
    } catch (err) {
      warnings.push({ code: "chain_read_failed", message: `the oracle status pre-check failed (${revertReason(err)}) — the calldata is exact regardless` });
    }
  } else {
    warnings.push({ code: "funding_needs_rpc", message: "no RPC resolved — the deployability pre-check was skipped; the calldata is exact regardless" });
  }
  return envelope({
    state: "ok",
    data: { kind: "deploy-oracle", to: mr.registry, calldata, value: "0", collateralAsset: a.collateralAsset, referenceAsset: a.referenceAsset, mode: modeName, ...modeNote, ...status, execution: executionEthTransaction(), clientRequestId: input.clientRequestId },
    chainId,
    source: resolved ? "chain" : "config",
    warnings: [...(resolved ? rpcWarn(resolved) : []), ...warnings],
    ctx,
  });
}
