// Needs you is two short lists: the ducks that cannot carry on until somebody
// acts, and everything else, to read when you like. Which list a thing belongs
// in, and the one line it gets, are the only decisions that page makes, so they
// are made here where tests/inbox-list.test.mjs can check them without a
// browser.

import { whoHasIt } from "./board-turn.mjs";

const at = (created) => Date.parse(created) || 0;
const pending = (rows) => (rows || []).filter((r) => r.status === "pending");
const nameOf = (data, duckId) =>
  (data.ducks || []).find((d) => d.id === duckId)?.name;

// A tool name is all the server knows about an approval, so it is all there is
// to put on the line - but said as a sentence rather than as itself. The card
// used to read "Run create_sales_invoice on Moneybird", which is a line written
// for the duck, not for the person deciding.
export function plainly(name) {
  const own =
    String(name || "")
      .split(/\.|__/)
      .filter(Boolean)
      .pop() || "";
  const words = own
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  return words ? words[0].toUpperCase() + words.slice(1) : "";
}

// What an approval will do, in the only words there are for it.
export function willDo(approval) {
  const what = plainly(approval.tool) || "Do something";
  return approval.connection_name
    ? what + " on " + approval.connection_name
    : what;
}

// The line an ask goes by: its card's title in chat, and its line here. A
// tool ask says it in the duck's own one plain line, first line only and cut;
// older asks, and a duck that left it out, keep the tool's name said as a
// sentence.
export function askTitle(kind, item, canIntegrate = false) {
  if (kind === "approval") return firstLine(item.summary, 120) || willDo(item);
  if (kind === "skill")
    return (
      (item.operation === "create"
        ? "Add a new skill: "
        : "Give ducks the skill: ") + item.name
    );
  if (kind === "board")
    return (
      (item.operation === "create"
        ? "Set up a new task board: "
        : "Change the task board: ") + item.name
    );
  // A key connection has no sign-in to do: it needs a working key.
  return item.kind === "access"
    ? item.duck_name + " wants to use " + item.connection_name
    : item.auth_type !== "oauth"
      ? item.connection_name + " needs a working key"
      : canIntegrate
        ? "Sign in to " + item.connection_name + " again"
        : item.connection_name + " needs someone to sign in again";
}

// One value, said the way somebody would say it out loud.
const said = (given) =>
  given === null || given === undefined
    ? "Nothing"
    : typeof given === "boolean"
      ? given
        ? "Yes"
        : "No"
      : String(given);
// One named line of the exact action. A value with parts of its own - the lines
// of an invoice - keeps them, as named lines under it: the same words the
// action really carries, without the braces and quotes they travelled in. The
// card used to print the whole thing as JSON, which is a thing written for a
// machine, shown to the person deciding whether to let it happen.
function fact(name, given) {
  if (!given || typeof given !== "object") return { name, value: said(given) };
  if (Array.isArray(given))
    // A list of plain things is one line, the way a list is read out. A list of
    // things with parts of their own is numbered, one line each.
    return given.every((one) => !one || typeof one !== "object")
      ? { name, value: given.length ? given.map(said).join(", ") : "Nothing" }
      : { name, parts: given.map((one, i) => fact(String(i + 1), one)) };
  const named = Object.entries(given);
  return named.length
    ? { name, parts: named.map(([key, one]) => fact(plainly(key), one)) }
    : { name, value: "Nothing" };
}
// The exact action as plain lines instead of the JSON it arrives in.
export function facts(args) {
  let value;
  try {
    value = JSON.parse(args);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return Object.entries(value).map(([key, one]) => fact(plainly(key), one));
}

// The first thing a message says, as its line. A message has no title, and the
// words somebody actually wrote are the truest short thing there is.
export function firstLine(body, limit = 96) {
  const line =
    String(body || "")
      .split("\n")
      .map((one) =>
        one
          .replace(/^\s*(?:#{1,6}|>|[-*+]|\d+[.)])\s+/, "")
          .replace(/[*_`~]/g, "")
          .trim(),
      )
      .find(Boolean) || "";
  return line.length > limit
    ? line.slice(0, limit).replace(/\s+\S*$/, "") + "…"
    : line;
}

// What is left of a message once its first line has become the line above it.
// A message of one sentence has nothing left, and does not need to say the same
// thing twice.
export function theRest(body) {
  const lines = String(body || "").split("\n");
  const first = lines.findIndex((one) => one.trim());
  return first < 0
    ? ""
    : lines
        .slice(first + 1)
        .join("\n")
        .replace(/^\s+/, "");
}

// Whether a line is asking for an AI to be connected.
export const asksForAI = (message) =>
  /\bAI (account|connection)\b/i.test(message.needs_you || "");

// A line that names somewhere to go should lead there. The welcome message asks
// for an AI connection and the card's one blue button said "Reply in thread",
// which goes to the words about the place rather than to the place. Only for
// somebody who can connect one: a paused schedule tells members too. A paused
// schedule is turned back on in the scheduled tasks, by somebody who works on
// tasks - after an AI is connected, when that is why it stopped.
const connectAI = {
  label: "Connect an AI",
  to: { type: "settings", tab: "ai" },
};
export const pausedSchedule = (message) =>
  String(message.origin || "").startsWith("schedule-paused:");
// A duck asking on a ticket is answered on the ticket: its chat is the
// ticket's own, hidden one, and a reply there never reached the ticket. It
// used to lead there only when the ticket was on a board.
export function placeFor(message, canConnect = true, canSchedule = true, aiReady = false) {
  if (pausedSchedule(message)) {
    if (asksForAI(message) && canConnect && !aiReady) return connectAI;
    // To that schedule's own page, where it is turned back on.
    if (canSchedule)
      return {
        label: "Open scheduled tasks",
        to: {
          type: "tasks",
          scheduled: true,
          scheduleId: String(message.origin).slice("schedule-paused:".length),
        },
      };
  } else if (asksForAI(message) && canConnect) return connectAI;
  if (message.task_id)
    return {
      label: "Open the ticket",
      to: {
        type: "tasks",
        ...(message.board_id ? { boardId: message.board_id } : {}),
        id: message.task_id,
      },
    };
  return null;
}

// Why a message is in the list it is in, said under it. A paused schedule is
// waiting for somebody to turn it back on, not for anybody's reply.
export function whyHere(message, name, aiReady = false) {
  if (!message.needs_you)
    return message.duck_id ? name + " is not waiting for this." : "";
  if (pausedSchedule(message))
    return asksForAI(message) && !aiReady
      ? "It stays paused until an AI is connected and somebody turns it back on."
      : "It stays paused until somebody turns it back on.";
  if (asksForAI(message)) return "No duck can answer until this is done.";
  if (message.task_id)
    return name + " is waiting for your answer on the ticket.";
  return name + " is waiting for your reply.";
}

// A form somebody had started typing into, whose wait has since run out. It
// used to drop off the list at that moment, and the words went with it. It
// stays, until they take it off, unless it was finished or stopped. "Still
// waiting" is the rule waitingOnYou in ui.jsx uses, so a line is never here
// twice.
export function heldRequests(data, typed, now = Date.now()) {
  return (data.human_requests || []).filter(
    (r) =>
      typed.has(r.id) &&
      r.kind !== "takeover" &&
      !(
        ["pending", "preparing", "desktop", "submitting"].includes(r.status) &&
        r.expires > now
      ) &&
      !["completed", "cancelled"].includes(r.status),
  );
}

// The tickets waiting for this person, decided by the same rule the board uses
// for its "Your turn": stuck or sent back for changes on a ticket they run, or a
// step that is theirs to do. Needs you used to hear about a ticket only through
// a message the duck left, so the two could not agree: answering that message
// in chat took it off the list and left the ticket stuck, a ticket sent back
// for changes was never listed at all, and the board said "Your turn" beside a
// Needs you that said nothing was waiting.
export function ticketsForMe(data) {
  const w = data.workflows || {};
  const out = [];
  for (const ticket of w.tickets || []) {
    const board = (w.boards || []).find((b) => b.id === ticket.board_id);
    const task = (data.tasks || []).find((x) => x.id === ticket.task_id);
    if (!board || board.legacy || board.archived || !task) continue;
    const columns = (w.columns || [])
      .filter((c) => c.board_id === board.id)
      .sort((a, b) => a.position - b.position);
    const index = columns.findIndex((c) => c.id === ticket.column_id);
    const now = whoHasIt({
      ticket,
      task,
      column: columns[index] || {},
      isLast: index === columns.length - 1,
      legacy: false,
      runs: w.runs,
      ducks: data.ducks,
      members: data.members,
      me: data.user?.id,
      canDoTasks: data.permissions?.tasks,
    });
    if (now.kind !== "you" && !now.mine) continue;
    // A duck waiting for this person on its screen already has its own line,
    // the one that opens the screen. The ticket saying so as well is the same
    // thing twice.
    const onScreen = (w.runs || []).some(
      (r) =>
        r.task_id === ticket.task_id &&
        r.column_id === ticket.column_id &&
        r.revision === ticket.revision &&
        r.status === "waiting_human",
    );
    if (onScreen) continue;
    const why =
      now.kind === "stuck"
        ? now.status === "Changes requested"
          ? "changes"
          : "stuck"
        : ticket.state === "ready_to_move"
          ? "move"
          : "step";
    out.push({ ticket, task, board, column: columns[index] || null, now, why });
  }
  return out;
}

// Everything on the page, sorted into the two lists. `requests` is the ducks
// stopped on a screen - the same list the sidebar number counts, handed in so
// the page and the number beside it cannot drift apart.
export function inboxRows(data, requests = []) {
  const waiting = [];
  const tickets = ticketsForMe(data);
  const recoveryRows = data.recovery_attention || [];
  // A board ticket's own message about being blocked. Once the ticket has its
  // line here, the message is the same thing said twice. (Once the ticket
  // moves on, the server takes the message off the list.)
  const listed = new Set(tickets.map((x) => x.task.id));
  const saidElsewhere = (m) => m.needs_you && listed.has(m.task_id);
  // A duck stopped at a connection, as one line with the button that fixes
  // it. Its message about it, and its stuck ticket, would say the same thing
  // again without the button.
  const stoppedAt = data.connection_blocks || [];
  const toldAbout = new Set(stoppedAt.flatMap((b) => b.message_ids || []));
  const ticketStopped = new Set(stoppedAt.flatMap((b) => b.task_ids || []));
  const recoveryTasks = new Set(recoveryRows.map((r) => r.task_id).filter(Boolean));
  for (const r of recoveryRows) {
    waiting.push({
      id: "recovery:" + r.job_id,
      kind: "recovery",
      at: at(r.updated || r.next_attempt_at),
      duckId: r.duck_id,
      name: r.task_title || "Unfinished work",
      ask: "Needs attention: " + (r.task_title || nameOf(data, r.duck_id) || "Unfinished work"),
      item: r,
    });
  }
  for (const b of stoppedAt)
    waiting.push({
      id: "connection:" + b.id,
      kind: "connection",
      at: at(b.created),
      duckId: b.duck_id,
      name: b.duck_name,
      // A key connection has no sign-in to do: it needs a working key.
      ask: askTitle("connection", b, !!data.permissions?.integrations),
      item: b,
    });
  for (const x of tickets) {
    if (recoveryTasks.has(x.task.id)) continue;
    if (ticketStopped.has(x.task.id)) continue;
    const note = (data.inbox || []).find(
      (m) => m.task_id === x.task.id && m.needs_you,
    );
    waiting.push({
      id: "ticket:" + x.task.id,
      kind: "ticket",
      at: at(x.ticket.updated || x.task.updated || x.task.created),
      duckId: x.column?.duck_id || note?.duck_id || null,
      name: x.board.name,
      ask:
        {
          stuck: "Stuck: ",
          changes: "Changes requested: ",
          move: "Ready to move on: ",
          step: "Your step: ",
        }[x.why] + x.task.title,
      // "Stuck" is already the line above it.
      said: (x.ticket.error || note?.body || "").replace(
        /^blocked[:.\s-]*/i,
        "",
      ),
      item: x,
    });
  }
  for (const r of requests)
    waiting.push({
      id: "request:" + r.id,
      kind: "request",
      at: at(r.created),
      duckId: r.duck_id,
      name: nameOf(data, r.duck_id) || "Your duck",
      ask: r.title,
      item: r,
    });
  for (const a of pending(data.approvals))
    waiting.push({
      id: "approval:" + a.id,
      kind: "approval",
      at: at(a.created),
      // An approval arrives with the duck's name and not its id, so the face is
      // found by name. A duck renamed since shows its initial instead.
      duckId: (data.ducks || []).find((d) => d.name === a.duck_name)?.id,
      name: a.duck_name || "A duck",
      ask: askTitle("approval", a),
      item: a,
    });
  for (const p of pending(data.skill_proposals))
    waiting.push({
      id: "skill:" + p.id,
      kind: "skill",
      at: at(p.created),
      duckId: p.duck_id,
      name: nameOf(data, p.duck_id) || "Chief Duck",
      ask: askTitle("skill", p),
      item: p,
    });
  for (const p of pending(data.board_proposals))
    waiting.push({
      id: "board:" + p.id,
      kind: "board",
      at: at(p.created),
      duckId: p.duck_id,
      name: nameOf(data, p.duck_id) || "Chief Duck",
      ask: askTitle("board", p),
      item: p,
    });
  for (const p of pending(data.schedule_proposals))
    waiting.push({
      id: "schedule:" + p.id,
      kind: "schedule",
      at: at(p.created),
      duckId: p.duck_id,
      name: nameOf(data, p.duck_id) || "A duck",
      ask:
        p.operation === "remove"
          ? "Stop doing “" + p.title + "” regularly?"
          : p.operation === "update"
            ? "Change “" + (p.before?.title || p.title) + "”?"
          : "Do “" +
            p.title +
            "” " +
            String(p.how_often || "").replace(/^./, (c) => c.toLowerCase()) +
            "?",
      item: p,
    });
  // A duck only puts a message in this list when it needs an answer, so that is
  // what tells the two lists apart: a reason means somebody is held up by it.
  const later = [];
  for (const m of data.inbox || []) {
    if (saidElsewhere(m) || toldAbout.has(m.id)) continue;
    const name = m.duck_name || m.user_name || "Teammate";
    // Past 800 characters a message is a conversation, and the line leads to
    // the chat it came from.
    const whole = String(m.body || "");
    const body = whole.length > 800 ? whole.slice(0, 800) + "…" : whole;
    const first = firstLine(body);
    const row = {
      id: "message:" + m.id,
      kind: "message",
      at: at(m.created),
      duckId: m.duck_id,
      name,
      ask: m.needs_you || first || "A message from " + name,
      // A line that had to be cut short keeps the whole message under it. A
      // message that is only its question has nothing more to say under it.
      said: m.needs_you
        ? body.trim() === m.needs_you.trim()
          ? ""
          : body
        : !first || first.endsWith("…")
          ? body
          : theRest(body),
      item: m,
    };
    (m.needs_you ? waiting : later).push(row);
  }
  // A duck stopped on a screen is the only thing here with a clock running, so
  // it goes first. Everything else is newest first.
  waiting.sort(
    (one, two) =>
      (two.kind === "request") - (one.kind === "request") || two.at - one.at,
  );
  later.sort((one, two) => two.at - one.at);
  return { waiting, later };
}
