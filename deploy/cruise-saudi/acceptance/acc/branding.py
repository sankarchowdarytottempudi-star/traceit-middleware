"""Branding: no TraceIT / Tottempudi / traceit-tottech anywhere a Cruise Saudi user can see or download.

B1/B2 rendered UI of both apps (Playwright crawl, every route + every tab)
B3    raw HTML, page titles and every static asset referenced by both index pages
B4    API answers: error texts, health, headers, unknown routes
B5    downloadable documents (generated documents, workbooks, packages: zips are opened)
B6    texts shipped inside the images (e-mail templates, server messages, document templates)
B7    positive check: the product calls itself "Cruise Saudi Weave"
B8    e-mails: manual (a real e-mail must be received and read)
"""
from __future__ import annotations

import io
import json
import os
import re
import shlex
import subprocess
import urllib.parse
import zipfile
from typing import Dict, List, Optional

from .core import Config, Http, Run, PASS, FAIL, WAITING, SKIP, MANUAL, FORBIDDEN_TEXT, scan_text, short, sh, have

G = "branding"

FACTORY_ROUTES = ["", "migrations", "migrations/new", "migrations/from-git", "migrations/from-requirements", "migrations/paste",
                  "estate", "workspaces", "knowledge", "playground", "canvas", "tool-health", "studio", "studio/connections",
                  "studio/connectors", "studio/executions", "admin", "admin/users", "settings", "no-such-page-cs-acc"]
GATEWAY_ROUTES = ["", "apis", "rate-limits", "gateways", "analytics", "gateway-analytics", "logs", "compliance", "approvals",
                  "policies", "consumers", "applications", "blocking", "audit", "no-such-page-cs-acc"]


def _fmt(hits: List[Dict[str, str]], n: int = 6) -> str:
    by: Dict[str, int] = {}
    for x in hits:
        by[x["where"]] = by.get(x["where"], 0) + 1
    top = "; ".join(f"{k}: {v}" for k, v in sorted(by.items(), key=lambda kv: -kv[1])[:n])
    ex = " | ".join(f"[{x['match']}] {x.get('url', '')[-60:]} ...{x['context']}..." for x in hits[:3])
    return f"{len(hits)} hits ({top}). e.g. {ex}"


def _texty(ct: str) -> bool:
    return bool(re.search(r"text/|javascript|json|svg|xml|manifest", ct or "", re.I))


def scan_blob(name: str, data: bytes, hits: List[Dict[str, str]], depth: int = 0):
    """Scan a downloaded file; zips (incl. .xlsx/.docx/.jar) are opened and every text entry scanned."""
    if data[:2] == b"PK" and depth < 3:
        try:
            z = zipfile.ZipFile(io.BytesIO(data))
            scan_text(name, f"file name", hits)
            for info in z.infolist()[:3000]:
                if info.file_size > 20 * 1024 * 1024:
                    continue
                scan_text(info.filename, f"entry name in {name}", hits)
                scan_blob(f"{name}!{info.filename}", z.read(info), hits, depth + 1)
            return
        except zipfile.BadZipFile:
            pass
    if b"\x00" in data[:4096] and not data.startswith(b"%PDF"):
        return  # binary
    scan_text(data.decode("utf-8", "replace"), f"document {name}", hits)


def run(cfg: Config, h: Http, r: Run, ses, extra_migrations: Optional[List[str]] = None):
    F, Gw = cfg.factory_url.rstrip("/"), (cfg.gateway_url or "").rstrip("/")
    fh = ses.headers("factory", "admin") or {}
    gh = ses.headers("gateway", "admin") if Gw else None

    # ---------------------------------------------------------------- B1/B2 rendered UI (Playwright)
    crawl = _crawl(cfg, ses)
    for cid, app, title in (("B1", "factory", "Factory UI: every route and tab, rendered text, titles and HTML"),
                            ("B2", "gateway", "Gateway UI: every route and tab, rendered text, titles and HTML")):
        def f(app=app):
            if crawl.get("error"):
                return (SKIP if crawl.get("skip") else FAIL), crawl["error"]
            pages = [p for p in crawl["pages"] if p["app"] == app]
            if not pages:
                return WAITING, f"no {app} address / not crawled"
            hits = [x for x in crawl["hits"] if x["where"].startswith(app + ":") and "response" not in x["where"]]
            ok = [p for p in pages if not p.get("error")]
            signed_in = "" if ses.headers(app, "admin") is not None else " (signed-out pages only: no session for this app)"
            base = f"{len(ok)}/{len(pages)} pages, {sum(p.get('tabs', 0) for p in pages)} tabs{signed_in}"
            if hits:
                return FAIL, f"{base}; {_fmt(hits)}"
            return PASS, f"{base}; no {FORBIDDEN_TEXT}"
        r.check(cid, G, title, f)

    # ---------------------------------------------------------------- B3 raw HTML + static assets
    def assets():
        hits: List[Dict[str, str]] = []
        fetched = 0
        titles = []
        for name, base, hd in (("factory", F, fh), ("gateway", Gw, gh or {})):
            if not base:
                continue
            idx = h.get(base + "/", headers=hd, timeout=20, follow=True)
            if idx.status != 200:
                hits.append({"where": f"{name}: index", "match": "-", "context": f"index -> {idx.status}", "url": base})
                continue
            scan_text(idx.text, f"{name}: index.html", hits)
            m = re.search(r"<title>(.*?)</title>", idx.text, re.S | re.I)
            titles.append(f"{name}: {m.group(1).strip() if m else '(no title)'}")
            refs = set(re.findall(r'(?:src|href)="([^"]+)"', idx.text))
            origin = "{0.scheme}://{0.netloc}".format(urllib.parse.urlsplit(base))
            queue = [urllib.parse.urljoin(base + "/", x) for x in refs]
            seen = set()
            while queue and fetched < 400:
                u = queue.pop()
                if u in seen or not u.startswith(origin):
                    continue
                seen.add(u)
                x = h.get(u, headers=hd, timeout=30)
                fetched += 1
                if x.status != 200:
                    continue
                if _texty(x.header("content-type")) or u.endswith((".js", ".css", ".svg", ".webmanifest", ".json")):
                    t = x.text
                    scan_text(t, f"{name}: asset {u.rsplit('/', 1)[-1][:40]}", hits)
                    # follow imports between chunks and manifest icons
                    for ref in re.findall(r'["\'(]((?:\.{0,2}/)?(?:assets|brand|icons)/[\w./-]+\.(?:js|css|svg|webmanifest|json))', t):
                        queue.append(urllib.parse.urljoin(u, ref))
        ev = f"{fetched} files fetched; titles: {', '.join(titles)}"
        if hits:
            return FAIL, f"{ev}; {_fmt(hits)}"
        return PASS, f"{ev}; no {FORBIDDEN_TEXT}"
    r.check("B3", G, "HTML, page titles, scripts, styles, icons and manifests of both apps", assets)

    # ---------------------------------------------------------------- B4 API answers
    def api_texts():
        hits: List[Dict[str, str]] = []
        probes = [("factory", F, p) for p in ("/healthz", "/api/auth/me", "/api/factory/no-such-route-cs-acc",
                                              "/api/factory/migrations/cs-acc-none", "/api/factory/migrations/cs-acc-none/docs",
                                              "/api/factory/migrations/cs-acc-none/docs/NOPE.md", "/api/factory/estate/cs-acc-none",
                                              "/api/factory/jobs/cs-acc-none", "/api/auth/login", "/api/factory/tool-health",
                                              "/api/factory/migrate/options", "/api/factory/phases")]
        if Gw:
            probes += [("gateway", Gw, p) for p in ("/healthz", "/api/auth/me", "/api/no-such-route-cs-acc", "/api/apis",
                                                    "/api/ratelimits/cs-acc-none", "/api/compliance/cs-acc-none", "/api/auth/login")]
        n = 0
        for name, base, path in probes:
            hd = fh if name == "factory" else (gh or {})
            for with_session in ((True, False) if hd else (False,)):
                x = h.get(base + path, headers=hd if with_session else {}, timeout=20)
                n += 1
                scan_text(x.text, f"{name}: {path} ({x.status})", hits)
                for k, v in x.headers.items():
                    scan_text(f"{k}: {v}", f"{name}: header of {path}", hits)
        if hits:
            return FAIL, f"{n} answers checked; {_fmt(hits)}"
        return PASS, f"{n} answers (errors, health, unknown routes, headers, sign-in redirect) checked; no {FORBIDDEN_TEXT}"
    r.check("B4", G, "API answers and error texts of both apps", api_texts)

    # ---------------------------------------------------------------- B5 downloadable documents
    def documents():
        hits: List[Dict[str, str]] = []
        lst = h.get(F + "/api/factory/migrations", headers=fh, timeout=30)
        if lst.status != 200:
            return WAITING, f"migration list -> {lst.status}"
        ms = (lst.json() or {}).get("migrations", [])
        ids = list(extra_migrations or [])
        limit = int(cfg.secret("ACC_DOC_MIGRATIONS", "3"))
        ids += [m["id"] for m in sorted(ms, key=lambda m: m.get("updatedAt") or "", reverse=True) if m["id"] not in ids][:limit]
        files = 0
        urls = [F + "/api/factory/requirements/template.xlsx"]
        for mid in ids:
            d = h.get(F + f"/api/factory/migrations/{mid}/docs", headers=fh, timeout=30)
            dj = d.json() or {}
            names = [x if isinstance(x, str) else x.get("name") for x in (dj.get("docs") or dj.get("documents") or (dj if isinstance(dj, list) else []))]
            urls += [F + f"/api/factory/migrations/{mid}/docs/{urllib.parse.quote(n)}" for n in names if n]
            urls += [F + f"/api/factory/migrations/{mid}/{p}" for p in ("corrections.xlsx", "requirements-template.xlsx", "package", "open-items", "parity")]
        urls += [u for u in crawl.get("downloads", []) if "/api/" in u][:40]
        for u in dict.fromkeys(urls):
            x = h.get(u, headers=fh, timeout=120)
            if x.status != 200 or not x.body:
                continue
            files += 1
            scan_blob(u.rsplit("/", 2)[-2] + "/" + u.rsplit("/", 1)[-1], x.body, hits)
        ev = f"{files} documents from {len(ids)} migrations (+ templates) opened, zips/xlsx unpacked"
        if files == 0:
            return WAITING, "no downloadable document found yet"
        if hits:
            return FAIL, f"{ev}; {_fmt(hits)}"
        return PASS, f"{ev}; no {FORBIDDEN_TEXT}"
    r.check("B5", G, "Downloadable documents (generated docs, workbooks, packages)", documents)

    # ---------------------------------------------------------------- B6 texts inside the images
    def images():
        imgs = [i for i in cfg.secret("ACC_IMAGES", "").split(",") if i]
        if not imgs and cfg.container_prefix and have("docker"):
            rc, out = sh(["docker", "ps", "--filter", f"name=^{cfg.container_prefix}", "--format", "{{.Image}}"], 30)
            imgs = sorted(set(l.strip() for l in out.splitlines() if l.strip()))
        if not imgs:
            return SKIP, "no images given (ACC_IMAGES) and no install containers found"
        if not have("docker"):
            return SKIP, "docker not available"
        found, checked = [], []
        script = ("for d in /app /srv /usr/share/nginx/html /opt/weave; do [ -d $d ] && "
                  "grep -rIilE 'traceit|tottempudi' $d --exclude-dir=node_modules --exclude-dir=.git 2>/dev/null; done | head -40")
        for img in imgs:
            rc, out = sh(shlex.split(cfg.secret("ACC_HEAVY_PREFIX", "")) + ["docker", "run", "--rm", "--network", "none", "--entrypoint", "sh", img, "-c", script], 300)
            checked.append(img)
            files = [l for l in out.splitlines() if l.startswith("/")]
            if files:
                found.append(f"{img}: {len(files)} files e.g. {', '.join(files[:5])}")
        if found:
            return FAIL, "; ".join(found)
        return PASS, f"images {', '.join(checked)}: no file outside node_modules names {FORBIDDEN_TEXT}"
    r.check("B6", G, "Server texts shipped in the images (e-mail and document templates, messages)", images)

    # ---------------------------------------------------------------- B7 positive
    def positive():
        out = []
        bad = []
        for name, base, hd in (("factory", F, fh), ("gateway", Gw, gh or {})):
            if not base:
                continue
            x = h.get(base + "/", headers=hd, timeout=20, follow=True)
            m = re.search(r"<title>(.*?)</title>", x.text, re.S | re.I)
            t = m.group(1).strip() if m else ""
            out.append(f"{name} title '{t}'")
            if "Cruise Saudi" not in t:
                bad.append(name)
        if not out:
            return WAITING, "no app reachable"
        return (FAIL if bad else PASS), "; ".join(out)
    r.check("B7", G, "Page titles say Cruise Saudi Weave", positive)

    r.add("B8", G, "E-mails (sign-in, notifications, reports) show only Cruise Saudi names and addresses", MANUAL,
          "trigger one e-mail of each kind to a test mailbox; read sender name, subject, body, footer, links (checklist 2.6)")


def _crawl(cfg: Config, ses) -> Dict:
    mod = cfg.secret("ACC_PLAYWRIGHT_MODULE", "")
    if not mod:
        for c in ("/root/traceit-middleware/apps/weave-factory/node_modules/@playwright/test/index.mjs",
                  os.path.join(cfg.harness_dir, "node_modules/playwright/index.mjs")):
            if os.path.exists(c):
                mod = c
                break
    if not mod or not have("node"):
        return {"error": "Playwright not available on this host (set ACC_PLAYWRIGHT_MODULE); rendered-UI scan not run - B3/B4 still scan HTML and assets", "skip": True, "pages": [], "hits": []}
    apps = [{"name": "factory", "base": cfg.factory_url, "routes": FACTORY_ROUTES, "cookies": _cookies(ses, "factory")}]
    if cfg.gateway_url:
        apps.append({"name": "gateway", "base": cfg.gateway_url, "routes": GATEWAY_ROUTES, "cookies": _cookies(ses, "gateway")})
    conf = {"apps": apps, "insecure": cfg.insecure_tls, "resolve": {k: f"{v[0]}:{v[1]}" for k, v in cfg.resolve.items()},
            "maxPages": int(cfg.secret("ACC_MAX_PAGES", "120")), "out": os.path.join(cfg.out_dir, "crawl.json"),
            "shots": os.path.join(cfg.out_dir, "shots") if cfg.secret("ACC_SHOTS") else ""}
    os.makedirs(cfg.out_dir, exist_ok=True)
    cp = os.path.join(cfg.out_dir, "crawl-config.json")
    with open(cp, "w") as f:
        json.dump(conf, f)
    os.chmod(cp, 0o600)  # may hold session cookies
    prefix = shlex.split(cfg.secret("ACC_HEAVY_PREFIX", ""))
    env = dict(os.environ, ACC_PLAYWRIGHT_MODULE=mod)
    try:
        p = subprocess.run(prefix + ["node", os.path.join(cfg.harness_dir, "crawl.mjs"), cp], capture_output=True, timeout=3600, env=env)
    finally:
        try:
            os.remove(cp)
        except OSError:
            pass
    tail = (p.stdout + p.stderr).decode("utf-8", "replace").strip().splitlines()[-3:]
    print("        crawl: " + " / ".join(tail))
    if p.returncode != 0 or not os.path.exists(conf["out"]):
        return {"error": f"crawl failed (exit {p.returncode}): {short(' '.join(tail), 300)}", "pages": [], "hits": []}
    return json.load(open(conf["out"]))


def _cookies(ses, app: str):
    hd = ses.headers(app, "admin")
    if not hd or "Cookie" not in hd:
        return []
    out = []
    for part in hd["Cookie"].split("; "):
        if "=" in part:
            k, v = part.split("=", 1)
            out.append({"name": k, "value": v})
    return out
