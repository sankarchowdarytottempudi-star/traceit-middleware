// Pure helpers for the migration and estate screens (no network, no DOM): wording, filters,
// form checks, the landscape layout and the chart scale. Covered by test/migrate.test.ts.
import { num, txt } from "./text.ts";

export type Tone = "ok" | "warn" | "bad" | "accent" | "muted";
export type LayerKey = "exp" | "proc" | "sys" | "other";

export function layerKey(layer: unknown): LayerKey {
  const l = txt(layer).toLowerCase();
  if (l.startsWith("exp")) return "exp";
  if (l.startsWith("proc")) return "proc";
  if (l.startsWith("sys")) return "sys";
  return "other";
}
export const LAYER_LABEL: Record<LayerKey, string> = { exp: "Experience", proc: "Process", sys: "System", other: "Other" };

/** Installed on the cluster, but part of the old application is not written yet. */
export const NOT_FINISHED = "Deployed, not finished";
/** A project for another platform (webMethods, MuleSoft, Boomi, ...): generated, checked and packaged; the customer installs it. */
export const READY_DOWNLOAD = "Ready to download";
const TARGET_LABEL: Record<string, string> = { wso2: "WSO2", ballerina: "WSO2", mule: "MuleSoft", springboot: "Spring Boot", dotnet: ".NET", webmethods: "webMethods", boomi: "Boomi", workato: "Workato", openapi: "OpenAPI", nodejs: "Node.js", node: "Node.js" };
export function targetOf(m: { targetTech?: unknown }): string { return (txt(m.targetTech) || "wso2").toLowerCase(); }
export function isWso2Target(m: { targetTech?: unknown }): boolean { const t = targetOf(m); return t === "wso2" || t === "ballerina"; }
export function targetLabel(m: { targetTech?: unknown }): string { const t = targetOf(m); return TARGET_LABEL[t] ?? t; }
export function outcomeTone(outcome: unknown): Tone {
  switch (txt(outcome)) {
    case "Failed": return "bad";
    case NOT_FINISHED: return "warn";
    case "Verified": case "Deployed": case "Complete": case READY_DOWNLOAD: return "ok";
    case "Not started": case "": return "muted";
    default: return "accent";
  }
}
export function statusTone(status: unknown): Tone {
  switch (txt(status)) {
    case "done": return "ok";
    case "failed": return "bad";
    case "running": return "accent";
    case "action_required": return "warn";
    default: return "muted";
  }
}
export function statusLabel(status: unknown): string {
  switch (txt(status)) {
    case "done": return "Done";
    case "failed": return "Failed";
    case "running": return "Running";
    case "action_required": return "Needs you";
    case "skipped": return "Skipped";
    case "pending": case "": return "Waiting";
    default: return txt(status).replace(/_/g, " ");
  }
}
export function healthTone(health: unknown): Tone {
  switch (txt(health)) {
    case "healthy": return "ok";
    case "degraded": return "warn";
    case "down": return "bad";
    default: return "muted";
  }
}
export function healthLabel(health: unknown): string {
  switch (txt(health)) {
    case "healthy": return "Healthy";
    case "degraded": return "Degraded";
    case "down": return "Down";
    default: return "Unknown";
  }
}

/** "5 min ago", "3 h ago", "2 d ago"; empty for a missing or unreadable date. */
export function ago(iso: unknown, now: number = Date.now()): string {
  const t = Date.parse(txt(iso));
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}
export function dateTime(iso: unknown): string {
  const t = Date.parse(txt(iso));
  if (!Number.isFinite(t)) return "";
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
export function clock(iso: unknown, withDate = false): string {
  const t = Date.parse(txt(iso));
  if (!Number.isFinite(t)) return "";
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, "0");
  const time = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  return withDate ? `${p(d.getMonth() + 1)}-${p(d.getDate())} ${time}` : time;
}
export function compact(n: unknown): string {
  const v = num(n);
  if (Math.abs(v) >= 1_000_000) return `${(v / 1_000_000).toFixed(v % 1_000_000 === 0 ? 0 : 1)}M`;
  if (Math.abs(v) >= 10_000) return `${(v / 1000).toFixed(v % 1000 === 0 ? 0 : 1)}K`;
  return v.toLocaleString("en-US");
}
export function fileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
export function ms(v: unknown): string {
  const n = num(v);
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)} s`;
  return `${Math.round(n)} ms`;
}
export function baseName(path: unknown): string {
  return txt(path).replace(/^.*[\\/]/, "").replace(/^[0-9a-f]{8}-/, "");
}

// ---- migrations list
export interface MigrationRow { id: string; name?: unknown; apiName?: unknown; workspace?: unknown; technology?: unknown; busy?: boolean; queued?: number; progress?: { outcome?: unknown } | null }
export interface MigrationFilter { q?: string; workspace?: string; outcome?: string; technology?: string }
export function filterMigrations<T extends MigrationRow>(list: T[], f: MigrationFilter): T[] {
  const q = (f.q || "").trim().toLowerCase();
  return list.filter((m) => {
    if (f.workspace && txt(m.workspace) !== f.workspace) return false;
    if (f.technology && txt(m.technology) !== f.technology) return false;
    if (f.outcome) {
      if (f.outcome === "running") { if (!m.busy) return false; }
      else if (txt(m.progress?.outcome) !== f.outcome) return false;
    }
    if (!q) return true;
    return [m.name, m.apiName, m.id, m.workspace, m.technology].some((v) => txt(v).toLowerCase().includes(q));
  });
}
export function distinct(values: unknown[]): string[] {
  return [...new Set(values.map((v) => txt(v)).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

// ---- new migration form
export interface NewMigrationForm { name: string; workspace: string; technology: string; target: string; file: { name: string; size: number } | null }
export interface NewMigrationRules { extensions: string[]; maxUploadMb: number; technologies: { id: string; sourceType?: string }[] }
export function validateNewMigration(f: NewMigrationForm, rules: NewMigrationRules): Partial<Record<"name" | "workspace" | "file" | "technology", string>> {
  const e: Partial<Record<"name" | "workspace" | "file" | "technology", string>> = {};
  const name = f.name.trim();
  if (!name) e.name = "Give the migration a name";
  else if (name.length > 120) e.name = "Keep the name under 120 characters";
  else if (/[^\x20-\x7E]/.test(name)) e.name = "Use plain letters, digits and punctuation in the name";
  if (!f.workspace.trim()) e.workspace = "Choose a workspace or type a new one";
  else if (/[^\x20-\x7E]/.test(f.workspace)) e.workspace = "Use plain letters, digits and punctuation in the workspace name";
  if (!f.technology) e.technology = "Choose what the source is written in";
  if (!f.file) { e.file = "Choose the file to upload"; return e; }
  const ext = (/\.[a-z0-9]+$/i.exec(f.file.name)?.[0] || "").toLowerCase();
  const spec = rules.technologies.find((t) => t.id === f.technology)?.sourceType === "spec";
  if (!rules.extensions.includes(ext)) e.file = `This file type is not accepted. Upload ${rules.extensions.join(", ")} (zip a project folder first).`;
  else if (spec && ext !== ".json") e.file = "A written specification must be a .json file";
  else if (!spec && ext === ".json") e.file = "A .json file is only accepted as a written specification. Put an OpenAPI file in a .zip.";
  else if (f.file.size <= 0) e.file = "The file is empty";
  else if (f.file.size > rules.maxUploadMb * 1024 * 1024) e.file = `The file is larger than ${rules.maxUploadMb} MB`;
  return e;
}

// ---- "Paste code": snippets instead of a file
export interface PasteSnippet { name: string; text: string }
export interface PasteRules { maxSnippets: number; maxSnippetKb: number; maxTotalKb: number }
export const PASTE_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._:/\\-]*$/;
export const textBytes = (s: string) => new TextEncoder().encode(s).length;
/** Problems of the pasted pieces: per piece (by index) and for the whole set. */
export function validatePaste(snippets: PasteSnippet[], rules: PasteRules): { pieces: Record<number, string>; all?: string } {
  const pieces: Record<number, string> = {};
  const filled = snippets.filter((s) => s.text.trim());
  if (!filled.length) return { pieces, all: "Paste at least one piece of code" };
  if (snippets.length > rules.maxSnippets) return { pieces, all: `Paste at most ${rules.maxSnippets} pieces of code` };
  let total = 0;
  const seen = new Map<string, number>();
  snippets.forEach((s, i) => {
    const b = textBytes(s.text);
    total += b;
    const name = s.name.trim();
    if (!s.text.trim()) pieces[i] = "This piece is empty: paste the code or remove the piece";
    else if (b > rules.maxSnippetKb * 1024) pieces[i] = `This piece is larger than ${rules.maxSnippetKb} KB`;
    else if (name && (name.length > 120 || !PASTE_NAME.test(name) || name.split(/[\\/]/).includes(".."))) pieces[i] = "The file name may use letters, digits, spaces and . _ - : / only";
    else if (name && seen.has(name.toLowerCase()) && !/^(flow\.xml|node\.ndf)$/i.test(name)) pieces[i] = `Another piece is already called ${name}`;
    if (name) seen.set(name.toLowerCase(), i);
  });
  if (total > rules.maxTotalKb * 1024) return { pieces, all: `All pieces together are larger than ${Math.round(rules.maxTotalKb / 1024)} MB. Upload the project as a .zip instead.` };
  return { pieces };
}
/** A file name to suggest for the technology (placeholder text only). */
export function pasteNameHint(technology: string): string {
  return ({ mule4: "for example orders-flow.xml or transform.dwl", webmethods: "for example flow.xml, node.ndf or orders.process:receiveOrder", boomi: "for example process.xml",
    java: "for example OrderService.java", dotnet: "for example OrdersController.cs", node: "for example routes.js", openapi: "for example openapi.yaml", ballerina: "for example main.bal" } as Record<string, string>)[technology] ?? "for example flow.xml, transform.dwl, MyService.java, process.xml";
}

// ---- partial source (pasted code, one file, part of a project)
export interface PartialView { why: string; source: string; unknowns: { what: string; supply: string }[] }
export function partialOf(m: { partialSource?: unknown } | null | undefined): PartialView | null {
  const p = m?.partialSource as { why?: unknown; source?: unknown; unknowns?: unknown } | null | undefined;
  if (!p || typeof p !== "object") return null;
  const unknowns = (Array.isArray(p.unknowns) ? p.unknowns : []).map((u) => (u && typeof u === "object" ? { what: txt((u as { what?: unknown }).what), supply: txt((u as { supply?: unknown }).supply) } : { what: txt(u), supply: "" })).filter((u) => u.what);
  return { why: txt(p.why), source: txt(p.source), unknowns };
}
export const PARTIAL_SOURCE_WORD: Record<string, string> = { pasted: "pasted code", "single-file": "one file", fragment: "part of a project", "html-export": "an HTML documentation export" };

// ---- what can be done next on a migration
export interface PhaseLite { key: string; status?: string; mode?: string; steps?: { key: string; status?: string }[] }
export interface FailureLite { phase?: unknown; phaseKey?: unknown; step?: unknown; status?: unknown; detail?: unknown; output?: unknown; help?: { kind?: unknown; what?: unknown; why?: unknown; todo?: unknown; retry?: unknown } | null }
export interface MigrationState { busy?: boolean; targetTech?: unknown; apiName?: unknown; sourceType?: unknown; sourceFile?: unknown; phases?: PhaseLite[]; progress?: { outcome?: unknown; failure?: FailureLite | null } | null }
export interface NextAction { id: "autorun" | "document" | "spec" | "scaffold" | "test" | "deploy"; label: string; hint: string; primary?: boolean; writes?: boolean }
const phaseStatus = (m: MigrationState, key: string) => txt(m.phases?.find((p) => p.key === key)?.status) || "pending";
export function isSpec(m: MigrationState): boolean {
  return txt(m.sourceType) === "spec" || txt(m.sourceFile).endsWith(".spec.json");
}
/** The steps the migration tool can run, in the order they make sense, with the first sensible one marked primary. */
export function nextActions(m: MigrationState): NextAction[] {
  const doc = phaseStatus(m, "document"), sc = phaseStatus(m, "scaffold"), test = phaseStatus(m, "test"), dep = phaseStatus(m, "deploy");
  const named = !!txt(m.apiName);
  const out: NextAction[] = [];
  if (isSpec(m)) {
    out.push({ id: "spec", label: sc === "done" ? "Generate again from the specification" : "Generate from the specification", hint: "Produces the documents and the service from the written specification.", writes: true });
  } else {
    out.push({ id: "document", label: doc === "done" ? "Read the source again" : "Read the source and write the documents", hint: "Reads the uploaded source and produces the technical, mapping and functional documents and the estimate." });
    if (doc === "done" && named) out.push({ id: "scaffold", label: sc === "done" ? "Generate the service again" : "Generate the service", hint: "Creates the service code from the documents and the mapping.", writes: true });
  }
  // A service with operations that are not migrated, or a backend without an address, is not deployed.
  const notReady = txt(m.progress?.failure?.help?.kind) === "not-ready";
  const other = !isWso2Target(m);
  if (sc === "done" && named && other) {
    // another platform: the tool checks and packages the project; the customer installs it on their servers
    const lbl = targetLabel(m);
    out.push({ id: "test", label: dep === "done" ? "Check the project again" : `Check and package the ${lbl} project`, hint: `Checks the generated ${lbl} project, counts what is still marked TODO and makes it ready to download. Nothing is installed here.`, writes: true });
  } else if (sc === "done" && named) {
    out.push({ id: "test", label: test === "done" ? "Run the tests again" : "Build and run the tests", hint: "Builds the generated service, checks that every operation is migrated and runs its tests.", writes: true });
    if (!notReady) out.push({ id: "deploy", label: dep === "done" ? "Deploy again" : "Deploy", hint: "Builds the image and installs the service on the cluster.", writes: true });
  }
  let primary: NextAction["id"] | undefined;
  if (isSpec(m)) primary = sc !== "done" ? "spec" : test !== "done" ? "test" : dep !== "done" ? "deploy" : undefined;
  else if (other) primary = doc !== "done" ? "document" : sc !== "done" ? "scaffold" : dep !== "done" ? "test" : undefined;
  else primary = doc !== "done" ? "document" : sc !== "done" ? "scaffold" : test !== "done" ? "test" : dep !== "done" ? "deploy" : undefined;
  return out.map((a) => ({ ...a, primary: a.id === primary }));
}

// ---- when a step failed or is blocked: what happened, what to do, and the step to run again
export interface FailureView { blocked: boolean; title: string; what: string; why: string; todo: string[]; output: string; retry?: { id: NextAction["id"]; label: string } }
export function failureView(m: MigrationState): FailureView | null {
  const f = m.progress?.failure;
  if (!f) return null;
  const h = f.help ?? {};
  const blocked = txt(h.kind) === "not-ready" || txt(f.status) === "action_required";
  const key = txt(f.phaseKey);
  const id: NextAction["id"] | undefined = txt(h.kind) === "not-ready" ? "test"
    : key === "document" || key === "upload" ? (isSpec(m) ? "spec" : "document")
    : key === "scaffold" ? (isSpec(m) ? "spec" : "scaffold") : key === "test" ? "test" : key === "deploy" ? "deploy" : undefined;
  const offered = id ? nextActions({ ...m, progress: null }).some((a) => a.id === id) : false;
  const todo = Array.isArray(h.todo) ? h.todo.map((t) => txt(t)).filter(Boolean) : [];
  return {
    blocked,
    title: blocked ? "Not finished yet" : `${txt(f.phase) || "A step"} failed${txt(f.step) ? `: ${txt(f.step)}` : ""}`,
    what: txt(h.what) || (blocked ? "This step is waiting for you." : "This step did not finish."),
    why: txt(h.why) || txt(f.detail),
    todo: todo.length ? todo : ["Run this step again. If it fails the same way, send the tool output through the Feedback tab."],
    output: txt(f.output) || (blocked ? "" : txt(f.detail)),
    retry: id && offered ? { id, label: txt(h.kind) === "not-ready" ? "Check again (build and run the tests)" : txt(h.kind) === "pending-changes" ? "Build and check" : "Run this step again" } : undefined,
  };
}

// ---- "Finish this migration": words and checks for one open item
export interface OpenItemLike { id: string; kind: string; title: string; starts?: string; params?: string[]; suggest?: { backend?: string; method?: string; path?: string } | null;
  placeholder?: { file?: string; function?: string; each?: string; started?: boolean } | null;
  source?: { steps?: number; parts?: number; transforms?: number; calls?: { method?: string; path?: string; backend?: string }[]; loses?: unknown } | null }
export function itemKindWord(item: { kind: string; starts?: string }): string {
  if (item.kind === "backend") return "Backend without an address";
  if (item.kind === "entry") return txt(item.starts) ? `Starts by itself: ${txt(item.starts)}` : "Starts by itself";
  return item.kind === "code" ? "Operation being written" : "Operation not migrated";
}
/** What the "pass it on" form starts with: the old code's own call when it is plain, else the operation's own method. */
export function forwardStart(item: OpenItemLike, backends: string[]): { backend: string; method: string; path: string } {
  const verb = txt(item.title).split(" ")[0].toUpperCase();
  // a timer run or a topic message hands work over, so its call starts as POST
  const own = item.kind === "entry" ? "POST" : ["GET", "POST", "PUT", "PATCH", "DELETE"].includes(verb) ? verb : "GET";
  const call = item.suggest ?? (item.source?.calls ?? []).find((c) => txt(c.backend) && backends.includes(txt(c.backend)));
  const backend = call && backends.includes(txt(call.backend)) ? txt(call.backend) : backends[0] ?? "";
  const plain = (p: string) => (/^\/[A-Za-z0-9_\-./{}~%:]*$/.test(p) ? p : "");
  return { backend, method: txt(call?.method).toUpperCase() || own, path: plain(txt(call?.path)) || "/" };
}
export type DecisionLike = { action: string; newBackend?: { name?: string; url?: string }; backend?: string; method?: string; path?: string; reason?: string; url?: string; from?: string; note?: string };
/** Why a decision cannot be saved yet, in the words shown under the field; "" when it can. */
export function decisionProblem(d: DecisionLike, item: { params?: string[]; kind?: string }): string {
  if (d.action === "forward") {
    const path = txt(d.path);
    if (!txt(d.backend) && !d.newBackend) return "Choose the API the call is passed on to.";
    if (!path.startsWith("/")) return "The path starts with /.";
    if (!/^\/[A-Za-z0-9_\-./{}~%:]*$/.test(path)) return "Use letters, digits, - _ . / and {name} for a value from the caller's address.";
    const used = [...path.matchAll(/\{(\w*)\}/g)].map((x) => x[1]);
    const have = item.params ?? [];
    const bad = used.find((u) => !have.includes(u));
    if (bad !== undefined || (path.match(/[{}]/g) ?? []).length !== used.length * 2) return have.length ? `This operation only has ${have.map((p) => `{${p}}`).join(", ")} in its address.` : item.kind === "entry" ? "A part that starts by itself has no values in its address, so { } cannot be used." : "This operation has no values in its address, so { } cannot be used.";
    return "";
  }
  if (d.action === "not_needed") return txt(d.reason).length < 3 ? "Say in a few words why it is not needed." : "";
  if (d.action === "address" && txt(d.from)) return "";
  if (d.action === "address") return /^https?:\/\/[^\s"]+$/i.test(txt(d.url)) ? (/localhost/i.test(txt(d.url)) ? "localhost cannot be reached from the installed service. Use the backend's real address." : "") : "The address starts with http:// or https:// and has no spaces.";
  if (d.action === "note") return txt(d.note).length < 3 ? "Write the note first." : "";
  return "Choose what to do with this item.";
}
/** The choice in "Which API receives the call?" that stands for an API the service does not know yet. */
export const NEW_API = "+new";
/** What is wrong with the name and the address of an API added while a call is passed on; "" where it is fine. */
export function newApiProblem(name: string, url: string, known: string[]): { name: string; url: string } {
  const n = txt(name).trim().replace(/\s+/g, " "), u = txt(url).trim();
  // the tool keeps it under the words joined together, the first one in small letters
  const kept = n.split(/[^A-Za-z0-9]+/).filter(Boolean).map((w, i) => (i ? w[0].toUpperCase() : w[0].toLowerCase()) + w.slice(1)).join("");
  return {
    name: !n ? "Give the new API a name, for example loyalty engine."
      : !/^[A-Za-z][A-Za-z0-9 _-]{1,39}$/.test(n) ? "Use letters, digits and spaces, and start with a letter."
      : known.includes(kept) ? `This service already knows ${kept}. Choose it in the list, or give the new API another name.` : "",
    url: !u ? "Enter the address of the new API."
      : !/^https?:\/\/[^\s"]+$/i.test(u) ? "The address starts with http:// or https:// and has no spaces."
      : /\/\/(localhost|127\.0\.0\.1|\[::1\])(?=[:/]|$)/i.test(u) ? "localhost cannot be reached from the installed service. Use the API's real address." : "",
  };
}
/** What a pass-on would leave undone, as the tool read it from the old code (empty: the old code made one plain call). */
export function passOnLoses(item: { source?: { loses?: unknown } | null }): string[] {
  const l = item.source?.loses;
  return Array.isArray(l) ? l.map((x) => txt(x).trim()).filter(Boolean).slice(0, 12) : [];
}
/** Under the path of "pass it on": what is sent to that API each time. */
export function passOnHint(item: { kind: string; placeholder?: { each?: string } | null }): string {
  if (item.kind !== "entry") return "The caller's body, query and headers are passed on as they are.";
  return txt(item.placeholder?.each) === "message"
    ? "Every message is sent to this address as the body, exactly as it arrived. An answer of 400 or above is logged as a failed message."
    : "Every run makes this one call, with no body. An answer of 400 or above is logged as a failed run.";
}
/** What the tool already wrote for a part that starts by itself, in one line; "" when it wrote nothing. */
export function placeholderLine(item: { kind: string; placeholder?: { file?: string; function?: string; started?: boolean } | null }): string {
  const p = item.placeholder;
  if (item.kind !== "entry" || !p) return "";
  const where = `${txt(p.file) || "starts.bal"}${txt(p.function) ? `, function ${txt(p.function)}` : ""}`;
  return p.started === false
    ? `The service has a placeholder for it (${where}), but the tool does not start this kind of listener itself. It is finished in the code.`
    : `The service has a switched-off placeholder for it (${where}). Whatever is decided here, it stays off until "enabled = true" is set for it in the service's settings. Switch it on when the old application stops doing this work, otherwise the work is done twice.`;
}
/** The settings files of the upload that hold the old application's address of a backend (their names only). */
export function sourceEnvs(item: { fromSource?: unknown }): string[] {
  return Array.isArray(item.fromSource) ? item.fromSource.filter((x): x is string => typeof x === "string" && x.trim() !== "").slice(0, 40) : [];
}
/** What keeps an item with notes open, in the words shown under its notes. */
export function noteLimit(can: string[] | undefined): string {
  const c = can ?? [];
  const ways = [c.includes("forward") ? "it is passed on to an API" : "", c.includes("not_needed") ? "it is marked as not needed" : ""].filter(Boolean);
  return `A note does not finish this part. The tool does not write logic from a description, so it stays open until its code is written${ways.length ? `, or until ${ways.join(" or ")}` : ""}.`;
}
/** The line above the list when nothing is open: finished, or why it still is not. */
export function nothingOpen(d: { ready?: boolean; summary?: string }): { done: boolean; text: string } {
  if (d.ready) return { done: true, text: "Every item of this service has been decided." };
  const why = txt(d.summary).trim();
  return { done: false, text: why ? `Not finished: ${why}${/[.!?]$/.test(why) ? "" : "."}` : "Nothing is open here, but the service is not finished yet. Build and check it to see what is missing." };
}
export function sourceSummary(src: { steps?: number; parts?: number; transforms?: number }): string {
  const steps = num(src.steps), parts = num(src.parts), tr = num(src.transforms);
  const size = `${steps} ${steps === 1 ? "step" : "steps"}${parts > 1 ? ` in ${parts} parts of the old code` : " in the old code"}`;
  return tr > 0 ? `${size}; ${tr} of them ${tr === 1 ? "reshapes" : "reshape"} the data.` : `${size}; none of them reshapes the data.`;
}

// ---- the estate landscape (layer columns, left to right)
export interface LandApi { name: string; layer?: unknown }
export interface LandLink { from: string; to: string; via?: string; toKind?: string; label?: string; connector?: string }
export interface LandNode { id: string; kind: "api" | "backend"; col: number; x: number; y: number; w: number; h: number; layer: LayerKey }
export interface LandEdge { key: string; from: string; to: string; via: string; d: string; sameColumn: boolean; label?: string }
export interface Landscape { width: number; height: number; nodeW: number; columns: { title: string; x: number; count: number }[]; nodes: LandNode[]; edges: LandEdge[] }
export const LAND_MIN_WIDTH = 820;
const COLS: LayerKey[] = ["exp", "proc", "sys"];
const API_H = 58, BACK_H = 40, ROW_GAP = 12, TOP = 30;

export function layoutLandscape(apis: LandApi[], links: LandLink[], available: number): Landscape {
  const width = Math.max(LAND_MIN_WIDTH, Math.floor(available) || 0);
  const gap = Math.max(56, Math.min(110, Math.round(width * 0.08)));
  const nodeW = Math.floor((width - gap * 3) / 4);
  const names = new Set(apis.map((a) => a.name));
  const colOf = new Map<string, number>();
  for (const a of apis) { const k = layerKey(a.layer); colOf.set(a.name, k === "other" ? 1 : COLS.indexOf(k)); }
  const backends: string[] = [];
  for (const l of links) if (!names.has(l.to) && !backends.includes(l.to)) backends.push(l.to);
  for (const b of backends) colOf.set(b, 3);

  // order: first column by name; each later column by the average position of what calls into it
  const order: string[][] = [[], [], [], []];
  for (const a of [...apis].sort((x, y) => x.name.localeCompare(y.name))) order[colOf.get(a.name)!].push(a.name);
  order[3] = backends;
  const pos = new Map<string, number>();
  order[0].forEach((n, i) => pos.set(n, i));
  for (let c = 1; c < 4; c++) {
    const score = (n: string): number => {
      const callers = links.filter((l) => l.to === n && pos.has(l.from) && colOf.get(l.from)! < c).map((l) => pos.get(l.from)! / Math.max(1, order[colOf.get(l.from)!].length));
      return callers.length ? callers.reduce((a, b) => a + b, 0) / callers.length : 2;
    };
    const scored = order[c].map((n, i) => ({ n, s: score(n), i }));
    scored.sort((a, b) => a.s - b.s || a.i - b.i);
    order[c] = scored.map((x) => x.n);
    order[c].forEach((n, i) => pos.set(n, i));
  }

  const colHeight = (c: number) => order[c].reduce((h, _n, i) => h + (c === 3 ? BACK_H : API_H) + (i ? ROW_GAP : 0), 0);
  const inner = Math.max(...[0, 1, 2, 3].map(colHeight), API_H);
  const height = TOP + inner + 8;
  const nodes: LandNode[] = [];
  const byId = new Map<string, LandNode>();
  for (let c = 0; c < 4; c++) {
    let y = TOP + Math.round((inner - colHeight(c)) / 2);
    for (const n of order[c]) {
      const h = c === 3 ? BACK_H : API_H;
      const node: LandNode = { id: n, kind: c === 3 ? "backend" : "api", col: c, x: c * (nodeW + gap), y, w: nodeW, h, layer: c === 3 ? "other" : layerKey(apis.find((a) => a.name === n)?.layer) };
      nodes.push(node); byId.set(n, node);
      y += h + ROW_GAP;
    }
  }
  const edges: LandEdge[] = [];
  const seen = new Set<string>();
  for (const l of links) {
    const a = byId.get(l.from), b = byId.get(l.to);
    if (!a || !b || a === b) continue;
    const key = `${l.from}>${l.to}>${l.via || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const y1 = a.y + a.h / 2, y2 = b.y + b.h / 2;
    let d: string;
    const same = a.col === b.col;
    if (same) {
      const x = a.x + a.w, bulge = Math.min(gap * 0.55, 46);
      d = `M ${x} ${y1} C ${x + bulge} ${y1}, ${x + bulge} ${y2}, ${x + 5} ${y2}`;
    } else if (b.col > a.col) {
      const x1 = a.x + a.w, x2 = b.x - 5, mid = (x2 - x1) / 2;
      d = `M ${x1} ${y1} C ${x1 + mid} ${y1}, ${x2 - mid} ${y2}, ${x2} ${y2}`;
    } else {
      const x1 = a.x, x2 = b.x + b.w + 5, mid = (x1 - x2) / 2;
      d = `M ${x1} ${y1} C ${x1 - mid} ${y1}, ${x2 + mid} ${y2}, ${x2} ${y2}`;
    }
    edges.push({ key, from: l.from, to: l.to, via: l.via || "http", d, sameColumn: same, label: l.label });
  }
  const titles = ["Experience", "Process", "System", "Backends"];
  return { width, height, nodeW, columns: titles.map((title, c) => ({ title, x: c * (nodeW + gap), count: order[c].length })), nodes, edges };
}

// ---- chart scale
export function niceMax(max: number, count = 4): number {
  if (!(max > 0)) return count;
  const raw = max / count;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  for (const m of [1, 2, 2.5, 5, 10]) {
    const step = m * pow;
    if (step >= raw && Number.isInteger(step)) return step * count;
  }
  return Math.max(count, Math.ceil(raw) * count);
}
export function ticks(max: number, count = 4): number[] {
  const top = niceMax(max, count);
  return Array.from({ length: count + 1 }, (_, i) => (top / count) * i);
}
/** Merge buckets so a chart never draws more than `limit` bars. */
export function rebucket<T extends { at: string; total: number; errors: number }>(series: T[], limit: number): { at: string; total: number; errors: number; span: number }[] {
  const size = Math.max(1, Math.ceil(series.length / Math.max(1, limit)));
  const out: { at: string; total: number; errors: number; span: number }[] = [];
  for (let i = 0; i < series.length; i += size) {
    const part = series.slice(i, i + size);
    out.push({ at: part[0].at, total: part.reduce((a, p) => a + num(p.total), 0), errors: part.reduce((a, p) => a + num(p.errors), 0), span: part.length });
  }
  return out;
}

// ---- log text search highlight
export function splitMatch(text: string, q: string): { text: string; hit: boolean }[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return [{ text, hit: false }];
  const out: { text: string; hit: boolean }[] = [];
  const lower = text.toLowerCase();
  let i = 0;
  for (let n = 0; n < 50; n++) {
    const at = lower.indexOf(needle, i);
    if (at < 0) break;
    if (at > i) out.push({ text: text.slice(i, at), hit: false });
    out.push({ text: text.slice(at, at + needle.length), hit: true });
    i = at + needle.length;
  }
  if (i < text.length) out.push({ text: text.slice(i), hit: false });
  return out;
}

// ---- projects taken from a git repository
export interface RepoForm { name: string; url: string; branch: string; token: string }
export function repoFormProblems(f: RepoForm): Partial<Record<"name" | "url" | "branch" | "token", string>> {
  const e: Partial<Record<"name" | "url" | "branch" | "token", string>> = {};
  if (!f.name.trim()) e.name = "Give the repository a name";
  const url = f.url.trim();
  if (!url) e.url = "Paste the https:// address of the repository";
  else if (/^(git@|ssh:\/\/|git:\/\/)/i.test(url)) e.url = "Use the address that starts with https:// (git servers show it under \"Clone with HTTPS\")";
  else if (!/^https:\/\/\S+$/i.test(url)) e.url = "The address must start with https:// and have no spaces";
  else if (/^https:\/\/[^/]*@/i.test(url)) e.url = "Leave the user name and the token out of the address. They have their own fields.";
  const b = f.branch.trim();
  if (b && (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(b) || b.includes(".."))) e.branch = "A branch name has letters, digits, - _ . and / only";
  if (/[\r\n]/.test(f.token.trim())) e.token = "Paste the token on one line";
  return e;
}
export interface RepoLike { state?: unknown; message?: unknown; readAt?: unknown; commit?: unknown; onBranch?: unknown; projects?: unknown }
/** The state of a connected repository in a word and a line. */
export function repoState(r: RepoLike, now: number = Date.now()): { tone: Tone; label: string; detail: string } {
  const st = txt(r.state);
  if (st === "reading") return { tone: "accent", label: "Reading", detail: "The build server is reading the repository. This takes from a few seconds to a few minutes." };
  if (st === "failed") return { tone: "bad", label: "Could not be read", detail: txt(r.message) || "The repository could not be read." };
  const n = Array.isArray(r.projects) ? r.projects.length : 0;
  const parts = [n === 0 ? "No project was found in it" : n === 1 ? "1 project" : `${n} projects`];
  if (txt(r.onBranch)) parts.push(`branch ${txt(r.onBranch)}`);
  if (txt(r.commit)) parts.push(`commit ${txt(r.commit).slice(0, 7)}`);
  const when = ago(r.readAt, now);
  if (when) parts.push(`read ${when}`);
  return { tone: n ? "ok" : "warn", label: "Read", detail: parts.join(" · ") };
}
export interface RepoProjectLike { path: string; migrations?: { outcome?: unknown; queued?: unknown }[] }
/** The projects that have no migration yet: the ones ticked when the list opens. */
export function notMigratedYet(projects: RepoProjectLike[]): string[] {
  return projects.filter((p) => !(p.migrations && p.migrations.length)).map((p) => p.path);
}
export function projectState(p: RepoProjectLike): { tone: Tone; text: string } {
  const m = p.migrations?.[0];
  if (!m) return { tone: "muted", text: "Not migrated yet" };
  if (m.queued) return { tone: "accent", text: "Being migrated" };
  return { tone: outcomeTone(m.outcome), text: txt(m.outcome) || "Migration started" };
}
/** What starts when the button is pressed, in one sentence. */
export function importPlan(count: number, environment: string, build: boolean): string {
  if (count <= 0) return "Tick the projects to migrate.";
  const steps = ["read and documented", "turned into a service"];
  if (environment) steps.push(`given the addresses from its settings file "${environment}"`);
  if (build) steps.push("built and tested");
  const list = steps.length > 1 ? `${steps.slice(0, -1).join(", ")} and ${steps[steps.length - 1]}` : steps[0];
  return `${count === 1 ? "1 project is" : `${count} projects are`} worked through one after the other: each is ${list}. Nothing is deployed until you say so.`;
}
