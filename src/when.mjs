// Times and counts as a person says them. Kept out of ui.jsx so they can be
// tested without a browser.
const time = (s) =>
  new Date(s).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const day = (s) =>
  new Date(s).toLocaleDateString([], { day: "numeric", month: "short" });

// A past moment in a sentence: "at 14:05" today, "yesterday at 14:05", "on
// 12 Sep at 14:05" before that. A bare time made a failure or a reply from
// last week read as if it happened this morning.
export function atWhen(s, now = new Date()) {
  const d = new Date(s),
    today = new Date(now),
    yesterday = new Date(now);
  yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "at " + time(s);
  if (d.toDateString() === yesterday.toDateString())
    return "yesterday at " + time(s);
  return "on " + day(s) + " at " + time(s);
}
// The same as a label: "14:05", "yesterday at 14:05", "12 Sep at 14:05".
export const fmtWhen = (s, now) => atWhen(s, now).replace(/^(at|on) /, "");
// "1 tool", "3 tools".
export const plural = (n, word) => n + " " + word + (n === 1 ? "" : "s");
