# Manual Review Workbench (§15)

The page reviewers use inside Zoho CRM, as a **Web Tab** that frames `<PUBLIC_BASE_URL>/review`.
It is served by the Factory BFF only while `REVIEW_WORKBENCH_ENABLED=1`, and is not linked from
the Factory navigation. Turned off, `/review` and `/api/review/*` answer 404.

## What it talks to

Browser → `/api/review/*` (this BFF) → the Integration Service review API (`REVIEW_API_URL`) only.
The Workbench never calls Python, PostgreSQL or CRM. Opening a case makes no CRM call. CRM links
on the page are plain links that open CRM in a new tab.

Upstream endpoints it expects (Integration Service):

| Workbench | Upstream |
|---|---|
| queue | `GET /v1/review-cases?kind&status&assignee` → `[]` or `{cases:[]}` |
| case | `GET /v1/review-cases/{id}` (ReviewCase from the §11 contract) |
| history | `GET /v1/review-cases/{id}/history` → `[]` or `{history:[]}` |
| take / hand over | `POST /v1/review-cases/{id}/assignment` `{assigneeId, assignedBy}` |
| comment | `POST /v1/review-cases/{id}/comments` `{authorId, text}` |
| decision | `POST /v1/review-cases/{id}/decisions` (DecisionPreparationRequest; the Integration Service runs prepare → CRM freshness read → commit, or answers 409 `REVIEW_DATA_CHANGED`) |

Each call carries `Authorization: Bearer <service token>` plus `x-reviewer-id`, `x-reviewer-roles`
and `x-correlation-id`. The reviewer id always comes from the session; anything the browser sends
in its place is ignored.

## Sign-in and its security

* **Identity:** Zoho Accounts, OAuth 2 authorization code with PKCE (S256), scope
  `AaaServer.profile.READ` only. No CRM scope, no extra licence. The Zoho access token is used once
  to read the user's e-mail and ZUID, then revoked.
* **Popup:** Zoho's sign-in page cannot be framed, so sign-in runs in a small window. The result comes
  back by `postMessage` aimed only at this server's origin and checked for origin and nonce. If the
  window loses its link back (Cross-Origin-Opener-Policy), the page claims the result instead: it keeps
  a random secret, sign-in only ever sees its SHA-256 hash, and `POST /api/review/auth/claim` returns
  the result once, within two minutes, to whoever presents the secret.
* **Session:** an opaque random token (stored server-side only as its SHA-256), sent as an
  `Authorization` header. No cookie, so third-party-cookie blocking in the Web Tab does not matter and
  there is no CSRF surface. POSTs must also carry no `Origin` or this server's own. Idle limit
  `REVIEW_IDLE_MINUTES` (30, sliding); absolute limit `REVIEW_MAX_HOURS` (8). The token is kept in
  that tab's sessionStorage only.
* **Framing:** `/review` is sent with `Content-Security-Policy: frame-ancestors 'self' <REVIEW_FRAME_ANCESTORS>`,
  `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, `Cache-Control: no-store`. The rest
  of the Factory keeps its own headers.
* **Roles** (§15.3), from `REVIEW_ROLE_MAP_FILE`: `IDENTITY_REVIEWER` (decide, take cases, comment,
  sees personal details), `IDENTITY_SUPERVISOR` (also reverse decisions and hand cases to others),
  `CRM_ADMINISTRATOR` (read and comment, details masked), `AUDIT_REPORTING` (read only, details masked).
  An account without a role cannot sign in. Masking happens on the server, so masked values never
  reach the browser.

## Settings (Factory env file)

| Name | Meaning |
|---|---|
| `REVIEW_WORKBENCH_ENABLED` | `1` serves the page |
| `REVIEW_ZOHO_CLIENT_ID`, `REVIEW_ZOHO_CLIENT_SECRET_FILE` | Zoho API console "Server-based application" client |
| `REVIEW_ZOHO_ACCOUNTS_URL` | the customer's Zoho data centre, e.g. `https://accounts.zoho.sa` (default `.com`) |
| `REVIEW_ROLE_MAP_FILE` | JSON `{"users": {"<email or ZUID>": ["IDENTITY_REVIEWER"]}, "domains": {"<domain>": [...]}}` |
| `REVIEW_API_URL`, `REVIEW_API_TOKEN_FILE` | Integration Service review API and its service token |
| `REVIEW_FRAME_ANCESTORS` | space-separated CRM origins allowed to frame the page (default the four `crm.zoho.*`) |
| `REVIEW_CRM_LINK_BASE` | e.g. `https://crm.zoho.sa/crm/<org>`; links become `<base>/tab/Contacts/<id>` |
| `REVIEW_SLA_DAYS`, `REVIEW_WORKWEEK` | JSON business days per case kind; work days `0-4` (Sun–Thu) |

Redirect URI to register in the Zoho API console: `<PUBLIC_BASE_URL>/api/review/auth/callback`.

## CRM Web Tab

Setup → Customization → Web Tabs → New: URL `<PUBLIC_BASE_URL>/review`, shown to the reviewer,
supervisor, administrator and audit profiles. No CRM merge fields are needed.
