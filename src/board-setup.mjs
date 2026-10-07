// The rules the board setup page follows, kept apart from the page so they can
// be tested without a browser. See src/BoardSetup.jsx.

// The server's own limits.
export const MOST_STEPS = 12;
export const MOST_CHECKERS = 8;

// A step on the page. Saved steps carry their id; a new one carries a key of
// its own until it is saved. The server drops the key.
let made = 0;
const step = (name, more = {}) => ({
  key: "new-" + ++made,
  name,
  duck_id: null,
  instructions: "",
  approvers: [],
  wait_for_ducks: [],
  review_in_order: true,
  ...more,
});
export const stepKey = (c) => c.id || c.key;

// No template starts with a step nobody works on: the brief is the ticket
// itself, and "New ticket" asks for it. Each work step names the jobs whose
// duck should do it.
export const templates = [
  {
    id: "content",
    label: "Content creation",
    name: "Content creation",
    steps: [
      {
        name: "Research",
        job: /research|analys/i,
        instructions:
          "Look into the brief. Save the facts and sources as a document.",
      },
      {
        name: "Write",
        job: /writ|copy|content|edit/i,
        instructions: "Write it from the research. Keep it plain.",
      },
      { name: "Review", instructions: "Read it and decide if it can go out." },
      { name: "Ready to publish", finish: true },
    ],
  },
  {
    id: "marketing",
    label: "Marketing",
    name: "Marketing",
    steps: [
      {
        name: "Plan",
        job: /market|campaign|brand|social/i,
        instructions:
          "Plan the campaign from the brief: who it is for, the message and the channels.",
      },
      {
        name: "Create",
        job: /writ|copy|content|design|creat/i,
        instructions: "Make what the plan needs. Keep it plain.",
      },
      { name: "Review", instructions: "Check it and decide if it can go out." },
      { name: "Ready to launch", finish: true },
    ],
  },
  {
    id: "blank",
    label: "Blank board",
    name: "",
    steps: [{ name: "To do" }, { name: "Done", finish: true }],
  },
];

// A new board from a template. Each work step gets the first duck on the team,
// in the order ducks are listed everywhere, whose job matches and that no
// earlier step has taken. Only the job counts. With no match the step is a
// person's, which the card says, and any duck is one click away.
export function fromTemplate(id, ducks) {
  const t = templates.find((x) => x.id === id);
  const taken = new Set();
  const onTeam = ducks.filter((d) => !d.removed);
  return {
    name: t.name,
    description: "",
    enabled: true,
    auto_advance: true,
    columns: t.steps.map(({ name, job, instructions = "", finish }) => {
      const duck =
        job && onTeam.find((d) => !taken.has(d.id) && job.test(d.role || ""));
      if (duck) taken.add(duck.id);
      return step(name, {
        duck_id: duck?.id || null,
        instructions,
        ...(finish ? { finish: true } : {}),
      });
    }),
  };
}

// A saved board as the page edits it. The last step is the finish line when it
// has nobody on it and no check: the server's own rule for where finished
// tickets land. It is decided once, here, so a card never turns into something
// else while somebody edits it, and a board saved without one gets none.
export function fromBoard(board, columns) {
  return {
    name: board.name,
    description: board.description || "",
    enabled: !!board.enabled,
    auto_advance: !!board.auto_advance,
    columns: columns.map((c, i) => ({
      id: c.id,
      name: c.name,
      duck_id: c.duck_id || null,
      instructions: c.instructions || "",
      approvers: [...(c.approvers || [])],
      wait_for_ducks: [...(c.wait_for_ducks || [])],
      review_in_order: !!c.review_in_order,
      ...(i === columns.length - 1 && !c.duck_id && !c.approvers?.length
        ? { finish: true }
        : {}),
    })),
  };
}

export const blankStep = (columns) => step(newStepName(columns));

// "New step", then "New step 2", "New step 3": the first name no step has.
// The server wants every name different, whatever the case.
export function newStepName(columns) {
  const used = new Set(columns.map((c) => c.name.trim().toLowerCase()));
  for (let n = 1; ; n++) {
    const name = n === 1 ? "New step" : "New step " + n;
    if (!used.has(name.toLowerCase())) return name;
  }
}

// The steps with the one at `from` moved to `to`. The finish line stays last,
// and nothing moves past it.
export function moveStep(columns, from, to) {
  const finish = columns.at(-1)?.finish ? columns.length - 1 : columns.length;
  if (from >= finish) return columns;
  const list = [...columns];
  const [moving] = list.splice(from, 1);
  list.splice(Math.max(0, Math.min(to, finish - 1)), 0, moving);
  return list;
}

// Whether saving starts a step's unfinished tickets again. The server's own
// test: a different duck, different words, or different checkers. A new name,
// other waits or another order restart nothing.
export const restarts = (saved, now) =>
  !!saved &&
  (saved.duck_id !== now.duck_id ||
    saved.instructions !== now.instructions ||
    JSON.stringify(saved.approvers) !== JSON.stringify(now.approvers));

export function ticketWords(count, name, restart) {
  if (!count) return "";
  const one = count === 1;
  return (
    (one ? "1 ticket is in " : count + " tickets are in ") +
    name +
    "." +
    (restart
      ? " Saving starts " +
        (one ? "it" : "them") +
        " again with these settings."
      : "")
  );
}
