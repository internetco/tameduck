// The rules a failed run's card has to work out before it can say anything:
// what reason there is, whether that reason can carry a headline, whether it
// can be read where it stands, whether the row above is already printing it,
// and whether somebody has already set the run going again. Kept out of the
// component so they can be checked without a browser - they are easy to get
// wrong and almost impossible to see in a picture.

// Whatever the run recorded when it stopped.
export function reasonFor(job) {
  return job?.error ? job.error.trim() : "";
}

// A run that fails before writing anything has the server copy its error into
// the message body as well (recordJobFailure), so the machine's sentence
// arrives wearing the duck's name. It is the card's to tell. Printed in the
// row as well, it read as the duck talking - with the card underneath saying
// the duck never said why, directly below the reason it gave.
export function bodyIsTheReason(job, body) {
  return !!job?.error && job.error.trim() === (body || "").trim();
}

// The server writes these as plain sentences ("The server restarted during
// this run."), and a sentence is what a headline can be. A code, a fragment or
// a page of output is not, so the card says the plain thing in the headline
// and puts this below at reading size, where it can be read rather than
// shouted.
export function readsAsSentence(reason) {
  return !!reason && reason.length <= 160 && /^[A-Z].*[.!?]$/s.test(reason);
}

// Short enough, and on one line, to sit at the end of the card's second line.
// The server keeps a thousand characters of whatever threw, and most of what
// throws is a page of output: set as running text, one of those made the card
// 467px tall on a phone with the one thing to press below the fold. Anything
// longer goes behind a line that says what is behind it, the way the rest of
// the app hands over its raw text.
export function readsInLine(reason) {
  return !!reason && reason.length <= 120 && !reason.includes("\n");
}

// Trying again is a fresh run on the same request, which is exactly how the
// server decides whether one is already going before it starts another
// (/jobs/:id/retry). A run with no request behind it has nothing to match on,
// so it is left alone rather than matched against every other run of its kind,
// which would have shown "Trying again" over a failure nobody had touched.
const stillGoing = [
  "queued",
  "running",
  "waiting_human",
  "waiting_consultation",
];
export function retryOf(job, jobs = []) {
  if (!job?.input_message_id) return null;
  return (
    jobs.find(
      (other) =>
        other.id !== job.id &&
        other.input_message_id === job.input_message_id &&
        other.duck_id === job.duck_id &&
        stillGoing.includes(other.status),
    ) || null
  );
}

// A later run of the same request, finished or not. Once one has run, this
// failure is dealt with: the card only counted a retry while it was still
// going, so when the retry finished the old card said "Couldn't finish" again
// with a live Try again, and pressing it made the duck do the whole job a
// second time - the emails, the tickets, the files. The newest one, so the
// card can say when it was.
export function laterRunOf(job, jobs = []) {
  if (!job?.input_message_id) return null;
  return (
    jobs
      .filter(
        (other) =>
          other.id !== job.id &&
          other.input_message_id === job.input_message_id &&
          other.duck_id === job.duck_id &&
          String(other.created) > String(job.created),
      )
      .sort((a, b) => (String(a.created) < String(b.created) ? 1 : -1))[0] ||
    null
  );
}

// Written for a person rather than printed by a machine: it starts and ends
// like a sentence, sits on one line, has words in it, and has none of the marks
// output is made of. Length is not the test. It used to be, and a hundred and
// seventy characters of plain advice - "Your ducks are set to use ChatGPT,
// which is not connected. Claude is connected, so choose it under What ducks
// use in Settings, AI connection, and send this again." - was taken for a page
// of output and folded away, on the card whose one job is to say what went
// wrong.
const MACHINE = /[{}`<>\\]|\b[A-Z0-9]{2,}_[A-Z0-9_]+\b|^\w*Error:/;
export function readsAsProse(reason) {
  return (
    !!reason &&
    reason.length <= 600 &&
    !reason.includes("\n") &&
    /^[A-Z].*[.!?]$/.test(reason) &&
    / \S+ \S+ /.test(reason) &&
    !MACHINE.test(reason)
  );
}

// The opening sentence of some prose, when it can carry a headline and
// something follows it. The server writes these, so a stop, question or
// exclamation mark followed by a space and a capital is where one ends.
function firstSentence(prose) {
  const m = prose.match(/^(.+?[.!?])\s+(?=[A-Z])/);
  return m && readsAsSentence(m[1]) ? m[1] : null;
}

// What the card says about why, worked out in one place so it can be checked
// without a browser.
//   headline - the line in bold
//   rest     - the rest of a person's words, read straight after the
//              headline and before the time: it is usually what to do, and it
//              belongs next to the button that does it
//   detail   - an error code, read after the time as the supporting fact
//   folded   - raw output to put behind "Show the error"
// Any of the last three may be null.
//
// A person's words are always on show: a short sentence is the headline, and
// a longer piece is split so its first sentence says what went wrong and the
// rest says what to do. Only output goes behind the fold.
//
// The card's own words never say the duck "stopped". That is the word the chat
// uses for a run a person stopped - "Stopped by Sam Visser." - and a failure is
// not a choice the duck made. Nor does it say "It said:": the reason is the
// server's, not something the duck said.
export function explain(reason, name) {
  const plain = name + " hit a problem before it finished.";
  if (!reason)
    return {
      headline: name + " hit a problem and didn't say what.",
      rest: null,
      detail: null,
      folded: null,
    };
  if (readsAsSentence(reason) && !reason.includes("\n"))
    return { headline: reason, rest: null, detail: null, folded: null };
  if (readsAsProse(reason)) {
    const first = firstSentence(reason);
    return first
      ? { headline: first, rest: reason.slice(first.length).trim(), detail: null, folded: null }
      : { headline: plain, rest: reason, detail: null, folded: null };
  }
  if (readsInLine(reason))
    return { headline: plain, rest: null, detail: "The error: " + reason, folded: null };
  return { headline: plain, rest: null, detail: null, folded: reason };
}
