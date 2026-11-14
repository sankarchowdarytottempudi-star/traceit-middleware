"""Shared helpers for the APIM blue/green scripts. Python 3 stdlib only.

Secrets (admin password, client secrets, tokens) live in process memory only. Nothing in this
module prints or writes them.
"""
from __future__ import annotations
import base64, json, os, re, ssl, subprocess, urllib.error, urllib.parse, urllib.request

CTX = ssl.create_default_context()
CTX.check_hostname = False
CTX.verify_mode = ssl.CERT_NONE

DCR_CLIENT = "infra-bluegreen"
SCOPES = ("apim:api_view apim:api_manage apim:admin apim:admin_operations apim:tier_view "
          "apim:tier_manage apim:subscribe apim:app_manage apim:sub_manage apim:api_key "
          "apim:subscription_view apim:app_owner_change apim:environment_read "
          "apim:keymanagers_manage apim:policies_import_export apim:bl_view apim:bl_manage")


def default_configmap(ns="apim"):
    """ConfigMap to read credentials from: $APIM_CONF_CM, else blue's `apim-conf` while it still
    exists, else green's `apim-conf-green` (both hold the same credentials)."""
    if os.environ.get("APIM_CONF_CM"):
        return os.environ["APIM_CONF_CM"]
    rc = subprocess.run(["kubectl", "-n", ns, "get", "cm", "apim-conf"], capture_output=True).returncode
    return "apim-conf" if rc == 0 else "apim-conf-green"


def toml_from_configmap(name=None, ns="apim"):
    name = name or default_configmap(ns)
    return subprocess.check_output(
        ["kubectl", "-n", ns, "get", "cm", name, "-o", r"jsonpath={.data.deployment\.toml}"],
        text=True)


def toml_value(toml, section, key):
    """Tiny reader: value of `key` inside `[section]` (strings only)."""
    cur = None
    for line in toml.splitlines():
        s = line.strip()
        if s.startswith("#") or not s:
            continue
        m = re.match(r"^\[+([^\]]+)\]+$", s)
        if m:
            cur = m.group(1).strip()
            continue
        if cur == section:
            m = re.match(r'^%s\s*=\s*"(.*)"\s*$' % re.escape(key), s)
            if m:
                return m.group(1)
    return None


def admin_credentials(cm=None):
    t = toml_from_configmap(cm)
    return toml_value(t, "super_admin", "username"), toml_value(t, "super_admin", "password")


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


_OPENER = urllib.request.build_opener(urllib.request.HTTPSHandler(context=CTX), _NoRedirect())


def http(method, url, headers=None, data=None, timeout=60, raw=False, want_headers=False):
    """Returns (status, body) or (status, body, headers). Never raises on HTTP status codes and
    never follows redirects (a 302 is returned as a 302)."""
    if isinstance(data, (dict, list)):
        data = json.dumps(data).encode()
    elif isinstance(data, str):
        data = data.encode()
    req = urllib.request.Request(url, data=data, method=method, headers=headers or {})
    try:
        with _OPENER.open(req, timeout=timeout) as resp:
            status, body, hdrs = resp.status, resp.read(), resp.headers
    except urllib.error.HTTPError as e:
        status, body, hdrs = e.code, e.read(), e.headers
    if want_headers:
        return status, body, hdrs
    if raw:
        return status, body
    text = body.decode("utf-8", "replace")
    if text.strip().startswith(("{", "[")):
        try:
            return status, json.loads(text)
        except ValueError:
            pass
    return status, text


def basic(user, password):
    return "Basic " + base64.b64encode(f"{user}:{password}".encode()).decode()


class Apim:
    def __init__(self, base, user, password):
        self.base = base.rstrip("/")
        self.user, self.password = user, password
        self._tok = None

    def token(self):
        if self._tok:
            return self._tok
        st, dcr = http("POST", f"{self.base}/client-registration/v0.17/register",
                       {"Authorization": basic(self.user, self.password),
                        "Content-Type": "application/json"},
                       {"clientName": DCR_CLIENT, "owner": self.user,
                        "grantType": "password refresh_token", "saasApp": True,
                        "callbackUrl": "https://localhost"})
        if st != 200 or not isinstance(dcr, dict) or "clientId" not in dcr:
            raise RuntimeError(f"DCR failed on {self.base}: HTTP {st}")
        form = urllib.parse.urlencode({"grant_type": "password", "username": self.user,
                                       "password": self.password, "scope": SCOPES})
        st, tok = http("POST", f"{self.base}/oauth2/token",
                       {"Authorization": basic(dcr["clientId"], dcr["clientSecret"]),
                        "Content-Type": "application/x-www-form-urlencoded"}, form)
        if st != 200 or "access_token" not in tok:
            raise RuntimeError(f"admin token failed on {self.base}: HTTP {st}")
        self._tok = tok["access_token"]
        self.dcr_client_id = dcr["clientId"]
        return self._tok

    def get(self, path, ok=(200,)):
        st, body = http("GET", self.base + path,
                        {"Authorization": "Bearer " + self.token(), "Accept": "application/json"})
        if st not in ok:
            raise RuntimeError(f"GET {path} on {self.base}: HTTP {st}")
        return body

    def get_list(self, path, page=100):
        """Follow limit/offset paging until the list is exhausted."""
        out, offset = [], 0
        sep = "&" if "?" in path else "?"
        while True:
            body = self.get(f"{path}{sep}limit={page}&offset={offset}")
            items = body.get("list", []) if isinstance(body, dict) else []
            out.extend(items)
            total = (body.get("pagination") or {}).get("total") if isinstance(body, dict) else None
            offset += page
            if not items or len(items) < page or (total is not None and len(out) >= total):
                return out

    def app_keys(self, app_id):
        """Raw key list of a DevPortal application INCLUDING secrets. Memory only."""
        body = self.get(f"/api/am/devportal/v3/applications/{app_id}/oauth-keys")
        return body.get("list", []) if isinstance(body, dict) else []
