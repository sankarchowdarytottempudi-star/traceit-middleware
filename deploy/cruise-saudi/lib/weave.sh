# Cruise Saudi Weave - how the three Weave containers are started (install.sh and upgrade.sh).
# Needs cs_load to have run. Env files: $ETC/{gateway,factory,runtime}.env (written by install.sh).
# shellcheck shell=bash

weave_port(){ case "$1" in gateway) echo "$PORT_GATEWAY";; factory) echo "$PORT_FACTORY";; runtime) echo "$PORT_RUNTIME";; esac; }
weave_health(){ case "$1" in runtime) echo /v1/healthz;; *) echo /healthz;; esac; }

# weave_start <component> <image>  - (re)creates container $PREFIX<component>; no health wait
weave_start(){
  local comp="$1" image="$2" args=() cmd=() limits=()
  [ "$ISOLATED" = 1 ] && limits=(--cpus 1 --memory 1g)
  local ca=(-v "$ETC/apim-ca.pem:/etc/weave/apim-ca.pem:ro" -v "$ETC/extra-ca.pem:/etc/weave/extra-ca.pem:ro")
  case "$comp" in
    runtime) args=(--user 1000:1000 --env-file "$ETC/runtime.env" -v "$DATA/runtime:/data" "${ca[@]}");;
    gateway) args=(--env-file "$ETC/gateway.env" -v "$DATA/gateway:/app/apps/gateway-admin-bff/.data" "${ca[@]}"
               -v "$ETC/k8s:/etc/weave/k8s:ro" -v "$DATA_ROOT/logs/apim:/var/log/weave/apim:ro" -v "$PLATFORM_DIR/services:/estate/services:ro")
             cmd=(node dist/src/index.js);;   # the image's default CMD points at dist/index.js; the compiled entry is dist/src/index.js
    factory) args=(--env-file "$ETC/factory.env" -v "$DATA/factory:/app/apps/weave-factory-bff/.data" "${ca[@]}"
               -v "$ETC/k8s:/etc/weave/k8s:ro" -v "$DATA_ROOT/logs/apim:/var/log/weave/apim:ro" -v "$PLATFORM_DIR/services:/estate/services:ro"
               -v "$PLATFORM_DIR/framework:/estate/framework:ro")
             [ -d "$ETC/target" ] && args+=(-v "$ETC/target:/etc/weave/target:ro");;
    *) die "unknown component $comp";;
  esac
  docker rm -f "$PREFIX$comp" >/dev/null 2>&1 || true
  run docker run -d --name "$PREFIX$comp" --network host --restart unless-stopped "${limits[@]+"${limits[@]}"}" \
    --label app.kubernetes.io/part-of=cruise-saudi-weave --label weave/profile="${PREFIX%-}" \
    --log-opt max-size=50m --log-opt max-file=5 "${args[@]}" "$image" "${cmd[@]+"${cmd[@]}"}"
}

# weave_healthy <component> [tries]  - 0 when its health URL answers 200
weave_healthy(){
  local comp="$1" tries="${2:-40}" c
  c=$(wait_http "http://127.0.0.1:$(weave_port "$comp")$(weave_health "$comp")" 200 "$tries") && return 0
  echo "[$(_ts)] $PREFIX$comp health answered $c; last log lines:" >>"$LOG_FILE"
  docker logs --tail 30 "$PREFIX$comp" 2>&1 | sed -E 's/((key|secret|password|token)[^ =:]*[=:] *)[^ ]+/\1***/Ig' >>"$LOG_FILE"
  return 1
}
