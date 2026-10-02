#!/bin/sh
# Turn the melange spec of a RELEASE into the spec of a REHEARSAL: fetch a branch, not a tag.
#
# A release packages a tag: the spec's git-checkout step names the tag and pins the commit the
# tag must resolve to. A rehearsal packages the commit under test, which has no tag. So, after
# scripts/apk-spec-identity.sh wrote a synthetic identity into the spec, this script replaces
# the tag with the branch that carries the commit. The commit pin stays: melange still refuses
# any other commit, so the rehearsal packages exactly the commit CI is testing.
#
# That is the ONE way the rehearsal's build differs from a release build. The package name,
# the build pipeline, the toolchain and the melange command line are the release's own.
#
#   sh scripts/apk-rehearsal-spec.sh <spec> <branch>
set -eu

spec="${1:?spec path}"; branch="${2:?branch}"
case "$branch" in *[!A-Za-z0-9._/-]*|"") echo "apk-rehearsal-spec: not a branch name: $branch" >&2; exit 2 ;; esac

[ "$(yq '.pipeline[0].uses' "$spec")" = git-checkout ] || { echo "apk-rehearsal-spec: the spec's first pipeline step is not git-checkout" >&2; exit 1; }
commit="$(yq '.pipeline[0].with.expected-commit' "$spec")"
case "$commit" in
  0000000000000000000000000000000000000000|null|"") echo "apk-rehearsal-spec: the spec carries no commit pin — run scripts/apk-spec-identity.sh first" >&2; exit 1 ;;
esac

BRANCH="$branch" yq -i 'del(.pipeline[0].with.tag) | .pipeline[0].with.branch = strenv(BRANCH)' "$spec"

[ "$(yq '.pipeline[0].with | has("tag")' "$spec")" = false ] || { echo "apk-rehearsal-spec: the tag is still in the spec" >&2; exit 1; }
[ "$(yq '.pipeline[0].with.expected-commit' "$spec")" = "$commit" ] || { echo "apk-rehearsal-spec: the commit pin changed" >&2; exit 1; }
yq '.pipeline[0].with' "$spec"
