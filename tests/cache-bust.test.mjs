import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bust, bustHtml, bustDist, stampOf } from "../scripts/cache-bust.mjs";

const S = "20261007182933";

test("the stamp is the build's time, UTC, to the second", () => {
  assert.equal(stampOf(new Date("2026-10-07T18:29:33.456Z")), S);
});

test("assets on this site get the stamp; pages, other sites and Vite's own files do not", () => {
  assert.equal(bust("/pricing.js", S), `/pricing.js?v=${S}`);
  assert.equal(bust("/media/tameduck-intro-cover.png", S), `/media/tameduck-intro-cover.png?v=${S}`);
  assert.equal(bust("/fonts/outfit-latin-wght-normal.woff2", S), `/fonts/outfit-latin-wght-normal.woff2?v=${S}`);
  // Relative, as on a help page.
  assert.equal(bust("help.css", S), `help.css?v=${S}`);
  // A version written by hand gives way to the build's.
  assert.equal(bust("/auth.js?v=browser-code-2", S), `/auth.js?v=${S}`);
  // Other query and the anchor stay.
  assert.equal(bust("/brand/icons.svg?mode=dark#duck", S), `/brand/icons.svg?mode=dark&v=${S}#duck`);
  for (const same of [
    "/pricing",
    "/help/files",
    "/",
    "#intro-video",
    "https://tameduck.com/brand/mark.png",
    "//cdn.example.test/x.js",
    "data:image/png;base64,AAAA",
    "mailto:info@tameduck.com",
    "/assets/index-Ab12Cd34.js",
    "/assets/index-Ef56Gh78.css",
    "/downloads/TameDuck.dmg",
    "",
  ])
    assert.equal(bust(same, S), same, JSON.stringify(same));
});

test("a page's own asks are stamped: scripts, styles, pictures, video, srcset and url()", () => {
  const html = `<link rel="stylesheet" href="/desktop-downloads.css"><link rel="icon" href="/brand/mark.svg">
<script src="/pricing.js" defer></script><script type="module" crossorigin src="/assets/index-Ab12Cd34.js"></script>
<a href="/start">Try it</a> <a href="https://github.com/internetco/tameduck">Code</a>
<video poster="/media/cover.png"><source src="/media/intro.mp4" type="video/mp4"></video>
<img srcset="/brand/duck.png 1x, /brand/duck@2x.png 2x" src='/brand/duck.png' alt="">
<div style="background:url('/brand/bg.webp')"></div><style>@font-face{src:url(/fonts/o.woff2) format("woff2")}</style>`;
  const out = bustHtml(html, S);
  for (const asked of [
    `href="/desktop-downloads.css?v=${S}"`,
    `href="/brand/mark.svg?v=${S}"`,
    `src="/pricing.js?v=${S}"`,
    `poster="/media/cover.png?v=${S}"`,
    `src="/media/intro.mp4?v=${S}"`,
    `src='/brand/duck.png?v=${S}'`,
    `srcset="/brand/duck.png?v=${S} 1x, /brand/duck@2x.png?v=${S} 2x"`,
    `url('/brand/bg.webp?v=${S}')`,
    `url(/fonts/o.woff2?v=${S})`,
  ])
    assert.ok(out.includes(asked), asked);
  for (const kept of ['src="/assets/index-Ab12Cd34.js"', 'href="/start"', 'href="https://github.com/internetco/tameduck"'])
    assert.ok(out.includes(kept), kept);
  // A second build puts its own stamp in place of the first, not beside it.
  assert.equal(bustHtml(out, "20261008090000"), bustHtml(html, "20261008090000"));
});

test("every page and stylesheet in dist is stamped, and nothing else is touched", (t) => {
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), "tameduck-bust-"));
  t.after(() => fs.rmSync(dist, { recursive: true, force: true }));
  const put = (file, body) => {
    fs.mkdirSync(path.dirname(path.join(dist, file)), { recursive: true });
    fs.writeFileSync(path.join(dist, file), body);
  };
  const read = (file) => fs.readFileSync(path.join(dist, file), "utf8");
  put("pricing.html", '<script src="/pricing.js"></script>');
  put("help/index.html", '<link rel="stylesheet" href="help.css">');
  put("assets/index-Ab12Cd34.css", "a{background:url(/brand/bg.png)}");
  put("pricing.js", 'const intro = "/media/intro.mp4";');
  put("about.html", '<a href="/pricing">Pricing</a>');
  assert.equal(bustDist(dist, S), 3);
  assert.equal(read("pricing.html"), `<script src="/pricing.js?v=${S}"></script>`);
  assert.equal(read("help/index.html"), `<link rel="stylesheet" href="help.css?v=${S}">`);
  assert.equal(read("assets/index-Ab12Cd34.css"), `a{background:url(/brand/bg.png?v=${S})}`);
  assert.equal(read("pricing.js"), 'const intro = "/media/intro.mp4";');
  assert.equal(read("about.html"), '<a href="/pricing">Pricing</a>');
});
