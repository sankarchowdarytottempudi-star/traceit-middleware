// Edit one generated document (.md) in place. The person's version replaces the generated one and is
// kept when the migration is rebuilt; changes to the mapping table also reach the generated code.
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { RotateCcw, Save } from "lucide-react";
import { api, type ApiError, type DocEdit, type Migration } from "../api.ts";
import { txt } from "../lib/text.ts";
import { dateTime } from "../lib/migrate.ts";
import { Btn, Confirm, Failed, Field, Loading, Notice, Panel, Pill, errText } from "./ui.tsx";

export const editable = (name: string) => /\.(md|markdown)$/i.test(name);
/** The largest document the server takes (2 MB). */
export const DOC_MAX = 2 * 1024 * 1024;

export function editedLabel(e: DocEdit | undefined | null): string {
  if (!e) return "Edited";
  return `Edited${txt(e.by) ? ` by ${txt(e.by)}` : ""}${e.at ? ` on ${dateTime(e.at)}` : ""}`;
}

/** Plain words for a refused save or revert. */
export function saveError(e: ApiError): string {
  if (e.status === 409) return txt(e.body?.error) || "A step of this migration is running. Save your changes when it has finished.";
  if (e.status === 413) return "The document is larger than 2 MB. Make it shorter and save again.";
  if (e.status === 422) {
    const rows = Array.isArray(e.body?.errors) ? (e.body!.errors as { problem?: string; line?: number }[]) : [];
    const head = txt(e.body?.error) || "The document was not accepted.";
    return rows.length ? `${head} ${rows.map((r) => `${r.line ? `Line ${r.line}: ` : ""}${txt(r.problem)}`).join(" ")}` : head;
  }
  return errText(e);
}

export function DocEditor({ m, name, edit, onClose }: { m: Pick<Migration, "id" | "busy" | "queued">; name: string; edit?: DocEdit | null; onClose: () => void }) {
  const qc = useQueryClient();
  const src = useQuery({ queryKey: ["migration-doc-source", m.id, name], queryFn: () => api.docSource(m.id, name), retry: false });
  const [text, setText] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");
  const [done, setDone] = useState("");
  const [askRevert, setAskRevert] = useState(false);
  const [reverting, setReverting] = useState(false);
  const [revertErr, setRevertErr] = useState("");
  // the text follows the server copy whenever that changes (loaded, saved, reverted); typing is kept otherwise
  useEffect(() => { if (src.data !== undefined) setText(src.data); }, [src.data]);
  const busy = !!m.busy || !!m.queued;
  const value = text ?? "";
  const changed = text !== null && src.data !== undefined && text !== src.data;
  const size = new Blob([value]).size;
  const tooBig = size > DOC_MAX;

  const after = () => {
    qc.invalidateQueries({ queryKey: ["migration-doc-edits", m.id] }); qc.invalidateQueries({ queryKey: ["migration-docs", m.id] });
    qc.invalidateQueries({ queryKey: ["migration-doc", m.id, name] }); qc.invalidateQueries({ queryKey: ["migration-doc-source", m.id, name] });
    qc.invalidateQueries({ queryKey: ["migration", m.id] }); qc.invalidateQueries({ queryKey: ["migrations"] });
  };
  const save = () => {
    setErr(""); setDone(""); setSaving(true);
    api.saveDocSource(m.id, name, { text: value, ...(note.trim() ? { note: note.trim().slice(0, 500) } : {}) })
      .then(() => { setDone("Saved. The migration is being rebuilt with your version."); setNote(""); after(); })
      .catch((e: ApiError) => setErr(saveError(e)))
      .finally(() => setSaving(false));
  };
  const revert = () => {
    setRevertErr(""); setReverting(true);
    api.revertDoc(m.id, name)
      .then(() => { setAskRevert(false); setDone("Back to the generated version. The migration is being rebuilt."); after(); })
      .catch((e: ApiError) => setRevertErr(saveError(e)))
      .finally(() => setReverting(false));
  };

  return (
    <Panel title={<span className="mf-mg-wrap">Edit <span className="mf-mono">{name}</span></span>} actions={edit ? <Pill tone="accent">{editedLabel(edit)}</Pill> : undefined}>
      <div className="mf-mg-stack" style={{ gap: 12 }} data-testid="doc-editor">
        {src.isLoading ? <Loading rows={1} h={240} /> : src.isError ? <Failed what="This document cannot be edited right now." error={src.error} onRetry={() => src.refetch()} /> : (
          <>
            <label className="mf-mg-field">
              <span>Document text</span>
              <textarea className="mf-mg-input mf-mono" rows={22} value={value} disabled={busy || saving} spellCheck={false} onChange={(e) => { setText(e.target.value); setDone(""); }}
                style={{ width: "100%", fontSize: 13, minHeight: 260 }} data-testid="doc-editor-text" aria-invalid={tooBig} />
              {tooBig ? <span className="mf-mg-err" role="alert">The document is larger than 2 MB.</span> : null}
            </label>
            <p className="mf-mg-hint mf-mg-wrap" style={{ margin: 0 }} data-testid="doc-editor-explain">
              Your version replaces the generated document and is kept when the migration is rebuilt. Changes to the mapping table are also applied to the generated code.
            </p>
            {edit?.note ? <span className="mf-mg-small mf-mg-muted mf-mg-wrap">Note of the last change: {txt(edit.note)}</span> : null}
            <Field label="What did you change? (optional)">
              <input className="mf-mg-input" value={note} maxLength={500} disabled={busy || saving} onChange={(e) => setNote(e.target.value)} data-testid="doc-editor-note" />
            </Field>
            {busy && <span className="mf-mg-hint mf-mg-wrap" data-testid="doc-editor-busy">A step of this migration is running. Changes can be saved when it has finished.</span>}
            {err && <Notice tone="bad"><span data-testid="doc-editor-error">{err}</span></Notice>}
            {done && <Notice tone="ok"><span data-testid="doc-editor-done">{done}</span></Notice>}
            <div className="mf-mg-actions">
              <Btn kind="primary" icon={<Save size={15} aria-hidden="true" />} disabled={!changed || busy || tooBig} busy={saving} onClick={save} data-testid="doc-editor-save">Save changes</Btn>
              <Btn onClick={onClose} data-testid="doc-editor-cancel">{done ? "Close" : "Cancel"}</Btn>
              {edit && <Btn icon={<RotateCcw size={15} aria-hidden="true" />} disabled={busy || saving} onClick={() => { setRevertErr(""); setAskRevert(true); }} data-testid="doc-editor-revert"
                style={{ minWidth: 0, maxWidth: "100%", whiteSpace: "normal", height: "auto", minHeight: 38, textAlign: "left" }}>Revert to the generated version</Btn>}
            </div>
          </>
        )}
      </div>
      {askRevert && (
        <Confirm title="Go back to the generated version?" confirmLabel="Revert" danger busy={reverting} error={revertErr || undefined} onConfirm={revert} onClose={() => setAskRevert(false)}>
          <span>Your version of <span className="mf-mono">{name}</span> is dropped and the generated document is used again. The migration is rebuilt.</span>
        </Confirm>
      )}
    </Panel>
  );
}
