#!/bin/sh
# Write the release identity into the apko image spec: where the cork-cli apk comes from, which
# exact version the image installs, and the two OCI annotations that name the release.
#
# Shared by the release (apk-repo.yml) and the rehearsal (release-toolchain.yml) — see
# scripts/apk-melange-build.sh for why.
#
#   sh scripts/apk-image-spec.sh pages <apkver> <tag> <revision>
#   sh scripts/apk-image-spec.sh local <apkver> <tag> <revision> <pubkey>...
#
# pages: the spec keeps the PUBLISHED channel (production: the apk was pushed to Pages first).
# local: the Pages channel never carries a candidate. Each slice under incoming/<arch>/slice IS
#        a signed per-arch repository (apks + APKINDEX.tar.gz), so the image composes from them
#        as a local repository under ./local, verified with the public key(s) given. The wolfi
#        repository and its key stay as they are; only the cork-cli pair is swapped.
# <revision> is the commit the image is built from: the TAG's commit for a release (not
# github.sha — on a backfill dispatched from main they differ), the tested commit for a rehearsal.
set -eu

mode="${1:?pages or local}"; apkver="${2:?apk version}"; tag="${3:?tag}"; revision="${4:?revision (40-hex commit)}"
spec="${APKO_SPEC:-packaging/cork-cli.apko.yaml}"
PAGES_REPO="https://cork-technology.github.io/cork-cli/apk"
PAGES_KEY="https://cork-technology.github.io/cork-cli/melange.rsa.pub"
repo="${GITHUB_REPOSITORY:-Cork-Technology/cork-cli}"
case "$repo" in Cork-Technology/cork-cli|Cork-Technology/cork-cli-private) ;; *) echo 'apk-image-spec: unrecognized component repository' >&2; exit 2 ;; esac
if [ "$repo" = Cork-Technology/cork-cli-private ]; then
  [ "$mode" = local ] || { echo 'apk-image-spec: private Pages channel is unsupported' >&2; exit 1; }
  printf '%s' "$tag" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+-rc\.[0-9]+$' || { echo 'apk-image-spec: private image is candidate-only' >&2; exit 1; }
fi
case "$revision" in ????????????????????????????????????????) ;; *) echo "apk-image-spec: revision must be a 40-hex commit (got: $revision)" >&2; exit 2 ;; esac
case "$revision" in *[!0-9a-f]*) echo "apk-image-spec: revision must be a 40-hex commit (got: $revision)" >&2; exit 2 ;; esac
test -f "$spec" || { echo "apk-image-spec: $spec not found" >&2; exit 1; }

case "$mode" in
  pages)
    [ $# -eq 4 ] || { echo "apk-image-spec: pages takes no public key — the spec's own keyring names the published one" >&2; exit 2; } ;;
  local)
    [ $# -ge 5 ] || { echo "apk-image-spec: local needs at least one public key file" >&2; exit 2; }
    shift 4
    # Every input is checked before anything is written: a refusal leaves the spec as it was.
    for pub in "$@"; do
      test -s "$pub" || { echo "apk-image-spec: public key file is missing or empty: $pub" >&2; exit 1; }
    done
    for arch in x86_64 aarch64; do
      test -f "incoming/$arch/slice/APKINDEX.tar.gz" || { echo "apk-image-spec: incoming/$arch/slice has no signed index" >&2; exit 1; }
    done
    for arch in x86_64 aarch64; do
      mkdir -p "local/$arch" && cp -a "incoming/$arch/slice/." "local/$arch/"
    done
    REPO="$PAGES_REPO" yq -i '(.contents.repositories[] | select(. == strenv(REPO))) = "./local"' "$spec"
    # The published key leaves the keyring; each given key takes its place, in order.
    KEY="$PAGES_KEY" yq -i '.contents.keyring |= map(select(. != strenv(KEY)))' "$spec"
    for pub in "$@"; do
      case "$pub" in /*|./*) ref="$pub" ;; *) ref="./$pub" ;; esac
      PUB="$ref" yq -i '.contents.keyring += [strenv(PUB)]' "$spec"
    done
    [ "$(REPO="$PAGES_REPO" yq '[.contents.repositories[] | select(. == strenv(REPO))] | length' "$spec")" = 0 ] \
      || { echo "apk-image-spec: the spec still names the Pages repository" >&2; exit 1; }
    [ "$(yq '[.contents.repositories[] | select(. == "./local")] | length' "$spec")" = 1 ] \
      || { echo "apk-image-spec: the spec does not name ./local exactly once — the Pages repository line it replaces is gone from the spec" >&2; exit 1; }
    yq '.contents.repositories, .contents.keyring' "$spec" ;;
  *) echo "apk-image-spec: unknown mode: $mode (pages or local)" >&2; exit 2 ;;
esac

# An independent `apko build` of this spec must resolve the SAME package as this run — pin
# cork-cli to the exact version-revision instead of floating on the index head. (epoch is 0 in
# melange.yaml; a future epoch bump must be mirrored here.)
PIN="cork-cli=${apkver}-r0" yq -i '(.contents.packages[] | select(. == "cork-cli")) = strenv(PIN)' "$spec"
[ "$(PIN="cork-cli=${apkver}-r0" yq '[.contents.packages[] | select(. == strenv(PIN))] | length' "$spec")" = 1 ] \
  || { echo "apk-image-spec: the spec's cork-cli package was not pinned to ${apkver}-r0" >&2; exit 1; }
yq '.contents.packages' "$spec"

# OCI annotations a verifier reads without pulling the SBOM: the static ones live in the spec;
# version and revision are the RELEASE's.
ANN_VERSION="$tag" ANN_REVISION="$revision" \
  yq -i '.annotations["org.opencontainers.image.version"] = strenv(ANN_VERSION) | .annotations["org.opencontainers.image.revision"] = strenv(ANN_REVISION)' "$spec"
if [ "$repo" = Cork-Technology/cork-cli-private ]; then
  REPO="$repo" yq -i '.annotations["org.opencontainers.image.source"] = "https://github.com/" + strenv(REPO) | .annotations["org.opencontainers.image.documentation"] = "https://github.com/" + strenv(REPO) + "#readme" | .annotations["org.opencontainers.image.title"] = "cork-cli-private"' "$spec"
fi
yq '.annotations' "$spec"
