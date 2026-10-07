// Password-protected key files for CLI signing. The MCP server never signs [K1]: this module
// lives in the CLI package, which the MCP package cannot depend on, and a test fails if any
// MCP or core source reaches it (packages/cli/test/keystore.test.ts).
//
// Format: Web3 Secret Storage v3 — the standard encrypted JSON keystore — so a key can be moved
// to or from another wallet tool BY HAND. Keystores live only in our own directory; another
// tool's keystore folder is never read.
import { createCipheriv, createDecipheriv, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { pbkdf2 } from "@noble/hashes/pbkdf2";
import { scrypt } from "@noble/hashes/scrypt";
import { sha256 } from "@noble/hashes/sha2";
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { keccak256, type Hex } from "viem";
import { privateKeyToAddress } from "viem/accounts";

/** A failure the user can act on. The message never carries key material or a password. */
export class KeystoreError extends Error {
  constructor(
    readonly code: "keystore_not_found" | "keystore_exists" | "keystore_permissions" | "keystore_invalid" | "keystore_wrong_password" | "keystore_name_invalid" | "keystore_dir_unset",
    message: string,
  ) {
    super(message);
    this.name = "KeystoreError";
  }
}

export interface KeystoreV3 {
  version: 3;
  id: string;
  address?: string;
  crypto: {
    cipher: "aes-128-ctr";
    cipherparams: { iv: string };
    ciphertext: string;
    kdf: "scrypt" | "pbkdf2";
    kdfparams: Record<string, unknown>;
    mac: string;
  };
}

// The cost geth and most wallets write. Reading accepts the file's own parameters within bounds,
// so a hand-moved key from another tool decrypts here.
export const SCRYPT_DEFAULT = { n: 262144, r: 8, p: 1 } as const;
const BOUNDS = { maxN: 1 << 20, maxR: 32, maxP: 16, maxC: 10_000_000 };

/** Where keystores live: CORK_KEYSTORE_DIR, else the user's config directory. Under vitest the
 *  default is unset unless a test opts in, so a test run never touches the user's keys. */
export function keystoreDir(env: Record<string, string | undefined> = process.env): string | null {
  const explicit = env["CORK_KEYSTORE_DIR"];
  if (explicit) return explicit;
  if (process.env.VITEST !== undefined) return null;
  return join(env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config"), "cork-helper-cli", "keystores");
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function keystorePath(dir: string, name: string): string {
  if (!NAME.test(name) || name.endsWith(".json")) {
    throw new KeystoreError("keystore_name_invalid", `'${name}' is not a keystore name — use letters, digits, '.', '_' or '-' (up to 64 characters, no path separators)`);
  }
  return join(dir, `${name}.json`);
}

function requireDir(env?: Record<string, string | undefined>): string {
  const dir = keystoreDir(env);
  if (dir === null) throw new KeystoreError("keystore_dir_unset", "no keystore directory: set CORK_KEYSTORE_DIR");
  return dir;
}

/** A key file anyone but the owner can read is refused, the way ssh refuses a loose key. */
function assertPrivate(path: string): void {
  if (process.platform === "win32") return;
  const mode = statSync(path).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new KeystoreError("keystore_permissions", `${path} can be read by other users (mode ${mode.toString(8).padStart(3, "0")}) — run: chmod 600 '${path}'`);
  }
}

function hex(b: Uint8Array): string {
  return Buffer.from(b).toString("hex");
}

function unhex(s: unknown, what: string, bytes?: number): Buffer {
  if (typeof s !== "string" || !/^(0x)?[0-9a-fA-F]*$/.test(s) || s.replace(/^0x/, "").length % 2 !== 0) throw new KeystoreError("keystore_invalid", `keystore ${what} is not hex`);
  const b = Buffer.from(s.replace(/^0x/, ""), "hex");
  if (bytes !== undefined && b.length !== bytes) throw new KeystoreError("keystore_invalid", `keystore ${what} must be ${bytes} bytes`);
  return b;
}

function int(v: unknown, what: string, max: number): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > max) throw new KeystoreError("keystore_invalid", `keystore kdfparams.${what} is out of range`);
  return v;
}

function deriveKey(ks: KeystoreV3, password: string): Buffer {
  const p = ks.crypto.kdfparams;
  const salt = unhex(p["salt"], "kdfparams.salt");
  const dklen = int(p["dklen"], "dklen", 64);
  if (dklen < 32) throw new KeystoreError("keystore_invalid", "keystore kdfparams.dklen must be at least 32");
  // The runtime's own scrypt (BoringSSL under Bun) refuses parameters other wallets write —
  // e.g. the spec's r=1, n=2^18 vector — so both KDFs use the audited pure-JS implementation.
  const pw = new TextEncoder().encode(password.normalize("NFKD"));
  if (ks.crypto.kdf === "scrypt") {
    const n = int(p["n"], "n", BOUNDS.maxN);
    if ((n & (n - 1)) !== 0) throw new KeystoreError("keystore_invalid", "keystore kdfparams.n must be a power of two");
    const r = int(p["r"], "r", BOUNDS.maxR);
    const pp = int(p["p"], "p", BOUNDS.maxP);
    return Buffer.from(scrypt(pw, salt, { N: n, r, p: pp, dkLen: dklen, maxmem: 2 * 128 * r * (n + pp + 2) }));
  }
  if (ks.crypto.kdf === "pbkdf2") {
    if (p["prf"] !== "hmac-sha256") throw new KeystoreError("keystore_invalid", "keystore pbkdf2 prf must be hmac-sha256");
    return Buffer.from(pbkdf2(sha256, pw, salt, { c: int(p["c"], "c", BOUNDS.maxC), dkLen: dklen }));
  }
  throw new KeystoreError("keystore_invalid", `keystore kdf '${String(ks.crypto.kdf)}' is not supported (scrypt or pbkdf2)`);
}

function macOf(dk: Buffer, ciphertext: Buffer): Buffer {
  return Buffer.from(keccak256(Buffer.concat([dk.subarray(16, 32), ciphertext])).slice(2), "hex");
}

export function parseKeystore(text: string): KeystoreV3 {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new KeystoreError("keystore_invalid", "keystore is not JSON");
  }
  const ks = raw as KeystoreV3;
  // Some writers capitalise the key ("Crypto"); the spec says crypto.
  const c = (ks as unknown as { crypto?: unknown; Crypto?: unknown }).crypto ?? (ks as unknown as { Crypto?: unknown }).Crypto;
  if (!ks || ks.version !== 3 || !c || typeof c !== "object") throw new KeystoreError("keystore_invalid", "not a version 3 keystore");
  const crypto = c as KeystoreV3["crypto"];
  if (crypto.cipher !== "aes-128-ctr") throw new KeystoreError("keystore_invalid", `keystore cipher '${String(crypto.cipher)}' is not supported (aes-128-ctr)`);
  if (!crypto.kdfparams || typeof crypto.kdfparams !== "object") throw new KeystoreError("keystore_invalid", "keystore kdfparams missing");
  return { ...ks, crypto };
}

/** Decrypt to the 32-byte private key. The caller must wipe the returned buffer after use. */
export function decryptKeystore(ks: KeystoreV3, password: string): Buffer {
  const dk = deriveKey(ks, password);
  try {
    const ciphertext = unhex(ks.crypto.ciphertext, "ciphertext");
    const mac = unhex(ks.crypto.mac, "mac", 32);
    if (!timingSafeEqual(macOf(dk, ciphertext), mac)) throw new KeystoreError("keystore_wrong_password", "wrong password (the keystore's check value does not match)");
    const decipher = createDecipheriv("aes-128-ctr", dk.subarray(0, 16), unhex(ks.crypto.cipherparams?.iv, "cipherparams.iv", 16));
    const key = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    if (key.length !== 32) {
      key.fill(0);
      throw new KeystoreError("keystore_invalid", "keystore does not hold a 32-byte private key");
    }
    return key;
  } finally {
    dk.fill(0);
  }
}

/** Encrypt a private key into a v3 keystore (scrypt). `cost` exists for tests only. */
export function encryptKeystore(privateKey: Buffer, password: string, cost: { n: number; r: number; p: number } = SCRYPT_DEFAULT): KeystoreV3 {
  if (privateKey.length !== 32) throw new KeystoreError("keystore_invalid", "a private key is 32 bytes");
  const salt = randomBytes(32);
  const iv = randomBytes(16);
  const kdfparams = { dklen: 32, n: cost.n, r: cost.r, p: cost.p, salt: hex(salt) };
  const ks0: KeystoreV3 = { version: 3, id: randomUUID(), crypto: { cipher: "aes-128-ctr", cipherparams: { iv: hex(iv) }, ciphertext: "", kdf: "scrypt", kdfparams, mac: "" } };
  const dk = deriveKey(ks0, password);
  try {
    const cipher = createCipheriv("aes-128-ctr", dk.subarray(0, 16), iv);
    const ciphertext = Buffer.concat([cipher.update(privateKey), cipher.final()]);
    const address = privateKeyToAddress(`0x${hex(privateKey)}` as Hex).toLowerCase().slice(2);
    return { ...ks0, address, crypto: { ...ks0.crypto, ciphertext: hex(ciphertext), mac: hex(macOf(dk, ciphertext)) } };
  } finally {
    dk.fill(0);
  }
}

/** The address a keystore declares, readable without the password (null when it declares none). */
export function declaredAddress(ks: KeystoreV3): `0x${string}` | null {
  return typeof ks.address === "string" && /^(0x)?[0-9a-fA-F]{40}$/.test(ks.address) ? (`0x${ks.address.replace(/^0x/, "").toLowerCase()}` as `0x${string}`) : null;
}

export function readKeystore(name: string, env?: Record<string, string | undefined>): { path: string; keystore: KeystoreV3 } {
  const path = keystorePath(requireDir(env), name);
  if (!existsSync(path)) throw new KeystoreError("keystore_not_found", `no keystore named '${name}' — \`ch wallet list\` shows the names; \`ch wallet import ${name}\` adds one`);
  assertPrivate(path);
  return { path, keystore: parseKeystore(readFileSync(path, "utf8")) };
}

/** Owner-only directory, owner-only file, written to a temp file and renamed so a reader never
 *  sees half a key; an existing name is never overwritten. */
export function writeKeystore(name: string, ks: KeystoreV3, env?: Record<string, string | undefined>): string {
  const dir = requireDir(env);
  const path = keystorePath(dir, name);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") chmodSync(dir, 0o700);
  if (existsSync(path)) throw new KeystoreError("keystore_exists", `a keystore named '${name}' already exists — pick another name, or \`ch wallet remove ${name}\` first`);
  const tmp = `${path}.tmp-${process.pid}`;
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeSync(fd, `${JSON.stringify(ks, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  return path;
}

export function removeKeystore(name: string, env?: Record<string, string | undefined>): string {
  const path = keystorePath(requireDir(env), name);
  if (!existsSync(path)) throw new KeystoreError("keystore_not_found", `no keystore named '${name}'`);
  unlinkSync(path);
  return path;
}

export interface KeystoreEntry {
  name: string;
  address: `0x${string}` | null;
  /** Why the file cannot be used, when it cannot (loose permissions, not a keystore). */
  problem?: string;
}

export function listKeystores(env?: Record<string, string | undefined>): { dir: string; entries: KeystoreEntry[] } {
  const dir = requireDir(env);
  if (!existsSync(dir)) return { dir, entries: [] };
  const entries: KeystoreEntry[] = [];
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith(".json")) continue;
    const name = file.slice(0, -".json".length);
    if (!NAME.test(name)) continue;
    try {
      const { keystore } = readKeystore(name, env);
      entries.push({ name, address: declaredAddress(keystore) });
    } catch (e) {
      entries.push({ name, address: null, problem: e instanceof KeystoreError ? e.message : "unreadable" });
    }
  }
  return { dir, entries };
}

/** Parse a typed or pasted private key; refuses anything but 32 bytes of hex. */
export function parsePrivateKey(text: string): Buffer {
  const s = text.trim().replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]{64}$/.test(s)) throw new KeystoreError("keystore_invalid", "a private key is 64 hex characters (32 bytes), optionally prefixed 0x");
  return Buffer.from(s, "hex");
}
