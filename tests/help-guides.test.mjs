// The Help guides' text marks, search, screen mapping and screenshot rings,
// as the Help pages and the in-app panel both use them.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  guideForView,
  highlight,
  plainText,
  richText,
  searchHelp,
  shotLayout,
} from "../shared/help-guides.mjs";

const guides = JSON.parse(fs.readFileSync("public/help/guides.json", "utf8"));

test("guide text: bold, controls, and links only to Help", () => {
  assert.deepEqual(richText("Click [[Save]] and wait for **Saved**."), [
    { kind: "text", text: "Click " },
    { kind: "ui", text: "Save" },
    { kind: "text", text: " and wait for " },
    { kind: "strong", text: "Saved" },
    { kind: "text", text: "." },
  ]);
  assert.deepEqual(richText("See [the board guide](/help/task-board#step-4)."), [
    { kind: "text", text: "See " },
    { kind: "link", text: "the board guide", href: "/help/task-board#step-4" },
    { kind: "text", text: "." },
  ]);
  // A link anywhere else is shown as its words, never followed.
  assert.deepEqual(richText("[a shop](https://example.com)"), [{ kind: "text", text: "a shop" }]);
  assert.deepEqual(richText("[it](javascript:alert(1))").map((p) => p.kind), ["text", "text"]);
  assert.equal(plainText("Tell [Duck] to stop, then click [[Done]]."), "Tell [Duck] to stop, then click Done.");
});

test("search: the step that answers comes first, then steps that mention it, then guides", () => {
  const key = searchHelp(guides, "key");
  assert.deepEqual(
    key.steps.slice(0, 2).map((r) => `${r.guide.id} ${r.number}`),
    ["connect-ai 3", "connect-ai 4"],
  );
  assert.equal(key.steps[0].snippet, undefined, "a step found by its title needs no quote");
  const mention = key.steps.find((r) => r.snippet);
  assert.ok(mention && /\bkey/i.test(mention.snippet), "a step found by its text quotes where");
  assert.ok(!/^Pick how to connect/.test(mention.snippet), "the quote is from the text, not the title");
  // A webhook can be locked with an API key of its own, so that guide is
  // found too - after the one about connecting an AI.
  assert.deepEqual(key.guides.map((g) => g.id), ["connect-ai", "webhooks"]);

  // Every word typed counts, and each may be the start of a word.
  assert.deepEqual(searchHelp(guides, "add tic").steps[0].step.title, "Add a ticket");
  assert.equal(searchHelp(guides, "invite").steps[0].step.title, "Invite a teammate");
  assert.equal(searchHelp(guides, "INVITE").steps[0].step.title, "Invite a teammate");
  // "key" is a word start of "keys", not of "monkey".
  assert.ok(searchHelp([{ id: "x", title: "X", steps: [{ title: "Monkey", do: "a" }] }], "key").steps.length === 0);
  assert.deepEqual(searchHelp(guides, "   "), { terms: [], steps: [], guides: [] });
  assert.deepEqual(searchHelp(guides, "zzqx").steps, []);
  assert.ok(searchHelp(guides, "a", { steps: 3 }).steps.length <= 3);
});

test("highlight marks where each search word starts", () => {
  assert.deepEqual(highlight("Invite a teammate", ["inv", "team"]), [
    { text: "Inv", hit: true },
    { text: "ite a ", hit: false },
    { text: "team", hit: true },
    { text: "mate", hit: false },
  ]);
  assert.deepEqual(highlight("Click [[Save]]", []), [{ text: "Click Save", hit: false }]);
});

test("each app screen has its guide, and only where one fits", () => {
  assert.equal(guideForView({ type: "tasks" }), "task-board");
  assert.equal(guideForView({ type: "tasks", id: "t1" }), "task-board");
  assert.equal(guideForView({ type: "inbox" }), "needs-you");
  assert.equal(guideForView({ type: "files" }), "files");
  assert.equal(guideForView({ type: "computers" }), "computers");
  assert.equal(guideForView({ type: "team" }), "team");
  assert.equal(guideForView({ type: "chat" }), "first-task");
  assert.equal(guideForView({ type: "settings", tab: "ai" }), "connect-ai");
  assert.equal(guideForView({ type: "settings", tab: "billing" }), null);
  assert.equal(guideForView({ type: "skills" }), null);
  assert.equal(guideForView(null), null);
  for (const id of ["task-board", "needs-you", "files", "computers", "team", "first-task", "connect-ai"])
    assert.ok(guides.some((g) => g.id === id), id + " exists");
});

test("rings sit on their buttons in a cropped screenshot", () => {
  const shot = shotLayout({
    width: 200,
    height: 400,
    crop: { top: 100, height: 200 },
    marks: [
      { x: 50, y: 150, w: 100, h: 20, label: "Save" },
      { x: 10, y: 200, w: 20, h: 20, badge: "corner", label: "More" },
    ],
  });
  assert.equal(shot.cropped, true);
  assert.equal(shot.ratio, "200 / 200");
  assert.deepEqual(shot.picture, { width: 100, left: 0, top: -50 });
  assert.deepEqual(shot.marks[0].ring, { left: 25, top: 25, width: 50, height: 10 });
  assert.deepEqual(shot.marks[0], { ...shot.marks[0], n: 1, side: "left", badge: { left: 25, top: 30 } });
  assert.deepEqual(shot.marks[1], { ...shot.marks[1], n: 2, side: "corner", badge: { left: 15, top: 50 } });
  const whole = shotLayout({ width: 100, height: 50, marks: [{ x: 5, y: 5, w: 10, h: 10 }] });
  assert.equal(whole.cropped, false);
  assert.equal(whole.numbered, false);
  assert.equal(whole.marks[0].side, "right", "too near the left edge for a number on its left");
});

test("in the narrow panel, a wide screen is shown around its rings", () => {
  const image = { width: 1200, height: 600, marks: [{ x: 900, y: 100, w: 100, h: 40, label: "Scheduled" }] };
  const shot = shotLayout(image, { focus: true });
  assert.equal(shot.cropped, true);
  // 420 wide (the least shown), centred on the ring, and inside the picture.
  assert.equal(shot.ratio, "420 / 189");
  assert.deepEqual(shot.picture, { width: 285.714, left: -176.19, top: -13.492 });
  const { ring } = shot.marks[0];
  assert.ok(ring.left > 0 && ring.left + ring.width < 100 && ring.top > 0 && ring.top + ring.height < 100);
  // Pushed back inside at an edge, never past it.
  const edge = shotLayout({ width: 1200, height: 600, marks: [{ x: 1150, y: 560, w: 40, h: 30, label: "x" }] }, { focus: true });
  assert.ok(edge.picture.left >= -(1200 / 420 - 1) * 100 - 0.001);
  assert.equal(shotLayout(image).cropped, false, "the Help pages show it whole");
  assert.equal(shotLayout({ width: 1200, height: 600 }, { focus: true }).cropped, false, "nothing to show around");
});
