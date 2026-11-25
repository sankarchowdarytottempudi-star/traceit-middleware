"""Mule -> WSO2 migration end to end with our own synthetic Mule 4 project (sample-mule/cs-acc-orders).

upload -> documents -> mapping is right -> generate -> build/tests -> deploy to the target cluster ->
published on API Manager, secured -> called through the gateway with a key -> logs and analytics.
The migration is named cs-acc-<stamp>-orders. The sample calls the harness's stand-in backend.
"""
from __future__ import annotations

import io
import json
import os
import time
import urllib.parse
import zipfile
from typing import Any, Dict, List, Optional

from .apim import Apim, StandIn, PUB, DEV
from .core import Config, Http, Run, PASS, FAIL, WAITING, SKIP, MANUAL, short

G = "migration"
SAMPLE = "sample-mule/cs-acc-orders"


def build_sample(cfg: Config, backend_host: str = "", backend_port: str = "") -> bytes:
    root = os.path.join(cfg.harness_dir, SAMPLE)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for d, _, files in os.walk(root):
            for f in sorted(files):
                p = os.path.join(d, f)
                rel = os.path.relpath(p, os.path.dirname(root))
                data = open(p, "rb").read()
                if f == "config.yaml" and backend_host:
                    data = data.replace(b"standin.cs-acc.local", backend_host.encode()).replace(b'"8099"', f'"{backend_port}"'.encode())
                z.writestr(rel, data)
    return buf.getvalue()


LIVE_HOSTS = ("traceit-tottech.com",)
LIVE_PORTS = (":8788", ":8796")


def _guard(cfg: Config, h: Http, F: str, hd) -> str:
    """The migration runs the tool's generate/test/deploy steps. Never against a live tool, and never
    where the tool's version recorder could push to a git remote (it commits on every deploy)."""
    if any(x in F for x in LIVE_HOSTS) or any(F.split("/factory")[0].endswith(p) for p in LIVE_PORTS):
        return f"refused: {F} is a live TraceIT Factory/tool - the migration runs only on the install under test"
    if not (cfg.isolated or cfg.secret("ACC_ALLOW_MIGRATION") == "1"):
        return "runs only with --isolated-test, or ACC_ALLOW_MIGRATION=1 on the customer's install before go-live"
    v = h.get(F + "/api/factory/versions/status", headers=hd, timeout=20)
    j = v.json() or {}
    if v.status == 200 and (j.get("remote") or "").strip():
        return ("refused: the migration tool's version recorder has a git remote connected (it would commit and push "
                "on deploy) - disconnect it or point MT_VERSIONS_HOME at a scratch folder first")
    return ""


def run(cfg: Config, h: Http, r: Run, ses) -> List[str]:
    """Returns the ids of the migrations it made (their documents go into the branding scan)."""
    F = cfg.factory_url.rstrip("/")
    made: List[str] = []

    def mule_only():
        hd = ses.headers("factory", "admin")
        if hd is None:
            return WAITING, ses.last_error
        x = h.get(F + "/api/factory/migrate/options", headers=hd, timeout=20)
        j = x.json() or {}
        techs = [t.get("id") for t in j.get("technologies", [])]
        targets = [t.get("id") for t in (j.get("targets") or j.get("targetTechnologies") or [])]
        extra_t = [t for t in techs if t not in ("mule4", "auto")]
        extra_g = [t for t in targets if t not in ("wso2",)]
        ev = f"sources offered: {techs}; targets offered: {targets or '(not listed)'}"
        return (FAIL if extra_t or extra_g else PASS), ev
    r.check("M0", G, "The edition offers only MuleSoft (Mule 4) -> WSO2", mule_only)

    st = None if cfg.read_only else StandIn(cfg)
    zipped = build_sample(cfg, st.host if st else "", str(st.port) if st else "")
    zp = os.path.join(cfg.out_dir, "cs-acc-orders.zip")
    os.makedirs(cfg.out_dir, exist_ok=True)
    open(zp, "wb").write(zipped)
    r.add("M1", G, "Sample Mule 4 project (ours, synthetic) packaged", PASS,
          f"{zp} ({len(zipped)} bytes): 1 HTTP listener POST /api/orders, 1 flow, DataWeave transform, HTTP request to the stand-in"
          + (f" at {st.url}" if st else ""))

    titles = {"M2": "Upload accepted, migration created", "M3": "Documents generated (technical, mapping, functional)",
              "M4": "Mapping is right (listener, fields, transform, backend call)", "M5": "WSO2 service generated",
              "M6": "Build and tests pass", "M7": "Deployed to the target cluster and running",
              "M8": "Published on API Manager, secured", "M9": "Called through the gateway with a key: right answer",
              "M10": "Logs of that call visible in the Factory", "M11": "Analytics of that call visible in the Gateway console"}
    if cfg.read_only:
        for k, t in titles.items():
            r.add(k, G, t, SKIP, "read-only run: would create a migration, a service and a published API")
        return made
    hd = ses.headers("factory", "admin")
    if hd is None:
        for k, t in titles.items():
            r.add(k, G, t, WAITING, f"no Factory session: {ses.last_error}")
        return made
    stop = _guard(cfg, h, F, hd)
    if stop:
        for k, t in titles.items():
            r.add(k, G, t, SKIP, stop)
        if st:
            st.stop()
        return made

    state: Dict[str, Any] = {}
    name = f"cs-acc-{cfg.stamp}-orders"

    def get_m():
        x = h.get(F + f"/api/factory/migrations/{state['id']}", headers=hd, timeout=30)
        return x.json() or {}

    def phase(m, key):
        return next((p for p in m.get("phases", []) if p.get("key") == key), {})

    def wait_idle(seconds):
        """Wait until the migration is neither busy nor queued and its phases are known (a failed read
        counts as busy: the tool may be restarting)."""
        end = time.time() + seconds
        m: Dict[str, Any] = {}
        time.sleep(5)
        while time.time() < end:
            m = get_m()
            started = any(p.get("status") not in (None, "pending") for p in m.get("phases", []) if p.get("key") != "upload")
            if m.get("phases") and started and not m.get("busy") and not m.get("queued"):
                return m
            time.sleep(10)
        return m

    def m2():
        q = urllib.parse.urlencode({"name": name, "workspace": cfg.secret("ACC_WORKSPACE", "cs-acc"), "filename": "cs-acc-orders.zip",
                                    "sourceType": "mule4", "target": "wso2"})
        x = h.request("POST", F + "/api/factory/migrations?" + q, headers=dict(hd, **{"Content-Type": "application/octet-stream"}),
                      data=zipped, timeout=120)
        j = x.json() or {}
        if x.status in (200, 201) and j.get("id"):
            state["id"] = j["id"]
            made.append(j["id"])
            return PASS, f"migration {j['id']} '{name}', technology {j.get('technology')}"
        return FAIL, f"upload -> {x.status} {short(x.text, 160)}"
    r.check("M2", G, titles["M2"], m2)

    def need():
        if "id" not in state:
            raise RuntimeError("not run: no migration (see M2)")

    def m3():
        need()
        go = h.request("POST", F + f"/api/factory/migrations/{state['id']}/run/autorun", headers=hd, data={}, timeout=60)
        if go.status not in (200, 201, 202):
            return FAIL, f"'Run automatically' -> {go.status} {short(go.text, 140)}"
        m = wait_idle(int(cfg.secret("ACC_MIGRATION_TIMEOUT", "1800")))
        state["m"] = m
        d = h.get(F + f"/api/factory/migrations/{state['id']}/docs", headers=hd, timeout=30).json() or {}
        names = [x if isinstance(x, str) else x.get("name") for x in (d.get("docs") or d.get("documents") or [])]
        state["docs"] = names
        want = ["TECHNICAL.md", "MAPPING.md", "FUNCTIONAL.md"]
        miss = [w for w in want if w not in names]
        ph = phase(m, "document").get("status")
        return (PASS if not miss and ph == "done" else FAIL), f"document phase {ph}; documents {names[:10]}; missing {miss}"
    r.check("M3", G, titles["M3"], m3)

    def m4():
        need()
        x = h.get(F + f"/api/factory/migrations/{state['id']}/docs/MAPPING.md", headers=hd, timeout=30)
        t = x.text
        musts = ["/api/orders", "POST", "customerName", "customer", "qty", "quantity", "unitPrice", "amount", "total", "/orders"]
        miss = [w for w in musts if w not in t]
        return (PASS if x.status == 200 and not miss else FAIL), f"MAPPING.md {x.status}, {len(t)} chars; missing terms: {miss or 'none'}"
    r.check("M4", G, titles["M4"], m4)

    def phase_check(key, label):
        def f():
            need()
            m = state.get("m") or get_m()
            p = phase(m, key)
            steps = ", ".join(f"{s.get('key')}={s.get('status')}" for s in p.get("steps", []))
            return (PASS if p.get("status") == "done" else FAIL), f"{label} phase {p.get('status')}: {steps}"
        return f
    r.check("M5", G, titles["M5"], phase_check("scaffold", "scaffold"))
    r.check("M6", G, titles["M6"], phase_check("test", "test"))

    def m7():
        need()
        status, ev = phase_check("deploy", "deploy")()
        kc = cfg.secret("ACC_TARGET_KUBECONFIG")
        api = (state.get("m") or {}).get("apiName", "")
        state["api"] = api
        if status == PASS and kc and api:
            from .core import sh
            rc, out = sh(["kubectl", "--kubeconfig", kc, "get", "pods", "-A", "-l", f"app.kubernetes.io/name={api}", "--no-headers"], 60)
            running = [l for l in out.splitlines() if "Running" in l]
            ev += f"; target cluster pods for {api}: {len(running)} running"
            if not running:
                status = FAIL
        elif status == PASS:
            ev += "; target cluster not inspected (set ACC_TARGET_KUBECONFIG to prove where it runs)"
        return status, ev
    r.check("M7", G, titles["M7"], m7)

    a = Apim(cfg, h)

    def m8():
        need()
        ok, why = a.available()
        if not ok:
            return WAITING, why
        api = state.get("api")
        if not api:
            return FAIL, "the migration has no API name"
        found = [x for x in a.list(PUB + "/apis?query=name:" + urllib.parse.quote(api))]
        if not found:
            return FAIL, f"no API named {api} on API Manager (publishing step missing?)"
        d = a.call("GET", f"{PUB}/apis/{found[0]['id']}")
        state["apim"] = d
        sec = [s for s in d.get("securityScheme", []) if s in ("oauth2", "api_key", "mutualssl")]
        ok = d.get("lifeCycleStatus") == "PUBLISHED" and sec
        return (PASS if ok else FAIL), f"{d.get('name')} {d.get('context')} {d.get('version')} {d.get('lifeCycleStatus')} security {sec}"
    r.check("M8", G, titles["M8"], m8)

    def m9():
        d = state.get("apim")
        if not d:
            raise RuntimeError("not run: API not on API Manager (see M8)")
        if not cfg.apim_gw_url:
            return WAITING, "no API gateway address"
        app = a.app_with_token(f"cs-acc-{cfg.stamp}-orders-app", d["id"])
        state["app"] = app
        url = cfg.apim_gw_url.rstrip("/") + d["context"].replace("{version}", d["version"]) + ("" if "{version}" in d["context"] else "/" + d["version"]) + "/api/orders"
        body = {"customerName": "Test Guest", "items": [{"sku": "CS-ACC-1", "qty": 2, "unitPrice": 10.5}]}
        x = None
        for _ in range(20):
            x = h.request("POST", url, headers={"Authorization": "Bearer " + app["token"]}, data=body, timeout=30)
            if x.status not in (401, 404, 503):
                break
            time.sleep(5)
        anon = h.request("POST", url, data=body, timeout=30).status
        j = x.json() or {}
        got = (st.calls[-1]["body"] if st and st.calls else None)
        right = x.status == 200 and abs(float(j.get("total") or 0) - 21.0) < 0.001 and str(j.get("orderId", "")).startswith("cs-acc-")
        backend_ok = isinstance(got, dict) and got.get("customer") == "TEST GUEST" and got.get("total") in (21, 21.0)
        state["called_at"] = time.time()
        return (PASS if right and backend_ok and anon == 401 else FAIL), \
            f"POST {url.split('//', 1)[-1]} -> {x.status} {short(x.text, 120)}; without key -> {anon}; backend received {short(got, 140)}"
    r.check("M9", G, titles["M9"], m9)

    def m10():
        api = state.get("api")
        if not state.get("called_at"):
            raise RuntimeError("not run: no call made (see M9)")
        for _ in range(12):
            x = h.get(F + f"/api/factory/estate/{api}/logs", headers=hd, timeout=30)
            if "order" in x.text.lower():
                return PASS, f"estate logs of {api}: {len((x.json() or {}).get('lines', []))} lines, the call is there"
            time.sleep(10)
        return FAIL, f"no log line of the call in {api} logs ({x.status})"
    r.check("M10", G, titles["M10"], m10)

    def m11():
        api = state.get("api")
        if not state.get("called_at"):
            raise RuntimeError("not run: no call made (see M9)")
        gh = ses.headers("gateway", "admin")
        if gh is None or not cfg.gateway_url:
            return WAITING, f"no gateway console session ({ses.last_error})"
        for _ in range(18):
            x = h.get(cfg.gateway_url.rstrip("/") + f"/api/analytics/api/{api}", headers=gh, timeout=30)
            j = x.json() or {}
            total = j.get("total") or j.get("requests") or (j.get("summary") or {}).get("total")
            if total:
                return PASS, f"gateway analytics for {api}: total {total}"
            time.sleep(10)
        return FAIL, f"gateway analytics for {api} shows no call ({x.status} {short(x.text, 100)})"
    r.check("M11", G, titles["M11"], m11)

    # clean-up: our application on API Manager; the migration stays listed (named cs-acc-*) so the
    # customer can open it as evidence, unless ACC_DELETE_MIGRATION=1.
    try:
        if state.get("app"):
            a.call("DELETE", f"{DEV}/applications/{state['app']['applicationId']}")
        if cfg.secret("ACC_DELETE_MIGRATION") == "1" and state.get("id"):
            h.request("DELETE", F + f"/api/factory/migrations/{state['id']}", headers=hd, timeout=30)
    except Exception as e:
        r.notes.append(f"migration clean-up: {short(str(e), 120)}")
    finally:
        a.close()
        if st:
            st.stop()
    if state.get("api"):
        r.notes.append(f"left for evidence: migration {name} and its deployed API {state.get('api')} (remove with the Factory's delete and an undeploy)")
    return made
