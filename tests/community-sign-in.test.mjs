// Who can get in by email on a server somebody runs for their own team: the
// people with a place there and the people invited to one - never a stranger
// who found the address, and never before the owner has finished setup. The
// hosted edition, where anybody may start a company, is unchanged.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const previous = { ...process.env };
const dataDir = fs.mkdtempSync(
  path.join(os.tmpdir(), "tameduck-community-sign-in-"),
);
process.env.DATA_DIR = dataDir;
process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex");
process.env.APP_URL = "http://localhost:3000";
process.env.SMTP_URL = "smtp://mail.example.test:25";
const s = await import("../server/store.mjs");
const mail = await import("../server/mail.mjs");
const { registerSignIn } = await import("../server/sign-in.mjs");

const inbox = [];
mail.sendWith(async (message) => inbox.push(message));
after(() => {
  s.db.close();
  for (const key of ["DATA_DIR", "ENCRYPTION_KEY", "APP_URL", "SMTP_URL"])
    if (previous[key] === undefined) delete process.env[key];
    else process.env[key] = previous[key];
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const count = (table) => s.one(`SELECT count(*) n FROM ${table}`).n;
const membershipOf = (user) =>
  s.one(
    "SELECT company_id company FROM memberships WHERE user_id=? LIMIT 1",
    user,
  );
// The server's own rule, kept small: a place, else the invitation waiting,
// else - only when the way in starts one - a new company.
function placeFor(user, newCompany) {
  const member = membershipOf(user);
  if (member) return member;
  const email = s.one("SELECT email FROM users WHERE id=?", user).email;
  const invite = s.one(
    "SELECT * FROM invites WHERE email=? AND accepted=0 AND expires>?",
    email,
    Date.now(),
  );
  if (invite) {
    s.run("INSERT INTO memberships VALUES(?,?,?,'{}')", invite.company_id, user, invite.role);
    s.run("UPDATE invites SET accepted=1 WHERE token_hash=?", invite.token_hash);
    return { company: invite.company_id, created: false };
  }
  if (newCompany)
    return { company: s.createCompany(user, newCompany), created: true };
  return null;
}
function server({ community }) {
  const routes = new Map();
  registerSignIn(
    { post: (route, fn) => routes.set(route, fn) },
    {
      community,
      membershipOf,
      placeFor,
      session: () => ({}),
    },
  );
  return async (route, body) => {
    let answer;
    try {
      await routes.get(route)({ body }, { json: (v) => (answer = v) });
      return { status: 200, body: answer };
    } catch (e) {
      return { status: e.status || 500, error: e.message };
    }
  };
}
const community = server({ community: true });
const hosted = server({ community: false });
// The link as it arrives in the inbox.
const linkIn = (message) => /\/enter#([A-Za-z0-9_-]+)/.exec(message.text)?.[1];
// A link somebody already holds, as if it had been sent before.
function heldLink(email) {
  const value = crypto.randomBytes(32).toString("base64url");
  s.run(
    "INSERT INTO sign_in_links VALUES(?,?,?,?,0)",
    s.hash(value),
    email,
    Date.now(),
    Date.now() + 15 * 60000,
  );
  return value;
}
function person(email) {
  const id = s.id();
  s.run("INSERT INTO users VALUES(?,?,?,?,?,?)", id, email, "Someone", "", null, s.now());
  return id;
}

test("before setup a community server sends nobody a link, and no link opens it", async () => {
  const asked = await community("/api/auth/link", { email: "early@example.test" });
  assert.equal(asked.status, 200);
  assert.equal(asked.body.ok, true, "the same answer as for anybody");
  assert.equal(inbox.length, 0);
  assert.equal(count("sign_in_links"), 0);
  const opened = await community("/api/auth/enter", { token: heldLink("early@example.test") });
  assert.equal(opened.status, 403);
  assert.match(opened.error, /invited/);
  assert.equal(count("users"), 0, "the setup link is still the only way in");
  assert.equal(count("companies"), 0);
});

test("a community server lets in its members and the people they invite, and nobody else", async () => {
  const owner = person("owner@example.test");
  const company = s.createCompany(owner, "Northgate");
  const companies = count("companies");

  // A stranger: the same answer, but no mail and no link.
  inbox.length = 0;
  const stranger = await community("/api/auth/link", { email: "stranger@example.test" });
  assert.deepEqual(stranger.body, (await community("/api/auth/link", { email: "owner@example.test" })).body);
  assert.equal(inbox.filter((m) => m.to === "stranger@example.test").length, 0);
  assert.equal(inbox.filter((m) => m.to === "owner@example.test").length, 1, "a member gets one");
  const denied = await community("/api/auth/enter", { token: heldLink("stranger@example.test") });
  assert.equal(denied.status, 403);
  assert.equal(s.one("SELECT 1 FROM users WHERE email=?", "stranger@example.test"), undefined);

  // Invited: the link comes, and opening it joins the company that invited them.
  s.run(
    "INSERT INTO invites(token_hash,id,company_id,email,role,created_by,expires) VALUES(?,?,?,?,?,?,?)",
    s.hash(crypto.randomBytes(16).toString("hex")),
    s.id(),
    company,
    "invited@example.test",
    "member",
    owner,
    Date.now() + 86400000,
  );
  inbox.length = 0;
  await community("/api/auth/link", { email: "invited@example.test" });
  assert.equal(inbox.length, 1);
  const joined = await community("/api/auth/enter", { token: linkIn(inbox[0]) });
  assert.equal(joined.status, 200, joined.error);
  assert.equal(joined.body.company, company);
  assert.equal(count("companies"), companies, "and starts no company of their own");

  // Taken out of their only company, with no invitation: no way back in, and
  // no company of their own either.
  const former = person("former@example.test");
  inbox.length = 0;
  await community("/api/auth/link", { email: "former@example.test" });
  assert.equal(inbox.length, 0);
  assert.equal((await community("/api/auth/enter", { token: heldLink("former@example.test") })).status, 403);
  assert.equal(membershipOf(former), undefined);
  assert.equal(count("companies"), companies);
});

test("the hosted edition still lets anybody start a company", async () => {
  inbox.length = 0;
  await hosted("/api/auth/link", { email: "newcomer@example.test" });
  assert.equal(inbox.length, 1);
  const before = count("companies");
  const started = await hosted("/api/auth/enter", { token: linkIn(inbox[0]) });
  assert.equal(started.status, 200, started.error);
  assert.equal(started.body.created, true);
  assert.equal(count("companies"), before + 1);
});
