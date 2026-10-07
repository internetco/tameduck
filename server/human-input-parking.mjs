import { all, run, now, emit, json } from "./store.mjs";
import { expireRequests, requestFor } from "./human-input-store.mjs";
import { controlFor } from "./computer-control-store.mjs";
import { computerEvent } from "./computer-events.mjs";
import { closeControl } from "./computer-control.mjs";
import { computerInternals as C } from "./computers.mjs";
import { browserFor, releaseFormLease, thawForm } from "./secure-browser.mjs";

const parking = new Map();
export const activeParkingCount = () => parking.size;
// Hold the computer until every old input channel is closed. Only then can another job use it.
export async function parkHumanRequest(
  r,
  {
    close = closeControl,
    release = releaseFormLease,
    connect = browserFor,
  } = {},
) {
  const current = requestFor(r.id);
  if (!current || !["expired", "parking"].includes(current.status)) return;
  run(
    "UPDATE human_requests SET status='parking',updated=? WHERE id=?",
    now(),
    r.id,
  );
  const lease = controlFor(r.computer_id);
  close(r.computer_id);
  await C.lock("computer:" + r.computer_id, async () => {
    r = requestFor(r.id);
    if (r.status !== "parking") return;
    const binding = json(r.binding),
      c = C.row(r.computer_id);
    const released = await release(binding);
    if (
      !released &&
      binding?.target_id &&
      c?.box_id === binding.box_id &&
      c?.started_at === binding.started_at &&
      C.readyStates.includes(c.state)
    ) {
      const browser = await connect(c).catch(() => null);
      if (browser)
        try {
          const latest = C.row(c.id);
          if (
            latest.box_id === binding.box_id &&
            latest.started_at === binding.started_at
          )
            await thawForm(browser, binding).catch(() => {});
        } finally {
          browser.close();
        }
    }
    if (requestFor(r.id).status !== "parking") return;
    if (lease) {
      run(
        "DELETE FROM computer_control WHERE computer_id=? AND generation=?",
        r.computer_id,
        lease.generation,
      );
      // Given back by the clock, not by anybody: nobody is named.
      computerEvent({ id: r.computer_id, company_id: r.company_id }, "gave_back");
    }
    run(
      // Say why it ended. The duck reads this outcome when its run resumes, so
      // an unanswered request must not look like an answered one — and equally,
      // a request somebody did answer must not be recorded as ignored. Closing
      // the tab is the ordinary way a takeover ends, and the duck was then told
      // nobody had come and its input was never provided, when in fact somebody
      // had been on the machine and may have changed it.
      `UPDATE human_requests SET status='parked',outcome=CASE WHEN coalesce(outcome,'')='' THEN ? ELSE outcome END,updated=? WHERE id=? AND status='parking'`,
      r.control_generation
        ? "A person took over this screen and the wait ran out before they handed it back. What they did is already on the computer: look at the current state before repeating anything, and ask again only if what you needed is still missing."
        : "Nobody took over in time, so this request expired and the computer was handed back. The input you asked for was never provided. Check the current computer state and ask again if you still need it.",
      now(),
      r.id,
    );
    // The computer is free again, and resumeWaitingJobs() now lets this request's
    // own job continue rather than leaving it waiting for a person forever.
    emit(r.company_id);
  });
}
export function parkExpiredHumanRequests(options) {
  expireRequests();
  for (const r of all(
    "SELECT * FROM human_requests WHERE status IN ('expired','parking')",
  )) {
    if (parking.has(r.id)) continue;
    const pending = parkHumanRequest(r, options)
      .catch(() => {
        // Keep the hold on cleanup failure, and retry on the next worker tick.
      })
      .finally(() => parking.delete(r.id));
    parking.set(r.id, pending);
  }
  return Promise.all([...parking.values()]);
}
