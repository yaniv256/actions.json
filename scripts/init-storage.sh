#!/usr/bin/env bash
set -euo pipefail

# Creates a local .storage/ workspace from examples/storage-scaffold/.
#
# .storage/ lives inside the actions.json checkout but is gitignored — it is
# your data, not part of the code repo. Point the bridge at it with
# --storage-root .storage.
#
# Idempotent: refuses to overwrite an existing .storage/ unless --force.

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
src="$repo_root/examples/storage-scaffold"
dst="$repo_root/.storage"
force=0

for arg in "$@"; do
  case "$arg" in
    --force) force=1 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

if [[ ! -d "$src" ]]; then
  echo "scaffold not found at $src" >&2
  exit 1
fi

if [[ -d "$dst" && "$force" -ne 1 ]]; then
  echo ".storage/ already exists — leaving it untouched (use --force to reset)."
  exit 0
fi

rm -rf "$dst"
cp -R "$src" "$dst"
# .gitkeep files were only needed to ship empty dirs in the scaffold.
find "$dst" -name '.gitkeep' -delete

echo "Created $dst"
echo "Point the bridge at it with: --storage-root .storage"
