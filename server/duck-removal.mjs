import { all, one, run, now, tenant, fail, audit, emit, recordStopper } from "./store.mjs";
import { flockIsFull, flockFullMessage } from "./company-limits.mjs";
import { cancelJob } from "./runtime.mjs";
import { pauseComputer } from "./computers.mjs";

// Taking a duck off the team.
//
// A duck cannot be deleted. Its id is on every message it wrote, every ticket
// it worked, every run it made and every file it saved, and all of that has to
// go on reading correctly for as long as the company keeps its history. So
// removing a duck retires it: the row stays and the screens still get it, which
// is what lets an old conversation render the right name, face and colour. What
// changes is that it is never offered work and never counted as one of the
// company's ducks again - and it can be put back.
//
// The screens are given every duck, removed ones included, and filter the lists
// themselves. That is the safe way round: a list that forgets to filter shows a
// duck that should not be there, which somebody notices, while a lookup that
// could not find its duck would quietly render a blank face on a message from
// two years ago, which nobody notices.

// The ducks this company actually has. Everything that offers a duck, counts
// them, or lists them asks for these; only history asks for all of them.
export const liveDucks = (company) =>
  all(
    "SELECT * FROM ducks WHERE company_id=? AND removed=0 ORDER BY chief DESC,created",
    company,
  );
export const isRemoved = (duckId) =>
  !!one("SELECT removed FROM ducks WHERE id=?", duckId)?.removed;
// Said to a duck's own tools, and to any route that takes a duck id, so that
// neither can hand work to somebody who is no longer on the team.
export function assertOnTheTeam(duckId, company) {
  const duck = tenant("ducks", duckId, company);
  if (duck.removed)
    fail(
      409,
      duck.name +
        " was taken off the team, so it cannot be given work. Put it back from Settings, Ducks if you want it again.",
    );
  return duck;
}

// Everything a removal has to stop, in one place, so that turning a duck off
// cannot leave one of its parts still running.
async function standDown(duck, userId) {
  const company = duck.company_id;
  // 1. Runs in flight. A cancelled run is gone; putting the duck back does not
  //    bring it back, and the screen says so before this happens.
  const running = all(
    "SELECT * FROM jobs WHERE company_id=? AND duck_id=? AND status IN ('queued','running','waiting_human','waiting_consultation')",
    company,
    duck.id,
  );
  for (const job of running) recordStopper(job.id, userId);
  for (const job of running) await cancelJob(job);
  // 2. Its computer, which otherwise sits there booted and billed with nobody
  //    to use it. Stopping is best-effort: a provider that will not answer must
  //    not keep the duck on the team.
  const computers = all(
    "SELECT id FROM computers WHERE company_id=? AND duck_id=? AND state NOT IN ('archived','archiving')",
    company,
    duck.id,
  );
  for (const c of computers)
    try {
      await pauseComputer(c.id, company, null, {
        automatic: true,
        reason: duck.name + " was taken off the team.",
        kind: "stopped_removed",
      });
    } catch {
      // Left as it is. The janitor stops an idle computer anyway, and the duck
      // can no longer ask this one for anything.
    }
  // 3. Scheduled tasks. The tick would pause these itself at their next turn,
  //    but that could be a month away, and until then the screen would promise
  //    work by somebody who is gone.
  const scheduled = all(
    "SELECT id FROM schedules WHERE company_id=? AND duck_id=? AND paused=0",
    company,
    duck.id,
  );
  for (const s of scheduled)
    run(
      "UPDATE schedules SET paused=1,paused_reason=?,updated=? WHERE id=?",
      duck.name +
        " was taken off the team. Put the duck back, or give this to another one, then turn it on again.",
      now(),
      s.id,
    );
  // 4. Approvals it is still waiting on. A tool call a person has to approve
  //    outlives the run that asked: the duck stops and the job finishes, and
  //    the card sits in Needs you until somebody decides. Approving one after
  //    the duck has gone would start a fresh run for it, so the card goes -
  //    with the same sentence a stopped run leaves behind.
  const approvals = run(
    "UPDATE approvals SET status='cancelled',result=?,updated=? WHERE company_id=? AND status='pending' AND job_id IN (SELECT id FROM jobs WHERE duck_id=?)",
    "The duck that asked for this was taken off the team before anyone decided, so the tool was never used.",
    now(),
    company,
    duck.id,
  ).changes;
  // 4b. Its asks to be let into a connection, or for one to be signed in to
  //     again. Nobody should be asked to let in a duck that has gone, and one
  //     put back later should not bring the old ask back with it.
  run(
    "UPDATE connection_blocks SET status='dismissed',updated=? WHERE company_id=? AND duck_id=? AND status='waiting'",
    now(),
    company,
    duck.id,
  );
  // 5. Requests it left with a person to decide. A card asking somebody to
  //    approve a schedule proposed by a duck that is no longer here is a
  //    question with no one behind it.
  let withdrawn = 0;
  for (const table of [
    "schedule_proposals",
    "board_proposals",
    "skill_proposals",
  ])
    withdrawn += run(
      "UPDATE " +
        table +
        " SET status='withdrawn',updated=? WHERE company_id=? AND duck_id=? AND status='pending'",
      now(),
      company,
      duck.id,
    ).changes;
  return {
    runs: running.length,
    computers: computers.length,
    schedules: scheduled.length,
    proposals: withdrawn,
    approvals,
  };
}

// What the screen shows before it asks. Same numbers standDown will act on, so
// the warning and what happens cannot disagree.
export function whatRemovalStops(duck) {
  return {
    runs: one(
      "SELECT count(*) n FROM jobs WHERE company_id=? AND duck_id=? AND status IN ('queued','running','waiting_human','waiting_consultation')",
      duck.company_id,
      duck.id,
    ).n,
    computers: one(
      "SELECT count(*) n FROM computers WHERE company_id=? AND duck_id=? AND state NOT IN ('archived','archiving')",
      duck.company_id,
      duck.id,
    ).n,
    schedules: one(
      "SELECT count(*) n FROM schedules WHERE company_id=? AND duck_id=? AND paused=0",
      duck.company_id,
      duck.id,
    ).n,
    // Cards sitting on somebody's Needs you waiting to be decided. Removing the
    // duck takes them away, and the dialog used to promise that "everything it
    // has already written stays exactly where it is" while quietly clearing
    // these - so a decision somebody was part-way through simply vanished.
    waiting:
      one(
        "SELECT count(*) n FROM approvals WHERE company_id=? AND status='pending' AND job_id IN (SELECT id FROM jobs WHERE duck_id=?)",
        duck.company_id,
        duck.id,
      ).n +
      ["schedule_proposals", "board_proposals", "skill_proposals"].reduce(
        (n, table) =>
          n +
          one(
            "SELECT count(*) n FROM " +
              table +
              " WHERE company_id=? AND duck_id=? AND status='pending'",
            duck.company_id,
            duck.id,
          ).n,
        0,
      ),
  };
}

export async function setRemoved(duck, removed, userId) {
  if (removed && duck.chief)
    fail(
      409,
      duck.name +
        " runs your flock and every company has exactly one, so it cannot be taken off the team. You can change its name, its job and how it works on its profile.",
    );
  if (!!duck.removed === !!removed)
    return { ok: true, ...whatRemovalStops(duck), unchanged: true };
  // Putting one back is adding one, and it was the only way in that never
  // counted. The product's own advice is "take one off the team to make
  // room", so the way to a twenty-sixth duck was to follow it: take one off,
  // add a replacement, then put the first one back. Nothing said a word.
  if (!removed && flockIsFull(duck.company_id))
    fail(409, flockFullMessage(duck.company_id, { name: duck.name }));
  const stopped = removed ? await standDown(duck, userId) : null;
  run("UPDATE ducks SET removed=? WHERE id=?", removed ? 1 : 0, duck.id);
  audit(
    duck.company_id,
    userId,
    removed ? "Duck taken off the team" : "Duck put back on the team",
    removed ? { duck: duck.name, ...stopped } : { duck: duck.name },
    { duck: duck.id },
  );
  emit(duck.company_id);
  return { ok: true, ...(stopped || {}) };
}
