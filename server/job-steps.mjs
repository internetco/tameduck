// Every note a duck wrote on its way through one run, for the progress card in
// chat.
//
// The note was already written on every action and kept on that action's row,
// but only the newest one was ever shown - on the computer, where the next
// action overwrote it. So somebody watching could see what the duck was doing
// now and nothing of what it had already done.
//
// actions: that run's rows in the order they happened, as { note, at, state }.
// A step whose last action failed says so: ticking it told somebody watching a
// duck that could not reach its desktop at all that every step had gone fine.
// last: the computer's own note when this run wrote it last. Saying it has
// finished with the computer writes one without an action row, and it is
// usually the one that says how things were left.
// earlier: how many older notes a very long run had that are not sent, so the
// card can say its list does not start at the beginning.
export const STEPS_KEPT = 200;
export function stepsOf(actions = [], last = null) {
  const steps = [];
  for (const a of [...actions, ...(last ? [last] : [])]) {
    const note = String(a?.note || "").trim();
    // One note per action, so a duck clicking through a form writes the same
    // sentence five times. Once is enough.
    if (!note) continue;
    const failed = a.state === "failed";
    const prior = steps[steps.length - 1];
    if (prior?.note === note) {
      prior.failed = failed;
      continue;
    }
    steps.push({ note, at: a.at || null, ...(failed ? { failed } : {}) });
  }
  for (const s of steps) if (!s.failed) delete s.failed;
  return {
    steps: steps.slice(-STEPS_KEPT),
    earlier: Math.max(0, steps.length - STEPS_KEPT),
  };
}
