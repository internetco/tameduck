import { all, permissions } from "./store.mjs";
import { publicUpload } from "./uploads.mjs";

const liveJobStates = new Set([
  "queued",
  "running",
  "waiting_human",
  "waiting_consultation",
]);
const liveConsultationStates = new Set(["waiting", "running"]);

const computerActionLabels = new Map([
  ["terminal", "Used the terminal"],
  ["screenshot", "Checked the screen"],
  ["get_state", "Checked the screen"],
  ["click", "Used the desktop"],
  ["type", "Entered information"],
  ["press_key", "Used the keyboard"],
  ["scroll", "Reviewed the page"],
  ["open", "Opened an app"],
  ["launch_app", "Opened an app"],
  ["browser_navigate", "Opened a web page"],
]);

const newer = (left, right) =>
  right && (!left || String(right.at || "") >= String(left.at || ""))
    ? right
    : left;

export function shortTitle(value, fallback = "Current request") {
  const first = String(value || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  const clean = String(first || fallback)
    .replace(
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
      "",
    )
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
  const title = clean || fallback;
  return title.length > 180 ? title.slice(0, 179).trimEnd() + "…" : title;
}

function publicConsultation(row) {
  return {
    id: row.id,
    from_duck_id: row.from_duck_id,
    to_duck_id: row.to_duck_id,
    to_duck_name: row.to_duck_name || "Former duck",
    child_job_id: row.child_job_id,
    child_status: row.child_status || null,
    computer_id: row.computer_id || null,
    question: row.question,
    status: row.status,
    answer: row.answer || null,
    error: row.error || null,
    created: row.created,
    updated: row.updated,
  };
}

function valuesFor(ids) {
  return ids.map(() => "?").join(",");
}

// Build the Team page's current-work view from durable records only. In
// particular, this never exposes tool arguments, terminal commands, approval
// arguments or hidden helper conversations.
export function duckActivity(company, user, member) {
  const p = permissions(member);
  const jobs = all(
    `SELECT j.*,
            root.id visible_job_id,root.conversation_id visible_conversation_id,
            root.output_message_id visible_output_message_id,
            root.thread_id visible_thread_id,root.task_id root_task_id,
            parent.duck_id parent_duck_id,parent_duck.name parent_duck_name,
            input.body input_body,
            task.id visible_task_id,task.title task_title,
            bt.board_id,bt.state workflow_state,bt.error workflow_error,
            EXISTS(SELECT 1 FROM conversation_members member
                    WHERE member.conversation_id=root.conversation_id
                      AND member.user_id=?) chat_visible
       FROM jobs j
       JOIN jobs root ON root.id=COALESCE(j.root_job_id,j.id)
                    AND root.company_id=j.company_id
       LEFT JOIN jobs parent ON parent.id=j.parent_job_id
       LEFT JOIN ducks parent_duck ON parent_duck.id=parent.duck_id
       LEFT JOIN messages input ON input.id=j.input_message_id
       LEFT JOIN duck_consultations own_consultation
              ON own_consultation.child_job_id=j.id
       LEFT JOIN tasks task
              ON task.id=COALESCE(j.task_id,root.task_id,own_consultation.task_id)
             AND task.company_id=j.company_id
       LEFT JOIN board_tasks bt ON bt.task_id=task.id
      WHERE j.company_id=? AND j.checkin=0 AND (
        j.status IN ('queued','running','waiting_human','waiting_consultation')
        OR EXISTS(SELECT 1 FROM approvals approval
                   WHERE approval.job_id=j.id
                     AND approval.status IN ('pending','executing'))
        OR EXISTS(SELECT 1 FROM inbox pending
                   WHERE pending.message_id=j.output_message_id
                     AND pending.user_id=? AND pending.state='pending')
        OR EXISTS(SELECT 1 FROM human_requests request
                   WHERE request.job_id=j.id
                     AND request.status IN ('preparing','pending','desktop','submitting')
                     AND request.expires>?)
      )
      ORDER BY j.created,j.id`,
    user,
    company,
    user,
    Date.now(),
  ).filter((job) => !!job.visible_task_id || !!job.chat_visible);

  const jobIds = jobs.map((job) => job.id);
  const outputIds = jobs.map((job) => job.output_message_id).filter(Boolean);
  const approvals = jobIds.length
    ? all(
        `SELECT approval.id,approval.job_id,approval.status,approval.created,
                approval.updated,job.user_id
           FROM approvals approval JOIN jobs job ON job.id=approval.job_id
          WHERE approval.company_id=?
            AND approval.status IN ('pending','executing')
            AND approval.job_id IN (${valuesFor(jobIds)})`,
        company,
        ...jobIds,
      ).filter((approval) => p.approvals || approval.user_id === user)
    : [];
  const approvalByJob = new Map(approvals.map((row) => [row.job_id, row]));

  const needs = outputIds.length
    ? all(
        `SELECT message.id,message.created,message.needs_you,job.id job_id,
                job.updated
           FROM inbox pending
           JOIN messages message ON message.id=pending.message_id
           JOIN jobs job ON job.output_message_id=message.id
          WHERE message.company_id=? AND pending.user_id=?
            AND pending.state='pending' AND message.needs_you IS NOT NULL
            AND message.id IN (${valuesFor(outputIds)})`,
        company,
        user,
        ...outputIds,
      )
    : [];
  const needsByJob = new Map(needs.map((row) => [row.job_id, row]));

  const requests =
    p.computers && jobIds.length
      ? all(
          `SELECT id,job_id,title,status,created,updated
           FROM human_requests
          WHERE company_id=? AND user_id=?
            AND status IN ('preparing','pending','desktop','submitting')
            AND expires>?
            AND job_id IN (${valuesFor(jobIds)})`,
          company,
          user,
          Date.now(),
          ...jobIds,
        )
      : [];
  const requestByJob = new Map(requests.map((row) => [row.job_id, row]));

  const consultations = jobIds.length
    ? all(
        `SELECT consultation.*,
                helper.name to_duck_name,child.status child_status,
                (SELECT action.computer_id FROM computer_actions action
                  WHERE action.job_id=consultation.child_job_id
                  ORDER BY action.rowid DESC LIMIT 1) computer_id
           FROM duck_consultations consultation
           LEFT JOIN ducks helper ON helper.id=consultation.to_duck_id
           LEFT JOIN jobs child ON child.id=consultation.child_job_id
          WHERE consultation.company_id=?
            AND (consultation.parent_job_id IN (${valuesFor(jobIds)})
              OR consultation.child_job_id IN (${valuesFor(jobIds)}))
          ORDER BY consultation.created`,
        company,
        ...jobIds,
        ...jobIds,
      )
    : [];
  const parentConsultations = new Map();
  const childConsultation = new Map();
  for (const row of consultations) {
    if (!parentConsultations.has(row.parent_job_id))
      parentConsultations.set(row.parent_job_id, []);
    parentConsultations.get(row.parent_job_id).push(row);
    childConsultation.set(row.child_job_id, row);
  }

  const artifacts = outputIds.length
    ? all(
        `SELECT artifact.id,artifact.message_id,artifact.kind,
                artifact.reference_id,artifact.title,artifact.verb,
                artifact.created,
                CASE WHEN artifact.kind='screenshot'
                     THEN EXISTS(SELECT 1 FROM computer_captures capture
                                  WHERE capture.id=artifact.reference_id)
                     ELSE 1 END kept,
                EXISTS(SELECT 1 FROM message_artifact_changes changes
                        WHERE changes.artifact_id=artifact.id) has_changes
           FROM message_artifacts artifact
          WHERE artifact.company_id=?
            AND artifact.message_id IN (${valuesFor(outputIds)})
          ORDER BY artifact.created`,
        company,
        ...outputIds,
      )
    : [];
  const artifactsByMessage = new Map();
  for (const artifact of artifacts) {
    if (!artifactsByMessage.has(artifact.message_id))
      artifactsByMessage.set(artifact.message_id, []);
    artifactsByMessage.get(artifact.message_id).push({
      ...artifact,
      kept: !!artifact.kept,
      has_changes: !!artifact.has_changes,
    });
  }
  const fileIds = artifacts
    .filter((artifact) => artifact.kind === "file")
    .map((artifact) => artifact.reference_id);
  const fileById = new Map(
    (fileIds.length
      ? all(
          `SELECT upload.*,task_upload.task_id
             FROM uploads upload
             LEFT JOIN task_uploads task_upload ON task_upload.upload_id=upload.id
            WHERE upload.company_id=? AND upload.id IN (${valuesFor(fileIds)})`,
          company,
          ...fileIds,
        )
      : []
    ).map((file) => [file.id, file]),
  );

  const actions = jobIds.length
    ? all(
        `SELECT job_id,tool,created FROM computer_actions
          WHERE state='done' AND job_id IN (${valuesFor(jobIds)})
          ORDER BY created`,
        ...jobIds,
      )
    : [];
  const actionByJob = new Map();
  for (const action of actions)
    actionByJob.set(action.job_id, {
      text: computerActionLabels.get(action.tool) || "Used the computer",
      at: action.created,
    });

  const items = [];
  for (const job of jobs) {
    const approval = approvalByJob.get(job.id);
    const need = needsByJob.get(job.id);
    const request = requestByJob.get(job.id);
    if (!liveJobStates.has(job.status) && !approval && !need && !request)
      continue;
    const ownConsultation = childConsultation.get(job.id);
    const asked = parentConsultations.get(job.id) || [];
    const waitingFor = asked
      .filter((row) => liveConsultationStates.has(row.status))
      .map((row) => ({
        duck_id: row.to_duck_id,
        name: row.to_duck_name || "Former duck",
      }));
    let state = job.status === "queued" ? "queued" : "working";
    let blockingReason = null;
    if (waitingFor.length) {
      state = "waiting_duck";
      blockingReason =
        "Waiting for " + waitingFor.map((duck) => duck.name).join(", ") + ".";
    }
    if (job.status === "waiting_consultation" && !waitingFor.length) {
      state = "waiting_duck";
      blockingReason = "Waiting for another duck.";
    }
    if (job.status === "waiting_human" && !request && !need) {
      state = "waiting_input";
      blockingReason = "Waiting for human input.";
    }
    if (request) {
      state = "needs_you";
      blockingReason = shortTitle(request.title, "Waiting for your input");
    }
    if (need) {
      state = "needs_you";
      blockingReason = shortTitle(need.needs_you, "Waiting for your answer");
    }
    if (approval?.status === "pending") {
      state = "waiting_approval";
      blockingReason = "Waiting for approval.";
    }
    if (job.workflow_state === "blocked") {
      state = "needs_you";
      blockingReason = shortTitle(
        job.workflow_error,
        "This ticket is blocked.",
      );
    }

    const fallback = {
      text:
        job.status === "queued"
          ? "Queued"
          : job.status === "waiting_consultation"
            ? "Asked another duck for help"
            : job.status === "waiting_human"
              ? "Asked for your input"
              : "Started working",
      at: job.created,
    };
    let latest = fallback;
    latest = newer(latest, actionByJob.get(job.id));
    for (const artifact of artifactsByMessage.get(job.output_message_id) || [])
      latest = newer(latest, {
        text: `${artifact.verb} ${artifact.title}`,
        at: artifact.created,
      });
    for (const consultation of asked)
      latest = newer(latest, {
        text:
          consultation.status === "answered"
            ? `${consultation.to_duck_name || "Another duck"} answered`
            : `Asked ${consultation.to_duck_name || "another duck"} for help`,
        at: consultation.updated || consultation.created,
      });
    if (ownConsultation)
      latest = newer(latest, {
        text:
          ownConsultation.status === "answered"
            ? "Returned help to " + (job.parent_duck_name || "another duck")
            : "Started helping " + (job.parent_duck_name || "another duck"),
        at: ownConsultation.updated || ownConsultation.created,
      });
    if (request)
      latest = newer(latest, {
        text: "Asked for your input",
        at: request.updated || request.created,
      });
    if (need)
      latest = newer(latest, {
        text: "Asked for your answer",
        at: need.updated || need.created,
      });
    if (approval)
      latest = newer(latest, {
        text:
          approval.status === "executing"
            ? "Running approved action"
            : "Requested approval",
        at: approval.updated || approval.created,
      });
    if (latest === fallback) latest.at = job.updated || job.created;

    const answerThread =
      need && !job.visible_task_id
        ? job.visible_thread_id || job.visible_output_message_id
        : job.visible_thread_id;
    const destination = job.visible_task_id
      ? {
          type: "tasks",
          id: job.visible_task_id,
          ...(job.board_id ? { boardId: job.board_id } : {}),
        }
      : {
          type: "chat",
          id: job.visible_conversation_id,
          ...(answerThread ? { threadId: answerThread } : {}),
        };
    const ownArtifacts = (
      job.visible_task_id || job.conversation_id === job.visible_conversation_id
        ? artifactsByMessage.get(job.output_message_id) || []
        : []
    ).map((artifact) => {
      if (artifact.kind !== "file") return artifact;
      const file = fileById.get(artifact.reference_id);
      const accessible =
        file &&
        (job.visible_task_id
          ? file.task_id === job.visible_task_id
          : file.conversation_id === job.visible_conversation_id);
      return {
        ...artifact,
        file: accessible ? publicUpload(file) : null,
      };
    });
    items.push({
      id: job.id,
      job_id: job.id,
      state,
      title: job.task_title
        ? job.task_title
        : ownConsultation
          ? shortTitle(ownConsultation.question, "Helping another duck")
          : job.schedule_title || shortTitle(job.input_body),
      latest_action: latest.text,
      updated: latest.at,
      started: job.created,
      blocking_reason: blockingReason,
      waiting_for: waitingFor,
      parent_duck: job.parent_duck_id
        ? {
            duck_id: job.parent_duck_id,
            name: job.parent_duck_name || "Former duck",
          }
        : null,
      destination,
      consultations: [
        ...asked.map(publicConsultation),
        ...(ownConsultation &&
        !asked.some((row) => row.id === ownConsultation.id)
          ? [publicConsultation(ownConsultation)]
          : []),
      ],
      artifacts: ownArtifacts,
      ...(job.visible_output_message_id
        ? { response_message_id: job.visible_output_message_id }
        : {}),
    });
  }

  const byDuck = new Map(
    all(
      "SELECT id FROM ducks WHERE company_id=? ORDER BY chief DESC,created",
      company,
    ).map((duck) => [duck.id, []]),
  );
  const duckByJob = new Map(jobs.map((job) => [job.id, job.duck_id]));
  for (const item of items) {
    const duckId = duckByJob.get(item.job_id);
    if (duckId && byDuck.has(duckId)) byDuck.get(duckId).push(item);
  }
  for (const duckItems of byDuck.values())
    duckItems.sort((a, b) =>
      String(b.updated).localeCompare(String(a.updated)),
    );
  return [...byDuck].map(([duck_id, duckItems]) => ({
    duck_id,
    items: duckItems,
  }));
}
