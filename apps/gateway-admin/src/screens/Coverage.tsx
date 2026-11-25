// Coverage matrix: every API on the gateway (migrated services, Studio flows, APIs made directly in
// API Manager) against the eleven policy families.
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { rulesClient, type CoverageRow } from "../api.ts";
import { ErrorState, SegTabs } from "../components/ui.tsx";
import { Loading, Section } from "../components/gw.tsx";
import { PageHeader } from "./PageHeader.tsx";

type F = "all" | "open" | "nolimit" | "nothreat";
const CELL = { covered: { sym: "●", word: "covered", color: "var(--ok)" }, gap: { sym: "○", word: "gap", color: "var(--bad)" }, elsewhere: { sym: "–", word: "handled elsewhere or not applicable", color: "var(--faint)" } } as const;
const KIND: Record<string, string> = { migrated: "Migrated service", flow: "Studio flow", direct: "Made in API Manager" };
const TAB_FOR = ["access", "policies", "policies", "access", "traffic", "policies", "policies", "policies", "policies", "live", "policies"];

export function Coverage() {
  const q = useQuery({ queryKey: ["coverage"], queryFn: rulesClient.coverage });
  const [f, setF] = useState<F>("all");
  const rows = useMemo(() => (q.data?.rows ?? []).filter((r: CoverageRow) => f === "all" || (f === "open" && r.open) || (f === "nolimit" && r.noLimit) || (f === "nothreat" && r.noThreat)), [q.data, f]);
  const fam = q.data?.families ?? [];
  const count = (k: keyof CoverageRow) => (q.data?.rows ?? []).filter((r) => r[k]).length;
  return (
    <>
      <PageHeader area="Coverage" title="Policy coverage" subtitle="Every API on the gateway against the eleven policy families. A gap links straight to where it is fixed." />
      {q.isLoading ? <Loading tiles={0} blocks={1} /> : q.isError || !q.data ? <ErrorState message={(q.error as Error)?.message ?? "Could not load coverage"} onRetry={() => q.refetch()} /> : (
        <Section title={`APIs (${rows.length})`} note={<>● covered · <span style={{ color: "var(--bad)" }}>○ gap</span> · – handled in the service, outside the gateway, or not applicable</>}
          actions={<SegTabs<F> label="Show" value={f} onChange={setF} tabs={[{ id: "all", label: "All", count: q.data.rows.length }, { id: "open", label: "Open APIs", count: count("open") }, { id: "nolimit", label: "No rate limit", count: count("noLimit") }, { id: "nothreat", label: "No threat protection", count: count("noThreat") }]} />}>
          <div className="gw-tablewrap" style={{ overflowX: "auto" }}>
            <table className="gw-table" aria-label="Coverage" style={{ minWidth: 900 }}>
              <thead><tr><th scope="col">API</th>{fam.map((x, i) => <th key={x} scope="col" title={x} style={{ fontSize: 11, textAlign: "center", width: 54 }}>{i + 1}. {x.split(" ")[0]}</th>)}</tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} data-api={r.name}>
                    <td><Link className="gw-link gw-mono" to={`/apis/${r.id}`}>{r.name}</Link><div className="gw-faint" style={{ fontSize: 11.5 }}>{KIND[r.kind]}{r.live ? " · live" : " · not deployed"}</div></td>
                    {r.cells.map((c, i) => (
                      <td key={i} style={{ textAlign: "center" }}>
                        {c === "gap" ? <Link to={`/apis/${r.id}?tab=${TAB_FOR[i]}`} title={`${fam[i]}: gap. Fix it`} aria-label={`${r.name} ${fam[i]} gap`} style={{ color: CELL.gap.color, textDecoration: "none", fontSize: 16 }}>{CELL.gap.sym}</Link>
                          : <span title={`${fam[i]}: ${CELL[c].word}`} aria-label={`${r.name} ${fam[i]} ${CELL[c].word}`} style={{ color: CELL[c].color, fontSize: 16 }}>{CELL[c].sym}</span>}
                      </td>))}
                  </tr>))}
              </tbody>
            </table>
          </div>
          {!rows.length && <p className="gw-note">No API matches this filter.</p>}
        </Section>
      )}
    </>
  );
}
