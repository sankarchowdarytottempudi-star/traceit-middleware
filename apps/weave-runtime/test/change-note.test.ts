// "Change in your own words" saves a new revision with the user's words as the note of that version;
// the note is never stored in the flow itself. Undo restores the version before it.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Flow, FlowNode } from "@traceit/weave-flow";
import { loadConfig } from "../src/config.js";
import { Runtime } from "../src/runtime.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wr-note-"));
let rt: Runtime;
beforeAll(() => { rt = new Runtime(loadConfig({ DATA_DIR: tmp, SECRET_KEY_FILE: path.join(tmp, "k"), RUNTIME_INTERNAL_KEY: "k", PORT: "0", GATEWAY_RECONCILE_SECONDS: "0" } as NodeJS.ProcessEnv)); });
afterAll(async () => { await rt.close(); fs.rmSync(tmp, { recursive: true, force: true }); });
const node = (id: string, type: string, config: Record<string, unknown>): FlowNode => ({ id, type, name: id, position: { x: 0, y: 0 }, config } as FlowNode);

describe("a save with a change note", () => {
  it("puts the words in the version history, not in the flow, and undo restores the version before", async () => {
    const f = await rt.createFlow({ name: "note test", flow: { nodes: [node("in", "trigger.http", { methods: ["GET"], path: "/x" }), node("out", "respond", { status: "200", body: "$" })], edges: [{ id: "e1", from: "in", fromPort: "out", to: "out" }] } as never });
    const changed = { ...f, nodes: f.nodes.map((n) => (n.id === "out" ? { ...n, config: { ...n.config, status: "201" } } : n)), changeNote: "In your own words (out): answer 201 instead of 200" } as Flow & { changeNote: string };
    const saved = await rt.updateFlow(f.id, changed);
    expect(saved.revision).toBe(f.revision + 1);
    expect(saved).not.toHaveProperty("changeNote");
    const versions = rt.store.listVersions(f.id);
    expect(versions.find((v) => v.revision === saved.revision)?.note).toBe("In your own words (out): answer 201 instead of 200");
    const back = await rt.restoreVersion(f.id, f.revision);
    expect(back.nodes.find((n) => n.id === "out")!.config.status).toBe("200");
    expect(rt.store.listVersions(f.id).find((v) => v.revision === back.revision)?.note).toBe(`Restored from revision ${f.revision}`);
    const long = await rt.updateFlow(f.id, { ...back, changeNote: "x".repeat(500) } as Flow);
    expect(rt.store.listVersions(f.id).find((v) => v.revision === long.revision)?.note).toHaveLength(300);
  });
});
