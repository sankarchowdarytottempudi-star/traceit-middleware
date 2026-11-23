// "Open decisions": the steps where the agent stopped because a person has to choose (which
// connector, an expression, code, the services to call, leave the step out, or finish it by hand).
// All changed answers go to the migration tool in one request; it keeps them and rebuilds the
// migration with them. Rows it cannot accept come back with the card they belong to.
import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Save } from "lucide-react";
import { api, type AgentDecision, type AnswerType, type ApiError, type DecisionAnswer, type DecisionAnswerInput, type DecisionRowError, type DecisionScope, type Migration } from "../api.ts";
import { txt } from "../lib/text.ts";
import { dateTime } from "../lib/migrate.ts";
import { Btn, Failed, Field, Loading, Notice, Panel, Pill, errText } from "./ui.tsx";

export const KIND_LABEL: Record<string, string> = {
  connector: "Connector step",
  builtin: "Built-in step",
  java: "Java code",
  "dynamic-call": "Call decided while running",
  unknown: "Step not recognised",
};
export const ANSWER_LABEL: Record<AnswerType, string> = {
  connector: "Use a connector",
  expression: "Write an expression",
  code: "Write code",
  call: "Call these services",
  drop: "Remove this step",
  manual: "I'll finish this by hand",
};
const ANSWER_TYPES: AnswerType[] = ["connector", "expression", "code", "call", "drop", "manual"];
export const LANGUAGES: [string, string][] = [["java", "Java"], ["javascript", "JavaScript"], ["groovy", "Groovy"], ["python", "Python"], ["sql", "SQL"]];

/** What a person has typed or picked for one decision (only decisions a person touched have one). */
export interface Draft { type: AnswerType; option: string; text: string; language: string; services: string; dropOk: boolean; scope: DecisionScope; note: string }

const optKey = (connector: string, operation: string) => `${connector}\u0000${operation}`;
const typesOf = (d: AgentDecision): AnswerType[] => {
  const t = (d.answerTypes ?? []).filter((x): x is AnswerType => ANSWER_TYPES.includes(x as AnswerType));
  return t.length ? t : ["manual"];
};
export const isAnswered = (d: AgentDecision) => !!d.answer && typeof d.answer === "object" && !!(d.answer as { type?: string }).type;

/** A draft that starts from the saved answer (when there is one) or the first way of answering. */
export function draftOf(d: AgentDecision): Draft {
  const types = typesOf(d);
  const a = isAnswered(d) ? d.answer! : null;
  const type = a && types.includes(a.type) ? a.type : types[0];
  return {
    type,
    option: a?.type === "connector" ? optKey(a.connector, a.operation) : "",
    text: a?.type === "expression" || a?.type === "code" ? txt(a.text) : "",
    language: a?.type === "code" ? txt(a.language) || "java" : "java",
    services: a?.type === "call" ? (a.services ?? []).join("\n") : "",
    dropOk: a?.type === "drop",
    scope: d.scope === "workspace" ? "workspace" : "api",
    note: txt(d.note),
  };
}

export const servicesOf = (s: string): string[] => [...new Set(s.split(/[\n,]/).map((x) => x.trim()).filter(Boolean))];

/** The answer a draft stands for, or the problem that stops it from being sent. */
export function answerOf(dr: Draft): { answer: DecisionAnswer } | { problem: string } {
  switch (dr.type) {
    case "connector": {
      if (!dr.option) return { problem: "Choose the connector to use." };
      const [connector, operation] = dr.option.split("\u0000");
      return { answer: { type: "connector", connector, operation: operation ?? "" } };
    }
    case "expression": return dr.text.trim() ? { answer: { type: "expression", text: dr.text.trim() } } : { problem: "Write the expression." };
    case "code": return dr.text.trim() ? { answer: { type: "code", language: dr.language || "java", text: dr.text } } : { problem: "Write the code." };
    case "call": { const services = servicesOf(dr.services); return services.length ? { answer: { type: "call", services } } : { problem: "Name at least one service to call." }; }
    case "drop": return dr.dropOk ? { answer: { type: "drop" } } : { problem: "Tick the box to confirm the step can be removed." };
    default: return { answer: { type: "manual" } };
  }
}

/** The body of "Save answers": every changed answer, in the order of the list; problems by decision id. */
export function buildAnswers(drafts: Record<string, Draft>, decisions: AgentDecision[]): { answers: DecisionAnswerInput[]; problems: Record<string, string> } {
  const answers: DecisionAnswerInput[] = [];
  const problems: Record<string, string> = {};
  for (const d of decisions) {
    const dr = drafts[d.id];
    if (!dr) continue;
    const r = answerOf(dr);
    if ("problem" in r) { problems[d.id] = r.problem; continue; }
    answers.push({ id: d.id, answer: r.answer, scope: dr.scope, ...(dr.note.trim() ? { note: dr.note.trim().slice(0, 2000) } : {}) });
  }
  return { answers, problems };
}

export function answerText(a: DecisionAnswer | null | undefined, d?: AgentDecision): string {
  if (!a) return "";
  switch (a.type) {
    case "connector": {
      const o = (d?.options ?? []).find((x) => x.connector === a.connector && x.operation === a.operation);
      return `Use ${txt(o?.label) || [a.connector, a.operation].filter(Boolean).join(" · ")}`;
    }
    case "expression": return "An expression";
    case "code": return `Code (${(LANGUAGES.find(([k]) => k === a.language)?.[1]) || txt(a.language) || "code"})`;
    case "call": return `Call ${(a.services ?? []).join(", ")}`;
    case "drop": return "The step is removed";
    default: return "Finished by hand";
  }
}

type Filter = "open" | "answered" | "all";

function DecisionCard({ d, draft, editing, problem, disabled, onChange, onEdit }: {
  d: AgentDecision; draft: Draft | undefined; editing: boolean; problem?: string; disabled: boolean;
  onChange: (dr: Draft) => void; onEdit: () => void;
}) {
  const answered = isAnswered(d);
  const types = typesOf(d);
  const dr = draft ?? draftOf(d);
  const set = (p: Partial<Draft>) => onChange({ ...dr, ...p });
  const kind = txt(d.kind) || "unknown";
  const where = [txt(d.flow), txt(d.where)].filter(Boolean).join(" · ");
  const name = `decision-${d.id}`;
  return (
    <div className="mf-mg-card" data-testid="decision" data-decision={d.id} data-answered={answered ? "yes" : "no"}>
      <div className="mf-mg-row" style={{ gap: 8, alignItems: "flex-start" }}>
        <span className="mf-mg-grow mf-mg-wrap" style={{ fontWeight: 700, fontSize: 14, flexBasis: 200 }}>{where || txt(d.construct) || d.id}</span>
        <Pill tone={kind === "unknown" ? "warn" : undefined}>{KIND_LABEL[kind] ?? kind}</Pill>
        {answered && <Pill tone="ok">Answered</Pill>}
        {draft && <Pill tone="accent">Changed, not saved</Pill>}
      </div>
      {txt(d.source) && <span className="mf-mono mf-mg-small mf-mg-muted mf-mg-wrap" data-testid="decision-source">{txt(d.source)}</span>}
      {answered && !editing ? (
        <div className="mf-mg-row" style={{ gap: 8 }} data-testid="decision-answered">
          <span className="mf-mg-small mf-mg-grow mf-mg-wrap" style={{ flexBasis: 220 }}>
            <strong>{answerText(d.answer, d)}</strong>
            {" — "}Answered{txt(d.answeredBy) ? ` by ${txt(d.answeredBy)}` : ""}{d.answeredAt ? ` on ${dateTime(d.answeredAt)}` : ""}{d.scope === "workspace" ? " (every API in this workspace)" : ""}
          </span>
          <Btn small disabled={disabled} onClick={onEdit} data-testid="decision-change">Change</Btn>
        </div>
      ) : (
        <>
          {txt(d.construct) && <span className="mf-mg-small mf-mg-wrap"><strong>In the source:</strong> <span className="mf-mono">{txt(d.construct)}</span></span>}
          {txt(d.summary) && <span className="mf-mg-small mf-mg-wrap" data-testid="decision-summary"><strong>What it does:</strong> {txt(d.summary)}</span>}
          {txt(d.why) && <span className="mf-mg-small mf-mg-muted mf-mg-wrap" data-testid="decision-why"><strong style={{ color: "var(--text)" }}>Why the agent stopped:</strong> {txt(d.why)}</span>}
          {types.length > 1 && (
            <div className="mf-mg-choices" role="radiogroup" aria-label="How should this step be done?" data-testid="decision-types">
              {types.map((t) => (
                <button key={t} type="button" role="radio" aria-checked={dr.type === t} className="mf-btn mf-mg-choice" disabled={disabled} onClick={() => set({ type: t })} style={{ whiteSpace: "normal" }}>
                  {ANSWER_LABEL[t]}
                </button>
              ))}
            </div>
          )}
          {dr.type === "connector" && (
            <Field label="Connector to use">
              <select className="mf-mg-input" value={dr.option} disabled={disabled} onChange={(e) => set({ option: e.target.value })} data-testid="decision-connector">
                <option value="">Choose a connector</option>
                {(d.options ?? []).map((o) => <option key={optKey(o.connector, o.operation)} value={optKey(o.connector, o.operation)}>{txt(o.label) || [o.connector, o.operation].filter(Boolean).join(" · ")}</option>)}
              </select>
            </Field>
          )}
          {dr.type === "expression" && (
            <Field label="Expression" hint="What the step works out, written as an expression of the target platform.">
              <textarea className="mf-mg-input mf-mono" rows={3} value={dr.text} disabled={disabled} onChange={(e) => set({ text: e.target.value })} spellCheck={false} data-testid="decision-expression" />
            </Field>
          )}
          {dr.type === "code" && (
            <>
              <Field label="Language">
                <select className="mf-mg-input" value={dr.language} disabled={disabled} onChange={(e) => set({ language: e.target.value })} data-testid="decision-language">
                  {LANGUAGES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </select>
              </Field>
              <Field label="Code">
                <textarea className="mf-mg-input mf-mono" rows={8} value={dr.text} disabled={disabled} onChange={(e) => set({ text: e.target.value })} spellCheck={false} data-testid="decision-code" />
              </Field>
            </>
          )}
          {dr.type === "call" && (
            <Field label="Services to call" hint="One per line, or separated by commas, in the order they are called.">
              <textarea className="mf-mg-input mf-mono" rows={3} value={dr.services} disabled={disabled} onChange={(e) => set({ services: e.target.value })} spellCheck={false} data-testid="decision-services" />
            </Field>
          )}
          {dr.type === "drop" && (
            <label className="mf-mg-check mf-mg-check-wrap">
              <input type="checkbox" checked={dr.dropOk} disabled={disabled} onChange={(e) => set({ dropOk: e.target.checked })} data-testid="decision-drop" />
              <span>Remove this step (owner confirmed)</span>
            </label>
          )}
          {dr.type === "manual" && <span className="mf-mg-hint mf-mg-wrap" data-testid="decision-manual">The step stays in the project as a to-do with this note, and a person finishes it in the target platform.</span>}
          <fieldset style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
            <legend className="mf-mg-small" style={{ fontWeight: 600, marginBottom: 6 }}>Use this answer for</legend>
            <div className="mf-mg-row" style={{ gap: 14 }}>
              <label className="mf-mg-check mf-mg-check-wrap"><input type="radio" name={`${name}-scope`} checked={dr.scope === "api"} disabled={disabled} onChange={() => set({ scope: "api" })} />Only this API</label>
              <label className="mf-mg-check mf-mg-check-wrap"><input type="radio" name={`${name}-scope`} checked={dr.scope === "workspace"} disabled={disabled} onChange={() => set({ scope: "workspace" })} data-testid="decision-scope-workspace" />Every API in this workspace</label>
            </div>
          </fieldset>
          <Field label="Note (optional)" hint="Why this is the right choice. Kept with the answer.">
            <input className="mf-mg-input" value={dr.note} maxLength={2000} disabled={disabled} onChange={(e) => set({ note: e.target.value })} data-testid="decision-note" />
          </Field>
        </>
      )}
      {problem && <span className="mf-mg-err mf-mg-wrap" role="alert" data-testid="decision-error">{problem}</span>}
    </div>
  );
}

export function Decisions({ m }: { m: Migration }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["migration-decisions", m.id], queryFn: () => api.decisions(m.id), retry: false, enabled: (!!m.serviceDir || !!m.decisionsCounts) && m.sourceType !== "requirements" && !m.checkOnly });
  const [filter, setFilter] = useState<Filter>("open");
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [editing, setEditing] = useState<Set<string>>(new Set());
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");
  const [done, setDone] = useState("");
  const list = q.data?.decisions ?? [];
  const counts = useMemo(() => {
    const answered = list.filter(isAnswered).length;
    return { open: list.length - answered, answered };
  }, [list]);
  if (!m.apiName && !m.decisionsCounts) return null;
  if (q.isError && (q.error as ApiError).status === 404) return null;
  if (q.isSuccess && list.length === 0) return null;

  const busy = !!m.busy || !!m.queued;
  const shown = list.filter((d) => filter === "all" || (filter === "open" ? !isAnswered(d) || editing.has(d.id) || !!drafts[d.id] : isAnswered(d)));
  const changed = Object.keys(drafts).length;

  const change = (d: AgentDecision, dr: Draft) => {
    setDrafts((s) => ({ ...s, [d.id]: dr }));
    setProblems((p) => { const n = { ...p }; delete n[d.id]; return n; });
    setDone("");
  };
  const save = () => {
    const { answers, problems: local } = buildAnswers(drafts, list);
    setErr(""); setDone("");
    if (Object.keys(local).length) { setProblems(local); setErr("Some answers are not complete. They are marked below."); return; }
    if (!answers.length) return;
    setSaving(true);
    api.answerDecisions(m.id, answers)
      .then((r) => {
        const n = Number(r?.applied ?? answers.length);
        setDrafts({}); setEditing(new Set()); setProblems({});
        setDone(`${n} answer${n === 1 ? "" : "s"} saved. The migration is being rebuilt with ${n === 1 ? "it" : "them"}.`);
        qc.invalidateQueries({ queryKey: ["migration-decisions", m.id] }); qc.invalidateQueries({ queryKey: ["migration", m.id] }); qc.invalidateQueries({ queryKey: ["migrations"] });
      })
      .catch((e: ApiError) => {
        const rows = Array.isArray(e.body?.errors) ? (e.body!.errors as DecisionRowError[]) : [];
        if (e.status === 422 && rows.length) {
          const byId: Record<string, string> = {};
          for (const r of rows) if (r.id) byId[r.id] = txt(r.problem) || "This answer was not accepted.";
          setProblems(byId);
          setErr(`${rows.length} answer${rows.length === 1 ? " was" : "s were"} not accepted. Nothing was saved: correct the answers marked below and save again.`);
        } else if (e.status === 409) {
          setErr(txt(e.body?.error) || "A step of this migration is running. Save the answers when it has finished.");
        } else setErr(errText(e));
      })
      .finally(() => setSaving(false));
  };

  const FILTERS: [Filter, string, number][] = [["open", "Open", counts.open], ["answered", "Answered", counts.answered], ["all", "All", list.length]];
  return (
    <Panel title="Open decisions" actions={q.isSuccess ? <Pill tone={counts.open ? "warn" : "ok"}>{counts.open ? `${counts.open} open` : "All answered"}</Pill> : undefined}>
      <div className="mf-mg-stack" style={{ gap: 12 }} data-testid="decisions">
        <p className="mf-mg-sub mf-mg-wrap" style={{ fontSize: 13.5, margin: 0 }}>
          The agent stopped at these steps because it needs a person's choice. Answer them here and the migration is rebuilt with your answers.
        </p>
        {q.isLoading ? <Loading rows={2} h={90} /> : q.isError ? <Failed what="The open decisions are not available right now." error={q.error} onRetry={() => q.refetch()} /> : (
          <>
            <div className="mf-mg-row" role="radiogroup" aria-label="Which decisions to show" style={{ gap: 8 }} data-testid="decisions-filter">
              {FILTERS.map(([f, label, n]) => (
                <button key={f} type="button" role="radio" aria-checked={filter === f} className={`mf-tab${filter === f ? " mf-tab-on" : ""}`} onClick={() => setFilter(f)}>
                  {label}<span className="mf-mg-count">{n}</span>
                </button>
              ))}
            </div>
            {busy && <span className="mf-mg-hint mf-mg-wrap" data-testid="decisions-busy">A step of this migration is running. The answers can be saved when it has finished.</span>}
            {shown.length === 0 ? (
              <p className="mf-mg-small mf-mg-muted" style={{ margin: 0 }} data-testid="decisions-none">{filter === "open" ? "Every decision is answered." : "No decision is answered yet."}</p>
            ) : (
              <div className="mf-mg-stack" style={{ gap: 10 }}>
                {shown.map((d) => (
                  <DecisionCard key={d.id} d={d} draft={drafts[d.id]} editing={editing.has(d.id) || !!drafts[d.id]} problem={problems[d.id]} disabled={busy || saving}
                    onChange={(dr) => change(d, dr)} onEdit={() => { setEditing((s) => new Set(s).add(d.id)); setDrafts((s) => ({ ...s, [d.id]: s[d.id] ?? draftOf(d) })); }} />
                ))}
              </div>
            )}
            {err && <Notice tone={Object.keys(problems).length ? "warn" : "bad"}><span data-testid="decisions-error">{err}</span></Notice>}
            {done && <Notice tone="ok"><span data-testid="decisions-done">{done}</span></Notice>}
            <div className="mf-mg-actions">
              <Btn kind="primary" icon={<Save size={15} aria-hidden="true" />} disabled={!changed || busy} busy={saving} onClick={save} data-testid="decisions-save">Save answers</Btn>
              {changed > 0 && <span className="mf-mg-hint mf-mg-wrap">{changed} changed answer{changed === 1 ? "" : "s"} will be saved together.</span>}
              {changed > 0 && <Btn small disabled={saving} onClick={() => { setDrafts({}); setEditing(new Set()); setProblems({}); setErr(""); }}>Undo changes</Btn>}
            </div>
          </>
        )}
      </div>
    </Panel>
  );
}
