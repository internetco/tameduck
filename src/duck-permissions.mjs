// The words and the sums behind Settings > Ducks. Kept apart from the table so
// they can be checked without a browser.

// The things a company decides about a duck, in the order they are asked.
// Each one is a column: what it is called, the line under that heading, the
// answer a switch gives either way, what the All ducks row offers, what the
// switch is called out loud, and the name its line carries on a phone, where
// there are no headings above it to lean on.
export const PERMISSIONS = [
  {
    key: "secrets",
    head: "Save secrets",
    help: "Passwords and keys",
    lab: "Save secrets",
    on: "Allowed",
    off: "Off",
    said: "save and read secrets",
    allOn: "Turn all on",
    allOff: "Turn all off",
  },
  {
    key: "notes",
    head: "Keep notes",
    help: "What it remembers",
    lab: "Keep notes",
    on: "Allowed",
    off: "Off",
    said: "keep its own notes",
    allOn: "Turn all on",
    allOff: "Turn all off",
  },
  {
    key: "computer",
    head: "Use its computer",
    help: "Websites and files",
    lab: "Use its computer",
    on: "Allowed",
    off: "Off",
    said: "use its computer",
    allOn: "Turn all on",
    allOff: "Turn all off",
  },
  {
    key: "proxy",
    head: "Use proxy",
    help: "Can switch it on when needed",
    lab: "Use proxy when needed",
    on: "Allowed",
    off: "Off",
    said: "use the proxy",
    allOn: "Turn all on",
    allOff: "Turn all off",
  },
  // This column used to read backwards. Its heading ended "without asking" and
  // the unticked box under it said "Ask me first", so a newcomer ticked the box
  // to be asked and stopped the asking instead. Now the switch is on when the
  // duck may go ahead, and the word beside it says which of the two that is.
  {
    key: "schedules",
    head: "Schedule work",
    help: "Without asking first",
    // On a phone the heading and its "Without asking first" are gone, and
    // "Schedule work: Allowed" would say the duck may not schedule work at all
    // when it is off. The line says the whole thing instead.
    lab: "Schedule work without asking",
    on: "Allowed",
    off: "Asks first",
    said: "schedule work without asking",
    allOn: "Allow all",
    allOff: "All ask first",
  },
];

// A bulk button offers to turn a column off while any duck in it is still on,
// and only offers to turn it on once none of them is. The old buttons asked
// whether every duck was on, so with four ducks allowed and one not, the one
// button on screen offered to turn the fifth on - the opposite of the tidying
// up somebody opens this table to do.
export const anyDuck = (ducks, key) => ducks.some((d) => !!d[key]);

// Putting a bulk change back is not one change: the ducks had answers of their
// own. Split them into the two the server can set in one call each, and leave
// out a group nobody is in, because it refuses an empty list of ducks.
export function undoGroups(before, key) {
  const groups = [];
  for (const value of [true, false]) {
    const ids = before.filter((d) => !!d[key] === value).map((d) => d.id);
    if (ids.length) groups.push({ ids, value });
  }
  return groups;
}

// The line the All ducks row leaves behind, so that one press on five ducks
// says what it did rather than simply happening.
export function afterBulk(key, value, count) {
  if (key === "schedules")
    return count === 1
      ? value
        ? "Your duck may schedule work without asking."
        : "Your duck asks first before scheduling work."
      : value
        ? "All " + count + " ducks may schedule work without asking."
        : "All " + count + " ducks ask first before scheduling work.";
  if (key === "proxy")
    return (
      "Proxy access is " +
      (value ? "on for " : "off for ") +
      (count === 1 ? "your duck" : "all " + count + " ducks") +
      "."
    );
  const thing = {
    secrets: "Secrets",
    notes: "Notes",
    computer: "Computers",
  }[key];
  return (
    thing +
    (value ? " are on for " : " are off for ") +
    (count === 1 ? "your duck" : "all " + count + " ducks") +
    "."
  );
}
