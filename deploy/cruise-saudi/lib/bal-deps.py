#!/usr/bin/env python3
"""List every Ballerina package version the migrated services and the framework depend on
(services/*/Dependencies.toml, framework/*/Dependencies.toml, Dependencies.toml) and where it
comes from: the Ballerina distribution or the Central cache. Exit 1 when one is missing.

usage: bal-deps.py <platform dir> <central cache bala dir> <distribution bala dir>
"""
import glob
import os
import sys
import tomllib

src, cache, dist = sys.argv[1:4]
OWN = ("aroya", "traceit")          # the platform's own packages, built from the workspace
need = {}
files = glob.glob(f"{src}/services/*/Dependencies.toml") + glob.glob(f"{src}/framework/*/Dependencies.toml") \
    + glob.glob(f"{src}/Dependencies.toml")
for f in files:
    with open(f, "rb") as fh:
        for p in tomllib.load(fh).get("package", []):
            if p["org"] in OWN:
                continue
            need.setdefault(f'{p["org"]}/{p["name"]}', set()).add(p["version"])
missing = []
for pkg, versions in sorted(need.items()):
    for v in sorted(versions):
        where = "distribution" if os.path.isdir(f"{dist}/{pkg}/{v}") else "cache" if os.path.isdir(f"{cache}/{pkg}/{v}") else None
        print(f"{pkg}:{v}\t{where or 'MISSING'}")
        if not where:
            missing.append(f"{pkg}:{v}")
print(f"# {len(files)} Dependencies.toml files, {sum(len(v) for v in need.values())} package versions, missing: {len(missing)}")
sys.exit(1 if missing else 0)
