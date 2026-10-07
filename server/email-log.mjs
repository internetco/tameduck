// Every email this server tries to send, kept.
//
// Until now there was no way to answer the first question anybody asks about
// email in production: "did it go?" MailHog holds staging's mail and nothing
// holds production's, so the only record was a line in the service log, which
// rolls over, names no person, and says nothing at all about an email that was
// never attempted because somebody had switched it off.
//
// One row per attempt, with the person it was for, the company it was about,
// what kind of email it was, and what happened:
//
//   sent    handed to the mail server
//   failed  the mail server refused it or could not be reached (error says why)
//   off     not attempted, because the person has switched that kind off
//
// Always the person's user id when there is one - an invitation or a first
// sign-in link goes to an address with no account yet - so "every email we
// sent Maria" is one query however many addresses she has used.
//
// The plain-text body is kept, because "what did it say" is the second
// question. With one exception, made before it is written: a sign-in link and
// an invitation link are each a password for as long as they live, and a table
// of them would be a table of ways in to every account that asked. The token
// after /enter# or /invite# is replaced before the row is written, so the log
// shows that a link was sent without being one.
//
// The table is made by server/migrations/0002_email-log.sql.
import { db, id, now, one } from "./store.mjs";

// A link that opens an account, with its token taken out. Everything after the
// # up to the end of the address: the token is the whole fragment.
export const withoutTokens = (text) =>
  String(text || "").replace(
    /(\/(?:enter|invite)#)[^\s"'<>)\]]+/g,
    "$1[token removed]",
  );

// Whose address this is, when nobody said. An address can be typed in any case
// by whoever invited them; the account is the same person.
const userFor = (address) =>
  one("SELECT id FROM users WHERE lower(email)=lower(?)", String(address || ""))
    ?.id || null;

export function logEmail({
  to,
  user = null,
  company = null,
  kind,
  subject,
  status,
  error = "",
  text = "",
}) {
  // Never the reason an email fails. A log that throws would turn a delivered
  // message into an error for whoever sent it.
  try {
    db.prepare(
      "INSERT INTO email_log(id,created,user_id,company_id,kind,to_address,subject,status,error,body) VALUES(?,?,?,?,?,?,?,?,?,?)",
    ).run(
      id(),
      now(),
      user || userFor(to),
      company || null,
      String(kind || "unknown"),
      String(to || ""),
      String(subject || ""),
      status,
      String(error || "").slice(0, 500),
      withoutTokens(text).slice(0, 20000),
    );
  } catch (e) {
    console.error("Email log:", e.message);
  }
}

// The words of an old email are not worth keeping for ever; the row saying it
// was sent, to whom and when, is. Bodies older than ninety days are cleared,
// the rows stay. Called once an hour by the reminder timer.
const KEEP_BODIES = 90 * 24 * 3600 * 1000;
export function trimEmailLog(at = Date.now()) {
  try {
    return db
      .prepare("UPDATE email_log SET body='' WHERE body<>'' AND created<?")
      .run(new Date(at - KEEP_BODIES).toISOString()).changes;
  } catch (e) {
    console.error("Email log:", e.message);
    return 0;
  }
}
