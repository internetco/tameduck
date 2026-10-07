import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const data = fs.mkdtempSync(path.join(os.tmpdir(), "td-checkin-runtime-"));
process.env.DATA_DIR = data;
process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex");
const s = await import("../server/store.mjs");
const tools = await import("../server/duck-tools.mjs");
const runtime = await import("../server/runtime.mjs");
const checks = await import("../server/chief-checkins.mjs");
const chat = await import("../server/chat-store.mjs");
const mail = await import("../server/mail.mjs");
mail.sendWith(async () => {});
after(() => {
  s.db.close();
  fs.rmSync(data, { recursive: true, force: true });
});

async function fixture(provider = "openrouter", model = "qa/chief-assigned") {
  const user = s.id();
  s.run(
    "INSERT INTO users VALUES(?,?,?,?,?,?)",
    user,
    user + "@example.test",
    "Check-in QA",
    "unused",
    null,
    s.now(),
  );
  const company = s.createCompany(user, "Isolated check-in QA");
  const duck = s.one(
    "SELECT * FROM ducks WHERE company_id=? AND chief=1",
    company,
  );
  const conversation = s.directConversation(company, user, duck);
  s.run(
    "INSERT INTO ai_credentials VALUES(?,?,?,?)",
    company,
    "openrouter",
    s.encrypt("isolated-test-key"),
    s.now(),
  );
  s.run(
    "INSERT INTO duck_models VALUES(?,?,?,?)",
    duck.id,
    company,
    provider,
    model,
  );
  checks.saveChiefCheckins(user, company, { enabled: true });
  const started = await checks.startChiefCheckin(user, company, {
    enqueue: tools.enqueue,
    aiStatus: async () => ({ connected: true }),
  });
  assert.equal(started.started, true);
  const job = s.one(
    "SELECT * FROM jobs WHERE company_id=? AND checkin=1",
    company,
  );
  s.run("UPDATE jobs SET status='running' WHERE id=?", job.id);
  return {
    user,
    company,
    duck,
    conversation,
    job: s.one("SELECT * FROM jobs WHERE id=?", job.id),
    provider,
    model,
  };
}
const bodyFor = (job) =>
  s.one("SELECT body FROM messages WHERE id=?", job.output_message_id).body;
const stream = (events) =>
  new Response(
    events
      .map(
        (e) =>
          "data: " + (typeof e === "string" ? e : JSON.stringify(e)) + "\n\n",
      )
      .join(""),
    { headers: { "Content-Type": "text/event-stream" } },
  );
const prose = (body) =>
  stream([
    { choices: [{ delta: { content: body }, finish_reason: null }] },
    { choices: [{ delta: {}, finish_reason: "stop" }] },
    "[DONE]",
  ]);
const toolCall = (name, args) =>
  stream([
    {
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: crypto.randomUUID(),
                function: { name, arguments: JSON.stringify(args) },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    "[DONE]",
  ]);
const complete = (summary, quiet = false) => ({
  outcome: "completed",
  summary,
  quiet,
  control_revision: 0,
});
async function apiRun(f, responses) {
  const requests = [];
  await runtime.perform(f.job, {
    resolve: async (company, choice) => choice,
    api: (job, selection) =>
      runtime.performAPI(job, selection, {
        fetcher: async (url, options) => {
          const request = JSON.parse(options.body);
          requests.push(request);
          const response = responses.shift();
          assert.ok(response, "unexpected extra provider request");
          return typeof response === "function" ? response(request) : response;
        },
      }),
  });
  return requests;
}

test("check-in follows assigned model, advertises read tools, and buffers prose before quiet finish", async () => {
  const f = await fixture();
  const requests = await apiRun(f, [
    prose("I am checking your work now."),
    () => {
      assert.equal(
        bodyFor(f.job),
        "",
        "progress must never reach the stored chat body",
      );
      return toolCall(
        "finish_work",
        complete("There is nothing new to suggest.", true),
      );
    },
  ]);
  assert.ok(
    requests.every((r) => r.model === f.model),
    "each call must use Chief assigned model",
  );
  const names = requests[0].tools.map((t) => t.function?.name || t.name);
  assert.ok(names.includes("finish_work"));
  assert.ok(
    !names.some((n) =>
      /^(computer_|mcp_|duck_|task_save|notes_|document_save|needs_you)/.test(
        n,
      ),
    ),
  );
  assert.equal(bodyFor(f.job), "");
  assert.equal(
    s.one("SELECT status FROM jobs WHERE id=?", f.job.id).status,
    "done",
  );
  assert.equal(
    s.one("SELECT result FROM chief_checkin_runs WHERE job_id=?", f.job.id)
      .result,
    "quiet",
  );
  assert.equal(
    s.one("SELECT 1 FROM unfinished_work WHERE root_job_id=?", f.job.id),
    undefined,
  );
  const output = s.one(
    "SELECT * FROM messages WHERE id=?",
    f.job.output_message_id,
  );
  assert.equal(
    s.one(
      `SELECT count(*) n FROM messages m WHERE m.id=? AND ${chat.notifiableMessageSql("m")}`,
      output.id,
    ).n,
    0,
  );
});

test("only the accepted useful summary is published once, and progress is discarded", async () => {
  const f = await fixture();
  const finding =
    "The launch research is ready. I can turn it into a decision brief if you want.";
  await apiRun(f, [
    prose("Some preliminary thoughts."),
    () => {
      assert.equal(bodyFor(f.job), "");
      return toolCall("finish_work", complete(finding));
    },
  ]);
  assert.equal(bodyFor(f.job), finding);
  assert.equal(
    s.one("SELECT origin FROM messages WHERE id=?", f.job.output_message_id)
      .origin,
    "chief_checkin_suggestion",
  );
  assert.equal(
    s.one(
      "SELECT count(*) n FROM messages WHERE company_id=? AND body=?",
      f.company,
      finding,
    ).n,
    1,
  );
  assert.equal(
    s.one(
      `SELECT count(*) n FROM messages m WHERE m.id=? AND ${chat.notifiableMessageSql("m")}`,
      f.job.output_message_id,
    ).n,
    1,
  );
});

test("unadvertised mutation, delegation, computer and connected tools are refused server-side", async () => {
  const f = await fixture();
  const count = s.one(
    "SELECT count(*) n FROM tasks WHERE company_id=?",
    f.company,
  ).n;
  for (const name of [
    "task_save",
    "duck_ask",
    "duck_recruit",
    "computer_terminal",
    "mcp_request",
    "notes_write",
    "needs_you",
  ]) {
    await assert.rejects(
      tools.handleTool(f.job, name, {}, s.id()),
      /check.in|suggestion|read.only|not allowed/i,
      name,
    );
  }
  assert.equal(
    s.one("SELECT count(*) n FROM tasks WHERE company_id=?", f.company).n,
    count,
  );
  assert.equal(
    s.one("SELECT acknowledgement FROM jobs WHERE id=?", f.job.id)
      .acknowledgement,
    null,
  );
});

test("turning check-ins off during provider execution prevents every visible publication", async () => {
  const f = await fixture();
  await apiRun(f, [
    () => {
      checks.saveChiefCheckins(f.user, f.company, { enabled: false });
      return toolCall("finish_work", complete("This must not be delivered."));
    },
  ]);
  assert.equal(bodyFor(f.job), "");
  assert.equal(
    s.one("SELECT status FROM jobs WHERE id=?", f.job.id).status,
    "cancelled",
  );
  assert.equal(
    s.one(
      `SELECT count(*) n FROM messages m WHERE m.id IN (?,?) AND ${chat.notifiableMessageSql("m")}`,
      f.job.input_message_id,
      f.job.output_message_id,
    ).n,
    0,
  );
});

test("permission loss during a check cannot publish a finding", async () => {
  const f = await fixture();
  await assert.rejects(
    apiRun(f, [
      () => {
        s.run(
          "UPDATE memberships SET role='member',permissions=? WHERE company_id=? AND user_id=?",
          JSON.stringify({ tasks: false, chat: true, ducks: true }),
          f.company,
          f.user,
        );
        return toolCall("finish_work", complete("No longer permitted."));
      },
    ]),
    /check.in|permitted|permission/i,
  );
  assert.equal(bodyFor(f.job), "");
});

function fakeCodex(onTurn) {
  const rt = Object.create(runtime.Runtime.prototype);
  rt.handlers = new Set();
  rt.toolOperations = new Set();
  rt.threadId = null;
  rt.turnId = null;
  rt.status = async () => ({ connected: true });
  rt.writes = [];
  rt.starts = [];
  rt.write = (message) => rt.writes.push(message);
  rt.request = async (method, params = {}) => {
    if (method === "thread/start") {
      rt.threadStart = params;
      return { thread: { id: "thread" } };
    }
    if (method === "turn/start") {
      const id = "turn-" + (rt.starts.length + 1);
      rt.starts.push(params);
      setTimeout(() => {
        Promise.resolve(onTurn(rt, id)).catch((error) =>
          rt.receive({
            method: "runtime/closed",
            params: { error: error.message },
          }),
        );
      }, 0);
      return { turn: { id } };
    }
    return {};
  };
  return rt;
}

test("Codex also uses assigned model and suppresses intermediate check-in prose", async () => {
  const f = await fixture("codex", "qa-chief-subscription");
  let inspected = false;
  const rt = fakeCodex(async (current, turnId) => {
    await current.receive({
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread",
        itemId: "thought",
        delta: "I am reviewing the workspace.",
      },
    });
    assert.equal(bodyFor(f.job), "");
    inspected = true;
    await current.receive({
      id: 8,
      method: "item/tool/call",
      params: {
        threadId: "thread",
        tool: "finish_work",
        arguments: complete("No useful new opportunity.", true),
        callId: "chief-finish",
      },
    });
    await current.receive({
      method: "turn/completed",
      params: {
        threadId: "thread",
        turn: { id: turnId, status: "interrupted" },
      },
    });
  });
  await runtime.perform(f.job, {
    resolve: async (company, choice) => choice,
    codex: (job, choice) =>
      runtime.performCodex(job, choice, { getRuntime: async () => rt }),
  });
  assert.equal(inspected, true);
  assert.equal(rt.threadStart.model, f.model);
  assert.ok(
    !rt.threadStart.dynamicTools.some((t) => t.name.startsWith("computer_")),
  );
  assert.equal(bodyFor(f.job), "");
  assert.equal(
    s.one("SELECT status FROM jobs WHERE id=?", f.job.id).status,
    "done",
  );
});

test("ordinary chat still streams progress and uses its normal tools", async () => {
  const f = await fixture();
  s.run("UPDATE jobs SET status='done' WHERE id=?", f.job.id);
  const input = s.addMessage(
    f.company,
    f.conversation.id,
    "Write a short report",
    { user: f.user },
  );
  const id = tools.enqueue(
    f.company,
    f.user,
    f.conversation.id,
    f.duck.id,
    input,
  );
  s.run("UPDATE jobs SET status='running' WHERE id=?", id);
  f.job = s.one("SELECT * FROM jobs WHERE id=?", id);
  const requests = await apiRun(f, [
    prose("Here is the progress."),
    () => {
      assert.match(bodyFor(f.job), /Here is the progress/);
      return toolCall("finish_work", complete("The report is ready."));
    },
  ]);
  assert.ok(
    requests[0].tools.some((t) => (t.function?.name || t.name) === "task_save"),
  );
  assert.match(bodyFor(f.job), /The report is ready/);
});

test("a human request arriving during a check stays an ordinary queued job", async () => {
  const f = await fixture();
  let normal;
  await apiRun(f, [
    async () => {
      const input = s.addMessage(
        f.company,
        f.conversation.id,
        "Please write the report now.",
        { user: f.user },
      );
      const id = tools.enqueue(
        f.company,
        f.user,
        f.conversation.id,
        f.duck.id,
        input,
      );
      normal = s.one("SELECT * FROM jobs WHERE id=?", id);
      await assert.rejects(
        runtime.steerJob(normal),
        /check.in|queued|matching active/i,
      );
      assert.equal(
        s.one("SELECT status FROM jobs WHERE id=?", id).status,
        "queued",
      );
      assert.equal(
        s.one("SELECT control_revision FROM jobs WHERE id=?", f.job.id)
          .control_revision,
        0,
      );
      return toolCall("finish_work", complete("No new suggestion.", true));
    },
  ]);
  assert.equal(
    s.one("SELECT checkin FROM jobs WHERE id=?", normal.id).checkin,
    0,
  );
});

test("internal check-in prompts cannot be retried with ordinary action tools", async () => {
  const f = await fixture();
  assert.throws(
    () =>
      tools.enqueue(
        f.company,
        f.user,
        f.conversation.id,
        f.duck.id,
        f.job.input_message_id,
      ),
    /Internal check.ins/,
  );
});

test("failed checks and restart cancellation leave no notification or automatic recovery", async () => {
  const failed = await fixture();
  runtime.recordJobFailure(failed.job, new Error("Isolated provider outage"));
  assert.equal(bodyFor(failed.job), "");
  assert.equal(
    s.one(
      `SELECT count(*) n FROM messages m WHERE m.id IN (?,?) AND ${chat.notifiableMessageSql("m")}`,
      failed.job.input_message_id,
      failed.job.output_message_id,
    ).n,
    0,
  );
  const interrupted = await fixture();
  runtime.recoverAfterRestart();
  assert.equal(
    s.one("SELECT status FROM jobs WHERE id=?", interrupted.job.id).status,
    "cancelled",
  );
  assert.equal(bodyFor(interrupted.job), "");
  assert.equal(
    s.one(
      "SELECT 1 FROM unfinished_work WHERE root_job_id=?",
      interrupted.job.id,
    ),
    undefined,
  );
});
