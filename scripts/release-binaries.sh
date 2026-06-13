#!/usr/bin/env bash
set -euo pipefail

# Builds the full actions.json release on real machines — no GitHub runners.
# Packages the extension, builds the bridge for every platform on a real host
# of that platform, creates the GitHub release if needed, and uploads
# everything.
#
#   extension    : this host (zip)
#   linux-x64    : this host (native cargo)
#   win-x64      : the Windows host, via PowerShell + a Windows-side checkout
#   macos-arm64  : the Mac, native (aarch64-apple-darwin), over SSH
#   macos-x64    : the Mac, cross-compiled (x86_64-apple-darwin), over SSH
#
# Usage:
#   scripts/release-binaries.sh --version 0.1.119 [--tag extension-v0.1.119] \
#       [--repo yaniv256/actions.json] \
#       [--platforms linux-x64,win-x64,macos-arm64,macos-x64] \
#       [--no-extension] [--no-upload]
#
# Each platform produces actions-json-mcp-<version>-<slug>.tar.gz in dist/.
# Unless --no-upload, the release for --tag is created if missing and all
# artifacts are uploaded.

version=""
tag=""
repo="yaniv256/actions.json"
platforms="linux-x64,win-x64,macos-arm64,macos-x64"
no_upload=0
no_extension=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version)      version="${2:?}"; shift 2 ;;
    --tag)          tag="${2:?}"; shift 2 ;;
    --repo)         repo="${2:?}"; shift 2 ;;
    --platforms)    platforms="${2:?}"; shift 2 ;;
    --no-upload)    no_upload=1; shift ;;
    --no-extension) no_extension=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

[[ -z "$version" ]] && { echo "--version is required" >&2; exit 2; }
[[ -z "$tag" ]] && tag="extension-v${version}"

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
dist="$repo_root/dist"
mkdir -p "$dist"

# --- Config (override via env) -----------------------------------------------
MAC_HOST="${MAC_HOST:-$USER@10.42.0.4}"
MAC_KEY="${MAC_KEY:-$HOME/.ssh/id_ed25519_mac}"
MAC_REPO="${MAC_REPO:-/Users/agent-zara/Projects/actions.json}"
MAC_PATH_EXPORT='export PATH=/opt/homebrew/bin:$HOME/.cargo/bin:$PATH'

# git and cargo are on the Windows PATH, so PowerShell can call them by name.
WIN_REPO_WIN="${WIN_REPO_WIN:-C:\\Users\\yaniv\\Projects\\actions.json}"
WIN_REPO_WSL="${WIN_REPO_WSL:-/mnt/c/Users/yaniv/Projects/actions.json}"
PWSH="${PWSH:-/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe}"

GIT_URL="https://github.com/${repo}.git"

log() { printf '\n=== %s ===\n' "$*"; }

# Package a built binary into dist/ using the existing packaging conventions.
# Args: <slug> <path-to-binary>
package() {
  local slug="$1" bin_src="$2"
  local bin_name="actions-json-mcp"
  [[ "$slug" == win-* ]] && bin_name="actions-json-mcp.exe"
  local art="$dist/actions-json-mcp-${version}-${slug}.tar.gz"
  local tmp; tmp="$(mktemp -d)"
  install -m 755 "$bin_src" "$tmp/$bin_name"
  install -m 644 "$repo_root/mcp/actions-json-mcp/README.md" "$tmp/README.md"
  printf '%s\n' "$version" > "$tmp/VERSION"
  ( cd "$tmp" && tar -czf "$art" "$bin_name" README.md VERSION )
  rm -rf "$tmp"
  ( cd "$dist" && shasum -a 256 "$(basename "$art")" >> SHA256SUMS.txt 2>/dev/null \
      || sha256sum "$(basename "$art")" >> SHA256SUMS.txt )
  echo "$art"
}

build_linux() {
  log "linux-x64 (this host)"
  ( cd "$repo_root/mcp/actions-json-mcp" && cargo build --release --locked )
  package "linux-x64" "$repo_root/mcp/actions-json-mcp/target/release/actions-json-mcp"
}

win_ps() { "$PWSH" -NoProfile -Command "$1" 2>&1 | grep -ivE 'UNC paths|CMD.EXE|wsl.localhost|started with the above|Defaulting to Windows'; }

build_windows() {
  log "win-x64 (Windows host)"
  # Ensure a Windows-side checkout at the release tag, then build. git and cargo
  # are on the Windows PATH; PowerShell runs from a real Windows cwd.
  win_ps "if (-not (Test-Path '$WIN_REPO_WIN')) { git clone '$GIT_URL' '$WIN_REPO_WIN' }" | tail -2 || true
  win_ps "Set-Location '$WIN_REPO_WIN'; git fetch --tags --quiet; git checkout --quiet '$tag'" | tail -2
  win_ps "Set-Location '$WIN_REPO_WIN\\mcp\\actions-json-mcp'; cargo build --release --locked" | tail -4
  package "win-x64" "${WIN_REPO_WSL}/mcp/actions-json-mcp/target/release/actions-json-mcp.exe"
}

mac_ssh() { ssh -i "$MAC_KEY" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new "$MAC_HOST" "$@"; }

mac_prepare() {
  local token; token="$(gh auth token)"
  mac_ssh "$MAC_PATH_EXPORT; \
    if [ ! -d '$MAC_REPO' ]; then git clone https://${token}@github.com/${repo}.git '$MAC_REPO'; fi; \
    cd '$MAC_REPO' && git fetch --tags --quiet && git checkout --quiet '$tag' && \
    rustup target add aarch64-apple-darwin x86_64-apple-darwin >/dev/null 2>&1 || true" 2>&1 | tail -3
}

build_mac() {
  local slug="$1" target="$2"
  log "$slug (Mac, $target)"
  mac_ssh "$MAC_PATH_EXPORT; cd '$MAC_REPO/mcp/actions-json-mcp' && \
    cargo build --release --locked --target $target" 2>&1 | tail -4
  local remote="$MAC_REPO/mcp/actions-json-mcp/target/$target/release/actions-json-mcp"
  local local_bin="$dist/.mac-$slug-actions-json-mcp"
  scp -i "$MAC_KEY" -o IdentitiesOnly=yes "$MAC_HOST:$remote" "$local_bin" 2>&1 | tail -1
  package "$slug" "$local_bin"
  rm -f "$local_bin"
}

build_extension() {
  log "extension (this host)"
  # package-extension.sh writes its own SHA256SUMS.txt (overwriting); the bridge
  # builds then append to it, so the extension must be built first.
  bash "$repo_root/scripts/package-extension.sh" --version "$version" --out-dir "$dist" >/dev/null
  echo "$dist/actions-json-overlay-runtime-${version}.zip"
}

# --- Run ----------------------------------------------------------------------
rm -f "$dist/SHA256SUMS.txt"
IFS=',' read -ra wanted <<< "$platforms"
mac_needed=0
for p in "${wanted[@]}"; do [[ "$p" == macos-* ]] && mac_needed=1; done
[[ "$mac_needed" == 1 ]] && { log "syncing Mac checkout to $tag"; mac_prepare; }

built=()
[[ "$no_extension" == 0 ]] && built+=("$(build_extension)")
for p in "${wanted[@]}"; do
  case "$p" in
    linux-x64)   built+=("$(build_linux)") ;;
    win-x64)     built+=("$(build_windows)") ;;
    macos-arm64) built+=("$(build_mac macos-arm64 aarch64-apple-darwin)") ;;
    macos-x64)   built+=("$(build_mac macos-x64 x86_64-apple-darwin)") ;;
    *) echo "unknown platform: $p" >&2; exit 2 ;;
  esac
done

log "built artifacts"
printf '%s\n' "${built[@]}"

if [[ "$no_upload" == 0 ]]; then
  # Create the release if it doesn't exist yet (the tag must already be pushed).
  if ! gh release view "$tag" --repo "$repo" >/dev/null 2>&1; then
    log "creating release $tag on $repo"
    gh release create "$tag" --repo "$repo" --prerelease \
      --title "$tag" --notes "Release $version. Bridge binaries for linux-x64, macos-x64, macos-arm64, win-x64."
  fi
  log "uploading artifacts to release $tag"
  gh release upload "$tag" "${built[@]}" "$dist/SHA256SUMS.txt" --repo "$repo" --clobber
  log "done — ${tag} on ${repo}"
else
  log "skipped upload (--no-upload)"
fi
