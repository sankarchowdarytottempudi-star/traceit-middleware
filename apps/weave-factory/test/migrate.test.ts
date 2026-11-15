import { describe, expect, it } from "vitest";
import {
  LAND_MIN_WIDTH, ago, baseName, compact, distinct, fileSize, filterMigrations, healthLabel, healthTone, isSpec, layerKey, layoutLandscape,
  ms, nextActions, failureView, itemKindWord, forwardStart, decisionProblem, NEW_API, newApiProblem, passOnLoses, passOnHint, placeholderLine, sourceEnvs, repoFormProblems, repoState, notMigratedYet, projectState, importPlan, noteLimit, nothingOpen, sourceSummary, niceMax, outcomeTone, rebucket, splitMatch, statusLabel, statusTone, ticks, validateNewMigration,
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
    expect(outcomeTone("Deployed, not finished")).toBe("warn");
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
    for (const v of [1, 2, 3, 5, 7, 11, 37]) expect(ticks(v).every((t) => Number.isInteger(t))).toBe(true);
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

describe("failureView", () => {
  const phases = (s: Record<string, string>) => ["upload", "document", "mapping", "scaffold", "implement", "test", "deploy"].map((key) => ({ key, status: s[key] ?? "pending" }));
  const base = { apiName: "guest-identity-proc-api", sourceFile: "x.jar", phases: phases({ upload: "done", document: "done", scaffold: "done", test: "failed" }) };
  it("is empty while nothing has failed", () => {
    expect(failureView({ ...base, progress: { outcome: "In progress", failure: null } })).toBeNull();
    expect(failureView({ ...base })).toBeNull();
  });
  it("explains a failed step and offers that step again", () => {
    const v = failureView({ ...base, progress: { outcome: "Failed", failure: { phase: "Testing", phaseKey: "test", step: "bal build", status: "failed", detail: "ERROR [Ballerina.toml] could not locate the package path",
      output: "raw output", help: { kind: "workspace-entry", what: "The build stopped before reaching this API.", why: "The shared build list named a folder that no longer exists.", todo: ["Run this step again."], retry: true } } } })!;
    expect(v.blocked).toBe(false);
    expect(v.title).toBe("Testing failed: bal build");
    expect(v.what).toMatch(/build stopped/);
    expect(v.todo).toEqual(["Run this step again."]);
    expect(v.output).toBe("raw output");
    expect(v.retry).toEqual({ id: "test", label: "Run this step again" });
  });
  it("still says what to do when the tool gave no explanation", () => {
    const v = failureView({ ...base, phases: phases({ upload: "done", document: "failed" }), progress: { failure: { phase: "Documentation", phaseKey: "document", step: "Unpack", status: "failed", detail: "boom" } } })!;
    expect(v.why).toBe("boom");
    expect(v.todo.length).toBe(1);
    expect(v.output).toBe("boom");
    expect(v.retry?.id).toBe("document");
  });
  it("a service that is not finished is blocked, not failed, and deployment is not offered", () => {
    const m = { ...base, phases: phases({ upload: "done", document: "done", scaffold: "done", test: "action_required" }),
      progress: { outcome: "In progress", failure: { phase: "Testing", phaseKey: "test", step: "Every operation migrated", status: "action_required", detail: "8 operations still answer not migrated",
        help: { kind: "not-ready", what: "The service is not finished, so it is not offered for deployment.", why: "8 operations still answer not migrated", todo: ["Write the logic of: GET /a.", "Then run the tests again."], retry: false } } } };
    const v = failureView(m)!;
    expect(v.blocked).toBe(true);
    expect(v.title).toBe("Not finished yet");
    expect(v.retry).toEqual({ id: "test", label: "Check again (build and run the tests)" });
    expect(v.output).toBe("");
    expect(nextActions(m).map((a) => a.id)).toEqual(["document", "scaffold", "test"]);
    expect(nextActions({ ...m, progress: { outcome: "In progress", failure: null } }).map((a) => a.id)).toContain("deploy");
  });
});

describe("finish this migration", () => {
  const op = { id: "op:GET /items/{itemId}", kind: "operation", title: "GET /items/{itemId}", params: ["itemId"], suggest: null,
    source: { steps: 4, parts: 1, transforms: 0, calls: [{ method: "get", path: "/items/{itemId}", backend: "catalogue" }] } };
  it("passes a part that starts by itself on to an API", () => {
    const timer = { id: "entry:nightly", kind: "entry", title: "nightly", starts: "runs on a timer", params: [], suggest: null,
      placeholder: { file: "starts.bal", function: "runNightly", each: "run", started: true } };
    const topic = { ...timer, id: "entry:rates", title: "rates", placeholder: { file: "starts.bal", function: "onRates", each: "message", started: true } };
    expect(forwardStart(timer, ["ledger"])).toEqual({ backend: "ledger", method: "POST", path: "/" });
    expect(forwardStart({ ...timer, suggest: { backend: "ledger", method: "PUT", path: "/close" } }, ["ledger"])).toEqual({ backend: "ledger", method: "PUT", path: "/close" });
    expect(decisionProblem({ action: "forward", backend: "ledger", method: "POST", path: "/close" }, timer)).toBe("");
    expect(decisionProblem({ action: "forward", backend: "ledger", method: "POST", path: "/close/{id}" }, timer)).toMatch(/starts by itself has no values/);
    expect(passOnHint(timer)).toMatch(/Every run makes this one call, with no body/);
    expect(passOnHint(topic)).toMatch(/Every message is sent to this address as the body/);
    expect(passOnHint({ kind: "operation" })).toMatch(/caller's body, query and headers/);
    expect(placeholderLine(timer)).toMatch(/switched-off placeholder for it \(starts\.bal, function runNightly\).*enabled = true/);
    expect(placeholderLine({ ...timer, placeholder: { file: "starts.bal", function: "onQueue", started: false } })).toMatch(/does not start this kind of listener itself/);
    expect(placeholderLine({ kind: "entry" })).toBe("");
    expect(placeholderLine({ kind: "operation", placeholder: { file: "x" } })).toBe("");
  });
  it("names each kind of open item", () => {
    expect(itemKindWord(op)).toBe("Operation not migrated");
    expect(itemKindWord({ kind: "code" })).toBe("Operation being written");
    expect(itemKindWord({ kind: "backend" })).toBe("Backend without an address");
    expect(itemKindWord({ kind: "entry", starts: "every 5 minutes" })).toBe("Starts by itself: every 5 minutes");
    expect(itemKindWord({ kind: "entry" })).toBe("Starts by itself");
  });
  it("starts the form from the old code's own call when it can be used as it is", () => {
    expect(forwardStart(op, ["stock", "catalogue"])).toEqual({ backend: "catalogue", method: "GET", path: "/items/{itemId}" });
    expect(forwardStart({ ...op, suggest: { backend: "stock", method: "POST", path: "/find" } }, ["stock", "catalogue"])).toEqual({ backend: "stock", method: "POST", path: "/find" });
    // a call to a backend the new service does not know, or a path built in code: the operation's own method and "/"
    expect(forwardStart({ ...op, title: "POST /pay", source: { calls: [{ method: "PUT", path: "#[vars.url]", backend: "gone" }] } }, ["stock"])).toEqual({ backend: "stock", method: "POST", path: "/" });
    expect(forwardStart({ ...op, source: { calls: [{ method: "GET", path: "#[vars.url]", backend: "stock" }] } }, ["stock"])).toEqual({ backend: "stock", method: "GET", path: "/" });
    expect(forwardStart({ ...op, source: null }, [])).toEqual({ backend: "", method: "GET", path: "/" });
  });
  it("checks an API that is added while a call is passed on", () => {
    expect(NEW_API).not.toMatch(/^[A-Za-z_]\w*$/);            // can never be the name of a real backend
    expect(newApiProblem("loyalty engine", "https://loyalty.internal/api", ["catalogue"])).toEqual({ name: "", url: "" });
    expect(newApiProblem("", "", []).name).toMatch(/Give the new API a name/);
    expect(newApiProblem("", "", []).url).toMatch(/Enter the address/);
    expect(newApiProblem("2nd engine", "https://x.internal", []).name).toMatch(/start with a letter/);
    expect(newApiProblem("loyalty/engine", "https://x.internal", []).name).toMatch(/letters, digits and spaces/);
    expect(newApiProblem("Loyalty  Engine", "https://x.internal", ["loyaltyEngine"]).name).toMatch(/already knows loyaltyEngine/);
    expect(newApiProblem("a", "loyalty.internal", []).url).toMatch(/http:\/\/ or https:\/\//);
    expect(newApiProblem("a", "http://localhost:9090/x", []).url).toMatch(/localhost cannot be reached/);
    expect(newApiProblem("a", "http://127.0.0.1", []).url).toMatch(/localhost cannot be reached/);
    expect(newApiProblem("ab", "http://localhost.example.internal/x", []).url).toBe("");
    // the form's path check does not ask for a known backend when a new one is being added
    expect(decisionProblem({ action: "forward", newBackend: { name: "loyalty", url: "https://x.internal" }, method: "GET", path: "/items/{itemId}" }, op)).toBe("");
    expect(decisionProblem({ action: "forward", newBackend: { name: "loyalty", url: "https://x.internal" }, method: "GET", path: "items" }, op)).toMatch(/starts with/);
  });
  it("lists what a pass-on would leave undone", () => {
    expect(passOnLoses({ source: { loses: ["It calls other systems 2 times. A pass-on makes one call.", " ", 7] } })).toEqual(["It calls other systems 2 times. A pass-on makes one call.", "7"]);
    expect(passOnLoses({ source: { loses: "x" } })).toEqual([]);
    expect(passOnLoses({ source: null })).toEqual([]);
    expect(passOnLoses({})).toEqual([]);
  });
  it("says why a decision cannot be saved yet", () => {
    const f = (path: string, backend = "catalogue") => decisionProblem({ action: "forward", backend, method: "GET", path }, op);
    expect(f("/items/{itemId}")).toBe("");
    expect(f("/v2/items.json")).toBe("");
    expect(f("/items", "")).toMatch(/Choose the API/);
    expect(f("items")).toMatch(/starts with/);
    expect(f("/items?x=1")).toMatch(/letters/);
    expect(f("/items/{other}")).toMatch(/only has \{itemId\}/);
    expect(f("/items/{itemId")).toMatch(/only has/);
    expect(decisionProblem({ action: "forward", backend: "a", method: "GET", path: "/a/{id}" }, {})).toMatch(/no values/);
    expect(decisionProblem({ action: "not_needed", reason: "  " }, op)).toMatch(/why/);
    expect(decisionProblem({ action: "not_needed", reason: "replaced by the new portal" }, op)).toBe("");
    expect(decisionProblem({ action: "address", url: "catalogue.internal" }, op)).toMatch(/http/);
    expect(decisionProblem({ action: "address", url: "http://localhost:8080" }, op)).toMatch(/localhost/);
    expect(decisionProblem({ action: "address", url: "https://catalogue.internal/api" }, op)).toBe("");
    expect(decisionProblem({ action: "address", from: "shore/uat" }, op)).toBe("");
    expect(decisionProblem({ action: "note", note: "" }, op)).toMatch(/note/);
    expect(decisionProblem({ action: "note", note: "Returns the guest's bookings." }, op)).toBe("");
    expect(decisionProblem({ action: "" }, op)).toMatch(/Choose/);
  });
  it("lists the settings files a backend address can be taken from", () => {
    expect(sourceEnvs({ fromSource: ["shore/prod", "shore/uat"] })).toEqual(["shore/prod", "shore/uat"]);
    expect(sourceEnvs({ fromSource: ["uat", "", 7, null] })).toEqual(["uat"]);
    expect(sourceEnvs({})).toEqual([]);
    expect(sourceEnvs({ fromSource: "uat" })).toEqual([]);
  });
  it("says that a note does not finish an item, and what does", () => {
    expect(noteLimit(["forward", "not_needed", "note"])).toBe("A note does not finish this part. The tool does not write logic from a description, so it stays open until its code is written, or until it is passed on to an API or it is marked as not needed.");
    expect(noteLimit(["not_needed", "note"])).toMatch(/code is written, or until it is marked as not needed\.$/);
    expect(noteLimit(["note"])).toMatch(/until its code is written\.$/);
    expect(noteLimit(undefined)).toMatch(/does not finish/);
  });
  it("does not call a service finished when nothing is open but it is not ready", () => {
    expect(nothingOpen({ ready: true, summary: "x" })).toEqual({ done: true, text: "Every item of this service has been decided." });
    expect(nothingOpen({ ready: false, summary: "every operation of this service was marked as not needed, so there is nothing to deploy" }))
      .toEqual({ done: false, text: "Not finished: every operation of this service was marked as not needed, so there is nothing to deploy." });
    expect(nothingOpen({ ready: false }).done).toBe(false);
    expect(nothingOpen({ ready: false }).text).toMatch(/not finished yet/);
  });
  it("sums up the old code in one line", () => {
    expect(sourceSummary({ steps: 1, parts: 1, transforms: 0 })).toBe("1 step in the old code; none of them reshapes the data.");
    expect(sourceSummary({ steps: 12, parts: 3, transforms: 1 })).toBe("12 steps in 3 parts of the old code; 1 of them reshapes the data.");
    expect(sourceSummary({ steps: 9, parts: 2, transforms: 4 })).toBe("9 steps in 2 parts of the old code; 4 of them reshape the data.");
  });
  it("offers \"Build and check\" when decisions wait to be installed", () => {
    const done = ["upload", "document", "scaffold", "test", "deploy"].map((key) => ({ key, status: "done" }));
    const m = { id: "m1", apiName: "a-proc-api", status: "deployed", serviceDir: "services/a", phases: done, progress: { outcome: "Deployed, not finished", failure: { phase: "Testing", phaseKey: "test", stepKey: "build", step: "Build", status: "action_required", detail: "",
      help: { kind: "pending-changes", what: "The installed service is still the earlier version.", why: "", todo: [], retry: true } } } };
    expect(failureView(m as never)?.retry).toEqual({ id: "test", label: "Build and check" });
  });
});

describe("projects from a git repository", () => {
  const form = { name: "Integration", url: "https://git.example.test/team/apis.git", branch: "", token: "" };
  it("accepts an https address, with or without a branch and a token", () => {
    expect(repoFormProblems(form)).toEqual({});
    expect(repoFormProblems({ ...form, branch: "release/2.1", token: "abc" })).toEqual({});
  });
  it("says what is wrong with an address, a branch or a token", () => {
    expect(repoFormProblems({ ...form, name: " ", url: "" })).toMatchObject({ name: expect.any(String), url: expect.stringMatching(/Paste/) });
    expect(repoFormProblems({ ...form, url: "git@git.example.test:team/apis.git" }).url).toMatch(/Clone with HTTPS/);
    expect(repoFormProblems({ ...form, url: "http://git.example.test/team/apis.git" }).url).toMatch(/https:\/\//);
    expect(repoFormProblems({ ...form, url: "https://me:pw@git.example.test/team/apis.git" }).url).toMatch(/own fields/);
    expect(repoFormProblems({ ...form, branch: "my branch" }).branch).toBeTruthy();
    expect(repoFormProblems({ ...form, token: "a\nb" }).token).toMatch(/one line/);
  });
  it("describes the state of a repository", () => {
    const now = Date.parse("2026-11-15T12:00:00Z");
    expect(repoState({ state: "reading" }).label).toBe("Reading");
    expect(repoState({ state: "failed", message: "The git server refused the sign-in." })).toMatchObject({ tone: "bad", detail: "The git server refused the sign-in." });
    expect(repoState({ state: "ready", projects: [{}, {}], onBranch: "main", commit: "0123456789abcdef", readAt: "2026-11-15T11:57:00Z" }, now))
      .toEqual({ tone: "ok", label: "Read", detail: "2 projects · branch main · commit 0123456 · read 3 min ago" });
    expect(repoState({ state: "ready", projects: [] })).toMatchObject({ tone: "warn", detail: "No project was found in it" });
  });
  it("ticks only what is not migrated yet and names the state of the rest", () => {
    const ps = [{ path: "a" }, { path: "b", migrations: [{ outcome: "Deployed" }] }, { path: "c", migrations: [{ outcome: "Ready to deploy", queued: true }] }, { path: "d", migrations: [] }];
    expect(notMigratedYet(ps)).toEqual(["a", "d"]);
    expect(projectState(ps[0]).text).toBe("Not migrated yet");
    expect(projectState(ps[1])).toEqual({ tone: "ok", text: "Deployed" });
    expect(projectState(ps[2])).toEqual({ tone: "accent", text: "Being migrated" });
  });
  it("says in one sentence what will start", () => {
    expect(importPlan(0, "uat", true)).toMatch(/Tick/);
    expect(importPlan(1, "", false)).toBe("1 project is worked through one after the other: each is read and documented and turned into a service. Nothing is deployed until you say so.");
    expect(importPlan(3, "shore/uat", true)).toBe("3 projects are worked through one after the other: each is read and documented, turned into a service, given the addresses from its settings file \"shore/uat\" and built and tested. Nothing is deployed until you say so.");
  });
});
