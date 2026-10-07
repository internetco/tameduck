import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import { registerWebPages, registerWebPageGuards, readDistribution } from "../server/web-pages.mjs";

async function server(appOnly, files) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tameduck-pages-"));
  await fs.mkdir(path.join(root, "dist"));
  await Promise.all(Object.entries(files).map(([name, body]) =>
    (async () => {
      const target = path.join(root, "dist", name.includes(".") ? name : name + ".html");
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, body);
    })()));
  const app = express();
  registerWebPageGuards(app, { root });
  app.use(express.static(path.join(root, "dist"), { index: false }));
  registerWebPages(app, { root, appOnly, signedIn: req => req.headers.cookie === "signed=1" });
  const listener = await new Promise(resolve => {
    const value = app.listen(0, "127.0.0.1", () => resolve(value));
  });
  return { root, listener, url: `http://127.0.0.1:${listener.address().port}` };
}

async function close(value) {
  await new Promise((resolve, reject) => value.listener.close(error => error ? reject(error) : resolve()));
  await fs.rm(value.root, { recursive: true, force: true });
}

test("hosted /home is the website's home page for somebody signed in", async t => {
  const value = await server(false, { home: '<nav><a href="/login">Sign in</a></nav> MARKETING', index: "APP", enter: "LOGIN" });
  t.after(() => close(value));
  const signed = await fetch(value.url + "/home", { headers: { cookie: "signed=1" } });
  assert.equal(signed.status, 200);
  const body = await signed.text();
  assert.match(body, /MARKETING/);
  assert.match(body, /<a href="\/">Open TameDuck<\/a>/);
  assert.doesNotMatch(body, /Sign in/);
  assert.equal(signed.headers.get("cache-control"), "no-store");
  assert.match(signed.headers.get("x-robots-tag"), /noindex/);
  // Signed out, the home page has one address.
  const out = await fetch(value.url + "/home", { redirect: "manual" });
  assert.equal(out.status, 302);
  assert.equal(out.headers.get("location"), "/");
  // An app-only build has no website: /home is the app's, like any other path.
  const appOnly = await server(true, { index: "APP", enter: "LOGIN" });
  t.after(() => close(appOnly));
  assert.equal(await (await fetch(appOnly.url + "/home", { headers: { cookie: "signed=1" } })).text(), "APP");
});

test("hosted root keeps marketing page for signed-out visitors", async t => {
  const value = await server(false, { home: "MARKETING", index: "APP", enter: "LOGIN", pricing: "PRICE", demo: "DEMO" });
  t.after(() => close(value));
  assert.equal((await fetch(value.url + "/")).status, 200);
  assert.equal(await (await fetch(value.url + "/")).text(), "MARKETING");
  assert.equal(await (await fetch(value.url + "/", { headers: { cookie: "signed=1" } })).text(), "APP");
  assert.equal(await (await fetch(value.url + "/pricing")).text(), "PRICE");
});

test("app-only root uses login page and excludes marketing routes", async t => {
  const value = await server(true, { index: "APP", enter: "LOGIN", home: "SECRET MARKETING", "pricing.html": "SECRET PRICING", "pricing.js": "SECRET SCRIPT", "demo.js": "SECRET DEMO", "demo/shot": "SECRET SHOT", "distribution.json": '{"edition":"community"}' });
  t.after(() => close(value));
  assert.equal(await (await fetch(value.url + "/")).text(), "LOGIN");
  assert.equal(await (await fetch(value.url + "/", { headers: { cookie: "signed=1" } })).text(), "APP");
  assert.equal((await fetch(value.url + "/pricing")).status, 404);
  assert.equal((await fetch(value.url + "/demo.html")).status, 404);
  assert.equal((await fetch(value.url + "/home.html")).status, 404);
  assert.equal((await fetch(value.url + "/pricing.html")).status, 404);
  assert.equal((await fetch(value.url + "/pricing.js")).status, 404);
  assert.equal((await fetch(value.url + "/demo.js")).status, 404);
  assert.equal((await fetch(value.url + "/demo/shot")).status, 404);
});

test("app-only unknown paths serve the app, but missing app assets are 404", async t => {
  const value = await server(true, { index: "APP", "distribution.json": '{"edition":"community"}' });
  t.after(() => close(value));
  assert.equal(await (await fetch(value.url + "/w/company/chat")).text(), "APP");
  assert.equal((await fetch(value.url + "/privacy")).status, 404);
});

test("community source points to the configured version and invalid markers fail", async t => {
  const value = await server(true, { index: "APP", about: "LICENSE AND SOURCE", "distribution.json": '{"edition":"community","sourceUrl":"https://example.test/source","license":"AGPL-3.0-only"}' });
  t.after(() => close(value));
  const response = await fetch(value.url + "/source", { redirect: "manual" });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "https://example.test/source");
  assert.equal(await (await fetch(value.url + "/about")).text(), "LICENSE AND SOURCE");
  assert.equal(readDistribution(value.root, { env: { PUBLIC_SOURCE_URL: "https://example.test/modified" } }).sourceUrl, "https://example.test/modified");
  assert.throws(() => readDistribution(value.root, { env: { PUBLIC_SOURCE_URL: "javascript:alert(1)" } }));
  await fs.writeFile(path.join(value.root, "dist/distribution.json"), "{broken");
  assert.throws(() => readDistribution(value.root));
});
