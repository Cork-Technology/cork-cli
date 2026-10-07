// RFQ API-key storage, resolved the AWS way: env var, then credential_process, then a key stored
// for the venue host. Every failure is checked for one thing above all: it never shows a key.
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  listCredentials,
  maskKey,
  removeStoredApiKey,
  resolveRfqApiKey,
  runCredentialProcess,
  setStoredApiKey,
  splitCommand,
} from "../src/credentials.ts";

const KEY = "cork-test-key-a1b2c3d4e5";
const STAGING = "https://breaking.cork.tech";
const PROD = "https://api-phoenix.cork.tech";
const posix = process.platform !== "win32";

let dir: string;
let path: string;
let env: Record<string, string | undefined>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cork-cred-"));
  path = join(dir, "nested", "credentials");
  env = { VITEST: "true", CORK_CREDENTIALS_FILE: path };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function writeFile(text: string, mode = 0o600): void {
  setStoredApiKey("seed", "seed.invalid", "seed-key-000000000", env); // creates the private dir
  writeFileSync(path, text, { mode });
  chmodSync(path, mode);
}

function script(name: string, body: string): string {
  const p = join(dir, name);
  writeFileSync(p, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return p;
}

describe("resolution order — first hit wins", () => {
  it("the env var beats credential_process and the stored key", async () => {
    const proc = script("cp.sh", `echo '{"Version":1,"RfqApiKey":"from-process-0000"}'`);
    writeFile(`[default]\ncredential_process = ${proc}\nrfq_api_key.breaking.cork.tech = from-file-00000\n`);
    const r = await resolveRfqApiKey({ venueUrl: STAGING, env: { ...env, CORK_RFQ_API_KEY: KEY } });
    expect(r).toEqual({ ok: true, key: KEY, disclosure: { method: "apiKey", source: "env", profile: "default", host: "breaking.cork.tech" } });
  });

  it.skipIf(!posix)("credential_process beats the stored key, and applies to whatever host is configured", async () => {
    const proc = script("cp.sh", `echo '{"Version":1,"RfqApiKey":"from-process-0000"}'`);
    writeFile(`[default]\ncredential_process = ${proc}\nrfq_api_key.breaking.cork.tech = from-file-00000\n`);
    for (const venueUrl of [STAGING, PROD]) {
      const r = await resolveRfqApiKey({ venueUrl, env });
      expect(r.ok && r.key).toBe("from-process-0000");
      expect(r.ok && r.disclosure.source).toBe("credential_process");
    }
  });

  it("the stored key serves ONLY its own host", async () => {
    writeFile(`[default]\nrfq_api_key.breaking.cork.tech = ${KEY}\n`);
    const staging = await resolveRfqApiKey({ venueUrl: `${STAGING}/`, env });
    expect(staging.ok && staging.key).toBe(KEY);
    const prod = await resolveRfqApiKey({ venueUrl: PROD, env });
    expect(prod.ok).toBe(false);
    expect(!prod.ok && prod.message).toContain("no key for api-phoenix.cork.tech");
    expect(!prod.ok && prod.message).not.toContain(KEY);
  });

  it("a port is part of the host", async () => {
    writeFile(`[default]\nrfq_api_key.localhost:8080 = ${KEY}\n`);
    expect((await resolveRfqApiKey({ venueUrl: "http://localhost:8080", env })).ok).toBe(true);
    expect((await resolveRfqApiKey({ venueUrl: "http://localhost:9090", env })).ok).toBe(false);
  });

  it("the profile: explicit, else CORK_PROFILE, else default; a missing profile is named", async () => {
    writeFile(`[default]\nrfq_api_key.breaking.cork.tech = default-key-00000\n[desk]\nrfq_api_key.breaking.cork.tech = desk-key-0000000\n`);
    expect((await resolveRfqApiKey({ venueUrl: STAGING, env })) as { key?: string }).toMatchObject({ key: "default-key-00000" });
    expect((await resolveRfqApiKey({ venueUrl: STAGING, env: { ...env, CORK_PROFILE: "desk" } })) as { key?: string }).toMatchObject({ key: "desk-key-0000000" });
    expect((await resolveRfqApiKey({ venueUrl: STAGING, profile: "default", env: { ...env, CORK_PROFILE: "desk" } })) as { key?: string }).toMatchObject({ key: "default-key-00000" });
    const missing = await resolveRfqApiKey({ venueUrl: STAGING, profile: "nope", env });
    expect(!missing.ok && missing.message).toContain("has no profile [nope]");
  });

  it("no file and no env var: the refusal lists the resolution order", async () => {
    const r = await resolveRfqApiKey({ venueUrl: STAGING, env });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.message).toMatch(/CORK_RFQ_API_KEY.*credential_process.*ch auth set-key/su);
  });
});

describe("the file", () => {
  it.skipIf(!posix)("is refused when other users can read it (the ssh rule)", async () => {
    writeFile(`[default]\nrfq_api_key.breaking.cork.tech = ${KEY}\n`, 0o644);
    const r = await resolveRfqApiKey({ venueUrl: STAGING, env });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.message).toContain("chmod 600");
    expect(!r.ok && r.message).not.toContain(KEY);
    expect(() => listCredentials(env)).toThrow(/chmod 600/u);
  });

  it.skipIf(!posix)("is written atomically, private from the first byte: file 0600, directory 0700", () => {
    setStoredApiKey("default", "breaking.cork.tech", KEY, env);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "nested")).mode & 0o777).toBe(0o700);
    expect(readFileSync(path, "utf8")).toBe(`[default]\nrfq_api_key.breaking.cork.tech = ${KEY}\n`);
  });

  it("set replaces in place and keeps comments and other profiles; remove drops one host or all of a profile", () => {
    writeFile(`# my keys\n[default]\ncredential_process = /bin/true\nrfq_api_key.breaking.cork.tech = old-key-000000000\n\n[desk]\nrfq_api_key.breaking.cork.tech = desk-key-0000000\n`);
    setStoredApiKey("default", "breaking.cork.tech", KEY, env);
    setStoredApiKey("default", "api-phoenix.cork.tech", "prod-key-00000000", env);
    setStoredApiKey("new", "breaking.cork.tech", "new-key-000000000", env);
    const text = readFileSync(path, "utf8");
    expect(text).toContain("# my keys");
    expect(text).toContain(`rfq_api_key.breaking.cork.tech = ${KEY}`);
    expect(text).not.toContain("old-key");
    expect(text.indexOf("rfq_api_key.api-phoenix.cork.tech")).toBeLessThan(text.indexOf("[desk]"));
    expect(text).toContain("[new]\nrfq_api_key.breaking.cork.tech = new-key-000000000");
    expect(removeStoredApiKey("default", "api-phoenix.cork.tech", env)).toBe(1);
    expect(removeStoredApiKey("desk", undefined, env)).toBe(1);
    const after = readFileSync(path, "utf8");
    expect(after).toContain("credential_process = /bin/true");
    expect(after).not.toContain("desk-key");
    expect(after).not.toContain("prod-key");
  });

  it("a malformed line is named by number, never by content", async () => {
    writeFile(`[default]\n${KEY}\n`);
    const r = await resolveRfqApiKey({ venueUrl: STAGING, env });
    expect(!r.ok && r.message).toContain("line 2");
    expect(!r.ok && r.message).not.toContain(KEY);
  });

  it("a listing masks every key to its last four characters", () => {
    writeFile(`[default]\ncredential_process = /bin/true\nrfq_api_key.breaking.cork.tech = ${KEY}\n`);
    const listing = listCredentials(env);
    expect(listing.profiles).toEqual([{ profile: "default", credentialProcess: true, keys: [{ host: "breaking.cork.tech", masked: "…d4e5" }] }]);
    expect(JSON.stringify(listing)).not.toContain(KEY);
    expect(maskKey("short")).toBe("…");
  });

  it("under the test runner the default ~/.config path is never read or written", async () => {
    const hermetic = { VITEST: "true" };
    expect(listCredentials(hermetic).profiles).toEqual([]);
    expect(() => setStoredApiKey("default", "breaking.cork.tech", KEY, hermetic)).toThrow(/disabled under the test runner/u);
    expect((await resolveRfqApiKey({ venueUrl: STAGING, env: hermetic })).ok).toBe(false);
  });

  it("refuses a key with whitespace and a profile name that would break the file", () => {
    expect(() => setStoredApiKey("default", "breaking.cork.tech", "two words", env)).toThrow(/whitespace/u);
    expect(() => setStoredApiKey("a]b", "breaking.cork.tech", KEY, env)).toThrow(/profile names/u);
  });
});

describe.skipIf(!posix)("credential_process", () => {
  it("parses the AWS-style JSON", async () => {
    const proc = script("ok.sh", `echo '{"Version":1,"RfqApiKey":"${KEY}"}'`);
    expect(await runCredentialProcess(proc, "default")).toBe(KEY);
  });

  it("is killed at the timeout", async () => {
    const proc = script("slow.sh", `sleep 5; echo '{"Version":1,"RfqApiKey":"${KEY}"}'`);
    const started = Date.now();
    await expect(runCredentialProcess(proc, "default", 300)).rejects.toThrow(/did not finish within 300 ms/u);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("a non-zero exit, a missing command, bad JSON and the wrong JSON shape never echo the output", async () => {
    const failing = script("fail.sh", `echo '${KEY}'; echo '${KEY}' >&2; exit 3`);
    const notJson = script("text.sh", `echo '${KEY}'`);
    const wrongShape = script("shape.sh", `echo '{"Version":2,"RfqApiKey":"${KEY}"}'`);
    for (const [cmd, pattern] of [
      [failing, /exited with status 3/u],
      [join(dir, "absent"), /not found/u],
      [notJson, /did not print JSON/u],
      [wrongShape, /without \{"Version": 1/u],
    ] as const) {
      const err = await runCredentialProcess(cmd, "default").catch((e: Error) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toMatch(pattern);
      expect((err as Error).message).not.toContain(KEY);
      expect((err as Error).stack ?? "").not.toContain(KEY);
    }
  });

  it("through the resolver, a failing process is the refusal — it does not fall through to a stored key", async () => {
    const failing = script("fail.sh", "exit 1");
    writeFile(`[default]\ncredential_process = ${failing}\nrfq_api_key.breaking.cork.tech = ${KEY}\n`);
    const r = await resolveRfqApiKey({ venueUrl: STAGING, env });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.message).toContain("exited with status 1");
  });
});

describe("splitCommand (no shell)", () => {
  it("splits on whitespace and honours quotes and escapes", () => {
    expect(splitCommand(`op read "op://Cork Vault/rfq key" --format 'json x'`)).toEqual(["op", "read", "op://Cork Vault/rfq key", "--format", "json x"]);
    expect(splitCommand(String.raw`a\ b c`)).toEqual(["a b", "c"]);
    expect(splitCommand(`a "" b`)).toEqual(["a", "", "b"]);
    expect(() => splitCommand(`a "b`)).toThrow(/unclosed quote/u);
  });
});
