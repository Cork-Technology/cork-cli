// Envio connection details in one place. Envio ships TWO products with TWO secrets and ONE shared
// fallback, and the auth/endpoint rules for both were previously hand-inlined at their call sites
// (the `<specific> ?? shared` fallback written twice, the HyperRPC URL built inline). This module
// is the single owner of "how do we reach Envio and authenticate to it", so the two products can
// never drift apart and a token can never be pasted into a log verbatim.
//
//   HyperSync  — bulk historical event scans via the @envio-dev/hypersync-client napi client.
//                Endpoint: https://<chain>.hypersync.xyz, token as a BEARER header.
//   HyperRPC   — an eth_getLogs JSON-RPC endpoint. Endpoint: https://<chainId>.rpc.hypersync.xyz,
//                token in the URL PATH (so it must be redacted out of any surfaced error).

/** The two Envio products, each with its own dedicated token env var. */
export type EnvioProduct = "hypersync" | "hyperrpc";

const PRODUCT_ENV_VAR: Record<EnvioProduct, string> = {
  hypersync: "ENVIO_HYPERSYNC_TOKEN",
  hyperrpc: "ENVIO_HYPERRPC_TOKEN",
};

/**
 * Resolve an Envio API token: the product-specific var wins, `ENVIO_API_TOKEN` is the shared
 * fallback for both (the tokens are interchangeable across products in practice). One definition
 * of this rule, used by both the HyperSync client loader and the HyperRPC endpoint resolver.
 */
export function envioToken(product: EnvioProduct): string | undefined {
  return process.env[PRODUCT_ENV_VAR[product]] ?? process.env.ENVIO_API_TOKEN;
}

/** HyperSync bulk-scan endpoints per chain (token required since 2025-11-03, sent as a header). */
export const HYPERSYNC_URLS: Record<number, string> = {
  1: "https://eth.hypersync.xyz",
  42161: "https://arbitrum.hypersync.xyz",
  8453: "https://base.hypersync.xyz",
  11155111: "https://sepolia.hypersync.xyz",
};

/** HyperSync endpoint for a chain, or undefined when Envio has no HyperSync for it. */
export function hyperSyncUrl(chainId: number): string | undefined {
  return HYPERSYNC_URLS[chainId];
}

/** HyperRPC eth_getLogs host. The token is sent as an `Authorization: Bearer` header — the same
 *  mechanism HyperSync uses — NOT in the URL path, so nothing secret rides in the URL. (Envio only
 *  documents the path form, but the header is empirically supported and confirmed with a live
 *  token on chains 1 and 42161; keeping the secret out of the URL removes the leak class entirely.) */
export function hyperRpcHost(chainId: number): string {
  return `https://${chainId}.rpc.hypersync.xyz`;
}

/**
 * Host-safe form of a logs/RPC URL for error messages: keeps scheme + host, drops the path and
 * query where a secret (HyperRPC token, or an override endpoint's API key) would live. The token
 * is never separated from the URL by callers, so redaction is by structure, not by known value.
 */
export function redactEnvioUrl(url: string): string {
  try {
    const u = new URL(url);
    const hasPath = u.pathname !== "" && u.pathname !== "/";
    return `${u.protocol}//${u.host}${hasPath ? "/<redacted>" : ""}${u.search ? "?<redacted>" : ""}`;
  } catch {
    return "<redacted-url>";
  }
}

/** Replace every occurrence of `url` in a message with its redacted form (transport errors from
 *  fetch/undici often echo the full request URL, token and all). */
export function redactUrlIn(message: string, url: string): string {
  return message.split(url).join(redactEnvioUrl(url));
}
