#!/usr/bin/env bash
# Cruise Saudi Weave - OFFLINE bundle builder. Runs on OUR side (a build host with Docker, internet,
# the platform sources), never on the customer's server. The customer's server has no internet:
# everything the installer and the code generator need at runtime is in this bundle.
#
#   bash deploy/cruise-saudi/build-bundle.sh [--version 1.0.0] [--out DIR] [--with-model]
#
# Produces  <out>/weave-cruise-saudi-<version>.tar.gz  (+ .sha256) holding:
#   images/docker/   Weave Gateway, Weave Factory (VITE_WEAVE_EDITION=cruise-saudi), flow runtime,
#                    base images of migrated APIs: eclipse-temurin:21-jre-alpine (Ballerina), node:22-bookworm-slim (Node.js)
#   images/k8s/      wso2/wso2am:4.5.0, postgres:16-alpine, migration tool
#   images/model/    llama.cpp server image (only with --with-model)
#   bin/             k3s binary + airgap images + install script, helm, kubectl, caddy, docker (static)
#   pkgs/            Ballerina 2201.13.4 (.deb + .rpm, bundled JRE 21), PostgreSQL JDBC driver,
#                    standalone CPython 3.12 (for servers without python3.12), k3s-selinux (RHEL 9)
#   platform/        code generator seed (migration-factory + framework + chart + Dockerfile, no customer
#                    sources), Ballerina package cache (every library the services/framework import),
#                    BALLERINA-DEPENDENCIES.txt, OFFLINE-BUILD-PROOF.txt
#   model/           local code model .gguf (only with --with-model, ~4.7 GB)
#   installer files  install.sh, upgrade.sh, rollback.sh, backup.sh, restore.sh, uninstall.sh, docs, templates
#
# Options:
#   --version V        bundle version (default: 1.0.0-<git short sha>)
#   --out DIR          output directory (default: ./dist)
#   --src DIR          traceit-middleware checkout (default: the repository holding this script)
#   --mt-src DIR       Migration-tool source (default: /root/Migration-tool)
#   --platform-src D   api-migration-platform source (default: /root/api-migration-platform)
#   --os ubuntu|rhel|all   which Ballerina package(s) to include (default: all)
#   --skip-build       reuse images already tagged cruise-saudi/*:<version>
#   --with-model       add the local code model (/opt/weave-model/*.gguf) and its llama.cpp image
#   --model-dir DIR    where the .gguf lives (default /opt/weave-model)
#   --skip-bal-check   skip the offline Ballerina build proof (step 5)
#   --no-tar           leave the staging directory, do not create the .tar.gz
#
# Heavy: run it as  flock /root/accept/heavy-build.lock systemd-run --scope -q -p CPUQuota=200% nice -n 19 bash build-bundle.sh ...
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$(cd "$HERE/../.." && pwd)"
OUT="$PWD/dist"; VERSION=""; MT_SRC=/root/Migration-tool; PLATFORM_SRC=/root/api-migration-platform
OSSEL=all; SKIP_BUILD=0; NO_TAR=0; WITH_MODEL=0; MODEL_DIR=/opt/weave-model; BAL_CHECK=1
while [ $# -gt 0 ]; do
  case "$1" in
    --version) VERSION="$2"; shift 2;;
    --out) OUT="$2"; shift 2;;
    --src) SRC="$2"; shift 2;;
    --mt-src) MT_SRC="$2"; shift 2;;
    --platform-src) PLATFORM_SRC="$2"; shift 2;;
    --os) OSSEL="$2"; shift 2;;
    --skip-build) SKIP_BUILD=1; shift;;
    --with-model) WITH_MODEL=1; shift;;
    --model-dir) MODEL_DIR="$2"; shift 2;;
    --skip-bal-check) BAL_CHECK=0; shift;;
    --no-tar) NO_TAR=1; shift;;
    -h|--help) sed -n '2,36p' "$0"; exit 0;;
    *) echo "unknown option $1" >&2; exit 2;;
  esac
done

# Pinned versions (keep in sync with lib/common.sh)
K3S_VERSION="v1.31.4+k3s1"
HELM_VERSION="v3.16.3"
KUBECTL_VERSION="v1.31.4"
CADDY_VERSION="2.11.9"
DOCKER_VERSION="27.5.1"
BAL_VERSION="2201.13.4"
PGJDBC_VERSION="42.7.4"
APIM_IMAGE="docker.io/wso2/wso2am:4.5.0"
PG_IMAGE="docker.io/library/postgres:16-alpine"
JRE_IMAGE="eclipse-temurin:21-jre-alpine"          # base of every migrated Ballerina API (deploy/docker/Dockerfile)
NODE_IMAGE="node:22-bookworm-slim"                # base of migrated APIs generated for the Node.js target
LLAMA_IMAGE="ghcr.io/ggml-org/llama.cpp:server-b4800"
PYTHON_STANDALONE="https://github.com/astral-sh/python-build-standalone/releases/download/20241016/cpython-3.12.7+20241016-x86_64-unknown-linux-gnu-install_only.tar.gz"
K3S_SELINUX_RPM="https://github.com/k3s-io/k3s-selinux/releases/download/v1.6.stable.1/k3s-selinux-1.6-1.el9.noarch.rpm"

cd "$SRC"
[ -n "$VERSION" ] || VERSION="1.0.0-$(git rev-parse --short HEAD 2>/dev/null || date +%Y%m%d)"
NAME="weave-cruise-saudi-$VERSION"
STAGE="$OUT/$NAME"; CACHE="$OUT/cache"
mkdir -p "$OUT" "$CACHE"
[ -n "$NAME" ] && rm -rf "${STAGE:?}"
mkdir -p "$STAGE"/{images/docker,images/k8s,bin,pkgs,platform}
log(){ echo "[bundle $(date +%H:%M:%S)] $*"; }
die(){ echo "[bundle] ERROR: $*" >&2; exit 1; }
fetch(){ # url file  (cached); prints the local path
  local url="$1" f="$CACHE/$2"
  if [ ! -s "$f" ]; then log "download $(basename "$f")" >&2; curl -fsSL --retry 3 -o "$f.part" "$url" && mv "$f.part" "$f"; fi
  echo "$f"
}

GW=cruise-saudi/weave-gateway:$VERSION; FA=cruise-saudi/weave-factory:$VERSION
RT=cruise-saudi/weave-runtime:$VERSION; MT=cruise-saudi/migration-tool:$VERSION

# ---- 1. images ---------------------------------------------------------------------------
if [ "$SKIP_BUILD" = 0 ]; then
  log "build $GW (edition cruise-saudi)"
  docker build -q -f deploy/Dockerfile -t "$GW" --build-arg VITE_WEAVE_EDITION=cruise-saudi \
    --build-arg VITE_WEAVE_FACTORY_URL=/factory . >/dev/null
  log "build $FA (edition cruise-saudi)"
  docker build -q -f deploy/Dockerfile.factory -t "$FA" --build-arg VITE_WEAVE_EDITION=cruise-saudi \
    --build-arg VITE_WEAVE_GATEWAY_URL=/ . >/dev/null
  log "build $RT (edition cruise-saudi)"
  docker build -q -f deploy/Dockerfile.runtime -t "$RT" --build-arg VITE_WEAVE_EDITION=cruise-saudi . >/dev/null
  log "build $MT from $MT_SRC"
  [ -f "$MT_SRC/deploy/Dockerfile" ] || die "no Migration-tool source at $MT_SRC"
  docker build -q -f "$MT_SRC/deploy/Dockerfile" -t "$MT" "$MT_SRC" >/dev/null
fi
for i in "$GW" "$FA" "$RT" "$MT"; do docker image inspect "$i" >/dev/null 2>&1 || die "image $i missing"; done
for i in "$JRE_IMAGE" "$NODE_IMAGE" "${PG_IMAGE#docker.io/library/}"; do docker image inspect "$i" >/dev/null 2>&1 || docker pull -q "$i" >/dev/null; done

log "save docker images"
docker save "$GW" -o "$STAGE/images/docker/weave-gateway.tar"
docker save "$FA" -o "$STAGE/images/docker/weave-factory.tar"
docker save "$RT" -o "$STAGE/images/docker/weave-runtime.tar"
docker save "$JRE_IMAGE" -o "$STAGE/images/docker/eclipse-temurin-21-jre-alpine.tar"
docker save "$NODE_IMAGE" -o "$STAGE/images/docker/node-22-bookworm-slim.tar"
if [ "$WITH_MODEL" = 1 ]; then
  docker image inspect "$LLAMA_IMAGE" >/dev/null 2>&1 || docker pull -q "$LLAMA_IMAGE" >/dev/null
  mkdir -p "$STAGE/images/model"; docker save "$LLAMA_IMAGE" -o "$STAGE/images/model/llama-cpp-server.tar"
fi

log "save k8s images"
docker save "$MT" -o "$STAGE/images/k8s/migration-tool.tar"
docker save "${PG_IMAGE#docker.io/library/}" -o "$STAGE/images/k8s/postgres-16-alpine.tar"
if docker image inspect wso2/wso2am:4.5.0 >/dev/null 2>&1; then
  docker save wso2/wso2am:4.5.0 -o "$STAGE/images/k8s/wso2am-4.5.0.tar"
elif command -v k3s >/dev/null && k3s ctr images ls -q | grep -qx "$APIM_IMAGE"; then
  k3s ctr images export --platform linux/amd64 "$STAGE/images/k8s/wso2am-4.5.0.tar" "$APIM_IMAGE"
else
  docker pull -q "$APIM_IMAGE" >/dev/null && docker save wso2/wso2am:4.5.0 -o "$STAGE/images/k8s/wso2am-4.5.0.tar"
fi
# an export from k3s is incomplete when containerd discarded layer blobs; the real image is ~770 MB
[ "$(stat -c %s "$STAGE/images/k8s/wso2am-4.5.0.tar")" -gt 500000000 ] || die "wso2am image export is incomplete; docker pull $APIM_IMAGE and re-run"
{ echo "gateway=$GW"; echo "factory=$FA"; echo "runtime=$RT"; echo "migration_tool=$MT"
  echo "apim=$APIM_IMAGE"; echo "postgres=$PG_IMAGE"; echo "jre=$JRE_IMAGE"; echo "node=$NODE_IMAGE"
  [ "$WITH_MODEL" = 1 ] && echo "model=$LLAMA_IMAGE"; true; } >"$STAGE/images/IMAGES"

# ---- 2. binaries and packages ------------------------------------------------------------
K3SU="https://github.com/k3s-io/k3s/releases/download/${K3S_VERSION//+/%2B}"
cp "$(fetch "$K3SU/k3s" "k3s-$K3S_VERSION")" "$STAGE/bin/k3s"
cp "$(fetch "$K3SU/k3s-airgap-images-amd64.tar.zst" "k3s-airgap-$K3S_VERSION.tar.zst")" "$STAGE/bin/k3s-airgap-images-amd64.tar.zst"
cp "$(fetch https://get.k3s.io "k3s-install-$K3S_VERSION.sh")" "$STAGE/bin/k3s-install.sh"
tar xzf "$(fetch "https://get.helm.sh/helm-$HELM_VERSION-linux-amd64.tar.gz" "helm-$HELM_VERSION.tgz")" -C "$CACHE" linux-amd64/helm
cp "$CACHE/linux-amd64/helm" "$STAGE/bin/helm"
cp "$(fetch "https://dl.k8s.io/release/$KUBECTL_VERSION/bin/linux/amd64/kubectl" "kubectl-$KUBECTL_VERSION")" "$STAGE/bin/kubectl"
tar xzf "$(fetch "https://github.com/caddyserver/caddy/releases/download/v$CADDY_VERSION/caddy_${CADDY_VERSION}_linux_amd64.tar.gz" "caddy-$CADDY_VERSION.tgz")" -C "$STAGE/bin" caddy
cp "$(fetch "https://download.docker.com/linux/static/stable/x86_64/docker-$DOCKER_VERSION.tgz" "docker-$DOCKER_VERSION.tgz")" "$STAGE/bin/docker-static.tgz"
chmod 755 "$STAGE"/bin/k3s "$STAGE"/bin/helm "$STAGE"/bin/kubectl "$STAGE"/bin/caddy "$STAGE"/bin/k3s-install.sh

BALU="https://dist.ballerina.io/downloads/$BAL_VERSION"
case "$OSSEL" in ubuntu|all) cp "$(fetch "$BALU/ballerina-$BAL_VERSION-swan-lake-linux-x64.deb" "ballerina-$BAL_VERSION.deb")" "$STAGE/pkgs/";; esac
case "$OSSEL" in rhel|all) cp "$(fetch "$BALU/ballerina-$BAL_VERSION-swan-lake-linux-x64.rpm" "ballerina-$BAL_VERSION.rpm")" "$STAGE/pkgs/"
  cp "$(fetch "$K3S_SELINUX_RPM" k3s-selinux.el9.rpm)" "$STAGE/pkgs/k3s-selinux.el9.noarch.rpm";; esac
cp "$(fetch "$PYTHON_STANDALONE" python-3.12-standalone.tgz)" "$STAGE/pkgs/python-3.12-standalone.tgz"
cp "$(fetch "https://repo1.maven.org/maven2/org/postgresql/postgresql/$PGJDBC_VERSION/postgresql-$PGJDBC_VERSION.jar" "postgresql-$PGJDBC_VERSION.jar")" "$STAGE/pkgs/postgresql-jdbc.jar"

# ---- 3. code generator seed ----------------------------------------------------------------
log "platform seed from $PLATFORM_SRC (no services, no customer sources)"
[ -d "$PLATFORM_SRC/migration-factory" ] || die "no api-migration-platform at $PLATFORM_SRC"
tar -C "$PLATFORM_SRC" --exclude='__pycache__' --exclude='*.pyc' --exclude='target' --exclude='.git' \
  -czf "$STAGE/platform/platform-seed.tgz" migration-factory framework deploy/docker deploy/helm tools
cat > "$STAGE/platform/Ballerina.toml" <<'EOF'
# Ballerina workspace of the migration platform: the reusable framework plus every migrated
# service (the migration tool adds "services/<api>" entries as it creates them).
[workspace]
packages = [
    "framework/integration-commons",
]
EOF
# Python: the migration tool and the code generator use the standard library only (no pip packages).

# ---- 3b. Ballerina package cache: every library the generated services and the framework import --
BAL_CACHE="${BAL_CACHE:-/root/.ballerina}"
[ -d "$BAL_CACHE/repositories/central.ballerina.io" ] || die "no Ballerina Central cache at $BAL_CACHE/repositories"
log "check the Ballerina cache covers every dependency of $PLATFORM_SRC (services + framework)"
python3 "$HERE/lib/bal-deps.py" "$PLATFORM_SRC" "$BAL_CACHE/repositories/central.ballerina.io/bala" \
  "/usr/lib/ballerina/distributions/ballerina-$BAL_VERSION/repo/bala" >"$STAGE/platform/BALLERINA-DEPENDENCIES.txt" \
  || die "the Ballerina cache misses packages (see $STAGE/platform/BALLERINA-DEPENDENCIES.txt)"
log "Ballerina cache complete: $(tail -1 "$STAGE/platform/BALLERINA-DEPENDENCIES.txt")"
tar -C "$BAL_CACHE" -czf "$STAGE/platform/ballerina-repositories.tgz" repositories   # Settings.toml (tokens) not included

# ---- 3c. optional local code model ----
if [ "$WITH_MODEL" = 1 ]; then
  g=$(ls "$MODEL_DIR"/*.gguf 2>/dev/null | head -1); [ -n "$g" ] || die "no .gguf in $MODEL_DIR"
  log "local code model $(basename "$g") ($(du -h "$g" | cut -f1))"
  mkdir -p "$STAGE/model"; cp "$g" "$STAGE/model/"; (cd "$STAGE/model" && sha256sum ./*.gguf > model.sha256)
fi

# ---- 4. proof: build one generated service with ONLY the bundled .deb + cache, no network ----
if [ "$BAL_CHECK" = 1 ]; then
  log "offline proof: bal build --offline of services/${BAL_CHECK_SERVICE:-seaware-sys-api} in a container with --network none"
  bash "$HERE/lib/bal-offline-check.sh" "$STAGE" "$PLATFORM_SRC" "${BAL_CHECK_SERVICE:-seaware-sys-api}" "$NODE_IMAGE" \
    >"$STAGE/platform/OFFLINE-BUILD-PROOF.txt" 2>&1 || { tail -30 "$STAGE/platform/OFFLINE-BUILD-PROOF.txt" >&2; die "offline Ballerina build failed"; }
  log "offline build OK: $(grep -c '\.jar$' "$STAGE/platform/OFFLINE-BUILD-PROOF.txt") jar(s) built without network (platform/OFFLINE-BUILD-PROOF.txt)"
fi

# ---- 5. installer --------------------------------------------------------------------------
log "installer files"
cp -a "$HERE"/. "$STAGE/"
# Entra ID / users-and-access guide for Cruise Saudi's administrators (from the users stream)
if [ -f "$SRC/docs/CRUISE-SAUDI-SSO.md" ]; then mkdir -p "$STAGE/docs"; cp "$SRC/docs/CRUISE-SAUDI-SSO.md" "$STAGE/docs/"
else log "WARNING: $SRC has no docs/CRUISE-SAUDI-SSO.md (images built without users and access?)"; fi
echo "$VERSION" > "$STAGE/VERSION"
(cd "$SRC" && git rev-parse HEAD 2>/dev/null || echo unknown) > "$STAGE/SOURCE_COMMIT"
(cd "$STAGE" && find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS)

if [ "$NO_TAR" = 0 ]; then
  log "pack $NAME.tar.gz"
  if command -v pigz >/dev/null; then tar -C "$OUT" -cf - "$NAME" | pigz -p 2 > "$OUT/$NAME.tar.gz.part"
  else tar -C "$OUT" -czf "$OUT/$NAME.tar.gz.part" "$NAME"; fi
  mv "$OUT/$NAME.tar.gz.part" "$OUT/$NAME.tar.gz"
  sha256sum "$OUT/$NAME.tar.gz" > "$OUT/$NAME.tar.gz.sha256"
  log "done: $OUT/$NAME.tar.gz ($(du -h "$OUT/$NAME.tar.gz" | cut -f1))"
else
  log "done: staging directory $STAGE"
fi
