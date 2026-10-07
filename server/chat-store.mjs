import { modelForMessage } from "./ai-config.mjs";
import {
  db,
  id,
  now,
  one,
  all,
  run,
  fail,
  memberFor,
  tenant,
  threadRoot,
} from "./store.mjs";
import { artifactsFor } from "./artifacts.mjs";
import { fileFacts, fileNotices } from "./uploads.mjs";
import { consultationsForMessage } from "./duck-consultations.mjs";
import { queueReason } from "./job-queue-state.mjs";
import { webhookMessage } from "./webhook-context.mjs";

export function humanConversation(company, user, teammate) {
  if (user === teammate) fail(400, "Choose another teammate to message.");
  if (!memberFor(company, user) || !memberFor(company, teammate))
    fail(404, "That teammate is not in this company.");
  const [low, high] = [user, teammate].sort();
  return db.transaction(() => {
    const existing = one(
      "SELECT conversation_id FROM human_directs WHERE company_id=? AND user_low=? AND user_high=?",
      company,
      low,
      high,
    );
    if (existing) {
      // Rejoining a company restores access to this person's existing direct chat.
      for (const u of [low, high])
        run(
          "INSERT OR IGNORE INTO conversation_members VALUES(?,?)",
          existing.conversation_id,
          u,
        );
      return tenant("conversations", existing.conversation_id, company);
    }
    const cid = id();
    run(
      "INSERT INTO conversations(id,company_id,name,kind,creator_id,created) VALUES(?,?,?,?,?,?)",
      cid,
      company,
      "Direct message",
      "human",
      user,
      now(),
    );
    for (const u of [low, high])
      run("INSERT INTO conversation_members VALUES(?,?)", cid, u);
    run("INSERT INTO human_directs VALUES(?,?,?,?)", company, low, high, cid);
    return tenant("conversations", cid, company);
  })();
}
const select =
  "SELECT m.*,d.name duck_name,d.emoji,d.color,u.name user_name FROM messages m LEFT JOIN ducks d ON d.id=m.duck_id LEFT JOIN users u ON u.id=m.user_id";
// A completed silent duck run is useful audit history, but it is not a new
// thing a person needs to read, even when its tools saved a visible artifact.
// Human attachment-only messages are still unread; errors and cancellations
// still call attention to themselves.
export const notifiableMessageSql = (alias = "m") =>
  `(${alias}.origin IS NOT 'chief_checkin' AND (${alias}.state IN ('error','cancelled') OR (${alias}.state='sent' AND (` +
  `${alias}.body<>'' OR ${alias}.needs_you IS NOT NULL OR (` +
  `${alias}.duck_id IS NULL AND EXISTS (SELECT 1 FROM message_artifacts ma ` +
  `WHERE ma.message_id=${alias}.id AND ma.company_id=${alias}.company_id ` +
  `AND ma.verb<>'Viewed'))))))`;
// The server's thread count must describe the same core transcript as Chat.
// Schedule identity lives on the related job rather than the output message.
export const visibleMessageSql = (alias = "m") =>
  `(${alias}.origin IS NOT 'chief_checkin' AND NOT (${alias}.state='sent' AND ${alias}.duck_id IS NOT NULL AND ` +
  `${alias}.body='' AND ${alias}.needs_you IS NULL AND NOT EXISTS (` +
  `SELECT 1 FROM message_artifacts visible_artifact WHERE ` +
  `visible_artifact.message_id=${alias}.id AND ` +
  `visible_artifact.company_id=${alias}.company_id AND ` +
  `visible_artifact.verb<>'Viewed') AND NOT EXISTS (` +
  `SELECT 1 FROM upload_notices notice WHERE notice.message_id=${alias}.id ` +
  `AND notice.company_id=${alias}.company_id) AND NOT EXISTS (` +
  `SELECT 1 FROM jobs consultation_job JOIN duck_consultations consultation ON ` +
  `consultation.parent_job_id=consultation_job.id WHERE ` +
  `consultation_job.output_message_id=${alias}.id AND ` +
  `consultation.company_id=${alias}.company_id) AND NOT EXISTS (` +
  `SELECT 1 FROM jobs schedule_job LEFT JOIN messages schedule_input ON ` +
  `schedule_input.id=schedule_job.input_message_id AND ` +
  `schedule_input.company_id=schedule_job.company_id WHERE ` +
  `schedule_job.output_message_id=${alias}.id AND ` +
  `schedule_job.company_id=${alias}.company_id AND ` +
  `(schedule_job.schedule_id IS NOT NULL OR schedule_input.origin='schedule')) AND NOT EXISTS (` +
  `SELECT 1 FROM jobs acknowledgement_job WHERE acknowledgement_job.output_message_id=${alias}.id ` +
  `AND acknowledgement_job.company_id=${alias}.company_id AND acknowledgement_job.acknowledgement IS NOT NULL)))`;
export function decoratedMessages(
  company,
  conversation,
  thread = null,
  limit = 1000,
) {
  return all(
    select +
      " WHERE m.company_id=? AND m.origin IS NOT 'chief_checkin' AND m.conversation_id=? AND m.thread_id IS ? ORDER BY m.rowid DESC LIMIT ?",
    company,
    conversation,
    thread,
    Math.min(Math.max(Math.trunc(limit) || 1000, 1), 20000),
  )
    .reverse()
    .map((m) => decorate(company, m));
}
// A duck reply's own run, sent with the reply. The chat used to find it only in
// the workspace's list of its 100 newest runs, so once 100 more had happened -
// a schedule every five minutes does it in about eight hours - an older reply
// lost its run. A failure's reason then printed as the duck's own words, the
// card below said the duck gave none, Try again went, and "Stopped by you"
// became "Run stopped." (usability hunt #16).
//
// Later runs of the same request come too, but only under a reply that failed
// or was stopped: those are the only cards that ask whether it was tried again,
// and a chat can hold a thousand replies, so this is not asked of every one.
const endedBadly = ["error", "interrupted", "cancelled", "steer_unknown"];
function runFacts(company, m) {
  if (!m.duck_id) return { run: null, later_runs: [] };
  const run = one(
    "SELECT j.*,f.outcome work_outcome FROM jobs j LEFT JOIN job_work_finishes f ON f.job_id=j.id WHERE j.company_id=? AND j.output_message_id=? ORDER BY j.created DESC LIMIT 1",
    company,
    m.id,
  );
  if (!run) return { run: null, later_runs: [] };
  const later_runs =
    run.input_message_id && endedBadly.includes(run.status)
      ? all(
          "SELECT * FROM jobs WHERE company_id=? AND input_message_id=? AND duck_id=? AND id<>? AND created>? ORDER BY created DESC LIMIT 5",
          company,
          run.input_message_id,
          run.duck_id,
          run.id,
          run.created,
        )
      : [];
  const accepted_steers = all(
    `SELECT id,company_id,user_id,conversation_id,thread_id,duck_id,
      input_message_id,status,steered_into,updated,rowid accepted_order
     FROM jobs WHERE company_id=? AND user_id=? AND conversation_id=?
     AND thread_id IS ? AND duck_id=? AND status='steered'
     AND steered_into=? ORDER BY updated,rowid`,
    run.company_id,
    run.user_id,
    run.conversation_id,
    run.thread_id || null,
    run.duck_id,
    run.id,
  );
  return {
    run: { ...run, queue_reason: queueReason(run), accepted_steers },
    later_runs,
  };
}
// Everything a message needs before a person sees it. A thread's parent was
// assembled by hand without this, so a shared file lost the facts that say it
// still exists and the thread opened claiming the file had been deleted.
function decorate(company, m) {
  const artifacts = artifactsFor(m.id, company);
  const files = fileFacts(
    company,
    artifacts.filter((a) => a.kind === "file").map((a) => a.reference_id),
  );
  return {
    ...m,
    ai_model: modelForMessage(company, m.id),
    chief_checkin:
      m.origin === "chief_checkin_suggestion"
        ? (() => {
            const r = one(
              "SELECT r.id,r.dismissed FROM chief_checkin_runs r JOIN jobs j ON j.id=r.job_id WHERE j.output_message_id=? AND r.company_id=?",
              m.id,
              company,
            );
            return r ? { run_id: r.id, dismissed: !!r.dismissed } : null;
          })()
        : null,
    // A deleted upload keeps its artifact so the message can say so.
    artifacts: artifacts.map((a) =>
      a.kind === "file" ? { ...a, file: files.get(a.reference_id) || null } : a,
    ),
    file_notices: fileNotices(company, m.id),
    consultations: m.duck_id ? consultationsForMessage(company, m.id) : [],
    ...runFacts(company, m),
    // Who the duck is actually waiting for. A paused reply in a channel is seen
    // by everybody in it, and every one of them was told it was waiting for
    // *their* input - with no form, no button and no name, because the request
    // is filed under one person and the server refuses anybody else. Say whose
    // it is.
    waiting_for: m.state === "waiting_human" ? waitingFor(m.id) : null,
    workflow: m.origin === "workflow" ? workflowRequest(m.id) : null,
    // Which app sent it, for a task that came in through a duck's webhook.
    webhook: m.origin === "webhook" ? webhookMessage(m.id) : null,
    // Also looked up for a duck reply with nothing in it, because on a
    // schedule saying nothing is the right answer and should not read as
    // a run that failed.
    schedule:
      m.origin === "schedule" || (m.duck_id && !m.body)
        ? scheduleRequest(company, m.id)
        : null,
  };
}
// The person a paused reply is waiting for: the one the request was filed
// under. Some requests carry the message directly, and a takeover taken by
// somebody outside the run's own chat carries only the run, so look for both.
const waitingFor = (message) =>
  one(
    "SELECT r.user_id FROM human_requests r LEFT JOIN jobs j ON j.id=r.job_id WHERE (r.message_id=? OR j.output_message_id=?) AND r.status NOT IN ('completed','cancelled') ORDER BY r.rowid DESC LIMIT 1",
    message,
    message,
  )?.user_id || null;
// Which schedule sent this, so chat can show one quiet line instead of the
// whole standing instruction over again every time it comes round.
function scheduleRequest(company, message) {
  const s = one(
    `SELECT j.schedule_id id,j.schedule_title title,j.schedule_summary,
      current.id current_schedule_id,input.origin input_origin
     FROM jobs j
     LEFT JOIN messages input
       ON input.id=j.input_message_id AND input.company_id=j.company_id
     LEFT JOIN schedules current
       ON current.id=j.schedule_id AND current.company_id=j.company_id
     WHERE j.company_id=? AND (j.input_message_id=? OR j.output_message_id=?)
     LIMIT 1`,
    company,
    message,
    message,
  );
  return s && s.id && s.title && s.schedule_summary
    ? {
        id: s.id,
        title: s.title,
        how_often: s.schedule_summary,
        removed: !s.current_schedule_id,
      }
    : s?.input_origin === "schedule"
      ? {
          id: null,
          title: null,
          how_often: null,
          removed: null,
        }
      : null;
}
// What a workflow request message asked for, so chat can show a short card.
function workflowRequest(message) {
  return (
    one(
      "SELECT r.role,r.revision,t.id task_id,t.title,c.name stage,c.board_id,d.name duck_name FROM jobs j JOIN workflow_runs r ON r.job_id=j.id JOIN tasks t ON t.id=r.task_id JOIN board_columns c ON c.id=r.column_id JOIN ducks d ON d.id=r.duck_id WHERE j.input_message_id=?",
      message,
    ) || null
  );
}
export function readThread(company, conversation, message) {
  const root = threadRoot(company, conversation, message);
  const parent = one(select + " WHERE m.id=?", root.id);
  return {
    parent: {
      ...decorate(company, parent),
    },
    replies: decoratedMessages(company, conversation, root.id),
  };
}
export function threadSummaries(company, conversation, user) {
  const summaries = new Map();
  const rows = all(
    `SELECT m.id,m.thread_id,m.created,m.duck_id,m.user_id,d.name duck_name,u.name user_name,
    CASE WHEN m.user_id IS NOT ? AND ${notifiableMessageSql("m")} AND r.message_id IS NULL THEN 1 ELSE 0 END unread
    FROM messages m LEFT JOIN ducks d ON d.id=m.duck_id LEFT JOIN users u ON u.id=m.user_id
    LEFT JOIN message_reads r ON r.message_id=m.id AND r.user_id=?
    WHERE m.company_id=? AND m.conversation_id=? AND m.thread_id IS NOT NULL
    AND m.state NOT IN ('queued','steered','steering')
    AND ${visibleMessageSql("m")} ORDER BY m.rowid`,
    user,
    user,
    company,
    conversation,
  );
  for (const row of rows) {
    if (!summaries.has(row.thread_id))
      summaries.set(row.thread_id, {
        reply_count: 0,
        reply_unread: 0,
        last_reply_at: null,
        repliers: [],
      });
    const thread = summaries.get(row.thread_id);
    thread.reply_count++;
    thread.reply_unread += row.unread;
    thread.last_reply_at = row.created;
    const key = row.duck_id || row.user_id;
    if (!thread.repliers.some((r) => r.id === key))
      thread.repliers.push({
        id: key,
        duck_id: row.duck_id,
        name: row.duck_name || row.user_name || "Teammate",
      });
  }
  return summaries;
}

// Unread replies live outside the main transcript, so opening a conversation
// cannot honestly clear them. Give the workspace enough information to lead a
// person to the oldest unread thread without loading chat history or marking
// anything read. The recursive walk also repairs the display target for old
// rows whose thread_id points at another reply instead of the root.
export function unreadThreadState(company, user) {
  const rows = all(
    `WITH RECURSIVE unread AS (
       SELECT message.id,message.conversation_id,message.thread_id,
              message.rowid message_rowid
         FROM messages message
         JOIN conversations conversation
           ON conversation.id=message.conversation_id
          AND conversation.company_id=message.company_id
         JOIN conversation_members membership
           ON membership.conversation_id=message.conversation_id
          AND membership.user_id=?
         LEFT JOIN message_reads receipt
           ON receipt.message_id=message.id AND receipt.user_id=?
        WHERE message.company_id=? AND message.thread_id IS NOT NULL
          AND message.user_id IS NOT ?
          AND ${notifiableMessageSql("message")}
          AND receipt.message_id IS NULL
     ), ancestors(unread_id,conversation_id,candidate_id,depth) AS (
       SELECT id,conversation_id,thread_id,0 FROM unread
       UNION ALL
       SELECT ancestor.unread_id,ancestor.conversation_id,parent.thread_id,
              ancestor.depth+1
         FROM ancestors ancestor
         JOIN messages parent ON parent.id=ancestor.candidate_id
          AND parent.conversation_id=ancestor.conversation_id
        WHERE parent.thread_id IS NOT NULL AND ancestor.depth<32
     ), normalized AS (
       SELECT unread.*,
              (SELECT ancestor.candidate_id
                 FROM ancestors ancestor
                 JOIN messages root ON root.id=ancestor.candidate_id
                  AND root.conversation_id=ancestor.conversation_id
                  AND root.thread_id IS NULL
                WHERE ancestor.unread_id=unread.id
                ORDER BY ancestor.depth DESC LIMIT 1) root_id
         FROM unread
     ), ranked AS (
       SELECT normalized.*,
              row_number() OVER (
                PARTITION BY conversation_id ORDER BY message_rowid
              ) oldest
         FROM normalized
     )
     SELECT conversation_id,count(*) unread_thread_count,
            max(CASE WHEN oldest=1 THEN root_id END) unread_thread_id
       FROM ranked GROUP BY conversation_id`,
    user,
    user,
    company,
    user,
  );
  return new Map(rows.map((row) => [row.conversation_id, row]));
}
export function markMessagesRead(company, conversation, user, ids) {
  return db.transaction(() => {
    let changed = 0;
    for (const mid of new Set(ids)) {
      const msg = one(
        "SELECT id,user_id,state FROM messages WHERE id=? AND company_id=? AND conversation_id=?",
        mid,
        company,
        conversation,
      );
      if (!msg) fail(404, "That message is not in this conversation.");
      if (
        msg.user_id === user ||
        !["sent", "error", "cancelled"].includes(msg.state)
      )
        continue;
      changed += run(
        "INSERT OR IGNORE INTO message_reads VALUES(?,?,?,?)",
        company,
        mid,
        user,
        now(),
      ).changes;
    }
    return changed;
  })();
}
