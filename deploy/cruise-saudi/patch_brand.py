from pathlib import Path
R = Path("/root/traceit-middleware")
def sub(p, old, new, n=1):
    f = R / p; t = f.read_text()
    assert t.count(old) == n, (p, old[:70], t.count(old)); f.write_text(t.replace(old, new))
# lockup: Cruise Saudi edition = Weave mark + "Weave" + "by Cruise Saudi" as text
f = R / "packages/weave-brand/src/WeaveLockup.tsx"; t = f.read_text()
t = t.replace('import { PRODUCT_NAME } from "./constants.ts";', 'import { IS_CRUISE_SAUDI, OWNER_NAME, PRODUCT_NAME } from "./constants.ts";\nimport { WeaveMark } from "./WeaveMark.tsx";')
old = '''  const Svg = MAP[`${variant}-${theme}`];
  const h = height ?? (variant === "primary" ? 72 : 28);'''
assert t.count(old) == 1
t = t.replace(old, '''  const h = height ?? (variant === "primary" ? 72 : 28);
  if (IS_CRUISE_SAUDI) {
    const ink = theme === "dark" ? "#F2F7FB" : "#0C1B2A";
    const muted = theme === "dark" ? "rgba(242,247,251,0.7)" : "rgba(12,27,42,0.62)";
    return (
      <span data-weave-lockup={variant} data-theme={theme} role="img" aria-label={PRODUCT_NAME}
        style={{ display: "inline-flex", alignItems: "center", gap: Math.round(h * 0.18), height: h, lineHeight: 1 }}>
        <WeaveMark size={Math.round(h * (variant === "primary" ? 0.78 : 0.9))} theme={theme} />
        <span style={{ display: "inline-flex", flexDirection: "column", alignItems: "flex-start" }}>
          <span style={{ color: ink, fontWeight: 800, fontSize: Math.round(h * (variant === "primary" ? 0.5 : 0.62)), letterSpacing: "-0.01em" }}>Weave</span>
          {variant === "primary" && <span style={{ color: muted, fontSize: Math.round(h * 0.17), fontWeight: 600, letterSpacing: "0.06em" }}>by {OWNER_NAME}</span>}
        </span>
      </span>
    );
  }
  const Svg = MAP[`${variant}-${theme}`];''')
f.write_text(t)
sub("packages/weave-brand/src/index.ts", 'export { TraceItLogo } from "./TraceItLogo.tsx";', 'export { TraceItLogo } from "./TraceItLogo.tsx";\nexport { OwnerLogo } from "./OwnerLogo.tsx";')
for app in ("weave-factory", "gateway-admin"):
    b = R / f"apps/{app}/src/brand.tsx"; t = b.read_text()
    t = t.replace("export { PRODUCT_NAME, MODULES, TAGLINE, COMPANY_LINE } from", "export { PRODUCT_NAME, MODULES, TAGLINE, COMPANY_LINE, SIGN_IN_LABEL, OWNER_NAME } from")
    t = t.replace("TraceItLogo } from \"@traceit/weave-brand\";", "TraceItLogo, OwnerLogo } from \"@traceit/weave-brand\";")
    t = t.replace('This app is the "Factory" area of TraceIT Weave.', 'This app is the "Factory" area of Weave.')
    b.write_text(t)
    s = R / f"apps/{app}/src/components/Shell.tsx"; t = s.read_text()
    t = t.replace("TraceItLogo, PRODUCT_NAME", "OwnerLogo, PRODUCT_NAME").replace("<TraceItLogo ", "<OwnerLogo ")
    s.write_text(t)
    a = R / f"apps/{app}/src/App.tsx"; t = a.read_text()
    assert t.count(">Sign in with WSO2</a>") == 1, app
    t = t.replace(">Sign in with WSO2</a>", ">{SIGN_IN_LABEL}</a>")
    a.write_text(t)
    m = R / f"apps/{app}/src/main.tsx"; t = m.read_text()
    assert t.count(">TraceIT Weave hit an error</h1>") == 1, app
    t = t.replace(">TraceIT Weave hit an error</h1>", ">{PRODUCT_NAME} hit an error</h1>")
    m.write_text(t)
    h = R / f"apps/{app}/index.html"; t = h.read_text()
    t = t.replace("<title>TraceIT Weave</title>", "<title>Weave</title>").replace(">TraceIT Weave could not load</h1>", ">Weave could not load</h1>")
    h.write_text(t)
print("ok")
