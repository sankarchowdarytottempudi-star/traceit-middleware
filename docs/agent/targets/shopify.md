# Target: Shopify

Shopify work comes in three shapes; identify which before building:
**(a) store/data migration** (products, variants, customers, orders, inventory, redirects into Shopify), **(b) integrations** (ERP/WMS/PIM/CRM ↔ Shopify), **(c) custom app / storefront behaviour** (app, Functions, checkout/theme extensions, Flow).

## 1. What it is / artifacts
- **Admin GraphQL API** (primary; REST Admin is legacy) — versioned quarterly; pin a supported version.
- **Webhooks** (topics such as orders/create, products/update) delivered to HTTPS, EventBridge or Pub/Sub; subscriptions via API or app config.
- **Bulk operations** (GraphQL bulk query/mutation, JSONL) for large exports/imports.
- **Apps** (Shopify CLI, Remix template), **app extensions** (checkout UI, admin, theme app extensions), **Shopify Functions** (discounts, delivery/payment customisation, validation), **Flow** workflows, **metafields / metaobjects** (custom data), **Storefront API** for headless.
- Integration logic itself lives in the paired target (Node.js/.NET/Workato/Boomi/WSO2) — read that file too.

## 2. Neutral → Shopify
| Neutral | Shopify |
|---|---|
| db.write to "products/customers/orders" | GraphQL mutations (`productSet`/`productCreate`, `customerCreate`, `orderCreate`/draft orders, `inventorySetQuantities`…) — confirm exact mutation names against the pinned version |
| db.query | GraphQL queries with cursor pagination; bulk query for full exports |
| trigger event | webhook subscription (topic) → handler in paired target |
| custom fields | metafield definitions (namespace.key, type) / metaobjects |
| validation / pricing logic at checkout | Shopify Functions |
| automation in the store | Flow workflow or app logic |
| file/asset | `stagedUploadsCreate` + file/media mutations |

## 3. Triggers
Webhooks (verify HMAC, respond fast, process async, dedupe by webhook id) · schedules in the paired target (e.g. nightly bulk sync) · app events (install/uninstall) · Flow triggers.

## 4. Systems
Shopify store(s) per environment (dev store / staging / production), app credentials (OAuth, access scopes — minimal), external systems via paired target.

## 5. Data
- Migration order: metafield definitions → collections → products/variants/media → customers → inventory/locations → orders (historical orders as draft/imported per policy) → redirects (URL mapping from the old site).
- IDs: keep a cross-reference table old-id ↔ Shopify GID for idempotent re-runs.
- Respect cost-based GraphQL rate limits (throttle by `extensions.cost`); use bulk operations for large volumes.
- Money as decimal strings with currency; time zones of the store.

## 6. Error handling
Per unit mode from core §8.4. Mutations return `userErrors` — treat non-empty `userErrors` as failure. Webhook handler: alert-and-continue per event with DLQ/replay list; migrations: report-and-continue per record with a rejects file, re-runnable.

## 7. Config
Store domain, API version, scopes, app keys in secrets; per-environment stores; metafield namespaces as config.

## 8. Packaging / deploy / start
App: `shopify app deploy` (extensions, Functions) + host the app backend; webhooks registered; start check: app installs on the dev store, webhooks subscribed and receiving test deliveries, Functions active. Migration: dry run on a dev store, counts reconciled.

## 9. Tests
Dev-store end-to-end: create test order → webhook → effect; Function unit tests (input/output JSON fixtures); migration reconciliation (counts and spot-checks per entity); HMAC verification test.

## 10. Target gates
Pinned, supported API version · all mutations check `userErrors` · webhook HMAC verified · idempotency keys for writes/webhooks · minimal scopes · cross-reference table for migrated ids · redirects for every old URL that had traffic (if in scope).

## 11. Traps / confirm first
API version deprecation schedule · checkout customisation limits by plan (money/plan → human) · order import rules (taxes, fulfilment state) · variant/option limits · metafield type changes are not free · webhook delivery is at-least-once and unordered.

## 12. Lessons
(empty — add from the first Shopify fixture)
