# Web ↔ mobile migration (either direction)

Use with `apps/react-native.md` (mobile target) or a web target (default: **Next.js + React + TypeScript**, Tailwind, TanStack Query, App Router; existing conventions win).

## 1. Extra review-workbook sheets for apps
| Sheet | Columns |
|---|---|
| Screens | ID, Name, Route/Path, Purpose, Data calls, States (loading/empty/error/success/offline), Roles, Source |
| Navigation | ID, From, To, Trigger (tap/link/redirect/push/deeplink), Condition, Source |
| States | ID, Screen, State, What the user sees, Copy, Source |
| Assets | ID, Kind (icon/image/font/animation/copy), Name, Where used, Source |
Rows follow the same Action rules as every sheet (core §6).

## 2. Reading the source app
Inventory, per screen: route, components, API calls (method, path, payload), form fields + validation, roles/permissions, analytics events, feature flags, copy/i18n keys, device features used, offline behaviour. From code, every item cites `file:line`. Behaviour in the backend stays in the backend — migrate the client, not the server, unless asked.

## 3. Mapping rules

### Web → mobile
| Web | Mobile |
|---|---|
| Page/route | Screen + route; group into tabs/stacks by the source's primary navigation |
| Top/side nav | Tab bar (≤ 5 primary), stack for drill-down, drawer only if the source has many sections |
| Hover, tooltips | Long-press / info buttons |
| Tables | Lists/cards with detail screen; keep sort/filter |
| Multi-column forms | Single-column, stepper for long forms; native pickers/keyboards per field type |
| Cookies/session auth | OIDC + tokens in secure storage; refresh flow |
| File download/upload | Share sheet / document picker / camera |
| Browser notifications / e-mail links | Push notifications + deep links to the same content |
| SEO, SSR | Not applicable — drop and list as deliberate |
| Responsive breakpoints | Phone + tablet layouts; respect safe areas, dynamic type |

### Mobile → web
| Mobile | Web |
|---|---|
| Screen | Route/page (SSR/SSG where the content is public — SEO) |
| Tabs/stack | Header/side navigation, breadcrumbs, browser back must work |
| Gestures (swipe, pull-to-refresh) | Buttons/links, refresh control |
| Push notifications | Web Push (where supported) + e-mail; state the gap for iOS Safari limits |
| Camera, biometrics, contacts, background location | `getUserMedia`, WebAuthn/passkeys; contacts/background location usually no equivalent → deliberate change or open question |
| Offline-first local DB | Service worker + IndexedDB if offline is required; else online-only, stated |
| Secure storage tokens | HttpOnly secure cookies via a BFF, not localStorage |
| Deep links | URLs (every screen addressable) |
| App store distribution | Deploy pipeline (Vercel/containers/CDN) |

## 4. Always preserve
User flows and their order · business validation and error messages · roles/permissions · analytics event names · accessibility (WCAG 2.2 AA web; platform accessibility mobile) · copy and translations · legal (consent, account deletion, privacy).

## 5. Design
Use the source design system mapped to target tokens (colour, type, spacing, radius). Every screen has loading/empty/error/success (+offline on mobile) states. A redesign is a customer decision — without approval, keep the visual language and adapt only platform conventions; record adaptations as deliberate changes.

## 6. Gates (in addition to the target app gates)
Every source screen mapped (or deliberately dropped with reason) · every navigation edge reachable · every API call from the source used by the target with the same contract · analytics parity list · accessibility checks pass · feature-gap list (no equivalent) reviewed by the customer.

## 7. Tests
E2E per primary user flow written once against the spec and run on the target (Playwright for web, Maestro/Detox for mobile); visual regression on key screens; parity checklist from the Screens sheet.

## 8. Lessons
(empty — add from the first app fixture)
