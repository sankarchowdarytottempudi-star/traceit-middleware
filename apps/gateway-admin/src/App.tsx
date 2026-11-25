import { Routes, Route } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Shell } from "./components/Shell.tsx";
import { apiClient } from "./api.ts";
import { WeaveLockup, WeaveMark, TAGLINE, COMPANY_LINE, SIGN_IN_LABEL } from "./brand.tsx";
import { useTheme } from "./theme.tsx";
import { Overview } from "./screens/Overview.tsx";
import { RateLimits } from "./screens/RateLimits.tsx";
import { Compliance } from "./screens/Compliance.tsx";
import { Gateways } from "./screens/Gateways.tsx";
import { Approvals } from "./screens/Approvals.tsx";
import { Apis } from "./screens/Apis.tsx";
import { Analytics } from "./screens/Analytics.tsx";
import { ApiAnalytics } from "./screens/ApiAnalytics.tsx";
import { GatewayAnalytics } from "./screens/GatewayAnalytics.tsx";
import { Logs } from "./screens/Logs.tsx";
import { ApiRules } from "./screens/ApiRules.tsx";
import { Blocking } from "./screens/Blocking.tsx";
import { Applications } from "./screens/Applications.tsx";
import { Coverage } from "./screens/Coverage.tsx";
import { PolicyLibrary } from "./screens/PolicyLibrary.tsx";
import { GatewaySettings } from "./screens/GatewaySettings.tsx";

function SignIn() {
  const { resolved } = useTheme();
  return (
    <div className="mf" style={{ minHeight: "100vh", display: "grid", placeItems: "center", background: "var(--bg)" }}>
      <div className="mf-in" style={{ display: "flex", flexDirection: "column", gap: 18, alignItems: "center", padding: 44, borderRadius: 20, background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--shadow)", maxWidth: 420, textAlign: "center" }}>
        <WeaveMark size={56} theme={resolved} animated live />
        <WeaveLockup variant="primary" theme={resolved} height={48} />
        <p style={{ margin: 0, color: "var(--muted)" }}>{TAGLINE}</p>
        <a className="mf-btn mf-pri" href="/api/auth/login" style={{ height: 44, padding: "0 22px", display: "inline-flex", alignItems: "center", borderRadius: 10, background: "var(--accent)", color: "var(--onAccent)", fontWeight: 600, textDecoration: "none" }}>{SIGN_IN_LABEL}</a>
        <p style={{ margin: 0, fontSize: 12, color: "var(--faint)" }}>{COMPANY_LINE}</p>
      </div>
    </div>
  );
}

export function App() {
  const me = useQuery({ queryKey: ["me"], queryFn: apiClient.me, retry: false });
  if (me.isLoading) return <div className="mf" style={{ minHeight: "100vh", background: "var(--bg)" }} />;
  if (me.isError) return <SignIn />;
  return (
    <Routes>
      <Route element={<Shell />}>
        <Route index element={<Overview />} />
        <Route path="rate-limits" element={<RateLimits />} />
        <Route path="gateways" element={<Gateways />} />
        <Route path="apis" element={<Apis />} />
        <Route path="apis/:id" element={<ApiRules />} />
        <Route path="blocking" element={<Blocking />} />
        <Route path="applications" element={<Applications />} />
        <Route path="coverage" element={<Coverage />} />
        <Route path="policy-library" element={<PolicyLibrary />} />
        <Route path="settings" element={<GatewaySettings />} />
        <Route path="analytics" element={<Analytics />} />
        <Route path="analytics/api/:name" element={<ApiAnalytics />} />
        <Route path="gateway-analytics" element={<GatewayAnalytics />} />
        <Route path="logs" element={<Logs />} />
        <Route path="compliance" element={<Compliance />} />
        <Route path="approvals" element={<Approvals />} />
      </Route>
    </Routes>
  );
}
