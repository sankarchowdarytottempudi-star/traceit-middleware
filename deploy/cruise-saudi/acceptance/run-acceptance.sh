#!/usr/bin/env bash
# Cruise Saudi Weave go-live acceptance - one command.
#
#   run-acceptance.sh <base-url> [--isolated-test] [--read-only] [--dev-auth] [--secrets FILE] [--out DIR] [...]
#
#   <base-url>       the weave host, e.g. https://weave.cruisesaudi.example (Factory at /factory, Gateway console at /)
#   --isolated-test  the isolated copy on this host (installer --isolated-test): https://weave.aroya.test and
#                    https://apim.aroya.test through 127.0.0.1:9443, namespaces cs-apim/cs-weave, containers cstest-*
#   --read-only      never create anything (dry run against a shared or production instance)
#   --secrets FILE   env file with ACC_* credentials (see docs/CRUISE-SAUDI-ACCEPTANCE.md, "Harness"); never printed
#   all options:     run-acceptance.sh --help
#
# Prints PASS/FAIL/WAITING/SKIP/MANUAL per item with evidence; writes report.json and report.html.
# Exit code = number of FAIL items (0 = everything that ran passed).
#
# On the shared test VM the heavy parts (browser crawl, image scan, backup) run under the shared lock
# /root/accept/heavy-build.lock with a CPU quota; set ACC_HEAVY_WRAPPED=1 if you already hold the lock.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -z "${ACC_HEAVY_PREFIX+x}" ]; then
  if [ "${ACC_HEAVY_WRAPPED:-0}" != "1" ] && [ -e /root/accept/heavy-build.lock ] && command -v systemd-run >/dev/null; then
    export ACC_HEAVY_PREFIX="flock /root/accept/heavy-build.lock systemd-run --scope -q -p CPUQuota=150% nice -n 19"
  else
    export ACC_HEAVY_PREFIX=""
  fi
fi
# do not add load to a busy host
for i in $(seq 1 60); do
  load=$(cut -d' ' -f1 /proc/loadavg 2>/dev/null || echo 0)
  awk -v l="$load" 'BEGIN{exit !(l>8)}' || break
  echo "load average $load > 8 - waiting 30 s ($i/60)"; sleep 30
done
exec python3 "$HERE/acceptance.py" "$@"
