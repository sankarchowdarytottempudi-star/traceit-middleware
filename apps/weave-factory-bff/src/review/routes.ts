// Identity Review Workbench — server side (plan v2.1 §5.1, §5.2, §15).
//
// The page runs inside Zoho CRM as a Web Tab (an iframe). Sign-in: Zoho is the identity provider
// (OAuth 2 authorization code + PKCE, scope AaaServer.profile.READ — no CRM data scope, no extra
// licence). The sign-in runs in a top-level popup because Zoho's login page cannot be framed; the
// popup hands a short-lived opaque session token to the Workbench with postMessage (origin-checked,
// nonce-bound). The token travels as an Authorization header, never as a cookie, so third-party
// cookie blocking cannot break it and no request carries ambient credentials (no CSRF surface);
// POSTs additionally must come from this origin. Sessions end after REVIEW_IDLE_MINUTES idle and
// REVIEW_MAX_HOURS in total. Roles come from a server-side role map (Zoho user e-mail / ZUID / domain).
//
// Every case read and decision goes to the Integration Service review API (REVIEW_API_URL) with a
// service credential plus the reviewer's identity and roles. This server never calls Python,
// PostgreSQL or Zoho CRM data APIs; opening a case makes zero CRM reads by construction.
import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Config } from "../config.js";
import type { SessionStore } from "../sessionStore.js";
import { loadReviewConfig, rolesFor, type ReviewConfig, type ReviewRole } from "./config.js";
import { allowedActions, canAssign, canSee, canSeeProtected, decisionRequest, maskValue, maskView, slaOf } from "./logic.js";

interface Sess { zuid: string; email: string; name: string; roles: ReviewRole[]; created: number }
type Fetch = typeof fetch;

const b64url = (b: Buffer) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const problem = (reply: FastifyReply, status: number, code: string, message: string) =>
  reply.code(status).type("application/json").send({ code, message });

/** Headers for the Workbench page itself: frameable only by the customer's Zoho CRM. */
export function reviewPageHeaders(rc: ReviewConfig): Record<string, string> {
  return {
    "content-security-policy": `frame-ancestors 'self' ${rc.frameAncestors.join(" ")}`.trim(),
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "cache-control": "no-cache, no-store, must-revalidate",
  };
}

export function isReviewPath(url: string): boolean {
  const p = url.split("?")[0];
  return p === "/review" || p.startsWith("/review/");
}

export function registerReview(app: FastifyInstance, cfg: Config, store: SessionStore, opts: { fetch?: Fetch; rc?: ReviewConfig } = {}) {
  const rc = opts.rc ?? loadReviewConfig();
  const doFetch: Fetch = opts.fetch ?? fetch;
  const origin = new URL(cfg.PUBLIC_BASE_URL).origin;
  const redirectUri = `${cfg.PUBLIC_BASE_URL.replace(/\/+$/, "")}/api/review/auth/callback`;
  const idle = rc.idleMinutes * 60;

  app.addHook("onRequest", async (req, reply) => {
    if ((req.url.startsWith("/api/review/") || req.url === "/api/review") && !rc.enabled) {
      return problem(reply, 404, "NOT_FOUND", "Not found");
    }
  });

  async function session(req: FastifyRequest, reply: FastifyReply): Promise<Sess | null> {
    const h = req.headers.authorization ?? "";
    const m = /^Bearer ([A-Za-z0-9_-]{30,100})$/.exec(h);
    if (!m) { problem(reply, 401, "UNAUTHORIZED", "Sign in with your Zoho account."); return null; }
    const key = `review:sess:${sha(m[1])}`;
    const s = await store.get<Sess>(key);
    if (!s || Date.now() - s.created > rc.maxHours * 3600_000) {
      if (s) await store.del(key);
      problem(reply, 401, "UNAUTHORIZED", "Your session ended. Sign in again."); return null;
    }
    await store.set(key, s, idle); // sliding idle expiry
    if (!canSee(s.roles)) { problem(reply, 403, "FORBIDDEN", "Your account has no review role."); return null; }
    return s;
  }

  function sameOrigin(req: FastifyRequest, reply: FastifyReply): boolean {
    const o = req.headers.origin;
    if (o && o !== origin) { problem(reply, 403, "FORBIDDEN", "Requests must come from the Workbench."); return false; }
    return true;
  }

  async function upstream(s: Sess, method: string, path: string, body?: unknown): Promise<{ status: number; data: any }> {
    if (!rc.apiUrl) return { status: 503, data: { code: "REVIEW_API_NOT_CONNECTED", message: "The review service is not connected yet." } };
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 20_000);
    try {
      const r = await doFetch(`${rc.apiUrl}${path}`, {
        method,
        signal: ctl.signal,
        headers: {
          accept: "application/json",
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
          ...(rc.apiToken ? { authorization: `Bearer ${rc.apiToken}` } : {}),
          "x-reviewer-id": s.zuid,
          "x-reviewer-roles": s.roles.join(","),
          "x-correlation-id": `wb-${randomBytes(8).toString("hex")}`,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const text = await r.text();
      let data: any = null;
      try { data = text ? JSON.parse(text) : null; } catch { data = { code: "INTERNAL_ERROR", message: "The review service answered something unreadable." }; }
      return { status: r.status, data };
    } catch {
      return { status: 502, data: { code: "REVIEW_API_UNREACHABLE", message: "The review service did not answer. Try again." } };
    } finally { clearTimeout(t); }
  }

  const link = (id: unknown) => (rc.crmLinkBase && typeof id === "string" && /^[\w-]{1,40}$/.test(id) ? `${rc.crmLinkBase}/tab/Contacts/${id}` : null);

  function shapeCase(c: any, s: Sess) {
    const prot = canSeeProtected(s.roles);
    const incoming = c?.incoming ? maskView(c.incoming, prot) : c?.incoming;
    const candidates = Array.isArray(c?.candidates) ? c.candidates.map((x: any) => ({ ...maskView(x, prot), crmLink: link(x?.crmGuestRecordId) })) : [];
    return {
      ...c,
      incoming: incoming ? { ...incoming, crmLink: link(incoming.crmGuestRecordId) } : incoming,
      candidates,
      sla: slaOf(String(c?.kind ?? ""), c?.createdAt, rc.slaDays, rc.workWeek),
      allowedActions: allowedActions(s.roles, String(c?.caseStatus ?? "")),
      canAssign: canAssign(s.roles),
      protectedShown: prot,
    };
  }

  // ---- sign-in ----------------------------------------------------------------------------
  app.get("/api/review/info", async () => ({
    enabled: rc.enabled, signIn: !!(rc.zohoClientId && rc.zohoClientSecret), connected: !!rc.apiUrl,
  }));

  app.get("/api/review/auth/start", async (req, reply) => {
    if (!rc.zohoClientId || !rc.zohoClientSecret) return problem(reply, 503, "SIGN_IN_NOT_CONFIGURED", "Zoho sign-in is not configured yet.");
    const nonce = String((req.query as { nonce?: string }).nonce ?? "");
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(nonce)) return problem(reply, 400, "INVALID_REQUEST", "Open sign-in from the Workbench.");
    const state = b64url(randomBytes(24));
    const verifier = b64url(randomBytes(48));
    await store.set(`review:state:${state}`, { verifier, nonce }, 600);
    const q = new URLSearchParams({
      response_type: "code", client_id: rc.zohoClientId, scope: "AaaServer.profile.READ", redirect_uri: redirectUri,
      state, access_type: "online", prompt: "consent",
      code_challenge: b64url(createHash("sha256").update(verifier).digest()), code_challenge_method: "S256",
    });
    return reply.redirect(`${rc.zohoAccountsUrl}/oauth/v2/auth?${q.toString()}`);
  });

  const closePage = async (reply: FastifyReply, payload: Record<string, unknown>) => {
    const h = typeof payload.nonce === "string" ? payload.nonce : "";
    if (h) await store.set(`review:handoff:${h}`, payload, 120);
    const msg = JSON.stringify({ type: "weave-review-session", ...payload }).replace(/</g, "\\u003c");
    return reply
      .header("content-security-policy", "default-src 'none'; script-src 'unsafe-inline'; frame-ancestors 'none'")
      .header("cache-control", "no-store").header("referrer-policy", "no-referrer")
      .type("text/html; charset=utf-8")
      .send(`<!doctype html><meta charset="utf-8"><title>Signing in…</title><p style="font-family:system-ui">You can close this window.</p>
<script>try{window.opener&&window.opener.postMessage(${msg},${JSON.stringify(origin)});}catch(e){}setTimeout(function(){window.close()},300);</script>`);
  };

  app.get("/api/review/auth/callback", async (req, reply) => {
    const q = req.query as { code?: string; state?: string; error?: string };
    const st = q.state ? await store.get<{ verifier: string; nonce: string }>(`review:state:${q.state}`) : null;
    if (q.state) await store.del(`review:state:${q.state}`);
    if (!st || !q.code || q.error) return closePage(reply, { ok: false, error: "SIGN_IN_FAILED" });
    try {
      const tok = await doFetch(`${rc.zohoAccountsUrl}/oauth/v2/token`, {
        method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "authorization_code", client_id: rc.zohoClientId, client_secret: rc.zohoClientSecret,
          redirect_uri: redirectUri, code: q.code, code_verifier: st.verifier }).toString(),
      });
      const t = (await tok.json().catch(() => ({}))) as { access_token?: string };
      if (!tok.ok || !t.access_token) return closePage(reply, { ok: false, nonce: st.nonce, error: "SIGN_IN_FAILED" });
      const ui = await doFetch(`${rc.zohoAccountsUrl}/oauth/user/info`, { headers: { authorization: `Zoho-oauthtoken ${t.access_token}` } });
      const u = (await ui.json().catch(() => ({}))) as { Email?: string; ZUID?: string | number; Display_Name?: string; First_Name?: string };
      // The access token is only needed for the user's identity; give it back straight away.
      void doFetch(`${rc.zohoAccountsUrl}/oauth/v2/token/revoke?token=${encodeURIComponent(t.access_token)}`, { method: "POST" }).catch(() => undefined);
      const email = String(u.Email ?? "");
      const zuid = String(u.ZUID ?? "");
      if (!ui.ok || !email || !zuid) return closePage(reply, { ok: false, nonce: st.nonce, error: "SIGN_IN_FAILED" });
      const roles = rolesFor(rc.roleMap, email, zuid);
      if (!roles.length) return closePage(reply, { ok: false, nonce: st.nonce, error: "NO_REVIEW_ROLE" });
      const token = b64url(randomBytes(32));
      await store.set(`review:sess:${sha(token)}`, { zuid, email, name: String(u.Display_Name ?? u.First_Name ?? ""), roles, created: Date.now() } satisfies Sess, idle);
      return closePage(reply, { ok: true, nonce: st.nonce, token, idleMinutes: rc.idleMinutes });
    } catch {
      return closePage(reply, { ok: false, nonce: st.nonce, error: "SIGN_IN_FAILED" });
    }
  });

  // The Workbench holds a secret; sign-in only ever saw its hash. Presenting the secret once, within
  // two minutes, hands over the outcome. This works even when the sign-in window lost its link back.
  app.post("/api/review/auth/claim", async (req, reply) => {
    if (!sameOrigin(req, reply)) return;
    const secret = String((req.body as { secret?: string } | null)?.secret ?? "");
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(secret)) return problem(reply, 400, "INVALID_REQUEST", "Open sign-in from the Workbench.");
    const h = b64url(createHash("sha256").update(secret).digest());
    const got = await store.get<Record<string, unknown>>(`review:handoff:${h}`);
    if (!got) return reply.code(204).send();
    await store.del(`review:handoff:${h}`);
    return got;
  });

  app.get("/api/review/session", async (req, reply) => {
    const s = await session(req, reply); if (!s) return;
    return {
      user: { zuid: s.zuid, name: s.name, email: maskValue("email", s.email) },
      roles: s.roles, connected: !!rc.apiUrl, idleMinutes: rc.idleMinutes,
      expiresAt: new Date(s.created + rc.maxHours * 3600_000).toISOString(),
      slaDays: rc.slaDays, crmLinks: !!rc.crmLinkBase,
    };
  });

  app.post("/api/review/auth/logout", async (req, reply) => {
    const m = /^Bearer ([A-Za-z0-9_-]{30,100})$/.exec(req.headers.authorization ?? "");
    if (m) await store.del(`review:sess:${sha(m[1])}`);
    return reply.code(204).send();
  });

  // ---- cases (all through the Integration Service review API) -------------------------------
  const KINDS = /^(MULTIPLE_IDENTITY_CONFLICT|FOUR_FIELD_REVIEW|PAIR_REPAIR|REEVALUATION_CONFLICT|GUARDRAIL|SHADOW_CANDIDATE)$/;
  const STATUSES = /^REVIEW_[A-Z_]{3,30}$/;
  const CASE_ID = /^[A-Za-z0-9_.:-]{1,80}$/;

  app.get("/api/review/cases", async (req, reply) => {
    const s = await session(req, reply); if (!s) return;
    const q = req.query as { kind?: string; status?: string; mine?: string };
    const p = new URLSearchParams();
    if (q.kind && KINDS.test(q.kind)) p.set("kind", q.kind);
    if (q.status && STATUSES.test(q.status)) p.set("status", q.status);
    if (q.mine === "1") p.set("assignee", s.zuid);
    const r = await upstream(s, "GET", `/v1/review-cases${p.size ? `?${p.toString()}` : ""}`);
    if (r.status !== 200) return reply.code(r.status).send(r.data);
    const list: any[] = Array.isArray(r.data) ? r.data : Array.isArray(r.data?.cases) ? r.data.cases : [];
    const prot = canSeeProtected(s.roles);
    return {
      cases: list.slice(0, 500).map((c) => ({
        caseId: c.caseId, kind: c.kind, priority: c.priority, caseStatus: c.caseStatus, createdAt: c.createdAt,
        assignee: c.assignee ?? null, candidateCount: c.candidateCount ?? null, ruleVersion: c.ruleVersion,
        title: prot ? (c.title ?? null) : null,
        sla: slaOf(String(c.kind ?? ""), c.createdAt, rc.slaDays, rc.workWeek),
      })),
    };
  });

  app.get("/api/review/cases/:id", async (req, reply) => {
    const s = await session(req, reply); if (!s) return;
    const id = (req.params as { id: string }).id;
    if (!CASE_ID.test(id)) return problem(reply, 400, "INVALID_REQUEST", "Unknown case.");
    const r = await upstream(s, "GET", `/v1/review-cases/${encodeURIComponent(id)}`);
    if (r.status !== 200) return reply.code(r.status).send(r.data);
    return shapeCase(r.data, s);
  });

  app.get("/api/review/cases/:id/history", async (req, reply) => {
    const s = await session(req, reply); if (!s) return;
    const id = (req.params as { id: string }).id;
    if (!CASE_ID.test(id)) return problem(reply, 400, "INVALID_REQUEST", "Unknown case.");
    const r = await upstream(s, "GET", `/v1/review-cases/${encodeURIComponent(id)}/history`);
    return reply.code(r.status).send(r.status === 200 ? { history: Array.isArray(r.data) ? r.data : (r.data?.history ?? []) } : r.data);
  });

  app.post("/api/review/cases/:id/assignment", async (req, reply) => {
    if (!sameOrigin(req, reply)) return;
    const s = await session(req, reply); if (!s) return;
    const id = (req.params as { id: string }).id;
    if (!CASE_ID.test(id)) return problem(reply, 400, "INVALID_REQUEST", "Unknown case.");
    const assigneeId = String((req.body as { assigneeId?: unknown } | null)?.assigneeId ?? "");
    if (!/^[\w.@-]{1,80}$/.test(assigneeId)) return problem(reply, 400, "INVALID_REQUEST", "Choose who takes the case.");
    const self = assigneeId === s.zuid;
    const mayTake = s.roles.includes("IDENTITY_REVIEWER") || s.roles.includes("IDENTITY_SUPERVISOR");
    if (!(canAssign(s.roles) || (self && mayTake))) return problem(reply, 403, "FORBIDDEN", "Only a supervisor can give a case to someone else.");
    const r = await upstream(s, "POST", `/v1/review-cases/${encodeURIComponent(id)}/assignment`, { assigneeId, assignedBy: s.zuid });
    return reply.code(r.status).send(r.data);
  });

  app.post("/api/review/cases/:id/comments", async (req, reply) => {
    if (!sameOrigin(req, reply)) return;
    const s = await session(req, reply); if (!s) return;
    const id = (req.params as { id: string }).id;
    if (!CASE_ID.test(id)) return problem(reply, 400, "INVALID_REQUEST", "Unknown case.");
    if (!s.roles.some((r) => r === "IDENTITY_REVIEWER" || r === "IDENTITY_SUPERVISOR" || r === "CRM_ADMINISTRATOR")) return problem(reply, 403, "FORBIDDEN", "Your role can read cases but not comment.");
    const text = String((req.body as { text?: unknown } | null)?.text ?? "").trim();
    if (!text || text.length > 2000) return problem(reply, 400, "INVALID_REQUEST", "Write a comment of up to 2000 characters.");
    const r = await upstream(s, "POST", `/v1/review-cases/${encodeURIComponent(id)}/comments`, { authorId: s.zuid, text });
    return reply.code(r.status).send(r.data);
  });

  app.post("/api/review/cases/:id/decisions", async (req, reply) => {
    if (!sameOrigin(req, reply)) return;
    const s = await session(req, reply); if (!s) return;
    const id = (req.params as { id: string }).id;
    if (!CASE_ID.test(id)) return problem(reply, 400, "INVALID_REQUEST", "Unknown case.");
    // The case's current state decides what is allowed (read from the review projection, not CRM).
    const cur = await upstream(s, "GET", `/v1/review-cases/${encodeURIComponent(id)}`);
    if (cur.status !== 200) return reply.code(cur.status).send(cur.data);
    const d = decisionRequest(id, s.zuid, (req.body ?? {}) as Record<string, unknown>, s.roles, String(cur.data?.caseStatus ?? ""));
    if (!d.ok) return problem(reply, d.status, d.code, d.message);
    const r = await upstream(s, "POST", `/v1/review-cases/${encodeURIComponent(id)}/decisions`, d.body);
    return reply.code(r.status).send(r.data);
  });


}
