// cork_prepare_orders rollover-fill + deploy-rollover-contract (2026-10-01, cork-cli-private#24
// item 4): the FILLER side of a rollover. Real bytes throughout — the roll order is built by the
// same intent builder a holder signs with, signed with a throwaway key, and the fill calldata is
// decoded back through the BaseFiller ABI to prove the job the contract will read.
import { describe, expect, it } from "vitest";
import { decodeAbiParameters, getAddress, type Hex, zeroHash } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  buildRolloverIntent,
  computeOrderDigest,
  decodeBaseFillerCall,
  encodeOriginData,
  gaslessOrderOf,
  GASLESS_ORDER_COMPONENTS,
  hashJitMarketParams,
  parseRolloverPayload,
  requiredPremium,
  resolveRollover,
  runTool,
  type HandlerContext,
  type RolloverVenuePost,
} from "@cork/core";
import { stubRpc, type StubCall } from "./helpers.ts";

const NOW = 1_790_000_000n;
const CHAIN = 8453;
// The public Anvil #0 key — a well-known test vector, never a secret. The cPT HOLDER (order user).
const holder = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const FILLER = getAddress("0x00000000000000000000000000000000000000f1");
const CLONE = getAddress("0x0000000000000000000000000000000000000c10");
const SRC_CST = getAddress("0x00000000000000000000000000000000000000c1");
const DST_CST = getAddress("0x00000000000000000000000000000000000000c2");
const PREMIUM = getAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
const SRC_POOL = `0x${"11".repeat(32)}` as const;
const DST_POOL = `0x${"22".repeat(32)}` as const;
type Seen = { url: string; method: string };

const rollover = (await resolveRollover(CHAIN)).rollover!;
const EXACT = rollover.exactSettler as `0x${string}`;
const PARTIAL = rollover.partialSettler as `0x${string}`;
const BASE_FILLER = rollover.baseFiller!;
const FACTORY = rollover.factory as `0x${string}`;
const PREVIOUS = rollover.generations!.find((g) => g.label === "phoenix/v0.3-rc.1")!;

/** A signed roll order the way the venue stores it: the intent builder's venuePost + the
 *  holder's EIP-712 signature + the envelope the venue derives. */
async function signedOrder(over: Partial<Parameters<typeof buildRolloverIntent>[0]> = {}) {
  const built = buildRolloverIntent({
    chainId: CHAIN, user: holder.address, settler: EXACT, rolloverContract: CLONE, srcCstToken: SRC_CST, dstCstToken: DST_CST, premiumToken: PREMIUM,
    srcPoolId: SRC_POOL, dstPoolId: DST_POOL, orderSize: 10n ** 18n, minPremiumPerShare: 62n, openDeadline: NOW + 600n, fillDeadline: NOW + 1200n,
    clientRequestId: "fill-test-0001", ...over,
  });
  const signature = await holder.signTypedData({ domain: built.domain, types: built.types, primaryType: "OrderData", message: built.order });
  const payload = { chainId: CHAIN, order: built.venuePost.order, intent: built.venuePost.intent, signature, envelope: { orderDataType: built.orderDataType, originData: encodeOriginData(gaslessOrderOf(built.order)) } };
  return { built, payload, digest: built.orderDigest };
}

/** The chain as the pre-flight reads it: settler orderStatus, factory rolloverContractOf, balances, allowances. */
function chain(o: { status?: number; clone?: string; srcBal?: bigint; premBal?: bigint; allow?: Record<string, bigint> } = {}) {
  return stubRpc((c: StubCall) => {
    switch (c.functionName) {
      case "orderStatus": return BigInt(o.status ?? 1);
      case "rolloverContractOf": return o.clone ?? CLONE;
      case "predictRolloverContractOf": return CLONE;
      case "balanceOf": return c.address.toLowerCase() === SRC_CST.toLowerCase() ? (o.srcBal ?? 10n ** 18n) : (o.premBal ?? 10n ** 9n);
      case "allowance": { const [owner, spender] = c.args as [string, string]; return o.allow?.[`${c.address}:${owner}:${spender}`.toLowerCase()] ?? 0n; }
      default: throw new Error(`no stub for ${c.functionName}`);
    }
  });
}
function venue(routes: Array<{ match: string; status?: number; body: unknown }>, seen: Seen[] = []) {
  return async (url: string, init?: RequestInit): Promise<Response> => {
    seen.push({ url, method: init?.method ?? "GET" });
    const r = routes.find((r) => url.includes(r.match));
    if (!r) return new Response(JSON.stringify({ statusCode: 404, error: "Not Found" }), { status: 404 });
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
  };
}
const fill = (action: Record<string, unknown>, ctx: Partial<HandlerContext> = {}) =>
  runTool("cork_prepare_orders", { chainId: CHAIN, account: FILLER, clientRequestId: "fill-0001", action: { type: "rollover-fill", ...action } }, { nowSeconds: NOW, resolveRpc: chain(), ...ctx });
const codes = (env: { warnings: Array<{ code: string }> }) => env.warnings.map((w) => w.code);
type Data = Record<string, unknown> & { calldata: Hex; approvals: Array<{ token: string; spender: string; amount: string; kind: string; satisfied?: boolean }> };

describe("rollover-fill — the filler's BaseFiller.execute from the signed payload", () => {
  it("inline payload: the job decodes back field-for-field, the envelope is abi.encode(order), both allowances go to BaseFiller, the premium cap defaults to ceil(size × rate / 1e18)", async () => {
    const { built, payload, digest } = await signedOrder();
    const env = await fill({ orderDigest: digest, signedOrder: payload });
    expect(env.state).toBe("ok");
    const d = env.data as Data;
    expect(d).toMatchObject({ kind: "rollover-fill", to: BASE_FILLER, fillFunction: "execute", orderDigest: digest, settler: EXACT, settlerKind: "EXACT", settlerGeneration: "phoenix/v0.4-rc.1", jitMarketWire: "0.2", chainStatus: "Opened", cloneVerified: true, destination: FILLER, premiumCapEstimated: true });
    expect(d.fillerSrcCst).toBe((10n ** 18n).toString());
    expect(d.premiumCap).toBe(requiredPremium(10n ** 18n, 62n).toString());
    expect(d.premiumCap).toBe("62");
    const { functionName, args } = decodeBaseFillerCall(d.calldata);
    expect(functionName).toBe("execute");
    const job = args[0] as unknown as { settler: string; order: { originSettler: string; user: string; nonce: bigint; originChainId: bigint; openDeadline: number; fillDeadline: number; orderDataType: Hex; orderData: Hex }; userSig: Hex; srcCst: string; premiumToken: string; fillerSrcCst: bigint; intent: { rolloverContract: string; orderDigest: Hex; deadline: bigint; nonce: bigint; preRolloverHooks: unknown[] }; premiumCap: bigint; minDstPerSrc: bigint; fillerAuthSig: Hex };
    expect(job.settler).toBe(EXACT);
    expect(job.order).toMatchObject({ originSettler: EXACT, user: holder.address, nonce: built.order.orderSalt, originChainId: BigInt(CHAIN), openDeadline: Number(NOW + 600n), fillDeadline: Number(NOW + 1200n), orderDataType: built.orderDataType });
    expect(job.order.orderData.length).toBe(2 + 864 * 2);
    expect(job.userSig).toBe(payload.signature);
    expect(job.srcCst).toBe(SRC_CST);
    expect(job.premiumToken).toBe(PREMIUM);
    expect(job.fillerSrcCst).toBe(10n ** 18n);
    expect(job.intent).toMatchObject({ rolloverContract: CLONE, orderDigest: digest, deadline: built.intent.deadline, nonce: built.intent.nonce });
    expect(job.premiumCap).toBe(62n);
    expect(job.minDstPerSrc).toBe(0n);
    expect(job.fillerAuthSig).toBe("0x");
    // The envelope the settler re-encodes and compares byte-for-byte.
    const [reencoded] = decodeAbiParameters([{ type: "tuple", components: GASLESS_ORDER_COMPONENTS }], d.originData as Hex);
    expect(reencoded).toEqual(job.order);
    expect(computeOrderDigest(CHAIN, parseRolloverPayload(payload).order)).toBe(digest);
    expect(d.approvals.map((a) => [a.token, a.spender, a.amount, a.kind, a.satisfied])).toEqual([[SRC_CST, BASE_FILLER, (10n ** 18n).toString(), "exact", false], [PREMIUM, BASE_FILLER, "62", "cap", false]]);
    expect(codes(env)).toEqual(["premium_cap_estimated", "approval_missing", "unsigned_artifact"]);
    expect(env.provenance.source).toBe("config");
    expect((d.execution as { kind: string }).kind).toBe("eth-transaction");
  });

  it("venue path: the record is fetched by digest, the digest is RECOMPUTED, a payload that hashes elsewhere is a conflict and never filled", async () => {
    const { payload, digest } = await signedOrder();
    const seen: Seen[] = [];
    const ok = await fill({ orderDigest: digest }, { venueFetch: venue([{ match: `/rollover/v1/orders/${digest}`, body: { order: { orderDigest: digest, remainingSize: "1000000000000000000", payload }, fills: [], slots: [] } }], seen) });
    expect(ok.state).toBe("ok");
    expect(ok.provenance.source).toBe("service");
    expect(seen[0]!.url).toContain(`/rollover/v1/orders/${digest}`);
    const other = `0x${"ab".repeat(32)}` as const;
    const lie = await fill({ orderDigest: other }, { venueFetch: venue([{ match: `/rollover/v1/orders/${other}`, body: { order: { orderDigest: other, payload }, fills: [], slots: [] } }]) });
    expect(lie.state).toBe("conflict");
    expect(codes(lie)).toEqual(["order_hash_mismatch"]);
    expect((lie.data as { localOrderDigest: string }).localOrderDigest).toBe(digest);
    const missing = await fill({ orderDigest: other }, { venueFetch: venue([]) });
    expect(missing.state).toBe("unavailable");
    expect(codes(missing)).toEqual(["order_not_found"]);
  });

  it("the settler's own rules, pre-empted by name: full size on an ExactSettler, mode vs settler kind, a passed fillDeadline, a reserved filler, a terminal status", async () => {
    const { payload, digest } = await signedOrder();
    const short = await fill({ orderDigest: digest, signedOrder: payload, fillerSrcCst: "500000000000000000" });
    expect(short.state).toBe("unavailable");
    expect(short.warnings[0]!.message).toMatch(/Settler__ExactFillRequiresFullOrderSize/u);
    const partialOnExact = await signedOrder({ allowPartialFills: true });
    const mode = await fill({ orderDigest: partialOnExact.digest, signedOrder: partialOnExact.payload });
    expect(mode.state).toBe("unavailable");
    expect(codes(mode)).toEqual(["settler_mode_mismatch"]);
    const expired = await signedOrder({ fillDeadline: NOW - 1n, openDeadline: NOW - 2n });
    const late = await fill({ orderDigest: expired.digest, signedOrder: expired.payload });
    expect(late.state).toBe("unavailable");
    expect(late.warnings[0]!.message).toMatch(/Settler__FillAfterDeadline/u);
    const reserved = await signedOrder({ exclusiveFiller: getAddress("0x00000000000000000000000000000000000000e1") });
    const priv = await fill({ orderDigest: reserved.digest, signedOrder: reserved.payload });
    expect(priv.state).toBe("unavailable");
    expect(codes(priv)).toEqual(["private_order"]);
    const authed = await fill({ orderDigest: reserved.digest, signedOrder: reserved.payload, fillerAuthSig: "0x1234" });
    expect(authed.state).toBe("ok");
    expect((decodeBaseFillerCall((authed.data as Data).calldata).args[0] as { fillerAuthSig: Hex }).fillerAuthSig).toBe("0x1234");
    const settled = await fill({ orderDigest: digest, signedOrder: payload }, { resolveRpc: chain({ status: 2 }) });
    expect(settled.state).toBe("conflict");
    expect(codes(settled)).toEqual(["status_mismatch"]);
    expect(settled.warnings[0]!.message).toMatch(/Settled/u);
  });

  it("a partial-settler order fills at a smaller size; a wrong clone, a low premium cap and a short balance are named before the chain says so", async () => {
    const p = await signedOrder({ settler: PARTIAL, allowPartialFills: true });
    const env = await fill({ orderDigest: p.digest, signedOrder: p.payload, fillerSrcCst: "250000000000000000", premiumCap: "10" }, { resolveRpc: chain({ srcBal: 10n ** 17n }) });
    expect(env.state).toBe("ok");
    expect(env.data as Data).toMatchObject({ settlerKind: "PARTIAL", fillerSrcCst: "250000000000000000", premiumCap: "10", premiumCapEstimated: false, premiumAtOneToOne: "16" });
    const msgs = env.warnings.filter((w) => w.code === "would_revert").map((w) => w.message);
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toMatch(/premiumCap 10 is below .* = 16, .*Settler__PremiumExceedsCap/u);
    expect(msgs[1]).toMatch(/you hold 100000000000000000 of the src cST/u);
    const wrongClone = await fill({ orderDigest: p.digest, signedOrder: p.payload, fillerSrcCst: "250000000000000000" }, { resolveRpc: chain({ clone: "0x00000000000000000000000000000000000000de" }) });
    expect(wrongClone.state).toBe("unavailable");
    expect(wrongClone.warnings[0]!.message).toMatch(/Settler__RolloverContractNotDeployed/u);
  });

  it("a JIT commitment: executeWithMarket on the settler generation's wire, the instruction must hash to the signed commitment; missing or surplus instructions refuse", async () => {
    const jit = { collateralAsset: PREMIUM, referenceAsset: DST_CST, expiryTimestamp: NOW + 86_400n * 10n, recipe: getAddress("0x00000000000000000000000000000000000000ec"), rateOverride: 0n, rateMin: 1n, rateMax: 2n, rateChangePerDayMax: 3n, rateChangeCapacityMax: 4n, additionalData: "0x" as Hex, oracleSalt: zeroHash, swapFeePercentage: 0n, unwindSwapFeePercentage: 0n };
    const hash = hashJitMarketParams(jit, "0.2");
    const committed = await signedOrder({ jitMarketHash: hash });
    const jitInput = { collateralAsset: jit.collateralAsset, referenceAsset: jit.referenceAsset, expiryTimestamp: jit.expiryTimestamp.toString(), recipe: jit.recipe, constraint: { rateMin: "1", rateMax: "2", rateChangePerDayMax: "3", rateChangeCapacityMax: "4" } };
    const env = await fill({ orderDigest: committed.digest, signedOrder: committed.payload, jitMarket: jitInput });
    expect(env.state).toBe("ok");
    expect((env.data as Data).fillFunction).toBe("executeWithMarket");
    const { functionName, args } = decodeBaseFillerCall((env.data as Data).calldata);
    expect(functionName).toBe("executeWithMarket");
    expect(args[1]).toMatchObject({ collateralAsset: PREMIUM, referenceAsset: DST_CST, recipe: jit.recipe, oracleSalt: zeroHash, constraint: { rateMin: 1n, rateMax: 2n, rateChangePerDayMax: 3n, rateChangeCapacityMax: 4n } });
    const drifted = await fill({ orderDigest: committed.digest, signedOrder: committed.payload, jitMarket: { ...jitInput, swapFeePercentage: "1000000000000000000" } });
    expect(drifted.state).toBe("conflict");
    expect(codes(drifted)).toEqual(["jit_market_hash_mismatch"]);
    expect((drifted.data as { committedJitMarketHash: string }).committedJitMarketHash).toBe(hash);
    const missing = await fill({ orderDigest: committed.digest, signedOrder: committed.payload });
    expect(missing.state).toBe("unavailable");
    expect(missing.warnings[0]!.message).toMatch(/pass the negotiated jitMarket instruction/u);
    const plain = await signedOrder();
    const surplus = await fill({ orderDigest: plain.digest, signedOrder: plain.payload, jitMarket: jitInput });
    expect(surplus.state).toBe("unavailable");
    expect(surplus.warnings[0]!.message).toMatch(/commits to NO just-in-time market/u);
  });

  it("an rc.2 settler (the previous generation) builds against ITS BaseFiller and refuses a non-zero oracleSalt its struct cannot carry", async () => {
    const jit = { collateralAsset: PREMIUM, referenceAsset: DST_CST, expiryTimestamp: NOW + 86_400n * 10n, recipe: getAddress("0x00000000000000000000000000000000000000ec"), rateOverride: 0n, rateMin: 1n, rateMax: 2n, rateChangePerDayMax: 3n, rateChangeCapacityMax: 4n, additionalData: "0x" as Hex, swapFeePercentage: 0n, unwindSwapFeePercentage: 0n };
    const hash = hashJitMarketParams(jit, "rc.2");
    const o = await signedOrder({ settler: PREVIOUS.exactSettler as `0x${string}`, jitMarketHash: hash });
    const jitInput = { collateralAsset: jit.collateralAsset, referenceAsset: jit.referenceAsset, expiryTimestamp: jit.expiryTimestamp.toString(), recipe: jit.recipe, constraint: { rateMin: "1", rateMax: "2", rateChangePerDayMax: "3", rateChangeCapacityMax: "4" } };
    const env = await fill({ orderDigest: o.digest, signedOrder: o.payload, jitMarket: jitInput });
    expect(env.state).toBe("ok");
    expect(env.data as Data).toMatchObject({ to: PREVIOUS.baseFiller, settlerGeneration: "phoenix/v0.3-rc.1", jitMarketWire: "rc.2", fillFunction: "executeWithMarket" });
    expect(decodeBaseFillerCall((env.data as Data).calldata).args[1]).not.toHaveProperty("oracleSalt");
    const salted = await fill({ orderDigest: o.digest, signedOrder: o.payload, jitMarket: { ...jitInput, oracleSalt: `0x${"01".repeat(32)}` } });
    expect(salted.state).toBe("unavailable");
    expect(salted.warnings[0]!.message).toMatch(/oracleSalt/u);
  });

  it("without an RPC the fill is built from the signed payload alone and says what was not read", async () => {
    const { payload, digest } = await signedOrder();
    const env = await fill({ orderDigest: digest, signedOrder: payload }, { resolveRpc: async () => null });
    expect(env.state).toBe("ok");
    expect(codes(env)).toEqual(["premium_cap_estimated", "funding_needs_rpc", "unsigned_artifact"]);
    expect((env.data as Data).chainStatus).toBeNull();
    expect((env.data as Data).approvals.every((a) => a.satisfied === undefined)).toBe(true);
  });
});

describe("deploy-rollover-contract — the per-account clone", () => {
  const deploy = (action: Record<string, unknown>, ctx: Partial<HandlerContext> = {}) =>
    runTool("cork_prepare_orders", { chainId: CHAIN, account: FILLER, clientRequestId: "clone-0001", action: { type: "deploy-rollover-contract", ...action } }, { nowSeconds: NOW, ...ctx });

  it("targets the primary generation's factory with deployRolloverContract(), reports the predicted clone and that none exists", async () => {
    const env = await deploy({}, { resolveRpc: stubRpc((c: StubCall) => (c.functionName === "predictRolloverContractOf" ? CLONE : c.functionName === "rolloverContractOf" ? "0x0000000000000000000000000000000000000000" : (() => { throw new Error(`no stub for ${c.functionName}`); })())) });
    expect(env.state).toBe("ok");
    // deployRolloverContract() — selector 0x39858cf6, no arguments.
    expect(env.data).toMatchObject({ kind: "deploy-rollover-contract", to: FACTORY, calldata: "0x39858cf6", owner: FILLER, predictedRolloverContract: CLONE, existingRolloverContract: null, rolloverGeneration: "phoenix/v0.4-rc.1", wire: "0.2" });
    expect(codes(env)).toEqual(["unsigned_artifact"]);
  });

  it("an existing clone is reported, and an owner that is not the sender is called out (the factory deploys for msg.sender only)", async () => {
    const env = await deploy({ owner: holder.address }, { resolveRpc: stubRpc((c: StubCall) => (c.functionName === "predictRolloverContractOf" ? CLONE : CLONE)) });
    expect(env.state).toBe("ok");
    expect((env.data as { existingRolloverContract: string }).existingRolloverContract).toBe(CLONE);
    expect(codes(env)).toEqual(["rollover_contract_exists", "invalid_order_terms", "unsigned_artifact"]);
    expect(env.warnings[0]!.message).toMatch(/CorkRolloverContractFactory__AlreadyDeployed/u);
  });
});

export type { RolloverVenuePost };
