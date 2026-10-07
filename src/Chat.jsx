import { WorkCard } from "./WorkCard.jsx";
import { DuckConsultations } from "./DuckConsultations.jsx";
import { draftKey, keptDraft, keepDraft, sweepDrafts } from "./drafts.mjs";
import { HumanInputCard } from "./HumanInput.jsx";
import { QueueReason } from "./QueueReason.jsx";
import { queueReason } from "./queue-reason.mjs";
import { SkillProposalCard } from "./SkillProposals.jsx";
import { BoardProposalCard } from "./BoardProposals.jsx";
import { ScheduleProposalCard } from "./ScheduleProposals.jsx";
import { ConnectionAskCard, ToolAskCard } from "./AskCard.jsx";
import { modelLabel } from "./AISettings.jsx";
import { whoStopped, STOPPED_TAIL } from "./stopped-words.mjs";
import React, { useState, useEffect, useRef } from "react";
import {
  MessageSquare,
  Monitor,
  FileText,
  Columns3,
  Users,
  Sparkles,
  ArrowRight,
  Loader2,
  RotateCcw,
  CircleAlert,
  Square,
  ChevronUp,
  Check,
  X,
  ArrowUpRight,
  Link,
  Files,
  Paperclip,
  TriangleAlert,
  Workflow,
  Clock,
  Plug,
  Webhook,
  ArrowDown,
} from "lucide-react";
import {
  api,
  Avatar,
  Button,
  IconButton,
  Markdown,
  fmtTime,
  atWhen,
  fmtWhen,
  flock,
} from "./ui.jsx";
import { ChatArtifacts, DocumentPicker, FileNotices } from "./Attachments.jsx";
import { FileIcon, formatBytes, uploadUrl } from "./file-ui.jsx";
import { aiDown, withoutDuckAI } from "../shared/ai-access.mjs";
import "./ticket-documents.css";
// Drafts for chats nobody reopened, once per page load.
sweepDrafts();
const MAX_UPLOAD = 25 * 1000 * 1000;
// What the server will take. Kept here so the composer can say so in time.
const MESSAGE_LIMIT = 20000;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
import { canArchiveChannel } from "./ChannelArchive.jsx";
import { conversationName, conversationPeer } from "./chat-utils.mjs";
import { routePath } from "./navigation.mjs";
import { hideSilentCompletion } from "./chat-message-visibility.mjs";
import {
  reasonFor,
  bodyIsTheReason,
  explain,
  retryOf,
  laterRunOf,
} from "./run-failure.mjs";
import {
  answeringNow,
  duckIdsFor,
  firstAnswer,
  hasPicker,
  isAnswered,
  rememberAnswer,
  runMinutes,
  runSentences,
  sendLabelFor,
} from "./composer-choice.mjs";
import {
  createScreenshotQueue,
  fetchScreenshot,
} from "./screenshot-loader.mjs";
import "./threads.css";
import { projectAcceptedSteers } from "./chat-message-order.mjs";
import "./composer.css";
import "./run-failure.css";
import "./chat-latest.css";
import { RecoveryStatus as SharedRecoveryStatus } from "./RecoveryStatus.jsx";
// A machine that is on and can be photographed. Same three the Computers
// page uses; a stopped one has only its last saved picture.
// A phone keyboard has no Shift+Return, so on a touch device "Enter to send"
// leaves no way at all to type a second line: the half-written message goes the
// moment somebody reaches for the next one. Return makes a new line there and
// the send button sends, which is what every phone chat does - and what the
// ticket box in this same product already did, so two text boxes were answering
// the same key in opposite ways.
const touchOnly =
  typeof window !== "undefined" &&
  window.matchMedia &&
  window.matchMedia("(hover: none) and (pointer: coarse)").matches;
const screenLive = ["ready", "idle", "running"];
// A desktop nothing has been done to for this long is not a picture of what the
// duck is doing. It is the last thing it did there - or, on a computer that has
// just been resumed, the last thing it did days ago in some other task.
const STILL_MS = 30000;
const howLong = (ms) => {
  const minutes = Math.round(ms / 60000);
  return minutes < 1
    ? "under a minute"
    : minutes === 1
      ? "a minute"
      : minutes + " minutes";
};
// Half-written messages, by conversation and thread, kept for as long as the
// page is open. Not storage: these hold uploads somebody has already made,
// and they belong to this session and nowhere else.
// Which day a message belongs to. Today and yesterday are named, because that
// is how people talk about them; anything older gets its date, with the year
// once it is not this one.
const dayLabel = (created) => {
  const when = new Date(created),
    today = new Date();
  const day = (d) => d.toDateString();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (day(when) === day(today)) return "Today";
  if (day(when) === day(yesterday)) return "Yesterday";
  return when.toLocaleDateString([], {
    day: "numeric",
    month: "short",
    ...(when.getFullYear() === today.getFullYear() ? {} : { year: "numeric" }),
  });
};
// Why a reply stopped mid-air with nothing written in it. Somebody opening the
// duck's screen pauses its run, and that reads very differently from the duck
// asking for something, so say which it was.
const pausedBecause = (requests, m, data) => {
  const mine = requests.find((r) => r.job_id || r.message_id === m.id);
  if (mine?.kind === "takeover")
    return "Stopped here while you have the computer. It carries on when you hand the screen back.";
  if (mine) return "Stopped here. Your duck is waiting for you on the screen.";
  if (m.waiting_for && m.waiting_for !== data.user.id)
    return "Stopped here, waiting for a teammate.";
  return "Stopped here, waiting for a person.";
};
// No "cancelled" here any more. A stopped run is told by the line at the foot
// of its own card, which also says who stopped it, and this one only repeated
// the weaker half of that. The state never reaches here now, and a sentence
// kept for a state that cannot arrive is the kind that gets read as live.
const endedWithout = (state) =>
  state === "steered"
    ? "Replaced by what you said next."
    : state === "error"
      ? "This run ended with an error."
      : "This run ended without a reply.";
// What a schedule sent when its turn came round. The duck gets the whole
// standing instruction, but nobody wants to read it again every five minutes,
// and it is not something the person typed, so it shows as one quiet line.
function ScheduleRequest({ message: m, go }) {
  const s = m.schedule;
  return (
    <div className="schedule-request">
      <p>
        {s?.title && s?.how_often ? (
          <>
            <strong>{s.title}</strong> · {s.how_often}
            {s.removed && <> · This scheduled task was removed.</>}
          </>
        ) : (
          "A scheduled job came round."
        )}
      </p>
      <div className="schedule-request-actions">
        {s?.id && !s.removed && (
          <Button
            className="secondary small"
            onClick={() =>
              go({ type: "tasks", scheduled: true, scheduleId: s.id })
            }
          >
            Open schedules <ArrowUpRight size={14} />
          </Button>
        )}
      </div>
      <details>
        <summary>Show what the duck was asked</summary>
        <pre>{m.body}</pre>
      </details>
    </div>
  );
}
// A preview refresh is a separate image request so the old, known-good frame
// can stay on screen until the new one has decoded. Setting an <img>'s src
// directly made an intermittent 404 or an in-flight replacement show the
// browser's broken-image icon in the middle of a chat.
//
// request: the picture is inside a "Needs you" card, beside the button that
// opens the screen for it. It then opens that same request, and is labelled as
// whose screen it is rather than how fresh the picture is.
export function ChatScreenShot({
  screen,
  duck,
  frame,
  screenStill,
  go,
  request = null,
}) {
  const [shown, setShown] = useState(null);
  const [unavailable, setUnavailable] = useState(false);
  const queue = useRef(null);
  useEffect(() => {
    const loader = createScreenshotQueue({
      load: fetchScreenshot,
      onLoad: (url) => {
        setShown(url);
        setUnavailable(false);
      },
      onError: () => setUnavailable(true),
    });
    queue.current = loader;
    return () => loader.cancel();
  }, []);
  const source =
    "/api/computers/" +
    screen.id +
    "/screenshot?v=" +
    encodeURIComponent(
      screen.human_control || !screen.photographing
        ? screen.screenshot_at
        : frame,
    );
  useEffect(() => {
    queue.current.schedule(source);
  }, [source]);
  // A saved frame may have a fixed URL and no active polling. Retry an
  // unavailable frame too, so a transient error can recover without a reload.
  useEffect(() => {
    if (!unavailable || screen.photographing) return;
    const retry = setInterval(() => queue.current.schedule(source), 3000);
    return () => clearInterval(retry);
  }, [unavailable, screen.photographing, source]);
  const status = unavailable
    ? shown
      ? "Latest picture is temporarily unavailable — showing the last saved picture"
      : "Screen preview is temporarily unavailable"
    : !shown
      ? "Loading screen preview"
      : screen.human_control
        ? "Somebody is on this screen"
        : !screen.photographing
          ? "The last picture of this screen"
          : screenStill
            ? "Nothing has changed here for " + howLong(screenStill)
            : "Live \u00b7 a new picture every second";
  const name = duck?.name || "the duck";
  return (
    <button
      type="button"
      className="chat-screen-shot"
      aria-label={"Open " + name + "'s screen"}
      onClick={() =>
        go({
          type: "computers",
          id: screen.id,
          control: true,
          // A picture beside a duck's ask is the way to answer it on screen.
          ...(request ? { requestId: request.id, take: true } : {}),
        })
      }
    >
      {shown ? (
        <img
          src={shown}
          alt={
            screenStill
              ? "The last thing " + name + " did on this screen"
              : "What " + name + " is looking at"
          }
        />
      ) : (
        <div
          className="chat-screen-unavailable"
          role="img"
          aria-label={unavailable ? status : "Loading screen preview"}
        />
      )}
      {/* In a "Needs you" card it says whose screen it is. On a duck's
          progress card it is the one way in, and says so: the freshness it used
          to announce there ("Live", "Nothing has changed here for 10 minutes")
          sat beside "Working" and disagreed with it. */}
      <span>
        {!request ? (
          <>
            <Monitor size={14} aria-hidden="true" /> Open screen
          </>
        ) : shown && !unavailable ? (
          (duck?.name || "The duck") + "'s screen"
        ) : (
          status
        )}
      </span>
    </button>
  );
}
// The duck's terminal, in the chat, next to the picture of its screen.
//
// It asks for its own data rather than riding the workspace payload: command
// output is long, this is one message out of a whole transcript, and that
// payload is fetched by every open tab about once a second.
// What a connected service answered after somebody approved the call. The duck
// reads all of it; a person gets the first line and can open the rest, because
// whoever pressed Approve did not write the JSON underneath it.
function ToolResult({ message: m }) {
  const [first, ...rest] = (m.body || "").split("\n\n");
  const payload = rest.join("\n\n").trim();
  return (
    <div className="schedule-request">
      <Markdown>{first}</Markdown>
      {payload && (
        <details>
          <summary>Show what the service sent back</summary>
          <pre>{payload}</pre>
        </details>
      )}
    </div>
  );
}
// A request the workflow wrote for a ticket run. The duck gets the full text;
// people see what was asked and can open the ticket.
function WorkflowRequest({ message: m, go }) {
  const w = m.workflow;
  return (
    <div className="workflow-request">
      <p>
        {w ? (
          <>
            Asked <strong>{w.duck_name}</strong> to{" "}
            {w.role === "reviewer" ? "review" : "work on"}{" "}
            <strong>{w.title}</strong> · {w.stage}
            {w.revision > 1 ? " · attempt " + w.revision : ""}
          </>
        ) : (
          "Asked a duck to work on a ticket."
        )}
      </p>
      <div className="workflow-request-actions">
        {w && (
          <Button
            className="secondary small"
            onClick={() =>
              go({ type: "tasks", boardId: w.board_id, id: w.task_id })
            }
          >
            Open ticket <ArrowUpRight size={14} />
          </Button>
        )}
        {m.user_name && <small>Runs with {m.user_name}’s AI connection</small>}
      </div>
      <details>
        <summary>Show full instructions</summary>
        <pre>{m.body}</pre>
      </details>
    </div>
  );
}
export default function Chat(props) {
  const [narrow, setNarrow] = useState(
    () => window.matchMedia("(max-width: 1100px)").matches,
  );
  useEffect(() => {
    const media = window.matchMedia("(max-width: 1100px)");
    const change = () => setNarrow(media.matches);
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  const openThread = (id) =>
    props.go({ type: "chat", id: props.conversation.id, threadId: id });
  const closeThread = () =>
    props.go({ type: "chat", id: props.conversation.id });
  // Kept outside the component. App keys this whole view by conversation, so
  // switching channel remounts it - and the Files and Tasks tabs unmount it
  // altogether. A half-written message, and any files already uploaded with it,
  // went every time, with nothing said. src/drafts.mjs outlives all of that,
  // and a Refresh as well.
  const keyFor = (thread) =>
    draftKey(props.data.user.id, props.conversation.id, thread);
  const updateDraft = (key, value) => keepDraft(keyFor(key), value);
  return (
    <div className={"chat-workspace " + (props.threadId ? "has-thread" : "")}>
      <div className="chat-main-pane" hidden={!!props.threadId && narrow}>
        <ChatPane
          {...props}
          threadId={null}
          // A reply found by search: the chat beside its thread shows the
          // message it answers - unless the thread covers it, on a phone.
          focus={
            props.at && (!props.threadId ? props.at : !narrow && props.threadId)
          }
          visible={!props.threadId || !narrow}
          openThread={openThread}
          savedDraft={keptDraft(keyFor("main"))}
          saveDraft={(value) => updateDraft("main", value)}
        />
      </div>
      {props.threadId && (
        <aside className="thread-pane" aria-label="Message thread">
          <header className="thread-header">
            <div>
              <h2>Thread</h2>
              <span>{conversationName(props.conversation, props.data)}</span>
            </div>
            <IconButton
              icon={Link}
              label="Copy thread link"
              onClick={() =>
                navigator.clipboard
                  .writeText(
                    window.location.origin +
                      routePath({
                        companyId: props.data.company.id,
                        type: "chat",
                        id: props.conversation.id,
                        threadId: props.threadId,
                      }),
                  )
                  .then(() => props.notify("Thread link copied"))
                  .catch(() =>
                    props.notify("Copy the thread URL from your address bar."),
                  )
              }
            />
            <IconButton icon={X} label="Close thread" onClick={closeThread} />
          </header>
          <ChatPane
            {...props}
            key={props.threadId}
            focus={props.at}
            visible
            openThread={openThread}
            savedDraft={keptDraft(keyFor(props.threadId))}
            saveDraft={(value) => updateDraft(props.threadId, value)}
          />
        </aside>
      )}
    </div>
  );
}
function RecoveryStatus({ job, data, action }) {
  return <SharedRecoveryStatus recovery={job?.recovery} data={data} action={action} />;
}

// A run that stopped before it was done, told the way the "Needs you" card
// tells it: the word on a band, the reason as a headline, and one thing to
// press. It used to be a pink wash over the whole row with a second pink box
// inside it, 1.034:1 apart, and an 11px "Retry" sitting at the end of a
// sentence like its last two words. Nothing on it said the work had failed,
// and the duck's own sentence was repainted the same pink as the machine's
// warning, so nobody could tell what the duck said from what the system
// printed.
function RunFailure({
  m,
  job,
  duck,
  data,
  action,
  go,
  screenShown,
  conversation,
}) {
  // Five failures in one morning is five cards down the chat. This is the way
  // to put one away that does not pretend the work succeeded - and it is only
  // this screen, for now: nothing on the server remembers it.
  const [hidden, setHidden] = useState(false);
  // Folding the card takes away the button the keyboard was standing on, and
  // focus then falls back to the top of the document - so somebody working by
  // keyboard had to walk the whole page to get back to where they were. Hand
  // it to the line that takes the card's place, and back into the card when
  // the card comes back.
  const handOver = useRef(false),
    card = useRef(null),
    folded = useRef(null);
  useEffect(() => {
    if (!handOver.current) return;
    handOver.current = false;
    (hidden ? folded.current : card.current?.querySelector("button"))?.focus();
  }, [hidden]);
  const name = m.duck_name || duck?.name || "The duck";
  // The workspace's newest runs, and the later runs of this same request that
  // came with the message - for an older failure, whose retry has long since
  // fallen off that list and would otherwise not be seen at all.
  const known = [
    ...data.jobs,
    ...(m.later_runs || []).filter(
      (r) => !data.jobs.some((j) => j.id === r.id),
    ),
  ];
  const again = retryOf(job, known);
  // Tried again already, and that try has finished: this one is dealt with.
  // Whatever happened next is its own message further down.
  const tried = again ? null : laterRunOf(job, known);
  // The server lets only the person who started a run try it again, and said
  // so by quietly leaving the button out. The foot says it in words now.
  const mine = job?.user_id === data.user.id;
  const starter = (data.members || []).find((u) => u.id === job?.user_id);
  // Nobody can try again where the duck could not answer: in an archived
  // channel, or one it has been taken out of. The server refuses both, and the
  // card says why instead of offering the button.
  const shut = conversation?.archived
    ? "The channel is archived, so this cannot be tried again here."
    : conversation?.kind === "group" &&
        job?.duck_id &&
        !conversation.ducks?.includes(job.duck_id)
      ? name +
        " is no longer in this channel, so this cannot be tried again here."
      : "";
  const retry = mine && !shut;
  // What to say about why, from src/run-failure.mjs: the headline, one more
  // line if there is one, and raw output to fold away if there is some.
  const reason = reasonFor(job),
    said = explain(reason, name);
  // Only when the activity above this is not already offering the same way in,
  // so a failed message never carries two doors to one screen.
  const computer =
    !screenShown &&
    data.permissions.computers &&
    data.computers?.items.find((c) => c.duck_id === m.duck_id);
  if (tried)
    return (
      <p className="run-failure-quiet">
        <span>
          {name} couldn't finish, and was tried again {atWhen(tried.created)}.
          What happened next is further down.
        </span>
      </p>
    );
  if (hidden && !again)
    return (
      <p className="run-failure-quiet">
        <span>{name} couldn't finish.</span>
        <button
          type="button"
          className="run-failure-out"
          ref={folded}
          onClick={() => {
            handOver.current = true;
            setHidden(false);
          }}
        >
          Show what happened
        </button>
      </p>
    );
  return (
    <section
      className={"run-failure" + (again ? " again" : "")}
      ref={card}
      aria-label={
        again ? name + " is trying again" : name + " could not finish"
      }
    >
      <p className="run-failure-band">
        {again ? (
          <>
            <RotateCcw className="spin" size={14} /> Trying again
          </>
        ) : (
          <>
            <CircleAlert size={14} /> Couldn't finish
          </>
        )}
      </p>
      <div className="run-failure-main">
        {!again && <h4 className="run-failure-title">{said.headline}</h4>}
        <p className="run-failure-said">
          {again
            ? name + " started again " + atWhen(again.created) + "."
            : (said.rest ? said.rest + " " : "") +
              "That was " +
              atWhen(m.created) +
              "." +
              (said.detail ? " " + said.detail : "")}
        </p>
        {/* A page of output, which is what most of what throws really is: the
            server keeps a thousand characters of it. Set as running text one
            of those made the card 467px tall on a phone, with the one thing to
            press below the fold - so it goes behind a line that says what is
            behind it, where the rest of the app puts its raw text, and comes
            back whole, line breaks and all. */}
        {!again && said.folded && (
          <details className="run-failure-more">
            <summary>Show the error</summary>
            <p>{said.folded}</p>
          </details>
        )}
        {!again && (retry || computer) && (
          <div className="run-failure-row">
            {retry && (
              <Button
                onClick={() =>
                  action(() => api("/jobs/" + job.id + "/retry", "POST", {}))
                }
              >
                <RotateCcw size={15} /> Try again
              </Button>
            )}
            {computer && (
              <button
                type="button"
                className="run-failure-open"
                onClick={() => go({ type: "computers", id: computer.id })}
              >
                <Monitor size={14} /> Open {name}'s screen
              </button>
            )}
          </div>
        )}
      </div>
      <div className="run-failure-foot">
        <span>
          {again
            ? "It hit a problem once already."
            : shut && job
              ? shut
              : !job || mine
                ? "Anything it finished before this is saved."
                : "Only " +
                  (starter?.name || "the person who started it") +
                  " can try this again."}
        </span>
        {again ? (
          (again.user_id === data.user.id || data.permissions.company) && (
            <button
              type="button"
              className="run-failure-out stop"
              onClick={() =>
                action(
                  () => api("/jobs/" + again.id + "/cancel", "POST", {}),
                  "Run stopped",
                )
              }
            >
              Stop
            </button>
          )
        ) : (
          <button
            type="button"
            className="run-failure-out"
            onClick={() => {
              handOver.current = true;
              setHidden(true);
            }}
          >
            Leave it for now
          </button>
        )}
      </div>
    </section>
  );
}
function ChatPane({
  conversation,
  threadId,
  visible,
  openThread,
  savedDraft,
  saveDraft,
  data,
  eventVersion,
  action,
  notify,
  go,
  setModal,
  latest,
  focus,
  seek,
}) {
  const [messages, setMessages] = useState([]);
  // How far back this screen has asked to see. The transcript stopped at the
  // newest thousand with nothing said and no way back, so a chat that had been
  // going for a year simply began in the middle.
  const [reach, setReach] = useState(1000);
  // Ticks once a second so a duck's screen in chat keeps up with what it is
  // doing. The picture itself answers 304 when it has not changed, so this
  // costs a few bytes rather than a reload of the whole workspace.
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => {
      if (!document.hidden) setFrame((n) => n + 1);
    }, 1000);
    return () => clearInterval(timer);
  }, []);
  const [draft, setDraft] = useState(savedDraft?.body || "");
  const [attachedDocs, setAttachedDocs] = useState(savedDraft?.documents || []);
  const [attachmentPicker, setAttachmentPicker] = useState(false);
  // Files upload as soon as they are picked; sending attaches the finished ones.
  const [uploads, setUploads] = useState(savedDraft?.files || []);
  const [dragging, setDragging] = useState(false);
  const transfers = useRef(new Map());
  const fileInput = useRef();
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [parent, setParent] = useState(null);
  const [loadError, setLoadError] = useState("");
  const [atBottom, setAtBottom] = useState(true);
  const [foreground, setForeground] = useState(
    document.visibilityState === "visible",
  );
  const readIds = useRef(new Set());
  const [ai, setAI] = useState(null);
  // Counts up each time the AI's status should be asked again.
  const [askAI, setAskAI] = useState(0);
  // Who answers in this conversation. In a channel it is nothing at all until
  // somebody says - the whole point of the bar - and what they said last time
  // is where it starts. A direct chat with a duck is not a question: that duck
  // answers. A chat between people has nobody to ask.
  const [selected, setSelected] = useState(() => firstAnswer(conversation));
  // Which of the bar's two lists is open, if either.
  const [openList, setOpenList] = useState("");
  // Whether the who-answers list was opened by somebody trying to send. Picking
  // then finishes what they started, rather than making them press Send twice.
  const sendAfterPick = useRef(false);
  const bar = useRef();
  const openMenu = useRef();
  const scroller = useRef();
  const bottom = useRef();
  const follow = useRef(true);
  // Where somebody left off: the first message they had not read when the
  // chat opened. It gets a "New" line, and the chat opens there rather than at
  // the bottom, which used to mark twenty messages read at once with nothing
  // to show where the new ones began. Fixed for the visit, so the line does
  // not move while they read.
  const [leftOff, setLeftOff] = useState(null);
  const landed = useRef(false);
  const newLine = useRef();
  // The message that was at the top before older ones arrived, so the screen
  // can put it back where the person was reading rather than jumping.
  const wasTop = useRef(null);
  const textarea = useRef();
  // Who can be asked to do something here. A duck taken off the team keeps its
  // place in the conversation - so that putting it back puts it back here too,
  // and so its old messages still read correctly - but it is not somebody you
  // can address any more.
  const ducks = flock(data).filter((d) => conversation.ducks.includes(d.id));
  const group = conversation.kind === "group";
  const human = conversation.kind === "human";
  // A direct chat with a duck that has been taken off the team. It is nobody's
  // to address any more, but it is still the duck's chat: the name, the face
  // and every message stay, so this reads as a chat with somebody who has
  // gone rather than as a broken screen with no title.
  const gone =
    !group && !human && !ducks.length
      ? data.ducks.find((d) => conversation.ducks.includes(d.id))
      : null;
  const lead = ducks[0] || gone;
  const peer = conversationPeer(conversation, data);
  const picker = hasPicker(conversation, ducks);
  const chosen = isAnswered(selected, ducks);
  const answering = answeringNow(conversation, ducks, selected);
  const asksDuck = !!ducks.length && answering !== "none";
  const unavailable = (human && !peer) || !!gone;
  const rawDisplayed = threadId && parent ? [parent, ...messages] : messages;
  const displayed = projectAcceptedSteers(rawDisplayed, [
    ...(data.jobs || []),
    ...rawDisplayed.map((message) => message.run).filter(Boolean),
  ]);
  // Something somebody else said, finished, that this person could still need
  // to read.
  const notifiable = (m) =>
    m.user_id !== data.user.id &&
    (["error", "cancelled"].includes(m.state) ||
      (m.state === "sent" &&
        (m.body ||
          m.needs_you ||
          (!m.duck_id && m.artifacts?.some((a) => a.verb !== "Viewed")))));
  // How many replies this thread actually shows, so the count and the word
  // agree with each other and with the transcript.
  const shownReplies = messages.filter(
    (r) =>
      !["steered", "steering"].includes(r.state) &&
      !(r.state === "queued" && !r.body && !r.artifacts?.length) &&
      !hideSilentCompletion(r, data),
  ).length;
  useEffect(() => {
    saveDraft({
      body: draft,
      documents: attachedDocs,
      files: uploads.filter((u) => u.status === "ready"),
    });
  }, [draft, attachedDocs, uploads]);
  useEffect(
    () => () => {
      for (const xhr of transfers.current.values()) xhr.abort();
    },
    [],
  );
  const ready = uploads.filter((u) => u.status === "ready");
  const uploading = uploads.some((u) => u.status === "uploading");
  const canAttach =
    data.permissions.chat &&
    !conversation.archived &&
    !unavailable &&
    !(threadId && !parent);
  // Every reason a message cannot go, in one place, so the button and the key
  // cannot come to different conclusions about the same message. Whether the
  // ducks are paused is kept out of it, because that depends on who the message
  // is going to - and that can change in the same press, when somebody answers
  // the who-answers list with "no duck, just people".
  const cannotSend =
    (!draft.trim() && !attachedDocs.length && !ready.length) ||
    uploading ||
    busy ||
    !data.permissions.chat ||
    !!conversation.archived ||
    unavailable ||
    !!(threadId && !parent);
  // Whether the paused flock stops this message. Nobody having said who
  // answers is not the same as asking a duck, so the box stays typable until
  // somebody names one - as it was when a channel simply started on "people
  // only" and nobody could pause a message to a colleague.
  const pausedFor = (who) =>
    !!data.company.paused && !!ducks.length && who !== "none" && who !== null;
  const patchUpload = (key, changes) =>
    setUploads((list) =>
      list.map((u) => (u.key === key ? { ...u, ...changes } : u)),
    );
  // Anywhere else on the page, a dropped file would replace the app with the file.
  useEffect(() => {
    const guard = (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (e.type === "drop") setDragging(false);
    };
    const reset = () => setDragging(false);
    window.addEventListener("dragover", guard);
    window.addEventListener("drop", guard);
    window.addEventListener("dragend", reset);
    return () => {
      window.removeEventListener("dragover", guard);
      window.removeEventListener("drop", guard);
      window.removeEventListener("dragend", reset);
    };
  }, []);
  function droppedFiles(transfer) {
    const items = [...(transfer.items || [])].filter((i) => i.kind === "file");
    if (!items.length) return transfer.files;
    const folders = items.filter((i) => i.webkitGetAsEntry?.()?.isDirectory);
    if (folders.length)
      notify(
        "Folders can't be shared. Zip the folder or drop the files inside it.",
      );
    return items
      .filter((i) => !folders.includes(i))
      .map((i) => i.getAsFile())
      .filter(Boolean);
  }
  function uploadFiles(fileList) {
    const picked = [...(fileList || [])];
    if (!picked.length || !canAttach) return;
    const room = Math.max(0, 10 - uploads.length);
    if (picked.length > room)
      notify("You can share up to 10 files in one message.");
    const added = picked.slice(0, room).map((file) => ({
      key: Math.random().toString(36).slice(2) + Date.now(),
      file,
      name: file.name || "Pasted file",
      size: file.size,
      progress: 0,
      status: file.size > MAX_UPLOAD ? "error" : "uploading",
      error: file.size > MAX_UPLOAD ? "Files can be up to 25 MB." : "",
    }));
    setUploads((list) => [...list, ...added]);
    for (const entry of added.filter((u) => u.status === "uploading")) {
      const xhr = new XMLHttpRequest();
      transfers.current.set(entry.key, xhr);
      xhr.open("POST", "/api/conversations/" + conversation.id + "/uploads");
      xhr.setRequestHeader("Content-Type", "application/octet-stream");
      xhr.setRequestHeader("X-TameDuck", "1");
      xhr.setRequestHeader("X-File-Name", encodeURIComponent(entry.name));
      xhr.upload.onprogress = (e) =>
        e.lengthComputable &&
        patchUpload(entry.key, { progress: e.loaded / e.total });
      xhr.onload = () => {
        transfers.current.delete(entry.key);
        let body = {};
        try {
          body = JSON.parse(xhr.responseText);
        } catch {}
        if (xhr.status === 200)
          patchUpload(entry.key, { ...body, file: null, status: "ready" });
        else
          patchUpload(entry.key, {
            status: "error",
            error:
              body.error ||
              (xhr.status === 413
                ? "This file is too large to upload."
                : "The upload failed. Try again."),
          });
      };
      xhr.onerror = () => {
        transfers.current.delete(entry.key);
        patchUpload(entry.key, {
          status: "error",
          error: "The upload failed. Check your connection and try again.",
        });
      };
      xhr.send(entry.file);
    }
  }
  function removeUpload(entry) {
    transfers.current.get(entry.key)?.abort();
    transfers.current.delete(entry.key);
    if (entry.status === "ready")
      api("/uploads/" + entry.id, "DELETE").catch(() => {});
    setUploads((list) => list.filter((u) => u.key !== entry.key));
  }
  useEffect(() => {
    const changed = () => setForeground(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", changed);
    return () => document.removeEventListener("visibilitychange", changed);
  }, []);
  useEffect(() => {
    if (threadId && parent?.duck_id && group) setSelected(parent.duck_id);
  }, [parent?.id]);
  useEffect(() => {
    if (!visible || !foreground || !loaded || !atBottom) return;
    const unread = displayed
      .filter((m) => notifiable(m) && !readIds.current.has(m.id))
      .slice(-1000)
      .map((m) => m.id);
    if (!unread.length) return;
    unread.forEach((id) => readIds.current.add(id));
    api("/conversations/" + conversation.id + "/read", "POST", {
      message_ids: unread,
    }).catch(() => unread.forEach((id) => readIds.current.delete(id)));
  }, [messages, parent, loaded, visible, foreground, atBottom, eventVersion]);
  const running = data.jobs.filter(
    (j) =>
      j.conversation_id === conversation.id &&
      (j.thread_id || null) === (threadId || null) &&
      ["queued", "running", "waiting_consultation"].includes(j.status),
  );
  // What the bar says while ducks are waiting to work here, and how long the
  // one run has been waiting. Both tick over with `frame`, which the pane
  // already has. A run that is going is not in it: its own card on its own
  // message says so, with its own Stop, and the bar saying it again - "is
  // working · 4 min" under a card saying "Working · 4 min" - was one of six
  // places the same run was being told.
  const waiting = running.filter((j) => j.status !== "running");
  const runWords = runSentences(waiting, data.ducks);
  const minutes = runMinutes(waiting);
  // Every row of the who-answers list, each with its face. One duck in the
  // channel makes "both ducks" meaningless, so it is not offered.
  const answerRows = !picker
    ? []
    : [
        ...ducks.map((d) => ({
          value: d.id,
          label: d.name,
          mark: <Avatar duck={d} size={24} />,
        })),
        ...(ducks.length > 1
          ? [
              {
                value: "all",
                label: ducks.length === 2 ? "Both ducks" : "All ducks",
                mark: (
                  <span className="composer-faces">
                    <Avatar duck={ducks[0]} size={24} />
                    <Avatar duck={ducks[1]} size={24} />
                  </span>
                ),
              },
            ]
          : []),
        {
          value: "none",
          label: "No duck, just people",
          plain: true,
          mark: (
            <span className="composer-tile">
              <Users size={14} />
            </span>
          ),
        },
      ];
  const sendLabel = sendLabelFor(picker, answering, ducks);
  // The bar is dead when the box is: no permission, an archived channel, a
  // teammate who has gone, a thread that has not loaded.
  const barOff =
    !data.permissions.chat ||
    !!conversation.archived ||
    unavailable ||
    !!(threadId && !parent);
  useEffect(() => {
    let live = true;
    api(
      "/conversations/" +
        conversation.id +
        (threadId
          ? "/threads/" + threadId
          : "/messages" + (reach > 1000 ? "?limit=" + reach : "")),
    )
      .then((m) => {
        if (live) {
          if (threadId && m.parent.id !== threadId) {
            go(
              { type: "chat", id: conversation.id, threadId: m.parent.id },
              { replace: true },
            );
            return;
          }
          setMessages(threadId ? m.replies : m);
          if (threadId) setParent(m.parent);
          if (!landed.current) {
            landed.current = true;
            const first = threadId
              ? null
              : m.find((x) => x.unread && notifiable(x));
            // Somebody who came for one message is taken to it, and nothing
            // counts as read until the chat has got there.
            if (first || focus) {
              follow.current = false;
              setAtBottom(false);
            }
            if (first) setLeftOff(first.id);
          }
          setLoadError("");
          setLoaded(true);
        }
      })
      .catch((e) => {
        if (live) {
          setLoadError(e.message);
          setLoaded(true);
        }
      });
    return () => {
      live = false;
    };
  }, [eventVersion, conversation.id, threadId, reach]);
  // A different conversation starts at the newest thousand again.
  useEffect(() => setReach(1000), [conversation.id, threadId]);
  // Older messages push everything down. Without this the view stays at the
  // same pixel and the person is suddenly reading a different day.
  useEffect(() => {
    if (!wasTop.current) return;
    const el = document.querySelector(
      '[data-message-id="' + wasTop.current + '"]',
    );
    wasTop.current = null;
    el?.scrollIntoView({ block: "start", behavior: "instant" });
  }, [messages]);
  useEffect(() => {
    let live = true;
    if (asksDuck)
      api("/ai/status")
        .then((value) => {
          if (live) setAI(value);
        })
        .catch(() => {});
    else setAI(null);
    return () => {
      live = false;
    };
  }, [conversation.id, asksDuck, askAI]);
  // A connection that has dropped usually comes back without anybody doing
  // anything. The banner was only asked once, so it went on saying the AI was
  // not working until the page was reloaded, while Send already worked. So
  // while it says so and the page is being looked at, it asks again.
  const down = asksDuck && aiDown(ai);
  useEffect(() => {
    if (!down || !foreground) return;
    const again = setInterval(() => setAskAI((n) => n + 1), 10000);
    return () => clearInterval(again);
  }, [down, foreground]);
  useEffect(() => {
    if (visible && follow.current)
      bottom.current?.scrollIntoView({ behavior: "instant", block: "end" });
  }, [messages, visible]);
  const nearBottom = () => {
    const x = scroller.current;
    follow.current = !x || x.scrollHeight - x.scrollTop - x.clientHeight < 150;
    setAtBottom(follow.current);
  };
  useEffect(() => {
    // The "New" line still shows where unread begins, but a message
    // somebody came for from search is where the chat opens.
    if (!leftOff || !visible || focus) return;
    newLine.current?.scrollIntoView({ behavior: "instant", block: "start" });
    // A few new messages fit on the screen, and then it is at the bottom
    // after all. Asked here, because a scroll that does not move fires
    // nothing.
    nearBottom();
  }, [leftOff, visible]);
  const toLatest = () => {
    follow.current = true;
    setAtBottom(true);
    bottom.current?.scrollIntoView({ behavior: "instant", block: "end" });
  };
  // The message somebody came to see, from search: scrolled to and marked,
  // each time they pick it. Further back than this screen has loaded, it asks
  // for more first. Gone altogether, the chat opens the way it would anyway.
  const [found, setFound] = useState(null);
  const shown = useRef(null);
  useEffect(() => {
    if (!focus || !loaded || !visible || shown.current === seek) return;
    const el = scroller.current?.querySelector(
      '[data-message-id="' + focus + '"]',
    );
    if (!el && !threadId && messages.length >= reach) {
      setReach((r) => r + 1000);
      return;
    }
    shown.current = seek;
    if (el) {
      follow.current = false;
      el.scrollIntoView({ behavior: "instant", block: "center" });
      setFound(focus);
    } else if (newLine.current)
      newLine.current.scrollIntoView({ behavior: "instant", block: "start" });
    else toLatest();
    nearBottom();
  }, [focus, seek, loaded, visible, messages]);
  // The mark is a moment. Left on, it flashed again every time the chat came
  // back from a thread on a phone. Only its own: an earlier mark's clock can
  // run out just after the next search has marked another message.
  useEffect(() => {
    if (!found) return;
    const timer = setTimeout(
      () => setFound((now) => (now === found ? null : now)),
      2400,
    );
    return () => clearTimeout(timer);
  }, [found]);
  // Clicking the chat you are already in, in the sidebar, takes you to the
  // latest. It did nothing, while its row said "3 new".
  const shownLatest = useRef(latest);
  useEffect(() => {
    if (latest === shownLatest.current) return;
    shownLatest.current = latest;
    if (!threadId) toLatest();
  }, [latest]);
  // What came in while somebody was reading further up. Nothing on the screen
  // said so: the only sign was a count in the sidebar, on the row of the
  // chat they were already in.
  const fresh = atBottom
    ? 0
    : displayed.filter(
        (m) => m.unread && notifiable(m) && !readIds.current.has(m.id),
      ).length;
  // A list opened in the bar takes the keyboard, so Escape and the arrows land
  // in it, and a press anywhere else closes it.
  useEffect(() => {
    if (!openList) return;
    const menu = openMenu.current;
    (
      menu?.querySelector('[aria-pressed="true"]') ||
      menu?.querySelector("button")
    )?.focus();
    const away = (e) => {
      if (!bar.current?.contains(e.target)) closeList();
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [openList]);
  // Leaving the conversation, or opening a thread, leaves nothing hanging open.
  useEffect(() => setOpenList(""), [conversation.id, threadId]);
  function closeList(backTo) {
    sendAfterPick.current = false;
    setOpenList("");
    if (backTo) bar.current?.querySelector('[aria-expanded="true"]')?.focus?.();
  }
  // Escape puts the list away and the keyboard back on the button that opened
  // it; the arrows walk the rows, as they do in any list of choices.
  function listKeys(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeList(true);
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const rows = [...e.currentTarget.querySelectorAll("button")];
    const at = rows.indexOf(document.activeElement);
    const step = e.key === "ArrowDown" ? 1 : -1;
    rows[(at + step + rows.length) % rows.length]?.focus();
  }
  // Somebody has answered the question. It is this channel's answer from now
  // on, and if they were in the middle of sending, the message goes. A thread
  // is a different question - it hangs off one message - so an answer given in
  // one is the thread's alone and does not rewrite the channel's.
  function choose(value, e) {
    setSelected(value);
    if (!threadId) rememberAnswer(conversation.id, value);
    setOpenList("");
    const finish = sendAfterPick.current;
    sendAfterPick.current = false;
    if (finish) send(e, value);
    textarea.current?.focus();
  }
  async function send(e, pick) {
    e?.preventDefault();
    const who = pick === undefined ? answering : pick;
    // There is nothing to send, so there is nothing to ask about either:
    // Enter in an empty box used to open the list and ask who should answer a
    // message nobody had written.
    if (cannotSend) return;
    // Nobody has said who answers in this channel yet. Enter is the quietest
    // way there is to send into the void, so it opens the list as well rather
    // than guessing on somebody's behalf.
    if (picker && who === null) {
      sendAfterPick.current = true;
      setOpenList("who");
      return;
    }
    if (pausedFor(who)) return;
    setBusy(true);
    const body = draft;
    try {
      await api("/conversations/" + conversation.id + "/messages", "POST", {
        body,
        document_ids: attachedDocs,
        upload_ids: ready.map((u) => u.id),
        thread_id: threadId || null,
        duck_ids: duckIdsFor(who, ducks),
      });
      // The box stays open while a message goes, and people carry straight on
      // with the next thought. Emptying it outright threw that away the moment
      // the first one arrived, so only the words that were sent come out.
      setDraft((now) =>
        now === body
          ? ""
          : now.startsWith(body)
            ? now.slice(body.length).replace(/^\s+/, "")
            : now,
      );
      setAttachedDocs([]);
      setUploads((list) => list.filter((u) => u.status === "uploading"));
      follow.current = true;
      // The server asks the AI before it gives a duck a message, so one that
      // went may mean it works again. The banner is asked now rather than
      // left saying otherwise until its next look.
      if (ai?.connected === false) setAskAI((n) => n + 1);
      await action(async () => ({ ok: true }));
    } catch (e) {
      notify(e.message);
      // Any refusal may be the AI: ask again, so the banner says the same as
      // the refusal did - never connected, or connected and down. Asked
      // through the effect, so an answer that arrives after the person has
      // moved to another chat is not shown there.
      if (e.status === 409 && asksDuck) setAskAI((n) => n + 1);
    } finally {
      setBusy(false);
      textarea.current?.focus();
    }
  }
  const noAI = ai?.connected === false ? withoutDuckAI(ai, data) : null;
  return (
    <div
      className={"chat-layout " + (dragging ? "dragging-files" : "")}
      onDragOver={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = canAttach ? "copy" : "none";
        if (canAttach) setDragging(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) setDragging(false);
      }}
      onDrop={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        setDragging(false);
        uploadFiles(droppedFiles(e.dataTransfer));
      }}
    >
      {dragging && (
        <div className="file-drop" aria-hidden="true">
          <Paperclip size={26} />
          <strong>Drop files to share them here</strong>
          <span>Up to 10 files, 25 MB each</span>
        </div>
      )}
      {!threadId && (
        <nav className="channel-tabs" aria-label="Conversation tools">
          <span className="active">
            <MessageSquare size={15} /> Messages
          </span>
          <button
            onClick={() =>
              go(
                conversation.kind === "direct" && lead
                  ? { type: "files", duckId: lead.id }
                  : { type: "files", conversationId: conversation.id },
              )
            }
          >
            <Files size={15} /> Files
          </button>
          <button onClick={() => go({ type: "tasks" })}>
            <Columns3 size={15} /> Tasks
          </button>
        </nav>
      )}
      {!threadId &&
        conversation.unread_thread_count > 0 &&
        conversation.unread_thread_id && (
          <button
            type="button"
            className="unread-thread-shortcut"
            onClick={() => openThread(conversation.unread_thread_id)}
          >
            <MessageSquare size={15} aria-hidden="true" />
            <span>
              {conversation.unread_thread_count} unread thread{" "}
              {conversation.unread_thread_count === 1 ? "reply" : "replies"}
            </span>
            <strong>View</strong>
            <ArrowRight size={15} aria-hidden="true" />
          </button>
        )}
      <div className="chat-scroll" ref={scroller} onScroll={nearBottom}>
        {!threadId && (
          <>
            <div className="chat-intro">
              <Avatar
                duck={group || human ? null : lead}
                name={human ? conversationName(conversation, data) : undefined}
                size={48}
              />
              <h2>
                {group
                  ? "# " + conversation.name
                  : conversationName(conversation, data)}
              </h2>
              <p>
                {human
                  ? "A private conversation between you and " +
                    conversationName(conversation, data) +
                    ". Messages and files stay here, with threads for the details."
                  : group
                    ? "A shared space for your team. Send a message to people, or choose a duck to bring them into the conversation."
                    : gone
                      ? `${gone.role}. Off the team since somebody took it off - everything it wrote is still here to read.`
                      : lead?.chief
                        ? "Your chief of staff. Make a plan, build your team, and get work moving."
                        : `${lead?.role}. A teammate with their own perspective, memory, and a place in your flock.`}
              </p>
              <div className="intro-links">
                {!human && (
                  <button
                    onClick={() =>
                      setModal(
                        group
                          ? { type: "participants", conversation }
                          : { type: "duck", duck: lead },
                      )
                    }
                  >
                    {group ? <Users size={15} /> : <Sparkles size={15} />}{" "}
                    {/* The same word as the button above it, for the same
                        dialog. It said "See members" there. */}
                    {group ? "Members" : "Edit duck profile"}{" "}
                    <ArrowRight size={14} />
                  </button>
                )}
                {!group && (
                  <span>
                    Only you and {conversationName(conversation, data)}
                  </span>
                )}
              </div>
            </div>
          </>
        )}
        {loadError && (
          <div className="chat-load-error" role="alert">
            {loadError}
          </div>
        )}
        {!loaded && (
          <div className="inline-loading">
            <Loader2 size={18} className="spin" /> Loading conversation
          </div>
        )}
        {!threadId && loaded && messages.length >= reach && (
          <button
            className="text-button load-earlier"
            onClick={() => {
              follow.current = false;
              wasTop.current = messages[0]?.id || null;
              setReach((r) => r + 1000);
            }}
          >
            Show earlier messages
          </button>
        )}
        {displayed
          // A queued message is normally an empty placeholder for a reply that
          // has not started, and those are not worth showing. A reply that went
          // back into the queue after a handover is not empty: it already holds
          // what the duck wrote, the screenshots it took and the files it saved,
          // and hiding it took all of that off the screen until the duck
          // happened to get its turn again.
          .filter(
            (m) =>
              !["steered", "steering"].includes(m.state) &&
              !(m.state === "queued" && !m.body && !m.artifacts?.length) &&
              !hideSilentCompletion(m, data),
          )
          .map((m, index, shown) => {
            const duck = data.ducks.find((d) => d.id === m.duck_id);
            // Messages carried a clock time and nothing else, under a single
            // divider dated when the conversation began, so a chat running over
            // weeks read as one very long day and "11:15 PM" could be any of
            // them. A line goes in wherever the day changes.
            const before = shown[index - 1];
            const newDay =
              !before ||
              new Date(before.created).toDateString() !==
                new Date(m.created).toDateString();
            // The workspace's list first, because it is kept up to the minute
            // while a run is going. Then the run that came with the message:
            // that list only holds the 100 newest, and a reply whose run had
            // fallen off it changed what it said - its reason in the duck's
            // voice, no Try again, "Run stopped." for a stop that was yours.
            const job =
              data.jobs.find((j) => j.output_message_id === m.id) ||
              m.run ||
              undefined;
            // A run that fails before writing anything has the server copy its
            // error into the message body as well, so the machine's sentence
            // arrives wearing the duck's name. The card below carries it, as
            // the headline where it is a sentence. Printed here too it read as
            // the duck talking - with the card underneath saying the duck
            // never said why, directly below the reason it had just given.
            const machineSaidIt =
              m.state === "error" && bodyIsTheReason(job, m.body);
            const jobQueueReason = queueReason(job);
            // The steps and commands stay with the message whose run made
            // them. The terminal used to hang off whichever message the server
            // currently pointed the screen at, so sending anything took it off
            // the answer it belonged to and moved it onto the new message,
            // which had not run anything yet.
            const worked =
              job &&
              data.permissions.computers &&
              ((data.terminal_jobs || []).includes(job.id) ||
                (data.desktop_jobs || []).includes(job.id))
                ? (data.computers?.items || []).find(
                    (c) => c.duck_id === m.duck_id,
                  )
                : null;
            const requests = data.human_requests || [],
              messageRequests = requests.filter((r) => r.message_id === m.id),
              screenComputer =
                data.permissions.computers &&
                data.computers?.items.find(
                  (c) =>
                    c.duck_id === m.duck_id && c.checkpoint_message_id === m.id,
                ),
              // Whether this run did anything to the desktop at all. A run that
              // only typed at a terminal changed nothing on that screen, so a
              // picture of it is a picture of whatever was left lying there -
              // which is exactly what people were shown, motionless, beside a
              // terminal doing all the work. What is still worth keeping is the
              // way in to the screen and the duck's own account of itself, so
              // only the picture goes.
              usedDesktop = !job || (data.desktop_jobs || []).includes(job.id),
              activeMessageRequests = messageRequests.filter(
                (r) =>
                  ["pending", "preparing", "desktop", "submitting"].includes(
                    r.status,
                  ) && r.expires > Date.now(),
              ),
              legacyRequests = screenComputer
                ? requests.filter(
                    (r) =>
                      r.computer_id === screenComputer.id &&
                      !r.message_id &&
                      (r.id === screenComputer.request_id ||
                        (Date.parse(r.created) >= Date.parse(m.created) &&
                          r.checkpoint === screenComputer.checkpoint)) &&
                      (!r.conversation_id ||
                        r.conversation_id === conversation.id) &&
                      // A takeover that failed is parked, and parked is the
                      // whole reason this card exists: it carries why the
                      // screen never opened, and the button that opens it
                      // again from today's checkpoint token. Keeping only the
                      // live statuses dropped it, so somebody whose takeover
                      // failed got no reason at all and a plain "View its
                      // screen" that pins no token. The stale countdown that
                      // change was made to stop is already held down inside
                      // the card, by `waits` in HumanInput.jsx.
                      !["completed", "cancelled"].includes(r.status),
                  )
                : [],
              inlineRequests = messageRequests.length
                ? messageRequests
                : legacyRequests,
              // A card under this message that still wears "Needs you": not
              // answered, and its wait not run out. It carries what the duck
              // needs as its headline, so the note and the "waiting" label
              // that said the same thing stand down for it.
              waitingCard = inlineRequests.some(
                (r) =>
                  ![
                    "completed",
                    "cancelled",
                    "parked",
                    "parking",
                    "expired",
                  ].includes(r.status) && r.expires > Date.now(),
              ),
              // Any card still open under it, waiting or not. One whose wait
              // ran out says the duck is no longer waiting, and the reply
              // above it went on saying "Waiting for you".
              openCard = inlineRequests.some(
                (r) => !["completed", "cancelled"].includes(r.status),
              ),
              screen =
                !activeMessageRequests.length && !legacyRequests.length
                  ? screenComputer
                  : null,
              // Has the picture moved? Only something done to the desktop moves
              // it. A duck working through the terminal touches the machine
              // every few seconds and changes nothing on screen - which is
              // exactly what happened to somebody who watched a signup form
              // from a job two days earlier, badged "Live", while their duck
              // fetched and read thirty pages without ever opening a window.
              desktopAt = screen?.desktop_at
                ? Date.parse(screen.desktop_at)
                : screen?.started_at || 0,
              screenStill =
                screen && !screen.human_control && desktopAt
                  ? Date.now() - desktopAt >= STILL_MS
                    ? Date.now() - desktopAt
                    : 0
                  : 0;
            const pending = data.jobs.filter(
              (j) =>
                j.input_message_id === m.id &&
                ["queued", "steering"].includes(j.status),
            );
            const pendingQueueReason = queueReason(
              pending.find((j) => j.status === "queued"),
            );
            const humanHold = pending.some((j) =>
              requests.some(
                (r) =>
                  r.duck_id === j.duck_id &&
                  !["completed", "cancelled", "parked"].includes(r.status) &&
                  r.expires > Date.now(),
              ),
            );
            const steerable = pending.find(
              (j) =>
                j.status === "queued" &&
                j.user_id === data.user.id &&
                data.jobs.some(
                  (active) =>
                    active.status === "running" &&
                    active.user_id === j.user_id &&
                    active.conversation_id === j.conversation_id &&
                    (active.thread_id || null) === (j.thread_id || null) &&
                    active.duck_id === j.duck_id,
                ),
            );
            // A reply is written into an empty message, so an empty body used
            // to be read as "still thinking" and animated forever. Only a
            // queued one is still going with nothing else to say so: a working
            // one has its card, and a paused one is stopped, waiting for a
            // person.
            const thinking = m.state === "queued";
            const wasSteered = data.jobs.some(
              (j) => j.input_message_id === m.id && j.status === "steered",
            );
            // The way in to the duck's screen, on its card: the picture, which
            // is itself the button, or a plain button when there is no picture
            // to show. Never both - they were two doors to one screen, one
            // under the other. And none at all to a screen this run never
            // touched, which is an invitation to look at nothing, or on a
            // failed run, whose own card offers the way in.
            const picture =
              screen && usedDesktop && m.state !== "error" ? (
                screen.screenshot_at && screenLive.includes(screen.state) ? (
                  <ChatScreenShot
                    key={screen.id + ":" + m.id}
                    screen={screen}
                    duck={duck}
                    frame={frame}
                    screenStill={screenStill}
                    go={go}
                  />
                ) : (
                  <>
                    <Button
                      type="button"
                      className="secondary small"
                      aria-label={
                        "Open " + (duck?.name || "the duck") + "'s screen"
                      }
                      onClick={() =>
                        // No checkpoint token. Pinning one freezes this page on
                        // the screen as it was at the moment of the click, and
                        // the duck changes it with its very next action -
                        // which is the whole reason somebody presses this. A
                        // token belongs to an invitation meant for one person;
                        // this is just a way to go and look.
                        go({ type: "computers", id: screen.id, control: true })
                      }
                    >
                      <Monitor size={15} aria-hidden="true" /> Open screen
                    </Button>
                    {screen.state === "archived" && (
                      <small>
                        The saved computer will reopen when you take control.
                      </small>
                    )}
                  </>
                )
              ) : null;
            return (
              <React.Fragment key={m.id}>
                {newDay && (
                  <div className="date-divider">
                    <span>{dayLabel(m.created)}</span>
                  </div>
                )}
                {m.id === leftOff && (
                  <div className="chat-new-line" ref={newLine}>
                    <span>New</span>
                  </div>
                )}
                <article
                  data-message-id={m.id}
                  className={
                    "message " +
                    (m.state === "error" ? "message-error " : "") +
                    (m.id === found ? "message-found" : "")
                  }
                  key={m.id}
                >
                  {!threadId && (
                    <div className="message-actions">
                      <IconButton
                        icon={MessageSquare}
                        // Named after whoever said it: a list of these all
                        // called "Reply in thread" is three identical buttons
                        // to anybody reading the page rather than looking at it.
                        label={
                          "Reply in thread to " +
                          (m.duck_name || m.user_name || "this message")
                        }
                        onClick={() => openThread(m.id)}
                      />
                    </div>
                  )}
                  {m.origin === "workflow" ? (
                    <span className="workflow-request-avatar" aria-hidden>
                      <Workflow size={19} />
                    </span>
                  ) : m.origin === "schedule" ? (
                    <span className="schedule-request-avatar" aria-hidden>
                      <Clock size={19} />
                    </span>
                  ) : m.origin === "tool" ? (
                    <span className="schedule-request-avatar" aria-hidden>
                      <Plug size={19} />
                    </span>
                  ) : m.origin === "webhook" ? (
                    <span className="schedule-request-avatar" aria-hidden>
                      <Webhook size={19} />
                    </span>
                  ) : (
                    <Avatar duck={duck} name={m.user_name} size={38} />
                  )}
                  <div className="message-main">
                    <div className="message-meta">
                      <strong>
                        {m.origin === "workflow"
                          ? "Workflow"
                          : m.origin === "schedule"
                            ? "Scheduled"
                            : m.origin === "tool"
                              ? "Connected service"
                              : m.origin === "webhook"
                                ? // Sent by another app, under the name of
                                  // whoever turned the webhook on: said as
                                  // the app, not as them.
                                  m.webhook?.source || "Another app"
                                : m.duck_name || m.user_name || "Workspace"}
                      </strong>
                      {duck && <span className="bot-label">DUCK</span>}
                      {m.origin === "workflow" && (
                        <span className="bot-label">TICKET</span>
                      )}
                      {m.origin === "schedule" && (
                        <span className="bot-label">ON A SCHEDULE</span>
                      )}
                      {m.origin === "webhook" && (
                        <span
                          className="bot-label"
                          title={
                            "Sent through this duck’s webhook" +
                            (m.user_name ? ", on behalf of " + m.user_name : "")
                          }
                        >
                          {m.webhook?.test ? "WEBHOOK TEST" : "WEBHOOK"}
                        </span>
                      )}
                      <time>{fmtTime(m.created)}</time>
                      {m.ai_model && (
                        <span
                          className={
                            "message-model " +
                            (m.ai_model.fallback_reason ? "fallback" : "")
                          }
                          title={
                            m.ai_model.fallback_reason || modelLabel(m.ai_model)
                          }
                        >
                          {modelLabel(m.ai_model)}
                          {m.ai_model.fallback_reason
                            ? " · Default fallback"
                            : ""}
                        </span>
                      )}
                      {pending.length > 0 && (
                        <div className="queued-label">
                          {pending.some((j) => j.status === "steering") ? (
                            "Steering current reply…"
                          ) : pendingQueueReason ? (
                            <>
                              Queued ·{" "}
                              <QueueReason reason={pendingQueueReason} />
                            </>
                          ) : humanHold ? (
                            "Queued · the duck is waiting for an answer"
                          ) : (
                            "Queued · waiting for its turn"
                          )}
                        </div>
                      )}
                      {wasSteered && !pending.length && (
                        <span className="queued-label">
                          Used to steer current reply
                        </span>
                      )}
                      {m.state === "waiting_consultation" && (
                        <span className="message-waiting">
                          Waiting for teammate replies
                        </span>
                      )}
                      {/* The card underneath already says where things stand.
                          Without one - the duck is waiting for a teammate,
                          whose card only they are sent - this is the only
                          thing that says why the reply stopped. */}
                      {m.state === "waiting_human" && !openCard && (
                        <span className="message-waiting">
                          {!m.waiting_for || m.waiting_for === data.user.id
                            ? "Waiting for you"
                            : "Waiting for " +
                              ((data.members || []).find(
                                (u) => u.id === m.waiting_for,
                              )?.name || "a teammate")}
                        </span>
                      )}
                      {/* A run that is going says so on its own card below. */}
                      {m.state === "queued" && (
                        <div className="message-working">
                          <span className="working-dot" />
                          {jobQueueReason ? (
                            <>
                              Queued · <QueueReason reason={jobQueueReason} />
                            </>
                          ) : humanHold ? (
                            "Queued · the duck is waiting for an answer"
                          ) : (
                            "In the queue"
                          )}
                        </div>
                      )}
                    </div>
                    {job?.recovery && (
                      <RecoveryStatus job={job} data={data} action={action} />
                    )}
                    {/* The run, told once: how long, the steps it has taken
                        in its own words, a picture of its screen that is the
                        way in, and the commands under Details. Once it is over
                        it folds into one line.

                        Above the answer, because that is the order the two
                        happened in: you watch the work, then the duck tells
                        you how it went. */}
                    {(job?.acknowledgement || m.run?.acknowledgement) && (
                      <div
                        className="duck-acknowledgement"
                        data-acknowledgement
                      >
                        {job?.acknowledgement || m.run.acknowledgement}
                      </div>
                    )}
                    {m.duck_id &&
                      (m.state === "working" || worked || picture) && (
                        <WorkCard
                          key={job?.id || m.id}
                          name={duck?.name || m.duck_name || "The duck"}
                          state={m.state}
                          outcome={job?.work_outcome || m.run?.work_outcome}
                          started={job?.created || m.created}
                          ended={job?.updated}
                          computer={worked?.id}
                          job={job?.id}
                          tick={frame}
                          picture={picture}
                          onGrow={() => {
                            if (follow.current)
                              bottom.current?.scrollIntoView({
                                behavior: "instant",
                                block: "end",
                              });
                          }}
                          onStop={
                            job?.status === "running" &&
                            (job.user_id === data.user.id ||
                              data.permissions.company)
                              ? () =>
                                  action(() =>
                                    api(
                                      "/jobs/" + job.id + "/cancel",
                                      "POST",
                                      {},
                                    ),
                                  )
                              : null
                          }
                        />
                      )}
                    {m.origin === "workflow" ? (
                      <WorkflowRequest message={m} go={go} />
                    ) : m.origin === "schedule" ? (
                      <ScheduleRequest message={m} go={go} />
                    ) : m.origin === "tool" ? (
                      <ToolResult message={m} />
                    ) : m.body &&
                      !machineSaidIt &&
                      !(
                        /^Shared (a file|\d+ files)\.$/.test(m.body) &&
                        m.artifacts?.some((a) => a.kind === "file")
                      ) ? (
                      <Markdown>
                        {m.artifacts?.some((a) => a.kind === "screenshot")
                          ? m.body
                              .replace(
                                /!\[[^\]]*\]\(\/api\/computer-captures\/[a-f0-9-]+\)/g,
                                "",
                              )
                              .replace(/^[ \t]*(?:[-*+]|\d+\.)[ \t]*$/gm, "")
                          : m.body}
                      </Markdown>
                    ) : m.state === "working" ||
                      m.consultations?.length ||
                      m.artifacts?.some(
                        (a) => a.verb !== "Viewed",
                      ) ? null : thinking ? (
                      <div className="thinking">
                        <i />
                        <i />
                        <i />
                      </div>
                    ) : m.state === "sent" ? (
                      m.schedule ? (
                        <p className="message-nothing">Nothing to report.</p>
                      ) : null
                    ) : // A run that failed and wrote nothing said so twice:
                    // "This run ended with an error." here, in the weaker of
                    // the two voices, and the card below saying it properly
                    // with the reason and something to press.
                    // And a stopped one said it twice over: this line,
                    // then the line below naming who stopped it. That one says
                    // everything this one did, and the part people came for.
                    m.state === "error" || m.state === "cancelled" ? null : (
                      <p className="message-nothing">
                        {m.state === "waiting_human"
                          ? pausedBecause(inlineRequests, m, data)
                          : endedWithout(m.state)}
                      </p>
                    )}
                    {m.chief_checkin && m.body && (
                      <div className="chief-checkin-message-action">
                        {m.chief_checkin.dismissed ? (
                          <span>Dismissed</span>
                        ) : (
                          <button
                            type="button"
                            className="text-button"
                            onClick={() =>
                              action(() =>
                                api(
                                  "/chief-checkins/runs/" +
                                    encodeURIComponent(m.chief_checkin.run_id) +
                                    "/dismiss",
                                  "POST",
                                  {},
                                ),
                              )
                            }
                          >
                            Dismiss
                          </button>
                        )}
                      </div>
                    )}
                    {/* Something the duck needs that has no card of its own,
                        like "Connect your AI account". It wears the badge's
                        colours: it used to be a faint grey box, the weakest
                        thing on the page for the one line that mattered. */}
                    {m.needs_you && m.duck_id && !waitingCard && (
                      <p className="message-needs-you">
                        <span className="needs-you-pill">Needs you</span>
                        <span>{m.needs_you}</span>
                      </p>
                    )}
                    {inlineRequests.map((r) => {
                      const onIt =
                        data.permissions.computers &&
                        usedDesktop &&
                        data.computers?.items.find(
                          (c) =>
                            c.id === r.computer_id &&
                            c.screenshot_at &&
                            screenLive.includes(c.state),
                        );
                      return (
                        <HumanInputCard
                          key={r.id}
                          request={r}
                          data={data}
                          action={action}
                          go={go}
                          picture={
                            onIt ? (
                              <ChatScreenShot
                                key={onIt.id + ":" + r.id}
                                screen={onIt}
                                duck={duck}
                                frame={frame}
                                screenStill={0}
                                go={go}
                                request={r}
                              />
                            ) : null
                          }
                        />
                      );
                    })}
                    {(data.skill_proposals || [])
                      .filter((p) => p.message_id === m.id)
                      .map((p) => (
                        <SkillProposalCard
                          key={p.id}
                          proposal={p}
                          data={data}
                          action={action}
                          go={go}
                        />
                      ))}
                    {(data.schedule_proposals || [])
                      .filter((p) => p.message_id === m.id)
                      .map((p) => (
                        <ScheduleProposalCard
                          key={p.id}
                          proposal={p}
                          data={data}
                          action={action}
                          go={go}
                        />
                      ))}
                    {(data.board_proposals || [])
                      .filter((p) => p.message_id === m.id)
                      .map((p) => (
                        <BoardProposalCard
                          key={p.id}
                          proposal={p}
                          data={data}
                          action={action}
                          go={go}
                        />
                      ))}
                    {/* A duck asking to use a connected tool, answered under
                        what it said. It used to have no card here at all:
                        the duck said it had asked "in Needs you". */}
                    {(data.approvals || [])
                      .filter((a) => a.message_id === m.id)
                      .map((a) => (
                        <ToolAskCard
                          key={a.id}
                          approval={a}
                          data={data}
                          action={action}
                          go={go}
                        />
                      ))}
                    {(data.connection_blocks || [])
                      .filter((b) => b.message_ids?.includes(m.id))
                      .map((b) => (
                        <ConnectionAskCard
                          key={b.id}
                          block={b}
                          data={data}
                          action={action}
                          go={go}
                        />
                      ))}
                    <DuckConsultations
                      items={m.consultations}
                      data={data}
                      action={action}
                      go={go}
                    />
                    <FileNotices notices={m.file_notices} data={data} />
                    <ChatArtifacts
                      onMediaLoad={() => {
                        if (follow.current)
                          bottom.current?.scrollIntoView({
                            behavior: "instant",
                          });
                      }}
                      // What a duck only read stays on the ticket, not in chat.
                      items={m.artifacts?.filter((a) => a.verb !== "Viewed")}
                      message={m}
                      data={data}
                      action={action}
                      notify={notify}
                      conversation={conversation}
                      threadId={threadId}
                      go={go}
                      setModal={setModal}
                    />
                    {!threadId && m.reply_count > 0 && (
                      <button
                        className="thread-replies"
                        onClick={() => openThread(m.id)}
                      >
                        <span className="thread-avatars">
                          {m.repliers.slice(0, 3).map((person) => (
                            <Avatar
                              key={person.id}
                              duck={data.ducks.find(
                                (d) => d.id === person.duck_id,
                              )}
                              name={person.name}
                              size={21}
                            />
                          ))}
                        </span>
                        <strong>
                          {m.reply_count}{" "}
                          {m.reply_count === 1 ? "reply" : "replies"}
                        </strong>
                        {m.reply_unread > 0 && (
                          <span className="thread-unread">
                            {m.reply_unread} new
                          </span>
                        )}
                        <small>Last reply {fmtWhen(m.last_reply_at)}</small>
                      </button>
                    )}
                    {steerable && (
                      <button
                        className="steer-button"
                        onClick={() =>
                          action(
                            () =>
                              api(
                                "/jobs/" + steerable.id + "/steer",
                                "POST",
                                {},
                              ),
                            "Message sent to the active reply",
                          )
                        }
                      >
                        Steer current reply <ArrowRight size={13} />
                      </button>
                    )}
                    {m.state === "error" && (
                      <RunFailure
                        m={m}
                        job={job}
                        duck={duck}
                        data={data}
                        action={action}
                        go={go}
                        screenShown={!!picture}
                        conversation={conversation}
                      />
                    )}
                    {job?.status === "done" &&
                      job.work_outcome === "incomplete" &&
                      !(worked || picture) && (
                        <small className="muted">
                          Finished with work remaining
                        </small>
                      )}
                    {m.state === "cancelled" && (
                      <small className="muted">
                        {whoStopped(job, data) + STOPPED_TAIL}
                      </small>
                    )}
                  </div>
                </article>
                {threadId && m.id === parent?.id && (
                  <div className="thread-divider">
                    {shownReplies} {shownReplies === 1 ? "reply" : "replies"}
                  </div>
                )}
              </React.Fragment>
            );
          })}
        <div ref={bottom} />
        {!atBottom && loaded && (
          <button type="button" className="chat-to-latest" onClick={toLatest}>
            <ArrowDown size={15} aria-hidden="true" />
            {fresh === 1
              ? "1 new message"
              : fresh > 1
                ? fresh + " new messages"
                : "Jump to latest"}
          </button>
        )}
      </div>
      {attachmentPicker && (
        <DocumentPicker
          data={data}
          action={action}
          conversation={conversation}
          threadId={threadId}
          onClose={() => setAttachmentPicker(false)}
          onSelect={(id) =>
            setAttachedDocs((list) => [...new Set([...list, id])].slice(0, 10))
          }
        />
      )}
      <div className="composer-area">
        {!!conversation.archived && (
          <div className="archived-banner">
            This channel is archived. Its history is saved.
            {canArchiveChannel(data, conversation) && (
              <Button
                className="secondary small"
                onClick={() =>
                  action(
                    () =>
                      api(
                        "/conversations/" + conversation.id + "/archive",
                        "PATCH",
                        { archived: false },
                      ),
                    "Channel unarchived",
                  )
                }
              >
                Unarchive channel
              </Button>
            )}
          </div>
        )}
        {gone ? (
          <div className="archived-banner">
            {gone.name} is off the team, so nothing can be sent here. Everything
            it wrote is saved. Put it back from the Team page to carry on.
          </div>
        ) : (
          unavailable && (
            <div className="archived-banner">
              This teammate is no longer in the company. Your conversation
              history is saved.
            </div>
          )
        )}
        {/* Pausing the flock greys out the message box. Nothing said so, so it
            read as the chat being broken rather than as something someone had
            deliberately switched off, and there was nothing to say where. */}
        {asksDuck && !!data.company.paused && (
          <div className="connect-banner">
            <span className="connect-icon">
              <Sparkles size={18} />
            </span>
            <div>
              <strong>Your ducks are paused.</strong>
              <span>
                {data.company.billing_hold
                  ? "They start again when the plan is started or paid."
                  : "Nobody can send them work until they are started again."}
              </span>
            </div>
            {data.company.billing_hold
              ? data.permissions.billing && (
                  <Button
                    className="small"
                    onClick={() => go({ type: "settings", tab: "billing" })}
                  >
                    Billing <ArrowUpRight size={15} />
                  </Button>
                )
              : data.permissions.company && (
                  <Button
                    className="small"
                    onClick={() => go({ type: "settings", tab: "company" })}
                  >
                    Company settings <ArrowUpRight size={15} />
                  </Button>
                )}
          </div>
        )}
        {/* Connecting an AI is not everybody's to do. "Connect AI" landed a
            plain member on a page that tells them there is nothing for them to
            connect - a button inviting them to do a thing, and a screen saying
            the thing is not theirs. They are told who to ask instead. A
            connection that has only dropped says so: it used to say nobody had
            ever connected one. */}
        {asksDuck && !data.company.paused && noAI && (
          <div className="connect-banner">
            <span className="connect-icon">
              {aiDown(ai) ? (
                <TriangleAlert size={18} />
              ) : (
                <Sparkles size={18} />
              )}
            </span>
            <div>
              <strong>{noAI.title}</strong>
              <span>{noAI.line}</span>
            </div>
            {noAI.fixes && (
              <Button
                className="small"
                onClick={() => go({ type: "settings", tab: "ai" })}
              >
                {aiDown(ai) ? "Check connection" : "Connect AI"}{" "}
                <ArrowUpRight size={15} />
              </Button>
            )}
          </div>
        )}
        {uploads.length > 0 && (
          <ul className="draft-files" aria-label="Files to send">
            {uploads.map((u) => (
              <li
                key={u.key}
                className={"draft-file " + u.status}
                title={u.error || u.name}
              >
                {u.status === "ready" && u.group === "image" && u.inline ? (
                  <img src={uploadUrl(u.id)} alt="" />
                ) : u.status === "error" ? (
                  <span className="file-icon file-icon-error">
                    <TriangleAlert size={18} />
                  </span>
                ) : (
                  <FileIcon item={u} size={18} />
                )}
                <span className="draft-file-text">
                  <strong>{u.name}</strong>
                  <small role={u.status === "error" ? "alert" : undefined}>
                    {u.status === "error"
                      ? u.error
                      : u.status === "uploading"
                        ? `Uploading… ${Math.round(u.progress * 100)}%`
                        : formatBytes(u.size)}
                  </small>
                  {u.status === "uploading" && (
                    <span className="draft-file-progress">
                      <i
                        style={{ width: `${Math.round(u.progress * 100)}%` }}
                      />
                    </span>
                  )}
                </span>
                <button
                  type="button"
                  aria-label={"Remove " + u.name}
                  onClick={() => removeUpload(u)}
                >
                  <X size={13} />
                </button>
              </li>
            ))}
          </ul>
        )}
        {attachedDocs.length > 0 && (
          <div className="draft-attachments">
            {attachedDocs.map((id) => (
              <span key={id}>
                <FileText size={14} />
                {data.documents.find((d) => d.id === id)?.title}
                <button
                  aria-label={
                    "Remove attached document " +
                    data.documents.find((d) => d.id === id)?.title
                  }
                  onClick={() =>
                    setAttachedDocs((list) => list.filter((d) => d !== id))
                  }
                >
                  <X size={13} />
                </button>
              </span>
            ))}
          </div>
        )}
        <form className="composer" onSubmit={send}>
          {/* The server refuses anything longer, and somebody pasting a long
              document only found out after pressing send. Say it while there is
              still room to do something about it. */}
          {draft.length > MESSAGE_LIMIT - 2000 && (
            <p
              className={
                "composer-count " + (draft.length > MESSAGE_LIMIT ? "over" : "")
              }
              role="status"
            >
              {draft.length > MESSAGE_LIMIT
                ? "That is " +
                  (draft.length - MESSAGE_LIMIT).toLocaleString() +
                  " characters too long to send. Shorten it, or attach it as a file."
                : (MESSAGE_LIMIT - draft.length).toLocaleString() +
                  " characters left."}
            </p>
          )}
          <textarea
            ref={textarea}
            aria-label={threadId ? "Thread reply" : "Message"}
            placeholder={
              !data.permissions.chat
                ? "Your role has read-only access."
                : threadId
                  ? "Reply in thread…"
                  : group
                    ? "Message the group…"
                    : "Message " + conversationName(conversation, data) + "…"
            }
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            disabled={barOff || pausedFor(answering)}
            onPaste={(e) => {
              if (e.clipboardData.files.length) {
                e.preventDefault();
                uploadFiles(e.clipboardData.files);
              }
            }}
            onKeyDown={(e) => {
              if (
                e.key === "Enter" &&
                !e.shiftKey &&
                !touchOnly &&
                !e.nativeEvent.isComposing
              ) {
                e.preventDefault();
                send(e);
              }
            }}
          />
          {/* One bar. Attach, what a duck is doing here with the way to stop
              it, and a Send that says where the message is going. Nothing sits
              above the box or below it any more. */}
          <div
            className={"composer-bar" + (runWords.length ? " working" : "")}
            ref={bar}
          >
            <button
              type="button"
              className="composer-tool"
              aria-label="Attach a file or a document"
              title="Attach a file or a document"
              aria-expanded={openList === "attach"}
              disabled={!canAttach}
              onClick={() => setOpenList(openList === "attach" ? "" : "attach")}
            >
              <Paperclip size={18} />
            </button>
            <input
              ref={fileInput}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                uploadFiles(e.target.files);
                e.target.value = "";
              }}
            />
            {openList === "attach" && (
              <div
                className="composer-list at-start"
                role="group"
                aria-label="Attach"
                ref={openMenu}
                onKeyDown={listKeys}
              >
                <button
                  type="button"
                  onClick={() => {
                    setOpenList("");
                    fileInput.current?.click();
                  }}
                >
                  <span className="composer-tile">
                    <Paperclip size={14} />
                  </span>
                  A file from this computer
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setOpenList("");
                    setAttachmentPicker(true);
                  }}
                >
                  <span className="composer-tile">
                    <FileText size={14} />
                  </span>
                  A company document
                </button>
              </div>
            )}
            {!!runWords.length && (
              <p className="composer-status" role="status">
                <Loader2 className="spin" size={16} />
                <span>
                  {runWords.map((r, i) => (
                    <React.Fragment key={r.who + r.tail}>
                      {i > 0 && " · "}
                      <strong>{r.who}</strong>
                      {r.tail}
                    </React.Fragment>
                  ))}
                  {/* The minutes climb on their own, and a reader that speaks
                      every change would say the whole sentence again each one. */}
                  {minutes >= 1 && (
                    <span className="composer-since" aria-hidden="true">
                      {" · " + minutes + " min"}
                    </span>
                  )}
                </span>
              </p>
            )}
            {waiting.some((j) => j.user_id === data.user.id) && (
              <button
                type="button"
                className="button composer-stop"
                onClick={() =>
                  action(async () => {
                    const mine = waiting.filter(
                      (j) => j.user_id === data.user.id,
                    );
                    // Stopping them one after another gave up at the first
                    // refusal, and a run that had just finished on its own is
                    // exactly such a refusal. Pressing Stop with two ducks
                    // working then stopped neither and said "This run has
                    // already stopped", which was untrue of the one still going.
                    const results = await Promise.allSettled(
                      mine.map((j) =>
                        api("/jobs/" + j.id + "/cancel", "POST", {}),
                      ),
                    );
                    const refused = results.filter(
                      (r) => r.status === "rejected",
                    );
                    if (refused.length === results.length)
                      throw refused[0].reason;
                    return { ok: true };
                  })
                }
              >
                <Square size={12} /> Stop
              </button>
            )}
            <div
              className="composer-send"
              role={picker && chosen ? "group" : undefined}
              aria-label={picker && chosen ? "Send" : undefined}
            >
              {picker && !chosen ? (
                /* This stands where Send stands and is what somebody with a
                   message written presses, so answering the list finishes
                   what they started rather than asking them to press twice. */
                <button
                  type="button"
                  className="button"
                  aria-expanded={openList === "who"}
                  disabled={barOff}
                  onClick={() => {
                    sendAfterPick.current = openList !== "who";
                    setOpenList(openList === "who" ? "" : "who");
                  }}
                >
                  Choose who answers <ChevronUp size={16} />
                </button>
              ) : (
                <>
                  <button
                    className="button composer-go"
                    title={
                      touchOnly
                        ? "Return makes a new line"
                        : "Enter to send · Shift + Enter for a new line"
                    }
                    disabled={cannotSend || pausedFor(answering)}
                  >
                    {sendLabel}
                    {busy ? (
                      <Loader2 size={16} className="spin" />
                    ) : (
                      <ArrowRight size={16} />
                    )}
                  </button>
                  {picker && (
                    <button
                      type="button"
                      className={
                        "button composer-more" +
                        (cannotSend || pausedFor(answering) ? " quiet" : "")
                      }
                      aria-label="Change who answers"
                      aria-expanded={openList === "who"}
                      disabled={barOff}
                      onClick={() => {
                        sendAfterPick.current = false;
                        setOpenList(openList === "who" ? "" : "who");
                      }}
                    >
                      <ChevronUp size={16} />
                    </button>
                  )}
                </>
              )}
            </div>
            {openList === "who" && (
              <div
                className="composer-list at-end"
                role="group"
                aria-label="Who answers"
                ref={openMenu}
                onKeyDown={listKeys}
              >
                {answerRows.map((row, i) => (
                  <React.Fragment key={row.value}>
                    {row.plain && i > 0 && (
                      <span className="composer-line" aria-hidden="true" />
                    )}
                    <button
                      type="button"
                      className={row.plain ? "plain" : ""}
                      aria-pressed={selected === row.value}
                      onClick={(e) => choose(row.value, e)}
                    >
                      <span className="composer-mark">{row.mark}</span>
                      {row.label}
                      {selected === row.value && (
                        <Check size={16} className="composer-tick" />
                      )}
                    </button>
                  </React.Fragment>
                ))}
              </div>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}
