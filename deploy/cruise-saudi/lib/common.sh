# Cruise Saudi Weave - shared helpers for install.sh / upgrade.sh / backup.sh / restore.sh / uninstall.sh.
# Sourced, never executed. Every script calls  cs_init "$@"  first.
# shellcheck shell=bash

CS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ---- pinned versions (keep in sync with build-bundle.sh) ----
K3S_VERSION="v1.31.4+k3s1"
HELM_VERSION="v3.16.3"
CADDY_VERSION="2.11.9"
DOCKER_VERSION="27.5.1"
BAL_VERSION="2201.13.4"
PGJDBC_VERSION="42.7.4"
APIM_IMAGE="docker.io/wso2/wso2am:4.5.0"
PG_IMAGE="docker.io/library/postgres:16-alpine"

# ---- output ----
LOG_FILE="${LOG_FILE:-/var/log/weave-install.log}"
_ts(){ date '+%Y-%m-%d %H:%M:%S'; }
log(){ echo "[$(_ts)] $*" >>"$LOG_FILE"; echo "    $*"; }
step(){ CS_STEP="$*"; CS_STEPNO=$((${CS_STEPNO:-0}+1)); echo "[$(_ts)] ==== STEP $CS_STEPNO: $* ====" >>"$LOG_FILE"; printf '\n==> [%02d] %s\n' "$CS_STEPNO" "$*"; }
ok(){ echo "[$(_ts)] OK: $*" >>"$LOG_FILE"; printf '    OK  %s\n' "$*"; }
warn(){ echo "[$(_ts)] WARN: $*" >>"$LOG_FILE"; printf '    !!  %s\n' "$*" >&2; }
die(){ echo "[$(_ts)] FAILED (step: ${CS_STEP:-init}): $*" >>"$LOG_FILE"
       printf '\nFAILED in step "%s": %s\nSee %s for details.\n' "${CS_STEP:-init}" "$*" "$LOG_FILE" >&2; exit 1; }
run(){ echo "[$(_ts)] \$ $*" >>"$LOG_FILE"; "$@" >>"$LOG_FILE" 2>&1; }   # quiet, logged
trap_err(){ trap 'rc=$?; [ $rc -ne 0 ] && echo "[$(_ts)] exit $rc at line $LINENO (step: ${CS_STEP:-init})" >>"$LOG_FILE"' EXIT; }

# ---- arguments shared by every script ----
#   --config FILE      weave.conf (default: $DATA_ROOT/etc/weave.conf, else ./weave.conf)
#   --bundle DIR       extracted bundle directory (default: the directory holding the scripts)
#   --isolated-test    test profile on a host that already runs the live system (see RUNBOOK)
cs_parse_common(){
  CS_ARGS=()
  ISOLATED=0; CONFIG=""; BUNDLE=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --isolated-test) ISOLATED=1; shift;;
      --config) CONFIG="$2"; shift 2;;
      --bundle) BUNDLE="$2"; shift 2;;
      *) CS_ARGS+=("$1"); shift;;
    esac
  done
}

need_root(){ [ "$(id -u)" = 0 ] || die "run as root"; }

# Load weave.conf + derive the profile. Test profile overrides names/ports so it can share a host
# with the live system without touching it.
cs_load(){
  if [ "$ISOLATED" = 1 ]; then DEFAULT_ROOT=/opt/weave-cstest; else DEFAULT_ROOT=/opt/weave; fi
  if [ -z "$CONFIG" ]; then
    if [ -f "$DEFAULT_ROOT/etc/weave.conf" ]; then CONFIG="$DEFAULT_ROOT/etc/weave.conf"
    elif [ -f "$CS_DIR/weave.conf" ]; then CONFIG="$CS_DIR/weave.conf"
    elif [ "$ISOLATED" = 1 ]; then CONFIG="$CS_DIR/weave.conf.example"
    else die "no configuration: copy weave.conf.example to weave.conf, edit it, and pass --config weave.conf"; fi
  fi
  [ -f "$CONFIG" ] || die "configuration file $CONFIG not found"
  CONFIG="$(readlink -f "$CONFIG")"
  # shellcheck disable=SC1090
  set -a; . "$CONFIG"; set +a
  # proxy settings are for the running services only; the installer itself never goes out
  CONF_HTTPS_PROXY="${HTTPS_PROXY:-}"; CONF_NO_PROXY="${NO_PROXY:-}"
  unset HTTPS_PROXY https_proxy HTTP_PROXY http_proxy NO_PROXY no_proxy

  : "${DATA_ROOT:=/opt/weave}"
  : "${WEAVE_DOMAIN:?WEAVE_DOMAIN is not set in $CONFIG}"
  : "${APIM_DOMAIN:?APIM_DOMAIN is not set in $CONFIG}"
  : "${APIM_ADMIN_USER:=admin}"
  : "${APIM_CPU_LIMIT:=4}"; : "${APIM_MEMORY_LIMIT:=8Gi}"; : "${APIM_JVM_HEAP:=4g}"
  : "${APIM_STARTUP_MINUTES:=5}"
  : "${PG_CPU_LIMIT:=2}"; : "${PG_MEMORY_LIMIT:=2Gi}"
  : "${APIM_DATA_SIZE:=20Gi}"; : "${PG_DATA_SIZE:=50Gi}"
  : "${GATEWAY_HTTPS_NODEPORT:=30243}"; : "${GATEWAY_HTTP_NODEPORT:=30280}"
  : "${APIM_MGMT_NODEPORT:=30443}"; : "${MT_NODEPORT:=30900}"
  : "${ENABLE_GW_PATH:=yes}"
  : "${BACKUP_TARGET:=$DATA_ROOT/backups}"; : "${BACKUP_RETENTION_DAYS:=14}"
  : "${AUTH_PROVIDER:=local,oidc}"
  : "${WEAVE_ADMIN_EMAIL:=${ADMIN_EMAIL:-admin@$WEAVE_DOMAIN}}"; : "${WEAVE_ADMIN_NAME:=Weave Admin}"
  : "${GATEWAY_STAGE:=production}"; : "${GATEWAY_CLIENT_IP_HEADER:=X-Forwarded-For}"
  : "${AUTH_SESSION_HOURS:=12}"; : "${OIDC_GROUPS_CLAIM:=groups}"
  if [ "$ISOLATED" = 0 ]; then
    case "$DATA_ROOT" in /|/usr*|/etc*|/var|/root|/home) die "DATA_ROOT=$DATA_ROOT is not allowed";; esac
  fi

  PREFIX=weave-; NS_APIM=apim; NS_WEAVE=weave; NS_SERVICES=wso2
  PORT_GATEWAY=8787; PORT_FACTORY=8788; PORT_RUNTIME=8790
  HTTPS_PORT=443; HTTP_PORT=80; CADDY_BIND=""
  CADDY_UNIT=weave-caddy
  if [ "$ISOLATED" = 1 ]; then
    DATA_ROOT=/opt/weave-cstest
    WEAVE_DOMAIN=weave.aroya.test; APIM_DOMAIN=apim.aroya.test
    TLS_CERT_FILE=""; TLS_KEY_FILE=""      # self-signed test certificate, made below
    PREFIX=cstest-; NS_APIM=cs-apim; NS_WEAVE=cs-weave; NS_SERVICES=cs-weave
    PORT_GATEWAY=18787; PORT_FACTORY=18788; PORT_RUNTIME=18790
    HTTPS_PORT=9443; HTTP_PORT=9080; CADDY_BIND=127.0.0.1
    GATEWAY_HTTPS_NODEPORT=32243; GATEWAY_HTTP_NODEPORT=32280; APIM_MGMT_NODEPORT=32443; MT_NODEPORT=32690
    APIM_CPU_LIMIT=2; APIM_MEMORY_LIMIT=6Gi; APIM_JVM_HEAP=3g; APIM_STARTUP_MINUTES=12
    PG_CPU_LIMIT=1; PG_MEMORY_LIMIT=1Gi; APIM_DATA_SIZE=2Gi; PG_DATA_SIZE=2Gi
    BACKUP_TARGET=$DATA_ROOT/backups; BACKUP_RETENTION_DAYS=2
    CADDY_UNIT=cstest-caddy
    LOG_FILE=/var/log/weave-cstest-install.log
  fi
  if [ "$ISOLATED" = 1 ]; then   # the test profile can never address live resources
    [[ "$NS_APIM" == cs-* && "$NS_WEAVE" == cs-* && "$PREFIX" == cstest- && "$DATA_ROOT" == /opt/weave-cstest ]] || die "isolated profile guard failed"
  fi
  ETC="$DATA_ROOT/etc"; DATA="$DATA_ROOT/data"; BIN="$DATA_ROOT/bin"; STATE="$DATA_ROOT/state"
  SECRETS="$ETC/secrets.env"
  PLATFORM_DIR="$DATA_ROOT/platform"
  HTTPS_SUFFIX=""; [ "$HTTPS_PORT" = 443 ] || HTTPS_SUFFIX=":$HTTPS_PORT"
  WEAVE_URL="https://$WEAVE_DOMAIN$HTTPS_SUFFIX"
  APIM_URL="https://$APIM_DOMAIN$HTTPS_SUFFIX"
  : "${GATEWAY_PUBLIC_URL:=}"
  if [ -z "$GATEWAY_PUBLIC_URL" ]; then
    if [ "$ENABLE_GW_PATH" = yes ]; then GATEWAY_PUBLIC_URL="$WEAVE_URL/gw"; else GATEWAY_PUBLIC_URL="https://$WEAVE_DOMAIN:$GATEWAY_HTTPS_NODEPORT"; fi
  fi
  [ "$ISOLATED" = 1 ] && GATEWAY_PUBLIC_URL="$WEAVE_URL/gw"
  export PATH="$BIN:/usr/local/bin:$PATH"
  export KUBECONFIG="${KUBECONFIG_OVERRIDE:-/etc/rancher/k3s/k3s.yaml}"
  mkdir -p "$(dirname "$LOG_FILE")"; touch "$LOG_FILE"; chmod 600 "$LOG_FILE"
}

cs_find_bundle(){
  if [ -z "$BUNDLE" ]; then
    if [ -d "$CS_DIR/images" ]; then BUNDLE="$CS_DIR"
    elif [ -s "${STATE:-/nonexistent}/bundle-path" ] && [ -f "$(cat "$STATE/bundle-path")/images/IMAGES" ]; then BUNDLE="$(cat "$STATE/bundle-path")"; fi
  fi
  if [ -n "$BUNDLE" ]; then
    BUNDLE="$(readlink -f "$BUNDLE")"
    [ -f "$BUNDLE/images/IMAGES" ] || die "$BUNDLE is not an extracted Weave bundle (no images/IMAGES)"
    BUNDLE_VERSION="$(cat "$BUNDLE/VERSION" 2>/dev/null || echo unknown)"
    IMG_GATEWAY=$(grep ^gateway= "$BUNDLE/images/IMAGES" | cut -d= -f2)
    IMG_FACTORY=$(grep ^factory= "$BUNDLE/images/IMAGES" | cut -d= -f2)
    IMG_RUNTIME=$(grep ^runtime= "$BUNDLE/images/IMAGES" | cut -d= -f2)
    IMG_MT=$(grep ^migration_tool= "$BUNDLE/images/IMAGES" | cut -d= -f2)
  fi
}

# Secrets: generated once, root-only, never printed.
gen_secret(){ openssl rand -hex "${1:-24}"; }
cs_secrets(){
  mkdir -p "$ETC"; chmod 700 "$ETC"
  touch "$SECRETS"; chmod 600 "$SECRETS"
  local k
  for k in PG_SUPERUSER_PASSWORD APIM_DB_PASSWORD APIM_ADMIN_PASSWORD APIM_KEYSTORE_PASSWORD \
           GATEWAY_SESSION_SECRET FACTORY_SESSION_SECRET RUNTIME_INTERNAL_KEY MT_ADMIN_TOKEN; do
    grep -q "^$k=" "$SECRETS" || echo "$k=$(gen_secret)" >>"$SECRETS"
  done
  # first Weave admin's password: 20 characters, letters and digits (printed once at the end of install)
  if ! grep -q "^WEAVE_BOOTSTRAP_PASSWORD=" "$SECRETS"; then
    echo "WEAVE_BOOTSTRAP_PASSWORD=$(openssl rand -base64 30 | tr -dc 'A-Za-z0-9' | head -c 20)" >>"$SECRETS"
    NEW_BOOTSTRAP_PASSWORD=1
  fi
  # 128-bit symmetric key API Manager encrypts secrets in its database with (32 hex chars)
  grep -q "^APIM_ENCRYPTION_KEY=" "$SECRETS" || echo "APIM_ENCRYPTION_KEY=$(gen_secret 16)" >>"$SECRETS"
  # shellcheck disable=SC1090
  set -a; . "$SECRETS"; set +a
}
cs_read_secrets(){ [ -f "$SECRETS" ] || die "no $SECRETS (is Weave installed here?)"; set -a; . "$SECRETS"; set +a; }

# Template rendering: @@NAME@@ -> value of $NAME. Fails on any placeholder left unresolved.
render(){ # template out
  local content name val
  content="$(cat "$1")"
  for name in $(grep -o '@@[A-Z0-9_]*@@' "$1" | sort -u | tr -d @); do
    [ -n "${!name+x}" ] || die "template $1 needs $name, which is not set"
    val="${!name}"
    content="${content//"@@$name@@"/"$val"}"
  done
  printf '%s\n' "$content" >"$2"
}

k(){ kubectl "$@"; }
wait_http(){ # url expected-code tries [curl opts...]
  local url="$1" want="$2" tries="$3"; shift 3; local code i
  for i in $(seq 1 "$tries"); do
    code=$(curl -sk -o /dev/null -w '%{http_code}' --max-time 10 "$@" "$url" 2>/dev/null || true)
    [[ "$code" =~ ^($want)$ ]] && { echo "$code"; return 0; }
    sleep 3
  done
  echo "$code"; return 1
}
host_ip(){ ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}'; }
cni_ip(){ ip -4 -o addr show cni0 2>/dev/null | awk '{print $4}' | cut -d/ -f1; }
