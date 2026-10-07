import { id, one, run } from "./store.mjs";

const readyStates = new Set(["ready", "idle", "running"]);

// Reconcile billing usage only after the provider has confirmed that a box is
// running. This repairs a resume whose response was lost without inventing
// usage for an archived/stopped box. The caller should invoke this while it
// holds the per-computer start/reconciliation lock.
export function reconcileComputerUsage(
  computer,
  { time = Date.now() } = {},
) {
  if (
    !computer?.id ||
    !computer.company_id ||
    !computer.box_id ||
    !readyStates.has(computer.state)
  )
    return false;
  const existing = one(
    "SELECT 1 FROM computer_usage WHERE computer_id=? AND ended IS NULL LIMIT 1",
    computer.id,
  );
  if (existing) return false;
  const last = one(
    "SELECT ended FROM computer_usage WHERE computer_id=? AND ended IS NOT NULL ORDER BY ended DESC LIMIT 1",
    computer.id,
  );
  const candidate = Number(computer.started_at);
  const started = Number.isFinite(candidate) &&
    candidate > 0 && candidate <= time &&
    (!last || candidate > Number(last.ended))
    ? candidate
    : time;
  run(
    "INSERT INTO computer_usage(id,computer_id,company_id,started,ended) VALUES(?,?,?,?,NULL)",
    id(),
    computer.id,
    computer.company_id,
    started,
  );
  return true;
}

export const computerUsageInternals = { readyStates };
