import type { BrandTheme } from "./constants.ts";
import { IS_CRUISE_SAUDI, OWNER_NAME } from "./constants.ts";
import { TraceItLogo } from "./TraceItLogo.tsx";

/** The owner's logo in the top bar and side bar. TraceIT edition: the official TraceIT logo.
 *  Cruise Saudi edition: a text wordmark until Cruise Saudi's logo files are added (cruise-saudi-logo-*.svg). */
export function OwnerLogo({ variant = "wordmark", theme = "light", height }:
  { variant?: "wordmark" | "mark"; theme?: BrandTheme; height?: number }) {
  if (!IS_CRUISE_SAUDI) return <TraceItLogo variant={variant} theme={theme} height={height} />;
  const h = height ?? (variant === "mark" ? 28 : 22);
  const ink = theme === "dark" ? "#F2F7FB" : "#0C1B2A";
  return (
    <span data-owner-logo={variant} data-theme={theme} role="img" aria-label={OWNER_NAME}
      style={{ display: "inline-flex", alignItems: "center", height: h, lineHeight: 1, color: ink,
               fontWeight: 700, letterSpacing: "0.08em", fontSize: Math.round(h * 0.72), whiteSpace: "nowrap" }}>
      {variant === "mark" ? "CS" : "CRUISE SAUDI"}
    </span>
  );
}
