// Production lessons the Factory applies by default (owner request, 2026-11-20). The catalogue
// itself is lessons/lessons.json (a copy of migration-factory/factory/lessons.json, the source of
// truth shared with the migration generator and the Migration tool). This module carries the part
// the canvas, the runtime and the validator need: check ids, fix texts and the fixed rules that
// recognise a login call, a notification send and an idempotent call. No model, no network.

export interface LessonCheck { id: string; lesson: string; title: string; fix: string; }

/** Check ids and fix texts; the test keeps them identical to lessons/lessons.json. */
export const LESSON_CHECKS: Record<string, LessonCheck> = {
  "L1.login-per-request": { id: "L1.login-per-request", lesson: "L1", title: "A login/token call runs on every request",
    fix: "Keep the session or token and reuse it until it expires (generated: lessonsCall session mode on the framework's SharedCache, lessons.sessionReuseSeconds). Share only the API's own service/agent account, never a per-end-user session." },
  "L1.login-in-loop": { id: "L1.login-in-loop", lesson: "L1", title: "A login/token call runs inside a loop or parallel branch",
    fix: "Log in once before the loop and pass the session to each item; or use the connection-level token." },
  "L2.read-not-shared": { id: "L2.read-not-shared", lesson: "L2", title: "Backend reads are neither shared nor cached",
    fix: "Set lessons.shareIdenticalReads = true and, for answers that may be a little old, lessons.readCacheSeconds (e.g. 60). Never cache writes or per-user answers unless the key includes the user." },
  "L3.notify-blocks-answer": { id: "L3.notify-blocks-answer", lesson: "L3", title: "The answer waits for an e-mail/SMS/notification send",
    fix: "Send it in the background after the answer (generated: lessonsBackground(...), Factory: 'Send in background'), with retries and a visible failure log." },
  "L4.no-timeout": { id: "L4.no-timeout", lesson: "L4", title: "An outbound call has no explicit timeout",
    fix: "Set timeoutSeconds for the backend (below the caller's timeout, e.g. 20 s when the gateway waits 30 s)." },
  "L4.timeout-too-long": { id: "L4.timeout-too-long", lesson: "L4", title: "An outbound timeout is not below the caller's timeout",
    fix: "Lower the backend timeout below the caller's (gateway) timeout so the service can still answer with a clear error." },
  "L4.retry-non-idempotent": { id: "L4.retry-non-idempotent", lesson: "L4", title: "A non-idempotent call is retried",
    fix: "Retry only GET/HEAD/OPTIONS (or calls with an idempotency key). Payment and booking calls are never retried." },
  "L4.unbounded-fanout": { id: "L4.unbounded-fanout", lesson: "L4", title: "Parallel calls to one backend are not bounded",
    fix: "Bound the parallel calls (e.g. at most 4 at once) or call sequentially." },
};

/** Defaults new steps get (L4): explicit timeout below the gateway's 30 s, back-off 1 s then 3 s. */
export const LESSON_DEFAULTS = { timeoutMs: 20_000, retryDelaysMs: "1000, 3000", retries: 2, sessionSeconds: 240, inflightMaxMs: 30_000, backgroundRetryDelaysMs: [1000, 3000] } as const;

/** "[L4] Step: message. Fix: ..." - every lesson warning cites its id and how to fix it. */
export function lessonMessage(checkId: string, subject: string, detail?: string): string {
  const c = LESSON_CHECKS[checkId];
  if (!c) return `${subject}: ${detail ?? checkId}`;
  return `[${c.lesson} ${c.id}] ${subject}: ${detail ?? c.title}. Fix: ${c.fix}`;
}

export const IDEMPOTENT_METHODS = ["GET", "HEAD", "OPTIONS"];
const IDEMPOTENCY_HEADER = /^(?:idempotency-key|x-idempotency-key|x-request-id-idempotent)$/i;

/** True when repeating the call cannot change data twice: a read method, a GraphQL query (not a
 * mutation), an upsert endpoint (Zoho /upsert with duplicate_check_fields, L7), or a call that
 * carries an Idempotency-Key header. */
export function isIdempotentCall(method: string, headerNames: string[] = [], graphqlQuery?: string, url?: string): boolean {
  const m = String(method || "GET").toUpperCase();
  if (graphqlQuery !== undefined) return !/^\s*mutation\b/i.test(String(graphqlQuery).replace(/^\s*#.*$/gm, ""));
  if (IDEMPOTENT_METHODS.includes(m)) return true;
  if (url && /\/upsert(?:$|[/?#])/i.test(String(url))) return true;
  return headerNames.some((h) => IDEMPOTENCY_HEADER.test(String(h).trim()));
}

const LOGIN = /(?:^|[\s/_.:-])(?:log-?in|sign-?in|logon|authenticate|authenticat\w*|auth|o?auth2?\/token|token|access[-_ ]?token|session|connect\/token)(?:$|[\s/_.:?-])/i;
/** A call that opens a session or fetches a token (by its URL, operation or step name). */
export function isLoginLike(...texts: unknown[]): boolean {
  return texts.some((t) => typeof t === "string" && t !== "" && LOGIN.test(t.replace(/\{\{[^}]*\}\}/g, " ")));
}

const NOTIFY = /(?:^|[\s/_.:-])(?:e-?mails?|mail|smtp|sms|text-?message|notif\w*|push|whatsapp|otp|send-?(?:mail|email|sms|message|notification))(?:$|[\s/_.:?-])/i;
/** An e-mail / SMS / notification send (by its URL, operation, connector or step name). */
export function isNotificationLike(...texts: unknown[]): boolean {
  return texts.some((t) => typeof t === "string" && t !== "" && NOTIFY.test(t.replace(/\{\{[^}]*\}\}/g, " ")));
}

/** "1000, 3000" | [1000, 3000] -> [1000, 3000]. */
export function delaysOf(v: unknown): number[] {
  const parts = Array.isArray(v) ? v : typeof v === "string" ? v.split(/[,;\s]+/) : [];
  return parts.map((x) => Number(x)).filter((n) => Number.isFinite(n) && n >= 0).map((n) => Math.min(60_000, Math.round(n)));
}
