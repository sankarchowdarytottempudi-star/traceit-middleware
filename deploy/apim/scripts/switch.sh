#!/usr/bin/env bash
# Point the live Service `wso2am` (NodePorts 30443 / 30243 / 30280) at green or back at blue.
#   switch.sh green     go live on green
#   switch.sh blue      ROLLBACK: one command, takes effect within a second
#   switch.sh status
# Only the Service selector changes. Neither Deployment is touched, both keep running.
set -euo pipefail
NS=apim
ROOT=${APIM_BG_ROOT:-/root/apim-bluegreen}
case "${1:-status}" in
  green) SEL=wso2am-green ;;
  blue)  SEL=wso2am ;;
  status)
    echo "Service wso2am selects app=$(kubectl -n $NS get svc wso2am -o jsonpath='{.spec.selector.app}')"
    kubectl -n $NS get endpoints wso2am -o wide; kubectl -n $NS get pods -o wide; exit 0 ;;
  *) echo "usage: switch.sh green|blue|status" >&2; exit 2 ;;
esac
READY=$(kubectl -n $NS get pods -l app=$SEL -o jsonpath='{range .items[*]}{.status.containerStatuses[0].ready}{"\n"}{end}' | grep -c true || true)
[ "$READY" -ge 1 ] || { echo "refusing: no READY pod with label app=$SEL" >&2; exit 1; }
OLD=$(kubectl -n $NS get svc wso2am -o jsonpath='{.spec.selector}')
mkdir -p "$ROOT"; echo "$(date -u +%FT%TZ) $OLD" >> "$ROOT/selector-history.log"
kubectl -n $NS patch svc wso2am --type merge -p "{\"spec\":{\"selector\":{\"app\":\"$SEL\"}}}"
echo "$(date -u +%FT%TZ) switch.sh $1: kubectl -n $NS patch svc wso2am selector $OLD -> {\"app\":\"$SEL\"}" >> "$ROOT/actions.log"
kubectl -n $NS get endpoints wso2am
