# The SDK roadmap: why the binary comes first, and what comes next

**Audience:** integrators who wrap Cork inside their own trust boundary. Zyfai first among them.

This page answers three questions. Why is the signed binary the integration surface today? What
is the path to a library? How does each stage keep the threat-model posture? The hands-on guides
are [sdk.md](sdk.md) for the `@cork/core` library and [zyfai-quickstart.md](zyfai-quickstart.md)
for the full integration flow.

## Why the binary is the integration surface today

One `ch` binary carries the whole surface: the CLI, the MCP server (`ch mcp`), the bit-exact math
ports, and the verification rules. It reconstructs from bytes and never trusts a parse you hand
it. The chain outranks the indexer. Three properties make it the right first artifact for a
security-conscious integrator.

1. **It is one verifiable thing.** Every release builds twice on independent runners and publishes
   only when both builds are byte-identical. Every asset carries a Sigstore-signed SLSA Build L3
   attestation. You check it with one command:

   ```sh
   gh attestation verify ch-linux-x64 --repo Cork-Technology/cork-cli \
     --signer-workflow Cork-Technology/cork-cli/.github/workflows/build-binaries.yml
   ```

   You can also rebuild it from the tagged commit and compare checksums. There is no dependency
   tree to audit at install time. The audit surface is the repository at one commit.

2. **It is a process you can cage.** The binary runs behind an OS process boundary, so every
   isolation tool you already trust applies: a container or TEE, a seccomp or no-network profile,
   a read-only filesystem, an environment with no secrets. The tool never signs, never holds keys
   and never broadcasts, so the sandbox can grant it almost nothing. A compromised binary is
   contained. Its only channel to you is the artifacts it emits, and you verify each one before
   anything is signed: decode the bytes, simulate them, recompute the hashes.

   A library gets no such cage. It runs in-process with the full authority of your backend: its
   memory, its environment, its credentials, every other loaded module. The same compromise then
   has the blast radius of the whole host process. In-process isolation exists (Node's permission
   model is process-wide; SES, LavaMoat and WASM sandboxes are per-package but exotic) and none of
   it matches an OS process boundary. If you need a real boundary around a library, run it in its
   own process, which is what the binary already is, hardened and attested.

3. **A hosted API cannot carry this posture.** An API moves the computation, and the verification,
   to someone else's machine. You would trust a network response where the binary lets you verify
   locally: recompute an order hash, simulate frozen bytes, decode a signed transaction before you
   broadcast it. That client-side verification is the product. It does not survive being put
   behind an endpoint. This is why there is no API-only integration path.

## The roadmap, in three stages

**Stage 1, today: the signed binary (CLI and MCP).** Drive it from a shell, a script or an MCP
client. This is the pilot surface. For agent-driven flows it stays the right one after the later
stages exist.

**Stage 2, shipping now: the SDK as attested release tarballs.** When you want in-process typed
calls instead of a subprocess, `@cork/core` and `@cork/schemas` ship beside the binaries as
`cork-*.tgz` on every release. They are packed reproducibly, listed in the same `checksums.txt`,
and covered by the same attestation and the same determinism gate. You verify a tarball with the
same `gh attestation verify` recipe, install it by URL, and your lockfile pins its sha512 against
an immutable release asset. Install details are in [sdk.md](sdk.md). The deliberate trade-off:
no semver ranges. Every upgrade is an explicit URL change that you verify and review. For a
partner integration, that is the posture we want on both sides.

Know what moving in-process costs before you choose this stage: the sandbox. The library runs
with your backend's authority, and a compromise of it, or of any dependency it loads, has the
blast radius of that whole process. The dependency surface also shifts. The binary embeds its
dependencies from our frozen lockfile inside the attested build. The tarball declares them
(exact-pinned: `viem`, `zod`) for your machine to fetch from the npm registry at install time.
Mitigate accordingly: install with `--ignore-scripts`, commit and review the lockfile, and if you
want typed calls and a real boundary, run the SDK inside its own worker process. The SDK holds no
keys either, so it needs no ambient authority to do its job.

**Stage 3, later: the npm registry through trusted publishing.** When the SDK opens to a broad
audience, reach starts to matter and the tarball-URL friction stops paying for itself. The
packages then publish to npm through trusted publishing: short-lived OIDC credentials pinned to
this repository and workflow, automatic Sigstore provenance, no long-lived tokens anywhere. Until
then we stay off the registry on purpose. The npm supply-chain incidents of 2025 and 2026 taught
that registry provenance proves where a package was built, not that you should run it. A
single-partner integration gets a stronger guarantee from the attested-asset chain it already
verifies for the binary.

## How this relates to the threat model

The posture for a wrapped integration rests on two separations. Every stage keeps both.

- **Prepare, sign and submit are separate.** Whatever surface you consume, it returns unsigned
  bytes or typed data. Compromising the artifact channel never yields a signing capability,
  because there is none to yield. Your keys, your Safe policy and your receiver-forcing adapters
  (the `*ForSelf` shape) stay the enforcement layer.

- **One provenance chain, verified at your edge.** The binary you wrap and the SDK you import come
  from the same tagged commit, the same double build and the same attestation identity. Your
  supply-chain check is one recipe, applied the same way, run on your machine before anything
  enters your boundary. Nothing in the roadmap asks you to trust a registry account, a maintainer
  laptop or a mirror you cannot verify.

What the roadmap does not change: you still audit what you deploy and what you import. An
attestation proves the bytes came from this repository's release workflow at a named commit. It
is the start of your review, not a substitute for it.

## Choosing a stage

| You are building | Use | Why |
|---|---|---|
| Agent-driven flows, human operators, scripts | Stage 1: the binary (`ch`, `ch mcp`) | One attested artifact behind an OS process boundary you can sandbox. The MCP surface is the agent-native one. |
| A backend that calls Cork in-process, typed | Stage 2: the release tarballs | The same provenance chain, typed envelopes, explicit and verifiable upgrades. You trade the process sandbox for in-process convenience. |
| Anything, once the SDK is public on npm | Stage 3: npm with trusted publishing | Semver and reach, with OIDC provenance. Announced when it lands. |

Questions on the roadmap or the threat model: ask your Cork contact. The deeper security analysis
referenced in the quickstart (section 5) covers the wrapped-adapter posture in full.
