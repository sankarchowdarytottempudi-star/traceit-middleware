#!/usr/bin/env bash
# Go live on green - or refuse and leave blue serving. Safe to re-run.
#
#   1. refuses unless both gate runs (first boot, after a pod restart) passed;
#   2. takes a fresh validated snapshot of blue and compares it, table by table, with the seed
#      green was started from, and compares blue's and green's REST truth. Any difference means
#      green is stale: exit 3, nothing switched (RUNBOOK "re-seed");
#   3. patches the selector of Service wso2am to green (scripts/switch.sh green);
#   4. checks blue once more now that nothing reaches it (a write that landed on blue between
#      step 2 and step 3 would otherwise be lost), then repeats the whole gate on the real ports (reference = blue, addressed by pod IP) and checks
#      that the two Weave consoles are healthy and their sign-in redirect reaches APIM;
#   5. on ANY failure switches back to blue at once.
# Writes /root/apim-bluegreen/STATUS.
set -uo pipefail
NS=apim
ROOT=${APIM_BG_ROOT:-/root/apim-bluegreen}
HERE=$(cd "$(dirname "$0")" && pwd)
CONSOLES=${WEAVE_CONSOLES:-"weave.traceit-tottech.com weave.traceit-tottech.com/factory"}
cd "$HERE"
log() { echo "$(date -u +%FT%TZ) $*" >> "$ROOT/actions.log"; }
refuse() { echo "NOT SWITCHED: $*" >&2; printf 'blue-live: %s\n' "$*" > "$ROOT/STATUS"; exit "${RC:-1}"; }
stamp=$(date -u +%H%M%S)

[ "$(kubectl -n $NS get svc wso2am -o jsonpath='{.spec.selector.app}')" = wso2am ] || { echo "Service wso2am does not select blue: nothing to do"; exit 0; }
for g in first-boot after-restart; do
  grep -q '^RESULT: PASS' "$ROOT/gate-$g.txt" 2>/dev/null || refuse "verification gate '$g' has not passed"
done
kubectl -n $NS rollout status deploy/wso2am-green --timeout=5s >/dev/null 2>&1 || refuse "green is not ready"

echo "== 1/5 is green still an exact copy of blue?"
ok=""
for try in 1 2 3; do   # a write on blue between the REST read and the copy fails validation: try again
  stamp=$(date -u +%H%M%S)
  T=$ROOT/truth/blue-preswitch-$stamp.json
  python3 truth.py collect https://127.0.0.1:30443 "$T" >/dev/null || refuse "could not read blue's REST state"
  log "go_live.sh: truth.py collect on blue + green, snapshot.sh preswitch-$stamp (read-only)"
  SN=$(bash snapshot.sh "preswitch-$stamp") || refuse "could not snapshot blue"
  if python3 validate.py "$SN" "$T" | tail -4; then ok=1; break; fi
  sleep 5
done
[ -n "$ok" ] || refuse "fresh snapshot of blue failed validation 3 times (blue is being written right now)"
# Test APIs (name/context weave*, sample*, e2e*) are the one tolerated difference: the runtime
# re-creates them on green after the switch (resync below).
if ! python3 validate.py dbdiff "$ROOT/seed" "$SN" --ignore-test; then RC=3 refuse "blue changed since green was seeded (database rows differ) - re-seed"; fi
TG=$ROOT/truth/green-preswitch-$stamp.json
python3 truth.py collect https://127.0.0.1:31443 "$TG" >/dev/null || refuse "could not read green's REST state"
D=$(python3 truth.py diff "$T" "$TG" --ignore-test); drc=$?; echo "$D"
[ $drc = 0 ] || RC=3 refuse "blue and green differ over REST - re-seed"
IGN=""; case "$D" in *"ignored test APIs"*) IGN=--ignore-test ;; esac

echo "== 2/5 switch"
BLUE_IP=$(kubectl -n $NS get pod -l app=wso2am -o jsonpath='{.items[0].status.podIP}')
GREEN_IP=$(kubectl -n $NS get pod -l app=wso2am-green -o jsonpath='{.items[0].status.podIP}')
pkill -f egress-watch.sh 2>/dev/null   # after the switch green calling "its" public address is green calling itself
bash switch.sh green || refuse "selector patch failed"
back() { bash switch.sh blue; printf 'blue-live: %s\n' "switched to green and back: $*" > "$ROOT/STATUS"; echo "ROLLED BACK TO BLUE: $*" >&2; exit 1; }
for i in 1 2 3 4 5 6 7 8 9 10; do
  [ "$(kubectl -n $NS get endpoints wso2am -o jsonpath='{.subsets[0].addresses[0].ip}')" = "$GREEN_IP" ] && break; sleep 1
done
[ "$(kubectl -n $NS get endpoints wso2am -o jsonpath='{.subsets[0].addresses[*].ip}')" = "$GREEN_IP" ] || back "Service endpoints are not green's pod"

echo "== 3/5 blue no longer receives traffic: did anything reach it between the check and the switch?"
T2=$ROOT/truth/blue-frozen-$stamp.json
python3 truth.py collect "https://$BLUE_IP:9443" "$T2" >/dev/null || back "could not read blue after the switch"
SN2=$(bash snapshot.sh "frozen-$stamp") || back "could not snapshot blue after the switch"
python3 validate.py "$SN2" "$T2" | tail -1 || back "snapshot of blue after the switch failed validation"
python3 validate.py dbdiff "$ROOT/seed" "$SN2" --ignore-test || back "blue was written to in the seconds before the switch - re-seed"

echo "== 4/5 gate on the real ports (30443 / 30243 / 30280)"
log "go_live.sh: gate.py post-switch (reference blue by pod IP $BLUE_IP, target live NodePorts)"
python3 gate.py --label post-switch --ref-pod-ip "$BLUE_IP" --target-mgmt https://127.0.0.1:30443 \
  --target-gw https://127.0.0.1:30243 --target-gw-http http://127.0.0.1:30280 $IGN | grep -v '^\[PASS\]'
grep -q '^RESULT: PASS' "$ROOT/gate-post-switch.txt" || back "post-switch gate failed (see $ROOT/gate-post-switch.txt)"

echo "== 5/5 Weave consoles"
for h in $CONSOLES; do
  code=$(curl -s -m 20 -o /dev/null -w '%{http_code}' "https://$h/healthz")
  [ "$code" = 200 ] || back "https://$h/healthz answered $code"
  loc=$(curl -s -m 20 -o /dev/null -w '%{redirect_url}' "https://$h/api/auth/login")
  case "$loc" in https://*:30443/oauth2/authorize\?*) ;; *) back "https://$h/api/auth/login does not redirect to APIM" ;; esac
  step=$(curl -sk -m 20 -o /dev/null -w '%{http_code} %{redirect_url}' "$loc")
  case "$step" in "302 https://"*":30443/authenticationendpoint/login.do"*) ;; *) back "APIM did not accept the sign-in request of $h (${step%% *})" ;; esac
  code=$(curl -sk -m 20 -o /dev/null -w '%{http_code}' "${step#302 }")
  [ "$code" = 200 ] || back "APIM login page for $h answered $code"
  echo "[PASS] $h: healthz 200, sign-in redirect -> APIM /oauth2/authorize -> login page 200"
done

# Test APIs other streams published on blue after the snapshot are re-created by the runtime.
if curl -s -m 5 -o /dev/null http://127.0.0.1:8790/v1/healthz; then
  code=$( (set +x; . /root/.runtime.env; curl -s -m 120 -o /dev/null -w '%{http_code}' -X POST \
           -H "x-weave-key: $RUNTIME_INTERNAL_KEY" http://127.0.0.1:8790/v1/gateway/resync) )
  echo "runtime resync: HTTP $code"; log "go_live.sh: POST http://127.0.0.1:8790/v1/gateway/resync -> HTTP $code"
else
  echo "runtime (127.0.0.1:8790) is not running: resync skipped"
fi
# From now on green holds the newest state. Disarm the seed, so that a green pod that ever finds
# its volume empty refuses to start instead of silently serving this old copy of blue.
[ -f "$ROOT/seed/VALIDATED" ] && mv "$ROOT/seed/VALIDATED" "$ROOT/seed/CONSUMED"
printf 'green-live\nswitched %s; rollback: kubectl -n apim patch svc wso2am --type merge -p '"'"'{"spec":{"selector":{"app":"wso2am"}}}'"'"'\n' "$(date -u +%FT%TZ)" > "$ROOT/STATUS"
echo "GREEN IS LIVE"
