// An email when a task on a board has waited an hour for a person.
//
// A board moves on its own while ducks do the steps. Where a step is a
// person's, it stops, and nothing tells anybody: a board task is not in Needs
// you, it sends no email, and the only sign is the ticket sitting in its column
// until somebody happens to open the board. So when a task has waited an hour
// at a step only a person can take, everybody who can work on the boards hears
// about it - once for each wait, with every waiting task on that board in the
// one email.
//
// "Everybody who can work on the boards", because that is who a board step
// waits on. A board has no list of its own people and a person's step names
// nobody: any member with the tasks permission can do it, so they are the
// ones to tell.
//
// And whether or not they have been in the app since. The half-hour reminder
// holds back for somebody who has been in, because Needs you would have shown
// them the thing. A board task is not in Needs you, so being in the app says
// nothing about whether they have seen it.
//
// This reads the board tables and writes none of them. server/workflows.mjs
// owns boards; what this keeps of its own is board_waits: when it first saw
// each wait, and whether that wait has been told about. The table is made by
// server/migrations/0003_board-waits.sql.
import { all, one, db, memberFor, permissions } from "./store.mjs";
import * as notices from "./mail-notices.mjs";

const MINUTE = 60000;
// How long a task waits before anybody is written to about it.
export const BOARD_WAIT = 60 * MINUTE;

const whenOf = (value) => {
  if (!value) return 0;
  const s = String(value);
  return (
    Date.parse(
      /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(s)
        ? s.replace(" ", "T") + "Z"
        : s,
    ) || 0
  );
};

// What a person would have to do for a task to move again, or nothing if no
// person is needed. Three ways a board waits on somebody:
//
//   do      a step with no working duck, not done yet. Not the finish line - a
//           last column with no duck and no approvers completes by itself.
//   move    a step that is done, on a board set not to move tasks on by
//           itself, so somebody has to press "Move to ...".
//   changes a reviewing duck asked for changes, and
//   stuck   a task stopped - both need somebody to start a new attempt.
//
// A duck's own step is never a person's, and a step already done is on its
// way; neither counts.
export function whatItNeeds(t) {
  if (t.state === "ready_to_move") return t.auto_advance ? null : "move";
  if (t.state === "changes_requested") return "changes";
  if (t.state === "blocked") return "stuck";
  if (t.state !== "ready" && t.state !== "waiting") return null;
  if (t.duck_id) return null;
  if (t.worker_result) return null;
  const approvers = (() => {
    try {
      return JSON.parse(t.approvers || "[]");
    } catch {
      return [];
    }
  })();
  if (!t.later && !approvers.length) return null;
  return "do";
}

// Every task on every board that is waiting on a person right now.
//
// The General board is left out: it is the old task list, not a workflow, and
// its tasks wait for somebody to pick them up by design. A board with its duck
// work paused is not: pausing it stops ducks starting, and a person's step on
// it is still a person's step and still waiting. An archived board is out of
// use, so nobody is written to about it.
export function waitingTasks() {
  return all(
    `SELECT bt.task_id,bt.company_id,bt.board_id,bt.column_id,bt.revision,
            bt.state,bt.worker_result,bt.updated,
            b.name board_name,b.auto_advance,
            col.name stage_name,col.duck_id,col.approvers,
            (SELECT count(*) FROM board_columns n
              WHERE n.board_id=bt.board_id AND n.retired=0 AND n.position>col.position) later
       FROM board_tasks bt
       JOIN task_boards b ON b.id=bt.board_id AND b.legacy=0 AND b.archived=0
       JOIN board_columns col ON col.id=bt.column_id AND col.retired=0
      WHERE bt.state IN ('ready','waiting','ready_to_move','changes_requested','blocked')`,
  )
    .map((t) => {
      const need = whatItNeeds(t);
      if (!need) return null;
      // One wait is one task at one step needing one thing. The revision
      // alone is not enough: finishing a step by hand leaves the revision
      // where it was and turns "do this step" into "move it on", which is a
      // new thing to ask for. "changes" and "stuck" are the same ask - start
      // a new attempt - so a task moving from one to the other is not.
      const ask = need === "stuck" ? "changes" : need;
      return { ...t, need, key: `${t.task_id}:${t.revision}:${ask}` };
    })
    .filter(Boolean);
}

// When reminders started. Every wait already there on the first sweep is
// noted with exactly this time, and a wait is only ever due if it was first
// seen after it - so nothing that was waiting before this shipped is written
// about. The first version judged that by the task's own "updated" time, which
// a person's step with watched ducks rewrites every time it flips, so a task
// left waiting for a month before launch was emailed an hour after it.
function liveSince(now) {
  db.prepare(
    "INSERT OR IGNORE INTO email_sent(key,created) VALUES('board-reminders:live-since',?)",
  ).run(new Date(now).toISOString());
  return whenOf(
    one("SELECT created FROM email_sent WHERE key='board-reminders:live-since'")
      ?.created,
  );
}

// Who can act on a waiting task. Doing a step and moving a task need the tasks
// permission; starting a new attempt also needs chat, because the new attempt
// is a run in that person's name.
const canAct = (p, need) =>
  !!p.tasks && (need === "do" || need === "move" || !!p.chat);

// The tasks on one board that the product is already asking this person about
// - a duck on the task stopped at the step it is at now and asked them, and
// that question is in their Needs you and in the half-hour reminder - so they
// are not told again here. Only for the task's current step and attempt, and
// only a card they can see: the first version counted any old card on the
// task, and retrying does not clear one, so a single "I am stuck" from last
// week silenced every later email about that task to the person who runs it.
const alreadyAsked = (user, board) =>
  new Set(
    all(
      `SELECT DISTINCT bt.task_id
         FROM inbox i
         JOIN messages m ON m.id=i.message_id
         JOIN conversation_members cm ON cm.conversation_id=m.conversation_id AND cm.user_id=i.user_id
         JOIN jobs j ON j.output_message_id=m.id
         JOIN workflow_runs r ON r.job_id=j.id
         JOIN board_tasks bt ON bt.task_id=r.task_id AND bt.column_id=r.column_id AND bt.revision=r.revision
        WHERE i.user_id=? AND i.state='pending' AND m.needs_you IS NOT NULL AND bt.board_id=?`,
      user,
      board,
    ).map((r) => r.task_id),
  );

const breathe = () => new Promise((r) => setImmediate(r));

// Returns how many emails went out. Takes the time as an argument so a test
// can run it at any moment it likes.
export async function sweepBoards(now = Date.now()) {
  const live = liveSince(now);
  const iso = new Date(now).toISOString();
  const waiting = waitingTasks();

  // Note every wait the first time it is seen, and forget the ones that are
  // over, so the table holds what is waiting now and nothing else.
  const noted = new Map();
  db.transaction(() => {
    const note = db.prepare(
      "INSERT OR IGNORE INTO board_waits(key,company_id,board_id,task_id,first_seen) VALUES(?,?,?,?,?)",
    );
    for (const t of waiting)
      note.run(t.key, t.company_id, t.board_id, t.task_id, iso);
    const keep = new Set(waiting.map((t) => t.key));
    const drop = db.prepare("DELETE FROM board_waits WHERE key=?");
    for (const row of all("SELECT key FROM board_waits"))
      if (!keep.has(row.key)) drop.run(row.key);
    for (const row of all("SELECT key,first_seen,told FROM board_waits"))
      noted.set(row.key, { seen: whenOf(row.first_seen), told: !!row.told });
  })();

  // Due: first seen after reminders began, an hour ago or more, and not yet
  // told about. "Told" is what stops the work: without it a task blocked for a
  // fortnight had its whole board re-swept for every member every minute,
  // long after everybody had been written to.
  const due = (t) => {
    const w = noted.get(t.key);
    return !!w && !w.told && w.seen > live && w.seen <= now - BOARD_WAIT;
  };
  const byBoard = new Map();
  for (const t of waiting) {
    const list = byBoard.get(t.board_id) || [];
    list.push(t);
    byBoard.set(t.board_id, list);
  }

  let sent = 0;
  const told = db.prepare("UPDATE board_waits SET told=1 WHERE key=?");
  for (const [board, tasks] of byBoard) {
    const dueKeys = new Set(tasks.filter(due).map((t) => t.key));
    if (!dueKeys.size) continue;
    let retry = false;
    const company = tasks[0].company_id;
    for (const { user_id: user } of all(
      "SELECT user_id FROM memberships WHERE company_id=?",
      company,
    )) {
      await breathe();
      const member = memberFor(company, user);
      if (!member) continue;
      const p = permissions(member);
      const asked = alreadyAsked(user, board);
      const mine = tasks
        .filter((t) => canAct(p, t.need) && !asked.has(t.task_id))
        .map((t) => {
          const { seen } = noted.get(t.key);
          return {
            key: t.key,
            task: t.task_id,
            stage: t.stage_name,
            need: t.need,
            // A wait already there when these emails began was first seen
            // then, not when it began. Its task's last change is nearer.
            since:
              seen <= live ? Math.min(seen, whenOf(t.updated) || seen) : seen,
          };
        })
        .sort((a, b) => a.since - b.since);
      const owed = mine.filter((i) => dueKeys.has(i.key));
      if (!owed.length) continue;
      // Whether the person has this switched off is send()'s question, so the
      // email log gets its "off" row - the answer to "why did I not get it".
      const result = await notices.boardReminder({
        company,
        user,
        board,
        boardName: tasks[0].board_name,
        items: mine,
        owed,
        now,
      });
      sent += result.sent;
      if (result.retry) retry = true;
    }
    // Told, unless a send failed in a way worth trying again - then the next
    // sweep comes back to this board for it. mail-notices decides which
    // failures those are, and gives up after a few.
    if (!retry) for (const key of dueKeys) told.run(key);
  }
  return sent;
}
