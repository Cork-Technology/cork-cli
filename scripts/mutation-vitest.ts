// Keep Bun alive across fork-worker turnover and the asynchronous JSON reporter flush.
// Vitest's CLI starts this promise without awaiting it; Bun can exit 0 between files.
import { startVitest } from "vitest/node";

const [outputFile, ...files] = process.argv.slice(2);
if (!outputFile || files.length === 0) throw new Error("Expected report path and test files");
const ctx = await startVitest("test", files, {
  run: true,
  watch: false,
  reporters: ["json"],
  outputFile,
});
await ctx?.close();
