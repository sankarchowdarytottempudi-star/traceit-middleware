# 08 — Complete inputs and guided release (no gaps, no rework)

Rework comes from missing facts, not from building. This file makes the factory get complete facts on day 1, verify them against the real systems, refuse to build a unit until it is ready, and release through UAT and production as a guided routine.

## 1. Evidence request (day 1, before reading)
Generate a checklist from the source type and target, send it to the customer, track each item received / missing / not applicable.

| Source type | Ask for |
|---|---|
| Any integration | full legacy export (package/project), all properties/config files per environment, connection inventory (system, host, auth type, owner), schedules (scheduler export), sample payloads per interface (masked), error/alerting conventions, volumes and SLAs |
| Database work | DDL for every table used, stored procedure/package specs (and bodies if possible), sample rows, which schema/user per environment |
| Messaging | topic/queue list with schemas, ordering and retention needs, sample messages |
| Files | folder paths per environment, file name patterns, sample files, archive rules, time zone |
| APIs | OpenAPI/WSDL, auth method, sample requests/responses, error codes, rate limits |
| Apps | design files, screen list, API contracts, analytics plan, store accounts |

Missing evidence items become blocking or non-blocking open questions automatically, each with an owner. Lessons from past jobs (missing properties file, missing procedure code, missing message type, missing schedules) are always on the list.

## 2. Automatic verification against real systems (read-only)
With read-only test-environment access (credentials via the 07 wizard):
- **Databases:** read the data dictionary (e.g. Oracle `ALL_TAB_COLUMNS`, `ALL_ARGUMENTS`, `ALL_PROCEDURES`) to confirm tables, columns, types, nullability, keys and procedure signatures (names, order, IN/OUT, types); detect whether a procedure writes data where possible.
- **SFTP/file:** list folders, confirm paths and sample file names match patterns.
- **Messaging:** confirm topics exist, read schemas from the registry.
- **APIs:** call safe endpoints (GET/health/metadata) to confirm base URLs and auth.
Each verified fact updates the spec ("verified on <date> against <env>"); mismatches become open questions with the evidence attached. Never write to customer systems during verification.

## 3. "Ready to build" check per unit
A unit is built only when its checklist is complete; otherwise it waits with a clear list of what's missing.

| Unit has | Must be known |
|---|---|
| HTTP endpoint | method, path, request/response schema, auth, error codes, volumes |
| Schedule | frequency, time zone, overlap rule (skip/queue) |
| Event consumer | topic, schema, ordering need, duplicate handling, error mode |
| DB step | verified table/columns or procedure signature, transaction need |
| File step | verified paths, pattern, archive/overwrite rules |
| Alerting | alert system and its fields, who receives what |
| Any unit | error mode (01-CORE §8.4), owner, test data |

The report shows units as Ready / Waiting (with the missing items and owners).

## 4. Customer profile (captured once, reused)
`profiles/<customer>.json` (private): naming conventions, folder/project structure, alerting system and mapping, logging standards, environments (names, URLs, accounts), approval chain, change-management tool, deployment windows, spelling/language preferences for documents. Every migration for that customer starts from the profile; changes to it are versioned.

## 5. Environments and promotion
- Environment matrix per project: dev → test → UAT → prod, each with its own connections, properties and accounts (07 wizard), never shared secrets.
- Promotion moves the **same build hash**; only environment config differs.
- **UAT:** deploy → run the business UAT scripts (07 §6) with the customer's testers → record pass/fail and sign-off in the tool → defects flow back as workbook changes or bug items, regenerate, retest.
- **Before prod:** performance/load test at stated volumes, security scan (dependencies, secrets, config), parity (07 §2) green, rollback rehearsed.
- **Release pack generated:** release notes (what's in, deliberate changes, known limits), change ticket created in the customer's tool (Jira/ServiceNow) with plan, risk, rollback, test evidence; deployment window respected.
- **Prod:** one approved click → deploy → smoke test → monitoring live (07 §8) → hypercare dashboard for the first days.

## 6. Gates
| Gate | Pass |
|---|---|
| Evidence | every blocking evidence item received or explicitly waived by the customer |
| Verification | every DB/file/topic/API fact used by a unit verified against a real environment, or listed as unverified with owner |
| Ready to build | all units Ready |
| UAT | all UAT scripts passed and signed off |
| Prod readiness | performance, security, parity, rollback rehearsal green; change ticket approved |

## 7. The honest limit
The tool can be gap-free only when the customer supplies the evidence and decisions. The tool's job is to ask for everything on day 1, verify everything it can by itself, and make every remaining gap visible with an owner, so nothing is discovered late and nothing is rebuilt.

## 8. Lessons
1. Missing properties file, missing procedure code, an undefined message type and absent schedules caused most open points in a past migration → always on the day-1 evidence list.
2. Table and procedure details marked "unverified" for the whole project → read-only data-dictionary verification.
