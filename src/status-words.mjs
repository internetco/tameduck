// What TameDuck says about itself: the one strip at the top of the page, and
// the page that opens a company. The words and the timing live here, away
// from React, so a test can read them.
//
// Before this there were three messages in three places: a yellow strip in
// fixed colours, a grey update strip, and a toast in the browser's own words
// ("Failed to fetch") raised by every failed check, twelve seconds apart, over
// the message box. Now a check that fails says so once, in the strip, and
// tries again by itself.

// A request that never reached the server is "offline". A server that
// answered, but with trouble, is "down". Of everything a server says when it
// fails, only its sentence about being too busy is meant for people, so that
// one is passed on and the rest is not.
export function troubleFrom(error) {
  if (error?.offline) return { kind: "offline", say: "" };
  return {
    kind: "down",
    say: error?.status === 429 ? String(error.message || "") : "",
  };
}

// Twenty seconds, then further apart, never more than a minute. It used to be
// every three seconds for as long as it took.
const WAITS = [20, 30, 45, 60];
export const retryWait = (tries) =>
  WAITS[Math.min(Math.max(tries, 1), WAITS.length) - 1] * 1000;

// One more check that failed: count it, and say when the next one is.
export function noteFailure(previous, error, now) {
  const tries = (previous?.tries || 0) + 1;
  return {
    ...troubleFrom(error),
    since: previous?.since || now,
    tries,
    next: now + retryWait(tries),
  };
}

export const secondsUntil = (at, now) =>
  Math.max(1, Math.ceil((at - now) / 1000));
// The seconds to the next try, never more than the wait that was planned: the
// page's clock moves once a second, so the moment a try fails it can hold a
// time up to a second old, and the wait read "61 seconds".
const waitOf = (trouble, now) =>
  Math.min(secondsUntil(trouble.next, now), retryWait(trouble.tries) / 1000);
export const inSeconds = (n) => n + (n === 1 ? " second" : " seconds");
export const triesSince = (tries, time) =>
  tries + (tries === 1 ? " try" : " tries") + " since " + time;

// The one thing the strip says, most urgent first. Nothing to say is null.
// `wait` is the seconds to the next try, when there is one; the strip counts
// it down after `waitLead`.
export function stripMessage({ trouble, backOnline, update, now, clock }) {
  if (trouble?.kind === "offline")
    return {
      key: "offline",
      tone: "off",
      title: "You’re offline",
      text:
        "Since " +
        clock(trouble.since) +
        ". TameDuck reconnects by itself. What you type is kept.",
      actions: ["try"],
    };
  if (trouble)
    return {
      key: "down",
      tone: "off",
      // Too busy is an answer, so it is not said as no answer. The sentence
      // under it is the server's own.
      title: trouble.say ? "TameDuck is busy" : "TameDuck isn’t answering",
      text: trouble.say || "The problem is on our side, not yours.",
      waitLead: "Next try in",
      wait: waitOf(trouble, now),
      actions: ["try"],
    };
  if (backOnline)
    return {
      key: "back",
      tone: "ok",
      title: "Back online",
      text: "Everything is up to date.",
      actions: [],
    };
  if (update)
    return {
      key: "update",
      tone: "up",
      title: "A new version of TameDuck is ready",
      text: "Refresh when it suits you. What you’ve typed and not sent stays in its box.",
      actions: ["later", "refresh"],
    };
  return null;
}

// The page shown while a company opens, and in its place when it will not.
//   name     the company being opened, or null when this browser does not
//            know its name yet
//   current  the company that is still open, when this was a switch
//   other    another company to offer instead, from the last visit
export function openingPage({
  opening,
  trouble,
  name,
  current,
  other,
  now,
  clock,
}) {
  const what = name || "TameDuck";
  if (opening || !trouble)
    return { opening: true, text: "Opening " + what + "…" };
  const offline = trouble.kind === "offline";
  if (current)
    return {
      title: what + " didn’t open",
      text:
        (offline
          ? "You’re offline."
          : trouble.say || "TameDuck had a problem on its side, not yours.") +
        " " +
        current.name +
        " is still open.",
      actions: ["again", "back"],
    };
  return {
    title: what + " didn’t open",
    text: offline
      ? "You’re offline."
      : trouble.say || "TameDuck had a problem on its side, not yours.",
    waitLead: offline ? "TameDuck tries again in" : "It tries again in",
    wait: waitOf(trouble, now),
    foot: triesSince(trouble.tries, clock(trouble.since)),
    // Nothing else would work without a connection: another company and
    // signing out both need the server.
    actions: offline
      ? ["try"]
      : ["try", ...(other ? ["other"] : []), "signout"],
  };
}
