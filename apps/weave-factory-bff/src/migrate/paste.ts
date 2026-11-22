// Pasted code and single files: wrapped into a .zip with a minimal project of their technology, so the
// migration tool and the factory read them like any upload. The layout is the same as the factory's own
// (migration-factory/factory/paste.py; keep them in step): Mule src/main/mule/*.xml + DataWeave in
// src/main/resources/dwl, a webMethods package <Pkg>/ns/<Pkg>/<folder>/<service>/flow.xml (+ a minimal node.ndf
// when only the flow was pasted), Boomi export/components/*.xml, Java src/main/java/<package>/. A PASTED.txt
// manifest at the top says it was pasted (or was one file) and which snippets it holds: the factory marks the
// result "partial source" and lists what the snippets cannot show. Nothing here runs the code.
import { deflateRawSync } from "node:zlib";

export const PASTE_TECHNOLOGIES = [
  { id: "auto", label: "Detect from the code" },
  { id: "mule4", label: "MuleSoft (Mule 4 XML, DataWeave)" },
  { id: "webmethods", label: "webMethods (flow.xml, node.ndf, Java service)" },
  { id: "boomi", label: "Boomi (component XML, Groovy)" },
  { id: "java", label: "Java" },
  { id: "dotnet", label: ".NET (C#)" },
  { id: "node", label: "Node.js (JavaScript / TypeScript)" },
  { id: "openapi", label: "OpenAPI / Swagger" },
  { id: "ballerina", label: "Ballerina" },
] as const;
export type PasteTech = (typeof PASTE_TECHNOLOGIES)[number]["id"];
const TECH_IDS = PASTE_TECHNOLOGIES.map((t) => t.id) as readonly string[];

/** Single files the New migration screen accepts; the server wraps each into a project zip. */
/** One-file integrations read whole by the factory's plug-in readers (passed through unchanged, never wrapped as a partial
 *  snippet): TIBCO BW6 process, BizTalk map / orchestration, SSIS package, XSLT stylesheet, SAP CPI iFlow. Logic App and
 *  Step Functions definitions are .json, which is accepted already. */
export const INTEGRATION_FILE_EXTENSIONS = [".bwp", ".btm", ".odx", ".dtsx", ".xsl", ".xslt", ".iflw"];
export const SINGLE_FILE_EXTENSIONS = [".xml", ".html", ".htm", ".dwl", ".java", ".groovy", ".cs", ".js", ".ts", ".yaml", ".yml", ".wsdl", ".xsd", ".bal", ".properties"];
export const PASTE_LIMITS = { maxSnippets: 20, maxSnippetBytes: 1024 * 1024, maxTotalBytes: 2 * 1024 * 1024, maxNameLength: 120, singleFileMb: 10 };

const MULE_NS = /<mule[\s>][^>]*mulesoft\.org\/schema\/mule|xmlns(:\w+)?="http:\/\/www\.mulesoft\.org\/schema\/mule/s;
const WM_FLOW = /<FLOW[\s>]/;
const WM_NDF = /<Values\s+version=|<value\s+name="svc_type"/;
const BOOMI = /<bns:Component[\s>]|http:\/\/api\.platform\.boomi\.com\//;
const DW = /^\s*%dw\s+[12]\.\d/m;
const JAVA = /^\s*(package\s+[\w.]+\s*;|import\s+[\w.*]+\s*;|(public\s+)?(final\s+)?(abstract\s+)?(class|interface|enum|record)\s+\w+)/m;
const OPENAPI = /^\s*["']?(openapi|swagger)["']?\s*:/m;

/** The technology of ONE file: platform markers in the content first, the name second. */
export function sniff(name: string, text: string): PasteTech | "unknown" {
  const low = name.toLowerCase();
  const head = text.slice(0, 200_000);
  if (BOOMI.test(head)) return "boomi";
  if (low.endsWith(".xml") || low.endsWith(".ndf")) {
    if (MULE_NS.test(head)) return "mule4";
    if (WM_FLOW.test(head) || WM_NDF.test(head)) return "webmethods";
  }
  if (low.endsWith(".dwl") || DW.test(head.slice(0, 2000))) return "mule4";
  const base = low.split("/").pop() ?? "";
  if (low.endsWith(".java") || ((!base.includes(".") || base.endsWith(".txt")) && JAVA.test(head) && head.includes("class"))) return "java";
  if (low.endsWith(".groovy")) return /\bdataContext\b|com\.boomi\./.test(head) ? "boomi" : "java";
  if (low.endsWith(".cs")) return "dotnet";
  if (low.endsWith(".bal")) return "ballerina";
  if (/\.(ya?ml|json)$/.test(low) && OPENAPI.test(head)) return "openapi";
  if (/\.(js|ts)$/.test(low)) return "node";
  return "unknown";
}
export function sniffAll(snippets: { name: string; text: string }[]): PasteTech | "unknown" {
  const found = new Set(snippets.map((s) => sniff(s.name, s.text)));
  for (const t of ["boomi", "webmethods", "mule4", "ballerina", "dotnet", "java", "openapi", "node"] as const) if (found.has(t)) return t;
  return "unknown";
}

export function slug(name: string, dflt = "pasted"): string {
  const s = String(name || "").replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^[-_]+|[-_]+$/g, "").toLowerCase().slice(0, 60);
  return s || dflt;
}
export function safeName(name: string, dflt: string): string {
  const base = String(name || "").trim().split(/[\\/]/).pop() ?? "";
  const s = base.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[._]+|[._]+$/g, "").slice(0, 100);
  return s || dflt;
}
const ident = (s: string) => { const o = s.replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_+|_+$/g, ""); return (/^\d/.test(o) ? "P_" + o : o) || "Pasted"; };
const title = (s: string) => s.toLowerCase().split("_").map((w) => (w ? w[0].toUpperCase() + w.slice(1) : "")).join("") || "Pasted";

function defaultName(tech: string, text: string, i: number): string {
  if (tech === "java") { const m = /\b(class|interface|enum|record)\s+(\w+)/.exec(text); return `${m ? m[2] : `Pasted${i}`}.java`; }
  if (tech === "mule4") return DW.test(text.slice(0, 2000)) && !text.slice(0, 200).includes("<") ? `pasted-${i}.dwl` : `pasted-${i}.xml`;
  if (tech === "webmethods") return WM_NDF.test(text) && !WM_FLOW.test(text) ? "node.ndf" : "flow.xml";
  if (tech === "boomi") return `component-${i}.xml`;
  if (tech === "dotnet") return `Pasted${i}.cs`;
  if (tech === "ballerina") return `pasted${i}.bal`;
  if (tech === "openapi") return `openapi-${i}.yaml`;
  if (tech === "node") return `pasted${i}.js`;
  return `snippet-${i}.txt`;
}

function wmService(name: string, i: number): [string, string] {
  const raw = String(name || "").trim();
  if (raw.includes(":") && !raw.toLowerCase().endsWith(".xml")) {
    const at = raw.lastIndexOf(":");
    const ns = raw.slice(0, at).split(".").filter(Boolean).map(ident).join(".");
    return [ns || "pasted", ident(raw.slice(at + 1))];
  }
  let parts = raw.split(/[\\/]/).filter(Boolean);
  if (parts.length && ["flow.xml", "node.ndf"].includes(parts[parts.length - 1].toLowerCase())) parts = parts.slice(0, -1);
  if (parts.length && parts[0].toLowerCase() === "ns") parts = parts.slice(1);
  if (parts.length >= 2) return [parts.slice(0, -1).map(ident).join("."), ident(parts[parts.length - 1])];
  if (parts.length === 1 && !/\.(xml|ndf)$/i.test(parts[0])) return ["pasted", ident(parts[0])];
  return ["pasted", `service${i}`];
}

export const WM_NDF_TEMPLATE = `<?xml version="1.0" encoding="UTF-8"?>
<Values version="2.0">
  <value name="svc_type">flow</value>
  <value name="svc_subtype">default</value>
  <value name="svc_sigtype">java 3.5</value>
  <record name="svc_sig" javaclass="com.wm.util.Values">
    <record name="sig_in" javaclass="com.wm.util.Values"><value name="field_type">record</value><array name="rec_fields" type="record" depth="1"/></record>
    <record name="sig_out" javaclass="com.wm.util.Values"><value name="field_type">record</value><array name="rec_fields" type="record" depth="1"/></record>
  </record>
  <value name="node_comment">Generated by the migration factory: only the flow was pasted, the signature is not known.</value>
</Values>
`;
const WM_MANIFEST = `<?xml version="1.0" encoding="UTF-8"?>
<Values version="2.0">
  <value name="enabled">yes</value>
  <value name="system_package">no</value>
  <value name="version">0.0</value>
  <value name="description">Generated by the migration factory around pasted code</value>
  <record name="requires" javaclass="com.wm.util.Values"><value name="WmPublic">*.*</value></record>
</Values>
`;

export interface Snippet { name: string; text: string }
/** Relative path -> text of a minimal project holding the snippets, with PASTED.txt at the top. */
export function layout(snippets: Snippet[], technology: string, project: string, source: "pasted" | "single-file" = "pasted", createdBy = "weave-factory"): { technology: string; files: Map<string, string> } {
  const snips = snippets.slice(0, 50).map((s) => ({ name: s.name || "", text: s.text || "" }));
  const tech = TECH_IDS.includes(technology) && technology !== "auto" ? technology : sniffAll(snips);
  const proj = slug(project);
  const files = new Map<string, string>();
  const lineSnip: string[] = [], lineGen: string[] = [];
  const put = (relIn: string, text: string, given: string) => {
    let rel = relIn, n = 2;
    while (files.has(rel)) {
      const dot = relIn.lastIndexOf(".");
      rel = dot > relIn.lastIndexOf("/") ? `${relIn.slice(0, dot)}-${n}${relIn.slice(dot)}` : `${relIn}-${n}`;
      n++;
    }
    files.set(rel, text);
    lineSnip.push(`snippet: ${rel} <- ${given || "(no name)"} (${Buffer.byteLength(text, "utf8")} bytes)`);
  };
  const pkg = title(ident(proj));
  const wmDirs: string[] = [];
  snips.forEach(({ name: given, text }, idx) => {
    const i = idx + 1;
    const kind = sniff(given || defaultName(tech, text, i), text);
    const name = safeName(given, defaultName(kind !== "unknown" ? kind : tech, text, i));
    const low = name.toLowerCase();
    if (tech === "mule4") {
      let rel: string;
      if (low.endsWith(".dwl")) rel = `src/main/resources/dwl/${name}`;
      else if (/\.(ya?ml|properties)$/.test(low) && !OPENAPI.test(text)) rel = `src/main/resources/${name}`;
      else if (/\.(raml|ya?ml|json)$/.test(low)) rel = `src/main/resources/api/${name}`;
      else if (low.endsWith(".java")) rel = `src/main/java/${name}`;
      else if (low.endsWith(".xml") && MULE_NS.test(text.slice(0, 200_000))) rel = `src/main/mule/${low === "flow.xml" ? "pasted-flow.xml" : name}`;
      else rel = `src/main/resources/${name}`;
      put(rel, text, given);
    } else if (tech === "webmethods") {
      const code = /\.(java|html|htm|properties|wsdl|xsd)$/.test(low);
      const dirOf = () => { const [folder, svc] = wmService(given, i); return `${pkg}/ns/${pkg}/${folder.split(".").join("/")}/${svc}`; };
      if (!code && WM_FLOW.test(text.slice(0, 200_000))) { const d = dirOf(); put(`${d}/flow.xml`, text, given); wmDirs.push(d); }
      else if (low.endsWith(".ndf") || (!code && WM_NDF.test(text.slice(0, 5000)))) {
        const last = wmDirs[wmDirs.length - 1];
        if (last && !files.has(`${last}/node.ndf`)) put(`${last}/node.ndf`, text, given);
        else { const d = dirOf(); put(`${d}/node.ndf`, text, given); wmDirs.push(d); }
      } else if (low.endsWith(".java")) put(`${pkg}/code/source/${name}`, text, given);
      else if (low.endsWith(".properties")) put(`${pkg}/config/${name}`, text, given);
      else if (low.endsWith(".wsdl")) put(`${pkg}/resources/wsdl/${name}`, text, given);
      else if (low.endsWith(".xsd")) put(`${pkg}/resources/xsd/${name}`, text, given);
      else if (/\.html?$/.test(low)) put(`docs/${name}`, text, given);
      else put(`${pkg}/resources/${name}`, text, given);
    } else if (tech === "boomi") {
      if (low.endsWith(".groovy")) put(`export/scripts/${name}`, text, given);
      else if (/\.html?$/.test(low)) put(`docs/${name}`, text, given);
      else put(`export/components/${low.endsWith(".xml") ? name : name + ".xml"}`, text, given);
    } else if (tech === "java") {
      if (/\.(java|groovy)$/.test(low)) {
        const m = /^\s*package\s+([\w.]+)\s*;/m.exec(text);
        put(`src/main/${low.endsWith(".groovy") ? "groovy" : "java"}/${m ? m[1].replace(/\./g, "/") + "/" : ""}${name}`, text, given);
      } else put(`src/main/resources/${name}`, text, given);
    } else if (tech === "ballerina") put(low.endsWith(".bal") ? name : `resources/${name}`, text, given);
    else if (tech === "openapi") put(`api/${name}`, text, given);
    else if (/\.html?$/.test(low)) put(name, text, given);
    else put(`src/${name}`, text, given);
  });
  if (tech === "mule4") {
    if (![...files.keys()].some((r) => r.startsWith("src/main/mule/"))) lineGen.push("note: no Mule configuration XML was pasted (only DataWeave or resources)");
    if (!files.has("mule-artifact.json")) files.set("mule-artifact.json", JSON.stringify({ minMuleVersion: "4.4.0" }) + "\n");
    lineGen.push("generated: mule-artifact.json (minimal; the runtime version is not known)");
    if (!files.has("pom.xml")) files.set("pom.xml", `<?xml version="1.0" encoding="UTF-8"?>\n<project xmlns="http://maven.apache.org/POM/4.0.0">\n  <modelVersion>4.0.0</modelVersion>\n  <groupId>pasted</groupId>\n  <artifactId>${proj}</artifactId>\n  <version>0.0.0</version>\n  <packaging>mule-application</packaging>\n  <name>${proj}</name>\n</project>\n`);
    lineGen.push("generated: pom.xml (minimal; the dependencies are not known)");
  } else if (tech === "webmethods") {
    if (!files.has(`${pkg}/manifest.v3`)) files.set(`${pkg}/manifest.v3`, WM_MANIFEST);
    lineGen.push(`generated: ${pkg}/manifest.v3 (minimal package manifest)`);
    for (const d of wmDirs) if (!files.has(`${d}/node.ndf`)) { files.set(`${d}/node.ndf`, WM_NDF_TEMPLATE); lineGen.push(`generated: ${d}/node.ndf (minimal; only flow.xml was pasted, the signature is not known)`); }
  } else if (tech === "ballerina") {
    if (!files.has("Ballerina.toml")) files.set("Ballerina.toml", `[package]\norg = "pasted"\nname = "${ident(proj).toLowerCase()}"\nversion = "0.0.0"\n`);
    lineGen.push("generated: Ballerina.toml (minimal)");
  }
  files.set("PASTED.txt", ["PASTED SOURCE - not a whole project", `source: ${source}`, `technology: ${tech}`, `created-by: ${createdBy}`, ...lineSnip, ...lineGen].join("\n") + "\n");
  return { technology: tech, files };
}

// ---- a plain .zip writer (deflate), enough for a handful of text files
const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
export function crc32(buf: Buffer): number { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
export function zipFiles(entries: { path: string; data: Buffer }[]): Buffer {
  const locals: Buffer[] = [], centrals: Buffer[] = [];
  let offset = 0;
  // a fixed time (1 Jan 2020): the same snippets give the same bytes
  const time = 0, date = ((2020 - 1980) << 9) | (1 << 5) | 1;
  for (const e of entries) {
    const name = Buffer.from(e.path, "utf8");
    const comp = deflateRawSync(e.data);
    const crc = crc32(e.data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(8, 8);
    lh.writeUInt16LE(time, 10); lh.writeUInt16LE(date, 12); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(e.data.length, 22); lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    locals.push(lh, name, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(8, 10);
    ch.writeUInt16LE(time, 12); ch.writeUInt16LE(date, 14); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(e.data.length, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt16LE(0, 30); ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34); ch.writeUInt16LE(0, 36); ch.writeUInt32LE(0, 38); ch.writeUInt32LE(offset, 42);
    centrals.push(ch, name);
    offset += lh.length + name.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

/** The project zip: everything under one top folder named after the project (the API's name in the factory). */
export function wrapToZip(snippets: Snippet[], technology: string, project: string, source: "pasted" | "single-file"): { zip: Buffer; filename: string; technology: string; paths: string[] } {
  const top = slug(project);
  const { technology: tech, files } = layout(snippets, technology, top, source);
  const entries = [...files.entries()].map(([p, text]) => ({ path: `${top}/${p}`, data: Buffer.from(text, "utf8") }));
  return { zip: zipFiles(entries), filename: `${top}.zip`, technology: tech, paths: [...files.keys()] };
}

/** Text of an uploaded single file (UTF-8, UTF-16 with BOM, else Latin-1). */
export function decodeText(buf: Buffer): string {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString("utf16le");
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString("utf8");
  const s = buf.toString("utf8");
  return s.includes("\uFFFD") ? buf.toString("latin1") : s;
}

export function isSingleFile(filename: string): boolean {
  const ext = (/\.[a-z0-9]+$/i.exec(filename)?.[0] || "").toLowerCase();
  return SINGLE_FILE_EXTENSIONS.includes(ext);
}

const NAME_OK = /^[A-Za-z0-9][A-Za-z0-9 ._:/\\-]*$/;
/** The "Paste code" form, checked: name, workspace, target, technology and 1..20 snippets within the size limits. */
export function pastedOf(body: unknown, targets: string[]):
  { ok: true; value: { name: string; workspace: string; target: string; technology: string; snippets: Snippet[] } } | { ok: false; error: string } {
  const b = (body && typeof body === "object" && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
  const str = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/[^\x20-\x7e]/g, "-").replace(/["\\]/g, "").trim().slice(0, max) : "");
  const name = str(b.name, 120), workspace = str(b.workspace, 80);
  const target = (typeof b.target === "string" ? b.target : "wso2").toLowerCase();
  const technology = typeof b.technology === "string" && b.technology ? b.technology : "auto";
  if (!name) return { ok: false, error: "Give the migration a name" };
  if (!targets.includes(target)) return { ok: false, error: "Unknown target technology" };
  if (!TECH_IDS.includes(technology)) return { ok: false, error: "Choose what the pasted code is written in" };
  const raw = Array.isArray(b.snippets) ? b.snippets : [];
  if (!raw.length) return { ok: false, error: "Paste at least one piece of code" };
  if (raw.length > PASTE_LIMITS.maxSnippets) return { ok: false, error: `Paste at most ${PASTE_LIMITS.maxSnippets} pieces of code` };
  const snippets: Snippet[] = [];
  let total = 0;
  const seen = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const s = (raw[i] && typeof raw[i] === "object" ? raw[i] : {}) as Record<string, unknown>;
    const text = typeof s.text === "string" ? s.text : "";
    const fname = typeof s.name === "string" ? s.name.trim() : "";
    const n = i + 1;
    if (!text.trim()) return { ok: false, error: `Piece ${n} is empty` };
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes > PASTE_LIMITS.maxSnippetBytes) return { ok: false, error: `Piece ${n} is larger than ${PASTE_LIMITS.maxSnippetBytes / 1024} KB` };
    total += bytes;
    if (fname && (fname.length > PASTE_LIMITS.maxNameLength || !NAME_OK.test(fname) || fname.split(/[\\/]/).includes(".."))) return { ok: false, error: `The file name of piece ${n} may use letters, digits, spaces and . _ - : / only` };
    if (fname) { const k = fname.toLowerCase(); if (seen.has(k) && !/^(flow\.xml|node\.ndf)$/.test(k)) return { ok: false, error: `Two pieces are both called ${fname}` }; seen.add(k); }
    snippets.push({ name: fname, text });
  }
  if (total > PASTE_LIMITS.maxTotalBytes) return { ok: false, error: `All pieces together are larger than ${PASTE_LIMITS.maxTotalBytes / 1024 / 1024} MB. Upload the project as a .zip instead.` };
  return { ok: true, value: { name, workspace, target, technology, snippets } };
}
