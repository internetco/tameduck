const ComputerControl = React.lazy(() => import("./ComputerControl.jsx"));
import { useAIReady } from "./use-ai.mjs";
import { COMPUTER_IDLE_SECONDS } from "../shared/computer-policy.mjs";
import React, { useState, useEffect, useRef } from "react";
import {
  Monitor,
  MonitorOff,
  Play,
  Square,
  Power,
  Hand,
  Undo2,
  Clock,
  Camera,
  CircleAlert,
  Loader2,
  ArrowLeft,
  ArrowUpRight,
  FileText,
  MessageSquare,
  Hash,
} from "lucide-react";
import {
  api,
  Avatar,
  Modal,
  Field,
  Button,
  Empty,
  DuckPicker,
  flock,
  fmtTime,
  plural,
} from "./ui.jsx";
import { routePath } from "./navigation.mjs";
import {
  historyLine,
  isLive,
  listFooter,
  listRows,
  listSummary,
  pageState,
  stopQuestions,
  whyNoStart,
} from "./computer-state.mjs";
import "./computers.css";
// Eight hours reads better as hours; anything under one stays in minutes.
const sessionLimit = (minutes) => {
  const m = minutes ?? 480;
  return m >= 120
    ? Math.round(m / 60) + "-hour"
    : m >= 60
      ? "one-hour"
      : m + "-minute";
};
const live = ["ready", "idle", "running"];
const historyIcons = {
  play: Play,
  square: Square,
  power: Power,
  hand: Hand,
  undo: Undo2,
};
const workIcons = { ticket: FileText, chat: MessageSquare, channel: Hash };
// A plain click follows the link here; anything else - a new tab, a copied
// address - is left to the browser, which is why these are real links.
const plainClick = (e) =>
  !(e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey);
// The day the history is for is the reader's own, not the server's.
const todayStarted = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
};
export default function Computers({
  data,
  action,
  notify,
  initialId,
  control,
  requestId,
  checkpointToken,
  returnTo,
  take,
  go,
}) {
  const config = data.computers;
  const ai = useAIReady(data.company.id);
  const [busy, setBusy] = useState(null);
  // One pane at a time up to 1100px, as the stylesheet has it: the list alone,
  // or a computer's page alone.
  const [narrow, setNarrow] = useState(
    () => window.matchMedia("(max-width: 1100px)").matches,
  );
  useEffect(() => {
    const media = window.matchMedia("(max-width: 1100px)");
    const change = () => setNarrow(media.matches);
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  const policy = initialId === "controls";
  // The computer whose page Controls was opened over. Controls has an address
  // of its own, so without this the page behind it changed to the first row's
  // computer, and closing it did not come back.
  const behind = useRef(null);
  if (!policy) behind.current = initialId || null;
  const detail = policy ? behind.current : initialId;
  const rows = config ? listRows(data, config, ai) : [];
  // The computer on the right: the one in the address, or on a wide screen
  // the first row that has one - the duck waiting for you comes first. On a
  // narrow one the list is alone, and a page picked for it was not on screen
  // but still asked for a picture every second, and marked its row current.
  const shown =
    config?.items.find((c) => c.id === detail) ||
    (!detail && !narrow && rows.find((r) => r.c)?.c) ||
    null;
  const shownDuck =
    (shown && (data.ducks || []).find((d) => d.id === shown.duck_id)) || null;
  // A picture a second, asked for by the page rather than pushed by the
  // server: pushing it would reload the whole workspace for every open tab in
  // the company once a second, and asking costs a 304 when nothing changed.
  // Only for the one computer on show, only while the server is photographing
  // it, and only while this tab is in front.
  const [frame, setFrame] = useState(0);
  const refresh = !!(
    shown &&
    !control &&
    isLive(shown) &&
    !shown.desktop_failed &&
    shown.photographing &&
    !shown.human_control
  );
  useEffect(() => {
    if (!refresh) return;
    const timer = setInterval(() => {
      if (!document.hidden) setFrame((n) => n + 1);
    }, 1000);
    return () => clearInterval(timer);
  }, [refresh]);
  // What happened to it today, asked again whenever something that would add
  // a line to it has changed.
  const [history, setHistory] = useState({ id: null, events: [] });
  const changed = [
    shown?.id,
    shown?.state,
    shown?.human_control?.generation,
    shown?.request_id,
    shown?.last_start?.at,
    shown?.last_stop?.at,
  ].join("|");
  useEffect(() => {
    if (!shown || control) return;
    let current = true;
    api(
      "/computers/" +
        shown.id +
        "/history?since=" +
        encodeURIComponent(todayStarted()),
    )
      .then(
        (r) => current && setHistory({ id: shown.id, events: r?.events || [] }),
      )
      .catch(() => current && setHistory({ id: shown.id, events: [] }));
    return () => {
      current = false;
    };
  }, [changed, control]);
  // A computer opened by its address - from a chat, Needs you, or a link -
  // may be far down a long list. Bring its row into sight. Coming Back to the
  // list on a phone, it is the row you left that is brought back, with focus
  // on it: the list used to open at its top, so people lost their place.
  const listRef = useRef(null),
    left = useRef(null);
  useEffect(() => {
    const from = left.current;
    left.current = detail;
    const back =
      narrow &&
      !detail &&
      from &&
      listRef.current?.querySelector(
        'a.computer-row-name[href$="/computers/' + from + '"]',
      );
    if (back) {
      back.scrollIntoView({ block: "center" });
      back.focus({ preventScroll: true });
      return;
    }
    listRef.current
      ?.querySelector(".computer-row.selected")
      ?.scrollIntoView({ block: "nearest" });
  }, [detail]);
  // Each computer's page opens at its top. One pane is kept for all of them,
  // so opening another after scrolling down to Today opened it scrolled down
  // too, with its name and state out of sight.
  const pageRef = useRef(null),
    viewRef = useRef(null);
  useEffect(() => {
    if (!shown) return;
    if (viewRef.current) viewRef.current.scrollTop = 0;
    if (narrow && pageRef.current) pageRef.current.scrollTop = 0;
  }, [shown?.id]);
  const closeControls = () =>
    go(
      behind.current
        ? { type: "computers", id: behind.current }
        : { type: "computers" },
    );
  if (!config) return null;
  if (control && detail && config.items.some((c) => c.id === detail)) {
    const c = config.items.find((c) => c.id === detail);
    return (
      <React.Suspense fallback={<div className="page">Opening desktop…</div>}>
        <ComputerControl
          key={c.id + ":" + (requestId || "manual")}
          requestId={requestId}
          checkpointToken={checkpointToken}
          returnTo={returnTo}
          autoTake={take}
          computer={c}
          duck={data.ducks.find((d) => d.id === c.duck_id)}
          data={data}
          action={action}
          notify={notify}
          go={go}
        />
      </React.Suspense>
    );
  }
  const dialog = policy && (
    <ComputerPolicy
      config={config}
      data={data}
      action={action}
      onClose={closeControls}
    />
  );
  if (!config.allowed_ducks.length && !config.items.length)
    return (
      <div className="page">
        <Empty
          icon={Monitor}
          title="Give a duck a computer"
          action={
            data.permissions.company ? (
              <Button
                className="secondary"
                onClick={() => go({ type: "computers", id: "controls" })}
              >
                Choose ducks
              </Button>
            ) : null
          }
        >
          Choose which ducks can use a browser or desktop. Computers start on
          demand and save their disk when stopped.
          {!data.permissions.company &&
            " An owner or admin chooses which ducks get one."}
        </Empty>
        {dialog}
      </div>
    );
  const href = (to) => routePath({ companyId: data.company.id, ...to });
  const follow = (to) => (e) => {
    if (!plainClick(e)) return;
    e.preventDefault();
    go(to);
  };
  async function start(duck) {
    setBusy(duck.id);
    try {
      const r = await action(() =>
        api("/computers/start", "POST", { duck_id: duck.id }),
      );
      if (r?.state && !live.includes(r.state))
        notify("Computer is starting. Its saved workspace will appear here.");
    } finally {
      setBusy(null);
    }
  }
  // The same three questions from the row and from the page, in today's words.
  function stop(c, duck) {
    for (const question of stopQuestions(c, duck, data))
      if (!window.confirm(question)) return;
    action(() => api("/computers/" + c.id + "/pause", "POST", {}));
  }
  // With take, the screen is taken on arrival: the duck is waiting for this
  // person, or they already have it.
  function desktop(c, take = false) {
    go({
      type: "computers",
      id: c.id,
      control: true,
      // The ask it is taken for, by name, as the ask card does. Unnamed, the
      // page found a request for this person it had not been told about and
      // said "This task or request changed" instead of opening the screen.
      ...(take && c.request_id && c.request_user_id === data.user.id
        ? { requestId: c.request_id }
        : {}),
      ...(take ? { take } : {}),
    });
  }
  // Stopping a run frees a duck stuck on a question nobody can answer.
  const press = (kind, c, duck, run = null) =>
    kind === "screen"
      ? desktop(c, true)
      : kind === "watch"
        ? desktop(c)
        : kind === "stop"
          ? stop(c, duck)
          : kind === "stop_run"
            ? action(
                () => api("/jobs/" + run + "/cancel", "POST", {}),
                "Run stopped",
              )
            : start(duck);
  const icons = { start: Play, stop: Square };
  // Said once, above the list: the first thing stopping every computer here.
  const notice = whyNoStart(data, config, ai);
  const because = (why) => (
    <>
      {why.words}
      {why.action && (
        <>
          {" "}
          <button
            type="button"
            className="text-button"
            onClick={() => go(why.action.to)}
          >
            {why.action.label}
          </button>
        </>
      )}
    </>
  );
  const row = (r) => {
    const { duck, c, button } = r;
    const selected = !!c && c.id === shown?.id;
    const Icon = button && icons[button.kind];
    return (
      <li
        key={duck.id}
        className={"computer-row" + (selected ? " selected" : "")}
      >
        <Avatar duck={duck} size={32} />
        <div className="computer-row-text">
          <span className="computer-row-top">
            {/* A duck with no computer yet has nothing to open. */}
            {c ? (
              <a
                className="computer-row-name"
                href={href({ type: "computers", id: c.id })}
                aria-current={selected ? "true" : undefined}
                onClick={follow({ type: "computers", id: c.id })}
              >
                {duck.name}
              </a>
            ) : (
              <span className="computer-row-name">{duck.name}</span>
            )}
            {r.time && <span className="computer-row-time">{r.time}</span>}
          </span>
          <span className={"computer-state tone-" + r.tone}>
            {r.tone === "busy" ? (
              <Loader2 className="spin" size={12} aria-hidden="true" />
            ) : (
              <span className="computer-dot" aria-hidden="true" />
            )}
            <span className="computer-state-words">{r.state}</span>
          </span>
          {r.line3 && <span className="computer-row-line">{r.line3}</span>}
          {c?.proxy?.enabled && (
            <span className="computer-row-line">
              Proxy{" "}
              {c.proxy.connected
                ? "on"
                : c.proxy.state === "starting"
                  ? "connecting"
                  : "needs attention"}
            </span>
          )}
        </div>
        {button && (
          <Button
            className={button.primary ? "" : "secondary"}
            aria-label={button.aria}
            disabled={button.disabled}
            busy={button.kind === "start" && busy === duck.id}
            onClick={() => press(button.kind, c, duck)}
          >
            {Icon && <Icon size={12} aria-hidden="true" />}
            <span>{button.label}</span>
          </Button>
        )}
      </li>
    );
  };
  const groups = [
    ["On", rows.filter((r) => r.group === "on")],
    ["Off", rows.filter((r) => r.group === "off")],
  ].filter(([, group]) => group.length);
  const p = shown && pageState(shownDuck, shown, data, config, ai);
  const picture = p?.picture;
  const src = (v) =>
    "/api/computers/" + shown.id + "/screenshot?v=" + encodeURIComponent(v);
  const PictureIcon =
    picture &&
    { off: Power, busy: Loader2, alert: CircleAlert, noscreen: MonitorOff }[
      picture.kind
    ];
  const work = p?.work;
  const WorkIcon = work && workIcons[work.icon];
  const events = history.id === shown?.id ? history.events : [];
  return (
    <div
      className="computers-page"
      data-view={detail ? "page" : "list"}
      ref={pageRef}
    >
      <section
        className="computers-list"
        aria-label="All computers"
        ref={listRef}
      >
        <div className="computers-list-main">
          <div className="computers-list-head">
            <h2>{plural(rows.length, "computer")}</h2>
            <span>{listSummary(rows, config)}</span>
          </div>
          {notice && <div className="info-box">{because(notice)}</div>}
          {config.computer_limit && (
            <div className="info-box">{config.computer_limit.message}</div>
          )}
          {groups.map(([label, group]) => (
            <React.Fragment key={label}>
              <h3 id={"computers-" + label}>{label}</h3>
              <ul
                className="computer-rows"
                aria-labelledby={"computers-" + label}
              >
                {group.map(row)}
              </ul>
            </React.Fragment>
          ))}
        </div>
        <p className="computers-foot">
          <Clock size={15} aria-hidden="true" />
          <span>{listFooter(config)}</span>
        </p>
      </section>
      {/* Nothing beside the list on a narrow screen: it is not shown there. */}
      {(detail || !narrow) && (
        <section
          className="computer-view"
          aria-label={p ? p.title : "Computers"}
          ref={viewRef}
        >
          {detail && (
            <button
              type="button"
              className="text-button computer-view-back"
              aria-label="Back to computers"
              onClick={() => go({ type: "computers" })}
            >
              <ArrowLeft size={16} aria-hidden="true" />
              Back
            </button>
          )}
          {p ? (
            <div className="computer-view-body">
              <div className="computer-head">
                <Avatar duck={shownDuck} size={40} />
                <div>
                  <div className="computer-title">
                    <h2>{p.title}</h2>
                    <span className={"computer-pill " + (p.on ? "on" : "off")}>
                      <span className="computer-dot" aria-hidden="true" />
                      {p.on ? "On" : "Off"}
                    </span>
                  </div>
                  {p.sub && <span className="computer-sub">{p.sub}</span>}
                </div>
              </div>
              <div className="computer-why">
                <p className="computer-why-head">{p.headline}</p>
                <p>{p.sentence}</p>
              </div>
              {p.error && <p className="computer-error-line">{p.error}</p>}
              {picture.kind === "live" ? (
                <button
                  type="button"
                  className="computer-picture"
                  aria-label={picture.aria}
                  onClick={() => desktop(shown, p.forMe)}
                >
                  <img
                    src={src(picture.refresh ? frame : shown.screenshot_at)}
                    alt=""
                  />
                  <span className="screen-label">
                    <Camera size={12} aria-hidden="true" />
                    {picture.label}
                  </span>
                </button>
              ) : picture.kind === "first" || picture.kind === "noscreen" ? (
                <div className="computer-picture">
                  <span className="computer-picture-over">
                    {PictureIcon && (
                      <PictureIcon size={30} aria-hidden="true" />
                    )}
                    <span
                      className={picture.kind === "first" ? "small" : "big"}
                    >
                      {picture.big}
                    </span>
                  </span>
                </div>
              ) : (
                <div
                  className="computer-picture grey"
                  role="img"
                  aria-label={picture.aria}
                >
                  {shown.screenshot_at && (
                    <img src={src(shown.screenshot_at)} alt="" />
                  )}
                  <span className="computer-picture-over">
                    <span className="computer-picture-icon">
                      <PictureIcon
                        size={19}
                        className={picture.kind === "busy" ? "spin" : undefined}
                        aria-hidden="true"
                      />
                    </span>
                    <span className="big">{picture.big}</span>
                    {picture.small && (
                      <span className="small">{picture.small}</span>
                    )}
                  </span>
                </div>
              )}
              {(p.actions.length > 0 || p.hint || p.blocked) && (
                <div className="computer-buttons">
                  {p.actions.map((a) => {
                    const Icon = icons[a.kind];
                    return (
                      <Button
                        key={a.kind}
                        className={a.primary ? "" : "secondary"}
                        disabled={a.disabled}
                        busy={a.kind === "start" && busy === shownDuck?.id}
                        onClick={() =>
                          press(a.kind, shown, shownDuck, p.stopRun)
                        }
                      >
                        {Icon && <Icon size={14} aria-hidden="true" />}
                        <span>{a.label}</span>
                      </Button>
                    );
                  })}
                  {p.blocked ? (
                    <span className="computer-hint">{because(p.blocked)}</span>
                  ) : (
                    p.hint && <span className="computer-hint">{p.hint}</span>
                  )}
                </div>
              )}
              {work && (
                <div className="computer-part">
                  <h3>{p.workHeading}</h3>
                  {React.createElement(
                    work.to ? "a" : "div",
                    {
                      className: "computer-work",
                      ...(work.to
                        ? { href: href(work.to), onClick: follow(work.to) }
                        : {}),
                    },
                    <>
                      <span className="computer-work-icon">
                        <WorkIcon size={16} aria-hidden="true" />
                      </span>
                      <span className="computer-work-text">
                        <span className="computer-work-title">
                          {work.title}
                        </span>
                        {work.subtitle && (
                          <span className="computer-work-sub">
                            {work.subtitle}
                          </span>
                        )}
                      </span>
                      {work.to && (
                        <ArrowUpRight
                          className="computer-work-go"
                          size={16}
                          aria-hidden="true"
                        />
                      )}
                    </>,
                  )}
                </div>
              )}
              <div className="computer-part">
                <div className="computer-part-head">
                  <h3 id="computer-today">Today</h3>
                  {/* Only the people the Activity log is sent to. */}
                  {data.permissions.integrations && (
                    <a
                      href={href({ type: "settings", tab: "activity" })}
                      onClick={follow({ type: "settings", tab: "activity" })}
                    >
                      All of it in the Activity log
                    </a>
                  )}
                </div>
                {events.length ? (
                  <ol
                    className="computer-history"
                    aria-labelledby="computer-today"
                  >
                    {events.map((e) => {
                      const line = historyLine(e, data, shownDuck, config);
                      const Icon = historyIcons[line.icon];
                      return (
                        <li key={e.id}>
                          <time dateTime={e.created}>{fmtTime(e.created)}</time>
                          <Icon size={14} aria-hidden="true" />
                          <span>
                            {line.words}
                            {line.place &&
                              (line.place.to ? (
                                <a
                                  href={href(line.place.to)}
                                  onClick={follow(line.place.to)}
                                >
                                  {line.place.words}
                                </a>
                              ) : (
                                line.place.words
                              ))}
                          </span>
                        </li>
                      );
                    })}
                  </ol>
                ) : (
                  <p className="computer-quiet">
                    Nothing happened on it today.
                  </p>
                )}
              </div>
            </div>
          ) : (
            <p className="computer-none">
              No computer has started yet. Each duck starts its own when it
              needs it.
            </p>
          )}
        </section>
      )}
      {dialog}
    </div>
  );
}
function ComputerPolicy({ config, data, action, onClose }) {
  const [ducks, setDucks] = useState(config.allowed_ducks),
    [enabled, setEnabled] = useState(!!config.enabled),
    // The version this dialog was opened on. Everything else here is a snapshot
    // that never reloads, and saving replaces the whole policy, so without this
    // the second of two people to press Save quietly put the first one's change
    // back - the company switch included - and stopped machines under ducks
    // that had just been allowed one.
    [base] = useState(config.policy_version),
    [busy, setBusy] = useState(false);
  // Saving this stops machines. The card's own "Save & stop" asks first, and
  // names who is on the screen and which duck is mid-task; this dialog did the
  // same damage from two rooms away with nothing but a line of body text.
  // Somebody signing in on a duck's desktop had the box stopped underneath
  // them, and their page blamed a dropped connection for it.
  const losing = (config.items || []).filter(
    (c) => live.includes(c.state) && (!enabled || !ducks.includes(c.duck_id)),
  );
  const named = (c) =>
    (data.ducks || []).find((d) => d.id === c.duck_id)?.name || "a duck";
  return (
    <Modal title="Computer controls" onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (losing.length) {
            const held = losing.filter((c) => c.human_control);
            const asking = losing.filter(
              (c) =>
                c.request_id &&
                c.request_kind !== "takeover" &&
                !c.human_control,
            );
            if (
              !window.confirm(
                "This stops " +
                  (losing.length === 1
                    ? named(losing[0]) + "'s computer"
                    : losing.length + " running computers") +
                  ". " +
                  (held.length
                    ? "Somebody is on " +
                      (held.length === 1
                        ? named(held[0]) + "'s screen"
                        : held.length + " of those screens") +
                      " right now and will be dropped, losing anything not saved. "
                    : "") +
                  (asking.length
                    ? (asking.length === 1
                        ? named(asking[0]) + " is"
                        : asking.length + " ducks are") +
                      " waiting for somebody on the screen, and will have to ask again. "
                    : "") +
                  "Save anyway?",
              )
            )
              return;
          }
          setBusy(true);
          const r = await action(
            () =>
              api("/computers/settings", "PUT", {
                enabled,
                allowed_ducks: ducks,
                base,
              }),
            (result) => result.warning || "Computer controls saved",
          );
          setBusy(false);
          if (r) onClose();
        }}
      >
        <label className="checkbox-line">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          Allow computers for this company
        </label>
        <Field
          label="Ducks with computer access"
          hint="These ducks can change settings, install software, and manage files on their computers."
        >
          <DuckPicker ducks={flock(data)} value={ducks} onChange={setDucks} />
        </Field>
        <div className="info-box">
          <Clock size={17} />
          {/* Read off the server rather than remembered here, because this
              sentence claimed one machine per company and a fifteen-minute
              session long after both numbers had changed. */}
          <span>
            Small machines, up to {config.max_running ?? 10} running at once for
            this company,{" "}
            {Math.round((config.idle_seconds ?? COMPUTER_IDLE_SECONDS) / 60)}{" "}
            idle minutes before stopping, and a{" "}
            {sessionLimit(config.session_minutes)} maximum session. Viewing a
            saved screenshot never starts a computer. Disabling a duck saves and
            stops its computer.
          </span>
        </div>
        <div className="modal-actions">
          <Button busy={busy}>Save controls</Button>
        </div>
      </form>
    </Modal>
  );
}
