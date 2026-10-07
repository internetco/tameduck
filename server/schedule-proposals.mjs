// A duck asking to set up work that repeats, to change it, or to stop it.
//
// Somebody says "check zabbix every five minutes" in chat, and the duck offers
// to set it up. A person sees exactly what it would do and says yes or no,
// because a schedule spends money and queue slots from then on with nobody
// watching. A person who trusts a duck with this can switch the asking off.
import { z } from "zod";
import {
  db,
  one,
  all,
  run,
  id,
  now,
  fail,
  emit,
  audit,
  addMessage,
  tenant,
  onTeam,
  conversationFor,
  memberFor,
  permissions,
  json,
} from "./store.mjs";
import {
  describe,
  nextFire,
  REPEATS,
  MINUTE_CHOICES,
  isFrequent,
  readable,
} from "../shared/schedule-times.mjs";
import {
  changeSchedule,
  companyTimezone,
  publicSchedule,
  removeSchedule,
} from "./schedules.mjs";
import { cardAnswered } from "./unfinished-work.mjs";
export const proposalLifeMs = 86400000;
export const duckMaySchedule = (duck, company) =>
  one(
    "SELECT enabled FROM duck_schedule_access WHERE duck_id=? AND company_id=?",
    duck,
    company,
  )?.enabled === 1;
export function setDuckScheduleAccess(company, duck, enabled) {
  tenant("ducks", duck, company);
  run(
    "INSERT INTO duck_schedule_access VALUES(?,?,?) ON CONFLICT(duck_id) DO UPDATE SET enabled=excluded.enabled",
    duck,
    company,
    enabled ? 1 : 0,
  );
  emit(company);
  return { duck_id: duck, enabled: !!enabled };
}
// What the duck may ask for. The same shapes a person can choose in the form,
// so a duck cannot invent a kind of schedule the product does not have.
export const proposalShape = z.object({
  title: z.string().trim().min(1).max(200),
  instructions: z.string().max(20000).default(""),
  repeat: z.enum(REPEATS),
  at_minute: z.number().int().min(0).max(1439).nullable().default(540),
  on_day: z.number().int().min(0).max(31).nullable().default(null),
  every_minutes: z.number().int().nullable().default(null),
  from_minute: z.number().int().min(0).max(1439).nullable().default(null),
  to_minute: z.number().int().min(0).max(1439).nullable().default(null),
  weekdays_only: z.boolean().default(false),
  board_id: z.string().uuid().nullable().default(null),
});
function check(a, company) {
  if (a.repeat === "once")
    fail(
      400,
      "Propose something that repeats. A one-off is just work you can do now.",
    );
  if (a.repeat === "minutes" && !MINUTE_CHOICES.includes(a.every_minutes))
    fail(
      400,
      "Choose one of: every " + MINUTE_CHOICES.join(", every ") + " minutes.",
    );
  if (a.repeat === "weekly" && (a.on_day === null || a.on_day > 6))
    fail(400, "Say which day of the week.");
  if (a.repeat === "monthly" && (a.on_day === null || a.on_day < 1))
    fail(400, "Say which day of the month.");
  if (
    isFrequent(a.repeat) &&
    (a.from_minute === null) !== (a.to_minute === null)
  )
    fail(400, "Give both ends of the time of day, or neither.");
  if (!isFrequent(a.repeat) && a.at_minute === null)
    fail(400, "Choose what time this happens.");
  if (isFrequent(a.repeat) && a.board_id)
    fail(
      400,
      "Something this frequent cannot put a ticket on a board every time. Leave the board out.",
    );
  if (a.board_id) tenant("task_boards", a.board_id, company);
}
// The sentence a person reads before deciding. It has to carry everything that
// matters: what, how often, who does it, and that it keeps costing.
export function proposalOperation(p) {
  return json(p.payload).operation || "create";
}
// A schedule as it was when a duck asked to change or stop it. That is what a
// person agrees to, so it is checked again, field by field, when they answer:
// a yes on the card is not a yes to whatever the schedule has since become.
const SNAPSHOT = [
  "title",
  "instructions",
  "duck_id",
  "board_id",
  "repeat",
  "at_minute",
  "on_day",
  "every_minutes",
  "from_minute",
  "to_minute",
  "weekdays_only",
  "timezone",
  "paused",
  "runner_id",
];
const snapshotOf = (s) => ({
  id: s.id,
  ...Object.fromEntries(SNAPSHOT.map((field) => [field, s[field]])),
  weekdays_only: !!s.weekdays_only,
});
const unchangedSince = (current, snapshot) =>
  SNAPSHOT.every((field) =>
    field === "weekdays_only" || field === "paused"
      ? !!current[field] === !!snapshot[field]
      : (current[field] ?? null) === (snapshot[field] ?? null),
  );
// replaces_id names a request of the duck's own that nobody has answered. A
// duck asked to change a live schedule once put the schedule's own id there,
// was told only that the request no longer existed, and tried the same thing
// again on every automatic retry.
function noSuchRequest(replaces, company) {
  if (
    one("SELECT 1 FROM schedules WHERE id=? AND company_id=?", replaces, company)
  )
    fail(
      400,
      "That is the id of a scheduled task, not of a request. replaces_id only revises a request of yours that nobody has answered yet. To change the scheduled task itself, use schedule_update with schedule_id=" +
        replaces +
        ".",
    );
  fail(404, "That request no longer exists.");
}
function targetFor(p) {
  const a = json(p.payload);
  if (proposalOperation(p) === "create") return null;
  const snapshot = a.target || {};
  const targetId = a.target_schedule_id || p.schedule_id || snapshot.id;
  const current = targetId
    ? one("SELECT * FROM schedules WHERE id=? AND company_id=?", targetId, p.company_id)
    : null;
  return {
    id: targetId,
    title: snapshot.title ?? "",
    instructions: snapshot.instructions ?? "",
    duck_id: snapshot.duck_id ?? p.duck_id,
    board_id: snapshot.board_id ?? null,
    repeat: snapshot.repeat ?? null,
    at_minute: snapshot.at_minute ?? null,
    on_day: snapshot.on_day ?? null,
    every_minutes: snapshot.every_minutes ?? null,
    from_minute: snapshot.from_minute ?? null,
    to_minute: snapshot.to_minute ?? null,
    weekdays_only: snapshot.weekdays_only ?? false,
    timezone: snapshot.timezone ?? companyTimezone(p.company_id),
    paused: snapshot.paused ?? false,
    runner_id: snapshot.runner_id ?? null,
    current: !!current,
  };
}
function proposalStatus(p) {
  if (proposalOperation(p) !== "create" && p.status === "pending" && !targetFor(p)?.current)
    return "obsolete";
  return expiredStatus(p);
}
// What a change would do, as it is now and as it would be. Only what differs
// is named in `changed`, so a new set of instructions is not lost among three
// lines that stay as they were. It goes by the name it has now, which is the
// one people know it by, even when the change is to its name.
function changeSummary(p) {
  const a = json(p.payload);
  const target = targetFor(p);
  const after = { ...a.proposed, timezone: target.timezone };
  const where = (s) => {
    const board =
      s.board_id && one("SELECT name FROM task_boards WHERE id=?", s.board_id);
    return board
      ? "As a ticket on " + board.name + ", every time"
      : (one("SELECT name FROM ducks WHERE id=?", target.duck_id)?.name ||
          "The duck") +
          " does it in your chat, and only raises a ticket when it finds something";
  };
  const before = {
    title: target.title,
    instructions: target.instructions,
    how_often: target.repeat ? describe(target) : "",
    where: where(target),
  };
  const proposed = {
    title: after.title,
    instructions: after.instructions,
    how_often: describe(after),
    where: where(after),
  };
  // A paused one has no next run, and the card must not promise one.
  const next =
    target.current && !target.paused ? nextFire(after, Date.now()) : null;
  return {
    operation: "update",
    target_schedule_id: target.id,
    ...proposed,
    before,
    changed: Object.keys(proposed).filter((k) => proposed[k] !== before[k]),
    next_run: next ? readable(next, after.timezone) : "",
    paused: !!target.paused,
    timezone: after.timezone,
    current: target.current,
    already_removed: !target.current,
  };
}
export function proposalSummary(company, p) {
  const a = json(p.payload);
  if (proposalOperation(p) === "update") return changeSummary(p);
  if (proposalOperation(p) === "remove") {
    const target = targetFor(p);
    const board = target.board_id && one("SELECT name FROM task_boards WHERE id=?", target.board_id);
    return {
      operation: "remove",
      target_schedule_id: target.id,
      title: target.title,
      instructions: target.instructions,
      how_often: target.repeat ? describe(target) : "",
      where: board
        ? "As a ticket on " + board.name + ", every time"
        : (one("SELECT name FROM ducks WHERE id=?", target.duck_id)?.name || "The duck") +
          " does it in your chat, and only raises a ticket when it finds something",
      timezone: target.timezone,
      current: target.current,
      already_removed: !target.current,
    };
  }
  const duck = one("SELECT name FROM ducks WHERE id=?", p.duck_id);
  const board =
    a.board_id && one("SELECT name FROM task_boards WHERE id=?", a.board_id);
  const timezone = companyTimezone(company);
  const next = nextFire({ ...a, timezone }, Date.now());
  return {
    operation: "create",
    title: a.title,
    instructions: a.instructions,
    how_often: describe({ ...a, timezone }),
    where: board
      ? "As a ticket on " + board.name + ", every time"
      : duck.name +
        " does it in your chat, and only raises a ticket when it finds something",
    first_run: next ? readable(next, timezone) : "",
    timezone,
  };
}
// A card nobody answered is not still waiting. Boards and skills have said so
// since they were written; this one sat in the chat for ever.
const expiredStatus = (p) =>
  p.status === "pending" && p.expires && p.expires <= now()
    ? "expired"
    : p.status;
// About how many times a month a schedule runs, for the card that asks for one:
// what it keeps costing is the thing a person is agreeing to. Counted with
// nextFire over the coming week, so a time window, weekdays only and a clock
// change count the way the runs really will, then scaled to an average month.
// A monthly one is once a month by definition, and a week cannot see it.
// Remembered by shape, because every open tab asks for this list about once a
// second while a duck is writing, and a week of five-minute checks is two
// thousand steps.
const runsCounted = new Map();
export function runsAMonth(schedule, from = Date.now()) {
  if (schedule.repeat === "monthly") return 1;
  const key = JSON.stringify([
    schedule.repeat,
    schedule.at_minute,
    schedule.on_day,
    schedule.every_minutes,
    schedule.from_minute,
    schedule.to_minute,
    !!schedule.weekdays_only,
    schedule.timezone,
  ]);
  if (runsCounted.has(key)) return runsCounted.get(key);
  const week = from + 7 * 86400000;
  let runs = 0;
  for (
    let at = nextFire(schedule, from);
    at && at <= week;
    at = nextFire(schedule, at)
  )
    runs++;
  const month = (runs * 365.25) / 12 / 7;
  // "About 8,800", not "About 8,766": it is an estimate, and looks like one.
  const step = month < 100 ? 1 : 10 ** (Math.floor(Math.log10(month)) - 1);
  const said = Math.round(month / step) * step;
  if (runsCounted.size > 200) runsCounted.clear();
  runsCounted.set(key, said);
  return said;
}
export const listScheduleProposals = (company, user) =>
  all(
    `SELECT p.*,u.name decided_by_name FROM schedule_proposals p JOIN conversation_members cm
     ON cm.conversation_id=p.conversation_id AND cm.user_id=?
     LEFT JOIN users u ON u.id=p.decided_by
     WHERE p.company_id=? AND p.message_id IS NOT NULL ORDER BY p.created DESC LIMIT 100`,
    user,
    company,
  ).map((p) => {
    const status = proposalStatus(p);
    const summary = proposalSummary(company, p);
    return {
      id: p.id,
      status,
      duck_id: p.duck_id,
      conversation_id: p.conversation_id,
      message_id: p.message_id,
      schedule_id: p.schedule_id,
      // When it was asked. Skill and board proposals have always sent this; this
      // one did not, so on the Needs you page, where everything waiting is one
      // list in the order it arrived, a duck's schedule request had no time on
      // its line and sorted to the bottom whatever its age.
      created: p.created,
      // How long it stays open, and afterwards who answered and when. An
      // answered card used to say only "Not set up.": not what, not who.
      expires: p.expires,
      updated: p.updated,
      decided_by: p.decided_by,
      decided_by_name: p.decided_by_name,
      ...summary,
      ...(status === "pending" && summary.operation === "create"
        ? {
            runs_a_month: runsAMonth({
              ...json(p.payload),
              timezone: summary.timezone,
            }),
            // Whether the duck may already schedule without asking, so the
            // card does not offer that as new. Ticked on one card, it was
            // still offered on the duck's other.
            duck_may_schedule: duckMaySchedule(p.duck_id, company),
          }
        : {}),
      // A change to how often it runs changes what it keeps costing, which
      // is said as it is now and as it would be.
      ...(status === "pending" && summary.operation === "update"
        ? {
            runs_a_month: runsAMonth({
              ...json(p.payload).proposed,
              timezone: summary.timezone,
            }),
            runs_a_month_before: runsAMonth({
              ...targetFor(p),
              timezone: summary.timezone,
            }),
          }
        : {}),
    };
  });
// Turn an agreed proposal into a real schedule. Also the path taken straight
// away when a person has said this duck need not ask.
export function applyProposal(company, p, createSchedule) {
  const a = json(p.payload);
  onTeam(p.duck_id, company);
  const timezone = companyTimezone(company);
  const next = nextFire({ ...a, timezone }, Date.now());
  if (!next) fail(400, "That does not describe a time that ever comes round.");
  return createSchedule(company, p.user_id, p.duck_id, a, timezone, next);
}
// Put an agreed change on a schedule, by the form's own path. It keeps its
// duck and its clock: a duck may ask what the work is and when it happens,
// not who does it.
function applyChange(company, s, proposed, by) {
  onTeam(s.duck_id, company);
  if (proposed.board_id) tenant("task_boards", proposed.board_id, company);
  const next = nextFire({ ...proposed, timezone: s.timezone }, Date.now());
  if (!next) fail(400, "That does not describe a time that ever comes round.");
  // Asked for on somebody's behalf: the change is theirs, as a person's own
  // edit would be (see changeSchedule).
  return changeSchedule(company, s, { ...proposed, duck_id: s.duck_id }, next, { by });
}
const decisionPattern = /^schedule-decision:([0-9a-f-]+):(approve|decline)$/;
export function scheduleDecisionOutcome(job) {
  const origin = one(
    "SELECT origin FROM messages WHERE id=? AND company_id=? AND conversation_id=?",
    job.input_message_id,
    job.company_id,
    job.conversation_id,
  )?.origin;
  const match = origin?.match(decisionPattern);
  if (!match) return null;
  const p = one(
    "SELECT id,company_id,status,schedule_id,user_id,duck_id,conversation_id,payload FROM schedule_proposals WHERE id=? AND company_id=?",
    match[1],
    job.company_id,
  );
  if (
    !p ||
    p.user_id !== job.user_id ||
    p.duck_id !== job.duck_id ||
    p.conversation_id !== job.conversation_id ||
    !["approved", "declined"].includes(p.status)
  )
    return null;
  const operation = proposalOperation(p);
  const target = targetFor(p);
  const scheduleExists = !!(
    operation === "create" &&
    p.schedule_id &&
    one("SELECT 1 FROM schedules WHERE id=? AND company_id=?", p.schedule_id, job.company_id)
  );
  return {
    status: p.status,
    operation,
    proposal_id: p.id,
    schedule_id: operation === "create" ? p.schedule_id : null,
    target_schedule_id: operation !== "create" ? target?.id || null : null,
    schedule_exists: operation === "update" ? !!target?.current : scheduleExists,
    already_removed: operation !== "create" ? !target?.current : false,
    message:
      p.status === "declined"
        ? operation === "update"
          ? "This change to the scheduled task was declined, so it runs as it did. Do not propose the same change again during this continuation; continue the original request where possible."
          : "This scheduled-task request was declined. Do not propose it again during this continuation; continue the original request where possible."
        : operation === "remove"
          ? "This scheduled task was removed. Do not propose or recreate it during this continuation; continue the original request where possible."
          : operation === "update"
            ? target?.current
              ? "This change was approved and the scheduled task now runs with it. Do not propose it again; continue the original request, including any other unfinished work."
              : "This change was approved, but the scheduled task has since been removed. Do not recreate it during this continuation; continue the original request where possible."
            : scheduleExists
              ? "This scheduled task is already set up. Do not propose or create it again; continue the original request, including any initial check or other unfinished work."
              : "This scheduled task was approved earlier, but its schedule has since been removed. Do not recreate it during this continuation; continue the original request where possible.",
  };
}
function existingContinuation(p, decision) {
  const message = one(
    "SELECT id FROM messages WHERE company_id=? AND conversation_id=? AND origin=? ORDER BY rowid LIMIT 1",
    p.company_id,
    p.conversation_id,
    "schedule-decision:" + p.id + ":" + decision,
  );
  const job =
    message &&
    one(
      "SELECT id,status,error FROM jobs WHERE input_message_id=? ORDER BY rowid LIMIT 1",
      message.id,
    );
  return job
    ? { status: "queued", job_id: job.id, job_status: job.status }
    : {
        status: "unavailable",
        message: "No continuation was queued for this recorded decision.",
      };
}
function decisionResponse(p, decision, continuation = null) {
  const operation = proposalOperation(p);
  const target = targetFor(p);
  return {
    ok: true,
    status: decision,
    operation,
    schedule_id: operation === "create" ? p.schedule_id : null,
    target_schedule_id: operation !== "create" ? target?.id || null : null,
    schedule_exists: operation === "create"
      ? !!(p.schedule_id && one("SELECT 1 FROM schedules WHERE id=? AND company_id=?", p.schedule_id, p.company_id))
      : !!target?.current,
    current: operation !== "create" ? !!target?.current : undefined,
    already_removed: operation !== "create" ? !target?.current : undefined,
    continuation: continuation || existingContinuation(p, decision),
  };
}
export function registerScheduleProposals(
  app,
  {
    enqueue,
    createSchedule,
    setScheduleAccess = setDuckScheduleAccess,
  },
) {
  app.get("/api/schedule-proposals/:id", (req, res) => {
    const p = one(
      "SELECT * FROM schedule_proposals WHERE id=? AND company_id=?",
      req.params.id,
      req.company.id,
    );
    if (!p) fail(404, "That request is no longer available.");
    conversationFor(p.conversation_id, req.company.id, req.user.id);
    res.json({
      id: p.id,
      status: proposalStatus(p),
      ...proposalSummary(req.company.id, p),
    });
  });
  app.post("/api/schedule-proposals/:id/decide", (req, res) => {
    const visible = one(
      "SELECT * FROM schedule_proposals WHERE id=? AND company_id=?",
      req.params.id,
      req.company.id,
    );
    if (!visible) fail(404, "That request is no longer available.");
    conversationFor(visible.conversation_id, req.company.id, req.user.id);
    const member = memberFor(req.company.id, req.user.id);
    if (!permissions(member).tasks)
      fail(403, "You do not have permission to create and manage tasks.");
    const a = z
      .object({
        decision: z.enum(["approve", "decline"]),
        feedback: z.string().max(2000).default(""),
        always: z.boolean().default(false),
        expected_operation: z.enum(["create", "remove", "update"]).optional(),
      })
      .parse(req.body);
    const result = db.transaction(() => {
      const p = one(
        "SELECT * FROM schedule_proposals WHERE id=? AND company_id=?",
        req.params.id,
        req.company.id,
      );
      if (!p) fail(404, "That request is no longer available.");
      const expectedOperation = proposalOperation(p);
      // Older open tabs label every proposal as creation. They must not
      // approve a removal or a change through a misleading “Set it up”
      // button, or grant broader scheduling permission using the old
      // permission description.
      if (
        (a.expected_operation && a.expected_operation !== expectedOperation) ||
        (!a.expected_operation &&
          (expectedOperation !== "create" || (a.decision === "approve" && a.always)))
      )
        fail(409, "This page is out of date. Refresh it to review the correct action before deciding.");
      if (p.status === "approved" || p.status === "declined") {
        const recorded = p.status === "approved" ? "approve" : "decline";
        if (a.decision !== recorded)
          fail(409, "This request was already answered with the other decision.");
        // Somebody else said yes first, and this person also ticked "without
        // asking". That is a choice of its own, and it was dropped without a
        // word while the card said all was well.
        if (recorded === "approve" && a.always) {
          if (!permissions(member).ducks)
            fail(403, "Only a teammate with duck settings permission can allow scheduling without asking.");
          setScheduleAccess(req.company.id, p.duck_id, true);
        }
        return decisionResponse(p, recorded);
      }
      if (p.status === "superseded")
        fail(
          409,
          "This request was replaced by a newer one. Answer that one instead.",
        );
      if (p.status === "withdrawn")
        fail(
          409,
          "The duck took this request back, so there is nothing to answer.",
        );
      if (p.status !== "pending")
        fail(409, "This request is being answered already.");
      if (expiredStatus(p) === "expired")
        fail(
          409,
          "This request is more than a day old. Ask the duck for a fresh one.",
        );
      let scheduleId = null;
      const operation = proposalOperation(p);
      if (a.decision === "approve") {
        const requester = memberFor(req.company.id, p.user_id);
        if (!permissions(requester).tasks || !permissions(requester).chat)
          fail(
            409,
            "The requester can no longer run scheduled chat tasks, so this request cannot be approved.",
          );
        if (a.always && !permissions(member).ducks)
          fail(403, "Only a teammate with duck settings permission can allow scheduling without asking.");
        if (operation === "remove" || operation === "update") {
          const payload = json(p.payload);
          const targetId = payload.target_schedule_id || p.schedule_id;
          const current = targetId &&
            one("SELECT * FROM schedules WHERE id=? AND company_id=?", targetId, req.company.id);
          if (!current)
            fail(409, "That scheduled task was removed before this request was approved.");
          if (!unchangedSince(current, payload.target || {}))
            fail(
              409,
              operation === "remove"
                ? "That scheduled task changed before this request was approved. Ask for a fresh removal request."
                : "That scheduled task changed before this request was approved. Ask the duck for a fresh change request.",
            );
          if (operation === "update") {
            scheduleId = applyChange(req.company.id, current, payload.proposed, p.user_id).id;
            audit(req.company.id, req.user.id, "Scheduled task updated", payload.proposed.title);
          } else {
            // Removing a schedule retires every other pending request that names
            // it, but this request must remain pending until the decision below
            // records it as approved. Otherwise the guarded update silently
            // affects zero rows and its continuation cannot verify the approval.
            removeSchedule(req.company.id, targetId, { preserveProposalId: p.id });
            audit(req.company.id, req.user.id, "Scheduled task removed", current.title);
          }
        } else {
          scheduleId = applyProposal(req.company.id, p, createSchedule).id;
        }
        if (a.always) setScheduleAccess(req.company.id, p.duck_id, true);
      }
      const decided = a.decision === "approve" ? "approved" : "declined";
      run(
        "UPDATE schedule_proposals SET status=?,schedule_id=?,decided_by=?,feedback=?,updated=? WHERE id=? AND status='pending'",
        decided,
        scheduleId,
        req.user.id,
        a.feedback,
        now(),
        p.id,
      );
      const saved = { ...p, status: decided, schedule_id: operation === "remove" ? null : scheduleId };
      const summary = proposalSummary(req.company.id, p);
      const told = addMessage(
        req.company.id,
        p.conversation_id,
        // Each says what it was about, in the card's own words: a no said
        // only "Not set up.", and a stop said "Removed:" under "Stopped:".
        a.decision === "approve"
          ? operation === "remove"
            ? "Stopped: **" + summary.title + "**." +
              (a.feedback ? "\n\n" + a.feedback : "")
            : operation === "update"
              ? "Changed: **" + summary.title + "**" +
                // How often is said only when that is what changed.
                (summary.changed.includes("how_often")
                  ? ", " +
                    summary.how_often.charAt(0).toLowerCase() +
                    summary.how_often.slice(1)
                  : "") +
                "." +
                (a.feedback ? "\n\n" + a.feedback : "")
            : "Set up: **" +
              summary.title +
              "**, " +
              // Only its first letter: "every Thursday", not "every thursday".
              summary.how_often.charAt(0).toLowerCase() +
              summary.how_often.slice(1) +
              "." +
              (a.feedback ? "\n\n" + a.feedback : "")
          : operation === "remove"
            ? "Kept: **" + summary.title + "**." +
              (a.feedback ? "\n\n" + a.feedback : "")
            : operation === "update"
              ? "Not changed: **" + summary.before.title + "**." +
                (a.feedback ? "\n\n" + a.feedback : "")
            : "Not set up: **" + summary.title + "**." +
              (a.feedback ? "\n\n" + a.feedback : ""),
        {
          user: req.user.id,
          thread: p.thread_id || null,
          origin: "schedule-decision:" + p.id + ":" + a.decision,
        },
      );
      let continuation;
      if (one("SELECT paused FROM companies WHERE id=?", req.company.id)?.paused)
        continuation = {
          status: "paused",
          message: "Your ducks are paused, so the follow-up could not be queued.",
        };
      else if (!permissions(memberFor(req.company.id, p.user_id)).chat)
        continuation = {
          status: "unavailable",
          message:
            "The requester no longer has chat permission, so the follow-up could not be queued.",
        };
      else {
        try {
          const jobId = db.transaction(() =>
            enqueue(
              req.company.id,
              p.user_id,
              p.conversation_id,
              p.duck_id,
              told,
            ),
          )();
          continuation = { status: "queued", job_id: jobId || null };
        } catch (e) {
          continuation = {
            status: "unavailable",
            message: e.message || "The follow-up could not be queued.",
          };
        }
      }
      cardAnswered(p.job_id, req.company.id, {
        carriedOn: continuation.status === "queued",
      });
      audit(
        req.company.id,
        req.user.id,
        "Scheduled task request " + a.decision + "d",
        summary.title,
      );
      return decisionResponse(saved, a.decision, continuation);
    }).immediate();
    emit(req.company.id);
    res.json(result);
  });
}
// Taking back something nobody has answered. One tool and one id across all
// three kinds of proposal, because four near-identical tools is exactly the
// sort of thing that makes a product hard to hold in your head. Nothing here
// decides anything on a person's behalf: a withdrawn card stops asking, and
// says the duck took it back rather than that anybody refused it.
const kinds = [
  ["schedule_proposals", "scheduled task"],
  ["board_proposals", "task board"],
  ["skill_proposals", "skill"],
];
export function withdrawProposal(job, duck, pid, reason) {
  for (const [table, what] of kinds) {
    const p = one(
      "SELECT * FROM " + table + " WHERE id=? AND company_id=?",
      pid,
      job.company_id,
    );
    if (!p) continue;
    // Its own, in the chat it was asked in. A duck cannot reach across to
    // something another duck asked for, or into another conversation.
    if (p.duck_id !== duck.id || p.conversation_id !== job.conversation_id)
      fail(403, "Only the conversation that asked for this can take it back.");
    // A run nobody started must not retire something a person is being asked to
    // decide: a scheduled run happens in the same chat, under the same person,
    // hundreds of times a day, with nobody watching what it reads.
    if (one("SELECT 1 FROM schedule_runs WHERE job_id=?", job.id))
      fail(
        403,
        "A run that nobody started cannot take back something a person is being asked to decide.",
      );
    if (p.status !== "pending")
      fail(
        409,
        p.status === "withdrawn"
          ? "You already took this back."
          : "That was already answered, so there is nothing to take back.",
      );
    run(
      "UPDATE " +
        table +
        " SET status='withdrawn',updated=? WHERE id=? AND status='pending'",
      now(),
      pid,
    );
    addMessage(
      job.company_id,
      p.conversation_id,
      "Took back the " +
        what +
        " request." +
        (reason ? " " + reason : "") +
        " Nothing was set up.",
      { duck: duck.id, thread: p.thread_id || null },
    );
    audit(job.company_id, job.user_id, "Duck withdrew a request", {
      duck: duck.id,
      kind: what,
      proposal: pid,
    });
    emit(job.company_id);
    return {
      status: "withdrawn",
      message:
        "Taken back. The card no longer asks them to decide. Say plainly that you withdrew it and why.",
    };
  }
  fail(404, "There is no request with that id in this company.");
}
function removalTarget(job, duck, scheduleId) {
  const current = one(
    "SELECT * FROM schedules WHERE id=? AND company_id=?",
    scheduleId,
    job.company_id,
  );
  if (!current)
    fail(404, "That scheduled task was not found for this duck in this company.");
  return current;
}
export function listRemovableSchedules(job, duck) {
  return all(
    "SELECT * FROM schedules WHERE company_id=? ORDER BY created",
    job.company_id,
  ).map(publicSchedule);
}
// One undecided card per duck per chat, whatever it asks, and replaces_id is
// how a duck changes what it asked. Removing and changing a schedule ask the
// same way, so they share this.
function makeRoomFor(job, duck, replaces, waitingMessage) {
  const waiting = one(
    "SELECT id FROM schedule_proposals WHERE company_id=? AND duck_id=? AND conversation_id=? AND status='pending' AND (expires IS NULL OR expires>?)",
    job.company_id, duck.id, job.conversation_id, now(),
  );
  if (waiting && waiting.id !== replaces) fail(409, waitingMessage(waiting.id));
  if (replaces) {
    const old = one("SELECT * FROM schedule_proposals WHERE id=? AND company_id=?", replaces, job.company_id);
    if (!old) noSuchRequest(replaces, job.company_id);
    if (old.duck_id !== duck.id || old.conversation_id !== job.conversation_id || old.user_id !== job.user_id)
      fail(403, "Only the conversation that asked for this can replace it.");
    if (old.status !== "pending")
      fail(409, "That request was already answered, so there is nothing to replace.");
    run("UPDATE schedule_proposals SET status='superseded',updated=? WHERE id=? AND status='pending'", now(), replaces);
  }
}
export function removeRequestedSchedule(job, duck, args) {
  const target = removalTarget(job, duck, args.schedule_id);
  const snapshot = snapshotOf(target);
  const summary = proposalSummary(job.company_id, {
    ...job,
    duck_id: duck.id,
    payload: JSON.stringify({
      operation: "remove",
      target_schedule_id: target.id,
      target: snapshot,
    }),
  });
  if (duckMaySchedule(duck.id, job.company_id)) {
    removeSchedule(job.company_id, target.id);
    audit(job.company_id, job.user_id, "Scheduled task removed", target.title);
    emit(job.company_id);
    return {
      ...summary,
      operation: "remove",
      status: "removed",
      current: false,
      already_removed: false,
      message: "Removed. Tell the person the scheduled task was removed.",
    };
  }
  const replaces = String(args?.replaces_id || "").trim();
  return db.transaction(() => {
    makeRoomFor(job, duck, replaces, (waiting) =>
      "You already asked for a scheduled-task decision here (" + waiting + "). Use replaces_id to revise it.",
    );
    const pid = id();
    run(
      "INSERT INTO schedule_proposals(id,company_id,job_id,user_id,duck_id,conversation_id,thread_id,message_id,payload,status,schedule_id,replaces_id,created,updated,expires) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      pid, job.company_id, job.id, job.user_id, duck.id, job.conversation_id,
      job.thread_id || null, job.output_message_id, JSON.stringify({
        operation: "remove", target_schedule_id: target.id, target: snapshot,
      }), "pending", target.id, replaces || null, now(), now(),
      new Date(Date.now() + proposalLifeMs).toISOString(),
    );
    emit(job.company_id);
    return {
      ...summary,
      operation: "remove",
      status: "waiting for a person",
      proposal_id: pid,
      target_schedule_id: target.id,
      message: "Nothing has been removed yet. A person has to agree to removing this scheduled task first. Stop here and tell them what you proposed.",
    };
  }).immediate();
}

// The parts of a schedule a duck may ask to change. Who does it and on which
// clock stay as they are.
const CHANGEABLE = [
  "title",
  "instructions",
  "repeat",
  "at_minute",
  "on_day",
  "every_minutes",
  "from_minute",
  "to_minute",
  "weekdays_only",
  "board_id",
];
// What a schedule row keeps for its kind of repeat: an hourly check has no
// time of day and a daily one no window, whatever else was said.
const kept = (a) => ({
  ...a,
  at_minute: isFrequent(a.repeat) ? null : a.at_minute,
  on_day: a.repeat === "weekly" || a.repeat === "monthly" ? a.on_day : null,
  every_minutes: a.repeat === "minutes" ? a.every_minutes : null,
  from_minute: isFrequent(a.repeat) ? a.from_minute : null,
  to_minute: isFrequent(a.repeat) ? a.to_minute : null,
  weekdays_only: isFrequent(a.repeat) && !!a.weekdays_only,
});
// Called from the duck's tool to change a schedule that is already running.
// There was no way to: a duck told to change what its own ten-minute check
// does could only save the new rules in its notes, while the check went on
// running the old instructions. What it asks for is laid over the schedule
// as it is, so a duck changing the instructions does not have to copy out
// the rest, and get some of it wrong. Like setting one up, it waits for a
// person unless they have said this duck need not ask.
export function proposeScheduleChange(job, duck, args) {
  const s = removalTarget(job, duck, args.schedule_id);
  if (s.repeat === "once")
    fail(
      400,
      "That one runs only once, so it cannot be changed this way. A person can change it on the Scheduled tasks page.",
    );
  const given = (field) => args[field] !== undefined && args[field] !== null;
  const asItIs = kept({
    ...Object.fromEntries(CHANGEABLE.map((field) => [field, s[field]])),
    weekdays_only: !!s.weekdays_only,
  });
  const proposed = kept(
    proposalShape.parse({
      ...asItIs,
      ...Object.fromEntries(
        CHANGEABLE.filter(given).map((field) => [field, args[field]]),
      ),
      // An empty board is "in the chat, not on a board".
      ...(given("board_id") ? { board_id: args.board_id || null } : {}),
    }),
  );
  check(proposed, job.company_id);
  if (CHANGEABLE.every((field) => (proposed[field] ?? null) === (asItIs[field] ?? null)))
    fail(
      400,
      "That is how it runs already, so there is nothing to change. Give only what should be different.",
    );
  if (!nextFire({ ...proposed, timezone: s.timezone }, Date.now()))
    fail(400, "That does not describe a time that ever comes round.");
  const payload = JSON.stringify({
    operation: "update",
    target_schedule_id: s.id,
    target: snapshotOf(s),
    proposed,
  });
  const replaces = String(args?.replaces_id || "").trim();
  return db.transaction(() => {
    makeRoomFor(job, duck, replaces, (waiting) =>
      "You already asked for a scheduled-task decision here and nobody has answered yet (" +
      waiting +
      "). To change what you asked for, call schedule_update again with replaces_id=" +
      waiting +
      ". To take it back entirely, use proposal_withdraw.",
    );
    const pid = id();
    run(
      "INSERT INTO schedule_proposals(id,company_id,job_id,user_id,duck_id,conversation_id,thread_id,message_id,payload,status,schedule_id,replaces_id,created,updated,expires) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      pid, job.company_id, job.id, job.user_id, duck.id, job.conversation_id,
      job.thread_id || null, job.output_message_id, payload, "pending", s.id,
      replaces || null, now(), now(),
      new Date(Date.now() + proposalLifeMs).toISOString(),
    );
    const summary = proposalSummary(
      job.company_id,
      one("SELECT * FROM schedule_proposals WHERE id=?", pid),
    );
    // Changed at once, and still said in the chat as a line under the duck's
    // reply, so the change is on record where it was asked for.
    if (duckMaySchedule(duck.id, job.company_id)) {
      applyChange(job.company_id, s, proposed, job.user_id);
      run(
        "UPDATE schedule_proposals SET status='approved',updated=? WHERE id=?",
        now(),
        pid,
      );
      audit(job.company_id, job.user_id, "Scheduled task updated", proposed.title);
      emit(job.company_id);
      return {
        ...summary,
        status: "changed",
        proposal_id: pid,
        message:
          "Changed, because a person allowed you to schedule work without asking. Tell them what you changed.",
      };
    }
    emit(job.company_id);
    return {
      ...summary,
      status: "waiting for a person",
      proposal_id: pid,
      message:
        "Nothing has changed yet. A person has to agree to this change first, and they can see exactly what would change. Stop here and tell them what you asked to change. You will be asked again once they have decided.",
    };
  }).immediate();
}

// Called from the duck's tool. Either sets the schedule up, when a person has
// already said this duck need not ask, or files the request and stops.
export function proposeSchedule(job, duck, args, { createSchedule }) {
  const decided = scheduleDecisionOutcome(job);
  if (decided) return decided;
  const a = proposalShape.parse(args);
  check(a, job.company_id);
  const replaces = String(args?.replaces_id || "").trim();
  return db.transaction(() => {
  // One undecided card per duck per chat. The person says "every five minutes",
  // then a minute later narrows it, and the duck proposes again - and both
  // cards sat there, live, asking for the same decision, while the duck asked
  // in prose to please ignore the first. This refusal carries the id the duck
  // needs, which is the only place it can get it: the id it was given when it
  // proposed is long gone from its context by the next turn.
  const waiting = one(
    "SELECT id FROM schedule_proposals WHERE company_id=? AND duck_id=? AND conversation_id=? AND status='pending' AND (expires IS NULL OR expires>?)",
    job.company_id,
    duck.id,
    job.conversation_id,
    now(),
  );
  if (waiting && waiting.id !== replaces)
    fail(
      409,
      "You already asked for a scheduled task here and nobody has answered yet (" +
        waiting.id +
        "). To change what you asked for, call this again with replaces_id=" +
        waiting.id +
        ". To take it back entirely, use proposal_withdraw.",
    );
  if (replaces) {
    const old = one(
      "SELECT * FROM schedule_proposals WHERE id=? AND company_id=?",
      replaces,
      job.company_id,
    );
    if (!old) noSuchRequest(replaces, job.company_id);
    if (
      old.duck_id !== duck.id ||
      old.conversation_id !== job.conversation_id ||
      old.user_id !== job.user_id
    )
      fail(403, "Only the conversation that asked for this can replace it.");
    if (old.status !== "pending")
      fail(
        409,
        "That request was already answered, so there is nothing to replace.",
      );
    run(
      "UPDATE schedule_proposals SET status='superseded',updated=? WHERE id=? AND status='pending'",
      now(),
      replaces,
    );
  }
  const pid = id();
  run(
    "INSERT INTO schedule_proposals(id,company_id,job_id,user_id,duck_id,conversation_id,thread_id,message_id,payload,status,replaces_id,created,updated,expires) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    pid,
    job.company_id,
    job.id,
    job.user_id,
    duck.id,
    job.conversation_id,
    job.thread_id || null,
    job.output_message_id,
    JSON.stringify(a),
    "pending",
    replaces || null,
    now(),
    now(),
    new Date(Date.now() + proposalLifeMs).toISOString(),
  );
  const p = one("SELECT * FROM schedule_proposals WHERE id=?", pid);
  const summary = proposalSummary(job.company_id, p);
  if (duckMaySchedule(duck.id, job.company_id)) {
    const schedule = applyProposal(job.company_id, p, createSchedule);
    run(
      "UPDATE schedule_proposals SET status='approved',schedule_id=?,updated=? WHERE id=?",
      schedule.id,
      now(),
      pid,
    );
    emit(job.company_id);
    return {
      ...summary,
      status: "set up",
      message:
        "Set up, because a person allowed you to schedule work without asking. Tell them what you have set up and when it first runs.",
    };
  }
  emit(job.company_id);
  return {
    ...summary,
    status: "waiting for a person",
    message:
      "Nothing is scheduled yet. A person has to agree to it first, and they can see exactly what you asked for. Stop here and tell them what you have proposed. You will be asked again once they have decided.",
  };
  }).immediate();
}
