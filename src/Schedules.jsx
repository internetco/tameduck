import React, { useEffect, useRef, useState } from "react";
import {
  Clock,
  Plus,
  Columns3,
  ChevronRight,
  CirclePause,
  MessageCircle,
  Minus,
  TriangleAlert,
} from "lucide-react";
import {
  api,
  Avatar,
  Button,
  Field,
  Empty,
  flock,
  useUnsavedGuard,
} from "./ui.jsx";
import {
  describe,
  nextFire,
  readable,
  isFrequent,
  instantOf,
  clockAt,
  MINUTE_CHOICES,
} from "../shared/schedule-times.mjs";
import { routePath } from "./navigation.mjs";
import {
  keepTyped,
  lastRunLine,
  nextLine,
  shortWhy,
  stoppedWhy,
} from "./schedule-feed.mjs";
import "./schedules.css";
// A one-off is a date and a time on the company's clock, not the browser's.
const onceAt = (date, time, timezone) => {
  const [y, m, d] = String(date || "")
    .split("-")
    .map(Number);
  if (!y || !m || !d) return NaN;
  const [h, min] = String(time || "09:00")
    .split(":")
    .map(Number);
  return instantOf(y, m, d, h * 60 + min, timezone);
};
const DAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];
const REPEAT_LABELS = [
  ["weekdays", "Every weekday (Mon–Fri)"],
  ["daily", "Every day"],
  ["weekly", "Every week"],
  ["monthly", "Every month"],
  ["hourly", "Every hour"],
  ["minutes", "Every few minutes"],
  ["once", "Once"],
];
const toMinute = (value) => {
  const [h, m] = String(value || "09:00").split(":");
  return Number(h) * 60 + Number(m);
};
const toClock = (minute) =>
  String(Math.floor((minute ?? 540) / 60)).padStart(2, "0") +
  ":" +
  String((minute ?? 540) % 60).padStart(2, "0");
// The times a person can pick, on a 24-hour clock like every time the product
// shows. The browser's own time box said "09:00 AM" to an English browser while
// the line under it said 09:00. A time a schedule already has stays on the
// list even when it is not on a quarter hour, or opening it would change it.
const timesOfDay = (...keep) =>
  [
    ...new Set([
      ...Array.from({ length: 96 }, (_, n) => toClock(n * 15)),
      ...keep.filter(Boolean),
    ]),
  ].sort();
// What the person is about to set up, in the words they would use, worked out
// by the same code the server schedules with so the two can never disagree.
// `lead` is who this happens to, in the words the form already uses: a duck
// does the work, or a board takes a ticket. Selecting a board leaves duck_id
// alone, so this named whichever duck happened to be first in the flock when
// the dialog opened - contradicting the hint two lines above it.
// `first` says when it would first happen, which is worth saying while it is
// being set up or changed, and repeats the heading once it is saved.
function preview(form, lead, timezone, first = true) {
  const at_minute = toMinute(form.time);
  if (form.repeat === "once") {
    if (!form.date) return "";
    const when = onceAt(form.date, form.time, timezone);
    return Number.isNaN(when)
      ? ""
      : `${lead} once, on ${readable(when, timezone)}.`;
  }
  const shape = {
    repeat: form.repeat,
    at_minute,
    on_day:
      form.repeat === "weekly"
        ? Number(form.weekday)
        : form.repeat === "monthly"
          ? Number(form.monthday)
          : null,
    every_minutes: Number(form.every_minutes) || 5,
    from_minute: form.window ? toMinute(form.from) : null,
    to_minute: form.window ? toMinute(form.to) : null,
    weekdays_only: form.weekdays_only,
    timezone,
  };
  const next = first && nextFire(shape, Date.now());
  // Only the first letter comes down: "every monday" read as a typo.
  const how = describe(shape);
  return (
    `${lead} ${how.charAt(0).toLowerCase() + how.slice(1)}.` +
    (next ? ` First time: ${readable(next, timezone)}.` : "")
  );
}
// A one-off still waiting to happen, which is the only kind that has a day and
// a time to put back into the form.
const once = (s) => s?.repeat === "once" && !!s.next_at;
// The form's fields for a schedule, or for a new one.
const formFrom = (existing, timezone) => ({
  who: existing?.board_id ? "board" : "duck",
  // A new one starts with no duck chosen. It used to start on whichever duck
  // was first in the flock, so a schedule meant for another one went to the
  // chief duck because nobody noticed the field.
  duck_id: existing?.duck_id || "",
  board_id: existing?.board_id || "",
  title: existing?.title || "",
  instructions: existing?.instructions || "",
  repeat: existing?.repeat || "weekdays",
  // A one-off keeps its day and time in next_at; at_minute is null for one.
  // Reading only at_minute meant opening an existing one-off for editing
  // showed a blank date and a time of 09:00, whatever it had actually been
  // set to - and saving it then came back "Choose the day and time this
  // should happen", about the day and time on the screen behind the dialog.
  // A one-off that has already run has no next_at and no day left to show,
  // so that one does ask for a new one.
  time: once(existing)
    ? clockAt(existing.next_at, timezone).time
    : toClock(existing?.at_minute),
  every_minutes: String(existing?.every_minutes || 5),
  window: existing?.from_minute !== null && existing?.from_minute !== undefined,
  from: toClock(existing?.from_minute ?? 540),
  to: toClock(existing?.to_minute ?? 1020),
  weekdays_only: !!existing?.weekdays_only,
  weekday: String(existing?.repeat === "weekly" ? existing.on_day : 1),
  monthday: String(existing?.repeat === "monthly" ? existing.on_day : 1),
  date: once(existing) ? clockAt(existing.next_at, timezone).date : "",
});
// What saving sends. A schedule on a board still names a duck, because the
// server keeps one on every schedule, but the board decides who does the work.
const bodyOf = (form, timezone, boardDuck) => ({
  duck_id: form.who === "board" ? boardDuck : form.duck_id,
  board_id: form.who === "board" ? form.board_id || null : null,
  title: form.title.trim(),
  instructions: form.instructions,
  repeat: form.repeat,
  every_minutes: form.repeat === "minutes" ? Number(form.every_minutes) : null,
  from_minute:
    isFrequent(form.repeat) && form.window ? toMinute(form.from) : null,
  to_minute: isFrequent(form.repeat) && form.window ? toMinute(form.to) : null,
  weekdays_only: isFrequent(form.repeat) && form.weekdays_only,
  at_minute: form.repeat === "once" ? null : toMinute(form.time),
  on_day:
    form.repeat === "weekly"
      ? Number(form.weekday)
      : form.repeat === "monthly"
        ? Number(form.monthday)
        : null,
  starts_at:
    form.repeat === "once" ? onceAt(form.date, form.time, timezone) : null,
});
// The boards a schedule can put a ticket on. The original board is not one,
// and nor is an archived one: nobody works on it.
const realBoards = (data) =>
  (data.workflows?.boards || []).filter((b) => !b.legacy && !b.archived);
// "Pricing watch board", without saying board twice.
export const boardName = (board) =>
  board
    ? /\bboard$/i.test(board.name)
      ? board.name
      : board.name + " board"
    : "A board that has gone";
// How it is set up, on the schedule's own page: changed in place, no dialog,
// and a page with changes nobody saved asks before it is left.
export function ScheduleForm({ data, action, go, existing }) {
  const timezone = existing?.timezone || data.company.timezone || "UTC";
  const ducks = flock(data);
  // The boards it can go on, and the one it is on, whatever that is.
  const boards = realBoards(data);
  const onNow = (data.workflows?.boards || []).find(
    (b) => b.id === existing?.board_id,
  );
  if (onNow && !boards.includes(onNow)) boards.push(onNow);
  const fresh = formFrom(existing, timezone);
  const freshKey = JSON.stringify(fresh);
  const [base, setBase] = useState(fresh);
  const [form, setForm] = useState(fresh);
  const [busy, setBusy] = useState(false);
  // Which choice is missing, said beside it.
  const [missing, setMissing] = useState("");
  // A field this form changed was also changed somewhere else.
  const [conflict, setConflict] = useState(false);
  const set = (key, value) => setForm((f) => ({ ...f, [key]: value }));
  const live = useRef({ form, base, busy });
  live.current = { form, base, busy };
  // Still on the page that sent a request when it comes back. A create or a
  // delete that finished after somebody had moved on took them back to it,
  // and threw away whatever they were typing there.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const boardDuck = (f) =>
    (ducks.some((d) => d.id === f.duck_id) && f.duck_id) ||
    ducks.find((d) => d.chief)?.id ||
    ducks[0]?.id ||
    "";
  const work = (f) => JSON.stringify(bodyOf(f, timezone, boardDuck(f)));
  const changed = work(form) !== work(base);
  const changedNow = useRef(changed);
  changedNow.current = changed;
  useUnsavedGuard(() => changedNow.current);
  // Saved somewhere else - by a teammate, another tab, or this form a moment
  // ago. Every field nobody has touched here shows it; one typed into keeps
  // what was typed.
  useEffect(() => {
    const next = JSON.parse(freshKey);
    const kept = keepTyped(live.current.form, live.current.base, next);
    setBase(next);
    setForm(kept.form);
    if (kept.conflict && !live.current.busy) setConflict(true);
  }, [freshKey]);
  useEffect(() => {
    if (!changed) setConflict(false);
  }, [changed]);
  const duck = ducks.find((d) => d.id === form.duck_id);
  const gone =
    form.who === "duck" && form.duck_id && !duck
      ? data.ducks.find((d) => d.id === form.duck_id)
      : null;
  const board = boards.find((b) => b.id === form.board_id);
  const onBoard = form.who === "board";
  const ref = useRef();
  // How often it was before a board made it daily, for going back to a duck.
  const beforeBoard = useRef(null);
  const choose = (who) => {
    setMissing("");
    // A board takes a ticket once a day at most, so it is never offered more.
    // Going back to a duck puts back what it was: one stray tap on "A board"
    // turned every five minutes into every day.
    let repeat = form.repeat;
    if (who === "board" && isFrequent(repeat)) {
      beforeBoard.current = repeat;
      repeat = "daily";
    } else if (who === "duck" && beforeBoard.current) {
      if (repeat === "daily") repeat = beforeBoard.current;
      beforeBoard.current = null;
    }
    setForm((f) => ({ ...f, who, repeat }));
  };
  const firstTime = !existing || changed;
  return (
    <form
      ref={ref}
      className="sched-form"
      aria-label={existing ? "How it is set up" : "New scheduled task"}
      onSubmit={async (e) => {
        e.preventDefault();
        const lack =
          form.who === "duck" && !duck
            ? "duck"
            : form.who === "board" && !board
              ? "board"
              : !form.title.trim()
                ? "title"
                : "";
        setMissing(lack);
        if (lack) {
          ref.current.querySelector(`input[name="sched-${lack}"]`)?.focus();
          return;
        }
        setBusy(true);
        const sent = form;
        const body = bodyOf(form, timezone, boardDuck(form));
        const r = await action(
          () =>
            existing
              ? api("/schedules/" + existing.id, "PATCH", body)
              : api("/schedules", "POST", body),
          existing ? "Scheduled task saved" : "Scheduled task created",
        );
        if (!mounted.current) return;
        setBusy(false);
        if (!r) return;
        if (!existing)
          return go(
            { type: "tasks", scheduled: true, scheduleId: r.id },
            { replace: true, asked: true },
          );
        // What was typed while it was on its way stays, unsaved.
        const saved = formFrom(r, r.timezone || timezone);
        setBase(saved);
        setForm((f) => keepTyped(f, sent, saved).form);
        setConflict(false);
      }}
    >
      {/* Ducks and boards were one list, so "Chief Duck" and "Content
          (board)" sat side by side as if they were the same kind of thing.
          Where the work goes is its own question, asked first. */}
      {(boards.length > 0 || onBoard) && (
        <fieldset className="sched-who">
          <legend>Who does it</legend>
          <label>
            <input
              type="radio"
              name="sched-who"
              checked={!onBoard}
              onChange={() => choose("duck")}
            />
            <span>
              <b>A duck</b>
              <i>In your chat with it, as often as every 5 minutes</i>
            </span>
          </label>
          <label>
            <input
              type="radio"
              name="sched-who"
              checked={onBoard}
              onChange={() => choose("board")}
            />
            <span>
              <b>A board</b>
              <i>A new ticket each time, once a day at most</i>
            </span>
          </label>
        </fieldset>
      )}
      {!onBoard ? (
        <fieldset
          className="sched-faces"
          aria-describedby={missing === "duck" ? "sched-missing" : undefined}
        >
          <legend>Which duck</legend>
          {ducks.map((d) => (
            <label className="sched-face" key={d.id}>
              <input
                type="radio"
                name="sched-duck"
                className="sched-sr"
                checked={form.duck_id === d.id}
                onChange={() => {
                  setMissing("");
                  set("duck_id", d.id);
                }}
              />
              <Avatar duck={d} size={28} />
              {d.name}
            </label>
          ))}
          {gone && (
            <p className="sched-note">
              {gone.name} was taken off the team. Choose another duck.
            </p>
          )}
          {missing === "duck" && (
            <p className="sched-missing" id="sched-missing" role="alert">
              Choose which duck does it.
            </p>
          )}
        </fieldset>
      ) : (
        <fieldset
          className="sched-faces"
          aria-describedby={missing === "board" ? "sched-missing" : undefined}
        >
          <legend>Which board</legend>
          {boards.map((b) => (
            <label className="sched-face" key={b.id}>
              <input
                type="radio"
                name="sched-board"
                className="sched-sr"
                checked={form.board_id === b.id}
                onChange={() => {
                  setMissing("");
                  set("board_id", b.id);
                }}
              />
              <span className="sched-face-board" aria-hidden="true">
                <Columns3 size={15} />
              </span>
              {b.name + (b.archived ? " (archived)" : "")}
            </label>
          ))}
          {missing === "board" && (
            <p className="sched-missing" id="sched-missing" role="alert">
              Choose which board it goes on.
            </p>
          )}
        </fieldset>
      )}
      <Field label="What should it do?">
        <input
          name="sched-title"
          value={form.title}
          onChange={(e) => {
            if (missing === "title") setMissing("");
            set("title", e.target.value);
          }}
          maxLength={200}
          required
          placeholder="Summarise yesterday's signups"
        />
      </Field>
      {/* Spaces pass "required", and the server's answer to them was its own
          check text, "Too small: expected string to have >=1 characters". */}
      {missing === "title" && (
        <p className="sched-missing" id="sched-missing" role="alert">
          Say what it should do.
        </p>
      )}
      <Field label="Any details?">
        <textarea
          value={form.instructions}
          onChange={(e) => set("instructions", e.target.value)}
          rows={3}
          maxLength={20000}
          // An example for a new one only. On a schedule's own page an empty
          // box showing it read as what that schedule had been told to do.
          placeholder={
            existing
              ? undefined
              : "Look at yesterday's signups and post a short summary: how many, where they came from, anything unusual."
          }
        />
      </Field>
      <div className="sched-row2">
        <Field label="How often?">
          <select
            value={form.repeat}
            onChange={(e) => set("repeat", e.target.value)}
          >
            {REPEAT_LABELS.filter(
              ([value]) => !onBoard || !isFrequent(value),
            ).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </Field>
        {form.repeat === "weekly" && (
          <Field label="On which day?">
            <select
              value={form.weekday}
              onChange={(e) => set("weekday", e.target.value)}
            >
              {DAYS.map((name, value) => (
                <option key={value} value={value}>
                  {name}
                </option>
              ))}
            </select>
          </Field>
        )}
        {form.repeat === "monthly" && (
          <Field
            label="On which day of the month?"
            hint="Months that are too short use their last day."
          >
            <select
              value={form.monthday}
              onChange={(e) => set("monthday", e.target.value)}
            >
              {Array.from({ length: 31 }, (_, n) => n + 1).map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </Field>
        )}
        {form.repeat === "minutes" && (
          <Field label="How many minutes apart?">
            <select
              value={form.every_minutes}
              onChange={(e) => set("every_minutes", e.target.value)}
            >
              {MINUTE_CHOICES.map((m) => (
                <option key={m} value={m}>
                  Every {m} minutes
                </option>
              ))}
            </select>
          </Field>
        )}
        {form.repeat === "once" && (
          <Field label="On which day?">
            <input
              type="date"
              value={form.date}
              onChange={(e) => set("date", e.target.value)}
              required
            />
          </Field>
        )}
        {!isFrequent(form.repeat) && (
          <Field
            label="At what time?"
            // The list names the company's clock. A schedule on another one
            // says which, here where its time is chosen.
            hint={
              timezone !== (data.company.timezone || "UTC")
                ? "Times are in " + timezone + "."
                : undefined
            }
          >
            <select
              value={form.time}
              onChange={(e) => set("time", e.target.value)}
            >
              {timesOfDay(form.time, base.time).map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </Field>
        )}
      </div>
      {isFrequent(form.repeat) && (
        <div className="sched-often">
          <label className="sched-check">
            <input
              type="checkbox"
              checked={form.window}
              onChange={(e) => set("window", e.target.checked)}
            />
            Only at certain times of day
          </label>
          {form.window && (
            <div className="sched-row2">
              <Field label="From">
                <select
                  value={form.from}
                  onChange={(e) => set("from", e.target.value)}
                >
                  {timesOfDay(form.from, base.from).map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Until">
                <select
                  value={form.to}
                  onChange={(e) => set("to", e.target.value)}
                >
                  {timesOfDay(form.to, base.to).map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
          )}
          <label className="sched-check">
            <input
              type="checkbox"
              checked={form.weekdays_only}
              onChange={(e) => set("weekdays_only", e.target.checked)}
            />
            Weekdays only
          </label>
        </div>
      )}
      {conflict && changed && (
        <p className="sched-note sched-conflict" role="status">
          This was changed somewhere else while you were editing it. Saving
          keeps what you see here.
        </p>
      )}
      <div className="sched-save">
        <p>
          {preview(
            form,
            onBoard
              ? "This becomes a ticket on " + (board?.name || "that board")
              : (duck?.name || "The duck you choose") + " will do this",
            timezone,
            firstTime,
          )}
        </p>
        <Button busy={busy}>
          {existing ? "Save changes" : "Create scheduled task"}
        </Button>
      </div>
    </form>
  );
}
// Who a schedule is for and what it does, in one line: "Ops Duck · Every
// weekday at 09:00", and whose it is when it is not yours - unless the line
// after it says whose chat the answers go to.
export function whoAndWhen(s, data, withWhom = true) {
  const duck = data.ducks.find((d) => d.id === s.duck_id);
  // A schedule aimed at a board still carries the duck that was picked in the
  // form, but the board decides who does the work, so naming that duck was
  // simply wrong.
  const who = s.board_id
    ? boardName((data.workflows?.boards || []).find((b) => b.id === s.board_id))
    : duck?.name || "A duck that has gone";
  // A schedule runs for somebody: unless it files onto a board, the answer
  // lands in that person's own chat with the duck and in their Needs you.
  const forWhom =
    withWhom && !s.board_id && s.runner_id !== data.user.id
      ? " · for " +
        (data.members.find((m) => m.id === s.runner_id)?.name ||
          "somebody who has left")
      : "";
  return who + " · " + s.summary + forWhom;
}
// The list only finds one: its name, its state, and what it did last.
// Everything else is on that schedule's own page.
export default function Schedules({ data, go }) {
  const timezone = data.company.timezone || "UTC";
  const schedules = data.schedules || [];
  const now = Date.now();
  const open = (e, view) => {
    // A new tab, or a copied link, still works the ordinary way.
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button) return;
    e.preventDefault();
    go(view);
  };
  return (
    <div className="page sched-page">
      <div className="sched">
        <div className="sched-intro">
          <p>
            Work your ducks do again and again, without being asked. Times are
            in {timezone}.
          </p>
          {data.permissions.tasks && (
            <Button
              onClick={() =>
                go({ type: "tasks", scheduled: true, scheduleId: "new" })
              }
            >
              <Plus size={16} /> New scheduled task
            </Button>
          )}
        </div>
        {/* Somebody who may not see them is sent here from a link, and was
            told "Nothing is scheduled yet. Pick a duck..." under "You don't
            have access". */}
        {!data.permissions.tasks ? (
          <Empty icon={Clock} title="You can't see scheduled tasks">
            Ask an owner or admin if you need to.
          </Empty>
        ) : (
          !schedules.length && (
            <Empty icon={Clock} title="Nothing is scheduled yet">
              Pick a duck, say what to do, and choose when. It happens on its
              own from then on.
            </Empty>
          )
        )}
        {schedules.length > 0 && (
          <ul className="sched-list">
            {schedules.map((s) => {
              const duck = data.ducks.find((d) => d.id === s.duck_id);
              const why = stoppedWhy(s);
              const last = lastRunLine(s, s.timezone || timezone, now);
              const view = {
                type: "tasks",
                scheduled: true,
                scheduleId: s.id,
                companyId: data.company.id,
              };
              return (
                <li key={s.id}>
                  <a
                    className={"sched-row" + (why ? " stopped" : "")}
                    href={routePath(view)}
                    onClick={(e) => open(e, view)}
                  >
                    {s.board_id ? (
                      <span className="schedule-board-icon" aria-hidden="true">
                        <Columns3 size={17} />
                      </span>
                    ) : (
                      <Avatar duck={duck} size={33} />
                    )}
                    <span className="sched-row-text">
                      <b>{s.title}</b>
                      <i>{whoAndWhen(s, data)}</i>
                    </span>
                    <span className="sched-row-state">
                      {/* A schedule that stopped by itself looked like one
                          that was running: the same white card and a 12px
                          grey "Paused". It wears the Needs-you colour now,
                          because that is where it sends people. */}
                      {why ? (
                        <>
                          <span>
                            <span className="sched-chip">
                              <CirclePause size={14} aria-hidden="true" />
                              Stopped
                            </span>
                          </span>
                          <i>{shortWhy(why)}</i>
                        </>
                      ) : s.paused ? (
                        <>
                          <span>
                            <CirclePause
                              size={15}
                              className="sched-mark"
                              aria-hidden="true"
                            />
                            Paused
                          </span>
                          <i>{last.text}</i>
                        </>
                      ) : (
                        <>
                          <RunMark tone={last.tone}>{last.text}</RunMark>
                          <i>{nextLine(s, timezone, now)}</i>
                        </>
                      )}
                    </span>
                    <ChevronRight
                      size={16}
                      className="sched-chev"
                      aria-hidden="true"
                    />
                  </a>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
// A line about a run, led by the mark that goes with what it did. The words
// carry it; the mark only repeats them.
export function RunMark({ tone, children }) {
  return (
    <span className={"sched-said" + (tone === "bad" ? " bad" : "")}>
      {tone === "working" ? (
        <span className="sched-dot" aria-hidden="true" />
      ) : tone ? (
        <RunIcon tone={tone} />
      ) : null}
      {children}
    </span>
  );
}
// A reply, a ticket, a run that did not finish, and a quiet one.
const MARKS = {
  said: MessageCircle,
  ticket: Columns3,
  bad: TriangleAlert,
  quiet: Minus,
};
export function RunIcon({ tone }) {
  const Mark = MARKS[tone];
  return <Mark size={15} className={"sched-mark " + tone} aria-hidden="true" />;
}
