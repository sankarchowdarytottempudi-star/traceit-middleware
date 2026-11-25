# Cruise Saudi Weave: sign-in with Microsoft Entra ID, users and access

This page says exactly what Cruise Saudi's Entra ID administrator creates, and how the Weave server
is set up to use it. Until the app registration exists, Weave accounts (e-mail + password kept on
the Weave server) work on their own.

Weave has two web apps on one address:

| App | Address | Callback (redirect URI) |
| --- | --- | --- |
| Gateway console | `https://weave.aroya.com/` | `https://weave.aroya.com/api/auth/callback` |
| Factory (migrations, integration studio) | `https://weave.aroya.com/factory` | `https://weave.aroya.com/factory/api/auth/callback` |

Access is granted per person, per area:

| Role | Gives |
| --- | --- |
| **Migration** | the Factory (migrations and the integration studio) |
| **Gateway** | the Gateway console (APIs, analytics, logs, rate limits, approvals) |
| **Admin** | the "Users and access" screen: people, roles, group mapping, audit log |

A person can have any mix. Roles come from the person's own entry in Weave and, for Microsoft
accounts, from Entra groups mapped to roles (both add up).

---

## 1. What to create in Entra ID (Cruise Saudi)

### 1.1 App registration

Entra admin center → **Identity → Applications → App registrations → New registration**

| Field | Value |
| --- | --- |
| Name | `Cruise Saudi Weave` |
| Supported account types | **Accounts in this organizational directory only** (single tenant) |
| Redirect URI | Platform **Web**: `https://weave.aroya.com/api/auth/callback` |

`weave.aroya.com` is the internal name of the server; Entra accepts a private host name for a Web
redirect URI (it must be `https`). Microsoft never connects to it: the browser carries the answer back.

After it is created, open **Authentication** and:

- add the second Web redirect URI: `https://weave.aroya.com/factory/api/auth/callback`
- leave **Front-channel logout URL** empty
- under *Implicit grant and hybrid flows* leave **both boxes unticked** (Weave uses the authorization code flow with PKCE; no tokens are sent through the browser)
- *Allow public client flows*: **No**

From **Overview**, write down:

- **Application (client) ID** → `OIDC_CLIENT_ID`
- **Directory (tenant) ID** → used in `OIDC_ISSUER`

### 1.2 Client secret

**Certificates & secrets → Client secrets → New client secret**, description `weave-server`,
expiry of your policy (for example 12 or 24 months). Copy the **Value** (not the Secret ID) once;
it goes into `OIDC_CLIENT_SECRET` on the server and nowhere else. Put a reminder in the calendar
before it expires: an expired secret stops all Microsoft sign-ins (Weave accounts keep working).

### 1.3 API permissions

**API permissions**: Microsoft Graph, *delegated*: `openid`, `profile`, `email` (`User.Read` is
added by default and can stay). Press **Grant admin consent for Cruise Saudi** so people are not
asked one by one. Weave does not call Microsoft Graph.

### 1.4 Token configuration (groups claim, e-mail)

**Token configuration**:

1. **Add optional claim** → token type **ID** → tick `email` (and `preferred_username` if offered). If asked, allow the Graph `email` permission.
2. **Add groups claim** → choose **Groups assigned to the application** (recommended) or **Security groups**. Under *Customize token properties by type*, for **ID** keep **Group ID**.

Why "Groups assigned to the application": a person in more than 200 groups gets no `groups` list
in the token at all (Entra sends a "too many groups" marker instead). Limiting the claim to the
groups assigned to the app keeps the list short. Weave reads object IDs; group names are only sent
for groups synchronised from on-premises AD, so map by **Object ID**.

(Alternative some tenants prefer: define App roles `Weave.Admin`, `Weave.Migration`,
`Weave.Gateway` under **App roles**, assign them to groups, and set `OIDC_GROUPS_CLAIM=roles` on the
server; then map those role values instead of group IDs.)

### 1.5 Groups to create

**Identity → Groups → New group**, type **Security**, membership **Assigned**:

| Group | Weave role | Who |
| --- | --- | --- |
| `Weave - Admins` | Admin (+ Gateway, Migration if wanted) | the 1-2 people who manage access |
| `Weave - Migration` | Migration | people who run migrations / build integrations |
| `Weave - Gateway` | Gateway | people who operate the API gateway |

Write down each group's **Object ID**; a Weave admin enters them on the *Directory groups* tab.

### 1.6 Who may sign in (recommended)

**Enterprise applications → Cruise Saudi Weave → Properties → Assignment required? = Yes**, then
**Users and groups → Add user/group** → add the three groups. Only their members can then sign
in, and (with "Groups assigned to the application") only these groups appear in the token.
(Assigning groups to an application needs Entra ID P1 or P2. Without it, leave assignment off and
use "Security groups" in 1.4; Weave still lets in only people who have a Weave entry or a mapped group.)

### 1.7 What to send to the Weave operator

- Directory (tenant) ID
- Application (client) ID
- the client secret value (through a secure channel, never by e-mail or chat)
- the Object IDs of the three groups
- the e-mail of the first Weave admin

---

## 2. Server settings (Weave operator)

Both containers (Gateway and Factory) get the **same** sign-in settings and must see the **same**
users file. Use one directory on the host, mounted read-write into both, owned by the container
user (uid 1000):

```
install -d -m 700 -o 1000 -g 1000 /srv/weave/access
# Gateway and Factory containers:  -v /srv/weave/access:/data/access
```

Settings (in each app's env file):

| Setting | Value | Notes |
| --- | --- | --- |
| `AUTH_PROVIDER` | `oidc,local` | sign-in choices, in order. `local` alone until Entra is ready; keep `local` afterwards as the break-glass path. `wso2` = API Manager sign-in (TraceIT default) |
| `WEAVE_USERS_FILE` | `/data/access/users.json` | shared by both apps; created on first use |
| `WEAVE_AUDIT_FILE` | `/data/access/audit.jsonl` | optional; this is the default next to the users file |
| `OIDC_ISSUER` | `https://login.microsoftonline.com/<tenant id>/v2.0` | exactly this form |
| `OIDC_CLIENT_ID` | application (client) ID | |
| `OIDC_CLIENT_SECRET` | the secret value | or `OIDC_CLIENT_SECRET_FILE=/run/secrets/weave-oidc` |
| `OIDC_REDIRECT_URI` | Gateway: `https://weave.aroya.com/api/auth/callback`; Factory: `https://weave.aroya.com/factory/api/auth/callback` | defaults to `PUBLIC_BASE_URL` + `/api/auth/callback`, so normally not needed |
| `OIDC_SCOPES` | `openid profile email` | default |
| `OIDC_GROUPS_CLAIM` | `groups` | default; `roles` if App roles are used |
| `OIDC_LABEL` | `Sign in with Microsoft` | button text, default |
| `WSO2_DEFAULT_ROLES` | *(empty)* | only matters if `wso2` stays in `AUTH_PROVIDER`: roles of an API Manager user without a Weave entry. Default is all roles (TraceIT behaviour); set it empty at Cruise Saudi |
| `AUTH_SESSION_HOURS` | `12` | length of a Microsoft / Weave account session |
| `WEAVE_EDITION` | `cruise-saudi` | product name on the sign-in page (or `WEAVE_PRODUCT_NAME`) |

Unchanged, still needed: `APIM_DCR_USERNAME` / `APIM_DCR_PASSWORD` (see 2.3), `SESSION_SECRET`,
`PUBLIC_BASE_URL` (`https://weave.aroya.com` and `https://weave.aroya.com/factory`). The UI images
are built with `VITE_WEAVE_FACTORY_URL=https://weave.aroya.com/factory` (Gateway) and
`VITE_WEAVE_GATEWAY_URL=https://weave.aroya.com` (Factory) so each links to the other and to *Users and access*.

Keep the server clock in sync (NTP): ID tokens are checked for expiry with two minutes of tolerance.

### 2.0 Network: what the server must reach (closed firewall)

The users' **browsers** go to Microsoft for the sign-in page (`login.microsoftonline.com`, and the
usual Microsoft sign-in hosts such as `aadcdn.msftauth.net`); that is the browsers' normal internet
access and needs nothing on the server. The **Weave server** itself needs exactly one allow-list rule:

| From | To | Port | Used for |
| --- | --- | --- | --- |
| Weave server | `login.microsoftonline.com` | 443 (HTTPS) | `GET /<tenant>/v2.0/.well-known/openid-configuration` (discovery), `GET /<tenant>/discovery/v2.0/keys` (JWKS, the signing keys), `POST /<tenant>/oauth2/v2.0/token` (code exchange at each sign-in) |

Not needed: **Microsoft Graph** (`graph.microsoft.com`). Weave reads groups only from the ID
token's `groups` claim (section 1.4) and never calls Graph. Keep the groups claim limited to
"Groups assigned to the application" so it is never left out for people in many groups.

If the server reaches the internet only through a proxy, set (both apps):

| Setting | Example | Notes |
| --- | --- | --- |
| `OIDC_HTTPS_PROXY` | `http://proxy.cruisesaudi.local:3128` | proxy for the Microsoft calls only. If unset, `HTTPS_PROXY` / `https_proxy` is used |
| `NO_PROXY` | `localhost,127.0.0.1,.svc,.cluster.local` | hosts never sent to the proxy |

The proxy is used with `CONNECT`, so TLS runs end to end to Microsoft and the certificate is
checked; `http://user:password@host:port` works for a proxy that needs a login. API Manager and all
other internal calls never go through the proxy.

**If Microsoft cannot be reached:**

- People already signed in carry on: a session lives on the Weave server (up to `AUTH_SESSION_HOURS`) and is never re-checked with Microsoft.
- The discovery document is kept an hour and the signing keys until Microsoft publishes new ones; when they cannot be fetched again, the copies in hand stay in use. A short outage therefore only stops *new* Microsoft sign-ins (the code exchange itself needs Microsoft). The sign-in page then says so in plain words.
- **Break-glass:** keep `local` in `AUTH_PROVIDER` and at least one Weave account with the Admin role (password kept in the company vault). It signs in without Microsoft. The command-line tool (2.1) can also add or reset an account on the server.

A wrong or incomplete setting stops the app at start with a plain message (for example
"AUTH_PROVIDER includes oidc but OIDC_CLIENT_SECRET is not set").

### 2.1 First admin (once; there is no default password)

Either from the command line inside the Gateway container (asks for the password twice, hidden):

```
docker exec -it weave-gateway node dist/src/access/cli.js bootstrap-admin --email ops@cruisesaudi.com --name "Weave Ops"
# a Microsoft account instead (no password; signs in with Microsoft once Entra is set up):
docker exec -it weave-gateway node dist/src/access/cli.js bootstrap-admin --email it.admin@cruisesaudi.com --provider oidc
docker exec -it weave-gateway node dist/src/access/cli.js list
docker exec -it weave-gateway node dist/src/access/cli.js reset-password --email ops@cruisesaudi.com
```

(In the Factory container the path is `dist/access/cli.js`.) Or through the environment on the
first start: `WEAVE_BOOTSTRAP_ADMIN=<e-mail>` plus either `WEAVE_BOOTSTRAP_PASSWORD_FILE=<file with
the password>` (Weave account) or `WEAVE_BOOTSTRAP_PROVIDER=oidc` (Microsoft account). Both do
nothing once an active admin exists. Remove the variables (and the password file) afterwards.

### 2.2 Users and access screen

Gateway console → **Admin → Users and access** (the Factory shows a link for admins):

- **People**: add a Weave account (e-mail + password, at least 12 characters; "Generate" makes
  one), invite a Microsoft account by e-mail (the first sign-in binds the entry to the person's
  directory object ID; after that the e-mail is not used to match), set roles, switch off / on,
  reset a Weave password, remove. You cannot remove your own admin role or switch yourself off,
  and at least one active admin always remains.
- **Directory groups**: group Object ID → roles. A Microsoft user without a Weave entry who is in
  a mapped group gets an entry at first sign-in ("through groups").
- **Audit log**: sign-ins (and refused sign-ins), every change to users and groups, and every
  change made through the Gateway and the Factory (POST/PUT/PATCH/DELETE), with time, person,
  action, address and result.

Changes apply on the person's next request (roles are read from the shared file each time).

### 2.3 API Manager calls for Microsoft and Weave accounts

Microsoft and Weave accounts are not API Manager users. For them both apps call API Manager with
the server's own service account (`APIM_DCR_USERNAME`, password grant on the app's existing client
registration; token kept up to one minute) and write the real person to the audit log, marked
"service account". That account therefore needs the API Manager admin scopes (`apim:admin`,
`apim:api_manage`, ...). People who sign in with an API Manager account keep using their own token.
Who may do what is decided by the Weave roles, not by API Manager. In the Factory, switching a
running API on or off is allowed to Microsoft/Weave accounts that also have the Gateway role
(API Manager sign-ins: their `apim:admin` scope, as before).

### 2.4 Checks after setting up

1. Open `https://weave.aroya.com/api/auth/login`: the page shows "Sign in with Microsoft" and the Weave account form.
2. Sign in with Microsoft as a member of `Weave - Gateway` only: the Gateway console opens; the Factory says "No access to the Factory"; the Users and access item is not shown.
3. Sign in to the Factory as a member of `Weave - Migration` only: Factory opens; its Gateway link is hidden; the Gateway console says it has no access.
4. As an admin, open the audit log: the sign-ins are there.

If Microsoft sign-in fails, the sign-in page says so in plain words and the server log has the
reason (for example "ID token refused: audience does not match" means the client ID setting is
wrong; "issuer does not match" means the tenant in `OIDC_ISSUER` is wrong).

---

## 3. Notes

- Files: `users.json` (mode 600; passwords only as scrypt hashes) and `audit.jsonl` (append-only,
  one JSON object per line). Back both up with the rest of the Weave data. The audit log is not
  rotated by Weave; rotate it with the host's tools if it grows large (the screen reads the last 8 MB).
- Sessions are kept per app (cookie `sid` for the Gateway at `/`, `weave_factory_sid` at
  `/factory`; httpOnly, Secure, SameSite=Lax). Signing in to one app does not sign you in to the
  other, but with Microsoft the second sign-in passes without typing anything.
- Sign-out ends the Weave session only; the Microsoft session in the browser stays.
- Five wrong passwords for one Weave account from one address lock it for 15 minutes.
- Settings reference in code: `apps/gateway-admin-bff/src/access/settings.ts` (the same folder is in `apps/weave-factory-bff/src/access`).
