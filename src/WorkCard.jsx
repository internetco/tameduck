import React, { useEffect, useState } from "react";
import {
  ChevronRight,
  CircleAlert,
  CircleCheck,
  Circle,
  ListChecks,
  Loader2,
  Square,
} from "lucide-react";
import { useTerminal, CommandList } from "./Terminal.jsx";
import { chipWords, groupSteps, workingWords } from "./work-steps.mjs";
import "./work-card.css";

// A duck's run, told once, on its own message.
//
// It used to be told six ways at the same time: a green "Working" by the name,
// a black "Terminal · Complete" bar, three dots, "Nothing has changed here for
// 10 minutes" on the picture, the duck's latest note under it, and "is working
// · 4 min" with Stop down in the message box. Some of those disagreed with each
// other, and the picture and the button under it were two doors to one screen.
// Now there is one card: how long, the steps so far in plain words, a small
// picture that is itself the way in, and the commands folded under Details.
// When the run is over it folds into one line that opens to the same steps.
const SHOWN = 5;

function Steps({ steps, live, finished, earlier }) {
  const [all, setAll] = useState(false);
  const hidden = all ? 0 : Math.max(0, steps.length - SHOWN);
  return (
    <ol className="work-steps">
      {earlier && !hidden && (
        <li className="work-lost">Earlier steps were not kept.</li>
      )}
      {hidden > 0 && (
        <li className="work-more">
          <button type="button" onClick={() => setAll(true)}>
            Show {hidden} earlier {hidden === 1 ? "step" : "steps"}
          </button>
        </li>
      )}
      {steps.slice(hidden).map((s, i, shown) => {
        const last = i === shown.length - 1;
        // The last step of a run still going is the one it is on. The last
        // step of a run that ended without an answer is where it was left,
        // which is not the same as done. A step the duck only said it would
        // take next is never done.
        const kind = s.failed
          ? "failed"
          : (!last || finished) && !s.planned
            ? "done"
            : live
              ? "now"
              : "left";
        return (
          <li
            key={hidden + i}
            className={kind}
            aria-current={kind === "now" ? "step" : undefined}
          >
            {kind === "done" ? (
              <CircleCheck size={17} aria-hidden="true" />
            ) : kind === "failed" ? (
              <CircleAlert size={17} aria-hidden="true" />
            ) : kind === "now" ? (
              <svg
                width="17"
                height="17"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <circle cx="12" cy="12" r="9" fill="none" strokeWidth="2" />
                <circle cx="12" cy="12" r="4" />
              </svg>
            ) : (
              <Circle size={17} aria-hidden="true" />
            )}
            <span>
              <span className="work-hidden">
                {kind === "done"
                  ? "Done: "
                  : kind === "failed"
                    ? "Did not work: "
                    : kind === "now"
                      ? "Now: "
                      : ""}
              </span>
              {s.step}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function Body({ work, steps, live, finished, picture, computer }) {
  // Only a run on a computer writes steps, so only there is their absence
  // worth a word.
  const empty = steps.length
    ? ""
    : work.failed
      ? "The steps can't be shown right now."
      : computer && live
        ? "Getting started."
        : "";
  return (
    <>
      {(steps.length > 0 || picture || empty) && (
        <div className="work-body">
          {steps.length > 0 ? (
            <Steps
              steps={steps}
              live={live}
              finished={finished}
              earlier={work.earlier > 0}
            />
          ) : (
            <p className="work-empty">{empty}</p>
          )}
          {picture && <div className="work-picture">{picture}</div>}
        </div>
      )}
      {work.lines.length > 0 && (
        <details className="work-details">
          <summary>
            <ChevronRight size={14} aria-hidden="true" />
            Details
          </summary>
          <CommandList lines={work.lines} failed={work.failed} />
        </details>
      )}
    </>
  );
}

// computer: the duck's computer, when this run used it and this person may see
// it - otherwise there are no steps or commands to fetch, only the time.
export function WorkCard({
  name,
  state,
  outcome,
  started,
  ended,
  computer,
  job,
  tick,
  picture,
  onStop,
  onGrow,
}) {
  const live = state === "working";
  const done = state === "sent" && outcome !== "incomplete";
  const work = useTerminal({ computer, job, tick, live });
  const grouped = groupSteps(work.steps);
  // What it said it would do next never happened once the answer is in.
  const steps = done ? grouped.filter((s) => !s.planned) : grouped;
  // A run paused for somebody is not over, and its picture is the one way to
  // see where it stopped, so it is not folded away behind a line.
  const [open, setOpen] = useState(null);
  const shown =
    open ?? (!!picture && !["sent", "error", "cancelled"].includes(state));
  const [stopping, setStopping] = useState(false);
  const now = steps[steps.length - 1];
  // New steps land after the chat has scrolled to the newest message, and
  // would push the bottom of this card under the message box.
  useEffect(() => {
    onGrow?.();
  }, [steps.length, work.lines.length, work.loaded, now?.rest]);
  if (live) {
    const words = workingWords(started);
    return (
      <section className="work-card" aria-label={name + "'s progress"}>
        <div className="work-head">
          <Loader2 className="spin" size={16} aria-hidden="true" />
          {/* Read out when the step moves on. The minutes are not: a reader
              that speaks every change would say the whole line each minute. */}
          <p role="status">
            <strong>
              Working
              <span aria-hidden="true">{words.slice("Working".length)}</span>
            </strong>
            {now?.rest && (
              <>
                <span className="work-dot" aria-hidden="true">
                  {" · "}
                </span>
                {now.rest}
              </>
            )}
          </p>
          {onStop && (
            <button
              type="button"
              className="button work-stop"
              aria-label={"Stop " + name}
              disabled={stopping}
              onClick={async () => {
                setStopping(true);
                try {
                  await onStop();
                } finally {
                  setStopping(false);
                }
              }}
            >
              <Square size={12} aria-hidden="true" /> Stop
            </button>
          )}
        </div>
        <Body
          work={work}
          steps={steps}
          live
          finished={false}
          picture={picture}
          computer={computer}
        />
      </section>
    );
  }
  // A run that did nothing on a computer has nothing to open, so a reply that
  // was only ever words stays only words.
  if (!computer && !picture) return null;
  return (
    <div className="work-done">
      <button
        type="button"
        className={"work-chip" + (done ? " done" : "")}
        aria-expanded={shown}
        onClick={() => setOpen(!shown)}
      >
        {done ? (
          <CircleCheck size={15} aria-hidden="true" />
        ) : (
          <ListChecks size={15} aria-hidden="true" />
        )}
        {chipWords({
          state,
          outcome,
          started,
          ended,
          steps: grouped.filter((s) => !s.planned).length,
          more: work.earlier > 0,
        })}
        <ChevronRight className="work-chevron" size={13} aria-hidden="true" />
      </button>
      {shown && (
        <section
          className="work-card work-card-open"
          aria-label={"What " + name + " did"}
        >
          <Body
            work={work}
            steps={steps}
            live={false}
            finished={done}
            picture={picture}
            computer={computer}
          />
          {!steps.length && !work.lines.length && !picture && (
            <p className="work-empty solo">
              {work.loaded ? "Nothing was written down." : "Loading…"}
            </p>
          )}
        </section>
      )}
    </div>
  );
}
