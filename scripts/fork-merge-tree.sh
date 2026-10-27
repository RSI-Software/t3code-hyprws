#!/usr/bin/env bash
# Merge-tree conflict gate: is this head harder to rebase than the trunk?
# `git merge-tree --write-tree upstream/main <ref>` lists every path whose
# merge back into live upstream/main conflicts. Running it for the head and
# for origin/hyprws separates conflicts the head introduces (head-only paths
# fail the gate) from conflicts the trunk already carries (silent). The
# hyprws CI merge-tree job and `vp run fork:ci` both run this file, against
# whatever upstream/main and origin/hyprws the checkout has fetched.
#
# Usage: bash scripts/fork-merge-tree.sh <head>
set -euo pipefail

head_sha="${1:?usage: fork-merge-tree.sh <head>}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# 0 is clean, 1 is conflicts; anything else is a broken invocation that must
# fail loudly rather than pass silent.
conflicts() {
  local code=0
  git merge-tree --write-tree --name-only --no-messages upstream/main "$1" >"$work/out" || code=$?
  if [ "$code" -ne 0 ] && [ "$code" -ne 1 ]; then
    echo "merge-tree for $1 failed (exit $code)" >&2
    exit "$code"
  fi
  tail -n +2 "$work/out" | sort -u
}

conflicts "$head_sha" >"$work/head"
conflicts origin/hyprws >"$work/base"
comm -23 "$work/head" "$work/base" >"$work/head-only"

if [ -s "$work/head-only" ]; then
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    {
      printf '## Merge-tree conflicts introduced by this head\n\n'
      printf 'These paths conflict against `upstream/main` for this head but not for `origin/hyprws`:\n\n```\n'
      cat "$work/head-only"
      printf '```\n'
    } >>"$GITHUB_STEP_SUMMARY"
  fi
  echo "head-only merge-tree conflicts:" >&2
  cat "$work/head-only" >&2
  exit 1
fi
echo "merge-tree clean: no head-only conflicts"
