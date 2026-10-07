import { HumanInputCard } from "./HumanInput.jsx";
import { saysHandBack } from "./human-input-words.mjs";
import { nativeStreamState, decodedPlaybackProgress } from "./native-stream-state.mjs";
import { desktopReturnRoute } from "./navigation.mjs";
import { useAIReady, withoutAIWords } from "./use-ai.mjs";
import { canConnectAI } from "../shared/ai-access.mjs";
import React, { useEffect, useId, useRef, useState } from "react";
import RFB from "@novnc/novnc";
import {
  ArrowLeft,
  Hand,
  RefreshCw,
  Maximize,
  ClipboardPaste,
  Camera,
  Undo2,
} from "lucide-react";
import { api, Button, Avatar, useCountsAsDialog } from "./ui.jsx";
import "./desktop-full.css";
// Taking over a paused computer can take a couple of minutes, almost all of it
// waiting for the machine itself. The server reports which step it is on, so say
// that rather than showing one unchanging message the whole time.
// How long the viewer gets to come back on its own before the screen stops
// calling it a blip and asks the person to reconnect.
// How long after somebody last did anything we still count them as watching.
const stillHereMs = 10 * 60000;
// A computer that is on, whatever it happens to be doing this second.
const liveStates = ["ready", "idle", "running"];
// When the picture was taken. A bare clock time made a screen from this morning
// look like one from a minute ago.
const seenAt = (at) => {
  const when = new Date(at),
    clock = when.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return when.toDateString() === new Date().toDateString()
    ? clock
    : when.toLocaleDateString([], { day: "numeric", month: "short" }) +
        ", " +
        clock;
};
const preparingLabel = (phase) =>
  phase === "pausing"
    ? "Pausing the duck…"
    : phase === "waking"
      ? "Waking the computer… this takes a minute from paused"
      : phase === "desktop"
        ? "Starting the desktop…"
        : "Preparing desktop…";
// The lease outlives several missed beats, so a blip on the way to the server is
// not the end of a session: keep renewing until the lease genuinely cannot be
// saved. Only the server refusing this generation ends it immediately.
const leaseGraceMs = 70000;
// Whether the person at this end is on a Mac, and so is holding a keyboard
// whose shortcut key is not the one the desktop over there listens to. Read
// once: it cannot change while the page is open.
const onAMac = /Mac|iPhone|iPad/i.test(
  globalThis.navigator?.userAgentData?.platform ||
    globalThis.navigator?.platform ||
    globalThis.navigator?.userAgent ||
    "",
);
function heartbeat(computerId, generation, setError) {
  let lastRenewed = Date.now();
  return async () => {
    try {
      await api("/computers/" + computerId + "/control/heartbeat", "POST", {
        generation,
      });
      lastRenewed = Date.now();
      return true;
    } catch (e) {
      // "Slow down" and "took too long" are not the server taking the screen
      // away; treating them as a refusal ended a takeover mid-task over one
      // busy minute. They wait out the grace window like any other hiccup.
      const busy = [408, 429].includes(e.status);
      const refused = !busy && e.status >= 400 && e.status < 500;
      if (refused || Date.now() - lastRenewed > leaseGraceMs) {
        setError(e.message);
        // Which kind of failure, because they need opposite things said about
        // them. A refusal is the server's answer - the lease was taken, the
        // duck was removed from the team, computers were switched off,
        // permission was withdrawn, the session expired - and the caller must
        // not paint "Reconnect to continue" over it, which is the one action
        // that cannot work for any of those. Anything else really is the
        // connection, and reconnecting really is the answer.
        return refused ? "refused" : "lost";
      }
      return true;
    }
  };
}
export default function ComputerControl({
  computer: c,
  requestId,
  checkpointToken,
  returnTo,
  duck,
  data,
  action,
  notify,
  go,
  // Arrived by clicking a picture of the screen, which is asking for it.
  autoTake = false,
}) {
  // The duck is looked up by id from a list that may not have it - a row that
  // has not arrived yet, or one this person cannot see. Every other screen
  // falls back; this one read the name straight off it in ten places, so one
  // unresolved row took the whole desktop page down rather than showing it
  // with a plain name on top.
  const duckName = duck?.name || "Your duck";
  const ai = useAIReady(data.company.id);
  const host = useRef(),
    nativeFrame = useRef(),
    rfb = useRef(),
    retryTimer = useRef(null),
    retryDeadline = useRef(0),
    recovery = useRef(null),
    takeRef = useRef(null),
    taking = useRef(false),
    lastActivity = useRef(Date.now());
  const [version, setVersion] = useState(0),
    [status, setStatus] = useState("idle"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [paste, setPaste] = useState(""),
    [pasting, setPasting] = useState(false),
    [showPaste, setShowPaste] = useState(false),
    [streamStarting, setStreamStarting] = useState(false),
    // This tab took the screen and has not given it back, whatever the last
    // workspace refresh happened to say.
    [held, setHeld] = useState(false),
    [viewerUrl, setViewerUrl] = useState("");
  // The same person, not the same browser. Tied to the exact session cookie,
  // your own takeover from another device read as somebody else holding it:
  // the phone told you that you had the screen and to wait for yourself to
  // hand it back, with no way to take it, no way to hand it back, and not even
  // a still, because nothing is photographed while a screen is held. Whether
  // this particular tab is the one driving is decided by the generation below,
  // which is what actually tells two devices apart.
  const mine = c.human_control?.user_id === data.user.id;
  // The duck is waiting for this person on this screen. This page is where
  // they answer it, however they arrived - the Computers card's main button,
  // an old chat picture, or a page already open when the duck asked. Only the
  // one link that named the request used to work; every other way in called
  // their own request "This task or request changed" and took Take control
  // away, at the moment the duck needed them.
  const forMe = (data.human_requests || []).find((r) => r.id === c.request_id);
  const answerable = (r) =>
    !!r &&
    ["pending", "preparing", "desktop", "submitting"].includes(r.status) &&
    r.expires > Date.now();
  const [binding, setBinding] = useState(() => ({
    // Pinned only when the link named a request, or the request is this
    // person's own. Opening a screen a colleague held pinned the colleague's
    // request, so when they handed it back the page called that "This task or
    // request changed" for good, with Take control greyed out - on the page
    // that had just promised the screen would come free.
    request_id:
      requestId ||
      (!checkpointToken && (mine || answerable(forMe)) ? c.request_id : null),
    checkpoint_token: checkpointToken || c.checkpoint_token,
    generation: null,
  }));
  const request = (data.human_requests || []).find(
    (r) => r.id === binding.request_id,
  );
  const ownFailedRequest =
    !c.request_id &&
    !!request &&
    request.id === binding.request_id &&
    request.kind === "takeover" &&
    !request.job_id &&
    ["parked", "stale", "expired"].includes(request.status);
  const generation = binding.generation;
  // The screen moves on every time the duck does anything, and the token for it
  // moves with it. Holding on to the one from the moment this page opened meant
  // an ordinary working duck made "Take control" disable itself behind a warning
  // that the screen had been replaced — which it had not. A link that pinned a
  // particular moment still pins it; otherwise this follows the live screen.
  const pinned = !!checkpointToken;
  useEffect(() => {
    if (pinned || busy || binding.request_id || binding.generation) return;
    if (c.human_control) return;
    if (binding.checkpoint_token === c.checkpoint_token) return;
    setBinding((b) => ({ ...b, checkpoint_token: c.checkpoint_token }));
  }, [
    pinned,
    busy,
    binding.request_id,
    binding.generation,
    binding.checkpoint_token,
    c.checkpoint_token,
    c.human_control,
  ]);
  // And when the duck asks while the page is already open.
  useEffect(() => {
    if (pinned || busy || binding.request_id || binding.generation) return;
    if (!answerable(forMe)) return;
    setBinding((b) => ({ ...b, request_id: forMe.id }));
  }, [pinned, busy, binding.request_id, binding.generation, forMe?.id, forMe?.status]);
  // A take can create its request before the state refresh reaches this tab.
  // Do not flash a replacement warning during that short, owned transition.
  const changed =
    !busy &&
    (binding.request_id
      ? c.request_id !== binding.request_id && !ownFailedRequest
      : // Somebody else taking or being asked for the screen is not this
        // task changing: heldByOther and askedOfSomeoneElse below say it in
        // words. A request for this person is taken up above, and one that
        // can no longer be answered is said below.
        binding.checkpoint_token !== c.checkpoint_token);
  // A request for this person that can no longer be answered - the server
  // restarted under it, or its time ran out - still holds the screen.
  const stuckOnMe = !binding.request_id && !!forMe && !answerable(forMe) && !mine;
  // A duck can ask one particular person to take the screen. Anybody else who
  // opens this page saw "Ready when you are" and a live Take control, and got
  // "Only the person asked for this input can answer it" after pressing it.
  const heldByOther =
    !!c.human_control && !mine && c.human_control.expires > Date.now();
  // Every takeover opens a request, and this list only ever holds the asking
  // person's own, so to anybody else a colleague simply driving the machine
  // looked exactly like a duck waiting for someone who had been asked. They
  // were told the duck was waiting for a teammate to arrive while their
  // colleague was on it - and the toolbar beside it said "Another person has
  // control". Somebody is on it takes precedence over somebody was asked.
  const askedOfSomeoneElse =
    !!c.request_id && !request && !mine && !busy && !held && !heldByOther;
  // One answer to "can this person take the screen right now". The header
  // offered it while somebody else was holding the screen,
  // and pressing it came back "Another person has control of this computer".
  // Taking this screen would have to start the computer, and with no AI there
  // is nothing for it to do. The server refuses; this says why before anybody
  // presses. Somebody who already holds the screen is never shown this - their
  // Reconnect has to keep working - and neither is a machine that is up.
  const asleep =
    !c.state || ["not_started", "archived", "archiving"].includes(c.state);
  const noAIToWake = ai === false && !mine && asleep;
  // The same for the other things that keep a stopped computer stopped. Take
  // control was offered for all of them and each was refused once pressed -
  // "The company is paused." in words used nowhere else. The Computers card
  // already says these; this says them the same way.
  const config = data.computers;
  const wontWake =
    !mine && asleep && !noAIToWake
      ? data.company?.paused
        ? "Your flock is paused, so computers stay off." +
          (data.permissions.company
            ? " Resume it in Settings to take this screen."
            : " Ask an owner or admin to resume it.")
        : config && !config.enabled
          ? "Computers are paused for this company."
          : config && !(config.allowed_ducks || []).includes(c.duck_id)
            ? duckName + " is not allowed a computer."
            : ""
      : "";
  const cannotTake =
    changed ||
    askedOfSomeoneElse ||
    heldByOther ||
    noAIToWake ||
    !!wontWake ||
    stuckOnMe;
  // Why not, in a sentence. The panel used to invite somebody to step in right
  // beside a button it had greyed out, which reads as the product being broken
  // rather than as somebody else being on the machine.
  const holder = (data.members || []).find(
    (m) => m.id === c.human_control?.user_id,
  );
  const whyNot = changed
    ? "This task or request changed, so the screen you were looking at is no longer the current one."
    : askedOfSomeoneElse
      ? c.request_kind === "takeover"
        ? "Somebody else is taking this screen. It comes free when they hand it back."
        : duckName +
          " asked a teammate to take this screen. It is waiting for them."
      : heldByOther
        ? (holder?.name || "Someone else") +
          " has this screen right now. It comes free when they hand it back."
        : noAIToWake
          ? "Nothing can start this computer until an AI is connected."
          : wontWake ||
            (stuckOnMe
              ? duckName +
                " is stuck on a request that can no longer be answered. Stop its run on Computers to free the screen."
              : "");
  const payload = {
    ...binding,
    generation: binding.generation || c.human_control?.generation,
  };
  // Until the workspace refresh comes back carrying the new lease, the only
  // proof this tab holds the screen is the answer the take itself gave. Waiting
  // for the refresh meant a single failed or throttled one left the desktop
  // beating to nobody, and it was dropped a minute later with nothing said.
  const active =
    !changed &&
    !!generation &&
    (c.human_control
      ? mine &&
        generation === c.human_control.generation &&
        c.human_control.state === "live"
      : held);
  // Their screen, and held from this device. The same person on another device
  // is still "mine", but the server only lets the device that took it hand it
  // back, so a phone left behind was locked in the window below with a Done
  // that could only fail.
  const here =
    mine &&
    !!c.human_control &&
    (c.human_control.owned_by_session ||
      c.human_control.generation === generation);
  const elsewhere = mine && !!c.human_control && !here;
  // The screen is this person's, or on its way to them: from here until it is
  // handed back, the duck's desktop fills the window under one bar whose only
  // way out is handing it back. Small corner buttons to take and to hand back
  // were missed, and the duck stayed paused until its wait ran out.
  const holding = !changed && (c.human_control ? here : held);
  const fullWindow = holding || (streamStarting && !changed && !heldByOther);
  const titleId = useId();
  const fullRef = useRef(null),
    releaseRef = useRef(null),
    autoTook = useRef(false);
  const [now, setNow] = useState(Date.now());
  // Hand back needs a lease that is theirs and a wait that has not run out:
  // the server refuses both a lease still preparing and a request past its
  // time, and a Done button that could only fail kept somebody in this window.
  const waitOver = !!request && request.expires <= now;
  const canHandBack =
    here && c.human_control.state !== "preparing" && !waitOver;
  // The take is still under way, and there is no lease yet to hand back.
  const preparing =
    fullWindow &&
    !canHandBack &&
    !waitOver &&
    (busy || streamStarting || c.human_control?.state === "preparing");
  useCountsAsDialog(fullWindow);
  useEffect(() => {
    if (!fullWindow) return;
    const box = fullRef.current;
    box?.focus();
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 5000);
    // The app's menu and sidebar are still on the page under this window, and
    // Tab walked into them unseen, where one Enter left the duck paused behind
    // a page nobody could see. Everything around it is out of reach until the
    // window closes, except a message somebody still has to be able to read.
    const shut = [];
    for (
      let el = box;
      el?.parentElement && el !== document.body;
      el = el.parentElement
    )
      for (const other of el.parentElement.children)
        if (
          other !== el &&
          !other.inert &&
          !other.classList.contains("toast")
        ) {
          other.inert = true;
          shut.push(other);
        }
    return () => {
      clearInterval(t);
      for (const other of shut) other.inert = false;
    };
  }, [fullWindow]);
  // Clicking a picture of the screen is asking for it, so take it rather than
  // landing on a page with one more button to find.
  useEffect(() => {
    if (!autoTake || autoTook.current || active || busy || cannotTake) return;
    autoTook.current = true;
    takeRef.current?.();
  }, [autoTake, active, busy, cannotTake]);
  // Back would leave the duck paused behind a page that no longer shows it, so
  // it asks first, and handing back is the answer that leaves. While the take
  // is still under way there is nothing to hand back yet, so it says what
  // leaving costs instead.
  const guardBack = useRef(null);
  guardBack.current = !fullWindow
    ? null
    : canHandBack
      ? {
          ask:
            "Hand the screen back to " +
            duckName +
            "? It carries on from where you left it.",
          handBack: true,
        }
      : preparing
        ? { ask: "Leave now? " + duckName + " stays paused for a minute or two." }
        : null;
  // The app's own Back handler was there first and leaves the page before this
  // one hears about it, so Back first lands on a copy of this same address.
  // Leaving replaces that copy, so Back from the next page is not a second
  // visit to this one.
  const guarded = useRef(false);
  useEffect(() => {
    if (!fullWindow || guarded.current) return;
    guarded.current = true;
    history.pushState(history.state, "", location.pathname + location.search);
  }, [fullWindow]);
  useEffect(() => {
    const onBack = (event) => {
      if (!guarded.current) return;
      event.stopImmediatePropagation();
      const guard = guardBack.current;
      // Nothing left to ask about: on past this address to the page before.
      if (!guard) {
        guarded.current = false;
        history.back();
        return;
      }
      history.pushState(history.state, "", location.pathname + location.search);
      if (!window.confirm(guard.ask)) return;
      if (guard.handBack) releaseRef.current?.();
      else {
        guarded.current = false;
        history.go(-2);
      }
    };
    window.addEventListener("popstate", onBack, true);
    return () => window.removeEventListener("popstate", onBack, true);
  }, []);
  // Somebody on this page wants to see the screen. Say so, because it is now the
  // whole reason pictures are taken at all: a machine is photographed while a
  // duck is working on it or while somebody says they are watching, and not
  // otherwise. Saying it is watched is also what stops the machine going to
  // sleep under them.
  const watchable = Boolean(
    !active && !busy && !streamStarting && c?.screenshot_at && liveStates.includes(c.state),
  );
  useEffect(() => {
    if (!watchable) return;
    // Follow the person, not the open tab. Saying "somebody is watching" keeps
    // the machine awake and billing, and a page left open on a second monitor
    // over lunch is not somebody watching.
    let lastSeen = Date.now();
    const seen = () => (lastSeen = Date.now());
    for (const e of ["pointermove", "keydown", "wheel", "pointerdown"])
      window.addEventListener(e, seen, { passive: true });
    const ping = () => {
      if (document.hidden || Date.now() - lastSeen > stillHereMs) return;
      api("/computers/" + c.id + "/keep-awake", "POST", {}).catch(() => {});
    };
    ping();
    const timer = setInterval(ping, 60000);
    return () => {
      clearInterval(timer);
      for (const e of ["pointermove", "keydown", "wheel", "pointerdown"])
        window.removeEventListener(e, seen);
    };
  }, [watchable, c.id]);
  takeRef.current = take;
  releaseRef.current = release;
  useEffect(() => () => clearTimeout(retryTimer.current), []);
  async function take({ automatic = false } = {}) {
    if (taking.current) return;
    taking.current = true;
    clearTimeout(retryTimer.current);
    if (!retryDeadline.current) retryDeadline.current = Date.now() + 120000;
    setBusy(true);
    setStreamStarting(true);
    setError("");
    try {
      // A request that already failed has been retired, so asking for it again
      // is refused. Trying again means starting a fresh one against the screen
      // as it stands now, which is what the person pressing this expects.
      const body = ownFailedRequest
        ? {
            request_id: null,
            checkpoint_token: c.checkpoint_token,
            generation: null,
            transport: "native",
          }
        : { ...payload, transport: "native" };
      // Call the endpoint outside App.action so a failed preparation can carry
      // its durable request id into this screen before the refresh.
      const r = await api("/computers/" + c.id + "/control/take", "POST", body);
      if (r) {
        setViewerUrl(r.viewer_url || "");
        setBinding((b) => ({
          ...b,
          request_id: r.request_id,
          generation: r.generation,
        }));
        lastActivity.current = Date.now();
        setHeld(!!r.generation);
        retryDeadline.current = 0;
        recovery.current = {
          generation: r.generation,
          state:
            automatic && recovery.current
              ? recovery.current.state.nextTransport(Date.now())
              : nativeStreamState(),
        };
        setVersion((v) => v + 1);
      }
      await action(async () => r || {});
    } catch (e) {
      setHeld(false);
      if (e.request_id) setBinding((b) => ({ ...b, request_id: e.request_id }));
      const starting = /desktop is still (starting|preparing)|desktop is preparing/i.test(e.message || "");
      if (starting) {
        if (Date.now() >= retryDeadline.current) {
          retryDeadline.current = 0;
          setStreamStarting(false);
          setError("The computer is taking longer than expected. Reconnect to try again.");
        } else {
          setStatus("starting");
          setError("");
          retryTimer.current = setTimeout(() => takeRef.current?.({ automatic }), 2000);
        }
      } else {
        retryDeadline.current = 0;
        setStreamStarting(false);
        setError(e.message);
      }
      await action(async () => ({}));
    } finally {
      taking.current = false;
      setBusy(false);
    }
  }
  async function release() {
    setBusy(true);
    try {
      // payload's generation, not this tab's: somebody who reloads the page
      // still holds the screen, and had no way to give it back.
      const r = await action(() =>
        api("/computers/" + c.id + "/control/release", "POST", {
          generation: payload.generation,
        }),
      );
      if (r) {
        setHeld(false);
        rfb.current?.disconnect();
        go(
          desktopReturnRoute(returnTo, data.company.id) || {
            type: "computers",
          },
          { replace: guarded.current },
        );
        guarded.current = false;
      }
    } finally {
      setBusy(false);
    }
  }
  // Nothing left to hand back: the lease ran out or was taken away on the
  // server, so the duck is not waiting on this page any more.
  function leave() {
    clearTimeout(retryTimer.current);
    setHeld(false);
    go(desktopReturnRoute(returnTo, data.company.id) || { type: "computers" }, {
      replace: guarded.current,
    });
    guarded.current = false;
  }
  useEffect(() => {
    if (!active) return;
    // A stream this generation has already given up on does not start again on
    // its own: once health is stopped the beat returns straight away and tick()
    // returns null from then on. Re-arming "connecting" on every re-render
    // painted "we will reconnect automatically" over the server's own refusal,
    // and took away the one button that could have helped - for good, because
    // nothing was ever going to clear it.
    const givenUp =
      !!viewerUrl &&
      recovery.current?.generation === generation &&
      recovery.current.state.stopped;
    setStatus(givenUp ? "disconnected" : "connecting");
    setStreamStarting(!givenUp);
    if (viewerUrl) {
      if (recovery.current?.generation !== generation)
        recovery.current = { generation, state: nativeStreamState() };
      const health = recovery.current.state;
      const receive = (event) => {
        if (event.origin !== location.origin ||
            event.source !== nativeFrame.current?.contentWindow) return;
        if (["stream-error", "stream-disconnected"].includes(event.data?.type)) {
          health.transportDisconnected(Date.now());
          if (!health.stopped) {
            setStatus("connecting");
            setStreamStarting(true);
            setError("");
          }
        }
        // Playback itself confirms recovery; the provider's connection events
        // can arrive before any usable picture and may omit recovery entirely.
      };
      window.addEventListener("message", receive);
      // The keystroke reaches the machine, but its clipboard is not this one, so
      // Ctrl+V there pastes whatever the machine last copied rather than what
      // the person just copied here. Carry the text across instead: take the
      // paste as the browser reports it and type it on the far side.
      const notConnected =
        "The screen is not connected right now. Reconnect, then paste.";
      const send = async (text) => {
        // Windows clipboard text uses CRLF. The remote typing tool expects one
        // newline per line break, so normalize it before crossing machines.
        text = text.replace(/\r\n/g, "\n");
        if (!text) return;
        // Typing at a screen that is not there goes nowhere and says nothing.
        // The machine is perfectly happy to be typed at through a dead viewer,
        // so the only thing that notices is the person, later, when the field
        // they were looking at turns out to be empty.
        if (!health.connected) {
          setError(notConnected);
          return;
        }
        try {
          await api("/computers/" + c.id + "/control/type", "POST", {
            text,
            generation,
          });
          // A paste that failed left its red box on screen for good, so a later
          // paste that worked still looked broken.
          setError("");
          lastActivity.current = Date.now();
        } catch (err) {
          setError(err.message);
        }
      };
      const onPaste = (event) => {
        const text = event.clipboardData?.getData("text") || "";
        if (!text) return;
        event.preventDefault();
        send(text);
      };
      // The provider focuses its #input when a person clicks the screen. That
      // is its keyboard capture target, not a field in this page. Other inputs
      // in the provider viewer, and our own Paste text box, stay local.
      const ownKeystroke = (event) => {
        const doc = nativeFrame.current?.contentDocument;
        const target = event.target;
        if (!doc || !(target === doc || target?.ownerDocument === doc ||
            event.view === doc.defaultView)) return false;
        const tag = target?.tagName?.toLowerCase();
        return !target?.isContentEditable && tag !== "textarea" &&
          (tag !== "input" || target.id === "input");
      };
      const pasted = { current: 0 },
        fallback = { current: 0 };
      const onKey = (event) => {
        if (
          !(event.metaKey || event.ctrlKey) ||
          event.key?.toLowerCase() !== "v" ||
          !ownKeystroke(event)
        )
          return;
        if (event.repeat) {
          event.preventDefault();
          event.stopImmediatePropagation();
          return;
        }
        // Stop the provider forwarding Ctrl+V to a stale remote clipboard,
        // but allow the browser's default paste event. Its clipboardData works
        // even in the desktop app, where clipboard-read permission is denied.
        event.stopImmediatePropagation();
        // Some viewers or browsers still swallow paste. Only there, ask for
        // clipboard-read permission as a fallback and show a useful error if
        // it is refused. Never send the same text twice.
        clearTimeout(fallback.current);
        fallback.current = setTimeout(async () => {
          if (pasted.current > Date.now() - 400) return;
          try {
            const text = await navigator.clipboard.readText();
            if (text) send(text);
          } catch {
            setError(
              "Your browser did not allow reading the clipboard, so nothing was pasted. Allow clipboard access for this site, or use Paste text above.",
            );
          }
        }, 120);
      };
      const watching = new Set();
      const onPasteSeen = (e) => {
        if (!ownKeystroke(e)) return;
        pasted.current = Date.now();
        clearTimeout(fallback.current);
        onPaste(e);
      };
      const onViewerMouseUp = (event) => {
        const doc = nativeFrame.current?.contentDocument;
        if (event.currentTarget !== doc ||
            !event.target?.matches?.("video.video-stream")) return;
        // Safari can deliver the release into a newly focused iframe without
        // delivering the press. The provider then misses its usual focus call
        // and the next keys go nowhere. A real click on the screen still
        // means the person chose remote input; restore only its capture box.
        const capture = doc.getElementById("input");
        if (capture?.tagName === "INPUT" && doc.activeElement !== capture)
          capture.focus({ preventScroll: true });
      };
      const watch = (doc) => {
        if (!doc || watching.has(doc)) return;
        watching.add(doc);
        doc.addEventListener("paste", onPasteSeen, true);
        doc.addEventListener("keydown", onKey, true);
        doc.addEventListener("mouseup", onViewerMouseUp, true);
      };
      watch(document);
      let video = null, sampledTime = null;
      const samplePlayback = () => {
        if (!video) return;
        if (decodedPlaybackProgress(sampledTime, video)) {
          if (health.progress(Date.now())) {
            setStatus("connected");
            setStreamStarting(false);
            setError("");
          }
        }
        sampledTime = video.currentTime;
      };
      const attach = () => {
        const doc = nativeFrame.current?.contentDocument;
        watch(doc);
        const next = doc?.querySelector("video.video-stream");
        if (next !== video) {
          video?.removeEventListener("timeupdate", samplePlayback);
          video = next;
          sampledTime = null;
          video?.addEventListener("timeupdate", samplePlayback);
        }
        samplePlayback();
      };
      const frame = nativeFrame.current;
      frame?.addEventListener("load", attach);
      attach();
      const attachTimer = setInterval(() => {
        attach();
        const next = taking.current ? null : health.tick(Date.now(), !document.hidden);
        if (!health.connected && !health.stopped) {
          setStatus("connecting");
          setStreamStarting(true);
        }
        if (next === "reload") {
          setStreamStarting(true);
          setStatus("connecting");
          setError("");
          // A new provider grant is required after its stream terminates;
          // reloading the old viewer can strand it at a hidden login form.
          takeRef.current?.({ automatic: true });
        } else if (next === "failed") {
          setStreamStarting(false);
          setStatus("disconnected");
          setError("The desktop is taking longer than expected. Reconnect to try again.");
        }
      }, 1000);
      const beat = heartbeat(c.id, generation, setError);
      // Renew for as long as this desktop is open, whether or not the tab is in
      // front. Signing in is exactly the task that sends someone to another
      // window for a password, and pausing the heartbeat there let the lease
      // lapse and killed the desktop they had come back to use. Closing the tab
      // stops these beats, so an abandoned desktop is still released on the
      // server, and the absolute session cap still bounds a tab left open.
      const timer = setInterval(async () => {
        if (health.stopped) return;
        const why = await beat();
        if (why === true) return;
        // A refusal belongs to the lease, not to this effect instance. A
        // re-render landing between the beat and its answer threw the answer
        // away, so the server's "this control session expired" stayed on
        // screen under a banner promising a reconnect that could never come.
        if (recovery.current?.generation !== generation) return;
        health.stop();
        setStatus("disconnected");
        setStreamStarting(false);
        if (why === "lost")
          setError("The desktop connection stopped. Reconnect to continue.");
      }, 20000);
      return () => {
        clearInterval(timer);
        clearInterval(attachTimer);
        clearTimeout(fallback.current);
        frame?.removeEventListener("load", attach);
        video?.removeEventListener("timeupdate", samplePlayback);
        for (const doc of watching) {
          doc.removeEventListener("paste", onPasteSeen, true);
          doc.removeEventListener("keydown", onKey, true);
          doc.removeEventListener("mouseup", onViewerMouseUp, true);
        }
        watching.clear();
        window.removeEventListener("message", receive);
      };
    }
    const client = new RFB(
      host.current,
      (location.protocol === "https:" ? "wss:" : "ws:") +
        "//" +
        location.host +
        "/api/computers/" +
        c.id +
        "/control/stream?generation=" +
        encodeURIComponent(generation),
    );
    rfb.current = client;
    client.scaleViewport = true;
    client.resizeSession = false;
    client.qualityLevel = 6;
    client.compressionLevel = 2;
    let connectedLive = false;
    const connected = () => {
      connectedLive = true;
      setStatus("connected");
      setStreamStarting(false);
      setError("");
    };
    const disconnected = () => {
      connectedLive = false;
      setStatus("disconnected");
    };
    client.addEventListener("connect", connected);
    client.addEventListener("disconnect", disconnected);
    const activity = () => {
      lastActivity.current = Date.now();
    };
    const node = host.current;
    for (const name of ["pointerdown", "keydown", "wheel", "touchstart"])
      node.addEventListener(name, activity, { capture: true, passive: true });
    const beat = heartbeat(c.id, generation, setError);
    // Same reasoning as the native viewer: a hidden tab is not an absent person.
    const timer = setInterval(async () => {
      if (!connectedLive) return;
      if ((await beat()) !== true) client.disconnect();
    }, 20000);
    return () => {
      clearInterval(timer);
      client.removeEventListener("connect", connected);
      client.removeEventListener("disconnect", disconnected);
      client.disconnect();
      rfb.current = null;
      setPaste("");
      for (const name of ["pointerdown", "keydown", "wheel", "touchstart"])
        node.removeEventListener(name, activity, { capture: true });
    };
  }, [c.id, active, version, generation, viewerUrl]);
  // One label for the one control that takes the screen, wherever it sits.
  const takeLabel = ownFailedRequest
    ? "Try again"
    : elsewhere
      ? "Take it here"
      : mine
        ? "Reconnect"
        : "Take control";
  // Anything short of a connected screen can want this. The native viewer's
  // own failure page says "Reconnect to try again", and while active stayed
  // true with the stream never arriving there was no Reconnect anywhere on the
  // page to press.
  const retake =
    !noAIToWake &&
    !wontWake &&
    !streamStarting &&
    (!active || status !== "connected");
  const pasteForm = showPaste && (
    <form
      className="desktop-paste"
      onSubmit={async (e) => {
        e.preventDefault();
        const text = paste;
        if (pasting) return;
        lastActivity.current = Date.now();
        if (viewerUrl) {
          if (status !== "connected") {
            setError(
              "The screen is not connected right now. Reconnect, then paste.",
            );
            return;
          }
          setPasting(true);
          try {
            await api("/computers/" + c.id + "/control/type", "POST", {
              text,
              generation,
            });
            // Only once it has actually gone in. Clearing first threw away
            // a password somebody had just pasted, every time this failed.
            setPaste("");
            setShowPaste(false);
            notify("Text typed into the focused field on the desktop.");
          } catch (err) {
            setError(err.message);
          } finally {
            setPasting(false);
          }
          return;
        }
        setPaste("");
        setShowPaste(false);
        const client = rfb.current;
        client?.clipboardPasteFrom(text);
        setTimeout(() => {
          client?.sendKey(0xffe3, "ControlLeft", true);
          client?.sendKey(0x76, "KeyV");
          client?.sendKey(0xffe3, "ControlLeft", false);
        }, 150);
        client?.focus();
        notify("Text sent to the focused field in your desktop.");
      }}
    >
      <input
        type="password"
        aria-label="Text to copy to remote clipboard"
        autoComplete="off"
        autoFocus
        value={paste}
        onChange={(e) => setPaste(e.target.value)}
        placeholder="Text or password to paste…"
      />
      {/* Typing on the far machine takes as long as it takes, and the
          first paste of a takeover waits for the desktop controls to
          start. With nothing holding the button, a second press - or a
          second Enter, which submits the same form - typed the password
          onto the machine twice, into a field nobody can read back. */}
      <Button className="small" busy={pasting} disabled={!paste}>
        Paste into desktop
      </Button>
      <button
        type="button"
        className="text-button"
        onClick={() => {
          setPaste("");
          setShowPaste(false);
        }}
      >
        Cancel
      </button>
    </form>
  );
  if (fullWindow) {
    // What the duck asked for, in its words, is the title. A screen somebody
    // opened themselves has no ask behind it.
    const ask = request && request.kind !== "takeover" ? request : null;
    const minutes =
      ask && ask.expires > now
        ? Math.max(1, Math.ceil((ask.expires - now) / 60000))
        : 0;
    const handing = busy && !streamStarting;
    return (
      <section
        className="desktop-full"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={
          (ask?.instructions ? titleId + "-ask " : "") + titleId + "-say"
        }
        ref={fullRef}
        tabIndex={-1}
      >
        <header className="desktop-full-bar">
          <Avatar duck={duck} size={40} />
          <div className="desktop-full-words">
            <h2 id={titleId}>
              {ask ? ask.title : "You have " + duckName + "'s screen"}
            </h2>
            {/* What to do there, in the duck's words. The title alone is often
                what happened ("A code was texted to you"), not the step. */}
            {ask?.instructions && (
              <p className="desktop-full-ask" id={titleId + "-ask"}>
                {ask.instructions}
              </p>
            )}
            <p id={titleId + "-say"}>
              {preparing
                ? "Getting " + duckName + "'s screen ready."
                : waitOver
                  ? ask
                    ? duckName + " stopped waiting and carries on without this."
                    : "Your time on " + duckName + "'s screen ran out."
                  : duckName +
                    // Not a second "hand back" under a duck that just said it.
                    (saysHandBack(ask?.instructions)
                      ? " is paused."
                      : " is paused until you hand back.") +
                    (minutes
                      ? " It waits " +
                        minutes +
                        " more " +
                        (minutes === 1 ? "minute" : "minutes") +
                        "."
                      : "")}
            </p>
          </div>
          <div className="desktop-full-buttons">
            {active && status === "connected" && canHandBack && (
              <button
                type="button"
                className="desktop-full-quiet"
                aria-expanded={showPaste}
                onClick={() => setShowPaste((v) => !v)}
              >
                <ClipboardPaste size={16} aria-hidden="true" />
                Paste text
              </button>
            )}
            {canHandBack ? (
              <Button
                className="desktop-full-done"
                busy={handing}
                disabled={busy}
                onClick={release}
              >
                {!handing && <Undo2 size={18} aria-hidden="true" />}
                Done, hand back to {duckName}
              </Button>
            ) : (
              // Nothing is starting and nothing is left to hand back. While a
              // take is still under way there is no way out that would not
              // leave its lease behind, so nothing is offered then.
              !busy &&
              !streamStarting && (
                <Button className="desktop-full-done" onClick={leave}>
                  Close
                </Button>
              )
            )}
          </div>
        </header>
        {pasteForm}
        {/* These drive the older in-page viewer, not the native one, so they
            can only do anything while that viewer is connected. */}
        {!viewerUrl && active && status === "connected" && (
          <div className="desktop-full-keys">
            <button
              type="button"
              className="text-button"
              onClick={() => {
                rfb.current?.sendKey(0xffe3, "ControlLeft", true);
                rfb.current?.sendKey(0x6c, "KeyL");
                rfb.current?.sendKey(0xffe3, "ControlLeft", false);
                rfb.current?.focus();
                lastActivity.current = Date.now();
              }}
            >
              Address bar
            </button>
            <button
              type="button"
              className="text-button"
              onClick={() => {
                rfb.current?.sendKey(0xff09, "Tab");
                rfb.current?.focus();
              }}
            >
              Tab
            </button>
            <button
              type="button"
              className="text-button"
              onClick={() => {
                rfb.current?.sendKey(0xff0d, "Enter");
                rfb.current?.focus();
              }}
            >
              Enter
            </button>
          </div>
        )}
        {error && (
          <div className="error-box" role="alert">
            {error}
          </div>
        )}
        <div className="desktop-full-screen">
          <div
            className="human-desktop-canvas"
            ref={host}
            role="application"
            aria-label={duckName + " live desktop"}
          >
            {active && viewerUrl && (
              <iframe
                ref={nativeFrame}
                key={viewerUrl + ":" + version}
                title={duckName + " native desktop"}
                src={viewerUrl}
                referrerPolicy="no-referrer"
                allow="autoplay; clipboard-read; clipboard-write; fullscreen"
                // No min-height of its own: the box around it clips anything
                // taller, so asking for 65vh inside a shorter box simply cut
                // the bottom of the desktop off.
                style={{ width: "100%", height: "100%", border: 0 }}
              />
            )}
          </div>
          {(streamStarting || retake) && (
            <div
              className={
                "desktop-full-state" + (streamStarting ? " starting" : "")
              }
              role="status"
            >
              {streamStarting ? (
                <p>
                  <RefreshCw size={16} className="spin" aria-hidden="true" />
                  {viewerUrl
                    ? "Connecting to the screen…"
                    : c.human_control?.phase
                      ? preparingLabel(c.human_control.phase)
                      : "Getting the screen ready…"}
                </p>
              ) : (
                <>
                  {/* Every server restart marks leases paused, and a reload
                      leaves the screen held with nothing drawn. Either way the
                      screen is still theirs, and one press brings it back. */}
                  {!error && (
                    <p>
                      {c.human_control?.state === "paused"
                        ? "The desktop connection stopped."
                        : "The screen is not connected."}
                    </p>
                  )}
                  <Button
                    className="desktop-full-done"
                    busy={busy}
                    disabled={cannotTake}
                    onClick={() => take()}
                  >
                    <Hand size={16} aria-hidden="true" />
                    {takeLabel}
                  </Button>
                </>
              )}
            </div>
          )}
        </div>
        {/* The screen on the other side is a Linux desktop, where the shortcut
            key is Ctrl. A Mac keyboard's Command reaches it as a key that
            desktop no longer uses for anything, so Cmd+L and Cmd+T simply do
            nothing and there is no way to tell that from a frozen screen. */}
        {onAMac && active && status === "connected" && (
          <p className="desktop-modifier-hint desktop-full-hint">
            Shortcuts here use Ctrl, not ⌘ — it is a Linux desktop. ⌘V still
            pastes.
          </p>
        )}
      </section>
    );
  }
  // A duck waiting on this very person is not carrying on working, whatever
  // the picture's caption said.
  const waitingOnYou =
    !!request &&
    request.kind !== "takeover" &&
    request.status === "pending" &&
    request.expires > Date.now();
  const still = watchable && (
    <img
      className="desktop-watching"
      src={
        "/api/computers/" +
        c.id +
        "/screenshot?v=" +
        encodeURIComponent(c.screenshot_at)
      }
      alt={"What " + duckName + " has on its screen"}
    />
  );
  return (
    <section className="human-desktop-page">
      <header className="human-desktop-head">
        <button
          className="icon-button"
          aria-label="Back to computers"
          onClick={() => go({ type: "computers" })}
        >
          <ArrowLeft size={20} />
        </button>
        <Avatar duck={duck} size={32} />
        <div>
          <h2>{duckName}'s computer</h2>
          <p>
            {/* "your saved progress" was shown to everybody, including people
                who had never touched this screen: a colleague looking in while
                somebody else drove was told the pause was theirs. Say whose it
                actually is. */}
            {heldByOther
              ? (holder?.name || "Somebody else") +
                " has the screen · " +
                duckName +
                " is paused until they hand it back"
              : elsewhere
                ? "You have this screen on another device"
                : c.human_control
                  ? "Task paused · your saved progress stays here"
                  : noAIToWake
                    ? withoutAIWords(data)
                    : cannotTake
                      ? "You can watch this screen, but not take it right now"
                      : "Tap or click the screen to take control"}
          </p>
        </div>
        <div className="human-desktop-buttons">
          {/* Only reachable here when the task changed under a screen this
              person still holds; otherwise holding it fills the window, and
              handing back is in the bar there. */}
          {here && c.human_control.state !== "preparing" && (
            <Button className="secondary small" busy={busy} onClick={release}>
              Hand back to duck
            </Button>
          )}
          {noAIToWake && canConnectAI(data.role, data.permissions) && (
            <Button
              className="small"
              onClick={() => go({ type: "settings", tab: "ai" })}
            >
              Connect AI
            </Button>
          )}
        </div>
      </header>
      {changed && (
        <div className="error-box">
          This task or request changed. Return to Computers to review the
          current task.
        </div>
      )}
      {askedOfSomeoneElse && !changed && (
        <div className="info-box" role="status">
          {/* Only a request the duck made is the duck asking. A takeover is
              somebody helping themselves to the screen, and telling everybody
              else the duck had asked a teammate sent them looking under Needs
              you for something nobody had put there. */}
          {c.request_kind === "takeover"
            ? "Somebody else is taking this screen. It comes free when they hand it back, and " +
              duckName +
              " carries on."
            : duckName +
              " asked a teammate to take this screen, so it is waiting for them. They will find it under Needs you."}
        </div>
      )}
      {here && c.human_control.state === "paused" && !busy && (
        <div className="info-box" role="status">
          The desktop connection stopped. Reconnect to continue, or return to
          Computers to leave this request for later.
        </div>
      )}
      {request &&
        (request.status !== "desktop" || request.expires <= Date.now()) && (
          <HumanInputCard
            key={request.id}
            request={request}
            data={data}
            action={action}
            go={go}
            onScreen
          />
        )}
      {/* What the duck asked for disappeared the moment the screen opened,
          because the card above hides itself once the request is being held.
          That is the one moment the person needs it: they are looking at a
          desktop and have to remember what they came to do. */}
      {request &&
        request.status === "desktop" &&
        request.expires > Date.now() && (
          <div className="human-desktop-asked">
            <strong>
              {request.kind === "takeover" ? request.title : `${duckName} asked: ${request.title}`}
            </strong>
            {request.instructions && <p>{request.instructions}</p>}
          </div>
        )}
      <div className="human-desktop-toolbar">
        <span
          className={
            "desktop-status " + (status === "connected" ? "connected" : "")
          }
        >
          {/* This said "Native desktop viewer" - the name of a transport, not
              an answer to the question somebody asks before they type a
              password. */}
          {busy
            ? preparingLabel(c.human_control?.phase)
            : c.human_control && !mine
              ? "Another person has control"
              : liveStates.includes(c.state) && c.desktop_failed
                ? "This computer has no screen"
                : liveStates.includes(c.state) && !c.automation_ready
                  ? "Desktop controls are starting…"
                  : noAIToWake || wontWake
                    ? "Stopped · saved"
                    : cannotTake
                      ? "Watching"
                      : "Ready when you are"}
        </span>
        {/* Makes the picture full screen, and a phone-sized frame of a
            1920-wide screen is exactly where somebody needs it. */}
        <button
          className="icon-button"
          aria-label="Full screen desktop"
          onClick={() => host.current?.requestFullscreen?.()}
        >
          <Maximize size={16} />
        </button>
      </div>
      {error && <div className="error-box">{error}</div>}
      <div
        className="human-desktop-canvas"
        ref={host}
        role="application"
        aria-label={duckName + " live desktop"}
      >
        <div className="desktop-welcome">
          {/* Before this, coming here to see what your duck was up to showed
              a hand and an invitation to interrupt it. The screen was two
              clicks away on another page, and taking over - which stops the
              duck - was the only thing this page offered. Show the screen. */}
          {/* The picture is also the way in. The button that took the screen
              sat small in the top corner, and people clicked the picture
              instead and nothing happened. */}
          {retake && !cannotTake ? (
            <button
              type="button"
              className={"desktop-take" + (still ? " on-picture" : "")}
              aria-label={takeLabel}
              disabled={busy}
              onClick={() => take()}
            >
              {still || <Hand size={38} aria-hidden="true" />}
              <span className="button desktop-take-label" aria-hidden="true">
                <Hand size={18} />
                {takeLabel}
              </span>
            </button>
          ) : (
            still || <Hand size={38} />
          )}
          {watchable && (
            <span className="desktop-watching-label">
              <Camera size={13} />
              {/* Nothing is photographed while a person holds a screen, so
                  for anybody else this picture stops dead the moment a
                  colleague takes it - and it was still captioned as keeping
                  up, beside a claim that the duck was carrying on working.
                  Both were false at exactly the same moment. So was that
                  claim under a card saying the duck was waiting for you. */}
              {heldByOther
                ? `${duckName}'s screen at ${seenAt(c.screenshot_at)} · frozen while ${holder?.name || "somebody else"} has it, and there are no new pictures until they hand it back`
                : elsewhere
                  ? `${duckName}'s screen at ${seenAt(c.screenshot_at)} · frozen while you have it on another device`
                  : waitingOnYou
                    ? `${duckName}'s screen at ${seenAt(c.screenshot_at)} · ${duckName} is waiting for you`
                    : // No pictures are taken while a request is open, and a
                      // duck with no run is not carrying on with anything.
                      c.request_id
                      ? `${duckName}'s screen at ${seenAt(c.screenshot_at)} · frozen while ${duckName} waits for a person`
                      : c.duck_working
                        ? `${duckName}'s screen at ${seenAt(c.screenshot_at)} · keeps up while you watch, and ${duckName} carries on working`
                        : `${duckName}'s screen at ${seenAt(c.screenshot_at)} · keeps up while you watch`}
            </span>
          )}
          {/* The heading and the sentence under it explained the feature to
              somebody already standing on the feature's page with the button
              in front of them, and pushed the screen - the only thing this
              page is for - further down on every visit. What is left is the
              part that carries information: why you cannot take it, when
              there is a reason. */}
          {/* Not when the box above already says it, in more words. */}
          {whyNot && !(askedOfSomeoneElse && !changed) && <p>{whyNot}</p>}
        </div>
      </div>
    </section>
  );
}
