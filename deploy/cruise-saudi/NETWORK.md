# Cruise Saudi Weave – network, DNS and outbound allow-list

The Weave server has **only a private IP** inside Cruise Saudi's firewall boundary, **no public IP and
no internet access**. Installation, upgrades and code generation work fully offline from the bundle
(`weave-cruise-saudi-<version>.tar.gz`): container images, k3s and its airgap images, helm, kubectl,
Caddy, Docker (static), Ballerina with its JRE, the Ballerina package cache for every library the
generated services import (`bal build --offline`), the base images migrated APIs are built on
(`eclipse-temurin:21-jre-alpine`, `node:22-bookworm-slim`), a standalone Python 3.12 and, optionally,
the local code model. The migration tool and the code generator use the Python standard library only.
Nothing is downloaded at install or run time; `install.sh` never calls apt/dnf unless `--use-os-repo`
is given (and then only against the server's configured internal repository).

## DNS (internal)

Two records in Cruise Saudi's **internal** DNS zone, both to the server's **private** IP (or to an
internal load balancer / reverse proxy in front of it):

```
weave.aroya.com.   A   <private IP of the Weave server>
apim.aroya.com.    A   <private IP of the Weave server>
```

They do not need to exist in public DNS. Users' workstations and the internal load balancer must
resolve them through the internal resolvers. The server itself should resolve them too (pre-flight
checks it; `--skip-dns` when the records are added at cut-over). TLS certificates for these names come
from Cruise Saudi (an internal CA is fine: set `TLS_CA_FILE` in `weave.conf`; the CA is then trusted
by the server, the Weave services and the migration tool).

## Inbound (to the Weave server)

| Port | From | Purpose |
|---|---|---|
| 443/tcp | users' network | Weave consoles (`weave.aroya.com`), API Manager portals (`apim.aroya.com`) |
| 80/tcp | users' network (optional) | redirect to HTTPS only |
| 30243/tcp (`GATEWAY_HTTPS_NODEPORT`) | internal load balancer, **only** the addresses in `LB_SOURCE_CIDRS` | API gateway (HTTPS) for API consumers, only when `LB_SOURCE_CIDRS` is set. The LB must set/append `X-Forwarded-For` (per-API IP allow/deny rules read it) |
| 30280/tcp (`GATEWAY_HTTP_NODEPORT`) | as above, only with `GATEWAY_HTTP_EXPOSE=yes` | API gateway (plain HTTP) |
| 22/tcp | administrators | SSH |

### What the installer exposes (default: nothing beyond 80/443)

* **No NodePort or LoadBalancer services.** Every Kubernetes Service in the `apim` and `weave`
  namespaces is `ClusterIP`.
* API Manager management (`APIM_MGMT_NODEPORT`, 30443) and the migration tool (`MT_NODEPORT`, 30900)
  are pod **host ports bound to 127.0.0.1**: the reverse proxy, the Weave containers and the installer
  reach them on the server itself; from any other address they do not answer. The API Manager portals
  are published only through `https://apim.aroya.com` (443).
* The API gateway is reached by API consumers through `https://weave.aroya.com/gw/<context>/<version>/...`
  (443, `ENABLE_GW_PATH=yes`). With `LB_SOURCE_CIDRS` empty (default) its ports 30243/30280 are bound
  to 127.0.0.1 as well.
* If the existing load balancer must call the gateway port directly, list its address(es) in
  `weave.conf`: `LB_SOURCE_CIDRS=10.20.30.40,10.20.30.41` (IPv4 addresses or CIDRs, comma separated).
  The gateway HTTPS port then listens on every address, and the installer installs the iptables chain
  `WEAVE_GW` in the `raw` table (systemd unit `weave-firewall`, re-applied at boot; script
  `/opt/weave/bin/weave-firewall.sh`): a connection to 30243 is dropped unless it comes from
  loopback, the pod network (10.42.0.0/16) or `LB_SOURCE_CIDRS`. The rule sits in `raw/PREROUTING`
  because the host port is translated (DNAT) to the pod before the normal INPUT chain is consulted.
  Plain HTTP 30280 is added only with `GATEWAY_HTTP_EXPOSE=yes`. Emptying `LB_SOURCE_CIDRS` and re-running
  `install.sh` removes the chain and binds the gateway to 127.0.0.1 again. Check:
  `sudo /opt/weave/bin/weave-firewall.sh show WEAVE_GW`.
* Never exposed: 6443 (k3s API), 8787-8790 (Weave internals, 127.0.0.1 only), 8099 (local model).

The migration tool connects from the pod network (10.42.0.0/16) to this server's own port 22: allow
that on any host firewall. API Manager may also call its own public name from the pod (10.42.0.0/16 ->
this server's 443); its key manager uses `https://localhost:9443` inside the pod, so token validation
does not depend on the pod resolving `apim.aroya.com`.

### Security headers (reverse proxy)

Both sites send `Strict-Transport-Security: max-age=31536000; includeSubDomains`,
`X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin` and a restrictive
`Permissions-Policy`; the `Server` header is removed. `weave.aroya.com` (consoles) adds
`X-Frame-Options: DENY` and a `Content-Security-Policy` (`default-src 'self'`, scripts from the site
plus the consoles' own inline scripts by SHA-256 hash, `frame-ancestors 'none'`, `object-src 'none'`).
`apim.aroya.com` adds `frame-ancestors 'self'` (the WSO2 portals frame their own session-check page)
and keeps API Manager's own `X-Frame-Options`; its portals rely on inline scripts, so script sources
are not restricted there. HSTS makes browsers refuse plain HTTP to both names for a year: the names
must keep a valid certificate.

## Outbound allow-list (from the Weave server)

Default: **nothing to the internet.** Only the following, and only when the feature is used:

| Destination | Port | Needed for | When |
|---|---|---|---|
| `login.microsoftonline.com` | 443 | Microsoft Entra ID sign-in (OIDC discovery, token endpoint, signing keys) | only with `AUTH_PROVIDER=oidc` against Entra |
| `graph.microsoft.com` | 443 | reading the signed-in user's group membership (role mapping) | only if groups are read from Microsoft Graph (instead of the `groups` claim in the token) |
| deployment cluster API server (e.g. `https://<cluster>:6443`) – inside Cruise Saudi's network | 443/6443 | deploying migrated APIs (`DEPLOY_TARGET_KUBECONFIG`) | when migrated APIs are deployed |
| container registry (`DEPLOY_TARGET_REGISTRY`) – inside Cruise Saudi's network | 443 | pushing the images of migrated APIs | when migrated APIs are deployed |
| load balancer / gateway hosts of the deployment cluster – inside Cruise Saudi's network | 443 | smoke tests of deployed APIs, API Manager → backend calls | when migrated APIs are deployed |
| backend systems the migrated APIs call (Seaware, Zoho, databases …) | as configured | **only from the deployment cluster**, not from this server | – |
| `BACKUP_TARGET` share (NFS 2049 / SMB 445) – internal | 2049/445 | off-server backups | if the backup target is a network share |
| internal NTP / DNS servers | 123/udp, 53 | time and name resolution | always |

If outbound HTTPS to Entra must pass a corporate proxy, set `HTTPS_PROXY` / `NO_PROXY` in
`weave.conf`; they are written into the Weave services' environment, never used by the installer.

Not needed (and should stay blocked): Docker Hub, GitHub, get.k3s.io, dist.ballerina.io,
central.ballerina.io, npm, PyPI, OS package mirrors on the internet, any cloud AI endpoint (the
optional code model runs locally on 127.0.0.1:8099).

Known limit: migrated APIs generated for the **Node.js** target run `npm ci` in their image build and
therefore need an internal npm mirror (or must be built on our side); the default Ballerina target
builds fully offline.
