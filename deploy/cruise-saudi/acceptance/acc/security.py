"""Security checks: no default passwords, no open NodePorts, TLS only, secrets file permissions,
cookies, headers, no secrets in what the browser downloads."""
from __future__ import annotations

import glob
import json
import os
import re
import stat
import urllib.parse

from .core import Config, Http, Run, PASS, FAIL, WAITING, SKIP, MANUAL, sh, have, short, basic

G = "security"
# a secret-looking value: 10+ characters without spaces that mix letters and digits (UI words such as
# type:"password" or label texts do not match)
_VAL = r"[\"']((?=[^\"'\s]*\d)(?=[^\"'\s]*[A-Za-z])[^\"'\s]{10,})[\"']"
SECRET_PATTERNS = re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----|AKIA[0-9A-Z]{16}|"
                             r"\b(?:client_?secret|consumer_?secret|password|passwd|api_?key|x-weave-key)[\"']?\s*[:=]\s*" + _VAL, re.I)


def run(cfg: Config, h: Http, r: Run, ses):
    F, Gw = cfg.factory_url.rstrip("/"), (cfg.gateway_url or "").rstrip("/")
    https = cfg.base_url.startswith("https://")

    def apim_default():
        if not cfg.apim_url:
            return WAITING, "no API Manager address"
        tried = []
        for u, p in (("admin", "admin"), ("admin", "Admin123"), ("admin", "password")):
            x = h.request("POST", cfg.apim_url.rstrip("/") + "/client-registration/v0.17/register", timeout=20,
                          headers={"Authorization": basic(u, p), "Content-Type": "application/json"},
                          data={"clientName": "cs-acc-default-pw-probe", "owner": u, "grantType": "client_credentials", "saasApp": True})
            tried.append(f"{u}/{'*' * len(p)} -> {x.status}")
            if x.status == 200:
                cid = (x.json() or {}).get("clientId")
                if cid:
                    h.request("DELETE", cfg.apim_url.rstrip("/") + f"/client-registration/v0.17/register/{cid}",
                              headers={"Authorization": basic(u, p)}, timeout=20)
                return FAIL, f"API Manager accepts a default password: {tried[-1]}"
        return PASS, "default admin passwords refused: " + ", ".join(tried)
    r.check("S1", G, "API Manager: default admin passwords refused", apim_default)

    def factory_default():
        if cfg.dev_auth:
            return SKIP, "dev-auth test instance"
        x = ses.login_raw(F, "admin", "admin")
        if x.status == 404:
            return WAITING, f"no local sign-in at {ses.login_path} yet (cs/users)"
        return (PASS if x.status in (400, 401, 403) and not x.set_cookies else FAIL), f"admin/admin -> {x.status}"
    r.check("S2", G, "Consoles: default admin/admin refused", factory_default)

    def nodeports():
        if not cfg.namespaces:
            return SKIP, "no install namespaces given (--namespaces)"
        if not have("kubectl"):
            return SKIP, "kubectl not available"
        allowed = set(x for x in cfg.secret("ACC_ALLOWED_NODEPORTS", "").split(",") if x)
        open_ = []
        n = 0
        for ns in cfg.namespaces:
            rc, out = sh(["kubectl", "get", "svc", "-n", ns, "-o", "json"], 60)
            if rc != 0:
                return FAIL, f"kubectl get svc -n {ns}: {short(out, 120)}"
            for s in json.loads(out).get("items", []):
                n += 1
                t = s["spec"].get("type")
                if t in ("NodePort", "LoadBalancer"):
                    ports = [str(p.get("nodePort")) for p in s["spec"].get("ports", []) if p.get("nodePort")]
                    if not all(p in allowed for p in ports):
                        open_.append(f"{ns}/{s['metadata']['name']} {t} {','.join(ports)}")
        if open_:
            return FAIL, f"{len(open_)} of {n} services open on the node: {'; '.join(open_[:10])}"
        return PASS, f"{n} services in {','.join(cfg.namespaces)}: none of type NodePort/LoadBalancer"
    r.check("S3", G, "No open NodePorts / LoadBalancers in the install namespaces", nodeports)

    def listeners():
        if not have("ss"):
            return SKIP, "ss not available"
        rc, out = sh(["ss", "-ltnH"], 20)
        allowed = {"22", "80", "443"} | set(x for x in cfg.secret("ACC_ALLOWED_PORTS", "").split(",") if x)
        public = set()
        for line in out.splitlines():
            parts = line.split()
            if len(parts) < 4:
                continue
            addr = parts[3]
            host, _, port = addr.rpartition(":")
            if host.strip("[]") in ("127.0.0.1", "::1", "127.0.0.53", "127.0.0.54") or host.startswith("127.") or host.startswith("10.42.") :
                continue
            if port not in allowed:
                public.add(port)
        ev = f"ports open beyond {sorted(allowed)}: {sorted(public, key=lambda p: int(p) if p.isdigit() else 0)[:30]}"
        if cfg.isolated:
            return MANUAL, "shared test host (not the customer server) - judge on the customer server; " + ev
        return (FAIL if public else PASS), ev
    r.check("S4", G, "Host listens publicly only on 22/80/443 (plus agreed ports)", listeners)

    def tls_only():
        if not https:
            return SKIP, f"target {cfg.base_url} is a plain-http loopback test instance"
        u = urllib.parse.urlsplit(cfg.base_url)
        if cfg.isolated:
            return SKIP, "isolated test exposes only the TLS port 127.0.0.1:9443 (no port 80 to test)"
        x = h.get(f"http://{u.netloc}/", timeout=10)
        if x.status == 0:
            return PASS, f"http://{u.netloc} refused ({x.error})"
        loc = x.header("location")
        return (PASS if x.status in (301, 302, 307, 308) and loc.startswith("https://") else FAIL), f"http -> {x.status} {loc[:60]}"
    r.check("S5", G, "Plain HTTP is refused or redirected to HTTPS", tls_only)

    def tls_proto():
        if not https:
            return SKIP, "plain-http test instance"
        if not have("openssl"):
            return SKIP, "openssl not available"
        u = urllib.parse.urlsplit(cfg.base_url)
        host = u.hostname or ""
        ip, port = cfg.resolve.get(host, (host, u.port or 443))
        res = {}
        for proto in ("-tls1", "-tls1_1", "-tls1_2", "-tls1_3"):
            rc, out = sh(["openssl", "s_client", proto, "-connect", f"{ip}:{port}", "-servername", host], 15, input=b"")
            res[proto[1:]] = "accepted" if ("BEGIN CERTIFICATE" in out or "Cipher is" in out) and "Cipher is (NONE)" not in out else "refused"
        strict = h.get(cfg.base_url, timeout=15, strict_tls=True)
        cert = "valid (trusted chain, right name)" if strict.status else f"not trusted: {strict.error[:80]}"
        old_ok = res.get("tls1") == "refused" and res.get("tls1_1") == "refused"
        cert_ok = bool(strict.status) or cfg.isolated
        return (PASS if old_ok and res.get("tls1_2") == "accepted" and cert_ok else FAIL), f"{res}; certificate {cert}" + (" (test CA expected on the isolated install)" if cfg.isolated and not strict.status else "")
    r.check("S6", G, "TLS 1.2+ only, trusted certificate", tls_proto)

    def headers():
        out, bad = [], []
        for name, base in (("factory", F), ("gateway", Gw)):
            if not base:
                continue
            x = h.get(base + "/", timeout=15, follow=True)
            want = {"strict-transport-security": https, "x-content-type-options": True}
            frame = bool(x.header("x-frame-options")) or "frame-ancestors" in x.header("content-security-policy")
            miss = [k for k, need in want.items() if need and not x.header(k)] + ([] if frame else ["x-frame-options/frame-ancestors"])
            leak = [f"{k}: {x.header(k)}" for k in ("server", "x-powered-by") if x.header(k)]
            out.append(f"{name}: missing {miss or 'none'}; reveals {leak or 'nothing'}")
            if miss:
                bad.append(name)
        if not out:
            return WAITING, "no app reachable"
        return (FAIL if bad else PASS), "; ".join(out)
    r.check("S7", G, "Security headers (HSTS, nosniff, no framing)", headers)

    def cookies():
        if cfg.dev_auth:
            return SKIP, "dev-auth test instance"
        user, pw = ses.creds("admin")
        if not user:
            return WAITING, "no admin credentials to sign in"
        x = ses.login_raw(F, user, pw)
        if not x.set_cookies:
            return WAITING, f"sign-in -> {x.status}, no cookie"
        bad = []
        for c in x.set_cookies:
            low = c.lower()
            need = ["httponly", "samesite"] + (["secure"] if https else [])
            m = [n for n in need if n not in low]
            if m:
                bad.append(f"{c.split('=', 1)[0]} lacks {m}")
        return (FAIL if bad else PASS), f"{len(x.set_cookies)} session cookies; " + ("; ".join(bad) if bad else "all HttpOnly, SameSite" + (", Secure" if https else ""))
    r.check("S8", G, "Session cookies are HttpOnly, SameSite and Secure", cookies)

    def secrets_files():
        paths = []
        for g in cfg.secrets_paths:
            paths += [p for p in glob.glob(g, recursive=True) if os.path.isfile(p) and not p.endswith(".pub")]  # public keys are public
        if not paths:
            return WAITING, f"no secrets files found at {cfg.secrets_paths or '(none given: --secrets-glob)'}"
        bad = []
        for p in paths:
            s = os.stat(p)
            if s.st_mode & 0o077 or s.st_uid != 0:
                bad.append(f"{p} mode {oct(s.st_mode & 0o777)} uid {s.st_uid}")
        return (FAIL if bad else PASS), f"{len(paths)} files; " + ("; ".join(bad[:8]) if bad else "all root-owned, mode 600 or stricter")
    r.check("S9", G, "Secrets files are root-only (600)", secrets_files)

    def no_secrets_in_browser():
        found, n = [], 0
        for name, base in (("factory", F), ("gateway", Gw)):
            if not base:
                continue
            idx = h.get(base + "/", timeout=15, follow=True)
            refs = re.findall(r'src="([^"]+\.js)"', idx.text)
            for t, where in [(idx.text, "index")] + [(h.get(urllib.parse.urljoin(base + "/", ref), timeout=30).text, ref) for ref in refs]:
                n += 1
                for m in SECRET_PATTERNS.finditer(t):
                    label = re.split(r"[:=]", m.group(0), 1)[0][:30]  # never the value itself
                    found.append(f"{name} {where[-40:]}: {label} = <hidden, {len(m.group(0))} chars>")
        return (FAIL if found else PASS), f"{n} files; " + ("; ".join(found[:5]) if found else "no keys, client secrets or passwords")
    r.check("S10", G, "No keys, client secrets or passwords in what the browser downloads", no_secrets_in_browser)
