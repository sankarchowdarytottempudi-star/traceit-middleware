// One running API: what it is, its operations, connectors, mappings, configuration, logs and traffic.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { keepPreviousData, useMutation, useQuery } from "@tanstack/react-query";
import { ArrowRight, Check, ChevronDown, ChevronRight, Copy, CopyPlus, RefreshCw, Workflow } from "lucide-react";
import { api, type ApiError, type EstateApiDetail, type EstateConnector, type EstateMapping, type EstateOperation } from "../api.ts";
import { num, txt } from "../lib/text.ts";
import { LAYER_LABEL, ago, clock, compact, dateTime, healthLabel, layerKey, ms, niceMax, rebucket, splitMatch, ticks } from "../lib/migrate.ts";
import { Btn, Code, Dialog, Empty, Failed, Field, Head, HealthPill, KV, LayerPill, LinkBtn, Loading, Method, Notice, Panel, Pill, SearchBox, Stat, TabBar, errText, useTitle, type TabDef } from "./ui.tsx";
import { Landscape } from "./EstateList.tsx";

type Tab = "overview" | "operations" | "connectors" | "mappings" | "config" | "logs" | "traffic";
const TABS: Tab[] = ["overview", "operations", "connectors", "mappings", "config", "logs", "traffic"];

function CopyBtn({ value, label }: { value: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <button type="button" className="mf-btn mf-mg-btn mf-mg-btn-sm mf-mg-iconbtn" aria-label={label} title={label}
      onClick={async () => { try { await navigator.clipboard.writeText(value); setDone(true); setTimeout(() => setDone(false), 1500); } catch { /* clipboard not available */ } }}>
      {done ? <Check size={14} color="var(--ok)" aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
    </button>
  );
}
function Addr({ value, label }: { value: unknown; label: string }) {
  const v = txt(value);
  if (!v) return null;
  return <span className="mf-mg-row" style={{ gap: 8, flexWrap: "nowrap" }}><span className="mf-mono mf-mg-wrap mf-mg-small">{v}</span><CopyBtn value={v} label={label} /></span>;
}
function Expander({ open, onToggle, head, children }: { open: boolean; onToggle: () => void; head: ReactNode; children: ReactNode }) {
  return (
    <div className="mf-mg-item">
      <button type="button" className="mf-btn mf-mg-item-head" aria-expanded={open} onClick={onToggle}>
        {open ? <ChevronDown size={16} aria-hidden="true" /> : <ChevronRight size={16} aria-hidden="true" />}{head}
      </button>
      {open && <div className="mf-mg-item-body">{children}</div>}
    </div>
  );
}
function Sec({ title, children }: { title: string; children: ReactNode }) {
  return <div className="mf-mg-sec"><h3>{title}</h3>{children}</div>;
}
function Chips({ items, mono }: { items: unknown[]; mono?: boolean }) {
  return <div className="mf-mg-chips">{items.map((x, i) => <span key={i} className={`mf-mg-pill${mono ? " mf-mono" : ""}`} style={{ whiteSpace: "normal", overflowWrap: "anywhere" }}>{txt(x)}</span>)}</div>;
}
function useOpenSet(): [Set<string>, (id: string) => void, (ids: string[]) => void] {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggle = (id: string) => setOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  return [open, toggle, (ids) => setOpen(new Set(ids))];
}

// ---- Overview
function Overview({ d, onTab }: { d: EstateApiDetail; onTab: (t: Tab) => void }) {
  const est = useQuery({ queryKey: ["estate"], queryFn: () => api.estate(), staleTime: 30000 });
  const around = useMemo(() => {
    const links = (est.data?.links ?? d.links ?? []).filter((l) => l.from === d.name || l.to === d.name);
    const names = new Set<string>([d.name]);
    for (const l of links) { names.add(l.from); names.add(l.to); }
    const apis = (est.data?.apis ?? []).filter((a) => names.has(a.name));
    return { links, apis: apis.length ? apis : [{ name: d.name, layer: d.layer, health: d.health, gateway: d.gateway }] };
  }, [est.data, d]);
  const k = layerKey(d.layer);
  const ops = num(d.operationCount ?? d.operations?.length), cons = num(d.connectorCount ?? d.connectors?.length);
  const callers = around.links.filter((l) => l.to === d.name).map((l) => l.from);
  const what = `${k === "other" ? "An" : k === "exp" ? "An experience" : k === "proc" ? "A process" : "A system"} API with ${ops} operation${ops === 1 ? "" : "s"}`
    + (cons ? ` that reaches ${cons} other system${cons === 1 ? "" : "s"} through connectors` : "")
    + (callers.length ? `. It is called by ${[...new Set(callers)].join(", ")}.` : ".");
  return (
    <div className="mf-mg-stack">
      {(d.warnings ?? []).map((w, i) => <Notice key={i} tone="warn">{txt(w)}</Notice>)}
      <div className="mf-mg-stats">
        <Stat label="Health" value={healthLabel(d.health)} note={`${num(d.readyReplicas)} of ${num(d.replicas)} replica${num(d.replicas) === 1 ? "" : "s"} ready`} />
        <Stat label="Operations" value={ops} note={<button type="button" className="mf-mg-back" onClick={() => onTab("operations")}>See them <ArrowRight size={13} aria-hidden="true" /></button>} />
        <Stat label="Requests, last hour" value={d.metricsAvailable ? compact(d.requestsLastHour) : "Not measured"} note={d.metricsAvailable ? `${compact(d.errorsLastHour)} error${num(d.errorsLastHour) === 1 ? "" : "s"}` : "This API does not report traffic figures"} />
        <Stat label="Last deployed" value={ago(d.lastDeployedAt) || "Unknown"} note={dateTime(d.lastDeployedAt)} />
      </div>
      <div className="mf-mg-grid-2">
        <Panel title="What it is">
          <p style={{ margin: 0, fontSize: 14, lineHeight: 1.6 }}>{what}</p>
          <KV rows={[
            ["Layer", k === "other" ? txt(d.layer) : LAYER_LABEL[k]],
            ["Built with", txt(d.technology)],
            ["Public address", d.gateway?.published ? <Addr value={d.gateway.url} label="Copy the public address" /> : <span className="mf-mg-muted">Not published on the gateway. Only other services on the cluster can call it.</span>],
            ["Gateway", d.gateway?.published ? `${txt(d.gateway.context)} · version ${txt(d.gateway.version) || "unknown"} · ${txt(d.gateway.lifecycle).toLowerCase() || "published"}` : ""],
            ["Internal address", <Addr key="i" value={d.internalUrl} label="Copy the internal address" />],
            ["Base path", d.basePath ? <span className="mf-mono mf-mg-small">{txt(d.basePath)}</span> : ""],
            ["Test port", d.nodePort ? <span className="mf-mono mf-mg-small">{num(d.nodePort)}</span> : ""],
            ["Image", d.image ? <span className="mf-mono mf-mg-small">{txt(d.image)}</span> : ""],
            ["Migration", d.migrationId ? <Link className="mf-mg-name" to={`/migrations/${encodeURIComponent(d.migrationId)}`}>Open the migration it came from</Link> : <span className="mf-mg-muted">No migration is linked to this API</span>],
          ]} />
          {(d.features ?? []).length > 0 && <Sec title="What it does along the way"><Chips items={d.features!} /></Sec>}
        </Panel>
        <Panel title="Replicas">
          {(d.pods ?? []).length === 0 ? <Empty title="No replica is running" hint="The service has no pod on the cluster right now." /> : (
            <div className="mf-mg-tablewrap">
              <table className="mf-mg-table">
                <thead><tr><th>Replica</th><th>State</th><th className="mf-mg-num">Restarts</th><th>Started</th></tr></thead>
                <tbody>{d.pods!.map((p) => (
                  <tr key={p.name}>
                    <td className="mf-mg-td-main"><span className="mf-mono mf-mg-small mf-mg-wrap">{p.name}</span>{p.component && p.component !== d.name ? <div className="mf-mg-small mf-mg-faint">{txt(p.component)}</div> : null}</td>
                    <td data-label="State"><Pill tone={p.ready ? "ok" : "warn"}>{p.ready ? "Ready" : txt(p.phase) || "Not ready"}</Pill></td>
                    <td data-label="Restarts" className="mf-mg-num">{num(p.restarts)}</td>
                    <td data-label="Started"><span title={dateTime(p.startedAt)}>{ago(p.startedAt)}</span></td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
          {(d.sourceComponents ?? []).length > 0 && (
            <Sec title="Source that was read">
              <div className="mf-mg-small mf-mg-muted">{d.sourceComponents!.map((c) => `${txt(c.name)} (${num(c.files)} files, ${num(c.lines).toLocaleString("en-US")} lines)`).join(" · ")}</div>
            </Sec>
          )}
          {d.sourceAvailable === false && <Notice tone="warn">The source of this API is not available on this server, so operations, connectors and mappings cannot be shown.</Notice>}
        </Panel>
      </div>
      <section className="mf-mg-stack" style={{ gap: 10 }}>
        <div className="mf-mg-panel-head"><h2 className="mf-mg-h2">Where it sits</h2><span className="mf-mg-small mf-mg-muted">What calls this API and what it calls.</span></div>
        {around.links.length === 0 ? <div className="mf-mg-tablewrap"><Empty title="Nothing is connected to this API" hint="No other API calls it and it calls no other system." /></div> : <Landscape apis={around.apis} links={around.links} focus={d.name} />}
      </section>
    </div>
  );
}

// ---- Operations
function Operations({ d, onTab }: { d: EstateApiDetail; onTab: (t: Tab) => void }) {
  const [q, setQ] = useState("");
  const [open, toggle, setAll] = useOpenSet();
  const ops = d.operations ?? [];
  const shown = ops.filter((o) => !q.trim() || `${o.method} ${o.path} ${txt(o.summary)}`.toLowerCase().includes(q.trim().toLowerCase()));
  if (ops.length === 0) return <div className="mf-mg-tablewrap"><Empty title="No operations were found" hint="The source of this API has no request handlers, or it is not available on this server." /></div>;
  return (
    <div className="mf-mg-stack" style={{ gap: 10 }}>
      <div className="mf-mg-toolbar">
        <SearchBox value={q} onChange={setQ} placeholder="Search operations" />
        <Btn small onClick={() => setAll(open.size ? [] : shown.map((o) => o.id))}>{open.size ? "Collapse all" : "Expand all"}</Btn>
        <span className="mf-mg-small mf-mg-muted">{shown.length} of {ops.length}</span>
      </div>
      {shown.length === 0 ? <div className="mf-mg-tablewrap"><Empty title="No operation matches the search" /></div> : (
        <div className="mf-mg-list">
          {shown.map((o: EstateOperation) => (
            <Expander key={o.id} open={open.has(o.id)} onToggle={() => toggle(o.id)}
              head={<><Method method={o.method} /><span className="mf-mono mf-mg-item-title">{txt(o.path)}</span>{o.implemented === false && <Pill tone="warn">Not implemented</Pill>}{(o.calls ?? []).length > 0 && <Pill>{o.calls!.length} call{o.calls!.length === 1 ? "" : "s"}</Pill>}</>}>
              {o.summary && <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.55 }}>{txt(o.summary)}</p>}
              {(o.calls ?? []).length > 0 && (
                <Sec title="What it calls, in order">
                  <div className="mf-mg-tablewrap">
                    <table className="mf-mg-table">
                      <thead><tr><th>Connector</th><th>Request</th><th>Mapping used</th><th>Where</th></tr></thead>
                      <tbody>{o.calls!.map((c, i) => (
                        <tr key={i}>
                          <td className="mf-mg-td-main"><button type="button" className="mf-btn mf-mono mf-mg-name" onClick={() => onTab("connectors")}>{txt(c.connector) || "direct"}</button> <Pill>{txt(c.kind) || "http"}</Pill></td>
                          <td data-label="Request"><span className="mf-mono mf-mg-small mf-mg-wrap">{txt(c.method || c.op).toUpperCase()} {txt(c.path)}</span></td>
                          <td data-label="Mapping used">{c.mapping ? <button type="button" className="mf-btn mf-mono mf-mg-name mf-mg-small" onClick={() => onTab("mappings")}>{txt(c.mapping)}</button> : null}</td>
                          <td data-label="Where"><span className="mf-mono mf-mg-small mf-mg-faint">{txt(c.file)}{c.line ? `:${c.line}` : ""}</span></td>
                        </tr>
                      ))}</tbody>
                    </table>
                  </div>
                </Sec>
              )}
              {(o.params ?? []).length > 0 && <Sec title="Inputs"><Chips mono items={o.params!.map((p) => `${txt(p.name)}${p.type ? `: ${txt(p.type)}` : ""}${p.in ? ` (${txt(p.in)})` : ""}`)} /></Sec>}
              {(o.responses ?? []).length > 0 && <Sec title="Answers it can give"><Chips items={o.responses!.map((r) => [r.status ? String(r.status) : "", txt(r.message), r.when ? `when ${txt(r.when)}` : ""].filter(Boolean).join(" · "))} /></Sec>}
              {(o.headersRead ?? []).length > 0 && <Sec title="Headers it reads"><Chips mono items={o.headersRead!} /></Sec>}
              {(o.headersForwarded ?? []).length > 0 && <Sec title="Headers it passes on"><Chips mono items={o.headersForwarded!} /></Sec>}
              {(o.features ?? []).length > 0 && <Sec title="What it does along the way"><Chips items={o.features!} /></Sec>}
              {o.code && <Sec title="Source"><Code code={o.code} file={txt(o.file)} startLine={num(o.line, 1)} /></Sec>}
            </Expander>
          ))}
        </div>
      )}
    </div>
  );
}

// ---- Connectors
function Connectors({ d }: { d: EstateApiDetail }) {
  const [open, toggle] = useOpenSet();
  const list = d.connectors ?? [];
  if (list.length === 0) return <div className="mf-mg-tablewrap"><Empty title="This API has no connectors" hint="It does not call any other system, or its source is not available on this server." /></div>;
  const opName = (id: string) => { const o = (d.operations ?? []).find((x) => x.id === id); return o ? `${o.method} ${txt(o.relativePath) || o.path}` : id; };
  return (
    <div className="mf-mg-stack" style={{ gap: 10 }}>
      {list.some((c) => c.exampleValues) && <Notice>Some addresses below are the example values kept with the source, because the deployed values of this API are stored where this screen is not allowed to read them.</Notice>}
      <div className="mf-mg-list">
        {list.map((c: EstateConnector, i) => {
          const id = `${c.component ?? ""}/${c.name}/${i}`;
          return (
            <Expander key={id} open={open.has(id)} onToggle={() => toggle(id)}
              head={<><Pill tone={c.kind === "http" ? "sys" : "proc"}>{txt(c.kind) || "http"}</Pill><span className="mf-mg-item-title"><span className="mf-mono" style={{ fontWeight: 600 }}>{txt(c.name)}</span><span className="mf-mg-small mf-mg-muted mf-mono" style={{ display: "block" }}>{txt(c.target) || "address not set"}</span></span>{c.api ? <Pill tone="accent">API in this estate</Pill> : null}</>}>
              <KV rows={[
                ["Talks to", c.api ? <Link className="mf-mono mf-mg-name" to={`/estate/${encodeURIComponent(c.api)}`}>{c.api}</Link> : <span className="mf-mono mf-mg-small">{txt(c.backend) || txt(c.target)}</span>],
                ["Address", <Addr key="a" value={c.target} label="Copy the address" />],
                ["Set by", c.configKey ? <span className="mf-mono mf-mg-small">{txt(c.configKey)}</span> : ""],
                ["Sign-in", txt(c.auth)],
                ["Part", c.component && c.component !== d.name ? txt(c.component) : ""],
                ["Declared in", c.file ? <span className="mf-mono mf-mg-small">{txt(c.file)}{c.line ? `:${c.line}` : ""}</span> : ""],
              ]} />
              {(c.paths ?? []).length > 0 && <Sec title="Paths it calls"><Chips mono items={c.paths!} /></Sec>}
              {(c.usedBy ?? []).length > 0 && <Sec title="Used by these operations"><Chips mono items={c.usedBy!.map(opName)} /></Sec>}
              {(c.settings ?? []).length > 0 && (
                <Sec title="Settings">
                  <div>{c.settings!.map((s) => <div key={s.key} className="mf-mg-maprow"><span className="mf-mono">{txt(s.key)}</span><span aria-hidden="true">=</span><span className="mf-mono">{txt(s.value)}</span></div>)}</div>
                </Sec>
              )}
              {(c.secrets ?? []).length > 0 && <Sec title="Secrets (values are never shown)"><Chips mono items={c.secrets!.map((s) => `${txt(s)}: set`)} /></Sec>}
              {c.code && <Sec title="Source"><Code code={c.code} file={txt(c.file)} startLine={num(c.line, 1)} maxHeight={260} /></Sec>}
            </Expander>
          );
        })}
      </div>
    </div>
  );
}

// ---- Mappings
function Mappings({ d }: { d: EstateApiDetail }) {
  const [q, setQ] = useState("");
  const [open, toggle] = useOpenSet();
  const list = d.mappings ?? [];
  if (list.length === 0) return <div className="mf-mg-tablewrap"><Empty title="No mappings were found" hint="This API passes data through without reshaping it, or its source is not available on this server." /></div>;
  const needle = q.trim().toLowerCase();
  const shown = list.filter((m) => !needle || `${m.name} ${txt(m.summary)} ${txt(m.kind)} ${(m.fields ?? []).map((f) => `${f.target} ${f.source}`).join(" ")}`.toLowerCase().includes(needle));
  const opName = (id: string) => { const o = (d.operations ?? []).find((x) => x.id === id); return o ? `${o.method} ${txt(o.relativePath) || o.path}` : id; };
  return (
    <div className="mf-mg-stack" style={{ gap: 10 }}>
      <div className="mf-mg-toolbar"><SearchBox value={q} onChange={setQ} placeholder="Search mappings and fields" /><span className="mf-mg-small mf-mg-muted">{shown.length} of {list.length}</span></div>
      {shown.length === 0 ? <div className="mf-mg-tablewrap"><Empty title="No mapping matches the search" /></div> : (
        <div className="mf-mg-list">
          {shown.map((m: EstateMapping) => (
            <Expander key={m.id} open={open.has(m.id)} onToggle={() => toggle(m.id)}
              head={<><Pill>{txt(m.kind) || "mapping"}</Pill><span className="mf-mg-item-title"><span className="mf-mono" style={{ fontWeight: 600 }}>{txt(m.name)}</span>{m.summary && <span className="mf-mg-small mf-mg-muted" style={{ display: "block" }}>{txt(m.summary)}</span>}</span>{(m.fields ?? []).length > 0 && <Pill>{m.fields!.length} field{m.fields!.length === 1 ? "" : "s"}</Pill>}</>}>
              {(m.fields ?? []).length > 0 && (
                <Sec title="Field by field (result on the left, where it comes from on the right)">
                  <div>{m.fields!.map((f, i) => <div key={i} className="mf-mg-maprow"><span className="mf-mono" style={{ fontWeight: 600 }}>{txt(f.target)}</span><span aria-hidden="true" className="mf-mg-faint">←</span><span className="mf-mono mf-mg-muted">{txt(f.source)}</span></div>)}</div>
                </Sec>
              )}
              {(m.usedBy ?? []).length > 0 && <Sec title="Used by these operations"><Chips mono items={m.usedBy!.map(opName)} /></Sec>}
              {m.code && <Sec title="Source"><Code code={m.code} file={txt(m.file)} startLine={num(m.line, 1)} /></Sec>}
            </Expander>
          ))}
        </div>
      )}
    </div>
  );
}

// ---- Configuration
function Config({ d }: { d: EstateApiDetail }) {
  const [q, setQ] = useState("");
  const [only, setOnly] = useState("");
  const list = d.config ?? [];
  if (list.length === 0) return <div className="mf-mg-tablewrap"><Empty title="No configuration was found" hint="This API has no configuration keys, or they are stored where this screen is not allowed to read them." /></div>;
  const needle = q.trim().toLowerCase();
  const shown = list.filter((c) => (only === "secret" ? c.secret : only === "plain" ? !c.secret : true) && (!needle || `${c.key} ${c.secret ? "" : c.value} ${txt(c.component)}`.toLowerCase().includes(needle)));
  const multi = new Set(list.map((c) => txt(c.component))).size > 1;
  const src = txt(d.configSource);
  return (
    <div className="mf-mg-stack" style={{ gap: 10 }}>
      <Notice>{src === "deployed" ? "These are the values the running API was started with." : src === "example" || src === "source" ? "These are the example values kept with the source. The deployed values of this API are stored where this screen is not allowed to read them." : "Configuration keys of this API."} Values of passwords, tokens and keys are never shown; they appear as "set".</Notice>
      <div className="mf-mg-toolbar">
        <SearchBox value={q} onChange={setQ} placeholder="Search keys and values" />
        <select className="mf-mg-input" aria-label="Kind of value" value={only} onChange={(e) => setOnly(e.target.value)}><option value="">All keys</option><option value="plain">Plain values</option><option value="secret">Secrets</option></select>
        <span className="mf-mg-small mf-mg-muted">{shown.length} of {list.length}</span>
      </div>
      {shown.length === 0 ? <div className="mf-mg-tablewrap"><Empty title="No key matches the search" /></div> : (
        <div className="mf-mg-tablewrap">
          <table className="mf-mg-table">
            <thead><tr><th>Key</th><th>Value</th>{multi && <th>Part</th>}</tr></thead>
            <tbody>{shown.map((c, i) => (
              <tr key={`${c.component ?? ""}/${c.key}/${i}`}>
                <td className="mf-mg-td-main"><span className="mf-mono mf-mg-small mf-mg-wrap" style={{ fontWeight: 600 }}>{txt(c.key)}</span></td>
                <td data-label="Value">{c.secret ? <Pill tone="warn" title="The value is hidden">set (hidden)</Pill> : <span className="mf-mono mf-mg-small mf-mg-wrap">{txt(c.value) || <span className="mf-mg-faint">empty</span>}</span>}</td>
                {multi && <td data-label="Part"><span className="mf-mg-small mf-mg-muted">{txt(c.component)}</span></td>}
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---- Logs
function useDebounced<T>(value: T, delay: number): T {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), delay); return () => clearTimeout(t); }, [value, delay]);
  return v;
}
function Logs({ name }: { name: string }) {
  const [q, setQ] = useState("");
  const [level, setLevel] = useState("");
  const [pod, setPod] = useState("");
  const [tail, setTail] = useState(200);
  const [auto, setAuto] = useState(true);
  const dq = useDebounced(q, 350);
  const logs = useQuery({
    queryKey: ["estate-logs", name, tail, dq, level, pod],
    queryFn: () => api.estateLogs(name, { tail, q: dq.trim() || undefined, level: level || undefined, pod: pod || undefined }),
    refetchInterval: auto ? 5000 : false, placeholderData: keepPreviousData,
  });
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const lines = logs.data?.lines ?? [];
  const pods = logs.data?.pods ?? [];
  const lastKey = lines.length ? `${lines.length}/${txt(lines[lines.length - 1].at)}` : "";
  useEffect(() => { const el = box.current; if (el && stick.current) el.scrollTop = el.scrollHeight; }, [lastKey]);
  const filtered = !!(dq.trim() || level || pod);
  return (
    <div className="mf-mg-stack" style={{ gap: 10 }}>
      <div className="mf-mg-toolbar">
        <SearchBox value={q} onChange={setQ} placeholder="Search the log text" />
        <select className="mf-mg-input" aria-label="Level" value={level} onChange={(e) => setLevel(e.target.value)}>
          <option value="">All levels</option><option value="error">Errors</option><option value="warn">Warnings</option><option value="info">Information</option><option value="debug">Debug</option>
        </select>
        {pods.length > 1 && (
          <select className="mf-mg-input" aria-label="Replica" value={pod} onChange={(e) => setPod(e.target.value)}>
            <option value="">All {pods.length} replicas</option>{pods.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
          </select>
        )}
        <select className="mf-mg-input" aria-label="How many lines" value={tail} onChange={(e) => setTail(Number(e.target.value))}>
          <option value={100}>Last 100 lines</option><option value={200}>Last 200 lines</option><option value={500}>Last 500 lines</option><option value={1000}>Last 1000 lines</option>
        </select>
        <label className="mf-mg-check"><input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />Refresh every 5 seconds</label>
        <Btn small icon={<RefreshCw size={14} aria-hidden="true" />} busy={logs.isFetching && !auto} onClick={() => logs.refetch()}>Refresh now</Btn>
      </div>
      {(logs.data?.errors ?? []).map((e, i) => <Notice key={i} tone="warn">{txt(e)}</Notice>)}
      {logs.isLoading ? <Loading rows={1} h={220} /> : logs.isError ? <Failed what="The logs are not available right now." error={logs.error} onRetry={() => logs.refetch()} /> : (
        <>
          <div ref={box} className="mf-mono mf-mg-log" tabIndex={0} role="log" aria-label={`Log lines of ${name}`}
            onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }}>
            {lines.length === 0 ? <div className="mf-mg-logempty">{filtered ? "No log line matches these filters." : "This API has not written any log line yet."}</div> : lines.map((l, i) => {
              const lv = ["error", "warn", "info", "debug"].includes(txt(l.level)) ? txt(l.level) : "none";
              return (
                <div key={`${txt(l.at)}/${i}`} className="mf-mg-logline">
                  <span className="mf-mg-logtime" title={txt(l.at)}>{clock(l.at, true) || "            "}</span>
                  <span className={`mf-mg-loglevel mf-mg-lv-${lv}`}>{lv === "none" ? "" : lv}</span>
                  {pods.length > 1 && !pod && <span className="mf-mg-logpod" title={txt(l.pod)}>{txt(l.pod).split("-").slice(-1)[0]}</span>}
                  <span className="mf-mg-logtext">{splitMatch(txt(l.text), dq).map((p, x) => p.hit ? <mark key={x}>{p.text}</mark> : <span key={x}>{p.text}</span>)}</span>
                </div>
              );
            })}
          </div>
          <div className="mf-mg-small mf-mg-muted">{lines.length} line{lines.length === 1 ? "" : "s"}{filtered ? " after filtering" : ""} · newest at the bottom{auto ? " · refreshing every 5 seconds" : ""}{logs.dataUpdatedAt ? ` · read at ${clock(new Date(logs.dataUpdatedAt).toISOString())}` : ""}</div>
        </>
      )}
    </div>
  );
}

// ---- Traffic
const RANGES: { hours: number; label: string }[] = [{ hours: 1, label: "1 hour" }, { hours: 6, label: "6 hours" }, { hours: 24, label: "24 hours" }, { hours: 168, label: "7 days" }];
function topRounded(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.max(0, Math.min(r, w / 2, h));
  return `M ${x} ${y + h} V ${y + rr} Q ${x} ${y} ${x + rr} ${y} H ${x + w - rr} Q ${x + w} ${y} ${x + w} ${y + rr} V ${y + h} Z`;
}
function TrafficChart({ series, hours }: { series: { at: string; total: number; errors: number; span: number }[]; hours: number }) {
  const wrap = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(720);
  const [hi, setHi] = useState<number | null>(null);
  useEffect(() => {
    const el = wrap.current; if (!el) return;
    const read = () => setW(Math.max(280, el.clientWidth));
    read();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(read); ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const H = 230, L = 44, R = 8, T = 10, B = 26;
  const max = niceMax(Math.max(0, ...series.map((s) => s.total)));
  const tk = ticks(max);
  const iw = W - L - R, ih = H - T - B;
  const slot = iw / Math.max(1, series.length);
  const bw = Math.max(2, Math.min(28, slot - 2));
  const y = (v: number) => T + ih - (v / max) * ih;
  const label = (iso: string) => hours > 24 ? clock(iso, true).slice(0, 11) : clock(iso).slice(0, 5);
  const every = Math.max(1, Math.ceil(series.length / Math.max(2, Math.floor(iw / (hours > 24 ? 96 : 60)))));
  const h = hi !== null ? series[hi] : null;
  return (
    <div className="mf-mg-chart" ref={wrap} onMouseLeave={() => setHi(null)}>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Requests over time, with the errors among them. Use the table view for the figures.">
        {tk.map((t) => <g key={t}><line className="mf-mg-gridline" x1={L} x2={W - R} y1={y(t)} y2={y(t)} /><text x={L - 8} y={y(t) + 4} textAnchor="end">{compact(t)}</text></g>)}
        {series.map((s, i) => {
          const x = L + i * slot + (slot - bw) / 2;
          const ok = Math.max(0, s.total - s.errors);
          const okH = (ok / max) * ih, erH = (s.errors / max) * ih;
          const gap = okH > 0 && erH > 0 ? 2 : 0;
          return (
            <g key={s.at} opacity={hi === null || hi === i ? 1 : 0.45}>
              {okH > 0 && <path d={topRounded(x, T + ih - okH, bw, okH, erH > 0 ? 0 : 4)} style={{ fill: "var(--mf-mg-c1)" }} />}
              {erH > 0 && <path d={topRounded(x, T + ih - okH - gap - Math.max(erH, 2), bw, Math.max(erH, 2), 4)} style={{ fill: "var(--mf-mg-c2)" }} />}
              {i % every === 0 && <text x={L + i * slot + slot / 2} y={H - 8} textAnchor="middle">{label(s.at)}</text>}
              <rect x={L + i * slot} y={T} width={slot} height={ih} fill="transparent" onMouseEnter={() => setHi(i)} onFocus={() => setHi(i)} onClick={() => setHi(i)} />
            </g>
          );
        })}
        <line x1={L} x2={W - R} y1={T + ih} y2={T + ih} style={{ stroke: "var(--border2)" }} />
      </svg>
      {h && hi !== null && (
        <div className="mf-mg-tip" style={{ top: 4, ...(L + hi * slot > W / 2 ? { right: W - (L + hi * slot) + 6 } : { left: L + (hi + 1) * slot + 6 }) }}>
          <span className="mf-mg-small" style={{ fontWeight: 600 }}>{clock(h.at, true)}</span>
          <span className="mf-mg-tip-row"><span className="mf-mg-tip-key" style={{ background: "var(--mf-mg-c1)" }} />Successful<strong>{(h.total - h.errors).toLocaleString("en-US")}</strong></span>
          <span className="mf-mg-tip-row"><span className="mf-mg-tip-key" style={{ background: "var(--mf-mg-c2)" }} />Errors<strong>{h.errors.toLocaleString("en-US")}</strong></span>
        </div>
      )}
    </div>
  );
}
function Traffic({ name }: { name: string }) {
  const [hours, setHours] = useState(1);
  const [table, setTable] = useState(false);
  const m = useQuery({ queryKey: ["estate-metrics", name, hours], queryFn: () => api.estateMetrics(name, hours), refetchInterval: 30000, placeholderData: keepPreviousData });
  const series = useMemo(() => rebucket(m.data?.series ?? [], 60), [m.data]);
  const total = num(m.data?.total), errors = num(m.data?.errors);
  return (
    <div className="mf-mg-stack">
      <div className="mf-mg-toolbar" role="group" aria-label="Time range">
        {RANGES.map((r) => <button key={r.hours} type="button" aria-pressed={hours === r.hours} className={`mf-btn mf-mg-btn mf-mg-btn-sm${hours === r.hours ? " mf-mg-btn-pri" : ""}`} onClick={() => setHours(r.hours)}>{r.label}</button>)}
      </div>
      {m.isLoading ? <Loading rows={2} h={120} /> : m.isError ? <Failed what="The traffic figures are not available right now." error={m.error} onRetry={() => m.refetch()} /> : m.data && m.data.available === false ? (
        <div className="mf-mg-tablewrap"><Empty title="Traffic is not measured for this API" hint={txt(m.data.reason) || "This API does not report request figures to the monitoring system, so there is nothing to chart. The Logs tab shows what it is doing."} /></div>
      ) : (
        <>
          <div className="mf-mg-stats">
            <Stat label="Requests" value={compact(total)} note={`In the last ${RANGES.find((r) => r.hours === hours)?.label}`} />
            <Stat label="Errors" value={compact(errors)} note={total > 0 ? `${((errors / total) * 100).toFixed(errors ? 1 : 0)}% of requests` : "No requests in this period"} />
            <Stat label="Typical response" value={total > 0 ? ms(m.data?.p50Ms) : "No data"} note="Half of the requests were faster" />
            <Stat label="Slow response" value={total > 0 ? ms(m.data?.p95Ms) : "No data"} note="95 of 100 requests were faster" />
          </div>
          <Panel title="Requests over time" actions={<Btn small onClick={() => setTable((t) => !t)}>{table ? "Show the chart" : "Show as a table"}</Btn>}>
            {series.length === 0 || total === 0 ? <Empty title="No requests in this period" hint="Choose a longer period, or call the API and come back." /> : table ? (
              <div className="mf-mg-tablewrap" style={{ maxHeight: 420, overflow: "auto" }}>
                <table className="mf-mg-table">
                  <thead><tr><th>From</th><th className="mf-mg-num">Requests</th><th className="mf-mg-num">Errors</th></tr></thead>
                  <tbody>{series.filter((s) => s.total > 0).map((s) => <tr key={s.at}><td className="mf-mg-td-main"><span className="mf-mono mf-mg-small">{dateTime(s.at)}</span></td><td data-label="Requests" className="mf-mg-num">{s.total.toLocaleString("en-US")}</td><td data-label="Errors" className="mf-mg-num">{s.errors.toLocaleString("en-US")}</td></tr>)}</tbody>
                </table>
              </div>
            ) : (
              <>
                <div className="mf-mg-row mf-mg-small mf-mg-muted" style={{ gap: 16 }}>
                  <span className="mf-mg-row" style={{ gap: 6 }}><span className="mf-mg-swatch" style={{ background: "var(--mf-mg-c1)" }} />Successful requests</span>
                  <span className="mf-mg-row" style={{ gap: 6 }}><span className="mf-mg-swatch" style={{ background: "var(--mf-mg-c2)" }} />Errors</span>
                </div>
                <TrafficChart series={series} hours={hours} />
              </>
            )}
          </Panel>
        </>
      )}
    </div>
  );
}

// ---- the copy dialog
function CloneDialog({ name, onClose }: { name: string; onClose: () => void }) {
  const nav = useNavigate();
  const [flowName, setFlowName] = useState(`${name} copy`);
  const clone = useMutation({ mutationFn: () => api.estateClone(name, flowName.trim()), onSuccess: (r) => nav(`/studio/flows/${encodeURIComponent(r.flowId)}`) });
  const err = clone.error as ApiError | null;
  return (
    <Dialog title="Make an editable copy" onClose={onClose}
      footer={<><Btn onClick={onClose}>Cancel</Btn><Btn kind="primary" busy={clone.isPending} disabled={!flowName.trim()} onClick={() => clone.mutate()}>Create the copy</Btn></>}>
      <p style={{ margin: 0, fontSize: 14, lineHeight: 1.55 }}>This creates a new flow in the Studio that follows the same steps as <span className="mf-mono">{name}</span>. The running API is not changed, and the copy is not live until you deploy it yourself.</p>
      <Field label="Name of the copy"><input className="mf-mg-input" value={flowName} maxLength={80} onChange={(e) => setFlowName(e.target.value)} autoFocus /></Field>
      {err && <Notice tone="bad">{err.status === 503 ? "The Studio is not reachable right now, so the copy could not be created. Try again in a moment." : errText(err)}</Notice>}
    </Dialog>
  );
}

export function EstateDetail() {
  const { api: raw } = useParams();
  const name = raw ?? "";
  useTitle(name || "Estate");
  const [sp, setSp] = useSearchParams();
  const tab = (TABS.includes(sp.get("tab") as Tab) ? sp.get("tab") : "overview") as Tab;
  const setTab = (t: Tab) => { const n = new URLSearchParams(); if (t !== "overview") n.set("tab", t); setSp(n, { replace: true }); };
  const [cloning, setCloning] = useState(false);
  const det = useQuery({ queryKey: ["estate-api", name], queryFn: () => api.estateApi(name), enabled: !!name, refetchInterval: 30000 });
  const d = det.data;
  const tabs: TabDef<Tab>[] = [
    { id: "overview", label: "Overview" },
    { id: "operations", label: "Operations", count: d ? num(d.operations?.length) : undefined },
    { id: "connectors", label: "Connectors", count: d ? num(d.connectors?.length) : undefined },
    { id: "mappings", label: "Mappings", count: d ? num(d.mappings?.length) : undefined },
    { id: "config", label: "Configuration", count: d ? num(d.config?.length) : undefined },
    { id: "logs", label: "Logs" },
    { id: "traffic", label: "Traffic" },
  ];
  const notFound = det.isError && (det.error as ApiError).status === 404;
  return (
    <>
      <Head area="Estate" areaTo="/estate" back={{ to: "/estate", label: "All running APIs" }} mono title={name}
        subtitle={d ? <span className="mf-mg-row" style={{ gap: 8 }}><HealthPill health={d.health} /><LayerPill layer={d.layer} />{d.gateway?.published ? <Pill tone="accent">Published on the gateway</Pill> : <Pill>Internal only</Pill>}</span> : undefined}
        actions={d ? <>
          <LinkBtn to={`/studio/estate/${encodeURIComponent(name)}`} icon={<Workflow size={15} aria-hidden="true" />}>Open as flow</LinkBtn>
          <Btn kind="primary" icon={<CopyPlus size={15} aria-hidden="true" />} onClick={() => setCloning(true)}>Clone to edit</Btn>
        </> : undefined} />
      {det.isLoading ? <Loading rows={3} h={100} /> : notFound ? (
        <div className="mf-mg-tablewrap"><Empty title="This API is not running on the cluster" hint="It may have been removed or renamed." action={<LinkBtn to="/estate" small>See all running APIs</LinkBtn>} /></div>
      ) : det.isError || !d ? <Failed what="This API is not available right now." error={det.error} onRetry={() => det.refetch()} /> : (
        <>
          <TabBar tabs={tabs} value={tab} onChange={setTab} label="Sections of this API" />
          <div role="tabpanel" className="mf-mg-stack">
            {tab === "overview" && <Overview d={d} onTab={setTab} />}
            {tab === "operations" && <Operations d={d} onTab={setTab} />}
            {tab === "connectors" && <Connectors d={d} />}
            {tab === "mappings" && <Mappings d={d} />}
            {tab === "config" && <Config d={d} />}
            {tab === "logs" && <Logs name={name} />}
            {tab === "traffic" && <Traffic name={name} />}
          </div>
        </>
      )}
      {cloning && <CloneDialog name={name} onClose={() => setCloning(false)} />}
    </>
  );
}
