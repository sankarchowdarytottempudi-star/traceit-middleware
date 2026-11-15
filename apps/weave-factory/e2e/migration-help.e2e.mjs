#!/usr/bin/env node
// Factory: a migration whose step failed, or that is not finished, says what to do and offers the step again.
//
//   node e2e/migration-help.e2e.mjs [baseUrl] [--id <migrationId>] [--shots <dir>] [--width 390 --height 844]
//
// Read-only: it never starts a step. The "failed" case is the real migration with a failed build
// laid over its answer, so the check does not depend on something being broken at the time.
import { parseArgs, Session } from "./studio-lib.mjs";

const opts = parseArgs(["--id"]);
const i = opts.rest.indexOf("--id");
let id = i >= 0 ? opts.rest[i + 1] : "";
const s = new Session(opts);
const page = await s.start();
const api = `${opts.base}/api/factory/migrations`;

try {
  const list = await (await s.context.request.get(api)).json();
  const all = Array.isArray(list?.migrations) ? list.migrations : [];
  if (!id) id = (all.find((m) => m?.progress?.failure) ?? all[0])?.id ?? "";
  if (!id) { s.warn("there is no migration to look at"); }
  else {
    const real = await (await s.context.request.get(`${api}/${id}`)).json();
    const manualOpen = (m) => (m.phases ?? []).filter((p) => p.mode === "manual").flatMap((p) => p.steps ?? []).filter((st) => st.status === "action_required").length;
    const panel = page.locator('[data-testid="what-now"]');

    // ------------------------------------------------------------ 1. the migration as it is
    s.step(`1. The migration as it is (${real.progress?.failure ? "has a step that needs attention" : "nothing needs attention"})`);
    await s.goto(`/migrations/${id}`);
    await page.getByText("What you can do next").first().waitFor();
    if (real.progress?.failure && !real.busy) {
      await panel.waitFor();
      const help = real.progress.failure.help ?? {};
      s.check((await panel.innerText()).includes(String(help.what ?? "").slice(0, 40)), "it says in plain words what happened");
      s.check((await panel.locator("ol li").count()) >= 1, "it lists what you can do");
      if (help.kind === "not-ready") {
        s.check(await panel.getByRole("button", { name: /Check again/ }).isVisible(), "it offers to check again");
        s.check((await page.getByRole("button", { name: /^Deploy/ }).count()) === 0, "deployment is not offered while the service is not finished");
      }
    } else s.check((await panel.count()) === 0, "no help panel when nothing needs attention");
    s.check((await page.getByRole("button", { name: "Mark as done" }).count()) === manualOpen(real), "only the steps a person does can be marked as done", `${await page.getByRole("button", { name: "Mark as done" }).count()} shown, ${manualOpen(real)} expected`);
    s.check((await s.overflow()) === 0, "nothing runs off the side of the page");
    await s.shot("as-it-is");

    // ------------------------------------------------------------ 2. a failed build
    s.step("2. A step that failed");
    const failed = structuredClone(real);
    failed.busy = false;
    for (const p of failed.phases ?? []) if (p.key === "test") { p.status = "failed"; for (const st of p.steps ?? []) if (st.key === "build") { st.status = "failed"; st.detail = "ERROR [Ballerina.toml] could not locate the package path"; } }
    failed.progress = { ...(failed.progress ?? {}), outcome: "Failed", failure: { phase: "Testing", phaseKey: "test", step: "bal build", stepKey: "build", status: "failed",
      detail: "ERROR [Ballerina.toml] could not locate the package path",
      output: "Compiling source\nERROR [Ballerina.toml:(4:1,18:2)] could not locate the package path 'services/example'",
      help: { kind: "workspace-entry", what: "The build stopped before it reached this API.", why: "The shared build list named a folder that no longer exists.", todo: ["Run this step again. The tool now removes the dead entry first.", "If it fails the same way, send the tool output through the Feedback tab."], retry: true } } };
    await page.route(`**/api/factory/migrations/${id}`, (r) => r.request().method() === "GET" ? r.fulfill({ json: failed }) : r.continue());
    await s.goto(`/migrations/${id}`);
    await panel.waitFor();
    const text = await panel.innerText();
    s.check(/The build stopped before it reached this API/.test(text) && /no longer exists/.test(text), "it says what happened and why");
    s.check((await panel.locator("ol li").count()) === 2, "it lists the two things to do");
    await panel.locator("summary").click();
    s.check(await panel.locator("pre").isVisible() && /could not locate the package path/.test(await panel.locator("pre").innerText()), "the tool output can be opened");
    const again = panel.getByRole("button", { name: "Run this step again" });
    s.check(await again.isVisible(), "it offers the failed step again");
    await again.click();
    const dlg = page.getByRole("dialog").last();
    s.check(await dlg.isVisible().catch(() => false), "running it again asks first (nothing is started by this check)");
    await s.shot("failed-step");
    await page.keyboard.press("Escape");
    s.check((await s.overflow()) === 0, "nothing runs off the side of the page");
    await page.unroute(`**/api/factory/migrations/${id}`);
  }
} catch (e) {
  s.fail(`the check stopped: ${e?.message ?? e}`);
} finally {
  await s.finish();
}
