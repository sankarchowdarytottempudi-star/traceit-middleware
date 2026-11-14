#!/usr/bin/env python3
"""Record or compare the "ground truth" of an APIM instance through its REST APIs.

  truth.py collect <base-url> <out.json>      e.g. https://127.0.0.1:30443 (blue), :31443 (green)
  truth.py diff <a.json> <b.json> [--ignore-test]
        exit 0 = identical; 1 = differences (printed). --ignore-test drops APIs whose name or
        context starts with weave / sample / e2e (test APIs published overnight by the other
        streams; the Weave runtime re-creates those itself) and their subscriptions.

The output contains identifiers and consumer KEYS but never consumer secrets or tokens.
"""
from __future__ import annotations
import json, re, sys
from apimlib import Apim, admin_credentials

PUB, DEV, ADM = "/api/am/publisher/v4", "/api/am/devportal/v3", "/api/am/admin/v4"


def collect(base):
    user, password = admin_credentials()
    a = Apim(base, user, password)
    out = {"apis": [], "apiProducts": [], "applications": [], "subscriptions": [],
           "policies": {}, "keyManagers": [], "environments": []}

    for item in a.get_list(f"{PUB}/apis"):
        d = a.get(f"{PUB}/apis/{item['id']}")
        revs = a.get(f"{PUB}/apis/{item['id']}/revisions?query=deployed:true")
        deployed = [{"id": r.get("id"), "displayName": r.get("displayName"),
                     "deployments": sorted(
                         [{"name": x.get("name"), "vhost": x.get("vhost"),
                           "displayOnDevportal": x.get("displayOnDevportal"),
                           "status": x.get("status")} for x in r.get("deploymentInfo", [])],
                         key=lambda x: str(x["name"]))}
                    for r in (revs.get("list", []) if isinstance(revs, dict) else [])]
        ep = d.get("endpointConfig") or {}
        out["apis"].append({
            "id": d["id"], "name": d["name"], "context": d["context"], "version": d["version"],
            "provider": d.get("provider"), "type": d.get("type"),
            "lifeCycleStatus": d.get("lifeCycleStatus"),
            "securityScheme": sorted(d.get("securityScheme") or []),
            "apiThrottlingPolicy": d.get("apiThrottlingPolicy"),
            "policies": sorted(d.get("policies") or []),
            "transport": sorted(d.get("transport") or []),
            "responseCachingEnabled": d.get("responseCachingEnabled"),
            "cacheTimeout": d.get("cacheTimeout"),
            "productionEndpoint": (ep.get("production_endpoints") or {}).get("url")
            if isinstance(ep.get("production_endpoints"), dict) else None,
            "operations": sorted(
                [{"verb": o.get("verb"), "target": o.get("target"), "authType": o.get("authType"),
                  "throttlingPolicy": o.get("throttlingPolicy")} for o in d.get("operations", [])],
                key=lambda o: (str(o["target"]), str(o["verb"]))),
            "deployedRevisions": sorted(deployed, key=lambda r: str(r["id"])),
        })

    try:
        for p in a.get_list(f"{PUB}/api-products"):
            out["apiProducts"].append({k: p.get(k) for k in ("id", "name", "context", "state")})
    except RuntimeError:
        pass

    admin_apps = {x["applicationId"]: x for x in a.get_list(f"{ADM}/applications")}
    mine = {x["applicationId"]: x for x in a.get_list(f"{DEV}/applications")}
    for app_id, x in admin_apps.items():
        rec = {"applicationId": app_id, "name": x.get("name"), "owner": x.get("owner"),
               "status": x.get("status"), "keys": None}
        if app_id in mine:
            rec["throttlingPolicy"] = mine[app_id].get("throttlingPolicy")
            rec["keys"] = sorted(
                [{"keyType": k.get("keyType"), "keyManager": k.get("keyManager"),
                  "consumerKey": k.get("consumerKey"), "keyState": k.get("keyState"),
                  "mode": k.get("mode"),
                  "supportedGrantTypes": sorted(k.get("supportedGrantTypes") or [])}
                 for k in a.app_keys(app_id)], key=lambda k: (str(k["keyManager"]), str(k["keyType"])))
            for s in a.get_list(f"{DEV}/subscriptions?applicationId={app_id}"):
                out["subscriptions"].append({
                    "subscriptionId": s.get("subscriptionId"), "applicationId": app_id,
                    "apiId": s.get("apiId"), "apiName": (s.get("apiInfo") or {}).get("name"),
                    "apiContext": (s.get("apiInfo") or {}).get("context"),
                    "throttlingPolicy": s.get("throttlingPolicy"), "status": s.get("status")})
        out["applications"].append(rec)

    for kind in ("advanced", "application", "subscription", "custom"):
        try:
            lst = a.get(f"{ADM}/throttling/policies/{kind}")
        except RuntimeError as e:
            out["policies"][kind] = f"unavailable: {e}"
            continue
        items = []
        for p in lst.get("list", []):
            lim = p.get("defaultLimit") or {}
            rc = lim.get("requestCount") or {}
            items.append({"policyId": p.get("policyId"), "policyName": p.get("policyName"),
                          "isDeployed": p.get("isDeployed"), "type": lim.get("type"),
                          "requestCount": rc.get("requestCount"), "timeUnit": rc.get("timeUnit"),
                          "unitTime": rc.get("unitTime")})
        out["policies"][kind] = sorted(items, key=lambda p: str(p["policyName"]))
    try:
        dl = a.get(f"{ADM}/throttling/deny-policies")
        out["policies"]["deny"] = sorted(
            [{"conditionId": x.get("conditionId"), "conditionType": x.get("conditionType"),
              "conditionStatus": x.get("conditionStatus")} for x in dl.get("list", [])],
            key=lambda x: str(x["conditionId"]))
    except RuntimeError as e:
        out["policies"]["deny"] = f"unavailable: {e}"

    for k in a.get(f"{ADM}/key-managers").get("list", []):
        out["keyManagers"].append({kk: k.get(kk) for kk in ("id", "name", "type", "enabled")})
    for e in a.get(f"{ADM}/environments").get("list", []):
        out["environments"].append({kk: e.get(kk) for kk in ("id", "name", "gatewayType", "provider")})

    for key in ("apis", "apiProducts", "applications", "keyManagers", "environments"):
        out[key].sort(key=lambda x: (str(x.get("name")), str(x.get("id") or x.get("applicationId"))))
    out["subscriptions"].sort(key=lambda s: str(s["subscriptionId"]))
    return out


TEST = re.compile(r"^/?(weave|sample|e2e)", re.I)


def is_test_api(api):
    return bool(TEST.match(api.get("name") or "") or TEST.match(api.get("context") or ""))


def strip_test(t):
    drop = {a["id"] for a in t["apis"] if is_test_api(a)}
    t = dict(t)
    t["apis"] = [a for a in t["apis"] if a["id"] not in drop]
    t["subscriptions"] = [s for s in t["subscriptions"]
                          if s["apiId"] not in drop and not TEST.match(s.get("apiName") or "")
                          and not TEST.match(s.get("apiContext") or "")]
    return t, len(drop)


def flat(prefix, v, out):
    if isinstance(v, dict):
        for k in sorted(v):
            flat(f"{prefix}.{k}", v[k], out)
    elif isinstance(v, list):
        for i, x in enumerate(v):
            ident = None
            if isinstance(x, dict):
                ident = (x.get("name") or x.get("policyName") or x.get("subscriptionId")
                         or x.get("id") or x.get("target"))
                if "verb" in x and "target" in x:
                    ident = f"{x['verb']} {x['target']}"
                if "keyType" in x:
                    ident = f"{x.get('keyManager')}/{x['keyType']}"
            flat(f"{prefix}[{ident if ident is not None else i}]", x, out)
    else:
        out[prefix] = v


def diff(a, b, ignore_test):
    dropped = (0, 0)
    if ignore_test:
        a, na = strip_test(a)
        b, nb = strip_test(b)
        dropped = (na, nb)
    fa, fb = {}, {}
    flat("", a, fa)
    flat("", b, fb)
    lines = []
    for k in sorted(set(fa) | set(fb)):
        if fa.get(k, "<absent>") != fb.get(k, "<absent>"):
            lines.append(f"  {k}: {fa.get(k, '<absent>')!r} != {fb.get(k, '<absent>')!r}")
    return lines, dropped


def summary(t):
    return (f"{len(t['apis'])} APIs, {len(t['applications'])} applications, "
            f"{len(t['subscriptions'])} subscriptions, "
            f"{sum(len(x['keys'] or []) for x in t['applications'])} key mappings, "
            + ", ".join(f"{len(v) if isinstance(v, list) else '?'} {k} policies"
                        for k, v in t["policies"].items())
            + f", {len(t['keyManagers'])} key managers")


def main():
    if len(sys.argv) >= 4 and sys.argv[1] == "collect":
        t = collect(sys.argv[2])
        with open(sys.argv[3], "w") as f:
            json.dump(t, f, indent=1, sort_keys=True)
        print(summary(t))
        for api in t["apis"]:
            dep = ",".join(f"{r['displayName']}@" + "+".join(str(d["name"]) for d in r["deployments"])
                           for r in api["deployedRevisions"]) or "NOT DEPLOYED"
            print(f"  {api['name']:<34} {api['context']:<32} {api['version']:<5} "
                  f"{api['lifeCycleStatus']:<10} {dep}")
        return 0
    if len(sys.argv) >= 4 and sys.argv[1] == "diff":
        a, b = json.load(open(sys.argv[2])), json.load(open(sys.argv[3]))
        lines, dropped = diff(a, b, "--ignore-test" in sys.argv)
        if dropped != (0, 0):
            print(f"ignored test APIs: {dropped[0]} in A, {dropped[1]} in B")
        if lines:
            print(f"DIFFERENT ({len(lines)} fields):")
            print("\n".join(lines[:200]))
            return 1
        print("IDENTICAL")
        return 0
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main())
