import {
  db,
  one,
  all,
  run,
  now,
  id,
  tenant,
  addMessage,
  emit,
} from "./store.mjs";
import {
  ticketContext,
  ticketConversation,
  withTicketActor,
} from "./ticket-activity.mjs";
import { workflowTask, retryWorkflowTask } from "./workflows.mjs";
import {
  maySteer,
  pendingReplies,
  replyText,
  setReplyState,
} from "./ticket-replies.mjs";

const active = (task) =>
  all(
    "SELECT * FROM jobs WHERE task_id=? AND status IN ('queued','running','waiting_human','waiting_consultation') ORDER BY created",
    task,
  );
const repliesForCheck = (check) =>
  all(
    "SELECT r.*,a.body FROM ticket_replies r JOIN ticket_activity a ON a.id=r.activity_id WHERE r.job_id=? AND r.state='checking' ORDER BY r.activity_id",
    check.job_id,
  );
function humanGate(task) {
  if (
    one(
      "SELECT 1 FROM approvals a JOIN jobs j ON j.id=a.job_id WHERE j.task_id=? AND a.status IN ('pending','executing','unknown') LIMIT 1",
      task,
    )
  )
    return true;
  if (
    one(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='human_requests'",
    )
  )
    return !!one(
      "SELECT 1 FROM human_requests h JOIN jobs j ON j.id=h.job_id WHERE j.task_id=? AND h.status NOT IN ('completed','cancelled') LIMIT 1",
      task,
    );
  return false;
}
function currentWorker(t, task) {
  if (!t || t.legacy)
    return (
      task.assignee_id &&
      one(
        "SELECT * FROM ducks WHERE id=? AND company_id=? AND removed=0",
        task.assignee_id,
        task.company_id,
      )
    );
  let column = one(
    "SELECT * FROM board_columns WHERE id=? AND retired=0",
    t.column_id,
  );
  // A finished board may have an empty Done column. Follow-up work returns to
  // the last working stage, whose approvals must run again for the new revision.
  if (!column?.duck_id && t.state === "complete")
    column = one(
      "SELECT c.* FROM workflow_runs r JOIN board_columns c ON c.id=r.column_id WHERE r.task_id=? AND r.role='worker' AND c.retired=0 AND c.board_id=? AND c.duck_id IS NOT NULL ORDER BY r.rowid DESC LIMIT 1",
      task.id,
      t.board_id,
    );
  const duck =
    column?.duck_id &&
    one(
      "SELECT * FROM ducks WHERE id=? AND company_id=? AND removed=0",
      column.duck_id,
      task.company_id,
    );
  return duck ? { ...duck, column_id: column.id } : null;
}
function changedSince(check, t) {
  return (
    (t?.column_id || null) !== check.column_id ||
    (t?.revision || null) !== check.revision
  );
}
function resume(check, rows, task, t, duck, enqueue) {
  const last = rows.at(-1);
  if (t && !t.legacy) {
    withTicketActor(task.company_id, { user_id: last.user_id }, () => {
      if (duck.column_id !== t.column_id)
        run(
          "UPDATE board_tasks SET column_id=? WHERE task_id=?",
          duck.column_id,
          task.id,
        );
      retryWorkflowTask(
        task.company_id,
        last.user_id,
        task.id,
        "Continue with the latest ticket replies. Preserve completed work. " +
          check.message,
      );
      run(
        "UPDATE tasks SET status=CASE WHEN status='done' THEN 'open' ELSE status END,assignee_id=?,updated=? WHERE id=? AND company_id=?",
        duck.id,
        now(),
        task.id,
        task.company_id,
      );
    });
  } else {
    const conv = ticketConversation(task.company_id, task, duck);
    const input = addMessage(
      task.company_id,
      conv.id,
      `Continue this ticket using its latest replies. Preserve completed work and act only on the requested follow-up.\nTitle: ${task.title}\nBrief: ${task.description}\nSaved result: ${task.result || "None"}\nTask ID: ${task.id}`,
      { user: last.user_id, origin: "workflow" },
    );
    enqueue(task.company_id, last.user_id, conv.id, duck.id, input, {
      taskId: task.id,
    });
    run(
      "UPDATE tasks SET status='open',updated=? WHERE id=? AND company_id=? AND status='done'",
      now(),
      task.id,
      task.company_id,
    );
  }
  // These complete replies will be inserted into the worker's first context,
  // without shortening them to the ordinary activity preview's character cap.
  setReplyState(rows, "ready", "Duck is continuing with your update.");
  run(
    "UPDATE inbox SET state='replied' WHERE state='pending' AND message_id IN (SELECT output_message_id FROM jobs WHERE task_id=?)",
    task.id,
  );
}

export async function tickTicketReplies({
  enqueue,
  aiStatus,
  steerTicketJob,
  nowMs = Date.now(),
}) {
  // Apply a semantic decision only after its read-only model run finishes.
  for (const check of all(
    "SELECT c.*,j.status FROM ticket_reply_checks c JOIN jobs j ON j.id=c.job_id WHERE c.applied=0 AND j.status NOT IN ('queued','running','waiting_human','waiting_consultation') LIMIT 50",
  )) {
    const rows = repliesForCheck(check);
    if (!rows.length) {
      run(
        "UPDATE ticket_reply_checks SET applied=1 WHERE job_id=?",
        check.job_id,
      );
      continue;
    }
    const task = tenant("tasks", check.task_id, check.company_id),
      t = workflowTask(task.id);
    if (check.status !== "done" || !check.action) {
      setReplyState(
        rows,
        "held",
        "Your update is saved, but Duck could not decide how to continue. Send another reply or start a new attempt.",
      );
    } else if (rows.some((r) => !maySteer(r.company_id, r.user_id))) {
      setReplyState(
        rows,
        "held",
        "Update posted. Task permission is needed to steer Duck.",
      );
    } else if (
      active(task.id).length ||
      changedSince(check, t) ||
      pendingReplies(task.company_id, task.id).some(
        (r) => r.state === "pending",
      )
    ) {
      setReplyState(
        rows,
        "pending",
        "Update received. Duck will read the latest ticket state.",
        undefined,
        { record: false },
      );
    } else if (check.action !== "resume") {
      setReplyState(rows, "noted", check.message);
    } else if (humanGate(task.id)) {
      setReplyState(
        rows,
        "held",
        "Update saved. Complete the existing approval or private input request to continue.",
      );
    } else if (
      one("SELECT paused FROM companies WHERE id=?", task.company_id)?.paused ||
      (t && !t.legacy && !t.enabled)
    ) {
      continue;
    } else {
      const duck = currentWorker(t, task);
      if (!duck)
        setReplyState(
          rows,
          "held",
          "Update saved. Assign a working duck to continue this ticket.",
        );
      else db.transaction(() => resume(check, rows, task, t, duck, enqueue))();
    }
    run(
      "UPDATE ticket_reply_checks SET applied=1 WHERE job_id=?",
      check.job_id,
    );
    emit(check.company_id);
  }

  for (const target of all(
    "SELECT company_id,task_id,max(created) latest FROM ticket_replies WHERE state='pending' GROUP BY company_id,task_id ORDER BY min(activity_id) LIMIT 50",
  )) {
    if (nowMs - target.latest < 1000) continue; // Batch quick successive replies.
    let rows = pendingReplies(target.company_id, target.task_id).filter(
      (r) => r.state === "pending",
    );
    const denied = rows.filter((r) => !maySteer(r.company_id, r.user_id));
    setReplyState(
      denied,
      "held",
      "Update posted. Task permission is needed to steer Duck.",
    );
    rows = rows.filter((r) => maySteer(r.company_id, r.user_id));
    if (!rows.length) continue;
    const task = tenant("tasks", target.task_id, target.company_id),
      t = workflowTask(task.id);
    if (
      one("SELECT paused FROM companies WHERE id=?", task.company_id)?.paused ||
      (t && !t.legacy && !t.enabled)
    )
      continue;
    const jobs = active(task.id);
    if (humanGate(task.id) || jobs.some((j) => j.status === "waiting_human")) {
      // Keep the reply for the resumed worker's context, without approving or
      // completing the private interaction through a public ticket comment.
      setReplyState(
        rows,
        "ready",
        "Update saved. Duck will read it after the existing approval or private input request is completed.",
      );
      continue;
    }
    if (jobs.length) {
      if (jobs.some((j) => j.status === "queued")) continue; // first context takes it
      // Parallel reviewers each need to see the correction, but cannot modify
      // the work or bypass their independent approval rules.
      setReplyState(
        rows,
        "steering",
        "Update received. Sending it to Duck.",
        undefined,
        { record: false },
      );
      let accepted = true,
        uncertain = false;
      for (const job of jobs) {
        try {
          const undelivered = rows.filter(
            (r) =>
              !one(
                "SELECT 1 FROM ticket_reply_deliveries WHERE activity_id=? AND job_id=?",
                r.activity_id,
                job.id,
              ),
          );
          if (!undelivered.length) continue;
          const result = await steerTicketJob(
            job,
            replyText(undelivered),
            undelivered,
          );
          if (result.accepted)
            for (const row of undelivered)
              run(
                "INSERT OR IGNORE INTO ticket_reply_deliveries VALUES(?,?)",
                row.activity_id,
                job.id,
              );
          accepted &&= !!result.accepted;
          uncertain ||= !!result.uncertain;
        } catch {
          accepted = false;
          uncertain = true;
        }
      }
      if (uncertain)
        setReplyState(
          rows,
          "uncertain",
          "Your update is saved, but delivery could not be confirmed. Check the current work before retrying.",
        );
      else if (accepted)
        setReplyState(
          rows,
          "delivered",
          "Duck received your update and is continuing.",
          jobs[0].id,
        );
      else
        setReplyState(
          rows,
          "pending",
          "Update received. Duck will read it at the next stopping point.",
          undefined,
          { record: false },
        );
      continue;
    }
    // Do not restart work after the person explicitly stopped it while this
    // reply was queued. A genuinely later reply can still request continuation.
    const stopped = one(
      "SELECT updated FROM jobs WHERE task_id=? AND status='cancelled' ORDER BY updated DESC LIMIT 1",
      task.id,
    );
    if (stopped && Date.parse(stopped.updated) >= rows.at(-1).created) {
      setReplyState(
        rows,
        "held",
        "Update saved. Duck was stopped after this reply; send another update when you want to continue.",
      );
      continue;
    }
    if (
      one(
        "SELECT 1 FROM ticket_reply_checks WHERE task_id=? AND applied=0",
        task.id,
      )
    )
      continue;
    const duck = currentWorker(t, task);
    if (!duck) {
      setReplyState(
        rows,
        "held",
        "Update saved. Assign a working duck to continue this ticket.",
      );
      continue;
    }
    const currentRun =
      t &&
      one(
        "SELECT 1 FROM workflow_runs WHERE task_id=? AND column_id=? AND revision=?",
        task.id,
        t.column_id,
        t.revision,
      );
    if (
      t &&
      !t.legacy &&
      ["ready", "waiting"].includes(t.state) &&
      !currentRun
    ) {
      setReplyState(
        rows,
        "ready",
        "Update received. Duck will use it when the queued work starts.",
      );
      continue;
    }
    if (!(await aiStatus(task.company_id)).connected) continue;
    // The provider check is asynchronous. Recheck ownership, state and active
    // work before creating the one decision job for this batch.
    const fresh = workflowTask(task.id);
    if (
      active(task.id).length ||
      fresh?.revision !== t?.revision ||
      fresh?.column_id !== t?.column_id ||
      rows.some((r) => !maySteer(r.company_id, r.user_id))
    )
      continue;
    db.transaction(() => {
      const conv = ticketConversation(task.company_id, task, duck);
      const input = addMessage(
        task.company_id,
        conv.id,
        JSON.stringify({
          ticket: {
            title: task.title,
            description: task.description,
            result: task.result,
          },
          state: t?.state || task.status,
          stage:
            t && !t.legacy
              ? one(
                  "SELECT name,instructions FROM board_columns WHERE id=?",
                  t.column_id,
                )
              : null,
          activity: ticketContext(task.company_id, task.id),
          latest_replies: rows.map((r) => ({
            author: r.user_name,
            body: r.body,
          })),
          instruction:
            "Decide whether these latest replies require continuing work, acknowledgement only, or a necessary clarification. Do not do the work in this decision step.",
        }),
        { user: rows.at(-1).user_id, origin: "workflow" },
      );
      // No task_id: this read-only decision is not a new workflow attempt.
      const job = enqueue(
        task.company_id,
        rows.at(-1).user_id,
        conv.id,
        duck.id,
        input,
      );
      run(
        "INSERT INTO ticket_reply_checks(job_id,company_id,task_id,column_id,revision) VALUES(?,?,?,?,?)",
        job,
        task.company_id,
        task.id,
        t?.column_id || null,
        t?.revision || null,
      );
      setReplyState(
        rows,
        "checking",
        "Update received. Duck is checking what needs to happen next.",
        job,
      );
    })();
  }
}
