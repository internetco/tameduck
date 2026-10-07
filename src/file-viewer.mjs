// What the file viewer says, worked out without a browser so it can be tested.
import { columnLabel } from "./csv.mjs";
import { conversationName, conversationPeer } from "./chat-utils.mjs";

const count = (n, word) => n + " " + word + (n === 1 ? "" : "s");

// Row 1 of a spreadsheet a duck hands back is nearly always the names of its
// columns. Shown as a row under the letters A, B, C, the names scrolled away
// with everything else and "65 rows" counted them as a customer.
export function headedSheet(rows) {
  const width = Math.max(0, ...rows.map((row) => row.length));
  const names = Array.from({ length: width }, (_, c) => rows[0]?.[c] ?? "");
  return { names, body: rows.slice(1), width };
}

export const sheetSize = (rows, columns) =>
  count(rows, "row") + " · " + count(columns, "column");

// The strip over the grid. A grid wider than the window says there is more to
// the side until there is not: a tablet showed a one-letter sliver of Notes
// under "64 rows · 8 columns", and nothing else. A phone or a tablet is
// swiped, anything with a mouse is scrolled.
export function sheetStrip({ rows, columns, narrow, touch, wider, atEnd }) {
  if ((narrow || touch) && wider)
    return atEnd
      ? "Swiped to the last column"
      : count(rows, "row") + " · swipe sideways for more";
  if (wider && !atEnd)
    return sheetSize(rows, columns) + " · scroll sideways for more";
  return sheetSize(rows, columns);
}
export const pickHint = (touch) =>
  (touch ? "Tap" : "Click") + " a cell to read all of it";

// A column as wide as what is in it, and its name in at most two lines. Every
// column used to be at least 120px, so a two-digit count took as much room as
// a name and an eight-column list did not fit a laptop. None is wider than
// 320px (less on a phone, so any one column fits beside the pinned first); a
// longer cell shows whole when it is picked. The browser passes the real
// width of the words in its own font; without one, a letter is taken as 7px.
const PAD = 24,
  NARROWEST = 56;
const guess = (text) => text.length * 7;
export function fitWidths({ names, body, width }, measure = guess, most = 320) {
  const widest = (texts, weight, size) =>
    Math.max(0, ...texts.map((text) => measure(text, weight, size)));
  return Array.from({ length: width }, (_, c) => {
    const inside = widest(
      body.flatMap((row) => String(row[c] ?? "").split(/\r?\n/)),
      c === 0 ? 600 : 400,
      13,
    );
    const heading = String(names[c] ?? "");
    const name = Math.max(
      widest(heading.split(/\s+/), 650, 12.5),
      measure(heading, 650, 12.5) / 2 + 8,
    );
    return Math.max(
      NARROWEST,
      Math.min(most, Math.ceil(PAD + Math.max(inside, name))),
    );
  });
}

// How wide the table is drawn. One that fits the window stretches its last
// column to the edge. One wider than the window is swiped to its end with its
// first column pinned (and the row numbers, which are "pinned" wide), and what
// would show there as a sliver of a column cut off goes to the last column
// instead, so a phone swiped to the end shows the name and the notes whole.
export function sheetWidth(widths, pinned, room) {
  const fitted = pinned + widths.reduce((sum, w) => sum + w, 0);
  if (fitted <= room || widths.length < 2) return fitted;
  const beside = room - pinned - widths[0];
  let whole = 0;
  for (let c = widths.length - 1; c > 0 && whole + widths[c] <= beside; c--)
    whole += widths[c];
  return fitted + (whole ? beside - whole : 0);
}

// A sheet a little wider than the window: on a laptop 1024-1270px wide the
// eight columns were 1160px in 1066, and Notes ran off the edge mid-word. Its
// last column, when that is words, gives up what the others need and ends in
// "..." at the edge. Under 120px it would say nothing, so then the sheet is
// scrolled sideways instead, and a column of numbers is never cut short.
const FEWEST = 120;
export function fitToRoom(widths, pinned, room, lastIsNumber) {
  if (!room || widths.length < 2 || lastIsNumber) return widths;
  const others = pinned + widths.slice(0, -1).reduce((sum, w) => sum + w, 0);
  const left = Math.floor(room - others);
  if (left >= widths[widths.length - 1] || left < FEWEST) return widths;
  return [...widths.slice(0, -1), left];
}

// Counts, amounts and prices line up on the right, the way a sheet shows them.
const NUMBER = /^[-+]?[€$£]?\s?\d[\d.,\s]*%?$/;
export function numberColumns({ body, width }) {
  return Array.from({ length: width }, (_, c) => {
    const filled = body
      .map((row) => String(row[c] ?? "").trim())
      .filter(Boolean);
    return filled.length > 0 && filled.every((value) => NUMBER.test(value));
  });
}

// What the panel under the grid is headed with: the column's name and, beside
// it, the row's own name from the first column, so "Closed 14-28 October" says
// which customer it is about.
export function cellHeading({ names, body }, r, c) {
  const column = names[c] || "Column " + columnLabel(c);
  const row = String(body[r]?.[0] ?? "").trim();
  return c === 0 || !row ? column : column + " · " + row;
}

// Where a file was shared, in the three ways the viewer needs it: short for a
// phone's narrow line ("# operations"), as words in the top line's sentence,
// the middle one in bold ("in ", "# operations", ""), and for the question
// asked before deleting it. A chat with one person or one duck has no "#", and
// "Finance Duck shared it in Finance Duck" would say nothing.
//
// from is whoever shared it ({user_id} or {duck_id}). Whether that is the one
// on the other side of a chat of two is told by id: by name, a teammate who
// has left was "Teammate" on one side and "Former teammate" on the other, and
// read as two people.
export function sharedWhere({ conversation, task, data, from }) {
  if (task)
    return {
      label: task.title + " ticket",
      words: ["on the ", task.title, " ticket"],
      loses: "Everyone on the " + task.title + " ticket loses it",
    };
  if (!conversation) return null;
  if (conversation.kind === "group") {
    const channel = "# " + conversation.name;
    return {
      label: channel,
      words: ["in ", channel, ""],
      loses: "Everyone in " + channel + " loses it",
    };
  }
  const human = conversation.kind === "human";
  // Someone who has left is not named again: they cannot open it any more.
  const other = human
    ? conversationPeer(conversation, data)?.name
    : conversationName(conversation, data);
  const person =
    !!from?.user_id && data.members.some((m) => m.id === from.user_id);
  const theirs = human
    ? !!from?.user_id && from.user_id !== data.user.id
    : !person && (conversation.ducks || []).includes(from?.duck_id);
  const yours = { label: "your chat", words: ["in your chat", "", ""] };
  if (!other) return { ...yours, loses: "You lose it" };
  const loses = "You and " + other + " lose it";
  return theirs
    ? { ...yours, loses }
    : {
        label: "chat with " + other,
        words: ["in your chat with ", other, ""],
        loses,
      };
}

// Show in chat lands on the message the file came in, inside its thread when
// it was a reply there - the jump Search makes. A file on a ticket goes to the
// ticket, the way its row in Files does.
export function placeToShow({ conversationId, taskId, messageId, threadId }) {
  if (taskId)
    return { label: "Show in ticket", view: { type: "tasks", id: taskId } };
  if (!conversationId) return null;
  return {
    label: "Show in chat",
    view: {
      type: "chat",
      id: conversationId,
      ...(threadId ? { threadId } : {}),
      ...(messageId ? { at: messageId } : {}),
    },
  };
}

// Who shared it, the way Files says it: a person by name, a duck by name and
// face. A teammate who has left keeps a word rather than a blank.
export function sharerOf(from, data) {
  if (!from) return null;
  const duck = data.ducks.find((d) => d.id === from.duck_id);
  const person = data.members.find((m) => m.id === from.user_id);
  if (from.user_id && person) return { name: person.name };
  if (duck) return { duck, name: duck.name };
  return from.user_id ? { name: "Teammate" } : null;
}

// A screenshot's caption, as the name of the copy it is saved under.
export const savedName = (name, ending) =>
  new RegExp("\\" + ending + "$", "i").test(name) ? name : name + ending;

// The question before a delete. Nothing that can be brought back.
export const deleteWarning = (where) =>
  (where ? where.loses : "Everyone who can see it loses it") +
  ". This cannot be undone.";

// Why a delete did not happen. The server says why it refused in words meant
// for people; a request that never reached it did not say the file is still
// there (it once showed the browser's own "Failed to fetch").
export const deleteProblem = (error) =>
  error?.status
    ? error.message
    : "The file was not deleted. Check your connection and try again.";
