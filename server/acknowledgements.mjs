import { one, run, now, emit, db } from "./store.mjs";

export function acknowledgementEligible(job) {
  if (!job) return false;
  if (
    !one(
      "SELECT 1 FROM jobs WHERE id=? AND status='running' AND acknowledgement IS NULL AND schedule_id IS NULL AND acknowledgement_suppressed=0",
      job.id,
    )
  )
    return false;
  if (one("SELECT 1 FROM duck_consultations WHERE child_job_id=?", job.id))
    return false;
  if (one("SELECT 1 FROM ticket_reply_checks WHERE job_id=?", job.id))
    return false;
  const input = one(
    "SELECT origin FROM messages WHERE id=?",
    job.input_message_id,
  );
  const origin = input?.origin || "";
  if (
    origin === "tool" ||
    origin === "schedule" ||
    origin.startsWith("schedule-decision:")
  )
    return false;
  if (
    one(
      "SELECT 1 FROM jobs WHERE id<>? AND company_id=? AND duck_id=? AND input_message_id=? AND (acknowledgement IS NOT NULL OR status IN ('done','waiting_human','waiting_consultation'))",
      job.id,
      job.company_id,
      job.duck_id,
      job.input_message_id,
    )
  )
    return false;
  return true;
}

export function acknowledgementPrompt(job) {
  if (!acknowledgementEligible(job)) return "";
  return job.task_id
    ? "Start this ticket with a separate short paragraph in your own words about the work you are beginning and roughly how long it will take. Then continue with the work and answer in a new paragraph."
    : "If you need real tools, files, or computer work, first write one short, specific sentence about what you will do, then start. If you can answer directly, answer directly.";
}

export function ticketOpening(text) {
  const boundary = text.indexOf("\n\n");
  if (boundary < 0) return null;
  const opening = text.slice(0, boundary).trim();
  if (
    !opening ||
    opening.length > 240 ||
    !/^(?:On it\b|I(?:['’]ll| will| am going to)\b)/i.test(opening)
  )
    return null;
  return { opening, remainder: text.slice(boundary + 2) };
}

export function acknowledgeWork(job, text = "On it.") {
  if (!acknowledgementEligible(job)) return false;
  const body =
    String(text || "")
      .trim()
      .replace(/\s+/g, " ")
      .slice(0, 240) || "On it.";
  const changed = db.transaction(() => {
    const updated = run(
      "UPDATE jobs SET acknowledgement=?,acknowledged_at=? WHERE id=? AND acknowledgement IS NULL",
      body,
      now(),
      job.id,
    ).changes;
    if (updated && job.task_id)
      run(
        "INSERT OR IGNORE INTO ticket_activity(company_id,task_id,kind,action,body,duck_id,job_id,source_key,created) VALUES(?,?,?,?,?,?,?,?,?)",
        job.company_id,
        job.task_id,
        "acknowledgement",
        "Duck acknowledged work",
        body,
        job.duck_id,
        job.id,
        "ack:" + job.id,
        now(),
      );
    return updated;
  })();
  if (!changed) return false;
  emit(job.company_id);
  return true;
}
