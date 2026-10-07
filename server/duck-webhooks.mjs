// A duck's webhook: a private link another app can post a task to.
//
// Off for every duck until somebody who may change ducks turns it on. The link
// is the password: it is 256 random bits, kept only as a SHA-256 hash, and
// shown once. Two optional locks sit on top of it - an API key the caller has
// to send, and a list of addresses it has to come from - and the tab
// recommends both. A task that gets through is posted into the chat between
// the duck and the person who turned the webhook on, and runs as that person,
// exactly as a schedule does. Standing instructions written in the tab are
// read before the request, which cannot overrule them (webhook-context.mjs).
//
// An answer can be sent back: to the reply address set in the tab, or to a
// reply_url in the request on that same host. Answers are signed with a
// per-webhook secret so the receiving app can tell they are ours.
//
// Calls to a link nobody has are answered 404 and not recorded, so the
// answer says nothing about which links exist. Calls to a known link, started
// or refused, are listed in the tab.
import crypto from "node:crypto";
import net from "node:net";
import express from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { z } from "zod";
import { deploymentDrainRequested } from "./deployment-drain.mjs";
import {
  db,
  one,
  all,
  run,
  id,
  now,
  tenant,
  can,
  fail,
  emit,
  audit,
  addMessage,
  directConversation,
  memberFor,
  permissions,
  hash,
  encrypt,
  decrypt,
} from "./store.mjs";
import { validateUrl, guardedFetch } from "./mcp-network.mjs";

const LINK = /^whk_[A-Za-z0-9_-]{43}$/;
const MAX_BODY = 20 * 1024;
const MAX_TASK = 16000;
const appUrl = () =>
  (process.env.APP_URL || "http://localhost:3000").replace(/\/+$/, "");
const secret = (prefix) => prefix + crypto.randomBytes(32).toString("base64url");
const hint = (value) => value.slice(0, 8) + "…" + value.slice(-4);
export const linkFor = (link) => appUrl() + "/api/hooks/" + link;

// ---- the optional locks ---------------------------------------------------

// "203.0.113.7, 198.51.100.0/24" and the like, one per line or comma. Written
// back the way it was typed, minus blanks; refused whole if any entry is not
// an address or a range.
export function parseAllowedIps(text) {
  const entries = String(text || "")
    .split(/[\s,;]+/)
    .map((x) => x.trim())
    .filter(Boolean);
  if (entries.length > 50) fail(400, "Allow at most 50 addresses or ranges.");
  const list = new net.BlockList();
  for (const entry of entries) {
    const [address, bits, extra] = entry.split("/");
    const family = net.isIP(address);
    const size = family === 6 ? 128 : 32;
    if (
      !family ||
      extra !== undefined ||
      (bits !== undefined &&
        (!/^\d{1,3}$/.test(bits) || +bits < 0 || +bits > size))
    )
      fail(
        400,
        `"${entry.slice(0, 60)}" is not an IP address or range. Use addresses like 203.0.113.7 or ranges like 203.0.113.0/24.`,
      );
    const type = family === 6 ? "ipv6" : "ipv4";
    if (bits === undefined) list.addAddress(address, type);
    else list.addSubnet(address, +bits, type);
  }
  return { entries, list };
}
export function ipAllowed(allowed, ip) {
  const { entries, list } = parseAllowedIps(allowed);
  if (!entries.length) return true;
  const address = String(ip || "").replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, "");
  const family = net.isIP(address);
  if (!family) return false;
  return list.check(address, family === 6 ? "ipv6" : "ipv4");
}
function keyMatches(row, req) {
  if (!row.key_hash) return true;
  const sent =
    (req.get("authorization") || "").replace(/^Bearer\s+/i, "").trim() ||
    (req.get("x-tameduck-key") || "").trim();
  if (!sent) return false;
  return crypto.timingSafeEqual(
    Buffer.from(hash(sent), "hex"),
    Buffer.from(row.key_hash, "hex"),
  );
}

// A reply address has to be a public HTTPS host. Checked when it is saved and
// again, through the guarded connection, every time something is sent to it.
export function checkReplyUrl(value) {
  try {
    return validateUrl(value);
  } catch {
    fail(
      400,
      "Use a public HTTPS address for answers, like https://hooks.example.com/…",
    );
  }
}

// ---- reading and changing the settings --------------------------------------

const row = (duck) => one("SELECT * FROM duck_webhooks WHERE duck_id=?", duck);
function ensureRow(company, duck, user) {
  if (!row(duck))
    run(
      "INSERT INTO duck_webhooks(duck_id,company_id,updated_by,created,updated) VALUES(?,?,?,?,?)",
      duck,
      company,
      user,
      now(),
      now(),
    );
  return row(duck);
}
export const webhookEnabled = (duck) => !!row(duck)?.enabled;

function deliveries(duck) {
  return all(
    `SELECT d.*,m.conversation_id FROM duck_webhook_deliveries d
     LEFT JOIN messages m ON m.id=d.message_id
     WHERE d.duck_id=? AND d.received>? ORDER BY d.received DESC LIMIT 20`,
    duck,
    new Date(Date.now() - 7 * 86400000).toISOString(),
  ).map((d) => ({
    id: d.id,
    received: d.received,
    source: d.source,
    summary: d.summary,
    outcome: d.outcome,
    reason: d.reason,
    test: !!d.test,
    conversation_id: d.conversation_id || null,
    message_id: d.message_id || null,
    reply: d.reply_state === "none" ? null : { state: d.reply_state, note: d.reply_note },
  }));
}
export function publicWebhook(company, duck) {
  const r = row(duck);
  const runner = r?.runner_id
    ? one("SELECT id,name FROM users WHERE id=?", r.runner_id)
    : null;
  return {
    enabled: !!r?.enabled,
    has_link: !!r?.link_hash,
    link_hint: r?.link_hint || null,
    runner: runner ? { id: runner.id, name: runner.name } : null,
    enabled_at: r?.enabled_at || null,
    instructions: r?.instructions || "",
    hourly_limit: r?.hourly_limit ?? 20,
    allowed_ips: r?.allowed_ips || "",
    has_key: !!r?.key_hash,
    key_hint: r?.key_hint || null,
    reply_url: r?.reply_url || "",
    has_signing_secret: !!r?.signing_secret,
    deliveries: r ? deliveries(duck) : [],
  };
}

const settings = z
  .object({
    enabled: z.boolean().optional(),
    instructions: z.string().max(4000).optional(),
    hourly_limit: z.number().int().min(1).max(500).optional(),
    allowed_ips: z.string().max(4000).optional(),
    reply_url: z.string().trim().max(2000).optional(),
  })
  .strict();

function newLink(duck) {
  const link = secret("whk_");
  run(
    "UPDATE duck_webhooks SET link_hash=?,link_hint=?,updated=? WHERE duck_id=?",
    hash(link),
    hint(link),
    now(),
    duck,
  );
  return linkFor(link);
}

export function registerDuckWebhooks(app, { enqueue, aiStatus }) {
  const manage = (req) => {
    can(req.member, "ducks");
    const duck = tenant("ducks", req.params.id, req.company.id);
    return duck;
  };
  app.get("/api/ducks/:id/webhook", (req, res) => {
    const duck = manage(req);
    res.json({ webhook: publicWebhook(req.company.id, duck.id) });
  });
  app.patch("/api/ducks/:id/webhook", (req, res) => {
    const duck = manage(req);
    const a = settings.parse(req.body || {});
    if (a.allowed_ips !== undefined) parseAllowedIps(a.allowed_ips);
    if (a.reply_url) checkReplyUrl(a.reply_url);
    if (a.enabled && duck.removed)
      fail(409, duck.name + " is off the team. Put it back first.");
    let link = null;
    db.transaction(() => {
      const before = ensureRow(req.company.id, duck.id, req.user.id);
      if (a.enabled === true && !before.enabled) {
        // Whoever turns it on is who the work runs as, and is told so.
        run(
          "UPDATE duck_webhooks SET enabled=1,runner_id=?,enabled_at=? WHERE duck_id=?",
          req.user.id,
          now(),
          duck.id,
        );
        if (!before.link_hash) link = newLink(duck.id);
      }
      if (a.enabled === false)
        run("UPDATE duck_webhooks SET enabled=0 WHERE duck_id=?", duck.id);
      if (a.instructions !== undefined)
        run(
          "UPDATE duck_webhooks SET instructions=? WHERE duck_id=?",
          a.instructions.trim(),
          duck.id,
        );
      if (a.hourly_limit !== undefined)
        run(
          "UPDATE duck_webhooks SET hourly_limit=? WHERE duck_id=?",
          a.hourly_limit,
          duck.id,
        );
      if (a.allowed_ips !== undefined)
        run(
          "UPDATE duck_webhooks SET allowed_ips=? WHERE duck_id=?",
          parseAllowedIps(a.allowed_ips).entries.join("\n"),
          duck.id,
        );
      if (a.reply_url !== undefined) {
        run(
          "UPDATE duck_webhooks SET reply_url=? WHERE duck_id=?",
          a.reply_url,
          duck.id,
        );
        if (a.reply_url && !before.signing_secret)
          run(
            "UPDATE duck_webhooks SET signing_secret=? WHERE duck_id=?",
            encrypt(secret("whsec_")),
            duck.id,
          );
      }
      run(
        "UPDATE duck_webhooks SET updated=?,updated_by=? WHERE duck_id=?",
        now(),
        req.user.id,
        duck.id,
      );
    })();
    audit(req.company.id, req.user.id, "Duck webhook settings changed", {
      duck_id: duck.id,
      enabled: a.enabled,
      instructions: a.instructions !== undefined,
      hourly_limit: a.hourly_limit,
      allowed_ips: a.allowed_ips !== undefined,
      reply_url: a.reply_url !== undefined,
    });
    emit(req.company.id);
    res.json({
      webhook: publicWebhook(req.company.id, duck.id),
      ...(link ? { link } : {}),
    });
  });
  // A new link stops the old one at once.
  app.post("/api/ducks/:id/webhook/link", (req, res) => {
    const duck = manage(req);
    ensureRow(req.company.id, duck.id, req.user.id);
    const link = newLink(duck.id);
    audit(req.company.id, req.user.id, "Duck webhook link replaced", {
      duck_id: duck.id,
    });
    emit(req.company.id);
    res.json({ webhook: publicWebhook(req.company.id, duck.id), link });
  });
  app.post("/api/ducks/:id/webhook/key", (req, res) => {
    const duck = manage(req);
    ensureRow(req.company.id, duck.id, req.user.id);
    const key = secret("tdk_");
    run(
      "UPDATE duck_webhooks SET key_hash=?,key_hint=?,updated=?,updated_by=? WHERE duck_id=?",
      hash(key),
      hint(key),
      now(),
      req.user.id,
      duck.id,
    );
    audit(req.company.id, req.user.id, "Duck webhook API key set", {
      duck_id: duck.id,
    });
    emit(req.company.id);
    res.json({ webhook: publicWebhook(req.company.id, duck.id), key });
  });
  app.delete("/api/ducks/:id/webhook/key", (req, res) => {
    const duck = manage(req);
    run(
      "UPDATE duck_webhooks SET key_hash=NULL,key_hint=NULL,updated=?,updated_by=? WHERE duck_id=?",
      now(),
      req.user.id,
      duck.id,
    );
    audit(req.company.id, req.user.id, "Duck webhook API key removed", {
      duck_id: duck.id,
    });
    emit(req.company.id);
    res.json({ webhook: publicWebhook(req.company.id, duck.id) });
  });
  // The signing secret has to be pasted into the receiving app, so unlike the
  // link and the key it can be looked at again. Each look is written down.
  app.post("/api/ducks/:id/webhook/signing-secret", (req, res) => {
    const duck = manage(req);
    const r = row(duck.id);
    if (!r?.signing_secret) fail(404, "Set an address for answers first.");
    audit(req.company.id, req.user.id, "Duck webhook signing secret shown", {
      duck_id: duck.id,
    });
    res.json({ signing_secret: decrypt(r.signing_secret) });
  });
  app.post("/api/ducks/:id/webhook/test", async (req, res) => {
    const duck = manage(req);
    const r = row(duck.id);
    if (!r?.enabled) fail(409, "Turn the webhook on first.");
    const result = await accept(r, {
      task: "This is a test from TameDuck’s webhook settings. Reply with one short sentence to confirm you received it. Do nothing else.",
      source: "TameDuck test",
      ip: req.ip,
      test: true,
      replyUrl: "",
      enqueue,
      aiStatus,
    });
    res.status(result.status).json({
      ...result.body,
      webhook: publicWebhook(req.company.id, duck.id),
    });
  });
}

// ---- receiving --------------------------------------------------------------

function record(r, fields) {
  const deliveryId = id();
  run(
    `INSERT INTO duck_webhook_deliveries(id,company_id,duck_id,received,ip,source,summary,outcome,reason,test,message_id,job_id,reply_url,reply_state,reply_next_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    deliveryId,
    r.company_id,
    r.duck_id,
    now(),
    String(fields.ip || "").slice(0, 80),
    String(fields.source || "").slice(0, 80),
    String(fields.summary || "").replace(/\s+/g, " ").slice(0, 160),
    fields.outcome,
    fields.reason || "",
    fields.test ? 1 : 0,
    fields.message_id || null,
    fields.job_id || null,
    fields.reply_url || "",
    fields.reply_url ? "pending" : "none",
    fields.reply_url ? Date.now() : null,
  );
  emit(r.company_id);
  return deliveryId;
}
const refused = (r, fields, status, error) => {
  const delivery = record(r, { ...fields, outcome: "refused", reason: error });
  return { status, body: { id: delivery, status: "refused", error } };
};

// What arrived, read as a task. JSON may say "task" (or "text" or "message"),
// "from" (or "source") and "reply_url"; anything else is the task as text.
export function readPayload(buffer, type) {
  const text = buffer.toString("utf8");
  if (/json/i.test(type || "")) {
    let body;
    try {
      body = JSON.parse(text || "null");
    } catch {
      return { error: "The body is not valid JSON." };
    }
    if (typeof body === "string") return { task: body.trim() };
    if (!body || typeof body !== "object" || Array.isArray(body))
      return { error: 'Send an object like {"task": "…"}.' };
    const task = [body.task, body.text, body.message].find(
      (v) => typeof v === "string" && v.trim(),
    );
    return {
      task: (task || "").trim(),
      source: typeof (body.from ?? body.source) === "string"
        ? String(body.from ?? body.source).trim().slice(0, 80)
        : "",
      replyUrl: typeof body.reply_url === "string" ? body.reply_url.trim() : "",
    };
  }
  return { task: text.trim() };
}

async function accept(r, { task, source, ip, test, replyUrl, enqueue, aiStatus }) {
  const said = { ip, source, summary: task, test, reply_url: replyUrl };
  if (!task) return refused(r, said, 400, "There was no task in the request.");
  if (task.length > MAX_TASK)
    return refused(r, said, 413, "The task is longer than 16,000 characters.");
  const company = one("SELECT * FROM companies WHERE id=?", r.company_id);
  if (company?.paused)
    return refused(r, said, 409, "The flock is paused, so nothing is started.");
  const member = r.runner_id && memberFor(r.company_id, r.runner_id);
  if (!member || !permissions(member).tasks || !permissions(member).chat)
    return refused(
      r,
      said,
      409,
      "The person who turned this webhook on can no longer give this duck work. Turn it off and on again to hand it to you.",
    );
  const duck = one(
    "SELECT * FROM ducks WHERE id=? AND company_id=?",
    r.duck_id,
    r.company_id,
  );
  if (!duck || duck.removed)
    return refused(r, said, 409, "This duck is off the team.");
  const hour = new Date(Date.now() - 3600000).toISOString();
  const started = one(
    "SELECT count(*) n FROM duck_webhook_deliveries WHERE duck_id=? AND outcome='started' AND test=0 AND received>?",
    r.duck_id,
    hour,
  ).n;
  if (!test && started >= r.hourly_limit)
    return refused(
      r,
      said,
      429,
      "This webhook already started " + r.hourly_limit + " tasks in the last hour.",
    );
  const ai = await aiStatus(r.company_id).catch(() => ({ connected: false }));
  if (!ai.connected)
    return refused(r, said, 503, "No AI is connected, so the duck cannot work.");
  // The settings may have changed while the AI status was being read.
  const now_ = row(r.duck_id);
  if (!now_?.enabled || now_.link_hash !== r.link_hash)
    return { status: 404, body: { error: "Not found." } };
  let messageId = null,
    jobId = null;
  try {
    const conversation = directConversation(r.company_id, r.runner_id, duck);
    messageId = addMessage(r.company_id, conversation.id, task, {
      user: r.runner_id,
      origin: "webhook",
    });
    jobId = enqueue(r.company_id, r.runner_id, conversation.id, duck.id, messageId);
  } catch (e) {
    // The message is the record that something arrived; without a run it
    // would sit in the chat looking like work that never started.
    if (messageId && !jobId)
      run("UPDATE messages SET state='error' WHERE id=?", messageId);
    return refused(
      r,
      { ...said, message_id: messageId },
      e.status === 429 ? 429 : e.status || 500,
      e.status ? e.message : "The task could not be started.",
    );
  }
  const delivery = record(r, {
    ...said,
    outcome: "started",
    message_id: messageId,
    job_id: jobId,
  });
  return {
    status: 202,
    body: {
      id: delivery,
      status: "started",
      ...(replyUrl ? { reply: "pending" } : {}),
    },
  };
}

export function registerWebhookReceiver(app, { enqueue, aiStatus }) {
  // Links are unguessable, so this only stops one address hammering us.
  const limiter = rateLimit({
    windowMs: 60000,
    limit: 120,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    keyGenerator: (req) => ipKeyGenerator(req.ip),
    message: { error: "Too many requests. Slow down." },
  });
  const body = express.raw({ type: () => true, limit: MAX_BODY });
  app.all("/api/hooks/:link", limiter, (req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (req.method !== "POST")
      return res.status(405).set("Allow", "POST").json({ error: "Use POST." });
    body(req, res, (error) => {
      if (error)
        return res
          .status(error.status === 413 ? 413 : 400)
          .json({
            error:
              error.status === 413
                ? "The request is larger than 20 KB."
                : "The request could not be read.",
          });
      next();
    });
  }, async (req, res) => {
    const link = req.params.link;
    const r =
      LINK.test(link) &&
      one("SELECT * FROM duck_webhooks WHERE link_hash=? AND enabled=1", hash(link));
    if (!r || deploymentDrainRequested())
      return r
        ? res.status(503).set("Retry-After", "30").json({ error: "TameDuck is being updated. Try again shortly." })
        : res.status(404).json({ error: "Not found." });
    const payload = readPayload(
      Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0),
      req.get("content-type"),
    );
    const said = {
      ip: req.ip,
      source: payload.source || "",
      summary: payload.task || "",
    };
    const answer = ({ status, body: b }) => res.status(status).json(b);
    // Whoever failed a lock is not somebody whose words belong on the list,
    // so only that they called, from where, is written down.
    const stranger = { ip: req.ip };
    if (!ipAllowed(r.allowed_ips, req.ip))
      return answer(
        refused(r, stranger, 403, req.ip + " is not on the allowed list."),
      );
    if (!keyMatches(r, req))
      return answer(refused(r, stranger, 401, "Missing or wrong API key."));
    if (payload.error) return answer(refused(r, said, 400, payload.error));
    // Answers go to the address set in the tab, or to one the request names
    // on that same host. A request cannot send them anywhere else: that would
    // let anybody holding the link read the duck's work.
    let replyUrl = r.reply_url || "";
    if (payload.replyUrl) {
      let asked;
      try {
        asked = checkReplyUrl(payload.replyUrl);
      } catch (e) {
        return answer(refused(r, said, 400, e.message));
      }
      if (!r.reply_url)
        return answer(
          refused(r, said, 400, "Set an address for answers in the duck's Webhook tab before sending reply_url."),
        );
      if (asked.host !== new URL(r.reply_url).host)
        return answer(
          refused(r, said, 400, "reply_url must be on " + new URL(r.reply_url).host + ", the address set for answers."),
        );
      replyUrl = asked.href;
    }
    answer(
      await accept(r, {
        task: payload.task,
        source: payload.source,
        ip: req.ip,
        test: false,
        replyUrl,
        enqueue,
        aiStatus,
      }),
    );
  });
}

// ---- answers sent back ------------------------------------------------------

let replyFetch = null;
// Tests send answers to a local server, which the guarded connection refuses.
export const setReplyFetch = (fn) => (replyFetch = fn);
const RETRY = [60000, 5 * 60000, 30 * 60000];

export function signReply(secretValue, body, at = Math.floor(Date.now() / 1000)) {
  return (
    "t=" +
    at +
    ",v1=" +
    crypto.createHmac("sha256", secretValue).update(at + "." + body).digest("hex")
  );
}

export async function sendReplies() {
  for (const d of all(
    `SELECT d.*,j.status job_status,j.output_message_id,f.outcome work_outcome,f.summary work_summary,
            m.body answer,h.signing_secret,du.name duck_name
     FROM duck_webhook_deliveries d
     JOIN jobs j ON j.id=d.job_id
     LEFT JOIN job_work_finishes f ON f.job_id=j.id
     LEFT JOIN messages m ON m.id=j.output_message_id
     LEFT JOIN duck_webhooks h ON h.duck_id=d.duck_id
     LEFT JOIN ducks du ON du.id=d.duck_id
     WHERE d.reply_state='pending' AND d.reply_next_at<=?
       AND j.status NOT IN ('queued','running','waiting_human','waiting_consultation')
     LIMIT 20`,
    Date.now(),
  )) {
    const status =
      d.job_status === "cancelled"
        ? "cancelled"
        : d.job_status === "done"
          ? d.work_outcome === "incomplete"
            ? "incomplete"
            : "completed"
          : "failed";
    const body = JSON.stringify({
      id: d.id,
      duck: d.duck_name,
      status,
      answer: (d.answer || d.work_summary || "").slice(0, 60000),
      finished_at: new Date().toISOString(),
      chat_url: appUrl() + "/",
    });
    const headers = {
      "Content-Type": "application/json",
      "User-Agent": "TameDuck-Webhook/1",
      "X-TameDuck-Delivery": d.id,
    };
    if (d.signing_secret)
      headers["X-TameDuck-Signature"] = signReply(decrypt(d.signing_secret), body);
    let note = "";
    try {
      const target = checkReplyUrl(d.reply_url);
      const send = replyFetch || guardedFetch([target.hostname]);
      const response = await send(target.href, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(15000),
      });
      await response.body?.cancel?.().catch?.(() => {});
      if (response.ok) {
        run(
          "UPDATE duck_webhook_deliveries SET reply_state='sent',reply_attempts=reply_attempts+1,reply_next_at=NULL,reply_note=? WHERE id=?",
          "Sent, answered " + response.status + ".",
          d.id,
        );
        emit(d.company_id);
        continue;
      }
      note = "The app answered " + response.status + ".";
    } catch (e) {
      note = "Could not reach the app: " + String(e.message || e).slice(0, 120);
    }
    const attempts = d.reply_attempts + 1;
    const wait = RETRY[attempts - 1];
    run(
      "UPDATE duck_webhook_deliveries SET reply_state=?,reply_attempts=?,reply_next_at=?,reply_note=? WHERE id=?",
      wait ? "pending" : "failed",
      attempts,
      wait ? Date.now() + wait : null,
      wait ? note + " Trying again." : note + " Gave up after " + attempts + " tries.",
      d.id,
    );
    emit(d.company_id);
  }
}
export function startWebhookReplies() {
  let busy = false;
  const timer = setInterval(async () => {
    if (busy || deploymentDrainRequested()) return;
    busy = true;
    try {
      await sendReplies();
    } catch (e) {
      console.error("Webhook replies:", e.message);
    } finally {
      busy = false;
    }
  }, 15000);
  timer.unref();
  return timer;
}
