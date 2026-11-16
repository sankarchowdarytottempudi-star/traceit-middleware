// Database connectors for MySQL and SQL Server: the palette finds all three database steps by
// "sql", "mysql", "sql server", "mssql" and "database"; each step's settings show the SQL or the
// stored procedure with its parameters, a row limit and a timeout; the connection forms ask for
// what the database needs and "Test connection" shows the answer in plain words. The test call is
// answered by a stand-in laid over it, so no real database is contacted; no connection is saved.
// Creates one throw-away flow and deletes it.
import { parseArgs, Session, stamp, createFlow, addStep, selectNode, field, selectField, openGroup, deleteFlowFromEditor, sweep } from "./studio-lib.mjs";

const opts = parseArgs();
const prefix = "e2e";
const s = new Session(opts);
const page = await s.start();
const settle = (ms = 500) => page.waitForTimeout(ms);
// after a resize the settings panel may be a new element (a sheet on a phone): find it again, reopen it if closed
async function panelAfterResize(type) {
  await settle(400);
  const p = page.locator(".ws-panel");
  if (await p.first().isVisible().catch(() => false) && await p.locator('[data-field="operation"]').count()) return p;
  return selectNode(page, type);
}
let flowId;
try {
  const asked = page.viewportSize();
  const phone = asked && asked.width < 700;
  if (phone) await page.setViewportSize({ width: 1440, height: 900 });

  s.step("1. The palette finds every database step");
  flowId = await createFlow(s, `${prefix}-sql-${stamp()}`);
  const search = page.getByLabel("Search steps");
  const visible = async (type) => page.locator(`.ws-palette-item[data-node-type="${type}"]`).first().isVisible().catch(() => false);
  for (const q of ["sql", "database"]) {
    await search.fill(q); await settle(250);
    s.check((await visible("postgres.query")) && (await visible("mysql.query")) && (await visible("mssql.query")), `"${q}" shows Postgres, MySQL and SQL Server`);
  }
  for (const [q, type] of [["mysql", "mysql.query"], ["sql server", "mssql.query"], ["mssql", "mssql.query"]]) {
    await search.fill(q); await settle(250);
    s.check(await visible(type), `"${q}" shows ${type === "mysql.query" ? "Database (MySQL)" : "Database (SQL Server)"}`);
  }
  await search.fill("mysql"); await settle(250);
  s.check((await page.locator('.ws-palette-item[data-node-type="mysql.query"]').first().getAttribute("title"))?.includes("stored procedure"), "the description says what it does in plain words");
  await s.shot("palette");
  await search.fill("");

  s.step("2. The MySQL step: SQL with ? parameters, or a stored procedure; row limit and timeout");
  let panel = await addStep(page, "mysql.query");
  if (phone) { await page.setViewportSize(asked); panel = await panelAfterResize("mysql.query"); }
  for (const k of ["connection", "operation", "sql", "params", "resultMode"]) s.check(await field(panel, k).count() > 0, `shows "${k}"`);
  s.check((await field(panel, "sql").innerText().catch(() => "")) !== null && (await panel.innerText()).includes("?"), "the SQL hint uses ? placeholders");
  await openGroup(panel, "Advanced");
  for (const k of ["maxRows", "timeoutSeconds", "allowMultiple"]) s.check(await field(panel, k).count() > 0, `Advanced shows "${k}"`);
  s.step("2b. A MySQL connection is created right from the step (stand-in answers; nothing saved for real)");
  const made = { id: "cx_e2e_mysql", name: `${prefix}-mysql-here-${stamp()}`, type: "mysql", config: { host: "db.example.invalid", port: 3306, database: "app", user: "reader" }, secretsSet: ["password"], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  let created = null, tested = null;
  await page.route("**/api/studio/connections/test", (r) => { tested = r.request().postDataJSON(); return r.fulfill({ json: { ok: true, ms: 9, detail: "Connected to MySQL 8.4.13, database \"app\"" } }); });
  await page.route("**/api/studio/connections", async (r) => {
    if (r.request().method() === "POST") { created = r.request().postDataJSON(); return r.fulfill({ status: 201, json: made }); }
    const real = await r.fetch(); const body = await real.json().catch(() => ({ connections: [] }));
    return r.fulfill({ json: { ...body, connections: [...(body.connections ?? []).filter((c) => c.id !== made.id), ...(created ? [made] : [])] } });
  });
  const picker = field(panel, "connection").locator("select");
  const newItem = await picker.locator("option").filter({ hasText: "+ New MySQL connection" }).count();
  s.check(newItem === 1, 'the Connection dropdown offers "+ New MySQL connection…"');
  await picker.selectOption({ label: "+ New MySQL connection…" });
  const dlg = page.locator('[data-testid="connection-form"]');
  await dlg.waitFor();
  s.check(await page.locator("#ws-conn-type").isDisabled() && (await page.locator("#ws-conn-type").inputValue()) === "mysql", "the dialog is for a MySQL connection (kind fixed)");
  s.check((await field(dlg, "port").locator("input").inputValue()) === "3306", "the port defaults to 3306");
  s.check((await page.locator("#ws-conn-name").getAttribute("placeholder"))?.startsWith("e.g. "), "the name field shows an example, not a value");
  s.check((await field(dlg, "host").innerText()).includes("localhost means the server itself"), "the host field explains that localhost is the Weave server");
  await page.locator("#ws-conn-name").fill(made.name);
  await field(dlg, "host").locator("input").fill("db.example.invalid");
  await field(dlg, "database").locator("input").fill("app");
  await field(dlg, "user").locator("input").fill("reader");
  await field(dlg, "password").locator("input").first().fill("not-a-real-password-8");
  await openGroup(dlg, "Advanced");
  s.check(await field(dlg, "connectTimeoutSeconds").count() > 0 && await field(dlg, "poolMax").count() > 0, "connection timeout and pool size can be set");
  await page.locator('[data-action="test-connection"]').click();
  await dlg.getByText("Connected to MySQL", { exact: false }).waitFor({ timeout: 10_000 });
  s.check(tested?.type === "mysql", '"Test connection" checks the draft and answers in plain words');
  s.check((await s.overflow()) === 0, "the dialog fits the page");
  await s.shot("new-connection-from-step");
  await page.locator('[data-action="save-connection"]').click();
  await dlg.waitFor({ state: "detached", timeout: 10_000 });
  s.check(created?.type === "mysql" && created?.secrets?.password === "not-a-real-password-8" && created?.config?.host === "db.example.invalid", "the connection is created on this server with its password sent once");
  await page.waitForFunction((id) => [...document.querySelectorAll('.ws-panel [data-field="connection"] select')].some((x) => x.value === id), made.id, { timeout: 10_000 }).catch(() => {});
  s.check((await picker.inputValue()) === made.id, "the new connection is chosen in the step");
  s.check(!(await panel.innerText()).includes("not-a-real-password-8"), "the password is never shown");
  await panel.locator('[data-action="edit-connection-here"]').click();
  await dlg.waitFor();
  const pwEdit = field(dlg, "password").locator("input").first();
  s.check((await pwEdit.inputValue()) === "" && (await pwEdit.getAttribute("data-secret")) === "set" && /Stored/.test(await pwEdit.getAttribute("placeholder") ?? ""), "editing shows the password as stored, never its value");
  await page.getByRole("dialog").last().getByRole("button", { name: "Cancel", exact: true }).click();
  await page.unroute("**/api/studio/connections");
  await page.unroute("**/api/studio/connections/test");

  await selectField(panel, "operation", "procedure"); await settle(300);
  s.check(await field(panel, "procedure").count() > 0 && (await field(panel, "sql").count()) === 0, "a stored procedure asks for its name instead of SQL");
  await s.shot("mysql-step");
  if (phone) { await page.setViewportSize({ width: 1440, height: 900 }); await settle(300); }

  s.step("3. The SQL Server step: @p1 parameters, or a procedure with named inputs and outputs");
  // checked at desktop size (on a phone the open settings sheet hides the canvas, so a step cannot be reselected)
  panel = await addStep(page, "mssql.query");
  s.check((await panel.innerText()).includes("@p1"), "the SQL hint uses @p1 placeholders");
  await selectField(panel, "operation", "procedure"); await settle(300);
  s.check(await field(panel, "procInputs").count() > 0 && await field(panel, "procOutputs").count() > 0, "a procedure has named inputs and output parameters");
  if (phone) { await page.setViewportSize(asked); await settle(400); }
  s.check((await s.overflow()) === 0, "nothing runs off the side of the page");
  await s.shot("mssql-step");

  s.step("3b. Postgres has the same: \"+ New PostgreSQL connection…\" in its step");
  if (phone) { await page.setViewportSize({ width: 1440, height: 900 }); await settle(300); }
  panel = await addStep(page, "postgres.query");
  s.check(await field(panel, "connection").locator("select option").filter({ hasText: "+ New PostgreSQL connection" }).count() === 1, 'the Postgres step offers "+ New PostgreSQL connection…"');
  if (phone) { await page.setViewportSize(asked); await settle(300); }

  s.step("4. Connection forms and \"Test connection\" in plain words (stand-in answer, nothing saved)");
  let sent = null;
  await page.route("**/api/studio/connections/test", async (r) => {
    sent = r.request().postDataJSON();
    const kind = sent?.type;
    await r.fulfill({ json: { ok: false, ms: 12, detail: `Login failed: the user name or password is wrong, or this user may not use the database (${kind === "mssql" ? "SQL Server error ELOGIN" : "MySQL error 1045 ER_ACCESS_DENIED_ERROR"})` } });
  });
  for (const [type, port, label] of [["mysql", "3306", "MySQL"], ["mssql", "1433", "SQL Server"]]) {
    await s.goto("/studio/connections");
    await page.locator('[data-action="new-connection"]').first().click();
    const form = page.locator('[data-testid="connection-form"]');
    await form.waitFor();
    await page.locator("#ws-conn-name").fill(`${prefix}-${type}-${stamp()}`);
    await page.locator("#ws-conn-type").selectOption(type);
    await settle(300);
    s.check((await field(form, "port").locator("input").inputValue()) === port, `${label}: the port defaults to ${port}`);
    await field(form, "host").locator("input").fill("db.example.invalid");
    await field(form, "database").locator("input").fill("app");
    await field(form, "user").locator("input").fill("reader");
    const pw = field(form, "password").locator("input").first();
    await pw.fill("not-a-real-password-7");
    s.check((await pw.getAttribute("type")) === "password", `${label}: the password is typed hidden`);
    s.check(await field(form, "readOnly").count() > 0, `${label}: there is a read-only switch`);
    if (type === "mssql") s.check(await field(form, "encrypt").locator("input[type=checkbox]").isChecked(), "SQL Server: encryption is on by default");
    else s.check(await field(form, "tls").count() > 0, "MySQL: TLS can be switched on");
    await page.locator('[data-action="test-connection"]').click();
    await form.getByText("Login failed", { exact: false }).waitFor({ timeout: 10_000 });
    s.check(sent?.type === type && sent?.secrets?.password === "not-a-real-password-7", `${label}: the test sends the draft (to this server only)`);
    s.check(!(await form.innerText()).includes("not-a-real-password-7"), `${label}: the answer never shows the password`);
    s.check((await s.overflow()) === 0, `${label}: nothing runs off the side of the page`);
    await s.shot(`${type}-connection`);
    await page.getByRole("dialog").last().getByRole("button", { name: "Cancel", exact: true }).click();
  }
  await page.unroute("**/api/studio/connections/test");
  if (phone) await page.setViewportSize({ width: 1440, height: 900 });
  await s.goto(`/studio/flows/${flowId}`);
  await page.locator('[data-testid="flow-editor"]').waitFor();
  await deleteFlowFromEditor(s, flowId); flowId = undefined;
} catch (e) {
  s.fail(`the check stopped: ${e?.message ?? e}`);
} finally {
  try { await sweep(s, `${prefix}-sql-`); } catch { /* best effort */ }
  await s.finish();
}
