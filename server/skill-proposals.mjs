import crypto from "node:crypto";
import { plainMarkdown } from "./plain-markdown.mjs";
import { z } from "zod";
import { skillSchema, saveSkill, listSkills } from "./skills.mjs";
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

const digest = (value) =>
  crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const replacement = z.string().uuid().or(z.literal(""));
const targets = z.array(z.string().uuid()).min(1).max(DUCK_LIMIT);
const createSchema = skillSchema
  .omit({ version: true })
  .extend({ ducks: targets, replaces_id: replacement })
  .strict();
const assignSchema = z
  .object({
    skill_id: z.string().uuid(),
    ducks: targets,
    replaces_id: replacement,
  })
  .strict();
// Everything about the proposal that is not about the person who asked for it.
function proposalDuck(company, duckId) {
  const duck = tenant("ducks", duckId, company);
  if (!duck.chief) fail(403, "Only Chief Duck can propose skill changes.");
  if (tenantCompany(company).paused) fail(409, "This company is paused.");
  return duck;
}
function author(company, user, duckId) {
  const member = memberFor(company, user);
  can(member, "chat");
  can(member, "skills");
  can(member, "ducks");
  return proposalDuck(company, duckId);
}
// The person who asked has to still be here and still be allowed to ask. When
// they are not, that is about them and not about whoever is reading the card.
function askerStillHere(company, user) {
  const m = memberFor(company, user);
  if (m && permissions(m).chat && permissions(m).skills && permissions(m).ducks)
    return;
  const name = one("SELECT name FROM users WHERE id=?", user)?.name;
  fail(
    409,
    (name || "The person") +
      " asked for this and can no longer make this change - they have left, or their permissions changed. Decline it, and ask Chief for it yourself if you still want it.",
  );
}
function tenantCompany(company) {
  const c = one("SELECT * FROM companies WHERE id=?", company);
  if (!c) fail(404, "Company not found.");
  return c;
}
function skillSnapshot(company, sid) {
  const s = tenant("skills", sid, company);
  return {
    id: s.id,
    name: s.name,
    description: s.description,
    content: s.content,
    enabled: !!s.enabled,
    version: s.version,
    ducks: all(
      "SELECT duck_id FROM duck_skills WHERE skill_id=? ORDER BY duck_id",
      sid,
    ).map((d) => d.duck_id),
  };
}
function duckSnapshots(company, ids) {
  return [...new Set(ids)].sort().map((id) => {
    const d = tenant("ducks", id, company);
    return { id: d.id, name: d.name, role: d.role };
  });
}
function proposal(company, pid) {
  const p = one(
    "SELECT * FROM skill_proposals WHERE id=? AND company_id=?",
    pid,
    company,
  );
  if (!p) fail(404, "This proposal was not found.");
  return p;
}
// Whoever is allowed to answer a proposal - the same rule the decision itself
// is held to. A skill belongs to the whole company, but the proposal was only
// ever shown inside the private chat it was asked in, so somebody who could ask
// but not decide left a proposal nobody could reach, and it expired unanswered.
const mayDecide = (company, user) => {
  const m = memberFor(company, user);
  return (
    !!m &&
    permissions(m).skills &&
    permissions(m).ducks &&
    permissions(m).approvals
  );
};
function visible(company, user, p) {
  // Only while it is still waiting. Once it has been decided it is the
  // asker's own history, and the chat it sits in is theirs.
  if (p.status === "pending" && p.expires > now() && mayDecide(company, user))
    return;
  conversationFor(p.conversation_id, company, user);
}
// Ducks by name, as the card says them: "A", "A and B", "A, B and C", and
// after three "A, B, C and 2 more".
function names(list) {
  const shown =
    list.length > 3 ? [...list.slice(0, 3), list.length - 3 + " more"] : list;
  return shown.length < 2
    ? shown.join("")
    : shown.slice(0, -1).join(", ") + " and " + shown[shown.length - 1];
}
// Which ducks the proposal gives the skill to, and which already have it.
function whoGetsIt(payload) {
  const had = new Set(payload.existing?.ducks || []);
  return {
    duck_names: payload.ducks.filter((d) => !had.has(d.id)).map((d) => d.name),
    already_names: payload.ducks
      .filter((d) => had.has(d.id))
      .map((d) => d.name),
  };
}
function presentation(p, full = false) {
  const payload = JSON.parse(p.payload);
  return {
    id: p.id,
    operation: p.operation,
    name: payload.skill.name,
    status: p.status === "pending" && p.expires <= now() ? "expired" : p.status,
    fingerprint: p.fingerprint,
    message_id: p.message_id,
    conversation_id: p.conversation_id,
    thread_id: p.thread_id,
    duck_id: p.duck_id,
    user_id: p.user_id,
    created: p.created,
    expires: p.expires,
    result_skill_id: p.result_skill_id,
    feedback: p.feedback,
    // What the card says without opening the whole configuration.
    description: payload.skill.description,
    enabled: payload.skill.enabled,
    ...whoGetsIt(payload),
    decided_by: p.decided_by,
    decided_by_name: p.decided_by_name ?? null,
    updated: p.updated,
    ...(full
      ? {
          configuration: payload,
          company_name: tenantCompany(p.company_id).name,
        }
      : {}),
  };
}
export function listSkillProposals(company, user) {
  // The chat it was asked in, or the permission to answer it - and for the
  // latter only the ones still waiting, because a decided proposal is the
  // asker's own history and has no business in a stranger's Needs you.
  return all(
    `SELECT p.*,du.name decided_by_name FROM skill_proposals p
    LEFT JOIN users du ON du.id=p.decided_by
    WHERE p.company_id=?
    AND (EXISTS(SELECT 1 FROM conversation_members cm WHERE cm.conversation_id=p.conversation_id AND cm.user_id=?)
      OR (?=1 AND p.status='pending' AND p.expires>?))
    ORDER BY p.created DESC, p.rowid DESC LIMIT 100`,
    company,
    user,
    mayDecide(company, user) ? 1 : 0,
    now(),
  ).map((p) => presentation(p));
}
export function readSkillProposal(company, user, pid) {
  const p = proposal(company, pid);
  visible(company, user, p);
  return presentation(p, true);
}
export function chiefSkillCatalog(job) {
  author(job.company_id, job.user_id, job.duck_id);
  return listSkills(job.company_id);
}
export function chiefReadSkillProposal(job, pid) {
  author(job.company_id, job.user_id, job.duck_id);
  const prior = proposal(job.company_id, z.string().uuid().parse(pid));
  if (
    prior.duck_id !== job.duck_id ||
    prior.user_id !== job.user_id ||
    prior.conversation_id !== job.conversation_id ||
    prior.thread_id !== (job.thread_id || null)
  )
    fail(
      403,
      "Read and revise this proposal in its original Chief conversation.",
    );
  return readSkillProposal(job.company_id, job.user_id, prior.id);
}
export function proposeSkill(job, operation, args, callId) {
  const c = job.company_id;
  const chief = author(c, job.user_id, job.duck_id);
  const conv = conversationFor(job.conversation_id, c, job.user_id);
  if (conv.archived) fail(409, "This conversation is archived.");
  const a = (operation === "create" ? createSchema : assignSchema).parse(args);
  let skill,
    existing = null;
  if (operation === "assign") {
    existing = skillSnapshot(c, a.skill_id);
    skill = {
      ...existing,
      ducks: [...new Set([...existing.ducks, ...a.ducks])].sort(),
    };
    if (skill.ducks.length > DUCK_LIMIT)
      fail(
        400,
        `A skill can be assigned to at most ${DUCK_LIMIT} ducks.`,
      );
    if (skill.ducks.length === existing.ducks.length)
      fail(409, "These ducks already have this skill.");
  } else {
    if (one("SELECT count(*) n FROM skills WHERE company_id=?", c).n >= 100)
      fail(400, "This company already has 100 skills.");
    skill = skillSchema.parse(a);
    skill.ducks = [...new Set(skill.ducks)].sort();
  }
  const payload = { skill, existing, ducks: duckSnapshots(c, skill.ducks) };
  const pid = id(),
    created = now(),
    expires = new Date(Date.now() + 86400000).toISOString();
  const fingerprint = digest({ operation, payload, pid });
  return db.transaction(() => {
    const previous = one(
      "SELECT result FROM tool_receipts WHERE job_id=? AND call_id=?",
      job.id,
      callId,
    );
    if (previous) return JSON.parse(previous.result);
    if (a.replaces_id) {
      const old = proposal(c, a.replaces_id);
      if (
        old.user_id !== job.user_id ||
        old.duck_id !== job.duck_id ||
        old.conversation_id !== job.conversation_id ||
        old.thread_id !== (job.thread_id || null)
      )
        fail(
          403,
          "Only the original Chief conversation can revise this proposal.",
        );
      if (!["pending", "changes_requested"].includes(old.status))
        fail(409, "This proposal can no longer be revised.");
      run(
        "UPDATE skill_proposals SET status='superseded',updated=? WHERE id=?",
        created,
        old.id,
      );
    }
    // The card under it says what will change and that nothing has yet, so
    // Chief says only what it prepared.
    const getting = names(whoGetsIt(payload).duck_names);
    const mid = addMessage(
      c,
      job.conversation_id,
      operation === "create"
        ? `I've prepared a skill for ${plainMarkdown(getting)}.`
        : `I've prepared the skill ${plainMarkdown(skill.name)} for ${plainMarkdown(getting)}.`,
      { duck: chief.id, thread: job.thread_id || null },
    );
    run(
      `INSERT INTO skill_proposals(id,company_id,job_id,user_id,duck_id,conversation_id,thread_id,message_id,operation,payload,fingerprint,replaces_id,created,updated,expires)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      pid,
      c,
      job.id,
      job.user_id,
      chief.id,
      job.conversation_id,
      job.thread_id || null,
      mid,
      operation,
      JSON.stringify(payload),
      fingerprint,
      a.replaces_id || null,
      created,
      created,
      expires,
    );
    const result = {
      proposal_id: pid,
      status: "pending",
      name: skill.name,
      message:
        "The complete skill configuration and target ducks are ready for human review in this conversation and Needs you. No skill has been saved or assigned. Stop and wait. Only the human approval button can apply this proposal; chat agreement is not approval. To revise it, submit a new proposal with this replaces_id.",
    };
    run(
      "INSERT INTO tool_receipts VALUES(?,?,?)",
      job.id,
      callId,
      JSON.stringify(result),
    );
    audit(c, job.user_id, "Chief proposed skill " + operation, {
      proposal: pid,
      name: skill.name,
      ducks: skill.ducks,
    });
    return result;
  })();
}
const decisionSchema = z
  .object({
    decision: z.enum(["approve", "deny", "changes"]),
    fingerprint: z.string().length(64),
    feedback: z.string().trim().max(4000).optional(),
  })
  .strict();
export function decideSkillProposal(company, user, pid, input) {
  const a = decisionSchema.parse(input);
  const member = memberFor(company, user);
  can(member, "skills");
  can(member, "ducks");
  can(member, "approvals");
  if (a.decision === "changes" && !a.feedback)
    fail(400, "Describe the changes you want.");
  return db.transaction(() => {
    const p = proposal(company, pid);
    visible(company, user, p);
    if (p.fingerprint !== a.fingerprint)
      fail(409, "Reopen the complete configuration before deciding.");
    if (p.status !== "pending")
      fail(409, "This proposal has already been handled.");
    if (p.expires <= now())
      fail(409, "This proposal expired. Ask Chief for a fresh proposal.");
    const payload = JSON.parse(p.payload);
    if (
      digest({ operation: p.operation, payload, pid: p.id }) !== p.fingerprint
    )
      fail(409, "The proposal changed. Ask Chief for a fresh proposal.");
    let sid = null,
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
      if (
        digest(duckSnapshots(company, payload.skill.ducks)) !==
        digest(payload.ducks)
      )
        fail(409, "A selected duck changed. Ask Chief for a fresh proposal.");
      if (p.operation === "assign") {
        if (
          digest(skillSnapshot(company, payload.existing.id)) !==
          digest(payload.existing)
        )
          fail(
            409,
            "This skill or its assignments changed. Ask Chief for a fresh proposal.",
          );
        sid = payload.existing.id;
        for (const duck of payload.skill.ducks)
          run("INSERT OR IGNORE INTO duck_skills VALUES(?,?)", duck, sid);
      } else {
        sid = saveSkill(company, payload.skill).id;
      }
      message = `Approved skill ${p.operation === "create" ? "creation" : "assignment"}: ${plainMarkdown(payload.skill.name)}. ${payload.skill.enabled ? "Available to" : "Saved disabled for"} ${payload.ducks.map((d) => plainMarkdown(d.name)).join(", ")}. [Open skill](/w/${company}/skills/${sid}).`;
    } else
      message =
        a.decision === "deny"
          ? `Declined skill proposal ${plainMarkdown(payload.skill.name)}. No skill was saved or assigned.`
          : a.feedback;
    const status =
      a.decision === "approve"
        ? "applied"
        : a.decision === "deny"
          ? "denied"
          : "changes_requested";
    run(
      "UPDATE skill_proposals SET status=?,decided_by=?,feedback=?,result_skill_id=?,updated=? WHERE id=? AND status='pending'",
      status,
      user,
      a.feedback || null,
      sid,
      now(),
      pid,
    );
    const mid = addMessage(company, p.conversation_id, message, {
      user,
      thread: p.thread_id || null,
    });
    audit(company, user, "Skill proposal " + status, {
      proposal: pid,
      skill: sid,
      fingerprint: p.fingerprint,
    });
    return {
      ...presentation(proposal(company, pid)),
      decision_message_id: mid,
      request_user_id: p.user_id,
      chief_id: p.duck_id,
    };
  })();
}
export function registerSkillProposals(app, { enqueue }) {
  app.get("/api/skill-proposals/:id", (req, res) =>
    res.json(readSkillProposal(req.company.id, req.user.id, req.params.id)),
  );
  app.post("/api/skill-proposals/:id/decide", (req, res) => {
    const result = decideSkillProposal(
      req.company.id,
      req.user.id,
      req.params.id,
      req.body,
    );
    const carriedOn =
      result.status === "changes_requested" &&
      !req.company.paused &&
      permissions(memberFor(req.company.id, result.request_user_id)).chat;
    if (carriedOn) {
      enqueue(
        req.company.id,
        result.request_user_id,
        result.conversation_id,
        result.chief_id,
        result.decision_message_id,
        { acknowledge: false },
      );
    }
    cardAnswered(
      one(
        "SELECT job_id FROM skill_proposals WHERE id=? AND company_id=?",
        req.params.id,
        req.company.id,
      )?.job_id,
      req.company.id,
      { carriedOn },
    );
    emit(req.company.id);
    res.json(result);
  });
}
