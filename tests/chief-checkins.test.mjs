import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "td-chief-checkins-"));
process.env.DATA_DIR = scratch;
process.env.ENCRYPTION_KEY = "11".repeat(32);
const s = await import("../server/store.mjs");
const c = await import("../server/chief-checkins.mjs");
const { enqueue } = await import("../server/duck-tools.mjs");
const { decoratedMessages, visibleMessageSql, notifiableMessageSql } =
  await import("../server/chat-store.mjs");
after(() => {
  s.db.close();
  fs.rmSync(scratch, { recursive: true, force: true });
});
function fixture() {
  const user = s.id();
  s.run(
    "INSERT INTO users VALUES(?,?,?,?,?,?)",
    user,
    user + "@example.test",
    "Person",
    "unused",
    null,
    s.now(),
  );
  const company = s.createCompany(user, "Chief check-in test");
  const duck = s.one(
    "SELECT * FROM ducks WHERE company_id=? AND chief=1",
    company,
  );
  const deps = { enqueue, aiStatus: async () => ({ connected: true }) };
  return { user, company, duck, deps };
}
const at = Date.UTC(2026, 9, 5, 8);
const enable = (f) =>
  c.saveChiefCheckins(f.user, f.company, { enabled: true }, at);
const jobs = (f) =>
  s.all("SELECT * FROM jobs WHERE company_id=? AND checkin=1", f.company);
function finish(
  f,
  summary = "Review the new customer request.",
  quiet = false,
) {
  const job = jobs(f).at(-1);
  s.run("UPDATE jobs SET status='running' WHERE id=?", job.id);
  const result = c.finishCheckin(
    job,
    { outcome: "completed", summary, quiet },
    at + 1000,
  );
  s.run("UPDATE jobs SET status='done' WHERE id=?", job.id);
  s.run(
    "UPDATE messages SET body=?,state='sent' WHERE id=?",
    result.quiet ? "" : result.summary,
    job.output_message_id,
  );
  return { job, result };
}
test("uninitialized settings are personal, off, weekdays, standard times; strict patches reject identity/model and duplicate times", () => {
  const f = fixture();
  assert.deepEqual(
    c.chiefCheckinSettings(f.user, f.company, at).times,
    [540, 900],
  );
  assert.equal(c.chiefCheckinSettings(f.user, f.company, at).enabled, false);
  assert.equal(
    c.chiefCheckinSettings(f.user, f.company, at).weekdays_only,
    true,
  );
  for (const patch of [
    { model: "x" },
    { duck_id: f.duck.id },
    { times: [540, 540] },
    { times: [] },
    { times: [-1] },
    { times: [1440] },
    {},
  ])
    assert.throws(() => c.saveChiefCheckins(f.user, f.company, patch, at));
});
test("usable Chief connection creates a durable future default once without starting inference", async () => {
  const f = fixture();
  let probes = 0;
  const init = () =>
    c.initializeMissingChiefCheckins(
      f.company,
      async () => {
        probes++;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return true;
      },
      at,
    );
  await Promise.all([init(), init()]);
  const row = s.one(
    "SELECT * FROM chief_checkin_settings WHERE user_id=? AND company_id=?",
    f.user,
    f.company,
  );
  assert.equal(row.enabled, 1);
  assert.deepEqual(JSON.parse(row.times), [540, 900]);
  assert.equal(row.weekdays_only, 1);
  assert.ok(row.next_at > at);
  assert.equal(jobs(f).length, 0);
  assert.equal(probes, 1);
  c.saveChiefCheckins(f.user, f.company, { enabled: false }, at);
  assert.equal(await init(), 0);
  assert.equal(probes, 1);
  assert.equal(c.chiefCheckinSettings(f.user, f.company, at).enabled, false);
});
test("background engine initializes eligible members without an app visit", async () => {
  const f = fixture();
  await c.tickChiefCheckins(
    {
      enqueue,
      aiStatus: async () => ({ connected: false }),
      modelAvailable: async () => true,
    },
    at,
  );
  assert.equal(c.chiefCheckinSettings(f.user, f.company, at).enabled, true);
  assert.equal(jobs(f).length, 0);
});
test("missing or unusable connections stay unset and can initialize after recovery", async () => {
  const f = fixture();
  assert.equal(
    await c.initializeMissingChiefCheckins(f.company, async () => false, at),
    0,
  );
  assert.equal(
    s.one(
      "SELECT count(*) n FROM chief_checkin_settings WHERE company_id=?",
      f.company,
    ).n,
    0,
  );
  assert.equal(
    await c.initializeMissingChiefCheckins(
      f.company,
      async () => true,
      at + 31_000,
    ),
    1,
  );
  assert.equal(c.chiefCheckinSettings(f.user, f.company, at).enabled, true);
});
test("Chief changes, lost eligibility, and a saved Off during probing prevent default insertion", async () => {
  for (const change of ["chief", "membership", "off", "model"]) {
    const f = fixture();
    let resolve;
    const pending = c.initializeMissingChiefCheckins(
      f.company,
      Object.assign(
        () => new Promise((r) => (resolve = r)),
        change === "model"
          ? {
              assignmentSnapshot: () =>
                s.one(
                  "SELECT model FROM duck_models WHERE company_id=? AND duck_id=?",
                  f.company,
                  f.duck.id,
                )?.model || "original",
            }
          : {},
      ),
      at,
    );
    await new Promise((r) => setImmediate(r));
    if (change === "chief")
      s.run("UPDATE ducks SET chief=0 WHERE id=?", f.duck.id);
    if (change === "membership")
      s.run(
        "DELETE FROM memberships WHERE user_id=? AND company_id=?",
        f.user,
        f.company,
      );
    if (change === "off")
      c.saveChiefCheckins(f.user, f.company, { enabled: false }, at);
    if (change === "model")
      s.run(
        "INSERT INTO duck_models(duck_id,company_id,provider,model) VALUES(?,?,?,?) ON CONFLICT(duck_id) DO UPDATE SET model=excluded.model",
        f.duck.id,
        f.company,
        "codex",
        "new-model",
      );
    resolve(true);
    await pending;
    if (change === "off")
      assert.equal(
        c.chiefCheckinSettings(f.user, f.company, at).enabled,
        false,
      );
    else
      assert.equal(
        s.one(
          "SELECT count(*) n FROM chief_checkin_settings WHERE company_id=?",
          f.company,
        ).n,
        0,
      );
  }
});
test("new assignment does not reuse a prior assignment's in-flight availability", async () => {
  const f = fixture();
  let assignment = "old",
    calls = 0,
    resolveOld,
    started;
  const probeStarted = new Promise((resolve) => (started = resolve));
  const modelAvailable = Object.assign(
    () => {
      calls++;
      if (calls === 1)
        return new Promise((resolve) => {
          resolveOld = resolve;
          started();
        });
      return false;
    },
    { assignmentSnapshot: () => assignment },
  );
  const oldAttempt = c.initializeMissingChiefCheckins(
    f.company,
    modelAvailable,
    at,
  );
  await probeStarted;
  assignment = "new";
  const newAttempt = c.initializeMissingChiefCheckins(
    f.company,
    modelAvailable,
    at,
  );
  assert.equal(await newAttempt, 0);
  resolveOld(true);
  assert.equal(await oldAttempt, 0);
  assert.equal(calls, 2);
  assert.equal(
    s.one(
      "SELECT count(*) n FROM chief_checkin_settings WHERE company_id=?",
      f.company,
    ).n,
    0,
  );
});
test("model availability follows the Chief assignment and runtime fallback policy", async () => {
  const check = c.createChiefCheckinModelAvailability({
    modelPlan: () => [
      { provider: "chosen", model: "bad" },
      { provider: "fallback", model: "good" },
    ],
    validateModelSelection: (choice) => {
      if (choice.model === "bad")
        throw Object.assign(new Error("invalid"), { modelPolicy: true });
    },
    isSubscription: () => false,
    credential: (_company, provider) =>
      provider === "fallback" ? "key" : null,
    resolveAvailableModel: async () => ({
      provider: "fallback",
      model: "good",
    }),
    aiStatus: async () => ({ codex: { connected: false } }),
    codexModels: async () => [],
  });
  // Invalid assignments are model-policy failures and cannot be hidden by a
  // usable company fallback.
  assert.equal(await check("company", { id: "chief" }), false);
  const disconnectedThenFallback = c.createChiefCheckinModelAvailability({
    modelPlan: () => [
      { provider: "chosen", model: "good" },
      { provider: "fallback", model: "good" },
    ],
    validateModelSelection: () => {},
    isSubscription: () => false,
    credential: (_company, provider) =>
      provider === "fallback" ? "key" : null,
    resolveAvailableModel: async () => ({
      provider: "fallback",
      model: "good",
    }),
    aiStatus: async () => ({ codex: { connected: false } }),
    codexModels: async () => [],
  });
  assert.equal(
    await disconnectedThenFallback("company", { id: "chief" }),
    true,
  );
  const unexpectedFailure = c.createChiefCheckinModelAvailability({
    modelPlan: () => [
      { provider: "chosen", model: "good" },
      { provider: "fallback", model: "good" },
    ],
    validateModelSelection: () => {},
    isSubscription: () => false,
    credential: () => "key",
    resolveAvailableModel: async () => {
      throw new Error("unexpected internal failure");
    },
    aiStatus: async () => ({ codex: { connected: false } }),
    codexModels: async () => [],
  });
  assert.equal(await unexpectedFailure("company", { id: "chief" }), false);
  const unrelatedProviderOnly = c.createChiefCheckinModelAvailability({
    modelPlan: () => [{ provider: "chosen", model: "good" }],
    validateModelSelection: () => {},
    isSubscription: () => false,
    credential: () => null,
    resolveAvailableModel: async () => ({ provider: "chosen", model: "good" }),
    aiStatus: async () => ({ connected: true }),
    codexModels: async () => [],
  });
  assert.equal(await unrelatedProviderOnly("company", { id: "chief" }), false);
  let nativeResolutions = 0;
  const codex = (connected) =>
    c.createChiefCheckinModelAvailability({
      modelPlan: () => [{ provider: "codex", model: "" }],
      validateModelSelection: () => {},
      isSubscription: () => true,
      credential: () => null,
      resolveAvailableModel: async () => {
        nativeResolutions++;
        return { provider: "codex", model: "gpt-6.1" };
      },
      aiStatus: async () => ({ codex: { connected } }),
      codexModels: async () => [],
    });
  assert.equal(await codex(false)("company", { id: "chief" }), false);
  assert.equal(nativeResolutions, 0);
  assert.equal(await codex(true)("company", { id: "chief" }), true);
  assert.equal(nativeResolutions, 1);
});
test("weekdays and DST retain the workspace wall clock", () => {
  assert.equal(
    new Date(
      c.nextCheckinAt(
        [540],
        true,
        "Europe/Amsterdam",
        Date.UTC(2026, 9, 9, 15),
      ),
    ).toISOString(),
    "2026-10-12T07:00:00.000Z",
  );
  assert.equal(
    new Date(
      c.nextCheckinAt(
        [540],
        false,
        "Europe/Amsterdam",
        Date.UTC(2026, 9, 9, 15),
      ),
    ).toISOString(),
    "2026-10-10T07:00:00.000Z",
  );
  assert.equal(
    new Date(
      c.nextCheckinAt(
        [540],
        true,
        "Europe/Amsterdam",
        Date.UTC(2026, 9, 23, 15),
      ),
    ).toISOString(),
    "2026-10-26T08:00:00.000Z",
  );
});
test("concurrent checks claim once, set checkin before recovery, keep internal rows invisible", async () => {
  const f = fixture();
  enable(f);
  const results = await Promise.all([
    c.startChiefCheckin(f.user, f.company, f.deps, { at }),
    c.startChiefCheckin(f.user, f.company, f.deps, { at }),
  ]);
  assert.equal(results.filter((x) => x.started).length, 1);
  assert.equal(jobs(f).length, 1);
  const job = jobs(f)[0];
  assert.equal(job.recovery_root_job_id, null);
  assert.equal(
    s.one(
      "SELECT count(*) n FROM messages m WHERE m.id IN (?,?) AND " +
        visibleMessageSql(),
      job.input_message_id,
      job.output_message_id,
    ).n,
    0,
  );
  assert.equal(
    s.one(
      "SELECT count(*) n FROM messages m WHERE m.id IN (?,?) AND " +
        notifiableMessageSql(),
      job.input_message_id,
      job.output_message_id,
    ).n,
    0,
  );
  assert.equal(
    decoratedMessages(f.company, job.conversation_id).some((m) =>
      [job.input_message_id, job.output_message_id].includes(m.id),
    ),
    false,
  );
});
test("completed quiet checks skip unchanged inference; useful output does not dirty its own context", async () => {
  const f = fixture();
  enable(f);
  await c.startChiefCheckin(f.user, f.company, f.deps, { at });
  finish(f, "Nothing new.", true);
  assert.match(
    (await c.startChiefCheckin(f.user, f.company, f.deps, { at })).reason,
    /Nothing relevant/,
  );
  s.run("UPDATE ducks SET notes=? WHERE id=?", "A new goal", f.duck.id);
  assert.equal(
    (await c.startChiefCheckin(f.user, f.company, f.deps, { at })).started,
    true,
  );
  const { job } = finish(f);
  assert.equal(
    decoratedMessages(f.company, job.conversation_id).find(
      (m) => m.id === job.output_message_id,
    ).chief_checkin.dismissed,
    false,
  );
  assert.match(
    (await c.startChiefCheckin(f.user, f.company, f.deps, { at })).reason,
    /Nothing relevant/,
  );
});
test("duplicate suggestions remain quiet after unrelated context changes, including dismissed suggestions", async () => {
  const f = fixture();
  enable(f);
  await c.startChiefCheckin(f.user, f.company, f.deps, { at });
  finish(f);
  s.run(
    "UPDATE chief_checkin_runs SET dismissed=1,result='dismissed' WHERE company_id=?",
    f.company,
  );
  s.run("UPDATE ducks SET notes=? WHERE id=?", "Another goal", f.duck.id);
  await c.startChiefCheckin(f.user, f.company, f.deps, { at });
  assert.equal(finish(f).result.quiet, true);
});
test("Off during AI availability await prevents enqueue and Off invalidates in-flight publication", async () => {
  const f = fixture();
  enable(f);
  let resolve;
  const pending = c.startChiefCheckin(
    f.user,
    f.company,
    {
      enqueue,
      aiStatus: () =>
        new Promise((r) => {
          resolve = r;
        }),
    },
    { at },
  );
  c.saveChiefCheckins(f.user, f.company, { enabled: false }, at);
  resolve({ connected: true });
  assert.equal((await pending).started, false);
  assert.equal(jobs(f).length, 0);
  enable(f);
  await c.startChiefCheckin(f.user, f.company, f.deps, { at });
  const job = jobs(f)[0];
  s.run("UPDATE jobs SET status='running' WHERE id=?", job.id);
  c.saveChiefCheckins(f.user, f.company, { enabled: false }, at);
  assert.equal(
    s.one("SELECT status FROM jobs WHERE id=?", job.id).status,
    "cancelled",
  );
  assert.throws(() =>
    c.finishCheckin(job, {
      outcome: "completed",
      summary: "Do something",
      quiet: false,
    }),
  );
});
test("removed/replaced Chief and lost membership invalidate running checks; no specialist target", async () => {
  const f = fixture();
  enable(f);
  await c.startChiefCheckin(f.user, f.company, f.deps, { at });
  const job = jobs(f)[0];
  s.run("UPDATE ducks SET chief=0 WHERE id=?", f.duck.id);
  assert.throws(() => c.checkinAllowed(job));
  s.run("UPDATE ducks SET chief=1 WHERE id=?", f.duck.id);
  s.run(
    "DELETE FROM memberships WHERE user_id=? AND company_id=?",
    f.user,
    f.company,
  );
  assert.throws(() => c.checkinAllowed(job));
});
test("engine skips stale slots, paused/noAI, and busy Chief across users without backlog", async () => {
  const f = fixture();
  enable(f);
  let next = c.chiefCheckinSettings(f.user, f.company, at).next_at;
  await c.tickChiefCheckins(f.deps, next + 16 * 60000);
  assert.equal(jobs(f).length, 0);
  assert.ok(
    c.chiefCheckinSettings(f.user, f.company, next + 16 * 60000).next_at > next,
  );
  next = c.chiefCheckinSettings(f.user, f.company, at).next_at;
  await c.tickChiefCheckins(
    { enqueue, aiStatus: async () => ({ connected: false }) },
    next,
  );
  assert.equal(jobs(f).length, 0);
  s.run("UPDATE companies SET paused=1 WHERE id=?", f.company);
  assert.equal(
    (await c.startChiefCheckin(f.user, f.company, f.deps, { at })).started,
    false,
  );
  s.run("UPDATE companies SET paused=0 WHERE id=?", f.company);
  await c.startChiefCheckin(f.user, f.company, f.deps, { at });
  assert.match(
    (await c.startChiefCheckin(f.user, f.company, f.deps, { at })).reason,
    /busy/,
  );
});
test("permitted context excludes other users private chats and internal check-in history", async () => {
  const f = fixture(),
    other = s.id();
  s.run(
    "INSERT INTO users VALUES(?,?,?,?,?,?)",
    other,
    other + "@example.test",
    "Other",
    "unused",
    null,
    s.now(),
  );
  s.run(
    "INSERT INTO memberships VALUES(?,?,?,?)",
    f.company,
    other,
    "member",
    "{}",
  );
  const privateChat = s.directConversation(f.company, other, f.duck);
  s.addMessage(f.company, privateChat.id, "Private other-user goal", {
    user: other,
  });
  assert.equal(
    c
      .checkinContext(f.user, f.company)
      .messages.some((m) => m.body.includes("Private other-user")),
    false,
  );
  enable(f);
  await c.startChiefCheckin(f.user, f.company, f.deps, { at });
  assert.equal(
    c
      .checkinContext(f.user, f.company)
      .messages.some((m) => m.body.includes("suggestion-only")),
    false,
  );
});
test("API handlers enforce scope and dismissal leaves the published content and settings intact", async () => {
  const f = fixture();
  enable(f);
  await c.startChiefCheckin(f.user, f.company, f.deps, { at });
  const { job } = finish(f);
  const r = s.one("SELECT id FROM chief_checkin_runs WHERE job_id=?", job.id);
  const routes = new Map();
  c.registerChiefCheckins(
    {
      get: (p, h) => routes.set("GET " + p, h),
      patch: (p, h) => routes.set("PATCH " + p, h),
      post: (p, h) => routes.set("POST " + p, h),
    },
    f.deps,
  );
  const req = {
    user: { id: f.user },
    company: { id: f.company },
    member: s.memberFor(f.company, f.user),
    params: { id: r.id },
  };
  let output;
  routes.get("POST /api/chief-checkins/runs/:id/dismiss")(req, {
    json: (x) => {
      output = x;
    },
  });
  assert.equal(output.ok, true);
  assert.equal(
    s.one("SELECT body FROM messages WHERE id=?", job.output_message_id).body,
    "Review the new customer request.",
  );
  assert.equal(c.chiefCheckinSettings(f.user, f.company, at).enabled, true);
  assert.equal(
    decoratedMessages(f.company, job.conversation_id).find(
      (m) => m.id === job.output_message_id,
    ).chief_checkin.dismissed,
    true,
  );
  assert.throws(
    () =>
      routes.get("POST /api/chief-checkins/runs/:id/dismiss")(
        { ...req, user: { id: s.id() } },
        { json() {} },
      ),
    /unavailable/,
  );
});

test("skipped manual and scheduled attempts durably explain their outcome without claiming inference", async () => {
  const f = fixture();
  enable(f);
  const check = () => c.chiefCheckinSettings(f.user, f.company, at);
  let next = check().next_at;
  await c.tickChiefCheckins(f.deps, next + 16 * 60_000);
  assert.equal(check().last_result, "missed");
  assert.equal(check().last_checked_at, next + 16 * 60_000);
  await c.startChiefCheckin(
    f.user,
    f.company,
    { enqueue, aiStatus: async () => ({ connected: false }) },
    { at },
  );
  assert.equal(check().last_result, "unavailable");
  assert.equal(jobs(f).length, 0);
  s.run("UPDATE companies SET paused=1 WHERE id=?", f.company);
  await c.startChiefCheckin(f.user, f.company, f.deps, { at });
  assert.equal(check().last_result, "paused");
  s.run("UPDATE companies SET paused=0 WHERE id=?", f.company);
  await c.startChiefCheckin(f.user, f.company, f.deps, { at });
  assert.equal(check().last_result, "checking");
  await c.startChiefCheckin(f.user, f.company, f.deps, { at });
  assert.equal(check().last_result, "busy");
  finish(f, "Nothing new", true);
  const fingerprint = s.one(
    "SELECT last_context_hash FROM chief_checkin_settings WHERE user_id=? AND company_id=?",
    f.user,
    f.company,
  ).last_context_hash;
  await c.startChiefCheckin(f.user, f.company, f.deps, { at });
  assert.equal(check().last_result, "unchanged");
  assert.equal(
    s.one(
      "SELECT last_context_hash FROM chief_checkin_settings WHERE user_id=? AND company_id=?",
      f.user,
      f.company,
    ).last_context_hash,
    fingerprint,
  );
  c.saveChiefCheckins(f.user, f.company, { enabled: false }, at);
  const before = check();
  await c.startChiefCheckin(f.user, f.company, f.deps, { at: at + 60_000 });
  assert.deepEqual(check(), before);
});

test("held and paused ordinary work is retained as an exclusion with the permitted audience", async () => {
  const f = fixture(),
    conv = s.directConversation(f.company, f.user, f.duck);
  const input = s.addMessage(
    f.company,
    conv.id,
    "Leave the invoice task paused until I say resume.",
    { user: f.user },
  );
  const ordinary = enqueue(f.company, f.user, conv.id, f.duck.id, input);
  s.run("UPDATE jobs SET status='running' WHERE id=?", ordinary);
  const { finishWork } = await import("../server/work-finish.mjs");
  finishWork(
    s.one("SELECT * FROM jobs WHERE id=?", ordinary),
    {
      outcome: "incomplete",
      summary: "The person paused this.",
      reason: "Human pause",
      remaining_work: "Invoice follow-up",
      control_revision: 0,
      resume_policy: "hold",
    },
    "held-test",
  );
  s.run("UPDATE jobs SET status='done' WHERE id=?", ordinary);
  const context = c.checkinContext(f.user, f.company);
  assert.equal(context.protected_work.jobs[0].resume_policy, "hold");
  assert.equal(context.protected_work.held[0].state, "held");
  assert.match(context.protected_work.held[0].original_request, /paused/);
  const unrelated = fixture();
  assert.equal(
    c.checkinContext(unrelated.user, unrelated.company).protected_work.held
      .length,
    0,
  );
  enable(f);
  await c.startChiefCheckin(f.user, f.company, f.deps, { at });
  const fingerprint = JSON.stringify(
    c.checkinContext(f.user, f.company).protected_work,
  );
  finish(f, "No new suggestion.", true);
  assert.equal(
    JSON.stringify(c.checkinContext(f.user, f.company).protected_work),
    fingerprint,
  );
});
