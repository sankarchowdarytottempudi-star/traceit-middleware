// Lessons recorded from reviewer feedback. They are applied when later migrations are generated.
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api, type Lesson } from "../api.ts";
import { txt } from "../lib/text.ts";
import { ago, distinct } from "../lib/migrate.ts";
import { Btn, Empty, Failed, Head, Loading, Pill, SearchBox, Stat, useTitle } from "../migrate/ui.tsx";

const SCOPE_LABEL: Record<string, string> = { functional: "Every workspace", workspace: "This workspace", api: "This API" };
const scopeTone = (s: string) => (s === "functional" ? "ok" : s === "workspace" ? "sys" : undefined) as "ok" | "sys" | undefined;

export function Knowledge() {
  useTitle("Knowledge base");
  const k = useQuery({ queryKey: ["knowledge"], queryFn: api.knowledge });
  const [q, setQ] = useState(""); const [scope, setScope] = useState(""); const [tech, setTech] = useState(""); const [status, setStatus] = useState("");
  const lessons: Lesson[] = k.data?.feedback ?? [];
  const techs = useMemo(() => distinct(lessons.map((l) => l.technology)), [lessons]);
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return lessons.filter((l) => {
      if (scope && txt(l.scope) !== scope) return false;
      if (tech && txt(l.technology) !== tech) return false;
      if (status && (txt(l.status) || "open") !== status) return false;
      if (!needle) return true;
      return [l.summary, l.apiName, l.workspace, l.phase, l.docType, ...(l.mistakes ?? [])].some((v) => txt(v).toLowerCase().includes(needle));
    }).sort((a, b) => txt(b.createdAt).localeCompare(txt(a.createdAt)));
  }, [lessons, q, scope, tech, status]);
  const clear = () => { setQ(""); setScope(""); setTech(""); setStatus(""); };
  return (
    <>
      <Head area="Knowledge base" title="Knowledge base"
        subtitle="What reviewers taught the migration tool. A lesson marked for every workspace is applied to all later migrations; workspace and API lessons stay where they were written. Add a lesson from the Feedback tab of a migration." />
      {k.isLoading ? <Loading rows={3} h={96} /> : k.isError ? <Failed what="The knowledge base is not available right now." error={k.error} onRetry={() => k.refetch()} /> : lessons.length === 0 ? (
        <Empty title="No lessons yet" hint="Open a migration and use its Feedback tab to record what should be done differently next time." />
      ) : (
        <>
          <div className="mf-mg-stats">
            <Stat label="Lessons" value={lessons.length} />
            <Stat label="For every workspace" value={lessons.filter((l) => l.scope === "functional").length} />
            <Stat label="Already applied" value={lessons.filter((l) => l.status === "applied").length} note="Used in at least one later migration" />
          </div>
          <div className="mf-mg-toolbar">
            <SearchBox value={q} onChange={setQ} placeholder="Search the lessons" />
            <select className="mf-mg-input" aria-label="Applies to" value={scope} onChange={(e) => setScope(e.target.value)}>
              <option value="">Any reach</option><option value="functional">Every workspace</option><option value="workspace">One workspace</option><option value="api">One API</option>
            </select>
            <select className="mf-mg-input" aria-label="Source technology" value={tech} onChange={(e) => setTech(e.target.value)}>
              <option value="">Any source</option>{techs.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
            <select className="mf-mg-input" aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">Open and applied</option><option value="open">Open</option><option value="applied">Applied</option>
            </select>
            <span className="mf-mg-small mf-mg-muted">{shown.length === lessons.length ? `${lessons.length} lessons` : `${shown.length} of ${lessons.length}`}</span>
          </div>
          {shown.length === 0 ? <Empty title="No lesson matches these filters" action={<Btn small onClick={clear}>Clear filters</Btn>} /> : (
            <div className="mf-mg-stack" style={{ gap: 12 }}>
              {shown.map((l) => (
                <article key={l.id} className="mf-mg-card mf-in">
                  <div className="mf-mg-chips">
                    <Pill tone={scopeTone(txt(l.scope))}>{SCOPE_LABEL[txt(l.scope)] ?? txt(l.scope)}</Pill>
                    {txt(l.technology) && <Pill>{txt(l.technology)}</Pill>}
                    {txt(l.phase) && <Pill>{txt(l.phase)}</Pill>}
                    <Pill tone={l.status === "applied" ? "ok" : undefined}>{l.status === "applied" ? `Applied${(l.appliedIn ?? []).length ? ` in ${(l.appliedIn ?? []).length}` : ""}` : "Open"}</Pill>
                  </div>
                  <p className="mf-mg-wrap" style={{ margin: 0, fontSize: 14.5, fontWeight: 600, lineHeight: 1.45 }}>{txt(l.summary)}</p>
                  {(l.mistakes ?? []).length > 0 && (
                    <ul className="mf-mg-muted mf-mg-wrap" style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.5 }}>
                      {(l.mistakes ?? []).map((m, i) => <li key={i}>{txt(m)}</li>)}
                    </ul>
                  )}
                  <div className="mf-mg-row mf-mg-small mf-mg-faint">
                    {txt(l.apiName) && (l.migrationId ? <Link className="mf-mono mf-mg-name mf-mg-small" to={`/migrations/${encodeURIComponent(txt(l.migrationId))}?tab=feedback`}>{txt(l.apiName)}</Link> : <span className="mf-mono">{txt(l.apiName)}</span>)}
                    {txt(l.workspace) && <span>{txt(l.workspace)}</span>}
                    {l.createdAt && <span>{ago(l.createdAt)}</span>}
                  </div>
                </article>
              ))}
            </div>
          )}
        </>
      )}
    </>
  );
}
