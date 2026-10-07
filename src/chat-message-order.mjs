const scopeFields = ["company_id", "conversation_id", "thread_id"];

const sameKnownValues = (left, right, fields) =>
  fields.every((field) => {
    const a = left?.[field];
    const b = right?.[field];
    return a === undefined || b === undefined || a === b;
  });

const runMatchesMessages = (job, input, output) =>
  sameKnownValues(input, output, scopeFields) &&
  sameKnownValues(job, input, scopeFields) &&
  sameKnownValues(job, output, scopeFields) &&
  sameKnownValues(job, input, ["user_id"]) &&
  sameKnownValues(job, output, ["duck_id"]);

const steerMatchesRun = (steer, active, message) =>
  sameKnownValues(steer, active, [...scopeFields, "user_id", "duck_id"]) &&
  sameKnownValues(steer, message, scopeFields) &&
  sameKnownValues(active, message, ["user_id"]);

const acceptedTime = (job) => String(job.updated || "");
const compareAccepted = (position) => (left, right) =>
  acceptedTime(left).localeCompare(acceptedTime(right)) ||
  (left.accepted_order ?? Number.MAX_SAFE_INTEGER) -
    (right.accepted_order ?? Number.MAX_SAFE_INTEGER) ||
  (position.get(left.input_message_id) ?? Number.MAX_SAFE_INTEGER) -
    (position.get(right.input_message_id) ?? Number.MAX_SAFE_INTEGER) ||
  left.id.localeCompare(right.id);

// Accepted steering belongs beside the request it changed, even though the
// message was sent later. This only projects the view: the saved timestamps
// and transcript stay untouched.
export function projectAcceptedSteers(messages, jobs) {
  if (!messages?.length || !jobs?.length) return messages || [];

  const byId = new Map(messages.map((message) => [message.id, message]));
  const position = new Map(
    messages.map((message, index) => [message.id, index]),
  );
  const knownJobs = new Map();
  const mergeJob = (job) => {
    if (!job?.id) return;
    knownJobs.set(job.id, { ...(knownJobs.get(job.id) || {}), ...job });
  };

  for (const job of jobs) {
    mergeJob(job);
    for (const steer of job?.accepted_steers || [])
      mergeJob({
        company_id: job.company_id,
        user_id: job.user_id,
        conversation_id: job.conversation_id,
        thread_id: job.thread_id,
        duck_id: job.duck_id,
        status: "steered",
        steered_into: job.id,
        ...steer,
      });
  }

  const acceptedByRun = new Map();
  for (const job of knownJobs.values()) {
    if (job.status !== "steered" || !job.steered_into) continue;
    const accepted = acceptedByRun.get(job.steered_into) || [];
    accepted.push(job);
    acceptedByRun.set(job.steered_into, accepted);
  }

  const moved = new Set();
  const insertions = new Map();
  const acceptedOrder = compareAccepted(position);
  for (const active of knownJobs.values()) {
    const input = byId.get(active.input_message_id);
    const output = byId.get(active.output_message_id);
    if (!input || !output || !runMatchesMessages(active, input, output))
      continue;

    const accepted = (acceptedByRun.get(active.id) || [])
      .filter((steer) => {
        const message = byId.get(steer.input_message_id);
        return message && steerMatchesRun(steer, active, message);
      })
      .sort(acceptedOrder);
    if (!accepted.length) continue;

    const besideInput = insertions.get(active.input_message_id) || [];
    for (const steer of accepted) {
      const message = byId.get(steer.input_message_id);
      if (moved.has(message.id)) continue;
      moved.add(message.id);
      besideInput.push({ message, steer });
    }
    insertions.set(active.input_message_id, besideInput);
  }

  if (!moved.size) return messages;
  const projected = [];
  const emitted = new Set();
  const append = (message) => {
    if (emitted.has(message.id)) return;
    emitted.add(message.id);
    projected.push(message);
    for (const insertion of (insertions.get(message.id) || []).sort(
      (left, right) => acceptedOrder(left.steer, right.steer),
    ))
      append(insertion.message);
  };
  for (const message of messages) {
    if (!moved.has(message.id)) append(message);
  }
  // Corrupt cyclic links must not make messages disappear from the transcript.
  for (const message of messages) append(message);
  return projected;
}
