import { notePlace } from "./recent-places.mjs";
import { HOME, PAGE_IDS, pageFor } from "./settings-pages.mjs";
const pages = new Set([
  "chat",
  "tasks",
  "files",
  "skills",
  "computers",
  "inbox",
  "team",
  "settings",
]);
const details = new Set(["chat", "tasks", "files", "skills", "computers"]);
const settings = new Set(PAGE_IDS);
const idPattern = /^[a-zA-Z0-9_-]{1,100}$/;
// /skills/catalog/<catalogue id> and /skills/topic/<topic>.
const skillPlaces = { catalog: "catalogId", topic: "topic" };
// Files filters are saved in the query string so a filtered view can be shared.
const fileFilters = {
  type: /^[a-z]{1,20}$/,
  from: /^(user|duck):[a-zA-Z0-9_-]{1,100}$/,
  sort: /^(updated|newest|oldest|name|size)$/,
  layout: /^(list|grid)$/,
  folder: /^(all|unfiled|[a-zA-Z0-9_-]{1,100})$/,
  q: /^[^\u0000-\u001f]{1,100}$/,
};
function readFilters(search) {
  const params = new URLSearchParams(search || "");
  const filters = {};
  for (const [name, pattern] of Object.entries(fileFilters)) {
    const value = params.get(name);
    if (value && pattern.test(value)) filters[name] = value;
  }
  return filters;
}
function folderParam(search) {
  const folderId = new URLSearchParams(search || "").get("folder");
  return fileFilters.folder.test(folderId || "") ? { folderId } : {};
}

// Only chat and ticket destinations in this workspace can receive a handback.
// Store the route in the URL so a refresh/reconnect keeps the original context.
export function desktopReturnRoute(value, companyId) {
  if (typeof value !== "string" || value.length > 1000 || /[?#\\]/.test(value))
    return null;
  if (!/^\/w\/[^/]+\/(chat|tasks)\//.test(value)) return null;
  const route = readRoute(value);
  return route.companyId === companyId &&
    route.id &&
    ["chat", "tasks"].includes(route.type)
    ? route
    : null;
}
export function withDesktopReturn(next, current) {
  const sameCompany = current.companyId === next.companyId;
  // Ticket work opens its chat before the desktop. Keep that ticket through
  // the intermediate chat, but don't carry it into unrelated conversations.
  if (next.type === "chat" && next.id) {
    const origin =
      desktopReturnRoute(next.returnTo, next.companyId) ||
      (sameCompany &&
        (current.type === "tasks" && current.id
          ? desktopReturnRoute(routePath(current), next.companyId)
          : current.type === "chat" && current.id === next.id
            ? desktopReturnRoute(current.returnTo, next.companyId)
            : null));
    const result = { ...next };
    if (origin) result.returnTo = routePath(origin);
    else delete result.returnTo;
    return result;
  }
  if (next.type !== "computers" || !next.control || !next.id) return next;
  const explicit = desktopReturnRoute(next.returnTo, next.companyId);
  const origin =
    explicit ||
    (sameCompany &&
      (((current.type === "chat" ||
        (current.type === "computers" && current.id === next.id)) &&
        desktopReturnRoute(current.returnTo, next.companyId)) ||
        desktopReturnRoute(routePath(current), next.companyId)));
  const result = { ...next };
  if (origin) result.returnTo = routePath(origin);
  else delete result.returnTo;
  return result;
}
export function filesReturnRoute(value, companyId) {
  const origin = desktopReturnRoute(value, companyId);
  return origin?.type === "chat" ? origin : null;
}
export function withFilesReturn(next, current) {
  if (next.type !== "files") return next;
  const sameCompany = next.companyId === current.companyId;
  const origin =
    filesReturnRoute(next.returnTo, next.companyId) ||
    (sameCompany &&
      (current.type === "chat" && current.id
        ? filesReturnRoute(
            routePath({
              type: "chat",
              companyId: current.companyId,
              id: current.id,
              threadId: current.threadId,
            }),
            next.companyId,
          )
        : current.type === "files"
          ? filesReturnRoute(current.returnTo, next.companyId)
          : null));
  const result = { ...next };
  if (origin) result.returnTo = routePath(origin);
  else delete result.returnTo;
  return result;
}
function filesReturnParams(search, companyId) {
  const origin = filesReturnRoute(
    new URLSearchParams(search).get("returnTo"),
    companyId,
  );
  return origin ? { returnTo: routePath(origin) } : {};
}
function desktopReturnParams(search, companyId) {
  const origin = desktopReturnRoute(
    new URLSearchParams(search).get("returnTo"),
    companyId,
  );
  return origin ? { returnTo: routePath(origin) } : {};
}
// The one message a chat link points at, ?at=<message id>, opened the way
// picking it from search opens it. A scheduled task's "Open in chat" jumped to
// its answer when clicked, and the same link in a new tab, or copied, opened
// at the bottom of the chat. The app's own address leaves it out once loaded.
function messageAt(search) {
  const at = new URLSearchParams(search).get("at");
  return idPattern.test(at || "") ? { at } : {};
}

// Authentication tokens stay in their existing hash-based setup/invitation flow.
export function readRoute(pathname, search = "") {
  let parts;
  try {
    parts = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  } catch {
    return { type: "missing" };
  }
  let companyId;
  if (parts[0] === "w") {
    parts.shift();
    companyId = parts.shift();
    if (!idPattern.test(companyId || "")) return { type: "missing" };
  }
  let [type = "chat", value, extra] = parts;
  const scope = companyId ? { companyId } : {};
  // "Documents" became "Files"; old bookmarks keep working.
  if (type === "documents") type = "files";
  if (type === "files") {
    const filters = readFilters(search);
    const returnTo = filesReturnParams(search, companyId);
    const filtered = Object.keys(filters).length ? { filters } : {};
    if (
      ["duck", "chat"].includes(value) &&
      parts.length === 3 &&
      idPattern.test(extra || "")
    )
      return {
        ...scope,
        type,
        [value === "duck" ? "duckId" : "conversationId"]: extra,
        ...filtered,
        ...returnTo,
      };
    if (extra === undefined && (!value || idPattern.test(value)))
      return {
        ...scope,
        type,
        ...(value ? { id: value } : {}),
        ...filtered,
        ...returnTo,
      };
    return { ...scope, type: "missing" };
  }
  if (type === "team") {
    if (
      extra !== undefined ||
      (value && !["people", "activity"].includes(value))
    )
      return { ...scope, type: "missing" };
    // Team opens on the ducks and the people. The activity feed it used to
    // open on is the second tab now, and a link to one duck's work, which
    // was written as /team?duck=, still lands on that duck's work.
    const duckId = new URLSearchParams(search).get("duck");
    const focus = value !== "people" && idPattern.test(duckId || "");
    return {
      ...scope,
      type,
      tab: value === "activity" || focus ? "activity" : "people",
      ...(focus ? { duckId } : {}),
    };
  }
  if (!companyId && ["setup", "invite"].includes(type)) return { type: "chat" };
  if (
    type === "chat" &&
    extra === "thread" &&
    parts.length === 4 &&
    idPattern.test(value || "") &&
    idPattern.test(parts[3] || "")
  )
    return {
      ...scope,
      type,
      id: value,
      threadId: parts[3],
      ...messageAt(search),
      ...desktopReturnParams(search, companyId),
    };
  if (
    type === "computers" &&
    extra === "control" &&
    parts.length === 5 &&
    parts[3] === "checkpoint" &&
    /^[a-f0-9]{64}$/.test(parts[4]) &&
    idPattern.test(value || "")
  )
    return {
      ...scope,
      type,
      id: value,
      control: true,
      ...desktopReturnParams(search, companyId),
      checkpointToken: parts[4],
    };
  if (
    type === "computers" &&
    extra === "control" &&
    (parts.length === 3 ||
      (parts.length === 4 && idPattern.test(parts[3] || ""))) &&
    idPattern.test(value || "")
  )
    return {
      ...scope,
      type,
      id: value,
      control: true,
      ...desktopReturnParams(search, companyId),
      ...(parts[3] ? { requestId: parts[3] } : {}),
    };
  // /tasks/scheduled - the standing instructions, alongside the boards - and
  // /tasks/scheduled/<id>, one of them on its own page ("new" for a new one).
  if (type === "tasks" && value === "scheduled" && parts.length === 2)
    return { ...scope, type, scheduled: true };
  // A board is set up on a page of its own, which can open on one step.
  // Task ids are UUIDs, so "new-board" is never one.
  if (type === "tasks" && value === "new-board" && parts.length === 2)
    return { ...scope, type, newBoard: true };
  if (
    type === "tasks" &&
    value === "boards" &&
    idPattern.test(extra || "") &&
    parts[3] === "setup" &&
    (parts.length === 4 ||
      (parts.length === 5 && idPattern.test(parts[4] || "")))
  )
    return {
      ...scope,
      type,
      boardId: extra,
      setup: true,
      ...(parts[4] ? { stepId: parts[4] } : {}),
    };
  if (
    type === "tasks" &&
    value === "scheduled" &&
    parts.length === 3 &&
    idPattern.test(extra || "")
  )
    return { ...scope, type, scheduled: true, scheduleId: extra };
  // A skill from the catalogue, and a topic of it, have addresses of their
  // own, so Back from a skill returns to the list it was opened from.
  if (
    type === "skills" &&
    Object.hasOwn(skillPlaces, value || "") &&
    parts.length === 3 &&
    idPattern.test(extra || "")
  )
    return { ...scope, type, [skillPlaces[value]]: extra };
  if (
    type === "tasks" &&
    value === "boards" &&
    idPattern.test(extra || "") &&
    (parts.length === 3 ||
      (parts.length === 5 &&
        parts[3] === "ticket" &&
        idPattern.test(parts[4] || "")))
  )
    return {
      ...scope,
      type,
      boardId: extra,
      ...(parts[4] ? { id: parts[4] } : {}),
      ...(parts[4] ? folderParam(search) : {}),
    };
  // One connection, for a duck that is waiting on it.
  if (
    type === "settings" &&
    value === "connections" &&
    parts.length === 3 &&
    idPattern.test(extra || "")
  )
    return { ...scope, type, tab: "connections", connectionId: extra };
  if (!pages.has(type) || extra !== undefined)
    return { ...scope, type: "missing" };
  if (type === "settings")
    return { ...scope, type, tab: settings.has(value) ? value : HOME };
  if (value && (!details.has(type) || !idPattern.test(value)))
    return { ...scope, type: "missing" };
  return {
    ...scope,
    type,
    ...(value ? { id: value } : {}),
    ...(type === "chat"
      ? { ...messageAt(search), ...desktopReturnParams(search, companyId) }
      : {}),
  };
}

export function routePath(view) {
  const base = view.companyId ? "/w/" + encodeURIComponent(view.companyId) : "";
  if (!pages.has(view.type)) return base || "/";
  if (view.type === "files") {
    const returnTo = filesReturnRoute(view.returnTo, view.companyId);
    const query = new URLSearchParams(
      Object.entries(view.filters || {}).filter(([name, value]) =>
        fileFilters[name]?.test(value || ""),
      ),
    ).toString();
    return (
      base +
      "/files" +
      (view.duckId
        ? "/duck/" + encodeURIComponent(view.duckId)
        : view.conversationId
          ? "/chat/" + encodeURIComponent(view.conversationId)
          : view.id
            ? "/" + encodeURIComponent(view.id)
            : "") +
      (query || returnTo
        ? "?" +
          new URLSearchParams({
            ...(query ? Object.fromEntries(new URLSearchParams(query)) : {}),
            ...(returnTo ? { returnTo: routePath(returnTo) } : {}),
          }).toString()
        : "")
    );
  }
  if (view.type === "team")
    return (
      base +
      "/team" +
      (view.tab === "activity"
        ? "/activity" +
          (idPattern.test(view.duckId || "")
            ? "?" + new URLSearchParams({ duck: view.duckId }).toString()
            : "")
        : "")
    );
  if (view.type === "skills" && (view.catalogId || view.topic))
    return (
      base +
      (view.catalogId
        ? "/skills/catalog/" + encodeURIComponent(view.catalogId)
        : "/skills/topic/" + encodeURIComponent(view.topic))
    );
  if (view.type === "tasks" && view.scheduled)
    return (
      base +
      "/tasks/scheduled" +
      (view.scheduleId ? "/" + encodeURIComponent(view.scheduleId) : "")
    );
  if (view.type === "tasks" && view.newBoard) return base + "/tasks/new-board";
  if (view.type === "tasks" && view.boardId)
    return (
      base +
      "/tasks/boards/" +
      encodeURIComponent(view.boardId) +
      (view.setup
        ? "/setup" + (view.stepId ? "/" + encodeURIComponent(view.stepId) : "")
        : view.id
          ? "/ticket/" + encodeURIComponent(view.id)
          : "") +
      (view.id && fileFilters.folder.test(view.folderId || "")
        ? "?" + new URLSearchParams({ folder: view.folderId }).toString()
        : "")
    );
  const value =
    view.type === "settings"
      ? view.tab || HOME
      : details.has(view.type)
        ? view.id
        : null;
  return (
    base +
    "/" +
    view.type +
    (value ? "/" + encodeURIComponent(value) : "") +
    (view.type === "computers" && value && view.control
      ? "/control" +
        (view.requestId
          ? "/" + encodeURIComponent(view.requestId)
          : view.checkpointToken
            ? "/checkpoint/" + encodeURIComponent(view.checkpointToken)
            : "")
      : "") +
    (view.type === "chat" && value && view.threadId
      ? "/thread/" + encodeURIComponent(view.threadId)
      : "") +
    (view.type === "settings" &&
    view.tab === "connections" &&
    idPattern.test(view.connectionId || "")
      ? "/" + encodeURIComponent(view.connectionId)
      : "") +
    ((view.type === "chat" || (view.type === "computers" && view.control)) &&
    value &&
    desktopReturnRoute(view.returnTo, view.companyId)
      ? "?" +
        new URLSearchParams({
          returnTo: routePath(
            desktopReturnRoute(view.returnTo, view.companyId),
          ),
        }).toString()
      : "")
  );
}

// Validate destinations against the signed-in user's current workspace snapshot.
// Which board this person last opened, per company. It is a convenience for one
// browser, so a missing or unwritable store simply means the old behaviour.
const lastBoardKey = (company) => "tameduck:last-board:" + company;
function rememberedBoard(company) {
  try {
    return globalThis.localStorage?.getItem(lastBoardKey(company)) || null;
  } catch {
    return null;
  }
}
function rememberBoard(company, boardId) {
  try {
    globalThis.localStorage?.setItem(lastBoardKey(company), boardId);
  } catch {
    // A browser with storage blocked still navigates; it just will not remember.
  }
}
// shown: the view is already on screen and only the data changed.
export function resolveRoute(view, data, { shown = false } = {}) {
  const base = { companyId: data.company.id };
  // Where a bad URL, and every plain load, lands. The oldest direct chat - but
  // not one with a duck that has been taken off the team, or somebody whose
  // first duck is gone would be dropped on a chat that takes no messages every
  // time they opened the app.
  const onTheTeam = new Set(
    (data.ducks || []).filter((d) => !d.removed).map((d) => d.id),
  );
  const directs = data.conversations.filter((c) => c.kind === "direct");
  const home = {
    ...base,
    type: "chat",
    id: (
      directs.find((c) => (c.ducks || []).some((d) => onTheTeam.has(d))) ||
      directs[0]
    )?.id,
  };
  if (view.type === "documents") view = { ...view, type: "files" };
  if (!pages.has(view.type))
    return {
      view: home,
      notice: "That page is unavailable. Your workspace is ready below.",
    };
  let next = { ...view, ...base };
  let notice = "";
  if (
    next.type === "chat" &&
    !data.conversations.some((c) => c.id === next.id)
  ) {
    if (next.id) notice = "That conversation is unavailable in this company.";
    next = home;
  }
  const collections = {
    tasks: data.tasks,
    files: data.documents,
    skills: data.skills,
    computers: data.computers?.items,
  };
  if (
    next.id &&
    next.type in collections &&
    !(next.type === "computers" && next.id === "controls")
  ) {
    if (!collections[next.type]?.some((item) => item.id === next.id)) {
      delete next.id;
      notice = "That item is unavailable in this company.";
    }
  }
  if (
    next.type === "files" &&
    ((next.duckId && !data.ducks?.some((d) => d.id === next.duckId)) ||
      (next.conversationId &&
        !data.conversations.some((c) => c.id === next.conversationId)))
  ) {
    delete next.duckId;
    delete next.conversationId;
    notice = "Those files are unavailable. Showing all files you can access.";
  }
  if (next.type === "team") {
    next.tab =
      next.tab === "activity" || (next.tab !== "people" && next.duckId)
        ? "activity"
        : "people";
    if (
      next.duckId &&
      !(data.ducks || []).some((d) => d.id === next.duckId && !d.removed)
    ) {
      delete next.duckId;
      notice = "That duck is unavailable. Showing your team activity.";
    }
    if (next.tab === "people") delete next.duckId;
  }
  // A link to one scheduled task - from Needs you, the chat, an email - that
  // has since been deleted lands on the list, and says why.
  if (next.type === "tasks" && next.scheduled && next.scheduleId) {
    const refused = !data.permissions?.tasks
      ? "You don't have access to scheduled tasks."
      : next.scheduleId !== "new" &&
        !(data.schedules || []).some((s) => s.id === next.scheduleId) &&
        "That scheduled task no longer exists.";
    if (refused) {
      delete next.scheduleId;
      notice = refused;
    }
  }
  if (next.type === "tasks") {
    const boards = data.workflows?.boards || [];
    const board = boards.find((b) => b.id === next.boardId);
    const leaveSetup = () => {
      delete next.setup;
      delete next.stepId;
    };
    if (next.boardId && !board) {
      delete next.boardId;
      leaveSetup();
      notice = "That board is unavailable in this company.";
    }
    if ((next.setup || next.newBoard) && !data.permissions.tasks) {
      leaveSetup();
      delete next.newBoard;
      notice =
        "Setting up boards needs permission to manage tasks. Your company owner can give you this on the Team page.";
    }
    if (next.setup && board?.legacy) {
      leaveSetup();
      notice = "The General board has no steps to set up.";
    }
    // A ticket on an archived board still opens: tickets keep their history.
    // A setup page already on screen stays when its board is archived under
    // it, or the refresh would throw away what was typed; saving says why it
    // cannot. A link to it, or Back to it, lands on a board in use.
    if (board?.archived && !next.id && !(next.setup && shown)) {
      delete next.boardId;
      leaveSetup();
      notice =
        "That board is archived. You can bring it back from Archived boards in the board list.";
    }
    if (next.setup && !next.boardId) leaveSetup();
    // A step that is not on the board: the page opens on its first step.
    if (
      next.stepId &&
      !(data.workflows?.columns || []).some(
        (c) => c.id === next.stepId && c.board_id === next.boardId,
      )
    )
      delete next.stepId;
    // Coming back to the board list from another page used to land on whichever
    // board happens to be first. Return to the one last opened here instead.
    // A link to a specific ticket keeps deciding its own board, so following one
    // never drags the view onto the remembered board and hides the ticket. An
    // archived board is out of the list, so it is not come back to.
    if (!next.boardId && !next.id && !next.newBoard) {
      const last = rememberedBoard(data.company.id);
      if (last && boards.some((b) => b.id === last && !b.archived))
        next.boardId = last;
    }
    if (next.boardId) rememberBoard(data.company.id, next.boardId);
  }
  if (next.type === "computers") {
    if (!data.permissions.computers) {
      next = home;
      notice = "You don't have access to company computers.";
    } else if (next.id === "controls" && !data.permissions.company) {
      delete next.id;
      notice = "Only company admins can change computer controls.";
    }
  }
  if (next.type === "settings") {
    const tab = settings.has(next.tab) ? next.tab : HOME;
    // Only a page this person can use. A member used to land on AI connection,
    // which told them only the owner could change it.
    next.tab = pageFor(tab, data);
    if (next.tab !== tab)
      notice = "You don't have access to that settings page.";
    if (next.tab !== "connections") delete next.connectionId;
    else if (
      next.connectionId &&
      !(data.connections || []).some((c) => c.id === next.connectionId)
    ) {
      delete next.connectionId;
      notice = "That connection is no longer here.";
    }
  }
  // Search opens on the last few places this person was, so remember
  // each one as they arrive - after the checks above, so a place that is
  // gone is never remembered.
  notePlace(data.company.id, next);
  return { view: next, notice };
}
