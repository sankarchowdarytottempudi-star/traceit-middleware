# Cruise Saudi Weave: go-live acceptance

This checklist is for the Cruise Saudi team and our delivery team. It lists what has to be true
before Cruise Saudi Weave goes live on the Cruise Saudi server, and how each item is proven.

- **Auto** items are run by the harness (`deploy/cruise-saudi/acceptance/run-acceptance.sh`). The
  harness prints PASS / FAIL / WAITING / SKIP / MANUAL for each item, with evidence, and writes
  `report.json` and `report.html`. The item IDs below match the IDs in the report.
- **Manual** items need a person: a real Entra account, a real mailbox, or a step that removes data.
  They have a short procedure here.
- Go-live needs every item PASS or signed off. A WAITING item is not a pass.

Statuses in the report:

| Status | Meaning |
|---|---|
| PASS | Checked and correct. The evidence column shows what was seen. |
| FAIL | Checked and wrong. Must be fixed, or the owner accepts it in writing. |
| WAITING | Could not be checked yet: the feature, address or credential is missing. Not a pass. |
| SKIP | Does not apply to this run, for example a read-only run or a test instance without sign-in. |
| MANUAL | Needs a person. Follow the procedure below and sign it off. |

## How to run the harness

On the Cruise Saudi server, or on any host that reaches it, as root:

```bash
cd deploy/cruise-saudi/acceptance
./run-acceptance.sh https://weave.<cruise-saudi-domain> \
    --apim-url https://apim.<cruise-saudi-domain> \
    --namespaces <apim-namespace>,<weave-namespace> --containers <container-prefix> \
    --install-dir /opt/cruise-saudi-weave --secrets /root/acceptance.env \
    --secrets-glob '/etc/cruise-saudi-weave/*.env' --out /root/acceptance-$(date +%F)
```

On the isolated test install on our test host (the installer's `--isolated-test` mode):

```bash
./run-acceptance.sh --isolated-test --secrets /root/acceptance.env
```

This targets `https://weave.aroya.test` and `https://apim.aroya.test` through the test proxy at
`127.0.0.1:9443`, the namespaces `cs-apim` and `cs-weave`, and the containers `cstest-*`. API Manager
admin credentials are read from the `deployment.toml` in namespace `cs-apim` unless given.

Against a shared or production instance where nothing may be created, add `--read-only`. Against the
Factory test instance that runs without sign-in (`DEV_AUTH_USER`), add `--dev-auth`.

Options: `--factory-url`, `--gateway-url` (`none` to leave it out), `--apim-gateway-url` (where
published APIs are called, if it is not the API Manager address), `--only install,branding,...`,
`--insecure`. Run `./run-acceptance.sh --help` for the full list.

The exit code is the number of FAIL items.

### The secrets file

An env file, `chmod 600`, never committed. The harness never prints a value from it.

```bash
ACC_ADMIN_USER=...            # local (break-glass) account e-mail with all three roles: admin, migration, gateway
ACC_ADMIN_PASSWORD=...
ACC_MIGRATION_USER=...        # an account with the Migration role only
ACC_MIGRATION_PASSWORD=...
ACC_GATEWAY_USER=...          # an account with the Gateway role only
ACC_GATEWAY_PASSWORD=...
ACC_APIM_USER=...             # API Manager admin, for the throw-away gateway objects (optional on
ACC_APIM_PASSWORD=...         #   the isolated install: read from namespace cs-apim)
# optional
ACC_TARGET_KUBECONFIG=/root/.kube/target   # read-only view of the remote target cluster (M7)
ACC_LOGIN_PATH=/api/auth/local             # local sign-in route of the consoles
ACC_USERS_PATH=/api/access/users           # user management route
ACC_AUDIT_PATH=/api/access/audit           # audit route
ACC_BACKEND_BIND=10.42.0.1                 # where the stand-in backend listens (must be reachable from the pods)
```

### What the harness creates, and removes

- A migration named `cs-acc-<stamp>-orders` from our own synthetic Mule 4 project
  (`acceptance/sample-mule/cs-acc-orders`). It contains no customer source. It has one HTTP listener,
  one flow, a DataWeave transform and an HTTP request to a stand-in backend that the harness runs for
  the length of the test. The migration and its deployed service are left in place as evidence. The
  test application the harness made to call it is removed.
- The migration runs only with `--isolated-test`, or with `ACC_ALLOW_MIGRATION=1` on the
  customer's install before go-live. The harness refuses to run it against a live tool. It also
  refuses when the migration tool's version recorder has a git remote connected, because a deploy
  would commit and push to that repository.
- For the gateway rules: an API, an application with keys and a subscription, a traffic policy, and
  an IP blocking rule for a documentation-only address (198.51.100.x). All are named `cs-acc-<stamp>-*`
  and all are removed at the end, also when a step fails. Item G7 proves nothing is left behind.
- A test user `cs-acc-user-<stamp>`, created and deleted again (A8).
- Existing APIs, policies, applications, subscriptions and users are never changed.

With `--read-only` the harness creates nothing at all.

## 1. Install & health

| ID | Check | How | Pass when |
|---|---|---|---|
| I1 | The Weave Factory answers | Auto | `GET /factory/healthz` gives 200 |
| I2 | The Weave Gateway console answers | Auto | `GET /healthz` gives 200 |
| I3 | API Manager answers | Auto | The publisher REST API answers (401 without a token) |
| I4 | The API gateway answers | Auto | An unknown API gives 404/401/403, not a network error |
| I5 | All pods of the install are ready | Auto | Every pod in the install namespaces is Ready |
| I6 | The install's containers run and are healthy | Auto | Every container with the install prefix is Up and not unhealthy |
| I7 | The installed version can be seen | Auto | The Factory reports its version. This is needed to prove an upgrade. |
| I8 | The installer finishes on a clean server, without internet | Manual | `install.sh` completes with the offline bundle. Its log has no error. The time it took is written down. |
| I9 | A reboot brings everything back | Manual | Reboot the server. Within 10 minutes I1 to I6 pass again with no manual step. |

## 2. Branding

Nothing a Cruise Saudi user can see or download may say **TraceIT**, **Tottempudi** or
**traceit-tottech**, in any capitalisation. The harness searches for exactly these names:
`TraceIT|Tottempudi|traceit-tottech`, case-insensitive.

| ID | Check | How | Pass when |
|---|---|---|---|
| B1 | Factory UI | Auto (browser) | A browser visits every route and every link it finds, and opens every tab. Page titles, visible text, full HTML (including alt and aria texts) and every response the page loads show none of the names. |
| B2 | Gateway console UI | Auto (browser) | Same as B1, signed in as admin |
| B3 | HTML, titles, scripts, styles, icons, manifests | Auto | The `index.html` of both apps and every file it references (and every file those reference) contain none of the names |
| B4 | API answers and error texts | Auto | Health, unknown routes, unknown ids, sign-in redirects and response headers of both apps contain none of the names, signed in and signed out |
| B5 | Downloadable documents | Auto | Generated documents (technical, mapping, functional, estimate), corrections and requirements workbooks, and service packages are unpacked (zip, xlsx, docx) and searched. This includes the acceptance migration's own documents. |
| B6 | Texts shipped inside the images | Auto | No file in the application images outside `node_modules` contains the names. This covers e-mail templates, server messages and document templates. |
| B7 | The product names itself | Auto | Both page titles say "Cruise Saudi Weave" |
| B8 | E-mails | Manual | Send one e-mail of each kind (sign-in, notification, report) to a test mailbox. The sender name, address, subject, body, footer and links show only Cruise Saudi names and addresses. |
| B9 | Logo, favicon, app icon, colours | Manual | They match the Cruise Saudi brand sheet on the sign-in page, the shell, a phone home screen icon and a browser tab |

## 3. Sign-in & roles

| ID | Check | How | Pass when |
|---|---|---|---|
| A1 | The Factory API refuses calls without sign-in | Auto | 401/403 |
| A2 | The Gateway console API refuses calls without sign-in | Auto | 401/403 |
| A3 | Sign-in offers Microsoft Entra ID | Auto | The sign-in redirect goes to `login.microsoftonline.com` |
| A4 | The local (break-glass) admin can sign in | Auto | A session is made and `/api/auth/me` shows the admin role |
| A5 | A wrong password is refused | Auto | 400/401/403 and no session cookie |
| A6 | A Migration-only user cannot open the Gateway | Auto | The Gateway API refuses that user's session (401/403) |
| A7 | A Gateway-only user cannot run migrations | Auto | The Factory migration API refuses that user's session |
| A8 | An admin can add, list and remove users | Auto | `cs-acc-user-<stamp>` is created with the Migration role, appears in the list, and is deleted |
| A9 | Audit lines record who did what | Auto | The audit shows the user change from A8, and every line names a user |
| A10 | Entra with real Cruise Saudi accounts | Manual | **3.1** Sign in with one Entra account per role: admin, migration, gateway. Each sees only its menus. A Migration user who opens a Gateway address directly sees "not allowed". An account in no Weave group is refused with a clear message. Sign-out ends the session in both apps. |

## 4. Mule to WSO2 migration, end to end

The harness uses our own synthetic Mule 4 project (`sample-mule/cs-acc-orders`): `POST /api/orders`
turns `{customerName, items[{sku, qty, unitPrice}]}` into
`{customer (upper case), lines[{sku, quantity, amount}], total}`, sends it to the backend
`POST /orders`, and answers `{orderId, status, total}`.

| ID | Check | How | Pass when |
|---|---|---|---|
| M0 | The edition offers only MuleSoft to WSO2 | Auto | New migration offers only Mule 4 (and automatic detection) as the source and WSO2 (Ballerina) as the target |
| M0b | Other sources and targets are refused by the server | Auto | Uploads with a Node.js source or a Spring Boot target are refused (400/403), not only hidden in the screen |
| M1 | The sample project is packaged | Auto | Zip built from `sample-mule/`, pointed at the stand-in backend |
| M2 | Upload | Auto | The upload is accepted and a migration is created |
| M3 | Documents | Auto | The document phase is done. TECHNICAL.md, MAPPING.md and FUNCTIONAL.md exist. |
| M4 | The mapping is right | Auto | MAPPING.md names the listener `/api/orders` (POST), the fields `customerName`, `customer`, `qty`, `quantity`, `unitPrice`, `amount`, `total`, and the backend call `/orders` |
| M5 | Generate | Auto | The scaffold phase is done: a WSO2 service was generated |
| M6 | Build and tests | Auto | The test phase is done: build, unit tests and coverage gate |
| M7 | Deploy to the target cluster | Auto | The deploy phase is done. With `ACC_TARGET_KUBECONFIG`, the service's pod runs on the remote target cluster. |
| M8 | Published on API Manager, secured | Auto | The API is PUBLISHED with OAuth2 and/or API-key security |
| M9 | Called through the gateway with a key | Auto | With a token the answer is 200 with `total` 21.0 and the stand-in's order id. The backend got `customer: "TEST GUEST"` and `total: 21`. Without a key the answer is 401. |
| M10 | Logs | Auto | The Factory shows the service's log lines of that call |
| M11 | Analytics | Auto | The Gateway console's analytics for that API counts the call |
| M12 | A real Cruise Saudi Mule project | Manual | Cruise Saudi picks one of its own Mule projects and runs M2 to M11 by hand in the UI with its team. The answers match the Mule answers for the same requests. |

## 5. Gateway rules on a live API

The harness creates its own throw-away API, application and policies (`cs-acc-<stamp>-*`) on the
real gateway. It drives them through the API Manager API, which is what the console uses.

| ID | Check | How | Pass when |
|---|---|---|---|
| G1 | Throw-away API live | Auto | Published, secured, 200 with a token, 401 without, and the stand-in backend was reached |
| G2 | Block an IP | Auto | A blocking rule for 198.51.100.x gives 403 for that client address only. Other addresses are still served. After the rule is removed the address is served again. |
| G3 | Change CORS | Auto | After a new revision, a preflight from the new origin is allowed and one from the old origin is not |
| G4 | Roll back a revision | Auto | Revision 1 is restored and deployed. The old origin is allowed again, the new one is not, and calls are served. |
| G5 | Revoke a key | Auto | An API key and an OAuth token both work, and both give 401 once revoked |
| G6 | Traffic limit | Auto | A policy of 5 requests per minute is assigned to the subscription. Calls go through until the limit, then 429. |
| G7 | Clean-up | Auto | No `cs-acc-<stamp>` API, application, policy or blocking rule is left |
| G8 | The console offers the rules | Auto | The Gateway console answers its routes for traffic limits, access/security/CORS/IP, consumers/apps/keys, blocking rules and revisions |
| G9 | The console audits rule changes | Auto | The console's audit answers |
| G10 | The same, through the screens | Manual | **5.1** Signed in as a Gateway user, on a test API: assign a limit and exceed it (429), block your IP (403), change CORS, revoke a key (401), roll back a revision. Each change appears in the audit with your name. |

## 6. Backup & restore

| ID | Check | How | Pass when |
|---|---|---|---|
| K1 | The commands are installed | Auto | `backup.sh --help` and `restore.sh --help` work |
| K2 | A backup is complete | Auto (isolated install, or `ACC_RUN_BACKUP=1`) | The archive contains Factory data, API Manager data and settings, and only root can read it |
| K3 | A restore brings everything back | Manual (or Auto on the isolated install with `ACC_DESTRUCTIVE=1`) | **6.3** Restore the K2 archive onto a fresh isolated install. Migrations, users, APIs, applications, keys and gateway rules are back, and the harness passes again. |
| K4 | Backups leave the server | Manual | A scheduled backup is copied off the server, and someone restores it once per quarter |

## 7. Upgrade & rollback

| ID | Check | How | Pass when |
|---|---|---|---|
| U1 | The commands are installed | Auto | `upgrade.sh --help` and `rollback.sh --help` work |
| U2 | Upgrade, then roll back | Manual | On the isolated install: note the version (I7), back up (K2), upgrade to the new bundle, run the harness (everything passes, data still there), roll back, run the harness again. Both steps fit the agreed maintenance window. |

## 8. Security checks

| ID | Check | How | Pass when |
|---|---|---|---|
| S1 | API Manager default passwords | Auto | `admin/admin` and other default passwords are refused |
| S2 | Console default passwords | Auto | `admin/admin` is refused by the local sign-in |
| S3 | No open NodePorts | Auto | No Service in the install namespaces is of type NodePort or LoadBalancer, unless agreed (`ACC_ALLOWED_NODEPORTS`) |
| S4 | Public ports | Auto | The host listens publicly only on 22, 80 and 443, plus agreed ports (`ACC_ALLOWED_PORTS`) |
| S5 | TLS only | Auto | Plain HTTP is refused or redirected to HTTPS |
| S6 | TLS versions and certificate | Auto | TLS 1.0 and 1.1 are refused, TLS 1.2 or newer is accepted, and the certificate is trusted for the name |
| S7 | Security headers | Auto | HSTS, `X-Content-Type-Options: nosniff`, no framing (X-Frame-Options or CSP frame-ancestors) |
| S8 | Session cookies | Auto | HttpOnly, SameSite and Secure |
| S9 | Secrets file permissions | Auto | Every secrets file is owned by root, mode 600 or stricter |
| S10 | No secrets in the browser | Auto | Pages and scripts contain no private keys, client secrets or passwords |
| S11 | No outside AI | Manual | The install sends no data to a cloud AI service. Only the self-hosted model is configured. Outbound firewall logs agree. |
| S12 | Accounts and access | Manual | Default and test accounts are removed or disabled. The break-glass admin password is in the Cruise Saudi vault. |

## Before every release: regression suites (our team)

These run on our side before a bundle is handed over. They are not part of the customer run.

- Factory unit tests: `pnpm --filter weave-factory test` and `pnpm --filter weave-factory-bff test` (vitest)
- Factory UI suites: `B=<verify-url>/factory bash /root/accept/run_all.sh` (Playwright, `apps/weave-factory/e2e`)
- Migration tool: `cd Migration-tool/backend && python3 -m unittest`
- Generator: `cd api-migration-platform/migration-factory && python3 -m unittest` (including `tests/test_groovy_runtime.py`)

## Sign-off

| Group | Cruise Saudi (name, date) | Our team (name, date) | Notes |
|---|---|---|---|
| 1. Install & health | | | |
| 2. Branding | | | |
| 3. Sign-in & roles | | | |
| 4. Migration end to end | | | |
| 5. Gateway rules | | | |
| 6. Backup & restore | | | |
| 7. Upgrade & rollback | | | |
| 8. Security | | | |

Attach the `report.html` of the final harness run to this sign-off.
