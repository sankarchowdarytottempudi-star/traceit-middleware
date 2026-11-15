// "Finish this migration": what is left of a generated service, one item at a time, with what
// the old application did there, and the decision a person makes about it. The tool writes the
// frame of a service; it does not invent business logic. Here a person says what each open item
// is: pass the call on to an API, leave it out, set a backend's address, or keep a note for
// whoever writes the logic. Everything stays on this server.
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Ban, Link2, Play, StickyNote, Undo2 } from "lucide-react";
import { api, type ApiError, type Decision, type Migration, type OpenItem, type OpenItems, type ResolveResult } from "../api.ts";
import { num, txt } from "../lib/text.ts";
import { NEW_API, ago, decisionProblem, forwardStart, itemKindWord, newApiProblem, sourceSummary, type NextAction, noteLimit, nothingOpen, passOnHint, passOnLoses, placeholderLine, sourceEnvs } from "../lib/migrate.ts";
import { Btn, Failed, Field, Loading, Method, Notice, Panel, Pill, errText } from "./ui.tsx";

type Mode = "forward" | "not_needed" | "address" | "note";
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];
const GRID = { display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 200px), 1fr))" } as const;

function OldCode({ item }: { item: OpenItem }) {
  const src = item.source;
  if (item.kind === "backend") {
    return <p className="mf-mg-small mf-mg-muted mf-mg-wrap" style={{ margin: 0 }}>{item.sourceName ? <>The old application called it <span className="mf-mono">{txt(item.sourceName)}</span>. </> : null}The new service has no address for it on this server, so every operation that calls it fails.</p>;
  }
  if (!src) return <p className="mf-mg-small mf-mg-muted mf-mg-wrap" style={{ margin: 0 }}>{item.kind === "code" ? "This operation has code of its own that still answers \"not migrated\". It is finished in the code, not from here." : "The part of the old application behind this item could not be matched. The Design document describes it."}</p>;
  const does = (src.does ?? []).map((d) => txt(d)).filter(Boolean);
  return (
    <div className="mf-mg-sec">
      <h3>What the old application did here</h3>
      {does.length > 0 && <ul className="mf-mg-wrap" style={{ margin: 0, paddingLeft: 18, fontSize: 13.5, lineHeight: 1.55 }}>{does.map((d, i) => <li key={i}>{d}</li>)}{num(src.more) > 0 ? <li className="mf-mg-muted">and {num(src.more)} more</li> : null}</ul>}
      {(src.calls ?? []).map((c, i) => (
        <span key={i} className="mf-mg-row mf-mg-small" style={{ gap: 6 }}>
          <span className="mf-mg-muted">It called</span><Method method={c.method} /><span className="mf-mono mf-mg-wrap">{txt(c.path)}</span>
          <span className="mf-mg-muted">on</span><span className="mf-mono mf-mg-wrap">{txt(c.backend) || txt(c.config)}</span>
        </span>
      ))}
      <span className="mf-mg-hint">{sourceSummary(src)}</span>
    </div>
  );
}

function ItemCard({ item, backends, canAdd, disabled, saving, error, onDecide }: {
  item: OpenItem; backends: string[]; canAdd: boolean; disabled: boolean; saving: boolean; error: string; onDecide: (d: Decision, done: () => void) => void;
}) {
  const first = forwardStart(item, backends);
  const [mode, setMode] = useState<Mode | null>(null);
  const [backend, setBackend] = useState(first.backend || (canAdd ? NEW_API : ""));
  // an API this service does not know yet, and "the API I pass this on to does the rest"
  const [newName, setNewName] = useState("");
  const [newUrl, setNewUrl] = useState("");
  const [sure, setSure] = useState(false);
  const [method, setMethod] = useState(first.method);
  const [path, setPath] = useState(first.path);
  const [text, setText] = useState("");
  const [url, setUrl] = useState("");
  const [from, setFrom] = useState("");
  const envs = sourceEnvs(item);
  const can = (a: Mode) => (item.can ?? []).includes(a);
  const open = (m: Mode) => { setMode(mode === m ? null : m); setText(""); setSure(false); };
  const adding = backend === NEW_API;
  const added = adding ? newApiProblem(newName, newUrl, backends) : { name: "", url: "" };
  const loses = passOnLoses(item);
  const yes = sure ? { confirm: true as const } : {};
  const decision: Decision | null = mode === "forward" ? (adding ? { id: item.id, action: "forward", newBackend: { name: newName.trim(), url: newUrl.trim() }, method, path: path.trim(), ...yes } : { id: item.id, action: "forward", backend, method, path: path.trim(), ...yes })
    : mode === "not_needed" ? { id: item.id, action: "not_needed", reason: text.trim() }
    : mode === "address" ? (from ? { id: item.id, action: "address", from } : { id: item.id, action: "address", url: url.trim() })
    : mode === "note" ? { id: item.id, action: "note", note: text.trim() } : null;
  const problem = decision ? decisionProblem(decision, item) : "";
  const touched = mode === "forward" ? true : mode === "address" ? from !== "" || url.trim() !== "" : text.trim() !== "";
  // a pass-on waits for the new API's name and address, and for the tick when the old code did more than one call
  const waits = mode === "forward" && (!!added.name || !!added.url || (loses.length > 0 && !sure));
  const save = () => { if (decision && !problem && !waits) onDecide(decision, () => { setMode(null); setText(""); setUrl(""); setFrom(""); setNewName(""); setNewUrl(""); setSure(false); }); };
  const reshapes = num(item.source?.transforms);
  const notes = item.notes ?? [];

  return (
    <div className="mf-mg-card" data-testid="finish-item" data-item={item.id}>
      <div className="mf-mg-row" style={{ gap: 8 }}>
        <Pill tone={item.kind === "backend" ? "sys" : item.kind === "entry" ? "proc" : "exp"}>{itemKindWord(item)}</Pill>
        <span className="mf-mono mf-mg-wrap" style={{ fontWeight: 600, fontSize: 13.5 }}>{txt(item.title)}</span>
      </div>
      <OldCode item={item} />
      {placeholderLine(item) && <span className="mf-mg-hint mf-mg-wrap" data-testid="finish-placeholder">{placeholderLine(item)}</span>}
      {notes.length > 0 && (
        <div className="mf-mg-sec"><h3>Notes</h3>
          <ul className="mf-mg-small mf-mg-wrap" style={{ margin: 0, paddingLeft: 18, lineHeight: 1.5 }}>{notes.map((n, i) => <li key={i}>{txt(n.text)}{n.t ? <span className="mf-mg-muted"> · {ago(n.t)}</span> : null}</li>)}</ul>
          <span className="mf-mg-hint" data-testid="finish-note-limit">{noteLimit(item.can)}</span>
        </div>
      )}
      <div className="mf-mg-actions">
        {can("forward") && <Btn small kind={mode === "forward" ? "primary" : "default"} icon={<ArrowRight size={14} aria-hidden="true" />} disabled={disabled} onClick={() => open("forward")}>Pass it on to an API</Btn>}
        {can("address") && <Btn small kind={mode === "address" ? "primary" : "default"} icon={<Link2 size={14} aria-hidden="true" />} disabled={disabled} onClick={() => open("address")}>Set the address</Btn>}
        {can("not_needed") && <Btn small kind={mode === "not_needed" ? "primary" : "default"} icon={<Ban size={14} aria-hidden="true" />} disabled={disabled} onClick={() => open("not_needed")}>Not needed</Btn>}
        {can("note") && <Btn small kind={mode === "note" ? "primary" : "default"} icon={<StickyNote size={14} aria-hidden="true" />} disabled={disabled} onClick={() => open("note")}>Say what it does</Btn>}
      </div>

      {mode === "forward" && (
        <div className="mf-mg-stack" style={{ gap: 10 }} data-testid="finish-form">
          <div style={GRID}>
            <Field label="Which API receives the call?" hint={canAdd ? (backends.length ? "The backends this service already knows, or a new one." : "This service knows no other API yet. Add the one that receives the call.") : "The backends this service already knows."}>
              <select className="mf-mg-input" data-testid="finish-backend" value={backend} onChange={(e) => setBackend(e.target.value)}>{backends.map((b) => <option key={b} value={b}>{b}</option>)}{canAdd && <option value={NEW_API}>A new API…</option>}</select>
            </Field>
            <Field label="Method"><select className="mf-mg-input" value={method} onChange={(e) => setMethod(e.target.value)}>{METHODS.map((x) => <option key={x} value={x}>{x}</option>)}</select></Field>
          </div>
          {adding && (
            <div style={GRID} data-testid="finish-new-api">
              <Field label="Name of the new API" error={newName.trim() ? added.name || undefined : undefined} hint="A short name, for example loyalty engine. The service knows the API under this name from now on.">
                <input className="mf-mg-input" data-testid="finish-new-name" value={newName} maxLength={40} aria-invalid={!!newName.trim() && !!added.name} onChange={(e) => setNewName(e.target.value)} spellCheck={false} autoComplete="off" />
              </Field>
              <Field label="Address of that API" error={newUrl.trim() ? added.url || undefined : undefined} hint="Kept in this service's settings on this server. It is not shown again after saving.">
                <input className="mf-mg-input mf-mono" data-testid="finish-new-url" value={newUrl} maxLength={500} aria-invalid={!!newUrl.trim() && !!added.url} onChange={(e) => setNewUrl(e.target.value)} placeholder="https://" spellCheck={false} autoComplete="off" />
              </Field>
            </div>
          )}
          <Field label="Path on that API" error={problem || undefined} hint={(item.params ?? []).length ? <>Values from the caller's address you can use: {(item.params ?? []).map((p) => <span key={p} className="mf-mono">{`{${p}}`} </span>)}</> : passOnHint(item)}>
            <input className="mf-mg-input mf-mono" data-testid="finish-path" value={path} aria-invalid={!!problem} onChange={(e) => setPath(e.target.value)} placeholder="/path/on/the/api" spellCheck={false} />
          </Field>
          {loses.length > 0 && (
            <Notice tone="warn">
              <div data-testid="finish-loses">
                <strong>The old application did more here than one call.</strong>
                <ul className="mf-mg-wrap" style={{ margin: "4px 0 6px", paddingLeft: 18, lineHeight: 1.5 }}>{loses.map((l, i) => <li key={i}>{l}</li>)}</ul>
                <label style={{ display: "flex", gap: 8, alignItems: "flex-start", cursor: "pointer" }}>
                  <input type="checkbox" data-testid="finish-confirm" checked={sure} onChange={(e) => setSure(e.target.checked)} style={{ marginTop: 3 }} />
                  <span>The API I pass this on to does all of this.</span>
                </label>
                <span className="mf-mg-hint" style={{ display: "block", marginTop: 4 }}>The decision can be saved once this is ticked. If that API does not do it, choose "Say what it does" so the logic is written instead; otherwise callers get an answer while part of the old work is silently left out.</span>
              </div>
            </Notice>
          )}
          {loses.length === 0 && reshapes > 0 && item.kind === "entry" && <Notice tone="warn">The old code also reshaped the data here ({reshapes} {reshapes === 1 ? "place" : "places"}). Passing it on makes one plain call and sends nothing in the old shape. If that API needs the old shape, or more than one call was made, choose "Say what it does" so the logic is written instead.</Notice>}
          {loses.length === 0 && reshapes > 0 && item.kind !== "entry" && <Notice tone="warn">The old code also reshaped the data here ({reshapes} {reshapes === 1 ? "place" : "places"}). Passing the call on returns that API's answer as it is. If callers need the old shape, choose "Say what it does" so the logic is written instead.</Notice>}
        </div>
      )}
      {mode === "address" && (
        <div className="mf-mg-stack" style={{ gap: 10 }} data-testid="finish-form">
          {envs.length > 0 && (
            <Field label="Take it from the old application's settings" hint="The uploaded settings files hold the address the old application used for this backend. If that backend is itself migrated to this server, enter the address of the migrated service instead.">
              <select className="mf-mg-input" data-testid="finish-from" value={from} onChange={(e) => setFrom(e.target.value)}>
                <option value="">No, I enter the address</option>
                {envs.map((e) => <option key={e} value={e}>{e}</option>)}
              </select>
            </Field>
          )}
          {from === ""
            ? <Field label="Address of this backend" error={touched ? problem || undefined : undefined} hint="Kept in this service's settings on this server. It is not shown again after saving."><input className="mf-mg-input mf-mono" value={url} aria-invalid={touched && !!problem} onChange={(e) => setUrl(e.target.value)} placeholder="https://" spellCheck={false} autoComplete="off" /></Field>
            : <span className="mf-mg-hint" data-testid="finish-from-hint">The address is read from <span className="mf-mono">{from}</span> on this server and put into this service's settings. It is not shown here.</span>}
        </div>
      )}
      {mode === "not_needed" && (
        <div data-testid="finish-form"><Field label="Why is it not needed?" error={touched ? problem || undefined : undefined} hint={item.kind === "entry" ? "The reason is written next to the service's code. This part is then left out of the new service." : "The reason is written in the service's code and the operation is removed. Callers that still use it get \"not found\"."}><textarea className="mf-mg-input" rows={2} value={text} onChange={(e) => setText(e.target.value)} placeholder="For example: this export is no longer used" /></Field></div>
      )}
      {mode === "note" && (
        <div data-testid="finish-form"><Field label="What does it do, and which API has to be called?" error={touched ? problem || undefined : undefined} hint="Kept with the service for the person who writes its logic. Saving a note does not finish this item: it stays open until that code is written."><textarea className="mf-mg-input" rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder="For example: looks up the guest's bookings. Call GET /bookings on the reservation API and return its list." /></Field></div>
      )}
      {mode && (
        <div className="mf-mg-actions">
          <Btn kind="primary" small busy={saving} disabled={disabled || !!problem || waits} onClick={save}>{mode === "note" ? "Save the note" : "Save this decision"}</Btn>
          <Btn small disabled={saving} onClick={() => setMode(null)}>Cancel</Btn>
        </div>
      )}
      {error && <Notice tone="bad">{error}</Notice>}
    </div>
  );
}

export function Finish({ m, onRun }: { m: Migration; onRun: (a: NextAction["id"]) => void }) {
  const qc = useQueryClient();
  const enabled = !!m.serviceDir;
  const q = useQuery({ queryKey: ["open-items", m.id], queryFn: () => api.openItems(m.id), enabled, staleTime: 10000 });
  const [said, setSaid] = useState("");
  const decide = useMutation<ResolveResult, ApiError, Decision>({
    mutationFn: (d) => api.resolve(m.id, d),
    onSuccess: (r) => { qc.setQueryData<OpenItems>(["open-items", m.id], r.openItems); setSaid(txt(r.message)); qc.invalidateQueries({ queryKey: ["migration", m.id] }); qc.invalidateQueries({ queryKey: ["migrations"] }); qc.invalidateQueries({ queryKey: ["estate"] }); },
  });
  // a step that just finished may have changed what is open
  const wasBusy = useRef(false);
  useEffect(() => { if (wasBusy.current && !m.busy) qc.invalidateQueries({ queryKey: ["open-items", m.id] }); wasBusy.current = !!m.busy; }, [m.busy, m.id, qc]);

  if (!enabled) return null;
  if (q.isLoading) return <Panel title="Finish this migration"><Loading rows={2} /></Panel>;
  if (q.isError) return <Panel title="Finish this migration"><Failed what="What is left of this service could not be read right now." error={q.error} onRetry={() => q.refetch()} /></Panel>;
  const d = q.data;
  if (!d || !d.exists) return null;
  const items = d.items ?? [], closed = d.closed ?? [], pending = d.pending ?? [];
  if (items.length === 0 && closed.length === 0 && pending.length === 0) return null;
  const changed = pending.length > 0 || (!!d.needsBuild && closed.length > 0);
  const built = !d.needsBuild && !!d.ready;          // built with the decisions, only the install is missing
  const many = pending.length === 1 ? "decision is" : "decisions are";
  const locked = !!m.busy || !!d.busy;
  const none = nothingOpen(d);
  const back = decide.variables?.action === "reopen";

  return (
    <Panel title="Finish this migration" actions={items.length ? <Pill tone="warn">{items.length} open</Pill> : none.done ? <Pill tone="ok">Nothing open</Pill> : <Pill tone="warn">Not finished</Pill>}>
      <div className="mf-mg-stack" style={{ gap: 12 }} data-testid="finish">
        <p className="mf-mg-sub mf-mg-wrap" style={{ fontSize: 13.5, margin: 0 }}>
          {items.length ? "The tool wrote the frame of this service from the old code. It does not make up what an operation should do, so these items wait for someone who knows the old application. For each one, say what it is. Nothing you enter here leaves this server." : none.done ? none.text : "No item is open, but this service is not finished."}
        </p>
        {!items.length && !none.done && <Notice tone="warn"><span data-testid="finish-not-ready">{none.text}</span></Notice>}
        {said && <Notice tone="ok">{said}</Notice>}
        {items.map((it) => (
          <ItemCard key={it.id} item={it} backends={d.backends ?? []} canAdd={!!d.canAddBackend} disabled={locked} saving={decide.isPending && !back && decide.variables?.id === it.id}
            error={decide.isError && !back && decide.variables?.id === it.id ? errText(decide.error) : ""} onDecide={(dec, done) => { setSaid(""); decide.mutate(dec, { onSuccess: done }); }} />
        ))}
        {changed && (
          <Notice tone="warn">
            <strong>{!pending.length ? "The service changed after it was last built."
              : built ? `${pending.length} ${many} saved and the service is built with them. ${d.installed ? "The installed service is still the earlier version." : "It is not installed yet."}`
              : `${pending.length} ${many} saved in the service, but ${d.installed ? "the installed service is still the earlier version" : "the service has not been built with them yet"}.`}</strong>
            <span style={{ display: "block", marginTop: 2 }}>{built ? "Deploy it to put them in use." : "Build and check it, then deploy. Until then callers get the earlier answers."}</span>
            <span className="mf-mg-actions" style={{ marginTop: 8 }}>
              {built ? <Btn small kind="primary" icon={<Play size={14} aria-hidden="true" />} disabled={locked} onClick={() => onRun("deploy")}>Deploy</Btn>
                : <Btn small kind="primary" icon={<Play size={14} aria-hidden="true" />} disabled={locked} onClick={() => onRun("test")}>Build and check</Btn>}
              {built && <Btn small disabled={locked} onClick={() => onRun("test")}>Build and check again</Btn>}
            </span>
          </Notice>
        )}
        {closed.length > 0 && (
          <details data-testid="finish-closed" open={!items.length && !none.done ? true : undefined}>
            <summary className="mf-mg-small" style={{ cursor: "pointer", fontWeight: 600 }}>Decisions made ({closed.length})</summary>
            <ul className="mf-mg-small mf-mg-wrap" style={{ margin: "8px 0 0", paddingLeft: 18, lineHeight: 1.6 }}>
              {closed.slice().reverse().map((c, i) => <li key={i}><span className="mf-mono">{txt(c.title)}</span>: {txt(c.how)}{c.detail ? <span className="mf-mg-muted"> ({txt(c.detail)})</span> : null}{c.t ? <span className="mf-mg-muted"> · {ago(c.t)}</span> : null}
                {c.canReopen ? <span style={{ display: "inline-block", marginLeft: 8, verticalAlign: "middle" }}><Btn small icon={<Undo2 size={14} aria-hidden="true" />} disabled={locked} busy={decide.isPending && back && decide.variables?.id === c.id}
                  onClick={() => { setSaid(""); decide.mutate({ id: c.id, action: "reopen" }); }}>Take it back</Btn></span> : null}</li>)}
            </ul>
            {closed.some((c) => c.canReopen) && <span className="mf-mg-hint" style={{ display: "block", marginTop: 6 }}>Taking a "not needed" decision back puts the item on the list again, as it was before.</span>}
            {decide.isError && back && <Notice tone="bad">{errText(decide.error)}</Notice>}
          </details>
        )}
      </div>
    </Panel>
  );
}
