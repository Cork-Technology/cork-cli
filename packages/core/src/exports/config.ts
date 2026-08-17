// @cork/core/config — deployment identity and trust: the committed cork-defaults config with
// remote-first resolution, CREATE2 attestation verification, the approved-implementations
// allowlist guard, TEE (Phala/TDX) attestation replay for hosted deployments, and build/version
// identity.
export * from "../config.ts";
export * from "../config-remote.ts";
export * from "../implementations.ts";
export * from "../phala-attest.ts";
export * from "../version.ts";
