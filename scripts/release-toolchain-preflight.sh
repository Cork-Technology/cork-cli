#!/bin/sh
# Release-toolchain preflight: run every `apk add` of the release workflow in the image it
# pins, BEFORE a tag exists.
#
# Why this exists: .github/workflows/apk-repo.yml pins the job container by digest, but
# installs its tools from Wolfi's ROLLING repository — and a Chainguard image's
# /etc/apk/world pins every base package to the exact version the image was built with
# (`libcrypto3=3.6.3-r4`). `apk add` may not move those, so as the repository rolls the
# solver satisfies a request with ever older builds of the tool, until one collides. On
# 2026-10-01 that broke v0.6.1-rc.3 AFTER its GitHub Release was published: a six-week-old
# pin made `openssl` resolve to a 3.x CLI whose config files belong to the libcrypto 4 that
# git had started to pull in. A tag cannot be fixed, so the place to learn this is CI on main.
#
# The workflow file is the single source: this script reads the image and the install lines
# from it, so the two cannot drift apart.
#
#   sh scripts/release-toolchain-preflight.sh           run each install in a fresh container
#   sh scripts/release-toolchain-preflight.sh --list    print the image and the lines, run nothing
set -eu

workflow="${RELEASE_WORKFLOW:-.github/workflows/apk-repo.yml}"
runtime="${CONTAINER_RUNTIME:-docker}"

test -f "$workflow" || { echo "release-toolchain: $workflow not found" >&2; exit 1; }

images="$(sed -n 's/^ *image: *\([^ ]*\) *$/\1/p' "$workflow" | sort -u)"
count="$(printf '%s\n' "$images" | grep -c . || true)"
if [ "$count" != 1 ]; then
  echo "release-toolchain: expected ONE job-container image in $workflow, found $count:" >&2
  printf '%s\n' "$images" >&2
  exit 1
fi
case "$images" in
  *@sha256:????????????????????????????????????????????????????????????????) ;;
  *) echo "release-toolchain: the job-container image is not digest-pinned: $images" >&2; exit 1 ;;
esac

lines="$(sed -n 's/^.*\(apk add --no-cache [a-z0-9 .+_-]*\)$/\1/p' "$workflow")"
test -n "$lines" || { echo "release-toolchain: no \`apk add --no-cache\` line found in $workflow" >&2; exit 1; }

if [ "${1:-}" = "--list" ]; then
  echo "image: $images"
  printf '%s\n' "$lines"
  exit 0
fi

failed=0
# One FRESH container per line: each job of the workflow starts from the image, not from
# another job's installs.
printf '%s\n' "$lines" | while IFS= read -r line; do
  echo "::group::$line"
  if "$runtime" run --rm "$images" sh -ec "$line"; then
    echo "::endgroup::"
    echo "release-toolchain: OK    $line"
  else
    echo "::endgroup::"
    echo "::error::release-toolchain: FAILED in the pinned image: $line — the release workflow would fail at this step. Re-resolve the wolfi-base digest (the image is older than the repository it installs from) or fix the package name, then re-run."
    exit 1
  fi
done || failed=1

exit "$failed"
