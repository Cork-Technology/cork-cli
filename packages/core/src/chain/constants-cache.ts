// Long-TTL cache for on-chain CONTRACT CONSTANTS (immutables and near-immutables a contract
// self-reports: MAX_FEE_PERCENTAGE, maxExpiryDuration, role hashes). The alternative was the
// footgun this module retires: replicating a contract's constant as a source literal, which
// drifts silently when the contract redeploys with a different value (audit follow-up
// 2026-08-28, the C12 replicated-verdict class applied to constants).
//
// Contract with callers:
//   - `cachedContractConstant` is SYNC (memory → disk, TTL-checked): value gates that must work
//     offline read it and fall back to their compiled default — the pre-flight ORDER never
//     changes to accommodate the cache.
//   - `refreshContractConstant` is async best-effort: call it where a client already exists;
//     it reads the live view only when the cached value is stale or missing, single-flighted
//     per key, and NEVER throws. A stale cache therefore converges one call after the chain
//     changes — "long TTL" semantics, not read-per-call.
//   - Failure keeps the STALE value (a constant that answered once beats a compiled fallback);
//     a never-answered key stays undefined and the caller's fallback rules.
//
// INTERNAL module (like breaker.ts / atomic-file.ts): never re-export from the SDK barrels.
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { parseAbi, type PublicClient } from "viem";
import { atomicWriteFileSync } from "../atomic-file.ts";

/** 7 days: constants move only on redeploys/governance, and every consumer keeps a compiled
 *  fallback — a week-stale value is strictly better than a years-stale source literal. */
export const CONSTANT_TTL_MS = 7 * 24 * 3_600_000;

type Entry = { v: string; ts: number };
type Store = Record<string, Entry>;

const cacheFile = (): string => process.env.CORK_CONST_CACHE_FILE ?? join(homedir(), ".cache", "cork-helper-cli", "contract-constants.json");

/** Under vitest the cache is a NO-OP unless a test opts in with CORK_CONST_CACHE_FILE: reads
 *  answer undefined and refreshes read live without persisting. Two reasons: unit runs must
 *  never write the operator's real ~/.cache, and a process-wide cache would couple tests that
 *  assert on which probe reads their stub receives (the value would ride over from an earlier
 *  test in the same worker). Production and the CLI never set VITEST. */
const disabled = (): boolean => process.env.VITEST !== undefined && process.env.CORK_CONST_CACHE_FILE === undefined;

let memory: Store | null = null;
let memoryFile: string | null = null;
const inFlight = new Map<string, Promise<bigint | undefined>>();

export function resetConstantsCacheForTests(): void {
  memory = null;
  memoryFile = null;
  inFlight.clear();
}

function load(): Store {
  const file = cacheFile();
  // The env override can move between calls (tests do); a memory image from another file is
  // not this cache.
  if (memory !== null && memoryFile === file) return memory;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    memory = parsed !== null && typeof parsed === "object" ? (parsed as Store) : {};
  } catch {
    memory = {};
  }
  memoryFile = file;
  return memory;
}

function save(store: Store): void {
  try {
    atomicWriteFileSync(cacheFile(), JSON.stringify(store));
  } catch {
    /* a read-only cache dir degrades to in-process memory — never a caller failure */
  }
}

/** chainId is PART OF THE KEY on purpose: identical CREATE2 addresses across chains are the
 *  norm here, and an address-only key would let one chain's value answer for another. */
const keyOf = (chainId: number, address: string, fn: string): string => `${chainId}:${address.toLowerCase()}:${fn}`;

/** Sync cache read: the fresh cached value, or undefined (missing or past TTL — the caller's
 *  compiled fallback takes over). Never reads the chain. */
export function cachedContractConstant(chainId: number, address: `0x${string}`, fn: string, nowMs: number = Date.now()): bigint | undefined {
  if (disabled()) return undefined;
  const e = load()[keyOf(chainId, address, fn)];
  if (!e || nowMs - e.ts > CONSTANT_TTL_MS) return undefined;
  try {
    return BigInt(e.v);
  } catch {
    return undefined;
  }
}

/** One-getter ABI for the two shapes contract constants come in. bytes32 values (role hashes)
 *  are stored as their hex string and round-trip through BigInt either way. */
const constantAbi = (fn: string, out: "uint256" | "bytes32") => parseAbi([`function ${fn}() view returns (${out})`] as const);

/** Best-effort refresh: fresh cache → cached value, no read; stale/missing → ONE live read
 *  (single-flighted per key), stored on success. Read failure returns the stale value when one
 *  exists, else undefined. Never throws — this must not be the reason a prepare fails. */
export async function refreshContractConstant(
  client: PublicClient,
  chainId: number,
  address: `0x${string}`,
  fn: string,
  out: "uint256" | "bytes32" = "uint256",
  nowMs: number = Date.now(),
): Promise<bigint | undefined> {
  const key = keyOf(chainId, address, fn);
  if (!disabled()) {
    const e = load()[key];
    if (e && nowMs - e.ts <= CONSTANT_TTL_MS) {
      try {
        return BigInt(e.v);
      } catch {
        /* corrupt entry — fall through to a re-read */
      }
    }
  }
  const running = inFlight.get(key);
  if (running) return running;
  const read = (async (): Promise<bigint | undefined> => {
    try {
      const raw = await client.readContract({ address, abi: constantAbi(fn, out), functionName: fn });
      const value = typeof raw === "bigint" ? raw : BigInt(raw as string);
      if (!disabled()) {
        const s = load();
        s[key] = { v: out === "bytes32" ? `0x${value.toString(16).padStart(64, "0")}` : value.toString(), ts: nowMs };
        save(s);
      }
      return value;
    } catch {
      // Keep the stale value alive rather than dropping to the compiled fallback: it answered
      // from this chain once, which the fallback never did.
      const stale = disabled() ? undefined : load()[key];
      try {
        return stale ? BigInt(stale.v) : undefined;
      } catch {
        return undefined;
      }
    } finally {
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, read);
  return read;
}

/** bytes32 view of a cached value (role hashes), zero-padded. */
export function cachedContractConstantBytes32(chainId: number, address: `0x${string}`, fn: string, nowMs: number = Date.now()): `0x${string}` | undefined {
  const v = cachedContractConstant(chainId, address, fn, nowMs);
  return v === undefined ? undefined : (`0x${v.toString(16).padStart(64, "0")}` as `0x${string}`);
}
