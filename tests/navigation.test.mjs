import { test } from "node:test";
import assert from "node:assert/strict";
import {
  readRoute,
  routePath,
  resolveRoute,
  desktopReturnRoute,
  withDesktopReturn,
} from "../src/navigation.mjs";
const data = {
  company: { id: "company-a" },
  // The owner, who may open every settings page.
  role: "owner",
  permissions: {
    chat: true,
    ducks: true,
    tasks: true,
    docs: true,
    integrations: true,
    team: true,
    company: true,
    billing: true,
    approvals: true,
    skills: true,
    computers: true,
  },
  conversations: [
    { id: "chief-chat", kind: "direct" },
    { id: "archived-chat", kind: "group", archived: 1 },
  ],
  tasks: [{ id: "launch-task" }],
  documents: [{ id: "brief" }],
  ducks: [{ id: "chief" }],
  skills: [{ id: "research" }],
  computers: { items: [{ id: "desktop" }] },
};
const resolve = (path) => resolveRoute(readRoute(path), data);
test("a direct link restores its company and selected conversation, including archived history", () => {
  assert.deepEqual(resolve("/w/company-a/chat/archived-chat"), {
    view: { companyId: "company-a", type: "chat", id: "archived-chat" },
    notice: "",
  });
});
test("bookmarks retain saved detail selections and every settings tab", () => {
  for (const path of [
    "tasks/launch-task",
    "files/brief",
    "files/duck/chief",
    "files/chat/archived-chat",
    "skills/research",
    "computers/desktop",
    "computers/controls",
    "inbox",
    "team",
    ...[
      "ai",
      "appearance",
      "connections",
      "secrets",
      "company",
      "billing",
      "storage",
      "usage",
      "activity",
      "account",
    ].map((t) => "settings/" + t),
  ]) {
    const full = "/w/company-a/" + path;
    assert.equal(routePath(resolve(full).view), full);
  }
});
test("root and unscoped routes acquire the signed-in company without losing the destination", () => {
  assert.equal(routePath(resolve("/").view), "/w/company-a/chat/chief-chat");
  assert.equal(
    routePath(resolve("/settings/appearance").view),
    "/w/company-a/settings/appearance",
  );
  assert.equal(
    routePath(resolve("/w/company-a/files/").view),
    "/w/company-a/files",
  );
});

test("file and ticket folder selections survive copied links and refreshes", () => {
  const files = readRoute("/w/company-a/files/duck/chief", "?folder=reports");
  assert.equal(files.filters.folder, "reports");
  assert.equal(routePath(files), "/w/company-a/files/duck/chief?folder=reports");
  const ticket = readRoute(
    "/w/company-a/tasks/boards/marketing/ticket/launch-task",
    "?folder=unfiled",
  );
  assert.equal(ticket.folderId, "unfiled");
  assert.equal(
    routePath(ticket),
    "/w/company-a/tasks/boards/marketing/ticket/launch-task?folder=unfiled",
  );
  assert.equal(
    readRoute("/w/company-a/tasks/boards/marketing/ticket/launch-task", "?folder=../../bad").folderId,
    undefined,
  );
});
test("unavailable or removed items return to an accessible parent with an explanation", () => {
  for (const type of ["tasks", "files", "skills", "computers"]) {
    const r = resolve("/w/company-a/" + type + "/missing");
    assert.equal(routePath(r.view), "/w/company-a/" + type);
    assert.ok(r.notice);
  }
  const chat = resolve("/w/company-a/chat/missing");
  assert.equal(chat.view.id, "chief-chat");
  assert.ok(chat.notice);
});
test("deep links respect restricted computer and settings permissions", () => {
  const restricted = { ...data, permissions: {} };
  for (const path of [
    "settings/company",
    "settings/storage",
    "settings/usage",
    "settings/secrets",
    "settings/connections",
  ]) {
    const r = resolveRoute(readRoute("/w/company-a/" + path), restricted);
    assert.equal(routePath(r.view), "/w/company-a/settings/account");
    assert.ok(r.notice);
  }
  assert.equal(
    resolveRoute(readRoute("/w/company-a/computers"), restricted).view.id,
    "chief-chat",
  );
  assert.equal(
    resolveRoute(readRoute("/w/company-a/computers/controls"), {
      ...restricted,
      permissions: { computers: true },
    }).view.id,
    undefined,
  );
});
test("malformed and unknown routes recover without exceptions or external redirects", () => {
  for (const path of [
    "/%E0%A4%A",
    "/unknown",
    "/w/company-a/tasks/one/extra",
    "/w/%2F%2Fevil/chat",
    "/w/company-a/documents/%2e%2e%2fsecrets",
  ]) {
    const r = resolve(path);
    assert.equal(r.view.type, "chat");
    assert.ok(r.notice);
    assert.ok(routePath(r.view).startsWith("/w/company-a/"));
  }
  assert.equal(
    routePath(resolve("/w/company-a/settings/unknown").view),
    "/w/company-a/settings/account",
  );
});
// Everybody lands on Your account, the first page in the list. A member used
// to land on AI connection, a page that told them only the owner could change
// it.
test("Settings opens on Your account, quietly, when no page or an unknown one is asked for", () => {
  for (const path of ["/w/company-a/settings", "/w/company-a/settings/unknown"]) {
    const r = resolve(path);
    assert.equal(routePath(r.view), "/w/company-a/settings/account", path);
    assert.equal(r.notice, "", path);
  }
});
test("a link to a settings page somebody may not use opens Your account and says so", () => {
  const member = {
    ...data,
    role: "member",
    permissions: { chat: true, tasks: true, docs: true },
  };
  // An admin may not pay the bills unless given it.
  const admin = {
    ...data,
    role: "admin",
    permissions: { ...data.permissions, billing: false },
  };
  for (const [who, path] of [
    [member, "settings/ai"],
    [admin, "settings/billing"],
  ]) {
    const r = resolveRoute(readRoute("/w/company-a/" + path), who);
    assert.equal(routePath(r.view), "/w/company-a/settings/account", path);
    assert.equal(r.notice, "You don't have access to that settings page.", path);
  }
});
test("setup and invitation pages keep their existing authentication entry point", () => {
  assert.deepEqual(readRoute("/setup"), { type: "chat" });
  assert.deepEqual(readRoute("/invite"), { type: "chat" });
});
test("cross-company or stale links resolve only against the authorized workspace snapshot", () => {
  const r = resolveRoute(
    readRoute("/w/company-b/documents/other-company-brief"),
    data,
  );
  assert.equal(routePath(r.view), "/w/company-a/files");
  assert.ok(r.notice);
});

test("thread URLs survive refresh and retain the parent conversation", () => {
  const path = "/w/company-a/chat/chief-chat/thread/message-root";
  assert.deepEqual(readRoute(path), {
    companyId: "company-a",
    type: "chat",
    id: "chief-chat",
    threadId: "message-root",
  });
  assert.equal(routePath(resolve(path).view), path);
  assert.equal(
    routePath(resolve("/chat/chief-chat/thread/message-root").view),
    path,
  );
  for (const bad of [
    "/chat/chief-chat/thread",
    "/chat/chief-chat/thread/root/extra",
    "/documents/brief/thread/root",
    "/chat/chief-chat/thread/%2e%2e%2fevil",
  ])
    assert.equal(readRoute(bad).type, "missing");
  assert.equal(
    resolve("/chat/unavailable/thread/message-root").view.threadId,
    undefined,
  );
});
test("computer takeover has a persistent deep link", () => {
  const url = "/w/company-a/computers/desktop/control";
  assert.equal(routePath(resolve(url).view), url);
  assert.equal(resolve(url).view.control, true);
});
test("workflow board and ticket URLs survive refresh with company validation", () => {
  const wf = { ...data, workflows: { boards: [{ id: "marketing" }] } };
  for (const p of [
    "/w/company-a/tasks/boards/marketing",
    "/w/company-a/tasks/boards/marketing/ticket/launch-task",
  ])
    assert.equal(routePath(resolveRoute(readRoute(p), wf).view), p);
  const bad = resolveRoute(readRoute("/w/company-a/tasks/boards/foreign"), wf);
  assert.equal(bad.view.boardId, undefined);
  assert.ok(bad.notice);
});

test("human input takeover links preserve the exact request across refresh", () => {
  const path = "/w/company-a/computers/desktop/control/request-123";
  assert.equal(routePath(resolve(path).view), path);
  assert.equal(resolve(path).view.requestId, "request-123");
  assert.equal(
    readRoute("/computers/desktop/control/request-123/extra").type,
    "missing",
  );
});

test("chat screen shortcuts retain the exact checkpoint after refresh", () => {
  const token = "a".repeat(64);
  const url = "/w/company-a/computers/desktop/control/checkpoint/" + token;
  const route = resolve(url).view;
  assert.equal(route.checkpointToken, token);
  assert.equal(routePath(route), url);
  assert.equal(
    readRoute("/computers/desktop/control/checkpoint/invalid").type,
    "missing",
  );
});

test("old Documents links open Files, and file filters survive refresh", () => {
  assert.equal(
    routePath(resolve("/w/company-a/documents/brief").view),
    "/w/company-a/files/brief",
  );
  assert.equal(routePath(resolve("/documents").view), "/w/company-a/files");
  const url =
    "/w/company-a/files/duck/chief?type=pdf&from=user%3Au-1&sort=size&layout=grid&q=q3+plan";
  const [pathname, search] = url.split("?");
  const view = resolveRoute(readRoute(pathname, "?" + search), data).view;
  assert.deepEqual(view.filters, {
    type: "pdf",
    from: "user:u-1",
    sort: "size",
    layout: "grid",
    q: "q3 plan",
  });
  assert.equal(routePath(view), url);
  const cleaned = readRoute("/files", "?type=%3Cscript%3E&sort=random&from=x");
  assert.equal(cleaned.filters, undefined);
  assert.equal(routePath(cleaned), "/files");
});
test("file scopes for missing ducks or chats fall back to all files", () => {
  for (const path of ["files/duck/gone", "files/chat/gone"]) {
    const r = resolve("/w/company-a/" + path);
    assert.equal(routePath(r.view), "/w/company-a/files");
    assert.ok(r.notice);
  }
  for (const bad of [
    "/files/duck/a/b",
    "/files/team/chief",
    "/files/chat/%2e%2e",
  ])
    assert.equal(readRoute(bad).type, "missing");
});

test("returning to task boards reopens the board last used, per company", () => {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
  };
  try {
    const wf = {
      ...data,
      workflows: { boards: [{ id: "first" }, { id: "marketing" }] },
    };
    // Nothing remembered yet: the page still opens without a board.
    assert.equal(resolveRoute({ type: "tasks" }, wf).view.boardId, undefined);
    // Opening a board records it, and coming back reopens that one.
    resolveRoute(readRoute("/w/company-a/tasks/boards/marketing"), wf);
    assert.equal(resolveRoute({ type: "tasks" }, wf).view.boardId, "marketing");
    // A ticket link still decides its own board rather than being dragged away.
    assert.equal(
      resolveRoute({ type: "tasks", id: "launch-task" }, wf).view.boardId,
      undefined,
    );
    // A remembered board that no longer exists is ignored, not restored.
    const shrunk = { ...data, workflows: { boards: [{ id: "first" }] } };
    assert.equal(
      resolveRoute({ type: "tasks" }, shrunk).view.boardId,
      undefined,
    );
    // Another company keeps its own memory.
    const other = {
      ...wf,
      company: { id: "company-b" },
    };
    assert.equal(
      resolveRoute({ type: "tasks" }, other).view.boardId,
      undefined,
    );
  } finally {
    delete globalThis.localStorage;
  }
});

test("task boards still work when the browser refuses storage", () => {
  globalThis.localStorage = {
    getItem() {
      throw new Error("blocked");
    },
    setItem() {
      throw new Error("blocked");
    },
  };
  try {
    const wf = { ...data, workflows: { boards: [{ id: "marketing" }] } };
    assert.deepEqual(
      resolveRoute(readRoute("/w/company-a/tasks/boards/marketing"), wf).view,
      { companyId: "company-a", type: "tasks", boardId: "marketing" },
    );
    assert.equal(resolveRoute({ type: "tasks" }, wf).view.boardId, undefined);
  } finally {
    delete globalThis.localStorage;
  }
});

test("handback retains chat, thread and ticket origins through refresh and reconnect", () => {
  const control = {
    companyId: "company-a",
    type: "computers",
    id: "desktop",
    control: true,
  };
  for (const origin of [
    "/w/company-a/chat/chief-chat",
    "/w/company-a/chat/chief-chat/thread/root",
    "/w/company-a/tasks/boards/board-a/ticket/launch-task",
  ]) {
    const destination = withDesktopReturn(control, readRoute(origin));
    const url = new URL(routePath(destination), "https://example.test");
    const restored = readRoute(url.pathname, url.search);
    assert.equal(restored.returnTo, origin);
    assert.equal(
      routePath(desktopReturnRoute(restored.returnTo, "company-a")),
      origin,
    );
    assert.equal(
      withDesktopReturn({ ...control, requestId: "request-a" }, restored)
        .returnTo,
      origin,
    );
  }
});
test("opening a desktop from Computers has no chat or ticket return destination", () => {
  const destination = withDesktopReturn(
    { companyId: "company-a", type: "computers", id: "desktop", control: true },
    { companyId: "company-a", type: "computers" },
  );
  assert.equal(destination.returnTo, undefined);
  assert.equal(desktopReturnRoute(undefined, "company-a"), null);
});
test("desktop return destinations reject external, cross-company and recursive routes", () => {
  for (const origin of [
    "https://example.test/w/company-a/chat/chief-chat",
    "//example.test/chat/chief-chat",
    "/w/company-b/chat/chief-chat",
    "/w/company-a/computers/desktop/control",
    "/w/company-a/tasks",
    "/w/company-a/chat/chief-chat?returnTo=/computers",
    "/w/company-a/chat/%2Foutside",
  ]) {
    assert.equal(desktopReturnRoute(origin, "company-a"), null, origin);
    const query = new URLSearchParams({ returnTo: origin }).toString();
    assert.equal(
      readRoute("/w/company-a/computers/desktop/control", query).returnTo,
      undefined,
    );
  }
});

test("a ticket origin survives opening its work chat before taking control", () => {
  const ticket = readRoute(
    "/w/company-a/tasks/boards/board-a/ticket/launch-task",
  );
  const chat = withDesktopReturn(
    { companyId: "company-a", type: "chat", id: "chief-chat" },
    ticket,
  );
  const url = new URL(routePath(chat), "https://example.test");
  const restored = readRoute(url.pathname, url.search);
  assert.equal(restored.returnTo, routePath(ticket));
  const desktop = withDesktopReturn(
    { companyId: "company-a", type: "computers", id: "desktop", control: true },
    restored,
  );
  assert.deepEqual(desktopReturnRoute(desktop.returnTo, "company-a"), ticket);
  assert.equal(
    withDesktopReturn(
      { companyId: "company-a", type: "chat", id: "another-chat" },
      restored,
    ).returnTo,
    undefined,
  );
});

test("a board is set up at its own address, and an archived board is out of the way", () => {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
  };
  try {
    const wf = {
      ...data,
      permissions: { ...data.permissions, tasks: true },
      workflows: {
        boards: [
          { id: "general", legacy: 1 },
          { id: "blog", legacy: 0 },
          { id: "old", legacy: 0, archived: 1 },
        ],
        columns: [
          { id: "write", board_id: "blog" },
          { id: "plan", board_id: "old" },
        ],
      },
    };
    const go = (path, d = wf) => resolveRoute(readRoute(path), d);
    const W = "/w/company-a/tasks";
    // The three addresses survive a refresh, and say what they are.
    for (const path of [
      W + "/boards/blog/setup",
      W + "/boards/blog/setup/write",
      W + "/new-board",
    ])
      assert.deepEqual([routePath(go(path).view), go(path).notice], [path, ""]);
    assert.deepEqual(readRoute(W + "/boards/blog/setup/write"), {
      companyId: "company-a",
      type: "tasks",
      boardId: "blog",
      setup: true,
      stepId: "write",
    });
    assert.deepEqual(readRoute(W + "/new-board"), {
      companyId: "company-a",
      type: "tasks",
      newBoard: true,
    });
    // A step that is not on the board opens the page on its first step.
    assert.deepEqual(go(W + "/boards/blog/setup/plan"), {
      view: {
        companyId: "company-a",
        type: "tasks",
        boardId: "blog",
        setup: true,
      },
      notice: "",
    });
    // Without permission to manage tasks: the board, and why.
    const member = { ...wf, permissions: { ...wf.permissions, tasks: false } };
    assert.deepEqual(go(W + "/boards/blog/setup/write", member), {
      view: { companyId: "company-a", type: "tasks", boardId: "blog" },
      notice:
        "Setting up boards needs permission to manage tasks. Your company owner can give you this on the Team page.",
    });
    assert.equal(go(W + "/new-board", member).view.newBoard, undefined);
    // General has no steps.
    assert.deepEqual(go(W + "/boards/general/setup"), {
      view: { companyId: "company-a", type: "tasks", boardId: "general" },
      notice: "The General board has no steps to set up.",
    });
    // An unknown board.
    store.set("tameduck:last-board:company-a", "blog");
    const unknown = go(W + "/boards/gone/setup/write");
    assert.equal(unknown.notice, "That board is unavailable in this company.");
    assert.deepEqual(
      [unknown.view.boardId, unknown.view.setup, unknown.view.stepId],
      ["blog", undefined, undefined],
    );
    // An archived board: a link to it lands on a board in use and says why,
    // while a link to one of its tickets still opens the ticket.
    assert.deepEqual(go(W + "/boards/old"), {
      view: { companyId: "company-a", type: "tasks", boardId: "blog" },
      notice:
        "That board is archived. You can bring it back from Archived boards in the board list.",
    });
    // So does its setup page, from a link or from Back after archiving it,
    // and without permission to manage tasks too.
    const archived = {
      view: { companyId: "company-a", type: "tasks", boardId: "blog" },
      notice:
        "That board is archived. You can bring it back from Archived boards in the board list.",
    };
    assert.deepEqual(go(W + "/boards/old/setup"), archived);
    assert.deepEqual(go(W + "/boards/old/setup/plan"), archived);
    assert.deepEqual(go(W + "/boards/old/setup", member), archived);
    // Only a setup page already open when its board is archived under it
    // stays, so what was typed there is not thrown away.
    assert.deepEqual(
      resolveRoute(readRoute(W + "/boards/old/setup/plan"), wf, { shown: true })
        .view,
      {
        companyId: "company-a",
        type: "tasks",
        boardId: "old",
        setup: true,
        stepId: "plan",
      },
    );
    const ticket = W + "/boards/old/ticket/launch-task";
    assert.deepEqual(
      [routePath(go(ticket).view), go(ticket).notice],
      [ticket, ""],
    );
    // An archived board is never the one to come back to.
    store.set("tameduck:last-board:company-a", "old");
    assert.equal(resolveRoute({ type: "tasks" }, wf).view.boardId, undefined);
  } finally {
    delete globalThis.localStorage;
  }
});
