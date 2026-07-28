// Pull a REAL production Fusion v3.1 order from chain calldata: recent OrderFilled logs on the
// router, filter fill txs whose calldata embeds the settlement address, decode fillOrderArgs
// (uint256-tuple form) and slice the extension per TakerTraits' ARGS_EXTENSION_LENGTH bits.
import { createPublicClient, decodeFunctionData, http, parseAbi, toEventSelector } from "viem";
const client = createPublicClient({ transport: http("https://arb1.arbitrum.io/rpc") });
const ROUTER = "0x111111125421cA6dc452d289314280a0f8842A65" as const;
const SETTLEMENT = "2ad5004c60e16e54d5007c80ce329adde5b51ef5";
const fillAbi = parseAbi([
  "function fillOrderArgs((uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256) order, bytes32 r, bytes32 vs, uint256 amount, uint256 takerTraits, bytes args) returns (uint256, uint256, bytes32)",
  "function fillContractOrderArgs((uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256) order, bytes signature, uint256 amount, uint256 takerTraits, bytes args) returns (uint256, uint256, bytes32)",
]);
const head = await client.getBlockNumber();
const logs = await client.getLogs({ address: ROUTER, fromBlock: head - 80_000n, toBlock: head, event: { type: "event", name: "OrderFilled", inputs: [{ type: "bytes32", name: "orderHash" }, { type: "uint256", name: "remainingAmount" }] } });
console.log(`OrderFilled logs in last 80k blocks: ${logs.length}`);
for (const log of logs.slice(-30).reverse()) {
  const tx = await client.getTransaction({ hash: log.transactionHash });
  const idx = tx.input.toLowerCase().indexOf(SETTLEMENT);
  if (idx < 0) continue;
  // fill calls may be nested in resolver calldata — find the fill selector inside the input
  for (const sel of ["f497df75", "1e2cd7ed"]) {
    const at = tx.input.toLowerCase().indexOf(sel);
    if (at < 0) continue;
    const inner = `0x${tx.input.slice(at)}` as `0x${string}`;
    try {
      const dec = decodeFunctionData({ abi: fillAbi, data: inner });
      const [order, , , , takerTraits, args] = dec.functionName === "fillOrderArgs"
        ? [dec.args[0], 0, 0, 0, dec.args[4], dec.args[5]] as const
        : [dec.args[0], 0, 0, 0, dec.args[3], dec.args[4]] as const;
      const tt = takerTraits as bigint;
      const argsHex = (args as string).slice(2);
      const hasTarget = (tt & (1n << 251n)) !== 0n; // _ARGS_HAS_TARGET
      const extLen = Number((tt >> 224n) & ((1n << 24n) - 1n)); // _ARGS_EXTENSION_LENGTH
      const start = hasTarget ? 40 : 0;
      const extension = `0x${argsHex.slice(start, start + extLen * 2)}`;
      if (!extension.toLowerCase().includes(SETTLEMENT)) continue;
      console.log(JSON.stringify({
        tx: log.transactionHash, block: log.blockNumber.toString(), orderHashEvent: log.topics.length ? undefined : undefined,
        fillFn: dec.functionName,
        order: (order as readonly bigint[]).map((x) => x.toString()),
        extension,
      }));
      process.exit(0);
    } catch { /* not this selector's layout at this offset */ }
  }
}
console.log("no settlement-routed fill found in the sampled window");
