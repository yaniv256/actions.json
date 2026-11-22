#!/usr/bin/env bash
set -euo pipefail

# Builds the full actions.json release. Packages the extension, builds Linux
# and Windows on their native hosts, dispatches macOS builds to GitHub-hosted
# macOS runners, creates the GitHub release if needed, and uploads everything.
#
#   extension    : this host (zip)
#   linux-x64    : this host (native cargo)
#   win-x64      : the Windows host, via PowerShell + a Windows-side checkout
#   macos-arm64  : GitHub-hosted macOS runner (aarch64-apple-darwin)
#   macos-x64    : GitHub-hosted macOS runner (x86_64-apple-darwin)
#
# Usage:
#   scripts/release-binaries.sh --version 0.1.119 [--tag extension-v0.1.119] \
#       [--repo yaniv256/actions.json] \
#       [--no-upload]
#
# Each platform produces actions-json-<version>-<slug>.tar.gz in dist/.
# Unless --no-upload, the release for --tag is created if missing and all
# artifacts are uploaded.

version=""
tag=""
repo="yaniv256/actions.json"
no_upload=0
channel="stable"
counter=""
key_id="actions-json-stable-2026-01"
signing_key="${ACTIONS_JSON_RELEASE_SIGNING_KEY:-$HOME/.config/actions-json/release-signing-2026-01.pem}"
trust_file=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version)      version="${2:?}"; shift 2 ;;
    --tag)          tag="${2:?}"; shift 2 ;;
    --repo)         repo="${2:?}"; shift 2 ;;
    --platforms)    echo "complete releases require the extension and all four native platforms" >&2; exit 2 ;;
    --no-upload)    no_upload=1; shift ;;
    --no-extension) echo "complete releases require the extension and all four native platforms" >&2; exit 2 ;;
    --channel)       channel="${2:?}"; shift 2 ;;
    --counter)       counter="${2:?}"; shift 2 ;;
    --key-id)        key_id="${2:?}"; shift 2 ;;
    --signing-key)   signing_key="${2:?}"; shift 2 ;;
    --trust-file)    trust_file="${2:?}"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

[[ -z "$version" ]] && { echo "--version is required" >&2; exit 2; }
[[ -z "$tag" ]] && tag="extension-v${version}"
[[ "$counter" =~ ^[1-9][0-9]*$ ]] || { echo "--counter is required and must be a positive integer" >&2; exit 2; }
[[ -r "$signing_key" ]] || { echo "release signing key is not readable: $signing_key" >&2; exit 2; }
wanted=(linux-x64 win-x64 macos-arm64 macos-x64)

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
trust_file="${trust_file:-$repo_root/scripts/release-trust.json}"
dist="$repo_root/dist"
mkdir -p "$dist"
[[ -z "$(git -C "$repo_root" status --porcelain --untracked-files=all)" ]] || {
  echo "release requires a clean worktree so every platform builds exact HEAD" >&2; exit 1;
}
cargo_version="$(awk -F '"' '/^version = "/ { print $2; exit }' "$repo_root/mcp/actions-json-mcp/Cargo.toml")"
extension_version="$(node -p "require('$repo_root/extensions/chrome-overlay-runtime/manifest.json').version")"
[[ "$cargo_version" == "$version" && "$extension_version" == "$version" ]] || {
  echo "release version mismatch: requested=$version cargo=$cargo_version extension=$extension_version" >&2; exit 1;
}

# --- Config (override via env) -----------------------------------------------
MACOS_WORKFLOW="${MACOS_WORKFLOW:-build-macos-native.yml}"
MACOS_RUN_TIMEOUT_SECONDS="${MACOS_RUN_TIMEOUT_SECONDS:-3600}"
release_download_dir=""

# git and cargo are on the Windows PATH, so PowerShell can call them by name.
WIN_BUILD_ROOT_WIN="${WIN_BUILD_ROOT_WIN:-C:\\actions-json\\release}"
WIN_BUILD_ROOT_WSL="${WIN_BUILD_ROOT_WSL:-/mnt/c/actions-json/release}"
WIN_REPO_WIN=""
WIN_REPO_WSL=""
win_source_commit=""
PWSH="${PWSH:-/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe}"

log() { printf '\n=== %s ===\n' "$*" >&2; }

# Package the bridge binary into a per-platform dist/ tarball.
# Args: <slug> <path-to-bridge-binary>
package() {
  local slug="$1" bin_src="$2"
  local cli_name="actions-json"
  [[ "$slug" == win-* ]] && cli_name="actions-json.exe"
  local art="$dist/actions-json-${version}-${slug}.tar.gz"
  local tmp; tmp="$(mktemp -d)"
  install -m 755 "$bin_src" "$tmp/$cli_name"
  install -m 644 "$repo_root/mcp/actions-json-mcp/README.md" "$tmp/README.md"
  printf '%s\n' "$version" > "$tmp/VERSION"
  ( cd "$tmp" && tar -czf "$art" "$cli_name" README.md VERSION )
  rm -rf "$tmp"
  ( cd "$dist" && shasum -a 256 "$(basename "$art")" >> SHA256SUMS.txt 2>/dev/null \
      || sha256sum "$(basename "$art")" >> SHA256SUMS.txt )
  echo "$art"
}

# Package the chrome-launcher-helper as its OWN standalone release asset.
# Rationale (the product owner 2026-07-09): the helper must be installed where the BROWSER
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
  ( cd "$repo_root/mcp/actions-json-mcp" && CFLAGS="${CFLAGS:--O2}" cargo build --release --locked --target-dir "$target_dir" ) >&2
  [[ "$("$target_dir/release/actions-json-mcp" version | jq -r '.result.version')" == "$version" ]] || {
    echo "linux-x64 binary version mismatch" >&2; return 1;
  }
  package "linux-x64" "$target_dir/release/actions-json-mcp"
}

win_ps() {
  local output_file status
  # Native Windows processes launched from WSL cannot reliably inherit stdout
  # handles backed by the Linux filesystem. Keep this capture on DrvFS so the
  # child receives a native Windows file handle.
  output_file="$(mktemp "$WIN_BUILD_ROOT_WSL/powershell-output-XXXXXXXX")"
  # -NonInteractive prevents PowerShell from probing terminal capabilities
  # (including a cursor-position query) when this scripted release owns no
  # interactive console. Without it, WSL interop can fail before the command
  # runs with "Invalid argument".
  # WSL cannot start a Windows process while cwd names a Linux-only path (the
  # launcher fails with EINVAL before PowerShell can run Set-Location). Enter
  # the Windows-backed build root before crossing the interop boundary.
  if ( cd "$WIN_BUILD_ROOT_WSL" && "$PWSH" -NoProfile -NonInteractive -Command "$1; if (\$null -ne \$LASTEXITCODE) { exit \$LASTEXITCODE }" >"$output_file" 2>&1 ); then
    status=0
  else
    status=$?
  fi
  grep -ivE 'UNC paths|CMD.EXE|wsl.localhost|started with the above|Defaulting to Windows' "$output_file" || true
  rm -f -- "$output_file"
  return "$status"
}

build_windows() {
  log "win-x64 (Windows host)"
  # Build the exact source archive staged by windows_prepare. Cargo is on the
  # Windows PATH; PowerShell runs from a real Windows cwd.
  # All build chatter to stderr so $(build_windows) captures only the artifact.
  {
    win_ps "Set-Location '$WIN_REPO_WIN\\mcp\\actions-json-mcp'; cargo build --release --locked --target-dir '$WIN_REPO_WIN\\mcp\\target'" | tail -4 || return 1
    win_ps "\$reported = (& '$WIN_REPO_WIN\\mcp\\target\\release\\actions-json-mcp.exe' version | ConvertFrom-Json).result.version; if (\$reported -ne '$version') { throw 'win-x64 binary version mismatch' }" || return 1
    # The native-Windows pipe owner: the WSL→Windows Chrome launch path can't own
    # the --remote-debugging-pipe fds from WSL. Built natively on the Windows host
    # and shipped as its OWN standalone release asset (see package_helper) so the
    # browser host can fetch it regardless of which bridge tarball the agent pulls.
    win_ps "Set-Location '$WIN_REPO_WIN\\mcp\\chrome-launcher-helper'; cargo build --release --locked --target-dir '$WIN_REPO_WIN\\mcp\\target'" | tail -4 || return 1
  } >&2
  package "win-x64" "${WIN_REPO_WSL}/mcp/target/release/actions-json-mcp.exe" || return 1
  package_helper "win-x64" "${WIN_REPO_WSL}/mcp/target/release/chrome-launcher-helper.exe" || return 1
}

windows_prepare() {
  local commit root staging
  commit="$(git -C "$repo_root" rev-parse HEAD)"
  [[ "$commit" =~ ^[0-9a-f]{40}$ ]] || { echo "invalid release commit: $commit" >&2; return 1; }
  [[ "$WIN_BUILD_ROOT_WSL" == /mnt/c/* && "$WIN_BUILD_ROOT_WSL" != "/mnt/c" ]] || {
    echo "unsafe Windows build root" >&2; return 1;
  }
  case "/$WIN_BUILD_ROOT_WSL/" in *"/../"*|*"/./"*) echo "unsafe Windows build root" >&2; return 1 ;; esac
  mkdir -p "$WIN_BUILD_ROOT_WSL"
  root="$(realpath -e "$WIN_BUILD_ROOT_WSL")"
  [[ "$root" == /mnt/c/* ]] || { echo "Windows build root escaped /mnt/c" >&2; return 1; }
  win_source_commit="$commit"
  WIN_BUILD_ROOT_WSL="$root"
  WIN_REPO_WSL="$(mktemp -d "$root/actions-json-${commit}-XXXXXXXX")"
  WIN_REPO_WIN="$(wslpath -w "$WIN_REPO_WSL")"
  # DrvFS cannot apply every Unix directory mode or timestamp carried by a git
  # archive. Extract on the Linux filesystem first, then copy the exact bytes
  # and symlinks without asking /mnt/c to emulate metadata it does not support.
  staging="$(mktemp -d)"
  git -C "$repo_root" archive "$commit" | tar -xf - -C "$staging"
  rsync -rl --no-perms --no-times --omit-dir-times "$staging/" "$WIN_REPO_WSL/"
  rm -rf -- "$staging"
  printf '%s\n' "$commit" > "$WIN_REPO_WSL/.release-commit"
}

cleanup_release_workspace() {
  if [[ -n "$release_download_dir" ]]; then
    rm -rf -- "$release_download_dir"
  fi
  if [[ -n "$win_source_commit" && "$WIN_REPO_WSL" == "$WIN_BUILD_ROOT_WSL"/actions-json-"$win_source_commit"-* ]]; then
    rm -rf -- "$WIN_REPO_WSL"
  fi
}
trap cleanup_release_workspace EXIT

build_macos_on_github() {
  local commit request_id run_id deadline title slug artifact archive reported
  commit="$(git -C "$repo_root" rev-parse HEAD)"
  request_id="${commit:0:12}-$(date -u +%Y%m%dT%H%M%SZ)-$$"
  title="macOS native $version @ $commit ($request_id)"
  log "macOS native assets (GitHub-hosted runner)"
  gh api --method POST "repos/${repo}/actions/workflows/${MACOS_WORKFLOW}/dispatches" \
    -f ref="$tag" -f "inputs[version]=$version" -f "inputs[commit]=$commit" \
    -f "inputs[request_id]=$request_id"
  deadline=$((SECONDS + MACOS_RUN_TIMEOUT_SECONDS))
  run_id=""
  while [[ -z "$run_id" && $SECONDS -lt $deadline ]]; do
    run_id="$(gh api "repos/${repo}/actions/workflows/${MACOS_WORKFLOW}/runs?event=workflow_dispatch&head_sha=${commit}&per_page=20" \
      --jq ".workflow_runs[] | select(.display_title == \"$title\") | .id" | head -1)"
    [[ -n "$run_id" ]] || sleep 3
  done
  [[ -n "$run_id" ]] || { echo "timed out locating dispatched macOS workflow run" >&2; return 1; }
  gh run watch "$run_id" --repo "$repo" --exit-status || return 1
  [[ "$(gh api "repos/${repo}/actions/runs/${run_id}" --jq .head_sha)" == "$commit" ]] || {
    echo "macOS workflow run commit mismatch" >&2; return 1;
  }
  for slug in macos-arm64 macos-x64; do
    artifact="actions-json-${version}-${slug}"
    gh run download "$run_id" --repo "$repo" --name "$artifact" --dir "$dist/$artifact" || return 1
    archive="$dist/$artifact/actions-json-${version}-${slug}.tar.gz"
    [[ -s "$archive" ]] || { echo "missing macOS workflow artifact: $archive" >&2; return 1; }
    mv "$archive" "$dist/actions-json-${version}-${slug}.tar.gz"
    rmdir "$dist/$artifact"
    reported="$(tar -xOf "$dist/actions-json-${version}-${slug}.tar.gz" VERSION)"
    [[ "$reported" == "$version" ]] || { echo "$slug binary version mismatch" >&2; return 1; }
    [[ -n "$(tar -tzf "$dist/actions-json-${version}-${slug}.tar.gz" | grep -x actions-json)" ]] || {
      echo "$slug archive is missing the native CLI" >&2; return 1;
    }
    ( cd "$dist" && sha256sum "actions-json-${version}-${slug}.tar.gz" >> SHA256SUMS.txt )
    echo "$dist/actions-json-${version}-${slug}.tar.gz"
  done
}

build_extension() {
  log "extension (this host)"
  # package-extension.sh writes its own SHA256SUMS.txt (overwriting); the bridge
  # builds then append to it, so the extension must be built first.
  bash "$repo_root/scripts/package-extension.sh" --version "$version" --out-dir "$dist" >/dev/null
  [[ "$(unzip -p "$dist/actions-json-overlay-runtime-${version}.zip" manifest.json | jq -r '.version')" == "$version" ]] || {
    echo "packaged extension version mismatch" >&2; return 1;
  }
  echo "$dist/actions-json-overlay-runtime-${version}.zip"
}

# --- Run ----------------------------------------------------------------------
rm -f "$dist/SHA256SUMS.txt"
rm -f "$dist/actions-json-overlay-runtime-${version}.zip" \
  "$dist"/actions-json-"$version"-*.tar.gz \
  "$dist"/chrome-launcher-helper-"$version"-*.tar.gz
log "syncing Windows source for exact HEAD"
windows_prepare

built=()
# Run builders in the main shell with stdout captured by a regular file. A
# process substitution both hides the builder's exit status and prevents WSL
# from launching native Windows programs reliably. The file preserves distinct
# artifact lines while allowing set -e to observe a failed platform build.
collect_build() {
  local output_file line status
  output_file="$(mktemp)"
  if "$@" >"$output_file"; then status=0; else status=$?; fi
  while IFS= read -r line; do [[ -n "$line" ]] && built+=("$line"); done <"$output_file"
  rm -f -- "$output_file"
  return "$status"
}
collect_build build_extension
collect_build build_macos_on_github
for p in "${wanted[@]}"; do
  case "$p" in
    linux-x64)   collect_build build_linux ;;
    win-x64)     collect_build build_windows ;;
    macos-arm64|macos-x64) ;;
    *) echo "unknown platform: $p" >&2; exit 2 ;;
  esac
done

# VERIFY-OR-FAIL remains an independent postcondition even though collect_build
# now propagates each platform's exit status directly.
# (Real: 2026-07-09, win-x64's Windows-side `git checkout <tag>` failed, three of
# four tarballs were produced, and the script exited 0. A release cut that way
# ships with no Windows bridge binary; npx users on Windows 404 on the pin.)
# Never trust "the loop ran" as "the artifacts exist" — assert the artifacts.
verify_artifacts() {
  local expected name
  local missing=()
  mapfile -t expected < <(node "$repo_root/scripts/release-manifest.mjs" required-assets --version "$version")
  for name in "${expected[@]}"; do
    [[ -s "$dist/$name" ]] || missing+=("$name")
  done
  if (( ${#missing[@]} )); then
    echo "" >&2
    echo "RELEASE ABORTED — ${#missing[@]} required release asset(s) are missing:" >&2
    printf '  - %s\n' "${missing[@]}" >&2
    echo "" >&2
    echo "A platform build failed (a process substitution hides its exit status, so" >&2
    echo "the failure is not otherwise visible). Scroll up for that platform's output." >&2
    echo "" >&2
    echo "Inspect the named platform's build output above. Native hosts build the" >&2
    echo "exact local HEAD transferred without repository credentials." >&2
    echo "" >&2
    echo "Do NOT publish a partial release." >&2
    exit 1
  fi
}
verify_artifacts

manifest_assets=("${built[@]}")
mapfile -t signed_metadata < <(node "$repo_root/scripts/release-manifest.mjs" build \
  --version "$version" --counter "$counter" --channel "$channel" --key-id "$key_id" \
  --signing-key "$signing_key" --out-dir "$dist" --commit "$(git -C "$repo_root" rev-parse HEAD)" \
  "${manifest_assets[@]}")
node "$repo_root/scripts/release-manifest.mjs" verify --manifest "${signed_metadata[0]}" \
  --signature "${signed_metadata[1]}" --trust "$trust_file" \
  --asset-dir "$dist" --channel "$channel" --version "$version" >/dev/null
built+=("${signed_metadata[@]}")

log "built artifacts"
printf '%s\n' "${built[@]}"

if [[ "$no_upload" == 0 ]]; then
  release_commit="$(git -C "$repo_root" rev-parse HEAD)"
  remote_tag_commit="$(gh api "repos/${repo}/commits/${tag}" --jq .sha)"
  [[ "$remote_tag_commit" == "$release_commit" ]] || {
    echo "release tag $tag resolves to $remote_tag_commit, expected exact HEAD $release_commit" >&2
    exit 1
  }

  # Assets are invisible to users while staged. A release becomes a prerelease
  # only after an independent download proves the exact matrix and bytes.
  if gh release view "$tag" --repo "$repo" >/dev/null 2>&1; then
    [[ "$(gh release view "$tag" --repo "$repo" --json isDraft --jq .isDraft)" == "true" ]] || {
      echo "release $tag already exists and is not a draft; refusing to mutate it" >&2
      exit 1
    }
  else
    log "creating draft release $tag on $repo"
    gh release create "$tag" --repo "$repo" --draft --prerelease --target "$release_commit" \
      --title "$tag" --notes "Release $version. Bridge binaries for linux-x64, macos-x64, macos-arm64, win-x64."
  fi
  log "staging artifacts on draft release $tag"
  gh release upload "$tag" "${built[@]}" "$dist/SHA256SUMS.txt" --repo "$repo" --clobber

  expected_names=()
  for artifact in "${built[@]}" "$dist/SHA256SUMS.txt"; do expected_names+=("$(basename "$artifact")"); done
  mapfile -t expected_names < <(printf '%s\n' "${expected_names[@]}" | LC_ALL=C sort)
  mapfile -t remote_names < <(gh release view "$tag" --repo "$repo" --json assets --jq '.assets[].name' | LC_ALL=C sort)
  [[ "$(printf '%s\n' "${expected_names[@]}")" == "$(printf '%s\n' "${remote_names[@]}")" ]] || {
    echo "draft release asset set does not exactly match the signed local release" >&2
    diff -u <(printf '%s\n' "${expected_names[@]}") <(printf '%s\n' "${remote_names[@]}") >&2 || true
    exit 1
  }
  release_download_dir="$(mktemp -d)"
  gh release download "$tag" --repo "$repo" --dir "$release_download_dir"
  for artifact in "${built[@]}" "$dist/SHA256SUMS.txt"; do
    cmp --silent "$artifact" "$release_download_dir/$(basename "$artifact")" || {
      echo "remote release asset bytes differ: $(basename "$artifact")" >&2
      exit 1
    }
  done
  [[ "$(gh api "repos/${repo}/commits/${tag}" --jq .sha)" == "$release_commit" ]] || {
    echo "release tag moved during staging" >&2; exit 1;
  }
  gh release edit "$tag" --repo "$repo" --draft=false --prerelease
  [[ "$(gh release view "$tag" --repo "$repo" --json isDraft,isPrerelease --jq '[.isDraft,.isPrerelease] | @tsv')" == $'false\ttrue' ]] || {
    echo "release visibility postcondition failed" >&2; exit 1;
  }
  log "verified and published — ${tag} on ${repo} at ${release_commit}"
else
  log "skipped upload (--no-upload)"
fi
