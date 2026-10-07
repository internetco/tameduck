import React, { useId } from "react";
import { Ban } from "lucide-react";
import { Button, fmtTime } from "./ui.jsx";

// Saying no to a duck that asked for your screen. The only way out of a
// request used to be "Tell <duck> to stop", which ended the whole task, so
// somebody who simply could not or would not hand their screen over had to
// throw away the work along with it. This keeps the work: the duck is told no,
// and why if they want to say, and carries on another way.

// One press for the reasons people give most. Each is a whole sentence, so it
// reads right on its own and with more written after it.
export const QUICK_REASONS = [
  "I’m not at my computer.",
  "Find another way.",
  "Don’t use this website.",
];

// A quick reason replaces another quick reason, and is added to anything the
// person wrote themselves rather than writing over it.
export function withQuickReason(current, quick) {
  const text = (current || "").trim();
  if (!text || QUICK_REASONS.includes(text)) return quick;
  if (text.includes(quick)) return text;
  return text + " " + quick;
}

export function DeclineForm({
  title,
  name,
  reason,
  setReason,
  busy,
  error,
  onSend,
  onBack,
}) {
  const id = useId();
  const chosen = (reason || "").trim();
  return (
    <form
      className="human-input-decline"
      onSubmit={(e) => {
        e.preventDefault();
        onSend();
      }}
    >
      <h4 className="human-input-title">Say no to “{title}”</h4>
      <p className="human-input-say">
        {name.charAt(0).toUpperCase() + name.slice(1)} won’t get your screen and
        carries on without it. Telling it why helps it find another way.
      </p>
      <div className="human-input-reasons" role="group" aria-label="Quick reasons">
        {QUICK_REASONS.map((q) => (
          <button
            type="button"
            key={q}
            className={"human-input-reason" + (chosen.includes(q) ? " on" : "")}
            aria-pressed={chosen.includes(q)}
            disabled={busy}
            onClick={() => setReason(withQuickReason(reason, q))}
          >
            {q.replace(/\.$/, "")}
          </button>
        ))}
      </div>
      <label htmlFor={id} className="human-input-decline-label">
        Why not? <i>(optional)</i>
      </label>
      <textarea
        id={id}
        className="human-input-field"
        rows={3}
        maxLength={500}
        value={reason}
        disabled={busy}
        onChange={(e) => setReason(e.target.value)}
      />
      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}
      <div className="human-input-actions">
        <Button busy={busy}>Send to {name}</Button>
        <Button type="button" className="secondary" disabled={busy} onClick={onBack}>
          Back
        </Button>
        <span className="human-input-small human-input-decline-note">
          If it can’t finish without you, it tells you what’s left.
        </span>
      </div>
    </form>
  );
}

// What the card leaves behind once somebody said no: that they did, when, and
// what they wrote, so the chat still makes sense when read back later.
export function Declined({ request: r }) {
  return (
    <div className="human-input-done stopped human-input-declined">
      <Ban size={15} aria-hidden="true" />
      <span>
        <b>You said no</b>
        {r.title ? " to “" + r.title + "”" : ""}
        {r.declined_at || r.updated
          ? " · " + fmtTime(r.declined_at || r.updated)
          : ""}
        {r.declined_reason && (
          <q className="human-input-declined-reason">{r.declined_reason}</q>
        )}
      </span>
    </div>
  );
}
