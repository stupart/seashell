#!/bin/bash
set -euo pipefail

# Commit only verified bytes. A failed retry leaves any previous file intact.
DESTINATION="$1"
URL="$2"
EXPECTED_SHA256="$3"
valid_model() {
    [ -f "$1" ] && [ "$(shasum -a 256 "$1" | awk '{print $1}')" = "$EXPECTED_SHA256" ]
}
if valid_model "$DESTINATION"; then
    exit 0
fi
mkdir -p "$(dirname "$DESTINATION")"
PARTIAL="$(mktemp "${DESTINATION}.partial.XXXXXX")"
trap 'rm -f "$PARTIAL"' EXIT
curl --fail --location --retry 3 --connect-timeout 30 --max-time 3600 \
    --output "$PARTIAL" "$URL"
if ! valid_model "$PARTIAL"; then
    echo "Model checksum failed: $DESTINATION. Rerun the installer to retry." >&2
    exit 1
fi
chmod 600 "$PARTIAL"
mv -f "$PARTIAL" "$DESTINATION"
