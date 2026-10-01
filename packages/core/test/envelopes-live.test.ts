// LIVE (CORK_RPC_LIVE=1): the wallet-infrastructure singletons envelopes.ts may call `trusted`
// must hold byte-identical code on every chain this tool serves — that identity is the ONLY
// ground for trusting a chain-independent address. Re-read here, so a redeploy, a proxy
// upgrade or a chain that received different code (EntryPoint v0.8 did, 2026-10-01) fails loudly
// instead of being trusted from a stale table.
import { describe, expect, it } from "vitest";
import { keccak256 } from "viem";
import { ENVELOPE_SINGLETONS, resolveRpc } from "@cork/core";

const LIVE = process.env["CORK_RPC_LIVE"] === "1";
const CHAINS = [1, 42161, 8453] as const;

describe.skipIf(!LIVE)("envelope singletons — code identity across chains", () => {
  it("every byteVerified singleton holds the same non-empty code on mainnet, Arbitrum and Base; every non-verified one differs somewhere or is absent", async () => {
    const clients = await Promise.all(CHAINS.map((c) => resolveRpc(c, undefined)));
    for (const s of ENVELOPE_SINGLETONS) {
      const hashes = await Promise.all(clients.map(async (r) => {
        const code = await r!.client.getCode({ address: s.address });
        return code && code !== "0x" ? keccak256(code) : null;
      }));
      const identical = hashes.every((h) => h !== null && h === hashes[0]);
      expect(identical, `${s.label} ${s.address}: ${hashes.map((h, i) => `${CHAINS[i]}=${h?.slice(0, 10) ?? "none"}`).join(" ")}`).toBe(s.byteVerified);
    }
  }, 60_000);
});
