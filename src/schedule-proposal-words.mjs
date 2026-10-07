// The words on the card a duck posts when it wants to do something regularly,
// to change it, or to stop. Kept apart from the card so they can be checked
// without a browser. Every fact is the server's own: these only put it in a
// sentence.
import { clockAt, isFrequent, readable } from "../shared/schedule-times.mjs";
import { fmtWhen } from "./when.mjs";

// "Every Thursday at 10:00" inside a sentence. Only its first letter goes
// small: the whole thing used to, and the card said "every thursday".
export const inSentence = (words) =>
  String(words || "").replace(/^./, (c) => c.toLowerCase());

// The name a card goes by. A change goes by the name the schedule has now,
// which is the one people know, unless the change was made.
export const nameOf = (p) =>
  p.operation === "update" && p.status !== "approved"
    ? p.before?.title || p.title
    : p.title;

// The card's question, which is also its heading.
export const question = (p) =>
  p.operation === "remove"
    ? "Stop “" + p.title + "”?"
    : p.operation === "update"
      ? "Change “" + nameOf(p) + "”?"
      : p.title + (p.how_often ? ", " + inSentence(p.how_often) : "") + "?";

// On the 24-hour clock the facts above it use. It followed the reader's own
// habit, so in New York one card said "08:00" and "03:59 PM".
const time = (t) =>
  new Date(t).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });

// "Open until tomorrow at 09:55." A card lapses a day after it is asked, so it
// is nearly always tomorrow; one asked yesterday is open until today. The time
// is the reader's own, which is said when the card's other times are not.
export function openUntil(expires, now = new Date(), away = false) {
  const end = new Date(expires),
    today = new Date(now),
    tomorrow = new Date(now);
  tomorrow.setDate(today.getDate() + 1);
  const day =
    end.toDateString() === today.toDateString()
      ? "today"
      : end.toDateString() === tomorrow.toDateString()
        ? "tomorrow"
        : "on " +
          end.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  return (
    "Open until " + day + " at " + time(end) + (away ? ", your time" : "") + "."
  );
}

// The zone a schedule keeps, said only to somebody whose own clock is on
// another one. It used to follow every time on the card, for everybody.
export const zoneNote = (timezone, readerZone) =>
  timezone && readerZone && timezone !== readerZone
    ? ", " + timezone.split("/").pop().replace(/_/g, " ") + " time"
    : "";

const dayIn = (ts, timezone) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone || "UTC",
    weekday: "short",
    day: "numeric",
    month: "short",
  }).format(ts);

// When a schedule last ran, on its own clock: "today at 09:00".
export function ranWhen(at, timezone, now = Date.now()) {
  const ts = Date.parse(at);
  const ran = clockAt(ts, timezone),
    today = clockAt(now, timezone).date,
    yesterday = clockAt(now - 86400000, timezone).date;
  return (
    (ran.date === today
      ? "today"
      : ran.date === yesterday
        ? "yesterday"
        : "on " + dayIn(ts, timezone)) +
    " at " +
    ran.time
  );
}

const whose = (company) =>
  (company || "this company") + (/s$/i.test(company || "") ? "’" : "’s");

// What a change to how often it runs does to what it keeps costing: the new
// count, and the one it replaces.
export function costsInstead(runs, before, company) {
  if (!(runs > 0) || !(before > 0) || runs === before)
    return costs(runs, company);
  return (
    (runs === 1
      ? "One run"
      : "About " + runs.toLocaleString("en-GB") + " runs") +
    " a month instead of " +
    (before === 1 ? "one" : "about " + before.toLocaleString("en-GB")) +
    ", on " +
    whose(company) +
    " AI connection, until somebody pauses it"
  );
}

// What it keeps costing, which is what somebody is agreeing to.
export function costs(runs, company) {
  return runs === 1
    ? "One run a month on " +
        whose(company) +
        " AI connection, until somebody pauses it"
    : runs > 1
      ? "About " +
        runs.toLocaleString("en-GB") +
        " runs a month on " +
        whose(company) +
        " AI connection, until somebody pauses it"
      : "It keeps running on " +
        whose(company) +
        " AI connection until somebody pauses it";
}

// The first line of a card that asks to stop one: how often, and when it last
// ran, from the schedule itself. Its newest line in the list of runs is also
// written for a turn it skipped, which is not a run: the card said "Last ran
// today at 09:00" for a turn skipped because no AI was connected.
export function stopWhen(p, schedule, readerZone, now = Date.now()) {
  const how = p.how_often
    ? p.how_often + zoneNote(p.timezone, readerZone) + "."
    : "";
  const run = schedule?.last_run,
    at = () => ranWhen(run.at, schedule.timezone || p.timezone, now);
  const last = !schedule
    ? ""
    : schedule.paused
      ? "Paused."
      : !run
        ? "It has not run yet."
        : run.outcome === "started"
          ? "Last ran " + at() + "."
          : /^skipped/.test(run.outcome || "")
            ? "Its last turn, " + at() + ", was skipped."
            : "";
  return [how, last].filter(Boolean).join(" ");
}

// The one line an answered card leaves behind. It still says what was asked,
// who answered and when: a refused one used to say only "Not set up.", under
// the same grey bar as one that was.
//   tone: "yes" (a tick), "no" (a stop sign) or "over" (a clock)
//   what: the bold part, rest: the plain part, by: who and when, in grey
//   open: whether the schedule is there to go and look at
// Its times are the schedule's own, so somebody on another clock is told
// whose, as the card they answered told them.
export function answered(
  p,
  { me, duck = "The duck", schedule, now, readerZone } = {},
) {
  const removing = p.operation === "remove",
    changing = p.operation === "update",
    how = p.how_often ? p.how_often + zoneNote(p.timezone, readerZone) : "",
    when = p.updated ? fmtWhen(p.updated, now) : "",
    // "You, 10:02", "Sam de Vries said no, yesterday at 10:31".
    by = (verb = "") =>
      (p.decided_by === me ? "You" : p.decided_by_name || "Somebody") +
      verb +
      (when ? ", " + when : "");
  const said = (tone, what, rest, grey, open = false) => ({
    tone,
    what: what + ": " + nameOf(p) + ".",
    rest: rest.filter(Boolean).join(""),
    by: grey,
    open,
  });
  if (p.status === "approved") {
    if (removing) return said("yes", "Stopped", ["No more runs."], by() + ".");
    // Set up, or changed, by the duck itself: somebody had let it schedule
    // without asking.
    const who = p.decided_by
      ? by()
      : duck + ", without asking" + (when ? ", " + when : "");
    const done = changing ? "Changed" : "Set up";
    if (!p.schedule_id)
      return said(
        "yes",
        done,
        [how && how + ". ", "It has since been removed."],
        who + ".",
      );
    const next = !schedule
      ? ""
      : schedule.paused
        ? ", paused"
        : schedule.next_at
          ? ", next " +
            (isFrequent(schedule.repeat)
              ? readable(schedule.next_at, schedule.timezone)
              : dayIn(schedule.next_at, schedule.timezone))
          : "";
    return said("yes", done, [how, next, "."], who, true);
  }
  if (p.status === "declined")
    return removing
      ? said("no", "Kept", [how && how + "."], by(" kept it") + ".")
      : changing
        ? said("no", "Not changed", [], by(" said no") + ".")
        : said("no", "Not set up", [how && how + "."], by(" said no") + ".");
  if (p.status === "obsolete")
    return said(
      "over",
      "Already removed",
      [],
      "It was removed before anybody answered.",
    );
  if (p.status === "superseded")
    return said("over", "Replaced", [], duck + " asked again below.");
  if (p.status === "withdrawn")
    return said(
      "over",
      "Taken back",
      [],
      duck + " withdrew it" + (when ? ", " + when : "") + ".",
    );
  return said("over", "Lapsed", [], "Nobody answered within a day.");
}
