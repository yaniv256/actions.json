#!/usr/bin/env bash
set -euo pipefail

repo="yaniv256/actions.json"
version=""
channel="stable"
prefix="${HOME}/.local"
base_url=""
allow_downgrade=0
bind="127.0.0.1:17345"
storage_root="${XDG_DATA_HOME:-$HOME/.local/share}/actions-json/storage"
actions_path=""
configured_state_dir=""
bind_explicit=0
storage_explicit=0
actions_explicit=0
state_explicit=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version) version="${2:?}"; shift 2 ;;
    --channel) channel="${2:?}"; shift 2 ;;
    --prefix) prefix="${2:?}"; shift 2 ;;
    --base-url) base_url="${2:?}"; shift 2 ;;
    --recover) allow_downgrade=1; shift ;;
    --bind) bind="${2:?}"; bind_explicit=1; shift 2 ;;
    --storage-root) storage_root="${2:?}"; storage_explicit=1; shift 2 ;;
    --actions) actions_path="${2:?}"; actions_explicit=1; shift 2 ;;
    --state-dir) configured_state_dir="${2:?}"; state_explicit=1; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

# Windows reaches WSL services through localhost forwarding to the WSL virtual
# NIC. A loopback-only listener is therefore invisible to the Windows browser.
# Authentication remains mandatory on every privileged bridge route.
if [[ "$bind_explicit" == 0 && -r /proc/sys/kernel/osrelease ]] && grep -qi microsoft /proc/sys/kernel/osrelease; then
  bind="0.0.0.0:17345"
fi

[[ -n "$version" ]] || { echo "--version is required" >&2; exit 2; }
for command in curl openssl jq tar; do command -v "$command" >/dev/null || { echo "required command not found: $command" >&2; exit 1; }; done
case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) slug=linux-x64; platform=linux; arch=x64 ;;
  Darwin-x86_64) slug=macos-x64; platform=macos; arch=x64 ;;
  Darwin-arm64) slug=macos-arm64; platform=macos; arch=arm64 ;;
  *) echo "unsupported platform: $(uname -s)-$(uname -m)" >&2; exit 1 ;;
esac

if [[ -z "$base_url" ]]; then base_url="https://github.com/$repo/releases/download/extension-v$version"; fi
tmp="$(mktemp -d)"
config_file=""
created_config=0
created_alias=0
counter_existed=0
install_succeeded=0
cleanup_install() {
  if [[ "$install_succeeded" == 0 ]]; then
    [[ "$created_config" == 0 || -z "$config_file" ]] || rm -f -- "$config_file"
    [[ "$created_alias" == 0 ]] || rm -f -- "$prefix/bin/aj"
    if [[ -n "${counter_file:-}" ]]; then
      if [[ "$counter_existed" == 1 ]]; then
        mv -f -- "$tmp/counter.previous" "$counter_file"
      else
        rm -f -- "$counter_file"
      fi
    fi
  fi
  rm -rf -- "$tmp"
}
trap cleanup_install EXIT
curl -fL --retry 2 "$base_url/release-manifest.json" -o "$tmp/manifest.json"
curl -fL --retry 2 "$base_url/release-manifest.sig" -o "$tmp/manifest.sig"
cat > "$tmp/release.pub" <<'PEM'
-----BEGIN PUBLIC KEY-----
MIIBojANBgkqhkiG9w0BAQEFAAOCAY8AMIIBigKCAYEA4pZ6jhJbKu6zLvm8d3h4
l5OBeA49kfKflq51A53Fp6S2W1ikJCHQyePTD5gO1F+IIe9Qdc7Xq3tFZqrrhfGx
t2H8YaVXUO/nvUZKSoneUTZ6T1bBdBG88kXHbC0GjvBE7q98NHn+CjrtiWcKpVmB
i6YMIUuoot/oh3dMTgZFY6nwWHo57OYoYWQgs+QQEAjxNl2GePTFy02b3mioaBQm
AES6wiip8pZwxDUQtMf6kfm7yTivgrjkswt2dunSITCHcmXo/uWiGai+K8d+dVzR
LezpKw2S7G/1IbHie+lt9gvBkZkCgVlHqNCnL3KtCau0mBYgOkfzIk+p6YzB4HG/
/2MCvj4MHYmbTQrsk6BdRXjAc3sDUM0uV+pbm2aRC9P/TRvujZk9X7mR+f8Ws6Od
o6jzZhxuj6zaeuCky6aGtCnPxWe7EgOTk8Sgg2W5Ib9XU7y2n4upm2mpV2W9WSHF
syMjfvks+HhI5G65SqliY3vMx5kP87kGop2HTFtzkY/vAgMBAAE=
-----END PUBLIC KEY-----
PEM
openssl dgst -sha256 -verify "$tmp/release.pub" -signature "$tmp/manifest.sig" "$tmp/manifest.json" >/dev/null
[[ "$(jq -r .schema_version "$tmp/manifest.json")" == 1 ]] || { echo "unsupported release manifest" >&2; exit 1; }
[[ "$(jq -r .channel "$tmp/manifest.json")" == "$channel" ]] || { echo "release channel mismatch" >&2; exit 1; }
[[ "$(jq -r .key_id "$tmp/manifest.json")" == actions-json-stable-2026-01 ]] || { echo "untrusted or revoked release key" >&2; exit 1; }
[[ "$(jq -r .version "$tmp/manifest.json")" == "$version" ]] || { echo "release version mismatch" >&2; exit 1; }
counter="$(jq -r .release_counter "$tmp/manifest.json")"
[[ "$counter" =~ ^[1-9][0-9]*$ ]] || { echo "invalid release counter" >&2; exit 1; }
config_dir="$HOME/.actions-json"; config_file="$config_dir/config.json"
legacy_config="${XDG_CONFIG_HOME:-$HOME/.config}/actions-json/config.json"
legacy_local="$HOME/.actions-json.local.json"
mkdir -p "$config_dir"; chmod 700 "$config_dir"
if [[ ! -e "$config_file" ]]; then
  if [[ -f "$legacy_config" ]]; then
    cp -- "$legacy_config" "$config_file"
  elif [[ -f "$legacy_local" ]]; then
    cp -- "$legacy_local" "$config_file"
  fi
  [[ ! -e "$config_file" ]] || chmod 600 "$config_file"
fi
if [[ -e "$config_file" ]]; then
  [[ "$(jq -r '.schema_version // 1' "$config_file")" == 1 ]] || { echo "existing install config is invalid: $config_file" >&2; exit 1; }
  existing_state="$(jq -r '.state_dir // empty' "$config_file")"
  existing_bind="$(jq -r '.bind // empty' "$config_file")"
  existing_storage="$(jq -r '.storage_root // empty' "$config_file")"
  existing_actions="$(jq -r '.actions // empty' "$config_file")"
  [[ "$state_explicit" == 0 || "$configured_state_dir" == "$existing_state" ]] || { echo "--state-dir conflicts with existing config: $config_file" >&2; exit 2; }
  [[ "$bind_explicit" == 0 || "$bind" == "$existing_bind" ]] || { echo "--bind conflicts with existing config: $config_file" >&2; exit 2; }
  [[ "$storage_explicit" == 0 || "$storage_root" == "$existing_storage" ]] || { echo "--storage-root conflicts with existing config: $config_file" >&2; exit 2; }
  [[ "$actions_explicit" == 0 || "$actions_path" == "$existing_actions" ]] || { echo "--actions conflicts with existing config: $config_file" >&2; exit 2; }
  [[ -z "$existing_state" ]] || configured_state_dir="$existing_state"
  [[ -z "$existing_bind" ]] || bind="$existing_bind"
  [[ -z "$existing_storage" ]] || storage_root="$existing_storage"
  [[ -z "$existing_actions" ]] || actions_path="$existing_actions"
fi
state_dir="${configured_state_dir:-${XDG_STATE_HOME:-$HOME/.local/state}/actions-json}"
state_dir="$(realpath -m -- "$state_dir")"
storage_root="$(realpath -m -- "$storage_root")"
[[ -z "$actions_path" ]] || actions_path="$(realpath -m -- "$actions_path")"
for protected_path in "$state_dir" "$storage_root"; do
  [[ "$protected_path" != / && "$protected_path" != "$HOME" && ! -L "$protected_path" ]] || { echo "unsafe installation path: $protected_path" >&2; exit 2; }
done
counter_file="$state_dir/release-counter-$channel"
installed_counter=0; [[ -f "$counter_file" ]] && installed_counter="$(cat "$counter_file")"
if (( counter < installed_counter && allow_downgrade == 0 )); then echo "downgrade refused: release counter $counter < installed $installed_counter" >&2; exit 1; fi

pin_dir="$PWD"
while [[ "$pin_dir" != / ]]; do
  if [[ -f "$pin_dir/.actions-json-version" ]]; then
    pin="$(tr -d '[:space:]' < "$pin_dir/.actions-json-version")"
    [[ "$pin" == "$version" ]] || { echo "project pins actions-json $pin, not $version" >&2; exit 1; }
    break
  fi
  pin_dir="$(dirname "$pin_dir")"
done

asset="$(jq -r --arg p "$platform" --arg a "$arch" '.assets[] | select(.kind=="cli" and .platform==$p and .arch==$a) | .filename' "$tmp/manifest.json")"
[[ -n "$asset" && "$asset" != *$'\n'* ]] || { echo "signed manifest has no unique CLI asset for $slug" >&2; exit 1; }
expected_sha="$(jq -r --arg f "$asset" '.assets[] | select(.filename==$f) | .sha256' "$tmp/manifest.json")"
expected_bytes="$(jq -r --arg f "$asset" '.assets[] | select(.filename==$f) | .bytes' "$tmp/manifest.json")"
curl -fL --retry 2 "$base_url/$asset" -o "$tmp/asset.tar.gz"
[[ "$(wc -c < "$tmp/asset.tar.gz")" == "$expected_bytes" ]] || { echo "asset size mismatch" >&2; exit 1; }
actual_sha="$(openssl dgst -sha256 "$tmp/asset.tar.gz" | awk '{print $NF}')"
[[ "$actual_sha" == "$expected_sha" ]] || { echo "asset digest mismatch" >&2; exit 1; }
tar -xzf "$tmp/asset.tar.gz" -C "$tmp" actions-json
candidate_binary_version="$("$tmp/actions-json" version | jq -r '.result.version')"
[[ "$candidate_binary_version" == "$version" ]] || { echo "candidate binary version mismatch: expected $version, got $candidate_binary_version" >&2; exit 1; }
mkdir -p "$prefix/bin" "$state_dir"; chmod 700 "$state_dir"
mkdir -p "$config_dir" "$storage_root"; chmod 700 "$config_dir"
jq -n --arg state_dir "$state_dir" --arg bind "$bind" --arg storage_root "$storage_root" --arg actions "$actions_path" \
  '{schema_version:1,state_dir:$state_dir,bind:$bind,storage_root:$storage_root} + (if $actions == "" then {} else {actions:$actions} end)' > "$tmp/config-defaults.json"
if [[ -e "$config_file" ]]; then
  jq -s '.[0] * .[1]' "$tmp/config-defaults.json" "$config_file" > "$config_file.new"
else
  cp -- "$tmp/config-defaults.json" "$config_file.new"
  created_config=1
fi
chmod 600 "$config_file.new"; mv "$config_file.new" "$config_file"
if [[ ! -e "$prefix/bin/aj" && ! -L "$prefix/bin/aj" ]]; then
  ln -s actions-json "$prefix/bin/aj"
  created_alias=1
fi
if [[ -e "$counter_file" ]]; then
  cp -p -- "$counter_file" "$tmp/counter.previous"
  counter_existed=1
fi
printf '%s\n' "$counter" > "$counter_file"; chmod 600 "$counter_file"
if [[ -x "$prefix/bin/actions-json" ]]; then
  update_dir="$state_dir/updates"; mkdir -p "$update_dir"; chmod 700 "$update_dir"
  install -m 755 "$tmp/actions-json" "$update_dir/actions-json"
  printf '%s\n' "$candidate_binary_version" > "$update_dir/candidate.version"
  ACTIONS_JSON_STATE_DIR="$state_dir" "$prefix/bin/actions-json" update apply >/dev/null
else
  install -m 755 "$tmp/actions-json" "$prefix/bin/actions-json.new"
  mv -f "$prefix/bin/actions-json.new" "$prefix/bin/actions-json"
fi
install_succeeded=1
echo "installed actions-json $version ($slug); aj alias $([[ -L "$prefix/bin/aj" ]] && echo available || echo preserved-existing)"
