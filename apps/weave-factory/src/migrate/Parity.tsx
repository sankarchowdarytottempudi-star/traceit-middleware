// "Old code, item by item": every flow of the old application with its calls, fields, conditions
// and error handlers, and whether the new service does each of them (read by the tool from the
// uploaded code; nothing leaves the server). "Runtime properties": the running application's own
// properties override the file in the upload; pasted here they go to the service's settings.
// Values are never shown, only names.
import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Play, Upload } from "lucide-react";
import { api, uploadOldCode, type ApiError, type Migration, type ParityFlow, type ParityTotals, type RuntimePropsResult } from "../api.ts";
import { txt } from "../lib/text.ts";
import { Bar, Btn, Failed, Field, Loading, Notice, Panel, Pill, errText } from "./ui.tsx";

const TOTAL_WORDS: [keyof NonNullable<NonNullable<Migration["parity"]>["totals"]>, string][] = [
  ["calls", "Calls to other systems"], ["fields", "Fields written by transformations"], ["conditions", "Conditions"], ["tables", "Database tables"],
];

function Totals({ totals }: { totals?: Record<string, ParityTotals | undefined> }) {
  if (!totals) return null;
  return (
    <div style={{ display: "grid", gap: 8, gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 220px), 1fr))" }} data-testid="parity-totals">
      {TOTAL_WORDS.map(([k, label]) => {
        const t = totals[k];
        if (!t || !t.of) return null;
        return (
          <div key={k} className="mf-mg-stack" style={{ gap: 4 }}>
            <span className="mf-mg-small"><strong>{label}</strong> <span className="mf-mg-muted">{t.found} of {t.of} ({t.percent}%)</span></span>
            <Bar pct={t.percent} tone={t.percent >= 100 ? "ok" : t.percent < 80 ? "bad" : "accent"} label={label} />
          </div>
        );
      })}
    </div>
  );
}

function Mark({ ok }: { ok: boolean | null | undefined }) {
  return ok === null || ok === undefined ? <Pill tone="muted">not checked</Pill> : ok ? <Pill tone="ok">found</Pill> : <Pill tone="bad">missing</Pill>;
}

function FlowRow({ f }: { f: ParityFlow }) {
  const fields = f.fields ?? [], calls = f.calls ?? [], conds = f.conditions ?? [], missing = f.missing ?? [];
  const found = fields.filter((x) => x.found).length;
  return (
    <details className="mf-mg-card" data-testid="parity-flow" data-flow={f.name} style={{ padding: "10px 12px" }}>
      <summary className="mf-mg-row" style={{ gap: 8, cursor: "pointer" }}>
        <Pill tone={f.status === "complete" ? "ok" : "bad"}>{f.status === "complete" ? "complete" : `${missing.length} missing`}</Pill>
        <span className="mf-mono mf-mg-wrap" style={{ fontWeight: 600, fontSize: 13 }}>{txt(f.name)}</span>
        <span className="mf-mg-small mf-mg-muted">{txt(f.kind)}{f.trigger ? ` · starts: ${txt(f.trigger)}` : ""}{fields.length ? ` · fields ${found}/${fields.length}` : ""}</span>
      </summary>
      <div className="mf-mg-stack" style={{ gap: 8, marginTop: 8 }}>
        {missing.length > 0 && <Notice tone="bad"><span data-testid="parity-missing"><strong>Not found in the new service:</strong> {missing.map((m) => txt(m)).join("; ")}</span></Notice>}
        {calls.length > 0 && (
          <div className="mf-mg-sec"><h3>Calls</h3>
            <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 4 }}>{calls.map((c, i) => <li key={i} className="mf-mg-row mf-mg-small" style={{ gap: 6 }}><Mark ok={c.found} /><span className="mf-mono mf-mg-wrap">{txt(c.what)}</span></li>)}</ul>
          </div>
        )}
        {fields.length > 0 && (
          <div className="mf-mg-sec"><h3>Fields its transformations write</h3>
            <div className="mf-mg-wrap" style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
              {fields.map((x, i) => <span key={i} title={x.where ? `in ${x.where}` : x.found ? "found" : "missing"}><Pill tone={x.found ? (x.common ? "muted" : "ok") : "bad"}><span className="mf-mono">{txt(x.name)}</span></Pill></span>)}
            </div>
          </div>
        )}
        {conds.length > 0 && (
          <div className="mf-mg-sec"><h3>Conditions (values compared)</h3>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>{conds.map((c, i) => <Pill key={i} tone={c.found ? "ok" : "bad"}><span className="mf-mono">{txt(c.value)}</span></Pill>)}</div>
          </div>
        )}
        {(f.errors ?? []).length > 0 && <span className="mf-mg-small mf-mg-muted mf-mg-wrap">Error handlers: {(f.errors ?? []).map((e) => txt(e)).join(", ")}</span>}
      </div>
    </details>
  );
}

/** Upload the old application's archive again, for this migration only. */
export function OldCodeUpload({ m, again }: { m: Migration; again?: boolean }) {
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [pct, setPct] = useState<number | null>(null);
  const [err, setErr] = useState("");
  const [ask, setAsk] = useState(false);
  const [done, setDone] = useState("");
  const send = (force: boolean) => {
    if (!file) return;
    setErr(""); setDone(""); setPct(0);
    uploadOldCode(m.id, file, force, (f) => setPct(f)).promise
      .then((r) => {
        setPct(null); setAsk(false); setFile(null);
        if (input.current) input.current.value = "";
        setDone(txt(r.summary) || "The old application is attached.");
        qc.invalidateQueries({ queryKey: ["migration", m.id] }); qc.invalidateQueries({ queryKey: ["parity-map", m.id] }); qc.invalidateQueries({ queryKey: ["migrations"] });
      })
      .catch((e: ApiError & { body?: { needsForce?: boolean } }) => { setPct(null); setErr(errText(e)); setAsk(!!e.body?.needsForce); });
  };
  return (
    <div className="mf-mg-stack" style={{ gap: 8 }} data-testid="oldcode-upload">
      {!again && <p className="mf-mg-sub mf-mg-wrap" style={{ fontSize: 13.5, margin: 0 }}>The old application's code is not on this server any more, so the new service cannot be checked against it item by item. Upload the same .zip or .jar that was migrated.</p>}
      <span className="mf-mg-hint mf-mg-wrap">Only used to check the new service against the old code; the service is not generated again.</span>
      <div className="mf-mg-row" style={{ gap: 8 }}>
        <input ref={input} type="file" accept=".zip,.jar" data-testid="oldcode-file" aria-label="Old application (.zip or .jar)" onChange={(e) => { setFile(e.target.files?.[0] ?? null); setErr(""); setAsk(false); setDone(""); }} style={{ maxWidth: "100%" }} />
        <Btn small kind="primary" icon={<Upload size={14} aria-hidden="true" />} disabled={!file || pct !== null} busy={pct !== null} onClick={() => send(false)}>Upload the old application (.zip or .jar)</Btn>
      </div>
      {pct !== null && <Bar pct={Math.round(pct * 100)} label="Upload progress" />}
      {err && <Notice tone={ask ? "warn" : "bad"}><span data-testid="oldcode-error">{err}</span>{ask && <span className="mf-mg-actions" style={{ marginTop: 8 }}><Btn small kind="primary" onClick={() => send(true)}>It is the right application, upload it</Btn></span>}</Notice>}
      {done && <Notice tone="ok"><span data-testid="oldcode-done">{done}</span></Notice>}
    </div>
  );
}

export function ParityPanel({ m }: { m: Migration }) {
  // the tool says on the migration whether a comparison exists; only then is it read
  const enabled = !!m.serviceDir && !!m.parity;
  const q = useQuery({ queryKey: ["parity-map", m.id], queryFn: () => api.parityMap(m.id), enabled, staleTime: 30000,
    retry: (n, e) => (e as ApiError)?.status !== 404 && n < 2 });
  const [all, setAll] = useState(false);
  if (!enabled) {
    // no comparison yet: the old code is missing on this server (a written specification has none)
    if (!m.serviceDir || m.sourceType === "spec") return null;
    return <Panel title="Old code, item by item" actions={<Pill tone="warn">Not checked</Pill>}><OldCodeUpload m={m} /></Panel>;
  }
  if (q.isLoading) return <Panel title="Old code, item by item"><Loading rows={2} /></Panel>;
  if (q.isError) {
    if ((q.error as ApiError)?.status === 404) return null;
    return <Panel title="Old code, item by item"><Failed what="The comparison with the old code could not be read right now." error={q.error} onRetry={() => q.refetch()} /></Panel>;
  }
  const d = q.data;
  if (!d) return null;
  if (!d.ok) return <Panel title="Old code, item by item" actions={<Pill tone="warn">Not checked</Pill>}><div className="mf-mg-stack" style={{ gap: 10 }}><Notice>{txt(d.error) || "The old code could not be compared."}</Notice>{m.sourceType !== "spec" && <OldCodeUpload m={m} />}</div></Panel>;
  const flows = d.flows ?? [];
  const gaps = flows.filter((f) => f.status !== "complete");
  const shown = all ? flows : gaps;
  const conns = d.connections ?? [];
  return (
    <Panel title="Old code, item by item" actions={d.complete ? <Pill tone="ok">Complete</Pill> : <Pill tone="bad">{d.flowsWithGaps ?? gaps.length} flow{(d.flowsWithGaps ?? gaps.length) === 1 ? "" : "s"} with gaps</Pill>}>
      <div className="mf-mg-stack" style={{ gap: 12 }} data-testid="parity">
        <p className="mf-mg-sub mf-mg-wrap" style={{ fontSize: 13.5, margin: 0 }}>
          The tool read every flow and sub-flow of the old application: its calls to other systems, the fields its transformations write, the values its conditions compare and its error handlers.
          Each item is looked up in the new service. A migration is only finished when nothing is missing.
        </p>
        {d.summary && <span className="mf-mg-small mf-mg-wrap" data-testid="parity-summary">{txt(d.summary)}</span>}
        <Totals totals={d.totals as Record<string, ParityTotals | undefined>} />
        <div className="mf-mg-actions">
          <Btn small kind={!all ? "primary" : "default"} onClick={() => setAll(false)}>Only flows with gaps ({gaps.length})</Btn>
          <Btn small kind={all ? "primary" : "default"} onClick={() => setAll(true)}>All flows ({flows.length})</Btn>
        </div>
        {shown.length === 0 ? <Notice tone="ok">Every flow of the old application was found in the new service.</Notice>
          : <div className="mf-mg-stack" style={{ gap: 6 }}>{shown.map((f, i) => <FlowRow key={`${f.name}-${i}`} f={f} />)}</div>}
        {conns.length > 0 && (
          <div className="mf-mg-sec"><h3>Connections</h3>
            <div className="mf-mg-tablewrap">
              <table className="mf-mg-table" data-testid="parity-connections">
                <thead><tr><th>Old connection</th><th>Kind</th><th>Setting in the new service</th><th>Has a value</th></tr></thead>
                <tbody>{conns.map((c, i) => <tr key={i}><td className="mf-mono mf-mg-wrap">{txt(c.config)}</td><td>{txt(c.kind)}</td><td className="mf-mono mf-mg-wrap">{txt(c.settingsKey) || "-"}</td><td>{c.set ? <Pill tone="ok">yes</Pill> : <Pill tone="bad">no</Pill>}</td></tr>)}</tbody>
              </table>
            </div>
            <span className="mf-mg-hint">Values are kept in the service's settings on this server and are not shown.</span>
          </div>
        )}
        <details data-testid="oldcode-again">
          <summary className="mf-mg-small" style={{ cursor: "pointer", fontWeight: 600 }}>Upload the old application again</summary>
          <div style={{ marginTop: 8 }}><OldCodeUpload m={m} again /></div>
        </details>
      </div>
    </Panel>
  );
}

export function RuntimeProps({ m, onRun }: { m: Migration; onRun: (a: "deploy") => void }) {
  const qc = useQueryClient();
  const [text, setText] = useState("");
  const apply = useMutation<RuntimePropsResult, ApiError, string>({
    mutationFn: (t) => api.runtimeProperties(m.id, t),
    onSuccess: () => { setText(""); qc.invalidateQueries({ queryKey: ["migration", m.id] }); qc.invalidateQueries({ queryKey: ["parity-map", m.id] }); qc.invalidateQueries({ queryKey: ["open-items", m.id] }); },
  });
  if (!m.serviceDir) return null;
  const r = apply.data;
  const fromRuntime = m.settingsSource === "runtime";
  const changed = (r?.applied ?? []).length > 0;
  return (
    <Panel title="Runtime properties" actions={fromRuntime ? <Pill tone="ok">From the running application</Pill> : <Pill tone="warn">Settings only from the uploaded file</Pill>}>
      <div className="mf-mg-stack" style={{ gap: 10 }} data-testid="runtime">
        <p className="mf-mg-sub mf-mg-wrap" style={{ fontSize: 13.5, margin: 0 }}>
          A running application often has properties of its own (for example on the runtime screen of Anypoint), and they override the settings file in the upload.
          The uploaded code cannot contain them. Paste them here so the new service uses the same values: one property per line, as <span className="mf-mono">name=value</span>, <span className="mf-mono">name: value</span> or name and value separated by a tab.
        </p>
        <Field label="Properties of the running application" hint="Values go into this service's settings on this server. They are not shown again after applying and never leave this server.">
          <textarea className="mf-mg-input mf-mono" data-testid="runtime-text" rows={5} value={text} onChange={(e) => setText(e.target.value)} placeholder={"scheduler.mode=delta\nscheduler.frequency=60"} spellCheck={false} autoComplete="off" />
        </Field>
        <span className="mf-mg-actions"><Btn small kind="primary" disabled={!text.trim() || !!m.busy} busy={apply.isPending} onClick={() => apply.mutate(text)}>Apply</Btn></span>
        {apply.isError && <Notice tone="bad">{errText(apply.error)}</Notice>}
        {r && (
          <div className="mf-mg-stack" style={{ gap: 6 }} data-testid="runtime-result">
            {(r.applied ?? []).length > 0 && <Notice tone="ok"><strong>Applied ({(r.applied ?? []).length}):</strong> {(r.applied ?? []).map((a) => `${txt(a.property)} → ${txt(a.setting)}`).join(", ")}</Notice>}
            {(r.unchanged ?? []).length > 0 && <span className="mf-mg-small mf-mg-muted mf-mg-wrap">Already the same ({(r.unchanged ?? []).length}): {(r.unchanged ?? []).map((x) => txt(x)).join(", ")}</span>}
            {(r.unknown ?? []).length > 0 && <Notice tone="warn"><strong>Not used by the new service ({(r.unknown ?? []).length}):</strong> {(r.unknown ?? []).map((x) => txt(x)).join(", ")}</Notice>}
            {changed && (
              <Notice tone="warn">
                <strong>The settings are changed, but the installed service still runs with the earlier ones.</strong>
                <span style={{ display: "block", marginTop: 2 }}>Deploy to put them in use. No new build is needed for a change of settings.</span>
                <span className="mf-mg-actions" style={{ marginTop: 8 }}><Btn small kind="primary" icon={<Play size={14} aria-hidden="true" />} disabled={!!m.busy} onClick={() => onRun("deploy")}>Deploy</Btn></span>
              </Notice>
            )}
          </div>
        )}
      </div>
    </Panel>
  );
}
