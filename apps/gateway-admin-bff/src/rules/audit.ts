// JSON-lines audit of every write made from the console (GATEWAY_AUDIT_FILE).
// One line per action: who, what, on which API, a short before/after summary and the outcome.
import { appendFile, mkdir, readFile, stat } from "node:fs/promises";
import { dirname } from "node:path";

export interface AuditLine {
  at: string; user: string; action: string; outcome: "ok" | "failed";
  apiId?: string; apiName?: string; target?: string; environment?: string; revision?: string;
  before?: string; after?: string; detail?: string;
}
export interface Audit {
  file: string;
  write(line: Omit<AuditLine, "at">): Promise<void>;
  /** Newest first. */
  read(filter?: { apiId?: string; limit?: number }): Promise<AuditLine[]>;
}

const MAX_READ = 8 * 1024 * 1024; // only the last 8 MB is read back for the screens
const clip = (s: string | undefined, n = 600) => (s && s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function createAudit(file: string, now: () => Date = () => new Date()): Audit {
  let chain: Promise<void> = Promise.resolve();
  return {
    file,
    write(line) {
      const rec: AuditLine = { at: now().toISOString(), ...line, before: clip(line.before), after: clip(line.after), detail: clip(line.detail, 300) };
      // writes are serialised so lines never interleave
      chain = chain.then(async () => {
        await mkdir(dirname(file), { recursive: true });
        await appendFile(file, JSON.stringify(rec) + "\n", { encoding: "utf8", mode: 0o600 });
      }).catch(() => undefined);
      return chain;
    },
    async read(filter = {}) {
      let text = "";
      try {
        const st = await stat(file);
        const buf = await readFile(file);
        text = buf.subarray(Math.max(0, st.size - MAX_READ)).toString("utf8");
      } catch { return []; }
      const out: AuditLine[] = [];
      const lines = text.split("\n");
      for (let i = lines.length - 1; i >= 0 && out.length < (filter.limit ?? 200); i--) {
        const l = lines[i].trim();
        if (!l) continue;
        try {
          const j = JSON.parse(l) as AuditLine;
          if (filter.apiId && j.apiId !== filter.apiId) continue;
          out.push(j);
        } catch { /* partial first line of the window */ }
      }
      return out;
    },
  };
}
