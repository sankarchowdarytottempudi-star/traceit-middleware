#!/usr/bin/env bash
# Proof that the bundle builds a generated service WITHOUT network: a fresh Debian container with
# --network none installs the bundled Ballerina .deb, gets only the bundled package cache, and runs
# `bal build --offline` on a copy of one migrated service + the framework.
#   usage: bal-offline-check.sh <bundle staging dir> <platform dir> <service> <debian-based image>
set -euo pipefail
STAGE="$1"; PLATFORM="$2"; SVC="$3"; IMAGE="$4"
[ -d "$PLATFORM/services/$SVC" ] || { echo "no service $SVC in $PLATFORM/services"; exit 1; }
W="$(mktemp -d /tmp/cs-balcheck.XXXXXX)"
cleanup(){ case "$W" in /tmp/cs-balcheck.*) rm -rf -- "$W";; esac; }
trap cleanup EXIT
mkdir -p "$W/ws/services" "$W/home/.ballerina"
rsync -a --exclude target "$PLATFORM/framework" "$W/ws/"
rsync -a --exclude target "$PLATFORM/services/$SVC" "$W/ws/services/"
printf '[workspace]\npackages = [\n    "framework/integration-commons",\n    "services/%s",\n]\n' "$SVC" >"$W/ws/Ballerina.toml"
tar -C "$W/home/.ballerina" -xzf "$STAGE/platform/ballerina-repositories.tgz"
DEB="$(ls "$STAGE"/pkgs/ballerina-*.deb | head -1)"
echo "service: $SVC   image: $IMAGE   network: none   cache: bundle platform/ballerina-repositories.tgz"
docker run --rm --network none -e HOME=/w/home -v "$W:/w" -v "$DEB:/tmp/bal.deb:ro" "$IMAGE" bash -c '
  set -eo pipefail
  dpkg -i /tmp/bal.deb >/dev/null 2>&1
  ln -sfn /w/home/.ballerina /root/.ballerina
  bal version | head -1
  cd /w/ws && bal build --offline 2>&1 | tail -20
  find /w/ws -path "*/target/bin/*.jar"'
