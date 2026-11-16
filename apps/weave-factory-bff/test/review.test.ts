import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import { registerReview, reviewPageHeaders, isReviewPath } from "../src/review/routes";
import { parseRoleMap, rolesFor, loadReviewConfig, type ReviewConfig } from "../src/review/config";
import { addWorkingDays, slaOf, allowedActions, decisionRequest, maskView } from "../src/review/logic";
import { createSessionStore } from "../src/sessionStore";
import type { Config } from "../src/config";

const API = "http://review-api.test/identity-review";
const ACCOUNTS = "https://accounts.zoho.test";
const cfg = { PUBLIC_BASE_URL: "https://weave.example.test/factory" } as unknown as Config;

function rc(over: Partial<ReviewConfig> = {}): ReviewConfig {
  return {
    ...loadReviewConfig({}), enabled: true, apiUrl: API, apiToken: "svc-token", zohoAccountsUrl: ACCOUNTS,
    zohoClientId: "cid", zohoClientSecret: "csecret", crmLinkBase: "https://crm.zoho.test/crm/org1",
    roleMap: parseRoleMap(JSON.stringify({
      users: { "rev@aroya.test": ["IDENTITY_REVIEWER"], "sup@aroya.test": ["IDENTITY_SUPERVISOR"], "aud@aroya.test": ["AUDIT_REPORTING"], "adm@aroya.test": ["CRM_ADMINISTRATOR"] },
      domains: {},
    })),
    ...over,
  };
}

const CASE = {
  caseId: "RC-10001", caseStatus: "REVIEW_OPEN", kind: "FOUR_FIELD_REVIEW", priority: "NORMAL", ruleVersion: "1.0",
  createdAt: "2026-11-16T08:00:00Z",
  incoming: { crmGuestRecordId: "R100", crmModifiedTime: "2026-11-16T10:00:00Z", display: { firstName: "Ali", lastName: "Khan", dob: "1990-05-10", phone: "0551234567", email: "ali@example.com" }, normalized: { email_key: "ali@example.com" } },
  candidates: [{ crmGuestRecordId: "R200", crmIdentityRecordId: "I200", crmModifiedTime: "2026-11-16T09:40:00Z", display: { firstName: "Ali", lastName: "Khan", dob: "1991-05-10", phone: "0551234567", email: "ali@example.com" }, fieldResults: { dob: "CONFLICT" } }],
};

function harness(upstream?: (url: string, init: any) => Response | Promise<Response>) {
  const calls: { url: string; init: any }[] = [];
  const fake = (async (url: string, init: any = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).startsWith(`${ACCOUNTS}/oauth/v2/token/revoke`)) return new Response("", { status: 200 });
    if (String(url) === `${ACCOUNTS}/oauth/v2/token`) return new Response(JSON.stringify({ access_token: "zat" }), { status: 200 });
    if (String(url) === `${ACCOUNTS}/oauth/user/info`) {
      const who = (globalThis as any).__who ?? "rev@aroya.test";
      return new Response(JSON.stringify({ Email: who, ZUID: `z-${who.split("@")[0]}`, Display_Name: "Tester" }), { status: 200 });
    }
    if (upstream) return upstream(String(url), init);
    if (String(url).startsWith(`${API}/v1/review-cases/RC-10001/history`)) return new Response(JSON.stringify([{ at: "2026-11-16T10:00:00Z", what: "opened" }]), { status: 200 });
    if (String(url).startsWith(`${API}/v1/review-cases/RC-10001`)) return new Response(JSON.stringify(CASE), { status: 200 });
    if (String(url).startsWith(`${API}/v1/review-cases`)) return new Response(JSON.stringify({ cases: [{ ...CASE, title: "Ali Khan" }] }), { status: 200 });
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
  return { calls, fake };
}

async function appFor(conf: ReviewConfig, upstream?: (url: string, init: any) => Response | Promise<Response>) {
  const app = Fastify();
  const store = await createSessionStore();
  const h = harness(upstream);
  registerReview(app, cfg, store, { rc: conf, fetch: h.fake });
  await app.ready();
  return { app, calls: h.calls, store };
}

async function signIn(app: any, who: string): Promise<string> {
  (globalThis as any).__who = who;
  const start = await app.inject({ method: "GET", url: "/api/review/auth/start?nonce=abcdefghijklmnop1234" });
  const loc = new URL(start.headers.location as string);
  const cb = await app.inject({ method: "GET", url: `/api/review/auth/callback?code=c1&state=${loc.searchParams.get("state")}` });
  const m = /"token":"([^"]+)"/.exec(cb.body);
  if (!m) throw new Error(`no token: ${cb.body}`);
  return m[1];
}

describe("review workbench config and rules", () => {
  it("maps roles by user first, then domain; a broken map grants nothing", () => {
    const m = parseRoleMap(JSON.stringify({ users: { "A@X.test": ["IDENTITY_SUPERVISOR"] }, domains: { "@x.test": ["IDENTITY_REVIEWER", "NOPE"] } }));
    expect(rolesFor(m, "a@x.test", "1")).toEqual(["IDENTITY_SUPERVISOR"]);
    expect(rolesFor(m, "b@x.test", "2")).toEqual(["IDENTITY_REVIEWER"]);
    expect(rolesFor(parseRoleMap("{bad"), "a@x.test", "1")).toEqual([]);
  });
  it("counts working days on the Saudi week and marks SLA states", () => {
    const thu = new Date("2026-11-19T08:00:00Z"); // Thursday
    expect(addWorkingDays(thu, 1, [0, 1, 2, 3, 4]).toISOString().slice(0, 10)).toBe("2026-11-22"); // Sunday
    const sla = { FOUR_FIELD_REVIEW: 2, MULTIPLE_IDENTITY_CONFLICT: 1 };
    expect(slaOf("MULTIPLE_IDENTITY_CONFLICT", "2026-11-16T08:00:00Z", sla, [0, 1, 2, 3, 4], new Date("2026-11-16T09:00:00Z"))?.state).toBe("ON_TIME");
    expect(slaOf("MULTIPLE_IDENTITY_CONFLICT", "2026-11-16T08:00:00Z", sla, [0, 1, 2, 3, 4], new Date("2026-11-17T03:00:00Z"))?.state).toBe("DUE_SOON");
    const late = slaOf("FOUR_FIELD_REVIEW", "2026-11-16T08:00:00Z", sla, [0, 1, 2, 3, 4], new Date("2026-11-20T08:00:00Z"));
    expect(late?.state).toBe("OVERDUE"); expect(late?.escalate).toBe(true);
  });
  it("allows actions by role and case state", () => {
    expect(allowedActions(["IDENTITY_REVIEWER"], "REVIEW_OPEN")).toContain("CONFIRM_SAME_PERSON");
    expect(allowedActions(["IDENTITY_REVIEWER"], "REVIEW_OPEN")).not.toContain("REVERSE_DECISION");
    expect(allowedActions(["AUDIT_REPORTING"], "REVIEW_OPEN")).toEqual([]);
    expect(allowedActions(["CRM_ADMINISTRATOR"], "REVIEW_OPEN")).toEqual([]);
    expect(allowedActions(["IDENTITY_SUPERVISOR"], "REVIEW_COMMITTED")).toEqual(["REVERSE_DECISION"]);
    expect(allowedActions(["IDENTITY_REVIEWER"], "REVIEW_COMMITTED")).toEqual([]);
  });
  it("masks protected values for roles that may not see them", () => {
    const v = maskView({ display: { firstName: "Ali", email: "ali@example.com", phone: "0551234567", dob: "1990-05-10" }, normalized: { a: 1 } }, false) as any;
    expect(JSON.stringify(v)).not.toMatch(/Ali|example\.com|0551234567|1990/);
    expect(v.masked).toBe(true);
  });
  it("builds the decision with the session's reviewer and refuses incomplete ones", () => {
    const v = [{ crmGuestRecordId: "R100", crmModifiedTime: "2026-11-16T10:00:00Z" }];
    const ok = decisionRequest("RC-1", "z-rev", { action: "CONFIRM_SAME_PERSON", selectedIdentityId: "I200", versionsShown: v, idempotencyKey: "RC-1:z-rev:01", reviewerId: "someone-else" } as any, ["IDENTITY_REVIEWER"], "REVIEW_OPEN");
    expect(ok.ok && ok.body.reviewerId).toBe("z-rev");
    expect(decisionRequest("RC-1", "z", { action: "DEFER", versionsShown: v, idempotencyKey: "k-123456" }, ["IDENTITY_REVIEWER"], "REVIEW_OPEN").ok).toBe(false);
    expect(decisionRequest("RC-1", "z", { action: "CONFIRM_SAME_PERSON", versionsShown: [], idempotencyKey: "k-123456", selectedIdentityId: "I" }, ["IDENTITY_REVIEWER"], "REVIEW_OPEN").ok).toBe(false);
  });
  it("page headers allow framing only by the configured Zoho domains", () => {
    const h = reviewPageHeaders(rc({ frameAncestors: ["https://crm.zoho.sa"] }));
    expect(h["content-security-policy"]).toBe("frame-ancestors 'self' https://crm.zoho.sa");
    expect(isReviewPath("/review/cases/RC-1?x=1")).toBe(true);
    expect(isReviewPath("/reviewer")).toBe(false);
  });
});

describe("review workbench routes", () => {
  it("does not exist while the feature flag is off", async () => {
    const { app } = await appFor(rc({ enabled: false }));
    expect((await app.inject({ url: "/api/review/info" })).statusCode).toBe(404);
  });

  it("signs in with Zoho (PKCE, profile scope only) and hands the token to the opener", async () => {
    const { app, calls } = await appFor(rc());
    expect((await app.inject({ url: "/api/review/auth/start" })).statusCode).toBe(400); // no nonce
    const start = await app.inject({ url: "/api/review/auth/start?nonce=abcdefghijklmnop1234" });
    const loc = new URL(start.headers.location as string);
    expect(loc.origin + loc.pathname).toBe(`${ACCOUNTS}/oauth/v2/auth`);
    expect(loc.searchParams.get("scope")).toBe("AaaServer.profile.READ");
    expect(loc.searchParams.get("code_challenge_method")).toBe("S256");
    expect(loc.searchParams.get("redirect_uri")).toBe("https://weave.example.test/factory/api/review/auth/callback");
    const cb = await app.inject({ url: `/api/review/auth/callback?code=c1&state=${loc.searchParams.get("state")}` });
    expect(cb.body).toContain('"nonce":"abcdefghijklmnop1234"');
    expect(cb.body).toContain('"https://weave.example.test"'); // postMessage target origin
    expect(cb.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(calls.some((c) => c.url.includes("/oauth/v2/token/revoke"))).toBe(true);
    // a state is used once
    const again = await app.inject({ url: `/api/review/auth/callback?code=c1&state=${loc.searchParams.get("state")}` });
    expect(again.body).toContain("SIGN_IN_FAILED");
  });

  it("hands the session over once to whoever holds the secret, when the window lost its link", async () => {
    const { app } = await appFor(rc());
    (globalThis as any).__who = "rev@aroya.test";
    const { createHash } = await import("node:crypto");
    const secret = "s".repeat(20) + "ecretABCDEFGHIJKLMNOPQRSTUVWXYZ012";
    const h = createHash("sha256").update(secret).digest("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect((await app.inject({ method: "POST", url: "/api/review/auth/claim", payload: { secret } })).statusCode).toBe(204); // nothing yet
    const start = await app.inject({ url: `/api/review/auth/start?nonce=${h}` });
    expect(start.headers.location).not.toContain(secret);
    const st = new URL(start.headers.location as string).searchParams.get("state");
    await app.inject({ url: `/api/review/auth/callback?code=c1&state=${st}` });
    expect((await app.inject({ method: "POST", url: "/api/review/auth/claim", headers: { origin: "https://evil.test" }, payload: { secret } })).statusCode).toBe(403);
    const got = await app.inject({ method: "POST", url: "/api/review/auth/claim", payload: { secret } });
    expect(got.json().ok).toBe(true);
    const tok = got.json().token;
    expect((await app.inject({ url: "/api/review/session", headers: { authorization: `Bearer ${tok}` } })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/api/review/auth/claim", payload: { secret } })).statusCode).toBe(204); // only once
    expect((await app.inject({ method: "POST", url: "/api/review/auth/claim", payload: { secret: h } })).statusCode).toBe(204); // the hash alone opens nothing
  });

  it("refuses accounts without a review role", async () => {
    const { app } = await appFor(rc());
    (globalThis as any).__who = "nobody@other.test";
    const start = await app.inject({ url: "/api/review/auth/start?nonce=abcdefghijklmnop1234" });
    const st = new URL(start.headers.location as string).searchParams.get("state");
    const cb = await app.inject({ url: `/api/review/auth/callback?code=c1&state=${st}` });
    expect(cb.body).toContain("NO_REVIEW_ROLE");
    expect(cb.body).not.toContain('"token"');
  });

  it("needs a session; sessions end after the absolute limit", async () => {
    const conf = rc();
    const { app, store } = await appFor(conf);
    expect((await app.inject({ url: "/api/review/session" })).statusCode).toBe(401);
    const tok = await signIn(app, "rev@aroya.test");
    const ok = await app.inject({ url: "/api/review/session", headers: { authorization: `Bearer ${tok}` } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().roles).toEqual(["IDENTITY_REVIEWER"]);
    expect(ok.body).not.toContain("rev@aroya.test");
    const { createHash } = await import("node:crypto");
    const key = `review:sess:${createHash("sha256").update(tok).digest("hex")}`;
    const s = await store.get<any>(key);
    await store.set(key, { ...s, created: Date.now() - (conf.maxHours * 3600_000 + 1000) }, 60);
    expect((await app.inject({ url: "/api/review/session", headers: { authorization: `Bearer ${tok}` } })).statusCode).toBe(401);
  });

  it("reads cases only from the review API, with the service credential and reviewer identity", async () => {
    const { app, calls } = await appFor(rc());
    const tok = await signIn(app, "rev@aroya.test");
    calls.length = 0;
    const list = await app.inject({ url: "/api/review/cases?kind=FOUR_FIELD_REVIEW&mine=1", headers: { authorization: `Bearer ${tok}` } });
    expect(list.statusCode).toBe(200);
    expect(list.json().cases[0].sla).toBeTruthy();
    const one = await app.inject({ url: "/api/review/cases/RC-10001", headers: { authorization: `Bearer ${tok}` } });
    expect(one.json().incoming.display.firstName).toBe("Ali");
    expect(one.json().allowedActions).toContain("CONFIRM_SAME_PERSON");
    expect(one.json().candidates[0].crmLink).toBe("https://crm.zoho.test/crm/org1/tab/Contacts/R200");
    expect(calls.every((c) => c.url.startsWith(API))).toBe(true); // no CRM, no Python, no database
    expect(calls[0].url).toContain("assignee=z-rev");
    expect(calls[0].init.headers.authorization).toBe("Bearer svc-token");
    expect(calls[0].init.headers["x-reviewer-id"]).toBe("z-rev");
  });

  it("shows audit users masked values and no actions", async () => {
    const { app } = await appFor(rc());
    const tok = await signIn(app, "aud@aroya.test");
    const one = await app.inject({ url: "/api/review/cases/RC-10001", headers: { authorization: `Bearer ${tok}` } });
    expect(one.body).not.toMatch(/Ali|Khan|example\.com|0551234567|1990-05-10/);
    expect(one.json().allowedActions).toEqual([]);
    const list = await app.inject({ url: "/api/review/cases", headers: { authorization: `Bearer ${tok}` } });
    expect(list.json().cases[0].title).toBeNull();
    const d = await app.inject({ method: "POST", url: "/api/review/cases/RC-10001/decisions", headers: { authorization: `Bearer ${tok}` },
      payload: { action: "CONFIRM_DIFFERENT_PEOPLE", versionsShown: [{ crmGuestRecordId: "R100", crmModifiedTime: "2026-11-16T10:00:00Z" }], idempotencyKey: "RC-10001:x:01" } });
    expect(d.statusCode).toBe(403);
  });

  it("sends decisions with the signed-in reviewer and passes REVIEW_DATA_CHANGED through", async () => {
    let sent: any = null;
    const { app } = await appFor(rc(), (url, init) => {
      if (url.endsWith("/decisions")) { sent = JSON.parse(init.body); return new Response(JSON.stringify({ code: "REVIEW_DATA_CHANGED", message: "changed", fields: [{ crmGuestRecordId: "R200", fields: ["dob"] }] }), { status: 409 }); }
      return new Response(JSON.stringify(CASE), { status: 200 });
    });
    const tok = await signIn(app, "rev@aroya.test");
    const r = await app.inject({ method: "POST", url: "/api/review/cases/RC-10001/decisions", headers: { authorization: `Bearer ${tok}`, origin: "https://weave.example.test" },
      payload: { action: "CONFIRM_SAME_PERSON", selectedIdentityId: "I200", reviewerId: "forged", comment: "checked",
        versionsShown: [{ crmGuestRecordId: "R100", crmModifiedTime: "2026-11-16T10:00:00Z" }, { crmGuestRecordId: "R200", crmModifiedTime: "2026-11-16T09:40:00Z" }],
        idempotencyKey: "RC-10001:z-rev:01" } });
    expect(r.statusCode).toBe(409);
    expect(r.json().code).toBe("REVIEW_DATA_CHANGED");
    expect(sent.reviewerId).toBe("z-rev");
    expect(sent.versionsShown).toHaveLength(2);
  });

  it("refuses POSTs from another origin and lets only supervisors assign to others", async () => {
    const { app } = await appFor(rc(), (url) => new Response(JSON.stringify(url.endsWith("/assignment") ? { ok: true } : CASE), { status: 200 }));
    const rev = await signIn(app, "rev@aroya.test");
    expect((await app.inject({ method: "POST", url: "/api/review/cases/RC-10001/assignment", headers: { authorization: `Bearer ${rev}`, origin: "https://evil.test" }, payload: { assigneeId: "z-rev" } })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/api/review/cases/RC-10001/assignment", headers: { authorization: `Bearer ${rev}` }, payload: { assigneeId: "z-rev" } })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/api/review/cases/RC-10001/assignment", headers: { authorization: `Bearer ${rev}` }, payload: { assigneeId: "z-other" } })).statusCode).toBe(403);
    const sup = await signIn(app, "sup@aroya.test");
    expect((await app.inject({ method: "POST", url: "/api/review/cases/RC-10001/assignment", headers: { authorization: `Bearer ${sup}` }, payload: { assigneeId: "z-rev" } })).statusCode).toBe(200);
  });

  it("lets reviewers comment but not audit users", async () => {
    let sent: any = null;
    const { app } = await appFor(rc(), (url, init) => { if (url.endsWith("/comments")) { sent = JSON.parse(init.body); return new Response("{}", { status: 201 }); } return new Response(JSON.stringify(CASE), { status: 200 }); });
    const rev = await signIn(app, "rev@aroya.test");
    expect((await app.inject({ method: "POST", url: "/api/review/cases/RC-10001/comments", headers: { authorization: `Bearer ${rev}` }, payload: { text: "Phoned the guest" } })).statusCode).toBe(201);
    expect(sent).toEqual({ authorId: "z-rev", text: "Phoned the guest" });
    const aud = await signIn(app, "aud@aroya.test");
    expect((await app.inject({ method: "POST", url: "/api/review/cases/RC-10001/comments", headers: { authorization: `Bearer ${aud}` }, payload: { text: "x" } })).statusCode).toBe(403);
  });

  it("says plainly when the review service is not connected", async () => {
    const { app } = await appFor(rc({ apiUrl: "" }));
    const tok = await signIn(app, "rev@aroya.test");
    const r = await app.inject({ url: "/api/review/cases", headers: { authorization: `Bearer ${tok}` } });
    expect(r.statusCode).toBe(503);
    expect(r.json().code).toBe("REVIEW_API_NOT_CONNECTED");
  });
});
