// Pre-flight guards for a prepared Cork bundle: the on-chain conditions that make a well-formed
// bundle revert anyway. Every one is best-effort disclosure — we build the bytes regardless and
// warn, because a read failure must never turn byte-building into a hard error.
//
// All three guards enforced here were read off the deployed source (phoenix-private):
//   * expiry     — pre-expiry actions against an expired pool
//   * pause      — a global circuit breaker AND a per-pool 5-bit map
//   * whitelist  — gated pools, which check TWO different addresses (see below)
import type { PublicClient } from "viem";
import { poolManagerAbi, whitelistManagerAbi } from "../chain/abis.ts";
import type { PhoenixAction } from "@cork/schemas";

export interface PreflightWarning {
  code: string;
  message: string;
}

/** Actions that are the post-expiry settlement path — never flagged for expiry. */
const POST_EXPIRY_ACTIONS = new Set(["withdraw", "withdraw-other", "redeem"]);

/**
 * Which bit of the pool's `getPausedBitMap` gates each action.
 *
 * Verified by following every one of the 13 CorkPoolManager entrypoints to its
 * `_corkPool*NotPaused` helper and that helper to its `PoolLib._is*Paused` bit. Note `withdraw`
 * and `withdrawOther` reach the check indirectly, inside `_withdraw` — the guard is real, it is
 * just not on the external function.
 */
export const PAUSE_BIT: Record<string, number> = {
  deposit: 0,
  mint: 0,
  swap: 1,
  exercise: 1,
  "exercise-other": 1,
  withdraw: 2,
  "withdraw-other": 2,
  redeem: 2,
  "unwind-deposit": 3,
  "unwind-mint": 3,
  "unwind-swap": 4,
  "unwind-exercise": 4,
  "unwind-exercise-other": 4,
};

/** The controller's own name for each bit, so the message matches what an operator would unpause. */
const PAUSE_LABEL = ["deposit", "swap", "withdrawal", "unwindDepositAndMint", "unwindSwap"];

export interface PreflightInput {
  client: PublicClient;
  poolManager: `0x${string}`;
  /** Omit to skip the whitelist guard (partial deployment). */
  whitelistManager?: `0x${string}` | undefined;
  /** The adapter the call routes through — the address the POOL MANAGER sees as msg.sender. */
  corkAdapter?: `0x${string}` | undefined;
  /** Which call path the adapter belongs to — alters only the whitelist WORDING, never the
   *  check: "bundler3" (default) is the CorkAdapter behind Bundler3; "for-self" is an
   *  integrator-deployed ForSelf adapter called directly. On the for-self route, pass
   *  `account` only for caller-gate-generation adapters (WHITELIST() answers) — earlier
   *  ForSelf deployments check nothing about the account, so warning on it would be a
   *  false alarm. */
  route?: "bundler3" | "for-self" | undefined;
  /** for-self route only: the adapter's generation as probed on-chain — `true` when the
   *  adapter enforces isWhitelisted(poolId, msg.sender) itself (its WHITELIST() view
   *  answers), `false` when it predates the caller gate, `undefined` when unknowable.
   *  Alters only the adapter-subject WORDING. */
  callerGate?: boolean | undefined;
  poolId: `0x${string}`;
  actionType: PhoenixAction["type"];
  /** The declared initiator — the address the ADAPTER checks against the whitelist. */
  account?: `0x${string}` | undefined;
  /** Already read by the caller; 0 means "not set". */
  expiryTimestamp: bigint;
  nowSeconds: bigint;
  atBlock?: bigint | undefined;
}

/**
 * Read the pool's guard state and return one warning per condition that would revert.
 *
 * Reads are issued together; with a known chain viem collapses them into a single multicall3
 * request, so this costs one extra round trip rather than four.
 */
export async function poolPreflightWarnings(input: PreflightInput): Promise<PreflightWarning[]> {
  const { client, poolManager, whitelistManager, corkAdapter, poolId, actionType, account, expiryTimestamp, nowSeconds, atBlock } = input;
  const out: PreflightWarning[] = [];
  const blockArg = atBlock !== undefined ? { blockNumber: atBlock } : {};
  const pm = { address: poolManager, abi: poolManagerAbi } as const;

  // ── expiry ────────────────────────────────────────────────────────────────────────────────
  if (expiryTimestamp > 0n && expiryTimestamp <= nowSeconds && !POST_EXPIRY_ACTIONS.has(actionType)) {
    out.push({
      code: "pool_expired",
      message: `pool ${poolId} expired at ${expiryTimestamp} (now ${nowSeconds}) — '${actionType}' is a pre-expiry action and this bundle would revert on-chain; the post-expiry paths are withdraw/withdraw-other/redeem`,
    });
  }

  // ── pause + whitelist ─────────────────────────────────────────────────────────────────────
  // Each leg is independently best-effort: one unsupported view must not suppress the others.
  const wantWhitelist = whitelistManager !== undefined;
  const [globalPaused, bitmap, initiatorOk, adapterOk] = await Promise.all([
    client.readContract({ ...pm, functionName: "paused", args: [], ...blockArg }).catch(() => undefined),
    client.readContract({ ...pm, functionName: "getPausedBitMap", args: [poolId], ...blockArg }).catch(() => undefined),
    wantWhitelist && account
      ? client.readContract({ address: whitelistManager!, abi: whitelistManagerAbi, functionName: "isWhitelisted", args: [poolId, account], ...blockArg }).catch(() => undefined)
      : Promise.resolve(undefined),
    wantWhitelist && corkAdapter
      ? client.readContract({ address: whitelistManager!, abi: whitelistManagerAbi, functionName: "isWhitelisted", args: [poolId, corkAdapter], ...blockArg }).catch(() => undefined)
      : Promise.resolve(undefined),
  ]);

  if (globalPaused === true) {
    out.push({
      code: "pool_paused",
      message: `the CorkPoolManager is globally paused — EVERY action on every pool reverts EnforcedPause() until it is unpaused; this bundle would revert`,
    });
  }
  const bit = PAUSE_BIT[actionType];
  if (typeof bitmap === "number" || typeof bitmap === "bigint") {
    if (bit !== undefined && (BigInt(bitmap) & (1n << BigInt(bit))) !== 0n) {
      out.push({
        code: "pool_paused",
        message: `pool ${poolId} has its '${PAUSE_LABEL[bit]}' function paused (pauseBitMap bit ${bit} is set) — '${actionType}' routes through that guard and would revert EnforcedPause(); the bundle is built but not executable until it is unpaused`,
      });
    }
  }

  // A gated pool checks TWO addresses, and they are not the same one: CorkAdapter's own
  // onlyWhitelisted modifier checks `initiator()` (the user), while CorkPoolManager checks
  // `_msgSender()` — which, for a bundled call, is the adapter. Both must pass, so checking only
  // your own address is not enough to know the bundle will go through.
  if (initiatorOk === false) {
    out.push({
      code: "not_whitelisted",
      message:
        input.route === "for-self"
          ? `${account} is not whitelisted for pool ${poolId} — this ForSelf adapter enforces a caller whitelist (its WHITELIST() gate) and would revert CallerNotWhitelisted. One whitelist add per calling Safe: ask the pool operator to whitelist the account (or use a pool with no whitelist)`
          : `${account} is not whitelisted for pool ${poolId} — CorkAdapter checks the bundle's initiator() and would revert UnauthorizedSender(). Ask the pool operator to whitelist it (or use a pool with no whitelist)`,
    });
  }
  if (adapterOk === false) {
    out.push({
      code: "not_whitelisted",
      message:
        input.route === "for-self"
          ? input.callerGate === true
            ? `the ForSelf adapter ${corkAdapter} is not whitelisted for pool ${poolId} — the pool manager checks its direct caller, which on this path is the ADAPTER; nobody can reach this gated pool through it until the adapter itself is whitelisted. (This adapter also re-checks each CALLER against the same whitelist, so whitelisting it does NOT open the pool to other accounts — one add for the adapter, one per calling Safe)`
            : `the ForSelf adapter ${corkAdapter} is not whitelisted for pool ${poolId} — the pool manager checks its direct caller, which on this path is the ADAPTER; nobody can reach this gated pool through it until the adapter itself is whitelisted (and whitelisting a SHARED adapter of this pre-caller-gate generation opens the pool to every account on chain — see the adapter package README)`
          : `the corkAdapter ${corkAdapter} is not whitelisted for pool ${poolId} — the pool manager checks msg.sender, which for a bundled call is the ADAPTER, not you. Even a whitelisted user cannot reach this pool through Bundler3 until the adapter itself is whitelisted`,
    });
  }

  return out;
}
