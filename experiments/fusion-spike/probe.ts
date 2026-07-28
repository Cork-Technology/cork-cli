// Fusion empirical probe (2026-07-28): verify the live Settlement deployments on mainnet +
// Arbitrum, then prove a LOCAL port of the v3.1 dutch-auction math is wei-exact against the
// deployed contracts' own IAmountGetter views (eth_call at a pinned block).
//
// Run: bun experiments/fusion-spike/probe.ts   (from the repo root; public RPCs, no keys)
import { createPublicClient, http, keccak256, parseAbi, toHex } from "viem";

const CHAINS = [
  { name: "mainnet", id: 1, rpc: "https://ethereum-rpc.publicnode.com" },
  { name: "arbitrum", id: 42161, rpc: "https://arb1.arbitrum.io/rpc" },
] as const;

const ADDR = {
  settlementV31: "0x2Ad5004c60e16E54d5007C80CE329Adde5B51Ef5", // fusion-protocol master deployments (both chains, CREATE3)
  settlementV2: "0xfb2809A5314473E1165f6B58018E20ed8F07B840",
  settlementV1: "0xA88800CD213dA5Ae406ce248380802BD53b47647",
  accessToken: "0xAccE550000863572B867E661647CD7D97b72C507",
  etherscanHit: "0xf4F4D19c3ae690c412460A5948757180642364bf", // surfaced in search; classify
} as const;

// 1inch v4 `type Address is uint256`: the DEPLOYED selectors use an all-uint256 Order tuple
// (getTakingAmount = 0xd7ff8a80), NOT the address-typed form — the same custom-type trap as the
// fillOrderArgs selector (0xf497df75, JitOrderRoundTrip finding 2026-07-23). Verified against
// the deployments/arbitrum/SimpleSettlement.json artifact ABI.
const getterAbi = parseAbi([
  "function getMakingAmount((uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256) order, bytes extension, bytes32 orderHash, address taker, uint256 takingAmount, uint256 remainingMakingAmount, bytes extraData) view returns (uint256)",
  "function getTakingAmount((uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256) order, bytes extension, bytes32 orderHash, address taker, uint256 makingAmount, uint256 remainingMakingAmount, bytes extraData) view returns (uint256)",
  "function owner() view returns (address)",
]);

// ── local port of SimpleSettlement._getRateBump / _getAuctionBump (v3.1.2) ──────────────────
interface Auction {
  gasBumpEstimate: bigint; // uint24, 1e7 base
  gasPriceEstimate: bigint; // uint32, 1000 = 1 gwei
  startTime: bigint; // uint32
  duration: bigint; // uint24
  initialRateBump: bigint; // uint24, 1e7 base
  points: Array<{ rateBump: bigint; timeDelta: bigint }>; // uint24 ‖ uint16, cumulative deltas
}
const BASE_POINTS = 10_000_000n;
const GAS_PRICE_BASE = 1_000_000n;
const BASE_1E5 = 100_000n;

function rateBump(a: Auction, timestamp: bigint, baseFee: bigint): bigint {
  const gasBump = a.gasBumpEstimate === 0n || a.gasPriceEstimate === 0n ? 0n : (a.gasBumpEstimate * baseFee) / a.gasPriceEstimate / GAS_PRICE_BASE;
  const finish = a.startTime + a.duration;
  let auctionBump: bigint;
  if (timestamp <= a.startTime) auctionBump = a.initialRateBump;
  else if (timestamp >= finish) auctionBump = 0n;
  else {
    let currentTime = a.startTime;
    let currentBump = a.initialRateBump;
    auctionBump = -1n;
    for (const p of a.points) {
      const nextTime = currentTime + p.timeDelta;
      if (timestamp <= nextTime) {
        auctionBump = ((timestamp - currentTime) * p.rateBump + (nextTime - timestamp) * currentBump) / (nextTime - currentTime);
        break;
      }
      currentBump = p.rateBump;
      currentTime = nextTime;
    }
    if (auctionBump === -1n) auctionBump = ((finish - timestamp) * currentBump) / (finish - currentTime);
  }
  return auctionBump > gasBump ? auctionBump - gasBump : 0n;
}

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

/** takerPays: exact nesting = linear base (ceil) → fee markup (ceil) → rate bump (ceil). */
function localTakingAmount(M: bigint, T: bigint, m: bigint, fee: bigint, bump: bigint): bigint {
  const linear = ceilDiv(T * m, M);
  const withFee = ceilDiv(linear * (BASE_1E5 + fee), BASE_1E5);
  return ceilDiv(withFee * (BASE_POINTS + bump), BASE_POINTS);
}
/** makerGives: floor at every step, same nesting. */
function localMakingAmount(M: bigint, T: bigint, t: bigint, fee: bigint, bump: bigint): bigint {
  const linear = (M * t) / T;
  const withFee = (linear * BASE_1E5) / (BASE_1E5 + fee);
  return (withFee * BASE_POINTS) / (BASE_POINTS + bump);
}

// ── byte builders (v3.1 extraData layout: AuctionDetails ‖ feeData ‖ whitelist) ─────────────
const hexPad = (v: bigint, bytes: number) => v.toString(16).padStart(bytes * 2, "0");
function encodeExtraData(a: Auction, fees: { integratorFee: bigint; integratorShare: bigint; resolverFee: bigint; discountNumerator: bigint; whitelist: string[] }): `0x${string}` {
  let s = hexPad(a.gasBumpEstimate, 3) + hexPad(a.gasPriceEstimate, 4) + hexPad(a.startTime, 4) + hexPad(a.duration, 3) + hexPad(a.initialRateBump, 3);
  s += hexPad(BigInt(a.points.length), 1);
  for (const p of a.points) s += hexPad(p.rateBump, 3) + hexPad(p.timeDelta, 2);
  s += hexPad(fees.integratorFee, 2) + hexPad(fees.integratorShare, 1) + hexPad(fees.resolverFee, 2) + hexPad(fees.discountNumerator, 1);
  s += hexPad(BigInt(fees.whitelist.length), 1);
  for (const w of fees.whitelist) s += w.slice(-20); // low 10 bytes of each address
  return `0x${s}` as `0x${string}`;
}

const TAKER = "0x00000000000000000000000000000000000a11ce" as const;
const M = 10n ** 18n;
const T = 2_000_000_000n;
const ORDER = [1n, BigInt(TAKER), 0n, BigInt("0x9D39A5DE30e57443BfF2A8307A4256c8797A3497"), BigInt("0x53E82ABbb12638F09d9e624578ccB666217a765e"), M, T, 0n] as const;
const HASH = `0x${"11".repeat(32)}` as const;

async function main() {
  for (const chain of CHAINS) {
    const client = createPublicClient({ transport: http(chain.rpc) });
    console.log(`\n═══ ${chain.name} (${chain.id}) via ${new URL(chain.rpc).host} ═══`);
    const chainId = await client.getChainId();
    if (chainId !== chain.id) throw new Error(`endpoint answered chainId ${chainId}, expected ${chain.id}`);

    // 1. deployment verification
    for (const [label, addr] of Object.entries(ADDR)) {
      const code = await client.getCode({ address: addr as `0x${string}` });
      const size = code ? (code.length - 2) / 2 : 0;
      console.log(`  ${label.padEnd(14)} ${addr}  codeSize=${size}${size ? ` codeHash=${keccak256(code!).slice(0, 18)}…` : "  (NO CODE)"}`);
    }
    try {
      const owner = await client.readContract({ address: ADDR.settlementV31, abi: getterAbi, functionName: "owner" });
      console.log(`  settlementV31.owner() = ${owner}`);
    } catch (e) {
      console.log(`  settlementV31.owner() read failed: ${e instanceof Error ? e.message.split("\n")[0] : e}`);
    }

    // 2. parity probe at a pinned block
    const block = await client.getBlock();
    const ts = block.timestamp;
    const baseFee = block.baseFeePerGas ?? 0n;
    console.log(`  pinned block ${block.number} ts=${ts} baseFee=${baseFee}`);
    const auction: Auction = {
      gasBumpEstimate: 0n,
      gasPriceEstimate: 0n,
      startTime: ts - 600n,
      duration: 3600n,
      initialRateBump: 1_000_000n, // +10%
      points: [
        { rateBump: 700_000n, timeDelta: 900n },
        { rateBump: 300_000n, timeDelta: 900n },
      ],
    };
    const vectors: Array<{ label: string; a: Auction; fees: Parameters<typeof encodeExtraData>[1]; fee: bigint }> = [
      { label: "mid-auction, no fees", a: auction, fees: { integratorFee: 0n, integratorShare: 0n, resolverFee: 0n, discountNumerator: 0n, whitelist: [] }, fee: 0n },
      // whitelisted taker: resolverFee 200 discounted by 75/100 → 150; +integrator 100 → fee 250
      { label: "fees + whitelisted taker", a: auction, fees: { integratorFee: 100n, integratorShare: 50n, resolverFee: 200n, discountNumerator: 75n, whitelist: [TAKER] }, fee: 100n + 150n },
      // gas-bump coupling: bump reduced by gasBumpEstimate*baseFee/gasPriceEstimate/1e6
      { label: "gas-bump coupled", a: { ...auction, gasBumpEstimate: 50_000n, gasPriceEstimate: 1_000n }, fees: { integratorFee: 0n, integratorShare: 0n, resolverFee: 0n, discountNumerator: 0n, whitelist: [] }, fee: 0n },
      { label: "pre-start (bump pinned)", a: { ...auction, startTime: ts + 1000n }, fees: { integratorFee: 0n, integratorShare: 0n, resolverFee: 0n, discountNumerator: 0n, whitelist: [] }, fee: 0n },
      { label: "post-finish (bump 0)", a: { ...auction, startTime: ts - 10_000n, duration: 3600n }, fees: { integratorFee: 0n, integratorShare: 0n, resolverFee: 0n, discountNumerator: 0n, whitelist: [] }, fee: 0n },
    ];
    const m = 250_000_000_000_000_000n; // request 0.25e18 making
    const t = 500_000_000n; // request 0.5e9 taking
    for (const v of vectors) {
      const extraData = encodeExtraData(v.a, v.fees);
      // EMPIRICAL (2026-07-28, basefee-check.ts): public nodes run eth_call with block.basefee=0
      // (NoBaseFee), proven by gasPriceEstimate=1 returning the un-bumped price on both chains —
      // so on-chain parity is asserted at baseFee=0. The gas-bump term vs a REAL basefee needs an
      // anvil fork with basefee control (F0 acceptance); the formula itself mirrors
      // AuctionCalculator.calcRateBump(time, baseFee) verbatim. block baseFee printed above for
      // context only.
      const bump = rateBump(v.a, ts, 0n);
      const wantTaking = localTakingAmount(M, T, m, v.fee, bump);
      const wantMaking = localMakingAmount(M, T, t, v.fee, bump);
      const [gotTaking, gotMaking] = await Promise.all([
        client.readContract({ address: ADDR.settlementV31, abi: getterAbi, functionName: "getTakingAmount", args: [ORDER, "0x", HASH, TAKER, m, M, extraData], blockNumber: block.number }),
        client.readContract({ address: ADDR.settlementV31, abi: getterAbi, functionName: "getMakingAmount", args: [ORDER, "0x", HASH, TAKER, t, M, extraData], blockNumber: block.number }),
      ]);
      const ok = gotTaking === wantTaking && gotMaking === wantMaking;
      console.log(`  ${ok ? "PASS" : "FAIL"} ${v.label}: bump=${bump} taking on-chain=${gotTaking} local=${wantTaking} | making on-chain=${gotMaking} local=${wantMaking}`);
      if (!ok) process.exitCode = 1;
    }
  }
}
await main();
