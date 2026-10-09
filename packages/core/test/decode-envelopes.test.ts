// Smart-account ENVELOPE unwrapping in cork_decode (2026-10-01): a contract wallet's
// transaction wraps the call it means — a Safe execTransaction, an
// ERC-4337 handleOps bundle, an ERC-7579 execute, a Rhinestone intent, a MultiSend batch, often
// nested — and before this the decoder called the whole thing an unknown target and read nothing.
//
// Real bytes throughout: every envelope is encoded with the contracts' own pinned ABIs, the inner
// legs are real Cork/ERC-20/ForSelf calls, and one case replays a live integrator fill captured
// from Base (`fixtures/zyfai-rhinestone-fill-base.json`) through both decode kinds.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeFunctionData, encodePacked, getAddress, parseAbi, toFunctionSelector, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { BUNDLED_DEFAULTS, corkActionCall, decodeSingleCall, encodeMulticall, generationsOf, primaryOf, runTool, type HandlerContext } from "@cork/core";
import {
  decodeErc7579Executions,
  erc7579ExecutorModuleAbi,
  decodeMultiSendTransactions,
  decodeRhinestoneOperation,
  ENVELOPE_SINGLETONS,
  entryPointAbi,
  erc7579Abi,
  isEnvelopeSelector,
  multiSendAbi,
  rhinestoneIntentExecutorAbi,
  safe4337ModuleAbi,
  safeAbi,
  unwrapEnvelope,
} from "../src/bundle/envelopes.ts";
import { forSelfAbi, forSelfSelectors } from "../src/forself.ts";
import { corkAdapterAbi } from "../src/bundle/corkAdapterAbi.ts";
import { bundlerLegAbi } from "../src/bundle/legs.ts";
import { marketCreatorAbi, marketCreatorNestedAbi, marketRegistryAbi, marketRegistryNestedAbi } from "../src/market-registry.ts";
import { lopCallName } from "../src/orders.ts";

const ctx: HandlerContext = { nowSeconds: 1n };
const MAINNET = primaryOf(generationsOf(BUNDLED_DEFAULTS, 1))!.phoenix!;
const ADAPTER_1 = getAddress(MAINNET.corkAdapter!);
const BUNDLER3_1 = getAddress(MAINNET.bundler3!);
const BASE = generationsOf(BUNDLED_DEFAULTS, 8453);
const BASE_PRIMARY_FORSELF = primaryOf(BASE)!.forSelf!.adapter as `0x${string}`;
// Base's previous set has no reference ForSelf adapter; Arbitrum's does (v0.1.3-rc.1).
const ARB_PREVIOUS_FORSELF = generationsOf(BUNDLED_DEFAULTS, 42161).find((g) => g.label === "phoenix/v0.3-rc.1")!.forSelf!.adapter as `0x${string}`;
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as const;
const SAFE = getAddress("0x00000000000000000000000000000000000005af"); // a wallet: not in any book
const POOL = `0x${"11".repeat(32)}` as const;
const USER = "0x00000000000000000000000000000000000000aa" as const;
const ENTRYPOINT_V06 = ENVELOPE_SINGLETONS.find((s) => s.label.includes("v0.6"))!.address;
const ENTRYPOINT_V07 = ENVELOPE_SINGLETONS.find((s) => s.label.includes("v0.7"))!.address;
const ENTRYPOINT_V08 = ENVELOPE_SINGLETONS.find((s) => s.label.includes("v0.8"))!.address;
const MULTISEND_141 = ENVELOPE_SINGLETONS.find((s) => s.label === "Safe MultiSend 1.4.1")!.address;
const INTENT_EXECUTOR = ENVELOPE_SINGLETONS.find((s) => s.scheme === "rhinestone-intent-executor")!.address;
// The public Anvil #0 key — a well-known test vector, never a secret.
const signer = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");

type Leg = { kind: string; to: string; verification: string; generation?: string; delegatecall?: true; skipRevert?: boolean; scheme?: string; version?: string; account?: string; legs?: Leg[]; action?: string; role?: string; note?: string };
const codes = (env: { warnings: Array<{ code: string }> }) => env.warnings.map((w) => w.code).sort();
const msg = (env: { warnings: Array<{ code: string; message: string }> }, code: string) => env.warnings.find((w) => w.code === code)?.message ?? "";

// ── inner legs: real Cork bytes ──────────────────────────────────────────────────────────────
const depositCall = corkActionCall(ADAPTER_1, "safeDeposit", { poolId: POOL, collateralAssetsIn: 1n, receiver: USER, minCptAndCstSharesOut: 1n, deadline: 2n });
const bundleData = encodeMulticall([depositCall]);
const approveData = encodeFunctionData({ abi: parseAbi(["function approve(address,uint256)"]), functionName: "approve", args: [ADAPTER_1, 1_000_000n] });
const exerciseForSelf = encodeFunctionData({ abi: forSelfAbi, functionName: "exerciseForSelf", args: [{ poolId: POOL, cstSharesIn: 1n, minCollateralAssetsOut: 1n, maxReferenceAssetsIn: 1n, deadline: 2n }] });

// ── envelope builders (the contracts' own ABIs) ──────────────────────────────────────────────
const safeExec = (to: `0x${string}`, data: Hex, operation: 0 | 1 = 0, value = 0n) =>
  encodeFunctionData({ abi: safeAbi, functionName: "execTransaction", args: [to, value, data, operation, 0n, 0n, 0n, "0x0000000000000000000000000000000000000000", "0x0000000000000000000000000000000000000000", "0x"] });
const safe4337 = (to: `0x${string}`, data: Hex, operation: 0 | 1 = 0) => encodeFunctionData({ abi: safe4337ModuleAbi, functionName: "executeUserOp", args: [to, 0n, data, operation] });
const multiSend = (txs: Array<{ op: 0 | 1; to: `0x${string}`; value?: bigint; data: Hex }>) =>
  encodeFunctionData({
    abi: multiSendAbi,
    functionName: "multiSend",
    args: [`0x${txs.map((t) => encodePacked(["uint8", "address", "uint256", "uint256", "bytes"], [t.op, t.to, t.value ?? 0n, BigInt((t.data.length - 2) / 2), t.data]).slice(2)).join("")}` as Hex],
  });
const mode = (callType: number, execType = 0) => `0x${callType.toString(16).padStart(2, "0")}${execType.toString(16).padStart(2, "0")}${"0".repeat(60)}` as Hex;
const erc7579Single = (to: `0x${string}`, data: Hex, execType = 0, fn: "execute" | "executeFromExecutor" = "execute") =>
  encodeFunctionData({ abi: erc7579Abi, functionName: fn, args: [mode(0x00, execType), encodePacked(["address", "uint256", "bytes"], [to, 0n, data])] });
const erc7579Batch = (calls: Array<{ to: `0x${string}`; data: Hex }>, execType = 0) =>
  encodeFunctionData({ abi: erc7579Abi, functionName: "execute", args: [mode(0x01, execType), encodeAbiParameters([{ type: "tuple[]", components: [{ name: "target", type: "address" }, { name: "value", type: "uint256" }, { name: "callData", type: "bytes" }] }], [calls.map((c) => ({ target: c.to, value: 0n, callData: c.data }))])] });
const erc7579Delegate = (to: `0x${string}`, data: Hex) => encodeFunctionData({ abi: erc7579Abi, functionName: "execute", args: [mode(0xff), encodePacked(["address", "bytes"], [to, data])] });
const userOpV06 = (sender: `0x${string}`, callData: Hex) => ({ sender, nonce: 1n, initCode: "0x" as Hex, callData, callGasLimit: 1n, verificationGasLimit: 1n, preVerificationGas: 1n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, paymasterAndData: "0x" as Hex, signature: "0x" as Hex });
const userOpV07 = (sender: `0x${string}`, callData: Hex, initCode: Hex = "0x") => ({ sender, nonce: 1n, initCode, callData, accountGasLimits: `0x${"0".repeat(64)}` as Hex, preVerificationGas: 1n, gasFees: `0x${"0".repeat(64)}` as Hex, paymasterAndData: "0x" as Hex, signature: "0x" as Hex });
const handleOpsV06 = (ops: ReturnType<typeof userOpV06>[]) => encodeFunctionData({ abi: entryPointAbi, functionName: "handleOps", args: [ops, USER] });
const handleOpsV07 = (ops: ReturnType<typeof userOpV07>[]) => encodeFunctionData({ abi: entryPointAbi, functionName: "handleOps", args: [ops, USER] });
const rhinestoneSingle = (account: `0x${string}`, calls: Array<{ to: `0x${string}`; data: Hex }>, type = 2) =>
  encodeFunctionData({
    abi: rhinestoneIntentExecutorAbi,
    functionName: "executeSinglechainOps",
    args: [{ account, nonce: 7n, ops: { data: `0x${type.toString(16).padStart(2, "0")}05${encodeAbiParameters([{ type: "tuple[]", components: [{ name: "target", type: "address" }, { name: "value", type: "uint256" }, { name: "callData", type: "bytes" }] }], [calls.map((c) => ({ target: c.to, value: 0n, callData: c.data }))]).slice(2)}` as Hex }, signature: "0x" }],
  });

describe("envelopes.ts — one layer at a time, from the contracts' own layouts", () => {
  it("envelope selectors are disjoint from every Cork, leg, ForSelf, market and LOP selector", () => {
    const own = new Set<string>();
    for (const abi of [corkAdapterAbi, bundlerLegAbi, forSelfAbi, marketRegistryAbi, marketCreatorAbi, marketRegistryNestedAbi, marketCreatorNestedAbi] as readonly (readonly unknown[])[]) {
      for (const f of abi) if ((f as { type?: string }).type === "function") own.add(toFunctionSelector(f as never).toLowerCase());
    }
    for (const s of Object.values(forSelfSelectors())) own.add(s.toLowerCase());
    for (const abi of [entryPointAbi, safe4337ModuleAbi, safeAbi, multiSendAbi, erc7579Abi, rhinestoneIntentExecutorAbi]) {
      for (const f of abi) {
        const sel = toFunctionSelector(f).toLowerCase();
        expect(isEnvelopeSelector(sel), `${f.name} ${sel}`).toBe(true);
        expect(own.has(sel), `${f.name} ${sel} collides with a Cork-side selector`).toBe(false);
        expect(lopCallName(sel), `${f.name} ${sel} collides with a 1inch LOP selector`).toBeUndefined();
      }
    }
    expect(isEnvelopeSelector("0x374f435d")).toBe(false); // Bundler3.multicall is a bundle, not an envelope
  });

  it("Safe execTransaction: the account is the call's own target; operation 1 is a delegatecall", () => {
    const hop = unwrapEnvelope(SAFE, safeExec(ADAPTER_1, approveData, 0, 5n))!;
    expect(hop).toMatchObject({ scheme: "safe-exec-transaction", account: SAFE, calls: [{ to: ADAPTER_1, value: 5n, data: approveData, delegatecall: false, skipRevert: false }] });
    expect(unwrapEnvelope(SAFE, safeExec(MULTISEND_141, "0x", 1))!.calls[0]!.delegatecall).toBe(true);
    expect(() => unwrapEnvelope(SAFE, safeExec(ADAPTER_1, "0x", 2 as 0))).toThrow(/operation 2/u);
  });

  it("MultiSend packed transactions: op ‖ to ‖ value ‖ len ‖ data, per call; a short trailer is a decode failure, never a silent truncation", () => {
    const packed = multiSend([{ op: 0, to: USDC, data: approveData, value: 3n }, { op: 1, to: ADAPTER_1, data: "0x1234" }]);
    const hop = unwrapEnvelope(MULTISEND_141, packed)!;
    expect(hop.scheme).toBe("safe-multisend");
    expect(hop.calls).toEqual([
      { to: USDC, value: 3n, data: approveData, delegatecall: false, skipRevert: false },
      { to: ADAPTER_1, value: 0n, data: "0x1234", delegatecall: true, skipRevert: false },
    ]);
    // Truncate the last call's data by one byte: the length word still claims the full size.
    const bytes = `0x${packed.slice(2)}` as Hex;
    const args = encodeFunctionData({ abi: multiSendAbi, functionName: "multiSend", args: [`0x${"01".padEnd(2, "0")}${ADAPTER_1.slice(2)}${"0".repeat(64)}${(4).toString(16).padStart(64, "0")}1234` as Hex] });
    expect(() => unwrapEnvelope(MULTISEND_141, args)).toThrow(/runs past the end/u);
    expect(() => decodeMultiSendTransactions("0x00")).toThrow(/truncated/u);
    // An operation byte that is neither CALL nor DELEGATECALL is not a Safe transaction.
    expect(() => decodeMultiSendTransactions(`0x02${ADAPTER_1.slice(2)}${"0".repeat(64)}${(2).toString(16).padStart(64, "0")}1234` as Hex)).toThrow(/operation 2/u);
    void bytes;
  });

  it("ERC-7579: single (packed target‖value‖data), batch (abi.encode(Execution[])), delegatecall (0xff); try exec type marks skipRevert", () => {
    const single = unwrapEnvelope(SAFE, erc7579Single(ADAPTER_1, approveData))!;
    expect(single).toMatchObject({ scheme: "erc7579-execute", version: "execute:single", account: SAFE, calls: [{ to: ADAPTER_1, value: 0n, data: approveData, delegatecall: false, skipRevert: false }] });
    const batch = unwrapEnvelope(SAFE, erc7579Batch([{ to: USDC, data: approveData }, { to: BUNDLER3_1, data: bundleData }], 1))!;
    expect(batch.version).toBe("execute:batch:try");
    expect(batch.calls.map((c) => [c.to, c.skipRevert])).toEqual([[USDC, true], [BUNDLER3_1, true]]);
    const dc = unwrapEnvelope(SAFE, erc7579Delegate(MULTISEND_141, "0xabcd"))!;
    expect(dc.calls).toEqual([{ to: MULTISEND_141, value: 0n, data: "0xabcd", delegatecall: true, skipRevert: false }]);
    expect(unwrapEnvelope(SAFE, erc7579Single(ADAPTER_1, approveData, 0, "executeFromExecutor"))!.note).toMatch(/EXECUTOR module/u);
    expect(() => decodeErc7579Executions(0x02, "0x", false)).toThrow(/callType 0x02/u);
    expect(() => unwrapEnvelope(SAFE, encodeFunctionData({ abi: erc7579Abi, functionName: "execute", args: [mode(0x00, 0x07), "0x"] }))).toThrow(/execType 0x07/u);
  });

  it("ERC-4337 handleOps: v0.6 and v0.7+ are different tuples under different selectors; each op's callData is a call ON its sender", () => {
    const v06 = unwrapEnvelope(ENTRYPOINT_V06, handleOpsV06([userOpV06(SAFE, safe4337(ADAPTER_1, approveData))]))!;
    expect(v06).toMatchObject({ scheme: "erc4337-entrypoint", version: "v0.6", account: SAFE });
    expect(v06.calls[0]).toMatchObject({ to: SAFE, value: 0n, delegatecall: false });
    const other = getAddress("0x00000000000000000000000000000000000005b0");
    const v07 = unwrapEnvelope(ENTRYPOINT_V07, handleOpsV07([userOpV07(SAFE, "0x", "0xdeadbeef"), userOpV07(other, "0x")]))!;
    expect(v07.version).toBe("v0.7+");
    expect(v07.account).toBeUndefined(); // two senders: the account rides per call
    expect(v07.calls.map((c) => c.to)).toEqual([SAFE, other]);
    expect(v07.note).toMatch(/2 user operations.*initCode/u);
  });

  it("Rhinestone IntentExecutor: Operation.data = [Type][SigMode][payload]; Type 2/3 = Execution[], Type 1 = target‖data, Type 0 = nothing executes", () => {
    const hop = unwrapEnvelope(INTENT_EXECUTOR, rhinestoneSingle(SAFE, [{ to: USDC, data: approveData }, { to: BASE_PRIMARY_FORSELF, data: exerciseForSelf }]))!;
    expect(hop).toMatchObject({ scheme: "rhinestone-intent-executor", version: "executeSinglechainOps:erc7579", account: SAFE });
    expect(hop.calls.map((c) => c.to)).toEqual([USDC, BASE_PRIMARY_FORSELF]);
    expect(hop.note).toMatch(/nonce 0x7\b/u);
    expect(decodeRhinestoneOperation(`0x0105${USDC.slice(2)}${approveData.slice(2)}` as Hex)).toEqual({ version: "calldata", calls: [{ to: USDC, value: 0n, data: approveData, delegatecall: false, skipRevert: false }] });
    expect(decodeRhinestoneOperation("0x0000")).toEqual({ version: "eip712-hash", calls: [] });
    expect(decodeRhinestoneOperation("0x")).toEqual({ version: "empty", calls: [] });
    expect(() => decodeRhinestoneOperation("0x0905")).toThrow(/type 9/u);
    expect(unwrapEnvelope(INTENT_EXECUTOR, rhinestoneSingle(SAFE, [{ to: USDC, data: approveData }], 3))!.version).toBe("executeSinglechainOps:multicall");
  });
});

describe("cork_decode through envelopes — the inner Cork legs are verified like a bare transaction's", () => {
  it("a Safe execTransaction around a Bundler3 deposit bundle: the Cork leg is trusted, the envelope is the wallet, the result is OK with one envelope disclosure", async () => {
    const env = await runTool("cork_decode", { kind: "calldata", chainId: 1, data: safeExec(BUNDLER3_1, bundleData), to: SAFE }, ctx);
    expect(env.state).toBe("ok");
    const d = env.data as { legs: Leg[]; summary: string[] };
    expect(d.legs).toHaveLength(1);
    expect(d.legs[0]).toMatchObject({ kind: "envelope", scheme: "safe-exec-transaction", account: SAFE, verification: "unverified" });
    expect(d.legs[0]!.legs![0]).toMatchObject({ kind: "bundle", to: BUNDLER3_1, verification: "trusted" });
    expect(d.legs[0]!.legs![0]!.legs![0]).toMatchObject({ kind: "cork", action: "safeDeposit", verification: "trusted" });
    // The wallet's own contract is never a `target_unverified` finding; the bundle inside is clean.
    expect(codes(env)).toEqual(["envelope_unwrapped"]);
    expect(msg(env, "envelope_unwrapped")).toContain(`safe-exec-transaction [execTransaction] at ${SAFE} (the account's own contract), account ${SAFE}`);
    expect(d.summary[0]).toMatch(/^1\. UNVERIFIED target: Safe transaction \(execTransaction\) on 0x0000…05AF from account 0x0000…05AF: 1 call:$/iu);
    expect(d.summary[1]).toMatch(/^   1\. a nested bundle on/u);
    expect(d.summary[2]).toMatch(/^      1\. run Cork 'safeDeposit'/u);
  });

  it("a look-alike adapter three wallets deep is still a conflict: EntryPoint v0.7 → Safe4337Module → MultiSend → Cork leg at a fake adapter", async () => {
    const FAKE = getAddress("0x00000000000000000000000000000000000000ee");
    const fakeBundle = encodeMulticall([corkActionCall(FAKE, "safeDeposit", { poolId: POOL, collateralAssetsIn: 1n, receiver: USER, minCptAndCstSharesOut: 1n, deadline: 2n })]);
    const inner = multiSend([{ op: 0, to: USDC, data: approveData }, { op: 0, to: BUNDLER3_1, data: fakeBundle }]);
    const data = handleOpsV07([userOpV07(SAFE, safe4337(MULTISEND_141, inner, 1))]);
    const env = await runTool("cork_decode", { kind: "calldata", chainId: 1, data, to: ENTRYPOINT_V07 }, ctx);
    expect(env.state).toBe("conflict");
    expect(codes(env)).toEqual(["delegatecall_in_envelope", "envelope_unwrapped", "target_mismatch", "target_unverified"]);
    const d = env.data as { legs: Leg[] };
    const entry = d.legs[0]!;
    expect(entry).toMatchObject({ kind: "envelope", scheme: "erc4337-entrypoint", version: "v0.7+", to: ENTRYPOINT_V07, verification: "trusted", account: SAFE });
    const module = entry.legs![0]!;
    expect(module).toMatchObject({ kind: "envelope", scheme: "safe-4337-module", to: SAFE, verification: "unverified" });
    const ms = module.legs![0]!;
    // The MultiSend is DELEGATECALLED from the Safe (operation 1) — flagged on that leg and said once.
    expect(ms).toMatchObject({ kind: "envelope", scheme: "safe-multisend", to: MULTISEND_141, verification: "trusted", delegatecall: true });
    expect(msg(env, "delegatecall_in_envelope")).toMatch(/1 inner leg\(s\) run as a DELEGATECALL.*safe-multisend envelope at 0x38869bf6/iu);
    expect(ms.legs![1]!.legs![0]).toMatchObject({ kind: "cork", to: FAKE, verification: "mismatch" });
    expect(msg(env, "target_mismatch")).toMatch(/Cork 'safeDeposit' calldata targets 0x00000000000000000000000000000000000000ee/iu);
    expect(msg(env, "envelope_unwrapped")).toMatch(/3 smart-account envelope layer\(s\).*erc4337-entrypoint \[v0\.7\+\] at ERC-4337 EntryPoint v0\.7, account 0x[0-9a-fA-F]+ → safe-4337-module \[executeUserOp\] at 0x[0-9a-fA-F]+ \(the account's own contract\).*→ safe-multisend \[multiSend\] at Safe MultiSend 1\.4\.1/iu);
  });

  it("EntryPoint v0.8 is recognized by shape but its target stays unverified (its code differs per chain)", async () => {
    const env = await runTool("cork_decode", { kind: "calldata", chainId: 1, data: handleOpsV07([userOpV07(SAFE, erc7579Single(BUNDLER3_1, bundleData))]), to: ENTRYPOINT_V08 }, ctx);
    expect(env.state).toBe("ok");
    expect((env.data as { legs: Leg[] }).legs[0]).toMatchObject({ kind: "envelope", to: ENTRYPOINT_V08, verification: "unverified" });
    expect(msg(env, "envelope_unwrapped")).toMatch(/ERC-4337 EntryPoint v0\.8 \(address recognized, code NOT byte-verified across chains\)/u);
    expect(codes(env)).toEqual(["envelope_unwrapped"]);
  });

  it("a malformed envelope body degrades to an UNREADABLE leg naming the envelope function, never a throw", async () => {
    const truncated = safeExec(ADAPTER_1, approveData).slice(0, 200) as Hex;
    const leg = decodeSingleCall({ to: SAFE, data: truncated, value: 0n, skipRevert: false, callbackHash: `0x${"0".repeat(64)}` });
    expect(leg).toMatchObject({ kind: "unknown", verification: "unverified" });
    expect((leg as { note?: string }).note).toMatch(/selector matches Safe\.execTransaction but the body failed to decode/u);
  });

  it("the depth cap holds through envelopes: 17 nested Safe layers end in a raw leg, never a stack overflow", () => {
    let data: Hex = approveData;
    for (let i = 0; i < 17; i++) data = safeExec(SAFE, data);
    let leg = decodeSingleCall({ to: SAFE, data, value: 0n, skipRevert: false, callbackHash: `0x${"0".repeat(64)}` }) as Leg;
    let depth = 0;
    while (leg.kind === "envelope") { leg = leg.legs![0]!; depth++; }
    expect(depth).toBe(16);
    expect(leg.kind).toBe("unknown");
    expect(leg.note).toMatch(/nested envelope exceeds the 16-level decode depth cap/u);
  });
});

describe("the reference ForSelf adapter of a generation is Cork's own deployment", () => {
  it("a ForSelf call at a generation's reference adapter is trusted and labeled with the generation; an integrator's adapter stays unverified", async () => {
    const ref = await runTool("cork_decode", { kind: "calldata", chainId: 8453, data: exerciseForSelf, to: BASE_PRIMARY_FORSELF }, ctx);
    expect(ref.state).toBe("ok");
    expect((ref.data as { legs: Leg[] }).legs[0]).toMatchObject({ kind: "forself", verification: "trusted", generation: "phoenix/v0.5" });
    expect(codes(ref)).toEqual([]);
    const prev = await runTool("cork_decode", { kind: "calldata", chainId: 42161, data: exerciseForSelf, to: ARB_PREVIOUS_FORSELF }, ctx);
    expect((prev.data as { legs: Leg[] }).legs[0]).toMatchObject({ kind: "forself", verification: "trusted", generation: "phoenix/v0.3-rc.1" });
    const own = await runTool("cork_decode", { kind: "calldata", chainId: 8453, data: exerciseForSelf, to: "0x8f125a5f397a68566e38bfae0f37fcec57d91966" }, ctx);
    expect(own.state).toBe("ok");
    expect((own.data as { legs: Leg[] }).legs[0]).toMatchObject({ kind: "forself", verification: "unverified" });
    expect(codes(own)).toEqual(["target_unverified"]);
  });

  it("an SDK caller that vouched for ONE adapter gets a mismatch naming it when the call targets another unlisted adapter", () => {
    const vouched = getAddress("0x00000000000000000000000000000000000000f5");
    const other = getAddress("0x00000000000000000000000000000000000000f6");
    const call = (to: `0x${string}`) => ({ to, value: 0n, data: exerciseForSelf, skipRevert: false, callbackHash: `0x${"0".repeat(64)}` as Hex });
    const leg = decodeSingleCall(call(other), { forSelf: vouched }) as Leg & { expectedTarget?: string };
    expect(leg).toMatchObject({ kind: "forself", verification: "mismatch", expectedTarget: vouched });
    expect(decodeSingleCall(call(vouched), { forSelf: vouched })).toMatchObject({ kind: "forself", verification: "trusted" });
    // The reference list still wins over the vouched one: a generation's own adapter is trusted and labeled.
    expect(decodeSingleCall(call(BASE_PRIMARY_FORSELF), { forSelf: vouched, forSelfAdapters: [{ address: BASE_PRIMARY_FORSELF, label: "phoenix/v0.5" }] })).toMatchObject({ verification: "trusted", generation: "phoenix/v0.5" });
  });

  it("kind:tx — a signed tx TO the reference adapter names it in toLabel with its generation", async () => {
    const raw = await signer.signTransaction({ type: "eip1559", chainId: 8453, nonce: 0, to: BASE_PRIMARY_FORSELF, data: exerciseForSelf, gas: 300_000n, maxFeePerGas: 1_000_000n, maxPriorityFeePerGas: 1_000n });
    const env = await runTool("cork_decode", { kind: "tx", data: raw }, ctx);
    expect(env.state).toBe("ok");
    expect((env.data as { toLabel: string }).toLabel).toBe("forSelfAdapter (reference, phoenix/v0.5 generation)");
    expect(codes(env)).toEqual([]);
  });
});

describe("a live integrator fill (Base, 2026-09-30) — Rhinestone intent around approve + fillOrderForSelf", () => {
  const raw = JSON.parse(readFileSync(new URL("./fixtures/zyfai-rhinestone-fill-base.json", import.meta.url), "utf8")) as { chainId: number; to: `0x${string}`; input: Hex; account: `0x${string}`; forSelfAdapter: `0x${string}` };
  const fx = { ...raw, to: getAddress(raw.to), account: getAddress(raw.account), forSelfAdapter: getAddress(raw.forSelfAdapter) };

  it("kind:calldata with the IntentExecutor as `to`: the envelope is the trusted singleton, the account is the integrator's Safe, the inner legs are the approve and the ForSelf fill", async () => {
    const env = await runTool("cork_decode", { kind: "calldata", chainId: fx.chainId, data: fx.input, to: fx.to }, ctx);
    expect(env.state).toBe("ok");
    const d = env.data as { legs: Leg[]; summary: string[] };
    const outer = d.legs[0]!;
    expect(outer).toMatchObject({ kind: "envelope", scheme: "rhinestone-intent-executor", version: "executeSinglechainOps:erc7579", to: fx.to, verification: "trusted", account: fx.account });
    // Inside the intent: ONE execution, to the integrator's own ERC-7579 executor module (GuardedExecModuleUpgradeable
    // 2.2.0, integrator-deployed → unverified), whose batch is the approve and the ForSelf fill.
    expect(outer.legs).toHaveLength(1);
    const module = outer.legs![0]!;
    expect(module).toMatchObject({ kind: "envelope", scheme: "erc7579-executor-module", version: "executeGuardedBatch", to: getAddress("0xce1f0a650f9ee8a5b670403364e53765207d8c67"), verification: "unverified" });
    expect(module.legs!.map((l) => [l.kind, l.to, l.verification])).toEqual([
      ["leg", getAddress("0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"), "unverified"],
      ["forself", fx.forSelfAdapter, "unverified"],
    ]);
    expect(module.legs![0]).toMatchObject({ role: "erc20", fn: "approve" });
    expect(module.legs![1]).toMatchObject({ action: "fillOrderForSelf" });
    expect(codes(env)).toEqual(["envelope_unwrapped", "target_unverified"]);
    expect(msg(env, "envelope_unwrapped")).toMatch(/2 smart-account envelope layer\(s\).*rhinestone-intent-executor \[executeSinglechainOps:erc7579\] at Rhinestone IntentExecutor, account 0xB97a071B669ce909169012f55b83A7e12044a539 → erc7579-executor-module \[executeGuardedBatch\] at 0xcE1F0A650f9eE8a5B670403364E53765207D8c67 \(the account's own contract\)/u);
    expect(msg(env, "target_unverified")).toMatch(/ERC-20 'approve'.*ForSelf 'fillOrderForSelf' at 0x8f125a5f/iu);
    expect(d.summary[0]).toMatch(/^1\. Rhinestone intent \(executeSinglechainOps:erc7579\) on 0x0000…daaf from account 0xB97a…a539 — account-signed intent \(nonce 0x/iu);
    expect(d.summary[1]).toMatch(/^   1\. UNVERIFIED target: ERC-7579 executor-module batch \(executeGuardedBatch\) on 0xcE1F…8c67 — an ERC-7579 executor module.*: 2 calls:$/iu);
    expect(d.summary[3]).toMatch(/^      2\. UNVERIFIED target: run 'fillOrderForSelf' on the ForSelf adapter 0x8f12…1966/iu);
  });

  it("kind:tx — the same bytes re-signed to the IntentExecutor: toLabel names the singleton, no unknown_target", async () => {
    const raw = await signer.signTransaction({ type: "eip1559", chainId: 8453, nonce: 1, to: fx.to, data: fx.input, gas: 1_500_000n, maxFeePerGas: 1_000_000n, maxPriorityFeePerGas: 1_000n });
    const env = await runTool("cork_decode", { kind: "tx", data: raw }, ctx);
    expect(env.state).toBe("ok");
    expect((env.data as { toLabel: string }).toLabel).toBe("Rhinestone IntentExecutor");
    expect(codes(env)).toEqual(["envelope_unwrapped", "target_unverified"]);
  });

  it("kind:tx — a tx whose `to` is an integrator's EXECUTOR MODULE is wallet infrastructure, never described as the signer's own account", async () => {
    const executorModule = getAddress("0xce1f0a65d3cf0c5cb0b7a1b4e23a7e7d1a2f9cc1");
    const data = encodeFunctionData({ abi: erc7579ExecutorModuleAbi, functionName: "executeGuardedBatch", args: [[{ target: fx.forSelfAdapter, value: 0n, callData: exerciseForSelf }]] });
    const raw = await signer.signTransaction({ type: "eip1559", chainId: 8453, nonce: 3, to: executorModule, data, gas: 500_000n, maxFeePerGas: 1_000_000n, maxPriorityFeePerGas: 1_000n });
    const env = await runTool("cork_decode", { kind: "tx", data: raw }, ctx);
    expect(env.state).toBe("ok");
    expect(codes(env)).toEqual(["envelope_unwrapped", "target_unverified", "unknown_target"]);
    expect(msg(env, "unknown_target")).toMatch(/NOT the signer's account: it is wallet infrastructure \(a erc7579-executor-module envelope/u);
    expect(msg(env, "unknown_target")).not.toMatch(/YOUR wallet/u);
    // A MultiSend at an address outside the byte-verified singletons: the same honesty.
    const foreignMultiSend = getAddress("0x00000000000000000000000000000000000000d5");
    const raw2 = await signer.signTransaction({ type: "eip1559", chainId: 8453, nonce: 4, to: foreignMultiSend, data: multiSend([{ op: 0, to: fx.forSelfAdapter, data: exerciseForSelf }]), gas: 500_000n, maxFeePerGas: 1_000_000n, maxPriorityFeePerGas: 1_000n });
    const env2 = await runTool("cork_decode", { kind: "tx", data: raw2 }, ctx);
    expect(msg(env2, "unknown_target")).toMatch(/wallet infrastructure \(a safe-multisend envelope/u);
  });

  it("kind:tx — a tx whose `to` is the wallet itself (Safe execTransaction) is told so, not accused", async () => {
    const raw = await signer.signTransaction({ type: "eip1559", chainId: 8453, nonce: 2, to: fx.account, data: safeExec(fx.forSelfAdapter, exerciseForSelf), gas: 500_000n, maxFeePerGas: 1_000_000n, maxPriorityFeePerGas: 1_000n });
    const env = await runTool("cork_decode", { kind: "tx", data: raw }, ctx);
    expect(env.state).toBe("ok");
    expect((env.data as { toLabel: string | null }).toLabel).toBeNull();
    expect(codes(env)).toEqual(["envelope_unwrapped", "target_unverified", "unknown_target"]);
    expect(msg(env, "unknown_target")).toMatch(/it is the smart account itself \(a safe-exec-transaction envelope, execTransaction\).*confirm it is YOUR wallet/u);
  });
});
