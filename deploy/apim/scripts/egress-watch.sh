#!/usr/bin/env bash
# Evidence that green never talks to blue while it is being verified.
# Green is configured with the same public hostname as blue, so a server-side call to that name
# would silently land on blue. Once a second this samples the TCP connections inside green's
# network namespace (read-only: nsenter + ss) and records any whose peer is blue: its pod IP, the
# ClusterIP of Service wso2am, or the node address on the live NodePorts.
# Output: /root/apim-bluegreen/green-egress.log   ("SAMPLES n" heartbeat + one line per hit)
set -uo pipefail
ROOT=${APIM_BG_ROOT:-/root/apim-bluegreen}
OUT=$ROOT/green-egress.log
NODE_IP=$(kubectl get node -o jsonpath='{.items[0].status.addresses[?(@.type=="InternalIP")].address}')
SVC_IP=$(kubectl -n apim get svc wso2am -o jsonpath='{.spec.clusterIP}')
n=0
while true; do
  GREEN_IP=$(kubectl -n apim get pod -l app=wso2am-green -o jsonpath='{.items[0].status.podIP}' 2>/dev/null)
  BLUE_IP=$(kubectl -n apim get pod -l app=wso2am -o jsonpath='{.items[0].status.podIP}' 2>/dev/null)
  PID=""
  if [ -n "$GREEN_IP" ]; then
    for p in $(pgrep -f 'org.wso2.carbon.bootstrap.Bootstrap'); do
      if nsenter -t "$p" -n ip -4 -o addr show 2>/dev/null | grep -q " $GREEN_IP/"; then PID=$p; break; fi
    done
  fi
  if [ -n "$PID" ]; then
    for i in $(seq 1 30); do
      hits=$(nsenter -t "$PID" -n ss -Htn 2>/dev/null | awk '{print $1, $4, $5}' \
             | grep -E " (${BLUE_IP//./\\.}:[0-9]+|${SVC_IP//./\\.}:[0-9]+|(${NODE_IP//./\\.}|13\.140\.56\.229):(30443|30243|30280))$" || true)
      n=$((n + 1))
      [ -n "$hits" ] && echo "$(date -u +%FT%TZ) HIT green($GREEN_IP) -> blue: $hits" >> "$OUT"
      sleep 1
    done
    echo "$(date -u +%FT%TZ) SAMPLES $n green=$GREEN_IP blue=$BLUE_IP" >> "$OUT"
  else
    sleep 2
  fi
done
