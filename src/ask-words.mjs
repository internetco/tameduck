// The words on the card every "may I?" is asked with - a skill or a board Chief
// has prepared, a tool a duck wants to use, a connection a duck stopped at -
// and the one line each leaves once it is answered. Kept apart from the card
// so tests/ask-words.test.mjs can check them without a browser. What Chief or
// a duck wrote is only ever put in as it is, as text.
import { askTitle, firstLine } from "./inbox-list.mjs";
import { fmtWhen, plural } from "./when.mjs";

// "A", "A and B", "A, B and C".
const join = (list) =>
  list.length < 2
    ? list.join("")
    : list.slice(0, -1).join(", ") + " and " + list[list.length - 1];

// Names in a sentence. After three it says how many more, so a card for a
// skill given to the whole flock stays one line.
export const names = (list = []) =>
  join(
    list.length > 3 ? [...list.slice(0, 3), list.length - 3 + " more"] : list,
  );

const gets = (list) =>
  names(list) + (list.length === 1 ? " gets it." : " get it.");

// A skill: what it is for, in Chief's words, and which ducks get it.
export function skillLines(p) {
  const lines = [];
  const use = firstLine(p.description, 160);
  if (use) lines.push({ icon: "BookOpen", text: use });
  const ducks = p.duck_names || [];
  if (ducks.length) {
    let who = gets(ducks);
    if (p.operation === "create" && p.enabled === false)
      who += " It starts switched off.";
    const already = p.operation === "assign" ? p.already_names || [] : [];
    if (already.length)
      who +=
        " " +
        names(already) +
        (already.length === 1 ? " already has it." : " already have it.");
    lines.push({ icon: "Users", text: who });
  }
  return lines;
}

// Who does each stage. The last stage is where tickets finish, so nobody
// works in it.
function workers(stages) {
  const work = stages.slice(0, -1);
  if (!work.length) return "";
  return (
    work
      .slice(0, 4)
      .map(
        (s) =>
          s.name +
          ": " +
          (s.duck || "a person") +
          (s.checkers?.length ? ", checked by " + names(s.checkers) : ""),
      )
      .join(". ") +
    "." +
    (work.length > 4 ? " And " + (work.length - 4) + " more." : "")
  );
}

// What a change to a board does, as one sentence. The same comparison the
// dialog behind "See all settings" draws.
export function boardChange(c = {}) {
  const parts = [
    c.renamed_from && "renames it from " + c.renamed_from,
    c.description && "changes its description",
    c.enabled === true
      ? "lets its ducks start on their own"
      : c.enabled === false && "stops its ducks starting on their own",
    c.auto_advance === true
      ? "moves tickets on by itself"
      : c.auto_advance === false && "stops moving tickets on by itself",
    c.added > 0 && "adds " + plural(c.added, "stage"),
    c.changed > 0 && "changes " + plural(c.changed, "stage"),
    c.removed > 0 && "removes " + plural(c.removed, "stage"),
    // A new order is only news of its own when nothing came or went.
    c.moved && !c.added && !c.removed && "puts the stages in a new order",
  ].filter(Boolean);
  if (!parts.length) return "Changes its settings.";
  const said = join(parts);
  return said[0].toUpperCase() + said.slice(1) + ".";
}

// A board: its stages, or what changes, and who does each stage.
export function boardLines(p) {
  const stages = p.stages || [];
  const first =
    p.operation === "update"
      ? boardChange(p.changes || {})
      : plural(stages.length, "stage") +
        ": " +
        (stages.length > 6
          ? stages
              .slice(0, 6)
              .map((s) => s.name)
              .join(", ") +
            " and " +
            (stages.length - 6) +
            " more"
          : stages.map((s) => s.name).join(", "));
  const who = workers(stages);
  return [
    { icon: "Columns3", text: first },
    ...(who ? [{ icon: "Users", text: who }] : []),
  ];
}

// Where a tool ask's data really goes. The title above it is the duck's own
// words; this line is the server's, so no wording can hide it.
export const toolLine = (a) => ({
  icon: "Send",
  text:
    (a.duck_name || "The duck") + " sends this to " + a.connection_name + ".",
});

// A duck stopped at a connection. The sentences it had in Needs you, word for
// word.
export function connectionLines(b, canIntegrate) {
  const allow = b.kind === "access",
    signIn = b.auth_type === "oauth";
  const lines = [
    {
      icon: "Plug",
      text: allow
        ? `${b.duck_name} is not allowed to use ${b.connection_name}, so it stopped. Allow it, and it carries on where it stopped.`
        : `${b.connection_name} stopped letting TameDuck in, so ${b.duck_name} is waiting. ${signIn ? "Sign in again" : "Add or choose its key"}, and it carries on where it stopped.`,
    },
  ];
  // Allow also shares the connection's saved key - without it the duck is
  // refused one step later - so it says so, to whoever can press it.
  if (canIntegrate)
    lines.push({
      icon: "KeyRound",
      text: !allow
        ? signIn
          ? "You sign in on the connection's own page."
          : "You add or choose its key on the connection's own page."
        : b.key_name
          ? `${b.duck_name} also gets its saved key, ${b.key_name}.`
          : `Only ${b.duck_name} gets access, and only to ${b.connection_name}.`,
    });
  return lines;
}

// What somebody who may not decide is told instead of the buttons.
export function cannot(kind, item = {}) {
  if (kind !== "connection")
    return "An owner or teammate with approval permission can approve this.";
  return item.kind === "access"
    ? "An owner or admin can allow this."
    : item.auth_type === "oauth"
      ? "An owner or admin can sign in again."
      : "An owner or admin can fix its key.";
}

// The one line an answered ask folds to: who answered, what it was, when, and
// how it went.
//   tone: yes, no, note, over or fail - the mark in front of it
//   lead: the bold part, rest: everything after it, link: where to go, if
//   anywhere
export function folded(
  kind,
  p,
  { me, duck = "The duck", exists = false, now } = {},
) {
  const by =
    p.decided_by && p.decided_by === me
      ? "you"
      : p.decided_by_name || "somebody";
  const when = p.updated ? fmtWhen(p.updated, now) : "";
  const what =
    kind === "skill"
      ? (p.operation === "create" ? "New skill " : "Skill ") +
        p.name +
        " for " +
        names(p.duck_names || [])
      : kind === "board"
        ? (p.operation === "create"
            ? "New task board "
            : "Changes to the task board ") + p.name
        : askTitle("approval", p);
  const line = (tone, lead, tail = "", link = null, timed = true) => ({
    tone,
    lead,
    rest: [what, timed && when, tail].filter(Boolean).join(" · "),
    link,
  });
  const approved = "Approved by " + by;
  switch (p.status) {
    case "applied":
    case "executed":
      return line(
        "yes",
        approved,
        "",
        !exists
          ? null
          : kind === "skill"
            ? {
                label: "Open skill",
                to: { type: "skills", id: p.result_skill_id },
              }
            : kind === "board"
              ? {
                  label: "Open board",
                  to: { type: "tasks", boardId: p.board_id },
                }
              : null,
      );
    case "executing":
      return line("yes", approved, "Running now");
    case "failed":
      return line("fail", approved, "It did not work");
    case "unknown":
      return line("fail", approved, "It may not have worked");
    case "denied":
      return line("no", "Declined by " + by);
    case "changes_requested":
      return line("note", "Changes asked for by " + by);
    case "superseded":
      return line("over", "Replaced", duck + " asked again below", null, false);
    case "cancelled":
      return line("over", "Called off", "The run was stopped first");
    case "expired":
      return line(
        "over",
        "Lapsed",
        "Nobody answered within a day",
        null,
        false,
      );
    default:
      return null;
  }
}

// What the toast says once an answer has gone.
export const toast = (
  decision,
  title,
  { duck = "the duck", always = false } = {},
) =>
  decision === "approve"
    ? always
      ? "Approved. Chief may now change this board without asking"
      : "Approved: " + title
    : decision === "changes"
      ? "Sent to " + duck
      : "Declined: " + title;
