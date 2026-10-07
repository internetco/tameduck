import React, { useState } from "react";
import { api, Button, Field, Modal, useUnsavedGuard } from "./ui.jsx";
import { DISPLAY_SORTS, displaySettings } from "./board-display.mjs";
export default function BoardDisplaySettings({ board, data, action, onClose }) {
  const [initial] = useState(() => displaySettings(board));
  const canEdit = !!data.permissions.tasks;
  const [sort_order, setSort] = useState(initial.sort_order);
  const [days, setDays] = useState(
    initial.hide_done_after_days == null
      ? ""
      : String(initial.hide_done_after_days),
  );
  const [hide, setHide] = useState(initial.hide_done_after_days != null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const dirty =
    sort_order !== initial.sort_order ||
    hide !== (initial.hide_done_after_days != null) ||
    (hide && days !== String(initial.hide_done_after_days ?? ""));
  useUnsavedGuard(() => dirty);
  const closeGuard = () =>
    !busy &&
    (!dirty ||
      window.confirm(
        "Close without saving? What you have written here will be lost.",
      ));
  async function save(e) {
    e.preventDefault();
    if (busy || !canEdit) return;
    const n = !hide ? null : Number(days);
    if (n !== null && (!Number.isInteger(n) || n < 1 || n > 36500)) {
      setError("Enter a whole number from 1 to 36,500 days.");
      return;
    }
    setBusy(true);
    setError("");
    const result = await action(
      () =>
        api("/boards/" + board.id + "/display", "PATCH", {
          sort_order,
          hide_done_after_days: n,
        }),
      "Board display settings saved",
    );
    setBusy(false);
    if (result) onClose();
    else
      setError("Could not save these settings. Your changes are still here.");
  }
  return (
    <Modal
      title="Board view"
      ariaLabel="Board view"
      onClose={onClose}
      closeGuard={closeGuard}
    >
      <form className="board-display-settings" onSubmit={save}>
        <p className="board-display-copy">
          These settings apply to every column for everyone who can view this
          board. {!canEdit && "Only task editors can change them."}
        </p>
        <Field label="Ticket order">
          <select
            value={sort_order}
            onChange={(e) => setSort(e.target.value)}
            disabled={!canEdit || busy}
          >
            {DISPLAY_SORTS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </Field>
        <label className="board-display-check">
          <input
            type="checkbox"
            aria-label="Hide older Done tickets"
            checked={hide}
            onChange={(e) => setHide(e.target.checked)}
            disabled={!canEdit || busy}
          />{" "}
          <span>Hide older Done tickets</span>
        </label>
        {hide && (
          <Field
            label="Hide after (days)"
            hint="Completed tickets are hidden after this age; they are not deleted and remain available through past links."
          >
            <input
              type="number"
              min="1"
              max="36500"
              step="1"
              inputMode="numeric"
              required
              value={days}
              onChange={(e) => setDays(e.target.value)}
              disabled={!canEdit || busy}
            />
          </Field>
        )}
        <p className="board-display-note">
          Only completed tickets in the final column are affected. The age
          starts from completion time.
        </p>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <Button
            type="button"
            className="secondary"
            onClick={() => {
              if (closeGuard()) onClose();
            }}
            disabled={busy}
          >
            Cancel
          </Button>
          {canEdit && (
            <Button type="submit" disabled={busy || !dirty}>
              {busy ? "Saving…" : "Save board view"}
            </Button>
          )}
        </div>
      </form>
    </Modal>
  );
}
