#!/bin/sh
# Print the version pinned for one tool in mise.toml's [tools] table — the ONE place a toolchain
# version lives. Every other consumer derives from it: mise itself (local dev, jdx/mise-action in
# CI and the release builds), scripts/apk-spec-identity.sh (the melange build package constraint
# `bun~<pin>`), and the melange spec's build-time assertion. One parser, so no two readers can
# disagree about what the file says.
#
#   sh scripts/toolchain-pin.sh <tool> [mise.toml]
#
# The pin must be EXACT (digits and dots, e.g. 1.3.14): `bun build --compile` embeds the runtime,
# so a range or "latest" would make the reproducible-build statement float. A key outside the
# [tools] table, a single-quoted or unquoted value, or a missing key is reported, never guessed.
set -eu

tool="${1:?tool name}"; mise="${2:-$(dirname "$0")/../mise.toml}"
[ -f "$mise" ] || { echo "toolchain-pin: mise.toml not found: $mise" >&2; exit 2; }

pin="$(awk -v tool="$tool" '
  /^[[:space:]]*\[/ { intools = ($0 ~ /^[[:space:]]*\[tools\][[:space:]]*(#.*)?$/); next }
  intools && $0 ~ ("^[[:space:]]*" tool "[[:space:]]*=[[:space:]]*\"") {
    v = $0; sub(/^[^"]*"/, "", v); sub(/".*$/, "", v); print v; exit
  }
' "$mise")"
[ -n "$pin" ] || { echo "toolchain-pin: no \`$tool = \"X.Y.Z\"\` under [tools] in $mise" >&2; exit 2; }
printf '%s' "$pin" | grep -Eq '^[0-9]+(\.[0-9]+)+$' \
  || { echo "toolchain-pin: $tool is pinned to \"$pin\" in $mise — an exact version (digits and dots) is required, not a range or alias" >&2; exit 2; }
printf '%s\n' "$pin"
