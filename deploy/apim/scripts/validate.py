#!/usr/bin/env python3
"""Validate an H2 snapshot taken by snapshot.sh before anything is allowed to trust it.

  validate.py <snapshot-dir> <rest-truth.json>
  validate.py dbdiff <snapshot-dir-a> <snapshot-dir-b> [--ignore-test]   compare two validated snapshots

What it does (in the throwaway `apim-tools` pod, i.e. with the H2 jar that ships in the image):
  1. works on a duplicate (<snap>/check) so <snap>/raw stays byte-identical to what blue had;
  2. opens every database and runs a full `SCRIPT` export of it, which reads every row and LOB
     (a torn MVStore copy fails here); the export is deleted again straight away;
  3. dumps the identifying columns of the key tables to CSV (no secrets, no tokens) and builds
     <snap>/dbtruth.json;
  4. compares that with the REST ground truth recorded from blue by truth.py.
Exit 0 and writes <snap>/VALIDATED only when everything matches.
"""
from __future__ import annotations
import csv, hashlib, json, os, shutil, subprocess, sys
from apimlib import toml_from_configmap, toml_value

ROOT = os.environ.get("APIM_BG_ROOT", "/root/apim-bluegreen")
DBS = ["WSO2AM_DB", "WSO2SHARED_DB", "WSO2CARBON_DB", "WSO2MB_DB", "WSO2METRICS_DB"]

AM_QUERIES = {
    "apis": "SELECT API_UUID, API_NAME, API_VERSION, CONTEXT, STATUS, API_TYPE FROM AM_API ORDER BY 1",
    "applications": "SELECT UUID, NAME, APPLICATION_STATUS, APPLICATION_TIER, CREATED_BY FROM AM_APPLICATION ORDER BY 1",
    "subscriptions": "SELECT S.UUID, A.UUID AS APP_UUID, P.API_UUID, S.TIER_ID, S.SUB_STATUS FROM AM_SUBSCRIPTION S JOIN AM_APPLICATION A ON A.APPLICATION_ID=S.APPLICATION_ID JOIN AM_API P ON P.API_ID=S.API_ID ORDER BY 1",
    "key_mappings": "SELECT K.CONSUMER_KEY, A.UUID AS APP_UUID, K.KEY_TYPE, K.STATE, K.KEY_MANAGER FROM AM_APPLICATION_KEY_MAPPING K JOIN AM_APPLICATION A ON A.APPLICATION_ID=K.APPLICATION_ID ORDER BY 1",
    "oauth_apps": "SELECT CONSUMER_KEY, APP_NAME, USERNAME, GRANT_TYPES, APP_STATE, CALLBACK_URL FROM IDN_OAUTH_CONSUMER_APPS ORDER BY 1",
    "sp_apps": "SELECT APP_NAME, USERNAME, UUID FROM SP_APP ORDER BY 1",
    "revisions": "SELECT REVISION_UUID, API_UUID, ID FROM AM_REVISION ORDER BY 1",
    "deployments": "SELECT REVISION_UUID, NAME, VHOST, DISPLAY_ON_DEVPORTAL FROM AM_DEPLOYMENT_REVISION_MAPPING ORDER BY 1, 2",
    "gw_artifacts": "SELECT API_ID, REVISION_ID, OCTET_LENGTH(ARTIFACT) AS BYTES FROM AM_GW_API_ARTIFACTS ORDER BY 1, 2",
    "gw_deployments": "SELECT API_ID, REVISION_ID, LABEL, VHOST FROM AM_GW_API_DEPLOYMENTS ORDER BY 1, 2, 3",
    "gw_published": "SELECT API_ID, API_NAME, API_VERSION, API_TYPE FROM AM_GW_PUBLISHED_API_DETAILS ORDER BY 1",
    "policies_api": "SELECT NAME, UUID, DEFAULT_QUOTA, DEFAULT_UNIT_TIME, DEFAULT_TIME_UNIT, IS_DEPLOYED FROM AM_API_THROTTLE_POLICY ORDER BY 1",
    "policies_subscription": "SELECT NAME, UUID, QUOTA, UNIT_TIME, TIME_UNIT, IS_DEPLOYED FROM AM_POLICY_SUBSCRIPTION ORDER BY 1",
    "policies_application": "SELECT NAME, UUID, QUOTA, UNIT_TIME, TIME_UNIT, IS_DEPLOYED FROM AM_POLICY_APPLICATION ORDER BY 1",
    "key_managers": "SELECT UUID, NAME, TYPE, ENABLED FROM AM_KEY_MANAGER ORDER BY 1",
    "url_mappings": "SELECT COUNT(*) AS N FROM AM_API_URL_MAPPING",
    "scopes": "SELECT COUNT(*) AS N FROM IDN_OAUTH2_SCOPE",
}
SHARED_QUERIES = {
    "users": "SELECT UM_USER_NAME, UM_TENANT_ID FROM UM_USER ORDER BY 1",
    "roles": "SELECT UM_ROLE_NAME, UM_TENANT_ID FROM UM_ROLE ORDER BY 1",
    "hybrid_roles": "SELECT UM_ROLE_NAME, UM_TENANT_ID FROM UM_HYBRID_ROLE ORDER BY 1",
    "registry_resources": "SELECT COUNT(*) AS N FROM REG_RESOURCE",
    "registry_content": "SELECT COUNT(*) AS N FROM REG_CONTENT",
}


def run_h2(snap_name, db, sql_text, password):
    """Run a SQL script against <snap>/check/<db> inside the tools pod. Password goes via stdin."""
    sql_path = os.path.join(ROOT, "snap", snap_name, "check", f"{db}.q.sql")
    with open(sql_path, "w") as f:
        f.write(sql_text)
    p = subprocess.run(
        ["kubectl", "-n", "apim", "exec", "-i", "apim-tools", "--", "/work/bin/h2q.sh",
         f"/work/{snap_name}/check/{db}", f"/work/{snap_name}/check/{db}.q.sql"],
        input=password + "\n", text=True, capture_output=True)
    os.remove(sql_path)
    return p.returncode, (p.stdout + p.stderr)


def dump(snap_name, db, queries, passwords):
    out_dir = os.path.join(ROOT, "snap", snap_name, "dump")
    os.makedirs(out_dir, exist_ok=True)
    full = f"/work/{snap_name}/check/{db}.full.sql"
    sql = [f"SCRIPT TO '{full}';"]
    for name, q in queries.items():
        sql.append("CALL CSVWRITE('/work/%s/dump/%s.csv', '%s');" % (snap_name, name, q.replace("'", "''")))
    last = ""
    for pw in passwords:
        rc, last = run_h2(snap_name, db, "\n".join(sql) + "\n", pw)
        if rc == 0:
            break
    host_full = os.path.join(ROOT, "snap", snap_name, "check", f"{db}.full.sql")
    size = os.path.getsize(host_full) if os.path.exists(host_full) else -1
    if os.path.exists(host_full):
        os.remove(host_full)          # contains hashed credentials: never keep it
    if rc != 0:
        tail = [l for l in last.splitlines() if "password" not in l.lower()][-3:]
        raise SystemExit(f"FAIL: {db} did not open / export cleanly: {' | '.join(tail)[:400]}")
    res = {}
    for name in queries:
        with open(os.path.join(out_dir, f"{name}.csv"), newline="") as f:
            res[name] = list(csv.DictReader(f))
    return res, size


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def image_default_sums():
    out = subprocess.check_output(
        ["kubectl", "-n", "apim", "exec", "apim-tools", "--", "bash", "-c",
         "cd /home/wso2carbon/wso2am-4.5.0/repository/database && sha256sum *.mv.db"], text=True)
    return {l.split()[1]: l.split()[0] for l in out.splitlines() if l.strip()}


def build(snap_dir):
    name = os.path.basename(os.path.normpath(snap_dir))
    raw, check = os.path.join(snap_dir, "raw"), os.path.join(snap_dir, "check")
    shutil.rmtree(check, ignore_errors=True)
    os.makedirs(check, mode=0o700)
    for db in DBS:
        shutil.copy2(os.path.join(raw, db + ".mv.db"), check)
    shutil.copy2(os.path.join(os.path.dirname(os.path.abspath(__file__)), "h2q.sh"),
                 os.path.join(ROOT, "snap", "bin", "h2q.sh"))
    toml = toml_from_configmap()
    pw = [toml_value(toml, "database.apim_db", "password") or "wso2carbon",
          toml_value(toml, "database.shared_db", "password") or "wso2carbon", "wso2carbon"]
    db = {"exportBytes": {}}
    am, db["exportBytes"]["WSO2AM_DB"] = dump(name, "WSO2AM_DB", AM_QUERIES, pw)
    sh, db["exportBytes"]["WSO2SHARED_DB"] = dump(name, "WSO2SHARED_DB", SHARED_QUERIES, pw)
    stock = image_default_sums()
    for other in DBS[2:]:
        if stock.get(other + ".mv.db") == sha256(os.path.join(raw, other + ".mv.db")):
            # Byte-identical to the file shipped in the image: blue never wrote to it (the stock
            # WSO2METRICS_DB is even in an older H2 file format that 2.3 refuses to open, and is
            # unused because the JDBC metrics reporter is off). Nothing to validate.
            db["exportBytes"][other] = 0
            db.setdefault("imageDefault", []).append(other)
            continue
        _, db["exportBytes"][other] = dump(name, other, {}, pw)
    db.update(am)
    db.update(sh)
    shutil.rmtree(check, ignore_errors=True)
    shutil.rmtree(os.path.join(snap_dir, "dump"), ignore_errors=True)
    with open(os.path.join(snap_dir, "dbtruth.json"), "w") as f:
        json.dump(db, f, indent=1, sort_keys=True)
    return db


def compare(db, t):
    """DB snapshot vs REST truth. Returns list of problems."""
    bad = []

    def same(label, a, b):
        a, b = sorted(a), sorted(b)
        if a != b:
            bad.append(f"{label}: snapshot has {len(a)}, REST has {len(b)}; "
                       f"only in snapshot {sorted(set(a) - set(b))[:5]}, only in REST {sorted(set(b) - set(a))[:5]}")

    same("APIs (uuid,name,version,status)",
         [(r["API_UUID"], r["API_NAME"], r["API_VERSION"], r["STATUS"]) for r in db["apis"]],
         [(a["id"], a["name"], a["version"], a["lifeCycleStatus"]) for a in t["apis"]]
         + [(p["id"], p["name"], "1.0.0", p.get("state")) for p in t.get("apiProducts", [])])
    same("applications (uuid,name,status)",
         [(r["UUID"], r["NAME"], r["APPLICATION_STATUS"]) for r in db["applications"]],
         [(a["applicationId"], a["name"], a["status"]) for a in t["applications"]])
    known_apps = {a["applicationId"] for a in t["applications"] if a["keys"] is not None}
    same("subscriptions (uuid,app,api,tier,status)",
         [(r["UUID"], r["APP_UUID"], r["API_UUID"], r["TIER_ID"], r["SUB_STATUS"])
          for r in db["subscriptions"] if r["APP_UUID"] in known_apps],
         [(s["subscriptionId"], s["applicationId"], s["apiId"], s["throttlingPolicy"], s["status"])
          for s in t["subscriptions"]])
    same("application key mappings (consumerKey,app,type)",
         [(r["CONSUMER_KEY"], r["APP_UUID"], r["KEY_TYPE"]) for r in db["key_mappings"]
          if r["APP_UUID"] in known_apps],
         [(k["consumerKey"], a["applicationId"], k["keyType"])
          for a in t["applications"] for k in (a["keys"] or [])])
    oauth = {r["CONSUMER_KEY"] for r in db["oauth_apps"]}
    for r in db["key_mappings"]:
        if r["CONSUMER_KEY"] not in oauth:
            bad.append(f"consumer key {r['CONSUMER_KEY'][:6]}... has no IDN_OAUTH_CONSUMER_APPS row")
    same("deployed revisions (revision,gateway)",
         [(r["REVISION_UUID"], r["NAME"]) for r in db["deployments"]],
         [(rv["id"], d["name"]) for a in t["apis"] for rv in a["deployedRevisions"] for d in rv["deployments"]])
    art = {(r["API_ID"], r["REVISION_ID"]): int(r["BYTES"] or 0) for r in db["gw_artifacts"]}
    for a in t["apis"]:
        for rv in a["deployedRevisions"]:
            if art.get((a["id"], rv["id"]), 0) <= 0:
                bad.append(f"no gateway artifact stored for {a['name']} {rv['displayName']}")
    for kind, table in (("advanced", "policies_api"), ("subscription", "policies_subscription"),
                        ("application", "policies_application")):
        rest = t["policies"].get(kind)
        if not isinstance(rest, list):
            bad.append(f"REST truth has no {kind} policy list")
            continue
        names = {r["NAME"] for r in db[table]}
        missing = {p["policyName"] for p in rest} - names
        if missing:
            bad.append(f"{kind} policies missing in snapshot: {sorted(missing)}")
    same("key managers", [r["NAME"] for r in db["key_managers"]], [k["name"] for k in t["keyManagers"]])
    if not db["users"]:
        bad.append("user store (UM_USER) is empty")
    if int(db["registry_resources"][0]["N"]) < 10:
        bad.append("registry looks empty")
    return bad


VOLATILE = ("exportBytes", "imageDefault")


COUNT_ONLY = ("url_mappings", "scopes", "registry_resources", "registry_content")


def strip_test_rows(db):
    """Drop the rows that belong to test APIs (name/context starting with weave, sample or e2e):
    those are re-created by the Weave runtime after a switch and are no reason to re-seed."""
    from truth import TEST
    uuids = {r["API_UUID"] for r in db.get("apis", [])
             if TEST.match(r.get("API_NAME") or "") or TEST.match(r.get("CONTEXT") or "")}
    if not uuids:
        return db, 0
    db = dict(db)
    revs = {r["REVISION_UUID"] for r in db.get("revisions", []) if r["API_UUID"] in uuids}
    db["apis"] = [r for r in db["apis"] if r["API_UUID"] not in uuids]
    db["revisions"] = [r for r in db.get("revisions", []) if r["API_UUID"] not in uuids]
    db["subscriptions"] = [r for r in db.get("subscriptions", []) if r["API_UUID"] not in uuids]
    db["deployments"] = [r for r in db.get("deployments", []) if r["REVISION_UUID"] not in revs]
    for k in ("gw_artifacts", "gw_deployments", "gw_published"):
        db[k] = [r for r in db.get(k, []) if r["API_ID"] not in uuids]
    for k in COUNT_ONLY:          # plain row counts cannot be attributed to an API
        db.pop(k, None)
    return db, len(uuids)


def dbdiff(a, b, ignore_test=False):
    lines = []
    if ignore_test:
        a, na = strip_test_rows(a)
        b, nb = strip_test_rows(b)
        if na or nb:
            print(f"ignored test APIs: {na} in A, {nb} in B (row-count tables not compared)")
            a = {k: v for k, v in a.items() if k not in COUNT_ONLY}
            b = {k: v for k, v in b.items() if k not in COUNT_ONLY}
    for k in sorted(set(a) | set(b)):
        if k in VOLATILE:
            continue
        ra = sorted(json.dumps(r, sort_keys=True) for r in a.get(k, []))
        rb = sorted(json.dumps(r, sort_keys=True) for r in b.get(k, []))
        if ra != rb:
            only_a, only_b = sorted(set(ra) - set(rb)), sorted(set(rb) - set(ra))
            lines.append(f"{k}: {len(only_a)} row(s) only in A, {len(only_b)} only in B")
            for r in only_a[:8]:
                lines.append(f"   A {r[:200]}")
            for r in only_b[:8]:
                lines.append(f"   B {r[:200]}")
    return lines


def main():
    if len(sys.argv) >= 4 and sys.argv[1] == "dbdiff":
        a = json.load(open(os.path.join(sys.argv[2], "dbtruth.json")))
        b = json.load(open(os.path.join(sys.argv[3], "dbtruth.json")))
        lines = dbdiff(a, b, "--ignore-test" in sys.argv)
        print("\n".join(lines) if lines else "IDENTICAL (key tables)")
        return 1 if lines else 0
    if len(sys.argv) != 3:
        print(__doc__)
        return 2
    snap, truth_file = sys.argv[1].rstrip("/"), sys.argv[2]
    marker = os.path.join(snap, "VALIDATED")
    if os.path.exists(marker):
        os.remove(marker)
    db = build(snap)
    t = json.load(open(truth_file))
    print("opened + fully exported with the image's H2: " +
          ", ".join(f"{k} {v // 1024} KiB" if v else f"{k} (untouched image default, skipped)"
                    for k, v in db["exportBytes"].items()))
    print("rows: " + ", ".join(f"{k}={v[0]['N'] if len(v) == 1 and 'N' in v[0] else len(v)}"
                               for k, v in db.items() if k not in VOLATILE))
    bad = compare(db, t)
    if bad:
        print("SNAPSHOT DOES NOT MATCH REST TRUTH:")
        for b in bad:
            print("  - " + b)
        return 1
    with open(marker, "w") as f:
        f.write(f"validated against {os.path.basename(truth_file)}\n")
    print("VALIDATED: snapshot matches the REST ground truth")
    return 0


if __name__ == "__main__":
    sys.exit(main())
