#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

(cd crates/crew/ui && npm install && npm run build)
export SKIP_UI_BUILD=1

cd crates/crew
config_flag=()
if [[ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" && -z "${TAURI_SIGNING_PRIVATE_KEY_PATH:-}" ]]; then
  # Local unsigned .app / .dmg. CI sets the signing key and keeps updater
  # tarballs enabled from tauri.conf.json.
  config_flag=(--config '{"bundle":{"createUpdaterArtifacts":false}}')
fi

npm exec --prefix ui -- tauri build --bundles app dmg "${config_flag[@]}" "$@"

echo
echo "Bundles:"
find "$root/target" -path '*/bundle/dmg/*.dmg' -o -path '*/bundle/macos/*.app' \
  | sed 's|^|  |'
