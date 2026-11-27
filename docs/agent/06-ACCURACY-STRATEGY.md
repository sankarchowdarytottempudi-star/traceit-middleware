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

## 5. Human-confirmed middle step
The review workbook stays mandatory between reading and building. The reader pre-fills it as completely as possible (adds, deletes, answers) so the human only confirms; "human edits needed" (§1) is the measure to drive down.

## 6. Independent cross-checking
Three roles per job: **builder**; **verifier** that sees only the source + package (not the builder's reasoning) and lists mismatches with evidence; **arbiter** that resolves disagreements against the source. The verifier's findings are scored on the benchmark too.

## 7. Learning memory
- Lessons sections (every file) + a test per lesson.
- **Pattern library** `factory/patterns/<target>/<pattern>.json`: proven, imported-and-tested solutions (e.g. "Oracle OUT-param procedure on Workato", "alert-and-continue loop on Boomi", "keyed ordering on Kafka"). Writers reuse patterns before generating new shapes; a pattern is added only after it passed import + tests.
- Correction log: every reviewer change and every fixed error stored with before/after → training data (§10).

## 8. Better reading
Layout-aware PDF reading (tables, numbered steps), DOCX tables, per-platform legacy readers (02-SOURCES §3), and cross-checking document vs legacy code when both exist (disagreements → open questions). Reader scores (recall/precision) on the benchmark.

## 9. Searchable platform documentation (self-hosted)
Index official docs/references for every target plus the pattern library into a local vector + keyword index. Writers and fixers query it before using an unfamiliar construct and cite the doc id in the step comment. Refresh on platform version changes.

## 10. Fine-tuning (only after data exists)
When ≥ 50 reviewed migrations exist: build a dataset from (source, gold workbook) and (spec, corrected package, fixed errors) pairs; fine-tune the self-hosted open model (e.g. LoRA) for reading and writing; accept only if benchmark scores improve with no regression. Data never leaves the servers.

## 11. Honest reporting
Verdict first; "Not ready — waiting on N answers"; "not provable in this environment" list; numbers from the benchmark and gates, never adjectives.

## 12. Lessons
1. Trial-import checks caught invalid names (`call`, `execute_stored_procedure`) that reading alone missed → §3 and §4.
2. An independent reviewer caught a misclassified rule, a missing pragma and wrong error modes → §6.
