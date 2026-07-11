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

log() { printf '\n=== %s ===\n' "$*" >&2; }

# Package the bridge binary into a per-platform dist/ tarball.
# Args: <slug> <path-to-bridge-binary>
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

# Package the chrome-launcher-helper as its OWN standalone release asset.
# Rationale (Yaniv 2026-07-09): the helper must be installed where the BROWSER
# runs, which in the WSL→Windows topology is a DIFFERENT machine than the one
# that pulls the bridge tarball (the agent host, typically linux-x64). Bundling
# it inside the win-x64 bridge tarball only serves an all-Windows setup and hides
# it from the split setup it exists for. So it ships as its own asset the browser
# host fetches independently: chrome-launcher-helper-<v>-<slug>.tar.gz.
# Args: <slug> <path-to-helper-binary>
package_helper() {
  local slug="$1" bin_src="$2"
  local bin_name="chrome-launcher-helper"
  [[ "$slug" == win-* ]] && bin_name="chrome-launcher-helper.exe"
  local art="$dist/chrome-launcher-helper-${version}-${slug}.tar.gz"
  local tmp; tmp="$(mktemp -d)"
  install -m 755 "$bin_src" "$tmp/$bin_name"
  printf '%s\n' "$version" > "$tmp/VERSION"
  ( cd "$tmp" && tar -czf "$art" "$bin_name" VERSION )
  rm -rf "$tmp"
  ( cd "$dist" && shasum -a 256 "$(basename "$art")" >> SHA256SUMS.txt 2>/dev/null \
      || sha256sum "$(basename "$art")" >> SHA256SUMS.txt )
  echo "$art"
}

build_linux() {
  log "linux-x64 (this host)"
  local target_dir="$repo_root/mcp/target"
  ( cd "$repo_root/mcp/actions-json-mcp" && cargo build --release --locked --target-dir "$target_dir" ) >&2
  package "linux-x64" "$target_dir/release/actions-json-mcp"
}

win_ps() { "$PWSH" -NoProfile -Command "$1" 2>&1 | grep -ivE 'UNC paths|CMD.EXE|wsl.localhost|started with the above|Defaulting to Windows'; }

build_windows() {
  log "win-x64 (Windows host)"
  # Ensure a Windows-side checkout at the release tag, then build. git and cargo
  # are on the Windows PATH; PowerShell runs from a real Windows cwd.
  # All build chatter to stderr so $(build_windows) captures only the artifact.
  {
    win_ps "if (-not (Test-Path '$WIN_REPO_WIN')) { git clone '$GIT_URL' '$WIN_REPO_WIN' }" | tail -2 || true
    win_ps "Set-Location '$WIN_REPO_WIN'; git fetch --tags --quiet; git checkout --quiet '$tag'" | tail -2
    win_ps "Set-Location '$WIN_REPO_WIN\\mcp\\actions-json-mcp'; cargo build --release --locked --target-dir '$WIN_REPO_WIN\\mcp\\target'" | tail -4
    # The native-Windows pipe owner: the WSL→Windows Chrome launch path can't own
    # the --remote-debugging-pipe fds from WSL. Built natively on the Windows host
    # and shipped as its OWN standalone release asset (see package_helper) so the
    # browser host can fetch it regardless of which bridge tarball the agent pulls.
    win_ps "Set-Location '$WIN_REPO_WIN\\mcp\\chrome-launcher-helper'; cargo build --release --locked --target-dir '$WIN_REPO_WIN\\mcp\\target'" | tail -4
  } >&2
  package "win-x64" "${WIN_REPO_WSL}/mcp/target/release/actions-json-mcp.exe"
  package_helper "win-x64" "${WIN_REPO_WSL}/mcp/target/release/chrome-launcher-helper.exe"
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
  local remote="$MAC_REPO/mcp/target/$target/release/actions-json-mcp"
  local local_bin="$dist/.mac-$slug-actions-json-mcp"
  # Build + fetch chatter to stderr so the capture sees only the artifact path.
  {
    mac_ssh "$MAC_PATH_EXPORT; cd '$MAC_REPO/mcp/actions-json-mcp' && \
      cargo build --release --locked --target $target --target-dir '$MAC_REPO/mcp/target'" 2>&1 | tail -4
    scp -i "$MAC_KEY" -o IdentitiesOnly=yes "$MAC_HOST:$remote" "$local_bin" 2>&1 | tail -1
  } >&2
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
rm -f "$dist/actions-json-overlay-runtime-${version}.zip" \
  "$dist"/actions-json-mcp-"$version"-*.tar.gz \
  "$dist"/chrome-launcher-helper-"$version"-*.tar.gz
IFS=',' read -ra wanted <<< "$platforms"
mac_needed=0
for p in "${wanted[@]}"; do [[ "$p" == macos-* ]] && mac_needed=1; done
[[ "$mac_needed" == 1 ]] && { log "syncing Mac checkout to $tag"; mac_prepare; }

built=()
# collect(): append each newline-separated artifact path from a build_* function
# as its own array element. build_windows emits TWO paths (bridge tarball + the
# standalone chrome-launcher-helper asset), so a plain built+=("$(...)") would
# collapse both into one malformed element — split on newlines here.
collect() { local line; while IFS= read -r line; do [[ -n "$line" ]] && built+=("$line"); done; }
[[ "$no_extension" == 0 ]] && collect < <(build_extension)
for p in "${wanted[@]}"; do
  case "$p" in
    linux-x64)   collect < <(build_linux) ;;
    win-x64)     collect < <(build_windows) ;;
    macos-arm64) collect < <(build_mac macos-arm64 aarch64-apple-darwin) ;;
    macos-x64)   collect < <(build_mac macos-x64 x86_64-apple-darwin) ;;
    *) echo "unknown platform: $p" >&2; exit 2 ;;
  esac
done

# VERIFY-OR-FAIL (the postcondition). A platform build runs inside
# `collect < <(build_x)`, and a process substitution's exit status is NOT
# propagated — `set -euo pipefail` cannot see it. So a failed build is silently
# discarded and the script would march on to publish a PARTIAL release.
# (Real: 2026-07-09, win-x64's Windows-side `git checkout <tag>` failed, three of
# four tarballs were produced, and the script exited 0. A release cut that way
# ships with no Windows bridge binary; npx users on Windows 404 on the pin.)
# Never trust "the loop ran" as "the artifacts exist" — assert the artifacts.
verify_artifacts() {
  local missing=() p art
  for p in "${wanted[@]}"; do
    art="$dist/actions-json-mcp-${version}-${p}.tar.gz"
    [[ -s "$art" ]] || missing+=("$p ($(basename "$art"))")
  done
  if (( ${#missing[@]} )); then
    echo "" >&2
    echo "RELEASE ABORTED — ${#missing[@]} requested platform(s) produced no tarball:" >&2
    printf '  - %s\n' "${missing[@]}" >&2
    echo "" >&2
    echo "A platform build failed (a process substitution hides its exit status, so" >&2
    echo "the failure is not otherwise visible). Scroll up for that platform's output." >&2
    echo "" >&2
    echo "Common cause for win-x64: it clones \$GIT_URL (= \$repo, default the PUBLIC" >&2
    echo "repo) and checks out '$tag'. A tag that only exists on the DEV repo will not" >&2
    echo "resolve there — so the bridge binaries can only be cut AFTER the tag is" >&2
    echo "pushed to \$repo. Pass --repo/--tag to match where the tag actually lives." >&2
    echo "" >&2
    echo "Do NOT publish a partial release." >&2
    exit 1
  fi
}
verify_artifacts

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
