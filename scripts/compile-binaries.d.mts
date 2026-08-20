// Declarations for the release-test import (packages/cli/test/release.test.ts locks the asset
// naming between the compile script and self-update).
export function assetForTarget(target: string): string | null;
/** The Envio platform-package `.node` specifier a compiled target embeds; null where Envio ships none. */
export function hyperSyncBindingForTarget(target: string): string | null;
/** The `--define` argument pairs a target is compiled with (build identity + the embedded binding). */
export function compileDefines(opts: { version: string; commit: string; target: string }): string[];
