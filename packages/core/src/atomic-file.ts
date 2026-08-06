// Atomic file replacement for the on-disk caches (RPC resolver state, remote-config cache).
// Multiple processes share ~/.cache/cork-helper-cli/ — the long-lived MCP server plus any number
// of short-lived CLI runs — and a bare writeFileSync can interleave into a torn file a concurrent
// reader then parses as garbage. Write-to-temp-then-rename gives readers old-or-new, never mixed:
// same-directory rename is atomic on POSIX, and the pid-suffixed temp name keeps two processes
// from clobbering each other's staging file. (Corrupt-read handling stays in the readers — both
// caches already reset to a fresh state on unparseable content — this makes the corruption stop
// being producible by us.)
import { renameSync, writeFileSync } from "node:fs";

export function atomicWriteFileSync(path: string, data: string): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}
