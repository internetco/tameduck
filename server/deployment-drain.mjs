// The deploy process owns this marker. A fresh, nonempty nonce in the file
// identifies one drain request; the duck service only reads it. With no path
// configured, normal worker and schedule behavior is unchanged.
import fs from "node:fs";
import { all, one } from "./store.mjs";

let observedGeneration = null;
let finishingRoots = new Set();

function request() {
  const file = process.env.DEPLOY_DRAIN_FILE;
  if (!file) return null;
  try {
    const generation = fs.readFileSync(file, "utf8").trim();
    return { generation: generation || null };
  } catch (error) {
    if (error.code === "ENOENT") return null;
    // An unreadable marker must never be mistaken for permission to start.
    return { generation: null };
  }
}

export function deploymentDrainRequested() {
  return !!request();
}

export function observeDeploymentDrain() {
  const current = request();
  if (!current) {
    observedGeneration = null;
    finishingRoots = new Set();
    return false;
  }
  if (!current.generation) return true;
  if (observedGeneration !== current.generation) {
    // Include a parent that just returned to queued after its final helper.
    // A never-started root cannot have a consultation child.
    const rows = all(
      `SELECT j.id,j.root_job_id FROM jobs j
       WHERE j.status IN ('running','waiting_consultation')
          OR (j.status='queued' AND j.parent_job_id IS NULL
              AND EXISTS(SELECT 1 FROM jobs child WHERE child.parent_job_id=j.id))`,
    );
    finishingRoots = new Set(rows.map((job) => job.root_job_id || job.id));
    observedGeneration = current.generation;
  }
  return true;
}

// Read-only view for queue labels. The worker alone observes a new drain
// generation; reading state must not acknowledge a deployment request.
export function deploymentDrainBlocksQueuedJob(job) {
  const current = request();
  if (!current) return false;
  return !current.generation ||
    current.generation !== observedGeneration ||
    !finishingRoots.has(job.root_job_id || job.id);
}

export function mayStartQueuedJob(job) {
  if (!observeDeploymentDrain()) return true;
  return !!observedGeneration && finishingRoots.has(job.root_job_id || job.id);
}

export function deploymentDrainStatus(
  inMemoryActive = 0,
  workerTickBusy = false,
) {
  const current = request();
  if (!current) {
    observedGeneration = null;
    finishingRoots = new Set();
    return {
      requested: false,
      generation: null,
      acknowledged: false,
      ready: false,
      active: 0,
    };
  }
  const acknowledged =
    !!current.generation && current.generation === observedGeneration;
  if (!acknowledged)
    return {
      requested: true,
      generation: current.generation,
      acknowledged: false,
      ready: false,
      active: 0,
    };
  const jobs = all(
    "SELECT id,root_job_id,status FROM jobs WHERE status IN ('queued','running')",
  );
  const unfinished = jobs.filter(
    (job) =>
      job.status === "running" || finishingRoots.has(job.root_job_id || job.id),
  ).length;
  // An approved connected tool can outlive its duck's run. Its persisted
  // executing state prevents a restart while that external action is in flight.
  const actions = one(
    "SELECT count(*) n FROM approvals WHERE status='executing'",
  ).n;
  // These states wrap browser capture, typing, or lease release across awaits.
  // Ordinary pending/desktop human waits remain safely persisted.
  const humanActions = one(
    "SELECT count(*) n FROM human_requests WHERE status IN ('preparing','submitting','closing')",
  ).n;
  const active =
    unfinished +
    actions +
    humanActions +
    inMemoryActive +
    Number(workerTickBusy);
  if (active === 0) {
    // A parent parked on a person's input or a pending approval survives a
    // restart. Once there is no runnable part of its graph, close the cohort:
    // any later callback may queue its continuation, but cannot start it
    // between this readiness response and the service restart.
    finishingRoots = new Set();
  }
  return {
    requested: true,
    generation: current.generation,
    acknowledged: true,
    ready: active === 0,
    active,
  };
}
