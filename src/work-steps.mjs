// What a duck's progress card says, worked out here so it can be checked
// without a browser.
//
// A duck writes a note on every action it takes on its computer - "Reading the
// Kestrel pricing page. 3 of 6 hosts done." The first sentence is what it is
// doing, which is the step. Whatever follows is how far along it is, which
// changes on every action and is only worth reading for the newest one.
//
// Its tools ask it for "saved work and the next step", so a note is just as
// often "Saved the form draft. Next: review before sending." There the first
// sentence is already done, and the one it is on is the one after "Next".

const plain = (text) =>
  String(text || "")
    .trim()
    .replace(/\s+/g, " ");
const noStop = (text) => text.replace(/\.$/, "");
// "Next: review", "Next I will review", "Then review", "Now reviewing" - all
// of them the step it is on, said without the lead-in.
const lead =
  /^(?:next|then|now)\b(?![-'’])(?:\s+(?:step|up))?(?:\s+(?:is|will\s+be))?(?:\s*[:,]|\s+[-–—])?\s*(?:(?:i\s+will|i'll|i\s+am\s+going\s+to|i'm\s+going\s+to|i\s+need\s+to|i\s+am|i'm|to)\s+)?/i;
const ahead = (sentence) => {
  const bare = noStop(sentence);
  const said = bare.replace(lead, "");
  return said && said !== bare ? said[0].toUpperCase() + said.slice(1) : "";
};

// The note split into the step, the rest, and the step it says comes next. A
// stop, question or exclamation mark followed by a space and a capital or a
// digit is where a sentence ends, which is how the run-failure card reads the
// server's sentences too.
export function splitNote(note) {
  const said = plain(note)
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"'(])/)
    .filter(Boolean);
  const at = said.findIndex((x) => ahead(x));
  return {
    step: at === 0 ? "" : noStop(said[0] || ""),
    rest: noStop(said.filter((_, i) => i && i !== at).join(" ")),
    next: at < 0 ? "" : ahead(said[at]),
  };
}

// The steps a run took, in order. Notes arrive once per action, so the same
// step is written many times over with only its tail changing ("2 of 6", then
// "3 of 6"). Those are one step, and the tail kept is the newest one. When the
// newest note says what comes next, that is the last step, marked `planned`:
// it is what the duck is on while it works, and what it never got to if the
// run ended there.
export function groupSteps(notes = []) {
  const steps = [];
  let next = null;
  for (const n of notes) {
    const { step, rest, next: then } = splitNote(n?.note);
    if (!step && !then) continue;
    next = then ? { step: then, rest, at: n.at || null, planned: true } : null;
    if (!step) continue;
    const last = steps[steps.length - 1];
    if (last && last.step === step) {
      last.rest = rest;
      last.at = n.at || last.at;
      last.failed = !!n.failed;
    } else steps.push({ step, rest, at: n.at || null, failed: !!n.failed });
  }
  if (next && next.step !== steps[steps.length - 1]?.step) steps.push(next);
  return steps;
}

// How long, the way somebody says it out loud.
export function howLong(ms) {
  const minutes = Math.floor(Math.max(0, ms) / 60000);
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return minutes + " min";
  const hours = Math.floor(minutes / 60),
    left = minutes % 60;
  return hours + " h" + (left ? " " + left + " min" : "");
}

// The top of the card while the duck works. No time at all for the first
// minute: "Working · under a minute" is longer than the news it carries.
export function workingWords(started, at = Date.now()) {
  const since = Date.parse(started);
  if (!Number.isFinite(since) || at - since < 60000) return "Working";
  return "Working · " + howLong(at - since);
}

// more: a run so long that its first steps were not kept, so this is only
// how many there were at least.
const count = (n, more) =>
  n + (more ? "+ steps" : n === 1 ? " step" : " steps");

// The chip a finished run folds into. Only a run that ended with an answer is
// "Done". A failed or stopped one has its own card or line under it saying why,
// in its own words, and this must not put a second verdict beside that one -
// so it says how long the run went on for, and nothing about how it ended.
export function chipWords({ state, started, ended, steps, more, outcome }) {
  const from = Date.parse(started),
    to = Date.parse(ended);
  const took =
    Number.isFinite(from) && Number.isFinite(to) ? howLong(to - from) : "";
  const tail = steps ? " · " + count(steps, more) : "";
  if (state === "sent" && outcome === "incomplete")
    return "Finished with work remaining" + (took ? " · " + took : "") + tail;
  if (state === "sent") return took ? "Done in " + took + tail : "Done" + tail;
  if (state === "error" || state === "cancelled")
    return took
      ? "Ran for " + took + tail
      : steps
        ? count(steps, more)
        : "What it did";
  return steps ? count(steps, more) + " so far" : "What it did so far";
}
