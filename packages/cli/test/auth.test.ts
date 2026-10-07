// `ch auth`: RFQ API keys stored per profile and venue host. The key goes in through a prompt or
// a pipe, never argv, and never comes back out.
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT, runCli } from "@cork/cli";

const KEY = "cli-test-key-9z8y7x6w";
const STAGING = "https://breaking.cork.tech";
const posix = process.platform !== "win32";

let dir: string;
let env: Record<string, string>;
const reader = (value: string) => ({ readSecret: async () => value });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cork-cli-auth-"));
  env = { CORK_CREDENTIALS_FILE: join(dir, "credentials") };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("ch auth", () => {
  it("set-key stores the piped key for the venue host, private, and never prints it", async () => {
    const res = await runCli(["auth", "set-key", "--venue", STAGING, "--profile", "desk"], {}, env, reader(`${KEY}\n`));
    expect(res.code).toBe(EXIT.ok);
    expect(res.stdout).toContain("breaking.cork.tech");
    expect(res.stdout + res.stderr).not.toContain(KEY);
    expect(readFileSync(env.CORK_CREDENTIALS_FILE!, "utf8")).toBe(`[desk]\nrfq_api_key.breaking.cork.tech = ${KEY}\n`);
    if (posix) expect(statSync(env.CORK_CREDENTIALS_FILE!).mode & 0o777).toBe(0o600);
  });

  it("set-key refuses a key on the command line and stores nothing", async () => {
    const res = await runCli(["auth", "set-key", KEY, "--venue", STAGING], {}, env, reader("unused-key-000000"));
    expect(res.code).toBe(EXIT.invalid);
    expect(res.stderr).toContain("never pass a key on the command line");
    expect(res.stderr).not.toContain(KEY);
    expect(() => readFileSync(env.CORK_CREDENTIALS_FILE!, "utf8")).toThrow();
  });

  it("list masks the key; status names the source and never the key; remove drops it", async () => {
    await runCli(["auth", "set-key", "--venue", STAGING], {}, env, reader(KEY));
    const list = await runCli(["auth", "list"], {}, env);
    expect(list.stdout).toContain("[default]");
    expect(list.stdout).toContain(`breaking.cork.tech  …${KEY.slice(-4)}`);
    expect(list.stdout).not.toContain(KEY);
    const listJson = await runCli(["auth", "list", "--json"], {}, env);
    expect(listJson.stdout).not.toContain(KEY);

    const status = await runCli(["auth", "status", "--venue", STAGING, "--json"], {}, env);
    expect(status.code).toBe(EXIT.ok);
    expect(JSON.parse(status.stdout)).toEqual({ resolved: true, method: "apiKey", source: "credentials-file", profile: "default", host: "breaking.cork.tech" });
    expect(status.stdout).not.toContain(KEY);

    const prod = await runCli(["auth", "status", "--venue", "https://api-phoenix.cork.tech"], {}, env);
    expect(prod.code).toBe(EXIT.unavailable);
    expect(prod.stderr).toContain("no key for api-phoenix.cork.tech");

    const removed = await runCli(["auth", "remove", "--venue", STAGING, "--json"], {}, env);
    expect(JSON.parse(removed.stdout)).toEqual({ removed: 1, profile: "default", host: "breaking.cork.tech" });
    expect((await runCli(["auth", "status", "--venue", STAGING], {}, env)).code).toBe(EXIT.unavailable);
  });

  it("--profile on a tool call selects the profile the key is read from", async () => {
    await runCli(["auth", "set-key", "--venue", STAGING, "--profile", "desk"], {}, env, reader(KEY));
    const prev = process.env.CORK_CREDENTIALS_FILE;
    process.env.CORK_CREDENTIALS_FILE = env.CORK_CREDENTIALS_FILE;
    try {
      const sent: Array<Record<string, string>> = [];
      const ctx = {
        venueUrl: STAGING,
        nowSeconds: 1_790_000_000n,
        resolveRpc: async () => null,
        venueFetch: async (_url: string, init?: RequestInit) => {
          sent.push(Object.fromEntries(new Headers(init?.headers).entries()));
          return new Response(JSON.stringify({ rfq_id: "rfq_p", state: "open" }), { status: 201 });
        },
      };
      const input = {
        chainId: 42161,
        clientRequestId: "test-cli-profile-01",
        action: {
          type: "rfq-open",
          kind: "rollover",
          requester: "0x1111111111111111111111111111111111111111",
          referenceAsset: "0x9D39A5DE30e57443BfF2A8307A4256c8797A3497",
          collateralAsset: { exact: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" },
          source: { poolId: `0x${"ab".repeat(32)}`, shares: "1000000000000000000" },
          premiumToken: { exact: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" },
          expiryWindow: { notBefore: 1_795_000_000, notAfter: 1_795_604_800 },
          validUntil: 1_794_900_000,
          auth: { method: "apiKey" },
        },
      };
      const noProfile = await runCli(["submit", "--json", JSON.stringify(input)], ctx, {});
      expect(noProfile.code).toBe(EXIT.unavailable);
      expect(noProfile.stdout + noProfile.stderr).toContain("api_key_missing");
      const withProfile = await runCli(["submit", "--profile", "desk", "--json", JSON.stringify(input)], ctx, {});
      expect(withProfile.stdout).toContain('"profile": "desk"');
      expect(withProfile.stdout).not.toContain(KEY);
      expect(sent.at(-1)?.["x-cork-api-key"]).toBe(KEY);
    } finally {
      if (prev === undefined) delete process.env.CORK_CREDENTIALS_FILE;
      else process.env.CORK_CREDENTIALS_FILE = prev;
    }
  });
});
