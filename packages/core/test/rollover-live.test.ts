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
import { rolloverFactoryAbi } from "../src/rollover-fill.ts";
import { cloneAdmission } from "../src/handlers/rollover-clone-admission.ts";

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

// ── The settler's clone admission, mirrored: rollover-clone-admission.ts against real bytecode ──
// BaseSettler runs two clone checks in order: the NAMED address must be a deployed clone
// (Settler__RolloverContractNotDeployed(user)), then it must be the user's
// (Settler__UserNotRolloverContractOwner(user, rolloverContract)). This leg builds orders that fail
// each check, asks the real settler's resolveFor, and holds the pure mirror — fed facts read live
// with the same views the fill pre-flight reads — to the error the settler actually raised.
// KNOWN_CLONE is a deployed primary-generation clone (CREATE2, the same address on both chains,
// listed on the venue's contracts feed 2026-10-08); clones cannot be undeployed, and its owner is
// READ here, never assumed.
const KNOWN_CLONE = "0x149b46a125284611963c37e238679dd993d8ef41" as const;
const ownerAbi = [{ type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }] as const;

/** The 4-byte selector of the settler's revert from resolveFor, or a diagnostic string. */
type LiveClient = NonNullable<Awaited<ReturnType<typeof resolveRpc>>>["client"];
async function resolveForRevert(client: LiveClient, chainId: 42161 | 8453, settler: `0x${string}`, user: `0x${string}`, rolloverContract: `0x${string}`): Promise<string> {
  const now = BigInt(Math.floor(Date.now() / 1000));
  const built = buildRolloverIntent({
    chainId, user, settler, rolloverContract,
    srcCstToken: "0x9D39A5DE30e57443BfF2A8307A4256c8797A3497", dstCstToken: "0x53E82ABbb12638F09d9e624578ccB666217a765e", premiumToken: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    srcPoolId: `0x${"11".repeat(32)}`, dstPoolId: `0x${"22".repeat(32)}`, orderSize: 250n * 10n ** 18n, minPremiumPerShare: 12n * 10n ** 15n,
    openDeadline: now + 3_600n, fillDeadline: now + 86_400n, clientRequestId: `live-clone-admission-${user}-${rolloverContract}`,
  });
  const data = encodeFunctionData({
    abi: resolveForAbi,
    functionName: "resolveFor",
    args: [{ originSettler: settler, user, nonce: built.order.orderSalt, originChainId: BigInt(chainId), openDeadline: Number(built.order.openDeadline), fillDeadline: Number(built.order.fillDeadline), orderDataType: ORDER_DATA_TYPEHASH, orderData: encodeOrderData(built.order) }, "0x"],
  });
  try {
    await client.call({ to: settler, data });
    return "<did not revert>";
  } catch (err) {
    for (let e: unknown = err; e; e = (e as { cause?: unknown }).cause) {
      const d = (e as { data?: unknown }).data;
      if (typeof d === "string" && d.startsWith("0x") && d.length >= 10) return d.slice(0, 10).toLowerCase();
      if (typeof d === "object" && d !== null && typeof (d as { data?: unknown }).data === "string") return (d as { data: string }).data.slice(0, 10).toLowerCase();
    }
    return `<no data: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}>`;
  }
}
const selectorOf = (sig: string) => keccak256(stringToBytes(sig)).slice(0, 10);
const SETTLER_ERRORS = {
  Settler__RolloverContractNotDeployed: selectorOf("Settler__RolloverContractNotDeployed(address)"),
  Settler__UserNotRolloverContractOwner: selectorOf("Settler__UserNotRolloverContractOwner(address,address)"),
} as const;

describe.skipIf(!LIVE)("the settler's clone admission, mirrored — live (both chains)", () => {
  for (const chainId of [42161, 8453] as const) {
    it(`chain ${chainId}: each clone fault reverts the error cloneAdmission names, in the settler's order`, async () => {
      const { rollover } = await resolveRollover(chainId);
      const client = (await resolveRpc(chainId, undefined))!.client;
      const factory = rollover!.factory as `0x${string}`;
      const settler = rollover!.exactSettler as `0x${string}`;
      const STRANGER_USER = "0xC0FFEe0000000000000000000000000000000001" as const; // owns no clone
      const NOT_A_CLONE = "0x00000000000000000000000000000000000000de" as const;
      const facts = async (user: `0x${string}`, named: `0x${string}`) => {
        const [deployed, predicted, holderClone] = await Promise.all([
          client.readContract({ address: factory, abi: rolloverFactoryAbi, functionName: "isDeployedRolloverContract", args: [named] }),
          client.readContract({ address: factory, abi: rolloverFactoryAbi, functionName: "predictRolloverContractOf", args: [user] }),
          client.readContract({ address: factory, abi: rolloverFactoryAbi, functionName: "rolloverContractOf", args: [user] }),
        ]);
        const owner = deployed ? await client.readContract({ address: named, abi: ownerAbi, functionName: "owner" }) : null;
        return { user, named, deployed, owner, predicted, holderClone };
      };
      const cloneOwner = await client.readContract({ address: KNOWN_CLONE, abi: ownerAbi, functionName: "owner" });
      expect(cloneOwner.toLowerCase()).not.toBe(STRANGER_USER.toLowerCase());

      const cases: Array<[string, `0x${string}`, `0x${string}`]> = [
        ["check 1, the user's own predicted address (not deployed)", STRANGER_USER, (await facts(STRANGER_USER, NOT_A_CLONE)).predicted],
        ["check 1, an address that is no clone", STRANGER_USER, NOT_A_CLONE],
        ["check 2, someone else's deployed clone", STRANGER_USER, KNOWN_CLONE],
      ];
      for (const [label, user, named] of cases) {
        const verdict = cloneAdmission(await facts(user, named), "live");
        expect(verdict.ok, label).toBe(false);
        if (verdict.ok) continue;
        expect(await resolveForRevert(client, chainId, settler, user, named), label).toBe(SETTLER_ERRORS[verdict.settlerError]);
      }
      // The clone's own owner passes both checks: resolveFor no longer stops at the clone (it may
      // revert later, on the fake pools, but never with either clone error).
      const own = await resolveForRevert(client, chainId, settler, cloneOwner, KNOWN_CLONE);
      expect(Object.values(SETTLER_ERRORS)).not.toContain(own);
      expect(cloneAdmission(await facts(cloneOwner, KNOWN_CLONE), "live")).toEqual({ ok: true });
    }, 90_000);
  }
});
