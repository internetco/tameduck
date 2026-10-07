import { db, one, tenant, can, fail, audit } from "./store.mjs";
import { duckRefusalFor } from "./ai-gate.mjs";
import { manualRecoveryAvailability } from "./unfinished-work.mjs";

export function registerRecoveryActions(app, { enqueue, aiStatus }) {
  app.post("/api/jobs/:id/continue", async (req, res) => {
    can(req.member, "chat");
    const source = tenant("jobs", req.params.id, req.company.id);
    if (source.user_id !== req.user.id)
      fail(403, "Only the person who started this work can continue it.");
    if (source.task_id) can(req.member, "tasks");
    let available = manualRecoveryAvailability(source);
    if (!available.can_continue) fail(409, available.continue_blocked_reason);
    const refused = duckRefusalFor(await aiStatus(req.company.id), req.member);
    if (refused) fail(409, refused);
    const id = db
      .transaction(() => {
        const job = tenant("jobs", source.id, req.company.id);
        available = manualRecoveryAvailability(job);
        if (!available.can_continue)
          fail(409, available.continue_blocked_reason);
        // A separate current task run must not race the continuation either.
        if (
          job.task_id &&
          one(
            "SELECT 1 FROM jobs WHERE company_id=? AND task_id=? AND status IN ('queued','running','waiting_human','waiting_consultation')",
            job.company_id,
            job.task_id,
          )
        )
          fail(409, "This ticket already has work in progress.");
        const child = enqueue(
          job.company_id,
          job.user_id,
          job.conversation_id,
          job.duck_id,
          job.input_message_id,
          {
            taskId: job.task_id,
            acknowledge: false,
            recoveryRoot: job.recovery_root_job_id,
            manualRecovery: true,
          },
        );
        // Reuse an undecided workflow's ownership and revision. Continue never
        // advances the stage or replaces a recorded workflow decision.
        db.prepare(
          "UPDATE workflow_runs SET job_id=? WHERE job_id=? AND decision IS NULL",
        ).run(child, job.id);
        audit(job.company_id, req.user.id, "Unfinished work continued", {
          job: child,
          previous_job: job.id,
        });
        return child;
      })
      .immediate();
    res.json({ id });
  });
}
