#!/bin/sh
# Build the cork-cli apk for one architecture with melange — the ONE spelling of that command.
#
# Two callers run it: the release (apk-repo.yml, with the `release` environment's signing key)
# and the rehearsal (release-toolchain.yml, with a throwaway key, on every push to main). They
# share this file so that a rehearsal that passes has run the release's own command line — a
# rehearsal with its own copy of the flags would only prove the copy.
#
#   sh scripts/apk-melange-build.sh <arch> <signing-key-file> [out-dir] [spec]
#
# Run from the repository root, after scripts/apk-spec-identity.sh wrote the release identity
# into the spec.
set -eu

arch="${1:?arch (x86_64 or aarch64)}"; key="${2:?signing key file}"
out="${3:-packages}"; spec="${4:-packaging/melange.yaml}"
case "$arch" in x86_64|aarch64) ;; *) echo "apk-melange-build: unmapped arch $arch" >&2; exit 2 ;; esac
test -s "$key" || { echo "apk-melange-build: the signing key file is missing or empty: $key" >&2; exit 1; }

# Stolen from the wolfi-dev/os Makefile (surfaced as the official actions' source-date-epoch
# input): pin the build clock to the COMMIT being packaged. melange stamps file times and the
# package build_date from SOURCE_DATE_EPOCH, and the compiled `ch` binary is already
# deterministic (release.yml's double-build gate) — so a later re-dispatch has a real shot at
# rebuilding byte-identical apks, which is exactly what the publish job's immutability check
# (cmp, refuse different bytes) needs in order to pass on a partial-publish retry instead of
# bricking. Plain assignment + guard, NOT `export X="$(...)"` — export returns 0 even when
# the substitution fails, and run 32225918023 shipped an empty epoch that way.
SOURCE_DATE_EPOCH="$(git log -1 --format=%ct)"
test -n "$SOURCE_DATE_EPOCH" || { echo "::error::could not read the commit's timestamp for SOURCE_DATE_EPOCH" >&2; exit 1; }
export SOURCE_DATE_EPOCH
echo "SOURCE_DATE_EPOCH=$SOURCE_DATE_EPOCH (the packaged commit)"
repo="${GITHUB_REPOSITORY:-Cork-Technology/cork-cli}"
case "$repo" in Cork-Technology/cork-cli|Cork-Technology/cork-cli-private) ;; *) echo 'apk-melange-build: unrecognized component repository' >&2; exit 1 ;; esac
if [ "$repo" = Cork-Technology/cork-cli-private ]; then
  # actions/checkout already authenticated the private fetch outside the build sandbox.
  # Seed only the pinned tracked tree, never .git (which carries checkout's auth header),
  # untracked files, signing keys, or a token-bearing URI. No second trust root or sandbox secret.
  commit="$(git rev-parse HEAD)"
  [ "$(yq '.vars.repo' "$spec")" = "$repo" ] && [ "$(yq '.pipeline[0].with.repository' "$spec")" = "https://github.com/$repo" ] || { echo 'apk-melange-build: source repository identity mismatch' >&2; exit 1; }
  [ "$(yq '.pipeline[0].with.expected-commit' "$spec")" = "$commit" ] && [ "$(yq '.vars.commit' "$spec")" = "$commit" ] || { echo 'apk-melange-build: source commit pin mismatch' >&2; exit 1; }
  [ "$(yq '.pipeline[0].uses' "$spec")" = git-checkout ] || { echo 'apk-melange-build: expected pinned checkout step' >&2; exit 1; }
  ref="$(yq '.pipeline[0].with.branch // .pipeline[0].with.tag' "$spec")"
  [ "$ref" != '${{vars.tag}}' ] || ref="$(yq '.vars.tag' "$spec")"
  [ "$(git rev-parse "$ref^{commit}")" = "$commit" ] || { echo 'apk-melange-build: source ref does not resolve to pinned commit' >&2; exit 1; }
  work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT HUP INT TERM
  mkdir "$work/source"
  git archive --format=tar "$commit" > "$work/source.tar"
  tar -xf "$work/source.tar" -C "$work/source"
  yq 'del(.pipeline[0])' "$spec" > "$work/melange.yaml"
  # The canonical URL and exact source commit, not a local path or credential, name provenance.
  unset GH_TOKEN GITHUB_TOKEN CORK_GITHUB_TOKEN
  melange build "$work/melange.yaml" --source-dir "$work/source" \
    --git-repo-url "https://github.com/$repo" --git-commit "$commit" \
    --runner bubblewrap --arch "$arch" --signing-key "$key" --generate-provenance --out-dir "$out"
  ls -l "$out/$arch/"
  exit 0
fi

# bubblewrap, root-in-container (the wolfi-dev/os shape, still zero sudo — the runner the job
# container exists to restore): as in-container root the bwrap probe that refused the
# unprivileged runner user (run 32178646153) passes, and no daemon socket is involved. The
# docker runner is NOT usable in there even though the host socket is mounted: a sibling
# container's bind mounts resolve against the HOST filesystem, where the job's /__w workspace
# path does not exist. The flag stays EXPLICIT so an upstream default change cannot silently
# move the isolation model.
melange build "$spec" \
  --runner bubblewrap \
  --arch "$arch" \
  --signing-key "$key" \
  --generate-provenance \
  --out-dir "$out"
# `melange build` already generates AND signs the per-arch APKINDEX.tar.gz with the same key
# (observed in the v0.3.0-rc.1 backfill log, 2026-08-18). That local index is what CANDIDATES
# ship; production builds its CUMULATIVE index in scripts/apk-slice.sh.
ls -l "$out/$arch/"
