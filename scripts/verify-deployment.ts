// Third-party verifier for the Phala Cloud deployment (packaging/VERIFY.md): proves that the CVM
// answering at --cvm runs EXACTLY the attested image built from the tagged source — without
// trusting Cork's word for any link in the chain. Thin shell: all verdict logic lives in
// packages/core/src/phala-attest.ts (unit- and mutation-tested); this file only does I/O.
//
// The six checks:
//   (a) fetch the CVM's /attestation quote + event log, and /info app_compose
//       (documented shapes: {quote, event_log, report_data}; tcb_info.app_compose)
//   (b) quote signature via Phala's verify API — success is result.quote.verified, nothing
//       weaker (dcap-qvl locally for the trustless alternative)
//   (c) replay RTMR3 (SHA384 chain, 48 zero bytes, imr==3 events) and compare against the
//       RTMR3 parsed LOCALLY from the signed quote bytes — no service response in this loop
//   (d) SHA256 the served app_compose vs the event log's compose-hash event
//   (e) every compose image @sha256-pinned and equal to the expected released digest
//   (f) gh attestation verify oci://…@digest --repo <repo> (digest → tagged commit → source)
//
// Run:  bun scripts/verify-deployment.ts --cvm https://<cvm-host> --digest sha256:<64 hex> \
//         [--repo Cork-Technology/cork-cli] [--verify-api https://cloud-api.phala.com/api/v1/attestations/verify]
//
// HONEST BOUNDARY: attestation proves the CODE. Runtime inputs are NOT attested — the remote
// cork-defaults.json (zod-validated; the file lives in the attested repo), RPC responses, and
// venue responses can all vary independently of the measured image.
import { checkComposeHash, checkImagePins, extractDockerComposeFile, parseTdxQuote, replayRtmr3, type RtmrEvent } from "../packages/core/src/phala-attest.ts";

interface Args {
  cvm: string;
  digest: `sha256:${string}`;
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
    digest: digest as `sha256:${string}`,
    repo: get("--repo") ?? "Cork-Technology/cork-cli",
    verifyApi: get("--verify-api") ?? "https://cloud-api.phala.com/api/v1/attestations/verify",
  };
}

const results: Array<{ check: string; ok: boolean; detail: string }> = [];
function report(check: string, ok: boolean, detail: string) {
  results.push({ check, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${check} — ${detail}`);
}

async function getJson(url: string): Promise<Record<string, unknown>> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}

async function main() {
  const args = parseArgs();

  // ── (a) fetch the CVM attestation + info ─────────────────────────────────────────────────
  let quote: string | undefined;
  let events: RtmrEvent[] = [];
  let appCompose: string | undefined;
  try {
    const att = await getJson(`${args.cvm}/attestation`);
    if (typeof att.quote === "string" && att.quote.length > 0) quote = att.quote;
    // Documented: event_log is a JSON-encoded array (some builds inline it as an array).
    const rawLog = att.event_log;
    const parsedLog: unknown = typeof rawLog === "string" ? JSON.parse(rawLog) : rawLog;
    if (Array.isArray(parsedLog)) events = parsedLog as RtmrEvent[];
    report("a. attestation fetch", quote !== undefined && events.length > 0, `quote ${quote ? `${quote.length} hex chars` : "MISSING (.quote)"}, ${events.length} event-log entries`);
  } catch (err) {
    report("a. attestation fetch", false, `${args.cvm}/attestation: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    const info = await getJson(`${args.cvm}/info`);
    // Documented path: tcb_info.app_compose — tcb_info arrives as an object or a JSON string.
    const tcb: unknown = typeof info.tcb_info === "string" ? JSON.parse(info.tcb_info) : info.tcb_info;
    const compose = (tcb as Record<string, unknown> | null | undefined)?.app_compose;
    if (typeof compose === "string" && compose.length > 0) appCompose = compose;
    if (appCompose === undefined) report("a2. /info app_compose", false, "no tcb_info.app_compose in the /info response");
  } catch (err) {
    report("a2. /info app_compose", false, `${args.cvm}/info: ${err instanceof Error ? err.message : String(err)}`);
  }

  // ── (b) quote signature via Phala's verify API ───────────────────────────────────────────
  if (quote !== undefined) {
    try {
      const res = await fetch(args.verifyApi, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ hex: quote.startsWith("0x") ? quote : `0x${quote}` }),
      });
      const body = (await res.json()) as { quote?: { verified?: unknown } };
      // The documented success signal — and ONLY it. (HTTP 200 alone proves the API answered,
      // not that the signature verified; treating it as success was a bug this rewrite fixes.)
      const verified = body.quote?.verified === true;
      report("b. quote signature (Phala verify API)", verified, verified ? "quote.verified = true" : `quote.verified was ${JSON.stringify(body.quote?.verified)} (HTTP ${res.status}); trustless alternative: dcap-qvl verify`);
    } catch (err) {
      report("b. quote signature (Phala verify API)", false, `POST ${args.verifyApi}: ${err instanceof Error ? err.message : String(err)} (trustless alternative: dcap-qvl verify)`);
    }
  } else {
    report("b. quote signature (Phala verify API)", false, "no quote to verify");
  }

  // ── (c) RTMR3 replay vs the register parsed LOCALLY from the signed quote bytes ──────────
  if (quote !== undefined && events.length > 0) {
    try {
      const parsed = parseTdxQuote(quote);
      const replayed = replayRtmr3(events);
      const ok = replayed === parsed.rtmr3.toLowerCase();
      report("c. RTMR3 replay", ok, ok ? `event log replays to the quote's RTMR3 (${replayed.slice(0, 16)}…)` : `replayed ${replayed.slice(0, 16)}… ≠ quote rtmr3 ${parsed.rtmr3.slice(0, 16)}…`);
    } catch (err) {
      report("c. RTMR3 replay", false, err instanceof Error ? err.message : String(err));
    }
  } else {
    report("c. RTMR3 replay", false, "needs both the quote and the event log");
  }

  // ── (d) compose-hash + (e) image digest pinning ──────────────────────────────────────────
  if (appCompose !== undefined) {
    const ch = checkComposeHash(appCompose, events);
    report("d. compose-hash", ch.ok, ch.ok ? `sha256(app_compose) matches the measured event (${ch.served.slice(0, 16)}…)` : `served ${ch.served.slice(0, 16)}… vs logged ${ch.logged?.slice(0, 16) ?? "(no compose-hash event)"}…`);
    try {
      const pins = checkImagePins(extractDockerComposeFile(appCompose), args.digest);
      report("e. image digest pinning", pins.ok, pins.ok ? `${pins.images.length} image(s), all pinned to ${args.digest.slice(0, 23)}…` : `images=${JSON.stringify(pins.images)} unpinned=${pins.unpinned.length} wrong-digest=${pins.wrongDigest.length} (expected ${args.digest})`);
    } catch (err) {
      report("e. image digest pinning", false, err instanceof Error ? err.message : String(err));
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
