// Turns an OpenAPI 3.x or Swagger 2.0 description (JSON or YAML, text or already parsed) into
// a custom connector: one operation per path + method. Parsing happens here, on this server;
// the description is never sent anywhere.
import YAML from "yaml";
import type { ConnectorDef, ConnectorOperation, FieldDef } from "@traceit/weave-flow";
import { newId } from "./store.js";

const METHODS = ["get", "post", "put", "patch", "delete", "head", "options"];
const RESERVED = new Set(["connection", "failOnStatus", "output", "timeoutMs", "retries", "retryDelayMs", "resultTarget", "resultVar"]);
type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);

function parseSpec(spec: unknown): Obj {
  if (typeof spec === "string") {
    const text = spec.trim();
    if (!text) throw new Error("The API description is empty");
    let doc: unknown;
    if (text.startsWith("{")) { try { doc = JSON.parse(text); } catch (e) { throw new Error(`The API description is not valid JSON: ${(e as Error).message}`); } }
    else { try { doc = YAML.parse(text, { maxAliasCount: 200 }); } catch (e) { throw new Error(`The API description is not valid YAML: ${(e as Error).message.split("\n")[0]}`); } }
    if (!isObj(doc)) throw new Error("The API description must be an object with \"openapi\" or \"swagger\" and \"paths\"");
    return doc;
  }
  if (!isObj(spec)) throw new Error("Send the API description as { spec } (JSON object, or JSON/YAML text)");
  return spec;
}
function deref(doc: Obj, v: unknown, depth = 0): unknown {
  if (!isObj(v) || typeof v.$ref !== "string" || depth > 20) return v;
  if (!v.$ref.startsWith("#/")) return {};
  let cur: unknown = doc;
  for (const part of v.$ref.slice(2).split("/")) { cur = isObj(cur) ? cur[part.replace(/~1/g, "/").replace(/~0/g, "~")] : undefined; }
  return deref(doc, cur, depth + 1);
}
const slug = (s: string) => s.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
function opIdFor(method: string, path: string, given: unknown, used: Set<string>): string {
  let id = typeof given === "string" && slug(given) ? slug(given) : slug(`${method}_${path.replace(/[{}]/g, "")}`) || method;
  id = id.slice(0, 80);
  let out = id; for (let n = 2; used.has(out); n++) out = `${id}_${n}`;
  used.add(out); return out;
}
function kindOf(schema: unknown): FieldDef["kind"] {
  const t = isObj(schema) ? schema.type : undefined;
  if (t === "integer" || t === "number") return "template";
  return "template";
}

export function importOpenApi(spec: unknown, name?: string): ConnectorDef {
  const doc = parseSpec(spec);
  const v3 = typeof doc.openapi === "string" && doc.openapi.startsWith("3");
  const v2 = typeof doc.swagger === "string" && doc.swagger.startsWith("2");
  if (!v3 && !v2) throw new Error("This is not an OpenAPI 3 or Swagger 2 description (no \"openapi: 3.x\" or \"swagger: 2.0\" field)");
  if (!isObj(doc.paths) || !Object.keys(doc.paths).length) throw new Error("The API description has no paths");
  const info = isObj(doc.info) ? doc.info : {};
  const basePath = v2 && typeof doc.basePath === "string" && doc.basePath !== "/" ? "/" + doc.basePath.replace(/^\/+|\/+$/g, "") : "";
  const used = new Set<string>();
  const operations: ConnectorOperation[] = [];

  for (const [rawPath, itemRaw] of Object.entries(doc.paths)) {
    const item = deref(doc, itemRaw);
    if (!isObj(item)) continue;
    const shared = Array.isArray(item.parameters) ? item.parameters : [];
    for (const method of METHODS) {
      const op = item[method];
      if (!isObj(op)) continue;
      const id = opIdFor(method, rawPath, op.operationId, used);
      let path = basePath + (rawPath.startsWith("/") ? rawPath : "/" + rawPath);
      const params: FieldDef[] = []; const query: { key: string; value: string }[] = []; const headers: { key: string; value: string }[] = [];
      const keys = new Set<string>();
      const keyFor = (n: string) => { let k = slug(n) || "param"; if (RESERVED.has(k) || k === "body") k = `p_${k}`; let out = k; for (let i = 2; keys.has(out); i++) out = `${k}_${i}`; keys.add(out); return out; };
      // operation-level parameters override path-level ones with the same name + location
      const merged = new Map<string, Obj>();
      for (const p of [...shared, ...(Array.isArray(op.parameters) ? op.parameters : [])]) { const d = deref(doc, p); if (isObj(d) && typeof d.name === "string") merged.set(`${d.in}:${d.name}`, d); }
      let bodyParam: Obj | undefined; let formFields = false;
      for (const p of merged.values()) {
        const where = String(p.in), pname = String(p.name);
        if (where === "body") { bodyParam = p; continue; }
        if (where === "formData") { formFields = true; continue; }
        if (where === "cookie") continue;
        if (where === "header" && /^(authorization|content-type|accept)$/i.test(pname)) continue;   // supplied by the connection / runtime
        const schema = deref(doc, v3 ? p.schema : p) as Obj | undefined;
        const key = keyFor(pname);
        const f: FieldDef = { key, label: pname, kind: kindOf(schema), required: where === "path" ? true : p.required === true };
        const help = [typeof p.description === "string" ? p.description.trim().split("\n")[0].slice(0, 200) : "", where === "path" ? "Path parameter" : where === "query" ? "Query parameter" : "Header"].filter(Boolean).join(" - ");
        if (help) f.help = help;
        const def = isObj(schema) ? schema.default : undefined;
        if (def !== undefined && (typeof def !== "object" || def === null)) f.default = String(def);
        if (isObj(schema) && Array.isArray(schema.enum) && schema.enum.length && schema.enum.length <= 40 && schema.enum.every((e) => typeof e !== "object")) { f.kind = "select"; f.options = schema.enum.map((e) => ({ value: String(e), label: String(e) })); }
        if (where !== "path") f.group = where === "query" ? "Query" : "Headers";
        params.push(f);
        if (where === "path") { if (key !== pname) path = path.split(`{${pname}}`).join(`{${key}}`); }
        else if (where === "query") query.push({ key: pname, value: `{{ $params.${key} }}` });
        else if (where === "header") headers.push({ key: pname, value: `{{ $params.${key} }}` });
      }
      // path placeholders that the description forgot to declare
      for (const m of path.matchAll(/\{([^}]+)\}/g)) if (!params.some((f) => f.key === m[1])) { keys.add(m[1]); params.unshift({ key: m[1], label: m[1], kind: "template", required: true, help: "Path parameter" }); }

      let bodyTemplate: string | undefined;
      const rb = v3 ? deref(doc, op.requestBody) : undefined;
      const hasBody = !!bodyParam || formFields || isObj(rb);
      if (hasBody && !["get", "head"].includes(method)) {
        let contentType = "";
        if (isObj(rb) && isObj(rb.content)) contentType = Object.keys(rb.content).find((c) => /json/i.test(c)) ?? Object.keys(rb.content)[0] ?? "";
        else if (v2) { const consumes = Array.isArray(op.consumes) ? op.consumes : Array.isArray(doc.consumes) ? doc.consumes : []; contentType = String(consumes.find((c) => /json/i.test(String(c))) ?? consumes[0] ?? ""); }
        const desc = isObj(rb) && typeof rb.description === "string" ? rb.description : bodyParam && typeof bodyParam.description === "string" ? bodyParam.description : "";
        params.push({ key: "body", label: "Request body", kind: "expr", default: "$", required: (isObj(rb) && rb.required === true) || bodyParam?.required === true,
          help: [desc.trim().split("\n")[0].slice(0, 200), "An expression; $ is the current payload"].filter(Boolean).join(" - ") });
        bodyTemplate = "{{ $params.body }}";
        if (contentType && !/json/i.test(contentType)) headers.push({ key: "content-type", value: contentType });
      }
      const summary = typeof op.summary === "string" && op.summary.trim() ? op.summary.trim() : "";
      const o: ConnectorOperation = { id, name: (summary || (typeof op.operationId === "string" ? op.operationId : `${method.toUpperCase()} ${rawPath}`)).slice(0, 120), method: method.toUpperCase(), path, params };
      const description = typeof op.description === "string" && op.description.trim() ? op.description.trim() : summary ? `${method.toUpperCase()} ${rawPath}` : "";
      if (description) o.description = description.slice(0, 500);
      if (query.length) o.query = query;
      if (headers.length) o.headers = headers;
      if (bodyTemplate) o.bodyTemplate = bodyTemplate;
      operations.push(o);
    }
  }
  if (!operations.length) throw new Error("The API description has paths but no operations (get, post, put, patch, delete)");
  const now = new Date().toISOString();
  const title = (name && String(name).trim()) || (typeof info.title === "string" && info.title.trim()) || "Imported API";
  const def: ConnectorDef = { id: newId("cn"), name: title.slice(0, 80), connectionType: "http", operations, source: "openapi", createdAt: now, updatedAt: now };
  if (typeof info.description === "string" && info.description.trim()) def.description = info.description.trim().slice(0, 500);
  return def;
}

/** The server URL a description suggests, to prefill a new connection. */
export function suggestedBaseUrl(spec: unknown): string | undefined {
  let doc: Obj; try { doc = parseSpec(spec); } catch { return undefined; }
  if (Array.isArray(doc.servers) && isObj(doc.servers[0]) && typeof doc.servers[0].url === "string") return doc.servers[0].url;
  if (typeof doc.host === "string") return `${Array.isArray(doc.schemes) && doc.schemes.includes("https") ? "https" : "http"}://${doc.host}`;
  return undefined;
}
