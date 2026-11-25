#!/usr/bin/env bash
# Cruise Saudi Weave - backup. Online: nothing is stopped.
#
#   sudo /opt/weave/installer/backup.sh [--config FILE] [--target DIR] [--isolated-test]
#
# Writes <BACKUP_TARGET>/weave-backup-<UTC timestamp>/ with:
#   apim_db.dump, shared_db.dump   PostgreSQL custom-format dumps (pg_restore), globals.sql (roles)
#   apim-volume.tgz                API Manager volume: keystores (!), search index, local registry
#   weave-data.tgz                 Weave Gateway / Factory data, flow runtime (flows, secret.key)
#   migration-tool.tgz             migration tool data (projects, uploads, runs)
#   platform.tgz                   code generator workspace (migrated services; build output excluded)
#   etc.tgz                        weave.conf, secrets.env, certificates, keys  (SENSITIVE)
#   MANIFEST, SHA256SUMS
# then deletes backups older than BACKUP_RETENTION_DAYS. The directory is mode 700: it holds
# secrets, so the backup target must be protected like the server itself.
set -euo pipefail
. "$(dirname "$(readlink -f "$0")")/lib/common.sh"
cs_parse_common "$@"
TARGET_OVERRIDE=""
set -- "${CS_ARGS[@]+"${CS_ARGS[@]}"}"
while [ $# -gt 0 ]; do case "$1" in --target) TARGET_OVERRIDE="$2"; shift 2;; -h|--help) sed -n '2,18p' "$0"; exit 0;; *) echo "unknown option $1" >&2; exit 2;; esac; done
need_root; LOG_FILE=/var/log/weave-backup.log; cs_load
[ "$ISOLATED" = 1 ] && LOG_FILE=/var/log/weave-cstest-backup.log
cs_read_secrets
[ -n "$TARGET_OVERRIDE" ] && BACKUP_TARGET="$TARGET_OVERRIDE"
TS=$(date -u +%Y%m%dT%H%M%SZ); DEST="$BACKUP_TARGET/weave-backup-$TS"
mkdir -p "$DEST"; chmod 700 "$BACKUP_TARGET" "$DEST" 2>/dev/null || chmod 700 "$DEST"
echo "Weave backup -> $DEST"

step "PostgreSQL dumps"
PGPOD=$(kubectl -n "$NS_APIM" get pod -l app=apim-postgres -o jsonpath='{.items[0].metadata.name}') || die "no PostgreSQL pod in $NS_APIM"
for db in apim_db shared_db; do
  kubectl -n "$NS_APIM" exec "$PGPOD" -- pg_dump -U postgres -Fc "$db" >"$DEST/$db.dump" 2>>"$LOG_FILE" || die "pg_dump $db failed"
  [ -s "$DEST/$db.dump" ] || die "empty dump of $db"
  ok "$db: $(du -h "$DEST/$db.dump" | cut -f1)"
done
kubectl -n "$NS_APIM" exec "$PGPOD" -- pg_dumpall -U postgres --globals-only >"$DEST/globals.sql" 2>>"$LOG_FILE" || die "pg_dumpall --globals-only failed"

step "API Manager volume, Weave data, migration tool, workspace, configuration"
tar -C "$DATA" -czf "$DEST/apim-volume.tgz" apim 2>>"$LOG_FILE" || die "apim volume archive failed"
ok "apim-volume.tgz $(du -h "$DEST/apim-volume.tgz" | cut -f1)"
tar -C "$DATA" -czf "$DEST/weave-data.tgz" gateway factory runtime 2>>"$LOG_FILE" || die "weave data archive failed"
ok "weave-data.tgz $(du -h "$DEST/weave-data.tgz" | cut -f1)"
tar -C "$DATA" -czf "$DEST/migration-tool.tgz" migration-tool 2>>"$LOG_FILE" || die "migration tool archive failed"
ok "migration-tool.tgz $(du -h "$DEST/migration-tool.tgz" | cut -f1)"
tar -C "$DATA_ROOT" --exclude='platform/services/*/target' --exclude='platform/target' --exclude='__pycache__' \
  -czf "$DEST/platform.tgz" platform 2>>"$LOG_FILE" || die "workspace archive failed"
ok "platform.tgz $(du -h "$DEST/platform.tgz" | cut -f1)"
( umask 077; tar -C "$DATA_ROOT" -czf "$DEST/etc.tgz" etc 2>>"$LOG_FILE" ) || die "etc archive failed"
ok "etc.tgz (secrets - keep the backup target protected)"

{ echo "created=$TS"; echo "host=$(hostname)"; echo "version=$(cat "$STATE/weave-version" 2>/dev/null || echo unknown)"
  echo "profile=${PREFIX%-}"; cat "$STATE/images.current" 2>/dev/null || true; } >"$DEST/MANIFEST"
(cd "$DEST" && sha256sum ./*.dump ./*.tgz globals.sql MANIFEST >SHA256SUMS)
chmod 600 "$DEST"/*

step "Retention ($BACKUP_RETENTION_DAYS days)"
n=0
while IFS= read -r old; do rm -rf "$old"; n=$((n+1)); log "removed $old"; done < <(find "$BACKUP_TARGET" -maxdepth 1 -type d -name 'weave-backup-*' -mtime +"$BACKUP_RETENTION_DAYS")
ok "$n old backup(s) removed; kept: $(find "$BACKUP_TARGET" -maxdepth 1 -type d -name 'weave-backup-*' | wc -l)"
echo
echo "Backup complete: $DEST ($(du -sh "$DEST" | cut -f1))"
