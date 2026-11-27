# Target: React Native mobile app

## 1. What it is / artifacts
A React Native app for iOS and Android. Defaults (existing project conventions win):
**Expo** (managed workflow + development builds; EAS Build/Submit) · TypeScript strict · **Expo Router** (file-based) or React Navigation when the project uses it · **TanStack Query** for server state, Zustand (or Redux Toolkit if already used) for client state · `react-hook-form` + `zod` for forms · `expo-secure-store` for tokens · MMKV/SQLite for offline data · `expo-notifications` for push · i18n (`i18next`) · Jest + React Native Testing Library; Maestro (or Detox) for E2E.
Layout: `app/` (routes), `src/features/<feature>/{screens,components,api,hooks,state}`, `src/design/` (tokens, components), `src/api/` (clients generated from OpenAPI where available).
One unit = one screen + its data calls, or one background/push/deeplink handler.

## 2. Neutral → React Native
| Neutral | RN |
|---|---|
| ui.screen | route file + screen component with all states: loading (skeleton), empty, error (retry), success, offline |
| ui.navigate | router push/replace/tabs/stack/modal; deep link path per screen |
| ui.state | local state / Zustand store / query cache |
| http.request | typed API client (generated from OpenAPI) via TanStack Query (cache, retry rules from spec) |
| logic.validate | zod schema shared with the form |
| notify (push) | expo-notifications (FCM/APNs), permission flow, tap → deep link |
| file.* | expo-file-system, expo-document-picker, image-picker/camera with permission flows |
| auth | OAuth/OIDC via `expo-auth-session`; tokens in secure store; refresh on 401 |
| analytics | the source's events, same names |

## 3. Triggers
App launch, screen route, deep link / universal link / app link, push tap, background fetch/task (`expo-background-task` or equivalent — confirm platform limits), app state change (foreground/background).

## 4. Systems
Backend APIs (base URL per environment via app config/EAS env), identity provider, push service, analytics, crash reporting (Sentry), feature flags if the source had them.

## 5. Data
Server state cached with explicit stale times; offline: queue mutations when the source supports offline, else show the offline state; never store secrets outside secure storage; PII per policy.

## 6. Error handling
Per screen: error state with retry; global error boundary; API errors mapped to user messages from the spec; crash reporting; background task failures logged and retried per platform rules. Core §8.4 modes apply to background units.

## 7. Config
`app.config.ts` + EAS environment variables per build profile (development/preview/production); bundle ids, schemes, push credentials, API URLs; no secrets in the bundle (anything in the app is public).

## 8. Packaging / deploy / start
EAS Build for iOS/Android; development build for testing; start check: app installs and launches on both platforms, every route renders all states, deep links open the right screen, push received and tapped. Store submission (accounts, certificates, listing) → credentials/money → human.

## 9. Tests
Component tests per screen state; hook tests for data logic; Maestro/Detox E2E per main flow on both platforms; accessibility checks (labels, roles, contrast, dynamic type); snapshot of design tokens.

## 10. Target gates
Every screen in the spec exists with all five states · every navigation edge from the spec works · deep link per screen that the source linked to · no hard-coded API URLs or secrets · `tsc` and lint clean · E2E green on iOS and Android · accessibility labels on all interactive elements.

## 11. Traps / confirm first
Platform permission texts (iOS usage descriptions) · background execution limits (iOS) · push credentials · Expo SDK upgrade cadence (pin) · native modules not available in Expo Go (use dev builds) · store review rules (login, payments, account deletion).

## 12. Lessons
(empty — add from the first RN fixture)
