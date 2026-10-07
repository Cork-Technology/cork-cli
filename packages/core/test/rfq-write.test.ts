// RFQ v2 proven writes: cork_prepare_orders rfq-write hands out the typed data, cork_submit
// rebuilds the same body, checks who signed it, and only then relays. Offline: the venue is a
// fetch stub, the chain a stub client.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hashTypedData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { buildMakerOrder, LOP_ADDRESSES, runTool, type HandlerContext } from "@cork/core";
import { buildTeaching } from "@cork/schemas";
import { planRfqWrite } from "../src/rfq-bodies.ts";
import { rfqWriteRefusal409 } from "../src/handlers/submit.ts";
import { proveRfqWrite, rfqRecord, stubRpc } from "./helpers.ts";

const NOW = 1_790_000_000n;
const WRITER = privateKeyToAccount(`0x${"3a".repeat(32)}`);
const STRANGER = privateKeyToAccount(`0x${"3b".repeat(32)}`);
const SAFE = "0x5afe00000000000000000000000000000000cafe" as const;
const ERC1271_MAGIC = "0x1626ba7e";

interface Seen { url: string; method: string; body?: unknown; headers?: Record<string, string> }

function ctxWith(routes: Array<{ match: string; status?: number; body: unknown }>, seen: Seen[] = [], over: Partial<HandlerContext> = {}): HandlerContext {
  const venueFetch = async (url: string, init?: RequestInit): Promise<Response> => {
    seen.push({ url, method: init?.method ?? "GET", ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}), headers: Object.fromEntries(new Headers(init?.headers).entries()) });
    const r = routes.find((x) => url.includes(x.match));
    if (!r) return new Response(JSON.stringify({ message: `no stub for ${url}` }), { status: 404 });
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
  };
  return { nowSeconds: NOW, resolveRpc: async () => null, venueFetch, ...over };
}

const OPEN = {
  type: "rfq-open",
  kind: "new_position",
  requester: WRITER.address,
  // Mixed case on purpose: the venue stores — and hashes — addresses lowercased.
  referenceAsset: "0x9D39A5DE30e57443BfF2A8307A4256c8797A3497",
  collateralAsset: { one_of: ["0xaf88d065e77c8cC2239327C5EDb3A432268e5831"] },
  modes: ["liquidity_only"],
  packageIds: ["balanced-v1"],
  expiryWindow: { notBefore: 1_795_000_000, notAfter: 1_795_604_800 },
  marketTemplate: { inline: { oracle_recipe: "0x679Cbd016587D4dAA8bFd3cE87E2A2dD6b9a964d", oracle_params: { schema: "cork-inline-liquidity/1", anchor_rate: "1000000000000000000" } } },
  notionalAssets: "50000000000",
  validUntil: 1_794_900_000,
} as const;

const openInput = (auth: unknown = { method: "signature", signature: "0x00" }) => ({ chainId: 42161, clientRequestId: "test-rfq-open-0001", action: { ...OPEN, auth } });
const counterInput = (over: Record<string, unknown> = {}) => ({ chainId: 42161, clientRequestId: "test-rfq-ctr-0001", action: { type: "rfq-counter", rfqId: "rfq_1", requester: WRITER.address, premiumAnnualized: "0.035", auth: { method: "signature", signature: "0x00" }, ...over } });
const passInput = (over: Record<string, unknown> = {}) => ({ chainId: 42161, clientRequestId: "test-rfq-pass-0001", action: { type: "rfq-answer", rfqId: "rfq_1", underwriter: WRITER.address, status: "pass", reasonCode: "NO_CAPACITY", auth: { method: "signature", signature: "0x00" }, ...over } });

const postsOf = (seen: Seen[]) => seen.filter((s) => s.method === "POST");

const STAGING = "https://breaking.cork.tech";
const KEY = "test-rfq-api-key-7f3c9a";

/** Run with a private credentials file and env vars of the test's choosing, restored after. */
async function withCredentials(opts: { file?: string; env?: Record<string, string> }, fn: () => Promise<void>): Promise<void> {
  const names = ["CORK_RFQ_API_KEY", "CORK_PROFILE", "CORK_CREDENTIALS_FILE", ...Object.keys(opts.env ?? {})];
  const saved = Object.fromEntries(names.map((n) => [n, process.env[n]]));
  const dir = mkdtempSync(join(tmpdir(), "cork-cred-"));
  try {
    for (const n of names) delete process.env[n];
    const path = join(dir, "credentials");
    if (opts.file !== undefined) writeFileSync(path, opts.file, { mode: 0o600 });
    process.env.CORK_CREDENTIALS_FILE = path;
    Object.assign(process.env, opts.env ?? {});
    await fn();
  } finally {
    for (const n of names) {
      if (saved[n] === undefined) delete process.env[n];
      else process.env[n] = saved[n];
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("cork_prepare_orders rfq-write", () => {
  it("returns the exact body the venue hashes (addresses lowercased), its bodyHash, and the typed data the requester signs", async () => {
    const { auth: _auth, ...request } = openInput().action;
    const env = await runTool("cork_prepare_orders", { chainId: 42161, account: WRITER.address, clientRequestId: "test-rfq-open-0001", action: { type: "rfq-write", request } }, ctxWith([]));
    expect(env.state).toBe("ok");
    const d = env.data as { operation: string; ref: string; signer: string; body: Record<string, unknown>; bodyHash: string; digest: string; typedData: Parameters<typeof hashTypedData>[0]; execution: { kind: string } };
    expect(d.operation).toBe("open");
    expect(d.ref).toBe("test-rfq-open-0001");
    expect(d.signer).toBe(WRITER.address.toLowerCase());
    expect(d.body.schema_version).toBe("2");
    expect(d.body.kind).toBe("new_position");
    expect(d.body.reference_asset).toBe("0x9d39a5de30e57443bff2a8307a4256c8797a3497");
    expect((d.body.collateral_asset as { one_of: string[] }).one_of[0]).toBe("0xaf88d065e77c8cc2239327c5edb3a432268e5831");
    expect((d.body.market_template as { inline: { oracle_recipe: string } }).inline.oracle_recipe).toBe("0x679cbd016587d4daa8bfd3ce87e2a2dd6b9a964d");
    expect(d.body).not.toHaveProperty("signature");
    expect(d.typedData.domain).toEqual({ name: "Cork RFQ", version: "1", chainId: 42161 });
    expect(hashTypedData(d.typedData)).toBe(d.digest);
    expect(d.execution.kind).toBe("eip712-typed-data");
  });

  it("refuses when account is not the address that must sign", async () => {
    const { auth: _auth, ...request } = openInput().action;
    const env = await runTool("cork_prepare_orders", { chainId: 42161, account: STRANGER.address, clientRequestId: "test-rfq-open-0001", action: { type: "rfq-write", request } }, ctxWith([]));
    expect(env.state).toBe("unavailable");
    expect(env.warnings[0]?.code).toBe("invalid_order_terms");
    expect(env.warnings[0]?.message).toContain("requester");
  });

  it("an answer takes its kind and chain from the RFQ: a mismatching kind is refused before anything is built", async () => {
    const { auth: _auth, ...request } = passInput({ kind: "rollover" }).action;
    const env = await runTool("cork_prepare_orders", { chainId: 42161, account: WRITER.address, clientRequestId: "test-rfq-pass-0001", action: { type: "rfq-write", request } }, ctxWith([{ match: "/rfqs/v2/rfq_1", body: rfqRecord({ requester: STRANGER.address }) }]));
    expect(env.state).toBe("unavailable");
    expect(env.warnings[0]?.code).toBe("invalid_order_terms");
    expect(env.warnings[0]?.message).toMatch(/kind "new_position".*"rollover" answer/u);
  });
});

describe("cork_submit RFQ v2 writes — the proof", () => {
  it("the body prepare hands out and the body submit relays are byte-identical, and the signature over it relays", async () => {
    const { auth: _auth, ...request } = openInput().action;
    const prepared = await runTool("cork_prepare_orders", { chainId: 42161, account: WRITER.address, clientRequestId: "test-rfq-open-0001", action: { type: "rfq-write", request } }, ctxWith([]));
    const p = prepared.data as { body: Record<string, unknown>; bodyHash: string; typedData: never };
    const signature = await WRITER.signTypedData(p.typedData);
    const seen: Seen[] = [];
    const env = await runTool("cork_submit", openInput({ method: "signature", signature }), ctxWith([{ match: "/rfqs/v2", status: 201, body: { rfq_id: "rfq_new", state: "open" } }], seen));
    expect(env.state).toBe("ok");
    expect((env.data as { bodyHash: string }).bodyHash).toBe(p.bodyHash);
    expect((env.data as { signerType: string }).signerType).toBe("eoa");
    const posted = postsOf(seen)[0]!;
    expect(posted.url).toMatch(/\/rfqs\/v2$/u);
    const { signature: sent, ...rest } = posted.body as Record<string, unknown>;
    expect(sent).toBe(signature);
    expect(rest).toEqual(p.body);
    // No key is ever sent on the signature path.
    expect(posted.headers?.["x-cork-api-key"]).toBeUndefined();
  });

  it("a signature by another key over the same body is refused, NOT relayed (an EOA signer, read as one)", async () => {
    const plan = planRfqWrite({ chainId: 42161, clientRequestId: "test-rfq-open-0001", request: { ...OPEN } as never });
    const signature = await STRANGER.signTypedData(plan.typedData as never);
    const seen: Seen[] = [];
    const env = await runTool("cork_submit", openInput({ method: "signature", signature }), ctxWith([{ match: "/rfqs/v2", status: 201, body: {} }], seen, { resolveRpc: stubRpc(() => { throw new Error("no reads expected"); }) }));
    expect(env.state).toBe("conflict");
    expect(env.warnings[0]?.code).toBe("signature_or_reconstruction_mismatch");
    expect(env.warnings[0]?.message).toContain(STRANGER.address);
    expect(postsOf(seen)).toHaveLength(0);
  });

  it("a signature over a DIFFERENT body (another field value) recovers to someone else and is refused", async () => {
    const plan = planRfqWrite({ chainId: 42161, clientRequestId: "test-rfq-open-0001", request: { ...OPEN, notionalAssets: "1" } as never });
    const signature = await WRITER.signTypedData(plan.typedData as never);
    const seen: Seen[] = [];
    const env = await runTool("cork_submit", openInput({ method: "signature", signature }), ctxWith([{ match: "/rfqs/v2", status: 201, body: {} }], seen, { resolveRpc: stubRpc(() => undefined) }));
    expect(env.state).toBe("conflict");
    expect(postsOf(seen)).toHaveLength(0);
  });

  it("a contract wallet signer is checked with ERC-1271 over the CorkRfqWrite digest: accepted relays, rejected does not", async () => {
    const base = { ...openInput(), action: { ...openInput().action, requester: SAFE } };
    const plan = planRfqWrite({ chainId: 42161, clientRequestId: base.clientRequestId, request: { ...OPEN, requester: SAFE } as never });
    const walletSig = `0x${"ab".repeat(85)}` as const; // a Safe7579-style blob ecrecover cannot read
    const asked: Array<readonly unknown[] | undefined> = [];
    const wallet = (answer: string) =>
      stubRpc((c) => {
        if (c.functionName === "isValidSignature") {
          asked.push(c.args);
          return answer;
        }
        throw new Error(`unexpected read ${c.functionName}`);
      }, { code: { [SAFE]: "0x6080" } });
    const okSeen: Seen[] = [];
    const ok = await runTool("cork_submit", { ...base, action: { ...base.action, auth: { method: "signature", signature: walletSig } } }, ctxWith([{ match: "/rfqs/v2", status: 201, body: { rfq_id: "rfq_s", state: "open" } }], okSeen, { resolveRpc: wallet(`${ERC1271_MAGIC}00000000000000000000000000000000000000000000000000000000`) }));
    expect(ok.state).toBe("ok");
    expect((ok.data as { signerType: string }).signerType).toBe("erc1271");
    expect(asked[0]?.[0]).toBe(plan.digest);
    expect(postsOf(okSeen)).toHaveLength(1);
    const noSeen: Seen[] = [];
    const no = await runTool("cork_submit", { ...base, action: { ...base.action, auth: { method: "signature", signature: walletSig } } }, ctxWith([{ match: "/rfqs/v2", status: 201, body: {} }], noSeen, { resolveRpc: wallet("0xffffffff00000000000000000000000000000000000000000000000000000000") }));
    expect(no.state).toBe("conflict");
    expect(no.warnings[0]?.code).toBe("signature_or_reconstruction_mismatch");
    expect(postsOf(noSeen)).toHaveLength(0);
  });

  it("a possible contract signer with no RPC to ask is relayed with a warning — the venue checks it", async () => {
    const signature = await STRANGER.signTypedData(planRfqWrite({ chainId: 42161, clientRequestId: "test-rfq-open-0001", request: { ...OPEN } as never }).typedData as never);
    const seen: Seen[] = [];
    const env = await runTool("cork_submit", openInput({ method: "signature", signature }), ctxWith([{ match: "/rfqs/v2", status: 201, body: { rfq_id: "rfq_u", state: "open" } }], seen));
    expect(env.state).toBe("ok");
    expect(env.warnings.map((w) => w.code)).toContain("chain_read_failed");
    expect(env.warnings.find((w) => w.code === "chain_read_failed")?.message).toContain("relayed unchecked");
    expect(postsOf(seen)).toHaveLength(1);
  });

  it("auth apiKey with no key anywhere is refused api_key_missing before ANY request leaves the process — on every write", async () => {
    await withCredentials({}, async () => {
      for (const input of [openInput({ method: "apiKey" }), counterInput({ auth: { method: "apiKey" } }), passInput({ auth: { method: "apiKey" } })]) {
        const seen: Seen[] = [];
        const env = await runTool("cork_submit", input, ctxWith([{ match: "/rfqs/v2", status: 201, body: {} }], seen, { venueUrl: STAGING }));
        expect(env.state, input.action.type).toBe("unavailable");
        expect(env.warnings[0]?.code, input.action.type).toBe("api_key_missing");
        expect(env.warnings[0]?.message).toContain("CORK_RFQ_API_KEY");
        expect(env.warnings[0]?.message).toContain("breaking.cork.tech");
        expect(seen, input.action.type).toHaveLength(0);
      }
    });
  });

  it("auth apiKey relays with the key in the header ONLY — no signature in the body, no signer check, and the key never in the result", async () => {
    await withCredentials({ env: { CORK_RFQ_API_KEY: KEY } }, async () => {
      const seen: Seen[] = [];
      const env = await runTool("cork_submit", openInput({ method: "apiKey" }), ctxWith([{ match: "/rfqs/v2", status: 201, body: { rfq_id: "rfq_k", state: "open" } }], seen, { venueUrl: STAGING }));
      expect(env.state).toBe("ok");
      const d = env.data as { signerType: string; auth: Record<string, unknown> };
      expect(d.signerType).toBe("api-key");
      expect(d.auth).toEqual({ method: "apiKey", source: "env", profile: "default", host: "breaking.cork.tech" });
      const posted = postsOf(seen)[0]!;
      expect(posted.headers?.["x-cork-api-key"]).toBe(KEY);
      expect(posted.body).not.toHaveProperty("signature");
      expect(JSON.stringify(env)).not.toContain(KEY);
    });
  });

  it("a venue 401 on the key path teaches the key, not re-signing — and never echoes the key", async () => {
    await withCredentials({ env: { CORK_RFQ_API_KEY: KEY } }, async () => {
      const env = await runTool("cork_submit", openInput({ method: "apiKey" }), ctxWith([{ match: "/rfqs/v2", status: 401, body: { error: "Unauthorized", message: "Invalid x-cork-api-key." } }], [], { venueUrl: STAGING }));
      expect(env.state).toBe("unavailable");
      expect(env.warnings[0]?.code).toBe("venue_rejected");
      expect(env.warnings[0]?.message).toContain("ch auth status");
      expect(env.warnings[0]?.message).not.toContain("rfq-write");
      expect(JSON.stringify(env)).not.toContain(KEY);
    });
  });

  it("a key stored for ANOTHER venue host is never sent: staging's key does not reach production", async () => {
    await withCredentials({ file: `[default]\nrfq_api_key.breaking.cork.tech = ${KEY}\n` }, async () => {
      const seen: Seen[] = [];
      const prod = await runTool("cork_submit", openInput({ method: "apiKey" }), ctxWith([{ match: "/rfqs/v2", status: 201, body: {} }], seen, { venueUrl: "https://api-phoenix.cork.tech" }));
      expect(prod.state).toBe("unavailable");
      expect(prod.warnings[0]?.code).toBe("api_key_missing");
      expect(prod.warnings[0]?.message).toContain("no key for api-phoenix.cork.tech");
      expect(seen).toHaveLength(0);
      const staging = await runTool("cork_submit", openInput({ method: "apiKey" }), ctxWith([{ match: "/rfqs/v2", status: 201, body: { rfq_id: "rfq_s" } }], seen, { venueUrl: STAGING }));
      expect(staging.state).toBe("ok");
      expect((staging.data as { auth: { source: string } }).auth.source).toBe("credentials-file");
      expect(postsOf(seen)[0]!.headers?.["x-cork-api-key"]).toBe(KEY);
      expect(JSON.stringify(staging)).not.toContain(KEY);
    });
  });

  it("the profile comes from ctx.profile, then CORK_PROFILE, then default", async () => {
    const file = `[default]\nrfq_api_key.breaking.cork.tech = default-${KEY}\n[desk]\nrfq_api_key.breaking.cork.tech = desk-${KEY}\n`;
    for (const [over, env, expected] of [[{}, {}, "default"], [{}, { CORK_PROFILE: "desk" }, "desk"], [{ profile: "default" }, { CORK_PROFILE: "desk" }, "default"]] as const) {
      await withCredentials({ file, env }, async () => {
        const seen: Seen[] = [];
        const res = await runTool("cork_submit", openInput({ method: "apiKey" }), ctxWith([{ match: "/rfqs/v2", status: 201, body: {} }], seen, { venueUrl: STAGING, ...over }));
        expect((res.data as { auth: { profile: string } }).auth.profile).toBe(expected);
        expect(postsOf(seen)[0]!.headers?.["x-cork-api-key"]).toBe(`${expected}-${KEY}`);
      });
    }
  });

  it("the HTTP MCP endpoint never uses the server's keys: apiKey is refused there even when a key resolves", async () => {
    await withCredentials({ env: { CORK_RFQ_API_KEY: KEY } }, async () => {
      const seen: Seen[] = [];
      const env = await runTool("cork_submit", openInput({ method: "apiKey" }), ctxWith([{ match: "/rfqs/v2", status: 201, body: {} }], seen, { venueUrl: STAGING, apiKeys: "refuse" }));
      expect(env.state).toBe("unavailable");
      expect(env.warnings[0]?.code).toBe("api_key_missing");
      expect(env.warnings[0]?.message).toContain("HTTP MCP endpoint");
      expect(seen).toHaveLength(0);
    });
  });

  it("a counter: signed by the requester over the RFQ's kind, relayed with the signature; a pass answer likewise by the underwriter", async () => {
    const seen: Seen[] = [];
    const counter = await proveRfqWrite(WRITER, counterInput(), "new_position");
    const env = await runTool("cork_submit", counter, ctxWith([{ match: "/rfqs/v2/rfq_1/counters", status: 201, body: { counter_id: "ctr_1" } }, { match: "/rfqs/v2/rfq_1", body: rfqRecord({ requester: WRITER.address }) }], seen));
    expect(env.state).toBe("ok");
    expect((env.data as { counterId: string }).counterId).toBe("ctr_1");
    const body = postsOf(seen)[0]!.body as Record<string, unknown>;
    expect(body.kind).toBe("new_position");
    expect(body.schema_version).toBe("2");
    expect(body.requester).toBe(WRITER.address.toLowerCase());

    const seen2: Seen[] = [];
    const pass = await proveRfqWrite(WRITER, passInput(), "new_position");
    const env2 = await runTool("cork_submit", pass, ctxWith([{ match: "/rfqs/v2/rfq_1/answers", status: 201, body: { answer_id: "ans_1" } }, { match: "/rfqs/v2/rfq_1", body: rfqRecord({ requester: STRANGER.address }) }], seen2));
    expect(env2.state).toBe("ok");
    expect((postsOf(seen2)[0]!.body as Record<string, unknown>).reason_code).toBe("NO_CAPACITY");
  });

  it("the target gates the venue answers 404 / 409 / 410 / 403 are refused here before the POST burns its request_id", async () => {
    const counter = await proveRfqWrite(WRITER, counterInput(), "new_position");
    const cases: Array<[string, Array<{ match: string; status?: number; body: unknown }>, RegExp]> = [
      ["unknown or v1-opened", [{ match: "/rfqs/v2/rfq_1", status: 404, body: { message: "Unknown rfq_id" } }], /unknown to the venue's \/rfqs\/v2/u],
      ["another kind (a new_position-priced counter on a rollover RFQ)", [{ match: "/rfqs/v2/rfq_1", body: rfqRecord({ requester: WRITER.address, kind: "rollover" }) }], /prices a new_position counter/u],
      ["expired", [{ match: "/rfqs/v2/rfq_1", body: rfqRecord({ requester: WRITER.address, state: "expired" }) }], /expired/u],
      ["not the requester", [{ match: "/rfqs/v2/rfq_1", body: rfqRecord({ requester: STRANGER.address }) }], /only the RFQ's requester may counter/u],
      ["another chain", [{ match: "/rfqs/v2/rfq_1", body: rfqRecord({ requester: WRITER.address, chainId: 8453 }) }], /on chain 8453/u],
    ];
    for (const [label, routes, msg] of cases) {
      const seen: Seen[] = [];
      const env = await runTool("cork_submit", counter, ctxWith(routes, seen));
      expect(env.state, label).toBe("unavailable");
      expect(env.warnings[0]?.message, label).toMatch(msg);
      expect(postsOf(seen), label).toHaveLength(0);
    }
    // A kind the caller names that the RFQ does not have.
    const named = await runTool("cork_submit", { ...counter, action: { ...counter.action, kind: "rollover" } }, ctxWith([{ match: "/rfqs/v2/rfq_1", body: rfqRecord({ requester: WRITER.address }) }]));
    expect(named.warnings[0]?.message).toMatch(/kind "new_position"; a "rollover" counter/u);
  });

  it("a repeated package id is refused before anything is sent (the venue's unique refine)", async () => {
    const seen: Seen[] = [];
    const env = await runTool("cork_submit", { ...openInput(), action: { ...openInput().action, packageIds: ["balanced-v1", "balanced-v1"] } }, ctxWith([], seen));
    expect(env.state).toBe("unavailable");
    expect(env.warnings[0]?.code).toBe("invalid_order_terms");
    expect(env.warnings[0]?.message).toContain("balanced-v1 is repeated");
    expect(seen).toHaveLength(0);
  });

  it("an answer or counter body carries the TARGET RFQ's kind, else the caller's, never a fixed default", () => {
    const counter = { type: "rfq-counter", rfqId: "rfq_1", requester: WRITER.address, premiumAnnualized: "0.03" } as const;
    expect(planRfqWrite({ chainId: 42161, clientRequestId: "test-kind-0001", request: counter as never, target: { kind: "rollover" } }).body.kind).toBe("rollover");
    expect(planRfqWrite({ chainId: 42161, clientRequestId: "test-kind-0001", request: { ...counter, kind: "rollover" } as never }).body.kind).toBe("rollover");
    expect(planRfqWrite({ chainId: 42161, clientRequestId: "test-kind-0001", request: counter as never }).body.kind).toBe("new_position");
  });

  it("a rollover open carrying new_position fields is refused — no new_position-shaped body is sent for it", async () => {
    const seen: Seen[] = [];
    const env = await runTool("cork_submit", { ...openInput(), action: { ...openInput().action, kind: "rollover" } }, ctxWith([], seen));
    expect(env.state).toBe("unavailable");
    expect(env.warnings[0]?.code).toBe("invalid_order_terms");
    expect(env.warnings[0]?.message).toMatch(/belong to a new_position RFQ only/u);
    expect(seen).toHaveLength(0);
  });

  it("a quoted answer must carry, per option, an order made by the underwriter and its order_signature", async () => {
    const built = buildMakerOrder({ chainId: 42161, lop: LOP_ADDRESSES[42161]!, maker: WRITER.address, makerAsset: "0x9D39A5DE30e57443BfF2A8307A4256c8797A3497", takerAsset: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", makingAmount: 1n, takingAmount: 1n, clientRequestId: "test-rfq-q-order", allowPartialFills: false });
    const order = { salt: built.order.salt.toString(), maker: WRITER.address, receiver: built.order.receiver, makerAsset: built.order.makerAsset, takerAsset: built.order.takerAsset, makingAmount: "1", takingAmount: "1", makerTraits: built.order.makerTraits.toString() };
    const option = { option_id: "1", chain_id: 42161, collateral_asset: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", premium_annualized: "0.04", order, order_signature: await WRITER.sign({ hash: built.orderHash }) };
    const quoted = (options: unknown[]) => ({ chainId: 42161, clientRequestId: "test-rfq-q-0001", action: { type: "rfq-answer", rfqId: "rfq_1", underwriter: WRITER.address, status: "quoted", options, auth: { method: "signature", signature: "0x00" } } });
    const refusals: Array<[unknown[], RegExp]> = [
      [[{ option_id: "1", premium_annualized: "0.04" }], /carries no order/u],
      [[{ ...option, order: { ...order, maker: STRANGER.address } }], /must be the answer's underwriter/u],
      [[{ ...option, order_signature: undefined }], /order_signature is missing/u],
      [[option, { ...option, option_id: "2", order: { ...order, maker: WRITER.address.toLowerCase() } }], /repeats another option's order/u],
    ];
    for (const [options, msg] of refusals) {
      const seen: Seen[] = [];
      const env = await runTool("cork_submit", quoted(options), ctxWith([], seen));
      expect(env.state).toBe("unavailable");
      expect(env.warnings[0]?.message).toMatch(msg);
      expect(seen).toHaveLength(0);
    }
    // A well-formed quoted answer: the order addresses are lowercased as the venue stores them,
    // and order_signature rides outside the signed body.
    const seen: Seen[] = [];
    const signed = await proveRfqWrite(WRITER, quoted([option]), "new_position");
    const env = await runTool("cork_submit", signed, ctxWith([{ match: "/rfqs/v2/rfq_1/answers", status: 201, body: { answer_id: "ans_q" } }, { match: "/rfqs/v2/rfq_1", body: rfqRecord({ requester: STRANGER.address }) }], seen));
    expect(env.state).toBe("ok");
    const sentOption = ((postsOf(seen)[0]!.body as { options: Array<Record<string, unknown>> }).options[0])!;
    expect((sentOption.order as { makerAsset: string }).makerAsset).toBe("0x9d39a5de30e57443bff2a8307a4256c8797a3497");
    expect(sentOption.order_signature).toBe(option.order_signature);
  });
});

describe("cork_submit RFQ v2 — the venue's answers", () => {
  it("401/403 are proof refusals; a 409 is an idempotency clash only when the venue says the request_id was reused", async () => {
    const counter = await proveRfqWrite(WRITER, counterInput(), "new_position");
    const get = { match: "/rfqs/v2/rfq_1", body: rfqRecord({ requester: WRITER.address }) };
    const run = (status: number, message: string) => runTool("cork_submit", counter, ctxWith([{ match: "/rfqs/v2/rfq_1/counters", status, body: { error: "x", message } }, get]));
    const r401 = await run(401, "Missing proof: no signature by the requester.");
    expect(r401.state).toBe("unavailable");
    expect(r401.warnings[0]?.code).toBe("venue_rejected");
    expect(r401.warnings[0]?.message).toContain("rfq-write");
    expect((await run(403, "This API key may not \"counter\".")).warnings[0]?.code).toBe("venue_rejected");
    const kind409 = await run(409, 'This RFQ is kind "rollover"; a "new_position" counter cannot be posted on it.');
    expect(kind409.state).toBe("unavailable");
    expect(kind409.warnings[0]?.code).toBe("venue_rejected");
    const idem409 = await run(409, "request_id was already used with a different canonical body or target RFQ.");
    expect(idem409.state).toBe("conflict");
    expect(idem409.warnings[0]?.code).toBe("venue_conflict");
    expect(rfqWriteRefusal409("request_id was concurrently used with a different canonical body or target RFQ.")).toBe(false);
    expect(rfqWriteRefusal409("options[0].order (0xab) is already on the limit-order book. Sign a fresh order (new salt) for this answer.")).toBe(true);
    expect((await run(503, "Signature verification is temporarily unavailable. Retry later.")).warnings[0]?.code).toBe("venue_unreachable");
  });

  it("the old top-level signature field is taught to its new home", () => {
    const t = buildTeaching("cork_submit", [{ code: "unrecognized_keys", keys: ["signature"], path: ["action"], message: 'Unrecognized key: "signature"' }], { action: { type: "rfq-open" } });
    expect(t.issues[0]?.suggestion).toContain("auth: {method: 'signature', signature}");
  });
});
