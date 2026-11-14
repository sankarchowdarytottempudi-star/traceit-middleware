import { Routes, Route, Navigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Shell } from "./components/Shell.tsx";
import { api } from "./api.ts";
import { WeaveLockup, WeaveMark, TAGLINE, COMPANY_LINE } from "./brand.tsx";
import { useTheme } from "./theme.tsx";
import { migrateRoutes } from "./migrate/routes.tsx";
import { studioRoutes } from "./studio/routes.tsx";

function SignIn() {
  const { resolved } = useTheme();
  return (
    <div className="mf" style={{ minHeight: "100vh", display: "grid", placeItems: "center", background: "var(--bg)" }}>
      <div className="mf-in" style={{ display: "flex", flexDirection: "column", gap: 18, alignItems: "center", padding: 44, borderRadius: 20, background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--shadow)", maxWidth: 420, textAlign: "center" }}>
        <WeaveMark size={56} theme={resolved} animated live />
        <WeaveLockup variant="primary" theme={resolved} height={48} />
        <p style={{ margin: 0, color: "var(--muted)" }}>{TAGLINE}</p>
        <a className="mf-btn mf-pri" href="/api/auth/login" style={{ height: 44, padding: "0 22px", display: "inline-flex", alignItems: "center", borderRadius: 10, background: "var(--accent)", color: "var(--onAccent)", fontWeight: 600, textDecoration: "none" }}>Sign in with WSO2</a>
        <p style={{ margin: 0, fontSize: 12, color: "var(--faint)" }}>{COMPANY_LINE}</p>
      </div>
    </div>
  );
}

export function App() {
  const me = useQuery({ queryKey: ["me"], queryFn: api.me, retry: false });
  if (me.isLoading) return <div className="mf" style={{ minHeight: "100vh", background: "var(--bg)" }} />;
  if (me.isError) return <SignIn />;
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
