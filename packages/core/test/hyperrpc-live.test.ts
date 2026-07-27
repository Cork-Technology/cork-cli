// Live smoke for HyperRPC auth. Self-skips unless an Envio token is in the env, so CI stays
// offline/deterministic. Proves the thing we changed: resolveLogsEndpoint returns a bare host +
// a bearer token (token NOT in the URL), and that token authenticates via the Authorization
// header (a real 200 eth_chainId). This is the check that would have caught a broken auth wire.
import { describe, expect, it } from "vitest";
import { resolveLogsEndpoint } from "@cork/core";

const TOKEN = process.env.ENVIO_HYPERRPC_TOKEN ?? process.env.ENVIO_API_TOKEN;

describe.skipIf(!TOKEN)("HyperRPC — live Bearer-header auth (token never in the URL)", () => {
  it("chain 1: resolveLogsEndpoint gives bare host + bearer, and the header authenticates (eth_chainId=0x1)", async () => {
    const ep = resolveLogsEndpoint(1);
    expect(ep).not.toBeNull();
    expect(ep!.url).toBe("https://1.rpc.hypersync.xyz"); // no secret in the URL
    expect(ep!.bearerToken).toBeTruthy();

    const res = await fetch(ep!.url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${ep!.bearerToken}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result?: string; error?: unknown };
    expect(body.error).toBeUndefined();
    expect(body.result).toBe("0x1");
  }, 30_000);

  it("chain 42161: the same bearer token authenticates (eth_chainId=0xa4b1)", async () => {
    const ep = resolveLogsEndpoint(42161);
    const res = await fetch(ep!.url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${ep!.bearerToken}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result?: string };
    expect(body.result).toBe("0xa4b1");
  }, 30_000);
});
