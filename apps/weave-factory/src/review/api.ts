// Manual Review Workbench: the browser side of the review API. Only /api/review/* of this server is
// ever called; that server talks to the Integration Service review API. Nothing here reaches CRM.
//
// The session is an opaque token in an Authorization header (no cookie: the page lives in a CRM Web
// Tab, a third-party frame, where cookies are unreliable and a cookie would invite CSRF). It is kept
// in memory and in this tab's sessionStorage, so a reload inside the Web Tab keeps you signed in.
import { at } from "../lib/base.ts";

const KEY = "weave-review-token";
let token: string | null = (() => { try { return sessionStorage.getItem(KEY); } catch { return null; } })();

export function setToken(t: string | null) {
  token = t;
  try { if (t) sessionStorage.setItem(KEY, t); else sessionStorage.removeItem(KEY); } catch { /* storage blocked: memory only */ }
}
export const hasToken = () => !!token;

export class ReviewError extends Error {
  constructor(public status: number, public code: string, message: string, public data: any) { super(message); }
}

let onExpired: (() => void) | null = null;
export const whenExpired = (f: () => void) => { onExpired = f; };

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const r = await fetch(at(`/api/review${path}`), { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: "omit", cache: "no-store" });
  if (r.status === 204) return undefined as T;
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (r.status === 401 && token) { setToken(null); onExpired?.(); }
    throw new ReviewError(r.status, String(data?.code ?? "ERROR"), String(data?.message ?? "Something went wrong. Try again."), data);
  }
  return data as T;
}

export type Role = "IDENTITY_REVIEWER" | "IDENTITY_SUPERVISOR" | "CRM_ADMINISTRATOR" | "AUDIT_REPORTING";
export type Action = "CONFIRM_SAME_PERSON" | "CONFIRM_DIFFERENT_PEOPLE" | "CONFIRM_HOUSEHOLD" | "DEFER" | "REVERSE_DECISION";
export type Sla = { dueAt: string; state: "ON_TIME" | "DUE_SOON" | "OVERDUE"; escalate: boolean; days: number } | null;
export type Info = { enabled: boolean; signIn: boolean; connected: boolean };
export type Session = { user: { zuid: string; name: string; email: string }; roles: Role[]; connected: boolean; idleMinutes: number; expiresAt: string; slaDays: Record<string, number>; crmLinks: boolean };
export type CaseRow = { caseId: string; kind: string; priority?: string; caseStatus: string; createdAt?: string; assignee: string | null; candidateCount: number | null; ruleVersion?: string; title: string | null; sla: Sla };
export type FieldResult = "EXACT" | "CONFLICT" | "MISSING" | "SUPPRESSED" | "LOW_CONFIDENCE" | "OVER_SHARED" | string;
export type GuestView = {
  crmGuestRecordId: string; crmModifiedTime?: string; crmIdentityRecordId?: string; distinctIdentityId?: string;
  display?: Record<string, string | null>; normalized?: Record<string, unknown>; fieldResults?: Record<string, FieldResult>;
  reasonCodes?: string[]; masked?: boolean; crmLink?: string | null; label?: string;
};
export type Pair = { pairId?: string; guestId?: string; identityId?: string; crmGuestRecordId?: string; crmIdentityRecordId?: string; state?: string };
export type ReviewCase = {
  caseId: string; caseStatus: string; kind: string; priority?: string; ruleVersion?: string; reasonCodes?: string[]; createdAt?: string;
  assignee?: string | null; incoming?: GuestView; candidates: GuestView[]; provisionalIdentity?: string | { crmIdentityRecordId?: string } | null;
  pairs?: { current?: Pair[]; provisional?: Pair[]; surviving?: Pair[] }; shadow?: { label?: string; score?: number; modelVersion?: string } | null;
  sla: Sla; allowedActions: Action[]; canAssign: boolean; protectedShown: boolean; lastDecision?: { action?: string; at?: string; by?: string } | null;
};
export type HistoryItem = { at?: string; who?: string; by?: string; what?: string; action?: string; text?: string; comment?: string; kind?: string };
export type Version = { crmGuestRecordId: string; crmModifiedTime: string };

export const reviewApi = {
  info: () => call<Info>("GET", "/info"),
  session: () => call<Session>("GET", "/session"),
  claim: (secret: string) => call<Record<string, unknown> | undefined>("POST", "/auth/claim", { secret }),
  logout: () => call<void>("POST", "/auth/logout"),
  cases: (f: { kind?: string; status?: string; mine?: boolean }) => {
    const p = new URLSearchParams();
    if (f.kind) p.set("kind", f.kind);
    if (f.status) p.set("status", f.status);
    if (f.mine) p.set("mine", "1");
    const qs = p.toString();
    return call<{ cases: CaseRow[] }>("GET", `/cases${qs ? `?${qs}` : ""}`);
  },
  case: (id: string) => call<ReviewCase>("GET", `/cases/${encodeURIComponent(id)}`),
  history: (id: string) => call<{ history: HistoryItem[] }>("GET", `/cases/${encodeURIComponent(id)}/history`),
  assign: (id: string, assigneeId: string) => call<unknown>("POST", `/cases/${encodeURIComponent(id)}/assignment`, { assigneeId }),
  comment: (id: string, text: string) => call<unknown>("POST", `/cases/${encodeURIComponent(id)}/comments`, { text }),
  decide: (id: string, body: { action: Action; selectedIdentityId?: string; comment?: string; followUpDate?: string; versionsShown: Version[]; idempotencyKey: string }) =>
    call<{ caseStatus?: string; message?: string }>("POST", `/cases/${encodeURIComponent(id)}/decisions`, body),
};

// ---- sign-in ----------------------------------------------------------------------------------
const b64url = (b: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** A fresh secret and its hash. Sign-in sees only the hash; the secret claims the result. */
export async function newSecret(): Promise<{ secret: string; hash: string }> {
  const secret = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const hash = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret)));
  return { secret, hash };
}

export type SignInResult = { ok: true; token: string } | { ok: false; error: string };

/** Signs in through Zoho in a separate window (Zoho's sign-in page refuses to be framed). The result
 *  comes back by postMessage from this server's own origin, or, if the window lost its link back,
 *  by claiming it with the secret. */
export async function signIn(): Promise<SignInResult> {
  const { secret, hash } = await newSecret();
  const w = window.open(at(`/api/review/auth/start?nonce=${hash}`), "weave-review-signin", "popup,width=520,height=700");
  if (!w) return { ok: false, error: "POPUP_BLOCKED" };
  return new Promise<SignInResult>((resolve) => {
    let done = false;
    const finish = (r: SignInResult) => { if (done) return; done = true; window.removeEventListener("message", onMsg); clearInterval(poll); clearTimeout(stop); resolve(r); };
    const take = (d: any) => (d?.ok && typeof d.token === "string" ? finish({ ok: true, token: d.token }) : finish({ ok: false, error: String(d?.error ?? "SIGN_IN_FAILED") }));
    const onMsg = (e: MessageEvent) => {
      if (e.origin !== window.location.origin) return;
      const d = e.data;
      if (!d || d.type !== "weave-review-session" || d.nonce !== hash) return;
      // the same outcome also waits to be claimed; take it so it cannot be used later
      reviewApi.claim(secret).catch(() => undefined);
      take(d);
    };
    window.addEventListener("message", onMsg);
    const poll = setInterval(() => { reviewApi.claim(secret).then((d) => { if (d) take(d); }).catch(() => undefined); }, 1500);
    const stop = setTimeout(() => finish({ ok: false, error: "SIGN_IN_TIMEOUT" }), 5 * 60_000);
  });
}
