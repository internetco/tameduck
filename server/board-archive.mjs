import { z } from "zod";
import {
  one,
  all,
  run,
  now,
  tenant,
  fail,
  can,
  audit,
  emit,
  recordStopper,
} from "./store.mjs";
import { cancelJob } from "./runtime.mjs";
import { withTicketActor } from "./ticket-activity.mjs";
import { movedOn } from "./workflows.mjs";

// Archiving a board, and bringing it back.
//
// A board is never deleted: its tickets, their runs and their history have to
// go on reading correctly, from search and from links. So a board that is no
// longer used is archived instead. It leaves the board list, its ducks stop,
// and it can be brought back. Its tickets still open, and a person can still
// do a person's step on one.
export async function setBoardArchived(company, user, bid, archived) {
  const board = tenant("task_boards", bid, company);
  if (board.legacy) fail(409, "The General board cannot be archived.");
  if (!!board.archived === archived) return { ok: true, stopped: 0, paused: 0 };
  if (!archived) {
    // The same limit a new board meets, so bringing one back is not a way round it.
    if (
      one(
        "SELECT count(*) n FROM task_boards WHERE company_id=? AND archived=0",
        company,
      ).n >= 20
    )
      fail(
        409,
        "This company already has 20 boards in use. Archive one before bringing this one back.",
      );
    run("UPDATE task_boards SET archived=0,updated=? WHERE id=?", now(), bid);
    // Its scheduled tasks stay paused. Their reason says what to do.
    audit(company, user, "Board brought back", board.name);
    emit(company);
    return { ok: true, stopped: 0, paused: 0 };
  }
  // First out of use, so the engine starts nothing on it while the rest happens.
  const working = withTicketActor(company, { user_id: user }, () => {
    run("UPDATE task_boards SET archived=1,updated=? WHERE id=?", now(), bid);
    const jobs = all(
      "SELECT j.* FROM jobs j JOIN board_tasks bt ON bt.task_id=j.task_id WHERE bt.board_id=? AND j.status IN ('queued','running','waiting_human','waiting_consultation')",
      bid,
    );
    for (const job of jobs) recordStopper(job.id, user);
    return jobs;
  });
  // The work under way stops, the way archiving a channel stops the work in it.
  // Stopping a run waits on the duck, so it cannot be inside a transaction.
  for (const job of working) await cancelJob(job);
  const paused = withTicketActor(company, { user_id: user }, () => {
    // Nobody is left being asked about a ticket on a board that is out of use.
    for (const t of all(
      "SELECT task_id FROM board_tasks WHERE board_id=? AND state<>'complete'",
      bid,
    ))
      movedOn(t.task_id);
    // Scheduled tasks would keep adding tickets nobody works on. Paused the
    // way taking a duck off the team pauses its own.
    const n = run(
      "UPDATE schedules SET paused=1,paused_reason=?,updated=? WHERE company_id=? AND board_id=? AND paused=0",
      "“" +
        board.name +
        "” was archived. Bring the board back, or send this to another board, then turn it on again.",
      now(),
      company,
      bid,
    ).changes;
    // A card asking to approve changes to this board has nothing behind it now.
    run(
      "UPDATE board_proposals SET status='withdrawn',updated=? WHERE board_id=? AND status='pending'",
      now(),
      bid,
    );
    return n;
  });
  audit(
    company,
    user,
    "Board archived",
    board.name + (working.length ? " (" + working.length + " stopped)" : ""),
  );
  emit(company);
  return { ok: true, stopped: working.length, paused };
}

export function registerBoardArchive(app) {
  app.patch("/api/boards/:id/archive", async (req, res) => {
    can(req.member, "tasks");
    const a = z.object({ archived: z.boolean() }).parse(req.body);
    res.json(
      await setBoardArchived(
        req.company.id,
        req.user.id,
        req.params.id,
        a.archived,
      ),
    );
  });
}
