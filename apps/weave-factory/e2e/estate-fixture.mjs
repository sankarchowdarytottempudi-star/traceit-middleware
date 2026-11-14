// Where the "migrated services" data of the Studio comes from in the end-to-end scripts.
//
// After the merge the Factory under test answers /api/factory/estate itself ("own"). Before that the
// answers of another Factory can be passed through ("borrowed"), or this small built-in example is
// served to the page ("fixture"). Nothing here talks to anything but the Factory URLs given.
export const ESTATE_URL = /\/api\/factory\/estate(\/|\?|$)/;

export const FIXTURE_API = "example-orders-api";
const step = (id, type, name, x, config = {}, notes) => ({ id, type, name, position: { x, y: id.startsWith("b") ? 260 : 60 }, config, ...(notes ? { notes } : {}) });
const src = (line, code) => ({ file: "service.bal", line, endLine: line + code.split("\n").length - 1, code });
export const FIXTURE = {
  list: { apis: [{ name: FIXTURE_API, layer: "system", technology: "ballerina", status: "running", replicas: 1, basePath: "/orders", operations: 2, connectors: 1, gateway: { published: true, context: "/orders", version: "v1" } }] },
  detail: {
    name: FIXTURE_API, layer: "system", technology: "ballerina", status: "running",
    operations: [{ id: "a1", method: "GET", path: "/orders/{id}", implemented: true }, { id: "b1", method: "POST", path: "/orders", implemented: true }],
    connectors: [{ name: "ordersBackend", kind: "http", target: "http://orders.internal:8080", usedBy: ["GET /orders/{id}", "POST /orders"] }],
    mappings: [{ id: "m1", name: "toOrderView", kind: "record", operation: "GET /orders/{id}", file: "service.bal", line: 40, fields: [{ target: "orderId", source: "o.id" }, { target: "customerName", source: "o.customer.name" }], code: "OrderView v = { orderId: o.id, customerName: o.customer.name };" }],
  },
  flow: {
    id: `estate:${FIXTURE_API}`, name: FIXTURE_API, slug: FIXTURE_API, description: "Built-in example", tags: ["migrated", "ballerina"], revision: 1, readOnly: true,
    origin: { kind: "migrated", ref: FIXTURE_API }, settings: { basePath: "/orders" },
    nodes: [
      step("a1", "trigger.http", "GET /orders/{id}", 60, { method: "GET", path: "/orders/{id}", __operation: "GET /orders/{id}", __implemented: true, __source: src(12, "resource function get orders/[string id]() returns OrderView|error {") }),
      step("a2", "http.request", "Read the order", 360, { method: "GET", url: "http://orders.internal:8080/orders/{{ $request.params.id }}", __connector: "ordersBackend", __target: "http://orders.internal:8080", __source: src(13, "    json o = check ordersBackend->get(\"/orders/\" + id);") }, "Calls the orders backend."),
      step("a3", "transform.map", "Shape the answer", 660, { mapping: { rules: [{ id: "r1", target: "orderId", kind: "direct", source: "id" }, { id: "r2", target: "customerName", kind: "expr", expr: "customer.name" }] }, __source: src(14, "    OrderView v = { orderId: o.id, customerName: o.customer.name };") }),
      step("a4", "http.respond", "Answer", 960, { status: 200, __source: src(15, "    return v;") }),
      step("b1", "trigger.http", "POST /orders", 60, { method: "POST", path: "/orders", __operation: "POST /orders", __implemented: true, __source: src(20, "resource function post orders(@http:Payload json body) returns json|error {") }),
      step("b2", "http.request", "Create the order", 360, { method: "POST", url: "http://orders.internal:8080/orders", __connector: "ordersBackend", __source: src(21, "    return check ordersBackend->post(\"/orders\", body);") }),
      step("b3", "http.respond", "Answer", 660, { status: 201, __source: src(22, "}") }),
    ],
    edges: [
      { id: "e1", from: "a1", to: "a2" }, { id: "e2", from: "a2", to: "a3" }, { id: "e3", from: "a3", to: "a4" },
      { id: "e4", from: "b1", to: "b2" }, { id: "e5", from: "b2", to: "b3" },
    ],
  },
  logs: { lines: [{ at: "2026-01-31T10:20:30Z", level: "INFO", text: "GET /orders/42 answered 200 in 31 ms", pod: "example-1" }, { at: "2026-01-31T10:21:02Z", level: "ERROR", text: "POST /orders failed: backend timeout", pod: "example-1" }] },
};


const readList = (request, base) => request.get(`${base}/api/factory/estate`).then(async (r) => (r.ok() ? await r.json().catch(() => null) : null)).catch(() => null);
const usable = (list) => !!(list && Array.isArray(list.apis) && list.apis.length);

/** Decides where the data comes from. Returns { mode: "own" | "borrowed" | "fixture", list, own }. */
export async function pickEstate(request, base, from, forceFixture = false) {
  const own = await readList(request, base);
  if (usable(own) && !forceFixture) return { mode: "own", list: own, own };
  if (from && !forceFixture) { const list = await readList(request, from); if (usable(list)) return { mode: "borrowed", list, own }; }
  return { mode: "fixture", list: FIXTURE.list, own };
}

/** Makes a page (or a whole browser context) see the chosen data. */
export async function wireEstate(target, mode, from) {
  if (mode === "fixture") {
    await target.route(ESTATE_URL, async (route) => {
      const u = new URL(route.request().url());
      const rest = u.pathname.replace(/^.*\/api\/factory\/estate/, "");
      const json = (body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
      if (rest === "" || rest === "/") return json(FIXTURE.list);
      if (rest === `/${FIXTURE_API}`) return json(FIXTURE.detail);
      if (rest === `/${FIXTURE_API}/flow`) return json(FIXTURE.flow);
      if (rest === `/${FIXTURE_API}/logs`) { const q = (u.searchParams.get("q") || "").toLowerCase(); return json({ lines: FIXTURE.logs.lines.filter((l) => !q || l.text.toLowerCase().includes(q)) }); }
      if (rest === `/${FIXTURE_API}/clone` && route.request().method() === "POST") return json({ flowId: "fl_e2e_fixture" });
      return json({ type: "about:blank", title: "Not found", status: 404 }, 404);
    });
  } else if (mode === "borrowed") {
    await target.route(ESTATE_URL, async (route) => {
      const u = new URL(route.request().url());
      try { const response = await route.fetch({ url: from + u.pathname + u.search }); await route.fulfill({ response }); }
      catch { await route.abort(); }
    });
  }
}

/** The service worth looking at: one that calls other systems and has the most operations. */
export function pickService(list) {
  const ranked = [...list.apis].sort((a, b) => (Number(b.connectors) > 0 ? 1 : 0) - (Number(a.connectors) > 0 ? 1 : 0) || Number(b.operations || 0) - Number(a.operations || 0));
  return ranked[0]?.name;
}
