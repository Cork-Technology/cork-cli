#!/bin/sh
# Create a SIGNED release tag, prove the signature verifies, and only then push it.
#
#   sh scripts/release-tag.sh <tag> <commit> [remote] [message]
#
# remote defaults to cork-cli (release tags live only on the public repo); message defaults to
# the tag name. The tag must start with v; the commit must resolve; a tag of that name must not
# already exist locally (delete one deliberately, never through this script).
#
# The candidate must ALSO be the exact head of the advertised public main (audit SUPPLY-001,
# 2026-08-24). `git push <remote> refs/tags/<tag>` sends every object the tag reaches that the
# remote lacks: tagging a private-only commit would publish that commit AND its whole reachable
# history to the public repo. scripts/port-to-public.ts prints a ported head; that head must be
# pushed to public main FIRST, and this script re-fetches main and requires equality before it
# signs anything. The remote is compared by IDENTITY (host/owner/repo, normalised), not by URL
# literal: ssh and https spellings of the same repo are the same repo, and a look-alike host is
# not.
#
# Why a script: with an ssh-sk (FIDO) signing key, an untouched key makes the middleware return
# a ZERO-FILLED signature with a clean exit. `git tag -s` then reports success, and only
# `git tag -v` tells the truth ("incorrect signature"). On 2026-08-21 three such tags were
# created in a row before anyone noticed; a push would have published an unverifiable tag.
# This script never pushes a tag whose signature did not verify as Good against the configured
# allowed signers, and deletes the bad local tag so it cannot be pushed by hand later.
set -eu

tag="${1:?tag}"; commit="${2:?commit}"; remote="${3:-cork-cli}"; message="${4:-$1}"
canonical_repo="${CORK_RELEASE_REPO:-github.com/cork-technology/cork-cli}"
case "$tag" in v[0-9]*) ;; *) echo "release-tag: tag must start with v (got: $tag)" >&2; exit 2 ;; esac
sha="$(git rev-parse --verify --quiet "$commit^{commit}")" || { echo "release-tag: $commit is not a commit" >&2; exit 2; }
if git show-ref --verify --quiet "refs/tags/$tag"; then
  echo "release-tag: $tag already exists locally — inspect it (git tag -v $tag) and delete it deliberately first" >&2
  exit 2
fi

# Remote IDENTITY, not URL literal: strip scheme/userinfo, turn the scp-style colon into a
# slash, drop the .git suffix, lowercase. git@github.com:Cork-Technology/cork-cli.git and
# https://github.com/Cork-Technology/cork-cli.git are the same repo; evil.example is not.
normalize_remote() {
  printf '%s' "$1" | sed -E 's#^[a-zA-Z+]+://##; s#^[^/@]*@##; s#:#/#; s#/+$##; s#\.git$##' | tr 'A-Z' 'a-z'
}
push_url="$(git remote get-url --push "$remote" 2>/dev/null)" || { echo "release-tag: no remote named $remote in this repository" >&2; exit 2; }
push_repo="$(normalize_remote "$push_url")"
if [ "$push_repo" != "$canonical_repo" ]; then
  echo "release-tag: $remote pushes to $push_repo, not the canonical public repo $canonical_repo — release tags live ONLY there" >&2
  exit 2
fi

# The candidate must be the exact head the public repo already advertises. Anything else — a
# private commit, an ancestor, a commit ahead of main — would publish objects main does not have.
if ! git fetch --quiet --no-tags "$remote" refs/heads/main; then
  echo "release-tag: could not fetch $remote refs/heads/main — the candidate cannot be checked against public main" >&2
  exit 2
fi
public_main="$(git rev-parse --verify --quiet FETCH_HEAD^{commit})" || { echo "release-tag: fetched $remote refs/heads/main is not a commit" >&2; exit 2; }
if [ "$sha" != "$public_main" ]; then
  echo "release-tag: $sha is not the head of public main ($public_main)." >&2
  echo "release-tag: pushing a tag also pushes every object it reaches — port and push the commit to public main FIRST, then tag that head." >&2
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
