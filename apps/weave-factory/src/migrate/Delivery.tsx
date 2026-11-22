// A project for another platform: it is not installed here. The customer imports the package file
// into the platform (Workato refuses the whole project zip: "'testcases' is not a supported asset
// type"); the project zip with documents, tests and settings is the second, separate download.
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, PackageCheck, UploadCloud } from "lucide-react";
import { api, type ApiError, type ImportResult, type Migration } from "../api.ts";
import { num, txt } from "../lib/text.ts";
import { dateTime, isWso2Target, targetLabel, targetOf } from "../lib/migrate.ts";
import { Btn, Notice, Panel, Pill, errText } from "./ui.tsx";

/** Platforms whose generator writes one file to import; others show it only when the tool found one. */
const PACKAGED = new Set(["workato", "webmethods", "boomi"]);

export function hasPackage(m: Migration): boolean {
  return !isWso2Target(m) && !!m.serviceDir && (!!m.packageFile || PACKAGED.has(targetOf(m)));
}

export function packageLabel(m: Migration): string {
  return targetOf(m) === "workato" ? "Workato import package (.zip)" : `${targetLabel(m)} package (.zip)`;
}

// fetched first, so "there is no package" is said in words instead of being saved as a file
async function saveFrom(url: string, fallback: string) {
  const r = await fetch(url, { credentials: "include" });
  if (!r.ok) {
    let detail = "";
    try { const p = await r.json(); detail = p.error ?? ""; } catch { /* ignore */ }
    throw Object.assign(new Error(detail || `The package is not available right now (${r.status}).`), { status: r.status });
  }
  const name = (/filename="([^"]+)"/.exec(r.headers.get("content-disposition") || "") || [])[1] || fallback;
  const href = URL.createObjectURL(await r.blob());
  const a = document.createElement("a");
  a.href = href; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 30000);
}

/** Platforms the finished project can be imported into straight from here (with a saved account). */
export const IMPORTABLE = new Set(["boomi", "workato"]);
export const canImport = (m: Migration): boolean => IMPORTABLE.has(targetOf(m)) && !!m.serviceDir;

/** The last import in one line, and the tone it is shown in. */
export function importStatus(r: ImportResult | null | undefined, label: string): { text: string; tone: "ok" | "warn" | "bad" } | null {
  if (!r || !r.status) return null;
  const created = num(r.created), total = num(r.total);
  const where = `${label}${txt(r.folder) ? ` folder ${txt(r.folder)}` : ""}`;
  const when = r.at ? ` (${dateTime(r.at)})` : "";
  if (r.status === "imported") return { tone: "ok", text: `Imported ${created} of ${total} components into ${where}.${when}` };
  if (r.status === "partial") return { tone: "warn", text: `Imported ${created} of ${total} components into ${where}. ${total - created || (r.failures ?? []).length} could not be imported.${when}` };
  return { tone: "bad", text: `Nothing was imported into ${label}.${when}` };
}

function ImportSection({ m }: { m: Migration }) {
  const qc = useQueryClient();
  const lbl = targetLabel(m);
  const accounts = useQuery({ queryKey: ["target-accounts"], queryFn: api.targetAccounts, retry: false, staleTime: 30000 });
  const account = (accounts.data ?? []).find((a) => a.target === targetOf(m));
  // the tool also says on the migration whether an account is set up (when the account list is not available)
  const noAccount = accounts.isSuccess ? !account?.configured : m.import?.accountConfigured === false;
  const autoNow = !!(m.autoImport ?? m.import?.autoImport);
  const [auto, setAuto] = useState(autoNow);
  useEffect(() => setAuto(autoNow), [autoNow]);
  const [starting, setStarting] = useState(false);
  const [started, setStarted] = useState("");
  const [err, setErr] = useState("");
  const [autoErr, setAutoErr] = useState("");
  const [savingAuto, setSavingAuto] = useState(false);
  const phase = (m.phases || []).find((p) => p.key === "import");
  const importing = txt(m.import?.status) === "running" || txt(phase?.status) === "running";
  const busy = !!m.busy || !!m.queued;
  const result = m.importResult ?? m.import?.result ?? null;
  const status = importStatus(result, lbl);
  const failures = result?.failures ?? [];
  const refresh = () => { qc.invalidateQueries({ queryKey: ["migration", m.id] }); qc.invalidateQueries({ queryKey: ["migrations"] }); };
  const start = () => {
    setErr(""); setStarted(""); setStarting(true);
    api.importNow(m.id)
      .then((r) => { setStarted(txt(r?.message) || `The import into ${lbl} has started. This page shows the result when it is done.`); refresh(); })
      .catch((e: ApiError) => setErr(e.status === 409 ? (txt(e.body?.error) || "A step of this migration is running. Import when it has finished.") : errText(e)))
      .finally(() => setStarting(false));
  };
  const toggle = (on: boolean) => {
    setAutoErr(""); setAuto(on); setSavingAuto(true);
    api.setMigrationOptions(m.id, { autoImport: on })
      .then(refresh)
      .catch((e: ApiError) => { setAuto(!on); setAutoErr(errText(e)); })
      .finally(() => setSavingAuto(false));
  };
  return (
    <div className="mf-mg-sec" data-testid="delivery-import">
      <h3>Import into {lbl}</h3>
      <p className="mf-mg-small mf-mg-wrap" style={{ margin: 0, lineHeight: 1.5 }}>
        Put the components of this project straight into your {lbl} account, in a folder of their own.
      </p>
      {noAccount && (
        <Notice tone="warn"><span className="mf-mg-wrap" data-testid="delivery-import-noaccount">No {lbl} account is set up yet. Add it under <Link to="/workspaces#target-platforms">Workspaces &gt; Target platforms</Link>, then import from here.</span></Notice>
      )}
      <div className="mf-mg-actions">
        <Btn kind="primary" icon={<UploadCloud size={15} aria-hidden="true" />} disabled={noAccount || busy || importing} busy={starting} onClick={start} data-testid="delivery-import-now">Import now</Btn>
        <label className="mf-mg-check mf-mg-check-wrap">
          <input type="checkbox" checked={auto} disabled={savingAuto || (noAccount && !auto)} onChange={(e) => toggle(e.target.checked)} data-testid="delivery-import-auto" />
          <span>Import automatically after each build</span>
        </label>
      </div>
      {importing && <span className="mf-mg-hint mf-mg-wrap" data-testid="delivery-import-running">Importing into {lbl}. This page updates by itself.</span>}
      {!importing && busy && <span className="mf-mg-hint mf-mg-wrap">A step of this migration is running. Import when it has finished.</span>}
      {autoErr && <Notice tone="bad"><span data-testid="delivery-import-auto-error">{autoErr}</span></Notice>}
      {err && <Notice tone="bad"><span className="mf-mg-wrap" data-testid="delivery-import-error">{err}</span></Notice>}
      {started && !err && <Notice tone="ok"><span className="mf-mg-wrap" data-testid="delivery-import-started">{started}</span></Notice>}
      {status && (
        <Notice tone={status.tone}>
          <span className="mf-mg-wrap" data-testid="delivery-import-status">{status.text}</span>
          {failures.length > 0 && (
            <ul className="mf-mg-small mf-mg-wrap" data-testid="delivery-import-failures" style={{ margin: "6px 0 0", paddingLeft: 18, lineHeight: 1.5 }}>
              {failures.map((f, i) => <li key={i}><strong>{txt(f.component) || txt(f.file) || "A component"}</strong>{txt(f.file) && txt(f.component) ? <span className="mf-mono"> ({txt(f.file)})</span> : null}: {txt(f.reason) || `${lbl} gave no reason.`}</li>)}
            </ul>
          )}
        </Notice>
      )}
      <span className="mf-mg-hint mf-mg-wrap" data-testid="delivery-import-note">Nothing is deployed or switched on: schedules and listeners stay off.</span>
    </div>
  );
}

export function Delivery({ m }: { m: Migration }) {
  const [getting, setGetting] = useState(false);
  const [err, setErr] = useState("");
  if (isWso2Target(m) || !m.serviceDir) return null;
  const lbl = targetLabel(m);
  const step = (ph: string, st: string) => (m.phases || []).find((p) => p.key === ph)?.steps?.find((s: { key: string }) => s.key === st) as { status?: string; detail?: string } | undefined;
  const ready = step("test", "ready"), image = step("deploy", "image");
  const packed = txt(image?.status) === "done";
  const pkg = hasPackage(m);
  const getPackage = () => {
    setErr(""); setGetting(true);
    saveFrom(api.packageUrl(m.id), txt(m.packageFile) || `${m.id}-package.zip`).catch((e) => setErr(errText(e))).finally(() => setGetting(false));
  };
  return (
    <Panel title={`Your ${lbl} project`} actions={<Pill tone={packed ? "ok" : "muted"}>{packed ? "Ready to download" : "Not checked yet"}</Pill>}>
      <div className="mf-mg-stack" style={{ gap: 10 }} data-testid="delivery">
        <p className="mf-mg-sub mf-mg-wrap" style={{ fontSize: 13.5, margin: 0 }}>
          {m.sourceType === "requirements" ? `This service, built from requirements, is a ${lbl} project.` : `This migration produces a ${lbl} project.`} It is not installed here: {pkg ? `import the package into ${lbl}` : `download it and install it on your own ${lbl} servers`}. {targetOf(m) === "workato"
            ? "README.md says how; PARITY.md (section \"TODO and approximated steps\") lists the steps a person still has to finish; manual-assets/ lists the connections and settings to create; tests/ has the test cases."
            : "README.md says how; TODO.md lists the steps a person still has to finish; SETTINGS.md lists the values to set; TEST-CASES.md has the tests."}
        </p>
        {m.sourceType === "requirements" && <span className="mf-mg-hint mf-mg-wrap" data-testid="delivery-requirements-note">REQUIREMENTS-TODO.md lists the rules kept as TODO and the open questions that are not answered.</span>}
        {ready?.detail ? <Notice tone={txt(ready.status) === "done" ? "ok" : "warn"}>{txt(ready.detail)}</Notice> : null}
        {pkg && (
          <div className="mf-mg-actions">
            <Btn kind="primary" data-testid="delivery-package" icon={<PackageCheck size={15} aria-hidden="true" />} busy={getting} onClick={getPackage}
              style={{ minWidth: 0, maxWidth: "100%", whiteSpace: "normal", height: "auto", minHeight: 38, padding: "8px 14px", textAlign: "left" }}>{packageLabel(m)}</Btn>
            <span className="mf-mg-hint mf-mg-wrap" data-testid="delivery-package-note">{targetOf(m) === "workato"
              ? "Import this file in Workato (Tools > Recipe lifecycle management > Import package)."
              : `Import this file into ${targetLabel(m)}.`}</span>
          </div>
        )}
        {err && <Notice tone="bad"><span data-testid="delivery-package-error">{err}</span></Notice>}
        <div className="mf-mg-row" style={{ gap: 8, alignItems: "center" }}>
          <a className="mf-btn mf-mg-btn" href={api.projectUrl(m.id)} download data-testid="delivery-project" style={{ minWidth: 0, whiteSpace: "normal", height: "auto", minHeight: 38 }}>
            <Download size={15} aria-hidden="true" />Download the {lbl} project (.zip)
          </a>
          {pkg && <span className="mf-mg-hint mf-mg-wrap" data-testid="delivery-project-note">documents, tests and settings — not for importing</span>}
        </div>
        {canImport(m) && <ImportSection m={m} />}
      </div>
    </Panel>
  );
}
