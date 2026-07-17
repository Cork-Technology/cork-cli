// Offline unit tests for the RPC resolver + circuit breaker. All network/fs/clock access is
// injected, so nothing here touches the wire — we assert the resolution *logic*: precedence,
// retry/backoff, the breaker state machine, the chainId guard, and fallback scope.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_RPCS,
  FALLBACK_CHAINS,
  filterChainlistRpcs,
  resolveRpc,
  type ProbeResult,
  type RpcConfig,
  type RpcDeps,
  type RpcState,
} from "@cork/core";

const CFG: RpcConfig = {
  attempts: 3,
  baseDelayMs: 10,
  openThreshold: 2,
  cooldownMs: 1_000,
  probeTimeoutMs: 100,
  chosenTtlMs: 10_000,
  candidateTtlMs: 10_000,
  maxProbe: 10,
};

const MAINNET_DEFAULT = DEFAULT_RPCS[1]!;

function harness(opts: {
  now?: number;
  probe: (url: string) => ProbeResult;
  candidates?: Record<number, string[]>;
}) {
  const state: RpcState = { version: 1, breaker: {}, chosen: {}, candidates: {} };
  let t = opts.now ?? 1_000_000;
  const calls = { probe: [] as string[], fetch: [] as number[], sleeps: [] as number[] };
  const deps: RpcDeps = {
    now: () => t,
    sleep: async (ms) => {
      calls.sleeps.push(ms);
    },
    probe: async (url) => {
      calls.probe.push(url);
      return opts.probe(url);
    },
    fetchChainlist: async (chainId) => {
      calls.fetch.push(chainId);
      return opts.candidates?.[chainId] ?? [];
    },
    loadState: () => state,
    saveState: () => {
      /* state is the same object ref — mutations already persist */
    },
  };
  return { deps, calls, state, advance: (ms: number) => (t += ms) };
}

const okOn = (urls: string[], chainId = 1, latency: Record<string, number> = {}) =>
  (url: string): ProbeResult => (urls.includes(url) ? { ok: true, chainId, latencyMs: latency[url] ?? 20 } : { ok: false, latencyMs: 999 });

describe("resolveRpc precedence", () => {
  it("explicit URL wins verbatim and is never probed", async () => {
    const h = harness({ probe: () => ({ ok: false, latencyMs: 999 }) });
    const r = await resolveRpc(1, "https://my.explicit.rpc", CFG, h.deps);
    expect(r?.source).toBe("explicit");
    expect(r?.url).toBe("https://my.explicit.rpc");
    expect(h.calls.probe).toHaveLength(0);
  });

  it("uses the committed default when it probes healthy, and caches the choice", async () => {
    const h = harness({ probe: okOn([MAINNET_DEFAULT]) });
    const r = await resolveRpc(1, undefined, CFG, h.deps);
    expect(r?.source).toBe("default");
    expect(r?.url).toBe(MAINNET_DEFAULT);
    expect(h.calls.probe).toEqual([MAINNET_DEFAULT]); // one probe, healthy
    expect(h.state.chosen[1]?.url).toBe(MAINNET_DEFAULT);
  });

  it("a fresh cached choice short-circuits probing entirely", async () => {
    const h = harness({ probe: okOn([MAINNET_DEFAULT]) });
    await resolveRpc(1, undefined, CFG, h.deps); // populates chosen
    h.calls.probe.length = 0;
    const r = await resolveRpc(1, undefined, CFG, h.deps);
    expect(r?.source).toBe("default");
    expect(h.calls.probe).toHaveLength(0); // served from cache, no probe
  });
});

describe("retry + backoff + chainlist fallback", () => {
  it("retries the default with backoff, then fails over to the fastest healthy chainlist RPC", async () => {
    const A = "https://a.public.rpc";
    const B = "https://b.public.rpc";
    const h = harness({
      // default always fails; among candidates B is faster than A
      probe: (url) => (url === MAINNET_DEFAULT ? { ok: false, latencyMs: 999 } : { ok: true, chainId: 1, latencyMs: url === B ? 5 : 50 }),
      candidates: { 1: [A, B] },
    });
    const r = await resolveRpc(1, undefined, CFG, h.deps);
    expect(r?.source).toBe("chainlist");
    expect(r?.url).toBe(B); // lowest latency
    // default was retried `attempts` times with backoff between
    expect(h.calls.probe.filter((u) => u === MAINNET_DEFAULT)).toHaveLength(CFG.attempts);
    expect(h.calls.sleeps).toEqual([CFG.baseDelayMs, CFG.baseDelayMs * 2]); // exponential
    expect(h.calls.fetch).toEqual([1]);
  });

  it("chainId guard drops a wrong-chain endpoint even if it is fastest", async () => {
    const RIGHT = "https://right.rpc";
    const WRONG = "https://wrong.rpc"; // fastest but reports chainId 137
    const h = harness({
      probe: (url) => {
        if (url === MAINNET_DEFAULT) return { ok: false, latencyMs: 999 };
        if (url === WRONG) return { ok: true, chainId: 137, latencyMs: 1 };
        return { ok: true, chainId: 1, latencyMs: 30 };
      },
      candidates: { 1: [WRONG, RIGHT] },
    });
    const r = await resolveRpc(1, undefined, CFG, h.deps);
    expect(r?.url).toBe(RIGHT); // WRONG dropped despite 1ms latency
  });

  it("returns null when nothing resolves", async () => {
    const h = harness({ probe: () => ({ ok: false, latencyMs: 999 }), candidates: { 1: ["https://dead.rpc"] } });
    const r = await resolveRpc(1, undefined, CFG, h.deps);
    expect(r).toBeNull();
  });
});

describe("fallback scope", () => {
  it("does NOT hit chainlist for chains outside FALLBACK_CHAINS (e.g. staging vnet 49222)", async () => {
    expect(FALLBACK_CHAINS.has(49222)).toBe(false);
    const h = harness({ probe: () => ({ ok: true, chainId: 49222, latencyMs: 1 }), candidates: { 49222: ["https://x"] } });
    const r = await resolveRpc(49222, undefined, CFG, h.deps);
    expect(r).toBeNull(); // no default for 49222, and not eligible for chainlist
    expect(h.calls.fetch).toHaveLength(0);
  });

  it("all four public chains are eligible", () => {
    for (const c of [1, 42161, 8453, 11155111]) expect(FALLBACK_CHAINS.has(c)).toBe(true);
  });
});

describe("filterChainlistRpcs (chainlist candidate hygiene)", () => {
  it("keeps plain https, drops templated/ws/API-key URLs, orders tracking:none first", () => {
    const out = filterChainlistRpcs([
      { url: "https://tracked.example/rpc", tracking: "yes" },
      { url: "wss://ws.example/rpc", tracking: "none" },
      { url: "https://keyed.example/${INFURA_API_KEY}", tracking: "none" },
      { url: "https://needs.example/YOUR_API_KEY", tracking: "none" },
      { url: "https://clean.example/rpc", tracking: "none" },
      { url: "http://insecure.example/rpc", tracking: "none" },
      { url: "https://limited.example/rpc", tracking: "limited" },
    ]);
    expect(out).toEqual(["https://clean.example/rpc", "https://tracked.example/rpc", "https://limited.example/rpc"]);
  });
  it("empty input → empty output", () => {
    expect(filterChainlistRpcs([])).toEqual([]);
  });
});

describe("circuit breaker state machine", () => {
  it("opens after openThreshold failures and then skips probing the default while open", async () => {
    const h = harness({ probe: () => ({ ok: false, latencyMs: 999 }), candidates: { 1: [] } });
    // Each resolve fails the default once (attempts internal retries count as one 'failure' record).
    await resolveRpc(1, undefined, CFG, h.deps); // failure #1
    await resolveRpc(1, undefined, CFG, h.deps); // failure #2 -> breaker opens (threshold 2)
    expect(h.state.breaker[MAINNET_DEFAULT]?.openedAt).not.toBeNull();

    h.calls.probe.length = 0;
    await resolveRpc(1, undefined, CFG, h.deps); // breaker open -> default not probed at all
    expect(h.calls.probe.filter((u) => u === MAINNET_DEFAULT)).toHaveLength(0);
  });

  it("half-opens after the cooldown and probes the default again", async () => {
    const h = harness({ probe: () => ({ ok: false, latencyMs: 999 }), candidates: { 1: [] } });
    await resolveRpc(1, undefined, CFG, h.deps);
    await resolveRpc(1, undefined, CFG, h.deps); // opens
    h.calls.probe.length = 0;
    h.advance(CFG.cooldownMs + 1); // wait out the cooldown
    await resolveRpc(1, undefined, CFG, h.deps);
    expect(h.calls.probe.filter((u) => u === MAINNET_DEFAULT).length).toBeGreaterThan(0); // probed again
  });

  it("a success resets the breaker failure count", async () => {
    let healthy = false;
    const h = harness({ probe: (url) => (url === MAINNET_DEFAULT && healthy ? { ok: true, chainId: 1, latencyMs: 5 } : { ok: false, latencyMs: 999 }), candidates: { 1: [] } });
    await resolveRpc(1, undefined, CFG, h.deps); // failure #1
    healthy = true;
    await resolveRpc(1, undefined, CFG, h.deps); // success -> reset
    expect(h.state.breaker[MAINNET_DEFAULT]).toEqual({ failures: 0, openedAt: null });
  });
});
