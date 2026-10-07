// Which ducks a connection's key lets in, and what to say about it.
//
// A connection names the ducks that may use it, and so does its key in
// Secrets. A duck on the first list and not on the second was refused at work
// ("This duck cannot use the selected secret") while the card said Connected,
// and Configure would not save, even with nothing changed. The server keeps
// the two lists in step and the screens say where they are not, so the rule
// and its words live here, once, like shared/plan.mjs.

// Stored lists are JSON text; a list may also come as an array.
const list = (v) => {
  try {
    return Array.isArray(v) ? v : JSON.parse(v || "[]");
  } catch {
    return [];
  }
};
export const joined = (names) =>
  names.length < 2
    ? names[0] || ""
    : names.slice(0, -1).join(", ") + " and " + names[names.length - 1];
const names = (ducks) => joined(ducks.map((d) => d.name));

// The ducks in `wanted` (ids) that `key` does not let in, as team ducks in the
// team's order. No key, nobody. A duck taken off the team is left out, as it
// is from every count of who uses something.
export const notOnKey = (team, key, wanted) => {
  if (!key) return [];
  const ids = list(wanted),
    allowed = list(key.allowed_ducks);
  return team.filter(
    (d) => !d.removed && ids.includes(d.id) && !allowed.includes(d.id),
  );
};

// Under the key's picker: where keys live, and who the chosen one lets in.
export const keyHint = (team, key) => {
  if (!key) return "From Secrets.";
  const allowed = list(key.allowed_ducks);
  const may = team.filter((d) => !d.removed && allowed.includes(d.id));
  return (
    "From Secrets. " +
    (may.length ? names(may) + " may use it." : "No duck may use it yet.")
  );
};

// What pressing Save (or Connect) will also do to the key.
export const alsoLets = (verb, ducks) =>
  `${verb} also lets ${names(ducks)} use this key.`;

export const keyRefusal = (keyName, ducks) =>
  `${keyName} does not allow ${names(ducks)}. Choose another key, or let ${ducks.length === 1 ? "it" : "them"} use this one in Secrets.`;

// "Used by GitHub and Linear" for a key's row in Secrets, or nothing.
export const usedBy = (connections, secretId) => {
  const tools = connections
    .filter((c) => c.secret_id === secretId)
    .map((c) => c.name);
  return tools.length ? "Used by " + joined(tools) : "";
};

export const keyInUse = (toolNames) =>
  joined(toolNames.map((n) => "“" + n + "”")) +
  (toolNames.length === 1
    ? " uses this key. Give it another key in Connections first."
    : " use this key. Give them another key in Connections first.");
