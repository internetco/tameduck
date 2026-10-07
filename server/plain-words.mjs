// What a duck writes on a ticket or a board is read by people, and people can
// do nothing with the ids and codes the duck works with. Chief Duck wrote
// "site.eu connection ca661bbd-1add-4810-98f5-3b65d6bfebac returned AUTH_004
// on tool discovery" as the description of a ticket somebody was meant to act
// on. The prompt asks for plain words; this is the part that can be checked,
// so it is checked: a raw id or an error code sends the text back to the duck
// with a sentence saying what to write instead.

// A bare id. One inside a web address is part of the address, and stays.
const rawId =
  /(?<![\w/.=-])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![\w-])/i;
// An error code such as AUTH_004.
const code = /\b[A-Z]{2,}_\d{2,}\b/;

// Why these words cannot go in front of people, or null when they can.
export function notForPeople(fields) {
  for (const [label, value] of Object.entries(fields)) {
    const words = String(value ?? "");
    if (rawId.test(words))
      return `The ${label} is read by people and has an internal ID in it. Name the thing instead ("the site.eu connection", "the saved brief") and write it in plain words.`;
    const found = words.match(code);
    if (found)
      return `The ${label} is read by people and has an error code in it (${found[0]}). Say what went wrong in plain words ("the site.eu connection stopped working") instead.`;
  }
  return null;
}
