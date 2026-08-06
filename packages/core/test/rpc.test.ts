// Offline unit tests for the RPC resolver + circuit breaker. All network/fs/clock access is
// injected, so nothing here touches the wire — we assert the resolution *logic*: precedence,
// retry/backoff, the breaker state machine, the chainId guard, and fallback scope.
import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_RPCS,
  FALLBACK_CHAINS,
  filterChainlistRpcs,
  isTransportError,
  realDeps,
  reportEndpointFailure,
  resetExplicitVerification,
  resetRpcInflight,
  resolveRpc,
  rpcDiagnostics,
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
    // 0.5 is the un-jittered midpoint of the 0.5+random() factor, so the pre-jitter backoff
    // assertions carry over unchanged; the jitter test overrides this.
    random: () => 0.5,
  };
  return { deps, calls, state, advance: (ms: number) => (t += ms) };
}

const okOn = (urls: string[], chainId = 1, latency: Record<string, number> = {}) =>
  (url: string): ProbeResult => (urls.includes(url) ? { ok: true, chainId, latencyMs: latency[url] ?? 20 } : { ok: false, latencyMs: 999 });

describe("resolveRpc precedence", () => {
  it("explicit URL wins with no fallback; unreachable endpoints are still used verbatim (chainId probe is best-effort)", async () => {
    resetExplicitVerification();
    const h = harness({ probe: () => ({ ok: false, latencyMs: 999 }) });
    const r = await resolveRpc(1, "https://my.explicit.rpc", CFG, h.deps);
    expect(r?.source).toBe("explicit");
    expect(r?.url).toBe("https://my.explicit.rpc");
    // F21: exactly one eth_chainId verification probe — no fallback probing beyond it.
    expect(h.calls.probe).toHaveLength(1);
  });

  it("explicit URL answering with the WRONG chainId is refused (F21), and the verdict is memoized", async () => {
    resetExplicitVerification();
    const h = harness({ probe: () => ({ ok: true, chainId: 42161, latencyMs: 5 }) });
    await expect(resolveRpc(1, "https://wrong.chain.rpc", CFG, h.deps)).rejects.toMatchObject({ name: "RpcChainMismatchError" });
    // Memoized: a second resolution re-uses the verdict without another probe.
    await expect(resolveRpc(1, "https://wrong.chain.rpc", CFG, h.deps)).rejects.toMatchObject({ name: "RpcChainMismatchError" });
    expect(h.calls.probe).toHaveLength(1);
    // The SAME endpoint serves the chain it actually reports.
    const ok = await resolveRpc(42161, "https://wrong.chain.rpc", CFG, h.deps);
    expect(ok?.source).toBe("explicit");
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
      { url: "https://clean.example/rpc", tracking: "yes" }, // duplicate across tiers → deduped
    ]);
    expect(out).toEqual(["https://clean.example/rpc", "https://tracked.example/rpc", "https://limited.example/rpc"]);
  });
  it("empty input → empty output", () => {
    expect(filterChainlistRpcs([])).toEqual([]);
  });
});

describe("breaker feedback from real reads", () => {
  it("isTransportError: transport classes (incl. nested cause) yes; contract reverts no", () => {
    expect(isTransportError(Object.assign(new Error("x"), { name: "HttpRequestError" }))).toBe(true);
    expect(isTransportError({ name: "ContractFunctionExecutionError", cause: { name: "TimeoutError" } })).toBe(true);
    expect(isTransportError({ name: "ContractFunctionExecutionError", cause: { name: "ContractFunctionRevertedError" } })).toBe(false);
    expect(isTransportError(new Error("plain"))).toBe(false);
  });

  it("reportEndpointFailure records a breaker failure and evicts a matching chosen endpoint", () => {
    const h = harness({ probe: () => ({ ok: false, latencyMs: 1 }) });
    const URLX = "https://was-healthy.example/rpc";
    h.state.chosen[1] = { url: URLX, source: "chainlist", ts: h.deps.now() };
    reportEndpointFailure(1, URLX, CFG, h.deps);
    expect(h.state.breaker[URLX]?.failures).toBe(1);
    expect(h.state.chosen[1]).toBeUndefined(); // evicted — resolver re-resolves instead of serving it for the TTL
    // a failure for a DIFFERENT chain's chosen url must not evict this chain's choice
    h.state.chosen[42161] = { url: "https://other.example", source: "default", ts: h.deps.now() };
    reportEndpointFailure(1, "https://other.example", CFG, h.deps);
    expect(h.state.chosen[42161]).toBeDefined();
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

describe("backoff jitter", () => {
  it("delays scale by 0.5+random(): 0 halves them, high values stretch them", async () => {
    const h = harness({ probe: () => ({ ok: false, latencyMs: 999 }), candidates: { 1: [] } });
    h.deps.random = () => 0;
    await resolveRpc(1, undefined, CFG, h.deps);
    expect(h.calls.sleeps).toEqual([CFG.baseDelayMs * 0.5, CFG.baseDelayMs * 2 * 0.5]);

    h.calls.sleeps.length = 0;
    h.state.breaker = {}; // close the breaker so the default is probed again
    h.deps.random = () => 0.9;
    await resolveRpc(1, undefined, CFG, h.deps);
    expect(h.calls.sleeps).toEqual([CFG.baseDelayMs * 1.4, CFG.baseDelayMs * 2 * 1.4]);
  });
});

describe("single-flight resolution", () => {
  it("concurrent automatic resolutions for one chain share a single probe pass", async () => {
    resetRpcInflight();
    const h = harness({ probe: okOn([MAINNET_DEFAULT]) });
    let probes = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const orig = h.deps.probe;
    h.deps.probe = async (url, t) => {
      probes++;
      await gate;
      return orig(url, t);
    };
    const p1 = resolveRpc(1, undefined, CFG, h.deps);
    const p2 = resolveRpc(1, undefined, CFG, h.deps); // joins p1's flight
    release();
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(probes).toBe(1);
    expect(r1?.url).toBe(MAINNET_DEFAULT);
    expect(r2?.url).toBe(MAINNET_DEFAULT);
  });

  it("the flight is cleared on settle — a later resolution runs fresh", async () => {
    resetRpcInflight();
    const h = harness({ probe: okOn([MAINNET_DEFAULT]) });
    await resolveRpc(1, undefined, CFG, h.deps);
    h.state.chosen = {}; // force a re-probe
    h.calls.probe.length = 0;
    await resolveRpc(1, undefined, CFG, h.deps);
    expect(h.calls.probe.length).toBeGreaterThan(0); // not served from a stale in-flight promise
  });
});

describe("same-call failover (the failover-wrapped client)", () => {
  const B = "https://b.public.rpc";
  const transportDead = () => Object.assign(new Error("fetch failed"), { name: "HttpRequestError" });

  function failoverHarness() {
    // A fresh-chosen default that dies at REQUEST time; B is the healthy chainlist candidate.
    const h = harness({
      probe: (url) => (url === B ? { ok: true, chainId: 1, latencyMs: 5 } : { ok: false, latencyMs: 9 }),
      candidates: { 1: [B] },
    });
    h.state.chosen[1] = { url: MAINNET_DEFAULT, source: "default", ts: h.deps.now() };
    return h;
  }

  it("a transport-dead endpoint heals WITHIN the call; url/source mutate so the disclosure follows", async () => {
    const h = failoverHarness();
    const served: string[] = [];
    h.deps.request = (url) => async () => {
      served.push(url);
      if (url === MAINNET_DEFAULT) throw transportDead();
      return "0x10";
    };
    const r = await resolveRpc(1, undefined, CFG, h.deps);
    expect(r?.url).toBe(MAINNET_DEFAULT);
    const out = await r!.client.request({ method: "eth_blockNumber" });
    expect(out).toBe("0x10");
    expect(served).toEqual([MAINNET_DEFAULT, B]); // one failure, one retry — no third attempt
    expect(r?.url).toBe(B); // mutated in place → rpcWarn/rpcProvenance built at envelope time disclose B
    expect(r?.source).toBe("chainlist");
    expect(h.state.breaker[MAINNET_DEFAULT]?.failures).toBeGreaterThan(0); // the real failure fed the breaker
    expect(h.state.chosen[1]?.url).toBe(B); // the NEXT call starts on B
    // the failover re-resolve probes the just-failed default ONCE (attempts:1), not cfg.attempts times
    expect(h.calls.probe.filter((u) => u === MAINNET_DEFAULT)).toHaveLength(1);
  });

  it("a NON-transport error (contract revert) does NOT fail over and does NOT feed the breaker", async () => {
    const h = failoverHarness();
    h.deps.request = () => async () => {
      throw Object.assign(new Error("execution reverted"), { name: "ContractFunctionRevertedError" });
    };
    const r = await resolveRpc(1, undefined, CFG, h.deps);
    await expect(r!.client.request({ method: "eth_chainId" })).rejects.toThrow("execution reverted");
    expect(r?.url).toBe(MAINNET_DEFAULT); // unchanged
    expect(h.state.breaker[MAINNET_DEFAULT]).toBeUndefined();
    expect(h.calls.probe).toHaveLength(0); // no re-resolution
  });

  it("when nothing else resolves, the ORIGINAL error propagates after exactly one extra resolution attempt", async () => {
    const h = failoverHarness();
    h.state.candidates = {}; // no chainlist candidates cached
    const deadHarnessProbe = h.deps.probe;
    h.deps.probe = async (url, t) => (url === B ? { ok: false, latencyMs: 9 } : deadHarnessProbe(url, t));
    h.deps.fetchChainlist = async () => []; // and none fetchable
    const attempts: string[] = [];
    h.deps.request = (url) => async () => {
      attempts.push(url);
      throw transportDead();
    };
    const r = await resolveRpc(1, undefined, CFG, h.deps);
    await expect(r!.client.request({ method: "eth_blockNumber" })).rejects.toThrow("fetch failed");
    expect(attempts).toEqual([MAINNET_DEFAULT]); // bounded: no endpoint to retry on → no second request
    expect(r?.url).toBe(MAINNET_DEFAULT);
  });
});

describe("disk cache (real deps): corrupt-read reset + atomic write", () => {
  it("a corrupt state file resets to empty instead of throwing; saves are temp+rename with no residue", () => {
    const dir = mkdtempSync(join(tmpdir(), "cork-rpc-state-"));
    const file = join(dir, "rpc-state.json");
    writeFileSync(file, "{ this is not json");
    const prev = process.env.CORK_RPC_CACHE_FILE;
    process.env.CORK_RPC_CACHE_FILE = file;
    try {
      const deps = realDeps();
      const st = deps.loadState();
      expect(st).toEqual({ version: 1, breaker: {}, chosen: {}, candidates: {} }); // reset, not a throw
      st.chosen[1] = { url: "https://x.example/rpc", source: "chainlist", ts: 1 };
      deps.saveState(st);
      expect(readdirSync(dir)).toEqual(["rpc-state.json"]); // no .tmp-<pid> staging residue
      expect((JSON.parse(readFileSync(file, "utf8")) as RpcState).chosen[1]?.url).toBe("https://x.example/rpc");
    } finally {
      if (prev === undefined) delete process.env.CORK_RPC_CACHE_FILE;
      else process.env.CORK_RPC_CACHE_FILE = prev;
    }
  });
});

describe("rpcDiagnostics (the /readyz feed)", () => {
  it("reports hosts only — never the full URL (the committed defaults embed tokens in their PATH)", () => {
    const h = harness({ probe: () => ({ ok: false, latencyMs: 1 }) });
    h.state.chosen[1] = { url: MAINNET_DEFAULT, source: "default", ts: h.deps.now() };
    h.state.breaker[MAINNET_DEFAULT] = { failures: 3, openedAt: h.deps.now() };
    const d = rpcDiagnostics(CFG, h.deps);
    const raw = JSON.stringify(d);
    const tokenSegment = MAINNET_DEFAULT.split("/").pop()!;
    expect(raw).not.toContain(tokenSegment);
    expect(d.chosen[1]?.host).toBe(new URL(MAINNET_DEFAULT).host);
    expect(d.breakers).toEqual([{ host: new URL(MAINNET_DEFAULT).host, failures: 3, open: true, remainingCooldownMs: CFG.cooldownMs }]);
  });
});

describe("CORK_RPC_NO_FAILOVER kill-switch", () => {
  it("disables the in-call failover wrapper: a transport failure propagates untouched, nothing re-resolves", async () => {
    process.env.CORK_RPC_NO_FAILOVER = "1";
    try {
      const h = harness({
        probe: (url) => (url === "https://b.public.rpc" ? { ok: true, chainId: 1, latencyMs: 5 } : { ok: false, latencyMs: 9 }),
        candidates: { 1: ["https://b.public.rpc"] },
      });
      h.state.chosen[1] = { url: MAINNET_DEFAULT, source: "default", ts: h.deps.now() };
      let requested = 0;
      h.deps.request = () => async () => {
        requested++;
        throw Object.assign(new Error("fetch failed"), { name: "HttpRequestError" });
      };
      const r = await resolveRpc(1, undefined, CFG, h.deps);
      expect(r?.url).toBe(MAINNET_DEFAULT);
      // The plain client uses the REAL viem http transport, not deps.request — so the injected
      // fake must never be consulted, and the resolved fields must never mutate.
      expect(requested).toBe(0);
      expect(r?.source).toBe("default");
      expect(h.calls.probe).toHaveLength(0);
    } finally {
      delete process.env.CORK_RPC_NO_FAILOVER;
    }
  });
});
