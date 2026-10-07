import { computerContentItems, computerOutcome } from "./computer-result.mjs";
import { COMPUTER_IDLE_SECONDS } from "../shared/computer-policy.mjs";
import { generateCursorTrajectory } from "./cursor-trajectory.mjs";
import {
  observeDeliveredImage,
  cursorInputFrameRefusal,
} from "./cursor-input-frame.mjs";
import {
  nativeFocusTargeted,
  markNativeFocusRefused,
  clearNativeFocusGuard,
  nativeFocusGuardMessage,
} from "./computer-focus-guard.mjs";
import {
  attachCursorTrajectory,
  requiresCursorTrajectory,
} from "./cursor-trajectory-bridge.mjs";
import { duckDesktopSchema, duckDesktopInput } from "./computer-input.mjs";
import {
  assertComputerAllowance,
  computerAllowance,
} from "./computer-limits.mjs";
import { reconcileComputerUsage } from "./computer-usage.mjs";
import {
  enableComputerProxy,
  disableComputerProxy,
  finishJobComputerProxy,
  reconcileComputerProxy,
  computerProxyStatus,
  proxyCompanySummary,
  proxyComputerSummary,
  readProxyConfig,
  duckProxyAllowed,
} from "./computer-proxy.mjs";
import { transferComputerFile } from "./computer-file-import.mjs";
import { readComputerFile } from "./computer-file-export.mjs";
import { scanComputerOutputTree } from "./computer-file-export.mjs";
import { mutateComputerOutputFolder } from "./computer-output-folders.mjs";
import {
  boundTabForNativeAddress,
  normalizedPageAddress,
  waitForBrowserObservation,
} from "./browser-navigation.mjs";
import {
  requestForComputer,
  checkpointToken,
  finishRequest,
} from "./human-input-store.mjs";
import { runStreaming } from "./terminal-stream.mjs";
import {
  computerEvent,
  computerHistory,
  lastEvent,
  placeOf,
  STOP_KINDS,
} from "./computer-events.mjs";
import {
  controlFor,
  computerHeld,
  assertDuckControl,
} from "./computer-control-store.mjs";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { attachArtifact } from "./artifacts.mjs";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { fillSecrets, mentionsSecret } from "./duck-secrets.mjs";
import { DUCK_LIMIT } from "./store.mjs";
import { companyPlan } from "./company-limits.mjs";
import { consultationVisibleJob } from "./duck-consultations.mjs";
import {
  effectiveHumanWaitMinutes,
  MAX_HUMAN_WAIT_MINUTES,
} from "./human-wait-settings.mjs";
import { forgetTerminalOutput } from "./terminal-stream.mjs";
import {
  DATA,
  db,
  id,
  now,
  one,
  all,
  run,
  tenant,
  conversationFor,
  can,
  memberFor,
  permissions,
  encrypt,
  decrypt,
  fail,
  audit,
  emit,
  json,
} from "./store.mjs";
const BASE = "https://boat.dev/api/v1";
const providerSchemas = JSON.parse(
  fs.readFileSync(
    new URL("./guest/tool-schemas.json", import.meta.url),
    "utf8",
  ),
);
const nativeClickSchema = providerSchemas.find((s) => s.name === "click");
// Browser reads, navigation, preparation and page-owned dialogs remain
// available. Page mutation must use the native desktop controls so a refused
// background route cannot end a run without a real input attempt.
const filteredBrowserMutations = new Set([
  "browser_click",
  "browser_type",
  "browser_pointer",
]);
const schemas = providerSchemas
  .filter((s) => !filteredBrowserMutations.has(s.name))
  .map((s) => duckDesktopSchema(s, nativeClickSchema));
const schemaMap = new Map(schemas.map((s) => [s.name, s]));
// While its run is active, do not publish the old desktop frame as evidence
// of a pending page. New runs inspect the current desktop independently.
const pendingNavigation = new Map();
// A page opened through exact native window input must keep using that window
// for screenshots, even when another app occupies the desktop foreground.
const pageWindow = new Map();
const nativeInputTools = new Set([
  "click",
  "double_click",
  "right_click",
  "drag",
  "type_text",
  "press_key",
  "hotkey",
  "scroll",
  "move_cursor",
  "set_value",
]);
const nativeFeedbackTarget = (input) => {
  const target =
    input.target && typeof input.target === "object" ? input.target : null;
  const desktop = input.scope === "desktop" || target?.kind === "desktop";
  const window =
    input.scope === "window" ||
    target?.kind === "window" ||
    input.pid !== undefined ||
    input.window_id !== undefined;
  if (desktop && window) return null;
  if (!window) return { kind: "desktop" };
  const pid = input.pid ?? target?.pid;
  const window_id = input.window_id ?? target?.window_id;
  if (
    !Number.isSafeInteger(pid) ||
    pid <= 0 ||
    !Number.isSafeInteger(window_id) ||
    window_id <= 0 ||
    (input.pid !== undefined &&
      target?.pid !== undefined &&
      input.pid !== target.pid) ||
    (input.window_id !== undefined &&
      target?.window_id !== undefined &&
      input.window_id !== target.window_id)
  )
    return null;
  return { kind: "window", pid, window_id };
};
const addressBarIntent = new Map();
const isAddressHotkey = (tool, input) =>
  tool === "hotkey" &&
  Array.isArray(input.keys) &&
  input.keys.length === 2 &&
  input.keys.some((key) => String(key).toLowerCase() === "ctrl") &&
  input.keys.some((key) => String(key).toLowerCase() === "l");
const isEnter = (tool, input) =>
  tool === "press_key" &&
  ["enter", "return"].includes(String(input.key || "").toLowerCase());
const isPageUrl = (value) => {
  try {
    if (
      typeof value !== "string" ||
      !value ||
      value.length > 4000 ||
      /[\u0000-\u001f]/.test(value) ||
      /^https?:\/\/[^/?#]*@/i.test(value)
    )
      return null;
    const url = new URL(value);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      !url.hostname ||
      url.username ||
      url.password
    )
      return null;
    return normalizedPageAddress(value);
  } catch {
    return null;
  }
};
const pendingPage = (navigation) => ({
  requested_url: navigation.input.url,
  observed_url: navigation.observedUrl || null,
  navigation_sent: navigation.navigationSent === true,
});
const safeObservationToken = (value) =>
  typeof value === "string" && /^[a-z][a-z0-9_]{0,79}$/.test(value)
    ? value
    : null;
function openPageObservationFeedback(observed, input) {
  const state = observed.snapshot?.structuredContent || {};
  const refusal =
    state.refusal && typeof state.refusal === "object" ? state.refusal : {};
  const code = safeObservationToken(refusal.code || state.code);
  const reason = safeObservationToken(refusal.detail?.reason);
  const status = safeObservationToken(state.status);
  const pendingReason =
    observed.status === "observed"
      ? "window_capture_unavailable"
      : safeObservationToken(observed.reason) || "unavailable";
  const prepare =
    ["browser_requires_setup", "browser_consent_required"].includes(code) &&
    Number.isSafeInteger(input.pid) &&
    Number.isSafeInteger(input.window_id);
  const nextStep = prepare
    ? {
        tool: "browser_prepare",
        arguments: {
          pid: input.pid,
          window_id: input.window_id,
          strategy: { kind: "existing_profile" },
          ...(input.session ? { session: input.session } : {}),
        },
      }
    : null;
  const detail = [status, code, reason].filter(Boolean).join("; ");
  return {
    state: {
      navigation_pending_reason: pendingReason,
      ...(status ? { browser_read_status: status } : {}),
      ...(code ? { browser_read_code: code } : {}),
      ...(reason ? { browser_read_reason: reason } : {}),
      ...(nextStep ? { next_supported_step: nextStep } : {}),
    },
    text: nextStep
      ? ` Browser read requires preparation (${detail}). Use browser_prepare with pid ${input.pid}, window_id ${input.window_id}, and strategy.kind=existing_profile; the runtime will enforce permission.`
      : ` Browser observation is pending (${[pendingReason, detail].filter(Boolean).join("; ")}).`,
  };
}
async function observeNavigation(cid, navigation, guard) {
  // A manual address-bar sequence has no native readback. Keep its page
  // uncertain until a later verified opening replaces the pending attempt.
  if (navigation.kind === "legacy")
    return { status: "pending", reason: "unverified_address" };
  if (navigation.kind === "native" && !navigation.input.target_id) {
    if (
      !navigation.navigationSent ||
      !Number.isSafeInteger(navigation.input.pid) ||
      !Number.isSafeInteger(navigation.input.window_id)
    )
      return { status: "pending", reason: "not_sent" };
    guard();
    let addressRead;
    try {
      addressRead = await driver(cid, "read_page_address", {
        pid: navigation.input.pid,
        window_id: navigation.input.window_id,
        session: navigation.input.session,
      });
    } catch {
      guard();
      return { status: "pending", reason: "address_unavailable" };
    }
    guard();
    const addressState = addressRead?.structuredContent || {};
    if (
      addressRead?.isError ||
      addressState.status !== "ok" ||
      (addressState.effect && addressState.effect !== "confirmed") ||
      !isPageUrl(addressState.observed_url)
    )
      return { status: "pending", reason: "address_unavailable" };
    navigation.observedUrl = isPageUrl(addressState.observed_url);
    let binding;
    try {
      binding = await driver(cid, "get_browser_state", {
        pid: navigation.input.pid,
        window_id: navigation.input.window_id,
        session: navigation.input.session,
      });
    } catch {
      guard();
      return { status: "pending", reason: "unavailable" };
    }
    guard();
    const tab = boundTabForNativeAddress(binding, navigation.observedUrl);
    if (!tab)
      return { status: "pending", reason: "unavailable", snapshot: binding };
    navigation.input = { ...navigation.input, ...tab };
  }
  return waitForBrowserObservation({
    arguments: navigation.input,
    baseline: navigation.baseline,
    guard,
    read: async (input) => {
      try {
        return await driver(cid, "get_browser_state", input);
      } catch {
        guard();
        return { isError: true, structuredContent: { status: "error" } };
      }
    },
  });
}
const activeStates = [
  "provisioning",
  "provisioned",
  "cloning",
  "ready",
  "idle",
  "running",
  "archiving",
  "resuming",
];
const readyStates = ["ready", "idle", "running"];
// How long one computer start waits for the guest desktop to finish coming up.
// What a desktop that never came up says. The machine itself is fine and its
// terminal works, so this is not "the computer failed"; it is one half of it.
export const desktopDidNotStart =
  "The desktop did not finish starting, so there is no screen to work on. The terminal still works. Stop this computer and start it again to try the desktop once more.";
const desktopReadyMs = +process.env.DESKTOP_READY_MS || 90000,
  desktopPollMs = +process.env.DESKTOP_POLL_MS || 3000,
  // Creating and resuming a provider machine is a cold-boot operation. Real
  // starts commonly answer after 60-70 seconds, so the ordinary 35-second API
  // timeout reports a failure even though that same machine is still starting.
  // Keep status and action requests tightly bounded; only boot requests get
  // enough time to return their authoritative, idempotent result.
  startRequestMs = +process.env.COMPUTER_START_REQUEST_MS || 90000;
// Computers a single company may have running at once: the plan's, 10 on
// Company and 30 on Pro. The provider allows far more; this is a backstop
// against a runaway loop of starts, since every running machine bills per
// second.
const maxRunningPerCompany = (company) =>
  companyPlan(company).plan.runningAtOnce;
const idleMs = COMPUTER_IDLE_SECONDS * 1000,
  // Provider expiry must leave the whole idle window, plus time for cleanup.
  ttl = COMPUTER_IDLE_SECONDS + 5 * 60,
  renewBeforeMs = idleMs + 60000,
  // Idle time is what costs money for nothing, and that is already reaped after
  // idleMs. A computer that is being used is not waste, so this is only a
  // backstop against one that runs away and bills unnoticed, not a working
  // limit. It used to be fifteen minutes, which stopped ducks in the middle of
  // ordinary work and left people resuming from a snapshot over and over.
  maxSessionMs = 8 * 60 * 60 * 1000,
  // How long a machine that has just started is left alone before the idle rule
  // above can apply to it. Starting one takes a minute or two of that on its
  // own, and what follows is a person finding their bearings on a desktop that
  // has only just appeared, or a duck thinking about its first click. Neither
  // shows up as activity, and when the idle rule was two minutes that was
  // stopping machines almost as fast as they came up: the audit trail for one
  // afternoon reads start, stop ninety seconds later, start again, stop again.
  //
  // The idle window now exceeds this settling floor. Keep the floor so that
  // shortening that window cannot quietly bring the churn back.
  settlingMs = 5 * 60 * 1000;
const serial = new Map();
function lock(key, fn) {
  const before = serial.get(key) || Promise.resolve();
  const task = before.catch(() => {}).then(fn);
  serial.set(key, task);
  task
    .finally(() => {
      if (serial.get(key) === task) serial.delete(key);
    })
    .catch(() => {});
  return task;
}
export const computerConfigured = () => !!process.env.ASCII_API_KEY;
function settings(company) {
  return (
    one(
      "SELECT company_id,enabled FROM computer_settings WHERE company_id=?",
      company,
    ) || {
      company_id: company,
      enabled: 1,
    }
  );
}
// Each computer's time today: its row on the Computers page says its own. One
// read for all of them, because the page asks for every computer at once, about
// once a second while a duck writes, and a read per computer went through the
// company's whole usage each time.
export function dailySecondsByComputer(company, time = Date.now()) {
  const day = new Date(time);
  day.setUTCHours(0, 0, 0, 0);
  const used = new Map();
  for (const u of all(
    "SELECT computer_id,started,ended FROM computer_usage WHERE company_id=? AND (ended IS NULL OR ended>?)",
    company,
    day.getTime(),
  ))
    used.set(
      u.computer_id,
      (used.get(u.computer_id) || 0) +
        Math.max(
          0,
          (Math.min(u.ended ?? time, time) -
            Math.max(u.started, day.getTime())) /
            1000,
        ),
    );
  return used;
}
export function dailySeconds(company, time = Date.now()) {
  let sum = 0;
  for (const seconds of dailySecondsByComputer(company, time).values())
    sum += seconds;
  return sum;
}
// Every duck has its own computer unless someone turned access off for that duck.
export function duckComputerAllowed(duck, company) {
  return (
    one(
      "SELECT enabled FROM duck_computer_access WHERE duck_id=? AND company_id=?",
      duck,
      company,
    )?.enabled !== 0
  );
}
function modelCheckpoint(c, job) {
  if (!c?.checkpoint) return { checkpoint: "", checkpoint_provenance: null };
  const currentConversation =
    !!job &&
    (c.checkpoint_conversation_id || null) === (job.conversation_id || null);
  const currentJob = !!(
    job?.id &&
    c.checkpoint_job_id === job.id &&
    currentConversation
  );
  return {
    // A checkpoint records what a prior run believed it accomplished. Its text
    // is useful when that exact run resumes, but becomes false evidence when a
    // persistent computer is used for another task or conversation.
    checkpoint: currentJob ? c.checkpoint : "",
    checkpoint_provenance: {
      current_job: currentJob,
      current_conversation: currentConversation,
      saved_at: c.checkpoint_at || null,
      legacy: !c.checkpoint_job_id,
    },
  };
}
function checkpointUpdate(job, checkpoint) {
  return {
    checkpoint,
    checkpoint_job_id: job.id,
    checkpoint_conversation_id: job.conversation_id,
    checkpoint_at: now(),
  };
}
export function computerContext(duck, company, job = null) {
  const c = one(
    "SELECT id,state,checkpoint,checkpoint_job_id,checkpoint_conversation_id,checkpoint_at FROM computers WHERE duck_id=? AND company_id=?",
    duck,
    company,
  );
  return {
    enabled: !!(
      computerConfigured() &&
      settings(company).enabled &&
      duckComputerAllowed(duck, company)
    ),
    ...(c ? { id: c.id, state: c.state, ...modelCheckpoint(c, job) } : {}),
    human_control: !!computerHeld(duck, company),
    output_directory: "$HOME/tameduck/outputs",
  };
}
// Which ducks may have a computer, in a stable order.
const allowedDucks = (company) =>
  all(
    "SELECT id FROM ducks WHERE company_id=? AND id NOT IN (SELECT duck_id FROM duck_computer_access WHERE company_id=? AND enabled=0) ORDER BY chief DESC,created",
    company,
    company,
  ).map((d) => d.id);
// The whole policy as one value, so the Controls dialog can say which version
// it was looking at. Saving replaces the policy outright and starts and stops
// real machines, so a save from a dialog that has gone stale must not go
// through.
export const policyVersion = (company) =>
  crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        enabled: !!settings(company).enabled,
        ducks: allowedDucks(company),
      }),
    )
    .digest("hex");
// The duck's own tool names, handed over by duck-tools once it has built its
// list. Set rather than imported, because duck-tools imports this file and a
// cycle between them would leave one of the two half-built at load time.
let ownToolNames = new Set();
export const registerOwnTools = (names) => (ownToolNames = new Set(names));
// A duck looking for one of its OWN tools in here is told it does not exist,
// and believes it. That really happened: asked to hand a screen to a person, a
// duck looked up hand_over_screen through computer_tools - reasonably, since
// everything else it does to the computer goes through here - was told "this
// control is unavailable", announced "screen handover is unavailable in this
// session", and gave up. Then it wrote that in its checkpoint, where the next
// run read it as fact. So when the name is one of its own tools, say so and
// point at it.
const notADesktopControl = (name) =>
  ownToolNames.has(name)
    ? name +
      " is not a desktop control - it is one of your own tools. Call " +
      name +
      " directly, not through computer_tools or computer_action."
    : filteredBrowserMutations.has(name)
      ? name +
        " is unavailable for page interaction here. Use get_desktop_state or get_window_state, then native click, type_text, press_key, hotkey, scroll, drag, or move_cursor with the fresh capture's coordinates or element token. Do not guess coordinates or replay the refused browser action."
      : "This control is unavailable. Use computer_tools with no name to list the controls this computer has, or computer_terminal for full access to it. If you are looking for a tool of your own, call it directly rather than through the computer.";
function checkpointMessageId(computerId) {
  const job = one(
    `SELECT j.id,j.conversation_id,j.output_message_id
       FROM computer_actions action
       JOIN jobs j ON j.id=action.job_id
      WHERE action.id=(SELECT id FROM computer_actions WHERE computer_id=? ORDER BY rowid DESC LIMIT 1)
        AND NOT EXISTS(SELECT 1 FROM jobs active WHERE active.duck_id=j.duck_id AND active.company_id=j.company_id AND active.status='running' AND active.id<>j.id)`,
    computerId,
  );
  if (!job) return null;
  try {
    return (
      one(
        `SELECT parent.output_message_id
           FROM jobs current_helper
           JOIN duck_consultations consultation ON consultation.child_job_id=current_helper.id
           JOIN jobs parent ON parent.id=consultation.parent_job_id
          WHERE current_helper.conversation_id=?
          LIMIT 1`,
        job.conversation_id,
      )?.output_message_id || job.output_message_id
    );
  } catch (error) {
    if (/no such table: duck_consultations/i.test(error.message))
      return job.output_message_id;
    throw error;
  }
}
export function computerSummary(company, session) {
  const today = dailySecondsByComputer(company);
  return {
    configured: computerConfigured(),
    proxy: proxyCompanySummary(company),
    ...settings(company),
    idle_seconds: idleMs / 1000,
    session_minutes: maxSessionMs / 60000,
    // Sent so the screen can state the limit rather than remember it. The copy
    // there said "one active per company" and "a 15-minute maximum session"
    // long after both numbers had changed.
    max_running: maxRunningPerCompany(company),
    used_seconds: Math.ceil(
      [...today.values()].reduce((sum, seconds) => sum + seconds, 0),
    ),
    // Why a start would be refused right now, if it would be. Without this the
    // only trace of a refusal is a toast that clears itself in six seconds,
    // which is no help to somebody working out why nothing is starting.
    computer_limit: (() => {
      const v = computerAllowance(company);
      return v.ok ? null : { message: v.message };
    })(),
    policy_version: policyVersion(company),
    allowed_ducks: allowedDucks(company),
    items: all(
      "SELECT id,box_id,duck_id,state,bootstrapped,desktop_failed,checkpoint,checkpoint_job_id,screenshot_at,last_activity,viewer_until,started_at,archive_after,error,stopped_reason,created,updated FROM computers WHERE company_id=? ORDER BY created",
      company,
    ).map(({ bootstrapped, box_id, checkpoint_job_id, ...c }) => {
      // Each asked once. The request was looked up four times per computer.
      const request = requestForComputer(c.id),
        h = controlFor(c.id),
        live = readyStates.includes(c.state),
        time = Date.now();
      // The janitor's own answers, so the page says what the janitor will do.
      const in_use = live && midRun(c.id);
      const awaiting_user_id =
        live && !request ? awaitedPerson({ ...c, company_id: company }) : null;
      const last_start = lastEvent(c.id, ["started"]),
        stop = lastEvent(c.id, STOP_KINDS),
        // A stop from before the last start is not why it is off now. When the
        // stop after it was never written down, not knowing is the truth.
        last_stop = stop && !(last_start?.at > stop.at) ? stop : null;
      return {
        ...c,
        proxy: proxyComputerSummary(company, c.id, c.duck_id),
        checkpoint_token: checkpointToken({
          ...c,
          box_id,
          company_id: company,
        }),
        checkpoint_message_id: checkpointMessageId(c.id),
        // When this computer last did something that could change what is on
        // the screen. A duck working in the terminal refreshes last_activity with
        // every command while the picture stays exactly as it was, so a screen
        // still showing a form from a job two days ago was being badged as live,
        // and somebody sat watching it asking why nothing was happening. Nothing
        // was - on the screen. The work was going on where the screen cannot show
        // it, and only this says so.
        desktop_at:
          one(
            "SELECT created FROM computer_actions WHERE computer_id=? AND tool<>'terminal' ORDER BY rowid DESC LIMIT 1",
            c.id,
          )?.created || null,
        // Whether this screen is actually being kept up to date right now. The
        // card used to decide that for itself from the machine's state, and said
        // "Live - a new picture every second" about any running machine. Since
        // photographs stopped happening for machines nobody is using, that was a
        // promise the server had no intention of keeping: a page left open while
        // somebody went for coffee showed a frozen picture captioned as live.
        photographing: !!captureEligible(
          { ...c, bootstrapped, box_id },
          // Null, not undefined: undefined would ask again.
          { hold: h || null, request: request || null, running: () => in_use },
        ),
        request_id: request?.id || null,
        // What kind of request it is. A takeover is somebody helping themselves
        // to the screen; a form is the duck asking for a person by name. The
        // screen said the second about both, so a colleague quietly taking a
        // machine was reported as the duck having asked a teammate for help.
        request_kind: request?.kind || null,
        // Who it is waiting for. A duck with an open request will not start
        // anything new - the run loop skips it while its computer is held - so a
        // card nobody answered quietly stops that duck working, and the only sign
        // anywhere was a reply in a chat that appeared to be thinking for ever.
        request_user_id: request?.user_id || null,
        // A request written off by a server restart cannot be answered - the
        // frozen page it belonged to is gone - but it still holds this duck's
        // computer, and a held computer makes the run loop skip every job that
        // duck is given. The way out is to stop the run, and nobody could see
        // there was anything to stop: the Needs you page lists only requests that
        // are pending, preparing, desktop or submitting.
        request_status: request?.status || null,
        // Whether this duck has a run going at all, asked here rather than worked
        // out from the run list on the screen: that list only carries runs from
        // conversations the reader is in, so a colleague's run - and every run
        // with no conversation, like a schedule or a board - was invisible.
        // "Save & stop" then skipped its own warning and threw the work away
        // without a word.
        duck_working: !!one(
          "SELECT 1 FROM jobs WHERE duck_id=? AND company_id=? AND status IN ('running','queued')",
          c.duck_id,
          company,
        ),
        human_control: h
          ? {
              user_id: h.user_id,
              expires: h.expires,
              state: h.state,
              phase: h.phase || null,
              generation: h.generation,
              owned_by_session: h.session_hash === session,
            }
          : null,
        state: c.state,
        automation_ready: !!bootstrapped,
        // The desktop was given its time to come up and did not. Without this the
        // card said it was still on its way, for as long as the machine was up.
        desktop_failed: !!c.desktop_failed,
        // Its own share of today, for its row.
        used_today: Math.ceil(today.get(c.id) || 0),
        in_use,
        // Kept on because a duck's last reply asked this person something.
        awaiting_user_id,
        // When it stops by itself if nothing changes, so the page can say so.
        stops_at: live
          ? stopsAt(c, {
              hold: h,
              asked: askedFor(request, time),
              awaiting: !!awaiting_user_id,
              working: in_use,
              now: time,
            })
          : null,
        last_start,
        last_stop,
        // Stops from before computer_events have no last_stop, so the time the
        // machine last stopped counting is the next best answer.
        off_since:
          c.state === "archived"
            ? last_stop?.at ||
              (() => {
                const ended = one(
                  "SELECT max(ended) m FROM computer_usage WHERE computer_id=?",
                  c.id,
                )?.m;
                return ended ? new Date(ended).toISOString() : null;
              })()
            : null,
        work: computerWork(c, { request, checkpoint_job_id, last_start }),
      };
    }),
  };
}
// What a computer is working for, or last worked for, as the place a person
// knows: a chat or a ticket. A question it is waiting on names its run.
// Otherwise it is the newer of the last run that did something on it and the
// last start - and a start by a person that is newer than any run's action
// means nothing is known to be using it yet, so the row says who started it.
function computerWork(c, { request, checkpoint_job_id, last_start }) {
  let job = request?.job_id || null;
  if (!job) {
    const acted = one(
      "SELECT job_id,created FROM computer_actions WHERE computer_id=? AND job_id IS NOT NULL ORDER BY rowid DESC LIMIT 1",
      c.id,
    );
    const on = !["archived", "not_started"].includes(c.state);
    job =
      on && last_start && (!acted || last_start.at > acted.created)
        ? last_start.job_id
        : acted?.job_id || last_start?.job_id || null;
  }
  const place = job ? placeOf(job) : null;
  if (!place) return null;
  return {
    ...place,
    // What the run said it was doing - but only that run's own checkpoint. One
    // left by another run is not evidence about this one (modelCheckpoint).
    note:
      checkpoint_job_id === job
        ? (c.checkpoint || "")
            .split("\n")
            .map((line) => line.trim())
            .find(Boolean)
            ?.slice(0, 140) || null
        : null,
  };
}
// Bounded by the same wait the person gets for a request, so a duck asking and
// never being answered cannot hold a machine indefinitely. Answers who was
// asked, so the page can say whose answer the computer is kept on for.
//
// Only runs inside the longest wait anybody can set are read. Nothing older
// can count, and without the bound a duck that had never asked anybody had
// every run the company ever had read through, for each computer, each time
// the Computers page was sent.
function awaitedPerson(c) {
  const j = one(
    "SELECT j.user_id,j.needs_you,j.updated FROM jobs j WHERE j.duck_id=? AND j.company_id=? AND j.needs_you IS NOT NULL AND j.needs_you<>'' AND j.updated>? ORDER BY j.updated DESC LIMIT 1",
    c.duck_id,
    c.company_id,
    new Date(Date.now() - MAX_HUMAN_WAIT_MINUTES * 60000).toISOString(),
  );
  if (!j) return null;
  const waited = Date.now() - Date.parse(j.updated);
  return waited >= 0 &&
    waited < effectiveHumanWaitMinutes(j.user_id, c.duck_id) * 60000
    ? j.user_id
    : null;
}
const awaitingPerson = (c) => !!awaitedPerson(c);
function authorize(company, user, duck, { start = true } = {}) {
  const m = memberFor(company, user);
  if (!m) fail(403, "Your company membership has ended.");
  can(m, "computers");
  tenant("ducks", duck, company);
  if (start) {
    if (!computerConfigured())
      fail(503, "Computer provider is not configured.");
    if (!settings(company).enabled)
      fail(409, "Computers are paused for this company.");
    if (one("SELECT paused FROM companies WHERE id=?", company)?.paused)
      fail(409, "The company is paused.");
    if (!duckComputerAllowed(duck, company))
      fail(403, "Enable computer access for this duck in Computers first.");
  }
}
export async function asciiRequest(p, method = "GET", body, opts = {}) {
  // Keep persisted computer identities and internal callers stable across the
  // provider rename; only the external API path and envelope changed.
  const providerPath = p.replace(/^\/boxes(?=\/|\?|$)/, "/sandboxes");
  const r = await fetch(BASE + providerPath, {
    method,
    headers: {
      Authorization: "Bearer " + process.env.ASCII_API_KEY,
      "Content-Type": "application/json",
      ...(opts.key ? { "Idempotency-Key": opts.key } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(opts.timeout || 35000),
    redirect: "error",
  });
  let result;
  try {
    result = await r.json();
  } catch {
    fail(502, "The computer provider returned an unreadable response.");
  }
  if (!r.ok || result.ok === false) {
    const code = String(result.code || result.error?.code || "provider_error")
      .replace(/[^a-z_0-9]/gi, "")
      .slice(0, 80);
    const limitWindow = result.details?.window || result.error?.details?.window;
    // The code belongs in the log. Putting it in front of the person named a
    // service they have never heard of and sent them to an "account" and a
    // "panel" that are not part of TameDuck and that they cannot open.
    if (opts.sensitive)
      console.error("Computer provider refused private request", p, r.status);
    else console.error("Computer provider refused", p, r.status, code);
    const e = new Error(
      r.status === 429
        ? limitWindow === "day"
          ? "Computers have been started too many times today. This resets tomorrow."
          : "The computer service is busy. Please try again in a few minutes."
        : r.status === 402
          ? "Computers are unavailable because the TameDuck account needs attention. The owner of this workspace can sort it out in Settings."
          : "The computer service could not do that just now. Please try again in a moment.",
    );
    e.status = r.status === 429 ? 429 : 502;
    e.providerStatus = r.status;
    e.providerCode = code;
    throw e;
  }
  if (result && typeof result === "object") {
    if (result.sandbox && !result.box)
      result = { ...result, box: result.sandbox };
    if (result.sandboxes && !result.boxes)
      result = { ...result, boxes: result.sandboxes };
  }
  return result;
}
// What to put on a computer's card when something went wrong with it. Every
// message this file writes for a person carries a status; anything without one
// came from Node or from the provider's own plumbing — "fetch failed", a DNS
// name, a socket timeout — and saying that to somebody tells them nothing and
// worries them. The detail still goes to the log, where it is useful.
function shownError(e, context) {
  if (e?.status) return e.message;
  console.error("Computer failure", context, String(e?.message || e));
  return "Something went wrong with this computer. Try again in a moment.";
}
function row(cid) {
  return one("SELECT * FROM computers WHERE id=?", cid);
}
// announce:false writes the row without telling every open page in the company
// to reload its workspace. Only one caller uses it, and the reason is below.
function update(cid, fields, { announce = true } = {}) {
  const allowed = new Set([
    "box_id",
    "state",
    "checkpoint",
    "checkpoint_job_id",
    "checkpoint_conversation_id",
    "checkpoint_at",
    "screenshot_at",
    "screenshot_path",
    "last_activity",
    "viewer_until",
    "started_at",
    "archive_after",
    "error",
    "request_at",
    "bootstrapped",
    "bootstrap_version",
    "stopped_reason",
    "desktop_failed",
  ]);
  for (const k of Object.keys(fields))
    if (!allowed.has(k)) throw new Error("Invalid computer field");
  run(
    "UPDATE computers SET " +
      Object.keys(fields)
        .map((k) => k + "=?")
        .join(",") +
      ",updated=? WHERE id=?",
    ...Object.values(fields),
    now(),
    cid,
  );
  if (announce) emit(row(cid).company_id);
}
async function sync(cid) {
  const c = row(cid);
  if (!c.box_id) return c;
  let r;
  try {
    r = await asciiRequest("/boxes/" + encodeURIComponent(c.box_id));
  } catch (e) {
    // "There is no such machine" is not a hiccup to try again in a moment, and
    // it was being reported as one. Every route in this file starts by asking
    // the provider about the machine, so one gone box refused starting, refused
    // stopping and refused every action the duck took, all with the same
    // sentence, and the housekeeping round wrote that sentence back onto the
    // card every twenty seconds for ever. Nothing cleared the box id, so there
    // was no way out of it from inside the product - and the quietest version
    // was the worst: a computer stopped weeks ago, whose box the provider no
    // longer keeps, sat on "Stopped and saved" with a Resume button that could
    // never work again.
    //
    // Only a definite answer counts. A timeout or a 500 is a bad minute and is
    // rethrown; 404 and 410 are the provider saying it does not have this.
    if (![404, 410].includes(e.providerStatus)) throw e;
    run(
      "UPDATE computer_usage SET ended=? WHERE computer_id=? AND ended IS NULL",
      Date.now(),
      cid,
    );
    update(cid, {
      box_id: null,
      state: "not_started",
      bootstrapped: 0,
      viewer_until: 0,
      archive_after: null,
      request_at: null,
      error:
        "The saved workspace for this computer is no longer on the computer service, so it cannot be started again. Starting this computer makes a fresh one.",
    });
    return row(cid);
  }
  const b = r.box;
  if (!b?.state) throw new Error("Computer provider returned no state.");
  // Asking the provider takes time, and the janitor does it without the lock, so
  // somebody can stop this computer while the question is in flight. Deciding
  // from the row as it was before the question would then write the old state
  // back and bring a computer someone had just stopped back to life.
  const current = row(cid);
  const fields = {
    state:
      current.state === "archiving" && b.state !== "archived"
        ? "archiving"
        : b.state,
    archive_after: b.archiveAfter || null,
    // We have just been told about this machine, so whatever went wrong before
    // is over. Without this one bad minute during housekeeping left a perfectly
    // healthy computer wearing "Needs attention" until somebody stopped it.
    error: null,
  };
  if (b.state === "archived") {
    fields.viewer_until = 0;
    fields.bootstrapped = 0;
    // A resume that has just been accepted can be answered "archived" one more
    // time before the provider catches up. Closing the usage row on that
    // reading and opening another on the next one turns one start into two,
    // and a start now costs the company something. So a lagging answer during
    // a resume is not treated as a stop - the same allowance the state field
    // above already makes for "archiving". If the resume really did fail, the
    // row is archived by then and the next sync closes it, one reading later.
    if (current.state !== "resuming") {
      run(
        "UPDATE computer_usage SET ended=? WHERE computer_id=? AND ended IS NULL",
        Date.now(),
        cid,
      );
      // Stopped by the provider on its own - its time ran out - as well as by
      // Save & stop.
      releaseHeldScreen(current);
      // Nobody pressed Stop, so nothing wrote it down, and the computer's page
      // blamed whoever had stopped it the time before, at that old time.
      if (!["archiving", "archived"].includes(current.state))
        computerEvent(current, "stopped");
    }
  }
  update(cid, fields);
  const synced = row(cid);
  // This also covers housekeeping: a resume may have succeeded after its
  // request timed out, without another person or duck explicitly retrying it.
  reconcileComputerUsage(synced);
  return synced;
}
function quote(s) {
  return "'" + s.replaceAll("'", "'\\''") + "'";
}
async function command(c, cmd, seconds = 30, { sensitive = false } = {}) {
  const r = await asciiRequest(
    "/boxes/" + encodeURIComponent(c.box_id) + "/commands",
    "POST",
    { command: cmd, timeoutSeconds: seconds },
    { timeout: (seconds + 7) * 1000, sensitive },
  );
  if (!r.success || r.exitCode !== 0 || r.timedOut) {
    console.error("Computer command failed", {
      exitCode: r.exitCode,
      timedOut: r.timedOut,
      phase: cmd.startsWith("python3 -c")
        ? "desktop setup"
        : cmd.includes("driver.py")
          ? "desktop control"
          : "image tools",
      // Provider output can echo what was typed. Keep it out of the
      // service journal when this command carries a saved credential.
      ...(sensitive
        ? {}
        : {
            setupStage: cmd.startsWith("python3 -c")
              ? String(r.stdout || "").slice(-300)
              : undefined,
            stderr: String(r.stderr || "").slice(-1600),
          }),
    });
    // The caller above decides whether this is worth retrying, and it decides
    // from what actually went wrong. Throwing only the friendly sentence threw
    // the reason away with it, so the one piece of self-healing this file has —
    // noticing that the desktop controls have died and starting them again —
    // could never fire.
    throw Object.assign(
      new Error(
        "The computer action could not finish. Inspect its last screen before retrying.",
      ),
      {
        status: 502,
        cause: sensitive
          ? "Private desktop input failed."
          : String(r.stderr || r.stdout || "").slice(-1600),
      },
    );
  }
  if (r.stdoutTruncated)
    fail(502, "Computer response was too large. Request a smaller view.");
  return r.stdout;
}

async function executeProxyGuest(c, payload) {
  const install =
    payload.op === "enable"
      ? (() => {
          const script = fs.readFileSync(
            new URL("./guest/proxy.py", import.meta.url),
            "utf8",
          );
          const script64 = Buffer.from(script).toString("base64");
          return (
            "sudo install -d -m 0755 /usr/local/lib/tameduck && " +
            "printf %s " +
            quote(script64) +
            " | base64 -d | sudo tee /usr/local/lib/tameduck/proxy.py >/dev/null && " +
            "sudo chmod 0700 /usr/local/lib/tameduck/proxy.py && "
          );
        })()
      : "";
  const payload64 = Buffer.from(JSON.stringify(payload)).toString("base64");
  const stdout = await command(
    c,
    install +
      "printf %s " +
      quote(payload64) +
      " | base64 -d | sudo python3 /usr/local/lib/tameduck/proxy.py",
    45,
    { sensitive: true },
  );
  const line = String(stdout || "")
    .trim()
    .split("\n")
    .filter(Boolean)
    .at(-1);
  let result;
  try {
    result = JSON.parse(line || "");
  } catch {
    fail(502, "The computer proxy returned an unreadable response.");
  }
  if (!result || typeof result !== "object" || Array.isArray(result))
    fail(502, "The computer proxy returned an unreadable response.");
  if (result.ok !== true)
    fail(502, "The computer proxy operation did not complete.");
  return result;
}

export async function finishComputerProxyForJob(job) {
  return finishJobComputerProxy(job, executeProxyGuest);
}
// One at a time per computer. Starting the desktop controls restarts whatever
// is already there, so two callers arriving together - the usual case being a
// person pasting twice because the first paste gave no sign of life - each ran
// the whole thing and the second killed the controls the first had just
// started. Callers that arrive while one is running wait for that one instead.
// This is deliberately not the computer lock: bootstrap is called from inside
// that lock, and taking it again here would wait on itself forever.
const booting = new Map();
// A machine is set up when the controls are running AND the script that set
// them up is the one we ship now. Changing guest/bootstrap.py changes this
// string, and every running computer redoes its setup the next time anyone
// looks at it rather than carrying the old behaviour until its next stop.
const bootVersion = crypto
  .createHash("sha256")
  .update(
    fs.readFileSync(new URL("./guest/bootstrap.py", import.meta.url)) +
      fs.readFileSync(new URL("./guest/driver.py", import.meta.url)),
  )
  .digest("hex")
  .slice(0, 12);
const setUp = (c) => !!c.bootstrapped && c.bootstrap_version === bootVersion;
async function bootstrap(cid, guard = () => {}) {
  if (setUp(row(cid))) return true;
  const inFlight = booting.get(cid);
  if (inFlight) return inFlight;
  const attempt = bootstrapOnce(cid, guard).finally(() => {
    if (booting.get(cid) === attempt) booting.delete(cid);
  });
  booting.set(cid, attempt);
  return attempt;
}
async function bootstrapOnce(cid, guard = () => {}) {
  const script = fs.readFileSync(
    new URL("./guest/driver.py", import.meta.url),
    "utf8",
  );
  let c = row(cid);
  if (setUp(c)) return true;
  await command(
    c,
    `if [ ! -x "$HOME/tameduck/venv/bin/python" ]; then python3 -m venv "$HOME/tameduck/venv"; fi
"$HOME/tameduck/venv/bin/python" -c 'from PIL import Image' 2>/dev/null || "$HOME/tameduck/venv/bin/python" -m pip install --quiet 'Pillow>=11,<14'`,
    40,
  );
  const boot = fs.readFileSync(
    new URL("./guest/bootstrap.py", import.meta.url),
    "utf8",
  );
  const start =
    "python3 -c " +
    quote(boot) +
    " " +
    quote(Buffer.from(script).toString("base64")) +
    " readiness-v2";
  // A resumed machine reports its desktop as still starting for the first few
  // seconds. Waiting here rather than returning makes one start give back a
  // computer that is actually usable: otherwise the desktop controls stayed
  // down, and every screenshot failed with a refused connection until someone
  // happened to start the computer again.
  const deadline = Date.now() + desktopReadyMs;
  for (;;) {
    // Longer than the guest's own wait for its controls, so that when the guest
    // gives up it is still being listened to and its account of which half
    // failed reaches us. Equal numbers meant that account was never heard.
    const result = await command(c, start, 45);
    if (!result.includes("TAMEDUCK_DESKTOP_STARTING")) break;
    // Out of time. Giving up quietly left the card saying the desktop was
    // still starting and the duck being told to ask again - for as long as the
    // machine stayed up, which on one whose browser never comes back is
    // forever. Say it plainly, and say what fixes it.
    if (Date.now() + desktopPollMs >= deadline) {
      update(cid, { desktop_failed: 1 });
      return false;
    }
    await new Promise((r) => setTimeout(r, desktopPollMs));
    guard();
    c = row(cid);
    if (!readyStates.includes(c.state)) return false;
  }
  update(cid, {
    bootstrapped: 1,
    bootstrap_version: bootVersion,
    error: null,
    desktop_failed: 0,
  });
  return true;
}
const retryableDesktopReads = new Set([
  "list_apps",
  "list_windows",
  "get_window_state",
  "get_screen_size",
  "get_desktop_state",
  "get_browser_state",
  "zoom",
]);
async function driver(
  cid,
  tool,
  args,
  checkpoint,
  { retry = true, trajectory = false, guard = () => {} } = {},
) {
  const c = row(cid);
  // A read-only probe supplies physical pixels while the existing computer
  // lock is held. Only the final request can inject input; it is never replayed.
  const cursorTrajectory = trajectory
    ? await attachCursorTrajectory({
        tool,
        args,
        guard,
        generate: generateCursorTrajectory,
        probe: async (arguments_) => {
          const probePayload = Buffer.from(
            JSON.stringify({ tool: "__cursor_probe", arguments: arguments_ }),
          ).toString("base64");
          return JSON.parse(
            await command(
              c,
              '\"$HOME/tameduck/venv/bin/python\" \"$HOME/tameduck/driver.py\" ' +
                quote(probePayload),
              6,
              { sensitive: true },
            ),
          );
        },
      })
    : null;
  guard();
  if (trajectory && requiresCursorTrajectory(tool, args) && !cursorTrajectory)
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: "The humanized cursor model could not prepare a valid movement. No input was sent; inspect the screen before trying again.",
        },
      ],
      structuredContent: {
        status: "refused",
        effect: "refused",
        refusal: { code: "cursor_model_unavailable" },
        cursor_motion: { status: "refused", click_sent: false },
      },
    };
  const payload = Buffer.from(
    JSON.stringify({
      tool,
      arguments: args,
      checkpoint,
      ...(cursorTrajectory ? { cursor_trajectory: cursorTrajectory } : {}),
    }),
  ).toString("base64");
  const call = () =>
    command(
      c,
      '"$HOME/tameduck/venv/bin/python" "$HOME/tameduck/driver.py" ' +
        quote(payload),
      30,
      { sensitive: !retry },
    );
  let result;
  try {
    result = await call();
  } catch (e) {
    // Desktop controls that are down look identical to a computer with no
    // desktop at all: every screenshot fails and the duck quietly falls back to
    // shell commands, then reports it could not share what it saw. Bring the
    // controls back and repeat a read once. A failed mutation may already have
    // reached the desktop, so never replay it after a transport error.
    // Refused means the controls died; missing means they were never started,
    // which is the normal state during a human takeover, where the duck's
    // automation is deliberately skipped. Both are fixed by starting them.
    if (
      !retry ||
      !retryableDesktopReads.has(tool) ||
      !/refused|no such file|connection/i.test(
        String(e?.cause || "") + " " + String(e?.message || ""),
      )
    )
      throw e;
    update(cid, { bootstrapped: 0 });
    if (!(await bootstrap(cid))) throw e;
    result = await call();
  }
  let r;
  try {
    r = JSON.parse(result);
  } catch {
    throw new Error(
      "Desktop response was incomplete. Inspect the saved screen before retrying.",
    );
  }
  await saveScreen(cid, r, tool);
  return r;
}
// The Computers page should always show the duck's last screen, including while
// it waits for a person. The one thing never photographed is a session a person
// is actually holding, because they may be typing a password into it.
export const screenshotAllowed = (cid) => !controlFor(cid);
// Only a picture of the whole display is this machine's screen. Every tool that
// happens to return an image was overwriting it: zoom returns a crop of at most
// five hundred pixels, get_window_state returns one app's window - and the
// toolset will photograph a window that is behind another one or not on screen
// at all, since it drives them without bringing them to the front. Those were
// then shown on the Computers page as "the last captured screen of this duck's
// computer", full width in the modal, and handed to a person as the machine's
// state. On a running machine the next housekeeping round put a real one back a
// few seconds later; a stopped one kept the fragment for ever, because stopping
// deliberately skips a final capture, and so did one parked waiting for its
// person.
const wholeScreen = "get_desktop_state";
async function saveScreen(cid, r, tool) {
  if (tool !== wholeScreen) return;
  if (!screenshotAllowed(cid)) return;
  const image = r.content?.find((i) => i.type === "image" && i.data);
  if (!image) return;
  const dir = path.join(DATA, "computer-previews");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, cid + ".enc");
  fs.writeFileSync(file + ".tmp", encrypt(image.data), { mode: 0o600 });
  fs.renameSync(file + ".tmp", file);
  // Saving a picture nobody is watching does not need every open page in the
  // company to reload its whole workspace. The preview round has a comment
  // saying it deliberately does not do that, and it was never true: the round
  // does not announce anything, but the capture it performs writes a row, and
  // writing a row announced. Harmless while photographs only happened for
  // somebody who was watching; now that a duck working alone is photographed
  // every second, it meant a second-by-second reload in every open tab in the
  // company for a picture nobody had asked to see.
  //
  // Somebody actually watching does still need it: that screen busts its cache
  // with screenshot_at, which only reaches the browser on a refresh. The list
  // page counts its own frames and fetches the image itself.
  const watching = row(cid).viewer_until > Date.now();
  update(
    cid,
    { screenshot_path: file, screenshot_at: now() },
    { announce: watching },
  );
}
async function capture(cid) {
  if (!screenshotAllowed(cid)) return null;
  return driver(
    cid,
    "get_desktop_state",
    { session: "td-" + cid },
    row(cid).checkpoint,
  );
}
async function capturePageWindow(cid, context) {
  if (!screenshotAllowed(cid)) return null;
  const result = await driver(
    cid,
    "get_window_state",
    {
      pid: context.pid,
      window_id: context.window_id,
      include_screenshot: true,
      session: "td-" + cid,
    },
    row(cid).checkpoint,
  );
  const state = result?.structuredContent || {};
  if (
    result?.isError ||
    computerOutcome(result).failed ||
    state.pid !== context.pid ||
    state.window_id !== context.window_id ||
    !result.content?.some((item) => item.type === "image" && item.data)
  )
    return null;
  return result;
}
async function captureForJob(cid, jobId) {
  const context = pageWindow.get(cid);
  return context?.jobId === jobId
    ? capturePageWindow(cid, context)
    : capture(cid);
}
export function computerImage(c) {
  if (!c.screenshot_path) return null;
  return Buffer.from(
    decrypt(fs.readFileSync(c.screenshot_path, "utf8")),
    "base64",
  );
}
// Renewing hosting must not pretend the Duck used the computer. Otherwise
// housekeeping itself would reset the idle clock forever.
async function renewComputerLease(c) {
  if (
    c.archive_after &&
    Date.parse(c.archive_after) - Date.now() < renewBeforeMs
  ) {
    const r = await asciiRequest("/boxes/" + c.box_id, "PATCH", {
      ttlSeconds: ttl,
    });
    update(c.id, {
      archive_after:
        r.box?.archiveAfter || new Date(Date.now() + ttl * 1000).toISOString(),
    });
  }
}
// Housekeeping must not renew a stale provider identity while a foreground
// start, stop or action owns the computer. Skip a busy computer rather than
// waiting behind a long action; the next twenty-second round can try again.
async function renewComputerLeaseFromJanitor(snapshot) {
  const key = "computer:" + snapshot.id;
  if (serial.has(key)) return false;
  return lock(key, async () => {
    const current = row(snapshot.id);
    if (
      !current ||
      current.box_id !== snapshot.box_id ||
      !readyStates.includes(current.state)
    )
      return false;
    await renewComputerLease(current);
    return true;
  });
}
async function touch(cid) {
  update(cid, { last_activity: Date.now() });
  await renewComputerLease(row(cid));
}
function budget(c) {
  if (
    !requestForComputer(c.id) &&
    c.started_at &&
    Date.now() - c.started_at > maxSessionMs
  )
    fail(
      429,
      "This computer has been running for eight hours without a break. It has to be saved and stopped from the Computers page before it can carry on - that is a person's to do, not a duck's.",
    );
}
export async function ensureComputer(
  company,
  user,
  duck,
  reason,
  guard = () => {},
  { desktopOnly = false, modelJob = null } = {},
) {
  authorize(company, user, duck);
  // The ceiling this protects is counted per company, so the wait belongs to the
  // company too. Serialising every start in the whole deployment meant one cold
  // machine, which can take a minute and a half to come back from its snapshot,
  // held up every other company's ducks and every other person's takeover.
  return lock("company-start:" + company, () =>
    lock("duck:" + duck, async () => {
      guard();
      let c = one(
        "SELECT * FROM computers WHERE duck_id=? AND company_id=?",
        duck,
        company,
      );
      if (!c) {
        const cid = id();
        run(
          "INSERT INTO computers(id,company_id,duck_id,created,updated) VALUES(?,?,?,?,?)",
          cid,
          company,
          duck,
          now(),
          now(),
        );
        c = row(cid);
      }
      if (c.box_id) c = await sync(c.id);
      // The provider can briefly report the old running state after accepting stop.
      for (let n = 0; c.state === "archiving" && n < 15; n++) {
        await new Promise((r) => setTimeout(r, 1000));
        c = await sync(c.id);
      }
      if (
        !c.box_id ||
        (!readyStates.includes(c.state) && !activeStates.includes(c.state))
      ) {
        // Before anything is written down. A company that has run out of its
        // allowance cannot fix that by pausing a machine, so it is told that
        // first, and being told leaves no state change and no usage row behind.
        assertComputerAllowance(company, { computerId: c.id });
        // Counted per company: one tenant's computers must never block another's.
        // The old ceiling of two was the provider's trial limit, which this account
        // left long ago, so ducks were refused far below the capacity we pay for.
        const running = all(
          "SELECT * FROM computers WHERE id<>? AND company_id=? AND state IN ('provisioning','provisioned','cloning','ready','idle','running','archiving','resuming')",
          c.id,
          company,
        );
        const most = maxRunningPerCompany(company);
        if (running.length >= most)
          fail(
            429,
            `All ${most} computers for this company are already running. Pause one before starting another.`,
          );
        if (c.box_id && c.state !== "archived")
          fail(
            409,
            "This computer needs attention. Its saved workspace will not be replaced.",
          );
        update(c.id, {
          state: "provisioning",
          request_at: c.request_at || Date.now(),
          last_activity: Date.now(),
          started_at: Date.now(),
          viewer_until: 0,
          error: null,
          desktop_failed: 0,
        });
        try {
          let r;
          if (c.box_id)
            r = await asciiRequest(
              "/boxes/" + c.box_id + "/resume",
              "POST",
              {
                type: "small",
                noEnv: true,
                ttlSeconds: ttl,
              },
              { timeout: startRequestMs },
            );
          else {
            // No day-old lockout here any more. It was meant to stop a second
            // machine being created and billing unnoticed, but the create below
            // carries this computer's own id as its idempotency key, which is
            // exactly what makes asking again safe. What the guard actually did
            // was this: a duck's very first create fails - a timeout, a 502,
            // anything - request_at is stamped and only ever cleared by a
            // create that succeeds, so if nobody retried before the next day,
            // that duck could never have a computer again. Nothing in the
            // product can clear that stamp. The card said "Connection needs
            // checking" with a Start button that failed for ever, pointing at a
            // provider account whose name this file is careful never to say.
            r = await asciiRequest(
              "/boxes",
              "POST",
              { type: "small", noEnv: true, ttlSeconds: ttl },
              { key: c.id, timeout: startRequestMs },
            );
          }
          const bid = r.box?.id || c.box_id;
          if (!bid)
            throw new Error("The provider did not return a computer id.");
          update(c.id, {
            box_id: bid,
            state: r.box?.state || "provisioning",
            archive_after:
              r.box?.archiveAfter ||
              new Date(Date.now() + ttl * 1000).toISOString(),
            bootstrapped: 0,
            stopped_reason: null,
            // The request is answered, so the mark that says "we asked for a
            // computer and never heard back" has to go. It was only ever set and
            // never cleared, so a duck whose first attempt had failed was refused
            // for good once that stamp turned a day old.
            request_at: null,
          });
          if (
            !one(
              "SELECT 1 FROM computer_usage WHERE computer_id=? AND ended IS NULL",
              c.id,
            )
          )
            run(
              "INSERT INTO computer_usage VALUES(?,?,?,?,NULL)",
              id(),
              c.id,
              company,
              Date.now(),
            );
          audit(
            company,
            user,
            c.box_id ? "Computer resumed" : "Computer created",
            { duck: tenant("ducks", duck, company).name, reason },
          );
          // A duck's run starts one for itself; a person starts one from this
          // page or by taking an off screen.
          computerEvent(c, "started", {
            user: modelJob ? null : user,
            job: modelJob?.id || null,
          });
        } catch (e) {
          // A failed resume says nothing about whether the provider accepted
          // it - the timeout here is ours, not theirs. Writing "archived" on
          // our own authority took the row out of the janitor's reconciliation
          // for good, so a machine that really had started kept running and
          // billing: never stopped, and never counted in the time used. The
          // state is left for the janitor, which asks the provider and records
          // whatever is actually true.
          update(
            c.id,
            c.box_id
              ? { error: shownError(e, "start") }
              : { state: "creation_uncertain", error: shownError(e, "create") },
          );
          throw e;
        }
      }
      c = row(c.id);
      if (c.state === "archiving")
        return {
          id: c.id,
          state: c.state,
          ...(modelJob
            ? modelCheckpoint(c, modelJob)
            : { checkpoint: c.checkpoint }),
          message: "Saving the disk snapshot. Resume after it finishes.",
        };
      for (let n = 0; n < 20 && !readyStates.includes(c.state); n++) {
        await new Promise((r) => setTimeout(r, 1500));
        c = await sync(c.id);
      }
      if (readyStates.includes(c.state)) {
        // A resume can succeed at the provider after our request times out. A
        // later sync is the first authoritative evidence that billing resumed.
        reconcileComputerUsage(c);
        await reconcileComputerProxy(c, executeProxyGuest, { force: true });
        c = row(c.id);
        budget(c);
        await touch(c.id);
        if (!desktopOnly)
          await lock("computer:" + c.id, async () => {
            guard();
            if (await bootstrap(c.id, guard)) {
              if (!c.screenshot_at) await capture(c.id);
            }
          });
      }
      return {
        id: c.id,
        state:
          !desktopOnly &&
          readyStates.includes(row(c.id).state) &&
          !row(c.id).bootstrapped
            ? "provisioning"
            : row(c.id).state,
        ...(modelJob
          ? modelCheckpoint(c, modelJob)
          : { checkpoint: c.checkpoint }),
        message:
          desktopOnly && readyStates.includes(c.state)
            ? "Computer is running. Open its screen to take control."
            : readyStates.includes(c.state) && row(c.id).bootstrapped
              ? "Computer ready. Browser profile: $HOME/tameduck/chrome. To persist browser language, write a language such as nl-NL in $HOME/tameduck/browser-settings.json; startup applies it to Chrome and its content languages. Shell work is not visible on screen; keep your checkpoint current."
              : row(c.id).desktop_failed
                ? desktopDidNotStart
                : "Computer is starting. Call computer_start again to check readiness; it reuses the same computer.",
      };
    }),
  );
}
// Write down which pages are open before the machine goes away underneath them.
// The guest already keeps that list, in browser-tabs.json, and the desktop puts
// those pages back when it starts - but it only wrote the list after one of the
// duck's own desktop actions. A person who took the screen over and opened
// things themselves never triggered it, so their machine came back showing
// whatever the duck had been looking at, sometimes hours earlier. Measured on a
// real machine: a page opened by hand was gone after a stop, while the duck's
// last page returned. That reads as a crash, and it is what somebody means when
// they say the computer restarted and lost what it was doing.
//
// Best effort and strictly bounded: a machine that is wedged, slow, or already
// gone must never be able to delay releasing it. The test for that is in
// tests/computer-stop.test.mjs.
async function saveOpenPages(c) {
  let timer;
  try {
    await Promise.race([
      command(
        c,
        "$HOME/tameduck/venv/bin/python -c \"import socket,pathlib,json;s=socket.socket(socket.AF_UNIX);s.settimeout(5);s.connect(str(pathlib.Path.home()/'tameduck'/'control.sock'));s.sendall(json.dumps({'save':True}).encode()+b'\\n');s.recv(100)\"",
        6,
      ).catch(() => {}),
      // Unreferenced and cleared either way: the loser of a race is not
      // cancelled, and a stray seven-second timer per stop is enough to keep a
      // process alive after everything it belonged to has finished.
      new Promise((r) => {
        timer = setTimeout(r, 7000);
        timer.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
export async function ensureTerminalComputer(job, guard = () => {}) {
  const alive = () => {
    assertDuckControl(job.duck_id, job.company_id);
    if (!one("SELECT 1 FROM jobs WHERE id=? AND status='running'", job.id))
      fail(409, "This run has stopped.");
    guard();
  };
  alive();
  await ensureComputer(
    job.company_id,
    job.user_id,
    job.duck_id,
    "Terminal command",
    alive,
    { desktopOnly: true, modelJob: job },
  );
  const found = one(
    "SELECT id FROM computers WHERE duck_id=? AND company_id=?",
    job.duck_id,
    job.company_id,
  );
  const c = found && row(found.id);
  if (!c || !readyStates.includes(c.state))
    fail(
      409,
      "The computer is still starting. Try the terminal again shortly.",
    );
  budget(c);
  await touch(c.id);
  alive();
  return c;
}

export async function importComputerFile(
  job,
  file,
  { request = asciiRequest } = {},
) {
  const initial = await ensureTerminalComputer(job);
  return lock("computer:" + initial.id, async () => {
    const alive = async () => {
      assertDuckControl(job.duck_id, job.company_id);
      if (!one("SELECT 1 FROM jobs WHERE id=? AND status='running'", job.id))
        fail(409, "This run has stopped.");
      authorize(job.company_id, job.user_id, job.duck_id);
      const current = row(initial.id);
      if (
        !current ||
        current.box_id !== initial.box_id ||
        !readyStates.includes(current.state)
      )
        fail(409, "The computer is not ready for this file.");
      budget(current);
      await touch(current.id);
    };
    await alive();
    const result = await transferComputerFile({
      request,
      boxId: initial.box_id,
      file,
      guard: alive,
    });
    return { computer_id: initial.id, ...result };
  });
}

export async function exportComputerFile(
  job,
  filePath,
  publisher,
  { request = asciiRequest } = {},
) {
  if (typeof publisher !== "function")
    fail(503, "Computer file export is unavailable right now.");
  const initial = await ensureTerminalComputer(job);
  return lock("computer:" + initial.id, async () => {
    const alive = async () => {
      assertDuckControl(job.duck_id, job.company_id);
      if (!one("SELECT 1 FROM jobs WHERE id=? AND status='running'", job.id))
        fail(409, "This run has stopped.");
      authorize(job.company_id, job.user_id, job.duck_id);
      const current = row(initial.id);
      if (
        !current ||
        current.box_id !== initial.box_id ||
        !readyStates.includes(current.state)
      )
        fail(409, "The computer is not ready to share this file.");
      budget(current);
      await touch(current.id);
    };
    await alive();
    const file = await readComputerFile({
      request,
      boxId: initial.box_id,
      filePath,
      guard: alive,
    });
    file.computer_id = initial.id;
    file.source_box_id = initial.box_id;
    const published = await publisher(job, file, alive);
    return {
      computer_id: initial.id,
      output_directory: file.output_directory,
      ...published,
    };
  });
}

// Folder actions use the same bound computer and command lock as file exports.
// A cached folder from an old provider box must never target a replacement box.
export async function outputFolderOperation(
  context,
  operation,
  args,
  { request = asciiRequest, guard = () => {}, commit } = {},
) {
  const alive = () => {
    authorize(context.company_id, context.user_id, context.duck_id);
    assertDuckControl(context.duck_id, context.company_id);
    const duck = tenant("ducks", context.duck_id, context.company_id);
    if (duck.removed) fail(409, "This duck is no longer on the team.");
    if (context.id) {
      if (
        !one(
          "SELECT 1 FROM jobs WHERE id=? AND company_id=? AND duck_id=? AND user_id=? AND status='running'",
          context.id,
          context.company_id,
          context.duck_id,
          context.user_id,
        )
      )
        fail(409, "This run has stopped.");
    } else if (
      one(
        "SELECT 1 FROM jobs WHERE company_id=? AND duck_id=? AND status IN ('running','waiting_human')",
        context.company_id,
        context.duck_id,
      )
    ) {
      fail(
        409,
        "This duck is working. Try organizing its folders when it has finished.",
      );
    }
    guard();
  };
  alive();
  const prior = one(
    "SELECT * FROM computers WHERE company_id=? AND duck_id=?",
    context.company_id,
    context.duck_id,
  );
  if (
    (args.computer_id && prior?.id !== args.computer_id) ||
    (args.source_box_id && prior?.box_id !== args.source_box_id)
  )
    fail(
      409,
      "This folder belongs to a previous computer. Its saved files remain available.",
    );
  if (context.id) await ensureTerminalComputer(context, alive);
  else
    await ensureComputer(
      context.company_id,
      context.user_id,
      context.duck_id,
      "Organize published folders",
      alive,
      { desktopOnly: true },
    );
  const found = one(
    "SELECT * FROM computers WHERE company_id=? AND duck_id=?",
    context.company_id,
    context.duck_id,
  );
  if (!found || !readyStates.includes(found.state))
    fail(409, "The computer is still starting. Try again shortly.");
  return lock("computer:" + found.id, async () => {
    const bound = () => {
      alive();
      const current = row(found.id);
      if (
        !current ||
        current.box_id !== found.box_id ||
        !readyStates.includes(current.state) ||
        (args.computer_id && current.id !== args.computer_id) ||
        (args.source_box_id && current.box_id !== args.source_box_id)
      )
        fail(
          409,
          "The computer changed while its folders were being organized.",
        );
      budget(current);
    };
    bound();
    await touch(found.id);
    const result =
      operation === "scan"
        ? await scanComputerOutputTree({
            request,
            boxId: found.box_id,
            guard: bound,
          })
        : await mutateComputerOutputFolder({
            request,
            boxId: found.box_id,
            operation,
            path: args.path,
            target: args.target,
            guard: bound,
          });
    bound();
    const boundResult = {
      ...result,
      computer_id: found.id,
      source_box_id: found.box_id,
    };
    if (commit) await commit(boundResult, bound);
    return boundResult;
  });
}

export async function pauseComputer(
  cid,
  company,
  user,
  { automatic = false, reason = null, kind = null } = {},
) {
  const c = tenant("computers", cid, company);
  if (!automatic) authorize(company, user, c.duck_id, { start: false });
  // Stopping releases capacity and must not wait for another computer to bootstrap.
  return lock("computer:" + cid, async () => {
    let latest = await sync(cid);
    if (latest.state === "archived" || !latest.box_id)
      return { state: latest.state };
    if (latest.state === "archiving") return { state: "archiving" };
    // Stopping must reach the provider promptly. A final screenshot is
    // optional and can spend up to the driver timeout before /stop runs;
    // retain the last saved frame instead.
    update(cid, {
      state: "archiving",
      viewer_until: 0,
      bootstrapped: 0,
      error: null,
      // Somebody who pressed Stop themselves knows perfectly well why it
      // stopped; only a machine that stopped on its own has to explain itself.
      stopped_reason: reason,
    });
    await disableComputerProxy(latest, executeProxyGuest);
    await saveOpenPages(latest);
    try {
      await asciiRequest("/boxes/" + latest.box_id + "/stop", "POST", {});
    } catch (e) {
      // A refused stop used to leave the computer saying "Saving & stopping"
      // with nothing that worked: starting was disabled, stopping again
      // returned the same state without doing anything, and no error was shown.
      // Put it back where it was and say what happened, so it can be tried
      // again.
      update(cid, { state: latest.state, error: shownError(e, "stop") });
      emit(company);
      throw e;
    }
    pendingNavigation.delete(cid);
    pageWindow.delete(cid);
    addressBarIntent.delete(cid);
    releaseHeldScreen(latest);
    audit(
      company,
      user,
      automatic
        ? "Idle computer saving and stopping"
        : "Computer saving and stopping",
      tenant("ducks", c.duck_id, company).name,
    );
    computerEvent(c, kind || "stopped", { user });
    return { state: "archiving", checkpoint: latest.checkpoint };
  });
}
export async function computerTool(job, tool, args, callId) {
  const alive = () => {
    assertDuckControl(job.duck_id, job.company_id);
    if (!one("SELECT 1 FROM jobs WHERE id=? AND status='running'", job.id))
      fail(409, "This run has stopped.");
  };
  alive();
  if (tool === "computer_proxy") {
    const a = z
      .object({ action: z.enum(["enable", "disable", "status"]) })
      .strict()
      .parse(args);
    authorize(job.company_id, job.user_id, job.duck_id, {
      start: a.action === "enable",
    });
    let c = one(
      "SELECT * FROM computers WHERE company_id=? AND duck_id=?",
      job.company_id,
      job.duck_id,
    );
    if (a.action === "status")
      return {
        ...(c
          ? computerProxyStatus(job.company_id, c.id)
          : computerProxyStatus(job.company_id)),
        allowed: duckProxyAllowed(job.company_id, job.duck_id),
      };
    if (a.action === "enable") {
      if (!duckProxyAllowed(job.company_id, job.duck_id))
        fail(403, "Proxy access is off for this duck.");
      readProxyConfig(job.company_id, { required: true });
      c = await ensureTerminalComputer(job, alive);
      return lock("computer:" + c.id, async () => {
        alive();
        if (!duckProxyAllowed(job.company_id, job.duck_id))
          fail(403, "Proxy access is off for this duck.");
        const ready = await sync(c.id);
        if (!readyStates.includes(ready.state))
          fail(409, "The computer is not ready to use the proxy.");
        return enableComputerProxy(job, ready, executeProxyGuest);
      });
    }
    if (!c) return computerProxyStatus(job.company_id);
    return lock("computer:" + c.id, async () => {
      alive();
      const current = await sync(c.id).catch(() => c);
      return disableComputerProxy(current, executeProxyGuest);
    });
  }
  authorize(job.company_id, job.user_id, job.duck_id);
  if (tool === "computer_start") {
    const a = z
      .object({ reason: z.string().trim().min(1).max(500) })
      .parse(args);
    return ensureComputer(
      job.company_id,
      job.user_id,
      job.duck_id,
      a.reason,
      alive,
      { modelJob: job },
    );
  }
  let c = one(
    "SELECT * FROM computers WHERE company_id=? AND duck_id=?",
    job.company_id,
    job.duck_id,
  );
  if (tool === "computer_terminal") {
    c = await ensureTerminalComputer(job, alive);
  } else if (!c)
    fail(409, "Start your computer with computer_start when you need it.");
  const priorPending = pendingNavigation.get(c.id);
  if (
    priorPending &&
    !one(
      "SELECT 1 FROM jobs WHERE id=? AND status='running'",
      priorPending.jobId,
    )
  )
    pendingNavigation.delete(c.id);
  const priorPageWindow = pageWindow.get(c.id);
  if (
    priorPageWindow &&
    !one(
      "SELECT 1 FROM jobs WHERE id=? AND status='running'",
      priorPageWindow.jobId,
    )
  )
    pageWindow.delete(c.id);
  const priorIntent = addressBarIntent.get(c.id);
  if (
    priorIntent &&
    !one(
      "SELECT 1 FROM jobs WHERE id=? AND status='running'",
      priorIntent.jobId,
    )
  )
    addressBarIntent.delete(c.id);
  if (tool === "computer_screenshot") {
    const a = z
      .object({
        caption: z.string().min(1).max(200),
        diagnostic: z.boolean().optional(),
        region: z
          .object({
            x: z.number().int().min(0).max(16000),
            y: z.number().int().min(0).max(16000),
            width: z.number().int().min(1).max(16000),
            height: z.number().int().min(1).max(16000),
          })
          .nullable()
          .optional(),
      })
      .parse(args);
    return lock("computer:" + c.id, async () => {
      alive();
      authorize(job.company_id, job.user_id, job.duck_id);
      const latest = row(c.id);
      if (!readyStates.includes(latest.state) || !latest.bootstrapped)
        fail(
          409,
          "Start or resume your computer before capturing the desktop.",
        );
      const visibleJob = consultationVisibleJob(job);
      conversationFor(visibleJob.conversation_id, job.company_id, job.user_id);
      if (!screenshotAllowed(latest.id))
        fail(
          409,
          "A person is using this computer. Try again when they release it.",
        );
      const pending = pendingNavigation.get(c.id);
      let unverified = null;
      if (pending) {
        const observation = await observeNavigation(c.id, pending, () => {
          alive();
          authorize(job.company_id, job.user_id, job.duck_id);
          conversationFor(
            visibleJob.conversation_id,
            job.company_id,
            job.user_id,
          );
        });
        if (observation.status !== "observed") {
          const feedback = openPageObservationFeedback(
            observation,
            pending.input,
          );
          if (!a.diagnostic)
            fail(
              409,
              "The requested page has not been observed yet. No screenshot was shared: the screen may still show the previous page. Inspect the current screen before continuing; do not blindly repeat navigation. Set diagnostic=true to share the current screen with an unverified-page label." +
                feedback.text,
            );
          unverified = { ...pendingPage(pending), ...feedback.state };
        }
      }
      const exactWindow = pageWindow.get(c.id)?.jobId === job.id;
      const captured = await captureForJob(latest.id, job.id);
      alive();
      authorize(job.company_id, job.user_id, job.duck_id);
      conversationFor(visibleJob.conversation_id, job.company_id, job.user_id);
      if (!captured || captured.isError || computerOutcome(captured).failed)
        fail(
          502,
          exactWindow
            ? "The browser window could not be captured."
            : "The desktop could not be captured.",
        );
      if (!screenshotAllowed(latest.id))
        fail(
          409,
          "A person is using this computer. Try again when they release it.",
        );
      const image = captured.content?.find(
        (item) =>
          item.type === "image" && typeof item.data === "string" && item.data,
      );
      if (!image)
        fail(
          502,
          exactWindow
            ? "The browser window could not be captured."
            : "The desktop could not be captured.",
        );
      const capturedAt = exactWindow
        ? now()
        : row(latest.id).screenshot_at || now();
      let savedImage = image.data;
      let savedMime = image.mimeType || "image/jpeg";
      if (a.region) {
        const crop = spawnSync(
          "/usr/bin/python3",
          [
            "-c",
            "from PIL import Image; import io,sys,json; r=json.loads(sys.argv[1]); im=Image.open(io.BytesIO(sys.stdin.buffer.read())); x,y,w,h=[r[k] for k in ['x','y','width','height']]; assert x+w<=im.width and y+h<=im.height; im.crop((x,y,x+w,y+h)).convert('RGB').save(sys.stdout.buffer,format='JPEG',quality=85)",
            JSON.stringify(a.region),
          ],
          {
            input: Buffer.from(savedImage, "base64"),
            timeout: 4000,
            maxBuffer: 8000000,
            env: { PATH: "/usr/bin:/bin" },
          },
        );
        if (crop.status !== 0)
          fail(
            400,
            "The crop must fit inside the captured screen. Use its original pixel coordinates.",
          );
        savedImage = crop.stdout.toString("base64");
        savedMime = "image/jpeg";
      }
      const picture = encrypt(savedImage);
      if (picture.length > 4000000)
        fail(413, "The screenshot is too large to share.");
      // Nothing in the product can delete a saved screenshot, so refusing at the
      // cap turned the duck's ability to show anyone what it sees off for good,
      // once, for that company. The oldest give way to the newest instead.
      for (const old of all(
        "SELECT id FROM computer_captures WHERE company_id=? ORDER BY created DESC LIMIT -1 OFFSET 499",
        job.company_id,
      )) {
        // The picture goes; the fact that the duck took one stays. Deleting the
        // artifact too removed every trace from the message that referred to it,
        // so an old reply that had shown a screenshot silently became a duck
        // claiming it had taken one and showing nothing - and where the link was
        // in the text instead, a broken image over raw JSON. A deleted upload
        // already keeps its artifact so the message can say the file is gone
        // (server/chat-store.mjs); screenshots skipped that.
        run("DELETE FROM computer_captures WHERE id=?", old.id);
      }
      const captureId = id();
      const caption = unverified
        ? "Page opening could not be verified"
        : a.caption;
      run(
        "INSERT INTO computer_captures VALUES(?,?,?,?,?,?,?)",
        captureId,
        job.company_id,
        visibleJob.conversation_id,
        c.id,
        caption,
        picture,
        capturedAt,
      );
      attachArtifact(
        job.company_id,
        job.output_message_id,
        "screenshot",
        captureId,
        caption,
        "Captured",
      );
      if (!unverified) pendingNavigation.delete(c.id);
      const url = "/api/computer-captures/" + captureId;
      observeDeliveredImage(
        c.id,
        job.id,
        { content: [image], structuredContent: captured.structuredContent },
        {
          tool: exactWindow ? "get_window_state" : "get_desktop_state",
          target: exactWindow
            ? captured.structuredContent?.native_input_target
            : { scope: "desktop" },
          cropped: !!a.region,
        },
      );
      const metadata = {
        url,
        captured_at: capturedAt,
        markdown: "![" + caption.replace(/[\[\]\n]/g, " ") + "](" + url + ")",
        capture_scope: exactWindow ? "window" : "desktop",
        ...(exactWindow
          ? {
              native_input_target:
                captured.structuredContent?.native_input_target,
              capture_instruction: captured.content?.find(
                (item) =>
                  item.type === "text" &&
                  item.text?.startsWith("This native screenshot is "),
              )?.text,
            }
          : {}),
        ...(unverified
          ? {
              navigation_observation: "pending",
              ...unverified,
              warning:
                "This screenshot shows the current " +
                (exactWindow ? "browser window" : "desktop") +
                ", which may still be the previous page. It does not verify the requested destination. Describe only what is visible.",
            }
          : {}),
        instruction:
          "Inspect the returned saved image before describing or linking it. Confirm it supports your caption; otherwise explain what is actually visible. Include this Markdown in your reply only when you choose to show this saved screenshot. The image is private to conversation participants and will not change with future captures.",
      };
      return {
        ...metadata,
        _contentItems: [
          {
            type: "inputImage",
            imageUrl: "data:" + savedMime + ";base64," + savedImage,
          },
          { type: "inputText", text: JSON.stringify(metadata) },
        ],
      };
    });
  }
  // Saying you are finished, which is worth having: the checkpoint written at
  // that moment is the note a person reads when they come back to the machine.
  //
  // What it no longer does is stop the computer. The reason it gave for that
  // was idle charges, and an idle machine already stops itself - so the saving
  // was one the housekeeping round was going to make anyway, while the cost was
  // real: everything running thrown away at a moment the duck chose, and a
  // minute and a half to get the machine back if the run turned out not to be
  // finished after all.
  //
  // Deliberately does not touch the computer. Touching it would restart the
  // idle clock, so a duck saying it had finished would keep the machine alive
  // a whole idle window longer than saying nothing at all.
  if (tool === "computer_pause") {
    const a = z.object({ checkpoint: z.string().min(1).max(6000) }).parse(args);
    update(c.id, checkpointUpdate(job, a.checkpoint));
    return {
      computer_id: c.id,
      checkpoint: a.checkpoint,
      state: row(c.id).state,
      message:
        "Checkpoint saved. Your computer is left as it is and stops itself once nothing has happened on it for " +
        Math.round(idleMs / 60000) +
        " minutes. Files and open pages come back when it starts again.",
    };
  }
  if (tool === "computer_tools") {
    const a = z.object({ tool: z.string().max(100) }).parse(args);
    if (a.tool) {
      const s = schemaMap.get(a.tool);
      if (!s) fail(400, notADesktopControl(a.tool));
      return s;
    }
    return {
      tools: schemas
        .filter((t) => t.name !== "browser_navigate")
        .map((t) => ({
          name: t.name,
          description: t.description.split("\n")[0],
        })),
      instructions: "Pass a control name as tool to read its input schema.",
    };
  }
  if (tool === "computer_terminal") {
    const a = z
      .object({
        command: z.string().min(1).max(32000),
        timeout_seconds: z.number().int().min(1).max(60),
        checkpoint: z.string().min(1).max(6000),
      })
      .parse(args);
    // Two phases, because a command no longer finishes inside this call.
    //
    // The lock is what guarantees one operation at a time on a machine, and a
    // person taking the screen waits on it. While a command blocked inside it
    // for up to a minute, that person waited a minute, and the preview they
    // were coming to look at was skipped for the whole of it. So the lock now
    // covers starting the command - every guard, the checkpoint, and the row
    // that makes this at-most-once - and is released while the output is read
    // back.
    const op = job.id + ":" + callId;
    const latest = await lock("computer:" + c.id, async () => {
      alive();
      authorize(job.company_id, job.user_id, job.duck_id);
      const ready = await sync(c.id);
      if (!readyStates.includes(ready.state))
        fail(409, "Start or resume your computer before running commands.");
      budget(ready);
      await touch(c.id);
      alive();
      update(c.id, checkpointUpdate(job, a.checkpoint));
      if (one("SELECT 1 FROM computer_actions WHERE id=?", op))
        fail(
          409,
          "This command was already attempted. Inspect its saved result before issuing another command.",
        );
      // The command as typed: its receipt keeps only the result. It can carry
      // a secret the duck was given, so whatever shows it must mask it.
      run(
        "INSERT INTO computer_actions(id,computer_id,job_id,user_id,tool,checkpoint,state,created,command) VALUES(?,?,?,?,?,?,?,?,?)",
        op,
        c.id,
        job.id,
        job.user_id,
        "terminal",
        a.checkpoint,
        "executing",
        now(),
        a.command,
      );
      return ready;
    });
    {
      try {
        // Started in the background and read back as it runs, so a person can
        // watch the output arrive instead of waiting for all of it. What comes
        // back is the same shape the one blocking call used to return.
        // The command is stored and shown with its {{secret:name}} still in it;
        // only what leaves for the box has the value in it. The duck never saw
        // it, the journal never holds it, and the panel shows the placeholder.
        const { text: toRun } = fillSecrets(
          job.company_id,
          job.duck_id,
          a.command,
          job.id,
        );
        const result = await runStreaming(
          {
            op,
            command: toRun,
            timeoutSeconds: a.timeout_seconds,
            companyId: job.company_id,
          },
          {
            send: (command, timeoutSeconds) =>
              asciiRequest(
                "/boxes/" + encodeURIComponent(latest.box_id) + "/commands",
                "POST",
                { command, timeoutSeconds },
                { timeout: (timeoutSeconds + 7) * 1000 },
              ),
            alive,
            // The lock is released while this runs, so the machine's own
            // bookkeeping is kept up by hand: this is what stops the reaper and
            // the preview treating a long command as an idle box.
            onPoll: () => touch(c.id),
          },
        );
        const uncertain = !!result.timedOut || result.exitCode == null;
        run(
          "UPDATE computer_actions SET state=? WHERE id=?",
          uncertain ? "unknown" : result.success ? "done" : "failed",
          op,
        );
        audit(job.company_id, job.user_id, "Duck used computer terminal", {
          duck: tenant("ducks", job.duck_id, job.company_id).name,
        });
        return {
          computer_id: c.id,
          receipt_id: op,
          exit_code: result.exitCode ?? null,
          stdout: String(result.stdout || "").slice(0, 20000),
          stderr: String(result.stderr || "").slice(0, 10000),
          timed_out: !!result.timedOut,
          output_truncated:
            !!result.stdoutTruncated ||
            String(result.stdout || "").length > 20000 ||
            String(result.stderr || "").length > 10000,
          ...(uncertain
            ? {
                instruction:
                  "Command outcome is uncertain. Inspect files/processes before considering another command; do not repeat it blindly.",
              }
            : {}),
        };
      } catch (error) {
        run("UPDATE computer_actions SET state='unknown' WHERE id=?", op);
        throw error;
      }
    }
  }
  if (tool === "computer_action")
    return lock("computer:" + c.id, async () => {
      alive();
      authorize(job.company_id, job.user_id, job.duck_id);
      const a = z
        .object({
          tool: z.string().max(100),
          arguments: z.record(z.string(), z.unknown()),
          checkpoint: z.string().min(1).max(6000),
        })
        .parse(args);
      if (!schemaMap.has(a.tool)) fail(400, notADesktopControl(a.tool));
      if (Buffer.byteLength(JSON.stringify(a.arguments)) > 32000)
        fail(400, "Computer input is too large.");
      const latest = await sync(c.id);
      if (!readyStates.includes(latest.state))
        fail(
          409,
          "Your computer is stopped or starting. Call computer_start to resume the same workspace.",
        );
      if (!latest.bootstrapped)
        fail(
          409,
          "Your desktop controls are still starting. Call computer_start to check readiness.",
        );
      budget(latest);
      await touch(c.id);
      alive();
      update(c.id, checkpointUpdate(job, a.checkpoint));
      const op = job.id + ":" + callId;
      if (one("SELECT 1 FROM computer_actions WHERE id=?", op))
        fail(
          409,
          "This action was already attempted. Inspect the desktop before issuing a new action.",
        );
      // Only actual typing controls may receive credential values. Keep the
      // original tool arguments and checkpoint as placeholders in the run.
      const input = duckDesktopInput(
        a.tool,
        a.arguments,
        schemaMap.get(a.tool),
      );
      const typing = a.tool === "type_text";
      const hasReference = (value) =>
        typeof value === "string"
          ? mentionsSecret(value)
          : Array.isArray(value)
            ? value.some(hasReference)
            : value && typeof value === "object"
              ? Object.values(value).some(hasReference)
              : false;
      if (
        Object.entries(input).some(
          ([key, value]) =>
            hasReference(key) ||
            (hasReference(value) && !(typing && key === "text")),
        )
      )
        fail(
          400,
          "Secret references can only be used in text typed with type_text.",
        );
      const secretInput = typing && hasReference(input.text);
      if (secretInput) {
        if (typeof input.text !== "string")
          fail(400, "Text to type must be a string.");
        input.text = fillSecrets(
          job.company_id,
          job.duck_id,
          input.text,
          job.id,
        ).text;
      }
      if (
        a.tool === "open_page" &&
        (!Number.isSafeInteger(input.pid) ||
          input.pid <= 0 ||
          !Number.isSafeInteger(input.window_id) ||
          input.window_id <= 0 ||
          !isPageUrl(input.url))
      )
        fail(
          400,
          "Opening a page requires one exact window and an HTTP or HTTPS URL without credentials.",
        );
      const frameRefusal = cursorInputFrameRefusal(c.id, job.id, a.tool, input);
      if (frameRefusal) {
        if (nativeFocusTargeted(a.tool, input))
          markNativeFocusRefused(c.id, job.id);
        fail(409, frameRefusal);
      }
      const focusGuard = nativeFocusGuardMessage(c.id, job.id);
      if (
        focusGuard &&
        a.tool === "type_text" &&
        !nativeFocusTargeted(a.tool, input)
      )
        fail(409, focusGuard);
      run(
        "INSERT INTO computer_actions(id,computer_id,job_id,user_id,tool,checkpoint,state,created) VALUES(?,?,?,?,?,?,?,?)",
        op,
        c.id,
        job.id,
        job.user_id,
        a.tool,
        a.checkpoint,
        "executing",
        now(),
      );
      try {
        delete input.screenshot_out_file;
        const prop = schemaMap.get(a.tool).inputSchema.properties || {};
        if (prop.session) input.session = "td-" + c.id;
        if (
          a.tool === "launch_app" &&
          /chrom(e|ium)/i.test(String(input.launch_path || input.name || ""))
        ) {
          const extra = (input.additional_arguments || []).filter(
            (v) => !String(v).startsWith("--user-data-dir"),
          );
          input.additional_arguments = [
            ...extra,
            "--user-data-dir=__TAMEDUCK_PROFILE__",
            "--restore-last-session",
          ];
        }
        const navigationGuard = () => {
          alive();
          authorize(job.company_id, job.user_id, job.duck_id);
        };
        const priorNavigation = pendingNavigation.get(c.id);
        const intent = addressBarIntent.get(c.id);
        const currentIntent = intent?.jobId === job.id ? intent : null;
        const legacyUrl =
          a.tool === "type_text" && currentIntent?.phase === "focused"
            ? isPageUrl(input.text)
            : null;
        const legacyEnter =
          isEnter(a.tool, input) && currentIntent?.phase === "typed";
        if (a.tool === "open_page") {
          pendingNavigation.set(c.id, {
            kind: "native",
            input: { ...input },
            baseline: null,
            observedUrl: null,
            navigationSent: false,
            jobId: job.id,
          });
          pageWindow.set(c.id, {
            pid: input.pid,
            window_id: input.window_id,
            jobId: job.id,
          });
          addressBarIntent.delete(c.id);
        } else if (legacyUrl) {
          pendingNavigation.set(c.id, {
            kind: "legacy",
            input: {
              pid: currentIntent.pid,
              window_id: currentIntent.window_id,
              session: input.session,
              url: legacyUrl,
            },
            baseline: null,
            observedUrl: null,
            navigationSent: false,
            jobId: job.id,
          });
        }
        if (a.tool === "browser_navigate") {
          pageWindow.delete(c.id);
          navigationGuard();
          const baseline = await driver(c.id, "get_browser_state", {
            target_id: input.target_id,
            tab_id: input.tab_id,
            session: input.session,
            snapshot_format: "semantic_v2",
          });
          navigationGuard();
          pendingNavigation.set(c.id, {
            kind: "browser",
            input: { ...input },
            baseline,
            jobId: job.id,
          });
        }
        let r = await driver(c.id, a.tool, input, a.checkpoint, {
          retry: !secretInput && a.tool !== "open_page",
          trajectory: true,
          guard: navigationGuard,
        });
        if (a.tool === "get_browser_state") {
          const pending = pendingNavigation.get(c.id);
          if (
            pending?.kind === "native" &&
            pending.jobId === job.id &&
            pending.navigationSent &&
            pending.observedUrl &&
            input.pid === pending.input.pid &&
            input.window_id === pending.input.window_id
          ) {
            navigationGuard();
            const tab = boundTabForNativeAddress(r, pending.observedUrl);
            if (tab) {
              pending.input = { ...pending.input, ...tab };
              const observed = await observeNavigation(
                c.id,
                pending,
                navigationGuard,
              );
              navigationGuard();
              if (observed.status === "observed")
                pendingNavigation.delete(c.id);
              r = {
                ...r,
                structuredContent: {
                  ...r.structuredContent,
                  navigation_observation:
                    observed.status === "observed" ? "observed" : "pending",
                },
              };
            }
          }
        }
        if (a.tool === "open_page") {
          const state = r.structuredContent || {};
          const attempt = pendingNavigation.get(c.id);
          const dispatched = state.navigation_sent === true;
          attempt.navigationSent = dispatched;
          attempt.observedUrl = isPageUrl(state.observed_url);
          attempt.baseline = state.previous_url
            ? { structuredContent: { page: { url: state.previous_url } } }
            : null;
          let observed = { status: "pending", reason: "not_sent" };
          if (attempt.navigationSent)
            observed = await observeNavigation(c.id, attempt, navigationGuard);
          navigationGuard();
          let screen = null;
          try {
            screen = await captureForJob(c.id, job.id);
          } catch {
            /* Keep the dispatch receipt. */
          }
          navigationGuard();
          if (
            screen &&
            (computerOutcome(screen).failed ||
              !screen.content?.some((item) => item.type === "image"))
          )
            screen = null;
          if (observed.status === "observed" && screen)
            pendingNavigation.delete(c.id);
          const verified = observed.status === "observed" && !!screen;
          const feedback = verified
            ? null
            : openPageObservationFeedback(observed, input);
          r = {
            ...r,
            content: [
              ...(r.content || []).filter((item) => item.type !== "image"),
              {
                type: "text",
                text: verified
                  ? "The exact tab has observable page content. Inspect this fresh image of the exact browser window before describing it; loading or verification may still continue."
                  : "Page opening is not visually verified. This image of the exact browser window may still show the previous page. Inspect it before continuing; do not label it as the requested destination or blindly repeat input." +
                    feedback.text,
              },
              ...(screen?.content || []),
            ],
            structuredContent: {
              ...state,
              effect: state.effect,
              navigation_observation: verified ? "observed" : "pending",
              requested_url: input.url,
              observed_url: attempt.observedUrl,
              address_entered: state.address_entered === true,
              navigation_sent: dispatched,
              ...(feedback ? feedback.state : {}),
              ...(screen
                ? {
                    native_input_target: {
                      scope: "window",
                      pid: input.pid,
                      window_id: input.window_id,
                    },
                  }
                : {}),
            },
          };
        }
        if (a.tool === "browser_navigate") {
          if (computerOutcome(r).failed) {
            // A proven refusal leaves the previous navigation untouched. An
            // uncertain failure may have navigated, so keep the new guard.
            if (computerOutcome(r).status === "refused") {
              if (priorNavigation) pendingNavigation.set(c.id, priorNavigation);
              else pendingNavigation.delete(c.id);
            }
          } else {
            const observed = await observeNavigation(
              c.id,
              pendingNavigation.get(c.id),
              navigationGuard,
            );
            let screen = null;
            if (observed.status === "observed") {
              navigationGuard();
              screen = await capture(c.id);
              navigationGuard();
              if (
                !screen ||
                computerOutcome(screen).failed ||
                !screen.content?.some((i) => i.type === "image")
              )
                screen = null;
              if (screen) pendingNavigation.delete(c.id);
            }
            r = {
              ...r,
              content: [
                {
                  type: "text",
                  text: screen
                    ? "The navigated tab has observable page content. Inspect this fresh native desktop image before interacting or describing the page. This is not proof that loading, verification, or your task has finished."
                    : "Navigation was sent, but the new page has not been visually established. The desktop may still show the previous page. Inspect again before interacting or describing the destination; do not blindly repeat navigation.",
                },
                ...(screen?.content || []),
              ],
              structuredContent: {
                ...r.structuredContent,
                effect: "sent",
                navigation_observation: screen ? "observed" : "pending",
                ...(screen
                  ? { native_input_target: { scope: "desktop" } }
                  : {}),
              },
            };
          }
        }
        if (isAddressHotkey(a.tool, input)) {
          if (!computerOutcome(r).failed)
            addressBarIntent.set(c.id, {
              phase: "focused",
              pid: input.pid,
              window_id: input.window_id,
              jobId: job.id,
            });
          else addressBarIntent.delete(c.id);
        } else if (legacyUrl) {
          if (computerOutcome(r).status === "refused") {
            addressBarIntent.delete(c.id);
          } else
            addressBarIntent.set(c.id, { ...currentIntent, phase: "typed" });
        } else if (legacyEnter) {
          addressBarIntent.delete(c.id);
          const pending = pendingNavigation.get(c.id);
          if (
            pending?.kind === "legacy" &&
            computerOutcome(r).status !== "refused"
          ) {
            pending.navigationSent = true;
          }
        } else if (nativeInputTools.has(a.tool)) {
          addressBarIntent.delete(c.id);
        }
        // Native input can change the page without producing a trustworthy
        // provider-side confirmation. Capture in the same coordinate frame as
        // the input while the computer lock is held. Secret typing stays
        // masked and must never trigger a capture.
        if (
          nativeInputTools.has(a.tool) &&
          !secretInput &&
          !computerOutcome(r).failed
        ) {
          navigationGuard();
          const feedbackTarget = nativeFeedbackTarget(input);
          let fresh = null;
          try {
            fresh =
              feedbackTarget?.kind === "window"
                ? await capturePageWindow(c.id, feedbackTarget)
                : feedbackTarget?.kind === "desktop"
                  ? await capture(c.id)
                  : null;
          } catch {
            // A successful input remains successful when observation is
            // unavailable; the result still carries its original outcome.
          }
          navigationGuard();
          const originalContent = (r.content || []).filter(
            (item) => item.type !== "image",
          );
          if (
            fresh &&
            !computerOutcome(fresh).failed &&
            fresh.content?.some((item) => item.type === "image")
          ) {
            r = {
              ...r,
              content: [
                ...originalContent,
                {
                  type: "text",
                  text: pendingNavigation.get(c.id)
                    ? `Fresh ${feedbackTarget.kind === "window" ? "window" : "desktop"} state captured, but the requested page is not verified. This image may show the previous page; inspect it without labeling it as the destination.`
                    : `Fresh ${feedbackTarget.kind === "window" ? "window" : "desktop"} state captured immediately after native input. Inspect it before continuing.`,
                },
                ...fresh.content.filter(
                  (item) => item.type === "image" || item.type === "text",
                ),
              ],
              structuredContent: {
                ...r.structuredContent,
                native_observation: "fresh",
                ...(pendingNavigation.get(c.id)
                  ? { navigation_observation: "pending" }
                  : {}),
                native_input_target:
                  feedbackTarget.kind === "window"
                    ? {
                        scope: "window",
                        pid: feedbackTarget.pid,
                        window_id: feedbackTarget.window_id,
                      }
                    : { scope: "desktop" },
              },
            };
          } else {
            r = {
              ...r,
              content: [
                ...originalContent,
                {
                  type: "text",
                  text: "Fresh observation in the input's coordinate frame was unavailable after native input. Inspect current state before continuing; do not blindly repeat the action.",
                },
              ],
              structuredContent: {
                ...r.structuredContent,
                native_observation: "unavailable",
              },
            };
          }
        }
        const outcome = computerOutcome(r);
        if (nativeFocusTargeted(a.tool, input)) {
          if (outcome.status === "refused")
            markNativeFocusRefused(c.id, job.id);
          else if (!outcome.failed) clearNativeFocusGuard(c.id, job.id);
        }
        if (!secretInput)
          observeDeliveredImage(c.id, job.id, r, { tool: a.tool });
        // A provider may reject a control in structuredContent without setting
        // MCP isError. Dispatch success is not proof that a page changed.
        alive();
        run(
          "UPDATE computer_actions SET state=? WHERE id=?",
          outcome.failed
            ? "failed"
            : r.structuredContent?.effect && outcome.inspectRequired
              ? "unknown"
              : "done",
          op,
        );
        audit(job.company_id, job.user_id, "Duck used computer", {
          duck: tenant("ducks", job.duck_id, job.company_id).name,
          tool: a.tool,
        });
        return {
          _contentItems: secretInput
            ? [
                {
                  type: "inputText",
                  text: outcome.failed
                    ? "The computer refused the typing action. Inspect the screen before trying again."
                    : "Text was sent to the computer. Inspect the screen to confirm the result.",
                },
              ]
            : [
                ...computerContentItems(r),
                ...(r.structuredContent?.effect || outcome.failed
                  ? [
                      {
                        type: "inputText",
                        text:
                          "Computer outcome: " +
                          outcome.status +
                          ". " +
                          (outcome.inspectRequired
                            ? "Inspect fresh state to confirm the result. Never blindly repeat an uncertain input."
                            : "The provider confirmed the effect."),
                      },
                    ]
                  : []),
              ],
          _success: !outcome.failed,
          _outcome: secretInput ? undefined : outcome.status,
        };
      } catch (e) {
        run("UPDATE computer_actions SET state='unknown' WHERE id=?", op);
        update(c.id, {
          error:
            "The last action has an uncertain outcome. Inspect the screen before retrying.",
        });
        // A provider or driver error may echo its input. Never pass that
        // error to a model or journal after it has seen a credential value.
        if (secretInput)
          fail(
            502,
            "The typing action has an uncertain outcome. Inspect the screen before trying again.",
          );
        throw e;
      }
    });
  fail(400, "Unknown computer tool.");
}

// Duck settings saves the policy before this runs. Foreground enable uses the
// same lock and rechecks permission after each guest call, so a save made
// during activation cannot leave the route enabled.
export async function revokeDuckProxyForDucks(company, duckIds) {
  const denied = new Set(duckIds);
  const sessions = all(
    "SELECT computer_id,duck_id FROM computer_proxy_sessions WHERE company_id=? AND ended IS NULL",
    company,
  ).filter((session) => denied.has(session.duck_id));
  let uncertain = false;
  for (const session of sessions) {
    try {
      await lock("computer:" + session.computer_id, async () => {
        const computer = one(
          "SELECT * FROM computers WHERE id=? AND company_id=?",
          session.computer_id,
          company,
        );
        if (!computer) {
          uncertain = true;
          return;
        }
        if (duckProxyAllowed(company, session.duck_id)) return;
        const result = await disableComputerProxy(computer, executeProxyGuest);
        if (result.active) uncertain = true;
      });
    } catch {
      uncertain = true;
    }
  }
  return uncertain
    ? "Proxy shutdown could not be confirmed for every duck; it will be retried."
    : null;
}
export function registerComputers(app, { withoutAI = async () => null } = {}) {
  app.get("/api/computers", (req, res) => {
    can(req.member, "computers");
    res.json(computerSummary(req.company.id, req.session.token_hash));
  });
  app.put("/api/computers/settings", async (req, res) => {
    can(req.member, "company");
    can(req.member, "computers");
    const a = z
      .object({
        enabled: z.boolean(),
        // Every duck that may have a computer, in one list that replaces the
        // whole policy - so this cap is the size of a flock, not a page of
        // one. It said 25 while a company may have 50, which let somebody
        // tick every duck and then be unable to save.
        allowed_ducks: z.array(z.string().uuid()).max(DUCK_LIMIT),
      })
      .parse(req.body);
    // The dialog takes one snapshot of the policy when it opens and never
    // reloads it, and saving replaces the whole policy: every duck's access is
    // rewritten from the list sent, and any duck no longer on it has its
    // machine stopped. So the second of two people to press Save put the first
    // one's change back - including "Allow computers for this company", flipped
    // off to stop a duck misbehaving and flipped straight back on - and stopped
    // the machine of a duck that had just been granted access, mid-task, with
    // nobody told anything.
    const base = typeof req.body?.base === "string" ? req.body.base : null;
    if (base && base !== policyVersion(req.company.id))
      fail(
        409,
        "Someone else changed these controls while you had them open. Reopen them to see the current settings before saving.",
      );
    for (const d of a.allowed_ducks) tenant("ducks", d, req.company.id);
    db.transaction(() => {
      run(
        "INSERT INTO computer_settings(company_id,enabled) VALUES(?,?) ON CONFLICT(company_id) DO UPDATE SET enabled=excluded.enabled",
        req.company.id,
        +a.enabled,
      );
      // Store a choice for every current duck so turning one off is remembered;
      // ducks created later start with access.
      run(
        "DELETE FROM duck_computer_access WHERE company_id=?",
        req.company.id,
      );
      for (const d of all(
        "SELECT id FROM ducks WHERE company_id=?",
        req.company.id,
      ))
        run(
          "INSERT INTO duck_computer_access VALUES(?,?,?)",
          d.id,
          req.company.id,
          +a.allowed_ducks.includes(d.id),
        );
    })();
    const stopFailures = [];
    for (const c of all(
      "SELECT * FROM computers WHERE company_id=?",
      req.company.id,
    )) {
      if (
        (a.enabled && a.allowed_ducks.includes(c.duck_id)) ||
        !activeStates.includes(c.state)
      )
        continue;
      try {
        await pauseComputer(c.id, c.company_id, req.user.id, {
          automatic: true,
          ...(a.enabled
            ? {
                kind: "stopped_not_allowed",
                reason: notAllowedWhy(tenant("ducks", c.duck_id, c.company_id)),
              }
            : { kind: "stopped_off", reason: offWhy }),
        });
      } catch {
        // The policy was saved already. Try the remaining machines too and
        // report the partial result without claiming the setting failed.
        stopFailures.push(c.id);
      }
    }
    audit(req.company.id, req.user.id, "Computer policy updated");
    res.json({
      ok: true,
      ...(stopFailures.length
        ? {
            stop_failures: stopFailures,
            warning:
              "Computer controls saved. " +
              stopFailures.length +
              (stopFailures.length === 1
                ? " computer could"
                : " computers could") +
              " not be stopped. Open Computers and try Stop again.",
          }
        : {}),
    });
  });
  app.post("/api/computers/start", async (req, res) => {
    const a = z.object({ duck_id: z.string().uuid() }).parse(req.body);
    // With no AI no duck can work, so starting a computer only costs money.
    // One that is already up, or on its way up, is not a start - the same rule
    // taking a screen follows - so nobody is refused a machine that is running.
    const c = one(
      "SELECT state FROM computers WHERE duck_id=? AND company_id=?",
      a.duck_id,
      req.company.id,
    );
    if (!c || !activeStates.includes(c.state) || c.state === "archiving") {
      const why = await withoutAI(req);
      if (why) fail(409, why);
    }
    res.json(
      await ensureComputer(
        req.company.id,
        req.user.id,
        a.duck_id,
        "Started from the computer panel",
        () => {},
        { desktopOnly: true },
      ),
    );
  });
  app.post("/api/computers/:id/pause", async (req, res) => {
    res.json(await pauseComputer(req.params.id, req.company.id, req.user.id));
  });
  app.get("/api/computer-captures/:id", (req, res) => {
    const capture = one(
      "SELECT * FROM computer_captures WHERE id=? AND company_id=?",
      req.params.id,
      req.company.id,
    );
    if (!capture) fail(404, "Screenshot not found.");
    conversationFor(capture.conversation_id, req.company.id, req.user.id);
    res
      .set({
        "Content-Type": "image/jpeg",
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      })
      .send(Buffer.from(decrypt(capture.image), "base64"));
  });
  app.get("/api/computers/:id/screenshot", (req, res) => {
    can(req.member, "computers");
    const c = tenant("computers", req.params.id, req.company.id);
    const image = computerImage(c);
    if (!image) fail(404, "No screenshot captured yet.");
    // The Computers page asks for this about once a second so the card keeps up
    // with what the duck is doing. Almost every one of those asks is for a
    // picture the page already has, so answer those with a tag and nothing
    // else: a 304 costs a few bytes where the picture costs sixty kilobytes.
    // no-store would forbid even that, so it is no-cache - revalidate every
    // time, never serve a stale one blind.
    const tag =
      '"' +
      crypto
        .createHash("sha256")
        .update(c.screenshot_at || "none")
        .digest("hex")
        .slice(0, 16) +
      '"';
    res.set({
      "Content-Type": "image/jpeg",
      "Cache-Control": "private, no-cache",
      ETag: tag,
    });
    if (req.headers["if-none-match"] === tag) return res.status(304).end();
    res.send(image);
  });
  app.post("/api/computers/:id/desktop", (req, res) => {
    can(req.member, "computers");
    tenant("computers", req.params.id, req.company.id);
    res.json({
      url: "/w/" + req.company.id + "/computers/" + req.params.id + "/control",
    });
  });
  // One computer's day for its page, newest first. Never more than two days
  // back: the page asks for today, and "today" is the viewer's own.
  app.get("/api/computers/:id/history", (req, res) => {
    can(req.member, "computers");
    const c = tenant("computers", req.params.id, req.company.id);
    const floor = Date.now() - 48 * 3600000,
      asked = Date.parse(req.query?.since);
    res.json({
      events: computerHistory(
        c,
        new Date(
          Number.isFinite(asked) ? Math.max(asked, floor) : floor,
        ).toISOString(),
      ),
    });
  });
  app.post("/api/computers/:id/keep-awake", async (req, res) => {
    const c = tenant("computers", req.params.id, req.company.id);
    authorize(req.company.id, req.user.id, c.duck_id);
    if (!readyStates.includes(c.state))
      fail(409, "This computer is not running.");
    budget(c);
    await touch(c.id);
    update(c.id, { viewer_until: Date.now() + 5 * 60000 });
    res.json({ ok: true });
  });
}
// How stale a preview may get before it is retaken. Nobody is looking at most
// computers, so photographing them often is waste; the one a person has on
// screen is the one that has to keep up with the duck.
// A picture a second is not a stream, but it is close enough to watch a duck
// work: a capture takes about half a second against this provider, so asking
// for one a second keeps the loop busy without ever queueing. Only for a
// machine somebody is actually looking at; nobody is looking at most of them.
const watchedPreviewMs = +process.env.WATCHED_PREVIEW_MS || 1000;
// Whether there is anything on this screen worth photographing: a duck with a
// run going on this machine, or a person watching it. Anything else is a
// picture of a desktop nobody is looking at, of a machine nobody is using.
//
// It used to be the other way round - a picture a second while somebody
// watched, and one every twenty-five seconds for ever otherwise, for every
// computer that existed. So an idle machine was photographed all day and a duck
// working alone was photographed once every twenty-five seconds, which is the
// wrong way round from what anybody wants to see.
//
// `known` is for a caller that has already asked who holds it, what it waits on
// and whether a run is using it: the Computers page asks all three for every
// computer anyway, and asking twice made it slow on a busy workspace.
const worthPhotographing = (
  c,
  {
    hold = controlFor(c.id),
    request = requestForComputer(c.id),
    running = () => midRun(c.id),
  } = {},
) =>
  // Nobody is photographing a screen a person is holding - they may be typing a
  // password into it - nor one where a duck is stopped waiting for somebody,
  // because nothing on it is going to move until they arrive. Both were checked
  // by the rounds that take the pictures and not by this, which is what the
  // card is told: so a duck parked waiting for a person, on a page somebody had
  // open, was reported as being photographed every second while nothing was
  // photographing it at all. One answer now, for the rounds and for the screen.
  !hold && !request && (c.viewer_until > Date.now() || running());
// A card and the preview worker must agree about whether a fresh frame can be
// produced. A running provider box is not enough: until guest desktop controls
// have bootstrapped, capture() cannot make a picture and the card must say so.
// Undefined is accepted for the small pure helper fixtures that predate the
// persisted readiness field; real rows always carry bootstrapped.
export const captureEligible = (c, known) =>
  (c.bootstrapped === undefined ||
    (c.bootstrapped && readyStates.includes(c.state))) &&
  worthPhotographing(c, known);
// And due for one: only when it is in use and the last picture is older than a
// second. A duck's own desktop actions save the screen as they go, so this
// takes a picture only when a second has passed with nothing arriving - it
// fills the gaps rather than doubling up on them.
const photographDue = (c) =>
  captureEligible(c) &&
  (!c.screenshot_at ||
    Date.now() - Date.parse(c.screenshot_at) > watchedPreviewMs);
// A duck that is mid-run and has already used this computer is not idle, it is
// thinking. A few minutes is nothing: a duck reads a screen, decides what to do,
// maybe writes a file or searches the web, and comes back to click. The machine
// was being stopped underneath it, and the only sign was its next action
// answering "your computer is stopped" - after which it starts the machine
// again, waits forty seconds, and finds the form it was filling in empty. The
// same mistake was fixed for the session cap when fifteen minutes was cutting
// ducks off mid-job; this is the other half of it. Having touched the computer
// in this run is what separates a duck that is using it from a job that merely
// happens to be running, so an idle machine is still reaped. The eight-hour cap
// still bounds a run that goes wrong.
// Somebody took this screen and walked away. Their hold only runs out after
// ninety seconds without a heartbeat, and their page keeps beating through
// blips for seventy of them, so a lapsed hold is a person who has genuinely
// gone. What they leave behind is a request in their own name, and the server
// refuses everybody else by name - so until that request ran out on its own,
// which follows the personal wait setting and was thirteen minutes in one
// company here, the machine sat held: the duck could not carry on, nobody else
// could take the screen, and the page told them the duck had asked a teammate
// for help, which nobody had ever done.
//
// Completed rather than cancelled, deliberately: cancelling a request stops the
// duck's run outright, and nobody's work should be thrown away because a
// colleague shut a laptop.
// A computer that stops takes the screen from whoever was holding it. Nothing
// let go of them: "Hand back to duck" then failed on a desktop that was no
// longer there, the card said they still had the screen beside "Stopped", and
// the duck's run stayed blocked until the request ran out - up to a quarter of
// an hour. A duck's own request for input is left alone here: it is still the
// duck's question, and it resolves the way requests always do.
export function releaseHeldScreen(c) {
  const hold = controlFor(c.id);
  if (!hold) return false;
  const request = requestForComputer(c.id);
  if (request && request.kind !== "takeover") return false;
  run("DELETE FROM computer_control WHERE computer_id=?", c.id);
  if (request && request.user_id === hold.user_id)
    finishRequest(
      request,
      "completed",
      "The computer was stopped while a person had the screen. Anything they did before that is saved on it: inspect fresh state before carrying on, and do not repeat what they may already have done.",
    );
  emit(c.company_id);
  return true;
}
export function giveBackAbandonedScreen(
  c,
  { hold, request, now = Date.now() },
) {
  if (
    !hold ||
    hold.expires > now ||
    !request ||
    request.kind !== "takeover" ||
    request.user_id !== hold.user_id
  )
    return false;
  finishRequest(
    request,
    "completed",
    "The person who took this screen did not come back. Inspect fresh state, keep any changes they made, and carry on.",
  );
  run(
    "DELETE FROM computer_control WHERE computer_id=? AND generation=?",
    c.id,
    hold.generation,
  );
  audit(c.company_id, null, "Screen given back after nobody came back", {
    duck: c.duck_id,
  });
  computerEvent(c, "gave_back");
  emit(c.company_id);
  return true;
}
// Whether somebody's duck is actually waiting on this screen right now.
const askedFor = (request, now) =>
  !!request &&
  request.expires > now &&
  ["pending", "preparing", "desktop", "submitting"].includes(request.status);
// Why a computer stopped, in the words the person who comes back to it reads.
// Kept in one place so the reason and the kind written with it cannot drift.
const offWhy = "Computers are turned off for this company.",
  pausedWhy = "Your ducks are paused, so their computers stopped too.",
  notAllowedWhy = (duck) =>
    duck.name + " is not allowed a computer, so this one stopped.",
  leftWhy = "Nobody was on the screen any more.",
  longWhy =
    "It had been running for " +
    Math.round(maxSessionMs / 3600000) +
    " hours, so it stopped rather than keep billing unattended.",
  idleWhy =
    "Nothing happened on it for " +
    Math.round(idleMs / 60000) +
    " minutes, so it stopped to save money.";
// Which of the three it stopped by itself for, from the sentence stopReason gave.
export const stopKind = (why) =>
  why === leftWhy
    ? "stopped_left"
    : why === longWhy
      ? "stopped_long"
      : "stopped_idle";
// Whether this computer should stop now, and why - in the words the person who
// comes back to it will read. This used to be one expression in the middle of
// the housekeeping round, which meant it could not be tested without a provider
// standing by, and meant nobody noticed that the eight-hour backstop had no
// exception for somebody who was using the screen at that moment. Taking over a
// machine that happened to be old stopped it under you, mid-task, and all you
// were left with was a fresh desktop and no idea why.
export function stopReason(
  c,
  { disabled, hold, asked, awaiting, working, now = Date.now() } = {},
) {
  // Somebody turned this off deliberately. That is an instruction, not a guess,
  // and it outranks somebody being on the screen. The caller says which of the
  // three switches it was, because they read very differently to the person who
  // threw one of them.
  if (disabled) return typeof disabled === "string" ? disabled : offWhy;
  // Somebody is on this screen right now, or is being waited for. Nothing below
  // is worth taking a machine away from a person in the middle of using it.
  if ((hold && hold.expires > now) || asked || awaiting) return null;
  if (hold) return leftWhy;
  if (now - c.started_at > maxSessionMs) return longWhy;
  if (!working && now - c.started_at < settlingMs) return null;
  if (!working && now - c.last_activity > idleMs && now > c.viewer_until)
    return idleWhy;
  return null;
}
// When this computer stops by itself if nothing changes: the moment the idle
// rule above comes true. Null while a duck or a person is keeping it on.
export function stopsAt(
  c,
  { hold, asked, awaiting, working, now = Date.now() } = {},
) {
  if ((hold && hold.expires > now) || asked || awaiting || working) return null;
  if (hold) return now; // somebody left the screen: it goes on the next round
  return Math.min(
    (c.started_at || now) + maxSessionMs,
    Math.max(
      c.last_activity + idleMs,
      (c.started_at || 0) + settlingMs,
      c.viewer_until || 0,
    ),
  );
}
const midRun = (cid) =>
  !!one(
    "SELECT 1 FROM computer_actions a JOIN jobs j ON j.id=a.job_id WHERE a.computer_id=? AND j.status='running' LIMIT 1",
    cid,
  );
const sharedSyncing = new Set();
const maxConcurrentSharedSyncs = 2;
// Background copies must never hold the computer's interactive lock or delay
// the janitor's next machine. The worker guards every provider request and
// final commit against foreground activity and a changed computer identity.
export function scheduleSharedFileSync(
  computer,
  { request = asciiRequest, worker = null } = {},
) {
  const key = "computer:" + computer.id;
  if (
    !readyStates.includes(computer.state) ||
    sharedSyncing.has(computer.id) ||
    sharedSyncing.size >= maxConcurrentSharedSyncs ||
    serial.has(key)
  )
    return false;
  sharedSyncing.add(computer.id);
  Promise.resolve()
    .then(async () => {
      if (serial.has(key)) return;
      const syncWorker =
        worker ||
        (await import("./shared-files.mjs")).syncSharedFilesForComputer;
      await syncWorker(computer, request, {
        busy: () => serial.has(key),
        allowed: () =>
          !!settings(computer.company_id).enabled &&
          duckComputerAllowed(computer.duck_id, computer.company_id),
      });
    })
    .catch(() => {})
    .finally(() => sharedSyncing.delete(computer.id));
  return true;
}
export function startComputerJanitor() {
  // An action the last process was running when it stopped never finishes.
  run("UPDATE computer_actions SET state='unknown' WHERE state='executing'");
  let running = false;
  // What a duck typed streams into terminal_output so it can be watched as it
  // arrives. The moment the command finishes its receipt is written, and the
  // panel reads that instead - so the streamed copy is dead weight from then on,
  // and nothing was deleting it. One row per command, for the life of the
  // workspace, and it is not in the storage accounting either, so it did not
  // even show up as space being used.
  //
  // A day, not an hour: a run interrupted before its receipt was written has no
  // other copy of what arrived, and somebody coming back to it in the morning
  // should still find it. Anything still streaming is exempt without needing to
  // be: its row is being written to, so its updated time keeps moving.
  const forgetOldOutput = () =>
    forgetTerminalOutput(new Date(Date.now() - 24 * 3600000).toISOString());
  const tick = async () => {
    if (running || !computerConfigured()) return;
    running = true;
    try {
      forgetOldOutput();
      for (const old of all(
        "SELECT * FROM computers WHERE box_id IS NOT NULL AND state<>'archived'",
      )) {
        try {
          const c = await sync(old.id);
          await reconcileComputerProxy(c, executeProxyGuest);
          if (!readyStates.includes(c.state)) continue;
          // Three different decisions, and they used to arrive here as one
          // boolean and leave as one sentence: "Computers were turned off for
          // this company." Somebody who had paused their flock, or taken one
          // duck's computer away, read that and went looking for a switch they
          // had never touched.
          const off = !settings(c.company_id).enabled
            ? { why: offWhy, kind: "stopped_off" }
            : one("SELECT paused FROM companies WHERE id=?", c.company_id)
                  ?.paused
              ? { why: pausedWhy, kind: "stopped_paused" }
              : !duckComputerAllowed(c.duck_id, c.company_id)
                ? {
                    why: notAllowedWhy(
                      tenant("ducks", c.duck_id, c.company_id),
                    ),
                    kind: "stopped_not_allowed",
                  }
                : null;
          const hold = controlFor(c.id);
          let request = requestForComputer(c.id);
          if (giveBackAbandonedScreen(c, { hold, request })) request = null;
          const asked = askedFor(request, Date.now());
          // A duck that ended its run asking for its person is waiting on the
          // screen it left behind. Stopping here kills the browser and the page
          // the person was sent to, so they arrive at a desktop with nothing on
          // it. Hold it for as long as that person has to answer.
          const awaiting = !request && awaitingPerson(c);
          const why = stopReason(c, {
            disabled: off?.why,
            hold,
            asked,
            awaiting,
            working: midRun(c.id),
          });
          if (why) {
            await pauseComputer(c.id, c.company_id, null, {
              automatic: true,
              reason: why,
              kind: off?.kind || stopKind(why),
            });
            continue;
          }
          // A computer waiting on a person is still running and can still
          // have saved output changes. Scheduling here also keeps the scan
          // independent of desktop bootstrap and photographs.
          scheduleSharedFileSync(c);
          if (asked || awaiting) {
            await touch(c.id);
            continue;
          }
          // This also upgrades the lease on machines already running when the
          // idle policy changes, and preserves machines doing non-screen work.
          await renewComputerLeaseFromJanitor(c);
          // Bootstrapping is repair and stays unconditional: a machine whose
          // desktop has died has to be put back whether or not anybody is
          // looking, or the next duck to want it is refused. Photographing is
          // the part that only happens when there is a reason.
          const first = !c.screenshot_at;
          if (
            !hold &&
            !request &&
            !serial.has("computer:" + c.id) &&
            (first || !setUp(c) || photographDue(c))
          )
            await lock("computer:" + c.id, async () => {
              const ready = await bootstrap(c.id);
              // One picture when a machine first comes up, so its card is not
              // blank, and after that only while it is being used.
              if (ready && (first || photographDue(row(c.id))))
                await capture(c.id);
            });
        } catch (e) {
          update(old.id, { error: shownError(e, "housekeeping") });
        }
      }
    } finally {
      running = false;
    }
  };
  // The full round above talks to the provider about every computer, so it can
  // only run occasionally. A preview for someone who is watching has to keep up
  // with what the duck is doing, so it gets its own short round that only takes
  // the picture. It photographs nothing a person is holding, and nothing that is
  // waiting on a person, exactly as the slow round does.
  let previewing = false;
  // Returns how long until the next picture is actually due, so the round after
  // this one is scheduled for that moment instead of polling for it.
  const previewTick = async () => {
    if (previewing || !computerConfigured()) return watchedPreviewMs;
    previewing = true;
    let soonest = watchedPreviewMs;
    try {
      // This round used to ask only for machines somebody was watching, so a
      // duck working with nobody looking got a picture every twenty-five
      // seconds from the slow round - and whatever it had done in between was
      // never seen. There are at most a handful of computers in a company, so
      // the candidates are read and sorted out here.
      for (const c of all(
        "SELECT * FROM computers WHERE box_id IS NOT NULL AND state<>'archived' ORDER BY updated",
      )) {
        if (
          !readyStates.includes(c.state) ||
          !c.bootstrapped ||
          controlFor(c.id) ||
          requestForComputer(c.id) ||
          serial.has("computer:" + c.id) ||
          !worthPhotographing(c)
        )
          continue;
        if (!photographDue(c)) {
          // In use, but photographed within the last second. Remember when its
          // second is up so the next round lands then.
          soonest = Math.min(
            soonest,
            watchedPreviewMs - (Date.now() - Date.parse(c.screenshot_at)),
          );
          continue;
        }
        await lock("computer:" + c.id, async () => {
          if (row(c.id).bootstrapped) await capture(c.id);
        }).catch(() => {});
        // No announcement from here, and none from the capture either unless
        // somebody is watching - see saveScreen. Every announcement reloads the
        // whole workspace for every open page in the company, and at a picture
        // a second that is a hundred full payloads a minute per tab. The list
        // page asks for the picture itself, and the picture answers 304 when it
        // has not changed.
      }
    } finally {
      previewing = false;
    }
    return Math.max(50, soonest);
  };
  // Scheduled from the end of the last round rather than on a fixed timer. A
  // photograph is a round trip to the machine and takes the better part of a
  // second, so a timer every second spent most of its ticks finding the round
  // before it still running and skipping - a picture every 1.7 seconds when it
  // was asked for one a second. Asking again shortly after each round finishes
  // keeps it as close to a second as the machine can actually answer; the age
  // check is what stops it becoming a spin.
  let previewTimer;
  const nextPreview = (ms) => {
    previewTimer = setTimeout(async () => {
      nextPreview(await previewTick());
    }, ms);
    previewTimer.unref();
  };
  nextPreview(watchedPreviewMs);
  const timer = setInterval(tick, 20000);
  timer.unref();
  setTimeout(tick, 1000).unref();
  return timer;
}

export const computerInternals = {
  midRun,
  photographDue,
  worthPhotographing,
  captureEligible,
  saveScreen,
  authorize,
  screenshotAllowed,
  awaitingPerson,
  awaitedPerson,
  stopsAt,
  driver,
  sync,
  touch,
  renewComputerLease,
  renewComputerLeaseFromJanitor,
  budget,
  lock,
  command,
  bootstrap,
  row,
  update,
  checkpointUpdate,
  readyStates,
};
