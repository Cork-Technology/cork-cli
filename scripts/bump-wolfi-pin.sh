#!/bin/sh
# Move the wolfi-base pin of the release workflow to the image Chainguard serves now.
#
# The pin is the fixed trust root of the job that holds the signing key, and it AGES: the
# image's world file holds its base packages at their build versions while Wolfi's repository
# rolls on (scripts/release-toolchain-preflight.sh has the incident). Nothing bumps a job
# container's digest for us — Dependabot follows tags, not the digest behind `latest` — and a
# bot's pull request would bypass this repo's signed-commit flow. So a human runs this, reads
# the result, and commits it.
#
#   sh scripts/bump-wolfi-pin.sh              resolve, rewrite every pin, run the preflight
#   sh scripts/bump-wolfi-pin.sh --dry-run    resolve and report; change nothing
#
# The digest is read from the registry and then PROVEN: the manifest fetched by that digest
# must hash to it. Every job container moves together (the preflight refuses two pins).
set -eu

if [ -n "${RELEASE_WORKFLOWS:-}" ]; then
  workflows="$RELEASE_WORKFLOWS"
else
  workflows="$(grep -l '^ *image: *cgr\.dev/chainguard/wolfi-base' .github/workflows/*.yml 2>/dev/null | tr '\n' ' ' || true)"
fi
registry="${WOLFI_REGISTRY:-https://cgr.dev}"
repo="chainguard/wolfi-base"
image="cgr.dev/$repo"
here="$(dirname "$0")"

dry=0
case "${1:-}" in
  "") ;;
  --dry-run) dry=1 ;;
  *) echo "bump-wolfi-pin: unknown argument: $1" >&2; exit 2 ;;
esac

die() { echo "bump-wolfi-pin: $*" >&2; exit 1; }
sha256() { if command -v sha256sum >/dev/null 2>&1; then sha256sum | cut -c1-64; else shasum -a 256 | cut -c1-64; fi; }
is_digest() { case "$1" in sha256:????????????????????????????????????????????????????????????????) case "${1#sha256:}" in *[!0-9a-f]*) return 1 ;; *) return 0 ;; esac ;; *) return 1 ;; esac; }

[ -n "$(printf '%s' "$workflows" | tr -d ' ')" ] || die "no workflow names the $image image"
for workflow in $workflows; do test -f "$workflow" || die "$workflow not found"; done
# shellcheck disable=SC2086 # $workflows is a deliberate word list
old="$(sed -n "s|^ *image: *$image@\\(sha256:[0-9a-f]*\\) *\$|\\1|p" $workflows | sort -u)"
[ "$(printf '%s\n' "$old" | grep -c .)" = 1 ] || die "expected ONE $image pin across $workflows, found: $(printf '%s' "$old" | tr '\n' ' ')"
is_digest "$old" || die "the current pin is not a full sha256 digest: $old"

accept="Accept: application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json"
token="$(curl -fsS "$registry/token?scope=repository:$repo:pull" | sed -n 's/.*"token" *: *"\([^"]*\)".*/\1/p')"
[ -n "$token" ] || die "no pull token from $registry"
new="$(curl -fsSI -H "Authorization: Bearer $token" -H "$accept" "$registry/v2/$repo/manifests/latest" \
  | tr -d '\r' | sed -n 's/^[Dd]ocker-[Cc]ontent-[Dd]igest: *//p')"
is_digest "$new" || die "the registry did not name a sha256 digest for $repo:latest (got: '$new')"

tmp="$(mktemp)"; trap 'rm -f "$tmp" "$tmp".wf.*' EXIT
curl -fsS -H "Authorization: Bearer $token" -H "$accept" "$registry/v2/$repo/manifests/$new" -o "$tmp"
got="sha256:$(sha256 < "$tmp")"
[ "$got" = "$new" ] || die "the manifest served for $new hashes to $got — refusing a digest the content does not prove"
created="$(sed -n 's/.*"org\.opencontainers\.image\.created" *: *"\([^"]*\)".*/\1/p' "$tmp" | head -1)"
[ -n "$created" ] || created="an unknown time"

echo "pinned:  $image@$old"
echo "current: $image@$new   (built $created)"
if [ "$old" = "$new" ]; then
  echo "bump-wolfi-pin: the pin is the current image; nothing to change"
  exit 0
fi
if [ "$dry" = 1 ]; then
  echo "bump-wolfi-pin: --dry-run, nothing changed"
  exit 0
fi

today="$(date -u +%Y-%m-%d)"
# Every file is rewritten to a temporary copy and checked BEFORE any file is replaced: the
# pins move together or not at all.
n=0
for workflow in $workflows; do
  n=$((n + 1))
  sed -e "s|$image@$old|$image@$new|g" \
      -e "s|^\\( *# Pinned \\)[0-9-]*: the image built .*\\.\$|\\1$today: the image built $created.|" \
      "$workflow" > "$tmp.wf.$n"
  grep -q "$old" "$tmp.wf.$n" && die "the old digest is still in $workflow after the rewrite"
done
n=0; moved=0
for workflow in $workflows; do
  n=$((n + 1))
  cat "$tmp.wf.$n" > "$workflow"
  moved=$((moved + $(grep -c "$image@$new" "$workflow")))
done
echo "bump-wolfi-pin: $moved pins moved in $workflows"

if command -v "${CONTAINER_RUNTIME:-docker}" >/dev/null 2>&1; then
  # The preflight finds the same files this script did (RELEASE_WORKFLOWS, or by discovery).
  sh "$here/release-toolchain-preflight.sh" \
    || die "the preflight FAILED on the new image — the pins are moved in the file; fix the install lines or revert before you commit"
  echo "bump-wolfi-pin: the preflight passed on the new image. Review the diff and commit."
else
  echo "bump-wolfi-pin: no container runtime here, so the preflight did not run. CI runs it on the push: watch the release-toolchain workflow before you tag."
fi
