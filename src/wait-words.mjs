// The words and the choices of Settings > Your account > How long ducks wait
// for you. Kept apart from the screen so they can be read and checked without
// a browser, the way pause-flock-words.mjs is.

// The six times the list offers, for your usual and for every duck alike. It
// used to be a number box beside five lists: the box took any of 1 to 15 and
// had its own Save, the lists offered these six and saved the moment they
// changed.
export const WAIT_MINUTES = [1, 2, 3, 5, 10, 15];

export const minutes = (n) => n + (n === 1 ? " minute" : " minutes");

// A time the six do not have, like a 7 somebody typed into the old box, stays
// in that person's list. Left out, the list would show 1 minute, and the next
// pick anywhere near it would be read as the person choosing that.
export const waitChoices = (current) =>
  current == null || WAIT_MINUTES.includes(current)
    ? WAIT_MINUTES
    : [...WAIT_MINUTES, current].sort((a, b) => a - b);

// Your usual belongs to you, not to one company (human_wait_settings is keyed
// by person), so somebody in more than one company is told it is shared.
const across = (companies) =>
  companies === 2 ? "both your companies" : "all your companies";
export const usualHelp = (companies) =>
  companies > 1
    ? "Unless a duck has its own time. The same in " + across(companies) + "."
    : "Unless a duck has its own time";

// The line under the list after a pick. duck is a name, or nothing for your
// usual; wait is the minutes picked, or null for a duck set back to your
// usual, which is then spelled out as the minutes it means today.
export function savedLine({ duck, wait, usual, companies = 1 }) {
  if (!duck)
    return (
      "Saved. Your usual is now " +
      minutes(wait) +
      (companies > 1 ? ", in " + across(companies) : "") +
      "."
    );
  return wait == null
    ? `Saved. ${duck} now waits your usual ${minutes(usual)} for you.`
    : `Saved. ${duck} now waits ${minutes(wait)} for you.`;
}

// The same line when the save did not happen: what is still true, and what to
// do. wait is what is stored, as above.
export function failedLine({ duck, wait, usual }) {
  if (!duck)
    return `Not saved. Your usual is still ${minutes(wait)}. Try again.`;
  return wait == null
    ? `Not saved. ${duck} still waits your usual ${minutes(usual)} for you. Try again.`
    : `Not saved. ${duck} still waits ${minutes(wait)} for you. Try again.`;
}
