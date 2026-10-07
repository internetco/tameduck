// Every word the Computers list and a computer's own page say, worked out from
// the workspace the server sends. No React here, so all of it is tested without
// a browser (tests/computer-state.test.mjs).
//
// The old cards worked their words out inline, and three of them were wrong for
// long stretches: a computer whose desktop never started looked healthy as soon
// as it had an old picture; a question that could no longer be answered sent
// people to a screen where nothing could free it; and Start read "Resume" or
// "Start" depending on box_id, which the server never sends.
import { atWhen, fmtWhen, plural } from "./when.mjs";
import { COMPUTER_IDLE_SECONDS } from "../shared/computer-policy.mjs";
import { canConnectAI, withoutAIWords } from "../shared/ai-access.mjs";

const live = ["ready", "idle", "running"];
const coming = ["provisioning", "provisioned", "cloning", "resuming"];
const clock = (t) =>
  new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

// On is anything that is up, coming up, or may be up without our knowing - all
// of which bill. Off has genuinely stopped, or never started.
export const isOn = (c) =>
  !!c?.state && !["archived", "not_started"].includes(c.state);
export const isLive = (c) => live.includes(c?.state);

// "7 min", "1 h", "1 h 13 min". Empty for nothing at all; callers leave out
// anything under a minute.
export function duration(seconds) {
  if (!(seconds > 0)) return "";
  const m = Math.max(1, Math.round(seconds / 60)),
    h = Math.floor(m / 60),
    rest = m % 60;
  return h ? h + " h" + (rest ? " " + rest + " min" : "") : rest + " min";
}

// "16:36" today, "yesterday", "22 Sep" before that.
export function since(iso, now = new Date()) {
  const d = new Date(iso),
    yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (d.toDateString() === new Date(now).toDateString()) return clock(iso);
  if (d.toDateString() === yesterday.toDateString()) return "yesterday";
  return d.toLocaleDateString([], { day: "numeric", month: "short" });
}

// A person's name. Somebody who has left the company is "Someone".
const nameOf = (id, data) =>
  (data.members || []).find((m) => m.id === id)?.name || "Someone";

const ticketTitle = (work, data) =>
  (data.tasks || []).find((t) => t.id === work.task_id)?.title;
// Where a run works, as the reader knows it: a ticket by its title, their own
// chat, a channel by its name. A chat they are not in is described, not named.
// A ticket's title is set apart, because titles are often orders and read as
// broken English run into a sentence: "For Renew the certificate".
export function placeWords(work, data, duck) {
  if (!work) return null;
  if (work.task_id) {
    const title = ticketTitle(work, data);
    return title ? "“" + title + "”" : "a ticket";
  }
  const withDuck = (ids) =>
    (data.ducks || []).find((d) => ids.includes(d.id))?.name || duck?.name;
  const chat = (data.conversations || []).find(
    (c) => c.id === work.conversation_id,
  );
  if (chat)
    return chat.kind === "group"
      ? "#" + chat.name
      : chat.kind === "direct"
        ? "your chat with " + withDuck(chat.ducks || [])
        : "a chat";
  return work.conversation_kind === "direct"
    ? nameOf(work.user_id, data) + "'s chat with " + withDuck([work.duck_id])
    : work.conversation_kind === "group"
      ? "a channel you are not in"
      : "a chat";
}

// Where that place opens, when the reader can open it.
export function placeRoute(work, data) {
  if (!work) return null;
  if (work.task_id) {
    if (!(data.tasks || []).some((t) => t.id === work.task_id)) return null;
    const board = (data.workflows?.tickets || []).find(
      (t) => t.task_id === work.task_id,
    )?.board_id;
    return board
      ? { type: "tasks", boardId: board, id: work.task_id }
      : { type: "tasks", id: work.task_id };
  }
  return (data.conversations || []).some((c) => c.id === work.conversation_id)
    ? { type: "chat", id: work.conversation_id }
    : null;
}

// The "Working for" / "Last work" card.
export function workCard(work, data, duck) {
  if (!work) return null;
  // A title on its own needs nothing around it.
  const words =
    (work.task_id && ticketTitle(work, data)) || placeWords(work, data, duck);
  const flow = data.workflows || {};
  const ticket = work.task_id
    ? (flow.tickets || []).find((t) => t.task_id === work.task_id)
    : null;
  const chat = (data.conversations || []).find(
    (c) => c.id === work.conversation_id,
  );
  return {
    icon: work.task_id
      ? "ticket"
      : (chat?.kind || work.conversation_kind) === "group"
        ? "channel"
        : "chat",
    title: words.charAt(0).toUpperCase() + words.slice(1),
    subtitle: [
      ticket && (flow.boards || []).find((b) => b.id === ticket.board_id)?.name,
      ticket &&
        (flow.columns || []).find((c) => c.id === ticket.column_id)?.name,
      work.note,
    ]
      .filter(Boolean)
      .join(" · "),
    to: placeRoute(work, data),
  };
}

// Where a computer setting is changed, said to whoever is reading. Only owners
// and admins have Controls.
const changeWhere = (data) =>
  data.permissions?.company
    ? "You can change that under Controls."
    : "An owner or admin can change that.";

// Why Start cannot be pressed, the first reason that applies. The first four
// are the whole company's and are said once, above the list; the last two are
// one duck's and are said on its row and its page.
export function whyNoStart(data, config, ai, duck = null) {
  const company = (words, action = null, key) => ({
    key,
    company: true,
    words,
    action,
  });
  if (!config.configured)
    return company(
      "Computers are not set up for this workspace yet.",
      null,
      "setup",
    );
  if (ai === false)
    return company(
      withoutAIWords(data),
      canConnectAI(data.role, data.permissions)
        ? { label: "Connect AI", to: { type: "settings", tab: "ai" } }
        : null,
      "ai",
    );
  if (data.company?.paused)
    return data.permissions?.company
      ? company(
          "Your flock is paused, so computers stay off.",
          {
            label: "Resume the flock",
            to: { type: "settings", tab: "company" },
          },
          "paused",
        )
      : company(
          "Your flock is paused, so computers stay off. Ask an owner or admin to resume it.",
          null,
          "paused",
        );
  if (!config.enabled)
    return company(
      "Computers are paused for this company. Your saved work stays available. " +
        changeWhere(data),
      null,
      "off",
    );
  if (!duck) return null;
  if (!(config.allowed_ducks || []).includes(duck.id))
    return {
      key: "not_allowed",
      company: false,
      words: duck.name + " is not allowed a computer. " + changeWhere(data),
      action: null,
    };
  if (duck.removed)
    return {
      key: "removed",
      company: false,
      words: duck.name + " is no longer on the team.",
      action: null,
    };
  return null;
}

// What is going on with a computer, in one word, most pressing first. The row
// and the page both read this, so they cannot disagree.
function situation(c, data) {
  const me = data.user?.id;
  if (!c || c.state === "not_started") return { key: "none" };
  const on = isOn(c),
    hc = c.human_control;
  if (isLive(c) && c.desktop_failed) return { key: "failed" };
  if (on && hc)
    return {
      key:
        hc.user_id === me
          ? hc.state === "live"
            ? "mine"
            : "taking_mine"
          : hc.state === "live"
            ? "held"
            : "taking",
      who: hc.user_id,
    };
  // Written off by a restart, or out of time: it still holds the duck, and
  // nothing on the screen can free it. Only stopping its run does.
  if (c.request_id && ["stale", "expired"].includes(c.request_status))
    return { key: "stuck", who: c.request_user_id };
  if (on && c.request_id) {
    const mine = c.request_user_id === me;
    return c.request_kind === "takeover"
      ? { key: mine ? "taking_mine" : "taking", who: c.request_user_id }
      : { key: mine ? "asks_me" : "asks", who: c.request_user_id };
  }
  // The janitor keeps such a computer on for the person, so "Idle" would be
  // untrue.
  if (on && c.awaiting_user_id)
    return {
      key: c.awaiting_user_id === me ? "answer_me" : "answer",
      who: c.awaiting_user_id,
    };
  if (isLive(c))
    return {
      key: !c.automation_ready
        ? "screen_starting"
        : c.in_use
          ? "working"
          : "idle",
    };
  if (coming.includes(c.state)) return { key: "starting" };
  if (c.state === "archiving") return { key: "stopping" };
  if (c.state === "creation_uncertain") return { key: "uncertain" };
  if (c.state === "archived") return { key: "off" };
  return { key: "error" };
}
// A duck is waiting for this person on its screen, or they have it.
const forMe = (s) => ["mine", "taking_mine", "asks_me"].includes(s.key);

// One row of the list.
export function rowFor(duck, c, data, config, ai, now = Date.now()) {
  const s = situation(c, data),
    on = isOn(c),
    name = (id) => nameOf(id, data);
  const place = placeWords(c?.work, data, duck);
  // What it is working for, or last worked for; while it is on with nothing
  // known to be using it, who started it.
  const last = on
    ? place
      ? "For " + place
      : c?.last_start?.user_id
        ? "Started by " +
          (c.last_start.user_id === data.user?.id
            ? "you"
            : name(c.last_start.user_id))
        : null
    : place
      ? "Last: " + place
      : null;
  const notAllowed = !(config.allowed_ducks || []).includes(duck.id);
  const said = {
    failed: ["danger", "Desktop did not start", last, "stop"],
    mine: ["wait", "You have the screen", last, "screen"],
    taking_mine: ["wait", "You are taking the screen", last, "screen"],
    held: ["work", name(s.who) + " has the screen", last, "stop"],
    taking: ["work", name(s.who) + " is taking the screen", last, "stop"],
    stuck: ["danger", "Stuck on an old question", last, on ? "stop" : "start"],
    asks_me: ["wait", "Waiting for you", last, "screen"],
    asks: ["wait", "Waiting for " + name(s.who), last, "stop"],
    answer_me: ["wait", "Waiting for your answer", last, "stop"],
    answer: ["wait", "Waiting for " + name(s.who) + "'s answer", last, "stop"],
    screen_starting: ["busy", "Starting…", "Takes about a minute", null],
    starting: ["busy", "Starting…", "Takes about a minute", null],
    working: ["work", "Working", last, "stop"],
    idle: [
      "idle",
      !c?.stops_at
        ? "Idle"
        : c.stops_at <= now
          ? "Idle, stopping now"
          : "Idle, stops at " + clock(c.stops_at),
      last,
      "stop",
    ],
    stopping: ["busy", "Stopping…", "This finishes on its own", null],
    uncertain: [
      "danger",
      "Needs a look",
      "We asked for one and never heard back",
      "start",
    ],
    error: ["danger", "Something went wrong", last, "stop"],
    off: [
      "off",
      c?.off_since ? "Off since " + since(c.off_since, new Date(now)) : "Off",
      notAllowed ? "Not allowed a computer" : last,
      "start",
    ],
    none: [
      "off",
      "No computer yet",
      notAllowed
        ? "Not allowed a computer"
        : "One starts when " + duck.name + " needs it",
      "start",
    ],
  }[s.key];
  const [tone, state, line3, kind] = said;
  const buttons = {
    screen: {
      label: "Go to screen",
      aria: "Go to " + duck.name + "'s screen",
      primary: true,
      disabled: false,
    },
    stop: {
      label: "Stop",
      aria: "Stop " + duck.name + "'s computer",
      primary: false,
      disabled: false,
    },
    // Primary where there is saved work to go back to; a duck with no
    // computer yet starts its own when it needs one.
    start: {
      label: "Start",
      aria: "Start " + duck.name + "'s computer",
      primary: !!c && c.state !== "not_started",
      disabled: !!whyNoStart(data, config, ai, duck),
    },
  };
  return {
    group: on ? "on" : "off",
    tone,
    state,
    line3: duck.removed && on ? "No longer on the team" : line3,
    button: kind ? { kind, ...buttons[kind] } : null,
    forMe: forMe(s),
    time: c?.used_today >= 60 ? duration(c.used_today) + " today" : null,
  };
}

// Who is listed, and in what order: On first - a duck waiting for the reader
// or a screen they have at the very top, then the flock's own order, and a
// duck taken off the team last. Then Off: stopped computers, then ducks with
// none yet. A duck off the team is listed only while its machine is on, so
// nobody loses sight of one that is still billing.
export function listRows(data, config, ai, now = Date.now()) {
  const items = config.items || [],
    allowed = config.allowed_ducks || [];
  const find = (d) => items.find((c) => c.duck_id === d.id) || null;
  const ducks = data.ducks || [];
  const rows = [
    ...ducks.filter((d) => !d.removed && (allowed.includes(d.id) || find(d))),
    ...ducks.filter((d) => d.removed && isOn(find(d))),
  ].map((duck) => {
    const c = find(duck);
    return { duck, c, ...rowFor(duck, c, data, config, ai, now) };
  });
  const on = rows.filter((r) => r.group === "on"),
    off = rows.filter((r) => r.group === "off"),
    none = (r) => !r.c || r.c.state === "not_started";
  return [
    ...on.filter((r) => r.forMe && !r.duck.removed),
    ...on.filter((r) => !r.forMe && !r.duck.removed),
    ...on.filter((r) => r.duck.removed),
    ...off.filter((r) => !none(r)),
    ...off.filter(none),
  ];
}

// "3 on · 3 h 38 min used today"
export function listSummary(rows, config) {
  const on = rows.filter((r) => r.group === "on").length;
  return (
    (on ? on + " on" : "none on") +
    " · " +
    (config.used_seconds >= 60
      ? duration(config.used_seconds) + " used today"
      : "none used today")
  );
}
export const listFooter = (config) =>
  "Each one stops after " +
  plural(
    Math.round((config.idle_seconds ?? COMPUTER_IDLE_SECONDS) / 60),
    "idle minute",
  ) +
  ". Having this list open keeps none of them on.";

// Why it last stopped, as the headline of an Off computer's page.
export function stopHeadline(c, data) {
  const stop = c.last_stop;
  if (stop) {
    const at = atWhen(stop.at);
    if (stop.user_id)
      return (
        "Stopped by " +
        (stop.user_id === data.user?.id ? "you" : nameOf(stop.user_id, data)) +
        " " +
        at
      );
    if (["stopped_idle", "stopped_long", "stopped_left"].includes(stop.kind))
      return "Stopped by itself " + at;
    return "Stopped " + at;
  }
  // Stops from before there was a record of them.
  if (c.stopped_reason)
    return "Stopped by itself" + (c.off_since ? " " + atWhen(c.off_since) : "");
  if (c.off_since) return "Off since " + since(c.off_since);
  return "Off";
}

// A computer's own page.
export function pageState(duck, c, data, config, ai, now = Date.now()) {
  const s = situation(c, data),
    me = data.user?.id,
    D = duck?.name || "The duck",
    name = (id) => nameOf(id, data);
  const place = placeWords(c?.work, data, duck);
  const where = place ? " in " + place : "";
  let stopRun = null;
  const stuck = () => {
    const work = c.work;
    let end = "";
    if (
      work?.job_id &&
      work.active &&
      (work.user_id === me || data.permissions?.company)
    ) {
      stopRun = work.job_id;
      end = " Stop its run to free it.";
    } else if (work?.active)
      end = " " + name(work.user_id) + " or an owner or admin can stop it.";
    return (
      D +
      " asked " +
      (s.who === me ? "you" : name(s.who)) +
      " something on this screen that can no longer be answered, so nothing else starts for " +
      D +
      "." +
      end
    );
  };
  const title = (data.human_requests || []).find(
    (r) => r.id === c?.request_id,
  )?.title;
  const words = {
    failed: [
      "Its desktop did not start",
      "Its desktop was given time to start and did not. The terminal still works. Stop this computer and start it again to try the desktop once more.",
    ],
    mine: ["You have the screen", D + " is paused until you hand it back."],
    taking_mine: [
      "You are taking the screen",
      D + " is paused while the screen gets ready for you.",
    ],
    held: [
      name(s.who) + " has the screen",
      D + " is paused until they hand it back.",
    ],
    taking: [
      name(s.who) + " is taking the screen",
      D + " is paused while the screen gets ready for them.",
    ],
    stuck: ["Stuck on an old question", null],
    asks_me: [
      "Waiting for you on its screen",
      title
        ? "It asks: " +
          title +
          (/[.!?]$/.test(title) ? "" : ".") +
          " Nothing else starts for " +
          D +
          " until you answer."
        : D +
          " asked you for something on this screen. Nothing else starts for " +
          D +
          " until you answer.",
    ],
    asks: [
      "Waiting for " + name(s.who) + " on its screen",
      "Nothing else starts for " + D + " until they answer.",
    ],
    answer_me: [
      "Waiting for your answer",
      D + " asked you something" + where + ". It stays on while it waits.",
    ],
    answer: [
      "Waiting for " + name(s.who) + "'s answer",
      D +
        " asked " +
        name(s.who) +
        " something" +
        where +
        ". It stays on while it waits.",
    ],
    screen_starting: [
      "Starting its screen",
      "It is on. Its screen is still starting, and the terminal already works.",
    ],
    starting: ["Starting", "Getting it ready. This takes about a minute."],
    working: [
      "Working",
      D + " is using it now. It stays on while " + D + " works.",
    ],
    idle: [
      "Idle",
      "Nothing is happening on it." +
        (c?.stops_at > now
          ? " It stops by itself at " +
            clock(c.stops_at) +
            " unless a duck or a person uses it."
          : c?.stops_at
            ? " It stops by itself in a moment."
            : ""),
    ],
    stopping: [
      "Stopping",
      "Saving its workspace so it comes back as it was. This finishes on its own.",
    ],
    uncertain: [
      "This one needs checking",
      "We asked for a computer and never heard back, so one may be running. Start it again to find out — the same request is reused, so this cannot leave a second machine behind.",
    ],
    error: [
      "Something went wrong",
      c?.error ||
        "The computer service reported a problem with it. Stop it and start it again.",
    ],
    none: ["No computer yet", "One starts when " + D + " needs it."],
    off: [
      c && stopHeadline(c, data),
      (c?.stopped_reason ? c.stopped_reason + " " : "") +
        "Its files and the pages it had open come back when it starts.",
    ],
  }[s.key];
  const [headline] = words;
  const sentence = s.key === "stuck" ? stuck() : words[1];

  // What can be done here.
  const blocked = duck ? whyNoStart(data, config, ai, duck) : null;
  const start = {
    kind: "start",
    label: "Start computer",
    primary: true,
    disabled: !!blocked,
  };
  const stop = { kind: "stop", label: "Stop", primary: false, disabled: false };
  let actions = [],
    hint = null;
  if (s.key === "failed" || c?.state === "error") actions = [stop];
  // Stopping its run is the way out, so it is the main button. The screen is
  // not offered: nothing on it can free the duck.
  else if (s.key === "stuck" && isOn(c))
    actions = stopRun
      ? [
          {
            kind: "stop_run",
            label: "Stop its run",
            primary: true,
            disabled: false,
          },
          stop,
        ]
      : [stop];
  // Only these have nothing to press. The page used to ask for a desktop that
  // was set up as well, so a computer that was on while somebody took its
  // screen, or kept on for somebody's answer, had no buttons here while its
  // row offered Stop.
  else if (["starting", "screen_starting", "stopping"].includes(s.key))
    hint = "This finishes on its own.";
  else if (isOn(c) && s.key !== "uncertain") {
    actions = [
      forMe(s)
        ? {
            kind: "screen",
            label: "Go to screen",
            primary: true,
            disabled: false,
          }
        : {
            kind: "watch",
            label: "Watch the screen",
            primary: true,
            disabled: false,
          },
      stop,
    ];
    hint = "Watching keeps it on. You can take control from there.";
  } else if (duck) {
    actions = [start];
    if (c?.state !== "creation_uncertain" && !blocked)
      hint =
        "Takes about a minute. Once it is on, you can watch it or take control here.";
  }
  return {
    title: duck ? duck.name + "'s computer" : "This computer",
    on: isOn(c),
    sub: [
      duck ? (duck.removed ? "No longer on the team" : duck.role) : "",
      c?.used_today >= 60 ? duration(c.used_today) + " used today" : "",
    ]
      .filter(Boolean)
      .join(" · "),
    headline,
    sentence,
    stopRun,
    // The card showed a computer's error too. The error state says it as its
    // sentence already.
    error: c?.error && c.state !== "error" && !(
      !c.request_id && c.error.startsWith("This computer has restarted or stopped since you were asked")
    ) ? c.error : null,
    picture: pictureFor(duck, c, s),
    actions,
    hint,
    blocked: actions.some((a) => a.kind === "start") ? blocked : null,
    forMe: forMe(s),
    workHeading: isOn(c) ? "Working for" : "Last work",
    work: workCard(c?.work, data, duck),
  };
}

// The last picture of its screen, and what to say over it.
function pictureFor(duck, c, s) {
  const D = duck?.name || "this duck",
    shot = c?.screenshot_at;
  // No old picture at all: it would show a desktop that is not there.
  if (s.key === "failed")
    return { kind: "noscreen", big: "No screen on this computer." };
  if (!c || ["archived", "not_started"].includes(c.state))
    return {
      kind: "off",
      grey: true,
      big: "Off",
      small: shot ? "Last picture, " + fmtWhen(shot) : "No picture yet",
      aria: shot
        ? "Last picture of " +
          D +
          "'s screen, from " +
          fmtWhen(shot) +
          ", greyed out because the computer is off"
        : D + "'s computer is off. There is no picture of its screen yet.",
    };
  const over = (kind, big) => ({
    kind,
    grey: true,
    big,
    aria: D + "'s screen: " + big,
  });
  if (s.key === "screen_starting" || coming.includes(c.state))
    return over("busy", "Starting…");
  if (c.state === "archiving") return over("busy", "Stopping…");
  if (c.state === "creation_uncertain") return over("alert", "Needs a look");
  if (!isLive(c)) return over("alert", "Something went wrong");
  if (!shot)
    return {
      kind: "first",
      big: "The first picture of this screen appears in a moment.",
    };
  const refresh = !!(c.photographing && !c.human_control);
  return {
    kind: "live",
    refresh,
    aria: (forMe(s) ? "Go to " : "Watch ") + D + "'s screen",
    label: refresh
      ? "Live · a new picture every second"
      : "Last picture, " +
        fmtWhen(shot) +
        (c.human_control
          ? " · no new pictures while someone is on it"
          : c.request_id
            ? " · no new pictures while " + D + " waits for a person"
            : ""),
  };
}

// Stopping asks first, in these words, in this order.
export function stopQuestions(c, duck, data) {
  const me = data.user?.id,
    D = duck?.name || "This duck",
    asked = [];
  // Your own hold on another device is not somebody else.
  if (c.human_control && c.human_control.user_id !== me)
    asked.push(
      nameOf(c.human_control.user_id, data) +
        " is on this computer's screen right now. Stopping it closes their session and loses anything they have not saved. Stop anyway?",
    );
  // The moment a stop does the most harm: the duck froze a page for somebody
  // - a code, a password - and stopping throws that page away.
  if (c.request_id && c.request_kind !== "takeover")
    asked.push(
      D +
        " is waiting for " +
        (c.request_user_id === me
          ? "you"
          : (data.members || []).find((m) => m.id === c.request_user_id)
              ?.name || "somebody") +
        " on this screen. Stopping it throws away the page they need, and " +
        D +
        " will have to ask again. Stop anyway?",
    );
  if (c.duck_working)
    asked.push(
      D +
        " is working on this computer right now. Stopping it saves the disk but ends what it is doing. Stop anyway?",
    );
  return asked;
}

// One line of today's history. Names, as the Activity log uses them.
export function historyLine(e, data, duck, config) {
  const who = e.user_id ? nameOf(e.user_id, data) : null,
    D = duck?.name || "the duck";
  const line = (icon, words, place = null) => ({ icon, words, place });
  switch (e.kind) {
    case "started":
      if (who) return line("play", who + " started it");
      if (e.place)
        return line("play", D + " started it for ", {
          words: placeWords(e.place, data, duck),
          to: placeRoute(e.place, data),
        });
      return line("play", "It started");
    case "stopped":
      return line("square", who ? who + " stopped it" : "It stopped");
    case "stopped_idle":
      return line(
        "power",
        "Stopped by itself after " +
          plural(
            Math.round((config?.idle_seconds ?? COMPUTER_IDLE_SECONDS) / 60),
            "idle minute",
          ),
      );
    case "stopped_long":
      return line(
        "power",
        "Stopped by itself after " +
          plural(Math.round((config?.session_minutes ?? 480) / 60), "hour") +
          " on",
      );
    case "stopped_left":
      return line("power", "Stopped by itself: nobody came back to the screen");
    case "stopped_off":
      return line(
        "power",
        who
          ? who + " turned computers off, so it stopped"
          : "Stopped: computers are off for this company",
      );
    case "stopped_paused":
      return line("power", "Stopped: the flock was paused");
    case "stopped_not_allowed":
      return line(
        "power",
        who
          ? who + " took away " + D + "'s computer, so it stopped"
          : "Stopped: " + D + " may not have a computer",
      );
    case "stopped_removed":
      return line("power", "Stopped: " + D + " was taken off the team");
    case "took":
      return line("hand", (who || "Someone") + " took the screen");
    case "gave_back":
      return line(
        "undo",
        who
          ? who + " gave the screen back"
          : "The screen went back to " + D + ": nobody came back to it",
      );
    default:
      return line("power", "It stopped");
  }
}
