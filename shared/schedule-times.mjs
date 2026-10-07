// When a scheduled task happens next, and how to say it in English.
//
// Both the server and the create form use these, so the "first time" the person
// is shown while typing is produced by the same code that later decides when to
// run. They cannot drift apart.
//
// A schedule stores a wall-clock time and a zone, never an instant, so "every
// day at 09:00" stays 09:00 through a daylight-saving change instead of sliding
// to 08:00 or 10:00. The instant is worked out fresh each time.
export const REPEATS = [
  "once",
  "minutes",
  "hourly",
  "daily",
  "weekdays",
  "weekly",
  "monthly",
];
// How often "every so many minutes" may be. Below this a run would still be
// going when the next was due, every time.
export const MINUTE_CHOICES = [5, 10, 15, 30];
const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];
// One reader per zone. Making a new one is most of what nextFire costs: a
// week of five-minute steps took 160ms that way, and 10ms with this.
const readers = new Map();
const readerFor = (timezone) => {
  if (!readers.has(timezone))
    readers.set(
      timezone,
      new Intl.DateTimeFormat("en-US", {
        timeZone: timezone,
        hour12: false,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        weekday: "short",
      }),
    );
  return readers.get(timezone);
};
const parts = (ts, timezone) => {
  const read = readerFor(timezone).formatToParts(ts);
  const out = {};
  for (const p of read)
    if (p.type !== "literal")
      out[p.type] = p.type === "weekday" ? p.value : Number(p.value);
  // Midnight comes back as hour 24 in some locales.
  out.hour %= 24;
  return out;
};
// How far the zone is from UTC at that instant, in milliseconds.
const offsetAt = (ts, timezone) => {
  const p = parts(ts, timezone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - ts;
};
// The instant at which the clock in `timezone` reads this date and time.
// Exported because a one-off is picked as a date and a time on a company's
// clock, and turning that into an instant with Date.parse used the browser's
// clock instead — so the same choice meant a different moment depending on
// where the person making it happened to be sitting.
// An hour that a spring-forward skips resolves to the same instant as the hour
// that replaced it, so such a day still has exactly one occurrence.
export function instantOf(year, month, day, minute, timezone) {
  const wall = Date.UTC(year, month - 1, day, 0, minute);
  // Sample both sides of a transition. A gap has no exact wall-clock match;
  // choose its forward replacement. A repeated clock time uses the later
  // occurrence consistently, so a daily schedule still runs once that day.
  const offsets = new Set(
    [-2, -1, 0, 1, 2].map((day) => offsetAt(wall + day * 86400000, timezone)),
  );
  const candidates = [...offsets].map((offset) => wall - offset);
  const localWall = (ts) => ts + offsetAt(ts, timezone);
  const exact = candidates.filter((ts) => localWall(ts) === wall);
  if (exact.length) return Math.max(...exact);
  return (
    candidates
      .filter((ts) => localWall(ts) > wall)
      .sort((a, b) => localWall(a) - localWall(b))[0] ?? NaN
  );
}
// The date and time a form should show for an instant, on a company's clock.
// The inverse of instantOf, and needed for the same reason: reading a one-off
// back with the browser's clock showed the wrong day to anybody sitting in a
// different zone from the company.
export function clockAt(ts, timezone) {
  const p = parts(ts, timezone);
  const pad = (n) => String(n).padStart(2, "0");
  return {
    date: p.year + "-" + pad(p.month) + "-" + pad(p.day),
    time: pad(p.hour) + ":" + pad(p.minute),
  };
}
const daysInMonth = (year, month) =>
  new Date(Date.UTC(year, month, 0)).getUTCDate();
const weekdayOf = (year, month, day) =>
  new Date(Date.UTC(year, month - 1, day)).getUTCDay();
// Whether this calendar date is one the schedule happens on.
function falls(schedule, year, month, day) {
  const weekday = weekdayOf(year, month, day);
  if (schedule.repeat === "daily") return true;
  if (schedule.repeat === "weekdays") return weekday >= 1 && weekday <= 5;
  if (schedule.repeat === "weekly") return weekday === schedule.on_day;
  if (schedule.repeat === "monthly")
    // A month too short for the chosen date uses its last day, so "the 31st"
    // still happens in February rather than silently rolling into March.
    return day === Math.min(schedule.on_day, daysInMonth(year, month));
  return false;
}
export const isFrequent = (repeat) => ["minutes", "hourly"].includes(repeat);
// Repeats that come round many times a day may be told to keep to a window, so
// a check can watch only during office hours. No window means all day.
const insideWindow = (schedule, minute, weekday) => {
  if (schedule.weekdays_only && (weekday === 0 || weekday === 6)) return false;
  const from = schedule.from_minute,
    to = schedule.to_minute;
  if (from === null || from === undefined || to === null || to === undefined)
    return true;
  // A window that ends before it starts runs through midnight.
  return from <= to
    ? minute >= from && minute <= to
    : minute >= from || minute <= to;
};
// The first moment this schedule is due strictly after `afterMs`. Strictly, so
// that recomputing it immediately after a run can never return the same instant
// twice and fire again. Returns null when there is no next time.
export function nextFire(schedule, afterMs) {
  if (schedule.repeat === "once") return null;
  if (!REPEATS.includes(schedule.repeat)) return null;
  const timezone = schedule.timezone || "UTC";
  if (isFrequent(schedule.repeat)) {
    const step =
      (schedule.repeat === "hourly"
        ? 60
        : Math.max(1, schedule.every_minutes || 5)) * 60000;
    // Walk from the next step boundary, skipping anything outside the window.
    // A day is at most 1440 minutes, so a whole week of steps is a hard bound.
    let at = Math.floor(afterMs / step) * step + step;
    for (let n = 0; n < 8 * 1440; n++) {
      const p = parts(at, timezone);
      if (
        insideWindow(
          schedule,
          p.hour * 60 + p.minute,
          weekdayOf(p.year, p.month, p.day),
        )
      )
        return at;
      at += step;
    }
    return null;
  }
  const from = parts(afterMs, timezone);
  let { year, month, day } = from;
  // 400 days covers every preset, including the 29th of February.
  for (let n = 0; n < 400; n++) {
    if (falls(schedule, year, month, day)) {
      const at = instantOf(year, month, day, schedule.at_minute, timezone);
      if (at > afterMs) return at;
    }
    day += 1;
    if (day > daysInMonth(year, month)) {
      day = 1;
      month += 1;
      if (month > 12) {
        month = 1;
        year += 1;
      }
    }
  }
  return null;
}
const clock = (minute) =>
  String(Math.floor(minute / 60)).padStart(2, "0") +
  ":" +
  String(minute % 60).padStart(2, "0");
const ordinal = (n) => {
  const rest = n % 100;
  if (rest >= 11 && rest <= 13) return n + "th";
  return n + ["th", "st", "nd", "rd"][n % 10] || n + "th";
};
// How the schedule reads on screen. One sentence, no jargon.
export function describe(schedule) {
  const at = " at " + clock(schedule.at_minute ?? 0);
  if (isFrequent(schedule.repeat)) {
    const how =
      schedule.repeat === "hourly"
        ? "Every hour"
        : "Every " + (schedule.every_minutes || 5) + " minutes";
    const window =
      schedule.from_minute === null ||
      schedule.from_minute === undefined ||
      schedule.to_minute === null ||
      schedule.to_minute === undefined
        ? ""
        : ", between " +
          clock(schedule.from_minute) +
          " and " +
          clock(schedule.to_minute);
    return how + window + (schedule.weekdays_only ? ", on weekdays" : "");
  }
  if (schedule.repeat === "daily") return "Every day" + at;
  if (schedule.repeat === "weekdays") return "Every weekday" + at;
  if (schedule.repeat === "weekly")
    return "Every " + DAY_NAMES[schedule.on_day ?? 1] + at;
  if (schedule.repeat === "monthly")
    return "On the " + ordinal(schedule.on_day ?? 1) + " of each month" + at;
  return "Once";
}
// A date and time as somebody in that zone would read it.
export function readable(ts, timezone) {
  if (!ts) return "";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone || "UTC",
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(ts);
}
// Whether a zone name is one this machine understands. Checked when a schedule
// is saved rather than when it runs, so a bad name cannot strand it later.
export function knownTimezone(name) {
  if (typeof name !== "string" || !name) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: name });
    return true;
  } catch {
    return false;
  }
}
