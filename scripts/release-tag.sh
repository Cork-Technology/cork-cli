#!/bin/sh
# Create a SIGNED release tag, prove the signature verifies, and only then push it.
#
#   sh scripts/release-tag.sh <tag> <commit> [remote] [message]
#
# remote defaults to cork-cli (release tags live only on the public repo); message defaults to
# the tag name. The tag must start with v; the commit must resolve; a tag of that name must not
# already exist locally (delete one deliberately, never through this script).
#
# Why a script: with an ssh-sk (FIDO) signing key, an untouched key makes the middleware return
# a ZERO-FILLED signature with a clean exit. `git tag -s` then reports success, and only
# `git tag -v` tells the truth ("incorrect signature"). On 2026-08-21 three such tags were
# created in a row before anyone noticed; a push would have published an unverifiable tag.
# This script never pushes a tag whose signature did not verify as Good against the configured
# allowed signers, and deletes the bad local tag so it cannot be pushed by hand later.
set -eu

tag="${1:?tag}"; commit="${2:?commit}"; remote="${3:-cork-cli}"; message="${4:-$1}"
case "$tag" in v[0-9]*) ;; *) echo "release-tag: tag must start with v (got: $tag)" >&2; exit 2 ;; esac
sha="$(git rev-parse --verify --quiet "$commit^{commit}")" || { echo "release-tag: $commit is not a commit" >&2; exit 2; }
if git show-ref --verify --quiet "refs/tags/$tag"; then
  echo "release-tag: $tag already exists locally — inspect it (git tag -v $tag) and delete it deliberately first" >&2
  exit 2
fi

echo "release-tag: signing $tag at $sha — touch the key if it blinks" >&2
git tag -s "$tag" "$sha" -m "$message"
# The EXIT STATUS is the verdict, not the text: for a signer outside the allowed-signers list git
# still prints `Good "git" signature with …` and only then `No principal matched.` (non-zero).
# A grep for "Good" passes that; the exit status does not.
if ! git tag -v "$tag" >/dev/null 2>&1; then
  git tag -v "$tag" 2>&1 | tail -1 >&2
  git tag -d "$tag" >/dev/null
  echo "release-tag: the signature on $tag did NOT verify — tag deleted, nothing pushed (untouched FIDO key? wrong signing key?)" >&2
  exit 1
fi
echo "release-tag: signature verified" >&2
git push "$remote" "refs/tags/$tag"
