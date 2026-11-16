// Runs only against THROWAWAY database containers: set SQL_IT_FILE to a JSON file
// { "mysql": {host, port, user, password, database}, "mssql": {...} }. Skipped otherwise.
import fs from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import type { ResolvedConnection } from "../src/clients/data.js";
import { SqlClients, explain, runMssql, runMysql, type SqlRun } from "../src/clients/sqldb.js";

const cfg = process.env.SQL_IT_FILE ? JSON.parse(fs.readFileSync(process.env.SQL_IT_FILE, "utf8")) : null;
const dns = { isClusterName: () => false, resolve: async (h: string) => h } as never;
const clients = new SqlClients(dns);
afterAll(() => clients.closeAll());
const conn = (type: string, c: Record<string, unknown>, extra: Record<string, unknown> = {}): ResolvedConnection =>
  ({ id: `it-${type}-${JSON.stringify(extra)}`, name: "throwaway", type, updatedAt: "1", config: { host: c.host, port: c.port, user: c.user, database: c.database, encrypt: true, trustServerCertificate: true, ...extra }, secrets: { password: String(c.password) } });
const run = (engine: "mysql" | "mssql", over: Partial<SqlRun>): SqlRun => ({ engine, mode: "query", sql: "", procedure: "", params: [], inputs: [], outputs: [], maxRows: 1000, timeoutMs: 10_000, readOnly: false, allowMultiple: false, secrets: [], ...over });

describe.skipIf(!cfg?.mysql)("MySQL 8.4 (throwaway container)", () => {
  const c = () => conn("mysql", cfg.mysql);
  it("create, insert with bound values, select types, constraint, timeout, read-only, procedure", async () => {
    await runMysql(clients, c(), run("mysql", { sql: "create table if not exists it_t (id int primary key, name varchar(50), price decimal(10,2), at datetime, b varbinary(10), big bigint)" }));
    await runMysql(clients, c(), run("mysql", { sql: "delete from it_t" }));
    const ins = await runMysql(clients, c(), run("mysql", { sql: "insert into it_t values (?, ?, ?, ?, ?, ?)", params: [1, "O'Brien; drop table it_t", "12.50", "2026-01-02 03:04:05", Buffer.from("hi"), "9007199254740993"] }));
    expect(ins.rowCount).toBe(1);
    const sel = await runMysql(clients, c(), run("mysql", { sql: "select * from it_t where name = ?", params: ["O'Brien; drop table it_t"] }));
    expect(sel.rows[0]).toEqual({ id: 1, name: "O'Brien; drop table it_t", price: "12.50", at: "2026-01-02T03:04:05.000Z", b: "aGk=", big: "9007199254740993" });
    const dup = await runMysql(clients, c(), run("mysql", { sql: "insert into it_t (id) values (?)", params: [1] })).catch((e) => e);
    expect(dup.kind).toBe("constraint");
    const nf = await runMysql(clients, c(), run("mysql", { sql: "select * from no_such_table" })).catch((e) => e);
    expect(nf.kind).toBe("not-found");
    const slow = await runMysql(clients, c(), run("mysql", { sql: "select sleep(5)", timeoutMs: 1000 })).catch((e) => e);
    expect(slow.kind).toBe("timeout");
    const ro = conn("mysql", cfg.mysql, { readOnly: true });
    expect((await runMysql(clients, ro, run("mysql", { sql: "select count(*) as n from it_t", readOnly: true }))).rows[0]).toEqual({ n: 1 });
    expect((await runMysql(clients, ro, run("mysql", { sql: "update it_t set name='x'", readOnly: true })).catch((e) => e)).kind).toBe("read-only");
    await runMysql(clients, c(), run("mysql", { sql: "drop procedure if exists it_p" }));
    await runMysql(clients, c(), run("mysql", { sql: "create procedure it_p(in x int) select x * 2 as doubled" }));
    expect((await runMysql(clients, c(), run("mysql", { mode: "procedure", procedure: "it_p", params: [21] }))).rows).toEqual([{ doubled: 42 }]);
    const bad = explain("mysql", await clients.openMysql(conn("mysql", { ...cfg.mysql, password: "wrong" }), 1).then((p) => p.query("select 1")).catch((e) => e));
    expect(bad.kind).toBe("login");
    await runMysql(clients, c(), run("mysql", { sql: "drop table it_t" }));
  }, 60_000);
});

describe.skipIf(!cfg?.mssql)("SQL Server 2022 (throwaway container)", () => {
  const c = () => conn("mssql", cfg.mssql);
  it("create, insert with bound values, select types, constraint, timeout, read-only rollback, procedure with output", async () => {
    await runMssql(clients, c(), run("mssql", { sql: "if object_id('it_t') is not null drop table it_t" }));
    await runMssql(clients, c(), run("mssql", { sql: "create table it_t (id int primary key, name nvarchar(50), price decimal(10,2), at datetime2, b varbinary(10), big bigint)" }));
    await runMssql(clients, c(), run("mssql", { sql: "insert into it_t values (@p1, @p2, @p3, @p4, @p5, @p6)", params: [1, "O'Brien; drop table it_t", 12.5, new Date("2026-01-02T03:04:05Z"), Buffer.from("hi"), "9007199254740993"] }));
    const sel = await runMssql(clients, c(), run("mssql", { sql: "select * from it_t where name = @p1", params: ["O'Brien; drop table it_t"] }));
    expect(sel.rows[0]).toEqual({ id: 1, name: "O'Brien; drop table it_t", price: "12.5", at: "2026-01-02T03:04:05.000Z", b: "aGk=", big: "9007199254740993" });
    expect((await runMssql(clients, c(), run("mssql", { sql: "insert into it_t (id) values (@p1)", params: [1] })).catch((e) => e)).kind).toBe("constraint");
    expect((await runMssql(clients, c(), run("mssql", { sql: "select * from no_such_table" })).catch((e) => e)).kind).toBe("not-found");
    expect((await runMssql(clients, c(), run("mssql", { sql: "waitfor delay '00:00:05'", timeoutMs: 1000 })).catch((e) => e)).kind).toBe("timeout");
    await runMssql(clients, c(), run("mssql", { sql: "if object_id('it_p') is not null drop procedure it_p" }));
    await runMssql(clients, c(), run("mssql", { sql: "create procedure it_p @x int, @total int output as begin set @total = @x * 2; update it_t set name = 'changed'; select @x as x; end" }));
    const ro = conn("mssql", cfg.mssql, { readOnly: true });
    const p = await runMssql(clients, ro, run("mssql", { mode: "procedure", procedure: "it_p", inputs: [{ key: "x", value: 21 }], outputs: [{ name: "total", type: "int" }], readOnly: true }));
    expect(p).toMatchObject({ rows: [{ x: 21 }], output: { total: 42 }, returnValue: 0 });
    // read-only: the update inside the procedure was rolled back
    expect((await runMssql(clients, c(), run("mssql", { sql: "select name from it_t" }))).rows[0].name).toBe("O'Brien; drop table it_t");
    expect((await runMssql(clients, ro, run("mssql", { sql: "delete from it_t", readOnly: true })).catch((e) => e)).kind).toBe("read-only");
    const bad = explain("mssql", await clients.openMssql(conn("mssql", { ...cfg.mssql, password: "wrong" }), 1).catch((e) => e));
    expect(bad.kind).toBe("login");
    await runMssql(clients, c(), run("mssql", { sql: "drop procedure it_p; drop table it_t", allowMultiple: true }));
  }, 90_000);
});
