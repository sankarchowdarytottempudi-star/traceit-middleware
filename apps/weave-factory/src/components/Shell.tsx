import { at } from "../lib/base.ts";
import { useEffect, useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Boxes, ExternalLink, Info, LogOut, Menu, PanelLeftClose, PanelLeftOpen, UsersRound, X } from "lucide-react";
import type { NavGroup, NavItem } from "../nav.ts";
import { studioNav } from "../studio/routes.tsx";
import { migrateNav } from "../migrate/routes.tsx";
import { BRAND, WEAVE_GATEWAY_URL, WeaveMark, WeaveLockup, OwnerLogo, PRODUCT_NAME, TAGLINE, COMPANY_LINE } from "../brand.tsx";
import { useTheme } from "../theme.tsx";
import { ThemeSwitch } from "./ThemeSwitch.tsx";
import { api, rolesOf } from "../api.ts";
import { StudioHost } from "../studio/ui.tsx";

const groups: NavGroup[] = [...studioNav, ...migrateNav];

/** Screens that manage their own full-height layout (the flow canvas). */
function isBleed(pathname: string): boolean {
  return /^\/studio\/(flows|estate)\/[^/]+/.test(pathname);
}
function readCollapsed(): boolean {
  try { return localStorage.getItem("weave-side") === "rail"; } catch { return false; }
}
function currentLabel(pathname: string): string {
  let best: NavItem | null = null;
  for (const g of groups) for (const it of g.items) {
    const on = it.match ? it.match(pathname) : pathname === it.to || pathname.startsWith(it.to + "/");
    if (on && (!best || it.to.length > best.to.length)) best = it;
  }
  return best?.label ?? BRAND.section;
}

export function Shell() {
  const { resolved } = useTheme();
  const loc = useLocation();
  const [about, setAbout] = useState(false);
  const [open, setOpen] = useState(false);          // off-canvas drawer (small screens)
  const [rail, setRail] = useState(readCollapsed);  // icon-only rail (large screens)
  const me = useQuery({ queryKey: ["me"], queryFn: api.me, retry: false });
  const health = useQuery({ queryKey: ["healthz"], queryFn: async () => (await fetch(at("/healthz"))).ok, retry: false, refetchInterval: 30000 });
  const live = health.data === true;
  const roles = rolesOf(me.data);
  const roleWords = roles.length ? roles.map((r) => (r === "migration" ? "Migration" : r === "gateway" ? "Gateway" : "Admin")).join(" · ") : "No access";
  const usersUrl = WEAVE_GATEWAY_URL ? `${WEAVE_GATEWAY_URL.replace(/\/+$/, "")}/users` : "";
  const signOut = async () => { try { await fetch(at("/api/auth/logout"), { method: "POST", credentials: "include" }); } catch { /* signed out anyway */ } location.assign(at("/")); };
  const bleed = isBleed(loc.pathname);

  useEffect(() => { setOpen(false); }, [loc.pathname]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);
  const toggleRail = () => setRail((r) => { const n = !r; try { localStorage.setItem("weave-side", n ? "rail" : "full"); } catch { /* ignore */ } return n; });

  return (
    <div className={`mf mf-shell ${rail ? "mf-shell-rail" : ""}`}>
      <header className="mf-topbar">
        <button className="mf-topbtn" aria-label="Open menu" aria-expanded={open} onClick={() => setOpen(true)}><Menu size={20} /></button>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          <WeaveMark size={18} theme={resolved} live={live} />
          <strong className="mf-disp mf-topbar-title">{currentLabel(loc.pathname)}</strong>
        </span>
        <span style={{ flex: 1 }} />
        <span className="mf-topbar-brand"><OwnerLogo variant="wordmark" theme={resolved} height={16} /></span>
      </header>
      {open && <div className="mf-side-scrim" onClick={() => setOpen(false)} aria-hidden="true" />}
      <aside className={`mf-side mf-s ${open ? "mf-side-open" : ""}`} aria-label="Main navigation">
        <div className="mf-side-head">
          <span className="mf-side-logo"><OwnerLogo variant="wordmark" theme={resolved} height={22} /></span>
          <button className="mf-topbtn mf-side-close" aria-label="Close menu" onClick={() => setOpen(false)}><X size={18} /></button>
          <button className="mf-topbtn mf-side-rail" aria-label={rail ? "Expand sidebar" : "Collapse sidebar"} title={rail ? "Expand sidebar" : "Collapse sidebar"} onClick={toggleRail}>
            {rail ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}
          </button>
        </div>
        <div className="mf-side-product">
          <span style={{ opacity: live ? 1 : 0.4, filter: live ? "none" : "grayscale(1)", display: "inline-flex" }}><WeaveMark size={18} theme={resolved} live={live} /></span>
          <strong className="mf-disp mf-side-text" style={{ fontSize: 14 }}>{BRAND.section}</strong>
        </div>
        <nav className="mf-side-nav">
          <div className="mf-side-group">
            <span className="mf-mono mf-side-title">WEAVE</span>
            <span className="mf-nav mf-nav-on" aria-current="page" style={{ fontWeight: 600 }} title="Factory"><Boxes size={17} aria-hidden="true" /><span className="mf-side-text" style={{ flex: 1 }}>Factory</span></span>
            {WEAVE_GATEWAY_URL && roles.includes("gateway") && <a className="mf-nav" href={WEAVE_GATEWAY_URL} target="_blank" rel="noreferrer" title="Gateway"><ExternalLink size={17} aria-hidden="true" /><span className="mf-side-text" style={{ flex: 1 }}>Gateway</span></a>}
            {usersUrl && roles.includes("admin") && <a className="mf-nav" href={usersUrl} target="_blank" rel="noreferrer" title="Users and access (in the Gateway console)"><UsersRound size={17} aria-hidden="true" /><span className="mf-side-text" style={{ flex: 1 }}>Users and access</span></a>}
          </div>
          {groups.map((g) => (
            <div key={g.title} className="mf-side-group">
              <span className="mf-mono mf-side-title">{g.title}</span>
              {g.items.map((it) => (
                <NavLink key={it.to} to={it.to} end={it.end} title={it.label}
                  className={({ isActive }) => `mf-nav ${(it.match ? it.match(loc.pathname) : isActive) ? "mf-nav-on" : ""}`}>
                  <it.icon size={17} aria-hidden="true" /><span className="mf-side-text" style={{ flex: 1 }}>{it.label}</span>
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
        <div className="mf-side-foot">
          <div className="mf-side-text"><ThemeSwitch /></div>
          <div className="mf-side-user">
            <span className="mf-side-avatar">{(me.data?.user ?? "?").slice(0, 1).toUpperCase()}</span>
            <span className="mf-side-text" style={{ display: "flex", flexDirection: "column", lineHeight: 1.2, minWidth: 0, flex: 1 }}>
              <strong style={{ fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={me.data?.email || me.data?.user}>{me.data?.name || me.data?.user || "Not signed in"}</strong>
              <span style={{ fontSize: 11.5, color: "var(--faint)" }}>{me.data ? roleWords : "—"}</span>
            </span>
            <button className="mf-btn mf-gho mf-side-text" aria-label="Sign out" title="Sign out" onClick={signOut} style={{ width: 30, height: 30, borderRadius: 8, border: "1px solid var(--border)", background: "var(--surface)", cursor: "pointer", display: "grid", placeItems: "center", flex: "0 0 auto" }}><LogOut size={15} /></button>
            <button className="mf-btn mf-gho mf-side-text" aria-label="About" onClick={() => setAbout(true)} style={{ width: 30, height: 30, borderRadius: 8, border: "1px solid var(--border)", background: "var(--surface)", cursor: "pointer", display: "grid", placeItems: "center", flex: "0 0 auto" }}><Info size={15} /></button>
          </div>
        </div>
      </aside>
      <main className={`mf-main ${bleed ? "mf-main-bleed" : ""}`}><Outlet /></main>
      <StudioHost />
      {about && (
        <div className="mf-scrim" role="dialog" aria-modal="true" aria-label={`About ${PRODUCT_NAME}`} onClick={() => setAbout(false)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.45)", display: "grid", placeItems: "center", zIndex: 90, padding: 16 }}>
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
