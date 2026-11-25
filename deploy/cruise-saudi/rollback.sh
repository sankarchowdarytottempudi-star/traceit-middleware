#!/usr/bin/env bash
# Cruise Saudi Weave - go back to the version that was installed before the last upgrade.
#
#   sudo /opt/weave/installer/rollback.sh [--config FILE] [--isolated-test] [--yes]
#
# upgrade.sh keeps everything needed to go back: the previous images stay on the server
# (<DATA_ROOT>/state/images.previous), the previous code generator in <DATA_ROOT>/platform/.previous,
# the previous bundle's path and version in <DATA_ROOT>/state/*.previous, and a backup taken just
# before the upgrade (unless --no-backup was given).
#
# 1. when the previous bundle directory is still on the server: re-applies it (its install.sh), which
#    puts back the previous images AND the previous configuration, then smoke-tests
#    otherwise: puts back the previous images only (flow runtime -> gateway console -> factory ->
#    migration tool, each health-checked) and keeps the current configuration
# 2. puts back the previous code generator (migration-factory, framework, ...); migrated services kept
# 3. swaps current/previous, so running rollback.sh again returns to the newer version
#
# Data is NOT rolled back (migrations, users, API Manager content stay as they are now). To also return
# the data to the moment before the upgrade, restore the pre-upgrade backup afterwards:
#   sudo <DATA_ROOT>/installer/restore.sh <BACKUP_TARGET>/<timestamp>     (see RUNBOOK.md)
# Exit code: 0 = previous version running and healthy; 1 = failed (reason printed).
set -euo pipefail
. "$(dirname "$(readlink -f "$0")")/lib/common.sh"
. "$(dirname "$(readlink -f "$0")")/lib/weave.sh"
cs_parse_common "$@"
YES=0
for a in "${CS_ARGS[@]+"${CS_ARGS[@]}"}"; do case "$a" in --yes) YES=1;; -h|--help) sed -n '2,23p' "$0"; exit 0;; *) echo "unknown option $a" >&2; exit 2;; esac; done
need_root; cs_load; cs_read_secrets; trap_err
echo "[$(_ts)] ===== rollback.sh start (isolated=$ISOLATED) =====" >>"$LOG_FILE"
[ -f "$STATE/images.previous" ] || die "no $STATE/images.previous: there is no earlier version to go back to (rollback is possible after an upgrade.sh)"
[ -f "$STATE/images.current" ] || die "no $STATE/images.current: is Weave installed here?"
CUR_VERSION=$(cat "$STATE/weave-version" 2>/dev/null || echo unknown)
PREV_VERSION=$(cat "$STATE/weave-version.previous" 2>/dev/null || echo unknown)
PREV_BUNDLE=$(cat "$STATE/bundle-path.previous" 2>/dev/null || true)
CUR_BUNDLE=$(cat "$STATE/bundle-path" 2>/dev/null || true)
img(){ grep "^$1=" "$2" | cut -d= -f2; }
P_GATEWAY=$(img gateway "$STATE/images.previous"); P_FACTORY=$(img factory "$STATE/images.previous")
P_RUNTIME=$(img runtime "$STATE/images.previous"); P_MT=$(img migration_tool "$STATE/images.previous")
[ -n "$P_GATEWAY" ] && [ -n "$P_FACTORY" ] && [ -n "$P_RUNTIME" ] && [ -n "$P_MT" ] || die "$STATE/images.previous is incomplete"
echo "Rollback Weave $CUR_VERSION -> $PREV_VERSION  (log: $LOG_FILE)"
if [ "$YES" = 0 ] && [ -t 0 ]; then
  read -r -p "Go back to $PREV_VERSION now? Data stays as it is. [y/N] " ans; [[ "$ans" =~ ^[yY] ]] || { echo "nothing changed"; exit 1; }
fi

step "Previous images present"
for i in "$P_GATEWAY" "$P_FACTORY" "$P_RUNTIME"; do docker image inspect "$i" >/dev/null 2>&1 || die "docker image $i is no longer on this server"; done
k8s_imgs="$(k3s ctr -n k8s.io images ls -q 2>/dev/null || true)"   # no "| grep -q" under pipefail (SIGPIPE)
grep -qx "docker.io/$P_MT" <<<"$k8s_imgs" || die "k3s image docker.io/$P_MT is no longer on this server"
ok "$P_GATEWAY $P_FACTORY $P_RUNTIME $P_MT"
cp "$STATE/images.current" "$STATE/images.rollback-from"

step "Previous code generator"
if [ -d "$PLATFORM_DIR/.previous" ] && [ -n "$(ls -A "$PLATFORM_DIR/.previous" 2>/dev/null)" ]; then
  rm -rf "$PLATFORM_DIR/.rollback-from"; mkdir -p "$PLATFORM_DIR/.rollback-from"
  for d in "$PLATFORM_DIR/.previous"/*; do
    n=$(basename "$d"); [ -e "$PLATFORM_DIR/$n" ] && mv "$PLATFORM_DIR/$n" "$PLATFORM_DIR/.rollback-from/"; mv "$d" "$PLATFORM_DIR/$n"
  done
  rm -rf "$PLATFORM_DIR/.previous"; mv "$PLATFORM_DIR/.rollback-from" "$PLATFORM_DIR/.previous"
  ok "migration-factory/framework of $PREV_VERSION back in place (the newer code is in $PLATFORM_DIR/.previous)"
else warn "no $PLATFORM_DIR/.previous: code generator left as it is"; fi

swap_state(){
  printf 'gateway=%s\nfactory=%s\nruntime=%s\nmigration_tool=%s\n' "$P_GATEWAY" "$P_FACTORY" "$P_RUNTIME" "$P_MT" >"$STATE/images.current"
  cp "$STATE/images.rollback-from" "$STATE/images.previous"; rm -f "$STATE/images.rollback-from"
  echo "$PREV_VERSION" >"$STATE/weave-version"; echo "$CUR_VERSION" >"$STATE/weave-version.previous"
  [ -n "$CUR_BUNDLE" ] && echo "$CUR_BUNDLE" >"$STATE/bundle-path.previous"
  [ -n "$PREV_BUNDLE" ] && [ -d "$PREV_BUNDLE" ] && echo "$PREV_BUNDLE" >"$STATE/bundle-path"
  return 0
}

if [ -n "$PREV_BUNDLE" ] && [ -x "$PREV_BUNDLE/install.sh" ] && [ -f "$PREV_BUNDLE/images/IMAGES" ] \
   && [ "$(grep ^gateway= "$PREV_BUNDLE/images/IMAGES" | cut -d= -f2)" = "$P_GATEWAY" ]; then
  step "Re-apply $PREV_VERSION from its bundle ($PREV_BUNDLE)"
  args=(--config "$ETC/weave.conf" --bundle "$PREV_BUNDLE" --skip-dns); [ "$ISOLATED" = 1 ] && args+=(--isolated-test)
  "$PREV_BUNDLE/install.sh" "${args[@]}" || die "install.sh of $PREV_VERSION failed (see $LOG_FILE); run it again or restore the pre-upgrade backup"
  swap_state
else
  step "Put back the previous images (bundle of $PREV_VERSION not on this server: configuration stays current)"
  for c in runtime gateway factory; do
    v="P_${c^^}"; weave_start "$c" "${!v}" || die "could not start $PREFIX$c on ${!v}"
    weave_healthy "$c" || die "$PREFIX$c not healthy on ${!v} (docker logs $PREFIX$c)"
    ok "$PREFIX$c healthy on ${!v}"
  done
  kubectl -n "$NS_WEAVE" set image deploy/migration-tool app="$P_MT" >>"$LOG_FILE" 2>&1 || die "kubectl set image migration-tool failed"
  kubectl -n "$NS_WEAVE" rollout status deploy/migration-tool --timeout=240s >>"$LOG_FILE" 2>&1 || die "migration tool not ready on $P_MT"
  wait_http "http://127.0.0.1:$MT_NODEPORT/api/health" 200 20 >/dev/null || die "migration tool health check failed on $P_MT"
  ok "migration tool healthy on $P_MT"
  swap_state
fi
echo "Rollback to $PREV_VERSION complete. Running rollback.sh again returns to $CUR_VERSION."
echo "Data was not changed; to return it to the moment before the upgrade: restore.sh <pre-upgrade backup> (RUNBOOK.md)."
