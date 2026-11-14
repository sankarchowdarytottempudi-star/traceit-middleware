# weave-runtime

Stores, executes and publishes the integration flows designed on the Weave Studio canvas.
Every deployed flow is an HTTP API served by this process under `/run<basePath><triggerPath>`
and, when a gateway is configured, published on WSO2 API Manager in front of it.

The contract (types, node configs, routes) lives in `packages/weave-flow` (`CONTRACT.md`, `src/api.ts`).

## Run

```
pnpm --filter @traceit/weave-flow build
cd apps/weave-runtime
PORT=8791 BIND=127.0.0.1 DATA_DIR=/tmp/wr-dev RUNTIME_INTERNAL_KEY=<any value> npx tsx src/index.ts   # dev
npx tsc --noEmit -p tsconfig.json     # type-check (src + test)
npx vitest run                        # unit tests
```

Production is a container built from `deploy/Dockerfile.runtime` (repository root as build context),
run on the host network as uid 1000 with the data directory mounted at `/data`.

- Management API: `/v1/*`, every call except `GET /v1/healthz` needs the header `x-weave-key`.
- Live flows: `/run/*`, no key (they are reached through the gateway or from inside the cluster).
- The process refuses to bind to every interface; `BIND` must list specific addresses.

## Environment

| Name | Meaning | Default |
| --- | --- | --- |
| `PORT` | listening port | `8790` |
| `BIND` | comma-separated addresses to listen on (never `0.0.0.0`) | `127.0.0.1` |
| `RUNTIME_INTERNAL_KEY` | value expected in `x-weave-key` on `/v1/*` | none (required) |
| `DATA_DIR` | where everything is stored | `./.data` |
| `SECRET_KEY_FILE` | AES-256 key that seals connection secrets; created (mode 0600) when missing | `$DATA_DIR/secret.key` |
| `CLUSTER_DNS` | DNS server used for `*.svc` / `*.cluster.local` host names | system resolver |
| `GATEWAY_BACKEND_URL` | address the gateway uses to reach this runtime (endpoint of every published API) | none |
| `GATEWAY_PUBLIC_URL` | address callers use to reach the gateway (shown as the public URL of a flow) | none |
| `APIM_BASE_URL` | API Manager management address (Publisher / DevPortal REST) | none: publishing is skipped |
| `APIM_PUBLIC_URL` | API Manager address shown to people | `APIM_BASE_URL` |
| `APIM_CA_CERT_PATH` | CA certificate (PEM) trusted for the API Manager and the gateway | none |
| `APIM_DCR_USERNAME`, `APIM_DCR_PASSWORD` | account used to register the runtime's OAuth client | none |
| `APIM_TEST_APP_NAME` | DevPortal application the runtime owns for "try it through the gateway" | `weave-studio-test` |
| `APIM_API_NAME_PREFIX` | name prefix of the APIs the runtime creates | `weave-` |
| `GATEWAY_RECONCILE_SECONDS` | how often published flows are checked against the gateway | `120` |
| `EXEC_HISTORY_PER_FLOW` | executions kept per flow | `200` |
| `MODEL_URL` | optional in-estate model for plain-words rules the built-in rules do not understand | unset (no model is ever called) |
| `LOG_LEVEL` | process log level | `info` |

## Data layout (`DATA_DIR`)

```
flows/<flowId>.json              current draft of each flow
versions/<flowId>/<rev>.json     every saved revision (restore creates a new revision)
deployments/<flowId>.json        what is live: the deployed snapshot, routes, gateway status
connections/<id>.json            connections; secret values are sealed with AES-256-GCM
connectors/<id>.json             custom connectors (hand-written or imported from OpenAPI / Swagger)
executions/<flowId>/<id>.json    run history with step traces (secrets masked, large values cut)
logs/<flowId>.jsonl              flow log lines
metrics/<yyyy-mm-dd>.jsonl       one line per live execution, feeds /v1/stats
state/gateway.json               informational notes about the last publish (never trusted)
secret.key                       the sealing key; back it up together with connections/
```

Files are written atomically (temporary file, then rename). Saving a flow with a stale `revision`
answers 409. Secrets are write-only: the API only ever returns which secret fields are set.

## Publish and reconcile

Deploying a flow validates it, freezes the snapshot in `deployments/`, mounts its triggers under
`/run` and starts its schedules. When `APIM_BASE_URL` is set and the flow asks for the gateway:

1. the API `<APIM_API_NAME_PREFIX><slug>` is created or updated (context = the flow's gateway context,
   endpoint = `GATEWAY_BACKEND_URL/run<basePath>`, one resource per HTTP trigger);
2. a revision is created and deployed, and the API is published;
3. the runtime's own test application is subscribed, so the flow can be tried through the gateway.

Every API the runtime creates carries the property `managedBy=weave-runtime`. An API without that
marker is never updated or deleted, and a flow that asks for a context owned by such an API is
refused at validation and at deploy time.

The gateway may lose its state. Nothing stored is trusted: APIs, the application, subscriptions and
keys are looked up by name each time and recreated when missing. Every `GATEWAY_RECONCILE_SECONDS`
the runtime compares its deployments with the gateway and publishes again whatever is missing;
`POST /v1/gateway/resync` does the same on demand. Undeploying removes the listener, the schedules
and the API (subscriptions and revisions first). A freshly published API can take a few seconds
before the gateway answers for it.

## Plain-words mapping rules

`POST /v1/mapping/compile-instruction` and `POST /v1/mapping/infer` are deterministic code in
`src/mapping/`. They never call anything outside this process unless `MODEL_URL` is set, and even
then only the rule's own words, the target name, the field names and the function signatures
are sent, never sample values, addresses or secrets. A rule that is not
understood is returned as such, with what was understood and suggested phrasings; it is a validation
error on the flow and never silently dropped or guessed.
