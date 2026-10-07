import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";

process.env.DATA_DIR = fs.mkdtempSync("/tmp/tameduck-computer-runs-");
process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex");

const s = await import("../server/store.mjs");
const { computerUseOfRuns, COMPUTER_USE_SQL } = await import("../server/computer-runs.mjs");

// The query as it was before it was rewritten: every action joined to every
// run in its conversation. The new one must answer exactly as it did.
const BEFORE =
  "SELECT DISTINCT COALESCE(consultation.child_job_id,a.job_id) job_id, a.tool='terminal' typed FROM computer_actions a " +
  "JOIN jobs j ON j.id=a.job_id " +
  "LEFT JOIN jobs current_helper ON current_helper.conversation_id=j.conversation_id " +
  "LEFT JOIN duck_consultations consultation ON consultation.child_job_id=current_helper.id " +
  "LEFT JOIN jobs parent ON parent.id=consultation.parent_job_id " +
  "WHERE j.company_id=? AND (EXISTS(SELECT 1 FROM conversation_members cm WHERE cm.conversation_id=j.conversation_id AND cm.user_id=?) OR EXISTS(SELECT 1 FROM conversation_members cm WHERE cm.conversation_id=parent.conversation_id AND cm.user_id=?))";

const person = (name) => {
  const uid = s.id();
  s.run("INSERT INTO users VALUES(?,?,?,?,?,?)", uid, `${uid}@runs.test`, name, "", null, s.now());
  return uid;
};
const robin = person("Robin");
const sam = person("Sam");
const company = s.createCompany(robin, "Northgate");
s.run("INSERT INTO memberships(company_id,user_id,role) VALUES(?,?,?)", company, sam, "member");
const chief = s.one("SELECT * FROM ducks WHERE company_id=? AND chief=1", company);
const helper = s.createDuck(company, { name: "Research Duck", role: "Research", soul: "", identity: "", notes: "" });
const computer = s.id();
s.run("INSERT INTO computers(id,company_id,duck_id,state,created,updated) VALUES(?,?,?,'ready',?,?)", computer, company, chief.id, s.now(), s.now());

let tick = 0;
const job = (conversation, duck, user = robin, extra = {}) => {
  const id = s.id();
  const at = new Date(Date.UTC(2026, 9, 7, 8, 0, tick++)).toISOString();
  s.run(
    "INSERT INTO jobs(id,company_id,user_id,conversation_id,duck_id,status,created,updated,parent_job_id,root_job_id) VALUES(?,?,?,?,?,'done',?,?,?,?)",
    id, extra.company || company, user, conversation, duck.id, at, at, extra.parent || null, extra.root || null,
  );
  return id;
};
const act = (jobId, tool, times = 1) => {
  for (let i = 0; i < times; i++)
    s.run(
      "INSERT INTO computer_actions(id,computer_id,job_id,user_id,tool,checkpoint,state,created) VALUES(?,?,?,?,?,'{}','done',?)",
      s.id(), computer, jobId, robin, tool, s.now(),
    );
};
const answer = (rows) => rows.map((r) => `${r.job_id}:${r.typed ? 1 : 0}`).sort();
const fromFunction = (user) => {
  const r = computerUseOfRuns(company, user);
  return [...r.terminal_jobs.map((j) => `${j}:1`), ...r.desktop_jobs.map((j) => `${j}:0`)].sort();
};

// Robin's chat with Chief Duck, Sam's with Research Duck, Robin's with Research Duck.
const robinsChief = s.directConversation(company, robin, chief).id;
const samsHelper = s.directConversation(company, sam, helper).id;
const robinsHelper = s.directConversation(company, robin, helper).id;

const typedOnly = job(robinsChief, chief);
act(typedOnly, "terminal", 30);
const clickedOnly = job(robinsChief, chief);
act(clickedOnly, "click", 20);
act(clickedOnly, "screenshot", 5);
const both = job(robinsHelper, helper);
act(both, "terminal", 10);
act(both, "type", 10);
// Chief Duck asks Research Duck, whose run is in Sam's chat with it: Robin
// sees it through the run that asked.
const asking = job(robinsChief, chief);
const consulted = job(samsHelper, helper, sam, { parent: asking, root: asking });
s.run(
  "INSERT INTO duck_consultations(id,company_id,root_job_id,parent_job_id,child_job_id,from_duck_id,to_duck_id,call_id,question,deadline,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
  s.id(), company, asking, asking, consulted, chief.id, helper.id, "call-1", "Can you check this?", Date.now() + 60000, s.now(), s.now(),
);
act(consulted, "terminal", 15);
// Sam's own run in that chat, which Robin is not in.
const samsOwn = job(samsHelper, helper, sam);
act(samsOwn, "click", 12);
// Another company's run is nobody's business here.
const elsewhere = s.createCompany(sam, "Elsewhere");
const elsewhereChief = s.one("SELECT * FROM ducks WHERE company_id=? AND chief=1", elsewhere);
const theirs = job(s.directConversation(elsewhere, sam, elsewhereChief).id, elsewhereChief, sam, { company: elsewhere });
act(theirs, "terminal", 8);

test("each run is said to have typed, driven the desktop, or both - the same answer as before the rewrite", () => {
  for (const user of [robin, sam]) assert.deepEqual(fromFunction(user), answer(s.all(BEFORE, company, user, user)));
  const robins = computerUseOfRuns(company, robin);
  assert.deepEqual(new Set(robins.terminal_jobs), new Set([typedOnly, both, consulted]));
  // The consulted run also takes the desktop work done in its duck's
  // conversation, as it always has: the rewrite changes how fast, not what.
  assert.deepEqual(new Set(robins.desktop_jobs), new Set([clickedOnly, both, consulted]));
  // Sam's own run, and the other company's, are not Robin's to see.
  for (const hidden of [samsOwn, theirs])
    assert.ok(!robins.terminal_jobs.includes(hidden) && !robins.desktop_jobs.includes(hidden));
  assert.ok(computerUseOfRuns(company, sam).desktop_jobs.includes(samsOwn));
});

test("it is answered from indexes, not by reading every action and every run there is", () => {
  const plan = s.all("EXPLAIN QUERY PLAN " + COMPUTER_USE_SQL, company, company, robin, robin).map((r) => r.detail).join(" ; ");
  assert.match(plan, /computer_actions_job/, plan);
  assert.match(plan, /jobs_conversation/, plan);
  assert.doesNotMatch(plan, /SCAN a\b/, plan);
  // Many actions on a few runs come down to a row per run and kind.
  act(typedOnly, "terminal", 2000);
  assert.deepEqual(fromFunction(robin), answer(s.all(BEFORE, company, robin, robin)));
});
