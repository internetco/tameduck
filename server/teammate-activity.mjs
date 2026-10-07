import { all, one, memberFor, permissions } from "./store.mjs";

const MAX_DUCKS = 40;
const empty = () => ({ ducks: [], total: 0, truncated: false, omitted: 0 });
const state = {
  running: "working",
  waiting_human: "waiting_human",
  waiting_consultation: "waiting_helper",
  queued: "queued",
};

// This is a team-presence view, never a view of another conversation. A
// requester and their duck must still be able to use this run's destination.
function destinationFor(job, allowedTasks) {
  const current = one(
    "SELECT id,company_id,user_id,duck_id,conversation_id FROM jobs WHERE id=? AND company_id=? AND user_id=? AND duck_id=? AND conversation_id=?",
    job.id, job.company_id, job.user_id, job.duck_id, job.conversation_id,
  );
  if (!current) return null;
  let conversationId = current.conversation_id;
  const consultation = one(
    `SELECT root.conversation_id FROM duck_consultations dc
       JOIN jobs parent ON parent.id=dc.parent_job_id AND parent.company_id=dc.company_id
       JOIN jobs root ON root.id=coalesce(parent.root_job_id,parent.id) AND root.company_id=dc.company_id
      WHERE dc.child_job_id=? AND dc.company_id=?`,
    job.id, job.company_id,
  );
  if (consultation) conversationId = consultation.conversation_id;
  const conversation = one(
    "SELECT id,task_id FROM conversations WHERE id=? AND company_id=?",
    conversationId, job.company_id,
  );
  if (!conversation) return null;
  if (conversation.task_id) {
    if (!allowedTasks) return null;
    return conversation;
  }
  if (!one(
    "SELECT 1 FROM conversation_members WHERE conversation_id=? AND user_id=?",
    conversation.id, job.user_id,
  )) return null;
  if (!consultation && !one(
    "SELECT 1 FROM conversation_ducks WHERE conversation_id=? AND duck_id=?",
    conversation.id, job.duck_id,
  )) return null;
  return conversation;
}

function ticketVisibleToAudience(company, conversation, requesterCanReadTasks) {
  if (!requesterCanReadTasks) return false;
  // Ticket-owned conversations have no human members. Tickets themselves are
  // company shared; the current requester has already passed task permission.
  if (conversation.task_id) return true;
  const audience = all(
    "SELECT user_id FROM conversation_members WHERE conversation_id=?",
    conversation.id,
  );
  return audience.length > 0 && audience.every(({ user_id }) => {
    const member = memberFor(company, user_id);
    return !!member && !!permissions(member).tasks;
  });
}

export function teammateActivity(job) {
  if (!job?.id || !job.company_id || !job.user_id || !job.duck_id)
    return empty();
  const member = memberFor(job.company_id, job.user_id);
  if (!member || !permissions(member).chat) return empty();
  if (!one(
    "SELECT 1 FROM ducks WHERE id=? AND company_id=? AND removed=0",
    job.duck_id, job.company_id,
  )) return empty();
  const canReadTasks = !!permissions(member).tasks;
  const destination = destinationFor(job, canReadTasks);
  if (!destination) return empty();
  const count = one(
    "SELECT count(*) total FROM ducks WHERE company_id=? AND removed=0 AND id<>?",
    job.company_id, job.duck_id,
  ).total;
  const rows = all(
    `WITH live AS (
      SELECT j.duck_id,j.status,coalesce(j.task_id,dc.task_id) task_id,
        row_number() OVER (
          PARTITION BY j.duck_id
          ORDER BY CASE j.status
            WHEN 'running' THEN 0 WHEN 'waiting_human' THEN 1
            WHEN 'waiting_consultation' THEN 2 ELSE 3 END,
            j.created,j.rowid
        ) chosen,
        sum(CASE WHEN j.status='queued' THEN 1 ELSE 0 END)
          OVER (PARTITION BY j.duck_id) queued_count
      FROM jobs j
      LEFT JOIN duck_consultations dc
        ON dc.child_job_id=j.id AND dc.company_id=j.company_id
      WHERE j.company_id=?
        AND j.status IN ('running','waiting_human','waiting_consultation','queued')
    ), held AS (
      SELECT c.duck_id FROM computer_control h
        JOIN computers c ON c.id=h.computer_id WHERE c.company_id=?
      UNION
      SELECT duck_id FROM human_requests
        WHERE company_id=? AND status NOT IN ('completed','cancelled','parked')
    )
    SELECT d.id,d.name,live.status,live.task_id,
      coalesce(live.queued_count,0) queued_count,
      held.duck_id IS NOT NULL held
    FROM ducks d
      LEFT JOIN live ON live.duck_id=d.id AND live.chosen=1
      LEFT JOIN held ON held.duck_id=d.id
    WHERE d.company_id=? AND d.removed=0 AND d.id<>?
    ORDER BY CASE WHEN live.status IS NOT NULL OR held.duck_id IS NOT NULL
      THEN 0 ELSE 1 END,d.chief DESC,d.created,d.id
    LIMIT ?`,
    job.company_id, job.company_id, job.company_id,
    job.company_id, job.duck_id, MAX_DUCKS,
  );
  const showTicket = ticketVisibleToAudience(
    job.company_id, destination, canReadTasks,
  );
  const ids = [...new Set(rows.map((row) => row.task_id).filter(Boolean))];
  const tickets = showTicket && ids.length
    ? new Map(all(
      `SELECT id,title FROM tasks WHERE company_id=? AND id IN (${ids.map(() => "?").join(",")})`,
      job.company_id, ...ids,
    ).map((task) => [task.id, task]))
    : new Map();
  return {
    ducks: rows.map((row) => {
      const ticket = tickets.get(row.task_id);
      return {
        id: row.id,
        name: row.name,
        status: row.held ? "waiting_human" : state[row.status] || "idle",
        queued_count: row.queued_count,
        ...(ticket ? {
          ticket: {
            title: ticket.title.slice(0, 140),
            url: `/w/${job.company_id}/tasks/${ticket.id}`,
          },
        } : {}),
      };
    }),
    total: count,
    truncated: count > rows.length,
    omitted: Math.max(0, count - rows.length),
  };
}
