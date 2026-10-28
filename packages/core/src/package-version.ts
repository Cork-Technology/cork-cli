// The published @cork/core version, for an npm consumer whose build carries no CH_BUILD_VERSION
// (version.ts). Undefined in the source tree and in the compiled `ch` binary (which is stamped
// with its release version instead); scripts/build-packages.mjs overwrites the EMITTED
// dist/…/package-version.js with packages/core/package.json's "version".
export const PACKAGE_VERSION: string | undefined = undefined;
