import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Config } from "./config.js";
import { api } from "./wso2.js";
import * as R from "./reshape.js";
import type { Audit } from "./rules/audit.js";
import { BadInput, POLICY_NAME, rateWords } from "./rules/validate.js";

const ADMIN = "/api/am/admin/v4";
const GOV = "/api/am/governance/v1";
const PUB = "/api/am/publisher/v4";

const SUB_PATH: Record<string, string> = {
  advanced: `${ADMIN}/throttling/policies/advanced`,
  application: `${ADMIN}/throttling/policies/application`,
  subscription: `${ADMIN}/throttling/policies/subscription`,
  custom: `${ADMIN}/throttling/policies/custom`,
  deny: `${ADMIN}/throttling/deny-policies`,
};

const WRITABLE = ["advanced", "application", "subscription"];

/** Server-side check of a throttling policy body sent by the Rate limiting screen. */
export function checkPolicyBody(type: string, body: any, isNew: boolean): string {
  if (!WRITABLE.includes(type)) throw new BadInput(`Policies of type "${type}" cannot be changed from this console.`);
  const name = String(body?.policyName ?? "").trim();
  if (isNew && !POLICY_NAME.test(name)) throw new BadInput("Name the policy with letters, digits and underscores only (up to 60). API Manager refuses dashes, dots and spaces.");
  const rc = body?.defaultLimit?.requestCount;
  if (body?.defaultLimit?.type !== "REQUESTCOUNTLIMIT" || !rc) throw new BadInput("Only request-count limits can be set from this console.");
  const n = Number(rc.requestCount);
  if (!Number.isInteger(n) || n < 1 || n > 1_000_000_000) throw new BadInput("Requests must be a whole number between 1 and 1,000,000,000.");
  if (!["sec", "min", "hour", "day"].includes(String(rc.timeUnit))) throw new BadInput("Time unit must be second, minute, hour or day.");
  return rateWords(n, String(rc.timeUnit), Number(rc.unitTime) || 1);
}

export function registerRoutes(app: FastifyInstance, cfg: Config, audit?: Audit) {
  const w = { baseUrl: cfg.APIM_BASE_URL, caPem: cfg.caPem };

  async function need(req: FastifyRequest): Promise<string> {
    const t = await app.tokenForRequest(req);
    if (!t) throw Object.assign(new Error("Not signed in"), { statusCode: 401 });
    return t;
  }

  app.get("/api/ratelimits/:type", async (req) => {
    const { type } = req.params as { type: string };
    const t = await need(req);
    const { json } = await api(w, t, "GET", SUB_PATH[type] ?? SUB_PATH.subscription);
    const list = json?.list ?? (Array.isArray(json) ? json : []);
    if (type === "subscription") return { list: R.reshapeSubPolicies(list) };
    if (type === "advanced" || type === "custom") return { list: R.reshapeAdvanced(list) };
    if (type === "deny") return { list };
    return { list: R.reshapeAdvanced(list) };
  });

  async function actor(req: FastifyRequest) { return (await app.userForRequest?.(req)) ?? "unknown"; }
  app.post("/api/ratelimits/:type", async (req, reply) => {
    const { type } = req.params as { type: string };
    const words = checkPolicyBody(type, req.body, true);
    const t = await need(req);
    const body = { ...(req.body as any) };
    if (type === "subscription") body.billingPlan ??= "FREE";
    const { status, json } = await api(w, t, "POST", SUB_PATH[type], body);
    await audit?.write({ user: await actor(req), action: `create ${type} limit`, target: String(body.policyName), after: words, outcome: status < 400 ? "ok" : "failed", detail: status < 400 ? undefined : String(json?.description ?? json?.message ?? status) });
    reply.code(status === 0 ? 502 : status);
    return json;
  });
  app.put("/api/ratelimits/:type/:id", async (req, reply) => {
    const { type, id } = req.params as { type: string; id: string };
    const words = checkPolicyBody(type, req.body, false);
    if (!/^[0-9a-fA-F-]{8,64}$/.test(id)) throw new BadInput("That policy id is not valid.");
    const t = await need(req);
    const { status, json } = await api(w, t, "PUT", `${SUB_PATH[type]}/${id}`, req.body);
    await audit?.write({ user: await actor(req), action: `change ${type} limit`, target: String((req.body as any)?.policyName ?? id), after: words, outcome: status < 400 ? "ok" : "failed" });
    reply.code(status === 0 ? 502 : status);
    return json;
  });
  app.delete("/api/ratelimits/:type/:id", async (req, reply) => {
    const { type, id } = req.params as { type: string; id: string };
    if (!WRITABLE.includes(type)) throw new BadInput(`Policies of type "${type}" cannot be changed from this console.`);
    if (!/^[0-9a-fA-F-]{8,64}$/.test(id)) throw new BadInput("That policy id is not valid.");
    const t = await need(req);
    const { status, json } = await api(w, t, "DELETE", `${SUB_PATH[type]}/${id}`);
    await audit?.write({ user: await actor(req), action: `delete ${type} limit`, target: id, after: "deleted", outcome: status < 400 && status > 0 ? "ok" : "failed", detail: status < 400 ? undefined : String(json?.description ?? json?.message ?? status) });
    reply.code(status === 0 ? 502 : status);
    return status < 400 ? { ok: true } : { type: "about:blank", title: String(json?.description ?? json?.message ?? "API Manager refused the change"), status };
  });

  app.get("/api/environments", async (req) => {
    const t = await need(req);
    const { json } = await api(w, t, "GET", `${ADMIN}/environments`);
    return { list: R.reshapeEnvironments(json?.list ?? []) };
  });
  app.get("/api/key-managers", async (req) => {
    const t = await need(req);
    const { json } = await api(w, t, "GET", `${ADMIN}/key-managers`);
    return { list: R.reshapeKeyManagers(json?.list ?? []) };
  });

  // Governance (API Manager 4.5 governance REST API: policies, rulesets, artifact compliance).
  // Falls back to the service credentials when the signed-in token lacks the governance scopes.
  async function gov(req: FastifyRequest, path: string): Promise<{ status: number; json: any }> {
    const t = await need(req);
    let r = await api(w, t, "GET", `${GOV}${path}`).catch(() => ({ status: 0, json: null }));
    if ((r.status === 401 || r.status === 403) && app.serviceToken) {
      const st = await app.serviceToken().catch(() => "");
      if (st && st !== t) r = await api(w, st, "GET", `${GOV}${path}`).catch(() => ({ status: 0, json: null }));
    }
    return r;
  }
  const sev = (a: any, k: string) => Number((a?.severityBasedRuleViolationSummary ?? []).find((x: any) => String(x.severity).toUpperCase() === k)?.violatedRulesCount ?? 0);

  app.get("/api/compliance", async (req) => {
    const [list, summary, policies, rulesets] = await Promise.all([gov(req, "/artifact-compliance/api?limit=500"), gov(req, "/artifact-compliance/api/summary"),
      gov(req, "/policies?limit=100"), gov(req, "/rulesets?limit=100")]);
    if (list.status !== 200) {
      return { available: false, reason: list.status === 404 ? "The governance API is not enabled on this API Manager." : list.status === 401 || list.status === 403 ? "The console's account is not allowed to read governance results (scopes apim:gov_result_read, apim:gov_policy_read, apim:gov_rule_read)." : `API Manager answered ${list.status || "nothing"} for the governance results.`,
        governed: 0, compliant: 0, total: 0, errors: 0, warnings: 0, info: 0, apis: [], policies: [], rulesets: [], policyAdherencePct: 0, apiCompliancePct: 0 };
    }
    const rs = (rulesets.json?.list ?? []).map((r: any) => ({ id: r.id, name: r.name, ruleType: r.ruleType, provider: r.provider, documentationLink: r.documentationLink ?? null }));
    const pol = (policies.json?.list ?? []).map((p: any) => ({ id: p.id, name: p.name, labels: p.labels ?? [], states: p.governableStates ?? [],
      rulesets: (p.rulesets ?? []).map((id: string) => rs.find((r: any) => r.id === id)?.name ?? id),
      blocking: (p.actions ?? []).some((a: any) => a.type === "BLOCK") }));
    const apis = (list.json?.list ?? []).map((a: any) => ({ apiId: a.id, name: a.info?.name ?? a.id, version: a.info?.version ?? "", status: a.status,
      errors: sev(a, "ERROR"), warnings: sev(a, "WARN"), info: sev(a, "INFO"), policy: pol.map((p: any) => p.name).join(", ") || "No policy" }));
    const sm = summary.json ?? {};
    const total = Number(sm.total ?? apis.length);
    const governed = total - Number(sm.notApplicable ?? 0);
    const compliant = Number(sm.compliant ?? apis.filter((a: any) => a.status === "COMPLIANT").length);
    const sum = (k: string) => apis.reduce((n: number, a: any) => n + (a[k] ?? 0), 0);
    return { ...R.rankCompliance({ governed, compliant, total: governed, errors: sum("errors"), warnings: sum("warnings"), info: sum("info"), apis }),
      available: true, pending: Number(sm.pending ?? 0), policies: pol, rulesets: rs };
  });

  app.get("/api/compliance/:apiId", async (req) => {
    const { apiId } = req.params as { apiId: string };
    if (!/^[0-9a-fA-F-]{8,64}$/.test(apiId)) throw new BadInput("That API id is not valid.");
    const d = await gov(req, `/artifact-compliance/api/${apiId}`);
    if (d.status !== 200) return { apiId, violations: [], policies: [] };
    const failed: { id: string; name: string; policy: string }[] = [];
    for (const p of d.json?.governedPolicies ?? []) for (const r of p.rulesetValidationResults ?? []) if (r.status === "FAILED") failed.push({ id: r.id, name: r.name, policy: p.name });
    const results = await Promise.all(failed.map((f) => gov(req, `/artifact-compliance/api/${apiId}/ruleset-validation-results/${f.id}`).then((x) => ({ f, x }))));
    const violations = results.flatMap(({ f, x }) => (x.json?.violatedRules ?? []).map((v: any) => ({
      ruleName: v.name, severity: String(v.severity ?? "WARN").toUpperCase(), message: v.message ?? "", path: v.violatedPath?.path ?? undefined,
      fix: typeof v.description === "string" ? v.description.slice(0, 1500) : "", ruleset: f.name, policy: f.policy })));
    const order: Record<string, number> = { ERROR: 0, WARN: 1, INFO: 2 };
    violations.sort((a: any, b: any) => (order[a.severity] ?? 3) - (order[b.severity] ?? 3));
    return { apiId, status: d.json?.status, violations,
      policies: (d.json?.governedPolicies ?? []).map((p: any) => ({ name: p.name, status: p.status, rulesets: (p.rulesetValidationResults ?? []).map((r: any) => ({ name: r.name, status: r.status })) })) };
  });

  app.get("/api/workflows", async (req) => {
    const t = await need(req);
    const types = ["AM_API_STATE","AM_APPLICATION_CREATION","AM_SUBSCRIPTION_CREATION","AM_USER_SIGNUP",
      "AM_APPLICATION_REGISTRATION_PRODUCTION","AM_APPLICATION_REGISTRATION_SANDBOX","AM_API_PRODUCT_STATE",
      "AM_REVISION_DEPLOYMENT","AM_APPLICATION_DELETION","AM_SUBSCRIPTION_DELETION"];
    const out: any[] = [];
    for (const wt of types) {
      const { json } = await api(w, t, "GET", `${ADMIN}/workflows?workflowType=${wt}&limit=25`).catch(() => ({ json: { list: [] } }));
      const list = (json?.list ?? []).map((r: any) => ({ referenceId: r.referenceId, type: wt,
        requester: r.properties?.requester ?? r.createdBy ?? "unknown", description: r.description ?? wt, createdTime: r.createdTime ?? "" }));
      out.push({ type: wt, label: wt.replace(/^AM_/, "").replace(/_/g, " ").toLowerCase(), pending: list.length, requests: list });
    }
    return { types: out };
  });
  app.post("/api/workflows/:referenceId", async (req, reply) => {
    const { referenceId } = req.params as { referenceId: string };
    if (!/^[A-Za-z0-9-]{1,64}$/.test(referenceId)) throw new BadInput("That request reference is not valid.");
    const decision = String((req.body as any)?.status ?? "APPROVED");
    if (!["APPROVED", "REJECTED"].includes(decision)) throw new BadInput("Decision must be APPROVED or REJECTED.");
    const t = await need(req);
    const { status: s, json } = await api(w, t, "POST", `${ADMIN}/workflows/update-workflow-status?workflowReferenceId=${referenceId}`, { status: decision, description: String((req.body as any)?.description ?? "").slice(0, 500) });
    await audit?.write({ user: await actor(req), action: decision === "APPROVED" ? "approve request" : "reject request", target: referenceId, after: decision.toLowerCase(), outcome: s > 0 && s < 400 ? "ok" : "failed" });
    reply.code(s === 0 ? 500 : s);
    return json ?? { ok: s < 400 };
  });

  app.get("/api/apis", async (req) => {
    const t = await need(req);
    const { json } = await api(w, t, "GET", `${PUB}/apis?limit=200`);
    return { list: R.reshapeApis(json?.list ?? []) };
  });
}
