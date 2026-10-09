// Deployment set phoenix/v0.5 (Distribution phoenix/v0.5-rc.1, market-registry 0.6.0): the same
// contracts as phoenix/v0.4-rc.1 except the JIT adapter — CorkLimitOrderAdapter 0.5.0 at
// 0x960C…0616, whose permit row is (token, value, deadline, bytes signature), so a contract
// wallet's ERC-1271 signature can authorize the JIT permit. The set declares that row as
// `marketRegistry.jitPermitWire: "bytes"`; phoenix/v0.4-rc.1 keeps 0.4.0's v/r/s row ("vrs").
//
// The pinning test below exists because the 0.5.0 adapter was once written into the
// phoenix/v0.4-rc.1 block (commit 1573f600, reverted): each set names its OWN Distribution's
// adapter, and the two sets differ ONLY there.
import { describe, expect, it } from "vitest";
import { keccak256 } from "viem";
import { DEMO_ACCOUNT } from "@cork/schemas";
import {
  BUNDLED_DEFAULTS,
  buildJitExtension,
  classifyAddress,
  decodeJitExtensionFor,
  decodeJitExtraData,
  encodeJitExtraData,
  type FlatPermitRow,
  generationsOf,
  type HandlerContext,
  type JITMarketParams,
  type PermitParams,
  permitOfFlatRow,
  permitSignatureOfVrs,
  primaryOf,
  runTool,
  splitPermitSignature,
  ToolInputError,
  WIRES,
} from "@cork/core";
import { CST, JIT_TASK_PAIR, LIQUIDITY_RECIPE, stubContext } from "../../../evals/stub.ts";
import { parsePermitWires } from "../src/handlers/jit.ts";

const WAD = 10n ** 18n;
const NOW = 1_790_000_000n; // the eval stub's clock
const EXPIRY = (NOW + 20n * 86_400n).toString();
const V05 = "phoenix/v0.5";
const V04 = "phoenix/v0.4-rc.1";
const ADAPTER_050 = "0x960Cd94B31121806b1b0Ff02230D189Ad0310616";
const ADAPTER_040 = "0x3E01C558fc0854e92e6ef2a84c19D6Bf9D82B104";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
const SAMPLE: JITMarketParams = {
  collateralAsset: USDC,
  referenceAsset: "0x9c6864105AEC23388C89600046213a44C384c831",
  expiryTimestamp: 1_800_000_000n,
  recipe: "0xd5e8F76AafA20aA9A8983A35B71Ad3A793070Ed9",
  rateOverride: 0n,
  constraint: { rateMin: WAD, rateMax: 2n * WAD, rateChangePerDayMax: 10n ** 16n, rateChangeCapacityMax: 5n * 10n ** 16n },
  extraData: "0xaabbcc",
  oracleSalt: `0x${"11".repeat(32)}`,
  swapFeePercentage: WAD,
  unwindSwapFeePercentage: 2n * WAD,
  enableJitMint: true,
};
const SIG65 = `0x${"22".repeat(32)}${"33".repeat(32)}1b` as const;
const SIG1271 = `0x${"ab".repeat(85)}` as const; // a Safe7579-style validator ++ signature
const ROWS = [
  { token: USDC, value: "123", deadline: "1800000000", signature: SIG65 },
  { token: USDC, value: "7", deadline: "1800000000", signature: SIG1271 },
];
/** keccak256 of the DEPLOYED 0.5.0 adapter's own encodeExtraData({ SAMPLE }, ROWS) — read on
 *  42161 and 8453 on 2026-10-09 (identical on both; 1216 bytes). */
const LIVE_050_KECCAK = "0x951cb951c117f3840fbf39995bcf5cbe9e119bfc48da11caeaff1e83bbb811b0";

const setOf = (chainId: number, label: string) => generationsOf(BUNDLED_DEFAULTS, chainId).find((g) => g.label === label)!;
const lc = (a: unknown) => String(a).toLowerCase();

describe("each deployment set names its own Distribution's JIT adapter (the 1573f600 mistake, pinned)", () => {
  for (const chainId of [42161, 8453]) {
    it(`${chainId}: phoenix/v0.5 → 0x960C…0616 (0.5.0, bytes); phoenix/v0.4-rc.1 → 0x3E01…B104 (0.4.0, vrs); primary = phoenix/v0.5`, () => {
      const v05 = setOf(chainId, V05);
      const v04 = setOf(chainId, V04);
      expect(primaryOf(generationsOf(BUNDLED_DEFAULTS, chainId))!.label).toBe(V05);
      expect(v05.distribution).toBe("phoenix/v0.5-rc.1");
      expect(v04.distribution).toBe("phoenix/v0.4-rc.1");
      expect(lc(v05.marketRegistry!.adapter)).toBe(lc(ADAPTER_050));
      expect(lc(v04.marketRegistry!.adapter)).toBe(lc(ADAPTER_040));
      expect(v05.marketRegistry!.jitPermitWire).toBe("bytes");
      expect(v04.marketRegistry!.jitPermitWire).toBe("vrs");
      expect(v05.marketRegistry!.contractsVersion).toBe("0.6.0");
      // Everything else is the same contract set: only the adapter (and its labels) moved.
      const strip = (g: typeof v05) => ({ ...g, label: undefined, primary: undefined, distribution: undefined, marketRegistry: { ...g.marketRegistry!, adapter: undefined, jitPermitWire: undefined, contractsVersion: undefined } });
      expect(JSON.parse(JSON.stringify(strip(v05)))).toEqual(JSON.parse(JSON.stringify(strip(v04))));
    });
  }
  it("both adapters' code hashes are approved (each set's own code), on both chains", () => {
    const list = (BUNDLED_DEFAULTS as unknown as { approvedImplementations: Record<string, Record<string, { approved: string[] }>> }).approvedImplementations;
    for (const chainId of ["42161", "8453"]) {
      const jit = list[chainId]!.jitAdapter!.approved.map(lc);
      expect(jit).toContain("0x24a11fba142a4b681a3bfbadf0ed74566fdf6281102137794d35c217f004225d"); // 0.5.0
      expect(jit.some((h) => h.startsWith("0x2fe70bac"))).toBe(true); // 0.4.0
    }
  });
});

describe("the bytes permit row (CorkLimitOrderAdapter 0.5.0)", () => {
  it("encodes the deployed adapter's own bytes for a 65-byte and an 85-byte (ERC-1271) permit, and reads them back", () => {
    const permits = parsePermitWires(ROWS, "bytes");
    const bytes = encodeJitExtraData("nested", SAMPLE, permits, "bytes");
    expect(keccak256(bytes)).toBe(LIVE_050_KECCAK);
    expect((bytes.length - 2) / 2).toBe(1216);
    const back = decodeJitExtraData("nested", bytes, "bytes");
    expect(back.params).toEqual(SAMPLE);
    // The one signature field round-trips verbatim, ECDSA and ERC-1271 alike.
    expect(back.permits).toEqual(permits);
    // The nested default IS the bytes row (the v0.7.0 behaviour SDK callers rely on), on every entry point.
    expect(encodeJitExtraData("nested", SAMPLE, permits)).toBe(bytes);
    expect(WIRES.nested.encodeExtraData(SAMPLE, permits)).toBe(bytes);
    expect(decodeJitExtraData("nested", bytes)).toEqual(back);
    expect(WIRES.nested.decodeExtraData(bytes)).toEqual(back);
  });
  it("the v0.7.0 permit SDK surface: one `signature` field; the four helpers convert v/r/s both ways", () => {
    const vrs = splitPermitSignature(SIG65)!;
    expect(vrs).toEqual({ v: 27, r: `0x${"22".repeat(32)}`, s: `0x${"33".repeat(32)}` });
    expect(permitSignatureOfVrs(vrs.v, vrs.r, vrs.s)).toBe(SIG65);
    expect(splitPermitSignature(SIG1271)).toBeNull(); // ERC-1271 bytes have no v/r/s form
    const row: FlatPermitRow = { token: USDC, value: 7n, deadline: 9n, ...vrs };
    expect(permitOfFlatRow(row)).toEqual({ token: USDC, value: 7n, deadline: 9n, signature: SIG65 } satisfies PermitParams);
    // v/r/s input and the same signature as bytes are ONE permit, on both rows.
    const asVrs = { token: USDC, value: "7", deadline: "9", ...vrs };
    const asSig = { token: USDC, value: "7", deadline: "9", signature: SIG65 };
    for (const wire of ["bytes", "vrs"] as const) expect(parsePermitWires([asVrs], wire)).toEqual(parsePermitWires([asSig], wire));
  });
  it("the v/r/s row refuses a permit it cannot carry, and bytes on the flat wire refuse", () => {
    const permits = parsePermitWires(ROWS, "bytes");
    expect(() => encodeJitExtraData("nested", SAMPLE, permits, "vrs")).toThrow(/permits\[1\] carries a 85-byte signature[\s\S]*CorkLimitOrderAdapter 0\.4\.0[\s\S]*phoenix\/v0\.5/);
    expect(() => encodeJitExtraData("flat", SAMPLE, [], "bytes")).toThrow(/nested wire/);
    // Same 65-byte permit, two rows, two different encodings: the row is load-bearing.
    const only65 = parsePermitWires([ROWS[0]!], "bytes");
    expect(encodeJitExtraData("nested", SAMPLE, only65, "bytes")).not.toBe(encodeJitExtraData("nested", SAMPLE, only65, "vrs"));
  });
  it("parse: bytes takes an 85-byte signature verbatim and still refuses both forms; vrs refuses the 85 bytes", () => {
    expect(parsePermitWires([ROWS[1]!], "bytes")[0]!.signature).toBe(SIG1271);
    expect(() => parsePermitWires([{ ...ROWS[1]!, v: 27 }], "bytes")).toThrow(ToolInputError);
    // Neither form, or a partial v/r/s triple, refuses on BOTH rows.
    const bare = { token: USDC, value: "7", deadline: "9" };
    for (const w of ["bytes", "vrs"] as const) {
      for (const row of [bare, { ...bare, v: 27, r: `0x${"22".repeat(32)}` as const }]) {
        const e = (() => { try { parsePermitWires([row], w); } catch (x) { return x; } })();
        expect(e, w).toBeInstanceOf(ToolInputError);
        expect(JSON.stringify((e as ToolInputError).issues)).toMatch(/needs its signature/);
      }
    }
    const err = (() => { try { parsePermitWires([ROWS[1]!], "vrs"); } catch (e) { return e; } })();
    expect(err).toBeInstanceOf(ToolInputError);
    expect(JSON.stringify((err as ToolInputError).issues)).toMatch(/85 bytes[\s\S]*phoenix\/v0\.5/);
  });
});

describe("classification: the adapter pinpoints the set; shared contracts report both labels", () => {
  const gens = generationsOf(BUNDLED_DEFAULTS, 8453);
  it("each adapter belongs to ONE set; the shared registry, creator and pool manager belong to both", () => {
    expect(classifyAddress(gens, ADAPTER_050)).toEqual([expect.objectContaining({ label: V05, role: "jitAdapter", primary: true })]);
    expect(classifyAddress(gens, ADAPTER_040)).toEqual([expect.objectContaining({ label: V04, role: "jitAdapter", primary: false })]);
    for (const shared of [setOf(8453, V05).marketRegistry!.registry, setOf(8453, V05).marketRegistry!.marketCreator!, setOf(8453, V05).phoenix!.poolManager]) {
      expect(classifyAddress(gens, shared).map((c) => c.label).sort()).toEqual([V04, V05].sort());
    }
  });
  it("decode reads JIT bytes with the row of the set its adapter belongs to", () => {
    const bytes050 = encodeJitExtraData("nested", SAMPLE, parsePermitWires(ROWS, "bytes"), "bytes");
    const dec = decodeJitExtensionFor(gens, buildJitExtension(ADAPTER_050, bytes050));
    expect(dec).toMatchObject({ generation: V05, wire: "nested", permitWire: "bytes" });
    const bytes040 = encodeJitExtraData("nested", SAMPLE, parsePermitWires([ROWS[0]!], "vrs"), "vrs");
    expect(decodeJitExtensionFor(gens, buildJitExtension(ADAPTER_040, bytes040))).toMatchObject({ generation: V04, permitWire: "vrs" });
  });
});

describe("the JIT maker path on phoenix/v0.5 (the primary) and on phoenix/v0.4-rc.1 by name", () => {
  const makerJit = (ctx: HandlerContext, id: string, permits: unknown[], input: Record<string, unknown> = {}) =>
    runTool("cork_prepare_orders", { chainId: 42161, account: DEMO_ACCOUNT, clientRequestId: id, ...input, action: { type: "maker-order", poolId: `0x${"ce".repeat(32)}`, side: "SELL", makerAsset: CST, takerAsset: JIT_TASK_PAIR.collateralAsset, makingAmount: "1000000000000000000", takingAmount: "50000000000000000", jitMarket: { ...JIT_TASK_PAIR, expiryTimestamp: EXPIRY, recipe: LIQUIDITY_RECIPE, permits } } }, ctx);
  const permit = (signature: string) => ({ token: CST, value: "1000000000000000000", deadline: EXPIRY, signature });

  it("default (the primary): the 0.5.0 adapter, an ERC-1271 permit accepted, verified round-trip, contract-capable approval", async () => {
    const env = await makerJit(stubContext(), "v05-maker-0001", [permit(SIG1271)]);
    expect(env.state, JSON.stringify(env.warnings)).toBe("ok");
    const d = env.data as { extension: `0x${string}`; jit: { adapter: string; generation: string; permitWire: string; extraDataLayout: string }; approvals: Array<{ mechanism: string; wallets: string }>; typedData: { message: Record<string, unknown> } };
    expect(lc(d.jit.adapter)).toBe(lc(ADAPTER_050));
    expect(d.jit).toMatchObject({ generation: V05, permitWire: "bytes" });
    expect(d.jit.extraDataLayout).toMatch(/^verified-on-chain/);
    // The JIT permit entry: a contract wallet can sign it on this set (0.4.0 says eoa-only).
    const jitPermit = d.approvals.filter((a) => a.mechanism === "erc2612-permit");
    expect(jitPermit.length).toBe(1);
    expect(jitPermit[0]!.wallets).toBe("eoa+contract");
    const dec = await runTool("cork_decode", { kind: "order", chainId: 42161, data: { ...d.typedData.message, extension: d.extension } }, { nowSeconds: NOW });
    expect((dec.data as { jit: Record<string, unknown> }).jit).toMatchObject({ generation: V05, wire: "nested" });
  });

  it("phoenix/v0.4-rc.1 by name: the 0.4.0 adapter, the same ERC-1271 permit refused with teaching that names phoenix/v0.5", async () => {
    const ok = await makerJit(stubContext(), "v05-maker-0002", [permit(SIG65)], { generation: V04 });
    expect(ok.state, JSON.stringify(ok.warnings)).toBe("ok");
    expect(lc((ok.data as { jit: { adapter: string } }).jit.adapter)).toBe(lc(ADAPTER_040));
    expect((ok.data as { jit: { permitWire: string } }).jit.permitWire).toBe("vrs");
    expect((ok.data as { approvals: Array<{ mechanism: string; wallets: string }> }).approvals.filter((a) => a.mechanism === "erc2612-permit").map((a) => a.wallets)).toEqual(["eoa-only"]);
    const err = await makerJit(stubContext(), "v05-maker-0003", [permit(SIG1271)], { generation: V04 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ToolInputError);
    expect(JSON.stringify((err as ToolInputError).issues)).toMatch(/CorkLimitOrderAdapter 0\.4\.0[\s\S]*phoenix\/v0\.5/);
  });
});

describe("a CONTRACT maker (a Safe) with a JIT order whose pool does not exist yet", () => {
  /** The stub with the maker account given code — a smart account. */
  const contractMaker = (): HandlerContext => {
    const base = stubContext();
    return {
      ...base,
      resolveRpc: async (chainId, url) => {
        const r = await base.resolveRpc!(chainId, url);
        if (!r) return r;
        const client = r.client as unknown as Record<string, unknown>;
        const getCode = async (a: { address?: string } | undefined) =>
          String(a?.address ?? "").toLowerCase() === DEMO_ACCOUNT.toLowerCase() ? "0x6080604052" : (client["getCode"] as (x: unknown) => Promise<unknown>)(a);
        return { ...r, client: { ...client, getCode } as never };
      },
    };
  };
  const makerJit = (ctx: HandlerContext, id: string, permits: unknown[], input: Record<string, unknown> = {}) =>
    runTool("cork_prepare_orders", { chainId: 42161, account: DEMO_ACCOUNT, clientRequestId: id, ...input, action: { type: "maker-order", poolId: `0x${"ce".repeat(32)}`, side: "SELL", makerAsset: CST, takerAsset: JIT_TASK_PAIR.collateralAsset, makingAmount: "1000000000000000000", takingAmount: "50000000000000000", jitMarket: { ...JIT_TASK_PAIR, expiryTimestamp: EXPIRY, recipe: LIQUIDITY_RECIPE, permits } } }, ctx);
  type Data = { extension: `0x${string}`; execution: unknown; approvals: Array<{ mechanism: string; wallets: string }> };

  it("phoenix/v0.5, no permit yet: contract_maker_pre_rest names BOTH paths (ERC-1271 permit, or create-pool first)", async () => {
    const env = await makerJit(contractMaker(), "v05-contract-maker-0001", []);
    expect(env.state, JSON.stringify(env.warnings)).toBe("ok");
    const pre = env.warnings.find((w) => w.code === "contract_maker_pre_rest");
    expect(pre?.message).toContain("ERC-1271");
    expect(pre?.message).toContain("create-pool");
    expect(JSON.stringify((env.data as Data).execution)).toContain("create-pool");
    expect((env.data as Data).approvals.find((a) => a.mechanism === "erc2612-permit")?.wallets).toBe("eoa+contract");
  });

  it("phoenix/v0.5, with an ERC-1271 permit over the predicted cST: no create-pool-first push; the bytes carry the signature verbatim", async () => {
    const env = await makerJit(contractMaker(), "v05-contract-maker-0002", [{ token: CST, value: "1000000000000000000", deadline: EXPIRY, signature: SIG1271 }]);
    expect(env.state, JSON.stringify(env.warnings)).toBe("ok");
    expect(env.warnings.map((w) => w.code)).not.toContain("contract_maker_pre_rest");
    expect(JSON.stringify((env.data as Data).execution)).not.toContain("create-pool");
    const back = decodeJitExtensionFor(generationsOf(BUNDLED_DEFAULTS, 42161), (env.data as Data).extension);
    expect(back?.wire).toBe("nested");
    expect((back as { permits: PermitParams[] }).permits[0]!.signature).toBe(SIG1271);
  });

  it("phoenix/v0.4-rc.1: the permit is ECDSA-only, so create-pool first is THE path, even with an ECDSA permit attached", async () => {
    const env = await makerJit(contractMaker(), "v05-contract-maker-0003", [{ token: CST, value: "1000000000000000000", deadline: EXPIRY, signature: SIG65 }], { generation: V04 });
    expect(env.state, JSON.stringify(env.warnings)).toBe("ok");
    const pre = env.warnings.find((w) => w.code === "contract_maker_pre_rest");
    expect(pre?.message).toMatch(/only an ECDSA permit[\s\S]*create-pool/);
    expect(pre?.message).not.toContain("ERC-1271");
    expect(JSON.stringify((env.data as Data).execution)).toContain("create-pool");
  });
});

describe("the agent note stays where agents read it", () => {
  // Removing the rule from AGENTS.md / CLAUDE.md removes the guard against the 1573f600 mistake.
  it("AGENTS.md (and CLAUDE.md, where the tree has it) opens with the new-deployment-set rule, naming this test", async () => {
    const { existsSync, readFileSync } = await import("node:fs");
    // AGENTS.md ships in every tree; CLAUDE.md is private (the public port excludes it).
    const files = ["AGENTS.md", "CLAUDE.md"].filter((f) => f === "AGENTS.md" || existsSync(new URL(`../../../${f}`, import.meta.url)));
    expect(files[0]).toBe("AGENTS.md");
    for (const file of files) {
      const text = readFileSync(new URL(`../../../${file}`, import.meta.url), "utf8");
      const head = text.slice(0, 2500);
      expect(head, file).toContain("a new contract deployment is a NEW deployment set, never an edit of an existing one");
      expect(head, file).toContain("market-registry-v05.test.ts");
    }
  });
});
