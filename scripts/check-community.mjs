import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import Database from "better-sqlite3";
const root = path.resolve(process.argv[2] || ".");
const data = await fs.mkdtemp(path.join(os.tmpdir(), "tameduck-public-smoke-"));
const probe = net.createServer();
await new Promise((r) => probe.listen(0, "127.0.0.1", r));
const port = probe.address().port;
await new Promise((r) => probe.close(r));
const origin = `http://127.0.0.1:${port}`;
const setup = crypto.randomBytes(32).toString("hex");
const child = spawn(process.execPath, ["server/index.mjs"], {
  cwd: root,
  env: {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    NODE_ENV: "production",
    DATA_DIR: data,
    PORT: String(port),
    APP_URL: origin,
    ENCRYPTION_KEY: crypto.randomBytes(32).toString("hex"),
    SETUP_TOKEN_HASH: crypto.createHash("sha256").update(setup).digest("hex"),
    NO_BACKGROUND_WORK: "1",
    // Deliberately unsafe: native requests must fail closed without launching
    // any provider process, while the web app remains available.
    DUCK_SANDBOX_NETWORK: "host",
    PUBLIC_SOURCE_URL: "https://github.com/internetco/tameduck",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
child.stdout.on("data", (b) => (output += b));
child.stderr.on("data", (b) => (output += b));
let exit;
const closed = new Promise((r) =>
  child.once("close", (code) => {
    exit = code;
    r();
  }),
);
try {
  let up = false;
  for (let i = 0; i < 100; i++) {
    if (exit !== undefined)
      throw new Error("Server exited during startup: " + output.slice(-3500));
    try {
      const r = await fetch(origin + "/api/public");
      if (r.ok) {
        assert.equal((await r.json()).needsSetup, true);
        up = true;
        break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(up, true, "server must start with a fresh temporary database");
  const cspRoutes = ["/", "/login", "/api/public"];
  for (const route of cspRoutes) {
    const csp = (await fetch(origin + route)).headers.get(
      "content-security-policy",
    );
    assert.ok(csp, "CSP header must be present: " + route);
    const directives = Object.fromEntries(
      csp.split(";").map((directive) => {
        const [name, ...sources] = directive.trim().split(/\s+/);
        return [name, sources];
      }),
    );
    for (const name of ["script-src", "img-src", "connect-src"])
      assert.equal(
        directives[name].includes("https://pijtk6cbfb.9.sub-site.eu"),
        false,
        `community ${name} must not allow external analytics: ${route}`,
      );
    assert.deepEqual(directives["script-src"], ["'self'"], route);
    assert.deepEqual(directives["connect-src"], ["'self'"], route);
    assert.deepEqual(directives["img-src"], ["'self'", "data:"], route);
  }
  for (const url of ["/", "/setup", "/about", "/LICENSE.txt"])
    assert.equal((await fetch(origin + url)).status, 200, url);
  const help = await fetch(origin + "/help");
  assert.equal(help.status, 200);
  const helpHtml = await help.text();
  assert.match(helpHtml, /TameDuck Cloud/);
  assert.doesNotMatch(helpHtml, /href="\/pricing|Try it for &euro;1/);
  const guidesResponse = await fetch(origin + "/help/guides.json");
  assert.equal(guidesResponse.status, 200);
  const guides = await guidesResponse.json();
  assert.ok(guides.length > 0);
  for (const guide of guides) {
    assert.equal((await fetch(origin + "/help/" + guide.id)).status, 200, guide.id);
    for (const step of guide.steps) if (step.image) {
      const screenshot = await fetch(origin + step.image.src);
      assert.equal(screenshot.status, 200, step.image.src);
      assert.match(screenshot.headers.get("content-type"), /^image\/png/);
      await screenshot.arrayBuffer();
    }
  }
  for (const file of ["help.css", "help-search.js", "help-guides.js", "help-guide.js"])
    assert.equal((await fetch(origin + "/help/" + file)).status, 200, file);
  for (const url of [
    "/home.html",
    "/pricing",
    "/pricing.html",
    "/pricing.js",
    "/demo.html",
    "/demo.js",
    "/demo/shots/chief.png",
  ])
    assert.equal((await fetch(origin + url)).status, 404, url);
  const source = await fetch(origin + "/source", { redirect: "manual" });
  assert.equal(
    source.headers.get("location"),
    "https://github.com/internetco/tameduck",
  );
  const analytics = await (await fetch(origin + "/analytics.js")).text();
  assert.equal(analytics.includes("matomo"), false);
  // Somebody else's sign-in link opens nothing on a community server, before
  // setup or after it: no account, and the setup link stays the way in.
  const database = new Database(path.join(data, "tameduck.sqlite"));
  const users = () => database.prepare("SELECT count(*) n FROM users").get().n;
  const strangerEnters = async () => {
    const value = crypto.randomBytes(32).toString("base64url");
    database
      .prepare("INSERT INTO sign_in_links VALUES(?,?,?,?,0)")
      .run(
        crypto.createHash("sha256").update(value).digest("hex"),
        "stranger@example.test",
        Date.now(),
        Date.now() + 15 * 60000,
      );
    return fetch(origin + "/api/auth/enter", {
      method: "POST",
      headers: { "content-type": "application/json", "x-tameduck": "1", origin },
      body: JSON.stringify({ token: value }),
    });
  };
  assert.equal((await strangerEnters()).status, 403, "a stranger before setup");
  assert.equal(users(), 0);
  const create = await fetch(origin + "/api/auth/setup", {
    method: "POST",
    headers: { "content-type": "application/json", "x-tameduck": "1", origin },
    body: JSON.stringify({
      token: setup,
      name: "Preview Owner",
      email: "preview@example.test",
      password: crypto.randomBytes(24).toString("base64url"),
      company: "Preview Test",
    }),
  });
  assert.equal(create.status, 200);
  assert.equal((await strangerEnters()).status, 403, "a stranger after setup");
  assert.equal(users(), 1);
  database.close();
  const cookie = create.headers.get("set-cookie").split(";")[0];
  const stateResponse = await fetch(origin + "/api/state", {
    headers: { cookie },
  });
  assert.equal(stateResponse.status, 200);
  const state = await stateResponse.json();
  assert.equal(state.distribution.edition, "community");
  assert.equal(state.distribution.license, "AGPL-3.0-only");
  assert.equal(state.company.name, "Preview Test");
  assert.equal(state.billingConfigured, false);
  assert.equal(state.billing.enabled, false);
  assert.equal(state.billing.mode, "off");
  assert.equal(state.billing.blocked, false);
  assert.equal(state.company.billing_status, "staging");
  assert.ok(state.company.onboarded_at);
  const headers = {
    cookie,
    "content-type": "application/json",
    "x-tameduck": "1",
    origin,
  };
  const newCompany = await fetch(origin + "/api/companies", {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "Community Second Company" }),
  });
  assert.equal(newCompany.status, 200, "community can create another company");
  const newCompanyStateResponse = await fetch(origin + "/api/state", {
    headers: { cookie },
  });
  assert.equal(newCompanyStateResponse.status, 200);
  const newCompanyState = await newCompanyStateResponse.json();
  assert.equal(newCompanyState.company.name, "Community Second Company");
  assert.equal(newCompanyState.company.billing_status, "staging");
  assert.equal(newCompanyState.company.paused, 0);
  assert.equal(newCompanyState.billing.enabled, false);
  assert.equal(newCompanyState.billing.mode, "off");
  assert.equal(newCompanyState.billing.blocked, false);
  for (const route of ["", "checkout", "quote", "start-now", "webhook", "invoices", "payments/test"])
    for (const method of ["GET", "POST"])
      assert.equal(
        (
          await fetch(origin + "/api/billing" + (route ? "/" + route : ""), {
            method,
            headers,
            body: method === "POST" ? "{}" : undefined,
          })
        ).status,
        404,
        "community billing must be disabled: " + method + " " + (route || "/"),
      );
  const native = await fetch(origin + "/api/ai/connect", {
    method: "POST",
    headers,
    body: "{}",
  });
  assert.equal(
    native.status,
    503,
    "unverified native execution must be blocked",
  );
  assert.match(
    (await native.json()).error,
    /sandbox network isolation has not been verified/,
  );
  assert.equal(
    (await fetch(origin + "/api/state", { headers: { cookie } })).status,
    200,
    "the application must remain available after native execution is blocked",
  );
  assert.equal(
    (await fetch(origin + "/api/ai/config", { headers: { cookie } })).status,
    200,
    "API-key provider settings must remain available",
  );
  assert.equal(
    (await (await fetch(origin + "/api/public")).json()).needsSetup,
    false,
  );
  assert.equal(
    (
      await (await fetch(origin + "/", { headers: { cookie } })).text()
    ).includes("/assets/"),
    true,
  );
  console.log(
    JSON.stringify({
      ok: true,
      checks: [
        "fresh database migrations",
        "owner setup",
        "strangers' sign-in links open nothing, before or after setup",
        "authenticated state",
        "billing is off and blocks nothing",
        "a second company can be created",
        "there are no billing routes",
        "community source metadata",
        "native execution fails closed with host networking",
        "application remains available with native agents disabled",
        "anonymous and authenticated routes",
        "source and license",
        "marketing blocked",
        "Help pages, guide data, scripts and all referenced screenshots available",
        "analytics absent",
        "browser policy excludes hosted analytics",
      ],
      externalProviderCalls: false,
    }),
  );
} finally {
  child.kill("SIGTERM");
  await closed;
  await fs.rm(data, { recursive: true, force: true });
}
