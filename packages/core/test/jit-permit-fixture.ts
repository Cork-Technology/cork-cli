import { createPublicClient, custom, decodeAbiParameters, decodeFunctionData, encodeFunctionResult, parseAbi, zeroAddress, type Abi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { BUNDLED_DEFAULTS, deriveJitMarket, runTool, type HandlerContext } from "@cork/core";
// Public deterministic test key only. All chain/venue state is local to this fixture.
export const signer = privateKeyToAccount(`0x${"01".repeat(32)}`);
export const CST = "0x0000000000000000000000000000000000000c03";
export const CPT = "0x0000000000000000000000000000000000000c04";
export const CA = "0x0000000000000000000000000000000000000c01";
export const REF = "0x0000000000000000000000000000000000000c02";
export const ORACLE = "0x0000000000000000000000000000000000000c05";
export const DESIGNATOR = "0xef01008a67b5020ee254ef48e3b6a04927f39baf7e408a";
export const NOW = 1790000000n, WAD = 10n ** 18n;
export const CONSTRAINT = { rateMin: 1n, rateMax: 2n * WAD, rateChangePerDayMax: WAD, rateChangeCapacityMax: WAD };
const domainAbi = parseAbi(["function eip712Domain() view returns (bytes1 fields, string name, string version, uint256 chainId, address verifyingContract, bytes32 salt, uint256[] extensions)", "function nonces(address owner) view returns (uint256)"]);

export function permitWorld(prepareTool: typeof runTool = runTool, generation: "phoenix/v0.5" | "phoenix/v0.4-rc.1" = "phoenix/v0.5") {
  const gen = BUNDLED_DEFAULTS.generations[8453]!.sets[generation]!;
  const mr = gen.marketRegistry!, pm = gen.phoenix!.poolManager!, controller = gen.phoenix!.controller!;
  const state = { exists: false, nonce: 0n, name: "SYN-REF10cST", allowance: 0n, unavailable: false, drift: false, ownerContract: false, ownerDelegated: false, ownerCodeRejects: false, contractSignatureValid: true, domainChain: 8453n, domainToken: CST, domainFields: "0x0f", extensions: [] as bigint[], simulationFails: false };
  const calls: Array<{ method: string; functionName?: string; request?: unknown }> = [];
  const domain = () => [state.domainFields, state.name, "1", state.domainChain, state.domainToken, `0x${"00".repeat(32)}`, state.extensions] as const;
  // Raw JSON-RPC code responses pass through the installed viem action, including its
  // successful "0x" -> undefined normalization. Native fixtures use this same raw provider.
  const codeRpcRequests: Array<{ method: string; params?: readonly unknown[] }> = [];
  const codeProvider = {
    request: async (request: { method: string; params?: readonly unknown[] }): Promise<`0x${string}`> => {
      codeRpcRequests.push(request);
      if (request.method !== "eth_getCode") throw new Error(`unexpected code-provider method ${request.method}`);
      const address = String(request.params?.[0]).toLowerCase();
      if (address === signer.address.toLowerCase()) {
        if (state.ownerCodeRejects) throw Object.assign(new Error("fixture owner code rejected"), { code: 3 });
        return state.ownerDelegated ? DESIGNATOR : state.ownerContract ? "0x6000" : "0x";
      }
      if (address === ORACLE || address === CST && state.exists) return "0x6000";
      throw new Error("fixture has no implementation bytecode");
    },
  };
  const codeClient = createPublicClient({ transport: custom(codeProvider) });
  const client = {
    getBlockNumber: async () => { calls.push({ method: "getBlockNumber" }); return 100n; },
    getCode: async (request: { address: `0x${string}`; blockNumber?: bigint }) => {
      calls.push({ method: "getCode", request });
      return codeClient.getCode(request);
    },
    readContract: async (a: { functionName: string; args?: readonly unknown[]; address: string; blockNumber?: bigint; abi?: Abi }) => {
      calls.push({ method: "readContract", functionName: a.functionName, request: a });
      if (state.unavailable && ["eip712Domain", "nonces", "shares"].includes(a.functionName)) throw new Error("fixture state unreadable");
      if (a.functionName === "eip712Domain") return domain();
      if (a.functionName === "nonces") return state.nonce;
      if (a.functionName === "isValidSignature") return state.contractSignatureValid ? "0x1626ba7e" : "0xffffffff";
      if (a.functionName === "shares") return state.exists ? [CPT, CST] : [zeroAddress, zeroAddress];
      if (a.functionName === "decodeExtraData") {
        const decoder = a.abi?.find(item => item.type === "function" && item.name === "decodeExtraData");
        if (!decoder || decoder.type !== "function") throw new Error("fixture requires the requested decoder ABI");
        return decodeAbiParameters(decoder.outputs, a.args![0] as `0x${string}`);
      }
      const values: Record<string, unknown> = { LIMIT_ORDER_PROTOCOL: BUNDLED_DEFAULTS.lopAddresses[8453], POOL_MANAGER: pm, MARKET_CREATOR: mr.marketCreator, MARKET_REGISTRY: mr.registry, CONTROLLER: controller, CORK_POOL_MANAGER: pm, hasRole: true, isRecipe: true, source: 1, lookupWrapper: ORACLE, rate: WAD, resolve: state.drift ? { ...CONSTRAINT, rateMin: 2n } : CONSTRAINT, verify: true, maxExpiryDuration: 2592000n, decimals: 6, allowance: state.allowance, balanceOf: 0n };
      if (a.functionName in values) return values[a.functionName];
      throw new Error(`unmodeled ${a.functionName}`);
    },
    simulateCalls: async (a: { calls: Array<{ data: `0x${string}` }> }) => {
      calls.push({ method: "simulateCalls", request: a });
      if (state.simulationFails) throw new Error("simulation unsupported");
      return { results: a.calls.map(c => {
        const selector = c.data.slice(0, 10);
        if (selector === "0x84b0196e") return { status: "success", data: encodeFunctionResult({ abi: domainAbi, functionName: "eip712Domain", result: domain() as never }) };
        if (selector === "0x7ecebe00") return { status: "success", data: encodeFunctionResult({ abi: domainAbi, functionName: "nonces", result: state.nonce }) };
        // shares selector is decoded from the real request instead of assuming argument order.
        try { if (decodeFunctionData({ abi: parseAbi(["function shares(bytes32) view returns (address,address)"]), data: c.data }).functionName === "shares") return { status: "success", data: "0x" + CPT.slice(2).padStart(64, "0") + CST.slice(2).padStart(64, "0") }; } catch { /* creation */ }
        return { status: "success", data: "0x" };
      }) };
    },
  };
  const ctx: HandlerContext = {
    nowSeconds: NOW, generation, apiKeys: "refuse",
    resolveRpc: async () => ({ source: "explicit", url: "http://127.0.0.1/synthetic", client: client as never }),
    venueFetch: async () => Response.json({
      rfq_id: "rfq_local", kind: "new_position", state: "open", version: 1,
      answers: [{ answer_id: "answer_local", underwriter: signer.address, answer: { status: "firm", options: [{
        option_id: "opt_local", collateral_asset: CA, premium_annualized: "0.04", expiry: Number(NOW + 864000n),
        notional_max_assets: "1000000", mode: "liquidity_only", package_id: "pkg_local",
      }] } }],
      request: { schema_version: "2", kind: "new_position", chain_id: 8453, requester: signer.address, reference_asset: REF, collateral_asset: { exact: CA }, notional_assets: "1000000", modes: ["liquidity_only"], package_ids: ["pkg_local"], valid_until: Number(NOW + 86400n), market_template: { inline: { oracle_recipe: mr.recipes!.liquidity } } },
    }),
  };
  const jitMarket = { collateralAsset: CA, referenceAsset: REF, expiryTimestamp: String(NOW + 864000n), recipe: mr.recipes!.liquidity, enableJitMint: true, rateOverride: "0", swapFeePercentage: "0", unwindSwapFeePercentage: "0" };
  const poolId = deriveJitMarket({ collateralAsset: CA, referenceAsset: REF, expiryTimestamp: BigInt(jitMarket.expiryTimestamp), constraint: CONSTRAINT, oracle: ORACLE, wire: "10-field", swapFeePercentage: 0n, unwindSwapFeePercentage: 0n }).poolId;
  const input = { chainId: 8453, account: signer.address, clientRequestId: "jit-permit-local", format: "full", action: { type: "maker-order", poolId, side: "SELL", makerAsset: CST, takerAsset: CA, makingAmount: String(WAD), takingAmount: "1000", expirySeconds: 600, jitMarket } };
  const prepare = (request: unknown = input) => prepareTool("cork_prepare_orders", request, ctx);
  return { state, calls, ctx, input, prepare, poolId, client, codeProvider, codeRpcRequests };
}
