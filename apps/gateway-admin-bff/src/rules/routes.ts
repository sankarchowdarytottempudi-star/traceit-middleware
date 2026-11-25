// Gateway rules: everything an operator changes on a live API, from the API's own page, plus the
// global blocking rules, consumer applications/keys and policy usage. Every write is validated here,
// previewed in plain words, applied as API update -> new revision -> deploy, and written to the audit.
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Config } from "../config.js";
import { apimClient, ApimError, type ApimClient } from "./apim.js";
import { createAudit, type Audit } from "./audit.js";
import {
  ADDRESS_POLICY, addressPolicySpec, addressPolicySynapse, deploymentWords, planAccess, planTraffic, policyInfo, policyWords,
  readAddresses, readCors, readSecurity, readTraffic, revisionToPrune, MAX_REVISIONS, SECURITY_WORDS, type PolicyBook, type Plan,
} from "./model.js";
import {
  bad, blockBody, blockWords, checkAccess, checkApp, checkId, checkTraffic, KEY_TYPES, newPolicyBody, SubscribeInput, type Security,
} from "./validate.js";

type Who = { user: string; c: ApimClient; via: "user" | "service" };
const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

export function registerRuleRoutes(app: FastifyInstance, cfg: Config, opts: { audit?: Audit; now?: () => number } = {}) {
  const w = { baseUrl: cfg.APIM_BASE_URL, caPem: cfg.caPem };
  const audit = opts.audit ?? createAudit(cfg.GATEWAY_AUDIT_FILE || join(cfg.DATA_DIR || ".data", "gateway-audit.jsonl"));
  const stage: "production" | "uat" = cfg.GATEWAY_STAGE === "uat" ? "uat" : "production";
  const ipHeader = cfg.GATEWAY_CLIENT_IP_HEADER || "";
  const now = opts.now ?? (() => Date.now());
  const STAGE_WORD = stage === "production" ? "Production" : "UAT";

  // Which token can see the APIs: the person's own, or (fallback) the service credentials.
  const seen = new Map<string, { via: "user" | "service"; until: number }>();
  async function who(req: FastifyRequest): Promise<Who> {
    const t = await app.tokenForRequest(req);
    if (!t) throw Object.assign(new Error("Not signed in"), { statusCode: 401 });
    const user = (await app.userForRequest(req)) ?? "unknown";
    const k = sha(t);
    let s = seen.get(k);
    if (!s || s.until < now()) {
      let via: "user" | "service" = "user";
      try { if (!(await apimClient(w, t).apis()).length) via = "service"; } catch { via = "service"; }
      s = { via, until: now() + 60_000 };
      seen.set(k, s);
      if (seen.size > 500) seen.clear();
    }
    if (s.via === "service") {
      try { return { user, c: apimClient(w, await app.serviceToken()), via: "service" }; } catch { /* fall back to the person's token */ }
    }
    return { user, c: apimClient(w, t), via: "user" };
  }

  async function book(c: ApimClient): Promise<PolicyBook> {
    const [s, a, ap] = await Promise.all([c.policies("subscription"), c.policies("advanced"), c.policies("application").catch(() => [])]);
    return { subscription: s.map(policyInfo), advanced: a.map(policyInfo), application: ap.map(policyInfo) };
  }
  const apiSummary = (a: any) => ({ id: a.id, name: a.name, context: a.context, version: a.version, lifeCycleStatus: a.lifeCycleStatus, provider: a.provider,
    lastUpdatedTime: a.lastUpdatedTime ?? (a.updatedTime ? new Date(Number(a.updatedTime)).toISOString() : null), type: a.type });
  async function envTargets(c: ApimClient, id: string, chosen?: string[]) {
    const deps = (await c.deployments(id)).map((d: any) => ({ name: String(d.name), vhost: String(d.vhost ?? ""), revisionUuid: d.revisionUuid as string }));
    if (deps.length) return { deps, targets: deps.map((d) => ({ name: d.name, vhost: d.vhost })) };
    if (!chosen?.length) return { deps, targets: [] as { name: string; vhost: string }[] };
    const envs = await c.environments();
    const targets = chosen.map((n) => {
      const e = envs.find((x: any) => x.name === n);
      if (!e) bad(`Gateway environment "${n}" does not exist.`, "environments");
      return { name: String(e.name), vhost: String(e.vhosts?.[0]?.host ?? "localhost") };
    });
    return { deps, targets };
  }
  const liveSentence = (apiName: string, targets: { name: string; vhost: string }[]) => targets.length
    ? `This changes the live gateway for ${apiName} in ${STAGE_WORD} (${deploymentWords(targets)}). Gateways pick it up within about 15 seconds of saving.`
    : `${apiName} is not deployed to any gateway, so nothing live changes now. The change is saved and goes live at the next deployment.`;

  /** Preview or apply a planned change: PUT the API, make room for a revision, create it and deploy it. */
  async function previewOrApply(req: FastifyRequest, w0: Who, api: any, plan: Plan, action: string, chosen: string[] | undefined, extra?: () => Promise<void>) {
    const preview = String((req.query as any)?.preview ?? "") === "1";
    const { targets } = await envTargets(w0.c, api.id, chosen);
    const revs = targets.length ? await w0.c.revisions(api.id) : [];
    const prune = targets.length ? revisionToPrune(revs) : null;
    if (targets.length && revs.length >= MAX_REVISIONS && !prune)
      throw Object.assign(new Error(`API Manager keeps at most ${MAX_REVISIONS} revisions of an API and all of them are deployed. Undeploy an old revision first.`), { statusCode: 409 });
    const summary = {
      api: apiSummary(api), changes: plan.changes, noChange: plan.changes.length === 0,
      environments: targets, sentence: liveSentence(api.name, targets),
      pruneRevision: prune ? { id: prune.id, displayName: prune.displayName } : null,
      via: w0.via,
    };
    if (preview || summary.noChange) return { ...summary, applied: false };
    const note = `${action} by ${w0.user}: ${plan.changes.join(" ")}`.slice(0, 250);
    const base = { user: w0.user, action, apiId: api.id, apiName: api.name, environment: deploymentWords(targets), after: plan.changes.join(" ") };
    let step = "update the API";
    try {
      if (extra) { step = "prepare the API"; await extra(); }
      step = "update the API";
      await w0.c.putApi(api.id, plan.body);
      let revision: any = null;
      if (targets.length) {
        if (prune) { step = `remove old ${prune.displayName}`; await w0.c.deleteRevision(api.id, prune.id); }
        step = "create a revision";
        revision = await w0.c.createRevision(api.id, note);
        step = "deploy the revision";
        await w0.c.deploy(api.id, revision.id, targets);
      }
      await audit.write({ ...base, outcome: "ok", revision: revision?.displayName, detail: prune ? `removed undeployed ${prune.displayName} to make room` : undefined });
      return { ...summary, applied: true, revision: revision ? { id: revision.id, displayName: revision.displayName } : null };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await audit.write({ ...base, outcome: "failed", detail: `could not ${step}: ${msg}` });
      const saved = step === "create a revision" || step === "deploy the revision" || step.startsWith("remove old");
      throw Object.assign(new Error(saved ? `Saved on API Manager but not live: could not ${step} (${msg}). Open Change history to deploy it.` : `Nothing changed: could not ${step} (${msg}).`),
        { statusCode: e instanceof ApimError ? e.statusCode : 500 });
    }
  }

  // ---------------- context ----------------
  app.get("/api/rules/context", async (req) => {
    const x = await who(req);
    const envs = await x.c.environments().catch(() => []);
    return { stage, stageWord: STAGE_WORD, user: x.user, via: x.via, clientIpHeader: ipHeader, auditFile: !!audit.file,
      environments: envs.map((e: any) => ({ name: e.name, displayName: e.displayName ?? e.name, vhost: e.vhosts?.[0]?.host ?? "" })) };
  });

  app.get("/api/rules/apis", async (req) => {
    const x = await who(req);
    return { via: x.via, list: (await x.c.apis()).map(apiSummary) };
  });

  // ---------------- one API ----------------
  app.get("/api/rules/apis/:id", async (req) => {
    const id = checkId((req.params as any).id, "API id");
    const x = await who(req);
    const [api, b, deps, envs] = await Promise.all([x.c.api(id), book(x.c), x.c.deployments(id), x.c.environments().catch(() => [])]);
    const addr = readAddresses(api);
    return {
      stage, stageWord: STAGE_WORD, via: x.via, api: apiSummary(api),
      traffic: readTraffic(api),
      policies: b,
      access: { security: readSecurity(api), securityWords: SECURITY_WORDS[readSecurity(api)], cors: readCors(api), ipAllow: addr.allow, ipDeny: addr.deny, clientIpHeader: ipHeader },
      deployments: deps.map((d: any) => ({ name: d.name, vhost: d.vhost, revisionUuid: d.revisionUuid, deployedTime: d.deployedTime ?? null, status: d.status })),
      environments: envs.map((e: any) => ({ name: e.name, displayName: e.displayName ?? e.name, vhost: e.vhosts?.[0]?.host ?? "" })),
    };
  });

  app.post("/api/rules/apis/:id/traffic", async (req) => {
    const id = checkId((req.params as any).id, "API id");
    const x = await who(req);
    const [api, b] = await Promise.all([x.c.api(id), book(x.c)]);
    const input = checkTraffic(req.body, (api.operations ?? []).map((o: any) => ({ verb: String(o.verb), target: String(o.target) })),
      { subscription: b.subscription.map((p) => p.name), advanced: b.advanced.map((p) => p.name) });
    return previewOrApply(req, x, api, planTraffic(api, input, b), "traffic limits", input.environments);
  });

  app.post("/api/rules/apis/:id/access", async (req) => {
    const id = checkId((req.params as any).id, "API id");
    const x = await who(req);
    const api = await x.c.api(id);
    const input = checkAccess(req.body, { apiName: api.name, stage });
    const cur = readAddresses(api);
    const needPolicy = input.ipAllow.length + input.ipDeny.length > 0;
    const changed = cur.allow.join() !== input.ipAllow.join() || cur.deny.join() !== input.ipDeny.join();
    let policyId: string | null = null;
    if (needPolicy && changed) {
      const existing = (await x.c.apiOpPolicies(id).catch(() => [])).find((p: any) => p.name === ADDRESS_POLICY.name && p.version === ADDRESS_POLICY.version);
      policyId = existing?.id ?? null;
    }
    const plan = planAccess(api, input, policyId, ipHeader);
    if (input.security === "none" && readSecurity(api) !== "none")
      plan.changes.push(stage === "production" ? "WARNING: this is a production gateway. Anyone who knows the address can call this API without signing in." : "Warning: anyone who can reach this UAT gateway can call this API without signing in.");
    // Upload the API-specific address policy once, just before the update that uses it.
    const extra = needPolicy && changed && !policyId ? async () => {
      const up = await x.c.uploadApiOpPolicy(id, addressPolicySpec(), addressPolicySynapse());
      const fresh = planAccess(api, input, up?.id ?? null, ipHeader);
      plan.body = fresh.body;
    } : undefined;
    return previewOrApply(req, x, api, plan, "access", input.environments, extra);
  });

  app.get("/api/rules/apis/:id/consumers", async (req) => {
    const id = checkId((req.params as any).id, "API id");
    const x = await who(req);
    const subs = await x.c.subscriptions(id);
    return { list: subs.map((s: any) => ({ subscriptionId: s.subscriptionId, applicationId: s.applicationInfo?.applicationId, application: s.applicationInfo?.name,
      owner: s.applicationInfo?.subscriber, plan: s.throttlingPolicy, status: s.subscriptionStatus })) };
  });

  app.post("/api/rules/subscriptions/:subId/state", async (req) => {
    const subId = checkId((req.params as any).subId, "subscription id");
    const body = (req.body ?? {}) as { state?: string; apiId?: string };
    const state = String(body.state ?? "");
    if (!["BLOCKED", "PROD_ONLY_BLOCKED", "UNBLOCKED"].includes(state)) bad("State must be BLOCKED, PROD_ONLY_BLOCKED or UNBLOCKED.", "state");
    const apiId = checkId(body.apiId, "API id");
    const x = await who(req);
    const [api, subs] = await Promise.all([x.c.api(apiId), x.c.subscriptions(apiId)]);
    const sub = subs.find((s: any) => s.subscriptionId === subId);
    if (!sub) throw Object.assign(new Error("That subscription is not on this API."), { statusCode: 404 });
    const words: Record<string, string> = { BLOCKED: "blocked (no calls)", PROD_ONLY_BLOCKED: "production calls blocked, sandbox allowed", UNBLOCKED: "active" };
    const base = { user: x.user, action: "subscription state", apiId, apiName: api.name, target: `${sub.applicationInfo?.name} subscription`,
      before: words[sub.subscriptionStatus] ?? sub.subscriptionStatus, after: words[state] };
    try {
      if (state === "UNBLOCKED") await x.c.unblockSubscription(subId); else await x.c.blockSubscription(subId, state as any);
      await audit.write({ ...base, outcome: "ok" });
    } catch (e) { await audit.write({ ...base, outcome: "failed", detail: (e as Error).message }); throw e; }
    return { ok: true, state };
  });

  app.get("/api/rules/apis/:id/live", async (req) => {
    const id = checkId((req.params as any).id, "API id");
    const x = await who(req);
    const [api, deps, revs, lines] = await Promise.all([x.c.api(id), x.c.deployments(id), x.c.revisions(id).catch(() => []), audit.read({ apiId: id, limit: 1 })]);
    const gw = app.gwAnalytics;
    const status = gw?.status();
    let last5m = null, last1h = null;
    if (gw && status?.state === "active") {
      const cut = now() - 5 * 60_000;
      const rows = gw.recent({ api: api.name, limit: 1000 }).rows.filter((r) => r.ts >= cut);
      last5m = { requests: rows.length, errors: rows.filter((r) => r.status >= 400 || r.type === "fault").length, throttled: rows.filter((r) => r.throttled).length,
        refused: rows.filter((r) => r.status === 401 || r.status === 403).length };
      const t = gw.summary({ range: "1h", api: api.name }).totals;
      const refused = gw.summary({ range: "1h", api: api.name }).byStatus.filter((s) => s.status === 401 || s.status === 403).reduce((n, s) => n + s.requests, 0);
      last1h = { requests: t.requests, errors: t.clientErrors + t.serverErrors + t.faults, throttled: t.throttled, refused };
    }
    const revName = (uuid: string) => revs.find((r: any) => r.id === uuid)?.displayName ?? uuid;
    const last = lines[0];
    return {
      api: apiSummary(api), measured: !!last5m, analytics: status ? { state: status.state, detail: status.detail ?? null, lastEventAt: status.lastEventAt } : null,
      last5m, last1h,
      deployments: deps.map((d: any) => ({ name: d.name, vhost: d.vhost, revision: revName(d.revisionUuid), revisionId: d.revisionUuid, deployedTime: d.deployedTime ?? null })),
      lastChange: last ? { at: last.at, by: last.user, action: last.action, outcome: last.outcome, what: last.after ?? "" }
        : { at: api.lastUpdatedTime ?? null, by: null, action: "changed outside this console", outcome: "ok", what: "" },
    };
  });

  app.get("/api/rules/apis/:id/history", async (req) => {
    const id = checkId((req.params as any).id, "API id");
    const x = await who(req);
    const [revs, lines] = await Promise.all([x.c.revisions(id), audit.read({ apiId: id, limit: 100 })]);
    return {
      revisions: revs.map((r: any) => ({ id: r.id, displayName: r.displayName, description: r.description ?? "", createdTime: r.createdTime ?? null,
        deployedTo: (r.deploymentInfo ?? []).map((d: any) => ({ name: d.name, vhost: d.vhost, deployedTime: d.deployedTime ?? null })) }))
        .sort((a: any, b: any) => Number(b.createdTime) - Number(a.createdTime)),
      audit: lines, maxRevisions: MAX_REVISIONS,
    };
  });

  app.post("/api/rules/apis/:id/rollback", async (req) => {
    const id = checkId((req.params as any).id, "API id");
    const body = (req.body ?? {}) as { revisionId?: string };
    const revId = checkId(body.revisionId, "revision id");
    const preview = String((req.query as any)?.preview ?? "") === "1";
    const x = await who(req);
    const [api, revs] = await Promise.all([x.c.api(id), x.c.revisions(id)]);
    const rev = revs.find((r: any) => r.id === revId);
    if (!rev) throw Object.assign(new Error("That revision does not exist on this API."), { statusCode: 404 });
    const { deps, targets } = await envTargets(x.c, id);
    const current = deps.map((d) => revs.find((r: any) => r.id === d.revisionUuid)?.displayName ?? "unknown").join(", ") || "nothing deployed";
    const summary = {
      api: apiSummary(api), revision: { id: rev.id, displayName: rev.displayName, description: rev.description ?? "" },
      changes: [`Live definition: ${current} → ${rev.displayName}${rev.description ? ` ("${rev.description}")` : ""}.`, "The working copy in API Manager is reset to that revision too."],
      environments: targets, sentence: liveSentence(api.name, targets), noChange: false,
    };
    if (!targets.length) bad(`${api.name} is not deployed anywhere, so there is nothing to roll back.`);
    if (preview) return { ...summary, applied: false };
    const base = { user: x.user, action: "roll back", apiId: id, apiName: api.name, environment: deploymentWords(targets), before: current, after: rev.displayName, revision: rev.displayName };
    try {
      await x.c.restoreRevision(id, revId);
      await x.c.deploy(id, revId, targets);
      await audit.write({ ...base, outcome: "ok" });
    } catch (e) { await audit.write({ ...base, outcome: "failed", detail: (e as Error).message }); throw e; }
    return { ...summary, applied: true };
  });

  // ---------------- policies ----------------
  app.post("/api/rules/policies", async (req, reply) => {
    const x = await who(req);
    const b = await book(x.c);
    const all = [...b.subscription, ...b.advanced, ...(b.application ?? [])].map((p) => p.name);
    const { kind, body, name } = newPolicyBody(req.body, all);
    const base = { user: x.user, action: `create ${kind} limit`, target: name, after: String(body.description) };
    try { await x.c.createPolicy(kind, body); await audit.write({ ...base, outcome: "ok" }); }
    catch (e) { await audit.write({ ...base, outcome: "failed", detail: (e as Error).message }); throw e; }
    reply.code(201);
    return { ok: true, name, kind };
  });

  // Which APIs and applications use each policy (detail of every API; cached briefly).
  const detailCache = new Map<string, { at: number; data: any[] }>();
  async function allDetails(x: Who): Promise<any[]> {
    const k = x.via;
    const hit = detailCache.get(k);
    if (hit && now() - hit.at < 30_000) return hit.data;
    const list = await x.c.apis();
    const data: any[] = [];
    for (let i = 0; i < list.length; i += 6) {
      const part = await Promise.all(list.slice(i, i + 6).map(async (a: any) => {
        const [d, deps] = await Promise.all([x.c.api(a.id).catch(() => null), x.c.deployments(a.id).catch(() => [])]);
        return d ? { ...d, _deployments: deps } : null;
      }));
      data.push(...part.filter(Boolean));
    }
    detailCache.set(k, { at: now(), data });
    return data;
  }

  app.get("/api/rules/policies/usage", async (req) => {
    const x = await who(req);
    const [details, apps] = await Promise.all([allDetails(x), x.c.allApplications().catch(() => x.c.applications().catch(() => []))]);
    const use: Record<string, { apis: { id: string; name: string; how: string }[]; applications: string[] }> = {};
    const add = (name: string | null | undefined, entry: { id: string; name: string; how: string }) => {
      if (!name) return;
      (use[name] ??= { apis: [], applications: [] }).apis.push(entry);
    };
    for (const a of details) {
      for (const t of a.policies ?? []) add(t, { id: a.id, name: a.name, how: "plan consumers can pick" });
      if (a.apiThrottlingPolicy) add(a.apiThrottlingPolicy, { id: a.id, name: a.name, how: "limit for the whole API" });
      if (!a.apiThrottlingPolicy) for (const o of a.operations ?? []) if (o.throttlingPolicy && o.throttlingPolicy !== "Unlimited") add(o.throttlingPolicy, { id: a.id, name: a.name, how: `limit on ${o.verb} ${o.target}` });
    }
    for (const ap of apps) { const p = ap.throttlingPolicy ?? ap.throttlingTier; if (p) (use[p] ??= { apis: [], applications: [] }).applications.push(ap.name); }
    return { usage: use, apis: details.map((a) => ({ id: a.id, name: a.name })) };
  });

  // ---------------- overview signals ----------------
  app.get("/api/rules/overview", async (req) => {
    const x = await who(req);
    const [details, deny, lines] = await Promise.all([allDetails(x), x.c.denyPolicies().catch(() => null), audit.read({ limit: 8 })]);
    const perEnv: Record<string, { live: number; apis: string[] }> = {};
    for (const a of details) for (const d of a._deployments ?? []) { const e = (perEnv[d.name] ??= { live: 0, apis: [] }); e.live++; e.apis.push(a.name); }
    const open = details.filter((a) => readSecurity(a) === "none").map((a) => ({ id: a.id, name: a.name, live: (a._deployments ?? []).length > 0 }));
    const published = details.filter((a) => a.lifeCycleStatus === "PUBLISHED").length;
    const notDeployed = details.filter((a) => a.lifeCycleStatus === "PUBLISHED" && !(a._deployments ?? []).length).map((a) => ({ id: a.id, name: a.name }));
    const gw = app.gwAnalytics; const st = gw?.status();
    let now15 = null;
    if (gw && st?.state === "active") {
      const s = gw.summary({ range: "15m" });
      now15 = { requests: s.totals.requests, throttled: s.totals.throttled, refused: s.byStatus.filter((b) => b.status === 401 || b.status === 403).reduce((n, b) => n + b.requests, 0),
        errors: s.totals.serverErrors + s.totals.faults,
        topThrottled: s.byApi.filter((r) => r.throttled > 0).sort((a, b) => b.throttled - a.throttled).slice(0, 5).map((r) => ({ name: r.label, throttled: r.throttled })) };
    }
    const recent = lines.length ? lines.map((l) => ({ at: l.at, by: l.user, action: l.action, apiId: l.apiId ?? null, apiName: l.apiName ?? l.target ?? "", outcome: l.outcome, what: l.after ?? "" }))
      : details.filter((a) => a.lastUpdatedTime).sort((a, b) => String(b.lastUpdatedTime).localeCompare(String(a.lastUpdatedTime))).slice(0, 6)
        .map((a) => ({ at: a.lastUpdatedTime, by: null, action: "changed in API Manager", apiId: a.id, apiName: a.name, outcome: "ok", what: "" }));
    return {
      stage, stageWord: STAGE_WORD, via: x.via, total: details.length, published, environments: perEnv, notDeployed, open,
      blocking: deny ? { total: deny.length, active: deny.filter((d: any) => d.conditionStatus !== false).length } : null,
      traffic: now15, analytics: st ? { state: st.state, detail: st.detail ?? null } : null, recent,
    };
  });

  // ---------------- blocking rules (global) ----------------
  app.get("/api/rules/blocking", async (req) => {
    const x = await who(req);
    const list = await x.c.denyPolicies();
    return { list: list.map((d: any) => ({ id: d.conditionId, type: d.conditionType, value: d.conditionValue, enabled: d.conditionStatus !== false, words: blockWords(d.conditionType, d.conditionValue) })) };
  });
  app.post("/api/rules/blocking", async (req, reply) => {
    const x = await who(req);
    const needCtx = (req.body as any)?.type === "API";
    const apis = needCtx ? await x.c.apis() : [];
    const body = blockBody(req.body, { apiContexts: apis.flatMap((a: any) => [`${a.context}/${a.version}`, a.context]).map((s: string) => s.replace(/\/+/g, "/")), appNames: [] });
    const words = blockWords(body.conditionType, body.conditionValue);
    const base = { user: x.user, action: "add blocking rule", target: words, after: `${words}: ${body.conditionStatus ? "blocked now on every gateway" : "saved, not enforced"}` };
    let created: any;
    try { created = await x.c.createDeny(body); await audit.write({ ...base, outcome: "ok" }); }
    catch (e) { await audit.write({ ...base, outcome: "failed", detail: (e as Error).message }); throw e; }
    reply.code(201);
    return { id: created?.conditionId, words };
  });
  app.patch("/api/rules/blocking/:id", async (req) => {
    const id = checkId((req.params as any).id, "rule id");
    const on = (req.body as any)?.enabled;
    if (typeof on !== "boolean") bad("Say whether the rule is enabled (true or false).", "enabled");
    const x = await who(req);
    const cur = (await x.c.denyPolicies()).find((d: any) => d.conditionId === id);
    if (!cur) throw Object.assign(new Error("That blocking rule does not exist."), { statusCode: 404 });
    const words = blockWords(cur.conditionType, cur.conditionValue);
    const base = { user: x.user, action: on ? "enable blocking rule" : "disable blocking rule", target: words, before: cur.conditionStatus !== false ? "enforced" : "not enforced", after: on ? "enforced" : "not enforced" };
    try { await x.c.setDeny(id, on); await audit.write({ ...base, outcome: "ok" }); }
    catch (e) { await audit.write({ ...base, outcome: "failed", detail: (e as Error).message }); throw e; }
    return { ok: true, enabled: on };
  });
  app.delete("/api/rules/blocking/:id", async (req) => {
    const id = checkId((req.params as any).id, "rule id");
    const x = await who(req);
    const cur = (await x.c.denyPolicies()).find((d: any) => d.conditionId === id);
    if (!cur) throw Object.assign(new Error("That blocking rule does not exist."), { statusCode: 404 });
    const words = blockWords(cur.conditionType, cur.conditionValue);
    const base = { user: x.user, action: "remove blocking rule", target: words, before: words, after: "removed" };
    try { await x.c.deleteDeny(id); await audit.write({ ...base, outcome: "ok" }); }
    catch (e) { await audit.write({ ...base, outcome: "failed", detail: (e as Error).message }); throw e; }
    return { ok: true };
  });

  // ---------------- applications & keys ----------------
  const keyView = (k: any) => ({ keyMappingId: k.keyMappingId, keyType: k.keyType, keyManager: k.keyManager, consumerKey: k.consumerKey ?? null,
    state: k.keyState ?? null, grantTypes: k.supportedGrantTypes ?? [] });
  app.get("/api/rules/applications", async (req) => {
    const x = await who(req);
    const [apps, b] = await Promise.all([x.c.applications(), x.c.policies("application").catch(() => [])]);
    return { owner: x.via === "service" ? "service account" : x.user, plans: b.map(policyInfo),
      list: apps.map((a: any) => ({ id: a.applicationId, name: a.name, plan: a.throttlingPolicy, description: a.description ?? "", owner: a.owner, subscriptions: a.subscriptionCount ?? 0, status: a.status })) };
  });
  app.get("/api/rules/applications/:id", async (req) => {
    const id = checkId((req.params as any).id, "application id");
    const x = await who(req);
    const [a, keys, subs] = await Promise.all([x.c.application(id), x.c.keys(id).catch(() => []), x.c.appSubscriptions(id).catch(() => [])]);
    return { id: a.applicationId, name: a.name, plan: a.throttlingPolicy, description: a.description ?? "", owner: a.owner,
      keys: keys.map(keyView),
      subscriptions: subs.map((s: any) => ({ subscriptionId: s.subscriptionId, apiId: s.apiId, apiName: s.apiInfo?.name ?? s.apiId, apiVersion: s.apiInfo?.version ?? "", plan: s.throttlingPolicy, status: s.status })) };
  });
  app.post("/api/rules/applications", async (req, reply) => {
    const x = await who(req);
    const [apps, plans] = await Promise.all([x.c.applications(), x.c.policies("application")]);
    const v = checkApp(req.body, plans.map((p: any) => p.policyName), apps.map((a: any) => a.name));
    const base = { user: x.user, action: "create application", target: v.name, after: `application ${v.name}, limit ${v.plan}` };
    let created: any;
    try { created = await x.c.createApplication({ name: v.name, throttlingPolicy: v.plan, description: v.description, tokenType: "JWT" }); await audit.write({ ...base, outcome: "ok" }); }
    catch (e) { await audit.write({ ...base, outcome: "failed", detail: (e as Error).message }); throw e; }
    reply.code(201);
    return { id: created?.applicationId, name: v.name };
  });
  app.delete("/api/rules/applications/:id", async (req) => {
    const id = checkId((req.params as any).id, "application id");
    const x = await who(req);
    const a = await x.c.application(id);
    if (String((req.body as any)?.confirm ?? "") !== a.name) bad(`Deleting ${a.name} cuts off every caller using its keys. Type the application name to confirm.`, "confirm");
    const base = { user: x.user, action: "delete application", target: a.name, before: `application ${a.name} with ${a.subscriptionCount ?? 0} subscriptions`, after: "deleted" };
    try { await x.c.deleteApplication(id); await audit.write({ ...base, outcome: "ok" }); }
    catch (e) { await audit.write({ ...base, outcome: "failed", detail: (e as Error).message }); throw e; }
    return { ok: true };
  });
  app.post("/api/rules/applications/:id/keys", async (req) => {
    const id = checkId((req.params as any).id, "application id");
    const keyType = String((req.body as any)?.keyType ?? "");
    if (!(KEY_TYPES as readonly string[]).includes(keyType)) bad("Key type must be PRODUCTION or SANDBOX.", "keyType");
    const x = await who(req);
    const [a, kms, keys] = await Promise.all([x.c.application(id), x.c.keyManagers().catch(() => []), x.c.keys(id).catch(() => [])]);
    if (keys.some((k: any) => k.keyType === keyType)) bad(`${a.name} already has ${keyType.toLowerCase()} keys. Regenerate the secret or remove them first.`, "keyType");
    const km = (kms.find((k: any) => k.enabled !== false && /resident/i.test(k.name)) ?? kms.find((k: any) => k.enabled !== false))?.name ?? "Resident Key Manager";
    const base = { user: x.user, action: "generate keys", target: `${a.name} ${keyType.toLowerCase()} keys`, after: "consumer key and secret issued" };
    let k: any;
    try { k = await x.c.generateKeys(id, keyType, km); await audit.write({ ...base, outcome: "ok" }); }
    catch (e) { await audit.write({ ...base, outcome: "failed", detail: (e as Error).message }); throw e; }
    return { ...keyView(k), consumerSecret: k.consumerSecret ?? null, shownOnce: true };
  });
  app.post("/api/rules/applications/:id/keys/:km/regenerate", async (req) => {
    const id = checkId((req.params as any).id, "application id");
    const km = checkId((req.params as any).km, "key id");
    const x = await who(req);
    const a = await x.c.application(id);
    const base = { user: x.user, action: "regenerate secret", target: `${a.name} keys`, after: "new consumer secret; the old secret stops working" };
    let r: any;
    try { r = await x.c.regenerateSecret(id, km); await audit.write({ ...base, outcome: "ok" }); }
    catch (e) { await audit.write({ ...base, outcome: "failed", detail: (e as Error).message }); throw e; }
    return { consumerKey: r?.consumerKey ?? null, consumerSecret: r?.consumerSecret ?? null, shownOnce: true };
  });
  app.post("/api/rules/applications/:id/keys/:km/revoke", async (req) => {
    const id = checkId((req.params as any).id, "application id");
    const km = checkId((req.params as any).km, "key id");
    const x = await who(req);
    const a = await x.c.application(id);
    if (String((req.body as any)?.confirm ?? "") !== a.name) bad(`Removing these keys stops every caller that uses them. Type ${a.name} to confirm.`, "confirm");
    const base = { user: x.user, action: "remove keys", target: `${a.name} keys`, before: "keys issued", after: "keys removed" };
    try { await x.c.removeKeys(id, km); await audit.write({ ...base, outcome: "ok" }); }
    catch (e) { await audit.write({ ...base, outcome: "failed", detail: (e as Error).message }); throw e; }
    return { ok: true };
  });
  app.post("/api/rules/applications/:id/subscriptions", async (req, reply) => {
    const id = checkId((req.params as any).id, "application id");
    const p = SubscribeInput.safeParse({ ...(req.body as any), applicationId: id });
    if (!p.success) bad("Choose an API and a plan.");
    const x = await who(req);
    const [a, api] = await Promise.all([x.c.application(id), x.c.api(p.data!.apiId)]);
    if (!(api.policies ?? []).includes(p.data!.plan)) bad(`${api.name} does not offer plan ${p.data!.plan}. Offered: ${(api.policies ?? []).join(", ") || "none"}.`, "plan");
    const base = { user: x.user, action: "subscribe", apiId: api.id, apiName: api.name, target: a.name, after: `${a.name} subscribed with plan ${p.data!.plan}` };
    let s: any;
    try { s = await x.c.subscribe(id, api.id, p.data!.plan); await audit.write({ ...base, outcome: "ok" }); }
    catch (e) { await audit.write({ ...base, outcome: "failed", detail: (e as Error).message }); throw e; }
    reply.code(201);
    return { subscriptionId: s?.subscriptionId, status: s?.status };
  });
  app.delete("/api/rules/applications/:id/subscriptions/:subId", async (req) => {
    const id = checkId((req.params as any).id, "application id");
    const subId = checkId((req.params as any).subId, "subscription id");
    const x = await who(req);
    const [a, subs] = await Promise.all([x.c.application(id), x.c.appSubscriptions(id)]);
    const s = subs.find((y: any) => y.subscriptionId === subId);
    if (!s) throw Object.assign(new Error("That subscription is not on this application."), { statusCode: 404 });
    const base = { user: x.user, action: "unsubscribe", apiId: s.apiId, apiName: s.apiInfo?.name, target: a.name, before: `subscribed with plan ${s.throttlingPolicy}`, after: "unsubscribed" };
    try { await x.c.unsubscribe(subId); await audit.write({ ...base, outcome: "ok" }); }
    catch (e) { await audit.write({ ...base, outcome: "failed", detail: (e as Error).message }); throw e; }
    return { ok: true };
  });

  app.get("/api/rules/audit", async (req) => {
    await who(req);
    const q = req.query as any;
    return { list: await audit.read({ apiId: typeof q?.apiId === "string" ? q.apiId : undefined, limit: Math.min(500, Number(q?.limit) || 100) }) };
  });

  return { audit };
}

export type { Security };
export { policyWords };
