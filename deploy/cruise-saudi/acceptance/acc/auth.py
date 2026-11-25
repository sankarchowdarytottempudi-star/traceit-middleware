"""Sign-in & roles. Sessions for the other groups come from here too.

The user-management API is delivered by the `cs/users` branch. Its paths are configurable so the
harness follows that branch without code changes:
  ACC_LOGIN_PATH   local sign-in, JSON {email, password}       (default /api/auth/local)
  ACC_USERS_PATH   user list/create (GET/POST), /<id> delete  (default /api/access/users)
  ACC_AUDIT_PATH   audit lines                                 (default /api/access/audit)
The "admin" account of the secrets file should hold all three roles (admin, migration, gateway),
like the first admin the installer creates: the other groups use it for migrations and the console.
Credentials (from --secrets or the environment, never printed):
  ACC_ADMIN_USER / ACC_ADMIN_PASSWORD, ACC_MIGRATION_USER / ACC_MIGRATION_PASSWORD,
  ACC_GATEWAY_USER / ACC_GATEWAY_PASSWORD
"""
from __future__ import annotations

import json
import time
import urllib.parse
from typing import Dict, Optional

from .core import Config, Http, Run, PASS, FAIL, WAITING, SKIP, MANUAL, short

G = "auth"


def _cookie_header(set_cookies) -> str:
    return "; ".join(c.split(";", 1)[0] for c in set_cookies)


class Sessions:
    def __init__(self, cfg: Config, h: Http):
        self.cfg, self.h = cfg, h
        self.cache: Dict[str, Optional[str]] = {}
        self.login_path = cfg.secret("ACC_LOGIN_PATH", "/api/auth/local")
        self.last_error = ""

    def login_raw(self, base: str, user: str, pw: str):
        """POST the local sign-in as the browser does (JSON, same-origin Origin header)."""
        u = urllib.parse.urlsplit(base)
        return self.h.request("POST", base.rstrip("/") + self.login_path, timeout=20,
                              headers={"Origin": f"{u.scheme}://{u.netloc}", "Content-Type": "application/json"},
                              data={"email": user, "username": user, "password": pw})

    def creds(self, role: str):
        R = role.upper()
        return self.cfg.secret(f"ACC_{R}_USER"), self.cfg.secret(f"ACC_{R}_PASSWORD")

    def headers(self, app: str, role: str = "admin") -> Optional[Dict[str, str]]:
        """Request headers for `app` (factory|gateway) as `role`; {} on a dev-auth target; None when
        no session can be made (missing credentials or no local sign-in yet)."""
        if self.cfg.dev_auth and app == "factory":
            return {}
        key = f"{app}:{role}"
        if key not in self.cache:
            self.cache[key] = self._login(app, role)
        c = self.cache[key]
        if c is None:
            return None
        u = urllib.parse.urlsplit(self.cfg.factory_url if app == "factory" else self.cfg.gateway_url)
        return {"Cookie": c, "Origin": f"{u.scheme}://{u.netloc}"}  # same-origin, like the browser

    def _login(self, app: str, role: str) -> Optional[str]:
        user, pw = self.creds(role)
        if not user or not pw:
            self.last_error = f"no credentials for role {role} (ACC_{role.upper()}_USER/_PASSWORD)"
            return None
        base = self.cfg.factory_url if app == "factory" else self.cfg.gateway_url
        x = self.login_raw(base, user, pw)
        if x.status in (200, 204) and x.set_cookies:
            return _cookie_header(x.set_cookies)
        self.last_error = f"POST {self.login_path} on {app} -> {x.status} {short(x.text, 100)}"
        return None


def _access_base(cfg: Config, h: Http, ses: Sessions, path: str) -> str:
    """User management and its audit are served by one console (both share the users file); use the
    first that answers. Returns the base URL, or "" when neither does."""
    for app, base in (("gateway", cfg.gateway_url), ("factory", cfg.factory_url)):
        if not base:
            continue
        hd = ses.headers(app, "admin")
        if hd is not None and h.get(base.rstrip("/") + path, headers=hd, timeout=15).status == 200:
            return base.rstrip("/")
    return ""


def run(cfg: Config, h: Http, r: Run, ses: Sessions):
    F0, Gw = cfg.factory_url.rstrip("/"), (cfg.gateway_url or "").rstrip("/")
    F = F0
    users_path = cfg.secret("ACC_USERS_PATH", "/api/access/users")
    audit_path = cfg.secret("ACC_AUDIT_PATH", "/api/access/audit")
    U = _access_base(cfg, h, ses, users_path) if not cfg.dev_auth else ""
    UA = "gateway" if U and U == Gw else "factory"

    def unauth(base, path):
        def f():
            if cfg.dev_auth and base == F:
                return SKIP, "target runs with DEV_AUTH_USER (test instance): sign-in is switched off by design"
            if not base:
                return WAITING, "no address"
            x = h.get(base + path, timeout=15)
            if x.status in (401, 403):
                return PASS, f"GET {path} without a session -> {x.status}"
            return FAIL, f"GET {path} without a session -> {x.status} (data reachable without sign-in?)"
        return f
    r.check("A1", G, "Factory API refuses calls without sign-in", unauth(F, "/api/factory/migrations"))
    r.check("A2", G, "Gateway console API refuses calls without sign-in", unauth(Gw, "/api/apis"))

    def entra():
        if cfg.dev_auth:
            return SKIP, "dev-auth test instance"
        x = h.get(F + "/api/auth/login", timeout=15)
        loc = x.header("location")
        host = urllib.parse.urlsplit(loc).netloc if loc else ""
        if "login.microsoftonline.com" in host or "login.microsoft.com" in host:
            return PASS, f"sign-in goes to Microsoft Entra ({host})"
        if x.status in (301, 302, 303, 307, 308):
            return FAIL, f"sign-in goes to {host or loc[:60]} - not Microsoft Entra (cs/users)"
        return WAITING, f"GET /api/auth/login -> {x.status}: no Entra redirect configured on this target"
    r.check("A3", G, "Sign-in offers Microsoft Entra ID", entra)

    def local_admin():
        if cfg.dev_auth:
            return SKIP, "dev-auth test instance"
        hd = ses.headers("factory", "admin")
        if hd is None:
            return WAITING, ses.last_error
        me = h.get(F + "/api/auth/me", headers=hd, timeout=15)
        j = me.json() or {}
        roles = j.get("roles") or j.get("role") or (j.get("user") or {}).get("roles")
        if me.status == 200 and roles and "admin" in json.dumps(roles):
            return PASS, f"local admin signed in; roles={short(roles, 80)}"
        return FAIL, f"/api/auth/me -> {me.status} roles={short(roles, 80)}"
    r.check("A4", G, "Local (break-glass) admin can sign in", local_admin)

    def wrong_pw():
        if cfg.dev_auth:
            return SKIP, "dev-auth test instance"
        user, _ = ses.creds("admin")
        x = ses.login_raw(F, user or "admin@example.invalid", "cs-acc-wrong-" + cfg.stamp)
        if x.status == 404:
            return WAITING, f"no local sign-in at {ses.login_path} yet (cs/users)"
        if x.status in (400, 401, 403) and not x.set_cookies:
            return PASS, f"wrong password -> {x.status}, no session cookie"
        return FAIL, f"wrong password -> {x.status} cookies={len(x.set_cookies)}"
    r.check("A5", G, "A wrong password is refused", wrong_pw)

    # A6/A7 need a Migration-only and a Gateway-only account. Without them in the secrets file the
    # harness makes two temporary local accounts (cs-acc-<stamp>-mig/-gw) and removes them after A9.
    temp_users = []
    if not cfg.read_only and not cfg.dev_auth:
        adm = ses.headers(UA, "admin") if U else None
        for role, tag in (("migration", "mig"), ("gateway", "gw")):
            if ses.creds(role)[0] or adm is None:
                continue
            email, pw = f"cs-acc-{cfg.stamp}-{tag}@example.com", f"Cs-Acc-{cfg.stamp}-{tag}-pw-long"
            mk = h.request("POST", U + users_path, headers=adm, timeout=15,
                           data={"provider": "local", "email": email, "name": f"Acceptance {role} only", "roles": [role], "password": pw})
            if mk.status in (200, 201):
                uid = ((mk.json() or {}).get("user") or {}).get("id")
                temp_users.append((uid, email))
                cfg.env[f"ACC_{role.upper()}_USER"], cfg.env[f"ACC_{role.upper()}_PASSWORD"] = email, pw
        if temp_users:
            r.notes.append(f"temporary role accounts for A6/A7: {', '.join(e for _, e in temp_users)} (removed after A9)")

    def migration_no_gateway():
        hd = ses.headers("gateway", "migration")
        if hd is None:
            # the user may be unable to even get a gateway session: that is a pass if the login itself is refused for the role
            if "-> 403" in ses.last_error:
                return PASS, f"gateway sign-in refused for the migration-only user ({ses.last_error})"
            return WAITING, ses.last_error
        x = h.get(Gw + "/api/apis", headers=hd, timeout=15)
        if x.status in (401, 403):
            return PASS, f"migration-only user: gateway /api/apis -> {x.status}"
        return FAIL, f"migration-only user: gateway /api/apis -> {x.status} (must be refused)"
    r.check("A6", G, "A Migration-only user cannot open the Gateway", migration_no_gateway)

    def gateway_no_migration():
        if cfg.dev_auth:
            return SKIP, "dev-auth test instance"
        hd = ses.headers("factory", "gateway")
        if hd is None:
            if "-> 403" in ses.last_error:
                return PASS, f"factory sign-in refused for the gateway-only user ({ses.last_error})"
            return WAITING, ses.last_error
        x = h.get(F + "/api/factory/migrations", headers=hd, timeout=15)
        if x.status in (401, 403):
            return PASS, f"gateway-only user: factory migrations -> {x.status}"
        return FAIL, f"gateway-only user: factory migrations -> {x.status} (must be refused)"
    r.check("A7", G, "A Gateway-only user cannot run migrations", gateway_no_migration)

    created = {"name": ""}

    def manage_users():
        if cfg.dev_auth:
            return SKIP, "dev-auth test instance"
        if cfg.read_only:
            return SKIP, "read-only run"
        hd = ses.headers(UA, "admin")
        if hd is None:
            return WAITING, ses.last_error
        if not U:
            return WAITING, f"no console answers {users_path} (cs/users)"
        lst = h.get(U + users_path, headers=hd, timeout=15)
        if lst.status == 404:
            return WAITING, f"no user management at {users_path} yet (cs/users)"
        name = f"cs-acc-user-{cfg.stamp}@example.com"
        mk = h.request("POST", U + users_path, headers=hd, timeout=15,
                       data={"provider": "local", "email": name, "name": "Acceptance test user",
                             "roles": ["migration"], "password": "Cs-Acc-" + cfg.stamp + "-x9!long"})
        if mk.status not in (200, 201):
            return FAIL, f"create user -> {mk.status} {short(mk.text, 120)}"
        created["name"] = name
        mj = mk.json() or {}
        uid = (mj.get("user") or {}).get("id") or mj.get("id") or name
        again = h.get(U + users_path, headers=hd, timeout=15)
        listed = name in again.text
        rm = h.request("DELETE", U + users_path + "/" + urllib.parse.quote(str(uid)), headers=hd, timeout=15)
        gone = name not in h.get(U + users_path, headers=hd, timeout=15).text
        if listed and rm.status in (200, 204) and gone:
            return PASS, f"on the {UA} console: created {name} (role migration), listed, deleted ({rm.status})"
        return FAIL, f"listed={listed} delete={rm.status} gone={gone}"
    r.check("A8", G, "An admin can add, list and remove a user", manage_users)

    def audit():
        if cfg.dev_auth:
            hd: Optional[Dict[str, str]] = {}
        else:
            hd = ses.headers(UA, "admin")
            if hd is None:
                return WAITING, ses.last_error
        if not U:
            return WAITING, f"no console answers {audit_path} (cs/users)"
        x = h.get(U + audit_path, headers=hd, timeout=15)
        if x.status == 404:
            return WAITING, f"no audit at {audit_path}"
        if x.status != 200:
            return FAIL, f"GET {audit_path} -> {x.status}"
        j = x.json()
        items = j if isinstance(j, list) else (j or {}).get("items") or (j or {}).get("audit") or (j or {}).get("entries") or (j or {}).get("lines") or []
        if created["name"]:
            if created["name"] in x.text:
                return PASS, f"audit has {len(items)} lines incl. this run's user change ({created['name']})"
            return FAIL, f"audit ({len(items)} lines) does not show the user change {created['name']}"
        if items:
            keys = sorted(items[0].keys()) if isinstance(items[0], dict) else []
            who = all(any(k in (i or {}) for k in ("user", "actor", "who", "by")) for i in items[:20] if isinstance(i, dict))
            return (PASS if who else FAIL), f"audit answers with {len(items)} lines; fields {keys[:8]}; every line names a user: {who}"
        return WAITING, "audit answers but has no lines yet"
    r.check("A9", G, "Audit lines record who did what", audit)

    if temp_users:
        adm = ses.headers(UA, "admin") or {}
        for uid, email in temp_users:
            if uid:
                h.request("DELETE", U + users_path + "/" + urllib.parse.quote(str(uid)), headers=adm, timeout=15)
        left = [e for _, e in temp_users if e in h.get(U + users_path, headers=adm, timeout=15).text]
        if left:
            r.notes.append(f"temporary accounts NOT removed: {left}")

    r.add("A10", G, "Entra: a real Cruise Saudi account signs in; Entra groups map to admin/migration/gateway", MANUAL,
          "needs the customer's tenant: sign in with one account per role and confirm the menus (see checklist 3.1)")
