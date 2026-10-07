// Who has a ticket right now, in the one line at the foot of its card.
//
// Every card used to wear the same grey "Ready" pill. On a stage a person
// handles, "Ready" meant "waiting for a person" and stayed that way for good,
// and nothing said which person; a duck's stage that had not started yet said
// the same word as one it had finished. So the card now names whoever the
// ticket is waiting on - a duck that is on it, a duck that is next, you, or a
// teammate - and says plainly when it is stuck or done.
import { recoveryLabel } from "./recovery-status.mjs";

const running = ["running"];
const queuedTurn = (duck, reason) => ({
  kind: duck ? "duck" : "wait",
  ...(duck ? { duck } : {}),
  status:
    reason?.label && !["same_duck_busy", "starting_soon"].includes(reason.code)
      ? reason.label
      : duck
        ? "Waiting for " + duck.name
        : "Waiting to start",
});

// A stage a person does. The last column with nobody on it and no approvers is
// where finished tickets land, not a step anyone does.
export function personStep(column, isLast) {
  return !column.duck_id && !(isLast && !column.approvers?.length);
}

// One of:
//   { kind: "you" }                        yours to do next
//   { kind: "person", name }               a teammate's turn
//   { kind: "live", duck, status }         a duck is working on it now
//   { kind: "duck", duck, status }         a duck's step, not going right now
//   { kind: "wait", status }               waiting, with nobody to name
//   { kind: "stuck", status, mine }        stopped until somebody looks
//   { kind: "done" }
export function whoHasIt({
  ticket,
  task,
  column,
  isLast,
  legacy,
  runs = [],
  ducks = [],
  members = [],
  me,
  canDoTasks,
}) {
  const duckFor = (id) => ducks.find((d) => d.id === id) || null;
  const recoveryTurn = () => {
    const recovery = task.recovery;
    if (
      !recovery ||
      !["waiting", "queued", "held", "needs_attention"].includes(
        recovery.state,
      ) ||
      (task.running && task.running !== recovery.job_id)
    )
      return null;
    return recovery.state === "needs_attention"
      ? {
          kind: "stuck",
          status: recoveryLabel(recovery.state),
          mine: recovery.user_id === me && !!canDoTasks,
        }
      : { kind: "wait", status: recoveryLabel(recovery.state) };
  };
  if (legacy && task.status === "done") return { kind: "done" };
  if (!legacy && ticket.state === "complete") return { kind: "done" };
  if (legacy) {
    const duck = duckFor(task.running_duck) || duckFor(task.assignee_id);
    if (task.status === "done") return { kind: "done" };
    const recovering = recoveryTurn();
    if (recovering && !task.asked) return recovering;
    if (task.running && task.running_status === "queued")
      return queuedTurn(duck, task.queue_reason);
    if (task.running && task.running_status === "waiting_human")
      return {
        kind: "wait",
        status:
          me && task.running_by === me ? "Waiting for you" : "Waiting for a person",
      };
    if (task.running && task.running_status === "waiting_consultation")
      return { kind: "wait", status: "Waiting for another duck" };
    if (task.running)
      return duck
        ? { kind: "live", duck, status: "On it now" }
        : { kind: "wait", status: "A duck is on it" };
    // In "Being worked on" with nothing running: somebody moved it there by
    // hand, or the duck finished without marking it done. "Not started" under
    // that column's name would contradict it.
    // Its last run failed or was cut off, and nothing has run since: a person
    // has to look, whoever the duck is.
    if (task.asked)
      return {
        kind: "wait",
        status:
          me && task.asked_of === me ? "Waiting for you" : "Waiting for a person",
      };
    if (task.status === "working" && task.stuck)
      return {
        kind: "stuck",
        status: "Stuck",
        mine: !!me && task.creator_id === me,
      };
    if (task.status === "working")
      return duck
        ? { kind: "duck", duck, status: "Waiting" }
        : { kind: "wait", status: "Waiting for a person" };
    return duck
      ? { kind: "duck", duck, status: "Not started" }
      : { kind: "wait", status: "Nobody on it yet" };
  }
  // The person a ticket waits on is the one it runs as: whoever made it, or
  // whoever last started a new attempt. Anybody allowed to manage tasks can
  // step in, but only one of them is the one it is waiting for.
  const turnOf = () => {
    if (ticket.runner_id === me && canDoTasks) return { kind: "you" };
    const who = members.find((m) => m.id === ticket.runner_id);
    return who
      ? { kind: "person", name: who.name }
      : { kind: "wait", status: "Waiting for a person" };
  };
  if (ticket.state === "complete") return { kind: "done" };
  // The engine leaves a stuck ticket alone until a person starts a new
  // attempt, and it is the runner who hears about it in Needs you.
  if (ticket.state === "blocked" || ticket.state === "changes_requested")
    return {
      kind: "stuck",
      status: ticket.state === "blocked" ? "Stuck" : "Changes requested",
      mine: turnOf().kind === "you",
    };
  const current = runs.filter(
    (r) =>
      r.task_id === ticket.task_id &&
      r.column_id === ticket.column_id &&
      r.revision === ticket.revision,
  );
  // A duck stopped on a screen for a code or a password is waiting on a
  // person, not working, even though its run is still open.
  if (current.some((r) => r.status === "waiting_human")) return turnOf();
  const recovering = recoveryTurn();
  if (recovering) return recovering;
  const live =
    current.find((r) => r.role === "worker" && running.includes(r.status)) ||
    current.find((r) => r.role === "reviewer" && running.includes(r.status));
  if (live && duckFor(live.duck_id))
    return {
      kind: "live",
      duck: duckFor(live.duck_id),
      status: live.role === "reviewer" ? "Checking it now" : "On it now",
    };
  const consulting = current.find((r) => r.status === "waiting_consultation");
  if (consulting) return { kind: "wait", status: "Waiting for another duck" };
  const queued = current.find((r) => r.status === "queued");
  if (queued)
    return queuedTurn(
      duckFor(queued.duck_id),
      queued.queue_reason || task.queue_reason,
    );
  if (ticket.state === "ready_to_move") return turnOf();
  const duck = duckFor(column.duck_id);
  if (ticket.state === "working" && duck)
    return { kind: "live", duck, status: "On it now" };
  if (ticket.state === "reviewing") {
    const next = duckFor(
      (column.approvers || []).find(
        (id) => !current.some((r) => r.role === "reviewer" && r.duck_id === id),
      ),
    );
    return next
      ? { kind: "duck", duck: next, status: "Checks it next" }
      : { kind: "wait", status: "Being checked" };
  }
  if (ticket.state === "waiting")
    return duck && !duck.removed
      ? { kind: "duck", duck, status: "Waiting" }
      : { kind: "wait", status: "Waiting" };
  if (duck && !duck.removed) return { kind: "duck", duck, status: "Up next" };
  if (personStep(column, isLast)) return turnOf();
  if (!column.duck_id) return { kind: "done" };
  return { kind: "wait", status: "Waiting" };
}
