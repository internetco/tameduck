import { useAIReady } from "./use-ai.mjs";
import { pausedSchedule } from "./inbox-list.mjs";
import { TeamActivity } from "./TeamActivity.jsx";
import { DuckContactsTab } from "./DuckContacts.jsx";
import {
  HOW_OFTEN,
  formFor as contactsFor,
  changed as contactsChanged,
  toSave as contactsToSave,
  takeable,
  typedLimit,
} from "./duck-contacts.mjs";
import { SkillProposalCard } from "./SkillProposals.jsx";
import { HumanInputCard } from "./HumanInput.jsx";
import { BoardProposalCard } from "./BoardProposals.jsx";
import { ScheduleProposalCard } from "./ScheduleProposals.jsx";
import { ConnectionAskCard, ToolAskCard } from "./AskCard.jsx";
import { heldRequests, inboxRows, placeFor, whyHere } from "./inbox-list.mjs";
import { RecoveryStatus } from "./RecoveryStatus.jsx";
import { recoveryDestination } from "./recovery-status.mjs";
import { canConnectAI } from "../shared/ai-access.mjs";
import "./inbox.css";
import "./ticket-documents.css";
import { DuckModelPicker, modelLabel } from "./AISettings.jsx";
import { isSubscription } from "../shared/ai-providers.mjs";
import { EmojiPicker } from "./EmojiPicker.jsx";
import { duckAvatars, avatarFor } from "../shared/avatars.mjs";
import { DuckSkills } from "./Skills.jsx";
import { DuckWebhook } from "./DuckWebhook.jsx";
import { RemoveDuckDialog } from "./DuckRemoval.jsx";
import { duckTabs, faceRow } from "./duck-tabs.mjs";
import { duckCardState } from "./duck-activity.mjs";
import { isStandInJob } from "../shared/duck-job.mjs";
import "./duck-editor.css";
import "./team-cards.css";
import {
  MEMBER_GROUPS,
  ROLES,
  ROLE_DEFAULTS,
  ON,
  OFF,
  asAnswers,
  filledBy,
  helpFor,
  afterRole,
} from "./member-permissions.mjs";
import { isCommunityEdition } from "./settings-pages.mjs";
import "./member-permissions.css";
import "./document-editor.css";
import React, { useState, useEffect, useRef, useId } from "react";
import {
  Plus,
  Search,
  Columns3,
  Check,
  CheckCheck,
  Circle,
  CircleCheck,
  Cpu,
  Clock,
  ArrowRight,
  Users,
  Sparkles,
  Download,
  Play,
  LockKeyhole,
  Link,
  Copy,
  Trash2,
  MoreHorizontal,
  UserPlus,
  UserCog,
  AlertCircle,
  ChevronDown,
  Eye,
  FileText,
  Type,
  RotateCw,
} from "lucide-react";
import {
  api,
  Avatar,
  Modal,
  Field,
  Button,
  IconButton,
  Empty,
  Markdown,
  CopyButton,
  DuckPicker,
  fmtDate,
  fmtTime,
  flock,
  offTheTeam,
  waitingOnYou,
  useUnsavedGuard,
} from "./ui.jsx";
export function TaskBoard({ data, action, go, initialId }) {
  const [draft, setDraft] = useState(null);
  const edit = initialId ? data.tasks.find((t) => t.id === initialId) : draft;
  useEffect(() => {
    setDraft(null);
  }, [initialId]);
  const close = () => {
    setDraft(null);
    if (initialId) go({ type: "tasks" });
  };
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const tasks = data.tasks.filter(
    (t) =>
      (filter === "all" || t.assignee_id === filter) &&
      t.title.toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <div className="page board-page">
      <div className="page-heading">
        <div>
          <div className="eyebrow">A CLEAR VIEW OF THE WORK</div>
          <h2>All tasks</h2>
          <p>One shared board for you and your flock.</p>
        </div>
        {data.permissions.tasks && (
          <Button onClick={() => setDraft({})}>
            <Plus size={17} />
            New task
          </Button>
        )}
      </div>
      <div className="toolbar">
        <div className="search-field">
          <Search size={16} />
          <input
            aria-label="Search tasks"
            placeholder="Find a task…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <select
          aria-label="Filter by duck"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        >
          <option value="all">All ducks</option>
          {flock(data).map((d) => (
            <option value={d.id} key={d.id}>
              {d.name}
            </option>
          ))}
        </select>
        <span className="toolbar-note">{data.tasks.length} tasks</span>
      </div>
      <div className="kanban">
        {[
          { id: "open", label: "Open tasks", icon: Columns3 },
          { id: "working", label: "Being worked on", icon: Clock },
          { id: "done", label: "Done", icon: CheckCheck },
        ].map((column) => {
          const Icon = column.icon;
          const list = tasks.filter((t) => t.status === column.id);
          return (
            <section
              className={"kanban-column " + column.id}
              key={column.id}
              onDragOver={(e) => {
                if (data.permissions.tasks) e.preventDefault();
              }}
              onDrop={(e) => {
                e.preventDefault();
                const task = e.dataTransfer.getData("text/plain");
                if (
                  data.permissions.tasks &&
                  data.tasks.some((t) => t.id === task)
                )
                  action(() =>
                    api("/tasks/" + task, "PATCH", { status: column.id }),
                  );
              }}
            >
              <div className="column-heading">
                <Icon size={16} />
                <h3>{column.label}</h3>
                <span>{list.length}</span>
                {data.permissions.tasks && (
                  <IconButton
                    icon={Plus}
                    label={"Add " + column.label.toLowerCase() + " task"}
                    onClick={() => setDraft({ status: column.id })}
                  />
                )}
              </div>
              <div className="column-tasks">
                {list.map((t) => {
                  const duck = data.ducks.find((d) => d.id === t.assignee_id);
                  return (
                    <article
                      className="task-card"
                      key={t.id}
                      draggable={data.permissions.tasks}
                      onDragStart={(e) =>
                        e.dataTransfer.setData("text/plain", t.id)
                      }
                    >
                      <button
                        className="task-card-content"
                        onClick={() => go({ type: "tasks", id: t.id })}
                      >
                        <div className="task-label">
                          <span className={"priority " + t.priority}>
                            {t.priority === "high"
                              ? "High priority"
                              : t.priority === "low"
                                ? "Low priority"
                                : "Normal priority"}
                          </span>
                          <span>{fmtDate(t.created)}</span>
                        </div>
                        <h3>{t.title}</h3>
                        {t.description && <p>{t.description.slice(0, 160)}</p>}
                      </button>
                      <div className="task-card-bottom">
                        <span className="assignee">
                          {duck ? (
                            <>
                              <Avatar duck={duck} size={25} />
                              {duck.name}
                            </>
                          ) : (
                            <>
                              <Users size={15} />
                              Unassigned
                            </>
                          )}
                        </span>
                        {data.permissions.tasks && (
                          <select
                            aria-label={"Status for " + t.title}
                            value={t.status}
                            onChange={(e) =>
                              action(() =>
                                api("/tasks/" + t.id, "PATCH", {
                                  status: e.target.value,
                                }),
                              )
                            }
                          >
                            <option value="open">Open</option>
                            <option value="working">Working</option>
                            <option value="done">Done</option>
                          </select>
                        )}
                      </div>
                    </article>
                  );
                })}
                {!list.length && (
                  <div className="column-empty">
                    {column.id === "done" ? (
                      <>
                        Finish strong.
                        <br />
                        Finished tasks will land here.
                      </>
                    ) : column.id === "working" ? (
                      <>
                        Ready for action.
                        <br />
                        Assign a task and put a duck on it.
                      </>
                    ) : (
                      <>
                        Room for your next idea.
                        <br />
                        Add a task to get things moving.
                      </>
                    )}
                  </div>
                )}
              </div>
              {data.permissions.tasks && (
                <button
                  className="column-add"
                  onClick={() => setDraft({ status: column.id })}
                >
                  <Plus size={15} /> Add task
                </button>
              )}
            </section>
          );
        })}
      </div>
      {edit && (
        <TaskEditor
          key={edit.id || "new"}
          task={edit}
          data={data}
          action={action}
          go={go}
          onClose={close}
        />
      )}
    </div>
  );
}
export function TaskEditor({ task: listed, data, action, go, onClose }) {
  const [busy, setBusy] = useState(false);
  // The workspace payload carries the first lines of a brief, not the whole
  // thing, because it is fetched again every time a duck reports progress.
  // This form writes the brief back, so it must never open over a clipped one:
  // saving would quietly throw away everything past the cut.
  const [full, setFull] = useState(listed.description_clipped ? null : listed);
  useEffect(() => {
    if (!listed.id || !listed.description_clipped) {
      setFull(listed.id ? listed : null);
      return;
    }
    let live = true;
    setFull(null);
    api("/tasks/" + listed.id)
      .then((t) => live && setFull(t))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [listed.id, listed.updated, listed.description_clipped]);
  const task = listed.id ? full : listed;
  if (!task)
    return (
      <Modal title="Task details" onClose={onClose}>
        <p className="workflow-hint">Fetching the rest of this one…</p>
      </Modal>
    );
  return (
    <Modal
      title={task.id ? "Task details" : "A little work for the flock"}
      onClose={onClose}
      warnUnsaved
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          const a = Object.fromEntries(new FormData(e.currentTarget));
          const r = await action(
            () =>
              api(
                "/tasks" + (task.id ? "/" + task.id : ""),
                task.id ? "PATCH" : "POST",
                {
                  ...a,
                  assignee_id: a.assignee_id || null,
                  // What this form was loaded from. This editor sends every
                  // field back, so without it a save made from a form opened a
                  // minute ago silently undoes whatever somebody else changed
                  // in the meantime.
                  ...(task.id ? { updated: task.updated } : {}),
                },
              ),
            "Task saved",
          );
          setBusy(false);
          if (r) onClose();
        }}
      >
        <Field label="What needs doing?">
          <input
            name="title"
            defaultValue={task.title}
            required
            maxLength={200}
            autoFocus
            readOnly={!data.permissions.tasks}
            placeholder="Write our customer onboarding guide"
          />
        </Field>
        <Field label="A little context">
          <textarea
            name="description"
            rows={5}
            defaultValue={task.description}
            readOnly={!data.permissions.tasks}
            placeholder="What does a good result look like?"
          />
        </Field>
        <div className="form-row">
          <Field label="Assigned duck">
            <select
              name="assignee_id"
              defaultValue={task.assignee_id || ""}
              disabled={!data.permissions.tasks}
            >
              <option value="">Unassigned</option>
              {flock(data).map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Priority">
            <select
              name="priority"
              defaultValue={task.priority || "normal"}
              disabled={!data.permissions.tasks}
            >
              <option value="low">Low</option>
              <option value="normal">Normal</option>
              <option value="high">High</option>
            </select>
          </Field>
        </div>
        <Field label="Status">
          <select
            name="status"
            defaultValue={task.status || "open"}
            disabled={!data.permissions.tasks}
          >
            <option value="open">Open</option>
            <option value="working">Being worked on</option>
            <option value="done">Done</option>
          </select>
        </Field>
        <Field label="Result / handoff notes">
          <textarea
            name="result"
            defaultValue={task.result}
            rows={3}
            readOnly={!data.permissions.tasks}
          />
        </Field>
        <div className="modal-actions">
          {task.id &&
            task.assignee_id &&
            data.permissions.tasks &&
            data.permissions.chat && (
              <Button
                type="button"
                className="secondary"
                busy={busy}
                onClick={async () => {
                  setBusy(true);
                  const r = await action(() =>
                    api("/tasks/" + task.id + "/run", "POST", {}),
                  );
                  setBusy(false);
                  if (r) {
                    onClose();
                    go({ type: "chat", id: r.conversation_id });
                  }
                }}
              >
                <Play size={15} /> Ask duck to start
              </Button>
            )}
          {data.permissions.tasks && <Button busy={busy}>Save task</Button>}
        </div>
      </form>
    </Modal>
  );
}
export function DocumentEditor({ doc, data, action, onClose, onSaved }) {
  const [title, setTitle] = useState(doc.title);
  const [content, setContent] = useState(doc.content);
  // A document that already exists opens finished, the way it always has; a
  // new one opens where a person starts, which is Writing.
  const [reading, setReading] = useState(!!doc.id);
  const [busy, setBusy] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [copyOpen, setCopyOpen] = useState(false);
  const [copyError, setCopyError] = useState("");
  const [copyNote, setCopyNote] = useState("");
  // The name is the dialog's heading now, and the dialog draws its head
  // outside this form. Naming the form lets the field belong to it from up
  // there, so an empty name still stops a save and Enter in it still saves.
  const formId = useId();
  const copyBox = useRef(null);
  const copyButton = useRef(null);
  const sheet = useRef(null);
  // Nothing written means nothing worth putting in a file. The old bar
  // offered both exports on a brand-new document: one made an empty PDF, the
  // other downloaded a file holding a hash and two blank lines.
  const written = content.trim().length > 0;
  // A dialog puts the cursor in the first thing it can. That used to be the
  // close button, and with the name in the head it is now the name: on a
  // phone that scrolls a long name to its last word, and it leaves one
  // keypress between reading a document and renaming it. A document that
  // already has a name opens with the cursor resting on the sheet instead. A
  // new one is left alone, so it still opens in the name, which is the first
  // thing to type. This runs after the dialog has placed the cursor itself.
  useEffect(() => {
    if (doc.id) sheet.current?.focus();
  }, [doc.id]);
  // A menu left open after the pointer has gone elsewhere is a menu somebody
  // has to work out how to get rid of.
  useEffect(() => {
    if (!copyOpen) return;
    const away = (e) => {
      if (!copyBox.current?.contains(e.target)) setCopyOpen(false);
    };
    document.addEventListener("pointerdown", away, true);
    return () => document.removeEventListener("pointerdown", away, true);
  }, [copyOpen]);
  // Choosing from the menu takes the menu away under the hand that chose it,
  // and a keyboard is then left holding nothing: the next Tab starts the
  // dialog again at its name. The cursor goes back to the control that opened
  // the menu - once the work is done, because making a PDF greys that control
  // out and nothing can rest on a control that is switched off.
  const cursorBack = useRef(false);
  useEffect(() => {
    if (!cursorBack.current || copyOpen || preparing) return;
    cursorBack.current = false;
    copyButton.current?.focus();
  }, [copyOpen, preparing]);
  // The same file the "Export Markdown" link made: the name as a heading, a
  // blank line, then the words with their marks exactly as they are stored.
  const plainCopy = () => {
    cursorBack.current = true;
    setCopyOpen(false);
    // Without this a line left over from a PDF stays on screen saying a PDF is
    // on its way, beside a file that is not one.
    setCopyError("");
    setCopyNote("");
    const url = URL.createObjectURL(
      new Blob(["# " + title + "\n\n" + content], { type: "text/markdown" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = (title.replace(/[^a-z0-9]+/gi, "-") || "document") + ".md";
    a.click();
    URL.revokeObjectURL(url);
  };
  const pdfCopy = async () => {
    cursorBack.current = true;
    setCopyOpen(false);
    setPreparing(true);
    setCopyError("");
    setCopyNote("");
    try {
      const { downloadMarkdownPdf } = await import("./markdown-pdf.mjs");
      await downloadMarkdownPdf(title, content);
      setCopyNote("Your PDF is on its way to this computer.");
    } catch (e) {
      setCopyError("Could not make the PDF. Please try again.");
    } finally {
      setPreparing(false);
    }
  };
  return (
    <Modal
      // The biggest words in the dialog are this document's own name, typed
      // where they are read. The heading used to say "Company document",
      // which is the shelf it sits on and not the thing itself.
      title={
        <input
          className="doc-name"
          form={formId}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          required
          maxLength={200}
          readOnly={!data.permissions.docs}
          aria-label="Name of this document"
          placeholder="Name this document"
        />
      }
      ariaLabel={doc.id ? "Document" : "New document"}
      onClose={onClose}
      // A document is the longest thing anybody types in this product, and a
      // stray Escape threw the lot away without a word.
      closeGuard={() =>
        (title === doc.title && content === doc.content) ||
        window.confirm(
          "Close without saving? What you have written here will be lost.",
        )
      }
      wide
    >
      <form
        id={formId}
        className="doc-editor"
        ref={sheet}
        tabIndex={-1}
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          const r = await action(
            () =>
              api(
                "/documents" + (doc.id ? "/" + doc.id : ""),
                doc.id ? "PATCH" : "POST",
                {
                  title,
                  content,
                  ...(doc.conversation_id
                    ? { conversation_id: doc.conversation_id }
                    : {}),
                  ...(!doc.id && doc.folder_id ? { folder_id: doc.folder_id } : {}),
                  ...(doc.id ? { updated: doc.updated } : {}),
                },
              ),
            "Document saved",
          );
          setBusy(false);
          if (r) {
            if (onSaved) await onSaved(r);
            onClose();
          }
        }}
      >
        {/* Two names for the two sides of the same document, the same size,
            side by side, each with a line saying what it is for. "Write" and
            "Preview" were two verbs in a grey switch that read as settings. */}
        <div
          className="doc-modes"
          role="group"
          aria-label="Writing or finished"
        >
          <button
            type="button"
            className="doc-mode"
            aria-pressed={!reading}
            onClick={() => setReading(false)}
          >
            <b>Writing</b>
            <span>change the words</span>
          </button>
          <button
            type="button"
            className="doc-mode"
            aria-pressed={reading}
            onClick={() => setReading(true)}
          >
            <b>Finished</b>
            <span>how it will read</span>
          </button>
        </div>
        {reading ? (
          <div className="doc-read">
            <Markdown>{written ? content : "Nothing written yet."}</Markdown>
          </div>
        ) : (
          <div className="doc-write">
            <textarea
              className="doc-words"
              aria-label="The words of this document"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              readOnly={!data.permissions.docs}
              placeholder="Start writing."
              maxLength={60000}
            />
          </div>
        )}
        {copyError && (
          <p role="alert" className="error-box doc-note">
            {copyError}
          </p>
        )}
        {copyNote && (
          <p role="status" className="muted doc-note">
            {copyNote}
          </p>
        )}
        <div className="modal-actions doc-foot">
          <p className="doc-readers">
            <Eye size={15} /> Everyone at {data.company.name} and all its ducks
            can read this.
          </p>
          <div className="doc-foot-right">
            {written && (
              <div
                className="doc-copy"
                ref={copyBox}
                onKeyDown={(e) => {
                  // Escape belongs to the menu while the menu is open,
                  // otherwise it closes the whole document behind it.
                  if (e.key !== "Escape" || !copyOpen) return;
                  e.preventDefault();
                  e.stopPropagation();
                  setCopyOpen(false);
                  copyButton.current?.focus();
                }}
              >
                <button
                  type="button"
                  className="doc-copy-open"
                  ref={copyButton}
                  aria-haspopup="true"
                  aria-expanded={copyOpen}
                  disabled={preparing}
                  onClick={() => setCopyOpen(!copyOpen)}
                >
                  <Download size={16} />
                  {preparing ? "Getting it ready…" : "Download a copy"}
                  <ChevronDown size={14} className="doc-copy-chevron" />
                </button>
                {copyOpen && (
                  <div className="doc-copy-menu">
                    <button type="button" onClick={pdfCopy}>
                      <FileText size={16} /> PDF, ready to print or send
                    </button>
                    {/* The stored words really do carry marks, and this file
                        is those words. Saying so is kinder than a name for
                        the marks that nobody here has to learn. */}
                    <button type="button" onClick={plainCopy}>
                      <Type size={16} /> Plain text, marks and all
                    </button>
                  </div>
                )}
              </div>
            )}
            {data.permissions.docs && (
              <Button busy={busy}>Save document</Button>
            )}
          </div>
        </div>
      </form>
    </Modal>
  );
}

// The time on a line. Today's things are the ones somebody is reading now, so
// they get the time; anything older says which day as well.
function when(ms) {
  if (!ms) return "";
  return new Date(ms).toDateString() === new Date().toDateString()
    ? fmtTime(ms)
    : fmtDate(ms) + " at " + fmtTime(ms);
}
// "12 min left" while a duck is holding a screen open for somebody. Whole
// minutes, like the card's own foot, so the line and the card inside it never
// disagree by a second.
function minutesLeft(request) {
  const left = request.expires - Date.now();
  return request.status === "submitting" || left <= 0
    ? ""
    : Math.max(1, Math.ceil(left / 60000)) + " min left";
}
// One line: the face, what is needed, who and when, and the way in. The whole
// line is the control - a summary, so opening it with a keyboard and saying so
// to a screen reader come for free - and "Open" is a mark on the line rather
// than a second thing to aim at.
function InboxRow({ row, data, open, onToggle, onInput, children }) {
  const duck = (data.ducks || []).find((d) => d.id === row.duckId);
  const left = row.kind === "request" ? minutesLeft(row.item) : "";
  const said = when(row.at);
  return (
    <details className="inbox-item" open={open}>
      <summary
        className="inbox-row"
        // A summary already tells a screen reader whether it is open, but only
        // through the browser's own mapping of details, which is uneven; said
        // out loud it is also something a check can hold us to.
        aria-expanded={open}
        onClick={(e) => {
          // Which line is open is React's to say. Left alone the browser would
          // toggle as well, and the two would cancel each other out.
          e.preventDefault();
          onToggle();
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape" && open) {
            e.preventDefault();
            onToggle();
          }
        }}
      >
        <Avatar duck={duck} name={row.name} size={32} />
        <span className="inbox-what">
          <span className="inbox-ask">{row.ask}</span>
          <span className="inbox-who">
            {said ? row.name + " · " + said : row.name}
          </span>
        </span>
        {left && (
          <span className="inbox-left">
            <Clock size={12} aria-hidden="true" />
            {left}
          </span>
        )}
        <span className="button secondary small inbox-mark">
          {open ? "Close" : "Open"}
        </span>
      </summary>
      {open && (
        <div className="inbox-open" onInput={onInput}>
          {children}
        </div>
      )}
    </details>
  );
}
// Needs you, as two short lists: the ducks that cannot carry on until somebody
// acts, then the things to read when you like. One line each - the face, what
// is needed, who and when - and the real control opens under the line it
// belongs to.
//
// It used to be one list holding four card shapes behind All / Messages /
// Approvals tabs, where what the duck needed was the smallest text on its
// card, an approval spoke in tool names and raw JSON, and the one blue button
// said "Reply in thread" even when the card asked somebody to go and connect
// an AI. The two lists are the tabs: the sorting is done for you.
export function InboxView({ data, action, go }) {
  const aiReady = useAIReady(data.company.id);
  // Which line is open. undefined until somebody chooses, and then the top line
  // is open on arrival, so the most pressing thing is already there to answer.
  // null is a choice too: it means they shut it.
  const [chosen, setChosen] = useState(undefined);
  // The forms somebody has typed into. When the wait on one runs out it stays
  // where it was, open, with their words, until they take it off: it used to
  // vanish under their hands, and the words with it. Only this page knows, and
  // nothing is waiting on the server any more, so nothing is sent there.
  const [typed, setTyped] = useState(() => new Set());
  // A duck holding a screen open has a countdown on its line, and drops off the
  // page when the wait runs out. Nothing else here moves, and the line only
  // ever shows whole minutes, so this is slow on purpose.
  const [, retime] = useState(0);
  useEffect(() => {
    const tick = setInterval(() => retime((n) => n + 1), 10000);
    return () => clearInterval(tick);
  }, []);
  const held = heldRequests(data, typed);
  const kept = new Set(held.map((r) => "request:" + r.id));
  const { waiting, later } = inboxRows(data, [...waitingOnYou(data), ...held]);
  const first = (waiting[0] || later[0])?.id;
  // The top line opened on arrival is then chosen like any other, so when it
  // is answered and leaves, the line under it stays shut. It used to open by
  // itself, under the hand that had just answered, and a second press of the
  // same spot answered a card nobody had read.
  useEffect(() => {
    if (chosen === undefined && first) setChosen(first);
  }, [chosen, first]);
  const open = chosen === undefined ? first : chosen;
  // An answered line leaves the page, and the keyboard used to go with it, to
  // nothing. Put it on the line that took its place, or on the heading when
  // there is none.
  const column = useRef(null),
    before = useRef({ ids: [], open });
  const ids = [...waiting, ...later].map((row) => row.id);
  useEffect(() => {
    const was = before.current;
    before.current = { ids, open };
    if (!was.ids.includes(was.open) || ids.includes(was.open)) return;
    if (document.activeElement && document.activeElement !== document.body)
      return;
    const at = was.ids.indexOf(was.open);
    const next = [
      ...was.ids.slice(at + 1),
      ...was.ids.slice(0, at).reverse(),
    ].find((id) => ids.includes(id));
    const lines = column.current?.querySelectorAll(".inbox-item > summary");
    (next
      ? lines?.[ids.indexOf(next)]
      : column.current?.querySelector(".inbox-heading")
    )?.focus();
  });
  // A ticket waiting for this person. Nothing here moves it on - a reply in
  // chat never reached it - so the one thing to press goes to the ticket, where
  // a comment or a new attempt does.
  function ticket(row) {
    const { task, board, column, why } = row.item;
    return (
      <>
        {row.said && (
          <div className="inbox-said">
            <Markdown>{row.said}</Markdown>
          </div>
        )}
        <div className="inbox-do">
          <Button
            onClick={() =>
              go({ type: "tasks", boardId: board.id, id: task.id })
            }
          >
            Open the ticket
          </Button>
        </div>
        <div className="inbox-foot">
          <span>
            {why === "step"
              ? "This step is yours" +
                (column?.name ? ": " + column.name + "." : ".")
              : why === "move"
                ? "It is done here, and moves on when you move it."
                : "Nothing moves it on until you look at it."}
          </span>
        </div>
      </>
    );
  }
  function message(row) {
    const m = row.item,
      name = row.name;
    // Where the ask itself points. The card used to send everybody to the
    // thread, including the one asking them to go and connect an AI.
    const place = placeFor(
      m,
      canConnectAI(data.role, data.permissions),
      !!data.permissions?.tasks,
      aiReady === true,
    );
    const reply = () =>
      go({
        type: "chat",
        id: m.conversation_id,
        threadId: m.thread_id || m.id,
      });
    // A duck asking on a ticket is answered on the ticket. Its chat is the
    // ticket's own, hidden one: a reply there never reached the ticket.
    const onTicket = !!m.task_id;
    return (
      <>
        {row.said && (
          <div className="inbox-said">
            <Markdown>{row.said}</Markdown>
          </div>
        )}
        <div className="inbox-do">
          {place ? (
            <>
              <Button onClick={() => go(place.to)}>{place.label}</Button>
              {!onTicket && !pausedSchedule(m) && (
                <button type="button" className="inbox-reply" onClick={reply}>
                  Reply
                </button>
              )}
            </>
          ) : (
            !pausedSchedule(m) && <Button onClick={reply}>Reply</Button>
          )}
        </div>
        <div className="inbox-foot">
          {/* Why it is in the list it is in, so the two lists say what they
              are without a sentence under the heading explaining them. */}
          <span>{whyHere(m, name, aiReady === true)}</span>
          {/* "Clear" with a tick could mean done, deleted or hidden. It takes
              the message off this list and leaves it in the chat it came
              from, so that is what it says now. */}
          <button
            type="button"
            className="inbox-out"
            onClick={() =>
              action(
                () => api("/inbox/" + m.id + "/ignore", "POST", {}),
                "Taken off your list",
              )
            }
          >
            Take off my list
          </button>
        </div>
      </>
    );
  }
  function recovery(row) {
    const item = row.item;
    return (
      <>
        <RecoveryStatus recovery={item} data={data} action={action} />
        <div className="inbox-do">
          <Button onClick={() => go(recoveryDestination(item, data.workflows))}>
            {(data.workflows?.tickets || []).some(
              (t) => t.task_id === item.task_id,
            )
              ? "Open the ticket"
              : "Open the chat"}
          </Button>
        </div>
        <div className="inbox-foot">
          <span>
            {item.can_continue === false
              ? item.continue_blocked_reason ||
                "A person must review this work."
              : "Continue this work or open it to review the saved progress."}
          </span>
        </div>
      </>
    );
  }
  // What opens inside a line. The waiting duck, the asks and the board
  // settings are the cards chat shows, each without its own heading: the line
  // above is the heading.
  const inside = (row) =>
    row.kind === "request" ? (
      <>
        <HumanInputCard
          request={row.item}
          data={data}
          action={action}
          go={go}
          heading={false}
        />
        {kept.has(row.id) && (
          <div className="inbox-foot">
            <span>Kept here because you had started an answer.</span>
            <button
              type="button"
              className="inbox-out"
              onClick={() =>
                setTyped((was) => {
                  const now = new Set(was);
                  now.delete(row.item.id);
                  return now;
                })
              }
            >
              Take off my list
            </button>
          </div>
        )}
      </>
    ) : row.kind === "approval" ? (
      <ToolAskCard
        approval={row.item}
        data={data}
        action={action}
        go={go}
        head={false}
      />
    ) : row.kind === "skill" ? (
      <SkillProposalCard
        proposal={row.item}
        data={data}
        action={action}
        go={go}
        head={false}
      />
    ) : row.kind === "board" ? (
      <BoardProposalCard
        proposal={row.item}
        data={data}
        action={action}
        go={go}
        head={false}
      />
    ) : row.kind === "recovery" ? (
      recovery(row)
    ) : row.kind === "ticket" ? (
      ticket(row)
    ) : row.kind === "connection" ? (
      <ConnectionAskCard
        block={row.item}
        data={data}
        action={action}
        go={go}
        head={false}
      />
    ) : row.kind === "schedule" ? (
      <ScheduleProposalCard
        proposal={row.item}
        data={data}
        action={action}
        go={go}
        head={false}
      />
    ) : (
      message(row)
    );
  const list = (rows, label, calm) =>
    rows.length > 0 && (
      <section
        className={"inbox-group" + (calm ? " calm" : "")}
        aria-label={label}
      >
        <p className="inbox-band">
          <b>{label}</b>
          {/* A kept form is nobody waiting, so it is not counted, here or in
              the sidebar. */}
          <span className="inbox-count">
            {rows.filter((row) => !kept.has(row.id)).length}
          </span>
        </p>
        {rows.map((row) => (
          <InboxRow
            key={row.id}
            row={row}
            data={data}
            open={open === row.id}
            onToggle={() => setChosen(open === row.id ? null : row.id)}
            onInput={(e) => {
              if (
                row.kind === "request" &&
                String(e.target.value || "").trim() &&
                !typed.has(row.item.id)
              )
                setTyped((was) => new Set(was).add(row.item.id));
            }}
          >
            {/* Only the open one is built: a card that is not on screen
                should not be running a clock. */}
            {open === row.id ? inside(row) : null}
          </InboxRow>
        ))}
      </section>
    );
  return (
    <div className="page inbox-page">
      <div className="inbox-col" ref={column}>
        <h2 className="inbox-heading" tabIndex={-1}>
          Needs you
        </h2>
        {list(waiting, "Waiting for you", false)}
        {list(later, "To read when you like", true)}
        {!waiting.length && !later.length && (
          <Empty icon={CheckCheck} title="Nothing waiting on you.">
            Duck questions and blockers, messages from people, proposals and
            connected tool requests appear here.
          </Empty>
        )}
      </div>
    </div>
  );
}
// A model picked for one duck has to name a model, unless the provider picks
// its own. Asked twice: once to open the picker on a choice that is half made,
// and once to refuse a save the server would refuse anyway.
const modelUnfinished = (choice) =>
  !!choice && !choice.model && !isSubscription(choice.provider);
// One of the three big boxes of the duck dialog. The question is the box's
// label, so pressing it puts the cursor in the box, and the help sits above
// the box, where it is read before typing rather than after.
function DuckBrief({ question, say, ...box }) {
  const id = useId();
  return (
    <div className="duck-brief">
      <label htmlFor={id}>{question}</label>
      <p id={id + "-say"}>{say}</p>
      <textarea
        id={id}
        aria-describedby={id + "-say"}
        rows={8}
        maxLength={60000}
        {...box}
      />
    </div>
  );
}
export function DuckEditor({ duck, data, action, onClose, onCreated }) {
  const [tab, setTab] = useState("profile");
  // Asking whether to take the duck off the team opens over this dialog rather
  // than in place of it. It used to replace it, so Cancel dropped you out of
  // the profile altogether and threw away anything typed there without asking.
  const [removing, setRemoving] = useState(false);
  const [form, setForm] = useState(
    duck
      ? {
          ai_model:
            data.ai?.overrides?.find((m) => m.duck_id === duck.id) || null,
          name: duck.name,
          role: duck.role,
          emoji: duck.emoji,
          avatar: duck.avatar || avatarFor(duck),
          color: duck.color,
          soul: duck.soul,
          // A duck made with no job is given a stand-in for one, so its prompt
          // has no hole in it. Nobody wrote it, so here it is the blank it
          // stands in for: the tab says "Empty" and the box shows the example.
          // Nothing is sent unless somebody then writes a job.
          identity: isStandInJob(duck.identity) ? "" : duck.identity,
          notes: duck.notes,
        }
      : {
          name: "",
          role: "",
          emoji: "🦆",
          avatar: "01-hype-duck",
          ai_model: null,
          color: "#ffce32",
          soul: "Thoughtful, resourceful, and clear. Take ownership of your work, ask good questions, and explain what you need.",
          identity: "",
          notes: "",
        },
  );
  const [busy, setBusy] = useState(false);
  // Colour, twenty faces and sixty-four emoji were half of the first tab, and
  // the model took a card of its own above them. Each is one press away now,
  // and opens where it stands.
  const [moreFaces, setMoreFaces] = useState(false);
  const [modelOpen, setModelOpen] = useState(() =>
    modelUnfinished(form.ai_model),
  );
  // The face that holds the last place in the short row.
  const [keptFace, setKeptFace] = useState(form.avatar);
  // What the duck looked like when this dialog opened, so saving can tell what
  // this person changed from what the duck changed underneath them.
  const opened = useRef(form);
  const formEl = useRef(null);
  const uid = useId();
  const edit = data.permissions.ducks;
  // A duck that is off the team has no "Save changes" until it is put back,
  // so its boxes are for reading, as they are for somebody who may not change
  // ducks. They took typing before, and then had nowhere to send it.
  const canChange = edit && !duck?.removed;
  const field = (key, value) => setForm((f) => ({ ...f, [key]: value }));
  // Who this duck may ask for help. It is part of this form now, saved by the
  // same Save changes: it used to have a button of its own inside the tab,
  // out of reach at the bottom, and switching tab or closing lost the ticks
  // without a word. What the server already sends every tab is where it
  // starts, and its version is what the save says it started from.
  const savedContacts =
    duck && data.duck_settings?.find((d) => d.id === duck.id)?.contact_policy;
  const [contactsFrom, setContactsFrom] = useState(savedContacts || null);
  const [contacts, setContacts] = useState(() =>
    savedContacts ? contactsFor(savedContacts) : null,
  );
  // What the Contacts tab has to say: a number the server would not take, or
  // that somebody else changed who it may ask while this dialog was open.
  const [contactsProblem, setContactsProblem] = useState(null);
  useEffect(() => {
    if (!contactsFrom && savedContacts) {
      setContactsFrom(savedContacts);
      setContacts(contactsFor(savedContacts));
    }
  }, [contactsFrom, savedContacts]);
  // A duck switched on here and then taken off the team, in another tab say,
  // has no switch any more, and the server would refuse the whole list for
  // it. It is left out of what is saved, and the save says so.
  const { left: contactsLeft = [], ...contactsKept } =
    contacts && contactsFrom
      ? takeable(
          contacts,
          (data.duck_settings || [])
            .map((d) => d.id)
            .filter((id) => id !== duck?.id),
          contactsFrom,
        )
      : {};
  const contactsDirty =
    !!contacts &&
    !!contactsFrom &&
    contactsChanged({ ...contacts, ...contactsKept }, contactsFrom);
  const formDirty = JSON.stringify(form) !== JSON.stringify(opened.current);
  // Back in the browser, and closing or reloading the tab, ask as closing the
  // dialog does. They threw a flip away without a word.
  useUnsavedGuard(() => canChange && (formDirty || contactsDirty));
  const companyModel = data.ai?.default || { provider: "codex", model: "" };
  const tabs = duckTabs({
    form,
    duck,
    edit,
    skillsOn: duck
      ? data.skills.filter((s) => s.ducks.includes(duck.id)).length
      : 0,
    // The mark says what the switches say now, as the other tabs' marks do.
    contacts: contacts || savedContacts || undefined,
    ducks: data.ducks,
    webhook:
      duck && data.duck_settings?.find((d) => d.id === duck.id)?.webhook,
  });
  const faces = faceRow(duckAvatars, keptFace);
  const chooseFace = (id) => {
    field("avatar", id);
    if (!faces.some((a) => a.id === id)) setKeptFace(id);
  };
  const who = form.name.trim() || "this duck";
  const panel = {
    role: "tabpanel",
    id: uid + "panel",
    "aria-labelledby": uid + "tab" + tabs.findIndex((t) => t.id === tab),
  };
  return (
    <Modal
      title={
        duck ? (edit ? "Meet " + duck.name : duck.name) : "Welcome a new duck"
      }
      onClose={onClose}
      // This dialog holds a duck's character, its job and its notes, and a
      // stray Escape or a click beside it threw the lot away without a word.
      closeGuard={() =>
        (!formDirty && !contactsDirty) ||
        window.confirm(
          formDirty
            ? "Close without saving? What you have written here will be lost."
            : "Close without saving? Your changes here will be lost.",
        )
      }
      wide
    >
      <div className="duck-profile-hero">
        <Avatar duck={form} size={72} />
        <div>
          <h3>{form.name || "Your next teammate"}</h3>
          <p>{form.role || "A fresh perspective for your flock"}</p>
          {duck?.chief ? (
            <span className="pill chief">
              <Sparkles size={12} /> Chief of staff
            </span>
          ) : (
            <span className="pill">AI teammate</span>
          )}
        </div>
      </div>
      {/* These were four bare 12px words, the job third among them, and a
          sentence far below the fold to explain them. Each one now says what
          it holds and whether it is filled in. Every tab can be reached with
          Tab as before; the arrow keys move along them as well, which is what
          a screen reader is told to expect of a tab list. */}
      <div
        className={
          "duck-tabs" +
          (tabs.length > 4 ? " many" : "") +
          (tabs.length > 6 ? " seven" : "")
        }
        role="tablist"
        aria-label="Parts of this duck"
        onKeyDown={(e) => {
          const at = tabs.findIndex((t) => t.id === tab);
          const to =
            e.key === "ArrowRight"
              ? (at + 1) % tabs.length
              : e.key === "ArrowLeft"
                ? (at - 1 + tabs.length) % tabs.length
                : e.key === "Home"
                  ? 0
                  : e.key === "End"
                    ? tabs.length - 1
                    : -1;
          if (to < 0) return;
          e.preventDefault();
          setTab(tabs[to].id);
          e.currentTarget.children[to].focus();
        }}
      >
        {tabs.map((t, i) => (
          <button
            type="button"
            role="tab"
            key={t.id}
            id={uid + "tab" + i}
            className="duck-tab"
            // A name that does not move when the words do: the home page's
            // demo, and anything else that drives this dialog, finds a tab by
            // this rather than by its label and description.
            data-tab={t.id}
            aria-selected={tab === t.id}
            aria-controls={tab === t.id ? panel.id : undefined}
            onClick={() => setTab(t.id)}
          >
            <b>{t.name}</b>
            {t.mark === "needed" ? (
              <span className="duck-flag">{t.label}</span>
            ) : t.mark === "filled" ? (
              <CircleCheck
                className="duck-tab-mark filled"
                size={16}
                role="img"
                aria-label={t.label}
              />
            ) : (
              t.mark === "empty" && (
                <Circle
                  className="duck-tab-mark"
                  size={16}
                  role="img"
                  aria-label={t.label}
                />
              )
            )}
            <small>{t.about}</small>
          </button>
        ))}
      </div>
      {tab === "skills" && duck && (
        <div {...panel}>
          <DuckSkills duck={duck} data={data} action={action} />
          {/* The bar with "Save changes" is gone on these two tabs, and
              nothing said why. */}
          {data.permissions.skills && (
            <p className="duck-tab-foot">
              Skills are saved as you tick them, so there is no Save button
              here.
            </p>
          )}
        </div>
      )}
      {tab === "webhook" && duck && (
        <div {...panel}>
          <DuckWebhook duck={duck} action={action} />
        </div>
      )}
      <form
        ref={formEl}
        hidden={tab === "skills" || tab === "webhook"}
        onSubmit={async (e) => {
          e.preventDefault();
          if (!form.name || !form.role) {
            setTab("profile");
            // The name and the role live on the first tab, so from any other
            // one this button did nothing that could be seen. The browser says
            // which of the two is missing, once they are back on screen.
            requestAnimationFrame(() => formEl.current?.reportValidity());
            return;
          }
          // A provider with no model is refused by the server, and this form
          // sends every change as one diff - so the refusal threw away the
          // name, the notes and the avatar this person had changed too. The
          // model picker sits on the profile tab and says what is missing.
          if (modelUnfinished(form.ai_model)) {
            setTab("profile");
            setModelOpen(true);
            // Save sits at the bottom of a long dialog and the model sits near
            // the top of it, so switching tabs alone left somebody pressing a
            // button that did nothing visible.
            requestAnimationFrame(() =>
              document.querySelector(".duck-model-setting")?.scrollIntoView({
                block: "center",
                // Asked for in the call, a glide ignores the stylesheet's
                // promise to somebody who has turned motion off.
                behavior: matchMedia("(prefers-reduced-motion: reduce)").matches
                  ? "auto"
                  : "smooth",
              }),
            );
            return;
          }
          // A number of one's own that is not one the server takes: said on
          // the Contacts tab, next to the box, before anything is sent.
          const contactsOut = contactsDirty
            ? contactsToSave({ ...contacts, ...contactsKept })
            : null;
          if (contactsDirty && !contactsOut) {
            setTab("contacts");
            setContactsProblem({
              limit: HOW_OFTEN.find(
                ({ key }) =>
                  typeof contacts[key] === "string" &&
                  typedLimit(contacts[key]) === null,
              ).key,
              text: "Enter a whole number from 1 to 1000.",
            });
            return;
          }
          setContactsProblem(null);
          setBusy(true);
          // Send only what this person actually changed. Sending the whole form
          // wrote back every field as it was when the dialog opened, so saving
          // an avatar threw away notes the duck had written in the meantime.
          const changed = Object.fromEntries(
            Object.entries(form).filter(
              ([k, v]) =>
                JSON.stringify(v) !== JSON.stringify(opened.current[k]),
            ),
          );
          const profileChanged = Object.keys(changed).length > 0;
          // Somebody else, or the Chief, may have changed the contacts since
          // this dialog opened. Then the rest is still saved, and the tab
          // comes back with what they are now, to be looked at again. When
          // the rest is saved and the contacts fail for another reason, that
          // is said too, rather than only the reason.
          let newer = null;
          let notYet = false;
          const r = await action(
            async () => {
              const saved =
                !contactsOut || profileChanged
                  ? await api(
                      "/ducks" + (duck ? "/" + duck.id : ""),
                      duck ? "PATCH" : "POST",
                      duck ? changed : form,
                    )
                  : true;
              if (contactsOut) {
                try {
                  await api("/ducks/" + duck.id + "/contacts", "PATCH", {
                    ...contactsOut,
                    expected_version: contactsFrom.version,
                  });
                } catch (e) {
                  // The server says 409 for more than a newer version: only
                  // a newer version is somebody else's change.
                  const now =
                    e.status === 409 &&
                    (await api("/ducks/" + duck.id + "/contacts").catch(
                      () => null,
                    ));
                  if (
                    now &&
                    now.contact_policy.version !== contactsFrom.version
                  )
                    newer = now.contact_policy;
                  else if (profileChanged) notYet = true;
                  else throw e;
                }
              }
              return saved;
            },
            () =>
              notYet
                ? "The rest is saved. Contacts are not yet: try Save changes again."
                : newer
                  ? profileChanged
                    ? "The rest is saved. Contacts are not yet: check them and save again."
                    : undefined
                  : duck
                    ? "Duck updated" +
                      (contactsOut && contactsLeft.length
                        ? ". " +
                          contactsLeft
                            .map(
                              (id) =>
                                data.ducks.find((d) => d.id === id)?.name ||
                                "A duck",
                            )
                            .join(" and ") +
                          (contactsLeft.length > 1 ? " were" : " was") +
                          " taken off the team, so " +
                          duck.name +
                          " cannot ask " +
                          (contactsLeft.length > 1 ? "them." : "it.")
                        : "")
                    : "A new duck joined the flock",
          );
          setBusy(false);
          if (r && notYet) {
            opened.current = form;
            setTab("contacts");
          } else if (r && newer) {
            opened.current = form;
            setContactsFrom(newer);
            setContacts(contactsFor(newer));
            setTab("contacts");
            setContactsProblem({
              notice:
                "Somebody changed these while you had them open. Here they are now. Check them and press Save changes again.",
            });
          } else if (r) {
            duck ? onClose() : onCreated(r);
          }
        }}
      >
        {tab === "profile" && (
          <div className="duck-pane" {...panel}>
            <div className="form-row">
              <Field label="Name">
                <input
                  value={form.name}
                  onChange={(e) => field("name", e.target.value)}
                  required
                  maxLength={100}
                  readOnly={!canChange}
                  placeholder="Penny"
                />
              </Field>
              <Field
                label={
                  <>
                    Role <i>in a few words</i>
                  </>
                }
              >
                <input
                  value={form.role}
                  onChange={(e) => field("role", e.target.value)}
                  required
                  maxLength={100}
                  readOnly={!canChange}
                  placeholder="Marketing & storytelling"
                />
              </Field>
            </div>
            {/* The face is at the top of the dialog for everyone. Picking one is
                only for somebody who can: a row of greyed-out faces and a
                button that opened more of them told nobody anything. */}
            {canChange && (
              <div className={"duck-look" + (moreFaces ? " open" : "")}>
                {moreFaces ? (
                  <>
                    <Field label="Avatar background">
                      <div className="color-options">
                        {[
                          "#ffce32",
                          "#38df95",
                          "#4385ff",
                          "#a978ff",
                          "#ff638c",
                          "#ff953f",
                        ].map((c) => (
                          <button
                            type="button"
                            aria-label={"Choose color " + c}
                            aria-pressed={form.color === c}
                            key={c}
                            style={{ background: c }}
                            className={form.color === c ? "selected" : ""}
                            onClick={() => field("color", c)}
                          >
                            {form.color === c && <Check size={18} />}
                          </button>
                        ))}
                      </div>
                    </Field>
                    <Field
                      label="A face for your duck"
                      hint="Twenty personalities. Pick one that feels like your teammate."
                    >
                      <div className="duck-avatar-options">
                        {duckAvatars.map((a) => (
                          <button
                            type="button"
                            key={a.id}
                            aria-label={"Choose " + a.name}
                            aria-pressed={form.avatar === a.id}
                            title={a.name}
                            onClick={() => chooseFace(a.id)}
                          >
                            <Avatar
                              duck={{ avatar: a.id, color: form.color }}
                              size={56}
                            />
                            <span>{a.name.replace(" Duck", "")}</span>
                          </button>
                        ))}
                      </div>
                    </Field>
                    <Field label="Or choose an emoji">
                      <EmojiPicker
                        value={form.avatar === "emoji" ? form.emoji : null}
                        onChange={(emoji) =>
                          setForm((f) => ({ ...f, emoji, avatar: "emoji" }))
                        }
                      />
                    </Field>
                  </>
                ) : (
                  <Field label="Face">
                    <div className="duck-faces">
                      {faces.map((a) => (
                        <button
                          type="button"
                          key={a.id}
                          aria-label={"Choose " + a.name}
                          aria-pressed={form.avatar === a.id}
                          title={a.name}
                          onClick={() => chooseFace(a.id)}
                        >
                          <Avatar
                            duck={{ avatar: a.id, color: form.color }}
                            size={40}
                          />
                        </button>
                      ))}
                    </div>
                  </Field>
                )}
                {/* Keyed so it is the same button open and shut, and whoever
                  pressed it with the keyboard is still standing on it. */}
                <button
                  type="button"
                  key="more"
                  className="button secondary small"
                  aria-expanded={moreFaces}
                  onClick={() => setMoreFaces(!moreFaces)}
                >
                  {moreFaces
                    ? "Fewer faces and colours"
                    : "More faces and colours"}
                </button>
              </div>
            )}
            <div className="duck-model-row">
              <Cpu size={16} aria-hidden="true" />
              <b>AI model</b>
              <span>{form.ai_model ? "Its own" : "Same as the company"}</span>
              <small>{modelLabel(form.ai_model || companyModel)}</small>
              <button
                type="button"
                className="text-button"
                aria-expanded={modelOpen}
                onClick={() => setModelOpen(!modelOpen)}
              >
                {modelOpen ? "Hide" : canChange ? "Change" : "Compare"}
              </button>
            </div>
            {modelOpen && (
              <DuckModelPicker
                value={form.ai_model}
                onChange={(v) => field("ai_model", v)}
                companyDefault={companyModel}
                disabled={!canChange}
                data={data}
              />
            )}
          </div>
        )}
        {tab === "identity.md" && (
          <div {...panel}>
            <DuckBrief
              question={"What is " + who + "’s job?"}
              say="Brief it like a new colleague: what it looks after, what it can do on its own, and when to ask you."
              value={form.identity}
              onChange={(e) => field("identity", e.target.value)}
              readOnly={!canChange}
              placeholder={
                "For example: You answer the email customers send to " +
                data.company.name +
                ". Reply to questions about orders and deliveries yourself. Ask " +
                data.user.name.split(" ")[0] +
                " before you offer a refund."
              }
            />
          </div>
        )}
        {tab === "soul.md" && (
          <div {...panel}>
            <DuckBrief
              question="How should it behave?"
              say={
                !duck && form.soul === opened.current.soul
                  ? "Filled in for you. Change it if you want a different manner."
                  : "Its manner: how it talks, what it cares about, and how it makes up its mind."
              }
              value={form.soul}
              onChange={(e) => field("soul", e.target.value)}
              readOnly={!canChange}
            />
          </div>
        )}
        {tab === "notes" && (
          <div {...panel}>
            <DuckBrief
              question="What should it remember?"
              say="It adds to these notes itself as it learns. Everyone in your company can read them."
              value={form.notes}
              onChange={(e) => field("notes", e.target.value)}
              readOnly={!canChange}
              placeholder="Preferences, decisions, and useful context…"
            />
          </div>
        )}
        {tab === "contacts" && duck && contacts && (
          <div {...panel}>
            <DuckContactsTab
              duck={duck}
              data={data}
              saved={contactsFrom}
              value={contacts}
              onChange={(next) => {
                setContacts(next);
                setContactsProblem(null);
              }}
              problem={contactsProblem}
            />
          </div>
        )}
        <div className="modal-actions duck-actions">
          {/* Making a duck with no job is allowed, so this only says so. It
              wears the same colour as the mark on the tab it is about. */}
          {!duck && !form.identity.trim() && (
            <span className="duck-flag">Its job is still empty</span>
          )}
          {duck && (duck.removed || !edit) && (
            <small className="muted">
              {duck.removed
                ? "Off the team. Its work is all still here."
                : "A member of " + data.company.name}
            </small>
          )}
          {/* A duck used to be for ever: a capped flock, no way to take
              one back off. The chief runs the flock and every company has
              exactly one, so that one stays. */}
          {duck && edit && !duck.chief && (
            <button
              type="button"
              className={"text-button" + (duck.removed ? "" : " duck-remove")}
              onClick={() =>
                duck.removed
                  ? action(
                      () =>
                        api("/ducks/" + duck.id + "/removed", "PATCH", {
                          removed: false,
                        }),
                      duck.name + " is back on the team.",
                    ).then((ok) => ok && onClose())
                  : setRemoving(true)
              }
            >
              {duck.removed ? "Put back on the team" : "Take off the team"}
            </button>
          )}
          {/* Both ended in a plus, and nothing is added by saving. */}
          {edit && !duck?.removed && (
            <Button busy={busy}>
              {!busy && (duck ? <Check size={16} /> : <Plus size={16} />)}
              {duck ? "Save changes" : "Create duck"}
            </Button>
          )}
        </div>
      </form>
      {removing && (
        <RemoveDuckDialog
          duck={duck}
          action={action}
          onClose={() => setRemoving(false)}
          onRemoved={onClose}
        />
      )}
    </Modal>
  );
}
export function GroupEditor({ data, action, onClose, onCreated }) {
  const [ducks, setDucks] = useState([]);
  const [humans, setHumans] = useState([]);
  const [busy, setBusy] = useState(false);
  return (
    <Modal title="Bring the right minds together" onClose={onClose}>
      <p>Bring human teammates together. Ducks are optional.</p>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          const r = await action(() =>
            api("/conversations", "POST", {
              name: new FormData(e.currentTarget).get("name"),
              ducks,
              members: humans,
            }),
          );
          setBusy(false);
          if (r) onCreated(r);
        }}
      >
        <Field label="Group name">
          <input
            name="name"
            placeholder="launch-planning"
            maxLength={100}
            required
            autoFocus
          />
        </Field>
        <Field label="Ducks (optional)">
          <DuckPicker ducks={flock(data)} value={ducks} onChange={setDucks} />
        </Field>
        <Field label="Human teammates">
          <div className="check-list">
            <label>
              <input type="checkbox" checked disabled />
              <Avatar name={data.user.name} size={30} />
              <span>{data.user.name} (you)</span>
            </label>
            {data.members
              .filter((m) => m.id !== data.user.id)
              .map((m) => (
                <label key={m.id}>
                  <input
                    type="checkbox"
                    checked={humans.includes(m.id)}
                    onChange={(e) =>
                      setHumans(
                        e.target.checked
                          ? [...humans, m.id]
                          : humans.filter((x) => x !== m.id),
                      )
                    }
                  />
                  <Avatar name={m.name} size={30} />
                  <span>{m.name}</span>
                </label>
              ))}
          </div>
        </Field>
        <div className="modal-actions">
          <Button busy={busy} disabled={!ducks.length && !humans.length}>
            Create group chat <ArrowRight size={16} />
          </Button>
        </div>
      </form>
    </Modal>
  );
}
// The chat this person already has with a duck, if there is one. Reading it
// back off the conversations they are in, rather than asking the server to
// find-or-create, because a duck that is off the team must not get a new chat
// made for it.
const chatWith = (data, duck) =>
  (data.conversations || []).find(
    (c) => c.kind === "direct" && c.ducks?.includes(duck.id),
  );

export function TeamView({
  data,
  action,
  setModal,
  openDuck,
  openPerson,
  go,
  notify,
  tab = "people",
  focusDuckId,
}) {
  // Team used to open on the activity feed, which said "No work to show."
  // to anybody whose ducks were idle, with the ducks and the people behind a
  // second tab. The team is what the page is for, so it opens on the team.
  const activity = tab === "activity";
  return (
    <div className="page team-page">
      <div className="team-sections" role="tablist" aria-label="Team sections">
        <button
          type="button"
          role="tab"
          id="team-people-tab"
          aria-controls="team-people-panel"
          aria-selected={!activity}
          onClick={() => go({ type: "team" })}
        >
          Ducks &amp; people
        </button>
        <button
          type="button"
          role="tab"
          id="team-activity-tab"
          aria-controls="team-activity-panel"
          aria-selected={activity}
          onClick={() => go({ type: "team", tab: "activity" })}
        >
          Activity
        </button>
      </div>
      {activity ? (
        <div
          role="tabpanel"
          id="team-activity-panel"
          aria-labelledby="team-activity-tab"
        >
          <TeamActivity
            data={data}
            action={action}
            go={go}
            setModal={setModal}
            notify={notify}
            focusDuckId={focusDuckId}
          />
        </div>
      ) : (
        <div
          className="team-people"
          role="tabpanel"
          id="team-people-panel"
          aria-labelledby="team-people-tab"
        >
          <PeopleView
            data={data}
            action={action}
            notify={notify}
            setModal={setModal}
            openDuck={openDuck}
            openPerson={openPerson}
            go={go}
          />
        </div>
      )}
    </div>
  );
}
function DuckCard({ data, duck, items, openDuck, setModal, go }) {
  const state = duckCardState(items);
  // One button that matters. A duck holding something up is answered where it
  // is waiting; any other duck is written to.
  const main = state.answer ? (
    <Button
      className="small team-card-answer"
      aria-label={"Answer " + duck.name}
      onClick={() => go(state.answer)}
    >
      Answer
    </Button>
  ) : data.permissions.chat ? (
    <Button
      className="secondary small"
      aria-label={"Message " + duck.name}
      onClick={() => openDuck(duck)}
    >
      Message
    </Button>
  ) : null;
  return (
    <div className={"team-card" + (state.attention ? " needs-you" : "")}>
      <div className="team-card-who">
        <Avatar duck={duck} size={44} />
        <span className="team-card-names">
          <span className="team-card-name">
            {duck.name}
            {!!duck.chief && (
              <span
                className="team-card-chief"
                role="img"
                title="Chief of staff"
                aria-label="Chief of staff"
              >
                <Sparkles size={14} />
              </span>
            )}
          </span>
          <span className="team-card-role">{duck.role}</span>
        </span>
      </div>
      {/* Who it is first, then what it is doing, then what you can do about
          it - the order a person reads a card in. */}
      <p
        className={
          "team-card-state" +
          (state.working ? " working" : !items?.length ? " ready" : "")
        }
      >
        {state.attention ? (
          <b className="team-card-flag">{state.text}</b>
        ) : (
          <b>
            {state.working && (
              <i className="team-card-dot" aria-hidden="true" />
            )}
            {state.text}
          </b>
        )}
        {!!state.say && (
          <span className="team-card-say">
            {state.attention ? " " + state.say : " · " + state.say}
          </span>
        )}
      </p>
      <div className="team-card-do">
        {main}
        {/* The corner arrow used to be the whole card, and what it opened
            was a settings form. It is a button now, and it says so. */}
        <button
          type="button"
          className={main ? "team-card-quiet" : "button secondary small"}
          aria-label={duck.name + "’s profile"}
          onClick={() => setModal({ type: "duck", duck })}
        >
          Profile
        </button>
      </div>
    </div>
  );
}
const ownerName = (data) =>
  data.members.find((m) => m.role === "owner")?.name || "the owner";
function PersonCard({ data, member, openPerson, onPermissions, go }) {
  const you = member.id === data.user.id;
  const canMessage = !you && data.permissions.chat;
  const canChange = data.role === "owner" && member.role !== "owner";
  return (
    <div className="team-card person">
      <div className="team-card-who">
        <Avatar name={member.name} size={40} />
        <span className="team-card-names">
          <span className="team-card-name">{member.name}</span>
          <span className="team-card-role">
            <span className="team-card-standing">{member.role}</span>
            {you && " · you"}
          </span>
        </span>
      </div>
      <div className="team-card-do">
        {canMessage && (
          <Button
            className="secondary small"
            aria-label={"Message " + member.name}
            onClick={() => openPerson(member)}
          >
            Message
          </Button>
        )}
        {you && (
          <button
            type="button"
            className="team-card-quiet"
            onClick={() => go({ type: "settings", tab: "account" })}
          >
            Your account
          </button>
        )}
        {/* Beside Message the word did not fit, and pushed both under the
            name on some cards and not others. The owner is the only one who
            sees it, and the tip says the word. */}
        {canChange && (
          <button
            type="button"
            className={
              "button secondary small" + (canMessage ? " team-card-icon" : "")
            }
            aria-label={member.name + "’s permissions"}
            title={canMessage ? "Permissions" : undefined}
            onClick={() => onPermissions(member)}
          >
            {canMessage ? <UserCog size={17} /> : "Permissions"}
          </button>
        )}
      </div>
    </div>
  );
}
function PeopleView({
  data,
  action,
  notify,
  setModal,
  openDuck,
  openPerson,
  go,
}) {
  const [invite, setInvite] = useState(false);
  const [editing, setEditing] = useState(null);
  const activity = new Map(
    (data.duck_activity || []).map((entry) => [entry.duck_id, entry.items]),
  );
  return (
    <div className="page team-cards">
      {/* Making a duck and inviting a person each sit with the list they add
          to. The page's own name is on the bar above these tabs. */}
      <div className="team-group">
        <h2>
          Ducks <span>{flock(data).length}</span>
        </h2>
        {data.permissions.ducks && (
          <Button
            className="small team-add-duck"
            onClick={() => setModal({ type: "duck" })}
          >
            <Plus size={15} />
            Add a duck
          </Button>
        )}
      </div>
      <div className="team-grid duck-grid">
        {flock(data).map((d) => (
          <DuckCard
            key={d.id}
            data={data}
            duck={d}
            items={activity.get(d.id)}
            openDuck={openDuck}
            setModal={setModal}
            go={go}
          />
        ))}
      </div>
      {offTheTeam(data).length > 0 && (
        <>
          {/* Where a duck goes when it is taken off the team, and the way
              back. The same shape as Archived channels, and here rather than
              in Settings because this is the page about who is on the team. */}
          <div className="team-group">
            <h2>
              Off the team <span>{offTheTeam(data).length}</span>
            </h2>
          </div>
          <p className="team-note">
            These ducks are not offered any work. Everything they wrote is still
            here, and you can put them back whenever you like.
          </p>
          <div className="member-table">
            {offTheTeam(data).map((d) => (
              <div className="member-row" key={d.id}>
                <Avatar duck={d} />
                <span>
                  <strong>{d.name}</strong>
                  <small>{d.role}</small>
                </span>
                <span className="pill">Off the team</span>
                {/* A duck's chat is reached through the list of ducks and
                    nowhere else, so taking it out of that list took its whole
                    history off the screen with it. This is the way back in. */}
                {chatWith(data, d) && (
                  <Button
                    className="secondary small"
                    onClick={() =>
                      go({ type: "chat", id: chatWith(data, d).id })
                    }
                  >
                    Read the chat
                  </Button>
                )}
                {data.permissions.ducks && (
                  <Button
                    className="secondary small"
                    onClick={() =>
                      action(
                        () =>
                          api("/ducks/" + d.id + "/removed", "PATCH", {
                            removed: false,
                          }),
                        d.name + " is back on the team.",
                      )
                    }
                  >
                    Put back
                  </Button>
                )}
                <Button
                  className="secondary small"
                  onClick={() => setModal({ type: "duck", duck: d })}
                >
                  Open profile
                </Button>
              </div>
            ))}
          </div>
        </>
      )}
      <div className="team-group">
        <h2>
          People <span>{data.members.length}</span>
        </h2>
        {data.permissions.team && (
          <Button className="secondary small" onClick={() => setInvite(true)}>
            <UserPlus size={15} />
            Invite a teammate
          </Button>
        )}
      </div>
      <div className="team-grid person-grid">
        {data.members.map((m) => (
          <PersonCard
            key={m.id}
            data={data}
            member={m}
            openPerson={openPerson}
            onPermissions={setEditing}
            go={go}
          />
        ))}
      </div>
      {data.permissions.team && data.role !== "owner" && (
        <p className="team-note">
          Only {ownerName(data)} can change what people may do, or take someone
          off the team.
        </p>
      )}
      {data.invites.length > 0 && (
        <>
          <div className="team-group">
            <h2>
              Waiting to join <span>{data.invites.length}</span>
            </h2>
          </div>
          {/* These rows used to stand on their own, so each one drew the line
              meant to divide it from the next and the last one ended in a
              line to nowhere. */}
          <div className="member-table">
            {data.invites.map((i) => (
              <InviteRow
                key={i.id}
                invite={i}
                data={data}
                action={action}
                notify={notify}
              />
            ))}
          </div>
        </>
      )}
      {invite && (
        <InviteEditor
          data={data}
          action={action}
          onClose={() => setInvite(false)}
        />
      )}{" "}
      {editing && (
        <MemberEditor
          member={editing}
          company={data.company.name}
          community={isCommunityEdition(data)}
          action={action}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}
// An invitation nobody has taken up yet: who and when on top, what you can do
// under it. One that ran out stays, with Send again, rather than dropping off
// the list without a word. Every button names the address to a screen reader,
// so "Revoke" is never heard on its own.
function InviteRow({ invite: i, data, action, notify }) {
  const who = i.created_by === data.user.id ? "you" : i.invited_by;
  const about = "invite-" + i.id;
  // A link is made only by somebody who may send it, and only the owner
  // invites admins. The server refuses the same.
  const maySend = i.role !== "admin" || data.role === "owner";
  // One send at a time. A second press while the first was on its way found
  // the invitation already replaced, and its "no longer waiting" took the
  // place of the words that said the new link went.
  const [sending, setSending] = useState(false);
  // A date is never split over two lines, "Sep" at the end of one and "15"
  // alone on the next, as it was on a phone.
  const day = (t) => fmtDate(t).replace(/ /g, "\u00a0");
  const takeBack = (
    <button
      type="button"
      className="team-card-quiet"
      aria-describedby={about}
      onClick={() =>
        action(
          () => api("/invites/" + i.id, "DELETE"),
          i.ran_out ? "Invitation removed" : "Invitation revoked",
        )
      }
    >
      {i.ran_out ? "Remove" : "Revoke"}
    </button>
  );
  return (
    <div className={"member-row invite-row" + (i.ran_out ? " ran-out" : "")}>
      <span className="invitation-icon">
        {i.ran_out ? <Clock size={18} /> : <Link size={18} />}
      </span>
      <span>
        <strong id={about}>{i.email}</strong>
        {i.ran_out ? (
          <small>
            <span className="invite-ran-out">Ran out on {day(i.expires)}</span>{" "}
            · invited by {who} on {day(i.created)}
          </small>
        ) : (
          <small>
            Invited by {who} on {day(i.created)} · works until {day(i.expires)}
          </small>
        )}
      </span>
      <span className="pill team-role">{i.role}</span>
      {maySend ? (
        <div className="invite-do">
          {!i.ran_out && !!i.link_kept && (
            <CopyInviteLink invite={i} about={about} notify={notify} />
          )}
          <Button
            className="secondary small"
            aria-describedby={about}
            busy={sending}
            onClick={async () => {
              setSending(true);
              await action(
                () => api("/invites/" + i.id + "/again", "POST", {}),
                `Sent a new link to ${i.email}. The old one no longer works.`,
              );
              setSending(false);
            }}
          >
            {!sending && <RotateCw size={15} />}
            Send again
          </Button>
          {takeBack}
        </div>
      ) : (
        // Revoke is all there is, so it sits beside the role rather than
        // alone at the end of an empty line under it.
        takeBack
      )}
    </div>
  );
}
// Copy link asks the server for the link at the moment it is pressed, and
// straight away rather than through action(): a refresh between the press
// and the clipboard can outlast the browser's patience for writing to it.
function CopyInviteLink({ invite, about, notify }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      className="secondary small"
      aria-describedby={about}
      onClick={async () => {
        let url;
        try {
          url = (await api("/invites/" + invite.id + "/link")).url;
        } catch (e) {
          return notify(e.message);
        }
        try {
          await navigator.clipboard.writeText(url);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        } catch {
          window.prompt("Copy this link", url);
        }
      }}
    >
      {copied ? <Check size={15} /> : <Copy size={15} />}
      {copied ? "Copied" : "Copy link"}
    </Button>
  );
}
function InviteEditor({ data, action, onClose }) {
  const [url, setUrl] = useState(null);
  const [busy, setBusy] = useState(false);
  return (
    <Modal title="Invite a human teammate" onClose={onClose}>
      {url ? (
        <>
          <div className="success-icon">
            <Check size={25} />
          </div>
          <h3>Their place in the flock is ready.</h3>
          <p>
            We have emailed them the invitation. It is tied to their email
            address and expires in seven days. The link is here too, if you
            would rather send it yourself.
          </p>
          <div className="link-display">{url}</div>
          <CopyButton value={url} />
        </>
      ) : (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            const r = await action(() =>
              api(
                "/invites",
                "POST",
                Object.fromEntries(new FormData(e.currentTarget)),
              ),
            );
            setBusy(false);
            if (r) setUrl(r.url);
          }}
        >
          <Field label="Email address">
            <input
              name="email"
              type="email"
              required
              placeholder="teammate@company.com"
              autoFocus
            />
          </Field>
          {/* Only the owner can change people once they are in. An admin was
              told it could, and then found no button to do it with. */}
          <Field
            label="Company role"
            hint={
              data.role === "owner"
                ? "You can adjust individual permissions after they join."
                : "Only " +
                  ownerName(data) +
                  " can change what they may do after they join."
            }
          >
            <select name="role" defaultValue="member">
              <option value="member">
                Member — chat, tasks, and documents
              </option>
              <option value="viewer">Viewer — read-only access</option>
              {data.role === "owner" && (
                <option value="admin">
                  Admin — run the flock and invite people
                </option>
              )}
            </select>
          </Field>
          <div className="info-box">
            <Users size={19} />
            <span>
              There is nothing for them to set up. Everybody here shares this
              company’s ducks, knowledge and AI connection.
            </span>
          </div>
          <div className="modal-actions">
            <Button busy={busy}>
              Create invitation link <ArrowRight size={16} />
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}
// The switch Settings > Ducks shipped, drawn again here: a track and a knob
// over the real tick box, so Tab and Space still work and it is still
// announced as on or off.
function PermissionSwitch({ checked, label, onChange }) {
  return (
    <span className="mp-switch">
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        aria-label={label}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="mp-track" aria-hidden="true" />
    </span>
  );
}
// The way back for a teammate who has lost their phone and their backup
// codes. Nobody but the owner can let them in again, so it sits with
// everything else the owner decides about them, and only for somebody who has
// it on: the server tells only the owner who that is.
function TeammateTwoStep({ member, action }) {
  const [sure, setSure] = useState(false);
  const [off, setOff] = useState(false);
  const yes = useRef(null);
  const ask = useRef(null);
  const done = useRef(null);
  // Keep it on takes the question away, so the keyboard goes back to the
  // button that asked it.
  const kept = useRef(false);
  useEffect(() => {
    if (sure || !kept.current) return;
    kept.current = false;
    ask.current?.focus();
  }, [sure]);
  // The button that was pressed has gone, and the one that does it came up
  // half hidden under the dialog's Save bar, which stays stuck to its bottom.
  // Focus alone, or scrolling it just into the dialog, leaves it there, so it
  // is brought up to the middle; then the keyboard goes to it.
  useEffect(() => {
    if (!sure) return;
    yes.current?.scrollIntoView({ block: "center" });
    yes.current?.focus({ preventScroll: true });
  }, [sure]);
  // The buttons are gone once it is off, and the keyboard with them: it goes
  // to the words that say so.
  useEffect(() => {
    if (off) done.current?.focus();
  }, [off]);
  if (off || !member.two_step)
    return (
      <div className="mp-two-step">
        <b>Two-step sign-in</b>
        <span ref={done} tabIndex={-1}>
          Off. {member.name} can sign in again without a code.
        </span>
      </div>
    );
  return (
    <div className="mp-two-step">
      <b>Two-step sign-in</b>
      <span>
        If {member.name} has lost their phone and their backup codes, turn it
        off so they can sign in again.
      </span>
      {sure ? (
        <div className="confirm-box">
          {/* The words on /enter send a locked-out teammate to the owner,
              and whoever has broken into the teammate's mailbox can send
              that request too. */}
          <p>
            Turn off two-step sign-in for {member.name}? Only do this if they
            asked you in person or on a call, not by email or chat. We email
            them that you did.
          </p>
          <div className="mp-two-step-sure">
            <Button
              ref={yes}
              className="danger-button"
              onClick={async () => {
                const r = await action(
                  () => api("/members/" + member.id + "/two-step", "DELETE"),
                  "Two-step sign-in is off for " + member.name + ".",
                );
                if (r) setOff(true);
              }}
            >
              Turn it off
            </Button>
            <Button
              className="secondary"
              onClick={() => {
                kept.current = true;
                setSure(false);
              }}
            >
              Keep it on
            </Button>
          </div>
        </div>
      ) : (
        <Button ref={ask} className="secondary" onClick={() => setSure(true)}>
          Turn off their two-step sign-in
        </Button>
      )}
    </div>
  );
}
function MemberEditor({ member, company, community = false, action, onClose }) {
  // What this person may do now: the answers their role fills in, with
  // anything set by hand on top of them.
  const saved = {
    role: member.role,
    perms: asAnswers({
      ...ROLE_DEFAULTS[member.role],
      ...JSON.parse(member.permissions),
    }),
  };
  const [role, setRole] = useState(saved.role);
  const [perms, setPerms] = useState(saved.perms);
  // Once turned off, the team list no longer says they have it, and the part
  // would go before it could say it is off.
  const [hadTwoStep] = useState(!!member.two_step);
  // What the switches were before the last role press, and the line that says
  // what that press did. Picking a role used to rewrite all eleven in silence.
  const [undo, setUndo] = useState(null);
  const [confirm, setConfirm] = useState(false);
  const roleLabel = useId();
  const changed =
    role !== saved.role ||
    JSON.stringify(perms) !== JSON.stringify(saved.perms);
  function pickRole(next) {
    if (next === role) return;
    const filled = filledBy(next);
    const said = afterRole(next, perms, filled);
    // A press that moves nothing has nothing to say and nothing to put back.
    setUndo(said ? { said, role, perms } : null);
    setRole(next);
    setPerms(filled);
  }
  function setOne(key, on) {
    // The undo line names a list of switches. Set one by hand and that list is
    // no longer what is on the screen, so the offer goes with it.
    setUndo(null);
    setPerms({ ...perms, [key]: on });
  }
  return (
    <Modal
      ariaLabel={"What " + member.name + " may do"}
      title={
        <span className="mp-who">
          <Avatar name={member.name} size={38} />
          <span className="mp-who-lines">
            <span className="mp-who-name">What {member.name} may do</span>
            <small>{member.email}</small>
          </span>
        </span>
      }
      onClose={onClose}
      // Nothing here is saved until Save changes, so a stray Escape or a click
      // beside the dialog used to throw away every switch just set.
      closeGuard={() =>
        !changed ||
        window.confirm(
          "Close without saving? These switches will stay as they were.",
        )
      }
    >
      <div className="member-perms">
        <div className="mp-role">
          <span className="mp-label" id={roleLabel}>
            Role
          </span>
          <div className="mp-seg" role="group" aria-labelledby={roleLabel}>
            {ROLES.map((r) => (
              <button
                key={r.value}
                type="button"
                aria-pressed={role === r.value}
                onClick={() => pickRole(r.value)}
              >
                {role === r.value && <Check size={15} aria-hidden="true" />}
                {r.name}
              </button>
            ))}
          </div>
          {undo ? (
            <p className="mp-undo" role="status">
              <CircleCheck size={15} aria-hidden="true" />
              <span>{undo.said}</span>
              <button
                type="button"
                onClick={() => {
                  setRole(undo.role);
                  setPerms(undo.perms);
                  setUndo(null);
                }}
              >
                Put them back
              </button>
            </p>
          ) : (
            <p className="mp-note">
              A role fills the list in; you can change any line after.
            </p>
          )}
        </div>
        <div className="mp-card">
          {MEMBER_GROUPS.map((group) => (
            <div className="mp-group" key={group.name}>
              <span className="mp-group-head">
                <b>{group.name}</b>
                {group.help && <span>{group.help}</span>}
              </span>
              {group.permissions
                .filter((p) => !(community && p.key === "billing"))
                .map((p) => (
                  <label className="mp-row" key={p.key}>
                    <span className="mp-row-text">
                      <b>{p.name}</b>
                      <span>{helpFor(p, company)}</span>
                    </span>
                    <span className="mp-row-end">
                      <PermissionSwitch
                        checked={!!perms[p.key]}
                        label={member.name + ": " + p.said}
                        onChange={(on) => setOne(p.key, on)}
                      />
                      <span className={"mp-word" + (perms[p.key] ? " on" : "")}>
                        {perms[p.key] ? ON : OFF}
                      </span>
                    </span>
                  </label>
                ))}
            </div>
          ))}
        </div>
        {(member.two_step || hadTwoStep) && (
          <TeammateTwoStep member={member} action={action} />
        )}
      </div>
      {confirm && (
        <div className="confirm-box">
          <p>
            Remove {member.name} from this company? Their active sessions and
            runs will be stopped.
          </p>
          <Button
            className="danger-button"
            onClick={async () => {
              const r = await action(() =>
                api("/members/" + member.id, "DELETE"),
              );
              if (r) onClose();
            }}
          >
            Remove teammate
          </Button>
        </div>
      )}
      <div className="modal-actions mp-actions">
        <button
          type="button"
          className="mp-remove"
          onClick={() => setConfirm(true)}
        >
          Remove from {company}
        </button>
        <Button
          onClick={async () => {
            const r = await action(
              () =>
                api("/members/" + member.id, "PATCH", {
                  role,
                  permissions: asAnswers(perms),
                }),
              "Permissions saved",
            );
            if (r) onClose();
          }}
        >
          Save changes
        </Button>
      </div>
    </Modal>
  );
}
