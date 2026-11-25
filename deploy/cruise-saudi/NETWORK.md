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
| 30243/tcp (`GATEWAY_HTTPS_NODEPORT`) | internal load balancer | API gateway (HTTPS) for API consumers. The LB must set/append `X-Forwarded-For` (per-API IP allow/deny rules read it) |
| 30280/tcp (`GATEWAY_HTTP_NODEPORT`) | internal load balancer (only if plain HTTP is wanted) | API gateway (HTTP) |
| 22/tcp | administrators | SSH |

Everything else stays closed from outside (30443 API Manager management, 30900 migration tool, 6443
k3s API, 8787-8790 Weave internals – they are reached through 443 or only locally). The migration
tool connects from the pod network (10.42.0.0/16) to this server's own port 22: allow that on any
host firewall.

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
