"""Core of the Cruise Saudi Weave go-live acceptance harness: configuration, an HTTP client that can
pin host names to an address (isolated test install), the result registry and the report writers.

Python 3.8+ standard library only. Nothing here prints a secret: request headers are never logged,
and evidence strings are cut to a short length.
"""
from __future__ import annotations

import base64
import html
import http.client
import json
import os
import re
import socket
import ssl
import subprocess
import time
import urllib.parse
from dataclasses import dataclass, field, asdict
from typing import Any, Callable, Dict, List, Optional, Tuple

FORBIDDEN = re.compile(r"traceit-tottech|traceit|tottempudi", re.I)
FORBIDDEN_TEXT = "TraceIT|Tottempudi|traceit-tottech (case-insensitive)"

PASS, FAIL, WAITING, SKIP, MANUAL = "PASS", "FAIL", "WAITING", "SKIP", "MANUAL"

GROUPS = [
    ("install", "Install & health"),
    ("branding", "Branding"),
    ("auth", "Sign-in & roles"),
    ("migration", "Mule to WSO2 migration end to end"),
    ("gateway", "Gateway rules on a live API"),
    ("backup", "Backup & restore"),
    ("upgrade", "Upgrade & rollback"),
    ("security", "Security checks"),
]


def short(s: Any, n: int = 300) -> str:
    s = s if isinstance(s, str) else json.dumps(s, default=str) if not isinstance(s, bytes) else s.decode("utf-8", "replace")
    s = re.sub(r"\s+", " ", s).strip()
    return s if len(s) <= n else s[: n - 3] + "..."


def stamp() -> str:
    return time.strftime("%m%d%H%M%S", time.gmtime())


# --------------------------------------------------------------------------------------------- config
@dataclass
class Config:
    base_url: str
    factory_url: str
    gateway_url: str
    apim_url: str            # API Manager REST + /oauth2 (publisher, devportal, admin)
    apim_gw_url: str         # API Manager gateway (where published APIs are called)
    isolated: bool = False
    read_only: bool = False
    dev_auth: bool = False
    insecure_tls: bool = False
    resolve: Dict[str, Tuple[str, int]] = field(default_factory=dict)  # host -> (ip, port)
    namespaces: List[str] = field(default_factory=list)
    container_prefix: str = ""
    install_dir: str = ""
    secrets_paths: List[str] = field(default_factory=list)
    out_dir: str = ""
    only: List[str] = field(default_factory=list)
    harness_dir: str = ""
    stamp: str = field(default_factory=stamp)
    env: Dict[str, str] = field(default_factory=dict)   # values from --secrets (never printed)

    def secret(self, name: str, default: str = "") -> str:
        return os.environ.get(name) or self.env.get(name) or default

    def want(self, group: str) -> bool:
        return not self.only or group in self.only


def load_env_file(path: str) -> Dict[str, str]:
    out: Dict[str, str] = {}
    if not path or not os.path.exists(path):
        return out
    for line in open(path, encoding="utf-8", errors="replace"):
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        k = k.replace("export ", "").strip()
        v = v.strip().strip('"').strip("'")
        out[k] = v
    return out


# ------------------------------------------------------------------------------------------- http
@dataclass
class Resp:
    status: int
    headers: Dict[str, str]
    body: bytes
    url: str
    error: str = ""
    set_cookies: List[str] = field(default_factory=list)

    @property
    def text(self) -> str:
        return self.body.decode("utf-8", "replace")

    def json(self) -> Any:
        try:
            return json.loads(self.text)
        except ValueError:
            return None

    def header(self, name: str) -> str:
        return self.headers.get(name.lower(), "")


class Http:
    """Small HTTP client. `resolve` pins a host name to ip:port while keeping the name for SNI and the
    Host header (like curl --resolve). Redirects are not followed unless asked."""

    def __init__(self, cfg: Config):
        self.cfg = cfg
        self.ctx = ssl.create_default_context()
        if cfg.insecure_tls:
            self.ctx.check_hostname = False
            self.ctx.verify_mode = ssl.CERT_NONE
        self.strict_ctx = ssl.create_default_context()

    def _conn(self, u: urllib.parse.SplitResult, timeout: float, strict: bool = False):
        host = u.hostname or ""
        port = u.port or (443 if u.scheme == "https" else 80)
        ip, pport = self.cfg.resolve.get(host, (host, port))
        if u.scheme == "https":
            ctx = self.strict_ctx if strict else self.ctx
            conn = http.client.HTTPSConnection(ip, pport, timeout=timeout, context=ctx)
            if ip != host:
                def connect(c=conn, h=host):
                    sock = socket.create_connection((c.host, c.port), c.timeout)
                    c.sock = ctx.wrap_socket(sock, server_hostname=h)
                conn.connect = connect  # type: ignore
            return conn
        return http.client.HTTPConnection(ip, pport, timeout=timeout)

    def request(self, method: str, url: str, headers: Optional[Dict[str, str]] = None, data: Any = None,
                timeout: float = 30, follow: bool = False, strict_tls: bool = False, max_body: int = 64 * 1024 * 1024) -> Resp:
        hops = 0
        while True:
            r = self._once(method, url, headers, data, timeout, strict_tls, max_body)
            if follow and r.status in (301, 302, 303, 307, 308) and r.header("location") and hops < 8:
                url = urllib.parse.urljoin(url, r.header("location"))
                if r.status == 303:
                    method, data = "GET", None
                hops += 1
                continue
            return r

    def _once(self, method, url, headers, data, timeout, strict_tls, max_body) -> Resp:
        u = urllib.parse.urlsplit(url)
        hdrs = {"User-Agent": "cs-acceptance/1.0", "Accept": "*/*"}
        hdrs.update(headers or {})
        if isinstance(data, (dict, list)):
            data = json.dumps(data).encode()
            hdrs.setdefault("Content-Type", "application/json")
        elif isinstance(data, str):
            data = data.encode()
        path = (u.path or "/") + (("?" + u.query) if u.query else "")
        try:
            conn = self._conn(u, timeout, strict_tls)
            conn.putrequest(method, path, skip_host=True, skip_accept_encoding=True)
            conn.putheader("Host", u.netloc)
            for k, v in hdrs.items():
                conn.putheader(k, v)
            if data is not None:
                conn.putheader("Content-Length", str(len(data)))
            conn.endheaders(data)
            resp = conn.getresponse()
            body = resp.read(max_body)
            h = {k.lower(): v for k, v in resp.getheaders()}
            cookies = [v for k, v in resp.getheaders() if k.lower() == "set-cookie"]
            conn.close()
            return Resp(resp.status, h, body, url, set_cookies=cookies)
        except Exception as e:  # network error: status 0
            return Resp(0, {}, b"", url, error=f"{type(e).__name__}: {short(str(e), 160)}")

    def get(self, url, **kw) -> Resp:
        return self.request("GET", url, **kw)


def basic(user: str, pw: str) -> str:
    return "Basic " + base64.b64encode(f"{user}:{pw}".encode()).decode()


# ---------------------------------------------------------------------------------------- results
@dataclass
class Result:
    id: str
    group: str
    title: str
    status: str
    evidence: str = ""
    seconds: float = 0.0


class Run:
    def __init__(self, cfg: Config):
        self.cfg = cfg
        self.results: List[Result] = []
        self.started = time.time()
        self.notes: List[str] = []

    def add(self, id: str, group: str, title: str, status: str, evidence: str = "", seconds: float = 0.0):
        r = Result(id, group, title, status, short(evidence, 900), round(seconds, 1))
        self.results.append(r)
        color = {"PASS": "\033[32m", "FAIL": "\033[31m", "WAITING": "\033[33m", "SKIP": "\033[90m", "MANUAL": "\033[36m"}.get(status, "")
        tty = os.isatty(1)
        print(f"{color if tty else ''}{status:<7}{chr(27) + '[0m' if tty else ''} {id:<5} {title}" + (f"\n        - {r.evidence}" if r.evidence else ""), flush=True)
        return r

    def check(self, id: str, group: str, title: str, fn: Callable[[], Tuple[str, str]]):
        """Run fn() -> (status, evidence); an exception is a FAIL with its message as evidence."""
        t0 = time.time()
        try:
            status, ev = fn()
        except Exception as e:
            status, ev = FAIL, f"error: {type(e).__name__}: {short(str(e), 300)}"
        return self.add(id, group, title, status, ev, time.time() - t0)

    # ------------------------------------------------------------------ reports
    def summary(self) -> Dict[str, Dict[str, int]]:
        out: Dict[str, Dict[str, int]] = {}
        for r in self.results:
            g = out.setdefault(r.group, {})
            g[r.status] = g.get(r.status, 0) + 1
        return out

    def write(self) -> Tuple[str, str]:
        os.makedirs(self.cfg.out_dir, exist_ok=True)
        meta = {
            "product": "Cruise Saudi Weave", "suite": "go-live acceptance",
            "started": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(self.started)),
            "seconds": round(time.time() - self.started, 1),
            "base_url": self.cfg.base_url, "factory_url": self.cfg.factory_url, "gateway_url": self.cfg.gateway_url,
            "apim_url": self.cfg.apim_url, "apim_gateway_url": self.cfg.apim_gw_url,
            "isolated_test": self.cfg.isolated, "read_only": self.cfg.read_only, "dev_auth": self.cfg.dev_auth,
            "host": socket.gethostname(), "notes": self.notes,
        }
        jp = os.path.join(self.cfg.out_dir, "report.json")
        with open(jp, "w") as f:
            json.dump({"meta": meta, "summary": self.summary(), "results": [asdict(r) for r in self.results]}, f, indent=2)
        hp = os.path.join(self.cfg.out_dir, "report.html")
        with open(hp, "w") as f:
            f.write(render_html(meta, self.summary(), self.results))
        return jp, hp


def render_html(meta: Dict[str, Any], summary: Dict[str, Dict[str, int]], results: List[Result]) -> str:
    e = html.escape
    rows = []
    for gid, gtitle in GROUPS:
        rs = [r for r in results if r.group == gid]
        if not rs:
            continue
        counts = " ".join(f'<span class="pill {k.lower()}">{k} {v}</span>' for k, v in sorted(summary.get(gid, {}).items()))
        rows.append(f'<tr class="g"><th colspan="4">{e(gtitle)} {counts}</th></tr>')
        for r in rs:
            rows.append(f'<tr><td><span class="pill {r.status.lower()}">{r.status}</span></td><td class="id">{e(r.id)}</td>'
                        f'<td>{e(r.title)}</td><td class="ev">{e(r.evidence)}</td></tr>')
    tot: Dict[str, int] = {}
    for g in summary.values():
        for k, v in g.items():
            tot[k] = tot.get(k, 0) + v
    totals = " ".join(f'<span class="pill {k.lower()}">{k} {v}</span>' for k, v in sorted(tot.items()))
    m = "".join(f"<div><b>{e(k)}</b> {e(str(v))}</div>" for k, v in meta.items() if k != "notes")
    notes = "".join(f"<li>{e(n)}</li>" for n in meta.get("notes", []))
    return f"""<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Acceptance report</title><style>
:root{{--bg:#fff;--fg:#14202b;--mut:#5b6b7a;--line:#dfe5ea;--pass:#1d7a45;--fail:#b3261e;--wait:#9a6700;--skip:#6b7785;--man:#1f5f99}}
@media (prefers-color-scheme:dark){{:root{{--bg:#0f161d;--fg:#e6edf3;--mut:#9aa7b4;--line:#26313b;--pass:#4cc38a;--fail:#ff7b72;--wait:#e3b341;--skip:#8b98a5;--man:#79b8ff}}}}
body{{background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,sans-serif;margin:0;padding:16px}}
h1{{font-size:20px;margin:0 0 8px}} .meta{{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:2px 16px;color:var(--mut);margin-bottom:12px;font-size:12px}}
table{{border-collapse:collapse;width:100%}} td,th{{border-bottom:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}}
tr.g th{{padding-top:18px;font-size:15px}} td.id{{font-family:ui-monospace,monospace;white-space:nowrap}} td.ev{{color:var(--mut);font-size:12px;word-break:break-word}}
.pill{{display:inline-block;border:1px solid currentColor;border-radius:10px;padding:0 7px;font-size:11px;font-weight:600;white-space:nowrap}}
.pass{{color:var(--pass)}}.fail{{color:var(--fail)}}.waiting{{color:var(--wait)}}.skip{{color:var(--skip)}}.manual{{color:var(--man)}}
@media (max-width:640px){{td.ev{{display:block}}}}
</style></head><body><h1>Cruise Saudi Weave go-live acceptance</h1><div>{totals}</div><div class="meta">{m}</div>
{"<ul>" + notes + "</ul>" if notes else ""}<table>{''.join(rows)}</table></body></html>"""


# ------------------------------------------------------------------------------------------ misc
def sh(cmd: List[str], timeout: float = 120, input: Optional[bytes] = None) -> Tuple[int, str]:
    try:
        p = subprocess.run(cmd, capture_output=True, timeout=timeout, input=input)
        return p.returncode, (p.stdout + p.stderr).decode("utf-8", "replace")
    except FileNotFoundError:
        return 127, f"{cmd[0]}: not installed"
    except subprocess.TimeoutExpired:
        return 124, "timeout"


def have(cmd: str) -> bool:
    return sh(["sh", "-c", f"command -v {cmd}"])[0] == 0


def scan_text(text: str, where: str, hits: List[Dict[str, str]], limit: int = 400):
    for m in FORBIDDEN.finditer(text):
        if len(hits) >= limit:
            return
        a, b = max(0, m.start() - 40), min(len(text), m.end() + 40)
        hits.append({"where": where, "match": m.group(0), "context": short(text[a:b], 120)})
