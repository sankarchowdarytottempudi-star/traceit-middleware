#!/usr/bin/env python3
"""Verification gate: is the TARGET APIM instance a faithful, working copy of the REFERENCE?

Before the switch:  reference = blue on the live NodePorts, target = green on its verification ports
    gate.py --label first-boot
After the switch:   reference = blue addressed by pod IP, target = the live NodePorts (now green)
    gate.py --label post-switch --ref-pod-ip <blue pod ip> \
            --target-mgmt https://127.0.0.1:30443 --target-gw https://127.0.0.1:30243 \
            --target-gw-http http://127.0.0.1:30280

Exit 0 only if every check passed. A report is written to /root/apim-bluegreen/gate-<label>.txt.
Only read-only / self-rejecting requests are sent: no writes, bookings or payments. Secrets and
tokens stay in memory; the report contains neither.
"""
from __future__ import annotations
import argparse, hashlib, json, os, subprocess, sys, time, urllib.parse
import truth as truthmod
from apimlib import Apim, admin_credentials, basic, http

ROOT = os.environ.get("APIM_BG_ROOT", "/root/apim-bluegreen")
LOG_DIR = "/var/log/weave/apim"
CONNECTOR_APP = "aroya-connector"
# A read-only request per API context that is known to be answered by the backend.
SAFE_GET = {"/cms": "/descriptions/ctgs-descriptions"}
# Everything else that accepts GET gets the backend's own health resource (read-only).
DEFAULT_GET = "/live"

results = []


def check(name, ok, detail=""):
    results.append((name, bool(ok), detail))
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f"  ({detail})" if detail else ""), flush=True)
    return bool(ok)


def sh(cmd):
    return subprocess.run(cmd, shell=True, text=True, capture_output=True).stdout.strip()


def metric_lines():
    try:
        with open(os.path.join(LOG_DIR, "apim_metrics.log"), "rb") as f:
            return sum(1 for _ in f)
    except OSError:
        return -1


def gw(base, method, path, token=None, body=None):
    h = {"Accept": "application/json"}
    if token:
        h["Authorization"] = "Bearer " + token
    if body is not None:
        h["Content-Type"] = "application/json"
    st, raw = http(method, base + path, h, body, timeout=90, raw=True)
    code = ""
    try:
        code = str(json.loads(raw.decode("utf-8", "replace")).get("code", ""))
    except Exception:
        pass
    return st, code, hashlib.sha256(raw).hexdigest()[:12], len(raw)


def client_token(mgmt, key, secret):
    st, tok = http("POST", mgmt + "/oauth2/token",
                   {"Authorization": basic(key, secret),
                    "Content-Type": "application/x-www-form-urlencoded"},
                   "grant_type=client_credentials")
    return st, (tok.get("access_token") if isinstance(tok, dict) else None)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--label", required=True)
    ap.add_argument("--ref-mgmt", default="https://127.0.0.1:30443")
    ap.add_argument("--ref-gw", default="https://127.0.0.1:30243")
    ap.add_argument("--ref-gw-http", default="http://127.0.0.1:30280")
    ap.add_argument("--ref-pod-ip", default="")
    ap.add_argument("--target-mgmt", default="https://127.0.0.1:31443")
    ap.add_argument("--target-gw", default="https://127.0.0.1:31243")
    ap.add_argument("--target-gw-http", default="http://127.0.0.1:31280")
    ap.add_argument("--ignore-test", action="store_true",
                    help="tolerate weave*/sample*/e2e* test APIs that exist on one side only")
    ap.add_argument("--skip-analytics", action="store_true")
    a = ap.parse_args()
    if a.ref_pod_ip:
        a.ref_mgmt = f"https://{a.ref_pod_ip}:9443"
        a.ref_gw = f"https://{a.ref_pod_ip}:8243"
        a.ref_gw_http = f"http://{a.ref_pod_ip}:8280"

    blue_pod = json.loads(sh("kubectl -n apim get pod -l app=wso2am -o json"))["items"][0]
    blue_before = (blue_pod["metadata"]["uid"], blue_pod["status"]["containerStatuses"][0]["restartCount"],
                   sh("kubectl -n apim get deploy wso2am -o jsonpath='{.metadata.generation}'"),
                   sh("kubectl -n apim get cm apim-conf -o jsonpath='{.metadata.resourceVersion}'"))
    green_ip = sh("kubectl -n apim get pod -l app=wso2am-green -o jsonpath='{.items[0].status.podIP}'")

    user, password = admin_credentials()
    ref, tgt = Apim(a.ref_mgmt, user, password), Apim(a.target_mgmt, user, password)

    # 1. REST ground truth on both sides
    t_ref = truthmod.collect(a.ref_mgmt)
    t_tgt = truthmod.collect(a.target_mgmt)
    stamp = time.strftime("%H%M%S", time.gmtime())
    for side, t in (("ref", t_ref), ("target", t_tgt)):
        with open(os.path.join(ROOT, "truth", f"gate-{a.label}-{side}-{stamp}.json"), "w") as f:
            json.dump(t, f, indent=1, sort_keys=True)
    lines, dropped = truthmod.diff(t_ref, t_tgt, a.ignore_test)
    check("REST truth identical (APIs, revisions, applications, subscriptions, key mappings, policies, key managers)",
          not lines, truthmod.summary(t_tgt) + (f"; ignored test APIs ref/target={dropped}" if a.ignore_test else "")
          + ("; first diffs: " + " ; ".join(l.strip() for l in lines[:4]) if lines else ""))
    apis = t_tgt["apis"] if not a.ignore_test else truthmod.strip_test(t_tgt)[0]["apis"]
    check("every API is PUBLISHED and has a revision deployed on the Default gateway",
          apis and all(x["lifeCycleStatus"] == "PUBLISHED" and
                       any(d["name"] == "Default" for r in x["deployedRevisions"] for d in r["deployments"])
                       for x in apis), f"{len(apis)} APIs")
    check("DCR endpoint returns the same client for the same name (state restored, DCR works)",
          ref.token() and tgt.token() and ref.dcr_client_id == tgt.dcr_client_id)

    # 2. the connector's existing key + secret
    def connector(api, t):
        app = next((x for x in t["applications"] if x["name"] == CONNECTOR_APP), None)
        keys = api.app_keys(app["applicationId"]) if app else []
        k = next((k for k in keys if k.get("keyType") == "PRODUCTION"), None)
        return (k or {}).get("consumerKey"), (k or {}).get("consumerSecret")
    rk, rs = connector(ref, t_ref)
    tk, ts = connector(tgt, t_tgt)
    check(f"{CONNECTOR_APP}: consumer key and secret on target equal the reference", rk and rk == tk and rs and rs == ts)
    st_t, tok_t = client_token(a.target_mgmt, rk, rs)
    check(f"{CONNECTOR_APP}: existing key+secret obtain a token from target", st_t == 200 and tok_t, f"HTTP {st_t}")
    st_r, tok_r = client_token(a.ref_mgmt, rk, rs)
    check(f"{CONNECTOR_APP}: reference still issues tokens", st_r == 200 and tok_r, f"HTTP {st_r}")

    # 3. traffic through the gateway ports, target vs reference
    before = metric_lines()
    authed = 0
    for api in apis:
        ctx = f"{api['context']}/{api['version']}"
        verbs = {o["verb"] for o in api["operations"]}
        first = sorted(api["operations"], key=lambda o: (o["verb"] != "GET", o["target"]))[0]
        path = SAFE_GET.get(api["context"])
        if path is None:
            path = DEFAULT_GET if "GET" in verbs else first["target"].replace("/*", "/live")
        url = ctx + path
        probe_verb = first["verb"] if "GET" not in verbs else "GET"
        # Test APIs of other streams (weave*/sample*/e2e*) have resources and subscribers we know
        # nothing about: for those the target only has to answer exactly like the reference.
        known = not truthmod.is_test_api(api)
        for label, rbase, tbase in (("https", a.ref_gw, a.target_gw), ("http", a.ref_gw_http, a.target_gw_http)):
            # no credentials and a garbage token: both rejected by the gateway itself (never reach a backend)
            r, t = gw(rbase, probe_verb, url), gw(tbase, probe_verb, url)
            check(f"{ctx} [{label}] no token -> same rejection", r[:2] == t[:2] and (t[0] == 401 or not known), f"ref {r[0]}/{r[1]} target {t[0]}/{t[1]}")
            r, t = gw(rbase, probe_verb, url, "not-a-real-token"), gw(tbase, probe_verb, url, "not-a-real-token")
            check(f"{ctx} [{label}] invalid token -> same rejection", r[:2] == t[:2] and (t[0] == 401 or not known), f"ref {r[0]}/{r[1]} target {t[0]}/{t[1]}")
            # with a valid token: GET only (read-only). POST-only APIs get a GET, which the gateway
            # answers itself with 405 without calling the backend.
            r = gw(rbase, "GET", url, tok_r)
            t = gw(tbase, "GET", url, tok_t)
            authed += 1
            # same status, same fault code and same body size (bodies carry timestamps, so the
            # hash is only compared when it happens to match)
            same = r[0] == t[0] and r[1] == t[1] and (r[2] == t[2] or r[3] == t[3])
            check(f"{ctx} [{label}] GET {path} with own token -> same answer", same and (t[0] not in (401, 403, 500, 502, 503) or not known),
                  f"ref {r[0]}{'/' + r[1] if r[1] else ''} ({r[3]} bytes) target {t[0]}{'/' + t[1] if t[1] else ''} ({t[3]} bytes)")
            x = gw(tbase, "GET", url, tok_r)
            authed += 1
            check(f"{ctx} [{label}] token issued by reference accepted by target", x[0] == t[0], f"{x[0]}")
    # one explicit, known-good business read
    cms = gw(a.target_gw_http, "GET", "/cms/v1/descriptions/ctgs-descriptions", tok_t)
    authed += 1
    check("GET /cms/v1/descriptions/ctgs-descriptions through target gateway -> 200 with a body", cms[0] == 200 and cms[3] > 1000, f"{cms[0]}, {cms[3]} bytes")

    # 4. consoles, OAuth and discovery endpoints
    for path in ("/publisher/", "/devportal/", "/admin/", "/carbon/admin/login.jsp",
                 "/oauth2/token/.well-known/openid-configuration", "/services/Version",
                 "/api/am/publisher/v4/swagger.yaml", "/api/am/devportal/v3/apis"):
        r = http("GET", a.ref_mgmt + path, raw=True)[0]
        t = http("GET", a.target_mgmt + path, raw=True)[0]
        check(f"GET {path} answers like the reference", r == t and t < 500, f"ref {r} target {t}")
    jr = http("GET", a.ref_mgmt + "/oauth2/jwks")[1]
    jt = http("GET", a.target_mgmt + "/oauth2/jwks")[1]
    kid = lambda j: sorted(k.get("kid", "") for k in j.get("keys", [])) if isinstance(j, dict) else None
    check("JWKS (token signing keys) identical", kid(jt) and kid(jr) == kid(jt))
    try:
        dbt = json.load(open(os.path.join(ROOT, "seed", "dbtruth.json")))
        consoles = [r for r in dbt["oauth_apps"] if r["CALLBACK_URL"].startswith("https://") and "traceit-tottech.com" in r["CALLBACK_URL"]]
    except OSError:
        consoles = []
    check("console sign-in clients found in the seed snapshot", len(consoles) >= 2, ", ".join(c["APP_NAME"] for c in consoles))
    for c in consoles:
        q = urllib.parse.urlencode({"response_type": "code", "client_id": c["CONSUMER_KEY"],
                                    "redirect_uri": c["CALLBACK_URL"], "scope": "openid", "state": "gate"})
        locs = []
        for base in (a.ref_mgmt, a.target_mgmt):
            st, _, h = http("GET", f"{base}/oauth2/authorize?{q}", want_headers=True)
            loc = urllib.parse.urlsplit(h.get("Location", ""))
            locs.append((st, loc.netloc, loc.path))
        check(f"/oauth2/authorize for console client {c['APP_NAME']} redirects to the login page like the reference",
              locs[0] == locs[1] and locs[1][0] == 302 and "authenticationendpoint" in locs[1][2], f"{locs[1][0]} -> {locs[1][1]}{locs[1][2]}")

    # 5. analytics: one line per request in apim_metrics.log, readable by the Weave Gateway uid
    if not a.skip_analytics:
        time.sleep(6)
        after = metric_lines()
        check("apim_metrics.log received at least one line per authenticated gateway request",
              before >= 0 and after - before >= authed, f"{after - before} new lines for {authed} authenticated requests (plus rejected ones)")
        last = sh(f"tail -n 1 {LOG_DIR}/apim_metrics.log")
        check("metrics line is a native analytics event", "apimMetrics" in last and "apiName" in last, last[:60].replace("\n", " "))
        for f in ("apim_metrics.log", "wso2carbon.log", "http_access.log"):
            rc = subprocess.run(["setpriv", "--reuid=1000", "--regid=1000", "--clear-groups", "head", "-c", "1",
                                 os.path.join(LOG_DIR, f)], capture_output=True).returncode
            check(f"{LOG_DIR}/{f} readable by uid 1000 on the host", rc == 0)
        rc = subprocess.run(["setpriv", "--reuid=1000", "--regid=1000", "--clear-groups", "ls", LOG_DIR], capture_output=True).returncode
        check(f"{LOG_DIR} listable by uid 1000", rc == 0)
        acc = sh(f"ls {LOG_DIR} | grep -c '^http_access_\\.'")
        check("management HTTP access log is written to the host directory", acc.isdigit() and int(acc) >= 1)

    # 6. blue was not disturbed
    blue_pod = json.loads(sh("kubectl -n apim get pod -l app=wso2am -o json"))["items"][0]
    blue_after = (blue_pod["metadata"]["uid"], blue_pod["status"]["containerStatuses"][0]["restartCount"],
                  sh("kubectl -n apim get deploy wso2am -o jsonpath='{.metadata.generation}'"),
                  sh("kubectl -n apim get cm apim-conf -o jsonpath='{.metadata.resourceVersion}'"))
    check("blue untouched: same pod, 0 new restarts, deployment and ConfigMap unchanged", blue_before == blue_after and blue_pod["status"]["phase"] == "Running",
          f"restarts={blue_after[1]}")
    t_ref2 = truthmod.collect(a.ref_mgmt)
    l2, _ = truthmod.diff(t_ref, t_ref2, a.ignore_test)
    check("blue's own state is the same after the verification traffic", not l2)
    if not a.ref_pod_ip:
        # Green carries blue's public hostname in its config. scripts/egress-watch.sh samples the
        # TCP connections inside green's network namespace once a second; any connection to blue
        # (pod IP, Service IP or the live NodePorts) is recorded as a HIT.
        try:
            eg = open(os.path.join(ROOT, "green-egress.log")).read().splitlines()
        except OSError:
            eg = []
        samples = max([int(l.split()[2]) for l in eg if " SAMPLES " in l] or [0])
        hits = [l for l in eg if " HIT " in l]
        check("green never opened a connection to blue (per-second sampling of green's sockets since it started)",
              samples > 0 and not hits, f"{samples} samples, {len(hits)} hits, green pod {green_ip}")

    failed = [r for r in results if not r[1]]
    with open(os.path.join(ROOT, f"gate-{a.label}.txt"), "w") as f:
        f.write(f"gate {a.label} at {time.strftime('%FT%TZ', time.gmtime())}: reference {a.ref_mgmt}, target {a.target_mgmt}\n")
        for name, ok, detail in results:
            f.write(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f"  ({detail})" if detail else "") + "\n")
        f.write(f"RESULT: {'PASS' if not failed else 'FAIL'} ({len(results) - len(failed)}/{len(results)})\n")
    print(f"RESULT: {'PASS' if not failed else 'FAIL'} ({len(results) - len(failed)}/{len(results)})")
    return 0 if not failed else 1


if __name__ == "__main__":
    sys.exit(main())
