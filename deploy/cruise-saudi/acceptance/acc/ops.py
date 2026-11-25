"""Backup & restore, upgrade & rollback. The installer (`cs/installer`, deploy/cruise-saudi/) ships the
scripts; the harness checks they are there, that a backup really produces a complete archive (only on
an isolated test install or with ACC_RUN_BACKUP=1), and leaves the destructive round trips to the
checklist unless ACC_DESTRUCTIVE=1 on an isolated test install.

Script names (relative to --install-dir) can be changed with ACC_BACKUP_CMD, ACC_RESTORE_CMD,
ACC_UPGRADE_CMD, ACC_ROLLBACK_CMD.
"""
from __future__ import annotations

import glob
import os
import shlex
import tarfile
import time
import zipfile

from .core import Config, Http, Run, PASS, FAIL, WAITING, SKIP, MANUAL, sh, short


def _script(cfg: Config, env: str, default: str):
    rel = cfg.secret(env, default)
    if not cfg.install_dir:
        return None, "no install directory (--install-dir)"
    p = os.path.join(cfg.install_dir, rel.split()[0])
    if not os.path.exists(p):
        return None, f"{rel.split()[0]} not in {cfg.install_dir} yet (cs/installer)"
    return [p] + rel.split()[1:], ""


def _help(cmd):
    rc, out = sh(["bash"] + cmd + ["--help"], 30)
    return rc, out


def run(cfg: Config, h: Http, r: Run):
    G = "backup"
    iso = ["--isolated-test"] if cfg.isolated else []

    def present(env, default):
        def f():
            cmd, why = _script(cfg, env, default)
            if not cmd:
                return WAITING, why
            rc, out = _help(cmd)
            return (PASS if rc == 0 and len(out) > 20 else FAIL), f"{cmd[0]} --help -> exit {rc}: {short(out, 140)}"
        return f
    r.check("K1", G, "Backup and restore commands are installed and documented", lambda: _both(present("ACC_BACKUP_CMD", "backup.sh")(), present("ACC_RESTORE_CMD", "restore.sh")()))

    def backup():
        if cfg.read_only:
            return SKIP, "read-only run"
        if not (cfg.isolated or cfg.secret("ACC_RUN_BACKUP") == "1"):
            return SKIP, "runs only on an isolated test install or with ACC_RUN_BACKUP=1"
        cmd, why = _script(cfg, "ACC_BACKUP_CMD", "backup.sh")
        if not cmd:
            return WAITING, why
        out_dir = os.path.join(cfg.out_dir, "backup")
        os.makedirs(out_dir, exist_ok=True)
        prefix = shlex.split(cfg.secret("ACC_HEAVY_PREFIX", ""))
        t0 = time.time()
        rc, out = sh(prefix + ["bash"] + cmd + iso + [cfg.secret("ACC_BACKUP_TARGET_FLAG", "--target"), out_dir], 5400)
        files = [p for p in glob.glob(os.path.join(out_dir, "**", "*"), recursive=True) if os.path.isfile(p)]
        if rc != 0 or not files:
            return FAIL, f"backup exit {rc}, {len(files)} files: {short(out, 200)}"
        names = []
        for p in files:
            try:
                if tarfile.is_tarfile(p):
                    names += tarfile.open(p).getnames()
                elif zipfile.is_zipfile(p):
                    names += zipfile.ZipFile(p).namelist()
                else:
                    names.append(os.path.basename(p))
            except Exception:
                names.append(os.path.basename(p))
        blob = " ".join(names).lower()
        parts = {"factory data": any(k in blob for k in ("weave-data", "factory")), "api manager": any(k in blob for k in ("apim_db", "apim-volume", "am_db")),
                 "migration tool": "migration-tool" in blob, "settings": any(k in blob for k in ("etc.tgz", "secrets", "weave.conf"))}
        def shut(p):  # readable by root only: the file itself, or a 700 directory above it inside out_dir
            d = os.path.dirname(p)
            while d.startswith(out_dir) and len(d) > len(out_dir):
                if not os.stat(d).st_mode & 0o077:
                    return True
                d = os.path.dirname(d)
            return not os.stat(p).st_mode & 0o077
        loose = [p for p in files if not shut(p)]
        size = sum(os.path.getsize(p) for p in files)
        ev = f"{len(files)} files, {size // 1024} KiB in {time.time() - t0:.0f}s; parts {parts}; readable by others: {len(loose)}"
        return (PASS if all(parts.values()) and not loose else FAIL), ev
    r.check("K2", G, "A backup produces a complete archive (Factory data, API Manager, settings), readable by root only", backup)

    def restore():
        if not (cfg.isolated and cfg.secret("ACC_DESTRUCTIVE") == "1" and not cfg.read_only):
            return MANUAL, "restore the backup of K2 onto a fresh isolated install and confirm migrations, users, APIs, keys and gateway rules are back (checklist 6.3); automated only with --isolated-test and ACC_DESTRUCTIVE=1"
        cmd, why = _script(cfg, "ACC_RESTORE_CMD", "restore.sh")
        if not cmd:
            return WAITING, why
        arch = sorted(glob.glob(os.path.join(cfg.out_dir, "backup", "*")))
        if not arch:
            return FAIL, "no archive from K2"
        before = h.get(cfg.factory_url.rstrip("/") + "/api/factory/migrations", timeout=30).text
        rc, out = sh(["bash"] + cmd + iso + [arch[-1]], 3600)
        after = h.get(cfg.factory_url.rstrip("/") + "/api/factory/migrations", timeout=30).text
        return (PASS if rc == 0 and before == after else FAIL), f"restore exit {rc}; migration list same as before: {before == after}"
    r.check("K3", G, "Restore brings everything back", restore)

    G = "upgrade"
    def upgrade_rollback():
        up = present("ACC_UPGRADE_CMD", "upgrade.sh")()
        rb = present("ACC_ROLLBACK_CMD", "rollback.sh")()
        st_, ev = _both(up, rb)
        if rb[0] == WAITING and "rollback" in up[1].lower():
            ev += " (upgrade.sh rolls back by itself when an upgrade fails; a rollback after a successful upgrade has no command)"
        return st_, ev
    r.check("U1", G, "Upgrade and rollback commands are installed and documented", upgrade_rollback)
    r.add("U2", G, "Upgrade N-1 -> N keeps data; rollback N -> N-1 works; both within the agreed window", MANUAL,
          "on the isolated install: note version (I7), back up, upgrade, rerun this harness, roll back, rerun (checklist 7)")


def _both(a, b):
    sa, ea = a
    sb, eb = b
    order = [FAIL, WAITING, SKIP, PASS]
    worst = min((sa, sb), key=lambda s: order.index(s) if s in order else 0)
    return worst, f"{ea} | {eb}"
