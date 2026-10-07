// The join page's words that are worked out rather than written down. Kept
// apart from the page so they can be read and checked without a browser, the
// way member-permissions.mjs keeps the permissions dialog's.
import { plural } from "./when.mjs";

// What joining as each role gives. Exact, because an invitation always
// carries permissions '{}', so the person gets the role's defaults:
// ROLE_DEFAULTS in member-permissions.mjs. A viewer sees every task and file
// and the chats they are in, and cannot chat, add tasks or edit documents. If
// invitations ever carry their own permissions, build these lines from them.
const CARDS = {
  member: {
    title: "You join as a Member",
    line: "You can talk to the ducks, work on tasks and write documents.",
  },
  admin: {
    title: "You join as an Admin",
    line: "You can do what a member can, and also make ducks, connect outside tools and invite people.",
  },
  viewer: {
    title: "You join as a Viewer",
    line: "You can read the task board, the files and your chats, but not change anything.",
  },
};
export const roleCard = (role) =>
  Object.hasOwn(CARDS, role) ? CARDS[role] : CARDS.member;

// "Robin, Sam and 5 ducks": up to three first names, the owner first, then
// how many more people, then the ducks on the team.
export function whoIsThere({ people = [], more_people = 0, duck_count = 0 }) {
  const parts = [...people];
  if (more_people)
    parts.push(
      more_people + (more_people === 1 ? " more person" : " more people"),
    );
  if (duck_count) parts.push(plural(duck_count, "duck"));
  return parts.length > 1
    ? parts.slice(0, -1).join(", ") + " and " + parts.at(-1)
    : parts.join("");
}

// A link too short to be one: most of it was lost on the way. The words /enter
// uses for the same thing.
export const INCOMPLETE =
  "The whole link has to arrive in one piece. Some mail apps cut the end off.";
