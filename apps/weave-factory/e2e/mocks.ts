import type { Page } from "@playwright/test";

const migrations = { migrations: [{
  id: "m1", apiName: "cms-proc-api", workspace: "AROYA", technology: "mulesoft", busy: false,
  phases: [
    { key: "document", title: "Document generation", mode: "auto", status: "done", percent: 100, steps: [] },
    { key: "scaffold", title: "Service scaffold", mode: "auto", status: "done", percent: 100, steps: [] },
    { key: "deploy", title: "Deployment", mode: "auto", status: "running", percent: 40, steps: [] },
  ],
  progress: { overallPercent: 72, majorPhase: "Deployment", majorPhaseKey: "deploy",
    currentStep: "Deployment / Build image", nextStep: "Deployment / Import to k3s", done: false, outcome: "In progress" },
}] };
const workspaces = { workspaces: [{ name: "AROYA", servers: { dev: { host: "dev.aroya", port: 8290 }, uat: { host: "uat.aroya", port: 8290 } } }] };
const knowledge = { feedback: [
  { id: "l1", scope: "functional", technology: null, summary: "Preserve the source's downstream headers end-to-end.", mistakes: ["Dropped X-Seaware-Authorization at an intermediate hop."] },
  { id: "l2", scope: "api", technology: "mulesoft", apiName: "cms-proc-api", summary: "Pass text/html through unchanged.", mistakes: [] },
] };

export async function mockApi(page: Page, opts: { signedIn?: boolean } = {}) {
  const json = (data: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(data) });
  await page.route("**/healthz", (r) => r.fulfill(json({ status: "UP" })));
  await page.route("**/api/**", async (route) => {
    const url = route.request().url();
    if (url.includes("/api/auth/me")) {
      if (opts.signedIn === false) return route.fulfill({ status: 401, contentType: "application/problem+json", body: JSON.stringify({ title: "no", status: 401 }) });
      return route.fulfill(json({ user: "admin", role: "admin" }));
    }
    if (url.includes("/api/factory/workspaces")) return route.fulfill(json(workspaces));
    if (url.includes("/api/factory/migrations")) return route.fulfill(json(migrations));
    if (url.includes("/api/factory/knowledge")) return route.fulfill(json(knowledge));
    if (url.includes("/api/factory/proxy")) return route.fulfill(json({ status: 200, body: "{\"data\":{\"ok\":true}}", ms: 120, slo: "fast" }));
    if (url.includes("/api/factory/infer-mapping")) return route.fulfill(json({ engine: "heuristic", needsModel: false, rules: [
      { target: "ref", kind: "direct", source: "customer.ref" },
      { target: "email", kind: "direct", source: "customer.email" },
      { target: "first", kind: "expr", expr: "firstWord(customer.name)" },
    ] }));
    return route.fulfill(json({ ok: true }));
  });
}
