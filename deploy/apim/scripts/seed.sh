#!/usr/bin/env bash
# Publish a VALIDATED snapshot as the seed that green's init container copies onto an EMPTY volume.
# Usage: seed.sh /root/apim-bluegreen/snap/<name>
# The init container never overwrites a volume that already holds databases, so this only matters
# for a first boot (or after the PVC was deliberately deleted - see RUNBOOK "re-seed").
set -euo pipefail
umask 077
ROOT=${APIM_BG_ROOT:-/root/apim-bluegreen}
SNAP=${1:?usage: seed.sh <snapshot dir>}
[ -f "$SNAP/VALIDATED" ] || { echo "refusing: $SNAP has not been validated (validate.py)" >&2; exit 1; }
(cd "$SNAP/raw" && sha256sum -c SHA256SUMS >/dev/null)
rm -rf "$ROOT/seed.new"; mkdir -p "$ROOT/seed.new"
cp "$SNAP"/raw/*.mv.db "$SNAP/raw/SHA256SUMS" "$SNAP/raw/TAKEN_AT" "$SNAP/dbtruth.json" "$SNAP/VALIDATED" "$ROOT/seed.new/"
echo "$SNAP" > "$ROOT/seed.new/SOURCE"
rm -rf "$ROOT/seed.old"; [ -d "$ROOT/seed" ] && mv "$ROOT/seed" "$ROOT/seed.old"
mv "$ROOT/seed.new" "$ROOT/seed"; rm -rf "$ROOT/seed.old"
echo "$(date -u +%FT%TZ) seed.sh: $ROOT/seed <- $SNAP (taken $(cat "$ROOT/seed/TAKEN_AT"))" >> "$ROOT/actions.log"
echo "seed ready: snapshot taken $(cat "$ROOT/seed/TAKEN_AT")"
