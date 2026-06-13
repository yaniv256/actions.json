#!/usr/bin/env bash
set -euo pipefail

version=""
out_dir="dist"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version)
      version="${2:?missing value for --version}"
      shift 2
      ;;
    --out-dir)
      out_dir="${2:?missing value for --out-dir}"
      shift 2
      ;;
    *)
      echo "unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

if [[ -z "$version" ]]; then
  version="${GITHUB_REF_NAME:-dev}"
  version="${version#extension-v}"
  version="${version#v}"
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
bridge_dir="$repo_root/mcp/actions-json-mcp"
target_dir="$bridge_dir/target/release"
artifact_name="actions-json-mcp-${version}-linux-x64.tar.gz"

if [[ "$out_dir" != /* ]]; then
  out_dir="$repo_root/$out_dir"
fi

mkdir -p "$out_dir"
rm -f "$out_dir/$artifact_name"

cargo build --release --locked --manifest-path "$bridge_dir/Cargo.toml"

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

install -m 755 "$target_dir/actions-json-mcp" "$tmp_dir/actions-json-mcp"
install -m 644 "$bridge_dir/README.md" "$tmp_dir/README.md"
printf '%s\n' "$version" > "$tmp_dir/VERSION"

(
  cd "$tmp_dir"
  tar -czf "$out_dir/$artifact_name" actions-json-mcp README.md VERSION
)

(
  cd "$out_dir"
  sha256sum "$artifact_name" >> SHA256SUMS.txt
)

echo "$out_dir/$artifact_name"
