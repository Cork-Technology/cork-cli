// A faithful in-memory model of the 1inch LOP v4 invalidators, for tests that must catch a
// WRONG READ, not just a wrong classification. The earlier stubs answered
// `bitInvalidatorForOrder` the same way whatever argument arrived, so a read of the wrong slot
// (the view takes a NONCE and shifts by 8 itself; the tool passed a pre-shifted slot index and
// read an empty word — found 2026-08-20) passed every test. This fake keeps storage the way
// BitInvalidatorLib/RemainingInvalidatorLib do and answers the views exactly as OrderMixin does.
import { stubResolved } from "./helpers.ts";
import type { HandlerContext } from "../src/handlers/shared.ts";

const lc = (a: string) => a.toLowerCase();

export class FakeLopInvalidators {
  /** BitInvalidatorLib.Data: maker -> slotIndex -> 256-bit word. */
  private readonly bits = new Map<string, Map<bigint, bigint>>();
  /** RemainingInvalidatorLib: maker -> orderHash -> raw word (~remaining; 0 = never touched). */
  private readonly remaining = new Map<string, Map<string, bigint>>();
  /** Every readContract call, for assertions on WHAT was asked. */
  readonly calls: Array<{ functionName: string; args: readonly unknown[] }> = [];

  /** OrderMixin.cancelOrder / _bitInvalidator.checkAndInvalidate for a bit-invalidator order:
   *  set bit (nonce & 0xff) of word (nonce >> 8). */
  spendNonce(maker: `0x${string}`, nonceOrEpoch: bigint): void {
    const slots = this.bits.get(lc(maker)) ?? new Map<bigint, bigint>();
    const slot = nonceOrEpoch >> 8n;
    slots.set(slot, (slots.get(slot) ?? 0n) | (1n << (nonceOrEpoch & 0xffn)));
    this.bits.set(lc(maker), slots);
  }

  /** RemainingInvalidatorLib: store ~remaining (0 remaining = fully filled / cancelled). */
  setRemaining(maker: `0x${string}`, orderHash: `0x${string}`, remaining: bigint): void {
    const rows = this.remaining.get(lc(maker)) ?? new Map<string, bigint>();
    rows.set(lc(orderHash), ((1n << 256n) - 1n) ^ remaining);
    this.remaining.set(lc(maker), rows);
  }

  /** The two views, with the contract's own argument semantics. */
  readContract = async (c: { functionName: string; args?: readonly unknown[] }): Promise<unknown> => {
    const args = c.args ?? [];
    this.calls.push({ functionName: c.functionName, args });
    if (c.functionName === "bitInvalidatorForOrder") {
      // BitInvalidatorLib.checkSlot(nonce): `_raw[nonce >> 8]` — the SHIFT HAPPENS HERE.
      const [maker, nonce] = args as [string, bigint];
      return this.bits.get(lc(maker))?.get(nonce >> 8n) ?? 0n;
    }
    if (c.functionName === "rawRemainingInvalidatorForOrder") {
      const [maker, orderHash] = args as [string, string];
      return this.remaining.get(lc(maker))?.get(lc(orderHash)) ?? 0n;
    }
    throw new Error(`FakeLopInvalidators: no view named ${c.functionName}`);
  };

  /** A resolveRpc hook whose client is this fake (plus eth_getCode answering "no code"). */
  resolveRpc(source: "explicit" | "default" = "explicit"): NonNullable<HandlerContext["resolveRpc"]> {
    return async () =>
      stubResolved(
        {
          readContract: this.readContract,
          getCode: async () => undefined, // viem: an account without code answers undefined
        } as Record<string, (...args: never[]) => unknown>,
        source,
      );
  }
}
