// A successful run with no message or visible side effect belongs in the audit
// trail, not as an empty row in the conversation. Anything the row can still
// show keeps it in place.
export function hideSilentCompletion(message, data = {}) {
  if (message.origin === "chief_checkin") return true;
  const checkinJob = message.run?.checkin || (data.jobs || []).some(
    (job) => job.output_message_id === message.id && job.checkin,
  );
  if (checkinJob && (message.state !== "sent" || !message.body)) return true;
  if (
    message.state !== "sent" ||
    !message.duck_id ||
    ["schedule", "workflow", "tool"].includes(message.origin) ||
    message.schedule ||
    message.consultations?.length ||
    message.body ||
    message.run?.acknowledgement ||
    message.needs_you ||
    message.artifacts?.some((artifact) => artifact.verb !== "Viewed") ||
    message.file_notices?.length
  )
    return false;
  if (
    ["skill_proposals", "schedule_proposals", "board_proposals"].some((key) =>
      (data[key] || []).some((proposal) => proposal.message_id === message.id),
    ) ||
    (data.human_requests || []).some(
      (request) => request.message_id === message.id,
    ) ||
    // A duck that asked to use a tool, or stopped at a connection, and said
    // nothing else: its ask card is drawn under this row.
    (data.approvals || []).some(
      (approval) => approval.message_id === message.id,
    ) ||
    (data.connection_blocks || []).some((block) =>
      block.message_ids?.includes(message.id),
    ) ||
    (data.computers?.items || []).some(
      (computer) => computer.checkpoint_message_id === message.id,
    )
  )
    return false;
  const job = (data.jobs || []).find(
    (candidate) => candidate.output_message_id === message.id,
  );
  if (job?.acknowledgement) return false;
  return !(
    job &&
    ((data.terminal_jobs || []).includes(job.id) ||
      (data.desktop_jobs || []).includes(job.id))
  );
}
