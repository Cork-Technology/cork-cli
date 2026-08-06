// Phala/dstack attestation verification — the PURE logic behind scripts/verify-deployment.ts
// (thin shell over this module, per the one-typed-core architecture). Everything here is local
// byte math over caller-supplied bytes: no fetches, no trust in any service's parse [K3].
//
// Grounded empirically 2026-08-06 against:
//   - docs.phala.com/phala-cloud/attestation/verify-your-application.md (replay algorithm,
//     endpoint/field names: /attestation → {quote, event_log, report_data}; /info →
//     tcb_info.app_compose; verify API success = result.quote.verified; compose-hash =
//     SHA256(app_compose) vs the event log's `compose-hash` event_payload)
//   - Intel TDX DCAP quote layout (v4: 48-byte header + TDReport10 body; v5: header +
//     2-byte body_type + 4-byte body_size + body; TDReport15 shares the TDReport10 prefix)
//   - a REAL dstack CVM quote (test/fixtures/tdx-quote-from-tappd.hex, from Phala's own
//     dcap-qvl sample data) — the offsets below extract its populated RTMR3.
import { createHash } from "node:crypto";

// ── event log ────────────────────────────────────────────────────────────────────────────────

/** One dstack runtime event-log entry (the /attestation `event_log`, parsed from JSON). */
export interface RtmrEvent {
  imr: number;
  event_type?: number;
  /** SHA384 digest measured into the RTMR (hex, with or without 0x). */
  digest: string;
  /** Event name — boot events are `compose-hash`, `instance-id`, `key-provider`, …. */
  event?: string;
  /** Event payload — for `compose-hash` this is the SHA256 hex of app_compose. */
  event_payload?: string;
}

function sha384(buf: Uint8Array): Buffer {
  return createHash("sha384").update(buf).digest();
}

export function sha256Hex(s: string | Uint8Array): string {
  return createHash("sha256").update(s).digest("hex");
}

function hexToBytes(hex: string): Buffer {
  const clean = hex.replace(/^0x/, "");
  if (!/^[0-9a-fA-F]*$/.test(clean) || clean.length % 2 !== 0) {
    throw new Error(`not valid hex: ${hex.slice(0, 32)}…`);
  }
  return Buffer.from(clean, "hex");
}

/** Replay the RTMR3 register from the event log: starting from 48 zero bytes,
 *  `RTMR3 = SHA384(RTMR3 || digest)` over every event with `imr === 3`, in log order; a short
 *  digest is right-padded with zeros to 48 bytes (per the documented replay). Returns lowercase
 *  hex — compare against the RTMR3 extracted from the signed quote. */
export function replayRtmr3(events: readonly RtmrEvent[]): string {
  let rtmr: Buffer = Buffer.alloc(48, 0);
  for (const e of events) {
    if (e.imr !== 3) continue;
    let digest: Buffer = hexToBytes(e.digest);
    if (digest.length > 48) throw new Error(`event digest longer than 48 bytes (${digest.length}) — not an RTMR digest`);
    if (digest.length < 48) digest = Buffer.concat([digest, Buffer.alloc(48 - digest.length, 0)]);
    rtmr = sha384(Buffer.concat([rtmr, digest]));
  }
  return rtmr.toString("hex");
}

/** The event log's own claim of the compose hash: the `compose-hash` event's payload (hex). */
export function composeHashFromEvents(events: readonly RtmrEvent[]): string | undefined {
  return events.find((e) => e.event === "compose-hash")?.event_payload?.replace(/^0x/, "").toLowerCase();
}

/** Compare SHA256(served app_compose) against the event log's measured compose-hash. */
export function checkComposeHash(appCompose: string, events: readonly RtmrEvent[]): { served: string; logged: string | undefined; ok: boolean } {
  const served = sha256Hex(appCompose);
  const logged = composeHashFromEvents(events);
  return { served, logged, ok: logged !== undefined && served === logged };
}

// ── TDX quote parsing (v4/v5) ────────────────────────────────────────────────────────────────

export interface ParsedTdxQuote {
  version: 4 | 5;
  /** 0x81 = TDX. */
  teeType: number;
  mrTd: string;
  rtmr0: string;
  rtmr1: string;
  rtmr2: string;
  rtmr3: string;
  reportData: string;
}

const TEE_TYPE_TDX = 0x81;
// TDReport10 field offsets (TDReport15 shares this prefix): mrTd 136, rtmr0..3 from 328 in
// 48-byte strides, reportData 520..584.
const TD_REPORT10_LEN = 584;
const OFF = { mrTd: 136, rtmr0: 328, rtmr1: 376, rtmr2: 424, rtmr3: 472, reportData: 520 } as const;

/** Extract the measurement registers from a raw TDX DCAP quote (hex). Local and trustless — the
 *  RTMR3 anchor for the event-log replay comes from the SIGNED quote bytes, never from a
 *  verification service's response shape. (Signature validity over these bytes is a separate
 *  check: Phala's verify API, or dcap-qvl locally.) */
export function parseTdxQuote(quoteHex: string): ParsedTdxQuote {
  const raw = hexToBytes(quoteHex);
  if (raw.length < 48 + TD_REPORT10_LEN) throw new Error(`quote too short (${raw.length} bytes) for a TDX quote`);
  const version = raw.readUInt16LE(0);
  const teeType = raw.readUInt32LE(4);
  if (teeType !== TEE_TYPE_TDX) throw new Error(`not a TDX quote (tee_type 0x${teeType.toString(16)}, expected 0x81)`);
  let bodyStart: number;
  if (version === 4) {
    bodyStart = 48;
  } else if (version === 5) {
    // v5 inserts a body descriptor after the header: body_type u16 LE + body_size u32 LE.
    const bodyType = raw.readUInt16LE(48);
    if (bodyType !== 2 && bodyType !== 3) throw new Error(`v5 quote body_type ${bodyType} is not a TD report (2=TDReport10, 3=TDReport15)`);
    const bodySize = raw.readUInt32LE(50);
    if (bodySize < TD_REPORT10_LEN) throw new Error(`v5 quote body_size ${bodySize} shorter than a TD report`);
    bodyStart = 54;
  } else {
    throw new Error(`unsupported quote version ${version} (4 and 5 are implemented)`);
  }
  if (raw.length < bodyStart + TD_REPORT10_LEN) throw new Error("quote truncated: TD report body incomplete");
  const field = (off: number, len: number) => raw.subarray(bodyStart + off, bodyStart + off + len).toString("hex");
  return {
    version,
    teeType,
    mrTd: field(OFF.mrTd, 48),
    rtmr0: field(OFF.rtmr0, 48),
    rtmr1: field(OFF.rtmr1, 48),
    rtmr2: field(OFF.rtmr2, 48),
    rtmr3: field(OFF.rtmr3, 48),
    reportData: field(OFF.reportData, 64),
  };
}

// ── app-compose checks ───────────────────────────────────────────────────────────────────────

/** Pull the docker-compose text out of the app-compose JSON (dstack key: docker_compose_file). */
export function extractDockerComposeFile(appCompose: string): string {
  let doc: unknown;
  try {
    doc = JSON.parse(appCompose);
  } catch {
    throw new Error("app_compose is not JSON — expected the dstack app-compose document");
  }
  const file = (doc as Record<string, unknown> | null)?.docker_compose_file;
  if (typeof file !== "string" || file.length === 0) {
    throw new Error("app_compose has no docker_compose_file string — cannot check image pinning");
  }
  return file;
}

export interface ImagePinCheck {
  images: string[];
  unpinned: string[];
  wrongDigest: string[];
  ok: boolean;
}

/** Every compose image must be pinned `@sha256:…` AND equal the expected released digest — a
 *  floating tag makes the RTMR3 measurement meaningless (the hash would stop identifying code). */
export function checkImagePins(composeText: string, expectedDigest: `sha256:${string}`): ImagePinCheck {
  const images = [...composeText.matchAll(/^\s*image:\s*["']?([^\s"'#]+)/gm)].map((m) => m[1]!);
  const unpinned = images.filter((i) => !/@sha256:[0-9a-f]{64}$/.test(i));
  const wrongDigest = images.filter((i) => /@sha256:[0-9a-f]{64}$/.test(i) && !i.toLowerCase().endsWith(`@${expectedDigest.toLowerCase()}`));
  return { images, unpinned, wrongDigest, ok: images.length > 0 && unpinned.length === 0 && wrongDigest.length === 0 };
}
