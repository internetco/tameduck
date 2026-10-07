import React, { useEffect, useState } from "react";
import { Ban, Check, LockKeyhole, Monitor } from "lucide-react";
import { DeclineForm, Declined } from "./HumanInputDecline.jsx";
import { api, Button, fmtDate, fmtTime } from "./ui.jsx";
import {
  afterwards,
  forThePerson,
  saysHandBack,
  siteOf,
  waitWords,
} from "./human-input-words.mjs";
import "./human-input.css";
function sameCheckpoint(request, computer) {
  return (
    !!computer &&
    (request.message_id
      ? computer.checkpoint_message_id === request.message_id
      : !!request.checkpoint && computer.checkpoint === request.checkpoint)
  );
}
// One card for the moment a duck cannot finish without a person: a band in the
// colours of the sidebar's "Needs you" badge, what is needed in the duck's own
// words, the one control that does it, then how long the duck waits and the
// way out. It used to be a faint note, a separate card with two buttons of the
// same weight, and a screen preview, saying the same thing four times.
//
// onScreen: this card is being shown on the desktop page itself, rather than in
// chat. The button that opens the screen then leads to the page it is already
// on, so pressing the one control whose words match what you were just told to
// do did nothing at all, with nothing to say why.
// showDuck: the card stands on its own (Needs you, a request to another duck)
// with no message above it to say whose it is, so the band names the duck.
// picture: the last picture of the duck's screen, where the chat has one. It
// sits beside the button that opens that screen.
// heading: in the Needs you list the line above the card already carries the
// badge's colour and says what is being asked, so there the card leaves off its
// own band and its own title rather than saying both twice. What is left is the
// duck's words and the one control. Everywhere else keeps them.
export function HumanInputCard({
  request: r,
  data,
  action,
  go,
  onScreen = false,
  showDuck = false,
  picture = null,
  heading = true,
}) {
  const [values, setValues] = useState({}),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [time, setTime] = useState(Date.now()),
    // Saying no opens a small form in the card's place: why not, if they
    // want to say. Closed again by Back, or by the request moving on.
    [declining, setDeclining] = useState(false),
    [reason, setReason] = useState("");
  useEffect(() => {
    setValues({});
    setError("");
    setDeclining(false);
    setReason("");
  }, [r.id]);
  // What was typed goes whenever the request moves on: a form that comes back
  // after its page changed must never be handed an answer - a password least
  // of all - meant for the page that was there before. The one exception is
  // the wait running out and the server parking the request. The card then
  // shows back what they had written, and clearing it here too wiped that
  // about a second after the card promised to keep it.
  useEffect(() => {
    setError("");
    if (!["expired", "parking", "parked"].includes(r.status)) setValues({});
  }, [r.status]);
  useEffect(() => {
    const t = setInterval(() => setTime(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => () => setValues({}), []);
  const closed = ["completed", "cancelled"].includes(r.status),
    expired = r.expires <= time,
    waitEnded = expired || ["parked", "parking"].includes(r.status),
    accepting = r.status === "pending" && !expired,
    computer = data.computers?.items?.find((c) => c.id === r.computer_id),
    manualFailure =
      r.kind === "takeover" &&
      !r.job_id &&
      (r.status === "parked" ||
        r.status === "stale" ||
        r.status === "expired" ||
        expired),
    freshRetry =
      manualFailure &&
      r.status === "parked" &&
      !computer?.request_id &&
      !!computer?.checkpoint_token &&
      sameCheckpoint(r, computer),
    // A parked request is only resumable while its run is still holding for a
    // person. Parking normally lets the duck carry on, so by the time somebody
    // reads this the run has moved and the server refuses the retry - which was
    // offered anyway, and failed every time it was pressed.
    movedOn =
      r.status === "parked" &&
      !!r.job_id &&
      !(data.jobs || []).some(
        (j) => j.id === r.job_id && j.status === "waiting_human",
      ),
    retryable =
      !closed &&
      !manualFailure &&
      !movedOn &&
      !["preparing", "submitting", "parking", "closing"].includes(r.status),
    cancellable =
      !closed && !["submitting", "parking", "closing"].includes(r.status),
    // Taking a computer nobody offered pauses whatever run the duck had going,
    // even one in a chat this person is not in: the run's id is kept so it can
    // be resumed and only its conversation is dropped, which is how we know.
    // Closing such a card gives the screen back and lets the duck carry on; it
    // is not this person's task to stop.
    somebodyElses = !!r.job_id && !r.conversation_id,
    // A takeover row can only be made by a person pressing Take control: the
    // duck-facing tool makes a "form" one. So this whole card is about a screen
    // this person went and opened, and every word on it that said the duck was
    // asking for them was untrue.
    iOpenedIt = r.kind === "takeover",
    activeTakeover = iOpenedIt && r.status === "desktop" && !expired,
    opened = Number.isFinite(Date.parse(r.created))
      ? fmtDate(r.created) + " at " + fmtTime(r.created)
      : "",
    duck = data.ducks.find((d) => d.id === r.duck_id),
    name = duck?.name || "your duck",
    Name = duck?.name || "Your duck",
    site = siteOf(r.origin),
    outcome = forThePerson(r.outcome),
    fields = r.fields || [],
    // Nobody is waiting on this card any more: the wait ran out, or the screen
    // this person opened has gone. It stops wearing the badge's colours.
    over = waitEnded || manualFailure,
    // The person has answered and the duck is typing it in. Nothing is asked
    // of them now, so the card stops wearing the badge's colours for this too.
    sending = r.status === "submitting",
    asking = accepting && fields.length > 0,
    // The duck asked for something that can only be done on its screen: no
    // fields to fill in, or this person is already on it.
    onTheScreen =
      !iOpenedIt &&
      ((accepting && !fields.length) || (r.status === "desktop" && !expired)),
    // One short answer sits beside its button, named by the hint inside it.
    // Anything more is a small form - and so is one answer with a long name,
    // which a hint would cut short and then lose at the first keystroke.
    oneLine =
      fields.length === 1 &&
      fields[0].type !== "textarea" &&
      fields[0].label.length <= 28,
    toScreen = !onScreen && (accepting || (r.status === "desktop" && !expired)),
    tryAgain = retryable && ((!accepting && r.status !== "desktop") || expired),
    // Pressed on a screen this person opened, "I'm back, try again" and this
    // do the same thing, so only one of them is offered.
    handBack =
      cancellable && iOpenedIt && !manualFailure && !movedOn && !tryAgain,
    // Only a duck's own ask can be said no to: a screen this person opened is
    // handed back instead. Not while the page is still being got ready or an
    // answer is being typed in.
    canDecline =
      !iOpenedIt &&
      !!r.job_id &&
      (accepting || (r.status === "desktop" && !expired));
  // What somebody typed is theirs, and the wait running out is not a reason to
  // take it. This used to clear every field the moment the countdown reached
  // zero - mid-keystroke, with no warning, and the countdown only ever showed
  // whole minutes, so "Waits 1 more min" was the last thing they saw before a
  // long answer disappeared. Pressing "I'm back, try again" then started them
  // from nothing. The values are kept and shown back under the card, so they
  // are there to use when the duck asks again - which it does from scratch,
  // with a new form: the old request is closed by the retry.
  async function decide(op) {
    setBusy(true);
    setError("");
    try {
      const result = await api(
        "/human-requests/" + r.id + "/" + op,
        "POST",
        op === "submit" ? { values } : op === "decline" ? { reason } : {},
      );
      setValues({});
      if (op === "decline") {
        setDeclining(false);
        setReason("");
      }
      await action(async () => result);
    } catch (e) {
      // Not setValues({}): a refused submit is exactly when somebody still
      // needs what they typed. Only a submit that worked clears the form.
      setError(e.message);
      await action(async () => ({}));
    } finally {
      setBusy(false);
    }
  }
  // Straight onto the screen: it fills the window, and the duck's ask is the
  // bar across the top of it.
  const openScreen = () => {
    setValues({});
    go({
      type: "computers",
      id: r.computer_id,
      requestId: r.id,
      control: true,
      take: true,
    });
  };
  // Afterwards the card is one line. It has nothing left to ask, and a box
  // that still looked like a question sat under every answered message.
  if (closed && r.declined_at) return <Declined request={r} />;
  if (closed)
    return (
      <p
        className={
          "human-input-done" + (r.status === "cancelled" ? " stopped" : "")
        }
      >
        {r.status === "cancelled" ? (
          <Ban size={15} aria-hidden="true" />
        ) : (
          <Check size={15} aria-hidden="true" />
        )}
        <span>
          <b>{afterwards(r, { name, jobs: data.jobs })}</b>
          {r.updated ? " · " + fmtTime(r.updated) : ""}
        </span>
      </p>
    );
  const band = over
    ? iOpenedIt
      ? "You no longer have the screen"
      : Name + " is no longer waiting"
    : sending
      ? "Sending to " + name
      : iOpenedIt
        ? showDuck
          ? "You have " + name + "'s screen"
          : "You have the screen"
        : showDuck
          ? Name + " needs you"
          : "Needs you";
  // What the card is saying right now, where that is not the form or the
  // duck's own instructions.
  const state =
    accepting || (waitEnded && outcome)
      ? ""
      : r.status === "desktop" && !expired
        ? ""
        : r.status === "preparing"
          ? iOpenedIt
            ? "Getting the screen ready…"
            : "Getting the page ready…"
          : r.status === "submitting"
            ? Name + " is typing it in…"
            : manualFailure
              ? r.status === "parked"
                ? Name + " is free to work."
                : "Dismiss this before opening the screen again."
              : waitEnded
                ? ["parked", "parking"].includes(r.status)
                  ? r.status === "parked"
                    ? movedOn
                      ? r.was_taken
                        ? `The wait ran out before the screen was handed back, so ${name} carried on. Whatever was done on the computer is still there.`
                        : `Nobody came in time, so ${name} carried on without this. Ask again if you still want it.`
                      : // Under a band that says the duck is no longer waiting,
                        // this said it "is waiting for you to come back".
                        `${Name} let the screen go, and picks this up again when you are back.`
                    : `${Name} is letting this screen go so it can do other work.`
                  : `The wait is over. ${Name} is letting this screen go so it can do other work.`
                : r.status === "closing"
                  ? "Closing…"
                  : `The page changed or the connection dropped. ${Name} needs to look at it again.`;
  const say = iOpenedIt
    ? r.job_id
      ? `You opened this screen, so ${name} stopped where it was. It has not opened anything for you. Hand it back when you are done and ${name} carries on.`
      : // Opened on a duck that was not doing anything: nothing stopped, and
        // nothing carries on afterwards. It said both, under a reply the duck
        // had finished long before, as if the person had cut it off mid-task.
        `You opened this screen while ${name} was not working on anything, so nothing is paused. It has not opened anything for you. Hand it back when you are done.`
    : [
        r.instructions,
        // The duck only carries on once its screen comes back, and nothing
        // else on the card says so - unless the duck just did.
        onTheScreen && !saysHandBack(r.instructions)
          ? "Hand the screen back when you are done."
          : "",
      ]
        .filter(Boolean)
        .join(" ");
  const input = (f, extra = {}) =>
    f.type === "textarea" ? (
      <textarea
        className="human-input-field"
        required={f.required}
        value={values[f.id] || ""}
        maxLength={8192}
        onChange={(e) => setValues({ ...values, [f.id]: e.target.value })}
        {...extra}
      />
    ) : (
      <input
        className="human-input-field"
        type={["password", "otp"].includes(f.type) ? "password" : f.type}
        autoComplete={f.type === "otp" ? "one-time-code" : "off"}
        inputMode={f.type === "otp" ? "numeric" : undefined}
        spellCheck={false}
        required={f.required}
        maxLength={8192}
        value={values[f.id] || ""}
        onChange={(e) => setValues({ ...values, [f.id]: e.target.value })}
        {...extra}
      />
    );
  // The way out, as a quiet sentence in the foot. It used to be a blue link
  // called "Cancel task" beside the button that does the job, and it stops the
  // duck's whole run.
  const wayOut =
    // Once the run has moved on there is nothing left to stop: the duck
    // carried on and will deliver its reply either way.
    manualFailure || movedOn
      ? "Dismiss"
      : somebodyElses
        ? "Hand back to " + name
        : // A screen opened on a duck that was not doing anything has no run
          // behind it, and offering to stop one named something that did not
          // exist.
          r.job_id
          ? "Tell " + name + " to stop"
          : "Close the screen";
  const waits = !expired && !manualFailure && !waitEnded && !sending,
    // Handing back already says this when the run is somebody else's: the
    // server treats the two the same.
    showWayOut = cancellable && !(somebodyElses && handBack),
    otherWay = toScreen && asking,
    // A form has its Send button where Say no would go, so there it is a
    // quiet line in the foot, beside the other way of doing it.
    sayNoBelow = canDecline && asking && !declining,
    footSays = !waits
      ? ""
      : iOpenedIt
        ? opened &&
          (activeTakeover ? "You opened it on " : "You asked for it on ") +
            opened +
            "."
        : waitWords(r.expires - time, name, !!r.job_id && !somebodyElses);
  return (
    <section
      className={"human-input-card" + (over || sending ? " over" : "")}
      // The name is not drawn, so a card with no visible heading keeps it.
      aria-label={
        over || sending
          ? band
          : iOpenedIt
            ? "You have " + name + "'s screen"
            : Name + " needs you"
      }
    >
      {heading && <p className="human-input-band">{band}</p>}
      <div className="human-input-main">
        <div className="human-input-split">
          <div className="human-input-split-text">
            {declining ? (
              <DeclineForm
                title={r.title}
                name={name}
                reason={reason}
                setReason={setReason}
                busy={busy}
                error={error}
                onSend={() => decide("decline")}
                onBack={() => {
                  setDeclining(false);
                  setError("");
                }}
              />
            ) : (
              <>
            {heading && (
              <h4 className="human-input-title">
                {iOpenedIt
                  ? over
                    ? // True of a screen that ran out of time and of one that
                      // never opened, which is one of the ways to get here.
                      "The screen is closed"
                    : r.job_id
                      ? Name + " waits while you have its screen"
                      : "You have " + name + "'s screen"
                  : r.title}
              </h4>
            )}
            {!waitEnded && say && <p className="human-input-say">{say}</p>}
            {!waitEnded && (onTheScreen || iOpenedIt) && site && (
              <p className="human-input-small">
                {iOpenedIt
                  ? site + " is open on it."
                  : Name + " has " + site + " open for you."}
              </p>
            )}
            {!waitEnded && iOpenedIt && r.checkpoint && (
              <details className="human-input-more">
                <summary>What {name} last saved</summary>
                <p>{r.checkpoint}</p>
              </details>
            )}
            {/* What actually happened, from the row that knows. The card used
                to say nobody came even when somebody had taken the screen and
                simply closed the tab. */}
            {(manualFailure || movedOn || waitEnded) && outcome && (
              <p className="human-input-notice" role="status">
                {outcome}
              </p>
            )}
            {state && (
              <p className="human-input-notice" role="status">
                {state}
              </p>
            )}
            {asking && (
              <form
                autoComplete="off"
                onSubmit={(e) => {
                  e.preventDefault();
                  decide("submit");
                }}
              >
                {oneLine ? (
                  <div className="human-input-row">
                    {input(fields[0], {
                      "aria-label": fields[0].label,
                      placeholder: fields[0].label,
                    })}
                    <Button busy={busy}>Send to {name}</Button>
                  </div>
                ) : (
                  <>
                    {fields.map((f) => (
                      <label key={f.id}>
                        <span>
                          {f.label}
                          {f.required ? "" : " (optional)"}
                        </span>
                        {input(f)}
                      </label>
                    ))}
                    <Button busy={busy}>Send to {name}</Button>
                  </>
                )}
                <p className="human-input-small">
                  <LockKeyhole size={13} aria-hidden="true" />
                  <span>
                    {Name} types it into {site || "the page"}. It is not kept in
                    chat.
                  </span>
                </p>
              </form>
            )}
            {error && (
              <div className="error-box" role="alert">
                {error}
              </div>
            )}
            {/* What they had started writing when the wait ran out. The form
                itself is gone - the duck has let the screen go and will ask
                again from scratch - but the words are theirs, and losing a
                long answer to a countdown that only ever showed whole minutes
                is the sort of thing somebody does not forgive. */}
            {waitEnded &&
              Object.values(values).some((v) => String(v).trim()) && (
                <div className="human-input-kept">
                  <strong>You had started an answer. It was not sent.</strong>
                  {fields.map((f) =>
                    String(values[f.id] || "").trim() ? (
                      <p key={f.id}>
                        <span>{f.label}</span>
                        {f.type === "password" || f.type === "otp"
                          ? "••••••"
                          : values[f.id]}
                      </p>
                    ) : null,
                  )}
                </div>
              )}
            {((toScreen && !asking) ||
              (canDecline && !asking) ||
              freshRetry ||
              (manualFailure && !freshRetry && computer) ||
              tryAgain ||
              handBack) && (
              <div className="human-input-actions">
                {toScreen && !asking && (
                  <Button type="button" disabled={busy} onClick={openScreen}>
                    <Monitor size={15} aria-hidden="true" />
                    {iOpenedIt ? "Back to the screen" : "Open the screen"}
                  </Button>
                )}
                {canDecline && !asking && (
                  <Button
                    type="button"
                    className="secondary"
                    disabled={busy}
                    onClick={() => {
                      setError("");
                      setDeclining(true);
                    }}
                  >
                    <Ban size={15} aria-hidden="true" />
                    Say no
                  </Button>
                )}
                {freshRetry && (
                  <Button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setValues({});
                      go({
                        type: "computers",
                        id: computer.id,
                        control: true,
                        checkpointToken: computer.checkpoint_token,
                      });
                    }}
                  >
                    <Monitor size={15} aria-hidden="true" /> Open the screen
                    again
                  </Button>
                )}
                {manualFailure && !freshRetry && computer && (
                  <Button
                    type="button"
                    className="secondary"
                    disabled={busy}
                    onClick={() => {
                      setValues({});
                      go({ type: "computers", id: computer.id });
                    }}
                  >
                    <Monitor size={15} aria-hidden="true" /> Go to {name}'s
                    computer
                  </Button>
                )}
                {tryAgain && (
                  <Button
                    type="button"
                    busy={busy}
                    onClick={() => decide("retry")}
                  >
                    {waitEnded
                      ? "I’m back, try again"
                      : "Ask " + name + " to try again"}
                  </Button>
                )}
                {/* A screen this person opened themselves is finished with by
                    handing it back, and the duck carries on from where it
                    stopped. This button used to say "Cancel task" and really
                    did cancel the run - so somebody who went to look at what
                    their duck was doing, looked, and closed the card, killed
                    the task. The two things are two controls with two
                    different words. */}
                {handBack && (
                  <Button
                    type="button"
                    className={toScreen ? "secondary" : ""}
                    busy={busy}
                    onClick={() => decide("retry")}
                  >
                    Hand back to {name}
                  </Button>
                )}
              </div>
            )}
              </>
            )}
          </div>
          {picture && toScreen && onTheScreen && !declining && (
            <div className="human-input-picture">{picture}</div>
          )}
        </div>
      </div>
      {(footSays || showWayOut || otherWay || sayNoBelow) && (
        <div className="human-input-foot">
          {footSays && <span>{footSays}</span>}
          {(otherWay || showWayOut || sayNoBelow) && (
            <span className="human-input-outs">
              {/* The other way to do it. A second button beside "Send" made
                  two things of the same weight to choose between, so it is a
                  quiet sentence down here. */}
              {otherWay && (
                <button
                  type="button"
                  className="human-input-out"
                  disabled={busy}
                  onClick={openScreen}
                >
                  Do it on {name}'s screen instead
                </button>
              )}
              {sayNoBelow && (
                <button
                  type="button"
                  className="human-input-out"
                  disabled={busy}
                  onClick={() => {
                    setError("");
                    setDeclining(true);
                  }}
                >
                  Say no
                </button>
              )}
              {showWayOut && (
                <button
                  type="button"
                  className="human-input-out stop"
                  disabled={busy}
                  onClick={() => decide("cancel")}
                >
                  {wayOut}
                </button>
              )}
            </span>
          )}
        </div>
      )}
    </section>
  );
}
export function HumanInputNotice({ data, go }) {
  // Only the ones actually waiting on a person. This used to be everything that
  // was not completed or cancelled, which includes 'parked', 'stale' and
  // 'expired' - the resting places of a request nobody answered, and of a
  // takeover that failed. Those need nothing, so the banner sat on every page
  // saying a duck was waiting, with nothing to do about it.
  const requests = (data.human_requests || []).filter(
    (r) =>
      ["pending", "preparing", "desktop", "submitting"].includes(r.status) &&
      r.expires > Date.now(),
  );
  if (!requests.length) return null;
  // The ones a duck made. A screen this person opened themselves is theirs, and
  // counting it told them a duck that had asked for nothing needed them.
  const asked = requests.filter((r) => r.kind !== "takeover");
  return (
    <div className="human-input-banner">
      <LockKeyhole size={15} />
      <span>
        {/* A screen somebody opened themselves is not a duck asking for them,
            and this banner sits across every page in the product saying it was. */}
        {!asked.length
          ? requests.length === 1
            ? "You have a duck's screen open."
            : `You have ${requests.length} duck screens open.`
          : // The words of the card and of the sidebar badge that lead here.
            // It said "Your duck needs your input" beside a link called
            // "Review request", which named neither the duck nor anything to
            // do. A computer holds one request and a duck has one computer,
            // so each of these is a different duck.
            asked.length === 1
            ? (data.ducks.find((d) => d.id === asked[0].duck_id)?.name ||
                "Your duck") + " needs you."
            : `${asked.length} ducks need you.`}
      </span>
      <button
        className="text-button"
        onClick={() => {
          const r = asked[0] || requests[0];
          const computer = data.computers?.items?.find(
            (c) => c.id === r.computer_id,
          );
          const manualFailure =
            r.kind === "takeover" &&
            !r.job_id &&
            (r.status === "parked" ||
              r.status === "stale" ||
              r.status === "expired" ||
              r.expires <= Date.now());
          const freshRetry =
            manualFailure &&
            r.status === "parked" &&
            !computer?.request_id &&
            !!computer?.checkpoint_token &&
            sameCheckpoint(r, computer);
          go(
            freshRetry
              ? {
                  type: "computers",
                  id: computer.id,
                  control: true,
                  checkpointToken: computer.checkpoint_token,
                }
              : manualFailure
                ? { type: "computers", id: computer?.id || r.computer_id }
                : // "Back to the screen" went to the duck's chat whenever the
                  // screen had been taken from there. A screen you took is on
                  // the screen page; a duck's question is in its chat.
                  r.conversation_id && r.kind !== "takeover"
                  ? {
                      type: "chat",
                      id: r.conversation_id,
                      threadId: data.jobs.find((j) => j.id === r.job_id)
                        ?.thread_id,
                    }
                  : {
                      type: "computers",
                      id: r.computer_id,
                      requestId: r.id,
                      control: true,
                    },
          );
        }}
      >
        {!asked.length ? "Back to the screen" : "Show me"}
      </button>
    </div>
  );
}
