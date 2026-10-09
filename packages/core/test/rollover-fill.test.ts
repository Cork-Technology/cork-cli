// cork_prepare_orders rollover-fill + deploy-rollover-contract (2026-10-01): the FILLER side of
// a rollover. Real bytes throughout — the roll order is built by the
// same intent builder a holder signs with, signed with a throwaway key, and the fill calldata is
// decoded back through the BaseFiller ABI to prove the job the contract will read.
import { describe, expect, it } from "vitest";
import { decodeAbiParameters, getAddress, hashTypedData, type Hex, keccak256, encodeAbiParameters, toHex, zeroAddress, zeroHash } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  buildRolloverIntent,
  computeOrderDigest,
  corkSettlerDomainSeparator,
  decodeBaseFillerCall,
  encodeOriginData,
  fillerAuthTypedData,
  gaslessOrderOf,
  hashFillerAuth,
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
import { cloneAdmission } from "../src/handlers/rollover-clone-admission.ts";
import { chainStatusName } from "../src/rollover-verify.ts";

// The public Anvil #1 key — a well-known test vector, never a secret: the EXCLUSIVE filler.
const exclusive = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");

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

/** Where the factory deploys for an owner that has no clone yet: the holder's is CLONE (the
 *  address the test orders name), anyone else's a fixed other address. */
const PREDICTED_ELSEWHERE = getAddress("0x0000000000000000000000000000000000000b0b");
/** The chain as the pre-flight reads it: settler orderStatus, the rollover factory, the clone's
 *  owner(), balances, allowances. The factory is ONE world — `clones` maps each owner to the clone
 *  deployed for it, `predicted` overrides where an owner WOULD get one — and isDeployed /
 *  rolloverContractOf / predictRolloverContractOf / owner() all derive from it, so no test can
 *  describe a factory whose views disagree. owner() on an address that is no clone reverts, as a
 *  call to it on chain would. */
function chain(o: { status?: number; clones?: Record<string, string>; predicted?: Record<string, string>; srcBal?: bigint; premBal?: bigint; allow?: Record<string, bigint>; code?: Record<string, string>; isValidSignature?: string | Error } = {}) {
  const clones = new Map(Object.entries(o.clones ?? { [holder.address]: CLONE }).map(([owner, clone]) => [owner.toLowerCase(), getAddress(clone)]));
  const factories = new Set([FACTORY, PREVIOUS.factory as string].map((a) => a.toLowerCase()));
  const factoryOnly = (c: StubCall) => {
    if (!factories.has(c.address.toLowerCase())) throw new Error(`${c.functionName} called on ${c.address}, not a configured rollover factory`);
  };
  const predictedFor = (owner: string) =>
    clones.get(owner.toLowerCase()) ?? getAddress(o.predicted?.[owner] ?? (owner.toLowerCase() === holder.address.toLowerCase() ? CLONE : PREDICTED_ELSEWHERE));
  return stubRpc((c: StubCall) => {
    switch (c.functionName) {
      case "orderStatus": return BigInt(o.status ?? 1);
      case "isDeployedRolloverContract": factoryOnly(c); return [...clones.values()].some((v) => v.toLowerCase() === String(c.args?.[0]).toLowerCase());
      case "rolloverContractOf": factoryOnly(c); return clones.get(String(c.args?.[0]).toLowerCase()) ?? zeroAddress;
      case "predictRolloverContractOf": factoryOnly(c); return predictedFor(String(c.args?.[0]));
      case "owner": {
        const owner = [...clones].find(([, clone]) => clone.toLowerCase() === c.address.toLowerCase())?.[0];
        if (owner === undefined) throw new Error(`execution reverted: ${c.address} is not a rollover clone`);
        return getAddress(owner);
      }
      case "balanceOf": return c.address.toLowerCase() === SRC_CST.toLowerCase() ? (o.srcBal ?? 10n ** 18n) : (o.premBal ?? 10n ** 9n);
      case "allowance": { const [owner, spender] = c.args as [string, string]; return o.allow?.[`${c.address}:${owner}:${spender}`.toLowerCase()] ?? 0n; }
      case "isValidSignature":
        // Only a contract answers ERC-1271: a call to an address without code returns no data.
        if (o.code?.[c.address.toLowerCase()] === undefined) throw new Error(`execution reverted: ${c.address} has no code (returned no data "0x")`);
        if (o.isValidSignature instanceof Error) throw o.isValidSignature;
        return o.isValidSignature ?? "0x1626ba7e";
      default: throw new Error(`no stub for ${c.functionName}`);
    }
  }, { code: o.code ?? {} });
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
    expect(d).toMatchObject({ kind: "rollover-fill", to: BASE_FILLER, fillFunction: "execute", orderDigest: digest, settler: EXACT, settlerKind: "EXACT", settlerGeneration: "phoenix/v0.5", jitMarketWire: "0.2", chainStatus: "Opened", cloneVerified: true, destination: FILLER, premiumCapEstimated: true });
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
    const reserved = await signedOrder({ exclusiveFiller: exclusive.address });
    const priv = await fill({ orderDigest: reserved.digest, signedOrder: reserved.payload });
    expect(priv.state).toBe("unavailable");
    expect(codes(priv)).toEqual(["private_order"]);
    // Every terminal status refuses, by its own name.
    for (const name of ["Settled", "Expired", "Cancelled", "Closing"]) {
      const status = [0, 1, 2, 3, 4, 5].find((i) => chainStatusName(i) === name)!;
      const terminal = await fill({ orderDigest: digest, signedOrder: payload }, { resolveRpc: chain({ status }) });
      expect(terminal.state, name).toBe("conflict");
      expect(codes(terminal)).toEqual(["status_mismatch"]);
      expect(terminal.warnings[0]!.message).toContain(name);
    }
    const opened = await fill({ orderDigest: digest, signedOrder: payload }, { resolveRpc: chain({ status: 1 }) });
    expect(opened.state).toBe("ok");
  });

  it("a RESERVED order: settler.fill's caller is BaseFiller, so even the exclusive filler itself needs a FillerAuth signature over the account that calls BaseFiller; the signature is verified the way the settler verifies it", async () => {
    const { payload, digest } = await signedOrder({ exclusiveFiller: exclusive.address });
    const priv = await fill({ orderDigest: digest, signedOrder: payload });
    const td = (priv.data as { fillerAuthTypedData: Parameters<typeof hashTypedData>[0]; fillerAuthDigest: Hex }).fillerAuthTypedData;
    // The typed data the refusal hands back IS the digest the settler checks: LibFillerAuth.hashFillerAuth
    // = toTypedDataHash(domain, keccak(FILLER_AUTH_TYPEHASH ‖ orderDigest ‖ destination ‖ subFiller)).
    const typehash = keccak256(toHex("FillerAuth(bytes32 orderDigest,address destination,bytes32 subFiller)"));
    const structHash = keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }, { type: "address" }, { type: "bytes32" }], [typehash, digest, FILLER, `0x${FILLER.slice(2).toLowerCase().padStart(64, "0")}` as Hex]));
    const manual = keccak256(`0x1901${corkSettlerDomainSeparator(CHAIN, EXACT).slice(2)}${structHash.slice(2)}` as Hex);
    expect(hashTypedData(td)).toBe(manual);
    expect(hashFillerAuth({ chainId: CHAIN, settler: EXACT, orderDigest: digest, account: FILLER })).toBe(manual);
    expect((priv.data as { fillerAuthDigest: Hex }).fillerAuthDigest).toBe(manual);
    // The exclusive filler (an EOA) delegates to FILLER: verified chain-free by ecrecover.
    const auth = await exclusive.signTypedData(fillerAuthTypedData({ chainId: CHAIN, settler: EXACT, orderDigest: digest, account: FILLER }));
    const authed = await fill({ orderDigest: digest, signedOrder: payload, fillerAuthSig: auth });
    expect(authed.state).toBe("ok");
    expect((authed.data as Data).fillerAuth).toBe("eoa-verified");
    expect((decodeBaseFillerCall((authed.data as Data).calldata).args[0] as { fillerAuthSig: Hex }).fillerAuthSig).toBe(auth);
    // The wrong signer: ecrecover yields someone else and the filler's isValidSignature (an EOA
    // has none — the staticcall reverts) rejects → a conflict, no bytes.
    const wrong = await holder.signTypedData(fillerAuthTypedData({ chainId: CHAIN, settler: EXACT, orderDigest: digest, account: FILLER }));
    const bad = await fill({ orderDigest: digest, signedOrder: payload, fillerAuthSig: wrong });
    expect(bad.state).toBe("conflict");
    expect(codes(bad)).toEqual(["signature_or_reconstruction_mismatch"]);
    expect((bad.data as { recoveredSigner: string }).recoveredSigner.toLowerCase()).toBe(holder.address.toLowerCase());
    // A signature over a DIFFERENT account (the exclusive filler delegating to someone else) is
    // not this fill's authorization.
    const forOther = await exclusive.signTypedData(fillerAuthTypedData({ chainId: CHAIN, settler: EXACT, orderDigest: digest, account: holder.address }));
    const other = await fill({ orderDigest: digest, signedOrder: payload, fillerAuthSig: forOther });
    expect(other.state).toBe("conflict");
    // Without an RPC a non-recovering signature rides unverified, said so.
    const blind = await fill({ orderDigest: digest, signedOrder: payload, fillerAuthSig: wrong }, { resolveRpc: async () => null });
    expect(blind.state).toBe("ok");
    expect((blind.data as Data).fillerAuth).toBe("unverified");
    expect(blind.warnings.find((w) => w.code === "funding_needs_rpc")!.message).toMatch(/does not ecrecover to/u);
    // A reservation for the ACCOUNT ITSELF is still gated: the contract sees BaseFiller as the caller.
    const self = await signedOrder({ exclusiveFiller: FILLER });
    const selfRefused = await fill({ orderDigest: self.digest, signedOrder: self.payload });
    expect(selfRefused.state).toBe("unavailable");
    expect(codes(selfRefused)).toEqual(["private_order"]);
    expect(selfRefused.warnings[0]!.message).toMatch(/YOUR OWN signature/u);
    // A reservation for BaseFiller itself is the one direct pass through this path.
    const forBaseFiller = await signedOrder({ exclusiveFiller: BASE_FILLER as `0x${string}` });
    const direct = await fill({ orderDigest: forBaseFiller.digest, signedOrder: forBaseFiller.payload });
    expect(direct.state).toBe("ok");
    expect((direct.data as Data).fillerAuth).toBe("reserved-for-base-filler");
  });

  it("an order signed under another chain's settler domain cannot be filled here; a passed openDeadline is disclosed chain-free and refused once the chain says the order is still None", async () => {
    const foreign = await signedOrder({ chainId: 42161 });
    const env = await fill({ orderDigest: foreign.digest, signedOrder: foreign.payload });
    expect(env.state).toBe("unavailable");
    expect(env.warnings[0]!.message).toMatch(/originChainId is 42161, not 8453/u);
    const late = await signedOrder({ openDeadline: NOW - 1n, fillDeadline: NOW + 600n });
    const blind = await fill({ orderDigest: late.digest, signedOrder: late.payload }, { resolveRpc: async () => null });
    expect(blind.state).toBe("ok");
    expect(blind.warnings.find((w) => w.code === "would_revert")!.message).toMatch(/Settler__OpenAfterOpenDeadline/u);
    const none = await fill({ orderDigest: late.digest, signedOrder: late.payload }, { resolveRpc: chain({ status: 0 }) });
    expect(none.state).toBe("unavailable");
    expect(none.warnings[0]!.message).toMatch(/Settler__OpenAfterOpenDeadline/u);
    const opened = await fill({ orderDigest: late.digest, signedOrder: late.payload }, { resolveRpc: chain({ status: 1 }) });
    expect(opened.state).toBe("ok");
  });

  it("the fill size defaults to the venue's remainingSize (string or number); inline on a partial order it defaults to the ORDER size and says so", async () => {
    const p = await signedOrder({ settler: PARTIAL, allowPartialFills: true });
    const asString = await fill({ orderDigest: p.digest }, { venueFetch: venue([{ match: `/rollover/v1/orders/${p.digest}`, body: { order: { orderDigest: p.digest, remainingSize: "250000000000000000", payload: p.payload }, fills: [], slots: [] } }]) });
    expect(asString.state).toBe("ok");
    expect((asString.data as Data).fillerSrcCst).toBe("250000000000000000");
    expect(codes(asString)).not.toContain("invalid_order_terms");
    const asNumber = await fill({ orderDigest: p.digest }, { venueFetch: venue([{ match: `/rollover/v1/orders/${p.digest}`, body: { order: { orderDigest: p.digest, remainingSize: 250000000000, payload: p.payload }, fills: [], slots: [] } }]) });
    expect((asNumber.data as Data).fillerSrcCst).toBe("250000000000");
    const inline = await fill({ orderDigest: p.digest, signedOrder: p.payload });
    expect(inline.state).toBe("ok");
    expect((inline.data as Data).fillerSrcCst).toBe("1000000000000000000");
    expect(inline.warnings.find((w) => w.code === "invalid_order_terms")!.message).toMatch(/inline path has no remaining-size source/u);
    const exact = await signedOrder();
    const exactInline = await fill({ orderDigest: exact.digest, signedOrder: exact.payload });
    expect(codes(exactInline)).not.toContain("invalid_order_terms"); // an exact order fills at its size by definition
  });

  it("the clone the ORDER names is admitted the way the settler admits it: deployed first, then owned by the holder; each refusal names the settler's error and the holder's fix", async () => {
    const p = await signedOrder(); // names CLONE, the address the factory deploys for the holder
    const OTHER_PREDICTED = getAddress("0x0000000000000000000000000000000000000abc");
    const HOLDER_CLONE = getAddress("0x0000000000000000000000000000000000000d0d");
    const STRANGER = getAddress("0x0000000000000000000000000000000000005555");
    const refusal = async (world: Parameters<typeof chain>[0]) => {
      const env = await fill({ orderDigest: p.digest, signedOrder: p.payload }, { resolveRpc: chain(world) });
      expect(env.state).toBe("unavailable");
      const w = env.warnings.find((x) => x.code === "invalid_order_terms")!;
      return { data: env.data as Record<string, unknown>, message: w.message };
    };

    // 1. Not deployed, and the order names the holder's predicted address: the holder deploys,
    //    and this SAME signed order then fills.
    const deploys = await refusal({ clones: {} });
    expect(deploys.data).toMatchObject({ settlerError: "Settler__RolloverContractNotDeployed", fix: "holder-deploys-clone", rolloverContract: CLONE, holder: holder.address });
    expect(deploys.message).toMatch(new RegExp(`Settler__RolloverContractNotDeployed\\(${holder.address}\\)`, "u"));
    expect(deploys.message).toMatch(/deploy-rollover-contract from their own account[\s\S]*The same signed order then fills/u);

    // 2. Not deployed, and the order names some other address: no deployment helps.
    const elsewhere = await refusal({ clones: {}, predicted: { [holder.address]: OTHER_PREDICTED } });
    expect(elsewhere.data).toMatchObject({ settlerError: "Settler__RolloverContractNotDeployed", fix: "holder-signs-new-order" });
    expect(elsewhere.message).toMatch(new RegExp(`no deployment can change that[\\s\\S]*new order naming ${OTHER_PREDICTED}`, "u"));

    // 3. Not deployed, while the holder HAS a clone at another address: still check 1, not a
    //    "wrong owner" — and the fix names the clone the holder already has.
    const hasOne = await refusal({ clones: { [holder.address]: HOLDER_CLONE } });
    expect(hasOne.data).toMatchObject({ settlerError: "Settler__RolloverContractNotDeployed", fix: "holder-signs-new-order" });
    expect(hasOne.message).toMatch(new RegExp(`new order naming their clone ${HOLDER_CLONE}`, "u"));

    // 4. The order names someone else's DEPLOYED clone while the holder has none: check 2.
    const theirs = await refusal({ clones: { [STRANGER]: CLONE } });
    expect(theirs.data).toMatchObject({ settlerError: "Settler__UserNotRolloverContractOwner", fix: "holder-signs-new-order" });
    expect(theirs.message).toMatch(new RegExp(`owned by ${STRANGER}, not by the holder[\\s\\S]*Settler__UserNotRolloverContractOwner\\(${holder.address}, ${CLONE}\\)`, "u"));
    expect(theirs.message).toMatch(new RegExp(`new order naming ${PREDICTED_ELSEWHERE}|new order naming ${CLONE}`, "u"));

    // The admitted case still builds, and says it verified the clone.
    const ok = await fill({ orderDigest: p.digest, signedOrder: p.payload }, { resolveRpc: chain() });
    expect(ok.state).toBe("ok");
    expect((ok.data as Record<string, unknown>).cloneVerified).toBe(true);
  });

  it("a partial-settler order fills at a smaller size; a low premium cap and a short balance are named before the chain says so", async () => {
    const p = await signedOrder({ settler: PARTIAL, allowPartialFills: true });
    const env = await fill({ orderDigest: p.digest, signedOrder: p.payload, fillerSrcCst: "250000000000000000", premiumCap: "10" }, { resolveRpc: chain({ srcBal: 10n ** 17n }) });
    expect(env.state).toBe("ok");
    expect(env.data as Data).toMatchObject({ settlerKind: "PARTIAL", fillerSrcCst: "250000000000000000", premiumCap: "10", premiumCapEstimated: false, premiumAtOneToOne: "16" });
    const msgs = env.warnings.filter((w) => w.code === "would_revert").map((w) => w.message);
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toMatch(/premiumCap 10 is below .* = 16, .*Settler__PremiumExceedsCap/u);
    expect(msgs[1]).toMatch(/you hold 100000000000000000 of the src cST/u);
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
    expect(env.data).toMatchObject({ kind: "deploy-rollover-contract", to: FACTORY, calldata: "0x39858cf6", owner: FILLER, predictedRolloverContract: CLONE, existingRolloverContract: null, rolloverGeneration: "phoenix/v0.5", wire: "0.2" });
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

describe("rollover-fill — the HOLDER's signature is verified the way the settler verifies it", () => {
  // The settler runs SignatureChecker.isValidSignatureNow(order.user, orderDigest, signature) and
  // reverts on a false answer. Bytes for a signature the holder did not give can only revert.
  const CONTRACT_CODE = "0x6080";
  // The same factory world as every other test, with the holder as a contract account.
  const chainWithHolder = (o: { holderCode?: string; isValidSignature?: string | Error }) =>
    chain({ ...(o.isValidSignature !== undefined ? { isValidSignature: o.isValidSignature } : {}), code: o.holderCode !== undefined ? { [holder.address.toLowerCase()]: o.holderCode } : {} });
  type Verdict = Data & { holderSignature: string };

  it("the holder's own signature: eoa-verified, bytes built", async () => {
    const { payload, digest } = await signedOrder();
    const env = await fill({ orderDigest: digest, signedOrder: payload });
    expect(env.state).toBe("ok");
    expect((env.data as Verdict).holderSignature).toBe("eoa-verified");
  });

  it("a signature the holder did not give over THIS order: refuted, no bytes", async () => {
    const { payload, digest } = await signedOrder();
    const other = await signedOrder({ orderSize: 2n * 10n ** 18n }); // the same key, another order
    for (const signature of [other.payload.signature, `0x${"11".repeat(65)}`]) {
      const env = await fill({ orderDigest: digest, signedOrder: { ...payload, signature } });
      expect(env.state, signature.slice(0, 12)).toBe("conflict");
      expect(codes(env)).toContain("signature_or_reconstruction_mismatch");
      expect(env.warnings.find((w) => w.code === "signature_or_reconstruction_mismatch")!.message).toMatch(/does not verify for .* over the order digest .*is not a contract account.*no fill bytes are built/u);
      expect((env.data as Record<string, unknown>)["calldata"]).toBeUndefined();
    }
  });

  it("no RPC: a signature that does not recover is not refuted — it rides unverified, and says so", async () => {
    const { payload, digest } = await signedOrder();
    const other = await signedOrder({ orderSize: 2n * 10n ** 18n });
    const env = await fill({ orderDigest: digest, signedOrder: { ...payload, signature: other.payload.signature } }, { resolveRpc: async () => null });
    expect(env.state).toBe("ok");
    expect((env.data as Verdict).holderSignature).toBe("unverified");
    expect(env.warnings.some((w) => w.code === "funding_needs_rpc" && /the holder's signature does not ecrecover/u.test(w.message))).toBe(true);
    // The holder's real signature needs no chain at all.
    const good = await fill({ orderDigest: digest, signedOrder: payload }, { resolveRpc: async () => null });
    expect((good.data as Verdict).holderSignature).toBe("eoa-verified");
  });

  it("a CONTRACT holder is asked its own isValidSignature: accepted, rejected, and a read that failed", async () => {
    const { payload, digest } = await signedOrder();
    const contractSig = { ...payload, signature: `0x${"22".repeat(65)}` as Hex }; // what a Safe would hand over: not an ECDSA signature of the holder key
    const accepted = await fill({ orderDigest: digest, signedOrder: contractSig }, { resolveRpc: chainWithHolder({ holderCode: CONTRACT_CODE }) });
    expect(accepted.state, JSON.stringify(accepted.warnings)).toBe("ok");
    expect((accepted.data as Verdict).holderSignature).toBe("erc1271-verified");
    const rejected = await fill({ orderDigest: digest, signedOrder: contractSig }, { resolveRpc: chainWithHolder({ holderCode: CONTRACT_CODE, isValidSignature: "0xffffffff" }) });
    expect(rejected.state).toBe("conflict");
    expect(rejected.warnings.find((w) => w.code === "signature_or_reconstruction_mismatch")!.message).toMatch(/its isValidSignature did not answer the ERC-1271 magic value/u);
    // An outage is not a verdict: built, labeled.
    const outage = await fill({ orderDigest: digest, signedOrder: contractSig }, { resolveRpc: chainWithHolder({ holderCode: CONTRACT_CODE, isValidSignature: Object.assign(new Error("fetch failed"), { name: "HttpRequestError" }) }) });
    expect(outage.state, JSON.stringify(outage.warnings)).toBe("ok");
    expect((outage.data as Verdict).holderSignature).toBe("unverified");
    expect(outage.warnings.some((w) => w.code === "chain_read_failed" && /isValidSignature could not be asked/u.test(w.message))).toBe(true);
  });
});

describe("cloneAdmission — the settler's two clone checks as a pure rule", () => {
  const facts = { user: holder.address, named: CLONE, deployed: true, owner: holder.address, predicted: CLONE, holderClone: CLONE } as const;
  it("admits the holder's own deployed clone, and fails closed on a deployed clone whose owner could not be read", () => {
    expect(cloneAdmission(facts, "test")).toEqual({ ok: true });
    // Unreachable through the handler (owner() is read on every deployed clone and a failed read
    // throws), so the rule must not read a missing owner as the holder.
    expect(cloneAdmission({ ...facts, owner: null }, "test")).toMatchObject({ ok: false, settlerError: "Settler__UserNotRolloverContractOwner" });
  });
  it("owner comparison is by address, not by spelling", () => {
    expect(cloneAdmission({ ...facts, owner: holder.address.toLowerCase() as `0x${string}` }, "test")).toEqual({ ok: true });
  });
});
