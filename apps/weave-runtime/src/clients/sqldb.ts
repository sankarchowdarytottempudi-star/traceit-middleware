// MySQL and SQL Server clients for the "Database (MySQL)" and "Database (SQL Server)" steps, one
// pool per connection (rebuilt when the connection is edited), plus what both steps share:
// the one-statement rule, the read-only rule, value mapping to JSON and errors in plain words.
// Parameters always travel to the driver separately from the SQL text; nothing is concatenated.
import mysql from "mysql2/promise";
import mssql from "mssql";
import type { ClusterDns } from "./dns.js";
import type { ResolvedConnection } from "./data.js";

export type SqlEngine = "mysql" | "mssql";
export const ENGINE_LABEL: Record<SqlEngine, string> = { mysql: "MySQL", mssql: "SQL Server" };

/** A database failure in plain words. `kind` says what went wrong; `code` is the database's own code. */
export class SqlProblem extends Error {
  constructor(message: string, readonly kind: string, readonly code: string | number | null) { super(message); }
}

// ---------------------------------------------------------------- statement checks
/** The SQL with string literals, quoted names and comments blanked out (same length), for checks. */
export function stripLiterals(sql: string, engine: SqlEngine): string {
  let out = ""; let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i]; const nx = sql[i + 1];
    if (ch === "-" && nx === "-") { const j = sql.indexOf("\n", i); const end = j < 0 ? n : j; out += " ".repeat(end - i); i = end; continue; }
    if (ch === "#" && engine === "mysql") { const j = sql.indexOf("\n", i); const end = j < 0 ? n : j; out += " ".repeat(end - i); i = end; continue; }
    if (ch === "/" && nx === "*") { const j = sql.indexOf("*/", i + 2); const end = j < 0 ? n : j + 2; out += " ".repeat(end - i); i = end; continue; }
    const close = ch === "'" ? "'" : ch === '"' ? '"' : ch === "`" && engine === "mysql" ? "`" : ch === "[" && engine === "mssql" ? "]" : "";
    if (close) {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === "\\" && engine === "mysql" && close !== "`") { j += 2; continue; }
        if (sql[j] === close) { if (sql[j + 1] === close) { j += 2; continue; } break; }
        j++;
      }
      const end = Math.min(j + 1, n); out += " ".repeat(end - i); i = end; continue;
    }
    out += ch; i++;
  }
  return out;
}
/** True when the text holds more than one statement (a trailing semicolon is fine). */
const ROUTINE_DEFINITION = /^\s*(create(\s+or\s+(alter|replace))?|alter)\s+(definer\s*=\s*\S+\s+)?(procedure|proc|function|trigger)\b/i;
export function hasMultipleStatements(sql: string, engine: SqlEngine): boolean {
  const s = stripLiterals(sql, engine).trim().replace(/;+\s*$/, "");
  // a procedure, function or trigger definition is one statement even with semicolons in its body
  if (ROUTINE_DEFINITION.test(s)) return false;
  return s.includes(";");
}
const WRITE_WORDS = /^(insert|update|delete|merge|replace|upsert|drop|alter|create|truncate|grant|revoke|rename|load|lock|unlock|set|use|kill|backup|restore|dbcc|bulk|attach|detach|deny|declare|xp_|sp_)/i;
/** The first word of the statement, after comments and opening brackets. */
export function firstWord(sql: string, engine: SqlEngine): string {
  const m = /^[\s(]*([A-Za-z_]+)/.exec(stripLiterals(sql, engine));
  return m ? m[1].toLowerCase() : "";
}
/** On a read-only connection, statements that change data or settings are refused before they run. */
export function isWriteStatement(sql: string, engine: SqlEngine): boolean {
  const s = stripLiterals(sql, engine);
  if (WRITE_WORDS.test(firstWord(sql, engine))) return true;
  // WITH … INSERT/UPDATE/DELETE/MERGE, SELECT … INTO new table, SELECT … FOR UPDATE
  if (/^\s*with\b/i.test(s) && /\b(insert|update|delete|merge)\b/i.test(s)) return true;
  if (/^\s*select\b/i.test(s) && /\binto\s+(?!@)[A-Za-z_#\[`]/i.test(s)) return true;
  return /\bfor\s+update\b/i.test(s);
}
const PROC_NAME: Record<SqlEngine, RegExp> = {
  mysql: /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)?$/,
  mssql: /^\[?[A-Za-z_#@][\w$#@]*\]?(\.\[?[A-Za-z_#@][\w$#@]*\]?){0,2}$/,
};
export function checkProcedureName(name: string, engine: SqlEngine): string {
  const n = name.trim();
  if (!n) throw new SqlProblem("Enter the name of the stored procedure", "config", null);
  if (!PROC_NAME[engine].test(n)) throw new SqlProblem(`"${n}" is not a valid stored procedure name (letters, digits, _ and a schema prefix only)`, "config", null);
  return n;
}
/** MySQL: CALL `schema`.`name`(?, ?, …) — the values still go to the driver separately. */
export function mysqlCall(name: string, count: number): string {
  const quoted = checkProcedureName(name, "mysql").split(".").map((p) => "`" + p + "`").join(".");
  return `CALL ${quoted}(${Array.from({ length: count }, () => "?").join(", ")})`;
}

// ---------------------------------------------------------------- values
/** A database value as JSON: dates as ISO strings, binary as base64, big integers as strings. */
export function plainValue(v: unknown): unknown {
  if (v === undefined || v === null) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  if (typeof v === "bigint") return v.toString();
  if (Buffer.isBuffer(v)) return v.toString("base64");
  if (v instanceof Uint8Array) return Buffer.from(v).toString("base64");
  if (Array.isArray(v)) return v.map(plainValue);
  if (typeof v === "object") { const out: Record<string, unknown> = {}; for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = plainValue(x); return out; }
  if (typeof v === "number" && !Number.isFinite(v)) return null;
  return v;
}
/** Rows as plain JSON objects. Columns listed in `asText` (decimals) become strings, as Postgres returns them. */
export function plainRows(rows: unknown[], asText: Set<string> = new Set()): Record<string, unknown>[] {
  return rows.map((r) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries((r ?? {}) as Record<string, unknown>)) out[k] = asText.has(k) && v !== null && v !== undefined && typeof v !== "string" ? String(v) : plainValue(v);
    return out;
  });
}
/** A parameter value as the driver gets it: objects and arrays as JSON text (as the Postgres step does). */
export function paramValue(v: unknown): unknown {
  if (v === undefined) return null;
  if (v !== null && typeof v === "object" && !(v instanceof Date) && !Buffer.isBuffer(v)) return JSON.stringify(v);
  return v;
}

// ---------------------------------------------------------------- errors
const CONNECT_CODES = ["ECONNREFUSED", "ENOTFOUND", "EHOSTUNREACH", "ENETUNREACH", "EAI_AGAIN", "ECONNRESET", "ESOCKET", "EINSTLOOKUP", "ETIMEDOUT", "ETIMEOUT"];
const TLS_CODES = /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER|ALTNAME|HANDSHAKE|EPROTO|SSL|TLS/i;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"]);
/** The codes of an error, including the ones inside an AggregateError (Node tries ::1 and 127.0.0.1 for "localhost"). */
export function errorCodes(e: unknown): string[] {
  const out: string[] = [];
  const add = (x: unknown) => { const c = (x as { code?: unknown } | null)?.code; if (typeof c === "string" && c && !out.includes(c)) out.push(c); };
  add(e);
  const inner = (e as { errors?: unknown[] } | null)?.errors;
  if (Array.isArray(inner)) inner.forEach(add);
  const cause = (e as { cause?: unknown } | null)?.cause;
  if (cause) { add(cause); const ic = (cause as { errors?: unknown[] }).errors; if (Array.isArray(ic)) ic.forEach(add); }
  return out;
}
/** A connection that could not be opened, in plain words. `null` when the error is not about reaching the server. */
export function connectProblem(label: string, e: unknown, where: { host?: string; port?: number | string; timeoutSeconds?: number } = {}): SqlProblem | null {
  const codes = errorCodes(e);
  const host = String(where.host ?? "").trim();
  const at = host ? `${host}${where.port ? `:${where.port}` : ""}` : `the ${label} server`;
  const local = LOCAL_HOSTS.has(host.toLowerCase());
  const localHint = local
    ? ` The flow runs on the Weave server, so '${host}' means the server, not your computer. To use a database on your computer, open a tunnel (ssh -N -R 13306:localhost:${where.port || 3306} <server>) and use host 127.0.0.1 port 13306, or use the database's network address.`
    : "";
  const code = codes[0] ?? null;
  const tls = codes.find((c) => TLS_CODES.test(c));
  if (tls) return new SqlProblem(`The ${label} server's TLS certificate could not be verified (${tls}). Check the host name, add the server's CA under "Own CA", or switch off certificate checking only for a test database.`, "tls", tls);
  if (codes.includes("ECONNREFUSED")) return new SqlProblem(`Nothing is listening at ${at}.${localHint || " Check the host and port, and that the database accepts connections from the Weave server."}`, "connect", "ECONNREFUSED");
  if (codes.includes("ENOTFOUND") || codes.includes("EAI_AGAIN") || codes.includes("EINSTLOOKUP")) return new SqlProblem(`The host name ${host || "given"} is not known on the Weave server.`, "connect", code);
  if (codes.includes("ETIMEDOUT") || codes.includes("ETIMEOUT")) return new SqlProblem(`No answer from ${at} within ${where.timeoutSeconds ?? "the allowed"} s — a firewall may block it.${localHint}`, "connect", code);
  if (codes.includes("EHOSTUNREACH") || codes.includes("ENETUNREACH")) return new SqlProblem(`The Weave server has no network route to ${at}.`, "connect", code);
  if (codes.includes("ECONNRESET") || codes.includes("ESOCKET")) return new SqlProblem(`${at} closed the connection straight away — it may expect TLS (or not), or not be a ${label} server.`, "connect", code);
  return null;
}
const scrub = (msg: string, secrets: string[]) => secrets.filter((s) => s && s.length >= 3).reduce((m, s) => m.split(s).join("***"), msg);
/** Any driver error as a SqlProblem in plain words, never showing a secret. */
export function explain(engine: SqlEngine, e: unknown, opts: { secrets?: string[]; timeoutSeconds?: number; timedOut?: boolean; database?: string; host?: string; port?: number | string; connectTimeoutSeconds?: number } = {}): SqlProblem {
  if (e instanceof SqlProblem) return e;
  const err = (e ?? {}) as { code?: string; errno?: number; number?: number; sqlMessage?: string; message?: string; originalError?: { info?: { number?: number; message?: string } } };
  const label = ENGINE_LABEL[engine];
  const raw = scrub(String(err.sqlMessage || err.originalError?.info?.message || err.message || e), opts.secrets ?? []);
  const num = engine === "mysql" ? err.errno : err.number ?? err.originalError?.info?.number;
  const tag = engine === "mysql" ? ` (MySQL error ${num ?? err.code ?? "?"}${err.code && num ? " " + err.code : ""})` : ` (SQL Server error ${num ?? err.code ?? "?"})`;
  const code = (num ?? err.code ?? null) as string | number | null;
  const c = String(err.code || "");
  if (opts.timedOut || c === "PROTOCOL_SEQUENCE_TIMEOUT" || c === "ECANCEL" || (engine === "mssql" && c === "ETIMEOUT" && !/connect/i.test(raw)))
    return new SqlProblem(`The query did not finish within ${opts.timeoutSeconds ?? "the allowed"} seconds and was stopped`, "timeout", code);
  const reach = connectProblem(label, e, { host: opts.host, port: opts.port, timeoutSeconds: opts.connectTimeoutSeconds });
  if (reach) { reach.message = scrub(reach.message, opts.secrets ?? []); return reach; }
  if (CONNECT_CODES.includes(c)) return new SqlProblem(`Cannot connect to the ${label} server (${c}).`, "connect", code);
  if (engine === "mysql") {
    if (num === 1045 || num === 1044 || c === "ER_ACCESS_DENIED_ERROR") return new SqlProblem(`Login failed: the user name or password is wrong, or this user may not use the database${tag}`, "login", code);
    if (num === 1049) return new SqlProblem(`The database${opts.database ? ` "${opts.database}"` : ""} does not exist on the server${tag}`, "database", code);
    if (num === 1146 || num === 1054 || num === 1305) return new SqlProblem(`Not found in the database: ${raw}${tag}`, "not-found", code);
    if ([1062, 1451, 1452, 1048, 1216, 1217, 3819, 1364].includes(num ?? -1)) return new SqlProblem(`A rule of the database refused the change: ${raw}${tag}`, "constraint", code);
    if (num === 1064) return new SqlProblem(`The SQL has a syntax error: ${raw}${tag}`, "syntax", code);
    if (num === 1792) return new SqlProblem(`The connection is read-only, so the database refused the change${tag}`, "read-only", code);
  } else {
    if (c === "ELOGIN" || num === 18456) return new SqlProblem(`Login failed: the user name or password is wrong, or this user may not use the database${tag}`, "login", code);
    if (num === 4060) return new SqlProblem(`The database${opts.database ? ` "${opts.database}"` : ""} cannot be opened: it does not exist or this user may not use it${tag}`, "database", code);
    if (num === 208 || num === 207 || num === 2812) return new SqlProblem(`Not found in the database: ${raw}${tag}`, "not-found", code);
    if ([2627, 2601, 547, 515, 8152, 2628].includes(num ?? -1)) return new SqlProblem(`A rule of the database refused the change: ${raw}${tag}`, "constraint", code);
    if ([102, 156, 170, 105].includes(num ?? -1)) return new SqlProblem(`The SQL has a syntax error: ${raw}${tag}`, "syntax", code);
  }
  return new SqlProblem(`The database refused the query: ${raw}${num || err.code ? tag : ""}`, "query", code);
}

// ---------------------------------------------------------------- pools
interface Drivers { mysql: typeof mysql; mssql: typeof mssql }
const poolMax = (c: ResolvedConnection) => Math.min(Math.max(Math.floor(Number(c.config.poolMax) || 5), 1), 20);
export const connectTimeoutMs = (c: ResolvedConnection) => Math.min(Math.max(Number(c.config.connectTimeoutSeconds) || 5, 1), 60) * 1000;
/** Host, port and connect timeout of a connection, for error messages (never the password). */
export const whereOf = (c: ResolvedConnection, defaultPort: number) => ({ host: String(c.config.host ?? ""), port: Number(c.config.port || defaultPort), connectTimeoutSeconds: Math.round(connectTimeoutMs(c) / 1000) });
export const poolMaxOf = (c: ResolvedConnection) => Math.min(Math.max(Math.floor(Number(c.config.poolMax) || 5), 1), 20);
const caOf = (c: ResolvedConnection) => { const s = String(c.config.caCert ?? "").trim(); return s ? s : undefined; };

export class SqlClients {
  private my = new Map<string, { stamp: string; pool: Promise<mysql.Pool> }>();
  private ms = new Map<string, { stamp: string; pool: Promise<mssql.ConnectionPool> }>();
  constructor(private dns: ClusterDns, readonly drivers: Drivers = { mysql, mssql }) {}

  async mysqlFor(c: ResolvedConnection, multiple = false): Promise<mysql.Pool> {
    const key = multiple ? `${c.id}:multi` : c.id;
    const hit = this.my.get(key);
    if (hit && hit.stamp === c.updatedAt) return hit.pool;
    if (hit) void hit.pool.then((p) => p.end()).catch(() => undefined);
    const p = this.openMysql(c, poolMax(c), multiple);
    this.my.set(key, { stamp: c.updatedAt, pool: p });
    p.catch(() => { if (this.my.get(key)?.pool === p) this.my.delete(key); });
    return p;
  }
  async openMysql(c: ResolvedConnection, max = 5, multiple = false): Promise<mysql.Pool> {
    const host = String(c.config.host || "");
    if (!host) throw new SqlProblem("The MySQL connection has no host", "config", null);
    // cluster names need the cluster DNS; other names stay names so a TLS certificate can be checked against them
    const target = this.dns.isClusterName(host) ? await this.dns.resolve(host) : host;
    const pool = this.drivers.mysql.createPool({
      host: target, port: Number(c.config.port || 3306), database: String(c.config.database || "") || undefined, user: String(c.config.user || ""),
      password: c.secrets.password || undefined,
      ssl: c.config.tls ? { rejectUnauthorized: c.config.tlsVerify !== false, ...(caOf(c) ? { ca: caOf(c) } : {}) } : undefined,
      connectionLimit: max, maxIdle: max, idleTimeout: 30_000, queueLimit: 100, waitForConnections: true, connectTimeout: connectTimeoutMs(c),
      supportBigNumbers: true, bigNumberStrings: false, // big integers as numbers while exact, as text beyond 2^53
      decimalNumbers: false, dateStrings: false, timezone: "Z",
      multipleStatements: multiple, namedPlaceholders: false,
    });
    pool.on("connection", () => undefined);
    return pool;
  }
  async mssqlFor(c: ResolvedConnection): Promise<mssql.ConnectionPool> {
    const hit = this.ms.get(c.id);
    if (hit && hit.stamp === c.updatedAt) return hit.pool;
    if (hit) void hit.pool.then((p) => p.close()).catch(() => undefined);
    const p = this.openMssql(c, poolMax(c));
    this.ms.set(c.id, { stamp: c.updatedAt, pool: p });
    p.catch(() => { if (this.ms.get(c.id)?.pool === p) this.ms.delete(c.id); });
    return p;
  }
  async openMssql(c: ResolvedConnection, max = 5): Promise<mssql.ConnectionPool> {
    const host = String(c.config.host || "");
    if (!host) throw new SqlProblem("The SQL Server connection has no host", "config", null);
    const target = this.dns.isClusterName(host) ? await this.dns.resolve(host) : host;
    const instance = String(c.config.instance || "").trim();
    const pool = new this.drivers.mssql.ConnectionPool({
      server: target, ...(instance ? {} : { port: Number(c.config.port || 1433) }), database: String(c.config.database || "") || undefined,
      user: String(c.config.user || ""), password: c.secrets.password || "",
      options: { encrypt: c.config.encrypt !== false, trustServerCertificate: c.config.trustServerCertificate === true, serverName: host, ...(instance ? { instanceName: instance } : {}),
        ...(caOf(c) ? { cryptoCredentialsDetails: { ca: caOf(c) } } : {}), enableArithAbort: true },
      pool: { max, min: 0, idleTimeoutMillis: 30_000 }, connectionTimeout: connectTimeoutMs(c), requestTimeout: 0,
    } as mssql.config);
    pool.on("error", () => undefined);
    await pool.connect();
    return pool;
  }
  async closeAll() {
    for (const p of this.my.values()) await p.pool.then((x) => x.end()).catch(() => undefined);
    for (const p of this.ms.values()) await p.pool.then((x) => x.close()).catch(() => undefined);
    this.my.clear(); this.ms.clear();
  }
}

// ---------------------------------------------------------------- running a statement
export interface SqlRun {
  engine: SqlEngine; mode: "query" | "procedure"; sql: string; procedure: string;
  params: unknown[];                         // positional (MySQL ?, SQL Server @p1…)
  inputs: { key: string; value: unknown }[]; // SQL Server procedure: named inputs
  outputs: { name: string; type: string }[]; // SQL Server procedure: output parameters
  maxRows: number; timeoutMs: number; readOnly: boolean; allowMultiple: boolean; secrets: string[]; database?: string;
}
export interface SqlResult { rows: Record<string, unknown>[]; rowCount: number; truncated: boolean; output?: Record<string, unknown>; returnValue?: unknown; insertId?: unknown }

/** Checks every rule that does not need the database: one statement, read-only, procedure name. */
export function preflight(r: Pick<SqlRun, "engine" | "mode" | "sql" | "procedure" | "readOnly" | "allowMultiple">): void {
  if (r.mode === "procedure") { checkProcedureName(r.procedure, r.engine); return; }
  if (!r.sql.trim()) throw new SqlProblem("The SQL statement is empty", "config", null);
  if (!r.allowMultiple && hasMultipleStatements(r.sql, r.engine)) throw new SqlProblem("The SQL holds more than one statement. Run one statement per step, or switch on \"Allow several statements\" under Advanced.", "config", null);
  if (r.readOnly && isWriteStatement(r.sql, r.engine)) throw new SqlProblem("This connection is read-only: statements that change data or settings are not run", "read-only", null);
}
const cut = (rows: Record<string, unknown>[], max: number) => ({ rows: rows.length > max ? rows.slice(0, max) : rows, truncated: rows.length > max });
const isHeader = (o: unknown) => !!o && typeof o === "object" && !Array.isArray(o) && "affectedRows" in (o as object) && ("fieldCount" in (o as object) || (o as object).constructor?.name === "ResultSetHeader");

/** The rows and counts of a mysql2 query result (one statement, several, or a CALL). */
export function mysqlShape(res: unknown): { rows: unknown[]; rowCount: number; insertId?: unknown } {
  if (isHeader(res)) { const h = res as { affectedRows: number; insertId?: number }; return { rows: [], rowCount: h.affectedRows, ...(h.insertId ? { insertId: h.insertId } : {}) }; }
  if (Array.isArray(res)) {
    if (res.length && (Array.isArray(res[0]) || isHeader(res[0]))) {
      const sets = res.filter(Array.isArray) as unknown[][];
      if (sets.length) { const last = sets[sets.length - 1]; return { rows: last, rowCount: last.length }; }
      const last = res[res.length - 1] as { affectedRows: number; insertId?: number };
      return { rows: [], rowCount: last.affectedRows, ...(last.insertId ? { insertId: last.insertId } : {}) };
    }
    return { rows: res, rowCount: res.length };
  }
  return { rows: [], rowCount: 0 };
}

export async function runMysql(clients: SqlClients, conn: ResolvedConnection, r: SqlRun): Promise<SqlResult> {
  preflight(r);
  let pool: mysql.Pool;
  try { pool = await clients.mysqlFor(conn, r.allowMultiple); } catch (e) { throw explain("mysql", e, { secrets: r.secrets, database: r.database, ...whereOf(conn, 3306) }); }
  let cx: mysql.PoolConnection | undefined;
  try {
    cx = await pool.getConnection();
    if (r.readOnly) await cx.query("START TRANSACTION READ ONLY");
    const sql = r.mode === "procedure" ? mysqlCall(r.procedure, r.params.length) : r.sql;
    const [res] = await cx.query({ sql, values: r.params.map(paramValue), timeout: r.timeoutMs });
    if (r.readOnly) await cx.query("COMMIT");
    const shaped = mysqlShape(res);
    const { rows, truncated } = cut(plainRows(shaped.rows), r.maxRows);
    return { rows, rowCount: shaped.rowCount, truncated, ...(shaped.insertId !== undefined ? { insertId: plainValue(shaped.insertId) } : {}) };
  } catch (e) {
    if (cx && r.readOnly) await cx.query("ROLLBACK").catch(() => undefined);
    throw explain("mysql", e, { secrets: r.secrets, timeoutSeconds: Math.round(r.timeoutMs / 1000), database: r.database, ...whereOf(conn, 3306) });
  } finally { cx?.release(); }
}

const MSSQL_TYPES: Record<string, () => unknown> = {
  int: () => mssql.Int, bigint: () => mssql.BigInt, smallint: () => mssql.SmallInt, tinyint: () => mssql.TinyInt, bit: () => mssql.Bit,
  float: () => mssql.Float, real: () => mssql.Real, decimal: () => mssql.Decimal(38, 10), numeric: () => mssql.Numeric(38, 10), money: () => mssql.Money,
  nvarchar: () => mssql.NVarChar(mssql.MAX), varchar: () => mssql.VarChar(mssql.MAX), date: () => mssql.Date, datetime: () => mssql.DateTime,
  datetime2: () => mssql.DateTime2, uniqueidentifier: () => mssql.UniqueIdentifier, varbinary: () => mssql.VarBinary(mssql.MAX),
};
export function parseOutputs(list: unknown): { name: string; type: string }[] {
  return (Array.isArray(list) ? list : []).map((s) => String(s ?? "").trim()).filter(Boolean).map((s) => {
    const [name, type = "nvarchar"] = s.split(":").map((x) => x.trim());
    const t = type.toLowerCase();
    if (!/^@?[A-Za-z_][\w$#@]*$/.test(name)) throw new SqlProblem(`"${name}" is not a valid output parameter name`, "config", null);
    if (!MSSQL_TYPES[t]) throw new SqlProblem(`Output parameter type "${type}" is not supported. Use one of: ${Object.keys(MSSQL_TYPES).join(", ")}`, "config", null);
    return { name: name.replace(/^@/, ""), type: t };
  });
}
const DECIMALS = new Set(["decimal", "numeric", "money", "smallmoney"]);
function decimalColumns(rs: unknown): Set<string> {
  const cols = (rs as { columns?: Record<string, { type?: { declaration?: string; name?: string } }> })?.columns ?? {};
  return new Set(Object.entries(cols).filter(([, c]) => DECIMALS.has(String(c?.type?.declaration ?? c?.type?.name ?? "").toLowerCase())).map(([k]) => k));
}

export async function runMssql(clients: SqlClients, conn: ResolvedConnection, r: SqlRun): Promise<SqlResult> {
  preflight(r);
  const outputs = r.mode === "procedure" ? r.outputs : [];
  let pool: mssql.ConnectionPool;
  try { pool = await clients.mssqlFor(conn); } catch (e) { throw explain("mssql", e, { secrets: r.secrets, database: r.database, ...whereOf(conn, 1433) }); }
  let tx: mssql.Transaction | undefined; let timedOut = false; let timer: NodeJS.Timeout | undefined;
  try {
    const d = clients.drivers.mssql;
    if (r.readOnly) { tx = new d.Transaction(pool); await tx.begin(); }
    const req = tx ? new d.Request(tx) : pool.request();
    if (r.mode === "procedure") {
      for (const i of r.inputs) req.input(i.key.replace(/^@/, ""), paramValue(i.value) as never);
      for (const o of outputs) req.output(o.name, MSSQL_TYPES[o.type]() as never);
    } else r.params.forEach((p, i) => req.input(`p${i + 1}`, paramValue(p) as never));
    timer = setTimeout(() => { timedOut = true; req.cancel(); }, r.timeoutMs);
    const res = r.mode === "procedure" ? await req.execute(checkProcedureName(r.procedure, "mssql")) : await req.query(r.sql);
    // read-only: whatever ran is undone (procedures can change data even when the text cannot be checked)
    if (tx) { await tx.rollback(); tx = undefined; }
    const sets = (res.recordsets as unknown as unknown[][]) ?? [];
    const last = sets.length ? sets[sets.length - 1] : [];
    const { rows, truncated } = cut(plainRows(last, decimalColumns(last)), r.maxRows);
    const affected = (res.rowsAffected ?? []).reduce((a, b) => a + b, 0);
    return { rows, rowCount: sets.length ? last.length : affected, truncated,
      ...(outputs.length ? { output: plainValue(res.output) as Record<string, unknown> } : {}),
      ...(r.mode === "procedure" ? { returnValue: (res as { returnValue?: unknown }).returnValue ?? null } : {}) };
  } catch (e) {
    if (tx) await tx.rollback().catch(() => undefined);
    throw explain("mssql", e, { secrets: r.secrets, timeoutSeconds: Math.round(r.timeoutMs / 1000), timedOut, database: r.database, ...whereOf(conn, 1433) });
  } finally { if (timer) clearTimeout(timer); }
}
