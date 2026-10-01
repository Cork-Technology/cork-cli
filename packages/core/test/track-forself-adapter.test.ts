// cork_track verify kind "forSelfAdapter" (2026-10-01, cork-cli-private#24 item 2): which
// generation does a ForSelf adapter serve, and is it Cork's reference one? The decoder labels a
// generation's REFERENCE adapter chain-free; an integrator's own adapter (Zyfai's) has no config
// entry anywhere, and only its CORK()/LOP()/WHITELIST() views can say — a chain read, so it lives
// in track. The stub answers the real view names with real configured addresses; the live twin
// (`*-live` below) reads Zyfai's and the reference adapter on Base.
import { describe, expect, it } from "vitest";
import { BUNDLED_DEFAULTS, generationsOf, LOP_ADDRESSES, primaryOf, runTool, type HandlerContext } from "@cork/core";
import { stubRpc, TOKEN_CODE, type StubCall } from "./helpers.ts";

const NOW = 1_790_000_000n;
const BASE = generationsOf(BUNDLED_DEFAULTS, 8453);
const PRIMARY = primaryOf(BASE)!;
const PREVIOUS = BASE.find((g) => g.label === "phoenix/v0.3-rc.1")!;
const REFERENCE = PRIMARY.forSelf!.adapter as `0x${string}`;
const ZYFAI = "0x8f125a5f397a68566e38bfae0f37fcec57d91966" as const; // Zyfai's v0.4 adapter (live on Base)
const LOP = LOP_ADDRESSES[8453]!;
const refused = () => { throw new Error("execution reverted"); };
const transport = () => { throw Object.assign(new Error("fetch failed"), { name: "HttpRequestError" }); };

/** A client where `adapter` answers the three binding views as given (a thrown value = the view
 *  reverts), and holds code unless `noCode`. */
function rpc(adapter: string, views: { CORK?: string | (() => never); LOP?: string | (() => never); WHITELIST?: string | (() => never) }, noCode = false) {
  const answer = (v: string | (() => never) | undefined) => (typeof v === "function" ? v() : v === undefined ? refused() : v);
  return stubRpc((c: StubCall) => {
    if (c.address.toLowerCase() !== adapter.toLowerCase()) throw new Error(`unexpected read on ${c.address}`);
    if (c.functionName === "CORK") return answer(views.CORK);
    if (c.functionName === "LOP") return answer(views.LOP);
    if (c.functionName === "WHITELIST") return answer(views.WHITELIST);
    throw new Error(`no stub for ${c.functionName}`);
  }, { code: noCode ? {} : { [adapter.toLowerCase()]: TOKEN_CODE } });
}
const verify = (adapter: `0x${string}`, resolveRpc: NonNullable<HandlerContext["resolveRpc"]>) =>
  runTool("cork_track", { mode: "verify", chainId: 8453, subject: { kind: "forSelfAdapter", adapter } }, { nowSeconds: NOW, resolveRpc });
type Data = { verified: boolean; reference?: boolean; surface?: string; callerGate?: boolean; bindings?: Record<string, string>; generation?: { label: string }; code?: boolean };
const codes = (env: { warnings: Array<{ code: string }> }) => env.warnings.map((w) => w.code).sort();

describe("cork_track verify forSelfAdapter — classified by its own bindings", () => {
  it("the reference adapter of the primary: verified, reference:true, combined surface, caller gate", async () => {
    const env = await verify(REFERENCE, rpc(REFERENCE, { CORK: PRIMARY.phoenix!.poolManager, LOP, WHITELIST: PRIMARY.phoenix!.whitelistManager! }));
    expect(env.state).toBe("ok");
    expect(env.data as Data).toMatchObject({ verified: true, reference: true, surface: "combined", callerGate: true, generation: { label: "phoenix/v0.4-rc.1" }, bindings: { poolManager: PRIMARY.phoenix!.poolManager, lop: LOP, whitelistManager: PRIMARY.phoenix!.whitelistManager } });
    expect(env.provenance.generation).toMatchObject({ label: "phoenix/v0.4-rc.1" });
    expect(codes(env)).toEqual(["for_self_artifact"]);
    expect(env.warnings[0]!.message).toMatch(/REFERENCE ForSelf adapter of the phoenix\/v0\.4-rc\.1 generation/u);
  });

  it("an integrator's adapter bound to the primary: verified, reference:false, the message says whose code it is", async () => {
    const env = await verify(ZYFAI, rpc(ZYFAI, { CORK: PRIMARY.phoenix!.poolManager, LOP, WHITELIST: PRIMARY.phoenix!.whitelistManager! }));
    expect(env.state).toBe("ok");
    expect(env.data as Data).toMatchObject({ verified: true, reference: false, surface: "combined", callerGate: true, generation: { label: "phoenix/v0.4-rc.1" } });
    expect(env.warnings[0]!.message).toMatch(/integrator-deployed ForSelf adapter bound to the phoenix\/v0\.4-rc\.1 generation.*its CODE is the integrator's to audit/u);
  });

  it("an adapter bound to the PREVIOUS generation's pool manager is classified there — pool-only (no LOP view) and pre-caller-gate (no WHITELIST view) are disclosed, not accused", async () => {
    const env = await verify(ZYFAI, rpc(ZYFAI, { CORK: PREVIOUS.phoenix!.poolManager }));
    expect(env.state).toBe("ok");
    expect(env.data as Data).toMatchObject({ verified: true, reference: false, surface: "pool-only", callerGate: false, generation: { label: "phoenix/v0.3-rc.1" }, bindings: { poolManager: PREVIOUS.phoenix!.poolManager } });
    expect(env.warnings[0]!.message).toMatch(/pool actions only \(no LOP\(\) view\).*pre-caller-gate deployment/u);
  });

  it("reference means THIS generation's reference adapter: the previous set's reference adapter re-bound to the primary's pool manager is an integrator adapter of the primary, not a reference one", async () => {
    // Arbitrum carries a reference adapter on both sets; Base's previous set has none.
    const ARB = generationsOf(BUNDLED_DEFAULTS, 42161);
    const arbPrimary = primaryOf(ARB)!;
    const arbPreviousRef = ARB.find((g) => g.label === "phoenix/v0.3-rc.1")!.forSelf!.adapter as `0x${string}`;
    const env = await runTool("cork_track", { mode: "verify", chainId: 42161, subject: { kind: "forSelfAdapter", adapter: arbPreviousRef } }, {
      nowSeconds: NOW,
      resolveRpc: rpc(arbPreviousRef, { CORK: arbPrimary.phoenix!.poolManager, LOP: LOP_ADDRESSES[42161]!, WHITELIST: arbPrimary.phoenix!.whitelistManager! }),
    });
    expect(env.state).toBe("ok");
    expect(env.data as Data).toMatchObject({ verified: true, reference: false, generation: { label: "phoenix/v0.4-rc.1" } });
    // Bound where it belongs, it IS the reference adapter of the previous set.
    const home = ARB.find((g) => g.label === "phoenix/v0.3-rc.1")!.phoenix!;
    const ok = await runTool("cork_track", { mode: "verify", chainId: 42161, subject: { kind: "forSelfAdapter", adapter: arbPreviousRef } }, { nowSeconds: NOW, resolveRpc: rpc(arbPreviousRef, { CORK: home.poolManager, LOP: LOP_ADDRESSES[42161]! }) });
    expect(ok.data as Data).toMatchObject({ verified: true, reference: true, generation: { label: "phoenix/v0.3-rc.1" }, callerGate: false });
  });

  it("CORK() naming a pool manager no generation configures is a binding mismatch (conflict), as is a wrong LOP or a wrong whitelist manager", async () => {
    const foreignPm = await verify(ZYFAI, rpc(ZYFAI, { CORK: "0x00000000000000000000000000000000000000ee" }));
    expect(foreignPm.state).toBe("conflict");
    expect((foreignPm.data as Data).verified).toBe(false);
    expect(codes(foreignPm)).toEqual(["adapter_binding_mismatch"]);
    expect(foreignPm.warnings[0]!.message).toMatch(/pool manager of NO configured generation/u);
    const wrongLop = await verify(ZYFAI, rpc(ZYFAI, { CORK: PRIMARY.phoenix!.poolManager, LOP: "0x00000000000000000000000000000000000000ee" }));
    expect(wrongLop.state).toBe("conflict");
    expect(wrongLop.warnings[0]!.message).toMatch(/LOP\(\) names 0x00000000000000000000000000000000000000ee, not the chain's 1inch LOP v4/u);
    const wrongWl = await verify(ZYFAI, rpc(ZYFAI, { CORK: PRIMARY.phoenix!.poolManager, LOP, WHITELIST: PREVIOUS.phoenix!.whitelistManager! }));
    expect(wrongWl.state).toBe("conflict");
    expect(wrongWl.warnings[0]!.message).toMatch(/WHITELIST\(\) names .* not the phoenix\/v0\.4-rc\.1 generation's WhitelistManager/u);
  });

  it("a contract that refuses CORK() is not a ForSelf adapter; an empty account is a conflict; a transport failure is chain_read_failed, never a verdict", async () => {
    const notAdapter = await verify(ZYFAI, rpc(ZYFAI, { LOP }));
    expect(notAdapter.state).toBe("conflict");
    expect(notAdapter.warnings[0]!.message).toMatch(/does not answer CORK\(\)/u);
    const empty = await verify(ZYFAI, rpc(ZYFAI, {}, true));
    expect(empty.state).toBe("conflict");
    expect((empty.data as Data).code).toBe(false);
    expect(empty.warnings[0]!.message).toMatch(/NO CONTRACT at/u);
    const blip = await verify(ZYFAI, rpc(ZYFAI, { CORK: transport }));
    expect(blip.state).toBe("unavailable");
    expect(codes(blip)).toEqual(["chain_read_failed"]);
  });

  it("only mode verify applies; without an RPC the subject is honestly unservable", async () => {
    const sim = await runTool("cork_track", { mode: "simulate", chainId: 8453, subject: { kind: "forSelfAdapter", adapter: ZYFAI } }, { nowSeconds: NOW });
    expect(sim.state).toBe("unavailable");
    expect(codes(sim)).toEqual(["phase_gated"]);
    const noRpc = await runTool("cork_track", { mode: "verify", chainId: 8453, subject: { kind: "forSelfAdapter", adapter: ZYFAI } }, { nowSeconds: NOW, resolveRpc: async () => null });
    expect(noRpc.state).toBe("unavailable");
    expect(codes(noRpc)).toEqual(["requires_rpc"]);
  });
});

describe.skipIf(process.env["CORK_RPC_LIVE"] !== "1")("LIVE: Zyfai's v0.4 adapter and the reference adapter on Base", () => {
  it("Zyfai's adapter is an integrator adapter of phoenix/v0.4-rc.1 with the combined surface and the caller gate; the reference adapter is Cork's", async () => {
    const z = await runTool("cork_track", { mode: "verify", chainId: 8453, subject: { kind: "forSelfAdapter", adapter: ZYFAI } }, { nowSeconds: NOW });
    expect(z.state).toBe("ok");
    expect(z.data as Data).toMatchObject({ verified: true, reference: false, surface: "combined", callerGate: true, generation: { label: "phoenix/v0.4-rc.1" } });
    const r = await runTool("cork_track", { mode: "verify", chainId: 8453, subject: { kind: "forSelfAdapter", adapter: REFERENCE } }, { nowSeconds: NOW });
    expect(r.state).toBe("ok");
    expect(r.data as Data).toMatchObject({ verified: true, reference: true, generation: { label: "phoenix/v0.4-rc.1" } });
  }, 60_000);
});
