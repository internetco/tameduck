import { editedSinceOpened } from "./ticket-conflict.mjs";
import { hasPendingTicketReply } from "./ticket-replies.mjs";
import { assertDuckContactAllowed } from "./duck-contacts.mjs";
import { withTicketActor, ticketConversation } from "./ticket-activity.mjs";
import crypto from "node:crypto";
import { artifactsFor } from "./artifacts.mjs";
import { duckRefusalFor } from "./ai-gate.mjs";
import { aiDown } from "../shared/ai-access.mjs";
import { z } from "zod";
import {
  db,
  id,
  now,
  one,
  all,
  run,
  tenant,
  onTeam,
  fail,
  can,
  memberFor,
  permissions,
  json,
  addMessage,
  audit,
  emit,
  DUCK_LIMIT,
} from "./store.mjs";

function documentRefs(t) {
  return all(
    // Only what the worker produced. A document it merely opened while working
    // counts as Viewed, and counting those made the ticket's fingerprint depend
    // on files it does not own: someone editing the company brand guide then
    // invalidated a pending review of unrelated work, and the ticket's own
    // Documents list did not even show the file that caused it.
    "SELECT DISTINCT d.id,d.title,d.content,d.updated FROM workflow_runs r JOIN jobs j ON j.id=r.job_id JOIN message_artifacts a ON a.message_id=j.output_message_id AND a.kind='document' AND a.verb IN ('Created','Updated') JOIN documents d ON d.id=a.reference_id AND d.company_id=r.company_id WHERE r.task_id=? AND r.role='worker' ORDER BY d.id",
    t.task_id,
  );
}
function fileRefs(t) {
  return all(
    `SELECT u.id,u.name,u.size,u.sha256 FROM task_uploads tu
     JOIN uploads u ON u.id=tu.upload_id
     WHERE tu.company_id=? AND tu.task_id=? AND u.message_id IS NOT NULL
     ORDER BY u.id`,
    t.company_id,
    t.task_id,
  );
}
function fingerprint(t) {
  const task = tenant("tasks", t.task_id, t.company_id);
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify([
        task.title,
        task.description,
        t.worker_result,
        documentRefs(t),
        fileRefs(t),
      ]),
    )
    .digest("hex");
}
const text = z.string().trim().min(1).max(100),
  uuid = z.string().uuid();
const columnSchema = z.object({
  id: uuid.optional(),
  name: text,
  duck_id: uuid.nullable().default(null),
  instructions: z.string().max(12000).default(""),
  approvers: z.array(uuid).max(8).default([]),
  wait_for_ducks: z.array(uuid).max(DUCK_LIMIT).default([]),
  review_in_order: z.boolean().default(true),
});
const boardSchema = z.object({
  name: text,
  description: z.string().max(2000).default(""),
  auto_advance: z.boolean().default(true),
  enabled: z.boolean().default(true),
  columns: z.array(columnSchema).min(2).max(12),
});
const displaySettingsSchema = z
  .object({
    sort_order: z.enum(["newest", "oldest", "updated", "priority"]),
    hide_done_after_days: z.number().int().min(1).max(36500).nullable(),
  })
  .strict();
const activeStates = [
  "queued",
  "running",
  "waiting_human",
  "waiting_consultation",
];
// An archived board counts as paused, so everything that already waits on a
// paused board - the engine, and a reply on the ticket - waits on it too.
export const workflowTask = (tid) =>
  one(
    "SELECT bt.*,b.legacy,(b.enabled AND NOT b.archived) enabled,b.archived,b.auto_advance FROM board_tasks bt JOIN task_boards b ON b.id=bt.board_id WHERE bt.task_id=?",
    tid,
  );
const cols = (bid) =>
  all(
    "SELECT * FROM board_columns WHERE board_id=? AND retired=0 ORDER BY position",
    bid,
  );
const currentRuns = (t) =>
  all(
    "SELECT r.*,j.status,j.conversation_id,j.output_message_id FROM workflow_runs r JOIN jobs j ON j.id=r.job_id WHERE r.task_id=? AND r.column_id=? AND r.revision=? ORDER BY r.created",
    t.task_id,
    t.column_id,
    t.revision,
  );
function history(t, action, summary) {
  run(
    "INSERT INTO workflow_history VALUES(?,?,?,?,?,?,?,?)",
    id(),
    t.company_id,
    t.task_id,
    t.column_id,
    t.revision,
    action,
    summary,
    now(),
  );
}
// A ticket that has moved on - a new attempt, an edit, a changed stage - is
// no longer waiting on the "Ticket blocked" message its duck left. Left
// pending, that message stayed on Needs you and kept a "Needs you" tag on the
// duck's chat long after the ticket was running again.
export function movedOn(tid) {
  run(
    "UPDATE inbox SET state='replied' WHERE state='pending' AND message_id IN (SELECT m.id FROM jobs j JOIN messages m ON m.id=j.output_message_id WHERE j.task_id=? AND m.needs_you LIKE 'Ticket blocked: %')",
    tid,
  );
  // Nor on a connection its duck was stopped at: that line in Needs you took
  // the place of the ticket's own, which by now says something else. A new
  // attempt that is stopped again asks again.
  run(
    "UPDATE connection_blocks SET status='dismissed',updated=? WHERE place=? AND status='waiting'",
    now(),
    "ticket:" + tid,
  );
}
function state(t, value, error = "") {
  const old = one(
    "SELECT state,error FROM board_tasks WHERE task_id=?",
    t.task_id,
  );
  if (old?.state === value && old?.error === error) return;
  run(
    "UPDATE board_tasks SET state=?,error=?,updated=? WHERE task_id=?",
    value,
    error,
    now(),
    t.task_id,
  );
  emit(t.company_id);
}
export function ensureBoards(company, user) {
  let board = one(
    "SELECT * FROM task_boards WHERE company_id=? AND legacy=1",
    company,
  );
  if (!board) {
    const bid = id();
    run(
      "INSERT INTO task_boards(id,company_id,name,description,auto_advance,enabled,legacy,creator_id,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?)",
      bid,
      company,
      "General",
      "Your original task board.",
      0,
      0,
      1,
      user ||
        one(
          "SELECT user_id FROM memberships WHERE company_id=? ORDER BY rowid LIMIT 1",
          company,
        )?.user_id,
      now(),
      now(),
    );
    for (const [position, name] of [
      "Open tasks",
      "Being worked on",
      "Done",
    ].entries())
      run(
        "INSERT INTO board_columns(id,company_id,board_id,name,position) VALUES(?,?,?,?,?)",
        id(),
        company,
        bid,
        name,
        position,
      );
    board = tenant("task_boards", bid, company);
  }
  const columns = cols(board.id);
  for (const t of all(
    "SELECT * FROM tasks WHERE company_id=? AND id NOT IN (SELECT task_id FROM board_tasks)",
    company,
  )) {
    run(
      "INSERT INTO board_tasks(task_id,company_id,board_id,column_id,state,runner_id,updated) VALUES(?,?,?,?,?,?,?)",
      t.id,
      company,
      board.id,
      columns[t.status === "done" ? 2 : t.status === "working" ? 1 : 0].id,
      t.status === "done" ? "complete" : "ready",
      t.creator_id || user || board.creator_id,
      now(),
    );
  }
  // The original task API keeps working; mirror its three states into General.
  for (const t of all(
    "SELECT t.id,t.status,bt.column_id FROM tasks t JOIN board_tasks bt ON bt.task_id=t.id WHERE bt.board_id=?",
    board.id,
  )) {
    const col =
      columns[t.status === "done" ? 2 : t.status === "working" ? 1 : 0];
    if (col.id !== t.column_id)
      run(
        "UPDATE board_tasks SET column_id=?,state=?,updated=? WHERE task_id=?",
        col.id,
        t.status === "done" ? "complete" : "ready",
        now(),
        t.id,
      );
  }
  return board;
}
export function workflowSummary(company, user) {
  ensureBoards(company, user);
  return {
    boards: all(
      "SELECT * FROM task_boards WHERE company_id=? ORDER BY legacy DESC,created",
      company,
    ).map((b) => ({ ...b, base: boardDigest(company, b.id) })),
    columns: all(
      "SELECT * FROM board_columns WHERE company_id=? AND retired=0 ORDER BY position",
      company,
    ).map((c) => ({
      ...c,
      approvers: json(c.approvers),
      wait_for_ducks: json(c.wait_for_ducks),
    })),
    // Not SELECT *. A stage's write-up can run to twenty thousand characters,
    // and this payload is fetched again every time a duck reports progress --
    // about once a second while one is writing. The board shows none of it;
    // the ticket page asks for the rest when somebody opens it.
    tickets: all(
      "SELECT bt.task_id,bt.company_id,bt.board_id,bt.column_id,bt.revision,bt.state,bt.runner_id," +
        "substr(worker_result,1,240) worker_result," +
        "length(worker_result)>240 worker_result_clipped," +
        "bt.error,bt.updated,bt.last_checked,tc.completed_at FROM board_tasks bt LEFT JOIN task_completion tc ON tc.task_id=bt.task_id AND tc.company_id=bt.company_id WHERE bt.company_id=?",
      company,
    ),
    // The newest runs of each ticket, rather than the newest runs in the whole
    // company. A single busy board used to push every other ticket's runs out of
    // one shared window of five hundred, and a ticket whose runs had fallen out
    // showed none of its work and reported itself as idle while it was running.
    runs: all(
      "SELECT task_id,column_id,revision,duck_id,role,job_id,decision,result,created,status,conversation_id,output_message_id FROM (SELECT r.*,j.status,j.conversation_id,j.output_message_id,ROW_NUMBER() OVER (PARTITION BY r.task_id ORDER BY r.created DESC) rank FROM workflow_runs r JOIN jobs j ON j.id=r.job_id WHERE r.company_id=?) WHERE rank<=20",
      company,
    ),
  };
}
// A board as the editor sees it. Chief proposals compare against this snapshot.
// The board's settings as one value, so an editor can say which version it was
// looking at. Shared with the proposal path so the two always agree.
export const boardDigest = (company, bid) =>
  crypto
    .createHash("sha256")
    .update(JSON.stringify(boardSnapshot(company, bid)))
    .digest("hex");
export function boardSnapshot(company, bid) {
  const b = tenant("task_boards", bid, company);
  return {
    id: b.id,
    name: b.name,
    description: b.description,
    enabled: !!b.enabled,
    auto_advance: !!b.auto_advance,
    legacy: !!b.legacy,
    columns: cols(bid).map((c) => ({
      id: c.id,
      name: c.name,
      duck_id: c.duck_id,
      instructions: c.instructions,
      approvers: json(c.approvers),
      wait_for_ducks: json(c.wait_for_ducks),
      review_in_order: !!c.review_in_order,
    })),
  };
}
// Validates a board configuration without saving it. Active work is checked when it is saved.
export function checkBoard(company, body, bid = null) {
  const a = boardSchema.parse(body),
    old = bid ? tenant("task_boards", bid, company) : null;
  if (old?.legacy)
    fail(
      409,
      "General keeps its original three columns. Create a workflow board for custom stages.",
    );
  if (old?.archived)
    fail(
      409,
      "“" +
        old.name +
        "” is archived. Bring it back from Archived boards before changing it.",
    );
  if (
    !old &&
    one(
      "SELECT count(*) n FROM task_boards WHERE company_id=? AND archived=0",
      company,
    ).n >= 20
  )
    fail(
      409,
      "This company can have up to 20 boards in use. Archive one to make room.",
    );
  if (
    new Set(a.columns.map((c) => c.name.toLowerCase())).size !==
    a.columns.length
  )
    fail(400, "Give each step a different name.");
  const existing = old ? cols(bid) : [];
  for (const c of a.columns) {
    const saved = existing.find((x) => x.id === c.id);
    if (c.id && !saved) fail(400, "A column does not belong to this board.");
    // A duck taken off the team after the board was set up may stay where it
    // already is, so the rest of the board can still be changed. It is never
    // given a new place.
    const place = (d, already) =>
      already ? tenant("ducks", d, company) : onTeam(d, company);
    if (c.duck_id) place(c.duck_id, saved?.duck_id === c.duck_id);
    for (const d of c.approvers)
      place(d, !!saved && json(saved.approvers).includes(d));
    for (const d of c.wait_for_ducks)
      place(d, !!saved && json(saved.wait_for_ducks).includes(d));
    if (
      new Set(c.approvers).size !== c.approvers.length ||
      new Set(c.wait_for_ducks).size !== c.wait_for_ducks.length
    )
      fail(400, "Select each duck once.");
    if (c.duck_id && c.approvers.includes(c.duck_id))
      fail(
        400,
        "A working duck cannot approve its own work in the same column.",
      );
  }
  if (
    new Set(a.columns.filter((c) => c.id).map((c) => c.id)).size !==
    a.columns.filter((c) => c.id).length
  )
    fail(400, "A column appears twice.");
  // Finished tickets do not count. They cannot be moved anywhere - tickets only
  // ever move one column to the right, and there is nothing to the right of the
  // last one - so counting them made the last column impossible to remove once
  // a single ticket had reached it, with an instruction nobody could follow.
  // They are re-homed onto the new last column when the board is saved.
  for (const c of existing.filter((c) => !a.columns.some((x) => x.id === c.id)))
    if (
      one(
        "SELECT 1 FROM board_tasks WHERE column_id=? AND state<>'complete'",
        c.id,
      )
    ) {
      // "Move them out" is not something a person can simply do here: a ticket
      // leaves a column by finishing its stage and going one to the right. Say
      // that, and how many are in the way, instead of asking for the impossible.
      const waiting = one(
        "SELECT count(*) n FROM board_tasks WHERE column_id=? AND state<>'complete'",
        c.id,
      ).n;
      fail(
        409,
        "“" +
          c.name +
          "” still has " +
          waiting +
          (waiting === 1 ? " ticket in it" : " tickets in it") +
          ". A ticket leaves a step by finishing it and moving on, so finish " +
          (waiting === 1 ? "it" : "them") +
          " first.",
      );
    }
  return { a, old, existing };
}
// While the company is paused nothing queued starts, and a queued stage run
// carries the instructions and brief it was queued with. Somebody who paused
// in order to fix a stage was refused every edit behind that run ("Wait for
// this board's active ducks to finish"), and resuming then ran it with the old
// instructions - so the only way to change the stage was to let it run wrong.
// Paused, a queued run that an edit makes out of date is withdrawn instead;
// the stage starts again with what was saved when the company resumes. Work
// that is running or waiting on a person still refuses.
const paused = (company) =>
  !!one("SELECT paused FROM companies WHERE id=?", company)?.paused;
function withdrawQueued(taskIds) {
  for (const tid of taskIds)
    run(
      "UPDATE jobs SET status='cancelled',updated=? WHERE task_id=? AND status='queued'",
      now(),
      tid,
    );
}
export function saveBoard(company, user, body, bid = null) {
  // An editor that has been open a while holds the board as it was when it
  // opened, and it sends every column back. Without this, the later save
  // quietly retired a teammate's new column - checkBoard only refuses to drop a
  // column with unfinished tickets in it, and a column somebody has just made
  // is necessarily empty - and put their rewritten stage instructions back. And
  // because putting a value back counts as changing it, every unfinished ticket
  // in the columns it touched was reset to the start of its stage, throwing
  // away the write-up the duck had already finished and every approval
  // collected on it. Chief's proposals have been refused for exactly this since
  // the day they were written; the door a person walks through had nothing. The
  // check is only made when the editor sends the version it loaded.
  if (bid && body?.base && body.base !== boardDigest(company, bid))
    fail(
      409,
      "Someone changed this board while you had it open. Reopen it to load the latest version before saving.",
    );
  const { a, old, existing } = checkBoard(company, body, bid);
  if (old && paused(company))
    withdrawQueued(
      all(
        "SELECT task_id FROM board_tasks WHERE column_id IN (SELECT value FROM json_each(?)) AND state<>'complete'",
        JSON.stringify(
          a.columns
            .filter((c) => {
              const prev = existing.find((x) => x.id === c.id);
              return (
                prev &&
                (prev.duck_id !== c.duck_id ||
                  prev.instructions !== c.instructions ||
                  prev.approvers !== JSON.stringify(c.approvers))
              );
            })
            .map((c) => c.id),
        ),
      ).map((t) => t.task_id),
    );
  if (
    old &&
    one(
      "SELECT 1 FROM jobs j JOIN board_tasks bt ON bt.task_id=j.task_id WHERE bt.board_id=? AND j.status IN ('queued','running','waiting_human','waiting_consultation') AND NOT (j.status='queued' AND ?)",
      bid,
      +paused(company),
    )
  )
    fail(
      409,
      "Wait for this board’s active ducks to finish before changing it.",
    );
  const boardId = bid || id();
  db.transaction(() => {
    if (old)
      run(
        "UPDATE task_boards SET name=?,description=?,auto_advance=?,enabled=?,updated=? WHERE id=?",
        a.name,
        a.description,
        +a.auto_advance,
        +a.enabled,
        now(),
        bid,
      );
    else
      run(
        "INSERT INTO task_boards(id,company_id,name,description,auto_advance,enabled,legacy,creator_id,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?)",
        boardId,
        company,
        a.name,
        a.description,
        +a.auto_advance,
        +a.enabled,
        0,
        user,
        now(),
        now(),
      );
    run("UPDATE board_columns SET retired=1 WHERE board_id=?", boardId);
    a.columns.forEach((c, position) => {
      const cid = c.id || id();
      run(
        "INSERT INTO board_columns VALUES(?,?,?,?,?,?,?,?,?,?,0) ON CONFLICT(id) DO UPDATE SET name=excluded.name,position=excluded.position,duck_id=excluded.duck_id,instructions=excluded.instructions,approvers=excluded.approvers,wait_for_ducks=excluded.wait_for_ducks,review_in_order=excluded.review_in_order,retired=0",
        cid,
        company,
        boardId,
        c.name,
        position,
        c.duck_id,
        c.instructions,
        JSON.stringify(c.approvers),
        JSON.stringify(c.wait_for_ducks),
        +c.review_in_order,
      );
      const prev = existing.find((x) => x.id === cid);
      const changed =
        prev &&
        (prev.duck_id !== c.duck_id ||
          prev.instructions !== c.instructions ||
          prev.approvers !== JSON.stringify(c.approvers));
      if (changed)
        for (const t of all(
          "SELECT * FROM board_tasks WHERE column_id=? AND state<>'complete'",
          cid,
        )) {
          history(
            t,
            "Workflow changed",
            "Stage instructions or approvers changed; previous approvals retired.",
          );
          run(
            "UPDATE board_tasks SET revision=revision+1,state='ready',worker_result='',worker_details='',error='',updated=? WHERE task_id=?",
            now(),
            t.task_id,
          );
          movedOn(t.task_id);
        }
      run(
        "UPDATE tasks SET assignee_id=? WHERE id IN (SELECT task_id FROM board_tasks WHERE column_id=? AND state<>'complete')",
        c.duck_id,
        cid,
      );
    });
    // Finished tickets whose column has just been removed would otherwise point
    // at a column that is no longer on the board and disappear from it. They
    // come to rest on the new last column, which is where finished work lives.
    const last = one(
      "SELECT id FROM board_columns WHERE board_id=? AND retired=0 ORDER BY position DESC LIMIT 1",
      boardId,
    );
    if (last)
      run(
        "UPDATE board_tasks SET column_id=?,updated=? WHERE board_id=? AND column_id IN (SELECT id FROM board_columns WHERE board_id=? AND retired=1)",
        last.id,
        now(),
        boardId,
        boardId,
      );
  })();
  audit(company, user, old ? "Workflow updated" : "Workflow created", a.name);
  emit(company);
  return { id: boardId };
}
export function createBoardTask(company, user, bid, body) {
  const board = tenant("task_boards", bid, company),
    a = z
      .object({
        title: z.string().trim().min(1).max(200),
        description: z.string().max(60000).default(""),
        priority: z.enum(["low", "normal", "high"]).default("normal"),
        assignee_id: uuid.nullable().default(null),
      })
      .parse(body),
    first = cols(bid)[0],
    tid = id();
  if (a.assignee_id) onTeam(a.assignee_id, company);
  db.transaction(() => {
    run(
      "INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?,?,?,?)",
      tid,
      company,
      a.title,
      a.description,
      board.legacy ? a.assignee_id : first.duck_id,
      "open",
      a.priority,
      user,
      "",
      now(),
      now(),
    );
    run(
      "INSERT INTO board_tasks(task_id,company_id,board_id,column_id,runner_id,updated) VALUES(?,?,?,?,?,?)",
      tid,
      company,
      bid,
      first.id,
      user,
      now(),
    );
    history(workflowTask(tid), "Created", "Ticket entered " + first.name + ".");
  })();
  audit(company, user, "Workflow ticket created", a.title);
  emit(company);
  return { id: tid };
}
export function assertLegacyTask(tid) {
  if (workflowTask(tid)?.legacy === 0)
    fail(
      409,
      "This ticket follows a workflow. Use its board controls so work and approval checks are preserved.",
    );
}
export function workflowFinish(job, { outcome, summary, details = "" }) {
  if (hasPendingTicketReply(job.task_id))
    fail(
      409,
      "A new human reply is arriving. Read the latest ticket update and incorporate it before finishing this stage.",
    );
  const a = z
    .object({
      outcome: z.enum(["done", "approved", "changes_requested", "blocked"]),
      summary: z.string().trim().min(1).max(2000),
      details: z.string().trim().max(20000),
    })
    .parse({ outcome, summary, details: details ?? "" });
  const r = one("SELECT * FROM workflow_runs WHERE job_id=?", job.id),
    t = r && workflowTask(r.task_id);
  if (
    !r ||
    !t ||
    r.company_id !== job.company_id ||
    r.duck_id !== job.duck_id ||
    r.column_id !== t.column_id ||
    r.revision !== t.revision
  )
    fail(409, "This run is not assigned to the ticket’s current stage.");
  if (one("SELECT status FROM jobs WHERE id=?", job.id)?.status !== "running")
    fail(409, "This run is no longer active.");
  if (r.role === "worker" && !["done", "blocked"].includes(a.outcome))
    fail(400, "Working ducks finish with done or blocked.");
  if (
    r.role === "reviewer" &&
    !["approved", "changes_requested", "blocked"].includes(a.outcome)
  )
    fail(400, "Reviewers approve, request changes, or report a blocker.");
  if (
    r.role === "reviewer" &&
    a.outcome === "approved" &&
    r.fingerprint !== fingerprint(t)
  )
    fail(
      409,
      "The ticket or its documents changed during review. Report blocked and request a new attempt.",
    );
  run(
    "UPDATE workflow_runs SET decision=?,result=?,details=? WHERE id=?",
    a.outcome,
    a.summary,
    a.details,
    r.id,
  );
  // A blocked stage needs a person; its reply goes to Needs you with the plain summary.
  if (a.outcome === "blocked")
    run(
      "UPDATE jobs SET needs_you=? WHERE id=?",
      "Ticket blocked: " +
        a.summary.replace(/^blocked[:.\s-]*/i, "").slice(0, 280),
      job.id,
    );
  else
    run(
      "UPDATE jobs SET needs_you=NULL WHERE id=? AND needs_you LIKE 'Ticket blocked: %'",
      job.id,
    );
  emit(job.company_id);
  return {
    saved: true,
    outcome: a.outcome,
    message:
      "The workflow will apply this decision after your run finishes successfully. Do not move the ticket yourself.",
  };
}
function gate(t) {
  const c = tenant("board_columns", t.column_id, t.company_id),
    runs = currentRuns(t),
    worker = runs.find((r) => r.role === "worker");
  // Finished means the duck said so and its run is over, not that the run also
  // ended tidily. A run that recorded its decision and then hit the time limit
  // had done the work; demanding a clean ending as well left the stage stuck
  // behind a duck that had finished it.
  const workDone =
    worker &&
    worker.decision === "done" &&
    !activeStates.includes(worker.status) &&
    worker.status !== "cancelled";
  if (c.duck_id && !workDone)
    return "The assigned duck must finish its work first.";
  if (!c.duck_id && !t.worker_result)
    return "Mark this stage’s work complete first.";
  // The same for an approval: recorded, and the run over. It used to demand a
  // clean ending here too, so an approver whose run was cut off by a restart
  // or the time limit after it had approved left the ticket blocked, and the
  // only way on was to do the whole stage again.
  for (const d of json(c.approvers)) {
    const r = runs.find((r) => r.role === "reviewer" && r.duck_id === d);
    if (!(
      r &&
      r.decision === "approved" &&
      !activeStates.includes(r.status) &&
      r.status !== "cancelled" &&
      r.fingerprint === fingerprint(t)
    ))
      return "All required ducks must approve this version before it moves.";
  }
  return null;
}
// A note can go with a move from the ticket page. It is written into the
// history rather than posted as a comment: a comment on a duck's stage is a
// reply, and the reply check could start that stage again at the very moment
// it is being moved on. From the history the next stage's duck reads it with
// the other handoffs, and the feed shows it.
export function moveWorkflowTask(company, user, tid, to, note = "") {
  const t = workflowTask(tid);
  if (!t || t.company_id !== company) fail(404, "Ticket not found.");
  const columns = cols(t.board_id),
    index = columns.findIndex((c) => c.id === t.column_id),
    target = columns.find((c) => c.id === to);
  if (!target) fail(400, "Choose a column on the same board.");
  if (target.id === t.column_id) return { ok: true };
  if (t.legacy) {
    run(
      "UPDATE tasks SET status=?,updated=? WHERE id=?",
      ["open", "working", "done"][target.position],
      now(),
      tid,
    );
    ensureBoards(company, user);
    emit(company);
    return { ok: true };
  }
  if (target.position !== index + 1)
    fail(
      409,
      "Tickets move one column to the right. Finish the current stage first.",
    );
  const why = gate(t);
  if (why) fail(409, why);
  if (currentRuns(t).some((r) => activeStates.includes(r.status)))
    fail(409, "Wait for this ticket’s ducks to finish.");
  const said = String(note ?? "").trim()
    ? z.string().trim().max(20000).parse(note)
    : "";
  db.transaction(() => {
    if (said) history(t, "Note", said);
    history(
      t,
      "Moved",
      columns[index].name + " → " + target.name + "\n" + t.worker_result,
    );
    run(
      "UPDATE board_tasks SET column_id=?,revision=revision+1,state='ready',worker_result='',worker_details='',error='',updated=? WHERE task_id=?",
      target.id,
      now(),
      tid,
    );
    movedOn(tid);
    run(
      "UPDATE tasks SET assignee_id=?,status='working',updated=? WHERE id=?",
      target.duck_id,
      now(),
      tid,
    );
  })();
  emit(company);
  return { ok: true };
}
export function updateBoardDisplay(company, user, bid, body) {
  const board = tenant("task_boards", bid, company);
  const a = displaySettingsSchema.parse(body);
  run(
    "UPDATE task_boards SET sort_order=?,hide_done_after_days=?,updated=? WHERE id=?",
    a.sort_order,
    a.hide_done_after_days,
    now(),
    board.id,
  );
  audit(company, user, "Board display settings updated", {
    board: board.name,
    sort_order: a.sort_order,
    hide_done_after_days: a.hide_done_after_days,
  });
  emit(company);
  return a;
}
// Sends a ticket back to an earlier step, with what needs changing. It is its
// own action rather than a looser move: the move is what drag and drop and a
// duck's tool use, and neither should ever send work backwards. The write is
// the forward move's own, so the stage it returns to starts again - a duck's
// stage reads the note with the other handoffs, and a person's step waits for
// its person.
export function sendBackWorkflowTask(company, tid, to, note) {
  const t = workflowTask(tid);
  if (!t || t.company_id !== company) fail(404, "Ticket not found.");
  if (t.legacy) fail(409, "General tickets have no steps to send back to.");
  const columns = cols(t.board_id),
    from = columns.find((c) => c.id === t.column_id),
    target = columns.find((c) => c.id === to);
  if (!target) fail(400, "Choose a column on the same board.");
  if (!from || target.position >= from.position)
    fail(409, "A ticket can only be sent back to an earlier step.");
  if (t.state === "complete")
    fail(
      409,
      "This ticket is finished. Edit it to start it again from the first step.",
    );
  if (currentRuns(t).some((r) => activeStates.includes(r.status)))
    fail(409, "Wait for this ticket’s ducks to finish.");
  const said = z
    .string()
    .trim()
    .min(
      1,
      "Say what needs changing, so the step it goes back to knows what to do.",
    )
    .max(20000)
    .parse(note ?? "");
  db.transaction(() => {
    history(t, "Sent back", from.name + " → " + target.name + "\n" + said);
    run(
      "UPDATE board_tasks SET column_id=?,revision=revision+1,state='ready',worker_result='',worker_details='',error='',updated=? WHERE task_id=?",
      target.id,
      now(),
      tid,
    );
    movedOn(tid);
    run(
      "UPDATE tasks SET assignee_id=?,status='working',updated=? WHERE id=?",
      target.duck_id,
      now(),
      tid,
    );
  })();
  emit(company);
  return { ok: true };
}
// Who did each stage of a ticket, what it made, and how the ticket came to the
// stage it is on. The workspace payload carries only a ticket's newest runs and
// clipped handoffs, and the feed is paged, so neither can say it reliably.
export function ticketStages(company, tid) {
  const t = workflowTask(tid);
  if (!t || t.company_id !== company) fail(404, "Ticket not found.");
  if (t.legacy) return { stages: [], arrived: null };
  const columns = cols(t.board_id);
  // Whoever wrote a history row is on the feed entry made from it: the
  // person, or the duck that used a tool. The engine's own moves have nobody.
  const actor = (hid) => {
    const a = one(
      "SELECT a.user_id,a.duck_id,d.name duck_name,u.name user_name FROM ticket_activity a LEFT JOIN ducks d ON d.id=a.duck_id LEFT JOIN users u ON u.id=a.user_id WHERE a.source_key=?",
      "history:" + hid,
    );
    return a?.user_id || a?.duck_id
      ? {
          duck_id: a.duck_id,
          user_id: a.user_id,
          name: a.duck_name || a.user_name,
        }
      : null;
  };
  const stages = columns.map((c) => {
    const duck = one(
      "SELECT r.duck_id,r.result,r.details,r.job_id,j.updated finished,d.name FROM workflow_runs r JOIN jobs j ON j.id=r.job_id JOIN ducks d ON d.id=r.duck_id WHERE r.task_id=? AND r.column_id=? AND r.role='worker' AND r.decision='done' ORDER BY r.created DESC,r.rowid DESC LIMIT 1",
      tid,
      c.id,
    );
    const human = one(
      "SELECT id,summary,created FROM workflow_history WHERE task_id=? AND column_id=? AND action='Human completed work' ORDER BY created DESC,rowid DESC LIMIT 1",
      tid,
      c.id,
    );
    // A stage whose duck was changed can have both. The later one counts.
    if (human && (!duck || human.created > duck.finished))
      return {
        column_id: c.id,
        by: actor(human.id) || { duck_id: null, user_id: null, name: null },
        summary: human.summary,
        details: "",
        finished: human.created,
        documents: [],
      };
    if (!duck)
      return {
        column_id: c.id,
        by: null,
        summary: "",
        details: "",
        finished: null,
        documents: [],
      };
    return {
      column_id: c.id,
      by: { duck_id: duck.duck_id, user_id: null, name: duck.name },
      summary: duck.result,
      details: duck.details || "",
      finished: duck.finished,
      documents: all(
        "SELECT DISTINCT d.id,d.title,d.updated FROM jobs j JOIN message_artifacts a ON a.message_id=j.output_message_id AND a.kind='document' AND a.verb IN ('Created','Updated') JOIN documents d ON d.id=a.reference_id AND d.company_id=j.company_id WHERE j.id=? ORDER BY d.updated DESC",
        duck.job_id,
      ),
    };
  });
  // The last move says where it came from, but only if it came here: an edit
  // that reopened the ticket at the first step, or a stage renamed since,
  // would otherwise name a move that is not how it got where it is.
  const last = one(
    "SELECT id,action,summary,created FROM workflow_history WHERE task_id=? AND action IN ('Moved','Sent back') ORDER BY created DESC,rowid DESC LIMIT 1",
    tid,
  );
  const here = " → " + columns.find((c) => c.id === t.column_id)?.name;
  const [line, ...rest] = (last?.summary || "").split("\n");
  const arrived =
    last && line.endsWith(here)
      ? {
          from: line.slice(0, -here.length),
          sent_back: last.action === "Sent back",
          at: last.created,
          by: actor(last.id),
          note: last.action === "Sent back" ? rest.join("\n") : "",
        }
      : null;
  return { stages, arrived };
}
export function editWorkflowTask(company, user, tid, body) {
  const task = tenant("tasks", tid, company),
    t = workflowTask(tid);
  if (!t || t.legacy) fail(409, "Use the General task editor.");
  if (paused(company)) withdrawQueued([tid]);
  if (currentRuns(t).some((r) => activeStates.includes(r.status)))
    fail(
      409,
      "Wait for the active work or review to finish before editing this ticket.",
    );
  // Two people with the same ticket open both press Save. The General editor
  // has refused the second one for a while; this one took it, so whoever
  // saved first had their work replaced without either of them being told.
  // Only checked when the editor sends what it loaded, so a duck changing one
  // field is unaffected.
  const { updated: loaded, opened, ...fields } = body || {};
  if (editedSinceOpened(task, { updated: loaded, opened }))
    fail(
      409,
      "Someone else changed this ticket while you had it open, so nothing was saved. Your changes are still in the editor.",
    );
  const a = z
    .object({
      title: z.string().trim().min(1).max(200),
      description: z.string().max(60000),
      priority: z.enum(["low", "normal", "high"]),
    })
    .parse({ ...task, ...fields });
  // Whether this edit started a new version, so whoever asked for it is told.
  // A duck could otherwise report that it had changed a priority while it had
  // in fact reopened a finished ticket at the first column.
  let reopened = false;
  db.transaction(() => {
    run(
      "UPDATE tasks SET title=?,description=?,priority=?,updated=? WHERE id=?",
      a.title,
      a.description,
      a.priority,
      now(),
      tid,
    );
    if (a.title !== task.title || a.description !== task.description) {
      reopened = true;
      history(
        t,
        "Ticket edited",
        "New ticket version; previous work and approvals remain in history.",
      );
      if (t.state === "complete") {
        const first = cols(t.board_id)[0];
        run(
          "UPDATE board_tasks SET column_id=? WHERE task_id=?",
          first.id,
          tid,
        );
        run(
          "UPDATE tasks SET status='open',assignee_id=? WHERE id=?",
          first.duck_id,
          tid,
        );
      }
      run(
        "UPDATE board_tasks SET revision=revision+1,state='ready',worker_result='',worker_details='',error='',updated=? WHERE task_id=?",
        now(),
        tid,
      );
      movedOn(tid);
    }
  })();
  emit(company);
  return { ok: true, new_version: reopened };
}
export function registerWorkflows(app, { aiStatus, enqueue }) {
  app.get("/api/boards", (req, res) =>
    res.json(workflowSummary(req.company.id, req.user.id)),
  );
  app.post("/api/boards", (req, res) =>
    withTicketActor(req.company.id, { user_id: req.user.id }, () => {
      can(req.member, "tasks");
      res.json(saveBoard(req.company.id, req.user.id, req.body));
    }),
  );
  app.put("/api/boards/:id", (req, res) =>
    withTicketActor(req.company.id, { user_id: req.user.id }, () => {
      can(req.member, "tasks");
      res.json(saveBoard(req.company.id, req.user.id, req.body, req.params.id));
    }),
  );
  app.patch("/api/boards/:id/display", (req, res) => {
    can(req.member, "tasks");
    res.json(updateBoardDisplay(req.company.id, req.user.id, req.params.id, req.body));
  });
  app.post("/api/boards/:id/tasks", (req, res) =>
    withTicketActor(req.company.id, { user_id: req.user.id }, () => {
      can(req.member, "tasks");
      res.json(
        createBoardTask(req.company.id, req.user.id, req.params.id, req.body),
      );
    }),
  );
  // A stage's write-up in full, which the workspace payload leaves out.
  app.get("/api/workflow/tasks/:id", (req, res) => {
    // Readable by anyone in the company, like the summary it completes.
    const t = workflowTask(req.params.id);
    if (!t || t.company_id !== req.company.id) fail(404, "Ticket not found.");
    res.json(t);
  });
  app.patch("/api/workflow/tasks/:id", (req, res) =>
    withTicketActor(req.company.id, { user_id: req.user.id }, () => {
      can(req.member, "tasks");
      res.json(
        editWorkflowTask(req.company.id, req.user.id, req.params.id, req.body),
      );
    }),
  );
  // Who did each stage and what it made, for the ticket's page. Readable by
  // anyone in the company, like the ticket itself.
  app.get("/api/workflow/tasks/:id/stages", (req, res) =>
    res.json(ticketStages(req.company.id, req.params.id)),
  );
  app.post("/api/workflow/tasks/:id/move", (req, res) =>
    withTicketActor(req.company.id, { user_id: req.user.id }, () => {
      can(req.member, "tasks");
      res.json(
        moveWorkflowTask(
          req.company.id,
          req.user.id,
          req.params.id,
          uuid.parse(req.body.column_id),
          req.body.note,
        ),
      );
    }),
  );
  // No chat permission needed: no run starts in this person's name.
  app.post("/api/workflow/tasks/:id/send-back", (req, res) =>
    withTicketActor(req.company.id, { user_id: req.user.id }, () => {
      can(req.member, "tasks");
      res.json(
        sendBackWorkflowTask(
          req.company.id,
          req.params.id,
          uuid.parse(req.body.column_id),
          req.body.note,
        ),
      );
    }),
  );
  app.post("/api/workflow/tasks/:id/complete", (req, res) =>
    withTicketActor(req.company.id, { user_id: req.user.id }, () => {
      can(req.member, "tasks");
      res.json(
        completeWorkflowTask(
          req.company.id,
          req.params.id,
          req.body.summary,
          req.body.move === true,
        ),
      );
    }),
  );
  app.post("/api/workflow/tasks/:id/retry", async (req, res) => {
    can(req.member, "tasks");
    can(req.member, "chat");
    retryTicket(req.company.id, req.params.id);
    const refused = duckRefusalFor(await aiStatus(req.company.id), req.member);
    if (refused) fail(409, refused);
    withTicketActor(req.company.id, { user_id: req.user.id }, () =>
      retryWorkflowTask(
        req.company.id,
        req.user.id,
        req.params.id,
        req.body.feedback,
      ),
    );
    res.json({ ok: true });
  });
}
// Completes a human-owned stage. Callers set the ticket actor.
export function completeWorkflowTask(company, tid, input, moveOn = false) {
  const t = workflowTask(tid);
  if (!t || t.company_id !== company) fail(404, "Ticket not found.");
  if (t.legacy) fail(409, "Use the General task editor.");
  const c = tenant("board_columns", t.column_id, t.company_id);
  if (c.duck_id) fail(409, "The assigned duck must complete its work.");
  const summary = z.string().trim().min(1).max(20000).parse(input);
  if (currentRuns(t).length || t.worker_result || t.state === "complete")
    fail(
      409,
      "This version is already in review. Request a new attempt to change its work.",
    );
  const needsReview = json(c.approvers).length > 0;
  const complete = !needsReview && c.position === cols(t.board_id).length - 1;
  run(
    "UPDATE board_tasks SET worker_result=?,state=?,error='',updated=? WHERE task_id=?",
    summary,
    complete ? "complete" : needsReview ? "reviewing" : "ready_to_move",
    now(),
    t.task_id,
  );
  run(
    "UPDATE tasks SET result=?,status=?,updated=? WHERE id=?",
    summary,
    complete ? "done" : "working",
    now(),
    t.task_id,
  );
  history(t, "Human completed work", summary);
  // Approve or Finish on the ticket page means "and move it on". It does not
  // wait for the board's own switch, which only decides what happens when
  // nobody is there to say.
  const next = cols(t.board_id)[c.position + 1];
  if (moveOn && !needsReview && !complete && next)
    moveWorkflowTask(company, null, tid, next.id);
  emit(t.company_id);
  return { ok: true };
}
function retryTicket(company, tid) {
  const t = workflowTask(tid);
  if (!t || t.company_id !== company) fail(404, "Ticket not found.");
  if (paused(company)) withdrawQueued([tid]);
  if (currentRuns(t).some((r) => activeStates.includes(r.status)))
    fail(
      409,
      "Wait for the active ducks to finish before starting another attempt.",
    );
  if (t.legacy) fail(409, "Use Ask duck to start on General.");
  return t;
}
// Starts a new attempt run with the given user's AI connection. Callers set the ticket actor.
export function retryWorkflowTask(company, user, tid, feedback) {
  const t = retryTicket(company, tid);
  history(t, "New attempt", z.string().max(4000).default("").parse(feedback));
  run(
    "UPDATE board_tasks SET revision=revision+1,state='ready',runner_id=?,worker_result='',worker_details='',error='',updated=? WHERE task_id=?",
    user,
    now(),
    t.task_id,
  );
  movedOn(t.task_id);
  emit(t.company_id);
  return { ok: true };
}
export async function tickWorkflows({ enqueue, aiStatus }) {
  for (const old of all(
    // Least recently *looked at* first, so the window turns over. Ordering by
    // when a ticket last changed meant the ones that never change - every ticket
    // parked in a human's column - held the whole window for good, and no ticket
    // behind them was ever considered again, in any company on this server.
    "SELECT bt.* FROM board_tasks bt JOIN task_boards b ON b.id=bt.board_id JOIN companies c ON c.id=bt.company_id WHERE b.legacy=0 AND c.paused=0 AND bt.state NOT IN ('complete','blocked','changes_requested') ORDER BY bt.last_checked,bt.updated LIMIT 100",
  )) {
    // Written before any of the work below, so a ticket that throws still moves
    // out of the way of the others rather than blocking the queue behind it.
    run(
      "UPDATE board_tasks SET last_checked=? WHERE task_id=?",
      Date.now(),
      old.task_id,
    );
    if (hasPendingTicketReply(old.task_id)) continue;
    let t = workflowTask(old.task_id);
    const column = tenant("board_columns", t.column_id, t.company_id),
      columns = cols(t.board_id),
      task = tenant("tasks", t.task_id, t.company_id),
      member = memberFor(t.company_id, t.runner_id);
    try {
      if (!member || !permissions(member).tasks || !permissions(member).chat) {
        state(
          t,
          "blocked",
          "The person running this ticket needs chat and task permissions. Choose a new attempt with an authorized account.",
        );
        continue;
      }
      let runs = currentRuns(t);
      // Recovery retains this stage's existing ownership claim. Settling an
      // incomplete stage before its bounded continuation would block it.
      if (
        runs.some((r) =>
          one(
            "SELECT 1 FROM unfinished_work WHERE current_job_id=? AND state IN ('waiting','queued')",
            r.job_id,
          ),
        )
      )
        continue;
      if (
        runs.some(
          (r) =>
            activeStates.includes(r.status) &&
            (r.role === "worker" || column.review_in_order),
        )
      )
        continue;
      if (t.archived) {
        // A finished stage remains recorded even if its board was archived
        // before this tick processed the run. No further stage may start.
        const finishedWorker = runs.find(
          (r) =>
            r.role === "worker" &&
            r.decision === "done" &&
            r.status !== "cancelled",
        );
        if (finishedWorker && !t.worker_result) {
          run(
            "UPDATE board_tasks SET worker_result=?,worker_details=? WHERE task_id=?",
            finishedWorker.result,
            finishedWorker.details || "",
            t.task_id,
          );
          run(
            "UPDATE tasks SET result=?,updated=? WHERE id=?",
            finishedWorker.result,
            now(),
            t.task_id,
          );
          t = workflowTask(t.task_id);
        }
        state(
          t,
          "waiting",
          "This board is archived, so its ducks do not start. Bring it back to carry on.",
        );
        continue;
      }
      // A stage the duck actually finished is finished. It records its
      // decision the moment it calls workflow_finish, and that used to be
      // thrown away if the run itself ended badly afterwards - it hit the
      // thirty-minute ceiling, or the model returned an empty last reply, or
      // the provider failed on the final turn. The ticket was then blocked
      // with "This run ended without finishing the stage" followed by the
      // duck's own successful summary, and the only way on was to redo the
      // whole stage. Long computer work is exactly what runs close to that
      // ceiling and calls workflow_finish at the very end of it. Somebody
      // stopping the run by hand still counts as stopped.
      const failed = runs.find(
        (r) =>
          !activeStates.includes(r.status) &&
          (!r.decision ||
            r.decision === "blocked" ||
            r.decision === "changes_requested" ||
            r.status === "cancelled"),
      );
      if (failed) {
        // failed.result is whatever the duck last reported, which for a run cut
        // short after it had already reported success is a cheerful summary.
        // Showing that as the reason the ticket needs attention told people
        // their finished work was the failure. Only a decision that is itself a
        // refusal speaks for itself; anything else says what actually happened.
        const stopped =
          failed.decision === "blocked" ||
          failed.decision === "changes_requested";
        const reason = stopped
          ? failed.result ||
            "A duck run stopped without a completed stage decision. Review its chat and start a new attempt."
          : (failed.status === "cancelled"
              ? "This run was stopped before the stage finished."
              : failed.status === "interrupted"
                ? "This run was interrupted before the stage finished."
                : "This run ended without finishing the stage.") +
            (failed.result ? " The duck had reported: " + failed.result : "") +
            " Start a new attempt to carry on.";
        state(
          t,
          failed.decision === "changes_requested"
            ? "changes_requested"
            : "blocked",
          reason,
        );
        continue;
      }
      if (
        runs.some(
          (r) =>
            r.role === "reviewer" &&
            r.decision === "approved" &&
            r.fingerprint !== fingerprint(t),
        )
      ) {
        state(
          t,
          "changes_requested",
          "The ticket’s documents changed after review. Start a new attempt so the ducks review the current work.",
        );
        continue;
      }
      const worker = runs.find((r) => r.role === "worker");
      if (worker?.decision === "done" && !t.worker_result) {
        run(
          "UPDATE board_tasks SET worker_result=?,worker_details=? WHERE task_id=?",
          worker.result,
          worker.details || "",
          t.task_id,
        );
        run(
          "UPDATE tasks SET result=?,updated=? WHERE id=?",
          worker.result,
          now(),
          t.task_id,
        );
        t = workflowTask(t.task_id);
      }
      // An empty last column is a destination, not another piece of work.
      if (
        column.position === columns.length - 1 &&
        !column.duck_id &&
        !json(column.approvers).length
      ) {
        state(t, "complete");
        run(
          "UPDATE tasks SET status='done',updated=? WHERE id=?",
          now(),
          t.task_id,
        );
        history(t, "Completed", "Reached " + column.name + ".");
        continue;
      }
      const waiting = json(column.wait_for_ducks).find((d) =>
        one(
          "SELECT 1 FROM jobs WHERE company_id=? AND duck_id=? AND (task_id IS NULL OR task_id<>?) AND status IN ('queued','running','waiting_human','waiting_consultation')",
          t.company_id,
          d,
          t.task_id,
        ),
      );
      if (waiting && !worker && !t.worker_result) {
        state(
          t,
          "waiting",
          "Waiting for " +
            tenant("ducks", waiting, t.company_id).name +
            " to finish other work.",
        );
        continue;
      }
      let duckId = null,
        role = null;
      if (column.duck_id && !worker) {
        duckId = column.duck_id;
        role = "worker";
      } else if (!column.duck_id && !t.worker_result) {
        state(t, "ready");
        continue;
      } else {
        duckId = json(column.approvers).find(
          (d) => !runs.some((r) => r.role === "reviewer" && r.duck_id === d),
        );
        if (duckId) role = "reviewer";
      }
      if (duckId) {
        if (!t.enabled) {
          state(
            t,
            "waiting",
            t.archived
              ? "This board is archived, so its ducks do not start. Bring it back to carry on."
              : "Duck work is paused for this board.",
          );
          continue;
        }
        // The duck this stage is set to has been taken off the team. Say so and
        // wait, the way this stage waits for anything else it cannot start
        // without - except that this one does not resolve on its own, so the
        // sentence says what to do about it.
        const off = one(
          "SELECT name FROM ducks WHERE id=? AND removed=1",
          duckId,
        );
        if (off) {
          state(
            t,
            "waiting",
            off.name +
              " was taken off the team, so this stage has nobody to do it. Put the duck back, or give the stage to another one.",
          );
          continue;
        }
        const ai = await aiStatus(t.company_id);
        if (!ai.connected) {
          // Everybody who opens the ticket reads the same line, so it says
          // what is true for all of them. A connection that has dropped needs
          // nobody to do anything here: the next tick starts the stage once it
          // answers again.
          state(
            t,
            "waiting",
            aiDown(ai)
              ? "Your AI connection isn't working right now. This stage starts on its own once it's back."
              : "Connect an AI provider in Settings to start this stage.",
          );
          continue;
        }
        const fresh = workflowTask(t.task_id),
          latestMember = memberFor(t.company_id, t.runner_id);
        if (
          !fresh?.enabled ||
          fresh.revision !== t.revision ||
          fresh.column_id !== t.column_id ||
          !latestMember ||
          !permissions(latestMember).tasks ||
          !permissions(latestMember).chat ||
          one("SELECT paused FROM companies WHERE id=?", t.company_id)?.paused
        )
          continue;
        // A board stage is ticket work, so it runs in the ticket's own
        // conversation - the same one a plain ticket uses. It used to open a
        // direct chat with whoever set the board going and write the stage
        // prompt there as that person, which turned every board into private
        // messages they had never written.
        const duck = tenant("ducks", duckId, t.company_id),
          conv = ticketConversation(t.company_id, task, duck);
        const context = all(
          "SELECT action,summary FROM workflow_history WHERE task_id=? ORDER BY created DESC LIMIT 8",
          t.task_id,
        ).reverse();
        // The run context already includes shared ticket activity for this task.
        const prompt = `Workflow ticket: ${task.title}\nBoard: ${tenant("task_boards", t.board_id, t.company_id).name}\nStage: ${column.name}\nTask ID: ${t.task_id}\nVersion: ${t.revision}\n\nBrief:\n${task.description}\n\nStage instructions:\n${column.instructions || "Complete the work described by this stage and the ticket brief."}\n\nPrevious handoffs and feedback:\n${JSON.stringify(context).slice(-20000)}\n\nTask documents (read their current contents before reviewing):\n${JSON.stringify(documentRefs(t).map(({ id, title }) => ({ id, title })))}\n\nSaved result:\n${t.worker_result || task.result || "None yet."}${t.worker_details ? "\n\nDetails from the working duck:\n" + t.worker_details : ""}\n\n${role === "worker" ? "You are the working duck. Do this stage only, then call workflow_finish with outcome done. Save a document only when there is something worth keeping and re-reading; a result that fits in your summary belongs there instead. If blocked, use outcome blocked." : "You are an independent approver. Inspect the completed work and referenced documents. Call workflow_finish with approved, changes_requested, or blocked. Do not change the work you are reviewing."}\nworkflow_finish summary is what people read on the ticket: one to three short sentences in plain words, with no IDs or jargon (for example: \"Wrote the first draft of the article. Ready for review.\" or \"Blocked: I have no access to the website's CMS. Please give me access.\"). Put anything technical the next duck needs in details. Documents you save are linked to this ticket automatically, so do not list document IDs.\nDo not move the ticket or delegate it. The workflow enforces required approvals and moves it after successful completion.`;
        db.transaction(() => {
          const message = addMessage(t.company_id, conv.id, prompt, {
            user: t.runner_id,
            origin: "workflow",
          });
          const job = enqueue(
            t.company_id,
            t.runner_id,
            conv.id,
            duck.id,
            message,
            { taskId: t.task_id },
          );
          run(
            "INSERT INTO workflow_runs(id,company_id,task_id,column_id,revision,duck_id,role,job_id,decision,result,created,fingerprint) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
            id(),
            t.company_id,
            t.task_id,
            t.column_id,
            t.revision,
            duck.id,
            role,
            job,
            null,
            "",
            now(),
            role === "reviewer" ? fingerprint(t) : "",
          );
          // The stage is waiting for its queued job. beginJobWork promotes it
          // to Working/Reviewing atomically when the worker claims the slot.
          const actualRun = runs.some((r) =>
            ["running", "waiting_human", "waiting_consultation"].includes(r.status),
          );
          state(t, actualRun && ["working", "reviewing"].includes(t.state) ? t.state : "waiting");
        })();
        continue;
      }
      if (currentRuns(t).some((r) => activeStates.includes(r.status))) continue;
      const why = gate(t);
      if (why) {
        state(t, "blocked", why);
        continue;
      }
      if (column.position === columns.length - 1) {
        state(t, "complete");
        run(
          "UPDATE tasks SET status='done',updated=? WHERE id=?",
          now(),
          t.task_id,
        );
        history(t, "Completed", t.worker_result);
      } else if (t.auto_advance)
        moveWorkflowTask(
          t.company_id,
          t.runner_id,
          t.task_id,
          columns[column.position + 1].id,
        );
      else if (t.state !== "ready_to_move") state(t, "ready_to_move");
    } catch (e) {
      // The flock being full right now is not a failure of this ticket. Marking
      // it blocked took it out of the scheduler's own query for good, so it
      // never started even after the queue drained overnight and somebody had to
      // reopen every ticket by hand. Leave it as it is and come back to it.
      if (e.status === 429) continue;
      state(t, "blocked", e.message.slice(0, 2000));
    }
  }
}
// A ticket assigned to a duck starts by itself.
//
// It did not, and the reason was never a decision anybody made about tickets:
// the automatic worker only ever looked at real boards, and the board every
// workspace is handed is the legacy "General" list. So the first ticket
// somebody ever writes sits there until they find a button, which is not what
// the product says it does.
//
// Only tickets durably enrolled since heartbeat rollout. There are open tickets in
// this database from weeks ago, assigned and forgotten, and waking all of
// them at once on a deploy would spend somebody's whole model allowance on
// work nobody is waiting for any more.
//
// Enrollment deliberately excludes the pre-rollout backlog. At most a few
// are started each time round, but every waiting ticket is
// looked at. It used to read the five oldest candidates on the whole server
// and start what it could of those; five that could not start - their writer
// had left, or the company had no AI connected yet - were read again two
// seconds later, and again, and every ticket written after them, in every
// company, waited until the next restart.
//
// Not a ticket somebody stopped: its last run was cancelled by a person, and
// starting it again two seconds later would undo their Stop. And not the
// ticket a schedule opens when its duck says a person is needed: that is the
// duck's request for help, and starting it hands the duck its own request.
const startedPerRound = 5;
export async function startAssignedTickets(deps, since, refused = new Map()) {
  let started = 0;
  const connected = new Map();
  for (const task of all(
    "SELECT t.* FROM tasks t JOIN task_work_enrollment enrollment ON enrollment.task_id=t.id AND enrollment.company_id=t.company_id " +
      "JOIN ducks d ON d.id=t.assignee_id AND d.company_id=t.company_id AND d.removed=0 " +
      "JOIN companies c ON c.id=t.company_id AND c.paused=0 " +
      "WHERE t.status='open' " +
      "AND NOT EXISTS(SELECT 1 FROM jobs j WHERE j.task_id=t.id AND j.status IN ('queued','running','waiting_human','waiting_consultation')) " +
      "AND NOT EXISTS(SELECT 1 FROM board_tasks bt JOIN task_boards b ON b.id=bt.board_id WHERE bt.task_id=t.id AND b.legacy=0) " +
      "AND NOT EXISTS(SELECT 1 FROM schedules sc WHERE sc.incident_task_id=t.id) " +
      "ORDER BY t.created",
  )) {
    if (started >= startedPerRound) break;
    // One that threw is tried again when the ticket changes, not every two
    // seconds until the next restart.
    if (refused.get(task.id) === task.updated) continue;
    const runner = task.creator_id;
    const member = runner && memberFor(task.company_id, runner);
    // Somebody has to be behind the work: the person who wrote the ticket.
    // If they have left, or lost the permission to run ducks, the ticket
    // waits for a person rather than starting in nobody's name.
    if (!member || !permissions(member).tasks || !permissions(member).chat)
      continue;
    if (!connected.has(task.company_id))
      connected.set(
        task.company_id,
        (await deps.aiStatus(task.company_id)).connected,
      );
    if (!connected.get(task.company_id)) continue;
    const duck = tenant("ducks", task.assignee_id, task.company_id);
    try {
      const lineage = one(
        "SELECT * FROM duck_task_lineage WHERE task_id=? AND company_id=?",
        task.id,
        task.company_id,
      );
      if (
        lineage?.created_by_duck_id &&
        lineage.created_by_duck_id !== task.assignee_id
      )
        assertDuckContactAllowed(
          task.company_id,
          lineage.created_by_duck_id,
          task.assignee_id,
        );
      db.transaction(() => {
        if (
          one(
            "SELECT 1 FROM jobs WHERE task_id=? AND status IN ('queued','running','waiting_human','waiting_consultation')",
            task.id,
          )
        )
          return;
        const conv = ticketConversation(task.company_id, task, duck);
        const message = addMessage(
          task.company_id,
          conv.id,
          `Please work on this task: ${task.title}\n\n${task.description}\n\nTask ID: ${task.id}. Update the task when you are done, and ask if you need anything. Save a document only if there is something worth keeping - a short answer belongs in your reply, not in a file nobody asked for.`,
          { user: runner, origin: "workflow" },
        );
        const source = lineage?.created_by_job_id
          ? one(
              "SELECT root_job_id FROM jobs WHERE id=?",
              lineage.created_by_job_id,
            )
          : null;
        deps.enqueue(task.company_id, runner, conv.id, duck.id, message, {
          taskId: task.id,
          parentJobId: lineage?.created_by_job_id || null,
          rootJobId: source?.root_job_id || lineage?.created_by_job_id || null,
        });
        started++;
      })();
    } catch {
      // Left alone until the ticket changes; the person can still press the
      // button and be told why.
      refused.set(task.id, task.updated);
    }
  }
}
export function startWorkflowEngine(deps) {
  let busy = false;
  // Durable enrollment survives restart: see startAssignedTickets.
  const since = now(),
    refused = new Map();
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      if (deps.tickTicketReplies) await deps.tickTicketReplies();
      await tickWorkflows(deps);
      await startAssignedTickets(deps, since, refused);
    } catch (e) {
      console.error("Workflow scheduler:", e.message);
    } finally {
      busy = false;
    }
  }, 2000);
  timer.unref();
  return timer;
}
