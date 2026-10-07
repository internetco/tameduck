// The words a scheduled task's list row and its page are made of, worked out
// from what the server sends, and kept apart from the screens so they can be
// tested on their own.
//
// Every time is read on the schedule's own clock, which is not always the
// company's, and "today" means today on that clock.
import { clockAt, readable } from "../shared/schedule-times.mjs";

const dayFormat = (timezone, parts) =>
  new Intl.DateTimeFormat("en-GB", { timeZone: timezone || "UTC", ...parts });
// "Fri 18 Sept"
const dateOf = (ts, timezone) =>
  dayFormat(timezone, {
    weekday: "short",
    day: "numeric",
    month: "short",
  }).format(ts);
// "Fri 18"
const weekdayDay = (ts, timezone) =>
  dayFormat(timezone, { weekday: "short", day: "numeric" }).format(ts);
// "Sept"
const monthOf = (ts, timezone) =>
  dayFormat(timezone, { month: "short" }).format(ts);
const isToday = (ts, timezone, now) =>
  clockAt(ts, timezone).date === clockAt(now, timezone).date;
const joinAnd = (items) =>
  items.length < 2
    ? items.join("")
    : items.slice(0, -1).join(", ") + " and " + items.at(-1);

// "Today, 09:00" or "Wed 16 Sept, 09:00": the head of one run on the page.
export function whenLabel(ts, timezone, now = Date.now()) {
  if (!ts) return "";
  return isToday(ts, timezone, now)
    ? "Today, " + clockAt(ts, timezone).time
    : readable(ts, timezone);
}

// "today, 09:00" or "Fri 18 Sept": when a list row last did something. A day
// further back than today does not need its minute to be found again.
export function dayLabel(ts, timezone, now = Date.now()) {
  return isToday(ts, timezone, now)
    ? "today, " + clockAt(ts, timezone).time
    : dateOf(ts, timezone);
}

// "10:05" today, or "Thu 24 Sept, 09:00".
export function nextLabel(ts, timezone, now = Date.now()) {
  return isToday(ts, timezone, now)
    ? clockAt(ts, timezone).time
    : readable(ts, timezone);
}

// Several quiet runs said as one time, newest first as the page reads:
//   "Tue 22, Mon 21 and Fri 18 Sept, 09:00"   the same time on a few days
//   "Mon 14 to Tue 22 Sept, 09:00 (7 runs)"   the same time on many days
//   "Today, 08:00 to 09:55 (24 runs)"         many times on one day
//   "Mon 21 Sept, 17:55 to Tue 22 Sept, 09:00 (40 runs)"   anything else
export function foldedWhen(times, timezone, now = Date.now()) {
  if (times.length === 1) return whenLabel(times[0], timezone, now);
  const at = times.map((t) => ({ t, ...clockAt(t, timezone) }));
  const newest = at[0],
    oldest = at.at(-1),
    count = " (" + times.length + " runs)";
  if (at.every((x) => x.date === newest.date)) {
    const day = isToday(newest.t, timezone, now)
      ? "Today"
      : dateOf(newest.t, timezone);
    return times.length === 2
      ? day + ", " + oldest.time + " and " + newest.time
      : day + ", " + oldest.time + " to " + newest.time + count;
  }
  if (at.every((x) => x.time === newest.time)) {
    if (times.length <= 4) {
      // A month's name once, after the last day of that month.
      const words = at.map((x, n) => {
        const next = at[n + 1];
        return (
          weekdayDay(x.t, timezone) +
          (!next || monthOf(next.t, timezone) !== monthOf(x.t, timezone)
            ? " " + monthOf(x.t, timezone)
            : "")
        );
      });
      return joinAnd(words) + ", " + newest.time;
    }
    const sameMonth =
      monthOf(oldest.t, timezone) === monthOf(newest.t, timezone);
    return (
      (sameMonth
        ? weekdayDay(oldest.t, timezone)
        : dateOf(oldest.t, timezone)) +
      " to " +
      dateOf(newest.t, timezone) +
      ", " +
      newest.time +
      count
    );
  }
  return (
    readable(oldest.t, timezone) + " to " + readable(newest.t, timezone) + count
  );
}

// Runs that said something are shown with what they said; the others are a
// quiet line, and quiet lines in a row that say the same thing are one line.
const QUIET = new Set(["quiet", "skipped", "paused", "other"]);
export const runSaysSomething = (run) => !QUIET.has(run.kind);
// The words of a quiet line, after its time.
export function quietWords(run) {
  if (run.kind === "quiet") return "Nothing to report";
  const note = String(run.note || "").trim();
  // Why, in short: the page's head says the rest while it is stopped.
  if (run.kind === "paused")
    return shortWhy(note) ? "Stopped. " + shortWhy(note) : "Stopped";
  return note.replace(/\.$/, "") || "Ran";
}
// The page's feed, newest first: { run } for a run with something to show,
// { quiet: [runs], words } for one line standing for one or more quiet runs.
export function foldRuns(runs) {
  const items = [];
  for (const run of runs) {
    if (runSaysSomething(run)) {
      items.push({ run });
      continue;
    }
    const words = quietWords(run);
    const last = items.at(-1);
    // A stop is its own event, never one of a row of them.
    if (last?.quiet && last.words === words && run.kind !== "paused")
      last.quiet.push(run);
    else items.push({ quiet: [run], words });
  }
  return items;
}

// Why a schedule stopped by itself, in the server's words, or "" when it is
// running or a person paused it. Schedules paused before there was a reason
// to keep said so only by their count.
export function stoppedWhy(schedule) {
  if (!schedule?.paused) return "";
  if (schedule.paused_reason) return schedule.paused_reason;
  return schedule.strikes >= 3
    ? "Paused after " + schedule.strikes + " runs that did not finish."
    : "";
}
// The start of that reason, for a list row: "Scout was taken off the team"
// rather than the whole of what to do about it, and "3 runs did not finish"
// for the runs that ended badly.
export function shortWhy(why) {
  const first = String(why || "")
    .split(/[.,;](\s|$)/)[0]
    .trim();
  const failed =
    /^(?:The last|Paused after) (\d+) runs (?:ended without finishing|that did not finish)$/.exec(
      first,
    );
  return failed ? failed[1] + " runs did not finish" : first;
}

// What a list row says it did last. `tone` picks its mark: said, ticket,
// working, bad, or none.
export function lastRunLine(schedule, timezone, now = Date.now()) {
  const r = schedule.last_run;
  if (!r) return { tone: "", text: "Has not run yet" };
  const when = r.at ? dayLabel(Date.parse(r.at), timezone, now) : "";
  const today = r.at && isToday(Date.parse(r.at), timezone, now);
  switch (r.kind) {
    case "replied":
      return { tone: "said", text: "Replied " + when };
    case "raised":
      return { tone: "said", text: "Found something " + when };
    case "quiet":
      return { tone: "", text: "Nothing to report " + when };
    case "failed":
      return { tone: "bad", text: "Did not finish " + when };
    case "working":
      return { tone: "working", text: "Working now" };
    case "queued":
      return { tone: "", text: "Waiting its turn" };
    case "waiting":
      return { tone: "", text: "Waiting for a person" };
    case "ticket":
      return {
        tone: "ticket",
        text: "Ticket " + (today ? when : "on " + when),
      };
    case "skipped":
      return { tone: "", text: "Skipped " + when };
    default:
      return {
        tone: "",
        text: (String(r.note || "").replace(/\.$/, "") || "Ran") + " " + when,
      };
  }
}

// When it runs next, for a list row: "Next 10:05", "On Fri 2 Oct, 09:55".
export function nextLine(schedule, timezone, now = Date.now()) {
  if (!schedule.next_at) return "No further runs";
  const clock = schedule.timezone || timezone;
  const when = nextLabel(schedule.next_at, clock, now);
  // The heading names the company's clock. A time on another one says which,
  // or 09:00 reads as the company's 09:00 when it is not.
  const zone =
    schedule.timezone && schedule.timezone !== timezone
      ? " " + schedule.timezone
      : "";
  if (schedule.repeat !== "once") return "Next " + when + zone;
  return (
    (isToday(schedule.next_at, clock, now) ? "Today, " + when : "On " + when) +
    zone
  );
}

// The newest page of runs, fetched again because a run started or finished,
// laid over what is on screen. Earlier runs somebody has already opened stay
// open below it, as long as the two pages still meet.
export function mergeLatest(previous, page) {
  if (!previous?.runs || !page.more) return page;
  const oldest = page.runs.at(-1);
  const at = oldest ? previous.runs.findIndex((r) => r.id === oldest.id) : -1;
  if (at < 0) return page;
  return {
    runs: [...page.runs, ...previous.runs.slice(at + 1)],
    more: previous.more,
  };
}
// "Show earlier runs": the next page, after what is on screen.
export function appendEarlier(previous, page) {
  const seen = new Set(previous.runs.map((r) => r.id));
  return {
    runs: [...previous.runs, ...page.runs.filter((r) => !seen.has(r.id))],
    more: page.more,
  };
}

// A form laid over a newer copy of what it edits: every field the person has
// not touched takes the newer value, and every field they have keeps theirs.
// A form with anything typed into it used to keep all of it, so saving put
// back a teammate's older time along with this person's new details.
// `conflict` is a field they changed that was changed under them too.
export function keepTyped(form, was, now) {
  const next = { ...now };
  let conflict = false;
  for (const key of Object.keys(form)) {
    if (form[key] === was[key]) continue;
    next[key] = form[key];
    if (now[key] !== was[key] && now[key] !== form[key]) conflict = true;
  }
  return { form: next, conflict };
}
