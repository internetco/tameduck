import { policyResumeCount, resumePolicyHeldWork } from "./unfinished-work.mjs";
import { z } from "zod";
import {
  db,
  all,
  one,
  run,
  now,
  tenant,
  can,
  fail,
  audit,
  emit,
} from "./store.mjs";

export const legacyDefaultWorkMinutes = Math.min(
  Math.max(Math.ceil(+process.env.RUN_LIMIT_MINUTES || 30), 1),
  240,
);
export const MAX_WORK_MINUTES = 10080;
const minutes = z.number().int().min(0).max(MAX_WORK_MINUTES);
const override = z
  .object({
    duck_id: z.string().uuid(),
    run_minutes: minutes.nullable().optional(),
    auto_resume: z.boolean().nullable().optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.run_minutes !== undefined || value.auto_resume !== undefined,
    "Choose a setting to save.",
  );
const patchSchema = z
  .object({
    run_minutes: minutes.optional(),
    auto_resume: z.boolean().optional(),
    duck_overrides: z.array(override).max(100).optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.run_minutes !== undefined ||
      value.auto_resume !== undefined ||
      !!value.duck_overrides?.length,
    "Choose a work limit to save.",
  )
  .refine(
    (value) =>
      new Set((value.duck_overrides || []).map((row) => row.duck_id)).size ===
      (value.duck_overrides || []).length,
    "Each duck can appear only once.",
  );

export function effectiveWorkMinutes(companyId, duckId) {
  return (
    one(
      "SELECT run_minutes FROM duck_work_limit_overrides WHERE company_id=? AND duck_id=?",
      companyId,
      duckId,
    )?.run_minutes ??
    one(
      "SELECT run_minutes FROM company_work_limits WHERE company_id=?",
      companyId,
    )?.run_minutes ??
    legacyDefaultWorkMinutes
  );
}

export function effectiveAutoResume(companyId, duckId) {
  return !!(
    one(
      "SELECT auto_resume FROM duck_auto_resume_overrides WHERE company_id=? AND duck_id=?",
      companyId,
      duckId,
    )?.auto_resume ??
    one(
      "SELECT auto_resume FROM company_work_limits WHERE company_id=?",
      companyId,
    )?.auto_resume ??
    1
  );
}

export function workLimits(companyId) {
  const runMinutes =
    one(
      "SELECT run_minutes FROM company_work_limits WHERE company_id=?",
      companyId,
    )?.run_minutes ?? legacyDefaultWorkMinutes;
  const ducks = all(
    "SELECT d.id,d.name,o.run_minutes,a.auto_resume FROM ducks d LEFT JOIN duck_work_limit_overrides o ON o.duck_id=d.id AND o.company_id=d.company_id LEFT JOIN duck_auto_resume_overrides a ON a.duck_id=d.id AND a.company_id=d.company_id WHERE d.company_id=? AND d.removed=0 ORDER BY d.chief DESC,d.created,d.id",
    companyId,
  ).map((duck) => ({
    id: duck.id,
    name: duck.name,
    run_minutes: duck.run_minutes ?? null,
    effective_minutes: duck.run_minutes ?? runMinutes,
    auto_resume: duck.auto_resume === null ? null : !!duck.auto_resume,
    effective_auto_resume: effectiveAutoResume(companyId, duck.id),
  }));
  return {
    run_minutes: runMinutes,
    auto_resume: effectiveAutoResume(companyId, null),
    resume_eligible_count: policyResumeCount(companyId),
    ducks,
  };
}

export function registerWorkLimits(app) {
  app.post("/api/work-limits/resume", (req, res) => {
    can(req.member, "company");
    const resumed = resumePolicyHeldWork(req.company.id, req.user.id);
    res.json({ resumed, work_limits: workLimits(req.company.id) });
  });
  app.get("/api/work-limits", (req, res) => {
    can(req.member, "company");
    res.json(workLimits(req.company.id));
  });
  app.patch("/api/work-limits", (req, res) => {
    can(req.member, "company");
    const a = patchSchema.parse(req.body);
    db.transaction(() => {
      // Validate the whole batch before changing anything.
      for (const item of a.duck_overrides || []) {
        const duck = tenant("ducks", item.duck_id, req.company.id);
        if (duck.removed) fail(409, "That duck is no longer on the team.");
      }
      if (a.run_minutes !== undefined)
        run(
          "INSERT INTO company_work_limits(company_id,run_minutes,updated) VALUES(?,?,?) ON CONFLICT(company_id) DO UPDATE SET run_minutes=excluded.run_minutes,updated=excluded.updated",
          req.company.id,
          a.run_minutes,
          now(),
        );
      if (a.auto_resume !== undefined)
        run(
          "INSERT INTO company_work_limits(company_id,run_minutes,auto_resume,updated) VALUES(?,?,?,?) ON CONFLICT(company_id) DO UPDATE SET auto_resume=excluded.auto_resume,updated=excluded.updated",
          req.company.id,
          legacyDefaultWorkMinutes,
          a.auto_resume ? 1 : 0,
          now(),
        );
      for (const item of a.duck_overrides || []) {
        if (item.auto_resume === null)
          run(
            "DELETE FROM duck_auto_resume_overrides WHERE company_id=? AND duck_id=?",
            req.company.id,
            item.duck_id,
          );
        else if (item.auto_resume !== undefined)
          run(
            "INSERT INTO duck_auto_resume_overrides(duck_id,company_id,auto_resume,updated) VALUES(?,?,?,?) ON CONFLICT(duck_id) DO UPDATE SET auto_resume=excluded.auto_resume,updated=excluded.updated",
            item.duck_id,
            req.company.id,
            item.auto_resume ? 1 : 0,
            now(),
          );
        if (item.run_minutes === null)
          run(
            "DELETE FROM duck_work_limit_overrides WHERE company_id=? AND duck_id=?",
            req.company.id,
            item.duck_id,
          );
        else if (item.run_minutes !== undefined)
          run(
            "INSERT INTO duck_work_limit_overrides(duck_id,company_id,run_minutes,updated) VALUES(?,?,?,?) ON CONFLICT(duck_id) DO UPDATE SET run_minutes=excluded.run_minutes,updated=excluded.updated",
            item.duck_id,
            req.company.id,
            item.run_minutes,
            now(),
          );
      }
      audit(req.company.id, req.user.id, "Work limits updated", {
        run_minutes: a.run_minutes ?? null,
        auto_resume: a.auto_resume,
        duck_overrides: (a.duck_overrides || []).map((item) => ({
          duck_id: item.duck_id,
          run_minutes: item.run_minutes,
          auto_resume: item.auto_resume,
        })),
      });
    }).immediate();
    emit(req.company.id);
    res.json(workLimits(req.company.id));
  });
}

export function beginJobWork(job, { nowMs = Date.now() } = {}) {
  return db
    .transaction(() => {
      const current = one(
        "SELECT status,work_limit_minutes FROM jobs WHERE id=? AND company_id=? AND duck_id=?",
        job.id,
        job.company_id,
        job.duck_id,
      );
      if (!current || current.status !== "queued") return false;
      const limit =
        current.work_limit_minutes ??
        effectiveWorkMinutes(job.company_id, job.duck_id);
      const started = run(
        "UPDATE jobs SET status='running',work_limit_minutes=?,work_active_since_ms=?,updated=? WHERE id=? AND status='queued'",
        limit,
        nowMs,
        now(),
        job.id,
      );
      if (!started.changes) return false;
      if (job.task_id) {
        // A ticket becomes Working when its job actually claims a worker slot.
        // Queued work is intentionally left Open/Waiting so several requests
        // for one duck do not all look active at once.
        run(
          "UPDATE tasks SET status='working',updated=? WHERE id=? AND company_id=? AND status<>'done'",
          now(),
          job.task_id,
          job.company_id,
        );
        run(
          "UPDATE board_tasks SET state=CASE WHEN (SELECT wr.role FROM workflow_runs wr WHERE wr.job_id=? AND wr.company_id=? AND wr.task_id=board_tasks.task_id AND wr.column_id=board_tasks.column_id AND wr.revision=board_tasks.revision LIMIT 1)='reviewer' THEN 'reviewing' ELSE 'working' END,error='',updated=? WHERE task_id=? AND company_id=? AND board_id IN (SELECT id FROM task_boards WHERE legacy=0) AND state IN ('waiting','ready','working','reviewing') AND EXISTS (SELECT 1 FROM workflow_runs wr WHERE wr.job_id=? AND wr.company_id=? AND wr.task_id=board_tasks.task_id AND wr.column_id=board_tasks.column_id AND wr.revision=board_tasks.revision)",
          job.id,
          job.company_id,
          now(),
          job.task_id,
          job.company_id,
          job.id,
          job.company_id,
        );
      }
      return true;
    })
    .immediate();
}

// Direct provider calls in tests, and any legacy running row at rollout,
// receive a snapshot once. Ordinary worker starts use beginJobWork.
export function ensureJobWork(job, { nowMs = Date.now() } = {}) {
  let row = one(
    "SELECT status,work_limit_minutes,work_used_ms,work_active_since_ms FROM jobs WHERE id=? AND company_id=? AND duck_id=?",
    job.id,
    job.company_id,
    job.duck_id,
  );
  if (!row) fail(404, "This run was not found.");
  if (
    row.status === "running" &&
    (row.work_limit_minutes === null || row.work_active_since_ms === null)
  ) {
    const limit =
      row.work_limit_minutes ??
      effectiveWorkMinutes(job.company_id, job.duck_id);
    run(
      "UPDATE jobs SET work_limit_minutes=coalesce(work_limit_minutes,?),work_active_since_ms=coalesce(work_active_since_ms,?) WHERE id=? AND status='running'",
      limit,
      nowMs,
      job.id,
    );
    row = one(
      "SELECT status,work_limit_minutes,work_used_ms,work_active_since_ms FROM jobs WHERE id=?",
      job.id,
    );
  }
  return row;
}

export function remainingWorkMs(job, { nowMs = Date.now() } = {}) {
  const row = ensureJobWork(job, { nowMs });
  const minutes =
    row.work_limit_minutes ?? effectiveWorkMinutes(job.company_id, job.duck_id);
  if (minutes === 0) return null;
  const active =
    row.status === "running" && row.work_active_since_ms !== null
      ? Math.max(0, nowMs - row.work_active_since_ms)
      : 0;
  return Math.max(0, minutes * 60000 - row.work_used_ms - active);
}

export function checkpointJobWork(job, { nowMs = Date.now() } = {}) {
  run(
    "UPDATE jobs SET work_used_ms=work_used_ms+max(0,?-work_active_since_ms),work_active_since_ms=? WHERE id=? AND status='running' AND work_active_since_ms IS NOT NULL",
    nowMs,
    nowMs,
    job.id,
  );
}
