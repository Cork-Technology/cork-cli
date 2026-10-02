#!/bin/sh
# Merge one architecture's freshly built apk into its channel directory, sign ONE index over
# the result, and cut the SLICE the publish job places: only what this build added, plus the
# index, plus the gh-pages commit the index was computed against.
#
# Shared by the release (apk-repo.yml) and the rehearsal (release-toolchain.yml) — see
# scripts/apk-melange-build.sh for why. The caller prepares site/ first: production checks the
# published gh-pages channel out there (the merge creates site/apk/<arch> on a first publish);
# a candidate and the rehearsal start from an EMPTY channel, so their slice is a complete
# signed per-arch repository of its own.
#
#   sh scripts/apk-slice.sh <arch> <signing-key-file> <base>
#
# <base>: the gh-pages commit the channel directory was checked out at, or `none` (a candidate,
# the rehearsal, a first publish). Reads packages/<arch>; writes slice/ and slice-base.sha.
set -eu

arch="${1:?arch}"; key="${2:?signing key file}"; base="${3:?gh-pages base commit, or none}"
here="$(dirname "$0")"
test -s "$key" || { echo "apk-slice: the signing key file is missing or empty: $key" >&2; exit 1; }
# melange index runs inside the channel directory, so the key path must not be relative to here.
case "$key" in /*) keyabs="$key" ;; *) keyabs="$(pwd)/$key" ;; esac

# The immutability rule lives in ONE tested script (packages/cli/test/apk-channel-merge.test.ts):
# identical bytes skip, differing provenance keeps the first, differing apk REFUSES before
# anything is copied. It writes the names it added.
sh "$here/apk-channel-merge.sh" "site/apk/$arch" "packages/$arch" added.txt
(cd "site/apk/$arch" && melange index -o APKINDEX.tar.gz --signing-key "$keyabs" ./*.apk)

# The slice the publish job places: ONLY what this merge added plus the re-signed index — never
# the whole channel, which would make every artifact grow with history.
rm -rf slice && mkdir -p slice
cp "site/apk/$arch/APKINDEX.tar.gz" slice/
while IFS= read -r name; do cp "site/apk/$arch/$name" slice/; done < added.txt
printf '%s\n' "$base" > slice-base.sha
echo "slice for $arch: $(wc -l < added.txt) added file(s) + signed index, indexed against gh-pages $base"
