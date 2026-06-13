#!/usr/bin/env bash
set -euo pipefail

# Packages the actions-json-mcp bridge binary for one platform into a
# tarball named actions-json-mcp-<version>-<slug>.tar.gz and appends its
# checksum to SHA256SUMS.txt.
#
# Args:
#   --version <v>   release version (default: from GITHUB_REF_NAME)
#   --out-dir <d>   output directory (default: dist)
#   --slug <s>      platform slug for the artifact name, e.g. linux-x64,
#                   macos-x64, macos-arm64, win-x64 (default: linux-x64)
#   --target <t>    Rust target triple to build (default: host target).
#                   Native per-OS runners don't need this; it's here for
#                   optional cross-compilation.

version=""
out_dir="dist"
slug="linux-x64"
target=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version) version="${2:?missing value for --version}"; shift 2 ;;
    --out-dir) out_dir="${2:?missing value for --out-dir}"; shift 2 ;;
    --slug)    slug="${2:?missing value for --slug}"; shift 2 ;;
    --target)  target="${2:?missing value for --target}"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "$version" ]]; then
  version="${GITHUB_REF_NAME:-dev}"
  version="${version#extension-v}"
  version="${version#v}"
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
bridge_dir="$repo_root/mcp/actions-json-mcp"

# Windows binaries carry a .exe suffix.
bin_name="actions-json-mcp"
if [[ "$slug" == win-* ]]; then
  bin_name="actions-json-mcp.exe"
fi

# Build. With a target triple the binary lands under target/<triple>/release.
build_args=(build --release --locked --manifest-path "$bridge_dir/Cargo.toml")
if [[ -n "$target" ]]; then
  rustup target add "$target" >/dev/null 2>&1 || true
  build_args+=(--target "$target")
  target_dir="$bridge_dir/target/$target/release"
else
  target_dir="$bridge_dir/target/release"
fi

cargo "${build_args[@]}"

artifact_name="actions-json-mcp-${version}-${slug}.tar.gz"

if [[ "$out_dir" != /* ]]; then
  out_dir="$repo_root/$out_dir"
fi
mkdir -p "$out_dir"
rm -f "$out_dir/$artifact_name"

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

install -m 755 "$target_dir/$bin_name" "$tmp_dir/$bin_name"
install -m 644 "$bridge_dir/README.md" "$tmp_dir/README.md"
printf '%s\n' "$version" > "$tmp_dir/VERSION"

(
  cd "$tmp_dir"
  tar -czf "$out_dir/$artifact_name" "$bin_name" README.md VERSION
)

(
  cd "$out_dir"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$artifact_name" >> SHA256SUMS.txt
  else
    # macOS runners use shasum.
    shasum -a 256 "$artifact_name" >> SHA256SUMS.txt
  fi
)

echo "$out_dir/$artifact_name"
