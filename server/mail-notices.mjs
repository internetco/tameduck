// The emails the product sends, and who gets each one.
//
// One function per moment. The moment calls it; it works out who should hear,
// asks whether they want to, writes the message, and sends. Keeping that here
// rather than at each call site means the rules hold everywhere: which company
// it is about, why it arrived, where to turn it off, and never twice.
//
// Nothing here throws at its caller. A duck stopping to ask for help must not
// fail because a mailbox is full, so a send that goes wrong is logged and the
// rest still go.
import { all, one, run, db, now, permissions } from "./store.mjs";
import { send } from "./mail.mjs";
import { p, button, small, list } from "./mail-design.mjs";
import { canConnectAI } from "../shared/ai-access.mjs";

// What has already been sent, in email_sent. A duck announces the same request
// more than once - a retry, a reconnect, a second look by the scheduler - and
// each of those is the same thing to chase, not a new one.
export const firstTime = (key) =>
  db
    .prepare("INSERT OR IGNORE INTO email_sent(key,created) VALUES(?,?)")
    .run(key, now()).changes > 0;
// The claim is taken before the send, so two announcements arriving together
// cannot both write. That means a send which then fails has already been
// written down as done, and a duck has about ten minutes and usually announces
// again inside it - so the one remaining chance to reach the person was being
// swallowed by the record of an email that never arrived. A claim is given
// back when nothing could be delivered.
const forget = (key) =>
  db.prepare("DELETE FROM email_sent WHERE key=?").run(key);

// A claim is given back when a send fails, so the next moment tries again -
// right for a mail server that is down, for a minute or for an hour. Not for
// an address the mail server refuses: that is refused every time, and giving
// it back tried it every minute for as long as the thing waited, 1,440 times
// a day. A refusal keeps the claim - one try - and the email log says why.
//
// Two versions in between counted tries instead, and both lost emails that a
// plain outage should not: three tries went in three minutes, or all at once
// when several failed runs said the same thing together.
export function giveBack(result, keys) {
  if (result.sent || result.failed <= result.refused) return false;
  for (const k of keys) forget(k);
  return true;
}

// Names reach these emails from the product, and some of them were typed by a
// duck: Chief Duck names the ducks it recruits, and a duck the company trusts
// can write a standing task and call it what it likes. A name is a name, so it
// is cut to one line and a sensible length before it goes near a subject. What
// this stops is a duck that has been reading somebody else's web page calling
// itself "Duck - reply with the code from your bank" and having us print that
// above our own logo.
export const plain = (text, max = 60) => {
  const one = String(text ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  return one.length > max ? one.slice(0, max - 1).trimEnd() + "\u2026" : one;
};
export const appUrl = () =>
  (process.env.APP_URL || "https://tameduck.com").replace(/\/+$/, "");
export const companyName = (company) =>
  plain(one("SELECT name FROM companies WHERE id=?", company)?.name) ||
  "your company";
const personName = (user) =>
  plain(one("SELECT name FROM users WHERE id=?", user)?.name) || "Somebody";

// One person, by id. Returns nothing rather than throwing when they are gone.
const addressOf = (user) =>
  one("SELECT email FROM users WHERE id=?", user)?.email || null;

// Everybody in a company who could actually do the thing the email is about.
// Telling somebody about a schedule they have no way to restart is telling
// them off for something they cannot fix.
function peopleWhoCanFix(company) {
  return all(
    "SELECT u.id, u.email, m.role, m.permissions FROM memberships m " +
      "JOIN users u ON u.id=m.user_id " +
      "WHERE m.company_id=? AND m.role IN ('owner','admin')",
    company,
  );
}

// Every send goes through here: one mailbox at a time, and one that fails does
// not take the others with it.
// The mail server says no to the address, for good. Nodemailer calls a
// refused recipient EENVELOPE, but also uses it for our own sender being
// refused, and a 4xx is "try later", so neither of those counts.
const refusedAddress = (e) =>
  e?.code === "EENVELOPE" &&
  (e.command === "RCPT TO"
    ? e.responseCode >= 500
    : /recipient/i.test(e.message));

export async function deliver(messages) {
  let sent = 0;
  let failed = 0;
  let refused = 0;
  for (const message of messages) {
    try {
      if (await send(message)) sent += 1;
    } catch (e) {
      failed += 1;
      if (refusedAddress(e)) refused += 1;
      console.error(
        'Could not send "' + message.subject + '" to ' + message.to + ":",
        e.message,
      );
    }
  }
  // Somebody who has this switched off is not a failure: nothing was sent and
  // nothing should have been.
  return { sent, failed, refused };
}
const howMany = (result) => result.sent;

// The same opening on every one of them, so "You got this because" is the
// phrase people learn to look for when they want to know why we wrote.
const settingsLine = "You got this because you are on this company's team.";

// ---- somebody is invited ---------------------------------------------------
// Until now this email did not exist: the product showed the owner a link and
// left them to send it themselves, and the only mail an invited person ever
// got was one telling them to start a company they were not starting.
export async function invited({ company, invitedBy, email, link }) {
  const name = companyName(company);
  const asker = personName(invitedBy);
  return howMany(
    await deliver([
      {
        to: email,
        // No `user`: they may not have an account here at all, and somebody with
        // no settings cannot have turned this off.
        company,
        kind: "invitation",
        subject: `${asker} invited you to ${name} on TameDuck`,
        preheader: `Open this to join ${name}.`,
        blocks: [
          p(
            `${asker} invited you to ${name} on TameDuck, a workspace where AI teammates work alongside the people.`,
          ),
          button(`Join ${name}`, link),
          small("The link is yours alone. It stops working in seven days."),
          small(
            "If you were not expecting this, ignore it and nothing happens.",
          ),
        ],
        reason: `You got this because ${asker} invited you to ${name}.`,
      },
    ]),
  );
}

// ---- somebody joins --------------------------------------------------------
export async function joined({ company, joiner, invitedBy }) {
  // Nobody is told about their own arrival.
  if (!invitedBy || invitedBy === joiner) return 0;
  // And nobody who has since left. addressOf() is a plain lookup against
  // users, so an inviter who was taken off the team months ago would still be
  // told who is joining a company they can no longer see.
  if (
    !one(
      "SELECT 1 FROM memberships WHERE company_id=? AND user_id=?",
      company,
      invitedBy,
    )
  )
    return 0;
  const address = addressOf(invitedBy);
  if (!address) return 0;
  // Once per arrival. Three routes can reach this now, and one person can be
  // invited, join, be removed and be invited again.
  if (!firstTime(`joined:${company}:${joiner}`)) return 0;
  const name = companyName(company);
  return howMany(
    await deliver([
      {
        to: address,
        user: invitedBy,
        company,
        kind: "company",
        subject: `${personName(joiner)} joined ${name}`,
        preheader: "They can see the chats they are in.",
        blocks: [
          p(
            `${personName(joiner)} has joined ${name} and can see the chats they are part of.`,
          ),
          button("Open your team", `${appUrl()}/w/${company}/team`),
        ],
        reason: settingsLine,
      },
    ]),
  );
}

// ---- a duck is waiting on its screen ---------------------------------------
// The one the product is broken without. A duck stops part-way through a job
// because it has reached a step only a person can do, and it waits about ten
// minutes. Most of the time nobody comes, and it carries on without them.
//
// Three rules, all load-bearing:
//   - Nothing the duck wrote goes in. It has been reading somebody else's web
//     page, and a page can tell it to write "reply with the code".
//   - No sign-in token. An email saying a duck needs your bank code that also
//     logs you in is a phishing template with our name on it.
//   - One recipient: the person the duck asked. Everybody else would be turned
//     away at that screen anyway.
export async function waiting({
  company,
  user,
  duck,
  requestId,
  computerId,
  expiresAt,
  now: at = Date.now(),
}) {
  if (!firstTime("waiting:" + requestId)) return 0;
  const address = addressOf(user);
  if (!address) return 0;
  const name = companyName(company);
  const duckName =
    plain(one("SELECT name FROM ducks WHERE id=?", duck)?.name, 40) || "A duck";
  const timezone =
    one("SELECT timezone FROM companies WHERE id=?", company)?.timezone ||
    "UTC";
  // A time, not a duration. Mail sits in a queue, and "in ten minutes" is
  // wrong by the time it is read.
  let until = "shortly";
  try {
    until = new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZoneName: "short",
    }).format(new Date(expiresAt));
  } catch {}
  const result = await deliver([
    {
      to: address,
      user,
      company,
      kind: "waiting",
      // The company, not the duck. A duck's name is written by Chief Duck
      // after reading pages we do not control, and a subject line is the one
      // piece of an email that is read with no context at all - cutting it
      // short still left "Duck - REPLY WITH THE 6-DIGIT CODE FROM..." sitting
      // in an inbox under our name. The name is in the first line instead,
      // where it reads as a name in a sentence. The company is the more
      // useful half anyway: one person can be in several.
      subject: `A duck needs you for one step in ${name}`,
      preheader: `It waits until ${until}.`,
      blocks: [
        p(
          `${duckName} has stopped part-way through a job in ${name}. It has reached a step only you can do — a code sent to you, a password, or a payment — and it is holding its screen open for you.`,
        ),
        button(
          "Take the screen",
          `${appUrl()}/w/${company}/computers/${computerId}/control/${requestId}`,
        ),
        small(`It waits until ${until}, then carries on without you.`),
        small(
          "What it needs is on the screen. We never put it in an email, and we never ask you for it by reply.",
        ),
      ],
      reason: settingsLine,
    },
  ]);
  // Nothing arrived and it was not the person's choice, so the next time this
  // duck announces the same request it may try again.
  giveBack(result, ["waiting:" + requestId]);
  return result.sent;
}

// ---- no duck can work at all -----------------------------------------------
// Every duck in the company has stopped, and it will still be stopped tomorrow
// unless somebody signs in again or pays somebody. Until now this was written
// into the chat bubble of whichever run happened to fail, which is the last
// place anybody looks when nothing is answering - and if the company runs on
// standing tasks rather than chat, nobody was looking at all.
//
// Only the durable causes reach here: a key that was rejected, an account out
// of credits, a subscription that dropped. A rate limit or a provider having a
// bad five minutes is not somebody's problem to solve, and during a real
// outage every queued job in the company fails within minutes, so anything
// looser than this would be a storm rather than a notice.
export async function aiStopped({ company, why }) {
  // Once per company until it works again. The key is given back by the first
  // run that finishes.
  if (!firstTime("ai-stopped:" + company)) return 0;
  const name = companyName(company);
  // Only somebody who can connect an AI: the button opens AI connection, and
  // an admin without "Connect outside tools" is not let in there.
  const fixers = peopleWhoCanFix(company).filter((person) =>
    canConnectAI(person.role, permissions(person)),
  );
  const result = await deliver(
    fixers.map((person) => ({
      to: person.email,
      user: person.id,
      company,
      kind: "company",
      subject: `The ducks in ${name} have stopped working`,
      preheader: plain(why, 90),
      blocks: [
        p(
          `No duck in ${name} can do anything until its connection to an AI is working again. Everything they were asked to do is waiting rather than lost.`,
        ),
        p(plain(why, 200)),
        button("Open the connection", `${appUrl()}/w/${company}/settings/ai`),
        small(
          "You get this once. We will not write again about the same problem.",
        ),
      ],
      reason: settingsLine,
    })),
  );
  giveBack(result, ["ai-stopped:" + company]);
  return result.sent;
}

// Work is being done again, so the next outage is a new thing to say.
export const aiWorking = (company) => forget("ai-stopped:" + company);

// ---- the month's computer time is nearly gone ------------------------------
// The one moment in this product where doing nothing costs a company the rest
// of its month. Chief Duck says it in the chat, which is the right place for
// somebody who is here - and chat is never emailed, so for somebody who is not
// here it said nothing at all. The whole point of telling anybody at 80% is
// that there is still something they can do: stop a machine nobody is using,
// or tell a duck to stop leaving them up. At 100% it is too late for the
// month, and they should at least know why their ducks have stopped.
//
// The words are written here rather than lifted out of the chat message. That
// message is delivered as a duck, and this one is from us.
export async function computerTime({
  company,
  people,
  threshold,
  used,
  whole,
  until,
}) {
  const name = companyName(company);
  const done = threshold >= 100;
  const half = threshold <= 50;
  return howMany(
    await deliver(
      (people || [])
        .map((user) => ({ user, to: addressOf(user) }))
        .filter((x) => x.to)
        .map(({ user, to }) => ({
          to,
          user,
          company,
          kind: "company",
          subject: done
            ? `${name} has used this month's computer time`
            : half
              ? `${name} is half way through this month's computer time`
              : `${name} has used 80% of this month's computer time`,
          preheader: done
            ? `No new computer can start until ${until}.`
            : `It starts again on ${until}.`,
          blocks: [
            p(
              done
                ? `${name} has used all ${whole} of this month's computer time. No new computer can start until ${until}. Any that are running now carry on until they stop.`
                : half
                  ? `${name} has used ${used} of this month's ${whole} of computer time. Nothing is wrong: this is the half-way mark, sent while there is still time to do something about it.`
                  : `${name} has used ${used} of this month's ${whole} of computer time. When it is gone, no new computer can start until ${until} — the ones already running carry on.`,
            ),
            p(
              done
                ? "Your ducks can still think, write and talk. It is only the computers they cannot start."
                : "A computer left running uses time whether anybody is watching it or not, so the usual fix is to stop the ones nobody needs.",
            ),
            button(
              "See what is using it",
              `${appUrl()}/w/${company}/settings/usage`,
            ),
          ],
          reason: settingsLine,
        })),
    ),
  );
}

// ---- things have waited half an hour, and you have not been in -------------
// Needs you, sent to somebody who is not looking at it. server/waiting-
// reminders.mjs decides who is owed one and hands over everything waiting on
// them; this writes it.
//
// Every line is ours. A proposal's name, an approval's tool and a duck's
// question are all words a duck wrote or a third-party server chose, and the
// duck has been reading pages nobody here controls - so a line says what kind
// of thing is waiting and whose it is, and the words themselves stay in the
// app, behind the button.
const ago = (since, at) => {
  const minutes = Math.max(1, Math.floor((at - since) / 60000));
  if (minutes < 60) return minutes === 1 ? "1 minute" : `${minutes} minutes`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return hours === 1 ? "an hour" : `${hours} hours`;
  return `${Math.floor(hours / 24)} days`;
};
const waitLine = (item, at) => {
  const who = plain(item.duck, 40) || "A duck";
  const how = `waiting ${ago(item.since, at)}`;
  if (item.kind === "approval") return `${who} needs your approval (${how})`;
  if (item.kind === "skill") return `${who} proposed a skill (${how})`;
  if (item.kind === "board")
    return `${who} proposed a change to a task board (${how})`;
  if (item.kind === "schedule")
    return `${who} proposed a scheduled task (${how})`;
  if (item.kind === "stuck")
    return `A task ${who} was working on is stuck and needs you (${how})`;
  return `${who} asked you a question (${how})`;
};
// How many lines before the rest are counted rather than listed. Past this it
// is a backlog, and the button is the better way to see it.
const SHOWN = 8;

export async function waitingReminder({
  company,
  user,
  items,
  owed,
  now: at = Date.now(),
}) {
  if (!items?.length || !owed?.length) return 0;
  if (
    !one(
      "SELECT 1 FROM memberships WHERE company_id=? AND user_id=?",
      company,
      user,
    )
  )
    return 0;
  const address = addressOf(user);
  if (!address) return 0;
  // Claimed only now that there is somebody to write to - taking the claim
  // first would spend it on a person with no address, for good. One claim per
  // thing per person: a thing is only ever the reason for one email, however
  // long it goes on waiting, but the next new thing is a reason for another.
  const claimed = db.transaction(() =>
    owed.map((i) => `remind:${i.key}:${user}`).filter((k) => firstTime(k)),
  )();
  if (!claimed.length) return 0;
  const name = companyName(company);
  const one_ = items.length === 1;
  // What this email is about goes first, then the rest, oldest first. Listed
  // oldest first throughout, a backlog of eight week-old questions filled the
  // list and the new approval that caused the email was "and 1 more" - with
  // its one reminder spent, so nothing would ever name it.
  const owedKeys = new Set(owed.map((i) => i.key));
  const ordered = [
    ...items.filter((i) => owedKeys.has(i.key)),
    ...items.filter((i) => !owedKeys.has(i.key)),
  ];
  const shown = ordered.slice(0, SHOWN);
  const lines = shown.map((i) => waitLine(i, at));
  if (items.length > SHOWN) lines.push(`and ${items.length - SHOWN} more`);
  const result = await deliver([
    {
      to: address,
      user,
      company,
      kind: "decisions",
      subject: one_
        ? `Something is waiting for you in ${name}`
        : `${items.length} things are waiting for you in ${name}`,
      preheader: `The oldest has been waiting ${ago(Math.min(...items.map((i) => i.since)), at)}.`,
      blocks: [
        p(
          one_
            ? `This is waiting for you in ${name}:`
            : `These are waiting for you in ${name}:`,
        ),
        list(lines),
        button("Open Needs you", `${appUrl()}/w/${company}/inbox`),
        small(
          "We only send this when something has waited 30 minutes and you have not had TameDuck open since.",
        ),
      ],
      reason: `You got this because ${one_ ? "this is" : "these are"} waiting for your answer in ${name}.`,
    },
  ]);
  // Nothing arrived and it was not their choice: the next sweep may try again.
  giveBack(result, claimed);
  return result.sent;
}

// ---- tasks waiting on a board ----------------------------------------------
// server/board-reminders.mjs decides who hears and when; this writes it. One
// email per board, with every task on it that is waiting for a person, the ones
// that caused the email first. Each line opens its task.
//
// Stage and board names are in its lines, cut short; the task's own title is
// not. Any duck can open a task and call it what it likes, having read pages
// nobody here controls. A board and its stages are usually set up by a person
// or approved by one, but a company can let Chief change a board without
// asking - so they stay out of the subject and read as names in a sentence.
const boardLine = (item, at) => {
  const stage = plain(item.stage, 40) || "a step";
  const how = `waiting ${ago(item.since, at)}`;
  if (item.need === "move")
    return `At "${stage}": done, and waiting to be moved on (${how})`;
  if (item.need === "changes")
    return `At "${stage}": changes were asked for, and it needs a new attempt (${how})`;
  if (item.need === "stuck")
    return `At "${stage}": stuck, and it needs a new attempt (${how})`;
  return `At "${stage}": a person needs to do this step (${how})`;
};

// Returns { sent, retry }: how many went out, and whether a failed send gave
// its claims back so the sweep should come back for it.
export async function boardReminder({
  company,
  user,
  board,
  boardName,
  items,
  owed,
  now: at = Date.now(),
}) {
  if (!items?.length || !owed?.length) return { sent: 0, retry: false };
  if (
    !one(
      "SELECT 1 FROM memberships WHERE company_id=? AND user_id=?",
      company,
      user,
    )
  )
    return { sent: 0, retry: false };
  const address = addressOf(user);
  if (!address) return { sent: 0, retry: false };
  // Once for each wait, per person, however long it goes on.
  const claimed = db.transaction(() =>
    owed.map((i) => `board:${i.key}:${user}`).filter((k) => firstTime(k)),
  )();
  if (!claimed.length) return { sent: 0, retry: false };
  const name = companyName(company);
  const boardTitle = plain(boardName, 60) || "a task board";
  const owedKeys = new Set(owed.map((i) => i.key));
  const ordered = [
    ...items.filter((i) => owedKeys.has(i.key)),
    ...items.filter((i) => !owedKeys.has(i.key)),
  ];
  const shown = ordered.slice(0, SHOWN);
  const lines = shown.map((i) => ({
    text: boardLine(i, at),
    href: `${appUrl()}/w/${company}/tasks/boards/${board}/ticket/${i.task}`,
  }));
  if (items.length > SHOWN) lines.push(`and ${items.length - SHOWN} more`);
  const one_ = items.length === 1;
  const result = await deliver([
    {
      to: address,
      user,
      company,
      kind: "boards",
      // The company in the subject, not the board: a duck Chief is allowed to
      // change a board without asking can rename it, and a subject line is
      // the part of an email read with no context at all. The board is named
      // in the first line, where it reads as a name in a sentence.
      subject: one_
        ? `A task is waiting for someone in ${name}`
        : `${items.length} tasks are waiting for someone in ${name}`,
      preheader: `On a task board in ${name}.`,
      blocks: [
        p(
          one_
            ? `This task on ${boardTitle} in ${name} is waiting for a person:`
            : `These tasks on ${boardTitle} in ${name} are waiting for a person:`,
        ),
        list(lines),
        button(
          "Open the board",
          `${appUrl()}/w/${company}/tasks/boards/${board}`,
        ),
        small(
          "Everybody who can work on task boards gets this, once for each task, when it has waited an hour.",
        ),
      ],
      reason: `You got this because you can work on task boards in ${name}.`,
    },
  ]);
  const retry = giveBack(result, claimed);
  return { sent: result.sent, retry };
}

// ---- standing work stops ---------------------------------------------------
export async function scheduleStopped({ company, title, reason }) {
  const name = companyName(company);
  // A standing task is named by whoever wrote it, and on a company that lets
  // its ducks write them, that is sometimes a duck.
  const job = plain(title, 70) || "A scheduled job";
  return howMany(
    await deliver(
      peopleWhoCanFix(company).map((person) => ({
        to: person.email,
        user: person.id,
        company,
        kind: "decisions",
        subject: `${job} has stopped running`,
        preheader: reason,
        blocks: [
          p(
            `The scheduled job "${job}" in ${name} has stopped and will not run again until somebody starts it.`,
          ),
          p(reason),
          button("Open schedules", `${appUrl()}/w/${company}/tasks/scheduled`),
        ],
        reason: settingsLine,
      })),
    ),
  );
}
