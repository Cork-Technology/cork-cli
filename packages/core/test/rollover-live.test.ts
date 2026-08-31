// Live verification of the rc.2 rollover deployment (rollover v0.1.0-rc.2, v0.1.0-rc.2)
// against the real chains. Self-skips unless CORK_RPC_LIVE=1 so CI stays offline/deterministic.
//
// Three legs, per chain (42161 + 8453 — identical CREATE2 addresses, per-chain domains):
//   1. DOMAIN — the local corkSettlerDomainSeparator equals each settler's on-chain
//      DOMAIN_SEPARATOR() (the offline golden vectors' source of truth, re-fetched).
//   2. APPROVAL — the configured factory approves exactly the configured settlers.
//   3. ENCODING — resolveFor over our own encodeOrderData/ORDER_DATA_TYPEHASH reaches the
//      Settler__RolloverContractNotDeployed state check: the 864-byte layout, typehash, digest,
//      and deadline gates all pass on REAL bytecode, and admission dies only at the first check
//      that needs a deployed clone. This is the exact probe the venue used to verify
//      its rc.2 encoder; a wire regression fails DECODE (a different error) before that state
//      check is ever reached.
import { describe, expect, it } from "vitest";
import { encodeFunctionData, keccak256, stringToBytes } from "viem";
import {
  buildRolloverIntent,
  corkSettlerDomainSeparator,
  encodeOrderData,
  ORDER_DATA_TYPEHASH,
  resolveRollover,
  resolveRpc,
} from "@cork/core";

const LIVE = process.env.CORK_RPC_LIVE === "1";

const domainSeparatorAbi = [
  { type: "function", name: "DOMAIN_SEPARATOR", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] },
] as const;
const approvedSettlersAbi = [
  { type: "function", name: "approvedSettlers", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "bool" }] },
] as const;
const resolveForAbi = [
  {
    type: "function",
    name: "resolveFor",
    stateMutability: "view",
    inputs: [
      {
        name: "order",
        type: "tuple",
        components: [
          { name: "originSettler", type: "address" },
          { name: "user", type: "address" },
          { name: "nonce", type: "uint256" },
          { name: "originChainId", type: "uint256" },
          { name: "openDeadline", type: "uint32" },
          { name: "fillDeadline", type: "uint32" },
          { name: "orderDataType", type: "bytes32" },
          { name: "orderData", type: "bytes" },
        ],
      },
      { name: "originFillerData", type: "bytes" },
    ],
    outputs: [{ type: "tuple", components: [] }],
  },
] as const;

describe.skipIf(!LIVE)("rollover rc.2 deployment — live (both chains)", () => {
  for (const chainId of [42161, 8453] as const) {
    it(`chain ${chainId}: domains match, factory approves both settlers, resolveFor accepts our encoding`, async () => {
      const { rollover } = await resolveRollover(chainId);
      expect(rollover).toBeDefined();
      const r = await resolveRpc(chainId, undefined);
      expect(r).not.toBeNull();
      const client = r!.client;

      // 1. DOMAIN parity for both settlers.
      for (const settler of [rollover!.exactSettler, rollover!.partialSettler]) {
        const onChain = await client.readContract({ address: settler, abi: domainSeparatorAbi, functionName: "DOMAIN_SEPARATOR" });
        expect(onChain, `${settler} @ ${chainId}`).toBe(corkSettlerDomainSeparator(chainId, settler));
      }

      // 2. The configured factory approves exactly the configured settlers (default-deny).
      for (const settler of [rollover!.exactSettler, rollover!.partialSettler]) {
        const approved = await client.readContract({ address: rollover!.factory, abi: approvedSettlersAbi, functionName: "approvedSettlers", args: [settler] });
        expect(approved, `factory must approve ${settler}`).toBe(true);
      }

      // 3. resolveFor over OUR bytes: expect the state check (no deployed clone for this fake
      // user), which sits BEHIND the length/typehash/digest/deadline gates. Any encoding
      // regression reverts differently (decode/typehash error) or earlier.
      const now = BigInt(Math.floor(Date.now() / 1000));
      const built = buildRolloverIntent({
        chainId,
        user: "0xC0FFEe0000000000000000000000000000000001",
        settler: rollover!.exactSettler,
        rolloverContract: "0xC0FFEe0000000000000000000000000000000001",
        srcCstToken: "0x9D39A5DE30e57443BfF2A8307A4256c8797A3497",
        dstCstToken: "0x53E82ABbb12638F09d9e624578ccB666217a765e",
        premiumToken: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        srcPoolId: `0x${"11".repeat(32)}`,
        dstPoolId: `0x${"22".repeat(32)}`,
        orderSize: 250n * 10n ** 18n,
        minPremiumPerShare: 12n * 10n ** 15n,
        openDeadline: now + 3_600n,
        fillDeadline: now + 86_400n,
        clientRequestId: "live-rc2-probe",
      });
      const orderData = encodeOrderData(built.order);
      expect(orderData).toHaveLength(2 + 864 * 2);
      const calldata = encodeFunctionData({
        abi: resolveForAbi,
        functionName: "resolveFor",
        args: [
          {
            originSettler: rollover!.exactSettler,
            user: built.order.user,
            nonce: built.order.orderSalt,
            originChainId: BigInt(chainId),
            openDeadline: Number(built.order.openDeadline),
            fillDeadline: Number(built.order.fillDeadline),
            orderDataType: ORDER_DATA_TYPEHASH,
            orderData,
          },
          "0x",
        ],
      });
      let revertData: string | null = null;
      try {
        await client.call({ to: rollover!.exactSettler, data: calldata });
      } catch (err) {
        // Walk the viem error chain for the raw revert data (RawContractError.data).
        for (let e: unknown = err; e; e = (e as { cause?: unknown }).cause) {
          const d = (e as { data?: unknown }).data;
          if (typeof d === "string" && d.startsWith("0x") && d.length >= 10) {
            revertData = d;
            break;
          }
          if (typeof d === "object" && d !== null && typeof (d as { data?: unknown }).data === "string") {
            revertData = (d as { data: string }).data;
            break;
          }
        }
        if (revertData === null) revertData = `<no data: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}>`;
      }
      // Settler__RolloverContractNotDeployed(address user) — reaching THIS error proves the
      // wire format is accepted (an encoding/typehash regression reverts differently, before
      // the state check), and the arg carries our fake user back.
      const selector = keccak256(stringToBytes("Settler__RolloverContractNotDeployed(address)")).slice(0, 10);
      expect(revertData, "resolveFor must revert at the clone state check").not.toBeNull();
      expect(revertData!.toLowerCase().startsWith(selector)).toBe(true);
    }, 60_000);
  }
});
