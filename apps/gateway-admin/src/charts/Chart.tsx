// One hand-drawn SVG chart for the whole console: stacked columns, lines and grouped columns.
// No chart library and nothing loaded from the network. Colours come from the --c* tokens in styles.css.
import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { Table2, ChartColumn } from "lucide-react";
import { niceScale, axisCount, axisMs, timeTicks, topRoundedRect, mergeBuckets, type RangeKey } from "./scale.ts";
import { fmtInt, fmtMs, fmtClock, fmtDay, fmtDateTime } from "../lib/text.ts";

export interface Series { key: string; label: string; color: string; values: (number | null)[]; }
export type ChartKind = "stack" | "line" | "group";
export interface ChartProps {
  kind: ChartKind;
  series: Series[];
  unit: "count" | "ms";
  ariaLabel: string;
  /** Time charts: the start of every bucket (epoch ms), its length and the selected range. */
  times?: number[]; stepSeconds?: number; range?: RangeKey;
  /** Category charts: one label per bucket. */
  categories?: string[];
  height?: number;
  emptyText?: string;
}

export function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current; if (!el) return;
    setW(el.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

const fmtValue = (unit: "count" | "ms", v: number | null): string => (v == null ? "—" : unit === "ms" ? fmtMs(v) : fmtInt(v));

function bucketLabel(t: number, stepSeconds: number, span: number): string {
  const len = stepSeconds * span;
  if (len <= 60) return fmtDateTime(t);
  if (len >= 86400) return `${fmtDay(t)} to ${fmtDay(t + len * 1000 - 1)}`;
  return `${fmtDateTime(t)} to ${fmtClock(t + len * 1000)}`;
}

export function Legend({ series, line }: { series: { key: string; label: string; color: string }[]; line?: boolean }) {
  return (
    <ul className="gw-legend">
      {series.map((s) => <li key={s.key}><span className={`gw-swatch ${line ? "gw-swatch-line" : ""}`} style={{ background: s.color }} aria-hidden="true" />{s.label}</li>)}
    </ul>
  );
}

export function Chart(p: ChartProps) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const [byKeys, setByKeys] = useState(false);
  const H = p.height ?? 220;
  const n0 = p.times?.length ?? p.categories?.length ?? 0;

  const g = useMemo(() => {
    const W = Math.max(width, 120);
    const top = 10, bottom = 24, right = 10;
    // Columns narrower than 4px cannot be read: add neighbouring buckets together until they can.
    const k = p.kind === "stack" && p.times && n0 > 0 ? Math.max(1, Math.ceil(4 / ((W - 54) / n0))) : 1;
    const series = p.series.map((s) => ({ ...s, values: mergeBuckets(s.values.slice(0, n0), k) }));
    const n = k > 1 ? Math.ceil(n0 / k) : n0;
    let max = 0; let total = 0;
    for (let i = 0; i < n; i++) {
      let sum = 0;
      for (const s of series) { const v = s.values[i]; if (v != null && Number.isFinite(v)) { sum += v; if (p.kind !== "stack") max = Math.max(max, v); } }
      if (p.kind === "stack") max = Math.max(max, sum);
      total += sum;
    }
    const scale = niceScale(max, { integer: p.unit === "count" });
    const yText = (v: number) => (p.unit === "ms" ? axisMs(v, scale.max) : axisCount(v, scale.max));
    const left = Math.min(70, Math.max(26, Math.max(...scale.ticks.map((t) => yText(t).length)) * 6.4 + 10));
    const plotW = Math.max(10, W - left - right), plotH = H - top - bottom;
    const bw = n > 0 ? plotW / n : plotW;
    const y = (v: number) => top + plotH * (1 - Math.min(1, v / scale.max));
    const cx = (i: number) => left + (i + 0.5) * bw;
    let xt: { x: number; label: string }[] = [];
    if (p.times && n0 > 0) {
      const dayLabels = p.range === "7d" || p.range === "30d";
      xt = timeTicks(p.times, p.range ?? "1h", W >= 560, dayLabels ? fmtDay : fmtClock).map((t) => ({ x: left + ((t.i + 0.5) / n0) * plotW, label: t.label }));
    } else if (p.categories) {
      const every = Math.max(1, Math.ceil(52 / bw));
      xt = p.categories.map((c, i) => ({ x: cx(i), label: c, i })).filter((c) => c.i % every === 0);
    }
    const heads: string[] = [];
    for (let i = 0; i < n; i++) heads.push(p.times ? bucketLabel(p.times[i * k], p.stepSeconds ?? 60, k) : (p.categories?.[i] ?? ""));
    return { W, top, bottom, right, left, plotW, plotH, bw, n, k, series, scale, yText, y, cx, xt, heads, total };
  }, [width, p.kind, p.series, p.times, p.categories, p.unit, p.range, p.stepSeconds, n0, H]);

  const at = hover != null && hover < g.n ? hover : null;
  const pick = (e: PointerEvent<SVGRectElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const i = Math.floor(((e.clientX - box.left) / Math.max(1, box.width)) * g.n);
    setByKeys(false); setHover(Math.max(0, Math.min(g.n - 1, i)));
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!g.n) return;
    const cur = at ?? g.n - 1;
    let next: number | null = null;
    if (e.key === "ArrowRight") next = Math.min(g.n - 1, at == null ? cur : cur + 1);
    else if (e.key === "ArrowLeft") next = Math.max(0, cur - 1);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = g.n - 1;
    else if (e.key === "Escape") { setHover(null); return; }
    if (next != null) { e.preventDefault(); setByKeys(true); setHover(next); }
  };

  const marks: ReactNode[] = [];
  if (p.kind === "stack") {
    const barW = Math.max(1.5, Math.min(24, g.bw - 2));
    for (let i = 0; i < g.n; i++) {
      const x = g.cx(i) - barW / 2;
      let topIdx = -1;
      g.series.forEach((s, si) => { if ((s.values[i] ?? 0) > 0) topIdx = si; });
      let acc = 0;
      g.series.forEach((s, si) => {
        const v = s.values[i] ?? 0; if (!(v > 0)) return;
        let y1 = g.y(acc + v); const y0 = g.y(acc); acc += v;
        if (y0 - y1 < 1.5) y1 = y0 - 1.5;                      // a single request stays visible
        if (si !== topIdx && y0 - y1 > 4) y1 += 2;              // 2px of surface between stacked segments
        marks.push(si === topIdx
          ? <path key={`${s.key}-${i}`} d={topRoundedRect(x, y1, barW, y0 - y1, 4)} fill={s.color} />
          : <rect key={`${s.key}-${i}`} x={x} y={y1} width={barW} height={y0 - y1} fill={s.color} />);
      });
    }
  } else if (p.kind === "group") {
    const m = Math.max(1, g.series.length);
    const inner = Math.max(m * 2, Math.min(g.bw - Math.min(10, g.bw * 0.25), m * 24 + (m - 1) * 2));
    const barW = (inner - (m - 1) * 2) / m;
    for (let i = 0; i < g.n; i++) {
      g.series.forEach((s, si) => {
        const v = s.values[i] ?? 0; if (!(v > 0)) return;
        const x = g.cx(i) - inner / 2 + si * (barW + 2);
        let y1 = g.y(v); const y0 = g.y(0); if (y0 - y1 < 1.5) y1 = y0 - 1.5;
        marks.push(<path key={`${s.key}-${i}`} d={topRoundedRect(x, y1, barW, y0 - y1, 4)} fill={s.color} />);
      });
    }
  } else {
    g.series.forEach((s) => {
      let d = ""; let open = false;
      for (let i = 0; i < g.n; i++) {
        const v = s.values[i];
        if (v == null || !Number.isFinite(v)) { open = false; continue; }
        d += `${open ? "L" : "M"}${g.cx(i).toFixed(1)},${g.y(v).toFixed(1)}`; open = true;
        const alone = (i === 0 || s.values[i - 1] == null) && (i === g.n - 1 || s.values[i + 1] == null);
        if (alone) marks.push(<circle key={`${s.key}-dot-${i}`} cx={g.cx(i)} cy={g.y(v)} r={3} fill={s.color} stroke="var(--surface)" strokeWidth={1} />);
      }
      if (d) marks.unshift(<path key={`${s.key}-line`} d={d} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />);
    });
  }

  const tipRows = at == null ? [] : g.series.map((s) => ({ key: s.key, label: s.label, color: s.color, v: s.values[at] }));
  const tipTotal = at != null && p.kind === "stack" && g.series.length > 1 ? tipRows.reduce((a, r) => a + (r.v ?? 0), 0) : null;
  const tipLeft = at != null && g.cx(at) < g.W / 2;
  const spoken = at == null ? "" : `${g.heads[at]}: ${tipRows.map((r) => `${r.label} ${fmtValue(p.unit, r.v)}`).join(", ")}`;

  return (
    <div>
      {p.series.length >= 2 && <Legend series={p.series} line={p.kind === "line"} />}
      <div ref={ref} className="gw-chart" role="group" tabIndex={0} aria-label={`${p.ariaLabel}. Use the left and right arrow keys to read the values.`}
        onKeyDown={onKey} onBlur={() => setHover(null)} style={{ height: H }}>
        {width > 0 && (
          <svg width={g.W} height={H} viewBox={`0 0 ${g.W} ${H}`} aria-hidden="true">
            {g.scale.ticks.map((t) => (
              <g key={t}>
                <line x1={g.left} x2={g.W - g.right} y1={g.y(t)} y2={g.y(t)} stroke={t === 0 ? "var(--cAxis)" : "var(--cGrid)"} strokeWidth={1} shapeRendering="crispEdges" />
                <text x={g.left - 8} y={g.y(t) + 4} textAnchor="end">{g.yText(t)}</text>
              </g>
            ))}
            {g.xt.map((t, i) => {
              const anchor = t.x < g.left + 18 ? "start" : t.x > g.W - g.right - 18 ? "end" : "middle";
              return <text key={i} x={anchor === "start" ? g.left : anchor === "end" ? g.W - g.right : t.x} y={H - 6} textAnchor={anchor}>{t.label}</text>;
            })}
            {at != null && p.kind !== "line" && <rect x={g.left + at * g.bw} y={g.top} width={g.bw} height={g.plotH} fill="var(--text)" opacity={0.07} />}
            {at != null && p.kind === "line" && <line x1={g.cx(at)} x2={g.cx(at)} y1={g.top} y2={g.top + g.plotH} stroke="var(--cAxis)" strokeWidth={1} />}
            {marks}
            {at != null && p.kind === "line" && g.series.map((s) => {
              const v = s.values[at];
              return v == null ? null : <circle key={s.key} cx={g.cx(at)} cy={g.y(v)} r={4.5} fill={s.color} stroke="var(--surface)" strokeWidth={2} />;
            })}
            <rect x={g.left} y={g.top} width={g.plotW} height={g.plotH} fill="transparent"
              onPointerMove={pick} onPointerDown={pick} onPointerLeave={() => setHover(null)} />
          </svg>
        )}
        {width > 0 && g.total === 0 && <div className="gw-chart-empty">{p.emptyText ?? "No requests in this period"}</div>}
        {at != null && (
          <div className="gw-tip" style={tipLeft ? { left: Math.min(g.W - 160, g.cx(at) + 14) } : { right: Math.min(g.W - 160, g.W - g.cx(at) + 14) }}>
            <div className="gw-tip-head">{g.heads[at]}</div>
            {tipRows.map((r) => (
              <div className="gw-tip-row" key={r.key}>
                <span className={`gw-swatch ${p.kind === "line" ? "gw-swatch-line" : ""}`} style={{ background: r.color }} />
                <strong>{fmtValue(p.unit, r.v)}</strong><span className="gw-tip-l">{r.label}</span>
              </div>
            ))}
            {tipTotal != null && <div className="gw-tip-row" style={{ borderTop: "1px solid var(--border)", marginTop: 4, paddingTop: 3 }}><span className="gw-swatch" style={{ background: "transparent" }} /><strong>{fmtInt(tipTotal)}</strong><span className="gw-tip-l">Total</span></div>}
          </div>
        )}
        <span className="mf-sr" aria-live="polite">{byKeys ? spoken : ""}</span>
      </div>
    </div>
  );
}

/** A chart in a card, with the same numbers one click away as a table. */
export function ChartCard({ title, note, chart }: { title: string; note?: ReactNode; chart: ChartProps }) {
  const [asTable, setAsTable] = useState(false);
  const n = chart.times?.length ?? chart.categories?.length ?? 0;
  const rows: { head: string; vals: (number | null)[] }[] = [];
  if (asTable) {
    for (let i = 0; i < n; i++) {
      const vals = chart.series.map((s) => s.values[i] ?? null);
      if (chart.times && !vals.some((v) => v != null && v !== 0)) continue;
      rows.push({ head: chart.times ? bucketLabel(chart.times[i], chart.stepSeconds ?? 60, 1) : (chart.categories?.[i] ?? ""), vals });
    }
  }
  return (
    <section className="gw-card" aria-label={title}>
      <div className="gw-cardhead">
        <div><h2>{title}</h2>{note && <p className="gw-note">{note}</p>}</div>
        <button type="button" className="gw-btn gw-btn-sm" aria-pressed={asTable} onClick={() => setAsTable((v) => !v)}>
          {asTable ? <ChartColumn size={14} aria-hidden="true" /> : <Table2 size={14} aria-hidden="true" />}{asTable ? "Chart" : "Table"}
        </button>
      </div>
      {!asTable ? <Chart {...chart} /> : (
        <div className="gw-scrollbox" tabIndex={0} role="region" aria-label={`${title}, as a table`} style={{ maxHeight: (chart.height ?? 220) + 30 }}>
          <table className="gw-table">
            <thead><tr><th scope="col">{chart.times ? "Time" : "Bucket"}</th>{chart.series.map((s) => <th key={s.key} scope="col" className="gw-num">{s.label}</th>)}</tr></thead>
            <tbody>
              {rows.length === 0 && <tr><td colSpan={chart.series.length + 1} className="gw-muted">{chart.emptyText ?? "No requests in this period"}</td></tr>}
              {rows.map((r) => <tr key={r.head}><td>{r.head}</td>{r.vals.map((v, i) => <td key={i} className="gw-num">{fmtValue(chart.unit, v)}</td>)}</tr>)}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** Ranked horizontal bars: label and figure on one line, a thin single-colour bar underneath. */
export interface BarItem { key: string; label: ReactNode; value: number; display: ReactNode; color?: string; }
export function BarList({ items, max, empty }: { items: BarItem[]; max?: number; empty?: string }) {
  const top = max ?? Math.max(0, ...items.map((i) => i.value));
  if (!items.length) return <p className="gw-note" style={{ margin: 0 }}>{empty ?? "Nothing to show for this period."}</p>;
  return (
    <ul className="gw-barlist">
      {items.map((it) => (
        <li key={it.key}>
          <div className="gw-barrow"><span>{it.label}</span><span>{it.display}</span></div>
          <div className="gw-track" aria-hidden="true"><div className="gw-fill" style={{ width: `${top > 0 ? Math.max(0, Math.min(100, (it.value / top) * 100)) : 0}%`, background: it.color ?? "var(--c1)", minWidth: it.value > 0 ? 2 : 0 }} /></div>
        </li>
      ))}
    </ul>
  );
}

/** One thin bar split into parts, with every part named and counted underneath. */
export function SegBar({ parts, total }: { parts: { key: string; label: string; value: number; color: string }[]; total?: number }) {
  const sum = total ?? parts.reduce((a, p) => a + p.value, 0);
  const shown = parts.filter((p) => p.value > 0);
  return (
    <div>
      <div className="gw-segbar" aria-hidden="true">{shown.map((p) => <span key={p.key} style={{ flex: `${p.value} 1 0`, background: p.color }} />)}</div>
      <ul className="gw-legend" style={{ margin: "10px 0 0", gap: "6px 18px" }}>
        {parts.map((p) => (
          <li key={p.key}><span className="gw-swatch" style={{ background: p.color }} aria-hidden="true" /><span>{p.label}</span>
            <strong style={{ color: "var(--text)", fontVariantNumeric: "tabular-nums" }}>{fmtInt(p.value)}</strong>
            <span className="gw-faint">{sum > 0 ? `${Math.round((p.value / sum) * 1000) / 10}%` : "0%"}</span></li>
        ))}
      </ul>
    </div>
  );
}

/** A tiny column trend for table rows. Decorative: the row already carries the numbers. */
export function Spark({ values, width = 84, height = 22 }: { values: number[]; width?: number; height?: number }) {
  const n = Math.max(1, Math.ceil(values.length / 28));
  const v = mergeBuckets(values, n).map((x) => x ?? 0);
  const max = Math.max(0, ...v);
  if (!v.length || max === 0) return <span className="gw-faint" aria-hidden="true">—</span>;
  const bw = width / v.length; const w = Math.max(1, bw - 1);
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true" style={{ display: "block" }}>
      <line x1={0} x2={width} y1={height - 0.5} y2={height - 0.5} stroke="var(--cAxis)" strokeWidth={1} />
      {v.map((x, i) => (x > 0 ? <rect key={i} x={i * bw + (bw - w) / 2} y={height - 1 - Math.max(1.5, (x / max) * (height - 3))} width={w} height={Math.max(1.5, (x / max) * (height - 3))} fill="var(--c1)" /> : null))}
    </svg>
  );
}
