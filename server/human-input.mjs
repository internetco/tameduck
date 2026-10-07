import { z } from "zod";
import { deploymentDrainRequested } from "./deployment-drain.mjs";
import {
  one,
  run,
  now,
  tenant,
  conversationFor,
  json,
  fail,
  emit,
  audit,
} from "./store.mjs";
import { computerInternals as C } from "./computers.mjs";
import { controlFor } from "./computer-control-store.mjs";
import { computerEvent } from "./computer-events.mjs";
import * as notices from "./mail-notices.mjs";
import {
  requestFor,
  reserveRequest,
  finishRequest,
  expireRequests,
} from "./human-input-store.mjs";
import {
  browserFor,
  captureForm,
  fillBoundForm,
  activateBoundForm,
  thawForm,
  releaseFormLease,
} from "./secure-browser.mjs";
let pauseJobs = async () => {};
let closeHeldControl = () => {};
let currentConnect = browserFor;
const schema = z
  .object({
    title: z.string().trim().min(1).max(160),
    // A card with nothing written on it is the whole of what somebody sees when
    // they arrive. Empty, it rendered as "Complete this step, then let your duck
    // continue", which names no step and helps nobody.
    instructions: z.string().trim().min(1).max(1200),
    checkpoint: z.string().trim().min(1).max(6000),
    // Where the person lands. This was optional unless the duck bound fields,
    // so a duck could hand over a screen it had never navigated - and one did:
    // somebody opened it and found a search page left over from last week's
    // task. Say where they are going, or say it is not on a page at all.
    url: z.url().max(4000).optional(),
    working_directory: z.string().trim().min(1).max(500).optional(),
    fields: z
      .array(
        z
          .object({
            id: z
              .string()
              .regex(/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/)
              .refine(
                (value) => !Object.hasOwn(Object.prototype, value),
                "Invalid field identifier",
              ),
            label: z.string().trim().min(1).max(120),
            type: z.enum(["text", "email", "password", "otp", "textarea"]),
            required: z.boolean(),
            selector: z.string().min(1).max(500),
          })
          .strict(),
      )
      .max(12),
  })
  .strict()
  .refine(
    (a) => a.fields.length === 0 || !!a.url,
    "Bound fields need the address of the page they are on.",
  )
  .refine(
    (a) => !!a.url || !!a.working_directory,
    "Say where the person lands: pass url for the page you opened for them, or working_directory when the work is not on a web page.",
  );
export function assertRequestIdentity(r, c) {
  const b = json(r.binding);
  if (
    !b ||
    c.box_id !== b.box_id ||
    c.started_at !== b.started_at ||
    !C.readyStates.includes(c.state)
  )
    fail(
      409,
      "This computer has restarted or stopped since you were asked, so this is not the same screen any more. Ask your duck to send the request again.",
    );
  if (
    r.job_id &&
    !one(
      "SELECT 1 FROM jobs WHERE id=? AND company_id=? AND duck_id=? AND status='waiting_human'",
      r.job_id,
      r.company_id,
      r.duck_id,
    )
  )
    // Read by somebody who has just typed a password. "This request no longer
    // belongs to a paused task" told them nothing, least of all the one thing
    // they want to know, which is whether what they typed went anywhere.
    fail(
      409,
      "Your duck is not waiting for this any more, so nothing you typed was used.",
    );
  return b;
}
export function authorizeRequest(req, rid = req.params.id) {
  expireRequests();
  const r = tenant("human_requests", rid, req.company.id);
  C.authorize(r.company_id, req.user.id, r.duck_id, { start: false });
  if (r.user_id !== req.user.id)
    fail(403, "Only the person asked for this input can answer it.");
  if (r.conversation_id)
    conversationFor(r.conversation_id, r.company_id, req.user.id);
  return r;
}
// Whether a person said no to a screen request in this run, or in the run it
// was picked up again from.
export function declinedInThisWork(jobId) {
  const root =
    one("SELECT recovery_root_job_id r FROM jobs WHERE id=?", jobId)?.r ||
    jobId;
  return !!one(
    `SELECT 1 FROM human_requests WHERE declined_at IS NOT NULL AND job_id IN
     (SELECT id FROM jobs WHERE id=? OR id=? OR recovery_root_job_id=?)`,
    jobId,
    root,
    root,
  );
}
// What the duck reads when it carries on. The reason is the person's own
// words, so it is quoted as theirs and kept short; it can say how to go on,
// but it is an answer, not a new set of instructions that outrank the task.
export function declineOutcome(reason) {
  return (
    "The person said no to giving you their screen for this request" +
    (reason
      ? ', and wrote: "' + reason.replaceAll('"', "'") + '"'
      : " and gave no reason") +
    ". You do not have their screen. Do not ask for it, or for input on it, again in this task. Carry on another way within your permissions; their reason may say how. If the work cannot be finished without them, finish with incomplete and say plainly what is left for them to do."
  );
}
const declineReason = z
  .string()
  .trim()
  .max(500, "Keep the reason under 500 characters.")
  .optional()
  .default("");
export async function requestUserInput(
  job,
  args,
  { connect = browserFor } = {},
) {
  const a = schema.parse(args);
  if (
    !one(
      "SELECT 1 FROM jobs WHERE id=? AND status='running' AND company_id=? AND duck_id=?",
      job.id,
      job.company_id,
      job.duck_id,
    )
  )
    fail(409, "This run has stopped.");
  // Somebody who said no meant it for this piece of work. Without this a duck
  // that read "find another way" could simply ask again, and the person would
  // be handed the same card a minute later. A run picked up again to finish
  // the same work counts as the same work.
  if (declinedInThisWork(job.id))
    fail(
      409,
      "The person already said no to giving you their screen for this task. Do not ask again. Carry on another way within your permissions, or finish with incomplete and say plainly what is left for them to do.",
    );
  if (new Set(a.fields.map((f) => f.id)).size !== a.fields.length)
    fail(400, "Field identifiers must be unique.");
  if (new Set(a.fields.map((f) => f.selector)).size !== a.fields.length)
    fail(400, "Each field must target a different control.");
  if (a.url && new URL(a.url).protocol !== "https:")
    fail(400, "Secure input requires an HTTPS page.");
  C.authorize(job.company_id, job.user_id, job.duck_id);
  const c = one(
    "SELECT * FROM computers WHERE duck_id=? AND company_id=?",
    job.duck_id,
    job.company_id,
  );
  if (!c || !c.bootstrapped || !C.readyStates.includes(c.state))
    fail(409, "Start the computer and open the form first.");
  if (controlFor(c.id)) fail(409, "A human is already using this computer.");
  const r = reserveRequest(c, job, job.user_id, {
    ...a,
    kind: "form",
  });
  const originalComputer = {
    box_id: c.box_id,
    started_at: c.started_at,
  };
  await pauseJobs(job.duck_id, job.company_id);
  try {
    await C.lock("computer:" + c.id, async () => {
      const latest = C.row(c.id);
      if (
        latest.box_id !== originalComputer.box_id ||
        latest.started_at !== originalComputer.started_at
      )
        fail(
          409,
          "The saved computer changed while securing the page. Ask your duck for a fresh request.",
        );
      const beforeCapture = requestFor(r.id);
      if (
        beforeCapture.status !== "preparing" ||
        beforeCapture.expires <= Date.now()
      )
        fail(409, "This input request expired or was closed.");
      // A duck that named a directory and no page is asking to be joined in a
      // terminal there. That needs no browser at all, and asking for one anyway
      // meant a machine with nothing open could not hand over a terminal.
      const wantsTerminal = !a.url && !a.fields.length && !!a.working_directory;
      const browser = wantsTerminal ? null : await connect(latest);
      let retained = false;
      let binding;
      const abandon = async () => {
        if (binding) {
          await releaseFormLease(binding);
          retained = false;
        }
      };
      try {
        binding = {
          // Without a url, captureForm takes whichever https tab happens to be
          // open and freezes that one. So a duck asking to be joined in
          // /srv/deploy handed the person a leftover page from earlier work,
          // with the terminal it had promised nowhere in sight. A directory is
          // its own kind of handover and never goes looking at the browser.
          ...(wantsTerminal
            ? { working_directory: a.working_directory }
            : await captureForm(browser, a.url, a.fields, r.expires).catch(
                (e) => {
                  // Nothing on screen to preserve. Only a duck that named a
                  // directory can still be joined, in a terminal opened fresh.
                  if (a.fields.length || !a.working_directory) throw e;
                  return { working_directory: a.working_directory };
                },
              )),
          box_id: latest.box_id,
          started_at: latest.started_at,
        };
        retained = true;
        const afterCapture = C.row(c.id);
        if (
          afterCapture.box_id !== originalComputer.box_id ||
          afterCapture.started_at !== originalComputer.started_at
        ) {
          await abandon();
          fail(
            409,
            "The saved computer changed while securing the page. Ask your duck for a fresh request.",
          );
        }
        const afterRequest = requestFor(r.id);
        if (
          afterRequest.status !== "preparing" ||
          afterRequest.expires <= Date.now()
        ) {
          await abandon();
          fail(409, "This input request expired or was closed.");
        }
        C.update(c.id, C.checkpointUpdate(job, a.checkpoint));
        await C.touch(c.id);
        if (
          !run(
            "UPDATE human_requests SET binding=?,status='pending',updated=? WHERE id=? AND status='preparing' AND expires>?",
            JSON.stringify(binding),
            now(),
            r.id,
            Date.now(),
          ).changes
        ) {
          await abandon();
          fail(409, "This input request expired or was closed.");
        }
      } finally {
        if (!retained) browser?.close();
      }
    });
  } catch (e) {
    // Swallowing this told the duck its handover was ready when nothing had
    // been prepared. It then waited for input that could never be entered,
    // holding its computer until the deadline ran out, and the person was never
    // asked anything. Say what went wrong and hand the computer back.
    // Two audiences, two sentences. The duck is told below what went wrong and
    // what to do about it, in its own terms. This one is what the person reads
    // on the card, and "Pass the address of the one the person should continue
    // on" is an instruction to the duck: somebody reading their own Needs you
    // cannot pass an address and has no idea what it means.
    run(
      "UPDATE human_requests SET status='expired',outcome=?,updated=? WHERE id=? AND status='preparing'",
      (one("SELECT name FROM ducks WHERE id=?", job.duck_id)?.name ||
        "Your duck") +
        " could not hand this screen over, so nothing was asked of you. It knows what went wrong and can try again.",
      now(),
      r.id,
    );
    const { parkHumanRequest } = await import("./human-input-parking.mjs");
    await parkHumanRequest(requestFor(r.id)).catch(() => {});
    emit(job.company_id);
    return {
      request_id: r.id,
      status: requestFor(r.id)?.status || "expired",
      error: true,
      message:
        "The screen could not be prepared, so nobody has been asked: " +
        e.message +
        " Check what is on the computer now, then either ask again or carry on without it.",
    };
  }
  emit(job.company_id);
  // The screen is ready and the duck is now waiting on one person. It waits
  // about ten minutes, and most of the time nobody is looking at the app, so
  // this is the one email that cannot afford to be held back or batched.
  // Nothing the duck wrote goes into it: see server/mail-notices.mjs.
  const live = requestFor(r.id);
  notices
    .waiting({
      company: job.company_id,
      user: job.user_id,
      duck: job.duck_id,
      requestId: r.id,
      computerId: c.id,
      expiresAt: live.expires,
    })
    .catch((e) => console.error("Waiting email:", e.message));
  return {
    request_id: r.id,
    status: live.status,
    message:
      "Your task is paused for human input. Values will be entered directly in the browser; you will receive only a completion or cancellation outcome.",
  };
}
export async function openRequestedDesktop(
  r,
  c,
  { connect = browserFor } = {},
) {
  if (!["pending", "desktop"].includes(r.status) || r.expires <= Date.now())
    fail(409, "This request expired or changed. Ask your duck to retry it.");
  const b = assertRequestIdentity(r, c);
  if (r.kind !== "form" || r.status !== "pending") return;
  if (b?.target_id) {
    const browser = await connect(c);
    try {
      // Unfreeze the very page the duck was on and bring it forward, exactly as
      // it stood. Relaxed for a screen handover, which pinned no fields.
      await activateBoundForm(browser, b, json(r.fields), {
        relaxed: !json(r.fields).length,
      });
    } finally {
      browser.close();
    }
    return;
  }
  if (b?.working_directory) await openWorkingDirectory(c, b.working_directory);
}
// Only for work that left nothing on screen. A shell command runs and exits, so
// there is no session to keep; the best that can be offered is a terminal in
// the directory the duck named. Failing to open it must not block the handover.
export async function openWorkingDirectory(c, cwd, { drive = C.driver } = {}) {
  try {
    await drive(
      c.id,
      "launch_app",
      {
        launch_path: "x-terminal-emulator",
        additional_arguments: ["--working-directory=" + cwd],
      },
      "Opening the directory the person was asked to continue in",
    );
  } catch {
    // The takeover screen still carries the duck's instructions.
  }
}
export function registerHumanInput(
  app,
  { pauseDuckJobs, closeControl, connect = browserFor },
) {
  pauseJobs = pauseDuckJobs;
  closeHeldControl = closeControl;
  currentConnect = connect;
  // CDP freeze leases cannot survive a server restart. Keep the task blocked and require reinspection.
  run(
    "UPDATE human_requests SET status='stale',updated=? WHERE status IN ('pending','preparing','submitting','closing')",
    now(),
  );
  app.post("/api/human-requests/:id/submit", async (req, res) => {
    if (deploymentDrainRequested())
      fail(
        503,
        "TameDuck is being updated. Please try again shortly.",
      );
    let r = authorizeRequest(req);
    C.authorize(r.company_id, req.user.id, r.duck_id);
    if (r.status !== "pending" || r.expires <= Date.now())
      fail(409, "This request is no longer accepting input.");
    if (controlFor(r.computer_id))
      fail(409, "Hand back the desktop before answering this form.");
    const fields = json(r.fields);
    const values = z
      .record(z.string(), z.string().max(8192))
      .parse(req.body.values);
    if (!fields.length) fail(400, "Open the screen to complete this request.");
    if (Object.keys(values).some((key) => !fields.some((f) => f.id === key)))
      fail(
        400,
        "This form has changed since it was opened, so nothing was typed. Reload this page and try again.",
      );
    if (fields.some((f) => f.required && !values[f.id]))
      fail(400, "Complete every required field.");
    // A computer stopped under the page is a plain no: nothing can have been
    // typed. It was only found inside the attempt below, whose catch turned it
    // into "Input may have been applied; inspect the screen" - about a screen
    // that no longer exists.
    if (!C.readyStates.includes(C.row(r.computer_id)?.state)) {
      run(
        "UPDATE human_requests SET status='stale',updated=? WHERE id=? AND status='pending'",
        now(),
        r.id,
      );
      emit(r.company_id);
      fail(
        409,
        "The computer was stopped before your answer could be typed, so nothing was entered. Ask " +
          (one("SELECT name FROM ducks WHERE id=?", r.duck_id)?.name ||
            "your duck") +
          " to try again.",
      );
    }
    // One winner, even across tabs. A transport failure is never automatically retried.
    if (
      !run(
        "UPDATE human_requests SET status='submitting',updated=? WHERE id=? AND status='pending'",
        now(),
        r.id,
      ).changes
    )
      fail(409, "This request has already been answered.");
    // Whether anything can have reached the page. Until the form is being
    // filled, a failure is exactly what it says; only after that is "input may
    // have been applied" true.
    let typing = false;
    try {
      await C.lock("computer:" + r.computer_id, async () => {
        r = requestFor(r.id);
        if (r.status !== "submitting" || r.expires <= Date.now())
          fail(409, "This request expired.");
        const c = C.row(r.computer_id),
          binding = assertRequestIdentity(r, c);
        const browser = await connect(c);
        try {
          await fillBoundForm(browser, binding, fields, values, {
            beforeWriting: () => {
              typing = true;
            },
          });
        } finally {
          browser.close();
        }
        finishRequest(
          r,
          "completed",
          "Fields entered directly in the original browser form. Inspect fresh state before continuing.",
        );
      });
    } catch (error) {
      run(
        "UPDATE human_requests SET status='stale',updated=? WHERE id=? AND status='submitting'",
        now(),
        r.id,
      );
      emit(r.company_id);
      // A refusal the page made before writing anything is the plainest answer
      // there is, and it is the common one: say it rather than replacing it
      // with a maybe.
      if ((!typing || error?.nothingTyped) && error?.status) throw error;
      fail(
        409,
        "The page changed or the connection broke while your answer was being typed. Part of it may already be on the screen, so do not send it again - look at the screen, or ask your duck to start over.",
      );
    } finally {
      for (const k of Object.keys(values)) values[k] = "";
      if (req.body) delete req.body.values;
    }
    audit(r.company_id, req.user.id, "Human completed private input request", {
      request_id: r.id,
    });
    res.set("Cache-Control", "no-store").json({ ok: true });
  });
  // "decline" is saying no: the duck does not get the screen and carries on
  // without it. It used to be that the only way out of a request was "Tell
  // <duck> to stop", which ended the whole task.
  for (const operation of ["cancel", "retry", "decline"])
    app.post("/api/human-requests/:id/" + operation, async (req, res) => {
      if (deploymentDrainRequested())
        fail(
          503,
          "TameDuck is being updated. Please try again shortly.",
        );
      let r = authorizeRequest(req);
      if (["completed", "cancelled"].includes(r.status))
        fail(409, "This request is already closed.");
      const reason =
        operation === "decline" ? declineReason.parse(req.body?.reason) : "";
      // Nobody asked them for a screen they opened themselves, so there is
      // nothing to say no to: handing it back is the way out of that one.
      if (operation === "decline" && r.kind === "takeover")
        fail(409, "You opened this screen yourself. Hand it back instead.");
      if (
        ["submitting", "closing", "parking"].includes(r.status) ||
        (r.status === "preparing" && operation !== "cancel")
      )
        fail(409, "Wait for the current operation to finish.");
      // Taking a computer nobody offered pauses whatever the duck had going,
      // including a run in a chat this person is not in. The run's id is kept
      // so it can be resumed, and only its conversation is dropped - which is
      // exactly how we can tell. "Cancel task" on such a card used to stop a
      // colleague's run for good, with nothing said to them. For a run this
      // person cannot see, closing the card means only "I am finished here":
      // the screen goes back and the duck carries on.
      const somebodyElses = r.job_id && !r.conversation_id;
      const effective =
        operation === "cancel" && somebodyElses ? "retry" : operation;
      await resolveHumanRequest(r, effective, {
        connect,
        closeControl,
        by: req.user.id,
        reason,
      });
      audit(
        r.company_id,
        req.user.id,
        effective === "decline"
          ? "Human declined screen request"
          : "Human " + effective + " input request",
        // Whether a reason was given, not the reason: it is in the request.
        { request_id: r.id, ...(effective === "decline" ? { reason: !!reason } : {}) },
      );
      res.set("Cache-Control", "no-store").json({ ok: true });
    });
}

async function resolveHumanRequest(
  r,
  operation,
  {
    connect = currentConnect,
    closeControl = closeHeldControl,
    by = null,
    reason = "",
  } = {},
) {
  r = requestFor(r.id);
  const declined = operation === "decline";
  // Written before the request is finished, so nothing that sees it finished
  // can see it without the answer that finished it.
  const markDeclined = () =>
    declined &&
    run(
      "UPDATE human_requests SET declined_at=?,declined_reason=? WHERE id=?",
      now(),
      reason || null,
      r.id,
    );
  // A parked request no longer owns the computer. Never close or thaw another task's screen.
  if (r.status === "parked") {
    if (
      operation !== "cancel" &&
      r.job_id &&
      !one("SELECT 1 FROM jobs WHERE id=? AND status='waiting_human'", r.job_id)
    )
      fail(
        409,
        "This task has stopped and cannot be resumed from this request.",
      );
    markDeclined();
    finishRequest(
      r,
      operation === "cancel" ? "cancelled" : "completed",
      operation === "cancel"
        ? "The human cancelled this paused task."
        : declined
          ? declineOutcome(reason)
          : "No input was confirmed. The human is back: resume this task, inspect fresh computer state, reopen its saved checkpoint if needed, and continue the authorized work. Request fresh input only if a step still needs the human. Never reuse old fields or assume the previous screen survived.",
    );
    return;
  }
  run(
    "UPDATE human_requests SET status='closing',updated=? WHERE id=?",
    now(),
    r.id,
  );
  // Claim finalization before yielding, so another tab cannot reconnect during cancellation.
  closeControl(r.computer_id);
  await C.lock("computer:" + r.computer_id, async () => {
    r = requestFor(r.id);
    const c = C.row(r.computer_id);
    if (r.binding && C.readyStates.includes(c.state)) {
      const browser = await connect(c).catch(() => null);
      if (browser)
        try {
          await thawForm(browser, json(r.binding)).catch(() => {});
        } finally {
          browser.close();
        }
    }
    await releaseFormLease(json(r.binding));
    // The computer's history said somebody took the screen and never that it
    // came back, when it came back from this card rather than the screen.
    const hadIt = !!controlFor(r.computer_id);
    run("DELETE FROM computer_control WHERE computer_id=?", r.computer_id);
    if (hadIt)
      computerEvent({ id: r.computer_id, company_id: r.company_id }, "gave_back", {
        user: by,
      });
    markDeclined();
    finishRequest(
      r,
      operation === "cancel" ? "cancelled" : "completed",
      operation === "cancel"
        ? "The human cancelled this request and the blocked task."
        : declined
          ? declineOutcome(reason)
          : r.kind === "takeover"
          ? // Nobody asked them to take it, so there was never any input to
            // confirm. They looked, they may have changed something, and they
            // gave the screen back.
            "A person had this screen and has handed it back. Whatever they did is already on the computer: inspect fresh state before carrying on, and do not repeat what they may have already done."
          : "No input was confirmed. Recheck the saved checkpoint and request fresh input if needed.",
    );
  });
}
export async function cancelHumanRequestForJob(job) {
  const r = one(
    "SELECT * FROM human_requests WHERE job_id=? AND status NOT IN ('completed','cancelled')",
    job.id,
  );
  if (r) await resolveHumanRequest(r, "cancel");
  // A return click may have completed its request just before cancellation won.
  run(
    "UPDATE human_requests SET status='cancelled',outcome='The task was cancelled after the return request.',updated=? WHERE job_id=? AND status='completed' AND outcome LIKE 'No input%'",
    now(),
    job.id,
  );
}
