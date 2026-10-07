import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Check, Loader2, RotateCw, Server, WifiOff } from "lucide-react";
import { BrandMark, fmtTime } from "./ui.jsx";
import { inSeconds, openingPage, stripMessage } from "./status-words.mjs";
import "./status.css";

// "Later" on the update: this tab stops showing that one version. A newer one
// shows again, and so does a new tab.
const LATER = "tameduck:update-later";
const laterNote = () => {
  try {
    return sessionStorage.getItem(LATER);
  } catch {
    return null;
  }
};

// A clock that moves once a second, only while something on screen counts.
function useNow(counting) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!counting) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [counting]);
  return counting ? now : Date.now();
}

// A try that fails at once changes nothing on screen, so the button says it
// is trying for long enough to be seen.
function useTry(onTry) {
  const [busy, setBusy] = useState(false);
  const run = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await Promise.all([
        Promise.resolve(onTry()).catch(() => {}),
        new Promise((r) => setTimeout(r, 700)),
      ]);
    } finally {
      setBusy(false);
    }
  };
  return [busy, run];
}

const icons = { offline: WifiOff, down: Server, back: Check, update: RotateCw };

// The seconds count down, but a screen reader is told once, not every second.
function Words({ m }) {
  return (
    <>
      {m.text}
      {m.wait && (
        <>
          {" " + m.waitLead + " "}
          <span aria-live="off">{inSeconds(m.wait)}</span>.
        </>
      )}
    </>
  );
}

// Everything the app says about itself, one message at a time, at the top of
// the page and in the page's own theme.
export function StatusStrip({ trouble, backOnline, update, onTry }) {
  const [later, setLater] = useState(laterNote);
  const now = useNow(trouble?.kind === "down");
  const m = stripMessage({
    trouble,
    backOnline,
    update: !!update && later !== update,
    now,
    clock: fmtTime,
  });
  const [busy, tryNow] = useTry(onTry);
  // The live region stays on the page, so what appears in it is read out.
  // When the message a person had a button of goes, focus waits here rather
  // than falling to the top of the document.
  const live = useRef(null);
  const hadFocus = useRef(false);
  useLayoutEffect(() => {
    const el = live.current;
    if (
      hadFocus.current &&
      el &&
      !el.contains(document.activeElement) &&
      (!document.activeElement || document.activeElement === document.body)
    )
      el.focus();
  }, [m?.key]);
  const Icon = m && icons[m.key];
  return (
    <div
      className="status-strip-live"
      role="status"
      tabIndex={-1}
      ref={live}
      onFocus={() => (hadFocus.current = true)}
      onBlur={(e) => {
        // Focus that moves on is gone for good; focus that went because its
        // button did is the case above, and by then that button is detached.
        const from = e.target;
        const to = e.relatedTarget;
        if (to) {
          if (!live.current?.contains(to)) hadFocus.current = false;
        } else
          queueMicrotask(() => {
            if (from.isConnected) hadFocus.current = false;
          });
      }}
    >
      {m && (
        <div
          key={m.key}
          className={
            "status-strip is-" +
            m.tone +
            (m.actions.length > 1 ? " has-two" : "")
          }
          data-status={m.key}
        >
          <span className={"status-tile is-" + m.tone} aria-hidden="true">
            <Icon size={16} />
          </span>
          <span className="status-words">
            <b>{m.title}</b>
            <span className="status-text">
              <Words m={m} />
            </span>
          </span>
          {m.actions.length > 0 && (
            <span className="status-acts">
              {m.actions.includes("try") && (
                <button
                  type="button"
                  className="button secondary"
                  aria-busy={busy || undefined}
                  onClick={tryNow}
                >
                  {busy && <Loader2 className="spin" size={16} />}
                  Try now
                </button>
              )}
              {m.actions.includes("later") && (
                <button
                  type="button"
                  className="button secondary"
                  onClick={() => {
                    try {
                      sessionStorage.setItem(LATER, update);
                    } catch {}
                    setLater(update);
                  }}
                >
                  Later
                </button>
              )}
              {m.actions.includes("refresh") && (
                <button
                  type="button"
                  className="button"
                  onClick={() => window.location.reload()}
                >
                  Refresh
                </button>
              )}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

// While a company opens, and in its place when it will not: in the theme the
// person picked, naming the company, counting the tries, and always with a
// way out. It is one component whichever it shows, so the words sit in the
// same live region and a change between them is read out.
export function OpeningPage({
  opening,
  trouble,
  name,
  current,
  other,
  onTry,
  onOther,
  onBack,
  onSignOut,
}) {
  const failed = !opening && !!trouble;
  const now = useNow(failed && !current);
  const p = openingPage({
    opening,
    trouble,
    name,
    current,
    other,
    now,
    clock: fmtTime,
  });
  const [busy, tryNow] = useTry(onTry);
  const [stuck, setStuck] = useState(false);
  const signOut = async () => {
    setStuck(false);
    try {
      await onSignOut();
    } catch {
      setStuck(true);
    }
  };
  const Icon = trouble?.kind === "offline" ? WifiOff : Server;
  return (
    <main className="opening-page">
      <div className={"opening-box " + (failed ? "is-card" : "is-opening")}>
        {failed ? (
          <span className="status-tile is-off" aria-hidden="true">
            <Icon size={16} />
          </span>
        ) : (
          <BrandMark size={44} />
        )}
        <div className="opening-words" role="status">
          {failed ? (
            <>
              <h1>{p.title}</h1>
              <p>
                <Words m={p} />
              </p>
            </>
          ) : (
            <p className="opening-now">{p.text}</p>
          )}
        </div>
        {!failed && <span className="opening-bar" aria-hidden="true" />}
        {failed && p.foot && <p className="opening-foot">{p.foot}</p>}
        {failed && (
          <div className="opening-acts">
            {p.actions.map((a) =>
              a === "try" || a === "again" ? (
                <button
                  key={a}
                  type="button"
                  className="button"
                  aria-busy={busy || undefined}
                  onClick={tryNow}
                >
                  {busy && <Loader2 className="spin" size={16} />}
                  {a === "try" ? "Try now" : "Try again"}
                </button>
              ) : a === "other" ? (
                <button
                  key={a}
                  type="button"
                  className="button secondary"
                  onClick={() => onOther(other)}
                >
                  Open {other.name}
                </button>
              ) : a === "back" ? (
                <button
                  key={a}
                  type="button"
                  className="button secondary"
                  onClick={onBack}
                >
                  Back to {current.name}
                </button>
              ) : (
                <button
                  key={a}
                  type="button"
                  className="opening-quiet"
                  onClick={signOut}
                >
                  Sign out
                </button>
              ),
            )}
          </div>
        )}
        {failed && stuck && (
          <p className="opening-problem" role="alert">
            TameDuck couldn’t sign you out. Try again in a moment.
          </p>
        )}
      </div>
    </main>
  );
}
