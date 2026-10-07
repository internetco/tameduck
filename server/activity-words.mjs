// The activity log's sentences, written once, here.
//
// The log used to print what the server had written down for itself: "MCP
// connection created", "Tool approval executed · create_issue", a bare 36
// character id, and "Workspace" as the name of whoever did it when it was a
// duck. Every row is now a sentence that starts with whoever did the thing -
// "Ops Duck read the secret Supplier portal login" - and says who it was for.
//
// Nothing here reads the database. server/activity.mjs looks up the names a row
// needs and hands them over, so tests/activity-words.test.mjs can check every
// sentence without a server.
import { plainly, willDo, facts, firstLine } from "../src/inbox-list.mjs";
import { providerName } from "../shared/ai-providers.mjs";

// Which of the log's filters a row belongs to. The same two lists are in
// server/migrations/0011_activity-who-and-kind.sql, which gave the rows written
// before this their kind; the test checks that the two agree.
const SECRETS = new Set([
  "Secret group created",
  "Secret group renamed",
  "Secret group removed",
  "Secrets saved",
  "Secrets moved",
  "Secret saved",
  "Secret updated",
  "Secret deleted",
  "Duck replaced a secret",
  "Duck saved a secret",
  "Duck read a secret",
  "Duck used a secret",
  "MCP connection added",
  "MCP connection created",
  "MCP connection updated",
  "MCP connection removed",
  "MCP connection disconnected",
  "MCP sign-in started",
  "MCP account connected",
  "AI provider connected",
  "AI provider disconnected",
  "Duck allowed to use a connection",
  "Ducks allowed to use a key",
]);
const WORK = new Set([
  "Duck finished a run",
  "Duck run needs attention",
  "Duck used computer",
  "Duck used computer terminal",
  "Duck saved document",
  "Duck updated notes",
  "Chief recruited a duck",
  "Chief updated a ticket",
  "Duck updated task",
  "Chief delegated a task",
  "Duck used default model fallback",
  "Chief changed a board with standing permission",
  "Duck withdrew a request",
  "Computer resumed",
  "Computer created",
  "Idle computer saving and stopping",
  "Computer saving and stopping",
  "Screen given back after nobody came back",
]);
export const KINDS = ["secrets", "tools", "people", "work"];
export function kindOf(action) {
  const a = String(action || "");
  if (SECRETS.has(a)) return "secrets";
  if (/^tool approval /i.test(a) || a === "Connected tool executed")
    return "tools";
  if (WORK.has(a) || /^chief proposed (board|skill) /i.test(a)) return "work";
  return "people";
}
// Every action the server writes today, for the test.
export const KNOWN_ACTIONS = [...SECRETS, ...WORK];

// The runs a day folds into one line, and the computer use it folds into
// another: a duck's computer writes a row for every click.
export const RUN_FINISHED = "Duck finished a run";
export const COMPUTER_USE = new Set([
  "Duck used computer",
  "Duck used computer terminal",
]);

const q = (title) => "“" + String(title || "") + "”";
const count = (n, one, many) => n + " " + (n === 1 ? one : many);
const words = (value) => (typeof value === "string" ? value.trim() : "");
const field = (row, key) =>
  row.details && typeof row.details === "object" ? words(row.details[key]) : "";
const said = (row) => words(typeof row.details === "string" ? row.details : "");
const who = (row) => row.person || "Somebody";
const duck = (row) => row.duck?.name || "A duck";
const chief = (row) => row.duck?.name || row.chief?.name || "Chief Duck";
const named = (row, id) => (id && row.named?.[id]) || "";
// Who a duck's run was for, and what it was, when the person looking may see
// what was asked: "For Sam de Vries: “Order next week’s flour”".
const forWhom = (row) =>
  row.job?.for
    ? "For " + row.job.for + (row.job.title ? ": " + q(row.job.title) : "")
    : row.job?.title
      ? q(row.job.title)
      : null;
const theRun = (row) => (row.job?.title ? q(row.job.title) : "a run");

// A row whose action has no sentence yet keeps the words it was written with,
// as the log always showed them, without the 400 character cut.
function plainDetails(details) {
  if (!details) return "";
  if (typeof details === "string") return details;
  if (typeof details !== "object") return String(details);
  return ["duck", "name", "title", "reason", "board", "tool"]
    .map((key) => details[key])
    .filter((value) => typeof value === "string" && value)
    .join(" · ");
}

// action -> row -> what the line says. by: whose face starts the line.
// mark: the small sign in the face's corner, for what kind of thing it was.
const SENTENCES = {
  "Company created": (r) => ({
    mark: "plus",
    line: who(r) + " created " + (said(r) || "the company"),
  }),
  "Company set up": (r) => ({
    mark: "plus",
    line: who(r) + " set up " + (said(r) || "the company"),
  }),
  "Company settings updated": (r) => {
    const changed = Array.isArray(r.details?.changed) ? r.details.changed : [];
    if (changed.length === 1 && changed[0] === "paused")
      return {
        mark: "pause",
        line:
          who(r) +
          (r.details.paused
            ? " paused every duck"
            : " let the ducks work again"),
      };
    return { mark: "settings", line: who(r) + " changed the company settings" };
  },
  "Flock paused, runs stopped": (r) => ({
    mark: "pause",
    line:
      who(r) +
      " paused every duck and stopped " +
      count(Number(r.details?.runs) || 0, "run", "runs"),
  }),
  "Member permissions updated": (r) => ({
    mark: "person",
    line:
      who(r) +
      " changed what " +
      (named(r, field(r, "member")) || field(r, "name") || "a teammate") +
      " may do",
  }),
  "Teammate joined": (r) => ({ mark: "person", line: who(r) + " joined" }),
  "Teammate removed": (r) => ({
    mark: "person",
    line:
      who(r) +
      " removed " +
      (named(r, field(r, "member")) || field(r, "name") || "a teammate") +
      " from the company",
  }),
  "Invitation created": (r) => ({
    mark: "person",
    line: who(r) + " invited " + (said(r) || "somebody"),
  }),
  "Invitation sent again": (r) => ({
    mark: "person", line: who(r) + " sent the invitation to " + (said(r) || "somebody") + " again",
  }),
  "Invitation link copied": (r) => ({
    mark: "person", line: who(r) + " copied the invitation link for " + (said(r) || "somebody"),
  }),
  "Invitation revoked": (r) => ({
    mark: "person", line: who(r) + " revoked the invitation for " + (said(r) || "somebody"),
  }),
  "Company logo changed": (r) => ({mark: "settings", line: who(r) + " changed the company logo"}),
  "Company logo removed": (r) => ({mark: "settings", line: who(r) + " removed the company logo"}),
  "Board archived": (r) => ({
    mark: "task", line: who(r) + " archived the board " +
      (said(r) || "without a name").replace(/ \((\d+) stopped\)$/, (_, n) =>
        " (" + n + (n === "1" ? " duck run stopped)" : " duck runs stopped)")),
  }),
  "Board brought back": (r) => ({mark: "task", line: who(r) + " brought back the board " + (said(r) || "without a name")}),
  "Password changed": (r) => ({
    mark: "person",
    line: who(r) + " changed their password",
  }),
  "Two-step sign-in turned on": (r) => ({
    mark: "person",
    line: who(r) + " turned on two-step sign-in",
  }),
  "Two-step sign-in turned off": (r) => ({
    mark: "person",
    line: who(r) + " turned off two-step sign-in",
  }),
  "New two-step backup codes": (r) => ({
    mark: "person",
    line: who(r) + " made new backup codes for two-step sign-in",
  }),
  "Two-step sign-in turned off for a teammate": (r) => ({
    mark: "person",
    line:
      who(r) + " turned off two-step sign-in for " + (said(r) || "a teammate"),
  }),
  "Human wait settings updated": (r) => ({
    mark: "settings",
    line: who(r) + " changed how long ducks wait for them",
  }),
  "Work limits updated": (r) => ({
    mark: "settings",
    line: who(r) + " changed how long ducks may work on a run",
  }),
  "Computer policy updated": (r) => ({
    mark: "settings",
    line: who(r) + " changed the computer settings",
  }),
  "Company default AI model updated": (r) => ({
    mark: "settings",
    line: who(r) + " changed which AI model the ducks use",
  }),
  "Duck settings updated": (r) => ({
    mark: "settings",
    line:
      who(r) +
      " changed the settings of " +
      count(Number(r.details?.ducks) || 0, "duck", "ducks"),
  }),
  "Duck contact policy updated": (r) => ({
    mark: "settings",
    line: who(r) + " changed who " + duck(r) + " may contact",
  }),
  "Duck created": (r) => ({
    mark: "plus",
    line: who(r) + " added " + (r.duck?.name || said(r) || "a duck"),
  }),
  "Duck profile updated": (r) => ({
    mark: "settings",
    line:
      who(r) +
      " changed " +
      (r.duck?.name || said(r) || "a duck") +
      "’s profile",
  }),
  "Duck taken off the team": (r) => ({
    mark: "person",
    line: who(r) + " took " + duck(r) + " off the team",
  }),
  "Duck put back on the team": (r) => ({
    mark: "person",
    line: who(r) + " put " + duck(r) + " back on the team",
  }),
  "Duck skills updated": (r) => ({
    mark: "skill",
    line: r.details?.allowed
      ? who(r) + " let " + duck(r) + " use the skill " + field(r, "skill")
      : who(r) +
        " stopped " +
        duck(r) +
        " using the skill " +
        field(r, "skill"),
  }),
  "Duck run stopped": (r) => ({
    mark: "stop",
    line: who(r) + " stopped " + (r.duck ? duck(r) + "’s run" : "a duck’s run"),
    sub: r.job?.title ? q(r.job.title) : null,
  }),
  "Steered active reply": (r) => ({
    mark: "reply",
    line:
      who(r) +
      " interrupted " +
      (r.duck ? duck(r) : "a duck") +
      " with a new message",
    sub: r.job?.place || null,
  }),
  "Group chat created": (r) => ({
    mark: "chat",
    line: who(r) + " made the channel " + said(r),
  }),
  "Channel renamed": (r) => {
    const [was, now] = said(r).split(" → ");
    return {
      mark: "chat",
      line: now
        ? who(r) + " renamed the channel " + was + " to " + now
        : who(r) + " renamed a channel",
    };
  },
  "Channel members changed": (r) => ({
    mark: "chat",
    line: who(r) + " changed who is in " + said(r),
  }),
  "Channel archived": (r) => ({
    mark: "chat",
    line: who(r) + " archived the channel " + said(r),
  }),
  "Channel restored": (r) => ({
    mark: "chat",
    line: who(r) + " brought back the channel " + said(r),
  }),
  "Task created": (r) => ({
    mark: "task",
    line: who(r) + " made the task " + q(said(r)),
  }),
  "Task updated": (r) => ({
    mark: "task",
    line: who(r) + " changed the task " + q(field(r, "title")),
  }),
  "Workflow ticket created": (r) => ({
    mark: "task",
    line: who(r) + " made the ticket " + q(said(r)),
  }),
  "Workflow created": (r) => ({
    mark: "task",
    line: who(r) + " made the board " + said(r),
  }),
  "Workflow updated": (r) => ({
    mark: "task",
    line: who(r) + " changed the board " + said(r),
  }),
  "Scheduled task created": (r) => ({
    mark: "schedule",
    line: who(r) + " made the scheduled task " + q(said(r)),
  }),
  "Scheduled task updated": (r) => ({
    mark: "schedule",
    line: who(r) + " changed the scheduled task " + q(said(r)),
  }),
  "Scheduled task removed": (r) => ({
    mark: "schedule",
    line: who(r) + " removed the scheduled task " + q(said(r)),
  }),
  "Scheduled task request approved": (r) => ({
    mark: "schedule",
    line: who(r) + " allowed the scheduled task " + q(said(r)),
  }),
  "Scheduled task request declined": (r) => ({
    mark: "schedule",
    line: who(r) + " declined the scheduled task " + q(said(r)),
  }),
  "Document created": (r) => ({
    mark: "doc",
    line: who(r) + " made the document " + q(said(r)),
  }),
  "Document updated": (r) => ({
    mark: "doc",
    line: who(r) + " changed the document " + q(said(r)),
  }),
  "File deleted": (r) => ({
    mark: "doc",
    line: who(r) + " deleted the file " + said(r),
  }),
  "Skill created": (r) => ({
    mark: "skill",
    line: who(r) + " made the skill " + field(r, "name"),
  }),
  "Skill updated": (r) => ({
    mark: "skill",
    line: who(r) + " changed the skill " + field(r, "name"),
  }),
  "Skill removed": (r) => ({
    mark: "skill",
    line: who(r) + " removed the skill " + said(r),
  }),
  "Catalog skill added": (r) => ({
    mark: "skill",
    line: who(r) + " added the skill " + field(r, "name"),
  }),
  "Allowed Chief to change a board without asking": (r) => ({
    mark: "task",
    line:
      who(r) +
      " let " +
      chief(r) +
      " change the board " +
      field(r, "board") +
      " without asking",
  }),
  "Removed Chief permission to change a board": (r) => ({
    mark: "task",
    line:
      who(r) +
      " stopped " +
      chief(r) +
      " changing the board " +
      field(r, "board") +
      " without asking",
  }),
  "Human took control of computer": (r) => ({
    mark: "computer",
    line: who(r) + " took over " + duck(r) + "’s computer",
  }),
  "Took back an abandoned screen": (r) => ({
    mark: "computer",
    line: who(r) + " took over " + duck(r) + "’s computer",
  }),
  "Human typed into computer": (r) => ({
    mark: "computer",
    line: who(r) + " typed on " + duck(r) + "’s computer",
  }),
  "Human handed computer back to duck": (r) => ({
    mark: "computer",
    line: who(r) + " gave " + duck(r) + " its computer back",
  }),
  "Computer takeover preparation failed": (r) => ({
    mark: "computer",
    line: who(r) + " could not take over a duck’s computer",
  }),
  "Human completed private input request": (r) => ({
    mark: "computer",
    line: who(r) + " filled in what a duck asked for, privately",
  }),
  "Human cancel input request": (r) => ({
    mark: "computer",
    line: who(r) + " said no to a duck’s private request",
  }),
  "Human retry input request": (r) => ({
    mark: "computer",
    line: who(r) + " asked a duck to try its private request again",
  }),

  // Secrets and connections.
  "Secret saved": (r) => ({
    mark: "secret",
    line: who(r) + " saved the secret " + said(r),
  }),
  "Secret updated": (r) => ({
    mark: "secret",
    line: who(r) + " changed the secret " + said(r),
  }),
  "Secret deleted": (r) => ({
    mark: "secret",
    line: who(r) + " deleted the secret " + said(r),
  }),
  "Secrets saved": (r) => {
    const group = named(r, field(r, "group_id"));
    return {
      mark: "secret",
      line:
        who(r) +
        " saved " +
        count(Number(r.details?.count) || 0, "secret", "secrets") +
        (group ? " in " + group : ""),
    };
  },
  "Secrets moved": (r) => {
    const group = named(r, field(r, "group_id"));
    return {
      mark: "secret",
      line:
        who(r) +
        " moved " +
        count(Number(r.details?.count) || 0, "secret", "secrets") +
        (group ? " to " + group : " out of their group"),
    };
  },
  "Secret group created": (r) => ({
    mark: "secret",
    line: who(r) + " made the secret group " + said(r),
  }),
  "Secret group renamed": (r) => ({
    mark: "secret",
    line:
      who(r) +
      " renamed the secret group " +
      field(r, "from") +
      " to " +
      field(r, "to"),
  }),
  "Secret group removed": (r) => ({
    mark: "secret",
    line: who(r) + " removed the secret group " + said(r),
  }),
  "Duck saved a secret": (r) => ({
    by: "duck",
    mark: "secret",
    line: duck(r) + " saved the secret " + field(r, "name"),
    sub: forWhom(r),
  }),
  "Duck replaced a secret": (r) => ({
    by: "duck",
    mark: "secret",
    line: duck(r) + " changed the secret " + field(r, "name"),
    sub: forWhom(r),
  }),
  "Duck read a secret": (r) => ({
    by: "duck",
    mark: "secret",
    line: duck(r) + " read the secret " + field(r, "name"),
    sub: forWhom(r),
  }),
  "Duck used a secret": (r) => {
    const names = field(r, "names");
    return {
      by: "duck",
      mark: "secret",
      line:
        duck(r) +
        (names.includes(",") ? " used the secrets " : " used the secret ") +
        names,
      sub: forWhom(r),
    };
  },
  "MCP connection added": (r) => ({
    mark: "plug",
    line: who(r) + " added the connection " + said(r),
  }),
  "MCP connection created": (r) => ({
    mark: "plug",
    line: who(r) + " added the connection " + said(r),
  }),
  "MCP connection updated": (r) => ({
    mark: "plug",
    line: who(r) + " changed the connection " + said(r),
  }),
  "MCP connection removed": (r) => ({
    mark: "plug",
    line: who(r) + " removed the connection " + said(r),
  }),
  "MCP connection disconnected": (r) => ({
    mark: "plug",
    line: who(r) + " disconnected " + said(r),
  }),
  "MCP sign-in started": (r) => ({
    mark: "plug",
    line: who(r) + " started signing in to " + said(r),
  }),
  "MCP account connected": (r) => ({
    mark: "plug",
    line: who(r) + " signed in to " + said(r),
  }),
  "AI provider connected": (r) => ({
    mark: "plug",
    line:
      who(r) + " connected " + providerName(said(r) || field(r, "provider")),
  }),
  "AI provider disconnected": (r) => ({
    mark: "plug",
    line:
      who(r) + " disconnected " + providerName(field(r, "provider") || said(r)),
  }),
  "Ducks allowed to use a key": (r) => ({
    mark: "secret",
    line:
      who(r) +
      " let " +
      (field(r, "duck") || "ducks") +
      " use the key " +
      (field(r, "name") || "a key") +
      (field(r, "tool") ? " for " + field(r, "tool") : ""),
  }),
  "Duck allowed to use a connection": (r) => ({
    mark: "plug",
    line:
      who(r) +
      " let " +
      (r.duck?.name || field(r, "duck") || "a duck") +
      " use " +
      (field(r, "connection") || "a connection"),
  }),

  // What ducks did.
  "Duck finished a run": (r) => ({
    by: "duck",
    mark: "run",
    line:
      duck(r) +
      " finished " +
      theRun(r) +
      (r.job?.for ? " for " + r.job.for : ""),
  }),
  "Duck run needs attention": (r) => ({
    by: "duck",
    mark: "bad",
    line: duck(r) + " could not finish " + theRun(r),
    // The whole first line: it is what stopped the run, and it wraps.
    why: firstLine(said(r), 1000) || null,
    outcome: { tone: "bad", words: "Did not finish" },
  }),
  "Duck used computer": (r) => ({
    by: "duck",
    mark: "computer",
    line: duck(r) + " used its computer",
    sub: forWhom(r),
  }),
  "Duck used computer terminal": (r) => ({
    by: "duck",
    mark: "computer",
    line: duck(r) + " used its terminal",
    sub: forWhom(r),
  }),
  "Duck saved document": (r) => ({
    by: "duck",
    mark: "doc",
    line: duck(r) + " saved the document " + q(field(r, "title")),
    sub: forWhom(r),
  }),
  "Duck updated notes": (r) => ({
    by: "duck",
    mark: "doc",
    line: duck(r) + " updated its notes",
  }),
  "Duck updated task": (r) => ({
    by: "duck",
    mark: "task",
    line: duck(r) + " changed the task " + q(field(r, "title")),
  }),
  "Chief recruited a duck": (r) => ({
    by: "duck",
    mark: "plus",
    line: chief(r) + " added " + (said(r) || "a duck") + " to the team",
  }),
  "Chief updated a ticket": (r) => ({
    by: "duck",
    mark: "task",
    line:
      chief(r) +
      " changed " +
      (named(r, field(r, "task"))
        ? "the ticket " + q(named(r, field(r, "task")))
        : "a ticket"),
  }),
  "Chief delegated a task": (r) => ({
    by: "duck",
    mark: "task",
    line: chief(r) + " handed on the task " + q(said(r)),
  }),
  "Chief changed a board with standing permission": (r) => ({
    by: "duck",
    mark: "task",
    line: chief(r) + " changed the board " + field(r, "board"),
  }),
  "Duck used default model fallback": (r) => ({
    by: "duck",
    mark: "settings",
    line: duck(r) + " used the company’s AI model instead of its own",
    sub: forWhom(r),
  }),
  "Duck withdrew a request": (r) => ({
    by: "duck",
    mark: "schedule",
    line: duck(r) + " took back a request it had made",
  }),
  "Computer created": (r) => ({
    by: r.person ? "person" : "duck",
    mark: "computer",
    line: r.person
      ? who(r) + " started " + duck(r) + "’s computer"
      : duck(r) + "’s computer started",
  }),
  "Computer resumed": (r) => ({
    by: r.person ? "person" : "duck",
    mark: "computer",
    line: r.person
      ? who(r) + " started " + duck(r) + "’s computer"
      : duck(r) + "’s computer started",
  }),
  "Computer saving and stopping": (r) => ({
    by: r.person ? "person" : "duck",
    mark: "computer",
    line: r.person
      ? who(r) + " put " + duck(r) + "’s computer away"
      : duck(r) + "’s computer was put away",
  }),
  "Idle computer saving and stopping": (r) => ({
    by: "duck",
    mark: "computer",
    line: duck(r) + "’s computer was put away after sitting idle",
  }),
  "Screen given back after nobody came back": (r) => ({
    by: "duck",
    mark: "computer",
    line: duck(r) + " got its computer back after nobody came back to it",
  }),

  // Tool decisions whose record is gone: removing a connection deletes the
  // decisions made on it, and the log keeps this account of them.
  "Tool approval requested": (r) => ({
    by: "duck",
    mark: "tool",
    line: duck(r) + " asked to use " + q(plainly(field(r, "tool")) || "a tool"),
  }),
  "Connected tool executed": () => ({ hide: true }),
};
const TOOL_OUTCOMES = {
  executed: ["allowed", { tone: "done", words: "Done" }],
  denied: ["declined", { tone: "no", words: "Declined" }],
  changes_requested: [
    "asked for changes to",
    { tone: "unsure", words: "Changes asked" },
  ],
  failed: ["allowed", { tone: "bad", words: "Failed" }],
  unknown: ["allowed", { tone: "unsure", words: "Not sure it ran" }],
};

// What one row of the audit table says. row: {action, details (parsed), person,
// duck: {id,name}, chief: {id,name}, job: {title, for, place}, named: {id: name}}
export function sentence(row) {
  const action = String(row.action || "");
  const write = SENTENCES[action];
  if (write) return { by: "person", ...write(row) };
  const outcome = /^Tool approval (\w+)$/.exec(action);
  if (outcome && TOOL_OUTCOMES[outcome[1]]) {
    const [verb, pill] = TOOL_OUTCOMES[outcome[1]];
    return {
      by: "person",
      mark: "tool",
      line:
        who(row) +
        " " +
        verb +
        " " +
        q(
          field(row, "summary") ||
            plainly(field(row, "tool") || said(row)) ||
            "a tool",
        ),
      outcome: pill,
    };
  }
  const asked = /^Chief proposed (board|skill) (\w+)$/.exec(action);
  if (asked) {
    const [, thing, how] = asked;
    return {
      by: "duck",
      mark: thing === "board" ? "task" : "skill",
      line:
        chief(row) +
        (thing === "board"
          ? (how === "create"
              ? " asked to make the board "
              : " asked to change the board ") + field(row, "board")
          : how === "create"
            ? " asked to add the skill " + field(row, "name")
            : " asked to give the skill " +
              field(row, "name") +
              " to more ducks"),
    };
  }
  const answered = /^(Board|Skill) proposal (\w+)$/.exec(action);
  if (answered) {
    const [, thing, how] = answered;
    return {
      by: "person",
      mark: thing === "Board" ? "task" : "skill",
      line:
        who(row) +
        (how === "applied"
          ? " allowed "
          : how === "denied"
            ? " declined "
            : " asked for changes to ") +
        chief(row) +
        "’s " +
        (thing === "Board"
          ? "plan for the board " + field(row, "board")
          : "skill request" +
            (named(row, field(row, "skill"))
              ? " for " + named(row, field(row, "skill"))
              : "")),
    };
  }
  // Not written yet: the words it was written down with.
  const rest = plainDetails(row.details);
  return {
    by: row.person ? "person" : row.duck ? "duck" : "person",
    mark: "settings",
    line: (row.person ? row.person + ": " : "") + action,
    sub: rest || null,
  };
}

// A tool decision, from the approvals table. a: {tool, connection_name, args,
// status, result, duck, decider}.
export function decision(a) {
  const service = a.connection_name || "the service";
  const line = firstLine(a.summary, 120) || willDo(a);
  const asked = a.duck?.name || "A duck";
  const out = {
    by: "duck",
    mark: "tool",
    line,
    asked: askedFacts(a.args),
  };
  if (a.status === "cancelled")
    return {
      ...out,
      sub: asked + " asked",
      why: firstLine(a.result, 200) || null,
      outcome: { tone: "never", words: "Never used" },
    };
  const decider = a.decider || "Somebody";
  if (a.status === "denied")
    return {
      ...out,
      sub: asked + " asked · " + decider + " declined",
      outcome: { tone: "no", words: "Declined" },
    };
  // Sent back with a note; the duck asks again as a new ask.
  if (a.status === "changes_requested")
    return {
      ...out,
      sub: asked + " asked · " + decider + " asked for changes",
      why: firstLine(a.result, 200) || null,
      outcome: { tone: "unsure", words: "Changes asked" },
    };
  const allowed = asked + " asked · " + decider + " allowed it";
  if (a.status === "executed")
    return {
      ...out,
      sub: allowed,
      sent: sentBack(a.result),
      outcome: { tone: "done", words: "Done" },
    };
  if (a.status === "failed") {
    const reason = firstLine(replyText(a.result), 200);
    return {
      ...out,
      sub: allowed,
      why: reason ? service + " said: " + reason : null,
      outcome: { tone: "bad", words: "Failed" },
    };
  }
  // unknown: the one state in which nobody knows whether it happened.
  return {
    ...out,
    sub: allowed,
    why:
      (/restarted/i.test(String(a.result || ""))
        ? "TameDuck restarted while this ran. "
        : "It did not say whether it worked. ") +
      "Check " +
      service +
      " before asking again.",
    outcome: { tone: "unsure", words: "Not sure it ran" },
  };
}

// facts() gives named lines, some with lines of their own. The log shows them
// flat, a few at most, and leaves out ids nobody can read.
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function flat(lines, prefix = "", out = []) {
  for (const one of lines || []) {
    if (out.length >= 8) break;
    const name = (prefix ? prefix + " " : "") + one.name;
    if (one.parts) flat(one.parts, name, out);
    else if (/^id$/i.test(one.name) || ID.test(String(one.value))) continue;
    else
      out.push({
        name,
        value:
          one.value.length > 200 ? one.value.slice(0, 199) + "…" : one.value,
      });
  }
  return out;
}
export function askedFacts(args) {
  const lines = flat(facts(args));
  return lines.length ? lines : null;
}
// A connected service answers in an envelope: {content: [{type: "text", text}]}
// with the reply, often JSON of its own, inside the text.
function replyText(result) {
  let reply;
  try {
    reply = JSON.parse(result);
  } catch {
    return String(result || "");
  }
  const texts = Array.isArray(reply?.content)
    ? reply.content
        .filter((c) => c?.type === "text" && typeof c.text === "string")
        .map((c) => c.text)
    : [];
  return texts.join("\n");
}
export function sentBack(result) {
  let reply;
  try {
    reply = JSON.parse(result);
  } catch {
    return null;
  }
  if (reply?.structuredContent && typeof reply.structuredContent === "object") {
    const lines = flat(facts(JSON.stringify(reply.structuredContent)));
    if (lines.length) return { facts: lines };
  }
  const text = replyText(result).trim();
  if (!text) return null;
  const lines = flat(facts(text));
  if (lines.length) return { facts: lines };
  return { text: text.length > 300 ? text.slice(0, 299) + "…" : text };
}

// One day of folded work: "Ducks finished 7 runs", "Writer Duck 3, …".
export function foldWords(kind, byDuck, total) {
  const one = byDuck.length === 1 ? byDuck[0].name : null;
  const line =
    kind === "runs"
      ? (one || "Ducks") + " finished " + count(total, "run", "runs")
      : one
        ? one + " used its computer " + count(total, "time", "times")
        : "Ducks used their computers " + count(total, "time", "times");
  return {
    line,
    sub: one ? null : byDuck.map((d) => d.name + " " + d.count).join(", "),
  };
}
// One run inside the fold, after the duck's name in bold.
export function foldRun(row) {
  return (
    "finished " + theRun(row) + (row.job?.for ? " for " + row.job.for : "")
  );
}
export function foldComputer(n) {
  return "used its computer " + count(n, "time", "times");
}

// The heading of a day: "Today", "Wednesday 23 September".
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];
export function dayName(day, today) {
  const [y, m, d] = day.split("-").map(Number);
  const weekday = WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return (
    weekday +
    " " +
    d +
    " " +
    MONTHS[m - 1] +
    (today && today.slice(0, 4) !== day.slice(0, 4) ? " " + y : "")
  );
}
export function dayBefore(day) {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
}
export function dayHeading(day, today) {
  const date = dayName(day, today);
  if (day === today) return { title: "Today", date };
  if (day === dayBefore(today)) return { title: "Yesterday", date };
  return { title: date, date: "" };
}
