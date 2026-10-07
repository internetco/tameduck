import { assertComputerAllowance } from "./computer-limits.mjs";
import { deploymentDrainRequested } from "./deployment-drain.mjs";
import {
  prepareNativeDesktop,
  registerNativeDesktopStream,
  closeNativeDesktop,
} from "./native-desktop.mjs";
import {
  openComputerSocket,
  registerComputerRelay,
} from "./computer-relay.mjs";
import {
  requestForComputer,
  requestFor,
  reserveRequest,
  checkpointToken,
  finishRequest,
  visibleRequestJob,
} from "./human-input-store.mjs";
import {
  authorizeRequest,
  assertRequestIdentity,
  openRequestedDesktop,
} from "./human-input.mjs";
import { WebSocketServer } from "ws";
import { z } from "zod";
import {
  one,
  run,
  id,
  now,
  hash,
  tenant,
  fail,
  memberFor,
  permissions,
  audit,
  emit,
  json,
} from "./store.mjs";
import { controlFor } from "./computer-control-store.mjs";
import { effectiveHumanWaitMinutes } from "./human-wait-settings.mjs";
import { computerInternals as C, ensureComputer } from "./computers.mjs";
import { computerEvent } from "./computer-events.mjs";
let activeHumanControlActions = 0;
export const activeHumanControlActionCount = () => activeHumanControlActions;
const trackHumanAction = (handler) => async (req, res) => {
  if (deploymentDrainRequested())
    fail(
      503,
      "TameDuck is being updated. Please try again shortly.",
    );
  activeHumanControlActions++;
  try {
    await handler(req, res);
  } finally {
    activeHumanControlActions--;
  }
};
const streams = new Map(),
  connections = new Map();
const quote = (s) => "'" + s.replaceAll("'", "'\\''") + "'";
const leaseMs = 90000;
// A backstop so a wedged tab that keeps heartbeating cannot hold a computer forever.
export const maxSessionMs = 8 * 60 * 60 * 1000;
// How long a take waits for the provider to finish preparing the native desktop.
export const nativeReadyMs = 45000;
// How long a take waits for a stopped or archived machine to come back up.
export const machineReadyMs = 90000;
// What preparing a takeover costs before anybody can touch anything: waking the
// machine, issuing the desktop, and the provider round trips either side of
// both. Nothing here is time the person spends; it is time they are waiting.
export const prepareBudgetMs = machineReadyMs + nativeReadyMs + 105000;
// Taking over can mean waiting more than two minutes for an archived machine to
// come back, and the answer only arrives when it is all over. Say which step is
// running so the person is not left watching a motionless screen wondering
// whether it is working. Each step emits, so it reaches the page over its event
// stream while the request it is waiting on is still open.
function progress(cid, generation, phase) {
  const hold = one(
    "SELECT company_id,phase FROM computer_control WHERE computer_id=? AND generation=?",
    cid,
    generation,
  );
  // The waiting loop calls this every couple of seconds. Only a real change is
  // worth waking every open page in the company for.
  if (!hold || hold.phase === phase) return;
  run(
    "UPDATE computer_control SET phase=? WHERE computer_id=? AND generation=?",
    phase,
    cid,
    generation,
  );
  emit(hold.company_id);
}
export function closeControl(cid) {
  run(
    "UPDATE computer_control SET state='releasing',expires=0 WHERE computer_id=?",
    cid,
  );
  closeStreams(cid);
  connections.delete(cid);
}
function closeStreams(cid) {
  closeNativeDesktop(cid);
  for (const close of streams.get(cid) || []) close();
  streams.delete(cid);
}
export function checkControl(
  cid,
  company,
  user,
  session,
  { expired = false, generation, anySession = false } = {},
) {
  const c = tenant("computers", cid, company);
  // Not the start preflight: nothing here starts a machine. Everything that
  // comes through this is somebody already on a screen - their heartbeat, their
  // paste, and the button that hands the screen back. A teammate unticking this
  // duck in Controls, or turning computers off for the company, used to refuse
  // all three with "Enable computer access for this duck in Computers first" -
  // a setting the person on the dead screen may not even be allowed to reach.
  // Hand back failing is the worst of it: the hold survives, every run of that
  // duck stays blocked behind "A human is using your computer", and when the
  // wait finally runs out the record says they walked away. The request path
  // next door passes start:false for exactly this reason.
  C.authorize(company, user, c.duck_id, { start: false });
  const h = controlFor(cid);
  if (
    !h ||
    h.user_id !== user ||
    (!anySession && h.session_hash !== session)
  )
    fail(409, "This computer is not under your control. Choose Take control.");
  if (generation !== undefined && h.generation !== generation)
    fail(409, "This desktop tab is out of date. Reopen the current request.");
  if (!expired && (h.expires <= Date.now() || h.state !== "live"))
    fail(409, "Your desktop connection has paused. Reconnect to continue.");
  return { c, h };
}
export function validStream(cid, session, generation) {
  const s = one(
    "SELECT * FROM sessions WHERE token_hash=? AND expires>?",
    session,
    Date.now(),
  );
  if (!s) return false;
  const h = controlFor(cid),
    c = C.row(cid),
    m = memberFor(s.company_id, s.user_id),
    r = requestForComputer(cid);
  return !!(
    h &&
    c &&
    h.generation === generation &&
    h.session_hash === session &&
    h.user_id === s.user_id &&
    h.company_id === s.company_id &&
    h.expires > Date.now() &&
    h.state === "live" &&
    (!r ||
      (() => {
        const b = json(r.binding);
        return (
          r.status === "desktop" &&
          r.control_generation === generation &&
          r.expires > Date.now() &&
          b?.box_id === c.box_id &&
          b?.started_at === c.started_at &&
          (!r.job_id ||
            one(
              "SELECT 1 FROM jobs WHERE id=? AND status='waiting_human'",
              r.job_id,
            ))
        );
      })()) &&
    C.readyStates.includes(c.state) &&
    m &&
    permissions(m).computers &&
    one(
      "SELECT enabled FROM computer_settings WHERE company_id=?",
      s.company_id,
    )?.enabled !== 0 &&
    !one("SELECT paused FROM companies WHERE id=?", s.company_id)?.paused &&
    one("SELECT enabled FROM duck_computer_access WHERE duck_id=?", c.duck_id)
      ?.enabled !== 0
  );
}
async function prepareDesktop(c) {
  const unit =
    "[Unit]\nDescription=TameDuck human desktop\n[Service]\nExecStart=/usr/bin/x11vnc -display :0 -auth %h/.Xauthority -localhost -rfbport 5901 -forever -shared -nopw -noxdamage -quiet\nRestart=on-failure\nRestartSec=1\n";
  await C.command(
    c,
    `command -v x11vnc >/dev/null || (sudo -n apt-get update -qq && sudo -n DEBIAN_FRONTEND=noninteractive apt-get install -y -qq x11vnc)
mkdir -p "$HOME/.config/systemd/user"
printf %s ${quote(unit)} > "$HOME/.config/systemd/user/tameduck-human.service"
export XDG_RUNTIME_DIR="/run/user/$(id -u)"
export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"
systemctl --user daemon-reload
systemctl --user restart tameduck-human.service
python3 -c 'import socket,time; time.sleep(1); s=socket.create_connection(("127.0.0.1",5901),5); assert s.recv(12).startswith(b"RFB "); s.close()'`,
    60,
  );
  return { computer_id: c.id, box_id: c.box_id, started_at: c.started_at };
}
async function retireFailedTakeover(request, c, user, e) {
  const reason = e.status
    ? e.message
    : "The desktop could not be prepared. Please try again.";
  run(
    "UPDATE human_requests SET status='expired',outcome=?,updated=? WHERE id=? AND status IN ('preparing','pending','desktop')",
    "Could not open the screen. " + reason,
    now(),
    request.id,
  );
  // A failed preparation must not leave an invisible reservation blocking queued chat work.
  const { parkHumanRequest } = await import("./human-input-parking.mjs");
  try {
    await parkHumanRequest(requestFor(request.id));
  } catch {
    // Keep the hold while the parking worker retries cleanup, but preserve the failure receipt.
    console.error("Takeover cleanup pending", { request_id: request.id });
  }
  if (requestFor(request.id)?.status === "parked")
    C.update(c.id, { error: reason });
  audit(c.company_id, user, "Computer takeover preparation failed", {
    request_id: request.id,
  });
  emit(c.company_id);
  e.status ||= 502;
  e.publicMessage = reason;
  e.request_id = request.id;
}
export function registerComputerControl(
  app,
  {
    pauseDuckJobs,
    prepare = prepareDesktop,
    prepareNative = prepareNativeDesktop,
    ensure = ensureComputer,
    openRequest = openRequestedDesktop,
    machineReady = machineReadyMs,
    withoutAI = async () => null,
  },
) {
  const takeHandler = async (req, res) => {
    const native = req.body?.transport === "native";
    const cid = req.params.id,
      c = tenant("computers", cid, req.company.id);
    C.authorize(c.company_id, req.user.id, c.duck_id);
    // Taking a screen that is already up is not a start and must keep working
    // at the wall, whatever the allowance says. Taking one that has to be woken
    // is a start, and is refused here rather than later - after this point a
    // take pauses the duck, spends its human request and writes the refusal
    // into the computer's own error line.
    //
    // Two ways the row lies about whether this is a start. A machine stopped
    // seconds ago still says "archiving", which is a window that opens on
    // every single stop. And a machine whose time ran out is archived at the
    // provider before the janitor comes round, so for a few seconds the row
    // still says ready. Ask the provider rather than believe the row; if
    // asking fails, go with what we have, because refusing somebody's takeover
    // over a broken status check is worse than letting one through.
    let seen = c;
    if (c.box_id)
      try {
        seen = (await C.sync(cid)) || c;
      } catch {
        seen = c;
      }
    if (
      !seen.box_id ||
      seen.state === "archived" ||
      seen.state === "archiving"
    ) {
      // No AI first: it is the more basic reason, and somebody told they are
      // out of computer time when nothing could have worked anyway fixes the
      // wrong thing. Like the allowance, only a take that has to wake the
      // machine is refused - a screen that is up, including one a duck is
      // holding open for this person, can always be taken.
      const why = await withoutAI(req);
      if (why) fail(409, why);
      assertComputerAllowance(c.company_id, { computerId: c.id });
    }
    const old = controlFor(cid);
    // A different person, not a different browser. Holding the screen was tied
    // to the exact session cookie, so taking it on a laptop and then opening
    // the same computer on a phone refused you under your own name: the phone
    // said you had the screen and to wait for you to hand it back, offered no
    // way to take it or to hand it back, and could not even show a still,
    // because nothing is photographed while somebody holds a screen. Moving
    // from one device to another is an ordinary thing to do, and it replaces
    // your own hold - the old tab finds out the way it already does when a
    // screen is taken from under it.
    if (
      old &&
      old.user_id !== req.user.id &&
      (old.expires > Date.now() ||
        !["owner", "admin"].includes(req.member.role))
    )
      fail(
        409,
        "Another person has control of this computer. Wait for them to hand it back.",
      );
    if (old?.state === "preparing" && old.expires > Date.now())
      fail(409, "The desktop is still preparing.");
    // An abandoned screen. The check above deliberately lets an owner or admin
    // take a hold that has run out - somebody shut their laptop with the screen
    // held - but taking a screen also files a request in that person's name,
    // and the lookup below refuses everybody except them. So the allowance
    // could never once fire: the owner was sent to open "the current request",
    // and that request would never be theirs. A hold only runs out after ninety
    // seconds with no heartbeat, and the page keeps beating through blips for
    // seventy of them, so this is somebody who has genuinely gone. Close what
    // they left behind and this becomes an ordinary first takeover.
    //
    // Completed rather than cancelled, deliberately: cancelling a request stops
    // the duck's run outright (server/human-input-store.mjs), and nobody's work
    // should be thrown away because a colleague shut a laptop.
    const abandoned =
      old &&
      old.user_id !== req.user.id &&
      old.expires <= Date.now() &&
      ["owner", "admin"].includes(req.member.role)
        ? requestForComputer(cid)
        : null;
    if (
      abandoned &&
      abandoned.kind === "takeover" &&
      abandoned.user_id === old.user_id
    ) {
      finishRequest(
        abandoned,
        "completed",
        "The person who took this screen did not come back, and somebody who can manage this company took it over. Inspect fresh state and keep any changes they made.",
      );
      audit(c.company_id, req.user.id, "Took back an abandoned screen", {
        duck: c.duck_id,
        from: old.user_id,
      });
    }
    let request = requestForComputer(cid);
    const initialTakeover = !request;
    if (request) {
      if (req.body?.request_id !== request.id)
        fail(409, "Open the current request for this task.");
      request = authorizeRequest(req, request.id);
      if (
        !["pending", "desktop"].includes(request.status) ||
        request.expires <= Date.now()
      )
        fail(
          409,
          "This request expired or changed. Ask your duck to retry it.",
        );
      if (old && req.body?.generation !== old.generation)
        fail(409, "This desktop tab is out of date.");
      try {
        if (request.kind === "form") assertRequestIdentity(request, c);
        if (request.kind === "takeover") {
          const binding = json(request.binding);
          if (!binding?.box_id || !binding?.started_at)
            fail(
              409,
              "This takeover changed before the desktop was secured. Review the current task and take control again.",
            );
          assertRequestIdentity(request, c);
        }
      } catch (e) {
        await retireFailedTakeover(request, c, req.user.id, e);
        throw e;
      }
    } else {
      if (req.body?.request_id)
        fail(
          409,
          "This screen request is closed. Review the current task and open a new screen request.",
        );
      if (req.body?.checkpoint_token !== checkpointToken(c))
        fail(
          409,
          "The duck moved on since this screen was opened. Refresh and check the current task before taking control.",
        );
      // Only bind the request to the run's conversation when this person is in
      // it. The request is filed under them, and every later action on it is
      // checked against that conversation, so binding someone to a chat they are
      // not in produced a screen they could take but never hand back: release,
      // cancel and retry all answered "You are not a member of this
      // conversation", and the card was invisible to everyone.
      const job = one(
        "SELECT * FROM jobs WHERE duck_id=? AND company_id=? AND status='running' ORDER BY created LIMIT 1",
        c.duck_id,
        c.company_id,
      );
      // The chat the request will actually be shown in, which is not always
      // the run's own: a duck helping another duck works in a consultation
      // nobody is in, and its requests are shown in the chat of the duck that
      // asked for help. Checking the helper's empty conversation found nobody
      // ever in it, and the request was moved to the asker's chat anyway - so
      // anyone outside that chat took a helper's screen and could not give it
      // back.
      const shownIn = visibleRequestJob(job)?.conversation_id;
      const inJobConversation =
        shownIn &&
        one(
          "SELECT 1 FROM conversation_members WHERE conversation_id=? AND user_id=?",
          shownIn,
          req.user.id,
        );
      const source =
        !job &&
        one(
          "SELECT j.conversation_id,j.output_message_id FROM computer_actions a JOIN jobs j ON j.id=a.job_id JOIN conversation_members cm ON cm.conversation_id=j.conversation_id AND cm.user_id=? WHERE a.id=(SELECT id FROM computer_actions WHERE computer_id=? ORDER BY rowid DESC LIMIT 1) AND j.company_id=? AND j.duck_id=?",
          req.user.id,
          cid,
          c.company_id,
          c.duck_id,
        );
      request = reserveRequest(
        c,
        // The run is still the one being paused and resumed, so its id stays.
        // Only the conversation it belongs to is dropped, and only for someone
        // who is not in that conversation.
        job && !inJobConversation
          ? { ...job, conversation_id: null, output_message_id: null }
          : job,
        req.user.id,
        {
          conversation_id: source?.conversation_id,
          message_id: source?.output_message_id,
          kind: "takeover",
          // A person pressed Take control. Nobody asked them to, so the card
          // this titles must not read as a request from the duck.
          title: "You have this computer",
          checkpoint: c.checkpoint,
        },
      );
      // reserveRequest files a helper's request under the asker's chat
      // whatever it is given; for somebody outside that chat it belongs to no
      // chat at all.
      if (job && !inJobConversation) {
        run(
          "UPDATE human_requests SET conversation_id=NULL,message_id=NULL WHERE id=?",
          request.id,
        );
        request = requestFor(request.id);
      }
    }
    closeStreams(cid);
    connections.delete(cid);
    const generation = id();
    run(
      "INSERT INTO computer_control(computer_id,company_id,user_id,session_hash,expires,started,generation,state) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(computer_id) DO UPDATE SET user_id=excluded.user_id,session_hash=excluded.session_hash,expires=excluded.expires,started=excluded.started,generation=excluded.generation,state=excluded.state",
      cid,
      c.company_id,
      req.user.id,
      req.session.token_hash,
      // As long as preparing is allowed to take. Three minutes, against a
      // budget of four, let the cleanup that gives back abandoned screens close
      // a takeover that was still waking the machine, and stop it underneath.
      Date.now() + prepareBudgetMs,
      Date.now(),
      generation,
      "preparing",
    );
    emit(c.company_id);
    const current = () => {
      const r = requestFor(request.id);
      if (
        controlFor(cid)?.generation !== generation ||
        !r ||
        !["preparing", "pending", "desktop"].includes(r.status) ||
        r.expires <= Date.now()
      )
        fail(409, "This handoff expired or was replaced.");
      return r;
    };
    try {
      // Give preparing its own clock. The deadline for all of the waiting above
      // was the person's own "Wait for you" setting, and this product offers
      // that at one minute - so the shortest setting handed the takeover sixty
      // seconds to do over two minutes of unavoidable waiting, and "Take
      // control" simply could not wake a stopped computer. It failed at exactly
      // the moment the machine was coming back, and wrote the failure onto the
      // card of a computer that was by then ready. That setting is about how
      // long a duck waits for a person, so it starts when the screen is
      // actually theirs, further down.
      const readyBy = Date.now() + prepareBudgetMs;
      if ((requestFor(request.id)?.expires || 0) < readyBy)
        run(
          "UPDATE human_requests SET expires=?,updated=? WHERE id=?",
          readyBy,
          now(),
          request.id,
        );
      progress(cid, generation, "pausing");
      await pauseDuckJobs(c.duck_id, c.company_id);
      await C.lock("computer:" + cid, async () => {});
      current();
      const drained = C.row(cid);
      if (drained.box_id !== c.box_id || drained.started_at !== c.started_at)
        fail(
          409,
          "The computer changed while pausing this task. Review it before taking control.",
        );
      // A form is never restored into a new desktop process. Its original live page must survive.
      if (request.kind === "takeover" && initialTakeover)
        await ensure(
          c.company_id,
          req.user.id,
          c.duck_id,
          "Human taking control",
          current,
          { desktopOnly: native },
        );
      if (!native && !initialTakeover && !C.row(cid).bootstrapped)
        fail(
          409,
          "The bound desktop changed or stopped. Review the current task and take control again.",
        );
      // A native takeover still needs the machine itself running; only the duck's
      // automation is skipped. Restoring a stopped or archived computer outlasts a
      // single ensure() pass, and without this wait the takeover failed on arrival
      // and retired its own request, so the person had to start the whole handoff
      // again against a computer that was by then almost ready.
      const ready = () =>
        native
          ? C.readyStates.includes(C.row(cid).state)
          : C.row(cid).bootstrapped;
      const readyUntil = Date.now() + machineReady;
      while (!ready() && Date.now() < readyUntil) {
        current();
        // Waking an archived machine is the slowest step by far, so name what it
        // is doing rather than leaving the page silent for a minute or more.
        progress(
          cid,
          generation,
          C.readyStates.includes(C.row(cid).state) ? "desktop" : "waking",
        );
        await new Promise((r) => setTimeout(r, 2000));
        await ensure(
          c.company_id,
          req.user.id,
          c.duck_id,
          "Preparing human desktop",
          current,
          { desktopOnly: native },
        );
      }
      progress(cid, generation, "desktop");
      // The guest setup is what stops a Mac's Command key reaching the desktop
      // as Super, where Cmd+D means "show desktop" and hides everything the
      // person was working on. A native takeover needs none of the duck's
      // automation and so never asked for that setup: the one case where a
      // human is doing the typing was the one case that could go without it.
      // It returns at once when the machine is already set up, and a failure
      // here must not cost somebody their takeover.
      try {
        await C.bootstrap(cid);
      } catch {}
      const result = await C.lock("computer:" + cid, async () => {
        current();
        const latest = C.row(cid);
        if (
          !C.readyStates.includes(latest.state) ||
          (!native && !latest.bootstrapped)
        )
          fail(
            409,
            "The desktop is still starting. Reconnect in a few seconds.",
          );
        // Establish the viewer before thawing its bound browser page. Issuing
        // a native desktop can prepare a fresh capture surface; if the page was
        // thawed first, Chrome had already spent its repaint while no viewer was
        // ready and the person's first frame could keep a white content area.
        const result = native
          ? await prepareNative(latest, generation, {
              guard: current,
              deadline: Math.min(
                Date.now() + nativeReadyMs,
                requestFor(request.id)?.expires || 0,
              ),
            })
          : await prepare(latest);
        current();
        const prepared = C.row(cid);
        if (
          prepared.box_id !== latest.box_id ||
          prepared.started_at !== latest.started_at ||
          !C.readyStates.includes(prepared.state)
        )
          fail(
            409,
            "The desktop changed during preparation. Review the current task.",
          );
        if (!initialTakeover)
          assertRequestIdentity(requestFor(request.id), C.row(cid));
        if (request.kind === "form") await openRequest(current(), prepared);
        current();
        const binding =
          request.kind === "form"
            ? json(request.binding)
            : { box_id: latest.box_id, started_at: latest.started_at };
        run(
          "UPDATE human_requests SET binding=?,checkpoint=?,status='desktop',control_generation=?,updated=? WHERE id=?",
          JSON.stringify(binding),
          request.checkpoint,
          generation,
          now(),
          request.id,
        );
        // The screen is theirs from here, so their wait starts here.
        run(
          "UPDATE human_requests SET expires=?,updated=? WHERE id=?",
          Date.now() +
            effectiveHumanWaitMinutes(req.user.id, c.duck_id) * 60000,
          now(),
          request.id,
        );
        return result;
      });
      current();
      connections.set(cid, result);
      run(
        "UPDATE computer_control SET state='live',phase=NULL,expires=? WHERE computer_id=? AND generation=?",
        Math.min(
          Date.now() + leaseMs,
          requestFor(request.id)?.expires || Date.now() + leaseMs,
        ),
        cid,
        generation,
      );
      await C.touch(cid);
      C.update(cid, { error: null });
      audit(c.company_id, req.user.id, "Human took control of computer", {
        duck: c.duck_id,
        request_id: request.id,
      });
      // Only when the screen changes hands. The screen page takes it again
      // each time its stream reloads, and each of those read as another take.
      if (old?.user_id !== req.user.id)
        computerEvent(c, "took", { user: req.user.id });
      emit(c.company_id);
      res.set("Cache-Control", "no-store").json({
        ok: true,
        request_id: request.id,
        generation,
        ...(native
          ? { viewer_url: result.viewer_url, transport: "native" }
          : {}),
      });
    } catch (e) {
      closeNativeDesktop(cid, generation);
      run(
        "UPDATE computer_control SET state='paused',expires=0 WHERE computer_id=? AND generation=?",
        cid,
        generation,
      );
      await retireFailedTakeover(request, c, req.user.id, e);
      throw e;
    }
  };
  app.post("/api/computers/:id/control/take", trackHumanAction(takeHandler));
  const checked = (req, expired = false, anySession = false) => {
    if (!req.body?.generation)
      fail(409, "Reopen the current desktop before continuing.");
    return checkControl(
      req.params.id,
      req.company.id,
      req.user.id,
      req.session.token_hash,
      { expired, generation: req.body.generation, anySession },
    );
  };
  // The native viewer carries keystrokes but not the clipboard. Keep paste
  // contents off logs and receipts, and deliver UTF-8 through the guest's
  // clipboard so non-ASCII text is not silently truncated by XSendEvent.
  const typeHandler = async (req, res) => {
    const { c } = checked(req);
    const text = z.string().min(1).max(4000).parse(req.body?.text);
    // Taking the screen skips the duck's automation, so the controls that type
    // on the machine are usually not running yet. Start them on the first paste
    // rather than failing with nothing to show for it.
    await C.bootstrap(c.id);
    checked(req);
    // Where the text goes is the person's own click. The desktop scope delivers
    // to whatever holds the keyboard on the screen, which is the box they just
    // clicked, and that is the whole of it.
    //
    const typed = await C.driver(
      c.id,
      "paste_text",
      { text, scope: "desktop" },
      "Typed by the person holding the screen",
      { retry: false },
    );
    // The machine reports a refusal inside the answer rather than by failing, so
    // replying "ok" without reading it told someone their password had gone in
    // when nothing had been typed at all. What it says is the driver's own
    // wording may contain application data, so never log it.
    if (typed?.isError) {
      console.error("Paste refused on computer", c.id);
      fail(
        502,
        "The desktop did not take the text. Click the box you want it in, then paste again.",
      );
    }
    await C.touch(c.id);
    audit(c.company_id, req.user.id, "Human typed into computer", {
      duck: c.duck_id,
      characters: text.length,
    });
    res.json({ ok: true });
  };
  app.post("/api/computers/:id/control/type", trackHumanAction(typeHandler));
  app.post("/api/computers/:id/control/heartbeat", async (req, res) => {
    const { c, h } = checked(req);
    let r = requestForComputer(c.id);
    if (r) {
      assertRequestIdentity(r, c);
      if (r.expires <= Date.now()) fail(409, "This request expired.");
      // The wait setting is how long we hold the computer waiting for a person,
      // not a cap on the work they came to do. While they are actually connected
      // it rolls forward, so an active desktop is never cut mid-task; once the
      // heartbeats stop it runs out exactly as before and the computer frees up.
      const renewed =
        Date.now() + effectiveHumanWaitMinutes(r.user_id, c.duck_id) * 60000;
      if (r.status === "desktop" && r.control_generation === h.generation) {
        run(
          "UPDATE human_requests SET expires=?,updated=? WHERE id=? AND status='desktop' AND expires<? AND created>?",
          renewed,
          now(),
          r.id,
          renewed,
          new Date(Date.now() - maxSessionMs).toISOString(),
        );
        r = requestFor(r.id);
      }
    }
    run(
      "UPDATE computer_control SET expires=? WHERE computer_id=? AND generation=?",
      Math.min(Date.now() + leaseMs, r?.expires || Infinity),
      c.id,
      h.generation,
    );
    await C.touch(c.id);
    res.json({ ok: true });
  });
  const releaseHandler = async (req, res) => {
    // Your own screen, from any of your own devices. Take already allows a
    // phone to replace the laptop's hold, and the page shows Hand back on
    // both; release refused every browser but the one that took it, with
    // "Choose Take control" on a page that had no Take control to choose.
    const { c, h } = checked(req, true, true);
    const request = requestForComputer(c.id);
    if (request) {
      authorizeRequest(req, request.id);
      if (
        request.control_generation !== h.generation ||
        request.status !== "desktop" ||
        request.expires <= Date.now()
      )
        fail(
          409,
          "This request expired or changed. Ask your duck to recheck the checkpoint.",
        );
      assertRequestIdentity(request, c);
    }
    const native = connections.get(c.id)?.transport === "native";
    closeControl(c.id);
    await C.lock("computer:" + c.id, async () => {
      // Closing an old request must never delete a newer control lease.
      if (controlFor(c.id)?.generation !== h.generation)
        fail(409, "This handoff was replaced.");
      if (!native && C.readyStates.includes(c.state))
        await C.command(
          c,
          'export XDG_RUNTIME_DIR="/run/user/$(id -u)"; export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"; systemctl --user stop tameduck-human.service',
          10,
        ).catch(() => {});
      if (controlFor(c.id)?.generation !== h.generation)
        fail(409, "This handoff was replaced.");
      run(
        "DELETE FROM computer_control WHERE computer_id=? AND generation=?",
        c.id,
        h.generation,
      );
      if (request)
        finishRequest(
          request,
          "completed",
          "The human finished on the original desktop. Inspect fresh state and preserve their changes.",
        );
    });
    audit(c.company_id, req.user.id, "Human handed computer back to duck", {
      duck: c.duck_id,
      request_id: request?.id,
    });
    computerEvent(c, "gave_back", { user: req.user.id });
    emit(c.company_id);
    res.json({ ok: true });
  };
  app.post("/api/computers/:id/control/release", trackHumanAction(releaseHandler));
}
export function registerComputerStream(server, appUrl) {
  registerComputerRelay(server);
  registerNativeDesktopStream(server, { validStream, appUrl });
  // A restart drops every connection, so every hold is paused until its page
  // reconnects. It used to be paused with expires=0, and the janitor's first
  // round a second later read that as somebody who had walked away: it closed
  // their takeover and gave the screen to the duck before the page could come
  // back. With deploys several times a day, that took the screen from whoever
  // was on it every time. They get the same grace as any dropped connection.
  run("UPDATE computer_control SET state='paused',expires=?", Date.now() + leaseMs);
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 128 * 1024,
    perMessageDeflate: false,
  });
  server.on("upgrade", (req, socket, head) => {
    if (
      req.url?.startsWith("/api/computer-relay/") ||
      /^\/api\/computers\/[^/]+\/control\/native\//.test(req.url || "")
    )
      return;
    const match =
      /^\/api\/computers\/([0-9a-f-]{36})\/control\/stream\?generation=([0-9a-f-]{36})$/.exec(
        req.url || "",
      );
    const reject = () => {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    };
    if (!match || req.headers.origin !== new URL(appUrl).origin)
      return reject();
    const cookie = (req.headers.cookie || "")
      .split(";")
      .map((s) => s.trim())
      .find((s) => s.startsWith("td_session="));
    const session = hash(cookie?.slice(11) || ""),
      cid = match[1],
      h = controlFor(cid),
      config = connections.get(cid);
    if (
      !config ||
      !h ||
      h.generation !== match[2] ||
      !validStream(cid, session, match[2])
    )
      return reject();
    const generation = h.generation;
    wss.handleUpgrade(req, socket, head, async (ws) => {
      ws.on("error", () => {});
      let tunnel;
      try {
        tunnel = await openComputerSocket(C.row(cid), 5901);
      } catch {
        ws.close(1011, "Desktop connection failed");
        return;
      }
      if (ws.readyState !== 1 || !validStream(cid, session, generation)) {
        tunnel.destroy();
        ws.terminate();
        return;
      }
      let closed = false,
        live = true,
        tunnelPaused = false;
      const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(timer);
        tunnel.destroy();
        ws.terminate();
        streams.get(cid)?.delete(close);
      };
      // Same trade as the native transport: revalidate on the timer that already
      // bounded revocation, not on every frame of desktop video.
      const timer = setInterval(() => {
        live = validStream(cid, session, generation);
        if (!live) close();
      }, 1000);
      timer.unref();
      if (!streams.has(cid)) streams.set(cid, new Set());
      streams.get(cid).add(close);
      tunnel.on("error", close);
      tunnel.on("close", close);
      ws.on("error", close);
      ws.on("close", close);
      tunnel.on("data", (data) => {
        if (!live) return close();
        if (ws.bufferedAmount > 64 * 1024 * 1024) return close();
        ws.send(data, { binary: true }, (err) => {
          if (err) return close();
          if (tunnelPaused && ws.bufferedAmount <= 2 * 1024 * 1024) {
            tunnelPaused = false;
            tunnel.resume();
          }
        });
        if (!tunnelPaused && ws.bufferedAmount > 8 * 1024 * 1024) {
          tunnelPaused = true;
          tunnel.pause();
        }
      });
      ws.on("message", (data, binary) => {
        if (!binary || !live) return close();
        if (!tunnel.write(data)) ws.pause();
      });
      tunnel.on("drain", () => ws.resume());
    });
  });
  return wss;
}
