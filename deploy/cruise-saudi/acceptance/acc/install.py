"""Install & health: both consoles answer, API Manager answers, the install's pods and containers run."""
from __future__ import annotations

import json

from .core import Config, Http, Run, PASS, FAIL, WAITING, SKIP, sh, have, short

G = "install"


def run(cfg: Config, h: Http, r: Run):
    def health(url):
        def f():
            x = h.get(url.rstrip("/") + "/healthz", timeout=15)
            if x.status == 200:
                return PASS, f"GET {url}/healthz -> 200 {short(x.text, 120)}"
            return FAIL, f"GET {url}/healthz -> {x.status} {x.error or short(x.text, 120)}"
        return f

    r.check("I1", G, "Weave Factory answers /healthz", health(cfg.factory_url))
    if cfg.gateway_url:
        r.check("I2", G, "Weave Gateway console answers /healthz", health(cfg.gateway_url))
    else:
        r.add("I2", G, "Weave Gateway console answers /healthz", WAITING, "no gateway console address for this target")

    def apim():
        if not cfg.apim_url:
            return WAITING, "no API Manager address (pass --apim-url or use --isolated-test)"
        x = h.get(cfg.apim_url.rstrip("/") + "/services/Version", timeout=15)
        y = h.get(cfg.apim_url.rstrip("/") + "/api/am/publisher/v4/apis?limit=1", timeout=15)
        if y.status in (401, 200):
            return PASS, f"publisher REST answers ({y.status} unauthenticated is expected 401); /services/Version -> {x.status}"
        return FAIL, f"publisher REST -> {y.status} {y.error}"
    r.check("I3", G, "API Manager REST answers", apim)

    def gw():
        if not cfg.apim_gw_url:
            return WAITING, "no API gateway address"
        x = h.get(cfg.apim_gw_url.rstrip("/") + "/cs-acc-does-not-exist/1.0.0/", timeout=15)
        if x.status in (404, 401, 403):
            return PASS, f"gateway answers for an unknown API -> {x.status}"
        return FAIL, f"gateway -> {x.status} {x.error}"
    r.check("I4", G, "API gateway answers", gw)

    def pods():
        if not cfg.namespaces:
            return SKIP, "no install namespaces given (--namespaces)"
        if not have("kubectl"):
            return SKIP, "kubectl not available on this host"
        bad, total = [], 0
        for ns in cfg.namespaces:
            rc, out = sh(["kubectl", "get", "pods", "-n", ns, "-o", "json"], 60)
            if rc != 0:
                return FAIL, f"kubectl get pods -n {ns}: {short(out, 160)}"
            for p in json.loads(out).get("items", []):
                if p.get("status", {}).get("phase") == "Succeeded":
                    continue
                total += 1
                cs = p.get("status", {}).get("containerStatuses", []) or []
                if not cs or not all(c.get("ready") for c in cs):
                    bad.append(f"{ns}/{p['metadata']['name']}")
        if total == 0:
            return FAIL, f"no pods in {','.join(cfg.namespaces)}"
        if bad:
            return FAIL, f"{len(bad)}/{total} pods not ready: {', '.join(bad[:8])}"
        return PASS, f"{total} pods ready in {','.join(cfg.namespaces)}"
    r.check("I5", G, "All pods of the install are ready", pods)

    def containers():
        if not cfg.container_prefix:
            return SKIP, "no container prefix given (--containers)"
        if not have("docker"):
            return SKIP, "docker not available"
        rc, out = sh(["docker", "ps", "-a", "--filter", f"name=^{cfg.container_prefix}", "--format", "{{.Names}}\t{{.Status}}"], 30)
        lines = [l for l in out.splitlines() if l.strip()]
        if not lines:
            return FAIL, f"no container named {cfg.container_prefix}*"
        down = [l for l in lines if "\tUp" not in l]
        unhealthy = [l for l in lines if "unhealthy" in l]
        if down or unhealthy:
            return FAIL, "; ".join((down + unhealthy)[:6])
        return PASS, "; ".join(l.replace("\t", " ") for l in lines[:8])
    r.check("I6", G, "Install containers run (and are healthy)", containers)

    def version():
        x = h.get(cfg.factory_url.rstrip("/") + "/healthz", timeout=15)
        j = x.json() or {}
        v = j.get("version") or j.get("build") or x.header("x-weave-version")
        if v:
            return PASS, f"Factory reports version {short(str(v), 60)}"
        return WAITING, "the Factory does not report a version on /healthz yet (needed to prove an upgrade)"
    r.check("I7", G, "Installed version is visible", version)
