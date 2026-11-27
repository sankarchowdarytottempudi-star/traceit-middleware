# Migration Factory — Agent Knowledge Base

The factory turns **any source** (business documents, or an existing middleware / web / mobile system) into **any target** (middleware platform, code service, event platform, commerce platform, web app or mobile app) that builds, deploys, starts and passes its tests.

## Files

| File | Read it when |
|---|---|
| `01-CORE.md` | Always. Behaviour, pipeline, review workbook, neutral model, quality gates, reporting, data rules. |
| `02-SOURCES.md` | Always. How to read each kind of input (documents and legacy systems). |
| `03-CODING.md` | Always, for any agent that writes code, config or generated packages. |
| `04-UNDERSTANDING-REQUESTS.md` | Always, for any agent that talks to users or reads their messages and pasted material. |
| `06-ACCURACY-STRATEGY.md` | Builders of the factory itself: benchmark, deterministic-first, catalogues, build-run-fix loop, cross-checking, pattern library, docs index, fine-tuning. |
| `07-ZERO-TOUCH-DELIVERY.md` | Delivery agents and the tool UI: parity testing, simulators, one-command deploy/rollback, onboarding wizard, questions portal, change without rework, runbook, cutover, hand-over pack. |
| `08-COMPLETE-INPUTS-AND-RELEASE.md` | Day-1 evidence request, read-only verification against real systems, per-unit ready-to-build check, customer profile, guided UAT and production release. |
| `05-RESPONSE-QUALITY.md` | Always, for any agent that replies or reports: answer every question (new, repeated, missed, unknown) in sophisticated, correct English. |
| `targets/workato.md` | Target is Workato |
| `targets/wso2.md` | Target is WSO2 Micro Integrator / API Manager |
| `targets/boomi.md` | Target is Boomi |
| `targets/nodejs.md` | Target is a Node.js (TypeScript) service |
| `targets/dotnet.md` | Target is a .NET (ASP.NET Core) service |
| `targets/kafka.md` | Target is Kafka (event backbone, Connect, consumers/producers) |
| `targets/shopify.md` | Target is Shopify (store, app, integrations, data migration) |
| `apps/react-native.md` | Target is a React Native mobile app |
| `apps/web-mobile-migration.md` | Any web ↔ mobile migration (web → mobile, mobile → web) |

## How agents use it

1. Read `01-CORE.md`, `02-SOURCES.md`, `03-CODING.md`, `04-UNDERSTANDING-REQUESTS.md` and `05-RESPONSE-QUALITY.md`.
2. Read the one target file for the chosen target (two when a migration spans two, e.g. Kafka + Node.js consumers).
3. Never contradict the core. A target file only adds; if a target rule seems to conflict with the core, the core wins and the conflict is logged in `01-CORE.md` section 14.

## Install (IDE Claude)

Put this folder at `docs/agent/` in the factory repo and add to `CLAUDE.md`:

```
Every factory agent reads docs/agent/01-CORE.md, 02-SOURCES.md, 03-CODING.md and
04-UNDERSTANDING-REQUESTS.md and 05-RESPONSE-QUALITY.md, then the target file(s)
for the job, before any work. New lessons go into the matching file's "Lessons" section in the same
commit as the fix.
```

## Adding a new target

Copy any target file, keep the 12 headings (the "target template" in `01-CORE.md` section 9), fill each one, and add the target's fixtures to the regression corpus. A target without fixtures and green gates is not "supported".
