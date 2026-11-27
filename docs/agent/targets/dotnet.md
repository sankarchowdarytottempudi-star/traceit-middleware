# Target: .NET service (ASP.NET Core)

## 1. What it is / artifacts
A .NET solution: Web API, background workers, consumers. Defaults (existing conventions win): current .NET LTS · ASP.NET Core (minimal APIs or controllers to match the team) · OpenAPI from Operations rows · `Microsoft.Extensions.*` config, DI, logging (Serilog/OpenTelemetry) · `IHostedService`/`BackgroundService` workers · xUnit + FluentAssertions + `WebApplicationFactory` · Docker.
Layout: `src/<Project>.Api`, `src/<Project>.Units/<Unit>/{Handler,Service,Mapper,Contracts}`, `src/<Project>.Systems/<System>Client`, `src/<Project>.Workers`, `tests/...`.

## 2. Neutral → .NET
| Neutral | .NET |
|---|---|
| flow.call | call the other unit's service via DI (same app) or typed HttpClient/queue (separate app) |
| respond | `Results.Ok(...)` / typed `ActionResult<T>` with status per spec |
| http.request | typed `HttpClient` via `IHttpClientFactory`, base address from config |
| db.* | Dapper (default for migrated SQL) or EF Core when the project uses it |
| db.procedure | `Oracle.ManagedDataAccess.Core` `OracleCommand` CommandType.StoredProcedure with `ParameterDirection.Output`; SQL Server `SqlParameter` Output — native OUT params |
| transform.map | mapper classes (manual or Mapster/AutoMapper if already used) with tests |
| logic.validate | FluentValidation / DataAnnotations from field rows |
| event.publish | `Confluent.Kafka` producer, Azure Service Bus, RabbitMQ.Client |
| file.* | SSH.NET (SFTP), cloud storage SDKs |
| notify.email | MailKit or provider SDK |
| error.raise | typed exceptions → ProblemDetails via exception handler |

## 3. Triggers
HTTP → endpoint (Operations rows only) · schedule → Quartz.NET/Hangfire or platform CronJob · queue/topic → `BackgroundService` consumer · callable → service method/internal endpoint · file → polling worker.

## 4. Systems
One typed client per system: options class bound to config, timeout, Polly policy **only where the source retried**, interface + fake for tests.

## 5. Data / stored procedures
Native OUT parameters with exact names, order and `OracleDbType`/`SqlDbType` from field rows; transactions via `TransactionScope`/`DbTransaction` where the source had them.

## 6. Error handling
none → exception propagates (500 / job fault) · alert-then-fail → try/catch at the unit boundary: truncate (if source) → alert → `throw;` · report-and-continue → try/catch per item: alert, continue. Global exception handler returns ProblemDetails with spec status codes.

## 7. Config
`appsettings.json` keys for every source property (no values for secrets), environment overrides, options validated on start (`ValidateOnStart`), secrets from Key Vault / K8s secrets / user-secrets in dev.

## 8. Packaging / deploy / start
`dotnet build -warnaserror && dotnet test`; container image; start check: host starts, options validate, workers start, consumers subscribe.

## 9. Tests
xUnit per mapper/rule; `WebApplicationFactory` tests per Operations row (success + error rows); fakes for systems; Testcontainers for DB/Kafka where possible; OpenAPI contract test.

## 10. Target gates
Builds with warnings as errors · nullable enabled, no new warnings · OpenAPI = Operations rows · every config key declared and validated · stubs throw `NotImplementedException("TODO <rule id>")`, never return fake data · tests green.

## 11. Traps / confirm first
`DateTime` vs `DateTimeOffset` and time zones · decimal for money · Oracle `RefCursor` outputs · HttpClient lifetime (always via factory) · culture-sensitive parsing (use invariant culture).

## 12. Lessons
(empty — add from the first .NET fixture)
