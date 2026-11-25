"""WSO2 API Manager 4.x REST client for the throw-away objects of the acceptance run, plus the
stand-in backend. Every object it creates is named cs-acc-*; nothing else is ever changed.

Credentials: ACC_APIM_USER / ACC_APIM_PASSWORD (from --secrets or the environment), or read from the
`deployment.toml` of a ConfigMap in ACC_APIM_NAMESPACE (super_admin section). Never printed.
"""
from __future__ import annotations

import json
import os
import re
import socket
import subprocess
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, List, Optional, Tuple

from .core import Config, Http, basic, short, have

PUB, DEV, ADM = "/api/am/publisher/v4", "/api/am/devportal/v3", "/api/am/admin/v4"
SCOPES = ("apim:api_view apim:api_create apim:api_manage apim:api_publish apim:admin apim:tier_view apim:tier_manage "
          "apim:subscribe apim:app_manage apim:sub_manage apim:api_key apim:subscription_view apim:environment_read "
          "apim:bl_view apim:bl_manage apim:policies_import_export")


def credentials(cfg: Config) -> Tuple[str, str]:
    u, p = cfg.secret("ACC_APIM_USER"), cfg.secret("ACC_APIM_PASSWORD")
    if u and p:
        return u, p
    ns = cfg.secret("ACC_APIM_NAMESPACE")
    if ns and have("kubectl"):
        items = []
        for kind in ("cm", "secret"):
            out = subprocess.run(["kubectl", "-n", ns, "get", kind, "-o", "json"], capture_output=True, text=True).stdout
            try:
                items += json.loads(out).get("items", [])
            except ValueError:
                pass
        try:
            import base64 as _b64
            for cm in items:
                toml = (cm.get("data") or {}).get("deployment.toml")
                if toml and cm.get("kind") == "Secret":
                    toml = _b64.b64decode(toml).decode("utf-8", "replace")
                if toml and "[super_admin]" in toml:
                    sec = toml.split("[super_admin]", 1)[1].split("\n[", 1)[0]
                    mu = re.search(r'^\s*username\s*=\s*"(.*)"', sec, re.M)
                    mp = re.search(r'^\s*password\s*=\s*"(.*)"', sec, re.M)
                    if mu and mp:
                        return mu.group(1), mp.group(1)
        except ValueError:
            pass
    return "", ""


class ApimError(RuntimeError):
    pass


class Apim:
    def __init__(self, cfg: Config, h: Http):
        self.cfg, self.h = cfg, h
        self.base = cfg.apim_url.rstrip("/")
        self.user, self.pw = credentials(cfg)
        self._tok: Optional[str] = None
        self.dcr: Optional[Dict[str, str]] = None

    def available(self) -> Tuple[bool, str]:
        if not self.base:
            return False, "no API Manager address"
        if not self.user:
            return False, "no API Manager admin credentials (ACC_APIM_USER/ACC_APIM_PASSWORD or ACC_APIM_NAMESPACE)"
        return True, ""

    def token(self) -> str:
        if self._tok:
            return self._tok
        name = f"cs-acc-client-{self.cfg.stamp}"
        x = self.h.request("POST", self.base + "/client-registration/v0.17/register", timeout=30,
                           headers={"Authorization": basic(self.user, self.pw), "Content-Type": "application/json"},
                           data={"clientName": name, "owner": self.user, "grantType": "password refresh_token client_credentials",
                                 "saasApp": True, "callbackUrl": "https://localhost"})
        j = x.json() or {}
        if x.status != 200 or "clientId" not in j:
            raise ApimError(f"client registration -> {x.status} {x.error}")
        self.dcr = {"clientId": j["clientId"], "clientSecret": j["clientSecret"]}
        form = urllib.parse.urlencode({"grant_type": "password", "username": self.user, "password": self.pw, "scope": SCOPES})
        t = self.h.request("POST", self.base + "/oauth2/token", timeout=30, data=form,
                           headers={"Authorization": basic(j["clientId"], j["clientSecret"]), "Content-Type": "application/x-www-form-urlencoded"})
        tj = t.json() or {}
        if t.status != 200 or "access_token" not in tj:
            raise ApimError(f"admin token -> {t.status}")
        self._tok = tj["access_token"]
        return self._tok

    def call(self, method: str, path: str, data: Any = None, ok=(200, 201, 202, 204), headers: Optional[Dict[str, str]] = None, timeout=60):
        hd = {"Authorization": "Bearer " + self.token(), "Accept": "application/json"}
        hd.update(headers or {})
        x = self.h.request(method, self.base + path, headers=hd, data=data, timeout=timeout)
        if x.status not in ok:
            raise ApimError(f"{method} {path.split('?')[0]} -> {x.status} {short(x.text, 160)}")
        return x.json() if x.body else None

    def list(self, path: str) -> List[Dict[str, Any]]:
        sep = "&" if "?" in path else "?"
        out, off = [], 0
        while True:
            j = self.call("GET", f"{path}{sep}limit=100&offset={off}") or {}
            items = j.get("list", [])
            out += items
            if len(items) < 100:
                return out
            off += 100

    def close(self):
        if self.dcr:
            self.h.request("DELETE", f"{self.base}/client-registration/v0.17/register/{self.dcr['clientId']}",
                           headers={"Authorization": basic(self.user, self.pw)}, timeout=20)
            self.dcr = None

    # -------------------------------------------------------------- application helpers
    def app_with_token(self, name: str, api_id: str, policy: str = "Unlimited") -> Dict[str, str]:
        app = self.call("POST", DEV + "/applications", {"name": name, "throttlingPolicy": "Unlimited", "tokenType": "JWT",
                                                        "description": "cs-acc acceptance run, removed at the end"})
        out = {"applicationId": app["applicationId"], "name": name}
        sub = self.call("POST", DEV + "/subscriptions", {"apiId": api_id, "applicationId": app["applicationId"], "throttlingPolicy": policy})
        out["subscriptionId"] = sub["subscriptionId"]
        k = self.call("POST", f"{DEV}/applications/{app['applicationId']}/generate-keys",
                      {"keyType": "PRODUCTION", "keyManager": "Resident Key Manager", "grantTypesToBeSupported": ["client_credentials"],
                       "validityTime": 3600})
        out["consumerKey"], out["consumerSecret"] = k["consumerKey"], k["consumerSecret"]
        out["token"] = self.client_token(out)
        return out

    def client_token(self, app: Dict[str, str]) -> str:
        t = self.h.request("POST", self.base + "/oauth2/token", timeout=30, data="grant_type=client_credentials",
                           headers={"Authorization": basic(app["consumerKey"], app["consumerSecret"]),
                                    "Content-Type": "application/x-www-form-urlencoded"})
        tj = t.json() or {}
        if "access_token" not in tj:
            raise ApimError(f"application token -> {t.status}")
        return tj["access_token"]

    def revoke(self, app: Dict[str, str], token: str) -> int:
        x = self.h.request("POST", self.base + "/oauth2/revoke", timeout=30, data=urllib.parse.urlencode({"token": token}),
                           headers={"Authorization": basic(app["consumerKey"], app["consumerSecret"]),
                                    "Content-Type": "application/x-www-form-urlencoded"})
        return x.status


# ------------------------------------------------------------------------------- stand-in backend
class StandIn:
    """Tiny JSON backend for the throw-away API and the migrated sample service. Listens on the
    cluster bridge address (pods reach the host there), never on a public interface."""

    def __init__(self, cfg: Config):
        bind = cfg.secret("ACC_BACKEND_BIND") or ("10.42.0.1" if _has_addr("10.42.0.1") else "127.0.0.1")
        self.calls: List[Dict[str, Any]] = []
        calls = self.calls

        class H(BaseHTTPRequestHandler):
            def _answer(self):
                n = int(self.headers.get("Content-Length") or 0)
                body = self.rfile.read(n) if n else b""
                try:
                    parsed = json.loads(body) if body else None
                except ValueError:
                    parsed = body.decode("utf-8", "replace")[:200]
                calls.append({"method": self.command, "path": self.path, "body": parsed})
                if self.command == "POST" and self.path.rstrip("/").endswith("/orders"):
                    out = {"id": f"cs-acc-{len(calls)}", "status": "CREATED", "received": parsed}
                else:
                    out = {"ok": True, "method": self.command, "path": self.path}
                data = json.dumps(out).encode()
                self.send_response(200 if self.command != "POST" else 201)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            do_GET = do_POST = do_PUT = do_DELETE = _answer

            def log_message(self, *a):
                pass

        self.srv = ThreadingHTTPServer((bind, int(cfg.secret("ACC_BACKEND_PORT", "0"))), H)
        self.host, self.port = self.srv.server_address[0], self.srv.server_address[1]
        self.url = cfg.secret("ACC_BACKEND_URL") or f"http://{self.host}:{self.port}"
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()

    def stop(self):
        self.srv.shutdown()


def _has_addr(ip: str) -> bool:
    s = socket.socket()
    try:
        s.bind((ip, 0))
        return True
    except OSError:
        return False
    finally:
        s.close()
