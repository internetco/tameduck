import { requestForDuck, expireRequests } from "./human-input-store.mjs";
import { db, one, all, run, now, fail, emit } from "./store.mjs";
export const controlFor = (cid) =>
  one("SELECT * FROM computer_control WHERE computer_id=?", cid);
export const computerHeld = (duck, company) =>
  one(
    "SELECT h.* FROM computer_control h JOIN computers c ON c.id=h.computer_id WHERE c.duck_id=? AND c.company_id=?",
    duck,
    company,
  ) || requestForDuck(duck, company);
export function assertDuckControl(duck, company) {
  if (computerHeld(duck, company))
    fail(
      409,
      "A human is using your computer. Your run is paused until they hand it back.",
    );
}
export function markDuckWaiting(duck, company) {
  const jobs = all(
    "SELECT * FROM jobs WHERE duck_id=? AND company_id=? AND status IN ('running','waiting_human')",
    duck,
    company,
  );
  db.transaction(() => {
    for (const job of jobs) {
      run(
        "UPDATE jobs SET status='waiting_human',resumed_control=1,error=NULL,updated=? WHERE id=?",
        now(),
        job.id,
      );
      run(
        "UPDATE messages SET state='waiting_human' WHERE id=?",
        job.output_message_id,
      );
    }
  })();
  emit(company);
  return jobs;
}
export function resumeWaitingJobs(isActive = () => false) {
  expireRequests();
  for (const j of all("SELECT * FROM jobs WHERE status='waiting_human'")) {
    if (
      computerHeld(j.duck_id, j.company_id) ||
      one(
        // A parked request is finished with: it expired, its computer was handed
        // back, and nobody will ever answer it. Leaving it out of this list kept
        // the duck's job waiting for a person forever.
        "SELECT 1 FROM human_requests WHERE job_id=? AND status NOT IN ('completed','cancelled','parked')",
        j.id,
      ) ||
      one(
        "SELECT 1 FROM approvals WHERE job_id=? AND status IN ('pending','executing')",
        j.id,
      ) ||
      isActive(j)
    )
      continue;
    run("UPDATE jobs SET status='queued',updated=? WHERE id=?", now(), j.id);
    run("UPDATE messages SET state='queued' WHERE id=?", j.output_message_id);
    emit(j.company_id);
  }
}
