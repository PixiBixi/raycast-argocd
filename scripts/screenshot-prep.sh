#!/usr/bin/env bash
#
# Empties the on-disk caches so a screenshot cannot paint real application names, and prints
# what still has to be done by hand.
#
# This replaced a version that renamed the extension in package.json, on the theory that
# Raycast keys LocalStorage off the extension `name` and a throwaway name would therefore give
# an empty instance list. It does not: the support path is keyed by the name, LocalStorage is
# not. The rename bought only what this script now does directly, and it cost two things that
# were not worth it:
#
#   - Raycast registered the renamed extension as a SECOND extension. Both carry
#     title "ArgoCD", so the root search showed every command twice, indistinguishable, and
#     removing the stale one is a manual step in Raycast's settings.
#   - package.json churn, needing a guard so the throwaway name could not be published.
#
# Deleting the caches needs no identity change and nothing to restore: both are rebuilt from
# the API on the next load.
set -euo pipefail

cd "$(dirname "$0")/.."

readonly SUPPORT="$HOME/Library/Application Support/com.raycast.macos/extensions/argocd"

removed=0
for dir in "cache" "com.raycast.api.cache"; do
  target="$SUPPORT/$dir"
  if [ -d "$target" ]; then
    size=$(du -sh "$target" 2>/dev/null | cut -f1)
    rm -rf "$target"
    printf 'cleared %s (%s)\n' "$dir" "$size"
    removed=$((removed + 1))
  fi
done
[ "$removed" -eq 0 ] && printf 'nothing to clear; the caches are already empty.\n'

# Read back, because a delete that is never checked is how this repository keeps being wrong.
for dir in "cache" "com.raycast.api.cache"; do
  if [ -d "$SUPPORT/$dir" ]; then
    printf '::error::%s still exists after deletion\n' "$SUPPORT/$dir" >&2
    exit 1
  fi
done

cat <<'TEXT'

The caches are gone, so nothing real can paint before the first refresh. The rest is by hand,
because no flag and no script can do it:

  1. node scripts/demo-argocd.mjs, then npm run dev in another terminal, and keep it running.
  2. Manage Instances -> add http://127.0.0.1:8080, auth mode "token", any token value.
     Give it a neutral name: that name is rendered on every row and every section header.
  3. Manage Instances -> "Exclude from Searches" on each real instance. They read "excluded"
     afterwards, and only the demo one may stay included.
  4. Open Search Applications once. It is what fills the applications cache, and the
     ApplicationSets rollups read that cache, so they show no counts until you do.
  5. Capture with Raycast's Window Capture, "Save to Metadata" ticked. Name them
     argocd-1.png upwards; the store orders screenshots by filename.
     Do NOT capture Manage Instances: it lists every instance with its host, excluded or not.
  6. Re-include the real instances, then npm run store:payload.

Check the rows before each capture. Every row carries its instance name as a tag, so one real
tag anywhere in frame is a leak.
TEXT
