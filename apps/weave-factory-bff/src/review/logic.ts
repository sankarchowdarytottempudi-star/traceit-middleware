// Pure rules of the Review Workbench: who may do what, SLA state, masking. No I/O here.
import type { ReviewRole } from "./config.js";

export type Action = "CONFIRM_SAME_PERSON" | "CONFIRM_DIFFERENT_PEOPLE" | "CONFIRM_HOUSEHOLD" | "DEFER" | "REVERSE_DECISION";
export const ACTIONS: readonly Action[] = ["CONFIRM_SAME_PERSON", "CONFIRM_DIFFERENT_PEOPLE", "CONFIRM_HOUSEHOLD", "DEFER", "REVERSE_DECISION"];

const DECIDERS: ReviewRole[] = ["IDENTITY_REVIEWER", "IDENTITY_SUPERVISOR"];

/** Plan §15.3: reviewers decide and defer; supervisors also reverse and reassign; admin and audit never decide. */
export function allowedActions(roles: ReviewRole[], caseStatus: string): Action[] {
  const decider = roles.some((r) => DECIDERS.includes(r));
  const supervisor = roles.includes("IDENTITY_SUPERVISOR");
  if (caseStatus === "REVIEW_COMMITTED") return supervisor ? ["REVERSE_DECISION"] : [];
  if (!decider || caseStatus === "REVIEW_FAILED" || caseStatus === "REVIEW_CRM_UPDATE_PENDING") return [];
  return ["CONFIRM_SAME_PERSON", "CONFIRM_DIFFERENT_PEOPLE", "CONFIRM_HOUSEHOLD", "DEFER"];
}

export const canSee = (roles: ReviewRole[]): boolean => roles.length > 0;
/** Protected display values (names, DOB, phone, e-mail) only for reviewers and supervisors. */
export const canSeeProtected = (roles: ReviewRole[]): boolean => roles.some((r) => DECIDERS.includes(r));
export const canAssign = (roles: ReviewRole[]): boolean => roles.includes("IDENTITY_SUPERVISOR");

export function maskValue(field: string, v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  const s = String(v);
  if (field === "email") { const at = s.indexOf("@"); return at > 0 ? `${s[0]}•••@•••` : "•••"; }
  if (field === "phone") return s.length > 2 ? `•••${s.slice(-2)}` : "•••";
  if (field === "dob") return "••••-••-••";
  return s.length ? `${s[0]}•••` : "•••";
}

type View = { display?: Record<string, unknown> | null; normalized?: Record<string, unknown> | null; [k: string]: unknown };

/** Removes protected values for roles that may not see them; normalized values hold PII too. */
export function maskView<T extends View>(v: T, protectedOk: boolean): T {
  if (protectedOk || !v || typeof v !== "object") return v;
  const display = v.display ? Object.fromEntries(Object.entries(v.display).map(([k, x]) => [k, maskValue(k, x)])) : v.display;
  return { ...v, display, normalized: v.normalized ? {} : v.normalized, masked: true };
}

/** Adds `count` working days (the start day itself not counted) to a moment. */
export function addWorkingDays(from: Date, count: number, workWeek: number[]): Date {
  const d = new Date(from.getTime());
  let left = count;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (workWeek.includes(d.getUTCDay())) left -= 1;
  }
  return d;
}

export interface Sla { dueAt: string; state: "ON_TIME" | "DUE_SOON" | "OVERDUE"; escalate: boolean; days: number }

/** SLA of an open case: due after N working days; due soon in the last quarter; overdue escalates to a supervisor. */
export function slaOf(kind: string, createdAt: string | undefined, slaDays: Record<string, number>, workWeek: number[], now: Date = new Date()): Sla | null {
  if (!createdAt) return null;
  const start = new Date(createdAt);
  if (Number.isNaN(start.getTime())) return null;
  const days = slaDays[kind] ?? slaDays.FOUR_FIELD_REVIEW ?? 2;
  const due = addWorkingDays(start, days, workWeek);
  const total = due.getTime() - start.getTime();
  const left = due.getTime() - now.getTime();
  const state = left < 0 ? "OVERDUE" : left < total / 4 ? "DUE_SOON" : "ON_TIME";
  return { dueAt: due.toISOString(), state, escalate: state === "OVERDUE", days };
}

/** The decision request sent on: the reviewer is always the signed-in user, never what the browser says. */
export interface DecisionInput {
  action?: unknown; selectedIdentityId?: unknown; comment?: unknown; followUpDate?: unknown;
  versionsShown?: unknown; idempotencyKey?: unknown;
}
export function decisionRequest(caseId: string, reviewerId: string, b: DecisionInput, roles: ReviewRole[], caseStatus: string):
  { ok: true; body: Record<string, unknown> } | { ok: false; status: number; code: string; message: string } {
  const action = String(b.action ?? "") as Action;
  if (!ACTIONS.includes(action)) return { ok: false, status: 400, code: "INVALID_REQUEST", message: "Choose an action." };
  if (!allowedActions(roles, caseStatus).includes(action)) return { ok: false, status: 403, code: "FORBIDDEN", message: "Your role may not take this action on this case." };
  const versions = Array.isArray(b.versionsShown) ? b.versionsShown : [];
  const shown = versions
    .filter((x): x is { crmGuestRecordId: unknown; crmModifiedTime: unknown } => !!x && typeof x === "object")
    .map((x) => ({ crmGuestRecordId: String(x.crmGuestRecordId ?? ""), crmModifiedTime: String(x.crmModifiedTime ?? "") }))
    .filter((x) => x.crmGuestRecordId && x.crmModifiedTime);
  if (!shown.length) return { ok: false, status: 400, code: "INVALID_REQUEST", message: "The versions shown on screen are missing; reload the case." };
  const comment = typeof b.comment === "string" ? b.comment.trim().slice(0, 2000) : "";
  const followUp = typeof b.followUpDate === "string" ? b.followUpDate.trim() : "";
  if (action === "DEFER") {
    if (!comment) return { ok: false, status: 400, code: "INVALID_REQUEST", message: "Say why the case is deferred." };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(followUp)) return { ok: false, status: 400, code: "INVALID_REQUEST", message: "Choose a follow-up date." };
  }
  const selected = typeof b.selectedIdentityId === "string" && b.selectedIdentityId.trim() ? b.selectedIdentityId.trim() : null;
  if ((action === "CONFIRM_SAME_PERSON" || action === "REVERSE_DECISION") && !selected) {
    return { ok: false, status: 400, code: "INVALID_REQUEST", message: "Choose the identity this guest belongs to." };
  }
  const key = typeof b.idempotencyKey === "string" && /^[\w:.-]{6,120}$/.test(b.idempotencyKey) ? b.idempotencyKey : "";
  if (!key) return { ok: false, status: 400, code: "INVALID_REQUEST", message: "The request is missing its idempotency key; reload the case." };
  return {
    ok: true,
    body: {
      caseId, reviewerId, action, selectedIdentityId: selected, comment: comment || null,
      versionsShown: shown, idempotencyKey: key, ...(action === "DEFER" ? { followUpDate: followUp } : {}),
    },
  };
}
