// Split from handlers.ts (2026-08-05): track handlers — one typed dispatch, per-tool modules.
// Declarations are moved byte-identically; see handlers.ts for the runTool dispatch.
import { keccak256, stringToHex } from "viem";
import { Envelope, TrackInput } from "@cork/schemas";
import { computeMarketId } from "../marketid.ts";
import { readPoolState } from "../chain/reads.ts";
import { isTransportError } from "../chain/rpc.ts";
import { classifyBitInvalidator, classifyRemainingRaw, LOP_ADDRESSES, lopInvalidatorAbi, lopInvalidatorPlan } from "../orders.ts";
import { JIT_EVENTS } from "../market-registry.ts";
import { resolveRollover } from "../config-remote.ts";
import { chainStatusName, fetchDigestLogs, labelLogs, LogsRangeLimited, resolveLogsEndpoint, SETTLER_EVENTS, settlerStatusAbi, venueChainConsistent } from "../rollover-verify.ts";
import { getLopFills, getLopOrderbook, getRolloverOrder } from "../datasources/venue.ts";
import { chainReadFailed, envelope, getDep, getRpc, type HandlerContext, jsonSafe, rpcProvenance, rpcWarn, unavailable, venueDepsOf, venueFailed } from "./shared.ts";
import { collectVenuePages } from "./query.ts";


export async function handleTrack(input: TrackInput, ctx: HandlerContext): Promise<Envelope> {
  const chainId = input.chainId ?? 1;
  const subj = input.subject;

  // simulate: dry-run FROZEN bytes via eth_call — executes nothing, signs nothing [K1]. Accepts
  // the artifact shapes our own prepare tools emit (bundler3+multicall, to+calldata/data) plus a
  // caller `from`/`account` (defaults to the artifact's own account field when present). A revert
  // is a SUCCESSFUL simulation whose answer is "this would revert" — ok + wouldRevert, never a
  // fabricated failure.
  if (input.mode === "simulate") {
    if (subj.kind !== "artifact") {
      return unavailable(chainId, "phase_gated", `track simulate dry-runs a FROZEN artifact's bytes — pass subject kind 'artifact' with the prepared result (to/bundler3 + data/multicall + from/account); subject kind '${subj.kind}' has nothing executable to simulate`, ctx);
    }
    const a = subj.artifact;
    const pick = (...keys: string[]): string | undefined => {
      for (const k of keys) {
        const v = a[k];
        if (typeof v === "string" && v.startsWith("0x")) return v;
      }
      return undefined;
    };
    const to = pick("to", "bundler3");
    const data = pick("data", "multicall", "calldata");
    const from = pick("from", "account", "sender");
    if (!to || !data) {
      return unavailable(chainId, "missing_filter", "simulate needs the artifact's target and bytes: include `to` (or `bundler3`) and `data` (or `multicall`/`calldata`); optionally `from`/`account` for sender-dependent paths (funding pulls, roles)", ctx);
    }
    const resolved = await getRpc(ctx, chainId);
    if (!resolved) return unavailable(chainId, "requires_rpc", `simulate needs an RPC endpoint for chainId ${chainId} (none resolved — set CORK_RPC_URL)`, ctx);
    const rpc = rpcProvenance(input.format, resolved);
    const warnings: Array<{ code: string; message: string }> = [...rpcWarn(resolved)];
    if (!from) warnings.push({ code: "manual_funding", message: "no `from`/`account` in the artifact — simulated without a sender, so sender-dependent legs (transferFrom funding, role gates) are NOT exercised; pass the account for a faithful dry-run" });
    const valueStr = typeof a.value === "string" && /^[0-9]+$/.test(a.value) ? a.value : undefined;
    try {
      const call = {
        to: to as `0x${string}`,
        data: data as `0x${string}`,
        ...(from ? { account: from as `0x${string}` } : {}),
        ...(valueStr ? { value: BigInt(valueStr) } : {}),
        ...(ctx.atBlock !== undefined ? { blockNumber: ctx.atBlock } : {}),
      };
      const res = await resolved.client.call(call);
      let gas: bigint | undefined;
      try {
        gas = await resolved.client.estimateGas(call);
      } catch { /* estimate is best-effort garnish; the call already proved viability */ }
      return envelope({
        state: "ok",
        data: { mode: "simulate", wouldRevert: false, to, from: from ?? null, ...(res.data && res.data !== "0x" ? { returnData: res.data } : {}), ...(gas !== undefined ? { gasEstimate: gas } : {}), note: "eth_call dry-run at the current state — a later broadcast can still land differently (state/deadline drift)" },
        chainId,
        source: "chain",
        warnings,
        ...rpc,
        ctx,
      });
    } catch (err) {
      // Distinguish an execution REVERT (a real simulation answer) from a transport failure.
      const msg = err instanceof Error ? err.message : String(err);
      if (isTransportError(err)) return chainReadFailed(chainId, err, warnings, ctx, resolved);
      const reason = msg.split("\n").find((l) => /revert|Error|Custom/i.test(l))?.trim() ?? msg.split("\n")[0];
      return envelope({
        state: "ok",
        data: { mode: "simulate", wouldRevert: true, to, from: from ?? null, revertReason: reason },
        chainId,
        source: "chain",
        warnings: [...warnings, { code: "would_revert", message: `the frozen bytes REVERT at the current state (${reason}) — do not sign/broadcast as-is; common causes: expired deadline, missing funding/allowance, pool state moved since prepare` }],
        ...rpc,
        ctx,
      });
    }
  }

  // artifact: recompute the content digest and reconcile against the caller's claim (pure).
  if (subj.kind === "artifact") {
    const digest = keccak256(stringToHex(JSON.stringify(jsonSafe(subj.artifact) ?? null)));
    const claimed = input.expect?.artifactDigest;
    if (claimed) {
      const match = digest.toLowerCase() === claimed.toLowerCase();
      return envelope({ state: match ? "ok" : "conflict", data: { verified: match, computedDigest: digest, claimedDigest: claimed }, chainId, source: "config", ...(match ? {} : { warnings: [{ code: "digest_mismatch", message: "recomputed artifact digest does not match the claimed digest" }] }), ctx });
    }
    return envelope({ state: "ok", data: { computedDigest: digest }, chainId, source: "config", ctx });
  }

  // chain-authoritative subjects need an RPC.
  const { dep, depWarn } = await getDep(ctx, chainId);
  if (subj.kind === "marketRef") {
    if (!dep) return unavailable(chainId, "unknown_deployment", `no known Cork deployment for chainId ${chainId}`, ctx);
    const resolved = await getRpc(ctx, chainId);
    if (!resolved) return unavailable(chainId, "requires_rpc", "marketRef verification needs an RPC (none resolved — set CORK_RPC_URL)", ctx);
    const client = resolved.client;
    const rpc = rpcProvenance(input.format, resolved);
    try {
      const s = await readPoolState(client, { poolManager: dep.poolManager, constraintAdapter: dep.constraintAdapter }, subj.poolId, ctx.atBlock);
      const idMatches = computeMarketId(s.market).toLowerCase() === subj.poolId.toLowerCase();
      return envelope({
        state: idMatches ? "ok" : "conflict",
        data: { verified: idMatches, poolId: s.poolId, marketIdRecomputed: computeMarketId(s.market), swapRate: s.onChainSwapRate, market: s.market },
        chainId,
        source: "chain",
        block: s.blockNumber,
        warnings: idMatches ? [...rpcWarn(resolved), ...depWarn] : [{ code: "marketid_mismatch", message: "on-chain market params do not hash to the requested poolId" }, ...rpcWarn(resolved), ...depWarn],
        ...rpc,
        ctx,
      });
    } catch (err) {
      return chainReadFailed(chainId, err, [...rpcWarn(resolved), ...depWarn], ctx, resolved);
    }
  }

  if (subj.kind === "txHash") {
    const resolved = await getRpc(ctx, chainId);
    if (!resolved) return unavailable(chainId, "requires_rpc", "txHash reconcile needs an RPC (none resolved — set CORK_RPC_URL)", ctx);
    const client = resolved.client;
    const rpc = rpcProvenance(input.format, resolved);
    try {
      const r = await client.getTransactionReceipt({ hash: subj.txHash });
      // Label known Cork lifecycle events in the receipt (settler rollover events + the JIT
      // adapter's market-creation/mint events) so an agent sees WHAT happened, not just a count.
      const labeled = r.logs
        .map((l) => {
          const name = (l.topics[0] && (SETTLER_EVENTS[l.topics[0]] ?? JIT_EVENTS[l.topics[0]])) || undefined;
          return name ? { event: name, address: l.address, ...(l.topics[1] ? { topic1: l.topics[1] } : {}) } : undefined;
        })
        .filter((x): x is NonNullable<typeof x> => x !== undefined);
      return envelope({ state: "ok", data: { txHash: subj.txHash, status: r.status, blockNumber: r.blockNumber, gasUsed: r.gasUsed, logs: r.logs.length, ...(labeled.length ? { corkEvents: labeled } : {}) }, chainId, source: "chain", block: r.blockNumber, ...rpc, ctx });
    } catch (err) {
      // A missing receipt is a normal outcome (pending/unknown tx); anything else is a real
      // chain-read failure and must not masquerade as "not found".
      if (err && typeof err === "object" && "name" in err && (err as { name: string }).name === "TransactionReceiptNotFoundError") {
        return envelope({ state: "unavailable", data: { txHash: subj.txHash, found: false }, chainId, source: "chain", warnings: [{ code: "receipt_not_found", message: "no receipt for this txHash at the RPC (pending or unknown)" }], ctx });
      }
      return chainReadFailed(chainId, err, [], ctx, resolved);
    }
  }

  // orderHash / submissionRef: reconcile against the venue's lifecycle rows. Venue-reported
  // state — the independent chain-log verification leg [K7] lands in the next iteration; until
  // then a warning discloses that provenance honestly.
  if (subj.kind === "orderHash" || subj.kind === "submissionRef") {
    const ref = subj.kind === "orderHash" ? subj.orderHash : subj.submissionRef;
    const deps = venueDepsOf(ctx);
    const venueNote = { code: "venue_reported", message: "state is venue-reported (centralized) and was NOT independently chain-verified for this call — configure an RPC (status leg) and ENVIO_API_TOKEN or CORK_LOGS_RPC_URL (event-history leg) to enable [K7] verification" };
    try {
      if (/^0x[0-9a-fA-F]{64}$/.test(ref)) {
        // A 32-byte ref is a rollover orderDigest or a LOP orderHash — try both surfaces.
        const row = await getRolloverOrder(deps, ref.toLowerCase());
        if (row) {
          const order = (row.order ?? row) as Record<string, unknown>;
          const venueStatus = String(order.status ?? "");
          const digest = ref.toLowerCase() as `0x${string}`;

          // ── [K7] chain verification legs (best-effort; every gap is disclosed, never faked) ──
          const warnings: Array<{ code: string; message: string }> = [];
          let chainVerification: Record<string, unknown> | undefined;
          const { rollover } = await resolveRollover(chainId);
          const settlerAddr = typeof order.settler === "string" ? (order.settler as `0x${string}`) : undefined;
          const resolved = settlerAddr ? await getRpc(ctx, chainId) : null;
          if (settlerAddr && resolved) {
            try {
              const statusNum = (await resolved.client.readContract({
                address: settlerAddr,
                abi: settlerStatusAbi,
                functionName: "orderStatus",
                args: [digest],
              })) as number;
              const chainStatus = chainStatusName(statusNum);
              const consistent = venueChainConsistent(venueStatus, chainStatus);
              chainVerification = { leg: "orderStatus (settler view, live RPC)", settler: settlerAddr, chainStatus, venueStatus, consistent };
              if (!consistent) {
                // Chain outranks the venue: disagreement is an explicit conflict, with the
                // indexer's finality lag (~75 s on Arbitrum) noted for freshly-updated rows.
                return envelope({
                  state: "conflict",
                  data: { kind: "rollover-order", orderDigest: digest, venueStatus, chainStatus, order, chainVerification },
                  chainId,
                  source: "chain",
                  warnings: [{ code: "status_mismatch", message: `the venue reports '${venueStatus}' but the settler's orderStatus() returns '${chainStatus}' — chain outranks indexer [K7]; if the venue row updated within the indexer finality lag (~75s on Arbitrum) retry shortly` }],
                  ctx,
                });
              }
            } catch (err) {
              warnings.push({ code: "chain_read_failed", message: `orderStatus verification read failed (${err instanceof Error ? err.message.split("\n")[0] : String(err)}) — result is venue-reported only` });
            }
          } else {
            warnings.push(venueNote);
          }

          // Event-history leg via a logs-capable endpoint (HyperRPC preferred; token sent as a
          // Bearer header by fetchDigestLogs, never in the URL).
          const logsEndpoint = resolveLogsEndpoint(chainId, ctx.logsUrl);
          if (logsEndpoint && rollover) {
            try {
              const logs = await fetchDigestLogs({
                url: logsEndpoint.url,
                ...(logsEndpoint.bearerToken ? { bearerToken: logsEndpoint.bearerToken } : {}),
                addresses: [rollover.exactSettler, rollover.partialSettler],
                digest,
                fromBlock: rollover.seededAtBlock,
                ...(ctx.venueFetch || ctx.logsFetch ? { fetchImpl: ctx.logsFetch ?? ctx.venueFetch! } : {}),
              });
              chainVerification = { ...(chainVerification ?? {}), events: labelLogs(logs) };
            } catch (err) {
              warnings.push(
                err instanceof LogsRangeLimited
                  ? { code: "logs_range_limited", message: `the logs endpoint refused the historical range (${err.message}) — event history omitted; use HyperRPC (ENVIO_API_TOKEN) for full-range scans` }
                  : { code: "logs_unavailable", message: `event-history leg failed: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}` },
              );
            }
          } else if (!logsEndpoint) {
            warnings.push({ code: "logs_unavailable", message: "no logs-capable endpoint configured (set ENVIO_API_TOKEN for HyperRPC, or CORK_LOGS_RPC_URL) — event history omitted; status leg above still applies when an RPC resolved" });
          }

          return envelope({
            state: "ok",
            data: {
              kind: "rollover-order",
              orderDigest: digest,
              lifecycle: order.status ?? null,
              order,
              fills: row.fills ?? [],
              slots: row.slots ?? [],
              ...(chainVerification ? { chainVerification } : {}),
            },
            chainId,
            source: chainVerification ? "chain" : "indexer",
            warnings,
            ctx,
          });
        }
        // ── LOP surface: fills + resting-book row, then the on-chain invalidator leg [K7] ──
        const hash = ref.toLowerCase();
        // Bounded traversals (F19): a single-page scan could falsely report "no fills" /
        // "not resting" / "not found" for anything beyond page 1.
        const fillsScan = await collectVenuePages({ pageSize: 100, maxPages: 10 }, (cursor) => getLopFills(deps, { chainId, orderHash: hash, ...(cursor ? { cursor } : {}), limit: 100 }));
        const fills = { items: fillsScan.items };
        // The orderbook endpoint has no orderHash filter — walk the book client-side to
        // recover the maker/makerTraits the invalidator views need.
        let bookRow: Record<string, unknown> | undefined;
        let bookComplete = true;
        try {
          const book = await collectVenuePages({ pageSize: 100, maxPages: 10 }, (cursor) => getLopOrderbook(deps, { chainId, ...(cursor ? { cursor } : {}), limit: 100 }));
          bookComplete = book.complete;
          bookRow = book.items.find((r) => {
            const o = r as Record<string, unknown>;
            const h = o.orderHash ?? o.order_hash ?? o.hash ?? (o.order as Record<string, unknown> | undefined)?.orderHash;
            return typeof h === "string" && h.toLowerCase() === hash;
          }) as Record<string, unknown> | undefined;
        } catch {
          bookComplete = false; // book scan is best-effort; fills/chain legs below still apply
        }
        if (fills.items.length > 0 || bookRow) {
          const warnings: Array<{ code: string; message: string }> = [];
          let chainVerification: Record<string, unknown> | undefined;
          // maker + makerTraits from the book row (resting) or the first fill row (historical).
          const src = (bookRow?.order as Record<string, unknown> | undefined) ?? bookRow ?? (fills.items[0] as Record<string, unknown> | undefined);
          const maker = typeof src?.maker === "string" ? (src.maker as `0x${string}`) : undefined;
          const traitsStr = src?.makerTraits ?? src?.maker_traits;
          const lop = LOP_ADDRESSES[chainId];
          const resolved = maker && lop ? await getRpc(ctx, chainId) : null;
          if (maker && lop && resolved && traitsStr !== undefined) {
            try {
              const plan = lopInvalidatorPlan(BigInt(String(traitsStr)));
              const onChain =
                plan.mode === "bit"
                  ? classifyBitInvalidator(
                      (await resolved.client.readContract({ address: lop, abi: lopInvalidatorAbi, functionName: "bitInvalidatorForOrder", args: [maker, plan.slot] })) as bigint,
                      plan.mask,
                    )
                  : classifyRemainingRaw(
                      (await resolved.client.readContract({ address: lop, abi: lopInvalidatorAbi, functionName: "rawRemainingInvalidatorForOrder", args: [maker, hash as `0x${string}`] })) as bigint,
                    );
              chainVerification = {
                leg: `LOP ${plan.mode}-invalidator (live RPC)`,
                lop,
                maker,
                onChainStatus: onChain.status,
                ...(onChain.remaining !== undefined ? { remainingMakingAmount: onChain.remaining } : {}),
                cancellable: onChain.status !== "filled-or-cancelled",
              };
              // Chain outranks the venue: a book-listed order the chain says is dead is a conflict.
              if (bookRow && onChain.status === "filled-or-cancelled") {
                return envelope({
                  state: "conflict",
                  data: { kind: "lop-order", orderHash: hash, venueStatus: "resting (orderbook row present)", chainStatus: onChain.status, order: bookRow, fills: fills.items, chainVerification },
                  chainId,
                  source: "chain",
                  warnings: [{ code: "status_mismatch", message: "the venue orderbook still lists this order but the LOP invalidator says it is filled or cancelled — chain outranks indexer [K7]; do not attempt a fill, and a cancel would revert" }],
                  ctx,
                });
              }
            } catch (err) {
              warnings.push({ code: "chain_read_failed", message: `LOP invalidator read failed (${err instanceof Error ? err.message.split("\n")[0] : String(err)}) — result is venue-reported only` });
            }
          } else if (maker && lop && traitsStr !== undefined) {
            warnings.push(venueNote);
          } else if (!lop) {
            warnings.push({ code: "no_lop", message: `no 1inch LOP deployment configured for chainId ${chainId} — invalidator leg skipped` });
          } else {
            warnings.push({ code: "venue_reported", message: "venue rows carry no maker/makerTraits for this order — the on-chain invalidator leg needs both; state is venue-reported only" });
          }
          if (!bookRow && !bookComplete) {
            warnings.push({ code: "pagination_incomplete", message: "the orderbook walk did not exhaust the book — `resting` is UNKNOWN, not false; the fills below are still valid evidence" });
          }
          return envelope({
            state: "ok",
            data: {
              kind: "lop-order",
              orderHash: hash,
              // An incomplete book walk that found nothing cannot honestly claim "not resting".
              resting: bookRow ? true : bookComplete ? false : null,
              ...(bookRow ? { order: bookRow } : {}),
              count: fills.items.length,
              fills: fills.items,
              ...(chainVerification ? { chainVerification } : {}),
            },
            chainId,
            source: chainVerification ? "chain" : "indexer",
            warnings,
            ctx,
          });
        }
        if (!fillsScan.complete || !bookComplete) {
          // Neither surface found it, but at least one scan stopped short — no absence claim.
          return envelope({
            state: "conflict",
            data: { requestedRef: ref, fillsScanComplete: fillsScan.complete, orderbookScanComplete: bookComplete },
            chainId,
            source: "service",
            warnings: [{ code: "pagination_incomplete", message: "the venue scans were incomplete, so 'not found' cannot be honestly claimed — retry, narrow the search, or raise maxPages" }],
            ctx,
          });
        }
        return unavailable(chainId, "order_not_found", `no rollover order, LOP orderbook row, or LOP fills known to the venue for ${ref} on chainId ${chainId} (a normal outcome for an unposted/unfilled order)`, ctx);
      }
      return unavailable(chainId, "order_not_found", `submissionRef '${ref}' is not a 32-byte order digest — RFQ ids (rfq_/ans_) reconcile via cork_query once the RFQ read surface is wired`, ctx);
    } catch (err) {
      return venueFailed(chainId, err, ctx);
    }
  }

  // All five subject kinds are handled above; this is unreachable but keeps the return total.
  return unavailable(chainId, "needs_service", "track subject is not reconcilable in this iteration", ctx);
}
