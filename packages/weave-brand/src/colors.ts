import type { BrandTheme } from "./constants.ts";
/** Weave mark palette per BRAND.md. */
export function weaveColors(theme: BrandTheme) {
  return theme === "dark"
    ? { goldA: "#C97609", goldB: "#F3D9A8", ink: "#F2F7FB", knot: "#F2A62E", secondary: "rgba(143,166,188,0.55)" }
    : { goldA: "#8A5A08", goldB: "#F2A62E", ink: "#0C1B2A", knot: "#C97609", secondary: "rgba(12,27,42,0.55)" };
}
