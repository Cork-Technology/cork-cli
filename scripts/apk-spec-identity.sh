#!/bin/sh
# Write one release identity into packaging/melange.yaml — the single place the apk build
# learns WHICH tag it packages. Called by .github/workflows/apk-repo.yml; tested by
# packages/cli/test/apk-spec-identity.test.ts against the current spec AND the spec of the
# last pre-fix tag.
#
#   sh scripts/apk-spec-identity.sh <spec> <tag> <apkver> <commit>
#
# tag     the git tag, vX.Y.Z or vX.Y.Z-rc.N — the release identity compile-binaries.mjs stamps
# apkver  the same version in apk grammar (X.Y.Z or X.Y.Z_rcN) — what the package is NAMED
# commit  the tag's commit sha — pins git-checkout's expected-commit
#
# Two spellings of one version exist because apk grammar has no "-rc.N". Only the apk name may
# carry the apk spelling; every other use reads the tag (vars.tag). The v0.4.0-rc.1 apk build
# failed because the spec rebuilt the tag as "v" + package.version and compiled with
# v0.4.0_rc1 (run 32416116529).
set -eu

spec="${1:?spec path}"; tag="${2:?tag}"; apkver="${3:?apk version}"; commit="${4:?commit sha}"
case "$tag" in v[0-9]*) ;; *) echo "apk-spec-identity: tag must start with v (got: $tag)" >&2; exit 2 ;; esac
case "$commit" in ????????????????????????????????????????) ;; *) echo "apk-spec-identity: commit must be a 40-hex sha" >&2; exit 2 ;; esac

TAG="$tag" APKVER="$apkver" COMMIT="$commit" yq -i '
  .package.version = strenv(APKVER)
  | .vars.commit = strenv(COMMIT)
  | .vars.tag = strenv(TAG)
  | .pipeline[0].with.expected-commit = strenv(COMMIT)
' "$spec"

# Specs from tags up to v0.4.0-rc.1 (before 2026-08-20) have no vars.tag: they spell the tag
# as "v" + package.version at the checkout AND at the compile step. Rewrite both to the tag so
# a manual re-run of such a tag builds. SUNSET: delete this block once no tag ≤ v0.4.0-rc.1
# needs an apk rebuild (the next stable cut supersedes them); a current spec is unchanged by it.
TAG="$tag" yq -i '
  (.pipeline[0].with.tag | select(. == "v${{package.version}}")) = strenv(TAG)
  | (.pipeline[] | select(has("runs")) | .runs) |= sub("--version \"v\$\{\{package.version\}\}\"", "--version \"" + strenv(TAG) + "\"")
' "$spec"

# Guard: every --version the compile step passes must be the tag, nothing else.
# Accepted spellings: the literal tag (a rewritten pre-fix spec) or vars.tag (a current spec).
bad="$(yq '.pipeline[] | select(has("runs")) | .runs' "$spec" | grep -- '--version "' | grep -v -e "--version \"$tag\"" -e '--version "${{vars.tag}}"' || true)"
if [ -n "$bad" ]; then
  echo "apk-spec-identity: a compile step does not read the tag: $bad" >&2
  exit 1
fi
checkout="$(yq '.pipeline[0].with.tag' "$spec")"
if [ "$checkout" != "$tag" ] && [ "$checkout" != '${{vars.tag}}' ]; then
  echo "apk-spec-identity: git-checkout tag is $checkout, not the release tag" >&2
  exit 1
fi
yq '.package.version, .vars.commit, .vars.tag, .pipeline[0].with.tag' "$spec"
