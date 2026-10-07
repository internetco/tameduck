// What the plan includes for computer use: counted, shown, and applied.
//
// The plan includes a number of starts a minute, an hour and a day, and an
// amount of running time a month. computerUse() adds up what a company has
// had of each, for the usage page. assertComputerAllowance() is the gate: the
// computer code calls it once, just before it asks the provider for a
// machine, and it throws when the company is at a limit.
//
// Three rules shape everything below.
//
// A company must never be turned away by mistake. If the check itself breaks
// the start goes ahead, and a session nobody closed cannot eat the month.
//
// The refusal is one plain sentence that says what happened, when it frees
// up on the company's own clock, and that trying again will not work. That
// last part is for ducks, which are told to work round obstacles and will
// otherwise spend a hundred steps trying every door.
//
// Machines already running are left alone. Only a start is ever refused.
//
// The counting is read-only over computer_usage, which the computer code
// writes on its own: one row when a machine is created or resumed, closed
// when the provider reports it gone. So a start is a real start - a refused
// or failed one leaves no row - and a machine stopped and woken again is two,
// unless it is woken in the moments before the stop has been recorded, when
// the open row is carried on and it stays one.
import {
  db,
  one,
  all,
  fail,
  permissions,
  directConversation,
  addMessage,
} from "./store.mjs";
import { companyPlan } from "./company-limits.mjs";
import {
  COMPUTER_STARTS_PER_MINUTE,
  COMPUTER_STARTS_PER_HOUR,
  COMPUTER_STARTS_PER_DAY,
  COMPUTER_STARTS_PER_HOUR_PER_COMPUTER,
  COMPUTER_RUNNING_SECONDS_PER_MONTH,
} from "../shared/plan.mjs";
import * as notices from "./mail-notices.mjs";
import { proxyCompanySummary } from "./computer-proxy.mjs";

export const LIMITS = Object.freeze({
  starts_per_minute: COMPUTER_STARTS_PER_MINUTE,
  starts_per_hour: COMPUTER_STARTS_PER_HOUR,
  starts_per_day: COMPUTER_STARTS_PER_DAY,
  running_seconds_per_month: COMPUTER_RUNNING_SECONDS_PER_MONTH,
});

// Tables of our own, so nothing here depends on a column in somebody else's.
//
// overrides: one company given more (or less) than the plan, without a
// deploy. Empty means the plan. The CHECKs keep zero out, which would lock a
// company out; limitsFor() checks again, because text gets past a CHECK.
//
// periods: the month a company is in. It is written down rather than worked
// out each time so that changing the company's time zone cannot start the
// month again early, or leave a gap that is never counted.
//
// notes: which of "80%" and "100%" a company has been told this month.

// The one switch. Off, everything is still counted and shown and nothing is
// refused; the answer says enforced:false so the page can say as much.
// It is read every time, so it needs no restart, and it takes what somebody
// would type in a hurry: "OFF" during an incident used to change nothing.
const enforcing = () =>
  !/^\s*(off|0|false|no)\s*$/i.test(process.env.COMPUTER_LIMITS_ENFORCED || "");

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
// No session counts for more than this. The longest honest one is about
// sixteen hours (an eight-hour run, then a person holding the screen for
// another eight). Past a day it is not a session, it is a row that was closed
// late - the server was down, and "ended" is stamped when it came back.
const LONGEST_SESSION = DAY;
// A machine is alive while the provider keeps confirming it, which the
// computer code does every twenty seconds and records in computers.updated.
// A row still open for a machine nobody has heard from stops counting there,
// instead of running until the month is gone.
const HEARD_FROM_WITHIN = 2 * MINUTE;

// ---- the company's month -------------------------------------------------
const clock = (tz) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
function clockFor(tz) {
  try {
    return clock(tz);
  } catch {
    // A zone name this machine does not know. UTC is wrong by hours, not
    // by months, and everything still works.
    return clock("UTC");
  }
}
function wallClock(format, ms) {
  const p = {};
  for (const part of format.formatToParts(new Date(ms)))
    p[part.type] = Number(part.value);
  return p;
}
// How far the zone's wall clock is ahead of UTC at that instant.
function offsetAt(format, ms) {
  const p = wallClock(format, ms);
  return (
    Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) -
    Math.floor(ms / 1000) * 1000
  );
}
// The instant the 1st of that month begins on that clock. The offset is
// looked up where the answer is, not where "now" is: November in New York
// starts on summer time and is on winter time three weeks later, and using
// today's offset puts the 1st an hour out.
function firstOf(format, year, month) {
  const asUtc = Date.UTC(year, month - 1, 1);
  const near = asUtc - offsetAt(format, asUtc);
  return asUtc - offsetAt(format, near);
}
export function monthOf(tz, now = Date.now()) {
  const format = clockFor(tz);
  const { year, month } = wallClock(format, now);
  return {
    start: firstOf(format, year, month),
    end:
      month === 12
        ? firstOf(format, year + 1, 1)
        : firstOf(format, year, month + 1),
  };
}
// The month the company is in, written down. While "now" is inside it, it is
// the answer whatever the time zone says today. When it has ended, the next
// one begins exactly where it stopped and runs to the next 1st on the
// company's clock as it is now - and if that is only hours away, because the
// clock was just moved west across the 1st, to the one after, so that moving
// the clock is never a fresh allowance.
function periodFor(company, tz, now) {
  const kept = one(
    "SELECT starts_at, ends_at FROM computer_periods WHERE company_id=?",
    company,
  );
  if (kept && now >= kept.starts_at && now < kept.ends_at)
    return { start: kept.starts_at, end: kept.ends_at };
  const month = monthOf(tz, now);
  let { start, end } = month;
  if (kept && now >= kept.ends_at) start = Math.max(kept.ends_at, month.start);
  if (end - start < 15 * DAY) end = monthOf(tz, end).end;
  db.prepare(
    "INSERT OR REPLACE INTO computer_periods(company_id,starts_at,ends_at) VALUES(?,?,?)",
  ).run(company, start, end);
  return { start, end };
}

// ---- what the company has, and what it has used ---------------------------
// `afterTrial` asks for what the plan has once a trial is over: the page says
// so during the trial, or all it would show is the trial's one day.
export function limitsFor(company, { afterTrial = false } = {}) {
  const o =
    one("SELECT * FROM computer_limit_overrides WHERE company_id=?", company) ||
    {};
  // The plan's: Pro has three times the Company plan's starts and time, and
  // a trial has a day of running time for its whole week.
  const plan = companyPlan(company);
  const scale = plan.plan.computerScale;
  const own = {
    starts_per_minute: LIMITS.starts_per_minute * scale,
    starts_per_hour: LIMITS.starts_per_hour * scale,
    starts_per_day: LIMITS.starts_per_day * scale,
    running_seconds_per_month: plan.trial && !afterTrial
      ? plan.trial.computerSeconds
      : LIMITS.running_seconds_per_month * scale,
  };
  // NaN compares false with everything, so a bad number would be no limit at all.
  const pick = (k) => (Number.isInteger(o[k]) && o[k] > 0 ? o[k] : own[k]);
  return {
    starts_per_minute: pick("starts_per_minute"),
    starts_per_hour: pick("starts_per_hour"),
    starts_per_day: pick("starts_per_day"),
    running_seconds_per_month: pick("running_seconds_per_month"),
  };
}

const HEARD_FROM =
  "coalesce((SELECT CAST(strftime('%s', c.updated) AS INTEGER) * 1000 FROM computers c WHERE c.id = u.computer_id), 0) + " +
  HEARD_FROM_WITHIN;

// What the gate asks. It runs on every start and on every workspace payload,
// and the table is never pruned, so it must not read a company's whole
// history: at 50,000 rows that was 18ms with the whole server waiting, and
// bounded it is under one. Nothing older than the bound can matter - no
// session counts for more than a day, so a row that started more than a day
// before the month (or before the 24-hour window) has nothing left to give.
// The index computer_usage_company_started_ended makes it a seek, and carries
// "ended" so closed rows are summed without going back to the table.
export const GATE_QUERY = `SELECT
            coalesce(sum(u.started > ?), 0) AS minute,
            coalesce(sum(u.started > ?), 0) AS hour,
            coalesce(sum(u.started > ?), 0) AS day,
            coalesce(sum(max(0,
              min(CASE WHEN u.ended IS NULL THEN min(?, ${HEARD_FROM}) ELSE min(u.ended, ?) END,
                  u.started + ${LONGEST_SESSION})
              - max(u.started, ?))), 0) AS running_ms
       FROM computer_usage u WHERE u.company_id = ? AND u.started > ?`;
const gateArgsFor = (company, now, period) => [
  now - MINUTE,
  now - HOUR,
  now - DAY,
  now,
  now,
  period.start,
  company,
  Math.min(period.start, now - DAY) - LONGEST_SESSION,
];
// For the test that reads the query's plan.
export const gateArgs = (company, now = Date.now()) =>
  gateArgsFor(company, now, monthOf("UTC", now));

function measure(company, now, { totals = false } = {}) {
  const timezone =
    one("SELECT timezone FROM companies WHERE id=?", company)?.timezone ||
    "UTC";
  // A trial's running time is counted from the day it started, not from the
  // 1st: a trial that began on the 28th would otherwise get a second day of
  // computer time on the 1st.
  const trial = companyPlan(company).trial;
  const period = trial
    ? { start: trial.start, end: trial.end, trial: true }
    : periodFor(company, timezone, now);
  // Running time is each row's overlap with [start of the month, now]: a
  // machine that ran across midnight on the 1st counts only what came after,
  // and one that stopped last month counts nothing, though it is still a
  // start. An open row counts up to now while its machine is alive, and the
  // subquery that asks is only reached for open rows, which are few.
  const r = one(GATE_QUERY, ...gateArgsFor(company, now, period));
  // The page also shows everything there has ever been. That does read the
  // whole history, so only the page asks for it.
  const all_time = totals
    ? one(
        `SELECT count(*) AS total, min(u.started) AS first_start,
                coalesce(sum(u.ended IS NULL AND ${HEARD_FROM} >= ?), 0) AS running_now
           FROM computer_usage u WHERE u.company_id = ?`,
        now,
        company,
      )
    : {};
  return {
    company_id: company,
    now,
    timezone,
    period,
    starts: {
      minute: r.minute,
      hour: r.hour,
      day: r.day,
      total: all_time.total,
    },
    // Rounded down: half a second short of the month is not the month.
    running_seconds: Math.floor(r.running_ms / 1000),
    running_now: all_time.running_now,
    first_start: all_time.first_start,
    limits: limitsFor(company),
  };
}

// ---- saying when -----------------------------------------------------------
// On the company's clock, with the zone named, because the sentence is read
// by people elsewhere and relayed by ducks: "13:01 CET" today, "1 April at
// 00:00 CEST" any other day.
function whenText(tz, at, now) {
  let format;
  const options = {
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZoneName: "short",
  };
  try {
    format = new Intl.DateTimeFormat("en-GB", { ...options, timeZone: tz });
  } catch {
    format = new Intl.DateTimeFormat("en-GB", { ...options, timeZone: "UTC" });
  }
  const parts = (ms) =>
    Object.fromEntries(
      format.formatToParts(new Date(ms)).map((p) => [p.type, p.value]),
    );
  const a = parts(at),
    n = parts(now);
  const time = `${a.hour}:${a.minute} ${a.timeZoneName}`;
  const today = a.day === n.day && a.month === n.month;
  return { today, text: today ? time : `${a.day} ${a.month} at ${time}` };
}
// "40 days", "2.1 days", "6 hours", "1 minute". An allowance under a day said
// in days comes out as "0 days", which reads as though there never was any.
function spanText(seconds) {
  const say = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
  if (seconds >= 86400) return say(+(seconds / 86400).toFixed(1), "day");
  if (seconds >= 3600) return say(+(seconds / 3600).toFixed(1), "hour");
  return say(Math.max(1, Math.round(seconds / 60)), "minute");
}
const NO_USE = "Trying again before then will not work.";

// Which limits a start would run into right now, and the one sentence to say.
function verdict(m, { computerId = null } = {}) {
  const { company_id: company, now, limits, starts, timezone } = m;
  const hits = [];
  // When the count is already over - a lowered limit, rows repaired late -
  // the oldest start ageing out is not enough. It frees when enough of them
  // have, which is the (count - limit + 1)th oldest.
  const window = (limit, count, allowed, span, extra = "", args = []) => {
    if (count < allowed) return;
    const kth = one(
      `SELECT started FROM computer_usage WHERE company_id=? ${extra} AND started > ? ORDER BY started LIMIT 1 OFFSET ?`,
      company,
      ...args,
      now - span,
      count - allowed,
    );
    hits.push({ limit, count, frees_at: (kth?.started ?? now) + span });
  };
  window("minute", starts.minute, limits.starts_per_minute, MINUTE);
  window("hour", starts.hour, limits.starts_per_hour, HOUR);
  window("day", starts.day, limits.starts_per_day, DAY);
  if (computerId) {
    const mine = one(
      "SELECT count(*) n FROM computer_usage WHERE company_id=? AND computer_id=? AND started > ?",
      company,
      computerId,
      now - HOUR,
    ).n;
    window(
      "computer",
      mine,
      COMPUTER_STARTS_PER_HOUR_PER_COMPUTER,
      HOUR,
      "AND computer_id=?",
      [computerId],
    );
  }
  if (m.running_seconds >= limits.running_seconds_per_month)
    hits.push({
      limit: "month",
      count: m.running_seconds,
      frees_at: m.period.end,
    });
  if (!hits.length) return null;
  // The latest, not the first: told the hour frees at 16:35 while the day is
  // also full, somebody comes back at 16:35 and is refused again.
  const hit = hits.reduce((a, b) => (b.frees_at > a.frees_at ? b : a));
  const when = whenText(timezone, hit.frees_at, now);
  const at = when.today ? "at " + when.text : "on " + when.text;
  const allowance = spanText(limits.running_seconds_per_month);
  const message = {
    minute: `Your company's computers have been started ${hit.count} times in the last minute, which is all your plan includes. Try again in a minute.`,
    hour: `Your company's computers have been started ${hit.count} times in the last hour, which is all your plan includes. The next one can start ${at}. ${NO_USE}`,
    day: `Your company's computers have been started ${hit.count} times in the last 24 hours, which is all your plan includes. The next one can start ${at}. ${NO_USE}`,
    computer: `This computer has been started ${hit.count} times in the last hour, which usually means something is stuck in a loop. It can start again ${at}. ${NO_USE}`,
    month: m.period.trial
      ? `Your company has used all ${allowance} of computer time the trial includes. Computers can start again when the plan starts, ${at}, or straight away if you start it now in Settings → Billing. Ones running now carry on until they stop.`
      : `Your company has used all ${allowance} of computer time your plan includes this month. Computers can start again ${at}. Ones running now carry on until they stop. ${NO_USE}`,
  }[hit.limit];
  return { limit: hit.limit, message, frees_at: hit.frees_at };
}

// ---- the three things other code calls ------------------------------------
// For the page: the numbers, the limits, and whether a start would be refused
// right now.
export function computerUse(company, now = Date.now()) {
  const m = measure(company, now, { totals: true });
  const proxy = proxyCompanySummary(company, now);
  const names = new Map(
    all("SELECT id,name FROM ducks WHERE company_id=?", company).map((d) => [
      d.id,
      d.name,
    ]),
  );
  // In a trial, the plan that follows it and what that plan includes.
  const plan = m.period.trial ? companyPlan(company).plan : null;
  return {
    ...m,
    after_trial: plan
      ? {
          plan: plan.name,
          from: m.period.end,
          ...limitsFor(company, { afterTrial: true }),
          running_at_once: plan.runningAtOnce,
        }
      : null,
    proxy: {
      ...proxy,
      by_duck: proxy.by_duck.map((row) => ({
        ...row,
        duck_name: names.get(row.duck_id) || "Former duck",
      })),
    },
    enforced: enforcing(),
    blocked: enforcing() ? verdict(m) : null,
  };
}

// For code that wants to ask without being thrown at: { ok: true } or
// { ok: false, limit, message, frees_at }. Never throws. If the check cannot
// be made the answer is yes - the ceiling on running machines and the length
// of a session still stand behind it, and a paying company locked out by a
// bug of ours is worse than one that started a machine it should not have.
export function computerAllowance(
  company,
  { now = Date.now(), computerId = null, measured = null } = {},
) {
  if (!enforcing()) return { ok: true };
  try {
    const v = verdict(measured || measure(company, now), { computerId });
    return v ? { ok: false, ...v } : { ok: true };
  } catch (e) {
    console.error(
      "Computer limits could not be checked, so the start was allowed:",
      e.message,
    );
    return { ok: true };
  }
}

// The gate. Called once, inside the company's start lock, just before the
// provider is asked for a machine. A machine already running is not a start
// and never comes here.
export function assertComputerAllowance(company, opts = {}) {
  // Measured once and used twice: this runs inside the company's start lock.
  let measured = null;
  try {
    if (enforcing()) measured = measure(company, opts.now ?? Date.now());
  } catch {
    // computerAllowance will try again, fail the same way, say so and allow it.
  }
  const v = computerAllowance(company, { ...opts, measured });
  try {
    noteComputerAllowance(company, opts.now, measured);
  } catch (e) {
    console.error("Computer limits: the note could not be sent:", e.message);
  }
  if (!v.ok) fail(429, v.message);
}

// ---- telling people before the wall ---------------------------------------
// Once at 80% of the month and once at 100%, from Chief Duck, to the people
// who can open the usage page - the note points at it, and to anybody else
// that is a link to a page that turns them away. Not for the starts limits:
// those free up on their own within the day and a note for each would be
// noise. Looked at whenever a start is attempted or the page is opened, so
// there is no timer to keep alive.
export function noteComputerAllowance(
  company,
  now = Date.now(),
  measured = null,
) {
  // "No new computer can start" is not true while the switch is off. Nothing
  // is marked as sent, so it goes out when the switch comes back on.
  if (!enforcing()) return;
  const m = measured || measure(company, now);
  const allowed = m.limits.running_seconds_per_month;
  const share = m.running_seconds / allowed;
  // Half, most of it, all of it. Half way is the only one that is still easy
  // to act on: a fortnight left is time to notice a machine nobody uses, where
  // 80% is a few days and 100% is next month's problem.
  const threshold =
    share >= 1 ? 100 : share >= 0.8 ? 80 : share >= 0.5 ? 50 : 0;
  if (!threshold) return;
  // Found first: marking it sent and then finding nobody to send it would
  // lose the note for the whole month.
  const chief = one(
    "SELECT * FROM ducks WHERE company_id=? AND chief=1 AND removed=0",
    company,
  );
  if (!chief) return;
  const mark = db.prepare(
    "INSERT OR IGNORE INTO computer_limit_notes(company_id,period_start,threshold,at) VALUES(?,?,?,?)",
  );
  const told = mark.run(
    company,
    m.period.start,
    threshold,
    new Date().toISOString(),
  ).changes;
  // Straight past more than one at once is one note, not several: a company
  // that starts the month with a fortnight of machines already running is not
  // owed three emails about it.
  for (const lower of [50, 80])
    if (threshold > lower)
      mark.run(company, m.period.start, lower, new Date().toISOString());
  if (!told) return;
  const until = whenText(m.timezone, m.period.end, now).text;
  const whole = spanText(allowed);
  // Said in the allowance's own unit, and never as more than the whole.
  const unit = allowed >= 86400 ? 86400 : allowed >= 3600 ? 3600 : 60;
  const used = Math.min(
    allowed / unit,
    Math.floor((m.running_seconds / unit) * 10) / 10,
  );
  const body =
    threshold === 100
      ? `This month's computer time is used up (${whole} of ${whole}). No new computer can start until ${until}. Ones running now carry on until they stop.\n\nYou can see it under **Settings → Computer use**.`
      : threshold === 80
        ? `Heads-up: your company has used 80% of this month's computer time (${used} of ${whole}). When it is all used, no new computer can start until ${until}; ones already running carry on.\n\nYou can see it under **Settings → Computer use**.`
        : `Half of this month's computer time is used (${used} of ${whole}). Nothing is wrong — this is just the half-way mark, while there is still time to do something about it. It starts again on ${until}.\n\nYou can see what is using it under **Settings → Computer use**.`;
  const needs =
    threshold === 100
      ? "This month's computer time is used up."
      : threshold === 80
        ? "This month's computer time is nearly used."
        : "Half of this month's computer time is used.";
  const told_ = [];
  for (const member of all(
    "SELECT * FROM memberships WHERE company_id=?",
    company,
  )) {
    const p = permissions(member);
    if (!p.company && !p.billing) continue;
    told_.push(member.user_id);
    const conversation = directConversation(company, member.user_id, chief);
    addMessage(company, conversation.id, body, {
      duck: chief.id,
      inbox: true,
      needs,
    });
  }
  // And by email, to the same people. The chat message is the right place for
  // somebody who is here; the point of saying anything before the wall is that
  // there is still time to stop a machine nobody is using, and the person who
  // could do that is usually not looking at the app. Sent from the `told`
  // branch above, so each mark is once per company per month like the note
  // itself, and a company that jumps a mark never hears about the one it
  // skipped.
  notices
    .computerTime({
      company,
      people: told_,
      threshold,
      used: spanText(Math.min(allowed, m.running_seconds)),
      whole,
      until,
    })
    .catch((e) => console.error("Computer time email:", e.message));
}

export function registerComputerLimits(app) {
  app.get("/api/computer-use", (req, res) => {
    const p = permissions(req.member);
    if (!p.company && !p.billing)
      fail(
        403,
        "Only company admins and billing managers can view computer use.",
      );
    try {
      noteComputerAllowance(req.company.id);
    } catch (e) {
      console.error("Computer limits: the note could not be sent:", e.message);
    }
    res.json(computerUse(req.company.id));
  });
}
