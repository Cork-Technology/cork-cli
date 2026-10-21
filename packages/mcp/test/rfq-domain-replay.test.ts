import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createCorkServer } from "@cork/mcp";
import { runCli } from "@cork/cli";
import { hashTypedData, keccak256, stringToBytes, verifyTypedData } from "viem";
import type { Hex, TypedDataDefinition } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { encryptKeystore, writeKeystore } from "../../cli/src/keystore.ts";

const key = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const writer = privateKeyToAccount(key);
const now = 1800000000;
const input = { chainId: 8453, account: writer.address, clientRequestId: "venue-isolation-0001", action: { type: "rfq-write", request: { type: "rfq-open", kind: "new_position", requester: writer.address, referenceAsset: writer.address, collateralAsset: { exact: writer.address }, modes: ["liquidity_only"], packageIds: ["pkg-1"], expiryWindow: { notBefore: now + 3600, notAfter: now + 7200 }, notionalAssets: "1000", validUntil: now + 3600 } } };

async function prepare(venueUrl: string) {
  const server = createCorkServer({ venueUrl, nowSeconds: BigInt(now), resolveRpc: async () => null });
  const client = new Client({ name: "offline-rfq-isolation", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([client.connect(a), server.connect(b)]);
    const result = await client.callTool({ name: "cork_prepare_orders", arguments: input });
    const structured = result.structuredContent as { state: string; data: { typedData: TypedDataDefinition; digest: Hex } };
    expect(structured.state).toBe("ok");
    const text = result.content as Array<{ type: string; text: string }>;
    expect(JSON.parse(text[0]!.text).data.typedData.domain).toEqual(structured.data.typedData.domain);
    return structured;
  } finally { await client.close(); await server.close(); }
}

describe("RFQ venue domain through real MCP and wallet projections", () => {
  it("wallet signs the complete MCP-returned salted domain, not an unbound or other venue proof", async () => {
    const staging = await prepare("https://breaking.cork.tech");
    const prod = await prepare("https://api-phoenix.cork.tech");
    const td = staging.data.typedData;
    expect(td.domain?.salt).toBe(keccak256(stringToBytes("https://breaking.cork.tech")));
    expect(staging.data.digest).toBe(hashTypedData(td));
    const root = mkdtempSync(join(tmpdir(), "rfq-venue-wallet-"));
    const env = { CORK_KEYSTORE_DIR: join(root, "keystores") };
    const password = "offline fixture only";
    const shown: string[] = [];
    try {
      writeKeystore("fixture", encryptKeystore(Buffer.from(key.slice(2), "hex"), password, { n: 1024, r: 8, p: 1 }), env);
      const signed = await runCli(["sign", "--account", "fixture", "--json"], {}, env, { readStdin: async () => JSON.stringify(staging), prompter: { secret: async () => password, confirm: async () => true, say: (text) => { shown.push(text); } } });
      expect(signed.code, signed.stderr).toBe(0);
      const signedResult: { signature: Hex } = JSON.parse(signed.stdout);
      const signature = signedResult.signature;
      expect(await verifyTypedData({ ...td, address: writer.address, signature })).toBe(true);
      expect(await verifyTypedData({ ...prod.data.typedData, address: writer.address, signature })).toBe(false);
      const { salt: _salt, ...legacy } = td.domain!;
      expect(await verifyTypedData({ ...td, domain: legacy, address: writer.address, signature })).toBe(false);
      expect(shown.join("\n")).toContain(td.domain!.salt!);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
