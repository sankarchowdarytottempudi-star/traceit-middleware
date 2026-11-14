import { useState } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Boxes, Layers, FlaskConical, BookOpen, Workflow, ExternalLink, Info } from "lucide-react";
import { BRAND, WEAVE_GATEWAY_URL, WeaveMark, WeaveLockup, TraceItLogo, PRODUCT_NAME, TAGLINE, COMPANY_LINE } from "../brand.tsx";
import { useTheme } from "../theme.tsx";
import { ThemeSwitch } from "./ThemeSwitch.tsx";
import { api } from "../api.ts";

const groups: { title: string; items: { to: string; label: string; icon: typeof Boxes; end?: boolean }[] }[] = [
  { title: "MIGRATE", items: [
    { to: "/", label: "Migrations", icon: Boxes, end: true },
    { to: "/workspaces", label: "Workspaces", icon: Layers },
  ] },
  { title: "TEST", items: [{ to: "/playground", label: "Playground", icon: FlaskConical }] },
  { title: "BUILD", items: [{ to: "/canvas", label: "Flow canvas", icon: Workflow }] },
  { title: "KNOWLEDGE", items: [{ to: "/knowledge", label: "Knowledge base", icon: BookOpen }] },
];

export function Shell() {
  const { resolved } = useTheme();
  const [about, setAbout] = useState(false);
  const me = useQuery({ queryKey: ["me"], queryFn: api.me, retry: false });
  const health = useQuery({ queryKey: ["healthz"], queryFn: async () => (await fetch("/healthz")).ok, retry: false, refetchInterval: 30000 });
  const live = health.data === true;

  return (
    <div className="mf" style={{ display: "flex", minHeight: "100vh" }}>
      <aside className="mf-side mf-s" style={{ background: "var(--side)", borderRight: "1px solid var(--border)", padding: 18, display: "flex", flexDirection: "column", gap: 18, position: "sticky", top: 0, height: "100vh" }}>
        <div style={{ padding: "2px 4px" }}><TraceItLogo variant="wordmark" theme={resolved} height={22} /></div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "4px 10px" }}>
          <span style={{ opacity: live ? 1 : 0.4, filter: live ? "none" : "grayscale(1)" }}><WeaveMark size={18} theme={resolved} live={live} /></span>
          <strong className="mf-disp" style={{ fontSize: 14 }}>{BRAND.section}</strong>
          <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: "0.08em", padding: "1px 6px", borderRadius: 999, background: "var(--accentWash)", color: "var(--accentText)" }}>NEW</span>
        </div>
        <nav style={{ display: "flex", flexDirection: "column", gap: 16, flex: 1, overflowY: "auto" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span className="mf-mono" style={{ fontSize: 10.5, letterSpacing: "0.14em", color: "var(--faint)", padding: "0 12px 2px" }}>WEAVE</span>
            <span className="mf-nav mf-nav-on" aria-current="page" style={{ fontWeight: 600 }}><Boxes size={17} aria-hidden="true" /><span style={{ flex: 1 }}>Factory</span></span>
            {WEAVE_GATEWAY_URL && <a className="mf-nav" href={WEAVE_GATEWAY_URL} target="_blank" rel="noreferrer"><ExternalLink size={17} aria-hidden="true" /><span style={{ flex: 1 }}>Gateway</span></a>}
          </div>
          {groups.map((g) => (
            <div key={g.title} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span className="mf-mono" style={{ fontSize: 10.5, letterSpacing: "0.14em", color: "var(--faint)", padding: "0 12px 2px" }}>{g.title}</span>
              {g.items.map((it) => (
                <NavLink key={it.to} to={it.to} end={it.end} className={({ isActive }) => `mf-nav ${isActive ? "mf-nav-on" : ""}`}>
                  <it.icon size={17} aria-hidden="true" /><span style={{ flex: 1 }}>{it.label}</span>
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <ThemeSwitch />
          <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", borderRadius: 10, background: "var(--surface)", border: "1px solid var(--border)" }}>
            <span style={{ width: 30, height: 30, borderRadius: 8, background: "var(--accentWash)", color: "var(--accentText)", display: "grid", placeItems: "center", fontWeight: 700 }}>{(me.data?.user ?? "?").slice(0, 1).toUpperCase()}</span>
            <span style={{ display: "flex", flexDirection: "column", lineHeight: 1.2, minWidth: 0, flex: 1 }}>
              <strong style={{ fontSize: 13, overflow: "hidden", textOverflow: "ellipsis" }}>{me.data?.user ?? "Not signed in"}</strong>
              <span style={{ fontSize: 11.5, color: "var(--faint)" }}>{me.data?.role ?? "—"}</span>
            </span>
            <button className="mf-btn mf-gho" aria-label="About" onClick={() => setAbout(true)} style={{ width: 30, height: 30, borderRadius: 8, border: "1px solid var(--border)", background: "var(--surface)", cursor: "pointer", display: "grid", placeItems: "center" }}><Info size={15} /></button>
          </div>
        </div>
      </aside>
      <main style={{ flex: 1, minWidth: 0, padding: "28px 32px", display: "flex", flexDirection: "column", gap: 20 }}><Outlet /></main>
      {about && (
        <div className="mf-scrim" role="dialog" aria-modal="true" aria-label={`About ${PRODUCT_NAME}`} onClick={() => setAbout(false)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.45)", display: "grid", placeItems: "center", zIndex: 50 }}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 18, padding: 32, maxWidth: 420, display: "flex", flexDirection: "column", gap: 14, alignItems: "center", textAlign: "center", boxShadow: "var(--shadow)" }}>
            <WeaveLockup variant="primary" theme={resolved} height={64} />
            <p style={{ margin: 0, color: "var(--muted)" }}>{TAGLINE}</p>
            <p style={{ margin: 0, fontSize: 12.5, color: "var(--faint)" }}>Version 0.1.0</p>
            <p style={{ margin: 0, fontSize: 12.5, color: "var(--faint)" }}>{COMPANY_LINE}</p>
            <button className="mf-btn mf-gho" onClick={() => setAbout(false)} style={{ height: 38, padding: "0 18px", borderRadius: 9, border: "1px solid var(--border)", background: "var(--surface)", cursor: "pointer" }}>Close</button>
          </div>
        </div>
      )}
    </div>
  );
}
