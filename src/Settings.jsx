import AISettings from "./AISettings.jsx";
import Storage from "./Storage.jsx";
import ComputerUse from "./ComputerUse.jsx";
import EmailSettings from "./EmailSettings.jsx";
import TwoStep from "./TwoStep.jsx";
import Connections from "./Connections.jsx";
import Secrets from "./Secrets.jsx";
import DuckSettings from "./DuckSettings.jsx";
import Appearance from "./Appearance.jsx";
import ActivityLog from "./ActivityLog.jsx";
import BrowserNotifications from "./BrowserNotifications.jsx";
import WorkLimits from "./WorkLimits.jsx";
import BillingPage from "./Billing.jsx";
import React, { useState, useEffect, useId, useRef } from "react";
import {
  HardDrive,
  Gauge,
  Mail,
  Palette,
  Sparkles,
  Plug,
  KeyRound,
  Building2,
  CreditCard,
  History,
  User,
  Check,
  CircleAlert,
  Clock,
  Plus,
  ExternalLink,
  ShieldCheck,
  Copy,
  Trash2,
  RefreshCw,
  LogOut,
  Download,
  Play,
  CircleStop,
  TriangleAlert,
  Settings2,
  ChevronLeft,
  Upload,
  Bell,
} from "lucide-react";
import CompanyTile from "./CompanyTile.jsx";
import "./company-logo.css";
import {
  api,
  Avatar,
  Modal,
  Field,
  Button,
  IconButton,
  Empty,
  DuckPicker,
  flock,
  useUnsavedGuard,
} from "./ui.jsx";
import {
  busyRows,
  costLine,
  dialogLead,
  dialogPoints,
  headline,
  idleLine,
  stoppedFoot,
  stoppedHeadline,
  stoppedLine,
  subLine,
  workLine,
} from "./pause-flock-words.mjs";
import "./pause-flock.css";
import { forgetDrafts } from "./drafts.mjs";
import { forgetCompanies } from "./known-companies.mjs";
import { roleName } from "./member-permissions.mjs";
import {
  failedLine,
  minutes,
  savedLine,
  usualHelp,
  waitChoices,
} from "./wait-words.mjs";
import "./account.css";
import SettingsHead from "./SettingsHead.jsx";
import {
  settingsMenu,
  pageFor,
  isCommunityEdition,
} from "./settings-pages.mjs";
// Each page's mark in the menu. Its name, and who may open it, are in
// settings-pages.mjs.
const ICONS = {
  account: User,
  emails: Mail,
  appearance: Palette,
  company: Building2,
  ai: Sparkles,
  ducks: ShieldCheck,
  connections: Plug,
  secrets: KeyRound,
  billing: CreditCard,
  storage: HardDrive,
  usage: Gauge,
  activity: History,
  notifications: Bell,
  "work-limits": Clock,
};
// The page just picked from the menu. App builds Settings anew for every page,
// menu and all, so the button that was pressed is gone by the time the page is
// on the screen, and the keyboard was left on nothing. The new Settings reads
// this once to put it back.
let chosen = null;
export default function Settings({
  data,
  action,
  notify,
  initialTab,
  focusConnectionId,
  onTabChange,
  refresh,
}) {
  // A link to a page this person may not use shows Your account.
  // navigation.mjs has already said so, and moved the address.
  const tab = pageFor(initialTab, data);
  const setTab = onTabChange;
  // On a narrow window the menu is a page of its own, shown only after "All
  // settings" is pressed. It is not an address: Back goes where it always did.
  const [listing, setListing] = useState(false);
  const desktopClient =
    typeof navigator !== "undefined" && /Electron/i.test(navigator.userAgent);
  const [downloads, setDownloads] = useState(null);
  useEffect(() => {
    if (desktopClient) return;
    let live = true;
    api("/desktop-downloads")
      .then((value) => {
        if (live) setDownloads(value);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [desktopClient]);
  const menu = useRef(null),
    content = useRef(null),
    back = useRef(false);
  const title = () => content.current?.querySelector("h2")?.focus();
  useEffect(() => {
    const picked = chosen;
    chosen = null;
    if (picked !== tab) return;
    const item = menu.current?.querySelector('[aria-current="page"]');
    // On a narrow window the menu is put away, so the page's title.
    if (item?.offsetParent) item.focus();
    else title();
  }, []);
  useEffect(() => {
    if (listing) menu.current?.querySelector('[aria-current="page"]')?.focus();
    else if (back.current) title();
    back.current = false;
  }, [listing]);
  // A press anywhere outside Settings puts the list away. It can open the page
  // that is already open, as your own row or the theme button at the top do,
  // and App keeps this Settings then, so the list stayed over the page just
  // asked for. The keyboard stays where that press left it.
  useEffect(() => {
    if (!listing) return;
    const away = (e) =>
      !e.target.closest?.(".settings-layout") && setListing(false);
    document.addEventListener("click", away);
    return () => document.removeEventListener("click", away);
  }, [listing]);
  const choose = (id) => {
    // The page that is open: on a narrow window that means back to it, with
    // the keyboard on its title.
    if (id === tab) {
      back.current = true;
      return setListing(false);
    }
    chosen = id;
    setTab(id);
  };
  return (
    <div className={"settings-layout" + (listing ? " listing" : "")}>
      <nav className="settings-nav" aria-label="Settings" ref={menu}>
        {settingsMenu(data).map((group) => (
          <div className="settings-nav-group" key={group.key}>
            <h2>{group.label}</h2>
            {group.pages.map(({ id, name }) => {
              const Icon = ICONS[id];
              return (
                <button
                  type="button"
                  key={id}
                  className={tab === id ? "active" : ""}
                  aria-current={tab === id ? "page" : undefined}
                  onClick={() => choose(id)}
                >
                  <Icon size={16} aria-hidden="true" />
                  {name}
                </button>
              );
            })}
          </div>
        ))}
        {data.distribution?.edition === "community" && (
          <div className="settings-nav-group">
            <h2>About TameDuck</h2>
            <a
              className="settings-nav-link"
              href="/about"
              target="_blank"
              rel="noopener noreferrer"
            >
              <ExternalLink size={16} aria-hidden="true" />
              Source &amp; license
            </a>
          </div>
        )}
        {!desktopClient && !data.distribution && downloads && (
          <div className="settings-nav-group settings-downloads">
            <h2>Desktop app</h2>
            {downloads.platforms?.macUniversal?.available ? (
              <a className="settings-nav-link" href="/downloads/desktop/mac">
                <Download size={16} aria-hidden="true" />
                Mac
              </a>
            ) : (
              <span className="settings-nav-link settings-download-disabled">
                <Download size={16} aria-hidden="true" />
                Mac — Preparing download
              </span>
            )}
            {downloads.platforms?.windows?.available ? (
              <a
                className="settings-nav-link"
                href="/downloads/desktop/windows"
              >
                <Download size={16} aria-hidden="true" />
                Windows
              </a>
            ) : (
              <span className="settings-nav-link settings-download-disabled">
                <Download size={16} aria-hidden="true" />
                Windows — Preparing download
              </span>
            )}
          </div>
        )}
      </nav>
      <div className="settings-content" ref={content}>
        <button
          type="button"
          className="settings-back"
          onClick={() => setListing(true)}
        >
          <ChevronLeft size={18} aria-hidden="true" />
          All settings
        </button>
        {tab === "appearance" && <Appearance />}
        {tab === "ai" && <AISettings data={data} action={action} />}{" "}
        {tab === "connections" && data.permissions.integrations && (
          <Connections
            data={data}
            action={action}
            focus={focusConnectionId}
            unfocus={() => onTabChange("connections")}
          />
        )}{" "}
        {tab === "secrets" && data.permissions.integrations && (
          <Secrets data={data} action={action} />
        )}{" "}
        {tab === "ducks" && data.permissions.ducks && (
          <DuckSettings data={data} action={action} onTab={setTab} />
        )}
        {tab === "company" && data.permissions.company && (
          <Company data={data} action={action} />
        )}
        {tab === "work-limits" && data.permissions.company && (
          <WorkLimits data={data} action={action} />
        )}{" "}
        {tab === "storage" &&
          (data.permissions.company || data.permissions.billing) && (
            <Storage company={data.company} />
          )}
        {tab === "usage" &&
          (data.permissions.company || data.permissions.billing) && (
            <ComputerUse company={data.company} />
          )}
        {tab === "emails" && <EmailSettings />}
        {tab === "notifications" && (
          <BrowserNotifications company={data.company} />
        )}
        {tab === "billing" && !isCommunityEdition(data) && (
          <BillingPage data={data} action={action} refresh={refresh} />
        )}{" "}
        {tab === "activity" && data.permissions.integrations && (
          <ActivityLog data={data} />
        )}{" "}
        {tab === "account" && (
          <Account data={data} action={action} notify={notify} />
        )}
      </div>
    </div>
  );
}
// Settings > Your account: who you are, how long ducks wait for you, and
// signing in, in the order people look for them. It used to open on Sign out,
// start a second page title halfway down, and end on a download of the whole
// company's work, which is not a personal thing: that is at the foot of
// Settings > Company now.
function Account({ data, action, notify }) {
  const signingIn = useId();
  const [signIn, setSignIn] = useState(null);
  const [error, setError] = useState("");
  const load = async () => {
    try {
      setSignIn(await api("/account/sign-in"));
    } catch (e) {
      setError(e.message);
    }
  };
  useEffect(() => {
    load();
  }, []);
  return (
    <div className="account-page">
      <SettingsHead page="account" />
      <div className="settings-card account-you">
        <Avatar name={data.user.name} size={38} />
        <div>
          <b>{data.user.name}</b>
          <span>{data.user.email}</span>
          <span>{roleName(data.role) + " at " + data.company.name}</span>
        </div>
      </div>
      <HumanWaitSettings data={data} action={action} />
      <section
        className="settings-card account-signin"
        aria-labelledby={signingIn}
      >
        <h3 id={signingIn}>Signing in</h3>
        <p>
          You sign in with a link we send to your email. There is no password to
          remember.
        </p>
        {error && <div className="error-box">{error}</div>}
        {signIn && <TwoStep info={signIn} notify={notify} reload={load} />}
        <div className="account-signin-row">
          <div className="account-signin-line">
            <div>
              <h4>This device</h4>
              <p>
                Signing out clears anything you typed here and did not send.
              </p>
            </div>
            <Button
              className="secondary"
              onClick={async () => {
                // Signed out first: a sign-out that fails used to wipe the
                // unsent words anyway, say nothing, and leave you signed in.
                try {
                  await api("/auth/logout", "POST", {});
                } catch (e) {
                  if (e.status !== 401) {
                    notify(
                      e.status
                        ? "Not signed out. Try again."
                        : "Not signed out. Check your connection and try again.",
                    );
                    return;
                  }
                }
                // Unsent words go with the person, not with the machine.
                forgetDrafts(data.user.id);
                // And the names of their companies, kept for the page that
                // opens TameDuck.
                forgetCompanies();
                location.href = "/";
              }}
            >
              <LogOut size={16} />
              Sign out
            </Button>
          </div>
        </div>
      </section>
    </div>
  );
}
// How long a duck keeps a job open for you before it carries on without you.
// One list: your usual first, then every duck, each row the same six times,
// and every pick saved at once. It used to be a number box with its own Save
// button beside five lists that saved the moment they changed, with nothing
// on the page to say so. Settings > Ducks used to offer these times too; that
// column has gone, so this is the one screen for them.
const USUAL = "usual";
// A list's value is text: "" is a duck on your usual, anything else minutes.
const waitOf = (value) => (value === "" ? null : Number(value));

function HumanWaitSettings({ data, action }) {
  const saved = data.human_wait_settings;
  const heading = useId();
  // Picks the server has not answered yet, so a list shows what was picked
  // instead of jumping back to the old time while it saves.
  const [picked, setPicked] = useState({});
  // The last pick and the time it replaced, or that it did not save: the line
  // under the list, and what Undo puts back.
  const [said, setSaid] = useState(null);
  // The row whose Undo is on its way.
  const [undoing, setUndoing] = useState(null);
  const lists = useRef({});
  // One save at a time, in the order they were picked. A closed list changes
  // one step per arrow key on Windows, and each step is a save: sent side by
  // side, an earlier step could land last and be what stayed.
  const queue = useRef(Promise.resolve());
  if (!saved) return null;
  const usual = saved.default_minutes;
  const companies = data.companies?.length || 1;
  const rows = [
    { key: USUAL, stored: String(usual) },
    ...flock(data).map((duck) => ({
      key: duck.id,
      duck,
      stored: String(saved.duck_overrides?.[duck.id] ?? ""),
    })),
  ];

  // A save that fails says so in the line under the list, beside the row it
  // is about, in the page's own words: nothing is thrown for action() to put
  // in a pop-up. action() then fetches the page's data again, so every list
  // shows what is stored - except when the server was not reached at all, as
  // offline, where that would fail too and pop up a second "Could not reach
  // TameDuck" beside the line. A save that did land then still arrives with
  // the live update the server sends every open tab.
  const send = (key, value) => {
    const body =
      key === USUAL
        ? { default_minutes: Number(value) }
        : { duck_overrides: { [key]: waitOf(value) } };
    const run = queue.current.then(async () => {
      let ok = true;
      try {
        await api("/human-wait-settings", "PATCH", body);
      } catch (e) {
        if (!e.status) return false;
        ok = false;
      }
      await action(() => ok);
      return ok;
    });
    queue.current = run;
    return run;
  };
  const settle = (key, value) =>
    setPicked((now) => {
      if (now[key] !== value) return now;
      const next = { ...now };
      delete next[key];
      return next;
    });

  async function pick(row, value) {
    // Picking the same row again keeps what it had before the first pick, so
    // Undo goes back to where you started rather than one step - unless the
    // time has been changed somewhere else since, in another tab, say. Then
    // Undo goes back to that.
    const before =
      said && said.key === row.key && said.after === row.stored
        ? said.before
        : row.stored;
    setPicked((now) => ({ ...now, [row.key]: value }));
    const ok = await send(row.key, value);
    settle(row.key, value);
    setSaid({ key: row.key, before, after: value, failed: !ok });
  }

  async function undo() {
    if (undoing || !said) return;
    const mine = said;
    const { key, before } = mine;
    setUndoing(key);
    setPicked((now) => ({ ...now, [key]: before }));
    const ok = await send(key, before);
    settle(key, before);
    setUndoing(null);
    // The line goes only if it is still the one that was undone: a pick on
    // another row that landed meanwhile keeps its own line and its own Undo.
    setSaid((now) =>
      !ok
        ? { key, before: mine.after, after: before, failed: true }
        : now === mine
          ? null
          : now,
    );
    // The list that changed back is where you carry on.
    lists.current[key]?.focus();
  }

  // The line says only what is true now. Nothing while that row is still
  // saving, and nothing once its time has changed somewhere else, such as in
  // another tab. A save that seemed to fail but did land - the answer was
  // lost on the way back - is a save.
  const row = said && rows.find((r) => r.key === said.key);
  const landed = row && row.stored === said.after;
  const line =
    !row || (picked[said.key] !== undefined && undoing !== said.key)
      ? null
      : landed
        ? savedLine({
            duck: row.duck?.name,
            wait: waitOf(said.after),
            usual,
            companies,
          })
        : said.failed
          ? failedLine({
              duck: row.duck?.name,
              wait: waitOf(row.stored),
              usual,
            })
          : null;
  const failed = line && !landed;

  return (
    <section className="settings-card account-wait" aria-labelledby={heading}>
      <h3 id={heading}>How long ducks wait for you</h3>
      <p>
        When a duck needs something from you, it keeps that job open this long.
        Then it carries on without you.
      </p>
      <div className="account-wait-list">
        {rows.map((r) => {
          const id = heading + r.key;
          const value = picked[r.key] ?? r.stored;
          return (
            <div
              key={r.key}
              className={"account-wait-row" + (r.duck ? "" : " is-usual")}
            >
              {r.duck ? (
                <Avatar duck={r.duck} size={24} />
              ) : (
                <span className="account-wait-tile" aria-hidden="true">
                  <Clock size={15} />
                </span>
              )}
              <span className="account-wait-name">
                <label htmlFor={id}>
                  {r.duck ? r.duck.name : "Your usual"}
                </label>
                {!r.duck && (
                  <small id={id + "help"}>{usualHelp(companies)}</small>
                )}
              </span>
              <select
                id={id}
                ref={(el) => {
                  lists.current[r.key] = el;
                }}
                value={value}
                aria-describedby={r.duck ? undefined : id + "help"}
                onChange={(e) => pick(r, e.target.value)}
              >
                {r.duck && <option value="">Your usual</option>}
                {waitChoices(waitOf(value)).map((n) => (
                  <option key={n} value={String(n)}>
                    {minutes(n)}
                  </option>
                ))}
              </select>
            </div>
          );
        })}
      </div>
      <div className="account-wait-said" role="status">
        {line && (
          <div className={"duck-perms-undo" + (failed ? " is-failed" : "")}>
            {failed ? (
              <CircleAlert size={16} aria-hidden="true" />
            ) : (
              <Check size={16} aria-hidden="true" />
            )}
            <span>{line}</span>
            {landed && said.before !== said.after && (
              <button
                type="button"
                aria-disabled={!!undoing || undefined}
                onClick={undo}
              >
                Undo
              </button>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

// The one control that stops every duck in the company, and the one that
// starts them again. It sits above the Company form rather than in it, because
// it is not a setting: it ends work colleagues are in the middle of, for good,
// and it happens the moment it is pressed.
//
// It used to be a tick box dressed exactly like "Let Chief Duck grow the flock"
// in the row above it, 711px to the right of its own name and below the fold,
// which did nothing at all until you found "Save company settings" further down
// still - and then asked in a browser dialog, or, when nothing happened to be
// running, asked nothing and shut the company quietly. So the card names each
// busy duck, what it is on and who asked for it: the price is on the screen
// before the press, and the press always asks.
function PauseFlock({ data, action }) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const heading = useId();
  // A dialog that closes takes the focus with it, and a press replaces the
  // button that was pressed, so somebody working by keyboard was left with
  // nothing focused and had to tab from the top of the page again. The card
  // hands the focus on to whichever control it is showing now. There is no
  // dependency list because the render that matters is whichever one finally
  // puts that control on the screen.
  const card = useRef(null);
  const takeBack = useRef(false);
  useEffect(() => {
    if (!takeBack.current || asking) return;
    takeBack.current = false;
    card.current
      ?.querySelector(".pause-flock-stop, .pause-flock-start")
      ?.focus();
  });
  const rows = busyRows(data);
  const paused = !!data.company.paused;
  const company = data.company.name;
  const idle = flock(data)
    .filter((duck) => !rows.some((row) => row.duck_id === duck.id))
    .map((duck) => duck.name);
  // The company's own PATCH is what stops the flock, and it wants the whole
  // company back. Sending what is stored is how this button changes the one
  // thing it is about and leaves the form below - name, clock, rules, "Let
  // Chief Duck grow the flock" - exactly as it is, saved or not.
  const setPaused = async (next) => {
    setBusy(true);
    await action(
      () =>
        api("/company", "PATCH", {
          name: data.company.name,
          rules: data.company.rules,
          auto_create: !!data.company.auto_create,
          paused: next,
        }),
      next ? "Every duck is stopped." : "Every duck is working again.",
    );
    takeBack.current = true;
    setBusy(false);
    setAsking(false);
  };
  return (
    <section className="pause-flock" aria-labelledby={heading} ref={card}>
      <div className="pause-flock-card">
        {paused && (
          <p className="pause-flock-band">
            <CircleStop size={15} aria-hidden="true" />
            Everything is stopped
          </p>
        )}
        <div className="pause-flock-body">
          <div className="pause-flock-main">
            <h3 className="pause-flock-state" id={heading}>
              {!paused && (
                <span className="pause-flock-dot" aria-hidden="true" />
              )}
              <span>{paused ? stoppedHeadline(company) : headline(rows)}</span>
            </h3>
            {!paused && (
              <p className="pause-flock-sub">{subLine(rows, company)}</p>
            )}
          </div>
          {paused && !data.company.billing_hold && (
            <div className="pause-flock-acts">
              <Button
                className="pause-flock-start"
                busy={busy}
                onClick={() => setPaused(false)}
              >
                <Play size={16} />
                Start all ducks
              </Button>
            </div>
          )}
          {/* Paused by billing: starting the plan is what starts them, and
              the button here would only be refused. */}
          {paused && !!data.company.billing_hold && (
            <p className="pause-flock-sub">
              The ducks start again when the plan is started or paid, in
              Settings → Billing.
            </p>
          )}
        </div>
        {!!rows.length && (
          <div className="pause-flock-rows">
            {rows.map((row, index) => (
              <div className="pause-flock-row" key={index}>
                <Avatar duck={row.face} name={row.duck} size={30} />
                <span className="pause-flock-who">
                  <span className="pause-flock-name">{row.duck}</span>
                  <span className="pause-flock-what">
                    {paused ? stoppedLine(row) : workLine(row)}
                  </span>
                </span>
                {row.status === "waiting_human" && (
                  <span className="pause-flock-chip">
                    {row.yours
                      ? "Waiting for you"
                      : "Waiting for " + row.person}
                  </span>
                )}
              </div>
            ))}
            {!paused && !!idle.length && (
              <p className="pause-flock-rest">{idleLine(idle)}</p>
            )}
          </div>
        )}
        {paused ? (
          <p className="pause-flock-foot">{stoppedFoot(rows)}</p>
        ) : (
          <div className="pause-flock-act">
            <span>{costLine(rows)}</span>
            <button
              type="button"
              className="pause-flock-stop"
              disabled={busy}
              onClick={() => {
                takeBack.current = true;
                setAsking(true);
              }}
            >
              <CircleStop size={15} aria-hidden="true" />
              Stop all ducks
            </button>
          </div>
        )}
      </div>
      {asking && (
        <Modal
          title="Stop all ducks?"
          onClose={() => setAsking(false)}
          // Half a stop is not a state this screen has: while the press is on
          // its way the question stays where it is, cross and all.
          closeGuard={() => !busy}
        >
          <div className="pause-flock-dialog">
            <p className="pause-flock-lead">
              <span className="pause-flock-warn" aria-hidden="true">
                <TriangleAlert size={16} />
              </span>
              <span>{dialogLead(rows)}</span>
            </p>
            <ul className="pause-flock-points">
              {dialogPoints(rows, company).map((point) => (
                <li key={point}>{point}</li>
              ))}
            </ul>
            <div className="modal-actions">
              <Button
                type="button"
                className="secondary"
                autoFocus
                disabled={busy}
                onClick={() => setAsking(false)}
              >
                Keep working
              </Button>
              <Button
                type="button"
                className="pause-flock-go"
                busy={busy}
                onClick={() => setPaused(true)}
              >
                <CircleStop size={16} />
                Stop all ducks
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </section>
  );
}
// The browser's list of zones leaves out "UTC", which is the clock a company
// made on a UTC server starts on. With its own zone missing, the list showed
// the first one instead, and saving anything on this page quietly moved the
// company - and now its schedules - to Africa/Abidjan.
const zoneChoices = (current) => {
  const zones = Intl.supportedValuesOf
    ? Intl.supportedValuesOf("timeZone")
    : [];
  return current && !zones.includes(current) ? [current, ...zones] : zones;
};
// The tile and its picture, near the top of Company since that is where the
// name lives too. Only somebody who may change company settings gets the
// buttons; everyone else just sees whatever is already there.
function CompanyLogo({ data, action }) {
  const picker = useRef(null);
  const [busy, setBusy] = useState(false);
  const canEdit = !!data.permissions.company;
  const hasLogo = !!data.company.logo_url;
  async function upload(file) {
    if (!file) return;
    if (file.size > 1_000_000) {
      await action(() => {
        throw new Error("Logos can be up to 1 MB.");
      });
      return;
    }
    setBusy(true);
    await action(async () => {
      const r = await fetch("/api/company/logo", {
        method: "POST",
        headers: {
          "Content-Type": file.type || "application/octet-stream",
          "X-TameDuck": "1",
        },
        body: file,
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok)
        throw Object.assign(
          new Error(
            body.error ||
              (r.status === 413
                ? "Logos can be up to 1 MB."
                : "The upload failed. Try again."),
          ),
          { status: r.status },
        );
      return body;
    }, "Logo saved");
    setBusy(false);
  }
  async function remove() {
    setBusy(true);
    await action(() => api("/company/logo", "DELETE"), "Logo removed");
    setBusy(false);
  }
  return (
    <div className="company-logo-row">
      <CompanyTile company={data.company} className="company-logo-tile" />
      <div className="company-logo-info">
        <strong>Logo</strong>
        <small>
          Shown instead of the letter, everywhere {data.company.name} appears.
          Square pictures work best.
        </small>
      </div>
      {canEdit && (
        <div className="company-logo-actions">
          <input
            ref={picker}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            hidden
            onChange={(e) => {
              const file = e.target.files[0];
              e.target.value = "";
              upload(file);
            }}
          />
          <Button
            type="button"
            busy={busy}
            onClick={() => picker.current.click()}
          >
            <Upload size={16} /> {hasLogo ? "Replace" : "Upload"}
          </Button>
          {hasLogo && (
            <Button
              type="button"
              className="secondary"
              busy={busy}
              onClick={remove}
            >
              <Trash2 size={16} /> Remove
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
function Company({ data, action }) {
  const [busy, setBusy] = useState(false);
  const copy = useId();
  // What the form held when it opened or was last saved, to tell typed work
  // from none.
  const formRef = useRef(null),
    saved = useRef(null);
  const now = () => JSON.stringify([...new FormData(formRef.current)]);
  useEffect(() => {
    saved.current = now();
  }, []);
  useUnsavedGuard(() => !!formRef.current && saved.current !== now());
  return (
    <>
      <SettingsHead page="company" />
      <CompanyLogo data={data} action={action} />
      <PauseFlock data={data} action={action} />
      <form
        ref={formRef}
        className="settings-card"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          const sent = now();
          const form = Object.fromEntries(new FormData(e.currentTarget));
          const done = await action(
            () =>
              api("/company", "PATCH", {
                name: form.name,
                rules: form.rules,
                auto_create: form.auto_create === "on",
                paused: !!data.company.paused,
                timezone: form.timezone,
              }),
            "Company settings saved",
          );
          if (done) saved.current = sent;
          setBusy(false);
        }}
      >
        <Field label="Company name">
          <input
            name="name"
            defaultValue={data.company.name}
            required
            maxLength={100}
          />
        </Field>
        {/* Nothing in the product could set this. It was taken from whatever
            clock the server machine happened to be on, and the Schedules screen
            then stated it as fact - so an owner in Amsterdam running on a UTC
            box asked for a 09:00 summary and got it at 11:00, with no field
            anywhere to say so. The route has accepted and validated a timezone
            all along; no screen ever sent one. */}
        <Field
          label="Your working clock"
          hint="Scheduled tasks run on this clock, and move with it when you change it: 09:00 stays 09:00. Times already on your screen are shown in your own device's zone."
        >
          <select name="timezone" defaultValue={data.company.timezone || ""}>
            {zoneChoices(data.company.timezone).map((zone) => (
              <option key={zone} value={zone}>
                {zone.replace(/_/g, " ")}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label="Company context and rules"
          hint="Included whenever a duck starts work. Add your mission, terminology, preferences, and boundaries."
        >
          <textarea
            name="rules"
            defaultValue={data.company.rules}
            rows={9}
            placeholder={
              "We help…\nOur customers are…\nOur tone of voice is…\nAlways ask before…"
            }
            maxLength={60000}
          />
        </Field>
        <label className="setting-toggle">
          <span>
            <strong>Let Chief Duck grow the flock</strong>
            <small>
              The chief can create specialists when the person asking has
              permission to manage ducks.
            </small>
          </span>
          <input
            name="auto_create"
            type="checkbox"
            defaultChecked={!!data.company.auto_create}
          />
        </label>
        <div className="card-actions">
          <Button busy={busy}>Save</Button>
        </div>
      </form>
      {/* The whole company's work in one file. It sat at the foot of Your
          account, which is about one person. This tab only opens for somebody
          with the company permission, which is what /api/export asks for, and
          the route puts schedules in only for somebody who may see them. */}
      <section className="settings-card account-export" aria-labelledby={copy}>
        <h3 id={copy}>A copy of {data.company.name}’s work</h3>
        <p>
          {data.permissions.tasks
            ? "Company settings, ducks and their notes, tasks, schedules, skills and documents, in one file."
            : "Company settings, ducks and their notes, tasks, skills and documents, in one file."}{" "}
          Uploaded files are listed by name; what is in them is not included.
        </p>
        <a className="button secondary" href="/api/export" download>
          <Download size={16} />
          Download a copy
        </a>
      </section>
    </>
  );
}
