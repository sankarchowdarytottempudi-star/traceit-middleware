import type { BrandTheme } from "./constants.ts";
import { PRODUCT_NAME } from "./constants.ts";
/** Official lockup SVGs (brand/weave), served by the host app under assetBase. */
export function WeaveLockup({ variant = "primary", theme = "light", assetBase = "/brand", height }:
  { variant?: "primary" | "inline"; theme?: BrandTheme; assetBase?: string; height?: number }) {
  const src = `${assetBase}/weave-lockup-${variant}-${theme}.svg`;
  return <img src={src} alt={PRODUCT_NAME} style={{ height: height ?? (variant === "primary" ? 72 : 28), width: "auto", display: "block" }} />;
}
