#!/usr/bin/env node
// Factory: migrations started from a git repository instead of an upload.
//
//   node e2e/migration-git.e2e.mjs [baseUrl] [--shots <dir>] [--width 390 --height 844]
//
// The server's own answer is read once (to see that the route reaches the migration tool). Everything
// after that runs against a stand-in for the repository answers, so no repository is connected, no
// token is stored and no migration is created on the server by this check.
import { parseArgs, Session } from "./studio-lib.mjs";

const opts = parseArgs();
const s = new Session(opts);
const page = await s.start();
const TOKEN = "e2e-token-not-real-7731";
const ADDRESS = "https://git.example.test/team/apis.git";

// ---- the stand-in
const sent = { connect: [], refresh: [], imports: [], removed: [] };
let repos = [];
let readsLeft = 0;
const projects = (migId) => [
  { path: "apis/orders-api", name: "orders-api", technology: "mule4", flows: 7, files: 41, bytes: 180000, settings: ["dev", "uat", "prod", "common"], encrypted: false, migrations: [] },
  { path: "apis/stock-api", name: "stock-api", technology: "mule4", flows: 3, files: 22, bytes: 90000, settings: ["dev", "uat"], encrypted: true, migrations: [] },
  { path: "apis/customer-api", name: "customer-api", technology: "mule4", flows: 12, files: 60, bytes: 310000, settings: ["dev", "uat", "prod"], encrypted: false, migrations: [{ id: migId || "e2e-none", name: "customer-api", outcome: "Deployed", queued: false }] },
];
const envs = [{ name: "dev", projects: 3 }, { name: "uat", projects: 3 }, { name: "prod", projects: 2 }];
const json = (route, status, body) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

try {
  // ------------------------------------------------------------ 0. the real route
  s.step("0. The server answers for repositories");
  const real = await s.context.request.get(`${opts.base}/api/factory/repos`);
  const realBody = await real.json().catch(() => null);
  s.check(real.status() === 200 && Array.isArray(realBody?.repos), "the list of connected repositories is served", `status ${real.status()}`);
  s.check(!JSON.stringify(realBody ?? {}).includes("\"token\""), "no stored token is in the answer");
  const list = await (await s.context.request.get(`${opts.base}/api/factory/migrations`)).json().catch(() => ({}));
  const migs = Array.isArray(list?.migrations) ? list.migrations : [];
  const someMig = migs.find((m) => !m.busy)?.id ?? "";

  await s.context.route("**/api/factory/repos", async (route) => {
    const req = route.request();
    if (req.method() === "GET") {
      if (readsLeft > 0 && --readsLeft === 0) repos = repos.map((r) => (r.state === "reading" ? { ...r, state: "ready", onBranch: "main", commit: "0123456789abcdef0123", readAt: new Date().toISOString(), projects: projects(someMig), environments: envs } : r));
      return json(route, 200, { repos });
    }
    const body = req.postDataJSON();
    sent.connect.push(body);
    const repo = { id: "ab12cd34ef56", name: body.name, url: body.url, branch: body.branch || "", username: body.username || "", hasToken: !!body.token, state: "reading", message: "", projects: [], environments: [] };
    repos = [...repos, repo];
    readsLeft = 2;
    return json(route, 201, repo);
  });
  await s.context.route("**/api/factory/repos/*/refresh", async (route) => {
    const id = route.request().url().split("/").slice(-2)[0];
    sent.refresh.push({ id, body: route.request().postDataJSON() });
    repos = repos.map((r) => (r.id === id ? { ...r, state: "reading", message: "" } : r));
    readsLeft = 2;
    return json(route, 202, repos.find((r) => r.id === id) ?? {});
  });
  await s.context.route("**/api/factory/repos/*/import", async (route) => {
    const body = route.request().postDataJSON();
    sent.imports.push(body);
    repos = repos.map((r) => ({ ...r, projects: (r.projects ?? []).map((p) => (body.paths.includes(p.path) ? { ...p, migrations: [{ id: `e2e-${p.name}`, name: p.name, outcome: "Not started", queued: true }] } : p)) }));
    return json(route, 201, { created: body.paths.slice(0, 1).map((p) => ({ id: `e2e-${p.split("/").pop()}`, name: p.split("/").pop(), path: p })), refused: body.paths.slice(1).map((p) => ({ path: p, error: "The project is larger than this server accepts (500 MB)." })), workspace: body.workspace });
  });
  await s.context.route(/\/api\/factory\/repos\/[0-9a-f]+$/, async (route) => {
    if (route.request().method() !== "DELETE") return route.continue();
    const id = route.request().url().split("/").pop();
    sent.removed.push(id);
    repos = repos.filter((r) => r.id !== id);
    return json(route, 200, { ok: true });
  });

  // ------------------------------------------------------------ 1. two ways to start
  s.step("1. A migration can start from an upload or from a git repository");
  await s.goto("/migrations/new");
  const ways = page.getByRole("navigation", { name: "Where the source comes from" });
  await ways.waitFor();
  s.check((await ways.getByRole("link").count()) === 2, "both ways are offered on the new-migration screen");
  s.check((await ways.locator('[aria-current="page"]').innerText()).includes("Upload a file"), "the upload is the way that is open");
  s.check(await page.getByRole("button", { name: "Choose the file to upload" }).isVisible(), "the upload itself is still there");
  s.check((await s.overflow()) === 0, "nothing runs off the side of the page");
  await s.shot("two-ways");
  await ways.getByRole("link", { name: /From a git repository/ }).click();
  await page.getByRole("heading", { name: "Migrate from a git repository" }).waitFor();
  s.check(/\/migrations\/from-git$/.test(new URL(page.url()).pathname), "the second way opens its own screen");
  const form = page.locator('[data-testid="repo-form"]');
  await form.waitFor();
  s.check(await form.isVisible(), "with no repository connected, the form to connect one is open");

  // ------------------------------------------------------------ 2. what is typed is checked first
  s.step("2. What is typed is checked before anything is sent");
  const connectBtn = form.getByRole("button", { name: "Connect and read it" });
  await connectBtn.click();
  s.check((await form.getByRole("alert").count()) >= 2, "an empty form says what is missing");
  await form.getByPlaceholder("Integration APIs").fill("Integration APIs");
  await form.getByLabel("Address of the repository").fill("git@git.example.test:team/apis.git");
  s.check(/Clone with HTTPS/.test(await form.innerText()), "an SSH address is refused with the address to use instead");
  await form.getByLabel("Address of the repository").fill("https://someone:secret@git.example.test/team/apis.git");
  s.check(/own fields/.test(await form.innerText()), "a user name or token inside the address is refused");
  await connectBtn.click();
  s.check(sent.connect.length === 0, "nothing was sent while the form had a problem");
  const tokenField = form.getByLabel("Access token");
  s.check((await tokenField.getAttribute("type")) === "password", "the access token is typed into a hidden field");
  s.check(/kept on this server/.test(await form.innerText()), "it says where the token is kept");

  // ------------------------------------------------------------ 3. connect and read
  s.step("3. Connect a repository");
  await form.getByLabel("Address of the repository").fill(ADDRESS);
  await tokenField.fill(TOKEN);
  await connectBtn.click();
  const card = page.locator('[data-testid="repo-card"]').first();
  await card.waitFor();
  s.check(sent.connect.length === 1 && sent.connect[0].url === ADDRESS && sent.connect[0].token === TOKEN && sent.connect[0].name === "Integration APIs", "the name, the address and the token went to the server once");
  s.check(/Reading/.test(await card.innerText()), "the card says the repository is being read");
  await s.shot("reading");
  await page.locator('[data-testid="repo-card"][data-state="ready"]').waitFor();
  const cardText = await card.innerText();
  s.check(/3 projects/.test(cardText) && /branch main/.test(cardText) && /commit 0123456/.test(cardText), "when read, it shows the number of projects, the branch and the commit", cardText.replace(/\s+/g, " ").slice(0, 160));
  s.check(!(await page.content()).includes(TOKEN), "the token is nowhere on the page after connecting");
  s.check((await page.locator('[data-testid="repo-form"]').count()) === 0, "the form closes");

  // ------------------------------------------------------------ 4. projects
  s.step("4. Choose the projects");
  const rows = page.locator('[data-testid="project-row"]');
  s.check((await rows.count()) === 3, "every project of the repository is listed");
  const ticked = async () => rows.evaluateAll((trs) => trs.filter((tr) => tr.querySelector('input[type="checkbox"]').checked).map((tr) => tr.querySelector("strong").textContent));
  s.check(JSON.stringify(await ticked()) === JSON.stringify(["orders-api", "stock-api"]), "the projects without a migration are ticked, the migrated one is not", JSON.stringify(await ticked()));
  s.check(/Deployed/.test(await rows.nth(2).innerText()), "the migrated project shows the state of its migration");
  s.check(/Encrypted values/.test(await rows.nth(1).innerText()) && !/Encrypted values/.test(await rows.nth(0).innerText()), "a project with encrypted settings is marked");
  const startBtn = page.getByRole("button", { name: /^Migrate \d+ projects?$/ });
  s.check((await startBtn.innerText()).trim() === "Migrate 2 projects", "the button says how many projects it starts");
  s.check((await s.overflow()) === 0, "nothing runs off the side of the page");
  await s.shot("projects");

  // ------------------------------------------------------------ 5. settings and start
  s.step("5. Addresses come from the settings files, and the projects start");
  const envSelect = page.getByLabel("Take the addresses from the settings of");
  const envOptions = await envSelect.locator("option").allInnerTexts();
  s.check(envOptions.some((o) => /^uat \(every project\)$/.test(o.trim())) && envOptions.some((o) => /^prod \(2 of 3 projects\)$/.test(o.trim())), "the settings files of the projects are offered, with how many projects have each", envOptions.join(" | "));
  await startBtn.click();
  s.check(sent.imports.length === 0 && /Choose the settings file/.test(await page.locator(".mf-mg-wizard").innerText()), "it does not start before the settings file is chosen");
  await envSelect.selectOption("uat");
  const plan = await page.locator('[data-testid="plan"]').innerText();
  s.check(/2 projects are worked through one after the other/.test(plan) && /settings file "uat"/.test(plan) && /built and tested/.test(plan) && /Nothing is deployed/.test(plan), "one sentence says what will happen", plan);
  await s.shot("ready-to-start");
  await startBtn.click();
  await page.getByText("See the migrations").waitFor();
  const imp = sent.imports[0] ?? {};
  s.check(sent.imports.length === 1 && JSON.stringify(imp.paths) === JSON.stringify(["apis/orders-api", "apis/stock-api"]) && imp.environment === "uat" && imp.build === true && typeof imp.workspace === "string" && imp.workspace.length > 0,
    "the two projects, the workspace, the settings file and the build went to the server once", JSON.stringify({ ...imp, workspace: imp.workspace ? "(set)" : "" }));
  s.check(!("token" in imp), "no token travels with it");
  const started = await page.locator(".mf-mg-wizard").innerText();
  s.check(/1 migration was created/.test(started) && /1 project was not taken/.test(started) && /larger than this server accepts/.test(started), "it says what was created and what was not taken, with the reason");
  s.check(JSON.stringify(await ticked()) === "[]" && /Being migrated/.test(await rows.nth(0).innerText()), "the started projects show that they are being migrated and are no longer ticked");
  s.check((await s.overflow()) === 0, "nothing runs off the side of the page");
  await s.shot("started");

  // ------------------------------------------------------------ 6. a repository that cannot be read
  s.step("6. A repository that could not be read");
  repos = repos.map((r) => ({ ...r, state: "failed", message: "The git server refused the sign-in. Check the access token and that it may read this repository." }));
  await s.goto("/migrations/from-git");
  await page.locator('[data-testid="repo-card"][data-state="failed"]').waitFor();
  s.check(/refused the sign-in/.test(await card.innerText()), "the card says why in plain words");
  s.check((await page.locator('[data-testid="project-row"]').count()) === 0, "no projects are offered from it");
  await card.getByRole("button", { name: "Change the token" }).click();
  await card.getByLabel("New access token").fill(`${TOKEN}-2`);
  await s.shot("new-token");
  await card.getByRole("button", { name: "Save and read again" }).click();
  await page.locator('[data-testid="repo-card"][data-state="ready"]').waitFor();
  s.check(sent.refresh.length === 1 && sent.refresh[0].id === "ab12cd34ef56" && sent.refresh[0].body.token === `${TOKEN}-2`, "the new token is sent and the repository is read again");
  s.check(!(await page.content()).includes(TOKEN), "the token is nowhere on the page afterwards");

  // ------------------------------------------------------------ 7. remove
  s.step("7. Remove a repository");
  await card.getByRole("button", { name: "Remove" }).click();
  const dlg = page.getByRole("dialog").last();
  s.check(/stored access token are deleted/.test(await dlg.innerText()) && /stay as they are/.test(await dlg.innerText()), "it asks first and says what is deleted and what stays");
  s.check(sent.removed.length === 0, "nothing is removed before the answer");
  await dlg.getByRole("button", { name: "Remove" }).click();
  await page.locator('[data-testid="repo-form"]').waitFor();
  s.check(sent.removed.length === 1 && (await page.locator('[data-testid="repo-card"]').count()) === 0, "the repository is gone and the form to connect one is back");

  // ------------------------------------------------------------ 8. the list of migrations
  s.step("8. The list of migrations");
  if (!migs.length) s.warn("there is no migration on this server, so the waiting mark was not checked");
  else {
    const waiting = migs.find((m) => !m.busy) ?? migs[0];
    const laid = { ...list, migrations: migs.map((m) => (m.id === waiting.id ? { ...m, busy: false, queued: 2 } : { ...m, queued: 0 })) };
    await page.route("**/api/factory/migrations", (r) => (r.request().method() === "GET" ? r.fulfill({ json: laid }) : r.continue()));
    await s.goto("/migrations");
    await page.getByText("Waiting its turn").first().waitFor();
    s.check((await page.getByText("Waiting its turn").count()) === 1, "a project that waits for the one before it is marked as waiting");
    s.check(await page.getByRole("link", { name: "From a git repository" }).isVisible(), "the list offers the git repository beside the new migration");
    s.check((await s.overflow()) === 0, "nothing runs off the side of the page");
    await s.shot("waiting");
    await page.unroute("**/api/factory/migrations");
  }
} catch (e) {
  s.fail(`the check stopped: ${e?.message ?? e}`);
} finally {
  await s.finish();
}
