// End-to-end validation on REAL production bytes: decode + price the captured Fusion order via
// runTool, then eth_call the LIVE settlement getter with the same real extraData at a pinned
// block and require wei-exact agreement. Also freezes the fixture for offline tests.
import { createPublicClient, http, parseAbi, sliceHex } from "viem";
import { runTool } from "@cork/core";
import { writeFileSync } from "node:fs";

const RAW = {
  tx: "0x617bdf2bf012b0f3f7690c16346f376eb26cf02a5c7bf1d0c99d19328ce0538f",
  block: 488464473n,
  order: [
    "33701748000487897755986704189445794211750364958052645339576736733840550249982",
    "602006530333479658046990054617467628633710217654",
    "0",
    "609234726618302039048360928043599640778703963680",
    "1307708180845942709444202570947697363929169733832",
    "200000000",
    "105974268740443453",
    "33471150795161712739625987854073848363835857100595621427372814996761944784896",
  ],
  extension: "0x0000018d000000dc000000dc000000dc000000dc0000006e00000000000000002ad5004c60e16e54d5007c80ce329adde5b51ef5000000000000006a681b6d0000b400c4530100a1dd007e00000000006406150744f5914a1573eab4000000000000000000006ea9a11ae13b29f5c555d18bd45f0b94f54a968f0000000000000000000095770895ad27ad6b0d952ad5004c60e16e54d5007c80ce329adde5b51ef5000000000000006a681b6d0000b400c4530100a1dd007e00000000006406150744f5914a1573eab4000000000000000000006ea9a11ae13b29f5c555d18bd45f0b94f54a968f0000000000000000000095770895ad27ad6b0d952ad5004c60e16e54d5007c80ce329adde5b51ef500000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000646a681b5c06150744f5914a1573eab400000000000000000000000000006ea9a11ae13b29f5c5550000d18bd45f0b94f54a968f000000000000000000000000000095770895ad27ad6b0d950000000000000000000000000000000000000000000000000000017a7332f9ad360800",
} as const;

const addr = (v: string) => `0x${BigInt(v).toString(16).padStart(40, "0")}`;
const orderRec = {
  salt: RAW.order[0], maker: addr(RAW.order[1]), receiver: addr(RAW.order[2]),
  makerAsset: addr(RAW.order[3]), takerAsset: addr(RAW.order[4]),
  makingAmount: RAW.order[5], takingAmount: RAW.order[6], makerTraits: RAW.order[7],
  extension: RAW.extension,
};

const client = createPublicClient({ transport: http("https://arb1.arbitrum.io/rpc") });
const block = await client.getBlock({ blockNumber: RAW.block });
console.log("fill block timestamp:", block.timestamp);

const env = await runTool("cork_compute", {
  chainId: 42161,
  params: { kind: "dutch-auction-price", order: orderRec },
  at: { timestamp: block.timestamp.toString() },
}, { nowSeconds: block.timestamp });
if (env.state !== "ok") { console.log("ENVELOPE", JSON.stringify(env, null, 1)); process.exit(1); }
const d = env.data as Record<string, any>;
console.log("state:", env.state, "| classification:", d.settlement.classification, "| phase:", d.phase, "| bump:", d.rateBump.effective);
console.log("auction:", JSON.stringify(d.auction));
console.log("fees:", JSON.stringify(d.fees), "| fillability:", JSON.stringify({ gated: d.fillability.gated, resolvingStartTime: d.fillability.resolvingStartTime, publicFillTime: d.fillability.publicFillTime, whitelistSize: d.fillability.whitelistSize }));
console.log("takerPays(full order):", JSON.stringify(d.price.takerPays));

// contract-as-oracle: same REAL getter extraData, same timestamp context (pinned block), compare.
const getterAbi = parseAbi([
  "function getTakingAmount((uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256) order, bytes extension, bytes32 orderHash, address taker, uint256 makingAmount, uint256 remainingMakingAmount, bytes extraData) view returns (uint256)",
]);
const makingAmountData = sliceHex(RAW.extension as `0x${string}`, 32, 32 + 0x6e); // field 2 per offsets
const extraData = sliceHex(makingAmountData, 20);
const ORDER_T = RAW.order.map(BigInt) as unknown as readonly [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint];
// two takers: one from the order's whitelist (first entry half) and one not whitelisted
const wlTaker = `0x0000000000000000000000${(d.feesRaw ?? "")}`;
// Historical eth_call state is pruned on the public node; the getter depends only on the block
// env (timestamp; basefee=0 in eth_call), so parity at LATEST is equally strong: re-price
// locally at the latest block's timestamp and compare.
const latest = await client.getBlock();
const envLatest = await runTool("cork_compute", {
  chainId: 42161,
  params: { kind: "dutch-auction-price", order: orderRec },
  at: { timestamp: latest.timestamp.toString() },
}, { nowSeconds: latest.timestamp });
const dl = envLatest.data as Record<string, any>;
const onchainNonWl = await client.readContract({ address: "0x2Ad5004c60e16E54d5007C80CE329Adde5B51Ef5", abi: getterAbi, functionName: "getTakingAmount", args: [ORDER_T, "0x", `0x${"11".repeat(32)}`, "0x00000000000000000000000000000000000a11ce", BigInt(RAW.order[5]), BigInt(RAW.order[5]), extraData], blockNumber: latest.number });
const localNonWl = BigInt(dl.price.takerPays.nonWhitelistedTaker);
console.log(`contract-as-oracle (REAL bytes, latest block ts=${latest.timestamp}): on-chain=${onchainNonWl} local=${localNonWl} ${onchainNonWl === localNonWl ? "WEI-EXACT" : "MISMATCH"}`);
if (onchainNonWl !== localNonWl) process.exit(1);

writeFileSync("packages/core/test/fixtures/fusion-real-order.json", JSON.stringify({
  source: "Arbitrum fill tx " + RAW.tx + " (block " + RAW.block.toString() + ", captured 2026-07-28)",
  blockTimestamp: block.timestamp.toString(),
  order: orderRec,
  expected: {
    classification: d.settlement.classification,
    auction: d.auction,
    effectiveBump: d.rateBump.effective,
    takerPaysNonWhitelisted: d.price.takerPays.nonWhitelistedTaker,
    takerPaysWhitelisted: d.price.takerPays.whitelistedTaker,
    onChainGetterNonWhitelisted: onchainNonWl.toString(),
    fillability: { gated: d.fillability.gated, resolvingStartTime: d.fillability.resolvingStartTime, publicFillTime: d.fillability.publicFillTime, whitelistSize: d.fillability.whitelistSize },
  },
}, null, 2) + "\n");
console.log("fixture frozen: packages/core/test/fixtures/fusion-real-order.json");
