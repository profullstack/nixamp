#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd "$(dirname "$0")" && pwd)"
repository_dir="$(cd "$project_dir/.." && pwd)"
apk="${1:-$project_dir/app/build/outputs/apk/release/app-release.apk}"
public_apk="$repository_dir/backtoschool/public/backtoschoohelp.apk"

if [[ ! -f "$apk" ]]; then
  printf 'APK not found: %s\n' "$apk" >&2
  exit 1
fi

if command -v apksigner >/dev/null 2>&1; then
  apksigner verify --verbose "$apk"
fi

install -m 0644 "$apk" "$public_apk"
sha256sum "$public_apk" > "$public_apk.sha256"

cd "$repository_dir"
bun run backtoschool:build

test -f "$repository_dir/backtoschool/dist/backtoschoohelp.apk"
printf 'Staged %s\n' "$repository_dir/backtoschool/dist/backtoschoohelp.apk"
printf 'Public URL after deployment: https://backtoschool.help/backtoschoohelp.apk\n'
