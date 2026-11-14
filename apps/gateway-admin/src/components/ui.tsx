import { useEffect, useRef, useState, type ReactNode } from "react";
import { motion, AnimatePresence } from "motion/react";

export function Card({ children, delay = 0, style }: { children: ReactNode; delay?: number; style?: React.CSSProperties }) {
  return <section className="mf-s mf-in mf-card" style={{ animationDelay: `${delay}ms`, padding: 22, borderRadius: 16, background: "var(--surface)", border: "1px solid var(--border)", ...style }}>{children}</section>;
}

export function StatCard({ label, value, suffix, status }: { label: string; value: ReactNode; suffix?: string; status?: { word: string; color: string } }) {
  return (
    <div className="mf-s mf-in mf-card" style={{ padding: "18px 20px", borderRadius: 14, background: "var(--surface)", border: "1px solid var(--border)", display: "flex", flexDirection: "column", gap: 8 }}>
      <span style={{ fontSize: 12, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--faint)" }}>{label}</span>
      <span style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <span className="mf-disp" style={{ fontSize: 34, fontWeight: 800 }}>{value}</span>
        {suffix && <span style={{ fontSize: 14, color: "var(--muted)" }}>{suffix}</span>}
      </span>
      {status && <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 700, letterSpacing: "0.06em", color: status.color }}>{status.word}</span>}
    </div>
  );
}

export function SegTabs<T extends string>({ tabs, value, onChange, label = "views" }: { tabs: { id: T; label: string; count?: number }[]; value: T; onChange: (t: T) => void; label?: string }) {
  return (
    <div role="tablist" aria-label={label} className="gw-tabs-scroll" style={{ display: "inline-flex", gap: 4, padding: 4, borderRadius: 12, background: "var(--surface2)", border: "1px solid var(--border)" }}
      onKeyDown={(e) => {
        const i = tabs.findIndex((t) => t.id === value);
        if (e.key === "ArrowRight") onChange(tabs[(i + 1) % tabs.length].id);
        if (e.key === "ArrowLeft") onChange(tabs[(i - 1 + tabs.length) % tabs.length].id);
      }}>
      {tabs.map((t) => (
        <button key={t.id} role="tab" aria-selected={t.id === value} tabIndex={t.id === value ? 0 : -1}
          className={`mf-seg mf-btn ${t.id === value ? "mf-seg-on" : ""}`}
          style={{ height: 34, padding: "0 14px", borderRadius: 9, fontSize: 13.5, fontWeight: 600, whiteSpace: "nowrap", flex: "0 0 auto" }}
          onClick={() => onChange(t.id)}>
          {t.label}{t.count !== undefined && <span style={{ marginLeft: 6, opacity: 0.7 }}>{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function StatusWord({ word, color, icon }: { word: string; color: string; icon?: ReactNode }) {
  return <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11.5, fontWeight: 700, letterSpacing: "0.06em", color }}>{icon}{word}</span>;
}

export function Ring({ pct, color, label }: { pct: number; color: string; label: string }) {
  const r = 42, c = 2 * Math.PI * r, off = c - (pct / 100) * c;
  return (
    <div style={{ position: "relative", width: 168, height: 168 }}>
      <svg role="img" aria-label={`${pct} percent ${label}`} width="168" height="168" viewBox="0 0 100 100" style={{ transform: "rotate(-90deg)" }}>
        <circle cx="50" cy="50" r={r} fill="none" stroke="var(--surface3)" strokeWidth="9" />
        <circle className="mf-ring" cx="50" cy="50" r={r} fill="none" stroke={color} strokeWidth="9" strokeLinecap="round" strokeDasharray={c} strokeDashoffset={off} />
      </svg>
      <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
        <span className="mf-disp" style={{ fontSize: 38, fontWeight: 800 }}>{pct}%</span>
        <span style={{ fontSize: 12, color: "var(--faint)" }}>{label}</span>
      </div>
    </div>
  );
}

export function useCountUp(target: number, ms = 1400): number {
  const [v, setV] = useState(0);
  const raf = useRef(0);
  useEffect(() => {
    let reduce = false;
    try { reduce = matchMedia("(prefers-reduced-motion: reduce)").matches; } catch { /* ignore */ }
    if (reduce) { setV(target); return; }
    const t0 = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - t0) / ms);
      setV(Math.round(target * (1 - Math.pow(1 - t, 4))));
      if (t < 1) raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf.current);
  }, [target, ms]);
  return v;
}

export function Drawer({ open, title, onClose, children }: { open: boolean; title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    ref.current?.focus();
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div className="mf-scrim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.4)", backdropFilter: "blur(2px)", zIndex: 40 }} />
          <motion.div ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-label={title}
            initial={{ x: 40, opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={{ x: 40, opacity: 0 }}
            transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
            style={{ position: "fixed", top: 0, right: 0, bottom: 0, width: "min(480px, 100%)", background: "var(--surface)", borderLeft: "1px solid var(--border)", zIndex: 41, padding: 24, overflowY: "auto", boxShadow: "var(--shadow)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>{title}</h2>
              <button className="mf-btn mf-gho" aria-label="Close" onClick={onClose} style={{ width: 34, height: 34, borderRadius: 9, border: "1px solid var(--border)", background: "var(--surface)", cursor: "pointer" }}>✕</button>
            </div>
            {children}
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return <div className="mf-in" style={{ padding: 48, textAlign: "center", color: "var(--faint)" }}><p style={{ fontSize: 15, fontWeight: 600, color: "var(--muted)" }}>{title}</p>{hint && <p style={{ fontSize: 13 }}>{hint}</p>}</div>;
}
export function Skeleton({ h = 60 }: { h?: number }) {
  return <div className="mf-shim" style={{ height: h, borderRadius: 12, border: "1px solid var(--border)", background: "var(--surface2)" }} aria-hidden="true" />;
}
export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return <div role="alert" style={{ padding: 24, borderRadius: 12, border: "1px solid var(--bad)", background: "var(--badSoft)", color: "var(--bad)", display: "flex", gap: 12, alignItems: "center" }}>
    <span style={{ flex: 1 }}>{message}</span>
    {onRetry && <button className="mf-btn mf-gho" onClick={onRetry} style={{ height: 34, padding: "0 14px", borderRadius: 9, border: "1px solid var(--border)", background: "var(--surface)", cursor: "pointer" }}>Retry</button>}
  </div>;
}
