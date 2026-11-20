# Production lessons (applied by default)

Owner request, 2026-11-20: every API migrated to WSO2 (Ballerina) and every new low-code flow
must keep these practical issues and their fixes in mind. The machine-readable source is
`lessons.json` next to this file (ids, incidents, detection, default fix, tests, check ids).
Everything is deterministic: fixed rules, no model.

| Id | Lesson | Incident | Generator | Readiness check | Factory flows |
|----|--------|----------|-----------|-----------------|---------------|
| L1 | Reuse downstream sessions/tokens | 10 parallel Seaware logins, 2.5-4.6 s each, one 36 s timeout | session reuse for setting-only logins; TODO + warning for per-user logins | `L1.login-per-request`, `L1.login-in-loop` | warns on login in a loop / per request |
| L2 | Share identical in-flight reads, cache short-lived reads | CMS / cabin-price 3x parallel hits; stuck in-flight mark; `Kept & readonly` literal NPE | `lessonsCall` read mode on `commons:SharedCache` (off by default), expiring marks, no error caching, `.cloneReadOnly()` | `L2.read-not-shared`, `L2.readonly-literal`, `L2.inflight-no-expiry` | "Cache answer for N seconds / share identical calls" (off) |
| L3 | Background side effects | sign-in waited 5.4 s for the e-mail | unused notification sends go `start` with retries + error log | `L3.notify-blocks-answer` | "Send in background (don't wait)" |
| L4 | Explicit timeouts, idempotent-only retries, bounded fan-out | 60 s waits, retry risk on writes | explicit `timeoutSeconds` (20 s), GET-only retries 1 s/3 s, reused URL clients | `L4.no-timeout`, `L4.timeout-too-long`, `L4.retry-non-idempotent`, `L4.unbounded-fanout` | timeout default, retries only for idempotent/with key |
| L5 | Probes and rollouts | 1 s liveness killed services all night | no probe values written (chart defaults) | `L5.*` on per-service values | n/a |
| L6 | started/finished + backend timing + correlation | could not find unanswered calls | request/backend logs with `durationMs`, correlation header | `L6.no-duration-log`, `L6.no-correlation` | runtime step logs |
| L7 | Zoho specifics | "" rejected, 57-field search, .sa vs .in 401, prefix, duplicates | `lessonsDropEmpty` for Zoho bodies; search/insert findings | `L7.*` | Zoho connector rules |
| L8 | Config correctness | undeclared section, NodePort clash, wrong CMS host, TLS | only declared sections; explicit TLS/timeout | `L8.*` | n/a |
| L9 | Event idempotency/order | two identities for one message | TODO for consumers | `L9.event-no-idempotency` | event idempotency key |
| L10 | Ops safety (runbook) | VM overload 11-17/18 | n/a | `L10.pgrep-self-match` | n/a |

## Defaults the generator writes (section `[<org>.<pkg>.lessons]`)

| Setting | Default | Meaning |
|---|---|---|
| `outboundTimeoutSeconds` | 20 | timeout of ad-hoc URL clients; every backend also gets `timeoutSeconds = 20` |
| `retryDelaysSeconds` | [1, 3] | GET/HEAD/OPTIONS retried on connection errors and 502/503/504; others never |
| `shareIdenticalReads` | false | identical in-flight GETs share one backend call |
| `readCacheSeconds` | 0 | keep GET answers this long (0 = off); errors are never kept |
| `inflightMaxSeconds` | 30 | longest wait for an identical call (SharedCache waitSeconds); marks always released |
| `sessionReuseSeconds` | 240 | keep a setting-only (service-account) login this long (0 = off); dropped on 401/403/440 |
| `lessonsRedis` (section) | enabled = false unless the platform Redis is found | where shared reads/sessions live between copies |
| `backgroundSends` | true | notification sends whose result is unused run after the answer |

Switch the whole generator behaviour off with `MT_LESSONS=0`. Session reuse (L1) and shared/kept
reads (L2) are built on the framework's `commons:SharedCache` (`framework/integration-commons/shared_cache.bal`):
Redis between copies when `[<org>.<pkg>.lessonsRedis]` is on (the generator copies the platform Redis
address the state section uses), this copy's memory otherwise. The framework names the generated code
uses are in one place: `factory/lessons.py` (`FRAMEWORK_HELPERS`). L1 safety rule: share only the API's
own service/agent session, never a per-end-user one; the credential is part of the hashed key.

## Runbook (L10)

- Heavy builds/tests: `systemd-run --scope -p CPUQuota=100% nice -n 19 ionice -c3 <cmd>`; check
  `uptime` first and wait when the load average is above 20; not during working hours.
- No Playwright on the production VM.
- Never `while pgrep -f "<pattern>"`: the loop's own command line matches. Wait on a PID or `flock`.
- After Kubernetes/SQLite compaction, run the health check before continuing.
