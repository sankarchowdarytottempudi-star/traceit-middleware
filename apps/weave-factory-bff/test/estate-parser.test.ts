// The Ballerina reader against a small synthetic estate (test/fixtures/estate). The fixture follows
// the shapes the generator produces: a shared library with the client factory, config records,
// guard clauses that answer with an error, transforms in modules/core and a 501 stub.
import { describe, it, expect } from "vitest";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildApi, discoverSources } from "../src/estate/model";
import { parsePackage, makeFile, parseLiteral, resourcePath, maskSource } from "../src/estate/bal";
import { parseToml, isSecretKey, showValue, scrubUrl, maskDeep, flatten } from "../src/estate/toml";
import { flatCalls } from "../src/estate/walk";

const F = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "estate");
const sources = () => discoverSources(join(F, "services"));
const orders = () => buildApi(sources().find((e) => e.name === "orders-proc-api")!, [join(F, "config")]);

describe("source discovery", () => {
  it("finds one entry per service folder and accepts name=dir+dir entries", () => {
    expect(sources().map((e) => e.name)).toEqual(["orders-proc-api", "stock-sys-api"]);
    const multi = discoverSources(`combo=${join(F, "services", "orders-proc-api")}+${join(F, "services", "stock-sys-api")}`);
    expect(multi).toHaveLength(1);
    expect(multi[0].dirs).toHaveLength(2);
    expect(discoverSources("/no/such/place")).toEqual([]);
    expect(discoverSources(undefined)).toEqual([]);
  });
});

describe("reading a service", () => {
  it("lists the business operations with full paths and leaves health checks out", () => {
    const m = orders();
    expect(m.basePaths).toEqual(["/orders-proc-api/v1"]);
    expect(m.operations.map((o) => `${o.method} ${o.fullPath}`)).toEqual([
      "GET /orders-proc-api/v1/orders/{orderId}", "POST /orders-proc-api/v1/orders", "DELETE /orders-proc-api/v1/orders/{orderId}",
    ]);
    expect(m.operations.map((o) => o.id)).toEqual(["get-orders-orderid", "post-orders", "delete-orders-orderid"]);
    expect(m.operations[0].summary).toContain("reads the stock level");
    expect(m.operations[0].file).toBe("service.bal");
    expect(m.operations[0].line).toBeGreaterThan(1);
    expect(m.operations[0].code).toContain("stockClient->get");
  });

  it("marks a 501 stub as not migrated", () => {
    const stub = orders().operations.find((o) => o.id === "delete-orders-orderid")!;
    expect(stub.implemented).toBe(false);
    expect(stub.responses).toEqual([{ status: 501 }]);
    expect(orders().operations.filter((o) => o.implemented)).toHaveLength(2);
  });

  it("finds connectors with their target, config key and auth style, never a secret value", () => {
    const m = orders();
    const stock = m.connectors.find((c) => c.name === "stockClient")!;
    expect(stock).toMatchObject({ kind: "http", target: "http://stock-sys-api.shop.svc:80", configKey: "stock.url", usedBy: ["get-orders-orderid"] });
    expect(stock.paths).toEqual(["/stock-sys-api/v1/stock/{orderId}"]);
    expect(stock.auth).toContain("apiPassword: set");
    expect(stock.settings.find((s) => s.key === "stock.apiPassword")?.value).toBe("set");
    const billing = m.connectors.find((c) => c.name === "billingClient")!;
    expect(billing.target).toBe("https://billing.example.test/pay?token=***");
    expect(billing.settings.find((s) => s.key === "billing.apiPassword")?.value).toBe("not set");
    expect(JSON.stringify(m)).not.toContain("fixture-not-a-real-value");
    expect(JSON.stringify(m)).not.toContain("user:fixture");
  });

  it("records the calls of each operation in order with forwarded headers and error answers", () => {
    const get = orders().operations[0];
    expect(get.calls).toHaveLength(1);
    expect(get.calls[0]).toMatchObject({ connector: "stockClient", method: "GET", path: "/stock-sys-api/v1/stock/{orderId}" });
    expect(get.calls[0].headers).toEqual(["correlationId", "client_channel"]);
    expect(get.headersForwarded).toEqual(["client_channel"]);
    expect(get.responses.map((r) => r.status)).toEqual([400, 502]);
    expect(get.responses[1].message).toBe("Stock service was not reachable");
    expect(get.steps.map((s) => s.kind)).toEqual(["respond", "call", "respond"]);
    const post = orders().operations[1];
    expect(post.steps.map((s) => s.kind)).toEqual(["map", "call", "respond", "map"]);
    expect(flatCalls(post.steps)[0].body?.mapping).toBe("core.toChargeRequest");
    expect(post.calls[0]).toMatchObject({ connector: "billingClient", method: "POST", path: "/charges", mapping: "core.toChargeRequest" });
  });

  it("recovers target <- source fields of a mapping and keeps the raw code where it cannot", () => {
    const m = orders();
    const charge = m.mappings.find((x) => x.id === "core.toChargeRequest")!;
    expect(charge.fields).toEqual([
      { target: "orderRef", source: "check input.id" }, { target: "amount", source: "check input.total.value" },
      { target: "currency", source: "\"EUR\"" }, { target: "customer.email", source: "check input.buyer.email" },
    ]);
    expect(charge.usedBy).toEqual(["post-orders"]);
    expect(charge.summary).toBe("Builds the charge request sent to billing.");
    const receipt = m.mappings.find((x) => x.id === "core.toReceipt")!;
    expect(receipt.fields?.length || 0).toBe(0);
    expect(receipt.code).toContain("receiptId: payload.id");
  });

  it("resolves configuration from the deployed file over defaults and masks secret-like keys", () => {
    const m = orders();
    expect(m.configSource).toBe("deployed");
    const byKey = Object.fromEntries(m.config.map((c) => [c.key, c]));
    expect(byKey.env).toMatchObject({ value: "test", source: "deployed", secret: false });
    expect(byKey.httpPort).toMatchObject({ value: "8081", source: "default" });
    expect(byKey["stock.url"]).toMatchObject({ value: "http://stock-sys-api.shop.svc:80", source: "deployed" });
    expect(byKey["stock.timeoutSeconds"]).toMatchObject({ value: "30", source: "default" });
    expect(byKey["stock.apiPassword"]).toMatchObject({ value: "set", secret: true });
    expect(byKey.signingSecret).toMatchObject({ value: "set", secret: true });
    expect(byKey["billing.apiPassword"]).toMatchObject({ value: "not set", secret: true });
  });

  it("falls back to the example file and says so", () => {
    const m = buildApi(sources().find((e) => e.name === "orders-proc-api")!, []);
    expect(m.configSource).toBe("example");
    expect(m.config.find((c) => c.key === "env")).toMatchObject({ value: "example", source: "example" });
    expect(m.connectors.find((c) => c.name === "stockClient")!.target).toBe("http://localhost:9090");
  });

  it("explains a service that only answers health checks", () => {
    const m = buildApi(sources().find((e) => e.name === "stock-sys-api")!, []);
    expect(m.operations).toEqual([]);
    expect(m.warnings.join(" ")).toContain("health checks only");
  });
});

describe("language helpers", () => {
  it("reads services, resources, clients and configurables of a package", () => {
    const text = [
      "import ballerina/http;",
      "configurable string basePath = \"/demo/v1\";",
      "configurable string upstreamUrl = ?;",
      "final http:Client up = check new (upstreamUrl);",
      "service /demo/v1 on new http:Listener(9000) {",
      "    resource function get items/[string id]/parts(http:Request req) returns json|error {",
      "        // a brace } inside a comment and a \"string with }\" must not end the block",
      "        json r = check up->get(\"/items/\" + id);",
      "        return r;",
      "    }",
      "    resource function post items(@http:Payload json body) returns json => body;",
      "}",
    ].join("\n");
    const pkg = parsePackage("acme", "demo", "", [makeFile("service.bal", "", text)]);
    expect(pkg.services).toHaveLength(1);
    expect(pkg.services[0].resources.map((r) => `${r.method} ${r.path}`)).toEqual(["GET /items/{id}/parts", "POST /items"]);
    expect(pkg.clients.map((c) => `${c.name}:${c.kind}`)).toEqual(["up:http"]);
    expect(pkg.configurables.map((c) => `${c.key}:${c.required}`)).toEqual(["basePath:false", "upstreamUrl:true"]);
  });

  it("turns escaped resource paths into URL paths", () => {
    expect(resourcePath("get\\-all\\-checks")).toBe("/get-all-checks");
    expect(resourcePath("pos/[string checkId]/check\\-image")).toBe("/pos/{checkId}/check-image");
    expect(resourcePath(".")).toBe("/");
  });

  it("blanks comments and strings but keeps offsets", () => {
    const src = "a = \"x{y\"; // tail }\nb = 1;";
    const masked = maskSource(src);
    expect(masked).toHaveLength(src.length);
    expect(masked).not.toContain("{");
    expect(masked).not.toContain("}");
    expect(masked).toContain("b = 1;");
  });

  it("reads literals and leaves expressions marked", () => {
    expect(parseLiteral("{url: \"http://a\", n: 3, on: true, list: [1, 2]}")).toEqual({ url: "http://a", n: 3, on: true, list: [1, 2] });
    expect(parseLiteral("base + \"/x\"")).toEqual({ __expr: "base + \"/x\"" });
  });
});

describe("configuration files and masking", () => {
  it("parses tables, dotted keys, arrays and inline tables", () => {
    const t = parseToml("top = 1\n[a.b]\nurl = \"http://x\" # note\non = true\nlist = [\"p\", \"q\"]\n[a.b.c]\nd = { e = 2, f = \"g\" }\n[[a.items]]\nn = 1\n[[a.items]]\nn = 2\n") as any;
    expect(t.top).toBe(1);
    expect(t.a.b.url).toBe("http://x");
    expect(t.a.b.on).toBe(true);
    expect(t.a.b.list).toEqual(["p", "q"]);
    expect(t.a.b.c.d).toEqual({ e: 2, f: "g" });
    expect(t.a.items).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it("recognises secret-like keys without flagging ordinary ones", () => {
    for (const k of ["password", "dbPassword", "clientSecret", "accessToken", "apiKey", "api_key", "x.y.privateKey", "client_id", "signingSecret", "storePass"]) expect(isSecretKey(k), k).toBe(true);
    for (const k of ["passThroughDownstreamErrors", "url", "timeoutSeconds", "keyPrefix", "tokenUrl", "cacheKey", "basePath", "compass", "bypassCache"]) expect(isSecretKey(k), k).toBe(false);
  });

  it("shows secrets only as set / not set, at any depth", () => {
    expect(showValue("password", "hunter2")).toBe("set");
    expect(showValue("password", "")).toBe("not set");
    expect(showValue("url", "https://u:p@host/x?apiKey=abc&plain=1")).toBe("https://host/x?apiKey=***&plain=1");
    expect(scrubUrl("redis://default:pw@cache:6379")).toBe("redis://cache:6379");
    expect(maskDeep({ a: { token: "t", list: [{ secret: "s", name: "n" }] } })).toEqual({ a: { token: "set", list: [{ secret: "set", name: "n" }] } });
    expect(flatten({ a: { b: 1, c: { d: "x" } }, e: [1] })).toEqual([{ key: "a.b", value: 1 }, { key: "a.c.d", value: "x" }, { key: "e", value: [1] }]);
  });
});
