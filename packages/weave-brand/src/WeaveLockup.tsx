import type { BrandTheme } from "./constants.ts";
import { PRODUCT_NAME } from "./constants.ts";
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
  const Svg = MAP[`${variant}-${theme}`];
  const h = height ?? (variant === "primary" ? 72 : 28);
  return (
    <span data-weave-lockup={variant} data-theme={theme} role="img" aria-label={PRODUCT_NAME}
      style={{ display: "inline-flex", height: h, lineHeight: 0 }}>
      <Svg aria-hidden style={{ height: "100%", width: "auto", display: "block" }} />
    </span>
  );
}
