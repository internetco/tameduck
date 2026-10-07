const WINDOW_MS = 60_000;

export function groupAutomaticWorkflowActivity(items) {
  const result = [];
  let group = null;
  for (const event of items) {
    const automatic =
      !event.user_id &&
      !event.duck_id &&
      !event.details &&
      !event.documents_read?.length &&
      (event.kind === "change" || event.kind === "work");
    const time = Date.parse(event.created);
    const within =
      group &&
      Number.isFinite(time) &&
      Number.isFinite(group.firstTime) &&
      time >= group.firstTime &&
      time - group.firstTime <= WINDOW_MS;
    if (automatic && within) {
      group.items.push(event);
      continue;
    }
    if (group) result.push(group.items.length > 1 ? group : group.items[0]);
    if (automatic) group = { type: "workflow-group", firstTime: time, items: [event] };
    else {
      group = null;
      result.push(event);
    }
  }
  if (group) result.push(group.items.length > 1 ? group : group.items[0]);
  return result;
}
export const WORKFLOW_ACTIVITY_WINDOW_MS = WINDOW_MS;
