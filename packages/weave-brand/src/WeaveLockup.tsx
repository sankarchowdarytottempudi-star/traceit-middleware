import type { BrandTheme } from "./constants.ts";
import { IS_CRUISE_SAUDI, OWNER_NAME, PRODUCT_NAME } from "./constants.ts";
import { WeaveMark } from "./WeaveMark.tsx";
import PrimaryLight from "./svg/weave-lockup-primary-light.svg?react";
import PrimaryDark from "./svg/weave-lockup-primary-dark.svg?react";
import InlineLight from "./svg/weave-lockup-inline-light.svg?react";
import InlineDark from "./svg/weave-lockup-inline-dark.svg?react";

const MAP = {
  "primary-light": PrimaryLight, "primary-dark": PrimaryDark,
  "inline-light": InlineLight, "inline-dark": InlineDark,
} as const;

/** The Weave lockup, inline SVG (via vite-plugin-svgr), theme-selected. */
export function WeaveLockup({ variant = "primary", theme = "light", height }:
  { variant?: "primary" | "inline"; theme?: BrandTheme; height?: number }) {
  const h = height ?? (variant === "primary" ? 72 : 28);
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
  const Svg = MAP[`${variant}-${theme}`];
  return (
    <span data-weave-lockup={variant} data-theme={theme} role="img" aria-label={PRODUCT_NAME}
      style={{ display: "inline-flex", height: h, lineHeight: 0 }}>
      <Svg aria-hidden style={{ height: "100%", width: "auto", display: "block" }} />
    </span>
  );
}
