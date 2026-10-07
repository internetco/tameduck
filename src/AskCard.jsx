import React, { useEffect, useId, useRef, useState } from "react";
import {
  Ban,
  BookOpen,
  Check,
  ChevronRight,
  CircleAlert,
  Clock,
  Columns3,
  KeyRound,
  Loader2,
  MessageSquare,
  Plug,
  Send,
  Users,
} from "lucide-react";
import { api, Button } from "./ui.jsx";
import { askTitle, facts, willDo } from "./inbox-list.mjs";
import {
  cannot,
  connectionLines,
  folded,
  toast,
  toolLine,
} from "./ask-words.mjs";
import "./human-input.css";
import "./ask-card.css";

const icons = { BookOpen, Columns3, KeyRound, Plug, Send, Users };
const marks = {
  yes: Check,
  no: Ban,
  note: MessageSquare,
  over: Clock,
  fail: CircleAlert,
};

// The exact action, as named lines. A value with parts of its own says them as
// the same lines again, one step in, rather than as the JSON it arrived in.
const factLines = (rows) =>
  rows.map((one, i) => (
    // A value with parts of its own is a list rather than a value, so the CSS
    // puts its name over it instead of beside it.
    <div key={i} className={one.parts ? "deep" : ""}>
      <dt>{one.name}</dt>
      <dd>
        {one.parts ? (
          <dl className="inbox-facts inbox-facts-in">{factLines(one.parts)}</dl>
        ) : (
          one.value
        )}
      </dd>
    </div>
  ));

// One "may I?", whoever asks it. A duck wanting to use a tool, Chief with a
// skill or a board, a duck stopped at a connection: each used to look its own
// way - a sentence and a dialog of four same-size buttons, no card at all, a
// button that jumped to another page. Now each is this: the tag, a plain
// title, what will change, a link to all of it, and the answers on the card
// itself. Once answered it folds to one line that says who, what and when.
//
// head: in Needs you the line above the card is its heading, so there the
// card leaves off its tag and title.
//   lines: [{ icon, text }], what will happen
//   more: { label, onClick } for a link that opens the whole thing, or
//   sends: the exact action's lines, which the link folds open under the lines
//   decide(decision, { note, always }): the answer, sent; it throws a refusal
//   said: (decision, { always }) => the toast
//   askee: who "Ask for changes" goes to; none, no Ask for changes
//   yes: the first answer, { label, go } when it only goes somewhere
//   also: { label, onClick } for one more way, beside the first
//   no: the word for the way out
//   always, until: what the right of the bar holds
//   refusal: when set, no answers, only this line
//   done: the folded line once answered; lapse: the one when it runs out
export function AskCard({
  title,
  head = true,
  lines,
  more,
  sends,
  decide,
  said,
  askee,
  yes = { label: "Approve" },
  also,
  no = "Decline",
  always,
  until,
  refusal,
  done,
  lapse,
  expires,
  action,
  go,
}) {
  // Which answer is on its way. Only the pressed one says it is working.
  const [busy, setBusy] = useState(null),
    [error, setError] = useState(""),
    [open, setOpen] = useState(false),
    [noting, setNoting] = useState(false),
    [note, setNote] = useState(""),
    [ticked, setTicked] = useState(false),
    [time, setTime] = useState(Date.now());
  const id = useId(),
    card = useRef(null),
    line = useRef(null),
    pressed = useRef(null),
    changes = useRef(null),
    backed = useRef(false),
    answeredHere = useRef(false),
    wasHere = useRef(false);
  // The server says an ask has lapsed when it next sends the list; the clock
  // says so the moment it does.
  const lapsed = !done && !!expires && Date.parse(expires) <= time;
  // Somebody writing a note is not interrupted: the card waits for them, and
  // a note sent too late gets the server's refusal here, with the words kept.
  const holding = noting && !!note.trim();
  const shown = holding ? null : done || (lapsed ? lapse : null);
  const asking = !shown;
  useEffect(() => {
    if (!asking || done || !expires) return;
    const t = setTimeout(
      () => setTime(Date.now()),
      Math.min(Date.parse(expires) - Date.now() + 50, 2147483647),
    );
    return () => clearTimeout(t);
  }, [asking, done, expires]);
  // Whether the keyboard was last on this card, so that when it folds - lapsed,
  // or answered somewhere else - it is left on the line rather than on nothing.
  useEffect(() => {
    if (!asking) return;
    const seen = (e) => (wasHere.current = !!card.current?.contains(e.target));
    document.addEventListener("focusin", seen);
    return () => document.removeEventListener("focusin", seen);
  }, [asking]);
  // The button that was pressed goes with the card, so whoever pressed it is
  // left on the line that says what they did.
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
  // it pressed, which was switched off while the answer was out.
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
  // Back, or Escape in the note, returns to Ask for changes.
  useEffect(() => {
    if (noting || !backed.current) return;
    backed.current = false;
    changes.current?.focus();
  }, [noting]);
  async function answer(decision, event) {
    pressed.current = event?.currentTarget || null;
    setBusy(decision);
    setError("");
    try {
      const result = await decide(decision, {
        note: note.trim(),
        always: ticked,
      });
      answeredHere.current = true;
      // Sent: the note has done its job, and the card may fold.
      if (decision === "changes") setNoting(false);
      await action(async () => result, said?.(decision, { always: ticked }));
    } catch (e) {
      // Said on the card it is about. An answer that never reached the server
      // is said in plain words, not the browser's own.
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
  const back = () => {
    backed.current = true;
    setNoting(false);
  };
  if (shown) {
    const Mark = marks[shown.tone] || Clock;
    return (
      <p ref={line} tabIndex={-1} className={"ask-done " + shown.tone}>
        <span className="ask-done-mark">
          <Mark size={13} aria-hidden="true" />
        </span>
        <span className="ask-done-words">
          <b>{shown.lead}</b> · {shown.rest}
        </span>
        {/* In the app, never a page load. */}
        {shown.link && go && (
          <button
            type="button"
            className="ask-open"
            onClick={() => go(shown.link.to)}
          >
            {shown.link.label}
          </button>
        )}
      </p>
    );
  }
  const link = (more || sends) && (
    <button
      type="button"
      className="ask-more"
      onClick={sends ? () => setOpen(!open) : more.onClick}
      aria-expanded={sends ? open : undefined}
      aria-controls={sends ? id + "-sends" : undefined}
    >
      {sends ? "See what it sends" : more.label}
      <ChevronRight size={14} aria-hidden="true" />
    </button>
  );
  const off = !!busy;
  return (
    <section
      ref={card}
      className="human-input-card ask-card"
      aria-labelledby={head ? id + "-title" : undefined}
      // The name is not drawn in Needs you, so the card keeps it.
      aria-label={head ? undefined : title}
    >
      {head && (
        <div className="ask-head">
          <span className="ask-tag">Needs your OK</span>
          <h4 className="ask-title" id={id + "-title"}>
            {title}
          </h4>
          {link}
        </div>
      )}
      <ul className="ask-lines" aria-label="What will happen">
        {lines.map((one, i) => {
          const Icon = icons[one.icon];
          return (
            <li key={i}>
              {Icon && <Icon size={15} aria-hidden="true" />}
              <span>{one.text}</span>
            </li>
          );
        })}
      </ul>
      {sends && (
        <dl className="inbox-facts ask-sends" id={id + "-sends"} hidden={!open}>
          {factLines(sends)}
        </dl>
      )}
      {noting && (
        <label className="ask-note">
          <span>What should {askee} change?</span>
          <textarea
            className="human-input-field"
            rows={3}
            maxLength={2000}
            required
            autoFocus
            value={note}
            disabled={off}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                back();
              }
            }}
          />
        </label>
      )}
      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}
      {!head && link}
      <div className="human-input-foot ask-bar">
        {refusal ? (
          <p className="ask-cannot">{refusal}</p>
        ) : noting ? (
          <>
            <Button
              type="button"
              className="ask-approve"
              busy={busy === "changes"}
              disabled={off || !note.trim()}
              onClick={(e) => answer("changes", e)}
            >
              Send to {askee}
            </Button>
            <button
              type="button"
              className="ask-decline"
              disabled={off}
              onClick={back}
            >
              Back
            </button>
          </>
        ) : (
          <>
            <Button
              type="button"
              className="ask-approve"
              busy={busy === "approve"}
              disabled={off}
              onClick={(e) => (yes.go ? yes.go() : answer("approve", e))}
            >
              {!yes.go && busy !== "approve" && (
                <Check size={16} aria-hidden="true" />
              )}
              {yes.label}
            </Button>
            {askee && (
              <Button
                ref={changes}
                type="button"
                className="secondary"
                disabled={off}
                onClick={() => setNoting(true)}
              >
                Ask for changes
              </Button>
            )}
            {also && (
              <Button
                type="button"
                className="secondary"
                disabled={off}
                onClick={also.onClick}
              >
                {also.label}
              </Button>
            )}
            <button
              type="button"
              className="ask-decline"
              disabled={off}
              aria-busy={busy === "deny" || undefined}
              onClick={(e) => answer("deny", e)}
            >
              {busy === "deny" && (
                <Loader2 className="spin" size={14} aria-hidden="true" />
              )}
              {no}
            </button>
            {always ? (
              <label className="ask-always">
                <input
                  type="checkbox"
                  checked={ticked}
                  disabled={off}
                  onChange={(e) => setTicked(e.target.checked)}
                />
                {always}
              </label>
            ) : (
              until && <span className="ask-until">{until}</span>
            )}
          </>
        )}
      </div>
    </section>
  );
}

// A duck wanting to use a connected tool. Its title is the duck's own line;
// the line under it is the server's, so where the data goes is always said.
export function ToolAskCard({ approval: a, data, action, go, head = true }) {
  const title = askTitle("approval", a);
  const duck = a.duck_name || "the duck";
  return (
    <AskCard
      title={title}
      head={head}
      lines={[toolLine(a)]}
      sends={[{ name: "Action", value: willDo(a) }, ...(facts(a.args) || [])]}
      askee={duck}
      refusal={data.permissions?.approvals ? null : cannot("tool")}
      done={
        a.status === "pending"
          ? null
          : folded("tool", a, { me: data.user?.id, duck })
      }
      decide={(decision, { note }) =>
        api(
          "/approvals/" + a.id + "/decide",
          "POST",
          decision === "changes" ? { decision, note } : { decision },
        )
      }
      said={(decision) => toast(decision, title, { duck })}
      action={action}
      go={go}
    />
  );
}

// A duck stopped at a connection. Its buttons do what they always did: Allow
// lets it in, Reconnect goes to the connection's page, Not now puts it off.
// It does not fold: once settled it leaves, and the server has already said
// in the chat what happened.
export function ConnectionAskCard({ block: b, data, action, go, head = true }) {
  const manage = !!data.permissions?.integrations;
  return (
    <AskCard
      title={askTitle("connection", b, manage)}
      head={head}
      lines={connectionLines(b, manage)}
      refusal={manage ? null : cannot("connection", b)}
      yes={
        b.kind === "access"
          ? { label: "Allow" }
          : {
              label: "Reconnect",
              go: () =>
                go({
                  type: "settings",
                  tab: "connections",
                  connectionId: b.connection_id,
                }),
            }
      }
      also={
        b.board_id && {
          label: "Open the ticket",
          onClick: () =>
            go({ type: "tasks", boardId: b.board_id, id: b.task_id }),
        }
      }
      no="Not now"
      decide={(decision) =>
        api(
          "/connection-blocks/" +
            b.id +
            (decision === "approve" ? "/allow" : "/dismiss"),
          "POST",
          {},
        )
      }
      action={action}
      go={go}
    />
  );
}
