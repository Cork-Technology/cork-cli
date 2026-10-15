import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { baselineOk, verdictOf, type VitestJsonReport } from "./mutation-verdict.ts";

it("finishes both isolated files with one fork worker and reports a real assertion failure", () => {
  const root = mkdtempSync(join(tmpdir(), "cork-mutation-vitest-"));
  const entry = fileURLToPath(new URL("./mutation-vitest.ts", import.meta.url));
  const vitest = fileURLToPath(new URL("../node_modules/vitest/dist/index.js", import.meta.url));
  try {
    writeFileSync(join(root, "vitest.config.mjs"), 'export default {test:{include:["*.test.mjs"],maxWorkers:1,minWorkers:1,deps:{interopDefault:false}}};');
    const source = (name: string, expected: number) =>
      `import {it,expect} from ${JSON.stringify(vitest)}; it(${JSON.stringify(name)},()=>expect(2+3).toBe(${expected}));`;
    writeFileSync(join(root, "first.test.mjs"), source("first isolated file", 5));
    for (const expected of [5, 4]) {
      writeFileSync(join(root, "second.test.mjs"), source("second isolated file", expected));
      const output = join(root, `report-${expected}.json`);
      const child = spawnSync("bun", [entry, output, "first.test.mjs", "second.test.mjs"], {
        cwd: root, encoding: "utf8", timeout: 30_000,
      });
      expect(child.error, child.stderr).toBeUndefined();
      expect(child.status, child.stderr).toBe(expected === 5 ? 0 : 1);
      const report = JSON.parse(readFileSync(output, "utf8")) as VitestJsonReport;
      expect(report.numTotalTests).toBe(2);
      expect(report.numFailedTests).toBe(expected === 5 ? 0 : 1);
      expect(report.testResults?.map((result) => result.name.split("/").at(-1)).sort()).toEqual(["first.test.mjs", "second.test.mjs"]);
      expect(baselineOk(report, child.status!).ok).toBe(expected === 5);
      expect(verdictOf(report, child.status!, "fixture").verdict).toBe(expected === 5 ? "survived" : "caught");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 70_000);
