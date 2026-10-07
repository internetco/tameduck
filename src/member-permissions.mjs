// The words behind "What a teammate may do", and the two sums that dialog
// does. Kept apart from the dialog so they can be read and checked without a
// browser, the way Settings > Ducks keeps its own.

// The eleven things a company decides about a person, under the three plain
// headings an owner would sort them into. Each line carries the name of the
// thing, the one line of help read beside it, and the way the switch is said
// out loud after the person's name.
//
// The names are the owner's words, not the code's. The list used to offer
// "Manage MCP connections and secrets" - a protocol, named in the dialog where
// an office manager decides who may touch the company's keys - and "Approve
// connected tool actions and skill proposals", which is forty-nine characters
// and wrapped to two lines.
export const MEMBER_GROUPS = [
  {
    name: "Working together",
    permissions: [
      {
        key: "chat",
        name: "Chat with the ducks",
        help: "Ask a duck for something, and read the reply.",
        said: "chat with the ducks",
      },
      {
        key: "tasks",
        name: "Put work on the board",
        help: "Add work, change it and tick it off.",
        said: "put work on the board",
      },
      {
        key: "docs",
        name: "Write and edit documents",
        help: "Any document in the company’s files.",
        said: "write and edit documents",
      },
    ],
  },
  {
    name: "Running the flock",
    permissions: [
      {
        key: "ducks",
        name: "Make new ducks",
        help: "Add a duck, and change its name and its job.",
        said: "make new ducks",
      },
      {
        key: "skills",
        name: "Give ducks new skills",
        help: "Write a skill and hand it to a duck.",
        said: "give ducks new skills",
      },
      {
        key: "computers",
        name: "Use the company computers",
        help: "Open a duck’s computer and work on it.",
        said: "use the company computers",
      },
      {
        key: "approvals",
        name: "Answer when a duck asks",
        help: "Say yes or no while a duck waits for a person.",
        said: "answer when a duck asks",
      },
    ],
  },
  {
    // The only group that says anything under its name, because it is the one
    // holding the things nobody wants to hand over by accident.
    name: "The company itself",
    help: "Its money, its keys, and who else gets in.",
    permissions: [
      {
        key: "billing",
        name: "Pay the bills",
        help: "See the plan and invoices, and change the card.",
        said: "pay the bills",
      },
      {
        key: "integrations",
        name: "Connect outside tools, and see the keys",
        // For an admin it is also the AI: shared/ai-access.mjs.
        help: "Passwords and keys the whole company shares. An admin with this can also connect the AI.",
        said: "connect outside tools and see the keys",
      },
      {
        key: "team",
        name: "Invite people",
        help: "Send someone a link to join this company.",
        said: "invite people",
      },
      {
        key: "company",
        name: "Set the house rules, and stop every duck",
        help: "What every duck must do — and the stop switch.",
        said: "set the house rules and stop every duck",
      },
    ],
  },
];
// Every line in one list, for saving and for the sums. The groups are the only
// place the eleven are written down.
export const MEMBER_PERMISSIONS = MEMBER_GROUPS.flatMap((g) => g.permissions);
// All eleven answer the same question, so the two words are said once here
// rather than eleven times above.
export const ON = "Allowed";
export const OFF = "Off";

// One line names the company, because "a link to join Northgate" is what a
// person would say and "a link to join this company" is what a form would.
export const helpFor = (permission, company) =>
  permission.key === "team" && company
    ? "Send someone a link to join " + company + "."
    : permission.help;

// The three roles, and what each one fills the switches in with. These are the
// dialog's own defaults, unchanged: the server keeps a copy of its own for a
// teammate whose permissions were never written down.
export const ROLES = [
  { value: "admin", name: "Admin" },
  { value: "member", name: "Member" },
  { value: "viewer", name: "Viewer" },
];
// A role as a person reads it, the owner included. The owner is not in ROLES
// because the dialog turns that list into buttons, and nobody is made the
// owner there. Settings > Your account showed the raw word "owner".
export const roleName = (role) =>
  role === "owner"
    ? "Owner"
    : ROLES.find((r) => r.value === role)?.name || role;
export const ROLE_DEFAULTS = {
  admin: {
    chat: true,
    ducks: true,
    tasks: true,
    docs: true,
    integrations: true,
    team: true,
    company: true,
    billing: false,
    approvals: true,
    skills: true,
    computers: true,
  },
  member: { chat: true, tasks: true, docs: true },
  viewer: {},
};

// What the dialog saves, and what it puts on the screen: all eleven keys as a
// yes or a no. Anything set by hand beats the role, a key nobody ever wrote
// down is a no, and a key the server does not know is never sent back to it -
// it refuses the whole save over one it has not heard of.
export const asAnswers = (perms) =>
  Object.fromEntries(MEMBER_PERMISSIONS.map((p) => [p.key, !!perms?.[p.key]]));

// A role names only the handful it turns on, so it is read as all eleven
// answers rather than as the three or ten it mentions.
export const filledBy = (role) => asAnswers(ROLE_DEFAULTS[role]);

// Numbers this small are read, not counted.
const WORDS = [
  "no",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
];
const lines = (n) => (WORDS[n] || n) + (n === 1 ? " line" : " lines");

// The line a role press leaves behind. Picking a role rewrote every switch in
// silence, with no warning and no way back; now the press says what it did,
// and the undo beside this line puts the switches back where they were.
export function afterRole(role, before, after) {
  const name = ROLES.find((r) => r.value === role)?.name || role;
  const went = MEMBER_PERMISSIONS.filter(
    (p) => !!before[p.key] && !after[p.key],
  ).length;
  const came = MEMBER_PERMISSIONS.filter(
    (p) => !before[p.key] && !!after[p.key],
  ).length;
  // A press that moved nothing has nothing to say and nothing to put back.
  if (!went && !came) return null;
  if (went && came)
    return `${name} filled the list in: ${lines(went)} went off and ${lines(came)} came on.`;
  if (went) return `${name} is a smaller job: ${lines(went)} below went off.`;
  return `${name} is a bigger job: ${lines(came)} below came on.`;
}
