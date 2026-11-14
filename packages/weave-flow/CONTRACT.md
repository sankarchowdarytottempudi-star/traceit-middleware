# Weave Studio contract

Single source of truth shared by the canvas, the runtime and the estate (migrated API) views.
Types: `src/types.ts`. Node catalog: `src/catalog.ts`. REST: `src/api.ts`.

## Non-negotiable security rules

1. **Nothing leaves the server.** Flows, mappings, sample payloads, endpoints, ids and secrets
   are stored and processed only on the customer's server. No code path may call an external
   AI/LLM or any third-party SaaS with this data. Mapping inference and the plain-words
   interpreter are deterministic local code. An optional *in-estate* model hook may exist behind
   `MODEL_URL` (unset by default); it must never default to a public endpoint.
2. **Secrets are write-only.** Connection secrets are encrypted at rest (AES-256-GCM, key from a
   file on the server), never returned by any API, never written to traces or logs. Traces redact
   `authorization`, `cookie`, `set-cookie`, `x-seaware-authorization`, `client_auth`,
   `x-api-key`, `client_secret`, `password`, `token`-like header and field names.
3. The runtime's management API (`/v1`) requires the internal key header and listens on
   loopback. Live listeners (`/run/...`) listen on loopback and the cluster bridge only
   (never the public interface); the public door is the WSO2 gateway (OAuth2).

## Execution model

- A flow is a directed graph. Execution starts at one trigger node and follows edges.
- Context: `payload` (the current message), `vars` (flow variables), `request` (the triggering
  HTTP request: method, path, params, query, headers, body), `nodes` (outputs so far, by node
  name), plus `item`/`index` inside For Each and `error` inside an error path.
- A node receives the context, may replace `payload` or set a variable (`resultTarget`), then
  execution follows every edge leaving the output port it chose, in edge order, sequentially.
- **Errors:** if a node fails and its `error` port is wired, execution continues there with
  `$error = { message, status, node, detail }`. Otherwise the error bubbles to the nearest
  enclosing Try/Catch, else the execution fails (HTTP: status = error.status or 500, body
  `{ "error": { "message", "node" } }`).
- **Sub-graphs:** For Each (`each`), Parallel (`branch:<id>`) and Try (`try`/`catch`) run the
  nodes reachable from that port until paths end; the sub-graph's result is the payload at the
  end of its last path. Then execution continues on `done`.
- **HTTP response:** the first `respond` node reached sends the response. If the run ends
  without one, the response is `200` with the final payload as JSON. Nodes after `respond` still run.
- A node with several incoming edges runs once per arriving path (no implicit join; use Parallel).
- Disabled nodes pass the context through on `out`.
- Every node execution appends a `StepTrace`. Live executions are stored too (bounded history).

## Expressions

JSONata everywhere. The expression input (`$`) is the **payload**; other context is bound as
variables: `$payload`, `$vars`, `$request`, `$nodes`, `$item`, `$index`, `$error`,
`$env` (`{ flowName, executionId, now }`).

- `kind: "expr" | "code"` fields hold a bare expression: `customer.name`, `$request.query.id`,
  `$nodes."Get voyage".output.data.voyages[0]`.
- `kind: "template"` fields (and strings inside `json` / `keyvalue` values) interpolate
  `{{ expression }}`. A string that is exactly one `{{ ... }}` yields the raw value (not a string).
- Extra helper functions are listed in `GET /v1/catalog` → `functions`.

## Mapping

`MappingSpec.rules` build the output object field by field (dot paths, `[n]` indexes):

| kind | meaning |
|---|---|
| `direct` | copy `source` path from the input |
| `expr` | JSONata against the input |
| `const` | literal `value` |
| `instruction` | **the user's own words.** `instruction` is kept verbatim; the local interpreter fills `compiled { expr, explanation, confidence }`. The UI shows "Understood as: <explanation>" with the live result and lets the user edit the expression. If `compiled` is null the rule is a validation error with suggestions - never silently dropped. |

`comment` is free text kept with the rule and never executed.

## Estate (already-migrated services) — served by the Factory BFF, not the runtime

Read-only views over the migrated Ballerina services so a user can open any deployed API and see
its flow, connectors, mappings and logs, then clone it into an editable Weave flow.

```
GET  /api/factory/estate                      -> { apis: EstateApi[]; links: EstateLink[] }
GET  /api/factory/estate/:api                 -> EstateApiDetail
GET  /api/factory/estate/:api/flow?operation= -> Flow   (readOnly: true; one flow per service, every
                                                  operation is a trigger.http node; each node's
                                                  config.__source = { file, line, endLine, code })
GET  /api/factory/estate/:api/logs?tail=&q=   -> { lines: { at?: string; level?: string; text: string }[] }
GET  /api/factory/estate/:api/metrics?hours=  -> { total, errors, p50Ms, p95Ms, series: [{ at, total, errors }] }
POST /api/factory/estate/:api/clone           <- { name: string } -> { flowId: string }   (creates an editable Flow in the runtime, origin { kind: "migrated", ref: api })

EstateApi       { name, layer: "exp"|"proc"|"sys"|"other", technology, status: "running"|"down",
                  replicas, nodePort?, basePath?, gateway?: { published: boolean; context?: string },
                  operations: number, connectors: number, migrationId?: string }
EstateLink      { from: string; to: string; via: "http"|"graphql"|"redis"|"postgres"|"other"; label?: string }
EstateApiDetail EstateApi & {
                  operations: { id, method, path, summary?, implemented: boolean, file, line }[],
                  connectors: { name, kind, target (URL/host as configured; credentials NEVER included), usedBy: string[] }[],
                  mappings:   { id, operation?, name, kind: "function"|"record"|"query"|"inline", file, line, code, fields?: { target, source }[] }[],
                  config:     { key: string; value: string (secrets masked) }[] }
```

Canvas routes that render these: `/studio/estate/:api` opens the read-only flow view in the
same canvas component used for editing (inspector shows `config.__source.code`), with tabs
Flow | Connectors | Mappings | Logs and a "Clone to editable flow" action.

## Front-end routes (apps/weave-factory)

```
/                       Home (overview)                         studio
/studio                 Flows list                              studio
/studio/flows/:id       Canvas editor (tabs: Canvas, Connections, Mappings, Executions, Logs, Settings)  studio
/studio/connections     Connections                             studio
/studio/connectors      Custom connectors (+ OpenAPI import)    studio
/studio/executions      All executions                          studio
/studio/estate/:api     Read-only flow view of a migrated API   studio (data: migrate BFF)
/estate                 Deployed APIs landscape + list          migrate
/estate/:api            Migrated API detail                     migrate
/migrations             Migrations list                         migrate
/migrations/new         Start a migration                       migrate
/migrations/:id         Migration detail (phases, docs, run)    migrate
/workspaces /playground /knowledge                              migrate
```

## Additions by the runtime stream (all optional / additive; nothing above changed)

```
POST /v1/flows/:id/versions/:revision/restore  -> Flow            a new revision carrying that version's content
PUT  /v1/flows/:id  (stale revision)           -> 409 problem     carries `currentRevision`
POST /v1/flows/:id/deploy (flow has errors)    -> 422 problem     carries `issues: ValidationIssue[]`
/run/...                                       response header    `x-weave-execution-id` (the live execution it produced)
POST /v1/mapping/infer                         also accepts `sampleTarget` as a synonym of `desiredOutput`;
                                               rules are InferredMappingRule (MappingRule + confidence 0..1, comment = why).
                                               A target field nothing explains comes back as a low-confidence `const`
                                               rule with a comment, never dropped.
POST /v1/mapping/compile-instruction           response adds ok, reason, understood[], fields[], previewError
                                               (not understood: compiled = null, ok = false, reason + suggestions[])
POST /v1/mapping/preview                       rule entries add warning, compiled, suggestions[]
```

Mapping rules written in plain words (`kind: "instruction"`):
- they are compiled when the flow is saved, validated, tested or deployed; the result is stored in `compiled`
  (`engine: "rules"`, or `"in-estate-model"` when MODEL_URL is configured and the rules did not understand it);
- an instruction that is not understood is a validation **error** on the flow and a per-rule error in
  preview and test runs (`{ id, ok: false, error, suggestions }`); the other rules are still evaluated;
- text that is already a valid expression is accepted as written.

Expressions: connector operations bind `$params` (the operation's parameters) next to the standard bindings.
Extra helpers (all listed with examples in `GET /v1/catalog` -> `functions`): `$titleCase $capitalize $initials
$words $digits $isEmpty $coalesce $translate $toBool $yesNo $parseDate $formatDate $addTime $dateDiff
$epochMillis $toMinorUnits $fromMinorUnits $uuid $hash $parseJson $xmlToJson $jsonToXml`.

Stats: `errors` counts live executions that failed or answered 5xx (a handled failure that still answers 5xx
is an error for the caller). Only live executions are counted; test runs never are.
