// Settings is one list in two groups, your own things and then the company's,
// and each person is offered only the pages they may use. A member used to land
// on AI connection, a page that told them only the owner could change it.
//
// These are the answers the menu offers and the address check gives, read
// without a browser. The people are given the permissions the server sends for
// their role: the owner has all eleven, anybody else has their role's defaults
// with whatever was set by hand on top.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HOME,
  PAGE_IDS,
  pageFor,
  settingsMenu,
  settingsPage,
} from "../src/settings-pages.mjs";
import {
  MEMBER_PERMISSIONS,
  ROLE_DEFAULTS,
} from "../src/member-permissions.mjs";

const person = (role, set = {}) => ({
  role,
  permissions:
    role === "owner"
      ? Object.fromEntries(MEMBER_PERMISSIONS.map((p) => [p.key, true]))
      : { ...ROLE_DEFAULTS[role], ...set },
  company: { name: "Northgate" },
});
const menu = (who) =>
  settingsMenu(who).map((group) => [
    group.label,
    group.pages.map((page) => page.name),
  ]);
const YOU = ["You", ["Your account", "Emails", "Theme", "Notifications"]];

test("the owner sees You, then every company page under the company's own name", () => {
  assert.deepEqual(menu(person("owner")), [
    YOU,
    [
      "Northgate",
      [
        "Company",
        "AI connection",
        "Ducks",
        "Work limits",
        "Connections",
        "Secrets",
        "Billing",
        "Storage",
        "Computer use",
        "Activity log",
      ],
    ],
  ]);
});

test("everybody else is offered only the pages they may use", () => {
  for (const [who, someone, company] of [
    [
      "an admin",
      person("admin"),
      [
        "Company",
        "AI connection",
        "Ducks",
        "Work limits",
        "Connections",
        "Secrets",
        "Storage",
        "Computer use",
        "Activity log",
      ],
    ],
    [
      "an admin without Connect outside tools",
      person("admin", { integrations: false }),
      ["Company", "Ducks", "Work limits", "Storage", "Computer use"],
    ],
    ["a member", person("member"), []],
    [
      "a member given company settings",
      person("member", { company: true }),
      ["Company", "Work limits", "Storage", "Computer use"],
    ],
    [
      "a member given Connect outside tools",
      person("member", { integrations: true }),
      ["Connections", "Secrets", "Activity log"],
    ],
    [
      "a member given Pay the bills",
      person("member", { billing: true }),
      ["Billing", "Storage", "Computer use"],
    ],
    ["a viewer", person("viewer"), []],
  ])
    // A group with nothing in it is left out, heading and all.
    assert.deepEqual(
      menu(someone),
      company.length ? [YOU, ["Northgate", company]] : [YOU],
      who,
    );
});

test("a link to a page somebody may not use opens Your account", () => {
  assert.equal(HOME, "account");
  assert.equal(pageFor("whatever", person("owner")), "account");
  assert.equal(pageFor("ai", person("member")), "account");
  assert.equal(pageFor("ai", person("member", { integrations: true })), "account");
  assert.equal(pageFor("ai", person("admin")), "ai");
  assert.equal(pageFor("billing", person("admin")), "account");
  assert.equal(pageFor("work-limits", person("member")), "account");
  assert.equal(
    pageFor("work-limits", person("member", { company: true })),
    "work-limits",
  );
  assert.equal(pageFor("billing", person("member", { billing: true })), "billing");
});

test("every page says in one short line what it is for", () => {
  const names = PAGE_IDS.map((id) => settingsPage(id).name);
  assert.equal(new Set(names).size, names.length, "two pages share a name");
  for (const id of PAGE_IDS) {
    const intro = settingsPage(id).intro("Northgate");
    assert.ok(intro.length <= 110, `${id} is ${intro.length} characters: ${intro}`);
    assert.ok(
      (intro.match(/\.(\s|$)/g) || []).length <= 2,
      id + " is more than two sentences: " + intro,
    );
    assert.match(intro, /\.$/, id + " does not end with a full stop");
    assert.doesNotMatch(intro, /undefined/, id);
  }
  assert.equal(
    settingsPage("activity").intro("Northgate"),
    "What people and ducks did at Northgate, newest first.",
  );
});

test("a page that saves as you go says so, and Company says to press Save", () => {
  // Your account joined them once its wait time lost its own Save button.
  for (const id of ["account", "emails", "appearance", "ducks"])
    assert.match(
      settingsPage(id).intro("Northgate"),
      / Changes save straight away\.$/,
      id,
    );
  assert.match(settingsPage("company").intro("Northgate"), /press Save\.$/);
  assert.match(settingsPage("work-limits").intro("Northgate"), /press Save\.$/);
});
