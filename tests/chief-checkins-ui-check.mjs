// Disposable end-to-end check for the Chief-only check-in controls.
import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import assert from "node:assert/strict";
import { freePort } from "./free-port.mjs";
const root = path.resolve(import.meta.dirname, ".."),
  out = fs.mkdtempSync(root + "/work/chief-checkins-ui-"),
  dir = fs.mkdtempSync(root + "/work/chief-checkins-data-");
const port = process.env.CHECK_PORT || (await freePort()),
  origin = "http://127.0.0.1:" + port,
  setup = crypto.randomBytes(24).toString("hex"),
  key = crypto.randomBytes(32).toString("hex");
const child = spawn(process.execPath, ["server/index.mjs"], {
  cwd: root,
  env: {
    PATH: process.env.PATH,
    PORT: port,
    APP_URL: origin,
    DATA_DIR: dir,
    ENCRYPTION_KEY: key,
    SETUP_TOKEN_HASH: crypto.createHash("sha256").update(setup).digest("hex"),
    NO_BACKGROUND_WORK: "1",
  },
});
let logs = "";
child.stdout.on("data", (d) => (logs += d));
child.stderr.on("data", (d) => (logs += d));
for (let i = 0; i < 100; i++) {
  try {
    await fetch(origin + "/api/health");
    break;
  } catch {
    await new Promise((r) => setTimeout(r, 100));
  }
}
process.env.DATA_DIR = dir;
process.env.ENCRYPTION_KEY = key;
const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox"],
  }),
  page = await browser.newPage({ viewport: { width: 1365, height: 950 } }),
  errors = [];
page.on("pageerror", (e) => errors.push(e.message));
try {
  await page.goto(origin + "/setup#" + setup);
  await page.getByLabel("Your name", { exact: true }).fill("Robin Tester");
  await page.getByLabel("Email address").fill("robin@example.test");
  await page.getByLabel("Company name").fill("Check-ins B.V.");
  await page
    .getByLabel("Password", { exact: true })
    .fill("A disposable check-in password!");
  await page.getByRole("button", { name: "Create your workspace" }).click();
  await page.getByRole("button", { name: "I saved my key" }).click();
  await page.getByPlaceholder("Message Chief Duck…").waitFor();
  const store = await import("../server/store.mjs"),
    state = await page.evaluate(async () =>
      (await fetch("/api/state", { headers: { "X-TameDuck": "1" } })).json(),
    ),
    company = state.company.id;
  await page.goto(origin + "/w/" + company + "/settings/ducks");
  const panel = page.locator(".chief-checkins");
  await panel.waitFor();
  assert.equal(
    await panel
      .getByRole("switch", { name: "Enable Chief Duck check-ins" })
      .isChecked(),
    false,
    "a Chief without an AI connection must stay off",
  );
  assert.ok(
    await panel.getByRole("button", { name: "Check now" }).isDisabled(),
    "Check now must be unavailable while off",
  );
  assert.equal(
    await panel.locator('select[aria-label="Check-in frequency"]').count(),
    1,
    "frequency is the only select and does not expose a model field",
  );
  assert.equal(await panel.locator('input[type="text"]').count(), 0);
  assert.equal(
    await panel.locator("input[type=time]").count(),
    2,
    "two default times should be shown",
  );
  assert.equal(
    await panel.locator("input[type=time]").nth(0).inputValue(),
    "09:00",
  );
  assert.equal(
    await panel.locator("input[type=time]").nth(1).inputValue(),
    "15:00",
  );
  assert.equal(
    await panel.locator("input[type=checkbox]:not([role=switch])").count(),
    1,
    "the section should have only the weekdays checkbox",
  );
  assert.equal(
    await panel.evaluate((el) => !!el.closest(".duck-perms-table")),
    false,
    "the panel must sit outside the bulk permissions grid",
  );
  await panel
    .getByRole("switch", { name: "Enable Chief Duck check-ins" })
    .click();
  await page
    .getByRole("status")
    .filter({ hasText: "Check-ins enabled" })
    .waitFor();
  let cfg = await (
    await page.request.get(origin + "/api/chief-checkins", {
      headers: { "X-TameDuck": "1" },
    })
  ).json();
  assert.equal(cfg.enabled, true);
  await page.reload();
  await panel.waitFor();
  await panel.getByLabel("Check-in frequency").selectOption("once");
  await page.waitForFunction(async () => {
    const r = await fetch("/api/chief-checkins", {
      headers: { "X-TameDuck": "1" },
    });
    return (await r.json()).times.length === 1;
  });
  await page
    .getByRole("textbox", { name: "First check-in time" })
    .fill("10:45");
  await panel.getByRole("button", { name: "Save times" }).click();
  await page.getByRole("status").filter({ hasText: "Times saved" }).waitFor();
  await panel.getByLabel("Weekdays only").click();
  await page.waitForFunction(async () => {
    const r = await fetch("/api/chief-checkins", {
      headers: { "X-TameDuck": "1" },
    });
    return (await r.json()).weekdays_only === false;
  });
  cfg = await (
    await page.request.get(origin + "/api/chief-checkins", {
      headers: { "X-TameDuck": "1" },
    })
  ).json();
  assert.deepEqual(cfg.times, [645]);
  assert.equal(cfg.weekdays_only, false);
  await panel.getByLabel("Check-in frequency").selectOption("twice");
  await page.waitForFunction(async () => {
    const r = await fetch("/api/chief-checkins", {
      headers: { "X-TameDuck": "1" },
    });
    return (await r.json()).times.length === 2;
  });
  cfg = await (
    await page.request.get(origin + "/api/chief-checkins", {
      headers: { "X-TameDuck": "1" },
    })
  ).json();
  assert.equal(new Set(cfg.times).size, 2);
  await page.reload();
  await panel.waitFor();
  assert.equal(
    await panel
      .getByRole("textbox", { name: "First check-in time" })
      .inputValue(),
    "10:45",
    "saved time should survive reload",
  );
  assert.equal(await panel.getByLabel("Weekdays only").isChecked(), false);
  await panel.scrollIntoViewIfNeeded();
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "clean";
  });
  await panel.screenshot({ path: out + "/settings-desktop.png" });
  await page.screenshot({
    path: out + "/settings-page-desktop.png",
    fullPage: true,
  });
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "dark";
  });
  await panel.screenshot({ path: out + "/settings-dark-desktop.png" });
  await page.screenshot({
    path: out + "/settings-page-dark-desktop.png",
    fullPage: true,
  });
  const check = panel.getByRole("button", { name: "Check now" });
  await page.route("**/api/chief-checkins/check", (route) =>
    route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: "AI connection is unavailable." }),
    }),
  );
  await check.click();
  await panel.getByRole("alert").waitFor();
  assert.match(
    await panel.getByRole("alert").innerText(),
    /AI connection is unavailable/,
  );
  await page.unroute("**/api/chief-checkins/check");
  await check.click();
  await page
    .getByRole("status")
    .filter({ hasText: /AI connection is unavailable/ })
    .waitFor();
  assert.doesNotMatch(
    await panel.innerText(),
    /Check started/,
    "an unavailable check must not claim it started",
  );
  const chief = store.one(
      "SELECT * FROM ducks WHERE company_id=? AND chief=1 AND removed=0",
      company,
    ),
    conv = store.directConversation(company, state.user.id, chief),
    msg = store.addMessage(
      company,
      conv.id,
      "Review the updated launch plan before Friday.",
      { duck: chief.id, origin: "chief_checkin_suggestion", state: "sent" },
    ),
    job = store.id(),
    runId = store.id(),
    now = store.now();
  store.run(
    "INSERT INTO jobs(id,company_id,user_id,conversation_id,duck_id,output_message_id,status,created,updated,checkin) VALUES(?,?,?,?,?,?,'completed',?,?,1)",
    job,
    company,
    state.user.id,
    conv.id,
    chief.id,
    msg,
    now,
    now,
  );
  store.run(
    "INSERT INTO chief_checkin_runs(id,user_id,company_id,duck_id,job_id,context_hash,result,summary,created,finished_at) VALUES(?,?,?,?,?,'fixture-hash','suggested',?,?,?)",
    runId,
    state.user.id,
    company,
    chief.id,
    job,
    "Review the updated launch plan before Friday.",
    now,
    now,
  );
  await page.goto(origin + "/w/" + company + "/chat/" + conv.id);
  await page
    .getByText("Review the updated launch plan before Friday.")
    .waitFor();
  await page.getByRole("button", { name: "Dismiss", exact: true }).click();
  await page.getByText("Dismissed", { exact: true }).waitFor();
  assert.equal(
    store.one("SELECT dismissed FROM chief_checkin_runs WHERE id=?", runId)
      .dismissed,
    1,
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(origin + "/w/" + company + "/settings/ducks");
  await panel.waitFor();
  await panel.scrollIntoViewIfNeeded();
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "clean";
  });
  await panel.screenshot({ path: out + "/settings-mobile.png" });
  await page.screenshot({
    path: out + "/settings-page-mobile.png",
    fullPage: true,
  });
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "dark";
  });
  await panel.screenshot({ path: out + "/settings-dark-mobile.png" });
  await page.screenshot({
    path: out + "/settings-page-dark-mobile.png",
    fullPage: true,
  });
  const sizes = await panel.evaluate((el) => ({
    width: el.clientWidth,
    scroll: el.scrollWidth,
    screen: document.documentElement.clientWidth,
    body: document.body.scrollWidth,
  }));
  assert.ok(
    sizes.scroll <= sizes.width + 1,
    "check-in panel overflows at mobile width: " + JSON.stringify(sizes),
  );
  assert.ok(
    sizes.body <= sizes.screen + 1,
    "page has horizontal mobile overflow: " + JSON.stringify(sizes),
  );
  store.run("UPDATE ducks SET chief=0 WHERE id=?", chief.id);
  await page.reload();
  await page.waitForTimeout(200);
  assert.equal(
    await page.locator(".chief-checkins").count(),
    0,
    "settings should hide the section when no Chief exists",
  );
  assert.deepEqual(errors, [], "browser errors");
  console.log(
    "PASS Chief check-in settings, persistence, unavailable/error states, private suggestion dismissal, and mobile width",
  );
  console.log("SHOTS " + out);
} catch (e) {
  await page
    .screenshot({ path: out + "/failure.png", fullPage: true })
    .catch(() => {});
  console.error(e);
  console.error(logs.slice(-1600));
  process.exitCode = 1;
} finally {
  await browser.close();
  child.kill("SIGTERM");
}
