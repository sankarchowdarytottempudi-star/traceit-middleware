// Small UI kit for the studio screens. Plain CSS (studio.css), product tokens, light + dark.
import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type ButtonHTMLAttributes, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, Check, ChevronDown, ChevronRight, CircleAlert, CircleCheck, Copy, Info, LoaderCircle, X, type LucideIcon } from "lucide-react";
import { MODULES } from "../brand.tsx";
import { txt } from "../lib/text.ts";

// ---------------------------------------------------------------- helpers
export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}
export function useMediaQuery(query: string): boolean {
  const get = () => { try { return window.matchMedia(query).matches; } catch { return false; } };
  const [on, setOn] = useState(get);
  useEffect(() => {
    let mq: MediaQueryList;
    try { mq = window.matchMedia(query); } catch { return; }
    const h = () => setOn(mq.matches);
    h();
    mq.addEventListener("change", h);
    return () => mq.removeEventListener("change", h);
  }, [query]);
  return on;
}
/** phone <= 640, tablet <= 1024 (panels become slide-over sheets), desktop above. */
export function useBreakpoint(): "phone" | "tablet" | "desktop" {
  const phone = useMediaQuery("(max-width: 640px)");
  const tablet = useMediaQuery("(max-width: 1024px)");
  return phone ? "phone" : tablet ? "tablet" : "desktop";
}
export function useDocumentTitle(area: string) {
  useEffect(() => { document.title = `${area} · ${MODULES.factory}`; }, [area]);
}
export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}
export function fmtDuration(ms: unknown): string {
  const n = typeof ms === "number" ? ms : Number(ms);
  if (!Number.isFinite(n)) return "—";
  if (n < 1) return "<1 ms";
  if (n < 1000) return `${Math.round(n)} ms`;
  if (n < 60_000) return `${(n / 1000).toFixed(n < 10_000 ? 2 : 1)} s`;
  return `${Math.floor(n / 60_000)} min ${Math.round((n % 60_000) / 1000)} s`;
}
export function fmtTime(iso: unknown): string {
  if (typeof iso !== "string" || !iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return txt(iso);
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
export function ago(iso: unknown): string {
  if (typeof iso !== "string" || !iso) return "—";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return txt(iso);
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 10) return "just now";
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}
export function pretty(v: unknown): string {
  if (v === undefined) return "";
  if (typeof v === "string") return v;
  try { return JSON.stringify(v, null, 2); } catch { return String(v); }
}
export function downloadJson(name: string, value: unknown) {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export async function copyText(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* fall through */ }
  try {
    const ta = document.createElement("textarea");
    ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch { return false; }
}

// ---------------------------------------------------------------- buttons
type Variant = "primary" | "default" | "ghost" | "danger";
export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> { variant?: Variant; size?: "sm" | "md"; icon?: LucideIcon; busy?: boolean; block?: boolean; }
export function Button({ variant = "default", size = "md", icon: Icon, busy, block, className, children, disabled, type, ...rest }: ButtonProps) {
  return (
    <button type={type ?? "button"} className={cx("mf-button", `mf-button-${variant}`, size === "sm" && "mf-button-sm", block && "mf-button-block", className)} disabled={disabled || busy} {...rest}>
      {busy ? <LoaderCircle size={size === "sm" ? 14 : 16} className="mf-spin" aria-hidden="true" /> : Icon ? <Icon size={size === "sm" ? 14 : 16} aria-hidden="true" /> : null}
      {children != null && <span className="mf-button-label">{children}</span>}
    </button>
  );
}
export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> { label: string; icon: LucideIcon; active?: boolean; size?: number; tone?: "default" | "danger"; busy?: boolean; }
export function IconButton({ label, icon: Icon, active, size = 16, tone, busy, className, type, disabled, ...rest }: IconButtonProps) {
  return (
    <button type={type ?? "button"} aria-label={label} title={label} aria-pressed={active} disabled={disabled || busy}
      className={cx("mf-iconbtn", active && "mf-iconbtn-on", tone === "danger" && "mf-iconbtn-danger", className)} {...rest}>
      {busy ? <LoaderCircle size={size} className="mf-spin" aria-hidden="true" /> : <Icon size={size} aria-hidden="true" />}
    </button>
  );
}
export function CopyButton({ text, label = "Copy", size = "sm" }: { text: string; label?: string; size?: "sm" | "md" }) {
  const [done, setDone] = useState(false);
  return (
    <Button size={size} icon={done ? Check : Copy} onClick={async () => { if (await copyText(text)) { setDone(true); setTimeout(() => setDone(false), 1400); } }}>
      {done ? "Copied" : label}
    </Button>
  );
}

// ---------------------------------------------------------------- form controls
export function Field({ label, help, error, required, children, htmlFor, aside, className }: { label?: ReactNode; help?: ReactNode; error?: ReactNode; required?: boolean; children: ReactNode; htmlFor?: string; aside?: ReactNode; className?: string }) {
  return (
    <div className={cx("mf-field", className)}>
      {(label || aside) && (
        <div className="mf-field-head">
          {label && <label className="mf-label" htmlFor={htmlFor}>{label}{required && <span className="mf-req" aria-hidden="true"> *</span>}</label>}
          {aside && <span className="mf-field-aside">{aside}</span>}
        </div>
      )}
      {children}
      {error ? <div className="mf-field-error" role="alert">{error}</div> : help ? <div className="mf-help">{help}</div> : null}
    </div>
  );
}
export function Toggle({ checked, onChange, label, disabled, id }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode; disabled?: boolean; id?: string }) {
  return (
    <label className={cx("mf-toggle", disabled && "mf-toggle-disabled")}>
      <input id={id} type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="mf-toggle-track" aria-hidden="true"><span className="mf-toggle-thumb" /></span>
      {label && <span className="mf-toggle-label">{label}</span>}
    </label>
  );
}
/** A textarea that grows with its content (between min and max rows). */
export function AutoTextArea({ value, onChange, minRows = 1, maxRows = 12, className, mono, ...rest }: { value: string; onChange: (v: string) => void; minRows?: number; maxRows?: number; mono?: boolean } & Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "onChange">) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    const line = mono ? 19 : 20;
    const max = maxRows * line + 18;
    el.style.height = `${Math.min(max, Math.max(minRows * line + 18, el.scrollHeight + 2))}px`;
    el.style.overflowY = el.scrollHeight + 2 > max ? "auto" : "hidden";
  }, [value, minRows, maxRows, mono]);
  return <textarea ref={ref} className={cx("mf-control", mono && "mf-control-mono", className)} value={value} rows={minRows} spellCheck={!mono} onChange={(e) => onChange(e.target.value)} {...rest} />;
}
/** JSON editor that keeps what the user typed while it is not valid JSON yet. */
export function JsonEditor({ value, onChange, minRows = 3, maxRows = 14, placeholder, disabled, ariaLabel, id }: { value: unknown; onChange: (v: unknown) => void; minRows?: number; maxRows?: number; placeholder?: string; disabled?: boolean; ariaLabel?: string; id?: string }) {
  const [text, setText] = useState(() => (value === undefined ? "" : pretty(value)));
  const [err, setErr] = useState<string | null>(null);
  const last = useRef(value);
  useEffect(() => {
    // external change (undo, restore, another control): refresh the text unless it already matches
    if (last.current === value) return;
    last.current = value;
    try { if (text.trim() && JSON.stringify(JSON.parse(text)) === JSON.stringify(value)) return; } catch { /* replace */ }
    setText(value === undefined ? "" : pretty(value));
    setErr(null);
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div>
      <AutoTextArea id={id} mono value={text} minRows={minRows} maxRows={maxRows} placeholder={placeholder} disabled={disabled} aria-label={ariaLabel} aria-invalid={!!err}
        onChange={(t) => {
          setText(t);
          if (!t.trim()) { setErr(null); last.current = undefined; onChange(undefined); return; }
          try { const v = JSON.parse(t); setErr(null); last.current = v; onChange(v); } catch (e) { setErr((e as Error).message.replace(/^JSON\.parse: /, "")); }
        }} />
      {err && <div className="mf-field-error">Not valid JSON yet: {err}</div>}
    </div>
  );
}

// ---------------------------------------------------------------- feedback
export type Tone = "neutral" | "ok" | "warn" | "bad" | "info" | "accent";
export function Badge({ tone = "neutral", children, icon: Icon, title }: { tone?: Tone; children: ReactNode; icon?: LucideIcon; title?: string }) {
  return <span className={cx("mf-badge", `mf-badge-${tone}`)} title={title}>{Icon && <Icon size={12} aria-hidden="true" />}{children}</span>;
}
export function Callout({ tone = "info", title, children, actions }: { tone?: "info" | "ok" | "warn" | "bad"; title?: ReactNode; children?: ReactNode; actions?: ReactNode }) {
  const Icon = tone === "ok" ? CircleCheck : tone === "warn" ? AlertTriangle : tone === "bad" ? CircleAlert : Info;
  return (
    <div className={cx("mf-callout", `mf-callout-${tone}`)} role={tone === "bad" ? "alert" : "status"}>
      <Icon size={16} aria-hidden="true" className="mf-callout-icon" />
      <div className="mf-callout-body">
        {title && <strong>{title}</strong>}
        {children && <div>{children}</div>}
        {actions && <div className="mf-callout-actions">{actions}</div>}
      </div>
    </div>
  );
}
export function Spinner({ label = "Loading" }: { label?: string }) {
  return <span className="mf-spinner" role="status"><LoaderCircle size={16} className="mf-spin" aria-hidden="true" />{label}</span>;
}
export function Empty({ icon: Icon, title, hint, action }: { icon?: LucideIcon; title: string; hint?: ReactNode; action?: ReactNode }) {
  return (
    <div className="mf-empty">
      {Icon && <span className="mf-empty-icon"><Icon size={22} aria-hidden="true" /></span>}
      <p className="mf-empty-title">{title}</p>
      {hint && <p className="mf-empty-hint">{hint}</p>}
      {action && <div style={{ marginTop: 6 }}>{action}</div>}
    </div>
  );
}

// ---------------------------------------------------------------- overlays
function useEscape(onClose: () => void, active = true) {
  useEffect(() => {
    if (!active) return;
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    document.addEventListener("keydown", h);
    return () => document.removeEventListener("keydown", h);
  }, [onClose, active]);
}
function portalRoot(): HTMLElement {
  return (document.querySelector(".mf-shell") as HTMLElement | null) ?? document.body;
}
export function Modal({ title, subtitle, onClose, children, footer, width = 560, full, bodyClass, labelledBy }: { title: ReactNode; subtitle?: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; width?: number; full?: boolean; bodyClass?: string; labelledBy?: string }) {
  useEscape(onClose);
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  return createPortal(
    <div className="mf-modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby={labelledBy ?? id} className={cx("mf-modal", full && "mf-modal-full")} style={full ? undefined : { maxWidth: width }}>
        <div className="mf-modal-head">
          <div style={{ minWidth: 0, flex: 1 }}>
            <h2 id={id} className="mf-modal-title">{title}</h2>
            {subtitle && <p className="mf-modal-sub">{subtitle}</p>}
          </div>
          <IconButton label="Close" icon={X} onClick={onClose} />
        </div>
        <div className={cx("mf-modal-body", bodyClass)}>{children}</div>
        {footer && <div className="mf-modal-foot">{footer}</div>}
      </div>
    </div>,
    portalRoot(),
  );
}
/** Slide-over panel. Used for the palette / config panel on small screens and for detail drawers. */
export function Sheet({ title, onClose, children, side = "right", width = 420, footer, headExtra }: { title: ReactNode; onClose: () => void; children: ReactNode; side?: "right" | "left" | "bottom"; width?: number; footer?: ReactNode; headExtra?: ReactNode }) {
  useEscape(onClose);
  return createPortal(
    <>
      <div className="mf-sheet-scrim" onClick={onClose} aria-hidden="true" />
      <aside role="dialog" aria-modal="true" aria-label={typeof title === "string" ? title : undefined} className={cx("mf-sheet", `mf-sheet-${side}`)} style={side === "bottom" ? undefined : { width: `min(${width}px, 100vw)` }}>
        <div className="mf-sheet-head">
          <h2 className="mf-sheet-title">{title}</h2>
          {headExtra}
          <IconButton label="Close" icon={X} onClick={onClose} />
        </div>
        <div className="mf-sheet-body">{children}</div>
        {footer && <div className="mf-sheet-foot">{footer}</div>}
      </aside>
    </>,
    portalRoot(),
  );
}
export interface MenuItem { id: string; label: string; icon?: LucideIcon; onSelect: () => void; danger?: boolean; disabled?: boolean; hint?: string; divider?: boolean; }
export function Menu({ items, trigger, align = "right", label }: { items: MenuItem[]; trigger: (props: { onClick: () => void; "aria-expanded": boolean; "aria-haspopup": "menu" }) => ReactNode; align?: "left" | "right"; label?: string }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState<CSSProperties>({});
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | TouchEvent) => { if (!wrap.current?.contains(e.target as Node) && !(e.target as HTMLElement).closest?.(".mf-menu")) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", close); document.addEventListener("touchstart", close); document.addEventListener("keydown", key);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("touchstart", close); document.removeEventListener("keydown", key); };
  }, [open]);
  useLayoutEffect(() => {
    if (!open || !wrap.current) return;
    const r = wrap.current.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    const style: CSSProperties = { position: "fixed", maxHeight: Math.max(160, vh - r.bottom - 16) };
    if (vh - r.bottom < 220 && r.top > vh - r.bottom) { style.bottom = vh - r.top + 6; style.maxHeight = r.top - 16; } else style.top = r.bottom + 6;
    if (align === "right") style.right = Math.max(8, vw - r.right); else style.left = Math.max(8, Math.min(r.left, vw - 240));
    setPos(style);
  }, [open, align]);
  return (
    <span ref={wrap} className="mf-menu-wrap">
      {trigger({ onClick: () => setOpen((o) => !o), "aria-expanded": open, "aria-haspopup": "menu" })}
      {open && createPortal(
        <div className="mf-menu" role="menu" aria-label={label} style={pos}>
          {items.map((it) => (
            <div key={it.id}>
              {it.divider && <div className="mf-menu-div" role="separator" />}
              <button type="button" role="menuitem" disabled={it.disabled} className={cx("mf-menu-item", it.danger && "mf-menu-danger")}
                onClick={() => { setOpen(false); it.onSelect(); }}>
                {it.icon ? <it.icon size={15} aria-hidden="true" /> : <span style={{ width: 15 }} />}
                <span style={{ flex: 1 }}>{it.label}</span>
                {it.hint && <span className="mf-menu-hint">{it.hint}</span>}
              </button>
            </div>
          ))}
        </div>, portalRoot())}
    </span>
  );
}

// ---------------------------------------------------------------- toasts + confirm (module-level, rendered by <StudioHost/>)
interface Toast { id: number; tone: "ok" | "bad" | "info"; text: string; }
interface ConfirmReq { id: number; title: string; body?: ReactNode; confirmLabel?: string; cancelLabel?: string; danger?: boolean; resolve: (ok: boolean) => void; }
let seq = 1;
let toasts: Toast[] = [];
let confirms: ConfirmReq[] = [];
const listeners = new Set<() => void>();
let snapshot = { toasts, confirms };
function emit() { snapshot = { toasts, confirms }; listeners.forEach((l) => l()); }
export function toast(text: string, tone: Toast["tone"] = "ok", ms = tone === "bad" ? 7000 : 3200) {
  const t: Toast = { id: seq++, tone, text };
  toasts = [...toasts.slice(-3), t];
  emit();
  setTimeout(() => { toasts = toasts.filter((x) => x.id !== t.id); emit(); }, ms);
}
export function confirmDialog(opts: Omit<ConfirmReq, "id" | "resolve">): Promise<boolean> {
  return new Promise((resolve) => { confirms = [...confirms, { ...opts, id: seq++, resolve }]; emit(); });
}
export function StudioHost() {
  const s = useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => snapshot);
  const c = s.confirms[0];
  const answer = useCallback((ok: boolean) => { if (!c) return; confirms = confirms.filter((x) => x.id !== c.id); emit(); c.resolve(ok); }, [c]);
  return (
    <>
      <div className="mf-toasts" aria-live="polite">
        {s.toasts.map((t) => (
          <div key={t.id} className={cx("mf-toast", `mf-toast-${t.tone}`)} role={t.tone === "bad" ? "alert" : "status"}>
            {t.tone === "ok" ? <CircleCheck size={16} aria-hidden="true" /> : t.tone === "bad" ? <CircleAlert size={16} aria-hidden="true" /> : <Info size={16} aria-hidden="true" />}
            <span>{t.text}</span>
          </div>
        ))}
      </div>
      {c && (
        <Modal title={c.title} onClose={() => answer(false)} width={440}
          footer={<><Button onClick={() => answer(false)}>{c.cancelLabel ?? "Cancel"}</Button><Button variant={c.danger ? "danger" : "primary"} onClick={() => answer(true)} autoFocus>{c.confirmLabel ?? "Confirm"}</Button></>}>
          {c.body && <div className="mf-confirm-body">{c.body}</div>}
        </Modal>
      )}
    </>
  );
}

// ---------------------------------------------------------------- navigation bits
export interface TabDef<T extends string> { id: T; label: string; count?: number; icon?: LucideIcon; tone?: Tone; }
export function Tabs<T extends string>({ tabs, value, onChange, label = "Sections", className }: { tabs: TabDef<T>[]; value: T; onChange: (t: T) => void; label?: string; className?: string }) {
  return (
    <div role="tablist" aria-label={label} className={cx("mf-tabs", className)}
      onKeyDown={(e) => {
        const i = tabs.findIndex((t) => t.id === value);
        if (e.key === "ArrowRight") onChange(tabs[(i + 1) % tabs.length].id);
        if (e.key === "ArrowLeft") onChange(tabs[(i - 1 + tabs.length) % tabs.length].id);
      }}>
      {tabs.map((t) => (
        <button key={t.id} type="button" role="tab" aria-selected={t.id === value} tabIndex={t.id === value ? 0 : -1} data-tab={t.id}
          className={cx("mf-tabs-tab", t.id === value && "mf-tabs-on")} onClick={() => onChange(t.id)}>
          {t.icon && <t.icon size={15} aria-hidden="true" />}
          <span>{t.label}</span>
          {t.count !== undefined && t.count > 0 && <span className={cx("mf-tabs-count", t.tone && `mf-badge-${t.tone}`)}>{t.count}</span>}
        </button>
      ))}
    </div>
  );
}
export function StudioHeader({ area, title, subtitle, actions }: { area: string; title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  useDocumentTitle(area);
  return (
    <header className="mf-pagehead mf-in">
      <div className="mf-pagehead-text">
        <div className="mf-mono mf-pagehead-crumb">{MODULES.factory.toUpperCase()} / <span>{area.toUpperCase()}</span></div>
        <h1 className="mf-pagehead-title">{title}</h1>
        {subtitle && <p className="mf-pagehead-sub">{subtitle}</p>}
      </div>
      {actions && <div className="mf-pagehead-actions">{actions}</div>}
    </header>
  );
}
/** A table that scrolls inside its own container instead of widening the page. */
export function TableWrap({ children, label }: { children: ReactNode; label?: string }) {
  return <div className="mf-tablewrap" role="region" aria-label={label} tabIndex={0}>{children}</div>;
}
export function Section({ title, aside, children, className }: { title?: ReactNode; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx("mf-section", className)}>
      {(title || aside) && <div className="mf-section-head">{title && <h3 className="mf-section-title">{title}</h3>}{aside}</div>}
      {children}
    </section>
  );
}
export function Collapsible({ title, children, defaultOpen = false, count }: { title: ReactNode; children: ReactNode; defaultOpen?: boolean; count?: number }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="mf-collapse">
      <button type="button" className="mf-collapse-head" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {open ? <ChevronDown size={15} aria-hidden="true" /> : <ChevronRight size={15} aria-hidden="true" />}
        <span style={{ flex: 1, textAlign: "left" }}>{title}</span>
        {count !== undefined && <span className="mf-tabs-count">{count}</span>}
      </button>
      {open && <div className="mf-collapse-body">{children}</div>}
    </div>
  );
}

// ---------------------------------------------------------------- JSON tree (inspect + pick a path)
function typeOf(v: unknown): string {
  return v === null ? "null" : Array.isArray(v) ? "array" : typeof v;
}
function needsQuote(k: string): boolean { return !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k); }
export function joinPath(base: string, key: string | number): string {
  if (typeof key === "number") return `${base}[${key}]`;
  const seg = needsQuote(key) ? `"${key.replace(/"/g, '\\"')}"` : key;
  return base ? `${base}.${seg}` : seg;
}
interface TreeCtx { onPick?: (path: string, value: unknown) => void; draggable?: boolean; pickLabel?: string; }
const TreeContext = createContext<TreeCtx>({});
function TreeRow({ k, value, path, depth, defaultOpen }: { k: string; value: unknown; path: string; depth: number; defaultOpen: boolean }) {
  const ctx = useContext(TreeContext);
  const t = typeOf(value);
  const container = t === "object" || t === "array";
  const [open, setOpen] = useState(defaultOpen);
  const entries: [string | number, unknown][] = !container ? [] : t === "array" ? (value as unknown[]).slice(0, 50).map((v, i) => [i, v]) : Object.entries(value as Record<string, unknown>);
  const size = t === "array" ? (value as unknown[]).length : entries.length;
  const preview = container ? (t === "array" ? `[${size}]` : `{${size}}`) : t === "string" ? JSON.stringify(value) : String(value);
  return (
    <li className="mf-tree-li">
      <div className={cx("mf-tree-row", ctx.onPick && "mf-tree-pickable")} style={{ paddingLeft: 6 + depth * 14 }}
        draggable={!!ctx.draggable && !!path}
        onDragStart={(e) => { e.dataTransfer.setData("application/x-weave-path", path); e.dataTransfer.setData("text/plain", path); e.dataTransfer.effectAllowed = "copy"; }}>
        {container
          ? <button type="button" className="mf-tree-caret" aria-label={open ? "Collapse" : "Expand"} aria-expanded={open} onClick={() => setOpen((o) => !o)}>{open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</button>
          : <span className="mf-tree-caret" />}
        <button type="button" className="mf-tree-key" title={ctx.onPick ? `${ctx.pickLabel ?? "Use"} ${path}` : path} disabled={!ctx.onPick || !path}
          onClick={() => ctx.onPick?.(path, value)} data-path={path}>
          <span className="mf-tree-name">{k}</span>
          <span className={cx("mf-tree-val", `mf-tree-${t}`)}>{preview}</span>
        </button>
      </div>
      {container && open && (
        <ul className="mf-tree-ul">
          {entries.map(([ck, cv]) => <TreeRow key={String(ck)} k={String(ck)} value={cv} path={joinPath(path, ck)} depth={depth + 1} defaultOpen={depth < 0} />)}
          {t === "array" && size > 50 && <li className="mf-tree-more" style={{ paddingLeft: 26 + depth * 14 }}>… {size - 50} more items</li>}
          {size === 0 && <li className="mf-tree-more" style={{ paddingLeft: 26 + depth * 14 }}>empty</li>}
        </ul>
      )}
    </li>
  );
}
/** Collapsible view of a JSON value. With `onPick`, clicking a field hands back its path. */
export function JsonTree({ value, rootPath = "", rootLabel, onPick, draggable, pickLabel, openDepth = 1 }: { value: unknown; rootPath?: string; rootLabel?: string; onPick?: (path: string, value: unknown) => void; draggable?: boolean; pickLabel?: string; openDepth?: number }) {
  const t = typeOf(value);
  if (value === undefined) return <div className="mf-tree-more">No data</div>;
  const entries: [string | number, unknown][] = t === "array" ? (value as unknown[]).slice(0, 50).map((v, i) => [i, v]) : t === "object" ? Object.entries(value as Record<string, unknown>) : [];
  return (
    <TreeContext.Provider value={{ onPick, draggable, pickLabel }}>
      <ul className="mf-tree">
        {rootLabel
          ? <TreeRow k={rootLabel} value={value} path={rootPath} depth={0} defaultOpen={openDepth > 0} />
          : t === "object" || t === "array"
            ? entries.map(([k, v]) => <TreeRow key={String(k)} k={String(k)} value={v} path={joinPath(rootPath, k)} depth={0} defaultOpen={openDepth > 1} />)
            : <li className="mf-tree-li"><div className="mf-tree-row"><span className={cx("mf-tree-val", `mf-tree-${t}`)}>{t === "string" ? JSON.stringify(value) : String(value)}</span></div></li>}
        {(t === "object" || t === "array") && !rootLabel && entries.length === 0 && <li className="mf-tree-more">empty</li>}
      </ul>
    </TreeContext.Provider>
  );
}
/** Read-only code / JSON block with a copy button. */
export function CodeBlock({ value, maxHeight = 320, label, wrap }: { value: unknown; maxHeight?: number; label?: string; wrap?: boolean }) {
  const text = pretty(value);
  return (
    <div className="mf-code">
      <div className="mf-code-bar">{label && <span>{label}</span>}<span style={{ flex: 1 }} /><CopyButton text={text} /></div>
      <pre className="mf-code-pre" style={{ maxHeight, whiteSpace: wrap ? "pre-wrap" : "pre" }} tabIndex={0}>{text || " "}</pre>
    </div>
  );
}
/** Tree / raw switch for a payload. */
export function DataView({ value, label, onPick, rootPath, maxHeight = 320 }: { value: unknown; label?: string; onPick?: (path: string, value: unknown) => void; rootPath?: string; maxHeight?: number }) {
  const [raw, setRaw] = useState(false);
  if (value === undefined) return <div className="mf-help">No data recorded.</div>;
  const scalar = value === null || typeof value !== "object";
  return (
    <div className="mf-dataview">
      <div className="mf-code-bar">
        {label && <span>{label}</span>}
        <span style={{ flex: 1 }} />
        {!scalar && <button type="button" className="mf-linkbtn" onClick={() => setRaw((r) => !r)}>{raw ? "Tree" : "Raw"}</button>}
        <CopyButton text={pretty(value)} />
      </div>
      {raw || scalar
        ? <pre className="mf-code-pre" style={{ maxHeight }} tabIndex={0}>{pretty(value)}</pre>
        : <div className="mf-dataview-tree" style={{ maxHeight }}><JsonTree value={value} onPick={onPick} rootPath={rootPath} openDepth={2} /></div>}
    </div>
  );
}
export function StatusDot({ tone }: { tone: Tone }) {
  return <span className={cx("mf-dot", `mf-dot-${tone}`)} aria-hidden="true" />;
}
