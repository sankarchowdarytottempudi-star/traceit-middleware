# Target: Node.js service (TypeScript)

## 1. What it is / artifacts
A TypeScript service repo: HTTP API, background jobs, queue/topic consumers. Defaults (existing project conventions win):
Node LTS · TypeScript strict · **Fastify** (or NestJS when the source is large and layered) · OpenAPI 3 from the Operations rows (routes validated from the schema) · `pino` logging with correlation id · config via env + schema validation (`zod`/`envalid`) · Docker image · `vitest`/`jest` + `supertest`.
Layout: `src/units/<unit>/{handler,service,mapper,schema}.ts`, `src/systems/<system>.ts` (one client per system), `src/jobs`, `src/consumers`, `src/config`.

## 2. Neutral → Node.js
| Neutral | Node.js |
|---|---|
| flow.call | direct call to another unit's service function (same service) or HTTP/queue call (separate service) |
| respond | Fastify reply with schema-typed body + status |
| http.request | `undici`/`fetch` client per system with base URL from config, timeout, typed response |
| db.* | driver per DB: `pg`, `mssql`, `oracledb`, `mysql2`; query builder (Knex/Kysely) or ORM only if the project uses one |
| db.procedure | `oracledb` `execute('BEGIN pkg.proc(:a,:b,:out1,:out2); END;', {out1:{dir:BIND_OUT,type:STRING}})` — native OUT binds; `mssql` `request.output(...)` |
| transform.map | pure mapper functions with unit tests |
| logic.* | plain TS; validation with the route schema / `zod` |
| event.publish | `kafkajs` / `@confluentinc/kafka-javascript`, `amqplib`, cloud SDKs |
| file.* | `ssh2-sftp-client`, cloud storage SDKs |
| notify.email | `nodemailer` (SMTP) or provider SDK |
| notify.alert | client for the alert system |
| error.raise | throw typed error mapped to status by the error handler |

## 3. Triggers
HTTP → route (Operations rows only) · schedule → `node-cron`/`croner` in a dedicated worker process, or platform cron (K8s CronJob) — prefer the platform when deployed on K8s · queue/topic → consumer process (consumer group, manual commit after success) · callable → exported function / internal route · file → poller job.

## 4. Systems
One client module per system with: config keys, timeout, retry policy only where the source retried, typed requests/responses, a fake for tests.

## 5. Data / stored procedures
Native OUT binds (no wrappers needed). Transactions where the source had them. Parameter types/order from the field rows. Connection pools sized from config.

## 6. Error handling
none → let it throw (route returns 500 / job fails) · alert-then-fail → try/catch at the unit boundary: truncate (if source) → alert → rethrow · report-and-continue → try/catch inside the item loop: alert, continue. Central error handler maps typed errors to status codes from the spec.

## 7. Config
Every source property = one env var, validated at startup (fail fast if missing); `.env.example` lists all keys (no values); secrets from the platform secret store.

## 8. Packaging / deploy / start
`npm ci && npm run build && npm test`; Docker image; health/readiness endpoints **only if the deployment platform needs them** (record as a deliberate addition, never in the API spec as business endpoints). Start check: container starts, config validates, consumers join groups, jobs register.

## 9. Tests
Unit tests per mapper/rule; route tests with `supertest`/Fastify `inject` per Operations row (success + every error row); system clients faked; integration tests with Testcontainers (Postgres/Oracle XE/Kafka/SFTP) where available; contract test against the OpenAPI.

## 10. Target gates
`tsc` clean · lint clean · OpenAPI matches Operations rows exactly · every env key in `.env.example` and the schema · no `any` in system clients · no TODO stubs that return fake data (stubs must throw) · tests green.

## 11. Traps / confirm first
Event-loop blocking in CPU-heavy maps (use worker threads) · `oracledb` thin vs thick mode (thin needs no Instant Client; some features need thick) · Kafka consumer commit semantics · time zones in cron (set explicitly) · number precision for money (use decimal libs/strings).

## 12. Lessons
(empty — add from the first Node.js fixture)
