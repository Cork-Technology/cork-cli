// Terminal styling for the CLI's human-readable output: SGR (Select Graphic Rendition) escape
// sequences plus the Unicode glyphs the renderers share.
//
// ZERO dependencies, deliberately. A color library (chalk, picocolors, kleur…) would be the
// classic supply-chain foothold — a transitively-trusted package touching every byte the CLI
// prints — for functionality that is ~40 lines of constants. Everything here is plain string
// concatenation; nothing reads the filesystem, network, or process state.
//
// Styling is decided ONCE per stream (colorEnabled) and carried as a Style value; the renderers
// stay pure functions and tests exercise both sides of the switch. Two invariants the tests pin:
//   1. Stripping SGR sequences from styled output yields the unstyled output byte-for-byte —
//      styling never moves, adds, or hides a character, so wrapping and column alignment are
//      computed on plain text and remain correct.
//   2. JSON output (--json / CORK_JSON=1) NEVER carries an escape sequence — machines get the
//      wire format untouched no matter what FORCE_COLOR says.
//
// Glyphs are unconditional (no ASCII fallback): the renderers already speak Unicode
// (`·`, `▸`, `→` predate this file), so a UTF-8 terminal is an established requirement of the
// prose surface — JSON remains the escape hatch for anything that cannot render it.

/** Shared glyph vocabulary — one constant so the state badge, warning rows, and error headers
 *  never drift apart. */
export const GLYPH = {
  ok: "✔",
  warn: "⚠",
  fail: "✖",
  item: "▸",
  sep: "·",
  suggest: "→",
} as const;

export interface Style {
  /** Whether this style emits escape sequences at all — lets callers branch cheaply. */
  readonly enabled: boolean;
  bold(s: string): string;
  dim(s: string): string;
  red(s: string): string;
  green(s: string): string;
  yellow(s: string): string;
  cyan(s: string): string;
}

/**
 * Should `stream` get SGR sequences? The conventional resolution ladder:
 *
 *   1. FORCE_COLOR — explicit user intent, strongest (the supports-color convention):
 *      "0"/"false" disables, any other set value enables, TTY or not (CI logs, pagers).
 *   2. NO_COLOR — any non-empty value disables (https://no-color.org).
 *   3. TERM=dumb — a terminal that declared it cannot render SGR.
 *   4. Otherwise: color iff the stream is a TTY. A pipe or a test harness gets plain text,
 *      so scripts scraping prose (already discouraged — that is what --json is for) never
 *      meet an escape sequence by surprise.
 */
export function colorEnabled(env: Record<string, string | undefined>, isTTY: boolean): boolean {
  const force = env["FORCE_COLOR"];
  if (force !== undefined) return force !== "0" && force !== "false";
  const no = env["NO_COLOR"];
  if (no !== undefined && no !== "") return false;
  if (env["TERM"] === "dumb") return false;
  return isTTY;
}

// Attribute-scoped close codes (39 = default foreground, 22 = normal intensity) rather than the
// blanket reset \x1b[0m, so nested styles compose: bold(cyan(x)) closes the color without
// killing the bold.
const SGR: Record<Exclude<keyof Style, "enabled">, readonly [number, number]> = {
  bold: [1, 22],
  dim: [2, 22],
  red: [31, 39],
  green: [32, 39],
  yellow: [33, 39],
  cyan: [36, 39],
};

function code(open: number, close: number): (s: string) => string {
  return (s) => `\u001b[${open}m${s}\u001b[${close}m`;
}

const identity = (s: string): string => s;

/** Build a Style: real SGR wrappers when enabled, identity passthroughs when not — callers
 *  style unconditionally and the switch lives here. */
export function makeStyle(enabled: boolean): Style {
  if (!enabled) return PLAIN;
  return {
    enabled: true,
    bold: code(...SGR.bold),
    dim: code(...SGR.dim),
    red: code(...SGR.red),
    green: code(...SGR.green),
    yellow: code(...SGR.yellow),
    cyan: code(...SGR.cyan),
  };
}

/** The no-op style — the default parameter of every renderer, so they stay drop-in pure
 *  functions for tests and embedders that never think about terminals. */
export const PLAIN: Style = {
  enabled: false,
  bold: identity,
  dim: identity,
  red: identity,
  green: identity,
  yellow: identity,
  cyan: identity,
};
