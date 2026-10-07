import { z } from "zod";
import {
  db,
  all,
  one,
  run,
  now,
  tenant,
  memberFor,
  fail,
  audit,
  emit,
} from "./store.mjs";

export const DEFAULT_HUMAN_WAIT_MINUTES = 10;
export const MIN_HUMAN_WAIT_MINUTES = 1;
export const MAX_HUMAN_WAIT_MINUTES = 15;

const minutes = z
  .number()
  .int()
  .min(MIN_HUMAN_WAIT_MINUTES)
  .max(MAX_HUMAN_WAIT_MINUTES);

export function personalHumanWaitMinutes(userId) {
  return (
    one(
      "SELECT default_minutes FROM human_wait_settings WHERE user_id=?",
      userId,
    )?.default_minutes ?? DEFAULT_HUMAN_WAIT_MINUTES
  );
}

export function effectiveHumanWaitMinutes(userId, duckId) {
  return (
    one(
      "SELECT minutes FROM human_wait_duck_overrides WHERE user_id=? AND duck_id=?",
      userId,
      duckId,
    )?.minutes ?? personalHumanWaitMinutes(userId)
  );
}

export function humanWaitSettings(userId, companyId) {
  const duckOverrides = Object.fromEntries(
    all(
      "SELECT duck_id,minutes FROM human_wait_duck_overrides WHERE user_id=? AND company_id=?",
      userId,
      companyId,
    ).map((row) => [row.duck_id, row.minutes]),
  );
  return {
    default_minutes: personalHumanWaitMinutes(userId),
    duck_overrides: duckOverrides,
  };
}

function assertMember(req) {
  if (
    !req.company?.id ||
    !req.user?.id ||
    !memberFor(req.company.id, req.user.id)
  )
    fail(403, "Your company membership has ended.");
}

const patchSchema = z
  .object({
    default_minutes: minutes.optional(),
    duck_overrides: z.record(z.string().uuid(), minutes.nullable()).optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.default_minutes !== undefined || value.duck_overrides !== undefined,
    "Choose a setting to save.",
  );

export function registerHumanWaitSettings(app) {
  app.get("/api/human-wait-settings", (req, res) => {
    assertMember(req);
    res.json(humanWaitSettings(req.user.id, req.company.id));
  });

  app.patch("/api/human-wait-settings", (req, res) => {
    assertMember(req);
    const a = patchSchema.parse(req.body);
    const overrides = a.duck_overrides || {};

    // Resolve every duck against the current company before writing anything.
    // This keeps a personal setting from being used to probe another tenant.
    for (const duckId of Object.keys(overrides))
      tenant("ducks", duckId, req.company.id);

    db.transaction(() => {
      if (a.default_minutes !== undefined)
        run(
          "INSERT INTO human_wait_settings(user_id,default_minutes,updated) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET default_minutes=excluded.default_minutes,updated=excluded.updated",
          req.user.id,
          a.default_minutes,
          now(),
        );
      for (const [duckId, value] of Object.entries(overrides)) {
        if (value === null)
          run(
            "DELETE FROM human_wait_duck_overrides WHERE user_id=? AND duck_id=? AND company_id=?",
            req.user.id,
            duckId,
            req.company.id,
          );
        else
          run(
            "INSERT INTO human_wait_duck_overrides(user_id,duck_id,company_id,minutes,updated) VALUES(?,?,?,?,?) ON CONFLICT(user_id,duck_id) DO UPDATE SET company_id=excluded.company_id,minutes=excluded.minutes,updated=excluded.updated",
            req.user.id,
            duckId,
            req.company.id,
            value,
            now(),
          );
      }
      audit(req.company.id, req.user.id, "Human wait settings updated", {
        default_minutes: a.default_minutes,
        duck_overrides: Object.keys(overrides),
      });
    })();
    emit(req.company.id);
    res.json(humanWaitSettings(req.user.id, req.company.id));
  });
}
