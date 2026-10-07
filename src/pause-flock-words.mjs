// The words the company's stop uses, away from the markup so they can be read
// on their own and tested on their own.
//
// The old control said none of this. It was a tick box with a paragraph of
// counts beside it - "2 runs are going right now, and 1 is waiting" - and a
// browser dialog afterwards. A count cannot say whose afternoon it is about to
// throw away, so these build the same facts out of names: which duck, what it
// is on, and who asked for it.
const NUMBERS = [
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
];
export const numberWord = (n) => NUMBERS[n] ?? String(n);
const capital = (s) => s.slice(0, 1).toUpperCase() + s.slice(1);

// Up to three names read as names; past that they are a crowd, and a wall of
// them would hide the sentence they are in.
export function joinNames(names, plural) {
  if (!names.length) return "";
  if (names.length === 1) return names[0];
  if (names.length === 2) return names[0] + " and " + names[1];
  if (names.length === 3)
    return names[0] + ", " + names[1] + " and " + names[2];
  return names.length + " " + plural;
}

// Working first, then the ducks that are holding something: the rows the press
// destroys are the rows it is about to be pressed over.
const ORDER = {
  running: 0,
  waiting_human: 1,
  waiting_consultation: 2,
  queued: 3,
};
export function busyRows(data) {
  const ducks = data?.ducks || [];
  return (data?.flock?.busy || [])
    .map((run) => ({
      ...run,
      // Every duck the company has ever had is in the payload, removed ones
      // included, so a face is always found even for a duck taken off the team
      // while it was still working.
      face: ducks.find((d) => d.id === run.duck_id) || null,
    }))
    .sort(
      (a, b) =>
        (ORDER[a.status] ?? 9) - (ORDER[b.status] ?? 9) ||
        a.duck.localeCompare(b.duck),
    );
}

const asked = (row) => (row.yours ? "you" : row.person);

// What one duck is on, and for whom. A run with no title of its own still says
// who asked for it, which is the part that decides whether you press.
export function workLine(row) {
  const what = row.title
    ? row.title + ", for " + asked(row)
    : "Something " + asked(row) + " asked for";
  if (row.status === "queued") return what + ". Waiting its turn.";
  if (row.status === "waiting_consultation")
    return what + ". Waiting for another duck.";
  return what;
}

// The same duck, once everything is stopped: what it is still holding and what
// happens to it when the ducks are started again.
export function stoppedLine(row) {
  const carries = " Carries on when you start again.";
  if (row.status === "waiting_human")
    return (
      (row.yours
        ? "Still waiting for you."
        : "Still waiting for " + row.person + ".") + carries
    );
  if (row.status === "waiting_consultation")
    return "Waiting for another duck." + carries;
  if (row.status === "queued") return "Waiting its turn." + carries;
  return workLine(row);
}

export function headline(rows) {
  const ducks = new Set(rows.map((r) => r.duck_id)).size;
  if (!ducks) return "Every duck is free";
  if (ducks === 1) return "One duck has something on";
  return capital(numberWord(ducks)) + " ducks have something on";
}

export function subLine(rows, company) {
  return rows.length
    ? "Stopping ends all of it, for everybody at " + company + "."
    : "Stopping means nobody at " +
        company +
        " can send the ducks work until you start them again.";
}

// The price, in the strip the button sits on. Two facts, kept apart: what is
// destroyed and what merely waits.
export function costLine(rows) {
  const going = rows.filter((r) => r.status === "running").length;
  const waiting = rows.length - going;
  const first =
    going === 0
      ? "Nothing is working, so nothing is thrown away."
      : going === 1
        ? "The one working stops for good."
        : "The " + numberWord(going) + " working stop for good.";
  const rest =
    waiting === 0
      ? ""
      : waiting === 1
        ? " The one waiting carries on when you start again."
        : " The " +
          numberWord(waiting) +
          " waiting carry on when you start again.";
  return first + rest;
}

export function idleLine(names) {
  if (!names.length) return "";
  return (
    joinNames(names, "other ducks") +
    (names.length === 1 ? " has" : " have") +
    " nothing on."
  );
}

export function dialogLead(rows) {
  const going = rows.filter((r) => r.status === "running");
  if (!going.length) return "Nothing is running, so no work is thrown away.";
  const ducks = [...new Set(going.map((r) => r.duck))];
  const who = joinNames(ducks, "ducks");
  return ducks.length === 1
    ? who + " stops what it is doing, and it does not pick it up again."
    : who + " stop what they are doing, and they do not pick it up again.";
}

// The consequences, one per line. The last one is here whatever is happening:
// it is the part the old dialog never said at all, and the only part that is
// true even when the company is completely quiet.
export function dialogPoints(rows, company) {
  const points = [];
  const going = rows.filter((r) => r.status === "running");
  // You first, so "You and Sam de Vries have to ask" reads as a sentence.
  const people = [
    ...new Set(going.map((r) => (r.yours ? "You" : r.person))),
  ].sort((a, b) => (a === "You" ? -1 : b === "You" ? 1 : 0));
  if (people.length) {
    const who = joinNames(people, "people");
    points.push(
      who +
        (people.length === 1 && who !== "You" ? " has" : " have") +
        " to ask for that work afresh.",
    );
  }
  const waiting = rows.filter((r) => r.status !== "running");
  if (waiting.length) {
    const ducks = [...new Set(waiting.map((r) => r.duck))];
    const forYou = waiting.some((r) => r.status === "waiting_human" && r.yours);
    points.push(
      ducks.length === 1
        ? ducks[0] +
            (forYou ? " keeps waiting for you, and" : " keeps waiting, and") +
            " carries on when you start again."
        : joinNames(ducks, "ducks") +
            " keep waiting, and carry on when you start again.",
    );
  }
  points.push("Anything already saved stays saved.");
  points.push(
    "Nobody at " +
      company +
      " can send the ducks work until you start them again.",
  );
  return points;
}

// While everything is stopped.
export const stoppedHeadline = (company) =>
  "Nobody at " + company + " can send the ducks work";
export const stoppedFoot = (rows) =>
  (rows.length
    ? "Everything above is still waiting. "
    : "Nothing is waiting. ") +
  "The runs that were stopped do not come back, and whoever was waiting on one has to ask again.";
