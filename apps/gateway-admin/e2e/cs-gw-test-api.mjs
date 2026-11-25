#!/usr/bin/env node
// Throw-away API for the gateway-rules checks against a REAL API Manager.
//
//   node e2e/cs-gw-test-api.mjs create <suffix>     -> creates, deploys and publishes API cs-gw-test-<suffix>
//   node e2e/cs-gw-test-api.mjs cleanup             -> removes EVERYTHING named cs-gw-test-* (apps, API, policies)
//                                                      and blocking rules on the test address range / test contexts
//   node e2e/cs-gw-test-api.mjs list                -> shows what cleanup would remove
//
// Env: APIM_BASE_URL, APIM_CA_CERT_PATH (host path), APIM_DCR_USERNAME, APIM_DCR_PASSWORD,
//      APIM_CLIENT_FILE (JSON with clientId/clientSecret of an existing registration).
// Only objects whose name starts with cs-gw-test- are ever written or deleted.
import https from "node:https";
import { readFileSync } from "node:fs";

const PREFIX = "cs-gw-test-";
const POLICY_PREFIX = "cs_gw_test_"; // API Manager refuses dashes in policy names
const TEST_NET = "203.0.113."; // documentation range (RFC 5737): never a real caller
const base = process.env.APIM_BASE_URL;
const ca = readFileSync(process.env.APIM_CA_CERT_PATH, "utf8");
const client = JSON.parse(readFileSync(process.env.APIM_CLIENT_FILE, "utf8"));
const PUB = "/api/am/publisher/v4", ADMIN = "/api/am/admin/v4", DEV = "/api/am/devportal/v3";

function req(method, path, headers = {}, body) {
  const u = new URL(base + path);
  return new Promise((resolve, reject) => {
    const r = https.request({ method, hostname: u.hostname, port: u.port, path: u.pathname + u.search, headers, ca }, (res) => {
      let t = ""; res.on("data", (c) => (t += c)); res.on("end", () => { let j = null; try { j = t ? JSON.parse(t) : null; } catch { j = { raw: t.slice(0, 300) }; } resolve({ status: res.statusCode, json: j }); });
    });
    r.on("error", reject); if (body) r.write(body); r.end();
  });
}
const SCOPE = "apim:api_view apim:api_manage apim:api_create apim:api_publish apim:tier_view apim:tier_manage apim:subscribe apim:app_manage apim:sub_manage apim:bl_view apim:bl_manage apim:admin apim:api_delete";
async function token() {
  const r = await req("POST", "/oauth2/token", { Authorization: "Basic " + Buffer.from(`${client.clientId}:${client.clientSecret}`).toString("base64"), "Content-Type": "application/x-www-form-urlencoded" },
    new URLSearchParams({ grant_type: "password", username: process.env.APIM_DCR_USERNAME, password: process.env.APIM_DCR_PASSWORD, scope: SCOPE }).toString());
  if (r.status !== 200) throw new Error(`token: ${r.status}`);
  return r.json.access_token;
}
const tok = await token();
const call = async (method, path, body) => {
  const r = await req(method, path, { Authorization: `Bearer ${tok}`, Accept: "application/json", ...(body !== undefined ? { "Content-Type": "application/json" } : {}) }, body !== undefined ? JSON.stringify(body) : undefined);
  if (r.status >= 400) throw new Error(`${method} ${path} -> ${r.status} ${JSON.stringify(r.json).slice(0, 300)}`);
  return r.json;
};
const list = async (path) => { const j = await call("GET", path); return j?.list ?? (Array.isArray(j) ? j : []); };
const mine = (name) => typeof name === "string" && name.startsWith(PREFIX);

async function create(suffix) {
  if (!/^[a-z0-9-]{1,30}$/.test(suffix)) throw new Error("suffix: lower-case letters, digits, dash");
  const name = `${PREFIX}${suffix}`;
  const op = (verb) => ({ target: "/orders", verb, authType: "Application & Application User", throttlingPolicy: "Unlimited" });
  const api = await call("POST", `${PUB}/apis`, {
    name, context: `/${name}`, version: "v1", description: "Throw-away API for the Weave gateway rules checks. Safe to delete.",
    policies: ["Unlimited"], transport: ["http", "https"], visibility: "PUBLIC",
    securityScheme: ["oauth2", "oauth_basic_auth_api_key_mandatory"],
    endpointConfig: { endpoint_type: "http", production_endpoints: { url: "http://example.invalid" }, sandbox_endpoints: { url: "http://example.invalid" } },
    operations: [op("GET"), op("POST")],
  });
  const rev = await call("POST", `${PUB}/apis/${api.id}/revisions`, { description: "created by cs-gw-test-api.mjs" });
  await call("POST", `${PUB}/apis/${api.id}/deploy-revision?revisionId=${rev.id}`, [{ name: "Default", vhost: "localhost", displayOnDevportal: true }]);
  await call("POST", `${PUB}/apis/change-lifecycle?apiId=${api.id}&action=Publish`);
  console.log(JSON.stringify({ id: api.id, name, context: `/${name}`, version: "v1" }));
}

async function plan() {
  const apis = (await list(`${PUB}/apis?limit=500`)).filter((a) => mine(a.name));
  const apps = (await list(`${DEV}/applications?limit=200`)).filter((a) => mine(a.name));
  const pol = {};
  for (const k of ["subscription", "advanced", "application"]) pol[k] = (await list(`${ADMIN}/throttling/policies/${k}`)).filter((p) => mine(p.policyName) || String(p.policyName).startsWith(POLICY_PREFIX));
  const deny = (await list(`${ADMIN}/throttling/deny-policies`)).filter((d) => {
    const v = d.conditionValue;
    const s = typeof v === "string" ? v : JSON.stringify(v);
    return s.includes(TEST_NET) || s.includes(`/${PREFIX}`) || s.includes(`:${PREFIX}`);
  });
  return { apis, apps, pol, deny };
}

async function cleanup() {
  const p = await plan();
  for (const a of p.apps) { await call("DELETE", `${DEV}/applications/${a.applicationId}`); console.log(`removed application ${a.name}`); }
  for (const d of p.deny) { await call("DELETE", `${ADMIN}/throttling/deny-policy/${d.conditionId}`); console.log(`removed blocking rule ${d.conditionType} ${JSON.stringify(d.conditionValue)}`); }
  for (const a of p.apis) {
    if (!mine(a.name)) continue;
    await call("DELETE", `${PUB}/apis/${a.id}`); console.log(`removed API ${a.name}`);
  }
  for (const [k, l] of Object.entries(p.pol)) for (const x of l) { await call("DELETE", `${ADMIN}/throttling/policies/${k}/${x.policyId}`); console.log(`removed ${k} policy ${x.policyName}`); }
  const left = await plan();
  const n = left.apis.length + left.apps.length + left.deny.length + Object.values(left.pol).flat().length;
  console.log(n === 0 ? "CLEAN: nothing named cs-gw-test-* / cs_gw_test_* is left" : `LEFT: ${n} object(s) still present`);
  if (n) process.exitCode = 1;
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === "create") await create(arg);
else if (cmd === "cleanup") await cleanup();
else if (cmd === "list") { const p = await plan(); console.log(JSON.stringify({ apis: p.apis.map((a) => a.name), apps: p.apps.map((a) => a.name), policies: Object.fromEntries(Object.entries(p.pol).map(([k, l]) => [k, l.map((x) => x.policyName)])), deny: p.deny.map((d) => d.conditionValue) }, null, 1)); }
else { console.log("usage: create <suffix> | cleanup | list"); process.exitCode = 2; }
