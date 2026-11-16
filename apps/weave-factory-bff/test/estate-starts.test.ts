// Parts that start by themselves: what the running service said about them at start-up.
import { describe, it, expect } from "vitest";
import { isHealthOnlyWarning, runSummary, startStates } from "../src/estate/starts";

const L = (text: string, at = "2026-11-16T08:00:00Z") => ({ text, at });

describe("estate: parts that start by themselves", () => {
  it("reads on, off and not started from the start-up lines, by switch", () => {
    const parts = [
      { name: "interfaceFlow", starts: "runs on a timer", kind: "scheduler", switch: "timer", on: true },
      { name: "active-MQFlow", starts: "starts from a message queue", kind: "jms:listener", switch: "queue", on: false },
    ];
    const s = startStates(parts, [L('level=INFO message="batch starting" timer="ON, every 60.0s (mode delta, error e-mail on, OSS copy off)" queue="off" progressKeptIn="Redis"')]);
    expect(s[0]).toMatchObject({ name: "interfaceFlow", on: true, live: "on", said: "ON, every 60.0s (mode delta, error e-mail on, OSS copy off)" });
    expect(s[1]).toMatchObject({ name: "active-MQFlow", on: false, live: "off" });
  });

  it("explains a timer that did not start, with no address in the text", () => {
    const s = startStates([{ name: "interfaceFlow", starts: "runs on a timer", kind: "scheduler", switch: "timer", on: true }],
      [L('message="starting" timer="NOT STARTED, the database could not be reached at jdbc://10.1.2.3:5432/db as ops@corp.example.com"')]);
    expect(s[0].live).toBe("not-started");
    expect(s[0].why).toMatch(/^the database could not be reached/);
    expect(JSON.stringify(s)).not.toMatch(/10\.1\.2\.3|corp\.example\.com|jdbc:\/\//);
  });

  it("uses startingPoint lines, falls back to the kind for a single part without a switch, and says unknown otherwise", () => {
    expect(startStates([{ name: "nightly", starts: "runs on a timer", kind: "scheduler", switch: "", on: null }],
      [L('message="starting point" startingPoint="nightly" state="ON, every 120s"')])[0]).toMatchObject({ live: "on", on: null });
    expect(startStates([{ name: "payment-scheduler", starts: "runs on a timer", kind: "scheduler", switch: "", on: null }],
      [L('message="started" timer="off"')])[0].live).toBe("off");
    expect(startStates([{ name: "rates", starts: "starts from a Kafka topic", kind: "kafka:message-listener", on: null }], [])[0].live).toBe("unknown");
  });

  it("counts runs and keeps the last one", () => {
    const r = runSummary([
      L('message="Seaware sync run finished"', "2026-11-16T08:00:00Z"),
      L('message="Seaware sync run failed" reason="OSS refused the upload (HTTP 403)"', "2026-11-16T08:01:00Z"),
      L('message="Seaware sync run finished"', "2026-11-16T08:02:00Z"),
      L('message="No data from seaware to process"'),
    ]);
    expect(r).toEqual({ finished: 2, failed: 1, lastAt: "2026-11-16T08:02:00Z", last: "finished", lastReason: undefined });
    expect(runSummary([L("nothing here")])).toBeUndefined();
  });

  it("knows the health-checks-only warning", () => {
    expect(isHealthOnlyWarning("The deployed code answers health checks only; no business operations were found.")).toBe(true);
    expect(isHealthOnlyWarning("Something else")).toBe(false);
  });
});

import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApi } from "../src/estate/model";

describe("estate reader: a service made from a service class", () => {
  it("finds the operations of `final X svc = new;` attached to the listener", () => {
    const dir = mkdtempSync(join(tmpdir(), "estate-class-"));
    mkdirSync(join(dir, "shop"));
    writeFileSync(join(dir, "shop", "Ballerina.toml"), '[package]\norg = "aroya"\nname = "shop"\nversion = "0.1.0"\n');
    writeFileSync(join(dir, "shop", "service.bal"), [
      "import ballerina/http;",
      "configurable int httpPort = 8081;",
      'configurable string basePath = "/shop/v1";',
      "listener http:Listener httpListener = new (httpPort);",
      "function init() returns error? {",
      "    check httpListener.attach(shopService, basePath);",
      "}",
      "isolated service class RecordedApi {",
      "    *http:InterceptableService;",
      "    public function createInterceptors() returns http:Interceptor[] => [];",
      "    isolated resource function get items/[string id]() returns json => {};",
      "    isolated resource function post items(@http:Payload json body) returns json => {};",
      "}",
      "final RecordedApi shopService = new;",
      "service /health on httpListener {",
      '    resource function get live() returns json => {status: "UP"};',
      "}",
    ].join("\n"));
    const model = buildApi({ name: "shop", dirs: [join(dir, "shop")] });
    const ops = model.operations.map((o) => `${o.method} ${o.fullPath}`);
    expect(ops).toEqual(expect.arrayContaining(["GET /shop/v1/items/{id}", "POST /shop/v1/items"]));
    expect(model.warnings.some((w) => /health checks only/.test(w))).toBe(false);
  });
});
