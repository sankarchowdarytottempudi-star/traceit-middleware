import { useTheme, type Mode } from "../theme.tsx";
const opts: { id: Mode; label: string }[] = [{ id: "light", label: "Light" }, { id: "dark", label: "Dark" }, { id: "auto", label: "Auto" }];
export function ThemeSwitch() {
  const { mode, setMode } = useTheme();
  return (
    <div role="group" aria-label="Theme" style={{ display: "inline-flex", gap: 3, padding: 3, borderRadius: 10, background: "var(--surface2)", border: "1px solid var(--border)" }}>
      {opts.map((o) => (
        <button key={o.id} className={`mf-seg mf-btn ${mode === o.id ? "mf-seg-on" : ""}`} aria-pressed={mode === o.id}
          onClick={() => setMode(o.id)} style={{ height: 28, padding: "0 10px", borderRadius: 7, fontSize: 12, fontWeight: 600 }}>{o.label}</button>
      ))}
    </div>
  );
}
