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
node "$repo_root/extensions/chrome-overlay-runtime/esbuild.protoface.mjs"
node "$repo_root/extensions/chrome-overlay-runtime/esbuild.protoface-broker.mjs"

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
    agent-surface.html \
    src/options.html \
    src/options.js \
    src/agent/agent-event-map.mjs \
    src/agent/amplitude-envelope.mjs \
    src/agent/amplitude-runtime-message.mjs \
    src/agent/background-screenshot-capture.mjs \
    src/agent/cloud-store.mjs \
    src/agent/bridge-pairing-settings.mjs \
    src/agent/bridge-connection-log.mjs \
    src/agent/bridge-runtime-verification.mjs \
    src/agent/corpus-build.mjs \
    src/agent/corpus-embedding.mjs \
    src/agent/corpus-index.mjs \
    src/agent/corpus-search.mjs \
    src/agent/credential-store.mjs \
    src/agent/debug-log-presentation.mjs \
    src/agent/debugger-session-manager.mjs \
    src/agent/extension-operation-receipts.mjs \
    src/agent/fake-realtime-transport.mjs \
    src/agent/file-transfer.mjs \
    src/agent/bridge-output-delivery.mjs \
    src/agent/hosted-tool-executor.mjs \
    src/agent/local-actions-catalog.mjs \
    src/agent/overlay-settings-store.mjs \
    src/agent/pill-presentation.mjs \
    src/agent/popup-presentation.mjs \
    src/agent/protoface-avatar-controller.mjs \
    src/agent/protoface-credential-store.mjs \
    src/agent/projection-cache-store.mjs \
    src/agent/projection-cache-policy.mjs \
    src/agent/indexeddb-adapter.mjs \
    src/agent/projection-embedding-cache.mjs \
    src/agent/projection-graph.mjs \
    src/agent/projection-graph-query.mjs \
    src/agent/projection-semantic-policy.mjs \
    src/agent/projection-semantic-search.mjs \
    src/agent/projection-snapshot-store.mjs \
    src/agent/projection-target-resolution.mjs \
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
    src/agent/tab-ownership-authority.mjs \
    src/agent/transfer-buffer.mjs \
    src/agent/usage-reconciler.mjs \
    src/agent/vendor/jsonata.mjs \
    src/agent/vendor/siriwave.mjs \
    src/agent/voice-settings-store.mjs \
    src/agent/protoface-settings-store.mjs \
    src/agent/workflow-actions.mjs \
    src/agent/voice-icons.mjs \
    src/delegated-agent/approval-store.mjs \
    src/delegated-agent/bundle-schema.mjs \
    src/delegated-agent/delegated-policy.mjs \
    src/delegated-agent/durable-state-commit-log.mjs \
    src/delegated-agent/group-store.mjs \
    src/delegated-agent/home-lease.mjs \
    src/delegated-agent/page-broker.js \
    src/background.js \
    src/content.js \
    src/offscreen-agent.js \
    src/popup.js \
    src/agent-surface.js \
    src/storage-bundle.mjs \
    src/a11y/automation_shim.js \
    src/a11y/announcer.js \
    src/a11y/gated-repeat.mjs \
    src/a11y/live_region_observer.js \
    dist/a11y-bundle.js \
    dist/protoface-client-bundle.mjs \
    dist/protoface-broker-bundle.mjs
)

# Release assets are capped at 700 KiB by GitOversight. Keep the checked-in
# sources readable, then strip comments/formatting from the largest shipped
# JavaScript files in a temporary copy. This is a packaging transform only:
# names, imports, and executable behavior remain unchanged.
repack_dir="$(mktemp -d)"
trap 'rm -rf "$repack_dir"' EXIT
unzip -q "$out_dir/$artifact_name" -d "$repack_dir"
for module_file in \
  src/background.js \
  src/agent-surface.js \
  src/options.js \
  src/popup.js
do
  "$repo_root/node_modules/.bin/terser" \
    "$repack_dir/$module_file" \
    --module \
    --comments false \
    --output "$repack_dir/$module_file.min"
  mv "$repack_dir/$module_file.min" "$repack_dir/$module_file"
done
while IFS= read -r module_file; do
  "$repo_root/node_modules/.bin/terser" \
    "$module_file" \
    --module \
    --comments false \
    --output "$module_file.min"
  mv "$module_file.min" "$module_file"
done < <(find "$repack_dir/src/agent" -type f -name '*.mjs' -print | sort)
"$repo_root/node_modules/.bin/terser" \
  "$repack_dir/src/content.js" \
  --comments false \
  --output "$repack_dir/src/content.js.min"
mv "$repack_dir/src/content.js.min" "$repack_dir/src/content.js"
rm -f "$out_dir/$artifact_name"
(
  cd "$repack_dir"
  zip -9 -q -r "$out_dir/$artifact_name" .
)

artifact_bytes="$(stat -c %s "$out_dir/$artifact_name")"
if (( artifact_bytes > 700 * 1024 )); then
  echo "packaged extension is ${artifact_bytes} bytes; GitOversight release assets must be <= 716800 bytes" >&2
  exit 1
fi

(
  cd "$out_dir"
  sha256sum "$artifact_name" > SHA256SUMS.txt
)

echo "$out_dir/$artifact_name"
echo "$out_dir/SHA256SUMS.txt"
