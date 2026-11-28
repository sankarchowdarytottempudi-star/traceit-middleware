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
| event.publish | broker product decides (§4): Kafka → `kafka.publish_to_topic` (`topic`, `key`, `value` = fields as JSON); Workato Event Streams / pub-sub → `workato_pub_sub.publish_to_topic` |
| file.read/move | `sftp.dir`, `sftp.streamable_download`, `sftp.rename` |
| file.write (workspace) | `workato_files.store_file` |
| notify.email | `email.send_mail` (no From field) |
| transform.map / complex logic | datapills + formulas; `js_eval` for real logic |
| logic.choice / loop | `if` / `elsif` / `else`, `foreach`, `repeat` (needs max iterations) |
| variables | `workato_variable.declare_variable` / `update_variables` |
| error.raise | `stop` with error |
| http.request | `rest.make_request_v2` with real method, base URL, path |
| notify.alert (HTTP alert API) | `rest.make_request_v2` to the Operations row the text says is called on the alert system ("calls POST /alerts on OpsAlert with …"); body fields as written (literal, caught error message, feature name, correlation id; a field with no value → null + TODO) |

## 3. Triggers
callable → `workato_recipe_function.execute` · schedule → `clock.scheduled_event` (**"every 1 hour" = hours/1**, minutes/15 etc.; fixed times need time zone) · event → Kafka: `kafka.new_message` (`topic`); Event Streams: `workato_pub_sub.subscribe_to_topic` · HTTP → `workato_api_platform.receive_request` + endpoint (only for Operations rows) · file → connector's new-file trigger. Never invent `/api`, `/health` or schedules.

## 4. Systems/connectors
JDBC (`jdbc`), SFTP (`sftp`), message broker by its product (system name / host / note / source quote): Kafka → Apache Kafka (`kafka`, a connection named after the system, no topic files), Workato Event Streams / pub-sub → Event Streams (`workato_pub_sub`, built in, `*.topic.json` with the message fields), no product named → Event Streams stand-in (README says so), FileStorage (`workato_files`), Email (`email`), HTTP (`rest`), SaaS connectors by their catalogue id. Custom connectors (customer-only): customer build uses the real connector + actions; trial build swaps each step for `STAND-IN for <connector>.<action> — checked in the customer workspace only` at the same position; an automatic diff allows only those swaps. The catalogue (export from the target workspace) lives in `factory/writers/workato_providers.json`; anything not in it fails the build.

## 5. Data / stored procedures
JDBC has **no** stored-procedure action. Functions: `SELECT pkg.fn(?) FROM DUAL`. Procedures with OUT params: one `run_custom_sql` with an Oracle 12c+ `WITH FUNCTION` wrapper, `PRAGMA AUTONOMOUS_TRANSACTION` (comment: changes commit independently — customer to confirm), OUT values joined with `~^~`; next step splits on the **first** `~^~` with a missing-separator guard; DATE params bound as dates (`TO_DATE` format flagged as assumption); types/order from the field rows; "verify against the package spec". Different shape from the design → README "Deliberate changes".

## 6. Error handling
none → no try (API recipes too: a failing step fails the job and the API answers HTTP 500) · alert-then-fail → `try` around body; catch: truncate (if source does) → alert system → `stop` with error · report-and-continue → `try` inside the `foreach`; catch alerts, no stop. Truncation (truncateStringMiddle 2000) = first 1000 + "..." + last 997.

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
Verified on a real Workato trial by import + start check (2026-11-28):
- Recipe functions: `execute`, `return_result`, `call_recipe` (`call` is rejected). `return_result.result` and `call_recipe.parameters` must not be blank.
- SFTP: `dir` input `directory`, output list `entries`; `streamable_download` input `filename`, output `contents`; `rename` inputs `from` / `to`.
- FileStorage `store_file`: inputs `file_name`, `file_path`, `content`. Email `send_mail`: `to`, `subject`, `body` (not `message`).
- JDBC `run_custom_sql` has no static output: declare `extended_output_schema` (`rows`, array of the selected columns); then `rows` / `rows.first.COL` are valid.
- Project properties: formula mode `=account_property('k')` is rejected ("expression is unsafe", also with `.presence`, `.to_i`, `==`); use text interpolation `#{account_property('k')}`, and compare a text-mode copy in IF conditions.
- Connection names are unique per workspace: re-import into the same folder (updates in place); a second folder with the same connection names is refused.
- A field-name probe (one recipe referencing each candidate datapill, then start check) settles unknown names without a sample export.
- A "success" start can be hollow: check the recipe still has its real steps (a writer that replaces a blank-input action by a TODO starts cleanly).
Added 2026-11-28 (wk6):
- Kafka names from the exported catalogue (`workato_catalogue.json`, GET /api/integrations on the trial): provider `kafka` ("Apache Kafka"), actions `publish_to_topic`, `publish_to_topic_batch`, triggers `new_message`, `new_message_v2`, `new_message_batch`, `new_message_batch_v2`. `publish_message` (used before by the webMethods path) is not a Workato name. Input field names (`topic`, `key`, `value`) are not in the catalogue: UNVERIFIED until a Kafka connection exists.
- The event system's product decides the connector, in the writer and in the gates alike (Connections: Kafka needs a `kafka` connection, Event Streams none; Topic files: Kafka → no topic files and every Kafka topic named in the spec; Recipe triggers: Kafka → `kafka.new_message`).
- Inside a record loop a field of the iterated select is the loop item (`foreach` datapill), never `rows.first` of the select (the supplier publish sent the first row of the batch for every row).
- An HTTP alert API's endpoint is an Operations row named as an outbound call ("calls POST /alerts on OpsAlert"): a call step, not an API-platform endpoint, in the writer and in the Triggers gate.

- Trial start check (2026-11-28, no Kafka connection): `kafka.new_message` requires "Group ID" (input `group`) and "Message schema" (input `workato_schema_id`); `kafka.publish_to_topic` requires "Message schema" (`workato_schema_id`). The writer reads the group from an environment property (value unset); the schema is a workspace object, chosen after import (README line per topic) - the recipe does not start while it is blank.
- An unconnected connection gives `success: false` with `config_errors` `[step, [["account_id", <id>, "unconnected", …]]]`; `code_errors` are still reported for other steps (required fields, unknown datapills), so a start check without connections still finds field errors.
- Test run API: `POST /api/recipes/:id/test` exists (400 "Recipe is running. Stop it before starting a test run" while running; stopped -> 202 `{"status": "IN_PROGRESS"}` and the recipe reports `running: true` until `PUT /stop`); `GET /api/recipes/:id/test` gives the state. A recipe-function test run waits for a call: no job is produced without a caller. `POST /recipes/:id/run` and `/jobs` -> 404 "API not found".
- Verifier findings (2026-11-28): a wrapper rule ("Oracle OUT parameters are captured through SQL wrappers") written under one feature applies to every procedure with OUT parameters - cwPOValidation / cwTerminationUpdate were plain `BEGIN … END` blocks returning null while RU8 counted as carried. The Procedure SQL gate now reds a plain block when such a rule exists, an input the requirements name ("Called with P_A, P_B") that the database call never binds (GreenLeaf P_AMOUNT), and a recipe-function result that is always null next to a database call.
- A function's output keeps the name the requirements give ("returns one field 'count'"), quoted in Oracle SQL (`AS "count"`): an unquoted alias comes back upper-cased.
