// What the Members dialog says about a channel: who is in it, who made it, and
// who may change it. Kept apart from the dialog so every sentence can be
// checked without a browser. Who may do what is the server's rule
// (server/chat.mjs): taking somebody else out, renaming and archiving belong to
// whoever made the channel or an admin; adding anyone, removing a duck and
// leaving belong to anybody in it who may chat.

export const firstName = (name = "") => name.trim().split(/\s+/)[0] || name;

// The people and the ducks in the channel, you first. `ducks` is the flock:
// a duck taken off the team stays on the channel so it can be put back, and
// is shown nowhere.
export function channelLists({ members, ducks, me }, channel) {
  const people = members.filter((m) => channel.members.includes(m.id));
  return {
    people: [
      ...people.filter((m) => m.id === me),
      ...people.filter((m) => m.id !== me),
    ],
    ducks: ducks.filter((d) => channel.ducks.includes(d.id)),
  };
}

// Who made it, from the creator_id sent with every channel. `person` is null
// when they are no longer in the company. `here` is whether they are still in
// the channel: only people in it may change it, so a maker who left is named
// in the head but is not who to ask.
export const maker = ({ members, me }, channel) => ({
  mine: channel.creator_id === me,
  person: members.find((m) => m.id === channel.creator_id) || null,
  here: channel.members.includes(channel.creator_id),
});
const boss = (made) => (made.here ? made.person : null);

// "Made by you on 3 March · 6 members". The day in English whatever the
// browser's language, since the sentence around it is English.
export function headLine(channel, lists, made, now = new Date()) {
  const n = lists.people.length + lists.ducks.length;
  const count = n + (n === 1 ? " member" : " members");
  if (channel.archived) return "Archived · " + count;
  const at = new Date(channel.created);
  const on = at.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    ...(at.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}),
  });
  const by = made.mine ? "you" : made.person?.name;
  return (by ? "Made by " + by + " on " : "Made on ") + on + " · " + count;
}

// The line under "People": who may take somebody out, and why.
export function peopleRule({ chat, runs }, made) {
  if (!chat) return "";
  if (made.mine) return "You made this channel, so you can remove people.";
  if (runs) return "You are an admin, so you can remove people.";
  if (boss(made))
    return (
      made.person.name +
      " made this channel, so only " +
      firstName(made.person.name) +
      " or an admin can remove people."
    );
  return "Only an admin can remove people.";
}

export const duckRule = ({ chat }) =>
  chat ? "Anyone in the channel can add or remove a duck." : "";

// Somebody who may not rename or archive is told who can.
export const onlyWho = (made, what) =>
  (boss(made)
    ? "Only " + firstName(made.person.name) + " or an admin"
    : "Only an admin") +
  " can " +
  what +
  " it.";

// The words beside Leave in the foot, if any.
export function footLine({ chat, runs }, made, alone) {
  if (!chat) return "You can read this channel, but not change who is in it.";
  return [
    runs ? "" : onlyWho(made, "rename or archive"),
    alone ? "You are the only person here, so you cannot leave." : "",
  ]
    .filter(Boolean)
    .join(" ");
}

// Letters without their accents, so "daniel" finds Daniëlle.
const plainLetters = (s = "") =>
  s
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();

// Everybody at the company who is not in yet, and every duck, that the typed
// words find. Nobody is added until Add is pressed beside them. `kept` are the
// ones just added: they stay where they were, saying so, until the search
// changes, so that the next row never slides under the pointer.
export function toAdd({ members, ducks }, channel, query, kept = []) {
  const q = plainLetters(query.trim());
  const finds = (...words) => words.some((w) => plainLetters(w).includes(q));
  const people = members.filter((m) => !channel.members.includes(m.id));
  const out = ducks.filter((d) => !channel.ducks.includes(d.id));
  const shown = (list, inside) =>
    list.filter((x) => !inside.includes(x.id) || kept.includes(x.id));
  return {
    anyone: people.length + out.length > 0,
    people: shown(members, channel.members).filter((m) =>
      finds(m.name, m.email),
    ),
    ducks: shown(ducks, channel.ducks).filter((d) => finds(d.name)),
  };
}

// Spaces and marks nobody can see, such as a zero-width space, are no name.
export const blank = (name) => !name.replace(/[\s\p{Cf}]/gu, "");

// A request that never reached the server has only the browser's own words,
// such as "Failed to fetch".
export const plain = (err) =>
  err.status
    ? err
    : new Error("Nothing changed. Check your connection and try again.");

// What pressing Remove beside somebody asks, in their own row.
export function removeAsk(who, kind) {
  const short = kind === "duck" ? who.name : firstName(who.name);
  return {
    title: "Remove " + who.name + "?",
    what:
      kind === "duck"
        ? who.name + " stops answering here. Everything it wrote stays."
        : "The channel goes from " +
          short +
          "’s sidebar, and so does anything in it waiting for " +
          short +
          ".",
    keep: "Keep " + short,
    remove: "Remove " + short,
  };
}
