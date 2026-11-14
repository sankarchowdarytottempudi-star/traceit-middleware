import type { BrandTheme } from "./constants.ts";
/** The OFFICIAL TraceIT logo (static, never animated). Files from brand/weave. */
export function TraceItLogo({ variant = "wordmark", theme = "light", assetBase = "/brand", height }:
  { variant?: "wordmark" | "mark"; theme?: BrandTheme; assetBase?: string; height?: number }) {
  const file = variant === "mark" ? `traceit-mark-${theme}.svg` : `traceit-logo-${theme}.svg`;
  return <img src={`${assetBase}/${file}`} alt="TraceIT" style={{ height: height ?? (variant === "mark" ? 28 : 22), width: "auto", display: "block" }} />;
}
