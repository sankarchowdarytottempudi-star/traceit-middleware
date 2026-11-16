import { describe, expect, it } from "vitest";
import { BUILTIN_NODE_TYPES, BUILTIN_CONNECTION_TYPES } from "@traceit/weave-flow";
import { HANDLERS } from "../src/engine/nodes.js";
import type { ResolvedConnection } from "../src/clients/data.js";
import {
  SqlClients, SqlProblem, explain, firstWord, hasMultipleStatements, isWriteStatement, mysqlCall, mysqlShape, parseOutputs, paramValue,
  plainRows, plainValue, runMssql, runMysql, stripLiterals, type SqlRun,
} from "../src/clients/sqldb.js";

const dns = { isClusterName: (h: string) => h.endsWith(".svc"), resolve: async () => "10.0.0.9" } as never;
const conn = (type: string, config: Record<string, unknown> = {}): ResolvedConnection =>
  ({ id: `c-${type}`, name: "test db", type, updatedAt: "t1", config: { host: "db.example.test", database: "app", user: "u", ...config }, secrets: { password: "s3cret-pass" } });
const run = (over: Partial<SqlRun>): SqlRun => ({ engine: "mysql", mode: "query", sql: "select 1", procedure: "", params: [], inputs: [], outputs: [], maxRows: 1000, timeoutMs: 5000, readOnly: false, allowMultiple: false, secrets: ["s3cret-pass"], database: "app", ...over });

// ---------------------------------------------------------------- fake drivers
function fakeMysql(reply: (sql: string, values: unknown[]) => unknown) {
  const calls: { sql: string; values: unknown[]; timeout?: number }[] = []; const pools: Record<string, unknown>[] = []; let released = 0;
  const driver = { createPool: (cfg: Record<string, unknown>) => { pools.push(cfg); return {
    end: async () => undefined, on: () => undefined,
    getConnection: async () => ({ release: () => { released++; }, query: async (q: string | { sql: string; values?: unknown[]; timeout?: number }) => {
      const o = typeof q === "string" ? { sql: q, values: [] } : q; calls.push({ sql: o.sql, values: o.values ?? [], timeout: (o as { timeout?: number }).timeout });
      const r = reply(o.sql, o.values ?? []); if (r instanceof Error) throw r; return [r, []]; } }),
  }; } };
  return { driver, calls, pools, released: () => released };
}
function fakeMssql(reply: (sql: string, inputs: Record<string, unknown>) => unknown) {
  const log: string[] = []; const inputs: Record<string, unknown> = {}; const outputs: string[] = [];
  class Req { private cancelled?: () => void;
    input(n: string, v: unknown) { inputs[n] = v; return this; } output(n: string) { outputs.push(n); return this; }
    cancel() { log.push("cancel"); this.cancelled?.(); }
    async query(sql: string) { log.push("query"); const r = reply(sql, inputs); if (r === "hang") return new Promise((_, rej) => { this.cancelled = () => rej(Object.assign(new Error("Canceled."), { code: "ECANCEL" })); }); if (r instanceof Error) throw r; return r; }
    async execute(name: string) { log.push(`execute ${name}`); const r = reply(name, inputs); if (r instanceof Error) throw r; return r; } }
  class Tx { constructor(_p: unknown) {} async begin() { log.push("begin"); } async rollback() { log.push("rollback"); } }
  class Pool { constructor(readonly cfg: Record<string, unknown>) { pools.push(cfg); } on() { return this; } async connect() { return this; } async close() {} request() { return new Req(); } }
  const pools: Record<string, unknown>[] = [];
  return { driver: { ConnectionPool: Pool, Request: Req, Transaction: Tx }, log, inputs, outputs, pools };
}
const clients = (my?: unknown, ms?: unknown) => new SqlClients(dns, { mysql: my ?? {}, mssql: ms ?? {} } as never);

describe("statement checks", () => {
  it("one statement only; semicolons inside strings, names and comments do not count", () => {
    expect(hasMultipleStatements("select 1;", "mysql")).toBe(false);
    expect(hasMultipleStatements("select 1; drop table t", "mysql")).toBe(true);
    expect(hasMultipleStatements("select ';' as a, `x;y` from t -- ; comment\n", "mysql")).toBe(false);
    expect(hasMultipleStatements("select 'it''s; fine' /* ; */ from [a;b]", "mssql")).toBe(false);
    expect(hasMultipleStatements("select 1\n# ;\n", "mysql")).toBe(false);
    expect(hasMultipleStatements("select 1; select 2;", "mssql")).toBe(true);
    expect(stripLiterals("select 'x'", "mysql")).toHaveLength("select 'x'".length);
    expect(hasMultipleStatements("create procedure p @x int as begin set @x = 1; select @x; end", "mssql")).toBe(false);
    expect(hasMultipleStatements("CREATE DEFINER=`a`@`%` PROCEDURE p() BEGIN select 1; select 2; END", "mysql")).toBe(false);
  });
  it("read-only spots statements that change data", () => {
    for (const s of ["insert into t values (1)", "  UPDATE t set a=1", "/* x */ delete from t", "drop table t", "with x as (select 1) delete from t", "select * into backup_t from t", "select * from t for update", "truncate table t", "merge t using s on 1=1 when matched then delete;"])
      expect(isWriteStatement(s, s.startsWith("merge") ? "mssql" : "mysql")).toBe(true);
    for (const s of ["select * from t", "(select 1)", "with x as (select 1) select * from x", "select 'insert into' as txt", "select @x into @y"])
      expect(isWriteStatement(s, "mysql")).toBe(false);
    expect(firstWord("-- c\n  (SELECT 1)", "mysql")).toBe("select");
  });
  it("procedure names are checked and quoted; values are never put in the text", () => {
    expect(mysqlCall("app.get_booking", 2)).toBe("CALL `app`.`get_booking`(?, ?)");
    expect(() => mysqlCall("x; drop table t", 0)).toThrow(SqlProblem);
    expect(() => mysqlCall("", 0)).toThrow(/name of the stored procedure/);
  });
  it("output parameters are name:type with a known type", () => {
    expect(parseOutputs(["total:int", "@status", " "])).toEqual([{ name: "total", type: "int" }, { name: "status", type: "nvarchar" }]);
    expect(() => parseOutputs(["x:blob"])).toThrow(/not supported/);
    expect(() => parseOutputs(["a b:int"])).toThrow(/not a valid/);
  });
});

describe("values", () => {
  it("dates as ISO, binary as base64, big integers as strings, decimals as text like Postgres", () => {
    expect(plainValue(new Date("2026-01-02T03:04:05Z"))).toBe("2026-01-02T03:04:05.000Z");
    expect(plainValue(Buffer.from("hi"))).toBe("aGk=");
    expect(plainValue(12345678901234567890n)).toBe("12345678901234567890");
    expect(plainValue({ a: [new Date(0)] })).toEqual({ a: ["1970-01-01T00:00:00.000Z"] });
    expect(plainRows([{ price: 12.5, name: "x", at: null }], new Set(["price"]))).toEqual([{ price: "12.5", name: "x", at: null }]);
    expect(paramValue({ a: 1 })).toBe('{"a":1}'); expect(paramValue(undefined)).toBeNull(); expect(paramValue(5)).toBe(5);
  });
  it("mysql2 results: rows, an OK header, a CALL with result sets", () => {
    expect(mysqlShape([{ a: 1 }, { a: 2 }])).toEqual({ rows: [{ a: 1 }, { a: 2 }], rowCount: 2 });
    expect(mysqlShape({ affectedRows: 3, insertId: 7, fieldCount: 0 })).toEqual({ rows: [], rowCount: 3, insertId: 7 });
    expect(mysqlShape([[{ a: 1 }], { affectedRows: 0, fieldCount: 0 }])).toEqual({ rows: [{ a: 1 }], rowCount: 1 });
  });
});

describe("errors in plain words, never a secret", () => {
  it("MySQL", () => {
    expect(explain("mysql", { code: "ER_ACCESS_DENIED_ERROR", errno: 1045, sqlMessage: "Access denied for user 'u' (using password: YES) s3cret-pass" }, { secrets: ["s3cret-pass"] }).kind).toBe("login");
    const nf = explain("mysql", { code: "ER_NO_SUCH_TABLE", errno: 1146, sqlMessage: "Table 'app.nope' doesn't exist" });
    expect(nf.kind).toBe("not-found"); expect(nf.message).toContain("app.nope"); expect(nf.message).toContain("1146");
    expect(explain("mysql", { code: "ER_DUP_ENTRY", errno: 1062, sqlMessage: "Duplicate entry '1' for key 'PRIMARY'" }).kind).toBe("constraint");
    expect(explain("mysql", { code: "ECONNREFUSED", message: "connect ECONNREFUSED" }).kind).toBe("connect");
    expect(explain("mysql", { code: "PROTOCOL_SEQUENCE_TIMEOUT" }, { timeoutSeconds: 3 }).message).toContain("within 3 seconds");
    const leak = explain("mysql", { errno: 9999, sqlMessage: "boom s3cret-pass boom" }, { secrets: ["s3cret-pass"] });
    expect(leak.message).not.toContain("s3cret-pass");
  });
  it("SQL Server", () => {
    expect(explain("mssql", { code: "ELOGIN", message: "Login failed for user 'u'." }).kind).toBe("login");
    expect(explain("mssql", { code: "EREQUEST", number: 208, message: "Invalid object name 'nope'." }).kind).toBe("not-found");
    expect(explain("mssql", { code: "EREQUEST", number: 2627, message: "Violation of PRIMARY KEY constraint" }).kind).toBe("constraint");
    expect(explain("mssql", { code: "ESOCKET", message: "Failed to connect" }).kind).toBe("connect");
    expect(explain("mssql", { code: "ECANCEL" }, { timeoutSeconds: 2 }).kind).toBe("timeout");
  });
});

describe("MySQL step with a fake driver", () => {
  it("values go to the driver separately; the pool has sane limits and no multiple statements", async () => {
    const f = fakeMysql(() => [{ id: 1, at: new Date("2026-01-01T00:00:00Z"), blob: Buffer.from("x") }]);
    const res = await runMysql(clients(f.driver), conn("mysql"), run({ sql: "select * from t where id = ? and n = ?", params: [5, { a: 1 }] }));
    expect(f.calls[0]).toEqual({ sql: "select * from t where id = ? and n = ?", values: [5, '{"a":1}'], timeout: 5000 });
    expect(res.rows).toEqual([{ id: 1, at: "2026-01-01T00:00:00.000Z", blob: "eA==" }]);
    expect(f.pools[0]).toMatchObject({ multipleStatements: false, connectionLimit: 5, bigNumberStrings: false, decimalNumbers: false, host: "db.example.test" });
    expect(f.released()).toBe(1);
  });
  it("a cluster name is resolved through the cluster DNS", async () => {
    const f = fakeMysql(() => []);
    await runMysql(clients(f.driver), conn("mysql", { host: "mysql.wso2.svc" }), run({}));
    expect(f.pools[0].host).toBe("10.0.0.9");
  });
  it("several statements are refused before anything is sent", async () => {
    const f = fakeMysql(() => []);
    await expect(runMysql(clients(f.driver), conn("mysql"), run({ sql: "select 1; drop table t" }))).rejects.toThrow(/more than one statement/);
    expect(f.calls).toHaveLength(0);
  });
  it("read-only: writes refused, reads inside a read-only transaction", async () => {
    const f = fakeMysql(() => [{ a: 1 }]);
    await expect(runMysql(clients(f.driver), conn("mysql", { readOnly: true }), run({ sql: "delete from t", readOnly: true }))).rejects.toThrow(/read-only/);
    await runMysql(clients(f.driver), conn("mysql", { readOnly: true }), run({ readOnly: true }));
    expect(f.calls.map((c) => c.sql)).toEqual(["START TRANSACTION READ ONLY", "select 1", "COMMIT"]);
  });
  it("row limit and stored procedures", async () => {
    const f = fakeMysql((sql) => (sql.startsWith("CALL") ? [[{ n: 1 }, { n: 2 }, { n: 3 }], { affectedRows: 0, fieldCount: 0 }] : []));
    const res = await runMysql(clients(f.driver), conn("mysql"), run({ mode: "procedure", procedure: "get_rows", params: ["a"], maxRows: 2 }));
    expect(f.calls[0].sql).toBe("CALL `get_rows`(?)"); expect(f.calls[0].values).toEqual(["a"]);
    expect(res).toMatchObject({ rows: [{ n: 1 }, { n: 2 }], rowCount: 3, truncated: true });
  });
  it("driver errors come back in plain words without the password", async () => {
    const f = fakeMysql(() => Object.assign(new Error("Access denied s3cret-pass"), { code: "ER_ACCESS_DENIED_ERROR", errno: 1045, sqlMessage: "Access denied s3cret-pass" }));
    const e = await runMysql(clients(f.driver), conn("mysql"), run({})).catch((x) => x);
    expect(e).toBeInstanceOf(SqlProblem); expect(e.kind).toBe("login"); expect(String(e.message)).not.toContain("s3cret-pass");
  });
});

describe("SQL Server step with a fake driver", () => {
  it("@p1… inputs, decimals as text, encryption on by default", async () => {
    const f = fakeMssql(() => ({ recordsets: [Object.assign([{ id: 1, price: 9.5 }], { columns: { price: { type: { declaration: "decimal" } } } })], rowsAffected: [1] }));
    const res = await runMssql(clients(undefined, f.driver), conn("mssql"), run({ engine: "mssql", sql: "select * from t where id = @p1", params: [42] }));
    expect(f.inputs).toEqual({ p1: 42 }); expect(res.rows).toEqual([{ id: 1, price: "9.5" }]);
    expect((f.pools[0].options as Record<string, unknown>)).toMatchObject({ encrypt: true, trustServerCertificate: false });
    expect(f.pools[0].password).toBe("s3cret-pass");
  });
  it("stored procedure with named inputs and outputs", async () => {
    const f = fakeMssql(() => ({ recordsets: [], rowsAffected: [2], output: { total: 7 }, returnValue: 0 }));
    const res = await runMssql(clients(undefined, f.driver), conn("mssql"), run({ engine: "mssql", mode: "procedure", procedure: "dbo.Book", inputs: [{ key: "@id", value: 3 }], outputs: [{ name: "total", type: "int" }] }));
    expect(f.log).toContain("execute dbo.Book"); expect(f.inputs).toEqual({ id: 3 }); expect(f.outputs).toEqual(["total"]);
    expect(res).toMatchObject({ rowCount: 2, output: { total: 7 }, returnValue: 0 });
  });
  it("read-only: everything runs in a transaction that is rolled back", async () => {
    const f = fakeMssql(() => ({ recordsets: [[{ a: 1 }]], rowsAffected: [1] }));
    await runMssql(clients(undefined, f.driver), conn("mssql", { readOnly: true }), run({ engine: "mssql", readOnly: true }));
    expect(f.log).toEqual(["begin", "query", "rollback"]);
  });
  it("a query running too long is cancelled and reported as a timeout", async () => {
    const f = fakeMssql(() => "hang");
    const e = await runMssql(clients(undefined, f.driver), conn("mssql"), run({ engine: "mssql", timeoutMs: 300 })).catch((x) => x);
    expect(f.log).toContain("cancel"); expect(e.kind).toBe("timeout");
  });
});

describe("catalog", () => {
  it("both steps and connection types exist, with handlers and search words", () => {
    for (const t of ["mysql.query", "mssql.query"]) { expect(BUILTIN_NODE_TYPES.find((d) => d.type === t)).toBeTruthy(); expect(HANDLERS[t]).toBeTypeOf("function"); }
    for (const t of ["mysql", "mssql"]) { const c = BUILTIN_CONNECTION_TYPES.find((d) => d.type === t)!; expect(c.fields.find((f) => f.key === "password")?.secret).toBe(true); }
    const search = (q: string) => BUILTIN_NODE_TYPES.filter((d) => `${d.label} ${d.description} ${d.type} ${(d.keywords ?? []).join(" ")}`.toLowerCase().includes(q)).map((d) => d.type);
    for (const q of ["sql", "database"]) expect(search(q)).toEqual(expect.arrayContaining(["postgres.query", "mysql.query", "mssql.query"]));
    expect(search("mysql")).toContain("mysql.query"); expect(search("mssql")).toContain("mssql.query"); expect(search("sql server")).toContain("mssql.query");
  });
});
