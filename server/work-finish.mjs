import { checkinAllowed } from "./chief-checkins.mjs";
import { recordUnfinishedWork } from "./unfinished-work.mjs";
import { z } from "zod";
import { db, one, run, now, fail, json } from "./store.mjs";

const input = z
  .object({
    outcome: z.enum(["completed", "incomplete"]),
    summary: z.string().trim().min(1).max(4000),
    reason: z.string().trim().max(2000).optional(),
    remaining_work: z.string().trim().max(4000).optional(),
    control_revision: z.number().int().min(0),
    quiet: z.boolean().optional(),
    resume_policy: z.enum(["automatic", "hold"]).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.outcome !== "incomplete") return;
    for (const key of ["reason", "remaining_work"])
      if (!value[key])
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: "Explain what stopped and what remains.",
        });
  });

export const finishFor = (job) =>
  one(
    "SELECT * FROM job_work_finishes WHERE job_id=? AND company_id=?",
    job.id,
    job.company_id,
  );

export function finishWork(job, args, callId) {
  const value = input.parse(args);
  if (job.checkin) checkinAllowed(job);
  return db
    .transaction(() => {
      const previous = one(
        "SELECT result FROM tool_receipts WHERE job_id=? AND call_id=?",
        job.id,
        callId,
      );
      if (previous) return json(previous.result);
      const current = one(
        "SELECT status,control_revision,schedule_id,needs_you FROM jobs WHERE id=? AND company_id=?",
        job.id,
        job.company_id,
      );
      if (!current || current.status !== "running")
        fail(409, "This run has stopped.");
      if (finishFor(job))
        fail(409, "This run has already recorded its finish.");
      if (
        value.quiet &&
        (value.outcome !== "completed" ||
          (!current.schedule_id && !job.checkin) ||
          current.needs_you)
      )
        fail(
          409,
          "A quiet finish is only for a completed scheduled check with nothing a person needs to see.",
        );
      if (
        one(
          "SELECT 1 FROM jobs WHERE steered_into=? AND status IN ('steering','steer_unknown') LIMIT 1",
          job.id,
        ) ||
        (job.task_id &&
          one(
            "SELECT 1 FROM ticket_replies WHERE task_id=? AND company_id=? AND state IN ('steering','uncertain') LIMIT 1",
            job.task_id,
            job.company_id,
          ))
      )
        fail(
          409,
          "A human update is being delivered. Wait for its outcome and review the latest instructions before finishing.",
        );
      if (current.control_revision !== value.control_revision)
        fail(
          409,
          "New human instructions arrived. Read the accepted updates and decide again before finishing.",
        );
      const result = {
        accepted: true,
        outcome: value.outcome,
        summary: value.summary,
        ...(value.outcome === "incomplete"
          ? { reason: value.reason, remaining_work: value.remaining_work }
          : {}),
        quiet: !!value.quiet,
        resume_policy: value.resume_policy || "automatic",
      };
      run(
        "INSERT INTO job_work_finishes(job_id,company_id,call_id,control_revision,outcome,summary,reason,remaining_work,quiet,created,resume_policy) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
        job.id,
        job.company_id,
        callId,
        value.control_revision,
        value.outcome,
        value.summary,
        value.reason || "",
        value.remaining_work || "",
        value.quiet ? 1 : 0,
        now(),
        value.resume_policy || "automatic",
      );
      if (!job.checkin) recordUnfinishedWork(job, value);
      run(
        "INSERT INTO tool_receipts(job_id,call_id,result) VALUES(?,?,?)",
        job.id,
        callId,
        JSON.stringify(result),
      );
      return result;
    })
    .immediate();
}
