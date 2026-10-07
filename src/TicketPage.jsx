import { DuckConsultations } from "./DuckConsultations.jsx";
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Clock,
  ChevronRight,
  Copy,
  Download,
  FileText,
  History,
  MessageSquare,
  Pencil,
  Play,
  RotateCcw,
  Square,
  TriangleAlert,
  ShieldCheck,
} from "lucide-react";
import {
  api,
  Avatar,
  Button,
  Field,
  IconButton,
  Markdown,
  flock,
} from "./ui.jsx";
import { DocumentEditor } from "./views.jsx";
import { isCsvFile } from "./csv.mjs";
import { isPreviewable } from "./FilePreview.jsx";
import { FileViewer } from "./FileViewer.jsx";
import { sharerOf } from "./file-viewer.mjs";
import { FileIcon, formatBytes, typeLabel, uploadUrl } from "./file-ui.jsx";
import { FolderBrowser, FolderMoveDialog } from "./FolderBrowser.jsx";
import { inFolder, validFolder } from "./files-list.mjs";
import "./ticket-documents.css";
import "./ticket-conflict.css";
import { groupAutomaticWorkflowActivity } from "./ticket-activity-group.mjs";
import { collapseTicketStarts } from "./ticket-activity-starts.mjs";
import { ArtifactChangesAction } from "./Attachments.jsx";
import { whoHasIt } from "./board-turn.mjs";
import { ask, cardsFor, panelFor, primaryFor, checkersLine } from "./ticket-stages.mjs";
import { StageStrip, StagePanel } from "./TicketStages.jsx";
import { placeCaret } from "./BoardSetup.jsx";
import { queueReason } from "./queue-reason.mjs";
import { RecoveryStatus as SharedRecoveryStatus } from "./RecoveryStatus.jsx";
import { recoveryLabel } from "./recovery-status.mjs";
// The fields each editor writes back. The older General editor also writes the
// status and the assigned duck.
const FIELDS = ["title", "description", "priority"];
const fieldsFor = (legacy) =>
  legacy ? [...FIELDS, "status", "assignee_id"] : FIELDS;
// Two values of one field, the way a person would compare them: a text box
// turns Windows line endings into plain ones, and "no duck" is empty either way.
const same = (a, b) =>
  String(a ?? "").replace(/\r\n/g, "\n") ===
  String(b ?? "").replace(/\r\n/g, "\n");
// What a ticket holds in each of the editor's fields, as the editor holds it.
const openedFrom = (t, legacy) => ({
  title: t.title,
  description: t.description || "",
  priority: t.priority,
  ...(legacy ? { status: t.status, assignee_id: t.assignee_id || "" } : {}),
});
// Which fields this person has changed since the editor opened. Only those are
// sent, and only those are checked. Sending every field meant a save put back
// the old value of anything somebody else had changed meanwhile - a priority
// they had just raised went back down because somebody fixed a typo.
const editedFields = (values, opened, legacy) =>
  fieldsFor(legacy).filter((k) => !same(values[k], opened?.[k]));
// A field and its value in the words the editor uses for them.
const LABELS = {
  title: "title",
  description: "description",
  priority: "priority",
  status: "status",
  assignee_id: "assigned duck",
};
const STATUS_WORDS = { open: "Open", working: "Working", done: "Done" };
const PRIORITY_WORDS = { low: "Low", normal: "Normal", high: "High" };
function describe(keys, t, data) {
  const duck = (id) =>
    (data.ducks || []).find((d) => d.id === id)?.name || "Unassigned";
  const words = {
    title: (v) => v,
    description: (v) => v || "(empty)",
    priority: (v) => PRIORITY_WORDS[v] || v,
    status: (v) => STATUS_WORDS[v] || v,
    assignee_id: (v) => (v ? duck(v) : "Unassigned"),
  };
  return keys.map((k) => ({ key: k, label: LABELS[k], value: words[k](t[k]) }));
}
const joinWords = (labels) =>
  labels.length < 2
    ? labels.join("")
    : labels.slice(0, -1).join(", ") + " and " + labels.at(-1);
// What the server is told the editor was opened with, for the fields being
// saved, so it can refuse only when somebody else changed one of those. The
// description goes as a fingerprint rather than the text: it can be sixty
// thousand characters, and twice that does not fit in a request. A browser
// that cannot make one sends nothing extra, and the save is checked the old,
// stricter way.
async function openedFingerprint(opened, keys) {
  if (!opened || !globalThis.crypto?.subtle) return null;
  try {
    const out = {};
    for (const k of keys) if (k !== "description") out[k] = opened[k] ?? "";
    if (keys.includes("description")) {
      const bytes = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(opened.description ?? ""),
      );
      out.description_sha256 = [...new Uint8Array(bytes)]
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
    }
    return out;
  } catch {
    return null;
  }
}
const states = {
  ready: "Ready",
  working: "Working",
  stuck: "Stuck",
  reviewing: "In review",
  waiting: "Waiting",
  waiting_consultation: "Waiting for teammate replies",
  blocked: "Needs attention",
  changes_requested: "Changes requested",
  ready_to_move: "Ready to move",
  complete: "Done",
};
// The feed prints what the trigger wrote, which is the database's own wording:
// an action built out of a decision or a job status. "Submitted changes
// requested" and "Duck work cancelled" are what a duck doing its job looked
// like to somebody reading their own ticket.
const plainly = {
  "Submitted done": "finished the stage",
  "Submitted approved": "approved the work",
  "Submitted changes requested": "asked for changes",
  "Submitted blocked": "is blocked",
  "Duck work queued": "is waiting to start",
  "Duck work running": "started work",
  "Duck work done": "finished",
  "Duck work failed": "could not finish",
  "Duck work error": "hit a problem",
  "Duck work cancelled": "was stopped",
  "Duck work waiting human": "needs somebody",
  "Duck work waiting consultation": "Waiting for teammate replies",
  "Sent back": "sent it back",
  "Duck acknowledged work": "started work",
  Note: "left a note",
};
const display = (value) =>
  value == null || value === ""
    ? "None"
    : states[value] || String(value).replaceAll("_", " ");
const date = (value) =>
  new Date(value).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
function Changes({ items }) {
  return (
    <div className="ticket-field-changes">
      {items.map((c, i) => (
        <div key={i}>
          {["Description", "Result"].includes(c.field) ||
          String(c.before || "").length + String(c.after || "").length > 240 ? (
            <details>
              <summary>{c.field} changed</summary>
              <div className="ticket-diff">
                <section>
                  <small>Before</small>
                  <Markdown>{display(c.before)}</Markdown>
                </section>
                <section>
                  <small>After</small>
                  <Markdown>{display(c.after)}</Markdown>
                </section>
              </div>
            </details>
          ) : (
            <>
              <strong>{c.field}</strong>
              <span className="ticket-old-value">{display(c.before)}</span>
              <ArrowRight size={12} />
              <span>{display(c.after)}</span>
            </>
          )}
        </div>
      ))}
    </div>
  );
}
function DocumentLink({ title, available = true, onOpen }) {
  return available ? (
    <button type="button" className="ticket-document-link" onClick={onOpen}>
      <FileText size={14} />
      <span>{title}</span>
    </button>
  ) : (
    <span className="ticket-document-link deleted">
      <FileText size={14} />
      <span>{title} (deleted)</span>
    </span>
  );
}
function TicketRecovery({ recovery, job, data, action }) {
  if (!recovery) return null;
  return <SharedRecoveryStatus recovery={{ ...recovery, job_id: recovery.job_id || job?.id }} data={data} action={action} />;
}
function TicketFileLink({ file, onPreview }) {
  const previewable =
    isCsvFile(file) || isPreviewable(file) || (file.group === "image" && file.inline);
  const content = (
    <>
      <FileIcon item={file} size={16} />
      <span>{file.name}</span>
    </>
  );
  return (
    <div className="ticket-file-link">
      {previewable ? (
        <button
          type="button"
          onClick={() => onPreview(file)}
          title={"Preview " + file.name}
        >
          {content}
        </button>
      ) : (
        <a href={uploadUrl(file.id, true)} title={"Download " + file.name}>
          {content}
        </a>
      )}
      <a
        className="icon-button"
        href={uploadUrl(file.id, true)}
        aria-label={"Download " + file.name}
        title={"Download " + file.name}
      >
        <Download size={16} />
      </a>
    </div>
  );
}
export default function TicketPage({
  task: listed,
  ticket: listedTicket,
  board,
  columns,
  data,
  action,
  go,
  onClose,
  initialFolder = "all",
}) {
  // The workspace payload carries the first lines of a brief, not the whole
  // thing. This is the page that shows the whole thing, so it asks for it.
  // The brief is not the only long thing on a ticket: the handoff note is
  // carried clipped as well, and a General ticket shows the duck's answer from
  // it. Asking only when the brief was clipped meant a short brief and a long
  // answer left the answer off the page entirely.
  const clipped = Boolean(listed.description_clipped || listed.result_clipped);
  const [full, setFull] = useState(clipped ? null : listed);
  // One failed fetch used to be the end of it: nothing retried, the effect only
  // reruns when the ticket itself changes, and the page then showed 240
  // characters of a brief with an ellipsis and no explanation, beside an Edit
  // button greyed out for no stated reason. Reopening the ticket was the only
  // way out and nothing said so.
  const [attempt, setAttempt] = useState(0);
  const [briefFailed, setBriefFailed] = useState(false);
  useEffect(() => {
    if (!clipped) {
      setFull(listed);
      setBriefFailed(false);
      return;
    }
    let live = true,
      retry = 0;
    api("/tasks/" + listed.id)
      .then((r) => {
        if (!live) return;
        setFull(r);
        setBriefFailed(false);
      })
      .catch((e) => {
        if (!live) return;
        if (attempt < 3) {
          retry = setTimeout(() => setAttempt((n) => n + 1), 2000);
          return;
        }
        setBriefFailed(true);
        setError(e.message);
      });
    return () => {
      live = false;
      clearTimeout(retry);
    };
  }, [listed.id, listed.updated, clipped, attempt]);
  // The saved copy is only renewed when the ticket itself is edited, and a run
  // failing or starting does not edit it. So whether a run is going, and
  // whether the last one stopped, always come from the fresh payload: the
  // page kept saying the duck was working after its card had turned Stuck.
  const task = full
    ? {
        ...listed,
        ...full,
        running: listed.running,
        running_by: listed.running_by,
        running_duck: listed.running_duck,
        running_status: listed.running_status,
        queue_reason: listed.queue_reason,
        recovery: listed.recovery,
        stuck: listed.stuck,
        asked: listed.asked,
        asked_of: listed.asked_of,
      }
    : listed;
  const whole = Boolean(full);
  // Same for the stage's own write-up, which the board never shows and this
  // page shows whole.
  const ticketClipped = Boolean(listedTicket.worker_result_clipped);
  const [fullTicket, setFullTicket] = useState(
    ticketClipped ? null : listedTicket,
  );
  useEffect(() => {
    if (!ticketClipped) {
      setFullTicket(listedTicket);
      return;
    }
    let live = true;
    api("/workflow/tasks/" + listedTicket.task_id)
      .then((r) => live && setFullTicket(r))
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [listedTicket.task_id, listedTicket.updated, ticketClipped]);
  const t = fullTicket ? { ...listedTicket, ...fullTicket } : listedTicket;
  const legacy = Boolean(board.legacy);
  // What the handoff panel shows, and whether it is all of it. Both halves are
  // carried clipped in the workspace payload, so until the whole one has
  // arrived this says so rather than stopping mid-sentence in silence.
  const handoffText = t.worker_result || (legacy && task.result) || "";
  const handoffWhole = t.worker_result
    ? Boolean(fullTicket) || !listedTicket.worker_result_clipped
    : whole || !listed.result_clipped;
  const handoff = handoffWhole ? handoffText : handoffText + "…";
  // What the ticket said at the moment this form was opened. The stale-save
  // check sends this, and used to send task.updated - which is refreshed from
  // the workspace payload about once a second, so by the time anybody pressed
  // Save it already carried whatever the other person had just written. The
  // check could not fail, and the save it was there to refuse went through
  // every time.
  const [openedAt, setOpenedAt] = useState(null);
  // What the editor showed when it was opened. A save is refused only if one
  // of these has changed since - somebody else really did rewrite it - and not
  // because a comment or a duck's progress note touched the ticket.
  const [openedWith, setOpenedWith] = useState(null);
  // Set when a save was refused because somebody else changed what this editor
  // writes: their version, and what in it differs. The choice replaces Save.
  const [conflict, setConflict] = useState(null);
  const [editing, setEditingState] = useState(false),
    [busy, setBusy] = useState(false),
    [feedback, setFeedback] = useState(""),
    [steering, setSteering] = useState(null);
  const [feed, setFeed] = useState([]),
    [before, setBefore] = useState(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [filter, setFilter] = useState("all"),
    [documents, setDocuments] = useState([]),
    [files, setFiles] = useState([]),
    [folders, setFolders] = useState([]),
    [foldersReady, setFoldersReady] = useState(false),
    [moveItem, setMoveItem] = useState(null),
    [openFile, setOpenFile] = useState(null),
    [openDoc, setOpenDoc] = useState(null);
  const [consultations, setConsultations] = useState([]);
  // What each stage made, for the strip and the panel (2.4). Fetched for
  // boards only; a General ticket has no stages.
  const [stages, setStages] = useState(null);
  const [arrived, setArrived] = useState(null);
  // Which earlier stage's own work is being looked at, or null for the
  // current stage (3.2, 3.4). Reset whenever the ticket moves.
  const [picked, setPicked] = useState(null);
  const [foldOpen, setFoldOpen] = useState(false);
  const [briefOpen, setBriefOpen] = useState(false);
  const [briefOverflow, setBriefOverflow] = useState(false);
  const [sendBackTarget, setSendBackTarget] = useState(null);
  const [sendBackError, setSendBackError] = useState("");
  // Names which button in the foot is busy, so only that one spins while
  // every button in the foot is greyed out (3.3.6).
  const [pressed, setPressed] = useState(null);
  const briefRef = useRef(null);
  const noteRef = useRef(null);
  const headingRef = useRef(null);
  const stripRef = useRef(null);
  const panelRef = useRef(null);
  const draftKey =
    "td-ticket-update:" + data.company.id + ":" + data.user.id + ":" + task.id;
  const draftRef = useRef("");
  const [draft, setDraft] = useState(() => {
    try {
      return sessionStorage.getItem(draftKey) || "";
    } catch {
      return "";
    }
  });
  draftRef.current = draft;
  const latest = useRef(0),
    loaded = useRef(false),
    requestId = useRef(crypto.randomUUID()),
    [posting, setPosting] = useState(false),
    [copied, setCopied] = useState(false);
  const c = columns.find((c) => c.id === t.column_id),
    next = columns[c.position + 1];
  const runs = data.workflows.runs.filter(
    (r) =>
      r.task_id === task.id &&
      r.column_id === t.column_id &&
      r.revision === t.revision,
  );
  const jobs = data.jobs?.filter((j) => j.task_id === task.id) || [];
  // The jobs this page can see are only the ones in conversations this person
  // belongs to, and asking a duck to work opens a direct one with whoever
  // asked. So a General ticket a teammate started looked idle to everybody
  // else: the status pill said Working while the button next to it invited
  // them to start it again. The payload now says outright whether a ticket has
  // a run going.
  const recovery = task.recovery || jobs.find((job) => job.recovery)?.recovery;
  const recoveryJob = jobs.find((job) => job.id === recovery?.job_id) || null;
  const queuedJob = jobs.find((job) => job.status === "queued") ||
    (task.running_status === "queued" ? {
      id: task.running, status: "queued", duck_id: task.running_duck,
      queue_reason: task.queue_reason,
    } : null);
  const otherWorkActive =
    ["running","waiting_human","waiting_consultation"].includes(task.running_status) ||
    jobs.some(
      (job) =>
        job !== queuedJob &&
        ["running", "waiting_human", "waiting_consultation"].includes(job.status),
    ) ||
    runs.some(
      (run) =>
        run.status !== "queued" &&
        ["running", "waiting_human", "waiting_consultation"].includes(run.status),
    );
  const queuedReason = otherWorkActive ? null : queueReason(queuedJob);
  const active =
    Boolean(task.running) ||
    [...runs, ...jobs].some((r) =>
      ["queued", "running", "waiting_human", "waiting_consultation"].includes(r.status),
    );
  const waitingForDuck = consultations.find((c) =>
    ["waiting", "running"].includes(c.status),
  );
  const duck = data.ducks.find(
    (d) => d.id === (legacy ? task.assignee_id : c.duck_id),
  );
  const creator = data.members.find((m) => m.id === task.creator_id),
    owner = data.members.find((m) => m.id === t.runner_id);
  // A General ticket whose last run failed or was cut off, with nothing run
  // since. Its card said Stuck while this page said Working under the duck's
  // name, so the page asks the card's own rule rather than keeping a copy.
  const stuck =
    legacy &&
    whoHasIt({ task, legacy, ducks: data.ducks, me: data.user.id }).kind ===
      "stuck";
  const status = legacy
    ? task.status === "done"
      ? "complete"
      : ["queued","waiting_human","waiting_consultation"].includes(task.running_status)
        ? "waiting"
      : stuck
        ? "stuck"
        : task.status === "working"
          ? "working"
          : "ready"
    : t.state;
  // The duck's last run ended with a question for a person and nothing has
  // run since. The ticket went on saying Working, so the one thing that was
  // true - the duck is waiting on somebody's answer - was said nowhere.
  const askedMe = !active && Boolean(task.asked) && task.asked_of === data.user.id;
  const asked =
    legacy && !active && task.asked && status === "working"
      ? askedMe
        ? "Waiting for you"
        : "Waiting for " +
          (data.members.find((m) => m.id === task.asked_of)?.name ||
            "a teammate")
      : null;
  // Every row in the Details panel described the column the ticket is sitting
  // in. A finished ticket sits in the empty last column, which has no duck and
  // no approvers, so the panel read "Working duck: Human handles this stage"
  // beside a feed showing the duck that had just done it. On a finished ticket,
  // say who did the work rather than describing a destination as a stage.
  const finished = !legacy && status === "complete";
  const workerRuns = data.workflows.runs
    .filter((r) => r.task_id === task.id && r.role === "worker")
    .sort((a, b) => (a.created < b.created ? -1 : 1));
  const whose = finished
    ? data.ducks.find((d) => d.id === workerRuns[workerRuns.length - 1]?.duck_id)
    : duck;
  // Not t.revision: that goes up on every move as well as on every retry, so a
  // ticket that sailed through one stage was labelled "Attempt 2". This counts
  // the times the working duck was actually asked to do the stage it is on.
  const tries = new Set(
    workerRuns
      .filter((r) => r.column_id === t.column_id)
      .map((r) => r.revision),
  ).size;
  function merge(items) {
    setFeed((old) =>
      [...new Map([...old, ...items].map((x) => [x.id, x])).values()].sort(
        (a, b) => a.id - b.id,
      ),
    );
  }
  useEffect(() => {
    let cancelled = false;
    async function refreshActivity() {
      try {
        let cursor = loaded.current ? latest.current : null;
        do {
          const r = await api(
            "/tasks/" +
              task.id +
              "/activity" +
              (cursor === null ? "" : "?after=" + cursor),
          );
          if (cancelled) return;
          if (!draftRef.current && r.steering) setSteering(r.steering);
          merge(r.items);
          if (r.consultations) setConsultations(old => [...new Map([...old, ...r.consultations].map(c => [c.id, c])).values()]);
          latest.current = Math.max(
            latest.current,
            ...r.items.map((a) => a.id),
          );
          if (!loaded.current) {
            setBefore(r.next_before);
            loaded.current = true;
          }
          cursor = r.next_after;
        } while (cursor != null);
        const [docs, attachmentResult, stagesResult] = await Promise.all([
          api("/tasks/" + task.id + "/documents"),
          api("/tasks/" + task.id + "/files"),
          legacy
            ? Promise.resolve(null)
            : api("/workflow/tasks/" + task.id + "/stages").catch(() => undefined),
        ]);
        if (cancelled) return;
        setDocuments(docs.documents || docs);
        setFiles(attachmentResult.files);
        setFolders(attachmentResult.folders || docs.folders || []);
        setFoldersReady(true);
        if (!legacy) {
          if (stagesResult === undefined) {
            setError("What each stage made did not load. It will try again.");
          } else if (stagesResult) {
            setStages(stagesResult.stages);
            setArrived(stagesResult.arrived);
          }
        }
        if (stagesResult !== undefined) setError("");
        setLoading(false);
      } catch (e) {
        if (!cancelled) {
          setError(e.message);
          setLoading(false);
        }
      }
    }
    refreshActivity();
    return () => {
      cancelled = true;
    };
  }, [task.id, data]);
  const requestedFolder = initialFolder || "all";
  const folderId = validFolder(folders, requestedFolder) ? requestedFolder : "all";
  const chooseFolder = (next) => go({
    type: "tasks",
    boardId: board.id,
    id: task.id,
    ...(next && next !== "all" ? { folderId: next } : {}),
  }, { replace: true });
  useEffect(() => {
    if (foldersReady && !validFolder(folders, requestedFolder)) chooseFolder("all");
  }, [foldersReady, folders, requestedFolder]);
  async function refreshAttachments() {
    try {
      const [docs, attachmentResult] = await Promise.all([
        api("/tasks/" + task.id + "/documents"),
        api("/tasks/" + task.id + "/files"),
      ]);
      setDocuments(docs.documents || docs);
      setFiles(attachmentResult.files || []);
      setFolders(attachmentResult.folders || docs.folders || []);
      setFoldersReady(true);
    } catch (e) { setError(e.message); }
  }
  // Which stage's own work the panel is showing goes back to the current one
  // whenever the ticket itself moves on, and the earlier-stage picker starts
  // over at the column right before the current one.
  useEffect(() => {
    setPicked(null);
    setSendBackTarget(null);
    setSendBackError("");
  }, [t.column_id]);
  // The caret under the panel's top edge points at the picked or current
  // card, and follows the strip when it slides or the window resizes (43B's
  // placeCaret, reused as it is).
  useLayoutEffect(() => {
    placeCaret(stripRef.current, panelRef.current);
  });
  useEffect(() => {
    const place = () => placeCaret(stripRef.current, panelRef.current);
    const row = stripRef.current;
    if (!row) return;
    row.addEventListener("scroll", place, { passive: true });
    window.addEventListener("resize", place);
    return () => {
      row.removeEventListener("scroll", place);
      window.removeEventListener("resize", place);
    };
  });
  // The strip alone scrolls the current card into view on a phone - the page
  // itself never scrolls sideways (5). It lands where the card snaps: the
  // strip's scroll-padding (the page's 16px gutter) in from the left edge, or
  // as far as the strip goes. Bounding rects, not offsetLeft: the cards have
  // no positioned ancestor of their own to measure offsetLeft against.
  useEffect(() => {
    const row = stripRef.current;
    if (!row || window.innerWidth > 700) return;
    const card = row.querySelector('[aria-current="step"]');
    if (!card) return;
    const r = row.getBoundingClientRect(),
      c = card.getBoundingClientRect(),
      gutter = parseFloat(getComputedStyle(row).scrollPaddingLeft) || 0;
    row.scrollLeft += c.left - r.left - gutter;
  }, [t.column_id]);
  // The brief is held to 7 lines until asked for whole; measured again
  // whenever the text or the width changes.
  useEffect(() => {
    if (briefOpen) return;
    const el = briefRef.current;
    if (!el) return;
    const measure = () => setBriefOverflow(el.scrollHeight > el.clientHeight + 2);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [task.description, whole, briefOpen]);
  async function older() {
    setLoading(true);
    try {
      const r = await api("/tasks/" + task.id + "/activity?before=" + before);
      merge(r.items);
      if (r.consultations) setConsultations(old => [...new Map([...old, ...r.consultations].map(c => [c.id, c])).values()]);
      setBefore(r.next_before);
      setError("");
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }
  function changeDraft(value) {
    if (value && value !== draft) setSteering(null);
    if (sendBackError) setSendBackError("");
    draftRef.current = value;
    setDraft(value);
    try {
      sessionStorage.setItem(draftKey, value);
    } catch {}
  }
  // Post note only / Post note: today's comment path. The only change is the
  // toast, which now reads "Note posted" (it used to say "Update posted").
  async function post() {
    if (!draft.trim() || posting) return;
    setPosting(true);
    const r = await action(
      () =>
        api("/tasks/" + task.id + "/comments", "POST", {
          body: draft,
          request_id: requestId.current,
        }),
      askedMe ? "Answer sent" : "Note posted",
    );
    if (r) {
      setSteering(r.steering || null);
      changeDraft("");
      requestId.current = crypto.randomUUID();
    }
    setPosting(false);
  }
  // Stop is on the ticket because the ticket is the only place its run can be
  // seen: the work happens in the ticket's own conversation, which no chat list
  // shows, so a duck doing the wrong thing on a ticket could not be stopped
  // short of pausing the whole company. Same rule as Stop in chat: the person
  // the run is for, or somebody who runs the company.
  const runningDuck = data.ducks.find((d) => d.id === task.running_duck);
  const canStop =
    Boolean(task.running) &&
    (task.running_by === data.user.id || data.permissions.company);
  async function stopRun() {
    setPressed("stop");
    await action(() => api("/jobs/" + task.running + "/cancel", "POST", {}));
    setPressed(null);
  }
  // Ask duck to work, and General's Try again: the same action either way.
  async function askDuckToWork() {
    setPressed("primary");
    await action(() => api(recovery ? "/jobs/" + recovery.job_id + "/continue" : "/tasks/" + task.id + "/run", "POST", {}));
    setPressed(null);
  }
  const focusHeading = () => headingRef.current?.focus();
  // ---- the stages (2.4), the strip and the panel's mode (3.2, 3.3) ---------
  const canDoTasks = data.permissions.tasks;
  const stagePanel = legacy
    ? panelFor({
        legacy: true,
        ticket: t,
        task,
        columns,
        me: data.user.id,
        members: data.members,
        ducks: data.ducks,
        active,
        consultation: waitingForDuck,
        queuedJob: queuedReason ? queuedJob : null,
      })
    : panelFor({
        legacy: false,
        ticket: t,
        task,
        columns,
        runs,
        active,
        me: data.user.id,
        members: data.members,
        ducks: data.ducks,
        canDoTasks,
        consultation: waitingForDuck,
        queuedJob: queuedReason ? queuedJob : null,
        arrived,
        now: new Date(),
      });
  const cards = legacy
    ? []
    : cardsFor({
        legacy: false,
        ticket: t,
        columns,
        stages,
        panel: stagePanel,
        me: data.user.id,
        members: data.members,
        ducks: data.ducks,
      });
  const primary = legacy
    ? null
    : primaryFor({ mode: stagePanel.mode, columns, column: c, ducks: data.ducks, note: draft });
  const checkersText =
    !legacy && stagePanel.mode === "turn" && (c.approvers || []).length
      ? checkersLine(
          c.approvers.map((id) => data.ducks.find((d) => d.id === id)?.name || "A duck"),
          c.position === columns.length - 1,
        )
      : null;
  const noteAmbiguous = data.permissions.tasks && ["stuck", "finished", "turn"].includes(stagePanel.mode);
  const noteLabel = noteAmbiguous ? "Post note only" : "Post note";
  const noteHint = noteAmbiguous ? "Goes with the button you press" : null;
  const sendBackAllowed =
    !legacy &&
    canDoTasks &&
    (stagePanel.mode === "finished" || (stagePanel.mode === "turn" && c.position > 0));
  const earlierColumns = sendBackAllowed ? columns.slice(0, c.position) : [];
  const sendBackTargetId =
    sendBackAllowed && earlierColumns.length
      ? sendBackTarget || columns[c.position - 1]?.id
      : null;
  const sendBackTargetName = earlierColumns.find((x) => x.id === sendBackTargetId)?.name;
  async function doSendBack() {
    if (!draft.trim()) {
      setSendBackError(
        "Say what needs changing. It goes back to " + sendBackTargetName + " with the ticket.",
      );
      noteRef.current?.focus();
      return;
    }
    setSendBackError("");
    setPressed("sendback");
    const r = await action(
      () =>
        api("/workflow/tasks/" + task.id + "/send-back", "POST", {
          column_id: sendBackTargetId,
          note: draft,
        }),
      "Sent back to " + sendBackTargetName,
    );
    setPressed(null);
    if (r) {
      changeDraft("");
      setPicked(null);
      focusHeading();
    }
  }
  const sendBack = sendBackAllowed && earlierColumns.length
    ? {
        earlier: earlierColumns,
        target: sendBackTargetId,
        targetName: sendBackTargetName,
        onTargetChange: setSendBackTarget,
        error: sendBackError,
        busy: pressed === "sendback",
        onSend: doSendBack,
      }
    : null;
  async function doPrimary() {
    if (!primary) return;
    setPressed("primary");
    const r = await action(
      () => api("/workflow/tasks/" + task.id + "/" + primary.path, "POST", primary.body),
      primary.toast || undefined,
    );
    setPressed(null);
    if (r) {
      changeDraft("");
      setPicked(null);
      focusHeading();
    }
  }
  const pickedColumn = !legacy && picked ? columns.find((x) => x.id === picked) : null;
  const pickedRecord = pickedColumn && stages ? stages.find((s) => s.column_id === picked) : null;
  // Keep raw rows for live cursors and pagination; combine only the display.
  const shown = collapseTicketStarts(feed).filter(
    (a) =>
      filter === "all" ||
      (filter === "updates"
        ? ["comment", "consultation", "acknowledgement"].includes(a.kind)
        : filter === "documents"
          ? a.kind === "document" ||
            a.kind === "file" ||
            a.documents_read?.length > 0
          : !["comment", "consultation", "acknowledgement"].includes(a.kind)),
  );
  async function openDocument(id) {
    try {
      setOpenDoc(await api("/documents/" + id));
    } catch (e) {
      setError(e.message);
    }
  }
  // Opening the editor remembers where the ticket stood; closing it forgets,
  // and asks first when there is something written that would go.
  const form = useRef(null);
  const typedSomething = () => {
    const live = form.current;
    if (!live) return false;
    const title = live.elements.title?.value ?? task.title;
    const description =
      live.elements.description?.value ?? task.description ?? "";
    return title !== task.title || description !== (task.description || "");
  };
  const setEditing = (on, saved = false) => {
    if (on) {
      setOpenedAt(task.updated);
      // The older editor also writes status and assignee back, so for it a
      // duck starting work is a change a save would undo, and still refuses.
      setOpenedWith(openedFrom(task, legacy));
      setConflict(null);
      setEditingState(true);
      return;
    }
    // A save that worked has nothing to lose. The question below compares the
    // form against the ticket as this render knows it, and that is still the
    // version from before the save - the payload has not come back yet - so
    // closing after a successful save asked whether to throw away the very
    // thing it had just written down.
    if (saved) {
      setConflict(null);
      setEditingState(false);
      return;
    }
    if (
      typedSomething() &&
      !window.confirm(
        "Close without saving? What you have written here will be lost.",
      )
    )
      return;
    setEditingState(false);
  };
  async function saveDetails(e) {
    e.preventDefault();
    await save(openedAt || task.updated, openedWith);
  }
  const field = (k) => form.current?.elements.namedItem(k);
  async function save(loadedAt, opened, again = false) {
    const values = Object.fromEntries(new FormData(form.current));
    const mine = editedFields(values, opened, legacy);
    // Nothing was changed, so there is nothing to save and nothing to lose.
    if (!mine.length) {
      setConflict(null);
      setEditing(false, true);
      return;
    }
    const body = Object.fromEntries(
      mine.map((k) => [k, k === "assignee_id" ? values[k] || null : values[k]]),
    );
    body.updated = loadedAt;
    const fingerprint = await openedFingerprint(opened, mine);
    if (fingerprint) body.opened = fingerprint;
    const path = (legacy ? "/tasks/" : "/workflow/tasks/") + task.id;
    setBusy(true);
    try {
      await api(path, "PATCH", body);
    } catch (error) {
      if (error.status !== 409) {
        setBusy(false);
        await action(() => Promise.reject(error));
        return;
      }
      // The plain task, for both kinds: the board route answers with the
      // stage's work, not the fields this form edits.
      const now = await api("/tasks/" + task.id).catch(() => null);
      setBusy(false);
      if (!now) {
        // Say what is true and what to do. Never "reopen": that is how the
        // text used to get lost.
        await action(() =>
          Promise.reject(
            new Error(
              "Nothing was saved, and the latest version did not load. Your text is still here, so press Save to try again.",
            ),
          ),
        );
        return;
      }
      // The form as it is now, not as it was when Save was pressed: a menu
      // changed while the save was on its way is this person's change too, and
      // must be neither written over nor left out of the choice.
      const valuesNow = Object.fromEntries(new FormData(form.current));
      const mineNow = editedFields(valuesNow, opened, legacy);
      // Whatever they changed that this person did not touch is simply theirs.
      // It goes into the form now, so no later save can put the old value back.
      const theirs = openedFrom(now, legacy);
      for (const k of fieldsFor(legacy))
        if (!mineNow.includes(k) && field(k)) field(k).value = theirs[k] ?? "";
      // Only a field both changed, to different things, needs a choice.
      const clash = mineNow.filter(
        (k) => !same(now[k], opened?.[k]) && !same(now[k], valuesNow[k]),
      );
      if (clash.length) {
        setConflict({ theirs: now, clash: describe(clash, now, data) });
        return;
      }
      // They changed the same field to the same thing, so there is nothing to
      // choose. Save on top of theirs - once; a second refusal is something
      // else, and is shown as it is.
      if (!again && mineNow.some((k) => !same(now[k], opened?.[k]))) {
        setOpenedAt(now.updated);
        setOpenedWith(theirs);
        return save(now.updated, theirs, true);
      }
      await action(() => Promise.reject(error));
      return;
    }
    // Busy until the editor has closed. Save came back on while the page
    // reloaded, and a second press in that moment was refused as somebody
    // else's change - against this person's own first save.
    await action(() => Promise.resolve(true), "Ticket updated");
    setConflict(null);
    setEditing(false, true);
    setBusy(false);
  }
  // Save this person's version of what they changed, now checked against
  // theirs, so a third change landing meanwhile is caught too.
  async function keepMine() {
    // The button is not Save, so the form's own checks - a title cannot be
    // empty - would otherwise be skipped and the server's wording shown.
    if (!form.current.reportValidity()) return;
    const theirs = openedFrom(conflict.theirs, legacy);
    setOpenedAt(conflict.theirs.updated);
    setOpenedWith(theirs);
    setConflict(null);
    await save(conflict.theirs.updated, theirs);
  }
  // Their version of what both changed goes into the form. Nothing else this
  // person typed is touched, and nothing is saved or thrown away until they
  // press Save or Cancel - unless that leaves nothing of theirs changed, in
  // which case there is nothing left to save and the editor closes.
  async function useTheirs() {
    const theirs = openedFrom(conflict.theirs, legacy);
    for (const { key } of conflict.clash)
      if (field(key)) field(key).value = theirs[key] ?? "";
    setOpenedAt(conflict.theirs.updated);
    setOpenedWith(theirs);
    setConflict(null);
    const values = Object.fromEntries(new FormData(form.current));
    if (!editedFields(values, theirs, legacy).length) {
      setEditing(false, true);
      await action(() => Promise.resolve(true));
    } else
      await action(
        () => Promise.resolve(true),
        "Their version is in the box. Your other changes are still here, so press Save to keep them.",
      );
  }
  return (
    <div className="page ticket-page">
      <nav className="ticket-breadcrumb" aria-label="Ticket navigation">
        <button onClick={onClose}>
          <ArrowLeft size={16} />
          {board.name}
        </button>
        <span>/</span>
        <span title={task.id}>TD-{task.id.slice(0, 8).toUpperCase()}</span>
        <div className="ticket-breadcrumb-actions">
          <IconButton
            icon={Copy}
            label={copied ? "Link copied" : "Copy ticket link"}
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(location.href);
                setCopied(true);
              } catch {
                setError(
                  "Could not copy the link. You can copy it from the address bar.",
                );
              }
            }}
          />
        </div>
      </nav>
      <header className="ticket-page-heading ticket-top">
        <div>
          <div className="ticket-created">
            Created by {creator?.name || "a teammate"} · {date(task.created)} ·{" "}
            <span className={"ticket-priority " + task.priority}>
              {PRIORITY_WORDS[task.priority] || task.priority} priority
            </span>
          </div>
          <h1>{task.title}</h1>
          {editing ? (
            <form
              className="ticket-inline-editor"
              ref={form}
              onSubmit={saveDetails}
            >
              <Field label="Title">
                <input
                  name="title"
                  defaultValue={task.title}
                  maxLength={200}
                  required
                  // Held still while a save is on its way. Anything typed in
                  // that moment was dropped when the editor closed, or written
                  // over when the save came back refused.
                  readOnly={busy}
                />
              </Field>
              <Field label="Description">
                <textarea
                  name="description"
                  defaultValue={task.description}
                  rows={9}
                  maxLength={60000}
                  readOnly={busy}
                />
              </Field>
              <div className="ticket-edit-properties">
                <Field label="Priority">
                  <select name="priority" defaultValue={task.priority}>
                    <option value="low">Low</option>
                    <option value="normal">Normal</option>
                    <option value="high">High</option>
                  </select>
                </Field>
                {!!legacy && (
                  <>
                    <Field label="Status">
                      <select name="status" defaultValue={task.status}>
                        <option value="open">Open</option>
                        <option value="working">Working</option>
                        <option value="done">Done</option>
                      </select>
                    </Field>
                    <Field label="Assigned duck">
                      <select
                        name="assignee_id"
                        defaultValue={task.assignee_id || ""}
                      >
                        <option value="">Unassigned</option>
                        {flock(data).map((d) => (
                          <option key={d.id} value={d.id}>
                            {d.name}
                          </option>
                        ))}
                      </select>
                    </Field>
                  </>
                )}
              </div>
              {!legacy && (
                <p className="workflow-hint">
                  Changing the title or description starts a new version for
                  review. Completed tickets reopen in the first column.
                </p>
              )}
              {conflict ? (
                <div className="ticket-conflict" role="alert">
                  <strong>
                    Someone else changed the{" "}
                    {joinWords(conflict.clash.map((c) => c.label))} too, while you
                    were editing.
                  </strong>
                  <p>Their version:</p>
                  <dl>
                    {conflict.clash.map((c) => (
                      <React.Fragment key={c.key}>
                        <dt>{c.label[0].toUpperCase() + c.label.slice(1)}</dt>
                        <dd>{c.value}</dd>
                      </React.Fragment>
                    ))}
                  </dl>
                  <div className="ticket-inline-actions">
                    <Button
                      busy={busy}
                      disabled={active}
                      type="button"
                      onClick={keepMine}
                    >
                      Keep mine
                    </Button>
                    <Button
                      className="secondary"
                      type="button"
                      disabled={busy}
                      onClick={useTheirs}
                    >
                      Use theirs
                    </Button>
                  </div>
                  {active ? (
                    // Keep mine is greyed out while a duck works, the same as
                    // Save. Grey on its own left Use theirs looking like the
                    // only way out.
                    <small>
                      A duck is working on this ticket right now. Keep mine
                      works again as soon as it has finished.
                    </small>
                  ) : (
                    <small>
                      Keep mine saves your version. Use theirs keeps theirs and
                      drops yours.
                    </small>
                  )}
                </div>
              ) : (
              <div className="ticket-inline-actions">
                <Button busy={busy} disabled={active}>
                  Save changes
                </Button>
                <Button
                  className="secondary"
                  type="button"
                  onClick={() => setEditing(false)}
                >
                  Cancel
                </Button>
              </div>
              )}
            </form>
          ) : (
            <>
              <section
                className={"ticket-description" + (briefOpen ? "" : " clamped") + (briefOverflow && !briefOpen ? " overflows" : "")}
                aria-label="Ticket description"
                ref={briefRef}
              >
                <Markdown>
                  {whole
                    ? task.description || "No description yet."
                    : task.description + "…"}
                </Markdown>
              </section>
              {briefOverflow && (
                <button
                  type="button"
                  className="text-button ticket-brief-toggle"
                  onClick={() => setBriefOpen((o) => !o)}
                >
                  {briefOpen ? "Show less" : "Show the whole brief"}
                </button>
              )}
            </>
          )}
        </div>
        {data.permissions.tasks && !editing && (
          // Not until the whole brief is here. This form writes it back, and
          // opening it over a clipped one would throw the rest away on save.
          <>
            <Button
              className="secondary small"
              disabled={active || !whole}
              onClick={() => setEditing(true)}
            >
              <Pencil size={14} />
              Edit ticket
            </Button>
            {!whole && (
              <span className="workflow-hint">
                {briefFailed
                  ? "The whole brief did not load, so editing would cut it short."
                  : "Fetching the rest of the brief…"}
                {briefFailed && (
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => {
                      setBriefFailed(false);
                      setAttempt(0);
                    }}
                  >
                    Try again
                  </button>
                )}
              </span>
            )}
          </>
        )}
      </header>
      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}
      {!legacy && (
        <StageStrip cards={cards} pickedId={picked} onPick={setPicked} listRef={stripRef} />
      )}
      <div ref={panelRef} className="ticket-stage-panel-wrap">
        {!legacy && <span className="ticket-stage-caret" aria-hidden="true" />}
        <StagePanel
          board={board}
          legacy={legacy}
          panel={stagePanel}
          t={t}
          task={task}
          column={c}
          columns={columns}
          data={data}
          me={data.user.id}
          runs={runs}
          stages={stages}
          arrived={arrived}
          now={new Date()}
          pickedColumn={pickedColumn}
          pickedRecord={pickedRecord}
          draft={draft}
          onDraftChange={changeDraft}
          steering={steering}
          onPostNote={post}
          postBusy={posting}
          noteLabel={noteLabel}
          noteHint={noteHint}
          sendBack={sendBack}
          canStop={canStop && !recovery}
          runningDuck={runningDuck}
          onStop={stopRun}
          stopBusy={pressed === "stop"}
          primary={legacy && recovery ? null : primary}
          onPrimary={legacy && recovery ? undefined : legacy ? askDuckToWork : doPrimary}
          primaryBusy={pressed === "primary"}
          headingRef={headingRef}
          noteRef={noteRef}
          onOpenDocument={openDocument}
          go={go}
          checkersText={checkersText}
          askedMe={askedMe}
          duck={duck}
          active={active}
          consultation={waitingForDuck}
          permTasks={data.permissions.tasks}
          permChat={data.permissions.chat}
        />
      </div>
      <TicketRecovery recovery={recovery} job={recoveryJob} data={data} action={action} />
      <button
        type="button"
        className="ticket-everything"
        aria-expanded={foldOpen}
        aria-controls="ticket-everything"
        onClick={() => setFoldOpen((o) => !o)}
      >
        <ChevronRight size={14} aria-hidden="true" />
        Everything on this ticket
        {!legacy && (
          <span className="ticket-everything-hint">
            Pick a stage above to see just its work
          </span>
        )}
      </button>
      {foldOpen && (
      <div id="ticket-everything" className="ticket-page-layout">
        <div className="ticket-main">
          <section
            className="ticket-activity-section"
            aria-label="Ticket activity"
          >
            <div className="ticket-activity-heading">
              <h2>Activity</h2>
              <div role="group" aria-label="Filter activity">
                {[
                  ["all", "All"],
                  ["updates", "Updates"],
                  ["documents", "Files & documents"],
                  ["changes", "Changes"],
                ].map(([value, label]) => (
                  <button
                    key={value}
                    aria-pressed={filter === value}
                    className={filter === value ? "active" : ""}
                    onClick={() => setFilter(value)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <p className="ticket-shared-note">
              Updates are shared with everyone in {data.company.name} and
              included in duck work.
            </p>
            {before && (
              <button
                className="ticket-load-older"
                disabled={loading}
                onClick={older}
              >
                Load earlier activity
              </button>
            )}
            {loading && !feed.length && (
              <p className="workflow-hint">Loading activity…</p>
            )}
            <div className="ticket-activity-feed">
              {groupAutomaticWorkflowActivity(shown).map((entry) => {
                if (entry.type === "workflow-group") {
                  return (
                    <article
                      key={"workflow-" + entry.items[0].id}
                      className="ticket-activity-entry change"
                    >
                      <span className="ticket-system-avatar">
                        <History size={15} />
                      </span>
                      <details className="ticket-activity-content workflow-group">
                        <summary>
                          <ChevronRight
                            size={14}
                            className="workflow-group-chevron"
                            aria-hidden="true"
                          />
                          <strong>Workflow updated</strong>
                          <span>{entry.items.length} updates</span>
                          <time
                            dateTime={entry.items[0].created}
                            title={new Date(
                              entry.items[0].created,
                            ).toLocaleString()}
                          >
                            {date(entry.items[0].created)}
                          </time>
                        </summary>
                        <div className="workflow-group-events">
                          {entry.items.map((a) => (
                            <div className="workflow-group-event" key={a.id}>
                              <header>
                                <strong>{a.action}</strong>
                                <time
                                  dateTime={a.created}
                                  title={new Date(a.created).toLocaleString()}
                                >
                                  {date(a.created)}
                                </time>
                              </header>
                              {a.body && (
                                <div className="ticket-update-body">
                                  <Markdown>
                                    {a.readable_body || a.body}
                                  </Markdown>
                                </div>
                              )}
                              {a.changes?.length > 0 && (
                                <Changes items={a.changes} />
                              )}
                            </div>
                          ))}
                        </div>
                      </details>
                    </article>
                  );
                }
                const a = entry;
                const d = data.ducks.find((d) => d.id === a.duck_id);
                const author = a.duck_name || a.user_name || "Workflow";
                return (
                  <article
                    key={a.id}
                    className={"ticket-activity-entry " + a.kind}
                  >
                    {a.duck_id ? (
                      <Avatar duck={d} size={30} />
                    ) : a.user_id ? (
                      <Avatar name={author} size={30} />
                    ) : (
                      <span className="ticket-system-avatar">
                        <History size={15} />
                      </span>
                    )}
                    <div className="ticket-activity-content">
                      <header>
                        <strong>{author}</strong>
                        {a.duck_id && (
                          <span className="ticket-duck-tag">Duck</span>
                        )}
                        <span>
                          {a.kind === "comment"
                            ? "posted an update"
                            : a.kind === "consultation"
                              ? "Asked for help"
                              : a.asked
                                ? "asked"
                                : plainly[a.action] || a.action}
                        </span>
                        <time dateTime={a.created} title={date(a.created)}>
                          {date(a.created)}
                        </time>
                      </header>
                      {a.kind === "consultation" ? (
                        <DuckConsultations items={consultations.filter(c => c.id === a.consultation_id)} data={data} action={action} go={go} showHumanRequests />
                      ) : a.kind === "document" ? (
                        <div className="ticket-document-actions">
                          <DocumentLink
                            title={a.body}
                            available={a.document_available}
                            onOpen={() => openDocument(a.document_id)}
                          />
                          {a.action === "Updated document" && a.artifact_id && (
                            <ArtifactChangesAction
                              artifact={{
                                id: a.artifact_id,
                                title: a.body,
                                has_changes: a.artifact_has_changes,
                              }}
                              endpoint={
                                "/tasks/" +
                                task.id +
                                "/artifacts/" +
                                a.artifact_id +
                                "/changes"
                              }
                              className="artifact-changes-trigger ticket-artifact-changes-trigger"
                            />
                          )}
                        </div>
                      ) : a.kind === "file" ? (
                        a.file ? (
                          <TicketFileLink
                            file={a.file}
                            onPreview={setOpenFile}
                          />
                        ) : (
                          <span className="attachment-gone">
                            {a.body} (deleted)
                          </span>
                        )
                      ) : (
                        a.body && (
                          <div className="ticket-update-body">
                            <Markdown>{a.readable_body || a.body}</Markdown>
                          </div>
                        )
                      )}
                      {a.details && a.kind !== "consultation" && (
                        <details className="ticket-handoff-details">
                          <summary>Details for the next duck</summary>
                          <Markdown>{a.details}</Markdown>
                        </details>
                      )}
                      {a.changes.length > 0 && <Changes items={a.changes} />}
                      {a.documents_read?.length > 0 && (
                        <details className="ticket-documents-read">
                          <summary>
                            Read {a.documents_read.length}{" "}
                            {a.documents_read.length === 1
                              ? "document"
                              : "documents"}
                          </summary>
                          <ul>
                            {a.documents_read.map((d) => (
                              <li key={d.id}>
                                <DocumentLink
                                  title={d.title}
                                  available={d.available}
                                  onOpen={() => openDocument(d.id)}
                                />
                              </li>
                            ))}
                          </ul>
                        </details>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
            {!loading && !shown.length && (
              <p className="ticket-empty-activity">
                {filter === "updates"
                  ? "No updates yet. Start the conversation below."
                  : "No activity to show."}
              </p>
            )}
          </section>
        </div>
        <aside className="ticket-properties" aria-label="Ticket details">
          <div className="ticket-properties-card">
            <h2>Details</h2>
            <dl>
              <div>
                <dt>Board</dt>
                <dd>
                  <button onClick={onClose}>{board.name}</button>
                </dd>
              </div>
              <div>
                <dt>Stage</dt>
                <dd>{c.name}</dd>
              </div>
              <div>
                <dt>Status</dt>
                <dd>
                  <span className={"ticket-state " + (recovery ? "waiting" : asked ? "waiting" : status)}>
                    {recovery ? recoveryLabel(recovery.state) : waitingForDuck ? "Waiting for teammate replies" : asked || states[status]}
                  </span>
                </dd>
              </div>
              <div>
                <dt>Priority</dt>
                <dd>
                  <span className={"ticket-priority " + task.priority}>
                    {task.priority[0].toUpperCase() + task.priority.slice(1)}
                  </span>
                </dd>
              </div>
              <div>
                <dt>{finished ? "Done by" : stuck ? "Assigned duck" : "Working duck"}</dt>
                <dd>
                  {whose ? (
                    <span className="ticket-person">
                      <Avatar duck={whose} size={23} />
                      {whose.name}
                    </span>
                  ) : finished ? (
                    "A teammate"
                  ) : (
                    "Human handles this stage"
                  )}
                </dd>
              </div>
              {!legacy && (
                <>
                  {!finished && (
                    <div>
                      <dt>Required approvals</dt>
                      <dd>
                        {c.approvers.length
                          ? c.approvers.map((id) => (
                              <span className="ticket-person" key={id}>
                                <Avatar
                                  duck={data.ducks.find((d) => d.id === id)}
                                  size={22}
                                />
                                {data.ducks.find((d) => d.id === id)?.name}
                              </span>
                            ))
                          : "None"}
                      </dd>
                    </div>
                  )}
                  {c.wait_for_ducks.length > 0 && (
                    <div>
                      <dt>Wait for</dt>
                      <dd>
                        {c.wait_for_ducks
                          .map(
                            (id) => data.ducks.find((d) => d.id === id)?.name,
                          )
                          .join(", ")}
                      </dd>
                    </div>
                  )}
                  <div>
                    <dt>Run by</dt>
                    <dd>{owner?.name || "Teammate"}</dd>
                  </div>
                  {tries > 1 && (
                    <div>
                      <dt>Attempt</dt>
                      <dd>{tries}</dd>
                    </div>
                  )}
                </>
              )}
              <div>
                <dt>Updated</dt>
                <dd>
                  <time dateTime={task.updated}>{date(task.updated)}</time>
                </dd>
              </div>
            </dl>
          </div>
          <div className="ticket-properties-card ticket-folder-browser">
            <FolderBrowser
              folders={folders}
              folderId={folderId}
              onSelect={chooseFolder}
              onChanged={refreshAttachments}
              scope={{
                task_id: task.id,
                ...(task.assignee_id ? {
                  duck_id: task.assignee_id,
                  computer: !!data.computers?.items?.some((c) => c.duck_id === task.assignee_id),
                } : {}),
              }}
              canCreate={!!data.permissions.docs}
              ownerName={(f) => f.duck_id ? data.ducks.find((d) => d.id === f.duck_id)?.name : ""}
              notify={setError}
            />
          </div>
          <div
            className="ticket-properties-card ticket-documents"
            aria-label="Ticket documents"
          >
            <h2>Documents</h2>
            {documents.filter((d) => inFolder(d, folderId)).length ? (
              <ul>
                {documents.filter((d) => inFolder(d, folderId)).map((d) => (
                  <li key={d.id}>
                    <DocumentLink
                      title={d.title}
                      available
                      onOpen={() => openDocument(d.id)}
                    />
                    <small>
                      {d.touched_by ? d.touched_by + " · " : ""}
                      <time dateTime={d.touched}>{date(d.touched)}</time>
                    </small>
                    {data.permissions.docs && d.can_move !== false && folders.some((f) => f.can_manage) && <button type="button" className="text-button ticket-file-move" onClick={() => setMoveItem({ ...d, name: d.title, kind: "document" })}>Move</button>}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="workflow-hint">
                Documents ducks save for this ticket appear here.
              </p>
            )}
          </div>
          <div
            className="ticket-properties-card ticket-files"
            aria-label="Ticket files"
          >
            <h2>Files</h2>
            {files.filter((f) => inFolder(f, folderId)).length ? (
              <ul>
                {files.filter((f) => inFolder(f, folderId)).map((file) => (
                  <li key={file.id}>
                    <TicketFileLink file={file} onPreview={setOpenFile} />
                    <small>
                      {typeLabel(file)} · {formatBytes(file.size)}
                      {file.duck_id &&
                      data.ducks.find((d) => d.id === file.duck_id)?.name
                        ? " · " +
                          data.ducks.find((d) => d.id === file.duck_id).name
                        : ""}{" "}
                      ·{" "}
                      <time dateTime={file.created} title={date(file.created)}>
                        {date(file.created)}
                      </time>
                    </small>
                    {data.permissions.docs && file.can_move !== false && folders.some((f) => f.can_manage) && <button type="button" className="text-button ticket-file-move" onClick={() => setMoveItem({ ...file, id: file.shared_file_id || file.id, kind: file.kind || "upload" })}>Move</button>}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="workflow-hint">
                Files ducks share for this ticket appear here. Each published
                file keeps its own copy.
              </p>
            )}
          </div>
        </aside>
      </div>
      )}
      {openFile && (
        <FileViewer
          file={openFile}
          who={sharerOf(openFile.duck_id ? { duck_id: openFile.duck_id } : { user_id: openFile.user_id }, data)}
          from={openFile.duck_id ? { duck_id: openFile.duck_id } : { user_id: openFile.user_id }}
          shared={{ taskId: task.id, created: openFile.created }}
          data={data}
          action={action}
          go={go}
          deletable={false}
          onClose={() => setOpenFile(null)}
        />
      )}
      {openDoc && (
        <DocumentEditor
          doc={openDoc}
          data={data}
          action={action}
          onClose={() => setOpenDoc(null)}
        />
      )}
      {moveItem && <FolderMoveDialog item={moveItem} folders={folders} ownerName={(f) => f.duck_id ? data.ducks.find((d) => d.id === f.duck_id)?.name : ""} notify={setError} onClose={() => setMoveItem(null)} onMoved={refreshAttachments} />}
    </div>
  );
}
