// RFQ API keys, resolved the way the AWS CLI resolves credentials: an environment variable wins,
// then the profile's credential_process, then a key stored in the credentials file. A stored key
// belongs to ONE venue host, so a staging key is never sent to production.
//
// A key is a secret: nothing here ever puts it in an error, a warning or a listing. Errors name
// the file, the profile, the host and a line number — never a value.
import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { atomicWriteFileSync } from "./atomic-file.ts";

export const RFQ_API_KEY_ENV = "CORK_RFQ_API_KEY";
export const PROFILE_ENV = "CORK_PROFILE";
export const DEFAULT_PROFILE = "default";
/** Prefix of a stored key's name: `rfq_api_key.<venue host> = <key>`. */
export const STORED_KEY_PREFIX = "rfq_api_key.";
export const CREDENTIAL_PROCESS_TIMEOUT_MS = 10_000;

export type ApiKeySource = "env" | "credential_process" | "credentials-file";

export interface ApiKeyDisclosure {
  method: "apiKey";
  source: ApiKeySource;
  profile: string;
  host: string;
}

export type ApiKeyResolution = { ok: true; key: string; disclosure: ApiKeyDisclosure } | { ok: false; message: string };

export function credentialsFilePath(env: Record<string, string | undefined> = process.env): string {
  return env.CORK_CREDENTIALS_FILE ?? join(homedir(), ".config", "cork-helper-cli", "credentials");
}

/** The test suite never reads or writes the real ~/.config file unless a test opts in with
 *  CORK_CREDENTIALS_FILE (the same rule the scan and constants caches follow). */
function disabled(env: Record<string, string | undefined>): boolean {
  return env.VITEST !== undefined && env.CORK_CREDENTIALS_FILE === undefined;
}

export function selectedProfile(explicit: string | undefined, env: Record<string, string | undefined> = process.env): string {
  return explicit ?? env[PROFILE_ENV] ?? DEFAULT_PROFILE;
}

/** The host a key is bound to — `URL.host`, so a non-default port is part of it. */
export function venueHost(venueUrl: string): string {
  return new URL(venueUrl).host.toLowerCase();
}

// ── the file ──────────────────────────────────────────────────────────────────────────────

type Line =
  | { kind: "other"; text: string }
  | { kind: "section"; name: string; text: string }
  | { kind: "entry"; section: string; key: string; value: string; text: string };

export class CredentialsFileError extends Error {}

function parseCredentials(text: string, path: string): Line[] {
  const lines: Line[] = [];
  let section: string | null = null;
  for (const [i, raw] of text.split(/\r?\n/u).entries()) {
    const t = raw.trim();
    if (t === "" || t.startsWith("#") || t.startsWith(";")) {
      lines.push({ kind: "other", text: raw });
      continue;
    }
    const sec = /^\[([^\]]+)\]$/u.exec(t);
    if (sec) {
      section = sec[1]!.trim();
      lines.push({ kind: "section", name: section, text: raw });
      continue;
    }
    const eq = t.indexOf("=");
    if (eq <= 0) throw new CredentialsFileError(`${path} line ${i + 1}: expected \`[profile]\` or \`name = value\``);
    if (section === null) throw new CredentialsFileError(`${path} line ${i + 1}: an entry before any \`[profile]\` section`);
    lines.push({ kind: "entry", section, key: t.slice(0, eq).trim().toLowerCase(), value: t.slice(eq + 1).trim(), text: raw });
  }
  while (lines.length > 0 && lines[lines.length - 1]!.kind === "other" && lines[lines.length - 1]!.text.trim() === "") lines.pop();
  return lines;
}

/** Refuse a file other users can read — the ssh rule. A key in a world-readable file is a key
 *  every account on the machine holds. */
function assertPrivate(path: string): void {
  if (process.platform === "win32") return;
  const mode = statSync(path).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new CredentialsFileError(`${path} can be read by other users (mode ${mode.toString(8).padStart(3, "0")}) — refusing to read keys from it. Fix it with: chmod 600 ${path}`);
  }
}

function readLines(env: Record<string, string | undefined>): { path: string; lines: Line[] } {
  const path = credentialsFilePath(env);
  if (disabled(env) || !existsSync(path)) return { path, lines: [] };
  assertPrivate(path);
  return { path, lines: parseCredentials(readFileSync(path, "utf8"), path) };
}

function writeLines(path: string, lines: Line[]): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  atomicWriteFileSync(path, `${lines.map((l) => l.text).join("\n")}\n`, 0o600);
  chmodSync(path, 0o600);
}

function entryOf(lines: Line[], profile: string, key: string): string | undefined {
  for (const l of lines) if (l.kind === "entry" && l.section === profile && l.key === key) return l.value;
  return undefined;
}

// ── credential_process ────────────────────────────────────────────────────────────────────

/** Split a command line into argv without a shell: whitespace separates, single and double
 *  quotes group, a backslash escapes the next character outside single quotes. */
export function splitCommand(command: string): string[] {
  const args: string[] = [];
  let cur = "";
  let started = false;
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (quote === "'") {
      if (c === "'") quote = null;
      else cur += c;
    } else if (c === "\\" && i + 1 < command.length) {
      cur += command[++i];
      started = true;
    } else if (quote === '"') {
      if (c === '"') quote = null;
      else cur += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      started = true;
    } else if (/\s/u.test(c)) {
      if (started) args.push(cur);
      cur = "";
      started = false;
    } else {
      cur += c;
      started = true;
    }
  }
  if (quote !== null) throw new CredentialsFileError("credential_process has an unclosed quote");
  if (started) args.push(cur);
  return args;
}

/** Run the profile's credential_process. Its output is a secret, so no failure message ever
 *  quotes stdout or stderr. */
export async function runCredentialProcess(command: string, profile: string, timeoutMs = CREDENTIAL_PROCESS_TIMEOUT_MS): Promise<string> {
  const argv = splitCommand(command);
  if (argv.length === 0) throw new CredentialsFileError(`profile [${profile}]: credential_process is empty`);
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(argv[0]!, argv.slice(1), { timeout: timeoutMs, maxBuffer: 64 * 1024, windowsHide: true }, (err, out) => {
      if (err) {
        const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string | null; code?: number | string };
        const why = e.killed || e.signal ? `did not finish within ${timeoutMs} ms` : e.code === "ENOENT" ? `could not start (${argv[0]} not found)` : `exited with status ${String(e.code)}`;
        reject(new CredentialsFileError(`profile [${profile}]: credential_process ${why}`));
      } else resolve(String(out));
    });
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new CredentialsFileError(`profile [${profile}]: credential_process did not print JSON (expected {"Version": 1, "RfqApiKey": "…"})`);
  }
  const o = parsed as { Version?: unknown; RfqApiKey?: unknown };
  if (o === null || typeof o !== "object" || o.Version !== 1 || typeof o.RfqApiKey !== "string" || o.RfqApiKey === "") {
    throw new CredentialsFileError(`profile [${profile}]: credential_process printed JSON without {"Version": 1, "RfqApiKey": "<non-empty string>"}`);
  }
  return o.RfqApiKey;
}

// ── resolution ────────────────────────────────────────────────────────────────────────────

export const RESOLUTION_ORDER = `1. the ${RFQ_API_KEY_ENV} environment variable; 2. the profile's credential_process in the credentials file; 3. the profile's stored key for this venue host (\`ch auth set-key\`)`;

export interface ResolveOptions {
  venueUrl: string;
  profile?: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
}

/** First hit wins: env var, then credential_process, then the key stored for this host. */
export async function resolveRfqApiKey(opts: ResolveOptions): Promise<ApiKeyResolution> {
  const env = opts.env ?? process.env;
  const profile = selectedProfile(opts.profile, env);
  let host: string;
  try {
    host = venueHost(opts.venueUrl);
  } catch {
    return { ok: false, message: "the venue URL is not a valid URL, so no key can be matched to it" };
  }
  const fromEnv = env[RFQ_API_KEY_ENV];
  if (fromEnv !== undefined && fromEnv !== "") return { ok: true, key: fromEnv, disclosure: { method: "apiKey", source: "env", profile, host } };
  try {
    const { path, lines } = readLines(env);
    const hasProfile = lines.some((l) => l.kind === "section" && l.name === profile);
    const process_ = entryOf(lines, profile, "credential_process");
    if (process_ !== undefined) {
      const key = await runCredentialProcess(process_, profile, opts.timeoutMs);
      return { ok: true, key, disclosure: { method: "apiKey", source: "credential_process", profile, host } };
    }
    const stored = entryOf(lines, profile, `${STORED_KEY_PREFIX}${host}`);
    if (stored !== undefined && stored !== "") return { ok: true, key: stored, disclosure: { method: "apiKey", source: "credentials-file", profile, host } };
    const where = hasProfile ? `profile [${profile}] in ${path} has no key for ${host}` : `${path} has no profile [${profile}]`;
    return { ok: false, message: `no RFQ API key for venue host ${host}: ${where}. Looked in order: ${RESOLUTION_ORDER}. Store one with \`ch auth set-key --profile ${profile} --venue https://${host}\`` };
  } catch (err) {
    if (err instanceof CredentialsFileError) return { ok: false, message: err.message };
    // A read failure of the file itself (permissions on the directory, a vanished file) —
    // named by its class only, never by content.
    return { ok: false, message: `could not read the credentials file (${(err as NodeJS.ErrnoException).code ?? "unknown error"})` };
  }
}

// ── management (the `ch auth` commands) ─────────────────────────────────────────────────────

export function maskKey(key: string): string {
  return key.length <= 8 ? "…" : `…${key.slice(-4)}`;
}

export interface CredentialListing {
  path: string;
  profiles: Array<{ profile: string; credentialProcess: boolean; keys: Array<{ host: string; masked: string }> }>;
}

export function listCredentials(env: Record<string, string | undefined> = process.env): CredentialListing {
  const { path, lines } = readLines(env);
  const profiles: CredentialListing["profiles"] = [];
  for (const l of lines) {
    if (l.kind === "section" && !profiles.some((p) => p.profile === l.name)) profiles.push({ profile: l.name, credentialProcess: false, keys: [] });
    if (l.kind !== "entry") continue;
    const p = profiles.find((x) => x.profile === l.section)!;
    if (l.key === "credential_process") p.credentialProcess = true;
    else if (l.key.startsWith(STORED_KEY_PREFIX)) p.keys.push({ host: l.key.slice(STORED_KEY_PREFIX.length), masked: maskKey(l.value) });
  }
  return { path, profiles };
}

function assertWritable(env: Record<string, string | undefined>): void {
  if (disabled(env)) throw new CredentialsFileError("the credentials file is disabled under the test runner — set CORK_CREDENTIALS_FILE");
}

export function setStoredApiKey(profile: string, host: string, key: string, env: Record<string, string | undefined> = process.env): string {
  assertWritable(env);
  if (!/^\S+$/u.test(key)) throw new CredentialsFileError("the key is empty or contains whitespace");
  if (!/^[A-Za-z0-9._-]+$/u.test(profile)) throw new CredentialsFileError(`profile names use letters, digits, '.', '_' and '-' only — got ${JSON.stringify(profile)}`);
  const { path, lines } = readLines(env);
  const name = `${STORED_KEY_PREFIX}${host}`;
  const text = `${name} = ${key}`;
  const at = lines.findIndex((l) => l.kind === "entry" && l.section === profile && l.key === name);
  if (at >= 0) lines[at] = { kind: "entry", section: profile, key: name, value: key, text };
  else {
    let sectionEnd = -1;
    for (const [i, l] of lines.entries()) {
      if (l.kind === "section" && l.name === profile) sectionEnd = i;
      else if (sectionEnd >= 0 && l.kind === "entry" && l.section === profile) sectionEnd = i;
    }
    const entry: Line = { kind: "entry", section: profile, key: name, value: key, text };
    if (sectionEnd >= 0) lines.splice(sectionEnd + 1, 0, entry);
    else {
      if (lines.length > 0) lines.push({ kind: "other", text: "" });
      lines.push({ kind: "section", name: profile, text: `[${profile}]` }, entry);
    }
  }
  writeLines(path, lines);
  return path;
}

/** Remove one host's key, or — with no host — every stored key of the profile. The section and
 *  its credential_process stay; that line is the user's to edit. Returns how many were removed. */
export function removeStoredApiKey(profile: string, host: string | undefined, env: Record<string, string | undefined> = process.env): number {
  assertWritable(env);
  const { path, lines } = readLines(env);
  const keep = lines.filter((l) => !(l.kind === "entry" && l.section === profile && (host === undefined ? l.key.startsWith(STORED_KEY_PREFIX) : l.key === `${STORED_KEY_PREFIX}${host}`)));
  const removed = lines.length - keep.length;
  if (removed > 0) writeLines(path, keep);
  return removed;
}
