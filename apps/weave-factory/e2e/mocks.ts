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

// Weave Studio: one saved flow with four steps, nothing deployed, an empty history.
const at = "2026-01-31T10:00:00.000Z";
const flow = {
  id: "fl_demo", name: "orders-lookup", slug: "orders-lookup", description: "Reads an order and reshapes the answer.", tags: [], revision: 3,
  origin: { kind: "blank" }, createdAt: at, updatedAt: at, deployment: null,
  settings: { basePath: "/orders-lookup/v1", gateway: { publish: true, security: "oauth2" } },
  nodes: [
    { id: "n1", type: "trigger.http", name: "HTTP Listener", position: { x: 60, y: 120 }, config: { method: "GET", path: "/orders/:id" } },
    { id: "n2", type: "http.request", name: "Read the order", position: { x: 340, y: 120 }, config: { method: "GET", url: "https://orders.example/orders/{{ $request.params.id }}" } },
    { id: "n3", type: "transform.map", name: "Reshape", position: { x: 620, y: 120 }, config: { mapping: { rules: [{ id: "r1", target: "ref", kind: "direct", source: "id" }] } } },
    { id: "n4", type: "http.respond", name: "Respond", position: { x: 900, y: 120 }, config: { status: 200 } },
  ],
  edges: [{ id: "e1", from: "n1", fromPort: "out", to: "n2" }, { id: "e2", from: "n2", fromPort: "out", to: "n3" }, { id: "e3", from: "n3", fromPort: "out", to: "n4" }],
};
const summary = { id: flow.id, name: flow.name, slug: flow.slug, description: flow.description, tags: [], origin: flow.origin, revision: flow.revision, updatedAt: at, deployment: null, nodeCount: 4, triggers: ["GET /orders/:id"], lastExecution: null };
function studio(path: string, method: string): unknown {
  if (path === "/healthz") return { status: "UP", flowsDeployed: 0, gateway: "reachable" };
  if (path === "/catalog") return {}; // the Studio falls back to the catalog bundled with the contract package
  if (path === "/flows" && method === "GET") return { flows: [summary] };
  if (path === "/flows/validate") return { issues: [] };
  if (path === `/flows/${flow.id}`) return flow;
  if (path.endsWith("/versions")) return { versions: [{ revision: 3, savedAt: at, savedBy: "admin" }] };
  if (path.endsWith("/logs")) return { lines: [] };
  if (path.startsWith("/executions")) return { executions: [] };
  if (path.startsWith("/stats")) return { flows: [], series: [] };
  if (path === "/connections") return { connections: [] };
  if (path === "/connectors") return { connectors: [] };
  return { ok: true };
}

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
    if (url.includes("/api/factory/estate")) return route.fulfill(json({ apis: [] }));
    if (url.includes("/api/studio/")) return route.fulfill(json(studio(new URL(url).pathname.replace(/^.*\/api\/studio/, ""), route.request().method())));
    return route.fulfill(json({ ok: true }));
  });
}
