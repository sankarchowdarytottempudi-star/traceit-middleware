import { describe, expect, it } from "vitest";
import {
  LAND_MIN_WIDTH, ago, baseName, compact, distinct, fileSize, filterMigrations, healthLabel, healthTone, isSpec, layerKey, layoutLandscape,
  ms, nextActions, niceMax, outcomeTone, rebucket, splitMatch, statusLabel, statusTone, ticks, validateNewMigration,
} from "../src/lib/migrate.ts";

describe("labels and tones", () => {
  it("maps layer words and name suffixes to the three layers", () => {
    expect(layerKey("experience")).toBe("exp");
    expect(layerKey("process")).toBe("proc");
    expect(layerKey("system")).toBe("sys");
    expect(layerKey("exp")).toBe("exp");
    expect(layerKey(null)).toBe("other");
    expect(layerKey({ odd: true })).toBe("other");
  });
  it("gives each outcome and status a tone", () => {
    expect(outcomeTone("Deployed")).toBe("ok");
    expect(outcomeTone("Failed")).toBe("bad");
    expect(outcomeTone("In progress")).toBe("accent");
    expect(outcomeTone(undefined)).toBe("muted");
    expect(statusTone("done")).toBe("ok");
    expect(statusTone("failed")).toBe("bad");
    expect(statusTone("action_required")).toBe("warn");
    expect(statusLabel("action_required")).not.toMatch(/_/);
    expect(healthTone("healthy")).toBe("ok");
    expect(healthTone("down")).toBe("bad");
    expect(healthLabel("degraded")).toBe("Degraded");
    expect(healthLabel(undefined)).toBe("Unknown");
  });
});

describe("formatting", () => {
  const now = Date.parse("2026-01-10T12:00:00Z");
  it("says how long ago something happened", () => {
    expect(ago("2026-01-10T11:59:40Z", now)).toMatch(/now|second/);
    expect(ago("2026-01-10T11:30:00Z", now)).toMatch(/30 min/);
    expect(ago("2026-01-10T09:00:00Z", now)).toMatch(/3 h/);
    expect(ago("2026-01-07T12:00:00Z", now)).toMatch(/3 d/);
    expect(ago("not a date", now)).toBe("");
    expect(ago(undefined, now)).toBe("");
  });
  it("shortens numbers, sizes and times", () => {
    expect(compact(950)).toBe("950");
    expect(compact(12500)).toMatch(/12\.5\s?k/i);
    expect(compact(undefined)).toBe("0");
    expect(fileSize(512)).toBe("512 B");
    expect(fileSize(5 * 1024 * 1024)).toMatch(/5(\.0)? MB/);
    expect(ms(42.4)).toBe("42 ms");
    expect(ms(1500)).toBe("1.5 s");
    expect(baseName("/data/uploads/0a1b2c3d-orders.zip")).toBe("orders.zip");
  });
});

describe("filterMigrations", () => {
  const list = [
    { id: "a1", name: "Orders", apiName: "orders-sys-api", workspace: "North", technology: "mule4", busy: false, progress: { outcome: "Deployed" } },
    { id: "b2", name: "Loyalty", apiName: null, workspace: "North", technology: "unknown", busy: true, progress: { outcome: "In progress" } },
    { id: "c3", name: "Billing", apiName: "billing-proc-api", workspace: "South", technology: "mule4", busy: false, progress: { outcome: "Failed" } },
  ];
  it("searches name, API name, id and workspace", () => {
    expect(filterMigrations(list, { q: "ORDERS" }).map((m) => m.id)).toEqual(["a1"]);
    expect(filterMigrations(list, { q: "south" }).map((m) => m.id)).toEqual(["c3"]);
    expect(filterMigrations(list, { q: "b2" }).map((m) => m.id)).toEqual(["b2"]);
  });
  it("filters by workspace, outcome, running and technology together", () => {
    expect(filterMigrations(list, { workspace: "North" })).toHaveLength(2);
    expect(filterMigrations(list, { outcome: "Failed" }).map((m) => m.id)).toEqual(["c3"]);
    expect(filterMigrations(list, { outcome: "running" }).map((m) => m.id)).toEqual(["b2"]);
    expect(filterMigrations(list, { workspace: "North", technology: "mule4" }).map((m) => m.id)).toEqual(["a1"]);
    expect(filterMigrations(list, {})).toHaveLength(3);
  });
  it("lists distinct values, sorted, without blanks", () => {
    expect(distinct(["b", "a", "", null, "b"])).toEqual(["a", "b"]);
  });
});

describe("validateNewMigration", () => {
  const rules = { extensions: [".zip", ".jar", ".json"], maxUploadMb: 500, technologies: [{ id: "auto" }, { id: "mule4" }, { id: "spec", sourceType: "spec" }] };
  const ok = { name: "Orders", workspace: "North", technology: "mule4", target: "wso2", file: { name: "orders.zip", size: 1000 } };
  it("accepts a complete form", () => { expect(validateNewMigration(ok, rules)).toEqual({}); });
  it("asks for a name, a workspace and a file", () => {
    const e = validateNewMigration({ ...ok, name: " ", workspace: "", file: null }, rules);
    expect(e.name).toBeTruthy(); expect(e.workspace).toBeTruthy(); expect(e.file).toBeTruthy();
  });
  it("rejects file types the migration tool does not read", () => {
    expect(validateNewMigration({ ...ok, file: { name: "orders.tar.gz", size: 10 } }, rules).file).toMatch(/not accepted/);
  });
  it("keeps .json for written specifications only", () => {
    expect(validateNewMigration({ ...ok, file: { name: "orders.json", size: 10 } }, rules).file).toMatch(/specification/);
    expect(validateNewMigration({ ...ok, technology: "spec", file: { name: "orders.zip", size: 10 } }, rules).file).toMatch(/\.json/);
    expect(validateNewMigration({ ...ok, technology: "spec", file: { name: "orders.json", size: 10 } }, rules)).toEqual({});
  });
  it("rejects empty and oversized files", () => {
    expect(validateNewMigration({ ...ok, file: { name: "a.zip", size: 0 } }, rules).file).toMatch(/empty/);
    expect(validateNewMigration({ ...ok, file: { name: "a.zip", size: 501 * 1024 * 1024 } }, rules).file).toMatch(/500 MB/);
  });
  it("rejects names that would not survive the upload address", () => {
    expect(validateNewMigration({ ...ok, name: "Orders ☃" }, rules).name).toBeTruthy();
  });
});

describe("nextActions", () => {
  const phases = (s: Record<string, string>) => ["upload", "document", "mapping", "scaffold", "implement", "test", "deploy"].map((key) => ({ key, status: s[key] ?? "pending" }));
  it("starts with reading the source", () => {
    const a = nextActions({ phases: phases({ upload: "done" }), sourceFile: "x.zip" });
    expect(a.map((x) => x.id)).toEqual(["document"]);
    expect(a[0].primary).toBe(true);
    expect(a[0].writes).toBeFalsy();
  });
  it("offers generating once the documents exist and the API has a name", () => {
    const a = nextActions({ phases: phases({ upload: "done", document: "done" }), apiName: "orders-sys-api" });
    expect(a.map((x) => x.id)).toEqual(["document", "scaffold"]);
    expect(a.find((x) => x.primary)?.id).toBe("scaffold");
    expect(a.find((x) => x.id === "scaffold")?.writes).toBe(true);
    expect(nextActions({ phases: phases({ document: "done" }) }).map((x) => x.id)).toEqual(["document"]);
  });
  it("offers test and deploy after generating", () => {
    const a = nextActions({ phases: phases({ document: "done", scaffold: "done" }), apiName: "orders-sys-api" });
    expect(a.map((x) => x.id)).toEqual(["document", "scaffold", "test", "deploy"]);
    expect(a.find((x) => x.primary)?.id).toBe("test");
  });
  it("uses the specification route for a written specification", () => {
    const m = { sourceType: "spec", phases: phases({ upload: "done" }) };
    expect(isSpec(m)).toBe(true);
    expect(isSpec({ sourceFile: "/u/abc.spec.json" })).toBe(true);
    expect(nextActions(m).map((x) => x.id)).toEqual(["spec"]);
    expect(nextActions(m)[0].primary).toBe(true);
  });
  it("marks nothing primary once everything is done", () => {
    const a = nextActions({ phases: phases({ document: "done", scaffold: "done", test: "done", deploy: "done" }), apiName: "x-api" });
    expect(a.some((x) => x.primary)).toBe(false);
  });
});

describe("layoutLandscape", () => {
  const apis = [{ name: "shop-exp-api", layer: "experience" }, { name: "orders-proc-api", layer: "process" }, { name: "erp-sys-api", layer: "system" }, { name: "crm-sys-api", layer: "system" }];
  const links = [
    { from: "shop-exp-api", to: "orders-proc-api", via: "http", toKind: "api" },
    { from: "orders-proc-api", to: "erp-sys-api", via: "http", toKind: "api" },
    { from: "erp-sys-api", to: "erp.example.internal", via: "http", toKind: "backend" },
    { from: "orders-proc-api", to: "cache", via: "redis", toKind: "backend" },
  ];
  it("places every API and backend once, in layer order from left to right", () => {
    const land = layoutLandscape(apis, links, 1200);
    expect(land.nodes.map((n) => n.id).sort()).toEqual(["cache", "crm-sys-api", "erp-sys-api", "erp.example.internal", "orders-proc-api", "shop-exp-api"]);
    const x = (id: string) => land.nodes.find((n) => n.id === id)!.x;
    expect(x("shop-exp-api")).toBeLessThan(x("orders-proc-api"));
    expect(x("orders-proc-api")).toBeLessThan(x("erp-sys-api"));
    expect(x("erp-sys-api")).toBeLessThan(x("erp.example.internal"));
    expect(land.columns).toHaveLength(4);
    expect(land.edges).toHaveLength(4);
    for (const e of land.edges) expect(e.d.startsWith("M")).toBe(true);
  });
  it("never overlaps two nodes in the same column", () => {
    const land = layoutLandscape(apis, links, 1200);
    for (const a of land.nodes) for (const b of land.nodes) {
      if (a.id !== b.id && a.col === b.col) expect(Math.abs(a.y - b.y)).toBeGreaterThanOrEqual(a.h);
    }
  });
  it("keeps a readable minimum width on a phone and fits inside the canvas", () => {
    const land = layoutLandscape(apis, links, 340);
    expect(land.width).toBeGreaterThanOrEqual(LAND_MIN_WIDTH);
    for (const n of land.nodes) { expect(n.x).toBeGreaterThanOrEqual(0); expect(n.x + n.w).toBeLessThanOrEqual(land.width); expect(n.y + n.h).toBeLessThanOrEqual(land.height); }
  });
  it("copes with nothing to draw", () => {
    const land = layoutLandscape([], [], 900);
    expect(land.nodes).toEqual([]); expect(land.edges).toEqual([]);
  });
});

describe("chart helpers", () => {
  it("rounds the axis up to a tidy number", () => {
    expect(niceMax(0)).toBeGreaterThan(0);
    expect(niceMax(7)).toBeGreaterThanOrEqual(7);
    expect(niceMax(93)).toBe(100);
    expect(niceMax(1250)).toBeGreaterThanOrEqual(1250);
  });
  it("gives evenly spaced ticks ending at the maximum", () => {
    const t = ticks(100, 4);
    expect(t[0]).toBe(0); expect(t[t.length - 1]).toBe(100); expect(t).toHaveLength(5);
  });
  it("merges buckets without losing requests", () => {
    const series = Array.from({ length: 61 }, (_, i) => ({ at: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(), total: 2, errors: i % 2 }));
    const out = rebucket(series, 30);
    expect(out.length).toBeLessThanOrEqual(31);
    expect(out.reduce((s, b) => s + b.total, 0)).toBe(122);
    expect(out.reduce((s, b) => s + b.errors, 0)).toBe(30);
    expect(rebucket(series.slice(0, 10), 30)).toHaveLength(10);
  });
});

describe("splitMatch", () => {
  it("marks every match, whatever the case", () => {
    const parts = splitMatch("Error: bad ERROR again", "error");
    expect(parts.filter((p) => p.hit).map((p) => p.text)).toEqual(["Error", "ERROR"]);
    expect(parts.map((p) => p.text).join("")).toBe("Error: bad ERROR again");
  });
  it("returns the text whole without a search", () => {
    expect(splitMatch("plain", "")).toEqual([{ text: "plain", hit: false }]);
  });
});
