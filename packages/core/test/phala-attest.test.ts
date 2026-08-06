// Phala/dstack attestation logic — every check that verify-deployment.ts stakes a verdict on.
// The replay expectation is recomputed INDEPENDENTLY in-test (own crypto calls, not the module
// under test); the quote parser is anchored to a REAL dstack CVM quote (Phala's own dcap-qvl
// sample data, fixtures/tdx-quote-from-tappd.hex); the image-pin check runs against this repo's
// ACTUAL packaging/phala-compose.yml — the file the deploy pipeline substitutes.
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  checkComposeHash,
  checkImagePins,
  composeHashFromEvents,
  extractDockerComposeFile,
  parseTdxQuote,
  replayRtmr3,
  type RtmrEvent,
  sha256Hex,
} from "@cork/core";

const REAL_QUOTE_HEX = readFileSync(join(import.meta.dirname, "fixtures", "tdx-quote-from-tappd.hex"), "utf8").trim();
const REAL_COMPOSE = readFileSync(join(import.meta.dirname, "..", "..", "..", "packaging", "phala-compose.yml"), "utf8");

const h384 = (b: Buffer) => createHash("sha384").update(b).digest();

/** A realistic dstack boot event log: the three imr==3 boot events the docs name, plus imr 0-2
 *  firmware noise that the replay must ignore. Digests are SHA384(payload) like dstack computes. */
function realisticEventLog(composeHash: string): RtmrEvent[] {
  const ev = (imr: number, event: string, payload: string): RtmrEvent => ({
    imr,
    event_type: 134217729,
    digest: h384(Buffer.from(`${event}:${payload}`)).toString("hex"),
    event,
    event_payload: payload,
  });
  return [
    { imr: 0, event_type: 2147483659, digest: h384(Buffer.from("td_hob")).toString("hex") },
    { imr: 1, event_type: 2147483651, digest: h384(Buffer.from("kernel")).toString("hex") },
    { imr: 2, event_type: 6, digest: h384(Buffer.from("initrd")).toString("hex") },
    ev(3, "system-preparing", ""),
    ev(3, "app-id", "00".repeat(20)),
    ev(3, "compose-hash", composeHash),
    ev(3, "instance-id", "11".repeat(20)),
    ev(3, "key-provider", '{"name":"kms","id":"beef"}'),
    ev(3, "boot-mr-done", ""),
  ];
}

describe("replayRtmr3 — the SHA384 measurement chain", () => {
  it("matches an independent recomputation over the imr==3 subset, in order", () => {
    const log = realisticEventLog(sha256Hex("app-compose"));
    // Independent recomputation: same algorithm, hand-rolled here (no module code).
    let expected = Buffer.alloc(48, 0);
    for (const e of log) {
      if (e.imr !== 3) continue;
      expected = h384(Buffer.concat([expected, Buffer.from(e.digest, "hex")]));
    }
    expect(replayRtmr3(log)).toBe(expected.toString("hex"));
    // And it must NOT equal a replay over ALL events — the imr filter is load-bearing.
    let allImrs = Buffer.alloc(48, 0);
    for (const e of log) allImrs = h384(Buffer.concat([allImrs, Buffer.from(e.digest, "hex")]));
    expect(replayRtmr3(log)).not.toBe(allImrs.toString("hex"));
  });

  it("is order-sensitive (a reordered log measures differently)", () => {
    const log = realisticEventLog(sha256Hex("x"));
    const swapped = [...log];
    [swapped[3], swapped[5]] = [swapped[5]!, swapped[3]!];
    expect(replayRtmr3(swapped)).not.toBe(replayRtmr3(log));
  });

  it("right-pads short digests to 48 bytes (documented replay detail)", () => {
    const short: RtmrEvent = { imr: 3, digest: "aa".repeat(32) }; // 32 bytes, e.g. a SHA256
    const padded: RtmrEvent = { imr: 3, digest: "aa".repeat(32) + "00".repeat(16) };
    expect(replayRtmr3([short])).toBe(replayRtmr3([padded]));
    // and the padding is on the RIGHT: left-padding would measure differently
    const leftPadded: RtmrEvent = { imr: 3, digest: "00".repeat(16) + "aa".repeat(32) };
    expect(replayRtmr3([short])).not.toBe(replayRtmr3([leftPadded]));
  });

  it("an empty (or imr<3-only) log replays to the pristine register", () => {
    // 48 zero bytes never hashed — the initial RTMR value itself.
    expect(replayRtmr3([])).toBe("00".repeat(48));
    expect(replayRtmr3([{ imr: 1, digest: "ab".repeat(48) }])).toBe("00".repeat(48));
  });

  it("rejects malformed digests instead of measuring garbage", () => {
    expect(() => replayRtmr3([{ imr: 3, digest: "zz" }])).toThrow(/not valid hex/);
    expect(() => replayRtmr3([{ imr: 3, digest: "ab".repeat(49) }])).toThrow(/longer than 48/);
  });
});

describe("parseTdxQuote — measurement extraction from the signed bytes", () => {
  it("extracts a populated RTMR3 from a REAL dstack CVM quote (v4, TDX)", () => {
    const q = parseTdxQuote(REAL_QUOTE_HEX);
    expect(q.version).toBe(4);
    expect(q.teeType).toBe(0x81);
    // Empirical anchor: this real CVM quote's registers, pinned byte-for-byte. If the offsets
    // drift, these change — the strongest possible regression net for pure byte math.
    expect(q.rtmr3).toBe("a2d25bc888a93009af5b70eadb410e9071d18387e4db39aae20fe767f5c4279d95e6519c5d797938a90694599c5bea7a");
    expect(q.rtmr1).toBe("918fbd97108e05450afa6aca140c6363ab913578b66cc312e3e8542ce5ade455a30c8d9e4d53a5e43d81955f76140279");
    expect(q.reportData).toHaveLength(128);
  });

  it("parses a v5 envelope (body descriptor before the same TD report layout)", () => {
    const raw = Buffer.from(REAL_QUOTE_HEX.replace(/^0x/, ""), "hex");
    const v4 = parseTdxQuote(REAL_QUOTE_HEX);
    // Wrap the REAL v4 body as a v5 quote: patch version, insert body_type/body_size.
    const header = Buffer.from(raw.subarray(0, 48));
    header.writeUInt16LE(5, 0);
    const body = raw.subarray(48);
    const desc = Buffer.alloc(6);
    desc.writeUInt16LE(2, 0); // TDReport10
    desc.writeUInt32LE(body.length, 2);
    const v5 = parseTdxQuote(Buffer.concat([header, desc, body]).toString("hex"));
    expect(v5.version).toBe(5);
    expect(v5.rtmr3).toBe(v4.rtmr3);
    expect(v5.mrTd).toBe(v4.mrTd);
  });

  it("refuses non-TDX, unknown versions, and truncated bodies", () => {
    const raw = Buffer.from(REAL_QUOTE_HEX.replace(/^0x/, ""), "hex");
    const sgx = Buffer.from(raw);
    sgx.writeUInt32LE(0, 4);
    expect(() => parseTdxQuote(sgx.toString("hex"))).toThrow(/not a TDX quote/);
    const v9 = Buffer.from(raw);
    v9.writeUInt16LE(9, 0);
    expect(() => parseTdxQuote(v9.toString("hex"))).toThrow(/unsupported quote version/);
    expect(() => parseTdxQuote(raw.subarray(0, 100).toString("hex"))).toThrow(/too short/);
  });
});

describe("compose-hash and image pinning — the checks that bind the CVM to the release", () => {
  const DIGEST = `sha256:${"ab".repeat(32)}` as const;
  // replaceAll, like the workflow's sed: the file's comment block also contains the literal
  // placeholder, and a first-occurrence replace would leave the image line unsubstituted —
  // which checkImagePins correctly refuses (pinned below as the template negative case).
  const composeWithDigest = REAL_COMPOSE.replaceAll("${DIGEST}", DIGEST);
  const appCompose = JSON.stringify({ manifest_version: 2, name: "cork-mcp", runner: "docker-compose", docker_compose_file: composeWithDigest });

  it("SHA256(served app_compose) must equal the measured compose-hash event", () => {
    const events = realisticEventLog(sha256Hex(appCompose));
    expect(checkComposeHash(appCompose, events)).toMatchObject({ ok: true, served: sha256Hex(appCompose) });
    // One byte of drift in the served document fails the check.
    expect(checkComposeHash(appCompose + " ", events).ok).toBe(false);
    // A log with no compose-hash event cannot pass.
    expect(checkComposeHash(appCompose, events.filter((e) => e.event !== "compose-hash")).ok).toBe(false);
    expect(composeHashFromEvents(events)).toBe(sha256Hex(appCompose));
  });

  it("this repo's ACTUAL phala-compose.yml (digest-substituted) passes the pin check", () => {
    const compose = extractDockerComposeFile(appCompose);
    const res = checkImagePins(compose, DIGEST);
    expect(res).toMatchObject({ ok: true, unpinned: [], wrongDigest: [] });
    expect(res.images).toEqual([`ghcr.io/cork-technology/cork-cli@${DIGEST}`]);
  });

  it("catches every pinning failure mode: floating tag, wrong digest, empty compose", () => {
    const floating = checkImagePins("services:\n  a:\n    image: ghcr.io/cork-technology/cork-cli:latest\n", DIGEST);
    expect(floating.ok).toBe(false);
    expect(floating.unpinned).toHaveLength(1);
    const wrong = checkImagePins(`services:\n  a:\n    image: ghcr.io/x/y@sha256:${"cd".repeat(32)}\n`, DIGEST);
    expect(wrong.ok).toBe(false);
    expect(wrong.wrongDigest).toHaveLength(1);
    // No images at all is a FAILURE, not a vacuous pass — the check must find something to bless.
    expect(checkImagePins("services: {}\n", DIGEST).ok).toBe(false);
    // The UNSUBSTITUTED template must fail too: a deploy that forgot the digest substitution
    // would ship image `…@${DIGEST}` — the same guard the workflow's post-sed grep performs.
    expect(checkImagePins(REAL_COMPOSE, DIGEST).ok).toBe(false);
  });

  it("extractDockerComposeFile demands the documented dstack shape", () => {
    expect(() => extractDockerComposeFile("not json")).toThrow(/not JSON/);
    expect(() => extractDockerComposeFile("{}")).toThrow(/docker_compose_file/);
    expect(extractDockerComposeFile(appCompose)).toBe(composeWithDigest);
  });
});
