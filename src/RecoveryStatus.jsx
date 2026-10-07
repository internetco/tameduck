import React, { useState } from "react";
import { Clock, Play, Square } from "lucide-react";
import { api, Button } from "./ui.jsx";
import {
  recoveryCanContinue,
  recoveryDetail,
  RECOVERY_STATES,
} from "./recovery-status.mjs";
import "./recovery-status.css";
export function RecoveryStatus({ recovery, data, action, compact = false }) {
  const [busy, setBusy] = useState(false);
  if (!recovery || !RECOVERY_STATES.has(recovery.state)) return null;
  const owner = recovery.user_id === data?.user?.id;
  const canStop =
    (owner || data?.permissions?.company) &&
    ["waiting", "queued"].includes(recovery.state);
  const canContinue = owner && recoveryCanContinue(recovery);
  const run = async (fn, message) => {
    if (busy) return;
    setBusy(true);
    try {
      await action(fn, message);
    } finally {
      setBusy(false);
    }
  };
  const Container = compact ? "span" : "div";
  return (
    <Container
      className={
        "recovery-status ticket-recovery recovery-" +
        recovery.state +
        (compact ? " recovery-compact" : "")
      }
      role="status"
    >
      <span className="recovery-status-copy">
        <Clock size={14} /> <b>{recoveryDetail(recovery, { compact })}</b>
      </span>
      {!compact && (canContinue || canStop) && (
        <span className="recovery-status-actions">
          {canContinue && (
            <Button
              disabled={busy}
              className="secondary small"
              onClick={() =>
                run(
                  () =>
                    api("/jobs/" + recovery.job_id + "/continue", "POST", {}),
                  "Work continued",
                )
              }
            >
              <Play size={13} /> Continue
            </Button>
          )}
          {canStop && (
            <Button
              disabled={busy}
              className="secondary small"
              onClick={() =>
                run(
                  () => api("/jobs/" + recovery.job_id + "/cancel", "POST", {}),
                  "Automatic resume stopped",
                )
              }
            >
              <Square size={13} /> Stop automatic resume
            </Button>
          )}
        </span>
      )}
    </Container>
  );
}
