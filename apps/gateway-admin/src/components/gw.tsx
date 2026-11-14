// Shared pieces of the observe screens (APIs, analytics, gateway analytics, logs).
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { RefreshCw, AlertTriangle, Info, CircleCheck, CircleX, CirclePause, CircleHelp } from "lucide-react";
import { SegTabs } from "./ui.tsx";
import { ago } from "../lib/text.ts";

export function Tile({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return <div className="gw-tile"><span className="gw-tile-label">{label}</span><span className="gw-tile-value">{value}</span>{hint ? <span className="gw-tile-hint">{hint}</span> : null}</div>;
}

export function Section({ title, note, actions, children }: { title: string; note?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="gw-card" aria-label={title}>
      <div className="gw-cardhead"><div style={{ minWidth: 0 }}><h2>{title}</h2>{note ? <p className="gw-note">{note}</p> : null}</div>{actions}</div>
      {children}
    </section>
  );
}

export type Tone = "ok" | "warn" | "bad" | "sys" | "proc" | "exp" | "accent" | "plain";
export function Chip({ tone = "plain", children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return <span className={`gw-chip ${tone === "plain" ? "" : `gw-chip-${tone}`}`} title={title}>{children}</span>;
}

export function Banner({ tone = "info", children }: { tone?: "info" | "warn" | "bad"; children: ReactNode }) {
  return (
    <div className={`gw-banner ${tone === "warn" ? "gw-banner-warn" : tone === "bad" ? "gw-banner-bad" : ""}`} role={tone === "info" ? "note" : "alert"}>
      {tone === "info" ? <Info size={17} aria-hidden="true" /> : <AlertTriangle size={17} aria-hidden="true" />}
      <div style={{ minWidth: 0 }}>{children}</div>
    </div>
  );
}

const HEALTH: Record<string, { word: string; color: string; icon: typeof CircleCheck }> = {
  healthy: { word: "Healthy", color: "var(--ok)", icon: CircleCheck },
  degraded: { word: "Degraded", color: "var(--warn)", icon: AlertTriangle },
  down: { word: "Down", color: "var(--bad)", icon: CircleX },
  stopped: { word: "Stopped", color: "var(--muted)", icon: CirclePause },
  unknown: { word: "Unknown", color: "var(--muted)", icon: CircleHelp },
};
export function HealthWord({ state }: { state: string }) {
  const h = HEALTH[state] ?? HEALTH.unknown;
  return <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontWeight: 600, color: h.color }}><h.icon size={15} aria-hidden="true" />{h.word}</span>;
}

/** A value kept in the address bar, so a view can be bookmarked and shared. */
export function useParam<T extends string>(key: string, fallback: T, allowed?: readonly T[]): [T, (v: T) => void] {
  const [sp, setSp] = useSearchParams();
  const raw = sp.get(key);
  const value = raw != null && (!allowed || (allowed as readonly string[]).includes(raw)) ? (raw as T) : fallback;
  const set = useCallback((v: T) => setSp((prev) => {
    const n = new URLSearchParams(prev);
    if (v === fallback || v === "") n.delete(key); else n.set(key, v);
    return n;
  }, { replace: true }), [key, fallback, setSp]);
  return [value, set];
}

export function RangeTabs<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: readonly T[] }) {
  return <SegTabs label="Time range" tabs={options.map((o) => ({ id: o, label: o }))} value={value} onChange={onChange} />;
}
export const RANGE_WORDS: Record<string, string> = { "15m": "last 15 minutes", "1h": "last hour", "6h": "last 6 hours", "24h": "last 24 hours", "7d": "last 7 days", "30d": "last 30 days" };

export function useNow(everyMs = 5000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), everyMs); return () => clearInterval(id); }, [everyMs]);
  return now;
}

/** Auto-refresh is on by default and the choice is remembered on this device. */
export function useAutoRefresh(): [boolean, (v: boolean) => void] {
  const [on, setOn] = useState<boolean>(() => { try { return localStorage.getItem("gw.autoRefresh") !== "off"; } catch { return true; } });
  const set = useCallback((v: boolean) => { setOn(v); try { localStorage.setItem("gw.autoRefresh", v ? "on" : "off"); } catch { /* private window */ } }, []);
  return [on, set];
}

export function LiveBar({ auto, setAuto, updatedAt, fetching, onRefresh, everySeconds }: { auto: boolean; setAuto: (v: boolean) => void; updatedAt: number; fetching: boolean; onRefresh: () => void; everySeconds: number }) {
  const now = useNow(5000);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
      <span className="gw-faint" style={{ fontSize: 12.5 }}>{updatedAt ? `Updated ${ago(updatedAt, now)}` : "Loading"}</span>
      <button type="button" className="gw-btn" aria-pressed={auto} onClick={() => setAuto(!auto)} title={`Refreshes every ${everySeconds} seconds while on`}>Auto-refresh {auto ? "on" : "off"}</button>
      <button type="button" className="gw-iconbtn" style={{ width: 36, height: 36 }} aria-label="Refresh now" onClick={onRefresh}><RefreshCw size={15} className={fetching ? "mf-spin" : undefined} aria-hidden="true" /></button>
    </div>
  );
}

export interface Col<T> { key: string; label: string; num?: boolean; lead?: boolean; render: (row: T) => ReactNode; }
export function DataTable<T>({ cols, rows, rowKey, onRow, empty, label }: { cols: Col<T>[]; rows: T[]; rowKey: (row: T, i: number) => string; onRow?: (row: T) => void; empty: string; label: string }) {
  if (!rows.length) return <p className="gw-note" style={{ margin: 0 }}>{empty}</p>;
  return (
    <div className="gw-tablewrap">
      <table className="gw-table gw-stack" aria-label={label}>
        <thead><tr>{cols.map((c) => <th key={c.key} scope="col" className={c.num ? "gw-num" : undefined}>{c.label}</th>)}</tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={rowKey(r, i)} className={onRow ? "gw-click" : undefined} onClick={onRow ? () => onRow(r) : undefined}>
              {cols.map((c) => <td key={c.key} data-label={c.label} className={[c.num ? "gw-num" : "", c.lead ? "gw-lead" : ""].join(" ").trim() || undefined}>{c.render(r)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Loading({ tiles = 4, blocks = 2 }: { tiles?: number; blocks?: number }) {
  return (
    <div aria-busy="true" aria-label="Loading" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div className="gw-tiles">{Array.from({ length: tiles }, (_, i) => <div key={i} className="mf-shim" style={{ height: 86, borderRadius: 14, border: "1px solid var(--border)", background: "var(--surface2)" }} />)}</div>
      {Array.from({ length: blocks }, (_, i) => <div key={i} className="mf-shim" style={{ height: 240, borderRadius: 16, border: "1px solid var(--border)", background: "var(--surface2)" }} />)}
    </div>
  );
}

export function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => { const id = setTimeout(() => setV(value), ms); return () => clearTimeout(id); }, [value, ms]);
  return v;
}

export async function copyText(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* fall through to the old way */ }
  try {
    const ta = document.createElement("textarea");
    ta.value = text; ta.setAttribute("readonly", ""); ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch { return false; }
}
