import React, { useEffect, useState } from "react";
import { UserMinus } from "lucide-react";
import { api, Button, Modal } from "./ui.jsx";
// Taking a duck off the team stops whatever it is doing, and a stopped run does
// not come back. So this counts what it is about to stop and says so, the way
// pausing the flock and archiving a channel already do - rather than doing it
// quietly and leaving somebody to work out afterwards where their work went.
// Cancel only closes this question. onRemoved is called once the duck is off.
export function RemoveDuckDialog({
  duck,
  action,
  onClose,
  onRemoved = onClose,
}) {
  const [stops, setStops] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    api("/ducks/" + duck.id + "/removal")
      .then((r) => live && setStops(r))
      .catch(() => live && setStops({}));
    return () => {
      live = false;
    };
  }, [duck.id]);
  const runs = stops?.runs || 0;
  const computers = stops?.computers || 0;
  const schedules = stops?.schedules || 0;
  const waiting = stops?.waiting || 0;
  return (
    <Modal title={"Take " + duck.name + " off the team?"} onClose={onClose}>
      <p>
        <strong>{duck.name}</strong> stops working right now and is not offered
        anything again.
      </p>
      {runs > 0 && (
        <p>
          <strong>
            {runs === 1
              ? "One run is going right now."
              : runs + " runs are going right now."}
          </strong>{" "}
          {runs === 1 ? "It is" : "They are"} stopped, and putting {duck.name}{" "}
          back does not bring {runs === 1 ? "it" : "them"} back.
        </p>
      )}
      {(computers > 0 || schedules > 0) && (
        <p>
          {computers > 0 && "Its computer is stopped. "}
          {schedules === 1
            ? "One scheduled task is switched off."
            : schedules > 1
              ? schedules + " scheduled tasks are switched off."
              : ""}
        </p>
      )}
      {waiting > 0 && (
        <p>
          {waiting === 1
            ? "One thing waiting for a decision is taken back"
            : waiting + " things waiting for a decision are taken back"}
          , because nobody is behind them any more.
        </p>
      )}
      <p className="muted">
        Everything {duck.name} has already written stays exactly where it is.
        Its messages, tickets, documents and files keep its name and its face,
        and you can put it back on the team from the Team page whenever you
        like.
      </p>
      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}
      <div className="modal-actions">
        <Button
          type="button"
          className="secondary"
          autoFocus
          disabled={busy}
          onClick={onClose}
        >
          Cancel
        </Button>
        <Button
          type="button"
          busy={busy}
          // What this stops is fetched when the dialog opens. Until it is here
          // there is nothing to warn about yet, and a fast hand could destroy a
          // run without ever being told it existed.
          disabled={stops === null}
          onClick={async () => {
            setError("");
            setBusy(true);
            const done = await action(async () => {
              try {
                return await api("/ducks/" + duck.id + "/removed", "PATCH", {
                  removed: true,
                });
              } catch (e) {
                setError(e.message);
                throw e;
              }
            }, duck.name + " is off the team. You can put it back from the Team page.");
            setBusy(false);
            if (done) onRemoved();
          }}
        >
          <UserMinus size={16} />
          Take off the team
        </Button>
      </div>
    </Modal>
  );
}
