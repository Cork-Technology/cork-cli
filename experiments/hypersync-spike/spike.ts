// HyperSync napi client under Bun 1.3: load the module, construct a client, and (when the env
// token is present) stream one settler event range on Arbitrum. Exit 0 = viable under Bun.
import { HypersyncClient, LogField, BlockField } from "@envio-dev/hypersync-client";

const token = process.env.ENVIO_API_TOKEN;
console.log("module loaded OK (napi binding resolved under Bun)");

// client 1.x: a CONSTRUCTOR whose config field is `apiToken` (the 0.x API was `.new({ bearerToken })`).
const client = new HypersyncClient({
  url: "https://arbitrum.hypersync.xyz",
  apiToken: token ?? "",
});
console.log("client constructed OK:", typeof client.get);

if (!token) {
  console.log("no ENVIO_API_TOKEN in env — skipping the live query (tokenless has been rejected since 2025-11)");
  process.exit(0);
}

const res = await client.get({
  fromBlock: 484_973_900,
  logs: [{ address: ["0xbbcc54c637c26b484a8c57b5695c04e09dace13a"] }],
  fieldSelection: { log: [LogField.Address, LogField.Topic0, LogField.BlockNumber], block: [BlockField.Number] },
});
console.log("live query OK: logs", res.data.logs.length, "archiveHeight", res.archiveHeight);
