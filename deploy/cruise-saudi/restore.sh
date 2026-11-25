#!/usr/bin/env bash
# Cruise Saudi Weave - restore a backup made by backup.sh.
#
#   sudo /opt/weave/installer/restore.sh <backup-dir> --yes [--config FILE] [--bundle DIR] [--isolated-test]
#
# Same server or a NEW server (install.sh must have run there first, with the same weave.conf).
# What it does (Weave and API Manager are DOWN for the duration, typically 5-10 minutes):
#   1. verifies the backup checksums
#   2. stops the Weave containers, the migration tool and API Manager
#   3. restores PostgreSQL (apim_db, shared_db), the API Manager volume (keystores!), Weave data,
#      migration tool data and the code generator workspace
#   4. takes from the backup's secrets.env the values the restored data depends on
#      (API Manager admin password, keystore password, encryption key, internal keys, session
#      secrets, migration tool token); the PostgreSQL passwords of THIS server are kept
#   5. runs install.sh again, which re-applies the configuration, starts everything and smoke-tests it
# The data that was there before is moved aside to <DATA_ROOT>/data.before-restore-<ts> (not deleted).
set -euo pipefail
. "$(dirname "$(readlink -f "$0")")/lib/common.sh"
cs_parse_common "$@"
SRC=""; YES=0
set -- "${CS_ARGS[@]+"${CS_ARGS[@]}"}"
while [ $# -gt 0 ]; do case "$1" in --yes) YES=1; shift;; -h|--help) sed -n '2,18p' "$0"; exit 0;; -*) echo "unknown option $1" >&2; exit 2;; *) SRC="$1"; shift;; esac; done
need_root; cs_load; cs_read_secrets
[ -n "$SRC" ] && [ -d "$SRC" ] || die "usage: restore.sh <backup-dir> --yes"
SRC="$(readlink -f "$SRC")"
[ "$YES" = 1 ] || die "restore replaces the current data; re-run with --yes to confirm"
echo "Restoring $SRC into $DATA_ROOT (log: $LOG_FILE)"

step "Verify backup"
(cd "$SRC" && sha256sum --quiet -c SHA256SUMS) >>"$LOG_FILE" 2>&1 || die "checksum mismatch in $SRC"
for f in apim_db.dump shared_db.dump apim-volume.tgz weave-data.tgz migration-tool.tgz platform.tgz etc.tgz; do [ -s "$SRC/$f" ] || die "$f missing in backup"; done
ok "backup complete and intact ($(grep ^created= "$SRC/MANIFEST" | cut -d= -f2), version $(grep ^version= "$SRC/MANIFEST" | cut -d= -f2))"

step "Stop Weave, migration tool, API Manager"
for c in gateway factory runtime; do docker rm -f "$PREFIX$c" >/dev/null 2>&1 || true; done
kubectl -n "$NS_WEAVE" scale deploy/migration-tool --replicas=0 >>"$LOG_FILE" 2>&1 || true
kubectl -n "$NS_APIM" scale deploy/wso2am --replicas=0 >>"$LOG_FILE" 2>&1 || true
kubectl -n "$NS_APIM" wait --for=delete pod -l app=wso2am --timeout=180s >>"$LOG_FILE" 2>&1 || true
ok "stopped"

step "PostgreSQL"
PGPOD=$(kubectl -n "$NS_APIM" get pod -l app=apim-postgres -o jsonpath='{.items[0].metadata.name}') || die "PostgreSQL is not running (run install.sh first)"
for db in apim_db shared_db; do
  kubectl -n "$NS_APIM" exec "$PGPOD" -- psql -U postgres -v ON_ERROR_STOP=1 -q \
    -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='$db' AND pid<>pg_backend_pid();" \
    -c "DROP DATABASE IF EXISTS $db;" -c "CREATE DATABASE $db OWNER apimadmin;" >>"$LOG_FILE" 2>&1 || die "recreating $db failed"
  kubectl -n "$NS_APIM" exec -i "$PGPOD" -- pg_restore -U postgres -d "$db" --no-owner --role=apimadmin --exit-on-error <"$SRC/$db.dump" >>"$LOG_FILE" 2>&1 \
    || die "pg_restore $db failed (see log)"
  ok "$db restored ($(kubectl -n "$NS_APIM" exec "$PGPOD" -- psql -U postgres -d "$db" -tAc "select count(*) from information_schema.tables where table_schema='public'") tables)"
done

step "Files"
TS=$(date -u +%Y%m%dT%H%M%SZ); ASIDE="$DATA_ROOT/data.before-restore-$TS"; mkdir -p "$ASIDE"
for d in apim gateway factory runtime access migration-tool versions; do [ -e "$DATA/$d" ] && mv "$DATA/$d" "$ASIDE/"; done
tar -C "$DATA" -xzf "$SRC/apim-volume.tgz"; tar -C "$DATA" -xzf "$SRC/weave-data.tgz"; tar -C "$DATA" -xzf "$SRC/migration-tool.tgz"
[ -d "$PLATFORM_DIR" ] && mv "$PLATFORM_DIR" "$ASIDE/platform"
tar -C "$DATA_ROOT" -xzf "$SRC/platform.tgz"
ok "data restored; previous data kept in $ASIDE"

step "Secrets the restored data depends on"
tmp=$(mktemp -d); chmod 700 "$tmp"; tar -C "$tmp" -xzf "$SRC/etc.tgz" etc/secrets.env
cp "$SECRETS" "$ETC/secrets.env.before-restore-$TS"; chmod 600 "$ETC/secrets.env.before-restore-$TS"
for k in APIM_ADMIN_PASSWORD APIM_KEYSTORE_PASSWORD APIM_ENCRYPTION_KEY GATEWAY_SESSION_SECRET FACTORY_SESSION_SECRET RUNTIME_INTERNAL_KEY MT_ADMIN_TOKEN; do
  v=$(grep "^$k=" "$tmp/etc/secrets.env" | cut -d= -f2-) || true
  [ -n "$v" ] || continue
  grep -v "^$k=" "$SECRETS" >"$SECRETS.new" || true; echo "$k=$v" >>"$SECRETS.new"; chmod 600 "$SECRETS.new"; mv "$SECRETS.new" "$SECRETS"
done
rm -rf "$tmp"
ok "secrets merged (previous file: $ETC/secrets.env.before-restore-$TS)"
kubectl -n "$NS_APIM" scale deploy/wso2am --replicas=1 >>"$LOG_FILE" 2>&1 || true
kubectl -n "$NS_WEAVE" scale deploy/migration-tool --replicas=1 >>"$LOG_FILE" 2>&1 || true

step "Re-apply configuration and start (install.sh)"
args=(--config "$ETC/weave.conf"); [ "$ISOLATED" = 1 ] && args+=(--isolated-test); [ -n "$BUNDLE" ] && args+=(--bundle "$BUNDLE")
exec "$CS_DIR/install.sh" "${args[@]}" --skip-dns
