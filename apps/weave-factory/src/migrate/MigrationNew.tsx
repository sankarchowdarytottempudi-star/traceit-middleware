// Start a migration: name it, choose where it belongs, say what the source is, upload it (a project, or one
// source file the server wraps into a project) or paste the code ("Paste code": a partial source).
import { useMemo, useRef, useState, type DragEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ClipboardPaste, FileArchive, Plus, UploadCloud, X } from "lucide-react";
import { api, uploadMigration, type ApiError } from "../api.ts";
import { txt } from "../lib/text.ts";
import { fileSize, pasteNameHint, textBytes, validateNewMigration, validatePaste, type PasteSnippet } from "../lib/migrate.ts";
import { Bar, Btn, Failed, Field, Head, LinkBtn, Loading, Notice, Panel, Pill, SourceWays, errText, useTitle } from "./ui.tsx";
import { NewPartFields, type PartSpec } from "./Part.tsx";

// How complete the generator's writer for a target is (the migration factory's registry; older
// servers send only depth).
type Maturity = "complete" | "complete-unverified" | "partial" | "skeleton";
const MATURITY_WORD: Record<Maturity, string> = { complete: "Complete", "complete-unverified": "Complete (unverified)", partial: "Partial", skeleton: "Skeleton" };
const maturityOf = (t: { depth: string; maturity?: Maturity }): Maturity => t.maturity ?? (t.depth === "full" ? "complete" : t.depth === "partial" ? "partial" : "skeleton");

const NEW = "__new__";
function StepTitle({ n, children }: { n: number; children: string }) {
  return <span className="mf-mg-row" style={{ gap: 10 }}><span className="mf-mg-stepno">{n}</span>{children}</span>;
}

export function MigrationNew({ mode = "upload" }: { mode?: "upload" | "paste" }) {
  const pasting = mode === "paste";
  useTitle(pasting ? "New migration from pasted code" : "New migration");
  const nav = useNavigate();
  const qc = useQueryClient();
  const opts = useQuery({ queryKey: ["migrate-options"], queryFn: api.options, staleTime: 600000 });
  const wss = useQuery({ queryKey: ["workspaces"], queryFn: api.workspaces });
  const existing = useMemo(() => (wss.data?.workspaces ?? []).map((w) => txt(w.name)).filter((n) => n && n !== "Unassigned"), [wss.data]);

  const [name, setName] = useState("");
  const [sp] = useSearchParams();
  const asked = (sp.get("workspace") ?? "").trim();
  const [wsChoice, setWsChoice] = useState<string>("");
  const [wsNew, setWsNew] = useState(asked);
  const [technology, setTechnology] = useState("auto");
  const [snippets, setSnippets] = useState<PasteSnippet[]>([{ name: "", text: "" }]);
  const [creating, setCreating] = useState(false);
  const [target, setTarget] = useState("wso2");
  const [file, setFile] = useState<File | null>(null);
  const [part, setPart] = useState<PartSpec | null>(null);
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
  const tech = opts.data?.technologies.find((t) => t.id === technology);
  const tgt = opts.data?.targets.find((t) => t.id === target);
  const pasteOpts = opts.data?.paste;
  const isSpec = !pasting && tech?.sourceType === "spec";
  // in paste mode the file check does not apply: the pasted pieces are checked instead
  const errors = opts.data ? validateNewMigration({ name, workspace, technology, target, file: pasting ? { name: "pasted.zip", size: 1 } : file ? { name: file.name, size: file.size } : null }, pasting ? { ...opts.data, extensions: [".zip"] } : opts.data) : {};
  const pasteErrors = pasting && pasteOpts ? validatePaste(snippets, pasteOpts) : { pieces: {} as Record<number, string> };
  const show = (k: keyof typeof errors) => (tried ? errors[k] : undefined);
  const uploading = progress !== null || creating;
  const pastedBytes = snippets.reduce((n, s) => n + textBytes(s.text), 0);
  const setSnippet = (i: number, patch: Partial<PasteSnippet>) => setSnippets((list) => list.map((s, k) => (k === i ? { ...s, ...patch } : s)));
  const single = !pasting && !!file && (opts.data?.singleFileExtensions ?? []).includes((/\.[a-z0-9]+$/i.exec(file.name)?.[0] || "").toLowerCase());

  const pick = (f: File | null | undefined) => { if (f) { setFile(f); setError(""); } };
  const onDrop = (e: DragEvent) => { e.preventDefault(); setOver(false); if (!uploading) pick(e.dataTransfer.files?.[0]); };

  const submitPaste = async () => {
    setTried(true); setError("");
    if (!opts.data || !pasteOpts || Object.keys(errors).length || pasteErrors.all || Object.keys(pasteErrors.pieces).length) return;
    setCreating(true);
    try {
      const m = await api.pasteMigration({ name: name.trim(), workspace, target, technology, snippets: snippets.filter((s) => s.text.trim()).map((s) => ({ name: s.name.trim(), text: s.text })) });
      qc.invalidateQueries({ queryKey: ["migrations"] });
      qc.invalidateQueries({ queryKey: ["workspaces"] });
      if (startNow) { try { await api.run(m.id, "document"); } catch { /* the detail screen offers the step again */ } }
      nav(`/migrations/${encodeURIComponent(m.id)}`);
    } catch (e) {
      setError(errText(e));
    } finally { setCreating(false); }
  };

  const submit = async () => {
    if (pasting) return submitPaste();
    setTried(true); setError("");
    if (!opts.data || !file || Object.keys(errors).length) return;
    setProgress(0);
    const up = uploadMigration({ name: name.trim(), workspace, file, sourceType: isSpec ? "spec" : technology === "auto" ? undefined : technology, target, scope: part && !isSpec ? JSON.stringify(part) : undefined }, setProgress);
    abortRef.current = up.abort;
    try {
      const m = await up.promise;
      qc.invalidateQueries({ queryKey: ["migrations"] });
      qc.invalidateQueries({ queryKey: ["workspaces"] });
      if (startNow && !isSpec) { try { await api.run(m.id, "document"); } catch { /* the detail screen offers the step again */ } }
      nav(`/migrations/${encodeURIComponent(m.id)}`);
    } catch (e) {
      setProgress(null);
      if ((e as { aborted?: boolean }).aborted) return;
      const err = e as ApiError;
      setError(err.status === 413 ? `The file is larger than this server accepts (${opts.data.maxUploadMb} MB).` : errText(e));
    } finally { abortRef.current = null; }
  };

  return (
    <>
      <Head area="Migrations" areaTo="/migrations" back={{ to: "/migrations", label: "All migrations" }} title="New migration"
        subtitle={pasting ? "Paste the code of a flow, a script, a service or a process. It is read on this server and documented as a partial source: the documents say what the pasted code cannot show." : "Upload the source of an existing API or integration. It is read on this server, documented, and turned into a service you can test and deploy step by step."} />
      <SourceWays way={pasting ? "paste" : "upload"} />
      {pasting && opts.data && !pasteOpts ? <Notice tone="warn">This server does not accept pasted code yet. Upload the code as a file instead.</Notice> : null}
      {opts.isLoading ? <Loading rows={3} h={120} /> : opts.isError || !opts.data ? <Failed what="The migration options are not available right now." error={opts.error} onRetry={() => opts.refetch()} /> : (
        <form className="mf-mg-wizard" onSubmit={(e) => { e.preventDefault(); void submit(); }} noValidate>
          <Panel title={<StepTitle n={1}>Name it and choose a workspace</StepTitle>}>
            <div className="mf-mg-grid-2" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 260px), 1fr))" }}>
              <Field label="Migration name" error={show("name")} hint="A name people will recognise, for example the name of the API.">
                <input className="mf-mg-input" value={name} maxLength={120} aria-invalid={!!show("name")} onChange={(e) => setName(e.target.value)} disabled={uploading} placeholder="Customer profile API" />
              </Field>
              <Field label="Workspace" error={choice === NEW ? undefined : show("workspace")} hint="A workspace groups the migrations of one programme or team.">
                <select className="mf-mg-input" value={choice} onChange={(e) => setWsChoice(e.target.value)} disabled={uploading}>
                  {existing.map((w) => <option key={w} value={w}>{w}</option>)}
                  <option value={NEW}>New workspace…</option>
                </select>
              </Field>
              {choice === NEW && (
                <Field label="Name of the new workspace" error={show("workspace")} hint="It is created when the migration is uploaded.">
                  <input className="mf-mg-input" value={wsNew} maxLength={80} aria-invalid={!!show("workspace")} onChange={(e) => setWsNew(e.target.value)} disabled={uploading} />
                </Field>
              )}
            </div>
          </Panel>

          <Panel title={<StepTitle n={2}>{pasting ? "What is the pasted code written in?" : "What is the source written in?"}</StepTitle>}>
            {pasting ? (
              <div className="mf-mg-choices" role="radiogroup" aria-label="Technology of the pasted code">
                {(pasteOpts?.technologies ?? []).map((t) => (
                  <button key={t.id} type="button" role="radio" aria-checked={technology === t.id} className="mf-btn mf-mg-choice" disabled={uploading} onClick={() => { setTechnology(t.id); setError(""); }}>
                    <strong>{txt(t.label)}</strong>{t.id === "auto" ? <small>Recognised from the code (Mule XML, DataWeave, flow.xml, Boomi XML, Java, ...)</small> : null}
                  </button>
                ))}
              </div>
            ) : (
            <div className="mf-mg-choices" role="radiogroup" aria-label="Source technology">
              {opts.data.technologies.map((t) => (
                <button key={t.id} type="button" role="radio" aria-checked={technology === t.id} className="mf-btn mf-mg-choice" disabled={uploading} onClick={() => { setTechnology(t.id); setError(""); }}>
                  <strong>{txt(t.label)}</strong><small>{txt(t.upload)}</small>
                </button>
              ))}
            </div>
            )}
            {!pasting && tech?.hint && <Notice>{txt(tech.hint)}</Notice>}
            {!pasting && !isSpec && (technology === "auto" || technology === "node") && <NewPartFields value={part} onChange={setPart} disabled={uploading} />}
          </Panel>

          <Panel title={<StepTitle n={3}>What should it become?</StepTitle>}>
            <div className="mf-mg-choices" role="radiogroup" aria-label="Target">
              {opts.data.targets.map((t) => (
                <button key={t.id} type="button" role="radio" aria-checked={target === t.id} className="mf-btn mf-mg-choice" disabled={uploading} onClick={() => setTarget(t.id)}>
                  <span className="mf-mg-row" style={{ gap: 8, justifyContent: "space-between" }}><strong>{txt(t.label)}</strong><Pill tone={maturityOf(t) === "complete" ? "ok" : undefined}>{MATURITY_WORD[maturityOf(t)]}</Pill></span>
                  <small>{txt(t.hint)}</small>
                </button>
              ))}
            </div>
            {tgt && maturityOf(tgt) === "skeleton" && <Notice tone="warn">For this target the tool writes the documents and a project skeleton. Testing and deployment from this screen are only available for the complete target.</Notice>}
            {tgt && maturityOf(tgt) === "complete-unverified" && <Notice tone="warn">For this target the tool writes a complete project to download. It is format-checked but has not been imported into that product here; import and test it on your own systems.</Notice>}
            {tgt && maturityOf(tgt) === "partial" && <Notice tone="warn">For this target the tool writes a project to download; some steps stay marked placeholders (listed in its parity report). Testing and deployment from this screen are only available for the complete target.</Notice>}
          </Panel>

          {pasting ? (
          <Panel title={<StepTitle n={4}>Paste the code</StepTitle>}>
            <Notice tone="warn">Pasted code is a <strong>partial source</strong>: connection settings, schedules, called services and other parts that are not pasted cannot be known. The documents and the migration are marked "Partial source" and list what a person must supply.</Notice>
            {snippets.map((sn, i) => (
              <div key={i} className="mf-mg-stack" style={{ gap: 8, paddingTop: i ? 12 : 0, borderTop: i ? "1px solid var(--border)" : undefined }}>
                <div className="mf-mg-row" style={{ gap: 8, alignItems: "flex-end" }}>
                  <span className="mf-mg-grow">
                    <Field label={`Piece ${i + 1}: file name (optional)`} hint={pasteNameHint(technology)} error={tried ? pasteErrors.pieces[i] : undefined}>
                      <input className="mf-mg-input mf-mono" value={sn.name} maxLength={120} disabled={uploading} aria-invalid={!!(tried && pasteErrors.pieces[i])} placeholder="flow.xml" onChange={(e) => setSnippet(i, { name: e.target.value })} />
                    </Field>
                  </span>
                  {snippets.length > 1 && !uploading && <button type="button" className="mf-btn mf-mg-btn mf-mg-btn-sm mf-mg-iconbtn" aria-label={`Remove piece ${i + 1}`} onClick={() => setSnippets((l) => l.filter((_, k) => k !== i))}><X size={15} aria-hidden="true" /></button>}
                </div>
                <textarea className="mf-mg-input mf-mono" rows={12} spellCheck={false} value={sn.text} disabled={uploading} aria-label={`Code of piece ${i + 1}`}
                  placeholder="Paste the code here" style={{ fontSize: 12.5, whiteSpace: "pre", overflowX: "auto" }} onChange={(e) => setSnippet(i, { text: e.target.value })} />
                <span className="mf-mg-small mf-mg-muted">{fileSize(textBytes(sn.text))}{pasteOpts ? ` · at most ${pasteOpts.maxSnippetKb} KB` : ""}</span>
              </div>
            ))}
            <div className="mf-mg-row" style={{ gap: 10 }}>
              {pasteOpts && snippets.length < pasteOpts.maxSnippets && <Btn small icon={<Plus size={14} aria-hidden="true" />} disabled={uploading} onClick={() => setSnippets((l) => [...l, { name: "", text: "" }])}>Add another piece</Btn>}
              <span className="mf-mg-grow" />
              <span className="mf-mg-small mf-mg-muted">{snippets.length} piece{snippets.length === 1 ? "" : "s"} · {fileSize(pastedBytes)}{pasteOpts ? ` of ${Math.round(pasteOpts.maxTotalKb / 1024)} MB` : ""}</span>
            </div>
            {tried && pasteErrors.all && <span className="mf-mg-err" role="alert">{pasteErrors.all}</span>}
            <span className="mf-mg-hint">Each piece becomes a file of a minimal project of its technology (for example src/main/mule/ for Mule, a package with flow.xml and node.ndf for webMethods), with a PASTED.txt note listing the pieces. The code stays on this server.</span>
            <label className="mf-mg-check" style={{ whiteSpace: "normal" }}><input type="checkbox" checked={startNow} disabled={uploading} onChange={(e) => setStartNow(e.target.checked)} />Read the code and write the documents as soon as the migration is created</label>
          </Panel>
          ) : (
          <Panel title={<StepTitle n={4}>Upload the source</StepTitle>}>
            <input ref={input} type="file" hidden accept={opts.data.extensions.join(",")} onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ""; }} />
            {file ? (
              <div className="mf-mg-file">
                <FileArchive size={22} color="var(--accentText)" aria-hidden="true" />
                <span className="mf-mg-grow"><span className="mf-mono mf-mg-wrap" style={{ fontSize: 13.5, fontWeight: 600, display: "block" }}>{file.name}</span><span className="mf-mg-small mf-mg-muted">{fileSize(file.size)}</span></span>
                {!uploading && <><Btn small onClick={() => input.current?.click()}>Choose another</Btn><button type="button" className="mf-btn mf-mg-btn mf-mg-btn-sm mf-mg-iconbtn" aria-label="Remove the file" onClick={() => setFile(null)}><X size={15} aria-hidden="true" /></button></>}
              </div>
            ) : (
              <div className={`mf-mg-drop${over ? " mf-mg-drop-on" : ""}`} role="button" tabIndex={0} aria-label="Choose the file to upload"
                onClick={() => input.current?.click()} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.current?.click(); } }}
                onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={onDrop}>
                <UploadCloud size={28} color="var(--accentText)" aria-hidden="true" />
                <strong style={{ fontSize: 14.5 }}>Drop the file here, or choose it</strong>
                <span className="mf-mg-small mf-mg-muted">{txt(tech?.upload) || "A .zip or .jar of the project"} · up to {opts.data.maxUploadMb} MB</span>
              </div>
            )}
            {show("file") && <span className="mf-mg-err" role="alert">{show("file")}</span>}
            {single && <Notice tone="warn">One source file is wrapped into a minimal project on the server and read as a <strong>partial source</strong>: the documents list what the file cannot show (connections, schedules, called services, ...).</Notice>}
            <span className="mf-mg-hint">To upload a folder, compress it into a .zip first. One source file{opts.data.singleFileExtensions?.length ? ` (${opts.data.singleFileExtensions.join(" ")}, up to ${opts.data.singleFileMb ?? 10} MB)` : ""} is accepted as it is. Integration files (TIBCO .bwp, BizTalk .btm, SSIS .dtsx, XSLT .xsl, SAP CPI .iflw, Logic App or Step Functions .json) are read whole. A .zip may hold several APIs of different technologies: each one becomes its own migration. The file stays on this server: it is read here and is not sent anywhere else.</span>
            {!isSpec && <label className="mf-mg-check" style={{ whiteSpace: "normal" }}><input type="checkbox" checked={startNow} disabled={uploading} onChange={(e) => setStartNow(e.target.checked)} />Read the source and write the documents as soon as the upload finishes</label>}
          </Panel>
          )}

          {creating && <Panel><div className="mf-mg-row"><strong style={{ fontSize: 14 }}>Creating the migration from the pasted code…</strong></div></Panel>}
          {progress !== null && (
            <Panel>
              <div className="mf-mg-row"><strong style={{ fontSize: 14 }}>{progress! >= 1 ? "Upload finished, creating the migration…" : "Uploading…"}</strong><span className="mf-mg-grow" /><span className="mf-mono mf-mg-small">{Math.round(progress! * 100)}%</span></div>
              <div className="mf-mg-row"><Bar pct={progress! * 100} large label="Upload progress" /></div>
            </Panel>
          )}
          {error && <Notice tone="bad"><strong>The migration was not created.</strong> {error}</Notice>}
          {tried && (Object.keys(errors).length > 0 || (pasting && (pasteErrors.all || Object.keys(pasteErrors.pieces).length > 0))) && !uploading && <Notice tone="warn">Some answers above still need attention.</Notice>}
          <div className="mf-mg-actions">
            {progress !== null ? <Btn onClick={() => abortRef.current?.()}>Cancel the upload</Btn> : <>
              {pasting
                ? <Btn kind="primary" type="submit" busy={creating} disabled={!pasteOpts} icon={<ClipboardPaste size={16} aria-hidden="true" />}>Create the migration from the pasted code</Btn>
                : <Btn kind="primary" type="submit" icon={<UploadCloud size={16} aria-hidden="true" />}>Upload and create the migration</Btn>}
              <LinkBtn to="/migrations">Cancel</LinkBtn>
            </>}
          </div>
        </form>
      )}
    </>
  );
}
