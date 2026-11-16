// Plain-words labels and small pure helpers of the Manual Review Workbench (unit-tested).
import type { Action, GuestView, ReviewCase, Role, Version } from "./api.ts";

export const KIND_LABEL: Record<string, string> = {
  MULTIPLE_IDENTITY_CONFLICT: "Matches more than one person",
  REEVALUATION_CONFLICT: "Changed after a new check",
  FOUR_FIELD_REVIEW: "Four details to compare",
  PAIR_REPAIR: "Link to repair",
  GUARDRAIL: "Stopped by a safety rule",
  SHADOW_CANDIDATE: "Suggested by the trial matcher",
};
export const KIND_SHORT: Record<string, string> = {
  MULTIPLE_IDENTITY_CONFLICT: "Conflict", REEVALUATION_CONFLICT: "Re-check", FOUR_FIELD_REVIEW: "Four-field",
  PAIR_REPAIR: "Link repair", GUARDRAIL: "Safety rule", SHADOW_CANDIDATE: "Trial suggestion",
};
export const STATUS_LABEL: Record<string, string> = {
  REVIEW_OPEN: "Open", REVIEW_DECISION_PREPARED: "Decision being saved", REVIEW_DATA_CHANGED: "Data changed",
  REVIEW_CRM_UPDATE_PENDING: "Updating CRM", REVIEW_COMMITTED: "Decided", REVIEW_FAILED: "Failed",
};
export const ROLE_LABEL: Record<Role, string> = {
  IDENTITY_REVIEWER: "Identity reviewer", IDENTITY_SUPERVISOR: "Supervisor", CRM_ADMINISTRATOR: "CRM administrator", AUDIT_REPORTING: "Audit",
};
export const ACTION_LABEL: Record<Action, string> = {
  CONFIRM_SAME_PERSON: "Same person", CONFIRM_DIFFERENT_PEOPLE: "Different people", CONFIRM_HOUSEHOLD: "Same household",
  DEFER: "Decide later", REVERSE_DECISION: "Reverse the decision",
};
export const ACTION_HINT: Record<Action, string> = {
  CONFIRM_SAME_PERSON: "The incoming guest is the chosen person. Their records are linked.",
  CONFIRM_DIFFERENT_PEOPLE: "These are different people. Nothing is linked.",
  CONFIRM_HOUSEHOLD: "Different people who share contact details, such as a family.",
  DEFER: "Leave the case open with a reason and a date to look again.",
  REVERSE_DECISION: "Undo the decision made on this case and link to the chosen person instead, or to nobody.",
};
export const FIELDS: [string, string][] = [["firstName", "First name"], ["lastName", "Last name"], ["dob", "Date of birth"], ["phone", "Phone"], ["email", "Email"]];

export type Mark = { label: string; tone: "ok" | "warn" | "bad" | "muted"; symbol: string };
/** What a field comparison means, in words and a symbol (never colour alone). */
export function fieldMark(r: string | undefined, hasValue: boolean): Mark | null {
  switch (r) {
    case "EXACT": return { label: "Same", tone: "ok", symbol: "=" };
    case "CONFLICT": return { label: "Different", tone: "bad", symbol: "≠" };
    case "MISSING": return { label: "Missing", tone: "muted", symbol: "–" };
    case "SUPPRESSED": case "OVER_SHARED": return { label: "Shared by many guests", tone: "warn", symbol: "∴" };
    case "LOW_CONFIDENCE": return { label: "Not sure", tone: "warn", symbol: "?" };
    default: return hasValue ? null : { label: "Missing", tone: "muted", symbol: "–" };
  }
}

export function identityOf(g: GuestView): string {
  return g.crmIdentityRecordId || g.distinctIdentityId || "";
}
/** The distinct people the candidates belong to, in first-seen order. */
export function distinctIdentities(c: Pick<ReviewCase, "candidates">): string[] {
  const out: string[] = [];
  for (const g of c.candidates ?? []) { const id = identityOf(g); if (id && !out.includes(id)) out.push(id); }
  return out;
}

/** The record versions the reviewer looked at; sent with the decision so a change since is caught. */
export function versionsShown(c: Pick<ReviewCase, "incoming" | "candidates">): Version[] {
  const all = [c.incoming, ...(c.candidates ?? [])].filter(Boolean) as GuestView[];
  const seen = new Set<string>();
  const out: Version[] = [];
  for (const g of all) {
    if (!g.crmGuestRecordId || !g.crmModifiedTime || seen.has(g.crmGuestRecordId)) continue;
    seen.add(g.crmGuestRecordId);
    out.push({ crmGuestRecordId: g.crmGuestRecordId, crmModifiedTime: g.crmModifiedTime });
  }
  return out;
}

export type Change = { record: string; what: string; before?: string; after?: string };
/** What differs between the case as shown and the case as it is now. Values are only named when the
 *  reviewer may see them (both views are already masked for other roles). */
export function caseChanges(before: ReviewCase, after: ReviewCase): Change[] {
  const out: Change[] = [];
  const idx = (c: ReviewCase) => new Map([c.incoming, ...(c.candidates ?? [])].filter(Boolean).map((g) => [(g as GuestView).crmGuestRecordId, g as GuestView]));
  const a = idx(before), b = idx(after);
  for (const [id, g] of b) {
    const old = a.get(id);
    if (!old) { out.push({ record: id, what: "A guest was added to the case" }); continue; }
    let named = false;
    for (const [k, label] of FIELDS) {
      const x = old.display?.[k] ?? "", y = g.display?.[k] ?? "";
      if (x !== y) { out.push({ record: id, what: label, before: x || "(empty)", after: y || "(empty)" }); named = true; }
    }
    if (identityOf(old) !== identityOf(g)) { out.push({ record: id, what: "Linked person", before: identityOf(old) || "(none)", after: identityOf(g) || "(none)" }); named = true; }
    if (!named && old.crmModifiedTime !== g.crmModifiedTime) out.push({ record: id, what: "The record was saved again in CRM" });
  }
  for (const id of a.keys()) if (!b.has(id)) out.push({ record: id, what: "A guest left the case" });
  if (before.caseStatus !== after.caseStatus) out.push({ record: before.caseId, what: "Case status", before: STATUS_LABEL[before.caseStatus] ?? before.caseStatus, after: STATUS_LABEL[after.caseStatus] ?? after.caseStatus });
  return out;
}

export function age(iso: string | undefined, now = Date.now()): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return "";
  const m = Math.max(0, Math.round((now - t) / 60000));
  if (m < 60) return `${m} min`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h`;
  return `${Math.round(h / 24)} days`;
}

export function slaWords(s: ReviewCase["sla"]): { text: string; tone: "ok" | "warn" | "bad" } | null {
  if (!s) return null;
  const due = new Date(s.dueAt).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  if (s.state === "OVERDUE") return { text: `Overdue · was due ${due}${s.escalate ? " · supervisor told" : ""}`, tone: "bad" };
  if (s.state === "DUE_SOON") return { text: `Due soon · ${due}`, tone: "warn" };
  return { text: `On time · due ${due}`, tone: "ok" };
}

export const newIdempotencyKey = (caseId: string, who: string) =>
  `${caseId}:${who}:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`.replace(/[^\w:.-]/g, "_").slice(0, 120);

export const ERROR_WORDS: Record<string, string> = {
  POPUP_BLOCKED: "The browser blocked the sign-in window. Allow pop-ups for this page and try again.",
  SIGN_IN_FAILED: "Sign-in did not finish. Try again.",
  SIGN_IN_TIMEOUT: "Sign-in took too long. Try again.",
  NO_REVIEW_ROLE: "Your Zoho account has no review role. Ask your CRM administrator to add you.",
  REVIEW_API_NOT_CONNECTED: "The review service is not connected yet, so there are no cases to show.",
  REVIEW_API_UNREACHABLE: "The review service did not answer. Try again in a moment.",
};
