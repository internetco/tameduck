import React, { useEffect, useRef, useState } from "react";
import { api } from "./ui.jsx";

// What a run did on its computer: the commands it typed, and the notes it
// wrote on every step. The progress card in chat and a teammate's terminal in
// a consultation both read it from here.
export function useTerminal({ computer, job, tick, live }) {
  const [lines, setLines] = useState([]);
  const [steps, setSteps] = useState([]);
  const [earlier, setEarlier] = useState(0);
  const [total, setTotal] = useState(0);
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  // While the duck is working this asks again on a tick. Once the run is over,
  // what it typed cannot change, so it is fetched once and left alone: a
  // transcript can hold a hundred finished messages and not one of them has a
  // reason to keep asking.
  const [localTick, setLocalTick] = useState(0);
  useEffect(() => {
    if (!live || tick !== undefined) return;
    const timer = setInterval(() => setLocalTick((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, [live, tick]);
  const round = live ? Math.floor((tick ?? localTick) / 3) : 0;
  useEffect(() => {
    if (!computer) return;
    let current = true;
    api("/computers/" + computer + "/terminal" + (job ? "?job=" + job : ""))
      .then((r) => {
        if (!current) return;
        setLines(r.commands || []);
        setSteps(r.steps || []);
        setEarlier(r.earlier_steps || 0);
        setTotal(r.total || (r.commands || []).length);
        setFailed(false);
        setLoaded(true);
      })
      .catch(() => {
        if (!current) return;
        setFailed(true);
        setLoaded(true);
      });
    return () => {
      current = false;
    };
  }, [computer, job, round]);
  return { lines, steps, earlier, total, failed, loaded };
}

// The commands themselves, each with the end of what it printed.
export function CommandList({ lines, failed }) {
  const box = useRef(null);
  // Show the newest command from its own first line, not from the bottom of
  // its output. Scrolling to the very end put the "$ curl ..." line above the
  // top of the panel, leaving somebody looking at an answer with the question
  // missing - which is the one line they came for.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const commands = el.querySelectorAll(".chat-terminal-command");
    const newest = commands[commands.length - 1];
    el.scrollTop = newest ? newest.offsetTop - el.offsetTop : el.scrollHeight;
  }, [lines.length, lines[lines.length - 1]?.id]);
  return (
    <>
      {failed && (
        <p className="chat-terminal-state failed">
          Activity is temporarily unavailable. Try again shortly.
        </p>
      )}
      {!failed && !lines.length && (
        <p className="chat-terminal-state">No commands recorded yet.</p>
      )}
      <div className="chat-terminal-body" ref={box}>
        {lines.map((c) => (
          <div key={c.id}>
            <p className="chat-terminal-command">
              <span>$</span> {c.command || "(command not recorded)"}
            </p>
            {!!c.output && (
              <>
                {c.clipped && (
                  <p className="chat-terminal-state">… last few lines</p>
                )}
                <pre className="chat-terminal-output">{c.output}</pre>
              </>
            )}
            {c.truncated && (
              <p className="chat-terminal-state">
                too long to keep in full — the duck did not see the rest either
              </p>
            )}
            {c.state === "executing" ? (
              <p className="chat-terminal-state">still running…</p>
            ) : c.timed_out ? (
              <p className="chat-terminal-state failed">
                stopped when its time ran out — the duck was not told the result
                either
              </p>
            ) : c.state === "unknown" ? (
              // Stopped part-way - the screen was taken, the run was stopped,
              // or the server restarted. Without this the command and whatever
              // output had arrived sat there with no status, which reads as a
              // command that finished.
              <p className="chat-terminal-state failed">
                stopped before it finished
              </p>
            ) : (
              c.exit_code !== null &&
              c.exit_code !== 0 && (
                <p className="chat-terminal-state failed">
                  finished with an error (code {c.exit_code})
                </p>
              )
            )}
          </div>
        ))}
      </div>
    </>
  );
}

export function Terminal({ computer, job, name, tick, live }) {
  const { lines, total, failed } = useTerminal({ computer, job, tick, live });
  const [open, setOpen] = useState(false);
  const last = lines[lines.length - 1];
  const executing =
    !failed && live && lines.some((line) => line.state === "executing");
  const status = failed
    ? "Unavailable"
    : executing
      ? "Running"
      : !last
        ? "Waiting"
        : last.state === "executing" ||
            last.state === "unknown" ||
            last.timed_out
          ? "Stopped"
          : last.exit_code != null && last.exit_code !== 0
            ? "Error"
            : "Complete";
  return (
    <details
      className="chat-terminal"
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary className="chat-terminal-head">
        <span className="chat-terminal-title">
          <span
            className={executing ? "chat-terminal-pulse" : ""}
            aria-hidden="true"
          />
          Terminal
        </span>
        <small>
          {/* The number used to count the rows that came back, which is this
              panel's own window of twenty - so a duck that had run forty-seven
              commands was reported as having run twenty, starting at the
              twenty-eighth, with nothing marking where the rest had been. */}
          {status} ·{" "}
          {total > lines.length
            ? "last " + lines.length + " of " + total
            : lines.length === 1
              ? "1 command"
              : lines.length + " commands"}
        </small>
      </summary>
      <CommandList lines={lines} failed={failed} />
    </details>
  );
}
