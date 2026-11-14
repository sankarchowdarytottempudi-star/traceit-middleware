// Native gateway analytics ("tier 2"): contract between the indexer (this folder), the BFF
// routes and the console. The indexer tails WSO2 API Manager's apim_metrics.log (ELK reporter
// format: `... apimMetrics: apim:response, properties :{json}` / `apim:faulty`) from APIM_LOG_DIR.
// Everything stays on this server: the events are parsed and rolled up locally.

/** One gateway request, normalised from an apim:response or apim:faulty event. */
export interface GwEvent {
  ts: number;                       // epoch ms, from requestTimestamp
  type: "response" | "fault";
  api: string; version: string; context: string;
  method: string; resource: string; // apiMethod, apiResourceTemplate
  app: string; appOwner: string; user: string;
  keyType: string;                  // PRODUCTION | SANDBOX | ""
  status: number;                   // proxyResponseCode (what the caller received)
  targetStatus: number | null;      // backend status, null when the backend was not reached
  responseLatency: number;          // ms, total time at the gateway
  backendLatency: number;           // ms
  requestMediationLatency: number;  // ms
  responseMediationLatency: number; // ms
  cacheHit: boolean;
  throttled: boolean;
  errorType: string;                // "" for normal responses; AUTH, THROTTLED, TARGET_CONNECTIVITY, OTHER...
  errorCode: number | null;
  errorMessage: string;
  userAgent: string; userIp: string; correlationId: string;
  gatewayType: string; platform: string; destination: string;
}

export interface GwStatus {
  /** not-configured: APIM_LOG_DIR unset. waiting-for-file: directory set but no metrics file yet.
   *  active: file found and being followed. error: file exists but cannot be read. */
  state: "not-configured" | "waiting-for-file" | "active" | "error";
  enabled: boolean;                 // state === "active"
  file: string | null;
  fileSize: number;
  lastEventAt: string | null;       // ISO time of the newest event seen
  lastReadAt: string | null;        // ISO time the file was last read
  oldestAt: string | null;          // ISO time of the oldest retained bucket
  eventsIndexed: number;            // total since the index was created (survives restarts)
  linesSkipped: number;             // lines that were not analytics events or could not be parsed
  detail?: string;
}

export type GwRange = "15m" | "1h" | "6h" | "24h" | "7d" | "30d";
export interface GwQuery { range: GwRange; api?: string; app?: string; }

export interface GwTotals {
  requests: number; success: number; clientErrors: number; serverErrors: number;
  faults: number; throttled: number; cacheHits: number;
  avgResponseMs: number; avgBackendMs: number; avgMediationMs: number; // mediation = request + response mediation
  p50Ms: number; p95Ms: number; p99Ms: number;                         // gateway response latency, from histogram
  backendP50Ms: number; backendP95Ms: number;
}
export interface GwSeriesPoint {
  t: number;                        // bucket start, epoch ms
  requests: number; s2xx: number; s3xx: number; s4xx: number; s5xx: number;
  faults: number; throttled: number; cacheHits: number;
  avgResponseMs: number; avgBackendMs: number; p95Ms: number;
}
export interface GwBreakdownRow {
  key: string; label: string;
  requests: number; errors: number;  // errors = status >= 400
  faults: number; throttled: number; cacheHits: number;
  avgResponseMs: number; avgBackendMs: number; p95Ms: number;
  share: number;                    // 0..1 of all requests in the range
  lastAt: number | null;            // epoch ms of the newest bucket with traffic
  extra?: Record<string, string>;   // byApi: {version, context}; byApp: {owner}; byOperation: {api, method, resource}
}
export interface GwSummary {
  range: GwRange; from: number; to: number; stepSeconds: number;
  totals: GwTotals;
  series: GwSeriesPoint[];          // one point per step, zero-filled
  byApi: GwBreakdownRow[]; byApp: GwBreakdownRow[]; byOperation: GwBreakdownRow[];
  byStatus: { status: number; requests: number }[];
  byErrorType: { errorType: string; requests: number }[];
  latencyHistogram: { leMs: number | null; label: string; response: number; backend: number }[];
  apis: string[]; apps: string[];   // every API / application seen in the retained history (for filters)
}

export interface GwRecentQuery {
  search?: string;                  // free text over api, resource, app, user, ip, correlation id, status, error
  api?: string; app?: string;
  status?: "all" | "2xx" | "4xx" | "5xx" | "fault" | "throttled";
  correlationId?: string;
  limit?: number;                   // default 200, max 1000
}
export interface GwRecentResult { total: number; kept: number; rows: GwEvent[]; } // newest first; kept = events in memory

export interface GwApiHour { requests: number; errors: number; avgMs: number; p95Ms: number; lastAt: number | null; }

export interface GatewayAnalytics {
  start(): void;
  /** Stops the tailer and flushes the rollups to disk. */
  stop(): Promise<void>;
  status(): GwStatus;
  summary(q: GwQuery): GwSummary;
  recent(q: GwRecentQuery): GwRecentResult;
  /** Last 60 minutes per API name (all versions together), for the API inventory. */
  lastHourByApi(): Record<string, GwApiHour>;
}

export interface GwAnalyticsOptions {
  logDir: string | undefined;       // APIM_LOG_DIR; undefined/empty => not-configured
  dataDir: string;                  // BFF data dir; the index lives in <dataDir>/gateway-analytics/
  fileName?: string;                // default "apim_metrics.log"
  pollMs?: number;                  // default 2000
  recentMax?: number;               // default 5000 events kept in memory for the recent-requests table
  minuteRetentionHours?: number;    // default 26
  hourRetentionDays?: number;       // default 90
  now?: () => number;               // injectable clock for tests
  log?: (msg: string) => void;
}
