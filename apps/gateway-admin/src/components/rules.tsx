// Shared pieces of the rules screens: the live-change confirmation, inline "new limit" form,
// list inputs and plain-words helpers.
import { useState, type ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";
import { rulesClient, type ChangePlan, type PolicyInfo } from "../api.ts";
import { Drawer } from "./ui.tsx";
import { Banner } from "./gw.tsx";

export const UNLIMITED = 2147483647;
const UNIT: Record<string, string> = { sec: "second", min: "minute", hour: "hour", day: "day" };
export function rateWords(limit: number, timeUnit: string, unitTime = 1): string {
  if (!Number.isFinite(limit) || limit >= UNLIMITED || limit < 0) return "no limit";
  const n = limit.toLocaleString("en-US"); const w = UNIT[timeUnit] ?? timeUnit;
  return unitTime > 1 ? `${n} requests every ${unitTime} ${w}s` : `${n} ${limit === 1 ? "request" : "requests"} per ${w}`;
}
export function policyLabel(p: PolicyInfo | undefined, name: string, role: "plan" | "api" | "operation" | "application"): string {
  if (!p) return name === "Unlimited" ? "Unlimited: no limit" : `${name} (not found)`;
  if (p.limit >= UNLIMITED) return `${p.name}: no limit`;
  if (p.quotaType && p.quotaType !== "REQUESTCOUNTLIMIT") return `${p.name}: ${p.quotaType.toLowerCase().replace("limit", " limit")}`;
  const tail = role === "plan" ? " per consumer" : role === "api" ? ", shared by all callers" : role === "operation" ? ", shared by all callers" : " per application";
  return `${p.name}: ${rateWords(p.limit, p.timeUnit, p.unitTime)}${tail}`;
}
/** "a, b\nc" -> ["a","b","c"] */
export function splitList(s: string): string[] { return s.split(/[\n,]+/).map((x) => x.trim()).filter(Boolean); }

export function ListInput({ label, hint, value, onChange, placeholder, rows = 3, id }: { label: string; hint?: ReactNode; value: string; onChange: (v: string) => void; placeholder?: string; rows?: number; id: string }) {
  return (
    <label htmlFor={id} className="gw-field" style={{ display: "flex", width: "100%" }}>
      <span>{label}</span>
      <textarea id={id} className="gw-input" rows={rows} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)}
        style={{ height: "auto", padding: "8px 11px", fontFamily: "var(--mono, ui-monospace, monospace)", fontSize: 13, resize: "vertical", width: "100%" }} />
      {hint && <span style={{ fontWeight: 400, letterSpacing: 0, fontSize: 12, color: "var(--faint)" }}>{hint}</span>}
    </label>
  );
}

export function ErrorLine({ error }: { error: unknown }) {
  if (!error) return null;
  return <Banner tone="bad">{error instanceof Error ? error.message : String(error)}</Banner>;
}

/**
 * Shows exactly what will change on the live gateway and asks for confirmation. When `typeToConfirm`
 * is set the button stays disabled until that text is typed.
 */
export function ConfirmChange({ open, plan, title = "Confirm live change", busy, error, onConfirm, onClose, typeToConfirm, confirmLabel = "Apply to the live gateway", danger, deploysRevision = true }: {
  open: boolean; plan: ChangePlan | null; title?: string; busy: boolean; error?: unknown; onConfirm: () => void; onClose: () => void;
  typeToConfirm?: string; confirmLabel?: string; danger?: boolean; deploysRevision?: boolean;
}) {
  const [typed, setTyped] = useState("");
  const ready = !typeToConfirm || typed === typeToConfirm;
  return (
    <Drawer open={open} title={title} onClose={() => { setTyped(""); onClose(); }}>
      {plan && (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }} data-testid="confirm-change">
          <Banner tone={plan.environments.length ? "warn" : "info"}><strong>{plan.sentence}</strong></Banner>
          {plan.noChange ? <p className="gw-muted" style={{ margin: 0 }}>Nothing differs from what is live now, so there is nothing to apply.</p> : (
            <div>
              <h3 className="gw-h2" style={{ fontSize: 14, margin: "0 0 8px" }}>What changes</h3>
              <ul style={{ margin: 0, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 6, fontSize: 13.5, lineHeight: 1.5 }} aria-label="What changes">
                {plan.changes.map((c) => <li key={c} style={/^WARNING/i.test(c) ? { color: "var(--bad)", fontWeight: 700 } : undefined}>{c}</li>)}
              </ul>
            </div>
          )}
          {!plan.noChange && deploysRevision && plan.environments.length > 0 && (
            <p className="gw-muted" style={{ margin: 0, fontSize: 13 }}>
              Saving updates the API in API Manager, creates a new revision and deploys it to {plan.environments.map((e) => e.name).join(", ")}.
              {plan.pruneRevision ? ` API Manager keeps at most 5 revisions, so the oldest one that is not deployed (${plan.pruneRevision.displayName}) is removed first.` : ""}
              {" "}You can roll back from Change history.
            </p>
          )}
          {typeToConfirm && !plan.noChange && (
            <label className="gw-field" style={{ display: "flex" }}>
              <span>Type <strong className="gw-mono" style={{ color: "var(--text)" }}>{typeToConfirm}</strong> to confirm</span>
              <input className="gw-input" value={typed} onChange={(e) => setTyped(e.target.value)} aria-label="Type to confirm" autoComplete="off" />
            </label>
          )}
          <ErrorLine error={error} />
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            {!plan.noChange && <button type="button" className={`gw-btn ${danger ? "" : "gw-btn-pri"}`} style={danger ? { borderColor: "var(--bad)", color: "var(--bad)", background: "var(--badSoft)" } : undefined}
              disabled={busy || !ready} onClick={() => { onConfirm(); setTyped(""); }}>{busy ? "Applying…" : confirmLabel}</button>}
            <button type="button" className="gw-btn" onClick={() => { setTyped(""); onClose(); }}>{plan.noChange ? "Close" : "Cancel"}</button>
          </div>
        </div>
      )}
    </Drawer>
  );
}

/** Small inline form to create a limit that does not exist yet. */
export function NewLimit({ kind, onCreated, label }: { kind: "subscription" | "advanced" | "application"; onCreated: (name: string) => void; label: string }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [requests, setRequests] = useState(100);
  const [unit, setUnit] = useState("min");
  const m = useMutation({ mutationFn: () => rulesClient.createPolicy({ kind, name: name.trim(), requests: Number(requests), timeUnit: unit }),
    onSuccess: (r) => { onCreated(r.name); setOpen(false); setName(""); } });
  if (!open) return <button type="button" className="gw-btn gw-btn-sm" onClick={() => setOpen(true)}>{label}</button>;
  const who = kind === "subscription" ? "per consumer application" : kind === "advanced" ? "shared by every caller of the API or operation it is assigned to" : "per application, across all its APIs";
  return (
    <div className="gw-card" style={{ padding: 14, display: "flex", flexDirection: "column", gap: 10, background: "var(--surface2)" }} data-testid={`new-limit-${kind}`}>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
        <label className="gw-field">Name<input className="gw-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Orders_100PerMin" aria-label="New limit name" /></label>
        <label className="gw-field">Requests<input className="gw-input" type="number" min={1} value={requests} onChange={(e) => setRequests(Number(e.target.value))} style={{ width: 110 }} aria-label="Requests" /></label>
        <label className="gw-field">Per<select className="gw-select" value={unit} onChange={(e) => setUnit(e.target.value)} aria-label="Per"><option value="sec">second</option><option value="min">minute</option><option value="hour">hour</option><option value="day">day</option></select></label>
      </div>
      <p className="gw-muted" style={{ margin: 0, fontSize: 13 }}>In plain words: {rateWords(Number(requests) || 0, unit)}, {who}. Callers over the limit get HTTP 429. Letters, digits and underscores only.</p>
      <ErrorLine error={m.error} />
      <div style={{ display: "flex", gap: 8 }}>
        <button type="button" className="gw-btn gw-btn-pri gw-btn-sm" disabled={m.isPending || !name.trim()} onClick={() => m.mutate()}>{m.isPending ? "Creating…" : "Create limit"}</button>
        <button type="button" className="gw-btn gw-btn-sm" onClick={() => setOpen(false)}>Cancel</button>
      </div>
    </div>
  );
}

export function Radio({ name, value, current, onChange, title, children }: { name: string; value: string; current: string; onChange: (v: string) => void; title: string; children?: ReactNode }) {
  const on = value === current;
  return (
    <label className="gw-check" style={{ alignItems: "flex-start", padding: "10px 12px", border: `1px solid ${on ? "var(--accent)" : "var(--border)"}`, borderRadius: 10, background: on ? "var(--accentWash)" : "transparent" }}>
      <input type="radio" name={name} value={value} checked={on} onChange={() => onChange(value)} style={{ marginTop: 3 }} />
      <span style={{ display: "flex", flexDirection: "column", gap: 3 }}><strong style={{ fontSize: 13.5 }}>{title}</strong>{children && <span className="gw-muted" style={{ fontSize: 12.5, lineHeight: 1.45 }}>{children}</span>}</span>
    </label>
  );
}
