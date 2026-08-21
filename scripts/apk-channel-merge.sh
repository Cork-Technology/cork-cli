#!/bin/sh
# Merge one build's apk output into the cumulative, published per-arch channel directory under
# the immutability rule — the step that decides what a release may add to the apk repository.
# Called by .github/workflows/apk-repo.yml (melange-build, production tags) right before the
# channel index is signed; tested by packages/cli/test/apk-channel-merge.test.ts.
#
#   sh scripts/apk-channel-merge.sh <channel-dir> <incoming-dir> <added-list>
#
# channel-dir   the arch's published directory (a gh-pages worktree path, apk/<arch>/)
# incoming-dir  this build's output for the arch (melange's packages/<arch>/)
# added-list    written: one file name per line that this merge ADDED to the channel — the
#               publish job copies exactly these (plus the re-signed index), nothing else
#
# Rules, checked for EVERY incoming file BEFORE anything is copied, so a refusal leaves the
# channel untouched:
#   - a published file with identical bytes is skipped (a re-run of the same release);
#   - a published .attest.tar.gz with different bytes is kept as FIRST published: melange stamps
#     wall-clock build times into the SLSA predicate, so an honest rebuild of byte-identical
#     apks still yields a different provenance archive;
#   - a published .apk with different bytes is REFUSED — published apks are immutable; bump the
#     epoch instead;
#   - the incoming APKINDEX.tar.gz (the build's own local index) is ignored: the channel index is
#     regenerated over everything published, after this merge.
set -eu

channel="${1:?channel dir}"; incoming="${2:?incoming dir}"; added="${3:?added-list path}"
[ -d "$incoming" ] || { echo "apk-channel-merge: incoming dir not found: $incoming" >&2; exit 2; }
mkdir -p "$channel"
: > "$added"

# Pass 1: decide. Collect the names to copy; refuse before touching the channel.
to_copy=""
seen=0
for f in "$incoming"/*.apk "$incoming"/*.attest.tar.gz; do
  [ -e "$f" ] || continue
  seen=$((seen + 1))
  name="$(basename "$f")"
  if [ -e "$channel/$name" ]; then
    if cmp -s "$f" "$channel/$name"; then
      echo "already published byte-identical: $name — skipping (re-run)"
      continue
    fi
    case "$name" in
      *.attest.tar.gz)
        echo "already published provenance $name differs (fresh wall-clock fields) — keeping the FIRST-published attestation"
        continue ;;
    esac
    echo "REFUSING to overwrite already-published $name with DIFFERENT bytes — published apks are immutable (bump the epoch instead)" >&2
    exit 1
  fi
  to_copy="$to_copy $name"
done
[ "$seen" -gt 0 ] || { echo "apk-channel-merge: no .apk in $incoming — nothing to merge" >&2; exit 2; }

# Pass 2: copy, and record what was added.
for name in $to_copy; do
  cp "$incoming/$name" "$channel/$name"
  printf '%s\n' "$name" >> "$added"
  echo "added: $name"
done
