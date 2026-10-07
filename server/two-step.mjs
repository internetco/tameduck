// Two-step sign-in: after the email link, a 6-digit code from an
// authenticator app on the person's phone. It is the standard every such
// app understands (RFC 6238: HMAC-SHA1, 30-second steps, 6 digits), so Google
// Authenticator, Microsoft Authenticator, 1Password and Authy all work.
//
// Every way of getting a session goes through session() in server/index.mjs,
// and that asks here first. Somebody who has this on gets a pending sign-in
// instead of a session: five minutes, held by this browser in an HttpOnly
// cookie, and good for nothing but typing the code. Doing it in that one place
// means a way in added later cannot forget to ask.
import crypto from "node:crypto";
import { z } from "zod";
import qrcode from "qrcode-generator";
import {
  db,
  one,
  run,
  now,
  token,
  hash,
  encrypt,
  decrypt,
  fail,
  audit,
} from "./store.mjs";
import { send } from "./mail.mjs";
import { p, small } from "./mail-design.mjs";

const STEP_SECONDS = 30;
const DIGITS = 6;
export const PENDING_MINUTES = 5;
// Wrong codes allowed in one pending sign-in, and for one person in a quarter
// of an hour across all of them. The second is what stops somebody who has the
// email link from simply starting over for five more guesses.
export const TRIES = 5;
export const WRONG_LIMIT = 10;
const WRONG_WINDOW = 15 * 60000;
export const BACKUP_CODES = 8;
// Where somebody with no other way back writes to, having lost both their
// phone and their backup codes: anybody an owner may not do it for (see
// ownerCanTurnOff). Whoever runs TameDuck then uses scripts/two-step-off.mjs.
const HELP_ADDRESS = "info@tameduck.com";
const COOKIE = "td_pending";
// Only sent to the sign-in routes: nothing else has any use for it.
const COOKIE_PATH = "/api/auth";

// ---- the code ---------------------------------------------------------------

// Authenticator apps take the key as base32: letters and the digits 2-7, which
// is also what a person types when the camera will not work.
const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export function base32(bytes) {
  let bits = 0,
    value = 0,
    out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}
export function fromBase32(text) {
  let bits = 0,
    value = 0;
  const out = [];
  for (const c of String(text)
    .toUpperCase()
    .replace(/[\s=-]/g, "")) {
    const at = BASE32.indexOf(c);
    if (at < 0) throw new Error("Not a base32 key");
    value = (value << 5) | at;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export const stepAt = (ms = Date.now()) => Math.floor(ms / 1000 / STEP_SECONDS);

// RFC 4226's HOTP for one step: an HMAC of the step number, cut down to
// `digits` decimal digits the way every app does it.
export function codeFor(secret, step, digits = DIGITS) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = crypto.createHmac("sha1", secret).update(counter).digest();
  const at = mac[mac.length - 1] & 15;
  const number = mac.readUInt32BE(at) & 0x7fffffff;
  return String(number % 10 ** digits).padStart(digits, "0");
}

// People type "123 456" as often as "123456"; neither is a secret.
const digitsOf = (typed) => String(typed ?? "").replace(/[\s-]/g, "");

// Which step a typed code belongs to, or null. One step either side is
// allowed, because a phone's clock is seldom exactly right and a code typed in
// its last second arrives in the next. All three are compared, each in
// constant time, so how long this takes says nothing about how close a guess
// was.
export function matchingStep(secret, typed, at = stepAt()) {
  const code = digitsOf(typed);
  if (!/^\d{6}$/.test(code)) return null;
  const given = Buffer.from(code);
  let found = null;
  for (const step of [at - 1, at, at + 1]) {
    const same = crypto.timingSafeEqual(
      Buffer.from(codeFor(secret, step)),
      given,
    );
    if (same && found === null) found = step;
  }
  return found;
}

// ---- backup codes -------------------------------------------------------------

// Ten characters with nothing that reads as something else (no l, o, 0 or 1),
// shown as two groups of five.
const BACKUP_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";
function backupCode() {
  const bytes = crypto.randomBytes(10);
  const chars = [...bytes].map((b) => BACKUP_ALPHABET[b & 31]).join("");
  return chars.slice(0, 5) + "-" + chars.slice(5);
}
const backupDigits = (typed) =>
  String(typed ?? "")
    .toLowerCase()
    .replace(/[\s-]/g, "");
// Keyed with the server's own encryption key, so a copy of the database alone
// is not enough to try every code offline.
function backupHash(user, typed) {
  return crypto
    .createHmac("sha256", Buffer.from(process.env.ENCRYPTION_KEY || "", "hex"))
    .update(user + ":" + backupDigits(typed))
    .digest("hex");
}

// ---- who has it on --------------------------------------------------------------

// How long a session lasts (server/index.mjs opens them with it), so how
// long ago somebody signed in can be read off when their session ends.
export const SESSION_MS = 14 * 86400000;
// Turning it on only from a sign-in made in the last half hour. Somebody who
// got hold of an open session - a laptop left unlocked - could otherwise
// switch it on with their own phone, and since it signs every other session
// out, lock the real person out of their own account.
const RECENT_MS = 30 * 60000;
const signedInRecently = (session) =>
  !!session && Date.now() - (session.expires - SESSION_MS) < RECENT_MS;
export const twoStepOn = (user) =>
  !!one("SELECT 1 FROM two_step WHERE user_id=? AND confirmed=1", user);

const inAnotherCompany = (user, company) =>
  !!one(
    "SELECT 1 FROM memberships WHERE user_id=? AND company_id<>?",
    user,
    company,
  );
// Whether the owner of this company may turn it off for this person. It is
// off for their whole account, not for one company, so only for somebody in
// this company alone: then this company is all it opens. Anybody can start a
// company and invite anybody, so otherwise the owner of any company they had
// once joined could open all the others with nothing but the email link.
// Everybody else, owners included, goes through scripts/two-step-off.mjs.
export const ownerCanTurnOff = (user, company) =>
  twoStepOn(user) && !inAnotherCompany(user, company);

const backupLeft = (user) =>
  one(
    "SELECT count(*) n FROM two_step_backup_codes WHERE user_id=? AND used=0",
    user,
  ).n;

// What is said to somebody who is locked out, with the minutes still to wait,
// or null if they are not locked out.
export function lockedFor(user) {
  const row = one(
    "SELECT wrong,wrong_since FROM two_step WHERE user_id=?",
    user,
  );
  if (!row || row.wrong < WRONG_LIMIT) return null;
  const left = row.wrong_since + WRONG_WINDOW - Date.now();
  if (left <= 0) return null;
  const minutes = Math.ceil(left / 60000);
  return `Too many wrong codes. Try again in ${minutes === 1 ? "1 minute" : minutes + " minutes"}.`;
}
function noteWrong(user) {
  const at = Date.now();
  run(
    "UPDATE two_step SET wrong=CASE WHEN ?-wrong_since>=? THEN 1 ELSE wrong+1 END, wrong_since=CASE WHEN ?-wrong_since>=? THEN ? ELSE wrong_since END WHERE user_id=?",
    at,
    WRONG_WINDOW,
    at,
    WRONG_WINDOW,
    at,
    user,
  );
}

const WRONG_CODE =
  "That code is not right. Type the newest code from your app.";
const WRONG_BACKUP = "That backup code is not right, or it has been used.";
const REUSED =
  "That code has just been used. Wait for the next one in your app.";

// Spends a code from the app or a backup code: true, or why not. The spend is
// one conditional UPDATE each, so two requests racing with one code cannot
// both have it.
function spend(user, { code, backup }) {
  if (backup)
    return run(
      "UPDATE two_step_backup_codes SET used=1 WHERE user_id=? AND code_hash=? AND used=0",
      user,
      backupHash(user, backup),
    ).changes === 1
      ? true
      : WRONG_BACKUP;
  const row = one("SELECT secret FROM two_step WHERE user_id=?", user);
  if (!row) return WRONG_CODE;
  const step = matchingStep(fromBase32(decrypt(row.secret)), code);
  if (step === null) return WRONG_CODE;
  // Only a step after the last one used. A code read over a shoulder, or out
  // of a request log, is spent the moment its owner types it.
  return run(
    "UPDATE two_step SET last_step=? WHERE user_id=? AND last_step<?",
    step,
    user,
    step,
  ).changes === 1
    ? true
    : REUSED;
}
// The one check signing in, new backup codes and turning it off all use. A
// person who is locked out is refused even with the right code: otherwise the
// limit would only slow down the guessing, not stop it. 423 rather than 429,
// so the sign-in page can tell this wait from one sign-in that ran out of
// tries, which a new link does fix.
function attempt(user, answer) {
  const wait = lockedFor(user);
  if (wait) fail(423, wait);
  const result = spend(user, answer);
  if (result === true) run("UPDATE two_step SET wrong=0 WHERE user_id=?", user);
  else {
    noteWrong(user);
    // The try that locks them out, and only that one, since a locked person's
    // tries are refused above. Whoever typed these got past the email link,
    // and could keep the real person out for good by starting again every
    // quarter of an hour. Without this they would never know.
    if (
      one("SELECT wrong FROM two_step WHERE user_id=?", user)?.wrong ===
      WRONG_LIMIT
    )
      tellLocked(user);
  }
  return result;
}

const answer = z
  .object({
    code: z.string().max(20).optional(),
    backup: z.string().max(40).optional(),
  })
  .refine((a) => a.code || a.backup, "Type the code first.");

// ---- signing in -------------------------------------------------------------------

let secure = false;

// Instead of a session: a pending sign-in, for somebody who has two-step on.
// Returns what the caller adds to its answer, so the page knows to ask.
// company is null for somebody in no company yet; see placeFor in
// server/index.mjs, which runs after the code instead of before it.
export function holdForCode(res, user, company, newCompany = null) {
  // Swept on the way past rather than on a timer; they live five minutes.
  run("DELETE FROM pending_sign_ins WHERE expires<?", Date.now());
  const value = token();
  run(
    "INSERT INTO pending_sign_ins VALUES(?,?,?,?,?,0)",
    hash(value),
    user,
    company,
    newCompany,
    Date.now() + PENDING_MINUTES * 60000,
  );
  res.cookie(COOKIE, value, {
    httpOnly: true,
    secure,
    sameSite: "strict",
    maxAge: PENDING_MINUTES * 60000,
    path: COOKIE_PATH,
  });
  // Somebody who is locked out is told so now, not after typing a code that
  // would be refused anyway. Only somebody who got past the first step
  // hears it, so it says nothing to a stranger about whose account is whose.
  const wait = lockedFor(user);
  return wait ? { code: true, locked: wait } : { code: true };
}

export function registerTwoStepSignIn(
  app,
  { openSession, placeFor, production },
) {
  secure = production;
  const pendingFor = (req) => {
    const value = req.cookies?.[COOKIE];
    return value
      ? one(
          "SELECT * FROM pending_sign_ins WHERE token_hash=? AND expires>?",
          hash(value),
          Date.now(),
        )
      : null;
  };

  // The /enter page asks this when it opens with no link in its address, as it
  // does when reloaded while a code is still owed: it takes the link out of
  // the address as soon as it has read it.
  app.get("/api/auth/pending", (req, res) => {
    const pending = pendingFor(req);
    const wait = pending && lockedFor(pending.user_id);
    res.json(wait ? { waiting: true, locked: wait } : { waiting: !!pending });
  });

  app.post("/api/auth/code", (req, res) => {
    const a = answer.parse(req.body);
    const pending = pendingFor(req);
    // Ends this sign-in for good: the person starts again from the top.
    const over = (status, message) => {
      if (pending)
        run(
          "DELETE FROM pending_sign_ins WHERE token_hash=?",
          pending.token_hash,
        );
      res.clearCookie(COOKIE, { path: COOKIE_PATH });
      fail(status, message);
    };
    if (!pending)
      over(
        410,
        `This sign-in stopped after ${PENDING_MINUTES} minutes. Start again.`,
      );
    const wait = lockedFor(pending.user_id);
    if (wait) over(423, wait);
    const result = attempt(pending.user_id, a);
    if (result !== true) {
      run(
        "UPDATE pending_sign_ins SET tries=tries+1 WHERE token_hash=?",
        pending.token_hash,
      );
      const lockedNow = lockedFor(pending.user_id);
      if (lockedNow) over(423, lockedNow);
      if (pending.tries + 1 >= TRIES)
        over(
          429,
          `That is ${TRIES} wrong codes, so this sign-in has stopped. Start again.`,
        );
      fail(400, result);
    }
    // Spent once. Nothing awaits between here and the lookup above, but a
    // pending sign-in that becomes two sessions is the one thing this must
    // never do, so the delete says whether it was still there.
    if (
      !run(
        "DELETE FROM pending_sign_ins WHERE token_hash=?",
        pending.token_hash,
      ).changes
    )
      over(410, "This sign-in has already been used. Start again.");
    res.clearCookie(COOKIE, { path: COOKIE_PATH });
    // Somebody in no company yet joins the one that invited them, or starts
    // one, only now: the first step alone must change nothing.
    const company =
      pending.company_id ||
      placeFor(pending.user_id, pending.new_company)?.company;
    if (!company) fail(403, "Ask a company owner to invite you.");
    openSession(res, pending.user_id, company);
    res.json({ ok: true });
  });
}

// ---- turning it on and off, from Settings > Your account ----------------------

// The picture an app's camera reads, as the squares to paint: the client draws
// them as one SVG path, so there is no image to fetch and nothing to run.
function qrFor(text) {
  const q = qrcode(0, "M");
  q.addData(text);
  q.make();
  const count = q.getModuleCount();
  // Four empty squares round the edge: a camera needs the quiet margin to
  // find the corners.
  let path = "";
  for (let y = 0; y < count; y++)
    for (let x = 0; x < count; x++)
      if (q.isDark(y, x)) path += `M${x + 4} ${y + 4}h1v1h-1z`;
  return { size: count + 8, path };
}

// ---- the security emails ----------------------------------------------------------

// Always sent, whatever the person has switched off: they are about the way
// into the account itself. The promise is returned so that
// scripts/two-step-off.mjs can wait for it before it exits.
function mailAbout(user, company, message) {
  const address = one("SELECT email FROM users WHERE id=?", user)?.email;
  if (!address) return Promise.resolve(false);
  return send({
    to: address,
    user,
    company,
    kind: "security",
    ...message,
  }).catch((e) => {
    console.error("Two-step email:", e.message);
    return false;
  });
}
// The way back for somebody whose account had it turned on by somebody else,
// or who has lost their phone and their backup codes.
// The Team page shows that button as a picture only, so the words describe
// the picture: "Permissions" appears nowhere on a phone.
const WAY_BACK = `Ask the owner of your company to turn it off for you: on the Team page, they press the button with a person and a gear beside your name. If you own a company, or are in more than one, email ${HELP_ADDRESS}.`;

function tellOn(user, company) {
  return mailAbout(user, company, {
    subject: "Two-step sign-in is on",
    preheader: "Signing in now also asks for a code from your phone.",
    blocks: [
      p(
        "Two-step sign-in is now on for your TameDuck account. After the email link, you will also be asked for a code from your authenticator app.",
      ),
      small(
        "If this wasn't you, somebody else is in your account and you may not be able to sign in. " +
          WAY_BACK,
      ),
    ],
    reason: "You got this because the way into your account changed.",
  });
}

function tellLocked(user) {
  return mailAbout(user, null, {
    subject: "Too many wrong codes",
    preheader: "Signing in to your account is paused for 15 minutes.",
    blocks: [
      p(
        `Somebody typed ${WRONG_LIMIT} wrong codes from the authenticator app while signing in to your TameDuck account, so signing in is paused for 15 minutes.`,
      ),
      small(
        "If this wasn't you, somebody else can read your email. Change your email's password.",
      ),
    ],
    reason: "You got this because somebody tried to get into your account.",
  });
}

// by is who turned it off: the person themselves, the owner of their company
// (with their name and the company's), or whoever runs TameDuck.
export function tellOff(user, company, by = { who: "self" }) {
  const after =
    "Signing in no longer asks for a code from your phone. You can turn it on again in Settings, Your account.";
  const [said, ifNot] =
    by.who === "owner"
      ? [
          `${by.name}, the owner of ${by.company}, turned off two-step sign-in for your TameDuck account. ${after}`,
          `If you did not ask for this, tell ${by.name} straight away.`,
        ]
      : by.who === "support"
        ? [
            `As you asked, we turned off two-step sign-in for your TameDuck account. ${after}`,
            `If you did not ask for this, email ${HELP_ADDRESS} straight away.`,
          ]
        : [
            "Two-step sign-in is now off for your TameDuck account. Signing in no longer asks for a code from your phone.",
            "If this wasn't you, somebody else is in your account. Sign in, turn two-step sign-in back on in Settings, and tell the owner of your company.",
          ];
  return mailAbout(user, company, {
    subject: "Two-step sign-in is off",
    preheader: "Signing in no longer asks for a code from your phone.",
    blocks: [p(said), small(ifNot)],
    reason: "You got this because the way into your account changed.",
  });
}

// ---- turning it on and off ----------------------------------------------------------

// Eight new backup codes in place of any old ones. Called inside the caller's
// transaction; the codes themselves are returned once and only their hashes
// kept.
function newBackupCodes(user) {
  const codes = Array.from({ length: BACKUP_CODES }, backupCode);
  run("DELETE FROM two_step_backup_codes WHERE user_id=?", user);
  for (const code of codes)
    run(
      "INSERT INTO two_step_backup_codes VALUES(?,?,0)",
      user,
      backupHash(user, code),
    );
  return codes;
}

// Off, whoever does it: the key, the backup codes, and any sign-in that was
// waiting for a code, all at once.
export function turnOff(user) {
  db.transaction(() => {
    run("DELETE FROM two_step_backup_codes WHERE user_id=?", user);
    run("DELETE FROM pending_sign_ins WHERE user_id=?", user);
    run("DELETE FROM two_step WHERE user_id=?", user);
  })();
}

export function registerTwoStepSettings(app) {
  // What Settings > Your account needs to show about signing in: whether the
  // second step is on.
  app.get("/api/account/sign-in", (req, res) => {
    const on = twoStepOn(req.user.id);
    res.json({
      two_step: on,
      backup_codes_left: on ? backupLeft(req.user.id) : 0,
    });
  });

  // A new key, not yet in force. It only counts once a code from it has been
  // typed back, so a key that never reached the phone locks nobody out.
  app.post("/api/account/two-step/start", (req, res) => {
    if (twoStepOn(req.user.id)) fail(409, "Two-step sign-in is already on.");
    if (!signedInRecently(req.session))
      fail(
        403,
        "To turn this on, sign in again first. It works for half an hour after you sign in.",
      );
    const key = base32(crypto.randomBytes(20));
    run(
      "INSERT INTO two_step(user_id,secret,confirmed,last_step,created) VALUES(?,?,0,0,?) ON CONFLICT(user_id) DO UPDATE SET secret=excluded.secret,confirmed=0,last_step=0,created=excluded.created",
      req.user.id,
      encrypt(key),
      now(),
    );
    const uri =
      "otpauth://totp/" +
      encodeURIComponent("TameDuck") +
      ":" +
      encodeURIComponent(req.user.email) +
      `?secret=${key}&issuer=TameDuck&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`;
    res.json({
      // In fours, the way it is easiest to copy by hand.
      key: key.match(/.{1,4}/g).join(" "),
      uri,
      qr: qrFor(uri),
    });
  });

  app.post("/api/account/two-step/confirm", (req, res) => {
    const a = z.object({ code: z.string().max(20) }).parse(req.body);
    const user = req.user.id;
    const row = one("SELECT * FROM two_step WHERE user_id=?", user);
    if (!row) fail(409, "Start again: press Turn on.");
    if (row.confirmed) fail(409, "Two-step sign-in is already on.");
    const wait = lockedFor(user);
    if (wait) fail(423, wait);
    const step = matchingStep(fromBase32(decrypt(row.secret)), a.code);
    if (step === null) {
      noteWrong(user);
      fail(400, WRONG_CODE);
    }
    let codes;
    db.transaction(() => {
      run(
        "UPDATE two_step SET confirmed=1,last_step=?,wrong=0 WHERE user_id=?",
        step,
        user,
      );
      codes = newBackupCodes(user);
      // Everywhere else this account was signed in is signed out: somebody
      // who turns this on because they fear another person is in their
      // account wants that person out now, not in fourteen days.
      run(
        "DELETE FROM sessions WHERE user_id=? AND token_hash<>?",
        user,
        req.session.token_hash,
      );
    })();
    audit(req.company.id, user, "Two-step sign-in turned on");
    tellOn(user, req.company.id);
    // Shown once, here, and never again: only their hashes are kept.
    res.json({ ok: true, codes });
  });

  // New backup codes for old ones, for somebody who has used most of theirs or
  // lost the list. A code from the app (or a backup code) says it is them.
  app.post("/api/account/two-step/backup-codes", (req, res) => {
    const a = answer.parse(req.body);
    const user = req.user.id;
    if (!twoStepOn(user)) fail(409, "Two-step sign-in is off.");
    const result = attempt(user, a);
    if (result !== true) fail(400, result);
    const codes = db.transaction(() => newBackupCodes(user))();
    audit(req.company.id, user, "New two-step backup codes");
    res.json({ ok: true, codes });
  });

  app.post("/api/account/two-step/off", (req, res) => {
    const a = answer.parse(req.body);
    const user = req.user.id;
    if (!twoStepOn(user)) fail(409, "Two-step sign-in is already off.");
    const result = attempt(user, a);
    if (result !== true) fail(400, result);
    turnOff(user);
    audit(req.company.id, user, "Two-step sign-in turned off");
    tellOff(user, req.company.id);
    res.json({ ok: true });
  });

  // The way back for a teammate who has lost their phone and their backup
  // codes: without it, nobody could ever let them in again. Only the owner,
  // as with everything else about a teammate's account, and only for
  // somebody in no other company: see ownerCanTurnOff. The teammate is
  // emailed at once, and it is in the company's activity.
  app.delete("/api/members/:id/two-step", (req, res) => {
    if (req.member.role !== "owner")
      fail(
        403,
        "Only the company owner can turn off a teammate's two-step sign-in.",
      );
    const them = one(
      "SELECT u.id,u.name FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.company_id=? AND m.user_id=?",
      req.company.id,
      req.params.id,
    );
    if (!them) fail(404, "Member not found.");
    if (them.id === req.user.id)
      fail(400, "Turn off your own in Settings, Your account.");
    // One answer, whatever the reason. Saying "is in another company too"
    // told an owner which teammates use TameDuck somewhere else - of anybody,
    // two-step sign-in or not - which the screen is careful not to say.
    if (!twoStepOn(them.id) || inAnotherCompany(them.id, req.company.id))
      fail(
        409,
        `You can't turn off two-step sign-in for ${them.name} here. If they have lost their phone and their backup codes, they email ${HELP_ADDRESS}.`,
      );
    turnOff(them.id);
    audit(
      req.company.id,
      req.user.id,
      "Two-step sign-in turned off for a teammate",
      them.name,
    );
    tellOff(them.id, req.company.id, {
      who: "owner",
      name: req.user.name,
      company: req.company.name,
    });
    res.json({ ok: true });
  });
}
