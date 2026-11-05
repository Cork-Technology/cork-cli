#!/bin/sh
# Read-only, authenticated admission for a component cut. Never creates packages or changes visibility.
set -eu
repo="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
case "$repo" in
  Cork-Technology/cork-cli) image=ghcr.io/cork-technology/cork-cli ;;
  *) echo 'release-preflight: unrecognized component repository' >&2; exit 1 ;;
esac
: "${GH_TOKEN:?authorized GH_TOKEN is required}"
case "$GH_TOKEN" in *[!A-Za-z0-9_.-]*) echo 'release-preflight: malformed authentication token' >&2; exit 1 ;; esac
api="${CORK_RELEASE_API_URL:-https://api.github.com}"
case "$api" in https://api.github.com|http://127.0.0.1:*|http://localhost:*) ;; *) echo 'release-preflight: untrusted API origin' >&2; exit 1 ;; esac
work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT HUP INT TERM
request() {
  # Token travels on stdin, never in argv, a spec, provenance, or output. No redirects.
  status=$(printf 'header = "Authorization: Bearer %s"\nheader = "Accept: application/vnd.github+json"\n' "$GH_TOKEN" |
    curl --silent --show-error --config - --max-time 30 --output "$work/body" --write-out '%{http_code}' "$api/$1")
}
require_ok() { [ "$status" = 200 ] || { echo "release-preflight: authenticated $1 read failed (HTTP $status)" >&2; exit 1; }; }
request "repos/$repo"; require_ok repository
jq -e --arg r "$repo" '.full_name == $r and .private == false and .visibility == "public"' "$work/body" >/dev/null || { echo 'release-preflight: repository identity/visibility mismatch' >&2; exit 1; }
mode="${1:-release}"
case "$mode" in
  config-current|config-readback)
    branch="${2:?config branch}"; dest="${3:?destination file}"
    printf '%s' "$branch" | grep -Eq '^config/[0-9]+\.[0-9]+$' || { echo 'release-preflight: invalid config branch' >&2; exit 1; }
    # Metadata access alone does not prove contents authorization. Prove it against main
    # before treating a target ref's 404 as absence (GitHub hides inaccessible resources).
    request "repos/$repo/git/ref/heads/main"; require_ok 'known source branch authorization'
    request "repos/$repo/git/ref/heads/$branch"
    if [ "$status" = 404 ] && [ "$mode" = config-current ]; then
      echo 'exists=false'; echo 'unchanged=false'; exit 0
    fi
    require_ok 'config branch'
    request "repos/$repo/contents/cork-defaults.v2.json?ref=$branch"; require_ok 'config contents'
    jq -e '.encoding == "base64" and (.content | type == "string") and (.sha | test("^[0-9a-f]{40}$"))' "$work/body" >/dev/null || { echo 'release-preflight: malformed config contents' >&2; exit 1; }
    jq -r .content "$work/body" | base64 -d > "$dest"
    echo 'exists=true'; printf 'blob=%s\n' "$(jq -r .sha "$work/body")"
    exit 0 ;;
  identity|release|image|publish|release-readback|deploy) ;;
  *) echo 'release-preflight: unknown mode' >&2; exit 1 ;;
esac
tag="${RELEASE_TAG:?RELEASE_TAG is required}"
printf '%s' "$tag" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+(-rc\.[0-9]+)?$' || { echo 'release-preflight: unsupported release tag' >&2; exit 1; }
case "$tag" in *-rc.*) candidate=true ;; *) candidate=false ;; esac
expected="${RELEASE_COMMIT:-${GITHUB_SHA:?expected source commit is required}}"
printf '%s' "$expected" | grep -Eq '^[0-9a-f]{40}$' || { echo 'release-preflight: invalid source commit' >&2; exit 1; }
request "repos/$repo/git/ref/tags/$tag"; require_ok 'release tag'
depth=0
while :; do
  jq -e '.object.sha | test("^[0-9a-f]{40}$")' "$work/body" >/dev/null || { echo 'release-preflight: malformed tag object' >&2; exit 1; }
  sha="$(jq -r .object.sha "$work/body")"; kind="$(jq -r .object.type "$work/body")"
  case "$kind" in
    commit) break ;;
    tag) depth=$((depth + 1)); [ "$depth" -le 4 ] || { echo 'release-preflight: tag peel depth exceeded' >&2; exit 1; }
         request "repos/$repo/git/tags/$sha"; require_ok 'annotated tag' ;;
    *) echo 'release-preflight: tag does not name a commit' >&2; exit 1 ;;
  esac
done
[ "$sha" = "$expected" ] || { echo 'release-preflight: live tag does not resolve to the exact artifact source commit' >&2; exit 1; }
if [ "$mode" = release-readback ]; then
  # Settings admission is not proof that the published Release itself is immutable.
  case "$tag" in v0.*|*-rc.*) prerelease=true ;; *) prerelease=false ;; esac
  request "repos/$repo/releases/tags/$tag"; require_ok 'published Release (publication already occurred; reconcile before any retry)'
  jq -e --arg t "$tag" --argjson p "$prerelease" ' .tag_name == $t and .immutable == true and .draft == false and .prerelease == $p ' "$work/body" >/dev/null || {
    echo 'release-preflight: published Release metadata is not confirmed immutable with the intended tag/status; publication already occurred, reconcile before any retry' >&2; exit 1
  }
  echo 'release=immutable'
fi
printf 'commit=%s\n' "$sha"
printf 'repo=%s\nimage=%s\ncandidate=%s\n' "$repo" "$image" "$candidate"
