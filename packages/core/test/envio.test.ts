// Envio connection details in one place: the per-product-secret + shared-fallback token rule, the
// two endpoint URL shapes, and the URL redaction that keeps a HyperRPC token out of error text.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { envioToken, hyperSyncUrl, hyperRpcUrl, redactEnvioUrl, redactUrlIn } from "@cork/core";

const VARS = ["ENVIO_HYPERSYNC_TOKEN", "ENVIO_HYPERRPC_TOKEN", "ENVIO_API_TOKEN"] as const;

describe("envioToken — per-product secret with a shared fallback", () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const v of VARS) {
      saved[v] = process.env[v];
      delete process.env[v];
    }
  });
  afterEach(() => {
    for (const v of VARS) {
      if (saved[v] === undefined) delete process.env[v];
      else process.env[v] = saved[v];
    }
  });

  it("uses the product-specific token when set", () => {
    process.env.ENVIO_HYPERSYNC_TOKEN = "hs-tok";
    process.env.ENVIO_HYPERRPC_TOKEN = "rpc-tok";
    expect(envioToken("hypersync")).toBe("hs-tok");
    expect(envioToken("hyperrpc")).toBe("rpc-tok");
  });

  it("falls back to the shared token when the product var is unset", () => {
    process.env.ENVIO_API_TOKEN = "shared";
    expect(envioToken("hypersync")).toBe("shared");
    expect(envioToken("hyperrpc")).toBe("shared");
  });

  it("the product-specific token OUTRANKS the shared fallback, per product independently", () => {
    process.env.ENVIO_API_TOKEN = "shared";
    process.env.ENVIO_HYPERRPC_TOKEN = "rpc-tok";
    expect(envioToken("hyperrpc")).toBe("rpc-tok"); // dedicated wins
    expect(envioToken("hypersync")).toBe("shared"); // no hypersync-specific → shared fallback
  });

  it("returns undefined when neither the product var nor the shared var is set", () => {
    expect(envioToken("hypersync")).toBeUndefined();
    expect(envioToken("hyperrpc")).toBeUndefined();
  });
});

describe("Envio endpoint URLs", () => {
  it("hyperSyncUrl maps known chains and is undefined for chains Envio HyperSync doesn't serve", () => {
    expect(hyperSyncUrl(1)).toBe("https://eth.hypersync.xyz");
    expect(hyperSyncUrl(42161)).toBe("https://arbitrum.hypersync.xyz");
    expect(hyperSyncUrl(8453)).toBe("https://base.hypersync.xyz");
    expect(hyperSyncUrl(999999)).toBeUndefined();
  });
  it("hyperRpcUrl builds the chain-scoped token-in-path form", () => {
    expect(hyperRpcUrl(42161, "tok")).toBe("https://42161.rpc.hypersync.xyz/tok");
    expect(hyperRpcUrl(1, "abc")).toBe("https://1.rpc.hypersync.xyz/abc");
  });
});

describe("redactEnvioUrl / redactUrlIn — a token in the URL never reaches an error message", () => {
  it("strips a token-bearing path to host-only", () => {
    expect(redactEnvioUrl("https://42161.rpc.hypersync.xyz/sk-secret-token")).toBe("https://42161.rpc.hypersync.xyz/<redacted>");
  });
  it("redacts a query string (an override endpoint's ?api-key=)", () => {
    expect(redactEnvioUrl("https://x.example.com/rpc?api-key=SECRET")).toBe("https://x.example.com/<redacted>?<redacted>");
  });
  it("keeps a bare host with no secret path unchanged", () => {
    expect(redactEnvioUrl("https://eth.hypersync.xyz")).toBe("https://eth.hypersync.xyz");
  });
  it("a non-URL string is fully redacted, never echoed", () => {
    expect(redactEnvioUrl("definitely not a url")).toBe("<redacted-url>");
  });
  it("redactUrlIn replaces EVERY occurrence of the raw url with its redacted form", () => {
    const url = "https://42161.rpc.hypersync.xyz/sk-secret-token";
    const out = redactUrlIn(`request to ${url} failed; retried ${url}`, url);
    expect(out).not.toContain("sk-secret-token");
    expect(out).not.toContain(url);
    expect(out).toContain("https://42161.rpc.hypersync.xyz/<redacted>");
  });
});
