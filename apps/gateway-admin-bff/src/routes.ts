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

  app.get("/api/compliance", async (req) => {
    const t = await need(req);
    const { json } = await api(w, t, "GET", `${GOV}/compliance/api-compliance/summary`).catch(() => ({ json: null }));
    const apis = (json?.complianceSummary?.apis ?? json?.apis ?? []).map((a: any) => ({
      apiId: a.apiId ?? a.id, name: a.name, version: a.version ?? "v1",
      errors: a.errors ?? a.severityBasedRuleViolationSummary?.error ?? 0,
      warnings: a.warnings ?? a.severityBasedRuleViolationSummary?.warn ?? 0,
      info: a.info ?? a.severityBasedRuleViolationSummary?.info ?? 0,
      policy: a.policy ?? "WSO2 API Management Best Practices",
    }));
    const total = apis.length;
    const compliant = apis.filter((a: any) => a.errors === 0 && a.warnings === 0).length;
    const sum = (k: string) => apis.reduce((n: number, a: any) => n + (a[k] ?? 0), 0);
    return R.rankCompliance({ governed: total, compliant, total, errors: sum("errors"), warnings: sum("warnings"), info: sum("info"), apis });
  });

  app.get("/api/compliance/:apiId", async (req) => {
    const { apiId } = req.params as { apiId: string };
    const t = await need(req);
    const { json } = await api(w, t, "GET", `${GOV}/compliance/apis/${apiId}`).catch(() => ({ json: null }));
    const violations = (json?.ruleViolations ?? json?.violations ?? []).map((v: any) => ({
      ruleName: v.ruleName ?? v.name, severity: (v.severity ?? "WARN").toUpperCase(), message: v.message ?? v.ruleMessage ?? "", path: v.path,
    }));
    return { apiId, violations };
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
