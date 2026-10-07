import { after, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const temporary = fs.mkdtempSync(
  path.join(os.tmpdir(), "folder-computer-guards-"),
);
process.env.DATA_DIR = temporary;
process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex");
process.env.ASCII_API_KEY = "synthetic-test-key";
const s = await import("../server/store.mjs");
const { outputFolderOperation } = await import("../server/computers.mjs");
const { enqueue } = await import("../server/duck-tools.mjs");
const user = s.id();
s.run(
  "INSERT INTO users VALUES(?,?,?,?,?,?)",
  user,
  "folder-guard@example.test",
  "Owner",
  "unused",
  null,
  s.now(),
);
const company = s.createCompany(user, "Folder guard");
const duck = s.one(
  "SELECT * FROM ducks WHERE company_id=? AND chief=1",
  company,
);
const conversation = s.directConversation(company, user, duck);
const computer = s.id();
s.run(
  "INSERT INTO computers(id,company_id,duck_id,box_id,state,bootstrapped,created,updated) VALUES(?,?,?,?,?,?,?,?)",
  computer,
  company,
  duck.id,
  "current-box",
  "ready",
  1,
  s.now(),
  s.now(),
);
s.run("INSERT INTO duck_computer_access VALUES(?,?,1)", duck.id, company);
const message = s.addMessage(company, conversation.id, "Organize folders", {
  user,
});
const jobId = enqueue(company, user, conversation.id, duck.id, message);
s.run("UPDATE jobs SET status='running' WHERE id=?", jobId);
const job = s.tenant("jobs", jobId, company);
let providerCalls = 0;
const request = async () => {
  providerCalls++;
  throw new Error("Provider must not be called");
};
const act = (context = job, args = {}) =>
  outputFolderOperation(
    context,
    "create",
    { path: "Reports", ...args },
    { request },
  );
after(() => {
  s.db.close();
  fs.rmSync(temporary, { recursive: true, force: true });
});

test("old computer identities and stopped jobs cannot send a folder command", async () => {
  await assert.rejects(
    act(job, { computer_id: s.id(), source_box_id: "current-box" }),
    (e) => e.status === 409,
  );
  await assert.rejects(
    act(job, { computer_id: computer, source_box_id: "previous-box" }),
    (e) => e.status === 409,
  );
  s.run("UPDATE jobs SET status='stopped' WHERE id=?", jobId);
  try {
    await assert.rejects(act(), /run has stopped/);
  } finally {
    s.run("UPDATE jobs SET status='running' WHERE id=?", jobId);
  }
  assert.equal(providerCalls, 0);
});

test("human folder controls wait for an active duck and respect human computer takeover", async () => {
  const human = { company_id: company, user_id: user, duck_id: duck.id };
  await assert.rejects(act(human), /duck is working/);
  s.run(
    "INSERT INTO computer_control(computer_id,company_id,user_id,session_hash,expires,started,generation,state) VALUES(?,?,?,?,?,?,?,?)",
    computer,
    company,
    user,
    s.hash("synthetic-session"),
    Date.now() + 90000,
    Date.now(),
    s.id(),
    "live",
  );
  try {
    await assert.rejects(act(), /human is using/);
    await assert.rejects(act(human), /human is using/);
  } finally {
    s.run("DELETE FROM computer_control WHERE computer_id=?", computer);
  }
  assert.equal(providerCalls, 0);
});

test("folder commands recheck computer access and company membership", async () => {
  s.run(
    "UPDATE memberships SET role='admin',permissions=? WHERE company_id=? AND user_id=?",
    JSON.stringify({ computers: false }),
    company,
    user,
  );
  try {
    await assert.rejects(act(), (e) => e.status === 403);
  } finally {
    s.run(
      "UPDATE memberships SET role='owner',permissions='{}' WHERE company_id=? AND user_id=?",
      company,
      user,
    );
  }
  s.run(
    "DELETE FROM memberships WHERE company_id=? AND user_id=?",
    company,
    user,
  );
  await assert.rejects(act(), /membership has ended/);
  assert.equal(providerCalls, 0);
});
