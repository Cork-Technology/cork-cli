# Verifying the Cork MCP deployment (Phala Cloud CVM)

The hosted Cork MCP server runs inside a Phala Cloud **Confidential VM** (Intel TDX). This
document is the end-to-end recipe a third party follows to prove — without trusting Cork — that
the endpoint they are talking to runs **exactly the attested image built from the tagged source**.

The chain has three links, each independently checkable:

```
source at tag ──(melange SLSA provenance + release determinism gate)──▶ apk
apk ──(apko compose from the signed Pages repo, version-PINNED)──▶ image digest
image digest ──(GitHub attestation)──▶ ghcr.io/cork-technology/cork-cli@sha256:…
image digest ──(compose pin + RTMR3 measurement)──▶ the running CVM
```

## Quick run

```sh
bun scripts/verify-deployment.ts \
  --cvm https://<cvm-host> \
  --digest sha256:<the released image digest> \
  --repo Cork-Technology/cork-cli
```

The script performs the six checks below and exits non-zero if any fails.

## The six checks

1. **Fetch the CVM's attestation** — `GET <cvm>/attestation` returns the TDX quote and the
   runtime event log; `GET <cvm>/info` returns the effective `app_compose` (docker-compose +
   metadata) the CVM booted with.
2. **Verify the quote signature** — POST the quote to Phala's verify API
   (`https://cloud-api.phala.com/api/v1/attestations/verify`). Trust-minimized alternative:
   [dcap-qvl](https://github.com/Phala-Network/dcap-qvl) locally against Intel's PCS — no Phala
   service in the loop.
3. **Replay RTMR3** — the CVM measures boot-time facts into RTMR3 via a hardware event chain:
   starting from 48 zero bytes, `RTMR3 = SHA384(RTMR3 || event.digest)` over every event with
   `imr == 3` (`compose-hash`, `instance-id`, `key-provider`, …). The replayed value must equal
   the RTMR3 inside the signed quote — proving the event log is the one the hardware measured.
4. **Compose hash** — `SHA256(app_compose)` as served by `/info` must equal the event log's
   `compose-hash` event payload. Together with (3), this proves the served compose is the
   measured compose.
5. **Digest pinning** — every `image:` in the compose must be pinned `@sha256:…` (a floating tag
   would make the measurement meaningless) and must equal the expected released digest. The
   deploy pipeline enforces this at substitution time; the verifier re-checks it from the
   *measured* compose.
6. **Provenance to source** —
   `gh attestation verify oci://ghcr.io/cork-technology/cork-cli@sha256:… --repo Cork-Technology/cork-cli`
   links the digest to the exact workflow run and tagged commit that built it. Beneath it:
   the apk carries melange `--generate-provenance` SLSA provenance, the apko spec pins
   `cork-cli=X.Y.Z-rN` (so an independent `apko build` resolves the same package), and the
   release workflow's determinism gate requires two independent builds to be byte-identical
   before anything publishes.

## Honest boundary

Attestation proves the **code**. It does **not** attest runtime inputs:

- the remote `cork-defaults.json` address config (zod-validated at load; the file itself lives in
  the attested repo, but the fetch happens at runtime),
- RPC responses from whichever endpoint the deployment's `CORK_RPC_URL`/defaults resolve to,
- venue (api-phoenix) responses.

A verified CVM can still be fed wrong chain data by its RPC. The tool's own posture mitigates
this (chain reads verified against CREATE2-derivable addresses, commitments recomputed locally
[K3]) but the boundary should be understood, not hand-waved.

## Deploy pipeline (what produces all of the above)

- `.github/workflows/release.yml` — determinism gate (two independent byte-identical builds),
  immutable release from attested bytes.
- `.github/workflows/apk-repo.yml` — melange build (SLSA provenance, signed index) → Pages
  publish (immutable apks) → apko publish (version-pinned, SBOM, digest attested) →
  **phala-deploy** (digest substituted into `packaging/phala-compose.yml`,
  `phala deploy -c … -n cork-mcp --wait`, name-keyed in-place update).
- Runtime secrets (`CORK_MCP_TOKEN`, `ENVIO_API_TOKEN`, a private `CORK_RPC_URL`, …) are set as
  **encrypted CVM secrets** in the Phala dashboard — never in the compose, never in git.

## One-time setup this channel is blocked on (owner ops)

Nothing has ever been released — the whole channel first lights up on a `vX.Y.Z-rc.N` rehearsal
tag. Before that can happen the owner must:

1. Enable **immutable releases** on the GitHub repo.
2. Enable **GitHub Pages** (deploy from branch `gh-pages`, root).
3. Create the melange keypair: `MELANGE_SIGNING_KEY` secret + commit `packaging/melange.rsa.pub`.
4. Sign off the **LICENSE** (Apache-2.0).
5. Create a **Phala Cloud account** and set the `PHALA_CLOUD_API_KEY` repo secret; set the CVM's
   encrypted secrets in the dashboard.

## Optional later hardening (not built)

- `DstackApp` on-chain compose-hash whitelist: govern which compose hashes the CVM may boot,
  turning "what runs" into an on-chain policy rather than a deploy-time fact.
