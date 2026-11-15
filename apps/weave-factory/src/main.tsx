import { StrictMode, Component, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "@traceit/weave-brand/weave-brand.css";
import "./styles.css";
import { ThemeProvider } from "./theme.tsx";
import { App } from "./App.tsx";
import { PRODUCT_NAME } from "./brand.tsx";
import { BASE } from "./lib/base.ts";

document.title = PRODUCT_NAME;
const qc = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } });

class ErrorBoundary extends Component<{ children: ReactNode }, { err: Error | null }> {
  state = { err: null as Error | null };
  static getDerivedStateFromError(err: Error) { return { err }; }
  componentDidCatch(err: Error) { console.error("Weave crashed:", err); }
  render() {
    if (this.state.err) {
      return (
        <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", background: "var(--bg)", color: "var(--text)", fontFamily: "Inter, system-ui, sans-serif", padding: 24 }}>
          <div style={{ maxWidth: 480, textAlign: "center" }}>
            <h1 style={{ fontSize: 20, margin: "0 0 8px" }}>TraceIT Weave hit an error</h1>
            <p style={{ color: "var(--muted)", margin: "0 0 16px" }}>Something on this screen failed to render. Reload to try again; if it keeps happening, send the detail below to support.</p>
            <button onClick={() => { try { localStorage.clear(); } catch {} location.reload(); }} style={{ height: 40, padding: "0 20px", borderRadius: 10, border: "none", background: "var(--accent, #F2A62E)", color: "#0C1B2A", fontWeight: 600, cursor: "pointer" }}>Reload</button>
            <pre style={{ marginTop: 16, textAlign: "left", fontSize: 11, color: "var(--faint)", whiteSpace: "pre-wrap", overflow: "auto", maxHeight: 160 }}>{String(this.state.err?.message || this.state.err)}</pre>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <QueryClientProvider client={qc}>
        <ThemeProvider>
          <BrowserRouter basename={BASE || undefined}>
            <App />
          </BrowserRouter>
        </ThemeProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  </StrictMode>
);
