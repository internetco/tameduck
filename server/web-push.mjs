import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import webpush from "web-push";
import { DATA, db, all, one, run, memberFor, permissions, fail } from "./store.mjs";
import { notifiableMessageSql } from "./chat-store.mjs";

const KEY_FILE = path.join(DATA, "web-push-vapid.json");
const POLL_MS = 30_000;
const MAX_EVENT_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_EVENTS_PER_SUBSCRIPTION = 5;
let vapid;
let polling = false;

// Web Push endpoints are bearer capabilities. Restrict outbound requests to
// known browser push services so a submitted endpoint cannot probe our network.
export function validPushEndpoint(value) {
  if (typeof value !== "string" || value.length > 4096) return false;
  let url;
  try { url = new URL(value); } catch { return false; }
  if (url.protocol !== "https:" || url.port || url.username || url.password || url.hash)
    return false;
  const host = url.hostname.toLowerCase();
  if (host === "fcm.googleapis.com") return !url.search && /^\/fcm\/send\/[A-Za-z0-9_~!$&'()+,;=:@%/-]+$/.test(url.pathname);
  if (host === "updates.push.services.mozilla.com" || host === "push.services.mozilla.com")
    return !url.search && /^\/wpush\/v\d+\/[A-Za-z0-9_~!$&'()+,;=:@%/-]+$/.test(url.pathname);
  if (host === "web.push.apple.com") return !url.search && /^\/[A-Za-z0-9_~!$&'()+,;=:@%/-]+$/.test(url.pathname);
  if (host === "wns.windows.com" || /^[a-z0-9-]+\.notify\.windows\.com$/.test(host))
    return /^\/w\/$/.test(url.pathname) && /^\?token=[A-Za-z0-9_~!$&'()+,;=:@%/.-]+$/.test(url.search);
  return false;
}

const keyPattern = /^[A-Za-z0-9_-]+$/;
function exactKey(value, length) {
  if (typeof value !== "string" || !keyPattern.test(value)) return false;
  const bytes = Buffer.from(value, "base64url");
  return bytes.length === length && bytes.toString("base64url") === value;
}
export function validSubscription(subscription) {
  return !!subscription && typeof subscription === "object" &&
    validPushEndpoint(subscription.endpoint) &&
    exactKey(subscription.keys?.p256dh, 65) &&
    Buffer.from(subscription.keys.p256dh, "base64url")[0] === 4 &&
    (() => { try {
      crypto.ECDH.convertKey(Buffer.from(subscription.keys.p256dh, "base64url"), "prime256v1");
      return true;
    } catch { return false; } })() &&
    exactKey(subscription.keys?.auth, 16);
}

const messageKind = "CASE WHEN m.state IN ('error','cancelled') THEN 'failure' WHEN coalesce(m.needs_you,'')<>'' THEN 'input' ELSE 'reply' END";
const messageTime = "coalesce(j.updated,m.created)";
const messageEligible = `m.state IN ('sent','error','cancelled') AND ${notifiableMessageSql("m")}`;

function baselineCurrentEvents(endpoint, company, user, member, at) {
  const cutoff = new Date(at - MAX_EVENT_AGE_MS).toISOString();
  const p = permissions(member);
  run(`INSERT OR IGNORE INTO web_push_deliveries(endpoint,company_id,kind,event_id,delivered_at)
    SELECT ?,m.company_id,${messageKind},m.id,? FROM inbox i
      JOIN messages m ON m.id=i.message_id
      JOIN conversation_members cm ON cm.conversation_id=m.conversation_id AND cm.user_id=i.user_id
      LEFT JOIN jobs j ON j.output_message_id=m.id AND j.company_id=m.company_id
    WHERE i.user_id=? AND i.state='pending' AND m.company_id=? AND m.duck_id IS NOT NULL
      AND ${messageEligible} AND ${messageTime}>?`, endpoint, at, user, company, cutoff);
  run(`INSERT OR IGNORE INTO web_push_deliveries(endpoint,company_id,kind,event_id,delivered_at)
    SELECT ?,a.company_id,'approval',a.id,? FROM approvals a
      JOIN jobs j ON j.id=a.job_id AND j.company_id=a.company_id
    WHERE a.company_id=? AND a.status='pending' AND a.created>?
      AND (?=1 OR (j.user_id=? AND EXISTS
        (SELECT 1 FROM conversation_members cm WHERE cm.conversation_id=j.conversation_id AND cm.user_id=?)))`,
    endpoint, at, company, cutoff, p.approvals ? 1 : 0, user, user);
  if (p.computers) run(`INSERT OR IGNORE INTO web_push_deliveries(endpoint,company_id,kind,event_id,delivered_at)
    SELECT ?,h.company_id,'input',h.id,? FROM human_requests h
      JOIN jobs j ON j.id=h.job_id AND j.company_id=h.company_id
    WHERE h.company_id=? AND h.user_id=? AND h.status IN ('pending','desktop')
      AND h.expires>? AND h.created>?`, endpoint, at, company, user, at, cutoff);
}

function keys() {
  if (vapid) return vapid;
  try {
    const generated = webpush.generateVAPIDKeys();
    // Exclusive create prevents a second process from replacing the key and
    // invalidating every browser subscription after a rollout.
    fs.writeFileSync(KEY_FILE, JSON.stringify(generated), { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  const stat = fs.statSync(KEY_FILE);
  if ((stat.mode & 0o077) !== 0) fs.chmodSync(KEY_FILE, 0o600);
  const parsed = JSON.parse(fs.readFileSync(KEY_FILE, "utf8"));
  if (!keyPattern.test(parsed.publicKey || "") || !keyPattern.test(parsed.privateKey || ""))
    throw new Error("Invalid Web Push key file");
  vapid = parsed;
  return vapid;
}

function subscriptionFor(req, endpoint) {
  return one(
    `SELECT 1 FROM web_push_subscriptions w JOIN sessions s ON s.token_hash=w.session_hash
      WHERE w.endpoint=? AND w.session_hash=? AND w.user_id=? AND w.company_id=?
        AND s.user_id=w.user_id AND s.expires>?`,
    endpoint, req.session.token_hash, req.user.id, req.company.id, Date.now(),
  );
}

export function registerWebPush(app, { appUrl }) {
  const key = keys();
  const subject = new URL(appUrl).origin;
  const sameCompany = (req) => {
    if (req.body?.company_id != null && req.body.company_id !== req.company.id)
      fail(409, "Your current workspace changed. Please try again.");
  };
  app.get("/api/notifications/status", (req, res) =>
    res.json({ available: true, publicKey: key.publicKey, companyId: req.company.id }));
  app.post("/api/notifications/status", (req, res) => {
    sameCompany(req);
    if (typeof req.body?.endpoint !== "string" || req.body.endpoint.length > 4096)
      fail(400, "That browser subscription is not valid.");
    res.json({ available: true, publicKey: key.publicKey,
      subscribed: !!subscriptionFor(req, req.body.endpoint) });
  });
  app.post("/api/notifications/subscribe", (req, res) => {
    sameCompany(req);
    const subscription = req.body?.subscription;
    if (!validSubscription(subscription)) fail(400, "That browser subscription is not valid.");
    const foreign = one(`SELECT 1 FROM web_push_subscriptions w JOIN sessions s ON s.token_hash=w.session_hash
      WHERE w.endpoint=? AND w.user_id<>? AND s.expires>? LIMIT 1`,
      subscription.endpoint, req.user.id, Date.now());
    if (foreign) fail(409, "This browser is still enabled for another signed-in person.");
    const count = one("SELECT count(*) total FROM web_push_subscriptions WHERE session_hash=?", req.session.token_hash).total;
    if (count >= 10 && !subscriptionFor(req, subscription.endpoint))
      fail(429, "Too many browsers are enabled for this sign-in.");
    db.transaction(() => {
      const existing = subscriptionFor(req, subscription.endpoint);
      // A browser can rotate its push endpoint. Keep only its current one
      // for this session/workspace, while retaining the same endpoint's
      // baseline when Enable is pressed again.
      run("DELETE FROM web_push_subscriptions WHERE session_hash=? AND company_id=? AND endpoint<>?",
        req.session.token_hash, req.company.id, subscription.endpoint);
      if (existing) {
        run(`UPDATE web_push_subscriptions SET p256dh=?,auth=? WHERE endpoint=?
          AND session_hash=? AND company_id=? AND user_id=?`,
        subscription.keys.p256dh, subscription.keys.auth, subscription.endpoint,
        req.session.token_hash, req.company.id, req.user.id);
      } else {
        // Rebinding after an expired session must start a fresh baseline.
        run("DELETE FROM web_push_subscriptions WHERE endpoint=? AND company_id=?",
          subscription.endpoint, req.company.id);
        const at = Date.now();
        run(`INSERT INTO web_push_subscriptions(endpoint,p256dh,auth,session_hash,user_id,company_id,created)
          VALUES(?,?,?,?,?,?,?)`, subscription.endpoint, subscription.keys.p256dh,
          subscription.keys.auth, req.session.token_hash, req.user.id,
          req.company.id, new Date(at).toISOString());
        baselineCurrentEvents(subscription.endpoint, req.company.id, req.user.id, req.member, at);
      }
    })();
    res.json({ ok: true, subscribed: true });
  });
  app.post("/api/notifications/unsubscribe", (req, res) => {
    sameCompany(req);
    if (typeof req.body?.endpoint !== "string" || req.body.endpoint.length > 4096)
      fail(400, "That browser subscription is not valid.");
    run("DELETE FROM web_push_subscriptions WHERE endpoint=? AND session_hash=? AND user_id=? AND company_id=?",
      req.body.endpoint, req.session.token_hash, req.user.id, req.company.id);
    res.json({ ok: true, subscribed: false });
  });
  return { publicKey: key.publicKey, subject };
}

// These queries mirror the state feed's access rules. Reply notifications
// require that the person is in the conversation; approvals are visible to
// approvers or the owner of the work; computer prompts need that permission.
export function pendingWebPushEvents({ company, user, member, endpoint, query = all, now = Date.now() }) {
  const cutoff = new Date(now - MAX_EVENT_AGE_MS).toISOString();
  const p = permissions(member);
  const events = query(
    `SELECT m.id, ${messageTime} created, ${messageKind} kind
       FROM inbox i JOIN messages m ON m.id=i.message_id
       JOIN conversation_members cm ON cm.conversation_id=m.conversation_id AND cm.user_id=i.user_id
       LEFT JOIN jobs j ON j.output_message_id=m.id AND j.company_id=m.company_id
      WHERE i.user_id=? AND i.state='pending' AND m.company_id=? AND m.duck_id IS NOT NULL
        AND ${messageEligible} AND ${messageTime}>?
        AND NOT EXISTS (SELECT 1 FROM web_push_deliveries d WHERE d.endpoint=?
          AND d.company_id=m.company_id AND d.event_id=m.id)
      ORDER BY ${messageTime} LIMIT 5`,
    user, company, cutoff, endpoint,
  );
  const approvals = query(
    `SELECT a.id,a.created,'approval' kind FROM approvals a
       JOIN jobs j ON j.id=a.job_id AND j.company_id=a.company_id
      WHERE a.company_id=? AND a.status='pending' AND a.created>?
        AND (?=1 OR (j.user_id=? AND EXISTS
          (SELECT 1 FROM conversation_members cm WHERE cm.conversation_id=j.conversation_id AND cm.user_id=?)))
        AND NOT EXISTS (SELECT 1 FROM web_push_deliveries d WHERE d.endpoint=?
          AND d.company_id=a.company_id AND d.kind='approval' AND d.event_id=a.id)
      ORDER BY a.created LIMIT 5`,
    company, cutoff, p.approvals ? 1 : 0, user, user, endpoint,
  );
  events.push(...approvals);
  if (p.computers) events.push(...query(
    `SELECT h.id,h.created,'input' kind FROM human_requests h
       JOIN jobs j ON j.id=h.job_id AND j.company_id=h.company_id
      WHERE h.company_id=? AND h.user_id=? AND h.status IN ('pending','desktop')
        AND h.expires>? AND h.created>?
        AND NOT EXISTS (SELECT 1 FROM web_push_deliveries d WHERE d.endpoint=?
          AND d.company_id=h.company_id AND d.kind='input' AND d.event_id=h.id)
      ORDER BY h.created LIMIT 5`,
    company, user, now, cutoff, endpoint,
  ));
  return events.sort((a,b) => a.created.localeCompare(b.created)).slice(0, MAX_EVENTS_PER_SUBSCRIPTION);
}

const words = {
  reply: "A Duck replied.",
  input: "A Duck needs your attention.",
  approval: "An approval needs your attention.",
  failure: "A Duck run ended with a problem.",
};

export async function pollWebPush({ send = webpush.sendNotification, now = Date.now(), appUrl = process.env.APP_URL || "http://localhost:3000" } = {}) {
  if (polling) return;
  polling = true;
  try {
    const key = keys();
    // Deleting the session on sign-out or removing company membership cuts off
    // delivery even if a queued push has not yet been attempted.
    run(`DELETE FROM web_push_subscriptions WHERE NOT EXISTS
      (SELECT 1 FROM sessions s WHERE s.token_hash=web_push_subscriptions.session_hash
       AND s.user_id=web_push_subscriptions.user_id AND s.expires>?)
       OR NOT EXISTS (SELECT 1 FROM memberships m WHERE m.user_id=web_push_subscriptions.user_id
         AND m.company_id=web_push_subscriptions.company_id)`, now);
    run("DELETE FROM web_push_deliveries WHERE delivered_at<?", now - 2 * MAX_EVENT_AGE_MS);
    const rows = all(
      `SELECT w.* FROM web_push_subscriptions w
         JOIN sessions s ON s.token_hash=w.session_hash AND s.user_id=w.user_id AND s.expires>?
         JOIN memberships m ON m.company_id=w.company_id AND m.user_id=w.user_id
        ORDER BY w.created DESC`, now,
    );
    // Four sends at a time bounds outbound traffic and keeps one slow push
    // service from delaying every other browser.
    let cursor = 0;
    const worker = async () => {
      while (cursor < rows.length) {
        const row = rows[cursor++];
        const member = memberFor(row.company_id, row.user_id);
        if (!member) continue;
        for (const event of pendingWebPushEvents({ company: row.company_id, user: row.user_id, member,
          endpoint: row.endpoint, now })) {
          if (one("SELECT 1 FROM web_push_deliveries WHERE endpoint=? AND company_id=? AND kind=? AND event_id=?",
            row.endpoint, row.company_id, event.kind, event.id)) continue;
          // Recheck after fetching events: a sign-out or membership change can
          // occur while the poller is working.
          const stillEnabled = one(`SELECT 1 FROM web_push_subscriptions w
              JOIN sessions s ON s.token_hash=w.session_hash AND s.user_id=w.user_id AND s.expires>?
              JOIN memberships m ON m.company_id=w.company_id AND m.user_id=w.user_id
              WHERE w.endpoint=? AND w.company_id=? AND w.user_id=? AND w.session_hash=?`,
            Date.now(), row.endpoint, row.company_id, row.user_id, row.session_hash);
          const freshMember = stillEnabled && memberFor(row.company_id, row.user_id);
          if (!freshMember || !pendingWebPushEvents({ company: row.company_id, user: row.user_id,
            member: freshMember, endpoint: row.endpoint, now: Date.now() })
            .some((current) => current.kind === event.kind && current.id === event.id)) break;
          const payload = JSON.stringify({ title: "TameDuck", body: words[event.kind],
            path: `/w/${encodeURIComponent(row.company_id)}/inbox` });
          try {
            await send({ endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } }, payload,
              { TTL: 300, timeout: 8000, vapidDetails: { subject: new URL(appUrl).origin,
                publicKey: key.publicKey, privateKey: key.privateKey } });
            run("INSERT OR IGNORE INTO web_push_deliveries(endpoint,company_id,kind,event_id,delivered_at) VALUES(?,?,?,?,?)",
              row.endpoint, row.company_id, event.kind, event.id, Date.now());
          } catch (error) {
            if (error.statusCode === 404 || error.statusCode === 410)
              run("DELETE FROM web_push_subscriptions WHERE endpoint=?", row.endpoint);
            // Transient failures retry next poll. Never log endpoint or keys.
            break;
          }
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, rows.length) }, worker));
  } finally { polling = false; }
}

export function startWebPushPoller(options = {}) {
  const timer = setInterval(() => {
    pollWebPush(options).catch((error) => console.error("Web Push poll failed:", error.message));
  }, POLL_MS);
  timer.unref();
  return timer;
}
