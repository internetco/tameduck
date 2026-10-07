// Builds the Help pages from public/help/guides.json.
//
//   node scripts/build-help.mjs           write public/help/*.html and help-guides.js
//   node scripts/build-help.mjs --check   say which of them are out of date
//
// guides.json is the one place a guide is written. The in-app Help panel
// reads it as it is, and this script turns it into the Help home and one page
// per guide, so the two can never say different things. Edit the JSON, run
// this, and commit both. The pages are plain HTML with no inline script: the
// site's security policy only runs scripts from files.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { plainText, richText, shotLayout } from "../shared/help-guides.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const helpDir = path.join(root, "public", "help");
const publicDir = path.join(root, "public");
const distributionFile = path.join(publicDir, "distribution.json");
const communityEdition = fs.existsSync(distributionFile) &&
  JSON.parse(fs.readFileSync(distributionFile, "utf8")).edition === "community";

const GROUPS = { start: "Start here", everyday: "Everyday work" };
const CONTACT = "info@tameduck.com";

// Shortcuts under the search box on the Help home: a few things people come
// for most, each straight to the step that does it.
const POPULAR = [
  ["Connect ChatGPT", "connect-ai", 2],
  ["Add a duck", "create-first-duck", 1],
  ["Approve a request", "needs-you", 5],
  ["Invite a teammate", "team", 4],
  ["Start a computer", "computers", 2],
];

// Lucide's outlines, the same set the app draws with, so a guide carries the
// icon of its place in the app's sidebar.
const ICONS = {
  plug: '<path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/><path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z"/>',
  duck: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" x2="19" y1="8" y2="14"/><line x1="22" x2="16" y1="11" y2="11"/>',
  chat: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  inbox: '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
  board: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/><path d="M15 3v18"/>',
  files: '<path d="M20 7h-3a2 2 0 0 1-2-2V2"/><path d="M9 18a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h7l4 4v10a2 2 0 0 1-2 2Z"/><path d="M3 7.6v12.8A1.6 1.6 0 0 0 4.6 22h9.8"/>',
  monitor: '<rect width="20" height="14" x="2" y="3" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  webhook: '<path d="M18 16.98h-5.99c-1.1 0-1.95.94-2.48 1.9A4 4 0 0 1 2 17c.01-.7.2-1.4.57-2"/><path d="m6 17 3.13-5.78c.53-.97.1-2.18-.5-3.1a4 4 0 1 1 6.89-4.06"/><path d="m12 6 3.13 5.73C15.66 12.7 16.9 13 18 13a4 4 0 0 1 0 8"/>',
  arrow: '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
  back: '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
  chevron: '<path d="m9 18 6-6-6-6"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  steps: '<path d="M3 12h.01"/><path d="M3 18h.01"/><path d="M3 6h.01"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M8 6h13"/>',
  checked: '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  bulb: '<path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/>',
  warn: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  pin: '<path d="M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0"/><circle cx="12" cy="10" r="3"/>',
  zoom: '<polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" x2="14" y1="3" y2="10"/><line x1="3" x2="10" y1="21" y2="14"/>',
  mail: '<rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>',
  up: '<path d="M7 10v12"/><path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z"/>',
  down: '<path d="M17 14V2"/><path d="M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L12 22a3.13 3.13 0 0 1-3-3.88Z"/>',
};
const icon = (name, size = 20, cls = "icon") =>
  `<svg class="${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;

const esc = (value) =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

/** Guide text with its marks as HTML. */
const rich = (text) =>
  richText(text)
    .map((p) =>
      p.kind === "strong" ? `<strong>${esc(p.text)}</strong>`
      : p.kind === "ui" ? `<b class="ui">${esc(p.text)}</b>`
      : p.kind === "link" ? `<a href="${esc(p.href)}">${esc(p.text)}</a>`
      : esc(p.text),
    )
    .join("");

const longDate = (iso) =>
  new Date(iso + "T12:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
const stepLabel = (step) => step.nav || step.title;
const thumbOf = (guide) => guide.steps.find((s) => s.image)?.image;

// ---- checks -----------------------------------------------------------------

function pngSize(file) {
  const head = fs.readFileSync(file).subarray(0, 24);
  if (head.toString("ascii", 1, 4) !== "PNG") throw new Error(`${file} is not a PNG`);
  return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
}

/** Every way guides.json can be wrong, with where. Empty when it is right. */
export function problems(guides) {
  const out = [];
  const say = (where, what) => out.push(`${where}: ${what}`);
  const texts = (where, values) => {
    for (const value of values.filter((v) => v !== undefined)) {
      if (typeof value !== "string" || !value.trim()) say(where, "empty text");
      else if (/\]\(/.test(value) && richText(value).every((p) => p.kind !== "link"))
        say(where, `a link that is not to Help: ${value}`);
      else if (/\*\*|\[\[|\]\]/.test(plainText(value))) say(where, `unclosed mark: ${value}`);
    }
  };
  if (!Array.isArray(guides) || !guides.length) return ["guides.json: no guides"];
  const ids = new Set();
  for (const g of guides) {
    const at = g.id || "a guide";
    if (!/^[a-z]+(-[a-z]+)*$/.test(g.id ?? "")) say(at, "id must be lower-case words with dashes");
    if (ids.has(g.id)) say(at, "id used twice");
    ids.add(g.id);
    for (const key of ["title", "nav", "card", "summary"]) if (!g[key]?.trim?.()) say(at, `no ${key}`);
    if (!GROUPS[g.group]) say(at, `group must be one of ${Object.keys(GROUPS).join(", ")}`);
    if (!ICONS[g.icon]) say(at, `unknown icon ${g.icon}`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(g.checked ?? "")) say(at, "checked must be a date like 2026-10-05");
    if (!Array.isArray(g.tags) || !g.tags.length) say(at, "no search tags");
    if (!Array.isArray(g.steps) || !g.steps.length) { say(at, "no steps"); continue; }
    for (const n of g.quick ?? []) if (!g.steps[n - 1]) say(at, `quick step ${n} does not exist`);
    texts(at, [g.card, g.summary, g.done, ...(g.before?.items ?? []), g.before?.where]);
    g.steps.forEach((s, i) => {
      const where = `${at} step ${i + 1}`;
      if (!s.title?.trim()) say(where, "no title");
      if (!s.do?.trim()) say(where, "no instruction (do)");
      texts(where, [s.title, s.nav, s.do, s.more, s.note, s.warn, s.example, ...(s.list ?? [])]);
      const img = s.image;
      if (!img) return;
      if (!/^\/help\/screenshots\/[a-z0-9-]+\.png$/.test(img.src ?? "")) return say(where, `screenshot path ${img.src}`);
      const file = path.join(publicDir, img.src);
      if (!fs.existsSync(file)) return say(where, `missing ${img.src}`);
      const real = pngSize(file);
      if (real.width !== img.width || real.height !== img.height)
        say(where, `${img.src} is ${real.width}×${real.height}, not ${img.width}×${img.height}`);
      if (!img.alt?.trim()) say(where, "screenshot has no alt text");
      const top = img.crop?.top ?? 0;
      const tall = img.crop?.height ?? img.height;
      if (top < 0 || tall <= 0 || top + tall > img.height) say(where, "crop is outside the screenshot");
      const marks = img.marks ?? [];
      const labelled = marks.filter((m) => m.label).length;
      if (labelled && labelled !== marks.length) say(where, "label every mark or none");
      if (!labelled && !img.caption) say(where, "a screenshot needs a caption or labelled marks");
      for (const m of marks) {
        if (m.x < 0 || m.w <= 0 || m.x + m.w > img.width || m.y < top || m.h <= 0 || m.y + m.h > top + tall)
          say(where, `mark ${JSON.stringify(m)} is outside the shown screenshot`);
        if (m.badge && !["left", "right", "corner"].includes(m.badge)) say(where, `badge ${m.badge}`);
      }
    });
  }
  for (const [, id, n] of POPULAR) if (!guides.find((g) => g.id === id)?.steps[n - 1]) say("popular", `${id} step ${n}`);
  return out;
}

// ---- pieces -------------------------------------------------------------------

const head = ({ title, description }) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta name="theme-color" content="#FBF8F1">
<link rel="icon" href="/favicon.svg">
<link rel="stylesheet" href="/help/help.css">
</head>`;

const searchForm = ({ id, size }) => `<form class="search search-${size}" id="${id}" role="search" action="/help" data-search>
<label class="search-box">${icon("search", size === "lg" ? 22 : 18, "icon search-icon")}<span class="sr-only">Search help</span><input type="search" name="q" placeholder="${size === "lg" ? "Try “add a duck” or “API key”" : "Search help"}" autocomplete="off" spellcheck="false" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="${id}-results"><kbd aria-hidden="true">/</kbd></label>
<div class="search-results" id="${id}-results" role="listbox" aria-label="Search results" hidden></div>
</form>`;

const header = ({ hub, community }) => `<a class="skip" href="#content">Skip to ${hub ? "the guides" : "the guide"}</a>
<header class="site-header">
<div class="wrap nav">
<a class="brand" href="/"><img class="brand-tile" src="/brand/mark.svg" width="36" height="36" alt=""><span class="brand-name">TameDuck</span></a>
<a class="help-tag" href="/help"${hub ? ' aria-current="page"' : ""}><span class="sr-only">TameDuck </span>Help</a>
${hub ? "" : `<button class="search-toggle" type="button" aria-label="Search help" aria-expanded="false" aria-controls="header-search">${icon("search", 19)}</button>
${searchForm({ id: "header-search", size: "sm" })}
`}<nav class="nav-right" aria-label="Main">
${community ? '<a href="https://tameduck.com">TameDuck Cloud</a>' : '<a href="/pricing">Pricing</a>'}<a href="/help" aria-current="${hub ? "page" : "true"}">Help</a>
<a href="/login">Sign in</a>
<a class="btn" href="${community ? "/" : "/start"}">${community ? "Open TameDuck" : "Try it for &euro;1"} ${icon("arrow", 17)}</a>
</nav>
</div>
</header>`;

const footer = ({ community }) => `<footer class="site-footer">
<div class="wrap">
<div class="footer-grid">
<div class="footer-about"><span class="footer-brand"><img class="brand-tile" src="/brand/mark.svg" width="34" height="34" alt=""><span>TameDuck</span></span><p>A company workspace where the AI teammates have faces, memories, and computers of their own.</p></div>
<nav class="footer-cols" aria-label="Footer">
${community ? '<div class="footer-col"><span class="footer-head">TameDuck</span><a href="/">Open the app</a><a href="/about">About</a><a href="https://tameduck.com">TameDuck Cloud</a></div>' : '<div class="footer-col"><span class="footer-head">Product</span><a href="/#flock">The flock</a><a href="/#computer">Its own computer</a><a href="/#handover">The handover</a><a href="/#board">The board</a><a href="/#control">Needs you</a></div>'}
<div class="footer-col"><span class="footer-head">Company</span>${community ? "" : '<a href="/pricing">Pricing</a>'}<a class="here" href="/help">Help</a><a href="/privacy">Privacy</a><a href="/terms">Terms</a><a href="mailto:${CONTACT}">Contact</a><a href="https://github.com/internetco/tameduck" target="_blank" rel="noopener noreferrer">Open source ↗</a></div>
</nav>
</div>
<div class="footer-bottom"><span>Some of your teammates are ducks.</span><span>tameduck.com · © 2026 TameDuck</span></div>
</div>
</footer>`;

/** A screenshot, cropped to what matters, with rings on what to click. */
function figure(img) {
  const shot = shotLayout(img);
  const rings = shot.marks.map((m) =>
    `<span class="mark" style="left:${m.ring.left}%;top:${m.ring.top}%;width:${m.ring.width}%;height:${m.ring.height}%"></span>` +
    (shot.numbered ? `<span class="mark-num at-${m.side}" style="left:${m.badge.left}%;top:${m.badge.top}%">${m.n}</span>` : ""),
  ).join("");
  const legend = shot.numbered
    ? shot.marks.map((m) => `<span class="legend"><span class="mark-num">${m.n}</span>${esc(m.label)}</span>`).join("")
    : `<span class="caption">${esc(img.caption)}</span>`;
  return `<figure class="shot">
<div class="shot-frame${shot.cropped ? " is-cropped" : ""}" style="width:${img.width}px;aspect-ratio:${shot.ratio}"><img src="${img.src}" width="${img.width}" height="${img.height}" alt="${esc(img.alt)}" loading="lazy"${shot.cropped ? ` style="top:${shot.picture.top}%"` : ""}>${rings}</div>
<figcaption>${legend}<button class="zoom" type="button" data-zoom="${img.src}" data-alt="${esc(img.alt)}">${icon("zoom", 14)}Enlarge</button></figcaption>
</figure>`;
}

function stepHtml(step, i, last) {
  const n = i + 1;
  return `<li class="step${last ? " is-last" : ""}" id="step-${n}">
<div class="step-rail" aria-hidden="true"><span class="step-num">${n}</span></div>
<div class="step-body">
<h2><span class="sr-only">Step ${n}: </span>${esc(step.title)}</h2>
<p class="do">${rich(step.do)}</p>
${step.more ? `<p class="more">${rich(step.more)}</p>\n` : ""}${step.list ? `<ul class="step-list">${step.list.map((item) => `<li>${rich(item)}</li>`).join("")}</ul>\n` : ""}${step.example ? `<blockquote class="example"><p class="example-label">For example</p><p>“${rich(step.example)}”</p></blockquote>\n` : ""}${step.image ? figure(step.image) + "\n" : ""}${step.warn ? `<aside class="warn">${icon("warn")}<p><strong>Watch out.</strong> ${rich(step.warn)}</p></aside>\n` : ""}${step.note ? `<aside class="note">${icon("bulb")}<p><strong>Good to know.</strong> ${rich(step.note)}</p></aside>\n` : ""}</div>
</li>`;
}

function nav(guides, current) {
  const groups = Object.entries(GROUPS).map(([group, name]) => {
    const items = guides.filter((g) => g.group === group).map((g, i) => {
      const here = g.id === current.id;
      const mark = group === "start" ? `<span class="nav-num">${i + 1}</span>` : icon(g.icon, 19);
      const steps = here
        ? `<ol class="nav-steps">${g.steps.map((s, j) => `<li><a href="#step-${j + 1}" data-step="${j + 1}">${esc(stepLabel(s))}</a></li>`).join("")}</ol>`
        : "";
      return `<li><a class="nav-guide" href="/help/${g.id}"${here ? ' aria-current="page"' : ""}>${mark}<span>${esc(g.nav)}</span></a>${steps}</li>`;
    });
    return `<p class="nav-group">${name}</p>\n<ol class="nav-guides">${items.join("")}</ol>`;
  });
  return `<nav class="guide-nav" aria-label="Help guides">
<a class="back" href="/help">${icon("back", 16)}All guides</a>
${groups.join("\n")}
<p class="nav-stuck"><strong>Still stuck?</strong> <a href="mailto:${CONTACT}">Email ${CONTACT}</a></p>
</nav>`;
}

function guidePage(guides, guide, community) {
  const index = guides.indexOf(guide);
  const inGroup = guides.filter((g) => g.group === guide.group);
  const place = guide.group === "start" ? ` · Guide ${inGroup.indexOf(guide) + 1} of ${inGroup.length}` : "";
  const next = guides[index + 1];
  const nextInStart = next?.group === "start" ? ` · Guide ${guides.filter((g) => g.group === "start").indexOf(next) + 1} of ${inGroup.length}` : "";
  const thumb = next && thumbOf(next);
  const before = guide.before ? `<section class="before" aria-label="Before you start">
<h2>${esc(guide.before.title)}</h2>
<ul>${guide.before.items.map((item) => `<li>${icon("checked")}<span>${rich(item)}</span></li>`).join("")}</ul>
${guide.before.where ? `<p class="where">${icon("pin", 18)}<span>${rich(guide.before.where)}</span></p>\n` : ""}</section>
` : "";
  const upNext = next
    ? `<a class="next" href="/help/${next.id}">${thumb ? `<img src="${thumb.src}" alt="" width="${thumb.width}" height="${thumb.height}" loading="lazy">` : ""}<span class="next-text"><span class="next-eyebrow">Up next${nextInStart}</span><span class="next-title">${esc(next.title)}</span><span class="next-card">${esc(next.card)} ${next.steps.length} steps.</span></span><span class="next-go">${icon("arrow", 22)}</span></a>`
    : `<a class="next" href="/help"><span class="next-text"><span class="next-eyebrow">That was the last guide</span><span class="next-title">See all guides</span></span><span class="next-go">${icon("arrow", 22)}</span></a>`;
  return `${head({ title: `${guide.title} — TameDuck Help`, description: guide.summary })}
<body class="guide-page">
${header({ hub: false, community })}
<div class="wrap guide-layout">
${nav(guides, guide)}
<main id="content" class="guide-main">
<p class="crumbs"><a href="/help">Help</a>${icon("chevron", 14)}<span>${GROUPS[guide.group]}${place}</span></p>
<h1>${esc(guide.title)}</h1>
<p class="lead">${rich(guide.summary)}</p>
<p class="meta"><span>${icon("steps", 16)}${guide.steps.length} steps</span><span>${icon("checked", 16)}Checked against the app on ${longDate(guide.checked)}</span></p>
<nav class="step-strip" aria-label="Steps in this guide"><span>Step</span>${guide.steps.map((s, i) => `<a href="#step-${i + 1}" data-step="${i + 1}" aria-label="Step ${i + 1}: ${esc(stepLabel(s))}">${i + 1}</a>`).join("")}</nav>
${before}<ol class="steps">
${guide.steps.map((s, i) => stepHtml(s, i, i === guide.steps.length - 1)).join("\n")}
</ol>
<section class="done" aria-labelledby="done-title">
<p class="done-head" id="done-title">${icon("check", 19, "icon done-check")}${esc(guide.done || "That’s it.")}</p>
${upNext}
</section>
<div class="after">
<div class="feedback" data-feedback><span class="feedback-q">Did this guide help?</span><button type="button" data-answer="yes">${icon("up", 17)}Yes</button><button type="button" data-answer="no">${icon("down", 17)}Not really</button><p class="feedback-thanks" data-thanks="yes" hidden>Thanks for telling us.</p><p class="feedback-thanks" data-thanks="no" hidden>Sorry it didn’t. Tell us what was missing at <a href="mailto:${CONTACT}">${CONTACT}</a> and we’ll fix the guide.</p></div>
<a class="stuck-link" href="mailto:${CONTACT}">${icon("mail", 18)}Still stuck? Email ${CONTACT}</a>
</div>
</main>
</div>
${footer({ community })}
<dialog class="zoom-dialog" aria-label="Screenshot">
<form method="dialog" class="zoom-bar"><span class="zoom-caption"></span><button type="submit">Close</button></form>
<img class="zoom-img" alt="">
</dialog>
<script type="module" src="/help/help-search.js"></script>
<script src="/help/help-guide.js" defer></script>
</body>
</html>
`;
}

function hubPage(guides, community) {
  const ducks = ["02-royal", "04-space", "07-chef", "08-detective", "13-builder"]
    .map((d) => `<img src="/avatars/transparent-v1/${d}-duck-256.webp" width="256" height="256" alt="">`).join("");
  const start = guides.filter((g) => g.group === "start").map((g, i) => {
    const t = thumbOf(g);
    return `<li><a class="start-card" href="/help/${g.id}">
<span class="start-shot">${t ? `<img src="${t.src}" width="${t.width}" height="${t.height}" alt="" loading="lazy">` : ""}</span>
<span class="start-body"><span class="start-top"><span class="num">${i + 1}</span><span class="count">${g.steps.length} steps</span>${icon("arrow", 20)}</span><span class="start-title">${esc(g.title)}</span><span class="start-text">${esc(g.card)}</span></span>
</a></li>`;
  }).join("\n");
  const everyday = guides.filter((g) => g.group === "everyday").map((g) => `<a class="guide-card" href="/help/${g.id}"><span class="icon-tile">${icon(g.icon, 24)}</span><span class="guide-card-body"><span class="guide-card-title">${esc(g.title)}</span><span class="guide-card-text">${esc(g.card)}</span><span class="count">${g.steps.length} steps</span></span></a>`).join("\n");
  const popular = POPULAR.map(([label, id, n]) => `<a class="chip" href="/help/${id}${n > 1 ? `#step-${n}` : ""}">${esc(label)}</a>`).join("");
  return `${head({ title: "Help — TameDuck", description: "Short guides with real screenshots for every part of TameDuck: connecting an AI, creating Ducks, tasks, files, computers and your team." })}
<body class="hub-page">
${header({ hub: true, community })}
<main id="content">
<section class="hero">
<div class="ducks" aria-hidden="true">${ducks}<svg class="water" viewBox="0 0 480 30" preserveAspectRatio="none"><path class="water-fill" d="M0 12 Q15 4 30 12 T60 12 T90 12 T120 12 T150 12 T180 12 T210 12 T240 12 T270 12 T300 12 T330 12 T360 12 T390 12 T420 12 T450 12 T480 12 V30 H0 Z"/><path class="water-line" d="M0 12 Q15 4 30 12 T60 12 T90 12 T120 12 T150 12 T180 12 T210 12 T240 12 T270 12 T300 12 T330 12 T360 12 T390 12 T420 12 T450 12 T480 12"/><path class="water-ripple" d="M40 24 Q55 17 70 24 T100 24 T130 24 M300 24 Q315 17 330 24 T360 24 T390 24 T420 24"/></svg></div>
<h1>Get your ducks in a row.</h1>
<p class="hero-lead">Short guides with real screenshots. Search for what you want to do, or start at step one.</p>
${searchForm({ id: "hub-search", size: "lg" })}
<p class="popular"><span>Popular:</span>${popular}</p>
</section>
<section class="section wrap" aria-labelledby="start-title">
<div class="section-head"><h2 id="start-title">New here? Start with these three.</h2><p>From sign-up to your first task, in order.</p></div>
<ol class="start-cards">
${start}
</ol>
</section>
<section class="section wrap" aria-labelledby="everyday-title">
<div class="section-head"><h2 id="everyday-title">Everyday work</h2><p>Each guide has the same icon as its place in the app.</p></div>
<div class="guide-cards">
${everyday}
<div class="stuck-card"><span class="stuck-title">Still stuck?</span><span class="stuck-text">Email us and tell us what you were trying to do.</span><a class="btn" href="mailto:${CONTACT}">${icon("mail", 18)}${CONTACT}</a></div>
</div>
</section>
</main>
${footer({ community })}
<script type="module" src="/help/help-search.js"></script>
</body>
</html>
`;
}

/** Everything this script writes, by name under public/help. */
export function renderHelp(guides, { community = communityEdition } = {}) {
  const files = new Map();
  files.set("index.html", hubPage(guides, community));
  for (const guide of guides) files.set(`${guide.id}.html`, guidePage(guides, guide, community));
  const shared = fs.readFileSync(path.join(root, "shared", "help-guides.mjs"), "utf8");
  files.set("help-guides.js", "// Copied from shared/help-guides.mjs by scripts/build-help.mjs. Edit that file.\n" + shared);
  return files;
}

export function readGuides() {
  return JSON.parse(fs.readFileSync(path.join(helpDir, "guides.json"), "utf8"));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const guides = readGuides();
  const found = problems(guides);
  if (found.length) {
    console.error("guides.json has problems:\n  " + found.join("\n  "));
    process.exit(1);
  }
  const check = process.argv.includes("--check");
  const stale = [];
  for (const [name, body] of renderHelp(guides)) {
    const file = path.join(helpDir, name);
    const now = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
    if (now === body) continue;
    if (check) stale.push(name);
    else fs.writeFileSync(file, body);
  }
  if (check && stale.length) {
    console.error(`Out of date: ${stale.join(", ")}. Run: node scripts/build-help.mjs`);
    process.exit(1);
  }
  console.log(check ? "Help pages are up to date." : "Help pages written.");
}
