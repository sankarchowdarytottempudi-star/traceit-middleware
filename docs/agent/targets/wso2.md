# Target: WSO2 (Micro Integrator + API Manager)

## 1. What it is / artifacts
- **Micro Integrator (MI)** runs Synapse XML integration artifacts: **APIs** (REST resources), **proxy services**, **sequences** (reusable mediation), **endpoints**, **inbound endpoints** (Kafka, JMS, file, HTTP listeners…), **scheduled tasks**, **message stores / processors** (store-and-forward, retries), **templates**, **data services** (`.dbs`) for SQL/procedure exposure, **local entries / registry resources**.
- Packaged as a **Composite Application (`.car`)** built from an Integration Project (WSO2 Integration Studio or the MI extension for VS Code; Maven multi-module).
- **API Manager** publishes managed APIs (OpenAPI), applies throttling, security (OAuth2/JWT), versions; MI APIs are its backends.
- Runtime: MI Docker image on Kubernetes; config in `deployment.toml`; secrets via Secure Vault / K8s secrets.
- One unit = one API resource, proxy, task or inbound endpoint + its sequence(s).

## 2. Neutral → WSO2
| Neutral | WSO2 MI |
|---|---|
| flow.call | `<call-template>` / `<sequence key>` (in-process); `<call>` to another API's endpoint when it's a separate deployable |
| respond | `<respond/>` (with `<payloadFactory>`/`<property name="HTTP_SC">`) |
| http.request | `<call>`/`<send>` to an `<endpoint>` (http/address); method via `HTTP_METHOD` property |
| db.query / db.write | data service (`.dbs`) operation called as an endpoint, or DB connector; **procedures with OUT params → data service `<call-query>` with OUT params** (natively supported) |
| transform.map | `<payloadFactory>`, `<datamapper>`, `<xslt>`, `<script>` (JS) / `<enrich>` |
| logic.choice | `<filter>` / `<switch>` |
| logic.loop | `<foreach>` / `<iterate>` + `<aggregate>` |
| logic.validate | `<validate>` (JSON/XML schema) |
| event.publish | Kafka connector `kafkaTransport.publishMessages`, JMS endpoint, or message store |
| file.read/write/move | File connector (local/FTP/SFTP) operations |
| notify.email | Email connector (SMTP) |
| error.raise | `<makefault>` + `<respond>` or `<drop>`; fault sequence |
| log | `<log>` only where the source logs on purpose |

## 3. Triggers
HTTP → `<api context=… >` resource with real method/uri-template (Operations rows only) · schedule → `<task>` with cron (Quartz syntax: seconds field first — convert 5-field cron) · event/queue → inbound endpoint (Kafka/JMS/RabbitMQ) · file → file inbound endpoint (polling folder + pattern) · callable (in-process) → named sequence or template · callable (other services) → internal API.

## 4. Systems/connectors
Use WSO2 connectors from the connector store by system type (DB/data services, Kafka, File, Email, Salesforce, ServiceNow, Shopify…), configured via local entries/`init`. Endpoint definitions per system with environment-specific URLs from `deployment.toml`/env vars. Custom systems: HTTP endpoint + template.

## 5. Data / stored procedures
Data services support stored procedures with IN/OUT/INOUT params and result sets — map 1:1 from the source signature (names, order, SQL types). Expose as internal endpoints called from sequences. Transactions: `boxcarring`/request-box only where the source needed atomicity — note it.

## 6. Error handling
- none → no fault handling beyond default (error propagates to caller: respond with fault).
- alert-then-fail → sequence `onError` / API `faultSequence`: truncate if needed → alert call (alert system endpoint) → `<makefault>`/error response, status code.
- report-and-continue → inside `<foreach>`/`<iterate>`, a per-item sequence with its own `onError` that alerts and continues; or message store + processor for retries if the source retried.
- Retries only where the source retried: endpoint `<suspendOnFailure>`/`<markForSuspension>` or message processor max delivery attempts.

## 7. Config
`deployment.toml` + environment variables (`$env{...}` / `$SYSTEM:`); Secure Vault aliases for secrets; registry/local entries for config values; one config key per source property.

## 8. Packaging / deploy / start
Maven build → `.car`; deploy to MI (`carbonapps` folder or Docker image). Start check: MI starts with no deployment errors in `wso2carbon.log`; each API answers; tasks registered; inbound endpoints connected. Publish to API Manager with OpenAPI from the Operations rows.

## 9. Tests
MI unit testing framework (Synapse unit tests: test suites with mock services per endpoint) per sequence/API; integration tests with Testcontainers/docker-compose (DB, Kafka, SFTP); OpenAPI contract tests against API Manager gateway.

## 10. Target gates
`.car` builds · MI starts clean · every API resource maps to an Operations row · every artifact referenced (sequence/endpoint/template keys) exists · cron converted to Quartz correctly · fault sequences match error modes · no hard-coded hosts/credentials.

## 11. Traps / confirm first
Quartz cron has seconds · `<send>` vs `<call>` (blocking vs non-blocking) changes flow · JSON ↔ XML conversion in payloadFactory (`media-type`) · content-type/`messageType` properties · connector versions differ by MI version — pin them · API Manager vs MI responsibilities (throttling/security belong in APIM).

## 12. Lessons
1. `<throwError>` does not exist before MI 4.4 ("Unknown mediator") → the loop runs wso2/wso2mi:4.4.0, the version the
   writer targets.
2. A bare `<throwError>` in an API resource without a fault sequence makes MI answer 202 with no body → an HTTP
   rejection with a status is payloadFactory + HTTP_SC + respond (wso2_model.py).
3. An upsert whose fields are only the key produced `UPDATE t SET  WHERE k = ?` (Oracle: ORA-03050) → TODO naming the
   missing columns, never invalid SQL.
4. The requirement builder writes conditions as `isEmpty(payload.x)` / `isEmpty(payload)` → translated like "x is
   missing or empty" / "no row" (they were TODOs).
5. Loop bodies may carry mapping rows (`{"target", "source"}`) as fields → item properties use the source name (the
   writer crashed with "unhashable type: dict").
6. The kafkaTransport connector needs kafka-clients, avro and the Confluent serializer jars in `<MI_HOME>/lib`, plus
   the connector zip in synapse-libs and an import artefact; without them every sequence that publishes fails.
7. No `.car` and no MI unit-test suites are generated yet → the loop deploys the artefacts as Synapse configurations
   and the verdict stays "Not ready" until tests exist.
