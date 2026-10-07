import { effectiveHumanWaitMinutes } from "./human-wait-settings.mjs";
import {
  db,
  one,
  all,
  run,
  now,
  id,
  hash,
  fail,
  emit,
  json,
} from "./store.mjs";
// Only metadata belongs in human_requests. Submitted values never enter this database.
export const requestFor = (rid) =>
  one("SELECT * FROM human_requests WHERE id=?", rid);
export const requestForComputer = (cid) =>
  one(
    "SELECT * FROM human_requests WHERE computer_id=? AND status NOT IN ('completed','cancelled','parked')",
    cid,
  );
export const requestForDuck = (duck, company) =>
  one(
    "SELECT * FROM human_requests WHERE duck_id=? AND company_id=? AND status NOT IN ('completed','cancelled','parked')",
    duck,
    company,
  );
export function checkpointToken(c) {
  const job = one(
    "SELECT id FROM jobs WHERE duck_id=? AND company_id=? AND status='running' ORDER BY created LIMIT 1",
    c.duck_id,
    c.company_id,
  );
  const action = one(
    "SELECT id FROM computer_actions WHERE computer_id=? ORDER BY rowid DESC LIMIT 1",
    c.id,
  );
  return hash(
    JSON.stringify([
      c.id,
      c.box_id,
      c.started_at,
      c.checkpoint,
      job?.id,
      action?.id,
    ]),
  );
}
export function publicRequest(r) {
  return {
    id: r.id,
    computer_id: r.computer_id,
    duck_id: r.duck_id,
    job_id: r.job_id,
    conversation_id: r.conversation_id,
    message_id: r.message_id,
    user_id: r.user_id,
    kind: r.kind,
    title: r.title,
    instructions: r.instructions,
    checkpoint: r.checkpoint,
    status: r.status,
    expires: r.expires,
    created: r.created,
    // When it last changed. Once a request is closed nothing touches it again,
    // so this is when it was answered, and the line the card leaves behind in
    // chat can say so.
    updated: r.updated,
    outcome: r.outcome,
    // Whether anybody actually got onto the screen, so the card can tell "the
    // wait ran out and nothing was done" apart from "somebody was on it and
    // did not hand back". Sent as a plain yes or no; the generation itself is
    // an internal handle and has no business on a screen.
    was_taken: !!r.control_generation,
    // The person said no, and what they wrote, so the card can say so in
    // their words instead of reading like a hand-back.
    declined_at: r.declined_at || null,
    declined_reason: r.declined_reason || null,
    origin: json(r.binding)?.origin || null,
    fields: json(r.fields).map(({ selector, ...field }) => field),
  };
}
export function listHumanRequests(company, user) {
  return all(
    `SELECT r.* FROM human_requests r WHERE r.company_id=? AND r.user_id=?
 AND (r.conversation_id IS NULL OR EXISTS(SELECT 1 FROM conversation_members cm WHERE cm.conversation_id=r.conversation_id AND cm.user_id=?))
 ORDER BY r.created DESC LIMIT 100`,
    company,
    user,
    user,
  ).map(publicRequest);
}
export function visibleRequestJob(job) {
  if (!job) return null;
  return (
    one(
      `SELECT parent.* FROM duck_consultations consultation
       JOIN jobs parent ON parent.id=consultation.parent_job_id
       WHERE consultation.child_job_id=? AND consultation.company_id=?`,
      job.id,
      job.company_id,
    ) || job
  );
}
export function reserveRequest(c, job, user, options) {
  if (requestForComputer(c.id))
    fail(409, "This computer already has a pending human request.");
  const rid = id();
  const visibleJob = visibleRequestJob(job);
  db.transaction(() => {
    run(
      `INSERT INTO human_requests(id,company_id,computer_id,duck_id,job_id,user_id,conversation_id,message_id,kind,title,instructions,checkpoint,fields,status,expires,created,updated)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      rid,
      c.company_id,
      c.id,
      c.duck_id,
      job?.id || null,
      user,
      visibleJob?.conversation_id || options.conversation_id || null,
      visibleJob?.output_message_id || options.message_id || null,
      options.kind,
      options.title,
      options.instructions || "",
      options.checkpoint || c.checkpoint,
      JSON.stringify(options.fields || []),
      "preparing",
      Date.now() + effectiveHumanWaitMinutes(user, c.duck_id) * 60000,
      now(),
      now(),
    );
    // Reserve before any asynchronous work. Every run and every computer entry point sees the hold.
    for (const j of all(
      "SELECT * FROM jobs WHERE duck_id=? AND company_id=? AND status='running'",
      c.duck_id,
      c.company_id,
    )) {
      run(
        "UPDATE jobs SET status='waiting_human',resumed_control=1,error=NULL,updated=? WHERE id=?",
        now(),
        j.id,
      );
      run(
        "UPDATE messages SET state='waiting_human' WHERE id=?",
        j.output_message_id,
      );
    }
  })();
  emit(c.company_id);
  return requestFor(rid);
}
export function expireRequests(time = Date.now()) {
  for (const r of all(
    "SELECT * FROM human_requests WHERE expires<=? AND status IN ('preparing','pending','desktop','stale')",
    time,
  )) {
    run(
      "UPDATE human_requests SET status='expired',updated=? WHERE id=?",
      now(),
      r.id,
    );
    emit(r.company_id);
  }
}
export function finishRequest(r, status, outcome) {
  db.transaction(() => {
    if (
      status === "completed" &&
      r.job_id &&
      one("SELECT status FROM jobs WHERE id=?", r.job_id)?.status ===
        "cancelled"
    ) {
      status = "cancelled";
      outcome = "The original task was cancelled.";
    }
    run(
      "UPDATE human_requests SET status=?,outcome=?,updated=? WHERE id=?",
      status,
      outcome,
      now(),
      r.id,
    );
    if (status === "cancelled" && r.job_id) {
      // Only a run that was still holding for a person is stopped by this. A
      // parked request has already let its duck carry on, and marking the
      // message cancelled then painted "Stopped before anything was written"
      // over a reply the duck had finished and delivered.
      const stopped = run(
        "UPDATE jobs SET status='cancelled',updated=? WHERE id=? AND status='waiting_human'",
        now(),
        r.job_id,
      );
      if (stopped.changes)
        // The request carries no message when the run belongs to a chat its
        // taker is not in, and aiming at nothing left the reply in that chat
        // reading "Paused - waiting for your input" for good. The run itself
        // always knows which reply it is writing.
        run(
          "UPDATE messages SET state='cancelled' WHERE id=COALESCE(?,(SELECT output_message_id FROM jobs WHERE id=?))",
          r.message_id,
          r.job_id,
        );
    }
  })();
  emit(r.company_id);
}
