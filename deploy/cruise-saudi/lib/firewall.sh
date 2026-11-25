#!/usr/bin/env bash
# Cruise Saudi Weave - host firewall for the API gateway port (written by install.sh; NETWORK.md).
#
#   firewall.sh apply  <chain> "<tcp ports>" "<allowed sources>"   (re)create the chain, idempotent
#   firewall.sh remove <chain>                                    take the chain out again
#   firewall.sh show   <chain>
#
# The gateway is a pod host port: the kernel DNATs it to the pod in nat/PREROUTING, before the filter
# INPUT chain is consulted. The rules therefore live in raw/PREROUTING (before connection tracking and
# DNAT): a NEW packet to one of the ports is dropped unless it arrives on loopback or comes from the
# pod network (10.42.0.0/16) or one of the allowed sources. Nothing else on the host is touched.
set -euo pipefail
act="${1:-}"; chain="${2:-}"
[ -n "$chain" ] || { sed -n '2,12p' "$0"; exit 2; }
[[ "$chain" =~ ^[A-Z0-9_]{1,28}$ ]] || { echo "bad chain name $chain" >&2; exit 2; }
IPT=iptables; command -v iptables >/dev/null || IPT=/usr/sbin/iptables
POD_CIDR="${POD_CIDR:-10.42.0.0/16}"
remove(){
  while $IPT -w -t raw -S PREROUTING 2>/dev/null | grep -q -- "-j $chain\$"; do
    rule=$($IPT -w -t raw -S PREROUTING | grep -- "-j $chain\$" | head -1 | sed 's/^-A /-D /')
    eval "$IPT -w -t raw $rule"
  done
  if $IPT -w -t raw -S "$chain" >/dev/null 2>&1; then $IPT -w -t raw -F "$chain"; $IPT -w -t raw -X "$chain"; fi
}
case "$act" in
  apply)
    ports="$(echo "${3:-}" | tr ' ' ',')"; srcs="${4:-}"
    [ -n "$ports" ] || { echo "no ports" >&2; exit 2; }
    [ -n "$srcs" ] || { echo "no allowed sources (remove the chain instead)" >&2; exit 2; }
    $IPT -w -t raw -N "$chain" 2>/dev/null || $IPT -w -t raw -F "$chain"
    $IPT -w -t raw -A "$chain" -i lo -j RETURN
    $IPT -w -t raw -A "$chain" -s "$POD_CIDR" -j RETURN
    for s in $(echo "$srcs" | tr ',' ' '); do $IPT -w -t raw -A "$chain" -s "$s" -j RETURN; done
    $IPT -w -t raw -A "$chain" -j DROP
    # exactly one jump from PREROUTING, for the current port list
    while $IPT -w -t raw -S PREROUTING | grep -q -- "-j $chain\$"; do
      rule=$($IPT -w -t raw -S PREROUTING | grep -- "-j $chain\$" | head -1 | sed 's/^-A /-D /'); eval "$IPT -w -t raw $rule"
    done
    $IPT -w -t raw -I PREROUTING -p tcp -m multiport --dports "$ports" -j "$chain"
    ;;
  remove) remove;;
  show) { $IPT -w -t raw -S PREROUTING 2>/dev/null | grep -- "-j $chain\$" || true; $IPT -w -t raw -S "$chain" 2>/dev/null || echo "(no chain $chain)"; };;
  *) sed -n '2,12p' "$0"; exit 2;;
esac
