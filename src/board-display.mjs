export const DISPLAY_SORTS = [
  ["newest", "Newest first"],
  ["oldest", "Oldest first"],
  ["updated", "Recently updated"],
  ["priority", "Priority (high first)"],
];
export function displaySettings(board = {}) {
  return {
    sort_order: DISPLAY_SORTS.some(([v]) => v === board.sort_order)
      ? board.sort_order
      : "newest",
    hide_done_after_days:
      Number.isInteger(board.hide_done_after_days) &&
      board.hide_done_after_days >= 1
        ? board.hide_done_after_days
        : null,
  };
}
const time = (v) => {
  const n = Date.parse(v || "");
  return Number.isFinite(n) ? n : 0;
};
export function isCompletedDone({
  ticket,
  task,
  columnIndex,
  lastColumn,
  legacy,
}) {
  if (columnIndex !== lastColumn) return false;
  return legacy
    ? task?.status === "done"
    : ticket?.state === "complete" && task?.status === "done";
}
export function isHiddenDone({
  ticket,
  task,
  columnIndex,
  lastColumn,
  legacy,
  settings,
  now = Date.now(),
}) {
  if (
    !settings.hide_done_after_days ||
    !isCompletedDone({ ticket, task, columnIndex, lastColumn, legacy })
  )
    return false;
  const completed = time(ticket?.completed_at);
  return (
    completed > 0 && now - completed > settings.hide_done_after_days * 86400000
  );
}
const priority = { high: 0, normal: 1, low: 2 };
export function sortBoardCards(cards, order = "newest") {
  return [...cards].sort((a, b) => {
    const at = time(a.task?.created),
      bt = time(b.task?.created);
    if (order === "oldest")
      return at - bt || String(a.task_id).localeCompare(String(b.task_id));
    if (order === "updated")
      return (
        time(b.task?.updated) - time(a.task?.updated) ||
        bt - at ||
        String(a.task_id).localeCompare(String(b.task_id))
      );
    if (order === "priority")
      return (
        (priority[a.task?.priority] ?? 1) - (priority[b.task?.priority] ?? 1) ||
        bt - at ||
        String(a.task_id).localeCompare(String(b.task_id))
      );
    return bt - at || String(b.task_id).localeCompare(String(a.task_id));
  });
}
