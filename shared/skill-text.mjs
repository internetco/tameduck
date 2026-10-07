// A skill's instructions as a person reads them on its page.
//
// A skill from the catalogue is saved with a block TameDuck writes on top of it
// (publisher, source, licence and how to reach its files), and every upstream
// text opens with a name-and-description block written for the software that
// loads it, then its own title again. The page already says all three in
// words, so they are left out and the text starts where the publisher's
// instructions start. Only those lines are left out, and only while they are
// exactly as they were added: a line anybody wrote or changed among them is
// part of what the duck is told, so it shows. What the duck is given is not
// changed by any of this.

// The heading TameDuck's block ends with (server/skill-catalog-data.mjs).
const UPSTREAM = /^## Upstream SKILL\.md[ \t]*$/m;
const FRONT = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
const TITLE = /^# ([^\n]*)(?:\n|$)/;
const skipSpace = (text, at) => {
  const rest = text.slice(at);
  return at + rest.length - rest.trimStart().length;
};

// Where the publisher's own words start in an upstream text: after its
// name-and-description block, and the title under it.
function publisherStart(text, from = 0) {
  let at = skipSpace(text, from);
  const front = FRONT.exec(text.slice(at));
  if (!front) return at;
  at = skipSpace(text, at + front[0].length);
  const title = TITLE.exec(text.slice(at));
  return title ? at + title[0].length : at;
}

// A catalogue skill's text, as the catalogue has it.
export function catalogueText(content) {
  const text = String(content || "");
  return text.slice(publisherStart(text)).trim();
}

// A skill somebody wrote here keeps every line it was given, except a first
// line that only says its name again, and a block on top that holds nothing
// but a name and a description (a SKILL.md file brought in with Import .md).
export function writtenSkillText(content, name = "") {
  let text = String(content || "").trim();
  const front = FRONT.exec(text);
  if (
    front &&
    front[1]
      .split(/\r?\n/)
      .every((line) => !line.trim() || /^(name|description):/.test(line))
  )
    text = text.slice(front[0].length).trim();
  const title = TITLE.exec(text);
  if (
    title &&
    title[1].trim().toLowerCase() === String(name).trim().toLowerCase()
  )
    text = text.slice(title[0].length);
  return text.trim();
}

// Where the publisher's words start in a skill as it was added: after
// TameDuck's block, the Upstream heading, the name-and-description block and
// the title. -1 when the heading is not there.
function addedStart(text) {
  const heading = UPSTREAM.exec(text);
  return heading ? publisherStart(text, heading.index + heading[0].length) : -1;
}

// A skill added from the catalogue, as it is saved now. `added` is the text it
// was added with (catalogContent), which only the server has.
export function addedSkillText(content, added, name = "") {
  const text = String(content || ""),
    original = String(added || "");
  const start = addedStart(original);
  const hidden = start > 0 ? original.slice(0, start) : "";
  if (!hidden) return writtenSkillText(text, name);
  // Untouched above the publisher's words: they start straight after.
  if (text.startsWith(hidden)) return text.slice(hidden.length).trim();
  // Somebody changed something up there. The lines of the block that are
  // still as they were added are left out, and every other line shows.
  const end = addedStart(text);
  if (end < 0) return writtenSkillText(text, name);
  const top = text.slice(0, end).split("\n");
  const same = unchanged(top, hidden.split("\n"));
  return (
    top.filter((_, i) => !same.has(i)).join("\n") +
    "\n" +
    text.slice(end)
  )
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Which lines of `now` are lines of `was`, kept in the same order: the longest
// such run. A blank line is never counted, because leaving one out or keeping
// it changes nothing a reader sees.
function unchanged(now, was) {
  const a = now.map((l) => l.trimEnd()),
    b = was.map((l) => l.trimEnd());
  const best = Array.from({ length: a.length + 1 }, () =>
    new Array(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      best[i][j] =
        a[i] && a[i] === b[j]
          ? best[i + 1][j + 1] + 1
          : Math.max(best[i + 1][j], best[i][j + 1]);
  const same = new Set();
  for (let i = 0, j = 0; i < a.length && j < b.length;)
    if (a[i] && a[i] === b[j]) {
      same.add(i);
      i++;
      j++;
    } else if (best[i + 1][j] >= best[i][j + 1]) i++;
    else j++;
  return same;
}

// Headings of one level, outside code blocks: a "## Step" inside an example
// is not a part of the page.
function headings(text, level) {
  const mark = "#".repeat(level) + " ";
  let fenced = false,
    n = 0;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    else if (!fenced && line.startsWith(mark)) n++;
  }
  return n;
}

// "14 parts, about 9 minutes to read". The parts are the text's own sections,
// the ones a reader sees as the biggest headings on the page.
export function readingLine(text) {
  const words = String(text || "")
    .split(/\s+/)
    .filter(Boolean).length;
  const minutes = Math.max(1, Math.round(words / 230));
  const time =
    "about " + minutes + (minutes === 1 ? " minute" : " minutes") + " to read";
  const parts = headings(text, 2) || headings(text, 1);
  if (!parts) return time[0].toUpperCase() + time.slice(1);
  return parts + (parts === 1 ? " part, " : " parts, ") + time;
}
