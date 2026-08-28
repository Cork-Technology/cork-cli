// CorkMarketCreator (cork-periphery 0.1.0): the direct pool-creation path — the same pool a JIT
// fill derives, creatable AHEAD of the fill by a smart-account maker that cannot sign the
// EOA-only ERC-2612 cST permit. Calldata is pinned against an independently-generated golden
// vector (cast, and a live Base eth_call 2026-08-28 that returned the tool's exact predicted
// (poolId, cst, cpt) triple); handler paths run offline via injected RPC stubs. Live parity
// runs env-gated in rpc-live.test.ts.
import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeFunctionData, keccak256, toFunctionSelector } from "viem";
import {
  buildCreatorCreatePoolCall,
  buildDeployFixedRateOracleCall,
  buildDeployOracleCall,
  decodeSingleCall,
  deriveJitMarket,
  marketCreatorAbi,
  rateOverrideCoherence,
  runTool,
  summarizeBundle,
  type HandlerContext,
  type ResolvedConstraint,
} from "@cork/core";
import { stubRpc, type StubCall } from "./helpers.ts";
import { farFutureExpiryWarning, maxExpiryBoundWarning } from "../src/handlers/jit.ts";

const WAD = 10n ** 18n;
// The live parity fixture (Base, 2026-08-28): eth_call against the DEPLOYED creator returned
// exactly the (poolId, cst, cpt) this tool predicted for these params.
const CA = "0x211Cc4DD073734dA055fbF44a2b4667d5E5fE5d2";
const REF = "0xdDb46999F8891663a8F2828d25298f70416d7610";
const LIQ = "0xb881DB48ad6DA84a8F0D1cE4150Caf7Ae016Dc55";
// The 2.1.0 deployment set (cork-defaults.json; creator verified on-chain 2026-08-28).
const CREATOR = "0x0aCccE0ef90da8b8d95DBFeE2ADaaED9b566586C";
const REG = "0xa78d8137B01058dD23e545b6557209eBBc9611F1";
const CONTROLLER = "0x6b65D663e0B445BAf1870D5af806d57Ebb2C82A1";
const PM = "0x02803Bb52D2184f906F45B50C66AA969C2E37263";
const ORACLE = "0x00000000000000000000000000000000000000fe";
const FM_ROLE = "0x6c0757dc3e6b28b2580c03fd9e96c274acf4f99d91fbec9b418fa1d70604ff1c";

const CONSTRAINT: ResolvedConstraint = { rateMin: 900000000000000000n, rateMax: 1100000000000000000n, rateChangePerDayMax: 10000000000000000n, rateChangeCapacityMax: 100000000000000000n };
const CONSTRAINT_WIRE = { rateMin: "900000000000000000", rateMax: "1100000000000000000", rateChangePerDayMax: "10000000000000000", rateChangeCapacityMax: "100000000000000000" };
const PARAMS = { collateralAsset: CA, referenceAsset: REF, expiryTimestamp: 1790000000n, recipe: LIQ, rateOverride: 0n, constraint: CONSTRAINT, additionalData: "0x", swapFeePercentage: 0n, unwindSwapFeePercentage: 0n } as const;

// Golden vector, generated with `cast calldata "createNewPool((address,address,uint256,address,
// uint256,(uint256,uint256,uint256,uint256),bytes,uint256,uint256))" …` — an independent
// encoder, so a struct-order or type drift in marketCreatorAbi fails against bytes this repo
// did not produce.
const GOLDEN =
  "0xb67470770000000000000000000000000000000000000000000000000000000000000020000000000000000000000000211cc4dd073734da055fbf44a2b4667d5e5fe5d2000000000000000000000000ddb46999f8891663a8f2828d25298f70416d7610000000000000000000000000000000000000000000000000000000006ab13b80000000000000000000000000b881db48ad6da84a8f0d1ce4150caf7ae016dc5500000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000c7d713b49da00000000000000000000000000000000000000000000000000000f43fc2c04ee0000000000000000000000000000000000000000000000000000002386f26fc10000000000000000000000000000000000000000000000000000016345785d8a00000000000000000000000000000000000000000000000000000000000000000180000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000";

describe("buildCreatorCreatePoolCall (MarketParams wire format)", () => {
  it("matches the cast-generated golden vector byte for byte", () => {
    expect(buildCreatorCreatePoolCall(PARAMS)).toBe(GOLDEN);
  });

  it("encodes the nine fields in the contract's declared ORDER (independently-authored components)", () => {
    // JITMarketParams minus enableJitMint: collateralAsset, referenceAsset, expiryTimestamp,
    // recipe, rateOverride, constraint(4×uint256), additionalData, swapFee, unwindFee —
    // authored here from ICorkMarketCreator.sol, not from marketCreatorAbi.
    const selector = GOLDEN.slice(0, 10);
    const body = encodeAbiParameters(
      [
        {
          type: "tuple",
          components: [
            { name: "collateralAsset", type: "address" },
            { name: "referenceAsset", type: "address" },
            { name: "expiryTimestamp", type: "uint256" },
            { name: "recipe", type: "address" },
            { name: "rateOverride", type: "uint256" },
            { name: "constraint", type: "tuple", components: [{ name: "rateMin", type: "uint256" }, { name: "rateMax", type: "uint256" }, { name: "rateChangePerDayMax", type: "uint256" }, { name: "rateChangeCapacityMax", type: "uint256" }] },
            { name: "additionalData", type: "bytes" },
            { name: "swapFeePercentage", type: "uint256" },
            { name: "unwindSwapFeePercentage", type: "uint256" },
          ],
        },
      ],
      [{ ...PARAMS, constraint: { ...CONSTRAINT } }],
    );
    expect(buildCreatorCreatePoolCall(PARAMS)).toBe(`${selector}${body.slice(2)}`);
  });

  it("keeps swapFee BEFORE unwindFee with DISTINCT values (the golden's 0/0 fees cannot see a swap)", () => {
    const withFees = buildCreatorCreatePoolCall({ ...PARAMS, swapFeePercentage: 1n, unwindSwapFeePercentage: 2n });
    // The last two static words of the head are the two fees, in declaration order.
    // Word layout after the selector: [0] outer tuple offset, [1..5] ca/ref/expiry/recipe/
    // rateOverride, [6..9] constraint, [10] additionalData offset, [11] swapFee, [12] unwindFee.
    const words = withFees.slice(10).match(/.{64}/g)!;
    expect(BigInt(`0x${words[11]}`)).toBe(1n); // swapFeePercentage
    expect(BigInt(`0x${words[12]}`)).toBe(2n); // unwindSwapFeePercentage
  });

  it("the selector comes from the creator's own signature (a struct drift changes it)", () => {
    const fn = marketCreatorAbi.find((f) => f.type === "function" && f.name === "createNewPool");
    expect(toFunctionSelector(fn as never)).toBe(GOLDEN.slice(0, 10));
  });
});

describe("rateOverrideCoherence (ONE comparator behind the ladder's and the creator's gates)", () => {
  it("fixed + zero → needs-rate; fixed + rate → ok", () => {
    expect(rateOverrideCoherence("fixed", 0n)).toBe("needs-rate");
    expect(rateOverrideCoherence("fixed", WAD)).toBe("ok");
  });
  it("price/nav + non-zero → must-be-zero; zero → ok", () => {
    expect(rateOverrideCoherence("price", 1n)).toBe("must-be-zero");
    expect(rateOverrideCoherence("nav", 1n)).toBe("must-be-zero");
    expect(rateOverrideCoherence("price", 0n)).toBe("ok");
    expect(rateOverrideCoherence("nav", 0n)).toBe("ok");
  });
});

describe("expiry-bound helpers (the registry's maxExpiryDuration is REAL — 30 days at last read)", () => {
  it("farFutureExpiryWarning no longer claims the chain enforces no upper bound", () => {
    const w = farFutureExpiryWarning(1_790_000_000n + 6n * 31_557_600n, 1_790_000_000n);
    expect(w?.code).toBe("expiry_far_future");
    expect(w!.message).not.toContain("NO upper bound");
    expect(w!.message).toContain("maxExpiryDuration");
    expect(farFutureExpiryWarning(1_790_000_000n + 31_557_600n, 1_790_000_000n)).toBeUndefined();
  });

  it("maxExpiryBoundWarning: outside the INCLUSIVE bound warns with the creatable-from date; at the bound stays silent; a failed read degrades to silence", async () => {
    const client = (dur: bigint | Error) => ({ readContract: async () => { if (dur instanceof Error) throw dur; return dur; } }) as never;
    const over = await maxExpiryBoundWarning(client(2_592_000n), REG, 1_790_000_000n + 2_592_001n, 1_790_000_000n);
    expect(over?.code).toBe("would_revert");
    expect(over!.message).toContain("ExpiryOutOfRange");
    expect(over!.message).toContain(`${1_790_000_000n + 2_592_001n - 2_592_000n}`);
    expect(await maxExpiryBoundWarning(client(2_592_000n), REG, 1_790_000_000n + 2_592_000n, 1_790_000_000n)).toBeUndefined();
    expect(await maxExpiryBoundWarning(client(new Error("boom")), REG, 9_999_999_999n, 1n)).toBeUndefined();
  });
});

// ── handler paths (offline; injected RPC stub answering creator + registry views) ───────────
const ACTION = { type: "create-pool", collateralAsset: CA, referenceAsset: REF, expiryTimestamp: "1790000000", recipe: LIQ } as const;
const base = { chainId: 42161 as const, clientRequestId: "creator-0001" };
const NOW = 1_789_900_000n; // inside the 30-day window of expiry 1_790_000_000

/** The full creator-side stub: bindings, roles, recipe resolution, oracle, verify, bound. */
const creatorStub = (over: Partial<Record<string, unknown>> = {}) => (c: StubCall): unknown => {
  if (c.functionName in over) return over[c.functionName];
  switch (c.functionName) {
    case "POOL_MANAGER": return PM;
    case "CONTROLLER": return CONTROLLER;
    case "MARKET_REGISTRY": return REG;
    case "FEE_MANAGER_ROLE": return FM_ROLE;
    case "hasRole": return true;
    case "isRecipe": return true;
    case "source": return 1; // RecipeSource.PRICE
    case "lookupWrapper": return ORACLE;
    case "rate": return WAD;
    case "resolve": return { ...CONSTRAINT };
    case "verify": return true;
    case "maxExpiryDuration": return 2_592_000n;
    case "CORK_POOL_MANAGER": return PM;
    case "shares": return ["0x0000000000000000000000000000000000000000", "0x0000000000000000000000000000000000000000"];
    default: throw new Error(`unexpected ${c.functionName}`);
  }
};
const ctx = (handler: (c: StubCall) => unknown, opts?: Parameters<typeof stubRpc>[1]): HandlerContext => ({ nowSeconds: NOW, resolveRpc: stubRpc(handler, { code: { [ORACLE.toLowerCase()]: "0x6001" }, ...opts }) });

describe("cork_prepare_market create-pool (unsigned CorkMarketCreator.createNewPool tx)", () => {
  it("offline WITH an explicit constraint: exact calldata to the configured creator; skipped pre-flights disclosed", async () => {
    const env = await runTool("cork_prepare_market", { ...base, action: { ...ACTION, constraint: CONSTRAINT_WIRE } }, { nowSeconds: NOW, resolveRpc: async () => null });
    expect(env.state).toBe("ok");
    const d = env.data as { kind: string; to: string; calldata: string; note: string; scales: Record<string, string>; execution: { kind: string } };
    expect(d.kind).toBe("create-pool");
    expect(d.to).toBe(CREATOR);
    expect(d.calldata).toBe(GOLDEN);
    expect(d.note).toContain("cst.approve");
    expect(d.scales.unitsTopic).toContain("units");
    expect(d.execution.kind).toBe("eth-transaction");
    expect(env.warnings.some((w) => w.code === "funding_needs_rpc" && w.message.includes("SKIPPED"))).toBe(true);
  });

  it("offline WITHOUT a constraint → requires_rpc (the constraint is part of the calldata)", async () => {
    const env = await runTool("cork_prepare_market", { ...base, action: ACTION }, { nowSeconds: NOW, resolveRpc: async () => null });
    expect(env.state).toBe("unavailable");
    expect(env.warnings[0]?.code).toBe("requires_rpc");
    expect(env.warnings[0]?.message).toContain("recipe-rate-constraint");
  });

  it("value gates are the SHARED jitValueGate, creator-worded: past expiry names `expiryTimestamp` (not jitMarket) and 'sending this tx'", async () => {
    const env = await runTool("cork_prepare_market", { ...base, action: { ...ACTION, expiryTimestamp: "1", constraint: CONSTRAINT_WIRE } }, { nowSeconds: NOW, resolveRpc: async () => null });
    expect(env.state).toBe("unavailable");
    expect(env.warnings[0]?.code).toBe("invalid_order_terms");
    expect(env.warnings[0]?.message).toContain("expiryTimestamp 1 is not in the future");
    expect(env.warnings[0]?.message).not.toContain("jitMarket");
    expect(env.warnings[0]?.message).toContain("sending this tx");
  });

  it("fee above the 5e18 cap → invalid_order_terms (the creator restates the adapter's bound)", async () => {
    const env = await runTool("cork_prepare_market", { ...base, action: { ...ACTION, swapFeePercentage: (6n * WAD).toString(), constraint: CONSTRAINT_WIRE } }, { nowSeconds: NOW, resolveRpc: async () => null });
    expect(env.state).toBe("unavailable");
    expect(env.warnings[0]?.code).toBe("invalid_order_terms");
    expect(env.warnings[0]?.message).toContain("capped at 5e18");
  });

  it("equal pair → invalid_pair (domain rule, exit-3 envelope, never a throw)", async () => {
    const env = await runTool("cork_prepare_market", { ...base, action: { ...ACTION, referenceAsset: CA, constraint: CONSTRAINT_WIRE } }, { nowSeconds: NOW, resolveRpc: async () => null });
    expect(env.state).toBe("unavailable");
    expect(env.warnings[0]?.code).toBe("invalid_pair");
  });

  it("no recipe and no mode → teaching input error", async () => {
    await expect(runTool("cork_prepare_market", { ...base, action: { ...ACTION, recipe: undefined, constraint: CONSTRAINT_WIRE } }, { nowSeconds: NOW, resolveRpc: async () => null })).rejects.toThrow(/invalid input/);
  });

  it("online happy path: bindings verified, roles read, constraint AUTO-RESOLVED via recipe.resolve, pool id derived, teaching notices attached", async () => {
    const env = await runTool("cork_prepare_market", { ...base, action: ACTION }, ctx(creatorStub()));
    expect(env.state).toBe("ok");
    const d = env.data as { calldata: string; constraint: { rateMax: string }; pool: { poolId: string; exists: boolean }; oracle: { address: string; deployed: boolean }; source: string };
    expect(d.calldata).toBe(GOLDEN); // the auto-resolved constraint equals the golden fixture's
    expect(BigInt(d.constraint.rateMax)).toBe(CONSTRAINT.rateMax);
    expect(d.source).toBe("price");
    expect(d.oracle).toEqual(expect.objectContaining({ address: ORACLE, deployed: true }));
    const expected = deriveJitMarket({ collateralAsset: CA, referenceAsset: REF, expiryTimestamp: 1790000000n, constraint: CONSTRAINT, oracle: ORACLE });
    expect(d.pool.poolId).toBe(expected.poolId);
    expect(d.pool.exists).toBe(false);
    expect(env.warnings.some((w) => w.code === "constraint_window_notice")).toBe(true);
    expect(env.warnings.some((w) => w.code === "share_prediction_unavailable")).toBe(true);
  });

  it("an existing pool → pool_already_exists (idempotent no-op) with the PINNED share addresses; creation-only checks skipped", async () => {
    const CST = "0x0000000000000000000000000000000000000c57";
    const CPT = "0x0000000000000000000000000000000000000c97";
    const env = await runTool("cork_prepare_market", { ...base, action: ACTION }, ctx(creatorStub({ shares: [CPT, CST], maxExpiryDuration: 1n })));
    expect(env.state).toBe("ok");
    const d = env.data as { pool: { exists: boolean }; shares: { corkSwapToken: string; corkPrincipalToken: string; source: string } };
    expect(d.pool.exists).toBe(true);
    expect(d.shares).toEqual({ corkSwapToken: CST, corkPrincipalToken: CPT, source: "read" });
    expect(env.warnings.some((w) => w.code === "pool_already_exists")).toBe(true);
    // maxExpiryDuration answered 1s — but the bound applies only at CREATION, so no would_revert.
    expect(env.warnings.some((w) => w.code === "would_revert")).toBe(false);
  });

  it("expiry beyond the registry's maxExpiryDuration → would_revert naming ExpiryOutOfRange (creation bound)", async () => {
    const env = await runTool("cork_prepare_market", { ...base, action: ACTION }, ctx(creatorStub({ maxExpiryDuration: 3600n })));
    expect(env.state).toBe("ok");
    const w = env.warnings.find((x) => x.code === "would_revert");
    expect(w?.message).toContain("ExpiryOutOfRange");
  });

  it("a live oracle reporting ZERO rate → would_revert naming RateUnavailable (creation-only rule)", async () => {
    const env = await runTool("cork_prepare_market", { ...base, action: ACTION }, ctx(creatorStub({ rate: 0n, resolve: { ...CONSTRAINT } })));
    expect(env.state).toBe("ok");
    expect(env.warnings.some((w) => w.code === "would_revert" && w.message.includes("RateUnavailable"))).toBe(true);
  });

  it("recipe.verify rejecting → would_revert naming RecipeRejectedConstraint", async () => {
    const env = await runTool("cork_prepare_market", { ...base, action: { ...ACTION, constraint: CONSTRAINT_WIRE } }, ctx(creatorStub({ verify: false })));
    expect(env.state).toBe("ok");
    expect(env.warnings.some((w) => w.code === "would_revert" && w.message.includes("RecipeRejectedConstraint"))).toBe(true);
  });

  it("creator bindings contradicting config → conflict (adapter_binding_mismatch), nothing built", async () => {
    const env = await runTool("cork_prepare_market", { ...base, action: { ...ACTION, constraint: CONSTRAINT_WIRE } }, ctx(creatorStub({ MARKET_REGISTRY: CONTROLLER })));
    expect(env.state).toBe("conflict");
    expect(env.warnings[0]?.code).toBe("adapter_binding_mismatch");
    expect(env.warnings[0]?.message).toContain("CorkMarketCreator");
    expect((env.data as { calldata?: string }).calldata).toBeUndefined();
  });

  it("missing controller roles → roles_not_granted naming the per-role truth", async () => {
    const env = await runTool("cork_prepare_market", { ...base, action: ACTION }, ctx(creatorStub({ hasRole: false })));
    expect(env.state).toBe("ok");
    const w = env.warnings.find((x) => x.code === "roles_not_granted");
    expect(w?.message).toContain("POOL_CREATOR: false");
  });

  it("recipe not approved → recipe_not_found gate", async () => {
    const env = await runTool("cork_prepare_market", { ...base, action: { ...ACTION, constraint: CONSTRAINT_WIRE } }, ctx(creatorStub({ isRecipe: false })));
    expect(env.state).toBe("unavailable");
    expect(env.warnings[0]?.code).toBe("recipe_not_found");
  });

  it("a FIXED recipe without rateOverride → invalid_order_terms (needs-rate); a price recipe WITH one → invalid_order_terms (must-be-zero)", async () => {
    const fixed = await runTool("cork_prepare_market", { ...base, action: { ...ACTION, constraint: CONSTRAINT_WIRE } }, ctx(creatorStub({ source: 2 })));
    expect(fixed.state).toBe("unavailable");
    expect(fixed.warnings[0]?.message).toContain("FIXED-rate recipe");
    const nonzero = await runTool("cork_prepare_market", { ...base, action: { ...ACTION, rateOverride: WAD.toString(), constraint: CONSTRAINT_WIRE } }, ctx(creatorStub()));
    expect(nonzero.state).toBe("unavailable");
    expect(nonzero.warnings[0]?.message).toContain("REJECTED by the creator");
  });

  it("chain reads failing WITH an explicit constraint → build-and-warn (chain_read_failed), calldata exact", async () => {
    const env = await runTool("cork_prepare_market", { ...base, action: { ...ACTION, constraint: CONSTRAINT_WIRE } }, ctx(() => { throw new Error("rpc down"); }));
    expect(env.state).toBe("ok");
    expect((env.data as { calldata: string }).calldata).toBe(GOLDEN);
    expect(env.warnings.some((w) => w.code === "chain_read_failed" && w.message.includes("unverified"))).toBe(true);
  });

  it("the implementation guard is SCOPED to marketCreator + marketRegistry and resolves the creator's address from config", async () => {
    // Real code at the configured creator address that hashes OFF the bundled allowlist: the
    // guard must name the marketCreator role at its config-resolved address — the wiring killer
    // for implementationRoleAddress("marketCreator").
    const env = await runTool("cork_prepare_market", { ...base, action: { ...ACTION, constraint: CONSTRAINT_WIRE } }, ctx(creatorStub(), { code: { [CREATOR.toLowerCase()]: "0x6002", [ORACLE.toLowerCase()]: "0x6001" } }));
    expect(env.state).toBe("ok");
    const impl = env.warnings.filter((w) => w.code === "implementation_not_approved");
    expect(impl.some((w) => w.message.includes("marketCreator") && w.message.includes(CREATOR))).toBe(true);
    expect(impl.some((w) => w.message.includes("corkAdapter"))).toBe(false); // scope holds
  });

  it("no CorkMarketCreator configured for the chain → unknown_deployment (mainnet has the registry stack absent anyway; probe via a chain with mr but no creator is config-shaped, so assert the mainnet gate)", async () => {
    const env = await runTool("cork_prepare_market", { chainId: 1, clientRequestId: "creator-0002", action: { ...ACTION, constraint: CONSTRAINT_WIRE } }, { nowSeconds: NOW, resolveRpc: async () => null });
    expect(env.state).toBe("unavailable");
    expect(env.warnings[0]?.code).toBe("unknown_deployment");
  });
});

describe("cork_decode recognizes market-infrastructure calls (validate-before-broadcast parity)", () => {
  const leg = (to: `0x${string}`, data: `0x${string}`, trust = {}) => decodeSingleCall({ to, data, value: 0n, skipRevert: false, callbackHash: `0x${"00".repeat(32)}` }, trust);

  it("createNewPool labels kind 'market' role 'marketCreator', trusted at the configured creator and MISMATCH elsewhere", () => {
    const trusted = leg(CREATOR, GOLDEN, { marketCreator: CREATOR });
    expect(trusted.kind).toBe("market");
    expect(trusted).toEqual(expect.objectContaining({ role: "marketCreator", action: "createNewPool", verification: "trusted" }));
    const swapped = leg(CONTROLLER, GOLDEN, { marketCreator: CREATOR });
    expect(swapped.verification).toBe("mismatch");
    expect((swapped as { expectedTarget?: string }).expectedTarget).toBe(CREATOR);
    expect(leg(CREATOR, GOLDEN).verification).toBe("unverified");
  });

  it("registry oracle deploys label role 'marketRegistry' — this tool's own deploy-oracle bytes are no longer UNREADABLE", () => {
    const data = encodeFunctionData({ abi: marketCreatorAbi, functionName: "createNewPool", args: [{ collateralAsset: CA, referenceAsset: REF, expiryTimestamp: 1n, recipe: LIQ, rateOverride: 0n, constraint: { rateMin: 1n, rateMax: 2n, rateChangePerDayMax: 3n, rateChangeCapacityMax: 4n }, additionalData: "0x", swapFeePercentage: 0n, unwindSwapFeePercentage: 0n }] });
    expect(leg(CREATOR, data, { marketCreator: CREATOR }).kind).toBe("market");
    const dep = leg(REG, buildDeployOracleCall(CA, REF, "nav"), { marketRegistry: REG });
    expect(dep).toEqual(expect.objectContaining({ kind: "market", role: "marketRegistry", action: "deploy", verification: "trusted" }));
    const fix = leg(REG, buildDeployFixedRateOracleCall(WAD), { marketRegistry: REG });
    expect(fix).toEqual(expect.objectContaining({ kind: "market", action: "deployFixedRateOracle", verification: "trusted" }));
  });

  it("the summary names the pair, expiry, recipe, and idempotence for a reader", () => {
    const lines = summarizeBundle([leg(CREATOR, GOLDEN, { marketCreator: CREATOR })]);
    expect(lines[0]).toContain("create the Cork pool");
    expect(lines[0]).toContain("1790000000");
    expect(lines[0]).toContain("idempotent");
    expect(lines[0]).not.toContain("UNREADABLE");
    const navLine = summarizeBundle([leg(REG, buildDeployOracleCall(CA, REF, "nav"), { marketRegistry: REG })]);
    expect(navLine[0]).toContain("nav rate oracle");
  });
});

// poolId sanity: the derivation feeding create-pool is the verified computeMarketId — pin one
// value so the fixture above cannot drift silently from the market-registry suite's.
it("derive parity: the happy-path poolId is keccak256(abi.encode(Market)) with the fixture's fields", () => {
  const d = deriveJitMarket({ collateralAsset: CA, referenceAsset: REF, expiryTimestamp: 1790000000n, constraint: CONSTRAINT, oracle: ORACLE });
  const independent = keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "address" }],
      [CA, REF, 1790000000n, CONSTRAINT.rateMin, CONSTRAINT.rateMax, CONSTRAINT.rateChangePerDayMax, CONSTRAINT.rateChangeCapacityMax, ORACLE],
    ),
  );
  expect(d.poolId).toBe(independent);
});
