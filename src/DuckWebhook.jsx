import React, { useEffect, useId, useState } from "react";
import { KeyRound, Network, ShieldCheck, ShieldAlert } from "lucide-react";
import { api, Button, CopyButton, fmtDate, fmtTime } from "./ui.jsx";
import { Switch } from "./Switch.jsx";
import {
  LIMITS,
  locksSet,
  sampleRequest,
  webhookDirty,
  webhookForm,
} from "./duck-webhook.mjs";
import "./duck-webhook.css";

// The duck's Webhook tab: a private link another app can post tasks to. Like
// Skills, it saves as you go - the switch, a new link, a new key, a test - and
// has a Save of its own for what is typed, since none of it belongs to the
// duck's profile form.
export function DuckWebhook({ duck, action }) {
  const [hook, setHook] = useState(null);
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState("");
  // A link, key or secret is shown here once, right after it is made.
  const [shown, setShown] = useState(null);
  const ids = { rules: useId(), ips: useId(), reply: useId(), limit: useId() };
  const name = duck.name;
  // What the server now says. Anything being typed is kept.
  const take = (r) => {
    if (!r?.webhook) return r;
    setHook(r.webhook);
    setForm((f) =>
      f && hook && webhookDirty(f, hook) ? f : webhookForm(r.webhook),
    );
    return r;
  };
  // What other apps send arrives while this is open, so the list keeps up.
  useEffect(() => {
    let live = true;
    const load = () =>
      api("/ducks/" + duck.id + "/webhook")
        .then((r) => {
          if (!live) return;
          setHook(r.webhook);
          setForm((f) => f || webhookForm(r.webhook));
        })
        .catch(() => {});
    load();
    const t = setInterval(load, 10000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [duck.id]);
  // `said` may read the answer, and may say nothing: then no toast.
  async function call(key, fn, said) {
    setBusy(key);
    try {
      const r = await action(async () => take(await fn()));
      const words = r && (typeof said === "function" ? said(r) : said);
      if (words) await action(async () => r, words);
      return r;
    } finally {
      setBusy("");
    }
  }
  if (!hook || !form)
    return <p className="muted duck-webhook-loading">Loading…</p>;
  const locks = locksSet(hook);
  const dirty = webhookDirty(form, hook);
  const toggle = (on) =>
    call(
      "switch",
      () => api("/ducks/" + duck.id + "/webhook", "PATCH", { enabled: on }),
      (r) => {
        if (r?.link) setShown({ kind: "link", value: r.link });
        return on ? "Webhook on" : "Webhook off";
      },
    );
  const save = () =>
    call(
      "save",
      () =>
        api("/ducks/" + duck.id + "/webhook", "PATCH", {
          instructions: form.instructions,
          allowed_ips: form.allowed_ips,
          reply_url: form.reply_url,
          hourly_limit: Number(form.hourly_limit),
        }),
      "Webhook settings saved",
    ).then((r) => r && setForm(webhookForm(r.webhook)));
  return (
    <div className="duck-webhook">
      <div>
        <h3>Start tasks from other apps</h3>
        <p className="duck-webhook-intro">
          Give {name} a private web address. Zapier, Make, n8n, a web form or
          your own script can send a task to it, and {name} starts right away.
        </p>
      </div>

      <div className="duck-webhook-switch">
        <div>
          <p className="duck-webhook-strong">Let other apps send {name} tasks</p>
          <p className="duck-webhook-muted">
            {hook.enabled
              ? "On since " +
                fmtDate(hook.enabled_at) +
                " at " +
                fmtTime(hook.enabled_at) +
                (hook.runner ? ". Tasks run as " + hook.runner.name + "." : ".")
              : "Off. Nothing outside TameDuck can start work for this duck."}
          </p>
        </div>
        <Switch
          checked={hook.enabled}
          disabled={!!busy}
          label={"Let other apps send " + name + " tasks"}
          onChange={toggle}
        />
      </div>

      {!hook.enabled && !hook.has_link && (
        <div className="duck-webhook-note">
          <p className="duck-webhook-strong">Before you turn it on</p>
          <ul>
            <li>
              Anyone who has the link can give {name} work. Keep it as private
              as a password.
            </li>
            <li>
              Tasks run as you, with {name}’s skills, connections and computer.
            </li>
            <li>Results land in your chat with {name}, like a message you sent.</li>
            <li>You can switch it off or make a new link at any time.</li>
          </ul>
        </div>
      )}

      {shown && (
        <div className="duck-webhook-shown" role="status">
          <p className="duck-webhook-strong">
            {shown.kind === "link"
              ? "Copy the link now. It is shown only this once."
              : shown.kind === "key"
                ? "Copy the API key now. It is shown only this once."
                : "The signing secret. Paste it into the app that receives answers."}
          </p>
          <div className="duck-webhook-copy">
            <input
              readOnly
              aria-label={
                shown.kind === "link"
                  ? "Webhook link"
                  : shown.kind === "key"
                    ? "API key"
                    : "Signing secret"
              }
              value={shown.value}
              onFocus={(e) => e.target.select()}
            />
            <CopyButton value={shown.value} label="Copy" />
          </div>
          {shown.kind !== "secret" && (
            <p className="duck-webhook-muted">
              Lost it? Make a new one below. The old one stops working at once.
            </p>
          )}
        </div>
      )}

      {hook.has_link && (
        <div className="duck-webhook-row">
          <div>
            <p className="duck-webhook-strong">Link</p>
            <p className="duck-webhook-muted duck-webhook-mono">
              …/api/hooks/{hook.link_hint}
            </p>
          </div>
          <Button
            type="button"
            className="secondary"
            busy={busy === "link"}
            disabled={!!busy}
            onClick={() =>
              window.confirm(
                "Make a new link? The old one stops working at once, so every app that uses it has to be given the new one.",
              ) &&
              call(
                "link",
                () => api("/ducks/" + duck.id + "/webhook/link", "POST", {}),
                (r) => {
                  if (r?.link) setShown({ kind: "link", value: r.link });
                  return "New link made. The old one no longer works.";
                },
              )
            }
          >
            Make a new link
          </Button>
        </div>
      )}

      <section className="duck-webhook-section" aria-labelledby={ids.ips + "h"}>
        <div className="duck-webhook-head">
          {locks === 2 ? (
            <ShieldCheck size={18} aria-hidden="true" className="ok" />
          ) : (
            <ShieldAlert size={18} aria-hidden="true" className="warn" />
          )}
          <h4 id={ids.ips + "h"}>Extra locks</h4>
          <span className={"duck-webhook-pill" + (locks === 2 ? " ok" : " warn")}>
            {locks} of 2 set
          </span>
        </div>
        <p className="duck-webhook-muted">
          Recommended: set both. Then the link alone is not enough to give{" "}
          {name} work, even if it leaks.
        </p>
        <div className="duck-webhook-lock">
          <KeyRound size={16} aria-hidden="true" />
          <div>
            <p className="duck-webhook-strong">API key</p>
            <p className="duck-webhook-muted">
              {hook.has_key ? (
                <>
                  Set: <span className="duck-webhook-mono">{hook.key_hint}</span>.
                  The app sends it as <code>Authorization: Bearer …</code> or{" "}
                  <code>X-TameDuck-Key</code>.
                </>
              ) : (
                "Not set. Calls only need the link."
              )}
            </p>
          </div>
          <div className="duck-webhook-buttons">
            <Button
              type="button"
              className="secondary"
              busy={busy === "key"}
              disabled={!!busy}
              onClick={() =>
                (!hook.has_key ||
                  window.confirm(
                    "Make a new API key? The old one stops working at once.",
                  )) &&
                call(
                  "key",
                  () => api("/ducks/" + duck.id + "/webhook/key", "POST", {}),
                  (r) => {
                    if (r?.key) setShown({ kind: "key", value: r.key });
                    return "API key made";
                  },
                )
              }
            >
              {hook.has_key ? "Make a new key" : "Add an API key"}
            </Button>
            {hook.has_key && (
              <Button
                type="button"
                className="secondary"
                disabled={!!busy}
                onClick={() =>
                  window.confirm(
                    "Remove the API key? Calls will then only need the link.",
                  ) &&
                  call(
                    "unkey",
                    () => api("/ducks/" + duck.id + "/webhook/key", "DELETE"),
                    "API key removed",
                  )
                }
              >
                Remove
              </Button>
            )}
          </div>
        </div>
        <div className="duck-webhook-lock">
          <Network size={16} aria-hidden="true" />
          <label htmlFor={ids.ips} className="duck-webhook-field">
            <span className="duck-webhook-strong">Allowed IP addresses</span>
            <span className="duck-webhook-muted">
              One per line. Ranges like 203.0.113.0/24 work. Empty means any
              address. Your app’s documentation lists the addresses it sends
              from.
            </span>
            <textarea
              id={ids.ips}
              rows={3}
              maxLength={4000}
              spellCheck={false}
              className="duck-webhook-mono"
              placeholder={"203.0.113.7\n198.51.100.0/24"}
              value={form.allowed_ips}
              onChange={(e) => setForm({ ...form, allowed_ips: e.target.value })}
            />
          </label>
        </div>
      </section>

      <div className="duck-webhook-grid">
        <label htmlFor={ids.rules} className="duck-webhook-field">
          <span className="duck-webhook-strong">
            Standing instructions <i>(optional)</i>
          </span>
          <span className="duck-webhook-muted">
            {name} reads these first. What an app sends is a request, it can’t
            overrule them.
          </span>
          <textarea
            id={ids.rules}
            rows={6}
            maxLength={4000}
            placeholder="Only handle new orders. Never refund, cancel or delete anything."
            value={form.instructions}
            onChange={(e) => setForm({ ...form, instructions: e.target.value })}
          />
        </label>
        <div className="duck-webhook-field">
          <span className="duck-webhook-strong">What the other app sends</span>
          <pre className="duck-webhook-code">{sampleRequest(hook)}</pre>
          <span className="duck-webhook-muted">
            Plain text works too: the whole body becomes the task. Up to 20 KB.
          </span>
        </div>
      </div>

      <label htmlFor={ids.reply} className="duck-webhook-field">
        <span className="duck-webhook-strong">
          Send answers back to <i>(optional)</i>
        </span>
        <span className="duck-webhook-muted">
          When {name} finishes, its answer is posted here as JSON. A request may
          also name a <code>reply_url</code> on this same host.
        </span>
        <input
          id={ids.reply}
          type="url"
          maxLength={2000}
          placeholder="https://hooks.example.com/…"
          value={form.reply_url}
          onChange={(e) => setForm({ ...form, reply_url: e.target.value })}
        />
      </label>
      {hook.has_signing_secret && (
        <p className="duck-webhook-muted">
          Answers are signed in the <code>X-TameDuck-Signature</code> header
          with a secret only you and the app know.{" "}
          <button
            type="button"
            className="text-button"
            disabled={!!busy}
            onClick={() =>
              call(
                "secret",
                () =>
                  api("/ducks/" + duck.id + "/webhook/signing-secret", "POST", {}),
                (r) => {
                  if (r?.signing_secret)
                    setShown({ kind: "secret", value: r.signing_secret });
                },
              )
            }
          >
            Show signing secret
          </button>
        </p>
      )}

      <div className="duck-webhook-row">
        <label htmlFor={ids.limit} className="duck-webhook-inline">
          <span className="duck-webhook-strong">At most</span>
          <select
            id={ids.limit}
            value={form.hourly_limit}
            onChange={(e) => setForm({ ...form, hourly_limit: e.target.value })}
          >
            {LIMITS.map((n) => (
              <option key={n} value={n}>
                {n} tasks an hour
              </option>
            ))}
          </select>
        </label>
        <span className="duck-webhook-muted">
          More are refused and listed below.
        </span>
      </div>

      <section className="duck-webhook-section" aria-label="Recent calls">
        <div className="duck-webhook-head">
          <h4>Recent</h4>
          <span className="duck-webhook-muted">Last 7 days</span>
        </div>
        {hook.deliveries.length ? (
          <ul className="duck-webhook-list">
            {hook.deliveries.map((d) => (
              <li key={d.id}>
                <time>{fmtTime(d.received)}</time>
                <span className="duck-webhook-what">
                  {d.summary || (d.outcome === "refused" ? d.reason : "")}
                  {d.source && (
                    <span className="duck-webhook-muted"> · {d.source}</span>
                  )}
                  {d.outcome === "refused" && d.summary && (
                    <span className="duck-webhook-muted"> · {d.reason}</span>
                  )}
                  {d.reply && (
                    <span className="duck-webhook-muted">
                      {" "}
                      · Answer {d.reply.state === "sent" ? "sent" : d.reply.state === "failed" ? "not sent" : "waiting"}
                      {d.reply.note && d.reply.state !== "sent" ? ": " + d.reply.note : ""}
                    </span>
                  )}
                </span>
                <span className={"duck-webhook-pill " + (d.outcome === "started" ? "ok" : "bad")}>
                  {d.outcome === "started" ? (d.test ? "Test" : "Started") : "Refused"}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="duck-webhook-muted">Nothing has arrived yet.</p>
        )}
      </section>

      <div className="duck-webhook-foot">
        <Button
          type="button"
          className="secondary"
          busy={busy === "test"}
          disabled={!!busy || !hook.enabled}
          onClick={() =>
            call(
              "test",
              () => api("/ducks/" + duck.id + "/webhook/test", "POST", {}),
              "Test task sent. Look in your chat with " + name + ".",
            )
          }
        >
          Send a test task
        </Button>
        <span />
        <Button
          type="button"
          busy={busy === "save"}
          disabled={!!busy || !dirty}
          onClick={save}
        >
          Save
        </Button>
      </div>
    </div>
  );
}
