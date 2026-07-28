// Live parity gate for the Fusion pricing port: re-price the REAL captured production order at
// the CURRENT Arbitrum block and require wei-exact agreement with the deployed settlement
// getter's own answer over the same bytes (contract-as-oracle). Self-skips unless CORK_RPC_LIVE=1
// (same convention as rpc-live.test.ts). Note: eth_call runs with block.basefee = 0 on public
// nodes (empirical, experiments/fusion-spike/basefee-check.ts), so the local side prices with
// baseFeeWei omitted — which is exactly the getter's environment.
import { describe, expect, it } from "vitest";
import { parseAbi, sliceHex } from "viem";
import { resolveRpc, runTool } from "@cork/core";
import realFixture from "./fixtures/fusion-real-order.json" with { type: "json" };

const LIVE = process.env.CORK_RPC_LIVE === "1";

describe.skipIf(!LIVE)("fusion pricing — live contract-as-oracle parity (Arbitrum)", () => {
  it("local price at the latest block's timestamp equals the deployed getter wei-exactly", async () => {
    const resolved = await resolveRpc(42161, process.env.CORK_RPC_URL);
    expect(resolved).not.toBeNull();
    const client = resolved!.client;
    const block = await client.getBlock();

    const env = await runTool(
      "cork_compute",
      { chainId: 42161, params: { kind: "dutch-auction-price", order: realFixture.order }, at: { timestamp: block.timestamp.toString() }, format: "concise" },
      { nowSeconds: 0n },
    );
    expect(env.state).toBe("ok");
    const local = BigInt((env.data as { price: { takerPays: { nonWhitelistedTaker: string } } }).price.takerPays.nonWhitelistedTaker);

    const getterAbi = parseAbi([
      "function getTakingAmount((uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256) order, bytes extension, bytes32 orderHash, address taker, uint256 makingAmount, uint256 remainingMakingAmount, bytes extraData) view returns (uint256)",
    ]);
    const o = realFixture.order;
    const orderTuple = [BigInt(o.salt), BigInt(o.maker), BigInt(o.receiver), BigInt(o.makerAsset), BigInt(o.takerAsset), BigInt(o.makingAmount), BigInt(o.takingAmount), BigInt(o.makerTraits)] as const;
    const makingAmountData = sliceHex(o.extension as `0x${string}`, 32, 32 + 0x6e);
    const onChain = (await client.readContract({
      address: "0x2Ad5004c60e16E54d5007C80CE329Adde5B51Ef5",
      abi: getterAbi,
      functionName: "getTakingAmount",
      args: [orderTuple, "0x", `0x${"11".repeat(32)}`, "0x00000000000000000000000000000000000a11ce", BigInt(o.makingAmount), BigInt(o.makingAmount), sliceHex(makingAmountData, 20)],
      blockNumber: block.number,
    })) as bigint;
    expect(local).toBe(onChain);
  }, 60_000);
});
