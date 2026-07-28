// Bisect the getter revert: raw eth_call to capture revert data (custom error selector), and
// probe simpler extraData shapes to find which parse stage rejects ours.
import { createPublicClient, encodeFunctionData, http, parseAbi } from "viem";

const client = createPublicClient({ transport: http("https://arb1.arbitrum.io/rpc") });
const SETTLEMENT = "0x2Ad5004c60e16E54d5007C80CE329Adde5B51Ef5" as const;
const abi = parseAbi([
  "function getTakingAmount((uint256,address,address,address,address,uint256,uint256,uint256) order, bytes extension, bytes32 orderHash, address taker, uint256 makingAmount, uint256 remainingMakingAmount, bytes extraData) view returns (uint256)",
]);
const TAKER = "0x00000000000000000000000000000000000a11ce" as const;
const ORDER = [1n, TAKER, "0x0000000000000000000000000000000000000000", "0x9D39A5DE30e57443BfF2A8307A4256c8797A3497", "0x53E82ABbb12638F09d9e624578ccB666217a765e", 10n ** 18n, 2_000_000_000n, 0n] as const;
const HASH = `0x${"11".repeat(32)}` as const;

const hexPad = (v: bigint, bytes: number) => v.toString(16).padStart(bytes * 2, "0");
const block = await client.getBlock();
const ts = block.timestamp;

const header = (start: bigint) => hexPad(0n, 3) + hexPad(0n, 4) + hexPad(start, 4) + hexPad(3600n, 3) + hexPad(1_000_000n, 3);
const feeZero = hexPad(0n, 2) + hexPad(0n, 1) + hexPad(0n, 2) + hexPad(0n, 1) + hexPad(0n, 1);

const cases: Array<[string, string]> = [
  ["auction(N=0) + fees(0)", header(ts - 600n) + hexPad(0n, 1) + feeZero],
  ["auction(N=0) only, NO fee section", header(ts - 600n) + hexPad(0n, 1)],
  ["auction with NO points-count byte (v2 style) + fees", header(ts - 600n) + feeZero],
  ["auction(N=2) + fees(0)", header(ts - 600n) + hexPad(2n, 1) + hexPad(700_000n, 3) + hexPad(900n, 2) + hexPad(300_000n, 3) + hexPad(900n, 2) + feeZero],
  ["empty extraData", ""],
];

for (const [label, extra] of cases) {
  const data = encodeFunctionData({ abi, functionName: "getTakingAmount", args: [ORDER, "0x", HASH, TAKER, 250_000_000_000_000_000n, 10n ** 18n, `0x${extra}` as `0x${string}`] });
  try {
    const res = await client.request({ method: "eth_call", params: [{ to: SETTLEMENT, data }, "latest"] });
    console.log(`OK    ${label}: result=${BigInt(res as string)}`);
  } catch (err) {
    const e = err as { details?: string; data?: unknown; cause?: { data?: unknown; details?: string } };
    const raw = JSON.stringify(e.data ?? e.cause?.data ?? e.details ?? e.cause?.details ?? String(err)).slice(0, 200);
    console.log(`REVERT ${label}: ${raw}`);
  }
}
