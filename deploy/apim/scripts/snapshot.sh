#!/usr/bin/env bash
# Copy blue's embedded H2 database files out of the running pod WITHOUT touching its JVM.
#
# Read-only on blue: only `sha256sum` and `cat` run inside the pod. A copy of a live H2 MVStore
# file can be torn if H2 writes while we read, so every file is checksummed inside the pod before
# and after the copy and the local copy must match both. If anything moved we wait and retry.
# A stable copy is still not trusted until validate.py has opened it with the image's own H2 jar.
#
# Usage: snapshot.sh [name]      -> /root/apim-bluegreen/snap/<name>/raw/*.mv.db  (prints the dir)
set -euo pipefail
umask 077
NS=apim
ROOT=${APIM_BG_ROOT:-/root/apim-bluegreen}
NAME=${1:-$(date -u +%Y%m%dT%H%M%SZ)}
DBDIR=/home/wso2carbon/wso2am-4.5.0/repository/database
# Blue is the pod of Deployment `wso2am` (pod label app=wso2am). Green carries app=wso2am-green:
# APIM_SNAPSHOT_SELECTOR=app=wso2am-green snapshot.sh <name>   takes the same kind of copy of green.
SELECTOR=${APIM_SNAPSHOT_SELECTOR:-app=wso2am}
POD=$(kubectl -n $NS get pod -l "$SELECTOR" -o jsonpath='{.items[0].metadata.name}')
OUT=$ROOT/snap/$NAME/raw
mkdir -p "$OUT"
echo "$(date -u +%FT%TZ) snapshot.sh $NAME: read-only copy of $DBDIR/*.mv.db from pod $POD" >> "$ROOT/actions.log"

sums() { kubectl -n $NS exec "$POD" -c wso2am -- bash -c "cd $DBDIR && sha256sum *.mv.db"; }

for attempt in $(seq 1 20); do
  before=$(sums)
  for f in $(echo "$before" | awk '{print $2}'); do
    kubectl -n $NS exec "$POD" -c wso2am -- cat "$DBDIR/$f" > "$OUT/$f"
  done
  sleep 2
  after=$(sums)
  local_sums=$(cd "$OUT" && sha256sum *.mv.db)
  if [ "$before" = "$after" ] && [ "$before" = "$local_sums" ]; then
    echo "$local_sums" > "$OUT/SHA256SUMS"
    date -u +%FT%TZ > "$OUT/TAKEN_AT"
    echo "stable after $attempt attempt(s)" >&2
    echo "$ROOT/snap/$NAME"
    exit 0
  fi
  echo "attempt $attempt: blue wrote during the copy, retrying" >&2
  sleep 5
done
echo "could not get a stable copy in 20 attempts" >&2
exit 1
