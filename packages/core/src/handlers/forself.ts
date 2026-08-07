// ForSelf-mode prepare handlers: emit unsigned artifacts that call an INTEGRATOR-DEPLOYED
// Cork ForSelf adapter (cork-periphery shape) instead of the Bundler3 / raw-LOP paths —
// the artifact a parameter-blind session-key wallet (the Zyfai integration) signs. The
// adapter address is caller-supplied integrator config, never a Cork deployment; because the
// caller will be granting that address token allowances, its on-chain bindings (the pinned
// pool manager, and the pinned LOP on the fill surface) are verified whenever an RPC
// resolves, and a mismatch is a CONFLICT, not a warning.
import type { PublicClient } from "viem";
import { type ChainId, Envelope, executionEthTransaction, type PreparePhoenixInput } from "@cork/schemas";
import { buildFillOrderForSelfCall, buildPoolForSelfCall, forSelfBindingAbi } from "../forself.ts";
import { decodeJitExtension } from "../market-registry.ts";
import { buildTakerFill } from "../orders.ts";
import type { SignedLopOrder } from "../datasources/venue.ts";
import { resolvePoolTokens } from "../chain/reads.ts";
import { whitelistManagerAbi } from "../chain/abis.ts";
import { poolPreflightWarnings } from "../bundle/preflight.ts";
import { decodeSingleCall } from "../bundle/decode.ts";
import { summarizeBundle } from "../bundle/summary.ts";
import { envelope, getDep, getRpc, type HandlerContext, isTransportFailure, nowSecondsOf, revertReason, ToolInputError, unavailable } from "./shared.ts";

const ZERO = "0x0000000000000000000000000000000000000000";

type Warning = { code: string; message: string };

/** The wrapper's market binding, mirrored: the order must trade one of the pool's share
 *  tokens (cST or cPT) against one of its cash legs (collateral or reference), either
 *  direction. ONE comparator shared by every call site (mutation-probe doctrine). */
export function forSelfPairAllowed(
  tokens: { collateral: string; reference: string; cst: string; cpt: string },
  makerAsset: string,
  takerAsset: string,
): boolean {
  const m = makerAsset.toLowerCase();
  const t = takerAsset.toLowerCase();
  const isShare = (a: string) => a === tokens.cst.toLowerCase() || a === tokens.cpt.toLowerCase();
  const isCash = (a: string) => a === tokens.collateral.toLowerCase() || a === tokens.reference.toLowerCase();
  return (isShare(m) && isCash(t)) || (isCash(m) && isShare(t));
}

/** Verify a caller-supplied ForSelf adapter's pinned-protocol bindings on-chain. `wantLop`
 *  distinguishes the fill surface (combined/LOP adapters expose LOP()) from the pool-only
 *  surface (CORK() only). Returns a conflict envelope, warnings, or nothing to report —
 *  plus `callerGate`, the adapter's GENERATION: `true` when it exposes `WHITELIST()`
 *  (the caller-gate generation, which enforces isWhitelisted(poolId, msg.sender) on
 *  every entrypoint), `false` when the view reverts (a pre-gate deployment — legitimate,
 *  e.g. the 2026-08-07 shadow instance), `undefined` when transport left it unknowable.
 *  A `WHITELIST()` that ANSWERS but names a different whitelist manager than the chain's
 *  deployment config is a binding conflict like any other: the caller gate would consult
 *  the wrong list. */
export async function verifyForSelfBindings(args: {
  client: PublicClient | null;
  ctx: HandlerContext;
  chainId: ChainId;
  adapter: `0x${string}`;
  poolManager: `0x${string}`;
  lop?: `0x${string}` | undefined;
  whitelistManager?: `0x${string}` | undefined;
}): Promise<{ gate?: Envelope; warnings: Warning[]; callerGate?: boolean | undefined }> {
  const { client, ctx, chainId, adapter, poolManager, lop, whitelistManager } = args;
  const warnings: Warning[] = [];
  const unverified = (why: string): { warnings: Warning[] } => {
    warnings.push({
      code: "chain_read_failed",
      message: `${why} — the ForSelf adapter ${adapter} could NOT be verified against its pinned protocols. You are about to grant it a token allowance: independently confirm its CORK()${lop ? "/LOP()" : ""} bindings before signing`,
    });
    return { warnings };
  };
  if (!client) return unverified("no RPC resolved");
  // Attribution discipline: only a DEFINITIVE on-chain answer may accuse the adapter. A
  // transport failure is indeterminate and discloses instead — accusing an integrator's
  // real adapter because an RPC blipped would be a false alarm with an allowance at stake.
  let code: string | undefined;
  try {
    code = await client.getCode({ address: adapter });
  } catch {
    return unverified("the adapter's code could not be read");
  }
  if (code === undefined || code === "0x") {
    return {
      gate: envelope({
        state: "conflict",
        data: { adapter },
        chainId,
        source: "chain",
        warnings: [{ code: "adapter_binding_mismatch", message: `there is NO CONTRACT at ${adapter} on chainId ${chainId} — an allowance/tx to it would be irrecoverable. Verify the adapter address with your integrator; no artifact was built` }],
        ctx,
      }),
      warnings,
    };
  }
  // All binding reads issued together (one multicall round trip on known chains). The
  // WHITELIST() probe rides along but keeps its own error classification: unlike CORK/LOP
  // — whose refusal means "not a ForSelf adapter" — its refusal identifies the pre-gate
  // GENERATION, so it must never trip the shared catch below.
  let wlProbe: { kind: "answered"; value: string } | { kind: "refused" } | { kind: "transport" };
  let boundCork: string;
  let boundLop: string | undefined;
  try {
    [boundCork, boundLop, wlProbe] = await Promise.all([
      client.readContract({ address: adapter, abi: forSelfBindingAbi, functionName: "CORK" }),
      lop ? client.readContract({ address: adapter, abi: forSelfBindingAbi, functionName: "LOP" }) : Promise.resolve(undefined),
      client
        .readContract({ address: adapter, abi: forSelfBindingAbi, functionName: "WHITELIST" })
        .then((value): typeof wlProbe => ({ kind: "answered", value }))
        .catch((err): typeof wlProbe => ({ kind: isTransportFailure(err) ? "transport" : "refused" })),
    ]);
    const corkOk = boundCork.toLowerCase() === poolManager.toLowerCase();
    const lopOk = lop === undefined || (boundLop !== undefined && boundLop.toLowerCase() === lop.toLowerCase());
    if (!corkOk || !lopOk) {
      return {
        gate: envelope({
          state: "conflict",
          data: { adapter, expected: { poolManager, ...(lop ? { lop } : {}) }, onChain: { cork: boundCork, ...(boundLop !== undefined ? { lop: boundLop } : {}) } },
          chainId,
          source: "chain",
          warnings: [{ code: "adapter_binding_mismatch", message: `the ForSelf adapter ${adapter} is bound to a DIFFERENT ${corkOk ? "LOP" : "pool manager"} than this tool's ${chainId} deployment config — an allowance to it would fund the wrong protocol stack. Do not sign; verify the adapter address with your integrator` }],
          ctx,
        }),
        warnings,
      };
    }
  } catch (err) {
    if (isTransportFailure(err)) return unverified(`the binding reads failed in transport (${revertReason(err)})`);
    // The contract itself refused the views — that is the chain's own answer.
    return {
      gate: envelope({
        state: "conflict",
        data: { adapter },
        chainId,
        source: "chain",
        warnings: [{ code: "adapter_binding_mismatch", message: `the contract at ${adapter} did not answer the ForSelf binding views (CORK()${lop ? "/LOP()" : ""}): ${revertReason(err)} — it is not a Cork ForSelf adapter. You would be granting an allowance to an unverified contract; no artifact was built` }],
        ctx,
      }),
      warnings,
    };
  }

  // Resolve the generation probe — OPTIONAL by design: `WHITELIST()` only exists on the
  // caller-gate generation, and a refusal is a legitimate older deployment, not an
  // accusation; a transport blip proves nothing either way (attribution discipline).
  if (wlProbe.kind === "answered") {
    const boundWl = wlProbe.value;
    if (whitelistManager !== undefined && boundWl.toLowerCase() !== whitelistManager.toLowerCase()) {
      return {
        gate: envelope({
          state: "conflict",
          data: { adapter, expected: { whitelistManager }, onChain: { whitelist: boundWl } },
          chainId,
          source: "chain",
          warnings: [{ code: "adapter_binding_mismatch", message: `the ForSelf adapter ${adapter} pins a DIFFERENT WhitelistManager (${boundWl}) than this tool's ${chainId} deployment config (${whitelistManager}) — its caller gate would consult the wrong whitelist. Do not sign; verify the adapter address with your integrator` }],
          ctx,
        }),
        warnings,
      };
    }
    return { warnings, callerGate: true };
  }
  return { warnings, callerGate: wlProbe.kind === "refused" ? false : undefined };
}

/** The informational disclosure every ForSelf artifact carries. */
export function forSelfNotice(adapter: `0x${string}`, allowanceText: string): Warning {
  return {
    code: "for_self_artifact",
    message: `this artifact calls the integrator-deployed ForSelf adapter ${adapter} — outputs are structurally delivered to the CALLING account (no receiver parameter exists), and the adapter is custody-free (pulls, spends, sweeps back the remainder in one transaction). Approve ${allowanceText} to the ADAPTER itself, not to the pool manager or the LOP`,
  };
}

/** cork_prepare_orders taker-fill + forSelf: the unsigned fill as fillOrderForSelf calldata. */
export async function prepareForSelfTakerFill(args: {
  ctx: HandlerContext;
  chainId: ChainId;
  account: `0x${string}`;
  clientRequestId: string;
  lop: `0x${string}`;
  forSelf: { adapter: `0x${string}`; poolId: `0x${string}`; deadlineSeconds: number; deadlineAt?: string | undefined };
  signed: SignedLopOrder;
  localOrderHash: `0x${string}`;
  fillMakingAmount?: bigint | undefined;
  maximumTakingAmount?: bigint | undefined;
  auctionCap?: bigint | undefined;
  auctionData?: Record<string, unknown> | undefined;
  priorWarnings: Warning[];
}): Promise<Envelope> {
  const { ctx, chainId, account, lop, forSelf, signed, auctionData, priorWarnings } = args;
  const nowSecs = nowSecondsOf(ctx);
  const deadline = forSelf.deadlineAt !== undefined ? BigInt(forSelf.deadlineAt) : nowSecs + BigInt(forSelf.deadlineSeconds);
  const warnings: Warning[] = [...priorWarnings];
  if (forSelf.deadlineAt !== undefined && deadline <= nowSecs) {
    warnings.push({ code: "would_revert", message: `deadlineAt ${deadline} is not in the future (now ${nowSecs}) — the wrapper reverts DeadlineExceeded; pin a future absolute deadline for byte-stable retries` });
  }

  // Amount validation + derivation via the SAME rules as the raw fill path (zero-making,
  // over-ask clamp, all-or-nothing partial refusal) — one semantics, two encoders.
  let derived: ReturnType<typeof buildTakerFill>;
  try {
    derived = buildTakerFill({
      order: signed.order,
      signature: signed.signature,
      makerAccountType: signed.makerAccountType,
      taker: account,
      extension: signed.extension,
      ...(args.fillMakingAmount !== undefined ? { fillMakingAmount: args.fillMakingAmount } : {}),
      ...(args.maximumTakingAmount !== undefined ? { maximumTakingAmount: args.maximumTakingAmount } : args.auctionCap !== undefined ? { maximumTakingAmount: args.auctionCap } : {}),
    });
  } catch (err) {
    return unavailable(chainId, "invalid_order_terms", err instanceof Error ? err.message : "the resting order cannot be filled by this variant", ctx);
  }
  const cap = args.maximumTakingAmount ?? args.auctionCap ?? BigInt(derived.requiredTakingAmount);

  // Bindings + pool coherence, best-effort over whatever RPC resolves. Binding mismatch is
  // a hard conflict (the caller is about to approve tokens to this address).
  const { dep } = await getDep(ctx, chainId);
  const resolved = dep ? await getRpc(ctx, chainId) : null;
  if (!dep) {
    warnings.push({ code: "unknown_deployment", message: `no Cork deployment configured for chainId ${chainId} — the ForSelf adapter's CORK() binding and the pool coherence pre-flight were SKIPPED; verify the adapter independently before granting it an allowance` });
  }
  const bind: { gate?: Envelope; warnings: Warning[]; callerGate?: boolean | undefined } = dep
    ? await verifyForSelfBindings({ client: resolved?.client ?? null, ctx, chainId, adapter: forSelf.adapter, poolManager: dep.poolManager, lop, whitelistManager: dep.whitelistManager })
    : { warnings: [] };
  if (bind.gate) return bind.gate;
  warnings.push(...bind.warnings);
  // Caller-gate coherence (generation-aware): a caller-gate adapter re-checks the ACCOUNT
  // against the pool whitelist AFTER the fill, so an unlisted account's fill can only
  // revert. isWhitelisted is structurally true on ungated markets, so one unconditional
  // read is the whole pre-flight. Advance notice only, never authoritative for JIT
  // markets: a not-yet-created id can already read gated (activation is a pre-creation
  // act) AND creation overwrites the gate state from its own parameters mid-fill — the
  // adapter's post-fill check reads the end state either way.
  if (bind.callerGate === true && resolved && dep?.whitelistManager) {
    try {
      const accountOk = await resolved.client.readContract({
        address: dep.whitelistManager,
        abi: whitelistManagerAbi,
        functionName: "isWhitelisted",
        args: [forSelf.poolId, account],
        ...(ctx.atBlock !== undefined ? { blockNumber: ctx.atBlock } : {}),
      });
      if (accountOk === false) {
        warnings.push({ code: "not_whitelisted", message: `${account} is not whitelisted for pool ${forSelf.poolId} — this ForSelf adapter enforces a caller whitelist and the fill would revert CallerNotWhitelisted after moving the maker asset. One whitelist add per calling Safe: ask the pool operator to whitelist the account (or use a pool with no whitelist)` });
      }
    } catch {
      /* best-effort: an unreadable whitelist never blocks byte-building */
    }
  }
  if (resolved && dep) {
    try {
      const tokens = await resolvePoolTokens(resolved.client, dep.poolManager, forSelf.poolId, ctx.atBlock);
      if (tokens.collateral === ZERO || tokens.cst === ZERO) {
        let hasJit = false;
        if (signed.extension && signed.extension !== "0x") {
          try {
            decodeJitExtension(signed.extension);
            hasJit = true;
          } catch {
            /* not a JIT extension */
          }
        }
        if (hasJit) {
          warnings.push({ code: "pool_not_found", message: `pool ${forSelf.poolId} does not exist YET — the resting order carries a JIT extension, so the fill is expected to create its market and the wrapper checks the binding AFTER the fill. Verify the extension derives THIS pool id before signing: ch decode order (jit label) on the resting order` });
        } else {
          warnings.push({ code: "would_revert", message: `pool ${forSelf.poolId} does not exist on chainId ${chainId} and the resting order carries no JIT extension to create it — the wrapper's market binding will revert OrderAssetsNotInMarket; check the poolId` });
        }
      } else if (!forSelfPairAllowed(tokens, signed.order.makerAsset, signed.order.takerAsset)) {
        warnings.push({ code: "would_revert", message: `the resting order trades ${signed.order.makerAsset} against ${signed.order.takerAsset}, which is not one of pool ${forSelf.poolId}'s share tokens (cST/cPT) against one of its cash legs (collateral/reference) — the wrapper's market binding will revert OrderAssetsNotInMarket` });
      }
    } catch (err) {
      warnings.push({ code: "chain_read_failed", message: `the pool coherence pre-flight failed (${revertReason(err)}) — the wrapper's market binding could not be previewed` });
    }
  }

  const call = buildFillOrderForSelfCall({
    poolId: forSelf.poolId,
    order: signed.order,
    signature: signed.signature,
    fillMakingAmount: BigInt(derived.requiredMakingAmount),
    maximumTakingAmount: cap,
    extension: signed.extension ?? "0x",
    deadline,
  });
  warnings.push(forSelfNotice(forSelf.adapter, `the order's taker asset ${signed.order.takerAsset} (>= ${cap}, the pull cap; the unspent part returns in the same transaction)`));
  warnings.push({ code: "unsigned_artifact", message: "unsigned fill calldata only — independently simulate it (cork_track simulate) and set the taker-asset allowance TO THE ADAPTER before signing or broadcasting" });
  return envelope({
    state: "ok",
    data: {
      kind: "taker-fill",
      to: forSelf.adapter,
      calldata: call.calldata,
      value: "0",
      from: account,
      orderHash: args.localOrderHash,
      makerAsset: signed.order.makerAsset,
      takerAsset: signed.order.takerAsset,
      fillFunction: call.functionName,
      requiredMakingAmount: derived.requiredMakingAmount,
      requiredTakingAmount: derived.requiredTakingAmount,
      forSelf: {
        adapter: forSelf.adapter,
        poolId: forSelf.poolId,
        selector: call.selector,
        deadline: deadline.toString(),
        pullCap: cap.toString(),
        allowances: call.allowances,
        receiverPolicy: "structurally the calling account — the wrapper forces takerTraits bit 251 with the caller as target, zeroes the taker-interaction bits, and clears Permit2 sourcing",
      },
      ...(auctionData ? { auction: auctionData } : {}),
      simulationRequired: true,
      execution: executionEthTransaction(),
      clientRequestId: args.clientRequestId,
    },
    chainId,
    source: "service",
    warnings,
    ctx,
  });
}

/** cork_prepare_phoenix + forSelf: one pool action as a DIRECT adapter call (no Bundler3,
 *  no funding or sweep legs — the adapter pulls from the caller and sweeps back itself). */
export async function preparePhoenixForSelf(input: PreparePhoenixInput, ctx: HandlerContext): Promise<Envelope> {
  const forSelf = input.forSelf!;
  const action = input.action;
  if (action.type === "authority-onboard" || action.type === "authority-revoke") {
    throw new ToolInputError("cork_prepare_phoenix", [
      { path: ["forSelf"], message: "the authority ops are direct ERC-20 approve txs — there is no ForSelf twin to route them through; drop forSelf (and note ForSelf allowances are granted to the ADAPTER address)" },
    ]);
  }
  // The ForSelf surface has no receiver/owner parameters AT ALL — outputs go to the caller.
  // A different receiver in the action is therefore a contradiction, not a preference.
  const declared = action as { receiver?: string; owner?: string };
  for (const field of ["receiver", "owner"] as const) {
    const v = declared[field];
    if (v !== undefined && v.toLowerCase() !== input.account.toLowerCase()) {
      throw new ToolInputError("cork_prepare_phoenix", [
        { path: ["action", field], message: `forSelf artifacts structurally deliver to the CALLING account — the adapter's entrypoints carry no ${field} parameter, so ${v} cannot receive. Set ${field} = account (${input.account}), or drop forSelf to route a custom ${field} through Bundler3` },
      ]);
    }
  }
  const { dep, depWarn } = await getDep(ctx, input.chainId);
  if (!dep) return unavailable(input.chainId, "unknown_deployment", `no known Cork deployment for chainId ${input.chainId}`, ctx);
  const warnings: Warning[] = [...depWarn];
  const nowSecs = nowSecondsOf(ctx);
  const deadline = input.deadlineAt !== undefined ? BigInt(input.deadlineAt) : nowSecs + BigInt(input.deadlineSeconds);
  if (input.deadlineAt !== undefined && deadline <= nowSecs) {
    warnings.push({ code: "would_revert", message: `deadlineAt ${deadline} is not in the future (now ${nowSecs}) — the adapter reverts DeadlineExceeded; pin a future absolute deadline for byte-stable retries` });
  }

  const call = buildPoolForSelfCall(action, deadline);

  // Bindings + the same pool guards the Bundler3 path gets (expiry/pause/whitelist). The
  // whitelist subjects depend on the adapter's GENERATION: the pool manager always checks
  // its direct caller (the adapter), and caller-gate adapters (WHITELIST() answers)
  // additionally check the ACCOUNT — so the account leg of the pre-flight only runs when
  // the deployed adapter actually enforces it.
  const resolved = await getRpc(ctx, input.chainId);
  const bind = await verifyForSelfBindings({
    client: resolved?.client ?? null,
    ctx,
    chainId: input.chainId,
    adapter: forSelf.adapter,
    poolManager: dep.poolManager,
    whitelistManager: dep.whitelistManager,
  });
  if (bind.gate) return bind.gate;
  warnings.push(...bind.warnings);
  let tokenAddresses: Record<string, string> | undefined;
  if (resolved) {
    try {
      const tokens = await resolvePoolTokens(resolved.client, dep.poolManager, (action as { poolId: `0x${string}` }).poolId, ctx.atBlock);
      if (tokens.collateral === ZERO || tokens.cst === ZERO || tokens.cpt === ZERO) {
        return unavailable(input.chainId, "pool_not_found", `pool ${(action as { poolId: string }).poolId} does not exist on chainId ${input.chainId} (market returned a zeroed struct); check the poolId/chainId pairing`, ctx);
      }
      tokenAddresses = { collateral: tokens.collateral, reference: tokens.reference, cST: tokens.cst, cPT: tokens.cpt };
      warnings.push(
        ...(await poolPreflightWarnings({
          client: resolved.client,
          poolManager: dep.poolManager,
          whitelistManager: dep.whitelistManager,
          corkAdapter: forSelf.adapter,
          route: "for-self",
          callerGate: bind.callerGate,
          poolId: (action as { poolId: `0x${string}` }).poolId,
          actionType: action.type,
          ...(bind.callerGate === true ? { account: input.account } : {}),
          expiryTimestamp: tokens.expiryTimestamp,
          nowSeconds: nowSecs,
          atBlock: ctx.atBlock,
        })),
      );
    } catch (err) {
      warnings.push({ code: "chain_read_failed", message: `pool pre-flight reads failed (${revertReason(err)}) — expiry/pause/whitelist could not be previewed` });
    }
  }

  const allowanceText = call.allowances
    .map((a) => `${a.tokenRole}${tokenAddresses?.[a.tokenRole] ? ` (${tokenAddresses[a.tokenRole]})` : ""} for ${a.amountField}${a.kind === "cap" ? " (a cap — the remainder returns)" : ""}`)
    .join(", plus ");
  warnings.push(forSelfNotice(forSelf.adapter, allowanceText));

  // Summary derived from the BUILT BYTES [K3] — the same decoder+renderer every consumer of
  // this calldata sees — plus one allowance line from the (test-pinned) matrix. A hand-written
  // narration could drift from what the bytes actually do; a decoded one cannot.
  const summary = summarizeBundle(
    [decodeSingleCall({ to: forSelf.adapter, data: call.calldata, value: 0n, skipRevert: false, callbackHash: `0x${"0".repeat(64)}` })],
    {},
  );
  summary.push(`2. before signing, approve the adapter to spend: ${allowanceText}`);

  return envelope({
    state: "ok",
    data: {
      kind: input.action.type,
      to: forSelf.adapter,
      calldata: call.calldata,
      value: "0",
      from: input.account,
      deadline: deadline.toString(),
      forSelf: {
        adapter: forSelf.adapter,
        functionName: call.functionName,
        selector: call.selector,
        allowances: call.allowances.map((a) => ({ ...a, ...(tokenAddresses?.[a.tokenRole] ? { token: tokenAddresses[a.tokenRole] } : {}) })),
        receiverPolicy: "structurally the calling account — the adapter's entrypoints carry no receiver/owner parameters",
      },
      summary,
      simulationRequired: true,
      execution: executionEthTransaction(),
      clientRequestId: input.clientRequestId,
    },
    chainId: input.chainId,
    source: resolved ? "chain" : "config",
    warnings,
    ctx,
  });
}
