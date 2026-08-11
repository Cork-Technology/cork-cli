// Tiered surface-change gating (owner-approved 2026-08-11): the drift gate used to demand a full
// Layer-B eval run for ANY advertised-surface diff, pricing a typo fix the same as a tool
// redesign — which quietly discourages fixing advertised doc-rot at all. The tier boundary is
// MECHANICAL, never a judgment call ("it's just wording" is precisely how semantic drift ships):
//
//   prose    — every difference is a rewording of an EXISTING description-carrying string
//              (schema `description` values, the tool description, the server `instructions`)
//              that preserves the string's sentence count. Regenerate the fixture; no eval run.
//   semantic — anything else: keys added or removed anywhere, any non-description value changed
//              (names, types, enums, patterns, required, x-units, annotations), a description
//              gaining or losing sentences, arrays changing length. Full workflow: Layer B
//              (held-out included, per the cadence), then regenerate.
//
// Ambiguity FAILS EXPENSIVE by construction: the sentence counter is a mechanical approximation
// (terminal .!? before whitespace/end — abbreviations like "e.g." inflate both sides equally and
// cancel), so an edit near an abbreviation may misread as a sentence-count change. That
// misclassification direction is prose→semantic — an unnecessary eval, never a skipped one.
// The counter-evidence for tiering is real (an "unnecessary" full run once exposed rotted eval
// fixtures), which is why the cheap tier is this narrow.

/** One observed difference between the committed and current surface. */
export interface SurfaceChange {
  /** JSON-pointer-ish path into the surface object. */
  path: string;
  kind:
    | "description-reworded" // prose-eligible
    | "description-resized" // sentence count changed — semantic
    | "value-changed"
    | "key-added"
    | "key-removed"
    | "type-changed"
    | "array-resized";
}

export interface SurfaceTierVerdict {
  /** "none" = surfaces equal; "prose" = fixture regen only; "semantic" = eval-gated. */
  tier: "none" | "prose" | "semantic";
  changes: SurfaceChange[];
}

/** Keys whose string values carry agent-facing prose. Everything else is contract. */
const DESCRIPTION_KEYS = new Set(["description", "instructions"]);

/** Keys DERIVED from compared fields — excluded so they never double-report a prose edit as a
 *  value change (descriptionTokensApprox is chars/4 of the description beside it). */
const DERIVED_KEYS = new Set(["descriptionTokensApprox"]);

/** Mechanical sentence count: runs of terminal punctuation followed by whitespace or
 *  end-of-string. Not a linguist — a symmetric approximation whose errors cancel between the
 *  two sides unless the edit itself touches them (which then fails expensive, by design). */
export function sentenceCount(s: string): number {
  return (s.match(/[.!?]+(?=\s|$)/g) ?? []).length;
}

function walk(before: unknown, after: unknown, path: string, key: string, out: SurfaceChange[]): void {
  if (DERIVED_KEYS.has(key)) return;
  if (before === after) return;
  const tb = before === null ? "null" : Array.isArray(before) ? "array" : typeof before;
  const ta = after === null ? "null" : Array.isArray(after) ? "array" : typeof after;
  if (tb !== ta) {
    out.push({ path, kind: "type-changed" });
    return;
  }
  if (tb === "string") {
    if (DESCRIPTION_KEYS.has(key)) {
      out.push({ path, kind: sentenceCount(before as string) === sentenceCount(after as string) ? "description-reworded" : "description-resized" });
    } else {
      out.push({ path, kind: "value-changed" });
    }
    return;
  }
  if (tb === "array") {
    const b = before as unknown[];
    const a = after as unknown[];
    if (b.length !== a.length) {
      out.push({ path, kind: "array-resized" });
      return;
    }
    for (let i = 0; i < b.length; i++) walk(b[i], a[i], `${path}/${i}`, key, out);
    return;
  }
  if (tb === "object") {
    const b = before as Record<string, unknown>;
    const a = after as Record<string, unknown>;
    for (const k of Object.keys(b)) if (!(k in a)) out.push({ path: `${path}/${k}`, kind: "key-removed" });
    for (const k of Object.keys(a)) if (!(k in b)) out.push({ path: `${path}/${k}`, kind: "key-added" });
    for (const k of Object.keys(b)) if (k in a) walk(b[k], a[k], `${path}/${k}`, k, out);
    return;
  }
  // number | boolean | null with !== — a contract value moved.
  out.push({ path, kind: "value-changed" });
}

/** Classify the delta between the committed surface fixture and the live surface. Pure and
 *  total: never throws on well-formed JSON values. */
export function classifySurfaceDelta(before: unknown, after: unknown): SurfaceTierVerdict {
  const changes: SurfaceChange[] = [];
  walk(before, after, "", "", changes);
  if (changes.length === 0) return { tier: "none", changes };
  const prose = changes.every((c) => c.kind === "description-reworded");
  return { tier: prose ? "prose" : "semantic", changes };
}
