// SGR styling contract for the prose renderers (ansi.ts + the style threading through
// render.ts/explain.ts/app.ts). Two load-bearing invariants:
//
//   1. strip(styled) === plain — styling only wraps existing characters in escape sequences;
//      it never adds, removes, or moves a visible character, so wrapping/alignment (computed
//      on plain text) stay correct and NO_COLOR users lose nothing but the color.
//   2. JSON output NEVER carries an escape sequence, whatever FORCE_COLOR says — the wire
//      format is for machines and stays byte-exact.
import { describe, expect, it } from "vitest";
import { EXIT, runCli } from "@cork/cli";
import { colorEnabled, GLYPH, makeStyle, PLAIN } from "../src/ansi.ts";

const NOW = 1_800_000_000n;
const ESC = "\u001b[";

function strip(s: string): string {
  return s.replace(/\u001b\[[0-9;]*m/g, "");
}

describe("colorEnabled ladder", () => {
  it("defaults to the stream's TTY-ness", () => {
    expect(colorEnabled({}, true)).toBe(true);
    expect(colorEnabled({}, false)).toBe(false);
  });

  it("NO_COLOR (any non-empty value) disables, even on a TTY", () => {
    expect(colorEnabled({ NO_COLOR: "1" }, true)).toBe(false);
    expect(colorEnabled({ NO_COLOR: "anything" }, true)).toBe(false);
    // The spec keys on presence of a non-empty value; empty string is "unset".
    expect(colorEnabled({ NO_COLOR: "" }, true)).toBe(true);
  });

  it("FORCE_COLOR is the strongest word: enables off-TTY, and its 0/false disable beats a TTY", () => {
    expect(colorEnabled({ FORCE_COLOR: "1" }, false)).toBe(true);
    expect(colorEnabled({ FORCE_COLOR: "1", NO_COLOR: "1" }, false)).toBe(true);
    expect(colorEnabled({ FORCE_COLOR: "0" }, true)).toBe(false);
    expect(colorEnabled({ FORCE_COLOR: "false" }, true)).toBe(false);
  });

  it("TERM=dumb disables on a TTY", () => {
    expect(colorEnabled({ TERM: "dumb" }, true)).toBe(false);
    expect(colorEnabled({ TERM: "xterm-256color" }, true)).toBe(true);
  });
});

describe("makeStyle", () => {
  it("enabled style emits attribute-scoped SGR; disabled is identity (and IS the PLAIN singleton)", () => {
    const s = makeStyle(true);
    expect(s.green("OK")).toBe(`${ESC}32mOK${ESC}39m`);
    expect(s.bold("x")).toBe(`${ESC}1mx${ESC}22m`);
    expect(makeStyle(false)).toBe(PLAIN);
    expect(PLAIN.red("x")).toBe("x");
  });

  it("nesting composes without a blanket reset killing the outer attribute", () => {
    const s = makeStyle(true);
    // bold(cyan(x)) — the inner close (39, default foreground) must not close the bold (22).
    expect(s.bold(s.cyan("x"))).toBe(`${ESC}1m${ESC}36mx${ESC}39m${ESC}22m`);
  });
});

describe("styled CLI output", () => {
  it("prose result: styled output strips back to the plain output byte-for-byte", async () => {
    const plain = await runCli(["query", "protocol-config"], { nowSeconds: NOW });
    const styled = await runCli(["query", "protocol-config"], { nowSeconds: NOW }, { FORCE_COLOR: "1" });
    expect(styled.stdout).toContain(ESC);
    expect(strip(styled.stdout)).toBe(plain.stdout);
    // The state badge leads with the glyph in BOTH modes — glyphs are content, not styling.
    expect(plain.stdout).toContain(`${GLYPH.ok} OK`);
  });

  it("prose error: styled stderr strips back to plain, and still names the code", async () => {
    const plain = await runCli(["compute", "--input", "{not json"], { nowSeconds: NOW });
    const styled = await runCli(["compute", "--input", "{not json"], { nowSeconds: NOW }, { FORCE_COLOR: "1" });
    expect(plain.code).toBe(EXIT.invalid);
    expect(styled.stderr).toContain(ESC);
    expect(strip(styled.stderr)).toBe(plain.stderr);
    expect(strip(styled.stderr)).toContain(`${GLYPH.fail} ERROR`);
  });

  it("--explain: styled contract strips back to plain", async () => {
    const plain = await runCli(["compute", "--explain"], { nowSeconds: NOW });
    const styled = await runCli(["compute", "--explain"], { nowSeconds: NOW }, { FORCE_COLOR: "1" });
    expect(styled.stdout).toContain(ESC);
    expect(strip(styled.stdout)).toBe(plain.stdout);
    // The pinned plain header survives untouched.
    expect(plain.stdout).toContain("cork_compute  ·  ch compute  ·  phase 1");
  });

  it("warnings row leads with the warning glyph and keeps the code greppable", async () => {
    // Offline-deterministic: cork-pool without filters.poolId → unavailable + missing_filter.
    const r = await runCli(["query", "cork-pool", "--chain-id", "1"], { nowSeconds: NOW });
    expect(r.stdout).toContain(`${GLYPH.warn} missing_filter`);
  });

  it("JSON output NEVER carries escape sequences, even under FORCE_COLOR", async () => {
    const viaFlag = await runCli(["query", "protocol-config", "--json"], { nowSeconds: NOW }, { FORCE_COLOR: "1" });
    expect(viaFlag.stdout).not.toContain("\u001b");
    expect(() => JSON.parse(viaFlag.stdout)).not.toThrow();
    const viaEnv = await runCli(["query", "protocol-config"], { nowSeconds: NOW }, { FORCE_COLOR: "1", CORK_JSON: "1" });
    expect(viaEnv.stdout).not.toContain("\u001b");
    const errJson = await runCli(["compute", "--json", "{not json"], { nowSeconds: NOW }, { FORCE_COLOR: "1", CORK_JSON: "1" });
    expect(errJson.stderr).not.toContain("\u001b");
    expect(() => JSON.parse(errJson.stderr)).not.toThrow();
  });

  it("default runCli (no env, no io) stays plain — pipes and tests never meet an escape", async () => {
    const r = await runCli(["query", "protocol-config"], { nowSeconds: NOW });
    expect(r.stdout).not.toContain("\u001b");
  });

  it("TTY-ness is honored per stream via the io parameter", async () => {
    const r = await runCli(["query", "protocol-config"], { nowSeconds: NOW }, {}, { stdoutIsTTY: true });
    expect(r.stdout).toContain(ESC);
    const e = await runCli(["compute", "--input", "{not json"], { nowSeconds: NOW }, {}, { stdoutIsTTY: true, stderrIsTTY: false });
    expect(e.stderr).not.toContain("\u001b"); // stderr not a TTY → error prose stays plain
    // NO_COLOR beats a TTY end-to-end.
    const n = await runCli(["query", "protocol-config"], { nowSeconds: NOW }, { NO_COLOR: "1" }, { stdoutIsTTY: true });
    expect(n.stdout).not.toContain("\u001b");
  });
});
