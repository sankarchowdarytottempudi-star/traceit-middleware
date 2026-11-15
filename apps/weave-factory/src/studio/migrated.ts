import type { EstateApi, EstateCounts } from "./api.ts";
// Wording for calls that went through the migrated services (no React here, so it can be tested alone).
import type { MigratedExecutionSummary, MigratedExecutionStep } from "../api.ts";

export const MIGRATED_STATUS = [{ v: "", l: "Any result" }, { v: "success", l: "Succeeded" }, { v: "error", l: "Failed" }, { v: "running", l: "Still running" }, { v: "unknown", l: "No result logged" }];
export const MIGRATED_KIND = [{ v: "", l: "Calls and jobs" }, { v: "call", l: "Calls only" }, { v: "job", l: "Jobs only" }];
export const MIGRATED_VIA = [{ v: "", l: "Any caller" }, { v: "gateway", l: "Through the gateway" }, { v: "internal", l: "Inside the cluster" }, { v: "direct", l: "Not through the gateway" }];

export function migratedStatusLabel(status: unknown): string {
  return status === "success" ? "Succeeded" : status === "error" ? "Failed" : status === "running" ? "Running" : "No result logged";
}

const words = (s: string) => s.toLowerCase().replace(/[_-]+/g, " ").replace(/^./, (c) => c.toUpperCase());

/** Who started it, in two short lines: the caller, and how the call arrived. */
export function calledBy(x: Pick<MigratedExecutionSummary, "kind" | "via" | "application" | "trigger"> & { httpStatus?: number }): { main: string; sub: string } {
  if (x.kind === "job") return { main: x.trigger ? words(x.trigger) : "Background job", sub: "Job inside the service" };
  if (x.via === "gateway") return { main: x.application || (x.httpStatus === 401 ? "Caller without a valid key" : "Unknown application"), sub: "Through the gateway" };
  if (x.via === "internal") return { main: "Another service", sub: "Inside the cluster" };
  if (x.via === "direct") return { main: "Direct call", sub: "Not through the gateway" };
  return { main: "-", sub: "Caller not recorded" };
}

/** The services a call went through, entry first; empty when only one took part. */
export function chainText(x: Pick<MigratedExecutionSummary, "chain">): string {
  const c = (x.chain ?? []).filter(Boolean);
  return c.length > 1 ? c.join(" → ") : "";
}

export function offsetLabel(ms: unknown): string {
  const n = Number(ms);
  if (!Number.isFinite(n)) return "";
  const a = Math.abs(n), sign = n < 0 ? "-" : "+";
  if (a < 1000) return `${sign}${Math.round(a)} ms`;
  if (a < 60_000) return `${sign}${(a / 1000).toFixed(a < 10_000 ? 2 : 1)} s`;
  const m = Math.floor(a / 60_000), s = Math.round((a % 60_000) / 1000);
  return `${sign}${m} min ${s} s`;
}

const HINT_KEYS = ["operation", "operationName", "rootField", "job", "targetApi", "method", "path", "status", "outcome", "attempt", "elapsedMs", "durationMs", "bytes", "sourceEndpoint"];
/** The few fields worth reading without opening the line. */
export function stepHints(s: Pick<MigratedExecutionStep, "fields">, max = 4): { key: string; value: string }[] {
  const out: { key: string; value: string }[] = [];
  for (const k of HINT_KEYS) {
    const v = s.fields?.[k];
    if (v === undefined || v === "" || out.length >= max) continue;
    out.push({ key: k, value: String(v).length > 60 ? `${String(v).slice(0, 60)}…` : String(v) });
  }
  return out;
}

export const stepTone = (level: unknown): "error" | "warn" | "info" => {
  const l = String(level ?? "").toLowerCase();
  return l.startsWith("err") || l === "fatal" ? "error" : l.startsWith("warn") ? "warn" : "info";
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** One line that says what is on this page and how it adds up, so no number has to be guessed. */
export function estateTotals(flows: number, apis: EstateApi[], counts?: EstateCounts): { total: number; text: string; migrations: string } {
  const unfinished = apis.filter((a) => a.unfinished).length;
  const finished = apis.length - unfinished;
  const text = `${plural(flows, "flow")} built here and ${plural(apis.length, "migrated service")} running`
    + (apis.length ? ` (${finished} finished${unfinished ? `, ${unfinished} not finished` : ""})` : "");
  const migrations = counts && counts.migrations
    ? `Migrate lists ${plural(counts.migrations, "migration")} for ${plural(counts.migratedApis, "API")}: an API that was migrated more than once is one service here, and a migration appears here once its service is installed.`
    : "";
  return { total: flows + apis.length, text, migrations };
}
