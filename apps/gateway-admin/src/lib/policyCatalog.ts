// The middleware policy landscape, family by family, and where each policy lives in this product.
// "here" entries are applied through API Manager 4.5 by this console and were tested on a throw-away
// API (see docs/CRUISE-SAUDI-POLICIES.md for what each test proved). Nothing is marked "here" that
// the console cannot really apply.

export type PolicyState = "here" | "apim" | "service" | "outside" | "unsupported";
export const STATE_WORDS: Record<PolicyState, string> = {
  here: "Configure here",
  apim: "In API Manager portals",
  service: "Handled in the service",
  outside: "Outside the gateway",
  unsupported: "Not supported by this API Manager",
};
export interface CatalogEntry {
  id: string; family: number; name: string; state: PolicyState;
  /** where to do it: a tab of the API page (traffic|access|consumers|policies|history), a console path, or plain words */
  where: string; wso2: string; mule: string; apigee: string; azure: string; kong: string; note?: string;
}
export const FAMILIES = [
  "Authentication", "Authorization", "Transport & message security", "Threat protection", "Traffic management",
  "Mediation & transformation", "Reliability & messaging", "Data protection & compliance", "Governance & lifecycle",
  "Observability & operations", "AI / LLM gateway",
] as const;

const e = (family: number, id: string, name: string, state: PolicyState, where: string, wso2: string, mule: string, apigee: string, azure: string, kong: string, note?: string): CatalogEntry =>
  ({ id, family, name, state, where, wso2, mule, apigee, azure, kong, note });

export const CATALOG: CatalogEntry[] = [
  // 1 Authentication
  e(1, "oauth2", "OAuth2 / JWT bearer token", "here", "access", "Application-level security: OAuth2", "OAuth 2.0 access token enforcement / JWT validation", "VerifyAccessToken / VerifyJWT", "validate-jwt", "OAuth2 / JWT plugin"),
  e(1, "apikey", "API key (header name configurable)", "here", "access", "Application-level security: API Key; apiKeyHeader", "Client ID enforcement", "VerifyAPIKey", "Subscription key (Ocp-Apim-Subscription-Key)", "key-auth"),
  e(1, "basic", "Basic authentication (key manager users)", "here", "access", "Application-level security: Basic", "Basic authentication - simple / LDAP", "BasicAuthentication", "authentication-basic", "basic-auth"),
  e(1, "mtls", "Mutual TLS (client certificates)", "apim", "Publisher → API → Runtime → Transport level security (upload the client certificates)", "Transport-level security: Mutual SSL", "TLS context with mutual auth", "TLS virtual host with client auth", "validate-client-certificate", "mtls-auth"),
  e(1, "idp", "External identity provider / OpenID Connect", "apim", "Admin portal → Key managers (gateway-wide)", "Key manager (third-party IdP)", "OpenID Connect access token enforcement", "OAuthV2 with external IdP", "validate-jwt with openid-config", "openid-connect"),
  // 2 Authorization
  e(2, "scopes", "OAuth scopes per operation, role-based scopes", "apim", "Publisher → API → Resources (scopes) and Local scopes", "Operation scopes / role-bound scopes", "OAuth scope enforcement", "VerifyAccessToken scope", "validate-jwt required-claims", "acl / oauth2 scopes"),
  e(2, "jwtclaim", "Allow by JWT claim", "apim", "Publisher → API → Policies → JWT claim based access validator", "jwtClaimBasedAccessValidator", "JWT validation (claims)", "VerifyJWT + Condition", "validate-jwt required-claims", "jwt + acl"),
  e(2, "opa", "Open Policy Agent decision", "apim", "Publisher → API → Policies → OPA policy (needs your OPA server)", "opaPolicy", "Custom policy calling OPA", "ServiceCallout to OPA", "send-request to OPA", "opa plugin"),
  e(2, "subblock", "Block one consumer's subscription", "here", "consumers", "Subscription block (BLOCKED / PROD_ONLY_BLOCKED)", "Client ID enforcement (revoke contract)", "Revoke app / developer", "Suspend subscription", "Consumer ACL"),
  e(2, "denyapp", "Block an application or user everywhere", "here", "/blocking", "Deny policies (APPLICATION, USER)", "Client ID enforcement", "Revoke app", "ip-filter / check-header", "acl"),
  // 3 Transport & message security
  e(3, "https", "HTTPS only (refuse plain HTTP)", "here", "policies", "API transports (https)", "HTTPS listener", "Virtual host (TLS only)", "Protocols: HTTPS", "protocols: https"),
  e(3, "tls", "TLS versions and ciphers", "outside", "/settings (API Manager server change in deployment.toml + restart)", "Transport sslEnabledProtocols / ciphers", "TLS context", "Virtual host TLS settings", "Protocol & cipher settings", "nginx ssl_protocols"),
  e(3, "backendtls", "TLS / mTLS to the backend", "apim", "Publisher → API → Endpoints → certificates", "Endpoint certificates", "TLS context on HTTP request", "TargetEndpoint SSLInfo", "Backend client certificate", "client_certificate"),
  e(3, "wssec", "Message signing / encryption (WS-Security, JWS/JWE)", "service", "In the migrated service (Factory)", "Mediation sequences", "WS-Security / JWT signing", "WS-Security / JWS", "Custom policy", "Custom plugin"),
  // 4 Threat protection
  e(4, "ipfilter", "IP allow-list / deny-list for this API", "here", "access", "API-specific operation policy (console) / deny policies", "IP allowlist / IP blocklist", "AccessControl", "ip-filter", "ip-restriction"),
  e(4, "ipglobal", "IP / range blocking on every API", "here", "/blocking", "Deny policies (IP, IPRANGE)", "IP blocklist", "AccessControl", "ip-filter (global)", "ip-restriction (global)"),
  e(4, "json", "JSON threat protection", "here", "policies", "jsonValidator (Threat Protection-JSON)", "JSON threat protection", "JSONThreatProtection", "validate-content (json)", "request-validator"),
  e(4, "xml", "XML threat protection", "here", "policies", "xmlValidator", "XML threat protection", "XMLThreatProtection", "validate-content (xml)", "custom"),
  e(4, "schema", "OpenAPI schema validation of requests and responses", "here", "policies", "enableSchemaValidation", "APIkit / JSON schema validation", "OASValidation", "validate-content (schema)", "oas-validation"),
  e(4, "regex", "Regular-expression threat protector (SQL / script injection)", "apim", "Publisher → API → Policies → Regex policy (patterns are set on the server)", "regexPolicy", "Custom policy", "RegularExpressionProtection", "Custom policy", "bot-detection / custom"),
  e(4, "cors", "CORS", "here", "access", "CORS configuration", "CORS policy", "CORS", "cors", "cors"),
  e(4, "methods", "Allowed methods and paths", "service", "The API definition (Factory / Publisher resources): only defined operations are routed", "API resources", "APIkit router", "Proxy flows", "Operations", "routes"),
  e(4, "size", "Request size limit / WAF / bot and DDoS protection", "outside", "Load balancer / WAF in front of the gateway (e.g. Cloudflare)", "—", "HTTP listener limits", "Spike arrest + WAF", "Front Door WAF", "request-size-limiting"),
  // 5 Traffic management
  e(5, "plans", "Plans per consumer (subscription tiers, quotas)", "here", "traffic", "Subscription policies", "SLA tiers / rate limiting - SLA based", "Quota + API products", "Products + quota", "consumer rate-limiting"),
  e(5, "apilimit", "Limit for the whole API or per operation", "here", "traffic", "Advanced (API/resource) policies", "Rate limiting", "SpikeArrest / Quota", "rate-limit / rate-limit-by-key", "rate-limiting"),
  e(5, "applimit", "Limit per application", "here", "/applications", "Application policies", "Rate limiting (per client)", "Quota per app", "rate-limit-by-key (subscription)", "rate-limiting (consumer)"),
  e(5, "conditional", "Conditional limits (by IP, header, query, JWT claim)", "apim", "Admin portal → Rate limiting → Advanced policies → conditional groups", "Advanced policy conditional groups", "Rate limiting with key expression", "Quota with identifier", "rate-limit-by-key", "rate-limiting (header/path)"),
  e(5, "burst", "Burst control / spike arrest", "apim", "Admin portal → Subscription policy → Burst control", "rateLimitCount / rateLimitTimeUnit", "Spike control", "SpikeArrest", "rate-limit (short window)", "rate-limiting (second)"),
  e(5, "tps", "Backend protection (max requests per second to the backend)", "here", "policies", "maxTps (backend throughput)", "Spike control", "SpikeArrest at target", "rate-limit at backend", "upstream rate limiting"),
  e(5, "custom", "Custom rules (query language)", "apim", "Admin portal → Custom policies (Siddhi)", "Custom throttling policies", "Custom policy", "JavaScript policy", "policy expressions", "custom plugin"),
  // 6 Mediation & transformation
  e(6, "headers", "Add / remove request headers", "here", "policies", "addHeader / removeHeader", "Header injection / removal", "AssignMessage", "set-header", "request-transformer"),
  e(6, "rewrite", "URL / path rewrite", "apim", "Publisher → API → Policies → Rewrite resource path", "rewriteResourcePath", "HTTP request path", "AssignMessage / target path", "rewrite-uri", "request-transformer (uri)"),
  e(6, "jsonxml", "JSON ↔ XML", "apim", "Publisher → API → Policies → JSON to XML / XML to JSON", "jsonToXML / xmlToJson", "DataWeave", "JSONtoXML / XMLtoJSON", "json-to-xml / xml-to-json", "custom"),
  e(6, "soap", "SOAP ↔ REST", "apim", "Publisher → create API from WSDL (SOAP to REST), or build it in the Factory", "SOAP to REST generation", "APIkit for SOAP / DataWeave", "SOAP-to-REST proxy", "SOAP to REST import", "soap plugin (enterprise)"),
  e(6, "mapping", "Data mapping and orchestration", "service", "In the migrated service or Studio flow (Factory)", "Mediation sequences / integration", "DataWeave / flows", "JavaScript / ServiceCallout", "Policies + Logic Apps", "serverless functions"),
  // 7 Reliability & messaging
  e(7, "timeout", "Backend timeout and pause after failures (circuit breaking)", "here", "policies", "Endpoint config: actionDuration, suspendDuration", "Until-successful / circuit breaker", "TargetEndpoint timeouts + health monitor", "forward-request timeout / circuit breaker", "upstream timeouts / passive health checks"),
  e(7, "lb", "Load-balanced / failover backends", "apim", "Publisher → API → Endpoints → Load balanced / Failover", "Load-balance and failover endpoints", "Round robin / first successful", "LoadBalancer in TargetServer", "Backend pools", "upstream targets"),
  e(7, "cache", "Response caching", "here", "policies", "responseCachingEnabled / cacheTimeout", "HTTP caching", "ResponseCache", "cache-lookup / cache-store", "proxy-cache"),
  e(7, "retry", "Retries and idempotency", "service", "In the migrated service (write calls are never retried)", "Endpoint retry config", "Until-successful", "Retry in TargetEndpoint", "retry", "retries"),
  e(7, "broker", "Queues, topics, async delivery", "outside", "The message broker (Kafka / JMS) and the services", "Streaming APIs", "Anypoint MQ / JMS", "—", "Service Bus", "kafka plugins"),
  // 8 Data protection & compliance
  e(8, "masking", "Hide personal data in logs and analytics", "outside", "/settings (API Manager server change)", "Analytics/log masking (deployment.toml)", "Log masking", "Data masking", "Log settings", "log sanitisation"),
  e(8, "encrypt", "Payload field encryption", "service", "In the migrated service", "Mediation", "Crypto module", "JavaScript", "Custom policy", "custom"),
  e(8, "audit", "Audit of every change", "here", "history", "Console audit log (GATEWAY_AUDIT_FILE)", "Audit logging", "Audit trail", "Activity log", "Audit log (enterprise)"),
  e(8, "residency", "Data residency", "outside", "Where the gateway and services are hosted", "—", "Region selection", "Region", "Region", "Region"),
  // 9 Governance & lifecycle
  e(9, "lifecycle", "Publish / deprecate / block / retire", "here", "policies", "API lifecycle", "API Manager lifecycle", "API product lifecycle", "Revisions / versions", "Konnect lifecycle"),
  e(9, "revisions", "Revisions and roll back", "here", "history", "API revisions", "API versions", "Revisions", "Revisions", "decK config"),
  e(9, "versions", "New API version", "apim", "Publisher → API → Create new version", "Versioning", "API versions", "Proxy revisions", "Versions", "routes per version"),
  e(9, "lint", "OpenAPI linting / governance rulesets", "here", "/compliance", "Governance policies + rulesets (Spectral)", "API Governance", "API hub linting", "API Center analysis", "Insomnia linting"),
  e(9, "approvals", "Approvals for subscriptions and changes", "here", "/approvals", "Workflows", "Approvals", "Developer app approval", "Subscription approval", "Konnect approvals"),
  // 10 Observability & operations
  e(10, "analytics", "Per-API traffic, errors, latency", "here", "live", "Analytics (apim_metrics)", "API analytics", "Analytics", "Application Insights", "vitals / analytics"),
  e(10, "logs", "Gateway and service logs", "here", "/logs", "Gateway logs", "Logging", "MessageLogging", "log-to-eventhub", "file-log / http-log"),
  e(10, "correlation", "Correlation id and tracing", "outside", "/settings (API Manager server change: correlation logs / OpenTelemetry)", "Correlation logs / OpenTelemetry", "Correlation ID", "Trace", "Correlation / App Insights", "correlation-id / opentelemetry"),
  e(10, "alerts", "Alerts", "outside", "The monitoring stack (Prometheus / alert manager)", "—", "Alerts", "Alerts", "Azure Monitor alerts", "Prometheus"),
  // 11 AI / LLM
  e(11, "aiapi", "AI APIs: model round robin, failover, token limits", "apim", "Publisher → create AI API (model round robin / failover policies, AI subscription plans)", "AI APIs (modelRoundRobin, modelFailover, AI policies)", "AI gateway / MuleSoft AI Chain", "LLM policies", "llm-token-limit / azure-openai-*", "ai-proxy / ai-rate-limiting"),
  e(11, "guardrails", "Prompt guardrails (PII, prompt injection)", "unsupported", "Not offered by this API Manager 4.5 installation", "—", "Einstein trust layer", "Model Armor", "llm-content-safety", "ai-prompt-guard"),
];

export function entriesOf(family: number) { return CATALOG.filter((c) => c.family === family); }
