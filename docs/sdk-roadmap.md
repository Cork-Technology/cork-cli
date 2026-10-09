# The SDK roadmap: why the binary comes first, and what comes next

**Audience:** integrators who wrap Cork inside their own trust boundary.

This page answers three questions. Why is the signed binary the integration surface today? What
is the path to a library? How does each stage keep the threat-model posture? The hands-on guides
are [sdk.md](sdk.md) for the `@cork/core` library and [zyfai-quickstart.md](zyfai-quickstart.md)
for the full integration flow.

## Why the binary is the integration surface today

One `ch` binary carries the whole surface: the CLI, the MCP server (`ch mcp`), the bit-exact math
ports, and the verification rules. It reconstructs from bytes and never trusts a parse that you
give it. The chain outranks the indexer. Three properties make it the right first artifact for an
integrator who cares about security.

1. **It is one verifiable thing.** Every release builds twice on independent runners and publishes
   only when both builds are byte-identical. Every asset carries a Sigstore-signed SLSA Build L3
   attestation. You check it with one command:

   ```sh
   gh attestation verify ch-linux-x64 --repo Cork-Technology/cork-cli \
     --signer-workflow Cork-Technology/cork-cli/.github/workflows/build-binaries.yml
   ```

   Add `--source-ref` and `--source-digest` to bind the asset to its tag and commit, as
   [sdk.md](sdk.md) shows. You can also rebuild it from the tagged commit and compare checksums.
   There is no dependency tree to audit at install time. The audit surface is the repository at one
   commit.

2. **It is a process you can cage.** The binary runs behind an OS process boundary, so every
   isolation tool you already trust applies: a container or TEE, a seccomp or no-network profile,
   a read-only filesystem, an environment with no secrets. The tool never signs, never holds keys
   and never broadcasts, so the sandbox can grant it almost nothing. The sandbox contains a
   compromised binary. Its only channel to you is the artifacts it emits. You verify each artifact
   before anyone signs it: you decode the bytes, simulate them and recompute the hashes.

   A library gets no such cage. It runs in-process with the full authority of your backend: its
   memory, its environment, its credentials, every other loaded module. The same compromise then
   has the blast radius of the whole host process. In-process isolation exists, but none of it
   matches an OS process boundary. Node's permission model is process-wide. SES, LavaMoat and WASM
   sandboxes work per package, but they are exotic. To put a real boundary around a library, run
   it in its own process. The binary already is that process, hardened and attested.

3. **A hosted API cannot carry this posture.** An API moves the computation, and the verification,
   to someone else's machine. With an API, you trust a network response. With the binary, you
   verify locally: you recompute an order hash, simulate frozen bytes, and decode a signed
   transaction before you broadcast it. That client-side verification is the product, and it does
   not survive behind an endpoint. This is why there is no API-only integration path.

## The roadmap, in three stages

**Stage 1, today: the signed binary (CLI and MCP).** Drive it from a shell, a script or an MCP
client. This is the pilot surface. For agent-driven flows, it stays the right surface after the
later stages exist.

**Stage 2, shipping now: the SDK as attested release tarballs.** Use this stage when you want typed
calls in-process instead of a subprocess. `@cork/schemas`, `@cork/core` and the optional `@cork/mcp`
ship beside the binaries as `cork-*.tgz` on every release. The release packs them reproducibly and
lists them in the same `checksums.txt`. The same attestation and the same determinism gate cover
them. You download a tarball, verify it with the same `gh attestation verify` recipe, and install it
from the file. Your lockfile then pins its hash. Install details are in [sdk.md](sdk.md). The
deliberate trade-off: no semver ranges. Every upgrade is an explicit download that you verify and
review. For a partner integration, that is the posture we want on both sides.

Before you choose this stage, know what moving in-process costs you: the sandbox. The library runs
with your backend's authority. If an attacker compromises it, or any dependency it loads, the blast
radius is that whole process. The dependency surface also changes. The binary embeds its
dependencies from our frozen lockfile inside the attested build. The tarball declares them
(exact-pinned: `viem`, `zod`, and the optional HyperSync client packages), and your machine
fetches them from the npm registry at install time.
Reduce the risk: install with `--ignore-scripts`, and commit and review the lockfile. If you want
typed calls and a real boundary, run the SDK in its own worker process. The SDK holds no keys
either, so it needs no ambient authority to do its job.

**Stage 3, later: the npm registry through trusted publishing.** When the SDK opens to a broad
audience, reach starts to matter. Then the friction of tarball downloads no longer pays for
itself. At
that point we publish the packages to npm through trusted publishing: short-lived OIDC credentials
pinned to this repository and workflow, automatic Sigstore provenance, no long-lived tokens
anywhere. Until then, we stay off the registry on purpose. The npm supply-chain incidents of 2025
and 2026 taught one lesson. Registry provenance proves where a package was built, not that you
should run it. A single-partner integration gets a stronger guarantee from the chain of attested
assets that it already verifies for the binary.

## How this relates to the threat model

The posture for a wrapped integration rests on two separations. Every stage keeps both.

- **Prepare, sign and submit are separate.** Every surface returns unsigned bytes or typed data.
  An attacker who compromises the artifact channel gets no signing capability, because the channel
  has none. Your keys, your Safe policy and your receiver-forcing adapters (the `*ForSelf` shape)
  stay the enforcement layer.

- **One provenance chain, verified at your edge.** The binary you wrap and the SDK you import come
  from the same tagged commit, the same double build and the same attestation identity. Your
  supply-chain check is one recipe. You apply it the same way, on your machine, before anything
  enters your boundary. Nothing in the roadmap asks you to trust a registry account, a maintainer
  laptop or a mirror that you cannot verify.

What the roadmap does not change: you still audit what you deploy and what you import. An
attestation proves the bytes came from this repository's release workflow at a named commit. It
is the start of your review, not a substitute for it.

## Choosing a stage

| You are building | Use | Why |
|---|---|---|
| Agent-driven flows, human operators, scripts | Stage 1: the binary (`ch`, `ch mcp`) | One attested artifact behind an OS process boundary you can sandbox. The MCP surface is the agent-native one. |
| A backend that calls Cork in-process, typed | Stage 2: the release tarballs | The same provenance chain, typed envelopes, explicit and verifiable upgrades. You trade the process sandbox for in-process convenience. |
| Anything, once the SDK is public on npm | Stage 3: npm with trusted publishing | Semver and reach, with OIDC provenance. We announce it when it lands. |

Questions on the roadmap or the threat model: ask your Cork contact. The deeper security analysis
referenced in the quickstart (section 5) covers the wrapped-adapter posture in full.
