// One email for everything that has been waiting on a person, when they have
// not been in to see it.
//
// Needs you already shows a person what is waiting for them, and that works
// for somebody who is looking. Somebody who is not looking finds out when they
// next happen to open the app - and the duck that asked for their approval
// three hours ago has been sitting still for three hours. So when something has
// waited 30 minutes and the person has not had TameDuck open since it started
// waiting, we write to them. Once, with everything in it, not once per thing.
//
// Three rules hold the whole thing together:
//
//   - What it lists is what the page lists. The items come from the same
//     queries /api/state sends, sorted by the same inboxRows() the Needs you
//     page runs, so the email and the page cannot disagree about what is
//     waiting. It leaves out only what the page shows but somebody else already
//     emails: a duck holding its screen (emailed the moment it asks) and the
//     product's own notes (a paused schedule, the month's computer time).
//   - Only what this person can actually do. An approval shows in the Needs
//     you of the person whose run asked for it even when they may not approve
//     it; a reminder pointing them at a card they cannot press is a nag. So an
//     approval or a proposal is only a reason to write when they may decide it,
//     and a duck's question only when they can still answer it.
//   - Not to somebody who has been in. "In" means the app open in front of
//     them and used in the last ten minutes, per company - see presence below.
import { all, one, run, db, memberFor, permissions } from "./store.mjs";
import { inboxRows } from "../src/inbox-list.mjs";
import { listSkillProposals } from "./skill-proposals.mjs";
import { listBoardProposals } from "./board-proposals.mjs";
import { listScheduleProposals } from "./schedule-proposals.mjs";
import * as notices from "./mail-notices.mjs";
import { sweepBoards } from "./board-reminders.mjs";
import { trimEmailLog } from "./email-log.mjs";

const MINUTE = 60000;
// How long something waits before a person is written to about it.
export const WAIT = 30 * MINUTE;
// How far back a reminder will reach. Past a day the thing is not news, it is
// a backlog, and a person who has not been in for a week does not want their
// first email back to be a list of everything they missed.
const REACH = 24 * 60 * MINUTE;

// ---- presence ---------------------------------------------------------------
// When a person last had this company open, visible, and in use. Nothing else
// in the server knew: sessions carry no last-used time, and the two signals
// that do exist - /api/state polled every 12 seconds, and the event stream -
// both keep running in a background tab, so they say a tab is open, not that a
// person is there. A forgotten tab would then stop the reminder for exactly the
// person who needs it.
//
// So the page says so, on the requests it already makes (src/presence.mjs):
// every call through api() carries X-TameDuck-Here while the tab is showing and
// has been used in the last ten minutes, naming the company it shows. It is
// not a request of its own. The first version sent a separate POST at load,
// and a request fired while the app was starting was one Playwright never saw
// finish - every browser check that waited for "networkidle" hung on it.
//
// Kept in the presence table, per company, because one person can be in
// several and each shows its own Needs you. No foreign keys: a row there is a
// hint about the last minute, and it must never be the thing that stops a
// company or a person being removed.

// The newest sighting of everybody, in memory, and the table written at most
// once a minute per person per company. Only the write is throttled, never the
// sighting: the first version threw a sighting away when it came too soon after
// the last write, so somebody who came back to the tab, saw a new approval, and
// left again inside the minute was later told they had "not had TameDuck open
// since". The server is one process, so the sweep can read memory as well.
const latest = new Map();
const lastWrite = new Map();
export function notePresence(company, user, at = Date.now()) {
  const key = company + ":" + user;
  if (at > (latest.get(key) || 0)) latest.set(key, at);
  if (at - (lastWrite.get(key) || 0) < MINUTE) return false;
  lastWrite.set(key, at);
  run(
    "INSERT INTO presence(company_id,user_id,seen_at) VALUES(?,?,?) ON CONFLICT(company_id,user_id) DO UPDATE SET seen_at=excluded.seen_at",
    company,
    user,
    new Date(latest.get(key)).toISOString(),
  );
  return true;
}
export const forgetPresenceThrottle = () => {
  latest.clear();
  lastWrite.clear();
};

const seenAt = (company, user) =>
  Math.max(
    whenOf(
      one(
        "SELECT seen_at FROM presence WHERE company_id=? AND user_id=?",
        company,
        user,
      )?.seen_at,
    ),
    latest.get(company + ":" + user) || 0,
  );

// For every signed-in request: if the page says the person is here, note it.
// The header names the company the tab is showing, because one cookie serves
// every tab in a browser and the session's company moves on each switch; a
// company the person is not in falls back to the session's own.
export function presenceFromRequests(req, res, next) {
  const here = req.get("x-tameduck-here");
  if (here && req.user && req.company) {
    const company =
      here !== "1" && memberFor(here, req.user.id) ? here : req.company.id;
    notePresence(company, req.user.id);
  }
  next();
}

// ---- what is waiting --------------------------------------------------------
// Times in this database are ISO strings, except a few old rows written by
// SQLite's datetime(), which has a space where ISO has a T and no zone. Read
// bare, JavaScript takes those as local time; they are UTC.
function whenOf(value) {
  if (!value) return 0;
  const s = String(value);
  return (
    Date.parse(
      /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(s)
        ? s.replace(" ", "T") + "Z"
        : s,
    ) || 0
  );
}

// Who may decide each kind of proposal. The same rules the proposal modules
// apply when somebody presses Approve.
const mayDecide = {
  skill: (p) => p.skills && p.ducks && p.approvals,
  board: (p) => p.tasks && p.approvals,
  schedule: (p) => p.tasks,
  approval: (p) => p.approvals,
};

// The join both this and /api/state make, from a message to the run that
// wrote it, has the index jobs_output_message. Without it, it is a scan of
// every job, per message, per person, every minute.

// Everything waiting on one person in one company, with when each thing
// started waiting. This is the Needs you page's own list - the same sources,
// through the same inboxRows() - minus what is not for this email.
export function waitingFor(company, user) {
  const member = memberFor(company, user);
  if (!member) return [];
  const p = permissions(member);
  const data = {
    ducks: all("SELECT id,name FROM ducks WHERE company_id=?", company),
    // As /api/state sends it, plus the job behind each message - when a duck's
    // question landed is when its run finished, not when the message row was
    // made, which is when the run was queued, up to hours earlier - and the
    // conversation, to know whether this person can still answer in it.
    inbox: all(
      `SELECT m.*,d.name duck_name,j.id job_id,j.updated job_updated,j.task_id,
              c.archived conversation_archived,c.creator_id conversation_creator
         FROM inbox i
         JOIN messages m ON m.id=i.message_id
         JOIN conversations c ON c.id=m.conversation_id
         LEFT JOIN ducks d ON d.id=m.duck_id
         JOIN conversation_members cm ON cm.conversation_id=m.conversation_id AND cm.user_id=i.user_id
         LEFT JOIN jobs j ON j.output_message_id=m.id
        WHERE m.company_id=? AND i.user_id=? AND i.state='pending'`,
      company,
      user,
    ),
    // The page's own rule: the hundred newest. Approvals never expire, so a
    // schedule that asks for one every quarter of an hour passes a hundred in a
    // day, and the ones past that are not on the page the button opens.
    approvals: p.approvals
      ? all(
          `SELECT a.*,d.name duck_name
             FROM approvals a
             JOIN jobs j ON j.id=a.job_id
             JOIN ducks d ON d.id=j.duck_id
            WHERE a.company_id=? AND a.status='pending'
            ORDER BY a.created DESC LIMIT 100`,
          company,
        )
      : [],
    skill_proposals: mayDecide.skill(p)
      ? listSkillProposals(company, user)
      : [],
    board_proposals: mayDecide.board(p)
      ? listBoardProposals(company, user)
      : [],
    schedule_proposals: mayDecide.schedule(p)
      ? listScheduleProposals(company, user)
      : [],
  };
  const out = [];
  for (const row of inboxRows(data).waiting) {
    const item = row.item;
    if (row.kind === "message") {
      // A note the product wrote itself rather than a duck's question. The
      // ones that matter - a schedule that stopped, the month's computer time -
      // have their own email already.
      if (!item.job_id) continue;
      // A question this person can no longer answer: chat taken away, or the
      // channel archived by somebody else. Every way to reply would refuse
      // them, so the email would send them to a door that does not open.
      if (!p.chat) continue;
      if (
        item.conversation_archived &&
        item.conversation_creator !== user &&
        !p.company
      )
        continue;
      out.push({
        key: "message:" + item.id,
        kind: item.task_id ? "stuck" : "question",
        duck: item.duck_name,
        since: whenOf(item.job_updated) || whenOf(item.created),
      });
    } else {
      out.push({
        key: row.id,
        kind: row.kind,
        duck: row.name,
        since: whenOf(item.created),
      });
    }
  }
  // Longest waiting first: that is the one somebody is most held up by.
  return out.sort((a, b) => a.since - b.since);
}

// ---- the sweep ----------------------------------------------------------------
// When reminders started. Anything that began waiting before then is left
// alone, or the first minute after this shipped would have written to every
// person about every approval they had ever ignored.
function liveSince(now) {
  db.prepare(
    "INSERT OR IGNORE INTO email_sent(key,created) VALUES('waiting-reminders:live-since',?)",
  ).run(new Date(now).toISOString());
  return whenOf(
    one(
      "SELECT created FROM email_sent WHERE key='waiting-reminders:live-since'",
    )?.created,
  );
}

// Companies with something that could be owed a reminder right now: begun
// waiting inside the reach and at least half an hour ago. Bounded at both ends
// on purpose. An expired proposal stays 'pending' in its table for ever, and an
// unanswered question keeps its inbox row for ever, so a filter bounded only at
// one end picked the same companies every minute, for good, and did the whole
// of Needs you for all their members each time.
export function companiesWithSomethingWaiting(floor, until) {
  const from = new Date(floor).toISOString();
  const to = new Date(until).toISOString();
  return all(
    `SELECT company_id FROM approvals WHERE status='pending' AND created>=? AND created<=?
     UNION SELECT company_id FROM skill_proposals WHERE status='pending' AND created>=? AND created<=?
     UNION SELECT company_id FROM board_proposals WHERE status='pending' AND created>=? AND created<=?
     UNION SELECT company_id FROM schedule_proposals WHERE status='pending' AND created>=? AND created<=?
     UNION SELECT m.company_id FROM inbox i
            JOIN messages m ON m.id=i.message_id
            JOIN jobs j ON j.output_message_id=m.id
            WHERE i.state='pending' AND m.needs_you IS NOT NULL
              AND j.updated>=? AND j.updated<=?`,
    from,
    to,
    from,
    to,
    from,
    to,
    from,
    to,
    from,
    to,
  ).map((r) => r.company_id);
}

// Let the server answer somebody between two people. better-sqlite3 blocks,
// and a sweep that did every member of every company in one go held up every
// request for as long as it took.
const breathe = () => new Promise((r) => setImmediate(r));

// Who, if anybody, is owed a reminder right now, and send it. Returns how many
// emails went out. Takes the time as an argument so a test can run it at any
// moment it likes.
export async function sweepWaiting(now = Date.now()) {
  const floor = Math.max(now - REACH, liveSince(now));
  const until = now - WAIT;
  if (floor > until) return 0;
  let sent = 0;
  for (const company of companiesWithSomethingWaiting(floor, until)) {
    for (const { user_id: user } of all(
      "SELECT user_id FROM memberships WHERE company_id=?",
      company,
    )) {
      await breathe();
      // Whether the person has this switched off is send()'s question, so the
      // email log gets its "off" row - the answer to "why did I not get it".
      // Somebody who has been in since the latest moment anything could have
      // started and still be owed cannot be owed anything: skip the work.
      const seen = seenAt(company, user);
      if (seen >= until) continue;
      const items = waitingFor(company, user);
      if (!items.length) continue;
      // Something is owed a reminder when it has waited long enough, is not
      // older than the reach, and the person has not been in since it began.
      const owed = items.filter(
        (i) => i.since >= floor && i.since <= until && seen < i.since,
      );
      if (!owed.length) continue;
      sent += await notices.waitingReminder({
        company,
        user,
        items,
        owed,
        now,
      });
    }
  }
  return sent;
}

// ---- a duck's call for help that did not go -------------------------------------
// "A duck needs you for one step" is sent the moment the duck asks, from
// server/human-input.mjs, and nothing asks twice. When that one send failed,
// the person never heard, however soon the mail server was back. So each
// minute looks for a call still open whose email did not go - it gives its
// claim back when a send fails - and sends it, while there is time to act.
// A refused address, or the email switched off, keeps its claim: not again.
// Nor to somebody already taking the screen: a request stays pending while it
// is handed over, and the email asked them to take the screen they were
// taking. Each is read again just before it goes, since a send takes time.
const TOO_LATE = 2 * MINUTE;
const STILL_OPEN = `h.status='pending' AND h.expires>?
   AND NOT EXISTS (SELECT 1 FROM email_sent e WHERE e.key='waiting:'||h.id)
   AND NOT EXISTS (SELECT 1 FROM computer_control c WHERE c.computer_id=h.computer_id)`;
export async function resendDuckRequests(now = Date.now()) {
  let sent = 0;
  for (const { id } of all(
    `SELECT id FROM human_requests h WHERE ${STILL_OPEN}`,
    now + TOO_LATE,
  )) {
    const r = one(
      `SELECT * FROM human_requests h WHERE h.id=? AND ${STILL_OPEN}`,
      id,
      now + TOO_LATE,
    );
    if (!r) continue;
    sent += await notices.waiting({
      company: r.company_id,
      user: r.user_id,
      duck: r.duck_id,
      requestId: r.id,
      computerId: r.computer_id,
      expiresAt: r.expires,
    });
  }
  return sent;
}

// Once a minute, and never two at a time: a slow mail server can make one
// sweep outlast the minute, and a second one starting underneath it would
// write to the same people again.
export function startWaitingSweep() {
  let busy = false;
  let trimmed = 0;
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      await sweepWaiting();
    } catch (e) {
      console.error("Waiting reminders:", e.message);
    }
    // Tasks waiting on a board, and a duck's call for help that did not go, on
    // the same minute. Each its own try, so a fault in one never stops another.
    try {
      await sweepBoards();
    } catch (e) {
      console.error("Board reminders:", e.message);
    }
    try {
      await resendDuckRequests();
    } catch (e) {
      console.error("Duck request emails:", e.message);
    }
    if (Date.now() - trimmed > 60 * MINUTE) {
      trimmed = Date.now();
      trimEmailLog();
    }
    busy = false;
  }, MINUTE);
  timer.unref?.();
  return timer;
}
