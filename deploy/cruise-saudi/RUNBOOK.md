# Cruise Saudi Weave – operator runbook

All commands as root on the Weave server. Scripts live in the extracted bundle and, after the
first install, in `/opt/weave/installer/` (paths below assume `DATA_ROOT=/opt/weave`).

## 1. Before installing

**Network** – the server has a private IP only and no internet; the bundle carries everything.
Inbound ports, internal DNS and the outbound allow-list (Microsoft Entra sign-in, the deployment
cluster/registry/LB) are in [NETWORK.md](NETWORK.md).

**DNS** – two A records in the **internal** zone to the server's **private** IP (or to the internal
load balancer that forwards 443/80 to it); no public DNS needed:

```
weave.aroya.com.   A   <private server IP>
apim.aroya.com.    A   <private server IP>
```

**Certificate** – PEM files, readable by root:

* certificate file: the server certificate first, then the intermediate CA certificate(s)
  (`cat server.crt intermediate.crt > aroya.com.fullchain.pem`). Subject Alternative Names must
  contain both `weave.aroya.com` and `apim.aroya.com` (or `*.aroya.com`). A separate certificate for
  `apim.aroya.com` is possible (`APIM_TLS_CERT_FILE` / `APIM_TLS_KEY_FILE`).
* key file: unencrypted PEM (`-----BEGIN PRIVATE KEY-----` / `BEGIN RSA PRIVATE KEY` / `BEGIN EC PRIVATE KEY`).
  Remove a passphrase with `openssl pkey -in enc.key -out aroya.com.key`.
* Check: `openssl x509 -in aroya.com.fullchain.pem -noout -subject -ext subjectAltName -enddate`.

* internal CA: put the CA chain (intermediate(s) + root, PEM) into `TLS_CA_FILE`. The pre-flight
  verifies the certificate against it; when the certificate file holds only the server certificate,
  the chain is appended for serving; the CA is added to the host trust store
  (`update-ca-certificates` / `update-ca-trust`), to the Weave services (`NODE_EXTRA_CA_CERTS`,
  `/opt/weave/etc/extra-ca.pem`) and to the migration tool (`SSL_CERT_FILE`, ConfigMap
  `weave-ca-trust`), so internal HTTPS endpoints signed by it (registry, deployment cluster, IdP) are trusted.

The pre-flight refuses a certificate that does not cover both names, is expired, does not chain to
`TLS_CA_FILE`, or whose key does not match; it warns when fewer than 30 days remain.

**OS prerequisites** – checked, never downloaded: `curl openssl tar gzip sha256sum ss ip ssh-keygen sshd
systemctl iptables` (standard on Ubuntu 24.04 server / RHEL 9 server), recommended `git rsync crontab`,
on RHEL 9 with SELinux enforcing `container-selinux`. Missing ones: install from your internal
repository, or let the installer do it with `--use-os-repo`. Python 3.12: from the OS, else the
bundled standalone build (`/opt/weave/python`, linked as `/usr/local/bin/python3.12` and `python3`).

**Firewall** – inbound: 443 and 80 from users, `GATEWAY_HTTPS_NODEPORT` (30243) from the load balancer,
22 for administration. Block everything else from outside, in particular 30443 (API Manager
management, already published through `apim.aroya.com`), 30900 (migration tool), 30280, 6443 (k3s).
The migration tool connects to this server's own SSH port (22) from the pod network (10.42.0.0/16):
keep that allowed, with root key login (`PermitRootLogin prohibit-password` or `yes`).

## 2. Install

```bash
cp weave.conf.example weave.conf && vi weave.conf
./install.sh --config weave.conf --preflight
./install.sh --config weave.conf
```

Typical duration on 16 vCPU: 10–15 minutes (API Manager's first boot is 3–5 of them).
Options: `--skip-dns` (records not yet switched), `--allow-small` (smaller test server).

Re-running is safe at any time. To change a setting: edit `/opt/weave/etc/weave.conf`, then
`/opt/weave/installer/install.sh` (no `--config` needed; it reads that file). A changed API Manager
setting restarts API Manager (about 3 minutes of gateway downtime); Weave containers are recreated
(seconds).

## 3. First sign-in

1. Read the generated administrator password (never printed by the installer):
   `grep ^APIM_ADMIN_PASSWORD= /opt/weave/etc/secrets.env | cut -d= -f2`
2. Open `https://weave.aroya.com/` → **Sign in** → API Manager's login page → user `admin`
   (`APIM_ADMIN_USER`) and that password. The Factory (`/factory`) uses the same sign-in.
3. Create named users in `https://apim.aroya.com/carbon` (Users and Roles) or connect the corporate
   directory; give them the `admin` / `Internal/creator` / `Internal/publisher` roles as needed.
   Use named accounts for daily work and keep `admin` for emergencies.

Changing the admin password later: change it in API Manager (Carbon → Users → admin → Change
password), then put the same value into `APIM_ADMIN_PASSWORD` in `/opt/weave/etc/secrets.env` and
re-run `install.sh` (the Weave services register with it).

**Local code model** – a bundle built with `--with-model` carries the self-hosted code model
(`/opt/weave-model/*.gguf`, ~4.7 GB) and its llama.cpp image; install.sh starts container
`weave-change-model` on 127.0.0.1:8099 (4 CPU / 7 GB). No cloud AI is used.

**Offline code generation** – the Ballerina package cache from the bundle is unpacked into
`/root/.ballerina/repositories`; migrated services build with `bal build --offline`.

**SSO (OIDC)** – `AUTH_PROVIDER=oidc` and the `OIDC_*` values are written into the Weave env files
(`/opt/weave/etc/gateway.env`, `factory.env`), ready for the consoles' SSO support; until that is
enabled in the product, sign-in goes through API Manager, which itself can federate to the corporate
IdP (Carbon → Identity Providers).

## 4. Where things are

| What | Where |
|---|---|
| Settings / generated secrets | `/opt/weave/etc/weave.conf`, `/opt/weave/etc/secrets.env` (600) |
| Weave env files (generated) | `/opt/weave/etc/{gateway,factory,runtime}.env` |
| Certificates in use | `/opt/weave/etc/tls/`, API Manager's own CA: `/opt/weave/etc/apim-ca.pem` |
| PostgreSQL data | `/opt/weave/data/postgres` |
| API Manager volume (keystores!, index) | `/opt/weave/data/apim` |
| Weave data (sessions, flows, runtime key) | `/opt/weave/data/{gateway,factory,runtime}` |
| Migration tool data | `/opt/weave/data/migration-tool` |
| Code generator workspace | `/opt/weave/platform` (migrated services under `services/`) |
| Backups | `BACKUP_TARGET` (default `/opt/weave/backups`) |
| Install / backup log | `/var/log/weave-install.log`, `/var/log/weave-backup.log`, `/opt/weave/logs/backup.log` |
| API Manager logs | `/opt/weave/logs/apim/` (`wso2carbon.log`, `http_access*.log`, `apim_metrics.log`) |
| Reverse proxy logs | `/opt/weave/logs/caddy/`, `journalctl -u weave-caddy` |
| Weave logs | `docker logs weave-gateway` / `weave-factory` / `weave-runtime` |
| Kubernetes | `kubectl -n apim get pods`, `kubectl -n weave get pods` |

## 5. Upgrade

```bash
tar xzf weave-cruise-saudi-<new>.tar.gz
./weave-cruise-saudi-<new>/upgrade.sh
```

Backup first (automatic; `--no-backup` to skip), then flow runtime → gateway console → factory →
migration tool are replaced one at a time. If one does not become healthy, everything replaced so
far returns to the previous images and the script exits 1 (the reason is printed). Then the code
generator is refreshed (migrated services kept; previous code in `/opt/weave/platform/.previous`) and
`install.sh` from the new bundle re-applies the configuration and runs the smoke checks.
Going back on purpose: run `upgrade.sh` from the previous bundle.

## 6. Backup and restore

* Nightly (cron `/etc/cron.d/weave-backup`, `BACKUP_SCHEDULE`), or by hand: `/opt/weave/installer/backup.sh`.
* Online, nothing stops. Contents: PostgreSQL dumps (`apim_db`, `shared_db`, roles), the API Manager
  volume (keystores – tokens and encrypted values depend on them), Weave data (flows, runtime secret
  key), migration tool data, code generator workspace, configuration **including secrets**. Keep the
  backup target as protected as the server (the directories are mode 700). Copy them off the server
  (e.g. `BACKUP_TARGET` on an NFS share).
* Retention: `BACKUP_RETENTION_DAYS`.

Restore (same or new server):

```bash
# new server only: install first with the same weave.conf
./install.sh --config weave.conf
/opt/weave/installer/restore.sh /opt/weave/backups/weave-backup-<timestamp> --yes
```

Weave and API Manager are down for 5–10 minutes. The previous data is moved to
`/opt/weave/data.before-restore-<ts>` (delete it once satisfied). The restore ends by re-running
`install.sh`, so it finishes with the same smoke checks.

## 7. Troubleshooting

| Symptom | Check |
|---|---|
| install stops in a step | the message names the step and the reason; full detail at the end of `/var/log/weave-install.log`. Fix and re-run |
| "port 443 is in use" | `ss -ltnp 'sport = :443'`; stop the other web server (`systemctl disable --now nginx/httpd/caddy`) |
| browser certificate warning | the certificate file lacks the intermediate chain, or DNS points elsewhere |
| 502 on weave.aroya.com | `docker ps` – is `weave-gateway` / `weave-factory` running? `docker logs --tail 50 weave-gateway` |
| sign-in loops / "invalid callback" | `PUBLIC_BASE_URL` in `/opt/weave/etc/*.env` must match the browser URL; re-run install.sh after DNS/name changes |
| apim.aroya.com 502 | `kubectl -n apim get pods`; `kubectl -n apim logs deploy/wso2am --tail=100`; `/opt/weave/logs/apim/wso2carbon.log` |
| API Manager restarts during boot | slow disk/CPU: raise `APIM_STARTUP_MINUTES`, re-run install.sh |
| API Manager cannot reach the database | `kubectl -n apim get pods -l app=apim-postgres`; `kubectl -n apim logs job/apim-dbinit` |
| migrations do not start | `kubectl -n weave logs deploy/migration-tool`; SSH from the pod network to the host (firewall, `PermitRootLogin`) |
| flows published but not callable | runtime must listen on the pod network: `docker logs weave-runtime`, `BIND` in `runtime.env` lists `10.42.0.1` |
| disk full | `du -sh /opt/weave/*`; API Manager logs rotate (14 days); `docker system df`; old backups |

Service control: `systemctl restart weave-caddy`; `docker restart weave-gateway weave-factory weave-runtime`;
`kubectl -n apim rollout restart deploy/wso2am` (≈3 min gateway downtime).

## 8. Uninstall

`/opt/weave/installer/uninstall.sh --yes` removes the services and keeps all data;
`--purge` also deletes `/opt/weave` and the images; `--remove-k3s` also removes k3s.

## 9. Isolated test (our side; a host that already runs Weave)

`--isolated-test` installs a complete, separate copy next to a live system without touching it:

| | live / production profile | isolated test profile |
|---|---|---|
| data root | `/opt/weave` | `/opt/weave-cstest` |
| names | from weave.conf | `weave.aroya.test`, `apim.aroya.test` (self-signed CA in `/opt/weave-cstest/etc/tls/test-ca.crt`) |
| proxy | `weave-caddy` on :80/:443 | `cstest-caddy` on **127.0.0.1**:9080/9443, `admin off`, own Caddyfile |
| namespaces | `apim`, `weave`, `wso2` | `cs-apim`, `cs-weave` |
| PersistentVolumes | `weave-apim-*` | `cstest-apim-*` |
| containers / ports | `weave-*` on 8787/8788/8790 | `cstest-*` on 18787/18788/18790, 1 CPU / 1 GB each |
| NodePorts | 30443/30243/30280/30900 | 32443/32243/32280/32900 |
| API Manager | weave.conf sizes | 2 CPU / 6 Gi, 3g heap, 12 min startup budget; not started below 10 GB free memory (exit 3) |
| host software | installs Docker/k3s/helm/Ballerina if missing | verifies only, never installs or changes host software |

The test reuses the host's Docker, k3s, helm and Ballerina, uses its own Caddy binary copy, adds one
SSH key (comment `weave-migration-tool:cstest`) to `/root/.ssh/authorized_keys` and removes it on uninstall.

```bash
B=/root/gen-work/cs-installer/weave-cruise-saudi-<version>      # extracted bundle
cd /root/wt-cs/installer/deploy/cruise-saudi                     # or the bundle itself
free -g                                                          # need >= 10 GB available
while [ "$(cut -d. -f1 /proc/loadavg)" -ge 8 ]; do sleep 30; done
flock /root/accept/heavy-build.lock systemd-run --scope -q -p CPUQuota=200% nice -n 19 \
  ./install.sh --isolated-test --bundle "$B"
# browse (from the host): curl --cacert /opt/weave-cstest/etc/tls/test-ca.crt \
#   --resolve weave.aroya.test:9443:127.0.0.1 https://weave.aroya.test:9443/
./install.sh --isolated-test --bundle "$B"     # re-run: idempotent, nothing restarts
./backup.sh --isolated-test
./restore.sh --isolated-test /opt/weave-cstest/backups/weave-backup-<ts> --yes --bundle "$B"
./uninstall.sh --isolated-test --purge        # removes every cs-*/cstest-* resource and /opt/weave-cstest
```

Afterwards nothing named `cs-apim`, `cs-weave`, `cstest-*` remains:
`kubectl get ns | grep cs-; kubectl get pv | grep cstest; docker ps -a | grep cstest; systemctl status cstest-caddy; ls /opt/weave-cstest`.
