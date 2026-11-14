import { useEffect, useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { LayoutDashboard, Gauge, Server, Boxes, ShieldCheck, Inbox, ExternalLink, Info, ChartColumn, Activity, ScrollText, Menu, X, Waypoints, Factory } from "lucide-react";
import { BRAND, MODULES, WEAVE_FACTORY_URL, WeaveMark, WeaveLockup, TraceItLogo, PRODUCT_NAME, TAGLINE, COMPANY_LINE } from "../brand.tsx";
import { useTheme } from "../theme.tsx";
import { ThemeSwitch } from "./ThemeSwitch.tsx";
import { apiClient } from "../api.ts";

const gatewayGroups: { title: string; items: { to: string; label: string; icon: typeof Gauge; end?: boolean }[] }[] = [
  { title: "OBSERVE", items: [
    { to: "/", label: "Overview", icon: LayoutDashboard, end: true },
    { to: "/apis", label: "APIs", icon: Boxes },
    { to: "/analytics", label: "Service analytics", icon: ChartColumn },
    { to: "/gateway-analytics", label: "Gateway analytics", icon: Activity },
    { to: "/logs", label: "Logs", icon: ScrollText },
  ] },
  { title: "PLATFORM", items: [
    { to: "/rate-limits", label: "Rate limiting", icon: Gauge },
    { to: "/gateways", label: "Gateways & keys", icon: Server },
  ] },
  { title: "GOVERNANCE", items: [{ to: "/compliance", label: "Compliance", icon: ShieldCheck }] },
  { title: "WORKFLOWS", items: [{ to: "/approvals", label: "Approvals", icon: Inbox }] },
];

export function Shell() {
  const { resolved } = useTheme();
  const [about, setAbout] = useState(false);
  const [menu, setMenu] = useState(false);
  const loc = useLocation();
  const me = useQuery({ queryKey: ["me"], queryFn: apiClient.me, retry: false });
  const comp = useQuery({ queryKey: ["compliance"], queryFn: apiClient.compliance, retry: false });
  const health = useQuery({ queryKey: ["healthz"], queryFn: async () => (await fetch("/healthz")).ok, retry: false, refetchInterval: 30000 });
  const nonCompliant = comp.data ? comp.data.total - comp.data.compliant : 0;
  const live = health.data === true;

  // The slide-in menu (narrow screens) closes when a page is chosen and on Escape.
  useEffect(() => { setMenu(false); }, [loc.pathname]);
  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setMenu(false); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [menu]);

  return (
    <div className="mf gw-shell">
      <div className="gw-topbar">
        <button type="button" className="gw-iconbtn" aria-label="Open menu" aria-expanded={menu} aria-controls="gw-sidebar" onClick={() => setMenu(true)}><Menu size={18} aria-hidden="true" /></button>
        <WeaveMark size={18} theme={resolved} live={live} />
        <strong className="mf-disp" style={{ fontSize: 15 }}>{MODULES.gateway}</strong>
      </div>
      {menu && <button type="button" className="gw-navscrim" aria-label="Close menu" onClick={() => setMenu(false)} />}

      <aside id="gw-sidebar" className={`mf-side mf-s gw-side ${menu ? "gw-open" : ""}`}>
        <div style={{ padding: "2px 4px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
          <TraceItLogo variant="wordmark" theme={resolved} height={22} />
          <button type="button" className="gw-iconbtn gw-sideclose" style={{ width: 32, height: 32 }} aria-label="Close menu" onClick={() => setMenu(false)}><X size={16} aria-hidden="true" /></button>
        </div>

        <nav className="gw-nav" aria-label="Main">
          {/* The Weave section: the two modules of the product, side by side. */}
          <div className="gw-navgroup">
            <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "2px 10px 6px" }}>
              <span style={{ opacity: live ? 1 : 0.4, filter: live ? "none" : "grayscale(1)" }}><WeaveMark size={18} theme={resolved} live={live} /></span>
              <strong className="mf-disp" style={{ fontSize: 14 }}>{BRAND.section}</strong>
              <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: "0.08em", padding: "1px 6px", borderRadius: 999, background: "var(--accentWash)", color: "var(--accentText)" }}>NEW</span>
            </div>
            <span className="mf-nav mf-nav-on" aria-current="true" data-weave-module="gateway">
              <Waypoints size={17} aria-hidden="true" /><span style={{ flex: 1 }}>Gateway</span>
              <span style={{ fontSize: 11, fontWeight: 500, color: "var(--faint)" }}>This console</span>
            </span>
            {WEAVE_FACTORY_URL && (
              <a className="mf-nav" href={WEAVE_FACTORY_URL} target="_blank" rel="noreferrer" data-weave-module="factory">
                <Factory size={17} aria-hidden="true" /><span style={{ flex: 1 }}>Factory</span><ExternalLink size={14} aria-hidden="true" />
              </a>
            )}
          </div>
          {gatewayGroups.map((g) => (
            <div key={g.title} className="gw-navgroup">
              <span className="mf-mono gw-navtitle">{g.title}</span>
              {g.items.map((it) => (
                <NavLink key={it.to} to={it.to} end={it.end} className={({ isActive }) => `mf-nav ${isActive ? "mf-nav-on" : ""}`}>
                  <it.icon size={17} aria-hidden="true" /><span style={{ flex: 1 }}>{it.label}</span>
                  {it.label === "Compliance" && nonCompliant > 0 && (
                    <span style={{ fontSize: 11, fontWeight: 700, padding: "1px 7px", borderRadius: 999, background: "var(--badSoft)", color: "var(--bad)" }}>{nonCompliant}</span>
                  )}
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

      <main className="gw-main">
        <Outlet />
      </main>

      {about && (
        <div className="mf-scrim" role="dialog" aria-modal="true" aria-label={`About ${PRODUCT_NAME}`} onClick={() => setAbout(false)}
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.45)", display: "grid", placeItems: "center", zIndex: 50, padding: 16 }}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 18, padding: 32, maxWidth: 420, width: "100%", display: "flex", flexDirection: "column", gap: 14, alignItems: "center", textAlign: "center", boxShadow: "var(--shadow)" }}>
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
