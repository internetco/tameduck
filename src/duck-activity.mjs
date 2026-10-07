export const activityStates = {
  working: "Working",
  waiting_input: "Waiting for input",
  queued: "Queued",
  waiting_duck: "Waiting for teammate replies",
  needs_you: "Needs you",
  waiting_approval: "Waiting for approval",
};

export function activityLabel(item) {
  if (item.state === "waiting_duck" && item.waiting_for?.length) {
    const names = [
      ...new Set(item.waiting_for.map((d) => d.name).filter(Boolean)),
    ];
    if (names.length) return "Waiting for " + names.join(", ");
  }
  return activityStates[item.state] || "Checking status";
}

export function duckActivitySummary(items = []) {
  if (!items.length) return "No active tasks";
  if (items.length === 1) return activityLabel(items[0]);
  const counts = {};
  for (const item of items) counts[item.state] = (counts[item.state] || 0) + 1;
  const labels = {
    needs_you: "need you",
    waiting_approval: "awaiting approval",
    working: "working",
    waiting_input: "waiting for input",
    waiting_duck: "waiting for ducks",
    queued: "queued",
  };
  return (
    Object.entries(labels)
      .filter(([key]) => counts[key])
      .map(([key, label]) => `${counts[key]} ${label}`)
      .join(" · ") || `${items.length} active tasks`
  );
}

// What a duck's card on the Team page says about it, in one line. The Activity
// tab is the source of truth for what a duck is doing, so the words are its
// words - a second vocabulary for the same states would only disagree with it.
// This decides which piece of work leads when there is more than one, what the
// card says underneath, and where its button goes; the depth stays over there.
export function duckCardState(items = []) {
  if (!items.length) return { text: "Ready" };
  const lead =
    items.find((item) => item.state === "needs_you") ||
    items.find((item) => item.state === "waiting_approval") ||
    items[0];
  const attention =
    lead.state === "needs_you" || lead.state === "waiting_approval";
  return {
    text: duckActivitySummary(items),
    // A duck that is stuck: what it is stuck on is the thing worth reading.
    // Any other duck: the work it is on.
    say: (
      (lead.state === "needs_you" && lead.blocking_reason) ||
      lead.title ||
      ""
    )
      .replace(/\\([\\`*_{}\[\]()#+.!|<>~-])/g, "$1")
      .replace(/!?\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/([*_\x60~])/g, "")
      .replace(/<[^>]*>/g, ""),
    attention,
    // The green dot means a duck is at it right now. A duck that is queued,
    // or waiting for a person or another duck, says so in words and stays
    // quiet: a dot there would read as "all fine" over work that is stopped.
    working: !attention && items.some((item) => item.state === "working"),
    // Where Answer goes. Something waiting for a yes is decided on the Needs
    // you page, and everything else where the work itself is.
    answer: !attention
      ? null
      : lead.state === "waiting_approval"
        ? { type: "inbox" }
        : lead.destination,
  };
}

// The one short line a duck's row in the sidebar carries under its name. It
// reads the same duckCardState() the Team card reads, so the row and the card
// can never say different things about the same duck. There is room for one
// fact, so the order is what the duck is waiting on you for, then what it is
// doing, then the messages nobody has read.
export function duckRowSignal(items = [], unread = 0) {
  const waiting = Math.max(0, Math.trunc(Number(unread)) || 0);
  if (items.length) {
    const state = duckCardState(items);
    const say = state.say || "";
    return {
      kind: state.attention ? "attention" : state.working ? "working" : "busy",
      // The Activity tab's own words, so nothing here is kept in step by hand.
      lead: state.text,
      // A duck waiting on you wears its words as a chip, and what it is
      // waiting about simply follows, the way the Team card sets the two side
      // by side. Otherwise the line is a sentence: "Working on the Q3 supplier
      // list" is how a person says it out loud, while a duck with several jobs
      // says "1 working · 1 queued", which no preposition fits, so that one
      // takes the middle dot the summary itself uses.
      about: !say
        ? ""
        : state.attention
          ? say
          : (state.text === activityStates.working ? "on " : "· ") + say,
      unread: waiting,
    };
  }
  if (waiting > 0)
    return {
      kind: "unread",
      lead: `${waiting} new`,
      about: waiting === 1 ? "message" : "messages",
      // The figure is the line, so it is not also written at the end of it.
      unread: 0,
    };
  return null;
}

export function activityAge(value, current = Date.now()) {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return null;
  const seconds = Math.max(0, Math.floor((current - time) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} ${days === 1 ? "day" : "days"} ago`;
}
