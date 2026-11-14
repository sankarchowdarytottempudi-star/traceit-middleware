import { describe, it, expect } from "vitest";
import { parseMetricsLine } from "../src/gwanalytics/index.js";

const RESPONSE_JSON = '{"apiName":"cms-proc-api","proxyResponseCode":200,"destination":"http://cms-proc-api.wso2.svc/cms-proc-api/v1","apiCreatorTenantDomain":"carbon.super","platform":"Other","apiMethod":"GET","apiVersion":"v1","gatewayType":"SYNAPSE","apiCreator":"admin","responseCacheHit":false,"backendLatency":41,"correlationId":"00a94b54-5579-4f7e-95ed-5d6ac3ac4ee3","requestMediationLatency":3,"keyType":"PRODUCTION","apiId":"e0c4a5f8-1d2b-4c3a-9a51-0f6b1a2c3d4e","applicationName":"aroya-connector","targetResponseCode":200,"requestTimestamp":"2026-11-14T14:29:14.384Z","applicationOwner":"admin","userAgent":"curl","userName":"admin@carbon.super","apiResourceTemplate":"/descriptions/{type}","regionId":"default","responseLatency":46,"responseMediationLatency":2,"userIp":"10.42.0.1","apiContext":"/cms/v1","applicationId":"5f1c0d1e","apiType":"HTTP","properties":{"commonName":"N/A","responseContentType":"application/json","subtype":"DEFAULT","isEgress":false,"apiContext":"/cms/v1","responseSize":"1820","userName":"admin@carbon.super"}}';
const FAULT_JSON = '{"apiName":"cms-proc-api","proxyResponseCode":401,"errorType":"AUTH","apiCreatorTenantDomain":"carbon.super","platform":"Other","apiMethod":"GET","apiVersion":"v1","gatewayType":"SYNAPSE","apiCreator":"admin","responseCacheHit":false,"correlationId":"7a1c2b3d","errorCode":900902,"keyType":"PRODUCTION","apiId":"e0c4","applicationName":"UNKNOWN","targetResponseCode":-1,"requestTimestamp":"2026-11-14T14:29:15.001Z","applicationOwner":"UNKNOWN","userAgent":"curl/8.5.0","errorMessage":"AUTHENTICATION_FAILURE","apiResourceTemplate":"/descriptions/{type}","regionId":"default","userIp":"10.42.0.1","applicationId":"UNKNOWN","apiType":"HTTP","properties":{"commonName":"N/A","subtype":"DEFAULT","isEgress":false,"apiContext":"/cms/v1","userName":"UNKNOWN"}}';

const RESPONSE_LINE = `14:29:14,402 [-] [PassThroughMessageProcessor-12]  INFO ELKCounterMetric apimMetrics: apim:response, properties :${RESPONSE_JSON}`;
const FAULT_LINE = `14:29:15,010 [-] [PassThroughMessageProcessor-13]  INFO ELKCounterMetric apimMetrics: apim:faulty, properties :${FAULT_JSON}`;
const NOW = Date.UTC(2026, 10, 14, 15, 0, 0);

function line(type: "response" | "faulty", props: Record<string, unknown>, head = "properties :"): string {
  return `14:29:14,402 [-] [PassThroughMessageProcessor-1]  INFO ELKCounterMetric apimMetrics: apim:${type}, ${head}${JSON.stringify(props)}`;
}

describe("parseMetricsLine", () => {
  it("parses an apim:response event", () => {
    expect(parseMetricsLine(RESPONSE_LINE)).toEqual({
      ts: Date.parse("2026-11-14T14:29:14.384Z"), type: "response",
      api: "cms-proc-api", version: "v1", context: "/cms/v1", method: "GET", resource: "/descriptions/{type}",
      app: "aroya-connector", appOwner: "admin", user: "admin@carbon.super", keyType: "PRODUCTION",
      status: 200, targetStatus: 200,
      responseLatency: 46, backendLatency: 41, requestMediationLatency: 3, responseMediationLatency: 2,
      cacheHit: false, throttled: false, errorType: "", errorCode: null, errorMessage: "",
      userAgent: "curl", userIp: "10.42.0.1", correlationId: "00a94b54-5579-4f7e-95ed-5d6ac3ac4ee3",
      gatewayType: "SYNAPSE", platform: "Other", destination: "http://cms-proc-api.wso2.svc/cms-proc-api/v1",
    });
  });

  it("parses an apim:faulty event: no latency, backend not reached, UNKNOWN application kept", () => {
    const ev = parseMetricsLine(FAULT_LINE);
    expect(ev).toMatchObject({
      ts: Date.parse("2026-11-14T14:29:15.001Z"), type: "fault", api: "cms-proc-api", status: 401, targetStatus: null,
      errorType: "AUTH", errorCode: 900902, errorMessage: "AUTHENTICATION_FAILURE", throttled: false, cacheHit: false,
      app: "UNKNOWN", appOwner: "UNKNOWN", responseLatency: 0, backendLatency: 0, requestMediationLatency: 0, responseMediationLatency: 0,
      userAgent: "curl/8.5.0", destination: "",
    });
    // apiContext and userName are missing at the top level of this event: taken from the nested properties
    expect(ev?.context).toBe("/cms/v1");
    expect(ev?.user).toBe("UNKNOWN");
  });

  it("ignores the log4j prefix, whatever the layout", () => {
    const tail = `apimMetrics: apim:response, properties :${RESPONSE_JSON}`;
    const layouts = [
      `14:29:14,402 [-] [PassThroughMessageProcessor-12]  INFO ELKCounterMetric ${tail}`,
      `[2026-11-14 14:29:14,402]  INFO {org.wso2.am.analytics.publisher.reporter.elk.ELKCounterMetric} - ${tail}`,
      `TID: [-1234] [2026-11-14 14:29:14,402]  INFO {org.wso2.am.analytics.publisher.reporter.elk.ELKCounterMetric} - ${tail}`,
      tail,
    ];
    const expected = parseMetricsLine(RESPONSE_LINE);
    for (const l of layouts) expect(parseMetricsLine(l)).toEqual(expected);
  });

  it("accepts any spacing around the properties separator, CR at the end and junk after the object", () => {
    const expected = parseMetricsLine(RESPONSE_LINE);
    for (const sep of ["properties:", "properties :", "properties  :  ", "properties\t: "]) {
      expect(parseMetricsLine(`x apimMetrics:apim:response ,${sep}${RESPONSE_JSON}`)).toEqual(expected);
    }
    expect(parseMetricsLine(`${RESPONSE_LINE}\r`)).toEqual(expected);
    expect(parseMetricsLine(`${RESPONSE_LINE} trailing junk`)).toEqual(expected);
  });

  it("is not confused by the nested properties object or by braces inside strings", () => {
    const ev = parseMetricsLine(line("response", {
      apiName: "a", proxyResponseCode: 200, requestTimestamp: "2026-11-14T14:29:14.384Z", apiContext: "/top",
      apiResourceTemplate: "/x/{id}/y/{z}", userAgent: 'agent "} properties :{', userName: "top-user",
      properties: { apiContext: "/nested", userName: "nested-user", properties: { deep: "}{" }, apiName: "nested-name" },
    }));
    expect(ev).toMatchObject({ api: "a", context: "/top", user: "top-user", resource: "/x/{id}/y/{z}", userAgent: 'agent "} properties :{' });
  });

  it("coerces numbers and booleans that arrive as strings", () => {
    const ev = parseMetricsLine(line("response", {
      apiName: "a", proxyResponseCode: "201", targetResponseCode: "201", backendLatency: "41", responseLatency: " 46 ",
      requestMediationLatency: "3", responseMediationLatency: "2", responseCacheHit: "false", errorCode: "",
      requestTimestamp: "2026-11-14T14:29:14.384Z", apiVersion: 2,
    }));
    expect(ev).toMatchObject({
      status: 201, targetStatus: 201, backendLatency: 41, responseLatency: 46, requestMediationLatency: 3,
      responseMediationLatency: 2, cacheHit: false, errorCode: null, version: "2",
    });
    expect(parseMetricsLine(line("response", { responseCacheHit: "TRUE" }))?.cacheHit).toBe(true);
  });

  it("defaults missing and nonsensical fields sanely", () => {
    expect(parseMetricsLine(line("response", {}), NOW)).toEqual({
      ts: NOW, type: "response", api: "", version: "", context: "", method: "", resource: "", app: "", appOwner: "", user: "",
      keyType: "", status: 0, targetStatus: null, responseLatency: 0, backendLatency: 0, requestMediationLatency: 0,
      responseMediationLatency: 0, cacheHit: false, throttled: false, errorType: "", errorCode: null, errorMessage: "",
      userAgent: "", userIp: "", correlationId: "", gatewayType: "", platform: "", destination: "",
    });
    const odd = parseMetricsLine(line("response", {
      apiName: { nested: true }, proxyResponseCode: "abc", responseLatency: -5, backendLatency: null, targetResponseCode: 0,
      applicationName: ["x"], userIp: 12, requestTimestamp: "not a date",
    }), NOW);
    expect(odd).toMatchObject({ api: "", status: 0, responseLatency: 0, backendLatency: 0, targetStatus: null, app: "", userIp: "12", ts: NOW });
  });

  it("takes the time from requestTimestamp and falls back to now", () => {
    expect(parseMetricsLine(line("response", { requestTimestamp: "2026-11-14T14:29:14.384Z" }), NOW)?.ts).toBe(Date.parse("2026-11-14T14:29:14.384Z"));
    expect(parseMetricsLine(line("response", { requestTimestamp: 1794666554384 }), NOW)?.ts).toBe(1794666554384);
    expect(parseMetricsLine(line("response", { requestTimestamp: "1794666554384" }), NOW)?.ts).toBe(1794666554384);
    expect(parseMetricsLine(line("response", { requestTimestamp: "" }), NOW)?.ts).toBe(NOW);
    expect(parseMetricsLine(line("response", { requestTimestamp: 12 }), NOW)?.ts).toBe(NOW);
    const before = Date.now();
    const ts = parseMetricsLine(line("response", {}))?.ts ?? 0;
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(Date.now());
  });

  it("flags throttled faults by error type or by a 9008xx error code", () => {
    const byType = parseMetricsLine(line("faulty", { apiName: "a", proxyResponseCode: 429, errorType: "THROTTLED", errorCode: 900802, errorMessage: "API_LIMIT_EXCEEDED", targetResponseCode: -1 }));
    expect(byType).toMatchObject({ type: "fault", throttled: true, status: 429, errorType: "THROTTLED", errorCode: 900802, targetStatus: null });
    expect(parseMetricsLine(line("faulty", { errorType: "OTHER", errorCode: "900803" }))?.throttled).toBe(true);
    expect(parseMetricsLine(line("faulty", { errorType: "OTHER", errorCode: 900899 }))?.throttled).toBe(true);
    expect(parseMetricsLine(line("faulty", { errorType: "AUTH", errorCode: 900901 }))?.throttled).toBe(false);
    expect(parseMetricsLine(line("faulty", { errorType: "TARGET_CONNECTIVITY", errorCode: 101503, proxyResponseCode: 503 }))).toMatchObject({ throttled: false, status: 503 });
    // a 429 that the backend itself returned is a response, not a gateway throttle
    expect(parseMetricsLine(line("response", { proxyResponseCode: 429, errorCode: 900802 }))?.throttled).toBe(false);
  });

  it("parses a cache hit", () => {
    const ev = parseMetricsLine(line("response", { apiName: "a", proxyResponseCode: 200, responseCacheHit: true, backendLatency: 0, responseLatency: 2, targetResponseCode: 200 }));
    expect(ev).toMatchObject({ type: "response", cacheHit: true, backendLatency: 0, responseLatency: 2 });
  });

  it("returns null for blank lines, startup noise and stack traces", () => {
    const noise = [
      "", "   ", "\t",
      "[2026-11-14 14:20:01,113]  INFO {org.wso2.carbon.core.internal.StartupFinalizerServiceComponent} - WSO2 Carbon started in 42 sec",
      "java.lang.NullPointerException: Cannot invoke \"String.length()\" because \"s\" is null",
      "\tat org.wso2.am.analytics.publisher.reporter.elk.ELKCounterMetric.incrementCount(ELKCounterMetric.java:62)",
      "Caused by: java.io.IOException: apimMetrics: broken pipe",
      "apimMetrics:", "apimMetrics: apim:response", "apimMetrics: apim:response, properties :",
      "apimMetrics: apim:response, properties :[1,2,3]", "apimMetrics: apim:response, properties :null",
      "apimMetrics: apim:somethingElse, properties :{\"apiName\":\"a\"}",
      "apim:response, properties :{\"apiName\":\"a\"}",
    ];
    for (const l of noise) expect(parseMetricsLine(l)).toBeNull();
  });

  it("returns null for truncated or damaged JSON and never throws", () => {
    for (let cut = RESPONSE_LINE.length - 1; cut > RESPONSE_LINE.length - 400; cut -= 7) {
      expect(parseMetricsLine(RESPONSE_LINE.slice(0, cut))).toBeNull();
    }
    expect(parseMetricsLine(RESPONSE_LINE.replace('"apiName":', '"apiName"'))).toBeNull();
    expect(parseMetricsLine(`${RESPONSE_LINE.slice(0, 300)}\u0000\u0000\u0000`)).toBeNull();
    for (const bad of [undefined, null, 42, {}, []]) {
      expect(() => parseMetricsLine(bad as unknown as string)).not.toThrow();
      expect(parseMetricsLine(bad as unknown as string)).toBeNull();
    }
  });

  it("finds the event even when the marker text also appears earlier in the line", () => {
    const ev = parseMetricsLine(`thread apimMetrics: worker ${RESPONSE_LINE}`);
    expect(ev?.api).toBe("cms-proc-api");
  });

  it("caps absurdly long field values", () => {
    const ev = parseMetricsLine(line("response", { apiName: "a".repeat(5000), userAgent: "u".repeat(5000), responseLatency: 1e15 }));
    expect(ev?.api.length).toBe(256);
    expect(ev?.userAgent.length).toBe(512);
    expect(ev?.responseLatency).toBe(86_400_000);
  });
});
