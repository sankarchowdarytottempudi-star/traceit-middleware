// Parts of a service that start by themselves (a timer, a queue or topic listener): what the
// migration tool knows about them, and what the running service said about them when it started.
// Only names and states are read from the log, never values.
import type { LogLine } from "./k8s.js";

export interface StartPart { name: string; starts?: string; kind?: string; switch?: string | null; on?: boolean | null }
export type StartLive = "on" | "off" | "not-started" | "unknown";
export interface StartState {
  name: string; starts: string; kind?: string; switch?: string;
  /** What the settings say: true on, false off, null when the tool does not know the switch. */
  on: boolean | null;
  /** What the running service said at start-up. */
  live: StartLive;
  /** The state text the service logged, e.g. "ON, every 60.0s (mode delta…)" (masked, short). */
  said?: string;
  /** Plain-words reason when it did not start. */
  why?: string;
}
export interface RunSummary { finished: number; failed: number; lastAt?: string; last?: "finished" | "failed"; lastReason?: string }

const clean = (s: string) => s
  .replace(/[a-z][a-z0-9+.-]*:\/\/[^\s"',)]+/gi, "<address>")
  .replace(/\b[\w.+-]+@[\w-]+\.[\w.-]+/g, "<mailbox>")
  .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, "<ip>")
  .slice(0, 200);

function stateOf(said: string): StartLive {
  const s = said.trim().toLowerCase();
  if (s.startsWith("not started")) return "not-started";
  if (s === "off" || s.startsWith("off,") || s.startsWith("off ") || s.startsWith("switched off")) return "off";
  if (s.startsWith("on")) return "on";
  return "unknown";
}

/** The parts with what the log says about them. The newest start-up line wins. */
export function startStates(parts: StartPart[], lines: LogLine[]): StartState[] {
  const said = new Map<string, string>();
  for (const l of lines) {
    for (const m of l.text.matchAll(/\b([A-Za-z][\w]*)="([^"]*)"/g)) {
      const [, key, value] = m;
      if (["timer", "queue", "topic", "scheduler", "listener"].includes(key) || parts.some((p) => p.switch && p.switch === key)) said.set(`k:${key}`, value);
    }
    const sp = /startingPoint="([^"]+)"[^\n]*?state="([^"]*)"/.exec(l.text);
    if (sp) said.set(`p:${sp[1]}`, sp[2]);
  }
  return parts.map((p) => {
    const kindKey = /scheduler|poll/i.test(p.kind || "") || /timer/i.test(p.starts || "") ? "timer" : /kafka|topic/i.test(`${p.kind} ${p.starts}`) ? "topic" : "queue";
    const raw = said.get(`p:${p.name}`) ?? (p.switch ? said.get(`k:${p.switch}`) : undefined)
      ?? (parts.filter((x) => (x.switch || "") === "" && x !== p).length === 0 || parts.length === 1 ? said.get(`k:${kindKey}`) : undefined);
    const live = raw === undefined ? "unknown" : stateOf(raw);
    const text = raw === undefined ? undefined : clean(raw);
    return {
      name: p.name, starts: p.starts || (kindKey === "timer" ? "runs on a timer" : kindKey === "topic" ? "starts from a topic" : "starts from a message queue"),
      kind: p.kind, switch: p.switch || undefined, on: p.on === true ? true : p.on === false ? false : null, live, said: text,
      why: live === "not-started" && text ? text.replace(/^not started,?\s*/i, "") : undefined,
    };
  });
}

/** How the runs of a timer job went, from its log ("… run finished" / "… run failed"). */
export function runSummary(lines: LogLine[]): RunSummary | undefined {
  let finished = 0, failed = 0; let lastAt: string | undefined; let last: RunSummary["last"]; let lastReason: string | undefined;
  for (const l of lines) {
    const fin = /message="[^"]*\brun finished"/.test(l.text), fail = /message="[^"]*\brun failed"/.test(l.text);
    if (!fin && !fail) continue;
    if (fin) finished++; else failed++;
    if (!lastAt || (l.at && l.at >= lastAt)) {
      lastAt = l.at; last = fin ? "finished" : "failed";
      const r = /reason="([^"]*)"/.exec(l.text); lastReason = fail && r ? clean(r[1]) : undefined;
    }
  }
  return finished + failed ? { finished, failed, lastAt, last, lastReason } : undefined;
}

/** Warnings of the code reader that are wrong for a service whose work starts by itself. */
export function isHealthOnlyWarning(w: string): boolean { return /answers health checks only/i.test(w); }
