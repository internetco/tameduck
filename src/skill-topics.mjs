// How the Skills library sorts a thousand skills for somebody who runs a
// bakery rather than a codebase. Kept apart from the page so it can be read
// and checked without a browser.

// The topics a business reaches for, in the order they are offered, each with
// a few of its skills to say what is inside. Hand-kept: the catalogue says
// which topic a skill is in, not who it is for. Everything else is for
// software teams and sits behind one quiet tile at the end.
export const BUSINESS_TOPICS = [
  {
    name: "Writing & Communication",
    examples: ["Social Content", "Email Marketing", "Copy Editing"],
  },
  {
    name: "Marketing",
    examples: ["Marketing Plan", "Content Strategy", "Events"],
  },
  {
    name: "Sales & Growth",
    examples: ["Offer Design", "Pricing & Packaging", "Referral Programs"],
  },
  {
    name: "Research & Planning",
    examples: ["Customer Research", "Decision Questionnaire"],
  },
  {
    name: "SEO & Discovery",
    examples: ["AI Search Optimization", "Site Architecture"],
  },
];
const business = new Set(BUSINESS_TOPICS.map((t) => t.name));
export const isBusinessTopic = (name) => business.has(name);

// The address of a topic: /skills/topic/writing-communication.
export const topicSlug = (name) =>
  String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
// The tile that holds every topic for programmers has an address of its own.
export const SOFTWARE = "software";

// The catalogue files these under a business topic with nothing to set up,
// but each is about a codebase: it reads the project's code, writes files
// into it, or builds an app. Hand-kept, like the topics above.
const FOR_CODE = {
  "getsentry--skills--blog-writing-guide": "agent",
  "getsentry--skills--document-api-endpoint": "agent",
  "getsentry--skills--presentation-creator": "computer",
  "github--awesome-copilot--documentation-writer": "agent",
  "github--awesome-copilot--create-architectural-decision-record": "agent",
  "github--awesome-copilot--create-readme": "agent",
  "github--awesome-copilot--create-specification": "agent",
  "github--awesome-copilot--create-implementation-plan": "agent",
  "obra--superpowers--brainstorming": "agent",
};
// The one thing a skill can need that a duck does not have. "playbook" is a
// skill a duck can follow with nothing but the conversation.
export const needOf = (skill) =>
  (Object.hasOwn(FOR_CODE, skill.id) && FOR_CODE[skill.id]) ||
  skill.requirements;
export const worksAsIs = (skill) => needOf(skill) === "playbook";
export const NEEDS = {
  playbook: "Works as is. No computer or account needed.",
  computer: "Needs a computer to work on.",
  service: "Needs a connected account, and maybe a computer.",
  agent: "Made for coding tools a duck may not have.",
};
// The same, in the few words a row in a list has room for.
export const NEEDS_SHORT = {
  playbook: "Works as is",
  computer: "Needs a computer",
  service: "Needs a connected account",
  agent: "Made for coding tools",
};

// Every licence in the catalogue lets a company use a skill and change it for
// itself. Its name (MIT, Apache-2.0) means nothing to the person choosing.
const OPEN = new Set([
  "MIT",
  "Apache-2.0",
  "BSD-3-Clause",
  "MPL-2.0",
  "CC-BY-SA-4.0",
]);
export const licenceWords = (licence) =>
  OPEN.has(licence) ? "Free to use and change." : "Shared under its own terms.";

export const count = (n) => Number(n).toLocaleString("en-US");

// "16 of 34 work as is", "All 14 work as is", "None of 120 work as is".
export function worksAsIsLine(ready, total) {
  if (total && ready === total)
    return (
      "All " + count(total) + (total === 1 ? " works" : " work") + " as is"
    );
  if (!ready) return "None of " + count(total) + " work as is";
  return (
    count(ready) +
    " of " +
    count(total) +
    (ready === 1 ? " works" : " work") +
    " as is"
  );
}

// One tile per topic: its name, its address, how many of its skills work as
// is, and a few names from it. The business topics come first, in their own
// order; the rest are counted into the software tile, and listed on its page
// by name.
export function topicTiles(skills) {
  const byTopic = new Map();
  for (const s of skills) {
    if (!byTopic.has(s.category)) byTopic.set(s.category, []);
    byTopic.get(s.category).push(s);
  }
  const tile = (name, list, examples) => ({
    name,
    slug: topicSlug(name),
    total: list.length,
    ready: list.filter(worksAsIs).length,
    examples,
  });
  const names = new Set(skills.map((s) => s.name));
  const shown = BUSINESS_TOPICS.filter((t) => byTopic.has(t.name)).map((t) =>
    tile(
      t.name,
      byTopic.get(t.name),
      // A skill that has left the catalogue drops out of its tile's examples.
      t.examples.filter((e) => names.has(e)),
    ),
  );
  const software = [...byTopic.keys()]
    .filter((name) => !isBusinessTopic(name))
    .sort((a, b) => a.localeCompare(b))
    .map((name) => {
      const list = byTopic.get(name);
      return tile(
        name,
        list,
        [...list.filter(worksAsIs), ...list.filter((s) => !worksAsIs(s))]
          .slice(0, 3)
          .map((s) => s.name),
      );
    });
  return {
    business: shown,
    software,
    softwareSkills: software.reduce((n, t) => n + t.total, 0),
  };
}

// A topic's skills, the ones that work as is first, each group in the
// catalogue's own order.
export function topicSkills(skills, slug) {
  const list = skills.filter((s) => topicSlug(s.category) === slug);
  return {
    name: list[0]?.category || null,
    ready: list.filter(worksAsIs),
    needs: list.filter((s) => !worksAsIs(s)),
  };
}

// Every word of the search somewhere in the skill, the ones that work as is
// first.
export function searchSkills(skills, query) {
  const words = String(query || "")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return [];
  const found = skills.filter((s) => {
    const text =
      `${s.name} ${s.description} ${s.category} ${s.publisher}`.toLowerCase();
    return words.every((w) => text.includes(w));
  });
  return [...found.filter(worksAsIs), ...found.filter((s) => !worksAsIs(s))];
}

// "Add for Writer Duck", "Add for Writer Duck and Chief Duck", "Add for 3
// ducks". Nothing ticked still adds the skill, for no duck yet.
export function addLabel(names) {
  if (!names.length) return "Add to library";
  if (names.length === 1) return "Add for " + names[0];
  if (names.length === 2) return "Add for " + names[0] + " and " + names[1];
  return "Add for " + names.length + " ducks";
}

// Who has a skill, inside a sentence: "Chief Duck and Writer Duck lose it".
export function namesLine(names) {
  if (names.length <= 1) return names.join("");
  if (names.length <= 3)
    return names.slice(0, -1).join(", ") + " and " + names[names.length - 1];
  return names.slice(0, 2).join(", ") + " and " + (names.length - 2) + " more";
}

// Who has a skill, in the few words a row has room for.
export function whoLine(names) {
  if (!names.length) return "No duck yet";
  if (names.length <= 3) return names.join(", ");
  return names.slice(0, 2).join(", ") + " and " + (names.length - 2) + " more";
}
