// What our emails look like.
//
// One description of a message, two renderings: plain text and HTML. Written
// once and rendered twice rather than written twice, because the pair that
// drifts is the pair somebody edits in a hurry - and the plain text is not a
// fallback here, it is what a good half of people will actually read.
//
// The HTML is deliberately dull. Tables, inline styles, one image, no web
// fonts, no media queries doing anything load-bearing. Every email client is a
// different browser from 2009 and the ones that are not still strip <style>
// blocks. The rules that shape all of this:
//
//   - It has to read correctly with images turned off, which is the default in
//     a lot of clients. So the wordmark is text beside the logo, never inside
//     it, and no image carries meaning on its own.
//   - It has to read correctly as plain text, because that is what a watch, a
//     screen reader and a text client will show.
//   - It says who it is about and what to do, above the fold, in one sentence.
//   - Exactly one thing to press.
import { BRAND } from "../shared/brand.mjs";

const esc = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

// A link somebody types into a mail client is a link they cannot check, so
// every URL we put in an email is built from APP_URL and a path we wrote.
const appUrl = () =>
  (process.env.APP_URL || "https://tameduck.com").replace(/\/+$/, "");
const siteUrl = () => (process.env.SITE_URL || appUrl()).replace(/\/+$/, "");

// Where the picture comes from, which is not the same question as where the
// links go.
//
// A link is opened by the person, on the machine they are sitting at, so
// pointing it at whatever address they are using is right - including a
// loopback one while somebody is developing. A picture is fetched by their
// mail client, from wherever that is, and http://127.0.0.1:3065/brand/
// mark-email.png is a broken square in every inbox on earth. Every message
// this server sent from a test run had one.
//
// So the picture comes from an address the public internet can reach, and an
// address that obviously is not one never gets used for it.
const PUBLIC_SITE = "https://tameduck.com";
const onlyReachableFromHere = (url) =>
  /^https?:\/\/(localhost|127\.|0\.0\.0\.0|\[?::1\]?|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(
    url,
  );
const pictureUrl = () => {
  const chosen = siteUrl();
  return onlyReachableFromHere(chosen) ? PUBLIC_SITE : chosen;
};

// The blocks a message is made of. Nothing clever: a paragraph, a button, a
// line of small print, a rule.
export const p = (text) => ({ kind: "p", text });
// `bare` is for the message whose whole point is the address: in plain text
// it prints the URL alone, because "Open TameDuck:" under a line that already
// said that is one line of nothing.
// `wide` fills the card, for the message that is nothing but this button.
export const button = (text, href, { bare = false, wide = false } = {}) => ({
  kind: "button",
  text,
  href,
  bare,
  wide,
});
export const small = (text) => ({ kind: "small", text });
// A short list of lines, for a message that is about several things at once.
export const list = (items) => ({ kind: "list", items });
export const rule = () => ({ kind: "rule" });
// Amounts, one per line, label on the left and the figure on the right: what
// was charged, the VAT, the total. `strong` is the line that matters.
export const rows = (items) => ({ kind: "rows", items });
// Who is talking, as a face with a name beside it. The name is text, so with
// pictures off it still says who this is from. `picture` is a path on the
// site, fetched from the same public address as the logo.
export const sender = (name, detail, picture) => ({
  kind: "sender",
  name,
  detail,
  picture,
});

const textOf = (block) => {
  const bare = block.bare;
  if (block.kind === "button")
    // The address in full, on its own line. A bare URL is the one thing every
    // client makes clickable, and the one thing a person can read before they
    // trust it.
    return bare ? block.href : `${block.text}:\n${block.href}`;
  if (block.kind === "rule") return "—";
  if (block.kind === "rows")
    return block.items.map((r) => `${r.label}: ${r.value}`).join("\n");
  if (block.kind === "list")
    return block.items
      .map((i) =>
        typeof i === "string" ? "- " + i : "- " + i.text + "\n  " + i.href,
      )
      .join("\n");
  // The From line already says who it is, and a plain part is read top to
  // bottom: a name on its own line would be the first thing heard.
  if (block.kind === "sender") return "";
  return block.text;
};

// Every block keeps the space below it except the last one in the card. The
// card has padding of its own, and a block that also leaves room under itself
// doubles it: a button last in a message sat on 56px of nothing, which read as
// the email having lost its ending.
const htmlOf = (block, last) => {
  const below = (px) => (last ? 0 : px);
  if (block.kind === "button" && block.wide)
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 ${below(22)}px"><tr><td align="center" style="background:${BRAND.yellow};border-radius:12px"><a href="${esc(block.href)}" style="display:block;padding:15px 22px;font-family:${BRAND.font};font-size:16px;font-weight:700;color:${BRAND.ink};text-decoration:none;text-align:center">${esc(block.text)}</a></td></tr></table>`;
  if (block.kind === "button")
    return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:26px 0 ${below(26)}px"><tr><td style="background:${BRAND.yellow};border-radius:12px"><a href="${esc(block.href)}" style="display:inline-block;padding:13px 22px;font-family:${BRAND.font};font-size:16px;font-weight:700;color:${BRAND.ink};text-decoration:none">${esc(block.text)}</a></td></tr></table>`;
  if (block.kind === "sender")
    return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 ${below(18)}px"><tr><td style="padding-right:12px;vertical-align:middle"><img src="${esc(pictureUrl() + block.picture)}" width="48" height="48" alt="" style="display:block;border:0;border-radius:11px;background:${BRAND.yellow}"></td><td style="vertical-align:middle"><p style="margin:0;font-family:${BRAND.font};font-size:16px;font-weight:700;line-height:1.3;color:${BRAND.ink}">${esc(block.name)}</p><p style="margin:0;font-family:${BRAND.font};font-size:13px;line-height:1.4;color:${BRAND.muted}">${esc(block.detail)}</p></td></tr></table>`;
  if (block.kind === "rule")
    return `<div style="border-top:1px solid ${BRAND.line};margin:26px 0 ${below(26)}px"></div>`;
  if (block.kind === "rows")
    return (
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 ${below(18)}px;border:1px solid ${BRAND.line};border-radius:12px;background:${BRAND.paper}">` +
      block.items
        .map(
          (r) =>
            `<tr><td style="padding:${r.strong ? "10px" : "6px"} 16px;font-family:${BRAND.font};font-size:${r.strong ? 16 : 14}px;line-height:1.5;color:${r.muted ? BRAND.muted : BRAND.ink};${r.strong ? "font-weight:700;border-top:1px solid " + BRAND.line + ";" : ""}">${esc(r.label)}</td><td align="right" style="padding:${r.strong ? "10px" : "6px"} 16px;font-family:${BRAND.font};font-size:${r.strong ? 16 : 14}px;line-height:1.5;color:${r.muted ? BRAND.muted : BRAND.ink};white-space:nowrap;${r.strong ? "font-weight:700;border-top:1px solid " + BRAND.line + ";" : ""}">${esc(r.value)}</td></tr>`,
        )
        .join("") +
      `</table>`
    );
  if (block.kind === "list")
    return (
      `<ul style="margin:0 0 ${below(18)}px;padding:0 0 0 20px">` +
      block.items
        .map(
          (i, n) =>
            `<li style="margin:0 0 ${n === block.items.length - 1 ? 0 : 8}px;font-family:${BRAND.font};font-size:15px;line-height:1.5;color:${BRAND.ink}">${
              typeof i === "string"
                ? esc(i)
                : `<a href="${esc(i.href)}" style="color:${BRAND.ink}">${esc(i.text)}</a>`
            }</li>`,
        )
        .join("") +
      `</ul>`
    );
  if (block.kind === "small")
    return `<p style="margin:0 0 ${below(14)}px;font-family:${BRAND.font};font-size:13px;line-height:1.6;color:${BRAND.muted}">${esc(block.text)}</p>`;
  return `<p style="margin:0 0 ${below(16)}px;font-family:${BRAND.font};font-size:16px;line-height:1.6;color:${BRAND.ink}">${esc(block.text)}</p>`;
};

// Why this arrived, at the bottom of the message itself rather than down in
// the small print. It is about this email - who asked for it, or which company
// it came from - so it belongs with the email, and down among the copyright
// and the settings link it read as boilerplate nobody is meant to read.
const reasonHtml = (reason) =>
  `<p style="margin:24px 0 0;padding-top:16px;border-top:1px solid ${BRAND.line};font-family:${BRAND.font};font-size:12px;line-height:1.6;color:${BRAND.muted}">${esc(reason)}</p>`;

// Why this arrived and how to stop it, on every message that is not the way in
// itself. A person who cannot find that is a person who marks us as spam, and
// one spam report is worth more than any number of opens.
function footer({ settingsUrl }) {
  const site = siteUrl();
  // The name as a person would type it, so the address under the thank-you
  // reads as somewhere to go rather than as configuration.
  const domain = site.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  // Taken from the clock rather than written down. A year in a footer is the
  // one thing in a product that is certain to be wrong on the first of
  // January, and nobody notices until a customer does.
  const year = new Date().getFullYear();
  const small12 = `margin:0;font-family:${BRAND.font};font-size:12px;line-height:1.6;color:${BRAND.muted}`;

  const parts = [`Thank you for using TameDuck.\n${site}`];
  if (settingsUrl) parts.push(`Choose which emails you get: ${settingsUrl}`);
  parts.push(`\u00a9 ${year} TameDuck`);

  const html =
    `<div style="border-top:1px solid ${BRAND.line};margin-top:30px;padding-top:20px">` +
    // The mark and the thank-you on one line, laid out as a table because a
    // mail client from 2009 will not line up anything else.
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 14px"><tr>` +
    `<td style="padding-right:10px;vertical-align:middle">` +
    `<a href="${esc(site)}"><img src="${esc(pictureUrl())}/brand/mark-email.png" width="22" height="22" alt="" style="display:block;border:0;border-radius:7px"></a>` +
    `</td><td style="vertical-align:middle">` +
    `<p style="${small12};color:${BRAND.ink}">Thank you for using TameDuck.</p>` +
    `<p style="${small12}"><a href="${esc(site)}" style="color:${BRAND.violet}">${esc(domain)}</a></p>` +
    `</td></tr></table>` +
    (settingsUrl
      ? `<p style="${small12};margin-bottom:6px"><a href="${esc(settingsUrl)}" style="color:${BRAND.violet}">Choose which emails you get</a></p>`
      : "") +
    `<p style="${small12};margin-top:14px">\u00a9 ${year} TameDuck</p>` +
    `</div>`;
  return { text: parts.join("\n\n"), html };
}

// A message a duck sends in its own name carries its own face, so the wordmark
// on top would be a second sender, and a thank-you "for using TameDuck" to
// somebody who has not started yet reads as a form letter. Only the address
// stays, as somewhere to go.
function siteOnly() {
  const site = siteUrl();
  const domain = site.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  return {
    text: site,
    html: `<p style="margin:16px 0 0;font-family:${BRAND.font};font-size:12.5px;line-height:1.6;color:${BRAND.muted}"><a href="${esc(site)}" style="color:${BRAND.muted}">${esc(domain)}</a></p>`,
  };
}

// The whole message. `preheader` is the line a phone shows under the subject
// before anything is opened; left out, clients quietly use the first words of
// the logo's alt text, which reads like a bug.
export function render({
  subject,
  preheader,
  blocks,
  settingsUrl,
  reason,
  personal = false,
}) {
  const foot = personal ? siteOnly() : footer({ settingsUrl });
  const text = [
    ...blocks.map((b) => textOf(b)),
    ...(reason ? [reason] : []),
    "—",
    foot.text,
  ]
    .join("\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const site = siteUrl();
  const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<title>${esc(subject)}</title>
</head>
<body style="margin:0;padding:0;background:${BRAND.paper}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(preheader || "")}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${BRAND.paper}">
<tr><td align="center" style="padding:28px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;width:100%">
${
  personal
    ? ""
    : `<tr><td style="padding-bottom:22px">
  <a href="${esc(site)}" style="text-decoration:none;color:${BRAND.ink}">
    <img src="${esc(pictureUrl())}/brand/mark-email.png" width="34" height="34" alt=""
         style="vertical-align:middle;border:0;border-radius:10px">
    <span style="font-family:${BRAND.font};font-size:21px;font-weight:700;letter-spacing:-0.03em;color:${BRAND.ink};vertical-align:middle;padding-left:9px">TameDuck</span>
  </a>
</td></tr>
`
}<tr><td style="background:#ffffff;border:1px solid ${BRAND.line};border-radius:16px;padding:30px">
${blocks.map((b, i) => htmlOf(b, i === blocks.length - 1)).join("\n")}${reason ? "\n" + reasonHtml(reason) : ""}
</td></tr>
<tr><td>${foot.html}</td></tr>
</table>
</td></tr></table>
</body></html>`;
  return { subject, text, html };
}
