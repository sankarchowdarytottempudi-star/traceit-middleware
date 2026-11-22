// "Requirements" panel of a service built from a requirement document: what was understood (with the sentences
// it came from in REQUIREMENTS-READ.md), the review workbook down and up again, and the generation for the target.
// The Delivery panel (package first) follows once the service is generated.
import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Download, FileText, Play, Upload } from "lucide-react";
import { api, requirementsWorkbook, uploadRequirements, type ApiError, type CorrectionRowError, type Migration, type RequirementsChange, type RequirementsResult } from "../api.ts";
import { num, txt } from "../lib/text.ts";
import { ago, dateTime, isRequirements, isWso2Target, openQuestionsText, targetLabel } from "../lib/migrate.ts";
import { Bar, Btn, Notice, Panel, Pill, errText } from "./ui.tsx";
import { saveBlob, TemplateLink } from "./MigrationFromRequirements.tsx";

const COUNT_WORDS: [string, string, string][] = [
  ["operations", "operation", "operations"], ["triggers", "trigger", "triggers"], ["systems", "system", "systems"],
  ["fields", "field mapping", "field mappings"], ["rules", "business rule", "business rules"], ["errors", "error-handling item", "error-handling items"],
  ["nonFunctional", "non-functional note", "non-functional notes"],
];

/** "2 operations, 3 systems, 7 business rules" (kinds with none are left out). */
export function countsLine(c: Record<string, number> | undefined | null): string {
  const parts = COUNT_WORDS.filter(([k]) => num(c?.[k]) > 0).map(([k, one, many]) => `${num(c?.[k])} ${num(c?.[k]) === 1 ? one : many}`);
  return parts.length ? parts.join(", ") : "no items";
}

function changeText(c: RequirementsChange): string {
  const where = [txt(c.sheet), txt(c.id)].filter(Boolean).join(" ");
  const what = txt(c.action) === "answer" ? `answered${txt(c.answer) ? `: ${txt(c.answer)}` : ""}` : txt(c.action) === "resolved" ? "resolved by the review" : txt(c.action);
  return `${where || "Item"} · ${what}${(c.fields ?? []).length ? ` (${(c.fields ?? []).map((f) => txt(f)).join(", ")})` : ""}`;
}

export function Requirements({ m, onRun, running }: { m: Migration; onRun: (id: "generate") => void; running?: boolean }) {
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [pct, setPct] = useState<number | null>(null);
  const [err, setErr] = useState<{ text: string; rows: CorrectionRowError[] } | null>(null);
  const [done, setDone] = useState<RequirementsResult | null>(null);
  const [getting, setGetting] = useState(false);
  const [getErr, setGetErr] = useState("");
  if (!isRequirements(m)) return null;
  const rq = m.requirements ?? null;
  const read = !!rq?.name;
  const busy = !!m.busy || !!m.queued;
  const lbl = targetLabel(m);
  const cov = rq?.coverage ?? {};
  const oq = num(rq?.openQuestions);
  const reviews = [...(rq?.reviews ?? [])].reverse();
  const gen = rq?.generated ?? null;
  const docStatus = txt((m.phases ?? []).find((p) => p.key === "document")?.status);

  const download = () => {
    setGetErr(""); setGetting(true);
    requirementsWorkbook(m.id).then(({ blob, filename }) => saveBlob(blob, filename)).catch((e: ApiError) => setGetErr(errText(e))).finally(() => setGetting(false));
  };
  const send = () => {
    if (!file) return;
    setErr(null); setDone(null); setPct(0);
    uploadRequirements(m.id, file, (f) => setPct(f)).promise
      .then((r) => {
        setPct(null); setFile(null);
        if (input.current) input.current.value = "";
        setDone(r);
        qc.invalidateQueries({ queryKey: ["migration", m.id] }); qc.invalidateQueries({ queryKey: ["migrations"] });
        qc.invalidateQueries({ queryKey: ["migration-docs", m.id] }); qc.invalidateQueries({ queryKey: ["migration-doc", m.id] });
      })
      .catch((e: ApiError) => {
        setPct(null);
        const rows = Array.isArray(e.body?.errors) ? (e.body!.errors as CorrectionRowError[]) : [];
        setErr({ text: errText(e), rows });
      });
  };

  return (
    <Panel title="Requirements" actions={read ? <Pill tone={oq ? "warn" : "ok"}>{openQuestionsText(oq)}</Pill> : <Pill tone="muted">{docStatus === "failed" ? "Not read" : "Not read yet"}</Pill>}>
      <div className="mf-mg-stack" style={{ gap: 12 }} data-testid="requirements">
        {!read ? (
          <p className="mf-mg-sub mf-mg-wrap" style={{ fontSize: 13.5, margin: 0 }} data-testid="requirements-unread">
            {docStatus === "failed" ? "The requirement document could not be read. What to do is shown above." : docStatus === "running" || busy ? "The requirement document is being read on this server…" : "The requirement document has not been read yet. Read it with the first step below."}
            {txt(m.sourceFile) ? <> Document: <span className="mf-mono">{txt(m.sourceFile).split("/").pop()?.replace(/^[0-9a-f]{8}-/, "")}</span>.</> : null}
          </p>
        ) : (
          <>
            <div className="mf-mg-stack" style={{ gap: 4 }} data-testid="requirements-understood">
              <strong style={{ fontSize: 14 }}>What was understood</strong>
              <span className="mf-mg-wrap" style={{ fontSize: 13.5 }} data-testid="requirements-coverage">{num(cov.turnedIntoItems)} of {num(cov.requirementStatements)} requirement sentences turned into items{num(cov.leftAsOpenQuestions) ? `; ${num(cov.leftAsOpenQuestions)} left as open questions` : ""}.</span>
              <span className="mf-mg-small mf-mg-muted mf-mg-wrap" data-testid="requirements-counts">{countsLine(rq?.counts)}</span>
              <span className="mf-mg-small mf-mg-wrap" data-testid="requirements-open">{oq ? <><strong>{openQuestionsText(oq)}</strong> not answered yet. Answer them in the workbook (sheet "Open questions"), or generate anyway: they stay listed in the project.</> : "Every question is answered."}</span>
              {txt(rq?.readAgainAt) ? <span className="mf-mg-small mf-mg-muted">Read again {ago(rq?.readAgainAt)}: answers from an earlier workbook are not in this reading.</span> : null}
            </div>
            <div className="mf-mg-row" style={{ gap: 8, flexWrap: "wrap" }}>
              <a className="mf-btn mf-mg-btn mf-mg-btn-sm" href={api.docUrl(m.id, "REQUIREMENTS-READ.md")} download="REQUIREMENTS-READ.md" data-testid="requirements-read-md"><FileText size={14} aria-hidden="true" />REQUIREMENTS-READ.md</a>
              <Btn small data-testid="requirements-download" icon={<Download size={14} aria-hidden="true" />} disabled={busy} busy={getting} onClick={download}>Review workbook (.xlsx)</Btn>
            </div>
            {getErr && <Notice tone="bad"><span data-testid="requirements-download-error">{getErr}</span></Notice>}

            <div className="mf-mg-sec" style={{ marginTop: 0 }}>
              <h3>Review</h3>
              <ol className="mf-mg-small mf-mg-wrap" style={{ margin: "4px 0 8px", paddingLeft: 20, lineHeight: 1.6 }} data-testid="requirements-how">
                <li>Download the review workbook. Every row shows the sentence it came from.</li>
                <li>Correct a row and write <span className="mf-mono">change</span> in <strong>Action</strong>; <span className="mf-mono">add</span> a missing row, <span className="mf-mono">delete</span> a wrong one; write your answer next to each open question.</li>
                <li>Upload it. Rows with a problem are listed and nothing is changed until they are fixed.</li>
              </ol>
              <div className="mf-mg-row" style={{ gap: 8 }}>
                <input ref={input} type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" data-testid="requirements-review-file" aria-label="Reviewed workbook (.xlsx)"
                  onChange={(e) => { setFile(e.target.files?.[0] ?? null); setErr(null); setDone(null); }} style={{ maxWidth: "100%", minWidth: 0 }} />
                <Btn small kind="primary" data-testid="requirements-upload" icon={<Upload size={14} aria-hidden="true" />} disabled={!file || pct !== null || busy} busy={pct !== null} onClick={send}>Upload the reviewed workbook</Btn>
              </div>
              {pct !== null && <Bar pct={Math.round(pct * 100)} label="Upload progress" />}
              {err && (
                <Notice tone={err.rows.length ? "warn" : "bad"}>
                  <span data-testid="requirements-error">{err.text}</span>
                  {err.rows.length > 0 && (
                    <ul className="mf-mg-small mf-mg-wrap" data-testid="requirements-errors" style={{ margin: "6px 0 0", paddingLeft: 18, lineHeight: 1.5 }}>
                      {err.rows.map((e, i) => <li key={i}>{txt(e.sheet) ? <>Sheet <strong>{txt(e.sheet)}</strong></> : "The workbook"}{e.row !== undefined && e.row !== "" && e.row !== null ? <>, row <strong>{String(e.row)}</strong></> : null}: {txt(e.problem)}</li>)}
                    </ul>
                  )}
                </Notice>
              )}
              {done && (
                <Notice tone="ok">
                  <span className="mf-mg-stack" style={{ gap: 6 }} data-testid="requirements-done">
                    <span>{txt(done.message) || "Review kept."}</span>
                    {(done.changes ?? []).length > 0 && (
                      <ul className="mf-mg-small mf-mg-wrap" data-testid="requirements-changes" style={{ margin: 0, paddingLeft: 18, lineHeight: 1.5 }}>
                        {(done.changes ?? []).slice(0, 40).map((c, i) => <li key={i}>{changeText(c)}</li>)}
                      </ul>
                    )}
                  </span>
                </Notice>
              )}
              {reviews.length > 0 && (
                <div className="mf-mg-list" style={{ marginTop: 8 }} data-testid="requirements-history">
                  {reviews.slice(0, 10).map((h, i) => (
                    <div key={`${txt(h.at)}-${i}`} className="mf-mg-item"><div className="mf-mg-item-head" style={{ cursor: "default", flexWrap: "wrap" }}>
                      <span className="mf-mg-item-title mf-mg-small" title={dateTime(h.at)}>Reviewed {h.at ? ago(h.at) : ""}{txt(h.by) ? <span className="mf-mg-muted"> · {txt(h.by)}</span> : null}</span>
                      <span className="mf-mg-small mf-mg-muted mf-mg-wrap">{num(h.changes)} change{num(h.changes) === 1 ? "" : "s"} · {openQuestionsText(h.openQuestions)} left</span>
                    </div></div>
                  ))}
                </div>
              )}
            </div>

            <div className="mf-mg-sec" style={{ marginTop: 0 }} data-testid="requirements-generate-box">
              <h3>Generate</h3>
              {gen ? <Notice tone={rq?.changedSinceGenerate ? "warn" : "ok"}><span data-testid="requirements-generated">{rq?.changedSinceGenerate ? "The requirements changed after the service was generated: generate again to build it with your review. " : ""}Generated {gen.at ? ago(gen.at) : ""}{txt(gen.service) ? <> as <span className="mf-mono">{txt(gen.service)}</span></> : null}{txt(gen.line) ? `: ${txt(gen.line)}.` : "."}</span></Notice> : null}
              <div className="mf-mg-row" style={{ gap: 10, alignItems: "flex-start" }}>
                <Btn kind={!gen || rq?.changedSinceGenerate ? "primary" : "default"} data-testid="requirements-generate" icon={<Play size={14} aria-hidden="true" />} disabled={busy} busy={running}
                  onClick={() => onRun("generate")} style={{ minWidth: 0, maxWidth: "100%", whiteSpace: "normal", height: "auto", minHeight: 38, padding: "8px 14px", textAlign: "left" }}>
                  {gen ? `Generate the ${lbl} service again` : `Generate the ${lbl} service`}
                </Btn>
                <span className="mf-mg-hint mf-mg-grow mf-mg-wrap" style={{ flexBasis: 200, paddingTop: 9 }} data-testid="requirements-generate-note">
                  {oq ? `${openQuestionsText(oq)} not answered: you can generate now; they are listed in the project's README and REQUIREMENTS-TODO.md.` : "Every question is answered."}
                  {isWso2Target(m) ? " The service joins the build workspace; build, test and deploy it from the steps below." : ` The ${lbl} project is then checked and packaged for download.`}
                </span>
              </div>
            </div>
          </>
        )}
        <div className="mf-mg-row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <span className="mf-mg-small mf-mg-muted">The blank requirement template:</span>
          <TemplateLink id={m.id} />
        </div>
      </div>
    </Panel>
  );
}
