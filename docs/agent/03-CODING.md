# 03 — Coding standards (every agent that writes code or config)

The factory's output is code someone else will run, read and maintain. These rules apply to every target (generated recipes/processes are code too).

## 1. Before writing anything
1. **Read the existing code first.** Find the conventions (language version, framework, folder layout, naming, test style, lint rules, commit style) and follow them. Existing conventions beat every default in this knowledge base.
2. **Know the acceptance criteria.** Write down what "done" means (which tests, which gates, which behaviour) before the first edit.
3. **Find the smallest change that does the job.** Don't refactor unrelated code; don't add features nobody asked for.
4. **Check the target's real API/catalogue** for every library call, connector action or platform construct you plan to use. If you can't confirm a name, don't guess — look it up in the installed package, the vendor's docs or a platform export.

## 2. Writing code
- **Correct first, then clear, then fast.** Optimise only with a measurement.
- **Small units:** one function = one job; files grouped by feature/unit, not by technical layer, unless the project already does otherwise.
- **Names say what things are** in the business's words (from the spec), not `data2`, `tmp`, `handleStuff`.
- **Types everywhere** the language allows (TypeScript strict, C# nullable enabled, Python type hints). No `any`/`object`/`dynamic` at system boundaries.
- **Validate at the edges** (incoming requests, messages, files, config) against schemas derived from the spec; trust validated data inside.
- **No hidden behaviour:** no global mutable state, no side effects in getters/constructors, no magic strings — constants and config keys are named.
- **Errors:** typed errors with context (unit, item id, rule id); never swallow an exception; never `catch` just to log and continue unless the spec's error mode says continue (core §8.4).
- **Config and secrets:** every value that differs by environment is config; secrets only from the secret store; never in code, tests, logs or commits.
- **Time, money, text:** time zones explicit (store UTC, convert at edges as the spec says); money as decimal/minor units, never float; text as UTF-8; culture-invariant parsing.
- **Idempotency:** anything triggered by events, schedules or retries must be safe to run twice (dedup key from the spec).
- **Dependencies:** prefer the platform/standard library; add a package only when it saves real work, is maintained, licence-compatible, and pinned. Record why in the commit.
- **Comments explain why, not what.** Every generated unit carries a header: source trace (document/section or file:line), rule IDs implemented, deliberate changes.
- **No placeholders that pretend to work.** A stub throws/fails loudly with "TODO <rule id>: <original text>". Never return fake data, never leave empty URLs or dead branches.

## 3. Generated code specifically
- Generators produce code a human would write: formatted (prettier/dotnet format/black), linted, no duplicated blocks — shared logic goes into one helper the units call.
- Deterministic output: same spec → byte-identical package (sorted keys, stable ids), so diffs show real changes.
- Every generated artifact is traceable back to spec IDs; every spec ID forward to an artifact or a reasoned TODO (rule accounting).

## 4. Testing
- **Test behaviour, not implementation:** one test per rule and per error row, plus edge cases (empty, null optional fields, max sizes, duplicates, time-zone boundaries).
- Arrange-act-assert; descriptive test names in business words ("rejects supplier without vendor number").
- Fakes for external systems in unit tests; real dependencies via containers in integration tests where possible.
- A bug fix starts with a failing test that reproduces it.
- Never weaken, skip or delete a test to make a build green. If a test is wrong, fix it and say why in the commit.
- Coverage is a hint, not a goal; business logic and error paths must be covered.

## 5. Running and verifying
- Build, lint, type-check and the **full** test suite before every commit. Red = not done.
- Run what you changed: start the service/import the package/launch the app and exercise the changed path. A passing unit test is not proof the thing runs.
- Read the actual output of commands; don't assume success from exit codes alone when logs show warnings or skipped steps.
- When a command fails: read the error, find the root cause (not the symptom), fix, re-run the exact failing command, then the full suite.

## 6. Version control
- Conventional commits (`feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`), one logical change per commit, message says what and why.
- Tag before high-risk changes (data migrations, auth, payments, generator rewrites) so rollback is one command.
- Never commit secrets, customer documents (outside private fixtures), build outputs or local env files.
- Never force-push over shared history; never rewrite published commits.

## 7. Security baseline
- Least privilege for every credential/scope/ACL.
- Parameterised queries only — never string-concatenated SQL (bind values even for literals like 'NEW').
- Verify webhook/signature HMACs; validate redirects; escape output in web UIs.
- Dependency audit in CI (npm audit / dotnet list package --vulnerable / pip-audit); no known critical vulnerabilities shipped.
- Untrusted archives: unpack into an empty folder, never execute contents; run scripts that read them with isolated interpreters.

## 8. Performance and reliability
- Timeouts on every network call; retries only where the spec says, with back-off and a cap; loops always have an upper bound.
- Stream large files/datasets; batch database writes; paginate APIs.
- Log with a correlation id per job/request; no PII or secrets in logs.

## 9. Reviewing code (including your own output)
Check, in order: does it meet the acceptance criteria → is anything invented that the spec doesn't say → error handling matches the spec → tests prove each rule → no secrets/placeholders → readable by the next person. Report findings with file:line, the concrete failure scenario, and the fix.

## 10. When stuck
- Two failed attempts at the same approach → stop, re-read the error and the docs, try a different approach.
- Missing credential, paid service, destructive action, or a business fact only the customer knows → prepare everything else and escalate that one item (core §12).
- Never "make it pass" by deleting checks, mocking the thing under test, or hard-coding expected values.

## 11. Lessons
1. A generator passed its own format check while producing 96% log-only steps → behaviour checks are part of "tests pass".
2. A guessed platform action name (`call`, `execute_stored_procedure`) failed on import → confirm names against the target catalogue before use.
