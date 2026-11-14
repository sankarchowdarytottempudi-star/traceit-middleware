import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Config } from "./config.js";
import { api } from "./wso2.js";
import * as R from "./reshape.js";

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

export function registerRoutes(app: FastifyInstance, cfg: Config) {
  const w = { baseUrl: cfg.APIM_BASE_URL, caPem: cfg.caPem };

  async function token(req: FastifyRequest): Promise<string | null> {
    const sid = req.unsignCookie(req.cookies.sid ?? "").value;
    return sid ? app.tokenFor(sid) : null;
  }
  async function need(req: FastifyRequest): Promise<string> {
    const t = await token(req);
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

  app.post("/api/ratelimits/:type", async (req, reply) => {
    const { type } = req.params as { type: string };
    const t = await need(req);
    const { status, json } = await api(w, t, "POST", SUB_PATH[type] ?? SUB_PATH.subscription, req.body);
    reply.code(status);
    return json;
  });
  app.put("/api/ratelimits/:type/:id", async (req, reply) => {
    const { type, id } = req.params as { type: string; id: string };
    const t = await need(req);
    const { status, json } = await api(w, t, "PUT", `${SUB_PATH[type] ?? SUB_PATH.subscription}/${id}`, req.body);
    reply.code(status);
    return json;
  });
  app.delete("/api/ratelimits/:type/:id", async (req, reply) => {
    const { type, id } = req.params as { type: string; id: string };
    const t = await need(req);
    const { status } = await api(w, t, "DELETE", `${SUB_PATH[type] ?? SUB_PATH.subscription}/${id}`);
    reply.code(status === 0 ? 500 : status);
    return { ok: status < 400 };
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
    const t = await need(req);
    const { status: s, json } = await api(w, t, "POST", `${ADMIN}/workflows/update-workflow-status?workflowReferenceId=${referenceId}`, { status: (req.body as any)?.status ?? "APPROVED", description: (req.body as any)?.description ?? "" });
    reply.code(s === 0 ? 500 : s);
    return json ?? { ok: s < 400 };
  });

  app.get("/api/apis", async (req) => {
    const t = await need(req);
    const { json } = await api(w, t, "GET", `${PUB}/apis?limit=200`);
    return { list: R.reshapeApis(json?.list ?? []) };
  });
}
