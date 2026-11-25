#!/usr/bin/env python3
"""Cruise Saudi Weave go-live acceptance: runs every automatable check of
docs/CRUISE-SAUDI-ACCEPTANCE.md and writes report.json + report.html. Use run-acceptance.sh."""
from __future__ import annotations

import argparse
import os
import sys
import urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from acc.core import Config, Http, Run, GROUPS, load_env_file, FAIL  # noqa: E402
from acc import install, auth, branding, migration, gateway_rules, ops, security  # noqa: E402


def parse(argv):
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("base_url", nargs="?", help="weave host, e.g. https://weave.example.com (Factory at /factory, Gateway console at /)")
    p.add_argument("--isolated-test", action="store_true", help="target the isolated test install on this host (cs-apim/cs-weave, 127.0.0.1:9443)")
    p.add_argument("--read-only", action="store_true", help="never create anything (no migration, no API, no user, no backup)")
    p.add_argument("--dev-auth", action="store_true", help="the Factory runs with DEV_AUTH_USER (test instance): no sign-in")
    p.add_argument("--factory-url"); p.add_argument("--gateway-url", help="Gateway console; 'none' to leave it out")
    p.add_argument("--apim-url", help="API Manager (REST + /oauth2)"); p.add_argument("--apim-gateway-url", help="where published APIs are called")
    p.add_argument("--namespaces", help="comma list of the install's Kubernetes namespaces")
    p.add_argument("--containers", help="name prefix of the install's containers")
    p.add_argument("--install-dir", help="directory with install.sh / backup.sh / restore.sh / upgrade.sh / rollback.sh")
    p.add_argument("--secrets", help="env file with ACC_* credentials (never printed)")
    p.add_argument("--secrets-glob", action="append", default=[], help="secrets files whose permissions are checked (repeatable)")
    p.add_argument("--only", help="comma list of groups: " + ",".join(g for g, _ in GROUPS))
    p.add_argument("--out", help="report directory (default ./acceptance-report-<stamp>)")
    p.add_argument("--insecure", action="store_true", help="do not verify TLS certificates (recorded in the report)")
    return p.parse_args(argv)


def config(a) -> Config:
    env = load_env_file(a.secrets) if a.secrets else {}
    iso = a.isolated_test
    base = (a.base_url or ("https://weave.aroya.test" if iso else "")).rstrip("/")
    if not base:
        sys.exit("usage: run-acceptance.sh <base-url> [--isolated-test] [options]  (see --help)")
    host = urllib.parse.urlsplit(base).hostname or ""
    dom = host.split(".", 1)[1] if host.count(".") >= 2 else host
    gw = a.gateway_url if a.gateway_url is not None else base
    apim = a.apim_url or env.get("ACC_APIM_URL") or os.environ.get("ACC_APIM_URL") or (f"https://apim.{dom}" if iso else "")
    resolve = {}
    if iso:
        tgt = os.environ.get("ACC_ISOLATED_ADDR", "127.0.0.1:9443")
        ip, port = tgt.rsplit(":", 1)
        for h_ in {host, urllib.parse.urlsplit(apim).hostname or ""} | set(filter(None, os.environ.get("ACC_RESOLVE_HOSTS", "").split(","))):
            if h_:
                resolve[h_] = (ip, int(port))
    cfg = Config(
        base_url=base,
        factory_url=(a.factory_url or base + "/factory").rstrip("/"),
        gateway_url="" if gw == "none" else gw.rstrip("/"),
        apim_url=apim.rstrip("/"),
        apim_gw_url=(a.apim_gateway_url or env.get("ACC_APIM_GATEWAY_URL") or os.environ.get("ACC_APIM_GATEWAY_URL") or apim).rstrip("/"),
        isolated=iso, read_only=a.read_only, dev_auth=a.dev_auth,
        insecure_tls=a.insecure or iso, resolve=resolve,
        namespaces=[n for n in (a.namespaces or ("cs-apim,cs-weave" if iso else "")).split(",") if n],
        container_prefix=a.containers or ("cstest-" if iso else ""),
        install_dir=a.install_dir or (os.path.dirname(HERE) if iso else ""),
        secrets_paths=a.secrets_glob,
        only=[g for g in (a.only or "").split(",") if g],
        harness_dir=HERE, env=env,
    )
    if iso and "ACC_APIM_NAMESPACE" not in env and "ACC_APIM_NAMESPACE" not in os.environ:
        env["ACC_APIM_NAMESPACE"] = "cs-apim"
    cfg.out_dir = a.out or os.path.join(os.getcwd(), f"acceptance-report-{cfg.stamp}")
    return cfg


def main(argv=None) -> int:
    a = parse(argv if argv is not None else sys.argv[1:])
    cfg = config(a)
    h = Http(cfg)
    r = Run(cfg)
    print(f"Cruise Saudi Weave acceptance - run {cfg.stamp}\n  factory {cfg.factory_url}\n  gateway {cfg.gateway_url or '-'}\n"
          f"  api manager {cfg.apim_url or '-'} (gateway {cfg.apim_gw_url or '-'})\n  mode: {'isolated test, ' if cfg.isolated else ''}"
          f"{'read-only' if cfg.read_only else 'creates cs-acc-* objects and removes them'}{', dev-auth' if cfg.dev_auth else ''}\n", flush=True)
    if cfg.insecure_tls:
        r.notes.append("TLS certificates were not verified for the HTTP checks (isolated test CA or --insecure); S6 still checks the chain")
    ses = auth.Sessions(cfg, h)
    made = []
    # run order: the migration runs before the branding scan so that its documents are scanned too
    order = ["install", "auth", "migration", "branding", "gateway", "backup", "upgrade", "security"]
    titles = dict(GROUPS)
    for gid in order:
        title = titles[gid]
        if not cfg.want(gid):
            continue
        if gid == "upgrade" and cfg.want("backup"):
            continue  # written together with the backup group
        print(f"\n== {title}" + (" / Upgrade & rollback" if gid == "backup" else ""), flush=True)
        try:
            if gid == "install":
                install.run(cfg, h, r)
            elif gid == "auth":
                auth.run(cfg, h, r, ses)
            elif gid == "migration":
                made = migration.run(cfg, h, r, ses)
            elif gid == "branding":
                branding.run(cfg, h, r, ses, made)
            elif gid == "gateway":
                gateway_rules.run(cfg, h, r, ses)
            elif gid == "backup" or (gid == "upgrade" and not cfg.want("backup")):
                ops.run(cfg, h, r)  # writes the backup and the upgrade group
            elif gid == "security":
                security.run(cfg, h, r, ses)
        except Exception as e:  # a crashed group must not hide the others
            r.add(f"{gid[:1].upper()}!", gid, f"{title}: the group stopped", FAIL, f"{type(e).__name__}: {e}")
    jp, hp = r.write()
    tot = {}
    for res in r.results:
        tot[res.status] = tot.get(res.status, 0) + 1
    print(f"\nresult: {tot}\nreport: {jp}\n        {hp}")
    return sum(1 for res in r.results if res.status == FAIL)


if __name__ == "__main__":
    sys.exit(min(main(), 100))
