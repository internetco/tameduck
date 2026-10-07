// The public way in: type an address, open the link that arrives, and you are
// in. No password is chosen, so there is none to guess, reuse or lose.
//
// The thing to keep in mind everywhere below is that the link IS the password
// for the minutes it lives. So: it is long, only its hash is stored, it works
// once, it expires, asking for one is rate limited, and the token travels in
// the URL fragment - after the # - which browsers never send to a server and
// no access log ever records.
import { z } from "zod";
import { db, one, run, id, now, token, hash, fail } from "./store.mjs";
import { mailConfigured, sendMail, signInMessage } from "./mail.mjs";
import { twoStepOn } from "./two-step.mjs";

export const LINK_MINUTES = 15;
const LIFETIME = LINK_MINUTES * 60000;

// Asking is cheap; being asked about is not. Somebody else's address should
// not be made to buzz on a stranger's say-so, so both the address and the
// asker are held to a rate. In memory, which is right for one process and
// resets on deploy - a restart letting a handful of extra mails through is a
// smaller problem than a table to garbage-collect.
const asks = new Map();
export function tooMany(key, limit, windowMs = 15 * 60000) {
  // Recording the ask is the point, so this is called for its effect as well
  // as its answer: never short-circuit past it.
  const at = Date.now();
  const seen = (asks.get(key) || []).filter((t) => at - t < windowMs);
  seen.push(at);
  asks.set(key, seen);
  if (asks.size > 5000)
    for (const [k, v] of asks)
      if (!v.some((t) => at - t < windowMs)) asks.delete(k);
  return seen.length > limit;
}

// A company has to be called something and we are not asking. The domain is
// the best guess available: somebody signing up as maria@northgate.io is
// almost certainly setting up Northgate. Free mail providers say nothing about
// a company, so those fall back to the name on the address. Whatever it lands
// on, it is one field in Settings to change.
const PUBLIC_MAIL = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "yahoo.com",
  "ymail.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "proton.me",
  "protonmail.com",
  "pm.me",
  "gmx.com",
  "gmx.net",
  "web.de",
  "zoho.com",
  "aol.com",
  "fastmail.com",
  "hey.com",
  "mail.com",
  "yandex.com",
  "tutanota.com",
  "tuta.io",
  "duck.com",
  "posteo.de",
  "t-online.de",
]);

const titleCase = (s) =>
  s
    .split(/[-_. ]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ")
    .slice(0, 100);

export function companyNameFor(email) {
  const [local, domain = ""] = String(email).toLowerCase().split("@");
  const host = domain.replace(/^www\./, "");
  if (host && !PUBLIC_MAIL.has(host)) {
    // northgate.co.uk -> Northgate. The label before the public suffix is the
    // name; everything after it is plumbing.
    const parts = host.split(".").filter(Boolean);
    const label =
      parts.length > 2 && parts.at(-2).length <= 3
        ? parts.at(-3)
        : parts.at(-2) || parts[0];
    const named = titleCase(label || "");
    if (named) return named;
  }
  const named = titleCase(local || "");
  return named ? named + "'s company" : "My company";
}

const address = z.string().trim().toLowerCase().email().max(254);

// The page somebody was opening when they were asked to sign in: an app link,
// or an invitation. It rides through the emailed link and is opened after it,
// so it is only ever a page on this site. public/auth.js keeps a copy of this
// rule. Anything else is null, and the link goes to the workspace.
export function localPath(value) {
  if (typeof value !== "string" || value.length > 2000) return null;
  // A path here. //elsewhere and /\elsewhere are read by browsers as another
  // site, and anything not starting with / is not a path at all.
  if (!/^\/(?![/\\])/.test(value)) return null;
  // No spaces or control characters, which no address on this site has.
  if (/[\s\u0000-\u001f\u007f]/.test(value)) return null;
  // The way in itself would only ask again.
  if (/^\/(login|enter|start)/.test(value)) return null;
  return value;
}

export const signInLink = (base, value, next) =>
  `${base}/enter#${value}` + (next ? "&next=" + encodeURIComponent(next) : "");

export function registerSignIn(
  app,
  { session, placeFor, membershipOf, community = false },
) {
  // Asking for a link. The answer is the same sentence whether or not this
  // address has an account, and whether or not a link was really sent: an
  // endpoint that says "no account here" is a way to find out who has one.
  app.post("/api/auth/link", async (req, res) => {
    const a = z
      .object({
        email: address,
        // Never a reason to refuse: the page reads a refusal as a bad address.
        next: z.string().max(2000).optional().catch(undefined),
      })
      .parse(req.body);
    const quiet = () => res.json({ ok: true, minutes: LINK_MINUTES });

    // Per address. Everything under /api/auth is already held to 35 requests a
    // quarter of an hour per caller; what that does not stop is one caller
    // making somebody else's inbox buzz eleven times, so the address has a
    // limit of its own.
    if (tooMany("email:" + a.email, 3)) return quiet();
    if (!mailConfigured())
      fail(
        503,
        "Mail is not set up on this server yet, so no link can be sent.",
      );

    const returning = one("SELECT id FROM users WHERE email=?", a.email);
    // Somebody with a place already waiting for them is not starting a
    // company, and telling them they are is how they arrive confused.
    const invite = one(
      "SELECT c.name FROM invites i JOIN companies c ON c.id=i.company_id WHERE i.email=? AND i.accepted=0 AND i.expires>? ORDER BY i.rowid LIMIT 1",
      a.email,
      Date.now(),
    );
    // A server somebody runs for their own team is not open to everybody who
    // finds it: a link goes only to somebody with a place here or an
    // invitation to one. Before setup nobody has either, so the setup link
    // stays the only way in. The answer is the same sentence all the same.
    if (community && !invite && !(returning && membershipOf(returning.id)))
      return quiet();

    const value = token();
    run(
      "INSERT INTO sign_in_links VALUES(?,?,?,?,0)",
      hash(value),
      a.email,
      Date.now(),
      Date.now() + LIFETIME,
    );
    const base = (process.env.APP_URL || "").replace(/\/+$/, "");
    const { subject, text, html } = signInMessage({
      // After the #. The server never sees it in a request line, so it is not
      // in any access log, and a mail scanner that fetches the URL cannot burn
      // the link: opening it needs the page's own script to send it on. The
      // page they were opening rides after the # too, so it is in no log either.
      link: signInLink(base, value, localPath(a.next)),
      minutes: LINK_MINUTES,
      returning: !!returning,
      invited: invite?.name || null,
    });
    try {
      await sendMail({ to: a.email, subject, text, html });
    } catch (e) {
      // The link is useless now; do not leave it live for its full quarter of
      // an hour when nobody was ever told what it was.
      run("DELETE FROM sign_in_links WHERE token_hash=?", hash(value));
      fail(502, "The link could not be sent. Try again in a moment.");
    }
    return quiet();
  });

  // Opening the link. Claiming the token and doing the work are one
  // transaction, so two tabs racing cannot both get in on one link.
  app.post("/api/auth/enter", (req, res) => {
    const a = z.object({ token: z.string().min(20).max(400) }).parse(req.body);
    const digest = hash(a.token);
    let userId = null;
    let companyId = null;
    let created = false;
    let newCompany = null;

    db.transaction(() => {
      // Claim it. A single statement so the check and the spend cannot be
      // separated: if this changes no rows, somebody else already had it.
      const claimed = run(
        "UPDATE sign_in_links SET used=1 WHERE token_hash=? AND used=0 AND expires>?",
        digest,
        Date.now(),
      );
      if (!claimed.changes)
        fail(
          410,
          "This link has been used or has run out. Ask for a new one and it will arrive in a moment.",
        );
      const link = one(
        "SELECT email FROM sign_in_links WHERE token_hash=?",
        digest,
      );

      const user = one("SELECT * FROM users WHERE email=?", link.email);
      // On a community server an account comes with an invitation, and
      // nobody starts a company of their own by opening a link.
      if (
        community &&
        !(user && membershipOf(user.id)) &&
        !one(
          "SELECT 1 FROM invites WHERE email=? AND accepted=0 AND expires>?",
          link.email,
          Date.now(),
        )
      )
        fail(
          403,
          "Only people invited to this TameDuck can sign in. Ask one of its admins to invite you.",
        );
      if (user) {
        userId = user.id;
      } else {
        userId = id();
        // No password and no recovery key: there is nothing to recover to.
        // The column stays because every other row has one.
        run(
          "INSERT INTO users VALUES(?,?,?,?,?,?)",
          userId,
          link.email,
          nameFromEmail(link.email),
          "",
          null,
          now(),
        );
        created = true;
      }

      // Somebody who was invited belongs in the company that invited them,
      // not in a fresh one of their own. Without this, opening a link after
      // being invited quietly started a second, empty company and left the
      // invitation sitting unaccepted. Nowhere to be and nobody expecting
      // them is the "start a company" case, and also the way back for
      // somebody who was taken out of the only company they were in.
      newCompany = community ? null : companyNameFor(link.email);
      // With two-step sign-in on, joined or started only after the code.
      const place = twoStepOn(userId)
        ? membershipOf(userId)
        : placeFor(userId, newCompany);
      companyId = place?.company ?? null;
      created = created || !!place?.created;
    })();

    // With two-step sign-in on, this is a pending sign-in and the answer says
    // a code is owed; the link is spent either way.
    const next = session(res, userId, companyId, newCompany);
    res.json({ ok: true, created, company: companyId, ...next });
  });
}

// Somebody has to be called something in the sidebar until they say otherwise.
function nameFromEmail(email) {
  const local = String(email).split("@")[0] || "";
  return titleCase(local) || "New teammate";
}

// Old links are rubbish within the quarter hour; sweep them so the table does
// not grow for ever on a server nobody prunes.
export function sweepSignInLinks() {
  run("DELETE FROM sign_in_links WHERE expires < ?", Date.now() - 24 * 3600000);
}
