// What the migration tool accepts. It recognises the source technology from the uploaded archive
// by itself; this list tells the user what to upload and what happens to anything else.
export interface SourceTech { id: string; label: string; upload: string; hint?: string; sourceType?: "spec"; }
export interface TargetTech { id: string; label: string; depth: "full" | "skeleton"; hint: string; }

export const SOURCE_TECHNOLOGIES: SourceTech[] = [
  { id: "auto", label: "Detect automatically", upload: "A .zip or .jar of the project", hint: "The source technology is recognised from the files inside the archive." },
  { id: "mule4", label: "MuleSoft (Mule 4)", upload: "The project folder as a .zip, or the deployable .jar" },
  { id: "ibm", label: "IBM App Connect / Integration Bus", upload: "The project folder as a .zip" },
  { id: "oracle", label: "Oracle SOA Suite / Service Bus", upload: "The composite or project as a .zip or .jar" },
  { id: "boomi", label: "Boomi", upload: "The exported process components as a .zip" },
  { id: "webmethods", label: "webMethods", upload: "The exported package as a .zip" },
  { id: "workato", label: "Workato", upload: "The exported recipes as a .zip" },
  { id: "dotnet", label: ".NET (ASP.NET Web API)", upload: "The solution folder as a .zip" },
  { id: "java", label: "Java (Spring / JAX-RS)", upload: "The project folder as a .zip, or the .jar" },
  { id: "ballerina", label: "Ballerina", upload: "The package folder as a .zip" },
  { id: "openapi", label: "OpenAPI / Swagger description", upload: "A .zip that contains the openapi or swagger file (.yaml or .json)" },
  { id: "spec", label: "Written specification (no source code)", upload: "The functionality and mapping specification as a .json file", sourceType: "spec",
    hint: "Documents and a service are generated straight from the specification." },
  { id: "other", label: "Something else (for example Node.js)", upload: "A .zip that contains the OpenAPI or Swagger description of the API",
    hint: "Technologies that are not in this list are not read from their code. Upload the API's OpenAPI or Swagger description instead (most frameworks can export one), or use a written specification. An archive with neither is rejected with \"technology not recognised\"." },
];

export const TARGET_TECHNOLOGIES: TargetTech[] = [
  { id: "wso2", label: "WSO2 (Ballerina service)", depth: "full", hint: "Complete generator: documents, service, tests and deployment." },
  { id: "mule", label: "MuleSoft", depth: "skeleton", hint: "Project skeleton and documents." },
  { id: "springboot", label: "Spring Boot", depth: "skeleton", hint: "Project skeleton and documents." },
  { id: "dotnet", label: ".NET", depth: "skeleton", hint: "Project skeleton and documents." },
  { id: "webmethods", label: "webMethods", depth: "skeleton", hint: "Project skeleton and documents." },
  { id: "boomi", label: "Boomi", depth: "skeleton", hint: "Project skeleton and documents." },
  { id: "openapi", label: "OpenAPI description only", depth: "skeleton", hint: "The API contract and documents, no service." },
];

export const UPLOAD_EXTENSIONS = [".zip", ".jar", ".json"];

/** Header values go to the migration tool as plain ASCII. */
export function headerSafe(s: string, max = 120): string {
  return s.replace(/[^\x20-\x7e]/g, "-").replace(/["\\]/g, "").trim().slice(0, max);
}

export function validateUpload(q: { name?: string; workspace?: string; filename?: string; sourceType?: string; target?: string }, length: number | undefined, limitMb: number):
  { ok: true; headers: Record<string, string> } | { ok: false; status: number; error: string } {
  const name = headerSafe(q.name || "");
  const filename = headerSafe((q.filename || "").replace(/^.*[\\/]/, ""), 160);
  const workspace = headerSafe(q.workspace || "");
  const target = (q.target || "wso2").toLowerCase();
  if (!name) return { ok: false, status: 400, error: "Give the migration a name" };
  if (!filename) return { ok: false, status: 400, error: "Choose the file to upload" };
  const ext = (/\.[a-z0-9]+$/i.exec(filename)?.[0] || "").toLowerCase();
  if (!UPLOAD_EXTENSIONS.includes(ext)) return { ok: false, status: 400, error: `This file type is not accepted. Upload ${UPLOAD_EXTENSIONS.join(", ")} (zip a project folder first).` };
  const spec = q.sourceType === "spec";
  if (spec && ext !== ".json") return { ok: false, status: 400, error: "A written specification must be a .json file" };
  if (!spec && ext === ".json") return { ok: false, status: 400, error: "A .json file is only accepted as a written specification. Put an OpenAPI file in a .zip." };
  if (!TARGET_TECHNOLOGIES.some((t) => t.id === target)) return { ok: false, status: 400, error: "Unknown target technology" };
  if (length === undefined || !Number.isFinite(length)) return { ok: false, status: 411, error: "The upload has no size; try again" };
  if (length <= 0) return { ok: false, status: 400, error: "The file is empty" };
  if (length > limitMb * 1024 * 1024) return { ok: false, status: 413, error: `The file is larger than ${limitMb} MB` };
  const headers: Record<string, string> = { "X-Name": name, "X-Filename": filename, "X-Target-Tech": target };
  if (workspace) headers["X-Workspace"] = workspace;
  if (spec) headers["X-Source-Type"] = "spec";
  return { ok: true, headers };
}

/** Passwords and tokens kept by the migration tool are never passed on to the browser. */
export function withoutSecrets<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => withoutSecrets(v)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (/^(password|token|secret|apiKey|authorization)$/i.test(k)) { out[`${k}Set`] = typeof v === "string" ? v.length > 0 : !!v; continue; }
      out[k] = withoutSecrets(v);
    }
    return out as T;
  }
  return value;
}

export interface MigrationLite { id: string; name?: string; apiName?: string; workspace?: string; progress?: { outcome?: string; overallPercent?: number } }

/** Another migration that already produced a service with the same name. */
export function collisionOf(list: MigrationLite[], id: string): MigrationLite | undefined {
  const me = list.find((m) => m.id === id);
  if (!me?.apiName) return undefined;
  return list.find((m) => m.id !== id && m.apiName === me.apiName);
}

export function mergeWorkspaces(groups: any[], configs: any[], envs: any[], migrations: any[]) {
  const byName = new Map<string, any>();
  const at = (name: string) => {
    const key = name.toLowerCase();
    if (!byName.has(key)) byName.set(key, { name, total: 0, deployed: 0, failed: 0, inProgress: 0, migrations: [], environments: [], config: null });
    return byName.get(key);
  };
  for (const g of groups || []) Object.assign(at(String(g.name || "Unassigned")), { total: g.total || 0, deployed: g.deployed || 0, failed: g.failed || 0 });
  for (const m of migrations || []) {
    const w = at(String(m.workspace || "Unassigned"));
    w.migrations.push({ id: m.id, name: m.name, apiName: m.apiName, technology: m.technology, layer: m.layer, outcome: m.progress?.outcome, percent: m.progress?.overallPercent, busy: !!m.busy });
  }
  for (const w of byName.values()) { if (!w.total) w.total = w.migrations.length; w.inProgress = Math.max(0, w.total - w.deployed - w.failed); }
  for (const c of configs || []) at(String(c.name || "Unnamed")).config = withoutSecrets(c);
  for (const e of envs || []) at(String(e.workspace || "Unassigned")).environments.push(withoutSecrets(e));
  return [...byName.values()].sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
}
