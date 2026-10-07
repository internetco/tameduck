// Copied from shared/help-guides.mjs by scripts/build-help.mjs. Edit that file.
// The Help guides' small text format, search over the guides, and which guide
// belongs to which screen of the app. One copy serves both readers: the in-app
// Help panel imports it, and scripts/build-help.mjs copies it next to the Help
// pages as /help/help-guides.js, so a word found on one is found on the other.

// Guide text is plain text with three marks:
//   **Saved**              words to notice
//   [[Create ticket]]      a control on the screen, drawn like a button
//   [the board guide](/help/task-board#step-4)   a link to Help
const MARKS = /\*\*(.+?)\*\*|\[\[(.+?)\]\]|\[([^\]]+)\]\(([^)\s]+)\)/g;

/** Guide text as pieces: { kind: "text" | "strong" | "ui" | "link", text, href }. */
export function richText(text) {
  const pieces = [];
  let at = 0;
  for (const m of String(text ?? "").matchAll(MARKS)) {
    if (m.index > at) pieces.push({ kind: "text", text: text.slice(at, m.index) });
    if (m[1] !== undefined) pieces.push({ kind: "strong", text: m[1] });
    else if (m[2] !== undefined) pieces.push({ kind: "ui", text: m[2] });
    // Only links to Help itself: guide text never sends anybody elsewhere.
    else if (/^(\/help(\/[a-z-]+)?(#step-\d+)?|#step-\d+)$/.test(m[4]))
      pieces.push({ kind: "link", text: m[3], href: m[4] });
    else pieces.push({ kind: "text", text: m[3] });
    at = m.index + m[0].length;
  }
  if (at < String(text ?? "").length) pieces.push({ kind: "text", text: text.slice(at) });
  return pieces;
}

/** Guide text without its marks. */
export const plainText = (text) => richText(text).map((p) => p.text).join("");

const words = (text) =>
  plainText(text).toLocaleLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);

const termsOf = (query) =>
  String(query ?? "").toLocaleLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);

// Every typed word has to start a word of the text: "add du" finds
// "Add a duck", and "key" finds "keys" but not "monkey".
const finds = (terms, text) => {
  const have = words(text);
  return terms.every((term) => have.some((word) => word.startsWith(term)));
};

const bodyText = (step) =>
  [step.do, step.more, ...(step.list ?? []), step.note, step.warn, step.example].filter(Boolean).join(" ");
const stepText = (step) => [step.title, step.nav, bodyText(step)].filter(Boolean).join(" ");

/** The sentence a search word was found in, for a step found by its text. */
function snippet(step, terms) {
  const sentences = plainText(bodyText(step)).split(/(?<=[.!?:])\s+/);
  const hit = sentences.find((s) => terms.some((t) => words(s).some((w) => w.startsWith(t))));
  if (!hit) return "";
  return hit.length > 90 ? hit.slice(0, 88).replace(/\s+\S*$/, "") + "…" : hit;
}

/**
 * Steps and guides that match what somebody typed. Steps whose title matches
 * come first: they are the answer. Then steps that mention it, with the
 * sentence they mention it in, then whole guides.
 */
export function searchHelp(guides, query, { steps: maxSteps = 5, guides: maxGuides = 3 } = {}) {
  const terms = termsOf(query);
  if (!terms.length) return { terms, steps: [], guides: [] };
  const named = [];
  const mentioned = [];
  for (const guide of guides) {
    guide.steps.forEach((step, index) => {
      const found = { guide, step, index, number: index + 1 };
      if (finds(terms, [step.title, step.nav].join(" "))) named.push(found);
      else if (finds(terms, stepText(step))) mentioned.push({ ...found, snippet: snippet(step, terms) });
    });
  }
  const found = guides.filter((g) =>
    finds(terms, [g.title, g.nav, g.card, g.summary, ...(g.tags ?? [])].join(" ")),
  );
  return { terms, steps: [...named, ...mentioned].slice(0, maxSteps), guides: found.slice(0, maxGuides) };
}

/** Text split where the search words start, so a reader can mark them. */
export function highlight(text, terms) {
  const plain = plainText(text);
  if (!terms?.length) return [{ text: plain, hit: false }];
  const parts = [];
  let at = 0;
  for (const m of plain.matchAll(/[\p{L}\p{N}]+/gu)) {
    const word = m[0].toLocaleLowerCase();
    const term = terms.filter((t) => word.startsWith(t)).sort((a, b) => b.length - a.length)[0];
    if (!term) continue;
    if (m.index > at) parts.push({ text: plain.slice(at, m.index), hit: false });
    parts.push({ text: plain.slice(m.index, m.index + term.length), hit: true });
    at = m.index + term.length;
  }
  if (at < plain.length) parts.push({ text: plain.slice(at), hit: false });
  return parts;
}

/**
 * Where a screenshot sits in its frame and where its rings and numbers go, in
 * percent of the part that is shown, so they stay on their buttons at any
 * size. A screenshot can be cut to a band (crop: { top, height }, in pixels).
 * A ring's number sits to its left, to its right, or on its top-right corner.
 *
 * focus: show only the part around the rings. The in-app panel is too narrow
 * to show a whole wide screen legibly, so it shows where to click instead.
 */
export function shotLayout(image, { focus = false } = {}) {
  const pc = (n) => +n.toFixed(3);
  const marks = image.marks ?? [];
  const band = { x: 0, y: image.crop?.top ?? 0, w: image.width, h: image.crop?.height ?? image.height };
  let r = band;
  if (focus && marks.length) {
    const x0 = Math.min(...marks.map((m) => m.x));
    const x1 = Math.max(...marks.map((m) => m.x + m.w));
    const y0 = Math.min(...marks.map((m) => m.y));
    const y1 = Math.max(...marks.map((m) => m.y + m.h));
    // Room for the numbers beside the rings, and not so close that the
    // screen around them is lost.
    const w = Math.min(band.w, Math.max(x1 - x0 + 96, 420));
    const h = Math.min(band.h, Math.max(y1 - y0 + 72, w * 0.45));
    const x = Math.min(Math.max(band.x, (x0 + x1) / 2 - w / 2), band.x + band.w - w);
    const y = Math.min(Math.max(band.y, (y0 + y1) / 2 - h / 2), band.y + band.h - h);
    r = { x, y, w, h };
  }
  return {
    cropped: r.x !== 0 || r.y !== 0 || r.w !== image.width || r.h !== image.height,
    ratio: `${pc(r.w)} / ${pc(r.h)}`,
    picture: {
      width: pc((image.width / r.w) * 100),
      left: pc((-r.x / r.w) * 100),
      top: pc((-r.y / r.h) * 100),
    },
    numbered: marks.some((m) => m.label),
    marks: marks.map((m, i) => {
      const side = m.badge || (m.x > 40 ? "left" : "right");
      return {
        n: i + 1,
        label: m.label,
        side,
        ring: {
          left: pc(((m.x - r.x) / r.w) * 100),
          top: pc(((m.y - r.y) / r.h) * 100),
          width: pc((m.w / r.w) * 100),
          height: pc((m.h / r.h) * 100),
        },
        badge: {
          left: pc((((side === "left" ? m.x : m.x + m.w) - r.x) / r.w) * 100),
          top: pc((((side === "corner" ? m.y : m.y + m.h / 2) - r.y) / r.h) * 100),
        },
      };
    }),
  };
}

// The guide for the screen somebody is on, by the app's own view names.
const SCREENS = {
  inbox: "needs-you",
  tasks: "task-board",
  files: "files",
  computers: "computers",
  team: "team",
  chat: "first-task",
};

/** The guide id for an app view ({ type, tab }), or null when none fits. */
export function guideForView(view) {
  if (view?.type === "settings") return view.tab === "ai" ? "connect-ai" : null;
  return SCREENS[view?.type] ?? null;
}
