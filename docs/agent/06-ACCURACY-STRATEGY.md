# 06 — Accuracy strategy: beating general-purpose coding agents on migrations

General agents (Codex, Claude Code, OpenAI agents, website builders) start every job from scratch, guess platform names, and stop when the code "looks right". The factory wins on its own job by carrying structure, ground truth and verification they don't have. Every lever below must show up as a number on the benchmark (§1).

## 1. Benchmark (build first)
- `bench/` holds cases: source (document and/or legacy code) + gold reviewed workbook + gold target package (or gold behaviour spec) per target.
- Start with the existing fixtures + synthetic cases; grow to 20–30 per target family. Customer cases stay private; comparisons with external tools use anonymised/synthetic cases only.
- Scores per case and target:
  | Score | Meaning |
  |---|---|
  | Item recall / precision | gold items found / items found that are real |
  | Invented items | endpoints, schedules, topics, names not in the source (target 0) |
  | Rule accuracy | rules built correctly vs gold (built / carried / no-step / TODO) |
  | Error-mode accuracy | units with the right mode |
  | Valid-name rate | platform names that exist in the catalogue (target 100%) |
  | Import/start rate | units that deploy and start |
  | Test pass rate | generated tests passing |
  | Human edits needed | cells changed by the reviewer in the workbook |
- `python3 -m factory bench [--target t]` prints a scoreboard and writes `bench/results/<date>.json`. CI fails on any regression versus the last accepted result.
- Baseline: run the same anonymised cases once through general agents, by hand, and record their scores for comparison.

## 2. Deterministic first, AI second
Everything that can be decided by rules is code, with tests: extraction, noise filter, intake routing, workbook validation, unit segmentation of known shapes, rule routing, connector-by-system-type, procedure-wrapper SQL, cron conversion, error-mode shapes. The model is called only for interpretation (unusual phrasing, ambiguous mapping) and its output is validated against schemas before use. Track "share of decisions made by rules" per run.

## 3. Catalogues as ground truth
Per target, `factory/writers/<target>_catalogue.json` exported from the real platform (connectors/actions/fields, component types, connector versions, API versions, package names + versions). Writers may emit only catalogue names; field names inside actions come from exported sample recipes/components. Catalogues are refreshed by a script and versioned.

## 4. Build → run → fix loop (automatic)
After generation: deploy/import into a sandbox → start → run tests → parse errors → map each error to the step that caused it → fix (rule first, model second) → retry, up to N rounds. Stop with an honest "Not ready" listing the remaining errors.
| Target | Sandbox |
|---|---|
| Node.js, .NET, WSO2 MI, Kafka | Docker / Testcontainers on the server |
| Workato, Boomi, Shopify | trial/sandbox accounts via their APIs (credentials from the vault) |
| React Native / web | simulators/emulators + Playwright/Maestro |
Every fixed error becomes a rule or a lesson so it never needs fixing twice.

Implemented in `factory/loop/` (`python3 -m factory run <package> --target nodejs|dotnet|wso2_mi|kafka [--rounds N]`):
- Sandboxes run in limited `fb-*` containers (2 CPUs, 3 GB; installs and compiles under the shared heavy-build lock).
  Code targets follow the package's own Dockerfile (build stage RUN lines, then the final stage's image, files, user
  and command) instead of `docker build`, so the limits hold; the generated tests run in the build image.
- Stand-ins from the neutral model: Oracle (gvenzl/oracle-free) or PostgreSQL with the spec's tables (columns from the
  data stores plus the columns the spec's own SQL names), redpanda (Kafka API + Schema Registry, auto-create off,
  topics from the spec), a tiny HTTP stand-in. Procedures are never stood in (their body is the customer's).
- Start = the service answers HTTP, consumers are Stable in their groups on the broker, and one smoke call per HTTP
  unit answers a status the OpenAPI (or the neutral model) declares — never a 5xx and never the framework's
  unknown-route answer.
- Errors are parsed per tool (npm, tsc, vitest, MSBuild/NuGet, TRX, start-up logs, MI deployers, SQL parse on the
  database stand-in) and mapped to unit / step / file; fixer rules (`factory/loop/fixers.py`, one test each in
  tests/test_loop.py) are applied, then the next round. No rule = stop with "Not ready" and the remaining errors.
- The model hook is off by default and calls only a self-hosted model at a local MODEL_URL; its answer is a
  suggestion in the report, never applied.
- `run-report.json` per unit: built, started (with evidence), tests passed / failed, errors, fixes; the bench reads
  import/start and test pass rates from it (`--loop gold|all|off`; without Docker "n/a — not run").

## 5. Human-confirmed middle step
The review workbook stays mandatory between reading and building. The reader pre-fills it as completely as possible (adds, deletes, answers) so the human only confirms; "human edits needed" (§1) is the measure to drive down.

## 6. Independent cross-checking
Three roles per job: **builder**; **verifier** that sees only the source + package (not the builder's reasoning) and lists mismatches with evidence; **arbiter** that resolves disagreements against the source. The verifier's findings are scored on the benchmark too.

Implemented in `factory/verify/` (rules only; optional self-hosted note via `MODEL_URL` + `--model`, never changes a verdict):
`python3 -m factory verify <pkg> --source <doc-or-workbook> [--target t]` → `verify-report.json` (units missing/extra, invented endpoints/schedules/topics/systems, rule key values missing, calls missing, error mode per unit, alert routing — each with source quote + package file/step);
`python3 -m factory arbitrate verify-report.json --source …` → `arbitration.json` ("builder right" / "verifier right" / "source silent → open question", with the quote).
Bench: `verify_recall` (seeded defects reported: drop a unit, invent an endpoint, change a threshold, flip an error mode, route an alert to e-mail) and `verify_fp` (clean-package findings the gold does not confirm) on the gold-input package of workato / nodejs / dotnet.

## 7. Learning memory
- Lessons sections (every file) + a test per lesson.
- **Pattern library** `factory/patterns/<target>/<pattern>.json`: proven, imported-and-tested solutions (e.g. "Oracle OUT-param procedure on Workato", "alert-and-continue loop on Boomi", "keyed ordering on Kafka"). Writers reuse patterns before generating new shapes; a pattern is added only after it passed import + tests.
- Correction log: every reviewer change and every fixed error stored with before/after → training data (§10).

## 8. Better reading
Layout-aware PDF reading (tables, numbered steps), DOCX tables, per-platform legacy readers (02-SOURCES §3), and cross-checking document vs legacy code when both exist (disagreements → open questions). Reader scores (recall/precision) on the benchmark.

## 9. Searchable platform documentation (self-hosted)
Index official docs/references for every target plus the pattern library into a local vector + keyword index (today keyword-only: `python3 -m factory docs search "<query>" [--target t]`, `docs refresh`; Lessons 5). Writers and fixers query it before using an unfamiliar construct and cite the doc id in the step comment. Refresh on platform version changes.

## 10. Fine-tuning (only after data exists)
When ≥ 50 reviewed migrations exist: build a dataset from (source, gold workbook) and (spec, corrected package, fixed errors) pairs; fine-tune the self-hosted open model (e.g. LoRA) for reading and writing; accept only if benchmark scores improve with no regression. Data never leaves the servers.

## 11. Honest reporting
Verdict first; "Not ready — waiting on N answers"; "not provable in this environment" list; numbers from the benchmark and gates, never adjectives.

## 12. Lessons
1. Trial-import checks caught invalid names (`call`, `execute_stored_procedure`) that reading alone missed → §3 and §4.
2. An independent reviewer caught a misclassified rule, a missing pragma and wrong error modes → §6.
3. A verifier that reads the builder's files or the generated header comments ("Error mode: alert_then_fail", "Rules: RU8 built") agrees with the builder by construction → it reads only the source and the delivered artifacts, comments and Workato `comment` fields stripped; a test fails if `factory/verify` imports the builder or opens spec/neutral/rule-accounting/steps/log files.
4. On packages whose gates were green the verifier still found real gaps: a procedure parameter never bound, a function output not named as the source says, an OUT-parameter wrapper the source requires, an alert call the source gives but the package never makes → run the verifier on every package before "Ready".
5. A value that exists only inside a TODO message is not implemented → the verifier ignores TODO throws / TODO log steps, and the seeded "change a threshold" defect only touches values the verifier can see (else it is n/a, not a free hit).
6. Examples ("e.g. 500"), platform versions ("Oracle 12.1+"), alternatives ("A or B") and absence rules ("not migrated") are not key values → without these rules they were false positives.
7. Seeded-defect scoring compares findings by kind + unit + value + what was found: a TODO alert and an e-mail alert in the same unit are different findings (keying by kind + unit hid the e-mail mutation).
8. A shared rule that names several units is checked in each of them (01-CORE §8.3); where the gold files it under one unit the others count as false positives — reported as such, not tuned away.
9. Pattern library seeded only from shapes with proof (§7): `factory/patterns/<target>/<name>.json`, admitted when `proven_by.import` and `proven_by.tests` are true with evidence of those kinds (trial start in a target file's Lessons, a build report, a test id that exists); the loader refuses anything else and `tests/test_patterns.py` fails on it. Writers ask `pattern_for(target, problem)` (factory/writers/base.py) and keep their own literal as the fallback, so the Workato procedure wrapper reads separator/pragma/OUT type from the pattern with byte-identical output (golden test). Not admitted for lack of proof: Boomi, WSO2, Mule, webMethods, Kafka and Shopify shapes (never imported or run here), Workato stand-in custom connector (proved only by the build diff, not a start).
10. Correction log (§7): `factory/corrections_log.py` appends to data/private/corrections.jsonl (git-ignored; `FACTORY_CORRECTIONS_LOG=<path>|off`). `requirements read` of a reviewed workbook and `requirements apply` record every changed cell (before/after, sheet, row id), diffed against the reader's pre-filled workbook when it is still in the output folder; the build-run-fix loop calls `record_fix(error_text, step, fix_rule, ...)` (error text hashed with paths/numbers normalised). Tests switch it off.
11. Docs index (§9) is keyword-only BM25 in pure Python (`factory/docsindex/`): no self-hosted embedding model is installed on the factory server (no sentence-transformers/numpy, no local model directory), so the vector layer is reported as not available instead of calling any external embedding API. Corpus: docs/agent/** by section, the admitted patterns, and whatever is placed by hand under data/platform-docs/<target>/ (git-ignored; `docs refresh` indexes it, nothing is downloaded). `cite(query, target)` gives the doc id for a step comment; the Workato procedure comment cites it only with `FACTORY_DOC_CITES=1` (off by default, output unchanged).
12. Fine-tuning prep (§10) builds pairs only: `finetune build` writes reading (source → gold workbook) and writing (spec → gold behaviour + fixed errors) pairs under data/private/finetune/ from the public bench cases and the correction log; bench/private and other projects' log records need `--include-private` (aliased, output still private). Today: 7 public cases → "not enough data: 7 of 50"; no training until the threshold is met. "Share of decisions made by rules" (§2) was already on the scoreboard as the reader's `rules%` column.
13. The first loop runs on GreenLeaf found what reading and static gates missed: an MI mediator that the runtime
    version did not know, an upsert with an empty SET clause (Oracle rejected the parse), HTTP rejections that answered
    202 instead of 400/404, and missing connector libraries → writer fixes with tests, and SQL is parsed on the
    database stand-in every run.
14. A smoke 404 can be the framework saying "no such route" → every smoke answer is compared with the answer to an
    unknown route; only a different answer counts as the unit answering.
15. Spec SQL texts carry prose ("INSERT INTO READINGS (DEVICE_ID, TS, VALUE) for each reading"); taking every word as a
    column made the stand-in table invalid and the whole start stage did not run → columns only from the INSERT list,
    the SELECT list and the left side of comparisons; a failed smoke call carries the service's own log lines of that
    call (e.g. "TODO RU1: db.query ... only Oracle clients are generated for Node.js so far").
