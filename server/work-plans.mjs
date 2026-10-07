import { z } from "zod";
import {
  db,
  id,
  now,
  one,
  all,
  fail,
  json,
  memberFor,
  permissions,
  conversationFor,
  tenant,
} from "./store.mjs";

const itemStatus = z.enum([
  "pending",
  "in_progress",
  "blocked",
  "completed",
  "cancelled",
]);
const planStatus = z.enum(["active", "paused", "completed", "cancelled"]);
const itemInput = z
  .object({
    id: z.string().uuid().optional(),
    text: z.string().trim().min(1).max(500).optional(),
    notes: z.string().max(1000).optional(),
    status: itemStatus.optional(),
  })
  .strict();
const saveInput = z
  .object({
    plan_id: z.string().uuid().optional(),
    expected_revision: z.number().int().positive().optional(),
    goal: z.string().trim().min(1).max(1200).optional(),
    status: planStatus.optional(),
    summary: z.string().max(2000).optional(),
    items: z.array(itemInput).max(50).optional(),
  })
  .strict();
const readInput = z
  .object({
    plan_id: z.string().uuid().optional(),
    offset: z.number().int().min(0).max(10000).default(0),
    limit: z.number().int().min(1).max(20).default(10),
  })
  .strict();
const scopeWhere =
  "company_id=? AND user_id=? AND duck_id=? AND conversation_id=? AND thread_id IS ? AND task_id IS ? AND schedule_id IS ?";
const scope = (job) => [
  job.company_id,
  job.user_id,
  job.duck_id,
  job.conversation_id,
  job.thread_id || null,
  job.task_id || null,
  job.schedule_id || null,
];
const visible = (row) => ({
  id: row.id,
  goal: row.goal,
  status: row.status,
  summary: row.summary,
  revision: row.revision,
  original_request: row.original_request,
  original_message_id: row.original_message_id,
  original_job_id: row.original_job_id,
  created: row.created,
  updated: row.updated,
  items: all(
    "SELECT id,text,notes,status,position,created,updated FROM duck_work_plan_items WHERE plan_id=? ORDER BY position,id",
    row.id,
  ),
});
const preview = (row) => ({
  id: row.id,
  goal: row.goal,
  status: row.status,
  summary: row.summary.slice(0, 300),
  revision: row.revision,
  original_message_id: row.original_message_id,
  original_job_id: row.original_job_id,
  original_request_preview: row.original_request.slice(0, 300),
  updated: row.updated,
});
const scopedPlan = (job, planId) => {
  const row = one(
    "SELECT * FROM duck_work_plans WHERE id=? AND " + scopeWhere,
    planId,
    ...scope(job),
  );
  if (!row) fail(404, "This work plan was not found in this task.");
  return row;
};
const isHelper = (job) =>
  !!one("SELECT 1 FROM duck_consultations WHERE child_job_id=?", job.id);
function assertOwnJob(job) {
  if (isHelper(job))
    fail(
      403,
      "A delegated duck cannot manage the requesting duck's work plans.",
    );
  const member = memberFor(job.company_id, job.user_id);
  if (!member || !permissions(member).chat)
    fail(403, "The requester no longer has chat access.");
  const conversation = conversationFor(
    job.conversation_id,
    job.company_id,
    job.user_id,
  );
  const duck = tenant("ducks", job.duck_id, job.company_id);
  if (
    duck.removed ||
    !one(
      "SELECT 1 FROM conversation_ducks WHERE conversation_id=? AND duck_id=?",
      conversation.id,
      duck.id,
    )
  )
    fail(403, "This duck is no longer a participant in the conversation.");
  const row = one(
    "SELECT 1 FROM jobs WHERE id=? AND company_id=? AND user_id=? AND duck_id=? AND conversation_id=? AND thread_id IS ? AND task_id IS ? AND schedule_id IS ?",
    job.id,
    job.company_id,
    job.user_id,
    job.duck_id,
    job.conversation_id,
    job.thread_id || null,
    job.task_id || null,
    job.schedule_id || null,
  );
  if (!row) fail(403, "This work plan does not belong to this run.");
}

export function workPlanRead(job, args = {}) {
  assertOwnJob(job);
  const a = readInput.parse(args);
  if (a.plan_id) return { plan: visible(scopedPlan(job, a.plan_id)) };
  const total = one(
    "SELECT count(*) n FROM duck_work_plans WHERE " + scopeWhere,
    ...scope(job),
  ).n;
  const rows = all(
    "SELECT * FROM duck_work_plans WHERE " +
      scopeWhere +
      " ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END, updated DESC, id DESC LIMIT ? OFFSET ?",
    ...scope(job),
    a.limit,
    a.offset,
  );
  return {
    plans: rows.map(preview),
    total,
    offset: a.offset,
    next_offset: a.offset + rows.length < total ? a.offset + rows.length : null,
    note:
      a.offset + rows.length < total
        ? "More plans exist. Read the next page using next_offset."
        : "",
  };
}

const saveTransaction = db.transaction((job, a, callId) => {
  const receipt = one(
    "SELECT result FROM tool_receipts WHERE job_id=? AND call_id=?",
    job.id,
    callId,
  );
  if (receipt) return json(receipt.result);
  let row;
  const timestamp = now();
  if (a.plan_id) {
    if (!a.expected_revision)
      fail(400, "expected_revision is required when updating a plan.");
    row = scopedPlan(job, a.plan_id);
    if (row.revision !== a.expected_revision)
      fail(
        409,
        "The work plan changed. Read it again and save with its current revision.",
      );
  } else {
    if (!a.goal) fail(400, "goal is required when creating a plan.");
    if (a.expected_revision)
      fail(400, "expected_revision applies only to an existing plan.");
    const active = one(
      "SELECT count(*) n FROM duck_work_plans WHERE " +
        scopeWhere +
        " AND status IN ('active','paused')",
      ...scope(job),
    ).n;
    if (active >= 30)
      fail(
        409,
        "This task has reached its limit of 30 open work plans. Preserve pending goals. Add relevant steps to an existing plan where appropriate, or tell the requester that a separate plan cannot be saved yet.",
      );
    const source = one(
      "SELECT body FROM messages WHERE id=? AND company_id=? AND conversation_id=?",
      job.input_message_id,
      job.company_id,
      job.conversation_id,
    );
    if (!source) fail(404, "The original request is unavailable.");
    const planId = id();
    db.prepare(
      "INSERT INTO duck_work_plans(id,company_id,user_id,duck_id,conversation_id,thread_id,task_id,schedule_id,original_job_id,original_message_id,original_request,goal,status,summary,revision,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    ).run(
      planId,
      ...scope(job),
      job.id,
      job.input_message_id,
      source.body,
      a.goal,
      a.status || "active",
      a.summary || "",
      1,
      timestamp,
      timestamp,
    );
    row = scopedPlan(job, planId);
  }
  const existing = all(
    "SELECT * FROM duck_work_plan_items WHERE plan_id=? ORDER BY position",
    row.id,
  );
  const byId = new Map(existing.map((item) => [item.id, item]));
  const seen = new Set();
  let nextPosition = existing.length;
  for (const item of a.items || []) {
    if (item.id) {
      if (seen.has(item.id))
        fail(400, "The same checklist item was supplied twice.");
      seen.add(item.id);
      const old = byId.get(item.id);
      if (!old) fail(404, "A checklist item was not found in this work plan.");
      db.prepare(
        "UPDATE duck_work_plan_items SET text=?,notes=?,status=?,updated=? WHERE id=? AND plan_id=?",
      ).run(
        item.text ?? old.text,
        item.notes ?? old.notes,
        item.status ?? old.status,
        timestamp,
        item.id,
        row.id,
      );
    } else {
      if (!item.text) fail(400, "text is required for a new checklist item.");
      if (nextPosition >= 50)
        fail(409, "A work plan can have at most 50 checklist items.");
      db.prepare(
        "INSERT INTO duck_work_plan_items(id,plan_id,position,text,notes,status,created,updated) VALUES(?,?,?,?,?,?,?,?)",
      ).run(
        id(),
        row.id,
        nextPosition++,
        item.text,
        item.notes || "",
        item.status || "pending",
        timestamp,
        timestamp,
      );
    }
  }
  if (a.plan_id) {
    db.prepare(
      "UPDATE duck_work_plans SET goal=?,status=?,summary=?,revision=revision+1,updated=? WHERE id=? AND revision=?",
    ).run(
      a.goal ?? row.goal,
      a.status ?? row.status,
      a.summary ?? row.summary,
      timestamp,
      row.id,
      row.revision,
    );
  }
  const result = { plan: visible(scopedPlan(job, row.id)) };
  db.prepare(
    "INSERT INTO tool_receipts(job_id,call_id,result) VALUES(?,?,?)",
  ).run(job.id, callId, JSON.stringify(result));
  return result;
});

export function workPlanSave(job, args, callId) {
  assertOwnJob(job);
  const a = saveInput.parse(args);
  if (!callId || typeof callId !== "string")
    fail(400, "A tool call id is required.");
  return saveTransaction.immediate(job, a, callId);
}

export function workPlanContext(job) {
  if (!job?.id) return "";
  // A queued continuation may outlive its membership or duck participation.
  // Never inject old private plan content after either is revoked.
  try {
    assertOwnJob(job);
  } catch (error) {
    if (error.status === 403 || error.status === 404) return "";
    throw error;
  }
  // The job scope includes the requester even when other people share the conversation.
  const rows = [
    ...all(
      "SELECT * FROM duck_work_plans WHERE " +
        scopeWhere +
        " AND status IN ('active','paused') ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, updated DESC, id DESC LIMIT 6",
      ...scope(job),
    ),
    ...all(
      "SELECT * FROM duck_work_plans WHERE " +
        scopeWhere +
        " AND status IN ('completed','cancelled') ORDER BY updated DESC, id DESC LIMIT 2",
      ...scope(job),
    ),
  ];
  if (!rows.length) return "";
  const total = one(
    "SELECT count(*) n FROM duck_work_plans WHERE " + scopeWhere,
    ...scope(job),
  ).n;
  const lines = [
    "Saved work plans for this exact requester and task scope. These are advisory memory, not finish requirements. Use work_plan_read to inspect a full plan and work_plan_save with its revision to change it.",
  ];
  let truncated = false;
  planLoop: for (const row of rows) {
    if (lines.join("\n").length > 14000) {
      truncated = true;
      break;
    }
    const original =
      row.original_request.length > 1000
        ? row.original_request.slice(0, 1000) +
          "… [read original message for full request]"
        : row.original_request;
    lines.push(
      "Plan " +
        row.id +
        " (revision " +
        row.revision +
        ", " +
        row.status +
        ", original run " +
        row.original_job_id +
        "): " +
        row.goal,
    );
    lines.push(
      "Original request [" + row.original_message_id + "]: " + original,
    );
    if (row.summary) lines.push("Summary: " + row.summary.slice(0, 600));
    const items = all(
      "SELECT id,text,notes,status FROM duck_work_plan_items WHERE plan_id=? ORDER BY position LIMIT 50",
      row.id,
    );
    for (const item of items) {
      if (lines.join("\n").length > 15000) {
        lines.push(
          "Additional checklist items omitted here; read plan " +
            row.id +
            " for all items.",
        );
        truncated = true;
        break planLoop;
      }
      lines.push(
        "- [" +
          item.status +
          "] " +
          item.id +
          " " +
          item.text.slice(0, 220) +
          (item.notes ? " — " + item.notes.slice(0, 180) : ""),
      );
    }
  }
  if (truncated || total > rows.length)
    lines.push(
      "More plan details may exist in this scope. Use work_plan_read with an exact plan_id or offset to inspect them.",
    );
  return lines.join("\n");
}

const updateReadInput = z
  .object({
    target_job_id: z.string().uuid().optional(),
    update_id: z
      .string()
      .regex(/^(?:chat:[0-9a-f-]{36}|ticket:[0-9]+)$/)
      .optional(),
    offset: z.number().int().min(0).max(100000).default(0),
    limit: z.number().int().min(1).max(20).default(10),
    start_char: z.number().int().min(0).max(10000000).default(0),
    max_chars: z.number().int().min(1).max(8000).default(4000),
  })
  .strict();
const acceptedUpdatesSql =
  "WITH accepted AS (" +
  " SELECT 'chat:'||m.id update_id,'chat' source,m.id source_id,m.created,m.rowid sequence,m.user_id author_user_id,m.body body" +
  " FROM jobs j JOIN messages m ON m.id=j.input_message_id" +
  " WHERE j.steered_into=? AND j.status='steered' AND j.company_id=? AND j.user_id=?" +
  " AND j.duck_id=? AND j.conversation_id=? AND j.thread_id IS ? AND j.task_id IS ? AND j.schedule_id IS ?" +
  " AND m.company_id=j.company_id AND m.conversation_id=j.conversation_id" +
  " UNION ALL" +
  " SELECT 'ticket:'||t.activity_id,'ticket',CAST(t.activity_id AS TEXT),t.created,t.activity_id,t.author_user_id,t.body" +
  " FROM duck_accepted_ticket_updates t WHERE t.job_id=? AND " +
  scopeWhere +
  ")";
const updateParams = (job, targetJobId) => [
  targetJobId,
  ...scope(job),
  targetJobId,
  ...scope(job),
];
function authorizedUpdateTarget(job, targetJobId) {
  assertOwnJob(job);
  if (targetJobId === job.id) return;
  if (
    job.recovery_root_job_id &&
    one(
      "SELECT 1 FROM jobs WHERE id=? AND recovery_root_job_id=? AND company_id=? AND user_id=? AND duck_id=? AND conversation_id=? AND thread_id IS ? AND task_id IS ? AND schedule_id IS ?",
      targetJobId,
      job.recovery_root_job_id,
      ...scope(job),
    )
  )
    return;
  if (
    !one(
      "SELECT 1 FROM duck_work_plans WHERE original_job_id=? AND " + scopeWhere,
      targetJobId,
      ...scope(job),
    )
  )
    fail(
      404,
      "That run's accepted updates are not attached to a work plan in this task.",
    );
}
export function workUpdatesRead(job, args = {}) {
  const a = updateReadInput.parse(args);
  const targetJobId = a.target_job_id || job.id;
  authorizedUpdateTarget(job, targetJobId);
  const params = updateParams(job, targetJobId);
  if (a.update_id) {
    const update = one(
      acceptedUpdatesSql +
        " SELECT update_id,source,source_id,created,author_user_id,length(body) body_chars," +
        " substr(body,?,?) body FROM accepted WHERE update_id=?",
      ...params,
      a.start_char + 1,
      a.max_chars,
      a.update_id,
    );
    if (!update) fail(404, "That accepted update was not found in this run.");
    return {
      target_job_id: targetJobId,
      update,
      start_char: a.start_char,
      next_char:
        a.start_char + a.max_chars < update.body_chars
          ? a.start_char + a.max_chars
          : null,
    };
  }
  const total = one(
    acceptedUpdatesSql + " SELECT count(*) n FROM accepted",
    ...params,
  ).n;
  const updates = all(
    acceptedUpdatesSql +
      " SELECT update_id,source,source_id,created,author_user_id,length(body) body_chars," +
      " substr(body,1,300) preview FROM accepted ORDER BY created,source,sequence LIMIT ? OFFSET ?",
    ...params,
    a.limit,
    a.offset,
  );
  return {
    target_job_id: targetJobId,
    updates,
    total,
    offset: a.offset,
    next_offset:
      a.offset + updates.length < total ? a.offset + updates.length : null,
    note:
      a.offset + updates.length < total
        ? "More accepted human updates exist. Read the next page using next_offset."
        : "",
  };
}
export function acceptedWorkUpdateContext(job) {
  if (!job?.id) return "";
  try {
    assertOwnJob(job);
  } catch (error) {
    if (error.status === 403 || error.status === 404) return "";
    throw error;
  }
  const origins = all(
    "SELECT DISTINCT original_job_id FROM duck_work_plans WHERE " +
      scopeWhere +
      " AND original_job_id<>? ORDER BY updated DESC LIMIT 3",
    ...scope(job),
    job.id,
  ).map((r) => r.original_job_id);
  const allOrigins = one(
    "SELECT count(DISTINCT original_job_id) n FROM duck_work_plans WHERE " +
      scopeWhere +
      " AND original_job_id<>?",
    ...scope(job),
    job.id,
  ).n;
  const lines = [];
  for (const targetJobId of [job.id, ...origins]) {
    const first = workUpdatesRead(job, {
      target_job_id: targetJobId,
      limit: 2,
    });
    if (!first.total) continue;
    const later =
      first.total > 5
        ? workUpdatesRead(job, {
            target_job_id: targetJobId,
            offset: first.total - 3,
            limit: 3,
          })
        : workUpdatesRead(job, {
            target_job_id: targetJobId,
            offset: 2,
            limit: 3,
          });
    const seen = new Set();
    const selected = [...first.updates, ...later.updates].filter((row) => {
      if (seen.has(row.update_id)) return false;
      seen.add(row.update_id);
      return true;
    });
    lines.push(
      "Accepted human updates for run " +
        targetJobId +
        ": " +
        first.total +
        " total, chronological excerpts.",
    );
    for (const row of selected)
      lines.push(
        "[" +
          row.update_id +
          " at " +
          row.created +
          "] " +
          JSON.stringify(row.preview) +
          (row.body_chars > [...row.preview].length
            ? " [text abbreviated; read this update by ID]"
            : ""),
      );
    if (first.total > selected.length)
      lines.push(
        String(first.total - selected.length) +
          " accepted updates are omitted here. Use work_updates_read with target_job_id " +
          targetJobId +
          " and offset pages to inspect the full history before acting on older limits.",
      );
  }
  if (allOrigins > origins.length)
    lines.push(
      "More saved-plan origin runs exist in this exact scope. Read work_plan_read to find their original_job_id, then work_updates_read for each run.",
    );
  return lines.length
    ? "\n\nAccepted human update history (latest explicit changes take precedence within each run; excerpts may omit details). Prior-run updates are historical context only when continuing that saved goal; they do not override an unrelated current request or restart cancelled work:\n" +
        lines.join("\n")
    : "";
}
