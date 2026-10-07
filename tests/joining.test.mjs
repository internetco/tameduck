// Joining a company from an invitation, against a real server. The link is
// kept, encrypted, so it can be copied again; the waiting list keeps the ones
// that ran out; Send again retires the old link; the page is told who asked,
// as what, and who is there. An invitation alone never signs anybody in:
// joining requires mailbox verification, and any enabled second factor.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import Database from "better-sqlite3";
import { freePort } from "./free-port.mjs";

const root = path.resolve(import.meta.dirname, "..");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tameduck-joining-"));
const key = crypto.randomBytes(32).toString("hex");
// This process loads server/sign-in.mjs for localPath and signInLink, and
// that opens a database of its own, apart from the server's. Loaded as a
// whole, so a missing export fails its own test rather than every test.
const unitDirectory = fs.mkdtempSync(
  path.join(os.tmpdir(), "tameduck-joining-unit-"),
);
process.env.DATA_DIR = unitDirectory;
process.env.ENCRYPTION_KEY = key;
const signIn = await import("../server/sign-in.mjs");
const twoStep = await import("../server/two-step.mjs");
const unitStore = await import("../server/store.mjs");
// Before any test is declared: node:test starts running the ones it has at
// the first await after them, and would never see the rest.
const port = await freePort();

const origin = "http://127.0.0.1:" + port;
const setup = crypto.randomBytes(24).toString("hex");
const password = "A long test password 2026!";
let child, db;
const logs = [];
// Every call to /api/auth counts against one limit per address. Each part
// says it comes from an address of its own, which the server believes
// because it sits behind nginx.
let from = "10.8.0.1";
async function call(route, { method = "GET", body, cookie } = {}) {
  const r = await fetch(origin + "/api" + route, {
    method,
    headers: {
      "content-type": "application/json",
      "x-tameduck": "1",
      "x-forwarded-for": from,
      origin,
      ...(cookie ? { cookie } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const set = r.headers.getSetCookie();
  const named = (name) =>
    set.find((c) => c.startsWith(name + "="))?.split(";")[0] || null;
  return {
    status: r.status,
    data: await r.json().catch(() => null),
    session: named("td_session"),
    pending: named("td_pending"),
  };
}
const ok = (r) => {
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data;
};

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const now = () => new Date().toISOString();
// A legitimate mailbox link fixture, as if the local test mail transport had
// delivered it. Invitation tokens are never used in place of this proof.
function mailboxLink(email, expires = Date.now() + 15 * 60000) {
  const value = crypto.randomBytes(32).toString("base64url");
  db.prepare("INSERT INTO sign_in_links VALUES(?,?,?,?,0)").run(
    sha(value),
    email,
    Date.now(),
    expires,
  );
  return value;
}
const enter = (token) =>
  call("/auth/enter", { method: "POST", body: { token } });
const accountCounts = () =>
  Object.fromEntries(
    ["users", "memberships", "sessions", "pending_sign_ins"].map((table) => [
      table,
      db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n,
    ]),
  );
// The server's own way of keeping a secret, written out here so the stored
// link is checked against something other than the server itself.
function decrypt(value) {
  const [iv, tag, body] = value.split(":");
  const d = crypto.createDecipheriv(
    "aes-256-gcm",
    Buffer.from(key, "hex"),
    Buffer.from(iv, "hex"),
  );
  d.setAuthTag(Buffer.from(tag, "hex"));
  return Buffer.concat([
    d.update(Buffer.from(body, "hex")),
    d.final(),
  ]).toString("utf8");
}
function encrypt(value) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", Buffer.from(key, "hex"), iv);
  const body = Buffer.concat([c.update(value, "utf8"), c.final()]);
  return [iv, c.getAuthTag(), body].map((b) => b.toString("hex")).join(":");
}
// Somebody with an account, a place in a company and a session, written
// straight into the tables, as two-step.test does.
function person(name, email, role, company) {
  const id = crypto.randomUUID();
  db.prepare("INSERT INTO users VALUES(?,?,?,?,?,?)").run(
    id,
    email,
    name,
    "",
    null,
    now(),
  );
  db.prepare("INSERT INTO memberships VALUES(?,?,?,?)").run(
    company,
    id,
    role,
    "{}",
  );
  const value = crypto.randomBytes(32).toString("base64url");
  db.prepare("INSERT INTO sessions VALUES(?,?,?,?)").run(
    sha(value),
    id,
    company,
    Date.now() + 86400000,
  );
  return { id, cookie: "td_session=" + value };
}
function companyCalled(name) {
  const id = crypto.randomUUID();
  db.prepare("INSERT INTO companies(id,name,created) VALUES(?,?,?)").run(
    id,
    name,
    now(),
  );
  return id;
}
// An invitation made the old way, before links were kept: no token_enc.
function oldInvitation(company, email, by) {
  const row = {
    token_hash: sha(crypto.randomBytes(32).toString("base64url")),
    id: crypto.randomUUID(),
    company_id: company,
    email,
    created_by: by,
    created: Date.now(),
    expires: Date.now() + 7 * 86400000,
  };
  db.prepare(
    "INSERT INTO invites(token_hash,id,company_id,email,role,permissions,created_by,created,expires,accepted) VALUES(@token_hash,@id,@company_id,@email,'member','{}',@created_by,@created,@expires,0)",
  ).run(row);
  return row;
}
const rowFor = (token) =>
  db.prepare("SELECT * FROM invites WHERE token_hash=?").get(sha(token));
const newest = (email) =>
  db
    .prepare(
      "SELECT * FROM invites WHERE email=? AND accepted=0 ORDER BY rowid DESC LIMIT 1",
    )
    .get(email);
const audited = (action, details) =>
  !!db
    .prepare("SELECT 1 FROM audit WHERE action=? AND details=?")
    .get(action, details);

let robin, robinId, northgate, sam, ada, mo, priya, harbour, forPriya;
async function invite(email, role = "member", cookie = robin) {
  const { url } = ok(
    await call("/invites", { method: "POST", body: { email, role }, cookie }),
  );
  const token = url.split("#")[1];
  return { url, token, row: rowFor(token) };
}
const lookUp = (token, cookie) =>
  call("/auth/invitation", { method: "POST", body: { token }, cookie });

before(async () => {
  child = spawn(process.execPath, ["server/index.mjs"], {
    cwd: root,
    env: {
      PATH: process.env.PATH,
      PORT: port,
      APP_URL: origin,
      DATA_DIR: directory,
      ENCRYPTION_KEY: key,
      SETUP_TOKEN_HASH: sha(setup),
      NO_BACKGROUND_WORK: "1",
      DUCK_SANDBOX_NETWORK: "host",
    },
  });
  child.stdout.on("data", (d) => logs.push(String(d)));
  child.stderr.on("data", (d) => logs.push(String(d)));
  for (let i = 0; i < 120; i++) {
    try {
      await fetch(origin + "/api/health");
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  db = new Database(path.join(directory, "tameduck.sqlite"));

  // Robin starts Northgate the way an install does. Sam, Ada and Mo are on
  // the team; Priya has an account and a company of her own.
  const made = await call("/auth/setup", {
    method: "POST",
    body: {
      token: setup,
      name: "Robin Bakker",
      email: "robin@northgate.test",
      password,
      company: "Northgate",
    },
  });
  ok(made);
  robin = made.session;
  robinId = db
    .prepare("SELECT id FROM users WHERE email=?")
    .get("robin@northgate.test").id;
  northgate = db
    .prepare("SELECT company_id FROM memberships WHERE user_id=?")
    .get(robinId).company_id;
  sam = person("Sam de Vries", "sam@northgate.test", "member", northgate);
  ada = person("Ada Admin", "ada@northgate.test", "admin", northgate);
  mo = person("Mo Member", "mo@northgate.test", "member", northgate);
  harbour = companyCalled("Second Harbour");
  priya = person("Priya Raman", "priya@harbour.test", "owner", harbour);
  // Chief Duck and four more on the team, and one taken off it.
  for (const name of ["Pip", "Quill", "Rudd", "Tern", "Gone"]) {
    const duck = ok(
      await call("/ducks", {
        method: "POST",
        body: { name, role: "Helper" },
        cookie: robin,
      }),
    );
    if (name === "Gone")
      ok(
        await call("/ducks/" + duck.id + "/removed", {
          method: "PATCH",
          body: { removed: true },
          cookie: robin,
        }),
      );
  }
  // Priya is invited to Northgate too. Made here, because three of the tests
  // below are about her, and each should fail for its own reason.
  forPriya = await invite("priya@harbour.test");
});
after(async () => {
  if (child && child.exitCode === null) {
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGTERM");
    await exited;
  }
  db?.close();
  unitStore.db.close();
  fs.rmSync(directory, { recursive: true, force: true });
  fs.rmSync(unitDirectory, { recursive: true, force: true });
});

let noor, kim, lena, adi;

test("the link is kept encrypted, and never as itself", async () => {
  from = "10.8.1.1";
  noor = await invite("noor@northgate.test");
  assert.equal(noor.row.token_hash, sha(noor.token));
  assert.ok(noor.row.token_enc, "the link is kept, so it can be copied again");
  assert.equal(decrypt(noor.row.token_enc), noor.token);
  for (const [column, value] of Object.entries(noor.row))
    assert.ok(!String(value).includes(noor.token), column + " holds the link");
  // Not in the database file or its journal, byte for byte.
  for (const file of ["tameduck.sqlite", "tameduck.sqlite-wal"]) {
    const where = path.join(directory, file);
    if (fs.existsSync(where))
      assert.ok(!fs.readFileSync(where).includes(noor.token), file);
  }
  // The invitation mail is written down as sent, with its link taken out.
  for (let i = 0; i < 30; i++) {
    if (
      db
        .prepare("SELECT 1 FROM email_log WHERE to_address=?")
        .get("noor@northgate.test")
    )
      break;
    await new Promise((r) => setTimeout(r, 100));
  }
  for (const table of ["audit", "email_log"]) {
    const rows = JSON.stringify(db.prepare(`SELECT * FROM ${table}`).all());
    assert.ok(!rows.includes(noor.token), table + " holds the link");
  }
});

test("the waiting list keeps the ones that ran out, and says who sent each and when", async () => {
  from = "10.8.2.1";
  kim = await invite("kim@northgate.test");
  db.prepare("UPDATE invites SET expires=? WHERE token_hash=?").run(
    Date.now() - 2 * 86400000,
    kim.row.token_hash,
  );
  // Invited twice: the first link is retired, and only the second is waiting.
  await invite("lena@northgate.test", "viewer");
  lena = await invite("lena@northgate.test", "viewer");
  const list = ok(await call("/state", { cookie: robin })).invites;
  const kims = list.find((i) => i.email === "kim@northgate.test");
  assert.ok(kims, "an invitation that ran out is still listed");
  assert.equal(kims.ran_out, 1);
  assert.equal(kims.invited_by, "Robin Bakker");
  assert.equal(kims.created_by, robinId);
  assert.equal(kims.link_kept, 1);
  assert.ok(Math.abs(kims.created - Date.now()) < 60000, "when it was sent");
  assert.equal(kims.token_enc, undefined, "the link itself is never sent");
  const lenas = list.filter((i) => i.email === "lena@northgate.test");
  assert.deepEqual(
    lenas.map((i) => i.id),
    [lena.row.id],
    "one that was replaced is not listed",
  );
  assert.equal(lenas[0].ran_out, 0);
  assert.deepEqual(
    list.map((i) => i.created),
    list.map((i) => i.created).sort((a, b) => b - a),
    "newest first",
  );
  assert.deepEqual(
    ok(await call("/state", { cookie: sam.cookie })).invites,
    [],
    "nobody without Invite people sees any of it",
  );
});

test("Copy link gives the same link again, to whoever may send it", async () => {
  from = "10.8.3.1";
  const link = (row, cookie = robin) =>
    call("/invites/" + row.id + "/link", { cookie });
  assert.equal(ok(await link(noor.row)).url, noor.url);
  assert.ok(audited("Invitation link copied", "noor@northgate.test"));

  adi = await invite("adi@northgate.test", "admin");
  const byAda = await link(adi.row, ada.cookie);
  assert.equal(byAda.status, 403);
  assert.equal(byAda.data?.error, "Only the owner can invite admins.");
  assert.equal((await link(noor.row, sam.cookie)).status, 403);
  const ranOut = await link(kim.row);
  assert.equal(ranOut.status, 410);
  assert.equal(
    ranOut.data?.error,
    "This invitation ran out. Send it again for a new link.",
  );
  const theirs = oldInvitation(harbour, "x@harbour.test", priya.id);
  assert.equal((await link(theirs)).status, 404, "another company's");
  const made = oldInvitation(northgate, "old@northgate.test", robinId);
  const before = await link(made);
  assert.equal(before.status, 409);
  assert.equal(
    before.data?.error,
    "This link was made before links were kept. Send it again for a new one.",
  );
});

test("Send again sends a new link and retires the old one, within today's limits", async () => {
  from = "10.8.4.1";
  const again = (row, cookie = robin) =>
    call("/invites/" + row.id + "/again", { method: "POST", body: {}, cookie });
  // Sent again by Ada, although Robin sent the first one.
  const started = Date.now();
  ok(await again(lena.row, ada.cookie));
  // The old link's kept copy goes with it: nobody can use it any more.
  assert.equal(
    db
      .prepare("SELECT token_enc FROM invites WHERE token_hash=?")
      .get(lena.row.token_hash).token_enc,
    null,
    "the old link is not kept",
  );
  const fresh = newest("lena@northgate.test");
  assert.notEqual(fresh.token_hash, lena.row.token_hash);
  const token = decrypt(fresh.token_enc);
  assert.notEqual(token, lena.token);
  const old = await lookUp(lena.token);
  assert.equal(old.status, 410);
  assert.equal(
    old.data?.error,
    "You were invited again since this email was sent, so this link has been retired. Open the most recent invitation instead.",
  );
  assert.equal(fresh.created_by, ada.id);
  assert.ok(fresh.created >= started && fresh.created <= Date.now());
  assert.equal(fresh.expires, fresh.created + 7 * 86400000);
  assert.equal(fresh.role, "viewer");
  assert.ok(audited("Invitation sent again", "lena@northgate.test"));
  lena = { row: fresh, token, url: origin + "/invite#" + token };

  // One that ran out is live again.
  ok(await again(kim.row));
  const kims = ok(await call("/state", { cookie: robin })).invites.filter(
    (i) => i.email === "kim@northgate.test",
  );
  assert.equal(kims.length, 1);
  assert.equal(kims[0].ran_out, 0);

  // Three to one address in a quarter of an hour, the first one included.
  await invite("max@northgate.test");
  ok(await again(newest("max@northgate.test")));
  ok(await again(newest("max@northgate.test")));
  const fourth = await again(newest("max@northgate.test"));
  assert.equal(fourth.status, 429);
  assert.equal(
    fourth.data?.error,
    "That address has been invited several times just now. Give it a few minutes.",
  );

  const adminByAda = await again(adi.row, ada.cookie);
  assert.equal(adminByAda.status, 403);
  assert.equal(adminByAda.data?.error, "Only the owner can invite admins.");
  assert.equal((await again(adi.row, sam.cookie)).status, 403);
});

test("the look-up says who asked, as what, and who is there", async () => {
  from = "10.8.5.1";
  const r = await lookUp(noor.token);
  const { invitation, you } = ok(r);
  assert.deepEqual(Object.keys(r.data).sort(), ["invitation", "you"]);
  assert.deepEqual(Object.keys(invitation).sort(), [
    "account",
    "company",
    "duck_count",
    "ducks",
    "email",
    "invited_by",
    "more_people",
    "people",
    "role",
  ]);
  assert.equal(invitation.email, "noor@northgate.test");
  assert.equal(invitation.role, "member");
  assert.deepEqual(invitation.company, { name: "Northgate", logo_url: null });
  assert.equal(invitation.invited_by, "Robin Bakker");
  // First names only, the owner first, three at most.
  assert.deepEqual(invitation.people, ["Robin", "Sam", "Ada"]);
  assert.equal(invitation.more_people, 1);
  // Seven faces at most, and the duck taken off the team is not counted.
  assert.equal(invitation.duck_count, 5);
  assert.equal(invitation.ducks.length, 4);
  assert.deepEqual(Object.keys(invitation.ducks[0]).sort(), [
    "avatar",
    "chief",
    "color",
    "emoji",
  ]);
  assert.equal(invitation.ducks[0].chief, 1, "Chief Duck first");
  assert.equal(invitation.account, false);
  assert.equal(you, null);

  assert.equal(ok(await lookUp(forPriya.token)).invitation.account, true);
  // Asked for by POST only, so the token is never in a URL.
  assert.equal((await call("/auth/invitation", { cookie: robin })).status, 404);
});

test("a link that does not work says why", async () => {
  from = "10.8.6.1";
  const why = async (token) => {
    const r = await lookUp(token);
    return [r.status, r.data?.error];
  };
  const ran = await invite("ran@northgate.test");
  db.prepare("UPDATE invites SET expires=? WHERE token_hash=?").run(
    Date.now() - 1000,
    ran.row.token_hash,
  );
  assert.deepEqual(await why(ran.token), [
    410,
    "This invitation ran out. Ask Robin Bakker to send it again.",
  ]);

  const first = await invite("twice@northgate.test");
  await invite("twice@northgate.test");
  assert.deepEqual(await why(first.token), [
    410,
    "You were invited again since this email was sent, so this link has been retired. Open the most recent invitation instead.",
  ]);

  const used = await invite("used@northgate.test");
  person("Una Used", "used@northgate.test", "member", northgate);
  db.prepare("UPDATE invites SET accepted=1 WHERE token_hash=?").run(
    used.row.token_hash,
  );
  assert.deepEqual(await why(used.token), [
    410,
    "You have already joined with this invitation. Sign in instead.",
  ]);

  const NO_LONGER =
    "This link no longer works. Ask the person who invited you to send a new one.";
  const revoked = await invite("gone@northgate.test");
  ok(
    await call("/invites/" + revoked.row.id, {
      method: "DELETE",
      cookie: robin,
    }),
  );
  assert.deepEqual(await why(revoked.token), [410, NO_LONGER]);
  assert.ok(audited("Invitation revoked", "gone@northgate.test"));
  assert.deepEqual(await why(crypto.randomBytes(32).toString("base64url")), [
    410,
    NO_LONGER,
  ]);
  assert.equal((await lookUp("0123456789")).status, 400);
});

test("retired joining makes no account or session writes, even with a valid invitation", async () => {
  from = "10.8.7.1";
  const beforeCounts = accountCounts();
  const beforeInvite = rowFor(noor.token);
  for (const body of [
    { token: noor.token, name: "Noor Jansen" },
    {},
    { token: "short" },
  ]) {
    const r = await call("/auth/join", { method: "POST", body });
    assert.equal(r.status, 410);
    assert.match(r.data.error, /verify your email/);
    assert.equal(r.session, null);
    assert.equal(r.pending, null);
    assert.deepEqual(accountCounts(), beforeCounts);
    assert.deepEqual(rowFor(noor.token), beforeInvite);
  }
  const unsigned = await call("/invites/accept", {
    method: "POST",
    body: { token: noor.token },
  });
  assert.equal(unsigned.status, 401);
  const noMail = await call("/auth/link", {
    method: "POST",
    body: { email: "noor@northgate.test", next: "/invite#" + noor.token },
  });
  assert.equal(
    noMail.status,
    503,
    "an installation without mail cannot bypass mailbox proof",
  );
  assert.equal(noMail.session, null);
  assert.equal(noMail.pending, null);
  assert.deepEqual(accountCounts(), beforeCounts);
  assert.deepEqual(rowFor(noor.token), beforeInvite);
  assert.equal(
    db
      .prepare("SELECT 1 FROM sign_in_links WHERE email=?")
      .get("noor@northgate.test"),
    undefined,
  );
  assert.equal(
    db.prepare("SELECT 1 FROM users WHERE email=?").get("noor@northgate.test"),
    undefined,
  );
});

test("a verified mailbox joins a new invitee once, without a password or recovery key", async () => {
  from = "10.8.7.2";
  const token = mailboxLink("noor@northgate.test");
  const r = await enter(token);
  ok(r);
  assert.ok(r.session);
  assert.equal(r.data.recoveryKey, undefined);
  const user = db
    .prepare("SELECT * FROM users WHERE email=?")
    .get("noor@northgate.test");
  assert.equal(
    user.name,
    "Noor",
    "the existing mailbox flow derives the initial name",
  );
  assert.equal(user.password, "");
  assert.equal(user.recovery_hash, null);
  assert.equal(
    db
      .prepare("SELECT role FROM memberships WHERE company_id=? AND user_id=?")
      .get(northgate, user.id)?.role,
    "member",
  );
  assert.deepEqual(
    {
      ...db
        .prepare("SELECT accepted,token_enc FROM invites WHERE token_hash=?")
        .get(sha(noor.token)),
    },
    { accepted: 1, token_enc: null },
  );
  assert.ok(
    db
      .prepare(
        "SELECT 1 FROM conversations c JOIN conversation_members m ON m.conversation_id=c.id JOIN conversation_ducks cd ON cd.conversation_id=c.id JOIN ducks d ON d.id=cd.duck_id WHERE c.company_id=? AND c.kind='direct' AND m.user_id=? AND d.chief=1",
      )
      .get(northgate, user.id),
    "a chat with Chief Duck is waiting",
  );
  assert.equal(
    ok(await call("/state", { cookie: r.session })).company.id,
    northgate,
  );
  const counts = accountCounts();
  const replay = await enter(token);
  assert.equal(replay.status, 410);
  assert.equal(replay.session, null);
  assert.deepEqual(accountCounts(), counts);
  assert.equal(
    (
      await call("/invites/accept", {
        method: "POST",
        body: { token: noor.token },
        cookie: r.session,
      })
    ).status,
    410,
  );
});

test("expired mailbox proof changes nothing; expired invitations stay unusable after sign-in", async () => {
  from = "10.8.7.3";
  const pending = await invite("expired-proof@northgate.test");
  const counts = accountCounts();
  const expired = await enter(
    mailboxLink("expired-proof@northgate.test", Date.now() - 1000),
  );
  assert.equal(expired.status, 410);
  assert.equal(expired.session, null);
  assert.deepEqual(accountCounts(), counts);
  assert.equal(rowFor(pending.token).accepted, 0);
  const stale = await invite("priya@harbour.test");
  db.prepare("UPDATE invites SET expires=? WHERE token_hash=?").run(
    Date.now() - 1000,
    sha(stale.token),
  );
  const signedIn = await enter(mailboxLink("priya@harbour.test"));
  ok(signedIn);
  assert.equal(
    (
      await call("/invites/accept", {
        method: "POST",
        body: { token: stale.token },
        cookie: signedIn.session,
      })
    ).status,
    410,
  );
  assert.equal(rowFor(stale.token).accepted, 0);
  // Restore a live invitation for the signed-in acceptance tests below.
  forPriya = await invite("priya@harbour.test");
});

test("a verified different mailbox cannot accept the invitation", async () => {
  from = "10.8.7.4";
  const signedIn = await enter(mailboxLink("sam@northgate.test"));
  ok(signedIn);
  const wrong = await call("/invites/accept", {
    method: "POST",
    body: { token: forPriya.token },
    cookie: signedIn.session,
  });
  assert.equal(wrong.status, 403);
  assert.equal(rowFor(forPriya.token).accepted, 0);
  assert.equal(
    db
      .prepare("SELECT 1 FROM memberships WHERE company_id=? AND user_id=?")
      .get(northgate, priya.id),
    undefined,
  );
});

test("mailbox proof preserves two-step sign-in before invitation acceptance", async () => {
  from = "10.8.8.1";
  const ines = person(
    "Ines Okafor",
    "ines@elsewhere.test",
    "owner",
    companyCalled("Elsewhere"),
  );
  const secret = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
  db.prepare(
    "INSERT INTO two_step(user_id,secret,confirmed,created) VALUES(?,?,1,?)",
  ).run(ines.id, encrypt(secret), now());
  const forInes = await invite("ines@elsewhere.test");
  const counts = accountCounts();
  const retired = await call("/auth/join", {
    method: "POST",
    body: { token: forInes.token, name: "Somebody" },
  });
  assert.equal(retired.status, 410);
  assert.equal(retired.session, null);
  assert.equal(retired.pending, null);
  assert.deepEqual(accountCounts(), counts);
  const link = mailboxLink("ines@elsewhere.test");
  const waiting = await enter(link);
  ok(waiting);
  assert.equal(waiting.data.code, true);
  assert.equal(waiting.session, null);
  assert.ok(waiting.pending);
  assert.equal(rowFor(forInes.token).accepted, 0);
  assert.equal(
    (
      await call("/invites/accept", {
        method: "POST",
        body: { token: forInes.token },
        cookie: waiting.pending,
      })
    ).status,
    401,
  );
  assert.equal(
    (await enter(link)).status,
    410,
    "mailbox proof is already spent, including when a code is owed",
  );
  const code = twoStep.codeFor(twoStep.fromBase32(secret), twoStep.stepAt());
  const bad = code === "000000" ? "000001" : "000000";
  const refused = await call("/auth/code", {
    method: "POST",
    body: { code: bad },
    cookie: waiting.pending,
  });
  assert.equal(refused.status, 400);
  assert.equal(refused.session, null);
  assert.equal(rowFor(forInes.token).accepted, 0);
  const signedIn = await call("/auth/code", {
    method: "POST",
    body: { code },
    cookie: waiting.pending,
  });
  ok(signedIn);
  assert.ok(signedIn.session);
  assert.equal(
    rowFor(forInes.token).accepted,
    0,
    "an existing company is preserved until explicit acceptance",
  );
  ok(
    await call("/invites/accept", {
      method: "POST",
      body: { token: forInes.token },
      cookie: signedIn.session,
    }),
  );
  assert.equal(rowFor(forInes.token).accepted, 1);
  assert.equal(
    (
      await call("/auth/code", {
        method: "POST",
        body: { code },
        cookie: waiting.pending,
      })
    ).status,
    410,
  );
});

test("mailbox sign-in retains oldest-pending selection when two companies invite the same new person", async () => {
  from = "10.8.8.2";
  // This hand-built second-company fixture needs the Chief Duck that a
  // company created through the app normally receives.
  const chief = ok(
    await call("/ducks", {
      method: "POST",
      body: { name: "Harbour Chief", role: "Helper" },
      cookie: priya.cookie,
    }),
  );
  db.prepare("UPDATE ducks SET chief=1 WHERE id=?").run(chief.id);
  const first = await invite("multi@northgate.test");
  const second = await invite("multi@northgate.test", "viewer", priya.cookie);
  const signedIn = await enter(mailboxLink("multi@northgate.test"));
  ok(signedIn);
  assert.equal(
    ok(await call("/state", { cookie: signedIn.session })).company.id,
    northgate,
  );
  assert.equal(rowFor(first.token).accepted, 1);
  assert.equal(rowFor(second.token).accepted, 0);
  ok(
    await call("/invites/accept", {
      method: "POST",
      body: { token: second.token },
      cookie: signedIn.session,
    }),
  );
  assert.equal(
    ok(await call("/state", { cookie: signedIn.session })).company.id,
    harbour,
  );
  assert.equal(rowFor(second.token).accepted, 1);
});

test("signed in as the invited address, one press joins; anybody else is refused", async () => {
  from = "10.8.9.1";
  const accept = (token, cookie) =>
    call("/invites/accept", { method: "POST", body: { token }, cookie });
  const wrong = await accept(forPriya.token, sam.cookie);
  assert.equal(wrong.status, 403);
  assert.equal(
    wrong.data?.error,
    "This invitation does not match your signed-in email.",
  );
  ok(await accept(forPriya.token, priya.cookie));
  assert.equal(
    db
      .prepare("SELECT company_id FROM sessions WHERE token_hash=?")
      .get(sha(priya.cookie.split("=")[1])).company_id,
    northgate,
    "this session is now in Northgate",
  );
  assert.deepEqual(
    db
      .prepare(
        "SELECT company_id FROM memberships WHERE user_id=? ORDER BY company_id",
      )
      .all(priya.id)
      .map((m) => m.company_id),
    [harbour, northgate].sort(),
    "and still in her own company",
  );
  const dead = await accept(forPriya.token, priya.cookie);
  assert.equal(dead.status, 410);
});

test("the look-up knows who this browser is signed in as", async () => {
  from = "10.8.10.1";
  assert.deepEqual(ok(await lookUp(lena.token, sam.cookie)).you, {
    id: sam.id,
    name: "Sam de Vries",
    first: "Sam",
    email: "sam@northgate.test",
  });
  // A session whose company membership has ended is nobody.
  const lou = person("Lou Left", "lou@northgate.test", "member", northgate);
  db.prepare("DELETE FROM memberships WHERE user_id=?").run(lou.id);
  assert.equal(ok(await lookUp(lena.token, lou.cookie)).you, null);
  // The invited person, already in: straight there.
  assert.deepEqual(ok(await lookUp(forPriya.token, priya.cookie)), {
    joined: northgate,
  });
});

test("only a page on this site rides through sign-in", () => {
  const { localPath, signInLink } = signIn;
  assert.equal(typeof localPath, "function", "localPath is exported");
  for (const kept of ["/w/x/inbox", "/settings/emails", "/invite#tok"])
    assert.equal(localPath(kept), kept);
  for (const dropped of [
    "//evil.test",
    "/\\evil.test",
    "https://evil.test",
    "javascript:alert(1)",
    "/login",
    "/login#next=/x",
    "/enter#t",
    "/start",
    " /w",
    "/w/x\nfoo",
    "/" + "a".repeat(2000),
    undefined,
    42,
  ])
    assert.equal(localPath(dropped), null, JSON.stringify(dropped));
  assert.equal(
    signInLink("https://a.test", "tok", "/w/x/inbox"),
    "https://a.test/enter#tok&next=%2Fw%2Fx%2Finbox",
  );
  assert.equal(signInLink("https://a.test", "tok"), "https://a.test/enter#tok");
});
