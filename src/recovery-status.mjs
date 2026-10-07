export const RECOVERY_STATES = new Set([
  "waiting",
  "queued",
  "held",
  "needs_attention",
]);
export const recoveryLabel = (state) =>
  ({
    waiting: "Waiting to resume",
    queued: "Resuming soon",
    held: "Resume on hold",
    needs_attention: "Needs attention",
  })[state] || "Recovery";
export function recoveryDetail(
  recovery,
  { includeAttempts = true, compact = false } = {},
) {
  if (!recovery || !RECOVERY_STATES.has(recovery.state)) return "";
  const label = recoveryLabel(recovery.state);
  if (compact)
    return (
      label +
      (recovery.next_attempt_at
        ? " at " + new Date(recovery.next_attempt_at).toLocaleString()
        : "") +
      (includeAttempts && recovery.attempts > 0
        ? " · " + recovery.attempts + " of 3 retries used"
        : "")
    );
  const when = recovery.next_attempt_at
    ? " at " + new Date(recovery.next_attempt_at).toLocaleString()
    : "";
  const reason = recovery.reason
    ? " — " + recovery.reason.replace(/[.。]+$/, "")
    : "";
  const blocked =
    recovery.continue_blocked_reason &&
    ["held", "needs_attention"].includes(recovery.state)
      ? " Cannot continue: " +
        recovery.continue_blocked_reason.replace(/[.。]+$/, "")
      : "";
  const attempts = includeAttempts
    ? " " + (recovery.attempts || 0) + " of 3 automatic retries used"
    : "";
  return label + when + reason + blocked + "." + attempts;
}
export const recoveryCanContinue = (recovery) =>
  !!recovery &&
  recovery.can_continue === true &&
  ["held", "needs_attention"].includes(recovery.state);
export function recoveryDestination(item, workflows = {}) {
  const ticket = (workflows.tickets || []).find(
    (t) => t.task_id === item?.task_id,
  );
  return ticket
    ? { type: "tasks", boardId: ticket.board_id, id: item.task_id }
    : {
        type: "chat",
        id: item?.conversation_id,
        ...(item?.thread_id ? { threadId: item.thread_id } : {}),
      };
}
