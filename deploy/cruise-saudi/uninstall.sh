#!/usr/bin/env bash
# Cruise Saudi Weave - uninstall.
#
#   sudo /opt/weave/installer/uninstall.sh --yes [--purge] [--remove-k3s] [--isolated-test]
#
# Default: removes the running parts (Weave containers, reverse proxy unit, namespaces, volumes'
# Kubernetes objects, cron entry, the migration tool's SSH key) and KEEPS all data under DATA_ROOT
# (databases, volumes, configuration, secrets, backups): install.sh brings it back as it was.
# --purge       also deletes DATA_ROOT (all data, configuration, secrets; backups too when they are
#               under DATA_ROOT) and the Weave images
# --remove-k3s  also uninstalls k3s (production profile only; Docker and Ballerina are left in place)
set -euo pipefail
. "$(dirname "$(readlink -f "$0")")/lib/common.sh"
cs_parse_common "$@"
PURGE=0; RMK3S=0; YES=0
for a in "${CS_ARGS[@]+"${CS_ARGS[@]}"}"; do case "$a" in --purge) PURGE=1;; --remove-k3s) RMK3S=1;; --yes) YES=1;; -h|--help) sed -n '2,13p' "$0"; exit 0;; *) echo "unknown option $a" >&2; exit 2;; esac; done
need_root
[ -f /opt/weave-cstest/etc/weave.conf ] || [ "$ISOLATED" = 0 ] || CONFIG="$CS_DIR/weave.conf.example"
cs_load
[ "$ISOLATED" = 1 ] && YES=1          # the test profile only ever touches cs-*/cstest-* resources
[ "$ISOLATED" = 1 ] && [ "$RMK3S" = 1 ] && die "--remove-k3s is not allowed with --isolated-test"
[ "$YES" = 1 ] || die "this removes Cruise Saudi Weave from this server; re-run with --yes (add --purge to delete the data too)"
echo "Uninstalling Cruise Saudi Weave ($DATA_ROOT, purge=$PURGE)  log: $LOG_FILE"

step "Weave containers"
for c in gateway factory runtime change-model; do docker rm -f "$PREFIX$c" >>"$LOG_FILE" 2>&1 && ok "removed $PREFIX$c" || true; done

step "Reverse proxy"
if [ -f "/etc/systemd/system/$CADDY_UNIT.service" ]; then
  systemctl disable --now "$CADDY_UNIT" >>"$LOG_FILE" 2>&1 || true
  rm -f "/etc/systemd/system/$CADDY_UNIT.service"; systemctl daemon-reload
  ok "removed $CADDY_UNIT.service"
else ok "no $CADDY_UNIT.service"; fi

step "Kubernetes objects"
if kubectl get ns >/dev/null 2>&1; then
  for ns in "$NS_APIM" "$NS_WEAVE"; do
    if kubectl get ns "$ns" >/dev/null 2>&1; then kubectl delete ns "$ns" --wait=true --timeout=300s >>"$LOG_FILE" 2>&1 && ok "namespace $ns deleted" || warn "namespace $ns not deleted"; fi
  done
  if [ "$NS_SERVICES" != "$NS_APIM" ] && [ "$NS_SERVICES" != "$NS_WEAVE" ] && kubectl get ns "$NS_SERVICES" >/dev/null 2>&1; then
    kubectl -n "$NS_SERVICES" delete role,rolebinding weave-reader --ignore-not-found >>"$LOG_FILE" 2>&1
    if [ "$PURGE" = 1 ] && [ "$(kubectl get ns "$NS_SERVICES" -o jsonpath='{.metadata.labels.app\.kubernetes\.io/part-of}')" = cruise-saudi-weave ]; then
      kubectl delete ns "$NS_SERVICES" --timeout=300s >>"$LOG_FILE" 2>&1 && ok "namespace $NS_SERVICES deleted (migrated services on THIS cluster)"
    else ok "namespace $NS_SERVICES kept (access objects removed)"; fi
  fi
  for pv in "${PREFIX}apim-postgres" "${PREFIX}apim-data"; do
    kubectl delete pv "$pv" --ignore-not-found >>"$LOG_FILE" 2>&1 && ok "PersistentVolume $pv object removed (data stays in $DATA unless --purge)"
  done
else warn "Kubernetes not reachable; skipped"; fi

step "SSH key, schedule"
if [ -f "$ETC/mt-ssh/id_ed25519.pub" ] && [ -f /root/.ssh/authorized_keys ]; then
  key=$(cut -d' ' -f2 "$ETC/mt-ssh/id_ed25519.pub")   # matches the line with or without its command= options
  grep -vF "$key" /root/.ssh/authorized_keys >/root/.ssh/authorized_keys.weave-tmp || true
  chmod 600 /root/.ssh/authorized_keys.weave-tmp; mv /root/.ssh/authorized_keys.weave-tmp /root/.ssh/authorized_keys
  ok "migration tool key removed from /root/.ssh/authorized_keys"
fi
[ "$ISOLATED" = 0 ] && rm -f /etc/cron.d/weave-backup && ok "backup schedule removed"

if [ "$PURGE" = 1 ]; then
  step "Purge data and images"
  imgs=$(docker images --format '{{.Repository}}:{{.Tag}}' | grep '^cruise-saudi/' || true)
  if [ "$ISOLATED" = 1 ] && [ -n "${KEEP_IMAGES:-}" ]; then imgs=""; fi
  for i in $imgs; do docker rmi "$i" >>"$LOG_FILE" 2>&1 && ok "docker image $i removed" || warn "could not remove $i"; done
  for i in $(k3s ctr -n k8s.io images ls -q 2>/dev/null | grep '^docker.io/cruise-saudi/' || true); do
    [ "$ISOLATED" = 1 ] && [ -n "${KEEP_IMAGES:-}" ] && break
    k3s ctr -n k8s.io images rm "$i" >>"$LOG_FILE" 2>&1 && ok "k3s image $i removed"
  done
  case "$DATA_ROOT" in /opt/*|/srv/*|/data*) rm -rf "$DATA_ROOT"; ok "$DATA_ROOT deleted";; *) warn "DATA_ROOT=$DATA_ROOT not deleted automatically (unusual path); delete it by hand";; esac
fi

if [ "$RMK3S" = 1 ]; then
  step "k3s"
  [ -x /usr/local/bin/k3s-uninstall.sh ] && /usr/local/bin/k3s-uninstall.sh >>"$LOG_FILE" 2>&1 && ok "k3s removed" || warn "k3s-uninstall.sh not found or failed"
fi
echo
echo "Uninstall complete.$([ "$PURGE" = 0 ] && echo " Data kept in $DATA_ROOT (install.sh restores the service; uninstall.sh --purge deletes it).")"
