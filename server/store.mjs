import { avatarIds } from "../shared/avatars.mjs";
import { standInJob } from "../shared/duck-job.mjs";
import Database from "better-sqlite3";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { databaseFile, migrate } from "./migrate.mjs";
import { kindOf } from "./activity-words.mjs";
import { MAX_DUCKS } from "../shared/plan.mjs";
// No default folder, and the live one only from a deployed release: see
// databaseFile. The service sets DATA_DIR in /etc/tameduck.env.
const file = databaseFile();
export const DATA = process.env.DATA_DIR;
export const db = new Database(file);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.pragma("busy_timeout = 5000");
// Every table, index and trigger comes from server/migrations/.
migrate(db);
export const id = () => crypto.randomUUID();
export const now = () => new Date().toISOString();
export const token = () => crypto.randomBytes(32).toString("base64url");
export const hash = (s) => crypto.createHash("sha256").update(s).digest("hex");
// Every call site passes a constant SQL string with bound parameters, so the
// compiled statement is reusable and the cache stays bounded by the source.
// Re-compiling per call cost ~14x more, which the desktop stream paid per frame.
const statements = new Map();
function statement(sql) {
  let s = statements.get(sql);
  if (!s) {
    s = db.prepare(sql);
    statements.set(sql, s);
  }
  return s;
}
export const one = (sql, ...p) => statement(sql).get(...p);
export const all = (sql, ...p) => statement(sql).all(...p);
export const run = (sql, ...p) => statement(sql).run(...p);
export const json = (s) => {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
};
const scrypt = promisify(crypto.scrypt);
export async function passwordHash(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  return salt + ":" + (await scrypt(password, salt, 64)).toString("hex");
}
export async function passwordCheck(password, stored) {
  const [salt, key] = stored.split(":");
  const actual = await scrypt(password, salt, 64);
  return crypto.timingSafeEqual(Buffer.from(key, "hex"), actual);
}
export function encrypt(value) {
  const key = Buffer.from(process.env.ENCRYPTION_KEY || "", "hex");
  if (key.length !== 32)
    throw new Error("Vault encryption key is not configured");
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([c.update(value, "utf8"), c.final()]);
  return [
    iv.toString("hex"),
    c.getAuthTag().toString("hex"),
    body.toString("hex"),
  ].join(":");
}
export function decrypt(value) {
  const [iv, tag, body] = value.split(":");
  const c = crypto.createDecipheriv(
    "aes-256-gcm",
    Buffer.from(process.env.ENCRYPTION_KEY, "hex"),
    Buffer.from(iv, "hex"),
  );
  c.setAuthTag(Buffer.from(tag, "hex"));
  return Buffer.concat([
    c.update(Buffer.from(body, "hex")),
    c.final(),
  ]).toString("utf8");
}
export const defaultPermissions = {
  owner: {
    chat: true,
    ducks: true,
    tasks: true,
    docs: true,
    integrations: true,
    team: true,
    company: true,
    billing: true,
    approvals: true,
    skills: true,
    computers: true,
  },
  admin: {
    chat: true,
    ducks: true,
    tasks: true,
    docs: true,
    integrations: true,
    team: true,
    company: true,
    billing: false,
    approvals: true,
    skills: true,
    computers: true,
  },
  member: {
    chat: true,
    ducks: false,
    tasks: true,
    docs: true,
    integrations: false,
    team: false,
    company: false,
    billing: false,
    approvals: false,
    skills: false,
    computers: false,
  },
  viewer: {
    chat: false,
    ducks: false,
    tasks: false,
    docs: false,
    integrations: false,
    team: false,
    company: false,
    billing: false,
    approvals: false,
    skills: false,
    computers: false,
  },
};
export function permissions(member) {
  return member?.role === "owner"
    ? defaultPermissions.owner
    : {
        ...defaultPermissions[member?.role || "viewer"],
        ...json(member?.permissions || "{}"),
      };
}
export function fail(status, message) {
  throw Object.assign(new Error(message), { status });
}
// The refusal used to read "You do not have permission to integrations.", which
// is not a sentence and names a key only this codebase knows. Say the thing the
// person was trying to do, and who can give it to them.
const permissionNames = {
  chat: "chat with ducks",
  ducks: "create and configure ducks",
  tasks: "create and manage tasks",
  docs: "create and edit documents",
  integrations: "manage connections and secrets",
  team: "invite teammates",
  company: "change company settings",
  billing: "manage billing",
  approvals: "approve requests",
  skills: "create and assign skills",
  computers: "use company computers",
};
export function can(member, permission) {
  if (!permissions(member)[permission])
    fail(
      403,
      "You do not have permission to " +
        (permissionNames[permission] || permission) +
        // Team is its own page in the sidebar, not a tab inside Settings. Every
        // refusal in the product sent people to a screen that does not exist,
        // and the one they needed was two inches away on the left.
        ". Your company owner can give you this on the Team page.",
    );
}
export function memberFor(company, user) {
  return one(
    "SELECT * FROM memberships WHERE company_id=? AND user_id=?",
    company,
    user,
  );
}
export function tenant(table, record, company) {
  if (
    ![
      "ducks",
      "conversations",
      "tasks",
      "documents",
      "connections",
      "secrets",
      "secret_groups",
      "jobs",
      "approvals",
      "skills",
      "computers",
      "human_requests",
      "task_boards",
      "board_columns",
      "schedules",
    ].includes(table)
  )
    throw new Error("Invalid table");
  const row = one(
    `SELECT * FROM ${table} WHERE id=? AND company_id=?`,
    record,
    company,
  );
  if (!row) fail(404, "This item was not found.");
  return row;
}
export function conversationFor(record, company, user) {
  const row = tenant("conversations", record, company);
  if (
    !one(
      "SELECT 1 FROM conversation_members WHERE conversation_id=? AND user_id=?",
      record,
      user,
    )
  )
    fail(403, "You are not a member of this conversation.");
  return row;
}
export const listeners = new Set();
export function emit(company) {
  for (const x of listeners)
    if (x.company === company)
      x.response.write("data: " + JSON.stringify({ type: "refresh" }) + "\n\n");
}
// One line of the activity log. `about` names the duck the line is about, or
// that did it, and the run it happened in: without them a duck reading a secret
// was written down as nobody, and a duck's run as the person who asked for it.
export function audit(company, user, action, details = "", about = {}) {
  run(
    "INSERT INTO audit(id,company_id,user_id,action,details,created,duck_id,job_id,kind) VALUES(?,?,?,?,?,?,?,?,?)",
    id(),
    company,
    user,
    action,
    typeof details === "string" ? details : JSON.stringify(details),
    now(),
    about.duck || null,
    about.job || null,
    kindOf(action),
  );
  emit(company);
}
export function mirrorDuck(duck) {
  const dir = path.join(DATA, "companies", duck.company_id, "ducks", duck.id);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const [filename, value] of [
    ["soul.md", duck.soul],
    ["identity.md", duck.identity],
    ["notes.md", duck.notes],
  ])
    fs.writeFileSync(path.join(dir, filename), value, { mode: 0o600 });
}
// How many ducks a company may have working at once. It was 25 from the first
// commit, where the refusal called it what it was - "The MVP supports 25 ducks
// per company" - and nothing about the machinery needs it to be small: what a
// flock may do at once is held down elsewhere, by 30 queued or running tasks
// and the computers its plan may run at once, neither of which counts ducks.
// Ducks taken off the team are not counted: they are offered no work, and the
// Team page says so. This lives here because three places enforce it and two
// of them used to count different things - the screen counted the flock, the
// duck's own tool counted every duck ever made, so Chief Duck was refused
// while the Team page still offered an Add a duck tile.
//
// The number is the plan's (shared/plan.mjs): ten in a trial, fifty on
// Company, a hundred on Pro. DUCK_LIMIT is the most any plan allows, for the
// checks that only need a ceiling: how many ducks one channel, skill or key
// can be given to in one go.
export const DUCK_LIMIT = MAX_DUCKS;
export function createDuck(
  company,
  {
    name,
    role,
    emoji = "🦆",
    color = "#ffce32",
    soul,
    identity,
    chief = false,
    avatar,
    // Somebody can write notes on the Notes tab while making a duck. They were
    // sent and then dropped on the floor, because nothing here took them.
    notes = "",
  },
) {
  const duckId = id();
  // Part of the insert, so no duck is ever stored without one: nothing fills a
  // missing avatar in later. The count is of the ducks already there, so + 1
  // for this one.
  const count = one(
    "SELECT count(*) n FROM ducks WHERE company_id=?",
    company,
  ).n;
  const picture =
    avatar ||
    (chief ? "02-royal-duck" : avatarIds[(count + 1) % avatarIds.length]);
  run(
    "INSERT INTO ducks(id,company_id,name,role,emoji,color,soul,identity,notes,chief,created,avatar) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
    duckId,
    company,
    name,
    role,
    emoji,
    color,
    soul ||
      `You are thoughtful, direct, and dependable. Take ownership of your work, ask focused questions, and be clear about uncertainty.`,
    identity || standInJob(name, role),
    notes,
    chief ? 1 : 0,
    now(),
    picture,
  );
  const duck = tenant("ducks", duckId, company);
  mirrorDuck(duck);
  return duck;
}
// A duck that may still be given work.
//
// tenant() answers "is this duck in this company", which every route asked and
// which stays true of a duck somebody has taken off the team - so the team page
// could stop offering it and a schedule, a ticket, a board stage or another
// duck would go on handing it work regardless. Routes that are about to give a
// duck something to do ask this instead; routes that are only reading history
// go on asking tenant(), because history must resolve whatever the duck's state
// is today.
export function onTeam(duckId, company) {
  const duck = tenant("ducks", duckId, company);
  if (duck.removed)
    fail(
      409,
      duck.name +
        " was taken off the team, so it cannot be given work. Put it back from the Team page if you want it again.",
    );
  return duck;
}
export function directConversation(company, user, duck) {
  const existing = one(
    "SELECT c.* FROM conversations c JOIN conversation_members m ON m.conversation_id=c.id JOIN conversation_ducks d ON d.conversation_id=c.id WHERE c.company_id=? AND c.kind='direct' AND m.user_id=? AND d.duck_id=?",
    company,
    user,
    duck.id,
  );
  if (existing) return existing;
  const conversationId = id();
  run(
    "INSERT INTO conversations(id,company_id,name,kind,creator_id,created) VALUES(?,?,?,?,?,?)",
    conversationId,
    company,
    duck.name,
    "direct",
    user,
    now(),
  );
  run("INSERT INTO conversation_members VALUES(?,?)", conversationId, user);
  run("INSERT INTO conversation_ducks VALUES(?,?)", conversationId, duck.id);
  return tenant("conversations", conversationId, company);
}
export function threadRoot(company, conversation, message) {
  const selected = one(
    "SELECT * FROM messages WHERE id=? AND company_id=? AND conversation_id=?",
    message,
    company,
    conversation,
  );
  if (!selected)
    fail(404, "That message is not available in this conversation.");
  const root = selected.thread_id
    ? one(
        "SELECT * FROM messages WHERE id=? AND company_id=? AND conversation_id=? AND thread_id IS NULL",
        selected.thread_id,
        company,
        conversation,
      )
    : selected;
  if (!root) fail(404, "That thread is not available.");
  if (["queued", "steered", "steering"].includes(root.state))
    fail(
      409,
      "Wait until this message is available before replying in a thread.",
    );
  return root;
}
export function addMessage(
  company,
  conversation,
  body,
  {
    duck = null,
    user = null,
    state = "sent",
    inbox = false,
    thread = null,
    origin = null,
    needs = null,
  } = {},
) {
  if (thread) thread = threadRoot(company, conversation, thread).id;
  const messageId = id();
  run(
    "INSERT INTO messages(id,company_id,conversation_id,duck_id,user_id,body,state,created,thread_id,origin,needs_you) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
    messageId,
    company,
    conversation,
    duck,
    user,
    body,
    state,
    now(),
    thread,
    origin,
    needs,
  );
  if (inbox) {
    for (const x of all(
      "SELECT user_id FROM conversation_members WHERE conversation_id=? AND user_id IS NOT ?",
      conversation,
      user,
    ))
      run(
        "INSERT OR IGNORE INTO inbox(message_id,user_id) VALUES(?,?)",
        messageId,
        x.user_id,
      );
  }
  emit(company);
  return messageId;
}
// Whatever has to happen to every new company, from modules this one cannot
// import without importing itself: billing marks it as waiting for its first
// payment. Run inside the transaction that makes the company.
const companyCreated = [];
export const onCompanyCreated = (fn) => companyCreated.push(fn);
export function createCompany(user, name) {
  return db.transaction(() => {
    const companyId = id();
    run(
      // Without a timezone every time in the product reads as UTC, which is an
      // hour or two wrong for most people and says so nowhere. The machine's
      // own zone is the right first guess for a product whose owner runs the
      // server, and Settings can change it.
      "INSERT INTO companies(id,name,created,timezone) VALUES(?,?,?,?)",
      companyId,
      name,
      now(),
      Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    );
    run(
      "INSERT INTO memberships(company_id,user_id,role) VALUES(?,?,?)",
      companyId,
      user,
      "owner",
    );
    const duck = createDuck(companyId, {
      name: "Chief Duck",
      role: "Chief of staff",
      chief: true,
      soul: "# Soul\n\nCalm, resourceful, and warmly direct. Turn ambitious ideas into clear next steps. Keep the team focused. Prefer useful work over ceremony. Ask for decisions when you need them; never pretend work is done.",
      identity:
        "# Identity\n\nI am Chief Duck, your chief of staff. I coordinate the flock, keep track of priorities, and recruit specialist ducks when the company allows it. I remember company context in my notes and save reusable work as documents.",
    });
    const conv = directConversation(companyId, user, duck);
    addMessage(
      companyId,
      conv.id,
      "Hey, I’m Chief Duck. Welcome to your flock! 🦆\n\nTell me what your company does and what you’d like to get off your plate. I can help turn it into a plan, bring in specialist ducks, and keep the work moving.\n\nFirst, connect an AI account in **Settings → AI connection** so we can get to work.",
      {
        duck: duck.id,
        inbox: true,
        needs: "Connect your AI account so the ducks can start working.",
      },
    );
    audit(companyId, user, "Company created", name);
    for (const fn of companyCreated) fn(companyId, user);
    return companyId;
  })();
}

// Who stopped a run, written just before the stop rather than after it.
//
// After looks tidier and is wrong: cancelJob marks the job cancelled and then
// awaits work that can throw - a computer that will not answer, a lock, a form
// lease. A name written after that is lost for exactly the runs that went
// badly, which are the ones somebody is looking at this card to understand.
//
// Written once and never overwritten, so a cascade, a second press, or a
// channel archive that catches a run somebody had already stopped cannot take
// the first person's name off it. A missing userId writes nothing at all.
export const recordStopper = (jobId, userId) =>
  userId
    ? run(
        "UPDATE jobs SET stopped_by=? WHERE id=? AND stopped_by IS NULL",
        userId,
        jobId,
      )
    : undefined;
