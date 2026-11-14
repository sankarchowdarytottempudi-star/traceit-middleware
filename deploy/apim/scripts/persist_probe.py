#!/usr/bin/env python3
"""Proof that green's writes survive a pod restart (i.e. the volume is really used).

  persist_probe.py before [base]   ask green for a refresh token (stored only in green's database,
                                   issued after the seed) and keep it in /root/apim-bluegreen (0600)
  persist_probe.py after  [base]   redeem it. Works only if the database survived the restart.
No API objects are created: the DCR client `infra-bluegreen` already exists in the seed.
"""
from __future__ import annotations
import os, sys, urllib.parse
from apimlib import DCR_CLIENT, admin_credentials, basic, http

ROOT = os.environ.get("APIM_BG_ROOT", "/root/apim-bluegreen")
FILE = os.path.join(ROOT, ".persist-probe")


def client(base, user, password):
    st, dcr = http("POST", f"{base}/client-registration/v0.17/register",
                   {"Authorization": basic(user, password), "Content-Type": "application/json"},
                   {"clientName": DCR_CLIENT, "owner": user, "grantType": "password refresh_token",
                    "saasApp": True, "callbackUrl": "https://localhost"})
    if st != 200:
        raise SystemExit(f"DCR failed: HTTP {st}")
    return basic(dcr["clientId"], dcr["clientSecret"])


def main():
    mode = sys.argv[1]
    base = sys.argv[2] if len(sys.argv) > 2 else "https://127.0.0.1:31443"
    user, password = admin_credentials()
    auth = client(base, user, password)
    hdr = {"Authorization": auth, "Content-Type": "application/x-www-form-urlencoded"}
    if mode == "before":
        st, tok = http("POST", f"{base}/oauth2/token", hdr, urllib.parse.urlencode(
            {"grant_type": "password", "username": user, "password": password, "scope": "apim:api_view"}))
        if st != 200 or "refresh_token" not in tok:
            raise SystemExit(f"could not get a refresh token: HTTP {st}")
        with open(os.open(FILE, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w") as f:
            f.write(tok["refresh_token"])
        print("refresh token issued by green and parked (not printed)")
        return 0
    rt = open(FILE).read().strip()
    os.remove(FILE)
    st, tok = http("POST", f"{base}/oauth2/token", hdr,
                   urllib.parse.urlencode({"grant_type": "refresh_token", "refresh_token": rt}))
    ok = st == 200 and isinstance(tok, dict) and "access_token" in tok
    print(f"[{'PASS' if ok else 'FAIL'}] refresh token issued before the restart is honoured after it (HTTP {st})")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
