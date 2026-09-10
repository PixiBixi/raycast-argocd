#!/usr/bin/env bash
#
# Puts the extension in a state where a screenshot cannot show a real deployment, then puts
# it back.
#
# The demo server is necessary but not sufficient. Real instances stay configured, and the
# instance name is rendered in four places: as a section header and as a coloured tag on
# every row (ApplicationListView.tsx, ApplicationListItem.tsx), in the scope dropdown, and in
# navigation titles. Manage Instances shows every instance with its host, by design, and no
# flag filters that view.
#
# Raycast derives both LocalStorage and the support path from the extension's `name`, so a
# throwaway name yields an empty instance list, an empty projection cache and empty recents,
# while the real configuration sits untouched under the real name and comes back with it.
# Nothing is deleted and no token is re-entered.
#
#   ./scripts/screenshot-clean-room.sh enter    # then npm run demo, npm run dev, capture
#   ./scripts/screenshot-clean-room.sh leave    # restores the real name
set -euo pipefail

cd "$(dirname "$0")/.."

readonly REAL_NAME="argocd"
readonly TEMP_NAME="argocd-screenshots"
readonly SUPPORT="$HOME/Library/Application Support/com.raycast.macos/extensions"

name_now() { node -p 'require("./package.json").name'; }

set_name() {
  node --input-type=module -e '
    import { readFileSync, writeFileSync } from "node:fs";
    const [, , next] = process.argv;
    const raw = readFileSync("package.json", "utf8");
    const parsed = JSON.parse(raw);
    parsed.name = next;
    writeFileSync("package.json", JSON.stringify(parsed, null, 2) + "\n");
  ' -- "$1"
  npx prettier --write package.json >/dev/null
}

case "${1:-}" in
  enter)
    if [ -n "$(git status --porcelain)" ]; then
      printf '::error::the working tree is dirty; commit or stash first so leaving is a clean revert\n' >&2
      exit 1
    fi
    if [ "$(name_now)" != "$REAL_NAME" ]; then
      printf '::error::name is already %s, not %s; run leave first\n' "$(name_now)" "$REAL_NAME" >&2
      exit 1
    fi
    set_name "$TEMP_NAME"
    cat <<TEXT
Clean room entered. package.json name is now $TEMP_NAME, so Raycast will hand the extension
an empty LocalStorage and an empty support path. Your real instances are untouched.

  1. node scripts/demo-argocd.mjs
  2. npm run dev
  3. Manage Instances -> add http://127.0.0.1:8080, auth mode "token", any token value.
     Name it something neutral: that name appears on every row and in every section header.
  4. Bind Window Capture in Raycast's Advanced Preferences, tick "Save to Metadata",
     and capture 3 to 6 views. It writes 2000x1250 PNGs into metadata/ directly.
  5. ./scripts/screenshot-clean-room.sh leave
  6. npm run store:payload

Verify before each capture that the only instance listed is the demo one.
TEXT
    ;;
  leave)
    if [ "$(name_now)" != "$TEMP_NAME" ]; then
      printf 'name is %s already; nothing to restore.\n' "$(name_now)"
      exit 0
    fi
    set_name "$REAL_NAME"
    rm -rf "$SUPPORT/$TEMP_NAME"
    printf 'Real name restored. Throwaway storage removed.\n'
    printf 'Your instances are back: they were never touched, they live under %s.\n' "$SUPPORT/$REAL_NAME"
    ;;
  *)
    printf 'usage: %s enter|leave\n' "$0" >&2
    exit 2
    ;;
esac
