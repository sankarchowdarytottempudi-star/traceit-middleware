#!/usr/bin/env bash
# Cruise Saudi Weave - upgrade to a new bundle with automatic rollback.
#
#   tar xzf weave-cruise-saudi-<new>.tar.gz
#   sudo ./weave-cruise-saudi-<new>/upgrade.sh [--config FILE] [--no-backup] [--isolated-test]
#
# 1. checks the new bundle, takes a backup (backup.sh) unless --no-backup
# 2. loads the new images (the previous ones stay on the server)
# 3. replaces, one at a time, flow runtime -> gateway console -> factory -> migration tool; each must
#    answer its health check, otherwise EVERYTHING replaced so far goes back to the previous images
#    and the script exits 1
# 4. refreshes the code generator (migration-factory, framework, chart; migrated services are kept;
#    the previous code stays in <DATA_ROOT>/platform/.previous)
# 5. re-applies the configuration from the new bundle (install.sh), which also smoke-tests
# API Manager and PostgreSQL keep running (same image versions); their configuration is re-applied in 5.
set -euo pipefail
. "$(dirname "$(readlink -f "$0")")/lib/common.sh"
. "$(dirname "$(readlink -f "$0")")/lib/weave.sh"
cs_parse_common "$@"
NO_BACKUP=0
for a in "${CS_ARGS[@]+"${CS_ARGS[@]}"}"; do case "$a" in --no-backup) NO_BACKUP=1;; -h|--help) sed -n '2,16p' "$0"; exit 0;; *) echo "unknown option $a" >&2; exit 2;; esac; done
need_root; cs_load
[ -n "$BUNDLE" ] || { [ -d "$CS_DIR/images" ] && BUNDLE="$CS_DIR"; }
[ -n "$BUNDLE" ] || die "run upgrade.sh from the extracted NEW bundle, or pass --bundle DIR"
cs_find_bundle; cs_read_secrets; trap_err
echo "[$(_ts)] ===== upgrade.sh start (isolated=$ISOLATED bundle=$BUNDLE) =====" >>"$LOG_FILE"
[ -f "$STATE/images.current" ] || die "no $STATE/images.current: is Weave installed here?"
OLD_VERSION=$(cat "$STATE/weave-version" 2>/dev/null || echo unknown)
OLD_GATEWAY=$(grep ^gateway= "$STATE/images.current" | cut -d= -f2); OLD_FACTORY=$(grep ^factory= "$STATE/images.current" | cut -d= -f2)
OLD_RUNTIME=$(grep ^runtime= "$STATE/images.current" | cut -d= -f2); OLD_MT=$(grep ^migration_tool= "$STATE/images.current" | cut -d= -f2)
echo "Upgrade Weave $OLD_VERSION -> $BUNDLE_VERSION  (log: $LOG_FILE)"

step "Check the new bundle"
(cd "$BUNDLE" && sha256sum --quiet -c SHA256SUMS) >>"$LOG_FILE" 2>&1 || die "bundle checksum mismatch"
ok "bundle $BUNDLE_VERSION intact"

if [ "$NO_BACKUP" = 0 ]; then
  step "Backup before upgrading"
  bargs=(--config "$ETC/weave.conf"); [ "$ISOLATED" = 1 ] && bargs+=(--isolated-test)
  "$CS_DIR/backup.sh" "${bargs[@]}" | tail -1 | tee -a "$LOG_FILE" || die "backup failed; nothing was changed"
fi

step "Load new images"
for f in "$BUNDLE"/images/docker/weave-*.tar; do run docker load -i "$f" || die "docker load $f failed"; done
run k3s ctr -n k8s.io images import "$BUNDLE/images/k8s/migration-tool.tar" || die "k3s import of the migration tool failed"
ok "loaded $IMG_GATEWAY $IMG_FACTORY $IMG_RUNTIME $IMG_MT"

REPLACED=()
rollback(){
  warn "rolling back: ${REPLACED[*]:-nothing replaced yet}"
  local c
  for c in "${REPLACED[@]}"; do
    case "$c" in
      migration-tool) kubectl -n "$NS_WEAVE" set image deploy/migration-tool app="$OLD_MT" >>"$LOG_FILE" 2>&1
                      kubectl -n "$NS_WEAVE" rollout status deploy/migration-tool --timeout=180s >>"$LOG_FILE" 2>&1 && ok "migration tool back on $OLD_MT" || warn "migration tool rollback not healthy";;
      *) local v="OLD_${c^^}"; weave_start "$c" "${!v}" && weave_healthy "$c" 20 && ok "$PREFIX$c back on ${!v}" || warn "$PREFIX$c rollback not healthy";;
    esac
  done
  die "upgrade failed; previous version $OLD_VERSION restored"
}

step "Rolling replace (one component at a time)"
for c in runtime gateway factory; do
  new="IMG_${c^^}"
  log "replace $PREFIX$c -> ${!new}"
  REPLACED+=("$c")
  weave_start "$c" "${!new}" || rollback
  weave_healthy "$c" || rollback
  ok "$PREFIX$c healthy on ${!new}"
done
REPLACED+=(migration-tool)
kubectl -n "$NS_WEAVE" set image deploy/migration-tool app="$IMG_MT" >>"$LOG_FILE" 2>&1 || rollback
kubectl -n "$NS_WEAVE" rollout status deploy/migration-tool --timeout=240s >>"$LOG_FILE" 2>&1 || rollback
wait_http "http://127.0.0.1:$MT_NODEPORT/api/health" 200 20 >/dev/null || rollback
ok "migration tool healthy on $IMG_MT"
printf 'gateway=%s\nfactory=%s\nruntime=%s\nmigration_tool=%s\n' "$IMG_GATEWAY" "$IMG_FACTORY" "$IMG_RUNTIME" "$IMG_MT" >"$STATE/images.current"
printf 'gateway=%s\nfactory=%s\nruntime=%s\nmigration_tool=%s\n' "$OLD_GATEWAY" "$OLD_FACTORY" "$OLD_RUNTIME" "$OLD_MT" >"$STATE/images.previous"

step "Refresh the code generator"
rm -rf "$PLATFORM_DIR/.previous"; mkdir -p "$PLATFORM_DIR/.previous"
for d in migration-factory framework deploy tools; do [ -e "$PLATFORM_DIR/$d" ] && cp -a "$PLATFORM_DIR/$d" "$PLATFORM_DIR/.previous/"; done
tar xzf "$BUNDLE/platform/platform-seed.tgz" -C "$PLATFORM_DIR" || die "unpacking the code generator failed"
ok "migration-factory/framework updated (previous in $PLATFORM_DIR/.previous; services untouched)"

step "Re-apply configuration from the new bundle (install.sh)"
args=(--config "$ETC/weave.conf" --bundle "$BUNDLE" --skip-dns); [ "$ISOLATED" = 1 ] && args+=(--isolated-test)
if ! "$BUNDLE/install.sh" "${args[@]}"; then
  warn "install.sh from the new bundle failed"; REPLACED=(runtime gateway factory migration-tool)
  printf 'gateway=%s\nfactory=%s\nruntime=%s\nmigration_tool=%s\n' "$OLD_GATEWAY" "$OLD_FACTORY" "$OLD_RUNTIME" "$OLD_MT" >"$STATE/images.current"
  echo "$OLD_VERSION" >"$STATE/weave-version"
  rollback
fi
echo "Upgrade to $BUNDLE_VERSION complete (previous images kept for: upgrade.sh --bundle <old bundle>)."
