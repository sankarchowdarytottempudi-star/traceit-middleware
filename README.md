# TraceIT Weave - middleware tooling

Isolated workspace on the POC server for **TraceIT Weave** tooling, built on the WSO2 REST APIs.
Separate from TraceIT monitoring and from the WSO2 runtime (k3s).

- `apps/gateway-admin` - **Weave Gateway**: React 19 admin UI for WSO2 API Manager.
- `apps/gateway-admin-bff` - Fastify backend-for-frontend; owns all WSO2 communication (the browser never sees a WSO2 token).
- `packages/weave-brand` - brand components (WeaveMark, WeaveLockup, TraceItLogo) + constants + tokens.
- `packages/tokens` - base design tokens (CSS custom properties).
- `design/` - approved design references (source of truth; do not edit).
- `brand/weave/` - official logo assets + BRAND.md.
- `deploy/` - Dockerfile + Helm chart (`weave-gateway`).

> TraceIT Weave is a product of Tottempudi Software Solutions Pvt Ltd.

## Develop
```
pnpm install
pnpm --filter gateway-admin-bff dev      # BFF on :8787
pnpm --filter gateway-admin dev          # Vite on :5173 (proxies /api -> :8787)
```

## Run against a real WSO2
The BFF needs these env vars (see `apps/gateway-admin-bff/.env.example`):
`APIM_BASE_URL`, `APIM_CA_CERT_PATH` (PEM trusted as CA for WSO2's self-signed cert -
never disable TLS verification), `APIM_DCR_USERNAME`, `APIM_DCR_PASSWORD`, `SESSION_SECRET`,
`PUBLIC_BASE_URL`, optional `MIGRATION_TOOL_URL`.
On first start the BFF self-registers an OAuth client via WSO2 Dynamic Client Registration and
stores the client id/secret under `.data/` (never committed). Users sign in on the WSO2 login
page (Authorization Code + PKCE); the session is an httpOnly, Secure, SameSite=Lax cookie.
Set `VITE_WEAVE_FACTORY_URL` to show the Factory link in the sidebar.

## Quality gates
```
pnpm -r typecheck && pnpm -r lint && pnpm -r test
pnpm --filter gateway-admin build && pnpm --filter gateway-admin-bff build
pnpm --filter gateway-admin exec playwright test   # mocked WSO2; screenshots in runs/
```

## Container + Helm (not auto-deployed)
```
docker build -f deploy/Dockerfile -t weave-gateway:0.1.0 .
helm install weave-gateway deploy/helm/gateway-admin -n weave --create-namespace
```
See `deploy/helm/gateway-admin/README.md` for secrets and the release-name alias note.
