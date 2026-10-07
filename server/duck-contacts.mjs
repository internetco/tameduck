import { z } from "zod";
import {
  db,
  all,
  one,
  run,
  now,
  tenant,
  fail,
  permissions,
  memberFor,
  audit,
  emit,
} from "./store.mjs";

export const DEFAULT_CONTACT_POLICY = Object.freeze({
  mode: "all",
  allowed_duck_ids: [],
  chief_can_manage: true,
  max_requests_per_task: null,
  max_parallel_requests: null,
  version: 0,
});
const mode = z.enum(["all", "selected", "none"]);
const patchShape = z.object({
  mode: mode.optional(),
  allowed_duck_ids: z.array(z.string().uuid()).max(100).optional(),
  chief_can_manage: z.boolean().optional(),
  max_requests_per_task: z.number().int().min(1).max(1000).nullable().optional(),
  max_parallel_requests: z.number().int().min(1).max(1000).nullable().optional(),
  expected_version: z.number().int().min(0).optional(),
});
function activeDuck(company, id) {
  const duck = tenant("ducks", id, company);
  if (duck.removed)
    fail(
      409,
      duck.name +
        " was taken off the team, so it cannot be a contact. Put it back from the Team page if you want it again.",
    );
  return duck;
}
function rowPolicy(row) {
  if (!row) return { ...DEFAULT_CONTACT_POLICY, allowed_duck_ids: [] };
  return {
    mode: row.mode,
    allowed_duck_ids: JSON.parse(row.allowed_duck_ids || "[]"),
    chief_can_manage: !!row.chief_can_manage,
    max_requests_per_task: row.max_requests_per_task == null ? null : row.max_requests_per_task,
    max_parallel_requests: row.max_parallel_requests ?? null,
    version: row.version,
  };
}
export function getDuckContactPolicy(company, duckId) {
  activeDuck(company, duckId);
  return rowPolicy(
    one(
      "SELECT mode,allowed_duck_ids,chief_can_manage,max_requests_per_task,max_parallel_requests,version FROM duck_contact_policies WHERE company_id=? AND duck_id=?",
      company,
      duckId,
    ),
  );
}
function actorInfo(company, actor, target) {
  if (!actor || typeof actor.user_id !== "string")
    fail(403, "A human or Chief actor is required.");
  const member = memberFor(company, actor.user_id);
  if (!member || !permissions(member).ducks)
    fail(403, "You do not have permission to configure ducks.");
  if (!actor.duck_id)
    return { type: "human", current: getDuckContactPolicy(company, target) };
  const duck = one(
    "SELECT * FROM ducks WHERE id=? AND company_id=? AND removed=0",
    actor.duck_id,
    company,
  );
  if (!duck || !duck.chief)
    fail(403, "Only the active Chief can manage contact policies as a duck.");
  const current = getDuckContactPolicy(company, target);
  if (!current.chief_can_manage)
    fail(403, "Chief is not allowed to manage this duck's contact policy.");
  return { type: "Chief", current, duck };
}
export function setDuckContactPolicy(company, duckId, input, actor) {
  const a = patchShape.parse(input || {});
  if (a.expected_version === undefined)
    fail(400, "expected_version is required when saving a contact policy.");
  const target = activeDuck(company, duckId);
  const acting = actorInfo(company, actor, target.id);
  if (acting.type === "Chief" && a.chief_can_manage !== undefined)
    fail(403, "Chief cannot change the human lock on a contact policy.");
  const current = acting.current;
  const next = {
    mode: a.mode ?? current.mode,
    allowed_duck_ids: a.allowed_duck_ids ?? current.allowed_duck_ids,
    chief_can_manage: a.chief_can_manage ?? current.chief_can_manage,
    max_requests_per_task: a.max_requests_per_task !== undefined ? a.max_requests_per_task : current.max_requests_per_task,
    max_parallel_requests: a.max_parallel_requests !== undefined ? a.max_parallel_requests : current.max_parallel_requests,
  };
  if (next.mode !== "selected") next.allowed_duck_ids = [];
  if (next.mode === "selected") {
    const seen = new Set();
    // A duck taken off the team stays on the lists it was already on, so that
    // putting it back restores them. The contacts screen does not show it and
    // sends it back unchanged, and refusing that blocked every save.
    const kept = new Set(current.allowed_duck_ids);
    for (const id of next.allowed_duck_ids) {
      if (seen.has(id)) fail(400, "A contact target may only be listed once.");
      seen.add(id);
      if (id === duckId) fail(400, "A duck cannot contact itself.");
      if (kept.has(id)) tenant("ducks", id, company);
      else activeDuck(company, id);
    }
  }
  const saved = db.transaction(() => {
    const existing = one(
      "SELECT version FROM duck_contact_policies WHERE company_id=? AND duck_id=?",
      company,
      duckId,
    );
    const version = existing?.version ?? 0;
    if (version !== a.expected_version)
      fail(409, "This contact policy changed. Reload it before saving again.");
    const nextVersion = version + 1;
    run(
      `INSERT INTO duck_contact_policies (duck_id,company_id,mode,allowed_duck_ids,chief_can_manage,max_requests_per_task,max_parallel_requests,version,updated_by_user_id,updated_by_duck_id,updated) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(duck_id) DO UPDATE SET company_id=excluded.company_id,mode=excluded.mode,allowed_duck_ids=excluded.allowed_duck_ids,chief_can_manage=excluded.chief_can_manage,max_requests_per_task=excluded.max_requests_per_task,max_parallel_requests=excluded.max_parallel_requests,version=excluded.version,updated_by_user_id=excluded.updated_by_user_id,updated_by_duck_id=excluded.updated_by_duck_id,updated=excluded.updated`,
      duckId,
      company,
      next.mode,
      JSON.stringify(next.allowed_duck_ids),
      +next.chief_can_manage,
      next.max_requests_per_task,
      next.max_parallel_requests,
      nextVersion,
      actor.user_id,
      actor.duck_id || null,
      now(),
    );
    return { ...next, version: nextVersion };
  })();
  audit(company, actor.user_id, "Duck contact policy updated", {
    duck_id: duckId,
    actor: acting.type,
    actor_duck_id: actor.duck_id || null,
    mode: saved.mode,
    max_requests_per_task: saved.max_requests_per_task,
    max_parallel_requests: saved.max_parallel_requests,
    version: saved.version,
  });
  emit(company);
  return saved;
}
export function assertDuckContactAllowed(company, fromDuckId, toDuckId) {
  const from = activeDuck(company, fromDuckId);
  const to = activeDuck(company, toDuckId);
  if (from.id === to.id) fail(403, "A duck cannot contact itself.");
  const policy = getDuckContactPolicy(company, from.id);
  if (policy.mode === "none")
    fail(403, "This duck is not allowed to contact other ducks.");
  if (policy.mode === "selected" && !policy.allowed_duck_ids.includes(to.id))
    fail(403, "This duck is not an allowed contact target.");
  return true;
}
export function contactsForDuck(company, fromDuckId) {
  activeDuck(company, fromDuckId);
  const policy = getDuckContactPolicy(company, fromDuckId);
  return all(
    "SELECT id,name,role FROM ducks WHERE company_id=? AND removed=0 AND id<>? ORDER BY chief DESC,created",
    company,
    fromDuckId,
  )
    .filter(
      (duck) =>
        policy.mode === "all" ||
        (policy.mode === "selected" &&
          policy.allowed_duck_ids.includes(duck.id)),
    )
    .map(({ id, name, role }) => ({ id, name, role }));
}
