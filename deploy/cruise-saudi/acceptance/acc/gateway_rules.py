"""Gateway rules on a live API, end to end on the real gateway.

Creates its own throw-away objects, all named cs-acc-<stamp>-*: a subscription (traffic) policy, an
API pointing at the harness's stand-in backend, an application with keys, and an IP blocking rule for
a documentation-only address (198.51.100.x, RFC 5737). Everything is deleted at the end, also when a
step fails. Existing APIs, policies, applications and subscriptions are never read for change,
modified or deleted.

The rules are set through the API Manager REST API, which is what the Gateway console drives; the
console screens themselves (cs/gateway) are checked in G8/G9 when the console offers them.
"""
from __future__ import annotations

import time
import urllib.parse
from typing import Any, Dict, Optional

from .apim import Apim, ApimError, StandIn, PUB, DEV, ADM
from .core import Config, Http, Run, PASS, FAIL, WAITING, SKIP, short

G = "gateway"
BLOCK_IP_PREFIX = "198.51.100."


def run(cfg: Config, h: Http, r: Run, ses):
    ids = ("G1", "G2", "G3", "G4", "G5", "G6", "G7")
    titles = {
        "G1": "Throw-away API published, secured, callable with a key (and 401 without)",
        "G2": "Block an IP -> 403 for that IP only; unblock -> served again",
        "G3": "Change CORS -> the new origin is allowed, the old one is not",
        "G4": "Roll back a revision -> the previous CORS setting is live again",
        "G5": "Revoke a key (API key and OAuth token) -> 401",
        "G6": "Assign a traffic limit -> exceeding it gives 429",
        "G7": "Clean-up: no cs-acc object left on API Manager",
    }
    if cfg.read_only:
        for i in ids:
            r.add(i, G, titles[i], SKIP, "read-only run: creates throw-away objects on API Manager")
        _console(cfg, h, r, ses)
        return
    a = Apim(cfg, h)
    ok, why = a.available()
    if not ok or not cfg.apim_gw_url:
        for i in ids:
            r.add(i, G, titles[i], WAITING, why or "no API gateway address")
        _console(cfg, h, r, ses)
        return

    s = cfg.stamp
    name, ctx = f"cs-acc-{s}-api", f"/cs-acc-{s}"
    pol, appname = f"cs-acc-{s}-limit", f"cs-acc-{s}-app"
    origin1, origin2 = "https://initial.cs-acc.example", "https://changed.cs-acc.example"
    gw = cfg.apim_gw_url.rstrip("/") + ctx + "/1.0.0/echo"
    st = StandIn(cfg)
    state: Dict[str, Any] = {}

    # Console mode: when the Gateway console (cs/gateway) answers /api/rules/*, the rules of G2-G4 are
    # set through the console's own API (as an operator would from its screens) and enforcement is
    # still measured on the gateway. Otherwise they are set on API Manager directly.
    Gw = (cfg.gateway_url or "").rstrip("/")
    ghd = ses.headers("gateway", "admin") if Gw else None
    console = False
    if ghd is not None and Gw and cfg.secret("ACC_GW_DIRECT") != "1":
        console = h.get(Gw + "/api/rules/context", headers=ghd, timeout=20).status == 200
    if console:
        cfg.env["_ACC_CONSOLE_USED"] = "1"
    via = "via the Gateway console" if console else "via API Manager REST (console rules API not available)"

    def con(method, path, data=None):
        u = urllib.parse.urlsplit(Gw)
        x = h.request(method, Gw + path, headers=dict(ghd or {}, Origin=f"{u.scheme}://{u.netloc}"), data=data, timeout=60)
        if x.status not in (200, 201, 204):
            raise ApimError(f"console {method} {path} -> {x.status} {short(x.text, 160)}")
        return x.json() if x.body else None

    def call(token: Optional[str] = None, apikey: Optional[str] = None, xff: Optional[str] = None, method="GET", origin=None):
        hd: Dict[str, str] = {}
        if token:
            hd["Authorization"] = "Bearer " + token
        if apikey:
            hd["apikey"] = apikey
        if xff:
            hd["X-Forwarded-For"] = xff
        if origin:
            hd["Origin"] = origin
        if method == "OPTIONS":
            hd["Access-Control-Request-Method"] = "GET"
            hd["Access-Control-Request-Headers"] = "authorization"
        return h.request(method, gw, headers=hd, timeout=20)

    def wait_for(pred, seconds=90, step=3):
        end, last = time.time() + seconds, None
        while time.time() < end:
            last = pred()
            if last is not None and last[0]:
                return last
            time.sleep(step)
        return last or (False, "timeout")

    def deploy(rev_id: str):
        settings = a.call("GET", PUB + "/settings") or {}
        envs = settings.get("environment") or [{"name": "Default", "vhosts": [{"host": "localhost"}]}]
        body = [{"name": e["name"], "vhost": ((e.get("vhosts") or [{}])[0].get("host") or "localhost"), "displayOnDevportal": True}
                for e in envs[:1]]
        a.call("POST", f"{PUB}/apis/{state['api']}/deploy-revision?revisionId={rev_id}", body)
        return body[0]["name"]

    def cors_allows(origin: str) -> bool:
        x = call(method="OPTIONS", origin=origin)
        return x.header("access-control-allow-origin") in (origin,)

    try:
        # ------------------------------------------------------------------ G1 set up and call
        def g1():
            a.call("POST", ADM + "/throttling/policies/subscription", {
                "policyName": pol, "displayName": pol, "description": "cs-acc acceptance run, removed at the end",
                "defaultLimit": {"type": "REQUESTCOUNTLIMIT", "requestCount": {"requestCount": 5, "timeUnit": "min", "unitTime": 1}},
                "stopOnQuotaReach": True, "billingPlan": "FREE", "rateLimitCount": 0})
            state["policy"] = pol
            api = a.call("POST", PUB + "/apis", {
                "name": name, "context": ctx, "version": "1.0.0", "description": "cs-acc acceptance run, removed at the end",
                "policies": ["Unlimited", pol], "securityScheme": ["oauth2", "api_key", "oauth_basic_auth_api_key_mandatory"],
                "endpointConfig": {"endpoint_type": "http", "production_endpoints": {"url": st.url}, "sandbox_endpoints": {"url": st.url}},
                "corsConfiguration": {"corsConfigurationEnabled": True, "accessControlAllowOrigins": [origin1],
                                      "accessControlAllowCredentials": False, "accessControlAllowHeaders": ["authorization", "Content-Type", "apikey"],
                                      "accessControlAllowMethods": ["GET", "POST", "OPTIONS"]},
                "operations": [{"target": "/echo", "verb": "GET", "authType": "Application & Application User", "throttlingPolicy": "Unlimited"},
                               {"target": "/echo", "verb": "POST", "authType": "Application & Application User", "throttlingPolicy": "Unlimited"}]})
            state["api"] = api["id"]
            rev1 = a.call("POST", f"{PUB}/apis/{state['api']}/revisions", {"description": "cs-acc revision 1 (initial CORS)"})
            state["rev1"] = rev1["id"]
            env = deploy(rev1["id"])
            a.call("POST", f"{PUB}/apis/change-lifecycle?apiId={state['api']}&action=Publish")
            app = a.app_with_token(appname, state["api"], pol)
            state["app"] = app
            res = wait_for(lambda: (call(app["token"]).status == 200, None), 120)
            first = call(app["token"])
            anon = call()
            detail = a.call("GET", f"{PUB}/apis/{state['api']}") or {}
            secured = [x for x in detail.get("securityScheme", []) if x in ("oauth2", "api_key")]
            reached = any(c["path"].endswith("/echo") for c in st.calls)
            ev = (f"API {name} on {env}, lifecycle {detail.get('lifeCycleStatus')}, security {secured}; "
                  f"with token -> {first.status}, without -> {anon.status}; stand-in reached: {reached}")
            if first.status == 200 and anon.status == 401 and reached and detail.get("lifeCycleStatus") == "PUBLISHED":
                state["callable"] = True
                return PASS, ev
            return FAIL, ev
        r.check("G1", G, titles["G1"], g1)

        def need():
            if not state.get("callable"):
                raise ApimError("not run: the throw-away API is not callable (see G1)")

        # ------------------------------------------------------------------ G2 IP blocking
        def g2():
            need()
            ip = BLOCK_IP_PREFIX + str(10 + int(s[-2:]) % 200)
            other = BLOCK_IP_PREFIX + "250"
            tok = state["app"]["token"]
            before = call(tok, xff=ip).status
            if console:
                pol_ = con("POST", "/api/rules/blocking", {"type": "IP", "value": ip, "enabled": True}) or {}
                state["deny"] = pol_.get("id")
            else:
                pol_ = a.call("POST", ADM + "/deny-policies", {"conditionType": "IP", "conditionStatus": True,
                                                                "conditionValue": {"fixedIp": ip, "invert": False}})
                state["deny"] = pol_.get("policyId") or pol_.get("conditionId")
            res = wait_for(lambda: ((lambda x: (x.status == 403, x.status))(call(tok, xff=ip))), 90)
            blocked = call(tok, xff=ip)
            others = call(tok, xff=other).status
            if console:
                con("DELETE", f"/api/rules/blocking/{state['deny']}")
            else:
                a.call("DELETE", f"{ADM}/deny-policies/{state['deny']}")
            state.pop("deny", None)
            wait_for(lambda: ((lambda x: (x.status == 200, x.status))(call(tok, xff=ip))), 90)
            after = call(tok, xff=ip).status
            ev = (f"{via}: from {ip}: before {before}, blocked {blocked.status} ({short(blocked.text, 80)}), other address {others}, "
                  f"after unblock {after}")
            return (PASS if before == 200 and blocked.status == 403 and others == 200 and after == 200 else FAIL), ev
        r.check("G2", G, titles["G2"], g2)

        # ------------------------------------------------------------------ G3 CORS change (revision 2)
        def g3():
            need()
            init_ok = cors_allows(origin1)
            if console:
                out = con("POST", f"/api/rules/apis/{state['api']}/access", {
                    "security": "both", "ipAllow": [], "ipDeny": [],
                    "cors": {"enabled": True, "origins": [origin2], "headers": ["authorization", "Content-Type", "apikey"],
                             "methods": ["GET", "POST", "OPTIONS"], "credentials": False}}) or {}
                state["rev2"] = (out.get("revision") or {}).get("id") or "console"
            else:
                api = a.call("GET", f"{PUB}/apis/{state['api']}")
                api["corsConfiguration"]["accessControlAllowOrigins"] = [origin2]
                a.call("PUT", f"{PUB}/apis/{state['api']}", api)
                rev2 = a.call("POST", f"{PUB}/apis/{state['api']}/revisions", {"description": "cs-acc revision 2 (changed CORS)"})
                state["rev2"] = rev2["id"]
                deploy(rev2["id"])
            wait_for(lambda: (cors_allows(origin2), None), 90)
            new_ok, old_ok = cors_allows(origin2), cors_allows(origin1)
            ev = f"{via}: before: {origin1} allowed={init_ok}; after revision 2: {origin2} allowed={new_ok}, {origin1} allowed={old_ok}"
            return (PASS if init_ok and new_ok and not old_ok else FAIL), ev
        r.check("G3", G, titles["G3"], g3)

        # ------------------------------------------------------------------ G4 rollback to revision 1
        def g4():
            need()
            if not state.get("rev2"):
                raise ApimError("not run: no second revision (see G3)")
            if console:
                con("POST", f"/api/rules/apis/{state['api']}/rollback", {"revisionId": state["rev1"]})
            else:
                a.call("POST", f"{PUB}/apis/{state['api']}/restore-revision?revisionId={state['rev1']}")
                deploy(state["rev1"])
            wait_for(lambda: (cors_allows(origin1), None), 90)
            o1, o2 = cors_allows(origin1), cors_allows(origin2)
            served = call(state["app"]["token"]).status
            ev = f"{via}: revision 1 deployed again: {origin1} allowed={o1}, {origin2} allowed={o2}, call -> {served}"
            return (PASS if o1 and not o2 and served == 200 else FAIL), ev
        r.check("G4", G, titles["G4"], g4)

        # ------------------------------------------------------------------ G5 revoke keys
        def g5():
            need()
            app = state["app"]
            k = a.call("POST", f"{DEV}/applications/{app['applicationId']}/api-keys/PRODUCTION/generate", {"validityPeriod": 3600},
                       headers={"Content-Type": "application/json"})
            key = (k or {}).get("apikey")
            with_key = call(apikey=key).status if key else 0
            if key:
                a.call("POST", f"{DEV}/applications/{app['applicationId']}/api-keys/PRODUCTION/revoke", {"apikey": key})
                wait_for(lambda: ((lambda c: (c == 401, c))(call(apikey=key).status)), 90)
            key_after = call(apikey=key).status if key else 0
            tok = a.client_token(app)
            t_before = call(tok).status
            rv = a.revoke(app, tok)
            wait_for(lambda: ((lambda c: (c == 401, c))(call(tok).status)), 90)
            t_after = call(tok).status
            ev = f"API key: {with_key} -> revoked -> {key_after}; OAuth token: {t_before} -> revoke({rv}) -> {t_after}"
            return (PASS if with_key == 200 and key_after == 401 and t_before == 200 and t_after == 401 else FAIL), ev
        r.check("G5", G, titles["G5"], g5)

        # ------------------------------------------------------------------ G6 traffic limit
        def g6():
            need()
            tok = a.client_token(state["app"])
            codes = []
            for _ in range(40):
                c = call(tok).status
                codes.append(c)
                if c == 429:
                    break
            first429 = codes.index(429) + 1 if 429 in codes else None
            served = sum(1 for c in codes if c == 200)
            ev = f"policy {pol} = 5 requests/min on the subscription; {len(codes)} calls: {served}x200, first 429 at call {first429}"
            return (PASS if first429 and served >= 1 else FAIL), ev
        r.check("G6", G, titles["G6"], g6)
    finally:
        problems = _cleanup(a, state, pol, appname, name)
        st.stop()

        def g7():
            left = []
            try:
                left += [x["name"] for x in a.list(PUB + "/apis?query=name:" + urllib.parse.quote(f"cs-acc-{s}")) if x["name"].startswith("cs-acc-")]
                left += [x["name"] for x in a.list(DEV + "/applications") if x["name"].startswith(f"cs-acc-{s}")]
                subs = (a.call("GET", ADM + "/throttling/policies/subscription") or {}).get("list", [])
                left += [x["policyName"] for x in subs if x["policyName"].startswith(f"cs-acc-{s}")]
                deny = (a.call("GET", ADM + "/deny-policies") or {}).get("list", [])
                left += [f"deny {x.get('conditionValue')}" for x in deny if str(x.get("conditionValue", "")).find(BLOCK_IP_PREFIX) >= 0]
            finally:
                a.close()
            if left or problems:
                return FAIL, f"left behind: {left}; clean-up errors: {problems}"
            return PASS, "throw-away API, application, subscription, traffic policy, blocking rule and admin client removed"
        r.check("G7", G, titles["G7"], g7)
    _console(cfg, h, r, ses)


def _cleanup(a: Apim, state: Dict[str, Any], pol: str, appname: str, name: str):
    problems = []

    def step(label, fn):
        try:
            fn()
        except Exception as e:
            problems.append(f"{label}: {short(str(e), 100)}")
    if state.get("deny"):
        step("deny policy", lambda: a.call("DELETE", f"{ADM}/deny-policies/{state['deny']}"))
    if state.get("app"):
        step("application", lambda: a.call("DELETE", f"{DEV}/applications/{state['app']['applicationId']}"))
    if state.get("api"):
        def undeploy_delete():
            revs = (a.call("GET", f"{PUB}/apis/{state['api']}/revisions") or {}).get("list", [])
            for rv in revs:
                deps = rv.get("deploymentInfo") or []
                if deps:
                    a.call("POST", f"{PUB}/apis/{state['api']}/undeploy-revision?revisionId={rv['id']}",
                           [{"name": d["name"], "vhost": d.get("vhost"), "displayOnDevportal": True} for d in deps])
            time.sleep(2)
            a.call("DELETE", f"{PUB}/apis/{state['api']}")
        step("api", undeploy_delete)
    if state.get("policy"):
        def drop_policy():
            for x in (a.call("GET", ADM + "/throttling/policies/subscription") or {}).get("list", []):
                if x["policyName"] == pol:
                    a.call("DELETE", f"{ADM}/throttling/policies/subscription/{x['policyId']}")
        step("traffic policy", drop_policy)
    return problems


def _console(cfg: Config, h: Http, r: Run, ses):
    """G8/G9: the Gateway console offers the rules and records them (cs/gateway). Probed by the
    console's API; WAITING while the console does not answer those routes."""
    Gw = (cfg.gateway_url or "").rstrip("/")
    paths = [p for p in cfg.secret("ACC_GW_RULE_PATHS", "/api/rules/context,/api/rules/apis,/api/rules/blocking,/api/rules/applications,/api/rules/policies/usage,/api/rules/overview").split(",") if p]
    audit = cfg.secret("ACC_GW_AUDIT_PATH", "/api/rules/audit")

    def rules():
        if not Gw:
            return WAITING, "no gateway console address"
        hd = ses.headers("gateway", "admin")
        if hd is None:
            return WAITING, f"no gateway console session ({ses.last_error})"
        seen = {p: h.get(Gw + p, headers=hd, timeout=15).status for p in paths}
        missing = [p for p, c in seen.items() if c in (404, 405)]
        if len(missing) == len(paths):
            return WAITING, f"console routes not there yet (cs/gateway): {seen}"
        bad = [p for p, c in seen.items() if c != 200]
        return (FAIL if bad else PASS), f"console routes: {seen}"
    r.check("G8", G, "Gateway console offers limits, access/CORS/IP, consumers/keys, blocking, revisions", rules)

    def gaudit():
        if not Gw:
            return WAITING, "no gateway console address"
        hd = ses.headers("gateway", "admin")
        if hd is None:
            return WAITING, f"no gateway console session ({ses.last_error})"
        x = h.get(Gw + audit, headers=hd, timeout=15)
        if x.status in (404, 405):
            return WAITING, f"no console audit at {audit} yet (cs/gateway)"
        if x.status != 200:
            return FAIL, f"GET {audit} -> {x.status} {short(x.text, 100)}"
        mine = f"cs-acc-{cfg.stamp}" in x.text
        if cfg.env.get("_ACC_CONSOLE_USED") == "1" and not mine:
            return FAIL, f"the audit does not show this run's console changes on cs-acc-{cfg.stamp}-api"
        return PASS, f"audit answers; this run's changes listed: {mine}"
    r.check("G9", G, "Gateway console keeps an audit of rule changes", gaudit)
