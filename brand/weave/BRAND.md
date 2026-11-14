# TraceIT Weave: brand guide for developers

## Name
- Public / legal / first mention: **TraceIT Weave**. Never "Weave" alone outside the app, and never "WSO2 Weave".
- Modules: **Weave Factory** (API migration to WSO2 on Kubernetes; formerly "Migration Tool" / "Migration Factory") and **Weave Gateway** (API Gateway Admin for WSO2 API-M).
- Inside the TraceIT app (where the TraceIT logo is already visible), "Weave", "Factory" and "Gateway" alone are fine.
- Tagline: "Monitor it. Weave it."
- Footer / about: "TraceIT Weave is a product of Tottempudi Software Solutions Pvt Ltd".

## The TraceIT logo
The OFFICIAL TraceIT logo is the one served at traceit-tottech.com/brand/traceit-wordmark-{light,dark}.svg: a gold network trace with round nodes and grey secondary links, plus "Trace" in navy and "IT" in a gold gradient. Copies are included here as traceit-logo-light.svg / traceit-logo-dark.svg (wordmark) and traceit-mark-light.svg / traceit-mark-dark.svg (mark only).
- The thin amber "wave" line used in earlier design mock-ups is NOT the TraceIT logo. Remove it everywhere.
- Inside the TraceIT repo, always use the repo's own /brand files. The copies here are for apps outside that repo.

## Files (all SVG, text already converted to shapes, so no font is needed)
| File | Use |
|---|---|
| weave-lockup-primary-light.svg / -dark.svg | Sign-in, splash, About, marketing. "Weave" with "by [TraceIT logo]". Minimum width 260 px. |
| weave-lockup-inline-light.svg / -dark.svg | App header, docs, emails: "[TraceIT logo] \| Weave". Minimum height 28 px. |
| weave-mark-light.svg / -dark.svg | Sidebar item icon, loaders, small spaces. Minimum 16 px. |
| traceit-logo-*.svg, traceit-mark-*.svg | The official TraceIT logo (see above). |
| weave-app-icon.svg (+ png/weave-app-icon-1024.png) | PWA / Android / store icon. |
| favicon.svg (+ png/favicon.png) | Browser tab. |
Use the -light files on light backgrounds and the -dark files on dark backgrounds. Leave clear space of at least 1× the height of the knot dot all round, and never stretch, recolour or re-letter the logos.

## Colours (taken from the official TraceIT logo)
| Role | Light | Dark |
|---|---|---|
| Ink (text, Weave thread B) | #0C1B2A | #F2F7FB |
| Gold gradient (thread A, "IT") | #8A5A08 → #F2A62E | #C97609 → #F3D9A8 |
| End node / knot | #C97609 | #F2A62E |
| Secondary nodes | ink at 55% opacity | #8FA6BC at 55% |
| Accent text on light UI (contrast safe) | #8A5A08 | #F2A62E |

## Weave mark geometry (viewBox 0 0 64 64, stroke 4.2, round caps)
- Thread A (gold gradient from #8A5A08 at 8,46 to #F2A62E at 56,18): `M8 46 C16 22 23 16 32 32 S48 44 56 18`
- Thread B (ink): `M8 18 C16 42 23 48 32 32 S48 20 56 46`
- Nodes: start of A (8,46) r4.2 gold-dark; ends of B (8,18) and (56,46) r3.6 ink 55%; end of A (56,18) r4.8 #C97609 with a halo r9 at 16% opacity; knot (32,32) r5.2 #C97609.
- The node style deliberately echoes the TraceIT mark, so the two read as one family.

## Motion (animated mark component only)
- On mount, the threads draw in: stroke-dasharray 90, dashoffset 90 → 0, 2s, cubic-bezier(.16,1,.3,1), with thread B starting 250ms later.
- While the system is live: a light dash overlay on thread A (stroke-dasharray "3 9", dashoffset 0 → -24, 1.6s linear, infinite) looks like data flowing.
- The knot breathes (scale 1 → 1.3 → 1, 2.4s ease-in-out, infinite).
- All motion is off under prefers-reduced-motion.

Reference sheet: design/weave-brand/Weave.dc.html
