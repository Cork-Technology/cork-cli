// Execution proof: build a real funded deposit bundle with the tool and eth_call it against the
// live vnet from the funded dev EOA. eth_call runs the FULL state transition and reverts if any
// require fails (deadline, funding allowance, CORK.deposit, slippage, whitelist), so a clean call
// proves the built bytes actually execute. A negative control (absurd slippage) must revert —
// otherwise the "pass" would be meaningless.
import { beforeAll, describe, expect, it } from "vitest";
import { createPublicClient, encodeFunctionData, http, parseAbi, type PublicClient } from "viem";
import { mainnet } from "viem/chains";
import { MAINNET_DEPLOYMENT, runTool } from "@cork/core";

const RPC = process.env.CORK_TEST_RPC;
const POOL = "0xceebea356e5159c9cb06612c39ef2e6e0fe9cd3bb047541e26e0c0767bd1c16a" as const;
const DEV = "0xc0ffee0000000000000000000000000000000001" as const; // funded dev EOA (sUSDe holder)
const SUSDE = "0x9D39A5DE30e57443BfF2A8307A4256c8797A3497" as const; // collateral
const erc20 = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
]);

describe.skipIf(!RPC)("bundle execution simulation vs live vnet", () => {
  let client: PublicClient;
  const NOW = 4_000_000_000n; // far-future deadline base (vnet clock is ~mainnet)

  beforeAll(async () => {
    client = createPublicClient({ chain: mainnet, transport: http(RPC) }) as PublicClient;
    // Impersonated approval so erc20TransferFrom(initiator=DEV -> adapter) succeeds. The vnet
    // auto-impersonates unsigned eth_sendTransaction (documented fixture recipe).
    const data = encodeFunctionData({ abi: erc20, functionName: "approve", args: [MAINNET_DEPLOYMENT.corkAdapter, 2n ** 200n] });
    await client.request({ method: "eth_sendTransaction", params: [{ from: DEV, to: SUSDE, data }] } as never);
  });

  async function depositBundle(minShares: string): Promise<`0x${string}`> {
    const env = await runTool(
      "cork_prepare_phoenix",
      {
        chainId: 1,
        account: DEV,
        clientRequestId: "sim-deposit-0001",
        fundingMode: "erc20-approve",
        deadlineSeconds: 3600,
        action: { type: "deposit", poolId: POOL, collateralAssetsIn: "10000000000000000000", receiver: DEV, minCptAndCstSharesOut: minShares },
        format: "concise",
      },
      { rpcUrl: RPC!, nowSeconds: NOW },
    );
    expect(env.state).toBe("ok");
    const data = env.data as { fundingLegs: number; bundle: unknown[]; multicall: `0x${string}` };
    expect(data.fundingLegs).toBe(1); // one erc20TransferFrom leg
    expect(data.bundle).toHaveLength(2); // funding + action
    return data.multicall;
  }

  it("allowance was set for the adapter", async () => {
    const a = await client.readContract({ address: SUSDE, abi: erc20, functionName: "allowance", args: [DEV, MAINNET_DEPLOYMENT.corkAdapter] });
    expect(a > 0n).toBe(true);
  });

  it("funded deposit bundle executes (eth_call does not revert)", async () => {
    const multicall = await depositBundle("1"); // trivially-satisfiable slippage floor
    await expect(
      client.call({ account: DEV, to: MAINNET_DEPLOYMENT.bundler3, data: multicall }),
    ).resolves.toBeDefined();
  });

  it("negative control: absurd min-shares slippage makes the same bundle REVERT", async () => {
    const multicall = await depositBundle("1000000000000000000000000000"); // 1e27, unreachable
    await expect(
      client.call({ account: DEV, to: MAINNET_DEPLOYMENT.bundler3, data: multicall }),
    ).rejects.toThrow();
  });

  describe("swap path (two funding legs: cST + REF)", () => {
    const CST = "0x16Aa2EbE1E2D6C856c634DaFc256257d2fEc0C69" as const;
    const VBUSDC = "0x53E82ABbb12638F09d9e624578ccB666217a765e" as const;

    beforeAll(async () => {
      for (const token of [CST, VBUSDC]) {
        const data = encodeFunctionData({ abi: erc20, functionName: "approve", args: [MAINNET_DEPLOYMENT.corkAdapter, 2n ** 200n] });
        await client.request({ method: "eth_sendTransaction", params: [{ from: DEV, to: token, data }] } as never);
      }
    });

    async function swapBundle(maxRef: string): Promise<`0x${string}`> {
      const env = await runTool(
        "cork_prepare_phoenix",
        {
          chainId: 1,
          account: DEV,
          clientRequestId: "sim-swap-0001",
          fundingMode: "erc20-approve",
          deadlineSeconds: 3600,
          // want 1 sUSDe out; provide generous cST + REF maxes (actual pulled <= max or it reverts)
          action: { type: "swap", poolId: POOL, collateralAssetsOut: "1000000000000000000", receiver: DEV, maxCstSharesIn: "2000000000000000000", maxReferenceAssetsIn: maxRef },
          format: "concise",
        },
        { rpcUrl: RPC!, nowSeconds: NOW },
      );
      const data = env.data as { fundingLegs: number; bundle: unknown[]; multicall: `0x${string}` };
      expect(data.fundingLegs).toBe(2); // cST + REF
      expect(data.bundle).toHaveLength(3); // 2 funding + action
      return data.multicall;
    }

    it("funded swap bundle executes (eth_call does not revert)", async () => {
      const multicall = await swapBundle("2000000"); // 2 vbUSDC max, ample
      await expect(client.call({ account: DEV, to: MAINNET_DEPLOYMENT.bundler3, data: multicall })).resolves.toBeDefined();
    });

    it("negative control: REF max too low makes the swap REVERT (SlippageExceeded)", async () => {
      const multicall = await swapBundle("1"); // 1 wei vbUSDC — cannot cover
      await expect(client.call({ account: DEV, to: MAINNET_DEPLOYMENT.bundler3, data: multicall })).rejects.toThrow();
    });
  });
});
