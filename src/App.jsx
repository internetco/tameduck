import { appEntryPath, appUpdateAvailable } from "../shared/app-build.mjs";
import { OpeningPage, StatusStrip } from "./StatusStrip.jsx";
import { noteFailure } from "./status-words.mjs";
import {
  companyToOpen,
  forgetCompanies,
  knownCompanies,
  noteCompanies,
  otherCompany,
} from "./known-companies.mjs";
import { forgetDrafts } from "./drafts.mjs";
import { HumanInputNotice } from "./HumanInput.jsx";
import WorkflowBoards from "./WorkflowBoards.jsx";
import BoardSetup from "./BoardSetup.jsx";
import { inboxRows } from "./inbox-list.mjs";
import Schedules from "./Schedules.jsx";
import SchedulePage from "./SchedulePage.jsx";
import Chat from "./Chat.jsx";
import DirectMessagePicker from "./DirectMessagePicker.jsx";
import { conversationName, conversationPeer } from "./chat-utils.mjs";
import { duckRowSignal } from "./duck-activity.mjs";
import "./sidebar-signals.css";
import {
  ArchiveChannelDialog,
  ArchivedChannelsDialog,
} from "./ChannelArchive.jsx";
import ChannelMembers from "./ChannelMembers.jsx";
import {
  readRoute,
  routePath,
  resolveRoute,
  withDesktopReturn,
  withFilesReturn,
} from "./navigation.mjs";
import Computers from "./Computers.jsx";
import Skills from "./Skills.jsx";
import CompanyTile from "./CompanyTile.jsx";
import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  Archive,
  BookOpen,
  CircleHelp,
  Monitor,
  Palette,
  Search,
  Plus,
  ChevronDown,
  CreditCard,
  Inbox,
  Columns3,
  Files,
  Settings as SettingsIcon,
  Settings2,
  Hash,
  MessageSquare,
  ArrowUp,
  ArrowRight,
  PanelRight,
  Menu,
  LogOut,
  Command,
  Check,
  ShieldCheck,
  LayoutGrid,
  X,
  Users,
  Play,
  RotateCcw,
  Square,
  ExternalLink,
  ChevronLeft,
} from "lucide-react";
import {
  api,
  Avatar,
  Modal,
  Field,
  Button,
  IconButton,
  Empty,
  Markdown,
  CopyButton,
  fmtTime,
  fmtDate,
  anyDialogOpen,
  flock,
  waitingOnYou,
  Toast,
  BrandMark,
  mayLeave,
} from "./ui.jsx";
import FilesView, { filesTitle } from "./Files.jsx";
import { InboxView, DuckEditor, GroupEditor, TeamView } from "./views.jsx";
import { SearchView } from "./Search.jsx";
import Settings from "./Settings.jsx";
import HelpDrawer from "./HelpDrawer.jsx";
import { mayOpen, isCommunityEdition } from "./settings-pages.mjs";
import Onboarding from "./Onboarding.jsx";
import { BillingStrip, BillingGate, DuckLimitDialog } from "./Billing.jsx";
import { planLine, newCompanyCost } from "./billing-words.mjs";
const loadedAppEntry = appEntryPath(
  document.querySelector('script[type="module"][src]')?.getAttribute("src"),
);
const startToken = window.location.hash.slice(1);
const startPath = window.location.pathname;
// The one address that keeps the old form: the first account on a new server.
// Every other link opened signed out goes through the one way in and comes
// back to where it was going.
const oldForm = () => startPath === "/setup" && !!startToken;
export default function App() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState(() =>
    readRoute(window.location.pathname, window.location.search),
  );
  const viewRef = useRef(view);
  const dataRef = useRef(null);
  const companyPending = useRef(!!view.companyId);
  const refreshAgain = useRef(false);
  const [modal, setModal] = useState(null);
  // The company whose "paused" page was put aside to look around, this visit.
  const [lookedAround, setLookedAround] = useState(null);
  // Bumped when somebody goes to the chat that is already open.
  const [latest, setLatest] = useState(0);
  const [seek, setSeek] = useState(0);
  const [toast, setToast] = useState("");
  const [mobile, setMobile] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const helpButtonRef = useRef(null);
  const [recovery, setRecovery] = useState(null);
  const [eventVersion, setEventVersion] = useState(0);
  const [companyMenu, setCompanyMenu] = useState(false);
  // Why the last check failed, since when, how many tries, and when the next
  // one is (src/status-words.mjs). Null while all is well.
  const [trouble, setTrouble] = useState(null);
  const troubleRef = useRef(null);
  const noteTrouble = (t) => {
    troubleRef.current = t;
    setTrouble(t);
  };
  // "Back online", for four seconds after the strip said something was wrong.
  const [backOnline, setBackOnline] = useState(false);
  const backTimer = useRef();
  // The name of the skill or topic open in the Skills library, for the title.
  const [skillsTitle, setSkillsTitle] = useState("");
  // Places in the top bar a page can put its own controls: Files puts Back
  // before its name and Upload and New document after it.
  const [topbarLead, setTopbarLead] = useState(null);
  const [topbarActions, setTopbarActions] = useState(null);
  const refreshRef = useRef(false);
  const reloadTimer = useRef();
  const lastReload = useRef(0);
  const reopenTimer = useRef();
  const retryTimer = useRef();
  // Bumped to open the live connection again after the server closed it.
  const [liveAttempt, setLiveAttempt] = useState(0);
  const notify = useCallback((message) => {
    setToast(message);
  }, []);
  useEffect(() => {
    if (toast) {
      const t = setTimeout(() => setToast(""), 6000);
      return () => clearTimeout(t);
    }
  }, [toast]);
  const showView = useCallback((next, replace = true) => {
    viewRef.current = next;
    setView(next);
    const path = routePath(next);
    if (
      window.location.pathname + window.location.search !== path ||
      window.location.hash
    )
      window.history[replace ? "replaceState" : "pushState"]({}, "", path);
  }, []);
  const refresh = useCallback(async () => {
    if (refreshRef.current) {
      refreshAgain.current = true;
      return refreshRef.current;
    }
    const load = async () => {
      do {
        refreshAgain.current = false;
        try {
          const requestedCompany = viewRef.current.companyId;
          let d = await api("/state").catch(async (e) => {
            // The session can be on a company that will not open while the
            // address asks for another one: after a switch that failed half
            // way, say. The switch below needs a state that loaded, so it
            // never came, and the other company could not open either.
            if (
              !companyPending.current ||
              !requestedCompany ||
              e.offline ||
              e.status === 401
            )
              throw e;
            await api("/companies/switch", "POST", {
              id: requestedCompany,
            }).catch(() => {
              throw e;
            });
            return api("/state");
          });
          if (requestedCompany !== viewRef.current.companyId) {
            refreshAgain.current = true;
            continue;
          }
          if (
            companyPending.current &&
            requestedCompany &&
            requestedCompany !== d.company.id
          ) {
            if (d.companies.some((c) => c.id === requestedCompany)) {
              await api("/companies/switch", "POST", { id: requestedCompany });
              d = await api("/state");
            } else {
              notify(
                "You don't have access to that company. Your current workspace is open below.",
              );
            }
          }
          // Back/Forward can select another company while a request is in flight.
          if (requestedCompany !== viewRef.current.companyId) {
            refreshAgain.current = true;
            continue;
          }
          companyPending.current = false;
          const was = dataRef.current;
          // The page on screen is this company's, not a first load or a switch.
          const shown = was?.company.id === d.company.id;
          dataRef.current = d;
          setData(d);
          if (troubleRef.current) {
            clearTimeout(retryTimer.current);
            // The strip said something was wrong, so it says when that is
            // over. A company that opens after a failed start or switch
            // needs no words: it is on screen.
            if (
              troubleRef.current.inStrip &&
              was?.company.id === d.company.id
            ) {
              setBackOnline(true);
              clearTimeout(backTimer.current);
              backTimer.current = setTimeout(() => setBackOnline(false), 4000);
            }
            noteTrouble(null);
          }
          noteCompanies(d);
          setEventVersion((x) => x + 1);
          const resolved = resolveRoute(viewRef.current, d, { shown });
          showView(resolved.view, true);
          if (resolved.notice) notify(resolved.notice);
        } catch (e) {
          if (e.status === 401) {
            dataRef.current = null;
            companyPending.current = !!viewRef.current.companyId;
            setData(null);
            // Signed out is an answer, not a failure, so stop saying the
            // connection is broken and let the sign-in screen through.
            clearTimeout(retryTimer.current);
            noteTrouble(null);
            // Signed out here or in another tab: the companies go with them.
            forgetCompanies();
            if (!oldForm())
              window.location.replace(
                "/login#next=" +
                  encodeURIComponent(
                    window.location.pathname + window.location.search,
                  ),
              );
          } else {
            // Only 401 means signed out. Anything else — the server busy, a
            // dropped connection — used to leave the first load with nothing,
            // which shows the sign-in screen to somebody who is signed in, and
            // nothing ever tried again. Keep trying instead, and say so in
            // one place: the strip, or the page that opens the company. This
            // also raised a toast in the browser's own words on every failed
            // check, twelve seconds apart, over the message box.
            const t = noteFailure(troubleRef.current, e, Date.now());
            // Where it is said: in the strip over the open company, or on
            // the page that opens one.
            const open = dataRef.current?.company.id;
            const asked = viewRef.current.companyId;
            t.inStrip = !!open && (!asked || asked === open);
            // A switch to another company that failed. It can fail after the
            // server has already moved this browser's session there, and
            // every tab here would then ask for the company that does not
            // open: the one still on the old company said "TameDuck isn't
            // answering", and so did the front door. The session goes back,
            // so "Northgate is still open" is true everywhere.
            const switching = !!open && !t.inStrip;
            if (switching && !e.offline)
              await api("/companies/switch", "POST", { id: open }).catch(
                () => {},
              );
            noteTrouble(t);
            clearTimeout(retryTimer.current);
            // The card for a failed switch has Try again, and promises no
            // countdown: trying by itself would move the session to the
            // company that did not open, again and again, under every tab.
            if (!switching)
              retryTimer.current = setTimeout(
                () => refresh(),
                t.next - Date.now(),
              );
          }
        }
      } while (refreshAgain.current);
    };
    refreshRef.current = load();
    try {
      await refreshRef.current;
    } finally {
      refreshRef.current = null;
      setLoading(false);
    }
  }, [notify, showView]);
  const go = useCallback(
    (v, { replace = false, asked = false } = {}) => {
      // A page with typed work on it that is not saved asks before it goes.
      if (!asked && !mayLeave()) return;
      // Going to the chat that is already open - its row in the sidebar,
      // say - means "show me the latest".
      const was = viewRef.current;
      if (
        v.type === "chat" &&
        was.type === "chat" &&
        v.id === was.id &&
        !v.threadId &&
        !was.threadId &&
        !v.at
      )
        setLatest((n) => n + 1);
      // Each search pick is its own ask, even for the same message twice.
      if (v.type === "chat" && v.at) setSeek((n) => n + 1);
      const d = dataRef.current;
      let next = {
        ...v,
        companyId: v.companyId || d?.company.id || viewRef.current.companyId,
      };
      next = withFilesReturn(next, viewRef.current);
      next = withDesktopReturn(next, viewRef.current);
      const switchCompany =
        !!next.companyId && next.companyId !== d?.company.id;
      if (d && !switchCompany) {
        const resolved = resolveRoute(next, d);
        next = resolved.view;
        if (resolved.notice) notify(resolved.notice);
      }
      // A previous company switch may still finish after the user goes Back.
      companyPending.current = switchCompany || companyPending.current;
      showView(next, replace);
      setModal(null);
      setMobile(false);
      setCompanyMenu(false);
      if (companyPending.current) {
        setLoading(true);
        refresh();
      }
    },
    [notify, refresh, showView],
  );
  useEffect(() => {
    const restore = () => {
      // Back has already changed the address. Staying means putting back the
      // address of the page that is still on screen.
      if (!mayLeave())
        return window.history.pushState({}, "", routePath(viewRef.current));
      go(readRoute(window.location.pathname, window.location.search), {
        replace: true,
        asked: true,
      });
    };
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, [go]);
  useEffect(() => {
    refresh();
  }, []);
  useEffect(() => {
    if (!data) return;
    const source = new EventSource("/api/events");
    source.onmessage = (e) => {
      const event = JSON.parse(e.data);
      if (event.type === "refresh") {
        // A run reports progress every couple of hundred milliseconds while it
        // writes, which is faster than this wait, so the timer was pushed back
        // every time and never ran: the transcript stood still for the twelve
        // second poll, exactly while a duck was typing into it. Waiting is still
        // worth it to collect a burst, but never for longer than half a second.
        // Each of these reloads the whole workspace, and a writing duck reports
        // several times a second, so a floor of half a second had one open tab
        // asking for everything a hundred times a minute — enough on its own to
        // hit the server's own limit and be told to slow down. A second still
        // reads as live while a duck types.
        clearTimeout(reloadTimer.current);
        // While a check is failing, the next one is at the time the strip
        // says. Too busy is exactly when asking at every change is wrong.
        if (troubleRef.current) return;
        const run = () => {
          lastReload.current = Date.now();
          refresh();
        };
        if (Date.now() - lastReload.current > 1000) run();
        else reloadTimer.current = setTimeout(run, 400);
      }
    };
    // A browser reopens this by itself when the connection drops, but not when
    // the server answered with an error: then it closes for good and the page
    // goes quiet until someone reloads it. Reopening is what keeps it live.
    source.onerror = () => {
      if (source.readyState !== EventSource.CLOSED) return;
      clearTimeout(reopenTimer.current);
      reopenTimer.current = setTimeout(
        () => setLiveAttempt((n) => n + 1),
        5000,
      );
    };
    return () => {
      source.close();
      clearTimeout(reloadTimer.current);
      clearTimeout(reopenTimer.current);
    };
  }, [data?.company.id, refresh, liveAttempt]);
  // The check every twelve seconds keeps its own clock. It used to start over
  // each time the live connection was reopened, and once the session is gone
  // the server refuses that connection, so it is reopened every five seconds.
  // The check never came, and a page whose session ran out did not go to
  // sign-in until somebody pressed something.
  useEffect(() => {
    if (!data) return;
    // While a check is failing, the next one is at the time the strip says.
    const poll = setInterval(() => {
      if (!troubleRef.current) refresh();
    }, 12000);
    return () => clearInterval(poll);
  }, [data?.company.id, refresh]);
  // The browser knows first when the connection goes and when it comes back:
  // check at once rather than at the next turn of the clock.
  useEffect(() => {
    const offline = () => {
      if (dataRef.current && troubleRef.current?.kind !== "offline") refresh();
    };
    const online = () => {
      if (troubleRef.current) refresh();
    };
    window.addEventListener("offline", offline);
    window.addEventListener("online", online);
    return () => {
      window.removeEventListener("offline", offline);
      window.removeEventListener("online", online);
    };
  }, [refresh]);
  useEffect(() => {
    const key = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        // Not over an open dialog. Search replaced whatever was on screen, and
        // a dialog swapped out this way never runs its own close, so the
        // warning about unsaved work never fired and a half-written ticket went
        // with it. Close the dialog first - which asks, when it should.
        if (data && !anyDialogOpen()) setModal({ type: "search" });
      }
      // "?" opens Help, as long as it is not being typed into something.
      if (
        e.key === "?" &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        data &&
        !anyDialogOpen() &&
        !e.target.closest?.("input, textarea, select, [contenteditable]")
      ) {
        e.preventDefault();
        setMobile(false);
        setHelpOpen((current) => !current);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [!!data]);
  const action = async (fn, success) => {
    try {
      const result = await fn();
      // A message that can read the answer. Some of these only become true
      // once the server has replied - disconnecting a provider moves the
      // company default, and which model it moved to is not knowable here
      // until then.
      if (success)
        notify(typeof success === "function" ? success(result) : success);
      await refresh();
      return result;
    } catch (e) {
      notify(e.message);
      // Say it in the strip too, now rather than at the next check.
      if (e.offline && !troubleRef.current) refresh();
      return null;
    }
  };
  async function openDuck(duck) {
    const conv = await action(() =>
      api("/conversations/direct", "POST", { duck_id: duck.id }),
    );
    if (conv) go({ type: "chat", id: conv.id });
  }
  async function openPerson(person) {
    const conv = await action(() =>
      api("/conversations/direct", "POST", { user_id: person.id }),
    );
    if (conv) go({ type: "chat", id: conv.id });
  }
  const conversation = data?.conversations.find((c) => c.id === view.id);
  // The channel the Members dialog is about, as it is now. The dialog kept the
  // copy it opened with, so everybody added stayed under "Add", everybody
  // removed stayed listed, and every change looked as if it had failed.
  const inDialog =
    modal?.type === "participants"
      ? data?.conversations.find((c) => c.id === modal.conversation.id)
      : null;
  // Where the focus goes once a dialog has closed, when the dialog that had
  // it can no longer say: archiving from Members closes both.
  const refocus = useRef(null);
  useEffect(() => {
    if (modal) return;
    const to = refocus.current;
    refocus.current = null;
    if (to?.isConnected) to.focus();
  }, [modal]);
  const chief = data?.ducks.find((d) => d.chief);
  // The number on Needs you is the number of lines on it. Added up separately,
  // it could not count a ticket waiting for you, and could not leave out one a
  // ticket had already moved past.
  const pending = data
    ? (({ waiting, later }) => waiting.length + later.length)(
        inboxRows(data, waitingOnYou(data)),
      )
    : 0;
  const duckActivity = new Map(
    (data?.duck_activity || []).map((entry) => [entry.duck_id, entry]),
  );
  const title =
    view.type === "chat"
      ? conversationName(conversation, data)
      : {
          skills: skillsTitle || "Skills library",
          computers: "Computers",
          // The top bar said "Task board" over a page called "Scheduled
          // tasks". A schedule's own page is called what the schedule is.
          tasks: view.scheduled
            ? view.scheduleId === "new"
              ? "New scheduled task"
              : (view.scheduleId &&
                  data?.schedules?.find((s) => s.id === view.scheduleId)
                    ?.title) ||
                "Scheduled tasks"
            : data?.tasks.find((t) => t.id === view.id)?.title || "Task board",
          files: filesTitle(view, data),
          inbox: "Needs you",
          team: "Team",
          settings: "Settings",
        }[view.type];
  useEffect(() => {
    document.title = data
      ? `${title} · ${data.company.name} · TameDuck`
      : "TameDuck — Your team's home pond";
  }, [title, data?.company.name]);
  useEffect(() => {
    if (
      data &&
      !loading &&
      (!view.companyId || view.companyId === data.company.id)
    ) {
      window.tameduckAnalytics?.pageView(view, routePath(view));
      window.tameduckAnalytics?.signedIn();
    }
  }, [data?.company.id, loading, view]);
  // Opening a company, and in its place when it will not open: at the start,
  // or on the way to another company. Nothing loaded and the reason was not
  // "sign in" means the server is busy or unreachable, so it says that instead
  // of asking somebody who is already signed in to sign in again, and keeps
  // trying. Before anything has loaded, the company's name comes from the
  // last visit (src/known-companies.mjs). Also while a signed-out browser is
  // on its way to /login, so the old form never flashes up first.
  const switching =
    !!data && !!view.companyId && view.companyId !== data.company.id;
  if (loading || (trouble && (!data || switching)) || (!data && !oldForm())) {
    const known = knownCompanies();
    const target = data
      ? data.companies.find((c) => c.id === (view.companyId || data.company.id))
      : companyToOpen(known, view.companyId);
    return (
      <OpeningPage
        opening={loading}
        trouble={trouble}
        name={target?.name || null}
        current={switching ? data.company : null}
        other={data ? null : otherCompany(known, view.companyId)}
        onTry={refresh}
        onOther={(c) => {
          clearTimeout(retryTimer.current);
          noteTrouble(null);
          setLoading(true);
          companyPending.current = true;
          showView({ type: "chat", companyId: c.id });
          refresh();
        }}
        onBack={() => {
          clearTimeout(retryTimer.current);
          noteTrouble(null);
          // The switch stays pending, so if the session is still on the
          // company that did not open (putting it back was lost on the way),
          // the check that follows moves it (refresh(), above).
          go({ type: "chat", companyId: data.company.id }, { replace: true });
        }}
        onSignOut={async () => {
          // Signing out needs the server too. When it cannot, the page says
          // so and nothing is forgotten: going to the front door still
          // signed in would only open this page again.
          await api("/auth/logout", "POST", {});
          if (known.user) forgetDrafts(known.user);
          forgetCompanies();
          location.href = "/";
        }}
      />
    );
  }
  // Only /setup# comes this far signed out: see oldForm.
  if (!data)
    return (
      <>
        <Auth
          notify={notify}
          onSuccess={(r) => {
            if (r.recoveryKey) setRecovery(r.recoveryKey);
            refresh();
          }}
        />
        {toast && <Toast>{toast}</Toast>}
        {recovery && (
          <Recovery value={recovery} onClose={() => setRecovery(null)} />
        )}
      </>
    );
  // A company nobody has set up yet, opened by the person who started it.
  // Everything behind this screen was guessed from an email address, and no
  // duck can answer until an AI is connected, so there is nothing back there
  // worth letting them past to. Anybody else - somebody invited to a company
  // that already exists, or any company already set up - goes straight in.
  //
  // One page is let through. Every email we send ends with a link to the email
  // settings, that link carries no company because a person's inbox is theirs
  // rather than a company's, and it therefore opens against whichever company
  // the session is on. Starting a second company switches the session to it, so
  // an owner who did that would press "Choose which emails you get" and be
  // shown "First, the basics" for a company they were not thinking about - and
  // the only way out of that screen is to finish setting the company up. A
  // person trying to stop us writing to them must never be made to answer
  // questions first; that is how a person stops pressing the link and starts
  // pressing spam. The settings themselves are per person, so the page is
  // correct to show here.
  const stoppingOurEmails = view.type === "settings" && view.tab === "emails";
  if (!data.company.onboarded_at && data.role === "owner" && !stoppingOurEmails)
    return (
      <div className="status-frame">
        <StatusStrip
          trouble={trouble}
          backOnline={backOnline}
          update={
            appUpdateAvailable(loadedAppEntry, data.app_entry)
              ? data.app_entry
              : null
          }
          onTry={refresh}
        />
        <Onboarding
          data={data}
          action={action}
          refresh={refresh}
          // Set up, the workspace opens on the chat with Chief Duck, not on
          // the address the setting up happened at: coming back from paying
          // is Settings → Billing, and finishing left people on their trial.
          onFinished={async () => {
            await refresh();
            go({ type: "chat" }, { replace: true, asked: true });
          }}
        />
      </div>
    );
  // The plan at the foot of the menu opens Billing, so it is a button only for
  // somebody who may open Billing. For anybody else, pressing it ended at "You
  // don't have access to that settings page", so for them it is a line to read.
  const community = isCommunityEdition(data);
  const Plan = !community && mayOpen("billing", data) ? "button" : "div";
  const line = planLine(data.billing);
  // Adding a duck to a full flock opens what the plan allows instead of the
  // editor, which could only be refused.
  const flockAtLimit =
    !!data.billing?.enabled &&
    ["trialing", "active", "past_due"].includes(data.billing.status) &&
    flock(data).length >= data.billing.duck_limit;
  // A company paused by billing opens on the page that says so and how to
  // start it; anybody may look around first, and the strip stays.
  const gate =
    !!data.billing?.blocked &&
    view.type === "chat" &&
    lookedAround !== data.company.id;
  // The mark goes to the chat everybody lands on, and from there, clicked
  // again, to the website's home page. "/" is the workspace for anybody signed
  // in, so the website waits at /home; an app-only build has none.
  const toWebsite =
    data.distribution?.edition !== "community" &&
    view.type === "chat" &&
    !view.threadId &&
    !view.at &&
    view.id === resolveRoute({ type: "chat" }, data).view.id;
  return (
    <div className="app">
      <header className="global-bar">
        <a
          className="global-brand"
          href={
            toWebsite
              ? "/home"
              : routePath({ companyId: data.company.id, type: "chat" })
          }
          onClick={(e) => {
            // The website is a page of its own: the link goes there itself.
            if (toWebsite) return;
            if (!e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) {
              e.preventDefault();
              go({ type: "chat" });
            }
          }}
          aria-label={toWebsite ? "TameDuck website" : "TameDuck home"}
        >
          <BrandMark onDark /> TameDuck
        </a>
        <button
          className="global-search"
          onClick={() => setModal({ type: "search" })}
        >
          <Search size={17} />
          <span>Search {data.company.name}</span>
          <kbd>⌘ K</kbd>
        </button>
        <div className="global-status">
          <IconButton
            icon={Palette}
            label="Change theme"
            onClick={() => go({ type: "settings", tab: "appearance" })}
          />
          <span className="global-tagline">Let's get things done.</span>
          {/* Help lives up here, at the right of every screen, above the
              panel it opens. It used to sit at the bottom of the sidebar,
              under Settings, where nobody looked for it. */}
          <button
            className="help-top-button"
            ref={helpButtonRef}
            type="button"
            aria-expanded={helpOpen}
            aria-controls="help-drawer-panel"
            title="Help (?)"
            onClick={() => {
              setMobile(false);
              setHelpOpen((current) => !current);
            }}
          >
            <CircleHelp size={16} aria-hidden="true" />
            <span>Help</span>
          </button>
        </div>
      </header>
      {mobile && (
        <div className="mobile-scrim" onClick={() => setMobile(false)} />
      )}
      <aside className={"sidebar " + (mobile ? "mobile-open" : "")}>
        <div className="workspace-switch">
          <button onClick={() => setCompanyMenu(!companyMenu)}>
            <CompanyTile company={data.company} className="workspace-initial" />
            <span>
              {data.company.name}
              <small>Your workspace</small>
            </span>
            <ChevronDown size={16} />
          </button>
          {companyMenu && (
            <div className="workspace-dropdown">
              {data.companies.map((c) => (
                <button
                  key={c.id}
                  onClick={() => go({ type: "chat", companyId: c.id })}
                >
                  <CompanyTile
                    company={c}
                    className="workspace-dropdown-tile"
                  />
                  {c.name}
                  {c.id === data.company.id && <Check size={15} />}
                </button>
              ))}
              <button
                onClick={() => {
                  setModal({ type: "company" });
                  setCompanyMenu(false);
                }}
              >
                <Plus size={16} /> New company
              </button>
            </div>
          )}
        </div>
        <nav className="main-nav">
          <Nav
            icon={Inbox}
            label="Needs you"
            count={pending}
            active={view.type === "inbox"}
            onClick={() => go({ type: "inbox" })}
          />
          <Nav
            icon={Users}
            label="Team"
            active={view.type === "team"}
            onClick={() => go({ type: "team" })}
          />
          <Nav
            icon={Columns3}
            label="Task board"
            active={view.type === "tasks"}
            onClick={() => go({ type: "tasks" })}
          />
          <Nav
            icon={Files}
            label="Files"
            active={view.type === "files"}
            onClick={() => go({ type: "files" })}
          />
          {data.permissions.computers && (
            <Nav
              icon={Monitor}
              label="Computers"
              active={view.type === "computers"}
              onClick={() => go({ type: "computers" })}
            />
          )}
          <Nav
            icon={BookOpen}
            label="Skills library"
            active={view.type === "skills"}
            onClick={() => go({ type: "skills" })}
          />
        </nav>
        <div className="sidebar-scroll">
          <div className="section-heading">
            <span>
              Direct messages{" "}
              <small>
                {flock(data).length +
                  data.conversations.filter((c) => c.kind === "human").length}
              </small>
            </span>
            {data.permissions.chat && (
              <IconButton
                icon={Plus}
                label="New direct message"
                onClick={() => setModal({ type: "direct-message" })}
              />
            )}
          </div>
          <nav>
            {flock(data).map((d) => {
              const direct = data.conversations.find(
                (c) => c.kind === "direct" && c.ducks.includes(d.id),
              );
              return (
                <button
                  className={
                    "duck-nav " +
                    (view.type === "chat" &&
                    conversation?.kind === "direct" &&
                    conversation.ducks.includes(d.id)
                      ? "active"
                      : "")
                  }
                  key={d.id}
                  onClick={() => openDuck(d)}
                >
                  <Avatar duck={d} size={30} />
                  <span>
                    <span className="duck-nav-who">
                      <span className="duck-nav-name">{d.name}</span>
                      {/* The badge says "Chief" because the row is narrow,
                          but "Chief" on its own is not the job. A title is a
                          tooltip and is only sometimes read out, so the name a
                          screen reader is given says the whole thing. */}
                      {!!d.chief && (
                        <span
                          className="duck-nav-chief"
                          aria-label="Chief of staff"
                          title="Chief of staff"
                        >
                          Chief
                        </span>
                      )}
                    </span>
                    <RowSignal
                      signal={duckRowSignal(
                        duckActivity.get(d.id)?.items,
                        direct?.unread || 0,
                      )}
                    />
                  </span>
                </button>
              );
            })}
          </nav>
          <nav aria-label="Human direct messages">
            {data.conversations
              .filter((c) => c.kind === "human")
              .map((c) => (
                <button
                  key={c.id}
                  className={
                    "duck-nav " +
                    (view.type === "chat" && view.id === c.id ? "active" : "")
                  }
                  onClick={() => go({ type: "chat", id: c.id })}
                >
                  <Avatar name={conversationName(c, data)} size={30} />
                  <span>
                    <span className="duck-nav-who">
                      <span className="duck-nav-name">
                        {conversationName(c, data)}
                      </span>
                    </span>
                  </span>
                  {c.unread > 0 && (
                    <span className="row-new">{c.unread} new</span>
                  )}
                </button>
              ))}
          </nav>
          {data.permissions.chat && (
            <button
              className="add-sidebar"
              onClick={() => setModal({ type: "direct-message" })}
            >
              <span>
                <MessageSquare size={15} />
              </span>
              Message a teammate
            </button>
          )}
          {data.permissions.ducks && (
            <button
              className="add-sidebar"
              onClick={() => setModal({ type: "duck" })}
            >
              <span>
                <Plus size={15} />
              </span>
              Add a duck
            </button>
          )}
          <div className="section-heading">
            <span>
              Channels{" "}
              <small>
                {
                  data.conversations.filter(
                    (c) => c.kind === "group" && !c.archived,
                  ).length
                }
              </small>
            </span>
            {data.permissions.chat && (
              <IconButton
                icon={Plus}
                label="Create a group chat"
                onClick={() => setModal({ type: "group" })}
              />
            )}
          </div>
          <nav>
            {data.conversations
              .filter((c) => c.kind === "group" && !c.archived)
              .map((c) => (
                <div className="channel-nav-row" key={c.id}>
                  <button
                    className={
                      "group-nav " +
                      (view.type === "chat" && view.id === c.id ? "active" : "")
                    }
                    onClick={() => go({ type: "chat", id: c.id })}
                  >
                    <Hash size={17} />
                    <span>{c.name}</span>
                    {c.unread > 0 && (
                      <span className="row-new">{c.unread} new</span>
                    )}
                  </button>
                </div>
              ))}
          </nav>
          {!data.conversations.some(
            (c) => c.kind === "group" && !c.archived,
          ) && (
            <p className="sidebar-note">
              Bring ducks and people into a shared conversation.
            </p>
          )}
          {data.permissions.chat && (
            <button
              className="add-sidebar"
              onClick={() => setModal({ type: "group" })}
            >
              <span>
                <Plus size={15} />
              </span>
              Add channel
            </button>
          )}
          {/* Archived channels is a place like the channels above it, so it
              is the last row of this list. Pinned under the list, it covered
              the channel above it with nothing to say the list went on. */}
          <button
            className="archived-nav"
            onClick={() => setModal({ type: "archived" })}
          >
            <Archive size={16} />
            <span>Archived channels</span>
            <span className="archived-count">
              {
                data.conversations.filter(
                  (c) => c.kind === "group" && c.archived,
                ).length
              }
            </span>
          </button>
        </div>
        <div className="sidebar-footer">
          {!community && (
            <Plan
              className="plan-mini"
              onClick={
                Plan === "button"
                  ? () => go({ type: "settings", tab: "billing" })
                  : undefined
              }
            >
              <CreditCard size={18} />
              <span>
                {line.title}
                <small className={line.attention ? "attention" : undefined}>
                  {line.sub}
                </small>
              </span>
            </Plan>
          )}
          {/* You and your settings are one row here. The rail used to keep a
              second door to the same place in a column of its own, and its
              square opened your account, which is what your own name and
              face still open. On a phone this row stays put while the rest
              of the drawer scrolls. */}
          <div className="you-row">
            <button
              className={
                "you-nav " + (view.type === "settings" ? "active" : "")
              }
              aria-current={view.type === "settings" ? "page" : undefined}
              onClick={() => go({ type: "settings", tab: "account" })}
            >
              <Avatar name={data.user.name} size={30} />
              <span>
                <span className="you-nav-name">{data.user.name}</span>
                <small>Settings</small>
              </span>
              <SettingsIcon size={18} />
            </button>
          </div>
        </div>
      </aside>
      <main className="main" key={data.company.id}>
        <StatusStrip
          trouble={trouble}
          backOnline={backOnline}
          update={
            appUpdateAvailable(loadedAppEntry, data.app_entry)
              ? data.app_entry
              : null
          }
          onTry={refresh}
        />
        {!community && !gate && (
          <BillingStrip data={data} go={go} action={action} />
        )}
        {gate ? (
          <>
            <header className="topbar">
              <div className="topbar-title">
                <span className="mobile-menu">
                  <IconButton
                    icon={Menu}
                    label="Open sidebar"
                    onClick={() => setMobile(!mobile)}
                  />
                </span>
                <div>
                  <h1 tabIndex={-1}>
                    {data.billing.status === "held"
                      ? `${data.company.name} is on hold`
                      : data.billing.status === "canceled"
                        ? `${data.company.name}’s plan has ended`
                        : `${data.company.name} is paused`}
                  </h1>
                </div>
              </div>
            </header>
            <BillingGate
              data={data}
              go={go}
              action={action}
              onLookAround={() => setLookedAround(data.company.id)}
            />
          </>
        ) : (
        <>
        <header
          className={
            "topbar" +
            (view.type === "tasks" && view.id ? " ticket-page-topbar" : "") +
            (view.type === "tasks" && view.scheduled ? " topbar-crumbed" : "")
          }
        >
          <div className="topbar-title">
            <span className="mobile-menu">
              <IconButton
                icon={Menu}
                label="Open sidebar"
                onClick={() => setMobile(!mobile)}
              />
            </span>
            <span className="topbar-slot" ref={setTopbarLead} />
            {view.type === "chat" && conversation?.kind === "group" ? (
              <Hash size={23} />
            ) : view.type === "chat" ? (
              <Avatar
                name={
                  conversation?.kind === "human"
                    ? conversationName(conversation, data)
                    : undefined
                }
                duck={data.ducks.find((d) =>
                  conversation?.ducks.includes(d.id),
                )}
                size={34}
              />
            ) : null}
            <div>
              {view.type === "tasks" && view.id ? (
                <strong>Task boards</strong>
              ) : view.type === "tasks" && view.scheduled ? (
                // One step back up, then where you are.
                <div
                  className={
                    "topbar-crumbs" + (view.scheduleId ? " one-schedule" : "")
                  }
                >
                  <a
                    className="topbar-crumb"
                    href={routePath(
                      view.scheduleId
                        ? {
                            type: "tasks",
                            scheduled: true,
                            companyId: view.companyId,
                          }
                        : { type: "tasks", companyId: view.companyId },
                    )}
                    onClick={(e) => {
                      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button)
                        return;
                      e.preventDefault();
                      go(
                        view.scheduleId
                          ? { type: "tasks", scheduled: true }
                          : { type: "tasks" },
                      );
                    }}
                  >
                    <ChevronLeft size={16} aria-hidden="true" />
                    {view.scheduleId ? "Scheduled tasks" : "Task board"}
                  </a>
                  <h1>{title}</h1>
                </div>
              ) : (
                // Where the focus goes after leaving a channel, so that it
                // says where you have landed.
                <h1 tabIndex={-1}>{title}</h1>
              )}
              {view.type === "chat" && (
                <span className="topbar-sub">
                  {conversation?.kind === "group"
                    ? // "ducks" was hard-coded while "human" beside it was
                      // pluralised properly, so a channel with one duck read
                      // "1 ducks". And it counted conversation.ducks, which
                      // deliberately keeps a duck that has been taken off the
                      // team so it can be put back - so the header counted
                      // ducks the members dialog and the composer below it did
                      // not show. People first and called people, as the
                      // Members dialog it opens says.
                      `${conversation.members.length} ${conversation.members.length === 1 ? "person" : "people"} · ${flock(data).filter((d) => conversation.ducks.includes(d.id)).length} ${
                        flock(data).filter((d) =>
                          conversation.ducks.includes(d.id),
                        ).length === 1
                          ? "duck"
                          : "ducks"
                      }`
                    : conversation?.kind === "human"
                      ? "Private conversation"
                      : data.ducks.find((d) =>
                          conversation?.ducks.includes(d.id),
                        )?.role}
                </span>
              )}
            </div>
          </div>
          <div className="topbar-actions">
            {!!data.company.paused && (
              <span className="pill warning">Flock paused</span>
            )}
            {view.type === "chat" && conversation?.kind === "direct" && (
              <Button
                className="secondary small"
                aria-label="Duck profile"
                onClick={() =>
                  setModal({
                    type: "duck",
                    duck: data.ducks.find((d) =>
                      conversation.ducks.includes(d.id),
                    ),
                  })
                }
              >
                <PanelRight size={16} />
                <span>Duck profile</span>
              </Button>
            )}
            {view.type === "chat" && conversation?.kind === "group" && (
              <Button
                className="secondary small"
                onClick={() => setModal({ type: "participants", conversation })}
              >
                <Users size={16} />
                Members
              </Button>
            )}
            {/* The company's computer settings, beside the page's name. Named
                for the phone, where only the icon shows. */}
            {view.type === "computers" &&
              !view.control &&
              data.permissions.company && (
                <Button
                  className="secondary small"
                  aria-label="Controls"
                  onClick={() => go({ type: "computers", id: "controls" })}
                >
                  <Settings2 size={16} />
                  <span>Controls</span>
                </Button>
              )}
            <span className="topbar-slot" ref={setTopbarActions} />
          </div>
        </header>
        <HumanInputNotice data={data} go={go} />
        {view.type === "chat" && conversation && (
          <Chat
            key={conversation.id}
            conversation={conversation}
            threadId={view.threadId}
            at={view.at}
            seek={seek}
            data={data}
            eventVersion={eventVersion}
            action={action}
            notify={notify}
            go={go}
            setModal={setModal}
            latest={latest}
          />
        )}
        {view.type === "computers" && (
          <Computers
            control={view.control}
            requestId={view.requestId}
            checkpointToken={view.checkpointToken}
            returnTo={view.returnTo}
            take={view.take}
            data={data}
            action={action}
            notify={notify}
            initialId={view.id}
            go={go}
          />
        )}
        {view.type === "skills" && (
          <Skills
            data={data}
            action={action}
            notify={notify}
            initialId={view.id}
            catalogId={view.catalogId}
            topic={view.topic}
            go={go}
            onTitle={setSkillsTitle}
          />
        )}
        {view.type === "tasks" && view.scheduled && !view.scheduleId && (
          <Schedules data={data} go={go} />
        )}
        {view.type === "tasks" && view.scheduled && view.scheduleId && (
          <SchedulePage
            data={data}
            action={action}
            go={go}
            notify={notify}
            scheduleId={view.scheduleId}
          />
        )}
        {view.type === "tasks" && (view.setup || view.newBoard) && (
          <BoardSetup
            key={view.newBoard ? "new" : view.boardId}
            data={data}
            action={action}
            go={go}
            boardId={view.newBoard ? null : view.boardId}
            stepId={view.stepId}
          />
        )}
        {view.type === "tasks" &&
          !view.scheduled &&
          !view.setup &&
          !view.newBoard && (
            <WorkflowBoards
              data={data}
              action={action}
              go={go}
              initialId={view.id}
              boardId={view.boardId}
              folderId={view.folderId}
            />
          )}
        {view.type === "files" && (
          <FilesView
            data={data}
            action={action}
            notify={notify}
            view={view}
            go={go}
            setModal={setModal}
            eventVersion={eventVersion}
            topbar={{ lead: topbarLead, actions: topbarActions }}
          />
        )}
        {view.type === "inbox" && (
          <InboxView data={data} action={action} go={go} />
        )}
        {view.type === "team" && (
          <TeamView
            data={data}
            action={action}
            setModal={setModal}
            openDuck={openDuck}
            openPerson={openPerson}
            go={go}
            notify={notify}
            tab={view.tab}
            focusDuckId={view.duckId}
          />
        )}
        {view.type === "settings" && (
          <Settings
            key={data.company.id + ":" + (view.tab || "ai")}
            data={data}
            action={action}
            notify={notify}
            initialTab={view.tab || "ai"}
            focusConnectionId={view.connectionId}
            onTabChange={(tab) => go({ type: "settings", tab })}
            refresh={refresh}
          />
        )}
        </>
        )}
      </main>
      <HelpDrawer
        open={helpOpen}
        onClose={() => setHelpOpen(false)}
        triggerRef={helpButtonRef}
        view={view}
      />
      {modal?.type === "duck" && !modal.duck && flockAtLimit && (
        <DuckLimitDialog data={data} onClose={() => setModal(null)} go={go} />
      )}
      {modal?.type === "duck" && (modal.duck || !flockAtLimit) && (
        <DuckEditor
          duck={modal.duck}
          data={data}
          action={action}
          onClose={() => setModal(null)}
          onCreated={(d) => {
            setModal(null);
            openDuck(d);
          }}
        />
      )}
      {modal?.type === "direct-message" && (
        <DirectMessagePicker
          data={data}
          action={action}
          onClose={() => setModal(null)}
          onCreated={(c) => go({ type: "chat", id: c.id })}
        />
      )}
      {modal?.type === "group" && (
        <GroupEditor
          data={data}
          action={action}
          onClose={() => setModal(null)}
          onCreated={(c) => {
            setModal(null);
            go({ type: "chat", id: c.id });
          }}
        />
      )}
      {modal?.type === "search" && (
        <SearchView
          data={data}
          onClose={() => setModal(null)}
          go={go}
          openDuck={openDuck}
          openPerson={openPerson}
          action={action}
          here={view}
        />
      )}
      {modal?.type === "archive-channel" && (
        <ArchiveChannelDialog
          channel={modal.channel}
          action={action}
          onClose={() => {
            // Once archived, both dialogs have gone: the focus goes back to
            // what opened Members, not to the page.
            refocus.current = modal.back?.opener;
            setModal(null);
          }}
          // Archive is asked from Members, so changing your mind goes back
          // there rather than out of both.
          onCancel={modal.back ? () => setModal(modal.back) : undefined}
        />
      )}
      {modal?.type === "archived" && (
        <ArchivedChannelsDialog
          data={data}
          action={action}
          onClose={() => setModal(null)}
          go={go}
        />
      )}
      {modal?.type === "company" && (
        <NewCompany
          data={data}
          action={action}
          onClose={() => setModal(null)}
          go={go}
        />
      )}
      {modal?.type === "participants" && inDialog && (
        <ChannelMembers
          data={data}
          channel={inDialog}
          action={action}
          go={go}
          focus={modal.focus}
          opener={modal.opener}
          onClose={() => setModal(null)}
          onArchive={(opener) =>
            setModal({
              type: "archive-channel",
              channel: inDialog,
              back: {
                type: "participants",
                conversation: inDialog,
                focus: "archive",
                opener,
              },
            })
          }
        />
      )}
      {recovery && (
        <Recovery value={recovery} onClose={() => setRecovery(null)} />
      )}
      {toast && (
        <Toast>
          {toast}
          <button
            aria-label="Dismiss notification"
            onClick={() => setToast("")}
          >
            <X size={15} />
          </button>
        </Toast>
      )}
    </div>
  );
}
// What a row says is happening, under the name. A chip for something waiting
// on you, a dot for work under way, and plain words for the rest - all of it
// from duckRowSignal(), which is where the Team card's words come from too.
function RowSignal({ signal }) {
  if (!signal) return null;
  return (
    <span className="row-signal">
      {signal.kind === "attention" ? (
        <span className="row-signal-say">{signal.lead}</span>
      ) : (
        <span className="row-signal-lead">
          {signal.kind === "working" && (
            <i className="row-signal-dot" aria-hidden="true" />
          )}
          <b>{signal.lead}</b>
        </span>
      )}
      {!!signal.about && (
        <span className="row-signal-about">{signal.about}</span>
      )}
      {signal.unread > 0 && (
        <span className="row-new">{signal.unread} new</span>
      )}
    </span>
  );
}
function Nav({ icon: Icon, label, count, active, onClick }) {
  return (
    <button
      className={"nav-item " + (active ? "active" : "")}
      aria-current={active ? "page" : undefined}
      onClick={onClick}
    >
      <Icon size={18} />
      <span>{label}</span>
      {count > 0 && <b className="count">{count}</b>}
    </button>
  );
}
function Recovery({ value, onClose }) {
  return (
    <Modal title="Save your recovery key" onClose={() => {}}>
      <p>
        {/* There is no reset by email anywhere in this product: this key and the
            account's address are the only way back in. Saying "you can use it"
            made that sound like one option among several, and people clicked
            past it and were locked out of their own company for good. */}
        If you forget your password, this key is the only way back into your
        account. Nobody can email you a new one, and it is not shown again. Save
        it in your password manager now.
      </p>
      <div className="secret-display">{value}</div>
      <CopyButton value={value} label="Copy recovery key" />
      <div className="modal-actions">
        <Button onClick={onClose}>
          I saved my key <Check size={16} />
        </Button>
      </div>
    </Modal>
  );
}
// The first account on a new server, made at /setup# with the setup code.
function Auth({ notify, onSuccess }) {
  const [busy, setBusy] = useState(false);
  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    try {
      const a = Object.fromEntries(new FormData(e.currentTarget));
      const result = await api("/auth/setup", "POST", {
        ...a,
        token: startToken,
      });
      onSuccess(result);
    } catch (e) {
      notify(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="auth-page">
      <div className="auth-nav">
        <div className="brand">
          <span className="brand-mark">
            <BrandMark onYellow />
          </span>
          TameDuck
        </div>
      </div>
      <div className="auth-grid">
        <section className="auth-story">
          <span className="eyebrow">BIG IDEAS. MEET YOUR TEAM.</span>
          <h1>
            Big ideas.
            <br />
            Bright minds.
            <br />
            <span>Let’s go.</span>
          </h1>
          <p>
            Your chief of staff, specialist ducks, and human teammates. All
            together, turning conversations into work that gets done.
          </p>
          <div className="auth-team">
            <span>🦆</span>
            <span>🦉</span>
            <span>🎨</span>
            <span>👋</span>
            <p>
              Built around your company.
              <br />
              <strong>Ready to work alongside you.</strong>
            </p>
          </div>
          <div className="auth-bottom">
            <span>
              <Check size={16} /> Your own AI subscription
            </span>
            <span>
              <Check size={16} /> Your company’s context
            </span>
          </div>
        </section>
        <section className="auth-card">
          <div className="auth-icon">
            <BrandMark />
          </div>
          <h2>Make yourself at home.</h2>
          <p>Create your account and your first company.</p>
          <form onSubmit={submit}>
            <Field label="Your name">
              <input
                name="name"
                autoComplete="name"
                required
                maxLength={100}
                placeholder="Alex Morgan"
              />
            </Field>
            <Field label="Email address">
              <input
                name="email"
                type="email"
                autoComplete="username"
                required
                placeholder="you@company.com"
              />
            </Field>
            <Field label="Company name">
              <input
                name="company"
                required
                placeholder="Your company"
                maxLength={100}
              />
            </Field>
            <Field label="Password" hint="At least 12 characters.">
              <input
                name="password"
                type="password"
                minLength={12}
                maxLength={200}
                autoComplete="new-password"
                required
                placeholder="Make it a strong one"
              />
            </Field>
            <Button busy={busy} className="full">
              Create your workspace <ArrowRight size={17} />
            </Button>
          </form>
          <div className="auth-security">
            <ShieldCheck size={15} /> A private home for your team and its work.
          </div>
        </section>
      </div>
      <footer className="auth-footer">
        TameDuck <span>Your team. In full flight.</span>
      </footer>
    </div>
  );
}
function ArrowUpRightIcon() {
  return <ExternalLink size={14} />;
}
function NewCompany({ data, action, onClose, go }) {
  const [busy, setBusy] = useState(false);
  // Where new companies pay, the dialog says what this one will cost before
  // it is made: the trial is once per person, so a second company pays from
  // the start.
  const billed =
    !isCommunityEdition(data) &&
    !!data.billing?.enabled &&
    data.billing.mode !== "off";
  const trial = billed && !data.billing.trial_used;
  const cost = newCompanyCost({
    billed,
    trial,
    community: isCommunityEdition(data),
  });
  return (
    <Modal title="A new company, a new flock" warnUnsaved onClose={onClose}>
      <p>
        Each company has its own ducks, documents, and rules
        {cost.lead}.
      </p>
      {cost.title && (
        <div className="billing-pro" style={{ marginBottom: 18 }}>
          <div>
            <strong>{cost.title}</strong>
            <span>{cost.detail}</span>
          </div>
        </div>
      )}
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          const r = await action(() =>
            api("/companies", "POST", {
              name: new FormData(e.currentTarget).get("name"),
            }),
          );
          setBusy(false);
          if (r) {
            onClose();
            go({ type: "chat", id: null });
          }
        }}
      >
        <Field label="Company name">
          <input name="name" required maxLength={100} autoFocus />
        </Field>
        {cost.next && <p className="billing-notice">{cost.next}</p>}
        <div className="modal-actions">
          <Button busy={busy}>
            {billed ? "Continue" : "Create company"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
