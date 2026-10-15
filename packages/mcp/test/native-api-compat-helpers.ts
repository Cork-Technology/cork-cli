import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createCorkServer } from "@cork/mcp";
import { runCli } from "@cork/cli";
import { buildMakerOrder, LOP_ADDRESSES, type HandlerContext, type runTool } from "@cork/core";
import { privateKeyToAccount } from "viem/accounts";
import capture from "../../core/test/fixtures/venue-native-api110-confidence.json";

export { capture };
export const NOW = 1_790_000_000n;
// Public throwaway fixture key, never a funded wallet or external signing operation.
export const maker = privateKeyToAccount(`0x${"0c".repeat(32)}`);
export type Surface = "CLI" | "MCP";
type Envelope = Awaited<ReturnType<typeof runTool>>;
type Call = (tool: "cork_query" | "cork_prepare_orders" | "cork_track", input: Record<string, unknown>) => Promise<{ envelope: Envelope; failed: boolean }>;

export async function withSurface<T>(surface: Surface, context: HandlerContext, run: (call: Call) => Promise<T>): Promise<T> {
  if (surface === "CLI") return run(async (tool, input) => {
    const command = tool === "cork_query" ? ["query"] : tool === "cork_track" ? ["track"] : ["prepare", "orders"];
    const result = await runCli([...command, "--json", JSON.stringify(input)], context);
    return { envelope: JSON.parse(result.stdout || result.stderr) as Envelope, failed: result.code !== 0 };
  });
  const server = createCorkServer(context);
  const client = new Client({ name: "native-api-compat", version: "0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    return await run(async (tool, input) => {
      const result = await client.callTool({ name: tool, arguments: input });
      return { envelope: result.structuredContent as Envelope, failed: result.isError === true };
    });
  } finally {
    await client.close();
    await server.close();
  }
}

export async function signedRow(native: typeof capture.unknown | typeof capture.unavailable, id: string) {
  const built = buildMakerOrder({ chainId: native.chainId, lop: LOP_ADDRESSES[native.chainId]!, maker: maker.address,
    makerAsset: native.makerAsset as `0x${string}`, takerAsset: native.takerAsset as `0x${string}`,
    makingAmount: BigInt(native.makingAmount), takingAmount: BigInt(native.takingAmount), clientRequestId: id,
    allowPartialFills: true, expiry: NOW + 3600n });
  // Preserve captured native accounting/availability, replacing only signed identity/traits.
  return { ...native, ...Object.fromEntries(Object.entries(built.order).map(([key, value]) => [key, typeof value === "bigint" ? value.toString() : value])),
    orderHash: built.orderHash, extension: built.extension, signature: await maker.sign({ hash: built.orderHash }) };
}
