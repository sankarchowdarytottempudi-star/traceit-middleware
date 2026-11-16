// "Database (MySQL)" and "Database (SQL Server)" steps. Same contract as "Database (Postgres)":
// a parameterised statement whose values travel to the driver separately, the result as rows,
// the first row or a count; plus stored procedures, a row limit, a timeout and read-only connections.
import { evalExpr } from "../expr.js";
import { FlowError, type NodeCtx, type NodeHandler } from "./engine.js";
import { kvList, connectionOf } from "./nodes.js";
import { ENGINE_LABEL, SqlProblem, parseOutputs, runMssql, runMysql, type SqlEngine, type SqlResult } from "../clients/sqldb.js";

const numOr = (v: unknown, d: number) => { const n = Number(v); return v !== undefined && v !== null && v !== "" && Number.isFinite(n) ? n : d; };
const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi);

async function evalAll(list: unknown, c: NodeCtx): Promise<unknown[]> {
  const es = c.run.es(c.scope); const out: unknown[] = [];
  for (const p of Array.isArray(list) ? list : []) { const v = typeof p === "string" ? await evalExpr(p, es) : p; out.push(v === undefined ? null : v); }
  return out;
}

function shape(cfg: Record<string, unknown>, res: SqlResult): unknown {
  switch (cfg.resultMode) {
    case "first": return res.rows[0] ?? null;
    case "count": return res.rowCount;
    case "details": return { rows: res.rows, rowCount: res.rowCount, truncated: res.truncated,
      ...(res.output ? { output: res.output } : {}), ...(res.returnValue !== undefined ? { returnValue: res.returnValue } : {}), ...(res.insertId !== undefined ? { insertId: res.insertId } : {}) };
    default: return res.rows;
  }
}

function sqlStep(engine: SqlEngine): NodeHandler {
  return async (c) => {
    const cfg = c.cfg;
    const conn = connectionOf(c, cfg.connection, engine, true)!;
    const mode = cfg.operation === "procedure" ? "procedure" : "query";
    const es = c.run.es(c.scope);
    const inputs: { key: string; value: unknown }[] = [];
    if (engine === "mssql" && mode === "procedure") for (const kv of kvList(cfg.procInputs)) inputs.push({ key: kv.key, value: typeof kv.value === "string" ? await evalExpr(kv.value, es) : kv.value ?? null });
    const started = Date.now();
    try {
      const run = {
        engine, mode, sql: String(cfg.sql ?? ""), procedure: String(cfg.procedure ?? ""),
        params: mode === "procedure" && engine === "mssql" ? [] : await evalAll(cfg.params, c), inputs,
        outputs: engine === "mssql" && mode === "procedure" ? parseOutputs(cfg.procOutputs) : [],
        maxRows: Math.floor(clamp(numOr(cfg.maxRows, 1000), 1, 100_000)), timeoutMs: Math.floor(clamp(numOr(cfg.timeoutSeconds, 60), 1, 600) * 1000),
        readOnly: conn.config.readOnly === true, allowMultiple: cfg.allowMultiple === true, secrets: Object.values(conn.secrets).filter(Boolean),
        database: String(conn.config.database ?? ""),
      } as const;
      const res = engine === "mysql" ? await runMysql(c.run.deps.data.sql, conn, { ...run, params: [...run.params], inputs: [...run.inputs], outputs: [...run.outputs] })
        : await runMssql(c.run.deps.data.sql, conn, { ...run, params: [...run.params], inputs: [...run.inputs], outputs: [...run.outputs] });
      c.step.meta = { db: { engine: ENGINE_LABEL[engine], rows: res.rows.length, rowCount: res.rowCount, truncated: res.truncated, ms: Date.now() - started } };
      if (res.truncated) c.run.log("warn", `Only the first ${res.rows.length} rows were kept (row limit)`, c.node.name);
      return { result: shape(cfg, res) };
    } catch (e) {
      if (e instanceof SqlProblem) {
        const status = e.kind === "config" || e.kind === "read-only" ? 500 : e.kind === "timeout" ? 504 : 502;
        throw new FlowError(`${ENGINE_LABEL[engine]} "${conn.name}": ${e.message}`, { status, detail: { code: e.code, kind: e.kind } });
      }
      throw e;
    }
  };
}

export const mysqlQuery = sqlStep("mysql");
export const mssqlQuery = sqlStep("mssql");
