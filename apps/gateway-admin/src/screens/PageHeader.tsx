import { useEffect, type ReactNode } from "react";
import { MODULES } from "../brand.tsx";
export function PageHeader({ area, title, subtitle, actions }: { area: string; title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  useEffect(() => { document.title = `${area} · ${MODULES.gateway}`; }, [area]);
  return (
    <header className="mf-in" style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-end", justifyContent: "space-between", gap: 16 }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 10, maxWidth: 720 }}>
        <div className="mf-mono" style={{ fontSize: 12, letterSpacing: "0.14em", color: "var(--faint)" }}>{MODULES.gateway.toUpperCase()} / <span style={{ color: "var(--text)" }}>{area.toUpperCase()}</span></div>
        <h1 style={{ margin: 0, fontSize: 40, lineHeight: 1.08, fontWeight: 800 }}>{title}</h1>
        {subtitle && <p style={{ margin: 0, fontSize: 15, lineHeight: 1.55, color: "var(--muted)" }}>{subtitle}</p>}
      </div>
      {actions && <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>{actions}</div>}
    </header>
  );
}
