// A project for another platform: it is not installed here. The customer imports the package file
// into the platform (Workato refuses the whole project zip: "'testcases' is not a supported asset
// type"); the project zip with documents, tests and settings is the second, separate download.
import { useState } from "react";
import { Download, PackageCheck } from "lucide-react";
import { api, type Migration } from "../api.ts";
import { txt } from "../lib/text.ts";
import { isWso2Target, targetLabel, targetOf } from "../lib/migrate.ts";
import { Btn, Notice, Panel, Pill, errText } from "./ui.tsx";

/** Platforms whose generator writes one file to import; others show it only when the tool found one. */
const PACKAGED = new Set(["workato", "webmethods", "boomi"]);

export function hasPackage(m: Migration): boolean {
  return !isWso2Target(m) && !!m.serviceDir && (!!m.packageFile || PACKAGED.has(targetOf(m)));
}

export function packageLabel(m: Migration): string {
  return targetOf(m) === "workato" ? "Workato import package (.zip) — import this file in Workato" : `${targetLabel(m)} package (.zip)`;
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
          This migration produces a {lbl} project. It is not installed here: {pkg ? `import the package into ${lbl}` : `download it and install it on your own ${lbl} servers`}. README.md says how; TODO.md lists the steps a person still has to finish; SETTINGS.md lists the values to set; TEST-CASES.md has the tests.
        </p>
        {ready?.detail ? <Notice tone={txt(ready.status) === "done" ? "ok" : "warn"}>{txt(ready.detail)}</Notice> : null}
        {pkg && (
          <div className="mf-mg-actions">
            <Btn kind="primary" data-testid="delivery-package" icon={<PackageCheck size={15} aria-hidden="true" />} busy={getting} onClick={getPackage}
              style={{ minWidth: 0, whiteSpace: "normal", height: "auto", minHeight: 38, padding: "8px 14px", textAlign: "left" }}>{packageLabel(m)}</Btn>
          </div>
        )}
        {err && <Notice tone="bad"><span data-testid="delivery-package-error">{err}</span></Notice>}
        <div className="mf-mg-row" style={{ gap: 8, alignItems: "center" }}>
          <a className="mf-btn mf-mg-btn" href={api.projectUrl(m.id)} download data-testid="delivery-project" style={{ minWidth: 0, whiteSpace: "normal", height: "auto", minHeight: 38 }}>
            <Download size={15} aria-hidden="true" />Download the {lbl} project (.zip)
          </a>
          {pkg && <span className="mf-mg-hint mf-mg-wrap" data-testid="delivery-project-note">documents, tests and settings — not for importing</span>}
        </div>
      </div>
    </Panel>
  );
}
