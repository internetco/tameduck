import {
  db,
  one,
  all,
  run,
  now,
  memberFor,
  permissions,
  emit,
  tenant,
  can,
  fail,
  audit,
  recordStopper,
} from "./store.mjs";
import { effectiveAutoResume, remainingWorkMs } from "./work-limits.mjs";
import { computerHeld } from "./computer-control-store.mjs";
import { deploymentDrainRequested } from "./deployment-drain.mjs";

const backoff = [60000, 300000, 900000];
const POLICY_OFF_REASON = "Automatic continuation is turned off.";
const publicStates = new Set(["waiting", "queued", "held", "needs_attention"]);
const rowFor = (job) =>
  job?.recovery_root_job_id
    ? one(
        "SELECT * FROM unfinished_work WHERE root_job_id=? AND company_id=?",
        job.recovery_root_job_id,
        job.company_id,
      )
    : null;
const eligible = (job) =>
  job?.recovery_root_job_id &&
  !job.schedule_id &&
  !one("SELECT 1 FROM duck_consultations WHERE child_job_id=?", job.id) &&
  !one("SELECT 1 FROM ticket_reply_checks WHERE job_id=?", job.id);

// Called inside enqueue's transaction. An automatic continuation claims the
// same objective. Separate new requests leave prior unfinished objectives intact.
export function registerRecoveryJob(
  job,
  { recoveryRoot = null, manualRecovery = false } = {},
) {
  if (job.schedule_id) return;
  if (recoveryRoot) {
    const prior = one(
      "SELECT * FROM unfinished_work WHERE root_job_id=? AND company_id=?",
      recoveryRoot,
      job.company_id,
    );
    if (!prior) throw new Error("The continuation record is unavailable.");
    const source = one("SELECT * FROM jobs WHERE id=?", prior.current_job_id);
    if (
      !source ||
      source.user_id !== job.user_id ||
      source.duck_id !== job.duck_id ||
      source.conversation_id !== job.conversation_id ||
      source.task_id !== job.task_id ||
      source.thread_id !== job.thread_id
    )
      throw new Error("This continuation does not belong to this request.");
    if (manualRecovery) assertManualRecoveryAllowed(source);
    run(
      "UPDATE jobs SET recovery_root_job_id=?,work_limit_minutes=?,work_used_ms=? WHERE id=?",
      recoveryRoot,
      manualRecovery ? null : source.work_limit_minutes,
      manualRecovery ? 0 : source.work_used_ms,
      job.id,
    );
    run(
      "UPDATE unfinished_work SET current_job_id=?,state='queued',next_attempt_at=NULL,attempts=CASE WHEN ?=1 THEN 0 ELSE attempts END,updated=? WHERE root_job_id=?",
      job.id,
      manualRecovery ? 1 : 0,
      now(),
      recoveryRoot,
    );
    return;
  }
  const request =
    one(
      "SELECT body FROM messages WHERE id=? AND company_id=?",
      job.input_message_id,
      job.company_id,
    )?.body || "";
  run("UPDATE jobs SET recovery_root_job_id=? WHERE id=?", job.id, job.id);
  run(
    "INSERT INTO unfinished_work(root_job_id,company_id,current_job_id,state,original_request,created,updated) VALUES(?,?,?,'active',?,?,?)",
    job.id,
    job.company_id,
    job.id,
    request,
    now(),
    now(),
  );
}

// The cards a duck asks a person to decide: setting up, changing or stopping
// a schedule, a task board, a skill. A run that leaves one is waiting for that
// answer as surely as for an approval, but only approvals and screen requests
// held it, so a run that ended "incomplete" while its card waited was retried
// a minute later, asked again, and was told it already had - or replaced its
// own card under the person reading it.
const CARDS = ["schedule_proposals", "board_proposals", "skill_proposals"];
const CARD_REASON = "Held for a person's answer to the duck's request.";
const HELD_REASON = "This work is held until a person chooses to continue.";
function waitingOnCard(job) {
  const root = job.recovery_root_job_id || job.id;
  return CARDS.some((table) =>
    one(
      "SELECT 1 FROM " +
        table +
        " p JOIN jobs j ON j.id=p.job_id WHERE j.company_id=? AND (j.id=? OR j.recovery_root_job_id=?) AND p.status='pending' AND (p.expires IS NULL OR p.expires>?)",
      job.company_id,
      job.id,
      root,
      now(),
    ),
  );
}
// A person answered one of those cards. When the answer goes to the duck as a
// message of its own, that run carries the work on, so the work that asked is
// done with. It used to stay held under the duck's reply, offering Continue,
// which started the same request over again beside the answer. Answered while
// the run that asked is still going, it is closed all the same, and its finish
// leaves it closed. When nothing carries it on - a no that ends it, a paused
// flock - it stays held, and stops saying it waits for an answer it has.
export function cardAnswered(jobId, company, { carriedOn = false } = {}) {
  const job =
    jobId &&
    one("SELECT * FROM jobs WHERE id=? AND company_id=?", jobId, company);
  const row = rowFor(job);
  if (!row || ["completed", "cancelled"].includes(row.state)) return false;
  // Another of its cards still waits, and the work waits with it.
  if (waitingOnCard(job)) return false;
  if (carriedOn) {
    run(
      "UPDATE unfinished_work SET state='completed',next_attempt_at=NULL,reason=?,updated=? WHERE root_job_id=?",
      "A person answered the duck's request, and the duck carries on from the answer.",
      now(),
      row.root_job_id,
    );
    return true;
  }
  if (row.reason === CARD_REASON)
    run(
      "UPDATE unfinished_work SET reason=?,updated=? WHERE root_job_id=?",
      HELD_REASON,
      now(),
      row.root_job_id,
    );
  return false;
}

function controlHold(job) {
  if (job.stopped_by || job.status === "cancelled")
    return "This work was stopped by a person.";
  if (
    job.needs_you ||
    ["waiting_human", "waiting_consultation"].includes(job.status) ||
    computerHeld(job.duck_id, job.company_id)
  )
    return "Waiting for a person or teammate.";
  const root = job.recovery_root_job_id;
  if (
    one(
      "SELECT 1 FROM approvals a JOIN jobs j ON j.id=a.job_id WHERE (j.id=? OR j.recovery_root_job_id=?) AND a.status IN ('pending','executing','unknown')",
      job.id,
      root,
    ) ||
    one(
      "SELECT 1 FROM human_requests h JOIN jobs j ON j.id=h.job_id WHERE (j.id=? OR j.recovery_root_job_id=?) AND h.status NOT IN ('completed','cancelled')",
      job.id,
      root,
    )
  )
    return "Waiting for a person to approve or finish input.";
  if (waitingOnCard(job)) return CARD_REASON;
  return null;
}

export function holdRecovery(
  job,
  reason = "This continuation was stopped by a person.",
) {
  const row = rowFor(job);
  if (!row || ["completed", "cancelled"].includes(row.state)) return false;
  run(
    "UPDATE unfinished_work SET state='held',next_attempt_at=NULL,reason=?,updated=? WHERE root_job_id=?",
    reason,
    now(),
    row.root_job_id,
  );
  emit(job.company_id);
  return true;
}

// Store only structured run outcomes. Free-form blocker claims are context
// for the next attempt, never authority to create a permanent hold.
export function recordUnfinishedWork(job, finish, { nowMs = Date.now() } = {}) {
  if (job.checkin) return;
  const current = one(
    "SELECT * FROM jobs WHERE id=? AND company_id=?",
    job.id,
    job.company_id,
  );
  const row = rowFor(current);
  if (!row || row.current_job_id !== job.id || !eligible(current)) return;
  if (["held", "cancelled"].includes(row.state)) return;
  if (finish.resume_policy === "hold")
    run(
      "UPDATE unfinished_work SET state='held',next_attempt_at=NULL,reason='A person asked to hold work in this task scope.',updated=? WHERE state IN ('waiting','queued','needs_attention') AND current_job_id IN (SELECT id FROM jobs WHERE company_id=? AND user_id=? AND duck_id=? AND conversation_id=? AND thread_id IS ? AND task_id IS ? AND schedule_id IS ?)",
      now(),
      current.company_id,
      current.user_id,
      current.duck_id,
      current.conversation_id,
      current.thread_id,
      current.task_id,
      current.schedule_id,
    );
  // Its card was answered while it was still going, and the answer carries
  // the work on (cardAnswered): nothing is left here to resume.
  if (row.state === "completed") return;
  const workflow = one(
    "SELECT decision FROM workflow_runs WHERE job_id=?",
    job.id,
  );
  if (
    finish.outcome === "completed" ||
    ["done", "approved"].includes(workflow?.decision)
  ) {
    run(
      "UPDATE unfinished_work SET state='completed',next_attempt_at=NULL,updated=? WHERE root_job_id=?",
      now(),
      row.root_job_id,
    );
    return;
  }
  const hold =
    controlHold(current) ||
    (finish.resume_policy === "hold" ? HELD_REASON : null) ||
    (["blocked", "changes_requested"].includes(workflow?.decision)
      ? "This workflow needs a person to review its stage decision."
      : null) ||
    (!effectiveAutoResume(current.company_id, current.duck_id)
      ? POLICY_OFF_REASON
      : null);
  const exhausted = remainingWorkMs(current, { nowMs }) === 0;
  const state = hold
    ? "held"
    : exhausted || row.attempts >= 3
      ? "needs_attention"
      : "waiting";
  const reason =
    hold ||
    (exhausted
      ? "The original work limit has been reached."
      : row.attempts >= 3
        ? "Three automatic attempts finished without completing the work."
        : "Unfinished work will be checked again.");
  run(
    "UPDATE unfinished_work SET state=?,next_attempt_at=?,reason=?,summary=?,remaining_work=?,updated=? WHERE root_job_id=?",
    state,
    state === "waiting"
      ? new Date(nowMs + backoff[row.attempts]).toISOString()
      : null,
    reason,
    (finish.summary || "").slice(-16000),
    (
      finish.remaining_work ||
      "Review the saved work and continue the original request."
    ).slice(-16000),
    now(),
    row.root_job_id,
  );
}

export function recordRecoveryFailure(job, error, options) {
  if (job.checkin) return;
  const current = one("SELECT * FROM jobs WHERE id=?", job.id);
  if (!current || !eligible(current)) return;
  // Provider restrictions require explicit reconnection or permission; retain
  // a safe public reason, never provider payloads or credentials.
  if (
    /auth|sign.?in|billing|credit|quota|permission|API key|not connected/i.test(
      error.message || "",
    )
  ) {
    holdRecovery(
      current,
      "The AI connection or its permissions need attention.",
    );
    return;
  }
  recordUnfinishedWork(
    current,
    {
      outcome: "incomplete",
      summary:
        one("SELECT body FROM messages WHERE id=?", current.output_message_id)
          ?.body || "",
      remaining_work:
        "Inspect the saved work and fresh tool state before continuing.",
    },
    options,
  );
}

export function recoverySummary(job) {
  const row = rowFor(job);
  if (!row || row.current_job_id !== job.id || !publicStates.has(row.state))
    return null;
  // A finish decision is saved before provider shutdown; until the run really
  // ends it still owns the worker resource.
  if (job.status === "running") return null;
  // The card it is waiting on is what to answer. A line beside it offering
  // Continue started the same request again before anybody had.
  if (waitingOnCard(job)) return null;
  if (
    job.task_id &&
    one(
      "SELECT status FROM tasks WHERE id=? AND company_id=?",
      job.task_id,
      job.company_id,
    )?.status === "done"
  )
    return null;
  return {
    job_id: job.id,
    user_id: job.user_id,
    state: row.state,
    next_attempt_at: row.next_attempt_at,
    attempts: row.attempts,
    reason: row.reason,
    ...manualRecoveryAvailability(job, row),
  };
}
export function taskRecoverySummary(task) {
  if (task.status === "done") return null;
  const job = one(
    "SELECT * FROM jobs WHERE company_id=? AND task_id=? ORDER BY created DESC,rowid DESC LIMIT 1",
    task.company_id,
    task.id,
  );
  const latest = recoverySummary(job);
  if (latest || task.status === "done") return latest;
  const pending = one(
    "SELECT j.* FROM unfinished_work r JOIN jobs j ON j.id=r.current_job_id WHERE r.company_id=? AND j.task_id=? AND r.state IN ('waiting','queued','held','needs_attention') ORDER BY r.updated DESC,j.rowid DESC LIMIT 1",
    task.company_id,
    task.id,
  );
  return recoverySummary(pending);
}

export function unfinishedWorkContext(job) {
  const row = rowFor(job);
  if (!row || row.root_job_id === job.id) return "";
  const ancestors = all(
    "SELECT id FROM jobs WHERE recovery_root_job_id=? AND company_id=? AND id<>? ORDER BY created,rowid",
    row.root_job_id,
    job.company_id,
    job.id,
  ).map((j) => j.id);
  const updates = [];
  for (const ancestor of ancestors) {
    for (const u of all(
      "SELECT m.body,m.created FROM jobs j JOIN messages m ON m.id=j.input_message_id WHERE j.steered_into=? AND j.status='steered' AND j.company_id=? ORDER BY j.created,j.rowid",
      ancestor,
      job.company_id,
    ))
      updates.push(u);
    for (const u of all(
      "SELECT body,created FROM duck_accepted_ticket_updates WHERE job_id=? AND company_id=? ORDER BY created,activity_id",
      ancestor,
      job.company_id,
    ))
      updates.push(u);
  }
  updates.sort((a, b) => a.created.localeCompare(b.created));
  const updateText = updates.map((u) => u.body).join("\n\n");
  const omitted =
    updateText.length > 48000
      ? "\n[Earlier accepted updates omitted. Before acting, use work_updates_read with target_job_id for these ancestor runs: " +
        ancestors.join(", ") +
        ", paging offset/next_offset, then update_id/start_char/next_char for full text. Earlier action limits still apply unless the human changed them.]\n"
      : "";
  const newerRequests = all(
    "SELECT m.body,m.id FROM messages m JOIN jobs j ON j.input_message_id=m.id WHERE j.company_id=? AND j.user_id=? AND j.duck_id=? AND j.conversation_id=? AND j.thread_id IS ? AND j.task_id IS ? AND j.recovery_root_job_id<>? AND m.rowid>(SELECT rowid FROM messages WHERE id=(SELECT input_message_id FROM jobs WHERE id=?)) AND j.status NOT IN ('steered','steering','steer_unknown') ORDER BY m.created,m.rowid",
    job.company_id,
    job.user_id,
    job.duck_id,
    job.conversation_id,
    job.thread_id,
    job.task_id,
    row.root_job_id,
    row.root_job_id,
  );
  const newerText = newerRequests
    .map((u) => "[" + u.id + "] " + u.body)
    .join("\n\n");
  const newerContext =
    newerText.length > 32000
      ? "[Earlier newer messages omitted. Read their full current thread with thread_read before acting on any old restrictions. Message references: " +
        newerRequests.map((u) => u.id).join(", ") +
        "]\n" +
        newerText.slice(-32000)
      : newerText;
  return (
    "\n\nAutomatic continuation of the same original objective. This is a system scheduling event, not a new human request or additional permission. Preserve completed work, inspect current tools before assuming earlier blockers remain, and never repeat external actions blindly. The latest accepted human changes below take precedence. Do not revive cancelled or unrelated goals.\nOriginal objective:\n" +
    (row.original_request.length > 32000
      ? row.original_request.slice(0, 32000) +
        "\n[Original request abbreviated. Read its full starting message with thread_read before acting on omitted details.]"
      : row.original_request) +
    "\nSaved progress:\n" +
    row.summary +
    "\nRemaining work:\n" +
    row.remaining_work +
    "\nAccepted human updates from this objective (chronological):\n" +
    (updates.length ? omitted + updateText.slice(-48000) : "None.") +
    "\nNewer human messages in this exact task scope (may be separate requests or status questions; preserve this objective unless the human explicitly cancels or replaces it; do not repeat their already completed separate work):\n" +
    newerContext +
    "\nThe active-work allowance is cumulative across automatic attempts. An explicit human Retry or Continue can renew it; this system wake never renews it. Use finish_work incomplete when needed; use resume_policy hold for an explicit human pause or stop.\n\n"
  );
}

function dueGate(job, { starting = false } = {}) {
  const company = one(
    "SELECT paused FROM companies WHERE id=?",
    job.company_id,
  );
  if (!company || company.paused || deploymentDrainRequested())
    return { skip: true };
  const member = memberFor(job.company_id, job.user_id);
  if (
    !member ||
    !permissions(member).chat ||
    (job.task_id && !permissions(member).tasks)
  )
    return {
      hold: "The requester no longer has permission to continue this work.",
    };
  const duck = one(
    "SELECT removed FROM ducks WHERE id=? AND company_id=?",
    job.duck_id,
    job.company_id,
  );
  const conv = one(
    "SELECT archived FROM conversations WHERE id=? AND company_id=?",
    job.conversation_id,
    job.company_id,
  );
  if (
    !duck ||
    duck.removed ||
    !conv ||
    conv.archived ||
    !one(
      "SELECT 1 FROM conversation_members WHERE conversation_id=? AND user_id=?",
      job.conversation_id,
      job.user_id,
    ) ||
    !one(
      "SELECT 1 FROM conversation_ducks WHERE conversation_id=? AND duck_id=?",
      job.conversation_id,
      job.duck_id,
    )
  )
    return { hold: "This duck or conversation is unavailable." };
  if (!effectiveAutoResume(job.company_id, job.duck_id))
    return { hold: POLICY_OFF_REASON };
  const held = controlHold(job);
  if (held) return { hold: held };
  if (remainingWorkMs(job) === 0)
    return { attention: "The original work limit has been reached." };
  const workflow = one(
    "SELECT r.*,bt.state task_state,bt.revision task_revision,bt.column_id task_column,b.archived,b.enabled,bc.duck_id stage_duck,bc.approvers,bc.retired FROM workflow_runs r JOIN board_tasks bt ON bt.task_id=r.task_id JOIN task_boards b ON b.id=bt.board_id JOIN board_columns bc ON bc.id=bt.column_id WHERE r.job_id=?",
    job.id,
  );
  if (job.task_id) {
    const task = one(
      "SELECT status,assignee_id FROM tasks WHERE id=? AND company_id=?",
      job.task_id,
      job.company_id,
    );
    if (!task || task.status === "done") return { complete: true };
    if (!workflow && task.assignee_id !== job.duck_id)
      return { hold: "This ticket is now assigned to a different duck." };
  }
  if (
    one(
      "SELECT 1 FROM jobs j WHERE company_id=? AND duck_id=? AND id<>? AND (status IN ('running','waiting_human','waiting_consultation') OR (status='queued' AND (?=0 OR j.rowid<(SELECT rowid FROM jobs WHERE id=?))))",
      job.company_id,
      job.duck_id,
      job.id,
      starting ? 1 : 0,
      job.id,
    )
  )
    return { skip: true };
  if (
    one(
      "SELECT 1 FROM jobs WHERE company_id=? AND steered_into=? AND status IN ('steering','steer_unknown')",
      job.company_id,
      job.id,
    ) ||
    (job.task_id &&
      one(
        "SELECT 1 FROM ticket_replies WHERE task_id=? AND state IN ('steering','uncertain','checking','ready')",
        job.task_id,
      ))
  )
    return { skip: true };

  if (
    workflow &&
    (workflow.decision ||
      workflow.archived ||
      !workflow.enabled ||
      workflow.retired ||
      (workflow.role === "worker" && workflow.stage_duck !== job.duck_id) ||
      (workflow.role === "reviewer" &&
        !JSON.parse(workflow.approvers).includes(job.duck_id)) ||
      workflow.revision !== workflow.task_revision ||
      workflow.column_id !== workflow.task_column ||
      !["working", "reviewing", "waiting"].includes(workflow.task_state))
  )
    return { hold: "The workflow stage changed or needs review." };
  return {};
}

let ticking = false;
export async function tickUnfinishedWork(
  { enqueue, aiStatus },
  { nowMs = Date.now() } = {},
) {
  if (ticking || deploymentDrainRequested()) return 0;
  ticking = true;
  let started = 0;
  const connections = new Map();
  try {
    for (const candidate of all(
      "SELECT * FROM unfinished_work WHERE state='waiting' AND next_attempt_at<=? ORDER BY next_attempt_at,root_job_id",
      new Date(nowMs).toISOString(),
    )) {
      if (started >= 5) break;
      let job = one(
        "SELECT * FROM jobs WHERE id=? AND company_id=?",
        candidate.current_job_id,
        candidate.company_id,
      );
      if (!job || !["done", "error", "interrupted"].includes(job.status))
        continue;
      let gate = dueGate(job);
      if (gate.skip) continue;
      if (!gate.hold && !gate.attention && !gate.complete) {
        if (!connections.has(job.company_id)) {
          try {
            connections.set(job.company_id, await aiStatus(job.company_id));
          } catch {
            connections.set(job.company_id, { transient: true });
          }
        }
        if (connections.get(job.company_id)?.transient) continue;
        if (!connections.get(job.company_id)?.connected)
          gate = {
            hold: "The AI connection needs attention before this can continue.",
          };
      }
      try {
        db.transaction(() => {
          // Re-read every condition after the connection await, in the same
          // immediate transaction as enqueue and the objective claim.
          const row = one(
            "SELECT * FROM unfinished_work WHERE root_job_id=?",
            candidate.root_job_id,
          );
          job = one("SELECT * FROM jobs WHERE id=?", candidate.current_job_id);
          if (
            !row ||
            row.state !== "waiting" ||
            row.current_job_id !== candidate.current_job_id ||
            row.next_attempt_at > new Date(nowMs).toISOString() ||
            !job ||
            !["done", "error", "interrupted"].includes(job.status)
          )
            return;
          const freshGate = dueGate(job);
          if (freshGate.skip) return;
          gate =
            freshGate.hold || freshGate.attention || freshGate.complete
              ? freshGate
              : gate;
          if (
            gate.hold ||
            gate.attention ||
            gate.complete ||
            row.attempts >= 3
          ) {
            run(
              "UPDATE unfinished_work SET state=?,reason=?,next_attempt_at=NULL,updated=? WHERE root_job_id=?",
              gate.complete
                ? "completed"
                : gate.hold
                  ? "held"
                  : "needs_attention",
              gate.hold ||
                gate.attention ||
                "Three automatic attempts finished without completing the work.",
              now(),
              row.root_job_id,
            );
            return;
          }
          const id = enqueue(
            job.company_id,
            job.user_id,
            job.conversation_id,
            job.duck_id,
            job.input_message_id,
            {
              taskId: job.task_id,
              acknowledge: false,
              recoveryRoot: row.root_job_id,
              automaticRecovery: true,
            },
          );
          // Reuse the stage's existing ownership slot and revision. No new stage
          // run, approval, decision, or stage advance is created by a heartbeat.
          run(
            "UPDATE workflow_runs SET job_id=? WHERE job_id=? AND decision IS NULL",
            id,
            job.id,
          );
          run(
            "UPDATE unfinished_work SET attempts=attempts+1 WHERE root_job_id=?",
            row.root_job_id,
          );
          started++;
        }).immediate();
      } catch (error) {
        if (error.status !== 429)
          console.error(
            "Could not queue unfinished work",
            candidate.root_job_id,
          );
      }
      emit(candidate.company_id);
    }
  } finally {
    ticking = false;
  }
  return started;
}

export function recoveryStartAllowed(job) {
  if (!job.automatic_recovery) return true;
  const row = rowFor(job);
  const gate = dueGate(job, { starting: true });
  if (!row || row.current_job_id !== job.id || row.state !== "queued") {
    run(
      "UPDATE jobs SET status='cancelled',updated=? WHERE id=? AND status='queued'",
      now(),
      job.id,
    );
    run(
      "UPDATE messages SET state='cancelled' WHERE id=?",
      job.output_message_id,
    );
    return false;
  }
  if (gate.skip) return false;
  if (gate.hold || gate.attention || gate.complete) {
    holdRecovery(
      job,
      gate.hold || gate.attention || "This ticket has already been completed.",
    );
    // The held automatic child must not occupy the normal queued-work count.
    run(
      "UPDATE jobs SET status='cancelled',updated=? WHERE id=? AND status='queued'",
      now(),
      job.id,
    );
    run(
      "UPDATE messages SET state='cancelled' WHERE id=?",
      job.output_message_id,
    );
    return false;
  }
  return true;
}

export function recoverUnfinishedAfterRestart() {
  // Old interrupted jobs have no record. A newly started run has one even if
  // it crashed before its first tool call; keep the last work checkpoint.
  for (const job of all(
    "SELECT j.* FROM jobs j JOIN unfinished_work r ON r.current_job_id=j.id WHERE j.status='interrupted' AND r.state IN ('active','queued')",
  ))
    recordUnfinishedWork(job, {
      outcome: "incomplete",
      summary:
        one("SELECT body FROM messages WHERE id=?", job.output_message_id)
          ?.body || "",
      remaining_work:
        "Check saved work and current external state after the restart before continuing.",
    });
}

export function registerRecoveryCancel(app, { cancelJob }) {
  app.post("/api/jobs/:id/cancel", async (req, res) => {
    const job = tenant("jobs", req.params.id, req.company.id);
    if (job.user_id !== req.user.id) can(req.member, "company");
    const recoveryRow =
      job.recovery_root_job_id &&
      one(
        "SELECT * FROM unfinished_work WHERE root_job_id=? AND company_id=?",
        job.recovery_root_job_id,
        job.company_id,
      );
    const recovery =
      recoveryRow &&
      ["waiting", "queued", "needs_attention"].includes(recoveryRow.state)
        ? recoveryRow
        : recoverySummary(job);
    if (
      !["queued", "running", "waiting_human", "waiting_consultation"].includes(
        job.status,
      ) &&
      !["waiting", "queued", "needs_attention"].includes(recovery?.state)
    )
      fail(409, "This run has already stopped.");
    recordStopper(job.id, req.user.id);
    holdRecovery(job);
    // A stale Stop button can point to the parent after its child was claimed.
    // Stop that same objective's current child before any asynchronous cleanup.
    if (recoveryRow && recoveryRow.current_job_id !== job.id) {
      const child = tenant("jobs", recoveryRow.current_job_id, req.company.id);
      recordStopper(child.id, req.user.id);
      await cancelJob(child);
    }
    await cancelJob(job);
    audit(req.company.id, req.user.id, "Duck run stopped", "", {
      duck: job.duck_id,
      job: job.id,
    });
    res.json({ ok: true });
  });
}

// Only the human Retry route requests renewal; model tools and the heartbeat
// never set manualRecovery. Revalidate persisted gates inside enqueue's claim.
export function assertManualRecoveryAllowed(job) {
  const member = memberFor(job.company_id, job.user_id);
  if (
    !member ||
    !permissions(member).chat ||
    (job.task_id && !permissions(member).tasks)
  )
    fail(403, "The requester no longer has permission to continue this work.");
  if (one("SELECT paused FROM companies WHERE id=?", job.company_id)?.paused)
    fail(409, "Resume your flock first.");
  if (
    !one(
      "SELECT 1 FROM conversation_members WHERE conversation_id=? AND user_id=?",
      job.conversation_id,
      job.user_id,
    ) ||
    !one(
      "SELECT 1 FROM conversation_ducks WHERE conversation_id=? AND duck_id=?",
      job.conversation_id,
      job.duck_id,
    )
  )
    fail(
      403,
      "This requester or duck no longer participates in the conversation.",
    );
  const duck = one(
    "SELECT removed FROM ducks WHERE id=? AND company_id=?",
    job.duck_id,
    job.company_id,
  );
  const conv = one(
    "SELECT archived FROM conversations WHERE id=? AND company_id=?",
    job.conversation_id,
    job.company_id,
  );
  if (!duck || duck.removed || !conv || conv.archived)
    fail(409, "This duck or conversation is unavailable.");
  if (job.task_id) {
    const task = one(
      "SELECT status,assignee_id FROM tasks WHERE id=? AND company_id=?",
      job.task_id,
      job.company_id,
    );
    if (!task || task.status === "done")
      fail(409, "This ticket has already been completed.");
    const workflow = one(
      "SELECT r.*,bt.state task_state,bt.revision task_revision,bt.column_id task_column,b.archived,b.enabled,bc.duck_id stage_duck,bc.approvers,bc.retired FROM workflow_runs r JOIN board_tasks bt ON bt.task_id=r.task_id JOIN task_boards b ON b.id=bt.board_id JOIN board_columns bc ON bc.id=bt.column_id WHERE r.job_id=?",
      job.id,
    );
    if (!workflow && task.assignee_id !== job.duck_id)
      fail(409, "This ticket is now assigned to a different duck.");
    if (
      workflow &&
      (workflow.decision ||
        workflow.archived ||
        !workflow.enabled ||
        workflow.retired ||
        (workflow.role === "worker" && workflow.stage_duck !== job.duck_id) ||
        (workflow.role === "reviewer" &&
          !JSON.parse(workflow.approvers).includes(job.duck_id)) ||
        workflow.revision !== workflow.task_revision ||
        workflow.column_id !== workflow.task_column ||
        !["working", "reviewing", "waiting"].includes(workflow.task_state))
    )
      fail(
        409,
        "The workflow stage changed or needs review. Open the ticket to continue.",
      );
  }
  const root = job.recovery_root_job_id || job.id;
  if (
    computerHeld(job.duck_id, job.company_id) ||
    one(
      "SELECT 1 FROM approvals a JOIN jobs j ON j.id=a.job_id WHERE j.company_id=? AND (j.id=? OR j.recovery_root_job_id=?) AND a.status IN ('pending','executing','unknown')",
      job.company_id,
      job.id,
      root,
    ) ||
    one(
      "SELECT 1 FROM human_requests h JOIN jobs j ON j.id=h.job_id WHERE j.company_id=? AND (j.id=? OR j.recovery_root_job_id=?) AND h.status NOT IN ('completed','cancelled')",
      job.company_id,
      job.id,
      root,
    )
  )
    fail(
      409,
      "Resolve the pending approval or human input before continuing this work.",
    );
  if (waitingOnCard(job))
    fail(
      409,
      "Answer the duck's request in this chat before continuing this work.",
    );
}

// Public action availability is advisory. Every Continue rechecks these gates
// after the provider await, inside the same transaction that claims the root.
export function manualRecoveryAvailability(job, row = rowFor(job)) {
  if (
    !row ||
    row.current_job_id !== job.id ||
    !["waiting", "held", "needs_attention"].includes(row.state)
  )
    return {
      can_continue: false,
      continue_blocked_reason: "This work is already queued or has ended.",
    };
  if (
    !["done", "error", "interrupted", "cancelled", "steer_unknown"].includes(
      job.status,
    )
  )
    return {
      can_continue: false,
      continue_blocked_reason: "This work is still running.",
    };
  try {
    assertManualRecoveryAllowed(job);
    return { can_continue: true, continue_blocked_reason: null };
  } catch (error) {
    if (!error.status) throw error;
    return { can_continue: false, continue_blocked_reason: error.message };
  }
}

// Needs you must not depend on the newest 100 jobs. Only the original
// requester sees their recovery alerts, and only while they still have access.
export function recoveryAttention(company, user, member) {
  const p = permissions(member);
  if (!p.chat) return [];
  return all(
    "SELECT j.*,t.title task_title,r.updated recovery_updated FROM unfinished_work r JOIN jobs j ON j.id=r.current_job_id JOIN conversations c ON c.id=j.conversation_id JOIN conversation_members cm ON cm.conversation_id=c.id AND cm.user_id=? LEFT JOIN tasks t ON t.id=j.task_id AND t.company_id=j.company_id WHERE r.company_id=? AND j.user_id=? AND r.state='needs_attention' AND c.archived=0 AND (j.task_id IS NULL OR (t.id IS NOT NULL AND t.status<>'done')) ORDER BY r.updated DESC",
    user,
    company,
    user,
  )
    .filter((job) => !job.task_id || p.tasks)
    .map((job) => {
      const recovery = recoverySummary(job);
      return (
        recovery && {
          ...recovery,
          duck_id: job.duck_id,
          conversation_id: job.conversation_id,
          thread_id: job.thread_id,
          task_id: job.task_id,
          task_title: job.task_title || null,
          updated: job.recovery_updated,
        }
      );
    })
    .filter(Boolean);
}

// This narrow operation only releases a hold created by the saved Off policy.
// It never renews the allowance/attempts or releases a user's stop or approval.
function policyResumeCandidates(company) {
  return all(
    "SELECT j.*,r.attempts FROM unfinished_work r JOIN jobs j ON j.id=r.current_job_id WHERE r.company_id=? AND r.state='held' AND r.reason=? AND r.attempts<3 AND j.status IN ('done','error','interrupted')",
    company,
    POLICY_OFF_REASON,
  ).filter((job) => eligible(job) && Object.keys(dueGate(job)).length === 0);
}
export function policyResumeCount(company) {
  return policyResumeCandidates(company).length;
}
export function resumePolicyHeldWork(company, user) {
  const resumed = db
    .transaction(() => {
      let count = 0;
      for (const job of policyResumeCandidates(company)) {
        count += run(
          "UPDATE unfinished_work SET state='waiting',next_attempt_at=?,reason='Automatic resume was requested in Work limits.',updated=? WHERE root_job_id=? AND current_job_id=? AND state='held' AND reason=?",
          now(),
          now(),
          job.recovery_root_job_id,
          job.id,
          POLICY_OFF_REASON,
        ).changes;
      }
      if (count)
        audit(company, user, "Automatic resume requested for held work", {
          resumed: count,
        });
      return count;
    })
    .immediate();
  if (resumed) emit(company);
  return resumed;
}
