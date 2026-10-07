import { z } from "zod";
import {
  db,
  id,
  now,
  one,
  all,
  run,
  hash,
  memberFor,
  permissions,
  fail,
} from "./store.mjs";
import {
  assertDuckContactAllowed,
  getDuckContactPolicy,
} from "./duck-contacts.mjs";

const MAX_BODY = 4000;
const MAX_BATCH = 10;
const MAX_PENDING = 200;
const sendShape = z
  .object({
    duck_id: z.string().uuid(),
    body: z
      .string()
      .min(1)
      .max(MAX_BODY)
      .refine((value) => !!value.trim()),
    reply_to: z.string().uuid().optional(),
  })
  .strict();

function currentJob(job, mustRun = false) {
  if (
    !job?.id ||
    !job.company_id ||
    !job.user_id ||
    !job.duck_id ||
    !job.conversation_id
  )
    fail(403, "This run is unavailable.");
  const saved = one(
    "SELECT * FROM jobs WHERE id=? AND company_id=? AND user_id=? AND duck_id=? AND conversation_id=?",
    job.id,
    job.company_id,
    job.user_id,
    job.duck_id,
    job.conversation_id,
  );
  if (!saved) fail(403, "This run is unavailable.");
  if (mustRun && saved.status !== "running") fail(409, "This run has stopped.");
  if (
    mustRun &&
    one("SELECT paused FROM companies WHERE id=?", saved.company_id)?.paused
  )
    fail(409, "This company is paused.");
  return saved;
}
function activeDuck(company, duckId) {
  const duck = one(
    "SELECT id,name FROM ducks WHERE id=? AND company_id=? AND removed=0",
    duckId,
    company,
  );
  if (!duck) fail(403, "That duck is unavailable.");
  return duck;
}
function memberCan(company, user, task = false) {
  const member = memberFor(company, user);
  const p = permissions(member);
  return !!member && !!p.chat && (!task || !!p.tasks);
}
function jobScope(job) {
  // Consultation jobs carry an internal conversation. The human audience is
  // always the verified original task, never that internal conversation.
  const consultation = one(
    "SELECT * FROM duck_consultations WHERE child_job_id=? AND company_id=?",
    job.id,
    job.company_id,
  );
  let visible = job;
  if (consultation) {
    const parent = one(
      "SELECT * FROM jobs WHERE id=? AND company_id=?",
      consultation.parent_job_id,
      job.company_id,
    );
    const root =
      parent &&
      one(
        "SELECT * FROM jobs WHERE id=? AND company_id=?",
        parent.root_job_id || parent.id,
        job.company_id,
      );
    if (
      !parent ||
      !root ||
      consultation.to_duck_id !== job.duck_id ||
      !["waiting", "running"].includes(consultation.status) ||
      parent.status !== "waiting_consultation"
    )
      fail(403, "The original task is unavailable.");
    visible = root;
  }
  const conversation = one(
    "SELECT * FROM conversations WHERE id=? AND company_id=?",
    visible.conversation_id,
    job.company_id,
  );
  if (!conversation) fail(403, "The task conversation is unavailable.");
  if (!memberCan(job.company_id, job.user_id, !!conversation.task_id))
    fail(403, "The requesting member no longer has permission.");
  if (conversation.task_id) {
    if (
      !one(
        "SELECT 1 FROM tasks WHERE id=? AND company_id=?",
        conversation.task_id,
        job.company_id,
      )
    )
      fail(403, "The shared ticket is unavailable.");
  } else {
    if (
      !one(
        "SELECT 1 FROM conversation_members WHERE conversation_id=? AND user_id=?",
        conversation.id,
        job.user_id,
      )
    )
      fail(403, "The requesting member is no longer in this chat.");
    if (
      !consultation &&
      !one(
        "SELECT 1 FROM conversation_ducks WHERE conversation_id=? AND duck_id=?",
        conversation.id,
        job.duck_id,
      )
    )
      fail(403, "This duck is no longer in this chat.");
  }
  activeDuck(job.company_id, job.duck_id);
  return { conversation, visible, consultation };
}
function audience(company, conversation, requester) {
  let humans;
  if (conversation.task_id) {
    humans = all("SELECT user_id FROM memberships WHERE company_id=?", company)
      .map((row) => row.user_id)
      .filter((user) => memberCan(company, user, true));
  } else {
    humans = all(
      "SELECT user_id FROM conversation_members WHERE conversation_id=?",
      conversation.id,
    )
      .map((row) => row.user_id)
      .filter((user) => memberCan(company, user));
  }
  if (!humans.includes(requester) || humans.length === 0)
    fail(403, "The requesting member is outside this audience.");
  const ducks = conversation.task_id
    ? all("SELECT id FROM ducks WHERE company_id=? AND removed=0", company).map(
        (row) => row.id,
      )
    : all(
        "SELECT cd.duck_id id FROM conversation_ducks cd JOIN ducks d ON d.id=cd.duck_id WHERE cd.conversation_id=? AND d.company_id=? AND d.removed=0",
        conversation.id,
        company,
      ).map((row) => row.id);
  return { humans, ducks };
}
function parseIds(value) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
const subset = (values, allowed) =>
  values.every((value) => allowed.includes(value));
function messageSourceValid(row, targetAudience, targetScope) {
  let ancestor = row;
  const seen = new Set();
  while (ancestor) {
    if (seen.has(ancestor.id)) return false;
    seen.add(ancestor.id);
    const sourceJob = one(
      "SELECT * FROM jobs WHERE id=? AND company_id=?",
      ancestor.from_job_id,
      row.company_id,
    );
    const sourceConv = one(
      "SELECT * FROM conversations WHERE id=? AND company_id=?",
      ancestor.source_conversation_id,
      row.company_id,
    );
    if (
      !sourceJob ||
      !sourceConv ||
      sourceConv.task_id !== ancestor.source_task_id ||
      ["cancelled", "steered", "steer_unknown"].includes(sourceJob.status) ||
      (sourceJob.root_job_id &&
        one("SELECT status FROM jobs WHERE id=?", sourceJob.root_job_id)
          ?.status === "cancelled")
    )
      return false;
    if (!memberCan(row.company_id, sourceJob.user_id, !!sourceConv.task_id))
      return false;
    if (
      !sourceConv.task_id &&
      !one(
        "SELECT 1 FROM conversation_members WHERE conversation_id=? AND user_id=?",
        sourceConv.id,
        sourceJob.user_id,
      )
    )
      return false;
    if (
      sourceConv.task_id &&
      !one(
        "SELECT 1 FROM tasks WHERE id=? AND company_id=?",
        sourceConv.task_id,
        row.company_id,
      )
    )
      return false;
    try {
      activeDuck(row.company_id, ancestor.from_duck_id);
      activeDuck(row.company_id, ancestor.to_duck_id);
      assertDuckContactAllowed(
        row.company_id,
        ancestor.from_duck_id,
        ancestor.to_duck_id,
      );
      const sourceNow = audience(row.company_id, sourceConv, sourceJob.user_id);
      if (
        !sourceConv.task_id &&
        !one(
          "SELECT 1 FROM duck_consultations WHERE child_job_id=?",
          sourceJob.id,
        ) &&
        !sourceNow.ducks.includes(ancestor.from_duck_id)
      )
        return false;
      if (
        !subset(
          targetAudience.humans,
          parseIds(ancestor.source_human_audience),
        ) ||
        !subset(targetAudience.humans, sourceNow.humans)
      )
        return false;
      if (!sourceConv.task_id) {
        const permitted = [
          ...new Set([
            ...parseIds(ancestor.source_duck_audience),
            ancestor.to_duck_id,
          ]),
        ];
        const currentlyPermitted = [
          ...new Set([...sourceNow.ducks, ancestor.to_duck_id]),
        ];
        if (
          !subset(targetAudience.ducks, permitted) ||
          !subset(targetAudience.ducks, currentlyPermitted)
        )
          return false;
      }
    } catch {
      return false;
    }
    ancestor = ancestor.reply_to
      ? one(
          "SELECT * FROM duck_messages WHERE id=? AND company_id=?",
          ancestor.reply_to,
          row.company_id,
        )
      : null;
  }
  return true;
}
function visibleTo(row, job, scope, targetAudience) {
  if (row.company_id !== job.company_id || row.to_duck_id !== job.duck_id)
    return false;
  if (!messageSourceValid(row, targetAudience, scope)) return false;
  return true;
}
function publicMessage(row) {
  return {
    message_id: row.id,
    sender_kind: "duck",
    sender: { id: row.from_duck_id, name: row.from_duck_name },
    from_duck_id: row.from_duck_id,
    from_duck_name: row.from_duck_name,
    to_duck_id: row.to_duck_id,
    body: row.body,
    created: row.created,
    reply_to: row.reply_to,
    ...(row.source_task_id ? { task_id: row.source_task_id } : {}),
    status: row.delivered_job_id ? "delivered" : "queued",
  };
}
function validateRecipient(job, row) {
  const scope = jobScope(job);
  const targetAudience = audience(
    job.company_id,
    scope.conversation,
    job.user_id,
  );
  if (!visibleTo(row, job, scope, targetAudience))
    fail(403, "That message is unavailable in this task.");
  return { scope, targetAudience };
}
function receipt(row) {
  return {
    message_id: row.id,
    to_duck_id: row.to_duck_id,
    status: row.delivered_job_id ? "delivered" : "queued",
  };
}
export function countSentMessages(rootJob, fromDuck) {
  const rootJobId =
    typeof rootJob === "string" ? rootJob : rootJob.root_job_id || rootJob.id;
  const duckId = typeof fromDuck === "string" ? fromDuck : fromDuck.id;
  return one(
    "SELECT count(*) n FROM duck_messages WHERE root_job_id=? AND from_duck_id=?",
    rootJobId,
    duckId,
  ).n;
}
export function sendDuckMessage(job, input, callId) {
  const a = sendShape.parse(input);
  if (typeof callId !== "string" || !callId || callId.length > 200)
    fail(400, "A valid tool call is required.");
  const payloadHash = hash(
    JSON.stringify([a.duck_id, a.body, a.reply_to || null]),
  );
  return db.transaction(() => {
    const sender = currentJob(job, true);
    const sourceScope = jobScope(sender);
    if (
      sourceScope.consultation &&
      a.duck_id !== sourceScope.consultation.from_duck_id
    )
      fail(403, "A consultation helper can message only its requesting duck.");
    const sourceAudience = audience(
      sender.company_id,
      sourceScope.conversation,
      sender.user_id,
    );
    const from = activeDuck(sender.company_id, sender.duck_id);
    activeDuck(sender.company_id, a.duck_id);
    assertDuckContactAllowed(sender.company_id, sender.duck_id, a.duck_id);
    const saved = one(
      "SELECT * FROM duck_messages WHERE from_job_id=? AND call_id=?",
      sender.id,
      callId,
    );
    if (saved) {
      if (saved.payload_hash !== payloadHash)
        fail(409, "This tool call already sent a different message.");
      if (a.reply_to) {
        const original = one(
          "SELECT * FROM duck_messages WHERE id=? AND company_id=?",
          a.reply_to,
          sender.company_id,
        );
        if (
          !original ||
          original.to_duck_id !== sender.duck_id ||
          original.from_duck_id !== a.duck_id
        )
          fail(403, "That reply is unavailable.");
        validateRecipient(sender, original);
      }
      return receipt(saved);
    }
    let original = null;
    if (a.reply_to) {
      original = one(
        "SELECT * FROM duck_messages WHERE id=? AND company_id=?",
        a.reply_to,
        sender.company_id,
      );
      if (
        !original ||
        original.to_duck_id !== sender.duck_id ||
        original.from_duck_id !== a.duck_id ||
        !original.delivered_job_id
      )
        fail(
          403,
          "A reply must address a delivered message that this duck can currently read.",
        );
      validateRecipient(sender, original);
    }
    const rootId = sender.root_job_id || sender.id;
    const policy = getDuckContactPolicy(sender.company_id, sender.duck_id);
    const usedConsultations = one(
      "SELECT count(*) n FROM duck_consultations WHERE root_job_id=? AND from_duck_id=?",
      rootId,
      sender.duck_id,
    ).n;
    const usedMessages = countSentMessages(rootId, sender.duck_id);
    if (
      policy.max_requests_per_task !== null &&
      usedConsultations + usedMessages >= policy.max_requests_per_task
    )
      fail(
        409,
        "This duck has reached its teammate request limit for this task.",
      );
    const pending = one(
      "SELECT count(*) n FROM duck_messages WHERE company_id=? AND to_duck_id=? AND delivered_job_id IS NULL",
      sender.company_id,
      a.duck_id,
    ).n;
    if (pending >= MAX_PENDING) fail(429, "This duck's message queue is full.");
    let humans = sourceAudience.humans;
    if (original) {
      // A reply cannot widen the original audience, even if this run is on a
      // shared ticket or in a larger chat.
      humans = humans.filter((user) =>
        parseIds(original.source_human_audience).includes(user),
      );
      if (!humans.includes(sender.user_id))
        fail(403, "The reply is outside the original audience.");
    }
    const messageId = id();
    run(
      "INSERT INTO duck_messages(id,company_id,from_job_id,root_job_id,from_duck_id,from_duck_name,to_duck_id,body,created,reply_to,source_conversation_id,source_task_id,source_human_audience,source_duck_audience,call_id,payload_hash) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      messageId,
      sender.company_id,
      sender.id,
      rootId,
      from.id,
      from.name,
      a.duck_id,
      a.body,
      now(),
      original?.id || null,
      sourceScope.conversation.id,
      sourceScope.conversation.task_id || null,
      JSON.stringify(humans),
      JSON.stringify(sourceAudience.ducks),
      callId,
      payloadHash,
    );
    return receipt(one("SELECT * FROM duck_messages WHERE id=?", messageId));
  })();
}
function take(
  job,
  {
    includeRead = false,
    resume = false,
    limit = MAX_BATCH,
    max = MAX_BATCH,
    before = null,
  } = {},
) {
  const reader = currentJob(job, true);
  const scope = jobScope(reader);
  const targetAudience = audience(
    reader.company_id,
    scope.conversation,
    reader.user_id,
  );
  const bounded = Math.min(Math.max(Number(limit) || max, 1), max);
  let beforeSeq = null;
  if (before) {
    const marker = one(
      "SELECT * FROM duck_messages WHERE id=? AND company_id=? AND to_duck_id=?",
      before,
      reader.company_id,
      reader.duck_id,
    );
    if (!marker || !visibleTo(marker, reader, scope, targetAudience))
      fail(400, "That message cursor is unavailable.");
    beforeSeq = marker.seq;
  }
  const where = includeRead
    ? "1=1"
    : resume
      ? "(delivered_job_id IS NULL OR delivered_job_id=?)"
      : "delivered_job_id IS NULL";
  const params =
    resume && !includeRead
      ? [reader.company_id, reader.duck_id, reader.id]
      : [reader.company_id, reader.duck_id];
  const visible = [];
  let scanAfter = beforeSeq || 0;
  // Authorization cannot be expressed as a single SQL condition. Scan in
  // pages until enough permitted messages are found, even when many older
  // pending messages belong to other private audiences.
  while (visible.length <= bounded) {
    const rows = all(
      "SELECT * FROM duck_messages WHERE company_id=? AND to_duck_id=? AND " +
        where +
        " AND seq>? ORDER BY seq LIMIT 100",
      ...params,
      scanAfter,
    );
    if (!rows.length) break;
    for (const row of rows) {
      scanAfter = row.seq;
      if (
        row.delivered_job_id &&
        row.delivered_job_id !== reader.id &&
        !includeRead
      )
        continue;
      if (!visibleTo(row, reader, scope, targetAudience)) continue;
      visible.push(row);
      if (visible.length > bounded) break;
    }
    if (rows.length < 100) break;
  }
  const page = visible.slice(0, bounded);
  for (const row of page) {
    if (!row.delivered_job_id) {
      run(
        "UPDATE duck_messages SET delivered_job_id=?,delivered_at=? WHERE id=? AND delivered_job_id IS NULL",
        reader.id,
        now(),
        row.id,
      );
      row.delivered_job_id = reader.id;
    }
  }
  return {
    messages: page.map(publicMessage),
    has_more: visible.length > bounded,
    next_cursor: page.length ? page.at(-1).id : null,
  };
}
export function takeDuckMessages(job, options = {}) {
  if (
    !job?.id ||
    one("SELECT status FROM jobs WHERE id=?", job.id)?.status !== "running" ||
    one("SELECT paused FROM companies WHERE id=?", job.company_id)?.paused
  )
    return [];
  try {
    return db.transaction(() =>
      take(job, {
        resume: !!options.resume,
        limit: options.limit,
      }),
    )().messages;
  } catch (error) {
    // Background delivery must not break an unrelated authorized tool call
    // when membership, consultation, or contact rules change mid-run.
    if (error.status === 403 || error.status === 409) return [];
    throw error;
  }
}
export function readDuckMessages(job, options = {}) {
  return db.transaction(() =>
    take(job, {
      includeRead: !!options.include_read,
      limit: options.limit,
      max: 50,
      before: options.before,
    }),
  )();
}
