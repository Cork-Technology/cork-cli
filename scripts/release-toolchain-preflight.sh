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
# The pin is worth keeping — it is the fixed trust root (apk-tools, the repository keys) of
# the job that holds the signing key — so the answer to an aging pin is to keep it young:
# scripts/bump-wolfi-pin.sh moves it, and --max-age-days makes the weekly run say when.
#
# The workflow files are the single source: this script reads the image and the install lines
# from every workflow that runs a job in the wolfi-base image (the apk and image build, the
# CVM deploy, the rehearsal), so the two cannot drift apart. ONE digest across all of them.
#
#   sh scripts/release-toolchain-preflight.sh                     run each install in a fresh container
#   sh scripts/release-toolchain-preflight.sh --max-age-days 30   ...and fail when the image is older
#   sh scripts/release-toolchain-preflight.sh --list              print the image and the lines, run nothing
set -eu

runtime="${CONTAINER_RUNTIME:-docker}"
# RELEASE_WORKFLOWS: a space-separated list of files (the tests name their own). By default,
# every workflow that names the image — found, not listed, so a new one cannot be forgotten.
if [ -n "${RELEASE_WORKFLOWS:-}" ]; then
  workflows="$RELEASE_WORKFLOWS"
else
  workflows="$(grep -l '^ *image: *cgr\.dev/chainguard/wolfi-base' .github/workflows/*.yml 2>/dev/null | tr '\n' ' ' || true)"
fi

list=0; max_age=""
while [ $# -gt 0 ]; do
  case "$1" in
    --list) list=1 ;;
    --max-age-days)
      max_age="${2:-}"
      case "$max_age" in ''|*[!0-9]*) echo "release-toolchain: --max-age-days takes a whole number of days" >&2; exit 2 ;; esac
      shift ;;
    *) echo "release-toolchain: unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

[ -n "$(printf '%s' "$workflows" | tr -d ' ')" ] || { echo "release-toolchain: no workflow names the wolfi-base image" >&2; exit 1; }
for workflow in $workflows; do
  test -f "$workflow" || { echo "release-toolchain: $workflow not found" >&2; exit 1; }
done

# shellcheck disable=SC2086 # $workflows is a deliberate word list
images="$(sed -n 's/^ *image: *\([^ ]*\) *$/\1/p' $workflows | sort -u)"
count="$(printf '%s\n' "$images" | grep -c . || true)"
if [ "$count" != 1 ]; then
  echo "release-toolchain: expected ONE job-container image across $workflows, found $count:" >&2
  printf '%s\n' "$images" >&2
  exit 1
fi
case "$images" in
  *@sha256:????????????????????????????????????????????????????????????????) ;;
  *) echo "release-toolchain: the job-container image is not digest-pinned: $images" >&2; exit 1 ;;
esac

# Each distinct line once, in first-seen order: the rehearsal installs the same sets the
# release does, and one container per set is the whole question.
# shellcheck disable=SC2086
lines="$(sed -n 's/^.*\(apk add --no-cache [a-z0-9 .+_-]*\)$/\1/p' $workflows | awk '!seen[$0]++')"
test -n "$lines" || { echo "release-toolchain: no \`apk add --no-cache\` line found in $workflows" >&2; exit 1; }

if [ "$list" = 1 ]; then
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
    echo "::error::release-toolchain: FAILED in the pinned image: $line — the release workflow would fail at this step. Move the pin (sh scripts/bump-wolfi-pin.sh: the image is older than the repository it installs from) or fix the package name, then re-run."
    exit 1
  fi
done || failed=1
[ "$failed" = 0 ] || exit 1

# The image's age, from the image itself (it is local now: the runs above pulled it).
# Days since 1970-01-01 from a civil date, so no `date -d` (GNU) / `date -j` (BSD) split.
created="$("$runtime" image inspect --format '{{.Created}}' "$images" 2>/dev/null || true)"
day="$(printf '%s' "$created" | sed -n 's/^\([0-9][0-9][0-9][0-9]\)-\([0-9][0-9]\)-\([0-9][0-9]\)T.*/\1 \2 \3/p')"
if [ -z "$day" ]; then
  if [ -n "$max_age" ]; then
    echo "::error::release-toolchain: could not read the pinned image's build date (got: '${created}') — the age limit cannot be checked."
    exit 1
  fi
  echo "release-toolchain: the pinned image's build date is not readable; age not checked"
  exit 0
fi
now="${PREFLIGHT_NOW_EPOCH:-$(date -u +%s)}"
age="$(printf '%s %s\n' "$day" "$now" | awk '{
  y = $1; m = $2 + 0; d = $3 + 0
  if (m <= 2) { y -= 1; m += 12 }
  era = int(y / 400); yoe = y - era * 400
  doy = int((153 * (m - 3) + 2) / 5) + d - 1
  doe = yoe * 365 + int(yoe / 4) - int(yoe / 100) + doy
  print int($4 / 86400) - (era * 146097 + doe - 719468)
}')"
echo "release-toolchain: the pinned image was built $created — $age days ago"
if [ -n "$max_age" ] && [ "$age" -gt "$max_age" ]; then
  echo "::error::release-toolchain: the pinned wolfi-base image is $age days old (limit $max_age). Its base packages, the libcrypto apk verifies signatures with included, stay at that build, and every week adds to the distance between its world file and the repository it installs from. Run: sh scripts/bump-wolfi-pin.sh — then commit the change."
  exit 1
fi
