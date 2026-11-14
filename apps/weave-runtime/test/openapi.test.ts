import { describe, expect, it } from "vitest";
import { importOpenApi, suggestedBaseUrl } from "../src/openapi.js";

const v3 = { openapi: "3.0.3", info: { title: "Pet Store", version: "1" }, servers: [{ url: "https://api.example.test/v2" }],
  paths: { "/pets": { get: { operationId: "listPets", summary: "List pets", parameters: [{ name: "limit", in: "query", schema: { type: "integer" } }, { name: "x-trace", in: "header", schema: { type: "string" } }] },
    post: { operationId: "createPet", requestBody: { content: { "application/json": { schema: { type: "object", properties: { name: { type: "string" } } } } } } } },
    "/pets/{petId}": { parameters: [{ name: "petId", in: "path", required: true, schema: { type: "string" } }], get: { summary: "One pet" }, delete: { operationId: "delete pet!" } } } };
const v2yaml = `
swagger: "2.0"
info: { title: Orders, version: "1.0" }
host: orders.example.test
basePath: /api
schemes: [https]
paths:
  /orders/{id}:
    get:
      operationId: getOrder
      parameters:
        - { name: id, in: path, required: true, type: string }
        - { name: expand, in: query, type: string }
  /orders:
    post:
      summary: Create order
      parameters:
        - { name: body, in: body, schema: { type: object } }
`;

describe("OpenAPI import", () => {
  it("reads OpenAPI 3 (object or JSON text)", () => {
    for (const spec of [v3, JSON.stringify(v3)]) {
      const c = importOpenApi(spec);
      expect(c.name).toBe("Pet Store"); expect(c.source).toBe("openapi"); expect(c.connectionType).toBe("http");
      expect(c.operations.map((o) => `${o.method} ${o.path}`).sort()).toEqual(["DELETE /pets/{petId}", "GET /pets", "GET /pets/{petId}", "POST /pets"]);
      const list = c.operations.find((o) => o.id === "listPets")!;
      expect(list.name).toBe("List pets");
      expect(list.params.map((p) => p.key)).toContain("limit");
      expect((list.query ?? []).some((q) => q.key === "limit")).toBe(true);
      expect((list.headers ?? []).some((h) => h.key.toLowerCase() === "x-trace")).toBe(true);
      const one = c.operations.find((o) => o.method === "GET" && o.path === "/pets/{petId}")!;
      expect(one.params.map((p) => p.key)).toContain("petId");
      const ids = c.operations.map((o) => o.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_.-]+$/);
    }
    expect(suggestedBaseUrl(v3)).toBe("https://api.example.test/v2");
  });
  it("reads Swagger 2 written as YAML", () => {
    const c = importOpenApi(v2yaml, "My orders");
    expect(c.name).toBe("My orders");
    expect(c.operations.map((o) => `${o.method} ${o.path}`).sort()).toEqual(["GET /api/orders/{id}", "POST /api/orders"]);
    expect(c.operations.find((o) => o.id === "getOrder")!.params.map((p) => p.key).sort()).toEqual(["expand", "id"]);
    expect(suggestedBaseUrl(v2yaml)).toBe("https://orders.example.test");
  });
  it("explains what is wrong with something that is not a description", () => {
    expect(() => importOpenApi({ hello: 1 })).toThrow(/OpenAPI 3 or Swagger 2/);
    expect(() => importOpenApi("{ not json or yaml: [")).toThrow();
  });
});
