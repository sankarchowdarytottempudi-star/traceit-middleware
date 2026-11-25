import { at } from "./lib/base.ts";
import { Routes, Route, Navigate, useLocation } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Shell } from "./components/Shell.tsx";
import { api, rolesOf } from "./api.ts";
import { WeaveLockup, WeaveMark, TAGLINE, COMPANY_LINE, SIGN_IN_LABEL, WEAVE_GATEWAY_URL } from "./brand.tsx";
import { useTheme } from "./theme.tsx";
import { migrateRoutes } from "./migrate/routes.tsx";
import { studioRoutes } from "./studio/routes.tsx";
import { ReviewApp } from "./review/ReviewApp.tsx";

function SignIn() {
  const { resolved } = useTheme();
  return (
    <div className="mf" style={{ minHeight: "100vh", display: "grid", placeItems: "center", background: "var(--bg)" }}>
      <div className="mf-in" style={{ display: "flex", flexDirection: "column", gap: 18, alignItems: "center", padding: 44, borderRadius: 20, background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--shadow)", maxWidth: 420, textAlign: "center" }}>
        <WeaveMark size={56} theme={resolved} animated live />
        <WeaveLockup variant="primary" theme={resolved} height={48} />
        <p style={{ margin: 0, color: "var(--muted)" }}>{TAGLINE}</p>
        <a className="mf-btn mf-pri" href={at("/api/auth/login")} style={{ height: 44, padding: "0 22px", display: "inline-flex", alignItems: "center", borderRadius: 10, background: "var(--accent)", color: "var(--onAccent)", fontWeight: 600, textDecoration: "none" }}>{SIGN_IN_LABEL}</a>
        <p style={{ margin: 0, fontSize: 12, color: "var(--faint)" }}>{COMPANY_LINE}</p>
      </div>
    </div>
  );
}

/** Signed in, but not given the Migration (Factory) area. The server refuses its calls as well. */
function NoMigrationAccess({ gateway }: { gateway: boolean }) {
  const { resolved } = useTheme();
  const signOut = async () => { try { await fetch(at("/api/auth/logout"), { method: "POST", credentials: "include" }); } catch { /* ignore */ } location.assign(at("/")); };
  return (
    <div className="mf" style={{ minHeight: "100vh", display: "grid", placeItems: "center", background: "var(--bg)", padding: 16 }}>
      <div className="mf-in" role="alert" style={{ display: "flex", flexDirection: "column", gap: 16, alignItems: "center", padding: 40, borderRadius: 20, background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--shadow)", maxWidth: 440, textAlign: "center" }}>
        <WeaveMark size={44} theme={resolved} />
        <h1 style={{ margin: 0, fontSize: 22 }}>No access to the Factory</h1>
        <p style={{ margin: 0, color: "var(--muted)" }}>Your account has not been given the Migration (Factory) area. Ask an administrator if you need it.</p>
        {gateway && WEAVE_GATEWAY_URL && <a className="mf-btn mf-pri" href={WEAVE_GATEWAY_URL} style={{ height: 42, padding: "0 20px", display: "inline-flex", alignItems: "center", borderRadius: 10, background: "var(--accent)", color: "var(--onAccent)", fontWeight: 600, textDecoration: "none" }}>Open the Gateway console</a>}
        <button className="mf-btn mf-gho" onClick={signOut} style={{ height: 38, padding: "0 18px", borderRadius: 9, border: "1px solid var(--border)", background: "var(--surface)", cursor: "pointer" }}>Sign out</button>
      </div>
    </div>
  );
}

export function App() {
  // The Manual Review Workbench is its own page (shown in a CRM Web Tab) with its own Zoho sign-in.
  // It is not in the navigation, and the server only serves it while its feature flag is on.
  const { pathname } = useLocation();
  if (pathname === "/review" || pathname.startsWith("/review/")) return <ReviewApp />;
  return <FactoryApp />;
}

function FactoryApp() {
  const me = useQuery({ queryKey: ["me"], queryFn: api.me, retry: false });
  if (me.isLoading) return <div className="mf" style={{ minHeight: "100vh", background: "var(--bg)" }} />;
  if (me.isError) return <SignIn />;
  if (!rolesOf(me.data).includes("migration")) return <NoMigrationAccess gateway={rolesOf(me.data).includes("gateway")} />;
  return (
    <Routes>
      <Route element={<Shell />}>
        <Route index element={<Navigate to="/migrations" replace />} />
        {migrateRoutes()}
        {studioRoutes()}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
