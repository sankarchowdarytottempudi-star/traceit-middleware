#!/usr/bin/env node
// Factory: "Finish this migration". A migration whose service still has open items shows each
// one with what the old application did there, and lets a person decide it.
//
//   node e2e/migration-finish.e2e.mjs [baseUrl] [--id <migrationId>] [--shots <dir>] [--width 390 --height 844]
//
// Read-only: the decision is saved against a stand-in answer laid over the save call, so nothing
// in any service changes. What is open is read from the real migration.
import { parseArgs, Session } from "./studio-lib.mjs";

const opts = parseArgs(["--id"]);
const i = opts.rest.indexOf("--id");
let id = i >= 0 ? opts.rest[i + 1] : "";
const s = new Session(opts);
const page = await s.start();
const api = `${opts.base}/api/factory/migrations`;
const get = async (u) => (await s.context.request.get(u)).json();

try {
  let open = null;
  if (id) open = await get(`${api}/${id}/open-items`);
  else {
    const all = (await get(api))?.migrations ?? [];
    for (const m of all) {
      if (!m?.serviceDir || m.busy) continue;
      const o = await get(`${api}/${m.id}/open-items`).catch(() => null);
      if (o?.exists && (o.items ?? []).length) { id = m.id; open = o; break; }
    }
  }
  if (!id || !open?.exists || !(open.items ?? []).length) { s.warn("there is no migration with open items to look at"); }
  else {
    const items = open.items;
    const panel = page.locator('[data-testid="finish"]');
    const card = (it) => panel.locator(`[data-testid="finish-item"][data-item=${JSON.stringify(it.id)}]`);
    const LABEL = { forward: "Pass it on to an API", address: "Set the address", not_needed: "Not needed", note: "Say what it does" };

    // ------------------------------------------------------------ 1. what is open
    s.step(`1. What is left of ${open.api} (${items.length} open)`);
    await s.goto(`/migrations/${id}`);
    await panel.waitFor();
    s.check((await panel.locator('[data-testid="finish-item"]').count()) === items.length, "every open item has its own card", `${await panel.locator('[data-testid="finish-item"]').count()} shown, ${items.length} open`);
    s.check(/does not make up what an operation should do/.test(await panel.innerText()), "it says why these items wait for a person");
    let buttonsOk = true, wordsOk = true;
    for (const it of items) {
      const c = card(it);
      for (const a of Object.keys(LABEL)) if (((await c.getByRole("button", { name: LABEL[a], exact: true }).count()) === 1) !== (it.can ?? []).includes(a)) buttonsOk = false;
      const text = await c.innerText();
      if (!text.includes(it.title)) wordsOk = false;
      if (it.source?.does?.length && !text.includes(String(it.source.does[0]).slice(0, 30))) wordsOk = false;
    }
    s.check(buttonsOk, "each item offers exactly what can be done with it");
    s.check(wordsOk, "each item names itself and says what the old application did there");
    const page1 = await page.locator("body").innerText();
    s.check(!/https?:\/\/(?!weave\.)[a-z0-9.-]+\.[a-z]{2,}/i.test(await panel.innerText()), "no backend address is shown");
    s.check(page1.includes("Finish this migration"), "the section is on the Progress tab");
    s.check((await s.overflow()) === 0, "nothing runs off the side of the page");
    await s.shot("finish-open");

    // ------------------------------------------------------------ 2. the forms check what is typed
    s.step("2. The forms say what is wrong before anything is saved");
    const op = items.find((x) => (x.can ?? []).includes("forward"));
    const be = items.find((x) => (x.can ?? []).includes("address"));
    const any = items.find((x) => (x.can ?? []).includes("not_needed"));
    if (op) {
      const c = card(op);
      await c.getByRole("button", { name: LABEL.forward, exact: true }).click();
      const form = c.locator('[data-testid="finish-form"]');
      await form.waitFor();
      const choices = await form.locator("select").first().locator("option").allInnerTexts();
      s.check(choices.length === (open.backends ?? []).length && choices.every((x) => open.backends.includes(x)), "the APIs offered are the backends this service knows", `${choices.length} offered`);
      const path = form.locator("input");
      await path.fill("no-slash");
      s.check(/starts with \//.test(await form.innerText()) && await c.getByRole("button", { name: "Save this decision" }).isDisabled(), "a path without / is refused");
      await path.fill("/x/{notThere}");
      s.check(/in its address/.test(await form.innerText()) && await c.getByRole("button", { name: "Save this decision" }).isDisabled(), "a value the operation does not have is refused");
      await path.fill("/x");
      s.check(await c.getByRole("button", { name: "Save this decision" }).isEnabled(), "a plain path can be saved");
      await s.shot("finish-forward");
      await c.getByRole("button", { name: "Cancel" }).click();
    }
    if (be) {
      const c = card(be);
      await c.getByRole("button", { name: LABEL.address, exact: true }).click();
      const form = c.locator('[data-testid="finish-form"]');
      s.check(/not shown again/.test(await form.innerText()), "it says the address is not shown again");
      await form.locator("input").fill("catalogue.internal");
      s.check(/http:\/\/ or https:\/\//.test(await form.innerText()) && await c.getByRole("button", { name: "Save this decision" }).isDisabled(), "an address without http is refused");
      await s.shot("finish-address");
      await c.getByRole("button", { name: "Cancel" }).click();
    }
    if (any) {
      const c = card(any);
      await c.getByRole("button", { name: LABEL.not_needed, exact: true }).click();
      s.check(await c.getByRole("button", { name: "Save this decision" }).isDisabled(), "\"Not needed\" asks for a reason first");
      await c.getByRole("button", { name: "Cancel" }).click();
    }

    // ------------------------------------------------------------ 3. a decision, saved against a stand-in
    s.step("3. Saving a decision (stand-in answer; no service is changed)");
    const first = op ?? be ?? any ?? items[0];
    const action = op ? "forward" : be ? "address" : any ? "not_needed" : "note";
    const after = { ...open, items: action === "note" ? items : items.filter((x) => x.id !== first.id), needsBuild: action !== "note",
      closed: action === "note" ? open.closed ?? [] : [...(open.closed ?? []), { id: first.id, kind: first.kind, title: first.title, how: "decided in this check", t: new Date().toISOString() }],
      pending: action === "note" ? open.pending ?? [] : [...(open.pending ?? []), "decided in this check"] };
    let sent = null;
    await page.route(`**/api/factory/migrations/${id}/resolve`, (r) => { sent = r.request().postDataJSON(); return r.fulfill({ json: { ok: true, changed: action !== "note", message: "Saved for this check.", openItems: after } }); });
    const c = card(first);
    await c.getByRole("button", { name: LABEL[action], exact: true }).click();
    const form = c.locator('[data-testid="finish-form"]');
    if (action === "forward") await form.locator("input").fill("/checked/path");
    else if (action === "address") await form.locator("input").fill("https://backend.example.internal/api");
    else await form.locator("textarea").fill("Checked by the acceptance run.");
    await c.getByRole("button", { name: action === "note" ? "Save the note" : "Save this decision" }).click();
    await panel.getByText("Saved for this check.").waitFor();
    s.check(sent?.id === first.id && sent?.action === action, "the decision sent is the one that was made", JSON.stringify({ id: sent?.id, action: sent?.action }));
    s.check(Object.keys(sent ?? {}).every((k) => ["id", "action", "backend", "method", "path", "reason", "url", "note"].includes(k)), "nothing else is sent with it");
    if (action !== "note") {
      s.check((await panel.locator('[data-testid="finish-item"]').count()) === items.length - 1, "the decided item leaves the list");
      s.check(/Build and check it, then deploy/.test(await panel.innerText()), "it says the service has to be built and deployed for the decision to count");
      s.check(/Decisions made \(\d+\)/.test(await panel.locator('[data-testid="finish-closed"]').innerText()), "the decision is listed under \"Decisions made\"");
      await panel.getByRole("button", { name: "Build and check" }).click();
      const dlg = page.getByRole("dialog").last();
      s.check(await dlg.isVisible().catch(() => false), "\"Build and check\" asks first (nothing is started by this check)");
      await page.keyboard.press("Escape");
      s.check(action !== "address" || !(await panel.innerText()).includes("backend.example.internal"), "the address typed is not shown after saving");
    }
    s.check((await s.overflow()) === 0, "nothing runs off the side of the page");
    await s.shot("finish-decided");
    await page.unroute(`**/api/factory/migrations/${id}/resolve`);

    // ------------------------------------------------------------ 4. a decision the tool refuses
    const left = after.items.find((x) => (x.can ?? []).includes("note"));
    if (left) {
      s.step("4. A decision the tool refuses");
      await page.route(`**/api/factory/migrations/${id}/resolve`, (r) => r.fulfill({ status: 409, json: { error: "A step of this migration is running. Try again when it has finished." } }));
      const c2 = card(left);
      await c2.getByRole("button", { name: LABEL.note, exact: true }).click();
      await c2.locator("textarea").fill("Checked by the acceptance run.");
      await c2.getByRole("button", { name: "Save the note" }).click();
      await c2.getByText(/A step of this migration is running/).waitFor();
      s.check(await c2.locator("textarea").inputValue() === "Checked by the acceptance run.", "the reason is shown on the item and what was typed is kept");
      await page.unroute(`**/api/factory/migrations/${id}/resolve`);
      // the browser reports the refused call in its console; that one is the point of this step
      s.consoleErrors = s.consoleErrors.filter((e) => !(/409 \(Conflict\)/.test(e) && e.includes(`/migrations/${id}/resolve`)));
    }

    // ------------------------------------------------------------ 5. taking a decision back; what a note does
    s.step("5. A \"not needed\" decision can be taken back, and a note does not finish an item (stand-in answers)");
    const now = new Date().toISOString();
    const noted = items.find((x) => (x.can ?? []).includes("note")) ?? items[0];
    const emptied = { ...open, ready: false, items: [], needsBuild: true, pending: ["ANY /db is removed from the new service"],
      summary: "every operation of this service was marked as not needed, so there is nothing to deploy. Take a decision back under \"Decisions made\", or remove the migration",
      closed: [{ id: "op:GET /kept", kind: "operation", title: "GET /kept", how: "passed on to catalogue", t: now, canReopen: false },
        { id: "op:ANY /db", kind: "operation", title: "ANY /db", how: "not needed", detail: "do it later", t: now, canReopen: true }] };
    const again = { ...open, items: items.map((x) => (x.id === noted.id ? { ...x, notes: [{ text: "Update the database with the outcome of the call", t: now }] } : x)) };
    await page.route(`**/api/factory/migrations/${id}/open-items`, (r) => r.fulfill({ json: emptied }));
    await s.goto(`/migrations/${id}`);
    await panel.waitFor();
    const lead = await panel.innerText();
    s.check(/nothing to deploy/.test(await panel.locator('[data-testid="finish-not-ready"]').innerText()), "with nothing open and nothing to deploy, it says why the service is not finished");
    s.check(!/Every item of this service has been decided/.test(lead), "it does not call the service decided");
    const made = panel.locator('[data-testid="finish-closed"]');
    s.check(await made.evaluate((el) => el.open), "\"Decisions made\" is already open");
    s.check((await made.getByRole("button", { name: "Take it back" }).count()) === 1, "only the \"not needed\" decision can be taken back");
    await s.shot("finish-emptied");
    let undo = null;
    await page.unroute(`**/api/factory/migrations/${id}/open-items`);
    await page.route(`**/api/factory/migrations/${id}/open-items`, (r) => r.fulfill({ json: again }));
    await page.route(`**/api/factory/migrations/${id}/resolve`, (r) => { undo = r.request().postDataJSON(); return r.fulfill({ json: { ok: true, changed: true, message: "ANY /db is open again: the \"not needed\" decision was taken back.", openItems: again } }); });
    await made.getByRole("button", { name: "Take it back" }).click();
    await panel.getByText(/is open again/).waitFor();
    s.check(JSON.stringify(undo) === JSON.stringify({ id: "op:ANY /db", action: "reopen" }), "taking it back sends the item and nothing else", JSON.stringify(undo));
    s.check((await panel.locator('[data-testid="finish-item"]').count()) === items.length, "the items are on the list again");
    const nc = card(noted);
    s.check(/A note does not finish this part/.test(await nc.locator('[data-testid="finish-note-limit"]').innerText()), "under its notes, an item says that a note does not finish it");
    if ((noted.can ?? []).includes("note")) {
      await nc.getByRole("button", { name: LABEL.note, exact: true }).click();
      s.check(/does not finish this item/.test(await nc.locator('[data-testid="finish-form"]').innerText()), "the note form says so before the note is saved");
      await nc.getByRole("button", { name: "Cancel" }).click();
    }
    s.check((await s.overflow()) === 0, "nothing runs off the side of the page");
    await s.shot("finish-taken-back");
    await page.unroute(`**/api/factory/migrations/${id}/resolve`);
    await page.unroute(`**/api/factory/migrations/${id}/open-items`);
  }
} catch (e) {
  s.fail(`the check stopped: ${e?.message ?? e}`);
} finally {
  await s.finish();
}
