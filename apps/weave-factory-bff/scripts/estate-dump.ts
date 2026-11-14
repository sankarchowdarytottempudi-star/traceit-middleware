// Diagnostic: read the service sources and print what the estate reader finds.
//   npx tsx scripts/estate-dump.ts [api] [--json]
// Uses SERVICES_DIR and ESTATE_CONFIG_DIR from the environment. Prints no secret values.
import { buildApi, discoverSources } from "../src/estate/model.js";
import type { Step } from "../src/estate/walk.js";

const only = process.argv.slice(2).find((a) => !a.startsWith("--"));
const json = process.argv.includes("--json");
const configDirs = (process.env.ESTATE_CONFIG_DIR || "").split(",").map((s) => s.trim()).filter(Boolean);

function show(steps: Step[], indent: string): void {
  for (const s of steps) {
    if (s.kind === "call") console.log(`${indent}CALL ${s.client}->${s.op} ${s.path?.value ?? s.path?.text ?? ""} ${s.body?.mapping ? "[map " + s.body.mapping + "]" : ""} hdr=${(s.headers?.names || []).join("|")} fwd=${(s.headers?.forwarded || []).join("|")}`);
    else if (s.kind === "map") console.log(`${indent}MAP ${s.mapping}`);
    else if (s.kind === "respond") console.log(`${indent}RESPOND ${s.status}${s.guard ? " (guard: " + s.when + ")" : ""} ${s.message || ""}`);
    else if (s.kind === "if") { console.log(`${indent}IF ${s.cond}${s.thenReturns ? " [returns]" : ""}`); show(s.then, indent + "  "); if (s.else.length) { console.log(`${indent}ELSE`); show(s.else, indent + "  "); } }
    else if (s.kind === "match") { console.log(`${indent}MATCH ${s.subject}`); for (const c of s.cases) { console.log(`${indent}  CASE ${c.label}`); show(c.steps, indent + "    "); } }
    else if (s.kind === "loop") { console.log(`${indent}LOOP ${s.header}`); show(s.steps, indent + "  "); }
    else if (s.kind === "async") { console.log(`${indent}ASYNC ${s.fn}`); show(s.steps, indent + "  "); }
  }
}

for (const e of discoverSources(process.env.SERVICES_DIR)) {
  if (only && e.name !== only) continue;
  const m = buildApi(e, configDirs);
  if (json) { console.log(JSON.stringify(m, (k, v) => (k === "code" || k === "steps" ? undefined : v), 1)); continue; }
  console.log(`\n== ${m.name}  base=${m.basePaths.join(",")}  ops=${m.operations.length} connectors=${m.connectors.length} mappings=${m.mappings.length} config=${m.config.length} (${m.configSource}) features=${m.features.join("|")}`);
  for (const w of m.warnings) console.log(`  ! ${w}`);
  for (const o of m.operations) {
    console.log(`  ${o.implemented ? "OP  " : "STUB"} ${o.method} ${o.fullPath}  [${o.id}] ${o.file}:${o.line}  ${o.summary || ""}`);
    if (only) show(o.steps, "      ");
  }
  for (const c of m.connectors) console.log(`  CONN ${c.name} (${c.kind}) -> ${c.target} key=${c.configKey || "-"} auth="${c.auth}" usedBy=${c.usedBy.join(",")} paths=${c.paths.join(" ")}${c.component ? " [" + c.component + "]" : ""}`);
  if (only) for (const mp of m.mappings) console.log(`  MAP ${mp.id} (${mp.kind}) ${mp.file}:${mp.line} fields=${(mp.fields || []).length} usedBy=${(mp.usedBy || []).join(",")}`);
  if (only) for (const c of m.config) console.log(`  CFG ${c.key} = ${c.value} [${c.source}]`);
}
