// What a ticket's page says about its stages: where the ticket has been, who
// has it now and what they are asked to do, and what the button that moves it
// on will do. Worked out here, without React, so every word that depends on
// the ticket's state can be tested on its own. The page and the board card use
// the same whoHasIt, so the two cannot disagree about who has a ticket.
import { personStep, whoHasIt } from "./board-turn.mjs";
import { recoveryLabel, RECOVERY_STATES } from "./recovery-status.mjs";
import { queueReason } from "./queue-reason.mjs";

const active = ["queued", "running", "waiting_human", "waiting_consultation"];
// "your turn" in the middle of a sentence. A person's name keeps its capital.
const lower = (words) => words && words[0].toLowerCase() + words.slice(1);
const names = (list) =>
  list.length < 2
    ? list.join("")
    : list.slice(0, -1).join(", ") + " and " + list.at(-1);
const marker = /^(#{1,6}\s+|>\s*|[-*+]\s+|\d+\.\s+)/;

// What a step asks of whoever has it: the first sentence of its instructions,
// kept as written. "Read it and decide. Then say why." asks "Read it and
// decide".
export function ask(instructions) {
  const line =
    String(instructions || "")
      .split("\n")
      .map((l) => l.trim())
      .find(Boolean) || "";
  let said = line.replace(marker, "");
  const end = said.search(/[.!?] /);
  if (end >= 0) said = said.slice(0, end + 1);
  said = said.replace(/\.$/, "").trim();
  if (said.length > 90) {
    const cut = said.slice(0, 90);
    said = (cut.includes(" ") ? cut.slice(0, cut.lastIndexOf(" ")) : cut) + "…";
  }
  return said;
}

// A person's step checks the work of the duck just before it. Otherwise it is
// the person's own work: the first step, or one after another person's.
export const stepKind = (columns, index) =>
  index > 0 && columns[index - 1].duck_id ? "check" : "doing";

export function checkersLine(checkers, last) {
  return (
    names(checkers) +
    (checkers.length === 1 ? " checks it" : " check it") +
    (last ? ", then the ticket is done." : " before it moves on.")
  );
}

// "at 4:41 PM" today, "on Sep 23, 2026, 4:41 PM" any other day.
export function when(iso, now = new Date()) {
  const d = new Date(iso);
  return d.toDateString() === now.toDateString()
    ? "at " + d.toLocaleTimeString(undefined, { timeStyle: "short" })
    : "on " +
        d.toLocaleString(undefined, {
          dateStyle: "medium",
          timeStyle: "short",
        });
}

// A handoff as plain words, for a card too small to hold Markdown.
const plain = (md) =>
  String(md || "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .split("\n")
    .map((l) => l.trim().replace(marker, ""))
    .join(" ")
    .replace(/[*`~]+/g, "")
    .replace(/\s+/g, " ")
    .trim();

// The panel for the stage the ticket is on: which of its modes it is in, the
// chip, the heading and the line under it. First match wins, in the order the
// engine can leave a ticket in.
export function panelFor({
  legacy,
  ticket,
  task,
  columns,
  runs = [],
  active: going,
  me,
  members = [],
  ducks = [],
  canDoTasks,
  consultation,
  queuedJob,
  arrived,
  now = new Date(),
}) {
  const duckOf = (id) => ducks.find((d) => d.id === id) || null;
  const at = columns.findIndex((c) => c.id === ticket.column_id);
  const column = columns[at] || {};
  const who = whoHasIt({
    ticket,
    task,
    column,
    isLast: at === columns.length - 1,
    legacy,
    runs,
    ducks,
    members,
    me,
    canDoTasks,
  });
  const make = (mode, tone, chip, h2, extra = {}) => {
    const said = extra.said || lower(chip);
    return {
      mode,
      tone,
      chip,
      said,
      h2,
      // The stage's name, or on General whoever has it, and the chip's words.
      label: (extra.stage || h2) + (said ? ", " + said : ""),
      who,
      line: null,
      hint: null,
      ...extra,
    };
  };
  const person = (id) => members.find((m) => m.id === id)?.name;
  const otherStageActive =
    ["running", "waiting_human", "waiting_consultation"].includes(
      task.running_status,
    ) ||
    runs.some(
      (run) =>
        run.status !== "queued" &&
        ["running", "waiting_human", "waiting_consultation"].includes(
          run.status,
        ),
    );
  const waitingJob =
    queuedJob ||
    (task.running_status === "queued"
      ? {
          status: "queued",
          duck_id: task.running_duck,
          queue_reason: task.queue_reason,
        }
      : runs.find(
          (r) =>
            r.status === "queued" &&
            r.task_id === ticket.task_id &&
            r.column_id === ticket.column_id &&
            r.revision === ticket.revision,
        ));
  const queued =
    !otherStageActive && waitingJob?.status === "queued"
      ? queueReason(waitingJob) || {
          label: "Waiting to start",
          detail: "This ticket starts when its duck is available.",
        }
      : null;

  if (legacy) {
    const duck = duckOf(task.assignee_id);
    const h2 = duck ? duck.name : "Nobody on it yet";
    if (task.status === "done") return make("done", "ok", "Done", h2);
    if (
      RECOVERY_STATES.has(task.recovery?.state) &&
      !task.asked &&
      (!task.running || task.running === task.recovery.job_id)
    )
      return make(
        "recovery",
        task.recovery.state === "needs_attention" ? "danger" : "wait",
        recoveryLabel(task.recovery.state),
        h2,
      );
    if (going && task.running_status === "waiting_human")
      return make(
        "busy",
        "attn",
        me && task.running_by === me
          ? "Waiting for you"
          : "Waiting for " + (person(task.running_by) || "a teammate"),
        h2,
        { hint: "The duck is waiting for an answer before it can go on." },
      );
    if (going && task.running_status === "waiting_consultation")
      return make("busy", "wait", "Waiting", h2, {
        hint: `${duck?.name || "Duck"} is waiting for ${consultation?.to_duck_name || "another duck"} and will continue when the answer arrives.`,
      });
    if (going)
      return queued
        ? make("busy", "wait", "Queued", h2, {
            queueReason: queued,
            said: "queued",
          })
        : make("busy", "accent", "On it now", h2, {
            hint: consultation
              ? `${duck?.name || "Duck"} is waiting for ${consultation.to_duck_name || "another duck"} and will continue when the answer arrives.`
              : duck
                ? duck.name + " is working on this now."
                : "A run is going on this ticket.",
          });
    if (who.kind === "stuck")
      return make("stuck", "danger", null, h2, { said: "stuck" });
    if (task.asked && task.status === "working")
      return make(
        "asked",
        "attn",
        task.asked_of === me
          ? "Waiting for you"
          : "Waiting for " + (person(task.asked_of) || "a teammate"),
        h2,
      );
    return duck
      ? make("idle", "wait", who.status, h2)
      : make("idle", "wait", null, h2, {
          hint: "No duck is on this ticket yet. Pick one under Edit ticket and this turns on.",
        });
  }

  const name = column.name;
  const current = runs.filter(
    (r) =>
      r.task_id === ticket.task_id &&
      r.column_id === ticket.column_id &&
      r.revision === ticket.revision,
  );
  const live = current.filter((r) => active.includes(r.status));
  const turn =
    who.kind === "you"
      ? "Your turn"
      : who.kind === "person"
        ? who.name + "’s turn"
        : "Waiting for a person";
  const turnSaid = who.kind === "person" ? turn : lower(turn);
  const sentence = (duck, words) => ({
    duck,
    text: (duck?.name || "The duck") + words,
  });
  const meta = arrived
    ? (arrived.sent_back ? "Sent back from " : "Arrived from ") +
      arrived.from +
      " " +
      when(arrived.at, now)
    : "";
  const asks = ask(column.instructions);
  // The instructions fold is worth showing when it says more than the heading.
  const fold =
    !!column.instructions?.trim() &&
    column.instructions.trim().replace(/\.$/, "") !== asks;
  const base = { stage: name, meta, ask: asks, fold };

  if (ticket.state === "complete" || who.kind === "done")
    return make("done", "ok", "Done", name, base);
  if (ticket.state === "blocked" || ticket.state === "changes_requested")
    return make(
      "stuck",
      "danger",
      ticket.state === "blocked" ? "Stuck" : "Changes requested",
      name,
      base,
    );
  if (
    RECOVERY_STATES.has(task.recovery?.state) &&
    !live.some((run) =>
      ["running", "waiting_human", "waiting_consultation"].includes(run.status),
    ) &&
    (!task.running || task.running === task.recovery.job_id)
  )
    return make(
      "recovery",
      task.recovery.state === "needs_attention" ? "danger" : "wait",
      recoveryLabel(task.recovery.state),
      name,
      base,
    );
  if (going) {
    if (queued)
      return make("queued", "wait", "Queued", name, {
        ...base,
        line: { duck: duckOf(waitingJob.duck_id), text: queued.label },
        queueReason: queued,
      });
    const asking = live.find((r) => r.status === "waiting_human");
    const consulting = live.find((r) => r.status === "waiting_consultation");
    const checking = live.find(
      (r) => r.role === "reviewer" && r.status === "running",
    );
    if (asking)
      return make(
        "asking",
        "attn",
        ticket.runner_id === me
          ? "Waiting for you"
          : "Waiting for " + (person(ticket.runner_id) || "a teammate"),
        name,
        {
          ...base,
          line: sentence(
            duckOf(asking.duck_id),
            " is waiting for an answer before it can go on.",
          ),
        },
      );
    if (consulting)
      return make("consulting", "wait", "Waiting", name, {
        ...base,
        line: sentence(
          duckOf(consulting.duck_id),
          " is waiting for " +
            (consultation?.to_duck_name || "another duck") +
            " and will continue when the answer arrives.",
        ),
      });
    if (checking)
      return make("checking", "accent", "Checking it now", name, {
        ...base,
        line: sentence(duckOf(checking.duck_id), " is checking it."),
      });
    return make("working", "accent", "On it now", name, {
      ...base,
      line: sentence(
        duckOf(live.find((r) => r.status === "running")?.duck_id) ||
          duckOf(task.running_duck) ||
          duckOf(column.duck_id),
        " is on it.",
      ),
    });
  }
  if (ticket.state === "waiting")
    return make("waiting", "wait", "Waiting", name, {
      ...base,
      hint: ticket.error || null,
    });
  if (ticket.state === "ready_to_move")
    return make("finished", "attn", turn, name + " is finished", {
      ...base,
      said: turnSaid,
    });
  if (ticket.state === "reviewing")
    return make("checks-next", "accent", who.status, name, {
      ...base,
      line: who.duck ? sentence(who.duck, " checks it next.") : null,
      hint: who.duck ? null : "Being checked.",
    });
  if (personStep(column, at === columns.length - 1))
    return make("turn", "attn", turn, asks ? name + ": " + asks : name, {
      ...base,
      said: turnSaid,
    });
  const duck = duckOf(column.duck_id);
  return make("next-up", "accent", who.status || "Up next", name, {
    ...base,
    line: sentence(
      duck,
      ticket.state === "working" ? " is on it." : " starts soon.",
    ),
  });
}

// One card per step of the board, in order: the ones behind the ticket, the
// one it is on, and the ones ahead.
export function cardsFor({
  legacy,
  ticket,
  columns,
  stages,
  panel,
  me,
  members = [],
  ducks = [],
}) {
  if (legacy) return [];
  const duckOf = (id) => ducks.find((d) => d.id === id) || null;
  const p = columns.findIndex((c) => c.id === ticket.column_id);
  const complete = ticket.state === "complete";
  const record = (c) =>
    stages?.find((x) => x.column_id === c.id && x.by) || null;
  const finishLine = (c, i) =>
    !personStep(c, i === columns.length - 1) && !c.duck_id;
  return columns.map((c, i) => {
    const base = { id: c.id, name: c.name, finish: finishLine(c, i) };
    if (i < p) {
      const r = record(c);
      if (!r)
        return {
          ...base,
          place: "missed",
          who: { text: "No work saved" },
          label: c.name + ", no work saved",
        };
      const duck = duckOf(r.by.duck_id);
      const by = duck?.name || r.by.name || "A teammate";
      const docs = r.documents || [];
      return {
        ...base,
        place: "done",
        who: duck ? { text: by, duck } : { text: by, person: by },
        made: docs.length
          ? { title: docs[0].title, more: docs.length - 1 }
          : null,
        line3: docs.length ? null : plain(r.summary) || null,
        label: c.name + ", done by " + by,
      };
    }
    if (i === p) {
      const who = panel.who,
        mode = panel.mode;
      const runner = members.find((m) => m.id === ticket.runner_id);
      const duck = panel.line?.duck || who.duck || duckOf(c.duck_id);
      // Whoever has it: the person it waits for on a person's step, the duck
      // on a duck's.
      const line2 =
        mode === "done"
          ? { text: "Done" }
          : ["turn", "finished", "asking"].includes(mode) ||
              (mode === "stuck" && !duck)
            ? who.kind === "you" || who.mine
              ? { text: "You", person: members.find((m) => m.id === me)?.name }
              : who.kind === "person"
                ? { text: who.name, person: who.name }
                : mode === "stuck" && runner
                  ? { text: runner.name, person: runner.name }
                  : { text: "Nobody yet" }
            : duck
              ? { text: duck.name, duck }
              : { text: "Nobody yet" };
      const line3 = {
        done: new Date(ticket.updated).toLocaleString(undefined, {
          dateStyle: "medium",
          timeStyle: "short",
        }),
        turn: panel.ask ? panel.ask + "." : null,
        finished: "Finished. Ready to move on.",
        asking: panel.chip,
        consulting: "Waiting",
        waiting: "Waiting",
        stuck: panel.chip,
      }[mode];
      return {
        ...base,
        place: "current",
        tone: panel.tone,
        chip:
          ["turn", "finished"].includes(mode) && who.kind === "you"
            ? "Your turn"
            : null,
        who: line2,
        line3: line3 === undefined ? who.status || panel.chip : line3,
        danger: mode === "stuck",
        label:
          c.name +
          ", now: " +
          (line2.duck ? line2.duck.name + ", " : "") +
          panel.said,
      };
    }
    const duck = duckOf(c.duck_id);
    return {
      ...base,
      place: i === p + 1 ? "next" : "later",
      who: { text: i === p + 1 ? "Next" : "Later" },
      line3: base.finish
        ? "Done when it gets here."
        : duck
          ? duck.name + " does it."
          : "A person does it.",
    };
  });
}

// The button that moves the ticket on, and what it sends.
export function primaryFor({ mode, columns, column, ducks = [], note = "" }) {
  const index = columns.findIndex((c) => c.id === column.id),
    next = columns[index + 1];
  if (mode === "stuck")
    return {
      label: "Start a new attempt",
      icon: "retry",
      path: "retry",
      body: { feedback: note },
      toast: null,
    };
  if (mode === "finished" && next)
    return {
      label: (column.duck_id ? "Approve, move to " : "Move to ") + next.name,
      icon: column.duck_id ? "check" : "move",
      path: "move",
      body: { column_id: next.id, note },
      toast: "Moved to " + next.name,
    };
  if (mode !== "turn") return null;
  const check = stepKind(columns, index) === "check",
    checkers = (column.approvers || []).map(
      (id) => ducks.find((d) => d.id === id)?.name || "A duck",
    ),
    moves = !checkers.length && !!next;
  return {
    label: check
      ? moves
        ? "Approve, move to " + next.name
        : "Approve"
      : "Finish your step",
    icon: "check",
    path: "complete",
    body: {
      summary: note.trim() || (check ? "Approved." : "Done."),
      move: true,
    },
    toast: checkers.length
      ? "Sent to " + names(checkers) + " to check"
      : moves
        ? "Moved to " + next.name
        : null,
  };
}
