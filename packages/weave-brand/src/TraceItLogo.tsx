import type { BrandTheme } from "./constants.ts";
import WordmarkLight from "./svg/traceit-logo-light.svg?react";
import WordmarkDark from "./svg/traceit-logo-dark.svg?react";
import MarkLight from "./svg/traceit-mark-light.svg?react";
import MarkDark from "./svg/traceit-mark-dark.svg?react";

const MAP = {
  "wordmark-light": WordmarkLight, "wordmark-dark": WordmarkDark,
  "mark-light": MarkLight, "mark-dark": MarkDark,
} as const;

/** The OFFICIAL TraceIT logo, inline SVG (via vite-plugin-svgr), static - never animated. */
export function TraceItLogo({ variant = "wordmark", theme = "light", height }:
  { variant?: "wordmark" | "mark"; theme?: BrandTheme; height?: number }) {
  const Svg = MAP[`${variant}-${theme}`];
  const h = height ?? (variant === "mark" ? 28 : 22);
  return (
    <span data-traceit-logo={variant} data-theme={theme} role="img" aria-label="TraceIT"
      style={{ display: "inline-flex", height: h, lineHeight: 0 }}>
      <Svg aria-hidden style={{ height: "100%", width: "auto", display: "block" }} />
    </span>
  );
}
