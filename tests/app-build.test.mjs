import { test } from "node:test";
import assert from "node:assert/strict";
import { appEntryFromHtml, appUpdateAvailable } from "../shared/app-build.mjs";

test("deployment detection identifies the module entry rather than unrelated assets", () => {
  const html = `<link rel="stylesheet" href="/assets/app-old.css"><script src="/analytics.js"></script><script crossorigin src='/assets/index-new.js' type='module'></script>`;
  assert.equal(appEntryFromHtml(html), "/assets/index-new.js");
  assert.equal(appEntryFromHtml(`<script type="module" src="/src/main.jsx"></script>`), null);
  assert.equal(appEntryFromHtml(""), null);
});

test("update notice needs two known different production entries and clears after refresh", () => {
  assert.equal(appUpdateAvailable("/assets/index-old.js", "/assets/index-new.js"), true);
  assert.equal(appUpdateAvailable("https://staging.tameduck.com/assets/index-new.js", "/assets/index-new.js"), false);
  assert.equal(appUpdateAvailable("/assets/index-old.js", null), false);
  assert.equal(appUpdateAvailable(null, "/assets/index-new.js"), false);
  assert.equal(appUpdateAvailable("/src/main.jsx", "/assets/index-new.js"), false);
});
