// Who may connect this company's AI: add or remove a key, and choose the model
// every duck uses. The owner, and an admin who still has "Connect outside
// tools, and see the keys". A member given that switch can connect GitHub, but
// not the company's AI. Signing in with a ChatGPT plan stays the owner's
// alone: it is their own account, and every company they own runs on it.
//
// Written once, because the server that refuses and the screens that offer
// the button have to give the same answer.
export const canConnectAI = (role, permissions) =>
  role === "owner" || (role === "admin" && !!permissions?.integrations);

// Who to ask, for somebody who cannot connect one: everybody who can, by name,
// the owner first. Not "an admin": an admin can be one who cannot.
export function whoConnectsAI(members = []) {
  const names = members
    .filter((m) => m.connects_ai && m.name)
    .sort((x, y) => (y.role === "owner") - (x.role === "owner"))
    .map((m) => m.name);
  return names.length ? anyOf(names) : "the company owner";
}
const anyOf = (names) =>
  names.length === 1
    ? names[0]
    : names.slice(0, -1).join(", ") + " or " + names[names.length - 1];

// Who can fix a connection that has dropped, as a sentence without its full
// stop, and where when the person is not already there. Only the ChatGPT
// sign-in can be down, and only the owner signs in to it again: a member used
// to be told an admin could reconnect it, and the admin's own screen says
// they cannot. What an admin can do is connect another AI in its place.
export function whoFixesDown(members = [], where = "") {
  const owner = members.find((m) => m.role === "owner" && m.name)?.name,
    admins = members
      .filter((m) => m.connects_ai && m.role !== "owner" && m.name)
      .map((m) => m.name);
  return (
    (owner || "The company owner") +
    " can reconnect it" +
    where +
    (admins.length ? ", or " + anyOf(admins) + " can connect another AI" : "")
  );
}

// Whether the company's AI was connected and has stopped answering for now,
// rather than never connected at all. The server says connected:false for
// both; only a sign-in that is still there but cannot be reached comes back
// with `down` beside it. Telling that company "nobody has connected an AI" was
// untrue, and sent people off to connect something they already had.
export const aiDown = (status) =>
  status?.connected === false && !!(status.down || status.codex?.down);

const downWords = "Your AI connection isn't working right now";

// What a duck's chat shows over the message box while no duck can work: a
// title, the line under it, and whether this person is the one who can fix it
// (only they get a button). A member is told who can, by name, and never to do
// it themselves: they cannot.
export function withoutDuckAI(status, { role, permissions, members }) {
  const fixes = canConnectAI(role, permissions),
    who = whoConnectsAI(members);
  if (aiDown(status))
    return {
      fixes,
      title: downWords + ".",
      line: fixes
        ? "Ducks can't answer until it works again."
        : "Ducks can't answer until it works again. " +
          whoFixesDown(members, " in Settings") +
          ".",
    };
  return {
    fixes,
    title: "Ready when you are.",
    line: fixes
      ? "Connect an AI provider to start working together."
      : "Nobody has connected an AI yet, so no duck can work. Ask " +
        who +
        " to connect one.",
  };
}

// What pressing Send, Retry or "Ask duck to work" answers while no duck can
// work. The same facts as the chat's banner, said as one sentence.
export function duckRefusal(status, { role, permissions, members }) {
  const fixes = canConnectAI(role, permissions),
    who = whoConnectsAI(members);
  if (aiDown(status))
    return (
      downWords +
      ", so ducks can't answer. " +
      (fixes
        ? "Check it in Settings → AI connection."
        : whoFixesDown(members, " in Settings") + ".")
    );
  return fixes
    ? "Connect an AI provider in Settings → AI connection to ask a duck."
    : "Nobody has connected an AI yet, so no duck can work. Ask " +
        who +
        " to connect one.";
}

// What the computer screens say in place of Start while no AI is connected.
export const withoutAIWords = (data) =>
  canConnectAI(data.role, data.permissions)
    ? "Connect an AI first. Without one no duck can work, so computers stay off."
    : "Nobody has connected an AI yet, so computers stay off. Ask " +
      whoConnectsAI(data.members) +
      " to connect one.";
