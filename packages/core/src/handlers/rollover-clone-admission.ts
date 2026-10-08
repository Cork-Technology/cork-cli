// The settler's admission rule for the clone a rollover order names, mirrored (INTERNAL).
//
// BaseSettler (rollover 0.2.0) runs two checks, in this order, before a fill can open the order:
//   1. factory.isDeployedRolloverContract(order.rolloverContract) is false
//        → Settler__RolloverContractNotDeployed(user)
//   2. otherwise clone.owner() != order.user
//        → Settler__UserNotRolloverContractOwner(user, rolloverContract)
// The rule keys on the address the ORDER NAMES, not on the holder's own clone: an order can name
// someone else's deployed clone while the holder has none (check 2 fires), or an address that is
// no clone at all while the holder has one elsewhere (check 1 fires). Verified live on Base
// 2026-10-08: isDeployedRolloverContract is true for venue-listed clones and false for a non-clone,
// owner() returns the holder, and predictRolloverContractOf(owner) equals the deployed clone.
//
// Who can fix it differs. When the order names the address the factory WILL deploy for the holder
// (predictRolloverContractOf(user)), the holder sends deploy-rollover-contract and the SAME signed
// order fills. In every other case no deployment helps: the holder signs a new order naming their
// clone. The filler can fix none of these, so the fill prepare refuses with the holder's next step.

import { isAddressEqual, zeroAddress } from "viem";

type Address = `0x${string}`;

/** The one clone view the settler's ownership check reads. */
export const rolloverCloneAbi = [{ type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }] as const;

/** What the chain says about the clone an order names, read at one block. */
export interface CloneFacts {
  /** order.user — the cPT holder who signed. */
  user: Address;
  /** order.rolloverContract — the clone the order names. */
  named: Address;
  /** factory.isDeployedRolloverContract(named). */
  deployed: boolean;
  /** clone.owner() of `named`; null when `named` is not deployed (the read would revert). */
  owner: Address | null;
  /** factory.predictRolloverContractOf(user) — where the holder's clone is or will be. */
  predicted: Address;
  /** factory.rolloverContractOf(user) — the holder's deployed clone, zeroAddress when none. */
  holderClone: Address;
}

export type CloneAdmission =
  | { ok: true }
  | {
      ok: false;
      settlerError: "Settler__RolloverContractNotDeployed" | "Settler__UserNotRolloverContractOwner";
      /** holder-deploys-clone: the same signed order fills after the holder deploys.
       *  holder-signs-new-order: the order can never fill; the holder must re-sign. */
      fix: "holder-deploys-clone" | "holder-signs-new-order";
      message: string;
    };

/** The settler's two clone checks, in the settler's order. */
export function cloneAdmission(f: CloneFacts, factoryLabel: string): CloneAdmission {
  const holderHasClone = !isAddressEqual(f.holderClone, zeroAddress);
  const theirClone = holderHasClone ? `their clone ${f.holderClone}` : `${f.predicted} (their clone's address once they send deploy-rollover-contract)`;
  const notDeployed = !f.deployed;
  const notOwner = f.owner === null || !isAddressEqual(f.owner, f.user);
  if (notDeployed) {
    if (isAddressEqual(f.named, f.predicted)) {
      return {
        ok: false,
        settlerError: "Settler__RolloverContractNotDeployed",
        fix: "holder-deploys-clone",
        message: `the order names ${f.named}, the address the ${factoryLabel} factory deploys for its holder ${f.user}, but the holder has not deployed it yet — the fill reverts Settler__RolloverContractNotDeployed(${f.user}). Only the holder can fix this: they send cork_prepare_orders deploy-rollover-contract from their own account (the factory deploys for msg.sender). The same signed order then fills; prepare the fill again.`,
      };
    }
    return {
      ok: false,
      settlerError: "Settler__RolloverContractNotDeployed",
      fix: "holder-signs-new-order",
      message: `the order names ${f.named}, which is no clone on the ${factoryLabel} factory and not the address it deploys for the holder ${f.user} — the fill reverts Settler__RolloverContractNotDeployed(${f.user}), and no deployment can change that. The holder must sign a new order naming ${theirClone}.`,
    };
  }
  if (notOwner) {
    return {
      ok: false,
      settlerError: "Settler__UserNotRolloverContractOwner",
      fix: "holder-signs-new-order",
      message: `the order names ${f.named}, a clone owned by ${f.owner ?? "an unreadable owner"}, not by the holder ${f.user} — the fill reverts Settler__UserNotRolloverContractOwner(${f.user}, ${f.named}). The holder must sign a new order naming ${theirClone}.`,
    };
  }
  return { ok: true };
}
