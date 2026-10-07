import crypto from "node:crypto";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { db, one, run, token, memberFor, fail } from "./store.mjs";

const opaque = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const reference = z.object({ id: opaque });
const claim = reference.extend({ verifier: opaque });
const lifetime = 15 * 60000;
const codeLifetime = 5 * 60000;
const maxAttempts = 5;
const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const hashCode = (id, code) =>
  crypto
    .createHash("sha256")
    .update(id + ":" + code)
    .digest("hex");
const expired = () =>
  fail(
    410,
    "This desktop sign-in has expired. Start again in the latest TameDuck app on your computer.",
  );
function active(id) {
  const row = one("SELECT * FROM desktop_signins WHERE id=?", id);
  if (
    !row ||
    row.mode !== "browser-code" ||
    row.consumed ||
    row.expires <= Date.now() ||
    (row.handoff_code_expires && row.handoff_code_expires <= Date.now()) ||
    row.handoff_attempts >= maxAttempts
  )
    expired();
  return row;
}
function verifyApp(row, verifier) {
  const challenge = crypto
    .createHash("sha256")
    .update(verifier)
    .digest("base64url");
  if (
    !crypto.timingSafeEqual(Buffer.from(challenge), Buffer.from(row.challenge))
  )
    fail(401, "This sign-in belongs to a different app request.");
}
function approvedUser(row) {
  const user = one(
    "SELECT u.id,u.name,u.email FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.user_id=? AND s.expires>?",
    row.approved_session_hash,
    row.approved_user_id,
    Date.now(),
  );
  if (!user || !memberFor(row.approved_company_id, user.id)) expired();
  return user;
}

// Start and polling belong to a signed-out app. Only a full browser session
// (after two-step sign-in) may issue the short-lived secret. Polling never
// grants a session: the app must submit both its verifier and the typed code.
export function registerDesktopSignIn(app, { auth, signedInAs, openSession }) {
  const startLimit = rateLimit({
    windowMs: lifetime,
    limit: 10,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: {
      error: "Too many desktop sign-in requests. Try again in 15 minutes.",
    },
  });
  app.post("/api/desktop-signin/start", startLimit, (req, res) => {
    const { challenge, mode } = z
      .object({ challenge: opaque, mode: z.string().optional() })
      .parse(req.body);
    if (mode !== "browser-code")
      fail(
        426,
        "Update TameDuck desktop to use browser sign-in. You can still paste a fresh email sign-in link into the app.",
      );
    run("DELETE FROM desktop_signins WHERE expires<=?", Date.now());
    if (one("SELECT COUNT(*) n FROM desktop_signins").n >= 10000)
      fail(503, "Desktop sign-in is busy. Please try again shortly.");
    const id = token(),
      expires = Date.now() + lifetime;
    // code is the obsolete comparison field, kept for additive migration compatibility.
    run(
      "INSERT INTO desktop_signins(id,challenge,code,expires,mode) VALUES(?,?,'',?,'browser-code')",
      id,
      challenge,
      expires,
    );
    res.json({
      id,
      expires_at: expires,
      interval: 3,
      browser_path: "/desktop-signin#request=" + id,
    });
  });
  app.post("/api/desktop-signin/info", (req, res) => {
    const { id } = reference.parse(req.body),
      row = active(id),
      user = signedInAs(req);
    res.json({
      expires_at: row.expires,
      code_issued: !!row.handoff_code_hash,
      user: user ? { name: user.name, email: user.email } : null,
    });
  });
  app.post("/api/desktop-signin/approve", auth, (req, res) => {
    const { id } = reference.parse(req.body);
    const result = db.transaction(() => {
      const row = active(id);
      if (row.approved_session_hash)
        fail(
          409,
          "A code was already issued for this sign-in. If you lost it, start a new sign-in in the desktop app.",
        );
      const secret = Array.from(
        crypto.randomBytes(8),
        (byte) => alphabet[byte & 31],
      ).join("");
      const expires = Math.min(row.expires, Date.now() + codeLifetime);
      run(
        "UPDATE desktop_signins SET approved_session_hash=?,approved_user_id=?,approved_company_id=?,handoff_code_hash=?,handoff_code_expires=? WHERE id=?",
        req.session.token_hash,
        req.user.id,
        req.company.id,
        hashCode(id, secret),
        expires,
        id,
      );
      // Plaintext is returned once, to this authenticated browser only.
      return {
        ok: true,
        code: secret.slice(0, 4) + "-" + secret.slice(4),
        expires_at: expires,
      };
    })();
    res.json(result);
  });
  app.post("/api/desktop-signin/check", (req, res) => {
    const { id, verifier } = claim.parse(req.body),
      row = active(id);
    verifyApp(row, verifier);
    if (row.approved_session_hash) approvedUser(row);
    res
      .status(202)
      .json({ status: row.handoff_code_hash ? "code_ready" : "pending" });
  });
  app.post("/api/desktop-signin/finish", (req, res) => {
    const { id, verifier, code } = claim
      .extend({ code: z.string().max(32) })
      .parse(req.body);
    const normalized = code.toUpperCase().replace(/[\s-]/g, "");
    if (!/^[A-Z2-9]{8}$/.test(normalized))
      fail(400, "Enter the eight-character code from your browser.");
    const result = db.transaction(() => {
      const row = active(id);
      verifyApp(row, verifier);
      if (!row.handoff_code_hash)
        fail(409, "Finish signing in in your browser first to get a code.");
      const user = approvedUser(row);
      if (
        !crypto.timingSafeEqual(
          Buffer.from(hashCode(id, normalized)),
          Buffer.from(row.handoff_code_hash),
        )
      ) {
        const attempts = row.handoff_attempts + 1,
          locked = attempts >= maxAttempts;
        run(
          "UPDATE desktop_signins SET handoff_attempts=?,consumed=? WHERE id=?",
          attempts,
          locked ? 1 : 0,
          id,
        );
        // Return instead of throwing so the transaction commits the failed attempt.
        return {
          statusCode: locked ? 410 : 400,
          body: {
            error: locked
              ? "Too many incorrect codes. Start a new sign-in in the desktop app."
              : "That code does not match. Check the code in your browser.",
            attempts_remaining: Math.max(0, maxAttempts - attempts),
          },
        };
      }
      run(
        "UPDATE desktop_signins SET consumed=1,handoff_code_hash=NULL WHERE id=?",
        id,
      );
      openSession(res, user.id, row.approved_company_id);
      return {
        statusCode: 200,
        body: {
          status: "complete",
          company: row.approved_company_id,
          user: { name: user.name, email: user.email },
        },
      };
    })();
    res.status(result.statusCode).json(result.body);
  });
}
