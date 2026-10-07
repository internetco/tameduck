import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "tameduck-push-"));
process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex");
const store = await import("../server/store.mjs");
const push = await import("../server/web-push.mjs");
after(() => {
  store.db.close();
  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
});

function person(name) {
  const id = store.id();
  store.run("INSERT INTO users VALUES(?,?,?,?,?,?)", id, `${id}@example.test`, name, "unused", null, store.now());
  return id;
}
const alice = person("Alice"), bob = person("Bob");
const company = store.createCompany(alice, "One");
const other = store.createCompany(bob, "Two");
const session = "session-" + store.id();
store.run("INSERT INTO sessions VALUES(?,?,?,?)", session, alice, company, Date.now() + 60_000);
const endpoint = "https://fcm.googleapis.com/fcm/send/" + "a".repeat(64);
const curve = crypto.createECDH("prime256v1"); curve.generateKeys();
const subscription = { endpoint, keys: { p256dh: curve.getPublicKey().toString("base64url"),
  auth: crypto.randomBytes(16).toString("base64url") } };

function fakeApp() {
  const routes = new Map();
  return { routes, get: (url, fn) => routes.set(`GET ${url}`, fn),
    post: (url, fn) => routes.set(`POST ${url}`, fn) };
}
function request(app, method, url, body = {}, user = alice, companyId = company, sessionHash = session) {
  const req = { body, user: { id: user }, company: { id: companyId }, session: { token_hash: sessionHash },
    member: store.memberFor(companyId, user) };
  let result;
  app.routes.get(`${method} ${url}`)(req, { json: (value) => { result = value; } });
  return result;
}

test("accepts browser providers and refuses internal or disguised endpoints", () => {
  assert.equal(push.validSubscription(subscription), true);
  assert.equal(push.validPushEndpoint("https://db5p.notify.windows.com/w/?token=Abc%2fDef%3d"), true);
  for (const target of [
    "http://fcm.googleapis.com/fcm/send/a",
    "https://fcm.googleapis.com.evil.test/fcm/send/a",
    "https://127.0.0.1/fcm/send/a",
    "https://user@fcm.googleapis.com/fcm/send/a",
    "https://fcm.googleapis.com:8443/fcm/send/a",
    "https://fcm.googleapis.com/fcm/send/a?next=localhost",
  ]) assert.equal(push.validPushEndpoint(target), false, target);
});

test("opt-in is scoped to the exact person, session and company", () => {
  const app = fakeApp();
  push.registerWebPush(app, { appUrl: "https://example.test" });
  const capability = request(app, "GET", "/api/notifications/status");
  assert.ok(capability.publicKey);
  assert.equal(request(app, "POST", "/api/notifications/status", { endpoint }).subscribed, false);
  request(app, "POST", "/api/notifications/subscribe", { subscription });
  assert.throws(() => request(app, "POST", "/api/notifications/subscribe",
    { subscription, company_id: other }), /workspace changed/);
  assert.equal(push.validSubscription({ ...subscription, keys: { ...subscription.keys, p256dh: "a".repeat(87) } }), false);
  assert.equal(request(app, "POST", "/api/notifications/status", { endpoint }).subscribed, true);
  assert.equal(request(app, "POST", "/api/notifications/status", { endpoint }, bob, other).subscribed, false);
  assert.equal(request(app, "POST", "/api/notifications/status", { endpoint }, alice, company, "another-session").subscribed, false);
  assert.throws(() => request(app, "POST", "/api/notifications/subscribe", { subscription }, bob, other), /still enabled/);
  request(app, "POST", "/api/notifications/unsubscribe", { endpoint }, bob, other);
  assert.equal(request(app, "POST", "/api/notifications/status", { endpoint }).subscribed, true);
  assert.equal(fs.statSync(path.join(process.env.DATA_DIR, "web-push-vapid.json")).mode & 0o077, 0);
});

function duckReply(toUser, companyId, created, needs = null, visible = true, state = "sent") {
  const conversation = store.id(), duck = store.one("SELECT id FROM ducks WHERE company_id=? LIMIT 1", companyId).id;
  store.run("INSERT INTO conversations(id,company_id,name,kind,creator_id,created) VALUES(?,?,?,?,?,?)",
    conversation, companyId, "Chat", "direct", toUser, created);
  if (visible) store.run("INSERT INTO conversation_members VALUES(?,?)", conversation, toUser);
  const message = store.id();
  store.run("INSERT INTO messages(id,company_id,conversation_id,duck_id,body,state,created,needs_you) VALUES(?,?,?,?,?,?,?,?)",
    message, companyId, conversation, duck, "private contents", state, created, needs);
  store.run("INSERT INTO inbox(message_id,user_id,state) VALUES(?,?,'pending')", message, toUser);
  return message;
}

test("first opt-in baselines completed replies while queued work alerts on completion", async () => {
  const session2 = "session-" + store.id();
  const endpoint2 = "https://fcm.googleapis.com/fcm/send/" + "c".repeat(64);
  const sub2 = { ...subscription, endpoint: endpoint2 };
  store.run("INSERT INTO sessions VALUES(?,?,?,?)", session2, alice, company, Date.now() + 60_000);
  const before = new Date(Date.now() - 1000).toISOString();
  const old = duckReply(alice, company, before);
  const queued = duckReply(alice, company, before, null, true, "queued");
  const app = fakeApp(); push.registerWebPush(app, { appUrl: "https://example.test" });
  request(app, "POST", "/api/notifications/subscribe", { subscription: sub2 }, alice, company, session2);
  const sent = [];
  const send = async (target, payload) => { if (target.endpoint === endpoint2) sent.push(JSON.parse(payload)); };
  await push.pollWebPush({ send, appUrl: "https://example.test" });
  assert.equal(sent.length, 0, "old completed and queued placeholders do not alert");
  store.run("UPDATE messages SET state='sent' WHERE id=?", queued);
  await push.pollWebPush({ send, appUrl: "https://example.test" });
  assert.equal(sent.length, 1, "pre-enable queued work alerts when completed");
  assert.equal(sent[0].body, "A Duck replied.");
  assert.equal(store.one("SELECT count(*) n FROM web_push_deliveries WHERE endpoint=? AND event_id=?", endpoint2, old).n, 1);
  const created = store.one("SELECT created FROM web_push_subscriptions WHERE endpoint=?", endpoint2).created;
  const latest = duckReply(alice, company, new Date(Date.now() + 1000).toISOString());
  request(app, "POST", "/api/notifications/subscribe", { subscription: sub2 }, alice, company, session2);
  assert.equal(store.one("SELECT created FROM web_push_subscriptions WHERE endpoint=?", endpoint2).created, created);
  await push.pollWebPush({ send, appUrl: "https://example.test" });
  assert.equal(sent.length, 2, "repeated Enable does not baseline a newly arrived reply");
  assert.equal(store.one("SELECT count(*) n FROM web_push_deliveries WHERE endpoint=? AND event_id=?", endpoint2, latest).n, 1);
  request(app, "POST", "/api/notifications/unsubscribe", { endpoint: endpoint2 }, alice, company, session2);
  store.run("DELETE FROM sessions WHERE token_hash=?", session2);
  // Keep the original browser's next test independent of this browser's events.
  request(app, "POST", "/api/notifications/unsubscribe", { endpoint });
  request(app, "POST", "/api/notifications/subscribe", { subscription });
});

test("old queued jobs can finish now, unsubscribe cuts off a cached poll, and gone endpoints are removed", async () => {
  const session3 = "session-" + store.id();
  const endpoint3 = "https://fcm.googleapis.com/fcm/send/" + "d".repeat(64);
  const sub3 = { ...subscription, endpoint: endpoint3 };
  store.run("INSERT INTO sessions VALUES(?,?,?,?)", session3, alice, company, Date.now() + 60_000);
  const ancient = new Date(Date.now() - 3 * 86400000).toISOString();
  const message = duckReply(alice, company, ancient, null, true, "queued");
  const record = store.one("SELECT conversation_id,duck_id FROM messages WHERE id=?", message);
  const job = store.id();
  store.run(`INSERT INTO jobs(id,company_id,user_id,conversation_id,duck_id,output_message_id,status,created,updated)
    VALUES(?,?,?,?,?,?,?,?,?)`, job, company, alice, record.conversation_id,
    record.duck_id, message, "queued", ancient, ancient);
  const app = fakeApp(); push.registerWebPush(app, { appUrl: "https://example.test" });
  request(app, "POST", "/api/notifications/subscribe", { subscription: sub3 }, alice, company, session3);
  store.run("UPDATE messages SET state='sent' WHERE id=?", message);
  store.run("UPDATE jobs SET status='done',updated=? WHERE id=?", store.now(), job);
  const sent = [];
  const send = async (target, payload) => { if (target.endpoint === endpoint3) sent.push(JSON.parse(payload)); };
  await push.pollWebPush({ send, appUrl: "https://example.test" });
  assert.equal(sent.length, 1, "completion time, not old queue time, drives the alert");

  duckReply(alice, company, new Date(Date.now() + 1000).toISOString());
  duckReply(alice, company, new Date(Date.now() + 2000).toISOString());
  const sendAndDisable = async (target) => {
    if (target.endpoint !== endpoint3) return;
    sent.push("sent");
    request(app, "POST", "/api/notifications/unsubscribe", { endpoint: endpoint3 }, alice, company, session3);
  };
  await push.pollWebPush({ send: sendAndDisable, appUrl: "https://example.test" });
  assert.equal(sent.length, 2, "second cached event is suppressed after unsubscribe");

  request(app, "POST", "/api/notifications/subscribe", { subscription: sub3 }, alice, company, session3);
  duckReply(alice, company, new Date(Date.now() + 3000).toISOString());
  await push.pollWebPush({ send: async (target) => {
    if (target.endpoint === endpoint3) throw Object.assign(new Error("gone"), { statusCode: 410 });
  }, appUrl: "https://example.test" });
  assert.equal(store.one("SELECT count(*) n FROM web_push_subscriptions WHERE endpoint=?", endpoint3).n, 0);
  request(app, "POST", "/api/notifications/subscribe", { subscription: sub3 }, alice, company, session3);
  duckReply(alice, company, new Date(Date.now() + 4000).toISOString());
  store.run("DELETE FROM sessions WHERE token_hash=?", session3);
  let afterLogout = 0;
  await push.pollWebPush({ send: async (target) => { if (target.endpoint === endpoint3) afterLogout++; },
    appUrl: "https://example.test" });
  assert.equal(afterLogout, 0);
  request(app, "POST", "/api/notifications/unsubscribe", { endpoint });
  request(app, "POST", "/api/notifications/subscribe", { subscription });
});

test("approval alerts follow approver rights and private conversation access", () => {
  const charlie = person("Charlie");
  store.run("INSERT INTO memberships VALUES(?,?,?,?)", company, charlie, "member", "{}");
  const when = new Date(Date.now() + 1000).toISOString();
  const conversation = store.id();
  store.run("INSERT INTO conversations(id,company_id,name,kind,creator_id,created) VALUES(?,?,?,?,?,?)",
    conversation, company, "Private", "direct", alice, when);
  store.run("INSERT INTO conversation_members VALUES(?,?)", conversation, alice);
  const duck = store.one("SELECT id FROM ducks WHERE company_id=? LIMIT 1", company).id;
  const job = store.id();
  store.run(`INSERT INTO jobs(id,company_id,user_id,conversation_id,duck_id,status,created,updated)
    VALUES(?,?,?,?,?,?,?,?)`, job, company, alice, conversation, duck, "waiting_human", when, when);
  const connection = store.id(), approval = store.id();
  store.run("INSERT INTO connections(id,company_id,name,url,created) VALUES(?,?,?,?,?)",
    connection, company, "Example", "https://example.test", when);
  store.run("INSERT INTO approvals(id,company_id,job_id,connection_id,tool,args,status,created,updated) VALUES(?,?,?,?,?,?,?,?,?)",
    approval, company, job, connection, "do", "{}", "pending", when, when);
  const candidate = (user) => push.pendingWebPushEvents({ company, user,
    member: store.memberFor(company, user), endpoint: "test-endpoint", now: Date.now() });
  assert.equal(candidate(charlie).some((event) => event.id === approval), false);
  store.run("UPDATE memberships SET permissions=? WHERE company_id=? AND user_id=?",
    JSON.stringify({ approvals: true }), company, charlie);
  assert.equal(candidate(charlie).some((event) => event.id === approval), true);
  store.run("UPDATE memberships SET permissions='{}' WHERE company_id=? AND user_id=?", company, charlie);
  store.run("UPDATE jobs SET user_id=? WHERE id=?", charlie, job);
  assert.equal(candidate(charlie).some((event) => event.id === approval), false,
    "own job in a private conversation is still hidden when removed from it");
  store.run("INSERT INTO conversation_members VALUES(?,?)", conversation, charlie);
  assert.equal(candidate(charlie).some((event) => event.id === approval), true);
  store.run("UPDATE approvals SET status='decided' WHERE id=?", approval);
});

test("pushes new visible replies once, omits content and stops after access loss", async () => {
  const baseline = new Date(Date.now() + 500).toISOString();
  store.run("UPDATE web_push_subscriptions SET created=? WHERE endpoint=?", baseline, endpoint);
  const later = new Date(Date.now() + 1000).toISOString();
  duckReply(alice, company, later, null, false);
  duckReply(bob, other, later);
  const visible = duckReply(alice, company, later, "private question");
  const sent = [];
  const send = async (_sub, payload) => sent.push(JSON.parse(payload));
  await push.pollWebPush({ send, appUrl: "https://example.test" });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body, "A Duck needs your attention.");
  assert.equal(JSON.stringify(sent).includes("private"), false);
  store.run("INSERT INTO web_push_deliveries VALUES(?,?,?,?,?)",
    endpoint, company, "reply", "expired-delivery", Date.now() - 3 * 86400000);
  await push.pollWebPush({ send, appUrl: "https://example.test" });
  assert.equal(sent.length, 1, "delivery is deduplicated");
  assert.equal(store.one("SELECT count(*) n FROM web_push_deliveries WHERE event_id='expired-delivery'").n, 0,
    "old dedupe records are pruned");
  store.run("DELETE FROM memberships WHERE company_id=? AND user_id=?", company, alice);
  assert.equal(store.one("SELECT count(*) n FROM web_push_subscriptions WHERE endpoint=?", endpoint).n, 0,
    "revocation deletes binding immediately");
  duckReply(alice, company, new Date(Date.now() + 2000).toISOString());
  await push.pollWebPush({ send, appUrl: "https://example.test" });
  assert.equal(sent.length, 1, "revoked member gets no push");
  assert.equal(store.one("SELECT count(*) n FROM web_push_subscriptions WHERE endpoint=?", endpoint).n, 0,
    "membership revocation removes the browser binding");
  store.run("INSERT INTO memberships VALUES(?,?,?,?)", company, alice, "owner", "{}");
  await push.pollWebPush({ send, appUrl: "https://example.test" });
  assert.equal(sent.length, 1, "rejoining does not resurrect an old opt-in");
  store.run("DELETE FROM sessions WHERE token_hash=?", session);
  duckReply(alice, company, new Date(Date.now() + 3000).toISOString());
  await push.pollWebPush({ send, appUrl: "https://example.test" });
  assert.equal(sent.length, 1, "logout gets no push");
  assert.equal(store.one("SELECT count(*) n FROM web_push_subscriptions WHERE endpoint=?", endpoint).n, 0);
  assert.ok(visible);
});
