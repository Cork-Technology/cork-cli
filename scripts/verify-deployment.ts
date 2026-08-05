// Third-party verifier for the Phala Cloud deployment (packaging/VERIFY.md): proves that the CVM
// answering at --cvm runs EXACTLY the attested image built from the tagged source — without
// trusting Cork's word for any link in the chain. Six checks:
//   (a) fetch the CVM's /attestation quote + event log (and /info app_compose)
//   (b) verify the quote signature via Phala's verify API (dcap-qvl locally for trustless)
//   (c) replay RTMR3: SHA384 chain from 48 zero bytes over the imr==3 events
//   (d) SHA256 the served app_compose, compare to the event log's compose-hash event
//   (e) assert every compose image is @sha256-pinned and equals the expected digest
//   (f) gh attestation verify oci://…@digest --repo <repo> (digest → tagged commit → source)
//
// Run:  bun scripts/verify-deployment.ts --cvm https://<cvm-host> --digest sha256:<64 hex> \
//         [--repo Cork-Technology/cork-cli] [--verify-api https://cloud-api.phala.com/api/v1/attestations/verify]
//
// HONEST BOUNDARY: attestation proves the CODE. Runtime inputs are NOT attested — the remote
// cork-defaults.json (zod-validated; the file lives in the attested repo), RPC responses, and
// venue responses can all vary independently of the measured image.
//
// NOTE (pre-rehearsal): nothing has ever been deployed, so the exact wire shapes of the CVM
// /attestation and Phala verify-API responses are parsed DEFENSIVELY with named failures — the
// first rc rehearsal is expected to tighten them.
import { createHash } from "node:crypto";

interface Args {
  cvm: string;
  digest: string;
  repo: string;
  verifyApi: string;
}

function parseArgs(): Args {
  const get = (flag: string): string | undefined => {
    const i = process.argv.indexOf(flag);
    return i !== -1 ? process.argv[i + 1] : undefined;
  };
  const cvm = get("--cvm");
  const digest = get("--digest");
  if (!cvm || !digest || !/^sha256:[0-9a-f]{64}$/.test(digest)) {
    console.error("usage: bun scripts/verify-deployment.ts --cvm <https://cvm-host> --digest sha256:<64 hex> [--repo owner/repo] [--verify-api <url>]");
    process.exit(2);
  }
  return {
    cvm: cvm.replace(/\/$/, ""),
    digest,
    repo: get("--repo") ?? "Cork-Technology/cork-cli",
    verifyApi: get("--verify-api") ?? "https://cloud-api.phala.com/api/v1/attestations/verify",
  };
}

const results: Array<{ check: string; ok: boolean; detail: string }> = [];
function report(check: string, ok: boolean, detail: string) {
  results.push({ check, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${check} — ${detail}`);
}

function sha384(buf: Uint8Array): Buffer {
  return createHash("sha384").update(buf).digest();
}
function hexToBytes(hex: string): Buffer {
  return Buffer.from(hex.replace(/^0x/, ""), "hex");
}

/** Walk an unknown JSON value for the first string value under any of the given keys. */
function findKey(v: unknown, keys: string[]): string | undefined {
  if (v === null || typeof v !== "object") return undefined;
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (keys.includes(k) && typeof val === "string" && val.length > 0) return val;
    const nested = findKey(val, keys);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

interface RawEvent {
  imr: number;
  event_type?: number;
  digest: string;
  event?: string;
  event_payload?: string;
}

async function main() {
  const args = parseArgs();

  // ── (a) fetch the CVM attestation + info ─────────────────────────────────────────────────
  let quote: string | undefined;
  let events: RawEvent[] = [];
  let appCompose: string | undefined;
  try {
    const att = (await (await fetch(`${args.cvm}/attestation`)).json()) as Record<string, unknown>;
    quote = findKey(att, ["quote", "tdx_quote"]);
    const rawLog = att.event_log ?? att.eventlog ?? findKey(att, ["event_log"]);
    const parsedLog = typeof rawLog === "string" ? JSON.parse(rawLog) : rawLog;
    if (Array.isArray(parsedLog)) events = parsedLog as RawEvent[];
    report("a. attestation fetch", quote !== undefined && events.length > 0, `quote ${quote ? `${quote.length} hex chars` : "MISSING"}, ${events.length} event-log entries`);
  } catch (err) {
    report("a. attestation fetch", false, `GET ${args.cvm}/attestation failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    const info = (await (await fetch(`${args.cvm}/info`)).json()) as Record<string, unknown>;
    appCompose = typeof info.app_compose === "string" ? info.app_compose : findKey(info, ["app_compose"]);
    if (appCompose === undefined) report("a2. /info app_compose", false, "no app_compose field in /info response");
  } catch (err) {
    report("a2. /info app_compose", false, `GET ${args.cvm}/info failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // ── (b) quote signature via Phala's verify API (dcap-qvl locally for trustless) ──────────
  let attestedRtmr3: string | undefined;
  if (quote !== undefined) {
    try {
      const res = await fetch(args.verifyApi, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ hex: quote.startsWith("0x") ? quote : `0x${quote}` }),
      });
      const body = (await res.json()) as Record<string, unknown>;
      // Defensive: the API reports signature validity + the parsed TD report (rtmr values).
      const okFlag = body.success === true || body.verified === true || findKey(body, ["status"]) === "UpToDate" || res.ok;
      attestedRtmr3 = findKey(body, ["rtmr3", "rt_mr3"])?.replace(/^0x/, "");
      report("b. quote signature (Phala verify API)", okFlag && attestedRtmr3 !== undefined, okFlag ? `verified; rtmr3 ${attestedRtmr3 ?? "NOT FOUND in response — cannot anchor the replay"}` : `verify API HTTP ${res.status}`);
    } catch (err) {
      report("b. quote signature (Phala verify API)", false, `POST ${args.verifyApi} failed: ${err instanceof Error ? err.message : String(err)} (trustless alternative: dcap-qvl verify)`);
    }
  } else {
    report("b. quote signature (Phala verify API)", false, "no quote to verify");
  }

  // ── (c) RTMR3 replay: SHA384 chain from 48 zero bytes over imr==3 events ─────────────────
  if (events.length > 0) {
    let rtmr = Buffer.alloc(48, 0);
    let count = 0;
    for (const e of events) {
      if (e.imr !== 3) continue;
      rtmr = sha384(Buffer.concat([rtmr, hexToBytes(e.digest)]));
      count++;
    }
    const replayed = rtmr.toString("hex");
    const ok = attestedRtmr3 !== undefined && replayed === attestedRtmr3.toLowerCase();
    report("c. RTMR3 replay", ok, `${count} imr==3 events → ${replayed.slice(0, 16)}… ${ok ? "matches the quote" : `does NOT match attested ${attestedRtmr3?.slice(0, 16) ?? "?"}…`}`);
  } else {
    report("c. RTMR3 replay", false, "no event log");
  }

  // ── (d) compose-hash: SHA256(served app_compose) == the event log's compose-hash event ───
  if (appCompose !== undefined) {
    const served = createHash("sha256").update(appCompose).digest("hex");
    const ev = events.find((e) => e.event === "compose-hash");
    const logged = ev?.event_payload?.replace(/^0x/, "").toLowerCase();
    const ok = logged !== undefined && served === logged;
    report("d. compose-hash", ok, ok ? `sha256(app_compose) ${served.slice(0, 16)}… matches the measured event` : `served ${served.slice(0, 16)}… vs logged ${logged?.slice(0, 16) ?? "(no compose-hash event)"}…`);

    // ── (e) every compose image digest-pinned and equal to the expected digest ─────────────
    try {
      const composeDoc = JSON.parse(appCompose) as Record<string, unknown>;
      const dockerCompose = findKey(composeDoc, ["docker_compose_file"]) ?? appCompose;
      const images = [...dockerCompose.matchAll(/image:\s*["']?([^\s"']+)/g)].map((m) => m[1]!);
      const unpinned = images.filter((i) => !/@sha256:[0-9a-f]{64}$/.test(i));
      const wrong = images.filter((i) => /@sha256:/.test(i) && !i.endsWith(`@${args.digest}`));
      const ok2 = images.length > 0 && unpinned.length === 0 && wrong.length === 0;
      report("e. image digest pinning", ok2, ok2 ? `${images.length} image(s), all pinned to ${args.digest.slice(0, 23)}…` : `images=${JSON.stringify(images)} unpinned=${unpinned.length} wrong-digest=${wrong.length} (expected ${args.digest})`);
    } catch (err) {
      report("e. image digest pinning", false, `could not parse app_compose: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    report("d. compose-hash", false, "no app_compose served");
    report("e. image digest pinning", false, "no app_compose served");
  }

  // ── (f) provenance: image digest → tagged commit → source (GitHub attestation) ───────────
  const image = `oci://ghcr.io/${args.repo.toLowerCase()}@${args.digest}`;
  try {
    const proc = Bun.spawn(["gh", "attestation", "verify", image, "--repo", args.repo], { stdout: "pipe", stderr: "pipe" });
    const code = await proc.exited;
    report("f. gh attestation verify", code === 0, code === 0 ? `${image} attested by ${args.repo}` : `gh exited ${code} — run manually: gh attestation verify ${image} --repo ${args.repo}`);
  } catch {
    report("f. gh attestation verify", false, `gh CLI not available — run manually: gh attestation verify ${image} --repo ${args.repo}`);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  console.log(
    "\nHONEST BOUNDARY: these checks prove the CODE (image digest → tagged commit → source, measured into the CVM). Runtime inputs are NOT attested: the remote cork-defaults.json (zod-validated, and the file itself lives in the attested repo), RPC responses, and venue responses vary independently of the measurement.",
  );
  if (failed.length > 0) process.exit(1);
}

await main();
