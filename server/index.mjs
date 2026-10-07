import {
  chiefCheckinSettings,
  createChiefCheckinModelAvailability,
  initializeMissingChiefCheckins,
  registerChiefCheckins,
  startChiefCheckinEngine,
} from "./chief-checkins.mjs";
import { registerRecoveryActions } from "./recovery-actions.mjs";
import {
  assertManualRecoveryAllowed,
  registerRecoveryCancel,
  recoverySummary,
  recoveryAttention,
  taskRecoverySummary,
  holdRecovery,
} from "./unfinished-work.mjs";
import { appEntryFromHtml } from "../shared/app-build.mjs";
import { registerDesktopDownloads } from "./desktop-downloads.mjs";
import { registerWebPush, startWebPushPoller } from "./web-push.mjs";
import {
  deploymentDrainStatus,
  deploymentDrainRequested,
} from "./deployment-drain.mjs";
import { tickTicketReplies } from "./ticket-steering.mjs";
import { recoverTicketReplies } from "./ticket-replies.mjs";
import { registerNativeDesktopHttp } from "./native-desktop.mjs";
import { validStream } from "./computer-control.mjs";
import { registerHumanInput } from "./human-input.mjs";
import {
  registerConnectionBlocks,
  connectionBlocksFor,
  startConnectionBlocks,
} from "./connection-blocks.mjs";
import { listHumanRequests } from "./human-input-store.mjs";
import {
  registerHumanWaitSettings,
  humanWaitSettings,
} from "./human-wait-settings.mjs";
import { registerWorkLimits, workLimits } from "./work-limits.mjs";
import { queueReason } from "./job-queue-state.mjs";
import { registerSkillCatalog } from "./skill-catalog.mjs";
import {
  registerSkillProposals,
  listSkillProposals,
} from "./skill-proposals.mjs";
import {
  registerBoardProposals,
  listBoardProposals,
  listBoardAccess,
} from "./board-proposals.mjs";
import {
  registerAIConfig,
  configSummary,
  modelChoice,
  saveDuckModel,
  resolveAvailableModel,
  modelPlan,
  validateModelSelection,
  credential,
  isSubscription,
} from "./ai-config.mjs";
import {
  registerTicketActivity,
  withTicketActor,
  ticketConversation,
} from "./ticket-activity.mjs";
import {
  workflowSummary,
  registerWorkflows,
  startWorkflowEngine,
  assertLegacyTask,
} from "./workflows.mjs";
import { registerBoardArchive } from "./board-archive.mjs";
import { avatarIds } from "../shared/avatars.mjs";
import { knownTimezone } from "../shared/schedule-times.mjs";
import {
  registerComputerControl,
  closeControl,
  activeHumanControlActionCount,
  registerComputerStream,
} from "./computer-control.mjs";
import { registerChat, setArchived } from "./chat.mjs";
import { notifiableMessageSql, unreadThreadState } from "./chat-store.mjs";
import { setRemoved, whatRemovalStops, liveDucks } from "./duck-removal.mjs";
import { outputSoFar } from "./terminal-stream.mjs";
import { stepsOf } from "./job-steps.mjs";
import { nextDocumentVersion } from "./document-version.mjs";
import { registerStorage } from "./storage.mjs";
import { registerOnboarding } from "./onboarding.mjs";
import { registerEmailSettings } from "./email-settings.mjs";
import * as notices from "./mail-notices.mjs";
import {
  presenceFromRequests,
  startWaitingSweep,
} from "./waiting-reminders.mjs";
import { registerComputerLimits } from "./computer-limits.mjs";
import { registerUploads } from "./uploads.mjs";
import {
  registerFileFolders,
  validateFolderDestination,
  documentFolder,
} from "./file-folders.mjs";
import {
  registerCompanyLogo,
  companyLogoUrl,
  invitationLogoUrl,
  serveInvitationLogo,
} from "./company-logo.mjs";
import { registerConnections, listConnections } from "./connections.mjs";
import { registerOAuthCallback } from "./mcp-oauth.mjs";
import {
  registerSecrets,
  listSecretGroups,
  listSecrets,
  secretDigest,
} from "./secrets.mjs";
import { registerDuckSettings, duckSettings } from "./duck-settings.mjs";
import {
  registerDuckWebhooks,
  registerWebhookReceiver,
  startWebhookReplies,
} from "./duck-webhooks.mjs";
import { artifactsFor, attachArtifact } from "./artifacts.mjs";
import { duckActivity } from "./duck-activity.mjs";
import { registerActivity } from "./activity.mjs";
import {
  registerComputers,
  computerSummary,
  startComputerJanitor,
} from "./computers.mjs";
import { registerSkills, listSkills } from "./skills.mjs";
import {
  registerSchedules,
  startScheduleEngine,
  listSchedules,
  createSchedule,
  moveSchedulesToClock,
} from "./schedules.mjs";
import {
  registerScheduleProposals,
  listScheduleProposals,
} from "./schedule-proposals.mjs";
import express from "express";
import { initializeNativeRuntimeSafety } from "./runtime-safety.mjs";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import { registerSignIn, sweepSignInLinks, tooMany } from "./sign-in.mjs";
import { registerDesktopSignIn } from "./desktop-signin.mjs";
import {
  twoStepOn,
  SESSION_MS,
  ownerCanTurnOff,
  holdForCode,
  registerTwoStepSignIn,
  registerTwoStepSettings,
} from "./two-step.mjs";
import { refusalWithoutAI, duckRefusalFor } from "./ai-gate.mjs";
import { editedSinceOpened } from "./ticket-conflict.mjs";
import { canConnectAI } from "../shared/ai-access.mjs";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { z } from "zod";
import path from "node:path";
import { cacheHeadersFor } from "./static-cache.mjs";
import { computerUseOfRuns } from "./computer-runs.mjs";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  registerWebPages,
  registerWebPageGuards,
  readDistribution,
} from "./web-pages.mjs";
import {
  db,
  DATA,
  id,
  now,
  token,
  hash,
  one,
  all,
  run,
  json,
  passwordHash,
  encrypt,
  decrypt,
  permissions,
  can,
  fail,
  memberFor,
  tenant,
  onTeam,
  conversationFor,
  listeners,
  emit,
  audit,
  createDuck,
  directConversation,
  addMessage,
  createCompany,
  mirrorDuck,
  defaultPermissions,
  recordStopper,
} from "./store.mjs";
import { flockIsFull, flockFullMessage } from "./company-limits.mjs";
import {
  aiStatus,
  codexModels,
  startLogin,
  logoutAI,
  cancelJob,
  pauseDuckJobs,
  steerJob,
  steerTicketJob,
  startWorker,
  activeWorkerCount,
  workerTickBusy,
} from "./runtime.mjs";
import { enqueue } from "./duck-tools.mjs";
import {
  assertConsultationActive,
  consultationForChild,
  continueConsultationAfterApproval,
} from "./duck-consultations.mjs";
import { executeApproved } from "./integrations.mjs";
import {
  registerBilling,
  registerBillingWebhook,
  billingConfigured,
  billingSummary,
  startBillingEngine,
} from "./billing.mjs";
const app = express();
const APP_URL = process.env.APP_URL || "http://localhost:3000";
const production = APP_URL.startsWith("https:");
const port = Number(process.env.PORT || 3000);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distribution = readDistribution(root);
const community = distribution?.edition === "community";
const analyticsOrigin = "https://pijtk6cbfb.9.sub-site.eu";
const analyticsSources = community ? [] : [analyticsOrigin];
let appEntryCache = { stamp: null, value: null };
function currentAppEntry() {
  try {
    const file = path.join(root, "dist", "index.html");
    const stat = fs.statSync(file);
    const stamp = `${stat.ino}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
    if (stamp !== appEntryCache.stamp)
      appEntryCache = {
        stamp,
        value: appEntryFromHtml(fs.readFileSync(file, "utf8")),
      };
    return appEntryCache.value;
  } catch {
    return null;
  }
}
app.set("trust proxy", 1);
app.disable("x-powered-by");
registerWebPageGuards(app, { root });
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", ...analyticsSources],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", ...analyticsSources],
        connectSrc: ["'self'", ...analyticsSources],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
    },
  }),
);
// Community installations have no TameDuck subscription, even if hosted billing
// credentials were accidentally copied into their environment.
if (community)
  app.use("/api/billing", (req, res) =>
    res
      .status(404)
      .json({ error: "Billing is not available in this edition." }),
  );
// Mollie's word that a payment changed. Before the JSON parser and the guard
// below: Mollie posts a form and cannot send our header. It carries only an
// id; server/billing.mjs fetches the payment from Mollie itself.
registerBillingWebhook(app, { community });
// A duck's webhook. Before the JSON parser and the guard below for the same
// reason: the other app posts what it likes and cannot send our header. The
// link itself, and the locks set beside it, are what let a call in.
registerWebhookReceiver(app, { enqueue, aiStatus });
app.use(express.json({ limit: "256kb" }));
app.use(cookieParser());
registerOAuthCallback(app);
// The embedded desktop viewer is the provider's own page, so it cannot send our
// header. Its clipboard POST is what carries what you copied over to the machine,
// and this check was refusing it, which is why pasting into a held screen did
// nothing. It is still same-origin only: the origin check below covers it, and
// the stream's unguessable generation is checked by the proxy itself.
const viewerProxy = /^\/computers\/[^/]+\/control\/native\//;
// While somebody is holding a screen, these are the calls that keep them
// holding it. Throttling a person's own lifeline only ever took the desktop
// away mid-task from someone who had done nothing wrong.
const holdingAScreen =
  /^\/computers\/[^/]+\/control\/(heartbeat|release|type)$/;
// The cap exists to stop one source hammering the server. Keyed by address it
// counted a whole office behind one connection as a single person, and it
// counted the desktop viewer's own stream — hundreds of small requests a
// minute, all of them ours — against whoever happened to be watching a screen.
// Someone taking over a computer would spend the budget in seconds and be told
// "Too many requests" for something they had not done. Signed-in traffic is
// counted per person, so one busy screen cannot lock out a colleague, and
// whoever is not signed in is still counted by address as before.
const perPersonOrAddress = (req) => {
  const value = req.cookies?.td_session;
  if (value) {
    const session = one(
      "SELECT user_id FROM sessions WHERE token_hash=? AND expires>?",
      hash(value),
      Date.now(),
    );
    if (session) return "person:" + session.user_id;
  }
  return ipKeyGenerator(req.ip);
};
app.use(
  "/api",
  rateLimit({
    windowMs: 60000,
    limit: 1200,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    keyGenerator: perPersonOrAddress,
    // Watching a desktop is a video stream in pieces. Counting it here only
    // ever cut off the person watching.
    skip: (req) => viewerProxy.test(req.path) || holdingAScreen.test(req.path),
    message: {
      error:
        "TameDuck is asking for more at once than the server can keep up with. Give it a moment; it catches up on its own.",
    },
  }),
);
app.use("/api", (req, res, next) => {
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    if (req.get("x-tameduck") !== "1" && !viewerProxy.test(req.path))
      return res.status(403).json({ error: "Refresh the page and try again." });
    if (req.get("origin") && req.get("origin") !== APP_URL)
      return res
        .status(403)
        .json({ error: "This request came from a different website." });
  }
  res.set("Cache-Control", "no-store");
  next();
});
const authLimiter = rateLimit({
  windowMs: 15 * 60000,
  limit: 35,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Too many sign-in attempts. Try again in 15 minutes." },
});
app.use("/api/auth", authLimiter);
const name = z.string().trim().min(1).max(100);
const title = z.string().trim().min(1).max(200);
const email = z.string().trim().toLowerCase().email().max(254);
const password = z
  .string()
  .min(12, "Use at least 12 characters for your password.")
  .max(200);
const uuid = z.string().uuid();
const long = z.string().max(60000);
const role = z.enum(["admin", "member", "viewer"]);
// Every way in ends here - the email link, an invitation, the first setup -
// so this is the one place the second step is asked for. With
// two-step sign-in on, the person gets a pending sign-in rather than a session
// (server/two-step.mjs), and each route adds what this returns to its answer
// so the page knows to ask for the code. company is null only for somebody
// with two-step sign-in on who is in no company yet: see placeFor.
function session(res, user, company, newCompany = null) {
  if (twoStepOn(user)) return holdForCode(res, user, company, newCompany);
  openSession(res, user, company);
  return {};
}
function openSession(res, user, company) {
  const value = token();
  run(
    "INSERT INTO sessions VALUES(?,?,?,?)",
    hash(value),
    user,
    company,
    Date.now() + SESSION_MS,
  );
  res.cookie("td_session", value, {
    httpOnly: true,
    secure: production,
    sameSite: "strict",
    maxAge: 14 * 86400000,
    path: "/",
  });
}
function auth(req, res, next) {
  const value = req.cookies.td_session;
  if (!value) return res.status(401).json({ error: "Please sign in." });
  const row = one(
    "SELECT s.*,u.name,u.email FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires>?",
    hash(value),
    Date.now(),
  );
  if (!row) return res.status(401).json({ error: "Please sign in again." });
  const member = memberFor(row.company_id, row.user_id);
  if (!member)
    return res
      .status(403)
      .json({ error: "Your company membership has ended." });
  req.user = { id: row.user_id, name: row.name, email: row.email };
  req.company = one("SELECT * FROM companies WHERE id=?", row.company_id);
  req.member = member;
  req.session = row;
  next();
}
// Who this browser is signed in as, for the one page before sign-in that has
// to know: an invitation must not be taken by whoever happens to be signed in.
// Only a session auth() would let through counts.
function signedInAs(req) {
  const value = req.cookies.td_session;
  if (!value) return null;
  const row = one(
    "SELECT u.id,u.name,u.email,s.company_id FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires>?",
    hash(value),
    Date.now(),
  );
  return row && memberFor(row.company_id, row.id) ? row : null;
}
app.get("/api/health", (req, res) =>
  res.json({
    ok: !!one("SELECT 1 healthy"),
    service: "tameduck",
    deployDrain: deploymentDrainStatus(
      activeWorkerCount() + activeHumanControlActionCount(),
      workerTickBusy(),
    ),
  }),
);
app.get("/api/public", (req, res) => {
  res.json({ needsSetup: !one("SELECT 1 FROM users LIMIT 1") });
});
app.post("/api/auth/setup", async (req, res) => {
  const a = z
    .object({ token: z.string().min(20), name, email, password, company: name })
    .parse(req.body);
  if (
    one("SELECT 1 FROM users LIMIT 1") ||
    hash(a.token) !== process.env.SETUP_TOKEN_HASH
  )
    fail(403, "This setup link is invalid or has already been used.");
  const encoded = await passwordHash(a.password);
  const recovery = token();
  let userId;
  let companyId;
  db.transaction(() => {
    if (one("SELECT 1 FROM users LIMIT 1"))
      fail(409, "Setup has already been completed.");
    userId = id();
    run(
      "INSERT INTO users VALUES(?,?,?,?,?,?)",
      userId,
      a.email,
      a.name,
      encoded,
      hash(recovery),
      now(),
    );
    companyId = createCompany(userId, a.company);
    // Named, and by somebody who typed the name: there is nothing left for the
    // setting-up screens to ask. This path is also how every browser test and
    // the marketing capture build a workspace, and neither of those can answer
    // a question.
    run("UPDATE companies SET onboarded_at=? WHERE id=?", now(), companyId);
    // Whoever sets up a server that bills is not its customer.
    if (billingConfigured())
      run(
        "UPDATE companies SET billing_status='free',paused=0,billing_hold=0 WHERE id=?",
        companyId,
      );
  })();
  const next = session(res, userId, companyId);
  res.json({ ok: true, recoveryKey: recovery, ...next });
});
// Signing in with a password is off. Nobody can set a password any more, so
// the password form only led people to a dead end. Accounts that have one
// come in by the email link like everybody else, and the hashes stay stored.
// One answer for everybody, so it says nothing about which addresses exist.
for (const route of ["login", "recover", "password"])
  app.post("/api/auth/" + route, () =>
    fail(
      410,
      "Signing in with a password is turned off. Use the link we email you.",
    ),
  );
const membershipOf = (userId) => {
  const m = one(
    "SELECT company_id FROM memberships WHERE user_id=? ORDER BY rowid LIMIT 1",
    userId,
  );
  return m ? { company: m.company_id, created: false } : null;
};
const waitingInvitation = (address) =>
  one(
    "SELECT * FROM invites WHERE email=? AND accepted=0 AND expires>? ORDER BY rowid LIMIT 1",
    address,
    Date.now(),
  );
// The company somebody signs in to: the first one they are in; else the one
// whose invitation is waiting for them, joined now; else, when the way in
// starts one (the email link does), a new company called newCompany. Null if
// none of those. For somebody with two-step sign-in on, this runs only after
// the code, so the link alone joins and starts nothing.
function placeFor(userId, newCompany = null) {
  const member = membershipOf(userId);
  if (member) return member;
  const address = one("SELECT email FROM users WHERE id=?", userId).email;
  const invitation = waitingInvitation(address);
  if (invitation) {
    acceptInvitation(invitation, userId);
    return { company: invitation.company_id, created: false };
  }
  if (newCompany)
    return { company: createCompany(userId, newCompany), created: true };
  return null;
}
// Why a link did not work, in words that tell somebody what to do. Inviting
// the same address again retires the earlier invitation, which is right - two
// live links to one seat is worse - but the first email is still sitting in
// their inbox, and opening it said only "expired or already used". Somebody
// looking at two mails from us with no way to tell which is the live one gives
// up, and asks the person who invited them to do it all again. A link that ran
// out says so, and names who to ask for a new one, since they are the only
// person who can send it.
function whyNotUsable(tokenHash) {
  const old = one("SELECT * FROM invites WHERE token_hash=?", tokenHash);
  if (
    old &&
    one(
      "SELECT 1 FROM invites WHERE company_id=? AND email=? AND accepted=0 AND expires>?",
      old.company_id,
      old.email,
      Date.now(),
    )
  )
    return "You were invited again since this email was sent, so this link has been retired. Open the most recent invitation instead.";
  if (
    old &&
    one(
      "SELECT 1 FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.company_id=? AND u.email=?",
      old.company_id,
      old.email,
    )
  )
    return "You have already joined with this invitation. Sign in instead.";
  if (old && !old.accepted && old.expires <= Date.now()) {
    const inviter = one("SELECT name FROM users WHERE id=?", old.created_by);
    return inviter
      ? `This invitation ran out. Ask ${inviter.name} to send it again.`
      : "This invitation ran out. Ask the person who invited you to send it again.";
  }
  return "This link no longer works. Ask the person who invited you to send a new one.";
}
// Joining the company an invitation names. Shared by signing in with one
// waiting and by accepting one while already signed in.
function acceptInvitation(invitation, userId) {
  db.transaction(() => {
    run(
      "INSERT OR IGNORE INTO memberships VALUES(?,?,?,?)",
      invitation.company_id,
      userId,
      invitation.role,
      invitation.permissions,
    );
    run(
      "UPDATE invites SET accepted=1,token_enc=NULL WHERE token_hash=?",
      invitation.token_hash,
    );
    directConversation(
      invitation.company_id,
      userId,
      one(
        "SELECT * FROM ducks WHERE company_id=? AND chief=1",
        invitation.company_id,
      ),
    );
  })();
  // After the transaction: the person who asked for them hears that they came.
  notices
    .joined({
      company: invitation.company_id,
      joiner: userId,
      invitedBy: invitation.created_by,
    })
    .catch((e) => console.error("Joined email:", e.message));
}
// What the page an invitation opens shows: who asked, as what, who is there,
// and whether the address, or this browser, already has an account. A POST,
// so the token travels in the body and never in a URL, and under /api/auth,
// so the way-in limit covers it. First names only, bar the inviter's, who is
// already named in the email.
app.post("/api/auth/invitation", (req, res) => {
  const a = z.object({ token: z.string().min(20).max(400) }).parse(req.body);
  const digest = hash(a.token);
  const row = one("SELECT * FROM invites WHERE token_hash=?", digest);
  const you = signedInAs(req);
  // Already in: straight there, whatever the link says now.
  if (
    row &&
    you &&
    you.email === row.email &&
    memberFor(row.company_id, you.id)
  )
    return res.json({ joined: row.company_id });
  if (!row || row.accepted || row.expires <= Date.now())
    fail(410, whyNotUsable(digest));
  const first = (name) => name.trim().split(/\s+/)[0];
  const people = all(
    "SELECT u.name FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.company_id=? ORDER BY CASE WHEN m.role='owner' THEN 0 ELSE 1 END, m.rowid",
    row.company_id,
  ).map((p) => first(p.name));
  const shown = people.slice(0, 3);
  const ducks = all(
    "SELECT avatar,emoji,color,chief FROM ducks WHERE company_id=? AND removed=0 ORDER BY chief DESC, created",
    row.company_id,
  );
  const invitedCompany = one(
    "SELECT name,logo_mime,logo_version FROM companies WHERE id=?",
    row.company_id,
  );
  res.json({
    invitation: {
      email: row.email,
      role: row.role,
      company: {
        name: invitedCompany.name,
        // Gated by this same token, never by company id: see
        // /api/auth/invitation-logo below.
        logo_url: invitationLogoUrl(a.token, invitedCompany),
      },
      invited_by: one("SELECT name FROM users WHERE id=?", row.created_by).name,
      people: shown,
      more_people: people.length - shown.length,
      // Seven faces at most, the people's first.
      ducks: ducks.slice(0, 7 - shown.length),
      duck_count: ducks.length,
      account: !!one("SELECT 1 FROM users WHERE email=?", row.email),
    },
    you: you && {
      id: you.id,
      name: you.name,
      first: first(you.name),
      email: you.email,
    },
  });
});
// The picture an <img> on the invitation page can load: no session exists yet
// to check membership with, so this is gated the same way the page itself
// is - a live, unaccepted invite - never by anyone just asking for a company
// id. The token sits on the URL because an <img> has no way to send one in a
// body; nothing more sensitive than the invite link itself travels here.
app.get("/api/auth/invitation-logo/:token", (req, res) => {
  const token = z.string().min(20).max(400).parse(req.params.token);
  const row = one("SELECT * FROM invites WHERE token_hash=?", hash(token));
  if (!row || row.accepted || row.expires <= Date.now())
    return res.status(404).end();
  serveInvitationLogo(res, row.company_id);
});
// An invitation can be copied by its sender. It grants no sign-in authority:
// new and returning invitees must verify their mailbox through /auth/link.
// Keep the retired route explicit for old pages, without reading or changing
// an account, invitation, or session.
app.post("/api/auth/join", () => {
  fail(410, "To join, verify your email using the sign-in link we send you.");
});
// The public way in, registered here for the same reason setup and login
// are: everything below this line needs a session, and asking for a link
// is exactly what somebody without one does.
registerSignIn(app, { session, placeFor, membershipOf, community });
// Typing the code that turns a pending sign-in into a session. Before auth for
// the same reason: whoever is typing it has no session yet.
registerTwoStepSignIn(app, { openSession, placeFor, production });
registerDesktopSignIn(app, { auth, signedInAs, openSession });
registerDesktopDownloads(app);
app.use("/api", auth);
// A signed-in request from a page that is showing and in use says so; the
// half-hour reminder reads it. See server/waiting-reminders.mjs.
app.use("/api", presenceFromRequests);
registerWebPush(app, { appUrl: APP_URL });
app.post("/api/auth/logout", (req, res) => {
  run("DELETE FROM sessions WHERE token_hash=?", req.session.token_hash);
  res.clearCookie("td_session", { path: "/" });
  res.json({ ok: true });
});
registerTwoStepSettings(app);
app.post("/api/invites/accept", (req, res) => {
  const a = z.object({ token: z.string() }).parse(req.body);
  const invitation = one(
    "SELECT * FROM invites WHERE token_hash=? AND accepted=0 AND expires>?",
    hash(a.token),
    Date.now(),
  );
  // A dead link says why, as it does to somebody signed out.
  if (!invitation) fail(410, whyNotUsable(hash(a.token)));
  if (invitation.email !== req.user.email)
    fail(403, "This invitation does not match your signed-in email.");
  // Joining is one job, and this route used to do it a second time in its own
  // words: the same three writes, one transaction short, and without the line
  // that tells the person who asked for them. Two copies of a thing drift, and
  // this pair had.
  acceptInvitation(invitation, req.user.id);
  run(
    "UPDATE sessions SET company_id=? WHERE token_hash=?",
    invitation.company_id,
    req.session.token_hash,
  );
  res.json({ ok: true });
});
const chiefCheckinModelAvailable = createChiefCheckinModelAvailability({
  modelPlan,
  validateModelSelection,
  isSubscription,
  credential,
  resolveAvailableModel,
  aiStatus,
  codexModels,
});
const chiefCheckinDeps = { modelAvailable: chiefCheckinModelAvailable };

app.get("/api/state", async (req, res) => {
  const c = req.company.id;
  const u = req.user.id;
  const p = permissions(req.member);
  const unreadThreads = unreadThreadState(c, u);
  if (p.ducks)
    await initializeMissingChiefCheckins(c, chiefCheckinModelAvailable);
  const conversations = all(
    // Replies inside a thread count too. Left out, a duck answering a question
    // asked in a thread raised nothing anywhere, so the answer sat there until
    // somebody happened to open that thread again.
    `SELECT c.*,(SELECT count(*) FROM messages um LEFT JOIN message_reads mr ON mr.message_id=um.id AND mr.user_id=? WHERE um.conversation_id=c.id AND um.user_id IS NOT ? AND ${notifiableMessageSql("um")} AND mr.message_id IS NULL) unread,(SELECT count(*) FROM inbox i JOIN messages m ON m.id=i.message_id WHERE m.conversation_id=c.id AND i.user_id=? AND i.state='pending') pending FROM conversations c JOIN conversation_members cm ON cm.conversation_id=c.id WHERE c.company_id=? AND cm.user_id=? ORDER BY c.created`,
    u,
    u,
    u,
    c,
    u,
  ).map((x) => ({
    ...x,
    unread_thread_count: unreadThreads.get(x.id)?.unread_thread_count || 0,
    unread_thread_id: unreadThreads.get(x.id)?.unread_thread_id || null,
    // How many runs are going on in here, so archiving can say what it is
    // about to stop instead of stopping it quietly.
    working: one(
      "SELECT count(*) n FROM jobs WHERE conversation_id=? AND checkin=0 AND status IN ('queued','running','waiting_human','waiting_consultation')",
      x.id,
    ).n,
    ducks: all(
      "SELECT duck_id FROM conversation_ducks WHERE conversation_id=?",
      x.id,
    ).map((y) => y.duck_id),
    members: all(
      "SELECT user_id FROM conversation_members WHERE conversation_id=?",
      x.id,
    ).map((y) => y.user_id),
  }));
  res.json({
    app_entry: currentAppEntry(),
    ...(distribution ? { distribution } : {}),
    user: req.user,
    // The old Stripe ids are nobody's business on the screen.
    company: {
      ...req.company,
      stripe_customer: undefined,
      stripe_subscription: undefined,
      logo_url: companyLogoUrl(req.company),
    },
    permissions: p,
    role: req.member.role,
    human_wait_settings: humanWaitSettings(u, c),
    chief_checkins: p.ducks ? chiefCheckinSettings(u, c) : null,
    work_limits: p.company ? workLimits(c) : null,
    recovery_attention: recoveryAttention(c, u, req.member),
    duck_settings: p.ducks ? duckSettings(c, u) : [],
    // logo_mime/logo_version so the switcher can show every company's own
    // tile, not only the one this session is bound to.
    companies: all(
      "SELECT c.id,c.name,m.role,c.logo_mime,c.logo_version FROM companies c JOIN memberships m ON m.company_id=c.id WHERE m.user_id=?",
      u,
    ).map((row) => ({ ...row, logo_url: companyLogoUrl(row) })),
    ducks: all(
      "SELECT * FROM ducks WHERE company_id=? ORDER BY chief DESC,created",
      c,
    ),
    duck_activity: duckActivity(c, u, req.member),
    conversations,
    ai: configSummary(c),
    skills: listSkills(c),
    computers: p.computers ? computerSummary(c, req.session.token_hash) : null,
    // Not SELECT *. A brief can run to sixty thousand characters, and this
    // whole payload is fetched again on every change a duck reports -- about
    // once a second while one is writing. Shipping every brief and every
    // handoff note of every ticket ever written, once a second, to every open
    // tab, is most of a megabyte a second on a workspace with a few long
    // tickets. Lists only ever show the first line or so; the ticket itself
    // asks for the rest.
    tasks: all(
      // running: the jobs slice below is scoped to the asking person's own
      // conversations, and asking a duck to work opens a direct one, so a
      // ticket a teammate started read as idle to everyone else - the status
      // pill said Working while the button beside it invited them to start it
      // again, and pressing it answered "This task is already running."
      "SELECT t.id,t.company_id,t.title,substr(t.description,1,240) description," +
        "length(t.description)>240 description_clipped," +
        "substr(t.result,1,240) result,length(t.result)>240 result_clipped," +
        "t.assignee_id,t.status,t.priority,t.creator_id,t.created,t.updated," +
        // running is the run itself, not just whether there is one, with who
        // it runs for and which duck: the ticket page puts Stop beside it, and
        // a ticket's work is in a conversation only that person belongs to,
        // so nobody else could find the run to stop it.
        "lj.id running,lj.user_id running_by,lj.duck_id running_duck,lj.status running_status," +
        // asked: the duck's last run on it ended with a question for a person,
        // and nothing has run since. The ticket said Working and the feed
        // filed the question under "finished", so nothing on the page said
        // the duck was waiting for an answer. asked_of is who it asked.
        "(SELECT CASE WHEN j.status='done' AND coalesce(j.needs_you,'')<>'' THEN j.needs_you END " +
        "FROM jobs j WHERE j.task_id=t.id ORDER BY j.created DESC,j.rowid DESC LIMIT 1) asked," +
        "(SELECT j.user_id FROM jobs j WHERE j.task_id=t.id ORDER BY j.created DESC,j.rowid DESC LIMIT 1) asked_of," +
        // stuck: still "Being worked on", but its last run failed or was cut
        // off by a restart and nothing has run since. The board said
        // "Waiting" under a duck's name for days. Only failed runs are looked
        // at, which the status index keeps to a handful.
        "CASE WHEN t.status='working' THEN EXISTS(SELECT 1 FROM jobs j WHERE " +
        "j.status IN ('error','interrupted') AND j.task_id=t.id AND NOT EXISTS(" +
        "SELECT 1 FROM jobs k WHERE k.task_id=t.id AND k.created>j.created)) " +
        "ELSE 0 END stuck FROM tasks t " +
        "LEFT JOIN (SELECT task_id,id,user_id,duck_id,status FROM (" +
        "SELECT task_id,id,user_id,duck_id,status,created,rowid," +
        "ROW_NUMBER() OVER (PARTITION BY task_id ORDER BY " +
        "CASE status WHEN 'running' THEN 0 WHEN 'waiting_human' THEN 1 " +
        "WHEN 'waiting_consultation' THEN 2 ELSE 3 END,created DESC,rowid DESC) rn " +
        "FROM jobs WHERE task_id IS NOT NULL AND status IN " +
        "('queued','running','waiting_human','waiting_consultation')) " +
        "WHERE rn=1) lj ON lj.task_id=t.id " +
        "WHERE t.company_id=? ORDER BY t.created DESC",
      c,
    ).map((task) => ({
      ...task,
      queue_reason:
        task.running_status === "queued"
          ? queueReason({
              ...task,
              id: task.running,
              company_id: c,
              duck_id: task.running_duck,
              status: task.running_status,
            })
          : null,
      recovery: taskRecoverySummary(task),
    })),
    workflows: workflowSummary(c, u),
    schedules: p.tasks ? listSchedules(c) : [],
    schedule_proposals: p.tasks ? listScheduleProposals(c, u) : [],
    documents: all(
      "SELECT id,title,duck_id,user_id,created,updated FROM documents WHERE company_id=? ORDER BY updated DESC",
      c,
    ),
    // With whether each could connect the AI, so a screen that cannot
    // connect one names the people who can rather than "the owner".
    members: all(
      "SELECT u.id,u.name,u.email,m.role,m.permissions FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.company_id=? ORDER BY m.rowid",
      c,
    ).map((m) => ({
      ...m,
      connects_ai: canConnectAI(m.role, permissions(m)),
      // Only the owner can turn it off for somebody, so only the owner is told
      // who has it on, and only for those they could turn it off for.
      ...(req.member.role === "owner" && {
        two_step: ownerCanTurnOff(m.id, req.company.id),
      }),
    })),
    inbox: all(
      "SELECT m.*,i.state inbox_state,d.name duck_name,u.name user_name,j.task_id,bt.board_id,t.title task_title FROM inbox i JOIN messages m ON m.id=i.message_id LEFT JOIN ducks d ON d.id=m.duck_id LEFT JOIN users u ON u.id=m.user_id JOIN conversation_members cm ON cm.conversation_id=m.conversation_id AND cm.user_id=i.user_id LEFT JOIN jobs j ON j.output_message_id=m.id LEFT JOIN board_tasks bt ON bt.task_id=j.task_id LEFT JOIN tasks t ON t.id=j.task_id WHERE m.company_id=? AND i.user_id=? AND i.state='pending' ORDER BY m.created DESC",
      c,
      u,
    ),
    human_requests: p.computers ? listHumanRequests(c, u) : [],
    skill_proposals: listSkillProposals(c, u),
    board_proposals: listBoardProposals(c, u),
    board_access: listBoardAccess(c),
    // Anything still waiting on a person comes first. Ordered only by age, a
    // hundred decided approvals pushed a pending one off the end, and the duck
    // waiting on it waited for good with nothing on screen to say so.
    approvals: all(
      // message_id: the duck's own message, which the ask's card sits under.
      // decided_by_name: who answered, for the line the card folds to.
      `SELECT a.*,d.id duck_id,d.name duck_name,cn.name connection_name,j.user_id,
              COALESCE(parent.conversation_id,j.conversation_id) conversation_id,
              COALESCE(parent.thread_id,j.thread_id) thread_id,
              j.output_message_id message_id,du.name decided_by_name
         FROM approvals a
         JOIN jobs j ON j.id=a.job_id
         JOIN ducks d ON d.id=j.duck_id
         JOIN connections cn ON cn.id=a.connection_id
         LEFT JOIN users du ON du.id=a.decided_by
         LEFT JOIN duck_consultations consultation ON consultation.child_job_id=j.id
         LEFT JOIN jobs parent ON parent.id=consultation.parent_job_id
        WHERE a.company_id=? AND (?=1 OR j.user_id=?)
        ORDER BY (a.status='pending') DESC, a.created DESC LIMIT 100`,
      c,
      p.approvals ? 1 : 0,
      u,
    ),
    connections: p.integrations ? listConnections(c) : [],
    connection_blocks: connectionBlocksFor(c, u, p),
    secret_groups: p.integrations ? listSecretGroups(c) : [],
    secrets: p.integrations
      ? listSecrets(c).map((x) => ({ ...x, base: secretDigest(x) }))
      : [],
    // The ones that ran out stay, until somebody sends them again or removes
    // them: they used to drop off this list without a word, and Send again
    // needs them. Taken and replaced ones are accepted=1. ran_out is the
    // server's clock, not the browser's, and the link itself is never here.
    invites: p.team
      ? all(
          "SELECT i.id,i.email,i.role,i.created,i.expires,i.created_by,u.name invited_by," +
            "i.expires<=? ran_out,i.token_enc IS NOT NULL link_kept FROM invites i " +
            "LEFT JOIN users u ON u.id=i.created_by WHERE i.company_id=? AND i.accepted=0 ORDER BY i.created DESC",
          Date.now(),
          c,
        )
      : [],
    // The activity log asks GET /api/activity for its days; this only says
    // when the newest line was written, so an open log knows to look again.
    // Not for somebody who may not manage connections and secrets: the log
    // names them, and is theirs only (see server/activity.mjs).
    activity_at: p.integrations
      ? one("SELECT max(created) at FROM audit WHERE company_id=?", c)?.at ||
        null
      : null,
    jobs: all(
      "SELECT j.*,f.outcome work_outcome FROM jobs j LEFT JOIN job_work_finishes f ON f.job_id=j.id JOIN conversation_members cm ON cm.conversation_id=j.conversation_id WHERE j.company_id=? AND j.checkin=0 AND cm.user_id=? ORDER BY j.created DESC LIMIT 100",
      c,
      u,
    ).map((job) => ({
      ...job,
      queue_reason: queueReason(job),
      recovery: recoverySummary(job),
    })),
    // What each run did with its computer: server/computer-runs.mjs.
    ...computerUseOfRuns(c, u),
    // What pausing the flock would stop, company-wide. The run list above only
    // carries runs from conversations this person is in, so somebody about to
    // press Pause all ducks could not see their colleagues' work at all - and
    // pressing it cancels every bit of it, for good. Only for the people who
    // can actually press it.
    flock: p.company
      ? (() => {
          const going = all(
            "SELECT j.status,j.user_id,j.duck_id,u.name,d.name duck,COALESCE(NULLIF(j.schedule_title,''),t.title,CASE WHEN cv.kind<>'direct' THEN NULLIF(cv.name,'') END) title FROM jobs j JOIN users u ON u.id=j.user_id JOIN ducks d ON d.id=j.duck_id LEFT JOIN tasks t ON t.id=j.task_id LEFT JOIN conversations cv ON cv.id=j.conversation_id WHERE j.company_id=? AND j.checkin=0 AND j.status IN ('running','queued','waiting_human','waiting_consultation')",
            c,
          );
          // Pausing the flock cancels the runs that are going and nothing
          // else, but this counted the queued and the waiting ones too - so
          // the confirm box named four runs and four colleagues when it was
          // about to stop one. These are two different facts and the screen
          // needs both of them separately.
          const live = going.filter((x) => x.status === "running");
          return {
            running: live.length,
            waiting: going.length - live.length,
            people: [...new Set(live.map((x) => x.name))],
            // Three counts could not say what the press would cost. The screen
            // that stops the whole company now names each busy duck, what it
            // is on and who asked for it, because that is what somebody is
            // deciding about. A name, a person and the title of a channel,
            // ticket or scheduled task - nothing from inside a conversation -
            // and only for the people who may press the stop.
            busy: going.map((x) => ({
              duck_id: x.duck_id,
              duck: x.duck,
              person: x.name,
              yours: x.user_id === u,
              status: x.status,
              title: x.title || "",
            })),
          };
        })()
      : null,
    billingConfigured: billingConfigured(),
    billing: billingSummary(c, req.member),
  });
});
app.get("/api/events", (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();
  res.write('data: {"type":"connected"}\n\n');
  const listener = { company: req.company.id, response: res };
  listeners.add(listener);
  const timer = setInterval(() => {
    if (
      !one(
        "SELECT 1 FROM sessions WHERE token_hash=? AND expires>?",
        req.session.token_hash,
        Date.now(),
      ) ||
      !memberFor(req.company.id, req.user.id)
    )
      return res.end();
    res.write(": heartbeat\n\n");
  }, 25000);
  req.on("close", () => {
    clearInterval(timer);
    listeners.delete(listener);
  });
});
app.get("/api/search", (req, res) => {
  const q = String(req.query.q || "")
    .trim()
    .slice(0, 200);
  if (q.length < 2) return res.json([]);
  res.json(
    all(
      "SELECT m.id,m.body,m.conversation_id,m.thread_id,m.created FROM messages m JOIN conversation_members cm ON cm.conversation_id=m.conversation_id WHERE m.company_id=? AND cm.user_id=? AND m.body LIKE ? AND m.origin IS NOT 'workflow' AND m.origin IS NOT 'chief_checkin' ORDER BY m.created DESC LIMIT 26",
      req.company.id,
      req.user.id,
      "%" + q + "%",
    ),
  );
});
registerAIConfig(app, { codexModels });
app.get("/api/ai/status", async (req, res) =>
  res.json(await aiStatus(req.company.id, req.member.role === "owner")),
);
// The connection belongs to the company and is the owner's own account, so only
// the owner connects or disconnects it. Everybody else simply works through it.
app.post("/api/ai/connect", async (req, res) => {
  if (req.member.role !== "owner")
    fail(403, "Only the company owner can connect the AI for this company.");
  res.json(await startLogin(req.company.id));
});
app.post("/api/ai/disconnect", async (req, res) => {
  if (req.member.role !== "owner")
    fail(403, "Only the company owner can disconnect the AI for this company.");
  await logoutAI(req.company.id);
  res.json({ ok: true });
});
app.post("/api/companies", (req, res) => {
  const a = z.object({ name }).parse(req.body);
  if (
    one(
      "SELECT count(*) n FROM memberships WHERE user_id=? AND role='owner'",
      req.user.id,
    ).n >= 10
  )
    fail(400, "You can own up to 10 companies for now.");
  const company = createCompany(req.user.id, a.name);
  run(
    "UPDATE sessions SET company_id=? WHERE token_hash=?",
    company,
    req.session.token_hash,
  );
  res.json({ id: company });
});
app.post("/api/companies/switch", (req, res) => {
  const a = z.object({ id: uuid }).parse(req.body);
  if (!memberFor(a.id, req.user.id))
    fail(403, "You are not a member of this company.");
  run(
    "UPDATE sessions SET company_id=? WHERE token_hash=?",
    a.id,
    req.session.token_hash,
  );
  res.json({ ok: true });
});
app.patch("/api/company", async (req, res) => {
  can(req.member, "company");
  const a = z
    .object({
      name,
      rules: long,
      auto_create: z.boolean(),
      paused: z.boolean(),
      timezone: z.string().trim().min(1).max(64).optional(),
    })
    .parse(req.body);
  // Paused by billing is not a pause a person can lift here: the plan has to
  // be started or paid first, and Settings → Billing is where that is.
  if (req.company.billing_hold && !a.paused)
    fail(
      409,
      "The ducks are paused until the plan is started or paid. That is done in Settings → Billing.",
    );
  if (a.timezone !== undefined) {
    if (!knownTimezone(a.timezone))
      fail(400, "That is not a time zone this server knows.");
    db.transaction(() => {
      run(
        "UPDATE companies SET timezone=? WHERE id=?",
        a.timezone,
        req.company.id,
      );
      moveSchedulesToClock(req.company.id, a.timezone);
    })();
  }
  run(
    "UPDATE companies SET name=?,rules=?,auto_create=?,paused=? WHERE id=?",
    a.name,
    a.rules,
    a.auto_create ? 1 : 0,
    a.paused ? 1 : 0,
    req.company.id,
  );
  // What changed, so the log can say more than that somebody pressed Save.
  let changed = ["name", "rules", "auto_create", "paused", "timezone"].filter(
    (key) =>
      a[key] !== undefined &&
      String(key === "auto_create" || key === "paused" ? +a[key] : a[key]) !==
        String(req.company[key]),
  );
  if (a.paused) {
    // Stopped, not held: a cancelled run is gone, and starting the flock again
    // brings none of them back. The screen now says that before it happens.
    const stopped = all(
      "SELECT * FROM jobs WHERE company_id=? AND status='running'",
      req.company.id,
    );
    for (const job of stopped) recordStopper(job.id, req.user.id);
    for (const job of stopped) await cancelJob(job);
    if (stopped.length) {
      audit(req.company.id, req.user.id, "Flock paused, runs stopped", {
        runs: stopped.length,
      });
      // One press of Pause is one line: this one says it.
      changed = changed.filter((key) => key !== "paused");
    }
  }
  // Saved with nothing changed: nothing to write down.
  if (changed.length)
    audit(req.company.id, req.user.id, "Company settings updated", {
      changed,
      paused: a.paused,
    });
  res.json({ ok: true });
});
app.post("/api/ducks", async (req, res) => {
  can(req.member, "ducks");
  const a = z
    .object({
      name,
      role: name,
      emoji: z.string().max(12).optional(),
      avatar: z.enum([...avatarIds, "emoji"]).optional(),
      color: z
        .string()
        .regex(/^#[0-9a-fA-F]{6}$/)
        .optional(),
      soul: long.optional(),
      identity: long.optional(),
      // The editor has a Notes tab while you are making a duck, and what was
      // typed there was stripped here and never reached the duck.
      notes: long.optional(),
    })
    .parse(req.body);
  if (flockIsFull(req.company.id)) fail(400, flockFullMessage(req.company.id));
  const model =
    req.body.ai_model === undefined
      ? undefined
      : modelChoice.nullable().parse(req.body.ai_model);
  if (model != null)
    await resolveAvailableModel(req.company.id, model, { codexModels });
  can(memberFor(req.company.id, req.user.id), "ducks");
  const duck = db.transaction(() => {
    // Availability lookup yields to other requests; recheck the cap before writing.
    if (flockIsFull(req.company.id))
      fail(
        400,
        "This company has reached its duck limit. Take one off the team first.",
      );
    const d = createDuck(req.company.id, a);
    if (model !== undefined) saveDuckModel(req.company.id, d.id, model);
    return d;
  })();
  audit(req.company.id, req.user.id, "Duck created", duck.name, {
    duck: duck.id,
  });
  res.json(duck);
});
app.patch("/api/ducks/:id", async (req, res) => {
  can(req.member, "ducks");
  tenant("ducks", req.params.id, req.company.id);
  // Only what was sent is changed. The editor used to send back everything it
  // read when it opened, so saving a new avatar wrote back the notes as they
  // were at that moment, throwing away anything the duck had written into them
  // while the dialog sat open.
  const a = z
    .object({
      name: name.optional(),
      role: name.optional(),
      emoji: z.string().min(1).max(12).optional(),
      avatar: z.enum([...avatarIds, "emoji"]).optional(),
      color: z
        .string()
        .regex(/^#[0-9a-fA-F]{6}$/)
        .optional(),
      soul: long.optional(),
      identity: long.optional(),
      notes: long.optional(),
    })
    .parse(req.body);
  const model =
    req.body.ai_model === undefined
      ? undefined
      : modelChoice.nullable().parse(req.body.ai_model);
  if (model != null)
    await resolveAvailableModel(req.company.id, model, { codexModels });
  can(memberFor(req.company.id, req.user.id), "ducks");
  const fields = ["name", "role", "emoji", "color", "soul", "identity", "notes"]
    .filter((k) => a[k] !== undefined)
    .map((k) => [k, a[k]]);
  tenant("ducks", req.params.id, req.company.id);
  db.transaction(() => {
    if (fields.length)
      run(
        "UPDATE ducks SET " +
          fields.map(([k]) => k + "=?").join(",") +
          " WHERE id=?",
        ...fields.map(([, v]) => v),
        req.params.id,
      );
    if (a.avatar)
      run("UPDATE ducks SET avatar=? WHERE id=?", a.avatar, req.params.id);
    if (model !== undefined)
      saveDuckModel(req.company.id, req.params.id, model);
  })();
  mirrorDuck(tenant("ducks", req.params.id, req.company.id));
  audit(
    req.company.id,
    req.user.id,
    "Duck profile updated",
    tenant("ducks", req.params.id, req.company.id).name,
    { duck: req.params.id },
  );
  res.json({ ok: true });
});
// What a duck has been typing, for the terminal panel beside its screen.
//
// Shell work changes nothing on the desktop, so a person watching a duck do an
// hour of it saw a motionless picture and concluded it was doing nothing. The
// commands and their output were both already kept - the output in the tool
// receipt, the command beside it - and neither was ever shown to anybody.
//
// Secrets: a duck may put a key straight into a command. Anything matching a
// secret saved in this workspace is masked here, on the way out, so it is never
// on a screen or in a browser's memory. A secret the duck made up itself is not
// in that list and will show; the person choosing this was told so.
// The end of a command's output, in the amount a person glances at.
const PANEL_LINES = 8;
const tail = (text) => {
  const lines = String(text || "").split("\n");
  const kept = lines.slice(-PANEL_LINES).join("\n");
  return kept.length > 2000 ? kept.slice(-2000) : kept;
};
// The company's secrets, decrypted once for a whole answer. A long run has up
// to 200 steps and 40 commands to mask on every poll, and decrypting every
// secret again for each of them grew with both.
const masker = (company) => {
  const secrets = [];
  for (const row of all(
    "SELECT value FROM secrets WHERE company_id=?",
    company,
  ))
    try {
      const secret = decrypt(row.value);
      if (secret && secret.length > 3) secrets.push(secret);
    } catch {
      // A secret this server cannot read cannot appear in a command either.
    }
  return (text) => {
    if (!text) return text;
    let out = String(text);
    for (const secret of secrets) out = out.split(secret).join("••••••");
    return out;
  };
};
app.get("/api/computers/:id/terminal", (req, res) => {
  can(req.member, "computers");
  const masked = masker(req.company.id);
  const c = tenant("computers", req.params.id, req.company.id);
  // The run this panel belongs to, so one person's terminal is not shown
  // beside another person's message.
  const job = z
    .string()
    .uuid()
    .optional()
    .parse(req.query.job || undefined);
  const jobFilter = job
    ? ` AND (a.job_id=? OR a.job_id IN (
          SELECT sibling.id FROM jobs sibling
          WHERE sibling.conversation_id=(
            SELECT current.conversation_id FROM jobs current
            JOIN duck_consultations consultation ON consultation.child_job_id=current.id
            WHERE current.id=?
          )
        ))`
    : "";
  const rows = all(
    "SELECT a.id,a.created,a.state,a.command,r.result FROM computer_actions a " +
      "LEFT JOIN tool_receipts r ON r.job_id=a.job_id AND a.id=a.job_id||':'||r.call_id " +
      "WHERE a.computer_id=? AND a.tool='terminal'" +
      jobFilter +
      " ORDER BY a.rowid DESC LIMIT 20",
    ...(job ? [c.id, job, job] : [c.id]),
  );
  // How many there are altogether, so the panel can say it is showing the last
  // few of them rather than presenting its own window as the whole story.
  const total = one(
    "SELECT count(*) n FROM computer_actions WHERE computer_id=? AND tool='terminal'" +
      (job
        ? ` AND (job_id=? OR job_id IN (
              SELECT sibling.id FROM jobs sibling
              WHERE sibling.conversation_id=(
                SELECT current.conversation_id FROM jobs current
                JOIN duck_consultations consultation ON consultation.child_job_id=current.id
                WHERE current.id=?
              )
            ))`
        : ""),
    ...(job ? [c.id, job, job] : [c.id]),
  ).n;
  // The run's own notes, every one of them, for the steps on its card. Only for
  // one run: a list of steps from every run this computer ever had is not the
  // story of anything.
  const { steps, earlier } = job
    ? stepsOf(
        all(
          "SELECT a.checkpoint note,a.created at,a.state FROM computer_actions a WHERE a.computer_id=?" +
            jobFilter +
            " ORDER BY a.rowid",
          c.id,
          job,
          job,
        ),
        c.checkpoint_job_id === job
          ? { note: c.checkpoint, at: c.checkpoint_at }
          : null,
      )
    : { steps: [], earlier: 0 };
  res.json({
    total,
    steps: steps.map((s) => ({ ...s, note: masked(s.note) })),
    earlier_steps: earlier,
    commands: rows.reverse().map((a) => {
      let result = {};
      try {
        result = a.result ? JSON.parse(a.result) : {};
      } catch {
        result = {};
      }
      // A finished command has its receipt, which is the final and capped
      // truth. One still running has no receipt at all - it has whatever has
      // arrived so far, which is the whole reason somebody is looking.
      const arriving = a.result ? null : outputSoFar(a.id);
      const body = arriving
        ? [arriving.stdout, arriving.stderr].filter(Boolean).join("\n")
        : [result.stdout, result.stderr].filter(Boolean).join("\n");
      return {
        id: a.id,
        at: a.created,
        state: a.state,
        command: masked(a.command) || "",
        // Long output belongs in the receipt the duck reads, not on a panel
        // somebody is glancing at. The end is the part that says what happened,
        // and it is capped by lines as well as by characters: one curl of a
        // web page returns hundreds of short lines, and without the line cap
        // that single command filled the whole panel and pushed every other
        // command out of sight.
        output: masked(tail(body)),
        clipped: tail(body) !== body,
        // The receipt itself stops at 20000 characters of stdout and 10000 of
        // stderr. A panel that trimmed a tail off a result that had already
        // been cut would show a clipped thing twice over and say so once, so
        // the two are kept apart: this one means the duck did not see the rest
        // either.
        truncated: !!result.output_truncated,
        // A command its timeout stopped came back with its output cut off and
        // nothing else - no status line at all, which is exactly what a clean
        // success looks like. The receipt has known this all along.
        timed_out: !!result.timed_out,
        exit_code: result.exit_code ?? null,
      };
    }),
  });
});
// What taking this duck off the team would stop, asked for by the dialog that
// is about to ask. Not in the state payload: it is three counting queries per
// duck and that payload is fetched about once a second while a duck is working.
app.get("/api/ducks/:id/removal", (req, res) => {
  can(req.member, "ducks");
  res.json(whatRemovalStops(tenant("ducks", req.params.id, req.company.id)));
});
app.patch("/api/ducks/:id/removed", async (req, res) => {
  can(req.member, "ducks");
  const duck = tenant("ducks", req.params.id, req.company.id);
  const a = z.object({ removed: z.boolean() }).parse(req.body);
  res.json(await setRemoved(duck, a.removed, req.user.id));
});
registerChat(app);
app.post("/api/inbox/:id/ignore", (req, res) => {
  const msg = one(
    "SELECT m.id FROM messages m JOIN inbox i ON i.message_id=m.id WHERE m.id=? AND m.company_id=? AND i.user_id=?",
    req.params.id,
    req.company.id,
    req.user.id,
  );
  if (!msg) fail(404, "Message not found.");
  run(
    "UPDATE inbox SET state='ignored' WHERE message_id=? AND user_id=?",
    msg.id,
    req.user.id,
  );
  emit(req.company.id);
  res.json({ ok: true });
});
app.post("/api/jobs/:id/steer", async (req, res) => {
  can(req.member, "chat");
  if (req.company.paused) fail(409, "The flock is paused.");
  const job = tenant("jobs", req.params.id, req.company.id);
  if (job.user_id !== req.user.id)
    fail(403, "You can only steer your own request.");
  conversationFor(job.conversation_id, req.company.id, req.user.id);
  res.json(await steerJob(job));
});
app.patch("/api/conversations/:id/archive", async (req, res) => {
  can(req.member, "chat");
  const conv = conversationFor(req.params.id, req.company.id, req.user.id);
  if (conv.kind !== "group") fail(400, "Only channels can be archived.");
  if (conv.creator_id !== req.user.id && !permissions(req.member).company)
    fail(403, "Only the channel creator or a company admin can archive it.");
  const a = z.object({ archived: z.boolean() }).parse(req.body);
  const stopped = await setArchived(conv, a.archived, req.user.id);
  audit(
    req.company.id,
    req.user.id,
    a.archived ? "Channel archived" : "Channel restored",
    stopped ? conv.name + " (" + stopped + " stopped)" : conv.name,
  );
  emit(req.company.id);
  res.json({ ok: true, stopped });
});
registerRecoveryCancel(app, { cancelJob });
registerRecoveryActions(app, { enqueue, aiStatus });
app.post("/api/jobs/:id/retry", async (req, res) => {
  can(req.member, "chat");
  const job = tenant("jobs", req.params.id, req.company.id);
  if (job.checkin)
    fail(409, "Use Check now in Chief check-in settings to start a new check.");
  if (job.task_id) assertLegacyTask(job.task_id);
  if (job.user_id !== req.user.id)
    fail(403, "Only the person who started this run can retry it.");
  if (req.company.paused) fail(409, "Resume your flock first.");
  // Archiving a channel stops all work in it, and a duck taken out of a
  // channel no longer answers there. Trying an old failure again was the one
  // way round both: the duck went back to work where nobody could reply.
  const conv = job.conversation_id
    ? one(
        "SELECT kind,archived FROM conversations WHERE id=?",
        job.conversation_id,
      )
    : null;
  if (conv?.archived)
    fail(409, "This channel is archived. Unarchive it first to try again.");
  if (
    conv?.kind === "group" &&
    !one(
      "SELECT 1 FROM conversation_ducks WHERE conversation_id=? AND duck_id=?",
      job.conversation_id,
      job.duck_id,
    )
  )
    fail(
      409,
      "This duck is no longer in this channel. Add it back under Members to try again.",
    );
  // steer_unknown belongs here too: it means a steer's acknowledgement was
  // lost, so the work was deliberately held rather than risk doing it twice.
  // Retrying is exactly what the person wants, and the chat already offered the
  // button while the server refused it.
  if (
    !["error", "interrupted", "cancelled", "steer_unknown"].includes(
      job.status,
    ) &&
    !(job.status === "done" && recoverySummary(job))
  )
    fail(409, "This run cannot be retried.");
  const refused = duckRefusalFor(await aiStatus(req.company.id), req.member);
  if (refused) fail(409, refused);
  // Checked after the await, not before it. With the question about the AI
  // connection in between, two clicks on Retry both got past this and the duck
  // did the whole thing twice. Nothing can interleave between here and the
  // enqueue below, so this now means what it says.
  if (
    one(
      "SELECT 1 FROM jobs WHERE input_message_id=? AND duck_id=? AND status IN ('queued','running','waiting_human','waiting_consultation')",
      job.input_message_id,
      job.duck_id,
    )
  )
    fail(409, "A retry is already queued.");
  // Tried again already, and that try has finished. Another press here would
  // do the whole job again - a second answer, and any email, ticket or file a
  // second time. The card stops offering it; this is for a page that has not
  // caught up.
  if (
    job.input_message_id &&
    one(
      "SELECT 1 FROM jobs WHERE input_message_id=? AND duck_id=? AND id<>? AND created>?",
      job.input_message_id,
      job.duck_id,
      job.id,
      job.created,
    )
  )
    fail(
      409,
      "This was already tried again. What happened is further down in the chat.",
    );
  assertManualRecoveryAllowed(job);
  res.json({
    id: enqueue(
      job.company_id,
      job.user_id,
      job.conversation_id,
      job.duck_id,
      job.input_message_id,
      {
        taskId: job.task_id,
        acknowledge: false,
        recoveryRoot: job.recovery_root_job_id || null,
        manualRecovery: true,
      },
    ),
  });
});
const taskSchema = z.object({
  title,
  description: long.default(""),
  assignee_id: uuid.nullable().default(null),
  status: z.enum(["open", "working", "done"]).default("open"),
  priority: z.enum(["low", "normal", "high"]).default("normal"),
  result: long.default(""),
});
app.post("/api/tasks", (req, res) =>
  withTicketActor(req.company.id, { user_id: req.user.id }, () => {
    can(req.member, "tasks");
    const a = taskSchema.parse(req.body);
    if (a.assignee_id) onTeam(a.assignee_id, req.company.id);
    const task = id();
    run(
      "INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?,?,?,?)",
      task,
      req.company.id,
      a.title,
      a.description,
      a.assignee_id,
      a.status,
      a.priority,
      req.user.id,
      a.result,
      now(),
      now(),
    );
    audit(req.company.id, req.user.id, "Task created", a.title);
    res.json({ id: task });
  }),
);
// The brief and the handoff notes in full, which the workspace payload leaves
// out. One ticket, asked for when somebody opens it.
app.get("/api/tasks/:id", (req, res) => {
  // No permission check beyond belonging to the company: the list above hands
  // every member the same ticket, and this is the same ticket with its long
  // text whole. Requiring the manage permission here meant somebody who could
  // see a ticket but not edit it read a brief that stopped at 240 characters
  // with an ellipsis and no way to see the rest.
  res.json(tenant("tasks", req.params.id, req.company.id));
});
app.patch("/api/tasks/:id", (req, res) =>
  withTicketActor(req.company.id, { user_id: req.user.id }, () => {
    can(req.member, "tasks");
    const old = tenant("tasks", req.params.id, req.company.id);
    assertLegacyTask(old.id);
    // An editor that has been open a while holds the ticket as it was when it
    // opened, and it sends every field back. Without this, two people on one
    // ticket meant the later save quietly put back the older values of every
    // field it was not touching: one sets the priority, the other fixes a typo
    // a minute later and the priority goes back, with nothing said to either of
    // them. Skills and documents in this same product both refuse a stale save
    // and say so; tickets did not. The check is only made when the editor sends
    // what it loaded, so a duck saving one field is unaffected.
    const { updated: loaded, opened, ...fields } = req.body || {};
    if (editedSinceOpened(old, { updated: loaded, opened }))
      fail(
        409,
        "Someone else changed this ticket while you had it open, so nothing was saved. Your changes are still in the editor.",
      );
    const a = taskSchema.parse({ ...old, ...fields });
    if (a.assignee_id) onTeam(a.assignee_id, req.company.id);
    run(
      "UPDATE tasks SET title=?,description=?,assignee_id=?,status=?,priority=?,result=?,updated=? WHERE id=?",
      a.title,
      a.description,
      a.assignee_id,
      a.status,
      a.priority,
      a.result,
      now(),
      old.id,
    );
    audit(req.company.id, req.user.id, "Task updated", {
      title: a.title,
      status: a.status,
    });
    res.json({ ok: true });
  }),
);
app.post("/api/tasks/:id/run", async (req, res) => {
  can(req.member, "chat");
  can(req.member, "tasks");
  const task = tenant("tasks", req.params.id, req.company.id);
  assertLegacyTask(task.id);
  if (req.company.paused) fail(409, "Resume the flock before starting tasks.");
  if (!task.assignee_id) fail(400, "Assign a duck to this task first.");
  const working = () =>
    one(
      "SELECT 1 FROM jobs WHERE task_id=? AND status IN ('queued','running','waiting_human','waiting_consultation')",
      task.id,
    );
  // Answer the easy no before the slow part, so somebody pressing a button on a
  // task that is plainly already going is told straight away.
  if (working()) fail(409, "This task is already running.");
  const refused = duckRefusalFor(await aiStatus(req.company.id), req.member);
  if (refused) fail(409, refused);
  const duck = onTeam(task.assignee_id, req.company.id);
  // The ticket's own conversation, not a private chat between whoever pressed
  // the button and the duck. Work that came from a ticket used to arrive as a
  // message the person had never written, in their own direct messages, and the
  // duck answered there - so the board said nothing and the answer was in a
  // thread with no connection to it.
  const conv = ticketConversation(req.company.id, task, duck);
  const job = db.transaction(() => {
    // And ask again in here. Two people on one ticket both press "Ask duck to
    // work" in the same second; both get past the check above and both then
    // wait on aiStatus, which really waits. Whoever's turn comes second used to
    // start a second run in their own chat with the duck, and the whole task
    // was done twice — every email it sends, sent twice — with each person
    // seeing only their own thread. This block is synchronous, so nothing can
    // slip between this check and the enqueue below it.
    if (working()) fail(409, "This task is already running.");
    const message = addMessage(
      req.company.id,
      conv.id,
      `Please work on this task: ${task.title}\n\n${task.description}\n\nTask ID: ${task.id}. Update the task when you are done, and ask if you need anything. Save a document only if there is something worth keeping - a short answer belongs in your reply, not in a file nobody asked for.`,
      { user: req.user.id, origin: "workflow" },
    );
    run(
      "UPDATE tasks SET status='open',updated=? WHERE id=? AND status='done' AND company_id=?",
      now(),
      task.id,
      req.company.id,
    );
    return enqueue(req.company.id, req.user.id, conv.id, duck.id, message, {
      taskId: task.id,
    });
  })();
  res.json({ id: job, conversation_id: conv.id });
});
app.get("/api/documents/:id", (req, res) =>
  res.json(tenant("documents", req.params.id, req.company.id)),
);
app.post("/api/documents", (req, res) => {
  can(req.member, "docs");
  const a = z
    .object({
      title,
      content: long,
      conversation_id: z.string().uuid().optional(),
      folder_id: z.string().uuid().nullable().optional(),
    })
    .parse(req.body);
  if (a.conversation_id)
    conversationFor(a.conversation_id, req.company.id, req.user.id);
  const doc = id();
  if (a.folder_id !== undefined)
    validateFolderDestination(
      {
        company_id: req.company.id,
        user_id: req.user.id,
        ...(a.conversation_id
          ? { conversation_id: a.conversation_id, id: "document-create-route" }
          : {}),
      },
      a.folder_id,
      { kind: "document", id: doc, allow_missing: true },
    );
  db.transaction(() => {
    const version = nextDocumentVersion(null);
    run(
      "INSERT INTO documents VALUES(?,?,?,?,?,?,?,?)",
      doc,
      req.company.id,
      a.title,
      a.content,
      null,
      req.user.id,
      version,
      version,
    );
    if (a.conversation_id)
      run(
        "INSERT INTO document_conversations VALUES(?,?)",
        doc,
        a.conversation_id,
      );
    if (a.folder_id !== undefined)
      documentFolder(
        {
          company_id: req.company.id,
          user_id: req.user.id,
          ...(a.conversation_id
            ? { conversation_id: a.conversation_id, id: "document-create-route" }
            : {}),
        },
        doc,
        a.folder_id,
      );
  })();
  audit(req.company.id, req.user.id, "Document created", a.title);
  res.json({ id: doc });
});
app.patch("/api/documents/:id", (req, res) => {
  can(req.member, "docs");
  const old = tenant("documents", req.params.id, req.company.id);
  const a = z
    .object({
      title,
      content: long,
      updated: z.string().min(1),
      folder_id: z.string().uuid().nullable().optional(),
    })
    .parse(req.body);
  const version = nextDocumentVersion(old.updated);
  const folderContext = { company_id: req.company.id, user_id: req.user.id };
  if (a.folder_id !== undefined)
    validateFolderDestination(folderContext, a.folder_id, {
      kind: "document",
      id: old.id,
      allow_missing: false,
    });
  const change = db.transaction(() => {
    const updated = run(
      "UPDATE documents SET title=?,content=?,updated=? WHERE id=? AND updated=?",
      a.title,
      a.content,
      version,
      old.id,
      a.updated,
    );
    if (updated.changes && a.folder_id !== undefined)
      documentFolder(folderContext, old.id, a.folder_id);
    return updated;
  })();
  if (!change.changes)
    fail(
      409,
      "Someone edited this document. Reopen it to load the latest version before saving.",
    );
  audit(req.company.id, req.user.id, "Document updated", a.title);
  res.json({ ok: true });
});
// Sending an invitation, the first time or again. One door, so Send again keeps
// every rule the first send has: three to one address in a quarter of an hour,
// only the owner invites admins, nobody already on the team, and a new link
// retires the one before it (two live links to one seat is worse than one).
function sendInvitation(req, { email: address, role: as }, said) {
  // Per address, the same as asking for a sign-in link. This sends to an
  // address the caller chooses, on our letterhead, and the only other limit on
  // it counts requests by the person making them - so one member with the team
  // permission could make a stranger's inbox buzz as often as they liked and
  // it would be our name on all of it.
  if (tooMany("invite:" + address, 3))
    fail(
      429,
      "That address has been invited several times just now. Give it a few minutes.",
    );
  if (as === "admin" && req.member.role !== "owner")
    fail(403, "Only the owner can invite admins.");
  if (
    one(
      "SELECT 1 FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.company_id=? AND u.email=?",
      req.company.id,
      address,
    )
  )
    fail(409, "That person is already on the team.");
  const value = token();
  const created = Date.now();
  db.transaction(() => {
    run(
      "UPDATE invites SET accepted=1,token_enc=NULL WHERE company_id=? AND email=?",
      req.company.id,
      address,
    );
    // The link is kept encrypted, for Copy link. It is still checked by its
    // hash alone.
    run(
      "INSERT INTO invites(token_hash,id,company_id,email,role,permissions,created_by,created,expires,accepted,token_enc) VALUES(?,?,?,?,?,'{}',?,?,?,0,?)",
      hash(value),
      id(),
      req.company.id,
      address,
      as,
      req.user.id,
      created,
      created + 7 * 86400000,
      encrypt(value),
    );
  })();
  // audit() also tells every open page, so another Team page shows it.
  audit(req.company.id, req.user.id, said, address);
  const url = APP_URL + "/invite#" + value;
  // Sent, rather than handed to the owner to deliver themselves. The link is
  // still returned: somebody may want to pass it on another way, and the
  // screen shows it.
  notices
    .invited({
      company: req.company.id,
      invitedBy: req.user.id,
      email: address,
      link: url,
    })
    .catch((e) => console.error("Invitation email:", e.message));
  return url;
}
app.post("/api/invites", (req, res) => {
  can(req.member, "team");
  const a = z.object({ email, role }).parse(req.body);
  res.json({ url: sendInvitation(req, a, "Invitation created") });
});
const stillWaiting = (req) =>
  one(
    "SELECT * FROM invites WHERE id=? AND company_id=? AND accepted=0",
    req.params.id,
    req.company.id,
  ) || fail(404, "This invitation is no longer waiting.");
// Send again, from Team > Waiting to join: a new link, for one that is still
// waiting or one that ran out.
app.post("/api/invites/:id/again", (req, res) => {
  can(req.member, "team");
  sendInvitation(req, stillWaiting(req), "Invitation sent again");
  res.json({ ok: true });
});
// Copy link. The id is in the path and the token only in the answer, which is
// never cached. Written down, as reading a secret is: a kept link is a way in.
app.get("/api/invites/:id/link", (req, res) => {
  can(req.member, "team");
  const row = stillWaiting(req);
  if (row.expires <= Date.now())
    fail(410, "This invitation ran out. Send it again for a new link.");
  if (row.role === "admin" && req.member.role !== "owner")
    fail(403, "Only the owner can invite admins.");
  if (!row.token_enc)
    fail(
      409,
      "This link was made before links were kept. Send it again for a new one.",
    );
  audit(req.company.id, req.user.id, "Invitation link copied", row.email);
  res.json({ url: APP_URL + "/invite#" + decrypt(row.token_enc) });
});
app.delete("/api/invites/:id", (req, res) => {
  can(req.member, "team");
  const row = one(
    "SELECT email FROM invites WHERE id=? AND company_id=?",
    req.params.id,
    req.company.id,
  );
  run(
    "DELETE FROM invites WHERE id=? AND company_id=?",
    req.params.id,
    req.company.id,
  );
  if (row) audit(req.company.id, req.user.id, "Invitation revoked", row.email);
  emit(req.company.id);
  res.json({ ok: true });
});
app.patch("/api/members/:id", (req, res) => {
  if (req.member.role !== "owner")
    fail(403, "Only the company owner can change member permissions.");
  const old = memberFor(req.company.id, req.params.id);
  if (!old) fail(404, "Member not found.");
  if (old.role === "owner") fail(400, "The owner always retains full access.");
  const a = z
    .object({
      role,
      permissions: z.record(z.string(), z.boolean()).default({}),
    })
    .parse(req.body);
  // Every key the permissions editor shows. It sends all of them on every save,
  // so anything missing here rejected the whole request, role included, and no
  // member's permissions could be saved at all.
  const allowed = Object.keys(defaultPermissions.owner);
  if (Object.keys(a.permissions).some((k) => !allowed.includes(k)))
    fail(400, "Unknown permission.");
  run(
    "UPDATE memberships SET role=?,permissions=? WHERE company_id=? AND user_id=?",
    a.role,
    JSON.stringify(a.permissions),
    req.company.id,
    req.params.id,
  );
  audit(req.company.id, req.user.id, "Member permissions updated", {
    member: req.params.id,
    role: a.role,
  });
  res.json({ ok: true });
});
app.delete("/api/members/:id", async (req, res) => {
  if (req.member.role !== "owner")
    fail(403, "Only the owner can remove teammates.");
  const old = memberFor(req.company.id, req.params.id);
  if (!old || old.role === "owner") fail(400, "This member cannot be removed.");
  // Named rather than looped over inline, because each one has to be stamped
  // with who did this before it is stopped. The person is the owner doing the
  // removing, never req.params.id - that is whose runs are ending.
  const theirs = all(
    "SELECT * FROM jobs WHERE company_id=? AND user_id=? AND status IN ('running','queued','waiting_human','waiting_consultation')",
    req.company.id,
    req.params.id,
  );
  for (const job of theirs) recordStopper(job.id, req.user.id);
  for (const job of theirs) await cancelJob(job);
  run(
    "DELETE FROM memberships WHERE company_id=? AND user_id=?",
    req.company.id,
    req.params.id,
  );
  run(
    "DELETE FROM sessions WHERE company_id=? AND user_id=?",
    req.company.id,
    req.params.id,
  );
  // A channel needs one duck or one other person to be made, so a channel with
  // exactly one human in it is ordinary. Taking that human out of it left it
  // with nobody: every way of reading a conversation joins the membership of
  // whoever is asking, so the channel disappeared from every sidebar, from
  // Archived channels and from search, for everybody including the owner, with
  // nothing anywhere saying it had ever existed. Months of work could go that
  // way on one click.
  //
  // The product already refuses this end state when somebody walks into it by
  // hand: leaving a channel yourself answers "This is the last person in the
  // channel. Add somebody else first, or archive the channel." The two doors
  // to the same place disagreed. This one hands those channels to whoever did
  // the removing, so they are still there to read, to add people to, or to
  // archive deliberately.
  const orphaned = all(
    "SELECT c.id,c.name FROM conversations c JOIN conversation_members cm ON cm.conversation_id=c.id " +
      "WHERE c.company_id=? AND c.kind='group' AND cm.user_id=? " +
      "AND NOT EXISTS(SELECT 1 FROM conversation_members o WHERE o.conversation_id=c.id AND o.user_id<>?)",
    req.company.id,
    req.params.id,
    req.params.id,
  );
  run(
    "DELETE FROM conversation_members WHERE user_id=? AND conversation_id IN (SELECT id FROM conversations WHERE company_id=?)",
    req.params.id,
    req.company.id,
  );
  for (const c of orphaned)
    run(
      "INSERT OR IGNORE INTO conversation_members VALUES(?,?)",
      c.id,
      req.user.id,
    );
  audit(req.company.id, req.user.id, "Teammate removed", {
    member: req.params.id,
    ...(orphaned.length ? { kept: orphaned.map((c) => c.name) } : {}),
  });
  res.json({ ok: true });
});
registerSecrets(app);
registerConnections(app);
registerActivity(app);
app.post("/api/approvals/:id/decide", async (req, res) => {
  can(req.member, "approvals");
  const approval = tenant("approvals", req.params.id, req.company.id);
  // "changes" sends the ask back to the duck with the person's note, the way
  // Chief's skill and board asks already could be.
  const a = z
    .object({
      decision: z.enum(["approve", "deny", "changes"]),
      note: z.string().trim().max(2000).optional(),
    })
    .parse(req.body);
  if (a.decision === "changes" && !a.note) fail(400, "Say what to change.");
  if (a.decision === "approve" && deploymentDrainRequested())
    fail(
      503,
      "TameDuck is being updated. Please try this approval again shortly.",
    );
  if (approval.status !== "pending")
    fail(409, "This request has already been handled.");
  if (req.company.paused && a.decision === "approve")
    fail(409, "Resume the company before approving tools.");
  const job = tenant("jobs", approval.job_id, req.company.id);
  const helperConsultation = consultationForChild(job.id);
  if (helperConsultation) assertConsultationActive(job);
  // Stopping a run cancels its pending requests, so this is the narrow case of
  // somebody pressing Stop while somebody else is on the approval screen.
  if (job.status === "cancelled")
    fail(
      409,
      "The run that asked for this was stopped, so the tool was not used.",
    );
  const status =
    a.decision === "approve"
      ? "executing"
      : a.decision === "changes"
        ? "changes_requested"
        : "denied";
  // This check and the durable executing transition are synchronous, so
  // health cannot report ready while an approved external call is starting.
  if (a.decision === "approve" && deploymentDrainRequested())
    fail(
      503,
      "TameDuck is being updated. Please try this approval again shortly.",
    );
  const claimed = run(
    "UPDATE approvals SET status=?,decided_by=?,updated=? WHERE id=? AND status='pending'",
    status,
    req.user.id,
    now(),
    approval.id,
  );
  if (!claimed.changes) fail(409, "Another teammate handled this request.");
  let result = "The tool request was declined.";
  let outcome = "denied";
  if (a.decision === "changes") {
    result = a.note;
    outcome = "changes_requested";
  }
  if (a.decision === "approve") {
    try {
      const response = await executeApproved(approval, req.user.id);
      result = response.output;
      outcome = response.isError ? "failed" : "executed";
    } catch (e) {
      outcome = e.toolNotSent ? "failed" : "unknown";
      result = e.toolNotSent
        ? "The tool was not sent: " + e.message
        : "The tool did not report success: " +
          e.message +
          ". Check the connected service before requesting it again.";
    }
  }
  run(
    "UPDATE approvals SET status=?,result=?,updated=? WHERE id=?",
    outcome,
    result,
    now(),
    approval.id,
  );
  audit(
    req.company.id,
    req.user.id,
    "Tool approval " + outcome,
    { tool: approval.tool, summary: approval.summary },
    { duck: job.duck_id, job: job.id },
  );
  const message =
    a.decision === "changes"
      ? // The note is the person's own words, so it is posted as theirs, as it
        // is: it reads as theirs in chat, and the duck gets it as the next
        // thing said.
        addMessage(job.company_id, job.conversation_id, a.note, {
          user: req.user.id,
          thread: job.thread_id || null,
        })
      : addMessage(
          job.company_id,
          job.conversation_id,
          `Tool request **${approval.tool}**: ${outcome}.\n\n${result.slice(0, 20000)}`,
          // Marked as the tool's own, not as something this person wrote. The
          // duck still reads the whole answer from the transcript; chat shows
          // a line and keeps the service's JSON behind a disclosure, because
          // whoever pressed Approve did not type sixty thousand characters of
          // it.
          { user: req.user.id, origin: "tool", thread: job.thread_id || null },
        );
  // By this point the tool has really run and been recorded. Anything that goes
  // wrong from here is about resuming the duck, not about the decision, and
  // reporting it as a failed approval told people their approval had not
  // happened when the email had already gone out.
  let warning = "";
  if (helperConsultation) {
    try {
      continueConsultationAfterApproval(job, message);
    } catch (e) {
      warning =
        "The tool decision was recorded, but the delegated work could not continue: " +
        e.message;
    }
  } else if (!memberFor(job.company_id, job.user_id))
    warning = "The person who started this task is no longer in the company.";
  else if (!permissions(memberFor(job.company_id, job.user_id)).chat)
    warning =
      "The person who started this task can no longer chat with ducks, so it was not carried on.";
  else if (req.company.paused)
    warning =
      // Nothing was queued, so resuming the flock revives nothing. Saying it
      // would carry on sent people to unpause and wait for a task that was
      // never coming back.
      "The ducks are paused, so this task stopped here. Start them again and ask this duck to carry on; it will not restart on its own.";
  else
    try {
      enqueue(
        job.company_id,
        job.user_id,
        job.conversation_id,
        job.duck_id,
        message,
        { taskId: job.task_id, acknowledge: false },
      );
    } catch (e) {
      warning = "The duck could not be started again: " + e.message;
    }
  if (warning)
    addMessage(
      job.company_id,
      job.conversation_id,
      // Only say the tool ran when it ran. Declining posted "declined" and then,
      // directly underneath, "The tool ran, but this task did not carry on" -
      // so somebody who had just refused an email went looking in the CRM for
      // the email they had refused. The same false line fired whenever the
      // person who asked had left.
      (outcome === "executed" || outcome === "failed"
        ? "The tool ran, but this task did not carry on. "
        : outcome === "denied" || outcome === "changes_requested"
          ? "Nothing was run, and this task did not carry on. "
          : "This task did not carry on. ") + warning,
      { user: req.user.id, thread: job.thread_id || null },
    );
  res.json({ ok: true, status: outcome, warning: warning || undefined });
});
app.get("/api/export", (req, res) => {
  can(req.member, "company");
  const c = req.company.id;
  const data = {
    company: req.company,
    ai: configSummary(c),
    ducks: all("SELECT * FROM ducks WHERE company_id=?", c),
    workflows: workflowSummary(c, req.user.id),
    schedules: permissions(req.member).tasks ? listSchedules(c) : [],
    tasks: all("SELECT * FROM tasks WHERE company_id=?", c),
    ticket_activity: all(
      "SELECT * FROM ticket_activity WHERE company_id=? ORDER BY id",
      c,
    ),
    documents: all("SELECT * FROM documents WHERE company_id=?", c),
    // File contents stay encrypted on the server; the export lists what exists.
    uploads: all(
      "SELECT id,conversation_id,user_id,message_id,name,mime,size,created FROM uploads WHERE company_id=?",
      c,
    ),
    skills: all("SELECT * FROM skills WHERE company_id=?", c),
    skill_assignments: listSkills(c).map((s) => ({ id: s.id, ducks: s.ducks })),
    skill_proposals: all("SELECT * FROM skill_proposals WHERE company_id=?", c),
    board_proposals: all("SELECT * FROM board_proposals WHERE company_id=?", c),
    board_access: all("SELECT * FROM board_grants WHERE company_id=?", c),
    exported_at: now(),
  };
  res
    .set("Content-Disposition", 'attachment; filename="tameduck-company.json"')
    .json(data);
});
registerSkills(app);
registerSkillCatalog(app);
registerSkillProposals(app, { enqueue });
registerBoardProposals(app, { enqueue });
// What a person is told when they try to start a computer with no AI to use it.
const withoutAI = async (req) =>
  refusalWithoutAI(await aiStatus(req.company.id), req.member);
registerComputers(app, { withoutAI });
registerWorkflows(app, { aiStatus, enqueue });
registerBoardArchive(app);
registerSchedules(app, { aiStatus, enqueue });
registerChiefCheckins(app, { aiStatus, enqueue, ...chiefCheckinDeps });
registerScheduleProposals(app, { enqueue, createSchedule });
registerTicketActivity(app);
registerComputerControl(app, { pauseDuckJobs, withoutAI });
registerHumanInput(app, { pauseDuckJobs, closeControl });
registerConnectionBlocks(app, { enqueue });
registerNativeDesktopHttp(app, { validStream });
registerHumanWaitSettings(app);
registerWorkLimits(app);
registerDuckSettings(app);
registerDuckWebhooks(app, { enqueue, aiStatus });
registerUploads(app);
registerFileFolders(app);
registerCompanyLogo(app);
registerStorage(app);
registerOnboarding(app);
registerEmailSettings(app);
registerComputerLimits(app);
registerBilling(app, { community });
app.use("/api", (req, res) =>
  res.status(404).json({ error: "This action was not found." }),
);
// The workspace preview under the hero on the home page, and the only page on
// this origin that may be framed. Everything else keeps frame-ancestors 'none'
// on purpose: the app has Approve buttons on it, and a page that can be framed
// can be clickjacked into having them pressed. This one holds no data, reaches
// no API and has no action - it is captured markup and a stylesheet - and only
// our own pages may frame it.
app.get("/demo.html", (req, res, next) => {
  res.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "frame-ancestors 'self'",
      `script-src 'self' ${analyticsSources.join(" ")}`.trim(),
      "style-src 'self' 'unsafe-inline'",
      `img-src 'self' data: ${analyticsSources.join(" ")}`.trim(),
      `connect-src 'self' ${analyticsSources.join(" ")}`.trim(),
      "font-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'none'",
    ].join(";"),
  );
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  next();
});
// The one folder here that exists to be loaded from somewhere else. Helmet
// puts Cross-Origin-Resource-Policy: same-origin on everything, which is right
// for an app and wrong for a picture whose whole job is to be fetched by
// somebody else's mail client showing our email. Chromium refuses it with
// ERR_BLOCKED_BY_RESPONSE.NotSameOrigin, and anything else that honours the
// header does the same - so the logo at the top of every message we send was a
// broken square for any reader that is not this site. Only /brand, and only
// this header.
app.use("/brand", (req, res, next) => {
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  next();
});
app.use(
  express.static(path.join(root, "dist"), {
    index: false,
    maxAge: "1h",
    setHeaders: cacheHeadersFor(root),
  }),
);
const signedIn = (req) => {
  const value = req.cookies?.td_session;
  return (
    !!value &&
    !!one(
      "SELECT 1 FROM sessions WHERE token_hash=? AND expires>?",
      hash(value),
      Date.now(),
    )
  );
};
registerWebPages(app, {
  root,
  signedIn,
});
// Spent and expired links are rubbish within the quarter hour. Swept on the
// way past rather than on a timer, so a server nobody visits does no work.
setInterval(sweepSignInLinks, 6 * 3600000).unref();
app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  if (error instanceof z.ZodError)
    return res.status(400).json({
      error: error.issues
        .map((x) => x.message)
        .slice(0, 3)
        .join(" "),
    });
  if (error.code === "SQLITE_CONSTRAINT_UNIQUE")
    return res
      .status(409)
      .json({ error: "An item with those details already exists." });
  if (error.status)
    return res.status(error.status).json({
      error: error.publicMessage || error.message,
      ...(error.request_id ? { request_id: error.request_id } : {}),
    });
  console.error(new Date().toISOString(), req.method, req.path, error.message);
  res.status(500).json({ error: "Something went wrong. Please try again." });
});
// Native startup shares this verification gate, including background jobs and
// direct runtime construction. The HTTP app and API-key providers stay usable
// while native execution waits for verified isolation.
initializeNativeRuntimeSafety();

// A server started only to be photographed, or to check one route, should not
// also start doing a company's work. There is no real AI behind it, so every
// ticket it picks up fails, and the screens fill with "Needs attention" that
// nobody's actual workspace has. Off by default: this has to be asked for.
if (process.env.NO_BACKGROUND_WORK !== "1") {
  startWorker();
  startComputerJanitor();
  recoverTicketReplies();
  startWorkflowEngine({
    aiStatus,
    enqueue,
    tickTicketReplies: () =>
      tickTicketReplies({ aiStatus, enqueue, steerTicketJob }),
  });
  startScheduleEngine({ aiStatus, enqueue });
  startWebhookReplies();
  startChiefCheckinEngine({ aiStatus, enqueue, ...chiefCheckinDeps });
  startWaitingSweep();
  startConnectionBlocks();
  startWebPushPoller({ appUrl: APP_URL });
  startBillingEngine();
}
const httpServer = app.listen(port, "127.0.0.1", () =>
  console.log("TameDuck listening on " + port),
);

registerComputerStream(httpServer, APP_URL);
