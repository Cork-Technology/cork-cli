// Signing from the CLI with a password-protected keystore. This is the ONE place cork-cli signs,
// and only a human can make it sign: the password is typed at the terminal (prompt.ts), and every
// signature is preceded by a plain-English summary and an explicit yes. The MCP server never
// reaches this file — packages/cli/test/keystore.test.ts fails if MCP or core imports it.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Command } from "commander";
import { runTool, type HandlerContext } from "@cork/core";
import { isAddressEqual, type Hex, type TypedDataDefinition } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  declaredAddress,
  decryptKeystore,
  encryptKeystore,
  KeystoreError,
  listKeystores,
  parsePrivateKey,
  readKeystore,
  removeKeystore,
  writeKeystore,
} from "./keystore.ts";
import { NoTerminalError, PromptAbortedError, terminalPrompter, type Prompter } from "./prompt.ts";

const EXIT = { ok: 0, error: 1, invalid: 2, unavailable: 3, conflict: 4 } as const;

export interface WalletIo {
  /** Injected by tests; the real binary always asks the terminal. */
  prompter?: Prompter;
  /** Piped input (a `ch sign` artifact, or a private key for `ch wallet import --from-stdin`). */
  readStdin?: () => Promise<string>;
}

export interface WalletSink {
  out(text: string): void;
  fail(payload: { error: Record<string, unknown> }, code: number): void;
  setCode(code: number): void;
  wantsJson(opts: Record<string, unknown>): boolean;
}

/** A refusal shaped like every other CLI error. Never carries a key or a password. */
function failureOf(e: unknown): { payload: { error: Record<string, unknown> }; code: number } {
  if (e instanceof KeystoreError) return { payload: { error: { code: e.code, message: e.message } }, code: e.code === "keystore_wrong_password" ? EXIT.conflict : EXIT.invalid };
  if (e instanceof NoTerminalError) return { payload: { error: { code: "no_terminal", message: e.message } }, code: EXIT.unavailable };
  if (e instanceof PromptAbortedError) return { payload: { error: { code: "cancelled", message: e.message } }, code: EXIT.unavailable };
  if (e instanceof SignRefusal) return { payload: { error: { code: e.code, message: e.message } }, code: e.exit };
  // Anything else could have touched key material on its way up; only its kind is shown.
  return { payload: { error: { code: "internal_error", message: `signing failed (${(e as Error)?.name ?? "error"}; details withheld because they may carry key material)` } }, code: EXIT.error };
}

class SignRefusal extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly exit: number = EXIT.invalid,
  ) {
    super(message);
    this.name = "SignRefusal";
  }
}

function defaultReadStdin(): Promise<string> {
  return Promise.resolve(readFileSync(0, "utf8"));
}

// ---------------------------------------------------------------------------------------------
// What is about to be signed, in words a person can check before typing a password.

function short(v: unknown): string {
  const s = typeof v === "string" ? v : typeof v === "bigint" ? v.toString() : JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));
  return s === undefined ? "—" : s.length > 80 ? `${s.slice(0, 77)}…` : s;
}

export function describeTypedData(td: TypedDataDefinition): string[] {
  const d = (td.domain ?? {}) as Record<string, unknown>;
  const lines = [
    `You are about to SIGN typed data (EIP-712) of type ${String(td.primaryType)}.`,
    `  domain        ${short(d.name)} version ${short(d.version)}`,
    `  chain         ${short(d.chainId)}`,
    `  contract      ${d.verifyingContract === undefined ? "(none — the domain names no contract)" : short(d.verifyingContract)}`,
  ];
  const message = (td.message ?? {}) as Record<string, unknown>;
  for (const [k, v] of Object.entries(message)) lines.push(`  ${k.padEnd(13)} ${short(v)}`);
  if (td.primaryType === "CorkRfqWrite") lines.push("  This proves an RFQ write to the Cork venue: its bodyHash commits to every field of the request.");
  return lines;
}

/** The typed data inside a prepare result, a bare typed-data object, or nothing. */
export function typedDataOf(doc: unknown): TypedDataDefinition | null {
  const o = doc as Record<string, unknown> | null;
  const candidates = [(o?.data as Record<string, unknown> | undefined)?.typedData, o?.typedData, o];
  for (const c of candidates) {
    const t = c as Record<string, unknown> | undefined;
    if (t && typeof t === "object" && t.types && t.primaryType && t.message && t.domain) return t as unknown as TypedDataDefinition;
  }
  return null;
}

const TX_FIELDS = ["to", "chainId", "nonce", "gas"] as const;

/** A transaction complete enough to sign. A prepare result carries {to, data, value} only:
 *  nonce, gas and fees belong to the sender's own RPC, so they must be filled in first. */
export function transactionOf(doc: unknown): Record<string, unknown> | null {
  const o = doc as Record<string, unknown> | null;
  const data = o?.data as Record<string, unknown> | undefined;
  for (const c of [data?.tx, data?.transaction, o?.tx, o?.transaction, o]) {
    const t = c as Record<string, unknown> | undefined;
    if (t && typeof t === "object" && typeof t.to === "string" && !("types" in t)) return t;
  }
  return null;
}

function big(v: unknown, field: string): bigint {
  if (typeof v === "bigint") return v;
  if ((typeof v === "number" && Number.isInteger(v)) || (typeof v === "string" && /^(0x[0-9a-fA-F]+|\d+)$/.test(v))) return BigInt(v);
  throw new SignRefusal("invalid_transaction", `transaction field ${field} must be an integer (decimal or 0x-hex)`);
}

async function describeTransaction(tx: Record<string, unknown>, ctx: HandlerContext): Promise<string[]> {
  const lines = [
    "You are about to SIGN a transaction. ch does not broadcast it — you send the signed bytes through your own RPC.",
    `  to            ${short(tx.to)}`,
    `  value         ${short(tx.value ?? "0")} wei`,
    `  chain         ${short(tx.chainId)}`,
    `  nonce         ${short(tx.nonce)}`,
    `  gas           ${short(tx.gas)}`,
    tx.gasPrice !== undefined ? `  gas price     ${short(tx.gasPrice)}` : `  max fee       ${short(tx.maxFeePerGas)} (priority ${short(tx.maxPriorityFeePerGas)})`,
  ];
  if (typeof tx.data === "string" && tx.data !== "0x") {
    const env = (await runTool("cork_decode", { kind: "calldata", data: tx.data, to: tx.to, chainId: Number(tx.chainId) }, ctx).catch(() => null)) as { data?: { summary?: string[] } } | null;
    const summary = env?.data?.summary;
    if (Array.isArray(summary) && summary.length > 0) lines.push("  what it does:", ...summary.map((l) => `    ${l}`));
    else lines.push("  what it does: (calldata could not be decoded — do not sign until you have identified it)");
  }
  return lines;
}

// ---------------------------------------------------------------------------------------------
// The signing step: summary → yes → password → decrypt → check the key is the expected one →
// sign → wipe. The order matters: nothing secret is asked for until the human agreed to WHAT.

async function unlockAndSign(args: {
  name: string;
  env: Record<string, string | undefined>;
  prompter: Prompter;
  summary: string[];
  expectedSigner?: `0x${string}`;
  sign: (key: Hex) => Promise<Hex>;
}): Promise<{ signature: Hex; signer: `0x${string}` }> {
  const { keystore } = readKeystore(args.name, args.env);
  const declared = declaredAddress(keystore);
  if (args.expectedSigner && declared && !isAddressEqual(declared, args.expectedSigner)) {
    throw new SignRefusal("signer_mismatch", `keystore '${args.name}' holds ${declared}, but this must be signed by ${args.expectedSigner} — pick the keystore of that address`, EXIT.conflict);
  }
  args.prompter.say([...args.summary, `  signer        ${declared ?? "(the keystore declares no address — shown after unlock)"} (keystore '${args.name}')`].join("\n"));
  if (!(await args.prompter.confirm("Sign this?"))) throw new PromptAbortedError();
  const password = await args.prompter.secret(`Password for keystore '${args.name}': `);
  const key = decryptKeystore(keystore, password);
  try {
    const hex = `0x${key.toString("hex")}` as Hex;
    const signer = privateKeyToAccount(hex).address;
    if (args.expectedSigner && !isAddressEqual(signer, args.expectedSigner)) {
      throw new SignRefusal("signer_mismatch", `keystore '${args.name}' unlocks ${signer}, but this must be signed by ${args.expectedSigner}`, EXIT.conflict);
    }
    if (declared && !isAddressEqual(signer, declared)) {
      throw new SignRefusal("keystore_invalid", `keystore '${args.name}' declares ${declared} but holds the key of ${signer} — the file was edited; nothing signed`);
    }
    return { signature: await args.sign(hex), signer };
  } finally {
    // Best effort: the Buffer is wiped; the hex string viem needs cannot be (JS strings are immutable).
    key.fill(0);
  }
}

/** Sign typed data with a keystore — the shared step behind `ch sign` and `--account`. */
export async function signTypedDataWithKeystore(args: {
  name: string;
  typedData: TypedDataDefinition;
  env: Record<string, string | undefined>;
  prompter: Prompter;
  expectedSigner?: `0x${string}`;
}): Promise<{ signature: Hex; signer: `0x${string}` }> {
  return unlockAndSign({
    name: args.name,
    env: args.env,
    prompter: args.prompter,
    summary: describeTypedData(args.typedData),
    ...(args.expectedSigner ? { expectedSigner: args.expectedSigner } : {}),
    sign: (key) => privateKeyToAccount(key).signTypedData(args.typedData),
  });
}

// ---------------------------------------------------------------------------------------------
// `ch submit rfq-open|rfq-answer|rfq-counter --account <keystore>`: prepare → sign → submit.

export const ACCOUNT_SUGAR_TYPES = new Set(["rfq-open", "rfq-answer", "rfq-counter"]);

/** Turns a submit input WITHOUT auth into one WITH the keystore's signature, by running the
 *  rfq-write prepare first. Returns the new input, or the prepare envelope when it refused. */
export async function withKeystoreSignature(args: {
  input: Record<string, unknown>;
  name: string;
  ctx: HandlerContext;
  env: Record<string, string | undefined>;
  prompter: Prompter;
}): Promise<{ input: Record<string, unknown> } | { envelope: unknown }> {
  const action = (args.input.action ?? {}) as Record<string, unknown>;
  const type = String(action.type);
  if (!ACCOUNT_SUGAR_TYPES.has(type)) {
    throw new SignRefusal("invalid_input", `--account signs RFQ writes only (rfq-open, rfq-answer, rfq-counter), not '${type}' — sign other artifacts with \`ch sign --account <name>\``);
  }
  if ((action.auth as { method?: unknown } | undefined)?.method === "apiKey") {
    throw new SignRefusal("invalid_input", "--account proves the write with a keystore signature; auth {method:'apiKey'} proves it with an API key — choose one: drop --account, or drop auth");
  }
  if (action.auth !== undefined) {
    throw new SignRefusal("invalid_input", "--account produces the signature itself — drop `auth` from the input, or drop --account and pass your own auth");
  }
  const { type: _type, ...request } = action;
  const signer = (type === "rfq-answer" ? request.underwriter : request.requester) as `0x${string}` | undefined;
  if (typeof signer !== "string") throw new SignRefusal("invalid_input", `${type} needs ${type === "rfq-answer" ? "underwriter" : "requester"} — the address that signs`);
  const prepared = (await runTool(
    "cork_prepare_orders",
    { chainId: args.input.chainId, account: signer, clientRequestId: args.input.clientRequestId, action: { type: "rfq-write", request: { type, ...request } } },
    args.ctx,
  )) as { state?: string; data?: Record<string, unknown> };
  if (prepared.state !== "ok" || !prepared.data) return { envelope: prepared };
  const typedData = prepared.data.typedData as TypedDataDefinition;
  const { signature } = await signTypedDataWithKeystore({ name: args.name, typedData, env: args.env, prompter: args.prompter, expectedSigner: signer });
  const submitAction = prepared.data.submitAction as Record<string, unknown>;
  return { input: { ...args.input, action: { ...submitAction, auth: { method: "signature", signature } } } };
}

/** Run the sugar inside a command action; on refusal, report it and return null. */
export async function applyAccountSugar(
  args: { input: Record<string, unknown>; name: string; ctx: HandlerContext; env: Record<string, string | undefined>; io: WalletIo },
  sink: Pick<WalletSink, "fail">,
): Promise<{ input: Record<string, unknown> } | { envelope: unknown } | null> {
  try {
    return await withKeystoreSignature({ ...args, prompter: args.io.prompter ?? terminalPrompter() });
  } catch (e) {
    const f = failureOf(e);
    sink.fail(f.payload, f.code);
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// `ch wallet …` and `ch sign …`

export function registerWalletCommands(program: Command, deps: { env: Record<string, string | undefined>; io: WalletIo; ctx: HandlerContext; sink: WalletSink }): void {
  const { env, io, ctx, sink } = deps;
  const prompter = (): Prompter => io.prompter ?? terminalPrompter();
  const run = (opts: Record<string, unknown>, body: () => Promise<Record<string, unknown> | string>) =>
    body().then(
      (res) => {
        sink.out(sink.wantsJson(opts) ? `${JSON.stringify(typeof res === "string" ? { message: res } : res, null, 2)}\n` : typeof res === "string" ? `${res}\n` : `${Object.entries(res).map(([k, v]) => `${k.padEnd(10)} ${typeof v === "string" ? v : JSON.stringify(v)}`).join("\n")}\n`);
        sink.setCode(EXIT.ok);
      },
      (e) => {
        const f = failureOf(e);
        sink.fail(f.payload, f.code);
      },
    );

  const wallet = program.command("wallet").description("password-protected keystores for CLI signing (our own directory only: ~/.config/cork-helper-cli/keystores, or CORK_KEYSTORE_DIR); the MCP server never signs");

  const newPassword = async (p: Prompter): Promise<string> => {
    const a = await p.secret("New keystore password: ");
    if (a.length < 8) throw new SignRefusal("invalid_input", "a keystore password must be at least 8 characters");
    const b = await p.secret("Repeat the password: ");
    if (a !== b) throw new SignRefusal("invalid_input", "the two passwords differ — nothing was written");
    return a;
  };

  wallet
    .command("new <name>")
    .description("create a new key and store it encrypted (the password is typed at a prompt)")
    .option("--json", "print as JSON")
    .action((name: string, opts: Record<string, unknown>) =>
      run(opts, async () => {
        const p = prompter();
        const password = await newPassword(p);
        const key = randomBytes(32);
        try {
          const ks = encryptKeystore(key, password);
          const path = writeKeystore(name, ks, env);
          return { name, address: declaredAddress(ks) ?? "", path };
        } finally {
          key.fill(0);
        }
      }),
    );

  wallet
    .command("import <name>")
    .description("store an existing private key encrypted: typed at a hidden prompt, or piped with --from-stdin (never as an argument); the password is always typed")
    .option("--from-stdin", "read the private key from piped input instead of a prompt")
    .option("--json", "print as JSON")
    .action((name: string, opts: Record<string, unknown>) =>
      run(opts, async () => {
        const p = prompter();
        const keyText = opts["fromStdin"] ? await (io.readStdin ?? defaultReadStdin)() : await p.secret("Private key (hex, input hidden): ");
        const key = parsePrivateKey(keyText);
        try {
          const password = await newPassword(p);
          const ks = encryptKeystore(key, password);
          const path = writeKeystore(name, ks, env);
          return { name, address: declaredAddress(ks) ?? "", path };
        } finally {
          key.fill(0);
        }
      }),
    );

  wallet
    .command("list")
    .description("list keystore names and the address each declares (no password needed)")
    .option("--json", "print as JSON")
    .action((opts: Record<string, unknown>) =>
      run(opts, async () => {
        const { dir, entries } = listKeystores(env);
        if (sink.wantsJson(opts)) return { dir, keystores: entries };
        if (entries.length === 0) return `no keystores in ${dir} — \`ch wallet new <name>\` or \`ch wallet import <name>\``;
        return [`keystores in ${dir}`, ...entries.map((e) => `  ${e.name.padEnd(20)} ${e.address ?? "(no address declared)"}${e.problem ? `  — ${e.problem}` : ""}`)].join("\n");
      }),
    );

  wallet
    .command("address <name>")
    .description("print the address a keystore declares (no password needed)")
    .option("--json", "print as JSON")
    .action((name: string, opts: Record<string, unknown>) =>
      run(opts, async () => {
        const address = declaredAddress(readKeystore(name, env).keystore);
        if (!address) throw new SignRefusal("keystore_invalid", `keystore '${name}' declares no address; \`ch sign\` shows the signer after unlock`);
        return { name, address };
      }),
    );

  wallet
    .command("remove <name>")
    .description("delete a keystore file (asks first; --yes skips the question)")
    .option("--yes", "do not ask")
    .option("--json", "print as JSON")
    .action((name: string, opts: Record<string, unknown>) =>
      run(opts, async () => {
        const { keystore } = readKeystore(name, env);
        if (!opts["yes"] && !(await prompter().confirm(`Delete keystore '${name}' (${declaredAddress(keystore) ?? "no address declared"})? Without a backup the key is gone.`))) {
          throw new PromptAbortedError();
        }
        return { name, removed: removeKeystore(name, env) };
      }),
    );

  program
    .command("sign [file]")
    .description("sign a prepared artifact with a keystore — EIP-712 typed data (e.g. a cork_prepare_orders result) or a COMPLETE transaction (nonce, gas and fees filled in); reads the file or piped input, shows what will be signed, asks yes/no, then the password. Never broadcasts")
    .requiredOption("--account <name>", "the keystore to sign with (`ch wallet list`)")
    .option("--json", "print as JSON")
    .action((file: string | undefined, opts: Record<string, unknown>) =>
      run(opts, async () => {
        // The artifact is read before any key is touched, so a file that cannot be read is the
        // caller's input, named as such — never the catch-all for errors that may carry key material.
        let text: string;
        try {
          text = file ? readFileSync(file, "utf8") : await (io.readStdin ?? defaultReadStdin)();
        } catch (e) {
          throw new SignRefusal("artifact_unreadable", `cannot read the artifact to sign${file ? ` from ${file}` : " from standard input"} (${(e as NodeJS.ErrnoException)?.code ?? (e as Error)?.name ?? "error"}) — pass the path of a prepare result saved with --json, or pipe it in`);
        }
        let doc: unknown;
        try {
          doc = JSON.parse(text);
        } catch {
          throw new SignRefusal("invalid_json", "the artifact to sign is not JSON — pipe a prepare result (`ch prepare … --json | ch sign --account <name>`) or pass its file");
        }
        const name = String(opts["account"]);
        const td = typedDataOf(doc);
        if (td) {
          const { signature, signer } = await signTypedDataWithKeystore({ name, typedData: td, env, prompter: prompter() });
          return { kind: "typed-data", signer, signature };
        }
        const tx = transactionOf(doc);
        if (!tx) throw new SignRefusal("nothing_to_sign", "found neither typed data (domain/types/primaryType/message) nor a transaction (to/…) in the input");
        const missing = TX_FIELDS.filter((f) => tx[f] === undefined);
        if (tx.gasPrice === undefined && (tx.maxFeePerGas === undefined || tx.maxPriorityFeePerGas === undefined)) missing.push("maxFeePerGas+maxPriorityFeePerGas (or gasPrice)" as never);
        if (missing.length > 0) {
          throw new SignRefusal("incomplete_transaction", `the transaction lacks ${missing.join(", ")} — a prepare result carries to/data/value only; fill in the sender's nonce, gas and fees from your own RPC first`);
        }
        const request = {
          to: tx.to as `0x${string}`,
          data: (typeof tx.data === "string" ? tx.data : "0x") as Hex,
          value: tx.value === undefined ? 0n : big(tx.value, "value"),
          chainId: Number(big(tx.chainId, "chainId")),
          nonce: Number(big(tx.nonce, "nonce")),
          gas: big(tx.gas, "gas"),
          ...(tx.gasPrice !== undefined ? { gasPrice: big(tx.gasPrice, "gasPrice") } : { maxFeePerGas: big(tx.maxFeePerGas, "maxFeePerGas"), maxPriorityFeePerGas: big(tx.maxPriorityFeePerGas, "maxPriorityFeePerGas") }),
        };
        const summary = await describeTransaction(tx, ctx);
        const { signature, signer } = await unlockAndSign({ name, env, prompter: prompter(), summary, sign: (key) => privateKeyToAccount(key).signTransaction(request) });
        return { kind: "transaction", signer, signedTransaction: signature, next: "check it with `ch decode tx`, then send it with eth_sendRawTransaction through your own RPC" };
      }),
    );
}
