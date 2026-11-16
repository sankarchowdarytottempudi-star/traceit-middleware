// Two views of what a migrated service really does, both from the tool:
//  - "Trial run": the built service was started on the build server in a closed network, with its
//    deployment settings and every API it calls replaced by a stand-in with made-up data; each
//    operation and each part that starts by itself was called once.
//  - "Parts that start by themselves": timers, queue and topic listeners. They are installed
//    switched off, because the old application still does the same work; switching one on is a
//    person's decision. Values typed here go to the service's settings and never come back.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Play, Power, PowerOff } from "lucide-react";
import { api, type ApiError, type Decision, type Migration, type OpenItems, type ResolveResult, type StartPart } from "../api.ts";
import { txt } from "../lib/text.ts";
import { ago } from "../lib/migrate.ts";
import { Btn, Field, Method, Notice, Panel, Pill, errText } from "./ui.tsx";

const OP_WORDS: Record<string, [string, "ok" | "warn" | "bad" | "muted"]> = {
  answered: ["answered", "ok"], confirmed: ["as expected", "ok"], error: ["error on made-up data", "warn"],
  missing: ["not in the service", "bad"], placeholder: ["not migrated", "bad"], "no-answer": ["no answer", "bad"],
  stopped: ["not tried", "bad"], "case-failed": ["not as expected", "bad"],
};
const PART_WORDS: Record<string, [string, "ok" | "warn" | "bad" | "muted"]> = {
  confirmed: ["ran as expected", "ok"], ran: ["ran", "ok"], "ran-with-errors": ["ran, with errors", "warn"],
  "not-tried": ["not tried", "muted"], "nothing-seen": ["nothing seen", "warn"], failed: ["failed", "bad"], "case-failed": ["not as expected", "bad"],
};

export function TrialRun({ m }: { m: Migration }) {
  const t = m.trial;
  if (!t) return null;
  const ops = t.operations ?? [], parts = t.parts ?? [];
  const tone = !t.ran ? "muted" : t.passed ? "ok" : "bad";
  return (
    <Panel title="Trial run" actions={<Pill tone={tone}>{!t.ran ? "Not run" : t.passed ? "Passed" : "Found faults"}</Pill>}>
      <div className="mf-mg-stack" style={{ gap: 10 }} data-testid="trial">
        <p className="mf-mg-sub mf-mg-wrap" style={{ fontSize: 13.5, margin: 0 }}>
          Every time the service is built and checked, it is started on the build server in a closed network, with its deployment settings.
          Every API it calls is replaced by a stand-in with made-up data, so no real system is reached. Each operation and each part that starts by itself is called once.
          {t.at ? <span className="mf-mg-muted"> Last run {ago(t.at)}.</span> : null}
        </p>
        {!t.ran && <Notice>{txt(t.reason) || "The trial run did not start."}</Notice>}
        {t.ran && !t.started && <Notice tone="bad">The service did not start: {txt(t.why)}</Notice>}
        {t.ran && (t.faults ?? []).length > 0 && (
          <Notice tone="bad"><ul className="mf-mg-wrap" style={{ margin: 0, paddingLeft: 18, lineHeight: 1.5 }} data-testid="trial-faults">{(t.faults ?? []).map((f, i) => <li key={i}>{txt(f)}</li>)}</ul></Notice>
        )}
        {ops.length > 0 && (
          <div className="mf-mg-sec"><h3>Operations</h3>
            <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 6 }}>
              {ops.map((o, i) => {
                const [word, tn] = OP_WORDS[txt(o.result)] ?? [txt(o.result), "muted"];
                const [verb, ...rest] = txt(o.op).split(" ");
                return (
                  <li key={i} className="mf-mg-row mf-mg-small" style={{ gap: 6 }} data-testid="trial-op">
                    <Method method={verb} /><span className="mf-mono mf-mg-wrap">{rest.join(" ")}</span>
                    {o.case ? <span className="mf-mg-muted">· {txt(o.case)}</span> : null}
                    <Pill tone={tn}>{word}{o.status ? ` · ${o.status}` : ""}</Pill>
                    {(o.calls ?? []).length > 0 && <span className="mf-mg-muted mf-mg-wrap">called {(o.calls ?? []).map((c) => txt(c)).join(", ")}</span>}
                    {o.note ? <span className="mf-mg-muted mf-mg-wrap">{txt(o.note)}</span> : null}
                  </li>
                );
              })}
            </ul>
            {ops.some((o) => o.result === "error") && <span className="mf-mg-hint">"Error on made-up data": the operation is there and ran, but the stand-in's empty answers were not enough for it. That is not counted as a fault. Example requests with expected answers in the service's e2e/trial.json turn these into real checks.</span>}
          </div>
        )}
        {parts.length > 0 && (
          <div className="mf-mg-sec"><h3>Parts that start by themselves (each switched on alone, for the trial only)</h3>
            <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 6 }}>
              {parts.map((p, i) => {
                const [word, tn] = PART_WORDS[txt(p.result)] ?? [txt(p.result), "muted"];
                return (
                  <li key={i} className="mf-mg-row mf-mg-small" style={{ gap: 6 }} data-testid="trial-part">
                    <span className="mf-mono">{txt(p.name)}</span><span className="mf-mg-muted">({txt(p.starts)})</span><Pill tone={tn}>{word}</Pill>
                    {(p.calls ?? []).length > 0 && <span className="mf-mg-muted mf-mg-wrap">called {(p.calls ?? []).map((c) => txt(c)).join(", ")}</span>}
                    {p.note ? <span className="mf-mg-muted mf-mg-wrap" style={{ flexBasis: "100%" }}>{txt(p.note)}</span> : null}
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </div>
    </Panel>
  );
}

function PartCard({ part, pending, disabled, onDecide, busyWith, error }: {
  part: StartPart; pending: boolean; disabled: boolean; busyWith: string; error: string;
  onDecide: (d: Decision, done?: () => void) => void;
}) {
  const id = `start:${part.name}`;
  const [asking, setAsking] = useState(false);
  const [sure, setSure] = useState(false);
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const empty = part.empty ?? [];
  const setHere = part.setHere ?? [];
  const secret = (k: string) => [...empty, ...setHere].some((e) => e.key === k && (e.secret || e.secretSet));
  const on = part.on === true;
  return (
    <div className="mf-mg-card" data-testid="start-part" data-part={part.name}>
      <div className="mf-mg-row" style={{ gap: 8 }}>
        <Pill tone={on ? "ok" : "warn"}>{on ? "On" : part.on === false ? "Off" : "No switch"}</Pill>
        <span className="mf-mono" style={{ fontWeight: 600, fontSize: 13.5 }}>{txt(part.name)}</span>
        <span className="mf-mg-small mf-mg-muted">{txt(part.starts)}</span>
        {pending && <Pill tone="accent">Not deployed yet</Pill>}
      </div>
      {part.switch ? (
        <span className="mf-mg-hint mf-mg-wrap">Switch: <span className="mf-mono">enabled</span> in the <span className="mf-mono">{txt(part.switch)}</span> section of the service's settings.
          {on ? " The service does this work." : " The service is installed, but it does not do this work. The old application still does."}</span>
      ) : <span className="mf-mg-hint">This part has no switch the tool knows; it runs whenever the service runs.</span>}
      {empty.length > 0 && (
        <Notice tone="warn"><span data-testid="start-empty">Settings with no value: {empty.map((e) => e.key).join(", ")}. {on ? "It cannot work without them." : "Fill them before switching it on."}</span></Notice>
      )}
      {part.switch && (
        <div className="mf-mg-actions">
          {!on ? <Btn small kind="primary" icon={<Power size={14} aria-hidden="true" />} disabled={disabled} onClick={() => { setAsking(!asking); setSure(false); }}>Switch on…</Btn>
            : <Btn small icon={<PowerOff size={14} aria-hidden="true" />} disabled={disabled} busy={busyWith === id + ":off"} onClick={() => onDecide({ id, action: "switch", on: false })}>Switch off</Btn>}
        </div>
      )}
      {asking && !on && (
        <Notice tone="warn">
          <div data-testid="start-confirm">
            <strong>Switch this on only when the old application has stopped doing this work.</strong>
            <span style={{ display: "block", margin: "4px 0 6px" }}>While both run, the work is done twice: records are written twice and messages are sent twice. Once it is on, the new service does this work with its deployment settings, against the real systems.</span>
            <label style={{ display: "flex", gap: 8, alignItems: "flex-start", cursor: "pointer" }}>
              <input type="checkbox" data-testid="start-sure" checked={sure} onChange={(e) => setSure(e.target.checked)} style={{ marginTop: 3 }} />
              <span>The old application no longer does this work.</span>
            </label>
            <span className="mf-mg-actions" style={{ marginTop: 8 }}>
              <Btn small kind="primary" disabled={!sure || disabled} busy={busyWith === id + ":on"} onClick={() => onDecide({ id, action: "switch", on: true, confirm: true }, () => setAsking(false))}>Switch it on</Btn>
              <Btn small onClick={() => setAsking(false)}>Cancel</Btn>
            </span>
          </div>
        </Notice>
      )}
      {(empty.length > 0 || setHere.length > 0) && (
        <details>
          <summary className="mf-mg-small" style={{ cursor: "pointer", fontWeight: 600 }}>Fill a setting of this part</summary>
          <div className="mf-mg-stack" style={{ gap: 8, marginTop: 8 }}>
            <Field label="Setting">
              <select className="mf-mg-input" data-testid="start-key" value={key} onChange={(e) => { setKey(e.target.value); setValue(""); }}>
                <option value="">Choose…</option>
                {[...empty, ...setHere].map((e) => <option key={e.key} value={e.key}>{e.key}{empty.some((x) => x.key === e.key) ? " (no value)" : " (set here before)"}</option>)}
              </select>
            </Field>
            {key && (
              <Field label="Value" hint="Written into the service's settings on this server. It is not shown again after saving and never leaves this server.">
                <input className="mf-mg-input mf-mono" data-testid="start-value" type={secret(key) ? "password" : "text"} value={value} maxLength={500} onChange={(e) => setValue(e.target.value)} spellCheck={false} autoComplete="off" />
              </Field>
            )}
            {key && <span className="mf-mg-actions"><Btn small kind="primary" disabled={!value.trim() || disabled} busy={busyWith === id + ":setting"}
              onClick={() => onDecide({ id, action: "setting", key, value }, () => { setValue(""); setKey(""); })}>Save the value</Btn></span>}
          </div>
        </details>
      )}
      {error && <Notice tone="bad">{error}</Notice>}
    </div>
  );
}

export function StartParts({ m, onRun }: { m: Migration; onRun: (a: "deploy") => void }) {
  const qc = useQueryClient();
  const enabled = !!m.serviceDir;
  const q = useQuery({ queryKey: ["open-items", m.id], queryFn: () => api.openItems(m.id), enabled, staleTime: 10000 });
  const [said, setSaid] = useState("");
  const decide = useMutation<ResolveResult, ApiError, Decision>({
    mutationFn: (d) => api.resolve(m.id, d),
    onSuccess: (r) => { qc.setQueryData<OpenItems>(["open-items", m.id], r.openItems); setSaid(txt(r.message)); qc.invalidateQueries({ queryKey: ["migration", m.id] }); qc.invalidateQueries({ queryKey: ["migrations"] }); },
  });
  const parts = q.data?.starts ?? [];
  if (!enabled || !parts.length) return null;
  const pending = q.data?.pending ?? [];
  const off = parts.filter((p) => p.on === false).length;
  const v = decide.variables as (Decision & { on?: boolean }) | undefined;
  const busyWith = decide.isPending && v ? `${v.id}:${v.action === "switch" ? (v.on ? "on" : "off") : "setting"}` : "";
  const locked = !!m.busy || !!q.data?.busy;
  const deployed = txt((m.phases ?? []).find((x) => x.key === "deploy")?.status) === "done";
  return (
    <Panel title="Parts that start by themselves" actions={off ? <Pill tone="warn">{off} switched off</Pill> : <Pill tone="ok">All on</Pill>}>
      <div className="mf-mg-stack" style={{ gap: 12 }} data-testid="starts">
        <p className="mf-mg-sub mf-mg-wrap" style={{ fontSize: 13.5, margin: 0 }}>
          These parts of the old application run on a timer or wait for messages; nobody calls them. The new service is installed with them switched off,
          because the old application still does the same work and both together would do it twice. {deployed ? "Being installed is not the same as doing the work: a part that is off does nothing." : ""}
        </p>
        {said && <Notice tone="ok">{said}</Notice>}
        {parts.map((p) => (
          <PartCard key={p.name} part={p} pending={pending.some((x) => txt(x).startsWith(`${p.name} is switched`))} disabled={locked} busyWith={busyWith}
            error={decide.isError && v?.id === `start:${p.name}` ? errText(decide.error) : ""}
            onDecide={(d, done) => { setSaid(""); decide.mutate(d, { onSuccess: () => done?.() }); }} />
        ))}
        {pending.some((x) => / is switched (on|off)/.test(txt(x))) && (
          <Notice tone="warn">
            <strong>The settings are changed, but the installed service still runs with the earlier ones.</strong>
            <span style={{ display: "block", marginTop: 2 }}>Deploy to put the change in use. No new build is needed for a change of settings.</span>
            <span className="mf-mg-actions" style={{ marginTop: 8 }}><Btn small kind="primary" icon={<Play size={14} aria-hidden="true" />} disabled={locked} onClick={() => onRun("deploy")}>Deploy</Btn></span>
          </Notice>
        )}
      </div>
    </Panel>
  );
}
