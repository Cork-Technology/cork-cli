// Is block.basefee zero inside public-node eth_call? gasPriceEstimate=1 makes gasBump enormous
// (bump floors to 0) iff basefee>0. Same answer as no-gas-bump ⇒ basefee=0 in the call context.
import { createPublicClient, http, parseAbi } from "viem";
const abi = parseAbi([
  "function getTakingAmount((uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256) order, bytes extension, bytes32 orderHash, address taker, uint256 makingAmount, uint256 remainingMakingAmount, bytes extraData) view returns (uint256)",
]);
const hexPad = (v: bigint, b: number) => v.toString(16).padStart(b * 2, "0");
for (const [name, rpc] of [["mainnet", "https://ethereum-rpc.publicnode.com"], ["arbitrum", "https://arb1.arbitrum.io/rpc"]] as const) {
  const client = createPublicClient({ transport: http(rpc) });
  const block = await client.getBlock();
  const ts = block.timestamp;
  const ORDER = [1n, 0xa11cen, 0n, 1n, 2n, 10n ** 18n, 2_000_000_000n, 0n] as const;
  const mk = (gasBumpEst: bigint, gasPriceEst: bigint) =>
    `0x${hexPad(gasBumpEst, 3) + hexPad(gasPriceEst, 4) + hexPad(ts - 600n, 4) + hexPad(3600n, 3) + hexPad(1_000_000n, 3) + hexPad(0n, 1) + hexPad(0n, 7)}` as `0x${string}`;
  const call = (extra: `0x${string}`) =>
    client.readContract({ address: "0x2Ad5004c60e16E54d5007C80CE329Adde5B51Ef5", abi, functionName: "getTakingAmount", args: [ORDER, "0x", `0x${"11".repeat(32)}`, "0x00000000000000000000000000000000000a11ce", 250_000_000_000_000_000n, 10n ** 18n, extra], blockNumber: block.number });
  const [noGas, hugeGas] = await Promise.all([call(mk(0n, 0n)), call(mk(50_000n, 1n))]);
  console.log(`${name}: block.baseFee=${block.baseFeePerGas} | no-gas-bump=${noGas} | gasPriceEstimate=1 (bump→0 iff basefee>0): ${hugeGas} ⇒ eth_call basefee ${hugeGas === noGas ? "= 0" : "> 0"}`);
}
