// Every migration, with its progress. Opens the detail screen; starts a new one.
import { useMemo } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { GitBranch, Plus } from "lucide-react";
import { api, type Migration } from "../api.ts";
import { num, txt } from "../lib/text.ts";
import { ago, distinct, filterMigrations, NOT_FINISHED, outcomeTone, statusLabel } from "../lib/migrate.ts";
import { Bar, Btn, Empty, Failed, Head, LayerPill, LinkBtn, Loading, Pill, SearchBox, Stat, useTitle } from "../migrate/ui.tsx";

const OUTCOMES = ["Deployed", NOT_FINISHED, "Verified", "Complete", "In progress", "Not started", "Failed"];

function MigrationCard({ m }: { m: Migration }) {
  const p = m.progress;
  const outcome = txt(p?.outcome) || "Not started";
  const tone = outcomeTone(outcome);
  const pct = num(p?.overallPercent);
  const now = txt(p?.currentStep), next = txt(p?.nextStep);
  return (
    <Link to={`/migrations/${encodeURIComponent(m.id)}`} className="mf-mg-card mf-in" aria-label={`Open migration ${txt(m.name) || m.id}`}>
      <div className="mf-mg-row" style={{ justifyContent: "space-between", alignItems: "flex-start", flexWrap: "nowrap" }}>
        <div className="mf-mg-grow">
          <div className="mf-mg-name" style={{ fontSize: 15 }}>{txt(m.name) || txt(m.apiName) || m.id}</div>
          {txt(m.apiName) && txt(m.apiName) !== txt(m.name) && <div className="mf-mono mf-mg-small mf-mg-muted mf-mg-wrap">{txt(m.apiName)}</div>}
        </div>
        <Pill tone={tone}>{outcome}</Pill>
      </div>
      <div className="mf-mg-chips">
        {txt(m.layer) && <LayerPill layer={m.layer} />}
        {txt(m.technology) && txt(m.technology) !== "unknown" && <Pill>{txt(m.technology)}</Pill>}
        {txt(m.targetTech) && <Pill title="Target">to {txt(m.targetTech)}</Pill>}
        {m.busy && <Pill tone="accent">A step is running</Pill>}
        {!m.busy && num(m.queued) > 0 && <Pill tone="accent" title="Projects taken from a repository are worked through one after the other">Waiting its turn</Pill>}
      </div>
      <div className="mf-mg-row" style={{ flexWrap: "nowrap" }}>
        <Bar pct={pct} tone={tone === "ok" ? "ok" : tone === "bad" ? "bad" : "accent"} label={`Overall progress of ${txt(m.name) || m.id}`} />
        <span className="mf-mono mf-mg-small" style={{ fontWeight: 700, minWidth: 40, textAlign: "right" }}>{Math.round(pct)}%</span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: `repeat(${Math.max(1, (m.phases ?? []).length)}, minmax(0, 1fr))`, gap: 4 }} aria-hidden="true">
        {(m.phases ?? []).map((ph) => (
          <span key={ph.key} title={`${txt(ph.title)}: ${statusLabel(ph.status)}`} style={{ height: 4, borderRadius: 999, background: ph.status === "done" ? "var(--ok)" : ph.status === "failed" ? "var(--bad)" : ph.status === "running" ? "var(--accent)" : ph.status === "action_required" ? "var(--warn)" : "var(--surface3)" }} />
        ))}
      </div>
      <div className="mf-mg-small mf-mg-muted mf-mg-wrap">
        {txt(p?.majorPhase) && <span>{txt(p?.majorPhase)}</span>}
        {now && <span> · now: {now}</span>}
        {!now && next && <span> · next: {next}</span>}
      </div>
      <div className="mf-mg-row mf-mg-small mf-mg-faint" style={{ justifyContent: "space-between" }}>
        <span className="mf-mg-wrap">{txt(m.workspace) || "No workspace"}</span>
        <span>{m.updatedAt ? `changed ${ago(m.updatedAt)}` : m.createdAt ? `created ${ago(m.createdAt)}` : ""}</span>
      </div>
    </Link>
  );
}

export function Migrations() {
  useTitle("Migrations");
  const [sp, setSp] = useSearchParams();
  const q = sp.get("q") ?? "", workspace = sp.get("workspace") ?? "", outcome = sp.get("outcome") ?? "", technology = sp.get("technology") ?? "";
  const set = (k: string, v: string) => { const n = new URLSearchParams(sp); if (v) n.set(k, v); else n.delete(k); setSp(n, { replace: true }); };
  const list = useQuery({ queryKey: ["migrations"], queryFn: api.migrations, refetchInterval: (query) => ((query.state.data?.migrations ?? []).some((m) => m.busy || num(m.queued) > 0) ? 3000 : 15000) });
  const all = list.data?.migrations ?? [];
  const shown = useMemo(() => filterMigrations(all, { q, workspace, outcome, technology }).sort((a, b) => txt(b.updatedAt || b.createdAt).localeCompare(txt(a.updatedAt || a.createdAt))), [all, q, workspace, outcome, technology]);
  const workspaces = useMemo(() => distinct(all.map((m) => m.workspace)), [all]);
  const technologies = useMemo(() => distinct(all.map((m) => m.technology)), [all]);
  const count = (o: string) => all.filter((m) => txt(m.progress?.outcome) === o).length;
  const newBtn = <LinkBtn kind="primary" to="/migrations/new" icon={<Plus size={16} aria-hidden="true" />}>New migration</LinkBtn>;
  return (
    <>
      <Head area="Migrations" title="Migrations"
        subtitle="Each migration takes one API from its old platform to a running service: read the source, agree the mapping, generate, test and deploy."
        actions={<><LinkBtn to="/migrations/from-git" icon={<GitBranch size={16} aria-hidden="true" />}>From a git repository</LinkBtn>{newBtn}</>} />
      {list.isLoading ? <Loading rows={3} h={120} /> : list.isError ? <Failed what="The migrations are not available right now." error={list.error} onRetry={() => list.refetch()} /> : all.length === 0 ? (
        <Empty title="No migrations yet" hint="Start with the source of one API: a project archive or a written specification." action={newBtn} />
      ) : (
        <>
          <div className="mf-mg-stats">
            <Stat label="Migrations" value={all.length} note={`${workspaces.length} workspace${workspaces.length === 1 ? "" : "s"}`} />
            <Stat label="Deployed and finished" value={count("Deployed") + count("Verified")} note={count(NOT_FINISHED) ? `${count(NOT_FINISHED)} more installed, but not finished` : `${count("Verified")} verified`} />
            <Stat label="In progress" value={all.filter((m) => !["Deployed", NOT_FINISHED, "Verified", "Complete", "Failed"].includes(txt(m.progress?.outcome))).length} note={`${all.filter((m) => m.busy).length} running a step now`} />
            <Stat label="Failed" value={count("Failed")} note={count("Failed") ? "Open one to see why" : "Nothing needs attention"} />
          </div>
          <div className="mf-mg-toolbar">
            <SearchBox value={q} onChange={(v) => set("q", v)} placeholder="Search by name, API or workspace" />
            <select className="mf-mg-input" aria-label="Workspace" value={workspace} onChange={(e) => set("workspace", e.target.value)}>
              <option value="">All workspaces</option>{workspaces.map((w) => <option key={w} value={w}>{w}</option>)}
            </select>
            <select className="mf-mg-input" aria-label="State" value={outcome} onChange={(e) => set("outcome", e.target.value)}>
              <option value="">Any state</option><option value="running">Running a step now</option>{OUTCOMES.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
            <select className="mf-mg-input" aria-label="Source technology" value={technology} onChange={(e) => set("technology", e.target.value)}>
              <option value="">Any source</option>{technologies.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
            <span className="mf-mg-small mf-mg-muted">{shown.length === all.length ? `${all.length} migrations` : `${shown.length} of ${all.length}`}</span>
          </div>
          {shown.length === 0 ? <Empty title="No migration matches these filters" action={<Btn small onClick={() => setSp(new URLSearchParams(), { replace: true })}>Clear filters</Btn>} /> : (
            <div className="mf-mg-grid">{shown.map((m) => <MigrationCard key={m.id} m={m} />)}</div>
          )}
        </>
      )}
    </>
  );
}
