import { z } from "zod";
import { db, all, one, run, tenant, can, audit, emit, fail } from "./store.mjs";
import {
  getDuckContactPolicy,
  setDuckContactPolicy,
} from "./duck-contacts.mjs";
// Absence means enabled, matching duck_computer_access. Saving a secret is on
// for every duck unless someone turns it off, so a duck that creates an account
// always has somewhere to put the password it just chose.
export function duckSecretsEnabled(duck, company) {
  return (
    one(
      "SELECT enabled FROM duck_secret_access WHERE duck_id=? AND company_id=?",
      duck,
      company,
    )?.enabled !== 0
  );
}
// Notes a duck keeps for itself. Switching this off stops it writing new ones;
// notes a person wrote for it still load, because those are the human's
// guidance rather than the duck's own memory.
export function duckNotesEnabled(duck, company) {
  return (
    one(
      "SELECT enabled FROM duck_note_access WHERE duck_id=? AND company_id=?",
      duck,
      company,
    )?.enabled !== 0
  );
}
export function assertDuckNotes(duck, company) {
  if (!duckNotesEnabled(duck, company))
    fail(
      403,
      "Keeping your own notes is switched off for this duck. A human can turn it back on in duck settings.",
    );
}
export function assertDuckSecrets(duck, company) {
  if (!duckSecretsEnabled(duck, company))
    fail(
      403,
      "Saving and reading secrets is switched off for this duck. A human can turn it back on in duck settings.",
    );
}
// One row per duck, gathering the per-duck switches that live in separate
// tables, so a single screen can show and change all of them together.
export function duckSettings(company, userId) {
  const off = new Set(
    all(
      "SELECT duck_id FROM duck_secret_access WHERE company_id=? AND enabled=0",
      company,
    ).map((r) => r.duck_id),
  );
  const noNotes = new Set(
    all(
      "SELECT duck_id FROM duck_note_access WHERE company_id=? AND enabled=0",
      company,
    ).map((r) => r.duck_id),
  );
  const noComputer = new Set(
    all(
      "SELECT duck_id FROM duck_computer_access WHERE company_id=? AND enabled=0",
      company,
    ).map((r) => r.duck_id),
  );
  const noProxy = new Set(
    all(
      "SELECT duck_id FROM duck_proxy_access WHERE company_id=? AND enabled=0",
      company,
    ).map((r) => r.duck_id),
  );
  // Off unless switched on, which is the opposite of the others.
  const maySchedule = new Set(
    all(
      "SELECT duck_id FROM duck_schedule_access WHERE company_id=? AND enabled=1",
      company,
    ).map((r) => r.duck_id),
  );
  const waits = new Map(
    all(
      "SELECT duck_id,minutes FROM human_wait_duck_overrides WHERE user_id=? AND company_id=?",
      userId,
      company,
    ).map((r) => [r.duck_id, r.minutes]),
  );
  // Off until somebody turns it on, like schedules. Only whether it is on: the
  // rest lives on the duck's Webhook tab.
  const hooked = new Set(
    all(
      "SELECT duck_id FROM duck_webhooks WHERE company_id=? AND enabled=1",
      company,
    ).map((r) => r.duck_id),
  );
  // A duck that has been taken off the team has no switches worth setting: it
  // is never asked to do anything. It is listed separately, as something to put
  // back.
  return all(
    "SELECT id,name,role,chief FROM ducks WHERE company_id=? AND removed=0 ORDER BY chief DESC,created",
    company,
  ).map((d) => ({
    id: d.id,
    name: d.name,
    role: d.role,
    chief: !!d.chief,
    secrets: !off.has(d.id),
    notes: !noNotes.has(d.id),
    computer: !noComputer.has(d.id),
    proxy: !noProxy.has(d.id),
    // Unlike the others, this one is off until somebody turns it on: a schedule
    // keeps spending on its own once it exists.
    schedules: maySchedule.has(d.id),
    wait_minutes: waits.get(d.id) ?? null,
    contact_policy: getDuckContactPolicy(company, d.id),
    webhook: hooked.has(d.id),
  }));
}
const uuid = z.string().uuid();
const patch = z
  .object({
    duck_ids: z.array(uuid).min(1).max(100),
    secrets: z.boolean().optional(),
    notes: z.boolean().optional(),
    computer: z.boolean().optional(),
    proxy: z.boolean().optional(),
    schedules: z.boolean().optional(),
    wait_minutes: z.number().int().min(1).max(15).nullable().optional(),
  })
  .refine(
    (v) =>
      v.secrets !== undefined ||
      v.notes !== undefined ||
      v.computer !== undefined ||
      v.proxy !== undefined ||
      v.schedules !== undefined ||
      v.wait_minutes !== undefined,
    "Choose a setting to change.",
  );
export function registerDuckSettings(app) {
  app.get("/api/duck-settings", (req, res) => {
    can(req.member, "ducks");
    res.json({ ducks: duckSettings(req.company.id, req.user.id) });
  });
  app.patch("/api/duck-settings", (req, res) => {
    can(req.member, "ducks");
    const a = patch.parse(req.body);
    const company = req.company.id;
    for (const d of a.duck_ids)
      if (tenant("ducks", d, company).removed)
        fail(404, "This duck is no longer on the team.");
    db.transaction(() => {
      for (const duck of a.duck_ids) {
        if (a.secrets !== undefined)
          run(
            "INSERT INTO duck_secret_access VALUES(?,?,?) ON CONFLICT(duck_id) DO UPDATE SET company_id=excluded.company_id,enabled=excluded.enabled",
            duck,
            company,
            +a.secrets,
          );
        if (a.schedules !== undefined)
          run(
            "INSERT INTO duck_schedule_access VALUES(?,?,?) ON CONFLICT(duck_id) DO UPDATE SET company_id=excluded.company_id,enabled=excluded.enabled",
            duck,
            company,
            +a.schedules,
          );
        if (a.notes !== undefined)
          run(
            "INSERT INTO duck_note_access VALUES(?,?,?) ON CONFLICT(duck_id) DO UPDATE SET company_id=excluded.company_id,enabled=excluded.enabled",
            duck,
            company,
            +a.notes,
          );
        if (a.computer !== undefined)
          run(
            "INSERT INTO duck_computer_access VALUES(?,?,?) ON CONFLICT(duck_id) DO UPDATE SET company_id=excluded.company_id,enabled=excluded.enabled",
            duck,
            company,
            +a.computer,
          );
        if (a.proxy !== undefined)
          run(
            "INSERT INTO duck_proxy_access VALUES(?,?,?) ON CONFLICT(duck_id,company_id) DO UPDATE SET enabled=excluded.enabled",
            duck,
            company,
            +a.proxy,
          );
        if (a.wait_minutes !== undefined) {
          if (a.wait_minutes === null)
            run(
              "DELETE FROM human_wait_duck_overrides WHERE user_id=? AND duck_id=? AND company_id=?",
              req.user.id,
              duck,
              company,
            );
          else
            run(
              "INSERT INTO human_wait_duck_overrides(user_id,duck_id,company_id,minutes,updated) VALUES(?,?,?,?,?) ON CONFLICT(user_id,duck_id) DO UPDATE SET company_id=excluded.company_id,minutes=excluded.minutes,updated=excluded.updated",
              req.user.id,
              duck,
              company,
              a.wait_minutes,
              new Date().toISOString(),
            );
        }
      }
    })();
    audit(company, req.user.id, "Duck settings updated", {
      ducks: a.duck_ids.length,
      secrets: a.secrets,
      notes: a.notes,
      computer: a.computer,
      proxy: a.proxy,
      wait_minutes: a.wait_minutes,
    });
    emit(company);
    if (a.proxy === false)
      return import("./computers.mjs").then(
        async ({ revokeDuckProxyForDucks }) => {
          const warning = await revokeDuckProxyForDucks(company, a.duck_ids);
          res.json({
            ducks: duckSettings(company, req.user.id),
            ...(warning ? { warning } : {}),
          });
        },
      );
    res.json({ ducks: duckSettings(company, req.user.id) });
  });
  app.get("/api/ducks/:id/contacts", (req, res) => {
    can(req.member, "ducks");
    tenant("ducks", req.params.id, req.company.id);
    res.json({
      contact_policy: getDuckContactPolicy(req.company.id, req.params.id),
    });
  });
  app.patch("/api/ducks/:id/contacts", (req, res) => {
    can(req.member, "ducks");
    tenant("ducks", req.params.id, req.company.id);
    res.json({
      contact_policy: setDuckContactPolicy(
        req.company.id,
        req.params.id,
        req.body,
        { user_id: req.user.id },
      ),
    });
  });
}
