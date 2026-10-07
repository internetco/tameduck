import { one } from "./store.mjs";
import { computerHeld } from "./computer-control-store.mjs";
import { deploymentDrainBlocksQueuedJob } from "./deployment-drain.mjs";

// The worker and the read-only queue explanation share these snapshots. The
// database checks below also cover a worker on another process or after a
// transition that has not yet reached this process's next scheduling tick.
export const activeRunKeys = new Set();
export const activeDuckKeys = new Set();
export const duckResourceKey = (job) => job.company_id + ":" + job.duck_id;

const reason = (code, label, detail) => ({ code, label, detail });
export function queueReason(job) {
  if (!job || job.status !== "queued") return null;
  if (one("SELECT paused FROM companies WHERE id=?", job.company_id)?.paused)
    return reason("workspace_paused", "Workspace paused",
      "Resume the workspace to start this run.");
  if (deploymentDrainBlocksQueuedJob(job))
    return reason("deployment_drain", "Update in progress",
      "This run can start after the server update finishes.");
  if (one("SELECT removed FROM ducks WHERE id=? AND company_id=?", job.duck_id, job.company_id)?.removed)
    return reason("duck_unavailable", "Duck unavailable",
      "This duck is no longer on the team.");
  if (computerHeld(job.duck_id, job.company_id))
    return reason("human_hold", "Waiting for a person",
      "This duck is waiting for a person to respond or return screen control.");
  const other = one(
    "SELECT status FROM jobs WHERE company_id=? AND duck_id=? AND id<>? AND status IN ('running','waiting_human') ORDER BY CASE status WHEN 'waiting_human' THEN 0 ELSE 1 END LIMIT 1",
    job.company_id, job.duck_id, job.id,
  );
  if (other?.status === "waiting_human")
    return reason("human_hold", "Waiting for a person",
      "This duck is waiting for a person to respond or return screen control.");
  if (other || activeDuckKeys.has(duckResourceKey(job)))
    return reason("same_duck_busy", "Waiting for this duck to finish",
      "This duck finishes its current run before starting another.");
  const helper = one(
    "SELECT company_id,from_duck_id,status FROM duck_consultations WHERE child_job_id=?",
    job.id,
  );
  if (helper?.status === "waiting") {
    const parallel = one(
      "SELECT max_parallel_requests FROM duck_contact_policies WHERE company_id=? AND duck_id=?",
      helper.company_id, helper.from_duck_id,
    )?.max_parallel_requests ?? null;
    if (parallel !== null &&
        one(
          "SELECT count(*) n FROM duck_consultations WHERE company_id=? AND from_duck_id=? AND status='running'",
          helper.company_id, helper.from_duck_id,
        ).n >= parallel)
      return reason("helper_parallel_cap", "Waiting for another helper",
        "This helper starts when a current teammate request finishes.");
  }
  if (activeRunKeys.size >= 3)
    return reason("global_slots_used", "Waiting for other work to finish",
      "All three work slots are in use. This starts when one becomes free.");
  return reason("starting_soon", "Starting soon",
    "Ready to start when its turn comes.");
}
