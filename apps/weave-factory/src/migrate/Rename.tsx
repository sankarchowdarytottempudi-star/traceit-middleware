// Give the API of a migration its own name. Two migrations of one source produce the same API name;
// instead of replacing what the other migration produced, the person can choose another name. The
// source is then read and the project generated again under that name; corrections, document edits
// and decisions made under the old name are copied to the new one.
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { PenLine } from "lucide-react";
import { api, type ApiError, type Migration } from "../api.ts";
import { txt } from "../lib/text.ts";
import { targetOf } from "../lib/migrate.ts";
import { Btn, Dialog, Field, Notice, errText } from "./ui.tsx";

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

export function nameProblem(name: string): string {
  const n = name.trim();
  if (!n) return "Type a name.";
  if (!NAME_RE.test(n) || n.endsWith(".")) return "Use letters, digits, - _ or . only (no spaces or slashes), starting with a letter or digit, at most 80 characters.";
  return "";
}

/** A name to start from: the current one with the target platform added (never the current name itself). */
export function suggestName(m: Pick<Migration, "apiName" | "targetTech">): string {
  const base = (txt(m.apiName) || "api").replace(/[^A-Za-z0-9._-]/g, "_").replace(/^[^A-Za-z0-9]+/, "").slice(0, 60) || "api";
  const t = targetOf(m).replace(/[^A-Za-z0-9]/g, "");
  const s = base.toLowerCase().endsWith(`_${t}`) ? `${base}_2` : `${base}_${t}`;
  return s.slice(0, 80);
}

/** Whether the API of this migration can get another name (its name does not come from requirements, a spec or a checked package). */
export function renamable(m: Pick<Migration, "checkOnly" | "sourceType" | "sourceFile" | "apiName">): boolean {
  return !!m.apiName && !!m.sourceFile && !m.checkOnly && m.sourceType !== "requirements" && m.sourceType !== "spec";
}

function useRename(m: Migration, onDone: (message: string) => void) {
  const qc = useQueryClient();
  return useMutation<{ ok?: boolean; message?: string; apiName?: string }, ApiError, string>({
    mutationFn: (name) => api.renameApi(m.id, name.trim()),
    onSuccess: (r) => {
      for (const k of [["migration", m.id], ["migrations"], ["migration-docs", m.id], ["migration-doc-edits", m.id], ["workspaces"]]) qc.invalidateQueries({ queryKey: k });
      onDone(txt(r.message) || "Renamed. The documents and the project are being generated again under the new name.");
    },
  });
}

function NameInput({ value, onChange, error, disabled }: { value: string; onChange: (v: string) => void; error?: string; disabled?: boolean }) {
  return (
    <Field label="New API name" error={error} hint="The documents, the project and the package get this name. The other migration is not changed.">
      <input className="mf-mg-input mf-mono" value={value} disabled={disabled} maxLength={80} onChange={(e) => onChange(e.target.value)} data-testid="rename-input" aria-label="New API name" autoComplete="off" spellCheck={false} />
    </Field>
  );
}

/** "This API name is already in use": replace the other migration's API, or give this one its own name. */
export function NameInUse({ m, text, busy, onReplace, onClose, onRenamed }: { m: Migration; text: string; busy?: boolean; onReplace: () => void; onClose: () => void; onRenamed: (message: string) => void }) {
  const can = renamable(m);
  const [name, setName] = useState(() => suggestName(m));
  const [tried, setTried] = useState(false);
  const rn = useRename(m, onRenamed);
  const problem = nameProblem(name) || (name.trim() === txt(m.apiName) ? "This is the name already in use. Choose another one." : "");
  const submit = () => { setTried(true); if (!problem) rn.mutate(name); };
  return (
    <Dialog title="This API name is already in use" onClose={onClose}
      footer={<><Btn onClick={onClose}>Cancel</Btn><Btn kind="danger" busy={busy} disabled={rn.isPending} onClick={onReplace} data-testid="replace-it">Replace it</Btn></>}>
      <div className="mf-mg-stack" style={{ gap: 10, fontSize: 14, lineHeight: 1.55 }} data-testid="name-in-use">
        <span>{text}</span>
        <span className="mf-mg-muted">Replacing overwrites what the other migration produced under that name.</span>
        {can && (
          <div className="mf-mg-stack" style={{ gap: 8, borderTop: "1px solid var(--border)", paddingTop: 12 }} data-testid="rename-choice">
            <strong>Or keep both: give this migration's API its own name</strong>
            <NameInput value={name} onChange={setName} error={tried ? problem : undefined} disabled={rn.isPending} />
            <div className="mf-mg-row"><Btn kind="primary" icon={<PenLine size={14} aria-hidden="true" />} busy={rn.isPending} disabled={!!busy} onClick={submit} data-testid="rename-submit">Use this name and generate</Btn></div>
            {rn.isError && <Notice tone="bad">{errText(rn.error)}</Notice>}
          </div>
        )}
      </div>
    </Dialog>
  );
}

/** "Rename the API" at any time (header of a migration). */
export function RenameDialog({ m, onClose, onRenamed }: { m: Migration; onClose: () => void; onRenamed: (message: string) => void }) {
  const [name, setName] = useState(() => suggestName(m));
  const [tried, setTried] = useState(false);
  const rn = useRename(m, onRenamed);
  const problem = nameProblem(name) || (name.trim() === txt(m.apiName) ? "This is the current name. Choose another one." : "");
  const submit = () => { setTried(true); if (!problem) rn.mutate(name); };
  return (
    <Dialog title="Rename the API" onClose={onClose}
      footer={<><Btn onClick={onClose}>Cancel</Btn><Btn kind="primary" busy={rn.isPending} disabled={!!m.busy} onClick={submit} data-testid="rename-submit">Rename and generate again</Btn></>}>
      <div className="mf-mg-stack" style={{ gap: 10, fontSize: 14, lineHeight: 1.55 }} data-testid="rename-dialog">
        <span>Now called <span className="mf-mono">{txt(m.apiName)}</span>. The source is read and the project generated again under the new name. Your corrections, document edits and answered decisions are copied to it.</span>
        <NameInput value={name} onChange={setName} error={tried ? problem : undefined} disabled={rn.isPending} />
        {m.busy ? <Notice tone="warn">A step is running. Rename when it has finished.</Notice> : null}
        {rn.isError && <Notice tone="bad">{errText(rn.error)}</Notice>}
      </div>
    </Dialog>
  );
}
