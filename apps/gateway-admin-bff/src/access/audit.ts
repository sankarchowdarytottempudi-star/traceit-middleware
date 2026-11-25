// Append-only audit log: one JSON object per line (time, user, action, target, ...). Both apps
// append to the same file; each entry is written with a single O_APPEND write, so lines from the
// two processes never mix. Nothing here ever rewrites or shortens the file.
import { appendFileSync, closeSync, mkdirSync, openSync, readSync, statSync } from "node:fs";
import { dirname } from "node:path";

export interface AuditEntry {
  time: string;
  user: string;
  action: string;
  target?: string;
  /** Which app wrote it: "gateway" or "factory". */
  app?: string;
  provider?: string;
  /** "service-account" when API Manager was called with the server's own credentials for this person. */
  via?: string;
  status?: number;
  ip?: string;
  detail?: string;
}

export interface AuditLog {
  enabled: boolean;
  write(e: Omit<AuditEntry, "time"> & { time?: string }): void;
  /** Newest first. */
  read(opts?: { limit?: number; q?: string }): AuditEntry[];
}

const TAIL_BYTES = 8 * 1024 * 1024;

function clip(v: unknown, n: number): string | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const s = String(v).replace(/[\r\n]+/g, " ");
  return s.length > n ? s.slice(0, n) + "…" : s;
}

export function createAuditLog(file: string | undefined, appName: string): AuditLog {
  if (!file) return { enabled: false, write() { /* off */ }, read: () => [] };
  let made = false;
  return {
    enabled: true,
    write(e) {
      const line: AuditEntry = {
        time: e.time ?? new Date().toISOString(), user: clip(e.user, 200) ?? "unknown", action: clip(e.action, 200) ?? "",
        ...(e.target ? { target: clip(e.target, 500) } : {}), app: e.app ?? appName,
        ...(e.provider ? { provider: e.provider } : {}), ...(e.via ? { via: e.via } : {}),
        ...(e.status !== undefined ? { status: e.status } : {}), ...(e.ip ? { ip: clip(e.ip, 64) } : {}),
        ...(e.detail ? { detail: clip(e.detail, 1000) } : {}),
      };
      try {
        if (!made) { mkdirSync(dirname(file), { recursive: true }); made = true; }
        appendFileSync(file, JSON.stringify(line) + "\n", { mode: 0o600, flag: "a" });
      } catch (err) { console.error("audit write failed", (err as Error).message); }
    },
    read({ limit = 200, q } = {}) {
      let text = "";
      try {
        const size = statSync(file).size;
        const start = Math.max(0, size - TAIL_BYTES);
        const fd = openSync(file, "r");
        try { const buf = Buffer.alloc(size - start); readSync(fd, buf, 0, buf.length, start); text = buf.toString("utf8"); } finally { closeSync(fd); }
        if (start > 0) text = text.slice(text.indexOf("\n") + 1);
      } catch { return []; }
      const needle = (q ?? "").trim().toLowerCase();
      const out: AuditEntry[] = [];
      const lines = text.split("\n");
      for (let i = lines.length - 1; i >= 0 && out.length < Math.min(Math.max(limit, 1), 2000); i--) {
        const l = lines[i]; if (!l) continue;
        if (needle && !l.toLowerCase().includes(needle)) continue;
        try { out.push(JSON.parse(l) as AuditEntry); } catch { /* skip a damaged line */ }
      }
      return out;
    },
  };
}
