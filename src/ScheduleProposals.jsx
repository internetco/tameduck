import React, { useEffect, useId, useRef, useState } from "react";
import {
  ArrowRight,
  Ban,
  Calendar,
  Check,
  CircleStop,
  Clock,
  Loader2,
  MessageSquare,
  Repeat,
  SquareKanban,
  Trash2,
} from "lucide-react";
import { api, Button } from "./ui.jsx";
import {
  answered,
  costs,
  costsInstead,
  nameOf,
  openUntil,
  question,
  stopWhen,
  zoneNote,
} from "./schedule-proposal-words.mjs";
import "./human-input.css";
import "./schedule-proposals.css";
const readerZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return "";
  }
};
// A duck asking to do something regularly, to change it, or to stop. It is the
// card every duck uses when it needs you: the band, the schedule as a
// question, what it means in plain ink, one button, and the wait and the way
// out in the foot.
// It used to be a blue bar over five grey labels with three answers of three
// sizes, the middle one a whole sentence that also handed the duck a lasting
// permission.
// head: in the Needs you list the line above the card is its heading, so there
// the card leaves off its band and its question. Everywhere else keeps them.
export function ScheduleProposalCard({
  proposal: p,
  data,
  action,
  go,
  head = true,
}) {
  // Which answer is on its way, "approve" or "decline". One flag for both
  // made the red Stop it spin while Keep it was being sent.
  const [busy, setBusy] = useState(null),
    [always, setAlways] = useState(false),
    [error, setError] = useState(""),
    [time, setTime] = useState(Date.now());
  const id = useId(),
    card = useRef(null),
    line = useRef(null),
    pressed = useRef(null),
    answeredHere = useRef(false),
    wasHere = useRef(false);
  const removing = p.operation === "remove",
    changing = p.operation === "update";
  const duck = data.ducks.find((d) => d.id === p.duck_id);
  const Name = duck?.name || "The duck";
  // The server says a card has lapsed when it next sends the list; the clock
  // says so the moment it does.
  const lapsed =
    p.status === "pending" && !!p.expires && Date.parse(p.expires) <= time;
  const asking = p.status === "pending" && !lapsed;
  useEffect(() => {
    if (!asking || !p.expires) return;
    const t = setTimeout(
      () => setTime(Date.now()),
      Math.min(Date.parse(p.expires) - Date.now() + 50, 2147483647),
    );
    return () => clearTimeout(t);
  }, [asking, p.expires]);
  useEffect(() => setError(""), [p.id, p.status]);
  // Whether the keyboard was last on this card, so that when the card turns
  // into its line under it - lapsed, or answered somewhere else - it is left
  // on the line rather than on nothing.
  useEffect(() => {
    if (!asking) return;
    const seen = (e) => (wasHere.current = !!card.current?.contains(e.target));
    document.addEventListener("focusin", seen);
    return () => document.removeEventListener("focusin", seen);
  }, [asking]);
  // The button that was pressed goes with the question, so whoever pressed it
  // is left on the line that says what they did rather than on nothing.
  useEffect(() => {
    if (asking) return;
    const lost =
      !document.activeElement || document.activeElement === document.body;
    if (answeredHere.current || (wasHere.current && lost))
      line.current?.focus();
    answeredHere.current = false;
    wasHere.current = false;
  }, [asking]);
  // A refused answer leaves the card asking, and the keyboard on the button
  // it pressed. The button was disabled while the answer was out, which took
  // the keyboard off it and dropped it on the page.
  useEffect(() => {
    if (busy || !pressed.current) return;
    const button = pressed.current;
    pressed.current = null;
    if (
      button.isConnected &&
      (!document.activeElement || document.activeElement === document.body)
    )
      button.focus();
  }, [busy]);
  async function decide(decision, event) {
    pressed.current = event?.currentTarget || null;
    setBusy(decision);
    setError("");
    try {
      const result = await api(
        "/schedule-proposals/" + p.id + "/decide",
        "POST",
        {
          decision,
          always: decision === "approve" && always,
          expected_operation: p.operation || "create",
        },
      );
      answeredHere.current = true;
      await action(
        async () => result,
        [
          (removing
            ? decision === "approve"
              ? "Stopped: "
              : "Kept: "
            : changing
              ? decision === "approve"
                ? "Changed: "
                : "Not changed: "
              : decision === "approve"
                ? "Set up: "
                : "Not set up: ") +
            (changing && decision === "approve" ? p.title : nameOf(p)),
          // The lasting permission is said out loud too, not only the answer.
          !removing &&
            !changing &&
            decision === "approve" &&
            always &&
            Name + " may now schedule work without asking",
          result.continuation?.message,
        ]
          .filter(Boolean)
          .join(". "),
      );
    } catch (e) {
      // Said on the card it is about, where the answer was being given. An
      // answer that never reached the server was said in the browser's own
      // words, "Failed to fetch", and again in a toast.
      if (!e.status)
        setError(
          "The server could not be reached. Check your connection and try again.",
        );
      else {
        setError(e.message);
        // The server may know something this card does not, such as
        // somebody else having answered.
        await action(async () => ({}));
      }
    } finally {
      setBusy(null);
    }
  }
  // Afterwards it is one line, and the line still says what was asked, who
  // answered and when: a tick for yes, a stop sign for no.
  if (!asking) {
    const said = answered(lapsed ? { ...p, status: "expired" } : p, {
      me: data.user?.id,
      duck: Name,
      schedule: (data.schedules || []).find((s) => s.id === p.schedule_id),
      readerZone: readerZone(),
    });
    const Mark = said.tone === "yes" ? Check : said.tone === "no" ? Ban : Clock;
    const opens = said.open && !!go;
    return (
      <p
        ref={line}
        tabIndex={-1}
        className={"human-input-done schedule-ask-done " + said.tone}
      >
        <Mark size={16} aria-hidden="true" />
        <span>
          <b>{said.what}</b>
          {said.rest && " " + said.rest}{" "}
          <i>
            {said.by}
            {said.open && (opens ? " ·" : ".")}
          </i>
          {opens && (
            <>
              {" "}
              {/* The scheduled tasks, in the app. This was a plain link, so
                  pressing it loaded the whole app again. */}
              <button
                type="button"
                className="schedule-ask-go"
                onClick={() => go({ type: "tasks", scheduled: true })}
              >
                Open scheduled tasks
                <ArrowRight size={14} aria-hidden="true" />
              </button>
            </>
          )}
        </span>
      </p>
    );
  }
  const zone = readerZone();
  const target = removing
    ? (data.schedules || []).find((s) => s.id === p.target_schedule_id)
    : null;
  // A schedule does its work in the chat, or puts a ticket on a board every
  // time, and the server's sentence for it says which.
  const Where = /^As a ticket on /.test(p.where || "")
    ? SquareKanban
    : MessageSquare;
  return (
    <section
      ref={card}
      className="human-input-card schedule-ask"
      // The name is not drawn, so a card with no visible heading keeps it.
      aria-label={Name + " needs you"}
    >
      {head && <p className="human-input-band">Needs you</p>}
      <div className="human-input-main">
        {head && <h4 className="human-input-title">{question(p)}</h4>}
        {!removing && !changing && p.instructions && (
          <p className="human-input-say">{p.instructions}</p>
        )}
        {changing && <ScheduleChanges proposal={p} />}
        {/* When, where it lands and what it keeps costing, in plain ink. */}
        <ul className="schedule-ask-facts">
          {removing ? (
            <li>
              <Clock size={16} aria-hidden="true" />
              <span>{stopWhen(p, target, zone)}</span>
            </li>
          ) : changing ? (
            p.paused ? (
              <li>
                <Clock size={16} aria-hidden="true" />
                <span>
                  It is paused. The change applies when somebody turns it back
                  on.
                </span>
              </li>
            ) : (
              p.next_run && (
                <li>
                  <Calendar size={16} aria-hidden="true" />
                  <span>
                    From its next run, {p.next_run}
                    {zoneNote(p.timezone, zone)}
                  </span>
                </li>
              )
            )
          ) : (
            p.first_run && (
              <li>
                <Calendar size={16} aria-hidden="true" />
                <span>
                  First run {p.first_run}
                  {zoneNote(p.timezone, zone)}
                </span>
              </li>
            )
          )}
          {/* A change says where its work goes only when that changes, in
              the list of changes above. */}
          {p.where && !changing && (
            <li>
              <Where size={16} aria-hidden="true" />
              <span>{p.where}</span>
            </li>
          )}
          {removing ? (
            <li>
              <Trash2 size={16} aria-hidden="true" />
              <span>
                It is deleted, not paused, and its list of past runs goes with
                it. What it posted and the tickets it raised stay.
              </span>
            </li>
          ) : changing ? (
            changed(p, "how_often") && (
              <li>
                <Repeat size={16} aria-hidden="true" />
                <span>
                  {costsInstead(
                    p.runs_a_month,
                    p.runs_a_month_before,
                    data.company?.name,
                  )}
                </span>
              </li>
            )
          ) : (
            <li>
              <Repeat size={16} aria-hidden="true" />
              <span>{costs(p.runs_a_month, data.company?.name)}</span>
            </li>
          )}
        </ul>
        {/* Letting the duck do this on its own from now on is a lasting
            permission, so it is a tick box with its own name, and only for
            somebody who may change what ducks are allowed, while the duck
            may not already. */}
        {!removing &&
          !changing &&
          data.permissions?.ducks &&
          !p.duck_may_schedule && (
            <label className="schedule-ask-grant">
              <input
                type="checkbox"
                checked={always}
                disabled={!!busy}
                aria-labelledby={id + "-name"}
                aria-describedby={id + "-say"}
                onChange={(e) => setAlways(e.target.checked)}
              />
              <span>
                <b id={id + "-name"}>
                  Also let {Name} schedule work without asking
                </b>
                <span id={id + "-say"}>
                  From now on it starts, changes and stops regular work on its
                  own. You can turn this off again in Settings &gt; Ducks.
                </span>
              </span>
            </label>
          )}
        {error && (
          <div className="error-box" role="alert">
            {error}
          </div>
        )}
        <div className="human-input-actions">
          {removing ? (
            // It deletes the schedule and its list of past runs: the one
            // answer here that cannot be taken back looks like it.
            <Button
              type="button"
              className="schedule-ask-stop"
              busy={busy === "approve"}
              disabled={!!busy}
              onClick={(e) => decide("approve", e)}
            >
              {busy !== "approve" && (
                <CircleStop size={15} aria-hidden="true" />
              )}
              Stop it
            </Button>
          ) : (
            <Button
              type="button"
              busy={busy === "approve"}
              disabled={!!busy}
              onClick={(e) => decide("approve", e)}
            >
              {changing ? "Change it" : "Set it up"}
            </Button>
          )}
        </div>
      </div>
      <div className="human-input-foot">
        {p.expires && (
          <span>
            {openUntil(p.expires, new Date(), !!zoneNote(p.timezone, zone))}
          </span>
        )}
        <span className="human-input-outs">
          {/* The answer that was pressed is the one that says it is working. */}
          <button
            type="button"
            className={"human-input-out" + (removing ? "" : " stop")}
            disabled={!!busy}
            aria-busy={busy === "decline" || undefined}
            onClick={(e) => decide("decline", e)}
          >
            {busy === "decline" && (
              <Loader2 className="spin" size={13} aria-hidden="true" />
            )}
            {removing
              ? "Keep it"
              : changing
                ? "Keep it as it is"
                : "No, don’t set it up"}
          </button>
        </span>
      </div>
    </section>
  );
}
const changed = (p, what) => (p.changed || []).includes(what);
// What a change would make different, and only that, each as it is now and as
// it would be. New instructions are what is being agreed to, so they are said
// in full; the ones they replace are a press away, because two long blocks of
// nearly the same words, one struck through, are hard to read and harder to
// compare.
function ScheduleChanges({ proposal: p }) {
  const was = p.before || {};
  const swap = (before, after) => (
    <>
      <del>{before}</del>
      <span className="schedule-ask-to" aria-hidden="true">
        {" → "}
      </span>
      <ins>{after}</ins>
    </>
  );
  return (
    <dl className="schedule-ask-changes">
      {changed(p, "title") && (
        <div>
          <dt>Name</dt>
          <dd>{swap(was.title, p.title)}</dd>
        </div>
      )}
      {changed(p, "instructions") && (
        <div>
          <dt>New instructions</dt>
          <dd>
            <p className="schedule-ask-new">
              {p.instructions || "No instructions."}
            </p>
            <details className="human-input-more">
              <summary>What it says now</summary>
              <p>{was.instructions || "No instructions."}</p>
            </details>
          </dd>
        </div>
      )}
      {changed(p, "how_often") && (
        <div>
          <dt>How often</dt>
          <dd>{swap(was.how_often, p.how_often)}</dd>
        </div>
      )}
      {changed(p, "where") && (
        <div>
          <dt>Where</dt>
          <dd>{swap(was.where, p.where)}</dd>
        </div>
      )}
    </dl>
  );
}
