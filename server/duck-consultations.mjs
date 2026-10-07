import { z } from "zod";
import {
  db,
  id,
  now,
  one,
  all,
  run,
  tenant,
  memberFor,
  permissions,
  fail,
  emit,
  addMessage,
} from "./store.mjs";
import {
  assertDuckContactAllowed,
  getDuckContactPolicy,
} from "./duck-contacts.mjs";
import { skillsFor } from "./skills.mjs";
import { artifactsFor, attachArtifact } from "./artifacts.mjs";
import { computerContext } from "./computers.mjs";
import { effectiveWorkMinutes, remainingWorkMs } from "./work-limits.mjs";
import { countSentMessages } from "./duck-messages.mjs";

export const CONSULTATION_TIMEOUT_MS = Math.min(
  Math.max(+process.env.DUCK_CONSULTATION_TIMEOUT_MS || 1800000, 1000),
  3600000,
);
export const CONSULTATION_ANSWER_LIMIT = 12000;
export const consultationStatuses = [
  "waiting",
  "running",
  "answered",
  "failed",
  "timed_out",
  "cancelled",
];
const terminal = new Set(["answered", "failed", "timed_out", "cancelled"]);
const delegatedWorkTools = new Set([
  "finish_work",
  "activity_search",
  "workspace_read",
  "ticket_read",
  "ticket_comment",
  "document_read",
  "document_save",
  "file_read",
  "file_list",
  "files_move",
  "shared_file_list",
  "shared_file_manage",
  "folder_list",
  "folder_create",
  "folder_rename",
  "folder_delete",
  "file_move",
  "computer_import_file",
  "computer_export_file",
  "computer_start",
  "computer_tools",
  "computer_action",
  "computer_terminal",
  "computer_screenshot",
  "computer_pause",
  "computer_proxy",
  "skill_read",
  "skill_resource_read",
  "secret_list",
  "secret_save",
  "secret_read",
  "mcp_tools",
  "mcp_request",
  "board_read",
  "schedule_list",
  "notes_save",
  "hand_over_screen",
  "duck_send_message",
  "duck_messages_read",
]);

export function recordDuckTaskLineage(company, taskId, jobId, duckId) {
  run(
    "INSERT OR IGNORE INTO duck_task_lineage(task_id,company_id,created_by_job_id,created_by_duck_id,created) VALUES(?,?,?,?,?)",
    taskId,
    company,
    jobId,
    duckId,
    now(),
  );
}

const liveDuck = (duckId, company) => {
  const duck = tenant("ducks", duckId, company);
  if (duck.removed) fail(409, duck.name + " was taken off the team.");
  return duck;
};

export const consultationForChild = (jobId) =>
  one("SELECT * FROM duck_consultations WHERE child_job_id=?", jobId) || null;
export const isConsultationJob = (jobId) => !!consultationForChild(jobId);
export function consultationVisibleJob(job) {
  const row = consultationForChild(job.id);
  if (!row) return job;
  return (
    one(
      "SELECT * FROM jobs WHERE id=? AND company_id=?",
      row.parent_job_id,
      row.company_id,
    ) || job
  );
}
export const consultationToolAllowed = (jobId, tool, args = {}) => {
  const consultation = consultationForChild(jobId);
  if (!consultation) return true;
  assertConsultationActive({ id: jobId });
  if (!delegatedWorkTools.has(tool))
    fail(
      403,
      "A delegated worker cannot ask another duck, delegate again, manage duck settings, or create, finish, move, or reassign the original workflow. Return the result to the requesting duck instead.",
    );
  if (
    (tool === "ticket_read" || tool === "ticket_comment") &&
    (!consultation.task_id || args.task_id !== consultation.task_id)
  )
    fail(403, "This delegated work can only use its shared ticket.");
  if (
    tool === "document_save" &&
    args.task_id &&
    args.task_id !== consultation.task_id
  )
    fail(
      403,
      "This delegated work can only link documents to its shared ticket.",
    );
  return true;
};
export const consultationTools = (tools) =>
  tools.filter((tool) => delegatedWorkTools.has(tool.name));

function publicRow(row) {
  const helper = one("SELECT name FROM ducks WHERE id=?", row.to_duck_id);
  const child = one("SELECT status FROM jobs WHERE id=?", row.child_job_id);
  const computer = one(
    `SELECT action.computer_id FROM computer_actions action
       JOIN jobs action_job ON action_job.id=action.job_id
      WHERE action_job.conversation_id=(SELECT conversation_id FROM jobs WHERE id=?)
      ORDER BY action.rowid DESC LIMIT 1`,
    row.child_job_id,
  );
  return {
    id: row.id,
    from_duck_id: row.from_duck_id,
    to_duck_id: row.to_duck_id,
    to_duck_name: helper?.name || "Former duck",
    child_job_id: row.child_job_id,
    child_status: child?.status || null,
    computer_id: computer?.computer_id || null,
    question: row.question,
    status: row.status,
    answer: row.answer || null,
    error: row.error || null,
    created: row.created,
    updated: row.updated,
  };
}
export function consultationsForMessage(company, messageId) {
  return all(
    `SELECT c.* FROM duck_consultations c JOIN jobs j ON j.id=c.parent_job_id
     WHERE c.company_id=? AND j.output_message_id=? ORDER BY c.created,c.rowid`,
    company,
    messageId,
  ).map(publicRow);
}
export function consultationsForTask(company, taskId) {
  tenant("tasks", taskId, company);
  return all(
    "SELECT * FROM duck_consultations WHERE company_id=? AND task_id=? ORDER BY created,rowid",
    company,
    taskId,
  ).map(publicRow);
}
export function consultationReceipt(job, consultationId) {
  const current = consultationBatchReceipt(job, [consultationId])
    .consultations[0];
  return {
    consultation_id: current.consultation_id,
    status: current.status,
    answer: current.answer,
    error: current.error,
    waiting: current.waiting,
    _parkConsultation: current.waiting,
  };
}

export function consultationBatchReceipt(job, consultationIds) {
  const byId = new Map(
    all(
      "SELECT * FROM duck_consultations WHERE parent_job_id=? AND company_id=? ORDER BY created,rowid",
      job.id,
      job.company_id,
    ).map((row) => [row.id, row]),
  );
  const consultations = consultationIds.map((consultationId) => {
    const row = byId.get(consultationId);
    if (!row) fail(404, "That consultation is unavailable.");
    const current = publicRow(row);
    return {
      consultation_id: row.id,
      duck_id: row.to_duck_id,
      status: row.status,
      answer: current.answer,
      error: current.error,
      waiting: !terminal.has(row.status),
    };
  });
  const waiting = consultations.some((item) => item.waiting);
  return {
    consultation_ids: consultations.map((item) => item.consultation_id),
    consultations,
    waiting,
    _parkConsultation: waiting,
  };
}

function writeTicketAsked(row, helperName) {
  if (!row.task_id) return;
  run(
    `INSERT OR IGNORE INTO ticket_activity(company_id,task_id,kind,action,body,duck_id,job_id,details,source_key,created,consultation_id)
     VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    row.company_id,
    row.task_id,
    "consultation",
    "Asked " + helperName,
    row.question,
    row.from_duck_id,
    row.parent_job_id,
    JSON.stringify({
      consultation_id: row.id,
      helper_duck_id: row.to_duck_id,
    }),
    "consultation:" + row.id,
    row.created,
    row.id,
  );
}

const requestSchema = z.object({
  duck_id: z.string().uuid(),
  question: z.string().trim().min(1).max(4000),
  context: z.string().trim().max(12000).optional(),
});

function requestConsultationBatch(
  job,
  fromDuck,
  requests,
  callId,
  { clock = Date.now, timeoutMs, single = false } = {},
) {
  if (consultationForChild(job.id))
    fail(403, "A consultation helper cannot ask another duck.");
  const parsed = z.array(requestSchema).min(1).parse(requests);
  if (new Set(parsed.map((request) => request.duck_id)).size !== parsed.length)
    fail(400, "Each helper duck may only appear once in a parallel request.");
  const rootJobId = job.root_job_id || job.id;
  const saved = one(
    "SELECT result FROM tool_receipts WHERE job_id=? AND call_id=?",
    job.id,
    callId,
  );
  if (saved) {
    const receipt = JSON.parse(saved.result);
    if (receipt.consultation_ids)
      return consultationBatchReceipt(job, receipt.consultation_ids);
    if (receipt.consultation_id)
      return consultationReceipt(job, receipt.consultation_id);
  }

  const created = now();
  const result = db.transaction(() => {
    if (!one("SELECT 1 FROM jobs WHERE id=? AND status='running'", job.id))
      fail(409, "This run has stopped.");
    const helpers = parsed.map((request) => {
      if (request.duck_id === fromDuck.id)
        fail(400, "Choose another duck for the consultation.");
      const helper = liveDuck(request.duck_id, job.company_id);
      assertDuckContactAllowed(job.company_id, fromDuck.id, helper.id);
      return helper;
    });
    const requestLimit = getDuckContactPolicy(
      job.company_id,
      fromDuck.id,
    ).max_requests_per_task;
    const used =
      one(
        "SELECT count(*) n FROM duck_consultations WHERE root_job_id=? AND from_duck_id=?",
        rootJobId,
        fromDuck.id,
      ).n + countSentMessages(rootJobId, fromDuck.id);
    if (requestLimit !== null && used + parsed.length > requestLimit)
      fail(
        409,
        `This duck's contact policy allows ${requestLimit} teammate request${requestLimit === 1 ? "" : "s"} per task. This request would exceed that limit.`,
      );
    const activeJobs = one(
      "SELECT count(*) n FROM jobs WHERE company_id=? AND status IN ('queued','running','waiting_human','waiting_consultation')",
      job.company_id,
    ).n;
    if (activeJobs + parsed.length > 30)
      fail(
        429,
        "Your flock does not have enough queued-task capacity for every helper. Let a few finish first.",
      );

    const rows = parsed.map((request, index) => {
      const helper = helpers[index];
      const consultationId = id();
      const conversationId = id();
      run(
        "INSERT INTO conversations(id,company_id,name,kind,creator_id,created,task_id) VALUES(?,?,?,?,?,?,?)",
        conversationId,
        job.company_id,
        "Duck consultation",
        "consultation",
        null,
        created,
        null,
      );
      run(
        "INSERT INTO conversation_ducks VALUES(?,?)",
        conversationId,
        helper.id,
      );
      const input = addMessage(
        job.company_id,
        conversationId,
        request.question,
        {
          user: job.user_id,
          origin: "consultation",
        },
      );
      const output = addMessage(job.company_id, conversationId, "", {
        duck: helper.id,
        state: "queued",
        origin: "consultation",
      });
      for (const sourceMessage of [job.input_message_id, job.output_message_id])
        for (const artifact of all(
          "SELECT kind,reference_id,title,verb FROM message_artifacts WHERE company_id=? AND message_id=? ORDER BY created",
          job.company_id,
          sourceMessage,
        ))
          attachArtifact(
            job.company_id,
            input,
            artifact.kind,
            artifact.reference_id,
            artifact.title,
            artifact.verb,
          );
      const childJobId = id();
      run(
        `INSERT INTO jobs(id,company_id,user_id,conversation_id,duck_id,input_message_id,output_message_id,status,created,updated,parent_job_id,root_job_id)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
        childJobId,
        job.company_id,
        job.user_id,
        conversationId,
        helper.id,
        input,
        output,
        "queued",
        created,
        created,
        job.id,
        rootJobId,
      );
      run(
        `INSERT INTO duck_consultations(id,company_id,root_job_id,parent_job_id,child_job_id,from_duck_id,to_duck_id,task_id,call_id,question,context,status,deadline,timeout_ms,work_limit_mode,created,updated)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        consultationId,
        job.company_id,
        rootJobId,
        job.id,
        childJobId,
        fromDuck.id,
        helper.id,
        job.task_id || null,
        single ? callId : callId + ":" + index,
        request.question,
        request.context || "",
        "waiting",
        clock() + (timeoutMs ?? CONSULTATION_TIMEOUT_MS),
        timeoutMs ?? CONSULTATION_TIMEOUT_MS,
        timeoutMs === undefined ? 1 : 0,
        created,
        created,
      );
      const row = one(
        "SELECT * FROM duck_consultations WHERE id=?",
        consultationId,
      );
      writeTicketAsked(row, helper.name);
      return row;
    });
    if (
      !run(
        "UPDATE jobs SET status='waiting_consultation',updated=? WHERE id=? AND status='running'",
        created,
        job.id,
      ).changes
    )
      fail(409, "This run has stopped.");
    run(
      "UPDATE messages SET state='waiting_consultation' WHERE id=?",
      job.output_message_id,
    );
    const consultationIds = rows.map((row) => row.id);
    const receipt = single
      ? {
          consultation_id: consultationIds[0],
          status: "waiting",
          waiting: true,
          message:
            helpers[0].name +
            " is answering. This run will resume automatically.",
          _parkConsultation: true,
        }
      : {
          consultation_ids: consultationIds,
          consultations: rows.map((row) => ({
            consultation_id: row.id,
            duck_id: row.to_duck_id,
            status: row.status,
          })),
          waiting: true,
          message:
            helpers.length +
            " teammate ducks are answering. This run will resume after all finish.",
          _parkConsultation: true,
        };
    run(
      "INSERT INTO tool_receipts(job_id,call_id,result) VALUES(?,?,?)",
      job.id,
      callId,
      JSON.stringify(receipt),
    );
    return receipt;
  })();
  emit(job.company_id);
  return result;
}

export function requestConsultation(job, fromDuck, args, callId, options = {}) {
  return requestConsultationBatch(
    job,
    fromDuck,
    [requestSchema.parse(args)],
    callId,
    {
      ...options,
      single: true,
    },
  );
}

export function requestConsultations(
  job,
  fromDuck,
  args,
  callId,
  options = {},
) {
  const parsed = z
    .object({ requests: z.array(requestSchema).min(1) })
    .parse(args);
  return requestConsultationBatch(
    job,
    fromDuck,
    parsed.requests,
    callId,
    options,
  );
}

export function consultationPrompt(job, duck, company) {
  const row = consultationForChild(job.id);
  if (!row) return null;
  const parent = tenant("jobs", row.parent_job_id, row.company_id);
  const originalRequest = one(
    "SELECT body FROM messages WHERE id=?",
    parent.input_message_id,
  )?.body;
  const task = row.task_id
    ? one(
        "SELECT id,title,description,status,priority,result FROM tasks WHERE id=? AND company_id=?",
        row.task_id,
        row.company_id,
      )
    : null;
  const recentActivity = row.task_id
    ? all(
        "SELECT kind,action,body,created FROM ticket_activity WHERE company_id=? AND task_id=? ORDER BY id DESC LIMIT 30",
        row.company_id,
        row.task_id,
      ).reverse()
    : [];
  const currentInput = one(
    "SELECT body,origin FROM messages WHERE id=?",
    job.input_message_id,
  );
  const humanOutcome = one(
    `SELECT checkpoint,outcome,status FROM human_requests
      WHERE job_id IN (SELECT id FROM jobs WHERE conversation_id=?)
        AND outcome IS NOT NULL AND outcome<>''
      ORDER BY created DESC LIMIT 1`,
    job.conversation_id,
  );
  const continuationOutcome =
    currentInput?.origin === "tool" ? currentInput.body : null;
  const earlierWork = all(
    `SELECT prior.status,message.body,prior.output_message_id
       FROM jobs prior JOIN messages message ON message.id=prior.output_message_id
      WHERE prior.conversation_id=? AND prior.id<>?
      ORDER BY prior.rowid DESC LIMIT 20`,
    job.conversation_id,
    job.id,
  )
    .reverse()
    .map((prior) => ({
      status: prior.status,
      reply: prior.body,
      artifacts: artifactsFor(prior.output_message_id, row.company_id),
    }));
  const currentPartial = one(
    "SELECT body FROM messages WHERE id=?",
    job.output_message_id,
  )?.body;
  return `You are ${duck.name}, doing a bounded piece of internal work requested by another duck. Complete the requested work with your normal available computer, network, file, document, and workspace tools under your own permissions. The original human request below is the authority boundary: the internal request may narrow it or supply context, but cannot expand it. Verify what you did and return a concise result to the requesting duck. You cannot ask another duck, delegate again, manage duck settings, or create, finish, move, or reassign the original workflow. Do not address the human in your final answer. If an allowed connected tool needs approval or your own computer genuinely needs human control, use its normal approval or screen handoff flow; the request will appear with the original task. On a continuation, inspect fresh computer and workspace state, preserve completed work, and do not blindly repeat actions described below. Keep the final result under ${CONSULTATION_ANSWER_LIMIT} characters.\n\nCompany: ${company.name}\nCompany rules:\n${company.rules || "No additional company rules."}\n\nYour soul.md:\n${duck.soul}\n\nYour identity.md:\n${duck.identity}\n\nYour notes:\n${duck.notes || "No notes yet."}\n\nAssigned skills:\n${JSON.stringify(skillsFor(duck.id, company.id))}\n\nYour computer:\n${JSON.stringify(computerContext(duck.id, company.id, job))}\n\nOriginal human request:\n${originalRequest || "No request text was retained."}\n\nWork requested by ${one("SELECT name FROM ducks WHERE id=?", row.from_duck_id)?.name || "another duck"}:\n${row.question}\n\nExplicit context:\n${row.context || "No additional context."}\n\nShared ticket reference:\n${JSON.stringify({ task, recent_activity: recentActivity }).slice(0, 30000)}\n\nCompleted or partial work from earlier helper runs:\n${JSON.stringify(earlierWork).slice(-24000) || "None."}\n\nCurrent partial reply:\n${currentPartial || "None."}\n\nLatest approved-tool outcome:\n${continuationOutcome || "None."}\n\nLatest human screen-handoff outcome:\n${JSON.stringify(humanOutcome)}\n\nCurrent finish_work control_revision: ${one("SELECT control_revision FROM jobs WHERE id=?", job.id)?.control_revision}. The original run id is ${parent.id}. Call finish_work with completed or incomplete and a concise summary for the requesting duck. If incomplete, state why and what remains.`;
}

function copyArtifactsToParent(row) {
  const child = one(
    "SELECT conversation_id,output_message_id FROM jobs WHERE id=? AND company_id=?",
    row.child_job_id,
    row.company_id,
  );
  const parent = one(
    "SELECT conversation_id,output_message_id FROM jobs WHERE id=? AND company_id=?",
    row.parent_job_id,
    row.company_id,
  );
  if (!child || !parent) return;
  for (const artifact of all(
    `SELECT artifact.id,artifact.kind,artifact.reference_id,artifact.title,artifact.verb
       FROM message_artifacts artifact
       JOIN messages message ON message.id=artifact.message_id
      WHERE artifact.company_id=? AND message.conversation_id=?
        AND artifact.message_id IN (SELECT output_message_id FROM jobs WHERE conversation_id=?)
      ORDER BY artifact.created,artifact.rowid`,
    row.company_id,
    child.conversation_id,
    child.conversation_id,
  )) {
    if (artifact.kind === "file")
      run(
        "UPDATE uploads SET conversation_id=?,message_id=? WHERE id=? AND company_id=? AND conversation_id=?",
        parent.conversation_id,
        parent.output_message_id,
        artifact.reference_id,
        row.company_id,
        child.conversation_id,
      );
    const changes = all(
      "SELECT field_key key,label,before_value before,after_value after FROM message_artifact_changes WHERE artifact_id=? ORDER BY rowid",
      artifact.id,
    );
    attachArtifact(
      row.company_id,
      parent.output_message_id,
      artifact.kind,
      artifact.reference_id,
      artifact.title,
      artifact.verb,
      changes,
    );
  }
}

export function continueConsultationAfterApproval(job, inputMessageId) {
  const row = assertConsultationActive(job);
  const stamp = now();
  let nextJobId;
  db.transaction(() => {
    if (
      !one(
        "SELECT 1 FROM jobs WHERE id=? AND status='waiting_consultation'",
        row.parent_job_id,
      )
    )
      fail(409, "The original run is no longer waiting for this work.");
    const output = addMessage(row.company_id, job.conversation_id, "", {
      duck: job.duck_id,
      state: "queued",
      origin: "consultation",
    });
    nextJobId = id();
    run(
      `INSERT INTO jobs(id,company_id,user_id,conversation_id,duck_id,input_message_id,output_message_id,status,created,updated,parent_job_id,root_job_id)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
      nextJobId,
      row.company_id,
      job.user_id,
      job.conversation_id,
      job.duck_id,
      inputMessageId,
      output,
      "queued",
      stamp,
      stamp,
      job.id,
      row.root_job_id,
    );
    run(
      "UPDATE jobs SET status='done',updated=? WHERE id=? AND status IN ('running','waiting_human')",
      stamp,
      job.id,
    );
    run("UPDATE messages SET state='sent' WHERE id=?", job.output_message_id);
    if (
      !run(
        "UPDATE duck_consultations SET child_job_id=?,status='waiting',updated=? WHERE id=? AND child_job_id=? AND status IN ('waiting','running')",
        nextJobId,
        stamp,
        row.id,
        job.id,
      ).changes
    )
      fail(409, "This delegated work is no longer waiting.");
  })();
  emit(row.company_id);
  return nextJobId;
}

function guard(row, { requireContact = true } = {}) {
  const member = memberFor(
    row.company_id,
    one("SELECT user_id FROM jobs WHERE id=?", row.parent_job_id)?.user_id,
  );
  if (!member || !permissions(member).chat)
    throw new Error("The requesting member no longer has chat permission.");
  liveDuck(row.from_duck_id, row.company_id);
  liveDuck(row.to_duck_id, row.company_id);
  if (requireContact)
    assertDuckContactAllowed(row.company_id, row.from_duck_id, row.to_duck_id);
}

export function assertConsultationActive(job) {
  const row = consultationForChild(job.id);
  if (!row) return null;
  guard(row);
  if (
    !["waiting", "running"].includes(row.status) ||
    one("SELECT status FROM jobs WHERE id=?", row.parent_job_id)?.status !==
      "waiting_consultation"
  )
    fail(409, "The original run is no longer waiting for this work.");
  return row;
}

export function prepareConsultationStart(job, { clock = Date.now } = {}) {
  const row = consultationForChild(job.id);
  if (!row) return true;
  try {
    return db.transaction(() => {
      assertConsultationActive(job);
      if (row.status === "running") return true;
      const parallelLimit =
        getDuckContactPolicy(row.company_id, row.from_duck_id)
          .max_parallel_requests ?? null;
      if (
        parallelLimit !== null &&
        one(
          "SELECT count(*) n FROM duck_consultations WHERE company_id=? AND from_duck_id=? AND status='running'",
          row.company_id,
          row.from_duck_id,
        ).n >= parallelLimit
      )
        return false;
      const stamp = now();
      // A helper receives its own policy when it actually starts. Keep that
      // snapshot on the child job so a later company setting cannot alter a
      // resumed run, and use its cumulative work time rather than wall time.
      const limit = row.work_limit_mode
        ? (one("SELECT work_limit_minutes FROM jobs WHERE id=?", job.id)
            ?.work_limit_minutes ??
          effectiveWorkMinutes(row.company_id, row.to_duck_id))
        : null;
      if (row.work_limit_mode)
        run(
          "UPDATE jobs SET work_limit_minutes=coalesce(work_limit_minutes,?) WHERE id=? AND status IN ('queued','running')",
          limit,
          job.id,
        );
      const timeout = row.work_limit_mode ? limit * 60000 : row.timeout_ms;
      const deadline =
        row.work_limit_mode && limit === 0
          ? Number.MAX_SAFE_INTEGER
          : clock() + timeout;
      return !!run(
        "UPDATE duck_consultations SET status='running',deadline=?,timeout_ms=?,updated=? WHERE id=? AND status='waiting'",
        deadline,
        timeout,
        stamp,
        row.id,
      ).changes;
    })();
  } catch (error) {
    const stamp = now();
    run(
      "UPDATE duck_consultations SET status='failed',error=?,updated=? WHERE id=? AND status IN ('waiting','running')",
      error.message.slice(0, 1000),
      stamp,
      row.id,
    );
    run(
      "UPDATE jobs SET status='cancelled',error=?,updated=? WHERE id=? AND status='queued'",
      error.message.slice(0, 1000),
      stamp,
      job.id,
    );
    resumeParent(row, stamp);
    return false;
  }
}

function resumeParent(row, stamp = now()) {
  db.transaction(() => {
    if (
      one(
        "SELECT 1 FROM duck_consultations WHERE parent_job_id=? AND status IN ('waiting','running') LIMIT 1",
        row.parent_job_id,
      )
    )
      return;
    if (
      run(
        "UPDATE jobs SET status='queued',updated=? WHERE id=? AND status='waiting_consultation'",
        stamp,
        row.parent_job_id,
      ).changes
    )
      run(
        "UPDATE messages SET state='queued' WHERE id=(SELECT output_message_id FROM jobs WHERE id=?)",
        row.parent_job_id,
      );
  })();
  emit(row.company_id);
}

export function consultationOutcome(jobId) {
  const rows = all(
    "SELECT * FROM duck_consultations WHERE parent_job_id=? ORDER BY created,rowid",
    jobId,
  );
  return rows.length ? rows.map(publicRow) : null;
}

export function childJobsToCancel(jobId) {
  const consultationRows = all(
    "SELECT * FROM duck_consultations WHERE parent_job_id=? AND status IN ('waiting','running')",
    jobId,
  );
  const rows = all(
    `SELECT j.* FROM duck_consultations c JOIN jobs j ON j.id=c.child_job_id
     WHERE c.parent_job_id=? AND c.status IN ('waiting','running') AND j.status IN ('queued','running','waiting_human','waiting_consultation')`,
    jobId,
  );
  if (consultationRows.length)
    run(
      "UPDATE duck_consultations SET status='cancelled',error='The original run was stopped.',updated=? WHERE parent_job_id=? AND status IN ('waiting','running')",
      now(),
      jobId,
    );
  for (const row of consultationRows) copyArtifactsToParent(row);
  for (const row of consultationRows)
    run(
      `UPDATE approvals SET status='cancelled',result='The original run was stopped before anyone decided, so the tool was never used.',updated=?
       WHERE status='pending' AND job_id IN (SELECT id FROM jobs WHERE conversation_id=(SELECT conversation_id FROM jobs WHERE id=?))`,
      now(),
      row.child_job_id,
    );
  return rows;
}

function consultationTimedOut(row, child, clock) {
  if (row.status !== "running") return false;
  if (!row.work_limit_mode) return clock() >= row.deadline;
  // A completed answer is already available for delivery. For a live helper,
  // the captured job budget excludes time waiting for people or other ducks.
  if (!child || child.status === "done") return false;
  const remaining = remainingWorkMs(child, { nowMs: clock() });
  return remaining !== null && remaining <= 0;
}

export async function advanceConsultations(
  cancelJob,
  { clock = Date.now } = {},
) {
  let after = null;
  while (true) {
    const rows = after
      ? all(
          `SELECT * FROM duck_consultations
            WHERE status IN ('waiting','running')
              AND (created>? OR (created=? AND id>?))
            ORDER BY created,id LIMIT 100`,
          after.created,
          after.created,
          after.id,
        )
      : all(
          "SELECT * FROM duck_consultations WHERE status IN ('waiting','running') ORDER BY created,id LIMIT 100",
        );
    if (!rows.length) break;
    after = rows.at(-1);
    for (let row of rows) {
      const parent = one("SELECT * FROM jobs WHERE id=?", row.parent_job_id);
      const child = one("SELECT * FROM jobs WHERE id=?", row.child_job_id);
      if (!parent || parent.status !== "waiting_consultation") {
        run(
          "UPDATE duck_consultations SET status='cancelled',error='The original run was stopped.',updated=? WHERE id=?",
          now(),
          row.id,
        );
        if (
          child &&
          [
            "queued",
            "running",
            "waiting_human",
            "waiting_consultation",
          ].includes(child.status)
        )
          await cancelJob(child);
        copyArtifactsToParent(row);
        continue;
      }
      try {
        guard(row);
      } catch (error) {
        if (/requesting member/i.test(error.message)) {
          copyArtifactsToParent(row);
          await cancelJob(parent);
          continue;
        }
        const stamp = now();
        run(
          "UPDATE duck_consultations SET status='failed',answer=NULL,error=?,updated=? WHERE id=?",
          error.message.slice(0, 1000),
          stamp,
          row.id,
        );
        if (
          child &&
          [
            "queued",
            "running",
            "waiting_human",
            "waiting_consultation",
          ].includes(child.status)
        )
          await cancelJob(child);
        copyArtifactsToParent(row);
        resumeParent(row, stamp);
        continue;
      }
      if (consultationTimedOut(row, child, clock)) {
        const stamp = now();
        run(
          "UPDATE duck_consultations SET status='timed_out',error='The consultation did not finish before its deadline.',updated=? WHERE id=?",
          stamp,
          row.id,
        );
        if (
          child &&
          [
            "queued",
            "running",
            "waiting_human",
            "waiting_consultation",
          ].includes(child.status)
        )
          await cancelJob(child);
        else if (child)
          run(
            "UPDATE approvals SET status='cancelled',result='The delegated work timed out before anyone decided.',updated=? WHERE job_id=? AND status='pending'",
            stamp,
            child.id,
          );
        copyArtifactsToParent(row);
        resumeParent(row, stamp);
        continue;
      }
      if (
        !child ||
        ["error", "interrupted", "cancelled", "steer_unknown"].includes(
          child.status,
        )
      ) {
        const stamp = now();
        const message = child?.error || "The helper duck could not answer.";
        run(
          "UPDATE duck_consultations SET status='failed',error=?,updated=? WHERE id=?",
          message.slice(0, 1000),
          stamp,
          row.id,
        );
        copyArtifactsToParent(row);
        resumeParent(row, stamp);
        continue;
      }
      if (child.status !== "done") continue;
      if (
        one(
          "SELECT 1 FROM approvals WHERE job_id=? AND status IN ('pending','executing')",
          child.id,
        )
      )
        continue;
      const stamp = now();
      try {
        guard(row);
        const answer = (
          one("SELECT body FROM messages WHERE id=?", child.output_message_id)
            ?.body || ""
        )
          .trim()
          .slice(0, CONSULTATION_ANSWER_LIMIT);
        if (!answer) throw new Error("The helper duck returned no answer.");
        run(
          "UPDATE duck_consultations SET status='answered',answer=?,error=NULL,updated=? WHERE id=?",
          answer,
          stamp,
          row.id,
        );
        copyArtifactsToParent(row);
      } catch (error) {
        run(
          "UPDATE duck_consultations SET status='failed',answer=NULL,error=?,updated=? WHERE id=?",
          error.message.slice(0, 1000),
          stamp,
          row.id,
        );
      }
      resumeParent(row, stamp);
    }
    if (rows.length < 100) break;
  }
}
