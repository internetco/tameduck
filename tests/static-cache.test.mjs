import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import express from "express";
import { cacheHeadersFor } from "../server/static-cache.mjs";

test("scripts without a build hash are asked about every time, the rest kept as before", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tameduck-cache-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dist = path.join(root, "dist");
  for (const file of ["pricing.js", "theme.js", "desktop-downloads.css", "auth.js", "analytics.js", "login.html", "index.html", "assets/index-Ab12Cd34.js", "media/intro.mp4", "help/help.js"]) {
    fs.mkdirSync(path.dirname(path.join(dist, file)), { recursive: true });
    fs.writeFileSync(path.join(dist, file), "x");
  }
  const app = express();
  app.use(express.static(dist, { index: false, maxAge: "1h", setHeaders: cacheHeadersFor(root) }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  t.after(() => server.close());
  const base = "http://127.0.0.1:" + server.address().port;
  const cache = async (file) => (await fetch(base + "/" + file)).headers.get("cache-control");

  // The pricing page's own script: kept, but checked, so a release shows at once.
  assert.equal(await cache("pricing.js"), "no-cache");
  assert.equal(await cache("theme.js"), "no-cache");
  assert.equal(await cache("desktop-downloads.css"), "no-cache");
  // Still never kept.
  assert.equal(await cache("auth.js"), "no-store");
  assert.equal(await cache("analytics.js"), "no-store");
  assert.equal(await cache("login.html"), "no-store");
  assert.equal(await cache("index.html"), "public, max-age=0");
  // Hashed assets and media keep their hour; a folder's scripts are its own business.
  assert.equal(await cache("assets/index-Ab12Cd34.js"), "public, max-age=3600");
  assert.equal(await cache("media/intro.mp4"), "public, max-age=3600");
  assert.equal(await cache("help/help.js"), "public, max-age=3600");
  // Asked again with what it has, a browser is told nothing changed. (Not with
  // fetch: a conditional fetch adds Cache-Control: no-cache to the request, as
  // the standard says, and a server must answer that in full.)
  const etag = (await fetch(base + "/pricing.js")).headers.get("etag");
  const again = await new Promise((resolve, reject) =>
    http
      .get(base + "/pricing.js", { headers: { "If-None-Match": etag } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      })
      .on("error", reject),
  );
  assert.equal(again, 304);
});
