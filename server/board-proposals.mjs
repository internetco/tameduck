import crypto from "node:crypto";
import { plainMarkdown } from "./plain-markdown.mjs";
import { z } from "zod";
import { attachArtifact } from "./artifacts.mjs";
import { withTicketActor } from "./ticket-activity.mjs";
import {
  boardDigest,
  boardSnapshot,
  checkBoard,
  saveBoard,
} from "./workflows.mjs";
import { cardAnswered } from "./unfinished-work.mjs";
import {
  db,
  id,
  now,
  one,
  all,
  run,
  tenant,
  can,
  permissions,
  memberFor,
  conversationFor,
  fail,
  audit,
  addMessage,
  emit,
  DUCK_LIMIT,
} from "./store.mjs";

// Chief proposes board settings; a human approves each change unless they
// allowed Chief to change that board without asking. Tickets are not gated here.

const digest = (value) =>
  crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const toolColumn = z
  .object({
    id: z.string().default(""),
    name: z.string(),
    duck_id: z.string().default(""),
    instructions: z.string().default(""),
    approvers: z.array(z.string()).default([]),
    wait_for_ducks: z.array(z.string()).max(DUCK_LIMIT).default([]),
    review_in_order: z.boolean().default(true),
  })
  .strict();
const toolBoard = z
  .object({
    board_id: z.string().default(""),
    name: z.string(),
    description: z.string().default(""),
    enabled: z.boolean().default(true),
    auto_advance: z.boolean().default(true),
    columns: z.array(toolColumn),
    replaces_id: z.string().default(""),
  })
  .strict();
// The canonical settings compared against snapshots and passed to saveBoard.
function settings(a) {
  return {
    name: a.name,
    description: a.description,
    enabled: a.enabled,
    auto_advance: a.auto_advance,
    columns: a.columns.map((c) => ({
      ...(c.id ? { id: c.id } : {}),
      name: c.name,
      duck_id: c.duck_id || null,
      instructions: c.instructions,
      approvers: c.approvers,
      wait_for_ducks: c.wait_for_ducks,
      review_in_order: c.review_in_order,
    })),
  };
}
function snapshotSettings(snapshot) {
  const { id: _id, legacy: _legacy, ...rest } = snapshot;
  return rest;
}
// Everything about the proposal that is not about the person who asked for it.
function proposalDuck(company, duckId) {
  const duck = tenant("ducks", duckId, company);
  if (!duck.chief) fail(403, "Only Chief Duck can change task board settings.");
  if (one("SELECT paused FROM companies WHERE id=?", company)?.paused)
    fail(409, "This company is paused.");
  return duck;
}
function author(company, user, duckId) {
  const member = memberFor(company, user);
  can(member, "chat");
  can(member, "tasks");
  return proposalDuck(company, duckId);
}
// The person who asked has to still be here and still be allowed to ask. When
// they are not, that is about them and not about whoever is reading the card.
function askerStillHere(company, user) {
  const m = memberFor(company, user);
  if (m && permissions(m).chat && permissions(m).tasks) return;
  const name = one("SELECT name FROM users WHERE id=?", user)?.name;
  fail(
    409,
    (name || "The person") +
      " asked for this and can no longer make this change - they have left, or their permissions changed. Decline it, and ask Chief for it yourself if you still want it.",
  );
}
function duckNames(company, board) {
  const ids = new Set(
    board.columns.flatMap((c) =>
      [c.duck_id, ...c.approvers, ...c.wait_for_ducks].filter(Boolean),
    ),
  );
  return Object.fromEntries(
    [...ids].sort().map((d) => {
      const duck = tenant("ducks", d, company);
      return [d, { name: duck.name, role: duck.role }];
    }),
  );
}
function proposal(company, pid) {
  const p = one(
    "SELECT * FROM board_proposals WHERE id=? AND company_id=?",
    pid,
    company,
  );
  if (!p) fail(404, "This board proposal was not found.");
  return p;
}
// What a change to a board changes, counted the way BoardDiff draws it in the
// dialog, so the card's one sentence and the dialog behind it agree. Kept
// columns are the ones with the same id before and after.
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const reviewOrder = (c) =>
  c.approvers.length > 1 ? !!c.review_in_order : null;
function boardChanges(before, board) {
  if (!before) return null;
  const old = new Map(before.columns.map((c) => [c.id, c]));
  const kept = board.columns.filter((c) => c.id && old.has(c.id));
  const keptIds = new Set(kept.map((c) => c.id));
  const was = before.columns.filter((c) => keptIds.has(c.id));
  const differs = (c) => {
    const o = old.get(c.id);
    return (
      o.name !== c.name ||
      (o.duck_id || null) !== (c.duck_id || null) ||
      o.instructions !== c.instructions ||
      !same(o.approvers, c.approvers) ||
      !same(o.wait_for_ducks, c.wait_for_ducks) ||
      reviewOrder(o) !== reviewOrder(c)
    );
  };
  const flag = (key) => (!!before[key] !== !!board[key] ? !!board[key] : null);
  return {
    renamed_from: before.name !== board.name ? before.name : null,
    description: before.description !== board.description,
    enabled: flag("enabled"),
    auto_advance: flag("auto_advance"),
    added: board.columns.length - kept.length,
    changed: kept.filter(differs).length,
    removed: before.columns.length - kept.length,
    moved: kept.some((c, i) => c.id !== was[i].id),
  };
}
function presentation(p, full = false) {
  const payload = JSON.parse(p.payload);
  return {
    id: p.id,
    operation: p.operation,
    name: payload.board.name,
    board_id: p.board_id || p.result_board_id,
    status: p.status === "pending" && p.expires <= now() ? "expired" : p.status,
    fingerprint: p.fingerprint,
    message_id: p.message_id,
    conversation_id: p.conversation_id,
    thread_id: p.thread_id,
    duck_id: p.duck_id,
    user_id: p.user_id,
    created: p.created,
    expires: p.expires,
    feedback: p.feedback,
    standing_permission: !!p.grant_id,
    decided_by: p.decided_by,
    decided_by_name: p.decided_by_name ?? null,
    updated: p.updated,
    // What the card says without opening the whole configuration: each
    // stage and who does it, and for a change, what changes. A proposal
    // written down with less than this still lists, with no stages.
    stages: (payload.board.columns || []).map((c) => ({
      name: c.name,
      duck: c.duck_id ? payload.ducks?.[c.duck_id]?.name || null : null,
      checkers: (c.approvers || [])
        .map((id) => payload.ducks?.[id]?.name)
        .filter(Boolean),
    })),
    changes: boardChanges(payload.before, payload.board),
    ...(full ? { configuration: payload } : {}),
  };
}
// A grant only counts while its granter can still approve task board changes.
export function activeGrant(company, bid) {
  const g = one(
    "SELECT * FROM board_grants WHERE company_id=? AND board_id=? AND revoked_at IS NULL",
    company,
    bid,
  );
  if (!g) return null;
  const p = permissions(memberFor(company, g.granted_by));
  return p.tasks && p.approvals ? g : null;
}
export function listBoardAccess(company) {
  return all(
    `SELECT g.id,g.board_id,g.granted_by,g.created,u.name granted_by_name
    FROM board_grants g JOIN users u ON u.id=g.granted_by
    WHERE g.company_id=? AND g.revoked_at IS NULL ORDER BY g.created`,
    company,
  ).map((g) => ({ ...g, active: !!activeGrant(company, g.board_id) }));
}
function grant(company, bid, user, pid = null) {
  const board = tenant("task_boards", bid, company);
  if (board.legacy) fail(409, "General has no workflow settings to change.");
  if (activeGrant(company, bid)) return false;
  // A grant whose granter lost permission is replaced, not stacked.
  run(
    "UPDATE board_grants SET revoked_at=?,revoked_by=? WHERE board_id=? AND revoked_at IS NULL",
    now(),
    user,
    bid,
  );
  run(
    "INSERT INTO board_grants(id,company_id,board_id,granted_by,proposal_id,created) VALUES(?,?,?,?,?,?)",
    id(),
    company,
    bid,
    user,
    pid,
    now(),
  );
  audit(company, user, "Allowed Chief to change a board without asking", {
    board: board.name,
  });
  return true;
}
export function setChiefBoardAccess(company, user, bid, allow) {
  const member = memberFor(company, user);
  can(member, "tasks");
  can(member, "approvals");
  const board = tenant("task_boards", bid, company);
  z.boolean().parse(allow);
  return db.transaction(() => {
    if (allow) grant(company, bid, user);
    else if (
      one(
        "SELECT 1 FROM board_grants WHERE board_id=? AND revoked_at IS NULL",
        bid,
      )
    ) {
      run(
        "UPDATE board_grants SET revoked_at=?,revoked_by=? WHERE board_id=? AND revoked_at IS NULL",
        now(),
        user,
        bid,
      );
      audit(company, user, "Removed Chief permission to change a board", {
        board: board.name,
      });
    }
    emit(company);
    return { board_id: bid, allowed: !!activeGrant(company, bid) };
  })();
}
// Whoever is allowed to answer a proposal. A board belongs to the whole
// company, so this is the same rule the decision itself is held to.
const mayDecide = (company, user) => {
  const m = memberFor(company, user);
  return !!m && permissions(m).tasks && permissions(m).approvals;
};
export function listBoardProposals(company, user) {
  // A proposal was only ever shown inside the chat it was asked in - and that
  // is a private one-to-one with Chief. A plain member can ask (chat and tasks)
  // but cannot decide (no approvals), and the people who can decide were never
  // shown it at all: it was absent from their workspace and the id itself
  // answered 403. So nobody could answer, and after a day the proposal expired
  // with the board unchanged and nothing said to anyone. Anyone who may decide
  // now sees the ones still waiting, exactly as tool approvals work. Only the
  // ones still waiting: a decided proposal is the asker's own history and has
  // no business in a stranger's Needs you.
  return all(
    `SELECT p.*,du.name decided_by_name FROM board_proposals p
    LEFT JOIN users du ON du.id=p.decided_by
    WHERE p.company_id=? AND p.message_id IS NOT NULL
    AND (EXISTS(SELECT 1 FROM conversation_members cm WHERE cm.conversation_id=p.conversation_id AND cm.user_id=?)
      OR (?=1 AND p.status='pending' AND p.expires>?))
    ORDER BY p.created DESC, p.rowid DESC LIMIT 100`,
    company,
    user,
    mayDecide(company, user) ? 1 : 0,
    now(),
  ).map((p) => presentation(p));
}
// Reading and deciding follow the list: the chat it was asked in, or the
// permission to answer it.
function visible(company, user, p) {
  // Only while it is still waiting. Once it has been decided it is the
  // asker's own history, and the chat it sits in is theirs.
  if (p.status === "pending" && p.expires > now() && mayDecide(company, user))
    return;
  conversationFor(p.conversation_id, company, user);
}
export function readBoardProposal(company, user, pid) {
  const p = proposal(company, pid);
  visible(company, user, p);
  return presentation(p, true);
}
export function chiefReadBoardProposal(job, pid) {
  author(job.company_id, job.user_id, job.duck_id);
  const p = proposal(job.company_id, z.string().uuid().parse(pid));
  if (
    p.duck_id !== job.duck_id ||
    p.user_id !== job.user_id ||
    p.conversation_id !== job.conversation_id
  )
    fail(403, "Read this proposal in its original Chief conversation.");
  return readBoardProposal(job.company_id, job.user_id, p.id);
}
export function proposeBoard(job, args, callId) {
  const c = job.company_id;
  const chief = author(c, job.user_id, job.duck_id);
  const conv = conversationFor(job.conversation_id, c, job.user_id);
  if (conv.archived) fail(409, "This conversation is archived.");
  const input = toolBoard.parse(args);
  const bid = input.board_id ? z.string().uuid().parse(input.board_id) : null;
  // Use the validated (trimmed, defaulted) settings so the review shows exactly what is saved.
  const board = settings(checkBoard(c, settings(input), bid).a);
  const before = bid ? boardSnapshot(c, bid) : null;
  if (before && digest(snapshotSettings(before)) === digest(board))
    fail(409, "These settings already match the board. Nothing to change.");
  const payload = {
    board,
    before,
    ducks: duckNames(c, {
      columns: [...board.columns, ...(before?.columns || [])],
    }),
  };
  const pid = id(),
    created = now(),
    expires = new Date(Date.now() + 86400000).toISOString(),
    operation = bid ? "update" : "create",
    base = before ? boardDigest(c, bid) : "",
    fingerprint = digest({ operation, payload, base, pid });
  return db.transaction(() => {
    const previous = one(
      "SELECT result FROM tool_receipts WHERE job_id=? AND call_id=?",
      job.id,
      callId,
    );
    if (previous) return JSON.parse(previous.result);
    if (input.replaces_id) {
      const old = proposal(c, input.replaces_id);
      if (
        old.user_id !== job.user_id ||
        old.duck_id !== job.duck_id ||
        old.conversation_id !== job.conversation_id
      )
        fail(
          403,
          "Only the original Chief conversation can revise this proposal.",
        );
      if (!["pending", "changes_requested"].includes(old.status))
        fail(409, "This proposal can no longer be revised.");
      run(
        "UPDATE board_proposals SET status='superseded',updated=? WHERE id=?",
        created,
        old.id,
      );
    }
    const standing = bid && activeGrant(c, bid);
    let result;
    if (standing) {
      withTicketActor(c, { user_id: job.user_id, duck_id: chief.id }, () =>
        saveBoard(c, job.user_id, board, bid),
      );
      run(
        `INSERT INTO board_proposals(id,company_id,job_id,user_id,duck_id,conversation_id,thread_id,board_id,operation,payload,base,fingerprint,status,replaces_id,result_board_id,grant_id,created,updated,expires)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'applied',?,?,?,?,?,?)`,
        pid,
        c,
        job.id,
        job.user_id,
        chief.id,
        job.conversation_id,
        job.thread_id || null,
        bid,
        operation,
        JSON.stringify(payload),
        base,
        fingerprint,
        input.replaces_id || null,
        bid,
        standing.id,
        created,
        created,
        expires,
      );
      attachArtifact(
        c,
        job.output_message_id,
        "board",
        bid,
        board.name,
        "Updated",
      );
      audit(c, job.user_id, "Chief changed a board with standing permission", {
        proposal: pid,
        board: board.name,
        granted_by: standing.granted_by,
      });
      result = {
        proposal_id: pid,
        status: "applied",
        board_id: bid,
        message:
          "Applied. A human allowed Chief Duck to change this board without asking. Tell the human what changed.",
      };
    } else {
      const mid = addMessage(
        c,
        job.conversation_id,
        // The card under it says what will change and that nothing has yet,
        // so Chief says only what it prepared.
        `I've prepared ${bid ? "changes to the " + plainMarkdown(before.name) + " task board" : "a new " + plainMarkdown(board.name) + " task board"}.`,
        { duck: chief.id, thread: job.thread_id || null },
      );
      run(
        `INSERT INTO board_proposals(id,company_id,job_id,user_id,duck_id,conversation_id,thread_id,message_id,board_id,operation,payload,base,fingerprint,replaces_id,created,updated,expires)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        pid,
        c,
        job.id,
        job.user_id,
        chief.id,
        job.conversation_id,
        job.thread_id || null,
        mid,
        bid,
        operation,
        JSON.stringify(payload),
        base,
        fingerprint,
        input.replaces_id || null,
        created,
        created,
        expires,
      );
      audit(c, job.user_id, "Chief proposed board " + operation, {
        proposal: pid,
        board: board.name,
      });
      result = {
        proposal_id: pid,
        status: "pending",
        name: board.name,
        message:
          "The board settings are waiting for human approval in this conversation and Needs you. Nothing has been changed. Stop and wait. Only the approval button applies this; chat agreement is not approval. You will get a new message after the decision. To revise, propose again with this replaces_id.",
      };
    }
    run(
      "INSERT INTO tool_receipts VALUES(?,?,?)",
      job.id,
      callId,
      JSON.stringify(result),
    );
    emit(c);
    return result;
  })();
}
const decisionSchema = z
  .object({
    decision: z.enum(["approve", "deny", "changes"]),
    fingerprint: z.string().length(64),
    feedback: z.string().trim().max(4000).optional(),
    always_allow: z.boolean().default(false),
  })
  .strict();
export function decideBoardProposal(company, user, pid, input) {
  const a = decisionSchema.parse(input);
  const member = memberFor(company, user);
  can(member, "tasks");
  can(member, "approvals");
  if (a.decision === "changes" && !a.feedback)
    fail(400, "Describe the changes you want.");
  if (a.always_allow && a.decision !== "approve")
    fail(400, "Only an approval can allow future changes.");
  return db.transaction(() => {
    const p = proposal(company, pid);
    visible(company, user, p);
    if (p.fingerprint !== a.fingerprint)
      fail(409, "Reopen the board settings before deciding.");
    if (p.status !== "pending")
      fail(409, "This proposal has already been handled.");
    if (p.expires <= now())
      fail(409, "This proposal expired. Ask Chief for a fresh proposal.");
    const payload = JSON.parse(p.payload);
    if (
      digest({
        operation: p.operation,
        payload,
        base: p.base,
        pid: p.id,
      }) !== p.fingerprint
    )
      fail(409, "The proposal changed. Ask Chief for a fresh proposal.");
    const name = payload.board.name;
    let bid = p.board_id,
      message;
    if (a.decision === "approve") {
      // A proposal is asked for on somebody's authority, and it is still
      // checked against theirs - they may have left, or lost the permission,
      // between asking and this. What that used to do was run their permission
      // check and report the failure as the approver's own: the owner pressing
      // Approve was told *they* could not chat with ducks and that their
      // company owner could grant it in Settings. Say whose it is, and what to
      // do about it.
      askerStillHere(company, p.user_id);
      author(company, p.user_id, p.duck_id);
      if (conversationFor(p.conversation_id, company, p.user_id).archived)
        fail(409, "This conversation is archived.");
      if (bid && boardDigest(company, bid) !== p.base)
        fail(
          409,
          "This board changed after Chief proposed this. Ask Chief for a fresh proposal.",
        );
      bid = withTicketActor(
        company,
        { user_id: user, duck_id: p.duck_id },
        () => saveBoard(company, p.user_id, payload.board, bid),
      ).id;
      if (a.always_allow) grant(company, bid, user, pid);
      message = `Approved ${p.operation === "create" ? "the new" : "changes to the"} ${plainMarkdown(name)} task board.${a.always_allow ? " Chief Duck may change this board's settings without asking until someone removes that permission." : ""} [Open board](/w/${company}/tasks/boards/${bid}).\n\nChief: continue the original request if anything is left, such as creating tickets. Do not propose these settings again.`;
    } else
      message =
        a.decision === "deny"
          ? `Declined board proposal ${plainMarkdown(name)}. Nothing was changed.`
          : a.feedback;
    const status =
      a.decision === "approve"
        ? "applied"
        : a.decision === "deny"
          ? "denied"
          : "changes_requested";
    run(
      "UPDATE board_proposals SET status=?,decided_by=?,feedback=?,result_board_id=?,updated=? WHERE id=? AND status='pending'",
      status,
      user,
      a.feedback || null,
      a.decision === "approve" ? bid : null,
      now(),
      pid,
    );
    const mid = addMessage(company, p.conversation_id, message, {
      user,
      thread: p.thread_id || null,
    });
    audit(company, user, "Board proposal " + status, {
      proposal: pid,
      board: name,
      always_allow: a.always_allow,
    });
    return {
      ...presentation(proposal(company, pid)),
      decision_message_id: mid,
      request_user_id: p.user_id,
      chief_id: p.duck_id,
    };
  })();
}
export function registerBoardProposals(app, { enqueue }) {
  app.get("/api/board-proposals/:id", (req, res) =>
    res.json(readBoardProposal(req.company.id, req.user.id, req.params.id)),
  );
  app.post("/api/board-proposals/:id/decide", (req, res) => {
    const result = decideBoardProposal(
      req.company.id,
      req.user.id,
      req.params.id,
      req.body,
    );
    // Chief resumes after an approval or a change request; a decline ends the proposal.
    const carriedOn =
      result.status !== "denied" &&
      !req.company.paused &&
      permissions(memberFor(req.company.id, result.request_user_id)).chat;
    if (carriedOn)
      enqueue(
        req.company.id,
        result.request_user_id,
        result.conversation_id,
        result.chief_id,
        result.decision_message_id,
        { acknowledge: false },
      );
    cardAnswered(
      one(
        "SELECT job_id FROM board_proposals WHERE id=? AND company_id=?",
        req.params.id,
        req.company.id,
      )?.job_id,
      req.company.id,
      { carriedOn },
    );
    emit(req.company.id);
    res.json(result);
  });
  app.post("/api/boards/:id/chief-access", (req, res) =>
    res.json(
      setChiefBoardAccess(
        req.company.id,
        req.user.id,
        req.params.id,
        req.body?.allow,
      ),
    ),
  );
}
