// The local configuration OVERRIDE — `config.json` (2026-09-25 owner ruling, after the released
// 0.6.0 broke when the main-branch address file was renamed under it).
//
// Two layers, two owners:
//   - `config.default.json` is the RELEASED public document: bundled into the build and fetched
//     from the binary's release-line branch (config-remote.ts). Partners read it; it never carries a
//     non-canonical deployment set (policy R5b: a public file is a partner-facing projection).
//   - `config.json` is the OPERATOR's local document, never fetched from GitHub. Internal sets
//     (staging, dark-launch, a vnet), an internal RPC book, or an emergency address fix live here
//     — the escape hatch tag pinning removed. The private tree carries Cork's own copy; the
//     public port excludes the file by name (scripts/port-to-public.ts EXCLUDED_FILES).
//
// Merge rule (`mergeConfig`): the override wins, at the granularity of a WHOLE SET. A set in
// `config.json` replaces the set with the same key in the default, or adds a new one; a set is
// never merged field by field, because policy R5b requires every set to be complete and a
// half-merged set is how a signer ends up with one contract from each generation. `primary`,
// a chain's LOP address and its Fusion settlement entry are replaceable too. `only` (a partner
// pinning the sets it has integrated) keeps just the listed set keys of that chain after the
// merge; the primary must survive the filter or the chain's `primary` must be overridden.
//
// Never overridable: `approvedImplementations`. The code-hash allowlist stays the bundled
// copy's (implementations.ts), so a document that can move an address can never also admit the
// code behind it. An override that carries the key is REFUSED as a whole (the default serves,
// `config_override_invalid` warns) — a partial application would be a silent precedence bug.
//
// Every result that used an override says so: `provenance.config.override` names the file and
// the counts, and `config_override_active` (info) fires once per result — a local file that can
// redirect a signer is an attack surface worth naming on every artifact it touched.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { ChainGenerationsSchema, GenerationSchema, type ChainGenerations } from "./generations.ts";

const Address = z.string().regex(/^0x[0-9a-fA-F]{40}$/u);

/** One chain's override: any subset of `primary`, `sets` (whole sets, replace-or-add) and
 *  `only` (the set keys to keep after the merge). */
const ChainOverrideSchema = z
  .object({
    primary: z.string().optional(),
    sets: z.record(z.string(), GenerationSchema).optional(),
    only: z.array(z.string().min(1)).min(1).optional(),
  })
  .strict();

/** The override document. `approvedImplementations` is listed so its PRESENCE is refused with
 *  a pointed message instead of the generic unknown-key error. */
export const ConfigOverrideSchema = z
  .object({
    schemaVersion: z.literal(2),
    $comment: z.string().optional(),
    lopAddresses: z.record(z.string(), Address).optional(),
    fusionSettlements: z.record(z.string(), z.object({ current: Address, legacy: z.array(Address).default([]) }).strip()).optional(),
    generations: z.record(z.string(), ChainOverrideSchema).optional(),
    approvedImplementations: z.never({ message: "approvedImplementations is never overridable: the code-hash allowlist stays the bundled copy's, so a document that moves an address cannot also admit the code behind it" }).optional(),
  })
  .strict();
export type ConfigOverride = z.infer<typeof ConfigOverrideSchema>;

/** The shape `mergeConfig` needs from the default document (a structural subset of CorkDefaults,
 *  so this module never imports config-remote.ts — the dependency runs the other way). */
export interface MergeableConfig {
  lopAddresses: Record<string, string>;
  fusionSettlements?: Record<string, { current: string; legacy: string[] }> | undefined;
  generations: Record<string, ChainGenerations>;
}

export interface OverrideSummary {
  /** Set keys replaced or added, as `<chainId>/<key>`. */
  sets: string[];
  /** Chains whose `primary` the override moved. */
  primaryMoved: string[];
  /** Chains filtered by `only`, with the keys dropped, as `<chainId>: <key>, <key>`. */
  filtered: string[];
  /** Chains whose LOP address or Fusion entry the override replaced. */
  chainEntries: string[];
}

/** Where the override is read from, in order: `CORK_CONFIG_FILE`; the user's config dir; the
 *  repo root of a SOURCE run (the private tree's own `config.json`, beside config.default.json —
 *  absent from the public tree and from a compiled binary, whose import.meta.url is virtual). */
export function overrideCandidatePaths(env: NodeJS.ProcessEnv = process.env): string[] {
  const out: string[] = [];
  if (env.CORK_CONFIG_FILE) out.push(env.CORK_CONFIG_FILE);
  out.push(join(env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "cork-helper-cli", "config.json"));
  try {
    const here = fileURLToPath(import.meta.url);
    if (!here.startsWith("/$bunfs/") && !here.includes("~BUN")) out.push(join(here, "..", "..", "..", "..", "config.json"));
  } catch {
    /* virtual module URL (compiled binary): no repo-root candidate */
  }
  return out;
}

export type LoadedOverride =
  | { kind: "none" }
  | { kind: "ok"; path: string; override: ConfigOverride }
  | { kind: "invalid"; path: string; error: string };

/** Read the first candidate that exists. A missing file is silence; a present file that fails
 *  the schema is `invalid` (the caller refuses it whole and warns). `CORK_CONFIG_FILE` naming a
 *  missing file is ALSO invalid — an operator who asked for a file must not silently get none. */
export function loadOverrideFrom(paths: readonly string[], explicit: string | undefined = process.env.CORK_CONFIG_FILE): LoadedOverride {
  for (const path of paths) {
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      if (path === explicit) return { kind: "invalid", path, error: "CORK_CONFIG_FILE names a file that cannot be read" };
      continue;
    }
    try {
      return { kind: "ok", path, override: parseOverride(JSON.parse(text)) };
    } catch (err) {
      return { kind: "invalid", path, error: err instanceof Error ? err.message.split("\n").slice(0, 3).join(" ") : String(err) };
    }
  }
  return { kind: "none" };
}

export function parseOverride(raw: unknown): ConfigOverride {
  return ConfigOverrideSchema.parse(raw);
}

/** Apply `override` to `base` (pure; neither input is mutated). Throws when the merged chain
 *  would be invalid (a `primary` naming no set, an `only` list dropping the primary, a `primary`
 *  that is read-only) — the caller turns that into a refusal of the whole override. */
export function mergeConfig<T extends MergeableConfig>(base: T, override: ConfigOverride): { merged: T; summary: OverrideSummary } {
  const summary: OverrideSummary = { sets: [], primaryMoved: [], filtered: [], chainEntries: [] };
  const merged: T = { ...base, lopAddresses: { ...base.lopAddresses }, generations: { ...base.generations } };
  if (base.fusionSettlements) merged.fusionSettlements = { ...base.fusionSettlements };

  for (const [chainId, address] of Object.entries(override.lopAddresses ?? {})) {
    merged.lopAddresses[chainId] = address;
    summary.chainEntries.push(`${chainId}/lop`);
  }
  for (const [chainId, entry] of Object.entries(override.fusionSettlements ?? {})) {
    merged.fusionSettlements = { ...(merged.fusionSettlements ?? {}), [chainId]: entry };
    summary.chainEntries.push(`${chainId}/fusion`);
  }
  for (const [chainId, ov] of Object.entries(override.generations ?? {})) {
    const current = base.generations[chainId];
    const sets: Record<string, ChainGenerations["sets"][string]> = { ...(current?.sets ?? {}) };
    for (const [key, set] of Object.entries(ov.sets ?? {})) {
      sets[key] = set;
      summary.sets.push(`${chainId}/${key}`);
    }
    let primary = ov.primary ?? current?.primary;
    if (primary === undefined) throw new Error(`chain ${chainId}: the override adds sets to a chain the default does not configure, so it must name \`primary\``);
    if (ov.primary !== undefined && ov.primary !== current?.primary) summary.primaryMoved.push(chainId);
    let kept = sets;
    if (ov.only) {
      const keep = new Set(ov.only);
      const missing = ov.only.filter((k) => !(k in sets));
      if (missing.length > 0) throw new Error(`chain ${chainId}: \`only\` names sets that do not exist after the merge: ${missing.join(", ")} (known: ${Object.keys(sets).join(", ")})`);
      if (!keep.has(primary)) throw new Error(`chain ${chainId}: \`only\` drops the primary '${primary}' — keep it in the list or override \`primary\``);
      const dropped = Object.keys(sets).filter((k) => !keep.has(k));
      kept = Object.fromEntries(Object.entries(sets).filter(([k]) => keep.has(k)));
      if (dropped.length > 0) summary.filtered.push(`${chainId}: ${dropped.join(", ")}`);
    }
    // The chain schema re-validates the invariants the default file is held to (primary names a
    // set; the primary is active), so an override cannot produce a chain the default could not.
    merged.generations[chainId] = ChainGenerationsSchema.parse({ primary, sets: kept });
    primary = undefined;
  }
  return { merged, summary };
}

/** Human-readable one-liner of what an override changed, for the `config_override_active` message. */
export function describeOverride(path: string, s: OverrideSummary): string {
  const parts: string[] = [];
  if (s.sets.length > 0) parts.push(`${s.sets.length} set(s) replaced/added: ${s.sets.join(", ")}`);
  if (s.primaryMoved.length > 0) parts.push(`primary moved on chain(s) ${s.primaryMoved.join(", ")}`);
  if (s.filtered.length > 0) parts.push(`sets hidden by \`only\` — ${s.filtered.join("; ")}`);
  if (s.chainEntries.length > 0) parts.push(`chain entries replaced: ${s.chainEntries.join(", ")}`);
  return `local configuration override ${path} is in effect (${parts.length > 0 ? parts.join("; ") : "no effective change"}); it wins over config.default.json at whole-set granularity, and a file that can redirect a signer deserves the same care as a key — verify its contents before signing anything built with it`;
}
