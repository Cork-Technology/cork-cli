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
  runTool,
} from "@cork/core";
import { rolloverFactoryAbi } from "../src/rollover-fill.ts";
import { cloneAdmission } from "../src/handlers/rollover-clone-admission.ts";
import { deriveDstFloor, readRolloverTrust } from "../src/handlers/rollover-fill-safety.ts";
import { partialSettlerAccountingAbi, readRollPools, settlerPoolManagerAbi } from "../src/handlers/rollover-ranges.ts";
import { resolveGenerations } from "../src/config-remote.ts";

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

// The rollover-fill safety reads (planning#83) against the deployed contracts: the trust ABIs
// decode, the ERC-7484 check vets a module for its OWN phase only, and every deployed pool-manager
// generation previews deposits and unwinds at exactly 1:1 — the premise of a floor with no
// tolerance. The pool is found through the venue each run (unexpired, unpaused), so no pool id
// in this file can expire under the test.
describe.skipIf(!LIVE)("rollover-fill safety reads — live (both chains)", () => {
  for (const chainId of [42161, 8453] as const) {
    it(`chain ${chainId}: the clone's trust reads decode, and a standard module is vetted for its own phase only`, async () => {
      const { rollover } = await resolveRollover(chainId);
      const client = (await resolveRpc(chainId, undefined))!.client;
      const modules = rollover!.modules!;
      const pull = modules.ownerTokenPull!;
      const post = modules.postRolloverDstCptTransfer!;
      const t = await readRolloverTrust(client, { factory: rollover!.factory as `0x${string}`, clone: KNOWN_CLONE, hooks: { pre: [{ target: pull }], mid: [{ target: pull }], post: [{ target: post }], premium: [] } });
      expect(t.defaults.attesters.length).toBeGreaterThan(0);
      expect(t.defaults.threshold).toBeGreaterThan(0);
      expect(t.changeDelaySeconds).toMatch(/^[0-9]+$/u);
      expect(t.registry).toMatch(/^0x[0-9a-fA-F]{40}$/u);
      expect(t.hooks).toEqual([
        { phase: "pre", index: 0, target: pull, vettedByDefaults: true },
        { phase: "mid", index: 0, target: pull, vettedByDefaults: false },
        { phase: "post", index: 0, target: post, vettedByDefaults: true },
      ]);
      console.log(`chain ${chainId}: defaults [${t.defaults.attesters.join(",")}] threshold ${t.defaults.threshold}; trust-config delay ${t.changeDelaySeconds} s; known clone matches defaults: ${t.cloneMatchesDefaults}; pending: ${JSON.stringify(t.pending)}`);
    }, 90_000);

    it(`chain ${chainId}: every pool manager with a live pool previews 1:1, so the derived floor is exactly 1e18`, async () => {
      const client = (await resolveRpc(chainId, undefined))!.client;
      const env = await runTool("cork_query", { chainId, resource: "cork-pools", pageSize: 200, maxPages: 5 }, {});
      expect(env.state).toBe("ok");
      const soon = new Date(Date.now() + 86_400_000).toISOString();
      type Row = { poolId: `0x${string}`; poolManagerAddress: string; expiry: string; swapToken: { address: string }; isDepositPaused: boolean; isUnwindDepositPaused: boolean; collateralToken: { decimals: number } };
      const rows = ((env.data as { items: Row[] }).items ?? []).filter((r) => r.expiry > soon && !r.isDepositPaused && !r.isUnwindDepositPaused);
      const byManager = new Map<string, Row>();
      for (const r of rows) if (!byManager.has(r.poolManagerAddress.toLowerCase())) byManager.set(r.poolManagerAddress.toLowerCase(), r);
      expect(byManager.size, "no unexpired, unpaused pool on the venue for this chain").toBeGreaterThan(0);
      for (const [pm, r] of byManager) {
        const quantum = 10n ** BigInt(18 - r.collateralToken.decimals);
        const size = quantum * 1_000_003n;
        const cst = r.swapToken.address as `0x${string}`;
        const d = await deriveDstFloor(client, { chainId, srcPoolId: r.poolId, dstPoolId: r.poolId, srcCstToken: cst, dstCstToken: cst, fillerSrcCst: size });
        expect(d, `pool manager ${pm}, pool ${r.poolId}`).toMatchObject({ ok: true, floor: 10n ** 18n, srcBurned: size, quantum, collateralOut: 1_000_003n, expectedDstCst: size });
        const off = await deriveDstFloor(client, { chainId, srcPoolId: r.poolId, dstPoolId: r.poolId, srcCstToken: cst, dstCstToken: cst, fillerSrcCst: size + 1n });
        expect(off.ok ? "ok" : off.gap, `pool manager ${pm}`).toBe(quantum === 1n ? "ok" : "fill-refused");
      }
      console.log(`chain ${chainId}: 1:1 previews verified on ${[...byManager.keys()].join(", ")}`);
    }, 120_000);
  }
});

// The range reads (rollover-ranges.ts) against the deployed settlers: each settler's immutable
// CORK_POOL_MANAGER is the pool manager its configured generation names, the PartialSettler's
// accounting views decode (an unknown digest answers zeros), and readRollPools reads a live pool
// on the settler's own manager.
describe.skipIf(!LIVE)("rollover range reads — live (both chains)", () => {
  for (const chainId of [42161, 8453] as const) {
    it(`chain ${chainId}: every configured settler's pool manager is its generation's; the PartialSettler's accounting decodes`, async () => {
      const { rollover } = await resolveRollover(chainId);
      const { generations } = await resolveGenerations(chainId);
      const client = (await resolveRpc(chainId, undefined))!.client;
      const live = (rollover!.generations ?? []).filter((g) => g.retired === undefined);
      expect(live.length).toBeGreaterThan(0);
      for (const g of live) {
        const pm = generations.find((x) => x.label === g.label)!.phoenix!.poolManager;
        for (const settler of [g.exactSettler, g.partialSettler] as `0x${string}`[]) {
          const onChain = await client.readContract({ address: settler, abi: settlerPoolManagerAbi, functionName: "CORK_POOL_MANAGER" });
          expect(onChain.toLowerCase(), `${g.label} settler ${settler}`).toBe(pm.toLowerCase());
        }
        const unknown = `0x${"5a".repeat(32)}` as const;
        const acc = await client.readContract({ address: g.partialSettler as `0x${string}`, abi: partialSettlerAccountingAbi, functionName: "rolloverAccountingOf", args: [unknown] });
        expect(acc).toEqual({ participantSlotCount: 0, dstCstEscrowed: 0n, srcCstConsumed: 0n });
        const slot = await client.readContract({ address: g.partialSettler as `0x${string}`, abi: partialSettlerAccountingAbi, functionName: "fillerSlotAccountingOf", args: [unknown, g.baseFiller as `0x${string}`, `0x${"00".repeat(12)}${KNOWN_CLONE.slice(2)}`] });
        expect(slot).toMatchObject({ rollover: { dstCstProduced: 0n, srcCstProvided: 0n, filledAt: 0n, premiumFired: false }, settled: false });
      }
    }, 90_000);

    it(`chain ${chainId}: readRollPools reads a live pool from the settler's own pool manager`, async () => {
      const { rollover } = await resolveRollover(chainId);
      const client = (await resolveRpc(chainId, undefined))!.client;
      const settler = rollover!.exactSettler as `0x${string}`;
      const pm = (await client.readContract({ address: settler, abi: settlerPoolManagerAbi, functionName: "CORK_POOL_MANAGER" })).toLowerCase();
      const env = await runTool("cork_query", { chainId, resource: "cork-pools", pageSize: 200, maxPages: 5 }, {});
      type Row = { poolId: `0x${string}`; poolManagerAddress: string; expiry: string; swapToken: { address: string }; collateralToken: { address: string; decimals: number } };
      const soon = new Date(Date.now() + 86_400_000).toISOString();
      const row = ((env.data as { items: Row[] }).items ?? []).find((r) => r.poolManagerAddress.toLowerCase() === pm && r.expiry > soon);
      expect(row, `no unexpired pool on the primary settler's pool manager ${pm}`).toBeDefined();
      const f = await readRollPools(client, { chainId, settler, srcPoolId: row!.poolId, dstPoolId: `0x${"5a".repeat(32)}` });
      expect(f.poolManager.toLowerCase()).toBe(pm);
      expect(f.src.cst.toLowerCase()).toBe(row!.swapToken.address.toLowerCase());
      expect(f.src.collateral?.toLowerCase()).toBe(row!.collateralToken.address.toLowerCase());
      expect(f.src.quantum).toBe(10n ** BigInt(18 - row!.collateralToken.decimals));
      expect(f.src.expiry).toBe(BigInt(Math.floor(Date.parse(row!.expiry) / 1000)));
      expect(f.dst).toBeNull();
    }, 90_000);
  }
});
