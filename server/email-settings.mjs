// Which emails a person gets.
//
// Per person, not per company: somebody in four companies does not want to
// answer this four times, and "stop emailing me" means stop, not stop for one
// of them.
//
// Four switches rather than one per message. A list with a row for every
// email we might ever send is a list nobody reads, and it goes stale the day
// somebody adds a message and forgets the row. These are the four questions a
// person actually has an opinion about.
//
// The way in is not on the list and never will be. A sign-in link is not a
// notification, it is the only way to open the door, and an account that has
// turned it off is an account nobody can get into - including to turn it back
// on. Same for an invitation: it goes to somebody who has no settings here yet.
import { one, run, now } from "./store.mjs";

// What each switch covers, in the words the settings page uses. The server
// holds this rather than the screen, so the page and the gate can never
// disagree about what somebody turned off.
export const EMAIL_KINDS = Object.freeze({
  waiting: {
    title: "A duck needs you right now",
    detail:
      "A duck has stopped part-way through a job because it needs you to do one step on its screen — a code texted to you, a password, a payment. It waits about ten minutes, so this one is sent straight away.",
  },
  decisions: {
    title: "Things waiting for your answer",
    // This said "Approvals, proposals from Chief Duck, and work that has
    // stopped", which described three emails when only the last one existed.
    // A settings page that offers to switch off something we never send is a
    // page nobody can trust about the things we do send.
    detail:
      "Approvals, proposals and a duck's questions, once they have waited 30 minutes and you have not had TameDuck open since - all in one email. Also when a scheduled job gives up.",
  },
  boards: {
    title: "Tasks waiting on a board",
    detail:
      "When a task has waited an hour at a step on a board that a person has to take. Sent to everybody who can work on task boards, once for each task.",
  },
  company: {
    title: "Your company and plan",
    detail:
      "Somebody joined, computer time ran out, or every duck has stopped for want of a working AI connection. Rare, and always something you have to act on.",
  },
});
// Anything not in that list is always sent: the way in, an invitation to
// somebody who is not here yet, word that the way in has changed (two-step
// sign-in turned on or off) - the one email somebody whose account was taken
// most needs to see - and billing: an invoice, a receipt, notice of a payment
// about to be taken, and a payment that failed are owed to whoever pays.
export const ALWAYS = Object.freeze(["sign_in", "invitation", "security", "billing"]);

const DEFAULTS = Object.freeze({
  waiting: 1,
  decisions: 1,
  boards: 1,
  company: 1,
});

export function emailSettings(user) {
  const row = one("SELECT * FROM email_settings WHERE user_id=?", user);
  return {
    waiting: row ? !!row.waiting : !!DEFAULTS.waiting,
    decisions: row ? !!row.decisions : !!DEFAULTS.decisions,
    boards: row ? !!row.boards : !!DEFAULTS.boards,
    company: row ? !!row.company : !!DEFAULTS.company,
  };
}

// The one question the sending code asks. Unknown kinds are sent rather than
// dropped: a message nobody thought to classify is more likely to be important
// than to be noise, and a silent drop is the hardest kind of bug to see.
export function mayEmail(user, kind) {
  if (ALWAYS.includes(kind)) return true;
  if (!(kind in EMAIL_KINDS)) return true;
  return emailSettings(user)[kind];
}

export function saveEmailSettings(user, wanted) {
  const value = (k) =>
    wanted[k] === undefined ? DEFAULTS[k] : wanted[k] ? 1 : 0;
  run(
    "INSERT INTO email_settings(user_id,waiting,decisions,boards,company,updated) VALUES(?,?,?,?,?,?) " +
      "ON CONFLICT(user_id) DO UPDATE SET waiting=excluded.waiting,decisions=excluded.decisions,boards=excluded.boards,company=excluded.company,updated=excluded.updated",
    user,
    value("waiting"),
    value("decisions"),
    value("boards"),
    value("company"),
    now(),
  );
  return emailSettings(user);
}

// Where the link at the bottom of every email goes.
export const emailSettingsUrl = () =>
  (process.env.APP_URL || "https://tameduck.com").replace(/\/+$/, "") +
  "/settings/emails";

export function registerEmailSettings(app) {
  app.get("/api/email-settings", (req, res) => {
    res.json({ settings: emailSettings(req.user.id), kinds: EMAIL_KINDS });
  });
  app.put("/api/email-settings", (req, res) => {
    const body = req.body || {};
    res.json({ settings: saveEmailSettings(req.user.id, body) });
  });
}
registerEmailSettings.emailSettings = emailSettings;
registerEmailSettings.saveEmailSettings = saveEmailSettings;
registerEmailSettings.mayEmail = mayEmail;
