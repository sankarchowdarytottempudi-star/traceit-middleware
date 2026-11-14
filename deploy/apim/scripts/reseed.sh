#!/usr/bin/env bash
# Rebuild GREEN from a fresh snapshot of BLUE and run the whole verification gate again.
# Use it when go_live.sh refuses with "re-seed" (blue changed after green was seeded).
#
# Only green is touched: Deployment wso2am-green and PVC wso2am-green-data are deleted and
# re-created, blue is only read. Refuses to run while the live Service points at green, because
# then green holds the only copy of the newest state.
set -uo pipefail
NS=apim
ROOT=${APIM_BG_ROOT:-/root/apim-bluegreen}
HERE=$(cd "$(dirname "$0")" && pwd)
cd "$HERE"
log() { echo "$(date -u +%FT%TZ) reseed.sh: $*" >> "$ROOT/actions.log"; }
die() { echo "RESEED FAILED: $*" >&2; exit 1; }
[ "$(kubectl -n $NS get svc wso2am -o jsonpath='{.spec.selector.app}')" = wso2am ] || die "Service wso2am selects green: green is live, refusing to wipe it"

echo "== 1/5 fresh validated snapshot of blue"
ok=""
for try in 1 2 3 4 5; do
  stamp=$(date -u +%H%M%S)
  T=$ROOT/truth/blue-$stamp.json
  python3 truth.py collect https://127.0.0.1:30443 "$T" >/dev/null || die "could not read blue's REST state"
  SN=$(bash snapshot.sh "seed-$stamp") || die "could not snapshot blue"
  if python3 validate.py "$SN" "$T" | tail -1; then ok=1; break; fi
  echo "blue changed between the REST read and the copy; trying again"; sleep 10
done
[ -n "$ok" ] || die "no snapshot that matches blue's REST state in 5 attempts (blue is being written continuously)"
bash seed.sh "$SN" || die "seed.sh"
echo "$T" > "$ROOT/truth/SEED_TRUTH"

echo "== 2/5 discard the old green volume, start green on the new seed"
log "kubectl -n $NS delete deploy wso2am-green + pvc wso2am-green-data (GREEN only), then re-apply pvc + deployment"
kubectl -n $NS delete deploy wso2am-green --wait=true --timeout=180s
kubectl -n $NS wait --for=delete pod -l app=wso2am-green --timeout=180s
kubectl -n $NS delete pvc wso2am-green-data --wait=true --timeout=120s
rm -f "$ROOT"/gate-first-boot.txt "$ROOT"/gate-after-restart.txt
kubectl -n $NS apply -f ../green/pvc.yaml -f ../green/service-verify.yaml -f ../green/deployment.yaml
kubectl -n $NS rollout status deploy/wso2am-green --timeout=600s || die "green did not become ready"
kubectl -n $NS logs deploy/wso2am-green -c seed | tail -3

gate() {  # the gate fails if another stream changes blue while it runs: one more try, ignoring test APIs
  log "gate.py $1 (reads on blue and green)"
  python3 gate.py --label "$1" | grep -v '^\[PASS\]'
  grep -q '^RESULT: PASS' "$ROOT/gate-$1.txt" && return 0
  python3 gate.py --label "$1" --ignore-test | grep -v '^\[PASS\]'
  grep -q '^RESULT: PASS' "$ROOT/gate-$1.txt"
}
echo "== 3/5 gate, first boot"
gate first-boot || die "gate first-boot failed: $ROOT/gate-first-boot.txt"

echo "== 4/5 restart green once"
python3 persist_probe.py before https://127.0.0.1:31443 | tail -1
log "kubectl -n $NS delete pod -l app=wso2am-green (GREEN pod, restart test)"
kubectl -n $NS delete pod -l app=wso2am-green --wait=true --timeout=180s
sleep 5
kubectl -n $NS rollout status deploy/wso2am-green --timeout=600s || die "green did not come back"
python3 persist_probe.py after https://127.0.0.1:31443 | tail -1 | grep '^\[PASS\]' || die "state written before the restart is gone"

echo "== 5/5 gate, after restart"
gate after-restart || die "gate after-restart failed: $ROOT/gate-after-restart.txt"
echo "GREEN REBUILT AND VERIFIED - now run scripts/go_live.sh"
