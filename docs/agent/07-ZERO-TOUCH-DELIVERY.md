# 07 — Zero-touch delivery: from finished migration to "deploy and test"

## 1. Target experience
After a migration the user does only five things:
1. **Provide credentials** (wizard, §4).
2. **Answer open questions** (portal, §5).
3. **Press Deploy** (one command / one button, §3).
4. **Read the test report** (§6).
5. **Approve go-live** (§9).
Everything else is the factory's job. Any other manual step found in a real delivery is a defect: log it as a lesson and automate it.

## 2. Parity testing against the legacy system (strongest proof)
- **Capture:** record real inputs/outputs from the legacy system where allowed (HTTP requests/responses, messages on topics/queues, files in/out, DB rows before/after) for a representative period. Mask PII per policy.
- **Replay:** run the same inputs through the new build in the sandbox.
- **Compare:** field-by-field diff with rules for expected differences (timestamps, ids, ordering where not guaranteed, "Deliberate changes from the source").
- **Score:** parity % per unit; every mismatch is either a bug (fix + test) or a documented deliberate change. Target 100% explained.
- If capture isn't possible, build golden cases from the document's examples and the legacy code paths.

## 3. One-command deploy, promotion, rollback
- Per target, infrastructure/config as code (Terraform/Helm/K8s manifests, platform APIs for Workato/Boomi/Shopify, EAS for mobile).
- `factory deploy --env dev|test|prod`: provision → deploy/import → configure properties → start → smoke test → report. Fails closed and rolls back automatically on a failed smoke test.
- Promotion copies the exact tested build (same hash) between environments; only environment config differs.
- Rollback = one command to the previous build; tested in CI.

## 4. Onboarding wizard and pre-flight
- Collects per environment: connections (host, port, account), credentials (straight into the vault — never in files or chat), properties (every key in the spec), target accounts/licences.
- **Pre-flight check before building:** every connection tested (DB login + a harmless query, SFTP list, topic access, API ping); target catalogue refreshed; licences/limits checked; missing items listed in plain language with who must provide them.
- Re-runnable; shows green/red per item.

## 5. Open-questions portal and auto-rebuild
- Each open question shown to its owner (customer, SME, DBA) with context, options and the default the factory will use if accepted.
- Answers write back into the review workbook (as `change`/answers), trigger `apply` → regenerate → checks → tests automatically, and notify the user with the new report.
- Blocking vs non-blocking clearly marked; deploy to prod is disabled while blocking questions remain.

## 6. Tests the business can read
- Generated per unit: technical tests (CI) + **UAT scripts** for business testers (step, input, expected result, pass/fail box) derived from rules and error rows.
- **Simulators** for external systems built from their contracts (DB schema, SFTP folders, topic schemas, API specs, custom connector actions) so the full suite runs before customer systems are connected; then a short smoke suite against the real systems.
- Report: verdict, pass/fail per unit and rule, parity %, what wasn't testable and why — in plain language (05-RESPONSE-QUALITY).

## 7. Change without rework
- Re-reading an updated document produces a **diff of items**; only affected units regenerate.
- Manual edits in generated code/recipes live in marked protected regions or override files and survive regeneration; conflicts are reported, never overwritten silently.
- Every build carries the source version, workbook version and spec hash.

## 8. Operate: monitoring and runbook
- Auto-configured monitoring per unit (in TraceIT or the target's monitoring): run success/failure, latency, backlog/lag, error alerts routed to the right team.
- Generated runbook: for each unit, what it does, how to restart/replay, common failures and fixes, who to call.
- Post-go-live triage agent: groups failed runs, finds the cause, proposes a fix tested in the sandbox; a human approves before production.

## 9. Go-live (cutover) kit
- Data migration scripts (if any) with reconciliation counts.
- Parallel-run plan (old and new side by side, compare outputs for N days) where the customer allows.
- Cutover checklist with timings, switch steps, verification, and a tested rollback.
- Go-live approval is the user's single click after the report is green.

## 10. Hand-over pack (generated)
Architecture diagram, unit catalogue, connections/properties list, deliberate changes, open questions log with answers, test evidence (reports, parity), runbook, sign-off sheet.

## 11. The tool's own screen
Migration Tool flow on one screen: Upload → Review → Answer → Build → Deploy → Test → Sign off. A single status bar says what's done, what's running, and what is waiting on whom. Every step is resumable.

## 12. Gates for "ready to deploy"
| Gate | Pass |
|---|---|
| All 01-CORE §10 + target gates | green |
| Pre-flight | every connection and credential green |
| Blocking questions | 0 |
| Simulator test suite | green |
| Parity | 100% matched or explained |
| Deploy dry-run | succeeds; rollback tested |
| Hand-over pack | generated, complete |

## 13. Training the delivery agents
- Delivery fixtures: a full delivery per target family (spec → deploy → test → report) in the bench (06 §1), with scores for deploy success, rollback success, parity %, manual steps counted.
- Every manual step a user had to do in a real delivery becomes a bench case and a lesson.

## 14. Lessons
1. (Add from the first zero-touch delivery.)
