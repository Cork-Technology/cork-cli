// One typed dispatch shared by the MCP server and the CLI (RFC: "MCP + CLI over one core").
// Pure/offline tools are fully implemented; chain-backed compute runs when an RPC + addresses
// are supplied, else returns an honest `unavailable` envelope; unimplemented phases return
// `unavailable` with a reason rather than a fabricated result [K1/K3].
// Split 2026-08-05: per-tool handler modules live in ./handlers/; this file keeps the runTool
// dispatch and re-exports the original public surface (external interface unchanged).
import { buildTeaching, type ChainId, ComputeInput, DecodeInput, Envelope, inputJsonSchema, MATURITY, PrepareOrdersInput, PreparePhoenixInput, QueryInput, REGISTRY, SCHEMA_VERSION, searchTools, SubmitInput, TOOL_EXAMPLES, toolByName, type ToolName, TrackInput } from "@cork/schemas";
import { computeMarketId } from "./marketid.ts";
import { type CorkActionParamMap } from "./bundle/actions.ts";
import { type Call, encodeMulticall } from "./bundle/bundler3.ts";
import { decodeBundle } from "./bundle/decode.ts";
import { summarizeBundle } from "./bundle/summary.ts";
import { canAutoFund, type FundingMode, fundingPlan } from "./bundle/funding.ts";
import { poolPreflightWarnings } from "./bundle/preflight.ts";
import { resolvePoolTokens } from "./chain/reads.ts";
import { verifyCreate2 } from "./create2.ts";
import { CREATE2_ATTESTATIONS, CREATE2_DEPLOYER } from "./config.ts";
import { chainReadFailed, envelope, getDep, getRpc, type HandlerContext, nowSecondsOf, ToolInputError, unavailable } from "./handlers/shared.ts";
import { ACTION_MAP, buildPhoenixCall, handlePhoenixAuthority } from "./handlers/phoenix.ts";
import { handleCompute } from "./handlers/compute.ts";
import { handleDecodeEvent, handleDecodeOrder, handleDecodeReceipt } from "./handlers/decode.ts";
import { handleQuery } from "./handlers/query.ts";
import { handlePrepareMarket } from "./handlers/prepare-market.ts";
import { handlePrepareOrders } from "./handlers/prepare-orders.ts";
import { handleTrack } from "./handlers/track.ts";
import { handleSubmit } from "./handlers/submit.ts";

export { ToolInputError, jsonSafe, type HandlerContext } from "./handlers/shared.ts";
export { KNOWN_FILTER_KEYS } from "./handlers/filters.ts";
export { resetRegistryBindingGuardCache } from "./handlers/registry.ts";
export { decimalToScaled } from "./handlers/submit.ts";


/** Validate + dispatch a tool call. Throws ToolInputError on schema failure. */
export async function runTool(name: string, rawInput: unknown, ctx: HandlerContext = {}): Promise<Envelope> {
  const def = toolByName(name);
  if (!def) throw new ToolInputError(name, `unknown tool: ${name}`);
  const parsed = def.input.safeParse(rawInput);
  if (!parsed.success) throw new ToolInputError(name, parsed.error.issues, buildTeaching(name as ToolName, parsed.error.issues, rawInput));
  const chainIdOf = (x: unknown): ChainId => (x as { chainId?: ChainId }).chainId ?? 1;

  switch (name) {
    case "cork_capabilities": {
      const input = parsed.data as { topic?: string; search?: string };
      if (input.topic === "verify") {
        // Independently re-derive each deployed address from (deployer, salt, initCodeHash) [C10].
        const verifications = CREATE2_ATTESTATIONS.map((a) => ({
          name: a.name,
          ...verifyCreate2({ deployer: CREATE2_DEPLOYER, salt: a.salt, initCodeHash: a.initCodeHash, expected: a.expected }),
          salt: a.salt,
          initCodeHash: a.initCodeHash,
        }));
        const allMatch = verifications.every((v) => v.match);
        return envelope({
          state: allMatch ? "ok" : "conflict",
          data: { deployer: CREATE2_DEPLOYER, verifications },
          chainId: 1,
          source: "config",
          ...(allMatch ? {} : { warnings: [{ code: "create2_mismatch", message: "a deployed address did not reproduce from its salt+initCodeHash" }] }),
          ctx,
        });
      }
      const card = (t: (typeof REGISTRY)[number]) => ({ name: t.name, cli: `ch ${t.cliPath.join(" ")}`, phase: t.phase, maturity: MATURITY[t.name], description: t.description, annotations: t.annotations });

      // search: natural-language query -> ranked tools with the best-matching VARIANT (token
      // scoring over names/descriptions/example titles + per-variant hint phrases; search.ts).
      if (input.search) {
        const ranked = searchTools(input.search);
        const matches = ranked.map((r) => {
          const t = toolByName(r.name)!;
          const variantMaturity = r.variant ? MATURITY[r.name]?.variants?.[r.variant] : undefined;
          return {
            ...card(t as (typeof REGISTRY)[number]),
            ...(r.variant !== undefined ? { variant: r.variant } : {}),
            ...(variantMaturity !== undefined ? { variantMaturity } : {}),
            examples: TOOL_EXAMPLES[r.name],
            inputSchema: inputJsonSchema(r.name),
          };
        });
        return envelope({ state: "ok", data: { query: input.search, matches }, chainId: 1, source: "config", ctx });
      }

      // topic: a tool name (with or without cork_ prefix) or cli leaf -> that tool's full doc.
      if (input.topic) {
        const key = input.topic.toLowerCase();
        const t = REGISTRY.find((x) => x.name.toLowerCase() === key || x.name.toLowerCase() === `cork_${key}` || x.cliPath.join(" ").toLowerCase() === key || x.cliPath[x.cliPath.length - 1]?.toLowerCase() === key);
        if (!t) return unavailable(1, "unknown_topic", `no tool matches topic '${input.topic}'; try search or omit args for the full list`, ctx);
        return envelope({ state: "ok", data: { ...card(t), examples: TOOL_EXAMPLES[t.name], inputSchema: inputJsonSchema(t.name), output: "Envelope" }, chainId: 1, source: "config", ctx });
      }

      const data = REGISTRY.map(card);
      return envelope({ state: "ok", data: { tools: data, schemaVersion: SCHEMA_VERSION }, chainId: 1, source: "config", ctx });
    }
    case "cork_decode": {
      const input = parsed.data as DecodeInput;
      const chainId = input.chainId ?? 1;
      if (input.kind === "order") return handleDecodeOrder(input, chainId, ctx);
      if (input.kind === "event") return handleDecodeEvent(input, chainId, ctx);
      if (input.kind === "receipt") return handleDecodeReceipt(input, chainId, ctx);
      if (typeof input.data !== "string") {
        throw new ToolInputError(name, "calldata decode requires a hex string");
      }
      let legs;
      try {
        legs = decodeBundle(input.data as `0x${string}`);
      } catch (err) {
        // Malformed top-level bytes are invalid INPUT (exit 2, teachable) — not an internal error.
        throw new ToolInputError(name, [{ path: ["data"], message: err instanceof Error ? err.message : "calldata does not decode as a Bundler3 multicall" }]);
      }
      // Plain-English rendering alongside the structured legs: these bytes usually arrive from
      // somewhere else, and "what will this DO" is the question being asked of them.
      const adapter = (await getDep(ctx, chainId)).dep?.corkAdapter;
      // Summary before the leg dump: a reader scanning the prose output wants the intent first.
      return envelope({ state: "ok", data: { kind: "calldata", summary: summarizeBundle(legs, { adapter }), legs }, chainId, source: "config", ctx });
    }
    case "cork_compute":
      return handleCompute(parsed.data as ComputeInput, ctx);
    case "cork_prepare_phoenix": {
      const input = parsed.data as PreparePhoenixInput;
      const { dep, depWarn } = await getDep(ctx, input.chainId);
      if (!dep) return unavailable(input.chainId, "unknown_deployment", `no known Cork deployment for chainId ${input.chainId}`, ctx);
      const { corkAdapter, bundler3 } = dep;
      if (!corkAdapter || !bundler3) {
        return unavailable(input.chainId, "unknown_deployment", `tx-path contracts (corkAdapter/bundler3) are not configured for chainId ${input.chainId} (partial deployment — read tools still work); pass ctx.deployment to override`, ctx);
      }
      const nowSecs = nowSecondsOf(ctx);
      // deadlineAt (absolute) pins the bundle bytes across retries [K2]; deadlineSeconds
      // (relative, default) re-anchors to the clock on each call.
      const deadline = input.deadlineAt !== undefined ? BigInt(input.deadlineAt) : nowSecs + BigInt(input.deadlineSeconds);
      if (input.action.type === "authority-onboard" || input.action.type === "authority-revoke") {
        return handlePhoenixAuthority(input, depWarn, dep, ctx);
      }
      const actionLeg = buildPhoenixCall(input.action, corkAdapter, deadline);
      const warnings: Array<{ code: string; message: string }> = [...depWarn];
      // deadlineAt is validated for FORMAT only by the schema; a past moment builds fine and can
      // only revert on-chain — disclose it (the sibling deadlineSeconds is bounded-future) [F19].
      if (input.deadlineAt !== undefined && deadline <= nowSecs) {
        warnings.push({ code: "would_revert", message: `deadlineAt ${deadline} is not in the future (now ${nowSecs}) — the bundle would revert its deadline check on-chain; pin a future absolute deadline for byte-stable retries` });
      }
      let funding: Call[] = [];
      let sweepBack: Call[] = [];
      // Filled in whenever we read the pool, so the bundle summary can name tokens by their role.
      let tokenRoles: Record<string, string> | undefined;
      const roleMapOf = (t: { collateral: string; reference: string; cst: string; cpt: string }): Record<string, string> => ({
        [t.collateral.toLowerCase()]: "collateral",
        [t.reference.toLowerCase()]: "reference",
        [t.cst.toLowerCase()]: "cST",
        [t.cpt.toLowerCase()]: "cPT",
      });
      const mode = input.fundingMode as FundingMode;

      if (mode === "pre-funded") {
        // Caller guarantees tokens already sit in the adapter — nothing to fund. But when an
        // explicit RPC is configured, run the same pool-existence/expiry pre-flight the funded
        // path gets [F19]: 'pre-funded' must not silently skip guards the sibling mode enforces.
        const poolId = (input.action as { poolId?: `0x${string}` }).poolId;
        if (ctx.rpcUrl && poolId) {
          const resolved = await getRpc(ctx, input.chainId);
          if (resolved) {
            try {
              const tokens = await resolvePoolTokens(resolved.client, dep.poolManager, poolId, ctx.atBlock);
              const ZERO = "0x0000000000000000000000000000000000000000";
              if (tokens.collateral === ZERO || tokens.cst === ZERO || tokens.cpt === ZERO) {
                return unavailable(input.chainId, "pool_not_found", `pool ${poolId} does not exist on chainId ${input.chainId} (market returned a zeroed struct); check the poolId/chainId pairing`, ctx);
              }
              tokenRoles = roleMapOf(tokens);
              // 'pre-funded' gets the same guards as the funded path — it must not silently skip
              // checks its sibling enforces [F19].
              warnings.push(
                ...(await poolPreflightWarnings({
                  client: resolved.client,
                  poolManager: dep.poolManager,
                  whitelistManager: dep.whitelistManager,
                  corkAdapter,
                  poolId,
                  actionType: input.action.type,
                  account: input.account,
                  expiryTimestamp: tokens.expiryTimestamp,
                  nowSeconds: nowSecs,
                  atBlock: ctx.atBlock,
                })),
              );
            } catch {
              // best-effort — pre-funded byte-building stays offline-capable by design
            }
          }
        }
      } else if (!canAutoFund(input.action.type)) {
        warnings.push({ code: "manual_funding", message: `'${input.action.type}' has no auto-funding model in this iteration; fund the adapter manually or use fundingMode 'pre-funded'.` });
      } else if (!ctx.rpcUrl) {
        warnings.push({
          code: "funding_needs_rpc",
          message: `Funding leg for '${input.action.type}' needs an RPC to resolve pool token addresses; re-run with an RPC or use fundingMode 'pre-funded'. Bundle contains the action leg only.`,
        });
      } else {
        // Explicit RPC only (funding stays offline-by-default); routed through the resolver hook so
        // tests can stub the client, and guarded like every other chain read — a revert/transport
        // failure must map to an envelope, never escape raw (viem errors embed the RPC URL).
        const resolved = await getRpc(ctx, input.chainId);
        if (!resolved) return unavailable(input.chainId, "requires_rpc", "funding-leg resolution could not reach the configured RPC", ctx);
        const poolId = (input.action as { poolId: `0x${string}` }).poolId;
        let tokens;
        try {
          tokens = await resolvePoolTokens(resolved.client, dep.poolManager, poolId, ctx.atBlock);
        } catch (err) {
          return chainReadFailed(input.chainId, err, [], ctx, resolved);
        }
        // A nonexistent pool does NOT revert here — market() returns a zeroed struct. Refuse to
        // build funding legs against the zero address instead of emitting a plausible-looking
        // bundle that can only revert on-chain.
        const ZERO = "0x0000000000000000000000000000000000000000";
        if (tokens.collateral === ZERO || tokens.cst === ZERO || tokens.cpt === ZERO) {
          return unavailable(input.chainId, "pool_not_found", `pool ${poolId} does not exist on chainId ${input.chainId} (market returned a zeroed struct); check the poolId/chainId pairing`, ctx);
        }
        tokenRoles = roleMapOf(tokens);
        // Pre-flight guards [§5.4]: expiry, pause (global + per-pool bit), and whitelist. All
        // build-and-warn — a bundle that can only revert is still returned, clearly labelled.
        warnings.push(
          ...(await poolPreflightWarnings({
            client: resolved.client,
            poolManager: dep.poolManager,
            whitelistManager: dep.whitelistManager,
            corkAdapter,
            poolId,
            actionType: input.action.type,
            account: input.account,
            expiryTimestamp: tokens.expiryTimestamp,
            nowSeconds: nowSecondsOf(ctx),
            atBlock: ctx.atBlock,
          })),
        );
        // Sweep-back [F13]: auto-funding moves the caller's slippage CAP into the adapter, but the
        // pool consumes only the true amount. The delta is not just stranded — CoreAdapter's
        // erc20Transfer never checks receiver==initiator() and Bundler3.multicall is public, so
        // anyone can take it in a later block. Return it to the declared initiator in-bundle.
        const plan = fundingPlan(input.action, tokens, corkAdapter, mode, input.account);
        funding = plan.legs;
        sweepBack = plan.sweepLegs;
        if (plan.note) warnings.push({ code: "owner_managed_funding", message: plan.note });
        if (plan.sweepNote) warnings.push({ code: "sweep_back_skipped", message: plan.sweepNote });
        if (sweepBack.length) {
          warnings.push({
            code: "sweep_back",
            message: `this bundle ends with ${sweepBack.length} sweep-back leg(s) returning any unspent balance of ${plan.sweptTokens.join(", ")} to ${input.account}, because auto-funding moved a slippage CAP (not the exact amount) into the adapter. Each sweeps the adapter's FULL balance of that token (uint256.max sentinel), so it also returns any residual an earlier bundle abandoned there — that balance was already takeable by anyone. A zero residual is a no-op, not a revert.`,
          });
        }
      }

      const bundle = [...funding, actionLeg, ...sweepBack];
      const multicall = encodeMulticall(bundle);
      // What the caller is about to sign, in words. Token roles come from the pool read when we
      // did one, so amounts are attributed to "collateral"/"cST" rather than bare addresses.
      const summary = summarizeBundle(decodeBundle(multicall), { tokenRoles, account: input.account, adapter: corkAdapter });
      return envelope({
        state: "ok",
        data: { bundler3, corkAdapter, deadline, action: ACTION_MAP[input.action.type], fundingMode: mode, fundingLegs: funding.length, sweepBackLegs: sweepBack.length, summary, bundle, multicall, clientRequestId: input.clientRequestId },
        chainId: input.chainId,
        source: ctx.rpcUrl && funding.length ? "chain" : "config",
        warnings,
        ctx,
      });
    }
    case "cork_query":
      return handleQuery(parsed.data as QueryInput, ctx);
    case "cork_track":
      return handleTrack(parsed.data as TrackInput, ctx);
    case "cork_prepare_orders":
      return handlePrepareOrders(parsed.data as PrepareOrdersInput, ctx);
    case "cork_prepare_market":
      return handlePrepareMarket(parsed.data as Parameters<typeof handlePrepareMarket>[0], ctx);
    case "cork_submit":
      return handleSubmit(parsed.data as SubmitInput, ctx);
    default:
      return unavailable(chainIdOf(parsed.data), "phase_gated", `${name} is not implemented in this iteration`, ctx);
  }
}

export { computeMarketId };
export type { CorkActionParamMap };

