// Setting up a brand-new company.
//
// Somebody who has just opened the link in their email has a company named
// after their email domain, a display name guessed from the part before the @,
// a clock set to wherever this server happens to be, and no AI - so no duck
// can answer them. The two screens in src/Onboarding.jsx fix all four before
// they reach the app, and this is what the second one posts.
//
// It runs once per company and only for its owner. Somebody invited to a
// company that already exists is not asked to name it.
import { z } from "zod";
import {
  db,
  one,
  all,
  run,
  now,
  fail,
  audit,
  emit,
  permissions,
} from "./store.mjs";
import { knownTimezone } from "../shared/schedule-times.mjs";
import { configSummary, defaultModel, pointDucksAt } from "./ai-config.mjs";
import { isSubscription, providerName } from "../shared/ai-providers.mjs";

const text = z.string().trim();

// Whether a duck could actually answer: a key, or a ChatGPT sign-in.
//
// It used to be a key and nothing else. configSummary only ever calls an API
// key "configured"; a sign-in is a subscription and never is. So an owner who
// chose ChatGPT - the option the second screen shows first and calls the
// easiest - watched the finish button open, because the browser counted the
// sign-in, pressed it, and was told by the server to connect an AI.
//
// A key is looked at first because it is a row in the database. Whether the
// sign-in is live can only be asked of a running Codex process, so that is
// only done when there is no key to go on - and it is passed in, so a test can
// say which it is without starting one.
//
// runtime.mjs is fetched when it is asked for, not imported at the top. It
// brings the whole of the duck machinery with it, something in which keeps a
// process alive, and imported here it left tests/onboarding.test.mjs passing
// every test and then never exiting - which would have hung `npm test` for
// everybody. The server has it loaded already, so asking costs nothing there.
const chatgptSignedIn = async (company) => {
  const { codexStatus } = await import("./runtime.mjs");
  return (await codexStatus(company)).connected;
};
// Not whether an AI is connected, but whether the one the ducks are set to use
// is. Those came apart for a second company: the owner's key is kept for all
// their companies, but only the first was pointed at it, so the second one's
// ducks stayed on a ChatGPT plan nobody had signed in to. "Any AI is connected"
// let that through, and no duck in it could answer.
async function ducksCanAnswer(company, signedIn) {
  const { provider } = defaultModel(company);
  if (isSubscription(provider)) return !!(await signedIn(company));
  return configSummary(company).providers.some(
    (p) => p.id === provider && p.configured,
  );
}

// A new company whose owner already pays for an AI with a key is pointed at
// that key - when nobody has chosen anything for it, and when the ChatGPT plan
// it would otherwise use is not signed in. Otherwise its second screen opens
// on a warning about a plan they never signed up for, beside the key they did
// connect. A choice already made is never moved: pointDucksAt refuses to.
// Nothing is asked of ChatGPT when there is no key to point at anyway.
export async function pointAtWhatTheyPayFor(company, user, signedIn = chatgptSignedIn) {
  const key = configSummary(company).providers.find((p) => p.configured);
  if (!key) return false;
  if (await ducksCanAnswer(company, signedIn)) return false;
  return pointDucksAt(company, user, key.id);
}

// A company is only its owner's to set up, and only until it is set up.
function owning(company, user) {
  const member = one(
    "SELECT * FROM memberships WHERE company_id=? AND user_id=?",
    company,
    user,
  );
  if (!member || member.role !== "owner")
    fail(403, "Only the person who started this company can set it up.");
  if (one("SELECT onboarded_at FROM companies WHERE id=?", company)?.onboarded_at)
    fail(409, "This company has already been set up.");
}

// The first screen. Answered in one go, because a half-answered company -
// named but with no clock, or with rules but still called "Gmail" - is worse
// than one that has not started. Answering it again overwrites, so closing the
// tab halfway and coming back costs nothing.
//
// details_at says it has been answered. Without it a new tab or another device
// could not tell typed answers from guesses, so it opened on this screen again
// and called them guesses.
export function details(company, user, input) {
  const a = z
    .object({
      name: text.min(1).max(100),
      company: text.min(1).max(100),
      rules: z.string().trim().max(60000),
      timezone: text.min(1).max(64),
    })
    .parse(input);
  if (!knownTimezone(a.timezone))
    fail(400, "That is not a time zone this server knows.");
  owning(company, user);
  db.transaction(() => {
    run("UPDATE users SET name=? WHERE id=?", a.name, user);
    run(
      "UPDATE companies SET name=?,rules=?,timezone=?,details_at=? WHERE id=?",
      a.company,
      a.rules,
      a.timezone,
      now(),
      company,
    );
  })();
  emit(company);
  return { ok: true, company: one("SELECT * FROM companies WHERE id=?", company) };
}

// The second screen, and the end of the flow. A company is not marked ready
// because somebody pressed a button - it is marked ready when a duck could
// actually answer, which is the whole reason the screen before it exists. So
// the check is here as well as in the browser: the screen can be got around,
// and a workspace whose ducks cannot answer is not one to let anybody into.
export async function ready(company, user, signedIn = chatgptSignedIn) {
  owning(company, user);
  if (!(await ducksCanAnswer(company, signedIn)))
    fail(
      409,
      configSummary(company).providers.some((p) => p.configured)
        ? "Your ducks are set to use " +
            providerName(defaultModel(company).provider) +
            ", which is not connected. Choose one you have connected under What ducks use, then finish."
        : "Connect an AI first. No duck can answer until you have.",
    );
  run(
    "UPDATE companies SET onboarded_at=? WHERE id=? AND onboarded_at IS NULL",
    now(),
    company,
  );
  audit(company, user, "Company set up", one("SELECT name FROM companies WHERE id=?", company)?.name || "");
  await settle(company, user, signedIn);
  emit(company);
  return { ok: true, company: one("SELECT * FROM companies WHERE id=?", company) };
}

// Chief Duck's welcome asks the new owner to connect an AI, and it is right to
// until they have. Once they have, leaving it on their list is asking for
// something that is already done. It is taken off the same way the person
// would take it off themselves - the state the "Take off my list" button uses
// - rather than by inventing a state the rest of the product does not know.
// Nothing connected and it stays exactly where it was, which is the way back
// for anybody who leaves halfway.
export async function settle(company, user, signedIn = chatgptSignedIn) {
  if (!(await ducksCanAnswer(company, signedIn))) return;
  run(
    "UPDATE inbox SET state='ignored' WHERE user_id=? AND state='pending' AND message_id IN " +
      "(SELECT id FROM messages WHERE company_id=? AND needs_you LIKE '%AI%')",
    user,
    company,
  );
  // The message itself as well, not only the list. The welcome is written when
  // the company is made, before setup, and it asks for the two things setup has
  // just done - what the company does, and an AI - under a Needs you badge. So
  // the first thing a new owner saw after setup was Chief Duck asking for an AI
  // they had just connected, which reads as setup having failed. Only the
  // welcome as it was written is changed: the one from Chief Duck, still
  // carrying that request. Anything a person or a duck wrote is left alone.
  run(
    "UPDATE messages SET body=?,needs_you=NULL WHERE company_id=? AND needs_you LIKE '%AI%' " +
      "AND body LIKE '%connect an AI account%' " +
      "AND duck_id IN (SELECT id FROM ducks WHERE company_id=? AND chief=1)",
    "Hey, I’m Chief Duck. Welcome to your flock! 🦆\n\n" +
      "What would you like to get off your plate first? I can turn it into a plan, bring in specialist ducks, and keep the work moving.",
    company,
    company,
  );
}

// signedIn is there for the test, which drives these routes over HTTP and must
// be able to say whether the owner is signed in to ChatGPT without a real
// Codex process being started to find out. The server passes nothing.
export function registerOnboarding(app, { signedIn = chatgptSignedIn } = {}) {
  // No permission check beyond owner on either: these run before anybody has
  // had the chance to be given or refused anything.
  app.post("/api/onboarding", async (req, res) => {
    const answered = details(req.company.id, req.user.id, req.body);
    // The second screen comes next, so this is when a new company is pointed
    // at what its owner already pays for, and it opens on "Connected".
    if (await pointAtWhatTheyPayFor(req.company.id, req.user.id, signedIn))
      emit(req.company.id);
    res.json(answered);
  });
  app.post("/api/onboarding/ready", async (req, res) => {
    res.json(await ready(req.company.id, req.user.id, signedIn));
  });
}
// Reached through the function that registers them, so the flow is one thing
// to import and one thing to mock.
registerOnboarding.details = details;
registerOnboarding.ready = ready;
registerOnboarding.settle = settle;
registerOnboarding.pointAtWhatTheyPayFor = pointAtWhatTheyPayFor;
