// CLI signing with a password-protected keystore: the v3 format against the spec's own vectors,
// owner-only files, our own directory only, a human-only password, a yes before any signature,
// and a hard wall between the MCP server and this code.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { recoverTransactionAddress, verifyTypedData, type Hex } from "viem";
import { privateKeyToAccount, privateKeyToAddress } from "viem/accounts";
import { runCli } from "../src/app.ts";
import { decryptKeystore, encryptKeystore, keystoreDir, KeystoreError, parseKeystore, parsePrivateKey, readKeystore, writeKeystore } from "../src/keystore.ts";
import { NoTerminalError, terminalPrompter, type Prompter } from "../src/prompt.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const CHEAP = { n: 1024, r: 8, p: 1 };
const KEY = `0x${"3a".repeat(32)}` as Hex;
const ALICE = privateKeyToAccount(KEY);
const PASSWORD = "correct horse battery";

// Web3 Secret Storage definition, test vectors (password "testpassword").
const SPEC_KEY = "7a28b5ba57c53603b0b07b56bba752f7784bf506fa95edc395f5cf6c7514fe9d";
const SPEC_PBKDF2 = `{"crypto":{"cipher":"aes-128-ctr","cipherparams":{"iv":"6087dab2f9fdbbfaddc31a909735c1e6"},"ciphertext":"5318b4d5bcd28de64ee5559e671353e16f075ecae9f99c7a79a38af5f869aa46","kdf":"pbkdf2","kdfparams":{"c":262144,"dklen":32,"prf":"hmac-sha256","salt":"ae3cd4e7013836a3df6bd7241b12db061dbe2c6785853cce422d148a624ce0bd"},"mac":"517ead924a9d0dc3124507e3393d175ce3ff7c1e96529c6c555ce9e51205e9b2"},"id":"3198bc9c-6672-5ab3-d995-4942343ae5b6","version":3}`;
const SPEC_SCRYPT = `{"crypto":{"cipher":"aes-128-ctr","cipherparams":{"iv":"83dbcc02d8ccb40e466191a123791e0e"},"ciphertext":"d172bf743a674da9cdad04534d56926ef8358534d458fffccd4e6ad2fbde479c","kdf":"scrypt","kdfparams":{"dklen":32,"n":262144,"r":1,"p":8,"salt":"ab0c7876052600dd703518d6fc3fe8984592145b591fc8fb5c6d43190334ba19"},"mac":"2103ac29920d71da29f15d75b4a16dbe95cfd7ff8faea1056c33131d846e3097"},"id":"3198bc9c-6672-5ab3-d995-4942343ae5b6","version":3}`;

function freshDir(): { root: string; env: { CORK_KEYSTORE_DIR: string } } {
  const root = mkdtempSync(join(tmpdir(), "ch-keystore-"));
  return { root, env: { CORK_KEYSTORE_DIR: join(root, "keystores") } };
}

/** A scripted human: answers in order, records what was asked. Never a terminal. */
function scripted(answers: { secrets?: string[]; confirm?: boolean[] }): Prompter & { asked: string[]; shown: string[] } {
  const secrets = [...(answers.secrets ?? [])];
  const confirms = [...(answers.confirm ?? [])];
  const asked: string[] = [];
  const shown: string[] = [];
  return {
    asked,
    shown,
    async secret(q) {
      asked.push(q);
      const s = secrets.shift();
      if (s === undefined) throw new Error(`unexpected secret prompt: ${q}`);
      return s;
    },
    async confirm(q) {
      asked.push(q);
      return confirms.shift() ?? false;
    },
    say(t) {
      shown.push(t);
    },
  };
}

function storeAlice(env: Record<string, string>, name = "alice"): void {
  writeKeystore(name, encryptKeystore(Buffer.from(KEY.slice(2), "hex"), PASSWORD, CHEAP), env);
}

const TYPED = {
  domain: { name: "Cork RFQ", version: "1", chainId: 42161 },
  types: { CorkRfqWrite: [{ name: "operation", type: "string" }, { name: "ref", type: "string" }, { name: "bodyHash", type: "bytes32" }] },
  primaryType: "CorkRfqWrite",
  message: { operation: "open", ref: "test-rfq-open-0001", bodyHash: `0x${"11".repeat(32)}` },
} as const;

describe("v3 keystore format", () => {
  it("decrypts the spec's pbkdf2 and scrypt vectors to the spec's key", { timeout: 120_000 }, () => {
    for (const vector of [SPEC_PBKDF2, SPEC_SCRYPT]) {
      const key = decryptKeystore(parseKeystore(vector), "testpassword");
      expect(key.toString("hex")).toBe(SPEC_KEY);
    }
  });

  it("round-trips a key; a wrong password is refused by the check value, never decrypted", () => {
    const ks = encryptKeystore(Buffer.from(KEY.slice(2), "hex"), PASSWORD, CHEAP);
    expect(ks.address).toBe(ALICE.address.toLowerCase().slice(2));
    expect(`0x${decryptKeystore(ks, PASSWORD).toString("hex")}`).toBe(KEY);
    let err: unknown;
    try {
      decryptKeystore(ks, "not the password");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(KeystoreError);
    expect((err as KeystoreError).code).toBe("keystore_wrong_password");
  });

  it("errors never carry the key or the password", () => {
    const ks = encryptKeystore(Buffer.from(KEY.slice(2), "hex"), PASSWORD, CHEAP);
    const messages: string[] = [];
    for (const f of [() => decryptKeystore(ks, "hunter2-hunter2"), () => parsePrivateKey(`${KEY.slice(2)}zz`), () => parseKeystore("{nope")]) {
      try {
        f();
      } catch (e) {
        messages.push((e as Error).message);
      }
    }
    expect(messages).toHaveLength(3);
    for (const m of messages) {
      expect(m).not.toContain(KEY.slice(2));
      expect(m).not.toContain("hunter2");
      expect(m).not.toContain(PASSWORD);
    }
  });
});

describe("keystore files", () => {
  it("writes owner-only files in an owner-only directory, and refuses a file others can read", () => {
    const { env } = freshDir();
    storeAlice(env);
    const dir = env.CORK_KEYSTORE_DIR;
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, "alice.json")).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual(["alice.json"]);
    chmodSync(join(dir, "alice.json"), 0o644);
    expect(() => readKeystore("alice", env)).toThrow(/chmod 600/);
  });

  it("reads only our own directory — another tool's keystore folder is never consulted", () => {
    const { root, env } = freshDir();
    const foundry = join(root, ".foundry", "keystores");
    mkdirSync(foundry, { recursive: true });
    writeFileSync(join(foundry, "alice"), JSON.stringify(encryptKeystore(Buffer.from(KEY.slice(2), "hex"), PASSWORD, CHEAP)), { mode: 0o600 });
    expect(() => readKeystore("alice", { ...env, HOME: root })).toThrow(/no keystore named 'alice'/);
    for (const f of ["keystore.ts", "wallet.ts", "prompt.ts"]) {
      expect(readFileSync(join(ROOT, "packages/cli/src", f), "utf8")).not.toMatch(/\.foundry/);
    }
  });

  it("has no default directory under vitest unless a test opts in", () => {
    expect(keystoreDir({})).toBeNull();
    expect(keystoreDir({ CORK_KEYSTORE_DIR: "/x" })).toBe("/x");
  });
});

describe("the password comes from a human at a terminal only", () => {
  it("refuses with no terminal — a missing device or a plain file is never read for a password", async () => {
    const { root } = freshDir();
    const plain = join(root, "password.txt");
    writeFileSync(plain, `${PASSWORD}\n`);
    for (const path of [join(root, "no-such-tty"), plain]) {
      await expect(terminalPrompter(path).secret("Password: ")).rejects.toBeInstanceOf(NoTerminalError);
      await expect(terminalPrompter(path).confirm("Sign this?")).rejects.toBeInstanceOf(NoTerminalError);
    }
  });

  it("the binary never hands runCli a prompter, and no source reads a password from the environment", () => {
    const bin = readFileSync(join(ROOT, "packages/cli/src/bin.ts"), "utf8");
    expect(bin).not.toMatch(/prompter/);
    for (const f of ["keystore.ts", "wallet.ts", "prompt.ts"]) {
      expect(readFileSync(join(ROOT, "packages/cli/src", f), "utf8")).not.toMatch(/PASSWORD["'\]]|env\[["'][A-Z_]*PASS/);
    }
  });
});

describe("the MCP server can never sign", () => {
  it("no MCP, core or schemas source reaches the signing modules", () => {
    const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(join(dir, d.name)) : d.name.endsWith(".ts") ? [join(dir, d.name)] : []));
    for (const pkg of ["mcp", "core", "schemas"]) {
      for (const file of walk(join(ROOT, "packages", pkg, "src"))) {
        const src = readFileSync(file, "utf8");
        expect(src, file).not.toMatch(/(?:from|import)\s*\(?\s*["'][^"']*\b(keystore|wallet|prompt)(\.ts)?["']/);
        expect(src, file).not.toMatch(/["']@cork\/cli["']/);
      }
    }
    const mcpPkg = JSON.parse(readFileSync(join(ROOT, "packages/mcp/package.json"), "utf8")) as Record<string, Record<string, string> | undefined>;
    expect({ ...mcpPkg.dependencies, ...mcpPkg.devDependencies }["@cork/cli"]).toBeUndefined();
  });
});

describe("ch wallet", () => {
  it("imports a piped key, lists it and prints its address — never the key", { timeout: 120_000 }, async () => {
    const { env } = freshDir();
    const p = scripted({ secrets: [PASSWORD, PASSWORD] });
    const r = await runCli(["wallet", "import", "alice", "--from-stdin", "--json"], {}, env, { prompter: p, readStdin: async () => `${KEY}\n` });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).address).toBe(ALICE.address.toLowerCase());
    expect(r.stdout + r.stderr).not.toContain(KEY.slice(2));
    const list = await runCli(["wallet", "list", "--json"], {}, env, { prompter: scripted({}) });
    expect(JSON.parse(list.stdout).keystores).toEqual([{ name: "alice", address: ALICE.address.toLowerCase() }]);
    const addr = await runCli(["wallet", "address", "alice", "--json"], {}, env, { prompter: scripted({}) });
    expect(JSON.parse(addr.stdout).address).toBe(ALICE.address.toLowerCase());
  });

  it("refuses two different passwords and writes nothing", async () => {
    const { env } = freshDir();
    const r = await runCli(["wallet", "import", "alice", "--from-stdin", "--json"], {}, env, { prompter: scripted({ secrets: [PASSWORD, `${PASSWORD}!`] }), readStdin: async () => KEY });
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/passwords differ/);
    expect(existsSync(join(env.CORK_KEYSTORE_DIR, "alice.json"))).toBe(false);
  });

  it("asks before removing, and a no keeps the file", async () => {
    const { env } = freshDir();
    storeAlice(env);
    const kept = await runCli(["wallet", "remove", "alice"], {}, env, { prompter: scripted({ confirm: [false] }) });
    expect(kept.code).toBe(3);
    expect(existsSync(join(env.CORK_KEYSTORE_DIR, "alice.json"))).toBe(true);
    const gone = await runCli(["wallet", "remove", "alice"], {}, env, { prompter: scripted({ confirm: [true] }) });
    expect(gone.code).toBe(0);
    expect(existsSync(join(env.CORK_KEYSTORE_DIR, "alice.json"))).toBe(false);
  });
});

describe("ch sign", () => {
  it("shows what will be signed, asks yes, then the password, and signs as the keystore's address", async () => {
    const { env } = freshDir();
    storeAlice(env);
    const p = scripted({ confirm: [true], secrets: [PASSWORD] });
    const r = await runCli(["sign", "--account", "alice", "--json"], {}, env, { prompter: p, readStdin: async () => JSON.stringify({ state: "ok", data: { typedData: TYPED } }) });
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout) as { signer: string; signature: Hex };
    expect(out.signer).toBe(ALICE.address);
    expect(await verifyTypedData({ address: ALICE.address, ...TYPED, signature: out.signature })).toBe(true);
    expect(p.shown.join("\n")).toMatch(/CorkRfqWrite[\s\S]*Cork RFQ[\s\S]*42161[\s\S]*test-rfq-open-0001/);
    expect(p.asked).toEqual(["Sign this?", "Password for keystore 'alice': "]);
  });

  it("a no at the question signs nothing and never asks for the password", async () => {
    const { env } = freshDir();
    storeAlice(env);
    const p = scripted({ confirm: [false], secrets: [PASSWORD] });
    const r = await runCli(["sign", "--account", "alice", "--json"], {}, env, { prompter: p, readStdin: async () => JSON.stringify(TYPED) });
    expect(r.code).toBe(3);
    expect(JSON.parse(r.stderr).error.code).toBe("cancelled");
    expect(r.stdout).toBe("");
    expect(p.asked).toEqual(["Sign this?"]);
  });

  it("a wrong password is a conflict and its text never appears", async () => {
    const { env } = freshDir();
    storeAlice(env);
    const r = await runCli(["sign", "--account", "alice", "--json"], {}, env, { prompter: scripted({ confirm: [true], secrets: ["hunter2-hunter2"] }), readStdin: async () => JSON.stringify(TYPED) });
    expect(r.code).toBe(4);
    expect(r.stdout + r.stderr).not.toContain("hunter2");
  });

  it("signs a complete transaction, and refuses one a prepare result left without nonce/gas/fees", async () => {
    const { env } = freshDir();
    storeAlice(env);
    const tx = { to: "0x0000000000000000000000000000000000000001", data: "0x", value: "0", chainId: 8453, nonce: 7, gas: "21000", maxFeePerGas: "1000000000", maxPriorityFeePerGas: "1000" };
    const r = await runCli(["sign", "--account", "alice", "--json"], {}, env, { prompter: scripted({ confirm: [true], secrets: [PASSWORD] }), readStdin: async () => JSON.stringify(tx) });
    expect(r.code).toBe(0);
    const signed = JSON.parse(r.stdout).signedTransaction as Hex;
    expect(await recoverTransactionAddress({ serializedTransaction: signed as never })).toBe(ALICE.address);
    const partial = await runCli(["sign", "--account", "alice", "--json"], {}, env, { prompter: scripted({ confirm: [true], secrets: [PASSWORD] }), readStdin: async () => JSON.stringify({ to: tx.to, data: "0x", value: "0" }) });
    expect(partial.code).toBe(2);
    expect(JSON.parse(partial.stderr).error.code).toBe("incomplete_transaction");
  });

  it("an artifact file that cannot be read is the caller's input error, named, before any password", async () => {
    const { env } = freshDir();
    storeAlice(env);
    const p = scripted({ confirm: [], secrets: [] });
    const r = await runCli(["sign", "/nonexistent/tx.json", "--account", "alice", "--json"], {}, env, { prompter: p });
    expect(r.code).toBe(2);
    const error = JSON.parse(r.stderr).error as { code: string; message: string };
    expect(error.code).toBe("artifact_unreadable");
    expect(error.message).toMatch(/cannot read the artifact to sign from \/nonexistent\/tx\.json \(ENOENT\)/u);
    expect(p.asked).toEqual([]); // no password was asked for
  });
});

describe("ch submit rfq-* --account", () => {
  const OPEN = {
    type: "rfq-open",
    kind: "new_position",
    requester: ALICE.address,
    referenceAsset: "0x9D39A5DE30e57443BfF2A8307A4256c8797A3497",
    collateralAsset: { one_of: ["0xaf88d065e77c8cC2239327C5EDb3A432268e5831"] },
    modes: ["liquidity_only"],
    packageIds: ["balanced-v1"],
    expiryWindow: { notBefore: 1_795_000_000, notAfter: 1_795_604_800 },
    notionalAssets: "50000000000",
    validUntil: 1_794_900_000,
  };
  const ctxWith = (posts: unknown[]) => ({
    nowSeconds: 1_790_000_000n,
    resolveRpc: async () => null,
    venueFetch: async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") posts.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ rfq_id: "rfq_cli1", state: "open" }), { status: 201 });
    },
  });

  it("prepares, signs with the keystore, and submits a write the submit's own signer check accepts", async () => {
    const { env } = freshDir();
    storeAlice(env);
    const posts: unknown[] = [];
    const p = scripted({ confirm: [true], secrets: [PASSWORD] });
    const input = { chainId: 42161, clientRequestId: "test-rfq-open-cli1", action: OPEN };
    const r = await runCli(["submit", "--json", JSON.stringify(input), "--account", "alice"], ctxWith(posts) as never, env, { prompter: p });
    expect(r.stderr).toBe("");
    expect(JSON.parse(r.stdout).state).toBe("ok");
    expect(posts).toHaveLength(1);
    expect((posts[0] as { signature: string }).signature).toMatch(/^0x[0-9a-f]{130}$/);
    expect(p.shown.join("\n")).toMatch(/CorkRfqWrite[\s\S]*test-rfq-open-cli1/);
  });

  it("refuses a keystore whose address is not the writer before asking for the password", async () => {
    const { env } = freshDir();
    storeAlice(env);
    const posts: unknown[] = [];
    const p = scripted({ confirm: [true], secrets: [PASSWORD] });
    const other = privateKeyToAddress(`0x${"3b".repeat(32)}`);
    const input = { chainId: 42161, clientRequestId: "test-rfq-open-cli2", action: { ...OPEN, requester: other } };
    const r = await runCli(["submit", "--json", JSON.stringify(input), "--account", "alice"], ctxWith(posts) as never, env, { prompter: p });
    expect(r.code).toBe(4);
    expect(JSON.parse(r.stderr).error.code).toBe("signer_mismatch");
    expect(p.asked).toEqual([]);
    expect(posts).toHaveLength(0);
  });

  it("refuses --account beside auth apiKey before any prompt: one proof per write", async () => {
    const { env } = freshDir();
    storeAlice(env);
    const posts: unknown[] = [];
    const p = scripted({ confirm: [true], secrets: [PASSWORD] });
    const input = { chainId: 42161, clientRequestId: "test-rfq-open-cli3", action: { ...OPEN, auth: { method: "apiKey" } } };
    const r = await runCli(["submit", "--json", JSON.stringify(input), "--account", "alice", "--profile", "desk"], ctxWith(posts) as never, env, { prompter: p });
    expect(r.code).not.toBe(0);
    expect(JSON.parse(r.stderr).error.message).toMatch(/choose one/);
    expect(p.asked).toEqual([]);
    expect(p.shown).toEqual([]);
    expect(posts).toHaveLength(0);
  });

  it("is a CLI flag, not a tool field: the MCP surface fixture has no keystore anywhere", () => {
    const surface = readFileSync(join(ROOT, "packages/mcp/test/fixtures/tool-surface.json"), "utf8");
    expect(surface).not.toMatch(/keystore/i);
  });
});
