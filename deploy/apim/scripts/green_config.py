#!/usr/bin/env python3
"""Build green's configuration from blue's LIVE configuration, so the two cannot drift apart.

  green_config.py apply      read ConfigMap apim-conf (blue), apply the four documented changes,
                             keep a copy in /root/apim-bluegreen/green/ (mode 700) and create or
                             update ConfigMap apim-conf-green {deployment.toml, log4j2.properties}
  green_config.py template   write green/deployment.toml.template for the repository: the same
                             file with every credential replaced by a placeholder
  green_config.py diff       show what differs between blue's and green's deployment.toml
                             (values of credentials are never printed)

Changes relative to blue (nothing else):
  [apim.analytics] enable = true, type = "elk"   native analytics -> repository/logs/apim_metrics.log
  [indexing] re_indexing = 1                     rebuild the registry search index on first boot
                                                 (the index itself is not part of the DB snapshot)
  [http_access_log] maxDays = 14                 Tomcat deletes management access logs after 14 days
"""
from __future__ import annotations
import difflib, os, re, subprocess, sys
from apimlib import toml_from_configmap

ROOT = os.environ.get("APIM_BG_ROOT", "/root/apim-bluegreen")
HERE = os.path.dirname(os.path.abspath(__file__))
GREEN_DIR = os.path.join(HERE, "..", "green")
SECRET_KEY = re.compile(r"^(\s*#?\s*)([\w.'\-]*(password|secret|encryption_key)|auth_token|token|key)(\s*=\s*)(.*)$", re.I)

ADDED = '''
# ---- added for green (see deploy/apim/RUNBOOK.md) ----
[indexing]
re_indexing = 1

[http_access_log]
maxDays = 14
'''


def green_toml(blue):
    if re.search(r"^\[(indexing|http_access_log)\]", blue, re.M):
        raise SystemExit("blue's deployment.toml already has [indexing] or [http_access_log]: review by hand")
    out, section, changed = [], None, 0
    for line in blue.split("\n"):
        m = re.match(r"^\s*\[+([^\]]+)\]+\s*$", line)
        if m:
            section = m.group(1).strip()
        if section == "apim.analytics" and re.match(r"^\s*enable\s*=", line):
            out += ["enable = true", 'type = "elk"']
            changed += 1
            continue
        if section == "apim.analytics" and re.match(r"^\s*type\s*=", line):
            continue
        out.append(line)
    if changed != 1:
        raise SystemExit(f"expected exactly one [apim.analytics] enable line in blue's config, found {changed}")
    return "\n".join(out).rstrip("\n") + "\n" + ADDED


def redact(toml):
    out, section = [], ""
    for line in toml.split("\n"):
        m = re.match(r"^\s*#?\s*\[+([^\]]+)\]+\s*$", line)
        if m:
            section = m.group(1).strip()
        m = SECRET_KEY.match(line)
        if m and m.group(5).strip() not in ('""', "''", ""):
            name = (section + "." + m.group(2).strip("'")).upper()
            name = re.sub(r"[^A-Z0-9]+", "_", name).strip("_")
            line = f'{m.group(1)}{m.group(2)}{m.group(4)}"<SET-ME:{name}>"'
        out.append(line)
    return "\n".join(out)


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    blue = toml_from_configmap("apim-conf")
    green = green_toml(blue)
    if cmd == "template":
        path = os.path.join(GREEN_DIR, "deployment.toml.template")
        with open(path, "w") as f:
            f.write("# TEMPLATE - credentials replaced by <SET-ME:...> placeholders. The real file lives only in\n"
                    "# ConfigMap apim/apim-conf-green and in /root/apim-bluegreen/green/ (mode 700).\n"
                    "# Regenerate with: scripts/green_config.py template\n" + redact(green))
        print(f"wrote {os.path.normpath(path)}")
        return 0
    if cmd == "diff":
        for l in difflib.unified_diff(redact(blue).split("\n"), redact(green).split("\n"), "blue", "green", lineterm="", n=1):
            print(l)
        return 0
    if cmd == "apply":
        d = os.path.join(ROOT, "green")
        os.makedirs(d, mode=0o700, exist_ok=True)
        os.chmod(d, 0o700)
        toml_path = os.path.join(d, "deployment.toml")
        with open(os.open(toml_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w") as f:
            f.write(green)
        log4j = os.path.join(GREEN_DIR, "log4j2.properties")
        manifest = subprocess.check_output(
            ["kubectl", "-n", "apim", "create", "configmap", "apim-conf-green",
             f"--from-file=deployment.toml={toml_path}", f"--from-file=log4j2.properties={log4j}",
             "--dry-run=client", "-o", "yaml"])
        subprocess.run(["kubectl", "-n", "apim", "apply", "-f", "-"], input=manifest, check=True)
        return 0
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main())
