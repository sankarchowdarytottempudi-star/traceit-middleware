#!/usr/bin/env bash
# Cruise Saudi Weave - one-command installer for a raw Ubuntu 24.04 LTS / RHEL 9 server.
#
#   sudo ./install.sh --config weave.conf            install or re-apply (idempotent, re-runnable)
#   sudo ./install.sh --config weave.conf --preflight   only run the checks, change nothing
#
# Options:
#   --config FILE     settings (see weave.conf.example). Default: <DATA_ROOT>/etc/weave.conf
#   --bundle DIR      extracted offline bundle (default: the directory holding this script)
#   --preflight       run the pre-flight checks only
#   --skip-dns        do not require the DNS names to resolve yet (e.g. DNS is changed at cut-over)
#   --allow-small     allow a server below 16 vCPU / 60 GB RAM / 200 GB free (warning only)
#   --use-os-repo     let the installer apt/dnf-install the OS prerequisites from the server's
#                     configured (internal) repository. Default: never call apt/dnf; only check.
#   --isolated-test   TEST PROFILE for a host that already runs another Weave: separate data root
#                     /opt/weave-cstest, namespaces cs-apim/cs-weave, containers cstest-*, Caddy on
#                     127.0.0.1:9443 with a self-signed certificate for weave.aroya.test/apim.aroya.test.
#                     Reuses the host's Docker + k3s and never touches host-wide software. See RUNBOOK.
#
# Output: step-by-step on the terminal, full detail in /var/log/weave-install.log.
# Exit code: 0 = installed and smoke checks passed; 1 = failed (reason printed); 3 = not enough memory
# to start API Manager (isolated test only).
set -euo pipefail
. "$(dirname "$(readlink -f "$0")")/lib/common.sh"
. "$(dirname "$(readlink -f "$0")")/lib/weave.sh"

PREFLIGHT_ONLY=0; SKIP_DNS=0; ALLOW_SMALL=0; USE_OS_REPO=0
# OS prerequisites. Present on a standard Ubuntu 24.04 server / RHEL 9 server install; everything
# else (Docker, k3s, helm, kubectl, Caddy, Ballerina + JRE, Python 3.12 fallback) comes from the bundle.
REQ_CMDS="curl openssl tar gzip sha256sum ss ip ssh-keygen sshd systemctl iptables"
REC_CMDS="git rsync crontab"
PKGS_UBUNTU="curl ca-certificates openssl tar gzip iproute2 iptables openssh-server cron git rsync"
PKGS_RHEL="curl ca-certificates openssl tar gzip iproute iptables-nft openssh-server cronie git rsync container-selinux python3.12"
cs_parse_common "$@"
for a in "${CS_ARGS[@]+"${CS_ARGS[@]}"}"; do
  case "$a" in
    --preflight) PREFLIGHT_ONLY=1;; --use-os-repo) USE_OS_REPO=1;; --skip-dns) SKIP_DNS=1;; --allow-small) ALLOW_SMALL=1;;
    -h|--help) sed -n '2,22p' "$0"; exit 0;;
    *) echo "unknown option $a" >&2; exit 2;;
  esac
done
need_root
cs_load
cs_find_bundle
trap_err
echo "[$(_ts)] ===== install.sh start (isolated=$ISOLATED config=$CONFIG bundle=${BUNDLE:-none}) =====" >>"$LOG_FILE"
echo "Cruise Saudi Weave installer  (log: $LOG_FILE)"
[ "$ISOLATED" = 1 ] && echo "*** ISOLATED TEST PROFILE: data $DATA_ROOT, namespaces $NS_APIM/$NS_WEAVE, containers ${PREFIX}*, https://127.0.0.1:$HTTPS_PORT ***"

HOST_IP="$(host_ip)"; [ -n "$HOST_IP" ] || HOST_IP="$(hostname -I | awk '{print $1}')"

# =================================================================================== preflight
step "Pre-flight checks"
. /etc/os-release
case "$ID:${VERSION_ID%%.*}" in
  ubuntu:24) OS=ubuntu;;
  rhel:9|rocky:9|almalinux:9|ol:9|centos:9) OS=rhel;;
  *) die "unsupported OS $PRETTY_NAME (need Ubuntu 24.04 LTS or RHEL 9)";;
esac
[ "$ID" = ubuntu ] && [ "$VERSION_ID" != "24.04" ] && die "unsupported Ubuntu $VERSION_ID (need 24.04)"
[ "$(uname -m)" = x86_64 ] || die "need an x86_64 server (found $(uname -m))"
ok "OS: $PRETTY_NAME ($OS), host IP $HOST_IP"
missing=""; for c in $REQ_CMDS; do command -v "$c" >/dev/null || [ -x "/usr/sbin/$c" ] || missing="$missing $c"; done
if [ -n "$missing" ] && [ "$USE_OS_REPO" = 0 ]; then
  die "missing OS prerequisites:$missing. Install them from your internal repository (packages: $( [ "$OS" = ubuntu ] && echo "$PKGS_UBUNTU" || echo "$PKGS_RHEL")) or re-run with --use-os-repo"
fi
for c in $REC_CMDS; do command -v "$c" >/dev/null || warn "recommended command '$c' missing (git: repository import in the migration tool; crontab: backup schedule)"; done
[ -n "$missing" ] || ok "OS prerequisites present: $REQ_CMDS"

CPUS=$(nproc); MEM_GB=$(awk '/MemTotal/ {print int($2/1048576)}' /proc/meminfo)
AVAIL_GB=$(awk '/MemAvailable/ {print int($2/1048576)}' /proc/meminfo)
mkdir -p "$DATA_ROOT"
DISK_GB=$(df -BG --output=avail "$DATA_ROOT" | tail -1 | tr -dc 0-9)
if [ "$ISOLATED" = 1 ]; then
  ok "resources: $CPUS vCPU, $MEM_GB GB RAM ($AVAIL_GB GB available), $DISK_GB GB free (test profile: no size gate)"
else
  small=""
  [ "$CPUS" -ge 16 ] || small="$small cpu=$CPUS<16"
  [ "$MEM_GB" -ge 60 ] || small="$small ram=${MEM_GB}GB<60"
  [ "$DISK_GB" -ge 200 ] || small="$small disk=${DISK_GB}GB<200 free on $DATA_ROOT"
  if [ -n "$small" ]; then
    [ "$ALLOW_SMALL" = 1 ] && warn "server below the sizing:$small (continuing: --allow-small)" || die "server below the sizing:$small (16 vCPU / 64 GB / 1 TB expected; --allow-small to override)"
  else ok "resources: $CPUS vCPU, $MEM_GB GB RAM, $DISK_GB GB free on $DATA_ROOT"; fi
  [ "$DISK_GB" -ge 40 ] || die "only ${DISK_GB} GB free on $DATA_ROOT; need at least 40 GB"
fi

port_owner(){ ss -Hltnp "sport = :$1" 2>/dev/null | head -1 | sed -E 's/.*users:\(\("([^"]+)".*/\1/'; }
for p in "$HTTP_PORT" "$HTTPS_PORT"; do
  o="$(port_owner "$p")"
  if [ -n "$o" ]; then
    if systemctl is-active -q "$CADDY_UNIT" 2>/dev/null && [ "$o" = caddy ] && systemctl show -p MainPID --value "$CADDY_UNIT" | grep -q "$(ss -Hltnp "sport = :$p" | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2)"; then
      ok "port $p: already served by $CADDY_UNIT (re-run)"
    else die "port $p is in use by '$o' (stop it or free the port)"; fi
  else ok "port $p free"; fi
done
for p in "$PORT_GATEWAY" "$PORT_FACTORY" "$PORT_RUNTIME"; do
  o="$(port_owner "$p")"
  if [ -n "$o" ] && ! docker ps --format '{{.Names}}' 2>/dev/null | grep -q "^${PREFIX}"; then die "port $p (Weave internal) is in use by '$o'"; fi
done
if command -v kubectl >/dev/null && kubectl get ns >/dev/null 2>&1; then
  used=$(kubectl get svc -A -o jsonpath='{range .items[*]}{.metadata.namespace}{" "}{range .spec.ports[*]}{.nodePort}{" "}{end}{"\n"}{end}' 2>/dev/null | grep -vE "^($NS_APIM|$NS_WEAVE) " || true)
  for p in "$APIM_MGMT_NODEPORT" "$GATEWAY_HTTPS_NODEPORT" "$GATEWAY_HTTP_NODEPORT" "$MT_NODEPORT"; do
    echo "$used" | grep -qw "$p" && die "NodePort $p is already used by another namespace: $(echo "$used" | grep -w "$p" | cut -d' ' -f1)"
  done
  ok "NodePorts $APIM_MGMT_NODEPORT/$GATEWAY_HTTPS_NODEPORT/$GATEWAY_HTTP_NODEPORT/$MT_NODEPORT free"
fi

if [ "$ISOLATED" = 1 ]; then
  ok "DNS: test names are resolved by the smoke checks (curl --resolve); nothing to check"
else
  for d in "$WEAVE_DOMAIN" "$APIM_DOMAIN"; do
    ips=$(getent ahostsv4 "$d" | awk '{print $1}' | sort -u | tr '\n' ' ')
    if [ -z "$ips" ]; then
      [ "$SKIP_DNS" = 1 ] && warn "$d does not resolve (continuing: --skip-dns)" || die "$d does not resolve. Create an A record to this server ($HOST_IP), or pass --skip-dns"
    else
      echo " $(hostname -I) " | grep -q " ${ips%% *} " && ok "DNS $d -> $ips(this server)" || warn "DNS $d -> $ips(not an address of this server: fine if a load balancer / NAT forwards 443 here)"
    fi
  done
fi

if [ "$ISOLATED" = 1 ]; then
  ok "certificate: a self-signed test certificate for $WEAVE_DOMAIN / $APIM_DOMAIN is generated"
else
  check_cert(){ # cert key names...
    local c="$1" kf="$2"; shift 2
    [ -r "$c" ] || die "certificate file $c not readable (TLS_CERT_FILE in $CONFIG)"
    [ -r "$kf" ] || die "key file $kf not readable (TLS_KEY_FILE in $CONFIG)"
    openssl x509 -in "$c" -noout >/dev/null 2>&1 || die "$c is not a PEM certificate"
    grep -q ENCRYPTED "$kf" && die "$kf is encrypted; provide the key without a passphrase"
    [ "$(openssl x509 -in "$c" -noout -pubkey | openssl sha256)" = "$(openssl pkey -in "$kf" -pubout 2>/dev/null | openssl sha256)" ] \
      || die "key $kf does not belong to certificate $c"
    openssl x509 -in "$c" -noout -checkend 0 >/dev/null || die "certificate $c has expired ($(openssl x509 -in "$c" -noout -enddate))"
    openssl x509 -in "$c" -noout -checkend 2592000 >/dev/null || warn "certificate $c expires within 30 days ($(openssl x509 -in "$c" -noout -enddate | cut -d= -f2))"
    local n; for n in "$@"; do
      openssl x509 -in "$c" -noout -checkhost "$n" | grep -q "does match" || die "certificate $c does not cover $n (SAN: $(openssl x509 -in "$c" -noout -ext subjectAltName 2>/dev/null | tail -1 | xargs))"
    done
    if [ -n "${TLS_CA_FILE:-}" ]; then
      [ -r "$TLS_CA_FILE" ] || die "TLS_CA_FILE $TLS_CA_FILE not readable"
      openssl verify -CAfile "$TLS_CA_FILE" -untrusted "$c" "$c" >>"$LOG_FILE" 2>&1 \
        || die "certificate $c does not chain to the CA in $TLS_CA_FILE (openssl verify failed; see log)"
      ok "certificate $(basename "$c") chains to the CA in $(basename "$TLS_CA_FILE")"
    elif [ "$(grep -c 'BEGIN CERTIFICATE' "$c")" -lt 2 ]; then
      warn "$c holds a single certificate and no TLS_CA_FILE is set; browsers need the intermediate chain"
    fi
    ok "certificate $(basename "$c") matches its key and covers: $*; valid until $(openssl x509 -in "$c" -noout -enddate | cut -d= -f2)"
  }
  if [ -n "${APIM_TLS_CERT_FILE:-}" ]; then
    check_cert "$TLS_CERT_FILE" "$TLS_KEY_FILE" "$WEAVE_DOMAIN"
    check_cert "$APIM_TLS_CERT_FILE" "$APIM_TLS_KEY_FILE" "$APIM_DOMAIN"
  else
    check_cert "$TLS_CERT_FILE" "$TLS_KEY_FILE" "$WEAVE_DOMAIN" "$APIM_DOMAIN"
  fi
fi

# The server is expected to have NO internet. Nothing below ever downloads: the bundle is mandatory.
ONLINE=0; curl -sfI --max-time 5 https://get.k3s.io >/dev/null 2>&1 && ONLINE=1
[ "$ONLINE" = 1 ] && log "note: this server reaches the internet; the installer still uses only the bundle" \
                  || ok "no internet access detected (expected): offline installation from the bundle"
if [ -n "$BUNDLE" ]; then
  for f in images/docker/weave-gateway.tar images/docker/weave-factory.tar images/docker/weave-runtime.tar \
           images/docker/eclipse-temurin-21-jre-alpine.tar images/k8s/wso2am-4.5.0.tar images/k8s/postgres-16-alpine.tar \
           images/k8s/migration-tool.tar pkgs/postgresql-jdbc.jar platform/platform-seed.tgz platform/ballerina-repositories.tgz \
           bin/caddy bin/k3s bin/k3s-airgap-images-amd64.tar.zst bin/k3s-install.sh bin/helm bin/docker-static.tgz; do
    [ -s "$BUNDLE/$f" ] || die "bundle $BUNDLE is incomplete: $f missing"
  done
  if [ -f "$BUNDLE/SHA256SUMS" ] && [ ! -f "$STATE/bundle-$BUNDLE_VERSION.verified" ]; then
    log "verifying bundle checksums (once per bundle version)"
    (cd "$BUNDLE" && sha256sum --quiet -c SHA256SUMS >>"$LOG_FILE" 2>&1) || die "bundle checksum mismatch (see log); re-copy the bundle"
    mkdir -p "$STATE"; touch "$STATE/bundle-$BUNDLE_VERSION.verified"
  fi
  if [ "$ISOLATED" = 0 ]; then
    [ "$OS" = ubuntu ] && { ls "$BUNDLE"/pkgs/ballerina-*.deb >/dev/null 2>&1 || die "bundle has no Ballerina .deb (built with --os rhel?)"; }
    [ "$OS" = rhel ] && { ls "$BUNDLE"/pkgs/ballerina-*.rpm >/dev/null 2>&1 || die "bundle has no Ballerina .rpm (built with --os ubuntu?)"; }
  fi
  ok "offline bundle $BUNDLE_VERSION complete at $BUNDLE"
else
  die "no offline bundle (images/IMAGES). Extract weave-cruise-saudi-<version>.tar.gz and run install.sh from it, or pass --bundle DIR"
fi
command -v systemctl >/dev/null || die "systemd is required"
if [ "$PREFLIGHT_ONLY" = 1 ]; then echo; echo "Pre-flight checks passed. Nothing was changed."; exit 0; fi

# =================================================================================== layout
step "Directories, configuration, secrets"
mkdir -p "$ETC" "$DATA" "$BIN" "$STATE" "$DATA_ROOT/logs/apim" "$DATA_ROOT/logs/caddy" "$DATA_ROOT/apim-lib" "$PLATFORM_DIR" "$BACKUP_TARGET"
chmod 755 "$DATA_ROOT"; chmod 700 "$ETC" "$STATE"
if [ "$CONFIG" != "$ETC/weave.conf" ]; then cp "$CONFIG" "$ETC/weave.conf"; chmod 600 "$ETC/weave.conf"; fi
cs_secrets
ok "config $ETC/weave.conf, secrets $SECRETS (mode 600, generated once, never printed)"

mkdir -p "$ETC/tls"; chmod 700 "$ETC/tls"
if [ "$ISOLATED" = 1 ]; then
  if [ ! -s "$ETC/tls/test-ca.crt" ]; then
    run openssl req -x509 -newkey rsa:2048 -nodes -days 30 -subj "/CN=Weave isolated test CA" \
      -keyout "$ETC/tls/test-ca.key" -out "$ETC/tls/test-ca.crt"
    run openssl req -newkey rsa:2048 -nodes -subj "/CN=$WEAVE_DOMAIN" -keyout "$ETC/tls/weave.key" -out "$ETC/tls/weave.csr"
    printf 'subjectAltName=DNS:%s,DNS:%s\nextendedKeyUsage=serverAuth\n' "$WEAVE_DOMAIN" "$APIM_DOMAIN" >"$ETC/tls/ext.cnf"
    run openssl x509 -req -in "$ETC/tls/weave.csr" -CA "$ETC/tls/test-ca.crt" -CAkey "$ETC/tls/test-ca.key" -CAcreateserial \
      -days 30 -extfile "$ETC/tls/ext.cnf" -out "$ETC/tls/weave.crt"
  fi
  cp "$ETC/tls/weave.crt" "$ETC/tls/apim.crt"; cp "$ETC/tls/weave.key" "$ETC/tls/apim.key"
  install -m 644 "$ETC/tls/test-ca.crt" "$ETC/tls/customer-ca.pem"     # plays the role of TLS_CA_FILE
  ok "self-signed test certificate (test CA $ETC/tls/test-ca.crt used as the internal CA)"
else
  serve(){ # src-cert dest
    if [ -n "${TLS_CA_FILE:-}" ] && [ "$(grep -c 'BEGIN CERTIFICATE' "$1")" -lt 2 ]; then
      cat "$1" "$TLS_CA_FILE" >"$2"; log "$(basename "$2"): appended the CA chain from TLS_CA_FILE"
    else cat "$1" >"$2"; fi; chmod 644 "$2"; }
  serve "$TLS_CERT_FILE" "$ETC/tls/weave.crt"; install -m 600 "$TLS_KEY_FILE" "$ETC/tls/weave.key"
  serve "${APIM_TLS_CERT_FILE:-$TLS_CERT_FILE}" "$ETC/tls/apim.crt"; install -m 600 "${APIM_TLS_KEY_FILE:-$TLS_KEY_FILE}" "$ETC/tls/apim.key"
  if [ -n "${TLS_CA_FILE:-}" ]; then install -m 644 "$TLS_CA_FILE" "$ETC/tls/customer-ca.pem"; else : >"$ETC/tls/customer-ca.pem"; chmod 644 "$ETC/tls/customer-ca.pem"; fi
  ok "certificates copied to $ETC/tls"
fi
CURL_CA=(); [ -s "$ETC/tls/customer-ca.pem" ] && CURL_CA=(--cacert "$ETC/tls/customer-ca.pem")
# the internal CA becomes trusted by this host (docker push to an internal registry, curl, git) -
# production profile only; the test profile never changes the host's trust store
if [ "$ISOLATED" = 0 ] && [ -s "$ETC/tls/customer-ca.pem" ]; then
  if [ -d /usr/local/share/ca-certificates ]; then install -m 644 "$ETC/tls/customer-ca.pem" /usr/local/share/ca-certificates/weave-internal-ca.crt; run update-ca-certificates
  else install -m 644 "$ETC/tls/customer-ca.pem" /etc/pki/ca-trust/source/anchors/weave-internal-ca.pem; run update-ca-trust extract; fi
  ok "internal CA added to the host trust store"
fi

# =================================================================================== packages
step "Operating system prerequisites (no package downloads)"
if [ "$ISOLATED" = 0 ] && [ "$USE_OS_REPO" = 1 ]; then
  # only with --use-os-repo: the customer's INTERNAL mirror / Satellite, never the internet
  if [ "$OS" = ubuntu ]; then DEBIAN_FRONTEND=noninteractive run apt-get install -y -q $PKGS_UBUNTU || warn "apt-get install reported errors"
  else run dnf install -y $PKGS_RHEL || warn "dnf install reported errors"; fi
fi
if [ "$ISOLATED" = 0 ]; then
  systemctl enable --now "$( [ "$OS" = ubuntu ] && echo ssh || echo sshd )" >>"$LOG_FILE" 2>&1 || true
  systemctl enable --now "$( [ "$OS" = ubuntu ] && echo cron || echo crond )" >>"$LOG_FILE" 2>&1 || true
fi
if command -v python3.12 >/dev/null; then ok "python3.12 present ($(command -v python3.12))"
elif [ "$ISOLATED" = 1 ]; then die "test profile expects python3.12 on the host"
else
  # no python3.12 in the OS (e.g. minimal RHEL 9 without AppStream): standalone CPython from the bundle
  mkdir -p "$DATA_ROOT/python"; run tar xzf "$BUNDLE/pkgs/python-3.12-standalone.tgz" -C "$DATA_ROOT/python" --strip-components=1
  ln -sf "$DATA_ROOT/python/bin/python3.12" /usr/local/bin/python3.12
  python3.12 -c 'import ssl, sqlite3, json' >>"$LOG_FILE" 2>&1 || die "bundled python3.12 does not run"
  ok "python3.12 installed from the bundle ($DATA_ROOT/python, linked from /usr/local/bin/python3.12)"
fi
# the migration tool runs "python3" on this host: it must be 3.12 (RHEL 9's own python3 is 3.9;
# /usr/local/bin comes first in PATH, dnf keeps using /usr/bin/python3)
if ! python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 12) else 1)' 2>/dev/null; then
  [ "$ISOLATED" = 1 ] && die "test profile expects python3 >= 3.12"
  ln -sf "$(command -v python3.12)" /usr/local/bin/python3; ok "/usr/local/bin/python3 -> python3.12"
fi
ok "python3 is $(python3 -c 'import sys;print(sys.version.split()[0])'); the tools need only the standard library (no pip packages)"

# =================================================================================== docker
step "Docker"
if docker info >/dev/null 2>&1; then
  ok "Docker $(docker version --format '{{.Server.Version}}') already running"
elif [ "$ISOLATED" = 1 ]; then die "test profile expects Docker on the host"
else
  tgz="$BUNDLE/bin/docker-static.tgz"
  tmp=$(mktemp -d); tar xzf "$tgz" -C "$tmp"; install -m 755 "$tmp"/docker/* /usr/bin/; rm -rf "$tmp"
  getent group docker >/dev/null || groupadd -r docker
  cat >/etc/systemd/system/containerd.service <<'EOF'
[Unit]
Description=containerd (installed by Cruise Saudi Weave)
After=network.target
[Service]
ExecStartPre=-/sbin/modprobe overlay
ExecStart=/usr/bin/containerd
Restart=always
Delegate=yes
KillMode=process
LimitNOFILE=1048576
[Install]
WantedBy=multi-user.target
EOF
  cat >/etc/systemd/system/docker.service <<'EOF'
[Unit]
Description=Docker (installed by Cruise Saudi Weave)
After=network-online.target containerd.service
Wants=network-online.target
Requires=containerd.service
[Service]
ExecStart=/usr/bin/dockerd --containerd=/run/containerd/containerd.sock
Restart=always
LimitNOFILE=1048576
Delegate=yes
KillMode=process
[Install]
WantedBy=multi-user.target
EOF
  mkdir -p /etc/docker
  [ -f /etc/docker/daemon.json ] || echo '{"log-driver":"json-file","log-opts":{"max-size":"50m","max-file":"5"}}' >/etc/docker/daemon.json
  systemctl daemon-reload; run systemctl enable --now containerd docker
  for _ in $(seq 1 30); do docker info >/dev/null 2>&1 && break; sleep 2; done
  docker info >/dev/null 2>&1 || die "Docker did not start (journalctl -u docker)"
  ok "Docker $DOCKER_VERSION installed (static binaries + systemd units)"
fi

# =================================================================================== k3s
step "Kubernetes (k3s single node)"
if kubectl get nodes 2>/dev/null | grep -q ' Ready'; then
  ok "k3s already running: $(kubectl get nodes --no-headers | awk '{print $1" "$2" "$5}')"
elif [ "$ISOLATED" = 1 ]; then die "test profile expects a running k3s on the host"
else
  mkdir -p /var/lib/rancher/k3s/agent/images
  # airgap: system images (pause, coredns, local-path, metrics) from the bundle, binary from the bundle
  cp "$BUNDLE/bin/k3s-airgap-images-amd64.tar.zst" /var/lib/rancher/k3s/agent/images/
  install -m 755 "$BUNDLE/bin/k3s" /usr/local/bin/k3s
  inst="$BUNDLE/bin/k3s-install.sh"
  if [ "$OS" = rhel ] && ! rpm -q k3s-selinux >/dev/null 2>&1; then
    if rpm -q container-selinux >/dev/null 2>&1 && [ -s "$BUNDLE/pkgs/k3s-selinux.el9.noarch.rpm" ]; then
      run rpm -i "$BUNDLE/pkgs/k3s-selinux.el9.noarch.rpm" && ok "k3s-selinux policy installed from the bundle" || warn "k3s-selinux did not install"
    elif [ "$(getenforce 2>/dev/null)" = Enforcing ]; then
      die "SELinux is enforcing but container-selinux is missing: install container-selinux from your internal RHEL repository (or --use-os-repo) and re-run"
    fi
  fi
  # traefik + servicelb off: Caddy owns 80/443; the gateway is a NodePort. No download, no repo access.
  run env INSTALL_K3S_SKIP_DOWNLOAD=true INSTALL_K3S_SKIP_SELINUX_RPM=true INSTALL_K3S_SELINUX_WARN=true INSTALL_K3S_VERSION="$K3S_VERSION" \
    INSTALL_K3S_EXEC="server --disable traefik --disable servicelb --write-kubeconfig-mode 600" sh "$inst" \
    || die "k3s installation failed"
  for _ in $(seq 1 90); do kubectl get nodes 2>/dev/null | grep -q ' Ready' && break; sleep 2; done
  kubectl get nodes 2>/dev/null | grep -q ' Ready' || die "k3s node did not become Ready (journalctl -u k3s)"
  mkdir -p /root/.kube; install -m 600 /etc/rancher/k3s/k3s.yaml /root/.kube/config
  ok "k3s $K3S_VERSION installed, node Ready"
fi
for _ in $(seq 1 60); do [ -n "$(cni_ip)" ] && break; sleep 2; done
CNI_IP="$(cni_ip)"; [ -n "$CNI_IP" ] || die "no cni0 address (k3s networking not up)"
CLUSTER_DNS="$(kubectl -n kube-system get svc kube-dns -o jsonpath='{.spec.clusterIP}' 2>/dev/null || echo 10.43.0.10)"
ok "pod network gateway $CNI_IP, cluster DNS $CLUSTER_DNS"

# =================================================================================== toolchain
step "Build toolchain: helm, kubectl, Ballerina $BAL_VERSION, Caddy"
if command -v helm >/dev/null; then ok "helm $(helm version --short 2>/dev/null) present"
elif [ "$ISOLATED" = 1 ]; then die "test profile expects helm on the host"
else
  install -m 755 "$BUNDLE/bin/helm" /usr/local/bin/helm
  ok "helm $HELM_VERSION installed"
fi
command -v kubectl >/dev/null || ln -sf /usr/local/bin/k3s /usr/local/bin/kubectl
ok "kubectl $(kubectl version --client -o yaml 2>/dev/null | awk '/gitVersion/ {print $2; exit}')"
if command -v bal >/dev/null && bal version 2>/dev/null | grep -q "$BAL_VERSION"; then ok "Ballerina $BAL_VERSION present ($(readlink -f "$(command -v bal)"))"
elif [ "$ISOLATED" = 1 ]; then die "test profile expects Ballerina $BAL_VERSION on the host"
else
  if [ "$OS" = ubuntu ]; then run dpkg -i "$(ls "$BUNDLE"/pkgs/ballerina-*.deb | head -1)" || die "Ballerina package install failed"
  else run rpm -Uvh --replacepkgs "$(ls "$BUNDLE"/pkgs/ballerina-*.rpm | head -1)" || die "Ballerina package install failed"; fi
  bal version 2>/dev/null | grep -q "$BAL_VERSION" || die "bal does not report $BAL_VERSION after install"
  ok "Ballerina $BAL_VERSION installed (bundled JRE 21)"
fi
# Ballerina package cache (Central libraries every generated service imports): the migration tool
# builds as root on this host, so it goes to /root/.ballerina; merged, never deleting what is there.
if [ "$ISOLATED" = 0 ]; then
  mkdir -p /root/.ballerina; run tar xzf "$BUNDLE/platform/ballerina-repositories.tgz" -C /root/.ballerina --skip-old-files
  ok "Ballerina package cache unpacked into /root/.ballerina/repositories (bal build --offline)"
else
  ok "test profile: host Ballerina cache left as is (the offline build is proven by build-bundle.sh, platform/OFFLINE-BUILD-PROOF.txt)"
fi
install -m 755 "$BUNDLE/bin/caddy" "$BIN/caddy"
ok "caddy $("$BIN/caddy" version | awk '{print $1}') at $BIN/caddy (own copy; the OS caddy package is not used)"

# =================================================================================== images
step "Container images from the bundle"
for f in "$BUNDLE"/images/docker/*.tar; do
  ref=$(tar -xOf "$f" manifest.json 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin)[0]["RepoTags"][0])' 2>/dev/null || echo "")
  if [ -n "$ref" ] && [[ "$ref" != cruise-saudi/* ]] && docker image inspect "$ref" >/dev/null 2>&1; then ok "docker: $ref already present"; continue; fi
  run docker load -i "$f" || die "docker load $f failed"; ok "docker: loaded ${ref:-$(basename "$f")}"
done
have_k8s(){ k3s ctr -n k8s.io images ls -q 2>/dev/null | grep -qx "$1"; }
for f in "$BUNDLE"/images/k8s/*.tar; do
  ref=$(tar -xOf "$f" manifest.json 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin)[0]["RepoTags"][0])' 2>/dev/null || echo "")
  full="$ref"; case "$full" in */*/*) ;; */*) full="docker.io/$full";; ?*) full="docker.io/library/$full";; esac
  if [ -n "$ref" ] && [[ "$ref" != cruise-saudi/* ]] && have_k8s "$full"; then ok "k3s: $full already present"; continue; fi
  run k3s ctr -n k8s.io images import "$f" || die "k3s image import $f failed"; ok "k3s: imported ${full:-$(basename "$f")}"
done
have_k8s "docker.io/$IMG_MT" || die "migration tool image docker.io/$IMG_MT not in k3s after import"

# =================================================================================== platform
step "Code generator workspace ($PLATFORM_DIR)"
if [ ! -d "$PLATFORM_DIR/migration-factory" ]; then
  run tar xzf "$BUNDLE/platform/platform-seed.tgz" -C "$PLATFORM_DIR"
  ok "migration-factory, framework, chart and Dockerfile unpacked"
else ok "workspace present (code refreshed only by upgrade.sh)"; fi
[ -f "$PLATFORM_DIR/Ballerina.toml" ] || cp "$BUNDLE/platform/Ballerina.toml" "$PLATFORM_DIR/Ballerina.toml"
mkdir -p "$PLATFORM_DIR/services"
(cd "$PLATFORM_DIR/migration-factory" && python3.12 -s -c 'import factory' ) >>"$LOG_FILE" 2>&1 \
  && ok "code generator imports under Python 3.12" || die "migration-factory does not import with python3.12 (see log)"

# =================================================================================== k8s base
step "Kubernetes namespaces, secrets, access"
for ns in "$NS_APIM" "$NS_WEAVE" "$NS_SERVICES"; do
  kubectl create ns "$ns" --dry-run=client -o yaml | kubectl label --local -f - app.kubernetes.io/part-of=cruise-saudi-weave -o yaml | kubectl apply -f - >>"$LOG_FILE"
done
kubectl -n "$NS_APIM" create secret generic apim-db --from-literal=superuser-password="$PG_SUPERUSER_PASSWORD" \
  --from-literal=apim-password="$APIM_DB_PASSWORD" --from-literal=keystore-password="$APIM_KEYSTORE_PASSWORD" \
  --dry-run=client -o yaml | kubectl apply -f - >>"$LOG_FILE"
kubectl -n "$NS_WEAVE" create secret generic mt-admin --from-literal=token="$MT_ADMIN_TOKEN" --dry-run=client -o yaml | kubectl apply -f - >>"$LOG_FILE"
mkdir -p "$ETC/mt-ssh"; chmod 700 "$ETC/mt-ssh"
[ -f "$ETC/mt-ssh/id_ed25519" ] || run ssh-keygen -q -t ed25519 -N "" -f "$ETC/mt-ssh/id_ed25519" -C "weave-migration-tool:${PREFIX%-}"
mkdir -p /root/.ssh; chmod 700 /root/.ssh; touch /root/.ssh/authorized_keys; chmod 600 /root/.ssh/authorized_keys
grep -qF "$(cut -d' ' -f2 "$ETC/mt-ssh/id_ed25519.pub")" /root/.ssh/authorized_keys || cat "$ETC/mt-ssh/id_ed25519.pub" >>/root/.ssh/authorized_keys
kubectl -n "$NS_WEAVE" create secret generic mt-ssh --from-file=id_ed25519="$ETC/mt-ssh/id_ed25519" --dry-run=client -o yaml | kubectl apply -f - >>"$LOG_FILE"
render "$CS_DIR/manifests/weave-rbac.yaml" "$STATE/weave-rbac.yaml"; kubectl apply -f "$STATE/weave-rbac.yaml" >>"$LOG_FILE"
for _ in $(seq 1 30); do tok=$(kubectl -n "$NS_WEAVE" get secret weave-reader-token -o jsonpath='{.data.token}' 2>/dev/null); [ -n "$tok" ] && break; sleep 1; done
[ -n "$tok" ] || die "service account token was not issued"
mkdir -p "$ETC/k8s"; echo "$tok" | base64 -d >"$ETC/k8s/token"
kubectl -n "$NS_WEAVE" get secret weave-reader-token -o jsonpath='{.data.ca\.crt}' | base64 -d >"$ETC/k8s/ca.crt"
chown -R root:1000 "$ETC/k8s"; chmod 750 "$ETC/k8s"; chmod 640 "$ETC/k8s/token" "$ETC/k8s/ca.crt"
kubectl -n "$NS_APIM" create configmap apim-log4j2 --from-file=log4j2.properties="$CS_DIR/templates/apim-log4j2.properties" --dry-run=client -o yaml | kubectl apply -f - >>"$LOG_FILE"
ok "namespaces $NS_APIM, $NS_WEAVE, $NS_SERVICES; secrets; service account weave-reader (token in $ETC/k8s)"

# =================================================================================== postgres
step "PostgreSQL for API Manager"
mkdir -p "$DATA/postgres"
render "$CS_DIR/manifests/postgres.yaml" "$STATE/postgres.yaml"
kubectl apply -f "$STATE/postgres.yaml" >>"$LOG_FILE" || die "applying PostgreSQL manifests failed"
kubectl -n "$NS_APIM" rollout status deploy/apim-postgres --timeout=300s >>"$LOG_FILE" 2>&1 || { kubectl -n "$NS_APIM" describe pod -l app=apim-postgres | tail -20 >>"$LOG_FILE"; die "PostgreSQL did not become ready"; }
ok "PostgreSQL ready (data $DATA/postgres)"
kubectl -n "$NS_APIM" delete job apim-dbinit --ignore-not-found >>"$LOG_FILE" 2>&1
render "$CS_DIR/manifests/apim-dbinit.yaml" "$STATE/apim-dbinit.yaml"; kubectl apply -f "$STATE/apim-dbinit.yaml" >>"$LOG_FILE"
if ! kubectl -n "$NS_APIM" wait --for=condition=complete job/apim-dbinit --timeout=600s >>"$LOG_FILE" 2>&1; then
  kubectl -n "$NS_APIM" logs job/apim-dbinit --all-containers --tail=40 >>"$LOG_FILE" 2>&1 || true
  die "API Manager database schema job failed (kubectl -n $NS_APIM logs job/apim-dbinit)"
fi
kubectl -n "$NS_APIM" logs job/apim-dbinit -c psql 2>/dev/null | tee -a "$LOG_FILE" | sed 's/^/    | /'
ok "API Manager schema in apim_db and shared_db"

# =================================================================================== APIM
step "WSO2 API Manager 4.5.0"
install -m 644 "$BUNDLE/pkgs/postgresql-jdbc.jar" "$DATA_ROOT/apim-lib/postgresql-jdbc.jar"
APIM_STARTUP_FAILURES=$(( APIM_STARTUP_MINUTES * 6 - 3 ))
( umask 077; render "$CS_DIR/templates/apim-deployment.toml" "$STATE/deployment.toml.tmp" ) || die "rendering deployment.toml failed"
kubectl -n "$NS_APIM" create secret generic apim-conf --from-file=deployment.toml="$STATE/deployment.toml.tmp" --dry-run=client -o yaml | kubectl apply -f - >>"$LOG_FILE"
APIM_CONF_HASH=$( (cat "$STATE/deployment.toml.tmp" "$CS_DIR/templates/apim-log4j2.properties") | sha256sum | cut -c1-16)
rm -f "$STATE/deployment.toml.tmp"
render "$CS_DIR/manifests/apim.yaml" "$STATE/apim.yaml"
if ! kubectl -n "$NS_APIM" get deploy wso2am >/dev/null 2>&1 || ! kubectl -n "$NS_APIM" get deploy wso2am -o yaml | grep -q "$APIM_CONF_HASH"; then
  AVAIL_GB=$(awk '/MemAvailable/ {print int($2/1048576)}' /proc/meminfo)
  if [ "$ISOLATED" = 1 ] && [ "$AVAIL_GB" -lt 10 ]; then
    echo "NOT starting API Manager: only $AVAIL_GB GB memory available (the test needs 10 GB). Everything before this step is installed." | tee -a "$LOG_FILE" >&2
    exit 3
  fi
fi
mkdir -p "$DATA/apim"
kubectl apply -f "$STATE/apim.yaml" >>"$LOG_FILE" || die "applying API Manager manifests failed"
log "waiting for API Manager (first boot takes 3-$APIM_STARTUP_MINUTES minutes)"
t0=$(date +%s)
if ! kubectl -n "$NS_APIM" rollout status deploy/wso2am --timeout=$(( APIM_STARTUP_MINUTES * 60 + 300 ))s >>"$LOG_FILE" 2>&1; then
  kubectl -n "$NS_APIM" describe pod -l app=wso2am | tail -30 >>"$LOG_FILE" 2>&1
  kubectl -n "$NS_APIM" logs deploy/wso2am --tail=80 >>"$LOG_FILE" 2>&1 || true
  die "API Manager did not become ready (kubectl -n $NS_APIM logs deploy/wso2am; $DATA_ROOT/logs/apim/wso2carbon.log)"
fi
ok "API Manager ready after $(( $(date +%s) - t0 ))s"
pem=$(echo | openssl s_client -connect "127.0.0.1:$APIM_MGMT_NODEPORT" -servername localhost 2>/dev/null | openssl x509 2>/dev/null) || true
[ -n "$pem" ] || die "could not read the API Manager certificate on port $APIM_MGMT_NODEPORT"
echo "$pem" >"$ETC/apim-ca.pem"; chmod 644 "$ETC/apim-ca.pem"
openssl x509 -in "$ETC/apim-ca.pem" -noout -subject | grep -q "O *= *Cruise Saudi" || die "API Manager still serves the public default key pair"
ok "API Manager uses this installation's own key pair ($ETC/apim-ca.pem)"
# trust for internal HTTPS calls made by the Weave services and the migration tool:
#   extra-ca.pem = internal CA (TLS_CA_FILE) + API Manager's own certificate  -> NODE_EXTRA_CA_CERTS
#   ca-bundle.pem = the OS public bundle + extra-ca.pem                         -> SSL_CERT_FILE (Python)
cat "$ETC/tls/customer-ca.pem" "$ETC/apim-ca.pem" >"$ETC/extra-ca.pem"; chmod 644 "$ETC/extra-ca.pem"
sysbundle=/etc/ssl/certs/ca-certificates.crt; [ -s "$sysbundle" ] || sysbundle=/etc/pki/tls/certs/ca-bundle.crt
cat "$sysbundle" "$ETC/extra-ca.pem" >"$ETC/ca-bundle.pem"; chmod 644 "$ETC/ca-bundle.pem"
kubectl -n "$NS_WEAVE" create configmap weave-ca-trust --from-file=ca-bundle.pem="$ETC/ca-bundle.pem" --dry-run=client -o yaml | kubectl apply -f - >>"$LOG_FILE"
ok "CA trust for internal HTTPS: $(grep -c 'BEGIN CERTIFICATE' "$ETC/extra-ca.pem") extra certificate(s) ($ETC/extra-ca.pem)"
code=$(curl -s -o /dev/null -w '%{http_code}' --cacert "$ETC/apim-ca.pem" -u "$APIM_ADMIN_USER:$APIM_ADMIN_PASSWORD" \
  "https://localhost:$APIM_MGMT_NODEPORT/api/am/admin/v4/environments" || true)
[ "$code" = 200 ] || [ "$code" = 401 ] || [ "$code" = 403 ] || die "API Manager admin API answered $code"
code=$(curl -s -o /dev/null -w '%{http_code}' --cacert "$ETC/apim-ca.pem" -u "$APIM_ADMIN_USER:$APIM_ADMIN_PASSWORD" -H 'Content-Type: application/json' \
  -d '{"callbackUrl":"https://localhost/cb","clientName":"weave-install-check","owner":"'"$APIM_ADMIN_USER"'","grantType":"client_credentials","saasApp":true}' \
  "https://localhost:$APIM_MGMT_NODEPORT/client-registration/v0.17/register" || true)
case "$code" in 200|201) ok "administrator '$APIM_ADMIN_USER' signs in with the generated password (the default admin/admin is not used)";;
  *) die "API Manager rejected the generated administrator password (client registration answered $code)";; esac
code=$(curl -s -o /dev/null -w '%{http_code}' --cacert "$ETC/apim-ca.pem" -u admin:admin -H 'Content-Type: application/json' \
  -d '{"callbackUrl":"https://localhost/cb","clientName":"weave-install-check2","owner":"admin","grantType":"client_credentials","saasApp":true}' \
  "https://localhost:$APIM_MGMT_NODEPORT/client-registration/v0.17/register" || true)
case "$code" in 200|201) die "API Manager accepts admin/admin - refusing to continue";; *) ok "admin/admin is refused ($code)";; esac

# =================================================================================== migration tool
step "Migration tool (control plane)"
mkdir -p "$DATA/migration-tool"
MT_SSH_TARGET="root@$HOST_IP"
render "$CS_DIR/manifests/migration-tool.yaml" "$STATE/migration-tool.yaml"
kubectl apply -f "$STATE/migration-tool.yaml" >>"$LOG_FILE" || die "applying migration tool manifests failed"
kubectl -n "$NS_WEAVE" rollout status deploy/migration-tool --timeout=240s >>"$LOG_FILE" 2>&1 || die "migration tool did not become ready (kubectl -n $NS_WEAVE logs deploy/migration-tool)"
c=$(wait_http "http://127.0.0.1:$MT_NODEPORT/api/health" 200 20) || die "migration tool /api/health answered $c"
ok "migration tool ready on NodePort $MT_NODEPORT (drives this host as $MT_SSH_TARGET, workspace $PLATFORM_DIR)"

# =================================================================================== weave
step "Weave containers (gateway console, factory, flow runtime)"
for d in gateway factory runtime; do mkdir -p "$DATA/$d"; chown 1000:1000 "$DATA/$d"; done
umask 077
if [ -n "${DEPLOY_TARGET_KUBECONFIG:-}" ]; then
  [ -r "$DEPLOY_TARGET_KUBECONFIG" ] || die "DEPLOY_TARGET_KUBECONFIG $DEPLOY_TARGET_KUBECONFIG not readable"
  mkdir -p "$ETC/target"; install -m 640 -g 1000 "$DEPLOY_TARGET_KUBECONFIG" "$ETC/target/kubeconfig"
  [ -n "${DEPLOY_TARGET_REGISTRY_PASSWORD_FILE:-}" ] && install -m 640 -g 1000 "$DEPLOY_TARGET_REGISTRY_PASSWORD_FILE" "$ETC/target/registry-password"
  chgrp 1000 "$ETC/target"; chmod 750 "$ETC/target"
elif [ -d "$ETC/target" ]; then rm -rf "$ETC/target"
fi
# ---- users and access (docs/CRUISE-SAUDI-SSO.md): shared users file, sign-in providers, first admin
# $DATA/access: users.json + audit.jsonl, read-write for uid 1000 in BOTH consoles (/data/access)
mkdir -p "$DATA/access"; chown 1000:1000 "$DATA/access"; chmod 700 "$DATA/access"
# $ETC/access: files the containers read (owner 1000, mode 400): first admin's password, OIDC client secret
mkdir -p "$ETC/access"; chown root:1000 "$ETC/access"; chmod 750 "$ETC/access"
printf '%s' "$WEAVE_BOOTSTRAP_PASSWORD" >"$ETC/access/bootstrap-password"
chown 1000:1000 "$ETC/access/bootstrap-password"; chmod 400 "$ETC/access/bootstrap-password"
AUTH_EFFECTIVE=""
for p in $(echo "$AUTH_PROVIDER" | tr ',' ' ' | tr 'A-Z' 'a-z'); do
  case "$p" in
    apim) p=wso2;;
    local|wso2) ;;
    oidc)
      if [ -z "${OIDC_ISSUER:-}" ] || [ -z "${OIDC_CLIENT_ID:-}" ] || [ -z "${OIDC_CLIENT_SECRET_FILE:-}" ]; then
        warn "AUTH_PROVIDER lists oidc but OIDC_ISSUER / OIDC_CLIENT_ID / OIDC_CLIENT_SECRET_FILE are not all set: Microsoft sign-in stays off until they are (re-run install.sh)"
        continue
      fi
      [ -r "$OIDC_CLIENT_SECRET_FILE" ] || die "OIDC_CLIENT_SECRET_FILE $OIDC_CLIENT_SECRET_FILE not readable"
      install -m 400 -o 1000 -g 1000 "$OIDC_CLIENT_SECRET_FILE" "$ETC/access/oidc-client-secret";;
    *) die "AUTH_PROVIDER: unknown provider '$p' (use local, oidc, wso2)";;
  esac
  case ",$AUTH_EFFECTIVE," in *",$p,"*) ;; *) AUTH_EFFECTIVE="${AUTH_EFFECTIVE:+$AUTH_EFFECTIVE,}$p";; esac
done
[ -n "$AUTH_EFFECTIVE" ] || AUTH_EFFECTIVE=local
[[ ",$AUTH_EFFECTIVE," == *",oidc,"* ]] || rm -f "$ETC/access/oidc-client-secret"
case ",$AUTH_EFFECTIVE," in *",local,"*) ;; *) warn "AUTH_PROVIDER has no 'local': there is no break-glass sign-in when Microsoft is unreachable";; esac
ok "sign-in providers: $AUTH_EFFECTIVE; users file $DATA/access/users.json (shared by both consoles)"
common_env(){ cat <<EOF
APIM_BASE_URL=https://localhost:$APIM_MGMT_NODEPORT
APIM_PUBLIC_URL=$APIM_URL
APIM_CA_CERT_PATH=/etc/weave/apim-ca.pem
NODE_EXTRA_CA_CERTS=/etc/weave/extra-ca.pem
HTTPS_PROXY=$CONF_HTTPS_PROXY
NO_PROXY=$CONF_NO_PROXY
APIM_DCR_USERNAME=$APIM_ADMIN_USER
APIM_DCR_PASSWORD=$APIM_ADMIN_PASSWORD
RUNTIME_INTERNAL_KEY=$RUNTIME_INTERNAL_KEY
GATEWAY_PUBLIC_URL=$GATEWAY_PUBLIC_URL
EOF
}
sso_env(){ # $1 = public base URL of the app (its OIDC redirect URI is <base>/api/auth/callback)
  cat <<EOF
WEAVE_EDITION=cruise-saudi
AUTH_PROVIDER=$AUTH_EFFECTIVE
AUTH_SESSION_HOURS=$AUTH_SESSION_HOURS
WEAVE_USERS_FILE=/data/access/users.json
WEAVE_AUDIT_FILE=/data/access/audit.jsonl
WSO2_DEFAULT_ROLES=
WEAVE_BOOTSTRAP_ADMIN=$WEAVE_ADMIN_EMAIL
WEAVE_BOOTSTRAP_NAME=$WEAVE_ADMIN_NAME
WEAVE_BOOTSTRAP_PROVIDER=local
WEAVE_BOOTSTRAP_PASSWORD_FILE=/run/weave-access/bootstrap-password
EOF
  if [[ ",$AUTH_EFFECTIVE," == *",oidc,"* ]]; then cat <<EOF
OIDC_ISSUER=$OIDC_ISSUER
OIDC_CLIENT_ID=$OIDC_CLIENT_ID
OIDC_CLIENT_SECRET_FILE=/run/weave-access/oidc-client-secret
OIDC_REDIRECT_URI=$1/api/auth/callback
OIDC_SCOPES=${OIDC_SCOPES:-openid profile email}
OIDC_GROUPS_CLAIM=$OIDC_GROUPS_CLAIM
OIDC_LABEL=${OIDC_LABEL:-Sign in with Microsoft}
OIDC_HTTPS_PROXY=${OIDC_HTTPS_PROXY:-}
EOF
  fi
}
k8s_env(){ cat <<EOF
K8S_API_URL=https://127.0.0.1:6443
K8S_TOKEN_FILE=/etc/weave/k8s/token
K8S_CA_FILE=/etc/weave/k8s/ca.crt
K8S_NAMESPACE=$NS_SERVICES
EOF
}
target_env(){ [ -n "${DEPLOY_TARGET_KUBECONFIG:-}" ] && echo "DEPLOY_TARGET_KUBECONFIG=/etc/weave/target/kubeconfig" || echo "DEPLOY_TARGET_KUBECONFIG="
  cat <<EOF
DEPLOY_TARGET_CONTEXT=${DEPLOY_TARGET_CONTEXT:-}
DEPLOY_TARGET_NAMESPACE=${DEPLOY_TARGET_NAMESPACE:-}
DEPLOY_TARGET_REGISTRY=${DEPLOY_TARGET_REGISTRY:-}
DEPLOY_TARGET_REGISTRY_USER=${DEPLOY_TARGET_REGISTRY_USER:-}
DEPLOY_TARGET_REGISTRY_PASSWORD_FILE=$([ -n "${DEPLOY_TARGET_REGISTRY_PASSWORD_FILE:-}" ] && echo /etc/weave/target/registry-password)
EOF
}
{ echo "# generated by install.sh - edit weave.conf and re-run install.sh"
  echo "HOST=127.0.0.1"; echo "PORT=$PORT_GATEWAY"; echo "PUBLIC_BASE_URL=$WEAVE_URL"
  echo "SESSION_SECRET=$GATEWAY_SESSION_SECRET"; echo "DATA_DIR=/app/apps/gateway-admin-bff/.data"
  echo "SPA_DIR=/app/apps/gateway-admin/dist"; echo "RUNTIME_URL=http://127.0.0.1:$PORT_RUNTIME"
  echo "MIGRATION_TOOL_URL=http://127.0.0.1:$MT_NODEPORT"
  echo "GATEWAY_NAMESPACE=$NS_APIM"; echo "GATEWAY_POD_PREFIX=wso2am"
  echo "APIM_LOG_DIR=/var/log/weave/apim"; echo "SERVICES_DIR=/estate/services"
  common_env; k8s_env; sso_env "$WEAVE_URL"; } >"$ETC/gateway.env"
{ echo "# generated by install.sh - edit weave.conf and re-run install.sh"
  echo "HOST=127.0.0.1"; echo "PORT=$PORT_FACTORY"; echo "PUBLIC_BASE_URL=$WEAVE_URL/factory"
  echo "SESSION_SECRET=$FACTORY_SESSION_SECRET"; echo "DATA_DIR=/app/apps/weave-factory-bff/.data"
  echo "SPA_DIR=/app/apps/weave-factory/dist"
  echo "MT_BASE_URL=http://127.0.0.1:$MT_NODEPORT"; echo "MT_ADMIN_TOKEN=$MT_ADMIN_TOKEN"
  echo "RUNTIME_URL=http://127.0.0.1:$PORT_RUNTIME"; echo "SERVICES_DIR=/estate/services"
  echo "APIM_METRICS_LOG=/var/log/weave/apim/apim_metrics.log"
  common_env; k8s_env; sso_env "$WEAVE_URL/factory"; target_env; } >"$ETC/factory.env"
{ echo "# generated by install.sh - edit weave.conf and re-run install.sh"
  echo "PORT=$PORT_RUNTIME"; echo "BIND=127.0.0.1,$CNI_IP"; echo "DATA_DIR=/data"; echo "SECRET_KEY_FILE=/data/secret.key"
  echo "CLUSTER_DNS=$CLUSTER_DNS"; echo "GATEWAY_BACKEND_URL=http://$CNI_IP:$PORT_RUNTIME"
  common_env; } >"$ETC/runtime.env"
umask 022
chmod 600 "$ETC"/gateway.env "$ETC"/factory.env "$ETC"/runtime.env

for comp in runtime gateway factory; do
  img_var="IMG_${comp^^}"; weave_start "$comp" "${!img_var}" || die "could not start $PREFIX$comp"
  weave_healthy "$comp" || die "$PREFIX$comp not healthy (docker logs $PREFIX$comp)"
  ok "$PREFIX$comp healthy on 127.0.0.1:$(weave_port "$comp") (${!img_var})"
done
step "Local code model (optional, self-hosted; no cloud AI)"
gguf=$(ls "$BUNDLE"/model/*.gguf 2>/dev/null | head -1 || true)
if [ -z "$gguf" ]; then ok "bundle built without --with-model: no local model (the code-change assistant reports it as unavailable)"
elif [ "$ISOLATED" = 1 ]; then ok "test profile: local model not started (port 8099 belongs to the host's own model)"
else
  mkdir -p /opt/weave-model
  if ! (cd "$BUNDLE/model" && sha256sum --quiet -c model.sha256 >/dev/null 2>&1) ; then die "model file checksum mismatch in the bundle"; fi
  [ -s "/opt/weave-model/$(basename "$gguf")" ] && cmp -s "$gguf" "/opt/weave-model/$(basename "$gguf")" || cp "$gguf" /opt/weave-model/
  chown -R 64999:64999 /opt/weave-model; chmod 750 /opt/weave-model
  run docker load -i "$BUNDLE/images/model/llama-cpp-server.tar" || die "loading the llama.cpp image failed"
  limg=$(grep ^model= "$BUNDLE/images/IMAGES" | cut -d= -f2)
  docker rm -f "${PREFIX}change-model" >/dev/null 2>&1 || true
  run docker run -d --name "${PREFIX}change-model" --network host --restart unless-stopped --user 64999:64999 --cpus 4 --memory 7g \
    --label app.kubernetes.io/part-of=cruise-saudi-weave -v /opt/weave-model:/models:ro "$limg" \
    -m "/models/$(basename "$gguf")" --host 127.0.0.1 --port 8099 -t 4 --poll 0 -c 12288 --no-webui || die "could not start the local model"
  c=$(wait_http http://127.0.0.1:8099/health 200 60) && ok "local model $(basename "$gguf") serving on 127.0.0.1:8099" || die "local model not healthy (/health answered $c; docker logs ${PREFIX}change-model)"
fi

echo "$BUNDLE_VERSION" >"$STATE/weave-version"; echo "$BUNDLE" >"$STATE/bundle-path"
printf 'gateway=%s\nfactory=%s\nruntime=%s\nmigration_tool=%s\n' "$IMG_GATEWAY" "$IMG_FACTORY" "$IMG_RUNTIME" "$IMG_MT" >"$STATE/images.current"

# =================================================================================== caddy
step "Reverse proxy (Caddy) on port $HTTPS_PORT with the provided certificate"
CADDY_BIND_LINE=""; [ -n "$CADDY_BIND" ] && CADDY_BIND_LINE="	bind $CADDY_BIND"
GW_BLOCK=""
if [ "$ENABLE_GW_PATH" = yes ]; then GW_BLOCK="	# API gateway: /gw/<context>/<version>/... -> gateway HTTPS (NodePort $GATEWAY_HTTPS_NODEPORT)
	handle_path /gw/* {
		reverse_proxy https://127.0.0.1:$GATEWAY_HTTPS_NODEPORT {
			header_up Host {upstream_hostport}
			transport http {
				tls_server_name localhost
				tls_trust_pool file $ETC/apim-ca.pem
			}
		}
	}"; fi
mkdir -p "$DATA/caddy"
render "$CS_DIR/templates/Caddyfile" "$ETC/Caddyfile.new"
"$BIN/caddy" validate --config "$ETC/Caddyfile.new" --adapter caddyfile >>"$LOG_FILE" 2>&1 || die "Caddyfile does not validate (see log; $ETC/Caddyfile.new)"
mv "$ETC/Caddyfile.new" "$ETC/Caddyfile"
QUOTA=""; [ "$ISOLATED" = 1 ] && QUOTA="CPUQuota=50%"
cat >"/etc/systemd/system/$CADDY_UNIT.service" <<EOF
[Unit]
Description=Cruise Saudi Weave reverse proxy ($DATA_ROOT)
After=network-online.target docker.service k3s.service
Wants=network-online.target
[Service]
Environment=XDG_DATA_HOME=$DATA/caddy XDG_CONFIG_HOME=$DATA/caddy HOME=$DATA/caddy
ExecStart=$BIN/caddy run --config $ETC/Caddyfile --adapter caddyfile
Restart=always
RestartSec=3
LimitNOFILE=1048576
AmbientCapabilities=CAP_NET_BIND_SERVICE
$QUOTA
[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
run systemctl enable "$CADDY_UNIT"; run systemctl restart "$CADDY_UNIT"
for _ in $(seq 1 20); do ss -Hltn "sport = :$HTTPS_PORT" | grep -q . && break; sleep 1; done
systemctl is-active -q "$CADDY_UNIT" || die "$CADDY_UNIT did not start (journalctl -u $CADDY_UNIT)"
ok "$CADDY_UNIT active: $WEAVE_URL -> console/factory, $APIM_URL -> API Manager"

# =================================================================================== backups
step "Operator scripts and backup schedule"
# keep the scripts at a stable path (cron, upgrade, uninstall): <DATA_ROOT>/installer
if [ "$CS_DIR" != "$DATA_ROOT/installer" ]; then rm -rf "$DATA_ROOT/installer.new"; mkdir -p "$DATA_ROOT/installer.new"
  cp -a "$CS_DIR"/*.sh "$CS_DIR"/lib "$CS_DIR"/manifests "$CS_DIR"/templates "$CS_DIR"/*.md "$CS_DIR"/weave.conf.example "$DATA_ROOT/installer.new/"
  rm -rf "$DATA_ROOT/installer"; mv "$DATA_ROOT/installer.new" "$DATA_ROOT/installer"; fi
ok "scripts in $DATA_ROOT/installer"
if [ "$ISOLATED" = 1 ]; then ok "test profile: no schedule (run backup.sh --isolated-test by hand)"
elif [ -n "${BACKUP_SCHEDULE:-}" ]; then
  echo "$BACKUP_SCHEDULE root $DATA_ROOT/installer/backup.sh --config $ETC/weave.conf >>$DATA_ROOT/logs/backup.log 2>&1" >/etc/cron.d/weave-backup
  chmod 644 /etc/cron.d/weave-backup; ok "nightly backup: '$BACKUP_SCHEDULE' -> $BACKUP_TARGET (keep $BACKUP_RETENTION_DAYS days)"
else ok "no schedule (BACKUP_SCHEDULE empty)"; fi

# =================================================================================== smoke
step "Smoke checks"
R=(--resolve "$WEAVE_DOMAIN:$HTTPS_PORT:127.0.0.1" --resolve "$APIM_DOMAIN:$HTTPS_PORT:127.0.0.1")
fails=0
chk(){ # label url expected-codes [extra curl args]
  local label="$1" url="$2" want="$3"; shift 3; local c
  c=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "${CURL_CA[@]+"${CURL_CA[@]}"}" "${R[@]}" "$@" "$url" 2>>"$LOG_FILE" || true)
  if [[ "$c" =~ ^($want)$ ]]; then ok "$label -> $c"; else warn "$label -> $c (expected $want)"; fails=$((fails+1)); fi
}
chk "Weave Gateway console  $WEAVE_URL/" "$WEAVE_URL/" "200|302"
chk "Gateway console health $WEAVE_URL/healthz" "$WEAVE_URL/healthz" 200
chk "Weave Factory          $WEAVE_URL/factory/" "$WEAVE_URL/factory/" "200|302"
chk "Factory health         127.0.0.1:$PORT_FACTORY/healthz" "http://127.0.0.1:$PORT_FACTORY/healthz" 200
chk "Flow runtime health    127.0.0.1:$PORT_RUNTIME/v1/healthz" "http://127.0.0.1:$PORT_RUNTIME/v1/healthz" 200
chk "API Manager version    $APIM_URL/services/Version" "$APIM_URL/services/Version" 200
chk "API Manager Publisher  $APIM_URL/publisher/" "$APIM_URL/publisher/" "200|302"
chk "API Manager DevPortal  $APIM_URL/devportal/" "$APIM_URL/devportal/" "200|302"
chk "Gateway health         127.0.0.1:$APIM_MGMT_NODEPORT gateway startup check" "https://localhost:$APIM_MGMT_NODEPORT/api/am/gateway/v2/server-startup-healthcheck" 200 --cacert "$ETC/apim-ca.pem"
[ "$ENABLE_GW_PATH" = yes ] && chk "API gateway via proxy  $WEAVE_URL/gw/ (no API = 404)" "$WEAVE_URL/gw/no-such-api/1.0" "404|401|403"
chk "API gateway NodePort   :$GATEWAY_HTTPS_NODEPORT (no API = 404)" "https://localhost:$GATEWAY_HTTPS_NODEPORT/no-such-api/1.0" "404|401|403" --cacert "$ETC/apim-ca.pem"
chk "Migration tool health  :$MT_NODEPORT/api/health" "http://127.0.0.1:$MT_NODEPORT/api/health" 200
chk "HTTP -> HTTPS redirect :$HTTP_PORT" "http://$WEAVE_DOMAIN:$HTTP_PORT/" "301|302|308" --resolve "$WEAVE_DOMAIN:$HTTP_PORT:127.0.0.1"
# sign-in: Weave accounts (users and access) when the images have it; API Manager sign-in otherwise / as well
CJ=$(mktemp)
prov=$(curl -s --max-time 20 "${CURL_CA[@]+"${CURL_CA[@]}"}" "${R[@]}" "$WEAVE_URL/api/auth/providers" || true)
if [[ "$prov" == *'"providers"'* ]]; then
  ok "sign-in providers offered: $(echo "$prov" | tr -d '\n' | cut -c1-120)"
  for app in "$WEAVE_URL" "$WEAVE_URL/factory"; do
    name=$([ "$app" = "$WEAVE_URL" ] && echo "Gateway console" || echo "Factory")
    if [[ "$prov" == *'"local"'* ]]; then
      : >"$CJ"
      c=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "${CURL_CA[@]+"${CURL_CA[@]}"}" "${R[@]}" -c "$CJ" -b "$CJ" \
          -H "Origin: $WEAVE_URL" -H 'Content-Type: application/json' \
          -d "{\"email\":\"$WEAVE_ADMIN_EMAIL\",\"password\":\"$WEAVE_BOOTSTRAP_PASSWORD\"}" "$app/api/auth/local" || true)
      me=$(curl -s --max-time 20 "${CURL_CA[@]+"${CURL_CA[@]}"}" "${R[@]}" -b "$CJ" "$app/api/auth/me" || true)
      if [ "$c" = 200 ] && [[ "$me" == *'"admin"'* ]]; then ok "$name: first admin $WEAVE_ADMIN_EMAIL signs in (Weave account), $(echo "$me" | grep -o '"roles":\[[^]]*\]')"
      else warn "$name: first admin sign-in failed (POST /api/auth/local -> $c; /api/auth/me -> $(echo "$me" | cut -c1-120))"; fails=$((fails+1)); fi
    fi
  done
  if [[ "$prov" == *'"oidc"'* ]]; then
    loc=$(curl -s -o /dev/null -w '%{redirect_url}' --max-time 20 "${CURL_CA[@]+"${CURL_CA[@]}"}" "${R[@]}" "$WEAVE_URL/api/auth/login?provider=oidc" || true)
    [[ "$loc" == "${OIDC_ISSUER%/v2.0}"* ]] && ok "Microsoft sign-in starts at ${loc%%\?*}" || warn "Microsoft sign-in did not redirect to the issuer ('${loc:0:120}'); is login.microsoftonline.com reachable? (NETWORK.md)"
  fi
  APIM_LOGIN_PATH="/api/auth/login?provider=wso2"; [[ "$prov" == *'"wso2"'* ]] || APIM_LOGIN_PATH=""
else
  APIM_LOGIN_PATH="/api/auth/login"    # images without users and access: API Manager sign-in only
fi
rm -f "$CJ"
if [ -n "$APIM_LOGIN_PATH" ]; then
  loc=$(curl -s -o /dev/null -w '%{redirect_url}' --max-time 20 "${CURL_CA[@]+"${CURL_CA[@]}"}" "${R[@]}" "$WEAVE_URL$APIM_LOGIN_PATH" || true)
  if [[ "$loc" == "$APIM_URL/oauth2/authorize"* ]]; then
    login=$(curl -s -o /dev/null -w '%{http_code} %{url_effective}' -L --max-redirs 5 --max-time 30 "${CURL_CA[@]+"${CURL_CA[@]}"}" "${R[@]}" "$loc" || true)
    [[ "$login" == 200\ *authenticationendpoint/login* ]] && ok "API Manager sign-in: console -> $APIM_URL/oauth2/authorize -> login page" || { warn "authorize did not reach the login page: $login"; fails=$((fails+1)); }
  else warn "API Manager sign-in redirect is '$loc'"; fails=$((fails+1)); fi
fi

[ "$fails" = 0 ] || die "$fails smoke check(s) failed (details above and in $LOG_FILE)"
date -u +%FT%TZ >"$STATE/installed-at"

cat <<EOF

========================================================================================
 Cruise Saudi Weave $BUNDLE_VERSION is installed.

   Weave (Gateway console)  $WEAVE_URL/
   Weave Factory            $WEAVE_URL/factory/
   API Manager portals      $APIM_URL/publisher/   $APIM_URL/devportal/   $APIM_URL/admin/
   API gateway              $GATEWAY_PUBLIC_URL   (NodePort $GATEWAY_HTTPS_NODEPORT for the load balancer)

 Weave sign-in, first admin (Weave account):  $WEAVE_ADMIN_EMAIL
 API Manager portals: user '$APIM_ADMIN_USER', password: sudo grep ^APIM_ADMIN_PASSWORD= $SECRETS | cut -d= -f2
 Sign-in providers: $AUTH_EFFECTIVE   (Entra set-up: docs/CRUISE-SAUDI-SSO.md; network: NETWORK.md)
 Config: $ETC/weave.conf    Data: $DATA    Logs: $LOG_FILE, $DATA_ROOT/logs/
========================================================================================
EOF
if [ ! -f "$STATE/bootstrap-password-shown" ]; then
  # shown ONCE on the terminal (kept in $SECRETS as WEAVE_BOOTSTRAP_PASSWORD); never written to the log
  printf '\n  First admin password (shown only now - put it in the company vault, then change it\n  under Users and access):   %s\n\n' "$WEAVE_BOOTSTRAP_PASSWORD"
  touch "$STATE/bootstrap-password-shown"
else
  echo " First admin password: sudo grep ^WEAVE_BOOTSTRAP_PASSWORD= $SECRETS | cut -d= -f2   (unless changed since)"
fi
