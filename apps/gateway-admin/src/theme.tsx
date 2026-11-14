import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";

export type Mode = "light" | "dark" | "auto";
interface Ctx { mode: Mode; resolved: "light" | "dark"; setMode: (m: Mode) => void; }
const ThemeCtx = createContext<Ctx | null>(null);

function systemDark(): boolean {
  try { return matchMedia("(prefers-color-scheme: dark)").matches; } catch { return false; }
}
function read(): Mode {
  try { const v = localStorage.getItem("theme"); if (v === "light" || v === "dark" || v === "auto") return v; } catch { /* ignore */ }
  return "auto";
}
export function resolve(mode: Mode, sysDark: boolean): "light" | "dark" {
  return mode === "auto" ? (sysDark ? "dark" : "light") : mode;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<Mode>(read);
  const [sysDark, setSysDark] = useState<boolean>(systemDark);

  useEffect(() => {
    let mq: MediaQueryList | null = null;
    try {
      mq = matchMedia("(prefers-color-scheme: dark)");
      const h = (e: MediaQueryListEvent) => setSysDark(e.matches);
      mq.addEventListener("change", h);
      return () => mq?.removeEventListener("change", h);
    } catch { return; }
  }, []);

  const resolved = resolve(mode, sysDark);
  useEffect(() => { document.documentElement.dataset.theme = resolved; }, [resolved]);

  const setMode = useCallback((m: Mode) => {
    try { localStorage.setItem("theme", m); } catch { /* ignore */ }
    const apply = () => setModeState(m);
    try {
      const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (!reduce && (document as any).startViewTransition) { (document as any).startViewTransition(() => apply()); return; }
    } catch { /* ignore */ }
    apply();
  }, []);

  return <ThemeCtx.Provider value={{ mode, resolved, setMode }}>{children}</ThemeCtx.Provider>;
}

export function useTheme(): Ctx {
  const c = useContext(ThemeCtx);
  if (!c) throw new Error("useTheme outside ThemeProvider");
  return c;
}
