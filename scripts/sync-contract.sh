#!/bin/bash
# Copy the pure device-contract modules from an omarchy-wearable checkout.
# Usage: scripts/sync-contract.sh /path/to/omarchy-wearable
set -euo pipefail
src=${1:?usage: sync-contract.sh <omarchy-wearable checkout>}/server-contract/src/device
dst=$(cd "$(dirname "$0")/.." && pwd)/daemon/contract
for f in commands alert-mapping capture-gate; do
  { printf '// Verbatim copy of omarchy-wearable server-contract/src/device/%s.ts.\n// Do not edit here: run scripts/sync-contract.sh <path-to-omarchy-wearable>.\n\n' "$f"; cat "$src/$f.ts"; } >"$dst/$f.ts"
  echo "synced $f.ts"
done
