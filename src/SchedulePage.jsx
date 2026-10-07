// One scheduled task's own page: what it found, newest first; how it is set
// up, changed in place; and at the foot, set apart, Delete.
//
// The list used to carry all of it - five text links on every row, twenty grey
// lines of "finished" under each, and a red Delete beside Edit that asked
// through the browser's own box - and still never said what the duck found.
import React, { useEffect, useRef, useState } from "react";
import {
  ArrowUpRight,
  CirclePause,
  Columns3,
  Loader2,
  Pause,
  Play,
  Trash2,
} from "lucide-react";
import { api, Avatar, Button } from "./ui.jsx";
import {
  ScheduleForm,
  RunIcon,
  RunMark,
  boardName,
  whoAndWhen,
} from "./Schedules.jsx";
import { routePath } from "./navigation.mjs";
import { readable } from "../shared/schedule-times.mjs";
import {
  appendEarlier,
  foldRuns,
  foldedWhen,
  mergeLatest,
  stoppedWhy,
  whenLabel,
} from "./schedule-feed.mjs";
import { asksForAI, whyHere } from "./inbox-list.mjs";
import { canConnectAI } from "../shared/ai-access.mjs";

export default function SchedulePage({ data, action, go, notify, scheduleId }) {
  if (scheduleId === "new")
    return (
      <div className="page sched-page">
        <div className="sched">
          <ScheduleForm data={data} action={action} go={go} existing={null} />
        </div>
      </div>
    );
  const s = (data.schedules || []).find((x) => x.id === scheduleId);
  // Gone: the next look at the workspace takes this page back to the list
  // and says so.
  if (!s) return <div className="page sched-page" />;
  return (
    <OneSchedule
      key={s.id}
      s={s}
      data={data}
      action={action}
      go={go}
      notify={notify}
    />
  );
}

// A link inside the app that is still a link: it opens in a new tab, and it
// can be copied - at the answer it is about, too.
const linkTo = (go, view, companyId) => ({
  href:
    routePath({ ...view, companyId }) +
    (view.at ? "?at=" + encodeURIComponent(view.at) : ""),
  onClick: (e) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button) return;
    e.preventDefault();
    go(view);
  },
});

function OneSchedule({ s, data, action, go, notify }) {
  const timezone = s.timezone || data.company.timezone || "UTC";
  const duck = data.ducks.find((d) => d.id === s.duck_id);
  const board = s.board_id
    ? (data.workflows?.boards || []).find((b) => b.id === s.board_id)
    : null;
  const why = stoppedWhy(s);
  // Stopped for something turning it back on does not fix. Its duck taken off
  // the team: turning it back on is refused until it has another. No AI:
  // turning it back on only stops it again. What fixes it comes first.
  const duckGone = s.paused && !s.board_id && (!duck || !!duck.removed);
  const wantsAI =
    s.paused &&
    asksForAI({ needs_you: why }) &&
    canConnectAI(data.role, data.permissions);
  const page = useRef(null);
  const acts = useRef(null);
  const [pressed, setPressed] = useState("");
  // Where the keyboard goes once a press is done: the button now in its
  // place. Pause and Turn back on replace each other, and a busy button
  // cannot hold focus, so it fell to the top of the window.
  const [focusNext, setFocusNext] = useState("");
  useEffect(() => {
    if (!focusNext || pressed) return;
    const at = document.activeElement;
    if (!at || at === document.body || acts.current?.contains(at))
      acts.current?.querySelector(`[data-act="${focusNext}"]`)?.focus();
    setFocusNext("");
  }, [focusNext, pressed, s.paused]);
  const press = async (name, fn, next) => {
    setPressed(name);
    let done = null;
    try {
      done = await fn();
    } finally {
      setPressed("");
      setFocusNext(done ? next : name);
    }
  };
  const setPaused = (paused) =>
    press(
      paused ? "pause" : "resume",
      () =>
        action(
          () => api("/schedules/" + s.id, "PATCH", { paused }),
          paused ? "Paused" : "Turned back on",
        ),
      paused ? "resume" : "pause",
    );
  // The server decides whether it actually started: the previous run may
  // still be going, or there may be no AI connected. Say what happened, not
  // what was asked for.
  const runNow = () =>
    press(
      "run",
      async () => {
        const r = await action(() =>
          api("/schedules/" + s.id + "/run", "POST", {}),
        );
        if (r) notify(r.outcome);
        return r;
      },
      "run",
    );
  const chooseDuck = () => {
    const ducks = page.current?.querySelector(".sched-form .sched-faces");
    ducks?.scrollIntoView({ block: "center" });
    ducks?.querySelector("input")?.focus({ preventScroll: true });
  };
  const runner =
    s.runner_id === data.user.id
      ? null
      : data.members.find((m) => m.id === s.runner_id)?.name ||
        "somebody who has left";
  const zone =
    s.timezone && s.timezone !== (data.company.timezone || "UTC")
      ? " " + s.timezone
      : "";
  const when = s.paused
    ? "Paused, so it will not run until somebody turns it back on. "
    : s.next_at
      ? "Next: " + whenLabel(s.next_at, timezone) + zone + ". "
      : "It will not run again. ";
  const where = s.board_id
    ? "Each time, it becomes a new ticket on " +
      boardName(board) +
      ", and the board decides which duck picks it up."
    : "Answers go to " +
      (runner ? runner + "’s" : "your") +
      " chat with " +
      (duck?.name || "its duck") +
      ", and only become a ticket when it finds something " +
      (runner ? "they need" : "you need") +
      " to see.";
  return (
    <div className="page sched-page" ref={page}>
      {/* The same words Needs you uses for it, which is where it sends
          people from. */}
      {why && (
        <p className="sched-band">
          <CirclePause size={15} aria-hidden="true" />
          {whyHere({ needs_you: why, origin: "schedule-paused:" + s.id }, "")}
        </p>
      )}
      <div className="sched">
        <div className="sched-head">
          <div className="sched-head-main">
            {s.board_id ? (
              <span className="schedule-board-icon" aria-hidden="true">
                <Columns3 size={17} />
              </span>
            ) : (
              <Avatar duck={duck} size={33} />
            )}
            <div>
              <p className="sched-meta">
                <b>{whoAndWhen(s, data, false)}</b>
              </p>
              <p className={why ? "sched-why" : "sched-meta"}>
                {why || when + where}
              </p>
            </div>
          </div>
          <div className="sched-acts" ref={acts}>
            {!s.paused ? (
              <>
                <Button
                  className="secondary"
                  data-act="run"
                  busy={pressed === "run"}
                  onClick={runNow}
                >
                  <Play size={15} aria-hidden="true" /> Run now
                </Button>
                <Button
                  className="secondary"
                  data-act="pause"
                  busy={pressed === "pause"}
                  onClick={() => setPaused(true)}
                >
                  <Pause size={15} aria-hidden="true" /> Pause
                </Button>
              </>
            ) : duckGone ? (
              <Button data-act="choose" onClick={chooseDuck}>
                Choose another duck
              </Button>
            ) : (
              <>
                {wantsAI && (
                  <Button
                    data-act="connect"
                    onClick={() => go({ type: "settings", tab: "ai" })}
                  >
                    Connect an AI
                  </Button>
                )}
                <Button
                  className={wantsAI ? "secondary" : ""}
                  data-act="resume"
                  busy={pressed === "resume"}
                  onClick={() => setPaused(false)}
                >
                  <Play size={15} aria-hidden="true" /> Turn back on
                </Button>
              </>
            )}
          </div>
        </div>
        <h2 className="sched-h">What it found</h2>
        <Feed s={s} data={data} go={go} timezone={timezone} runner={runner} />
        <h2 className="sched-h">How it is set up</h2>
        <ScheduleForm data={data} action={action} go={go} existing={s} />
        <DeleteBox s={s} action={action} go={go} />
      </div>
    </div>
  );
}

// How many lines of what it found the page opens on, and how many more each
// "Show earlier runs" adds. Thirty runs at once put how it is set up, and
// Delete, a screen and a half further down than the design has them.
const FIRST = 5;
const MORE = 10;
// A run still going, which changes to what it found when it finishes.
const UNSETTLED = new Set(["working", "queued", "waiting"]);
// What it found, newest first, with the quiet runs folded into a line.
function Feed({ s, data, go, timezone, runner }) {
  const [feed, setFeed] = useState({ runs: null, more: false });
  const [shown, setShown] = useState(FIRST);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [attempt, setAttempt] = useState(0);
  // After Show earlier runs: the first line that came in, or the button.
  const [reach, setReach] = useState(null);
  const wrap = useRef(null);
  // A new run, or one that has just finished, changes the schedule's last run,
  // and the workspace says so; fetching runs does not refresh the workspace,
  // so this cannot loop. But a newer run skipped because this one was still
  // going is the last run then, and does not change when this one finishes,
  // so while a run on screen is going, every fresh look at the workspace
  // fetches the newest runs too.
  const version = JSON.stringify(s.last_run);
  const going = !!feed.runs?.some((r) => UNSETTLED.has(r.kind));
  useEffect(() => {
    let current = true;
    api("/schedules/" + s.id + "/runs")
      .then((page) => {
        if (!current) return;
        setError("");
        setFeed((previous) => mergeLatest(previous, page));
      })
      .catch((e) => current && setError(e.message));
    return () => {
      current = false;
    };
  }, [version, attempt, going ? data : null]);
  useEffect(() => {
    if (reach === null || loading) return;
    const at = document.activeElement;
    if (!at || at === document.body || wrap.current?.contains(at))
      (
        (reach !== "button" &&
          wrap.current?.querySelectorAll(".sched-feed > li")[reach]) ||
        wrap.current?.querySelector(".sched-earlier")
      )?.focus();
    setReach(null);
  }, [reach, loading]);
  const items = feed.runs ? foldRuns(feed.runs) : [];
  // Quiet runs fold into the line above them, so one page of them could add
  // nothing to see, and the button looked broken. It fetches until there is
  // something new to show, or nothing more - ten pages at most a press.
  const earlier = async () => {
    const want = shown + MORE;
    let now = feed;
    setLoading(true);
    try {
      for (
        let n = 0;
        n < 10 && now.more && foldRuns(now.runs).length <= want;
        n++
      ) {
        const page = await api(
          "/schedules/" +
            s.id +
            "/runs?before=" +
            encodeURIComponent(now.runs.at(-1).id),
        );
        now = appendEarlier(now, page);
        setFeed((previous) => appendEarlier(previous, page));
      }
      setError("");
      setShown(want);
      setReach(shown);
    } catch (e) {
      setError(e.message);
      setReach("button");
    } finally {
      setLoading(false);
    }
  };
  // A message that already ends "Try again." does not need the button to say
  // it twice.
  const trouble = error.replace(/\s*Try again\.?$/, "");
  if (!feed.runs)
    return (
      <p className="sched-empty" role="status">
        {error ? (
          <>
            {trouble}{" "}
            <button
              type="button"
              className="text-button"
              onClick={() => setAttempt((n) => n + 1)}
            >
              Try again
            </button>
          </>
        ) : (
          <>
            <Loader2 className="spin" size={15} aria-hidden="true" /> Loading
            what it found…
          </>
        )}
      </p>
    );
  // Somebody opening this to find out why their scheduled task had not run
  // was once told nothing at all - which is the one question they came with.
  if (!feed.runs.length)
    return (
      <p className="sched-empty">
        This has not run yet.{" "}
        {s.paused
          ? "It is paused, so it will not run until somebody turns it back on."
          : s.next_at
            ? "First run: " + readable(s.next_at, timezone) + "."
            : ""}
      </p>
    );
  return (
    <div ref={wrap}>
      <ol className="sched-feed">
        {items.slice(0, shown).map((item) =>
          item.quiet ? (
            <li
              className="sched-quiet"
              key={item.quiet[0].id}
              data-runs={item.quiet.length}
              tabIndex={-1}
            >
              <RunIcon tone="quiet" />
              <span>
                {foldedWhen(
                  item.quiet.map((r) => r.due),
                  timezone,
                )}{" "}
                · {item.words}
              </span>
            </li>
          ) : (
            <li key={item.run.id} tabIndex={-1}>
              <RunCard
                run={item.run}
                data={data}
                go={go}
                timezone={timezone}
                runner={runner}
              />
            </li>
          ),
        )}
      </ol>
      {error && (
        <p className="sched-empty" role="status">
          {error}
        </p>
      )}
      {(feed.more || items.length > shown) && (
        <Button
          type="button"
          className="secondary sched-earlier"
          busy={loading}
          onClick={earlier}
        >
          Show earlier runs
        </Button>
      )}
    </div>
  );
}

const RUN_WORDS = {
  replied: ["said", "Replied"],
  raised: ["said", "Found something"],
  failed: ["bad", "Did not finish"],
  working: ["working", "Working now"],
  queued: ["", "Waiting its turn"],
  waiting: ["", "Waiting for a person"],
  ticket: ["ticket", "Made a ticket"],
};
function RunCard({ run, data, go, timezone, runner }) {
  const [tone, words] = RUN_WORDS[run.kind] || ["", "Ran"];
  const company = data.company.id;
  // A ticket on a board opens on its board.
  const boardId = data.workflows?.tickets?.find(
    (t) => t.task_id === run.task_id,
  )?.board_id;
  // Every link on the page read "Open in chat"; each is described by its
  // run's time, so a screen reader can tell them apart.
  const when = "sched-when-" + run.id;
  return (
    <div className={"sched-run" + (tone === "bad" ? " bad" : "")}>
      <p className="sched-run-head">
        {tone === "working" ? (
          <RunMark tone="working" />
        ) : tone ? (
          <RunIcon tone={tone} />
        ) : null}
        <span className="sched-when" id={when}>
          {whenLabel(run.due, timezone)}
        </span>
        <span className={tone === "bad" ? "sched-bad" : "sched-what"}>
          {words}
        </span>
        <span className="sched-links">
          {run.task_id && (run.kind === "ticket" || run.kind === "raised") && (
            <a
              className="sched-link"
              aria-describedby={when}
              {...linkTo(
                go,
                {
                  type: "tasks",
                  id: run.task_id,
                  ...(boardId ? { boardId } : {}),
                },
                company,
              )}
            >
              Open the ticket
              <ArrowUpRight size={14} aria-hidden="true" />
            </a>
          )}
          {run.conversation_id ? (
            <a
              className="sched-link"
              aria-describedby={when}
              {...linkTo(
                go,
                {
                  type: "chat",
                  id: run.conversation_id,
                  ...(run.thread_id ? { threadId: run.thread_id } : {}),
                  ...(run.message_id ? { at: run.message_id } : {}),
                },
                company,
              )}
            >
              Open in chat
              <ArrowUpRight size={14} aria-hidden="true" />
            </a>
          ) : (
            run.kind !== "ticket" &&
            runner && <span className="sched-whose">In {runner}’s chat</span>
          )}
        </span>
      </p>
      {run.said && (
        <blockquote>
          {run.said}
          {run.cut ? "…" : ""}
        </blockquote>
      )}
    </div>
  );
}

// Set apart at the foot, and it asks - here, beside the button, not in the
// browser's own box.
function DeleteBox({ s, action, go }) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const keep = useRef(null),
    ask = useRef(null),
    moved = useRef(false),
    mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    // Focus goes to the safe answer, and back to Delete… when kept.
    if (!moved.current) return void (moved.current = true);
    (asking ? keep : ask).current?.focus();
  }, [asking]);
  const remove = async () => {
    setBusy(true);
    const done = await action(async () => {
      const r = await api("/schedules/" + s.id, "DELETE");
      // Off this page before the workspace is looked at again, or that look
      // finds the page's schedule gone and says it no longer exists. Only if
      // this is still the page on screen: one that finished late took
      // somebody off another schedule, and what they were typing there.
      if (mounted.current)
        go({ type: "tasks", scheduled: true }, { replace: true, asked: true });
      return r;
    }, "Scheduled task deleted");
    if (!done && mounted.current) setBusy(false);
  };
  if (!asking)
    return (
      <div className="sched-danger">
        <span>
          <b>Delete this scheduled task.</b> Its history of runs goes with it,
          and this cannot be undone.
        </span>
        <div>
          <button
            type="button"
            className="sched-delq"
            ref={ask}
            onClick={() => setAsking(true)}
          >
            <Trash2 size={15} aria-hidden="true" />
            Delete…
          </button>
        </div>
      </div>
    );
  return (
    <div
      className="sched-danger"
      role="alertdialog"
      aria-label="Delete this scheduled task"
      aria-describedby="sched-delete-question"
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        e.stopPropagation();
        setAsking(false);
      }}
    >
      <span id="sched-delete-question">
        <b>Delete it and all its runs?</b>
        {!s.paused && " To stop it for now, use Pause instead."}
      </span>
      <div>
        <button
          type="button"
          className="button secondary"
          ref={keep}
          onClick={() => setAsking(false)}
        >
          Keep it
        </button>
        <button
          type="button"
          className="sched-del"
          disabled={busy}
          onClick={remove}
        >
          {busy && <Loader2 className="spin" size={16} aria-hidden="true" />}
          Delete
        </button>
      </div>
    </div>
  );
}
