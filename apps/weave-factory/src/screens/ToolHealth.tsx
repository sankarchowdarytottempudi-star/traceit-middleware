// Tool health: what the migration tool's own corpus run found. Every uploaded project is run through
// the whole pipeline in a sandbox (read, documents, service, addresses, build, tests, item-by-item
// check, closed-room trial). Gaps that would hit other projects are the tool's to fix; decisions only
// the owner can make are listed apart. Names, counts and classes only — no settings values.
import { useQuery } from "@tanstack/react-query";
import { api } from "../api.ts";
import { txt } from "../lib/text.ts";
import { ago } from "../lib/migrate.ts";
import { Empty, Failed, Head, Loading, Panel, Pill, Stat, useTitle } from "../migrate/ui.tsx";

export function ToolHealthPage() {
  useTitle("Tool health");
  const q = useQuery({ queryKey: ["tool-health"], queryFn: () => api.toolHealth(), staleTime: 60000 });
  const d = q.data;
  const projects = d?.projects ?? [];
  const backlog = d?.backlog ?? [];
  const decisions = d?.decisions ?? [];
  const fixed = d?.fixed ?? [];
  const clean = projects.filter((p) => !(p.stops ?? []).some((s) => s.class === "generic")).length;
  return (
    <>
      <Head area="Knowledge base" areaTo="/knowledge" title="Tool health"
        subtitle="Every uploaded project is run through the whole migration in a sandbox: reading, documents, the generated service, addresses, build, unit tests, the item-by-item check and the closed-room trial. Gaps that would hit other projects are the tool's to fix; decisions only you can make are listed apart. Runs every night and when a project is added." />
      {q.isLoading ? <Loading rows={3} h={96} /> : q.isError ? <Failed what="Tool health is not available right now." error={q.error} onRetry={() => q.refetch()} />
        : !d?.ok ? <Empty title="No corpus run has finished yet" hint={txt(d?.error) || "The first run takes about an hour."} /> : (
        <div className="mf-mg-stack" data-testid="tool-health">
          <div className="mf-mg-stats">
            <Stat label="Projects run" value={projects.length} note={d.finished ? `finished ${ago(d.finished)}` : "running"} />
            <Stat label="Without a tool gap" value={clean} />
            <Stat label="Open tool gaps" value={backlog.length} />
            <Stat label="Your decisions" value={decisions.length} />
          </div>
          {fixed.length > 0 && (
            <Panel title="Fixed by the tool">
              <ul className="mf-mg-small mf-mg-wrap" style={{ margin: 0, paddingLeft: 18, lineHeight: 1.6 }} data-testid="th-fixed">
                {fixed.map((f, i) => <li key={i}>{txt(f.gap)}: {f.before} → {f.after}{f.at ? <span className="mf-mg-muted"> · {ago(f.at)}</span> : null}</li>)}
              </ul>
            </Panel>
          )}
          <Panel title="Tool gaps, most widespread first" actions={<Pill tone={backlog.length ? "warn" : "ok"}>{backlog.length ? `${backlog.length} open` : "none"}</Pill>}>
            {backlog.length === 0 ? <span className="mf-mg-small mf-mg-muted">No generic gap found in the last run.</span> : (
              <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 8 }} data-testid="th-backlog">
                {backlog.map((b, i) => (
                  <li key={i} className="mf-mg-small mf-mg-wrap">
                    <Pill tone="muted">{txt(b.stage)}</Pill> <strong>{txt(b.gap)}</strong>
                    <span className="mf-mg-muted"> · {b.projects.length} project{b.projects.length === 1 ? "" : "s"}{b.count > b.projects.length ? `, ${b.count} times` : ""}: {b.projects.slice(0, 8).join(", ")}{b.projects.length > 8 ? " …" : ""}</span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
          <Panel title="Decisions only you can make">
            {decisions.length === 0 ? <span className="mf-mg-small mf-mg-muted">None.</span> : (
              <ul className="mf-mg-small mf-mg-wrap" style={{ margin: 0, paddingLeft: 18, lineHeight: 1.6 }} data-testid="th-decisions">
                {decisions.map((s, i) => <li key={i}><span className="mf-mono">{txt(s.project)}</span>: {txt(s.what)}{s.backend ? <> (<span className="mf-mono">{txt(s.backend)}</span>)</> : null}</li>)}
              </ul>
            )}
          </Panel>
          <Panel title="Per project">
            <div style={{ overflowX: "auto" }}>
              <table className="mf-mg-table" data-testid="th-projects">
                <thead><tr><th>Project</th><th>Operations ported</th><th>Build</th><th>Coverage</th><th>Trial</th><th>Tool gaps</th></tr></thead>
                <tbody>
                  {projects.map((p, i) => {
                    const g = (p.stops ?? []).filter((s) => s.class === "generic").length;
                    return (
                      <tr key={i}>
                        <td className="mf-mono">{txt(p.name) || txt(p.archive)}</td>
                        <td>{p.operations != null ? `${p.ported ?? 0} of ${p.operations}` : "—"}</td>
                        <td>{p.build ? (p.build.rc === 0 ? <Pill tone="ok">compiles</Pill> : <Pill tone="bad">{p.build.errors} error{p.build.errors === 1 ? "" : "s"}</Pill>) : "—"}</td>
                        <td>{p.tests?.coverage != null ? `${Number(p.tests.coverage).toFixed(1)}%` : "—"}</td>
                        <td>{p.trial ? (p.trial.passed ? <Pill tone="ok">passed</Pill> : p.trial.started ? <Pill tone="warn">faults</Pill> : <Pill tone="muted">{p.trial.ran ? "did not start" : "not run"}</Pill>) : "—"}</td>
                        <td>{g ? <Pill tone="warn">{g}</Pill> : <Pill tone="ok">0</Pill>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Panel>
        </div>
      )}
    </>
  );
}
