// @cork/core/config — deployment identity and trust: the committed cork-defaults config with
// remote-first resolution, the GENERATION model (a chain hosts a set of contract generations,
// one primary; wires per block; address classification; pool-scoped generation resolution),
// CREATE2 attestation verification, the approved-implementations allowlist guard, TEE
// (Phala/TDX) attestation replay for hosted deployments, and build/version identity.
export * from "../config.ts";
export * from "../config-override.ts";
export * from "../config-remote.ts";
export * from "../generations.ts";
export * from "../implementations.ts";
export * from "../phala-attest.ts";
export * from "../version.ts";
