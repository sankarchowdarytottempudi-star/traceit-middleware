// "Which part of the project": a Node.js project often holds many features; a migration covers the
// part someone chooses — a route prefix, a module folder or routes from the list — with or without
// its background jobs. The tool makes that part from the whole upload (kept as it was).
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { at } from "../lib/base.ts";
import type { Migration } from "../api.ts";
import { Btn, Field, Notice, Panel, Pill, errText } from "./ui.tsx";

export interface ProjectRoute { method: string; path: string; file: string; handler?: string }
export interface PartSpec { prefix?: string; module?: string; routes?: string[]; workers?: true; name?: string }
type Mode = "prefix" | "module" | "routes";

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(at(path), { credentials: "include", ...(init?.body != null ? { headers: { "Content-Type": "application/json" } } : {}), ...init });
  let body: any = null;
  try { body = await r.json(); } catch { /* not JSON */ }
  if (!r.ok) throw Object.assign(new Error((body && (body.error || body.message)) || `Request failed (${r.status})`), { status: r.status, body });
  return body as T;
}

/** Module folders of a project, from where its routes live (src/modules/<x>, else the first folder). */
export function modulesOf(routes: ProjectRoute[]): string[] {
  const out = new Set<string>();
  for (const r of routes) {
    const segs = r.file.split("/");
    const i = segs.indexOf("modules");
    if (i >= 0 && segs.length > i + 1) out.add(segs.slice(0, i + 2).join("/"));
    else if (segs.length > 1) out.add(segs[0]);
  }
  return [...out].sort();
}

/** The routes a part would contain (the same rule the tool applies). */
export function routesIn(routes: ProjectRoute[], spec: PartSpec): ProjectRoute[] {
  if (spec.routes?.length) { const want = new Set(spec.routes); return routes.filter((r) => want.has(`${r.method} ${r.path}`) || want.has(r.path)); }
  if (!spec.prefix && !spec.module) return [];
  const pre = spec.prefix ? "/" + spec.prefix.replace(/^\/+|\/+$/g, "") : "";
  const mod = spec.module ? spec.module.replace(/^\/+|\/+$/g, "") + "/" : "";
  return routes.filter((r) => (!pre || r.path === pre || r.path.startsWith(pre + "/")) && (!mod || r.file.startsWith(mod)));
}

/** The part chosen while starting a migration (optional): a prefix or a module folder, jobs on/off. */
export function NewPartFields({ value, onChange, disabled }: { value: PartSpec | null; onChange: (v: PartSpec | null) => void; disabled?: boolean }) {
  const [on, setOn] = useState(!!value);
  const [kind, setKind] = useState<"prefix" | "module">(value?.module ? "module" : "prefix");
  const [text, setText] = useState(value?.prefix || value?.module || "");
  const [workers, setWorkers] = useState(!!value?.workers);
  const push = (o: boolean, k: "prefix" | "module", t: string, w: boolean) => onChange(o && t.trim() ? { [k]: t.trim(), ...(w ? { workers: true as const } : {}) } : null);
  return (
    <div className="mf-mg-stack" style={{ gap: 8 }} data-testid="new-part">
      <label style={{ display: "flex", gap: 8, alignItems: "center", cursor: "pointer" }}>
        <input type="checkbox" checked={on} disabled={disabled} data-testid="new-part-on" onChange={(e) => { setOn(e.target.checked); push(e.target.checked, kind, text, workers); }} />
        <span>Only part of the project (Node.js)</span>
      </label>
      {on && (
        <>
          <span className="mf-mg-hint">For a project with many features: the migration covers only the routes you name here. The whole upload is kept; the part can be changed later on the migration page, with the list of routes to choose from.</span>
          <div className="mf-mg-row" style={{ gap: 8, flexWrap: "wrap" }}>
            <select className="mf-mg-input" style={{ maxWidth: 200 }} value={kind} disabled={disabled} data-testid="new-part-kind" onChange={(e) => { const k = e.target.value as "prefix" | "module"; setKind(k); push(on, k, text, workers); }}>
              <option value="prefix">Route prefix</option>
              <option value="module">Module folder</option>
            </select>
            <input className="mf-mg-input mf-mono" style={{ flex: "1 1 220px", minWidth: 0 }} value={text} disabled={disabled} data-testid="new-part-text"
              placeholder={kind === "prefix" ? "/api/mobile/check-in" : "src/modules/mobile"} spellCheck={false} onChange={(e) => { setText(e.target.value); push(on, kind, e.target.value, workers); }} />
          </div>
          <label style={{ display: "flex", gap: 8, alignItems: "center", cursor: "pointer" }}>
            <input type="checkbox" checked={workers} disabled={disabled} onChange={(e) => { setWorkers(e.target.checked); push(on, kind, text, e.target.checked); }} />
            <span>Include every background job of the project (otherwise only the jobs that belong to these routes)</span>
          </label>
        </>
      )}
    </div>
  );
}

/** On a Node.js migration: the part it covers now, and the chooser to change it. */
export function ProjectPart({ m }: { m: Migration }) {
  const qc = useQueryClient();
  const node = (m.technology || "").toLowerCase() === "node";
  const scope = (m as any).scope as { spec?: PartSpec; routes?: string[]; routesInProject?: number; files?: number; filesInProject?: number; functionsInPart?: number; relatedWorkers?: string[] } | undefined;
  const [open, setOpen] = useState(false);
  const q = useQuery({ queryKey: ["project-routes", m.id], queryFn: () => call<{ routes?: ProjectRoute[]; error?: string } | ProjectRoute[]>(`/api/factory/migrations/${encodeURIComponent(m.id)}/routes`), enabled: node && open, staleTime: 60000 });
  const all: ProjectRoute[] = useMemo(() => { const d: any = q.data; return Array.isArray(d) ? d : Array.isArray(d?.routes) ? d.routes : []; }, [q.data]);
  const cur = scope?.spec || {};
  const [mode, setMode] = useState<Mode>(cur.routes?.length ? "routes" : cur.module ? "module" : "prefix");
  const [prefix, setPrefix] = useState(cur.prefix || "");
  const [module, setModule] = useState(cur.module || "");
  const [picked, setPicked] = useState<Set<string>>(new Set(cur.routes || []));
  const [find, setFind] = useState("");
  const [workers, setWorkers] = useState(!!cur.workers);
  const [name, setName] = useState(cur.name || "");
  const hasService = !!m.serviceDir;
  const installed = (m.phases || []).some((p) => p.key === "deploy" && String(p.status).toLowerCase() === "done");
  const [regen, setRegen] = useState(false);
  const [sure, setSure] = useState(false);
  const spec: PartSpec = mode === "prefix" ? { prefix: prefix.trim() } : mode === "module" ? { module: module.trim() } : { routes: [...picked].sort() };
  if (workers) spec.workers = true;
  if (name.trim()) spec.name = name.trim();
  const inPart = routesIn(all, spec);
  const keepService = hasService && !regen;
  const apply = useMutation<{ ok?: boolean; message?: string; functionsInPart?: number }, Error>({
    mutationFn: () => call(`/api/factory/migrations/${encodeURIComponent(m.id)}/scope`, { method: "POST", body: JSON.stringify({ ...spec, ...(keepService ? { keepService: true } : {}), ...(regen && installed ? { confirm: true } : {}) }) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["migration", m.id] }); qc.invalidateQueries({ queryKey: ["parity-map", m.id] }); qc.invalidateQueries({ queryKey: ["open-items", m.id] }); },
  });
  if (!node) return null;
  const shown = all.filter((r) => !find || `${r.method} ${r.path}`.toLowerCase().includes(find.toLowerCase()));
  const blocked = inPart.length === 0 || (regen && installed && !sure) || (mode === "routes" && picked.size === 0);
  return (
    <Panel title="Which part of the project" actions={scope?.spec ? <Pill tone="ok">{scope.routes?.length ?? 0} of {scope.routesInProject ?? "?"} routes</Pill> : <Pill tone="warn">The whole project</Pill>}>
      <div className="mf-mg-stack" style={{ gap: 10 }} data-testid="part">
        <p className="mf-mg-sub mf-mg-wrap" style={{ fontSize: 13.5, margin: 0 }}>
          {scope?.spec
            ? <>This migration covers {scope.spec.prefix ? <>the routes under <span className="mf-mono">{scope.spec.prefix}</span></> : scope.spec.module ? <>the module <span className="mf-mono">{scope.spec.module}</span></> : <>{scope.routes?.length} chosen routes</>}
              {" "}({scope.files ?? "?"} of {scope.filesInProject ?? "?"} files{typeof scope.functionsInPart === "number" ? `, ${scope.functionsInPart} functions used` : ""}
              {scope.relatedWorkers?.length ? `, ${scope.relatedWorkers.length} background job${scope.relatedWorkers.length === 1 ? "" : "s"} of the same feature` : ""}). Only what these routes use is counted in the check.</>
            : <>This migration covers the whole project. For a project with many features, choose the part it should cover.</>}
        </p>
        {!open && <span className="mf-mg-actions"><Btn small data-testid="part-open" onClick={() => setOpen(true)}>Choose the part</Btn></span>}
        {open && (
          <div className="mf-mg-stack" style={{ gap: 10 }}>
            {q.isLoading && <span className="mf-mg-hint">Reading the project's routes…</span>}
            {q.isError && <Notice tone="bad">{errText(q.error)}</Notice>}
            <div className="mf-mg-actions" role="radiogroup" aria-label="How to choose the part">
              {(["prefix", "module", "routes"] as Mode[]).map((k) => (
                <Btn key={k} small kind={mode === k ? "primary" : "default"} role="radio" aria-checked={mode === k} onClick={() => setMode(k)}>{k === "prefix" ? "Route prefix" : k === "module" ? "Module folder" : "Choose routes"}</Btn>
              ))}
            </div>
            {mode === "prefix" && (
              <Field label="Route prefix" hint="Every route whose address starts with this is in the part.">
                <input className="mf-mg-input mf-mono" data-testid="part-prefix" value={prefix} onChange={(e) => setPrefix(e.target.value)} placeholder="/api/mobile/check-in" spellCheck={false} />
              </Field>
            )}
            {mode === "module" && (
              <Field label="Module folder">
                <select className="mf-mg-input" data-testid="part-module" value={module} onChange={(e) => setModule(e.target.value)}>
                  <option value="">Choose a folder…</option>
                  {modulesOf(all).map((x) => <option key={x} value={x}>{x} ({routesIn(all, { module: x }).length} routes)</option>)}
                </select>
              </Field>
            )}
            {mode === "routes" && (
              <div className="mf-mg-stack" style={{ gap: 6 }}>
                <input className="mf-mg-input" data-testid="part-find" value={find} onChange={(e) => setFind(e.target.value)} placeholder="Find a route" />
                <div style={{ maxHeight: 280, overflowY: "auto", display: "grid", gap: 4 }} data-testid="part-routes">
                  {shown.map((r) => { const k = `${r.method} ${r.path}`; return (
                    <label key={k + r.file} className="mf-mg-small mf-mg-wrap" style={{ display: "flex", gap: 8, alignItems: "flex-start", cursor: "pointer" }}>
                      <input type="checkbox" checked={picked.has(k)} onChange={(e) => { const n = new Set(picked); if (e.target.checked) n.add(k); else n.delete(k); setPicked(n); }} style={{ marginTop: 3 }} />
                      <span className="mf-mono">{k}</span>
                    </label>); })}
                </div>
              </div>
            )}
            <label style={{ display: "flex", gap: 8, alignItems: "center", cursor: "pointer" }}>
              <input type="checkbox" checked={workers} onChange={(e) => setWorkers(e.target.checked)} />
              <span>Include every background job of the project (otherwise only the jobs that belong to these routes)</span>
            </label>
            <Field label="Service name (optional)" hint="Lower-case letters, digits and -; the name of the new service for this part.">
              <input className="mf-mg-input mf-mono" value={name} onChange={(e) => setName(e.target.value)} placeholder="check-in-wrapper-api" spellCheck={false} />
            </Field>
            <Notice tone={inPart.length ? "info" : "warn"}><span data-testid="part-preview">{inPart.length ? `${inPart.length} of ${all.length} routes are in this part.` : "No route of the project is in this part yet."}</span></Notice>
            {hasService && (
              <div className="mf-mg-stack" style={{ gap: 6 }} role="radiogroup" aria-label="What happens to the service">
                <label style={{ display: "flex", gap: 8, alignItems: "flex-start", cursor: "pointer" }}>
                  <input type="radio" checked={!regen} onChange={() => setRegen(false)} style={{ marginTop: 3 }} data-testid="part-keep" />
                  <span>Keep the service as it is. Only the check and the comparison use the new part (right for a service written or finished by hand).</span>
                </label>
                <label style={{ display: "flex", gap: 8, alignItems: "flex-start", cursor: "pointer" }}>
                  <input type="radio" checked={regen} onChange={() => setRegen(true)} style={{ marginTop: 3 }} data-testid="part-regen" />
                  <span>Generate the service again from this part. The current service folder is kept aside, not deleted.</span>
                </label>
              </div>
            )}
            {regen && installed && (
              <Notice tone="warn">
                <div data-testid="part-installed">
                  <strong>This service is installed.</strong> Generating it again replaces its code with what the tool makes from the part; anything written by hand in it is only in the kept-aside copy. The installed version keeps running until the next deployment.
                  <label style={{ display: "flex", gap: 8, alignItems: "flex-start", cursor: "pointer", marginTop: 6 }}>
                    <input type="checkbox" checked={sure} onChange={(e) => setSure(e.target.checked)} style={{ marginTop: 3 }} data-testid="part-sure" />
                    <span>Generate it again anyway.</span>
                  </label>
                </div>
              </Notice>
            )}
            <span className="mf-mg-actions">
              <Btn small kind="primary" data-testid="part-apply" disabled={blocked || !!m.busy} busy={apply.isPending} onClick={() => apply.mutate()}>Use this part</Btn>
              <Btn small onClick={() => setOpen(false)}>Close</Btn>
            </span>
            {apply.isError && <Notice tone="bad">{errText(apply.error)}</Notice>}
            {apply.data?.message && <Notice tone="ok">{apply.data.message}</Notice>}
          </div>
        )}
      </div>
    </Panel>
  );
}
