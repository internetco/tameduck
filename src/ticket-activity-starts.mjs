// The running status and its durable work acknowledgement are separate
// activity rows. Once the acknowledgement exists, the empty status row adds
// no information to the ticket feed.
function sameRun(a, b) {
  if (a.job_id == null || b.job_id == null || a.job_id !== b.job_id)
    return false;
  return a.task_id == null || b.task_id == null || a.task_id === b.task_id;
}

function meaningfulAcknowledgement(event) {
  return (
    event.kind === "acknowledgement" &&
    String(event.body ?? "").trim().length > 0
  );
}

function emptyRunningStatus(event) {
  return (
    event.kind === "work" &&
    event.action === "Duck work running" &&
    !String(event.body ?? "").trim() &&
    !String(event.readable_body ?? "").trim() &&
    !event.file &&
    !event.upload_id &&
    !event.document_id &&
    !event.artifact_id &&
    !String(event.details ?? "").trim() &&
    !(event.changes?.length > 0) &&
    !(event.documents_read?.length > 0)
  );
}

export function collapseTicketStarts(items) {
  const acknowledgements = items.filter(meaningfulAcknowledgement);
  return items.filter(
    (event) =>
      !emptyRunningStatus(event) ||
      !acknowledgements.some((ack) => sameRun(event, ack)),
  );
}
