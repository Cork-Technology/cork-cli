import { describe, expect, it } from "vitest";
import type { PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { BUNDLED_DEFAULTS, decodeJitExtension, decodeMakerTraits, runTool } from "@cork/core";
import type { PrepareOrdersInput } from "@cork/schemas";
import { prepareCstPermit, type CstPermitTypedData } from "../src/handlers/jit-permit.ts";
import { permitWorld, signer, CST, CA, NOW, WAD, CONSTRAINT } from "./jit-permit-fixture.ts";


// The envelope deliberately permits tool-specific data; these assertions exercise its public JSON.
interface TestData {
  jit: { permitTypedData: CstPermitTypedData; reprepareInput: PrepareOrdersInput & { action: Extract<PrepareOrdersInput["action"], { type: "maker-order" | "answer-rfq" }> & { jitMarket: NonNullable<Extract<PrepareOrdersInput["action"], { type: "maker-order" }>["jitMarket"]> } }; permitPreparation: { status: string; tokenState: string }; derivedPoolId: string };
  answer: { pool: { poolId: string }; quotedOption: { fresh_until: number }; expirySeconds: number; supersedes: string };
  typedData: { message: { makerTraits: string } };
  orderHash: string;
  extension: `0x${string}`;
  execution: { then: string[] };
  orderSignable: boolean;
}
const dataOf = (env: { data: unknown }) => env.data as TestData;

async function signReprepare(d: TestData) {
  const td = d.jit.permitTypedData;
  const signature = await signer.signTypedData({ ...td, message: { ...td.message, nonce: BigInt(td.message.nonce), value: BigInt(td.message.value), deadline: BigInt(td.message.deadline) } });
  const request = structuredClone(d.jit.reprepareInput);
  request.action.jitMarket.permits![0]!.signature = signature;
  return request;
}

describe("maker cST permit preparation", () => {
  it("returns a ready-to-sign newborn permit and unsigned pinned reprepare material", async () => {
    const w = permitWorld(); const d = dataOf(await w.prepare());
    expect(d.jit.permitTypedData).toMatchObject({ primaryType: "Permit", domain: { name: "SYN-REF10cST", version: "1", chainId: 8453, verifyingContract: CST }, message: { owner: signer.address, spender: BUNDLED_DEFAULTS.lopAddresses[8453], value: String(WAD), nonce: "0", deadline: String(NOW + 600n) } });
    expect(d.jit.reprepareInput.action.jitMarket.constraint).toEqual(Object.fromEntries(Object.entries(CONSTRAINT).map(([k,v]) => [k,String(v)])));
    expect(d.jit.permitPreparation.status).toBe("awaiting-signature");
  });
  it("honors an explicit RFQ constraint during its initial derivation despite live resolve drift", async () => {
    const w = permitWorld(); w.state.drift = true;
    const env = await w.prepare({ ...w.input, action: { type: "answer-rfq", rfqId: "rfq_local", premiumAnnualized: "0.04", expiryTimestamp: w.input.action.jitMarket.expiryTimestamp, jitMarket: { recipe: w.input.action.jitMarket.recipe, enableJitMint: true, constraint: Object.fromEntries(Object.entries(CONSTRAINT).map(([k,v])=>[k,String(v)])) } } });
    const d = dataOf(env);
    expect(d.answer.pool.poolId).toBe(w.poolId);
    expect(d.jit.derivedPoolId).toBe(w.poolId);
  });
  it("signs the token permit before the final order, preserving pool identity while extension/hash change", async () => {
    const w = permitWorld(); const first = dataOf(await w.prepare());
    const request = await signReprepare(first); w.state.drift = true;
    const result = await w.prepare(request); expect(result.state).toBe("ok");
    const final = dataOf(result);
    expect(final.jit.permitPreparation.status).toBe("verified");
    expect(final.jit.derivedPoolId).toBe(first.jit.derivedPoolId);
    expect(final.extension).not.toBe(first.extension);
    expect(final.orderHash).not.toBe(first.orderHash);
    expect(final.jit.permitTypedData).toBeUndefined();
  });
  it("prepares and verifies a nonzero-nonce EOA permit through viem's successful empty-code normalization", async () => {
    const w = permitWorld(); w.state.exists = true; w.state.nonce = 7n;
    const d = dataOf(await w.prepare());
    expect(d.jit.permitTypedData.message.nonce).toBe("7");
    expect(d.jit.permitPreparation.tokenState).toBe("existing");
    expect((await w.prepare(await signReprepare(d))).state).toBe("ok");
  });
  it("keeps a rejected owner-code RPC unavailable rather than treating the maker as an EOA", async () => {
    const w = permitWorld(); w.state.exists = true; w.state.nonce = 7n; w.state.ownerCodeRejects = true;
    const d = dataOf(await w.prepare());
    expect(d.jit.permitPreparation.status).toBe("unavailable");
    expect(d.orderSignable).toBe(false);
    expect(d.jit.permitTypedData).toBeUndefined();
    expect(d.jit.reprepareInput).toBeUndefined();
  });
  it("keeps real nonempty owner bytecode incompatible with the EOA-only v/r/s adapter", async () => {
    const w = permitWorld(); w.state.exists = true; w.state.ownerContract = true;
    const result = await prepareCstPermit({
      client: w.client as unknown as PublicClient, chainId: 8453, owner: signer.address,
      spender: BUNDLED_DEFAULTS.lopAddresses[8453]!, token: CST,
      poolManager: BUNDLED_DEFAULTS.generations[8453]!.sets["phoenix/v0.5"]!.phoenix!.poolManager!,
      poolId: w.poolId, amount: WAD, deadline: NOW + 600n, now: NOW, wire: "vrs", permits: [],
      observeCreated: async () => { throw new Error("contract v/r/s must refuse before token creation"); },
    });
    expect(result.status).toBe("unavailable");
    expect(result.typedData).toBeUndefined();
    expect(result.permit).toBeUndefined();
  });
  it.each(["nonce", "name", "owner", "value", "deadline", "token"] as const)("rejects a reprepare with changed %s binding", async (field) => {
    const w = permitWorld(); w.state.exists = true; w.state.nonce = 7n;
    const request = await signReprepare(dataOf(await w.prepare()));
    if (field === "nonce") w.state.nonce++;
    if (field === "name") w.state.name += "-changed";
    if (field === "owner") request.account = "0x000000000000000000000000000000000000abcd";
    if (field === "value") request.action.jitMarket.permits![0]!.value = String(2n * WAD);
    if (field === "deadline") request.action.jitMarket.permits![0]!.deadline = String(NOW + 1n);
    if (field === "token") request.action.jitMarket.permits![0]!.token = CA;
    expect((await w.prepare(request)).state).not.toBe("ok");
  });
  it("rejects a signature made by another EOA even when the metadata pins match", async () => {
    const w = permitWorld(); const d = dataOf(await w.prepare());
    const request = await signReprepare(d);
    const other = privateKeyToAccount(`0x${"02".repeat(32)}`);
    const td = d.jit.permitTypedData;
    request.action.jitMarket.permits![0]!.signature = await other.signTypedData({ ...td, message: { ...td.message, nonce: BigInt(td.message.nonce), value: BigInt(td.message.value), deadline: BigInt(td.message.deadline) } });
    expect((await w.prepare(request)).state).not.toBe("ok");
  });
  it.each(["domainChain", "domainToken", "domainFields", "extensions", "unavailable", "simulationFails"] as const)("does not return a signable permit for unsupported/unreadable %s", async field => {
    const w = permitWorld();
    if (field === "domainChain") w.state.domainChain = 1n;
    if (field === "domainToken") w.state.domainToken = CA;
    if (field === "domainFields") w.state.domainFields = "0x1f";
    if (field === "extensions") w.state.extensions = [1n];
    if (field === "unavailable") w.state.unavailable = true;
    if (field === "simulationFails") w.state.simulationFails = true;
    const env = await w.prepare();
    if (field === "unavailable" || field === "simulationFails") {
      const d = dataOf(env);
      expect(d.orderSignable).toBe(false);
      expect(d.jit.permitPreparation.status).toBe("unavailable");
      expect(d.jit.permitTypedData).toBeUndefined();
    } else {
      expect(env.state).not.toBe("ok");
      expect(env.data).toBeNull();
    }
  });
  it("needs no domain/nonce reads when existing cST allowance already covers the pull", async () => {
    const w = permitWorld(); w.state.exists = true; w.state.allowance = WAD;
    const d = dataOf(await w.prepare());
    expect(d.jit.permitPreparation.status).toBe("satisfied");
    expect(w.calls.filter(c => c.functionName === "nonces" || c.functionName === "eip712Domain")).toEqual([]);
  });
  it("preserves unpinned pre-signed permit input without extra token metadata reads", async () => {
    const w = permitWorld(); const request = await signReprepare(dataOf(await w.prepare()));
    delete request.action.jitMarket.permits![0]!.nonce;
    delete request.action.jitMarket.permits![0]!.typedDataHash;
    w.calls.length = 0;
    expect((await w.prepare(request)).state).toBe("ok");
    expect(w.calls.filter(c => c.functionName === "nonces" || c.functionName === "eip712Domain")).toEqual([]);
  });
  it("leaves BUY maker and Permit2 paths without an automatic cST permit", async () => {
    const w = permitWorld();
    const buy = dataOf(await w.prepare({ ...w.input, action: { ...w.input.action, side: "BUY", makerAsset: CA, takerAsset: CST } }));
    const p2 = dataOf(await w.prepare({ ...w.input, action: { ...w.input.action, usePermit2: true } }));
    expect(buy.jit.permitTypedData).toBeUndefined();
    expect(p2.jit.permitTypedData).toBeUndefined();
    expect(w.calls.filter(c => c.functionName === "nonces" || c.functionName === "eip712Domain")).toEqual([]);
  });
  it("supports contract-wallet signature bytes on the bytes adapter and rejects ERC-1271 failure", async () => {
    const w = permitWorld(); w.state.ownerContract = true;
    const d = dataOf(await w.prepare());
    const request = structuredClone(d.jit.reprepareInput);
    request.action.jitMarket.permits![0]!.signature = "0x1234";
    expect((await w.prepare(request)).state).toBe("ok");
    w.state.contractSignatureValid = false;
    expect((await w.prepare(request)).state).not.toBe("ok");
  });
  it("re-prepares the original RFQ action with a verified permit under resolver drift", async () => {
    const w = permitWorld();
    const input = { ...w.input, action: { type: "answer-rfq", rfqId: "rfq_local", premiumAnnualized: "0.04", expiryTimestamp: w.input.action.jitMarket.expiryTimestamp, jitMarket: { recipe: w.input.action.jitMarket.recipe, enableJitMint: true } } };
    const first = dataOf(await w.prepare(input));
    expect(first.jit.reprepareInput.action.type).toBe("answer-rfq");
    const request = await signReprepare(first); w.state.drift = true;
    const env = await w.prepare(request); expect(env.state).toBe("ok");
    const final = dataOf(env);
    expect(final.jit.permitPreparation.status).toBe("verified");
    expect(final.answer.pool.poolId).toBe(first.answer.pool.poolId);
    expect(final.orderHash).not.toBe(first.orderHash);
  });
  it("allows an already-consumed permit when the standing allowance covers the full maker pull", async () => {
    const w = permitWorld(); const request = await signReprepare(dataOf(await w.prepare()));
    w.state.exists = true; w.state.nonce = 1n; w.state.allowance = WAD;
    const env = await w.prepare(request); expect(env.state).toBe("ok");
    expect(dataOf(env).jit.permitPreparation.status).toBe("satisfied");
  });
  it("rejects makingAmount drift even when the old permit value would cover a smaller order", async () => {
    const w = permitWorld(); const request = await signReprepare(dataOf(await w.prepare()));
    if (request.action.type !== "maker-order") throw new Error("fixture expected maker");
    request.action.makingAmount = String(WAD / 2n);
    expect((await w.prepare(request)).state).not.toBe("ok");
  });
  it("rejects a signature for a foreign spender without trusting the copied pins", async () => {
    const w = permitWorld(); const d = dataOf(await w.prepare()); const request = await signReprepare(d);
    const td = d.jit.permitTypedData;
    request.action.jitMarket.permits![0]!.signature = await signer.signTypedData({ ...td, message: { ...td.message, spender: CA, value: BigInt(td.message.value), nonce: BigInt(td.message.nonce), deadline: BigInt(td.message.deadline) } });
    expect((await w.prepare(request)).state).not.toBe("ok");
  });
  it("refuses an already-expired helper deadline", async () => {
    const w = permitWorld(); const permitDeadline = String(NOW);
    expect((await w.prepare({ ...w.input, action: { ...w.input.action, jitMarket: { ...w.input.action.jitMarket, permitDeadline } } })).state).not.toBe("ok");
  });
  it.each([false, true])("does not append a ninth permit without funding, existing=%s", async exists => {
    const w = permitWorld(); w.state.exists = exists;
    const permits = Array.from({ length: 8 }, () => ({ token: CA, value: "1", deadline: String(NOW + 600n), signature: "0x1234" }));
    const d = dataOf(await w.prepare({ ...w.input, action: { ...w.input.action, jitMarket: { ...w.input.action.jitMarket, permits } } }));
    expect(d.orderSignable).toBe(false);
    expect(d.jit.permitPreparation.status).toBe("unavailable");
    expect(d.jit.reprepareInput).toBeUndefined();
  });
  it("does not add token-domain reads to a permit-free non-minting maker", async () => {
    const w = permitWorld();
    const d = dataOf(await w.prepare({ ...w.input, action: { ...w.input.action, jitMarket: { ...w.input.action.jitMarket, enableJitMint: false } } }));
    expect(d.jit.permitPreparation).toBeUndefined();
    expect(w.calls.filter(c => c.functionName === "nonces" || c.functionName === "eip712Domain" || c.method === "getBlockNumber")).toEqual([]);
  });
});

describe("A2 reviewed permit boundaries", () => {
  it("R1 completes a cited RFQ permit roundtrip without mixing uncited quote fields", async () => {
    const w = permitWorld();
    const input = { ...w.input, action: { type: "answer-rfq", rfqId: "rfq_local", answerId: "answer_local", optionId: "opt_local", jitMarket: { recipe: w.input.action.jitMarket.recipe, enableJitMint: true } } };
    const first = dataOf(await w.prepare(input));
    const request = await signReprepare(first);
    const env = await w.prepare(request);
    expect(env.state, JSON.stringify(env.warnings)).toBe("ok");
    const final = dataOf(env);
    expect(final.jit.permitPreparation.status).toBe("verified");
    expect(final.answer.supersedes).toBe("answer_local");
    expect(final.answer.pool.poolId).toBe(first.answer.pool.poolId);
  });
  it("R2 preserves duplicate unpinned cST rows without adding permit state reads", async () => {
    const w = permitWorld();
    const permits = Array.from({ length: 2 }, () => ({ token: CST, value: String(WAD), deadline: String(NOW + 600n), signature: "0x1234" }));
    const env = await w.prepare({ ...w.input, action: { ...w.input.action, jitMarket: { ...w.input.action.jitMarket, permits } } });
    expect(env.state, JSON.stringify(env.warnings)).toBe("ok");
    expect(dataOf(env).jit.permitPreparation.status).toBe("supplied");
    expect(decodeJitExtension("nested", dataOf(env).extension, "bytes").permits).toEqual(permits.map(p => ({ ...p, value: BigInt(p.value), deadline: BigInt(p.deadline) })));
    expect(w.calls.filter(c => c.functionName === "nonces" || c.functionName === "eip712Domain" || c.method === "getBlockNumber")).toEqual([]);
  });
  it("R2 lets eight existing rows coexist with adequate cST allowance and preserves unbounded lifetime", async () => {
    const w = permitWorld(); w.state.exists = true; w.state.allowance = WAD;
    const permits = Array.from({ length: 8 }, () => ({ token: CA, value: "1", deadline: String(NOW + 600n), signature: "0x1234" }));
    const { expirySeconds: _expiry, ...action } = w.input.action;
    const env = await w.prepare({ ...w.input, action: { ...action, jitMarket: { ...action.jitMarket, permits } } });
    expect(env.state, JSON.stringify(env.warnings)).toBe("ok");
    const d = dataOf(env);
    expect(d.orderSignable).toBe(true);
    expect(d.jit.permitPreparation.status).toBe("satisfied");
    expect(decodeJitExtension("nested", d.extension, "bytes").permits).toHaveLength(8);
    expect(decodeMakerTraits(BigInt(d.typedData.message.makerTraits)).expiry).toBe(0n);
  });
  it.each(["phoenix/v0.5", "phoenix/v0.4-rc.1"] as const)("R3 preserves the canonical signature actually encoded on %s", async generation => {
    const w = permitWorld(runTool, generation);
    const first = dataOf(await w.prepare());
    const request = await signReprepare(first);
    const signature = request.action.jitMarket.permits![0]!.signature!;
    const env = await w.prepare(request);
    expect(env.state, JSON.stringify(env.warnings)).toBe("ok");
    const d = dataOf(env);
    expect(d.jit.permitPreparation.status).toBe("verified");
    expect(decodeJitExtension("nested", d.extension, generation === "phoenix/v0.5" ? "bytes" : "vrs").permits[0]!.signature).toBe(signature);
  });
  it.each([
    { generation: "phoenix/v0.5", parity: 0 }, { generation: "phoenix/v0.5", parity: 1 },
    { generation: "phoenix/v0.4-rc.1", parity: 0 }, { generation: "phoenix/v0.4-rc.1", parity: 1 },
  ] as const)("R3 refuses a correct EOA signature carrying parity $parity on $generation", async ({ generation, parity }) => {
    const w = permitWorld(runTool, generation); w.state.exists = true;
    const first = dataOf(await w.prepare()), td = first.jit.permitTypedData;
    // Select a deterministic digest whose canonical signature carries this recovery bit.
    // Signing candidates is local; the producer only reads the selected real fixture nonce.
    for (let nonce = 0n; nonce < 16n; nonce++) {
      const signature = await signer.signTypedData({ ...td, message: { ...td.message, nonce, value: BigInt(td.message.value), deadline: BigInt(td.message.deadline) } });
      if (Number.parseInt(signature.slice(-2), 16) - 27 !== parity) continue;
      w.state.nonce = nonce;
      const d = dataOf(await w.prepare()), request = structuredClone(d.jit.reprepareInput);
      const row = request.action.jitMarket.permits![0]!;
      if (generation === "phoenix/v0.4-rc.1") {
        delete row.signature;
        row.r = signature.slice(0, 66) as `0x${string}`;
        row.s = `0x${signature.slice(66, 130)}`;
        row.v = parity;
      } else row.signature = `${signature.slice(0, -2)}0${parity}` as `0x${string}`;
      expect((await w.prepare(request)).state).not.toBe("ok");
      return;
    }
    throw new Error("deterministic fixture did not yield the requested recovery bit");
  });
  it("R3 refuses the equivalent high-S EOA signature rejected by pinned OpenZeppelin ECDSA", async () => {
    const w = permitWorld(), request = await signReprepare(dataOf(await w.prepare()));
    const row = request.action.jitMarket.permits![0]!, signature = row.signature!;
    const highS = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n - BigInt(`0x${signature.slice(66, 130)}`);
    const v = Number.parseInt(signature.slice(130), 16) === 27 ? "1c" : "1b";
    row.signature = `${signature.slice(0, 66)}${highS.toString(16).padStart(64, "0")}${v}` as `0x${string}`;
    expect((await w.prepare(request)).state).not.toBe("ok");
  });
  it("R3 refuses a compact EOA signature that the token's bytes recovery does not accept", async () => {
    const w = permitWorld(), request = await signReprepare(dataOf(await w.prepare()));
    const row = request.action.jitMarket.permits![0]!, signature = row.signature!;
    const parity = BigInt(Number.parseInt(signature.slice(130), 16) - 27);
    const vs = BigInt(`0x${signature.slice(66, 130)}`) | (parity << 255n);
    row.signature = `${signature.slice(0, 66)}${vs.toString(16).padStart(64, "0")}` as `0x${string}`;
    expect((await w.prepare(request)).state).not.toBe("ok");
  });
  it("R5 refuses an already-signed helper pin after its deadline passes", async () => {
    const w = permitWorld(), request = await signReprepare(dataOf(await w.prepare()));
    w.ctx.nowSeconds = BigInt(request.action.jitMarket.permitDeadline!) + 1n;
    expect((await w.prepare(request)).state).not.toBe("ok");
  });
  it.each(["finite", "omitted"] as const)("R5 bounds a delayed final order with %s TTL to its signed permit deadline", async ttl => {
    const w = permitWorld();
    const { expirySeconds: _expiry, ...unbounded } = w.input.action;
    const first = dataOf(await w.prepare({ ...w.input, action: ttl === "finite" ? w.input.action : unbounded }));
    const deadline = BigInt(first.jit.permitTypedData.message.deadline), request = await signReprepare(first);
    w.ctx.nowSeconds = NOW + 120n;
    const env = await w.prepare(request);
    expect(env.state, JSON.stringify(env.warnings)).toBe("ok");
    const d = dataOf(env);
    expect(d.jit.permitPreparation.status).toBe("verified");
    expect(d.orderSignable).toBe(true);
    expect(decodeMakerTraits(BigInt(d.typedData.message.makerTraits)).expiry).toBe(deadline);
    expect(request.action.jitMarket.permitDeadline).toBe(String(deadline));
  });
  it.each(["uncited", "cited"] as const)("R5 keeps delayed %s RFQ freshness and expiry echoes equal to its actual bounded order", async citation => {
    const w = permitWorld();
    const quote = citation === "cited" ? { answerId: "answer_local", optionId: "opt_local" } : { premiumAnnualized: "0.04", expiryTimestamp: w.input.action.jitMarket.expiryTimestamp };
    const first = dataOf(await w.prepare({ ...w.input, action: { type: "answer-rfq", rfqId: "rfq_local", ...quote, jitMarket: { recipe: w.input.action.jitMarket.recipe, enableJitMint: true } } }));
    const deadline = BigInt(first.jit.permitTypedData.message.deadline), request = await signReprepare(first);
    w.ctx.nowSeconds = NOW + 120n;
    const env = await w.prepare(request);
    expect(env.state, JSON.stringify(env.warnings)).toBe("ok");
    const d = dataOf(env), expiry = decodeMakerTraits(BigInt(d.typedData.message.makerTraits)).expiry;
    expect(expiry).toBe(deadline);
    expect(d.answer.quotedOption.fresh_until).toBe(Number(expiry));
    expect(d.answer.expirySeconds).toBe(Number(expiry - w.ctx.nowSeconds));
  });
  it.each([false, true])("R6 completes delegated-EOA v/r/s preparation and verification, existing=%s", async exists => {
    const w = permitWorld(runTool, "phoenix/v0.4-rc.1"); w.state.exists = exists; w.state.ownerDelegated = true; w.state.contractSignatureValid = false;
    const firstEnv = await w.prepare(), first = dataOf(firstEnv);
    expect(first.jit.permitTypedData, JSON.stringify(firstEnv.warnings)).toBeDefined();
    const env = await w.prepare(await signReprepare(first));
    expect(env.state, JSON.stringify(env.warnings)).toBe("ok");
    expect(dataOf(env).jit.permitPreparation.status).toBe("verified");
    expect(dataOf(env).orderSignable).toBe(true);
  });
  it("R6 keeps bytes-wire delegated makers on pinned SignatureChecker ERC-1271 semantics", async () => {
    const w = permitWorld(); w.state.ownerDelegated = true; w.state.contractSignatureValid = false;
    const request = await signReprepare(dataOf(await w.prepare()));
    // Even a correct EOA key signature is insufficient for a code-bearing bytes-wire owner.
    expect((await w.prepare(request)).state).not.toBe("ok");
    w.state.contractSignatureValid = true;
    request.action.jitMarket.permits![0]!.signature = "0x1234";
    const env = await w.prepare(request);
    expect(env.state, JSON.stringify(env.warnings)).toBe("ok");
    expect(dataOf(env).jit.permitPreparation.status).toBe("verified");
  });
  it("R6 keeps ordinary non-designator contract newborn makers on the v/r/s pre-rest path", async () => {
    const w = permitWorld(runTool, "phoenix/v0.4-rc.1"); w.state.ownerContract = true;
    const env = await w.prepare();
    expect(dataOf(env).jit.permitTypedData).toBeUndefined();
    expect(env.warnings.some(w => w.code === "contract_maker_pre_rest")).toBe(true);
  });
});
