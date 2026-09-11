// A signed 1inch LOP v4 order has FOUR independent properties, and every surface that acts on
// one (the fill builder, the refresh sugar, the ranked book, the finalizer) needs the same four
// answers:
//
//   1. identity     — the row hashes to the orderHash it claims (chain-free; hashLopOrder)
//   2. extension    — the bytes beside the order are the ones its salt commits to, exactly as
//                     OrderLib.isValidExtension decides at fill (chain-free)
//   3. authenticity — the MAKER signed it: ecrecover for an EOA (chain-free), the ERC-1271
//                     isValidSignature staticcall for a contract maker (an RPC read)
//   4. liveness     — the invalidator bit is unspent (an RPC read; lopInvalidatorPlan)
//
// Until 2026-09-11 only the venue-free inline fill checked all four; venue-sourced rows (the
// book, the venue fill path, refresh) checked 1 and 4 and inherited the venue's word for 2 and 3
// (audit DB-004). This module is the ONE home of checks 2 and 3 so no path can drift again:
// the pure verdicts live here, the envelope shaping for the build paths beside them, and the
// book's per-row leg composes the same functions.
import { isAddressEqual, recoverAddress } from "viem";
import { decodeMakerTraits, ERC1271_MAGIC, erc1271Abi, type LopOrder, saltExtensionBinding } from "../orders.ts";
import { Envelope } from "@cork/schemas";
import type { ResolvedRpc } from "../chain/rpc.ts";
import { envelope, getRpc, type HandlerContext, isTransportFailure, revertReason, unavailable } from "./shared.ts";

type ChainId = Parameters<typeof getRpc>[1];
/** The two reads the ladder performs, as a structural subset of viem's PublicClient. */
type MakerCodeClient = Pick<ResolvedRpc["client"], "getCode" | "readContract">;
type Warning = { code: string; message: string };

// ── 2. extension ────────────────────────────────────────────────────────────────────────────

/** OrderLib.isValidExtension, mirrored branch for branch: the HAS_EXTENSION flag (makerTraits
 *  bit 249) decides whether bytes are EXPECTED, and when they are, the salt's low 160 bits must
 *  equal keccak256(extension)'s. Three distinct reverts, three distinct reasons — a check that
 *  only compared hashes when bytes happened to be present (the pre-2026-09-11 inline check)
 *  missed both flag/bytes disagreements. */
export type ExtensionVerdict =
  | { valid: true }
  | { valid: false; reason: "MissingOrderExtension" | "UnexpectedOrderExtension" | "InvalidExtensionHash"; message: string };

export function extensionVerdict(order: LopOrder, extension: `0x${string}`): ExtensionVerdict {
  const hasBytes = extension.length > 2; // "0x" is the empty extension
  if (decodeMakerTraits(order.makerTraits).hasExtension) {
    if (!hasBytes) {
      return { valid: false, reason: "MissingOrderExtension", message: "the signed makerTraits set HAS_EXTENSION, but no extension bytes came with the order — OrderLib reverts MissingOrderExtension at fill, so these bytes can never fill. Pass the order's OWN extension verbatim" };
    }
    if (!saltExtensionBinding(order.salt, extension).bound) {
      return { valid: false, reason: "InvalidExtensionHash", message: "the salt's low 160 bits are not bound to keccak256(extension) — OrderLib enforces this binding at fill (InvalidExtension), so these bytes can never fill. Pass the order's OWN extension verbatim" };
    }
    return { valid: true };
  }
  if (hasBytes) {
    return { valid: false, reason: "UnexpectedOrderExtension", message: "extension bytes came with the order, but the signed makerTraits do not set HAS_EXTENSION — OrderLib reverts UnexpectedOrderExtension at fill, so these bytes can never fill. The order was signed WITHOUT an extension; drop the bytes" };
  }
  return { valid: true };
}

// ── 3. authenticity ─────────────────────────────────────────────────────────────────────────

/** How the maker-code probe went. "no-code" is a positive answer (an EOA); only the other two
 *  leave the account type genuinely unknown. viem's getCode returns `undefined` for an
 *  account WITHOUT code, so the read's outcome is tracked separately from its value —
 *  conflating the two reported every EOA maker as "could not be checked" (2026-08-20). */
export type MakerCodeProbe = "has-code" | "no-code" | "no-rpc" | "read-failed";

/** The verdict, not an envelope: call sites refuse with legitimately different consequences
 *  ("NOT finalized", "no fill bytes were built", "not refreshed", "the row was dropped"), so
 *  message construction stays with each caller. `eoa_mismatch` carries the code probe because
 *  its meaning depends on it: with "no-code" it is DEFINITIVE (an EOA that did not sign);
 *  with "no-rpc"/"read-failed" the maker might be a contract nobody could ask — indeterminate. */
export type MakerSignatureVerdict =
  | { kind: "eoa"; recoveredSigner: `0x${string}`; codeProbe: Exclude<MakerCodeProbe, "has-code"> }
  | { kind: "erc1271" }
  | { kind: "erc1271_transport"; reason: string }
  | { kind: "erc1271_rejected"; isValidSignatureAnswer: string | null }
  | { kind: "eoa_mismatch"; recoveredSigner: `0x${string}`; codeProbe: Exclude<MakerCodeProbe, "has-code"> }
  | { kind: "unparseable"; reason: string };

/** eth_getCode on the maker, classified. `undefined` and "0x" both mean "no code" (an EOA) —
 *  only a throw means the read failed, and a missing client means nobody could ask. */
export async function probeMakerCode(client: MakerCodeClient | null, maker: `0x${string}`): Promise<MakerCodeProbe> {
  if (!client) return "no-rpc";
  try {
    const code = await client.getCode({ address: maker });
    return code !== undefined && code !== "0x" ? "has-code" : "no-code";
  } catch {
    return "read-failed"; // transport failure or a client without getCode
  }
}

/** The ERC-1271 isValidSignature staticcall — the exact read the fill performs for a contract
 *  maker — classified. Attribution: a transport failure is indeterminate (retryable, not a
 *  verdict); a contract-side revert or a non-magic answer IS the verdict. */
export async function checkContractMakerSignature(client: MakerCodeClient, a: { maker: `0x${string}`; orderHash: `0x${string}`; signature: `0x${string}` }): Promise<Extract<MakerSignatureVerdict, { kind: "erc1271" | "erc1271_transport" | "erc1271_rejected" }>> {
  let magic: unknown;
  try {
    magic = await client.readContract({ address: a.maker, abi: erc1271Abi, functionName: "isValidSignature", args: [a.orderHash, a.signature] });
  } catch (err) {
    if (isTransportFailure(err)) return { kind: "erc1271_transport", reason: revertReason(err) };
    magic = null;
  }
  if (typeof magic !== "string" || magic.slice(0, 10).toLowerCase() !== ERC1271_MAGIC) {
    return { kind: "erc1271_rejected", isValidSignatureAnswer: typeof magic === "string" ? magic : null };
  }
  return { kind: "erc1271" };
}

/** Maker-signature verification ladder, shared by finalize-maker-order, both taker-fill
 *  acquisition paths and refresh-order. Code detection decides the branch: a CONTRACT maker
 *  (a Safe, the Zyfai shape) cannot be ecrecovered — verification performs the SAME
 *  isValidSignature staticcall the fill performs; an EOA maker verifies offline by ecrecover.
 *  Composes the two primitives above; the ranked book composes them differently (it settles
 *  ecrecover chain-free for every row first, then asks only about the rows that did not
 *  recover — see authenticateBookRowSignature). */
export async function verifyMakerSignatureLadder(a: {
  ctx: HandlerContext;
  chainId: ChainId;
  maker: `0x${string}`;
  orderHash: `0x${string}`;
  signature: `0x${string}`;
  /** A client the caller already resolved; omitted = resolve through the context. */
  client?: MakerCodeClient | undefined;
}): Promise<MakerSignatureVerdict> {
  const client: MakerCodeClient | null = a.client ?? (await getRpc(a.ctx, a.chainId))?.client ?? null;
  const probe = await probeMakerCode(client, a.maker);
  if (probe === "has-code") return checkContractMakerSignature(client!, a);
  const recovered = await recoverEoaSigner(a.orderHash, a.signature);
  if (recovered.signer === null) return { kind: "unparseable", reason: recovered.reason };
  if (!isAddressEqual(recovered.signer, a.maker)) return { kind: "eoa_mismatch", recoveredSigner: recovered.signer, codeProbe: probe };
  return { kind: "eoa", recoveredSigner: recovered.signer, codeProbe: probe };
}

/** The chain-free half of authenticity: ecrecover, never throwing. A signer equal to the maker
 *  is a POSITIVE verdict on its own (only the maker's key produces it); a different signer is
 *  not yet a negative one — the maker may be a contract whose ERC-1271 answer needs a read. */
export async function recoverEoaSigner(orderHash: `0x${string}`, signature: `0x${string}`): Promise<{ signer: `0x${string}` } | { signer: null; reason: string }> {
  try {
    return { signer: await recoverAddress({ hash: orderHash, signature }) };
  } catch (err) {
    return { signer: null, reason: err instanceof Error ? err.message : "the signature could not be parsed" };
  }
}

/** The disclosure an EOA verdict carries when the account type could not be established —
 *  one sentence per cause, shared by every consumer. `consequence` names what the caller did
 *  with the order anyway. */
export function makerCodeUnknownWarning(probe: Exclude<MakerCodeProbe, "has-code">, consequence: string): Warning | null {
  if (probe === "no-code") return null;
  const cause = probe === "no-rpc" ? "no RPC resolved to check whether the maker has code" : "the maker's code could not be read (the RPC call failed)";
  return { code: "chain_read_failed", message: `${cause} — the signature ecrecovers to the maker, so ${consequence}; if the maker is actually a contract account, retry with an RPC available` };
}

// ── 2 + 3 as one gate for the BUILD paths (fill, refresh) ───────────────────────────────────

export type SignedOrderAuthentication =
  | { ok: true; makerAccountType: "EOA" | "ERC1271"; warnings: Warning[]; source: "chain" | "config" }
  | { ok: false; envelope: Envelope };

/** Authenticate a signed order before building anything on it: the extension rule, then the
 *  signature ladder. Identity (the re-hash) stays with the caller — its data echo differs per
 *  acquisition path (requested vs venue-claimed hash) — and liveness stays with the shared
 *  tails that already read the invalidator. `consequence` is the sentence tail every refusal
 *  ends on ("no fill bytes were built"); `echo` rides in the refusal's data beside the standard
 *  fields. An indeterminate outcome (a transport failure on the code probe or the ERC-1271
 *  call) is `unavailable`, never a verdict: the fill path requires those exact reads to answer. */
export async function authenticateSignedOrder(a: {
  ctx: HandlerContext;
  chainId: ChainId;
  order: LopOrder;
  orderHash: `0x${string}`;
  signature: `0x${string}`;
  extension: `0x${string}`;
  consequence: string;
  echo?: Record<string, unknown>;
}): Promise<SignedOrderAuthentication> {
  const { ctx, chainId, order, orderHash } = a;
  const echo = a.echo ?? {};
  const ext = extensionVerdict(order, a.extension);
  if (!ext.valid) {
    return { ok: false, envelope: envelope({ state: "conflict", data: { ...echo, orderHash, extensionFault: ext.reason }, chainId, source: "config", warnings: [{ code: "signature_or_reconstruction_mismatch", message: `${ext.message}; ${a.consequence}` }], ctx }) };
  }
  const verdict = await verifyMakerSignatureLadder({ ctx, chainId, maker: order.maker, orderHash, signature: a.signature });
  if (verdict.kind === "erc1271_transport") {
    return { ok: false, envelope: unavailable(chainId, "chain_read_failed", `the maker ${order.maker} is a CONTRACT account but its isValidSignature staticcall failed in transport (${verdict.reason}) — the ERC-1271 signature could not be verified either way; retry with a working RPC (the fill path requires this exact call to answer)`, ctx) };
  }
  if (verdict.kind === "eoa_mismatch" && verdict.codeProbe === "read-failed") {
    // Indeterminate, not a verdict: the signature does not ecrecover to the maker, and the read
    // that would say whether the maker is a contract (whose ERC-1271 answer is the real test)
    // failed in transport. Refusing this as a mismatch would attribute an RPC outage to the
    // order (the DB-007 class).
    return { ok: false, envelope: unavailable(chainId, "chain_read_failed", `the signature recovers to ${verdict.recoveredSigner}, not the order maker ${order.maker}, and the maker's code could not be read (the RPC call failed) — so whether the maker is a contract account whose ERC-1271 answer would validate it is unknown; retry with a working RPC. ${a.consequence}`, ctx) };
  }
  if (verdict.kind === "erc1271_rejected" || verdict.kind === "eoa_mismatch" || verdict.kind === "unparseable") {
    return {
      ok: false,
      envelope: envelope({
        state: "conflict",
        data: { ...echo, orderHash, maker: order.maker, ...(verdict.kind === "erc1271_rejected" ? { makerAccountType: "ERC1271", isValidSignatureAnswer: verdict.isValidSignatureAnswer } : {}), ...(verdict.kind === "eoa_mismatch" ? { recoveredSigner: verdict.recoveredSigner } : {}) },
        chainId,
        source: verdict.kind === "erc1271_rejected" ? "chain" : "config",
        warnings: [{
          code: "signature_or_reconstruction_mismatch",
          message:
            verdict.kind === "erc1271_rejected"
              ? `the maker ${order.maker} is a CONTRACT account and its isValidSignature(orderHash, signature) did not answer the ERC-1271 magic value — the fill runs this exact staticcall, so these bytes can only revert; ${a.consequence}. (For a Safe, the hash must have been approved/signed per its own ERC-1271 scheme.)`
              : verdict.kind === "eoa_mismatch"
                ? `the signature recovers to ${verdict.recoveredSigner}, not the order maker ${order.maker} — the fill would revert on it, so ${a.consequence}.${verdict.codeProbe === "no-rpc" ? " If the maker is a CONTRACT account (ERC-1271, e.g. a Safe), make sure an RPC resolves (CORK_RPC_URL) so the maker's code can be detected" : " The maker has no code (an EOA), so no ERC-1271 path can validate this signature either"}`
                : `${verdict.reason} — ${a.consequence}`,
        }],
        ctx,
      }),
    };
  }
  const warnings: Warning[] = [];
  if (verdict.kind === "eoa") {
    const w = makerCodeUnknownWarning(verdict.codeProbe, "it is treated as an EOA order");
    if (w) warnings.push(w);
  }
  return { ok: true, makerAccountType: verdict.kind === "erc1271" ? "ERC1271" : "EOA", warnings, source: verdict.kind === "erc1271" ? "chain" : "config" };
}

// ── the BOOK's per-row leg ──────────────────────────────────────────────────────────────────

/** What a served book row says about its maker's signature. `eoa-verified` is settled
 *  chain-free (ecrecover to the maker); `erc1271-verified` needed the staticcall; `unverified`
 *  means the signature does not ecrecover to the maker AND nobody could ask the maker (no RPC,
 *  out of budget, or a transport failure) — a contract maker that could not be consulted, or
 *  a forgery nobody could refute yet. A row refuted either way is dropped, never labeled. */
export type BookMakerSignature = "eoa-verified" | "erc1271-verified" | "unverified";

/** The per-row authenticity leg for a row whose signature PARSED but did NOT ecrecover to its
 *  maker (both settled chain-free by the book's first half; an unparseable signature is
 *  dropped there). Only the chain can finish the question: the maker has no code → an EOA that
 *  never signed it (refuted); the maker has code → its own isValidSignature answer decides
 *  (verified, or refuted); the code read or the staticcall failed in transport → nobody could
 *  ask (indeterminate, the row stays `unverified`). No second ecrecover: its answer is the
 *  premise. */
export type BookSignatureOutcome = { outcome: "verified" } | { outcome: "refuted"; why: string } | { outcome: "indeterminate" };

export async function authenticateBookRowSignature(client: MakerCodeClient, a: { maker: `0x${string}`; orderHash: `0x${string}`; signature: `0x${string}` }): Promise<BookSignatureOutcome> {
  const probe = await probeMakerCode(client, a.maker);
  if (probe === "no-code") return { outcome: "refuted", why: "the signature does not recover to the maker, an EOA" };
  if (probe !== "has-code") return { outcome: "indeterminate" }; // read-failed (no-rpc cannot occur: the client is in hand)
  const verdict = await checkContractMakerSignature(client, a);
  if (verdict.kind === "erc1271") return { outcome: "verified" };
  if (verdict.kind === "erc1271_rejected") return { outcome: "refuted", why: "the contract maker's isValidSignature rejected the signature" };
  return { outcome: "indeterminate" };
}
