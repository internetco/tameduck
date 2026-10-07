import { z } from "zod";
import {
  db,
  id,
  now,
  all,
  one,
  run,
  can,
  tenant,
  fail,
  memberFor,
  permissions,
  conversationFor,
  onTeam,
  directConversation,
  addMessage,
  threadRoot,
  audit,
  emit,
  DUCK_LIMIT,
  recordStopper,
} from "./store.mjs";
import {
  artifactsFor,
  attachArtifact,
  artifactChangesFor,
} from "./artifacts.mjs";
import { claimUploads, attachUploads } from "./uploads.mjs";
import { aiStatus as statusFor, cancelJob } from "./runtime.mjs";
import { enqueue } from "./duck-tools.mjs";
import { duckRefusalFor } from "./ai-gate.mjs";
import {
  humanConversation,
  decoratedMessages,
  readThread,
  threadSummaries,
  markMessagesRead,
} from "./chat-store.mjs";
const uuid = z.string().uuid();
// 1 to 100 characters of something you can see. A zero-width space is not
// whitespace to trim(), and was saved as a name nobody could see.
const channelName = z
  .string()
  .trim()
  .max(100, "Keep the name to 100 characters or fewer.")
  .refine(
    (name) => name.replace(/[\s\p{Cf}]/gu, "") !== "",
    "Give the channel a name.",
  );
// A live channel in this person's own sidebar that already has the name,
// ignoring case and spaces at either end. Only theirs: refusing the name of a
// channel they are not in told anybody that a private channel of that name
// exists.
function sameName(companyId, userId, name, except) {
  const wanted = name.trim().toLowerCase();
  return all(
    "SELECT c.name FROM conversations c JOIN conversation_members m ON m.conversation_id=c.id WHERE m.user_id=? AND c.company_id=? AND c.kind='group' AND c.archived=0 AND c.id<>?",
    userId,
    companyId,
    except,
  ).find((c) => c.name.trim().toLowerCase() === wanted)?.name;
}
const threadSchema = uuid.nullable().optional();
export function registerChat(app, { aiStatus = statusFor } = {}) {
  app.get("/api/artifacts/:id/changes", (req, res) => {
    can(req.member, "chat");
    const changes = artifactChangesFor(
      uuid.parse(req.params.id),
      req.company.id,
      (conversation) =>
        conversationFor(conversation, req.company.id, req.user.id),
    );
    const { conversation_id, ...body } = changes;
    res.json(body);
  });
  app.post("/api/conversations/direct", (req, res) => {
    can(req.member, "chat");
    const a = z
      .object({ duck_id: uuid.optional(), user_id: uuid.optional() })
      .refine(
        (a) => !!a.duck_id !== !!a.user_id,
        "Choose one duck or teammate.",
      )
      .parse(req.body);
    const conv = a.duck_id
      ? directConversation(
          req.company.id,
          req.user.id,
          onTeam(a.duck_id, req.company.id),
        )
      : humanConversation(req.company.id, req.user.id, a.user_id);
    emit(req.company.id);
    res.json(conv);
  });
  app.post("/api/conversations", (req, res) => {
    can(req.member, "chat");
    const a = z
      .object({
        name: channelName,
        ducks: z
          .array(uuid)
          .max(
            DUCK_LIMIT,
            `A channel can hold ${DUCK_LIMIT} ducks, which is the whole flock.`,
          )
          .default([]),
        members: z.array(uuid).max(50).default([]),
      })
      .parse(req.body);
    if (!a.ducks.length && !a.members.some((u) => u !== req.user.id))
      fail(400, "Choose at least one teammate or duck.");
    for (const d of a.ducks) onTeam(d, req.company.id);
    for (const u of a.members)
      if (!memberFor(req.company.id, u))
        fail(400, "Select teammates from this company.");
    const cid = id();
    db.transaction(() => {
      run(
        "INSERT INTO conversations(id,company_id,name,kind,creator_id,created) VALUES(?,?,?,?,?,?)",
        cid,
        req.company.id,
        a.name,
        "group",
        req.user.id,
        now(),
      );
      for (const d of new Set(a.ducks))
        run("INSERT INTO conversation_ducks VALUES(?,?)", cid, d);
      for (const u of new Set([req.user.id, ...a.members]))
        run("INSERT INTO conversation_members VALUES(?,?)", cid, u);
    })();
    audit(req.company.id, req.user.id, "Group chat created", a.name);
    res.json({ id: cid });
  });
  // Who is in a channel was decided once, when it was made, and could never be
  // changed again: no control on any screen and no route here either. So
  // somebody who joined on Monday could never be shown three weeks of the
  // channel everybody else works in, and the only way round it was a second
  // channel and abandoning the history.
  app.patch("/api/conversations/:id", (req, res) => {
    can(req.member, "chat");
    const conv = conversationFor(req.params.id, req.company.id, req.user.id);
    if (conv.kind !== "group")
      fail(400, "Only a channel has members to change.");
    const a = z
      .object({
        // A channel could not be renamed anywhere, so a name typed in a hurry
        // stayed on it for good. Same rule as making one.
        name: channelName.optional(),
        add_members: z.array(uuid).max(50).default([]),
        remove_members: z.array(uuid).max(50).default([]),
        add_ducks: z
          .array(uuid)
          .max(
            DUCK_LIMIT,
            `A channel can hold ${DUCK_LIMIT} ducks, which is the whole flock.`,
          )
          .default([]),
        remove_ducks: z.array(uuid).max(DUCK_LIMIT).default([]),
      })
      .parse(req.body);
    const regroup =
      a.add_members.length +
      a.remove_members.length +
      a.add_ducks.length +
      a.remove_ducks.length;
    const renamed = a.name !== undefined && a.name !== conv.name;
    // An archived channel still took new people: somebody was added to one
    // nobody works in any more, and it appeared in nobody's sidebar.
    if (conv.archived && regroup)
      fail(
        409,
        "This channel is archived. Nobody can be added or removed until it is back.",
      );
    if (conv.archived && renamed)
      fail(409, "This channel is archived. Unarchive it to rename it.");
    if (renamed) {
      // The same people who may archive it.
      if (conv.creator_id !== req.user.id && !permissions(req.member).company)
        fail(
          403,
          "Only the person who made this channel, or a company admin, can rename it.",
        );
      // Two live channels with one name cannot be told apart in the sidebar.
      const taken = sameName(req.company.id, req.user.id, a.name, conv.id);
      if (taken)
        fail(
          409,
          "Another channel is already called #" + taken + ". Pick another name.",
        );
    }
    for (const u of a.add_members)
      if (!memberFor(req.company.id, u))
        fail(400, "Add teammates from this company.");
    for (const d of a.add_ducks) onTeam(d, req.company.id);
    const humans = () =>
      all(
        "SELECT user_id FROM conversation_members WHERE conversation_id=?",
        conv.id,
      ).map((x) => x.user_id);
    db.transaction(() => {
      if (renamed)
        run("UPDATE conversations SET name=? WHERE id=?", a.name, conv.id);
      for (const u of new Set(a.add_members))
        run(
          "INSERT OR IGNORE INTO conversation_members VALUES(?,?)",
          conv.id,
          u,
        );
      for (const d of new Set(a.add_ducks))
        run("INSERT OR IGNORE INTO conversation_ducks VALUES(?,?)", conv.id, d);
      for (const d of new Set(a.remove_ducks))
        run(
          "DELETE FROM conversation_ducks WHERE conversation_id=? AND duck_id=?",
          conv.id,
          d,
        );
      for (const u of new Set(a.remove_members)) {
        // Leaving is yours to do. Throwing somebody else out is not: anybody in
        // a channel could remove anybody else, the owner included, in one
        // unconfirmed click - and the person it happened to lost the channel
        // from their sidebar, their Needs-you items for it, and any run of
        // theirs going in it, with nothing said to them. Archiving the same
        // channel has always been the creator's or an admin's; this is a
        // bigger thing than archiving and was open to everybody.
        if (
          u !== req.user.id &&
          conv.creator_id !== req.user.id &&
          !permissions(req.member).company
        )
          fail(
            403,
            "Only the person who made this channel, or a company admin, can take somebody else out of it. You can leave it yourself.",
          );
        // A channel with nobody in it is reachable from nowhere: it is not in
        // anybody's sidebar and not in Archived either. Somebody has to be left
        // holding it.
        if (humans().length <= 1)
          fail(
            409,
            "This is the last person in the channel. Add somebody else first, or archive the channel.",
          );
        run(
          "DELETE FROM conversation_members WHERE conversation_id=? AND user_id=?",
          conv.id,
          u,
        );
      }
    })();
    if (renamed)
      audit(
        req.company.id,
        req.user.id,
        "Channel renamed",
        conv.name + " → " + a.name,
      );
    if (regroup)
      audit(
        req.company.id,
        req.user.id,
        "Channel members changed",
        renamed ? a.name : conv.name,
      );
    emit(req.company.id);
    res.json({ ok: true });
  });
  app.get("/api/conversations/:id/messages", (req, res) => {
    conversationFor(req.params.id, req.company.id, req.user.id);
    const threads = threadSummaries(req.company.id, req.params.id, req.user.id);
    // A chat used to stop dead at the newest thousand: no control, no marker,
    // and the thousand-and-first message looked like it had never been sent.
    // The screen asks for more when somebody asks to see further back.
    const limit = Number(req.query.limit) || 1000;
    // Which of these this person has not read yet, so the chat can draw a line
    // where they left off instead of opening at the bottom as if they had
    // read everything.
    const read = new Set(
      all(
        "SELECT r.message_id FROM message_reads r JOIN messages m ON m.id=r.message_id WHERE m.conversation_id=? AND r.user_id=?",
        req.params.id,
        req.user.id,
      ).map((r) => r.message_id),
    );
    res.json(
      decoratedMessages(req.company.id, req.params.id, null, limit).map((m) => ({
        ...m,
        unread: m.user_id !== req.user.id && !read.has(m.id),
        reply_count: 0,
        reply_unread: 0,
        repliers: [],
        ...threads.get(m.id),
      })),
    );
  });
  app.get("/api/conversations/:id/threads/:message", (req, res) => {
    conversationFor(req.params.id, req.company.id, req.user.id);
    res.json(readThread(req.company.id, req.params.id, req.params.message));
  });
  app.post("/api/conversations/:id/read", (req, res) => {
    conversationFor(req.params.id, req.company.id, req.user.id);
    const a = z
      .object({ message_ids: z.array(uuid).max(1000) })
      .parse(req.body);
    const changed = markMessagesRead(
      req.company.id,
      req.params.id,
      req.user.id,
      a.message_ids,
    );
    if (changed) emit(req.company.id);
    res.json({ ok: true });
  });
  app.post("/api/conversations/:id/messages", async (req, res) => {
    can(req.member, "chat");
    const conv = conversationFor(req.params.id, req.company.id, req.user.id);
    if (conv.archived)
      fail(409, "Unarchive this channel before sending a message.");
    const a = z
      .object({
        // Zod's own wording ("String must contain at most 20000
        // character(s)") is what a person saw when they pasted something long.
        body: z
          .string()
          .trim()
          .max(
            20000,
            "That message is too long to send. Keep it under 20,000 characters, or attach it as a file.",
          ),
        document_ids: z.array(uuid).max(10).default([]),
        upload_ids: z.array(uuid).max(10).default([]),
        duck_ids: z.array(uuid).max(10).optional(),
        thread_id: threadSchema,
      })
      .parse(req.body);
    if (!a.body && !a.document_ids.length && !a.upload_ids.length)
      fail(400, "Write a message or attach a file.");
    const thread = a.thread_id
      ? threadRoot(req.company.id, conv.id, a.thread_id).id
      : null;
    const attached = a.document_ids.map((d) =>
      tenant("documents", d, req.company.id),
    );
    const available = all(
      "SELECT duck_id FROM conversation_ducks WHERE conversation_id=?",
      conv.id,
    ).map((d) => d.duck_id);
    // Group conversations default to people. An explicit selection asks ducks.
    const ducks = [
      ...new Set(a.duck_ids ?? (conv.kind === "direct" ? available : [])),
    ];
    if (ducks.some((d) => !available.includes(d)))
      fail(400, "Select ducks who belong to this chat.");
    if (ducks.length) {
      if (req.company.paused)
        fail(
          409,
          "The flock is paused. Send to people only, or resume the ducks in company settings.",
        );
      const refused = duckRefusalFor(
        await aiStatus(req.company.id),
        req.member,
      );
      if (refused) fail(409, refused);
    }
    // Recheck access after a potentially slow AI connection check.
    const current = conversationFor(conv.id, req.company.id, req.user.id);
    const currentMember = memberFor(req.company.id, req.user.id);
    if (!currentMember) fail(403, "You are no longer in this company.");
    can(currentMember, "chat");
    if (current.archived)
      fail(409, "Unarchive this channel before sending a message.");
    if (
      ducks.length &&
      one("SELECT paused FROM companies WHERE id=?", req.company.id).paused
    )
      fail(409, "The flock is paused.");
    if (conv.kind === "human") {
      const pair = one(
        "SELECT user_low,user_high FROM human_directs WHERE conversation_id=?",
        conv.id,
      );
      const peer =
        pair &&
        (pair.user_low === req.user.id ? pair.user_high : pair.user_low);
      if (!peer || !memberFor(req.company.id, peer))
        fail(
          409,
          "This teammate is no longer in the company. Your conversation history is saved.",
        );
    }
    const mid = db.transaction(() => {
      // Claim inside the transaction so a file removed meanwhile cannot be sent.
      const uploads = claimUploads(
        req.company.id,
        conv.id,
        req.user.id,
        a.upload_ids,
      );
      const msg = addMessage(
        req.company.id,
        conv.id,
        a.body ||
          (uploads.length
            ? uploads.length === 1
              ? "Shared a file."
              : `Shared ${uploads.length} files.`
            : "Shared a document."),
        { user: req.user.id, thread, inbox: true },
      );
      attachUploads(req.company.id, msg, uploads);
      run(
        "UPDATE inbox SET state='replied' WHERE user_id=? AND state='pending' AND message_id IN (SELECT id FROM messages WHERE conversation_id=? AND (thread_id IS ? OR id=?))",
        req.user.id,
        conv.id,
        thread,
        thread,
      );
      for (const doc of attached)
        attachArtifact(
          req.company.id,
          msg,
          "document",
          doc.id,
          doc.title,
          "Shared",
        );
      for (const duck of ducks)
        enqueue(req.company.id, req.user.id, conv.id, duck, msg);
      return msg;
    })();
    emit(req.company.id);
    res.json({ id: mid, thread_id: thread });
  });
  app.post("/api/conversations/:id/document-event", (req, res) => {
    can(req.member, "chat");
    const conv = conversationFor(req.params.id, req.company.id, req.user.id);
    if (conv.archived) fail(409, "Unarchive this channel first.");
    const a = z
      .object({
        document_id: uuid,
        verb: z.enum(["Created", "Updated", "Shared"]),
        thread_id: threadSchema,
      })
      .parse(req.body);
    const thread = a.thread_id
      ? threadRoot(req.company.id, conv.id, a.thread_id).id
      : null;
    const doc = tenant("documents", a.document_id, req.company.id);
    const msg = addMessage(req.company.id, conv.id, "", {
      user: req.user.id,
      thread,
      inbox: true,
    });
    attachArtifact(req.company.id, msg, "document", doc.id, doc.title, a.verb);
    emit(req.company.id);
    res.json({ id: msg, thread_id: thread });
  });
}

// Archiving is how somebody says "we are done in here", and an archived channel
// refuses new messages. It used to leave the work already under way running: a
// duck kept going, kept spending, and posted its answer into a channel nobody
// was looking at any more - including a duck holding somebody's screen and
// waiting for them to come back. Stop it, the same way pausing the flock does,
// and say how much was stopped so the screen can warn before it happens.
export async function setArchived(conv, archived, userId = null) {
  // A channel's name is free while it is archived, so another may have taken
  // it, and bringing this one back gave the sidebar two of one name.
  const taken =
    !archived &&
    userId &&
    sameName(conv.company_id, userId, conv.name, conv.id);
  if (taken)
    fail(
      409,
      "Another channel is already called #" +
        taken +
        ". Rename that one first, then unarchive this one.",
    );
  run("UPDATE conversations SET archived=? WHERE id=?", +archived, conv.id);
  const stopped = archived
    ? all(
        "SELECT * FROM jobs WHERE conversation_id=? AND status IN ('queued','running','waiting_human','waiting_consultation')",
        conv.id,
      )
    : [];
  for (const job of stopped) recordStopper(job.id, userId);
  for (const job of stopped) await cancelJob(job);
  return stopped.length;
}
