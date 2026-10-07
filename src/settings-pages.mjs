// Settings as one list in two groups: your own things, then the company's
// under its own name. Who may open each page is written here once, because
// the menu that offers a page and the address that opens it must give the same
// answer. A member used to land on AI connection, a page that told them only
// the owner could change it.
//
// How a settings page saves, so the next page does it the same way. A switch,
// a pick or a press saves the moment you make it. Where the control cannot
// show what changed, because it is a pick in a list or a press that changes
// many things, a line under it says what is now true, with Undo. A switch is
// its own undo: flip it back. Where you type (a name, rules, a key), there is
// a form with one Save at its foot, and the page's intro says so. Anything
// that cannot be undone asks first, in the app's own dialog, never the
// browser's.
import { canConnectAI } from "../shared/ai-access.mjs";

const pages = [
  {
    id: "account",
    group: "you",
    name: "Your account",
    intro: () =>
      "Who you are, how long ducks wait for you, and signing in. Changes save straight away.",
  },
  {
    id: "emails",
    group: "you",
    name: "Emails",
    intro: () =>
      "What we email you when you are away, in every company you are in. Changes save straight away.",
  },
  {
    id: "appearance",
    group: "you",
    name: "Theme",
    intro: () =>
      "How TameDuck looks in this browser. Changes save straight away.",
  },
  {
    id: "notifications",
    group: "you",
    name: "Notifications",
    intro: () =>
      "Choose whether this browser may notify you about Duck updates.",
  },
  {
    id: "company",
    group: "company",
    name: "Company",
    may: (p) => !!p.company,
    intro: () =>
      "The name, clock and rules every duck works by. Make your changes, then press Save.",
  },
  {
    id: "ai",
    group: "company",
    name: "AI connection",
    // The rule the server and every "Connect AI" button use. Anybody else
    // could only read that somebody else changes it.
    may: (p, role) => canConnectAI(role, p),
    intro: () =>
      "The AI your ducks think with, and the plan or key that pays for it.",
  },
  {
    id: "ducks",
    group: "company",
    name: "Ducks",
    may: (p) => !!p.ducks,
    intro: () =>
      "What each duck may do on its own. Changes save straight away.",
  },
  {
    id: "work-limits",
    group: "company",
    name: "Work limits",
    may: (p) => !!p.company,
    intro: () =>
      "Set work limits and automatic resume for your company and ducks; press Save.",
  },
  {
    id: "connections",
    group: "company",
    name: "Connections",
    may: (p) => !!p.integrations,
    intro: () =>
      "Outside tools your ducks can use, and which ducks may use each one.",
  },
  {
    id: "secrets",
    group: "company",
    name: "Secrets",
    may: (p) => !!p.integrations,
    intro: () =>
      "Passwords and keys the whole company shares, and which ducks may use each one.",
  },
  {
    id: "billing",
    group: "company",
    name: "Billing",
    // "Pay the bills". Everybody used to see it, and a member could do
    // nothing there.
    may: (p) => !!p.billing,
    intro: () => "Your company’s TameDuck plan, and how it is paid.",
  },
  {
    id: "storage",
    group: "company",
    name: "Storage",
    may: (p) => !!(p.company || p.billing),
    intro: () =>
      "How much space your company’s work takes up, and what uses it.",
  },
  {
    id: "usage",
    group: "company",
    name: "Computer use",
    may: (p) => !!(p.company || p.billing),
    intro: () =>
      "Computer time, starts, and proxy traffic. At a computer limit no new computers start; running ones carry on.",
  },
  {
    id: "activity",
    group: "company",
    name: "Activity log",
    // The log names the secrets and the connections, so it goes only to
    // somebody who may manage them.
    may: (p) => !!p.integrations,
    intro: (company) =>
      "What people and ducks did at " + company + ", newest first.",
  },
];

// Where Settings opens, and where a page somebody may not use sends them: the
// first page in the list, which everybody may use.
export const HOME = "account";
export const PAGE_IDS = pages.map((page) => page.id);
export const settingsPage = (id) => pages.find((page) => page.id === id);
export const isCommunityEdition = (person) =>
  person?.distribution?.edition === "community" ||
  person?.edition === "community";

// `person` is the app's state: role, permissions and company.
export const mayOpen = (id, person) => {
  if (id === "billing" && isCommunityEdition(person)) return false;
  const page = settingsPage(id);
  return (
    !!page && (!page.may || page.may(person.permissions || {}, person.role))
  );
};
export const pageFor = (id, person) => (mayOpen(id, person) ? id : HOME);

// The menu: You, then the company under its own name, each with only the
// pages this person may use. A group with nothing in it is left out.
export const settingsMenu = (person) =>
  [
    { key: "you", label: "You" },
    { key: "company", label: person.company.name },
  ]
    .map((group) => ({
      ...group,
      pages: pages.filter(
        (page) => page.group === group.key && mayOpen(page.id, person),
      ),
    }))
    .filter((group) => group.pages.length);
