#!/usr/bin/env node
// Factory: "Target platforms" on the Workspaces screen — the Boomi and Workato accounts finished
// migrations are imported into. Tokens are write-only and never appear on the page.
//
//   node e2e/target-accounts.e2e.mjs [baseUrl] [--shots <dir>] [--width 390 --height 844]
//
// Read-only: the account calls go to stand-in answers laid over them, so nothing is stored and no
// platform is contacted. The last step checks the section at phone width (390 px) as well.
import { parseArgs, Session } from "./studio-lib.mjs";

const opts = parseArgs();
const s = new Session(opts);
const page = await s.start();
const TOKEN = "e2e-SECRET-token-7f3a9c";

try {
  const store = { boomi: { target: "boomi", configured: true, accountId: "****CD12", hasToken: true, user: "o***@acme.com", updated: new Date().toISOString(), updatedBy: "e2e" }, workato: { target: "workato", configured: false } };
  const sent = [];
  await s.context.route("**/api/factory/target-accounts", (r) => r.fulfill({ json: { accounts: [store.boomi, store.workato] } }));
  await s.context.route("**/api/factory/target-accounts/*", (r) => {
    const t = r.request().url().split("/").pop();
    const method = r.request().method();
    if (method === "PUT") {
      const body = r.request().postDataJSON();
      sent.push({ t, body });
      store[t] = t === "workato" ? { target: t, configured: true, apiBase: body.apiBase, updated: new Date().toISOString(), updatedBy: "e2e" } : { ...store[t], configured: true };
      return r.fulfill({ json: store[t] });
    }
    if (method === "DELETE") { store[t] = { target: t, configured: false }; return r.fulfill({ json: { ok: true } }); }
    return r.fulfill({ status: 404, json: { error: "not found" } });
  });
  await s.context.route("**/api/factory/target-accounts/*/test", (r) => {
    const t = r.request().url().split("/").slice(-2)[0];
    return r.fulfill({ json: t === "boomi" ? { ok: false, message: "Boomi refused the token: 401 Unauthorized. Check that the user's role has API Access." } : { ok: true, message: "Workato answered: the API client can import into folder 12345." } });
  });

  s.step("1. The section explains where each value is found");
  await s.goto("/workspaces#target-platforms");
  const section = page.locator('[data-testid="target-platforms"]');
  await section.waitFor();
  const text = await section.innerText();
  s.check(/Account Information/.test(text) && /Platform API Tokens/.test(text) && /API Access/.test(text), "Boomi: where the account id and the token are, and the role it needs");
  s.check(/API clients/.test(text) && /Recipe lifecycle management/.test(text), "Workato: where the API client is and what its role needs");
  s.check(/nothing is deployed or switched on/i.test(text), "it says importing does not deploy or switch anything on");
  const boomi = page.locator('[data-testid="target-boomi"]');
  s.check(/\*\*\*\*CD12/.test(await boomi.innerText()) && /set \(not shown\)/.test(await boomi.innerText()), "the saved Boomi account is shown masked, the token only as set");
  s.check((await page.locator('[data-testid="boomi-token"]').getAttribute("type")) === "password" && (await page.locator('[data-testid="boomi-token"]').inputValue()) === "", "the token field is empty and hidden");
  await s.shot("section");
  s.check((await s.overflow()) === 0, "nothing runs off the side of the page");

  s.step("2. Test the Boomi connection");
  await boomi.locator('[data-testid="target-boomi-testbtn"]').click();
  const msg = boomi.locator('[data-testid="target-boomi-test"]');
  await msg.waitFor();
  s.check(/401 Unauthorized/.test(await msg.innerText()), "the platform's answer is shown", await msg.innerText());

  s.step("3. Set up Workato");
  const workato = page.locator('[data-testid="target-workato"]');
  await workato.locator('[data-testid="target-workato-save"]').click();
  s.check(/Paste the API token/.test(await workato.locator('[data-testid="target-workato-problem"]').innerText()), "a missing token is named");
  await workato.locator('[data-testid="workato-center"]').selectOption("https://app.eu.workato.com");
  await workato.locator('[data-testid="workato-token"]').fill(TOKEN);
  await workato.locator('[data-testid="workato-folder"]').fill("12345");
  await workato.locator('[data-testid="target-workato-save"]').click();
  await workato.locator('[data-testid="target-workato-saved-note"]').waitFor();
  s.check(sent.length === 1 && sent[0].body.apiBase === "https://app.eu.workato.com" && sent[0].body.token === TOKEN && sent[0].body.parentFolderId === "12345", "the data center, token and folder are sent");
  await workato.getByText("Set up", { exact: true }).waitFor();
  s.check((await workato.locator('[data-testid="workato-token"]').inputValue()) === "", "the token field is cleared after saving");
  s.check(!(await page.content()).includes(TOKEN), "the token appears nowhere on the page");
  await workato.locator('[data-testid="target-workato-testbtn"]').click();
  await workato.locator('[data-testid="target-workato-test"]').waitFor();
  s.check(/can import/.test(await workato.locator('[data-testid="target-workato-test"]').innerText()), "the Workato test answer is shown");
  await s.shot("workato");
  s.check((await s.overflow()) === 0, "nothing runs off the side of the page");

  s.step("4. Remove the Boomi account");
  await boomi.locator('[data-testid="target-boomi-remove"]').click();
  await page.getByRole("dialog").getByRole("button", { name: "Remove" }).click();
  await boomi.getByText("Not set up", { exact: true }).waitFor();
  s.check((await boomi.locator('[data-testid="target-boomi-remove"]').count()) === 0, "the account is gone and can be set up again");

  s.step("5. Phone width (390 px)");
  if (opts.width > 400) await page.setViewportSize({ width: 390, height: 844 });
  await s.goto("/workspaces#target-platforms");
  await section.waitFor();
  await page.waitForTimeout(400);
  s.check((await s.overflow()) === 0, "the section fits a phone");
  await s.shot("phone");
} catch (e) {
  s.fail(`the check stopped: ${e?.message ?? e}`);
} finally {
  await s.finish();
}
