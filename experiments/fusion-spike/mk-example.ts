// Generate the worked-example Fusion order: minimal v3.1 extension (settlement getter on both
// amount fields, 2-point auction, zero fees), salt bound per OrderLib. Prints the example JSON.
import { concatHex, keccak256 } from "viem";
const SETTLEMENT = "0x2Ad5004c60e16E54d5007C80CE329Adde5B51Ef5";
const hp = (v: bigint, b: number) => v.toString(16).padStart(b * 2, "0");
// auction: start 2026-09-01 00:00 UTC (1787961600), 1h, +10% initial, 2 points
const auction = hp(0n, 3) + hp(0n, 4) + hp(1787961600n, 4) + hp(3600n, 3) + hp(1_000_000n, 3)
  + hp(2n, 1) + hp(700_000n, 3) + hp(900n, 2) + hp(300_000n, 3) + hp(900n, 2);
const fees = hp(0n, 2) + hp(0n, 1) + hp(0n, 2) + hp(0n, 1) + hp(0n, 1);
const amountData = (SETTLEMENT.slice(2) + auction + fees).toLowerCase();
const len = amountData.length / 2;
// offsets word: eight uint32 END offsets, index 0 = lowest bits; fields 2,3 = making/takingAmountData
const ends = [0, 0, len, 2 * len, 2 * len, 2 * len, 2 * len, 2 * len];
let offsets = 0n;
ends.forEach((e, i) => { offsets |= BigInt(e) << BigInt(32 * i); });
const extension = `0x${hp(offsets, 32)}${amountData}${amountData}` as `0x${string}`;
const salt = ((0xc0c0n << 160n) | (BigInt(keccak256(extension)) & ((1n << 160n) - 1n))).toString();
const order = {
  salt,
  maker: "0xc0ffee0000000000000000000000000000000001",
  receiver: "0x0000000000000000000000000000000000000000",
  makerAsset: "0x9D39A5DE30e57443BfF2A8307A4256c8797A3497",
  takerAsset: "0x53E82ABbb12638F09d9e624578ccB666217a765e",
  makingAmount: "1000000000000000000",
  takingAmount: "1000000",
  makerTraits: (1n << 249n).toString(), // HAS_EXTENSION
  extension,
};
console.log(JSON.stringify(order));
console.log("extension bytes:", (extension.length - 2) / 2);
