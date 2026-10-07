// What the AI connection page decides, kept apart from how it draws it so each
// decision can be tested without a browser.
import { isSubscription } from "../shared/ai-providers.mjs";
import { providerEnabled, modelVerified } from "../shared/ai-availability.mjs";

// The AIs a company can run on right now: the plan if its owner has signed in,
// and every key provider that has a key.
export const connectedAIs = (rows, planConnected) =>
  rows.filter(
    (p) =>
      p.enabled !== false &&
      providerEnabled(p.id) &&
      (isSubscription(p.id) ? !!planConnected : p.configured),
  );

// What the two boxes under "What ducks use" show, and whether there is
// anything to save.
//
// Preserve unavailable saved choices so the person sees what needs changing.
// Choosing a different provider or model always requires an explicit action.
export function ducksChoice(saved, choice, offered, all = false) {
  const has = (id) =>
      providerEnabled(id) &&
      offered.some((p) => p.id === id && p.enabled !== false),
    usable = (value) =>
      has(value.provider) &&
      ((isSubscription(value.provider) && !value.model) ||
        modelVerified(value.provider, value.model)),
    // Preserve a saved unavailable choice so the UI can explain it.
    shown = choice;
  return {
    works: usable(saved),
    shown,
    dirty:
      all || shown.provider !== saved.provider || shown.model !== saved.model,
    // A key provider needs a named verified model; the plan can choose its own.
    ready: usable(shown),
  };
}

// A company with no key of its own runs on its owner's. Only the owner can
// take that one away, so a teammate is told whose it is instead of being
// offered a button the server will refuse. Replacing it still works for them:
// it gives this company a key of its own.
export const borrowedKey = (p, owner) =>
  !!p.configured && !p.company_key && !owner;

// One key can be serving several companies its owner has, and removing it
// takes it from all of them. That is only ever true of the owner: anybody
// else removing a key removes this company's and nothing more.
export const otherCompanies = (p, owner) =>
  owner && p.also_used_by > 0
    ? p.also_used_by === 1
      ? "one other company you own"
      : p.also_used_by + " other companies you own"
    : "";

// The one line under a connected key's name. It says only what is true.
export function keyLine(p, { owner, canManage, who }) {
  if (borrowedKey(p, owner))
    return (
      "Running on " +
      (who === "the owner" ? "the owner’s" : who + "’s") +
      " key." +
      (canManage ? " Only they can remove it." : "")
    );
  const others = otherCompanies(p, owner);
  return "Key saved" + (others ? ". It also runs " + others + "." : "");
}

// The line under the plan's name once it is connected: whose account and which
// plan for the owner, from what the sign-in really returned, and nothing about
// either for anybody else - the server does not tell them.
export function planLine(p, account, { owner, who }) {
  if (!owner)
    return "Set up by " + who + ". It runs the ducks for everyone here.";
  const plan = account?.planType;
  return [
    account?.email || "Your " + p.name + " account",
    plan && plan[0].toUpperCase() + plan.slice(1) + " plan",
  ]
    .filter(Boolean)
    .join(" · ");
}

// What the page opens with while the company's AI is connected but not
// answering. It used to open with "Nobody has connected an AI for this company
// yet", which was untrue, over a row offering to connect it. Each person is
// told what they themselves can do: the owner signs in again, an admin can
// add another AI, and everybody else is told who can fix it.
export function downLine({ owner, canManage, who, fixes }) {
  const said =
    "Your AI connection isn't working right now, so ducks can't answer. ";
  if (owner)
    return said + "Try connecting it again below, or connect another AI.";
  if (canManage)
    return (
      said +
      (who === "the owner" ? "The owner" : who) +
      " can reconnect it, or you can connect another AI below."
    );
  return said + fixes + ".";
}
