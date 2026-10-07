// The words on the "Needs you" card that depend on what the server wrote down.
// Kept apart from the card so they can be checked without a browser.

// How a request ended. There is no column for it: the server writes a sentence
// for the duck in `outcome`, and its first words are all there is to go on.
// tests/human-input-words.test.mjs checks each of these is still something the
// server writes, so rewording one over there fails a test rather than quietly
// turning every line in chat into "Done".
export const ENDINGS = {
  sent: "Fields entered",
  onScreen: "The human finished",
  again: "No input",
  handedBack: "A person had this screen",
  declined: "The person said no",
};

// What the server writes down when a wait runs out is written for the duck, to
// read when it resumes: "The input you asked for was never provided. Check the
// current computer state". The person looking at the card is not the duck, and
// the card has a sentence of its own for them. Anything else the server wrote -
// why a screen could not be opened - is for the person, and is kept.
export const FOR_THE_DUCK = [
  "A person took over this screen and the wait ran out",
  "Nobody took over in time",
];
// Saying no is written for the duck too, and the card has a line of its own
// for it, in the person's own words.
export const forThePerson = (outcome) =>
  [...FOR_THE_DUCK, ENDINGS.declined].some((words) =>
    (outcome || "").startsWith(words),
  )
    ? ""
    : outcome || "";

const startOfSentence = (name) => name.charAt(0).toUpperCase() + name.slice(1);

// The one line a finished card leaves behind. Only the person who was asked is
// ever sent their request, so whoever reads this is the one who did it.
export function afterwards(request, { name = "your duck", jobs = [] } = {}) {
  const outcome = request.outcome || "";
  // Before "cancelled": a duck told to stop after somebody said no still had
  // its request answered with a no.
  if (request.declined_at || outcome.startsWith(ENDINGS.declined))
    return "You said no";
  if (request.status === "cancelled")
    // Dismissing a card whose duck had already carried on stops nothing, and
    // saying it did told people they had ended work that went on to finish.
    return jobs.some((j) => j.id === request.job_id && j.status === "cancelled")
      ? startOfSentence(name) + " was told to stop"
      : "Closed";
  if (outcome.startsWith(ENDINGS.sent)) return "You sent it to " + name;
  if (outcome.startsWith(ENDINGS.onScreen))
    return "You did it on " + name + "'s screen";
  if (outcome.startsWith(ENDINGS.again))
    return "You asked " + name + " to try again";
  if (outcome.startsWith(ENDINGS.handedBack))
    return "You handed the screen back to " + name;
  return "Done";
}

// "Ops Duck waits 12 more minutes, then carries on without it." A duck with no
// run behind the request has nothing to carry on with, so it only waits.
export function waitWords(msLeft, name = "your duck", carriesOn = true) {
  const minutes = Math.max(1, Math.ceil(msLeft / 60000));
  return (
    startOfSentence(name) +
    " waits " +
    minutes +
    " more " +
    (minutes === 1 ? "minute" : "minutes") +
    (carriesOn ? ", then carries on without it." : ".")
  );
}

// Whether the duck's own words already tell the person how to finish: hand the
// screen (or "it") back, or give it back. Not "press Done": that is as often
// the website's own button, and somebody who pressed that one would sit
// waiting with the screen still theirs. The card used to add
// "Hand the screen back when you are done." after every ask, and ducks mostly
// end theirs with "then hand the screen back when you're finished", so people
// read the same thing twice. Ducks word it every which way, so this matches
// loosely.
export const saysHandBack = (instructions) =>
  /\b(hand|give|pass)(s|ing)?(\s+[^\s.!?]+){0,3}\s+back\b/i.test(
    instructions || "",
  );

// "https://supplier-portal.example.com" is an address; "supplier-portal.example.com"
// is where somebody thinks they are.
export function siteOf(origin) {
  try {
    return new URL(origin).host;
  } catch {
    return "";
  }
}
