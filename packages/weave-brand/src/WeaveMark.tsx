import { useId } from "react";
import type { BrandTheme } from "./constants.ts";
import { weaveColors } from "./colors.ts";
import { PRODUCT_NAME } from "./constants.ts";

/** Exact paths from BRAND.md (viewBox 0 0 64 64, stroke 4.2, round caps). */
export const THREAD_A = "M8 46 C16 22 23 16 32 32 S48 44 56 18";
export const THREAD_B = "M8 18 C16 42 23 48 32 32 S48 20 56 46";

export interface WeaveMarkProps { size?: number; theme?: BrandTheme; animated?: boolean; live?: boolean; title?: string; }

export function WeaveMark({ size = 24, theme = "light", animated = false, live = false, title = PRODUCT_NAME }: WeaveMarkProps) {
  const id = useId().replace(/:/g, "");
  const c = weaveColors(theme);
  const gid = `wg-${id}`;
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" role="img" aria-label={title} fill="none">
      <style>{`
        @media (prefers-reduced-motion: no-preference) {
          ${animated ? `
          .${id}-a,.${id}-b{stroke-dasharray:90;stroke-dashoffset:90;animation:${id}draw 2s cubic-bezier(.16,1,.3,1) forwards}
          .${id}-b{animation-delay:.25s}
          @keyframes ${id}draw{to{stroke-dashoffset:0}}` : ``}
          ${live ? `
          .${id}-flow{animation:${id}flow 1.6s linear infinite}
          @keyframes ${id}flow{to{stroke-dashoffset:-24}}
          .${id}-knot{transform-box:fill-box;transform-origin:center;animation:${id}breathe 2.4s ease-in-out infinite}
          @keyframes ${id}breathe{0%,100%{transform:scale(1)}50%{transform:scale(1.3)}}` : ``}
        }
      `}</style>
      <defs>
        <linearGradient id={gid} x1="8" y1="46" x2="56" y2="18" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor={c.goldA} /><stop offset="1" stopColor={c.goldB} />
        </linearGradient>
      </defs>
      <circle cx="56" cy="18" r="9" fill={c.knot} opacity="0.16" />
      <path className={`${id}-b`} d={THREAD_B} stroke={c.ink} strokeWidth="4.2" strokeLinecap="round" />
      <path className={`${id}-a`} d={THREAD_A} stroke={`url(#${gid})`} strokeWidth="4.2" strokeLinecap="round" />
      {live && <path className={`${id}-flow`} d={THREAD_A} stroke={c.goldB} strokeWidth="4.2" strokeLinecap="round" strokeDasharray="3 9" opacity="0.9" />}
      <circle cx="8" cy="46" r="4.2" fill={c.goldA} />
      <circle cx="8" cy="18" r="3.6" fill={c.secondary} />
      <circle cx="56" cy="46" r="3.6" fill={c.secondary} />
      <circle cx="56" cy="18" r="4.8" fill={c.knot} />
      <circle className={`${id}-knot`} cx="32" cy="32" r="5.2" fill={c.knot} />
    </svg>
  );
}
