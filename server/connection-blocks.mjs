// A duck that stops at a connection used to leave one thing behind: a sentence
// in chat or on a ticket - "Please enable the Site.eu connection for
// Publishing Duck" - with nothing on it to press, and the setting somewhere
// else in the app. The server knows exactly what went wrong at the moment it
// refuses, so it writes it down here, and the person gets one button: Allow,
// or Reconnect. Once it is fixed the duck carries on by itself, the way it
// does after a tool approval.
import {
  db,
  id,
  now,
  one,
  all,
  run,
  json,
  fail,
  can,
  emit,
  audit,
  memberFor,
  permissions,
  addMessage,
  onTeam,
  tenant,
} from "./store.mjs";
import { retryWorkflowTask, workflowTask } from "./workflows.mjs";
import { withTicketActor } from "./ticket-activity.mjs";

// Handed in when the routes are registered: the queue lives in duck-tools,
// which records blocks through this file.
let startDuck = null;
const running = ["queued", "running", "waiting_human", "waiting_consultation"];

// Which of the two a refusal is, or null when it is something neither button
// fixes - an address that does not answer, a service that is down.
export function blockKind(error) {
  if (error?.block) return error.block;
  if (error?.code === 401 || error?.code === 403 || error?.status === 401)
    return "sign_in";
  if (/Unauthorized|invalid.grant|invalid.token|sign in/i.test(error?.message))
    return "sign_in";
  return null;
}

// The run the person was talking to. A helper's run answered the duck that
// asked it, so that duck is the one to carry on, and its chat is where.
function origin(job) {
  return (
    one(
      "SELECT p.* FROM duck_consultations c JOIN jobs p ON p.id=c.parent_job_id WHERE c.child_job_id=?",
      job.id,
    ) || job
  );
}
// Where a duck is waiting: a ticket, or a chat and the thread in it.
const placeOf = (job, at) =>
  at.task_id || job.task_id
    ? "ticket:" + (at.task_id || job.task_id)
    : "chat:" + at.conversation_id + ":" + (at.thread_id || "");

// Write it down, and give the duck the words to stop on. Anything that is not
// one of the two goes back to the duck as it was.
export function blocked(job, duck, connectionId, error) {
  const kind = blockKind(error);
  const connection = kind
    ? one(
        "SELECT * FROM connections WHERE id=? AND company_id=?",
        connectionId,
        job.company_id,
      )
    : null;
  if (!connection) return error;
  const at = origin(job);
  run(
    `INSERT INTO connection_blocks(id,company_id,connection_id,duck_id,kind,place,job_id,user_id,conversation_id,thread_id,task_id,message_id,created,updated)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(connection_id,duck_id,kind,place) WHERE status='waiting' DO UPDATE SET
       job_id=excluded.job_id,user_id=excluded.user_id,message_id=excluded.message_id,updated=excluded.updated`,
    id(),
    job.company_id,
    connection.id,
    duck.id,
    kind,
    placeOf(job, at),
    job.id,
    at.user_id,
    at.conversation_id,
    at.thread_id,
    at.task_id || job.task_id,
    at.output_message_id,
    now(),
    now(),
  );
  // Settings went on saying "Connected" while every duck was refused: only the
  // Test button ever wrote down that a sign-in had stopped working.
  if (kind === "sign_in")
    run(
      "UPDATE connections SET connection_status=?,checked_at=?,last_error=? WHERE id=?",
      connection.auth_type === "oauth" ? "auth_required" : "error",
      now(),
      "Sign in again or check that your key has access to this service.",
      connection.id,
    );
  emit(job.company_id);
  const name = connection.name;
  return Object.assign(
    new Error(
      kind === "access"
        ? `You are not allowed to use ${name} yet. The people who manage connections now see an Allow button for it. Stop here and tell the person, in one plain sentence, that you are waiting for access to ${name}. You will be told when it is allowed.`
        : `${name} would not let TameDuck in, so someone has to ${connection.auth_type === "oauth" ? "sign in to it again" : "fix its key"}. The people who manage connections now see a Reconnect button for it. Stop here and tell the person, in one plain sentence, that you are waiting for ${name} to be reconnected. You will be told when it works again.`,
    ),
    { status: 403 },
  );
}

// Claim it, so a second click - or a second teammate - does nothing.
function settle(block, status, by) {
  const claimed = run(
    "UPDATE connection_blocks SET status=?,settled_by=?,updated=? WHERE id=? AND status='waiting'",
    status,
    by,
    now(),
    block.id,
  ).changes;
  // Put off: the person whose duck is waiting keeps its message about it,
  // because it is still waiting.
  if (claimed && status === "fixed") tidy(block);
  return claimed;
}

// Fixed: the duck's message about it stops waiting for a reply, and so do the
// reminder emails. It belongs to the run the person talked to - for a helper,
// the duck that asked it - and a run still going writes its note when it ends,
// so this runs again when the duck carries on.
function tidy(block) {
  run(
    "UPDATE jobs SET needs_you=NULL WHERE id=? OR output_message_id=?",
    block.job_id,
    block.message_id,
  );
  if (!block.message_id) return;
  run("UPDATE messages SET needs_you=NULL WHERE id=?", block.message_id);
  run(
    "UPDATE inbox SET state='replied' WHERE message_id=? AND state='pending'",
    block.message_id,
  );
}

const stillRunning = (block) => {
  const job = one("SELECT * FROM jobs WHERE id=?", block.job_id);
  return !!job && [job, origin(job)].some((j) => running.includes(j.status));
};

// Carry the duck on now, or - while the run that was refused is still going,
// or its ticket has not stopped yet - once it has, so the new run does not
// start under the old one.
function proceed(block, by, line) {
  if (stillRunning(block) || carryOn(block, by, line) === "later")
    run(
      "UPDATE connection_blocks SET carry_on=?,updated=? WHERE id=?",
      line,
      now(),
      block.id,
    );
}
function fixed(block, by, line) {
  if (!settle(block, "fixed", by)) return false;
  proceed(block, by, line);
  return true;
}

// Start the duck again where it stopped. Says why not, when it cannot. Returns
// "later" when a ticket has not stopped yet.
function carryOn(block, by, line) {
  tidy(block);
  const job = one("SELECT * FROM jobs WHERE id=?", block.job_id);
  if (!job) return "";
  const at = origin(job);
  const stage = one(
    "SELECT task_id,column_id,revision FROM workflow_runs WHERE job_id=?",
    at.id,
  );
  if (stage) {
    // A ticket carries on with a new attempt, and only when it is still stuck
    // where this run left it. One that has moved on, or has a new attempt
    // already, was dealt with some other way.
    const t = workflowTask(stage.task_id);
    if (
      !t ||
      t.column_id !== stage.column_id ||
      t.revision !== stage.revision ||
      t.state === "complete"
    )
      return "";
    if (!["blocked", "changes_requested", "waiting"].includes(t.state))
      return "later";
    // Another duck on this stage is still at work - a second reviewer - and
    // a new attempt would be refused until it is done. The wait counts from
    // when it has finished, not from the click.
    if (
      one(
        `SELECT 1 FROM workflow_runs r JOIN jobs j ON j.id=r.job_id WHERE r.task_id=? AND r.revision=? AND j.status IN (${running.map(() => "?").join(",")})`,
        t.task_id,
        t.revision,
        ...running,
      )
    ) {
      run("UPDATE connection_blocks SET updated=? WHERE id=?", now(), block.id);
      return "later";
    }
    try {
      withTicketActor(block.company_id, { user_id: by }, () =>
        retryWorkflowTask(
          block.company_id,
          t.runner_id,
          t.task_id,
          line + " Carry on where you stopped, and keep the work already done.",
        ),
      );
      return "";
    } catch (e) {
      if (e.status === 409) return "later";
      return "The ticket could not start again: " + e.message;
    }
  }
  if (!at.conversation_id) return "";
  const message = addMessage(
    block.company_id,
    at.conversation_id,
    line + " Carry on where you stopped.",
    { user: by, origin: "tool", thread: at.thread_id || null },
  );
  const member = memberFor(block.company_id, at.user_id);
  let warning = "";
  if (!member)
    warning = "The person who started this task is no longer in the company.";
  else if (!permissions(member).chat)
    warning = "The person who started this task can no longer chat with ducks.";
  else if (
    one("SELECT paused FROM companies WHERE id=?", block.company_id)?.paused
  )
    warning =
      "The ducks are paused. Start them again and ask the duck to carry on.";
  else
    try {
      // Always queued, even behind a newer run in the same chat: that one
      // started before this line and cannot see it.
      startDuck(
        block.company_id,
        at.user_id,
        at.conversation_id,
        at.duck_id,
        message,
        { taskId: at.task_id },
      );
    } catch (e) {
      warning = "The duck could not be started again: " + e.message;
    }
  if (warning)
    addMessage(
      block.company_id,
      at.conversation_id,
      "It did not carry on. " + warning,
      { user: by, thread: at.thread_id || null },
    );
  return warning;
}

// Ducks fixed while their run was still going, carried on once it has ended.
// A ticket that has not stopped after ten minutes has gone its own way.
export function carryOnLater() {
  for (const block of all(
    "SELECT * FROM connection_blocks WHERE status='fixed' AND carry_on IS NOT NULL",
  )) {
    // The ten minutes count from when the run was last seen going.
    if (stillRunning(block)) {
      run("UPDATE connection_blocks SET updated=? WHERE id=?", now(), block.id);
      continue;
    }
    const said = carryOn(block, block.settled_by, block.carry_on);
    // Read again: a ticket another duck is still working on has just moved
    // the clock on.
    const since = one(
      "SELECT updated FROM connection_blocks WHERE id=?",
      block.id,
    ).updated;
    if (said !== "later" || Date.now() - Date.parse(since) > 10 * 60000)
      run("UPDATE connection_blocks SET carry_on=NULL WHERE id=?", block.id);
  }
}

// Every place this duck waits for this, from any one of them.
const alongside = (block) =>
  all(
    "SELECT * FROM connection_blocks WHERE connection_id=? AND duck_id=? AND kind=? AND status='waiting'",
    block.connection_id,
    block.duck_id,
    block.kind,
  );

function blockFor(company, blockId) {
  const block = one(
    "SELECT * FROM connection_blocks WHERE id=? AND company_id=?",
    blockId,
    company,
  );
  if (!block) fail(404, "This was not found.");
  if (block.status !== "waiting") fail(409, "Someone already dealt with this.");
  return block;
}

// Allow: the duck may use the connection - and its saved key, without which
// the call is refused one step later - and it carries on, wherever it waits.
export function allowDuck(company, blockId, by) {
  const block = blockFor(company, blockId);
  if (block.kind !== "access")
    fail(400, "This connection needs a sign-in, not an allowance.");
  const connection = tenant("connections", block.connection_id, company);
  // A pause is somebody's decision. Letting the duck in and telling it to go
  // on would only send it into "this connection is paused".
  if (!connection.enabled)
    fail(409, connection.name + " is paused. Switch it on first.");
  const duck = onTeam(block.duck_id, company);
  const line = `${duck.name} can now use ${connection.name}.`;
  const waiting = alongside(block);
  db.transaction(() => {
    const ducks = json(connection.allowed_ducks);
    if (!ducks.includes(duck.id))
      run(
        "UPDATE connections SET allowed_ducks=? WHERE id=?",
        JSON.stringify([...ducks, duck.id]),
        connection.id,
      );
    if (connection.secret_id) {
      const key = tenant("secrets", connection.secret_id, company);
      const keyDucks = json(key.allowed_ducks);
      if (!keyDucks.includes(duck.id))
        run(
          "UPDATE secrets SET allowed_ducks=? WHERE id=?",
          JSON.stringify([...keyDucks, duck.id]),
          key.id,
        );
    }
    if (!settle(block, "fixed", by))
      fail(409, "Someone already dealt with this.");
  })();
  audit(company, by, "Duck allowed to use a connection", {
    duck: duck.name,
    connection: connection.name,
  });
  proceed(block, by, line);
  for (const other of waiting)
    if (other.id !== block.id) fixed(other, by, line);
}

// A line in the chat where the duck waited, for the person it was waiting
// for. A ticket's work happens in a conversation of its own that nobody reads
// as a chat, so a ticket gets none: it stays stuck on the board, which says so.
function tell(block, by, words) {
  if (block.conversation_id && !block.task_id)
    addMessage(block.company_id, block.conversation_id, words, {
      user: by,
      thread: block.thread_id || null,
    });
}

// Not now: off the list, and the duck stays where it stopped. The person it
// was waiting for is told, rather than left thinking it still is.
export function dismissBlock(company, blockId, by) {
  const block = blockFor(company, blockId);
  const connection = one(
    "SELECT name FROM connections WHERE id=?",
    block.connection_id,
  );
  const duck = one("SELECT name FROM ducks WHERE id=?", block.duck_id);
  const person = one("SELECT name FROM users WHERE id=?", by);
  for (const b of alongside(block))
    if (settle(b, "dismissed", by))
      tell(
        b,
        by,
        `${person?.name || "Someone"} put off ${
          b.kind === "access"
            ? `letting ${duck?.name} use ${connection?.name}`
            : `fixing ${connection?.name}`
        } for now. ${duck?.name} is not carrying on.`,
      );
  emit(company);
}

// Somebody allowed ducks in Settings themselves. Those that were waiting on
// exactly that carry on, as if the button had been pressed.
export function accessGiven(company, connectionId, by) {
  const connection = one(
    "SELECT * FROM connections WHERE id=? AND company_id=?",
    connectionId,
    company,
  );
  if (!connection?.enabled) return;
  const allowed = json(connection.allowed_ducks);
  for (const block of all(
    "SELECT b.* FROM connection_blocks b JOIN ducks d ON d.id=b.duck_id AND d.removed=0 WHERE b.connection_id=? AND b.kind='access' AND b.status='waiting'",
    connectionId,
  ))
    if (allowed.includes(block.duck_id)) {
      const duck = one("SELECT name FROM ducks WHERE id=?", block.duck_id);
      fixed(block, by, `${duck.name} can now use ${connection.name}.`);
    }
  emit(company);
}

// The connection answers again, after a sign-in or a new key. Every duck that
// was waiting for that, and may still use it, carries on.
export function connectionWorksAgain(company, connectionId, by) {
  const connection = one(
    "SELECT * FROM connections WHERE id=? AND company_id=?",
    connectionId,
    company,
  );
  if (!connection) return;
  const allowed = json(connection.allowed_ducks);
  for (const block of all(
    "SELECT b.*,d.name duck_name FROM connection_blocks b JOIN ducks d ON d.id=b.duck_id AND d.removed=0 WHERE b.connection_id=? AND b.kind='sign_in' AND b.status='waiting'",
    connectionId,
  ))
    if (allowed.includes(block.duck_id))
      fixed(block, by, `${connection.name} works again.`);
    // Taken off this connection since it asked: nothing to carry on, and
    // nothing any fix to the connection could ever close.
    else if (settle(block, "dismissed", by))
      tell(
        block,
        by,
        `${connection.name} works again, but ${block.duck_name} is no longer allowed to use it, so it is not carrying on.`,
      );
}

// A duck got through. Where it is now, there is nothing left to wait for; any
// other place it was waiting for this carries on, and Settings stops saying it
// is broken - somebody fixed it without pressing the button.
export function gotThrough(job, connectionId, duckId) {
  const connection = one(
    "SELECT * FROM connections WHERE id=? AND company_id=?",
    connectionId,
    job.company_id,
  );
  if (!connection) return;
  const here = placeOf(job, origin(job));
  let changed = run(
    "UPDATE connections SET connection_status='connected',last_error=NULL,checked_at=? WHERE id=? AND connection_status IN ('error','auth_required')",
    now(),
    connectionId,
  ).changes;
  const duck = one("SELECT name FROM ducks WHERE id=?", duckId);
  for (const block of all(
    "SELECT * FROM connection_blocks WHERE connection_id=? AND duck_id=? AND status='waiting'",
    connectionId,
    duckId,
  )) {
    changed = true;
    if (block.place === here) settle(block, "fixed", null);
    else
      fixed(
        block,
        null,
        block.kind === "access"
          ? `${duck.name} can now use ${connection.name}.`
          : `${connection.name} works again.`,
      );
  }
  // A sign-in belongs to the connection, not the duck: every other duck
  // waiting for it carries on too.
  connectionWorksAgain(job.company_id, connectionId, null);
  if (changed) emit(job.company_id);
}

export const waitingForSignIn = (connectionId) =>
  !!one(
    "SELECT 1 FROM connection_blocks WHERE connection_id=? AND kind='sign_in' AND status='waiting'",
    connectionId,
  );

// What Needs you shows: one line for each duck, connection and cause, however
// many places it waits in. Everyone who can fix a connection sees every one;
// the person whose duck is waiting sees their own, with who can fix it. A
// paused connection is left alone until somebody switches it on.
export function connectionBlocksFor(company, user, perms) {
  const rows = all(
    `SELECT b.id,b.kind,b.connection_id,cn.name connection_name,cn.auth_type,
            CASE WHEN ?=1 THEN k.name END key_name,
            b.duck_id,d.name duck_name,b.user_id,b.conversation_id,b.thread_id,
            b.message_id,b.task_id,t.title task_title,bt.board_id,b.created
       FROM connection_blocks b
       JOIN connections cn ON cn.id=b.connection_id AND cn.enabled=1
       JOIN ducks d ON d.id=b.duck_id AND d.removed=0
       LEFT JOIN secrets k ON k.id=cn.secret_id
       LEFT JOIN tasks t ON t.id=b.task_id
       LEFT JOIN board_tasks bt ON bt.task_id=b.task_id
      WHERE b.company_id=? AND b.status='waiting' AND (?=1 OR b.user_id=?)
      ORDER BY b.created DESC LIMIT 200`,
    // The key's name, like the key itself, is for people who manage them.
    perms.integrations ? 1 : 0,
    company,
    perms.integrations ? 1 : 0,
    user,
  );
  const lines = new Map();
  for (const row of rows) {
    const key = row.duck_id + ":" + row.connection_id + ":" + row.kind;
    const line = lines.get(key);
    if (!line)
      lines.set(key, {
        ...row,
        message_ids: [row.message_id],
        task_ids: [row.task_id],
      });
    else {
      line.message_ids.push(row.message_id);
      line.task_ids.push(row.task_id);
    }
  }
  return [...lines.values()];
}

export function registerConnectionBlocks(app, { enqueue }) {
  startDuck = enqueue;
  app.post("/api/connection-blocks/:id/allow", (req, res) => {
    can(req.member, "integrations");
    allowDuck(req.company.id, req.params.id, req.user.id);
    emit(req.company.id);
    res.json({ ok: true });
  });
  app.post("/api/connection-blocks/:id/dismiss", (req, res) => {
    can(req.member, "integrations");
    dismissBlock(req.company.id, req.params.id, req.user.id);
    res.json({ ok: true });
  });
}

export function startConnectionBlocks() {
  setInterval(() => {
    try {
      carryOnLater();
    } catch (e) {
      console.error("Carrying ducks on after a connection fix:", e.message);
    }
  }, 5000).unref();
}
