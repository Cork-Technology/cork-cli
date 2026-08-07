import { describe, expect, it } from "vitest";
import type { PublicClient } from "viem";
import { PAUSE_BIT, poolPreflightWarnings } from "@cork/core";
import type { PhoenixAction } from "@cork/schemas";

const PM = "0x1111111111111111111111111111111111111111" as const;
const WLM = "0x2222222222222222222222222222222222222222" as const;
const ADP = "0xccccccccccccbad6f772a511b337d9ccc9570407" as const;
const POOL = "0xceebea356e5159c9cb06612c39ef2e6e0fe9cd3bb047541e26e0c0767bd1c16a" as const;
const USER = "0x00000000000000000000000000000000000000aa" as const;
const NOW = 1_800_000_000n;

/** Chain state a pool can be in; every field defaults to "nothing wrong". */
interface Stub {
  paused?: boolean;
  bitmap?: number;
  whitelisted?: Record<string, boolean>;
  /** Views that revert — the guard must degrade to silence, never throw. */
  reverts?: Set<string>;
}

function stubClient(s: Stub): PublicClient {
  return {
    readContract: async (args: { functionName: string; args?: readonly unknown[] }) => {
      if (s.reverts?.has(args.functionName)) throw new Error(`${args.functionName} reverted`);
      switch (args.functionName) {
        case "paused":
          return s.paused ?? false;
        case "getPausedBitMap":
          return s.bitmap ?? 0;
        case "isWhitelisted": {
          const who = String(args.args?.[1]).toLowerCase();
          return s.whitelisted?.[who] ?? true;
        }
        default:
          throw new Error(`unexpected read ${args.functionName}`);
      }
    },
  } as unknown as PublicClient;
}

const run = (s: Stub, actionType: string, over: Partial<Parameters<typeof poolPreflightWarnings>[0]> = {}) =>
  poolPreflightWarnings({
    client: stubClient(s),
    poolManager: PM,
    whitelistManager: WLM,
    corkAdapter: ADP,
    poolId: POOL,
    actionType: actionType as PhoenixAction["type"],
    account: USER,
    expiryTimestamp: 0n,
    nowSeconds: NOW,
    ...over,
  });

const codes = (w: { code: string }[]) => w.map((x) => x.code);

describe("preflight: pause", () => {
  it("clean pool -> no warnings", async () => {
    expect(await run({}, "deposit")).toEqual([]);
  });

  it("global pause blocks every action, on every pool", async () => {
    for (const a of ["deposit", "swap", "redeem", "unwind-swap"]) {
      const w = await run({ paused: true }, a);
      expect(codes(w)).toContain("pool_paused");
      expect(w[0]?.message).toMatch(/globally paused/);
    }
  });

  it("each action is gated by its own bit and no other", async () => {
    // Verified against CorkPoolManager's _corkPool*NotPaused helpers.
    const expected: Record<string, number> = {
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
    expect(PAUSE_BIT).toEqual(expected);
    for (const [action, bit] of Object.entries(expected)) {
      // its own bit trips it
      expect(codes(await run({ bitmap: 1 << bit }, action))).toContain("pool_paused");
      // every other bit leaves it alone
      for (let other = 0; other < 5; other++) {
        if (other === bit) continue;
        expect(codes(await run({ bitmap: 1 << other }, action))).not.toContain("pool_paused");
      }
    }
  });

  it("names the function an operator would unpause", async () => {
    const w = await run({ bitmap: 1 << 2 }, "withdraw");
    expect(w[0]?.message).toMatch(/'withdrawal' function paused/);
    expect(w[0]?.message).toMatch(/bit 2/);
  });

  it("a fully-paused bitmap trips whichever action is asked about", async () => {
    expect(codes(await run({ bitmap: 0b11111 }, "exercise-other"))).toContain("pool_paused");
  });
});

describe("preflight: whitelist", () => {
  it("gated pool, user not whitelisted -> flags the initiator check", async () => {
    const w = await run({ whitelisted: { [USER]: false } }, "deposit");
    expect(codes(w)).toEqual(["not_whitelisted"]);
    expect(w[0]?.message).toMatch(/initiator\(\)/);
  });

  it("adapter not whitelisted -> flagged even when the USER is whitelisted", async () => {
    // The non-obvious half: CorkPoolManager checks _msgSender(), which for a bundled call is the
    // adapter. A user who checks only their own address would see a false green.
    const w = await run({ whitelisted: { [USER]: true, [ADP.toLowerCase()]: false } }, "deposit");
    expect(codes(w)).toEqual(["not_whitelisted"]);
    expect(w[0]?.message).toMatch(/msg\.sender/);
    expect(w[0]?.message).toContain(ADP);
  });

  it("both unwhitelisted -> both reported, not just the first", async () => {
    const w = await run({ whitelisted: { [USER]: false, [ADP.toLowerCase()]: false } }, "deposit");
    expect(codes(w)).toEqual(["not_whitelisted", "not_whitelisted"]);
  });

  it("skips the whitelist guard when no whitelistManager is configured", async () => {
    expect(await run({ whitelisted: { [USER]: false } }, "deposit", { whitelistManager: undefined })).toEqual([]);
  });
});

describe("preflight: expiry", () => {
  it("pre-expiry action against an expired pool is flagged", async () => {
    expect(codes(await run({}, "deposit", { expiryTimestamp: NOW - 1n }))).toEqual(["pool_expired"]);
  });

  it("post-expiry settlement paths are never flagged", async () => {
    for (const a of ["withdraw", "withdraw-other", "redeem"]) {
      expect(codes(await run({}, a, { expiryTimestamp: NOW - 1n }))).toEqual([]);
    }
  });

  it("expiryTimestamp 0 means unset, not long-expired", async () => {
    expect(await run({}, "deposit", { expiryTimestamp: 0n })).toEqual([]);
  });
});

describe("preflight: degradation", () => {
  it("a reverting view is silent, and does not suppress the other guards", async () => {
    // An older deployment without getPausedBitMap must still get the whitelist verdict.
    const w = await run({ reverts: new Set(["getPausedBitMap", "paused"]), whitelisted: { [USER]: false } }, "deposit");
    expect(codes(w)).toEqual(["not_whitelisted"]);
  });

  it("every guard failing degrades to no warnings rather than throwing", async () => {
    const all = new Set(["paused", "getPausedBitMap", "isWhitelisted"]);
    await expect(run({ reverts: all }, "deposit")).resolves.toEqual([]);
  });

  it("guards compose: expired AND paused AND unwhitelisted all report together", async () => {
    const w = await run({ paused: true, bitmap: 1 << 0, whitelisted: { [USER]: false } }, "deposit", { expiryTimestamp: NOW - 1n });
    expect(codes(w)).toEqual(["pool_expired", "pool_paused", "pool_paused", "not_whitelisted"]);
  });

  // ── for-self route wording is GENERATION-aware (caller-gate adapters, 2026-08-07+) ────────
  it("for-self + callerGate: an unlisted ACCOUNT is flagged with the adapter's own gate wording", async () => {
    const w = await run({ whitelisted: { [USER]: false } }, "deposit", { route: "for-self", callerGate: true });
    expect(codes(w)).toEqual(["not_whitelisted"]);
    expect(w[0]?.message).toMatch(/CallerNotWhitelisted/);
    expect(w[0]?.message).toContain(USER);
    expect(w[0]?.message).not.toMatch(/initiator\(\)/); // that is the Bundler3 story, not this route's
  });

  it("for-self + callerGate: the unlisted-ADAPTER wording drops the blast-radius clause", async () => {
    const w = await run({ whitelisted: { [ADP]: false } }, "deposit", { route: "for-self", callerGate: true });
    expect(codes(w)).toEqual(["not_whitelisted"]);
    expect(w[0]?.message).toMatch(/does NOT open the pool/);
  });

  it("for-self WITHOUT callerGate (older adapter): the blast-radius warning stands", async () => {
    const w = await run({ whitelisted: { [ADP]: false } }, "deposit", { route: "for-self", callerGate: false, account: undefined });
    expect(codes(w)).toEqual(["not_whitelisted"]);
    expect(w[0]?.message).toMatch(/opens the pool to every account on chain/);
  });
});
