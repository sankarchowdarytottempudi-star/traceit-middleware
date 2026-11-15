// Small building blocks shared by the migrate screens. Styling lives in migrate.css (mf-mg-*).
import { useEffect, useId, useRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { Link, type LinkProps } from "react-router-dom";
import { AlertTriangle, CheckCircle2, ChevronLeft, GitBranch, Info, Loader2, Search, UploadCloud, X, XCircle } from "lucide-react";
import { MODULES } from "../brand.tsx";
import { txt } from "../lib/text.ts";
import { LAYER_LABEL, healthLabel, healthTone, layerKey, type Tone } from "../lib/migrate.ts";

const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(" ");

export function useTitle(title: string) {
  useEffect(() => { document.title = `${title} · ${MODULES.factory}`; }, [title]);
}

export function Head({ area, areaTo, title, subtitle, actions, back, mono }: { area: string; areaTo?: string; title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; back?: { to: string; label: string }; mono?: boolean }) {
  return (
    <header className="mf-mg-head mf-in">
      <div className="mf-mg-head-text">
        {back && <Link className="mf-mg-back" to={back.to}><ChevronLeft size={15} aria-hidden="true" />{back.label}</Link>}
        <div className="mf-mono mf-mg-crumb">{MODULES.factory.toUpperCase()} / {areaTo ? <Link to={areaTo} style={{ color: "var(--text)" }}>{area.toUpperCase()}</Link> : <span style={{ color: "var(--text)" }}>{area.toUpperCase()}</span>}</div>
        <h1 className={mono ? "mf-mono" : undefined} style={mono ? { fontSize: "clamp(20px, 3.4vw, 32px)", fontWeight: 700 } : undefined}>{title}</h1>
        {subtitle && <p className="mf-mg-sub">{subtitle}</p>}
      </div>
      {actions && <div className="mf-mg-actions">{actions}</div>}
    </header>
  );
}

type BtnKind = "default" | "primary" | "danger";
interface BtnProps extends ButtonHTMLAttributes<HTMLButtonElement> { kind?: BtnKind; small?: boolean; busy?: boolean; icon?: ReactNode }
const btnClass = (kind: BtnKind = "default", small?: boolean, extra?: string) =>
  cx("mf-btn", "mf-mg-btn", kind === "primary" && "mf-mg-btn-pri", kind === "danger" && "mf-mg-btn-dan", small && "mf-mg-btn-sm", extra);
export function Btn({ kind, small, busy, icon, children, className, disabled, type, ...rest }: BtnProps) {
  return (
    <button type={type ?? "button"} className={btnClass(kind, small, className)} disabled={disabled || busy} {...rest}>
      {busy ? <Loader2 size={15} className="mf-spin" aria-hidden="true" /> : icon}{children}
    </button>
  );
}
export function LinkBtn({ kind, small, icon, children, className, ...rest }: LinkProps & { kind?: BtnKind; small?: boolean; icon?: ReactNode }) {
  return <Link className={btnClass(kind, small, className)} {...rest}>{icon}{children}</Link>;
}

export function Pill({ tone, children, title }: { tone?: Tone | "exp" | "proc" | "sys"; children: ReactNode; title?: string }) {
  return <span title={title} className={cx("mf-mg-pill", tone && tone !== "muted" && `mf-mg-pill-${tone}`)}>{children}</span>;
}
export function Dot({ tone }: { tone: Tone }) {
  return <span aria-hidden="true" className={cx("mf-mg-dot", (tone === "ok" || tone === "warn" || tone === "bad") && `mf-mg-dot-${tone}`)} />;
}
export function HealthPill({ health }: { health: unknown }) {
  const tone = healthTone(health);
  return <Pill tone={tone}><Dot tone={tone} />{healthLabel(health)}</Pill>;
}
export function LayerPill({ layer }: { layer: unknown }) {
  const k = layerKey(layer);
  return <Pill tone={k === "other" ? undefined : k}>{k === "other" ? (txt(layer) || "Other") : LAYER_LABEL[k]}</Pill>;
}
export function Method({ method }: { method: unknown }) {
  const m = txt(method).toUpperCase() || "ANY";
  return <span className={`mf-mono mf-mg-method mf-mg-method-${m}`}>{m}</span>;
}

export function Panel({ title, actions, children, id }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; id?: string }) {
  return (
    <section className="mf-mg-panel mf-in" id={id}>
      {(title || actions) && <div className="mf-mg-panel-head">{title ? <h2 className="mf-mg-h2">{title}</h2> : <span />}{actions && <div className="mf-mg-actions">{actions}</div>}</div>}
      {children}
    </section>
  );
}
export function Stat({ label, value, note }: { label: string; value: ReactNode; note?: ReactNode }) {
  return <div className="mf-mg-stat"><span className="mf-mg-stat-label">{label}</span><span className="mf-disp mf-mg-stat-value">{value}</span>{note && <span className="mf-mg-stat-note">{note}</span>}</div>;
}
export function Notice({ tone = "info", children }: { tone?: "info" | "warn" | "bad" | "ok"; children: ReactNode }) {
  const Icon = tone === "warn" ? AlertTriangle : tone === "bad" ? XCircle : tone === "ok" ? CheckCircle2 : Info;
  const color = tone === "warn" ? "var(--warn)" : tone === "bad" ? "var(--bad)" : tone === "ok" ? "var(--ok)" : "var(--muted)";
  return <div className={cx("mf-mg-notice", tone !== "info" && `mf-mg-notice-${tone}`)} role={tone === "bad" ? "alert" : undefined}><Icon size={16} color={color} aria-hidden="true" /><div className="mf-mg-grow">{children}</div></div>;
}
export function Field({ label, hint, error, children }: { label: string; hint?: ReactNode; error?: string; children: ReactNode }) {
  return <label className="mf-mg-field"><span>{label}</span>{children}{error ? <span className="mf-mg-err" role="alert">{error}</span> : hint ? <span className="mf-mg-hint">{hint}</span> : null}</label>;
}
export function SearchBox({ value, onChange, placeholder, label }: { value: string; onChange: (v: string) => void; placeholder: string; label?: string }) {
  return (
    <div className="mf-mg-search">
      <Search size={15} aria-hidden="true" />
      <input className="mf-mg-input" type="search" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} aria-label={label ?? placeholder} />
    </div>
  );
}
export function Bar({ pct, tone, large, label }: { pct: number; tone?: "ok" | "bad" | "accent"; large?: boolean; label?: string }) {
  const p = Math.max(0, Math.min(100, Number.isFinite(pct) ? pct : 0));
  const color = tone === "ok" ? "var(--ok)" : tone === "bad" ? "var(--bad)" : "var(--accent)";
  return <span className={cx("mf-mg-bar", large && "mf-mg-bar-lg")} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(p)} aria-label={label ?? "Progress"}><span style={{ width: `${p}%`, background: color }} /></span>;
}

export interface TabDef<T extends string> { id: T; label: string; count?: number }
export function TabBar<T extends string>({ tabs, value, onChange, label }: { tabs: TabDef<T>[]; value: T; onChange: (t: T) => void; label: string }) {
  return (
    <div className="mf-mg-tabs" role="tablist" aria-label={label}
      onKeyDown={(e) => {
        const i = tabs.findIndex((t) => t.id === value);
        if (e.key === "ArrowRight") onChange(tabs[(i + 1) % tabs.length].id);
        if (e.key === "ArrowLeft") onChange(tabs[(i - 1 + tabs.length) % tabs.length].id);
      }}>
      {tabs.map((t) => (
        <button key={t.id} type="button" role="tab" aria-selected={t.id === value} tabIndex={t.id === value ? 0 : -1} className={cx("mf-tab", t.id === value && "mf-tab-on")} onClick={() => onChange(t.id)}>
          {t.label}{t.count !== undefined && <span className="mf-mg-count">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

/** Source code with line numbers. Always dark, like a terminal. */
export function Code({ code, file, startLine = 1, maxHeight }: { code: unknown; file?: string; startLine?: number; maxHeight?: number }) {
  const lines = txt(code).replace(/\n$/, "").split("\n");
  return (
    <div className="mf-mono mf-mg-code" style={maxHeight ? { maxHeight } : undefined} tabIndex={0} role="region" aria-label={file ? `Source of ${file}` : "Source"}>
      {file && <div className="mf-mg-code-file"><span>{file}</span><span>{startLine > 1 ? `from line ${startLine}` : ""}</span></div>}
      <table style={{ margin: "8px 0" }}><tbody>
        {lines.map((l, i) => <tr key={i}><td className="mf-mg-ln">{startLine + i}</td><td>{l || " "}</td></tr>)}
      </tbody></table>
    </div>
  );
}

export function Dialog({ title, onClose, children, footer, wide }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const id = useId();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    ref.current?.focus();
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="mf-mg-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby={id} className={cx("mf-mg-dialog", wide && "mf-mg-dialog-wide")}>
        <div className="mf-mg-panel-head">
          <h2 id={id}>{title}</h2>
          <button type="button" className="mf-btn mf-mg-btn mf-mg-iconbtn" aria-label="Close" onClick={onClose}><X size={16} aria-hidden="true" /></button>
        </div>
        {children}
        {footer && <div className="mf-mg-dialog-foot">{footer}</div>}
      </div>
    </div>
  );
}
export function Confirm({ title, children, confirmLabel, danger, busy, error, onConfirm, onClose }: { title: string; children: ReactNode; confirmLabel: string; danger?: boolean; busy?: boolean; error?: string; onConfirm: () => void; onClose: () => void }) {
  return (
    <Dialog title={title} onClose={onClose} footer={<><Btn onClick={onClose}>Cancel</Btn><Btn kind={danger ? "danger" : "primary"} busy={busy} onClick={onConfirm}>{confirmLabel}</Btn></>}>
      <div className="mf-mg-stack" style={{ gap: 10, fontSize: 14, lineHeight: 1.55 }}>{children}</div>
      {error && <Notice tone="bad">{error}</Notice>}
    </Dialog>
  );
}

export function Loading({ rows = 3, h = 64 }: { rows?: number; h?: number }) {
  return <div className="mf-mg-stack" style={{ gap: 10 }} aria-busy="true" aria-label="Loading">{Array.from({ length: rows }, (_, i) => <div key={i} className="mf-shim" style={{ height: h, borderRadius: 12, border: "1px solid var(--border)", background: "var(--surface2)" }} aria-hidden="true" />)}</div>;
}
export function Failed({ what, error, onRetry }: { what: string; error?: unknown; onRetry?: () => void }) {
  const detail = error instanceof Error ? error.message : txt(error);
  return (
    <Notice tone="bad">
      <div className="mf-mg-row" style={{ justifyContent: "space-between" }}>
        <span className="mf-mg-grow mf-mg-wrap"><strong>{what}</strong>{detail && detail !== "unauthorized" ? <> <span className="mf-mg-muted">{detail}</span></> : null}</span>
        {onRetry && <Btn small onClick={onRetry}>Try again</Btn>}
      </div>
    </Notice>
  );
}
export function Empty({ title, hint, action }: { title: string; hint?: ReactNode; action?: ReactNode }) {
  return (
    <div className="mf-in" style={{ padding: "36px 16px", textAlign: "center", display: "flex", flexDirection: "column", gap: 8, alignItems: "center" }}>
      <p style={{ margin: 0, fontSize: 15, fontWeight: 600, color: "var(--muted)" }}>{title}</p>
      {hint && <p style={{ margin: 0, fontSize: 13, color: "var(--faint)", maxWidth: 520, lineHeight: 1.5 }}>{hint}</p>}
      {action}
    </div>
  );
}
export function KV({ rows }: { rows: [string, ReactNode][] }) {
  const shown = rows.filter(([, v]) => v !== null && v !== undefined && v !== "" && v !== false);
  return <dl className="mf-mg-kv">{shown.map(([k, v]) => <div key={k} style={{ display: "contents" }}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>;
}
export function errText(e: unknown): string {
  return e instanceof Error ? e.message : txt(e) || "Something went wrong";
}
/** The two ways a migration can start: one uploaded file, or the projects of a git repository. */
export function SourceWays({ way }: { way: "upload" | "git" }) {
  return (
    <nav className="mf-mg-ways" aria-label="Where the source comes from">
      <Link className="mf-mg-way" to="/migrations/new" aria-current={way === "upload" ? "page" : undefined}>
        <UploadCloud size={20} color="var(--accentText)" aria-hidden="true" />
        <span><strong>Upload a file</strong><small>One project as a .zip or .jar, or a written specification.</small></span>
      </Link>
      <Link className="mf-mg-way" to="/migrations/from-git" aria-current={way === "git" ? "page" : undefined}>
        <GitBranch size={20} color="var(--accentText)" aria-hidden="true" />
        <span><strong>From a git repository</strong><small>Every project of a repository, with its settings files. Nothing to upload.</small></span>
      </Link>
    </nav>
  );
}
