// What happened to each computer, for its own page (migration 0012). The audit
// trail names the duck, never the machine, never the run a start was for and
// never why a machine stopped by itself, so a person coming back to a stopped
// computer had nothing to tell them whether they had broken it.
//
// Imports only the store and the request store, so computers.mjs and
// computer-control.mjs can both write here without a cycle.
import { one, all, run, id, now } from "./store.mjs";
import { visibleRequestJob } from "./human-input-store.mjs";

// A closed list, so every line on the page can be worded as plainly as
// "Stopped by itself after 5 idle minutes".
export const STOP_KINDS = [
  "stopped",
  "stopped_idle",
  "stopped_long",
  "stopped_left",
  "stopped_off",
  "stopped_paused",
  "stopped_not_allowed",
  "stopped_removed",
];
export const KINDS = ["started", ...STOP_KINDS, "took", "gave_back"];

export function computerEvent(c, kind, { user = null, job = null } = {}) {
  if (!KINDS.includes(kind)) throw new Error("Unknown computer event: " + kind);
  run(
    "INSERT INTO computer_events(id,company_id,computer_id,kind,user_id,job_id,created) VALUES(?,?,?,?,?,?,?)",
    id(),
    c.company_id,
    c.id,
    kind,
    user,
    job,
    now(),
  );
}

export function lastEvent(cid, kinds) {
  const e = one(
    `SELECT kind,user_id,job_id,created FROM computer_events WHERE computer_id=? AND kind IN (${kinds.map(() => "?").join(",")}) ORDER BY created DESC,rowid DESC LIMIT 1`,
    cid,
    ...kinds,
  );
  return e
    ? { kind: e.kind, user_id: e.user_id, job_id: e.job_id, at: e.created }
    : null;
}

// The place a run works in, as the page names it. A helper's run is shown as
// the run it helps: that is the chat or ticket a person knows about.
export function placeOf(jobId) {
  const raw = jobId && one("SELECT * FROM jobs WHERE id=?", jobId);
  if (!raw) return null;
  const job = visibleRequestJob(raw);
  const conversation = one(
    "SELECT kind,task_id FROM conversations WHERE id=?",
    job.conversation_id,
  );
  return {
    job_id: job.id,
    user_id: job.user_id,
    // Whose chat it is, when the reader is not in it: the duck the chat is with.
    duck_id: job.duck_id,
    task_id: job.task_id || conversation?.task_id || null,
    conversation_id: job.conversation_id,
    conversation_kind: conversation?.kind || null,
    active: [
      "queued",
      "running",
      "waiting_human",
      "waiting_consultation",
    ].includes(job.status),
  };
}

export function computerHistory(c, sinceIso) {
  return all(
    "SELECT id,kind,user_id,job_id,created FROM computer_events WHERE computer_id=? AND created>=? ORDER BY created DESC,rowid DESC LIMIT 50",
    c.id,
    sinceIso,
  ).map((e) => ({
    id: e.id,
    kind: e.kind,
    user_id: e.user_id,
    created: e.created,
    place: e.kind === "started" ? placeOf(e.job_id) : null,
  }));
}
