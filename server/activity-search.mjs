import { z } from "zod";
import {
  all,
  one,
  tenant,
  memberFor,
  permissions,
  can,
  fail,
  conversationFor,
} from "./store.mjs";
import { companyTimezone } from "./schedules.mjs";
// These used to create the tables searched below; the migrations do that now.
// Still imported first so modules load in the same order as before.
import "./artifacts.mjs";
import "./uploads.mjs";
import "./computers.mjs";
import "./ticket-activity.mjs";

const KINDS = ["message", "work", "ticket", "document", "file", "screenshot"];
const TERMINAL_JOBS = [
  "done",
  "error",
  "interrupted",
  "cancelled",
  "failed",
  "steer_unknown",
];
const argsSchema = z
  .object({
    query: z.string().trim().max(200).optional(),
    period: z
      .enum(["today", "yesterday", "last_7_days", "all"])
      .default("today"),
    date_from: z.string().optional(),
    date_to: z.string().optional(),
    actor_duck_id: z
      .union([z.enum(["self", "any"]), z.string().uuid()])
      .default("self"),
    kinds: z.array(z.enum(KINDS)).min(1).max(KINDS.length).optional(),
    scope: z
      .enum(["accessible", "current_conversation", "current_ticket"])
      .default("accessible"),
    limit: z
      .number()
      .int()
      .min(1)
      .transform((value) => Math.min(value, 50))
      .default(25),
    cursor: z.string().max(1000).optional(),
  })
  .strict();

const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const dayParts = (date) => date.split("-").map(Number);
function validDate(value) {
  if (!datePattern.test(value || "")) fail(400, "Dates must use YYYY-MM-DD.");
  const [year, month, day] = dayParts(value);
  const checked = new Date(Date.UTC(year, month - 1, day));
  if (
    checked.getUTCFullYear() !== year ||
    checked.getUTCMonth() !== month - 1 ||
    checked.getUTCDate() !== day
  )
    fail(400, "That calendar date is not valid.");
  return value;
}
function shiftDate(value, days) {
  const [year, month, day] = dayParts(value);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return shifted.toISOString().slice(0, 10);
}
function localDate(at, timezone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(at);
  const get = (type) => parts.find((part) => part.type === type).value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}
function zonedMidnight(value, timezone) {
  const [year, month, day] = dayParts(value);
  const target = Date.UTC(year, month - 1, day);
  let result = target;
  const format = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  for (let attempt = 0; attempt < 3; attempt++) {
    const parts = format.formatToParts(new Date(result));
    const get = (type) => +parts.find((part) => part.type === type).value;
    const represented = Date.UTC(
      get("year"),
      get("month") - 1,
      get("day"),
      get("hour"),
      get("minute"),
      get("second"),
    );
    result += target - represented;
  }
  return new Date(result).toISOString();
}
function resolveRange(args, timezone, clock) {
  const today = localDate(new Date(clock()), timezone);
  let from;
  let to;
  if (args.date_from || args.date_to) {
    from = validDate(args.date_from || args.date_to);
    to = validDate(args.date_to || args.date_from);
  } else if (args.period === "all") {
    return {
      date_from: null,
      date_to: today,
      start: null,
      end: zonedMidnight(shiftDate(today, 1), timezone),
    };
  } else {
    to = args.period === "yesterday" ? shiftDate(today, -1) : today;
    from = args.period === "last_7_days" ? shiftDate(today, -6) : to;
  }
  if (from > to) fail(400, "date_from must not be after date_to.");
  return {
    date_from: from,
    date_to: to,
    start: zonedMidnight(from, timezone),
    end: zonedMidnight(shiftDate(to, 1), timezone),
  };
}

function ftsQuery(query) {
  if (!query) return null;
  const tokens = query.match(/[\p{L}\p{N}_]+/gu)?.slice(0, 20) || [];
  if (!tokens.length) fail(400, "Search for at least one letter or number.");
  return tokens
    .map((token) => `"${token.replaceAll('"', '""')}"`)
    .join(" AND ");
}
function encodeCursor(event) {
  return Buffer.from(
    JSON.stringify({ at: event.occurred_at, id: event.id }),
  ).toString("base64url");
}
function decodeCursor(value) {
  if (!value) return null;
  try {
    return z
      .object({ at: z.string().datetime(), id: z.string().min(1).max(300) })
      .parse(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
  } catch {
    fail(400, "That activity cursor is invalid.");
  }
}
const compact = (value, max) => {
  const text = String(value || "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? text.slice(0, max - 1).trimEnd() + "…" : text;
};
const actor = (row) => {
  if (row.actor_duck_id)
    return {
      type: "duck",
      id: row.actor_duck_id,
      name: row.actor_duck_name || "Former duck",
    };
  if (row.actor_user_id)
    return {
      type: "user",
      id: row.actor_user_id,
      name: row.actor_user_name || "Former teammate",
    };
  if (row.actor_type === "shared")
    return { type: "shared", name: "Shared workspace" };
  return { type: "system", name: "Workspace" };
};
const chatUrl = (company, conversation, thread, message) =>
  `/w/${company}/chat/${conversation}/thread/${thread || message}`;

function currentContext(job) {
  const root = one(
    `SELECT root.* FROM jobs current
     JOIN jobs root ON root.id=coalesce(current.root_job_id,current.id)
     WHERE current.id=? AND current.company_id=?`,
    job.id,
    job.company_id,
  );
  if (!root) fail(404, "This run is unavailable.");
  const conversation = tenant(
    "conversations",
    root.conversation_id,
    job.company_id,
  );
  // Ticket-owned conversations intentionally have no human members. The
  // caller's current membership is the authorization boundary for ticket
  // activity; private chats still require current conversation membership.
  if (!conversation.task_id)
    conversationFor(root.conversation_id, job.company_id, job.user_id);
  const consultation = one(
    "SELECT task_id,parent_job_id FROM duck_consultations WHERE child_job_id=? AND company_id=?",
    job.id,
    job.company_id,
  );
  if (
    !conversation.task_id &&
    !one(
      "SELECT 1 FROM conversation_ducks WHERE conversation_id=? AND duck_id=?",
      conversation.id,
      job.duck_id,
    ) &&
    consultation?.parent_job_id == null
  )
    fail(
      403,
      "This duck no longer has access to the destination conversation.",
    );
  return {
    root,
    conversation,
    task_id: job.task_id || consultation?.task_id || root.task_id || null,
  };
}

function sqlFor({ query, kinds, scope, actorDuck, range, cursor, context }) {
  const match = (type, id) =>
    query
      ? `EXISTS(SELECT 1 FROM matched WHERE source_type='${type}' AND source_id=CAST(${id} AS TEXT))`
      : "1";
  const chatAccess = (conversation) =>
    `${conversation} IN (SELECT id FROM accessible_conversations)`;
  const audienceAccess = (conversation) =>
    `${conversation} IN (SELECT id FROM audience_conversations)`;
  const branches = [];
  branches.push(`SELECT 'message:'||m.id event_id,'message' kind,
    CASE WHEN m.user_id IS NOT NULL THEN 'Sent message' ELSE 'Replied' END action,
    coalesce(d.name,u.name,'Message') title,m.body snippet,
    coalesce(CASE WHEN j.output_message_id=m.id THEN j.updated END,m.created) occurred_at,
    m.created resource_created_at,m.duck_id actor_duck_id,m.user_id actor_user_id,
    d.name actor_duck_name,u.name actor_user_name,NULL actor_type,
    'chat' destination_type,m.conversation_id destination_id,m.conversation_id,
    m.id message_id,m.thread_id,NULL task_id,NULL document_id,NULL upload_id,NULL capture_id,
    j.id job_id,NULL evidence_type,1 available,NULL original_action,NULL original_occurred_at
   FROM messages m
   JOIN conversations c ON c.id=m.conversation_id AND c.company_id=m.company_id
   LEFT JOIN ducks d ON d.id=m.duck_id LEFT JOIN users u ON u.id=m.user_id
   LEFT JOIN jobs j ON j.output_message_id=m.id AND j.company_id=m.company_id
   WHERE m.company_id=:company AND c.kind<>'consultation' AND c.task_id IS NULL
     AND m.state IN ('sent','error','cancelled') AND m.id<>:current_output
     AND m.origin IS NOT 'chief_checkin'
     AND (coalesce(j.checkin,0)=0 OR (m.state='sent' AND m.body<>''))
     AND (j.id IS NULL OR j.status IN (${TERMINAL_JOBS.map((x) => `'${x}'`).join(",")}))
     AND (m.user_id IS NULL OR m.rowid<=:request_boundary)
     AND ${chatAccess("m.conversation_id")} AND ${match("message", "m.id")}`);

  branches.push(`SELECT 'work:'||j.id event_id,'work' kind,
    CASE j.status WHEN 'done' THEN 'Completed work' WHEN 'cancelled' THEN 'Cancelled work'
      WHEN 'interrupted' THEN 'Work interrupted' ELSE 'Work failed' END action,
    substr(coalesce(nullif(input.body,''),'Saved work'),1,500) title,
    substr(coalesce(nullif(output.body,''),j.error,''),1,1200) snippet,j.updated occurred_at,
    j.created resource_created_at,j.duck_id actor_duck_id,NULL actor_user_id,
    d.name actor_duck_name,NULL actor_user_name,NULL actor_type,
    'chat' destination_type,j.conversation_id destination_id,j.conversation_id,
    j.output_message_id message_id,j.thread_id,NULL task_id,NULL document_id,NULL upload_id,NULL capture_id,
    j.id job_id,NULL evidence_type,1 available,NULL original_action,NULL original_occurred_at
   FROM jobs j JOIN conversations c ON c.id=j.conversation_id AND c.company_id=j.company_id
   JOIN ducks d ON d.id=j.duck_id LEFT JOIN messages input ON input.id=j.input_message_id
   LEFT JOIN messages output ON output.id=j.output_message_id
   WHERE j.company_id=:company AND j.checkin=0 AND j.status IN (${TERMINAL_JOBS.map((x) => `'${x}'`).join(",")})
     AND j.parent_job_id IS NULL AND c.kind<>'consultation' AND c.task_id IS NULL
     AND ${chatAccess("j.conversation_id")}
     AND (${match("message", "input.id")} OR ${match("message", "output.id")})`);

  branches.push(`SELECT 'consultation-work:'||dc.id event_id,'work' kind,
    CASE dc.status WHEN 'answered' THEN 'Completed requested help' WHEN 'cancelled' THEN 'Requested help cancelled'
      WHEN 'timed_out' THEN 'Requested help timed out' ELSE 'Requested help failed' END action,
    dc.question title,coalesce(dc.answer,dc.error,'') snippet,dc.updated occurred_at,
    dc.created resource_created_at,dc.to_duck_id actor_duck_id,NULL actor_user_id,
    d.name actor_duck_name,NULL actor_user_name,NULL actor_type,
    CASE WHEN dc.task_id IS NOT NULL THEN 'ticket' ELSE 'chat' END destination_type,
    coalesce(dc.task_id,root.conversation_id) destination_id,root.conversation_id,
    root.output_message_id message_id,root.thread_id,dc.task_id,NULL document_id,NULL upload_id,NULL capture_id,
    dc.child_job_id job_id,NULL evidence_type,1 available,NULL original_action,NULL original_occurred_at
   FROM duck_consultations dc JOIN jobs parent ON parent.id=dc.parent_job_id
   JOIN jobs root ON root.id=coalesce(parent.root_job_id,parent.id)
   JOIN ducks d ON d.id=dc.to_duck_id
   WHERE dc.company_id=:company AND dc.status IN ('answered','failed','timed_out','cancelled')
     AND (dc.task_id IS NOT NULL OR (${audienceAccess("root.conversation_id")}
       AND (${chatAccess("root.conversation_id")} OR dc.to_duck_id=:duck)))
     AND (${match("message", "parent.input_message_id")} OR ${match("message", "parent.output_message_id")})`);

  branches.push(`SELECT 'ticket:'||printf('%020d',a.id) event_id,
    CASE WHEN a.kind='document' THEN 'document' WHEN a.kind='file' THEN 'file'
      WHEN a.kind='work' THEN 'work' ELSE 'ticket' END kind,
    a.action,coalesce(nullif(a.body,''),t.title) title,a.body snippet,a.created occurred_at,
    coalesce(doc.created,up.created,t.created) resource_created_at,a.duck_id actor_duck_id,
    a.user_id actor_user_id,d.name actor_duck_name,u.name actor_user_name,
    CASE WHEN a.duck_id IS NULL AND a.user_id IS NULL THEN 'system' END actor_type,
    'ticket' destination_type,a.task_id destination_id,NULL conversation_id,NULL message_id,NULL thread_id,
    a.task_id,a.document_id,CASE WHEN up.id IS NOT NULL THEN up.id END upload_id,NULL capture_id,
    a.job_id job_id,CASE WHEN up.file_group='image' THEN 'image_file' END evidence_type,
    CASE WHEN a.document_id IS NOT NULL THEN doc.id IS NOT NULL WHEN a.upload_id IS NOT NULL THEN up.id IS NOT NULL ELSE 1 END available,
    NULL original_action,NULL original_occurred_at
   FROM ticket_activity a JOIN tasks t ON t.id=a.task_id AND t.company_id=a.company_id
   LEFT JOIN ducks d ON d.id=a.duck_id LEFT JOIN users u ON u.id=a.user_id
   LEFT JOIN documents doc ON doc.id=a.document_id AND doc.company_id=a.company_id
   LEFT JOIN uploads up ON up.id=a.upload_id AND up.company_id=a.company_id AND up.message_id IS NOT NULL
   WHERE a.company_id=:company
     AND a.kind<>'acknowledgement'
     AND (${match("ticket", "a.id")} OR ${match("task", "a.task_id")}
       OR (a.document_id IS NOT NULL AND ${match("document", "a.document_id")})
       OR (a.upload_id IS NOT NULL AND ${match("upload", "a.upload_id")}))`);

  const helperOrigin = `EXISTS(SELECT 1 FROM duck_consultations hc
    JOIN jobs child ON child.id=hc.child_job_id
    JOIN messages child_message ON child_message.conversation_id=child.conversation_id
    JOIN jobs produced ON produced.output_message_id=child_message.id
      AND produced.conversation_id=child.conversation_id AND produced.duck_id=hc.to_duck_id
    JOIN message_artifacts original ON original.message_id=child_message.id
      AND original.company_id=visible.company_id AND original.kind=visible.kind
      AND original.reference_id=visible.reference_id
      AND original.verb IN ('Created','Updated','Captured')
      AND (original.kind<>'file' OR EXISTS(SELECT 1 FROM computer_file_exports source_export
        WHERE source_export.upload_id=original.reference_id AND source_export.company_id=original.company_id
        AND source_export.job_id=produced.id))
    WHERE hc.parent_job_id=owner.id)`;
  branches.push(`SELECT 'artifact:'||visible.id event_id,visible.kind,
    visible.verb||CASE visible.kind WHEN 'file' THEN ' file' WHEN 'document' THEN ' document'
      WHEN 'screenshot' THEN ' screenshot' ELSE '' END action,
    visible.title title,visible.title snippet,visible.created occurred_at,
    coalesce(doc.created,up.created,cap.created) resource_created_at,m.duck_id actor_duck_id,
    m.user_id actor_user_id,d.name actor_duck_name,u.name actor_user_name,NULL actor_type,
    'chat' destination_type,m.conversation_id destination_id,m.conversation_id,visible.message_id message_id,
    m.thread_id,NULL task_id,CASE WHEN visible.kind='document' THEN visible.reference_id END document_id,
    CASE WHEN visible.kind='file' AND up.id IS NOT NULL THEN up.id END upload_id,
    CASE WHEN visible.kind='screenshot' AND cap.id IS NOT NULL THEN cap.id END capture_id,
    owner.id job_id,CASE WHEN visible.kind='screenshot' THEN 'computer_capture'
      WHEN visible.kind='file' AND up.file_group='image' THEN 'image_file' END evidence_type,
    CASE WHEN visible.kind='document' THEN doc.id IS NOT NULL
      WHEN visible.kind='file' THEN up.id IS NOT NULL
      WHEN visible.kind='screenshot' THEN cap.id IS NOT NULL ELSE 1 END available,
    NULL original_action,NULL original_occurred_at
   FROM message_artifacts visible JOIN messages m ON m.id=visible.message_id AND m.company_id=visible.company_id
   JOIN conversations c ON c.id=m.conversation_id LEFT JOIN jobs owner ON owner.output_message_id=m.id
   LEFT JOIN ducks d ON d.id=m.duck_id LEFT JOIN users u ON u.id=m.user_id
   LEFT JOIN documents doc ON visible.kind='document' AND doc.id=visible.reference_id AND doc.company_id=visible.company_id
   LEFT JOIN uploads up ON visible.kind='file' AND up.id=visible.reference_id AND up.company_id=visible.company_id AND up.message_id IS NOT NULL
   LEFT JOIN computer_captures cap ON visible.kind='screenshot' AND cap.id=visible.reference_id AND cap.company_id=visible.company_id
   WHERE visible.company_id=:company AND visible.kind IN ('document','file','screenshot')
     AND c.kind<>'consultation' AND c.task_id IS NULL AND ${chatAccess("m.conversation_id")}
     AND NOT ${helperOrigin}
     AND (${match("artifact", "visible.id")} OR (visible.kind='document' AND ${match("document", "visible.reference_id")})
       OR (visible.kind='file' AND ${match("upload", "visible.reference_id")})
       OR (visible.kind='screenshot' AND ${match("capture", "visible.reference_id")}))`);

  branches.push(`SELECT 'helper-artifact:'||visible.id||':'||original.id event_id,visible.kind,
    CASE WHEN visible.kind='file' THEN 'Shared file' WHEN visible.kind='document' THEN 'Shared document'
      ELSE 'Shared screenshot' END action,visible.title title,visible.title snippet,
    visible.created occurred_at,coalesce(doc.created,up.created,cap.created) resource_created_at,
    coalesce(file_export.duck_id,hc.to_duck_id) actor_duck_id,NULL actor_user_id,
    coalesce(export_duck.name,d.name) actor_duck_name,NULL actor_user_name,NULL actor_type,
    CASE WHEN hc.task_id IS NOT NULL THEN 'ticket' ELSE 'chat' END destination_type,
    coalesce(hc.task_id,m.conversation_id) destination_id,m.conversation_id,visible.message_id message_id,
    m.thread_id,hc.task_id,CASE WHEN visible.kind='document' THEN visible.reference_id END document_id,
    CASE WHEN visible.kind='file' AND up.id IS NOT NULL THEN up.id END upload_id,
    CASE WHEN visible.kind='screenshot' AND cap.id IS NOT NULL THEN cap.id END capture_id,
    owner.id job_id,CASE WHEN visible.kind='screenshot' THEN 'computer_capture'
      WHEN visible.kind='file' AND up.file_group='image' THEN 'image_file' END evidence_type,
    CASE WHEN visible.kind='document' THEN doc.id IS NOT NULL WHEN visible.kind='file' THEN up.id IS NOT NULL
      WHEN visible.kind='screenshot' THEN cap.id IS NOT NULL ELSE 1 END available,
    original.verb||CASE original.kind WHEN 'file' THEN ' file' WHEN 'document' THEN ' document'
      WHEN 'screenshot' THEN ' screenshot' ELSE '' END original_action,
    original.created original_occurred_at
   FROM jobs owner
   JOIN message_artifacts visible ON visible.message_id=owner.output_message_id
   JOIN duck_consultations hc ON hc.parent_job_id=owner.id
   JOIN jobs child ON child.id=hc.child_job_id
   JOIN messages child_message ON child_message.conversation_id=child.conversation_id
   JOIN jobs produced ON produced.output_message_id=child_message.id
     AND produced.conversation_id=child.conversation_id AND produced.duck_id=hc.to_duck_id
   JOIN message_artifacts original ON original.message_id=child_message.id
     AND original.company_id=visible.company_id AND original.kind=visible.kind
     AND original.reference_id=visible.reference_id
     AND original.verb IN ('Created','Updated','Captured')
     AND (original.kind<>'file' OR EXISTS(SELECT 1 FROM computer_file_exports source_export
       WHERE source_export.upload_id=original.reference_id AND source_export.company_id=original.company_id
       AND source_export.job_id=produced.id))
   JOIN messages m ON m.id=visible.message_id JOIN ducks d ON d.id=hc.to_duck_id
   LEFT JOIN documents doc ON visible.kind='document' AND doc.id=visible.reference_id AND doc.company_id=visible.company_id
   LEFT JOIN uploads up ON visible.kind='file' AND up.id=visible.reference_id AND up.company_id=visible.company_id AND up.message_id IS NOT NULL
   LEFT JOIN computer_file_exports file_export ON visible.kind='file' AND file_export.upload_id=up.id AND file_export.company_id=visible.company_id
   LEFT JOIN ducks export_duck ON export_duck.id=file_export.duck_id AND export_duck.company_id=visible.company_id
   LEFT JOIN computer_captures cap ON visible.kind='screenshot' AND cap.id=visible.reference_id AND cap.company_id=visible.company_id
   WHERE owner.company_id=:company AND visible.kind IN ('document','file','screenshot')
     AND (hc.task_id IS NOT NULL OR (${audienceAccess("m.conversation_id")}
       AND (${chatAccess("m.conversation_id")} OR coalesce(file_export.duck_id,hc.to_duck_id)=:duck)))
     AND (${match("artifact", "visible.id")} OR (visible.kind='document' AND ${match("document", "visible.reference_id")})
       OR (visible.kind='file' AND ${match("upload", "visible.reference_id")})
       OR (visible.kind='screenshot' AND ${match("capture", "visible.reference_id")}))`);

  branches.push(`SELECT 'document:'||doc.id event_id,'document' kind,'Available document' action,
    doc.title,'' snippet,doc.updated occurred_at,doc.created resource_created_at,
    NULL actor_duck_id,NULL actor_user_id,NULL actor_duck_name,NULL actor_user_name,'shared' actor_type,
    'files' destination_type,doc.id destination_id,NULL conversation_id,NULL message_id,NULL thread_id,
    NULL task_id,doc.id document_id,NULL upload_id,NULL capture_id,NULL job_id,NULL evidence_type,1 available,
    NULL original_action,NULL original_occurred_at
   FROM documents doc WHERE doc.company_id=:company
     AND NOT EXISTS(SELECT 1 FROM message_artifacts ma JOIN messages artifact_message ON artifact_message.id=ma.message_id
       WHERE ma.company_id=doc.company_id AND ma.kind='document' AND ma.reference_id=doc.id
       AND artifact_message.conversation_id IN (SELECT id FROM accessible_conversations))
     AND NOT EXISTS(SELECT 1 FROM ticket_activity ta WHERE ta.company_id=doc.company_id AND ta.document_id=doc.id)
     AND ${match("document", "doc.id")}`);

  const params = {
    company: context.root.company_id,
    user: context.root.user_id,
    duck: context.search_duck_id,
    destination: context.root.conversation_id,
    current_output: context.current_output,
    request_boundary: context.request_boundary,
    start: range.start,
    end: range.end,
    cursor_at: cursor?.at || null,
    cursor_id: cursor?.id || null,
    query: query || "",
    limit: context.limit + 1,
  };
  const kindParts = [];
  for (const kind of kinds || KINDS) {
    if (kind === "screenshot")
      kindParts.push("kind='screenshot'", "evidence_type='image_file'");
    else kindParts.push(`kind='${kind}'`);
  }
  const scopeSql =
    scope === "current_conversation"
      ? "destination_type='chat' AND destination_id=:destination"
      : scope === "current_ticket"
        ? "destination_type='ticket' AND destination_id=:current_ticket"
        : "1";
  params.current_ticket = context.task_id || "";
  const actorSql = actorDuck ? "actor_duck_id=:actor_duck" : "1";
  params.actor_duck = actorDuck || "";
  const matched = query
    ? `matched AS (SELECT keys.source_type,keys.source_id FROM activity_recall_fts
       JOIN activity_recall_search_keys keys ON keys.fts_rowid=activity_recall_fts.rowid
       WHERE activity_recall_fts MATCH :query AND keys.company_id=:company),`
    : "matched AS (SELECT NULL source_type,NULL source_id WHERE 0),";
  return {
    sql: `WITH dest_users AS (
      SELECT cm.user_id FROM conversation_members cm JOIN memberships ms ON ms.user_id=cm.user_id AND ms.company_id=:company
      WHERE cm.conversation_id=:destination
    ), dest_ducks AS (
      SELECT cd.duck_id FROM conversation_ducks cd JOIN ducks dd ON dd.id=cd.duck_id AND dd.company_id=:company AND dd.removed=0
      WHERE cd.conversation_id=:destination
    ), audience_conversations AS (
      SELECT c.id FROM conversations c WHERE c.company_id=:company
       AND EXISTS(SELECT 1 FROM conversation_members own WHERE own.conversation_id=c.id AND own.user_id=:user)
       AND NOT EXISTS(SELECT 1 FROM dest_users du WHERE NOT EXISTS(SELECT 1 FROM conversation_members sm WHERE sm.conversation_id=c.id AND sm.user_id=du.user_id))
       AND NOT EXISTS(SELECT 1 FROM dest_ducks dd WHERE NOT EXISTS(SELECT 1 FROM conversation_ducks sd WHERE sd.conversation_id=c.id AND sd.duck_id=dd.duck_id))
    ), accessible_conversations AS (
      SELECT id FROM audience_conversations ac WHERE EXISTS(SELECT 1 FROM conversation_ducks sd WHERE sd.conversation_id=ac.id AND sd.duck_id=:duck)
    ), ${matched} events AS (${branches.join(" UNION ALL ")})
    SELECT * FROM events WHERE occurred_at<:end AND (:start IS NULL OR occurred_at>=:start)
      AND (:cursor_at IS NULL OR occurred_at<:cursor_at OR (occurred_at=:cursor_at AND event_id<:cursor_id))
      AND (${kindParts.join(" OR ")}) AND (${actorSql}) AND (${scopeSql})
    ORDER BY occurred_at DESC,event_id DESC LIMIT :limit`,
    params,
  };
}

export function searchActivity(job, input = {}, { clock = Date.now } = {}) {
  const args = argsSchema.parse(input || {});
  const member = memberFor(job.company_id, job.user_id);
  if (!member) fail(403, "Membership has been removed.");
  can(member, "chat");
  const searchDuck = tenant("ducks", job.duck_id, job.company_id);
  const context = currentContext(job);
  if (args.scope === "current_ticket" && !context.task_id)
    return {
      timezone: companyTimezone(job.company_id),
      range: resolveRange(args, companyTimezone(job.company_id), clock),
      events: [],
      has_more: false,
      next_cursor: null,
      coverage: [
        "This run has no current ticket.",
        "Results always reflect current access; an empty result does not prove that no activity exists.",
      ],
    };
  let actorDuck = null;
  if (args.actor_duck_id === "self") actorDuck = searchDuck.id;
  else if (args.actor_duck_id !== "any")
    actorDuck = tenant("ducks", args.actor_duck_id, job.company_id).id;
  const timezone = companyTimezone(job.company_id);
  const range = resolveRange(args, timezone, clock);
  const cursor = decodeCursor(args.cursor);
  const inputRow = one(
    "SELECT rowid FROM messages WHERE id=? AND company_id=?",
    job.input_message_id,
    job.company_id,
  );
  const built = sqlFor({
    query: ftsQuery(args.query),
    kinds: args.kinds,
    scope: args.scope,
    actorDuck,
    range,
    cursor,
    context: {
      ...context,
      search_duck_id: searchDuck.id,
      current_output: job.output_message_id,
      request_boundary: inputRow?.rowid || Number.MAX_SAFE_INTEGER,
      limit: args.limit,
    },
  });
  const rows = all(built.sql, built.params);
  const selected = rows.slice(0, args.limit);
  const p = permissions(member);
  const uploadIds = [
    ...new Set(selected.map((row) => row.upload_id).filter(Boolean)),
  ];
  const uploadRows = uploadIds.length
    ? all(
        `SELECT u.id,u.conversation_id,tu.task_id FROM uploads u
         LEFT JOIN task_uploads tu ON tu.upload_id=u.id AND tu.company_id=u.company_id
         WHERE u.company_id=? AND u.id IN (${uploadIds.map(() => "?").join(",")})`,
        job.company_id,
        ...uploadIds,
      )
    : [];
  const uploads = new Map(uploadRows.map((upload) => [upload.id, upload]));
  const currentConsultation = one(
    `SELECT consultation.task_id,parent.input_message_id,parent.output_message_id
       FROM duck_consultations consultation
       JOIN jobs parent ON parent.id=consultation.parent_job_id
      WHERE consultation.child_job_id=? AND consultation.company_id=?`,
    job.id,
    job.company_id,
  );
  const events = selected.map((row) => {
    const available = !!row.available;
    const destination =
      row.destination_type === "chat"
        ? {
            type: "chat",
            id: row.destination_id,
            ...(row.thread_id || row.message_id
              ? { thread_id: row.thread_id || row.message_id }
              : {}),
          }
        : row.destination_type === "ticket"
          ? { type: "ticket", id: row.destination_id }
          : { type: "files", id: row.destination_id };
    const source = {};
    for (const [key, value] of Object.entries({
      message_id: row.message_id,
      job_id: row.job_id,
      task_id: row.task_id,
      document_id: available ? row.document_id : null,
      capture_id: available ? row.capture_id : null,
    }))
      if (value != null) source[key] = value;
    let readable = true;
    if (row.upload_id) {
      const upload = uploads.get(row.upload_id);
      readable =
        !!upload &&
        (upload.task_id
          ? !!context.task_id && upload.task_id === context.task_id && !!p.tasks
          : upload.conversation_id === job.conversation_id ||
            (!!currentConsultation &&
              [
                currentConsultation.input_message_id,
                currentConsultation.output_message_id,
              ].includes(row.message_id)));
      if (readable) source.upload_id = row.upload_id;
    }
    const availability = { available };
    if (row.upload_id || row.kind === "file")
      availability.readable = available && readable;
    if (!available)
      availability.reason =
        row.kind === "screenshot"
          ? "The saved capture has expired."
          : "The saved item is no longer available.";
    else if (!readable)
      availability.reason =
        "The item is visible in history but is not readable from this request.";
    const source_url =
      row.destination_type === "chat"
        ? chatUrl(
            job.company_id,
            row.destination_id,
            row.thread_id,
            row.message_id,
          )
        : row.destination_type === "ticket"
          ? `/w/${job.company_id}/tasks/${row.destination_id}`
          : `/w/${job.company_id}/files/${row.destination_id}`;
    return {
      id: row.event_id,
      kind: row.kind,
      action: compact(row.action, 120),
      title: compact(row.title, 180) || "Saved activity",
      snippet: compact(row.snippet, 500),
      occurred_at: row.occurred_at,
      ...(row.resource_created_at
        ? { resource_created_at: row.resource_created_at }
        : {}),
      actor: actor(row),
      destination,
      source,
      source_url,
      ...(row.evidence_type ? { evidence_type: row.evidence_type } : {}),
      ...(row.original_action
        ? {
            original_action: compact(row.original_action, 120),
            original_occurred_at: row.original_occurred_at,
          }
        : {}),
      availability,
    };
  });
  return {
    timezone,
    range,
    events,
    has_more: rows.length > args.limit,
    next_cursor:
      rows.length > args.limit && events.length
        ? encodeCursor(events.at(-1))
        : null,
    coverage: [
      "Results include saved activity that this requester, duck, and destination audience can currently access.",
      "Private hidden helper transcripts, tool arguments, credentials, and raw file paths are excluded.",
      "An empty result means no matching visible saved activity was found; it does not prove that no activity exists.",
    ],
  };
}

export const activitySearchKinds = KINDS;
