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
extension_dir="$repo_root/extensions/chrome-overlay-runtime"
artifact_name="actions-json-overlay-runtime-${version}.zip"

if [[ "$out_dir" != /* ]]; then
  out_dir="$repo_root/$out_dir"
fi

# The a11y layer ships a built bundle (ChromeVox policy core; U2) — build it
# so the zip always carries a bundle matching the sources being packaged.
node "$repo_root/extensions/chrome-overlay-runtime/esbuild.a11y.mjs"

mkdir -p "$out_dir"
rm -f "$out_dir/$artifact_name" "$out_dir/SHA256SUMS.txt"

(
  cd "$extension_dir"
  zip -q -r "$out_dir/$artifact_name" \
    README.md \
    actions/overlay.actions.json \
    manifest.json \
    offscreen.html \
    popup.html \
    sidepanel.html \
    src/options.html \
    src/options.js \
    src/agent/agent-event-map.mjs \
    src/agent/cloud-store.mjs \
    src/agent/credential-store.mjs \
    src/agent/fake-realtime-transport.mjs \
    src/agent/bridge-output-delivery.mjs \
    src/agent/hosted-tool-executor.mjs \
    src/agent/local-actions-catalog.mjs \
    src/agent/realtime-cost.mjs \
    src/agent/realtime-model.mjs \
    src/agent/realtime-session-manager.mjs \
    src/agent/realtime-tool-catalog.mjs \
    src/agent/runtime-session-client.mjs \
    src/agent/realtime-webrtc-transport.mjs \
    src/agent/session-memory-store.mjs \
    src/agent/sigv4.mjs \
    src/agent/site-action-args.mjs \
    src/agent/state-projections.mjs \
    src/agent/task-queue.mjs \
    src/agent/transfer-buffer.mjs \
    src/agent/usage-reconciler.mjs \
    src/agent/vendor/jsonata.mjs \
    src/agent/voice-settings-store.mjs \
    src/agent/workflow-actions.mjs \
    src/background.js \
    src/content.js \
    src/offscreen-agent.js \
    src/popup.js \
    src/sidepanel.js \
    src/storage-bundle.mjs \
    src/a11y/automation_shim.js \
    src/a11y/announcer.js \
    src/a11y/gated-repeat.mjs \
    src/a11y/live_region_observer.js \
    dist/a11y-bundle.js
)

(
  cd "$out_dir"
  sha256sum "$artifact_name" > SHA256SUMS.txt
)

echo "$out_dir/$artifact_name"
echo "$out_dir/SHA256SUMS.txt"
