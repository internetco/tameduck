// Queue wording comes from the server so it can explain only a blocker the
// server has actually observed. Older servers may not send it yet.
export function queueReason(job) {
  if (!job || job.status !== "queued") return null;
  const reason = job.queue_reason;
  if (!reason || typeof reason.label !== "string" || !reason.label.trim())
    return null;
  return {
    label: reason.label.trim(),
    detail: typeof reason.detail === "string" ? reason.detail.trim() : "",
  };
}
