# Target: Workato

## 1. What it is / artifacts
iPaaS. Package zip with assets at the root: `*.recipe.json`, `*.connection.json` (stubs), `*.topic.json` (Event Streams), `*.api_group.json` + `*.api_endpoint.json` (API platform), lookup tables, project properties. One recipe per unit.

## 2. Neutral → Workato
| Neutral | Workato |
|---|---|
| flow.call | `workato_recipe_function.call_recipe` |
| respond (callable) | `workato_recipe_function.return_result` |
| respond (HTTP) | `workato_api_platform.return_response` |
| db.query / db.write / db.procedure | `jdbc.run_custom_sql` / `search_rows_sql` / `search_rows` (see §5) |
| event.publish | `workato_pub_sub.publish_to_topic` |
| file.read/move | `sftp.dir`, `sftp.streamable_download`, `sftp.rename` |
| file.write (workspace) | `workato_files.store_file` |
| notify.email | `email.send_mail` (no From field) |
| transform.map / complex logic | datapills + formulas; `js_eval` for real logic |
| logic.choice / loop | `if` / `elsif` / `else`, `foreach`, `repeat` (needs max iterations) |
| variables | `workato_variable.declare_variable` / `update_variables` |
| error.raise | `stop` with error |
| http.request | `rest.make_request_v2` with real method, base URL, path |

## 3. Triggers
callable → `workato_recipe_function.execute` · schedule → `clock.scheduled_event` (**"every 1 hour" = hours/1**, minutes/15 etc.; fixed times need time zone) · event → `workato_pub_sub.subscribe_to_topic` · HTTP → `workato_api_platform.receive_request` + endpoint (only for Operations rows) · file → connector's new-file trigger. Never invent `/api`, `/health` or schedules.

## 4. Systems/connectors
JDBC (`jdbc`), SFTP (`sftp`), Event Streams (`workato_pub_sub`), FileStorage (`workato_files`), Email (`email`), HTTP (`rest`), SaaS connectors by their catalogue id. Custom connectors (customer-only): customer build uses the real connector + actions; trial build swaps each step for `STAND-IN for <connector>.<action> — checked in the customer workspace only` at the same position; an automatic diff allows only those swaps. The catalogue (export from the target workspace) lives in `factory/writers/workato_providers.json`; anything not in it fails the build.

## 5. Data / stored procedures
JDBC has **no** stored-procedure action. Functions: `SELECT pkg.fn(?) FROM DUAL`. Procedures with OUT params: one `run_custom_sql` with an Oracle 12c+ `WITH FUNCTION` wrapper, `PRAGMA AUTONOMOUS_TRANSACTION` (comment: changes commit independently — customer to confirm), OUT values joined with `~^~`; next step splits on the **first** `~^~` with a missing-separator guard; DATE params bound as dates (`TO_DATE` format flagged as assumption); types/order from the field rows; "verify against the package spec". Different shape from the design → README "Deliberate changes".

## 6. Error handling
none → no try · alert-then-fail → `try` around body; catch: truncate (if source does) → alert system → `stop` with error · report-and-continue → `try` inside the `foreach`; catch alerts, no stop. Truncation (truncateStringMiddle 2000) = first 1000 + "..." + last 997.

## 7. Config
Project/environment properties for every key read (values unset); `account_property('<key>')` / project property datapills. Connections are stubs (name + provider), no secrets.

## 8. Packaging / import / start
Import the zip into the workspace; every callable/trigger recipe must start (`success: true`). Recipes import stopped (owner starts). Confirm field names inside actions with a sample recipe exported from the workspace.

## 9. Tests
Per recipe: rule and error-row cases; recipe-function tests via a caller recipe; trial start check; customer smoke list (one call per connection, one run per trigger).

## 10. Target gates
Recipe-function family names exact (`execute`, `return_result`, `call_recipe`) · no API collection without Operations rows · procedure SQL gate (pragma + comment, first-only split + guard, DATE binds) · stand-in diff · every topic file has real fields · repeat steps have a max iteration count.

## 11. Traps / confirm first
`call` invalid (use `call_recipe`) · `execute_stored_procedure`, `select_rows` invalid on JDBC · topic subscribe vs publish direction · "New message" trigger has no ordering/concurrency setting (legacy serial delivery not reproduced — say so) · step comments ≤ 800 chars · typed variables start nil · assets at zip root.

## 12. Lessons
See core §15 items 3–8; Workato-specific: `call` rejected by import; procedure-wrapper shape agreed (pragma, first split, DATE bind).
