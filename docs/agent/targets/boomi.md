# Target: Boomi (AtomSphere / Integration)

## 1. What it is / artifacts
Components built in AtomSphere and deployed as packaged components to Atoms/Molecules/Clouds: **processes** (made of shapes), **connections** + **connector operations**, **profiles** (JSON/XML/DB/flat file), **maps** (+ map functions), **process properties / dynamic process properties / document properties**, **cross-reference tables**, **environment extensions**. Created via the Platform API (Component CREATE with Boomi's accepted XML shapes). One unit = one process (sub-processes for callable units).

## 2. Neutral → Boomi shapes
| Neutral | Boomi |
|---|---|
| flow.call | **Process Call** shape (sub-process; "wait for process to complete" as the source) |
| respond | **Return Documents** (sub-process) / response from Web Services Server listener |
| http.request | HTTP Client connector operation (method, path, profile) |
| db.query/write/procedure | Database connector operation (Get/Send; stored procedure supported in DB profile) |
| transform.map | **Map** shape (+ functions, scripting only when needed) |
| logic.choice | **Decision** / **Route** shape |
| logic.loop | documents flow per record; **Flow Control** (run each document individually) |
| logic.validate | **Business Rules** shape / Cleanse |
| event.publish | Kafka/JMS/Event Streams connector operation |
| file.* | Disk / FTP / SFTP connector operations |
| notify.email | Mail connector / **Notify** shape (for alerts in process reporting) |
| error.raise | **Exception** shape |
| set variables | **Set Properties** shape (DPP/process properties) |
| end | **Stop** (continue = true/false), **Return Documents** |

## 3. Triggers
schedule → deployment schedule on the process (set via Atom Management / Platform API `ProcessSchedules`) · HTTP → **Web Services Server** connector (listen) start shape, path from Operations rows · event/queue → listener start shape (JMS/Kafka/Event Streams listen) · file → connector listen / scheduled poll · callable → start shape "Data Passthrough" sub-process.

## 4. Systems/connectors
Connector by system type (Database, HTTP Client, SFTP, Kafka, Mail, Salesforce, NetSuite, Shopify…). Connection components hold endpoints with values overridable through **environment extensions** per environment; secrets as extension-protected fields.

## 5. Data / stored procedures
Database profile of type stored procedure with IN/OUT parameters mapped from the source signature; result sets as profile elements. Batch size / commit options as the source specified.

## 6. Error handling
none → no Try/Catch; process errors propagate to the caller (Process Call fails) · alert-then-fail → **Try/Catch** around the main branch; catch path: truncate (if source) → alert system call → **Exception** shape · report-and-continue → Try/Catch scoped per document (Flow Control: each document individually), catch alerts and continues (no Exception). Retry only if the source retried (Try/Catch retry count).

## 7. Config
Process properties with defaults; environment extensions for connections, properties and cross-reference tables per environment; no credentials in components.

## 8. Packaging / deploy / start
Create components via Platform API (print Boomi's own error text, resume after last created). Create **packaged components** and **deploy** to the target environment; attach schedules/listeners. Start check: deployment succeeds; listeners show as listening; test-mode run of each process passes.

## 9. Tests
Test-mode executions with sample documents per rule/error row; Boomi process reporting checks; listener tests via HTTP calls.

## 10. Target gates
Every component created and packaged · every shape's referenced operation/profile/map exists · schedules match the spec · Try/Catch shape matches the error mode · no empty connection URLs · environment extensions declared for every environment-specific value.

## 11. Traps / confirm first
Component XML must match shapes Boomi's CREATE accepts — learn new types by creating a probe in a scratch folder and reading back · document vs process property scope · Flow Control changes error scope · listener processes need Web Services Server enabled on the Atom · licence counts per connector (money → human).

## 12. Lessons
- Component CREATE: write accepted shapes; resume after the last created component on failure.
