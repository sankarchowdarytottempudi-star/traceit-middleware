# Cruise Saudi Weave: gateway policy coverage

Generated from `apps/gateway-admin/src/lib/policyCatalog.ts` (the same list the console's API page shows under **Policies**).
Gateway: WSO2 API Manager 4.5. Every policy is in one of these states:

- **Configure here**: applied by the Weave Gateway console through the API Manager REST APIs (update the API, new revision, deploy) and tested on a throw-away API (`cs-gw-test-*`).
- **In API Manager portals**: API Manager 4.5 supports it, but this console does not offer it yet; do it in the Publisher or Admin portal.
- **Handled in the service**: belongs in the migrated service or Studio flow (Weave Factory).
- **Outside the gateway**: load balancer / WAF, broker, network, or an API Manager server-file change (shown on Gateway settings).
- **Not supported by this API Manager**: not available in this installation.

## What the tests on the real gateway proved

| Policy | Proof on the live gateway (throw-away API) |
|---|---|
| Per-API IP deny / allow list | Calls from the VM got `403 Calls from your address are not allowed for this API` within ~15 s; removing the rule let them in again. |
| Whole-API limit (3 per minute) | `429 Message throttled out` after the limit (API Manager counts asynchronously, so a few extra calls pass first). |
| Block a subscription | `900907 The requested API is temporarily blocked`; unblock restored access. |
| JSON threat protection | A 7-level JSON body was refused with `400 Threat Protection-JSON`; a flat body passed. |
| Basic authentication | After switching, bearer tokens were refused (`900902 Missing Credentials`). |
| Roll back | Rolling back to the revision without the limit removed the 429s. |
| Revision limit | With 5 revisions the oldest undeployed one was removed before the new one was created. |
| Regenerate secret | The old consumer secret was refused (`invalid_client`) right after. |
| Caching, backend TPS, timeout/suspension, header add/remove, XML threat protection, schema validation, HTTPS only, API key header name | Accepted by API Manager, stored in the API definition and deployed in a new revision. Their runtime effect was not observable against the dead test backend. |

Known API Manager 4.5 behaviour: after **Remove keys** (key clean-up) on an application, keys generated again on the same application produced tokens the gateway refused (`900901`). Rotate with **Regenerate secret**, or create a new application.

## 1. Authentication

| Policy | State | Where | WSO2 term | MuleSoft | Apigee | Azure APIM | Kong |
|---|---|---|---|---|---|---|---|
| OAuth2 / JWT bearer token | Configure here | API page → Access | Application-level security: OAuth2 | OAuth 2.0 access token enforcement / JWT validation | VerifyAccessToken / VerifyJWT | validate-jwt | OAuth2 / JWT plugin |
| API key (header name configurable) | Configure here | API page → Access | Application-level security: API Key; apiKeyHeader | Client ID enforcement | VerifyAPIKey | Subscription key (Ocp-Apim-Subscription-Key) | key-auth |
| Basic authentication (key manager users) | Configure here | API page → Access | Application-level security: Basic | Basic authentication - simple / LDAP | BasicAuthentication | authentication-basic | basic-auth |
| Mutual TLS (client certificates) | In API Manager portals | Publisher → API → Runtime → Transport level security (upload the client certificates) | Transport-level security: Mutual SSL | TLS context with mutual auth | TLS virtual host with client auth | validate-client-certificate | mtls-auth |
| External identity provider / OpenID Connect | In API Manager portals | Admin portal → Key managers (gateway-wide) | Key manager (third-party IdP) | OpenID Connect access token enforcement | OAuthV2 with external IdP | validate-jwt with openid-config | openid-connect |

## 2. Authorization

| Policy | State | Where | WSO2 term | MuleSoft | Apigee | Azure APIM | Kong |
|---|---|---|---|---|---|---|---|
| OAuth scopes per operation, role-based scopes | In API Manager portals | Publisher → API → Resources (scopes) and Local scopes | Operation scopes / role-bound scopes | OAuth scope enforcement | VerifyAccessToken scope | validate-jwt required-claims | acl / oauth2 scopes |
| Allow by JWT claim | In API Manager portals | Publisher → API → Policies → JWT claim based access validator | jwtClaimBasedAccessValidator | JWT validation (claims) | VerifyJWT + Condition | validate-jwt required-claims | jwt + acl |
| Open Policy Agent decision | In API Manager portals | Publisher → API → Policies → OPA policy (needs your OPA server) | opaPolicy | Custom policy calling OPA | ServiceCallout to OPA | send-request to OPA | opa plugin |
| Block one consumer's subscription | Configure here | API page → Consumers | Subscription block (BLOCKED / PROD_ONLY_BLOCKED) | Client ID enforcement (revoke contract) | Revoke app / developer | Suspend subscription | Consumer ACL |
| Block an application or user everywhere | Configure here | /blocking | Deny policies (APPLICATION, USER) | Client ID enforcement | Revoke app | ip-filter / check-header | acl |

## 3. Transport & message security

| Policy | State | Where | WSO2 term | MuleSoft | Apigee | Azure APIM | Kong |
|---|---|---|---|---|---|---|---|
| HTTPS only (refuse plain HTTP) | Configure here | API page → Policies | API transports (https) | HTTPS listener | Virtual host (TLS only) | Protocols: HTTPS | protocols: https |
| TLS versions and ciphers | Outside the gateway | /settings (API Manager server change in deployment.toml + restart) | Transport sslEnabledProtocols / ciphers | TLS context | Virtual host TLS settings | Protocol & cipher settings | nginx ssl_protocols |
| TLS / mTLS to the backend | In API Manager portals | Publisher → API → Endpoints → certificates | Endpoint certificates | TLS context on HTTP request | TargetEndpoint SSLInfo | Backend client certificate | client_certificate |
| Message signing / encryption (WS-Security, JWS/JWE) | Handled in the service | In the migrated service (Factory) | Mediation sequences | WS-Security / JWT signing | WS-Security / JWS | Custom policy | Custom plugin |

## 4. Threat protection

| Policy | State | Where | WSO2 term | MuleSoft | Apigee | Azure APIM | Kong |
|---|---|---|---|---|---|---|---|
| IP allow-list / deny-list for this API | Configure here | API page → Access | API-specific operation policy (console) / deny policies | IP allowlist / IP blocklist | AccessControl | ip-filter | ip-restriction |
| IP / range blocking on every API | Configure here | /blocking | Deny policies (IP, IPRANGE) | IP blocklist | AccessControl | ip-filter (global) | ip-restriction (global) |
| JSON threat protection | Configure here | API page → Policies | jsonValidator (Threat Protection-JSON) | JSON threat protection | JSONThreatProtection | validate-content (json) | request-validator |
| XML threat protection | Configure here | API page → Policies | xmlValidator | XML threat protection | XMLThreatProtection | validate-content (xml) | custom |
| OpenAPI schema validation of requests and responses | Configure here | API page → Policies | enableSchemaValidation | APIkit / JSON schema validation | OASValidation | validate-content (schema) | oas-validation |
| Regular-expression threat protector (SQL / script injection) | In API Manager portals | Publisher → API → Policies → Regex policy (patterns are set on the server) | regexPolicy | Custom policy | RegularExpressionProtection | Custom policy | bot-detection / custom |
| CORS | Configure here | API page → Access | CORS configuration | CORS policy | CORS | cors | cors |
| Allowed methods and paths | Handled in the service | The API definition (Factory / Publisher resources): only defined operations are routed | API resources | APIkit router | Proxy flows | Operations | routes |
| Request size limit / WAF / bot and DDoS protection | Outside the gateway | Load balancer / WAF in front of the gateway (e.g. Cloudflare) | — | HTTP listener limits | Spike arrest + WAF | Front Door WAF | request-size-limiting |

## 5. Traffic management

| Policy | State | Where | WSO2 term | MuleSoft | Apigee | Azure APIM | Kong |
|---|---|---|---|---|---|---|---|
| Plans per consumer (subscription tiers, quotas) | Configure here | API page → Traffic limits | Subscription policies | SLA tiers / rate limiting - SLA based | Quota + API products | Products + quota | consumer rate-limiting |
| Limit for the whole API or per operation | Configure here | API page → Traffic limits | Advanced (API/resource) policies | Rate limiting | SpikeArrest / Quota | rate-limit / rate-limit-by-key | rate-limiting |
| Limit per application | Configure here | /applications | Application policies | Rate limiting (per client) | Quota per app | rate-limit-by-key (subscription) | rate-limiting (consumer) |
| Conditional limits (by IP, header, query, JWT claim) | In API Manager portals | Admin portal → Rate limiting → Advanced policies → conditional groups | Advanced policy conditional groups | Rate limiting with key expression | Quota with identifier | rate-limit-by-key | rate-limiting (header/path) |
| Burst control / spike arrest | In API Manager portals | Admin portal → Subscription policy → Burst control | rateLimitCount / rateLimitTimeUnit | Spike control | SpikeArrest | rate-limit (short window) | rate-limiting (second) |
| Backend protection (max requests per second to the backend) | Configure here | API page → Policies | maxTps (backend throughput) | Spike control | SpikeArrest at target | rate-limit at backend | upstream rate limiting |
| Custom rules (query language) | In API Manager portals | Admin portal → Custom policies (Siddhi) | Custom throttling policies | Custom policy | JavaScript policy | policy expressions | custom plugin |

## 6. Mediation & transformation

| Policy | State | Where | WSO2 term | MuleSoft | Apigee | Azure APIM | Kong |
|---|---|---|---|---|---|---|---|
| Add / remove request headers | Configure here | API page → Policies | addHeader / removeHeader | Header injection / removal | AssignMessage | set-header | request-transformer |
| URL / path rewrite | In API Manager portals | Publisher → API → Policies → Rewrite resource path | rewriteResourcePath | HTTP request path | AssignMessage / target path | rewrite-uri | request-transformer (uri) |
| JSON ↔ XML | In API Manager portals | Publisher → API → Policies → JSON to XML / XML to JSON | jsonToXML / xmlToJson | DataWeave | JSONtoXML / XMLtoJSON | json-to-xml / xml-to-json | custom |
| SOAP ↔ REST | In API Manager portals | Publisher → create API from WSDL (SOAP to REST), or build it in the Factory | SOAP to REST generation | APIkit for SOAP / DataWeave | SOAP-to-REST proxy | SOAP to REST import | soap plugin (enterprise) |
| Data mapping and orchestration | Handled in the service | In the migrated service or Studio flow (Factory) | Mediation sequences / integration | DataWeave / flows | JavaScript / ServiceCallout | Policies + Logic Apps | serverless functions |

## 7. Reliability & messaging

| Policy | State | Where | WSO2 term | MuleSoft | Apigee | Azure APIM | Kong |
|---|---|---|---|---|---|---|---|
| Backend timeout and pause after failures (circuit breaking) | Configure here | API page → Policies | Endpoint config: actionDuration, suspendDuration | Until-successful / circuit breaker | TargetEndpoint timeouts + health monitor | forward-request timeout / circuit breaker | upstream timeouts / passive health checks |
| Load-balanced / failover backends | In API Manager portals | Publisher → API → Endpoints → Load balanced / Failover | Load-balance and failover endpoints | Round robin / first successful | LoadBalancer in TargetServer | Backend pools | upstream targets |
| Response caching | Configure here | API page → Policies | responseCachingEnabled / cacheTimeout | HTTP caching | ResponseCache | cache-lookup / cache-store | proxy-cache |
| Retries and idempotency | Handled in the service | In the migrated service (write calls are never retried) | Endpoint retry config | Until-successful | Retry in TargetEndpoint | retry | retries |
| Queues, topics, async delivery | Outside the gateway | The message broker (Kafka / JMS) and the services | Streaming APIs | Anypoint MQ / JMS | — | Service Bus | kafka plugins |

## 8. Data protection & compliance

| Policy | State | Where | WSO2 term | MuleSoft | Apigee | Azure APIM | Kong |
|---|---|---|---|---|---|---|---|
| Hide personal data in logs and analytics | Outside the gateway | /settings (API Manager server change) | Analytics/log masking (deployment.toml) | Log masking | Data masking | Log settings | log sanitisation |
| Payload field encryption | Handled in the service | In the migrated service | Mediation | Crypto module | JavaScript | Custom policy | custom |
| Audit of every change | Configure here | API page → Change history | Console audit log (GATEWAY_AUDIT_FILE) | Audit logging | Audit trail | Activity log | Audit log (enterprise) |
| Data residency | Outside the gateway | Where the gateway and services are hosted | — | Region selection | Region | Region | Region |

## 9. Governance & lifecycle

| Policy | State | Where | WSO2 term | MuleSoft | Apigee | Azure APIM | Kong |
|---|---|---|---|---|---|---|---|
| Publish / deprecate / block / retire | Configure here | API page → Policies | API lifecycle | API Manager lifecycle | API product lifecycle | Revisions / versions | Konnect lifecycle |
| Revisions and roll back | Configure here | API page → Change history | API revisions | API versions | Revisions | Revisions | decK config |
| New API version | In API Manager portals | Publisher → API → Create new version | Versioning | API versions | Proxy revisions | Versions | routes per version |
| OpenAPI linting / governance rulesets | Configure here | /compliance | Governance policies + rulesets (Spectral) | API Governance | API hub linting | API Center analysis | Insomnia linting |
| Approvals for subscriptions and changes | Configure here | /approvals | Workflows | Approvals | Developer app approval | Subscription approval | Konnect approvals |

## 10. Observability & operations

| Policy | State | Where | WSO2 term | MuleSoft | Apigee | Azure APIM | Kong |
|---|---|---|---|---|---|---|---|
| Per-API traffic, errors, latency | Configure here | API page → Live status | Analytics (apim_metrics) | API analytics | Analytics | Application Insights | vitals / analytics |
| Gateway and service logs | Configure here | /logs | Gateway logs | Logging | MessageLogging | log-to-eventhub | file-log / http-log |
| Correlation id and tracing | Outside the gateway | /settings (API Manager server change: correlation logs / OpenTelemetry) | Correlation logs / OpenTelemetry | Correlation ID | Trace | Correlation / App Insights | correlation-id / opentelemetry |
| Alerts | Outside the gateway | The monitoring stack (Prometheus / alert manager) | — | Alerts | Alerts | Azure Monitor alerts | Prometheus |

## 11. AI / LLM gateway

| Policy | State | Where | WSO2 term | MuleSoft | Apigee | Azure APIM | Kong |
|---|---|---|---|---|---|---|---|
| AI APIs: model round robin, failover, token limits | In API Manager portals | Publisher → create AI API (model round robin / failover policies, AI subscription plans) | AI APIs (modelRoundRobin, modelFailover, AI policies) | AI gateway / MuleSoft AI Chain | LLM policies | llm-token-limit / azure-openai-* | ai-proxy / ai-rate-limiting |
| Prompt guardrails (PII, prompt injection) | Not supported by this API Manager | Not offered by this API Manager 4.5 installation | — | Einstein trust layer | Model Armor | llm-content-safety | ai-prompt-guard |

## Totals

Configure here: 26 · In API Manager portals: 16 · Handled in the service: 5 · Outside the gateway: 7 · Not supported by this API Manager: 1
