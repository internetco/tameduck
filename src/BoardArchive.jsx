import React, { useEffect, useRef, useState } from "react";
import { Archive } from "lucide-react";
import { api, Button, Modal, plural } from "./ui.jsx";
import "./board-setup.css";

// A board is archived rather than deleted, and brought back from Archived
// boards at the end of the board list. The same pair as Archived channels.

const working = ["queued", "running", "waiting_human", "waiting_consultation"];

// What archiving stops, said before it happens.
export function ArchiveBoardDialog({
  board,
  data,
  unsaved,
  action,
  go,
  onClose,
}) {
  const cancelRef = useRef(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => cancelRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, []);
  const [error, setError] = useState("");
  const w = data.workflows;
  const here = new Set(
    w.tickets.filter((t) => t.board_id === board.id).map((t) => t.task_id),
  );
  const busyTickets = new Set(
    w.runs
      .filter((r) => here.has(r.task_id) && working.includes(r.status))
      .map((r) => r.task_id),
  ).size;
  const schedules = (data.schedules || []).filter(
    (s) => s.board_id === board.id && !s.paused,
  ).length;
  return (
    <Modal title={"Archive " + board.name + "?"} onClose={onClose}>
      <p className="board-archive-warning">
        It leaves the board list, and ducks stop working on it.
      </p>
      {busyTickets > 0 && (
        <p className="board-archive-warning">
          <strong>
            {busyTickets === 1
              ? "A duck is working on a ticket here right now."
              : "Ducks are working on " +
                busyTickets +
                " tickets here right now."}
          </strong>{" "}
          Archiving stops that work, and bringing the board back does not start
          it again.
        </p>
      )}
      {schedules > 0 && (
        <p className="board-archive-warning">
          {schedules === 1
            ? "A scheduled task adds tickets to this board. Archiving pauses it."
            : schedules +
              " scheduled tasks add tickets to this board. Archiving pauses them."}
        </p>
      )}
      {unsaved && (
        <p className="board-archive-warning">
          Changes you have not saved here are dropped.
        </p>
      )}
      <p className="muted">
        Its tickets keep their history and still show in search. You can bring
        it back from Archived boards in the board list.
      </p>
      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}
      <div className="modal-actions">
        <Button
          ref={cancelRef}
          autoFocus
          type="button"
          className="secondary"
          disabled={busy}
          onClick={onClose}
        >
          Cancel
        </Button>
        <Button
          type="button"
          busy={busy}
          onClick={async () => {
            setError("");
            setBusy(true);
            const done = await action(async () => {
              try {
                return await api("/boards/" + board.id + "/archive", "PATCH", {
                  archived: true,
                });
              } catch (e) {
                setError(e.message);
                throw e;
              }
            }, board.name + " archived. Bring it back from Archived boards in the board list.");
            setBusy(false);
            if (done) go({ type: "tasks" }, { asked: true });
          }}
        >
          <Archive size={16} aria-hidden="true" />
          Archive board
        </Button>
      </div>
    </Modal>
  );
}

// The boards out of use, newest first, each with a way back.
export function ArchivedBoardsDialog({ data, action, go, onClose }) {
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState("");
  const w = data.workflows;
  const archived = w.boards
    .filter((b) => b.archived)
    .sort((a, b) => b.updated.localeCompare(a.updated));
  return (
    <Modal title="Archived boards" onClose={onClose}>
      <p className="muted">
        These boards are out of the board list, and ducks do not work on them.
        Their tickets keep their history and still show in search.
      </p>
      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}
      <div className="archived-list">
        {archived.map((b) => {
          const tickets = w.tickets.filter((t) => t.board_id === b.id).length;
          return (
            <div key={b.id}>
              <span className="archived-board">
                <strong>{b.name}</strong>
                <span className="muted">
                  {tickets ? plural(tickets, "ticket") : "No tickets"}
                </span>
              </span>
              <Button
                type="button"
                className="secondary small"
                aria-label={"Bring back " + b.name}
                busy={busy === b.id}
                disabled={busy !== null}
                onClick={async () => {
                  setBusy(b.id);
                  setError("");
                  const done = await action(async () => {
                    try {
                      return await api(
                        "/boards/" + b.id + "/archive",
                        "PATCH",
                        { archived: false },
                      );
                    } catch (e) {
                      setError(e.message);
                      throw e;
                    }
                  }, b.name + " is back in the board list.");
                  setBusy(null);
                  if (done) {
                    onClose();
                    go({ type: "tasks", boardId: b.id });
                  }
                }}
              >
                Bring back
              </Button>
            </div>
          );
        })}
      </div>
    </Modal>
  );
}
