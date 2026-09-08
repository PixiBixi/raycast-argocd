#!/usr/bin/env bash
#
# Assembles exactly the files that belong in a raycast/extensions pull request, and refuses
# to produce anything when a store requirement is unmet.
#
# This exists because `ray publish` copies the whole extension directory minus a hardcoded
# ignore list -- ".git", ".github", "node_modules", "raycast-env.d.ts", ".direnv",
# ".raycast-swift-build", ".swiftpm", "compiled_raycast_swift", "compiled_raycast_rust" --
# and nothing else. openwiki/ and docs/ are not on that list, so they would travel into a
# repository owned by someone else, permanently, along with the measured figures and the
# instance topology they describe. The list cannot be extended, so the payload is assembled
# here instead and the pull request is opened by hand.
#
# The kept set is not invented: it is what published extensions actually carry. jira and
# brew both ship metadata/ and a test directory, brew ships vitest.config.ts, gitlab ships
# scripts/ and AGENTS.md. Tests are welcome; a wiki is not, because no published extension
# has one and it is not extension content.
set -euo pipefail

cd "$(dirname "$0")/.."

readonly OUT="${1:-dist/store-payload}"

# What travels. Anything absent here is deliberate, not forgotten:
#   openwiki/ docs/        repository-side documentation, describes internal topology
#   .github/ scripts/      this repository's CI, meaningless in the monorepo
#   AGENTS.md              links into openwiki/, which does not travel
#   .nvmrc                 pins a toolchain the monorepo pins itself
readonly KEEP=(
  package.json package-lock.json tsconfig.json
  eslint.config.mjs .prettierrc .prettierignore .gitignore
  README.md CHANGELOG.md LICENSE
  vitest.config.mts
  src assets metadata tests
)

fail=0
refuse() {
  fail=1
  printf '::error::%s\n' "$1" >&2
}

# 1. Screenshots. ray lint skips this check outright when metadata/ is absent, so a green
#    lint says nothing about it. Checked here instead, where absence is a refusal.
if [ ! -d metadata ]; then
  refuse "metadata/ is missing: the store needs 3 to 6 screenshots, PNG, exactly 2000x1250."
else
  shots=$(find metadata -maxdepth 1 -name '*.png' | sort)
  count=$(printf '%s\n' "$shots" | grep -c . || true)
  if [ "$count" -lt 3 ] || [ "$count" -gt 6 ]; then
    refuse "metadata/ holds $count PNG screenshots; the store wants between 3 and 6."
  fi
  while IFS= read -r shot; do
    [ -n "$shot" ] || continue
    size=$(python3 - "$shot" <<'PY'
import struct, sys
with open(sys.argv[1], "rb") as fh:
    head = fh.read(24)
if head[:8] != b"\x89PNG\r\n\x1a\n":
    print("notpng"); raise SystemExit
print("%dx%d" % struct.unpack(">II", head[16:24]))
PY
)
    case "$size" in
      2000x1250) ;;
      notpng) refuse "$shot is not a PNG." ;;
      *) refuse "$shot is ${size}; the store requires exactly 2000x1250 (take it on a retina screen)." ;;
    esac
  done <<< "$shots"
fi

# 2. The manifest fields the store reads. `author` must be the Raycast account username,
#    which is not necessarily the GitHub one.
node --input-type=module -e '
  import { readFileSync } from "node:fs";
  const p = JSON.parse(readFileSync("package.json", "utf8"));
  const missing = ["name", "title", "description", "icon", "author", "license", "categories"]
    .filter((k) => !p[k] || (Array.isArray(p[k]) && p[k].length === 0));
  if (missing.length > 0) {
    console.error(`::error::package.json is missing: ${missing.join(", ")}`);
    process.exit(1);
  }
  if (p.license !== "MIT") {
    console.error(`::error::license is ${p.license}; the store expects MIT`);
    process.exit(1);
  }
  if (p.version !== undefined) {
    console.error("::error::an extension is not versioned; remove the version field");
    process.exit(1);
  }
' || fail=1

# 3. The first CHANGELOG heading carries the merge-date placeholder Raycast substitutes.
if ! head -1 CHANGELOG.md | grep -qE '^## \[.+\] - \{PR_MERGE_DATE\}$'; then
  refuse "CHANGELOG.md must open with '## [Title] - {PR_MERGE_DATE}'; got: $(head -1 CHANGELOG.md)"
fi

# 4. Nothing identifying, and nothing personal, in what ships.
./scripts/check-no-secrets.sh >/dev/null || refuse "the leak gate failed; run ./scripts/check-no-secrets.sh"

# 5. It has to build.
npm run build >/dev/null 2>&1 || refuse "npm run build failed"

if [ "$fail" -ne 0 ]; then
  printf 'No payload written.\n' >&2
  exit 1
fi

rm -rf "$OUT"
mkdir -p "$OUT"
for entry in "${KEEP[@]}"; do
  [ -e "$entry" ] || continue
  cp -R "$entry" "$OUT/"
done

printf 'Payload for raycast/extensions/extensions/%s written to %s:\n' \
  "$(node -p 'require("./package.json").name')" "$OUT"
(cd "$OUT" && find . -type f | sed 's|^\./||' | sort | sed 's/^/  /')
