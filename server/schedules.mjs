// Work a duck does again and again without being asked.
//
// A schedule is not a task. It is a standing instruction that creates a task
// each time it comes round, and firing one does exactly what a person pressing
// "Ask duck" does, so the result is an ordinary task card and an ordinary
// thread in the duck's chat, with nothing new for anyone to learn.
import { z } from "zod";
import { deploymentDrainRequested } from "./deployment-drain.mjs";
import * as notices from "./mail-notices.mjs";
import {
  db,
  one,
  all,
  run,
  id,
  now,
  tenant,
  onTeam,
  fail,
  can,
  emit,
  audit,
  addMessage,
  directConversation,
  memberFor,
  permissions,
} from "./store.mjs";
import { withTicketActor, commentOnTicket } from "./ticket-activity.mjs";
import { createBoardTask } from "./workflows.mjs";
import {
  nextFire,
  describe,
  REPEATS,
  MINUTE_CHOICES,
  isFrequent,
  knownTimezone,
} from "../shared/schedule-times.mjs";
// A company's clock, which it is given when it is made. Without one "every day
// at nine" means nothing.
export const companyTimezone = (company) =>
  one("SELECT timezone FROM companies WHERE id=?", company)?.timezone || "UTC";
const scheduledRequestBody = (s) =>
  s.title +
  (s.instructions ? "\n\n" + s.instructions : "") +
  "\n\nThis is a scheduled job (" +
  describe(s) +
  "). Do it now. This runs again and again, so reply only with what a person actually needs to know this time. If everything was as expected, call finish_work with outcome completed, a short accurate summary for the saved record, and quiet=true; that keeps chat silent. For findings, call finish_work with quiet=false and a concise message. Use needs_you only if a person has to look at something or decide something.";
// How late is still worth doing. A morning summary produced at lunchtime is
// still the thing that was wanted; one produced the next evening is not.
const graceMs = 6 * 60 * 60 * 1000;
const maxPerCompany = 20;
// How many runs a schedule's page shows at a time. A five-minute check that
// found nothing folds into one line, so a page can hold a morning of them.
const RUNS_PAGE = 30;
const strikesBeforePause = 3;
const active = ["queued", "running", "waiting_human", "waiting_consultation"];
const minute = z.number().int().min(0).max(1439).nullable();
const shape = z.object({
  title: z.string().trim().min(1).max(200),
  instructions: z.string().max(20000).default(""),
  duck_id: z.string().uuid(),
  // Naming a board sends the work there instead of into the duck's chat. The
  // board's own first column decides which duck does it.
  board_id: z.string().uuid().nullable().default(null),
  repeat: z.enum(REPEATS),
  at_minute: minute.default(540),
  on_day: z.number().int().min(0).max(31).nullable().default(null),
  every_minutes: z.number().int().min(1).max(1440).nullable().default(null),
  from_minute: minute.default(null),
  to_minute: minute.default(null),
  weekdays_only: z.boolean().default(false),
  starts_at: z.number().int().nullable().default(null),
});
function validate(a) {
  if (a.repeat === "once" && !a.starts_at)
    fail(400, "Choose the day and time this should happen.");
  if (a.repeat === "weekly" && (a.on_day === null || a.on_day > 6))
    fail(400, "Choose which day of the week this happens on.");
  if (a.repeat === "monthly" && (a.on_day === null || a.on_day < 1))
    fail(400, "Choose which day of the month this happens on.");
  if (isFrequent(a.repeat)) {
    if (a.repeat === "minutes" && !MINUTE_CHOICES.includes(a.every_minutes))
      fail(
        400,
        "Choose how often: every " +
          MINUTE_CHOICES.slice(0, -1).join(", every ") +
          " or every " +
          MINUTE_CHOICES[MINUTE_CHOICES.length - 1] +
          " minutes.",
      );
    if ((a.from_minute === null) !== (a.to_minute === null))
      fail(400, "Give both ends of the time of day, or neither.");
    // Something this frequent that also makes a ticket every time would bury a
    // board within a day, so it is not allowed to.
    if (a.board_id)
      fail(
        400,
        "Something this frequent cannot put a ticket on a board every time. Leave the board out: it will work in the duck's chat and raise a ticket only when it finds something.",
      );
  } else if (a.repeat !== "once" && a.at_minute === null)
    fail(400, "Choose what time this happens.");
}
const plan = (a, timezone) =>
  a.repeat === "once" ? a.starts_at : nextFire({ ...a, timezone }, Date.now());
// Settings says scheduled tasks run on the company's clock, but each schedule
// keeps its own copy of the clock, and changing the company's left every copy
// behind: the page named the new zone while a 09:00 summary went on arriving at
// 09:00 on the old one. Now they move with it. Something that repeats keeps its
// time of day on the new clock; a one-time task keeps the moment it was set for.
export function moveSchedulesToClock(company, timezone) {
  for (const s of all(
    "SELECT * FROM schedules WHERE company_id=? AND timezone<>?",
    company,
    timezone,
  ))
    run(
      "UPDATE schedules SET timezone=?,next_at=?,updated=? WHERE id=?",
      timezone,
      s.repeat === "once" || s.next_at === null ? s.next_at : plan(s, timezone),
      now(),
      s.id,
    );
}
// Whether a run's answer says anything: words, or something it made or
// changed. Read from the reply itself, because a duck that answered but raised
// nothing was filed as "nothing to report" - and a schedule's page then folded
// the answer somebody came to read into a line saying there was none. Needs
// `m`, the run's output message. SQLite's trim() takes off spaces only, so an
// answer of blank lines counted as a reply with nothing under it.
const saidSomething = `(m.id IS NOT NULL AND (trim(m.body,' '||char(9)||char(10)||char(13))<>'' OR EXISTS (
  SELECT 1 FROM message_artifacts a WHERE a.message_id=m.id
  AND a.company_id=m.company_id AND a.verb<>'Viewed')))`;
// What one run came to, in one word the screens can build on: the page folds
// the quiet ones into a line and shows the rest with their answer. Worked out
// from the job and its reply rather than from the note, so runs filed before
// the note could say "replied" read right too.
export function runKind(r) {
  if (r.outcome === "paused") return "paused";
  if (String(r.outcome).startsWith("skipped")) return "skipped";
  if (r.outcome !== "started") return "other";
  // A board schedule files a ticket and has no job of its own.
  if (!r.job_id) return "ticket";
  if (!r.job_status) return r.note === "Did not finish." ? "failed" : "other";
  if (r.job_status === "queued") return "queued";
  if (r.job_status === "waiting_human") return "waiting";
  if (active.includes(r.job_status)) return "working";
  if (r.job_status !== "done" || r.work_outcome === "incomplete")
    return "failed";
  if (r.needs_you) return "raised";
  return r.replied ? "replied" : "quiet";
}
// The first few lines of an answer, as plain sentences. A reply is written for
// the chat, in Markdown, and a page of them showing the marks (###, **, |---|)
// or a half-cut table reads as noise. The whole answer is one press away.
//
// It costs what it keeps. It stops a line after the last one it shows, and a
// line is cut to a little more than can be shown before the marks are taken
// out. It used to clean every line of the whole answer first, with patterns
// that backtrack on long lines: one line of 40,000 spaces held the server,
// and every company on it, for two seconds.
export function excerpt(text, lines = 4, chars = 480) {
  const body = String(text || "");
  const plain = [];
  let cut = false;
  for (let from = 0; from <= body.length && plain.length <= lines;) {
    let end = body.indexOf("\n", from);
    if (end < 0) end = body.length;
    const whole = body.slice(from, end);
    from = end + 1;
    const first = whole.search(/\S/);
    if (first < 0) continue;
    // Up to three spaces before a mark still make it one.
    const start = Math.max(0, first - 3);
    const raw = whole.slice(start, first + chars + 200);
    const long = whole.length - start > raw.length;
    const bare = raw.trim();
    // Fences, a table's rule row and a horizontal rule say nothing.
    if (
      /^(```|~~~)/.test(bare) ||
      (/^[\s:|-]+$/.test(bare) && bare.includes("|") && bare.includes("-")) ||
      /^([-*_])(?:\s*\1){2,}$/.test(bare)
    )
      continue;
    let line = raw
      .replace(/^\s{0,3}#{1,6}\s+/, "")
      .replace(/^\s*>\s?/, "")
      .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "")
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/(\*\*|__)(.+?)\1/g, "$2")
      .replace(/(^|[\s(])[*_]([^*_\s][^*_]*?)[*_](?=[\s).,;:!?]|$)/g, "$1$2")
      .replace(/`([^`]*)`/g, "$1");
    if (/^\s*\|.*\|\s*$/.test(line))
      line = line
        .trim()
        .replace(/^\||\|$/g, "")
        .split("|")
        .map((cell) => cell.trim())
        .filter(Boolean)
        .join(" · ");
    line = line.replace(/\s+/g, " ").trim();
    if (!line) continue;
    plain.push(line);
    if (long && plain.length <= lines) cut = true;
  }
  let said = plain.slice(0, lines).join("\n");
  if (plain.length > lines) cut = true;
  if (said.length > chars) {
    said = said.slice(0, chars).replace(/\s+\S*$/, "");
    cut = true;
  }
  return { said, cut };
}
export function publicSchedule(s) {
  const last = one(
    `SELECT r.*,j.status job_status,f.outcome work_outcome,j.needs_you,${saidSomething} replied
     FROM schedule_runs r
     LEFT JOIN jobs j ON j.id=r.job_id AND j.company_id=r.company_id
     LEFT JOIN job_work_finishes f ON f.job_id=j.id
     LEFT JOIN messages m ON m.id=j.output_message_id AND m.company_id=j.company_id
     WHERE r.schedule_id=? AND r.company_id=? AND r.outcome<>'paused'
     ORDER BY r.created DESC LIMIT 1`,
    s.id,
    s.company_id,
  );
  return {
    id: s.id,
    title: s.title,
    instructions: s.instructions,
    duck_id: s.duck_id,
    board_id: s.board_id,
    repeat: s.repeat,
    at_minute: s.at_minute,
    on_day: s.on_day,
    every_minutes: s.every_minutes,
    from_minute: s.from_minute,
    to_minute: s.to_minute,
    weekdays_only: !!s.weekdays_only,
    incident_task_id: s.incident_task_id,
    timezone: s.timezone,
    next_at: s.next_at,
    paused: !!s.paused,
    paused_reason: s.paused_reason || "",
    strikes: s.strikes,
    runner_id: s.runner_id,
    summary: describe(s),
    last_run: last
      ? {
          outcome: last.outcome,
          note: last.note,
          at: last.created,
          job_status: last.job_status || null,
          kind: runKind(last),
        }
      : null,
  };
}
export const listSchedules = (company) =>
  all(
    "SELECT * FROM schedules WHERE company_id=? ORDER BY created",
    company,
  ).map(publicSchedule);

// A paused schedule's card in Needs you, taken off everybody's list once it is
// running again or gone. It said "It stays paused until somebody turns it back
// on", and stayed there, still counted, after they had.
function clearPausedCard(company, scheduleId) {
  run(
    "UPDATE inbox SET state='replied' WHERE state='pending' AND message_id IN (SELECT id FROM messages WHERE company_id=? AND origin=?)",
    company,
    "schedule-paused:" + scheduleId,
  );
}

// Remove one schedule and its run history as one operation. Proposal approval
// uses the same path as the human route, so an approved duck request cannot
// leave behind a runnable row or orphaned run records.
export function removeSchedule(
  company,
  scheduleId,
  { preserveProposalId = null } = {},
) {
  const s = one(
    "SELECT * FROM schedules WHERE id=? AND company_id=?",
    scheduleId,
    company,
  );
  if (!s) fail(404, "That scheduled task no longer exists.");
  db.transaction(() => {
    run(
      `UPDATE schedule_proposals
       SET status=CASE
         WHEN status='pending' AND (? IS NULL OR id<>?) THEN 'obsolete'
         ELSE status
       END,schedule_id=NULL
       WHERE schedule_id=? AND company_id=?`,
      preserveProposalId,
      preserveProposalId,
      s.id,
      company,
    );
    run(
      "DELETE FROM schedule_runs WHERE schedule_id=? AND company_id=?",
      s.id,
      company,
    );
    run("DELETE FROM schedules WHERE id=? AND company_id=?", s.id, company);
    clearPausedCard(company, s.id);
  })();
  return s;
}
function record(s, outcome, note, taskId = null, jobId = null) {
  run(
    "INSERT INTO schedule_runs(id,company_id,schedule_id,due,outcome,task_id,job_id,note,created) VALUES(?,?,?,?,?,?,?,?,?)",
    id(),
    s.company_id,
    s.id,
    s.next_at,
    outcome,
    taskId,
    jobId,
    note,
    now(),
  );
}
// Move to the next occurrence, but only if nobody has moved it already. The
// compare against the value we acted on is what makes a second tick arriving
// at the same moment unable to fire the same occurrence twice.
// One manual run of a schedule at a time. A single process, so a set is the
// whole of it.
const runningByHand = new Set();
const advance = (s) =>
  run(
    "UPDATE schedules SET next_at=?,updated=? WHERE id=? AND next_at IS ?",
    s.repeat === "once" ? null : nextFire(s, Date.now()),
    now(),
    s.id,
    s.next_at,
  ).changes > 0;
// `why` is written for the row under the schedule's own name, so it does not
// repeat the title; the message in chat does, because there it stands alone.
function pause(s, why) {
  // Already stopped. "Run now" picks a schedule by id without asking whether it
  // is paused, so pressing it on a schedule that stopped last Tuesday ran all
  // of this again: another chat message, another line in its history, and
  // another email to every owner and admin about a stop they were told about
  // days ago - and told about again by the very screen they pressed it on.
  if (s.paused) return emit(s.company_id);
  // Out loud, to the people who can start it again. A paused schedule is
  // standing work that has stopped for good, and the message this also writes
  // lands in a chat nobody has open.
  notices
    .scheduleStopped({ company: s.company_id, title: s.title, reason: why })
    .catch((e) => console.error("Schedule stopped email:", e.message));
  run(
    "UPDATE schedules SET paused=1,paused_reason=?,updated=? WHERE id=?",
    why,
    now(),
    s.id,
  );
  // Without this the screen went on showing the last run that went well, so a
  // dead schedule read "Paused - Last run: Ran, nothing to report."
  record(s, "paused", why);
  const duck = one("SELECT * FROM ducks WHERE id=?", s.duck_id);
  // One reason a schedule stops is that the person it ran for has left, and
  // saying so in that person's own chat told nobody. Anybody still here is
  // better than somebody who is gone, and the owner is always still here.
  const tell =
    (memberFor(s.company_id, s.runner_id) && s.runner_id) ||
    one(
      "SELECT user_id FROM memberships WHERE company_id=? AND role='owner'",
      s.company_id,
    )?.user_id;
  if (!duck || !tell) return emit(s.company_id);
  const conversation = directConversation(s.company_id, tell, duck);
  const said = "\u201c" + s.title + "\u201d is paused. " + why;
  // Marked with the schedule, so Needs you sends people to the schedules,
  // where it is turned back on, rather than offering a reply - nothing typed
  // into a chat does it - and takes the card away once it has been.
  addMessage(s.company_id, conversation.id, said, {
    duck: s.duck_id,
    inbox: true,
    needs: said,
    origin: "schedule-paused:" + s.id,
  });
  emit(s.company_id);
}
// What a finished run turned out to be. A schedule that works in a duck's chat
// says nothing most of the time; it is only worth a ticket when the duck says a
// person is needed. While that ticket is open, anything further is added to it
// rather than opening another, so a check running every few minutes cannot bury
// anybody under copies of the same problem.
export function settleFinishedRuns() {
  for (const r of all(
    `SELECT r.*,j.status,f.outcome work_outcome,j.needs_you,j.output_message_id,${saidSomething} replied
     FROM schedule_runs r JOIN jobs j ON j.id=r.job_id
     LEFT JOIN job_work_finishes f ON f.job_id=j.id
     LEFT JOIN messages m ON m.id=j.output_message_id AND m.company_id=j.company_id
     WHERE r.settled=0 AND r.outcome='started' AND j.status NOT IN ('queued','running','waiting_human','waiting_consultation') LIMIT 100`,
  )) {
    // Say what the run did, so the schedules screen has something to show
    // besides the word it is filed under while it is still going. An answer
    // with something in it is a reply, even when nobody is needed for it.
    run(
      "UPDATE schedule_runs SET settled=1,note=? WHERE id=?",
      r.status === "done" && r.work_outcome !== "incomplete"
        ? r.needs_you
          ? "Ran, and raised something for you."
          : r.replied
            ? "Ran, and replied."
            : "Ran, nothing to report."
        : r.work_outcome === "incomplete"
          ? "Finished with work remaining."
          : "Did not finish.",
      r.id,
    );
    const s = one("SELECT * FROM schedules WHERE id=?", r.schedule_id);
    // A board schedule already has its ticket; there is nothing to decide.
    if (!s || s.board_id || !r.needs_you) continue;
    const open =
      s.incident_task_id &&
      one(
        "SELECT * FROM tasks WHERE id=? AND status<>'done'",
        s.incident_task_id,
      );
    if (open) {
      commentOnTicket(
        s.company_id,
        open.id,
        { user_id: s.runner_id, duck_id: s.duck_id },
        r.needs_you,
        "schedule:" + r.id,
      );
      run("UPDATE schedule_runs SET task_id=? WHERE id=?", open.id, r.id);
      emit(s.company_id);
      continue;
    }
    const taskId = id();
    withTicketActor(s.company_id, { user_id: s.runner_id }, () => {
      run(
        "INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?,?,?,?)",
        taskId,
        s.company_id,
        s.title,
        r.needs_you,
        s.duck_id,
        "open",
        "normal",
        s.creator_id,
        "",
        now(),
        now(),
      );
    });
    run(
      "UPDATE schedules SET incident_task_id=?,updated=? WHERE id=?",
      taskId,
      now(),
      s.id,
    );
    run("UPDATE schedule_runs SET task_id=? WHERE id=?", taskId, r.id);
    emit(s.company_id);
  }
}
export async function tickSchedules({ enqueue, aiStatus, only = null }) {
  if (deploymentDrainRequested()) return;
  settleFinishedRuns();
  // `only` is somebody pressing Run now. That one schedule runs whatever its
  // turn says, even a paused one, and treats itself as due this moment - but
  // its turn is left exactly where it was, because running a thing by hand is
  // not its turn coming round. Nothing on this path writes next_at or paused at
  // all, which is what stops a manual run from undoing whatever a teammate is
  // doing to the same row at the same moment.
  const manual = !!only;
  const due = manual
    ? all(
        "SELECT s.* FROM schedules s JOIN companies c ON c.id=s.company_id WHERE s.id=? AND c.paused=0",
        only,
      ).map((s) => ({ ...s, next_at: Date.now() }))
    : all(
        "SELECT s.* FROM schedules s JOIN companies c ON c.id=s.company_id WHERE s.paused=0 AND c.paused=0 AND s.next_at IS NOT NULL AND s.next_at<=? ORDER BY s.next_at LIMIT 50",
        Date.now(),
      );
  for (const s of due) {
    if (deploymentDrainRequested()) return;
    try {
      const member = memberFor(s.company_id, s.runner_id);
      if (!member || !permissions(member).tasks || !permissions(member).chat) {
        pause(
          s,
          "The person this ran for can no longer be asked to do this work. Turning it back on will hand it to you.",
        );
        continue;
      }
      const duck = one(
        "SELECT * FROM ducks WHERE id=? AND company_id=?",
        s.duck_id,
        s.company_id,
      );
      if (!duck) {
        pause(s, "Its duck is gone.");
        continue;
      }
      // Nothing here is this schedule's fault, so it keeps its place and tries
      // again rather than losing its turn. The lateness rule below is what
      // stops it retrying forever - except it could never reach a schedule that
      // stopped here, because this returned first. A company with no AI
      // connected had every schedule sit in the past with "Next:" showing a
      // time that had already been and gone, saying nothing to anybody; and
      // when an AI was finally connected, the first tick wrote "TameDuck was
      // not running at the time this was due" into the log, which is not what
      // happened. So this waits out the same grace period, then says the true
      // reason, and gives up on a schedule that has missed its turn three times
      // over rather than missing it silently for ever.
      const ai = await aiStatus(s.company_id);
      if (deploymentDrainRequested()) return;
      // The AI status check yields to HTTP requests. A human or approved duck
      // removal may delete this row while it is pending, so never advance or
      // enqueue from the stale snapshot after the await.
      if (
        !one(
          "SELECT 1 FROM schedules WHERE id=? AND company_id=?",
          s.id,
          s.company_id,
        )
      )
        continue;
      if (!ai.connected) {
        if (Date.now() - s.next_at > graceMs) {
          record(
            s,
            "skipped_late",
            "Skipped: no AI was connected when this was due.",
          );
          run(
            "UPDATE schedules SET strikes=strikes+1,updated=? WHERE id=?",
            now(),
            s.id,
          );
          advance(s);
          const waiting = one("SELECT * FROM schedules WHERE id=?", s.id);
          if (waiting.strikes >= strikesBeforePause)
            pause(
              s,
              "It has missed " +
                waiting.strikes +
                " turns because no AI is connected. Connect one in Settings, AI connection, then turn this back on.",
            );
          emit(s.company_id);
        }
        continue;
      }
      const previous = one(
        "SELECT * FROM schedule_runs WHERE schedule_id=? AND job_id IS NOT NULL ORDER BY created DESC LIMIT 1",
        s.id,
      );
      const running =
        previous &&
        one(
          "SELECT 1 FROM jobs WHERE id=? AND status IN ('queued','running','waiting_human','waiting_consultation')",
          previous.job_id,
        );
      if (running) {
        record(
          s,
          "skipped_overlap",
          "Skipped, the previous run was still going.",
        );
        // A schedule that keeps skipping its own turn is piling up and gets
        // stopped. Somebody pressing the button and being told the last run is
        // still going has skipped nothing.
        if (!manual) {
          run(
            "UPDATE schedules SET strikes=strikes+1,updated=? WHERE id=?",
            now(),
            s.id,
          );
          advance(s);
          const after = one("SELECT * FROM schedules WHERE id=?", s.id);
          if (after.strikes >= strikesBeforePause)
            pause(
              s,
              "Skipped " +
                after.strikes +
                " times because the run before it had not finished, so it is paused rather than piling up.",
            );
        }
        emit(s.company_id);
        continue;
      }
      if (Date.now() - s.next_at > graceMs) {
        record(
          s,
          "skipped_late",
          "Skipped, TameDuck was not running at the time this was due.",
        );
        advance(s);
        emit(s.company_id);
        continue;
      }
      // A run that ended badly is only noticed here, because a failed run says
      // nothing to anybody on its own. Say it once, then try again.
      const brokeLast =
        previous &&
        one(
          "SELECT 1 FROM jobs WHERE id=? AND status IN ('error','interrupted','cancelled')",
          previous.job_id,
        );
      const conversation = directConversation(s.company_id, s.runner_id, duck);
      if (brokeLast) {
        run(
          "UPDATE schedules SET strikes=strikes+1,updated=? WHERE id=?",
          now(),
          s.id,
        );
        // Enough. A schedule whose runs keep ending badly used to say so and
        // try again, for ever: the strike was counted here and wiped a few
        // lines below when the next run was enqueued, so the count never
        // reached anything. A broken five-minute schedule fired 288 times a
        // day and dropped 288 "did not finish" items into Needs you, until
        // somebody found it and switched it off by hand.
        const failing = one("SELECT * FROM schedules WHERE id=?", s.id);
        if (failing.strikes >= strikesBeforePause) {
          pause(
            s,
            "The last " +
              failing.strikes +
              " runs ended without finishing, so it is paused rather than" +
              " trying again every time. Look at what it left behind, then" +
              " turn it back on.",
          );
          emit(s.company_id);
          continue;
        }
        // In the chat, not in Needs you: nothing is asked of anybody while it
        // tries again, and there it read "waiting for your reply" over the
        // words "Trying again now". If it goes on failing it is paused, and
        // that is in Needs you.
        addMessage(
          s.company_id,
          conversation.id,
          "**" + s.title + "** did not finish last time. Trying again now.",
          { duck: s.duck_id },
        );
      }
      const at = s.next_at;
      // Taking the turn, and the compare inside it is what stops two ticks
      // arriving together from firing the same occurrence twice. A manual run
      // is not taking a turn, so it does neither.
      if (!manual && !advance(s)) continue;
      let started = null;
      try {
        if (s.board_id) {
          // Onto a board: an ordinary ticket in its first column, which the
          // board's own engine picks up and runs through its stages. The board
          // decides which duck does it, so nothing here chooses one.
          withTicketActor(s.company_id, { user_id: s.runner_id }, () => {
            const ticket = createBoardTask(
              s.company_id,
              s.runner_id,
              s.board_id,
              { title: s.title, description: s.instructions },
            );
            started = {
              taskId: ticket.id || ticket.task_id || null,
              job: null,
            };
          });
        } else
          // Into the duck's chat: it works, and says what it found. Nothing
          // appears on a board unless the duck says a person is needed, which
          // is settled once the run has finished.
          withTicketActor(s.company_id, { user_id: s.runner_id }, () => {
            const message = addMessage(
              s.company_id,
              conversation.id,
              scheduledRequestBody(s),
              { user: s.runner_id, origin: "schedule" },
            );
            const job = enqueue(
              s.company_id,
              s.runner_id,
              conversation.id,
              duck.id,
              message,
              {
                schedule: {
                  id: s.id,
                  title: s.title,
                  summary: describe(s),
                },
              },
            );
            started = { taskId: null, job };
          });
      } catch (e) {
        // The flock being full is not this schedule's failure either, but its
        // turn has already been moved on, so put it back rather than losing it.
        // A manual run never moved it.
        if (!manual)
          run(
            "UPDATE schedules SET next_at=?,updated=? WHERE id=?",
            at,
            now(),
            s.id,
          );
        if (e.status !== 429) throw e;
        continue;
      }
      record(s, "started", "", started.taskId, started.job);
      // A board schedule's work is the ticket, and that is filed the moment
      // this runs. There is no job to watch, and settling only ever looks at
      // rows it can join to one, so this row stayed unsettled for good: the
      // Schedules page said "Last run: running now" about a run that had
      // finished days ago. Say what actually happened.
      if (s.board_id && started.taskId)
        run(
          "UPDATE schedule_runs SET settled=1,note=? WHERE schedule_id=? AND task_id=? AND settled=0",
          "Filed onto the board.",
          s.id,
          started.taskId,
        );
      // Starting a run is not the same as one having gone well. Wiping the
      // count here meant the strike counted a moment ago for a run that had
      // just failed was gone before anything could act on it. A run that
      // finishes clears it, a little further down.
      run(
        "UPDATE schedules SET last_fired_at=?,updated=? WHERE id=?",
        Date.now(),
        now(),
        s.id,
      );
      if (!brokeLast)
        run("UPDATE schedules SET strikes=0,updated=? WHERE id=?", now(), s.id);
      emit(s.company_id);
    } catch (e) {
      console.error("Scheduled task failed:", s.id, e.message);
    }
  }
}
export function startScheduleEngine(deps) {
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      await tickSchedules(deps);
    } catch (e) {
      console.error("Schedule engine:", e.message);
    } finally {
      busy = false;
    }
  }, 30000);
  timer.unref();
  return timer;
}
// Making a schedule row, shared by the form and by a duck's request so the two
// cannot end up meaning different things.
export function createSchedule(company, user, duckId, a, timezone, next) {
  // Checked here rather than only in the form, because a duck proposing one and
  // a trusted duck setting one up on its own both arrive by other doors.
  if (
    one("SELECT count(*) n FROM schedules WHERE company_id=?", company).n >=
    maxPerCompany
  )
    fail(
      409,
      "This company already has " +
        maxPerCompany +
        " scheduled tasks. Remove one before adding another.",
    );
  const sid = id();
  run(
    "INSERT INTO schedules(id,company_id,title,instructions,duck_id,board_id,repeat,at_minute,on_day,every_minutes,from_minute,to_minute,weekdays_only,timezone,next_at,runner_id,creator_id,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    sid,
    company,
    a.title,
    a.instructions || "",
    duckId,
    a.board_id || null,
    a.repeat,
    isFrequent(a.repeat) || a.repeat === "once" ? null : a.at_minute,
    a.repeat === "weekly" || a.repeat === "monthly" ? a.on_day : null,
    a.repeat === "minutes" ? a.every_minutes : null,
    isFrequent(a.repeat) ? a.from_minute : null,
    isFrequent(a.repeat) ? a.to_minute : null,
    isFrequent(a.repeat) && a.weekdays_only ? 1 : 0,
    timezone,
    next,
    user,
    user,
    now(),
    now(),
  );
  emit(company);
  return one("SELECT * FROM schedules WHERE id=?", sid);
}
// Changing one, shared by the form and by a duck's request a person agreed to,
// for the same reason: the same change has to mean the same thing whichever
// door it came through.
// Whether a change alters what a schedule does, which duck does it or where it
// lands - as opposed to only its name or time.
export const changesWork = (s, a) =>
  a.instructions !== s.instructions ||
  a.duck_id !== s.duck_id ||
  (a.board_id ?? null) !== (s.board_id ?? null);
// `by` is the person a change is made for: whoever edits it, or whoever a duck
// asked for it on behalf of. A schedule runs as its person, in their own chat
// with the duck, so anybody else who changes what it does takes it over: a
// colleague - by the form, or through a duck - could otherwise rewrite
// somebody's schedule and have a duck act as that person in their private
// chat. A new name or time leaves it with its person, as turning it back on
// does.
export function changeSchedule(company, s, a, next, { by = null } = {}) {
  const takeover = !!by && by !== s.runner_id && changesWork(s, a);
  // Given to another duck, one that stopped because its duck was taken off
  // the team no longer has that reason. The page and the list went on
  // naming the duck that left, under the one that now does it, and offered
  // nothing but a Turn back on that the duck's absence refused. It stays
  // paused until somebody turns it back on.
  const was = one(
    "SELECT name,removed FROM ducks WHERE id=? AND company_id=?",
    s.duck_id,
    company,
  );
  const why = String(s.paused_reason || "");
  const replaced =
    a.duck_id !== s.duck_id &&
    (was
      ? !!was.removed && why.startsWith(was.name + " was taken off the team")
      : why === "Its duck is gone.");
  run(
    "UPDATE schedules SET title=?,instructions=?,duck_id=?,board_id=?,repeat=?,at_minute=?,on_day=?,every_minutes=?,from_minute=?,to_minute=?,weekdays_only=?,next_at=?,strikes=0,paused_reason=CASE WHEN ?=1 THEN '' ELSE paused_reason END,runner_id=?,updated=? WHERE id=?",
    a.title,
    a.instructions,
    a.duck_id,
    a.board_id,
    a.repeat,
    isFrequent(a.repeat) || a.repeat === "once" ? null : a.at_minute,
    a.repeat === "weekly" || a.repeat === "monthly" ? a.on_day : null,
    a.repeat === "minutes" ? a.every_minutes : null,
    isFrequent(a.repeat) ? a.from_minute : null,
    isFrequent(a.repeat) ? a.to_minute : null,
    isFrequent(a.repeat) && a.weekdays_only ? 1 : 0,
    next,
    +replaced,
    takeover ? by : s.runner_id,
    now(),
    s.id,
  );
  if (takeover)
    audit(company, by, "Scheduled task taken over", { title: a.title, from: s.runner_id });
  return one("SELECT * FROM schedules WHERE id=?", s.id);
}
// Why a Run now did nothing, when the tick declined without writing a row.
//
// There was one sentence for every such case - "Nothing started. Check the AI
// connection in Settings." - and it was usually wrong. A flock already full, a
// duck taken off the team, a previous run still going: none of them is the AI
// connection, and all of them sent the person to a settings screen that was
// working perfectly. The real reason is knowable from the row and the company,
// so it is said instead.
async function whyNothingStarted(s, aiStatus) {
  const duck = one("SELECT name,removed FROM ducks WHERE id=?", s.duck_id);
  if (!duck) return "Its duck is gone, so this cannot run.";
  if (duck.removed)
    return (
      duck.name +
      " was taken off the team, so it cannot be given work. Put it back, or give this task to another duck."
    );
  if (one("SELECT paused FROM companies WHERE id=?", s.company_id)?.paused)
    return "Your ducks are paused, so nothing can start.";
  if (
    one(
      "SELECT count(*) n FROM jobs WHERE company_id=? AND status IN ('queued','running','waiting_human','waiting_consultation')",
      s.company_id,
    ).n >= 30
  )
    return "Your flock already has 30 tasks going. Let a few finish first.";
  if (!(await aiStatus(s.company_id)).connected)
    return "No AI is connected yet. Connect one in Settings, AI connection.";
  return "Nothing started. The run before this one may still be going.";
}
export function registerSchedules(app, { enqueue, aiStatus }) {
  app.post("/api/schedules", (req, res) => {
    can(req.member, "tasks");
    const a = shape.parse(req.body);
    validate(a);
    onTeam(a.duck_id, req.company.id);
    if (a.board_id) tenant("task_boards", a.board_id, req.company.id);
    if (
      one("SELECT count(*) n FROM schedules WHERE company_id=?", req.company.id)
        .n >= maxPerCompany
    )
      fail(
        409,
        "This company already has " +
          maxPerCompany +
          " scheduled tasks. Remove one before adding another.",
      );
    const timezone = companyTimezone(req.company.id);
    if (!knownTimezone(timezone))
      fail(400, "This company's time zone is not one this server knows.");
    const next = plan(a, timezone);
    if (!next || next <= Date.now()) fail(400, "Choose a time in the future.");
    const sid = id();
    run(
      "INSERT INTO schedules(id,company_id,title,instructions,duck_id,board_id,repeat,at_minute,on_day,every_minutes,from_minute,to_minute,weekdays_only,timezone,next_at,runner_id,creator_id,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      sid,
      req.company.id,
      a.title,
      a.instructions,
      a.duck_id,
      a.board_id,
      a.repeat,
      isFrequent(a.repeat) || a.repeat === "once" ? null : a.at_minute,
      a.repeat === "weekly" || a.repeat === "monthly" ? a.on_day : null,
      a.repeat === "minutes" ? a.every_minutes : null,
      isFrequent(a.repeat) ? a.from_minute : null,
      isFrequent(a.repeat) ? a.to_minute : null,
      isFrequent(a.repeat) && a.weekdays_only ? 1 : 0,
      timezone,
      next,
      req.user.id,
      req.user.id,
      now(),
      now(),
    );
    audit(req.company.id, req.user.id, "Scheduled task created", a.title);
    emit(req.company.id);
    res.json(publicSchedule(one("SELECT * FROM schedules WHERE id=?", sid)));
  });
  app.patch("/api/schedules/:id", (req, res) => {
    can(req.member, "tasks");
    const s = tenant("schedules", req.params.id, req.company.id);
    if (
      req.body &&
      Object.keys(req.body).length === 1 &&
      "paused" in req.body
    ) {
      const paused = z.boolean().parse(req.body.paused);
      // Creating or editing a schedule for a duck that is off the team is
      // refused; turning one back on was not. It said "Turned back on", showed
      // a "Next:" time that came and went, and every tick after it was refused
      // by the queue and threw the failure away - forever, and in silence.
      if (!paused) onTeam(s.duck_id, req.company.id);
      if (!paused && s.repeat === "once" && !s.next_at)
        fail(
          409,
          "Edit this one-time task and choose a new date before turning it back on.",
        );
      // A schedule runs for somebody: a run that is not on a board happens in
      // that person's own chat with the duck and lands in their Needs you. One
      // reason a schedule stops is that its person has left or lost the
      // permissions, and turning it back on has to hand it to somebody who can
      // actually run it or the engine just pauses it again within the half
      // minute, forever. That was written as "hand it to whoever pressed",
      // every time - so a colleague turning a schedule back on after a quiet
      // week quietly took delivery of it, and the person who wrote it and read
      // it every morning simply stopped receiving it, with neither of them told.
      const runner = memberFor(req.company.id, s.runner_id);
      const runnable =
        runner && permissions(runner).tasks && permissions(runner).chat;
      run(
        // Starting it again also clears why it stopped, so an old explanation
        // does not sit under a schedule that is running perfectly well.
        "UPDATE schedules SET paused=?,strikes=0,paused_reason=CASE WHEN ?=1 THEN paused_reason ELSE '' END,runner_id=CASE WHEN ?=1 THEN runner_id ELSE ? END,next_at=?,updated=? WHERE id=?",
        +paused,
        +paused,
        +paused,
        runnable ? s.runner_id : req.user.id,
        paused ? s.next_at : plan(s, s.timezone) || s.next_at,
        now(),
        s.id,
      );
      if (!paused) clearPausedCard(req.company.id, s.id);
      emit(req.company.id);
      return res.json(
        publicSchedule(one("SELECT * FROM schedules WHERE id=?", s.id)),
      );
    }
    const a = shape.parse(req.body);
    validate(a);
    onTeam(a.duck_id, req.company.id);
    if (a.board_id) tenant("task_boards", a.board_id, req.company.id);
    const next = plan(a, s.timezone);
    if (!next || next <= Date.now()) fail(400, "Choose a time in the future.");
    // Rewriting what somebody else's schedule does makes it yours (see
    // changeSchedule), and a schedule runs in its person's chat.
    if (req.user.id !== s.runner_id && changesWork(s, a)) can(req.member, "chat");
    changeSchedule(req.company.id, s, a, next, { by: req.user.id });
    audit(req.company.id, req.user.id, "Scheduled task updated", a.title);
    emit(req.company.id);
    res.json(publicSchedule(one("SELECT * FROM schedules WHERE id=?", s.id)));
  });
  app.delete("/api/schedules/:id", (req, res) => {
    can(req.member, "tasks");
    const s = tenant("schedules", req.params.id, req.company.id);
    removeSchedule(req.company.id, s.id);
    audit(req.company.id, req.user.id, "Scheduled task removed", s.title);
    emit(req.company.id);
    res.json({ ok: true });
  });
  // What each run did, newest first, a page at a time: `before` is the last run
  // already shown, and one more than a page comes back so the screen knows
  // whether to offer earlier ones. Twenty grey lines of "finished" said nothing
  // about what the duck found, so each run carries the first lines of its
  // answer and where it is in the chat - but only to somebody in that chat. A
  // schedule runs in its person's own chat with the duck, and a teammate who
  // can manage the schedule is not thereby someone who may read that chat.
  app.get("/api/schedules/:id/runs", (req, res) => {
    can(req.member, "tasks");
    const s = tenant("schedules", req.params.id, req.company.id);
    const after = req.query?.before;
    const before =
      typeof after === "string" && after
        ? one(
            "SELECT created,rowid n FROM schedule_runs WHERE id=? AND schedule_id=? AND company_id=?",
            after.slice(0, 100),
            s.id,
            req.company.id,
          )
        : null;
    // The run it was paging back from is gone: there is nothing earlier to
    // show from there.
    if (after && !before) return res.json({ runs: [], more: false });
    const rows = all(
      `SELECT r.id,r.due,r.outcome,r.note,r.task_id,r.job_id,r.created,
         j.status job_status,j.needs_you,j.conversation_id,
         j.output_message_id,m.thread_id,m.body,${saidSomething} replied,
         EXISTS (SELECT 1 FROM conversation_members cm
           WHERE cm.conversation_id=j.conversation_id AND cm.user_id=?) mine
       FROM schedule_runs r
       LEFT JOIN jobs j ON j.id=r.job_id AND j.company_id=r.company_id
       LEFT JOIN messages m ON m.id=j.output_message_id AND m.company_id=j.company_id
       WHERE r.schedule_id=? AND r.company_id=?
         ${before ? "AND (r.created<? OR (r.created=? AND r.rowid<?))" : ""}
       ORDER BY r.created DESC, r.rowid DESC LIMIT ?`,
      req.user.id,
      s.id,
      req.company.id,
      ...(before ? [before.created, before.created, before.n] : []),
      RUNS_PAGE + 1,
    );
    res.json({
      more: rows.length > RUNS_PAGE,
      runs: rows.slice(0, RUNS_PAGE).map((r) => {
        const kind = runKind(r);
        const words =
          kind === "raised"
            ? r.body?.trim()
              ? r.body
              : r.needs_you
            : kind === "replied"
              ? r.body
              : "";
        return {
          id: r.id,
          due: r.due,
          outcome: r.outcome,
          note: r.note,
          task_id: r.task_id,
          created: r.created,
          job_status: r.job_status || null,
          kind,
          ...(r.mine && r.conversation_id
            ? {
                conversation_id: r.conversation_id,
                message_id: r.output_message_id,
                thread_id: r.thread_id || null,
                ...excerpt(words),
              }
            : {}),
        };
      }),
    });
  });
  app.post("/api/schedules/:id/run", async (req, res) => {
    can(req.member, "tasks");
    const s = tenant("schedules", req.params.id, req.company.id);
    if (req.company.paused)
      fail(409, "Resume the flock before running this by hand.");
    // Run now used to bring the schedule's turn forward, let the ordinary tick
    // pick it up, and then put the turn back from values read before a wait
    // that really waits. Pause and Run now sit next to each other on the same
    // row of the same screen, so a teammate acting during that wait is the
    // ordinary case, and the restore put their pause back to running and their
    // new time back to the old one. Two people pressing Run now was worse: both
    // restored, the later one to a moment already past, and the engine ran the
    // work a second time nobody asked for. The tick is now told to run this one
    // schedule and to leave its turn alone, so this path writes nothing to the
    // row at all and has nothing to undo.
    if (runningByHand.has(s.id))
      fail(409, "This is already being run by hand. Wait for it to finish.");
    // A tick can decline to run this: the previous run may still be going, or
    // there may be no AI connected. Saying "Started now" either way told people
    // something had happened when nothing had.
    const before = one(
      "SELECT id FROM schedule_runs WHERE schedule_id=? ORDER BY created DESC LIMIT 1",
      s.id,
    )?.id;
    runningByHand.add(s.id);
    try {
      await tickSchedules({ enqueue, aiStatus, only: s.id });
    } finally {
      runningByHand.delete(s.id);
    }
    const latest = one(
      `SELECT r.*,j.status job_status FROM schedule_runs r
       LEFT JOIN jobs j ON j.id=r.job_id AND j.company_id=r.company_id
       WHERE r.schedule_id=? AND r.company_id=?
       ORDER BY r.created DESC LIMIT 1`,
      s.id,
      req.company.id,
    );
    const fresh = latest && latest.id !== before;
    emit(req.company.id);
    res.json({
      ...publicSchedule(one("SELECT * FROM schedules WHERE id=?", s.id)),
      started: !!fresh && latest.outcome === "started",
      outcome: fresh
        ? latest.outcome === "started"
          ? latest.job_status === "queued"
            ? "Queued to run."
            : "It is running now."
          : latest.note
        : await whyNothingStarted(s, aiStatus),
    });
  });
}
