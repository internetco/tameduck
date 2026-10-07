// Sending mail. There is exactly one kind so far: the link somebody opens to
// get in. That link IS the password, so everything here is written on the
// assumption that a copy of it lands somewhere neither we nor they control.
import nodemailer from "nodemailer";
import { mailTransportConfig } from "./mail-config.mjs";
import {
  render,
  p as para,
  button,
  small,
  rule,
  sender,
} from "./mail-design.mjs";
import { mayEmail, emailSettingsUrl, ALWAYS } from "./email-settings.mjs";
import { logEmail } from "./email-log.mjs";

// Separate SMTP fields support production credentials with URL punctuation;
// SMTP_URL remains available for staging. With neither, sign-in mail refuses
// to send rather than appearing to succeed.
const config = mailTransportConfig(process.env);
const from = process.env.MAIL_FROM || "TameDuck <no-reply@tameduck.com>";

export const mailConfigured = () => !!config;

let transport = null;
function mailer() {
  if (!config) return null;
  if (!transport) {
    // A sign-in link is worth a moment's wait, and not more.
    const timeouts = {
      connectionTimeout: 8000,
      greetingTimeout: 8000,
      socketTimeout: 12000,
    };
    transport =
      typeof config === "string"
        ? nodemailer.createTransport(config, timeouts)
        : nodemailer.createTransport({ ...config, ...timeouts });
  }
  return transport;
}

// Only the way in goes out through here, and Chief Duck is who asked for the
// address on the page, so the mail comes from Chief Duck too. The name
// changes and the configured address does not: that is the one the mail
// server is set up to send from.
export const chiefDuckFrom = () => ({
  name: "Chief Duck at TameDuck",
  address: (from.match(/<([^>]+)>/) || [null, from])[1].trim(),
});

// Every attempt goes in server/email-log.mjs's table, whatever happens to it.
export async function sendMail({
  to,
  subject,
  text,
  html,
  kind = "sign_in",
  user = null,
  company = null,
}) {
  const entry = { to, user, company, kind, subject, text };
  try {
    await deliver({ from: chiefDuckFrom(), to, kind, subject, text, html });
  } catch (e) {
    logEmail({ ...entry, status: "failed", error: e.message });
    throw e;
  }
  logEmail({ ...entry, status: "sent" });
}

// Everything goes out through here, and a test can replace it. Without this
// seam there is no way to see that a message was sent - or, harder and more
// important, that one was not.
let deliver = async ({ kind, ...message }) => {
  // `kind` travels with the message so a test - and anything we ever put in
  // front of this, a log or a queue - can tell a sign-in link from a notice
  // without reading the subject. It is ours, not SMTP's, so it stops here.
  const t = mailer();
  if (!t) {
    const problem = new Error(
      "No mail server is configured, so the link could not be sent.",
    );
    problem.status = 503;
    throw problem;
  }
  await t.sendMail(message);
};
export const sendWith = (fn) => {
  deliver = fn;
};

// The way every message that is not the sign-in link should be sent: say who
// it is for and what kind it is, and it is rendered in both parts, checked
// against what that person has turned off, and given the footer that says why
// it arrived.
//
// `user` is optional because an invitation goes to somebody who has no account
// here yet; with nobody to ask, it is sent.
export async function send({
  to,
  user,
  company = null,
  kind,
  subject,
  preheader,
  blocks,
  reason,
  // Files to go with it: an invoice's PDF. [{ filename, content, contentType }]
  attachments = undefined,
}) {
  if (user && !mayEmail(user, kind)) {
    // Kept too: "why did I not get it" is answered by the row that says the
    // person had switched it off.
    logEmail({ to, user, company, kind, subject, status: "off" });
    return false;
  }
  const message = render({
    subject,
    preheader,
    blocks,
    reason,
    // The two that are always sent offer no way to switch themselves off,
    // because there is not one. The invitation used to carry the link anyway,
    // which sent a stranger with no account here to a sign-in wall to look for
    // a switch that does not exist.
    settingsUrl: ALWAYS.includes(kind) ? null : emailSettingsUrl(),
  });
  const entry = { to, user, company, kind, subject, text: message.text };
  try {
    await deliver({
      from,
      to,
      kind,
      ...message,
      ...(attachments?.length ? { attachments } : {}),
    });
  } catch (e) {
    logEmail({ ...entry, status: "failed", error: e.message });
    throw e;
  }
  logEmail({ ...entry, status: "sent" });
  return true;
}

// The way in. The text part still carries the address in full and on its own
// line, exactly as it did when this was the only thing we sent: a link that
// renders as a button in one client and as nothing in another is a support
// ticket, and this is the one message where not arriving means locked out.
export function signInMessage({ link, minutes, returning, invited }) {
  const subject = invited
    ? `You have been invited to ${invited}`
    : returning
      ? "Your TameDuck sign-in link"
      : "Start your company on TameDuck";
  // Where to open it is said every time. The mail is read on a phone, and a
  // link opened there signs in the phone while the computer that asked goes
  // on waiting. It names both, because somebody may have asked on the phone.
  const opening = invited
    ? `${invited} has a place waiting for you. Open this link on the phone or computer where you asked.`
    : "Here’s your way in. Open it on the phone or computer where you asked.";
  // The button says what it does. "Open TameDuck" read the same for somebody
  // starting a company and somebody coming back.
  const action = invited
    ? `Join ${invited}`
    : returning
      ? "Open my workspace"
      : "Start my company";
  return render({
    subject,
    preheader: `Works once, for ${minutes} minutes.`,
    blocks: [
      sender("Chief Duck", "TameDuck", "/brand/chief-duck-email.png"),
      para(opening),
      button(action, link, { bare: true, wide: true }),
      rule(),
      small(
        `Works once, for ${minutes} minutes. Didn’t ask? Ignore it, nothing changes.`,
      ),
    ],
    // No switch to offer: turning this off would lock the account nobody could
    // then get back into.
    settingsUrl: null,
    personal: true,
  });
}
