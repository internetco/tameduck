// How a search result reads: the piece of a message that is shown, where the
// word somebody typed sits in it, and the plain name of a task's status. Kept
// out of the screen that paints them so each one can be read on its own.

// What a task's stored status is called where people can see it. The board's
// own column names, so a row and the board never say different things about
// the same task: the dialog used to print the stored word, "working".
const statusWords = { open: "Open", working: "Being worked on", done: "Done" };
export const statusSays = (status) => statusWords[status] || status;

// The piece of a long message worth showing: a whole number of words, around
// the word that was typed, with an ellipsis for what is left out on either
// side. It used to be the first 180 letters, cut wherever they ran out - "I
// have drafted a reminder for eac" - and the match itself was often past the
// cut, so the row never showed why it was a match at all.
export function excerpt(body, needle, span = 110) {
  const text = String(body ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= span) return text;
  const word = String(needle ?? "").trim();
  const at = word ? text.toLowerCase().indexOf(word.toLowerCase()) : -1;
  // A third of the room before the match and two thirds after it: what makes
  // sense of a line is usually what comes after the word, not before it.
  let start = at < 0 ? 0 : Math.max(0, at - Math.round(span / 3));
  let end = start + span;
  if (end >= text.length) {
    end = text.length;
    start = Math.max(0, end - span);
  }
  // Start on a word. The space this looks for is the one before the first
  // whole word; if the piece it lands in is very long, keep the letters
  // rather than throw a line away chasing a space.
  if (start > 0) {
    const space = text.indexOf(" ", start);
    if (space > 0 && space <= start + 20) start = space + 1;
  }
  if (end < text.length) {
    const space = text.lastIndexOf(" ", end);
    if (space > start) end = space;
  }
  // "Catering." followed by an ellipsis reads as four full stops, so the
  // punctuation the sentence happened to end on goes with the cut.
  const shown = text.slice(start, end).replace(/[\s.,;:]+$/, "");
  return (start > 0 ? "…" : "") + shown + (end < text.length ? "…" : "");
}

// A line cut into the pieces that are the typed word and the pieces that are
// not, so the screen can mark the first kind. The word is matched whatever
// its case, and every time it appears, because a name and a sentence can both
// carry it twice.
export function markParts(text, needle) {
  const line = String(text ?? "");
  const word = String(needle ?? "").trim();
  if (!word || !line) return [{ text: line, mark: false }];
  const hay = line.toLowerCase();
  const pin = word.toLowerCase();
  const parts = [];
  let from = 0;
  for (let at = hay.indexOf(pin); at >= 0; at = hay.indexOf(pin, from)) {
    if (at > from) parts.push({ text: line.slice(from, at), mark: false });
    parts.push({ text: line.slice(at, at + word.length), mark: true });
    from = at + word.length;
  }
  if (from < line.length) parts.push({ text: line.slice(from), mark: false });
  return parts;
}
