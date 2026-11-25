# Cruise Saudi Weave – installer

Everything Cruise Saudi Weave needs, installed on **one server** with one command. The operator edits
one file (`weave.conf`) and runs `install.sh`. Day-to-day operation (sign-in, upgrade, backup, restore,
troubleshooting) is in [RUNBOOK.md](RUNBOOK.md).

## What gets installed

| Part | How it runs | Where |
|---|---|---|
| Weave Gateway console (`/`) | Docker container `weave-gateway`, 127.0.0.1:8787 | `https://weave.aroya.com/` |
| Weave Factory (`/factory`) | Docker container `weave-factory`, 127.0.0.1:8788 | `https://weave.aroya.com/factory/` |
| Flow runtime | Docker container `weave-runtime`, 127.0.0.1:8790 + pod network | internal |
| WSO2 API Manager 4.5.0 all-in-one | k3s, namespace `apim`, Deployment `wso2am` | `https://apim.aroya.com/` (portals) |
| API gateway | same pod; host port **30243** (HTTPS) / 30280 (HTTP): 127.0.0.1 only, or the load balancer only (`LB_SOURCE_CIDRS`) | `https://weave.aroya.com/gw/...`; load balancer → `:30243` when `LB_SOURCE_CIDRS` is set |
| PostgreSQL 16 (API Manager data) | k3s, namespace `apim`, Deployment `apim-postgres` | internal |
| Migration tool (control plane) | k3s, namespace `weave`, 127.0.0.1:30900 (host port, loopback only) | used by the Factory |
| Code generator + toolchain | on the host: Python 3.12, Docker, Ballerina 2201.13.4 (JRE 21), helm, kubectl | `/opt/weave/platform` |
| Reverse proxy | Caddy (own binary), systemd unit `weave-caddy`, ports 80/443, **provided certificate** | |

Migrated APIs are deployed to a **different** cluster later (`DEPLOY_TARGET_*` in `weave.conf`).

## Requirements

* Ubuntu 24.04 LTS or RHEL 9 (x86_64), root, systemd. 16 vCPU / 64 GB RAM / 1 TB disk.
* Private IP only, **no internet**: the installer is fully offline (see [NETWORK.md](NETWORK.md) for
  DNS, inbound ports and the outbound allow-list). It never downloads and never calls apt/dnf
  (`--use-os-repo` allows the server's internal repository).
* OS prerequisites (present on a standard server install): `curl openssl tar gzip sha256sum ss ip
  ssh-keygen sshd systemctl iptables`; recommended `git rsync crontab`; RHEL 9 with SELinux enforcing
  also needs `container-selinux`. Python 3.12 comes from the OS or, if missing, from the bundle.
* Ports 80 and 443 free; inbound 443 (and 80 for the redirect) from users; 30243 from the load balancer
  only if it calls the gateway port directly (`LB_SOURCE_CIDRS`, see NETWORK.md).
* DNS: **internal A records** `weave.aroya.com` and `apim.aroya.com` → the server's private IP.
* A TLS certificate covering both names (SAN or `*.aroya.com`): PEM certificate file and an
  **unencrypted** PEM private key; for an internal CA also the CA chain file (`TLS_CA_FILE`).

## Install

```bash
tar xzf weave-cruise-saudi-<version>.tar.gz
cd weave-cruise-saudi-<version>
cp weave.conf.example weave.conf
vi weave.conf                       # names, certificate paths, e-mail, sizes, backup target
sudo ./install.sh --config weave.conf --preflight   # checks only, changes nothing
sudo ./install.sh --config weave.conf
```

The installer prints one line per step and ends with the URLs and how to read the first password;
the full log is `/var/log/weave-install.log`. It is **idempotent**: run it again after editing
`/opt/weave/etc/weave.conf` to apply a change; nothing is reset and no secret is regenerated.
Exit code 0 = installed and all smoke checks passed; non-zero = the step and the reason are printed.

Steps: pre-flight (OS, size, ports, DNS, certificate vs. names and key, bundle) → directories and
generated secrets → OS packages → Docker → k3s → helm/kubectl/Ballerina/Caddy → images → code generator
workspace → namespaces/secrets/access → PostgreSQL + schema → API Manager (own key pair, generated
admin password, admin/admin refused) → migration tool → Weave containers → Caddy → scripts + backup
schedule → smoke checks (every URL, API Manager health, gateway, sign-in redirect to the login page).

## Files

| File | Purpose |
|---|---|
| `weave.conf.example` | the only file an operator edits |
| `install.sh` | install / re-apply; `--preflight`, `--skip-dns`, `--allow-small`, `--isolated-test` |
| `upgrade.sh` | new bundle → backup → rolling replace with automatic rollback |
| `rollback.sh` | go back on purpose to the version installed before the last upgrade (RUNBOOK §5) |
| `backup.sh` / `restore.sh` | online backup (DB dumps, volumes, data, config) with retention / full restore |
| `uninstall.sh` | remove the services, keep data (`--purge` deletes data, `--remove-k3s`) |
| `build-bundle.sh` | **our side**: builds the Cruise Saudi images and the offline bundle (`--with-model` adds the local code model) |
| `NETWORK.md` | private-IP deployment: internal DNS, inbound ports, outbound allow-list |
| `lib/`, `manifests/`, `templates/` | shared shell code (incl. Ballerina dependency check + offline build proof), Kubernetes manifests, API Manager/Caddy templates |

## Building the bundle (our side)

```bash
cd traceit-middleware            # branch with the Cruise Saudi edition
/root/accept/heavy.sh bash deploy/cruise-saudi/build-bundle.sh --version 1.0.0 --out /root/gen-work/cs-installer \
  --src <checkout with cruise-saudi + users and access>
```

It builds `weave-gateway`, `weave-factory` (both `VITE_WEAVE_EDITION=cruise-saudi`, relative links
between the two consoles), `weave-runtime` and the migration tool, saves them with the API Manager,
PostgreSQL and base images of migrated APIs (`eclipse-temurin:21-jre-alpine`, `node:22-bookworm-slim`),
and adds k3s (+ airgap images), helm, kubectl, Caddy, static Docker, Ballerina (.deb + .rpm),
k3s-selinux, standalone Python 3.12, the PostgreSQL JDBC driver, the code generator seed (no customer
sources) and the Ballerina package cache. It **fails** unless every package version in the services'
and framework's `Dependencies.toml` is in the distribution or the cache (`platform/BALLERINA-DEPENDENCIES.txt`),
and unless a generated service builds with `bal build --offline` in a `--network none` container from
the bundled .deb + cache only (`platform/OFFLINE-BUILD-PROOF.txt`).
Output: `weave-cruise-saudi-<version>.tar.gz` + `.sha256`.

## Testing on a shared host (`--isolated-test`)

See RUNBOOK.md, section "Isolated test". In short:

```bash
/root/accept/heavy.sh ./install.sh --isolated-test --bundle <extracted bundle>
./backup.sh --isolated-test
./uninstall.sh --isolated-test --purge
```
