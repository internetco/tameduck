// Settings > Activity log: one trail, by day.
//
// People come here to find out who did something, or why a duck did - most
// often after something went wrong. The page used to be the newest hundred rows
// in 12px grey, 63 of 92 of them "Duck finished a run", with the tool
// decisions in cards below the last of them. Now every line starts with the
// face of whoever did it, each day has a heading, a day's routine runs are one
// line you can open, and a tool decision sits where it happened with how it
// ended in words. The sentences are the server's (server/activity-words.mjs);
// this only lays them out.
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Ban,
  CalendarClock,
  Check,
  ChevronDown,
  CircleHelp,
  CirclePause,
  CircleStop,
  FileText,
  Key,
  ListChecks,
  MessageSquare,
  Monitor,
  Plug,
  Plus,
  Settings2,
  Sparkles,
  TriangleAlert,
  UserRound,
  Wrench,
  X,
  CornerUpRight,
} from "lucide-react";
import { api, Avatar } from "./ui.jsx";
import { routePath } from "./navigation.mjs";
import { daysOf, laid } from "./activity-pages.mjs";
import "./activity-log.css";
import SettingsHead from "./SettingsHead.jsx";

const FILTERS = [
  ["everything", "Everything"],
  ["secrets", "Secrets and connections"],
  ["tools", "Tool decisions"],
  ["people", "People and settings"],
  ["work", "Ducks’ work"],
];
// With nothing to show under a filter, what would show up there.
const NOTHING = {
  everything: "Nothing has happened here yet.",
  secrets: "No secret or connection has been added, changed or used yet.",
  tools: "No duck has asked to use a connected tool yet.",
  people: "Nobody has changed anything here yet.",
  work: "No duck has done any work yet.",
};
// The sign in the corner of a face: what kind of thing happened.
const MARKS = {
  tool: Wrench,
  secret: Key,
  plug: Plug,
  bad: TriangleAlert,
  reply: CornerUpRight,
  person: UserRound,
  settings: Settings2,
  plus: Plus,
  task: ListChecks,
  doc: FileText,
  computer: Monitor,
  skill: Sparkles,
  chat: MessageSquare,
  pause: CirclePause,
  stop: CircleStop,
  schedule: CalendarClock,
  run: Check,
};
// How a thing ended: a word and a sign, never a colour alone.
const OUTCOMES = {
  done: Check,
  no: X,
  bad: TriangleAlert,
  unsure: CircleHelp,
  never: Ban,
};
// The runs a fold shows before "Show all".
const FIRST = 3;

function Face({ face, mark, ducks }) {
  const Mark = MARKS[mark];
  return (
    <span className="al-fb">
      {"person" in face ? (
        <Avatar name={face.person} size={30} />
      ) : (
        <Avatar
          duck={ducks.find((d) => d.id === face.duck) || { name: face.name }}
          size={30}
        />
      )}
      {Mark && (
        <span className={"al-kind" + (mark === "bad" ? " bad" : "")}>
          <Mark size={11} strokeWidth={2.1} aria-hidden="true" />
        </span>
      )}
    </span>
  );
}
function Outcome({ outcome }) {
  const Icon = OUTCOMES[outcome.tone];
  return (
    <span className={"al-out " + outcome.tone}>
      {Icon && <Icon size={13} strokeWidth={2.3} aria-hidden="true" />}
      {outcome.words}
    </span>
  );
}
function When({ entry, opens }) {
  return (
    <span className="al-when">
      <time dateTime={entry.time}>{entry.at}</time>
      {opens ? (
        <ChevronDown size={16} aria-hidden="true" />
      ) : (
        <i aria-hidden="true" />
      )}
    </span>
  );
}
function Facts({ lines }) {
  return (
    <dl className="al-facts">
      {lines.map((one, i) => (
        <React.Fragment key={i}>
          <dt>{one.name}</dt>
          <dd>{one.value}</dd>
        </React.Fragment>
      ))}
    </dl>
  );
}
// Where a line leads, opened inside the app rather than by loading it again.
function Place({ to, company, onLeave }) {
  const href = routePath(
    to.type === "tasks"
      ? { type: "tasks", id: to.id, companyId: company }
      : { type: "chat", id: to.id, threadId: to.thread, companyId: company },
  );
  return (
    <a
      className="al-link"
      href={href}
      onClick={(e) => {
        if (e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)
          return;
        e.preventDefault();
        onLeave?.();
        window.history.pushState({}, "", href);
        window.dispatchEvent(new PopStateEvent("popstate"));
      }}
    >
      {to.label}
    </a>
  );
}
function What({ entry, company, onLeave }) {
  return (
    <span className="al-what">
      <span className="al-line">{entry.line}</span>
      {entry.sub && <span className="al-sub">{entry.sub}</span>}
      {entry.why && (
        <span className="al-why">
          {entry.why}
          {entry.open && (
            <>
              {" "}
              <Place to={entry.open} company={company} onLeave={onLeave} />
            </>
          )}
        </span>
      )}
    </span>
  );
}

function Line({ entry, ducks, company, onLeave }) {
  const opens = !!(entry.asked || entry.sent);
  const top = (
    <>
      <Face face={entry.face} mark={entry.mark} ducks={ducks} />
      <What entry={entry} company={company} onLeave={onLeave} />
      {entry.outcome && <Outcome outcome={entry.outcome} />}
      <When entry={entry} opens={opens} />
    </>
  );
  if (!opens) return <div className="al-row">{top}</div>;
  return (
    <details>
      <summary className="al-row">{top}</summary>
      <div className="al-open">
        <div className="al-open-cols">
          {entry.asked && (
            <div>
              <h4>What it asked to do</h4>
              <Facts lines={entry.asked} />
            </div>
          )}
          {entry.sent && (
            <div>
              <h4>What {entry.service || "the service"} sent back</h4>
              {entry.sent.facts ? (
                <Facts lines={entry.sent.facts} />
              ) : (
                <p className="al-sent">{entry.sent.text}</p>
              )}
            </div>
          )}
        </div>
      </div>
    </details>
  );
}

// A day's routine work, one line that opens.
function Fold({ entry, ducks }) {
  const [all, setAll] = useState(false);
  const firstHidden = useRef(null);
  // Carry on from the first one that was not there before.
  useEffect(() => {
    if (all) firstHidden.current?.focus();
  }, [all]);
  const shown = all ? entry.items : entry.items.slice(0, FIRST);
  return (
    <details className="al-fold">
      <summary className="al-row">
        {entry.faces.length === 1 ? (
          // One duck's runs: its face, as on every other line.
          <Face
            face={entry.faces[0]}
            mark={entry.fold === "runs" ? "run" : "computer"}
            ducks={ducks}
          />
        ) : (
          <span className="al-faces" aria-hidden="true">
            {entry.faces.map((f, i) => (
              <Avatar
                key={i}
                duck={ducks.find((d) => d.id === f.duck) || { name: f.name }}
                size={19}
              />
            ))}
          </span>
        )}
        <span className="al-what">
          <span className="al-line">{entry.line}</span>
          {entry.sub && <span className="al-sub">{entry.sub}</span>}
        </span>
        <When entry={entry} opens />
      </summary>
      <div className="al-open">
        <ul className="al-runs">
          {shown.map((item, i) => (
            <li
              key={item.id}
              ref={i === FIRST ? firstHidden : null}
              // Each one shown by "Show all" can hold the keyboard, so a run
              // that finishes meanwhile does not take it away.
              tabIndex={all && i >= FIRST ? -1 : undefined}
            >
              <Avatar
                duck={
                  ducks.find((d) => d.id === item.face.duck) || {
                    name: item.face.name,
                  }
                }
                size={22}
              />
              <span>
                <b>{item.face.name}</b> {item.rest}
              </span>
              <time dateTime={item.time}>{item.at}</time>
            </li>
          ))}
        </ul>
        {!all && entry.items.length > FIRST && (
          <button
            type="button"
            className="al-quiet al-all"
            onClick={() => setAll(true)}
          >
            {entry.fold === "runs"
              ? "Show all " + entry.items.length + " runs"
              : "Show all " + entry.items.length + " ducks"}
          </button>
        )}
      </div>
    </details>
  );
}

// Where somebody was when they went from the log to a run's chat or ticket.
// Back brings them to the same filter, the same days and the same place.
let away = null;
// What scrolls the page the log is on.
function scrollerOf(el) {
  for (let e = el?.parentElement; e; e = e.parentElement) {
    const y = getComputedStyle(e).overflowY;
    if ((y === "auto" || y === "scroll") && e.scrollHeight > e.clientHeight)
      return e;
  }
  return document.scrollingElement;
}

export default function ActivityLog({ data }) {
  const company = data.company.id;
  // Back from a run's chat or ticket: the log as it was left.
  const [was] = useState(() =>
    away &&
    away.company === company &&
    window.history.state?.activityLog === away.at
      ? away
      : null,
  );
  const [show, setShow] = useState(was?.show || "everything");
  // The pages the server sent, newest first.
  const [pages, setPages] = useState(was?.pages || null);
  const [failed, setFailed] = useState(false);
  const [more, setMore] = useState({ busy: false, failed: false });
  // Answers to a filter somebody has since moved away from are dropped.
  const asked = useRef(0);
  const focusDay = useRef(null);
  const root = useRef(null);
  const now = useRef(pages);
  now.current = pages;
  const page = (which, at = {}) =>
    api("/activity?" + new URLSearchParams({ show: which, ...at }));
  const load = useCallback(async (which) => {
    const mine = ++asked.current;
    setPages(null);
    setFailed(false);
    setMore({ busy: false, failed: false });
    try {
      const got = await page(which);
      if (mine === asked.current) setPages([got]);
    } catch {
      if (mine === asked.current) setFailed(true);
    }
  }, []);
  // The newest days again, back to where the first page on screen stopped,
  // so they take its place and the days loaded below still follow on.
  const refresh = useCallback(async (which, mine = asked.current) => {
    try {
      const after = now.current?.[0]?.next?.before;
      const got = await page(which, after ? { after } : {});
      if (mine !== asked.current) return;
      setPages((old) => laid(old, got));
      setFailed(false);
    } catch {
      // The next change tries again; what is on screen is still true.
    }
  }, []);
  const back = useRef(!!was);
  useEffect(() => {
    if (back.current) {
      back.current = false;
      away = null;
      refresh(show);
      return;
    }
    load(show);
  }, [show, load, refresh]);
  // Where they were on the page, once it is laid out again.
  useEffect(() => {
    if (!was) return;
    const frame = requestAnimationFrame(() => {
      const scroller = scrollerOf(root.current);
      if (scroller) scroller.scrollTop = was.scroll;
    });
    return () => cancelAnimationFrame(frame);
  }, [was]);
  const leave = () => {
    const at = Date.now();
    away = {
      company,
      show,
      pages,
      scroll: scrollerOf(root.current)?.scrollTop || 0,
      at,
    };
    window.history.replaceState(
      { ...window.history.state, activityLog: at },
      "",
    );
  };
  // Something new was written down: read the newest days again, at most once
  // every two seconds, because a duck at its computer writes a line a click.
  const seen = useRef(data.activity_at);
  const waiting = useRef(null);
  useEffect(() => {
    if (data.activity_at === seen.current) return;
    seen.current = data.activity_at;
    if (waiting.current) return;
    // For the filter showing now: a later change of filter loads afresh.
    const mine = asked.current;
    waiting.current = setTimeout(() => {
      waiting.current = null;
      refresh(show, mine);
    }, 2000);
  }, [data.activity_at, show, refresh]);
  useEffect(() => () => clearTimeout(waiting.current), []);
  useEffect(() => {
    if (!focusDay.current) return;
    document.getElementById(focusDay.current)?.focus();
    focusDay.current = null;
  }, [pages]);
  const next = pages?.at(-1).next || null;
  const earlier = async () => {
    if (more.busy || !next) return;
    const mine = asked.current;
    const before = next.before;
    setMore({ busy: true, failed: false });
    try {
      const got = await page(show, { before });
      if (mine !== asked.current) return;
      focusDay.current = got.days[0] ? "al-day-" + got.days[0].day : null;
      // Unless the newest days were read again on another clock meanwhile.
      setPages((old) =>
        old?.at(-1).next?.before === before ? [...old, got] : old,
      );
      setMore({ busy: false, failed: false });
    } catch {
      if (mine === asked.current) setMore({ busy: false, failed: true });
    }
  };

  const ducks = data.ducks || [];
  const days = pages ? daysOf(pages) : [];
  const quiet = pages?.length === 1 && pages[0].quiet;
  return (
    <div className="activity-log" ref={root} aria-busy={more.busy || undefined}>
      <SettingsHead page="activity" company={data.company.name} />
      <div className="al-bar" role="group" aria-label="Show">
        {FILTERS.map(([id, name]) => (
          <button
            key={id}
            type="button"
            className="al-chip"
            aria-pressed={show === id}
            onClick={() => setShow(id)}
          >
            {name}
          </button>
        ))}
      </div>
      <label className="al-pick">
        <span>Show</span>
        <select value={show} onChange={(e) => setShow(e.target.value)}>
          {FILTERS.map(([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </select>
      </label>
      {!pages && !failed && (
        <p className="al-status" role="status">
          Loading…
        </p>
      )}
      {failed && !pages && (
        <div className="al-status" role="alert">
          The activity log could not be loaded.{" "}
          <button type="button" className="al-quiet" onClick={() => load(show)}>
            Try again
          </button>
        </div>
      )}
      {pages && !days.length && (
        <ul className="al-list">
          <li>
            <p className="al-quiet-line">{NOTHING[show]}</p>
          </li>
        </ul>
      )}
      {days.map((day, n) => (
        <section
          className="al-day"
          key={day.day}
          aria-labelledby={"al-day-" + day.day}
        >
          <h3 className="al-day-h" id={"al-day-" + day.day} tabIndex={-1}>
            {day.title}
            {day.date && <span>{day.date}</span>}
          </h3>
          <ul className="al-list">
            {day.entries.map((entry) => (
              <li key={entry.id}>
                {entry.fold ? (
                  <Fold entry={entry} ducks={ducks} />
                ) : (
                  <Line
                    entry={entry}
                    ducks={ducks}
                    company={company}
                    onLeave={leave}
                  />
                )}
              </li>
            ))}
            {quiet && n === days.length - 1 && (
              <li>
                <p className="al-quiet-line">
                  Nothing else yet. When somebody changes a setting, or a duck
                  reads a secret or asks to use a connected tool, it shows up
                  here.
                </p>
              </li>
            )}
          </ul>
        </section>
      ))}
      {next && (
        <div className="al-more">
          <button
            type="button"
            className="al-quiet"
            aria-disabled={more.busy || undefined}
            onClick={earlier}
          >
            {more.busy
              ? "Loading earlier days…"
              : "Show " + next.date + " and earlier"}
          </button>
          {more.failed && (
            <div className="al-status" role="alert">
              Those days could not be loaded.{" "}
              <button type="button" className="al-quiet" onClick={earlier}>
                Try again
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
