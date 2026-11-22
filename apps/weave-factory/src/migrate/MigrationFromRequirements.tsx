// "From requirements": a new service from a requirement document (no source code). The factory reads the document
// on this server into a draft spec whose every item cites the sentence it came from; anything unclear becomes an
// open question. The person reviews it in a workbook before anything is generated.
import { useMemo, useRef, useState, type DragEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, FileText, UploadCloud, X } from "lucide-react";
import { api, requirementsWorkbook, uploadMigration, type ApiError } from "../api.ts";
import { txt } from "../lib/text.ts";
import { REQUIREMENT_EXTENSIONS, fileSize, validateRequirementsForm } from "../lib/migrate.ts";
import { Bar, Btn, Failed, Field, Head, LinkBtn, Loading, Notice, Panel, Pill, SourceWays, errText, useTitle } from "./ui.tsx";

const NEW = "__new__";
function StepTitle({ n, children }: { n: number; children: string }) {
  return <span className="mf-mg-row" style={{ gap: 10 }}><span className="mf-mg-stepno">{n}</span>{children}</span>;
}

/** Saves a workbook fetched first, so a refusal is said in words instead of being saved as a file. */
export function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

export function TemplateLink({ id }: { id?: string }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const get = () => {
    setErr(""); setBusy(true);
    requirementsWorkbook(id ?? null, "template").then(({ blob, filename }) => saveBlob(blob, filename)).catch((e: ApiError) => setErr(errText(e))).finally(() => setBusy(false));
  };
  return (
    <span className="mf-mg-stack" style={{ gap: 6 }}>
      <span><Btn small data-testid="requirements-template" icon={<Download size={14} aria-hidden="true" />} busy={busy} onClick={get}>Download the template (.xlsx)</Btn></span>
      {err && <span className="mf-mg-err" role="alert" data-testid="requirements-template-error">{err}</span>}
    </span>
  );
}

export function MigrationFromRequirements() {
  useTitle("New service from requirements");
  const nav = useNavigate();
  const qc = useQueryClient();
  const opts = useQuery({ queryKey: ["migrate-options"], queryFn: api.options, staleTime: 600000 });
  const wss = useQuery({ queryKey: ["workspaces"], queryFn: api.workspaces });
  const existing = useMemo(() => (wss.data?.workspaces ?? []).map((w) => txt(w.name)).filter((n) => n && n !== "Unassigned"), [wss.data]);
  const [sp] = useSearchParams();
  const asked = (sp.get("workspace") ?? "").trim();
  const [name, setName] = useState("");
  const [wsChoice, setWsChoice] = useState("");
  const [wsNew, setWsNew] = useState(asked);
  const [target, setTarget] = useState("workato");
  const [file, setFile] = useState<File | null>(null);
  const [startNow, setStartNow] = useState(true);
  const [tried, setTried] = useState(false);
  const [over, setOver] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState("");
  const abortRef = useRef<(() => void) | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const askedNew = !!asked && !existing.includes(asked);
  const choice = wsChoice || (asked ? (askedNew ? NEW : asked) : existing.length ? existing[0] : NEW);
  const workspace = choice === NEW ? wsNew.trim() : choice;
  const exts = opts.data?.requirements?.extensions ?? REQUIREMENT_EXTENSIONS;
  const maxMb = opts.data?.requirements?.maxMb ?? Math.min(opts.data?.maxUploadMb ?? 25, 25);
  const targets = opts.data?.targets ?? [];
  const chosen = targets.some((t) => t.id === target) ? target : targets[0]?.id ?? "workato";
  const errors = validateRequirementsForm({ name, workspace, file: file ? { name: file.name, size: file.size } : null }, maxMb, exts);
  const show = (k: keyof typeof errors) => (tried ? errors[k] : undefined);
  const uploading = progress !== null;
  const pick = (f: File | null | undefined) => { if (f) { setFile(f); setError(""); } };
  const onDrop = (e: DragEvent) => { e.preventDefault(); setOver(false); if (!uploading) pick(e.dataTransfer.files?.[0]); };

  const submit = async () => {
    setTried(true); setError("");
    if (!opts.data || !file || Object.keys(errors).length) return;
    setProgress(0);
    const up = uploadMigration({ name: name.trim(), workspace, file, sourceType: "requirements", target: chosen }, setProgress);
    abortRef.current = up.abort;
    try {
      const m = await up.promise;
      qc.invalidateQueries({ queryKey: ["migrations"] });
      qc.invalidateQueries({ queryKey: ["workspaces"] });
      if (startNow) { try { await api.run(m.id, "document"); } catch { /* the migration page offers the step again */ } }
      nav(`/migrations/${encodeURIComponent(m.id)}`);
    } catch (e) {
      setProgress(null);
      if ((e as { aborted?: boolean }).aborted) return;
      const err = e as ApiError;
      setError(err.status === 413 ? `The document is larger than this server accepts (${maxMb} MB).` : errText(e));
    } finally { abortRef.current = null; }
  };

  return (
    <>
      <Head area="Migrations" areaTo="/migrations" back={{ to: "/migrations", label: "All migrations" }} title="New service from requirements"
        subtitle="Upload a requirement document. A draft of the service is read from it for you to review; nothing is generated before you have seen it." />
      <SourceWays way="requirements" />
      {opts.isLoading ? <Loading rows={3} h={120} /> : opts.isError || !opts.data ? <Failed what="The options are not available right now." error={opts.error} onRetry={() => opts.refetch()} /> : (
        <form className="mf-mg-wizard" onSubmit={(e) => { e.preventDefault(); void submit(); }} noValidate data-testid="requirements-new">
          <Panel title="How it works">
            <ul className="mf-mg-small mf-mg-wrap" style={{ margin: 0, paddingLeft: 18, lineHeight: 1.6 }} data-testid="requirements-explain">
              <li>We read the document on this server. It is not sent anywhere else.</li>
              <li>Every item we take from it cites the sentence it came from.</li>
              <li>Anything unclear becomes a question for you. Nothing is invented.</li>
              <li>You review the draft in a workbook before anything is generated.</li>
            </ul>
          </Panel>

          <Panel title={<StepTitle n={1}>Name it and choose a workspace</StepTitle>}>
            <div className="mf-mg-grid-2" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 260px), 1fr))" }}>
              <Field label="Name" error={show("name")} hint="A name people will recognise, for example the name of the integration.">
                <input className="mf-mg-input" data-testid="requirements-name" value={name} maxLength={120} aria-invalid={!!show("name")} onChange={(e) => setName(e.target.value)} disabled={uploading} placeholder="Order intake" />
              </Field>
              <Field label="Workspace" error={choice === NEW ? undefined : show("workspace")} hint="A workspace groups the work of one programme or team.">
                <select className="mf-mg-input" value={choice} onChange={(e) => setWsChoice(e.target.value)} disabled={uploading}>
                  {existing.map((w) => <option key={w} value={w}>{w}</option>)}
                  <option value={NEW}>New workspace…</option>
                </select>
              </Field>
              {choice === NEW && (
                <Field label="Name of the new workspace" error={show("workspace")} hint="It is created with this service.">
                  <input className="mf-mg-input" data-testid="requirements-workspace" value={wsNew} maxLength={80} aria-invalid={!!show("workspace")} onChange={(e) => setWsNew(e.target.value)} disabled={uploading} />
                </Field>
              )}
            </div>
          </Panel>

          <Panel title={<StepTitle n={2}>What should it become?</StepTitle>}>
            <div className="mf-mg-choices" role="radiogroup" aria-label="Target">
              {targets.map((t) => (
                <button key={t.id} type="button" role="radio" aria-checked={chosen === t.id} className="mf-btn mf-mg-choice" disabled={uploading} onClick={() => setTarget(t.id)}>
                  <span className="mf-mg-row" style={{ gap: 8, justifyContent: "space-between" }}><strong>{txt(t.label)}</strong>{t.id === "workato" ? <Pill tone="accent">First choice</Pill> : null}</span>
                  {t.hint ? <small>{txt(t.hint)}</small> : null}
                </button>
              ))}
            </div>
          </Panel>

          <Panel title={<StepTitle n={3}>Upload the requirement document</StepTitle>}>
            <input ref={input} type="file" hidden accept={exts.join(",")} data-testid="requirements-file" onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ""; }} />
            {file ? (
              <div className="mf-mg-file">
                <FileText size={22} color="var(--accentText)" aria-hidden="true" />
                <span className="mf-mg-grow" style={{ minWidth: 0 }}><span className="mf-mono mf-mg-wrap" style={{ fontSize: 13.5, fontWeight: 600, display: "block" }} data-testid="requirements-file-name">{file.name}</span><span className="mf-mg-small mf-mg-muted">{fileSize(file.size)}</span></span>
                {!uploading && <><Btn small onClick={() => input.current?.click()}>Choose another</Btn><button type="button" className="mf-btn mf-mg-btn mf-mg-btn-sm mf-mg-iconbtn" aria-label="Remove the file" onClick={() => setFile(null)}><X size={15} aria-hidden="true" /></button></>}
              </div>
            ) : (
              <div className={`mf-mg-drop${over ? " mf-mg-drop-on" : ""}`} role="button" tabIndex={0} aria-label="Choose the requirement document"
                onClick={() => input.current?.click()} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.current?.click(); } }}
                onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={onDrop}>
                <UploadCloud size={28} color="var(--accentText)" aria-hidden="true" />
                <strong style={{ fontSize: 14.5 }}>Drop the document here, or choose it</strong>
                <span className="mf-mg-small mf-mg-muted">{exts.join(" ")} · up to {maxMb} MB</span>
              </div>
            )}
            {show("file") && <span className="mf-mg-err" role="alert" data-testid="requirements-file-error">{show("file")}</span>}
            <span className="mf-mg-hint mf-mg-wrap">A PDF must hold text: a scanned PDF cannot be read (upload a .docx or .md copy instead). Do not put passwords or keys in the document; anything that looks like one is masked.</span>
            <div className="mf-mg-sec" style={{ marginTop: 4 }}>
              <h3>No document yet?</h3>
              <span className="mf-mg-hint mf-mg-wrap" style={{ display: "block", marginBottom: 8 }}>The template has one sheet for each kind of item (operations, triggers, systems, fields, rules, errors). Filled in, it is read exactly, one item per row.</span>
              <TemplateLink />
            </div>
            <label className="mf-mg-check" style={{ whiteSpace: "normal" }}><input type="checkbox" checked={startNow} disabled={uploading} onChange={(e) => setStartNow(e.target.checked)} />Read the document as soon as the upload finishes</label>
          </Panel>

          {progress !== null && (
            <Panel>
              <div className="mf-mg-row"><strong style={{ fontSize: 14 }}>{progress >= 1 ? "Upload finished, creating…" : "Uploading…"}</strong><span className="mf-mg-grow" /><span className="mf-mono mf-mg-small">{Math.round(progress * 100)}%</span></div>
              <div className="mf-mg-row"><Bar pct={progress * 100} large label="Upload progress" /></div>
            </Panel>
          )}
          {error && <Notice tone="bad"><strong>It was not created.</strong> <span data-testid="requirements-new-error">{error}</span></Notice>}
          {tried && Object.keys(errors).length > 0 && !uploading && <Notice tone="warn">Some answers above still need attention.</Notice>}
          <div className="mf-mg-actions">
            {progress !== null ? <Btn onClick={() => abortRef.current?.()}>Cancel the upload</Btn> : <>
              <Btn kind="primary" type="submit" data-testid="requirements-create" icon={<UploadCloud size={16} aria-hidden="true" />}>Upload and read the requirements</Btn>
              <LinkBtn to="/migrations">Cancel</LinkBtn>
            </>}
          </div>
        </form>
      )}
    </>
  );
}
