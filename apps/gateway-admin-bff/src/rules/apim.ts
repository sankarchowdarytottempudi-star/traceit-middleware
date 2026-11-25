// Thin, typed-enough client over the API Manager REST APIs the rules screens use
// (publisher v4, admin v4, devportal v3). Errors become Fastify-friendly errors with a plain title.
import { api, apiMultipart, type Wso2Opts } from "../wso2.js";

export const PUB = "/api/am/publisher/v4";
export const ADMIN = "/api/am/admin/v4";
export const DEV = "/api/am/devportal/v3";

export class ApimError extends Error {
  constructor(public statusCode: number, message: string, public apimStatus: number) { super(message); }
}

/** WSO2 error body -> short, safe sentence. Never echoes tokens; WSO2 messages are about the request. */
export function apimMessage(status: number, json: any): string {
  const parts = [json?.message, json?.description].filter((s) => typeof s === "string" && s.trim()).map((s: string) => s.trim());
  const uniq = [...new Set(parts)].join(": ").slice(0, 300);
  if (status === 0) return "API Manager could not be reached";
  if (status === 401) return "API Manager did not accept the console's sign-in";
  if (status === 403) return `API Manager refused this action for your account${uniq ? ` (${uniq})` : ""}`;
  return uniq || `API Manager answered ${status}`;
}

export type Call = (method: string, path: string, body?: unknown) => Promise<any>;

export function apimClient(w: Wso2Opts, token: string) {
  const call: Call = async (method, path, body) => {
    let r: { status: number; json: any };
    try { r = await api(w, token, method, path, body); }
    catch { throw new ApimError(502, "API Manager could not be reached", 0); }
    if (r.status === 0 || r.status >= 400) {
      // 401 from API Manager must not look like "you are signed out of the console"
      const code = r.status === 401 || r.status === 0 ? 502 : r.status >= 500 ? 502 : r.status;
      throw new ApimError(code, apimMessage(r.status, r.json), r.status);
    }
    return r.json;
  };
  const list = async (path: string) => { const j = await call("GET", path); return (j?.list ?? (Array.isArray(j) ? j : [])) as any[]; };
  return {
    call, list,
    // publisher
    apis: () => list(`${PUB}/apis?limit=500`),
    api: (id: string) => call("GET", `${PUB}/apis/${id}`),
    putApi: (id: string, body: unknown) => call("PUT", `${PUB}/apis/${id}`, body),
    createApi: (body: unknown) => call("POST", `${PUB}/apis`, body),
    deleteApi: (id: string) => call("DELETE", `${PUB}/apis/${id}`),
    lifecycle: (id: string, action: string) => call("POST", `${PUB}/apis/change-lifecycle?apiId=${id}&action=${encodeURIComponent(action)}`),
    revisions: (id: string) => list(`${PUB}/apis/${id}/revisions`),
    createRevision: (id: string, description: string) => call("POST", `${PUB}/apis/${id}/revisions`, { description }),
    deleteRevision: (id: string, rev: string) => call("DELETE", `${PUB}/apis/${id}/revisions/${rev}`),
    restoreRevision: (id: string, rev: string) => call("POST", `${PUB}/apis/${id}/restore-revision?revisionId=${rev}`),
    deployments: (id: string) => list(`${PUB}/apis/${id}/deployments`),
    deploy: (id: string, rev: string, envs: { name: string; vhost: string }[]) =>
      call("POST", `${PUB}/apis/${id}/deploy-revision?revisionId=${rev}`, envs.map((e) => ({ name: e.name, vhost: e.vhost, displayOnDevportal: true }))),
    subscriptions: (apiId: string) => list(`${PUB}/subscriptions?apiId=${apiId}&limit=200`),
    blockSubscription: (subId: string, state: "BLOCKED" | "PROD_ONLY_BLOCKED") => call("POST", `${PUB}/subscriptions/block-subscription?subscriptionId=${subId}&blockState=${state}`),
    unblockSubscription: (subId: string) => call("POST", `${PUB}/subscriptions/unblock-subscription?subscriptionId=${subId}`),
    apiOpPolicies: (id: string) => list(`${PUB}/apis/${id}/operation-policies?limit=100`),
    deleteApiOpPolicy: (id: string, policyId: string) => call("DELETE", `${PUB}/apis/${id}/operation-policies/${policyId}`),
    uploadApiOpPolicy: async (id: string, spec: string, synapse: string) => {
      let r: { status: number; json: any };
      try {
        r = await apiMultipart(w, token, `${PUB}/apis/${id}/operation-policies`, [
          { name: "policySpecFile", filename: "policy.json", contentType: "application/json", content: spec },
          { name: "synapsePolicyDefinitionFile", filename: "policy.j2", contentType: "application/octet-stream", content: synapse },
        ]);
      } catch { throw new ApimError(502, "API Manager could not be reached", 0); }
      if (r.status >= 400 || r.status === 0) throw new ApimError(r.status === 401 || r.status >= 500 ? 502 : r.status, apimMessage(r.status, r.json), r.status);
      return r.json;
    },
    // admin
    environments: () => list(`${ADMIN}/environments`),
    policies: (kind: "subscription" | "advanced" | "application" | "custom") => list(`${ADMIN}/throttling/policies/${kind}`),
    createPolicy: (kind: string, body: unknown) => call("POST", `${ADMIN}/throttling/policies/${kind}`, body),
    deletePolicy: (kind: string, id: string) => call("DELETE", `${ADMIN}/throttling/policies/${kind}/${id}`),
    denyPolicies: () => list(`${ADMIN}/throttling/deny-policies`),
    createDeny: (body: unknown) => call("POST", `${ADMIN}/throttling/deny-policies`, body),
    setDeny: (id: string, on: boolean) => call("PATCH", `${ADMIN}/throttling/deny-policy/${id}`, { conditionId: id, conditionStatus: on }),
    deleteDeny: (id: string) => call("DELETE", `${ADMIN}/throttling/deny-policy/${id}`),
    allApplications: () => list(`${ADMIN}/applications?limit=500`),
    // devportal (applications are owned by the account whose token is used)
    applications: () => list(`${DEV}/applications?limit=200`),
    application: (id: string) => call("GET", `${DEV}/applications/${id}`),
    createApplication: (body: unknown) => call("POST", `${DEV}/applications`, body),
    deleteApplication: (id: string) => call("DELETE", `${DEV}/applications/${id}`),
    keys: (appId: string) => list(`${DEV}/applications/${appId}/oauth-keys`),
    generateKeys: (appId: string, keyType: string, keyManager: string) => call("POST", `${DEV}/applications/${appId}/generate-keys`, {
      keyType, keyManager, grantTypesToBeSupported: ["client_credentials"], callbackUrl: "", validityTime: 3600, scopes: [] }),
    regenerateSecret: (appId: string, keyMappingId: string) => call("POST", `${DEV}/applications/${appId}/oauth-keys/${keyMappingId}/regenerate-secret`),
    removeKeys: (appId: string, keyMappingId: string) => call("POST", `${DEV}/applications/${appId}/oauth-keys/${keyMappingId}/clean-up`),
    appSubscriptions: (appId: string) => list(`${DEV}/subscriptions?applicationId=${appId}&limit=200`),
    subscribe: (applicationId: string, apiId: string, throttlingPolicy: string) => call("POST", `${DEV}/subscriptions`, { applicationId, apiId, throttlingPolicy }),
    unsubscribe: (subId: string) => call("DELETE", `${DEV}/subscriptions/${subId}`),
    keyManagers: () => list(`${DEV}/key-managers`),
  };
}
export type ApimClient = ReturnType<typeof apimClient>;
